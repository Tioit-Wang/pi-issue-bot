/**
 * `doctor` 每项检查的**失配路径**（tech-plan §6.4 的逐项语义）。
 *
 * 定位：真实环境里「一切正常」是最容易走过的一条路，而预检的价值恰恰在「不正常时说什么」。
 * 所以这里全部用假 docker / 假 fs / 假命令执行 / 假连接池 / 假 /proc 制造失配，
 * 断言三态与 detail 的关键信息（不锁死整句文案，只锁「必须说出来的事实」）。
 *
 * 真跑在 `doctor-real.test.ts`：那一组用真 daemon + 真 PG，不 mock。
 */
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { RACP_WS_PATH, RACP_WS_SUBPROTOCOL } from '../../../packages/racp-client/src/index.ts';
import {
  BLOCKED_PROBES,
  canaryNetworkCheck,
  judgeProbes,
  parseProbeOutput,
} from '../src/doctor/checks/canary-network.ts';
import {
  CGROUP_PROBE_CPUS,
  CGROUP_PROBE_MEMORY_BYTES,
  cgroupCheck,
  effectiveCpus,
  parseCgroupOutput,
} from '../src/doctor/checks/cgroup.ts';
import { dockerCheck } from '../src/doctor/checks/docker.ts';
import { diskCheck } from '../src/doctor/checks/disk.ts';
import { createEchoDocker, execRoundtripCheck } from '../src/doctor/checks/exec-roundtrip.ts';
import { hostCheck } from '../src/doctor/checks/host.ts';
import { imageCheck, majorFromNodeVersion, majorFromToolchainLabel } from '../src/doctor/checks/image.ts';
import { nftablesCheck } from '../src/doctor/checks/nftables.ts';
import { pinCheck } from '../src/doctor/checks/pin.ts';
import { postgresCheck } from '../src/doctor/checks/postgres.ts';
import { isShShebang, shellCheck } from '../src/doctor/checks/shell.ts';
import { isDockerSocketTarget, socketOwnershipCheck } from '../src/doctor/checks/socket-ownership.ts';
import { realFs, resolveDeps } from '../src/doctor/deps.ts';
import type {
  CheckContext,
  CommandResult,
  CommandRunner,
  DoctorDeps,
  DoctorFs,
  DoctorProc,
} from '../src/doctor/deps.ts';
import type { SqlExecutor } from '../src/db/index.ts';
import { checksumOf } from '../src/db/index.ts';
import { QUEUES } from '../src/queue/index.ts';
import type { SandboxDocker } from '../src/sandbox/docker.ts';

/* ── 假件 ─────────────────────────────────────────────────────────────── */

function enoent(target: string): NodeJS.ErrnoException {
  const error = new Error(`ENOENT: no such file or directory, open '${target}'`) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

const okResult = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
const failResult = (code = 1, stderr = 'boom'): CommandResult => ({ code, stdout: '', stderr });

/** 路径归一：Windows 上 `path.join` 会给 `C:\a\b`，fixture 一律用 POSIX 形态，比较前先抹平。 */
function normalizePath(target: string): string {
  return target.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '').replace(/\/+$/, '');
}

function makeFs(files: Record<string, string> = {}, over: Partial<DoctorFs> = {}): DoctorFs {
  const table = new Map(Object.entries(files).map(([key, value]) => [normalizePath(key), value]));
  const lookup = (target: string): string | undefined => table.get(normalizePath(target));
  const base: DoctorFs = {
    access: async (target) => {
      if (lookup(target) === undefined) {
        throw enoent(target);
      }
    },
    readFile: async (target) => {
      const value = lookup(target);
      if (value === undefined) {
        throw enoent(target);
      }
      return value;
    },
    readBytes: async (target) => {
      const value = lookup(target);
      return value === undefined ? undefined : new TextEncoder().encode(value);
    },
    readdir: async (target) => {
      const dir = normalizePath(target);
      const names: string[] = [];
      for (const key of table.keys()) {
        const index = key.lastIndexOf('/');
        if (index > 0 && key.slice(0, index) === dir) {
          names.push(key.slice(index + 1));
        }
      }
      if (names.length === 0) {
        throw enoent(target);
      }
      return names;
    },
    stat: async () => ({ mode: 0o100600, size: 1 }),
    mkdir: async () => {},
    mkdtemp: async () => path.join(os.tmpdir(), 'pi-bot-doctor-fake'),
    rm: async () => {},
    chmod: async () => {},
    writeFile: async () => {},
    freeBytes: async () => 0,
  };
  return { ...base, ...over };
}

