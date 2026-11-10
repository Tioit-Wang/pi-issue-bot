/**
 * `feedback/` 的公开出口（W2-D）：
 *
 * ```ts
 * // 终态收尾（worker/run-task.ts）
 * const outcome = await applyFeedback({ ledger, reactions, flags, logger }, {
 *   repo, targetKind, targetNumber, stage: feedbackStageForOutcome(outcome), anchor: idempotencyKey,
 * });
 * ```
 *
 * 依赖方向：`worker → feedback → github`（reaction 的 REST 细节在 `github/`，
 * 台账 SQL 在本模块）。`feedback/` 不 import `worker/`、`http/`、`queries/`。
 */
export {
  applyFeedback,
  removeOwnReaction,
} from './apply.ts';
export type {
  RemoveOwnReactionDeps,
  RemoveOwnReactionInput,
} from './apply.ts';

export {
  STAGE_CLEARS,
  STAGE_CONTENT,
  contentForStage,
  feedbackStageForOutcome,
  isTerminalStage,
  planStage,
} from './stage.ts';
export type { StagePlan } from './stage.ts';

export { FEEDBACK_SQL, REACTIONS_DISABLED_FLAG, REACTIONS_FLAG_SQL } from './sql.ts';

export {
  FEEDBACK_STAGE_VALUES,
  FEEDBACK_TARGET_KIND_VALUES,
  createPgFeedbackLedger,
  createPgReactionsFlagStore,
} from './pg.ts';
export type { PgFeedbackLedgerOptions, PgReactionsFlagStoreOptions } from './pg.ts';

export {
  FEEDBACK_STAGES,
  FEEDBACK_STATUSES,
  FEEDBACK_TARGET_KINDS,
} from './types.ts';
export type {
  ApplyFeedbackInput,
  FeedbackClaim,
  FeedbackDeps,
  FeedbackLedger,
  FeedbackLogger,
  FeedbackOutcome,
  FeedbackRow,
  FeedbackStage,
  FeedbackStatus,
  FeedbackTarget,
  FeedbackTargetKind,
  ReactionsFlagStore,
} from './types.ts';
