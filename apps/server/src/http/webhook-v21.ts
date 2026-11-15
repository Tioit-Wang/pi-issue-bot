/**
 * v2.1 全链路集成的**共用接线层**（WS6 / `docs/v21-contract.md` §2、§3、§4、§6）。
 *
 * 为什么不把这些逻辑直接撒进 `webhook.ts` / `run-task.ts` / `compose.ts`：
 *  - 这三个文件的旧路径（`source='pipeline'|'command'`，以及 v0.3 的 agent 消息）被大量单测钉住，
 *    任何「顺手改一行」都可能把旧行为改坏；新逻辑集中在**新模块**，旧文件只留「if 注入了 v21 才走」的钩子；
 *  - 判定 / 渲染 / 执行 / 会话 / 压缩五件事都要读同一份 `repos.settings`，集中一处才能只解析一次；
 *  - 单测可以用内存假实现直接调这里的纯函数，不必起 PostgreSQL 或 pi-host。
 *
 * 本模块**不碰** `trigger/**`、`prompt/**`、`writeback/**`、`compact/**`、`config/**` 的实现，
 * 只做「按冻结契约调用 + 把结果落到库/事件流」这一层装配。
 */
import type {
  EventKey,
  EventTemplateVariant,
  WebhookAcceptedResponse,
  ErrorBody,
} from '../../../../packages/contract/src/index.ts';
import { DEFAULT_EVENT_DELTA_TEMPLATES, maskCodeRegions } from '../../../../packages/contract/src/index.ts';
import type { Logger } from '../../../../packages/shared/src/index.ts';
import {
  readV21Settings,
  resolveAgentExecution,
  resolveEventTrigger,
  resolveManagedCatalog,
} from '../config/v21-settings.ts';
import type { SqlRunner } from '../config/repo-config.ts';
import {
  decideDailyQuotaExceeded,
  decideEvent,
  decidePullRequest,
  DEFAULT_EVENT_TEMPLATES,
} from '../trigger/decide.ts';
// 日配额（需求 §6.7 SL-3）：判定「要处理」之后再原子占一格，触顶即改判 `daily-quota`。
import { reserveDailyQuota } from '../queue/quota.ts';
import type { QuotaReservation } from '../queue/quota.ts';
import type { DecideEventInput, SkippedReason, TriggerDecision } from '../trigger/decide.ts';
import { needsRepoIssues, renderTemplate, renderTemplateAsync } from '../prompt/render.ts';
import type { AsyncRenderContext, RenderContext, RenderResult } from '../prompt/render.ts';
import { createRepoIssuesProvider } from '../prompt/repo-issues.ts';
import type { RepoIssuesLister, RepoIssuesProvider } from '../prompt/repo-issues.ts';
import {
  agentTaskIdempotencyKey,
  commentFingerprint,
  eventFingerprint,
  findTaskIdByKey,
  insertMessage,
  stripAliasMentions,
} from '../agent/index.ts';
import type { AgentSessionDomain, AgentSessionKey } from '../agent/index.ts';
import { errorBodyOf } from './errors.ts';
import { parseOutputV21Json } from '../../../../packages/envelope/src/index.ts';
import type { OutputV21, OutputV21Issue } from '../../../../packages/envelope/src/index.ts';
import { createV21PortFromGithub, executeV21 } from '../writeback/v21/execute.ts';
import type { ExecuteV21Result, V21ActionSwitches, V21PortSources } from '../writeback/v21/execute.ts';
import type { CatalogEntry } from '../writeback/v21/labels.ts';
import { createCompactionStore } from '../compact/store.ts';
import type {
  CompactionRecordInput,
  CompactInput,
  CompactResult,
  CompactStore,
} from '../compact/engine.ts';
import { planSessionOnEvent } from '../agent/session-state.ts';
import type { AgentSessionRow, SessionEventKey, SessionState, SessionTransition } from '../agent/session-state.ts';
import type { GithubReactionApi, GithubRequest, ReactionContent } from '../github/index.ts';

/* ── 0. 载荷读取的小工具（与 webhook.ts 的口径一致，刻意不 import 它的私有函数） ── */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' ? value : null;
}

