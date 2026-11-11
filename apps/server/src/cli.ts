/**
 * pi-bot 单一 CLI 入口（骨架阶段）。
 *
 * 设计边界（本文件属于 S3 骨架 session，后续 session 只在此追加子命令实现）：
 *  - 只做参数解析 + `--help`；五个子命令全部返回 NOT_IMPLEMENTED（退出码 2）。
 *  - 子命令清单与语义见 docs/tech-plan.md §8.4。
 *  - 运行方式（见 docs/spec/dev-setup.md）：
 *      pnpm --filter @pi-issue-bot/server cli -- --help
 *      pnpm cli -- --help                       # 根目录等价写法（tsx）
 *      node --experimental-strip-types apps/server/src/cli.ts --help
 *    本文件只用「可被 Node 直接擦除类型」的 TS 语法，因此两条路径都能跑。
 *
 * ── W2-G 追加的实现（B10）──────────────────────────────────────────────────
 * 两个通道，职责分开：
 *  - `main()`：**同步**的参数解析通道。它保留原有语义（`--help` / `--version` / 用法错误 /
 *    子命令返回 NOT_IMPLEMENTED），既有单测 `test/cli.test.ts` 依赖它，不改。
 *  - `runCli()`：**异步**的执行通道，真正跑 `serve` / `migrate` / `replay` / `bootstrap-host` /
 *    `doctor`。直接调用本文件（`pi-bot ...`）走的就是它。
 *
 * 为什么拆两个：解析是纯函数（可测、无 IO），执行要连库/连队列/等信号（不可同步返回）。
 * 把两者塞进同一个返回值类型只会让 `main()` 变成 `number | Promise<number>`，
 * 既破坏既有调用点，也让退出码语义模糊。
 */
import { pathToFileURL } from 'node:url';
import { readFile as readFileBytes } from 'node:fs/promises';
import { createLogger } from '../../../packages/shared/src/index.ts';
import type { Logger } from '../../../packages/shared/src/index.ts';
import { createApplication, createUnavailableWebhookAck, readAppConfig } from './app/index.ts';
import type { AppConfig, Application } from './app/index.ts';
import { closePool, createPool, migrate } from './db/index.ts';
import { ConfigError, readDatabaseUrl, readServeConfig } from './config/env.ts';
import type { EnvLike } from './config/env.ts';
import { createQueueEnqueuer, replayDelivery } from './http/index.ts';
import type { WebhookAck } from './http/index.ts';
import { bootstrapQueue, createBoss, startBoss, stopBoss } from './queue/index.ts';

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_NOT_IMPLEMENTED = 2;
/** 第 4 个码：能解析但执行失败（连不上库、找不到投递、迁移失败……）。 */
export const EXIT_FAILURE = 3;

/** 优雅停机的总预算（tech-plan §3.4：SIGTERM 后 90s 内必须退出）。 */
export const SHUTDOWN_TIMEOUT_MS = 90_000;

export type CommandName = 'serve' | 'doctor' | 'bootstrap-host' | 'replay' | 'migrate';

export type CommandSpec = {
  readonly name: CommandName;
  readonly usage: string;
  readonly summary: string;
};

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'serve',
    usage: 'serve',
    summary: 'HTTP + worker 同进程启动控制面（默认形态，tech-plan §8.4）',
  },
  {
    name: 'doctor',
    usage: 'doctor',
    summary: '启动前预检：docker、网络隔离、磁盘水位、pi-host 版本（tech-plan §6.4）',
  },
  {
    name: 'bootstrap-host',
    usage: 'bootstrap-host',
    summary: '首次与 pi-host 配对，落设备令牌（tech-plan §4.2）',
  },
  {
    name: 'replay',
    usage: 'replay <delivery-id>',
    summary: '用 webhook_deliveries 的原文重放一次投递，强制 dry-run（tech-plan §8.4）',
  },
  {
    name: 'migrate',
    usage: 'migrate',
    summary: '跑 migrations/ 下的 drizzle 迁移（tech-plan §8.4）',
  },
];

const CLI_NAME = 'pi-bot';
const VERSION = '0.0.0-skeleton';

/** CLI 的输出通道；抽出来是为了测试可以拦截，不必 patch process。 */
export type CliIo = {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
};

