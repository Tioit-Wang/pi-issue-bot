/**
 * reaction 状态机（`docs/plan-multi-repo.md` §5 那张表，逐行落成代码）。
 *
 * ```text
 * 阶段                          GitHub 动作                 目标
 * received（入队成功）           +eyes                       触发评论；issue/PR 事件 → 主贴
 * succeeded                     -eyes → +rocket             同锚点
 * failed / timed-out / cancelled  -eyes → +confused           同锚点
 * 重复投递 / 门禁拒绝 / dry-run   不动 GitHub（dry-run 只写 run_events: feedback.planned）
 * ```
 *
 * 两条「必须」与一条「绝不」：
 *  - **必须**先删 `eyes` 再加终态：这是两次跨 content 的调用，省不掉；
 *  - **必须**只删自己打的（`github/executor.ts::pickOwnReactionIds`）；
 *  - **绝不**为了刷新状态把同一个 content 删了重加：删了重加会换 `reaction_id`，
 *    白白多一次审计（plan §5 的实测结论）。
 */
import type { ReactionContent } from '../github/types.ts';
import type { FeedbackStage } from './types.ts';

/** 阶段 → 要加的 reaction。 */
export const STAGE_CONTENT: Readonly<Record<FeedbackStage, ReactionContent>> = {
  received: 'eyes',
  succeeded: 'rocket',
  failed: 'confused',
  'timed-out': 'confused',
  cancelled: 'confused',
};

/** 阶段 → 需要先删掉的 reaction（终态都先收 `eyes`；`received` 没有前置）。 */
export const STAGE_CLEARS: Readonly<Record<FeedbackStage, ReactionContent | null>> = {
  received: null,
  succeeded: 'eyes',
  failed: 'eyes',
  'timed-out': 'eyes',
  cancelled: 'eyes',
};

/** 该阶段要打的 reaction content。 */
export function contentForStage(stage: FeedbackStage): ReactionContent {
  return STAGE_CONTENT[stage];
}

/** 终态（`received` 之外都是终态）：终态才需要「先删 eyes」。 */
export function isTerminalStage(stage: FeedbackStage): boolean {
  return stage !== 'received';
}

/**
 * `runs.outcome` → 反馈阶段。
 *
 * 刻意**不收窄成 `RunOutcome` 联合**：`feedback/` 不该 import `worker/types.ts`
 * （worker 依赖 feedback，反向依赖会成环），传进来就是一个字符串。
 *
 * 映射口径（plan §5 第 3 行）：只有 `succeeded` 是火箭，`timed-out` / `cancelled`
 * 各自保留自己的阶段名（面板要能区分「超过」与「被取消」），其余一律 `failed`。
 */
export function feedbackStageForOutcome(outcome: string): FeedbackStage {
  switch (outcome) {
    case 'succeeded':
      return 'succeeded';
    case 'timed-out':
      return 'timed-out';
    case 'cancelled':
      return 'cancelled';
    default:
      // failed / degenerate-output / 未知 → 一律 confused
      return 'failed';
  }
}

/** 这次阶段切换需要做哪些动作（纯函数，单测直接钉这张表）。 */
export type StagePlan = {
  readonly stage: FeedbackStage;
  readonly add: ReactionContent;
  readonly remove: ReactionContent | null;
  readonly terminal: boolean;
};

export function planStage(stage: FeedbackStage): StagePlan {
  return {
    stage,
    add: contentForStage(stage),
    remove: STAGE_CLEARS[stage],
    terminal: isTerminalStage(stage),
  };
}
