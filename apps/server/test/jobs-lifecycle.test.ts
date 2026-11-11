/**
 * `jobs/lifecycle-sweep` 的**真库**测试（tech-plan §6.3 那张四行表）。
 *
 * 假 docker 只实现 `inspectState` / `destroyContainer`（记录调用顺序），容器清单从注入的
 * `listContainers` 来、磁盘水位从 `diskUsageRatio` 来——于是「清扫顺序」与
 * 「**销毁前必须 inspect**」这两件事可以被逐条断言，而不是靠读代码相信。
 *
 * 三个容器：成功（立即销毁）、失败（保留 1h，但磁盘 90% → 作为最旧失败容器被清）、超时（立即销毁）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { lifecycleSweep, listTrackedContainers } from '../src/jobs/index.ts';
import type { WorktreeCandidate } from '../src/jobs/index.ts';
import { SandboxError } from '../src/sandbox/index.ts';
import type { ContainerStateSnapshot, SandboxDocker, TrackedContainer } from '../src/sandbox/index.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

const NOW = Date.parse('2026-06-01T12:00:00.000Z');

let db: TestDb;
const clock = (): number => NOW;

type FakeState = { oomKilled: boolean; exitCode: number; status?: string };

type FakeDocker = {
  readonly docker: SandboxDocker;
  readonly calls: string[];
};

/** 假 docker：只认 inspect / destroy，并按调用顺序记录（顺序断言全靠它）。 */
function createFakeDocker(states: Readonly<Record<string, FakeState>>): FakeDocker {
  const calls: string[] = [];
  const docker: SandboxDocker = {
    ping: async () => undefined,
    createContainer: async () => {
      throw new Error('lifecycle 测试不该创建容器');
    },
    inspectState: async (containerId: string): Promise<ContainerStateSnapshot> => {
      calls.push(`inspect:${containerId}`);
      const state = states[containerId];
      if (state === undefined) {
        throw new SandboxError('容器已不存在', { code: 'CONTAINER_GONE' });
      }
      return {
        containerId,
        status: state.status ?? 'exited',
        running: false,
        exitCode: state.exitCode,
        oomKilled: state.oomKilled,
      };
    },
    execStream: async () => {
      throw new Error('lifecycle 测试不该 exec');
    },
    destroyContainer: async (containerId: string) => {
      calls.push(`destroy:${containerId}`);
    },
  };
  return { docker, calls };
}

/** 三个容器：jobId 与 `tasks.id` 一一对应，落库才有落点。 */
const CONTAINERS: readonly TrackedContainer[] = [
  { jobId: 't-success', containerId: 'c-success', jobDir: '', outcome: 'success', finishedAt: NOW - 60_000 },
  { jobId: 't-failure', containerId: 'c-failure', jobDir: '', outcome: 'failure', finishedAt: NOW - 30 * 60_000 },
  { jobId: 't-timeout', containerId: 'c-timeout', jobDir: '', outcome: 'timeout', finishedAt: NOW - 10_000 },
];

const STATES: Readonly<Record<string, FakeState>> = {
  'c-success': { oomKilled: false, exitCode: 0 },
  'c-failure': { oomKilled: true, exitCode: 137 },
  'c-timeout': { oomKilled: false, exitCode: 137 },
};

async function seed(): Promise<void> {
  await db.pool.query(`
    insert into tasks (id, source, repo, target_kind, target_number, command, actor_login, idempotency_key,
                       status, container_name, ended_at)
    values
      ('t-success', 'command', 'acme/widgets', 'pr', 12, '/review-pr', 'alice', 'life-k1', 'succeeded', 'c-success', '2026-06-01T11:59:00Z'),
      ('t-failure', 'command', 'acme/widgets', 'pr', 13, '/review-pr', 'bob',   'life-k2', 'failed',    'c-failure', '2026-06-01T11:30:00Z'),
      ('t-timeout', 'command', 'acme/widgets', 'pr', 14, '/review-pr', 'carol', 'life-k3', 'timed-out', 'c-timeout', '2026-06-01T11:59:50Z')
  `);
  await db.pool.query(`
    insert into runs (id, task_id, attempt, started_at, ended_at, outcome, failure_class)
    values
      ('r1', 't-success', 1, '2026-06-01T11:58:00Z', '2026-06-01T11:59:00Z', 'succeeded', null),
      ('r2', 't-failure', 1, '2026-06-01T11:29:00Z', '2026-06-01T11:30:00Z', 'failed',    null),
      ('r3', 't-timeout', 1, '2026-06-01T11:59:40Z', '2026-06-01T11:59:50Z', 'timed-out', 'timeout')
  `);
}

