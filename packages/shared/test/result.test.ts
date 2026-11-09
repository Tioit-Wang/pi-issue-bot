import { describe, expect, it } from 'vitest';
import { AppError, FAILURE_CLASSES, isAppError, toAppError } from '../src/errors.ts';
import { err, fromPromise, isErr, isOk, mapResult, ok, unwrap, unwrapOr } from '../src/result.ts';

describe('AppError', () => {
  it('必须带分类，默认不重试', () => {
    const error = new AppError('boom', { code: 'X', failureClass: 'model' });
    expect(error.failureClass).toBe('model');
    expect(error.retriable).toBe(false);
    expect(isAppError(error)).toBe(true);
    expect(isAppError(new Error('plain'))).toBe(false);
  });

  it('toAppError 透传已分类错误，未知错误归到 unknown', () => {
    const known = new AppError('k', { code: 'K', failureClass: 'parse' });
    expect(toAppError(known)).toBe(known);

    const wrapped = toAppError('string failure');
    expect(wrapped.failureClass).toBe('unknown');
    expect(wrapped.message).toBe('string failure');
  });

  it('分类表与 tech-plan §7.3 的取值一致（顺序无关，集合相等）', () => {
    expect([...FAILURE_CLASSES].sort()).toEqual(
      [
        'auth',
        'degenerate-output',
        'github-api',
        'interrupt',
        'model',
        'parse',
        'rate-limit',
        'sandbox',
        'sandbox-crash',
        'sandbox-oom',
        'timeout',
        'unknown',
      ].sort(),
    );
  });
});

describe('Result', () => {
  it('ok/err 与类型守卫', () => {
    const good = ok(1);
    const bad = err(new AppError('x', { code: 'X', failureClass: 'unknown' }));
    expect(isOk(good)).toBe(true);
    expect(isErr(bad)).toBe(true);
    expect(unwrap(good)).toBe(1);
    expect(unwrapOr(bad, 42)).toBe(42);
    expect(() => unwrap(bad)).toThrow();
  });

  it('mapResult 只映射成功值', () => {
    expect(unwrap(mapResult(ok(2), (value) => value * 3))).toBe(6);
    const bad = err('nope');
    expect(mapResult(bad, (value: number) => value)).toBe(bad);
  });

  it('fromPromise 把抛出转成 err 并归一化分类', async () => {
    const success = await fromPromise(async () => 'v');
    expect(isOk(success)).toBe(true);

    const failure = await fromPromise(async () => {
      throw new Error('bad');
    });
    expect(isErr(failure)).toBe(true);
    if (isErr(failure)) {
      expect(failure.error.failureClass).toBe('unknown');
    }
  });
});
