/**
 * `pi-bot bootstrap-host`：pi-host 引导（tech-plan §4.2 的六步，逐条落地）。
 *
 * ```
 * 0. 校验 PIN.json 的 SHA256 与 hostVersion（§2.2 钉扎，哈希永不放松）
 * 1. spawn <bundle>/bin/pi-host --data-dir <dir> --port 0 --pair   env: PI_DESKTOP_BASH=<shim>
 * 2. 读 stdout 前两行 → port + pairing token
 * 3. ws://127.0.0.1:<port>/v1/racp/ws   Authorization: Bearer ppt1.…
 *                                      Sec-WebSocket-Protocol: pi-racp.v1.jsonrpc
 * 4. connection/pair → pdt1.… 设备令牌（owner 角色）
 * 5. AES-256-GCM 加密写 host_credentials，并记录 hostId / version / expiresAt
 * 6. 正常启动不再传 --pair，直接用设备令牌连接（引导进程在这里收尾）
 * ```
 *
 * 三个关键决定：
 *  1. **`--pair` 进程不会自己退出**（§4.2 已验证的事实），所以引导末尾必须 `stop()`
 *     这个临时 Host；否则「引导用的随机端口进程」会和常驻进程抢同一份 data-dir。
 *  2. **设备令牌明文只在内存里存在一瞬间**：拿到就加密，落库的是 `v1:<iv>:<tag>:<ct>`。
 *     日志里只有 `hostId` / 版本 / 过期时间 / 密文长度，连密文本身也不打。
 *  3. **`--repair` 走同一条路**：Host 侧只存令牌的 SHA-256，丢了只能重新配对（§10.4 轮换路径）。
 *     `--repair` 不改变流程，只表示「这次是有意的重新配对」，并把旧行整体覆盖。
 *
 * 外部依赖全部注入（`spawn` / `readFile` / `createClient` / `credentials` / `key` / 时钟）：
 * 本机没有 bundle（dev-plan §13.1），单测用内存文件表 + 假 Host + 假 RACP 客户端跑完六步。
 */

import {
  DEVICE_TOKEN_PREFIX,
  RACP_WS_PATH,
  RacpClient,
  RacpOps,
  AppError,
  createNullLogger,
  previewRedacted,
  toAppError,
} from './deps.ts';
import type { Logger, WebSocketFactory } from './deps.ts';
import { decryptSecret, encryptSecret, looksEncrypted } from './crypto.ts';
import {
  HostSupervisor,
  parseHostPairingTokenLine,
  parseHostReadyLine,
} from './host-supervisor.ts';
import type {
  HostPairingInfo,
  HostRuntimeInfo,
  HostSpawn,
  HostSupervisorOptions,
} from './host-supervisor.ts';
import { assertHostVersionMatches, resolveBundleCommand, verifyPin } from './pin.ts';
import type { PinReadFile, PinVerification } from './pin.ts';

/** `host_credentials` 一行（与 `db/schema.ts` 的列一一对应）。 */
export interface HostCredentialRow {
  readonly hostId: string;
  /** 密文（`v1:<iv>:<tag>:<ct>`），**永不明文**。 */
  readonly tokenEnc: string;
  /** 密钥轮换版本号（业务列，不是密文格式版本）。 */
  readonly version: number;
  readonly expiresAt: Date | null;
}

/**
 * `host_credentials` 的写入口。用接口而不是直接拿 drizzle 表：
 * 本切片不允许改 `db/`，而且「引导」只需要 upsert + 查一行，两个方法足够；
 * 单测注入内存实现，生产注入 `createSqlHostCredentialStore(pool)`。
 */
export interface HostCredentialStore {
  upsert(row: HostCredentialRow): Promise<void>;
  find(hostId: string): Promise<HostCredentialRow | undefined>;
}