async function readRuns(): Promise<{ id: string; failure_class: string | null; failure_detail: unknown }[]> {
  const result = await db.pool.query(
    'select id, failure_class, failure_detail from runs order by id',
  );
  return result.rows as { id: string; failure_class: string | null; failure_detail: unknown }[];
}

beforeAll(async () => {
  db = await openTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.truncate();
  await seed();
});

describe('jobs/lifecycle-sweep（假 docker + 假磁盘 + 真库落盘）', () => {
  it('磁盘 90%：超时/成功立即销毁，最旧的失败容器被水位清掉；每次销毁前都 inspect', async () => {
    const { docker, calls } = createFakeDocker(STATES);

    const result = await lifecycleSweep({
      pool: db.pool,
      docker,
      clock,
      listContainers: async () => CONTAINERS,
      readDiskUsageRatio: async () => 0.9,
    });

    // 清扫顺序：保留期到点的（成功、超时）先按输入顺序，水位清理的（最旧失败）排在最后
    expect(calls).toEqual([
      'inspect:c-success',
      'destroy:c-success',
      'inspect:c-timeout',
      'destroy:c-timeout',
      'inspect:c-failure',
      'destroy:c-failure',
    ]);

    expect(result.stats.containersScanned).toBe(3);
    expect(result.stats.containersDestroyed).toBe(3);
    expect(result.stats.containersKept).toBe(0);
    expect(result.stats.watermarkExceeded).toBe(true);
    expect(result.stats.watermarkDestroyed).toBe(1);
    expect(result.stats.oomCaptured).toBe(1);
    expect(result.stats.exitCodeNonZero).toBe(2);
    expect(result.stats.diskUsagePercent).toBe(90);
    // 没注入 worktree reaper：只清容器，并明确告警
    expect(result.ok).toBe(false);
    expect(result.stats.worktreesRemoved).toBe(0);

    // 销毁前采到的快照落库：OOM 升级 failure_class，普通退出码只记事件
    const runs = await readRuns();
    const failure = runs.find((row) => row.id === 'r2');
    expect(failure?.failure_class).toBe('sandbox-oom');
    expect(failure?.failure_detail).toEqual({ oomKilled: true, exitCode: 137, containerId: 'c-failure' });
    const success = runs.find((row) => row.id === 'r1');
    expect(success?.failure_class).toBeNull();

    const events = await db.pool.query(
      "select run_id, cursor, payload from run_events where kind = 'sandbox.inspected' order by run_id",
    );
    expect(events.rows).toEqual([
      { run_id: 'r1', cursor: 1, payload: expect.objectContaining({ oomKilled: false, exitCode: 0 }) },
      { run_id: 'r2', cursor: 1, payload: expect.objectContaining({ oomKilled: true, exitCode: 137 }) },
      { run_id: 'r3', cursor: 1, payload: expect.objectContaining({ oomKilled: false, exitCode: 137 }) },
    ]);
  });

  it('磁盘 10%（未超水位）：失败容器按 1h 保留期留下来，worktree 按同一张表回收', async () => {
    const { docker, calls } = createFakeDocker(STATES);
    const removed: string[] = [];
    const candidates: readonly WorktreeCandidate[] = [
      { jobId: 't-success', path: '/jobs/w-success', outcome: 'success', finishedAt: NOW - 3_600_000 },
      { jobId: 't-failure', path: '/jobs/w-failure', outcome: 'failure', finishedAt: NOW - 7_200_000 },
      { jobId: 't-timeout', path: '/jobs/w-timeout', outcome: 'timeout', finishedAt: NOW - 10_000 },
    ];

    const result = await lifecycleSweep({
      pool: db.pool,
      docker,
      clock,
      listContainers: async () => CONTAINERS,
      readDiskUsageRatio: async () => 0.1,
      worktreeReaper: {
        list: async () => candidates,
        remove: async (candidate) => {
          removed.push(candidate.path);
        },
      },
    });

    expect(calls).toEqual([
      'inspect:c-success',
      'destroy:c-success',
      'inspect:c-timeout',
      'destroy:c-timeout',
    ]);
    expect(result.stats.containersDestroyed).toBe(2);
    expect(result.stats.containersKept).toBe(1);
    expect(result.stats.watermarkExceeded).toBe(false);
    expect(result.ok).toBe(true);

    // worktree：失败（超 1h）与超时（立即）回收，成功任务保留 24h
    expect(removed).toEqual(['/jobs/w-failure', '/jobs/w-timeout']);
    expect(result.stats.worktreesScanned).toBe(3);
    expect(result.stats.worktreesRemoved).toBe(2);
    expect(result.stats.worktreesKept).toBe(1);
  });

  it('dry-run：打印计划但一个容器都不杀，也不写库', async () => {
    const { docker, calls } = createFakeDocker(STATES);

    const result = await lifecycleSweep(
      {
        pool: db.pool,
        docker,
        clock,
        listContainers: async () => CONTAINERS,
        readDiskUsageRatio: async () => 0.9,
      },
      { dryRun: true },
    );

    expect(calls).toEqual([]);
    expect(result.stats.containersScanned).toBe(3);
    expect(result.stats.containersDestroyed).toBe(0);
    expect((await readRuns()).every((row) => row.failure_class === null || row.id === 'r3')).toBe(true);
    const events = await db.pool.query("select count(*)::int as n from run_events where kind = 'sandbox.inspected'");
    expect((events.rows[0] as { n: number }).n).toBe(0);
  });

  it('容器已经不在（CONTAINER_GONE）：照样销毁，状态记 null，不炸整轮', async () => {
    const { docker, calls } = createFakeDocker({}); // 一个都 inspect 不到

    const result = await lifecycleSweep({
      pool: db.pool,
      docker,
      clock,
      listContainers: async () => CONTAINERS,
      readDiskUsageRatio: async () => 0.9,
    });

    expect(calls.filter((call) => call.startsWith('destroy:'))).toHaveLength(3);
    expect(result.stats.oomCaptured).toBe(0);
    // 采不到 OOM 就不能瞎标记
    const runs = await readRuns();
    expect(runs.find((row) => row.id === 'r2')?.failure_class).toBeNull();
  });

  it('默认容器清单读 tasks（终态 + 有容器名），排队中的不参与', async () => {
    await db.pool.query(`
      insert into tasks (id, source, repo, target_kind, target_number, command, actor_login, idempotency_key,
                         status, container_name)
      values ('t-queued', 'command', 'acme/widgets', 'pr', 15, '/review-pr', 'dave', 'life-k4', 'queued', 'c-queued')
    `);
    const { docker, calls } = createFakeDocker(STATES);

    const result = await lifecycleSweep({
      pool: db.pool,
      docker,
      clock,
      readDiskUsageRatio: async () => 0.1,
    });

    expect(result.stats.containersScanned).toBe(3);
    expect(calls).not.toContain('inspect:c-queued');
  });

  it('入参自检：磁盘水位必须在 0–1 之间', async () => {
    const { docker } = createFakeDocker(STATES);
    await expect(
      lifecycleSweep(
        {
          pool: db.pool,
          docker,
          clock,
          listContainers: async () => CONTAINERS,
          readDiskUsageRatio: async () => 1.5,
        },
        {},
      ),
    ).rejects.toThrow(/0–1/);
  });
});

