/**
 * 装配层配置（W4-P）：**环境变量 → `AppConfig`**，一处读取、一处校验。
 *
 * 与 `config/env.ts` 的分工（两者都只读 env，但服务不同对象）：
 *  - `config/env.ts` 是**接入层**（W2-G）的配置：HTTP/metrics/webhook secret/migrations；
 *  - 本文件是**装配层**（本切片）的配置：再加 pi-host bundle、worker 镜像、沙箱网络、
 *    job/cache 目录、dry-run 开关、GitHub 令牌。
 *
 * 为什么另起一份而不是扩 `config/env.ts`：那个文件归 W2-G 且被 http 面的单测逐条钉住
 * （`readServeConfig` 的字段顺序与默认值），扩它会连带改别人的测试。装配层的配置**只**被
 * `app/` 与 `cli.ts` 消费，放在自己这边，边界干净。
 *
 * 三条纪律：
 *  1. **不读硬编码路径**：所有路径来自 env（`PI_BOT_*`），缺省值只在注释里说明来源；
 *  2. **缺关键项在启动时炸**：`pgDsn` / `webhookSecret` 缺失直接抛 `ConfigError`（CLI 映射成
 *     用法错误码，而不是「起来了一半」）；
 *  3. **`describeAppConfig()` 只吐脱敏摘要**：secret / token 一律不出现在日志里（§10.2）。
 */
import { ConfigError, DEFAULT_BODY_LIMIT_BYTES, defaultMigrationsDir } from '../config/index.ts';
import type { EnvLike } from '../config/index.ts';

