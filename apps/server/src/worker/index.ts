/**
 * `worker/` 的对外出口（B13）。
 *
 * 两个入口，语义相同、装配方式不同：
 *  - `createTaskRunner(deps)`：一次装配、多次执行（`run-task` 的 worker 用这个，
 *    依赖里的 docker/host/store 都是长生命周期对象）；
 *  - `runTask(input, deps)`：单次执行（测试、`replay` 子命令用）。
 *
 * 队列侧接法（tech-plan §4.3 / §7.3）：
 * ```ts
 * const runner = createTaskRunner(deps);
 * await registerTaskWorker(boss, async (job) => {
 *   const report = await runner.runTask(toRunInput(job.data));
 *   // 重试决策只读 report.retry（worker 自己不重投，见 queue/retry-policy.ts）
 *   if (report.retryable) await enqueueRetry(boss, job.data, report.retry);
 * });
 * ```
 *
 * 依赖方向（tech-plan §8.2）：`worker → runtime, sandbox, git(暂缺), envelope, github, degeneracy, queue, db`。
 * 唯一不能指向的是 `http/`（eslint 的 import-x 规则拦着，worker 不能反向依赖接入层）。
 */
import { runTask as runTaskImpl } from './run-task.ts';
import type { TaskRunInput, TaskRunReport, TaskRunner, TaskRunnerDeps } from './types.ts';

/** 记得住的运行器：`deps` 里应当放长生命周期对象（docker / host / store / proxy）。 */
export function createTaskRunner(deps: TaskRunnerDeps): TaskRunner {
  return {
    runTask: (input: TaskRunInput): Promise<TaskRunReport> => runTaskImpl(input, deps),
  };
}

/** 单次执行（不装配运行器）。 */
export function runTask(input: TaskRunInput, deps: TaskRunnerDeps): Promise<TaskRunReport> {
  return runTaskImpl(input, deps);
}

export {
  REVIEW_PR_COMMAND,
  decideOutcome,
  timeoutMsForCommand,
  toTaskStatus,
  toTaskOutcome,
} from './run-task.ts';

export { createPgRunStore } from './run-store.ts';
export type { PgRunStoreOptions } from './run-store.ts';

export {
  WORKTREE_UNAVAILABLE,
  createEmptyTargetContextPort,
  createExecProxyPort,
  createLifecycleDisposer,
  createSupervisorHostPort,
  createUnavailableWorktreePort,
} from './ports.ts';

export {
  actionTargetOf,
  describeDropped,
  executeActions,
  previewLabelDelta,
  toWriteActions,
} from './writeback.ts';
export type { ExecuteActionsInput, ExecuteActionsResult } from './writeback.ts';

export { envelopeRowOf, findEnvelopeText, prepareEnvelope } from './envelope.ts';
export type { CapturedEvent, EnvelopeFilterOptions } from './envelope.ts';

export {
  isInterruptError,
  isTimeoutError,
  observeCommandTimeout,
  signalFromContainerState,
  signalFromDegeneracy,
  signalFromError,
  signalFromGithub,
  signalFromParse,
  toQueueFailureClass,
} from './failure.ts';
export type { CommandTimeoutObservation } from './failure.ts';

export { ACTION_STATUSES, RUN_OUTCOMES, TASK_STEPS, WORKER_TASK_STATUS } from './types.ts';
export type {
  ActionOutcome,
  ActionRecord,
  ActionStatus,
  EndpointRegistry,
  EnvelopeRecord,
  ExecEndpoint,
  ExecProxyPort,
  HostEndpoint,
  HostPort,
  LifecycleDisposer,
  PreparedEnvelope,
  RunOutcome,
  RunStore,
  TargetContextPort,
  TaskRunInput,
  TaskRunReport,
  TaskRunner,
  TaskRunnerDeps,
  TaskStep,
  WorkerTaskStatus,
  WorktreeHandle,
  WorktreePort,
  WriteTargetContext,
} from './types.ts';
