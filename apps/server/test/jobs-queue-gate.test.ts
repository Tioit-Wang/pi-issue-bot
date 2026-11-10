/**
 * 排队闸门作业（`jobs/queue-gate.ts`）的测试 —— **不连库**。
 *
 * 三件只有在「作业层」才看得见的事：
 *  1. 阈值是按**仓库**取的（`settings.limits.queue_wait_minutes`）：SQL 用最小阈值粗筛，
 *     精确判定在 JS 侧按仓库各自的上限做；
 *  2. 命中后写 `tasks.status='cancelled_queue'`（带 `status='queued'` 守卫），
 *     并对 `target_number` 打一个 `confused` reaction ——**不发评论**（§0.4）；
 *  3. reaction / cancelJob 端口缺失或失败时降级成 warning，不推翻「任务已被取消」的事实。
 */
import { describe, expect, it } from 'vitest';
import { QUEUE_GATE_REPO_SETTINGS_SQL, queueGateSweep } from '../src/jobs/queue-gate.ts';
import type { QueueGateDeps } from '../src/jobs/queue-gate.ts';
import type { JobPool } from '../src/jobs/types.ts';
import { QUEUE_GATE_CANCEL_SQL, QUEUE_GATE_SQL } from '../src/queue/queue-gate.ts';

const NOW = new Date('2026-06-01T12:00:00.000Z');

type QueryCall = { readonly text: string; readonly values: readonly unknown[] | undefined };

/** 一次「库」：按 SQL 文本分派，记录每次调用，便于断言参数与顺序。 */
function createFakePool(input: {
  readonly repos?: ReadonlyArray<{ repo: string; settings?: unknown }>;
  readonly queued?: ReadonlyArray<{
    id: string;
    repo: string;
    targetNumber: number;
    minutesAgo: number;
    targetKind?: string;
    command?: string;
  }>;
  /** 取消语句的 rowCount（默认 1 = 真的改到了行） */
  readonly cancelRowCount?: number;
}): { pool: JobPool; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const pool: JobPool = {
    query: async (text: string, values?: readonly unknown[]) => {
      calls.push({ text, values });
      if (text === QUEUE_GATE_REPO_SETTINGS_SQL) {
        return {
          rows: (input.repos ?? []).map((repo) => ({
            repo_full_name: repo.repo,
            settings: repo.settings ?? {},
          })),
          rowCount: (input.repos ?? []).length,
        };
      }
      if (text === QUEUE_GATE_SQL) {
        return {
          rows: (input.queued ?? []).map((task) => ({
            id: task.id,
            repo: task.repo,
            target_kind: task.targetKind ?? 'issue',
            target_number: task.targetNumber,
            command: task.command ?? 'auto:triage',
            queued_at: new Date(NOW.getTime() - task.minutesAgo * 60 * 1000),
          })),
          rowCount: (input.queued ?? []).length,
        };
      }
      if (text === QUEUE_GATE_CANCEL_SQL) {
        return { rows: [], rowCount: input.cancelRowCount ?? 1 };
      }
      throw new Error(`未预期的 SQL：${text.slice(0, 60)}`);
    },
    connect: async () => {
      throw new Error('闸门不开事务');
    },
  };
  return { pool, calls };
}

function depsOf(pool: JobPool, overrides: Partial<QueueGateDeps> = {}): QueueGateDeps {
  return {
    pool,
    clock: () => NOW.getTime(),
    ...overrides,
  };
}

