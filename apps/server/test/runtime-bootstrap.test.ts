/**
 * `runtime/bootstrap.ts` 的单测：`pi-bot bootstrap-host` 的六步（tech-plan §4.2）。
 *
 * 本机没有 `vendor/pi-host` bundle、也没有真实 Host 可连（dev-plan §13.1），
 * 因此这里注入三样东西把六步完整跑一遍：
 *  - 内存文件表冒充 bundle（PIN + bin/pi-host）；
 *  - 假 spawn 产出 READY / PAIRING 两行；
 *  - 假 RACP 客户端记录 `connect` / `pair` 的入参并返回 `pdt1.…` 设备令牌。
 * 真实 `ws://` 握手留给「有 bundle 的目标机」验证（汇报里列明）。
 */
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BOOTSTRAP_ERROR_CODES,
  BOOTSTRAP_STEPS,
  bootstrapHost,
  createSqlHostCredentialStore,
  readDeviceToken,
} from '../src/runtime/bootstrap.ts';
import type { BootstrapClient, HostCredentialRow, HostCredentialStore } from '../src/runtime/bootstrap.ts';
import { HOST_SUPERVISOR_ERROR_CODES } from '../src/runtime/host-supervisor.ts';
import { decryptSecret, generateSecretKey, sha256Hex } from '../src/runtime/crypto.ts';
import { PIN_ERROR_CODES, PIN_FILE_NAME } from '../src/runtime/pin.ts';
import { RACP_WS_PATH, RACP_WS_SUBPROTOCOL, createLogger } from '../src/runtime/deps.ts';
import type { Logger } from '../src/runtime/deps.ts';
import {
  createFakeHostSpawner,
  createMemoryReadFile,
  pairingTokenLine,
  readyLine,
} from './helpers/fake-pi-host.ts';

const BUNDLE = resolve('/tmp/vendor/pi-host/1.0.0');
const SCHEMA_TEXT = '{"$id":"racp"}';
const BIN_TEXT = '#!/bin/sh\nexit 0\n';
const KEY = new Uint8Array(32).fill(11);
const DEVICE_TOKEN = 'pdt1.device-token-abcdefghijklmnop';

function createBundle(options: { readonly schemaHash?: string } = {}) {
  const pin = {
    hostVersion: '1.0.0',
    wsPath: RACP_WS_PATH,
    wsSubprotocol: RACP_WS_SUBPROTOCOL,
    sha256: {
      'racp.schema.json': options.schemaHash ?? sha256Hex(SCHEMA_TEXT),
      'bin/pi-host': sha256Hex(BIN_TEXT),
    },
    fetchedAt: '2026-06-01T00:00:00.000Z',
    upstreamRef: 'pi-desktop@v1.0.0',
  };
  return createMemoryReadFile({
    [join(BUNDLE, PIN_FILE_NAME)]: JSON.stringify(pin),
    [join(BUNDLE, 'racp.schema.json')]: SCHEMA_TEXT,
    [join(BUNDLE, 'bin', 'pi-host')]: BIN_TEXT,
  });
}

/** 内存版 `host_credentials`。 */
function createMemoryCredentials(seed: readonly HostCredentialRow[] = []): HostCredentialStore & {
  readonly rows: Map<string, HostCredentialRow>;
} {
  const rows = new Map<string, HostCredentialRow>();
  for (const row of seed) {
    rows.set(row.hostId, row);
  }
  return {
    rows,
    upsert: async (row) => {
      rows.set(row.hostId, row);
    },
    find: async (hostId) => rows.get(hostId),
  };
}

interface ClientOptions {
  readonly port: number;
  readonly host: string;
  readonly token: string;
  readonly expectedHostVersion?: string;
}

interface FakeClientRecording {
  readonly options: ClientOptions;
  readonly calls: string[];
}

