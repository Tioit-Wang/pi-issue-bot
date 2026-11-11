/**
 * 固定流水线的**状态机 + 读写**（`docs/plan-fixed-pipeline.md` §2 转移表 / §4.3 表 / §10.3）。
 *
 * 这个文件只回答两个问题，别混进第三个：
 *  1. **给定当前行与一个事件，该写哪些列**——`decideTransition()`，纯函数，逐行照 §2 的转移表；
 *  2. **怎么把那些列写进 `issue_pipeline`**——`loadPipeline()` / `ensurePipeline()` / `applyTransition()` /
 *     `createReadyRow()`，全部走注入的 `PipelineQueryable`（生产是 `pg.Pool`，单测可直接给真库）。
 *
 * 为什么副作用（入队任务 / 关 issue / 打标签 / 发评论）不在这个函数里做：
 * 转移表是**流程的骨架**，它必须能被单测逐行钉死（含「两种 `awaiting_info` 的 `info_requested_at` 差异」
 * 这种一眼看不出的差别）。IO 一旦混进来，测一条规则就要造一整套夹具，规则本身就被埋了。
 * 所以 `decideTransition()` 只把「要做什么」写进 `effects`，由调用方（`http/webhook.ts` 现在、
 * 阶段 0/1/2 的写回路径以后）执行。
 *
 * 两种 `awaiting_info`（§2 注 / §1.8 Q6 修订）——**这是本文件最容易写错的地方**：
 *  - `format/awaiting_info`：等**用户**补充 → `info_requested_at = now`，进 48h 关闭扫描；
 *  - `classify/awaiting_info`：等**管理员**（无法分类）→ `info_requested_at = NULL`，**不进**扫描。
 *    写错这一列，躺在等管理员的 issue 会被 48h 作业误关。
 */
import {
  PIPELINE_CATEGORIES,
  PIPELINE_COMMANDS,
} from '../../../../packages/contract/src/index.ts';
import type {
  PipelineCategory,
  PipelineCommand,
  PipelineStage,
  PipelineState,
} from '../../../../packages/contract/src/index.ts';
import { PIPELINE_LIMITS } from '../config/pipeline-constants.ts';

/* ── 类型 ─────────────────────────────────────────────────────────────────── */

/** 执行一条 SQL 的最小面。形状与 `config/repo-config.ts::SqlRunner` 一致：`pg.Pool` / `pg.Client` 直接可赋值。 */
export type PipelineQueryable = {
  query: (
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ readonly rows: readonly unknown[]; readonly rowCount?: number | null }>;
};

/** 主键：一个 issue 一行。 */
export type PipelineKey = {
  readonly repo: string;
  readonly issueNumber: number;
};

/**
 * `issue_pipeline` 的一行（camelCase，与列一一对应）。
 *
 * 为什么手写而不是用 drizzle 的 `$inferSelect`：`db/schema.ts` 是数据层的事实源，而
 * `workflows/` 不该为了一个类型去依赖 drizzle（它只认 SQL 与契约枚举）。两份定义由
 * `test/pipeline-state-machine.test.ts` 的真库读写对齐「列名一个不少」。
 */
