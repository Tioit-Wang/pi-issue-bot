import { describe, expect, it } from 'vitest';
import { DEADLINE_EXCEEDED, INTERRUPTED, runWithDeadline } from '../src/deadline.ts';
import { AppError } from '../src/errors.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 期待 promise 被拒绝，并把它抛出的值当 AppError 返回（避免 `.catch` 把成功值也算进来）。 */
async function rejectionOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected promise to reject');
}

describe('runWithDeadline', () => {
  it('未超时时正常返回值', async () => {
    const out = await runWithDeadline({ ms: 100 }, async () => 'ok');
    expect(out).toBe('ok');
  });

  it('超时抛 timeout 分类，并 abort 传给 fn 的 signal', async () => {
    let seen: AbortSignal | undefined;
    const promise = runWithDeadline({ ms: 10, label: 'job:1' }, async (signal) => {
      seen = signal;
      await sleep(200);
      return 'late';
    });

    const error = await rejectionOf(promise);
    expect(error).toBeInstanceOf(AppError);
    expect(error.failureClass).toBe('timeout');
    expect(error.code).toBe(DEADLINE_EXCEEDED);
    expect(error.message).toContain('job:1');
    expect(seen?.aborted).toBe(true);
  });

  it('允许自定义超时 code（命令级超时与任务级区分）', async () => {
    const error = await rejectionOf(runWithDeadline({ ms: 5, timeoutCode: 'COMMAND_TIMEOUT' }, () => sleep(100)));
    expect(error.code).toBe('COMMAND_TIMEOUT');
  });

  it('父 signal 取消归类为 interrupt，而不是 timeout', async () => {
    const parent = new AbortController();
    const promise = runWithDeadline({ ms: 0, parent: parent.signal }, () => sleep(200));
    parent.abort(new Error('SIGTERM'));

    const error = await rejectionOf(promise);
    expect(error.failureClass).toBe('interrupt');
    expect(error.code).toBe(INTERRUPTED);
  });

  it('父 signal 已取消时立刻失败，不执行 fn', async () => {
    const parent = new AbortController();
    parent.abort();
    let called = false;
    const error = await rejectionOf(
      runWithDeadline({ ms: 0, parent: parent.signal }, async () => {
        called = true;
        return 1;
      }),
    );
    expect(error).toBeInstanceOf(AppError);
    expect(called).toBe(false);
  });

  it('fn 自己抛错时原样透传（不包装成超时）', async () => {
    const boom = new AppError('sandbox died', { code: 'SANDBOX', failureClass: 'sandbox-crash' });
    const error = await rejectionOf(
      runWithDeadline({ ms: 100 }, async () => {
        throw boom;
      }),
    );
    expect(error).toBe(boom);
  });

  it('ms 为 0 时不设本级上限（只受父 signal 约束）', async () => {
    const out = await runWithDeadline({ ms: 0 }, async () => {
      await sleep(30);
      return 'done';
    });
    expect(out).toBe('done');
  });

  it('超时后迟到的 reject 不会变成 unhandledRejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await rejectionOf(
        runWithDeadline({ ms: 5 }, async () => {
          await sleep(50);
          throw new Error('late failure');
        }),
      );
      await sleep(80);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toHaveLength(0);
  });
});
