/**
 * 队列定义与启动自检的单测（tech-plan §4.7、§7.1、§7.5、§7.6）。
 *
 * 用假 boss（只记录调用）断言：
 *  - `ensureQueues` 只建缺失的队列，且把 §4.7 的 `expireInSeconds` 传下去；
 *  - `registerSchedules` 的 5 条 cron 与 UTC 时区；
 *  - `queueJobOptions` 的 `singletonKey = taskId` 与 20min/30min 两档执行期硬上限。
 */
import { describe, expect, it } from 'vitest';
import {
  EXPIRE_IN_SECONDS_DEFAULT,
  EXPIRE_IN_SECONDS_REVIEW_PR,
  QUEUE,
  QUEUES,
  REVIEW_PR_COMMAND,
  SCHEDULES,
  ensureQueues,
  expireInSecondsForCommand,
  queueSpecOf,
  registerSchedules,
  validateDefinitions,
} from '../src/queue/definitions.ts';
import type {
  CreateQueueOptions,
  QueueAdminBoss,
  QueueName,
  ScheduleAdminBoss,
} from '../src/queue/definitions.ts';
import { queueJobOptions } from '../src/queue/boss.ts';
import { JOB_PIPELINE_CLOSE_SCHEDULE } from '../src/config/pipeline-constants.ts';

type CreateCall = { readonly name: string; readonly options: CreateQueueOptions };
type ScheduleCall = {
  readonly name: string;
  readonly cron: string;
  readonly data: object | null;
  readonly options: Record<string, unknown>;
};

/** 会「记住」已建队列的假 boss：第二次调用必须什么都不建。 */
function fakeAdminBoss(): QueueAdminBoss & { readonly createCalls: CreateCall[]; readonly created: Set<string> } {
  const createCalls: CreateCall[] = [];
  const created = new Set<string>();
  const boss = {
    createCalls,
    created,
    getQueue: async (name: string): Promise<unknown | null> => (created.has(name) ? { name } : null),
    createQueue: async (name: string, options: CreateQueueOptions): Promise<void> => {
      createCalls.push({ name, options });
      created.add(name);
    },
  };
  return boss;
}

describe('queueJobOptions：singletonKey 与 expireInSeconds', () => {
  it('singletonKey 就是 taskId（任务已在队列就不再入队）', () => {
    const options = queueJobOptions('task-1', 'auto:triage');
    expect(options.singletonKey).toBe('task-1');
  });

  it('默认 20min，/review-pr 30min（§4.7 第二行）', () => {
    expect(expireInSecondsForCommand('auto:compliance')).toBe(EXPIRE_IN_SECONDS_DEFAULT);
    expect(expireInSecondsForCommand(REVIEW_PR_COMMAND)).toBe(EXPIRE_IN_SECONDS_REVIEW_PR);
    expect(EXPIRE_IN_SECONDS_DEFAULT).toBe(20 * 60);
    expect(EXPIRE_IN_SECONDS_REVIEW_PR).toBe(30 * 60);
    expect(queueJobOptions('t', REVIEW_PR_COMMAND).expireInSeconds).toBe(30 * 60);
    expect(queueJobOptions('t', 'auto:triage').expireInSeconds).toBe(20 * 60);
  });

  it('入队一律 retryLimit 0：自动重试会让超时任务被重跑（§7.3 F6）', () => {
    expect(queueJobOptions('t', REVIEW_PR_COMMAND).retryLimit).toBe(0);
  });
});

describe('QUEUES 定义', () => {
  it('7 个队列齐全（含 pipeline-close），命名与常量一致', () => {
    expect(QUEUES.map((spec) => spec.name).sort()).toEqual(
      [
        QUEUE.runTask,
        QUEUE.queueGate,
        QUEUE.lifecycleCleanup,
        QUEUE.metricsRollup,
        QUEUE.reconcile,
        QUEUE.retentionCleanup,
        QUEUE.pipelineClose,
      ].sort(),
    );
  });

  it('并发落在 1–4，run-task 是 2–4（§7.1）', () => {
    for (const spec of QUEUES) {
      expect(spec.concurrency).toBeGreaterThanOrEqual(1);
      expect(spec.concurrency).toBeLessThanOrEqual(4);
    }
    expect(queueSpecOf(QUEUE.runTask).concurrency).toBeGreaterThanOrEqual(2);
  });

  it('run-task 队列级 retryLimit 必须是 0', () => {
    expect(queueSpecOf(QUEUE.runTask).retryLimit).toBe(0);
  });

  it('validateDefinitions 对默认定义零违规', () => {
    expect(validateDefinitions()).toEqual([]);
  });

  it('validateDefinitions 能抓出「run-task 自动重试」「并发越界」「cron 段数不对」', () => {
    const badQueues = QUEUES.map((spec) =>
      spec.name === QUEUE.runTask ? { ...spec, retryLimit: 1, concurrency: 9 } : spec,
    );
    const badSchedules = [{ ...SCHEDULES[0]!, cron: '0 * * *' }];
    const violations = validateDefinitions(badQueues, badSchedules);
    expect(violations.some((item) => item.message.includes('retryLimit 必须为 0'))).toBe(true);
    expect(violations.some((item) => item.message.includes('并发必须在 1–4 之间'))).toBe(true);
    expect(violations.some((item) => item.message.includes('cron 必须是 5 段'))).toBe(true);
  });
});