/** 环境变量名（`deploy/*.service` 的 `EnvironmentFile` 与这里逐字对应）。 */
export const APP_ENV_KEYS = {
  /** 主键：PG DSN（新名，优先） */
  pgDsn: 'PI_BOT_PG_DSN',
  /** 兼容 `config/env.ts` 的既有名字（`readServeConfig` 用它）；`PI_BOT_PG_DSN` 未设时回退 */
  databaseUrl: 'PI_BOT_DATABASE_URL',
  httpHost: 'PI_BOT_HTTP_HOST',
  /** 主键：HTTP 端口（新名，优先） */
  port: 'PI_BOT_PORT',
  httpPort: 'PI_BOT_HTTP_PORT',
  metricsHost: 'PI_BOT_METRICS_HOST',
  metricsPort: 'PI_BOT_METRICS_PORT',
  webhookSecret: 'PI_BOT_WEBHOOK_SECRET',
  bodyLimitBytes: 'PI_BOT_BODY_LIMIT_BYTES',
  logLevel: 'PI_BOT_LOG_LEVEL',
  openapi: 'PI_BOT_OPENAPI',
  migrationsDir: 'PI_BOT_MIGRATIONS_DIR',
  /** pi-host bundle 目录（`vendor/pi-host/<version>/`，内含 `bin/pi-host` 与 `PIN.json`） */
  hostBundleDir: 'PI_BOT_HOST_BUNDLE_DIR',
  /** pi-host 的 `--data-dir` */
  hostDataDir: 'PI_BOT_HOST_DATA_DIR',
  /** pi-host `--port`（0 = 随机） */
  hostPort: 'PI_BOT_HOST_PORT',
  /** 已配对的**设备令牌**（`pdt1.…`）。只在 bundle 存在时用得上。 */
  hostToken: 'PI_BOT_HOST_TOKEN',
  /** 数据目录（磁盘水位与 job 目录的父目录） */
  dataDir: 'PI_BOT_DATA_DIR',
  /** worker 镜像（`pi-worker:node22`） */
  workerImage: 'PI_BOT_WORKER_IMAGE',
  /** 沙箱网络模式（`pi-jobs`） */
  sandboxNetwork: 'PI_BOT_SANDBOX_NETWORK',
  /** worktree / job 目录根（每任务一棵树，目录名 = taskId） */
  jobRoot: 'PI_BOT_JOB_ROOT',
  /** clone 缓存根 */
  cacheRoot: 'PI_BOT_CACHE_ROOT',
  /** 是否允许 `push_branch` 动作（M4 之前应为 false） */
  allowPushBranch: 'PI_BOT_ALLOW_PUSH_BRANCH',
  /** 强制 dry-run（首周默认 true，plan §11 M1） */
  dryRun: 'PI_BOT_DRY_RUN',
  /** 新 issue 的「接管」评论开关（默认开；关掉就只在被 @ 时出声） */
  greet: 'PI_BOT_GREET',
  /** 纯 @ 提问（不带 `/命令`）的开关（默认开） */
  freeMention: 'PI_BOT_FREE_MENTION',
  /** 面板鉴权：`off`（直接放行，只用于 loopback）/ `session`（cookie 会话） */
  panelAuth: 'PI_BOT_PANEL_AUTH',
  /** GitHub token（只用于 webhook 的 10 秒应答；worker 的写面走 App 认证） */
  githubToken: 'PI_BOT_GITHUB_TOKEN',
  /** GitHub App ID（推荐认证方式；与 `PI_BOT_GITHUB_TOKEN` 二选一，App 优先） */
  githubAppId: 'PI_BOT_GITHUB_APP_ID',
  /** App 私钥文件路径（`.pem`，`0600`，只在 bot 进程可读） */
  githubAppPrivateKeyPath: 'PI_BOT_GITHUB_APP_PRIVATE_KEY_PATH',
  /** App 安装 ID（安装到账号/组织后由 GitHub 给出；没有它取不到 installation token） */
  githubInstallationId: 'PI_BOT_GITHUB_INSTALLATION_ID',
  /**
   * 评论里 @ 的句柄（GitHub App 的 slug）。文档 §6.4 只规定「`@机器人 /命令`」，
   * 而 slug 由 App 名字决定（本次是 `pi-issue-bot-tioit`），所以句柄必须是配置而不是字面量。
   */
  mention: 'PI_BOT_MENTION',
  /**
   * 模型 API key。**标准 OpenAI / DeepSeek / MiMo 兼容端点都能用**：
   * 我们自己这一份是 `PI_BOT_MODEL_API_KEY`，兼容别名 `OPENAI_API_KEY` / `DEEPSEEK_API_KEY`。
   */
  modelApiKey: 'PI_BOT_MODEL_API_KEY',
  openaiApiKey: 'OPENAI_API_KEY',
  deepseekApiKey: 'DEEPSEEK_API_KEY',
  /** 模型 base URL（形如 `https://api.openai.com/v1`、`https://api.deepseek.com/v1`）；别名 `OPENAI_BASE_URL` / `DEEPSEEK_BASE_URL` */
  modelBaseUrl: 'PI_BOT_MODEL_BASE_URL',
  openaiBaseUrl: 'OPENAI_BASE_URL',
  deepseekBaseUrl: 'DEEPSEEK_BASE_URL',
  /** 模型名（`gpt-4o-mini`、`deepseek-chat`、`mimo-…`）；兼容别名 `PI_BOT_MODEL` */
  modelName: 'PI_BOT_MODEL_NAME',
  modelNameAlias: 'PI_BOT_MODEL',
} as const;

/** 缺省值（来源写在注释里，不做路径推导）。 */
export const APP_DEFAULTS = {
  httpHost: '127.0.0.1',
  httpPort: 3000,
  metricsHost: '127.0.0.1',
  metricsPort: 9464,
  bodyLimitBytes: DEFAULT_BODY_LIMIT_BYTES,
  logLevel: 'info',
  hostPort: 0,
  workerImage: 'pi-worker:node22',
  sandboxNetwork: 'pi-jobs',
  /** plan §11：M1 首周强制干跑，因此**缺省 true**（要真写必须显式配 false） */
  dryRun: true,
  allowPushBranch: false,
  /** 新 issue 默认发「接管」评论：它同时也让 bot 进入该 thread 的参与者，@ 补全才看得到 */
  greet: true,
  /** 纯 @ 提问默认开：`@bot 这个问题怎么解？` 也会得到回答 */
  freeMention: true,
  /** 缺省句柄：App 名叫 `pi-bot` 的部署不用配 `PI_BOT_MENTION` */
  mention: 'pi-bot',
} as const;

