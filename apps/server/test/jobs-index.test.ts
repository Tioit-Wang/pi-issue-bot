/**
 * `jobs/index.ts` 的注册映射测试（**不连库**）。
 *
 * 这里只回答一个问题：`queue/SCHEDULES` 里的每个队列，是否都映射到了一个作业，
 * 且缺依赖时能明确跳过而不是炸掉启动？映射写错不会有任何运行时症状（作业就是不跑，
 * 面板永远空着），所以用测试钉死。
 */
import { describe, expect, it } from 'vitest';

import { JOB_SCHEDULES, createJobRunners, registerJobs } from '../src/jobs/index.ts';
import type { JobDeps } from '../src/jobs/index.ts';
import { QUEUE, SCHEDULES } from '../src/queue/index.ts';
import type { WorkBoss } from '../src/queue/index.ts';
import type { GithubClient, ResponseLike } from '../src/github/index.ts';
import type { SandboxDocker } from '../src/sandbox/index.ts';

/** 只会记录调用、永远查不出数据的池子（映射测试不跑真实 SQL）。 */
function createFakePool(failWith?: Error): JobDeps['pool'] {
  return {
    query: async () => {
      if (failWith !== undefined) {
        throw failWith;
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => {
      throw new Error('映射测试不该开事务');
    },
  };
}

/** 只记录 (队列名) 的假 WorkBoss（真实的 `work()` 会拉起轮询，测试不要）。 */
function createFakeBoss(): { boss: WorkBoss; queues: string[] } {
  const queues: string[] = [];
  const boss: WorkBoss = {
    work: async (name: string) => {
      queues.push(name);
      return `handler-${name}`;
    },
  };
  return { boss, queues };
}


/** 假 GitHub 读接口：泛型要跟着 `GithubRequest` 走，否则 `data: {}` 不能赋给 `T`。 */
function createFakeGithubClient(): Pick<GithubClient, 'request'> {
  return {
    request: async <T = unknown>(): Promise<ResponseLike<T>> => ({
      status: 200,
      headers: {},
      data: undefined as T,
    }),
  };
}
const fakeDocker: SandboxDocker = {
  ping: async () => undefined,
  createContainer: async () => 'unused',
  inspectState: async () => {
    throw new Error('unused');
  },
  execStream: async () => {
    throw new Error('unused');
  },
  destroyContainer: async () => undefined,
};

describe('jobs/index：队列 ↔ 作业映射', () => {
  it('四个作业覆盖 queue/SCHEDULES 里对应的四个队列', () => {
    const scheduledQueues = SCHEDULES.map((spec) => spec.queue);
    for (const entry of JOB_SCHEDULES) {
      expect(scheduledQueues).toContain(entry.queue);
    }
    expect(JOB_SCHEDULES.map((entry) => entry.queue)).toEqual([
      QUEUE.metricsRollup,
      QUEUE.reconcile,
      QUEUE.retentionCleanup,
      QUEUE.lifecycleCleanup,
    ]);
    expect(JOB_SCHEDULES.map((entry) => entry.job)).toEqual([
      'metrics-rollup',
      'reconcile-reverts',
      'retention-cleanup',
      'lifecycle-sweep',
    ]);
  });

  it('依赖齐全时注册四个队列的 worker，并把结果写进日志', async () => {
    const { boss, queues } = createFakeBoss();
    const lines: string[] = [];
    const logger = {
      info: (fields: Record<string, unknown> | string, message?: string) => {
        lines.push(`${String(message)}:${JSON.stringify(fields)}`);
      },
      warn: (fields: Record<string, unknown> | string, message?: string) => {
        lines.push(`${String(message)}:${JSON.stringify(fields)}`);
      },
      error: (fields: Record<string, unknown> | string, message?: string) => {
        lines.push(`${String(message)}:${JSON.stringify(fields)}`);
      },
    };

    const registered = await registerJobs(boss, {
      pool: createFakePool(),
      logger,
      github: createFakeGithubClient(),
      docker: fakeDocker,
    });

    expect(registered).toEqual([
      QUEUE.metricsRollup,
      QUEUE.reconcile,
      QUEUE.retentionCleanup,
      QUEUE.lifecycleCleanup,
    ]);
    expect(queues).toEqual(registered);
    expect(lines).toEqual([]);
  });

  it('缺 docker / github 时跳过对应队列并告警，其余照注册', async () => {
    const { boss, queues } = createFakeBoss();
    const warnings: string[] = [];

    const registered = await registerJobs(boss, {
      pool: createFakePool(),
      logger: {
        info: () => {},
        warn: (fields, message) => {
          warnings.push(`${String(fields)}|${String(message)}`);
        },
        error: () => {},
      },
    });

    expect(registered).toEqual([QUEUE.metricsRollup, QUEUE.retentionCleanup]);
    expect(queues).toEqual([QUEUE.metricsRollup, QUEUE.retentionCleanup]);
    expect(warnings).toHaveLength(2);
    expect(warnings.join('\n')).toContain('未注入 github');
    expect(warnings.join('\n')).toContain('未注入 docker');
  });

  it('作业抛错时把错误记录下来并向上抛（交给 pg-boss 重试）', async () => {
    const { boss } = createFakeBoss();
    const errors: string[] = [];
    // 用一个「一查就炸」的池子让 metrics-rollup 失败
    const deps: JobDeps = {
      pool: createFakePool(new Error('数据库挂了')),
      logger: {
        info: () => {},
        warn: () => {},
        error: (_fields, message) => {
          errors.push(String(message));
        },
      },
      github: createFakeGithubClient(),
      docker: fakeDocker,
    };

    let handler: (() => Promise<void>) | undefined;
    const registrar = async (_boss: WorkBoss, queueName: string, fn: () => Promise<void>): Promise<string> => {
      if (queueName === QUEUE.metricsRollup) {
        handler = fn;
      }
      return `id-${queueName}`;
    };
    await registerJobs(boss, deps, registrar);

    expect(handler).toBeDefined();
    await expect(handler?.()).rejects.toThrow(/数据库挂了/);
    expect(errors).toContain('定时作业失败');
  });

  it('createJobRunners：缺注入时按作业报错，不静默跳过', () => {
    const runners = createJobRunners({ pool: createFakePool() });
    // 缺依赖是配置错误：同步抛（不是等着 resolve 一个失败结果）
    expect(() => runners['reconcile-reverts']()).toThrow(/缺少 github/);
    expect(() => runners['lifecycle-sweep']()).toThrow(/缺少 docker/);
  });
});
