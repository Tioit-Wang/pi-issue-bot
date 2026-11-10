/**
 * 排队闸门的单测（tech-plan §4.7 第三行，F5；多仓库：阈值来自仓库 settings）。
 *
 * 边界是产品承诺：`now() - queued_at > queue_wait_minutes` 才取消，正好等于阈值不取消。
 * 另外三条同样重要：只有 `status='queued'` 才算（`running` 归任务级时间闸），
 * `queued_at` 为 NULL 时不取消（数据异常不该导致误取消），
 * 以及**阈值按仓库取**（一个仓库等 30 分钟不影响另一个仓库的 3 分钟）。
 */
import { describe, expect, it } from 'vitest';
import {
  QUEUE_GATE_BATCH_LIMIT,
  QUEUE_GATE_CANCEL_SQL,
  QUEUE_GATE_REACTION,
  QUEUE_GATE_SQL,
  QUEUE_WAIT_LIMIT_MINUTES,
  QUEUE_WAIT_LIMIT_SECONDS,
  isQueueTimedOut,
  queueGateActions,
  queueWaitMinutesOf,
  queueWaitSeconds,
  resolveQueueWaitMinutes,
  smallestQueueWaitSeconds,
} from '../src/queue/queue-gate.ts';
import type { QueueGateCandidate } from '../src/queue/queue-gate.ts';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60 * 1000);
}

function candidate(overrides: Partial<QueueGateCandidate> = {}): QueueGateCandidate {
  return {
    id: 'task-1',
    repo: 'acme/widget',
    targetKind: 'issue',
    targetNumber: 123,
    command: 'auto:triage',
    queuedAt: minutesAgo(11),
    status: 'queued',
    ...overrides,
  };
}

describe('isQueueTimedOut：默认 10 分钟边界', () => {
  it('10 分钟整不算超（> 而不是 >=）', () => {
    expect(isQueueTimedOut({ status: 'queued', queuedAt: minutesAgo(10) }, NOW)).toBe(false);
  });

  it('10 分 1 秒算超', () => {
    const queuedAt = new Date(NOW.getTime() - (QUEUE_WAIT_LIMIT_SECONDS * 1000 + 1000));
    expect(isQueueTimedOut({ status: 'queued', queuedAt }, NOW)).toBe(true);
  });

  it('非 queued 状态一律不算（running 归任务级时间闸管）', () => {
    for (const status of ['running', 'succeeded', 'failed', 'timed-out', 'cancelled', 'cancelled_queue']) {
      expect(isQueueTimedOut({ status, queuedAt: minutesAgo(60) }, NOW)).toBe(false);
    }
  });

  it('queued_at 为 NULL 时保守放过', () => {
    expect(isQueueTimedOut({ status: 'queued', queuedAt: null }, NOW)).toBe(false);
  });

  it('阈值可覆盖（自定义数字）', () => {
    expect(isQueueTimedOut({ status: 'queued', queuedAt: minutesAgo(6) }, NOW, 5)).toBe(true);
    expect(isQueueTimedOut({ status: 'queued', queuedAt: minutesAgo(6) }, NOW, 30)).toBe(false);
  });
});