export interface AppConfig {
  /** PG DSN（业务表 + pg-boss 同一个库、不同 schema） */
  readonly pgDsn: string;
  /** `migrations/` 目录；`serve` 只检查、`migrate` 才真跑 */
  readonly migrationsDir: string;
  readonly logLevel: string;
  /** 强制干跑：为真时 worker 一次 GitHub 写都不做（M0 的 ⛔ 项） */
  readonly dryRun: boolean;
  /** 新 issue 的「接管」评论（`PI_BOT_GREET`） */
  readonly greet: boolean;
  /** 纯 @ 提问（不带 `/命令`）也跑一次 turn（`PI_BOT_FREE_MENTION`） */
  readonly freeMention: boolean;
  /** 面板鉴权模式；缺省 loopback 上是 `off`，其它地址上是 `session` */
  readonly panelAuth: 'off' | 'session';
  readonly http: {
    readonly host: string;
    readonly port: number;
    readonly bodyLimitBytes: number;
    readonly openapi: boolean;
  };
  readonly metrics: {
    readonly host: string;
    readonly port: number;
  };
  readonly webhook: {
    readonly secret: string;
  };
  /**
   * GitHub 认证：**App 优先**（installation token，1 小时过期，权限可收窄），
   * 退回到一个静态 token（只建议本地调试/webhook 应答用）。
   */
  readonly github: {
    readonly token: string | null;
    /** App ID；`null` = 不用 App 认证 */
    readonly appId: number | null;
    /** 私钥 `.pem` 路径；`null` = 不读文件 */
    readonly privateKeyPath: string | null;
    /** 安装 ID；`null` = 还没装（此时 App 认证不可用，会 warn） */
    readonly installationId: number | null;
    /** 评论里 @ 的句柄（App slug）；默认 `pi-bot` */
    readonly mention: string;
  };
  /**
   * 模型端点（plan §4.4：模型请求由宿主代发，key 只在可信侧）。
   *
   * 这里只做**搬运与校验**，不实现任何 provider 客户端：pi-host 拿到这几个环境变量后按
   * 标准 OpenAI 兼容协议（`/chat/completions`、`/models`）说话，所以 OpenAI、DeepSeek、
   * MiMo 这类兼容端点共用一套配置，切换只改 base URL / model name。
   */
  readonly model: {
    /** `null` = 没配（本机 dry-run / 单测场景）；有值时 pi-host 才能真跑 turn */
    readonly apiKey: string | null;
    /** 已去掉尾部 `/`；`null` = 不覆盖 pi-host 的默认端点 */
    readonly baseUrl: string | null;
    /** `null` = 没配模型名（`doctor` 会 warn） */
    readonly name: string | null;
  };
  readonly host: {
    /** `null` = 不拉起 pi-host（本机没有 bundle）；装配层会换成「明确失败」的端口 */
    readonly bundleDir: string | null;
    readonly dataDir: string;
    readonly port: number;
    /** 设备令牌；`null` 时 RACP 连接会以可读错误失败（不是静默跳过） */
    readonly token: string | null;
  };
  readonly worker: {
    readonly image: string;
    readonly network: string;
    readonly jobRoot: string;
    readonly cacheRoot: string;
    readonly allowPushBranch: boolean;
  };
  /** 数据目录（磁盘水位检查的对象；也用作 job/cache 的缺省父目录） */
  readonly dataDir: string;
}

/* ── 读取原语 ─────────────────────────────────────────────────────────────── */

