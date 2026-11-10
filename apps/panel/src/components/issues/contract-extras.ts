/**
 * Issue 中心 / 详情页要用的**反馈与打标字段读取器**。
 *
 * 这些字段由 W3-H 加进 `packages/contract/src/api.ts`（并联进行中），契约里是：
 *
 * - `IssueListItem.reactionState: IssueFeedbackEvent | null`
 * - `IssueListItem.labelDecisions: IssueLabelDecisionSummary | null`
 * - `IssueListItem.feedback: IssueFeedbackEvent[]`
 * - `IssueSummary.reactionState / pendingFeedback`（详情页头部）
 *
 * 为什么不直接在页面里写 `item.reactionState?.content`：查询层刚刚落地、mock 还在补，
 * 页面既要**现在**能跑，也要在字段缺失（旧响应 / 形状漂移 / dry-run 没台账）时**不炸**。
 * 所以这里做一层运行时宽容读取，并且**同时认新旧两种拼写**（`labelDecisions` / `labelDecision`、
 * `feedback` / `pendingFeedback` / `feedbackTimeline`）——前端不需要跟着后端改一次名就改一遍页面。
 *
 * 约定（与 `lib/repos.ts` 的 `normalizeRepoList` 同一套：宽容 + 保守）：
 * 「字段缺失」与「值为 null」在展示层**同义**（显示 `—`）：面板无法区分
 * 「后端说不适用」与「后端还没实现」，这里不假装知道。
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // 有的接口把数值序列化成字符串（pg 的 numeric → text），认得出来就用
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asStringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const list: string[] = [];
  for (const item of value.slice(0, max)) {
    const text = asString(item);
    if (text !== null && !list.includes(text)) list.push(text);
  }
  return list;
}

/* ── reaction 状态（`issue_feedback` 的最新终态） ───────────────────────────── */

/** 契约里的三个 reaction：入队 `eyes` → 终态 `rocket`（成功）/ `confused`（失败、缺信息）。 */
export const REACTION_STATES = ['eyes', 'rocket', 'confused'] as const;
export type ReactionState = (typeof REACTION_STATES)[number];
/** `null` = 没有记录（dry-run 仓库只写 `run_events(feedback.planned)`，不动 GitHub）。 */
export type ReactionValue = ReactionState | null;

/** 认字符串与 `{ content }` 两种形态（契约是后者：整个 `IssueFeedbackEvent`）。 */
export function toReactionState(value: unknown): ReactionValue {
  const direct = typeof value === 'string' ? value : asString(asRecord(value)?.['content']);
  if (direct === null) return null;
  return REACTION_STATES.find((state) => state === direct) ?? null;
}

export function readReactionState(source: unknown): ReactionValue {
  return toReactionState(pick(source, 'reactionState'));
}

/* ── 反馈台账（`issue_feedback`） ─────────────────────────────────────────── */

export type FeedbackEntry = {
  /** `issue_feedback.stage`：`received` / `succeeded` / `failed` / `timed-out` / `cancelled`。 */
  stage: string;
  /** 打上/摘掉的 reaction content；契约外取值或计划态为 `null`。 */
  content: ReactionValue;
  /** 实际落地时刻（`applied_at`）；dry-run 计划态为 `null`。 */
  appliedAt: string | null;
  /** 记台账的时刻（`created_at`）。 */
  at: string | null;
};

function toFeedbackEntry(value: unknown): FeedbackEntry | null {
  const record = asRecord(value);
  const stage = asString(record?.['stage']);
  if (record === null || stage === null) return null;
  return {
    stage,
    content: toReactionState(record['content']),
    appliedAt: asString(record['appliedAt']),
    at: asString(record['at']),
  };
}

/**
 * 读反馈时间线：`feedback`（列表行）→ `pendingFeedback`（会话头部，只含**未落地**的计划态）
 * → `feedbackTimeline`（早期草拟名）。三个都认，取第一个非空来源。
 */
export function readFeedbackTimeline(source: unknown): FeedbackEntry[] {
  for (const key of ['feedback', 'pendingFeedback', 'feedbackTimeline'] as const) {
    const raw = pick(source, key);
    if (!Array.isArray(raw)) continue;
    const entries: FeedbackEntry[] = [];
    for (const item of raw.slice(0, 20)) {
      const entry = toFeedbackEntry(item);
      if (entry !== null) entries.push(entry);
    }
    if (entries.length > 0) return entries;
  }
  return [];
}

/* ── 标签判定（`bot_labels.reason` + `label_decisions`） ────────────────────── */