function createFakeClientFactory(
  options: {
    readonly version?: string;
    readonly deviceToken?: string;
    readonly expiresAt?: string;
    readonly failConnect?: Error;
  } = {},
): {
  readonly createClient: (options: ClientOptions) => BootstrapClient;
  readonly recordings: FakeClientRecording[];
} {
  const recordings: FakeClientRecording[] = [];

  return {
    recordings,
    createClient: (clientOptions) => {
      const recording: FakeClientRecording = { options: clientOptions, calls: [] };
      recordings.push(recording);

      return {
        connect: async () => {
          recording.calls.push('connect');
          if (options.failConnect !== undefined) {
            throw options.failConnect;
          }
          return {
            server: { name: 'pi-host', version: options.version ?? '1.0.0', hostId: 'host-1' },
            protocolVersion: '1.0',
            principal: { subject: 'device-1', roles: ['owner'] },
          };
        },
        pair: async (params) => {
          recording.calls.push(`pair:${params.pairingToken}`);
          return {
            deviceToken: options.deviceToken ?? DEVICE_TOKEN,
            hostId: 'host-1',
            expiresAt: options.expiresAt ?? '2026-12-01T00:00:00.000Z',
          };
        },
        close: async () => {
          recording.calls.push('close');
        },
      };
    },
  };
}

interface HarnessOptions {
  readonly schemaHash?: string;
  readonly version?: string;
  readonly deviceToken?: string;
  readonly repair?: boolean;
  readonly allowHostVersionMismatch?: boolean;
  readonly existing?: readonly HostCredentialRow[];
  readonly lines?: readonly string[];
  /** READY 之后 stdout 就结束（测「缺 PAIRING 行」） */
  readonly endAfterLines?: boolean;
  /** 等 READY/PAIRING 行的上限；缺行场景要调小，否则要等默认 15s */
  readonly readyTimeoutMs?: number;
  readonly failConnect?: Error;
}

function createBootstrapHarness(options: HarnessOptions = {}) {
  const files = createBundle(options);
  const spawner = createFakeHostSpawner({
    scripts: [
      {
        lines: options.lines ?? [readyLine({ hostId: 'host-1' }), pairingTokenLine()],
        ...(options.endAfterLines === true ? { endAfterLines: true } : {}),
      },
    ],
  });
  const client = createFakeClientFactory({
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.deviceToken === undefined ? {} : { deviceToken: options.deviceToken }),
    ...(options.failConnect === undefined ? {} : { failConnect: options.failConnect }),
  });
  const credentials = createMemoryCredentials(options.existing ?? []);

  const run = (extra: { readonly logger?: Logger } = {}) =>
    bootstrapHost({
      bundleDir: BUNDLE,
      dataDir: '/var/lib/pi-bot/host',
      readFile: files.readFile,
      spawn: spawner.spawn,
      createClient: client.createClient,
      credentials,
      key: KEY,
      sandboxBashPath: '/usr/local/lib/pi-bot/sandbox-bash',
      baseEnv: { PATH: '/usr/bin' },
      deviceName: 'pi-bot@test',
      ...(options.repair === true ? { repair: true } : {}),
      ...(options.allowHostVersionMismatch === true ? { allowHostVersionMismatch: true } : {}),
      ...(extra.logger === undefined ? {} : { logger: extra.logger }),
      // 引导收尾要 stop()：把宽限等待与 READY 超时注入成可控值
      supervisor: {
        sleep: async () => {},
        stopGraceMs: 1,
        ...(options.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: options.readyTimeoutMs }),
      },
    });

  return { run, files, spawner, client, credentials };
}

