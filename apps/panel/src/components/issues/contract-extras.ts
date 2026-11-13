/**
 * Issue 中心 / 详情页要用的**反馈字段读取器**。
 *
 * 契约里是 `IssueListItem.reactionState / feedback` 与 `IssueSummary.reactionState / pendingFeedback`。
 * 页面既要**现在**能跑，也要在字段缺失（旧响应 / dry-run 没台账）时**不炸**，所以这里做一层
 * 运行时宽容读取：字段缺失与值为 null 在展示层同义（显示 `—`）。
 *
 * 打标判定摘要（`label_decisions`：结论理由 / 缺哪些信息）已随「结论正文 / 标签与理由」区块
 * 一起移除——详情页只展示会话本身，不再复述那套已过时的产出视图。
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