/**
 * 排队闸门的单测（tech-plan §4.7 第三行，F5）。
 *
 * 边界是产品承诺：`now() - queued_at > 10min` 才取消，正好 10 分钟不取消。
 * 另外两条同样重要：只有 `status='queued'` 才算（`running` 归任务级时间闸），
 * `queued_at` 为 NULL 时不取消（数据异常不该导致误取消）。
 */
import { describe, expect, it } from 'vitest';
import {
  QUEUE_GATE_BATCH_LIMIT,
  QUEUE_GATE_CANCEL_SQL,
  QUEUE_GATE_COMMENT,
  QUEUE_GATE_SQL,
  QUEUE_WAIT_LIMIT_MINUTES,
  QUEUE_WAIT_LIMIT_SECONDS,
  isQueueTimedOut,
  queueGateActions,
  queueWaitSeconds,
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

describe('isQueueTimedOut：10 分钟边界', () => {
  it('10 分钟整不算超（> 而不是 >=）', () => {
    expect(isQueueTimedOut({ status: 'queued', queuedAt: minutesAgo(10) }, NOW)).toBe(false);
  });

  it('10 分 1 秒算超', () => {
    const queuedAt = new Date(NOW.getTime() - (QUEUE_WAIT_LIMIT_SECONDS * 1000 + 1000));
    expect(isQueueTimedOut({ status: 'queued', queuedAt }, NOW)).toBe(true);
  });

  it('非 queued 状态一律不算（running 归任务级时间闸管）', () => {
    for (const status of ['running', 'succeeded', 'failed', 'timed-out', 'cancelled']) {
      expect(isQueueTimedOut({ status, queuedAt: minutesAgo(60) }, NOW)).toBe(false);
    }
  });

  it('queued_at 为 NULL 时保守放过', () => {
    expect(isQueueTimedOut({ status: 'queued', queuedAt: null }, NOW)).toBe(false);
  });

  it('上限可覆盖（自定义阈值）', () => {
    expect(isQueueTimedOut({ status: 'queued', queuedAt: minutesAgo(6) }, NOW, 5)).toBe(true);
    expect(isQueueTimedOut({ status: 'queued', queuedAt: minutesAgo(6) }, NOW, 30)).toBe(false);
  });
});

describe('queueWaitSeconds', () => {
  it('按整数秒计；时钟回拨（负值）归零', () => {
    expect(queueWaitSeconds(minutesAgo(3), NOW)).toBe(180);
    expect(queueWaitSeconds(new Date(NOW.getTime() + 5_000), NOW)).toBe(0);
    expect(queueWaitSeconds(null, NOW)).toBe(0);
  });
});

describe('queueGateActions', () => {
  it('只挑出超时的任务，并给出改状态 + 评论的动作', () => {
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
      comment: QUEUE_GATE_COMMENT,
    });
  });

  it('候选为空时返回空数组（不产生副作用）', () => {
    expect(queueGateActions([], NOW)).toEqual([]);
  });

  it('评论正文包含「排队过长」（plan §9.1 的措辞）', () => {
    expect(QUEUE_GATE_COMMENT).toContain('排队过长');
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
