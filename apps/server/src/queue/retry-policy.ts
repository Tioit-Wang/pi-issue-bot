/**
 * 重试矩阵（tech-plan §7.3 第二张表 → pg-boss 12 选项）。
 *
 * **只读最高优先级的那一个类**：`decideRetry()` 第一步就调 `pickHighestPrioritySignal()`，
 * 之后不再看其余信号。这是 F6 的全部内容——一个「既超时又崩溃」的 run 只会得到 `retry:false`。
 *
 * 三条实现取舍：
 *  1. **`run-task` 队列的 `retryLimit` 是 0**（见 definitions.ts）。pg-boss 的自动重试无法区分
 *     「任务级超时」与「容器崩溃」，所以自动重试一律关掉，重试改成**显式决策**：
 *     429 → 用 `startAfter` 重投一个新 job（退避时长按响应头）；5xx → 用 `retryLimit/retryDelay/retryBackoff`
 *     让 pg-boss 退避；其余 → `retryLimit: 0` 直接进异常兜底。
 *  2. **429 走 `startAfter` 而不是 `retryLimit`**：退避时长必须由 `retry-after` 决定，
 *     而 `retryDelay` 是队列级固定值，改不动（§7.3 备注）。
 *  3. **`attempt` 表示「已完成的尝试次数」**（第一次执行失败时是 1），这样「最多 4 次」
 *     可以直接写成 `attempt < 4`，边界不必在调用方心算。
 */
import { FAILURE_CLASS } from '../db/schema.ts';
import { pickHighestPrioritySignal } from './failure-class.ts';
import type { FailureClass, FailureSignal } from './failure-class.ts';

/** 429 最多 4 次尝试（plan §9.2「最多 4 次」= 首次 + 3 次重投） */
export const MAX_RATE_LIMIT_ATTEMPTS = 4;

/** 429 没有 `retry-after` 时的退避秒数（有响应头就按响应头） */
export const RATE_LIMIT_FALLBACK_DELAY_SECONDS = 30;

/** 5xx / 网络抖动：`retryLimit: 3`、`retryDelay: 30`、`retryBackoff: true`（§7.3） */
export const SERVER_ERROR_RETRY_LIMIT = 3;
export const SERVER_ERROR_RETRY_DELAY_SECONDS = 30;

/** `sandbox-crash`（优先级 3）：最多 1 次，第二次仍崩即判环境问题 */
export const SANDBOX_CRASH_RETRY_LIMIT = 1;

/** 重试决策的三种结果。`mode` 决定落到 pg-boss 的哪组选项上。 */
export type RetryDecision =
  | {
      readonly retry: false;
      readonly failureClass: FailureClass;
      /** 人读原因，直接进 `runs.failure_detail` 与异常兜底通知 */
      readonly reason: string;
    }
  | {
      readonly retry: true;
      readonly failureClass: FailureClass;
      /** 延迟重投：`boss.send(..., { startAfter })`，不走 `retryLimit` */
      readonly mode: 'start-after';
      readonly startAfterSeconds: number;
    }
  | {
      readonly retry: true;
      readonly failureClass: FailureClass;
      /** 交给 pg-boss 的退避重试 */
      readonly mode: 'pgboss-retry';
      readonly retryLimit: number;
      readonly retryDelaySeconds: number;
      readonly retryBackoff: boolean;
    };

export type RetryContext = {
  /** 已完成的尝试次数，默认 1（第一次执行刚失败） */
  readonly attempt?: number;
};

/** pg-boss 12 的 `SendOptions` 子集（只列重试/延迟相关字段，便于单测断言）。 */
export type RetrySendOptions = {
  readonly retryLimit: number;
  readonly retryDelay?: number;
  readonly retryBackoff?: boolean;
  readonly startAfter?: number;
};

/**
 * 把「可能是 429/401 但被上层标成 github_api」的信号归一到准确分类。
 * 只做下调不变优先级的事（429 → rate_limit、401/403 → auth），不跨越优先级。
 */
function normalizeSignal(signal: FailureSignal): FailureSignal {
  if (signal.failureClass !== FAILURE_CLASS.githubApi) {
    return signal;
  }
  if (signal.httpStatus === 429) {
    return { ...signal, failureClass: FAILURE_CLASS.rateLimit };
  }
  if (signal.httpStatus === 401 || signal.httpStatus === 403) {
    return { ...signal, failureClass: FAILURE_CLASS.auth };
  }
  return signal;
}

/** 429 的退避秒数：优先响应头，否则固定值；下限 1s，上限 15min（防止一个坏响应头把任务压到明天）。 */
export function rateLimitBackoffSeconds(retryAfterSeconds?: number | null): number {
  const raw = retryAfterSeconds ?? RATE_LIMIT_FALLBACK_DELAY_SECONDS;
  if (!Number.isFinite(raw) || raw <= 0) {
    return RATE_LIMIT_FALLBACK_DELAY_SECONDS;
  }
  return Math.min(Math.max(Math.round(raw), 1), 15 * 60);
}

function noRetry(failureClass: FailureClass, reason: string): RetryDecision {
  return { retry: false, failureClass, reason };
}

/**
 * 重试决策的**唯一入口**。
 *
 * @param signals 该 run 观测到的全部失败信号（可多个，可乱序）
 * @param context `attempt` = 已完成的尝试次数（默认 1）
 */