describe('SCHEDULES 定时任务', () => {
  it('六条定时任务：排队闸门每分钟、metrics 每天 00:10、reconcile 每小时、保留期每天、自动关闭每 10 分钟', () => {
    const byQueue = new Map(SCHEDULES.map((spec) => [spec.queue, spec]));
    expect(SCHEDULES).toHaveLength(6);
    expect(byQueue.get(QUEUE.queueGate)?.cron).toBe('* * * * *');
    expect(byQueue.get(QUEUE.lifecycleCleanup)?.cron).toBe('* * * * *');
    expect(byQueue.get(QUEUE.metricsRollup)?.cron).toBe('10 0 * * *');
    expect(byQueue.get(QUEUE.reconcile)?.cron).toBe('0 * * * *');
    expect(byQueue.get(QUEUE.retentionCleanup)?.cron).toBe('40 0 * * *');
    // 自动关闭（D5 / §9）：cron 取自 `config/pipeline-constants.ts::JOB_PIPELINE_CLOSE_SCHEDULE`
    expect(byQueue.get(QUEUE.pipelineClose)?.cron).toBe(JOB_PIPELINE_CLOSE_SCHEDULE);
  });

  it('全部按 UTC 解释（不依赖服务器本地时区）', () => {
    for (const spec of SCHEDULES) {
      expect(spec.timezone).toBe('UTC');
    }
  });
});

describe('ensureQueues：启动自检（队列不存在则 create）', () => {
  it('首次启动建全部 7 个队列，并把 §4.7 的选项传下去', async () => {
    const boss = fakeAdminBoss();
    const result = await ensureQueues(boss);

    expect(result.created).toHaveLength(7);
    expect(result.existing).toEqual([]);
    const runTaskCall = boss.createCalls.find((call) => call.name === QUEUE.runTask);
    expect(runTaskCall?.options).toEqual({
      expireInSeconds: EXPIRE_IN_SECONDS_DEFAULT,
      retryLimit: 0,
      retryDelay: 0,
      retryBackoff: false,
    });
  });

  it('第二次启动什么都不建（幂等）', async () => {
    const boss = fakeAdminBoss();
    await ensureQueues(boss);
    const second = await ensureQueues(boss);

    expect(second.created).toEqual([]);
    expect(second.existing).toHaveLength(7);
    expect(boss.createCalls).toHaveLength(7);
  });

  it('只补缺失的那一个', async () => {
    const boss = fakeAdminBoss();
    await ensureQueues(boss);
    boss.created.delete(QUEUE.reconcile);

    const result = await ensureQueues(boss);
    expect(result.created).toEqual([QUEUE.reconcile]);
    expect(result.existing).toHaveLength(6);
  });
});

describe('registerSchedules：注册 cron', () => {
  it('六条定时任务都注册到对应队列，带 tz 与 expireInSeconds', async () => {
    const calls: ScheduleCall[] = [];
    const boss: ScheduleAdminBoss = {
      schedule: async (name, cron, data, options) => {
        calls.push({ name, cron, data, options });
      },
    };

    const registered = await registerSchedules(boss);

    expect(registered).toHaveLength(6);
    expect(calls.map((call) => call.name as QueueName)).toContain(QUEUE.metricsRollup);
    const metrics = calls.find((call) => call.name === QUEUE.metricsRollup);
    expect(metrics?.cron).toBe('10 0 * * *');
    expect(metrics?.options.tz).toBe('UTC');
    expect(metrics?.options.expireInSeconds).toBe(600);
    // 定时 job 也不自动重试：重跑一次聚合没意义（幂等 UPSERT 保证的是「重跑结果一样」，不是「该重跑」）
    expect(metrics?.options.retryLimit).toBe(0);
    // 每条定时任务的 singletonKey 固定，重复注册不会叠出多条
    expect(metrics?.options.singletonKey).toBe(`${QUEUE.metricsRollup}-schedule`);
  });
});
