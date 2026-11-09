/**
 * Result 类型（不抛异常的返回通道）。
 *
 * 用途：写执行器、查询层、审批策略这些「失败是常态」的分支里，把失败当值传，而不是靠 catch。
 * 真正的意外（编程错误）仍然抛。
 */
import { type AppError, toAppError } from './errors.ts';

export type Result<T, E = AppError> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is { readonly ok: true; readonly value: T } {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is { readonly ok: false; readonly error: E } {
  return !result.ok;
}

/** 取成功值，失败则抛（把 Result 转回异常语义的边界点）。 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) {
    return result.value;
  }
  throw result.error instanceof Error ? result.error : new Error(String(result.error));
}

/** 失败时给默认值。 */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/** 映射成功值；失败原样传递。 */
export function mapResult<T, U, E>(result: Result<T, E>, map: (value: T) => U): Result<U, E> {
  return result.ok ? ok(map(result.value)) : result;
}

/** 把「可能抛出」的 async 函数转成 Result，未知错误归一到 AppError。 */
export async function fromPromise<T>(fn: () => Promise<T>): Promise<Result<T, AppError>> {
  try {
    return ok(await fn());
  } catch (error) {
    return err(toAppError(error));
  }
}