export type PipelineRow = {
  readonly repo: string;
  readonly issueNumber: number;
  readonly stage: PipelineStage;
  readonly state: PipelineState;
  readonly category: PipelineCategory | null;
  /** 阶段执行次数（含通过）；面板显示「格式检查跑了 3 次」 */
  readonly formatAttempts: number;
  /** 格式**不通过**累计次数；`>= PIPELINE_FORMAT_MAX_FAILS` → 自动关 issue（Q5） */
  readonly formatFailCount: number;
  readonly classifyAttempts: number;
  /** 触发本阶段的那次 issue 版本锚（幂等键 `pipeline:<stage>:<issueVersion>` 用它） */
  readonly issueVersion: string | null;
  readonly infoRequestedAt: Date | null;
  readonly lastRecheckAt: Date | null;
  readonly mentionSentAt: Date | null;
  readonly mentionCategory: string | null;
  readonly gateNoticeAt: Date | null;
  readonly sessionId: string | null;
  readonly sessionCursor: number;
  readonly sessionTurns: number;
  readonly sessionStartedAt: Date | null;
  readonly staleAt: Date | null;
  readonly blockedReason: string | null;
  readonly readyAt: Date | null;
  readonly closedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/** 可写的列（`repo` / `issue_number` 是主键，`created_at` 只由 DB 默认值给）。 */
export type PipelineTransition = {
  readonly stage?: PipelineStage;
  readonly state?: PipelineState;
  readonly category?: PipelineCategory | null;
  readonly formatAttempts?: number;
  readonly formatFailCount?: number;
  readonly classifyAttempts?: number;
  readonly issueVersion?: string | null;
  readonly infoRequestedAt?: Date | null;
  readonly lastRecheckAt?: Date | null;
  readonly mentionSentAt?: Date | null;
  readonly mentionCategory?: string | null;
  readonly gateNoticeAt?: Date | null;
  readonly sessionId?: string | null;
  readonly sessionCursor?: number;
  readonly sessionTurns?: number;
  readonly sessionStartedAt?: Date | null;
  readonly staleAt?: Date | null;
  readonly blockedReason?: string | null;
  readonly readyAt?: Date | null;
  readonly closedAt?: Date | null;
  /**
   * 这次转移要**顺手做**的事（调用方执行，`decideTransition` 不做 IO）。
   * - `enqueue`：要不要再入队一个阶段任务；
   * - `closeIssue`：要不要调 `closeIssue`（Q5 第 5 次不通过 / 48h 超时）；
   * - `confirmComment`：要不要发「已收到补充信息，格式检查通过」的确认（D8，仅重检通过）。
   */
  readonly effects?: PipelineEffects;
  /** 非空 = 这次事件**什么都不该写**（只在日志/面板留一句话），值就是原因。 */
  readonly ignore?: string;
};

export type PipelineEffects = {
  readonly enqueue?: PipelineCommand | null;
  readonly closeIssue?: boolean;
  readonly confirmComment?: boolean;
};

/** 用户在补充通道里的身份（§16.2 第 1 条：作者 / 管理员能触发重跑，其它人只记录）。 */
export type SupplementActor = 'author' | 'manager' | 'other';

/** 事件的基础字段：`at` 由调用方给（保证 `decideTransition` 是纯函数），`issueVersion` 是幂等锚的原料。 */
type PipelineEventBase = {
  readonly at: Date;
  readonly issueVersion?: string | null;
};

/**
 * 状态机认的全部事件（§2 转移表逐行对应）：
 *
 * | 事件 | §2 行 |
 * |---|---|
 * | `issue-opened` | `issues.opened`（非 bot） |
 * | `format-pass-first` / `format-pass-recheck` | 格式 pass（首次 / 重检） |
 * | `format-fail` | 格式 fail（含 Q5 的第 5 次自动关） |
 * | `supplement-comment` | `issue_comment.created`（补信息，优先通道） |
 * | `manager-comment` | `issue_comment.created`（等管理员，11:00） |
 * | `classify-result` | 分类四类 |
 * | `run-invalid` | 运行失败 / 信封不合法连续 2 次 |
 * | `manual-next` / `manual-prev` | `/pipeline next|prev`（Q7） |
 * | `auto-close` | `awaiting_info` 满 48h |
 * | `issue-closed` | `issues.closed`（人工关） |
 * | `issue-edited` | `issues.edited`（body/title 变，冷却 120s） |
 * | `edit-after-ready` | `issues.edited` 在 `agent/ready`（D7：只记 `stale_at`） |
 */
export type PipelineEvent =
  | (PipelineEventBase & { readonly kind: 'issue-opened' })
  | (PipelineEventBase & { readonly kind: 'issue-edited' })
  | (PipelineEventBase & { readonly kind: 'format-pass-first' })
  | (PipelineEventBase & { readonly kind: 'format-pass-recheck' })
  | (PipelineEventBase & { readonly kind: 'format-fail'; readonly formatMaxFails?: number })
  | (PipelineEventBase & {
      readonly kind: 'supplement-comment';
      readonly commentId?: number | null;
      readonly actor: SupplementActor;
    })
  | (PipelineEventBase & { readonly kind: 'manager-comment'; readonly fromManager: boolean })
  | (PipelineEventBase & { readonly kind: 'classify-result'; readonly result: PipelineCategory })
  | (PipelineEventBase & {
      readonly kind: 'run-invalid';
      readonly consecutive: number;
      readonly reason?: string;
    })
  | (PipelineEventBase & { readonly kind: 'manual-next'; readonly fromManager?: boolean })
  | (PipelineEventBase & { readonly kind: 'manual-prev'; readonly fromManager?: boolean })
  | (PipelineEventBase & {
      readonly kind: 'manual-recheck';
      /** `--force`：解掉 `blocked` 后重跑（§8 的门禁回执就是让人用这一条） */
      readonly force?: boolean;
      readonly fromManager?: boolean;
    })
  | (PipelineEventBase & {
      readonly kind: 'auto-close';
      readonly closeAfterHours?: number;
    })
  | (PipelineEventBase & { readonly kind: 'issue-closed' })
  | (PipelineEventBase & { readonly kind: 'edit-after-ready' });

/* ── SQL（导出便于单测 grep「写的是哪张表、哪些列」） ───────────────────────── */

const PIPELINE_SELECT_COLUMNS = `"repo", "issue_number", "stage", "state", "category",
  "format_attempts", "format_fail_count", "classify_attempts", "issue_version",
  "info_requested_at", "last_recheck_at", "mention_sent_at", "mention_category", "gate_notice_at",
  "session_id", "session_cursor", "session_turns", "session_started_at",
  "stale_at", "blocked_reason", "ready_at", "closed_at", "created_at", "updated_at"`;

export const PIPELINE_SQL = {
  /** 读一行（`loadPipeline`）。 */
  select: `SELECT ${PIPELINE_SELECT_COLUMNS}
FROM "issue_pipeline"
WHERE "repo" = $1 AND "issue_number" = $2`,
  /**
   * 建行（`ensurePipeline` / `createReadyRow`）。
   * `ON CONFLICT DO NOTHING` + 回读：并发两次 `issues.opened` 不会互相覆盖，
   * 也不会因为竞态抛 unique violation（webhook 里两条投递真的会撞）。
   */
  insert: `INSERT INTO "issue_pipeline" (
  "repo", "issue_number", "stage", "state", "category", "issue_version",
  "info_requested_at", "ready_at", "closed_at"
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT ("repo", "issue_number") DO NOTHING`,
  /** `applyTransition()` 拼出来的 UPDATE 的前半段（列与占位符见 `buildUpdateStatement()`）。 */
  updatePrefix: `UPDATE "issue_pipeline" SET `,
  /** UPDATE 的收尾：主键定位 + 自动 `updated_at = now()`（§4.3）。 */
  updateSuffix: `, "updated_at" = now() WHERE "repo" = $1 AND "issue_number" = $2`,
  /**
   * 门禁回执的限速读法（§8「每 issue 每小时 1 条」）。
   * 单独一条而不是复用 `select`：限速要在**入队前**判，且只需要一列。
   */
  gateNoticeAt: `SELECT "gate_notice_at" FROM "issue_pipeline" WHERE "repo" = $1 AND "issue_number" = $2`,
  /**
   * 48h 关闭扫描（§9，S2 的 `pipeline-close` 作业用它）。
   *
   * `info_requested_at IS NOT NULL` 这一条是**双保险**：`classify/awaiting_info`
   * （等管理员）这一列恒为 NULL，所以永远扫不到它——躺着等管理员的 issue 不会被误关。
   */
  closeScan: `SELECT "repo", "issue_number" FROM "issue_pipeline"
WHERE "state" = 'awaiting_info'
  AND "info_requested_at" IS NOT NULL
  AND "info_requested_at" < now() - ($1 || ' hours')::interval`,
} as const;

/** 可写列 → 列名（`buildUpdateStatement()` 用它拼 SQL，顺序固定便于单测断言）。 */
const PIPELINE_WRITABLE_COLUMNS: Readonly<Record<string, string>> = Object.freeze({
  stage: 'stage',
  state: 'state',
  category: 'category',
  formatAttempts: 'format_attempts',
  formatFailCount: 'format_fail_count',
  classifyAttempts: 'classify_attempts',
  issueVersion: 'issue_version',
  infoRequestedAt: 'info_requested_at',
  lastRecheckAt: 'last_recheck_at',
  mentionSentAt: 'mention_sent_at',
  mentionCategory: 'mention_category',
  gateNoticeAt: 'gate_notice_at',
  sessionId: 'session_id',
  sessionCursor: 'session_cursor',
  sessionTurns: 'session_turns',
  sessionStartedAt: 'session_started_at',
  staleAt: 'stale_at',
  blockedReason: 'blocked_reason',
  readyAt: 'ready_at',
  closedAt: 'closed_at',
});

/** 键顺序固定（同上：单测断言 UPDATE 语句时不该受对象字面量书写顺序影响）。 */
const PIPELINE_WRITABLE_KEYS: readonly (keyof typeof PIPELINE_WRITABLE_COLUMNS)[] = Object.freeze([
  'stage',
  'state',
  'category',
  'formatAttempts',
  'formatFailCount',
  'classifyAttempts',
  'issueVersion',
  'infoRequestedAt',
  'lastRecheckAt',
  'mentionSentAt',
  'mentionCategory',
  'gateNoticeAt',
  'sessionId',
  'sessionCursor',
  'sessionTurns',
  'sessionStartedAt',
  'staleAt',
  'blockedReason',
  'readyAt',
  'closedAt',
]);

/**
 * 剥掉历史遗留的幂等锚前缀：`issue_version` 列里**只存裸版本**（`sha256(updated_at)[0..16]`）。
 *
 * 为什么必须在写入前剥：锚（`pipeline:<stage>:<issueVersion>`）只该在**入队处**拼一次。
 * 早先 `webhook.ts` 把已经带前缀的锚当版本写进了这一列，而 `app/compose.ts::enqueueStageTask()`
 * 又按列值拼一次锚，于是同一个 issue 出现 `pipeline:classify:pipeline:format:x` 与
 * `pipeline:classify:x` 两种键 —— 同一版内容会被当成两次不同的运行。
 *
 * 幂等：已经是裸值就原样返回（`pipeline:format:` / `pipeline:classify:` 前缀剥一次即可，
 * 嵌套的旧数据多剥几次也无害，所以这里用循环而不是单次替换）。
 */
export function bareIssueVersion(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  let text = value;
  for (;;) {
    if (text.startsWith('pipeline:format:')) {
      text = text.slice('pipeline:format:'.length);
      continue;
    }
    if (text.startsWith('pipeline:classify:')) {
      text = text.slice('pipeline:classify:'.length);
      continue;
    }
    return text;
  }
}

/**
 * 把一次转移拼成一条 UPDATE（`$1`/`$2` 是主键，其余按 `PIPELINE_WRITABLE_KEYS` 顺序编号）。
 *
 * 显式的 `null` 与「没给这一列」是两件事：`undefined` = 不动，`null` = 写成 NULL
 * （`info_requested_at=null` 是「不再等用户」的唯一表达方式）。
 *
 * `issue_version` 是唯一被改写的列：写库前统一剥掉锚前缀（见 `bareIssueVersion()`），
 * 于是「列里是裸版本、锚只在入队处拼一次」这条不变量**在任何写入路径上都成立**。
 */
export function buildUpdateStatement(transition: PipelineTransition): {
  readonly text: string;
  readonly columns: readonly string[];
} {
  const sets: string[] = [];
  const columns: string[] = [];
  for (const key of PIPELINE_WRITABLE_KEYS) {
    const column = PIPELINE_WRITABLE_COLUMNS[key];
    const value = (transition as Record<string, unknown>)[key];
    if (column === undefined || value === undefined) {
      continue;
    }
    sets.push(`"${column}" = $${String(columns.length + 3)}`);
    columns.push(key);
  }
  const text =
    sets.length === 0
      ? `${PIPELINE_SQL.updatePrefix}"updated_at" = now()${PIPELINE_SQL.updateSuffix}`
      : `${PIPELINE_SQL.updatePrefix}${sets.join(', ')}${PIPELINE_SQL.updateSuffix}`;
  return { text, columns };
}

/** 写库前的那一层：只对 `issueVersion` 剥前缀（其余列原样）。 */
export function transitionValueOf(key: string, value: unknown): unknown {
  return key === 'issueVersion' && typeof value === 'string' ? bareIssueVersion(value) : value;
}


/* ── 行映射 ───────────────────────────────────────────────────────────────── */

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function intOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function dateOf(value: unknown): Date | null {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

const STAGE_VALUES: readonly PipelineStage[] = ['format', 'classify', 'agent', 'closed'];
const STATE_VALUES: readonly PipelineState[] = [
  'pending',
  'running',
  'awaiting_info',
  'ready',
  'blocked',
  'closed',
];

/** 库里的一行 → `PipelineRow`；阶段/状态词不认识时按最保守的 `format/pending` 收敛（不抛错）。 */
export function toPipelineRow(raw: unknown): PipelineRow | null {
  const record = recordOf(raw);
  const repo = textOf(record['repo']);
  if (repo === null) {
    return null;
  }
  const stage = STAGE_VALUES.find((value) => value === record['stage']) ?? 'format';
  const state = STATE_VALUES.find((value) => value === record['state']) ?? 'pending';
  const category = PIPELINE_CATEGORIES.find((value) => value === record['category']) ?? null;
  return {
    repo,
    issueNumber: intOf(record['issue_number']),
    stage,
    state,
    category,
    formatAttempts: intOf(record['format_attempts']),
    formatFailCount: intOf(record['format_fail_count']),
    classifyAttempts: intOf(record['classify_attempts']),
    issueVersion: textOf(record['issue_version']),
    infoRequestedAt: dateOf(record['info_requested_at']),
    lastRecheckAt: dateOf(record['last_recheck_at']),
    mentionSentAt: dateOf(record['mention_sent_at']),
    mentionCategory: textOf(record['mention_category']),
    gateNoticeAt: dateOf(record['gate_notice_at']),
    sessionId: textOf(record['session_id']),
    sessionCursor: intOf(record['session_cursor']),
    sessionTurns: intOf(record['session_turns']),
    sessionStartedAt: dateOf(record['session_started_at']),
    staleAt: dateOf(record['stale_at']),
    blockedReason: textOf(record['blocked_reason']),
    readyAt: dateOf(record['ready_at']),
    closedAt: dateOf(record['closed_at']),
    createdAt: dateOf(record['created_at']) ?? new Date(0),
    updatedAt: dateOf(record['updated_at']) ?? new Date(0),
  };
}

/* ── IO ───────────────────────────────────────────────────────────────────── */

/** 读一行；没有行返回 `null`（§1.3：无行 = 未知 = 放行）。 */
export async function loadPipeline(
  db: PipelineQueryable,
  key: PipelineKey,
): Promise<PipelineRow | null> {
  const result = await db.query(PIPELINE_SQL.select, [key.repo, key.issueNumber]);
  return toPipelineRow(result.rows[0]);
}

/** 建行时给的初值；缺省 = `format/pending`（§2 第一行）。 */
export type PipelineInit = {
  readonly stage?: PipelineStage;
  readonly state?: PipelineState;
  readonly category?: PipelineCategory | null;
  readonly issueVersion?: string | null;
  readonly infoRequestedAt?: Date | null;
  readonly readyAt?: Date | null;
  readonly closedAt?: Date | null;
};

/**
 * 确保有行（`INSERT … ON CONFLICT DO NOTHING` 后回读）。
 *
 * **不回写已有行**：并发两次 `issues.opened` 时第二次的 `insert` 是空操作，
 * 回读到的是第一次建的那一行——已经有进度的 issue 不会被一条迟到的事件打回 `pending`。
 */
export async function ensurePipeline(
  db: PipelineQueryable,
  key: PipelineKey,
  init: PipelineInit = {},
): Promise<PipelineRow> {
  await db.query(PIPELINE_SQL.insert, [
    key.repo,
    key.issueNumber,
    init.stage ?? 'format',
    init.state ?? 'pending',
    init.category ?? null,
    init.issueVersion ?? null,
    init.infoRequestedAt ?? null,
    init.readyAt ?? null,
    init.closedAt ?? null,
  ]);
  const row = await loadPipeline(db, key);
  if (row === null) {
    // 建行后还读不到 = 数据库不可用或表缺失，调用方不该继续「当作成功」
    throw new Error(`issue_pipeline 建行失败：${key.repo}#${String(key.issueNumber)}`);
  }
  return row;
}

/**
 * §1.3「无行放行 + 懒创建 ready 行」：存量 issue 第一次被 `@` 时补一行 `agent/ready`。
 *
 * 为什么不建 `format/pending`：存量 issue 早就被人手动处理过，回头再跑一遍格式检查
 * 只会给用户一条莫名其妙的「请补充信息」。放行 + `ready` 才是「不认识就当做已完成」。
 */
export async function createReadyRow(
  db: PipelineQueryable,
  key: PipelineKey,
  at: Date,
): Promise<PipelineRow> {
  return ensurePipeline(db, key, { stage: 'agent', state: 'ready', readyAt: at });
}

/**
 * 落一次转移（一条 UPDATE，自动 `updated_at = now()`）。
 *
 * 返回受影响行数：0 表示「行已被别人删掉/从未存在」，调用方据此判定要不要先 `ensurePipeline`。
 */
export async function applyTransition(
  db: PipelineQueryable,
  key: PipelineKey,
  transition: PipelineTransition,
): Promise<number> {
  if (transition.ignore !== undefined) {
    // 忽略型事件不写库：写一个只更新 `updated_at` 的 UPDATE 会让面板的「停留时长」失真
    return 0;
  }
  const { text, columns } = buildUpdateStatement(transition);
  const values: unknown[] = [key.repo, key.issueNumber];
  for (const column of columns) {
    // `issue_version` 在这里被剥成裸版本（列里不存锚，见 `bareIssueVersion()`）
    values.push(transitionValueOf(column, (transition as Record<string, unknown>)[column]));
  }
  const result = await db.query(text, values);
  return result.rowCount ?? result.rows.length;
}

/* ── 转移表（纯函数） ─────────────────────────────────────────────────────── */

function isFormatRunning(row: PipelineRow): boolean {
  return row.stage === 'format' && (row.state === 'pending' || row.state === 'running');
}

/** 幂等锚里「本阶段这一次」的那一段（`pipeline:<stage>:<issueVersion>[:<suffix>]`）。 */
export function pipelineAnchor(stage: 'format' | 'classify', issueVersion: string | null): string {
  return `${stage === 'format' ? 'pipeline:format' : 'pipeline:classify'}:${issueVersion ?? 'none'}`;
}

/**
 * **转移表**（§2 逐行实现；纯函数：不读时钟、不写库、不打 GitHub）。
 *
 * 返回值语义：
 *  - 有列 = 要写这些列（`applyTransition` 落库）；
 *  - `effects` = 顺手要做的副作用（入队 / 关 issue / 确认评论）；
 *  - `ignore` = 这次事件不动状态机（原因写进去，方便日志与面板解释）。
 */
export function decideTransition(
  current: PipelineRow | null,
  event: PipelineEvent,
): PipelineTransition {
  switch (event.kind) {
    /* §2 第 1 行：issues.opened（非 bot）→ 建行 + 入队 pipeline:format（light） */
    case 'issue-opened': {
      if (current !== null && current.state === 'closed') {
        // `issues.reopened` 之前先 `opened` 的情况不存在，但人工重开过又关掉的 issue 会走到这里
        return { ignore: 'closed' };
      }
      if (current !== null && current.stage === 'agent' && current.state === 'ready') {
        // 已经是 ready 的 issue 又收到 opened（重开）：D7 不回退，交给 Agent 自己处理
        return { ignore: 'already-ready' };
      }
      return {
        stage: 'format',
        state: 'pending',
        // 新一轮从零计失败次数（Q5 语义）：不重置的话「关掉再开」会带着旧账，
        // 下一次 fail 就可能直接撞上 `formatMaxFails` 把 issue 关掉。
        formatAttempts: 0,
        formatFailCount: 0,
        // 重新开局不是在「等用户补充」：这一列必须清掉，否则 48h 扫描会盯上它
        infoRequestedAt: null,
        // 上一轮卡住的原因不该跟着新一轮走（面板会显示一条已经作废的 blocked 理由）
        blockedReason: null,
        issueVersion: event.issueVersion ?? null,
        effects: { enqueue: 'pipeline:format' },
      };
    }

    /* §2 第 3 行：格式 pass（首次）→ 无评论；入队分类 */
    case 'format-pass-first': {
      if (current === null || !isFormatRunning(current)) {
        return { ignore: 'not-format-running' };
      }
      return classifyHandoff(current, event, false);
    }

    /* §2 第 4 行：格式 pass（重检，`format_fail_count > 0`）→ 一条确认评论（D8）+ 分类 */
    case 'format-pass-recheck': {
      if (current === null || !isFormatRunning(current)) {
        return { ignore: 'not-format-running' };
      }
      return classifyHandoff(current, event, true);
    }
    /* §2 第 5 行：格式 fail → awaiting_info（`info_requested_at=now`）；Q5 累计 5 次 → closed */
    case 'format-fail': {
      if (current === null || !isFormatRunning(current)) {
        return { ignore: 'not-format-running' };
      }
      const maxFails = event.formatMaxFails ?? PIPELINE_LIMITS.formatMaxFails;
      const failCount = current.formatFailCount + 1;
      const attempts = current.formatAttempts + 1;
      if (failCount >= maxFails) {
        // Q5：第 5 次不通过即关；这一次的 AI 评论就是最后反馈，不再另发关闭评论
        return {
          stage: 'closed',
          state: 'closed',
          formatAttempts: attempts,
          formatFailCount: failCount,
          infoRequestedAt: null,
          closedAt: event.at,
          blockedReason: null,
          issueVersion: event.issueVersion ?? current.issueVersion,
          effects: { closeIssue: true },
        };
      }
      return {
        stage: 'format',
        state: 'awaiting_info',
        formatAttempts: attempts,
        formatFailCount: failCount,
        // 等**用户**补充：这一列非空 = 进 48h 关闭扫描
        infoRequestedAt: event.at,
        blockedReason: null,
        issueVersion: event.issueVersion ?? current.issueVersion,
      };
    }

    /* §16.2 第 1 条：`format/awaiting_info` 的普通评论（作者 / managers）→ 立即重跑（优先通道） */
    case 'supplement-comment': {
      if (current === null) {
        return { ignore: 'no-row' };
      }
      if (current.stage !== 'format' || current.state !== 'awaiting_info') {
        return { ignore: `not-format-awaiting-info:${current.stage}/${current.state}` };
      }
      if (event.actor === 'other') {
        // §16.2：只有作者与 managers 的补充能触发重跑；其他人只记日志
        return { ignore: 'supplement-actor-not-allowed' };
      }
      return {
        stage: 'format',
        state: 'pending',
        // 双保险（§9）：回到 pending 就清掉，48h 扫描不会把正在重跑的 issue 关掉
        infoRequestedAt: null,
        // 冷却让位（§16.2 第 3 条）：评论触发是「优先通道」，记下时刻让随后的 issues.edited 让位
        lastRecheckAt: event.at,
        blockedReason: null,
        issueVersion: event.issueVersion ?? current.issueVersion,
        effects: { enqueue: 'pipeline:format' },
      };
    }

    /* §1.8 Q6 修订：`classify/awaiting_info`（等管理员）只有 managers 的评论能触发重分类 */
    case 'manager-comment': {
      if (current === null) {
        return { ignore: 'no-row' };
      }
      if (current.stage !== 'classify' || current.state !== 'awaiting_info') {
        return { ignore: `not-classify-awaiting-info:${current.stage}/${current.state}` };
      }
      if (!event.fromManager) {
        return { ignore: 'manager-comment-not-from-manager' };
      }
      return {
        stage: 'classify',
        state: 'pending',
        // 等**管理员**的语义：这一列恒为 NULL，不进 48h 扫描
        infoRequestedAt: null,
        lastRecheckAt: event.at,
        blockedReason: null,
        issueVersion: event.issueVersion ?? current.issueVersion,
        effects: { enqueue: 'pipeline:classify' },
      };
    }

    /* §2 分类四类：requirement / defect / other → agent/ready；not-found → classify/awaiting_info */
    case 'classify-result': {
      if (current === null || current.stage !== 'classify') {
        return { ignore: 'not-classify' };
      }
      if (current.state !== 'pending' && current.state !== 'running') {
        return { ignore: `not-classify-running:${current.state}` };
      }
      const attempts = current.classifyAttempts + 1;
      if (event.result === 'not-found') {
        // 虚拟缺陷 / 未知分类：停在原地等管理员（Q6 修订，推翻 D3「不阻塞」）
        return {
          stage: 'classify',
          state: 'awaiting_info',
          category: 'not-found',
          classifyAttempts: attempts,
          // **必须 NULL**：等管理员不进 48h 关闭扫描（§2 注）
          infoRequestedAt: null,
          blockedReason: null,
          issueVersion: event.issueVersion ?? current.issueVersion,
        };
      }
      return {
        stage: 'agent',
        state: 'ready',
        category: event.result,
        classifyAttempts: attempts,
        infoRequestedAt: null,
        blockedReason: null,
        readyAt: event.at,
        issueVersion: event.issueVersion ?? current.issueVersion,
      };
    }

    /* §2「运行失败 / 信封不合法连续 2 次 → blocked」 */
    case 'run-invalid': {
      if (current === null || current.state === 'closed') {
        return { ignore: 'no-row-or-closed' };
      }
      if (current.state === 'blocked') {
        return { ignore: 'already-blocked' };
      }
      const reason = event.reason ?? '运行失败 / 信封不合法';
      if (event.consecutive < 2) {
        // 第一次失败：留在原阶段等重试（不写 blocked，也别把 awaiting_info 打回 pending）
        return { state: 'pending', blockedReason: null };
      }
      return {
        state: 'blocked',
        blockedReason: `${reason}（连续 ${String(event.consecutive)} 次）`.slice(0, 500),
      };
    }

    /* §2 `/pipeline next`（managers，Q7）：format → classify → agent；blocked 等价解禁 */
    case 'manual-next': {
      if (current === null) {
        return { ignore: 'no-row' };
      }
      if (event.fromManager === false) {
        return { ignore: 'not-manager' };
      }
      if (current.state === 'closed') {
        return { ignore: 'closed' };
      }
      if (current.stage === 'format') {
        return {
          stage: 'classify',
          state: 'pending',
          infoRequestedAt: null,
          blockedReason: null,
          issueVersion: event.issueVersion ?? current.issueVersion,
          effects: { enqueue: 'pipeline:classify' },
        };
      }
      if (current.stage === 'classify') {
        return {
          stage: 'agent',
          state: 'ready',
          infoRequestedAt: null,
          blockedReason: null,
          readyAt: event.at,
          issueVersion: event.issueVersion ?? current.issueVersion,
        };
      }
      // 已经在 agent（最后一段）：没有「下一步」可走
      return { ignore: 'already-last-stage' };
    }

    /* §2 `/pipeline prev`（managers，Q7）：agent → classify → format（逐步重跑） */
    case 'manual-prev': {
      if (current === null) {
        return { ignore: 'no-row' };
      }
      if (event.fromManager === false) {
        return { ignore: 'not-manager' };
      }
      if (current.state === 'closed') {
        return { ignore: 'closed' };
      }
      if (current.stage === 'classify') {
        return {
          stage: 'format',
          state: 'pending',
          infoRequestedAt: null,
          blockedReason: null,
          issueVersion: event.issueVersion ?? current.issueVersion,
          effects: { enqueue: 'pipeline:format' },
        };
      }
      if (current.stage === 'agent') {
        return {
          stage: 'classify',
          state: 'pending',
          // 退回重分类时要清掉旧结论：不清的话面板会显示一条已经作废的分类
          category: null,
          infoRequestedAt: null,
          blockedReason: null,
          issueVersion: event.issueVersion ?? current.issueVersion,
          effects: { enqueue: 'pipeline:classify' },
        };
      }
      return { ignore: 'already-first-stage' };
    }

    /* §1.7 P6：`/recheck` 重跑当前阶段（`--force` 同时解 `blocked`）。阶段 2 没有「重跑」概念，由 @ 触发 */
    case 'manual-recheck': {
      if (current === null) {
        return { ignore: 'no-row' };
      }
      if (event.fromManager === false) {
        return { ignore: 'not-manager' };
      }
      if (current.state === 'closed') {
        return { ignore: 'closed' };
      }
      if (current.stage === 'agent') {
        return { ignore: 'agent-stage-has-no-recheck' };
      }
      const forced = event.force === true;
      // 不带 --force 时保留 `blocked_reason`（面板还要能说明为什么卡过）；带上就一并清掉
      const clearBlocked = forced || current.state !== 'blocked';
      const stage = current.stage;
      return {
        stage,
        state: 'pending',
        infoRequestedAt: null,
        lastRecheckAt: event.at,
        ...(clearBlocked ? { blockedReason: null } : {}),
        issueVersion: event.issueVersion ?? current.issueVersion,
        effects: { enqueue: stage === 'format' ? 'pipeline:format' : 'pipeline:classify' },
      };
    }

    /* §9：`awaiting_info` 满 48h 无补充 → 关 issue */
    case 'auto-close': {
      if (current === null) {
        return { ignore: 'no-row' };
      }
      if (current.state !== 'awaiting_info') {
        return { ignore: `not-awaiting-info:${current.state}` };
      }
      // 等管理员（`classify/awaiting_info`）不算「等用户」，`info_requested_at` 为 NULL
      if (current.infoRequestedAt === null) {
        return { ignore: 'info-not-requested' };
      }
      const hours = event.closeAfterHours ?? PIPELINE_LIMITS.closeAfterHours;
      const deadline = current.infoRequestedAt.getTime() + hours * 3_600_000;
      if (event.at.getTime() < deadline) {
        return { ignore: 'not-expired-yet' };
      }
      return {
        stage: 'closed',
        state: 'closed',
        infoRequestedAt: null,
        closedAt: event.at,
        effects: { closeIssue: true },
      };
    }

    /* §2 最后一行：`issues.closed`（人工关）→ closed，不再接事件 */
    case 'issue-closed': {
      if (current === null) {
        // 无行的 issue 被关：建一行 closed，避免「关掉之后又来一条 @」重新走三段
        return {
          stage: 'closed',
          state: 'closed',
          closedAt: event.at,
          infoRequestedAt: null,
        };
      }
      if (current.state === 'closed') {
        return { ignore: 'already-closed' };
      }
      return {
        stage: 'closed',
        state: 'closed',
        closedAt: event.at,
        infoRequestedAt: null,
        blockedReason: null,
      };
    }

    /* §2 `issues.edited`（format/pending | format/awaiting_info）→ 重跑（冷却 120s） */
    case 'issue-edited': {
      if (current === null) {
        return { ignore: 'no-row' };
      }
      if (current.state === 'closed') {
        return { ignore: 'closed' };
      }
      if (current.stage === 'agent') {
        // D7：ready 之后不回退，交给 Agent 自己处理；这里只当 edit-after-ready 处理
        return decideTransition(current, { ...event, kind: 'edit-after-ready' });
      }
      if (current.stage !== 'format') {
        // 分类阶段被编辑：不改流水线状态（分类看的是入队时的正文快照）
        return { ignore: `not-format:${current.stage}` };
      }
      return {
        stage: 'format',
        state: 'pending',
        infoRequestedAt: null,
        lastRecheckAt: event.at,
        blockedReason: null,
        issueVersion: event.issueVersion ?? current.issueVersion,
        effects: { enqueue: 'pipeline:format' },
      };
    }

    /* §2 `issues.edited` 在 `agent/ready` → 忽略（D7），只记 `stale_at` 供面板显示 */
    case 'edit-after-ready': {
      if (current === null) {
        return { ignore: 'no-row' };
      }
      if (current.stage !== 'agent' || current.state !== 'ready') {
        return { ignore: `not-ready:${current.stage}/${current.state}` };
      }
      return { staleAt: event.at };
    }
  }
}

/** `format` → `classify` 的交接（首次 pass 与重检 pass 只差「要不要一条确认评论」）。 */
function classifyHandoff(
  current: PipelineRow,
  event: PipelineEventBase,
  recheck: boolean,
): PipelineTransition {
  return {
    stage: 'classify',
    state: 'pending',
    formatAttempts: current.formatAttempts + 1,
    // 通过不增加 `format_fail_count`（Q5：那个数只计不通过）
    infoRequestedAt: null,
    blockedReason: null,
    issueVersion: event.issueVersion ?? current.issueVersion,
    effects: { enqueue: 'pipeline:classify', confirmComment: recheck },
  };
}

/* ── 小工具（webhook / 写回 / 作业共用） ───────────────────────────────────── */

/** 是不是流水线阶段任务（`source='pipeline'` 且命令在三档之内）。 */
export function isPipelineCommand(command: string): command is PipelineCommand {
  return (PIPELINE_COMMANDS as readonly string[]).includes(command);
}

/** 门禁回执限速：`gate_notice_at` 距今不足一小时 → 这次不发回执（只打 eyes）。 */
export function gateNoticeAllowed(
  gateNoticeAt: Date | null,
  at: Date,
  intervalSeconds: number = PIPELINE_LIMITS.gateNoticeIntervalSeconds,
): boolean {
  if (gateNoticeAt === null) {
    return true;
  }
  return at.getTime() - gateNoticeAt.getTime() >= intervalSeconds * 1000;
}

/** 重跑冷却（§16.2 第 3 条）：`issues.edited` 要等上一次触发够 120s 才重跑。 */
export function recheckCooldownElapsed(
  lastRecheckAt: Date | null,
  at: Date,
  cooldownSeconds: number = PIPELINE_LIMITS.recheckCooldownSeconds,
): boolean {
  if (lastRecheckAt === null) {
    return true;
  }
  // 时钟回拨（测试注入的固定时钟 / 服务器时间同步）时按「冷却已过」处理：
  // 宁可多跑一次重检，也别让补充信息的通道被卡住
  return at.getTime() - lastRecheckAt.getTime() >= cooldownSeconds * 1000;
}
