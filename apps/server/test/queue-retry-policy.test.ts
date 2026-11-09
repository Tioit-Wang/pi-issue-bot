/**
 * 重试矩阵的单测（tech-plan §7.3 第二张表）。
 *
 * 三条必须钉死的行为：
 *  1. **决策只读最高优先级的类**：超时 + 崩溃同时出现 → 不重试（哪怕崩溃本该重试 1 次）。
 *  2. **429 走 `startAfter`**（不是 `retryLimit`），`retry-after` 优先，最多 4 次尝试。
 *  3. **5xx 用 `retryLimit: 3` + `retryDelay: 30` + `retryBackoff`**，其余 4xx / 解析失败 / 命令级超时 / 任务级超时一律不重试。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_RATE_LIMIT_ATTEMPTS,
  SANDBOX_CRASH_RETRY_LIMIT,
  SERVER_ERROR_RETRY_DELAY_SECONDS,
  SERVER_ERROR_RETRY_LIMIT,
  decideRetry,
  rateLimitBackoffSeconds,
  toSendOptions,
} from '../src/queue/retry-policy.ts';
import type { RetryDecision } from '../src/queue/retry-policy.ts';
import { signalFromHttp } from '../src/queue/failure-class.ts';

describe('429 限流：startAfter 重投，最多 4 次尝试', () => {
  it('优先用 retry-after 作为 startAfter', () => {
    expect(decideRetry([signalFromHttp(429, 12)])).toEqual({
      retry: true,
      failureClass: 'rate_limit',
      mode: 'start-after',
      startAfterSeconds: 12,
    });
  });

  it('没有 retry-after 时退回固定退避 30s', () => {
    expect(decideRetry([signalFromHttp(429, null)])).toEqual({
      retry: true,
      failureClass: 'rate_limit',
      mode: 'start-after',
      startAfterSeconds: 30,
    });
  });

  it('第 1/2/3 次失败都重投，第 4 次失败不再重投（共 4 次尝试）', () => {
    const attemptAllowed = [1, 2, 3].map((attempt) => decideRetry([signalFromHttp(429, 5)], { attempt }).retry);
    expect(attemptAllowed).toEqual([true, true, true]);
    expect(decideRetry([signalFromHttp(429, 5)], { attempt: 4 }).retry).toBe(false);
    expect(decideRetry([signalFromHttp(429, 5)], { attempt: 9 }).retry).toBe(false);
    expect(MAX_RATE_LIMIT_ATTEMPTS).toBe(4);
  });

  it('429 直接用 retryLimit 是错的：映射出的选项必须是 startAfter + retryLimit 0', () => {
    const options = toSendOptions(decideRetry([signalFromHttp(429, 45)]));
    expect(options).toEqual({ retryLimit: 0, startAfter: 45 });
  });
});

describe('5xx / 网络抖动：retryLimit 3 + retryDelay 30 + retryBackoff', () => {
  it('503 → 交给 pg-boss 指数退避', () => {
    expect(decideRetry([signalFromHttp(503)])).toEqual({
      retry: true,
      failureClass: 'github_api',
      mode: 'pgboss-retry',
      retryLimit: SERVER_ERROR_RETRY_LIMIT,
      retryDelaySeconds: SERVER_ERROR_RETRY_DELAY_SECONDS,
      retryBackoff: true,
    });
    expect(toSendOptions(decideRetry([signalFromHttp(503)]))).toEqual({
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
    });
  });

  it('超过 3 次后不再重试', () => {
    expect(decideRetry([signalFromHttp(500)], { attempt: 3 }).retry).toBe(true);
    expect(decideRetry([signalFromHttp(500)], { attempt: 4 }).retry).toBe(false);
  });

  it('没有 HTTP 状态的 github_api 信号按 5xx 处理（多半是网络抖动）', () => {
    expect(decideRetry([{ failureClass: 'github_api' }]).retry).toBe(true);
  });
});

describe('确定性错误：一律不重试', () => {
  it('401/403 → auth，不重试', () => {
    expect(decideRetry([signalFromHttp(401)])).toMatchObject({ retry: false, failureClass: 'auth' });
    expect(decideRetry([signalFromHttp(403)])).toMatchObject({ retry: false, failureClass: 'auth' });
  });

  it('其它 4xx（如 422）不重试', () => {
    expect(decideRetry([signalFromHttp(422)])).toMatchObject({ retry: false, failureClass: 'github_api' });
  });

  it('解析失败 / 任务级超时 / 命令级超时都不重试', () => {
    expect(decideRetry([{ failureClass: 'parse' }])).toMatchObject({ retry: false, failureClass: 'parse' });
    expect(decideRetry([{ failureClass: 'timeout', detail: '任务级 deadline' }])).toMatchObject({
      retry: false,
      failureClass: 'timeout',
    });
    expect(decideRetry([{ failureClass: 'interrupt' }])).toMatchObject({ retry: false, failureClass: 'interrupt' });
    expect(decideRetry([{ failureClass: 'degenerate-output' }])).toMatchObject({
      retry: false,
      failureClass: 'degenerate-output',
    });
  });

  it('OOM 不重试（重试只会再 OOM 一次）', () => {
    expect(decideRetry([{ failureClass: 'sandbox-oom' }])).toMatchObject({ retry: false });
  });

  it('未知分类与空信号都保守不重试', () => {
    expect(decideRetry([])).toMatchObject({ retry: false, failureClass: 'unknown' });
    expect(decideRetry([{ failureClass: 'unknown' }])).toMatchObject({ retry: false });
  });

  it('不重试时映射出的选项是 retryLimit 0（F6 的第二道防线）', () => {
    expect(toSendOptions(decideRetry([{ failureClass: 'timeout' }]))).toEqual({ retryLimit: 0 });
  });
});

describe('sandbox-crash：最多重试 1 次', () => {
  it('第一次崩溃重试 1 次，第二次仍崩就不再来', () => {
    expect(decideRetry([{ failureClass: 'sandbox-crash' }])).toEqual({
      retry: true,
      failureClass: 'sandbox-crash',
      mode: 'pgboss-retry',
      retryLimit: SANDBOX_CRASH_RETRY_LIMIT,
      retryDelaySeconds: 0,
      retryBackoff: false,
    });
    expect(decideRetry([{ failureClass: 'sandbox-crash' }], { attempt: 1 }).retry).toBe(true);
    expect(decideRetry([{ failureClass: 'sandbox-crash' }], { attempt: 2 })).toMatchObject({ retry: false });
    expect(SANDBOX_CRASH_RETRY_LIMIT).toBe(1);
  });
});

describe('F6：决策只读最高优先级的类', () => {
  it('超时 + 崩溃同时出现 → 不重试（崩溃那条的 retryLimit 1 不许生效）', () => {
    const decision = decideRetry([
      { failureClass: 'sandbox-crash', detail: 'exit 137' },
      { failureClass: 'timeout', detail: 'deadline 触发后 kill 容器' },
    ]);
    expect(decision).toMatchObject({ retry: false, failureClass: 'timeout' });
    expect(toSendOptions(decision)).toEqual({ retryLimit: 0 });
  });

  it('OOM + 崩溃 → 不重试（OOM 优先级更高）', () => {
    expect(
      decideRetry([{ failureClass: 'sandbox-crash' }, { failureClass: 'sandbox-oom' }]),
    ).toMatchObject({ retry: false, failureClass: 'sandbox-oom' });
  });

  it('429 + 崩溃 → 取崩溃（优先级 3 高于 4），仍按崩溃重试 1 次', () => {
    const decision = decideRetry([{ failureClass: 'sandbox-crash' }, signalFromHttp(429, 7)]);
    expect(decision).toMatchObject({ retry: true, failureClass: 'sandbox-crash', mode: 'pgboss-retry' });
  });

  it('被标成 github_api 但实际 429 的信号会归一到 rate_limit', () => {
    const decision = decideRetry([{ failureClass: 'github_api', httpStatus: 429, retryAfterSeconds: 9 }]);
    expect(decision).toEqual({
      retry: true,
      failureClass: 'rate_limit',
      mode: 'start-after',
      startAfterSeconds: 9,
    });
  });
});

describe('rateLimitBackoffSeconds', () => {
  it('坏响应头有下限与上限，不会把任务压到明天', () => {
    expect(rateLimitBackoffSeconds(0)).toBe(30);
    expect(rateLimitBackoffSeconds(-5)).toBe(30);
    expect(rateLimitBackoffSeconds(Number.NaN)).toBe(30);
    // 小于 1 秒的响应头按 1 秒算（下限 1s），不是退回 30s
    expect(rateLimitBackoffSeconds(0.4)).toBe(1);
    expect(rateLimitBackoffSeconds(1)).toBe(1);
    expect(rateLimitBackoffSeconds(99_999)).toBe(900);
  });
});

describe('toSendOptions 的结构完整性', () => {
  it('三种决策映射出的字段集合互不混淆', () => {
    const none: RetryDecision = { retry: false, failureClass: 'parse', reason: 'x' };
    expect(toSendOptions(none)).toEqual({ retryLimit: 0 });

    const startAfter: RetryDecision = {
      retry: true,
      failureClass: 'rate_limit',
      mode: 'start-after',
      startAfterSeconds: 20,
    };
    expect(toSendOptions(startAfter)).toEqual({ retryLimit: 0, startAfter: 20 });

    const pgboss: RetryDecision = {
      retry: true,
      failureClass: 'github_api',
      mode: 'pgboss-retry',
      retryLimit: 3,
      retryDelaySeconds: 30,
      retryBackoff: true,
    };
    expect(toSendOptions(pgboss)).toEqual({ retryLimit: 3, retryDelay: 30, retryBackoff: true });
  });
});
