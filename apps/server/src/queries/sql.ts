/**
 * 查询层的公共底座：参数拼装、列值归一、时间窗、游标、以及**契约 ↔ 数据库取值的映射**。
 *
 * 三条硬规则在这里落地，其它文件只准复用、不准各写一份：
 *  1. **只读**：本层只有 `select`，没有 `insert/update/delete`，不开事务（`queries` 是面板的只读通道）。
 *  2. **不解 jsonb 做维度**（tech-plan §8.3 F9）：按命令 / 触发人拆分一律读 `tasks.command` /
 *     `tasks.actor_login` 这两列；只有契约**要求**返回 jsonb 内容的地方（信封 verdict、写回闸门 audit、
 *     事件 payload）才读 jsonb，且只读不筛。
 *  3. **契约值优先**：数据库列里存在契约枚举之外的取值（`timed-out`、`rate_limit`、`unknown` …），
 *     全部在 SQL 里映射成契约取值；映射不到的一律变成 `null` 或被过滤掉，
 *     绝不让面板拿到契约外字符串（那会让 `*ResponseSchema.parse()` 整页失败）。
 */
import type { Pool } from 'pg';

/** 只要能跑 SQL 就行——测试可以塞 `pg.Client`，生产传 `pg.Pool`。 */
export type SqlRunner = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
};

/** `createQueries` 的依赖（E12 冻结签名：`pool` + 可注入的 `now`）。 */
export type QueriesDeps = {
  pool: Pool;
  /** 时间源；测试注入固定时钟，「今日 / 最近 24h / 排队时长」才能断言到具体数字。 */
  now?: () => Date;
};

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

/** 查询层可以抛的两类错误：http 层按 `code` 映射成 400 / 422。 */
export type QueryErrorCode = 'bad-request' | 'unprocessable';

export class QueryError extends Error {
  readonly code: QueryErrorCode;

  constructor(code: QueryErrorCode, message: string) {
    super(message);
    this.name = 'QueryError';
    this.code = code;
  }
}

/**
 * 位置参数拼装器。
 *
 * 为什么要它：`tasks` 的列表有 5 个可选筛选 + 游标，手写 `$1..$9` 迟早错位；
 * 这里只负责「值进数组、占位符往后排」，SQL 里看不出参数顺序错误，但拼装过程可读。
 */
export class Params {
  private readonly values: unknown[] = [];

  /** 追加一个值，返回它的占位符（`$n`）。`cast` 用于 `::timestamptz` / `::text[]` 这类显式类型。 */
  add(value: unknown, cast?: string): string {
    this.values.push(value);
    return cast === undefined ? `$${this.values.length}` : `$${this.values.length}::${cast}`;
  }

  list(): unknown[] {
    return [...this.values];
  }
}

/* ── 列值归一 ─────────────────────────────────────────────────────────────── */

/** 时间列 → ISO8601 UTC（`Z` 结尾）。数据库里的 `timestamptz` 由 pg 解析成 Date。 */
export function isoOf(value: unknown, fallback: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value !== '') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return fallback;
}

export function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value !== '') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

/** `count(*)` / `sum()` / `numeric` 在 pg 里可能是 number、bigint 或字符串，统一成整数。 */
export function intOf(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return fallback;
}

export function intOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = intOf(value, Number.NaN);
  return Number.isNaN(parsed) ? null : parsed;
}

/** 金额：契约要求 4 位小数（`0.0412`），`numeric(12,6)` 的字符串先转 number 再收敛。 */
export function usdOf(value: unknown): number {
  const raw = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : 0;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.round(raw * 10_000) / 10_000;
}

/** 比例：0–1，保留 6 位足够；除数为 0 一律 `null`（契约要求 `null` 与 `0` 可区分）。 */
export function ratioOf(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  const raw = numerator / denominator;
  const clamped = Math.min(1, Math.max(0, raw));
  return Math.round(clamped * 1_000_000) / 1_000_000;
}

/** 两个时间列之间的毫秒数；任一为空或顺序倒置则为 `null`。 */
export function msBetween(start: unknown, end: unknown): number | null {
  const startIso = isoOrNull(start);
  const endIso = isoOrNull(end);
  if (startIso === null || endIso === null) return null;
  const delta = Date.parse(endIso) - Date.parse(startIso);
  return delta < 0 ? null : delta;
}

/** `durationMs` 只接受整数毫秒，`extract(epoch ...)` 是浮点，统一四舍五入。 */
export function msOf(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const raw = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(raw) || raw < 0) return null;
  return Math.round(raw);
}

/** jsonb 取值：只在契约要求返回原文的地方用（verdict / audit / payload / usage）。 */
export function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringOrNull(value: unknown, maxLength = 500): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

/* ── 时间窗 ───────────────────────────────────────────────────────────────── */

export type ResolvedWindow = { from: string; to: string };

/**
 * `from` / `to` 缺省补齐：**默认最近 24h**（contract-api §0 的排序与时间约定）。
 * 只给 `to` 时按 24h 反推；`from > to` 抛 422（契约里这是 `unprocessable`，不是 400）。
 */
