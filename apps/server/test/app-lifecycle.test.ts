/**
 * 装配层生命周期（**全假依赖，不连 docker / pi-host / PG**）：
 *
 *  1. `createApplication(...).start()` 之后 `/healthz` 200；
 *  2. `stop()` 按 tech-plan §3.4 的顺序执行，且 `boss` 已停、`pool` 已关（顺序用记录器断言）；
 *  3. `pi-bot serve` 能通过注入点用假装配跑起来、收到信号后停机并以 0 退出
 *     （这条直接证明「serve 不依赖真 docker / 真 host」）。
 *
 * 为什么这里不碰真库：`start()` 的第一件事是 `assertSchemaReady(pool)`（只读 `information_schema`），
 * 用假池就能验；真库的端到端在 `e2e-*.test.ts` 里。两处分工是刻意的：
 * 生命周期要快（毫秒级）且能断言顺序，端到端要真（PG + WS）。
 */
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import {
  SHUTDOWN_STEPS,
  createApplication,
  readAppConfig,
} from '../src/app/index.ts';
import type { AppConfig, Application } from '../src/app/index.ts';
import { EXIT_OK, runCli } from '../src/cli.ts';
import type { CliIo } from '../src/cli.ts';
import { createMetrics } from '../src/http/index.ts';
import type { MetricsServer } from '../src/http/index.ts';
import { createCountingGithubApi, createFakePorts, createFakeQueue } from './helpers/e2e-harness.ts';
import type { FakeQueue } from './helpers/e2e-harness.ts';

/** 记录每一步（共享给假 pool / 假 queue / 假 metrics，顺序断言就是数组顺序）。 */
type Recorder = string[];

/**
 * 假 PG 池：
 *  - `information_schema.tables` 查询返回「表都在」，让 `assertSchemaReady` 通过；
 *  - `select 1 as ok` 返回一行，让 `/healthz` 的 `ping` 通过；
 *  - `end()` 记账（停机顺序的最后几步要断言它）。
 */
function createFakePool(order: Recorder): Pool {
  const query = async (text: string) => {
    if (text.includes('information_schema')) {
      const rows = [
        'tasks',
        'runs',
        'run_events',
        'envelopes',
        'actions',
        'webhook_deliveries',
        'repos',
        'runtime_flags',
        // 0002 的三张技能表（`REQUIRED_TABLES` 与迁移必须同步，这里跟着一起长）
        'skills',
        'skill_versions',
        'skills_audit',
        // 0006 的三张 agent 表（同上：`REQUIRED_TABLES` 里加了就必须在这里出现）
        'agent_sessions',
        'agent_messages',
        'agent_denials',
      ].map((table) => ({ table_name: table }));
      return { rows, rowCount: rows.length };
    }
    return { rows: [{ ok: 1 }], rowCount: 1 };
  };

  const pool = {
    query,
    connect: async () => ({ query, release: () => undefined }),
    end: async () => {
      order.push('pool.end');
    },
  };
  return pool as unknown as Pool;
}

function createAppConfig(): AppConfig {
  return readAppConfig({
    PI_BOT_PG_DSN: 'postgres://postgres:postgres@127.0.0.1:5432/pi_issue_bot_test',
    PI_BOT_WEBHOOK_SECRET: 'e2e-webhook-secret-0123456789',
    PI_BOT_DATA_DIR: './.e2e-lifecycle',
    PI_BOT_DRY_RUN: 'true',
    PI_BOT_HTTP_HOST: '127.0.0.1',
    // 端口 0：让内核分配，避免与本机 3000 冲突
    PI_BOT_PORT: '0',
  });
}

/** 一个不监听、只记事的 metrics 实例。 */
function createRecordingMetricsServer(order: Recorder): MetricsServer {
  return {
    instance: null as unknown as FastifyInstance,
    host: '127.0.0.1',
    port: 0,
    listen: async () => ({ host: '127.0.0.1', port: 0 }),
    close: async () => {
      order.push('metrics.close');
    },
  };
}

function buildLifecycleApp(order: Recorder): { app: Application; queue: FakeQueue } {
  const config = createAppConfig();
  const queue = createFakeQueue();
  const fakePorts = createFakePorts({
    endpoint: {
      hostId: 'fake-host-lifecycle',
      port: 9,
      version: '0.21.0',
      token: 'pdt1.lifecycle0001',
    },
    github: createCountingGithubApi().api,
  });

  const app = createApplication(config, {
    pool: createFakePool(order),
    queue: {
      ...queue,
      async stop(options) {
        order.push('queue.stop');
        await queue.stop(options);
      },
    },
    ports: {
      ...fakePorts.ports,
      host: {
        ready: async () => ({
          hostId: 'fake-host-lifecycle',
          port: 9,
          version: '0.21.0',
          token: 'pdt1.lifecycle0001',
        }),
        stop: async () => {
          order.push('host.stop');
        },
      },
    },
    // 没有 bundle：任何一次 run 都会在 host 步骤明确失败（本文件不跑任务）
    racp: async () => {
      throw new Error('生命周期测试不跑任务');
    },
    metrics: createMetrics({ defaultMetrics: false }),
    metricsServer: createRecordingMetricsServer(order),
    ack: { addEyesReaction: async () => undefined },
    skipSchedules: true,
  });

  return { app, queue };
}