/** 只要能跑 SQL 就行（与 `db/pool.ts` 的 `SqlExecutor` 结构一致，不 import 它）。 */
export interface SqlExecutorLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toDateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * `host_credentials` 的 SQL 实现（生产用）。
 * SQL 用 upsert：同一次 `--repair` 重复执行是幂等的，不需要先删后插。
 */
export function createSqlHostCredentialStore(sql: SqlExecutorLike): HostCredentialStore {
  return {
    async upsert(row) {
      await sql.query(
        `INSERT INTO host_credentials (host_id, token_enc, version, expires_at, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (host_id) DO UPDATE
           SET token_enc = EXCLUDED.token_enc,
               version = EXCLUDED.version,
               expires_at = EXCLUDED.expires_at,
               updated_at = now()`,
        [row.hostId, row.tokenEnc, row.version, row.expiresAt],
      );
    },

    async find(hostId) {
      const result = await sql.query(
        `SELECT host_id, token_enc, version, expires_at FROM host_credentials WHERE host_id = $1`,
        [hostId],
      );
      const first = result.rows[0];
      if (!isRecord(first)) {
        return undefined;
      }
      const host = first['host_id'];
      const tokenEnc = first['token_enc'];
      const version = first['version'];
      if (typeof host !== 'string' || typeof tokenEnc !== 'string') {
        return undefined;
      }
      return {
        hostId: host,
        tokenEnc,
        version: typeof version === 'number' ? version : 1,
        expiresAt: toDateOrNull(first['expires_at']),
      };
    },
  };
}

/** `connection/initialize` 的返回里用到的部分（`RacpClient.connect()` 的结果）。 */
export interface BootstrapInitializeResult {
  readonly server: { readonly name?: string; readonly version: string; readonly hostId?: string };
  readonly protocolVersion?: string;
  readonly principal?: { readonly subject?: string; readonly roles?: readonly string[] };
}

export interface BootstrapPairResult {
  readonly deviceToken: string;
  readonly hostId?: string;
  readonly expiresAt?: string;
}

/**
 * 引导期需要的 RACP 客户端视图。
 * 真实的 `RacpClient + RacpOps` 由 `createRacpBootstrapClient` 适配；单测注入假实现。
 */
export interface BootstrapClient {
  connect(options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number }): Promise<BootstrapInitializeResult>;
  /** `connection/pair`（§4.2 第 4 步）。 */
  pair(params: { readonly pairingToken: string; readonly deviceName?: string }): Promise<BootstrapPairResult>;
  close(): Promise<void>;
}

export type BootstrapClientFactory = (options: {
  readonly port: number;
  readonly host: string;
  /** 引导期是 `ppt1.…` 配对令牌。 */
  readonly token: string;
  /** 只有**不**允许版本不符时才传，让客户端握手期就拒绝。 */
  readonly expectedHostVersion?: string;
}) => BootstrapClient;

/** 引导六步的名字（`result.steps` 与日志都按它对齐，便于对账）。 */
export const BOOTSTRAP_STEPS = {
  pinVerified: 'pin-verified',
  hostSpawned: 'host-spawned',
  pairingTokenRead: 'pairing-token-read',
  wsConnected: 'ws-connected',
  paired: 'paired',
  credentialsStored: 'credentials-stored',
} as const;

export type BootstrapStep = (typeof BOOTSTRAP_STEPS)[keyof typeof BOOTSTRAP_STEPS];

/** 引导相关的错误码。 */
export const BOOTSTRAP_ERROR_CODES = {
  pairingTokenMissing: 'PI_HOST_PAIRING_TOKEN_MISSING',
  badDeviceToken: 'HOST_PAIR_BAD_DEVICE_TOKEN',
  credentialAlreadyEncrypted: 'HOST_CREDENTIAL_ALREADY_ENCRYPTED',
} as const;