function readString(env: EnvLike, key: string): string | null {
  const raw = env[key];
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/** 多个别名取第一个有值的（`PI_BOT_PG_DSN` 优先于 `PI_BOT_DATABASE_URL`）。 */
function readFirst(env: EnvLike, keys: readonly string[]): { key: string; value: string } | null {
  for (const key of keys) {
    const value = readString(env, key);
    if (value !== null) {
      return { key, value };
    }
  }
  return null;
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

/** 可选整数：没配返回 `null`；配了但不是整数就报错（不静默当 0）。 */
function readOptionalInt(env: EnvLike, key: string, min: number): number | null {
  const raw = readString(env, key);
  if (raw === null) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) {
    throw new ConfigError(`${key} 必须是 ≥${String(min)} 的整数，收到 ${raw}`);
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
/**
 * 规范化模型 base URL：`https://api.deepseek.com/v1/` → `https://api.deepseek.com/v1`。
 *
 * 只做三件事：去掉尾部 `/`（否则拼出来是 `//models`）、拒绝非 http(s)、拒绝带 query/hash
 * （那说明用户把完整接口路径贴进来了，直接报错比悄悄 @ts-ignore 好）。
 * **不猜端点**：没配就返回 `null`，让 pi-host 用它自己的默认值。
 */
function normalizeModelBaseUrl(raw: string, key: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(`${key} 不是合法 URL：${raw}（形如 https://api.deepseek.com/v1）`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ConfigError(`${key} 只接受 http/https，收到 ${parsed.protocol}`);
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new ConfigError(`${key} 不应带查询串或锚点（填 base URL，不要填某个接口的完整路径）：${raw}`);
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/u, '');
}

/* ── 装配 ─────────────────────────────────────────────────────────────────── */

/**
 * 从 env 装配 `AppConfig`。缺关键项抛 `ConfigError`（CLI 捕获后以用法错误码退出）。
 *
 * 关键项只有两个：**PG DSN** 与 **webhook secret**。前者缺了整个进程没有状态，
 * 后者缺了 `/webhook` 无法验签（契约 §0.2：不设宽容模式，宁可起不来）。
 */
export function readAppConfig(env: EnvLike): AppConfig {
  const dsn = readFirst(env, [APP_ENV_KEYS.pgDsn, APP_ENV_KEYS.databaseUrl]);
  if (dsn === null) {
    throw new ConfigError(
      `缺少 ${APP_ENV_KEYS.pgDsn}（形如 postgres://user:pass@host:5432/db；兼容旧名 ${APP_ENV_KEYS.databaseUrl}）`,
    );
  }

  const webhookSecret = readString(env, APP_ENV_KEYS.webhookSecret);
  if (webhookSecret === null) {
    throw new ConfigError(`缺少 ${APP_ENV_KEYS.webhookSecret}：没有它就无法校验 GitHub 投递签名`);
  }

  const dataDir = readString(env, APP_ENV_KEYS.dataDir);
  if (dataDir === null) {
    throw new ConfigError(`缺少 ${APP_ENV_KEYS.dataDir}（数据目录：job 目录、clone 缓存、磁盘水位都在它下面）`);
  }

  // 模型端点：key 有三个别名（我们自己的 + OPENAI_ / DEEPSEEK_），先到先得。
  // 为什么允许别名：这台机器上别的工具（pi-host、各家 SDK）已经在读标准名，硬性要求改名
  // 只会让运维同时维护两套变量；别名让「标准 OpenAI / DeepSeek / MiMo 端点」开箱可用。
  const modelKey = readFirst(env, [
    APP_ENV_KEYS.modelApiKey,
    APP_ENV_KEYS.openaiApiKey,
    APP_ENV_KEYS.deepseekApiKey,
  ]);
  const modelBase = readFirst(env, [
    APP_ENV_KEYS.modelBaseUrl,
    APP_ENV_KEYS.openaiBaseUrl,
    APP_ENV_KEYS.deepseekBaseUrl,
  ]);
  const modelName = readFirst(env, [APP_ENV_KEYS.modelName, APP_ENV_KEYS.modelNameAlias]);

  // 配了 key 却没配模型名 → 启动就炸。理由：pi-host 每个 turn 都要模型名，
  // 让它到第一个任务才失败，等于把配置错误伪装成「任务失败」（plan §10 要求启动可判）。
  if (modelKey !== null && modelName === null) {
    throw new ConfigError(
      `配置了 ${modelKey.key} 但缺少 ${APP_ENV_KEYS.modelName}（例：deepseek-chat / gpt-4o-mini / mimo-…）`,
    );
  }
  const bundleDir = readString(env, APP_ENV_KEYS.hostBundleDir);
  const hostToken = readString(env, APP_ENV_KEYS.hostToken);
  // bundle 存在但没有设备令牌：**不在启动时炸**（配对是 `bootstrap-host` 的活，
  // 也判断不了这台机器究竟配过对没有）。到第一个任务的 RACP 连接处才以可读错误失败
  // （见 `app/racp.ts::createRacpChannelFactory`）。
  const jobRoot = readString(env, APP_ENV_KEYS.jobRoot);
  // 面板鉴权（`PI_BOT_PANEL_AUTH`）：`off` 直接放行、`session` 走 cookie 会话。
  // 缺省只在 **loopback** 上放行——监听在 127.0.0.1 时没有外部可达面，本地面板不必先登录。
  const httpHostForAuth = readString(env, APP_ENV_KEYS.httpHost) ?? APP_DEFAULTS.httpHost;
  const panelAuthValue = readString(env, APP_ENV_KEYS.panelAuth);
  const panelAuth: 'off' | 'session' =
    panelAuthValue === 'off' || panelAuthValue === 'session'
      ? panelAuthValue
      : /^(127\.|::1$|localhost$)/.test(httpHostForAuth)
        ? 'off'
        : 'session';

  return {
    pgDsn: dsn.value,
    migrationsDir: readString(env, APP_ENV_KEYS.migrationsDir) ?? defaultMigrationsDir(),
    logLevel: readString(env, APP_ENV_KEYS.logLevel) ?? APP_DEFAULTS.logLevel,
    dryRun: readBoolean(env, APP_ENV_KEYS.dryRun, APP_DEFAULTS.dryRun),
    greet: readBoolean(env, APP_ENV_KEYS.greet, APP_DEFAULTS.greet),
    freeMention: readBoolean(env, APP_ENV_KEYS.freeMention, APP_DEFAULTS.freeMention),
    panelAuth,
    http: {
      host: readString(env, APP_ENV_KEYS.httpHost) ?? APP_DEFAULTS.httpHost,
      // `PI_BOT_PORT`（新）优先，回退 `PI_BOT_HTTP_PORT`
      port: readInt(
        env,
        readString(env, APP_ENV_KEYS.port) === null ? APP_ENV_KEYS.httpPort : APP_ENV_KEYS.port,
        APP_DEFAULTS.httpPort,
        0,
        65_535,
      ),
      bodyLimitBytes: readInt(
        env,
        APP_ENV_KEYS.bodyLimitBytes,
        APP_DEFAULTS.bodyLimitBytes,
        1024,
        100 * 1024 * 1024,
      ),
      openapi: readBoolean(env, APP_ENV_KEYS.openapi, false),
    },
    metrics: {
      host: readString(env, APP_ENV_KEYS.metricsHost) ?? APP_DEFAULTS.metricsHost,
      port: readInt(env, APP_ENV_KEYS.metricsPort, APP_DEFAULTS.metricsPort, 0, 65_535),
    },
    webhook: { secret: webhookSecret },
    github: {
      token: readString(env, APP_ENV_KEYS.githubToken),
      appId: readOptionalInt(env, APP_ENV_KEYS.githubAppId, 1),
      privateKeyPath: readString(env, APP_ENV_KEYS.githubAppPrivateKeyPath),
      installationId: readOptionalInt(env, APP_ENV_KEYS.githubInstallationId, 1),
      mention: readString(env, APP_ENV_KEYS.mention) ?? APP_DEFAULTS.mention,
    },
    model: {
      apiKey: modelKey === null ? null : modelKey.value,
      baseUrl: modelBase === null ? null : normalizeModelBaseUrl(modelBase.value, modelBase.key),
      name: modelName === null ? null : modelName.value,
    },
    host: {
      bundleDir,
      dataDir: readString(env, APP_ENV_KEYS.hostDataDir) ?? `${dataDir}/host`,
      port: readInt(env, APP_ENV_KEYS.hostPort, APP_DEFAULTS.hostPort, 0, 65_535),
      token: hostToken,
    },
    worker: {
      image: readString(env, APP_ENV_KEYS.workerImage) ?? APP_DEFAULTS.workerImage,
      network: readString(env, APP_ENV_KEYS.sandboxNetwork) ?? APP_DEFAULTS.sandboxNetwork,
      // 缺省放在数据目录下面，而不是 `os.tmpdir()`：临时目录会被清理，worker 的 worktree 不能
      jobRoot: jobRoot ?? `${dataDir}/jobs`,
      cacheRoot: readString(env, APP_ENV_KEYS.cacheRoot) ?? `${dataDir}/cache`,
      allowPushBranch: readBoolean(env, APP_ENV_KEYS.allowPushBranch, APP_DEFAULTS.allowPushBranch),
    },
    dataDir,
  };
}

/** `readAppConfig` 的「进程环境」形态（CLI 入口用；测试直接传 `readAppConfig({...})`）。 */
export function readAppConfigFromProcess(): AppConfig {
  return readAppConfig(process.env as EnvLike);
}

/**
 * 脱敏摘要（进启动日志）。
 *
 * 只吐「能不能连、监听在哪、开关是开是关」：`webhookSecret` 与 `github.token` 的**存在性**
 * 可以出现（`configured: true`），值永远不出现（§10.2 值级脱敏的第一条）。
 */
export function describeAppConfig(config: AppConfig): Readonly<Record<string, unknown>> {
  return {
    pgDsn: redactDsn(config.pgDsn),
    http: `${config.http.host}:${String(config.http.port)}`,
    metrics: `${config.metrics.host}:${String(config.metrics.port)}`,
    dryRun: config.dryRun,
    allowPushBranch: config.worker.allowPushBranch,
    openapi: config.http.openapi,
    webhookSecretSet: true,
    // 只报「配没配」：`token` 这个键名会让日志门面的值级脱敏把整个对象抹掉，
    // 所以这里用 `*Configured` 命名（§10.2 要的是「值不出现」，不是「连状态都看不见」）
    githubTokenConfigured: config.github.token !== null,
    // App 认证只说「配没配 + App ID」，私钥路径不进日志（路径里常含机器名/用户名）。
    githubApp: {
      appId: config.github.appId,
      privateKeyConfigured: config.github.privateKeyPath !== null,
      installationId: config.github.installationId,
    },
    // 模型端点：base URL 与模型名可以出现（不是秘密），key 只报「配没配」。
    // 键名刻意不用 `apiKey`——日志门面的 `*.apiKey` 脱敏路径会把布尔值也抹成 `<redacted>`。
    model: {
      baseUrl: config.model.baseUrl,
      name: config.model.name,
      keyConfigured: config.model.apiKey !== null,
    },
    host: {
      bundleDir: config.host.bundleDir,
      dataDir: config.host.dataDir,
      deviceTokenConfigured: config.host.token !== null,
    },
    worker: { image: config.worker.image, network: config.worker.network },
  };
}

/** DSN 脱敏：保留协议/用户/主机/库名，抹掉口令。 */
export function redactDsn(dsn: string): string {
  try {
    const url = new URL(dsn);
    if (url.password !== '') {
      url.password = '***';
    }
    return url.toString();
  } catch {
    // 不是 URL 形态（例如 unix socket 的 key=value 串）：整体只报「已配置」
    return '<dsn 已配置>';
  }
}
