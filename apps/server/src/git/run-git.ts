/**
 * 唯一的 git 执行入口（tech-plan §5.5 / §5.6 第 3 条）。
 *
 * 三条硬约束集中在这里，任何调用点都无法绕过：
 * 1. **一律不执行仓库里的钩子**：基座参数固定带 `-c core.hooksPath=/dev/null`
 *    与 `-c submodule.recurse=false`。`/dev/null` 在 Windows 上同样有效——
 *    它只是「一个不存在的目录」，git 找不到钩子就静默不执行。
 * 2. **一律不许强推**：`assertNoForceArgs` 在**每次**调用上检查，`--force` /
 *    `--force-with-lease` / `--mirror` 这类令牌出现即抛错。refspec 里的 `+`
 *    （另一种强推写法）由 `push.ts` 自己组装 refspec 时保证不出现。
 * 3. **子进程只走 `execFile`，不经过 shell**：参数不会被拼接成命令行，路径里的
 *    空格/引号/`;` 没有注入面；令牌只经 env 传递（见 `push.ts`）。
 *
 * `-c core.autocrlf=false` 是对「推上去的字节 = 磁盘上的字节」的保障：
 * 否则宿主的 autocrlf 设置会在 `git add` 时改写行尾，闸门比对的路径与推送的字节
 * 就不是同一份东西了。
 */
import { execFile } from 'node:child_process';

import { AppError, redactSecrets } from './deps.ts';
import type { FailureClass } from './deps.ts';

/** 一次 git 调用的结果（`argv` 是**完整**argv，测试据此断言「没有 --force」）。 */
export interface GitResult {
  readonly argv: readonly string[];
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunGitOptions {
  /** 工作目录；仓库相关的命令必须给（一律用显式 `-C` 之外的这条路，便于审计）。 */
  readonly cwd?: string;
  /** 追加/覆盖的环境变量（`GIT_INDEX_FILE`、`GIT_ASKPASS` 等）。 */
  readonly env?: Readonly<Record<string, string>>;
  /** 允许非零退出（由调用方自己判读 `code`），默认抛出 `AppError`。 */
  readonly allowFailure?: boolean;
  /** 抛出时使用的错误码（默认 `GIT_FAILED`）。 */
  readonly code?: string;
  /** 抛出时使用的失败分类（默认取工厂的 `defaultFailureClass`）。 */
  readonly failureClass?: FailureClass;
  /** 超时（毫秒）。默认无限；clone/fetch 建议给。 */
  readonly timeoutMs?: number;
}

/**
 * git 执行器。**所有** git 调用都必须经这个函数，`git/` 之外的模块不得直接
 * 起 `git` 子进程——否则基座参数（钩子/强推）就漏了。
 */
export type RunGit = (args: readonly string[], options?: RunGitOptions) => Promise<GitResult>;

/**
 * 基座参数：任何 git 调用都会被加上这几条。
 *
 * `core.fsmonitor=false` 关掉 fsmonitor（其守护进程会把「看文件」变成「起服务」，
 * 与「写回只做确定的事」冲突）；`advice.detachedHead=false` 只是让摘取检出不刷提示。
 */
export const GIT_BASE_ARGS: readonly string[] = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'submodule.recurse=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.autocrlf=false',
  '-c',
  'advice.detachedHead=false',
];

/**
 * 身份与交互默认值：提交必须有作者，且**绝不允许 git 停下来问密码**——
 * 一个卡在凭据提示上的 push 会一直占着 worker 槽位，直到任务级超时才被杀。
 */
const DEFAULT_ENV: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: 'pi-issue-bot',
  GIT_AUTHOR_EMAIL: 'bot@pi-issue-bot.invalid',
  GIT_COMMITTER_NAME: 'pi-issue-bot',
  GIT_COMMITTER_EMAIL: 'bot@pi-issue-bot.invalid',
  GIT_TERMINAL_PROMPT: '0',
};

/** 出现即等于「强推/改写历史」的令牌。允许表而不是禁止表，避免漏掉新写法。 */
const FORBIDDEN_ARG_TOKENS: ReadonlySet<string> = new Set([
  '--force',
  '--force-with-lease',
  '--force-if-includes',
  '-f',
  '--mirror',
]);

/**
 * `--force` 唯一被允许出现的命令：`git worktree remove --force`。
 * 它没有「强推」语义——工作树里有容器留下的文件时，不带 --force 根本删不掉，
 * 而「删不掉就留着」会让每任务目录无限堆积。命令级白名单之外一律拒绝。
 */
const FORCE_ALLOWED_COMMANDS: ReadonlySet<string> = new Set(['worktree']);

/**
 * 拦住强推令牌。**每次调用都检查**，不是在 push 那一处检查一次就完事：
 * 免得将来有人从别的命令（例如 `push --mirror`）绕过去。
 */