describe('bootstrapHost：六步（tech-plan §4.2）', () => {
  it('完整走完六步：PIN → spawn --pair → 读两行 → 连 WS → pair → 加密落库', async () => {
    const harness = createBootstrapHarness();
    const result = await harness.run();

    expect(result.steps).toEqual([
      BOOTSTRAP_STEPS.pinVerified,
      BOOTSTRAP_STEPS.hostSpawned,
      BOOTSTRAP_STEPS.pairingTokenRead,
      BOOTSTRAP_STEPS.wsConnected,
      BOOTSTRAP_STEPS.paired,
      BOOTSTRAP_STEPS.credentialsStored,
    ]);
    expect(result.hostId).toBe('host-1');
    expect(result.hostVersion).toBe('1.0.0');
    expect(result.port).toBe(51_234);
    expect(result.wsUrl).toBe(`ws://127.0.0.1:51234${RACP_WS_PATH}`);
    expect(result.expiresAt?.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(result.repaired).toBe(false);
    expect(result.replacedExisting).toBe(false);

    // 第 1 步：参数由配置传入（--data-dir / --port 0 / --pair）
    expect(harness.spawner.commands[0]?.args).toEqual([
      '--data-dir',
      '/var/lib/pi-bot/host',
      '--port',
      '0',
      '--pair',
    ]);
    expect(harness.spawner.commands[0]?.env['PI_DESKTOP_BASH']).toBe('/usr/local/lib/pi-bot/sandbox-bash');

    // 第 3/4 步：用配对令牌连、用配对令牌换设备令牌，顺序固定
    const recording = harness.client.recordings[0];
    expect(recording?.options).toMatchObject({
      port: 51_234,
      host: '127.0.0.1',
      token: 'ppt1.test-pairing-token-0001',
    });
    expect(recording?.options.expectedHostVersion).toBe('1.0.0');
    expect(recording?.calls).toEqual(['connect', 'pair:ppt1.test-pairing-token-0001', 'close']);

    // 第 5 步：落库的是密文，能解回设备令牌
    const row = harness.credentials.rows.get('host-1');
    expect(row?.tokenEnc.startsWith('v1:')).toBe(true);
    expect(row?.tokenEnc).not.toContain(DEVICE_TOKEN);
    expect(decryptSecret(row?.tokenEnc ?? '', { key: KEY })).toBe(DEVICE_TOKEN);
    expect(row?.expiresAt?.toISOString()).toBe('2026-12-01T00:00:00.000Z');

    // 收尾：--pair 进程不会自己退出（§4.2），必须被停掉
    expect(harness.spawner.children[0]?.signals).toEqual(['SIGTERM']);
  });

  it('--repair：同一条流程、覆盖旧行，并如实报告 replacedExisting', async () => {
    const harness = createBootstrapHarness({
      repair: true,
      existing: [
        {
          hostId: 'host-1',
          tokenEnc: 'v1:old:old:old',
          version: 1,
          expiresAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
    });
    const result = await harness.run();

    expect(result.repaired).toBe(true);
    expect(result.replacedExisting).toBe(true);
    expect(harness.credentials.rows.get('host-1')?.tokenEnc).not.toBe('v1:old:old:old');
    expect(decryptSecret(harness.credentials.rows.get('host-1')?.tokenEnc ?? '', { key: KEY })).toBe(DEVICE_TOKEN);
  });

  it('日志里不出现设备令牌明文（§10.4）', async () => {
    const lines: string[] = [];
    const logger = createLogger({
      service: 'bootstrap-test',
      destination: {
        write(chunk: string): boolean {
          lines.push(chunk);
          return true;
        },
      },
    });
    const harness = createBootstrapHarness();
    await harness.run({ logger });

    const output = lines.join('\n');
    expect(output).toContain('host-1');
    expect(output).not.toContain(DEVICE_TOKEN);
    expect(output).not.toContain('pdt1.');
  });
});

describe('bootstrapHost：失败路径', () => {
  it('PIN 哈希不符 → PIN_HASH_MISMATCH，且不会 spawn 任何进程', async () => {
    const harness = createBootstrapHarness({ schemaHash: sha256Hex('被换掉的 schema') });
    await expect(harness.run()).rejects.toMatchObject({
      code: PIN_ERROR_CODES.hashMismatch,
      failureClass: 'auth',
    });
    expect(harness.spawner.commands).toHaveLength(0);
  });

  it('协商版本与 PIN 不符 → HOST_VERSION_MISMATCH，且不落库', async () => {
    const harness = createBootstrapHarness({ version: '2.0.0' });
    await expect(harness.run()).rejects.toMatchObject({ code: PIN_ERROR_CODES.hostVersionMismatch });
    expect(harness.credentials.rows.size).toBe(0);
    // 失败也要停掉临时 Host
    expect(harness.spawner.children[0]?.signals).toContain('SIGTERM');
  });

  it('allowHostVersionMismatch：放行版本不符、留痕、如实返回协商版本', async () => {
    const harness = createBootstrapHarness({ version: '2.0.0', allowHostVersionMismatch: true });
    const result = await harness.run();

    expect(result.hostVersion).toBe('2.0.0');
    expect(result.pin.versionMismatch).toEqual({ expected: '1.0.0', actual: '2.0.0' });
    // 放宽时客户端不带 expectedHostVersion（否则握手期就会被拒）
    expect(harness.client.recordings[0]?.options.expectedHostVersion).toBeUndefined();
    expect(harness.credentials.rows.get('host-1')?.tokenEnc.startsWith('v1:')).toBe(true);
  });

  it('connection/pair 返回的不是 pdt1.… → HOST_PAIR_BAD_DEVICE_TOKEN，且不落库', async () => {
    const harness = createBootstrapHarness({ deviceToken: 'not-a-device-token' });
    await expect(harness.run()).rejects.toMatchObject({
      code: BOOTSTRAP_ERROR_CODES.badDeviceToken,
      failureClass: 'auth',
    });
    expect(harness.credentials.rows.size).toBe(0);
  });

  it('没有 PAIRING 行（READY 之后 stdout 就结束）→ PI_HOST_PAIRING_TOKEN_MISSING', async () => {
    const harness = createBootstrapHarness({ lines: [readyLine()], endAfterLines: true, readyTimeoutMs: 50 });
    await expect(harness.run()).rejects.toMatchObject({
      code: HOST_SUPERVISOR_ERROR_CODES.pairingMissing,
    });
    expect(harness.client.recordings).toHaveLength(0);
    expect(harness.credentials.rows.size).toBe(0);
  });

  it('WS 连不上 → 原样抛出（失败分类由 racp-client 的错误决定）', async () => {
    const harness = createBootstrapHarness({ failConnect: new Error('HOST_DISCONNECTED') });
    await expect(harness.run()).rejects.toThrow(/HOST_DISCONNECTED/);
    expect(harness.credentials.rows.size).toBe(0);
  });
});

describe('createSqlHostCredentialStore：SQL 形状（真实 PG 由目标机跑）', () => {
  it('upsert 走 ON CONFLICT，find 取一行并归一化列名', async () => {
    const calls: { text: string; values?: unknown[] }[] = [];
    const store = createSqlHostCredentialStore({
      query: async (text, values) => {
        calls.push({ text, values });
        if (text.startsWith('SELECT')) {
          return {
            rows: [
              {
                host_id: 'host-1',
                token_enc: 'v1:a:b:c',
                version: 1,
                expires_at: new Date('2026-12-01T00:00:00.000Z'),
              },
            ],
          };
        }
        return { rows: [] };
      },
    });

    await store.upsert({
      hostId: 'host-1',
      tokenEnc: 'v1:a:b:c',
      version: 1,
      expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    });
    expect(calls[0]?.text).toContain('INSERT INTO host_credentials');
    expect(calls[0]?.text).toContain('ON CONFLICT (host_id) DO UPDATE');
    expect(calls[0]?.values).toEqual(['host-1', 'v1:a:b:c', 1, new Date('2026-12-01T00:00:00.000Z')]);

    const found = await store.find('host-1');
    expect(found).toMatchObject({ hostId: 'host-1', tokenEnc: 'v1:a:b:c', version: 1 });
    expect(found?.expiresAt?.toISOString()).toBe('2026-12-01T00:00:00.000Z');

    // 查不到时返回 undefined（不是抛错）
    const missing = await createSqlHostCredentialStore({ query: async () => ({ rows: [] }) }).find('host-x');
    expect(missing).toBeUndefined();
  });

  it('readDeviceToken：明文列不是密文格式 → 抛错（不静默接受明文）', () => {
    const key = generateSecretKey();
    expect(() =>
      readDeviceToken({ hostId: 'h', tokenEnc: 'pdt1.plaintext', version: 1, expiresAt: null }, key),
    ).toThrowError(expect.objectContaining({ code: BOOTSTRAP_ERROR_CODES.credentialAlreadyEncrypted }));
  });
});