export type BlockedReason = { reason: string; count: number };

export type LabelDecisionView = {
  /** 最近一次判定的时刻（`label_decisions.created_at`）；没判定过为 `null`。 */
  lastAt: string | null;
  /** 为什么打这些标（面向人的一句话）。 */
  reason: string | null;
  /** 想要打但没打上的（`desired` − `applied`）。 */
  blockedLabels: string[];
  /** 被拦原因（按 `blocked_reason` 聚合，数量降序）。 */
  blocked: BlockedReason[];
  /** 「缺哪些信息」清单（来自 `reason` 的切分；见 `missingInfoFromReason`）。 */
  missing: string[];
};

/**
 * `reason` → 「缺哪些信息」清单。
 *
 * 判定依据写在提示词里（`docs/impl-multi-repo.md` §0.3：合规缺失项由提示词控制，
 * 明细只落 `label_decisions.reason`），所以这里是**纯展示层切分**，不猜语义：
 * 先按行切，单行再按 `；`/`;` 切，去掉行首的项目符号与编号，最多 12 条。
 */
export function missingInfoFromReason(reason: string | null): string[] {
  if (reason === null) return [];
  const lines = reason
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const parts = lines.length > 1 ? lines : (lines[0] ?? '').split(/[；;]/);

  const items: string[] = [];
  for (const part of parts) {
    const cleaned = part.replace(/^\s*(?:[-*·]|\d+[.)、])\s*/, '').trim();
    if (cleaned !== '' && !items.includes(cleaned)) items.push(cleaned);
  }
  return items.slice(0, 12);
}

function toBlockedList(value: unknown): BlockedReason[] {
  if (!Array.isArray(value)) return [];
  const list: BlockedReason[] = [];
  for (const item of value.slice(0, 20)) {
    const record = asRecord(item);
    const reason = asString(record?.['reason']);
    if (record === null || reason === null) continue;
    list.push({ reason, count: asFiniteNumber(record['count']) ?? 1 });
  }
  return list;
}

/**
 * 读打标判定摘要。
 *
 * 契约位置：列表行 `labelDecisions`（复数，`IssueLabelDecisionSummary`）。
 * 同时容忍 `labelDecision`（单数，早期接口草稿）与 `{ issue: { ... } }` 嵌套。
 */
export function readLabelDecision(source: unknown): LabelDecisionView | null {
  const raw = pick(source, 'labelDecisions') ?? pick(source, 'labelDecision');
  const record = asRecord(raw);
  if (record === null) return null;

  const reason = asString(record['reason']);
  const desired = asStringList(record['desired'], 50);
  const applied = asStringList(record['applied'], 50);
  const blocked = toBlockedList(record['blocked']);
  const blockedLabels = desired.filter((label) => !applied.includes(label));

  // 结构化 `missing` 优先（后端若给），否则从 reason 切分；再不行退回被拦原因
  const explicit = asStringList(record['missing'], 12);
  const missing =
    explicit.length > 0
      ? explicit
      : missingInfoFromReason(reason).length > 0
        ? missingInfoFromReason(reason)
        : blocked.map((item) => item.reason);

  if (reason === null && blocked.length === 0 && missing.length === 0 && desired.length === 0) return null;
  return { lastAt: asString(record['lastAt']), reason, blockedLabels, blocked, missing };
}

/* ── 每次 run 的耗时与成本 ───────────────────────────────────────────────── */

export type RunCost = {
  /** 跑一次 run 的毫秒数；没有跑过/还在跑为 `null`。 */
  durationMs: number | null;
  /** 这一次 run 的成本（USD，4 位小数）；未计价为 `null`（≠ 0）。 */
  costUsd: number | null;
};

/** 读耗时/成本（字段名 `durationMs` / `costUsd`；契约**还没**提供这两个字段时返回 null）。 */
export function readRunCost(source: unknown): RunCost {
  const record = asRecord(source);
  if (record === null) return { durationMs: null, costUsd: null };
  return {
    durationMs: asFiniteNumber(record['durationMs']),
    costUsd: asFiniteNumber(record['costUsd']),
  };
}

/**
 * 顶层读不到就退回 `source.issue.<key>`：
 * 列表行的字段在顶层；会话响应的这些字段挂在 `issue`（`IssueSummary`）上——两处都认。
 */
function pick(source: unknown, key: string): unknown {
  const top = asRecord(source);
  if (top === null) return undefined;
  const direct = top[key];
  if (direct !== undefined && direct !== null) return direct;
  const nested = asRecord(top['issue']);
  if (nested === null) return undefined;
  return nested[key];
}