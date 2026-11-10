/**
 * `queue/` 的公共出口（tech-plan §8.2：`http/webhook` 与 `worker/` 都经这里用队列）。
 *
 * 分工：
 *  - `definitions.ts` —— 队列/定时任务的单一事实源（名字、并发、`expireInSeconds`、cron）
 *  - `failure-class.ts` —— `failure_class` 优先级表（§7.3 第一张表）
 *  - `retry-policy.ts` —— 重试矩阵（§7.3 第二张表）→ pg-boss 选项
 *  - `idempotency.ts` —— `tasks.idempotency_key` 公式（§7.2 F9）
 *  - `queue-gate.ts` —— 排队闸门（§4.7 第三行，F5）
 *  - `circuit-breaker.ts` —— 全局 429 熔断（§7.4）
 *  - `boss.ts` —— pg-boss 封装（实例外部注入，可测）
 *  - `compat.ts` —— 编译期断言：真实 `pg.Pool` / `PgBoss` 能直接喂给上面的注入点（无运行时副作用）
 */

export {
  EXPIRE_IN_SECONDS_DEFAULT,
  EXPIRE_IN_SECONDS_REVIEW_PR,
  QUEUE,
  QUEUES,
  REVIEW_PR_COMMAND,
  SCHEDULES,
  ensureQueues,
  expireInSecondsForCommand,
  queueSpecOf,
  registerSchedules,
  validateDefinitions,
} from './definitions.ts';
export type {
  CreateQueueOptions,
  DefinitionLogger,
  DefinitionViolation,
  QueueAdminBoss,
  QueueName,
  QueueSpec,
  ScheduleAdminBoss,
  ScheduleSpec,
} from './definitions.ts';

export {
  FAILURE_CLASS_PRIORITY,
  classifyHttpStatus,
  pickFailureClass,
  pickHighestPrioritySignal,
  priorityOf,
  signalFromHttp,
} from './failure-class.ts';
export type { FailureClass, FailureSignal } from './failure-class.ts';

export {
  MAX_RATE_LIMIT_ATTEMPTS,
  RATE_LIMIT_FALLBACK_DELAY_SECONDS,
  SANDBOX_CRASH_RETRY_LIMIT,
  SERVER_ERROR_RETRY_DELAY_SECONDS,
  SERVER_ERROR_RETRY_LIMIT,
  decideRetry,
  rateLimitBackoffSeconds,
  toSendOptions,
} from './retry-policy.ts';
export type { RetryContext, RetryDecision, RetrySendOptions } from './retry-policy.ts';

export { MISSING_ANCHOR, anchorFor, buildIdempotencyKey, idempotencyParts } from './idempotency.ts';
export type { IdempotencyInput } from './idempotency.ts';

export {
  QUEUE_GATE_BATCH_LIMIT,
  QUEUE_GATE_CANCEL_SQL,
  QUEUE_GATE_REACTION,
  QUEUE_GATE_SQL,
  QUEUE_WAIT_LIMIT_MINUTES,
  QUEUE_WAIT_LIMIT_SECONDS,
  isQueueTimedOut,
  queueGateActions,
  queueWaitMinutesOf,
  queueWaitSeconds,
  resolveQueueWaitMinutes,
  smallestQueueWaitSeconds,
} from './queue-gate.ts';
export type {
  QueueGateAction,
  QueueGateCandidate,
  QueueGateReactionPort,
  QueueWaitLimit,
} from './queue-gate.ts';

export {
  DEFAULT_CONCURRENCY_PER_REPO,
  MAX_CONCURRENCY_PER_REPO,
  MIN_CONCURRENCY_PER_REPO,
  RepoConcurrencyLimiter,
  concurrencyPerRepoOf,
} from './repo-concurrency.ts';
export type { RepoConcurrencyGate } from './repo-concurrency.ts';

export {
  CircuitBreaker,
  RATE_LIMIT_PAUSE_SECONDS,
  RATE_LIMIT_TRIP_THRESHOLD,
  REPO_RATE_LIMIT_TRIP_THRESHOLD,
  REPO_RATE_LIMIT_WINDOW_SECONDS,
  RUNTIME_FLAG_SQL,
  RateLimitWindowBreaker,
  breakerFlagRow,
  installationPauseKey,
  isPauseFlagActive,
  pauseRedeliverSeconds,
} from './circuit-breaker.ts';
export type {
  BreakerLevel,
  BreakerOptions,
  BreakerState,
  CircuitBreakerOptions,
  PauseFlagRow,
  RuntimeFlagRow,
} from './circuit-breaker.ts';

export {
  bootstrapQueue,
  cancelTaskJob,
  createBoss,
  enqueueRetry,
  enqueueTask,
  findTaskJobId,
  queueJobOptions,
  registerScheduleWorker,
  registerTaskWorker,
  startBoss,
  stopBoss,
} from './boss.ts';
export type {
  CreateBossOptions,
  QueueBoss,
  QueueJob,
  RunTaskJobData,
  TaskJob,
  TaskJobHandler,
  TaskWorkerOptions,
  WorkBoss,
} from './boss.ts';