export function resolveWindow(query: { from?: string | undefined; to?: string | undefined }, now: Date): ResolvedWindow {
  const toDate = query.to === undefined ? now : new Date(query.to);
  const fromDate = query.from === undefined ? new Date(toDate.getTime() - DAY_MS) : new Date(query.from);
  if (Number.isNaN(toDate.getTime()) || Number.isNaN(fromDate.getTime())) {
    throw new QueryError('bad-request', 'from / to 必须是 ISO8601 UTC 时间');
  }
  if (fromDate.getTime() > toDate.getTime()) {
    throw new QueryError('unprocessable', 'from 不能晚于 to');
  }
  return { from: fromDate.toISOString(), to: toDate.toISOString() };
}

/** UTC 自然日的起点（`today` 的窗口：00:00:00Z 起算）。 */
export function utcDayStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/* ── 游标 ─────────────────────────────────────────────────────────────────── */

/**
 * 游标是**不透明字符串**（contract-api §0）：面板只能原样回传。
 *
 * 语义（三类列表共用，差别只在「排序键」是什么）：
 *  - 编码方式是 `base64url("<排序键 ISO>\n<行 id>")`，排序键都是「时间倒序 + id 倒序」的复合键；
 *  - `tasks` 用 `queued_at`，`reverts` 用 `actions.reverted_at`，`audit` 用 `actions.created_at`；
 *  - 下一页取「严格小于游标」的行（keyset 分页，不用 offset：offfset 在实时列表上会漏行）。
 */