function makeRun(handler: (command: string, args: readonly string[]) => CommandResult): CommandRunner {
  return async (command, args) => handler(command, args);
}

function makeDocker(over: Partial<SandboxDocker> = {}): SandboxDocker {
  const base: SandboxDocker = {
    ping: async () => {},
    createContainer: async () => 'container-id',
    inspectState: async () => ({
      containerId: 'container-id',
      status: 'exited',
      running: false,
      exitCode: 0,
      oomKilled: false,
    }),
    execStream: async () => ({ exitCode: 0 }),
    destroyContainer: async () => {},
  };
  return { ...base, ...over };
}

function makePool(handler: (text: string) => unknown[]): SqlExecutor {
  return {
    query: async (text) => {
      const rows = handler(text);
      return { rows, rowCount: rows.length };
    },
  };
}

function ctxOf(over: DoctorDeps = {}): CheckContext {
  return resolveDeps({
    env: {},
    platform: 'linux',
    repoRoot: '/repo',
    migrationsDir: '/repo/migrations',
    fs: makeFs(),
    run: makeRun(() => okResult()),
    ...over,
  });
}

const sqlLedger = '0000_init.sql';
const sqlInit = 'CREATE TABLE t (id int);\n--> statement-breakpoint\n';

/** 一个「迁移已最新 + 队列建全」的假库。 */
function healthyPool(): SqlExecutor {
  return makePool((text) => {
    if (text.includes('select 1 as ok')) {
      return [{ ok: 1 }];
    }
    if (text.includes('schema_migrations')) {
      return [{ id: '0000_init', name: 'init', checksum: checksumOf(sqlInit), applied_at: new Date(0) }];
    }
    if (text.includes("to_regclass('pgboss.queue')")) {
      return [{ q: 'pgboss.queue' }];
    }
    if (text.includes('FROM "pgboss"."queue"')) {
      return QUEUES.map((spec) => ({ name: spec.name }));
    }
    throw new Error(`未知 SQL：${text}`);
  });
}

function migrationsFs(sql = sqlInit): DoctorFs {
  return makeFs({ [`/repo/migrations/${sqlLedger}`]: sql });
}

/* ── docker ───────────────────────────────────────────────────────────── */

