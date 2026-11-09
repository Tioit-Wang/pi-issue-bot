/**
 * 推送（tech-plan §5.5 / §5.6）：只推 `bot/*`、**永不 force**、令牌不落 argv。
 *
 * 三条实现要点：
 * 1. **refspec 只由这里拼**：`<commit>:refs/heads/bot/<task>-<slug>`。
 *    拼接点唯一，`+`（另一种强推写法）就没有被写进来的机会。
 * 2. **令牌走 `GIT_ASKPASS`**：临时脚本只做一件事——把环境变量里的令牌回显出来；
 *    令牌本身经 env 传给子进程，不进 argv、不进命令历史、不落盘到脚本里。
 *    脚本 0600、push 结束**立即删**（删不掉就报错，不让它留在磁盘上）。
 * 3. `-c credential.helper=` 把宿主机上任何凭据助手清空：否则 push 可能用错的身份
 *    成功（比失败更糟）。
 */
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { AppError } from './deps.ts';
import type { Logger } from './deps.ts';
import type { RunGit } from './run-git.ts';

/**
 * `bot/*` 分支名：`bot/<task>-<slug>`。
 *
 * 为什么用正则锁死而不是「startsWith('bot/')」：push 的 refspec 里，分支名会被原样
 * 展开成 `refs/heads/<name>`，任何 `..`、`~`、`^`、空格、`:` 都可能被 git 解释成
 * 别的东西（例如 `:` 会变成 refspec 的分隔符）。宁可拒绝一个怪名字。
 */
export const BOT_BRANCH_RE = /^bot\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** 默认的令牌环境变量名（脚本只回显它）。 */
export const TOKEN_ENV_KEY = 'PI_BOT_GIT_TOKEN';

/** 校验分支名是合法的 `bot/*`。非 `bot/*` 一律拒绝（永不动贡献者分支）。 */
export function assertBotBranch(branch: string): void {
  if (!isBotBranch(branch)) {
    throw new AppError(`分支名不在 bot/* 白名单内：${JSON.stringify(branch)}（plan §7.1）`, {
      code: 'BOT_BRANCH_INVALID',
      failureClass: 'sandbox',
      retriable: false,
      details: { branch },
    });
  }
}

/** 给测试与调用方判断「这条远程分支是不是我们的」。 */
export function isBotBranch(branch: string): boolean {
  // `check-ref-format` 的硬规则：`..`、尾部 `.lock`、`/.` 都不合法。
  // 正则放它们过去的话，refspec 在 git 侧才会报错——那时已经晚了，报错信息也更难懂。
  if (branch.includes('..') || branch.endsWith('.lock') || branch.includes('/.')) {
    return false;
  }
  return BOT_BRANCH_RE.test(branch);
}

/** 一个临时的 askpass 脚本。`remove()` 失败会抛错——不能默默留一个可执行文件在盘上。 */
export interface AskpassScript {
  readonly path: string;
  readonly tokenEnvKey: string;
  remove(): Promise<void>;
}

/**
 * 写一个只回显令牌的 askpass 脚本（权限 0600）。
 *
 * Windows 上用 `.cmd`（CreateProcess 能直接跑批处理），其余平台用 `#!/bin/sh`。
 * 两种都**只读环境变量**，脚本内容里没有令牌本身。
 */
export async function createAskpassScript(input: {
  dir: string;
  tokenEnvKey?: string;
  logger?: Logger | undefined;
}): Promise<AskpassScript> {
  const tokenEnvKey = input.tokenEnvKey ?? TOKEN_ENV_KEY;
  await mkdir(input.dir, { recursive: true });
  const extension = process.platform === 'win32' ? 'cmd' : 'sh';
  const file = path.join(input.dir, `askpass-${process.pid}-${Date.now().toString(36)}.${extension}`);
  const content =
    extension === 'cmd'
      ? ['@echo off', `echo %${tokenEnvKey}%`, ''].join('\r\n')
      : ['#!/bin/sh', `printf '%s\\n' "$${tokenEnvKey}"`, ''].join('\n');
  await writeFile(file, content, { encoding: 'utf8', mode: 0o600 });
  // Windows 上 mode 不生效，显式 chmod 一次让 POSIX 平台真的 0600。
  await chmod(file, 0o600);

  let removed = false;
  return {
    path: file,
    tokenEnvKey,
    async remove() {
      if (removed) {
        return;
      }
      removed = true;
      await rm(file, { force: true });
      try {
        await stat(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          input.logger?.debug({ script: file }, 'askpass 脚本已删除');
          return;
        }
        throw error;
      }
      throw new AppError('askpass 脚本删除失败——令牌脚本留在磁盘上是不可接受的', {
        code: 'ASKPASS_CLEANUP_FAILED',
        failureClass: 'sandbox',
        retriable: false,
        details: { script: file },
      });
    },
  };
}

/** 把错误里出现的令牌抹掉（万一某个 git 实现把 askpass 的输入回显进了报错）。 */
function scrubError(error: unknown, token: string | undefined): unknown {
  if (token === undefined || token.length === 0) {
    return error;
  }
  const scrub = (text: string): string => text.split(token).join('<redacted>');
  if (error instanceof AppError) {
    const details =
      error.details === undefined
        ? undefined
        : (JSON.parse(scrub(JSON.stringify(error.details))) as Record<string, unknown>);
    return new AppError(scrub(error.message), {
      code: error.code,
      failureClass: error.failureClass,
      retriable: error.retriable,
      ...(details === undefined ? {} : { details }),
      cause: error,
    });
  }
  if (error instanceof Error) {
    return new Error(scrub(error.message));
  }
  return error;
}