describe('createApplication 生命周期（全假依赖）', () => {
  it('start() → /healthz 200 → stop() 按 §3.4 顺序停机', async () => {
    const order: Recorder = [];
    const { app, queue } = buildLifecycleApp(order);

    const address = await app.start();
    expect(app.started).toBe(true);
    expect(address.http.port).toBeGreaterThan(0);
    // 队列被 start 过，run-task worker 注册过
    expect(queue.record.starts).toBe(1);
    expect(queue.record.workers).toContain('run-task');

    const health = await app.server.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    const report = health.json<{ status: string; checks: Array<{ id: string; status: string }> }>();
    expect(report.status).not.toBe('fail');
    expect(report.checks.find((check) => check.id === 'db')?.status).toBe('ok');

    await app.stop();

    // 1) 步骤顺序 = 常量顺序（§3.4：停入口 → 等 worker → 释放容器 → 关 host → 关池 → 关 metrics）
    expect(app.shutdownSteps).toEqual([...SHUTDOWN_STEPS]);
    // 2) 记录器里的真实副作用顺序：queue.stop 在 pool.end 之前，host.stop 也在 pool.end 之前
    expect(order).toEqual(['queue.stop', 'host.stop', 'pool.end', 'metrics.close']);
    // 3) boss 已停、池已关
    expect(queue.record.stopped).toHaveLength(1);
    expect(queue.record.stopped[0]?.graceful).toBe(true);
    expect(order).toContain('pool.end');
    expect(app.started).toBe(false);
  }, 30_000);

  it('重复 start() 抛错（而不是悄悄起第二个实例）', async () => {
    const order: Recorder = [];
    const { app } = buildLifecycleApp(order);
    await app.start();
    await expect(app.start()).rejects.toThrow();
    await app.stop();
  }, 30_000);

  it('「数据库缺表」在监听端口之前就失败（serve 只检查、不迁移）', async () => {
    const order: Recorder = [];
    const config = createAppConfig();
    const emptyPool = {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => undefined }),
      end: async () => {
        order.push('pool.end');
      },
    } as unknown as Pool;

    const app = createApplication(config, {
      pool: emptyPool,
      queue: createFakeQueue(),
      metrics: createMetrics({ defaultMetrics: false }),
      metricsServer: createRecordingMetricsServer(order),
      skipSchedules: true,
    });

    await expect(app.start()).rejects.toThrow(/缺表/u);
    // 没起来就不该有监听：连 stop() 都必须安全
    await app.stop();
  }, 30_000);
});

describe('pi-bot serve（假装配注入）', () => {
  it('start → 等信号 → 优雅停机，退出码 0，全程不连 docker / pi-host', async () => {
    const order: Recorder = [];
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = {
      out: (text) => {
        out.push(text);
      },
      err: (text) => {
        err.push(text);
      },
    };

    let startedApp: Application | undefined;
    const code = await runCli(['serve'], {
      io,
      env: {
        PI_BOT_PG_DSN: 'postgres://postgres:postgres@127.0.0.1:5432/pi_issue_bot_test',
        PI_BOT_WEBHOOK_SECRET: 'e2e-webhook-secret-0123456789',
        PI_BOT_DATA_DIR: './.e2e-lifecycle',
        PI_BOT_HTTP_HOST: '127.0.0.1',
        PI_BOT_PORT: '0',
      },
      appFactory: () => {
        const built = buildLifecycleApp(order);
        startedApp = built.app;
        return built.app;
      },
      // 不真发 SIGTERM：直接给一个信号，验证「收到信号 → 停机」这条路径
      waitSignal: async () => 'SIGTERM',
    });

    expect(code).toBe(EXIT_OK);
    expect(err).toEqual([]);
    expect(out.join('')).toContain('serve: 已启动');
    expect(out.join('')).toContain('SIGTERM');
    expect(startedApp?.started).toBe(false);
    expect(order).toEqual(['queue.stop', 'host.stop', 'pool.end', 'metrics.close']);
  }, 30_000);

  it('配错（缺 PI_BOT_PG_DSN）→ 用法错误码，不是崩栈', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(['serve'], {
      io: {
        out: (text) => {
          out.push(text);
        },
        err: (text) => {
          err.push(text);
        },
      },
      env: { PI_BOT_WEBHOOK_SECRET: 'x', PI_BOT_DATA_DIR: './.e2e-lifecycle' },
    });
    expect(code).toBe(1);
    expect(err.join('')).toContain('PI_BOT_PG_DSN');
  }, 30_000);
});
