/**
 * 关闭闸门（plan §7「关闭 issue」一行 + tech-plan §7.2 最后一段）。
 *
 * 硬约束：**判定只读 `issue_states` + `bot_labels` 两张表**，不发任何 GitHub 请求、
 * 不看 `actions` 历史。理由是「关闭」是 plan 里唯一不可回收的自动动作——判定链越短越好核，
 * 而且可以在没有网络的情况下重放。
 *
 * 五个条件（全部成立才关）：
 *  1. `needs-info` 在我们持有的标签里；
 *  2. `missing_set_hash IS NOT NULL`（当前仍有缺失项）；
 *  3. `now() - first_seen_at >= 48h`（这批缺失项已经摆了 48 小时）；
 *  4. `last_human_reply_at IS NULL` 或 `<= first_seen_at`（其间没有人回过话）；
 *  5. `closed_at IS NULL`（没关过）。
 *
 * 这一层**不执行关闭**：它返回一个布尔 + 逐条检查明细，真正的关闭由 `github/` 层做
 * （`decideCloseIssue({ deterministicConditionSatisfied })` 只接受外部传入的布尔，
 * 它自己不会去算——否则「谁算真相」就有两份了）。
 */
import { listBotLabels } from './bot-labels.ts';
import { loadIssueState } from './issue-state.ts';
import type { IssueStateSnapshot } from './issue-state.ts';
import type { SqlRunner } from './ports.ts';

/** 缺省标签名（仓库配置里 `labels.map['needs-info']` 映射成什么，由调用方传入）。 */
export const DEFAULT_NEEDS_INFO_LABEL = 'needs-info';

/** 48 小时宽限期（plan §7）。 */
export const CLOSE_GRACE_MS = 48 * 60 * 60 * 1000;

export type CloseGateCheckId =
  | 'needs-info-present'
  | 'missing-set-known'
  | 'grace-elapsed'
  | 'no-human-reply'
  | 'not-closed';

export type CloseGateCheck = {
  readonly id: CloseGateCheckId;
  readonly passed: boolean;
  /** 人读明细（进 `actions.audit` 与面板详情页）。 */
  readonly detail: string;
};

export type CloseGateDecision = {
  readonly shouldClose: boolean;
  /** 一句话结论：通过时说明「可以关」，未通过时指出**第一条**不满足的条件。 */
  readonly reason: string;
  /** 五条全列出来（不是只在失败处停），便于事后复盘「当时差哪一条」。 */
  readonly checks: readonly CloseGateCheck[];
  readonly graceMs: number;
  readonly now: Date;
};

export type CloseGateInput = {
  /** `issue_states` 的行；没有这一行就是「不关」。 */
  readonly state: IssueStateSnapshot | null;
  /** 我们持有的标签（`bot_labels` 里 `removed_at IS NULL` 的行）。 */
  readonly botLabels: readonly string[];
  readonly now?: Date;
  /** `needs-info` 在该仓库里的实际标签名（由 `labels.map` 决定）。 */
  readonly needsInfoLabel?: string;
  readonly graceMs?: number;
};

/** 纯判定：给定状态行与标签集，返回「能不能关」与逐条明细。 */
export function evaluateCloseGate(input: CloseGateInput): CloseGateDecision {
  const now = input.now ?? new Date();
  const needsInfoLabel = input.needsInfoLabel ?? DEFAULT_NEEDS_INFO_LABEL;
  const graceMs = input.graceMs ?? CLOSE_GRACE_MS;
  const state = input.state;

  const hasNeedsInfo = input.botLabels.includes(needsInfoLabel);
  const hasMissingSet = state?.missingSetHash !== null && state?.missingSetHash !== undefined;
  const firstSeenAt = state?.firstSeenAt ?? null;
  const elapsedMs = firstSeenAt === null ? null : now.getTime() - firstSeenAt.getTime();
  const graceElapsed = elapsedMs !== null && elapsedMs >= graceMs;
  const lastHumanReplyAt = state?.lastHumanReplyAt ?? null;
  // `<= first_seen_at` 才算「人没有再说话」：恰好同一时刻回复（同一次 webhook 批次）不算新回复。
  const noHumanReply =
    lastHumanReplyAt === null || (firstSeenAt !== null && lastHumanReplyAt.getTime() <= firstSeenAt.getTime());
  const notClosed = state === null ? false : state.closedAt === null;

  const checks: CloseGateCheck[] = [
    {
      id: 'needs-info-present',
      passed: hasNeedsInfo,
      detail: hasNeedsInfo ? `标签 ${needsInfoLabel} 在我方持有列表里` : `标签 ${needsInfoLabel} 不在我方持有列表里`,
    },
    {
      id: 'missing-set-known',
      passed: hasMissingSet,
      detail: hasMissingSet
        ? `missing_set_hash = ${String(state?.missingSetHash).slice(0, 12)}…`
        : 'missing_set_hash 为空（当前无缺失项）',
    },
    {
      id: 'grace-elapsed',
      passed: graceElapsed,
      detail:
        firstSeenAt === null
          ? 'first_seen_at 为空：这批缺失项还没有计时起点'
          : `已过 ${Math.floor((elapsedMs ?? 0) / 3_600_000)} 小时（要求 ≥ ${Math.floor(graceMs / 3_600_000)} 小时）`,
    },
    {
      id: 'no-human-reply',
      passed: noHumanReply,
      detail:
        lastHumanReplyAt === null
          ? '期间没有任何人工回复'
          : `最近人工回复 ${lastHumanReplyAt.toISOString()}（本次缺失项首次出现 ${firstSeenAt?.toISOString() ?? '（空）'}）`,
    },
    {
      id: 'not-closed',
      passed: notClosed,
      detail: state === null ? 'issue_states 里没有这一行' : state.closedAt === null ? '尚未关闭' : `已于 ${state.closedAt.toISOString()} 关闭`,
    },
  ];

  const firstFailed = checks.find((check) => !check.passed);
  return {
    shouldClose: firstFailed === undefined,
    reason:
      firstFailed === undefined
        ? '五个条件全部满足：可以关闭'
        : `不关闭：${firstFailed.id}（${firstFailed.detail}）`,
    checks,
    graceMs,
    now,
  };
}

/** 从库里读两张表后判定（这是生产路径；`evaluateCloseGate` 保持纯函数以便单测）。 */
export async function loadCloseGateDecision(
  db: SqlRunner,
  input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly now?: Date;
    readonly needsInfoLabel?: string;
    readonly graceMs?: number;
  },
): Promise<CloseGateDecision> {
  const state = await loadIssueState(db, { repo: input.repo, issueNumber: input.issueNumber });
  const botLabels = await listBotLabels(db, { repo: input.repo, issueNumber: input.issueNumber });
  return evaluateCloseGate({
    state,
    botLabels,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.needsInfoLabel === undefined ? {} : { needsInfoLabel: input.needsInfoLabel }),
    ...(input.graceMs === undefined ? {} : { graceMs: input.graceMs }),
  });
}