/**
 * `readDatabaseUrl` 的别名行为（实测踩坑回归）：
 *
 * `serve` 走 `app/config.ts`（优先 `PI_BOT_PG_DSN`），而 `migrate` / `replay` 走这里。
 * 两边只认同一个名字之前，按 README 只设新名会出现「服务能起、迁移报缺变量」——
 * 这条断言就是防止它再退化。
 */
import { describe, expect, it } from 'vitest';

import { ConfigError, readDatabaseUrl } from '../src/config/index.ts';

const dsn = 'postgres://pi:secret@127.0.0.1:5432/pi_bot';

describe('readDatabaseUrl', () => {
  it('只设 PI_BOT_PG_DSN（新名）即可', () => {
    expect(readDatabaseUrl({ PI_BOT_PG_DSN: dsn })).toBe(dsn);
  });

  it('只设 PI_BOT_DATABASE_URL（旧名）仍然可用', () => {
    expect(readDatabaseUrl({ PI_BOT_DATABASE_URL: dsn })).toBe(dsn);
  });

  it('两个都设时新名优先（与 app/config.ts 一致）', () => {
    expect(
      readDatabaseUrl({ PI_BOT_PG_DSN: dsn, PI_BOT_DATABASE_URL: 'postgres://old@127.0.0.1/old' }),
    ).toBe(dsn);
  });

  it('空字符串视为未配置', () => {
    expect(() => readDatabaseUrl({ PI_BOT_PG_DSN: '   ' })).toThrow(ConfigError);
  });

  it('都没设 → ConfigError，提示里同时给出两个变量名', () => {
    const message = String((() => {
      try {
        readDatabaseUrl({});
        return '';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })());
    expect(message).toContain('PI_BOT_PG_DSN');
    expect(message).toContain('PI_BOT_DATABASE_URL');
  });
});