export const processIo: CliIo = {
  out: (text: string): void => {
    process.stdout.write(text);
  },
  err: (text: string): void => {
    process.stderr.write(text);
  },
};

export function helpText(): string {
  const commandLines = COMMANDS.map((command) => `  ${command.usage.padEnd(24)}${command.summary}`);
  return [
    `${CLI_NAME} ${VERSION} — pi-issue-bot 控制面命令行`,
    '',
    `用法: ${CLI_NAME} <命令> [选项]`,
    '',
    '命令:',
    ...commandLines,
    '',
    '全局选项:',
    '  -h, --help       打印本帮助并以 0 退出',
    '  -v, --version    打印版本并以 0 退出',
    `不带命令时打印本帮助并以 ${EXIT_USAGE} 退出。`,
    '',
    '退出码:',
    `  ${EXIT_OK}  成功（--help / --version / 子命令执行成功）`,
    `  ${EXIT_USAGE}  用法错误（缺少命令、未知命令、缺少必需参数）`,
    `  ${EXIT_NOT_IMPLEMENTED}  NOT_IMPLEMENTED（子命令依赖的模块尚未落地，例如 doctor/、runtime/bootstrap.ts）`,
    `  ${EXIT_FAILURE}  执行失败（连不上库、投递不存在、迁移报错……）`,
    '',
  ].join('\n');
}

/**
 * 同步解析通道。**保持既有语义**：`test/cli.test.ts` 里逐条断言了它的返回值，
 * 真正的执行在 `runCli()`。参数解析与执行分离的理由见文件头。
 */
export function main(argv: readonly string[], io: CliIo = processIo): number {
  const head = argv[0];

  if (head === undefined) {
    io.err(`${CLI_NAME}: 缺少命令\n\n${helpText()}`);
    return EXIT_USAGE;
  }

  if (head === '-h' || head === '--help' || head === 'help') {
    io.out(helpText());
    return EXIT_OK;
  }

  if (head === '-v' || head === '--version' || head === 'version') {
    io.out(`${VERSION}\n`);
    return EXIT_OK;
  }

  const command = COMMANDS.find((candidate) => candidate.name === head);
  if (command === undefined) {
    io.err(`${CLI_NAME}: 未知命令 "${head}"\n\n${helpText()}`);
    return EXIT_USAGE;
  }

  if (argv.slice(1).some((token) => token === '-h' || token === '--help')) {
    io.out(helpText());
    return EXIT_OK;
  }

  io.err(
    `${CLI_NAME} ${command.name}: NOT_IMPLEMENTED\n` +
      `  这里只是**同步解析**通道；实际执行走 runCli()（直接运行本文件时自动使用）。\n` +
      `  期望行为（tech-plan §8.4）：${command.summary}\n`,
  );
  return EXIT_NOT_IMPLEMENTED;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 执行通道（W2-G）
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 子命令拿到的运行时上下文：env 与 io 都可注入（测试不碰 process）。 */
export type CommandRuntime = {
  readonly env: EnvLike;
  readonly io: CliIo;
  readonly now: () => Date;
};

/** 动态 import 的注入点：测试用它模拟「模块还没落地」。 */
export type ModuleLoader = (specifier: string) => Promise<Record<string, unknown>>;

const defaultModuleLoader: ModuleLoader = async (specifier) =>
  (await import(specifier)) as Record<string, unknown>;

export type RunCliOptions = {
  readonly env?: EnvLike;
  readonly io?: CliIo;
  readonly now?: () => Date;
  readonly moduleLoader?: ModuleLoader;
  /**
   * `serve` 的装配注入点：测试用它把 docker / pi-host / GitHub 全换成假件
   * （`test/app-lifecycle.test.ts` 用这条路径验「不连真 docker、不连真 host 也能跑起来」）。
   */
  readonly appFactory?: (config: AppConfig) => Application;
  /** `serve` 等信号的方式（测试直接 resolve，不必真发 SIGTERM）。 */
  readonly waitSignal?: () => Promise<NodeJS.Signals>;
};

/** `serve` 的装配注入点类型（`createApplication` 的形状）。 */
export type ServeAppFactory = (config: AppConfig) => Application;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 没有 GitHub 凭证时的 ack：明确报错，让 webhook handler 记 warn 并继续回 200。 */
export const createUnavailableAck: (reason: string) => WebhookAck = createUnavailableWebhookAck;

/**
 * 等 SIGTERM / SIGINT（优雅停机的触发点）。
 *
 * 单独抽出来是为了 `runServe` 可读；测试不跑它（会挂住进程）。
 */
export function waitForShutdownSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const onSignal = (signal: NodeJS.Signals): void => {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
      resolve(signal);
    };
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
  });
}