describe('docker 检查', () => {
  it('ping 成功 → ok，并带 daemon 版本', async () => {
    const result = await dockerCheck.run(
      ctxOf({ docker: makeDocker(), run: makeRun(() => okResult('29.4.0\n')) }),
    );
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('29.4.0');
  });

  it('ping 失败 → fail，并给出启动 daemon 的提示', async () => {
    const result = await dockerCheck.run(
      ctxOf({
        docker: makeDocker({
          ping: async () => {
            throw new Error('connect ENOENT /var/run/docker.sock');
          },
        }),
      }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('ENOENT');
    expect(result.fixHint).toContain('systemctl');
  });
});

/* ── disk ─────────────────────────────────────────────────────────────── */

describe('disk 检查', () => {
  it('可用空间不足 → fail，detail 同时给出实测与阈值', async () => {
    const result = await diskCheck.run(
      ctxOf({ fs: makeFs({}, { freeBytes: async () => 3 * 1024 ** 3 }) }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('3.0 GB');
    expect(result.detail).toContain('20.0 GB');
    expect(result.fixHint).toContain('清最旧的失败容器');
  });

  it('可用空间充足 → ok', async () => {
    const result = await diskCheck.run(
      ctxOf({ fs: makeFs({}, { freeBytes: async () => 69 * 1024 ** 3 }) }),
    );
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('69.0 GB');
  });

  it('阈值可配（PI_BOT_DISK_MIN_GB）', async () => {
    const result = await diskCheck.run(
      ctxOf({ env: { PI_BOT_DISK_MIN_GB: '5' }, fs: makeFs({}, { freeBytes: async () => 8 * 1024 ** 3 }) }),
    );
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('5.0 GB');
  });

  it('statfs 抛错 → fail（不是 warn：读不到水位就无从保护宿主）', async () => {
    const result = await diskCheck.run(
      ctxOf({
        fs: makeFs({}, {
          freeBytes: async () => {
            throw new Error('EACCES: /data');
          },
        }),
      }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('EACCES');
  });
});

/* ── image ────────────────────────────────────────────────────────────── */

describe('image 检查', () => {
  it('镜像缺失 → fail，附 docker build 提示', async () => {
    const result = await imageCheck.run(
      ctxOf({ image: 'pi-worker:node22', run: makeRun(() => failResult(1, 'No such image')) }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('pi-worker:node22');
    expect(result.fixHint).toContain('docker build');
  });

  it('label 说 node22 但容器里是 v20 → fail（不信 tag）', async () => {
    const result = await imageCheck.run(
      ctxOf({
        run: makeRun((_command, args) =>
          args[0] === 'image' ? okResult('node22|1001|1001:1001\n') : okResult('v20.11.0\n'),
        ),
      }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('v20.11.0');
    expect(result.detail).toContain('node22');
  });

  it('缺 toolchain label 但 node 能跑 → warn（不因缺 label 挡住启动）', async () => {
    const result = await imageCheck.run(
      ctxOf({
        run: makeRun((_command, args) =>
          args[0] === 'image' ? okResult('||1001:1001\n') : okResult('v22.23.4\n'),
        ),
      }),
    );
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('pi-bot.toolchain');
  });

  it('版本一致 → ok', async () => {
    const result = await imageCheck.run(
      ctxOf({
        run: makeRun((_command, args) =>
          args[0] === 'image' ? okResult('node22|1001|1001:1001\n') : okResult('v22.23.4\n'),
        ),
      }),
    );
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('1001:1001');
  });

  it('容器里跑不起来 → fail', async () => {
    const result = await imageCheck.run(
      ctxOf({
        run: makeRun((_command, args) =>
          args[0] === 'image' ? okResult('node22|1001|1001:1001\n') : failResult(127, 'node: not found'),
        ),
      }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('node -v');
  });

  it('版本解析：label 与 vX.Y.Z', () => {
    expect(majorFromToolchainLabel('node22')).toBe(22);
    expect(majorFromToolchainLabel('python312')).toBe(312);
    expect(majorFromToolchainLabel('nope')).toBeUndefined();
    expect(majorFromNodeVersion('v22.23.4')).toBe(22);
    expect(majorFromNodeVersion('garbage')).toBeUndefined();
  });
});

/* ── canary-network ───────────────────────────────────────────────────── */

describe('canary-network 检查', () => {
  const probeJson = (over: Record<string, string> = {}): string =>
    JSON.stringify({
      '169.254.169.254': 'timeout',
      '10.0.0.1': 'timeout',
      '172.16.0.1': 'timeout',
      dns: 'ok:1.2.3.4',
      ...over,
    });

  it('网络不存在 → warn（没法验证，但不冒充通过）', async () => {
    const result = await canaryNetworkCheck.run(
      ctxOf({ run: makeRun(() => failResult(1, 'no such network: pi-jobs')) }),
    );
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('pi-jobs');
    expect(result.fixHint).toContain('docker network create');
  });

  it('内网可达 → fail（这是最关键的一条）', async () => {
    const result = await canaryNetworkCheck.run(
      ctxOf({
        run: makeRun((_command, args) =>
          args[0] === 'network' ? okResult('bridge\n') : okResult(probeJson({ '169.254.169.254': 'ok' })),
        ),
      }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('169.254.169.254');
    expect(result.fixHint).toContain('nftables');
  });

  it('内网已断但公网 DNS 失败 → fail（沙箱装不了依赖）', async () => {
    const result = await canaryNetworkCheck.run(
      ctxOf({
        run: makeRun((_command, args) =>
          args[0] === 'network' ? okResult('bridge\n') : okResult(probeJson({ dns: 'error:ENOTFOUND' })),
        ),
      }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('公网 DNS');
  });

  it('内网断 + 公网通 → ok', async () => {
    const result = await canaryNetworkCheck.run(
      ctxOf({
        run: makeRun((_command, args) =>
          args[0] === 'network' ? okResult('bridge\n') : okResult(probeJson()),
        ),
      }),
    );
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('内网已阻断');
  });

  it('容器退出码非 0 → fail，带上 stderr 尾巴', async () => {
    const result = await canaryNetworkCheck.run(
      ctxOf({
        run: makeRun((_command, args) =>
          args[0] === 'network' ? okResult('bridge\n') : failResult(125, 'docker: Error response'),
        ),
      }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('125');
  });

  it('输出解析不出来 → fail（不猜结论）', async () => {
    const result = await canaryNetworkCheck.run(
      ctxOf({
        run: makeRun((_command, args) =>
          args[0] === 'network' ? okResult('bridge\n') : okResult('not json at all\n'),
        ),
      }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('无法解析');
  });

  it('纯判定：三个内网目标都必须不可达；任一可达即 fail', () => {
    const good = judgeProbes({ '169.254.169.254': 'timeout', '10.0.0.1': 'error:ECONNREFUSED', '172.16.0.1': 'timeout', dns: 'ok:1.2.3.4' });
    expect(good.status).toBe('ok');
    expect(good.blocked).toHaveLength(BLOCKED_PROBES.length);

    const bad = judgeProbes({ '10.0.0.1': 'ok', dns: 'ok:1.2.3.4' });
    expect(bad.status).toBe('fail');
    expect(bad.reachable).toEqual(['10.0.0.1']);
  });

  it('取最后一行可解析的 JSON（容忍杂行）', () => {
    expect(parseProbeOutput(`noise\n${probeJson()}\n`)?.['dns']).toBe('ok:1.2.3.4');
    expect(parseProbeOutput('nothing')).toBeUndefined();
    expect(parseProbeOutput('[1,2,3]')).toBeUndefined();
  });
});

/* ── cgroup ───────────────────────────────────────────────────────────── */

describe('cgroup 检查', () => {
  const goodOutput = `mem=${String(CGROUP_PROBE_MEMORY_BYTES)}\ncpu2=100000 100000\n`;

  it('参数落地 → ok', async () => {
    const result = await cgroupCheck.run(ctxOf({ run: makeRun(() => okResult(goodOutput)) }));
    expect(result.status).toBe('ok');
    expect(result.detail).toContain(String(CGROUP_PROBE_MEMORY_BYTES));
    expect(result.detail).toContain(`cpu=${CGROUP_PROBE_CPUS.toFixed(2)}`);
  });

  it('内存上限与参数不一致 → fail（参数没落地）', async () => {
    const result = await cgroupCheck.run(
      ctxOf({ run: makeRun(() => okResult(`mem=8589934592\ncpu2=400000 100000\n`)) }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('未生效');
  });

  it('读不到 cgroup 值 → fail，而不是默认通过', async () => {
    const result = await cgroupCheck.run(ctxOf({ run: makeRun(() => okResult('')) }));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('读不到内存上限');
  });

  it('解析：cgroup v1 的 cfs_quota/cfs_period 也能算出 CPU 数', () => {
    const v1 = parseCgroupOutput('mem=268435456\ncpu1q=200000\ncpu1p=100000\n');
    expect(v1.memoryBytes).toBe(268435456);
    expect(v1.cpuMax).toBeUndefined();
    expect(effectiveCpus(v1)).toBeCloseTo(2);
  });

  it('解析：v2 的 cpu.max=100000 100000 → 1 CPU', () => {
    expect(effectiveCpus(parseCgroupOutput('cpu2=100000 100000\n'))).toBeCloseTo(1);
    expect(effectiveCpus(parseCgroupOutput('cpu2=max 100000\n'))).toBeUndefined();
    expect(effectiveCpus(parseCgroupOutput(''))).toBeUndefined();
  });
});

/* ── postgres ─────────────────────────────────────────────────────────── */

describe('postgres 检查', () => {
  it('没配 DSN → fail，给出 export 提示', async () => {
    const result = await postgresCheck.run(ctxOf());
    expect(result.status).toBe('fail');
    expect(result.fixHint).toContain('PI_BOT_DATABASE_URL');
  });

  it('连不上 → fail', async () => {
    const result = await postgresCheck.run(
      ctxOf({
        pool: {
          query: async () => {
            throw new Error('ECONNREFUSED 127.0.0.1:5432');
          },
        },
      }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('ECONNREFUSED');
  });

  it('账本表不存在（42P01）→ fail，指向 migrate', async () => {
    const result = await postgresCheck.run(
      ctxOf({
        pool: makePool((text) => {
          if (text.includes('select 1 as ok')) {
            return [{ ok: 1 }];
          }
          const error = new Error('relation "schema_migrations" does not exist') as Error & { code: string };
          error.code = '42P01';
          throw error;
        }),
      }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('还没迁移');
    expect(result.fixHint).toContain('migrate');
  });

  it('有待执行迁移 → fail，列出待执行 id', async () => {
    const result = await postgresCheck.run(
      ctxOf({
        fs: migrationsFs(),
        pool: makePool((text) => {
          if (text.includes('select 1 as ok')) {
            return [{ ok: 1 }];
          }
          if (text.includes('schema_migrations')) {
            return [];
          }
          throw new Error(`未知 SQL：${text}`);
        }),
      }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('0000_init');
  });

  it('历史迁移被改过（checksum 不符）→ fail，且不自动迁移', async () => {
    const result = await postgresCheck.run(
      ctxOf({
        fs: migrationsFs(),
        pool: makePool((text) => {
          if (text.includes('select 1 as ok')) {
            return [{ ok: 1 }];
          }
          if (text.includes('schema_migrations')) {
            return [{ id: '0000_init', name: 'init', checksum: 'deadbeef', applied_at: new Date(0) }];
          }
          throw new Error(`未知 SQL：${text}`);
        }),
      }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('历史迁移被改过');
  });

  it('队列未初始化 → warn（迁移是好的，只是还没 serve 过）', async () => {
    const result = await postgresCheck.run(
      ctxOf({
        fs: migrationsFs(),
        pool: makePool((text) => {
          if (text.includes('select 1 as ok')) {
            return [{ ok: 1 }];
          }
          if (text.includes('schema_migrations')) {
            return [{ id: '0000_init', name: 'init', checksum: checksumOf(sqlInit), applied_at: new Date(0) }];
          }
          if (text.includes("to_regclass('pgboss.queue')")) {
            return [{ q: null }];
          }
          throw new Error(`未知 SQL：${text}`);
        }),
      }),
    );
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('pgboss.queue');
  });

  it('队列缺几条 → warn 并列出缺的名字', async () => {
    const missing = QUEUES[0]?.name ?? 'run-task';
    const result = await postgresCheck.run(
      ctxOf({
        fs: migrationsFs(),
        pool: makePool((text) => {
          if (text.includes('select 1 as ok')) {
            return [{ ok: 1 }];
          }
          if (text.includes('schema_migrations')) {
            return [{ id: '0000_init', name: 'init', checksum: checksumOf(sqlInit), applied_at: new Date(0) }];
          }
          if (text.includes("to_regclass('pgboss.queue')")) {
            return [{ q: 'pgboss.queue' }];
          }
          if (text.includes('FROM "pgboss"."queue"')) {
            return QUEUES.filter((spec) => spec.name !== missing).map((spec) => ({ name: spec.name }));
          }
          throw new Error(`未知 SQL：${text}`);
        }),
      }),
    );
    expect(result.status).toBe('warn');
    expect(result.detail).toContain(missing);
  });

  it('健康库 → ok（detail 带延迟与迁移数）', async () => {
    const result = await postgresCheck.run(ctxOf({ fs: migrationsFs(), pool: healthyPool() }));
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('迁移 1/1 已应用');
    expect(result.detail).toContain(`定义 ${String(QUEUES.length)} 条`);
  });
});

/* ── pin / host ───────────────────────────────────────────────────────── */

describe('pin 检查', () => {
  const pinJson = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      hostVersion: '0.21.0',
      wsPath: RACP_WS_PATH,
      wsSubprotocol: RACP_WS_SUBPROTOCOL,
      sha256: { 'racp.schema.json': sha256('schema-bytes') },
      fetchedAt: '2026-06-01T00:00:00.000Z',
      upstreamRef: 'v0.21.0',
      ...over,
    });

  function sha256(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
  }

  it('没有 vendored bundle → warn（VENDOR_MISSING，未校验 ≠ 通过）', async () => {
    const result = await pinCheck.run(ctxOf({ repoRoot: '/repo', fs: makeFs() }));
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('PIN_FILE_MISSING');
  });

  it('哈希不符 → fail（哈希永不放松）', async () => {
    const result = await pinCheck.run(
      ctxOf({
        bundleDir: '/repo/vendor/pi-host/0.21.0',
        fs: makeFs({
          '/repo/vendor/pi-host/0.21.0/PIN.json': pinJson(),
          '/repo/vendor/pi-host/0.21.0/racp.schema.json': 'tampered',
        }),
      }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('PIN_HASH_MISMATCH');
  });

  it('握手常量不符 → fail（§2.2 第 5 条）', async () => {
    const result = await pinCheck.run(
      ctxOf({
        bundleDir: '/repo/vendor/pi-host/0.21.0',
        fs: makeFs({
          '/repo/vendor/pi-host/0.21.0/PIN.json': pinJson({ wsPath: '/v2/racp/ws' }),
        }),
      }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('PIN_WS_BINDING_MISMATCH');
  });

  it('哈希与常量全对 → ok', async () => {
    const result = await pinCheck.run(
      ctxOf({
        bundleDir: '/repo/vendor/pi-host/0.21.0',
        fs: makeFs({
          '/repo/vendor/pi-host/0.21.0/PIN.json': pinJson(),
          '/repo/vendor/pi-host/0.21.0/racp.schema.json': 'schema-bytes',
        }),
      }),
    );
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('hostVersion=0.21.0');
  });
});

describe('host 检查', () => {
  it('未注入 connection/ping → warn（说明为什么没验）', async () => {
    const result = await hostCheck.run(ctxOf());
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('未注入');
  });

  it('握手成功 → ok', async () => {
    const result = await hostCheck.run(ctxOf({ hostPing: async () => ({ hostVersion: '0.21.0' }) }));
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('0.21.0');
  });

  it('握手失败 → fail', async () => {
    const result = await hostCheck.run(
      ctxOf({
        hostPing: async () => {
          throw new Error('HOST_DISCONNECTED');
        },
      }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('HOST_DISCONNECTED');
  });
});

/* ── shell ────────────────────────────────────────────────────────────── */

describe('shell 检查', () => {
  it('shim 不存在 → fail（命令会绕过容器）', async () => {
    const result = await shellCheck.run(ctxOf({ repoRoot: '/repo', fs: makeFs() }));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('sandbox-bash');
    expect(result.fixHint).toContain('chmod');
  });

  it('PI_DESKTOP_BASH 覆盖生效', async () => {
    const result = await shellCheck.run(
      ctxOf({
        env: { PI_DESKTOP_BASH: '/opt/pi/shim' },
        fs: makeFs({ '/opt/pi/shim': '#!/bin/sh\nexit 0\n' }),
      }),
    );
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('/opt/pi/shim');
    expect(result.detail).toContain('PI_DESKTOP_BASH');
  });

  it('不是 sh 脚本 → warn（存在但不像 shim）', async () => {
    const result = await shellCheck.run(
      ctxOf({ repoRoot: '/repo', fs: makeFs({ '/repo/scripts/sandbox-bash': '#!/usr/bin/env python3\n' }) }),
    );
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('shebang');
  });

  it('Windows 上按「存在 + 可读」判定并在 detail 说明', async () => {
    const result = await shellCheck.run(
      ctxOf({
        platform: 'win32',
        repoRoot: 'C:\\repo',
        fs: makeFs({ 'C:\\repo\\scripts\\sandbox-bash': '#!/bin/sh\nexit 0\n' }),
      }),
    );
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('Windows');
  });

  it('shebang 判定', () => {
    expect(isShShebang('#!/bin/sh')).toBe(true);
    expect(isShShebang('#!/usr/bin/env bash')).toBe(true);
    expect(isShShebang('#!/usr/bin/env python3')).toBe(false);
    expect(isShShebang('')).toBe(false);
  });
});

/* ── exec-roundtrip ───────────────────────────────────────────────────── */

describe('exec-roundtrip 检查', () => {
  it('假 docker 回 echo → ok（真监听 + 真往返，只是不真起容器）', async () => {
    const result = await execRoundtripCheck.run(
      ctxOf({ fs: realFs, platform: process.platform, roundtripDocker: createEchoDocker() }),
    );
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('exit 0');
  });

  it('输出不对 → fail', async () => {
    const result = await execRoundtripCheck.run(
      ctxOf({ fs: realFs, platform: process.platform, roundtripDocker: createEchoDocker('nope\n') }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('往返输出不对');
  });

  it('末帧退出码非 0 → fail', async () => {
    const result = await execRoundtripCheck.run(
      ctxOf({ fs: realFs, platform: process.platform, roundtripDocker: createEchoDocker('ok\n', 7) }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('退出码 7');
  });

  it('建临时目录失败 → fail（不是崩）', async () => {
    const result = await execRoundtripCheck.run(
      ctxOf({
        fs: makeFs({}, {
          mkdtemp: async () => {
            throw new Error('EACCES: tmpdir');
          },
        }),
      }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('EACCES');
  });

  it.skipIf(process.platform === 'win32')('端点文件权限不是 0600 → fail（§4.5 的权限要求是可断言的）', async () => {
    // 真 unix socket 只能在 POSIX 上监听；只把 stat 的权限位换成 644，其余走真实实现
    const strictFs: DoctorFs = { ...realFs, stat: async () => ({ mode: 0o100644, size: 32 }) };
    const result = await execRoundtripCheck.run(
      ctxOf({ fs: strictFs, platform: 'linux', roundtripDocker: createEchoDocker() }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('644');
  });
});

/* ── socket-ownership ─────────────────────────────────────────────────── */

describe('socket-ownership 检查', () => {
  it('Windows → warn（没有 /proc，并说明原因）', async () => {
    const result = await socketOwnershipCheck.run(ctxOf({ platform: 'win32' }));
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('/proc');
  });

  const procWith = (entries: Record<number, { cmdline: string; fds: Record<string, string> }>): DoctorProc => ({
    readdir: async (target) => {
      if (target === '/proc') {
        return Object.keys(entries);
      }
      const pid = Number.parseInt(target.split('/')[2] ?? '', 10);
      const entry = entries[pid];
      if (entry === undefined) {
        throw enoent(target);
      }
      return Object.keys(entry.fds);
    },
    readFile: async (target) => {
      const pid = Number.parseInt(target.split('/')[2] ?? '', 10);
      const entry = entries[pid];
      if (entry === undefined) {
        throw enoent(target);
      }
      return entry.cmdline;
    },
    readlink: async (target) => {
      const [, , pidRaw, , fd] = target.split('/');
      const pid = Number.parseInt(pidRaw ?? '', 10);
      const value = entries[pid]?.fds[fd ?? ''];
      if (value === undefined) {
        throw enoent(target);
      }
      return value;
    },
  });

  it('pi-host 持有 docker.sock → fail', async () => {
    const result = await socketOwnershipCheck.run(
      ctxOf({
        proc: procWith({
          100: { cmdline: '/opt/pi/bin/pi-host --port 451', fds: { '3': '/var/run/docker.sock' } },
        }),
      }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('docker.sock');
  });

  it('bot 自己拿着 socket 不算违规（只扫 pi-host 进程树）', async () => {
    const result = await socketOwnershipCheck.run(
      ctxOf({
        proc: procWith({
          100: { cmdline: '/opt/pi/bin/pi-host --port 451', fds: { '3': '/var/run/pi-bot/exec.sock' } },
          200: { cmdline: 'node pi-bot serve', fds: { '9': '/var/run/docker.sock' } },
        }),
      }),
    );
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('pi-host 进程树 1 个');
  });

  it('/proc 读不到 → warn（无法取证）', async () => {
    const result = await socketOwnershipCheck.run(
      ctxOf({
        proc: {
          readdir: async () => {
            throw enoent('/proc');
          },
          readFile: async () => '',
          readlink: async () => '',
        },
      }),
    );
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('/proc');
  });

  it('fd 目标判定', () => {
    expect(isDockerSocketTarget('/var/run/docker.sock')).toBe(true);
    expect(isDockerSocketTarget('socket:[12345]')).toBe(false);
  });
});

/* ── nftables ─────────────────────────────────────────────────────────── */

describe('nftables 检查', () => {
  it('配置文件缺失 → fail', async () => {
    const result = await nftablesCheck.run(ctxOf({ repoRoot: '/repo', fs: makeFs() }));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('nftables.conf');
  });

  it('文件在但缺关键片段 → fail', async () => {
    const result = await nftablesCheck.run(
      ctxOf({ repoRoot: '/repo', fs: makeFs({ '/repo/deploy/nftables.conf': 'table inet pi_jobs { }\n' }) }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('169.254.0.0/16');
  });

  it('nft 不可用 → warn，并说明原因', async () => {
    const result = await nftablesCheck.run(
      ctxOf({
        repoRoot: '/repo',
        fs: makeFs({ '/repo/deploy/nftables.conf': 'table inet pi_jobs { ip saddr 169.254.0.0/16 drop }\n' }),
        run: makeRun(() => failResult(-1, 'ENOENT: spawn nft ENOENT')),
      }),
    );
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('nft 不可用');
  });

  it('规则已加载 → ok', async () => {
    const result = await nftablesCheck.run(
      ctxOf({
        repoRoot: '/repo',
        fs: makeFs({ '/repo/deploy/nftables.conf': 'table inet pi_jobs { ip saddr 169.254.0.0/16 drop }\n' }),
        run: makeRun(() => okResult('table inet pi_jobs {\n}\n')),
      }),
    );
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('pi_jobs');
  });
});

