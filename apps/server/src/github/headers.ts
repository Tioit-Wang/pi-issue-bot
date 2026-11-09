/**
 * 响应头工具与限流头归一化（tech-plan §7.3 第一行、§5.3）。
 *
 * 只做纯函数：不读全局时间、不发请求。`now` 由调用方传入，测试才能对 `x-ratelimit-reset`
 * 这类「绝对时间戳」断言。限流结论统一收敛成 `RateLimitState`：
 *   - `{ kind: 'rate_limit', retryAfterMs }` → 交给 `boss.send(..., { startAfter })` 重投；
 *   - `{ kind: 'ok' }` → 继续跑。
 * 这样「429 走 startAfter、不走 retryLimit」这条规则（tech-plan §7.3）在上层只有一处判断。
 */
import type { HeaderBag, HeaderValue, RateLimitState } from './types.ts';

/** 响应头缺失 `retry-after` 与 `x-ratelimit-reset` 时的兜底等待时长。 */
export const FALLBACK_RETRY_AFTER_MS = 60_000;

/**
 * 按名字读响应头（大小写不敏感；多值头用逗号拼接）。
 *
 * Octokit 已经把 Node 的 headers 摊平成对象，但键名大小写不保证，所以这里统一小写比对。
 */
export function readHeader(headers: HeaderBag | undefined, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) {
      return normalizeHeaderValue(headers[key]);
    }
  }
  return undefined;
}

function normalizeHeaderValue(value: HeaderValue): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.join(',');
  }
  return String(value);
}

/**
 * 解析 `retry-after`：既可以是秒数（GitHub 429 的写法），也可以是 HTTP 日期。
 * 返回毫秒；无法解析返回 null。
 */
export function parseRetryAfterMs(raw: string | undefined, now: number): number | null {
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }

  // 纯数字（允许小数秒）
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Math.round(Number(trimmed) * 1000));
  }

  // HTTP 日期（RFC 7231 IMF-fixdate 为主，其它日期串交给 Date 解析）
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  return Math.max(0, timestamp - now);
}

/**
 * 把限流头归一化成 `RateLimitState`。
 *
 * 判定顺序（与 tech-plan §7.3 一致）：
 *  1. 有 `retry-after` → 以它为准（最精确，GitHub 在 429 上给的就是它）；
 *  2. `x-ratelimit-remaining <= 0` 且有 `x-ratelimit-reset` → 用 reset 与 now 的差；
 *  3. `remaining <= 0` 但缺 reset → 兜底 `FALLBACK_RETRY_AFTER_MS`。
 *
 * 注意：`remaining = 0` 单独出现时**也算限流**——GitHub 会先把最后一次额度用掉再拒绝，
 * 只等状态码 403/429 再判断会晚一步。
 */
export function parseRateLimitHeaders(
  headers: HeaderBag | undefined,
  now: number = Date.now(),
): RateLimitState {
  const remaining = parseIntegerHeader(readHeader(headers, 'x-ratelimit-remaining'));
  const resetSeconds = parseIntegerHeader(readHeader(headers, 'x-ratelimit-reset'));
  const resetAtMs = resetSeconds === null ? null : resetSeconds * 1000;

  const retryAfterMs = parseRetryAfterMs(readHeader(headers, 'retry-after'), now);
  if (retryAfterMs !== null) {
    return {
      kind: 'rate_limit',
      retryAfterMs,
      remaining,
      resetAtMs,
      source: 'retry-after',
    };
  }

  if (remaining !== null && remaining <= 0) {
    if (resetAtMs !== null) {
      return {
        kind: 'rate_limit',
        retryAfterMs: Math.max(0, resetAtMs - now),
        remaining,
        resetAtMs,
        source: 'x-ratelimit-reset',
      };
    }
    return {
      kind: 'rate_limit',
      retryAfterMs: FALLBACK_RETRY_AFTER_MS,
      remaining,
      resetAtMs,
      source: 'fallback',
    };
  }

  return { kind: 'ok', remaining, resetAtMs };
}

function parseIntegerHeader(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return null;
  }
  return Number.parseInt(trimmed, 10);
}

/**
 * 从 route 字符串里取 HTTP 方法（`'POST /repos/...'`）→ `'POST'`。
 * 没有前缀时退回 `params.method`，再退回 GET。
 */
export function detectMethod(route: string, params?: Readonly<Record<string, unknown>>): string {
  const matched = /^(GET|POST|PATCH|PUT|DELETE|HEAD)\s+\//.exec(route.trim());
  if (matched?.[1] !== undefined) {
    return matched[1];
  }
  const explicit = params?.['method'];
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return explicit.trim().toUpperCase();
  }
  return 'GET';
}