/** 在 `ms` 内跑完 `work`；超时只报告，不抛（停机流程不能自己炸）。 */
export async function runWithDeadline(
  work: Promise<void>,
  ms: number,
  onTimeout: () => void,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
    }, ms);
    // 不要因为这个定时器把进程吊住
    timer.unref();
  });
  const outcome = await Promise.race([work.then(() => 'done' as const), timeout]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  if (outcome === 'timeout') {
    onTimeout();
    return false;
  }
  return true;
}

/**
 * 装配 `serve`：把 `createApplication` 的结果原样交出去。
 *
 * 为什么本文件不再自己拼 pool/boss/fastify：装配是**一件事**（`app/compose.ts`），
 * 散在 CLI 里会出现「测试验的装配」与「线上跑的装配」两份相似代码 —— W4-P 之前就是那样，
 * 而两份代码的分叉点永远在出事的时候才被发现。
 *
 * 注入：`options.appFactory` 可以替换整份装配（测试用假 docker / 假 host / 假 GitHub，
 * 见 `test/app-lifecycle.test.ts`）；`options.waitSignal` 可以替换等信号的方式。
 */
function buildApplication(runtime: CommandRuntime, options: RunCliOptions): Application {
  const config = readAppConfig(runtime.env);
  const factory = options.appFactory ?? createApplication;
  return factory(config);
}

/**
 * `serve` 的执行通道：装配 → start → 等 SIGTERM/SIGINT → 停机（≤90s，`TimeoutStopSec=90`）。
 *
 * 退出码：正常停机 `EXIT_OK`；停机超预算**照样** `EXIT_OK`（进程已经被 systemd 判超时，
 * 这里再报一个失败码只会让「谁的问题」更模糊），但会在 stderr 留一行明确的记录。
 */
async function runServe(runtime: CommandRuntime, options: RunCliOptions): Promise<number> {
  const app = buildApplication(runtime, options);
  const address = await app.start();
  runtime.io.out(
    `${CLI_NAME} serve: 已启动 http://${address.http.host}:${String(address.http.port)}` +
      `（metrics ${address.metrics.host}:${String(address.metrics.port)}）\n`,
  );

  const waitSignal = options.waitSignal ?? waitForShutdownSignal;
  const signal = await waitSignal();
  runtime.io.out(`${CLI_NAME} serve: 收到 ${signal}，开始优雅停机（上限 ${String(SHUTDOWN_TIMEOUT_MS)}ms）\n`);
  await runWithDeadline(app.stop(), SHUTDOWN_TIMEOUT_MS, () => {
    runtime.io.err(`${CLI_NAME} serve: 停机超过 ${String(SHUTDOWN_TIMEOUT_MS)}ms，强制退出\n`);
  });
  return EXIT_OK;
}

async function runMigrate(runtime: CommandRuntime): Promise<number> {
  const config = readServeConfigOrDbOnly(runtime.env);
  const pool = createPool({
    connectionString: config.databaseUrl,
    applicationName: 'pi-bot-migrate',
    max: 2,
  });
  try {
    const result = await migrate(pool, config.migrationsDir);
    runtime.io.out(`applied: [${result.applied.join(', ')}] skipped: [${result.skipped.join(', ')}]\n`);
    return EXIT_OK;
  } finally {
    await closePool(pool);
  }
}