/**
 * 在「有令牌」时准备好 askpass 脚本并保证它被删掉，再把 env 交给实际命令。
 *
 * 抽出来的理由：push 与「删分支」两个调用点都需要同一套令牌生命周期，
 * 复制一份就意味着两处都要记得删脚本。
 */
async function withAskpass<T>(
  input: {
    readonly jobDir: string;
    readonly token?: string | undefined;
    readonly logger?: Logger | undefined;
    readonly tokenEnvKey?: string;
  },
  run: (env: Readonly<Record<string, string>>) => Promise<T>,
): Promise<T> {
  if (input.token === undefined || input.token.length === 0) {
    // 没有令牌（例如本地 file:// 远端）时也显式关掉交互提示，避免卡住。
    return run({ GIT_TERMINAL_PROMPT: '0' });
  }

  const script = await createAskpassScript({
    dir: path.join(input.jobDir, '.pi-bot'),
    ...(input.tokenEnvKey === undefined ? {} : { tokenEnvKey: input.tokenEnvKey }),
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  });
  let result: T;
  try {
    result = await run({
      GIT_ASKPASS: script.path,
      [script.tokenEnvKey]: input.token,
      // 关掉「问终端」这条路：askpass 一定会被用上，且绝不会停下来等人。
      GIT_TERMINAL_PROMPT: '0',
    });
  } catch (error) {
    // 失败路径：脚本一定要删（删不掉只记录，不能盖掉真正的失败原因）。
    try {
      await script.remove();
    } catch (cleanupError) {
      input.logger?.error({ error: String(cleanupError), script: script.path }, 'askpass 脚本清理失败');
    }
    throw scrubError(error, input.token);
  }
  // 成功路径：删不掉就让这次调用失败——令牌脚本留在盘上是不可接受的。
  await script.remove();
  return result;
}

export interface PushCommitInput {
  readonly jobDir: string;
  readonly commit: string;
  /** `bot/<task>-<slug>`。 */
  readonly branch: string;
  readonly runGit: RunGit;
  /** 推送令牌；缺省表示远端不需要认证（例如本地 file:// 仓库）。 */
  readonly token?: string | undefined;
  readonly remote?: string;
  readonly logger?: Logger | undefined;
  readonly tokenEnvKey?: string;
}

export interface PushCommitResult {
  readonly branch: string;
  readonly refspec: string;
  /** 完整 argv（审计与「没有 --force」的断言都用它）。 */
  readonly argv: readonly string[];
  readonly remoteRef: string;
  readonly stdout: string;
  /** askpass 脚本路径（已被删除；留作审计证据）。 */
  readonly askpassPath: string | null;
}

export async function pushCommit(input: PushCommitInput): Promise<PushCommitResult> {
  assertBotBranch(input.branch);
  const remote = input.remote ?? 'origin';
  const refspec = `${input.commit}:refs/heads/${input.branch}`;
  if (refspec.startsWith('+')) {
    // 构造出来就该是干净的；留一道断言，防止将来有人「顺手加个 +」。
    throw new AppError('refspec 不允许以 + 开头（那是强推写法）', {
      code: 'GIT_FORCE_REFUSED',
      failureClass: 'sandbox',
      retriable: false,
      details: { refspec },
    });
  }

  const args = ['-c', 'credential.helper=', 'push', '--no-verify', '--porcelain', remote, refspec];
  const result = await withAskpass(input, (env) =>
    input.runGit(args, {
      cwd: input.jobDir,
      env,
      code: 'GIT_PUSH_FAILED',
      // 远端（GitHub）失败归 github-api：重试矩阵按它判「4xx 不重试 / 5xx 可重试」。
      failureClass: 'github-api',
    }),
  );

  input.logger?.info({ branch: input.branch, remote, refspec }, '写回分支已推送');
  return {
    branch: input.branch,
    refspec,
    argv: result.argv,
    remoteRef: `refs/heads/${input.branch}`,
    stdout: result.stdout,
    askpassPath: null,
  };
}

export interface DeleteBotBranchInput {
  readonly jobDir: string;
  readonly branch: string;
  readonly runGit: RunGit;
  readonly token?: string | undefined;
  readonly remote?: string;
  readonly logger?: Logger | undefined;
}

/** 删一条 `bot/*` 远程分支（回收用）。同样拒绝非 `bot/*`，同样不 force。 */
export async function deleteBotBranch(input: DeleteBotBranchInput): Promise<void> {
  assertBotBranch(input.branch);
  const remote = input.remote ?? 'origin';
  const args = ['-c', 'credential.helper=', 'push', '--no-verify', remote, '--delete', input.branch];
  await withAskpass(input, (env) =>
    input.runGit(args, { cwd: input.jobDir, env, code: 'GIT_PUSH_DELETE_FAILED', failureClass: 'github-api' }),
  );
  input.logger?.info({ branch: input.branch }, 'bot 分支已删除');
}
