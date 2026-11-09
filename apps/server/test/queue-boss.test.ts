/**
 * pg-boss 封装的单测（tech-plan §5.3 第 7 步、§7.3、§4.7）。
 *
 * 全部用假 boss：**不连库、不 start()、不拉起 pg-boss 的后台线程**（dev-plan §13.4 第 5 条）。
 * 断言的是「传给 pg-boss 的参数对不对」——这正是 F6/F9 落地的地方：
 * `singletonKey = taskId`、`expireInSeconds` 两档、429 用 `startAfter`、其余 `retryLimit: 0`。
 */
import { describe, expect, it } from 'vitest';
import type { SendOptions } from 'pg-boss';
import {
  cancelTaskJob,
  enqueueRetry,
  enqueueTask,
  findTaskJobId,
  registerTaskWorker,
  queueJobOptions,
} from '../src/queue/boss.ts';
import type { QueueBoss, QueueJob, RunTaskJobData, TaskJob, WorkBoss } from '../src/queue/boss.ts';
import { QUEUE } from '../src/queue/definitions.ts';
import { decideRetry } from '../src/queue/retry-policy.ts';
import { signalFromHttp } from '../src/queue/failure-class.ts';

type SendCall = {
  readonly name: string;
  readonly data: object | null;
  readonly options: SendOptions | undefined;
};

function fakeQueueBoss(
  queuedJobs: readonly { id: string }[] = [],
): QueueBoss & { readonly sends: SendCall[]; readonly cancels: { name: string; id: string | string[] }[] } {
  const sends: SendCall[] = [];
  const cancels: { name: string; id: string | string[] }[] = [];
  return {
    sends,
    cancels,
    send: async (name, data, options) => {
      sends.push({ name, data, options });
      return `job-${sends.length}`;
    },
    cancel: async (name, id) => {
      cancels.push({ name, id });
      return { affected: 1 };
    },
    findJobs: async () => queuedJobs,
  };
}

const data: RunTaskJobData = {
  taskId: 'task-9',
  command: '/review-pr',
  repo: 'acme/widget',
};

describe('queueJobOptions / enqueueTask', () => {
  it('singletonKey = taskId，expireInSeconds 按命令分档，retryLimit 0', () => {
    expect(queueJobOptions('task-9', '/review-pr')).toEqual({
      singletonKey: 'task-9',
      expireInSeconds: 30 * 60,
      retryLimit: 0,
    });
    expect(queueJobOptions('task-9', 'auto:triage').expireInSeconds).toBe(20 * 60);
  });

  it('入队打到 run-task 队列，载荷与选项都对', async () => {
    const boss = fakeQueueBoss();
    const jobId = await enqueueTask(boss, data);

    expect(jobId).toBe('job-1');
    expect(boss.sends).toHaveLength(1);
    expect(boss.sends[0]?.name).toBe(QUEUE.runTask);
    expect(boss.sends[0]?.data).toEqual(data);
    expect(boss.sends[0]?.options).toEqual({
      singletonKey: 'task-9',
      expireInSeconds: 1800,
      retryLimit: 0,
    });
  });

  it('被 singletonKey 去重时返回 null（调用方按「已在队列」处理）', async () => {
    const boss: QueueBoss = {
      send: async () => null,
      cancel: async () => ({ affected: 0 }),
      findJobs: async () => [],
    };
    await expect(enqueueTask(boss, data)).resolves.toBeNull();
  });
});

describe('enqueueRetry：按决策重投', () => {
  it('retry:false 不入队（异常兜底不占队列）', async () => {
    const boss = fakeQueueBoss();
    const decision = decideRetry([{ failureClass: 'timeout' }]);
    await expect(enqueueRetry(boss, data, decision)).resolves.toBeNull();
    expect(boss.sends).toEqual([]);
  });

  it('429 → startAfter 重投，retryLimit 0，载荷 attempt +1', async () => {
    const boss = fakeQueueBoss();
    const decision = decideRetry([signalFromHttp(429, 25)]);
    await enqueueRetry(boss, { ...data, attempt: 1 }, decision);

    expect(boss.sends[0]?.options).toMatchObject({
      singletonKey: 'task-9',
      retryLimit: 0,
      startAfter: 25,
    });
    expect(boss.sends[0]?.data).toMatchObject({ taskId: 'task-9', attempt: 2 });
  });

  it('5xx → 交给 pg-boss 退避（retryLimit 3 / retryDelay 30 / retryBackoff）', async () => {
    const boss = fakeQueueBoss();
    await enqueueRetry(boss, data, decideRetry([signalFromHttp(503)]));

    expect(boss.sends[0]?.options).toMatchObject({
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
    });
    // 5xx 不该用 startAfter：退避由 pg-boss 自己算
    expect(boss.sends[0]?.options?.startAfter).toBeUndefined();
  });

  it('sandbox-crash → retryLimit 1', async () => {
    const boss = fakeQueueBoss();
    await enqueueRetry(boss, data, decideRetry([{ failureClass: 'sandbox-crash' }]));
    expect(boss.sends[0]?.options?.retryLimit).toBe(1);
  });
});

describe('findTaskJobId / cancelTaskJob（排队闸门用）', () => {
  it('按 singletonKey 找 job id，找到就 cancel', async () => {
    const boss = fakeQueueBoss([{ id: 'job-abc' }]);
    await expect(findTaskJobId(boss, 'task-9')).resolves.toBe('job-abc');
    await expect(cancelTaskJob(boss, 'task-9')).resolves.toBe(true);
    expect(boss.cancels).toEqual([{ name: QUEUE.runTask, id: 'job-abc' }]);
  });

  it('队列里没有该任务时返回 false，且不发 cancel（不是错误）', async () => {
    const boss = fakeQueueBoss([]);
    await expect(cancelTaskJob(boss, 'task-9')).resolves.toBe(false);
    expect(boss.cancels).toEqual([]);
  });
});

describe('registerTaskWorker', () => {
  it('把 QUEUES 的并发传给 localConcurrency，并把批量 handler 收窄成单任务', async () => {
    const seen: TaskJob[] = [];
    let captured: { localConcurrency: number } | null = null;

    const boss: WorkBoss = {
      work: async (_name, options, handler) => {
        captured = options;
        const jobs: QueueJob<RunTaskJobData>[] = [
          { id: 'job-1', data: { taskId: 't1', command: 'auto:triage', repo: 'acme/widget' } },
          { id: 'job-2', data: { taskId: 't2', command: '/review-pr', repo: 'acme/widget' } },
        ];
        await handler(jobs);
        return 'worker-1';
      },
    };

    const workerId = await registerTaskWorker(boss, async (job) => {
      seen.push(job);
    });

    expect(workerId).toBe('worker-1');
    expect(captured).toEqual({ localConcurrency: 3 });
    expect(seen.map((job) => job.id)).toEqual(['job-1', 'job-2']);
    expect(seen.map((job) => job.data.taskId)).toEqual(['t1', 't2']);
  });
});