describe('queueGateSweep：仓库级阈值生效', () => {
  it('同一等待时长，阈值 3 分钟的仓库被取消、阈值 30 分钟的不动', async () => {
    const { pool, calls } = createFakePool({
      repos: [
        { repo: 'fast/repo', settings: { limits: { queue_wait_minutes: 3 } } },
        { repo: 'slow/repo', settings: { limits: { queue_wait_minutes: 30 } } },
      ],
      queued: [
        { id: 'fast-1', repo: 'fast/repo', targetNumber: 11, minutesAgo: 5 },
        { id: 'slow-1', repo: 'slow/repo', targetNumber: 22, minutesAgo: 5 },
        { id: 'slow-2', repo: 'slow/repo', targetNumber: 33, minutesAgo: 31 },
      ],
    });

    const cancelled: string[] = [];
    const reactions: Array<{ repo: string; issueNumber: number; content: string }> = [];
    const result = await queueGateSweep(
      depsOf(pool, {
        cancelJob: async (taskId) => {
          cancelled.push(taskId);
          return true;
        },
        ack: {
          addReaction: async (input) => {
            reactions.push({
              repo: input.repo,
              issueNumber: input.issueNumber,
              content: input.content,
            });
          },
        },
      }),
      { now: NOW },
    );

    // 粗筛用的是「最小阈值」（3 分钟 = 180 秒），精筛按各仓库自己的上限
    const scan = calls.find((call) => call.text === QUEUE_GATE_SQL);
    expect(scan?.values?.[1]).toBe(180);

    expect(result.stats).toMatchObject({ scanned: 3, cancelled: 2, reactions: 2, jobsCancelled: 2, repos: 2 });
    expect(cancelled).toEqual(['fast-1', 'slow-2']);
    expect(reactions).toEqual([
      { repo: 'fast/repo', issueNumber: 11, content: 'confused' },
      { repo: 'slow/repo', issueNumber: 33, content: 'confused' },
    ]);
    // 零评论：reaction 端口收到的只有 content，没有任何 body 字段
    expect(reactions.every((item) => item.content === 'confused')).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('没有配置过 settings 的仓库回落到默认 10 分钟（阈值来自默认值而不是「永不取消」）', async () => {
    const { pool } = createFakePool({
      repos: [{ repo: 'acme/a' }],
      queued: [
        { id: 'nine', repo: 'acme/a', targetNumber: 1, minutesAgo: 9 },
        { id: 'eleven', repo: 'acme/a', targetNumber: 2, minutesAgo: 11 },
      ],
    });
    const result = await queueGateSweep(depsOf(pool), { now: NOW });
    expect(result.stats.cancelled).toBe(1);
  });

  it('仓库表为空时用默认 10 分钟扫（SQL 秒数 = 600）', async () => {
    const { pool, calls } = createFakePool({ repos: [], queued: [] });
    const result = await queueGateSweep(depsOf(pool), { now: NOW });
    const scan = calls.find((call) => call.text === QUEUE_GATE_SQL);
    expect(scan?.values?.[1]).toBe(600);
    expect(result.stats).toMatchObject({ scanned: 0, cancelled: 0, repos: 0 });
    expect(result.warnings).toEqual([]);
  });
});

describe('queueGateSweep：落库与降级', () => {
  it('取消语句带 status 守卫；守卫没命中（rowCount=0）时不打 reaction、不取消 job', async () => {
    const { pool } = createFakePool({
      repos: [{ repo: 'acme/a', settings: { limits: { queue_wait_minutes: 5 } } }],
      queued: [{ id: 'taken', repo: 'acme/a', targetNumber: 7, minutesAgo: 30 }],
      cancelRowCount: 0,
    });
    let reactions = 0;
    let jobCancels = 0;
    const result = await queueGateSweep(
      depsOf(pool, {
        cancelJob: async () => {
          jobCancels += 1;
          return true;
        },
        ack: {
          addReaction: async () => {
            reactions += 1;
          },
        },
      }),
      { now: NOW },
    );

    expect(result.stats).toMatchObject({ scanned: 1, cancelled: 0, reactions: 0, jobsCancelled: 0 });
    expect(reactions).toBe(0);
    expect(jobCancels).toBe(0);
  });

  it('未注入 reaction 端口：任务照样取消，但记一条 warning（不是失败）', async () => {
    const { pool } = createFakePool({
      repos: [{ repo: 'acme/a' }],
      queued: [{ id: 'stale', repo: 'acme/a', targetNumber: 9, minutesAgo: 42 }],
    });
    const result = await queueGateSweep(depsOf(pool), { now: NOW });

    expect(result.stats.cancelled).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('reaction');
    expect(result.ok).toBe(false);
  });

  it('reaction 失败只记 warning，不影响「已取消」的统计', async () => {
    const { pool } = createFakePool({
      repos: [{ repo: 'acme/a' }],
      queued: [{ id: 'stale', repo: 'acme/a', targetNumber: 9, minutesAgo: 42 }],
    });
    const result = await queueGateSweep(
      depsOf(pool, {
        ack: {
          addReaction: async () => {
            throw new Error('403 Resource not accessible');
          },
        },
      }),
      { now: NOW },
    );

    expect(result.stats).toMatchObject({ cancelled: 1, reactions: 0 });
    expect(result.warnings.join('\n')).toContain('403');
  });

  it('cancelJob 抛错也只记 warning（库里的状态已经改完）', async () => {
    const { pool } = createFakePool({
      repos: [{ repo: 'acme/a' }],
      queued: [{ id: 'stale', repo: 'acme/a', targetNumber: 9, minutesAgo: 42 }],
    });
    const result = await queueGateSweep(
      depsOf(pool, {
        cancelJob: async () => {
          throw new Error('pg-boss 挂了');
        },
        ack: { addReaction: async () => undefined },
      }),
      { now: NOW },
    );

    expect(result.stats.cancelled).toBe(1);
    expect(result.warnings.join('\n')).toContain('pg-boss 挂了');
  });

  it('cancelJob 返回 false（job 已经跑完）不算失败', async () => {
    const { pool } = createFakePool({
      repos: [{ repo: 'acme/a' }],
      queued: [{ id: 'stale', repo: 'acme/a', targetNumber: 9, minutesAgo: 42 }],
    });
    const result = await queueGateSweep(
      depsOf(pool, { cancelJob: async () => false, ack: { addReaction: async () => undefined } }),
      { now: NOW },
    );
    expect(result.stats).toMatchObject({ cancelled: 1, jobsCancelled: 0 });
    expect(result.ok).toBe(true);
  });
});