/** `migrate` 只需要 DSN + 迁移目录，不该因为没配 webhook secret 就跑不起来。 */
function readServeConfigOrDbOnly(env: EnvLike): { databaseUrl: string; migrationsDir: string } {
  const databaseUrl = readDatabaseUrl(env);
  const migrationsDir = env['PI_BOT_MIGRATIONS_DIR'];
  const resolved = migrationsDir === undefined || migrationsDir.trim() === ''
    ? // 与 `config/env.ts` 的默认值同一个来源，避免两处各写一份路径推导
      readServeConfig({
        ...env,
        PI_BOT_WEBHOOK_SECRET: env['PI_BOT_WEBHOOK_SECRET'] ?? '<unused-by-migrate>',
      }).migrationsDir
    : migrationsDir;
  return { databaseUrl, migrationsDir: resolved };
}

async function runReplay(runtime: CommandRuntime, argv: readonly string[]): Promise<number> {
  const deliveryId = argv[1];
  if (deliveryId === undefined || deliveryId.trim() === '') {
    runtime.io.err(`${CLI_NAME} replay: 缺少 <delivery-id>\n用法: ${CLI_NAME} replay <delivery-id>\n`);
    return EXIT_USAGE;
  }

  const databaseUrl = readDatabaseUrl(runtime.env);
  const logger = createLogger({ service: 'pi-bot-replay' });
  const pool = createPool({ connectionString: databaseUrl, applicationName: 'pi-bot-replay', max: 2 });
  const boss = createBoss({ connectionString: databaseUrl, applicationName: 'pi-bot-replay-queue' });
  try {
    await startBoss(boss);
    await bootstrapQueue(boss, { info: (message) => { logger.info(message); } });
    const result = await replayDelivery(
      {
        // 重放不做验签：原文已经验过一次（见 `http/webhook.ts` 的 `replayDelivery`）
        verify: async () => false,
        db: pool,
        enqueue: createQueueEnqueuer(boss),
        ack: createUnavailableAck('replay 强制 dry-run，不产生 GitHub 写动作'),
        logger,
        now: runtime.now,
      },
      deliveryId,
    );
    if (result === null) {
      runtime.io.err(`${CLI_NAME} replay: 没有这条投递（${deliveryId}）\n`);
      return EXIT_FAILURE;
    }
    runtime.io.out(`${JSON.stringify(result.body)}\n`);
    runtime.io.out(`replay 完成（强制 dry-run），耗时 ${String(result.elapsedMs)}ms\n`);
    return EXIT_OK;
  } finally {
    await stopBoss(boss);
    await closePool(pool);
  }
}

/** `bootstrap-host` / `doctor` 的共用骨架：动态 import，缺模块 → NOT_IMPLEMENTED。 */
async function runDelegated(
  runtime: CommandRuntime,
  options: {
    readonly command: CommandName;
    readonly specifier: string;
    readonly exportName: string;
    readonly args: unknown;
    readonly loader: ModuleLoader;
  },
): Promise<number> {
  let moduleExports: Record<string, unknown>;
  try {
    moduleExports = await options.loader(options.specifier);
  } catch (error) {
    runtime.io.err(
      `${CLI_NAME} ${options.command}: NOT_IMPLEMENTED — ${options.specifier} 还不存在（${describeError(error)}）\n`,
    );
    return EXIT_NOT_IMPLEMENTED;
  }
  const entry = moduleExports[options.exportName];
  if (typeof entry !== 'function') {
    runtime.io.err(
      `${CLI_NAME} ${options.command}: NOT_IMPLEMENTED — ${options.specifier} 没有导出 ${options.exportName}()\n`,
    );
    return EXIT_NOT_IMPLEMENTED;
  }
  const run = entry as (args: unknown) => Promise<{ readonly exitCode?: number } | undefined>;
  try {
    const outcome = await run(options.args);
    runtime.io.out(`${CLI_NAME} ${options.command}: 完成\n`);
    return outcome?.exitCode ?? EXIT_OK;
  } catch (error) {
    runtime.io.err(`${CLI_NAME} ${options.command}: ${describeError(error)}\n`);
    return EXIT_FAILURE;
  }
}

