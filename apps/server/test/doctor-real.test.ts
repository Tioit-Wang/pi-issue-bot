/**
 * **真跑**的 doctor 验收（dev-plan §13.1 / §13.2 E11：本机有 Docker 与 PG，就必须真跑）。
 *
 * 这一组不 mock 任何东西：
 *  - 真 `docker ping` / 真 `docker image inspect` / 真 `docker run node -v`；
 *  - 真金丝雀容器（在 `pi-jobs` 网桥上探内网与公网 DNS）；
 *  - 真 cgroup：在容器里读 `memory.max` / `cpu.max`；
 *  - 真 PG：`select 1` + `schema_migrations` + `pgboss.queue`；
 *  - 真临时目录 + 真 unix socket / 命名管道的 exec 代理往返。
 *
 * 环境不可用（没有 daemon 或连不上库）时整组 skip —— **不假装跑过**。
 * 报告会 `console.log` 出来：`pnpm -r test` 的输出里能直接读到逐项状态（人工核对用）。
 */
import { describe, expect, it, beforeAll } from 'vitest';

import { closePool, createPool, ping } from '../src/db/index.ts';
import { CHECKS, exitCodeOf, formatReport, runDoctor, worstStatusOf } from '../src/doctor/index.ts';
import type { DoctorIo, DoctorOutcome } from '../src/doctor/index.ts';
import { imageCheck } from '../src/doctor/checks/image.ts';
import { bootstrapQueue, createBoss, startBoss, stopBoss } from '../src/queue/index.ts';
import { createSandboxDocker } from '../src/sandbox/docker.ts';

const DSN =
  process.env['PI_BOT_DATABASE_URL'] ?? 'postgres://postgres:postgres@127.0.0.1:5432/pi_issue_bot_test';

async function daemonReachable(): Promise<boolean> {
  try {
    await createSandboxDocker().ping();
    return true;
  } catch {
    return false;
  }
}

async function databaseReachable(): Promise<boolean> {
  const pool = createPool({ connectionString: DSN, max: 1, connectionTimeoutMillis: 2_000 });
  try {
    await ping(pool);
    return true;
  } catch {
    return false;
  } finally {
    await closePool(pool);
  }
}

const dockerUp = await daemonReachable();
const postgresUp = await databaseReachable();
const ready = dockerUp && postgresUp;

function collectIo(): { readonly io: DoctorIo; readonly out: string[] } {
  const out: string[] = [];
  return {
    io: { out: (text) => out.push(text), err: (text) => out.push(text) },
    out,
  };
}

describe.skipIf(!ready)('doctor 真跑（真 docker + 真 PG）', () => {
  /**
   * 「环境已就绪」必须包含**当前代码定义的队列**：`QUEUES` 增删（例如新增 `pipeline-close`）后，
   * 一个只跑过迁移、还没启动过 `pi-bot serve` 的库会缺队列，doctor 的 postgres 项就会 warn ——
   * 那不是产品问题，是本机环境没 bootstrap。这里用产品自己的 bootstrap 补一次（幂等），
   * 放在 `describe` 内部：环境不可用时整组 skip，不该因为连不上库把文件跑红。
   */
  beforeAll(async () => {
    const boss = createBoss({ connectionString: DSN, max: 1, applicationName: 'pi-bot-doctor-test' });
    await startBoss(boss);
    try {
      await bootstrapQueue(boss);
    } finally {
      await stopBoss(boss);
    }
  }, 60_000);

  it('逐项跑完 12 项检查，聚合与退出码自洽', async () => {
    const { io } = collectIo();
    const outcome: DoctorOutcome = await runDoctor({
      env: { PI_BOT_DATABASE_URL: DSN },
      databaseUrl: DSN,
      io,
      json: false,
    });

    // 报告本身打出来：`pnpm -r test` 的输出里就能人工核对逐项状态
    console.log(formatReport(outcome));

    expect(outcome.checks).toHaveLength(CHECKS.length);
    expect(outcome.checks.map((entry) => entry.id)).toEqual(CHECKS.map((entry) => entry.id));
    expect(new Set(outcome.checks.map((entry) => entry.id)).size).toBe(CHECKS.length);
    expect(outcome.worst).toBe(worstStatusOf(outcome.checks));
    expect(outcome.exitCode).toBe(exitCodeOf(outcome));

    for (const entry of outcome.checks) {
      expect(entry.detail.length).toBeGreaterThan(0);
      expect(typeof entry.durationMs).toBe('number');
      expect(entry.durationMs).toBeGreaterThanOrEqual(0);
      if (entry.status !== 'ok') {
        // 非 ok 必须给出修复路径，否则报告没用
        expect(entry.fixHint?.length ?? 0).toBeGreaterThan(0);
      }
    }

    // 本机有 daemon：docker 项不可能 fail（fail 说明 doctor 自己判断错了）
    const docker = outcome.checks.find((entry) => entry.id === 'docker');
    expect(docker?.status).toBe('ok');
    // 本机有 PG 且迁移已跑：postgres 项不可能 fail
    const postgres = outcome.checks.find((entry) => entry.id === 'postgres');
    expect(postgres?.status).toBe('ok');
    // 代理往返不依赖真容器：这条在任何平台都必须 ok
    const roundtrip = outcome.checks.find((entry) => entry.id === 'exec-roundtrip');
    expect(roundtrip?.status).toBe('ok');
  }, 180_000);

  it('--json 输出与报告一致', async () => {
    const { io, out } = collectIo();
    const outcome = await runDoctor({
      env: { PI_BOT_DATABASE_URL: DSN },
      databaseUrl: DSN,
      io,
      json: true,
    });
    const parsed: unknown = JSON.parse(out.join(''));
    expect(parsed).toMatchObject({ worst: outcome.worst, exitCode: outcome.exitCode });
    const record = parsed as { checks: readonly { id: string; status: string }[] };
    expect(record.checks).toHaveLength(CHECKS.length);
  }, 180_000);

  it('真跑 fail 路径：不存在的镜像 → image 项 fail，退出码非零', async () => {
    const { io } = collectIo();
    const outcome = await runDoctor({
      env: { PI_BOT_DATABASE_URL: DSN },
      databaseUrl: DSN,
      io,
      json: false,
      checks: [imageCheck],
      image: 'pi-worker-does-not-exist:node22',
    });
    expect(outcome.checks[0]?.status).toBe('fail');
    expect(outcome.checks[0]?.detail).toContain('pi-worker-does-not-exist:node22');
    expect(outcome.exitCode).toBe(exitCodeOf(outcome));
    expect(outcome.exitCode).not.toBe(0);
  }, 60_000);
});