export interface BootstrapHostOptions {
  /** `vendor/pi-host/<version>/`。 */
  readonly bundleDir: string;
  /** `--data-dir`（§4.2：`/var/lib/pi-bot/host`）。 */
  readonly dataDir: string;
  readonly readFile: PinReadFile;
  readonly spawn: HostSpawn;
  readonly createClient: BootstrapClientFactory;
  readonly credentials: HostCredentialStore;
  /** 32 字节 AES key（来自 `EnvironmentFile`，由入口解析后注入）。 */
  readonly key: Uint8Array;
  /** 覆盖 `bundleDir/bin/pi-host`（本机没有 bundle 时让 doctor/测试指到别处）。 */
  readonly binaryPath?: string;
  /** `--repair`：有意重新配对（覆盖旧凭据）。 */
  readonly repair?: boolean;
  /** 只放宽「协商版本与 PIN 不符」；哈希校验永不放松。 */
  readonly allowHostVersionMismatch?: boolean;
  /** `PI_DESKTOP_BASH`（§4.5 shim）。 */
  readonly sandboxBashPath?: string;
  readonly deviceName?: string;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly logger?: Logger;
  readonly now?: () => number;
  /** 透传给监督器（退避/超时/时钟），测试用。 */
  readonly supervisor?: Partial<
    Pick<
      HostSupervisorOptions,
      'backoffMs' | 'restartWindowMs' | 'maxRestartsPerWindow' | 'stopGraceMs' | 'readyTimeoutMs' | 'sleep' | 'now'
    >
  >;
}

export interface BootstrapHostResult {
  readonly hostId: string;
  readonly hostVersion: string;
  /** 引导期监听端口（随机）。正常启动时由 Host 重新分配，不要缓存这个值。 */
  readonly port: number;
  readonly wsUrl: string;
  /** 设备令牌的过期时间（Host 侧也可能不发 = 不过期）。 */
  readonly expiresAt: Date | null;
  /** 本次是否 `--repair`。 */
  readonly repaired: boolean;
  /** 覆盖了已存在的凭据行（只有 hostId 已知时才能查到）。 */
  readonly replacedExisting: boolean;
  /** 六步留痕（顺序即执行顺序）。 */
  readonly steps: readonly BootstrapStep[];
  /** PIN 校验结果（含被放行的版本不符留痕）。 */
  readonly pin: PinVerification;
}