export function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}\n${id}`, 'utf8').toString('base64url');
}

export type DecodedCursor = { at: string; id: string };

export function decodeCursor(cursor: string | undefined): DecodedCursor | null {
  if (cursor === undefined || cursor === '') return null;
  let text: string;
  try {
    text = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new QueryError('bad-request', 'cursor 不是合法游标，请原样回传上一页的 nextCursor');
  }
  const index = text.indexOf('\n');
  if (index <= 0) {
    throw new QueryError('bad-request', 'cursor 不是合法游标，请原样回传上一页的 nextCursor');
  }
  const at = text.slice(0, index);
  const id = text.slice(index + 1);
  const parsed = new Date(at);
  if (id === '' || Number.isNaN(parsed.getTime())) {
    throw new QueryError('bad-request', 'cursor 不是合法游标，请原样回传上一页的 nextCursor');
  }
  return { at: parsed.toISOString(), id };
}

/* ── 契约取值映射（唯一一处，别处不许再写） ─────────────────────────────────── */

/**
 * `tasks.status` → 契约的 5 个取值。
 * 数据库侧出现过 `timed-out`（任务级超时）与 `cancelled_queue`（排队闸门取消）两个更细的状态；
 * 契约把它们收进 `failed` / `cancelled`。**未知取值归入 `failed`**：宁可显示「失败」，
 * 也不让一种新状态把整个面板打成 500（`parse()` 失败是整页失败）。
 */
export function sqlTaskStatus(column: string): string {
  return `case ${column}
    when 'queued' then 'queued'
    when 'running' then 'running'
    when 'succeeded' then 'succeeded'
    when 'failed' then 'failed'
    when 'timed-out' then 'failed'
    when 'cancelled' then 'cancelled'
    when 'cancelled_queue' then 'cancelled'
    else 'failed' end`;
}

/** 面板按状态筛选时的「一组库内取值」（`failed` 要连 `timed-out` 一起筛）。 */
export function taskStatusFilterValues(status: string): string[] {
  if (status === 'failed') return ['failed', 'timed-out'];
  if (status === 'cancelled') return ['cancelled', 'cancelled_queue'];
  return [status];
}

/**
 * `runs.failure_class` → 契约的 10 个取值；契约外（含数据库的 `unknown`）一律 `null`。
 * 数据库侧用的是下划线风格（`rate_limit` / `github_api`），契约是 kebab-case，映射放在这里。
 */
export function sqlFailureClass(column: string): string {
  return `case ${column}
    when 'timeout' then 'timeout'
    when 'interrupt' then 'interrupt'
    when 'degenerate-output' then 'degenerate-output'
    when 'degenerate_output' then 'degenerate-output'
    when 'sandbox-oom' then 'sandbox-oom'
    when 'sandbox_oom' then 'sandbox-oom'
    when 'sandbox-crash' then 'sandbox-crash'
    when 'sandbox_crash' then 'sandbox-crash'
    when 'auth' then 'auth'
    when 'rate-limit' then 'rate-limit'
    when 'rate_limit' then 'rate-limit'
    when 'model' then 'model'
    when 'parse' then 'parse'
    when 'github-api' then 'github-api'
    when 'github_api' then 'github-api'
    else null end`;
}

/** 契约的 10 个失败分类（与 `FAILURE_CLASSES` 同序，用于稳定排序与白名单过滤）。 */
export const FAILURE_CLASS_ORDER = [
  'timeout',
  'interrupt',
  'degenerate-output',
  'sandbox-oom',
  'sandbox-crash',
  'auth',
  'rate-limit',
  'model',
  'parse',
  'github-api',
] as const;

/** `runs.outcome` → 契约的 6 个取值；契约外为 `null`。 */
export function sqlOutcome(column: string): string {
  return `case ${column}
    when 'success' then 'success'
    when 'failed' then 'failed'
    when 'timed-out' then 'timed-out'
    when 'degenerate-output' then 'degenerate-output'
    when 'parse-failed' then 'parse-failed'
    when 'interrupted' then 'interrupted'
    else null end`;
}

/** `actions.revert_kind` → 契约的 5 个取值；契约外为 `null`。 */
export function sqlRevertKind(column: string): string {
  return `case ${column}
    when 'label-removed' then 'label-removed'
    when 'changes-requested' then 'changes-requested'
    when 'pr-closed' then 'pr-closed'
    when 'comment-deleted' then 'comment-deleted'
    when 'revert-commit' then 'revert-commit'
    else null end`;
}

/**
 * `run_events.kind` → 契约的 10 个取值。
 *
 * 库里存的是**原始事件名**（RACP 的 `turn.started` / `item.completed` / `approval.requested` /
 * `sandbox.inspected` / `writeback.fallback` …，保留原始名是为了排查），而契约只有 10 个粗粒度
 * 取值。这里按前缀归一，别再让 `else 'notice'` 把整页都变成「通知」——
 * 实机（2026-11-11）一条 run 的 207 条事件全部落进了兜底桶。
 *
 * `item.*` 归到 `tool-call`：RACP 的 item 是「对话条目」，本仓用到的 `item.started` /
 * `item.completed` 都带工具名（`item.delta` 是正文增量，已不落库，见 `worker/run-task.ts::onEvent`）。
 * 未知事件仍然归 `notice`（契约里它就是兜底桶）。
 *
 * 注意用**搜过的 case**（`case when … = …`）：简版 `case col when …` 里出现 `LIKE` 会变成
 * `col = (col like 'x.%')`，Postgres 直接报 `operator does not exist: text = boolean`。
 */
export function sqlRunEventKind(column: string): string {
  return `case
    when ${column} = 'session' then 'session'
    when ${column} = 'turn' then 'turn'
    when ${column} = 'tool-call' then 'tool-call'
    when ${column} = 'approval' then 'approval'
    when ${column} = 'command' then 'command'
    when ${column} = 'sandbox' then 'sandbox'
    when ${column} = 'envelope' then 'envelope'
    when ${column} = 'action' then 'action'
    when ${column} = 'writeback' then 'writeback'
    when ${column} like 'session.%' then 'session'
    when ${column} like 'turn.%' then 'turn'
    when ${column} like 'item.%' then 'tool-call'
    when ${column} like 'tool.%' then 'tool-call'
    when ${column} like 'approval.%' then 'approval'
    when ${column} like 'command.%' then 'command'
    when ${column} like 'sandbox.%' then 'sandbox'
    when ${column} like 'envelope.%' then 'envelope'
    when ${column} like 'action.%' then 'action'
    when ${column} like 'writeback.%' then 'writeback'
    else 'notice' end`;
}

/**
 * `actions` 的处置结果。
 *
 * 数据库没有 `status` 列：契约注释指出它落在 `actions.audit.status`（写回闸门写的 jsonb 摘要里）。
 * 写入方（W3 worker）还没落地，所以这里做三级回退，保证历史行也能读出合理值：
 *   1. `audit.status` 是契约取值 → 直接用它；
 *   2. `audit.rejectedReason` 非空 → `rejected`（写回闸门拒收）；
 *   3. `applied_at` 非空 → `applied`；`audit.dryRun` 为真 → `dry-run`；否则 `skipped`。
 */
export function sqlActionStatus(alias: string): string {
  return `case
    when ${alias}.audit ->> 'status' in ('applied','dry-run','skipped','rejected','failed')
      then ${alias}.audit ->> 'status'
    when ${alias}.audit ->> 'rejectedReason' is not null then 'rejected'
    when ${alias}.applied_at is not null then 'applied'
    when ${alias}.audit ->> 'dryRun' in ('true','1') then 'dry-run'
    else 'skipped' end`;
}

/**
 * 契约里能出现的 intent（`close_issue` 与 W2-D 的 `reaction.*` 也在内）；契约外的行不返回。
 *
 * `reaction.add` / `reaction.remove` 是**无感反馈**写进 `actions` 的行
 * （403 降级时的「未落地」留痕也用它），DB 侧没有 CHECK，只有这一个常量在收口。
 */
/** UTC 整点向下取整（趋势图的每个点是一个整点小时）。 */
export function roundHourDown(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours()));
}
export const ACTION_INTENTS_SQL = "('comment','label','create_issue','push_branch','close_issue','reaction.add','reaction.remove')";