export function decideRetry(
  signals: readonly FailureSignal[],
  context: RetryContext = {},
): RetryDecision {
  const highest = pickHighestPrioritySignal(signals);
  if (highest === null) {
    return noRetry(FAILURE_CLASS.unknown, '没有观测到可分类的失败信号，不自动重试');
  }

  const signal = normalizeSignal(highest);
  const attempt = Number.isFinite(context.attempt ?? 1)
    ? Math.max(1, Math.trunc(context.attempt ?? 1))
    : 1;

  switch (signal.failureClass) {
    // ── 优先级 1：这轮不该继续，也不该自动重来 ────────────────────────────────
    case FAILURE_CLASS.timeout:
      return noRetry(FAILURE_CLASS.timeout, '任务级超时：只接受人工 /retry（plan §9.1）');
    case FAILURE_CLASS.interrupt:
      return noRetry(FAILURE_CLASS.interrupt, '被取消信号中断，不自动重试');
    case FAILURE_CLASS.degenerateOutput:
      return noRetry(
        FAILURE_CLASS.degenerateOutput,
        '重复输出熔断（plan §9.3）：上下文已污染，重试只会重走一遍',
      );

    // ── 优先级 2：OOM 是配置/体量问题 ─────────────────────────────────────────
    case FAILURE_CLASS.sandboxOom:
      return noRetry(
        FAILURE_CLASS.sandboxOom,
        '容器 OOM：自动重试只会再 OOM 一次，解法是内存分档（§3.6）',
      );

    // ── 优先级 3：崩溃最多重试 1 次 ───────────────────────────────────────────
    case FAILURE_CLASS.sandboxCrash:
      if (attempt <= SANDBOX_CRASH_RETRY_LIMIT) {
        return {
          retry: true,
          failureClass: FAILURE_CLASS.sandboxCrash,
          mode: 'pgboss-retry',
          retryLimit: SANDBOX_CRASH_RETRY_LIMIT,
          retryDelaySeconds: 0,
          retryBackoff: false,
        };
      }
      return noRetry(FAILURE_CLASS.sandboxCrash, '第二次仍崩溃：判为环境问题，转异常兜底');

    // ── 优先级 4：按确定性判据分流 ────────────────────────────────────────────
    case FAILURE_CLASS.rateLimit:
      if (attempt >= MAX_RATE_LIMIT_ATTEMPTS) {
        return noRetry(
          FAILURE_CLASS.rateLimit,
          `429 已重投 ${MAX_RATE_LIMIT_ATTEMPTS - 1} 次（共 ${MAX_RATE_LIMIT_ATTEMPTS} 次尝试），放弃`,
        );
      }
      return {
        retry: true,
        failureClass: FAILURE_CLASS.rateLimit,
        mode: 'start-after',
        startAfterSeconds: rateLimitBackoffSeconds(signal.retryAfterSeconds),
      };

    case FAILURE_CLASS.githubApi: {
      const status = signal.httpStatus ?? 500;
      if (status >= 500) {
        if (attempt > SERVER_ERROR_RETRY_LIMIT) {
          return noRetry(FAILURE_CLASS.githubApi, `5xx 已达 ${SERVER_ERROR_RETRY_LIMIT} 次重试上限`);
        }
        return {
          retry: true,
          failureClass: FAILURE_CLASS.githubApi,
          mode: 'pgboss-retry',
          retryLimit: SERVER_ERROR_RETRY_LIMIT,
          retryDelaySeconds: SERVER_ERROR_RETRY_DELAY_SECONDS,
          retryBackoff: true,
        };
      }
      return noRetry(FAILURE_CLASS.githubApi, `HTTP ${status}：确定性错误，重试没有意义`);
    }

    case FAILURE_CLASS.auth:
      return noRetry(FAILURE_CLASS.auth, '401/403：凭证/权限问题，转异常兜底（plan §9.2）');

    case FAILURE_CLASS.parse:
      return noRetry(FAILURE_CLASS.parse, '信封解析失败：重试只会得到同样的坏输出，需调 prompt');

    case FAILURE_CLASS.model:
      // §9.2 未单列 model：它不是限流也不是 5xx，按「确定性错误」处理，转异常兜底通知
      return noRetry(FAILURE_CLASS.model, '模型侧确定性错误，转异常兜底通知');

    case FAILURE_CLASS.unknown:
    default:
      return noRetry(FAILURE_CLASS.unknown, '未知失败分类，保守不自动重试');
  }
}

/**
 * 决策 → pg-boss 选项。
 *
 * `retry: false` 一律映射成 `retryLimit: 0`：队列级 `retryLimit` 已经是 0，
 * 这里显式再写一次，是为了让「不重试」在**每个 job 的选项上可见**——
 * 以后如果有人改了队列默认值，时间闸的语义不会跟着变（§7.3 F6 的防线）。
 */
export function toSendOptions(decision: RetryDecision): RetrySendOptions {
  if (!decision.retry) {
    return { retryLimit: 0 };
  }
  if (decision.mode === 'start-after') {
    return { retryLimit: 0, startAfter: decision.startAfterSeconds };
  }
  return {
    retryLimit: decision.retryLimit,
    retryDelay: decision.retryDelaySeconds,
    retryBackoff: decision.retryBackoff,
  };
}