/** 把 `expiresAt`（ISO 字符串或空）转成 `Date | null`。 */
function parseExpiresAt(value: string | undefined): Date | null {
  if (value === undefined) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * 引导 Host（六步）。
 * 成功返回 `hostId` / 版本 / 过期时间；失败抛 `AppError`（PIN 不符 → `auth`，超时 → `timeout`）。
 * 无论成功失败，临时 `--pair` 进程都会被停掉。
 */
export async function bootstrapHost(options: BootstrapHostOptions): Promise<BootstrapHostResult> {
  const logger = options.logger ?? createNullLogger();
  const steps: BootstrapStep[] = [];
  // `runner.json` 存在时（Windows 开发机）二进制是 `node`、前置参数是 `pi-host.js`；
  // `options.binaryPath` 显式覆盖时前置参数无意义，按空处理。
  const bundleCommand = resolveBundleCommand(options.bundleDir);
  const binaryPath = options.binaryPath ?? bundleCommand.command;
  const prependArgs = options.binaryPath === undefined ? bundleCommand.prependArgs : [];

  // 第 0 步：PIN 钉扎（启动前校验一次，§2.2 第 2 条）。
  let pin = await verifyPin({
    bundleDir: options.bundleDir,
    readFile: options.readFile,
    ...(options.allowHostVersionMismatch === undefined
      ? {}
      : { allowHostVersionMismatch: options.allowHostVersionMismatch }),
  });
  steps.push(BOOTSTRAP_STEPS.pinVerified);
  logger.info({ hostVersion: pin.pin.hostVersion, files: pin.files.length }, 'PIN 校验通过');

  const supervisor = new HostSupervisor({
    spawn: options.spawn,
    binaryPath,
    dataDir: options.dataDir,
    port: 0,
    pair: true,
    logger,
    prependArgs,
    ...(options.sandboxBashPath === undefined ? {} : { sandboxBashPath: options.sandboxBashPath }),
    ...(options.baseEnv === undefined ? {} : { baseEnv: options.baseEnv }),
    ...(options.extraEnv === undefined ? {} : { extraEnv: options.extraEnv }),
    ...(options.supervisor ?? {}),
  });

  let client: BootstrapClient | undefined;
  try {
    // 第 1 步：spawn `--pair`（参数由配置传入，`port: 0` 表示随机）。
    const info: HostRuntimeInfo = await supervisor.start();
    steps.push(BOOTSTRAP_STEPS.hostSpawned);

    // 第 2 步：READY 行的 port + PAIRING 行的 token。
    const pairing: HostPairingInfo | undefined = info.pairing;
    if (pairing === undefined) {
      throw new AppError(
        `pi-host 未输出 ${'PI_HOST_PAIRING_TOKEN'} 行（引导必须带 --pair）`,
        {
          code: BOOTSTRAP_ERROR_CODES.pairingTokenMissing,
          failureClass: 'parse',
          retriable: false,
          details: { hostId: info.hostId },
        },
      );
    }
    steps.push(BOOTSTRAP_STEPS.pairingTokenRead);

    // 第 3 步：连 ws://127.0.0.1:<port>/v1/racp/ws，Bearer 配对令牌，子协议由 racp-client 内部加。
    const host = info.host ?? '127.0.0.1';
    client = options.createClient({
      port: info.port,
      host,
      token: pairing.token,
      ...(options.allowHostVersionMismatch === true ? {} : { expectedHostVersion: pin.pin.hostVersion }),
    });
    const initialized = await client.connect();
    // 协商版本必须等于 PIN；`allowHostVersionMismatch` 只放宽这一条，且留痕进 pin.versionMismatch。
    const versionCheck = assertHostVersionMatches(pin.pin.hostVersion, initialized.server.version, {
      allowHostVersionMismatch: options.allowHostVersionMismatch === true,
    });
    pin = { ...pin, hostVersion: versionCheck.hostVersion, versionMismatch: versionCheck.versionMismatch };
    steps.push(BOOTSTRAP_STEPS.wsConnected);
    logger.info(
      { hostId: info.hostId, port: info.port, version: initialized.server.version },
      '已连上 pi-host（RACP-WS）',
    );

    // 第 4 步：connection/pair → 设备令牌（owner 角色）。
    const paired = await client.pair({
      pairingToken: pairing.token,
      ...(options.deviceName === undefined ? {} : { deviceName: options.deviceName }),
    });
    if (typeof paired.deviceToken !== 'string' || !paired.deviceToken.startsWith(DEVICE_TOKEN_PREFIX)) {
      throw new AppError(`connection/pair 未返回 ${DEVICE_TOKEN_PREFIX}… 设备令牌`, {
        code: BOOTSTRAP_ERROR_CODES.badDeviceToken,
        failureClass: 'auth',
        retriable: false,
      });
    }
    steps.push(BOOTSTRAP_STEPS.paired);

    // 第 5 步：AES-256-GCM 加密并落库；记录 hostId / version / expiresAt。
    const tokenEnc = encryptSecret(paired.deviceToken, { key: options.key });
    const hostId = paired.hostId ?? info.hostId;
    const expiresAt = parseExpiresAt(paired.expiresAt ?? pairing.expiresAt);
    const existing = await options.credentials.find(hostId);
    if (existing !== undefined && !looksEncrypted(existing.tokenEnc)) {
      // 说明库里被写进过明文：不静默覆盖，先让人看一眼（§10.4 红线）。
      logger.error({ hostId }, 'host_credentials 里已有非法（非密文）令牌，本次覆盖');
    }
    await options.credentials.upsert({
      hostId,
      tokenEnc,
      version: DEFAULT_CREDENTIAL_VERSION,
      expiresAt,
    });
    steps.push(BOOTSTRAP_STEPS.credentialsStored);
    logger.info(
      {
        hostId,
        hostVersion: pin.pin.hostVersion,
        expiresAt: expiresAt === null ? null : expiresAt.toISOString(),
        repaired: options.repair === true,
        tokenCipherLength: tokenEnc.length,
      },
      '设备令牌已加密写入 host_credentials',
    );

    return {
      hostId,
      hostVersion: initialized.server.version,
      port: info.port,
      wsUrl: `ws://${host}:${String(info.port)}${RACP_WS_PATH}`,
      expiresAt,
      repaired: options.repair === true,
      replacedExisting: existing !== undefined,
      steps,
      pin,
    };
  } catch (error) {
    const appError = toAppError(error, { code: 'BOOTSTRAP_FAILED', failureClass: 'unknown' });
    logger.error({ code: appError.code, message: previewRedacted(appError.message) }, '引导失败');
    throw appError;
  } finally {
    if (client !== undefined) {
      await client.close().catch(() => undefined);
    }
    // `--pair` 不会自己退出（§4.2），引导收尾必须停掉这个临时进程。
    await supervisor.stop().catch(() => undefined);
  }
}

/**
 * 生产装配：用真实的 `RacpClient` + `RacpOps` 实现引导需要的窄接口。
 *
 * 为什么只暴露 `connect` / `pair` / `close`：向导只做这两件事，
 * 而 `RacpOps` 有 18 个 operation。窄接口让单测塞一个 20 行的假客户端即可，
 * 同时装配处仍然走真实客户端（含三个握手常量与版本协商）。
 */
export function createRacpBootstrapClient(
  options: {
    /** 仅测试/特殊传输用；默认 `racp-client` 自带的 `ws` 实现。 */
    readonly websocketFactory?: WebSocketFactory;
    /** 单次 RPC 超时；引导期给宽松一点（默认 30s）。 */
    readonly requestTimeoutMs?: number;
  } = {},
): BootstrapClientFactory {
  return (connectOptions) => {
    const client = new RacpClient({
      port: connectOptions.port,
      host: connectOptions.host,
      token: connectOptions.token,
      ...(connectOptions.expectedHostVersion === undefined
        ? {}
        : { expectedHostVersion: connectOptions.expectedHostVersion }),
      ...(options.websocketFactory === undefined ? {} : { websocketFactory: options.websocketFactory }),
      ...(options.requestTimeoutMs === undefined ? {} : { defaultTimeoutMs: options.requestTimeoutMs }),
    });
    const ops = new RacpOps(client);

    return {
      connect: async (connectOptions2) => await client.connect(connectOptions2),
      pair: async (params) =>
        await ops.pair({
          pairingToken: params.pairingToken,
          ...(params.deviceName === undefined ? {} : { deviceName: params.deviceName }),
        }),
      close: async () => {
        await client.close();
      },
    };
  };
}

/** 设备令牌解密（serve 启动时用）：密文 → 明文，只出现在内存里。 */
export function readDeviceToken(row: HostCredentialRow, key: Uint8Array): string {
  if (!looksEncrypted(row.tokenEnc)) {
    throw new AppError('host_credentials 里的令牌不是本模块产生的密文格式', {
      code: BOOTSTRAP_ERROR_CODES.credentialAlreadyEncrypted,
      failureClass: 'auth',
      retriable: false,
      details: { hostId: row.hostId },
    });
  }
  return decryptSecret(row.tokenEnc, { key });
}

/** `host_credentials.version` 的业务含义：密钥轮换版本（这里固定 1，轮换时由调用方给）。 */
export const DEFAULT_CREDENTIAL_VERSION = 1;

/** 解析器再导出一遍：doctor 也会直接解析这两行来做「Host 还能不能起」的检查。 */
export { parseHostReadyLine, parseHostPairingTokenLine };
