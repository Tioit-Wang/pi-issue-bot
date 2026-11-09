/**
 * `cli.ts` 执行通道（`runCli`）的测试。
 *
 * 为什么单独测「执行通道」而不是只测 `main()`：
 * `main()` 是同步解析通道（既有语义由 `test/cli.test.ts` 守住），真正跑子命令的是 `runCli()`。
 * 这里覆盖三件容易回归的事：
 *  1. 用法错误 / 缺参数的退出码
 *  2. `bootstrap-host` / `doctor` 的动态 import：模块缺失 → NOT_IMPLEMENTED（不假装成功）
 *  3. `migrate` 真的连真库执行（用**空迁移目录**验证「连得上、账本建得起来、结果打印得出来」，
 *     真正的 DDL 由 `db-migrate.test.ts` 与 `queries-*` 的建表流程覆盖）
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EXIT_FAILURE,
  EXIT_NOT_IMPLEMENTED,
  EXIT_OK,
  EXIT_USAGE,
  helpText,
  main,
  runWithDeadline,
  runCli,
} from '../src/cli.ts';
import type { ModuleLoader } from '../src/cli.ts';
import { testDsn } from './helpers/queries-db.ts';

type Captured = { readonly code: number; readonly stdout: string; readonly stderr: string };

async function capture(argv: readonly string[], options: { env?: Record<string, string>; moduleLoader?: ModuleLoader } = {}): Promise<Captured> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, {
    env: options.env ?? {},
    io: { out: (text) => stdout.push(text), err: (text) => stderr.push(text) },
    ...(options.moduleLoader === undefined ? {} : { moduleLoader: options.moduleLoader }),
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

/** 模拟「模块还没落地」：动态 import 抛错。 */
const missingModule: ModuleLoader = async (specifier) => {
  throw new Error(`Cannot find module '${specifier}'`);
};

let emptyMigrationsDir: string;

beforeAll(async () => {
  emptyMigrationsDir = await mkdtemp(join(tmpdir(), 'pi-bot-migrate-'));
});

afterAll(async () => {
  await rm(emptyMigrationsDir, { recursive: true, force: true });
});

describe('runCli：解析与退出码', () => {
  it('--help / --version 走解析通道，退出码 0', async () => {
    const help = await capture(['--help']);
    expect(help.code).toBe(EXIT_OK);
    expect(help.stdout).toContain('用法:');
    expect(help.stdout).toBe(helpText());

    const version = await capture(['--version']);
    expect(version.code).toBe(EXIT_OK);
    expect(version.stdout.trim()).not.toBe('');
  });

  it('缺命令 / 未知命令 → EXIT_USAGE（与 main() 一致）', async () => {
    expect((await capture([])).code).toBe(EXIT_USAGE);
    const unknown = await capture(['deploy-everything']);
    expect(unknown.code).toBe(EXIT_USAGE);
    expect(unknown.stderr).toContain('未知命令');
  });

  it('子命令带 --help 时只打印帮助（不执行）', async () => {
    const result = await capture(['replay', '--help']);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('用法:');
  });

  it('migrate 缺 DSN → EXIT_USAGE（配置错误，不是程序 bug）', async () => {
    const result = await capture(['migrate'], { env: {} });
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('配置错误');
    expect(result.stderr).toContain('PI_BOT_DATABASE_URL');
  });
});

describe('runCli replay', () => {
  it('缺 <delivery-id> → EXIT_USAGE 并打印用法', async () => {
    const result = await capture(['replay'], { env: { PI_BOT_DATABASE_URL: testDsn() } });
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('缺少 <delivery-id>');
  });

  it('投递不存在 → EXIT_FAILURE（不冒充 NOT_IMPLEMENTED）', async () => {
    const result = await capture(['replay', 'no-such-delivery'], {
      env: { PI_BOT_DATABASE_URL: testDsn() },
    });
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toContain('没有这条投递');
  });
});

describe('runCli migrate（真库）', () => {
  it('空迁移目录：连真库、建账本、打印 applied/skipped', async () => {
    const result = await capture(['migrate'], {
      env: { PI_BOT_DATABASE_URL: testDsn(), PI_BOT_MIGRATIONS_DIR: emptyMigrationsDir },
    });
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('applied: []');
    expect(result.stdout).toContain('skipped: [');
  });
});

describe('runCli bootstrap-host / doctor（动态 import）', () => {
  it('模块不存在 → EXIT_NOT_IMPLEMENTED', async () => {
    for (const command of ['bootstrap-host', 'doctor'] as const) {
      const result = await capture([command], { env: {}, moduleLoader: missingModule });
      expect(result.code, command).toBe(EXIT_NOT_IMPLEMENTED);
      expect(result.stderr).toContain('NOT_IMPLEMENTED');
    }
  });

  it('模块存在但没有导出约定的函数 → EXIT_NOT_IMPLEMENTED', async () => {
    const loader: ModuleLoader = async () => ({ somethingElse: 1 });
    const result = await capture(['doctor'], { env: {}, moduleLoader: loader });
    expect(result.code).toBe(EXIT_NOT_IMPLEMENTED);
    expect(result.stderr).toContain('runDoctor');
  });

  it('doctor 委派给 doctor/index.ts 的 runDoctor(options)', async () => {
    let received: unknown;
    const loader: ModuleLoader = async () => ({
      runDoctor: async (options: unknown) => {
        received = options;
        return { exitCode: 0 };
      },
    });
    const result = await capture(['doctor'], {
      env: { PI_BOT_DATABASE_URL: testDsn() },
      moduleLoader: loader,
    });
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('完成');
    expect(received).toMatchObject({ databaseUrl: testDsn() });
  });

  it('被委派的模块抛错 → EXIT_FAILURE', async () => {
    const loader: ModuleLoader = async () => ({
      bootstrapHost: async () => {
        throw new Error('PIN 校验失败');
      },
    });
    const result = await capture(['bootstrap-host'], { env: {}, moduleLoader: loader });
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toContain('PIN 校验失败');
  });
});

describe('runWithDeadline（优雅停机预算）', () => {
  it('按时完成返回 true，超时返回 false 并回调', async () => {
    expect(await runWithDeadline(Promise.resolve(), 50, () => undefined)).toBe(true);

    let timedOut = false;
    const slow = new Promise<void>((resolve) => {
      setTimeout(resolve, 200);
    });
    const ok = await runWithDeadline(slow, 20, () => {
      timedOut = true;
    });
    expect(ok).toBe(false);
    expect(timedOut).toBe(true);
  });
});

describe('main() 与 runCli() 的分工（防回归）', () => {
  it('main 仍是同步解析通道：子命令返回 NOT_IMPLEMENTED', () => {
    const code = main(['serve'], { out: () => undefined, err: () => undefined });
    expect(code).toBe(EXIT_NOT_IMPLEMENTED);
  });

  it('退出码常量互不相同', () => {
    expect(new Set([EXIT_OK, EXIT_USAGE, EXIT_NOT_IMPLEMENTED, EXIT_FAILURE]).size).toBe(4);
  });
});
