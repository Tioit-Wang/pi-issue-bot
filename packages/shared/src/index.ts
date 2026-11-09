/**
 * `@pi-issue-bot/shared` 的公共出口（叶子包，零业务依赖）。
 *
 * 硬约束（tech-plan §8.2 + dev-setup §3.2）：本包不得 import `apps/*` 或其它 `packages/*`。
 * 下游怎么用：
 * - 日志：`createLogger({ service: 'pi-bot' })`，全程 `logger.child({ taskId })` 穿 id；
 * - 脱敏：任何往日志/错误消息里放外部字符串之前先过 `redactSecrets`；
 * - 取消：`runWithDeadline({ ms, parent }, (signal) => ...)`；
 * - 失败：`AppError` 必须带 `failureClass`，重试决策只读它（tech-plan §7.3）。
 */
export {
  REDACTED,
  SECRET_PREFIXES,
  escapeRegExp,
  previewRedacted,
  redactSecrets,
  redactValue,
} from './redact.ts';

export { REDACT_PATHS, createLogger, createNullLogger } from './logger.ts';
export type { LogBindings, LogMethod, Logger, LoggerOptions } from './logger.ts';

export { AppError, FAILURE_CLASSES, isAppError, toAppError } from './errors.ts';
export type { FailureClass } from './errors.ts';

export { err, fromPromise, isErr, isOk, mapResult, ok, unwrap, unwrapOr } from './result.ts';
export type { Result } from './result.ts';

export { DEADLINE_EXCEEDED, INTERRUPTED, runWithDeadline } from './deadline.ts';
export type { RunWithDeadlineOptions } from './deadline.ts';