export function assertNoForceArgs(args: readonly string[]): void {
  const command = args[0] ?? '';
  if (FORCE_ALLOWED_COMMANDS.has(command)) {
    return;
  }
  for (const arg of args) {
    if (FORBIDDEN_ARG_TOKENS.has(arg)) {
      throw new AppError(`git 调用被拒：不允许强推/改写历史类参数 ${arg}（tech-plan §5.6）`, {
        code: 'GIT_FORCE_REFUSED',
        failureClass: 'sandbox',
        retriable: false,
        details: { argv: args.join(' ') },
      });
    }
  }
}

export interface ExecFileRunGitOptions {
  /** git 可执行文件，默认 `git`（生产由 systemd 的 PATH 决定）。 */
  readonly gitPath?: string;
  /**
   * 覆盖基座参数。**只为测试**而存在：反例 3 需要「把钩子路径改回去」来证明
   * 钩子确实会写文件，从而证明 `core.hooksPath=/dev/null` 是它没执行的原因。
   */
  readonly baseArgs?: readonly string[];
  /** 工厂级环境变量（在进程 env 之上、单次调用 env 之下）。 */
  readonly env?: Readonly<Record<string, string>>;
  readonly maxBuffer?: number;
  readonly defaultFailureClass?: FailureClass;
}

/** 拼环境变量：进程 env → 身份默认值 → 工厂 env → 单次调用 env（后者优先）。 */
function buildEnv(
  factoryEnv: Readonly<Record<string, string>> | undefined,
  callEnv: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {};
  for (const source of [process.env, DEFAULT_ENV, factoryEnv ?? {}, callEnv ?? {}]) {
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

interface SpawnResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** 起一次 git 子进程（不经过 shell）。退出码语义与 `child_process` 对齐。 */
function spawnGit(
  file: string,
  argv: readonly string[],
  options: {
    readonly cwd?: string | undefined;
    readonly env: NodeJS.ProcessEnv;
    readonly maxBuffer: number;
    readonly timeoutMs?: number | undefined;
  },
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve, reject) => {
    execFile(
      file,
      [...argv],
      {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: options.env,
        maxBuffer: options.maxBuffer,
        windowsHide: true,
        encoding: 'utf8',
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const exitCode = (error as { code?: unknown }).code;
        if (typeof exitCode === 'number') {
          resolve({ code: exitCode, stdout, stderr });
          return;
        }
        // 连进程都起不来（git 不在 PATH / 无执行权限）——这不是「git 失败」，是「没有 git」。
        reject(
          new AppError(`无法执行 git（${file}）：${error.message}`, {
            code: 'GIT_UNAVAILABLE',
            failureClass: 'sandbox',
            retriable: false,
            details: { gitPath: file },
            cause: error,
          }),
        );
      },
    );
  });
}

/** 默认执行器：`execFile('git', …)` + 基座参数 + 分类化错误。 */
export function createExecFileRunGit(options: ExecFileRunGitOptions = {}): RunGit {
  const gitPath = options.gitPath ?? 'git';
  const baseArgs = options.baseArgs ?? GIT_BASE_ARGS;
  const maxBuffer = options.maxBuffer ?? 32 * 1024 * 1024;
  const defaultFailureClass: FailureClass = options.defaultFailureClass ?? 'sandbox';

  return async (args, callOptions = {}) => {
    assertNoForceArgs(args);
    const argv = [...baseArgs, ...args];
    const env = buildEnv(options.env, callOptions.env);
    const spawned = await spawnGit(gitPath, argv, {
      cwd: callOptions.cwd,
      env,
      maxBuffer,
      timeoutMs: callOptions.timeoutMs,
    });
    if (spawned.code !== 0 && callOptions.allowFailure !== true) {
      // 只把 stderr 的**脱敏**片段放进错误里：git 的报错可能带着 remote URL，
      // 而 URL 是最容易被人顺手塞进凭据的地方。
      throw new AppError(`git 失败（exit ${spawned.code}）：${args[0] ?? '<empty>'}`, {
        code: callOptions.code ?? 'GIT_FAILED',
        failureClass: callOptions.failureClass ?? defaultFailureClass,
        retriable: false,
        details: {
          argv: argv.join(' '),
          stderr: redactSecrets(spawned.stderr).slice(0, 4000),
          stdout: redactSecrets(spawned.stdout).slice(0, 1000),
        },
      });
    }
    return { argv, ...spawned };
  };
}

/** 取 `stdout` 并去掉首尾空白（git 的输出几乎总是以换行结尾）。 */
export function gitOutput(result: GitResult): string {
  return result.stdout.trim();
}

/** 把 stdout 按行切开并丢掉空行（`ls-remote` / `worktree list` 这类列表输出用）。 */
export function gitLines(result: GitResult): string[] {
  return result.stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}