describe('仓库级阈值（settings.limits.queue_wait_minutes）', () => {
  const limitOf = (repo: string): number => (repo === 'slow/repo' ? 30 : 3);

  it('同一等待时长，不同仓库得到不同结论', () => {
    const task = { status: 'queued', queuedAt: minutesAgo(5) };
    expect(isQueueTimedOut({ ...task, repo: 'fast/repo' }, NOW, limitOf)).toBe(true);
    expect(isQueueTimedOut({ ...task, repo: 'slow/repo' }, NOW, limitOf)).toBe(false);
  });

  it('queueGateActions 把函数阈值传下去（而不是先算成一个数字）', () => {
    const actions = queueGateActions(
      [
        candidate({ id: 'fast', repo: 'fast/repo', queuedAt: minutesAgo(5) }),
        candidate({ id: 'slow', repo: 'slow/repo', queuedAt: minutesAgo(5) }),
        candidate({ id: 'slow-stale', repo: 'slow/repo', queuedAt: minutesAgo(31) }),
      ],
      NOW,
      limitOf,
    );
    expect(actions.map((action) => action.taskId)).toEqual(['fast', 'slow-stale']);
  });

  it('resolveQueueWaitMinutes：数字与函数两种形态都对', () => {
    expect(resolveQueueWaitMinutes(7, 'any/repo')).toBe(7);
    expect(resolveQueueWaitMinutes(limitOf, 'slow/repo')).toBe(30);
  });

  it('queueWaitMinutesOf：从 jsonb 里读，坏数据回落默认 10 分钟', () => {
    expect(queueWaitMinutesOf({ limits: { queue_wait_minutes: 3 } })).toBe(3);
    expect(queueWaitMinutesOf({ limits: {} })).toBe(QUEUE_WAIT_LIMIT_MINUTES);
    expect(queueWaitMinutesOf(null)).toBe(QUEUE_WAIT_LIMIT_MINUTES);
    expect(queueWaitMinutesOf({ limits: { queue_wait_minutes: 0 } })).toBe(QUEUE_WAIT_LIMIT_MINUTES);
    expect(queueWaitMinutesOf({ limits: { queue_wait_minutes: '3' } })).toBe(QUEUE_WAIT_LIMIT_MINUTES);
  });

  it('smallestQueueWaitSeconds：SQL 粗筛用最小阈值，没有仓库时用默认值', () => {
    expect(smallestQueueWaitSeconds([30, 3, 10])).toBe(180);
    expect(smallestQueueWaitSeconds([])).toBe(QUEUE_WAIT_LIMIT_SECONDS);
  });
});

describe('queueWaitSeconds', () => {
  it('按整数秒计；时钟回拨（负值）归零', () => {
    expect(queueWaitSeconds(minutesAgo(3), NOW)).toBe(180);
    expect(queueWaitSeconds(new Date(NOW.getTime() + 5_000), NOW)).toBe(0);
    expect(queueWaitSeconds(null, NOW)).toBe(0);
  });
});

describe('queueGateActions：取消动作的形状', () => {
  it('只挑出超时的任务，并给出「改状态 + 打 confused」的动作（不含评论）', () => {
    const actions = queueGateActions(
      [
        candidate({ id: 'stale', queuedAt: minutesAgo(42) }),
        candidate({ id: 'fresh', queuedAt: minutesAgo(2) }),
        candidate({ id: 'running', queuedAt: minutesAgo(42), status: 'running' }),
      ],
      NOW,
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      taskId: 'stale',
      repo: 'acme/widget',
      targetKind: 'issue',
      targetNumber: 123,
      command: 'auto:triage',
      waitedSeconds: 42 * 60,
      nextStatus: 'cancelled_queue',
      reaction: 'confused',
    });
    // 零评论（§0.4）：动作里不该再有任何文案字段
    expect(actions[0]).not.toHaveProperty('comment');
  });

  it('候选为空时返回空数组（不产生副作用）', () => {
    expect(queueGateActions([], NOW)).toEqual([]);
  });

  it('reaction 固定 confused（失败/超时/取消的统一角标）', () => {
    expect(QUEUE_GATE_REACTION).toBe('confused');
  });
});

describe('SQL 片段', () => {
  it('扫表语句只认 queued + queued_at 超过阈值，并走 (status, queued_at) 索引', () => {
    expect(QUEUE_GATE_SQL).toContain('"status" = $1');
    expect(QUEUE_GATE_SQL).toContain('"queued_at" IS NOT NULL');
    expect(QUEUE_GATE_SQL).toContain('now() - "queued_at" > make_interval(secs => $2)');
    expect(QUEUE_GATE_SQL).toContain('ORDER BY "queued_at"');
    expect(QUEUE_GATE_SQL).toContain('LIMIT $3');
    // 阈值是参数，不是写死的 interval：单测与调用方共用同一个常量
    expect(QUEUE_WAIT_LIMIT_SECONDS).toBe(QUEUE_WAIT_LIMIT_MINUTES * 60);
    expect(QUEUE_GATE_BATCH_LIMIT).toBeGreaterThan(0);
  });

  it('取消语句带 status 守卫（避免把已经开跑的任务改成 cancelled_queue）', () => {
    expect(QUEUE_GATE_CANCEL_SQL).toContain('SET "status" = $2');
    expect(QUEUE_GATE_CANCEL_SQL).toContain('WHERE "id" = $1 AND "status" = $3');
    expect(QUEUE_GATE_CANCEL_SQL).toContain('"ended_at" = now()');
  });
});
