/**
 * `runtime/host-supervisor.ts` 的单测（tech-plan §3.4 / §4.2）。
 *
 * 覆盖：READY/PAIRING 行解析与格式错误、退避重启序列、2 分钟内 3 次后放弃、
 * 停止语义（SIGTERM → 宽限期 → SIGKILL）、启动参数由配置传入。
 * 全部用假 spawn（本机没有 bundle，dev-plan §13.1），测试进程里不会出现真实 pi-host。
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HOST_BACKOFF_MS,
  DEFAULT_MAX_RESTARTS_PER_WINDOW,
  DEFAULT_RESTART_WINDOW_MS,
  HOST_SUPERVISOR_ERROR_CODES,
  HostSupervisor,
  buildHostArgs,
  parseHostPairingTokenLine,
  parseHostReadyLine,
} from '../src/runtime/host-supervisor.ts';
import {
  createFakeHostSpawner,
  pairingTokenLine,
  readyLine,
  waitFor,
} from './helpers/fake-pi-host.ts';

function createSupervisor(
  options: {
    readonly lines?: readonly string[];
    readonly scripts?: Parameters<typeof createFakeHostSpawner>[0];
    readonly pair?: boolean;
    readonly sleeps?: number[];
    readonly clock?: { now: number };
    readonly readyTimeoutMs?: number;
    readonly maxRestarts?: number;
  } = {},
) {
  const spawner = createFakeHostSpawner(
    options.scripts ?? { defaultLines: options.lines ?? [readyLine()] },
  );
  const sleeps = options.sleeps ?? [];
  const clock = options.clock ?? { now: 1_000_000 };
  const restarted: number[] = [];

  const supervisor = new HostSupervisor({
    spawn: spawner.spawn,
    binaryPath: '/opt/pi-host/bin/pi-host',
    dataDir: '/var/lib/pi-bot/host',
    ...(options.pair === undefined ? {} : { pair: options.pair }),
    baseEnv: { PATH: '/usr/bin', PI_HOST_PORT: '0' },
    extraEnv: { PI_BOT_MODEL_API_KEY: 'model-key' },
    sandboxBashPath: '/usr/local/lib/pi-bot/sandbox-bash',
    backoffMs: [500, 1_000, 2_000],
    restartWindowMs: DEFAULT_RESTART_WINDOW_MS,
    maxRestartsPerWindow: options.maxRestarts ?? DEFAULT_MAX_RESTARTS_PER_WINDOW,
    stopGraceMs: 5_000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => clock.now,
    onRestart: (info) => {
      restarted.push(info.restarts);
    },
    ...(options.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: options.readyTimeoutMs }),
  });

  return { supervisor, spawner, sleeps, clock, restarted };
}

describe('READY / PAIRING 行解析', () => {
  it('合法行 → {hostId, host, port, version} / {token, expiresAt}', () => {
    expect(parseHostReadyLine(readyLine({ hostId: 'h-9', port: 41_111, version: '1.2.3' }))).toEqual({
      hostId: 'h-9',
      host: '127.0.0.1',
      port: 41_111,
      version: '1.2.3',
    });
    expect(parseHostPairingTokenLine(pairingTokenLine({ token: 'ppt1.abc' }))).toEqual({
      token: 'ppt1.abc',
      expiresAt: '2026-11-09T20:00:00.000Z',
    });
  });

  it('前缀不符 / JSON 坏 / 字段缺失 / token 前缀错 → PI_HOST_READY_PARSE / PI_HOST_PAIRING_PARSE', () => {
    expect(() => parseHostReadyLine('READY {"hostId":"x","port":1,"version":"1"}')).toThrowError(
      expect.objectContaining({ code: HOST_SUPERVISOR_ERROR_CODES.readyParse }),
    );
    expect(() => parseHostReadyLine('PI_HOST_READY {"hostId":')).toThrowError(
      expect.objectContaining({ code: HOST_SUPERVISOR_ERROR_CODES.readyParse }),
    );
    expect(() => parseHostReadyLine('PI_HOST_READY {"hostId":"x","port":1}')).toThrowError(
      expect.objectContaining({ code: HOST_SUPERVISOR_ERROR_CODES.readyParse }),
    );
    expect(() => parseHostReadyLine('PI_HOST_READY {"hostId":"x","port":"8080","version":"1"}')).toThrowError(
      expect.objectContaining({ code: HOST_SUPERVISOR_ERROR_CODES.readyParse }),
    );
    expect(() => parseHostPairingTokenLine('PI_HOST_PAIRING_TOKEN {"token":"wrong","expiresAt":"2026-11-09T20:00:00Z"}'))
      .toThrowError(expect.objectContaining({ code: HOST_SUPERVISOR_ERROR_CODES.pairingParse }));
    expect(() => parseHostPairingTokenLine('PI_HOST_PAIRING_TOKEN {"token":"ppt1.a","expiresAt":"nope"}'))
      .toThrowError(expect.objectContaining({ code: HOST_SUPERVISOR_ERROR_CODES.pairingParse }));
  });

  it('解析失败时的 details 不含明文令牌（凭证不进日志/错误）', () => {
    try {
      parseHostPairingTokenLine('PI_HOST_PAIRING_TOKEN {"token":"secret-token","expiresAt":"2026-11-09T20:00:00Z"}');
      throw new Error('应当抛错');
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('secret-token');
    }
  });
});

describe('启动参数由配置传入', () => {
  it('buildHostArgs：--data-dir / --port 0 / --pair 与可选参数', () => {
    expect(buildHostArgs({ dataDir: '/var/lib/pi-bot/host' })).toEqual([
      '--data-dir',
      '/var/lib/pi-bot/host',
      '--port',
      '0',
    ]);
    expect(
      buildHostArgs({
        dataDir: '/d',
        port: 0,
        pair: true,
        hostCorePath: '/opt/host-core',
        sidecarPath: '/opt/sidecar.js',
        pairingLifetimeMs: 600_000,
        logLevel: 'debug',
      }),
    ).toEqual([
      '--data-dir',
      '/d',
      '--port',
      '0',
      '--host-core',
      '/opt/host-core',
      '--sidecar',
      '/opt/sidecar.js',
      '--pair',
      '--pairing-lifetime-ms',
      '600000',
      '--log-level',
      'debug',
    ]);
  });

  it('spawn 收到的命令：二进制路径、参数、环境（含 PI_DESKTOP_BASH）', async () => {
    const { supervisor, spawner } = createSupervisor({ pair: true, lines: [readyLine(), pairingTokenLine()] });
    const info = await supervisor.start();
    const command = spawner.commands[0];

    expect(command?.command).toBe('/opt/pi-host/bin/pi-host');
    expect(command?.args).toEqual([
      '--data-dir',
      '/var/lib/pi-bot/host',
      '--port',
      '0',
      '--pair',
    ]);
    expect(command?.env['PI_DESKTOP_BASH']).toBe('/usr/local/lib/pi-bot/sandbox-bash');
    expect(command?.env['PI_BOT_MODEL_API_KEY']).toBe('model-key');
    expect(info).toMatchObject({ hostId: 'host-1', port: 51_234, version: '1.0.0', restarts: 0 });
    expect(info.pairing?.token).toBe('ppt1.test-pairing-token-0001');
    await supervisor.stop();
  });
});

describe('启动失败', () => {
  it('READY 行格式错误 → PI_HOST_READY_PARSE，并 SIGKILL 掉子进程（不留孤儿）', async () => {
    const { supervisor, spawner } = createSupervisor({ lines: ['PI_HOST_READY nope'] });
    await expect(supervisor.start()).rejects.toMatchObject({
      code: HOST_SUPERVISOR_ERROR_CODES.readyParse,
      failureClass: 'parse',
    });
    expect(supervisor.status).toBe('failed');
    expect(spawner.children[0]?.signals).toContain('SIGKILL');
  });

  it('--pair 但只给 READY 行（流结束）→ PI_HOST_PAIRING_MISSING', async () => {
    const { supervisor } = createSupervisor({
      pair: true,
      scripts: { defaultLines: [readyLine()], scripts: [{ lines: [readyLine()], endAfterLines: true }] },
    });
    await expect(supervisor.start()).rejects.toMatchObject({
      code: HOST_SUPERVISOR_ERROR_CODES.pairingMissing,
    });
  });

  it('READY 行迟迟不来 → PI_HOST_READY_TIMEOUT（failureClass=timeout）', async () => {
    const { supervisor } = createSupervisor({
      scripts: { scripts: [{ lines: [] }] },
      readyTimeoutMs: 10,
    });
    await expect(supervisor.start()).rejects.toMatchObject({
      code: HOST_SUPERVISOR_ERROR_CODES.readyTimeout,
      failureClass: 'timeout',
    });
  });

  it('重复 start → HOST_SUPERVISOR_STATE', async () => {
    const { supervisor } = createSupervisor();
    await supervisor.start();
    await expect(supervisor.start()).rejects.toMatchObject({
      code: HOST_SUPERVISOR_ERROR_CODES.state,
    });
    await supervisor.stop();
  });
});

describe('崩溃重启：退避与上限', () => {
  it('退避序列 0.5s → 1s → 2s，重启后 restarts 递增并回调', async () => {
    const ready = [readyLine()];
    const { supervisor, spawner, sleeps, restarted } = createSupervisor({
      scripts: { scripts: [{ lines: ready }, { lines: ready }, { lines: ready }, { lines: ready }] },
    });
    await supervisor.start();
    expect(DEFAULT_HOST_BACKOFF_MS).toEqual([500, 1_000, 2_000]);

    spawner.crash(0);
    await waitFor(() => spawner.commands.length === 2, { label: '第一次重启' });
    expect(sleeps).toEqual([500]);
    expect(supervisor.info?.restarts).toBe(1);
    expect(restarted).toEqual([1]);

    spawner.crash(1);
    await waitFor(() => spawner.commands.length === 3, { label: '第二次重启' });
    spawner.crash(2);
    await waitFor(() => spawner.commands.length === 4, { label: '第三次重启' });

    expect(sleeps).toEqual([500, 1_000, 2_000]);
    expect(supervisor.restarts).toBe(3);
    expect(supervisor.status).toBe('ready');

    await supervisor.stop();
  });

  it('2 分钟内第 4 次崩溃 → 放弃并把 HOST_CRASH_LOOP 交给上层', async () => {
    const ready = [readyLine()];
    const { supervisor, spawner } = createSupervisor({
      scripts: { scripts: [{ lines: ready }, { lines: ready }, { lines: ready }, { lines: ready }] },
      clock: { now: 0 },
    });
    await supervisor.start();

    for (let crash = 0; crash < 3; crash += 1) {
      spawner.crash(crash);
      await waitFor(() => spawner.commands.length === crash + 2, { label: `第 ${String(crash + 1)} 次重启` });
    }
    expect(supervisor.restarts).toBe(3);

    // 第 4 次崩溃：窗口内已有 3 次重启 → 放弃
    spawner.crash(3);
    const fatal = await supervisor.waitForFatal();
    expect(fatal.code).toBe(HOST_SUPERVISOR_ERROR_CODES.crashLoop);
    expect(fatal.failureClass).toBe('sandbox-crash');
    expect(fatal.details).toMatchObject({ restarts: 3, maxRestartsPerWindow: 3 });
    expect(supervisor.status).toBe('failed');
    expect(supervisor.failure?.code).toBe(HOST_SUPERVISOR_ERROR_CODES.crashLoop);
    // 放弃之后不再 spawn 第 5 个进程
    expect(spawner.commands.length).toBe(4);
    await supervisor.stop();
  });

  it('窗口外的崩溃不累计：2 分钟过去后仍然重启', async () => {
    const ready = [readyLine()];
    const clock = { now: 0 };
    const { supervisor, spawner } = createSupervisor({
      scripts: { scripts: [{ lines: ready }, { lines: ready }, { lines: ready }, { lines: ready }, { lines: ready }] },
      clock,
    });
    await supervisor.start();

    for (let crash = 0; crash < 4; crash += 1) {
      spawner.crash(crash);
      await waitFor(() => spawner.commands.length === crash + 2, { label: `第 ${String(crash + 1)} 次重启` });
      clock.now += DEFAULT_RESTART_WINDOW_MS + 1; // 每次崩溃都晚于窗口
    }

    expect(supervisor.restarts).toBe(4);
    expect(supervisor.status).toBe('ready');
    expect(supervisor.failure).toBeUndefined();
    await supervisor.stop();
  });

  it('重启失败（新进程起不来）也按崩溃计数，最终仍收敛到放弃', async () => {
    const { supervisor, spawner } = createSupervisor({
      scripts: {
        scripts: [{ lines: [readyLine()] }, { lines: ['PI_HOST_READY broken'], endAfterLines: true }],
      },
      maxRestarts: 2,
      clock: { now: 0 },
    });
    await supervisor.start();
    spawner.crash(0);

    const fatal = await supervisor.waitForFatal();
    expect(fatal.code).toBe(HOST_SUPERVISOR_ERROR_CODES.crashLoop);
    expect(spawner.commands.length).toBe(3); // 首发 + 2 次重试
    await supervisor.stop();
  });
});

describe('停止语义', () => {
  it('SIGTERM 后进程退出：只发 SIGTERM，状态变 stopped', async () => {
    const { supervisor, spawner } = createSupervisor();
    await supervisor.start();
    await supervisor.stop();

    expect(spawner.children[0]?.signals).toEqual(['SIGTERM']);
    expect(supervisor.status).toBe('stopped');
    // 幂等
    await supervisor.stop();
    expect(spawner.children[0]?.signals).toEqual(['SIGTERM']);
  });

  it('SIGTERM 不退出：宽限期到点补 SIGKILL', async () => {
    const { supervisor, spawner } = createSupervisor({
      scripts: { scripts: [{ lines: [readyLine()], exitOnSigterm: false }] },
    });
    await supervisor.start();
    await supervisor.stop();

    expect(spawner.children[0]?.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(supervisor.status).toBe('stopped');
  });

  it('停止后不再重启（即使刚才崩过）', async () => {
    const ready = [readyLine()];
    const { supervisor, spawner } = createSupervisor({
      scripts: { scripts: [{ lines: ready }, { lines: ready }] },
    });
    await supervisor.start();
    await supervisor.stop();
    spawner.crash(0);
    await new Promise<void>((resolveTick) => {
      setTimeout(resolveTick, 10);
    });
    expect(spawner.commands.length).toBe(1);
    expect(supervisor.status).toBe('stopped');
  });

  it('还没 start 就 stop：直接进入 stopped，不抛错', async () => {
    const { supervisor, spawner } = createSupervisor();
    await supervisor.stop();
    expect(supervisor.status).toBe('stopped');
    expect(spawner.commands).toHaveLength(0);
  });
});
