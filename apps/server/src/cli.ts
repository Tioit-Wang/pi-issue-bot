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
 */
import { pathToFileURL } from 'node:url';

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_NOT_IMPLEMENTED = 2;

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
    `${CLI_NAME} ${VERSION} — pi-issue-bot 控制面命令行（骨架阶段：子命令尚未实现）`,
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
    `  ${EXIT_OK}  成功（--help / --version）`,
    `  ${EXIT_USAGE}  用法错误（缺少命令、未知命令）`,
    `  ${EXIT_NOT_IMPLEMENTED}  NOT_IMPLEMENTED（骨架阶段所有子命令都是这个码）`,
    '',
  ].join('\n');
}

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
      `  骨架阶段只实现参数解析与 --help；实现归属见 docs/spec/dev-setup.md 的目录所有权约定。\n` +
      `  期望行为（tech-plan §8.4）：${command.summary}\n`,
  );
  return EXIT_NOT_IMPLEMENTED;
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
  process.exitCode = main(process.argv.slice(2));
}
