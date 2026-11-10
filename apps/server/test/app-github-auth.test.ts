/**
 * GitHub 认证装配：**App 优先 / token 兜底 / 半配置降级**。
 *
 * 为什么单测要覆盖「半配置」：App 认证要三件（appId + 私钥 + 安装 ID），少填一件是最常见的
 * 现场事故，而它的表征是「webhook 收到了、评论发不出去」——没有这条断言就只能靠猜。
 */
import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ConfigError } from '../src/config/index.ts';
import { describeAppConfig, readAppConfig, resolveGithubAuth } from '../src/app/index.ts';

const base = {
  PI_BOT_PG_DSN: 'postgres://pi:secret@127.0.0.1:5432/pi_bot',
  PI_BOT_WEBHOOK_SECRET: 'whsec',
  PI_BOT_DATA_DIR: '/var/lib/pi-bot',
} as const;

// 用**真** RSA 私钥：@octokit/auth-app 在构造时就会解析 PEM，假字符串会抛
// `ERR_OSSL_UNSUPPORTED` 并变成 unhandled rejection（本单测第一版就踩过）。
const { privateKey: realPem } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const fakePem = realPem.export({ type: 'pkcs1', format: 'pem' }).toString();
const readPem = (): string => fakePem;

describe('readAppConfig：GitHub App 三件套', () => {
  it('appId / 私钥路径 / 安装 ID 都按整数与字符串读入', () => {
    const config = readAppConfig({
      ...base,
      PI_BOT_GITHUB_APP_ID: '5690173',
      PI_BOT_GITHUB_APP_PRIVATE_KEY_PATH: '/etc/pi-bot/app.pem',
      PI_BOT_GITHUB_INSTALLATION_ID: '88',
    });
    expect(config.github.appId).toBe(5690173);
    expect(config.github.privateKeyPath).toBe('/etc/pi-bot/app.pem');
    expect(config.github.installationId).toBe(88);
  });

  it('appId 不是整数 → ConfigError（不静默当 0）', () => {
    expect(() => readAppConfig({ ...base, PI_BOT_GITHUB_APP_ID: 'abc' })).toThrow(ConfigError);
    expect(() => readAppConfig({ ...base, PI_BOT_GITHUB_APP_ID: '0' })).toThrow(ConfigError);
  });
});

describe('resolveGithubAuth', () => {
  it('三件套齐全 → App 认证，私钥只读一次', () => {
    let reads = 0;
    const config = readAppConfig({
      ...base,
      PI_BOT_GITHUB_APP_ID: '5690173',
      PI_BOT_GITHUB_APP_PRIVATE_KEY_PATH: '/etc/pi-bot/app.pem',
      PI_BOT_GITHUB_INSTALLATION_ID: '88',
    });

    const resolution = resolveGithubAuth(config, {
      readFile: () => {
        reads += 1;
        return fakePem;
      },
    });

    expect(resolution.mode).toBe('app');
    expect(resolution.client).not.toBeNull();
    expect(resolution.detail).toContain('5690173');
    expect(resolution.detail).toContain('88');
    expect(reads).toBe(1);
    expect(resolution.detail).not.toContain('PRIVATE KEY');
  });

  it('缺安装 ID → degraded 且点名缺哪个变量（不静默退回未认证）', () => {
    const config = readAppConfig({
      ...base,
      PI_BOT_GITHUB_APP_ID: '5690173',
      PI_BOT_GITHUB_APP_PRIVATE_KEY_PATH: '/etc/pi-bot/app.pem',
    });

    const resolution = resolveGithubAuth(config, { readFile: readPem });
    expect(resolution.mode).toBe('degraded');
    expect(resolution.client).toBeNull();
    expect(resolution.detail).toContain('PI_BOT_GITHUB_INSTALLATION_ID');
  });

  it('只给了 appId → degraded 且点名缺私钥路径', () => {
    const config = readAppConfig({ ...base, PI_BOT_GITHUB_APP_ID: '5690173' });
    const resolution = resolveGithubAuth(config, { readFile: readPem });
    expect(resolution.mode).toBe('degraded');
    expect(resolution.detail).toContain('缺私钥路径');
  });

  it('有静态 token → token 模式', () => {
    const config = readAppConfig({ ...base, PI_BOT_GITHUB_TOKEN: 'ghs_fake' });
    const resolution = resolveGithubAuth(config, { readFile: readPem });
    expect(resolution.mode).toBe('token');
    expect(resolution.client).not.toBeNull();
  });

  it('什么都没配 → none（dry-run 合法）', () => {
    const resolution = resolveGithubAuth(readAppConfig({ ...base }), { readFile: readPem });
    expect(resolution.mode).toBe('none');
    expect(resolution.client).toBeNull();
    expect(resolution.detail).toContain('dry-run');
  });

  it('私钥读不到 / 不像 PEM → 启动期 ConfigError', () => {
    const config = readAppConfig({
      ...base,
      PI_BOT_GITHUB_APP_ID: '5690173',
      PI_BOT_GITHUB_APP_PRIVATE_KEY_PATH: '/missing.pem',
      PI_BOT_GITHUB_INSTALLATION_ID: '88',
    });

    expect(() =>
      resolveGithubAuth(config, {
        readFile: () => {
          throw new Error('ENOENT');
        },
      }),
    ).toThrow(/读不到 GitHub App 私钥/u);

    expect(() => resolveGithubAuth(config, { readFile: () => 'not a pem' })).toThrow(/不像 PEM/u);
  });

  it('脱敏摘要里不出现私钥路径（路径常含用户名/机器名）', () => {
    const config = readAppConfig({
      ...base,
      PI_BOT_GITHUB_APP_ID: '5690173',
      PI_BOT_GITHUB_APP_PRIVATE_KEY_PATH: '/home/alice/private/app.pem',
      PI_BOT_GITHUB_INSTALLATION_ID: '88',
    });
    const text = JSON.stringify(describeAppConfig(config));
    expect(text).not.toContain('/home/alice');
    expect(text).toContain('5690173');
  });
});
