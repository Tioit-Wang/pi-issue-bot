/**
 * 装配层配置的单测：**缺关键项给出可读错误**、别名优先、脱敏不漏口令。
 *
 * 为什么这些值得单测：`readAppConfig` 是 `serve` 的第一道门。配置错时的报错质量，
 * 直接决定「凌晨两点是看一眼日志就懂，还是要翻代码」。
 */
import { describe, expect, it } from 'vitest';

import { ConfigError } from '../src/config/index.ts';
import { describeAppConfig, readAppConfig, redactDsn } from '../src/app/index.ts';

const base = {
  PI_BOT_PG_DSN: 'postgres://pi:secret@127.0.0.1:5432/pi_bot',
  PI_BOT_WEBHOOK_SECRET: 'whsec',
  PI_BOT_DATA_DIR: '/var/lib/pi-bot',
} as const;

describe('readAppConfig（env → AppConfig）', () => {
  it('完整 env：关键项读取正确，缺省值来自文档常量', () => {
    const config = readAppConfig({ ...base });

    expect(config.pgDsn).toBe(base.PI_BOT_PG_DSN);
    expect(config.webhook.secret).toBe('whsec');
    expect(config.http.host).toBe('127.0.0.1');
    expect(config.http.port).toBe(3000);
    expect(config.metrics.port).toBe(9464);
    // plan §11：M1 首周强制干跑 → 缺省 true
    expect(config.dryRun).toBe(true);
    expect(config.worker.allowPushBranch).toBe(false);
    // 缺省目录都挂在 dataDir 下面（不读硬编码路径）
    expect(config.worker.jobRoot.startsWith(config.dataDir)).toBe(true);
    expect(config.worker.cacheRoot.startsWith(config.dataDir)).toBe(true);
    // 没有 bundle → null（装配层据此换成「明确失败」的 host 端口）
    expect(config.host.bundleDir).toBeNull();
  });

  it('缺 PG DSN → ConfigError（且提示里点名变量）', () => {
    expect(() => readAppConfig({ PI_BOT_WEBHOOK_SECRET: 'x', PI_BOT_DATA_DIR: '/d' })).toThrow(
      ConfigError,
    );
    expect(() => readAppConfig({ PI_BOT_WEBHOOK_SECRET: 'x', PI_BOT_DATA_DIR: '/d' })).toThrow(
      /PI_BOT_PG_DSN/u,
    );
  });

  it('缺 webhook secret / 数据目录 → 各自点名', () => {
    expect(() => readAppConfig({ PI_BOT_PG_DSN: base.PI_BOT_PG_DSN, PI_BOT_DATA_DIR: '/d' })).toThrow(
      /PI_BOT_WEBHOOK_SECRET/u,
    );
    expect(() => readAppConfig({ PI_BOT_PG_DSN: base.PI_BOT_PG_DSN, PI_BOT_WEBHOOK_SECRET: 'x' })).toThrow(
      /PI_BOT_DATA_DIR/u,
    );
  });

  it('PI_BOT_PG_DSN 优先于旧名 PI_BOT_DATABASE_URL', () => {
    const config = readAppConfig({
      PI_BOT_DATABASE_URL: 'postgres://old/db',
      PI_BOT_PG_DSN: 'postgres://new/db',
      PI_BOT_WEBHOOK_SECRET: 'x',
      PI_BOT_DATA_DIR: '/d',
    });
    expect(config.pgDsn).toBe('postgres://new/db');
  });

  it('端口越界 / 布尔值非法 → ConfigError', () => {
    expect(() => readAppConfig({ ...base, PI_BOT_PORT: '70000' })).toThrow(/PI_BOT_PORT/u);
    expect(() => readAppConfig({ ...base, PI_BOT_DRY_RUN: 'maybe' })).toThrow(/PI_BOT_DRY_RUN/u);
  });

  it('PI_BOT_PORT 优先于 PI_BOT_HTTP_PORT（新名优先，旧名兼容）', () => {
    expect(readAppConfig({ ...base, PI_BOT_HTTP_PORT: '4000' }).http.port).toBe(4000);
    expect(readAppConfig({ ...base, PI_BOT_HTTP_PORT: '4000', PI_BOT_PORT: '0' }).http.port).toBe(0);
  });
});

describe('脱敏', () => {
  it('describeAppConfig：吐「配没配」，不吐任何令牌值', () => {
    const config = readAppConfig({
      ...base,
      PI_BOT_GITHUB_TOKEN: 'ghp_secret',
      PI_BOT_HOST_BUNDLE_DIR: '/opt/vendor/pi-host/0.21.0',
      PI_BOT_HOST_TOKEN: 'pdt1.secret',
    });
    const described = JSON.stringify(describeAppConfig(config));

    expect(described).not.toContain('ghp_secret');
    expect(described).not.toContain('pdt1.secret');
    expect(described).not.toContain('secret'); // 连 DSN 里的口令也不能出现
    expect(described).toContain('githubTokenConfigured');
    expect(described).toContain('deviceTokenConfigured');
  });

  it('redactDsn：保留主机与库名，抹掉口令', () => {
    const redacted = redactDsn('postgres://pi:secret@db.internal:5432/pi_bot');
    expect(redacted).toContain('db.internal');
    expect(redacted).toContain('pi_bot');
    expect(redacted).not.toContain('secret');
  });
});