describe('容器清单：已处置过的不再重复进清扫（防「每分钟一条 sandbox.inspected」）', () => {
  it('最近一次 run 有 sandbox.inspected → 该任务不再进清单；重试产生新 run 后重新进清单', async () => {
    const jobIds = async (): Promise<string[]> =>
      (await listTrackedContainers({ pool: db.pool })).map((item) => item.jobId).sort();

    // 初始：三条终态任务都在清单里（历史任务本来就会被扫到）
    expect(await jobIds()).toEqual(['t-failure', 't-success', 't-timeout']);

    // worker 销毁容器时写的那条快照 —— 它同时是「这个容器已经处理过」的凭据
    await db.pool.query(
      "insert into run_events (run_id, cursor, kind, payload) values ('r1', 1, 'sandbox.inspected', '{}'::jsonb)",
    );
    expect(await jobIds()).toEqual(['t-failure', 't-timeout']);

    // 重试（runs.attempt +1）意味着容器可能真的还在：新 run 没有快照 → 重新进清单
    await db.pool.query(
      "insert into runs (id, task_id, attempt, started_at) values ('r4', 't-success', 2, '2026-06-01T12:10:00Z')",
    );
    expect(await jobIds()).toEqual(['t-failure', 't-success', 't-timeout']);
  });

  it('清扫一轮后该任务就从清单里消失（不会每分钟重复写事件）', async () => {
    const { docker } = createFakeDocker(STATES);
    const first = await lifecycleSweep({
      pool: db.pool,
      docker,
      clock,
      readDiskUsageRatio: async () => 0.9,
    });
    // 默认清单（真库）第一轮把三台都处理掉
    expect(first.stats.containersDestroyed).toBe(3);

    const second = await lifecycleSweep({
      pool: db.pool,
      docker,
      clock,
      readDiskUsageRatio: async () => 0.9,
    });
    // 第二轮：一条都不该再扫到，更不该再追加 sandbox.inspected
    expect(second.stats.containersScanned).toBe(0);
    const inserted = await db.pool.query(
      "select count(*)::int as n from run_events where kind = 'sandbox.inspected'",
    );
    expect((inserted.rows[0] as { n: number }).n).toBe(3);
  });
});
