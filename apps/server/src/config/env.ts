/**
 * 进程级配置：**只在入口读一次 env**，其余模块一律吃注入的配置对象（B10）。
 *
 * 为什么集中在这里：
 *  - `db/pool.ts`、`queue/boss.ts`、`http/*` 都刻意不读 `process.env`（见各文件头），
 *    于是单测与 `replay` 能塞假 DSN，不需要改全局状态；
 *  - 缺关键项（数据库 DSN、webhook secret）必须在**启动时**炸，而不是第一个事件到达时；
 *  - 变量名集中一处，`deploy/*.service` 的 `EnvironmentFile` 与这里逐字对应。
 */

import { fileURLToPath } from 'node:url';

/** 环境变量名（doc 里引用它，避免多处手抄字符串）。 */
export const ENV_KEYS = {
  databaseUrl: 'PI_BOT_DATABASE_URL',
  httpHost: 'PI_BOT_HTTP_HOST',
  httpPort: 'PI_BOT_HTTP_PORT',
  metricsHost: 'PI_BOT_METRICS_HOST',
  metricsPort: 'PI_BOT_METRICS_PORT',
  webhookSecret: 'PI_BOT_WEBHOOK_SECRET',
  bodyLimitBytes: 'PI_BOT_BODY_LIMIT_BYTES',
  logLevel: 'PI_BOT_LOG_LEVEL',
  openapi: 'PI_BOT_OPENAPI',
  migrationsDir: 'PI_BOT_MIGRATIONS_DIR',
} as const;

/** 与 tech-plan §3.2/§10.1 对齐的默认值。 */
export const DEFAULT_HTTP_HOST = '127.0.0.1';
export const DEFAULT_HTTP_PORT = 3000;
/** `/metrics` **只**监听 loopback，且是独立实例（tech-plan §10.1 F10）。 */
export const DEFAULT_METRICS_HOST = '127.0.0.1';
export const DEFAULT_METRICS_PORT = 9464;
/** 请求体上限 25 MB（`docs/spec/contract-api.md` §9：超过返回 413）。 */
export const DEFAULT_BODY_LIMIT_BYTES = 25 * 1024 * 1024;

/** 配置缺失或取值非法。CLI 捕获后打印并以非 0 退出，不「尽力启动」。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type EnvLike = Readonly<Record<string, string | undefined>>;

function readString(env: EnvLike, key: string): string | null {
  const raw = env[key];
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function readInt(env: EnvLike, key: string, fallback: number, min: number, max: number): number {
  const raw = readString(env, key);
  if (raw === null) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${key} 必须是 ${String(min)}–${String(max)} 的整数，收到 ${raw}`);
  }
  return value;
}

function readBoolean(env: EnvLike, key: string, fallback: boolean): boolean {
  const raw = readString(env, key);
  if (raw === null) {
    return fallback;
  }
  if (raw === '1' || raw.toLowerCase() === 'true') {
    return true;
  }
  if (raw === '0' || raw.toLowerCase() === 'false') {
    return false;
  }
  throw new ConfigError(`${key} 只接受 true/false/1/0，收到 ${raw}`);
}

/** `serve` 子命令的完整配置。 */
export type ServeConfig = {
  readonly databaseUrl: string;
  readonly httpHost: string;
  readonly httpPort: number;
  readonly metricsHost: string;
  readonly metricsPort: number;
  /** GitHub App 的 webhook secret；缺它 `/webhook` 无法验签，启动即失败。 */
  readonly webhookSecret: string;
  readonly bodyLimitBytes: number;
  readonly logLevel: string;
  readonly openapi: boolean;
  readonly migrationsDir: string;
};

/**
 * 只读数据库 DSN（`migrate` / `replay` 用）。
 *
 * 刻意单独一个函数：这两个子命令不需要 webhook secret，也不该因为 secret 没配就跑不起来。
 */
export function readDatabaseUrl(env: EnvLike): string {
  const url = readString(env, ENV_KEYS.databaseUrl);
  if (url === null) {
    throw new ConfigError(`缺少 ${ENV_KEYS.databaseUrl}（形如 postgres://user:pass@host:5432/db）`);
  }
  return url;
}

export function readServeConfig(env: EnvLike): ServeConfig {
  const databaseUrl = readDatabaseUrl(env);
  const webhookSecret = readString(env, ENV_KEYS.webhookSecret);
  if (webhookSecret === null) {
    throw new ConfigError(`缺少 ${ENV_KEYS.webhookSecret}：没有它就无法校验 GitHub 投递签名`);
  }
  return {
    databaseUrl,
    httpHost: readString(env, ENV_KEYS.httpHost) ?? DEFAULT_HTTP_HOST,
    httpPort: readInt(env, ENV_KEYS.httpPort, DEFAULT_HTTP_PORT, 0, 65_535),
    metricsHost: readString(env, ENV_KEYS.metricsHost) ?? DEFAULT_METRICS_HOST,
    metricsPort: readInt(env, ENV_KEYS.metricsPort, DEFAULT_METRICS_PORT, 0, 65_535),
    webhookSecret,
    bodyLimitBytes: readInt(
      env,
      ENV_KEYS.bodyLimitBytes,
      DEFAULT_BODY_LIMIT_BYTES,
      1024,
      100 * 1024 * 1024,
    ),
    logLevel: readString(env, ENV_KEYS.logLevel) ?? 'info',
    openapi: readBoolean(env, ENV_KEYS.openapi, false),
    migrationsDir: readString(env, ENV_KEYS.migrationsDir) ?? defaultMigrationsDir(),
  };
}

/**
 * 仓库根 `migrations/` 的绝对路径。
 *
 * 用 `import.meta.url` 而不是 `process.cwd()`：systemd unit 的 `WorkingDirectory` 不一定是仓库根，
 * 而 `pi-bot migrate` 找不到迁移目录时应当**确定地**失败，不该取决于从哪个目录启动。
 * 本文件在 `apps/server/src/config/`，向上四级即仓库根。
 */
export function defaultMigrationsDir(): string {
  return fileURLToPath(new URL('../../../../migrations/', import.meta.url));
}