function num(record: Record<string, unknown> | null, key: string): number {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

/**
 * 载荷里的「用户 id」：不是正整数就算**没给**（`null`），绝不猜 `0`。
 *
 * 为什么复用 `nullableNum()` 再补一道正数判断：载荷取数只有一条规则（非有限数 = 没给），
 * 但角色匹配还要区分「作者 id = 0」与「作者 id 缺失」——后者要降级按 login 并留痕（§6.6 坑一）。
 */
function positiveIdOrNull(record: Record<string, unknown> | null, key: string): number | null {
  const value = nullableNum(record, key);
  return value === null || value <= 0 ? null : value;
}

/** 载荷里「没给」与「给了 0」必须能区分（issue.number 从 1 起，0 = 缺失）。 */
function nullableNum(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ── 1. 事件判定（FR-2.1 ~ FR-2.5 / BR-6） ──────────────────────────────── */

/** webhook 的 `X-GitHub-Event` + `payload.action` → 五个事件键之一，或 PR 通配键。 */
export function v21EventKeyOf(event: string, action: string | null): EventKey | 'pull_request.*' | null {
  if (event.startsWith('pull_request')) {
    // §0「不纳入」：PR 事件本期一律按未触发留痕，不进 issue 会话
    return 'pull_request.*';
  }
  if (event === 'issue_comment') {
    return action === 'created' ? 'issue_comment.created' : null;
  }
  if (event === 'issues') {
    switch (action) {
      case 'opened':
        return 'issues.opened';
      case 'edited':
        return 'issues.edited';
      case 'labeled':
        return 'issues.labeled';
      case 'closed':
        return 'issues.closed';
      default:
        return null;
    }
  }
  return null;
}

/** 从 GitHub 载荷里抽出 `decideEvent()` 需要的那几项（其余由调用方给）。 */
export function v21DecisionInputOf(input: {
  readonly event: string;
  readonly action: string | null;
  readonly payload: unknown;
  readonly settings: unknown;
  readonly repoDisabled?: boolean | undefined;
  readonly contentDuplicate?: boolean | undefined;
  readonly dailyQuotaExceeded?: boolean | undefined;
  readonly signatureInvalid?: boolean | undefined;
}): DecideEventInput | null {
  const key = v21EventKeyOf(input.event, input.action);
  if (key === null || key === 'pull_request.*') {
    return null;
  }
  const payload = asRecord(input.payload);
  const issue = asRecord(payload?.['issue']);
  const comment = asRecord(payload?.['comment']);
  const sender = asRecord(payload?.['sender']);
  const changes = asRecord(payload?.['changes']);
  const label = asRecord(payload?.['label']);
  const commentUser = asRecord(comment?.['user']);
  const state = str(issue, 'state');

  return {
    event: key,
    action: input.action ?? '',
    settings: input.settings,
    changedFields: changes === null ? [] : Object.keys(changes),
    addedLabel: str(label, 'name'),
    issueState: state === 'closed' ? 'closed' : state === 'open' ? 'open' : null,
    actorIsBot:
      str(sender, 'type') === 'Bot' ||
      str(commentUser, 'type') === 'Bot' ||
      (str(commentUser, 'login') ?? '').endsWith('[bot]'),
    comment:
      comment === null
        ? null
        : {
            body: str(comment, 'body') ?? '',
            authorAssociation: str(comment, 'author_association'),
            authorLogin: str(commentUser, 'login') ?? str(sender, 'login'),
            // 作者 id 是角色成员匹配的**权威依据**（§6.6 坑一：login 会变）。
            // `comment.user.id` 载荷里恒有；缺失时退回 `sender.id`，两处都没有才是 `null`（判定侧降级并留痕）。
            authorId: positiveIdOrNull(commentUser, 'id') ?? positiveIdOrNull(sender, 'id'),
          },
    ...(input.repoDisabled === undefined ? {} : { repoDisabled: input.repoDisabled }),
    ...(input.contentDuplicate === undefined ? {} : { contentDuplicate: input.contentDuplicate }),
    ...(input.dailyQuotaExceeded === undefined ? {} : { dailyQuotaExceeded: input.dailyQuotaExceeded }),
    ...(input.signatureInvalid === undefined ? {} : { signatureInvalid: input.signatureInvalid }),
  };
}

/** 一次投递的 v2 判定；不在五个事件里（也不属于 PR）时返回 `null` = 无需留痕。 */
export function decideV21Delivery(input: {
  readonly event: string;
  readonly action: string | null;
  readonly payload: unknown;
  readonly settings: unknown;
  readonly repoDisabled?: boolean | undefined;
  readonly contentDuplicate?: boolean | undefined;
  readonly dailyQuotaExceeded?: boolean | undefined;
  readonly signatureInvalid?: boolean | undefined;
}): TriggerDecision | null {
  const key = v21EventKeyOf(input.event, input.action);
  if (key === 'pull_request.*') {
    return decidePullRequest();
  }
  const decideInput = v21DecisionInputOf(input);
  return decideInput === null ? null : decideEvent(decideInput);
}

/* ── 1.1 日配额判定（需求 §6.7 SL-3） ─────────────────────────────────────── */

/** `decideV21DeliveryWithQuota()` 的入参：`decideV21Delivery()` 那些 + 配额要的仓库与时钟。 */
export type V21QuotaDecisionInput = {
  readonly event: string;
  readonly action: string | null;
  readonly payload: unknown;
  readonly settings: unknown;
  /** 计数器按项目分账（`quota_counters.repo`） */
  readonly repo: string;
  readonly repoDisabled?: boolean | undefined;
  readonly contentDuplicate?: boolean | undefined;
  readonly signatureInvalid?: boolean | undefined;
  /** 时钟注入：配额窗口是 UTC 自然日，测试必须能把「现在」钉住 */
  readonly now?: (() => Date) | undefined;
  readonly logger?: Logger | undefined;
};

/**
 * 带**日配额**的投递判定（需求 §6.7 SL-3：触顶 = 拒绝处理并记录原因，可查）。
 *
 * 顺序是这条实现的关键，不能颠倒：
 *  1. 先按 `decideV21Delivery()` 走完契约 §2 的固定顺序（开关 → 条件 → 闸门 → 去重）；
 *  2. **只有判出「要处理」才占一格额度**：被开关关掉 / 闸门拒绝 / 内容重复的事件不该吃额度，
 *     否则扰动一次配置就能把一天的额度耗光；
 *  3. 占不到 → 改判成 `daily-quota`，由外层 `handleWebhook()` 写进
 *     `webhook_deliveries.decision_reason`（BR-6 的留痕通道），
 *     「为什么这条事件没被处理」在投递审计里一眼可查。
 *
 * 为什么不是「先读计数再判」：`decideV21Delivery()` 是同步纯函数，读库只能放在它之后；
 * 更要紧的是「读-判-加」三步在并发投递下会一起放行。`reserveDailyQuota()` 把判断与自增
 * 压成一条带条件的 UPSERT，抢不到最后一格的那一条会明确拿到 `granted:false`。
 *
 * 配额表读不到（库抖动 / 迁移没跑）时**放行**并记 warn：需求要的是「触顶拒绝」，
 * 不是「配额基础设施一坏就全天不处理事件」。
 */
export async function decideV21DeliveryWithQuota(
  db: SqlRunner,
  input: V21QuotaDecisionInput,
): Promise<TriggerDecision | null> {
  const base = decideV21Delivery({
    event: input.event,
    action: input.action,
    payload: input.payload,
    settings: input.settings,
    ...(input.repoDisabled === undefined ? {} : { repoDisabled: input.repoDisabled }),
    ...(input.contentDuplicate === undefined ? {} : { contentDuplicate: input.contentDuplicate }),
    ...(input.signatureInvalid === undefined ? {} : { signatureInvalid: input.signatureInvalid }),
  });
  // 降级匹配留痕（§6.6 坑一）：这次角色判定是**按 login** 命中而非按 id —— 旧配置缺 id，
  // 或载荷没给作者 id。留一条 warn，运维才知道「该补 id 了」，而不是把降级当成正常放行。
  const roleFallbacks = base?.roleLoginFallbacks ?? [];
  if (roleFallbacks.length > 0) {
    input.logger?.warn(
      { repo: input.repo, fallbacks: roleFallbacks.map((item) => `${item.role}:@${item.login}(${item.reason})`) },
      '角色成员按 login 降级匹配（配置缺 user id 或载荷缺作者 id）：请在面板重新保存该仓库配置以补全 id',
    );
  }
  // `null` = 不在 v2.1 的五个事件里（也不属于 PR）；未触发 = 已经决定不处理。两者都不占额度。
  if (base === null || !base.triggered) {
    return base;
  }
  const limit = resolveAgentExecution(input.settings).daily_quota;
  const now = (input.now ?? ((): Date => new Date()))();
  let reservation: QuotaReservation;
  try {
    reservation = await reserveDailyQuota(db, { repo: input.repo, limit, now });
  } catch (error) {
    input.logger?.warn(
      { repo: input.repo, err: error instanceof Error ? error.message : String(error) },
      '日配额读取失败：本次按放行处理（配额是限额，不是可用性开关）',
    );
    return base;
  }
  if (reservation.granted) {
    return base;
  }
  input.logger?.info(
    { repo: input.repo, used: reservation.used, limit: reservation.limit },
    '日配额已用尽：拒绝处理并留痕（decision_reason=daily-quota）',
  );
  return decideDailyQuotaExceeded(base.event);
}

/* ── 1.2 会话系统提示词的留痕（需求 §6.7 SL-1） ───────────────────────────── */

/**
 * 会话行上记一份「这条会话用的身份说明」。
 *
 * 为什么需要它：RACP 的 `systemPrompt` 只有 `session/create` 会带（`turn/start` 的载荷是
 * `input.{messageId,text}`、`session/attach` 只吃 `sessionId`），复用轮次里**没有**第二次下发点。
 * 所以这一列是**留痕**，不是下发：需求 §6.7 SL-1 的「每次调用都带」在协议层做不到（见 WP7-R），
 * 协议层面能做的只有「会话创建那一刻带上」，那就必须让「带的是哪一份」可查 ——
 * 而不是让面板拿当前项目配置去猜（配置随时会改，历史会话不会跟着变）。
 * 更不能反过来：把这一列读出来塞进某一轮的 `input.text`，等于「每轮重发一遍恒定身份」——
 * 那是把系统提示词当事件模板用，与 §6.7 那张表的分工相反，本包明确不做。
 *
 * 只在会话**还没建立**（`session_id IS NULL`）时写：会话一旦建好，身份就由创建那一刻决定，
 * 之后再写只会得到一份「和宿主里真实那份不一样」的记录。会话轮换（`session_id` 重新置 NULL）
 * 时会自动记上新的一份。
 */
export const V21_SESSION_PROMPT_SQL = {
  record: 'UPDATE "agent_sessions" SET "system_prompt" = $4, "updated_at" = now() WHERE "repo" = $1 AND "domain" = $2 AND "issue_number" = $3 AND ("session_id" IS NULL OR "system_prompt" IS NULL)',
} as const;

/** 把「这条 issue / PR 下一次建会话会用到的系统提示词」记到 `agent_sessions.system_prompt`。 */
export async function recordSessionSystemPrompt(
  db: SqlRunner,
  input: {
    readonly repo: string;
    /** 会话域（BR-5）：提示词是按域留痕的，PR 的不能写进 issue 的行 */
    readonly domain: AgentSessionDomain;
    readonly issueNumber: number;
    readonly settings: unknown;
  },
): Promise<string> {
  const prompt = resolveAgentExecution(input.settings).system_prompt;
  await db.query(V21_SESSION_PROMPT_SQL.record, [
    input.repo,
    input.domain,
    input.issueNumber,
    prompt,
  ]);
  return prompt;
}

/**
 * 判定行要写的两列（BR-6 / `docs/v21-contract.md` §2）。
 *
 * `decision` = `triggered|ignored`，`decision_reason` = `d.reason`（两侧都写）：
 * `TriggerDecision` 的判别联合两边**都有** `reason`（触发 = `enabled|conditional-met`，
 * 未触发 = `switch-off` 那一组），§2 明确要求「每次判定写 decision 与 decision_reason」。
 * 早期版本触发时留 null 是照着 `db/schema.ts` 的旧注释，但那样面板按 reason 聚合时
 * 触发侧全变成空值；这里以契约与接线核对表为准，两边都落具体 reason。
 *
 * 入参刻意只要求「有没有触发 + 原因」这两个字段（而不是 `TriggerDecision`）：
 * 有一类留痕结论**没有 EventKey**（`out-of-scope` / `paused` / `signature-invalid` …），
 * 它们由 `trigger/decide.ts::reasonOnlyDecision()` 给出，形状不能硬塞成 `SkippedDecision`。
 */
export type V21DecisionRowInput = {
  readonly triggered: boolean;
  readonly reason: string;
};

export function v21DecisionRowOf(decision: V21DecisionRowInput): {
  readonly decision: 'triggered' | 'ignored';
  readonly reason: string;
} {
  return {
    decision: decision.triggered ? 'triggered' : 'ignored',
    reason: decision.reason,
  };
}

export const V21_DECISION_SQL = {
  /** BR-6：不触发也要留痕。单独 UPDATE 而不是改 INSERT，是因为判定要等 `repos.settings` 读出来。 */
  write: 'UPDATE "webhook_deliveries" SET "decision" = $2, "decision_reason" = $3 WHERE "delivery_id" = $1',
} as const;

/**
 * 把判定写进投递行。
 *
 * 为什么校验 `rowCount`：这条语句是 `UPDATE`，投递行不在（或 `delivery_id` 对不上）时
 * PostgreSQL 报「成功 0 行」——判定算出来了、库里的行却没有结论，且静默。实测踩过的后果是
 * 「401 明明算出了 `signature-invalid`，库里什么都没有，连一条 warn 都没有」（`signature-invalid`
 * 那条 401 当时连投递行都没落，见 WP1-R）。抛错交给调用方记 warn：留痕是审计，
 * 不该让 GitHub 因为「写不进审计」重投一次（幂等行已经写好了）。
 */
export async function writeV21Decision(
  db: SqlRunner,
  deliveryId: string,
  decision: V21DecisionRowInput,
): Promise<void> {
  const row = v21DecisionRowOf(decision);
  const result = await db.query(V21_DECISION_SQL.write, [deliveryId, row.decision, row.reason]);
  if ((result.rowCount ?? 0) === 0) {
    // 消息里带原因，让调用方那一行 warn 自己就能回答「丢的是哪条结论」
    throw new Error(
      `判定留痕没有落到任何投递行：delivery_id=${deliveryId} reason=${row.reason}（投递行不存在？）`,
    );
  }
}

/* ── 2. 模板渲染（FR-2.3 / FR-4.1） ─────────────────────────────────────── */

/** 未知占位符的结构化告警（FR-2.3 的生产消费方）。字段至少含 unknown 列表与 event/repo。 */
export type V21UnknownPlaceholderWarning = {
  /** 触发告警的事件键（五个 EventKey 之一） */
  readonly event: string;
  /** 仓库全名 `owner/name` */
  readonly repo: string;
  /** 原样保留下来的占位符名（已去重） */
  readonly unknown: readonly string[];
  /** 关联投递，便于按 delivery_id 查现场 */
  readonly deliveryId: string;
};

/**
 * `WebhookDeps.v21`：注入即启用 v2 路径，**不注入时旧行为逐字节不变**。
 *
 * 为什么用「注入才启用」而不是全局开关：旧路径（`source='pipeline'|'command'` 与 v0.3
 * 的 agent 消息）被上百个单测钉住，只要 v2 分支不改它们的入参/出参，就零回归风险。
 */
export type V21WebhookDeps = {
  readonly db: SqlRunner;
  /** 项目级 issue 索引提供者；由装配层创建**一份**并复用（缓存 5 分钟才有意义） */
  readonly repoIssues?: RepoIssuesProvider | undefined;
  /** 没传 provider 时按它现造一份（单测常用）；生产由 `createRepoIssuesLister(client.request)` 注入 */
  readonly listIssues?: RepoIssuesLister | undefined;
  readonly ttlMs?: number | undefined;
  /**
   * 未知占位符告警的可选观测钩子。
   *
   * 为什么除了 `logger.warn` 还要一个钩子：`logger.warn` 已经是生产消费方（结构化字段），
   * 但部署可能还想把「模板写错了」推到告警系统；不注入时什么都不做，不影响投递。
   */
  readonly onUnknownPlaceholders?: ((warning: V21UnknownPlaceholderWarning) => void) | undefined;
};

/**
 * 取本次 webhook 要用的 issue 索引提供者；两者都没给 = 模板里的占位符按未知处理。
 *
 * 为什么用 WeakMap 缓存：`deps.v21` 是进程级装配出来的**同一个对象**，若每次投递都
 * `createRepoIssuesProvider()` 现造一份，`prompt/repo-issues.ts` 那个 5 分钟缓存就永远只有
 * 一次命中（一次 webhook 风暴 = N 份空缓存 = N 次 GitHub 分页请求）。按 deps 对象复用
 * 才能让「同一波并发只发一次」这条约束在生产里真的成立。
 */
const providerCache = new WeakMap<V21WebhookDeps, RepoIssuesProvider>();

export function repoIssuesProviderOf(deps: V21WebhookDeps): RepoIssuesProvider | undefined {
  if (deps.repoIssues !== undefined) {
    return deps.repoIssues;
  }
  if (deps.listIssues === undefined) {
    return undefined;
  }
  const cached = providerCache.get(deps);
  if (cached !== undefined) {
    return cached;
  }
  const created = createRepoIssuesProvider({
    listIssues: deps.listIssues,
    ...(deps.ttlMs === undefined ? {} : { ttlMs: deps.ttlMs }),
  });
  providerCache.set(deps, created);
  return created;
}

/**
 * v2 判定留痕的轨迹：`handleWebhook` 外层包装与内层管线之间只传这一份。
 */
export type V21Trace = {
  decision: TriggerDecision | null;
  payload: unknown;
  action: string | null;
  /**
   * 第 3 步投递级幂等命中（同一 delivery 重投）。
   *
   * 置 true 时外层**不再回写判定**：这一行是上一次投递留下的，原判定必须保持原样；
   * 否则重投会把 `triggered` 覆写成 `repo-disabled`，审计时间线就自相矛盾了。
   */
  skipDecision: boolean;
  /**
   * 内层在「算出判定之前」就返回时的**真实**病因（BR-6 / FR-6.4③）。
   *
   * 为什么由内层记而不是让外层从 `status` 反推：外层只看得到状态码，从它反推病因必然把
   * 多类事件压成一档 —— 这正是复审实测到的问题：暂停、安装事件、未知仓库、读策略失败
   * 全被记成 `repo-disabled`，而 `repos.enabled` 明明是 `true`（`decide.ts` 的
   * issue #30 教训换了条分支又踩一次）。
   */
  earlyExit: SkippedReason | null;
  /**
   * 内容级去重命中（FR-3.5）：`insertMessage()` 之后才知道，但**必须覆盖**已算出的判定。
   * 详见 `webhook.ts::resolveTraceDecision()` 的注释。
   */
  contentDuplicate: boolean;
  /**
   * 这一条投递在库里**有行**（决定外层兜底有没有可写的对象）。
   *
   * 为什么不能靠 `payload !== null` 判断：body 不是 JSON 时 `payload` 也是 `null`，
   * 而那时确实没有行可写（`payload` 列是 jsonb，存不了原文）；replay 则反过来 ——
   * 行早就存在、这一轮只是不重插。
   */
  deliveryRecorded: boolean;
};

/* ── 2.4 增量投喂：本轮变更内容（FR-4.2 / BR-4） ───────────────────────────── */

/**
 * `{{issue.contentDelta}}` 最多列多少行。
 *
 * 为什么要有上限：整段重写时「新增行」= 新的整篇正文，不设限的 diff 会把「增量」重新变成
 * 全量投喂——那正是 FR-4.2 要消掉的东西。超出的部分只给行数，agent 需要原文可以自己去读。
 */
const CONTENT_DELTA_MAX_LINES = 40;

/** `payload.changes` 的键 → 人话（未知键原样保留，不猜）。 */
const CHANGED_FIELD_LABELS: Readonly<Record<string, string>> = {
  body: '正文',
  title: '标题',
  labels: '标签',
  assignee: '指派',
  assignees: '指派',
  milestone: '里程碑',
  state: '状态',
  locked: '锁定',
  type: '类型',
};

/** 按行统计（多集），用于「旧正文里不再有的行 / 新正文里多出来的行」。 */
function countLines(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

/**
 * 行级差异（多集差，不保位置）：只回答「多了哪些行、少了哪些行」。
 *
 * 为什么不做 LCS 真 diff：这里的目的不是给人看 patch，而是把「本轮变了什么」告诉 agent。
 * 多集差的实现是线性的、无回溯，也不会因为一段话搬家就把整篇算成「全变」。
 */
export function v21LineDeltaOf(
  previous: string,
  current: string,
): { readonly added: readonly string[]; readonly removed: readonly string[] } {
  const previousCounts = countLines(previous);
  const currentCounts = countLines(current);
  const added: string[] = [];
  for (const line of current.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const left = previousCounts.get(line) ?? 0;
    if (left > 0) {
      previousCounts.set(line, left - 1);
    } else {
      added.push(line);
    }
  }
  const removed: string[] = [];
  for (const line of previous.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const left = currentCounts.get(line) ?? 0;
    if (left > 0) {
      currentCounts.set(line, left - 1);
    } else {
      removed.push(line);
    }
  }
  return { added, removed };
}

/** 一组行 → 带上限的文本块（`+ ` / `- ` 前缀，一眼能看出方向）。 */
function formatDeltaLines(prefix: '+' | '-', lines: readonly string[]): string[] {
  if (lines.length === 0) {
    return [];
  }
  const shown = lines.slice(0, CONTENT_DELTA_MAX_LINES);
  const out = shown.map((line) => `${prefix} ${line}`);
  const hidden = lines.length - shown.length;
  if (hidden > 0) {
    out.push(`… 另有 ${String(hidden)} 行未列出（需要全文请自己读 issue 正文）`);
  }
  return out;
}

/**
 * 本轮事件的**变更内容**（`{{issue.contentDelta}}` 的取值，FR-4.2 / BR-4）。
 *
 * 口径：首轮为空串（正文由 `{{issue.content}}` 承担）；后续轮只说「这一轮变了什么」——
 *  - `issues.edited`：`payload.changes` 的字段清单 + 正文的行级增删（`changes.body.from` 是旧正文）；
 *  - `issues.labeled`：新增的标签名；
 *  - `issues.closed`：状态从 open 到 closed；
 *  - `issue_comment.created`：空串（评论正文本来就由 `{{comment.body}}` 单独给）。
 *
 * 载荷缺 `changes`（GitHub 在某些编辑里不给）时**不崩、也不猜**：明写「未提供」，
 * 让 agent 知道该自己去读正文，而不是以为「什么都没变」。
 */
export function v21ContentDeltaOf(input: {
  readonly event: EventKey;
  readonly payload: unknown;
  /** 首轮没有「变更」可言（正文就是本轮的全部信息） */
  readonly firstEvent?: boolean | undefined;
}): string {
  if (input.firstEvent !== false) {
    return '';
  }
  const payload = asRecord(input.payload);
  const issue = asRecord(payload?.['issue']);
  const changes = asRecord(payload?.['changes']);
  const lines: string[] = [];

  if (input.event === 'issues.edited') {
    const fields = changes === null ? [] : Object.keys(changes);
    lines.push(
      fields.length === 0
        ? '变更字段：未知（载荷未提供 changes）'
        : `变更字段：${fields.map((field) => CHANGED_FIELD_LABELS[field] ?? field).join(', ')}`,
    );
    const previousBody = str(asRecord(changes?.['body']), 'from');
    const currentBody = str(issue, 'body') ?? '';
    if (previousBody !== null && previousBody !== currentBody) {
      const delta = v21LineDeltaOf(previousBody, currentBody);
      lines.push(...formatDeltaLines('+', delta.added), ...formatDeltaLines('-', delta.removed));
      if (delta.added.length === 0 && delta.removed.length === 0) {
        lines.push('正文只有空白/顺序变化，没有增删行');
      }
    } else if (fields.includes('body')) {
      lines.push('正文变了，但载荷没给 changes.body.from，无法列出增删行（需要原文请自己读 issue）');
    }
  } else if (input.event === 'issues.labeled') {
    const label = str(asRecord(payload?.['label']), 'name');
    lines.push(label === null ? '新增标签：未知（载荷未提供 label.name）' : `新增标签：${label}`);
  } else if (input.event === 'issues.closed') {
    lines.push('状态：open → closed');
  }

  return lines.join('\n');
}

/** webhook 载荷 → 渲染上下文（14 个占位符的数据源）。 */
export function v21RenderContextOf(input: {
  readonly repo: string;
  readonly eventAction: string;
  readonly payload: unknown;
  readonly repoIssues?: RepoIssuesProvider | undefined;
  /** 部署 / 项目配置的触发别名；给了就从评论正文里摘掉（`@bot` 是噪声，不是内容）。 */
  readonly aliases?: readonly string[] | undefined;
  /** 该 issue 此前是否已有成功轮次（`false` = 后续事件，只下发增量）；缺省按首轮处理。 */
  readonly firstEvent?: boolean | undefined;
  /** 事件键：只有它决定「本轮变更内容」怎么取（`v21ContentDeltaOf()`） */
  readonly event?: EventKey | undefined;
}): AsyncRenderContext {
  const payload = asRecord(input.payload);
  const issue = asRecord(payload?.['issue']);
  const comment = asRecord(payload?.['comment']);
  const sender = asRecord(payload?.['sender']);
  const issueUser = asRecord(issue?.['user']);
  const commentUser = asRecord(comment?.['user']);
  const labels = issue?.['labels'];
  const labelNames = Array.isArray(labels)
    ? labels.map((entry) => str(asRecord(entry), 'name') ?? '').filter((name) => name !== '')
    : [];

  const provider = input.repoIssues;
  return {
    repo: input.repo,
    actor: str(sender, 'login') ?? '',
    eventAction: input.eventAction,
    // 增量投喂（FR-4.2）：首轮空串，后续轮给「这一轮变了什么」
    contentDelta:
      input.event === undefined
        ? ''
        : v21ContentDeltaOf({
            event: input.event,
            payload: input.payload,
            ...(input.firstEvent === undefined ? {} : { firstEvent: input.firstEvent }),
          }),
    firstEvent: input.firstEvent !== false,
    issue: {
      author: str(issueUser, 'login') ?? '',
      number: num(issue, 'number'),
      url: str(issue, 'html_url') ?? '',
      title: str(issue, 'title') ?? '',
      content: str(issue, 'body') ?? '',
      labels: labelNames,
      updatedAt: str(issue, 'updated_at') ?? '',
    },
    ...(comment === null
      ? {}
      : {
          comment: {
            author: str(commentUser, 'login') ?? '',
            body: stripAliasMentions(str(comment, 'body') ?? '', input.aliases ?? []),
          },
        }),
    // 惰性：`renderTemplateAsync` 只在模板真写了 {{repo.issues}} 时才 await 这个函数
    ...(provider === undefined
      ? {}
      : { repoIssues: (): Promise<string> => provider.render(input.repo) }),
  };
}

/** 渲染一条 agent 消息正文；`unknown` 由调用方记配置告警，原文保留不改。 */
export async function renderV21AgentText(input: {
  readonly template: string;
  readonly ctx: AsyncRenderContext;
}): Promise<RenderResult> {
  return renderTemplateAsync(input.template, input.ctx);
}

/* ── 2.5 模板选择 / 未知占位符告警 / 一条 v2 消息的完整构建 ────────────────── */

/**
 * 取本轮真正要渲染的模板（FR-2.2 / FR-2.3 / FR-4.1）。
 *
 * 项目模板（`resolveEventTrigger(settings, event).prompt`）与平台内置默认模板
 * (`DEFAULT_EVENT_TEMPLATES[event]`) 在这里**收敛成同一个字符串**，之后一律交给
 * `renderTemplateAsync()`（`prompt/render.ts`）——不存在「默认模板走另一套私有渲染器」
 * 的分叉，所以 FR-2.3 的「一次遍历 / 未知原样保留」对两种模板都成立。
 *
 * `variant='delta'` 只影响「项目没自定义模板」这一支：改用 `DEFAULT_EVENT_DELTA_TEMPLATES`
 * （后续事件只下发变更 + 指令，FR-4.2）；项目自定义模板永远原样返回。
 */
export function v21TemplateOf(
  settings: unknown,
  event: EventKey,
  variant: EventTemplateVariant = 'full',
): string {
  const prompt = resolveEventTrigger(settings, event).prompt;
  if (prompt !== null && prompt.trim() !== '') {
    // 项目自定义模板永远原样返回（需求允许项目显式要求全文）
    return prompt;
  }
  return variant === 'delta' ? DEFAULT_EVENT_DELTA_TEMPLATES[event] : DEFAULT_EVENT_TEMPLATES[event];
}


/**
 * 按「是否首轮」选模板（FR-4.2 的模板选择全部收在这里）。
 *
 * 三条口径：
 *  1. 首轮（或判定侧没给判据）→ 全文默认模板，与改造前逐字节一致；
 *  2. 后续轮 + 项目**自定义**模板 → 原样用项目模板（需求允许项目显式要求全文，
 *     不允许的是平台强制每次全量）；
 *  3. 后续轮 + 平台默认 → 增量默认模板。
 *
 * 怎么区分「项目模板」与「平台默认」：**只在 `settings` 里该事件的 `prompt` 为空时**才算平台默认
 * （`v21TemplateOf()` 的实际行为）。`decidedTemplate` 与默认串逐字相等**不足以**判定 ——
 * 项目可能真的逐字照抄了默认模板，那是它的显式选择，后续轮必须继续给全文（需求允许显式要全文）。
 * 因此 `decidedTemplate` 只用于「判定侧已经给出模板」的短路，最终裁决仍看 `settings`：
 * 项目模板非空 → 原样返回；为空 → 按 `variant` 取平台默认那一套。
 */
function pickEventTemplate(input: {
  readonly settings: unknown;
  readonly event: EventKey;
  readonly firstEvent: boolean;
  readonly decidedTemplate?: string | undefined;
}): string {
  const variant: EventTemplateVariant = input.firstEvent ? 'full' : 'delta';
  const decided = input.decidedTemplate;
  if (decided === undefined || decided === DEFAULT_EVENT_TEMPLATES[input.event]) {
    return v21TemplateOf(input.settings, input.event, variant);
  }
  return decided;
}
/**
 * 未知占位符告警的**生产消费方**（FR-2.3）。
 *
 * 只在测试里断言 `unknown` 是不够的：模板是项目自己在面板里写的，写错了必须有人知道。
 * 这里落一条结构化 `warn`（字段含 unknown 列表 + event + repo + deliveryId），
 * 面板/告警系统可以直接按 `event` 聚合；`unknown` 里的占位符在正文里原样保留，
 * 既不静默丢、也不伪造数据。
 */
export function reportV21UnknownPlaceholders(
  logger: Logger,
  warning: V21UnknownPlaceholderWarning,
): void {
  logger.warn(
    {
      unknown: [...warning.unknown],
      event: warning.event,
      repo: warning.repo,
      deliveryId: warning.deliveryId,
    },
    'v2.1 模板含未知占位符：已原样保留（请检查项目事件模板配置）',
  );
}

/**
 * 从渲染结果首行认出技能触发词（`/issue-format` 这类四段结构的第一段）。
 *
 * 为什么还要单独传给 `insertMessage`：v2 的正文是模板渲染结果，不再经过 v0.3 的
 * `composeAgentMessage()`（它会摘 `/名字` 并产出 `skillIds`）。装配层仍要靠
 * `agent_messages.skill_ids` 找技能，所以这里把首行命令词显式结构化下来。
 */
export function v21SkillIdsOf(text: string): readonly string[] {
  const firstLine = text.split('\n', 1)[0]?.trim() ?? '';
  const matched = /^\/([a-z][a-z0-9-]{1,30})$/u.exec(firstLine);
  const id = matched?.[1] ?? '';
  return id === '' ? [] : [id];
}

/** 评论正文里的技能词：`/` 前是行首或空白，id 只含小写字母数字短横（与 skill-mentions 同口径）。 */
const COMMENT_SKILL_TOKEN = /(?:^|\s)\/([a-z][a-z0-9-]{1,30})(?=$|[\s.,;:!?，。；：！？、)）\]】])/u;

/**
 * 取评论正文里第一个技能词（不带前导 `/`）；代码块与行内代码里的不算（引用不是调用）。
 *
 * 为什么不用契约里的 `findSkillMentions()`：那个函数要求传入当前技能目录做精确匹配，
 * 而 webhook 层没有技能库依赖；这里的调用方随后会把 id 交给 worker，
 * 由注册表判定「有没有这个技能」（找不到时按普通文本处理，不报错）。
 */
export function explicitSkillOfComment(body: string | undefined): string | null {
  if (body === undefined || body.trim() === '') {
    return null;
  }
  const matched = COMMENT_SKILL_TOKEN.exec(maskCodeRegions(body));
  return matched?.[1] ?? null;
}

/** 把渲染结果的首行技能词换成 `/<id>`；首行不是技能词时另起一行前置。 */
export function withSkillFirstLine(text: string, id: string): string {
  const [first, ...rest] = text.split('\n');
  if (first !== undefined && /^\/[a-z][a-z0-9-]{1,30}$/u.test(first.trim())) {
    return [`/${id}`, ...rest].join('\n');
  }
  return [`/${id}`, text].join('\n');
}

/** 一条 v2 消息的构建结果。 */
export type V21MessageBuild = {
  readonly template: string;
  readonly text: string;
  readonly unknown: readonly string[];
  readonly skillIds: readonly string[];
};

/**
 * 从 settings + 载荷构建本轮发给 agent 的消息正文（v2 路径的唯一入口）。
 *
 * 惰性两道闸（FR-2.3 / AC-22）：
 *  1. `needsRepoIssues(template)===false` 时**连 provider 都不取**，`listIssues` 零请求；
 *  2. 取了 provider 时也只是把一个函数交给 `renderTemplateAsync`，它在模板没写
 *     `{{repo.issues}}` 时根本不会 await（第二道保险）。
 * 取数失败时回落到同步渲染并把 `{{repo.issues}}` 当未知占位符保留 —— 绝不伪造列表。
 *
 * `decidedTemplate` 是 `decideEvent()` 已解析好的 `template`：热路径优先用**它**，
 * 不再对同一份 settings 二次 `resolveEventTrigger()`（接线核对表第 2 条）。
 * 省略时才走 `v21TemplateOf()` 的显式解析（面板预览 / 直接调用方 / 单测），
 * 两条路径的取值逻辑一致，由集成测试的等价性用例钉住，不会出现静默错值。
 */
export async function buildV21AgentMessage(input: {
  readonly settings: unknown;
  readonly event: EventKey;
  readonly repo: string;
  readonly eventAction: string;
  readonly payload: unknown;
  readonly deps: V21WebhookDeps;
  readonly logger: Logger;
  readonly deliveryId: string;
  /** 判定侧已解析好的模板；给了就不再二次解析 settings */
  readonly decidedTemplate?: string | undefined;
  /** 触发别名：与 `V21WebhookRuntime.aliases` 同源，用于摘掉评论正文里的 `@bot`。 */
  readonly aliases?: readonly string[] | undefined;
  /**
   * 该 issue 此前是否已有成功轮次（FR-4.2 的首轮判据）。
   * `false` = 后续事件：默认模板换成增量版，`{{issue.contentDelta}}` 给本轮变更。
   * 省略按**首轮**处理（保守：多给全文不会让 agent 少上下文）。
   */
  readonly firstEvent?: boolean | undefined;
}): Promise<V21MessageBuild> {
  // FR-4.2 增量投喂：firstEvent=false 时 pickEventTemplate 把「平台默认」换成增量默认模板，
  // {{issue.contentDelta}} 拿本轮变更；项目自定义模板不受影响
  const firstEvent = input.firstEvent !== false;
  const template = pickEventTemplate({
    settings: input.settings,
    event: input.event,
    firstEvent,
    ...(input.decidedTemplate === undefined ? {} : { decidedTemplate: input.decidedTemplate }),
  });
  const provider = needsRepoIssues(template) ? repoIssuesProviderOf(input.deps) : undefined;
  const ctx = v21RenderContextOf({
    repo: input.repo,
    event: input.event,
    eventAction: input.eventAction,
    payload: input.payload,
    firstEvent,
    ...(provider === undefined ? {} : { repoIssues: provider }),
    ...(input.aliases === undefined ? {} : { aliases: input.aliases }),
  });

  let rendered: RenderResult;
  try {
    rendered = await renderV21AgentText({ template, ctx });
  } catch (error) {
    // provider.render() 是唯一可能抛错的异步源（GitHub 分页）。失败时按「没准备数据」处理，
    // `{{repo.issues}}` 进 unknown 并原样保留，不塞空串、更不编一份假索引。
    input.logger.warn(
      { repo: input.repo, event: input.event, err: describeError(error) },
      'v2.1 issue 索引取数失败：{{repo.issues}} 按未知占位符保留（不伪造数据）',
    );
    const syncCtx: RenderContext = {
      repo: ctx.repo,
      actor: ctx.actor,
      eventAction: ctx.eventAction,
      issue: ctx.issue,
      ...(ctx.comment === undefined ? {} : { comment: ctx.comment }),
      // 增量投喂的取值也一并带过来：回落路径不该把「本轮变更」变成空串/未知
      contentDelta: ctx.contentDelta,
      firstEvent: ctx.firstEvent,
      repoIssues: undefined,
    };
    rendered = renderTemplate(template, syncCtx);
  }

  if (rendered.unknown.length > 0) {
    const warning: V21UnknownPlaceholderWarning = {
      event: input.event,
      repo: input.repo,
      unknown: [...rendered.unknown],
      deliveryId: input.deliveryId,
    };
    reportV21UnknownPlaceholders(input.logger, warning);
    input.deps.onUnknownPlaceholders?.(warning);
  }

  // 评论里点名的技能优先：`issue_comment.created` 的默认模板首行写死了 `/issue-analysis`，
  // 于是「@机器人 /bug-analysis」永远跑通用分析（2026-11-12 实测）。这里把首行换成用户点名的那个。
  const explicitSkill =
    input.event === 'issue_comment.created' ? explicitSkillOfComment(ctx.comment?.body) : null;
  return {
    template,
    text: explicitSkill === null ? rendered.text : withSkillFirstLine(rendered.text, explicitSkill),
    unknown: rendered.unknown,
    skillIds: explicitSkill === null ? v21SkillIdsOf(rendered.text) : [explicitSkill],
  };
}

/* ── 3. {{repo.issues}} 的 GitHub 适配器（§6.3） ─────────────────────────── */

type RawIssue = {
  readonly number?: unknown;
  readonly title?: unknown;
  readonly state?: unknown;
  readonly updated_at?: unknown;
  readonly pull_request?: unknown;
};

function headerText(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

/** 从 Link 头里读最后一页；读不到就按「已取到的条数」给 total（宁可少报也不编数）。 */
function totalFromLink(
  linkHeader: unknown,
  rowsLength: number,
  perPage: number,
  page: number,
): number {
  const link = headerText(linkHeader);
  const last = link === null ? null : /<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/u.exec(link);
  if (last !== null) {
    const lastPage = Number(last[1] ?? '0');
    if (Number.isFinite(lastPage) && lastPage > 0) {
      return lastPage * perPage;
    }
  }
  return (page - 1) * perPage + rowsLength;
}

/**
 * 把 `GithubClient.request` 适配成 `createRepoIssuesProvider` 需要的 `listIssues`。
 *
 * 走 `GET /repos/{owner}/{repo}/issues`（**不是** search 接口）：GitHub 的 issues 接口
 * 会把 PR 混进来，所以 `pull_request` 字段必须原样透给 provider 去过滤（§6.3「排除 PR」）。
 */
export function createRepoIssuesLister(request: GithubRequest): RepoIssuesLister {
  return async ({ repo, state, perPage, page }) => {
    const slash = repo.indexOf('/');
    const owner = slash > 0 ? repo.slice(0, slash) : repo;
    const name = slash > 0 ? repo.slice(slash + 1) : '';
    const response = await request<readonly RawIssue[]>('GET /repos/{owner}/{repo}/issues', {
      owner,
      repo: name,
      state,
      per_page: perPage,
      page,
    });
    const rows = Array.isArray(response.data) ? response.data : [];
    return {
      total: totalFromLink(response.headers?.['link'], rows.length, perPage, page),
      items: rows.map((row) => ({
        number: typeof row.number === 'number' ? row.number : 0,
        title: typeof row.title === 'string' ? row.title : '',
        state: typeof row.state === 'string' ? row.state : 'open',
        isPullRequest: row.pull_request !== undefined && row.pull_request !== null,
        updatedAt: typeof row.updated_at === 'string' ? row.updated_at : '',
      })),
    };
  };
}

/**
 * 把 `GithubReactionApi`（旧路径的窄接口）适配成 v2 执行器的 reaction 面。
 *
 * 只差 `content` 的类型宽度：v2 的 schema 已经把 content 校验成同一组枚举，
 * 这里做一次显式收窄比在两个包之间改公共类型安全得多（旧假实现一个都不用改）。
 */
export function v21ReactionsOf(reactions: GithubReactionApi): NonNullable<V21PortSources['reactions']> {
  return {
    addReaction: (input) =>
      reactions.addReaction({ ...input, content: input.content as ReactionContent }),
    listReactions: (input) =>
      reactions.listReactions({ ...input, content: input.content as ReactionContent }),
    removeReaction: (input) => reactions.removeReaction(input),
  };
}

/** 开 PR 的能力：v2.1 之前没有任何代码路径会开 PR，所以这一层单独用 REST 接上。 */
export function createV21OpenPullRequest(request: GithubRequest): NonNullable<V21PortSources['openPullRequest']> {
  return async ({ repo, head, title, body }) => {
    const slash = repo.indexOf('/');
    const owner = slash > 0 ? repo.slice(0, slash) : repo;
    const name = slash > 0 ? repo.slice(slash + 1) : '';
    const info = await request<{ readonly default_branch?: unknown }>('GET /repos/{owner}/{repo}', {
      owner,
      repo: name,
    });
    const base = typeof info.data?.default_branch === 'string' ? info.data.default_branch : 'main';
    const created = await request<{ readonly number?: unknown }>('POST /repos/{owner}/{repo}/pulls', {
      owner,
      repo: name,
      head,
      base,
      title,
      body,
    });
    return { number: typeof created.data?.number === 'number' ? created.data.number : 0 };
  };
}

/* ── 4. v2 产出分流（FR-5.3） ──────────────────────────────────────────── */

/** 执行 v2 产出时运行时才知道的上下文。 */
export type V21ExecuteContext = {
  readonly repo: string;
  readonly issueNumber: number;
  readonly dryRun: boolean;
  /** issue 当前标签（`label` 目标态的差集依据） */
  readonly currentLabels?: readonly string[] | undefined;
  /** 我们历史上打过的标签（删除时记 owner） */
  readonly botLabels?: readonly string[] | undefined;
  /**
   * 允许被 `@` 到的 login（issue 作者 + 本轮触发人）。
   *
   * 执行器的提及中和用它：不在清单里的 `@` 会被插零宽空格。不给 = 谁都不许 @
   * （`comment` 的回复目标作者由执行器自己追加，不受这里影响）。
   */
  readonly allowedMentions?: readonly string[] | undefined;
};

/** 一次分流的结果。`handled=false` = 不是 v2 产出，调用方回落旧的 4-intent 信封。 */
export type V21Execution = {
  readonly handled: boolean;
  readonly valid: boolean;
  readonly errors: readonly OutputV21Issue[];
  readonly output: OutputV21 | null;
  readonly result: ExecuteV21Result | null;
};

export type V21Executor = (text: string, ctx: V21ExecuteContext) => Promise<V21Execution>;

/**
 * 造一个 v2 执行器：试探解析 → 成功才执行，失败原样交回旧路径。
 *
 * 「整份拒绝」由 `executeV21()` 保证：未知 type / 缺字段 / 开关未开时一条动作都不执行，
 * 错误进 `errors`（调用方写 `envelopes.errors` 与 `run_events`）。
 */
export function createV21Executor(options: {
  readonly write: V21PortSources['write'];
  readonly settings: (repo: string) => Promise<unknown>;
  readonly reactions?: V21PortSources['reactions'];
  readonly openPullRequest?: V21PortSources['openPullRequest'];
  /** issue 编辑面（改 / 关 / 重开 / 改删评论 / 关联）；不给时那些动作在调用点失败。 */
  readonly issueEdit?: V21PortSources['issueEdit'];
  readonly now?: (() => number) | undefined;
}): V21Executor {
  const api = createV21PortFromGithub({
    write: options.write,
    ...(options.reactions === undefined ? {} : { reactions: options.reactions }),
    ...(options.openPullRequest === undefined ? {} : { openPullRequest: options.openPullRequest }),
    ...(options.issueEdit === undefined ? {} : { issueEdit: options.issueEdit }),
  });

  return async (text, ctx) => {
    const parsed = parseOutputV21Json(text);
    if (!parsed.ok) {
      return { handled: false, valid: false, errors: parsed.errors, output: null, result: null };
    }
    const rawSettings = await options.settings(ctx.repo);
    const settings = readV21Settings(rawSettings).settings;
    const execution = resolveAgentExecution(rawSettings);
    const switches: V21ActionSwitches = {
      create_issue: execution.actions.create_issue,
      open_pr: execution.actions.open_pr,
      close_issue: execution.actions.close_issue,
    };
    const catalog: readonly CatalogEntry[] = resolveManagedCatalog(rawSettings).map((entry) => ({
      name: entry.name,
      meaning: entry.meaning,
      managed: entry.managed,
      status: entry.status,
    }));
    const result = await executeV21({
      output: parsed.output,
      repo: ctx.repo,
      issueNumber: ctx.issueNumber,
      dryRun: ctx.dryRun,
      actionsEnabled: switches,
      currentLabels: ctx.currentLabels ?? [],
      botLabels: ctx.botLabels ?? [],
      catalog,
      maxPerIssue: settings.labels.max_per_issue,
      api,
      ...(ctx.allowedMentions === undefined ? {} : { allowedMentions: ctx.allowedMentions }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const errors: readonly OutputV21Issue[] = result.errors.map((error) => ({
      path: `/actions/${String(error.index)}/${error.type}`,
      message: error.message,
    }));
    return { handled: true, valid: result.ok, errors, output: parsed.output, result };
  };
}

/* ── 5. 压缩留痕（FR-5.6 / AC-25） ─────────────────────────────────────── */

/**
 * 从 RACP 事件里认出 `itemType==='compaction'`。
 *
 * 为什么是「识别事件」而不是「在这里做压缩」：RACP 客户端目前**没有** session/history
 * 与 compact 操作，`packages/racp-client/src/schema.ts` 只在 itemType 枚举里留了
 * `'compaction'`。请求前自动压缩因此还接不上；本层能做的是把 host 报出来的压缩
 * 事件如实落进 `agent_compactions`，不假装已经自动压缩。
 */
export function compactionRecordOf(
  payload: unknown,
  ctx: { readonly repo: string; readonly issueNumber: number; readonly sessionId: string },
): CompactionRecordInput | null {
  const event = asRecord(payload);
  const item = asRecord(event?.['item']) ?? event;
  if (item === null || item['itemType'] !== 'compaction' && event?.['itemType'] !== 'compaction') {
    return null;
  }
  if (ctx.sessionId === '') {
    // `agent_compactions.session_id` 非空：没有会话 id 时宁可不写，也不写一条无法归因的行
    return null;
  }
  const detail = asRecord(item['checkpoint']) ?? item;
  return {
    repo: ctx.repo,
    issueNumber: ctx.issueNumber,
    sessionId: ctx.sessionId,
    generation: num(detail, 'generation'),
    beforeTokens: num(detail, 'beforeTokens'),
    afterTokens: num(detail, 'afterTokens'),
    summaryChars: typeof detail['summary'] === 'string' ? detail['summary'].length : num(detail, 'summaryChars'),
    fallback: detail['fallback'] === true,
  };
}

/** 装配层注入给 `runTask` 的事件钩子类型。 */
export type V21EventHook = (event: {
  readonly kind: string;
  readonly payload: unknown;
  readonly repo: string;
  readonly issueNumber: number;
  readonly sessionId: string;
}) => Promise<void>;

/** 用 `createCompactionStore()` 造事件钩子：命中压缩事件就只追加一行记录。 */
export function createV21CompactionHook(db: SqlRunner): V21EventHook {
  const store = createCompactionStore(db);
  return async (event) => {
    const record = compactionRecordOf(event.payload, {
      repo: event.repo,
      issueNumber: event.issueNumber,
      sessionId: event.sessionId,
    });
    if (record !== null) {
      await store.record(record);
    }
  };
}

/** 暴露给装配层的压缩引擎入口（`createCompactor` 的柯里化形态）。 */
export type V21Compactor = (input: CompactInput) => Promise<CompactResult>;

/** `CompactStore` 的公开别名（装配层用 `createCompactionStore(db)` 提供）。 */
export type V21CompactionStore = CompactStore;

/* ── 6. 会话状态（FR-3.4 / AC-23） ─────────────────────────────────────── */

export const V21_SESSION_SQL = {
  read: `SELECT "state", "sandbox_id", "session_id", "turns", "cursor"
FROM "agent_sessions" WHERE "repo" = $1 AND "domain" = $2 AND "issue_number" = $3`,
  /**
   * 只 UPDATE / INSERT，**永远不 DELETE**：
   * issue 随时可能重开，任何归档动作都会让重开的 issue 失去上下文（§6）。
   */
  create: `INSERT INTO "agent_sessions" ("repo", "domain", "issue_number", "state", "sandbox_id", "closed_at", "cursor", "turns", "updated_at")
VALUES ($1, $2, $3, $4, $5, NULL, 0, 0, now())
ON CONFLICT ("repo", "domain", "issue_number") DO NOTHING`,
  recycle: `UPDATE "agent_sessions"
SET "state" = 'idle', "sandbox_id" = NULL, "closed_at" = now(), "updated_at" = now()
WHERE "repo" = $1 AND "domain" = $2 AND "issue_number" = $3`,
  reuse: `UPDATE "agent_sessions"
SET "state" = 'active', "sandbox_id" = COALESCE("sandbox_id", $4), "closed_at" = NULL, "updated_at" = now()
WHERE "repo" = $1 AND "domain" = $2 AND "issue_number" = $3`,
} as const;

/**
 * 这条事件属于 issue 还是 PR（BR-5 的事实源）。
 *
 * 判据**照抄现有代码**，不发明新规则：
 *  - `X-GitHub-Event` 以 `pull_request` 开头 → PR 域（`v21EventKeyOf()` 已按此判）；
 *  - 其余事件看载荷里的 `issue.pull_request` 字段是否非空（REST 里 PR 就是 issue，
 *    GitHub 用这个字段区分；`http/webhook.ts` 的 `isPullRequest` 与
 *    `queries/issues.ts` 的 `kind='pr'` 都是同一口径）。
 *
 * 宁可判成 issue 域也不能判成 PR 域：判错成 PR 会让 issue 的上下文丢失（agent 从零开始），
 * 判错成 issue 只是把两段历史并到一处 —— 前者更贵。所以这里只在**有明确 PR 证据**时返回 `pr`。
 */
export function v21SessionDomainOf(input: {
  readonly event: string;
  readonly payload: unknown;
}): AgentSessionDomain {
  if (input.event.startsWith('pull_request')) {
    return 'pr';
  }
  const issue = asRecord(asRecord(input.payload)?.['issue']);
  return asRecord(issue?.['pull_request']) === null ? 'issue' : 'pr';
}

/** 从库行还原 `planSessionOnEvent()` 要的运行时快照。 */
export function v21SessionRowOf(
  row: Record<string, unknown> | undefined,
  key: { readonly repo: string; readonly domain: AgentSessionDomain; readonly issueNumber: number },
): AgentSessionRow | null {
  if (row === undefined) {
    return null;
  }
  const state = str(row, 'state');
  return {
    repo: key.repo,
    issueNumber: key.issueNumber,
    sessionId: str(row, 'session_id'),
    state: state === 'active' ? 'active' : ('idle' as SessionState),
    sandboxId: str(row, 'sandbox_id'),
    turns: num(row, 'turns'),
    cursor: num(row, 'cursor'),
  };
}

/**
 * 一次事件后的会话状态迁移（关闭 → 只回收沙箱；重开/其它事件 → 复用并标 active）。
 *
 * 返回迁移结论供留痕；`keepSession=false`（首次创建）时只 INSERT 一行，不删任何东西。
 * `domain` 必须由调用方按 `v21SessionDomainOf()` 给出（BR-5）：这条 UPDATE 只碰一个域的行。
 */
export async function applyV21SessionOnEvent(
  db: SqlRunner,
  input: {
    readonly repo: string;
    /** 会话域（BR-5） */
    readonly domain: AgentSessionDomain;
    readonly issueNumber: number;
    readonly event: SessionEventKey;
    readonly issueState: 'open' | 'closed';
    readonly sandboxId?: string | null | undefined;
  },
): Promise<SessionTransition> {
  const read = await db.query(V21_SESSION_SQL.read, [
    input.repo,
    input.domain,
    input.issueNumber,
  ]);
  const row = read.rows[0] as Record<string, unknown> | undefined;
  const transition = planSessionOnEvent({
    session: v21SessionRowOf(row, input),
    issueState: input.issueState,
    event: input.event,
  });
  const sandboxId = input.sandboxId ?? null;
  if (transition.action === 'create') {
    await db.query(V21_SESSION_SQL.create, [
      input.repo,
      input.domain,
      input.issueNumber,
      transition.state,
      sandboxId,
    ]);
  } else if (transition.action === 'recycle-sandbox') {
    await db.query(V21_SESSION_SQL.recycle, [input.repo, input.domain, input.issueNumber]);
  } else {
    await db.query(V21_SESSION_SQL.reuse, [input.repo, input.domain, input.issueNumber, sandboxId]);
  }
  return transition;
}

/**
 * 该（域, 编号）此前是否已有**成功轮次**（FR-4.2 首轮判据的唯一实现）。
 *
 * 判据选 `agent_sessions.turns`（既有的会话行），理由见 `docs/audit/fix/WP4.md`：
 *  - `turns` 由执行面在**一轮真正跑完之后**加一（`app/compose.ts`），语义正好是
 *    「历史里已经有几轮对话」，而不是「收到过几条消息」；
 *  - 运行时**重置会话**（`sessionReset`）之后 `turns` 会被归零（`app/compose.ts`
 *    的 `persistAgentSessionAfterRun()`），本条随即判成「首轮」——这正是我们要的：
 *    新会话没有旧正文历史，必须重新下发全文。注意会话**不会**因轮数/天数轮换
 *    （P0-1 / FR-3.4 已删掉那条路径），所以「归零」只由运行时重置触发；
 *  - 比 `agent_messages` 计数便宜且不受「已入队未执行」干扰：一轮还没跑完时仍算首轮，
 *    宁可多给一次全文，也不要让 agent 缺上下文。
 *
 * 读不到会话行（还没建）/ 读库失败 → `true`（首轮）。失败只 warn，绝不让投递 500。
 *
 * `key` 必须带 `domain`（BR-5）：PR 域的首轮判据绝不能拿同号 issue 的 `turns` 去判，
 * 否则 PR 的第一句话会被当成「续跑」而只收到增量。
 */
export async function v21IsFirstEventOf(
  db: SqlRunner,
  key: AgentSessionKey,
  onWarn: (error: unknown) => void,
): Promise<boolean> {
  try {
    const result = await db.query(V21_SESSION_SQL.read, [key.repo, key.domain, key.issueNumber]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row === undefined || num(row, 'turns') <= 0;
  } catch (error) {
    onWarn(error);
    return true;
  }
}

/* ── 7. v2 独立分支：判定 → 渲染 → 落 agent_messages → 投递 ───────────────── */

/** 一条 v2 消息在库里的定位信息（全部来自 webhook 载荷，不依赖 v0.3 的 plan）。 */
export type V21MessageIdentity = {
  readonly issueNumber: number;
  readonly commentId: number | null;
  /** 评论正文（内容级幂等键的输入，FR-3.5）；事件消息为 `null`。 */
  readonly commentBody: string | null;
  readonly actorLogin: string;
  readonly issueUpdatedAt: string;
  readonly targetTitle: string | null;
  readonly targetBody: string | null;
};

/** 从载荷里抽 v2 消息要用的字段。`issue.number` 缺失时给 0（GitHub 编号从 1 起）。 */
export function v21MessageIdentityOf(payload: unknown): V21MessageIdentity {
  const root = asRecord(payload);
  const issue = asRecord(root?.['issue']);
  const comment = asRecord(root?.['comment']);
  const sender = asRecord(root?.['sender']);
  const issueUser = asRecord(issue?.['user']);
  const commentUser = asRecord(comment?.['user']);
  return {
    issueNumber: nullableNum(issue, 'number') ?? 0,
    commentId: nullableNum(comment, 'id'),
    commentBody: str(comment, 'body'),
    actorLogin:
      str(sender, 'login') ?? str(commentUser, 'login') ?? str(issueUser, 'login') ?? 'unknown',
    issueUpdatedAt: str(issue, 'updated_at') ?? '',
    targetTitle: str(issue, 'title'),
    targetBody: str(issue, 'body'),
  };
}
/**
 * 一条 v2 消息的幂等键（FR-3.5 三层去重里的「事件级 / 内容级」）。
 *
 * 分两条口径：
 *  - **来自评论**（载荷带 `comment.id` 与正文）：内容级 —— `repo + issue + 规范化正文`。
 *    措辞不同就是不同内容（宁可多处理一次），同一段话重复贴只处理一次，与作者无关；
 *    `issue.updated_at` 在这里**不能**当键：它的精度是秒，同一秒的两条不同评论会互相顶掉。
 *  - **其余事件**（opened / edited / labeled / closed…）：事件级 —— 模板 + `issue.updated_at`，
 *    模板文本天然相同，纯文本 hash 会把「第二次编辑」永久吞掉。
 *
 * 评论正文缺失（空串）时回落到事件级：此时内容级键无法区分不同评论，与其把所有空评论并成
 * 一条，不如按 `updated_at` 各算一轮。
 */
export function v21MessageFingerprint(input: {
  readonly repo: string;
  readonly identity: V21MessageIdentity;
  readonly eventKey: string;
}): string {
  const body = input.identity.commentBody ?? '';
  if (input.identity.commentId !== null && body.trim() !== '') {
    return commentFingerprint({
      repo: input.repo,
      issueNumber: input.identity.issueNumber,
      text: body,
    });
  }
  return eventFingerprint({
    repo: input.repo,
    issueNumber: input.identity.issueNumber,
    templateId: input.eventKey,
    issueUpdatedAt: input.identity.issueUpdatedAt,
  });
}

/** `handleWebhook()` 传给 v2 分支的运行时快照（webhook.ts 只负责拼这份 + 接线）。 */
export type V21WebhookRuntime = {
  readonly deps: V21WebhookDeps;
  readonly logger: Logger;
  readonly deliveryId: string;
  readonly event: string;
  readonly action: string | null;
  readonly payload: unknown;
  readonly repo: string;
  readonly settings: unknown;
  readonly dryRun: boolean;
  /** 已由 `decideV21Delivery()` 算好的判定（含 PR 的 `pr-ignored`） */
  readonly decision: TriggerDecision;
  /**
   * 本次是否被 v0.3 认成命令通道（`@bot /review-pr`）。
   * 命令任务 `source='command'` 的写回/幂等语义由旧路径负责，v2 分支一律不接管。
   */
  readonly legacyCommand: boolean;
  /** 部署 / 项目配置里的触发别名：渲染正文时摘掉（与 v0.3 的 `stripAliases` 同一口径）。 */
  readonly aliases?: readonly string[] | undefined;
  readonly dispatchAgent?:
    | ((key: { readonly repo: string; readonly issueNumber: number }) => Promise<unknown>)
    | undefined;
  readonly addEyesReaction?:
    | ((input: {
        readonly repo: string;
        readonly issueNumber: number;
        readonly commentId: number | null;
      }) => Promise<void>)
    | undefined;
};

export type V21WebhookOutcome = {
  readonly status: number;
  readonly body: WebhookAcceptedResponse | ErrorBody;
};

function v21Accepted(
  deliveryId: string,
  action: 'ignored' | 'enqueued' | 'duplicate',
  taskId: string | null,
  duplicate: boolean,
): WebhookAcceptedResponse {
  return { status: 'accepted', deliveryId, taskId, duplicate, action, ackComment: null };
}

/**
 * v2.1 的**独立分支**（与 v0.3 `submitAgentMessage()` 平行，不共用组装逻辑）。
 *
 * 返回 `null` = 本次不接管（旧命令通道 / 非 v2 事件），调用方继续跑旧管线；
 * 其余情况一律给出最终应答：
 *  - `pr-ignored` / `switch-off` / `not-mentioned` / `bot-self` … → 200 `ignored`，**不入队**；
 *  - 触发 → `resolveEventTrigger` 选模板 → `renderTemplateAsync` 渲染 → 正文写
 *    `agent_messages.comment_body`（`insertMessage` 的 `body` 参数）→ 即时 dispatch → 回执。
 *
 * 为什么必须独立：v0.3 的 `decideWebhookTask()` 只放行 `opened`/`edited` + `@提及`，
 * `issues.labeled` / `issues.closed` 即使 v2 判定为触发也会被它判 ignore 直接丢掉。
 * 把 v2 结果仅当作「旧消息正文的覆盖」是接不上 FR-2.1 的事件面的。
 */
export async function handleV21Webhook(rt: V21WebhookRuntime): Promise<V21WebhookOutcome | null> {
  if (rt.legacyCommand) {
    return null;
  }
  const { decision } = rt;
  if (!decision.triggered) {
    rt.logger.info(
      { repo: rt.repo, event: decision.event, reason: decision.reason },
      'v2.1 判定未触发：只留痕，不入队',
    );
    return { status: 200, body: v21Accepted(rt.deliveryId, 'ignored', null, false) };
  }

  const eventKey = decision.event;
  const identity = v21MessageIdentityOf(rt.payload);
  if (identity.issueNumber <= 0) {
    rt.logger.warn(
      { repo: rt.repo, event: eventKey, deliveryId: rt.deliveryId },
      'v2.1 载荷缺少 issue.number：按忽略处理',
    );
    return { status: 200, body: v21Accepted(rt.deliveryId, 'ignored', null, false) };
  }

  try {
    // 首轮判据（FR-4.2）：此前有没有跑过成功轮次，决定「全文」还是「增量」。
    // 键必须带域（BR-5）：PR 与同号 issue 各有各的首轮。
    const sessionKey: AgentSessionKey = {
      repo: rt.repo,
      domain: v21SessionDomainOf({ event: rt.event, payload: rt.payload }),
      issueNumber: identity.issueNumber,
    };
    const firstEvent = await v21IsFirstEventOf(
      rt.deps.db,
      sessionKey,
      (error) => {
        rt.logger.warn(
          { repo: rt.repo, issue: identity.issueNumber, err: describeError(error) },
          'v2.1 首轮判据读取失败：按首轮（全文）投喂',
        );
      },
    );
    const build = await buildV21AgentMessage({
      settings: rt.settings,
      event: eventKey,
      repo: rt.repo,
      eventAction: rt.action ?? '',
      payload: rt.payload,
      deps: rt.deps,
      logger: rt.logger,
      deliveryId: rt.deliveryId,
      // `decideEvent()` 已把项目 prompt（空白则回落到内置默认）解析成 template，直接用；
      // 首轮/后续轮的默认模板差异由 `pickEventTemplate()` 在 buildV21AgentMessage 内收口
      decidedTemplate: decision.template,
      firstEvent,
      ...(rt.aliases === undefined ? {} : { aliases: rt.aliases }),
    });
    const key = {
      repo: rt.repo,
      issueNumber: identity.issueNumber,
      fingerprint: v21MessageFingerprint({
        repo: rt.repo,
        identity,
        eventKey,
      }),
    };
    const saved = await insertMessage(rt.deps.db, {
      key,
      kind: 'event',
      commentId: identity.commentId,
      // ★ 渲染结果作为本轮发给 agent 的消息正文（落 agent_messages.comment_body）
      body: build.text,
      actorLogin: identity.actorLogin,
      skillIds: build.skillIds,
    });
    if (!saved.inserted) {
      const existing = await findTaskIdByKey(rt.deps.db, agentTaskIdempotencyKey(key)).catch(
        () => null,
      );
      rt.logger.info({ repo: rt.repo, issue: identity.issueNumber }, 'v2.1 消息幂等命中：不重复投递');
      return { status: 200, body: v21Accepted(rt.deliveryId, 'duplicate', existing, true) };
    }

    // 系统提示词的留痕（§6.7 SL-1）：会话下一次创建时带的就是这一份，写一次之后就冻结，
    // 失败只 warn（留痕是审计，不该让已经入库的事件变成 500）。
    try {
      await recordSessionSystemPrompt(rt.deps.db, {
        repo: rt.repo,
        domain: sessionKey.domain,
        issueNumber: sessionKey.issueNumber,
        settings: rt.settings,
      });
    } catch (error) {
      rt.logger.warn({ err: describeError(error) }, '会话系统提示词留痕失败（不影响投递）');
    }

    // 立刻为这个 issue 领一条（cron 只是兜底）；失败只 warn，不影响 200。
    if (rt.dispatchAgent !== undefined) {
      try {
        await rt.dispatchAgent({ repo: rt.repo, issueNumber: identity.issueNumber });
      } catch (error) {
        rt.logger.warn({ err: describeError(error) }, 'v2.1 agent 即时投递失败（留给兜底）');
      }
    }
    const taskId = await findTaskIdByKey(rt.deps.db, agentTaskIdempotencyKey(key)).catch(() => null);

    // dry-run 一个 GitHub 写动作都不发（与旧路径同一口径）。
    if (!rt.dryRun && rt.addEyesReaction !== undefined) {
      try {
        await rt.addEyesReaction({
          repo: rt.repo,
          issueNumber: identity.issueNumber,
          commentId: identity.commentId,
        });
      } catch (error) {
        rt.logger.warn({ err: describeError(error) }, 'v2.1 回执打 eyes 失败（不影响 200）');
      }
    }
    return { status: 200, body: v21Accepted(rt.deliveryId, 'enqueued', taskId, false) };
  } catch (error) {
    rt.logger.error(
      { repo: rt.repo, event: eventKey, err: describeError(error) },
      'v2.1 agent 消息落库失败',
    );
    return {
      status: 500,
      body: errorBodyOf('internal', 'v2.1 agent 消息落库失败'),
    };
  }
}
