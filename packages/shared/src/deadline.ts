/**
 * 层级取消：`runWithDeadline`（tech-plan §4.7）。
 *
 * 为什么不用 `p-timeout`：我们要的是「父子层级的取消 + 分类化错误」，超时只是其中一种触发；
 * `p-timeout` 只给一个 Promise 加计时器，父 signal 传不进去，也拿不到 `failureClass`。
 *
 * 语义（对应 plan §9.1 的三层时间闸）：
 * - `ms` 触发 → 抛 `AppError{failureClass:'timeout'}`，`code = DEADLINE_EXCEEDED`；
 * - 父 signal 触发（SIGTERM / 任务级中止）→ 抛 `AppError{failureClass:'interrupt'}`，`code = INTERRUPTED`；
 * - `fn` 自己抛错 → 原样透传（调用方按 §7.3 分类）；
 * - 无论哪条路径，`fn` 拿到的 signal 都会在退出前 abort，事件循环里不留计时器。
 */

import { AppError, isAppError } from './errors.ts';

export const DEADLINE_EXCEEDED = 'DEADLINE_EXCEEDED';
export const INTERRUPTED = 'INTERRUPTED';

export type RunWithDeadlineOptions = {
  /** 上限毫秒。`<=0` 或非有限值表示不设本级上限（只继承父 signal）。 */
  ms: number;
  /** 上层取消信号（任务级 timeout / 优雅停机）。 */
  parent?: AbortSignal | undefined;
  /** 进错误消息与日志的标签，例如 `job:42`、`command:pnpm test`。 */
  label?: string;
  /** 超时的 code，默认 `DEADLINE_EXCEEDED`（命令级可传 `COMMAND_TIMEOUT` 区分）。 */
  timeoutCode?: string;
};

function timeoutError(options: RunWithDeadlineOptions, ms: number): AppError {
  return new AppError(`deadline exceeded after ${ms}ms${options.label === undefined ? '' : ` (${options.label})`}`, {
    code: options.timeoutCode ?? DEADLINE_EXCEEDED,
    failureClass: 'timeout',
    retriable: false,
  });
}

function interruptError(reason: unknown): AppError {
  if (isAppError(reason)) {
    return reason;
  }
  const message = reason instanceof Error ? reason.message : String(reason ?? 'aborted');
  return new AppError(`run interrupted: ${message}`, {
    code: INTERRUPTED,
    failureClass: 'interrupt',
    retriable: false,
    ...(reason === undefined ? {} : { cause: reason }),
  });
}

/**
 * 在「父取消 + 本级 deadline」下执行 `fn`。
 * `fn` 必须把自己拿到的 `signal` 传给下层（fetch / docker exec / ws 请求），否则取消失效。
 */
export async function runWithDeadline<T>(
  options: RunWithDeadlineOptions,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const { parent, ms } = options;

  if (parent?.aborted === true) {
    throw interruptError(parent.reason);
  }

  const controller = new AbortController();
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  let onParentAbort: (() => void) | undefined;

  const failure = new Promise<never>((_resolve, reject) => {
    const fail = (error: AppError): void => {
      if (settled) {
        return;
      }
      settled = true;
      controller.abort(error);
      reject(error);
    };

    if (Number.isFinite(ms) && ms > 0) {
      timer = setTimeout(() => {
        fail(timeoutError(options, ms));
      }, ms);
      // 别让计时器把进程钉住（CLI/测试里尤其重要）。
      timer.unref?.();
    }

    if (parent !== undefined) {
      onParentAbort = (): void => {
        fail(interruptError(parent.reason));
      };
      parent.addEventListener('abort', onParentAbort, { once: true });
    }
  });

  const work = fn(controller.signal);

  try {
    return await Promise.race([work, failure]);
  } finally {
    settled = true;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (parent !== undefined && onParentAbort !== undefined) {
      parent.removeEventListener('abort', onParentAbort);
    }
    // 已经取消的 work 迟到 reject 不能变成 unhandledRejection。
    void work.catch(() => {});
  }
}
