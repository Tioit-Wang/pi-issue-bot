/**
 * GitHub App 认证封装（B12；tech-plan §5.1、§5.2）。
 *
 * 三个官方库里的一个：`@octokit/auth-app`。它负责
 *   App JWT（RS256，由私钥签）→ `POST /app/installations/{id}/access_tokens` → installation token，
 * 并在库内部缓存、到期前自动续期。
 *
 * 本文件的硬约束（tech-plan §5.2 最后一段）：
 *  - **令牌只在内存**：不出现在返回值以外的任何地方——不落盘、不进日志、不进错误信息；
 *  - 缓存也在内存：`createInstallationTokenProvider()` 的 Map 随进程消失；
 *  - 私钥同样只在内存，且校验失败时**不回显私钥内容**。
 *
 * 为什么不用 Probot（tech-plan §5.1）：Probot 把「验签 + 路由 + 事件处理」绑成一个 Express 生命周期，
 * 而我们要的是「验签后 10 秒返回 200、立刻入队」。这里只取它底层的 auth，不要它的框架。
 */
import { createAppAuth } from '@octokit/auth-app';
import { authConfigError } from './errors.ts';

/** App 凭证（`appId` 来自 App 设置页，`privateKey` 是 PEM 文本）。 */
export type AppCredentials = {
  readonly appId: number | string;
  readonly privateKey: string;
};

/** 取到的 installation token（`expiresAt` 是 GitHub 给的 ISO 时间串，1 小时）。 */
export type InstallationToken = {
  readonly token: string;
  readonly expiresAt: string;
  readonly installationId: number | null;
};

/** `getToken()` 的可选参数：显式指定安装，或强制刷新（`refresh: true`）。 */
export type InstallationTokenRequest = {
  readonly installationId?: number | string;
  readonly refresh?: boolean;
};

/** 窄接口：本层只暴露「取 installation token」，其余一概不泄漏。 */
export type InstallationTokenProvider = {
  getToken(request?: InstallationTokenRequest): Promise<InstallationToken>;
  /** 丢掉内存缓存（测试与「换安装」时用）；不会调用任何网络接口。 */
  clearCache(): void;
  /** 可直接塞进 Octokit 的 `authStrategy`（同一个凭证，缓存由 @octokit/auth-app 负责）。 */
  readonly authStrategy: AuthStrategyLike;
};

/**
 * `@octokit/auth-app` 的调用面：`strategy({ type: 'installation', installationId })`。
 *
 * 用自定义类型而不是它的 `AuthInterface`：重载签名带 6 个分支，注入假实现时没必要伪造全部。
 * 真实类型只在下面 `defaultCreateAppAuth` 一处做断言。
 */
export type AuthStrategyLike = (options: AuthStrategyRequest) => Promise<unknown>;

/** 我们只用到的两种请求。 */
export type AuthStrategyRequest =
  | { readonly type: 'app' }
  | {
      readonly type: 'installation';
      readonly installationId?: number | string;
      readonly refresh?: boolean;
    };

/** 建 strategy 的工厂（注入点：测试用假工厂，绝不打网络）。 */
export type CreateAppAuthFactory = (options: Readonly<Record<string, unknown>>) => AuthStrategyLike;

const defaultCreateAppAuth: CreateAppAuthFactory = createAppAuth as unknown as CreateAppAuthFactory;

/** 提前多久认为令牌过期（避免「刚拿到就过期」的竞态）。 */
export const DEFAULT_TOKEN_TTL_SKEW_MS = 60_000;

/** 解析不出 `expiresAt` 时的保守假设：GitHub 的 installation token 是 1 小时。 */
const ASSUMED_TOKEN_LIFETIME_MS = 50 * 60_000;

const PEM_PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PEM_PRIVATE_KEY_END_PATTERN = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

/**
 * 校验 App 凭证。只检查形状，不发请求。
 *
 * 失败时抛出的是 `auth` 类 `GithubError`，message 里**只有字段名与原因**，不含私钥片段。
 */
export function assertAppCredentials(credentials: AppCredentials): void {
  const appId = credentials.appId;
  if (typeof appId === 'number') {
    if (!Number.isInteger(appId) || appId <= 0) {
      throw authConfigError('GitHub App 的 appId 必须是正整数');
    }
  } else if (appId.trim() === '' || !/^\d+$/.test(appId.trim())) {
    throw authConfigError('GitHub App 的 appId 必须是正整数（字符串形式也只允许数字）');
  }

  const privateKey = credentials.privateKey;
  if (privateKey.trim() === '') {
    throw authConfigError('GitHub App 的 privateKey 为空');
  }
  if (!PEM_PRIVATE_KEY_PATTERN.test(privateKey) || !PEM_PRIVATE_KEY_END_PATTERN.test(privateKey)) {
    throw authConfigError('GitHub App 的 privateKey 不是 PEM 私钥（缺少 BEGIN/END 头）');
  }
}

