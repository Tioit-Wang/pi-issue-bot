/**
 * GitHub 认证解析（装配层）：**App 优先，静态 token 兜底**。
 *
 * 为什么要单独一层：`github/auth.ts` 只懂「给 appId + 私钥，换 installation token」，
 * 它不读文件、不读配置；而「这次启动到底用哪种认证、缺什么」是装配层的判断题。放在这里的好处：
 *  - 私钥文件只在启动时读一次（不进每次请求路径）；
 *  - 缺 `PI_BOT_GITHUB_INSTALLATION_ID` 这类半配置状态，能给出可读的 `detail` 而不是 500；
 *  - 单测可以注入 `readFile`，不碰真文件与真网络。
 *
 * 优先级：`appId + privateKeyPath + installationId` 三者齐全 → App 认证；
 * 只给了 App 的一部分 → 记 `degraded` 并说明缺哪项（不静默退化成未认证）；
 * 否则有 `PI_BOT_GITHUB_TOKEN` → token 认证；都没有 → `none`（dry-run 合法）。
 */
import { readFileSync } from 'node:fs';

import { createGithubClient, createInstallationTokenProvider } from '../github/index.ts';
import type { GithubClient } from '../github/index.ts';
import { ConfigError } from '../config/index.ts';
import type { AppConfig } from './config.ts';

export type GithubAuthMode = 'app' | 'token' | 'none' | 'degraded';

export type GithubAuthResolution = {
  readonly mode: GithubAuthMode;
  readonly client: GithubClient | null;
  /** 给人看的一句话（进启动日志；不含密钥）。 */
  readonly detail: string;
};

export type GithubAuthDeps = {
  /** 注入用（测试不读真文件）。 */
  readonly readFile?: (path: string) => string;
};

/** 只做 PEM 形状校验：读不到/不像私钥 → 直接 `ConfigError`（启动期炸，别等第一个请求）。 */
function readPrivateKey(path: string, readFile: (p: string) => string): string {
  let pem: string;
  try {
    pem = readFile(path);
  } catch (error) {
    throw new ConfigError(
      `读不到 GitHub App 私钥（${path}）：${error instanceof Error ? error.message : String(error)}；` +
        '确认文件存在、属主是运行用户、权限 0600',
    );
  }
  if (!pem.includes('PRIVATE KEY-----')) {
    throw new ConfigError(`GitHub App 私钥文件不像 PEM（${path}）：应以 "-----BEGIN ... PRIVATE KEY-----" 开头`);
  }
  return pem;
}

export function resolveGithubAuth(config: AppConfig, deps: GithubAuthDeps = {}): GithubAuthResolution {
  const { token, appId, privateKeyPath, installationId } = config.github;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));

  if (appId !== null && privateKeyPath !== null) {
    if (installationId === null) {
      return {
        mode: 'degraded',
        client: null,
        detail:
          `GitHub App ${String(appId)} 已配私钥，但缺 PI_BOT_GITHUB_INSTALLATION_ID：` +
          '先在 GitHub 上把 App 安装到一个账号/仓库，然后把安装 ID 填进 env（否则取不到 installation token）',
      };
    }

    const privateKey = readPrivateKey(privateKeyPath, readFile);
    // 认证走「每次请求前取令牌」：`createInstallationTokenProvider` 内部缓存并按过期前
    // 1 分钟续期，我们只把令牌挂到 `Authorization` 上，请求语义与 `auth: token` 完全一致。
    //
    // 为什么不用 `@octokit/auth-app` 的 authStrategy：两条路都踩过坑——传实例是
    // `Invalid auth type: undefined`；传工厂则是它的 request 包装把 route 参数误当 body，
    // 打标直接 422 `issue_number, owner, repo are not permitted keys`（2026-11-10 实测）。
    const provider = createInstallationTokenProvider({
      credentials: { appId, privateKey },
      installationId,
    });

    return {
      mode: 'app',
      client: createGithubClient({ authTokenProvider: async () => (await provider.getToken()).token }),
      detail: `GitHub App 认证（appId=${String(appId)}，installationId=${String(installationId)}）`,
    };
  }

  if (appId !== null || privateKeyPath !== null) {
    return {
      mode: 'degraded',
      client: token === null ? null : createGithubClient({ authToken: token }),
      detail:
        'App 认证只配了一半（需要 PI_BOT_GITHUB_APP_ID 与 PI_BOT_GITHUB_APP_PRIVATE_KEY_PATH 同时给）：' +
        (appId === null ? '缺 appId；' : '') +
        (privateKeyPath === null ? '缺私钥路径；' : '') +
        (token === null ? '当前没有可用的 GitHub 客户端' : '暂用 PI_BOT_GITHUB_TOKEN 兜底'),
    };
  }

  if (token !== null) {
    return {
      mode: 'token',
      client: createGithubClient({ authToken: token }),
      detail: '静态 token 认证（PI_BOT_GITHUB_TOKEN）',
    };
  }

  return {
    mode: 'none',
    client: null,
    detail: '未配置 GitHub 认证：webhook 仍可验签与去重，但 10 秒应答与所有写操作都不可用（dry-run 合法）',
  };
}