async function runBootstrapHost(runtime: CommandRuntime, argv: readonly string[], loader: ModuleLoader): Promise<number> {
  const repair = argv.includes('--repair');
  const bundleDir = runtime.env['PI_BOT_BUNDLE_DIR'];
  const databaseUrl = runtime.env['PI_BOT_DATABASE_URL'];
  return runDelegated(runtime, {
    command: 'bootstrap-host',
    specifier: new URL('./runtime/bootstrap.ts', import.meta.url).href,
    exportName: 'bootstrapHost',
    // 约定：`bootstrapHost(options)`；缺失的环境项由 runtime 侧报错（它比 CLI 更懂要什么）
    args: {
      bundleDir,
      databaseUrl,
      repair,
      env: runtime.env,
      // `bootstrapHost` 的 `readFile` 是注入点（PIN 校验要读 bundle 里的文件）：
      // CLI 这条路径之前漏传，导致 `options.readFile is not a function`（真实缺陷，2026-11-11 修）。
      readFile: async (absolutePath: string) => {
        try {
          return await readFileBytes(absolutePath);
        } catch {
          return undefined;
        }
      },
      logger: createLogger({ service: 'pi-bot-bootstrap' }),
    },
    loader,
  });
}

async function runDoctor(runtime: CommandRuntime, loader: ModuleLoader): Promise<number> {
  const databaseUrl = runtime.env['PI_BOT_DATABASE_URL'];
  return runDelegated(runtime, {
    command: 'doctor',
    specifier: new URL('./doctor/index.ts', import.meta.url).href,
    exportName: 'runDoctor',
    args: { databaseUrl, env: runtime.env, logger: createLogger({ service: 'pi-bot-doctor' }) },
    loader,
  });
}

/**
 * 执行通道：解析 → 分派 → 退出码。
 *
 * 约定：
 *  - 解析错误（缺命令 / 未知命令 / 缺参数）→ `EXIT_USAGE`，与 `main()` 一致
 *  - 依赖模块未落地 → `EXIT_NOT_IMPLEMENTED`
 *  - 执行失败（数据库连不上、迁移报错、投递不存在）→ `EXIT_FAILURE`
 *  - `ConfigError` 也走 `EXIT_USAGE`：它属于「环境配错了」，不是程序 bug
 */
export async function runCli(argv: readonly string[], options: RunCliOptions = {}): Promise<number> {
  const io = options.io ?? processIo;
  const runtime: CommandRuntime = {
    env: options.env ?? (process.env as EnvLike),
    io,
    now: options.now ?? ((): Date => new Date()),
  };
  const loader = options.moduleLoader ?? defaultModuleLoader;

  const head = argv[0];
  if (head === undefined) {
    io.err(`${CLI_NAME}: 缺少命令\n\n${helpText()}`);
    return EXIT_USAGE;
  }
  if (head === '-h' || head === '--help' || head === 'help') {
    io.out(helpText());
    return EXIT_OK;
  }
  if (head === '-v' || head === '--version' || head === 'version') {
    io.out(`${VERSION}\n`);
    return EXIT_OK;
  }
  const command = COMMANDS.find((candidate) => candidate.name === head);
  if (command === undefined) {
    io.err(`${CLI_NAME}: 未知命令 "${head}"\n\n${helpText()}`);
    return EXIT_USAGE;
  }
  if (argv.slice(1).some((token) => token === '-h' || token === '--help')) {
    io.out(helpText());
    return EXIT_OK;
  }

  try {
    switch (command.name) {
      case 'serve':
        return await runServe(runtime, options);
      case 'migrate':
        return await runMigrate(runtime);
      case 'replay':
        return await runReplay(runtime, argv);
      case 'bootstrap-host':
        return await runBootstrapHost(runtime, argv, loader);
      case 'doctor':
        return await runDoctor(runtime, loader);
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      io.err(`${CLI_NAME} ${command.name}: 配置错误 — ${error.message}\n`);
      return EXIT_USAGE;
    }
    io.err(`${CLI_NAME} ${command.name}: ${describeError(error)}\n`);
    return EXIT_FAILURE;
  }
}

function isDirectInvocation(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) {
    return false;
  }
  try {
    return pathToFileURL(invoked).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  // 直接运行时走执行通道；退出码写进 `process.exitCode`（不 `process.exit()`，
  // 让 pino 的日志刷完、让优雅停机把连接关干净）
  void runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      processIo.err(`${CLI_NAME}: ${describeError(error)}\n`);
      process.exitCode = EXIT_FAILURE;
    },
  );
}

/** 未使用的导出提醒：`Logger` 类型给测试注入用（`tsc --noEmit` 下不留未用导入）。 */
export type { Logger };