/**
 * 建一个 `@octokit/auth-app` strategy。
 *
 * Octokit 的 `authStrategy` 选项就吃这个函数：传进 `new Octokit({ authStrategy })` 后，
 * 每次请求由它自动挂 `Authorization` 并在 1 小时过期前续期——**我们不做令牌传递**，
 * 也就不存在把令牌写进日志或磁盘的路径。
 */
export function createAppAuthStrategy(config: {
  readonly credentials: AppCredentials;
  readonly installationId?: number | string | undefined;
  readonly createAppAuthImpl?: CreateAppAuthFactory | undefined;
}): AuthStrategyLike {
  assertAppCredentials(config.credentials);
  const factory = config.createAppAuthImpl ?? defaultCreateAppAuth;

  const options: Record<string, unknown> = {
    appId: config.credentials.appId,
    privateKey: config.credentials.privateKey,
  };
  if (config.installationId !== undefined) {
    options['installationId'] = config.installationId;
  }

  // 注意：这里故意不传 `log`，也绝不在自己这层打印任何东西——
  // @octokit/auth-app 的默认 log 只 warn，且不会打印令牌。
  return factory(options);
}

/**
 * 内存缓存的 installation token 提供者。
 *
 * 用哪一层缓存：`@octokit/auth-app` 自带缓存（按 installationId 缓存到过期前 1 分钟）。
 * 这里再包一层是为了让「本层的窄接口」也能给非 Octokit 场景（比如 `git push` 的
 * `GIT_ASKPASS`）供令牌，同时保证**缓存只在进程内存**。
 */
export function createInstallationTokenProvider(config: {
  readonly credentials: AppCredentials;
  readonly installationId?: number | string | undefined;
  readonly createAppAuthImpl?: CreateAppAuthFactory | undefined;
  readonly now?: (() => number) | undefined;
  readonly ttlSkewMs?: number | undefined;
}): InstallationTokenProvider {
  const now = config.now ?? Date.now;
  const ttlSkewMs = config.ttlSkewMs ?? DEFAULT_TOKEN_TTL_SKEW_MS;
  const authStrategy = createAppAuthStrategy({
    credentials: config.credentials,
    ...(config.installationId === undefined ? {} : { installationId: config.installationId }),
    ...(config.createAppAuthImpl === undefined
      ? {}
      : { createAppAuthImpl: config.createAppAuthImpl }),
  });

  const cache = new Map<string, { readonly token: InstallationToken; readonly expiresAtMs: number }>();

  const resolveInstallationId = (explicit: number | string | undefined): number => {
    const raw = explicit ?? config.installationId;
    if (raw === undefined) {
      throw authConfigError('未指定 installationId：App 安装层级未知，无法取 installation token');
    }
    const numeric = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
    if (!Number.isInteger(numeric) || numeric <= 0) {
      throw authConfigError('installationId 必须是正整数');
    }
    return numeric;
  };

  const getToken = async (request?: InstallationTokenRequest): Promise<InstallationToken> => {
    const installationId = resolveInstallationId(request?.installationId);
    const key = String(installationId);
    const refresh = request?.refresh === true;

    if (!refresh) {
      const cached = cache.get(key);
      if (cached !== undefined && now() < cached.expiresAtMs - ttlSkewMs) {
        return cached.token;
      }
    } else {
      cache.delete(key);
    }

    const result = await authStrategy({
      type: 'installation',
      installationId,
      ...(refresh ? { refresh: true } : {}),
    });

    const token = parseInstallationAuthentication(result, installationId, now());
    cache.set(key, {
      token,
      expiresAtMs: token.expiresAt === '' ? now() + ASSUMED_TOKEN_LIFETIME_MS : Date.parse(token.expiresAt),
    });
    return token;
  };

  return {
    getToken,
    clearCache: () => {
      cache.clear();
    },
    authStrategy,
  };
}

/**
 * 从 `@octokit/auth-app` 的返回值里取 `token` / `expiresAt`。
 *
 * 解析失败时**不把原始返回值放进错误信息**——里面就是令牌本身。
 */
function parseInstallationAuthentication(
  result: unknown,
  installationId: number,
  now: number,
): InstallationToken {
  if (typeof result !== 'object' || result === null) {
    throw authConfigError(
      `installation ${String(installationId)} 的 auth 策略返回了非对象结果，无法取令牌`,
    );
  }
  const record = result as Record<string, unknown>;
  const token = record['token'];
  if (typeof token !== 'string' || token === '') {
    throw authConfigError(
      `installation ${String(installationId)} 的 auth 策略返回里没有 token 字段`,
    );
  }
  const rawExpiresAt = record['expiresAt'];
  const expiresAt =
    typeof rawExpiresAt === 'string' && !Number.isNaN(Date.parse(rawExpiresAt))
      ? rawExpiresAt
      : new Date(now + ASSUMED_TOKEN_LIFETIME_MS).toISOString();

  return { token, expiresAt, installationId };
}
