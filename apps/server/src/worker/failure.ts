/**
 * 失败信号汇总（tech-plan §7.3 第一张表，F6）。
 *
 * 三条规则，代码里逐条可见：
 *  1. **先收集全部信号，再按优先级取一个**：`queue/failure-class.ts` 的
 *     `pickHighestPrioritySignal()` 是唯一裁判，worker 自己不比较。
 *     只看「最后一个观测到的信号」会让「既超时又崩溃」的 run 走进 `sandbox-crash`
 *     的 `retryLimit: 1` 分支被自动重跑（plan §9.1 明确禁止）。
 *  2. **容器退出码只在「本轮已经不算成功」时才升级为信号**：任务级超时的实现就是 kill 容器，
 *     容器退出码与崩溃无法区分；反过来，一个成功跑完的 turn 里 agent 自己 kill 掉的命令
 *     也会留下非零退出码，把它当 `sandbox-crash` 会把成功任务判成失败。
 *     所以这个判断由 `run-task.ts` 在知道 outcome 之后调用（本文件只提供纯映射）。
 *  3. **命令级超时不是失败信号**：§7.3 的「命令级超时 → retry:false，交给 agent 换策略」
 *     意味着它根本不该改变 `runs.failure_class`。它只进 `failure_detail.commandTimeouts`
 *     供审计——若把它算成 `timeout`（优先级 1），一次慢命令就会让整个任务被判超时且永不重试。
 */
import type { DegeneracyHit } from '../degeneracy/index.ts';
import { classifyGithubError } from '../github/errors.ts';
import type { FailureClass, FailureSignal } from '../queue/index.ts';
import type { ContainerStateSnapshot } from '../sandbox/index.ts';
import { isAppError, toAppError } from './deps.ts';

/** shared 的 `FailureClass` 字面量与 `queue` 的（来自 db schema）不完全一致，这里做一次归一。 */
const SHARED_TO_QUEUE: Readonly<Record<string, FailureClass>> = Object.freeze({
  timeout: 'timeout',
  interrupt: 'interrupt',
  'degenerate-output': 'degenerate-output',
  'sandbox-oom': 'sandbox-oom',
  'sandbox-crash': 'sandbox-crash',
  auth: 'auth',
  'rate-limit': 'rate_limit',
  model: 'model',
  parse: 'parse',
  'github-api': 'github_api',
  // `sandbox` 表示「沙箱层自身不可用」（worktree 缺实现、docker 不可达）。
  // 它没有独立的 `failure_class`，按「容器侧环境问题」归到 `sandbox-crash`（优先级 3，最多重试 1 次）。
  sandbox: 'sandbox-crash',
  unknown: 'unknown',
});

/** shared 的失败分类 → `runs.failure_class` 的取值。 */
export function toQueueFailureClass(failureClass: string): FailureClass {
  return SHARED_TO_QUEUE[failureClass] ?? 'unknown';
}

/** 把任意抛出物变成一条信号（`AppError` 的分类照抄，其余归 `unknown`）。 */
export function signalFromError(error: unknown, detail?: string): FailureSignal {
  // 不写显式标注：`toAppError()` 的返回类型就是 `AppError`，标注只会把类型当值引入。
  const appError = toAppError(error, { code: 'WORKER_FAILED', failureClass: 'unknown' });
  return {
    failureClass: toQueueFailureClass(appError.failureClass),
    detail: detail ?? `${appError.code}: ${appError.message}`,
  };
}

/** 是否是任务级超时（`runWithDeadline` 抛的 `failureClass:'timeout'`）。 */
export function isTimeoutError(error: unknown): boolean {
  return isAppError(error) && error.failureClass === 'timeout';
}

/** 是否是取消（父 `AbortSignal` 触发）。 */
export function isInterruptError(error: unknown): boolean {
  return isAppError(error) && error.failureClass === 'interrupt';
}

/**
 * 容器状态 → 信号（§3.6 / §6.3）。
 *
 * **必须先看 OOM 再看退出码**：反过来一次 OOM 会被记成普通崩溃，
 * 走进「自动重试 1 次」再 OOM 一遍。`sandbox/lifecycle.ts::classifyDestroyedState()`
 * 已按这个顺序实现，本函数与它保持一致（顺序在注释与单测里都写死）。
 */
export function signalFromContainerState(
  state: ContainerStateSnapshot | null,
): FailureSignal | undefined {
  if (state === null) {
    return undefined;
  }
  if (state.oomKilled) {
    return {
      failureClass: 'sandbox-oom',
      detail: `容器 OOMKilled（exitCode=${String(state.exitCode)}）`,
    };
  }
  if (state.exitCode !== 0) {
    return {
      failureClass: 'sandbox-crash',
      detail: `容器非零退出（exitCode=${String(state.exitCode)}, status=${state.status}）`,
    };
  }
  return undefined;
}

/** 熔断命中 → `degenerate-output`（优先级 1，不重试）。 */
export function signalFromDegeneracy(hit: DegeneracyHit): FailureSignal {
  const detail = Object.entries(hit.detail)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ');
  return {
    failureClass: 'degenerate-output',
    detail: `重复输出熔断命中：${hit.criterion}（${detail}）`,
  };
}

/** 信封缺失 / 校验失败 → `parse`（优先级 4，不重试）。 */
export function signalFromParse(detail: string): FailureSignal {
  return { failureClass: 'parse', detail };
}

/**
 * GitHub 写失败 → 信号（带 HTTP 状态与 `retry-after`）。
 *
 * 分类直接复用 `github/errors.ts::classifyGithubError()`：429 的退避时长要按响应头算，
 * 在 worker 里重写一份「429 还是 401」的判定必然与它漂移。
 */
export function signalFromGithub(error: unknown): FailureSignal {
  const info = classifyGithubError(error);
  const failureClass: FailureClass =
    info.class === 'rate_limit' ? 'rate_limit' : info.class === 'auth' ? 'auth' : 'github_api';
  return {
    failureClass,
    httpStatus: info.status,
    retryAfterSeconds:
      info.retryAfterMs === null ? null : Math.max(1, Math.round(info.retryAfterMs / 1_000)),
    detail: `GitHub 写失败：${info.class}（HTTP ${
      info.status === null ? 'no-response' : String(info.status)
    }）${info.message}`,
  };
}

/** 观测到的「命令级超时」（进 `failure_detail`，**不参与**分类，见文件头第 3 条）。 */
export interface CommandTimeoutObservation {
  readonly cmdId?: string;
  readonly detail: string;
}

/** 从一条事件里抽命令级超时（容器内 `timeout` 生效 / 宿主看门狗触发）。 */
export function observeCommandTimeout(event: {
  readonly kind: string;
  readonly payload: unknown;
}): CommandTimeoutObservation | undefined {
  const payload = event.payload;
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const error = record['error'];
  const code =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>)['code'] : undefined;
  const cmdId = typeof record['cmdId'] === 'string' ? record['cmdId'] : undefined;
  const exitCode = record['exitCode'];
  // 容器内 `timeout -s KILL` 的退出码：124（timeout 自己的约定）或 137（KILL 后的 128+9）。
  const timedOut =
    code === 'EXEC_TIMEOUT' || record['timedOut'] === true || exitCode === 124 || exitCode === 137;
  if (!timedOut) {
    return undefined;
  }
  return {
    ...(cmdId === undefined ? {} : { cmdId }),
    detail: `命令级超时（kind=${event.kind}, exitCode=${String(
      typeof exitCode === 'number' ? exitCode : 'n/a',
    )}, code=${String(typeof code === 'string' ? code : 'n/a')}）`,
  };
}
