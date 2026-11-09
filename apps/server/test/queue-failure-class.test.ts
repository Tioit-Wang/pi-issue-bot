/**
 * `failure_class` 优先级表的单测（tech-plan §7.3 第一张表，F6）。
 *
 * 核心断言只有一句：**超时与崩溃同时出现时必须取超时**。取错了，超时任务就会被
 * `sandbox-crash` 的 `retryLimit: 1` 自动重跑一次，plan §9.1 当场失效。
 */
import { describe, expect, it } from 'vitest';
import {
  FAILURE_CLASS_PRIORITY,
  classifyHttpStatus,
  pickFailureClass,
  pickHighestPrioritySignal,
  priorityOf,
  signalFromHttp,
} from '../src/queue/failure-class.ts';
import type { FailureSignal } from '../src/queue/failure-class.ts';

describe('FAILURE_CLASS_PRIORITY', () => {
  it('与 §7.3 的四档一一对应', () => {
    expect(FAILURE_CLASS_PRIORITY.timeout).toBe(1);
    expect(FAILURE_CLASS_PRIORITY.interrupt).toBe(1);
    expect(FAILURE_CLASS_PRIORITY['degenerate-output']).toBe(1);
    expect(FAILURE_CLASS_PRIORITY['sandbox-oom']).toBe(2);
    expect(FAILURE_CLASS_PRIORITY['sandbox-crash']).toBe(3);
    expect(FAILURE_CLASS_PRIORITY.auth).toBe(4);
    expect(FAILURE_CLASS_PRIORITY.rate_limit).toBe(4);
    expect(FAILURE_CLASS_PRIORITY.parse).toBe(4);
    expect(FAILURE_CLASS_PRIORITY.github_api).toBe(4);
    expect(priorityOf('timeout')).toBe(1);
    expect(priorityOf('sandbox-crash')).toBe(3);
  });
});

describe('pickHighestPrioritySignal', () => {
  const timeout: FailureSignal = { failureClass: 'timeout', detail: 'deadline 触发' };
  const crash: FailureSignal = { failureClass: 'sandbox-crash', detail: 'exit 137' };

  it('超时 + 崩溃同时出现 → 取 timeout（不是最后观测到的那个）', () => {
    expect(pickHighestPrioritySignal([crash, timeout])?.failureClass).toBe('timeout');
    expect(pickHighestPrioritySignal([timeout, crash])?.failureClass).toBe('timeout');
    expect(pickFailureClass([crash, timeout])).toBe('timeout');
  });

  it('OOM 高于崩溃（OOM 不重试，崩溃可重试一次）', () => {
    expect(pickFailureClass([crash, { failureClass: 'sandbox-oom' }])).toBe('sandbox-oom');
  });

  it('同优先级按声明顺序取，结果确定', () => {
    expect(pickFailureClass([{ failureClass: 'sandbox-oom' }, { failureClass: 'sandbox-crash' }])).toBe(
      'sandbox-oom',
    );
    expect(pickFailureClass([{ failureClass: 'auth' }, { failureClass: 'rate_limit' }])).toBe('auth');
  });

  it('空信号返回 null（区别于 unknown）', () => {
    expect(pickHighestPrioritySignal([])).toBeNull();
    expect(pickFailureClass([])).toBeNull();
  });

  it('保留最高优先级信号的附加信息（retry-after 不能丢）', () => {
    const picked = pickHighestPrioritySignal([signalFromHttp(429, 42)]);
    expect(picked).toMatchObject({ failureClass: 'rate_limit', httpStatus: 429, retryAfterSeconds: 42 });
  });
});

describe('classifyHttpStatus', () => {
  it('429 → rate_limit，401/403 → auth，其余（含 5xx）→ github_api', () => {
    expect(classifyHttpStatus(429)).toBe('rate_limit');
    expect(classifyHttpStatus(401)).toBe('auth');
    expect(classifyHttpStatus(403)).toBe('auth');
    expect(classifyHttpStatus(500)).toBe('github_api');
    expect(classifyHttpStatus(422)).toBe('github_api');
  });
});
