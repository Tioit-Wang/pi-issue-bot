/**
 * 用**临时索引**组提交（tech-plan §5.6 的实现段）。
 *
 * 关键不变式：**worktree 自己的 `.git/index` 全程不动**。
 * 不做 `git add -A`（那会把容器里的一切脏东西塞进真索引，撤都撤不干净），
 * 而是把 `GIT_INDEX_FILE` 指到 `<job_dir>/.pi-bot/writeback.index`：
 *
 *   read-tree HEAD → add -A -- <intersect…> → write-tree → commit-tree -p HEAD
 *
 * 「推上去的字节」由这个索引决定，而索引只由交集路径填充；容器改过的别的文件
 * 从来没有机会进入这个 commit。
 *
 * `commit-tree` 而不是 `git commit`：后者会跑 pre-commit 钩子、会动 HEAD、会写
 * `ORIG_HEAD`/reflog，这三件事对写回都是副作用。`commit-tree` 只产出一个对象。
 */
import { chmod, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { createHash } from 'node:crypto';
import { AppError } from './deps.ts';
import { gitOutput } from './run-git.ts';
import type { RunGit } from './run-git.ts';
import type { IndexSnapshot } from './types.ts';

/** 临时索引相对 job 目录的位置（在拒收清单里，容器侧改不到）。 */
export const WRITEBACK_INDEX_REL = path.join('.pi-bot', 'writeback.index');

/** 默认的写回提交说明（`bot: <intent> / <task>`，见 tech-plan §5.6 的伪代码）。 */
export function writebackCommitMessage(input: { intent: string; taskId: string }): string {
  return `bot: ${input.intent} / ${input.taskId}`;
}

export interface CreateWritebackCommitInput {
  readonly jobDir: string;
  /** 交集路径（非空）。只有这些路径会进入新提交。 */
  readonly paths: readonly string[];
  readonly message: string;
  readonly runGit: RunGit;
  /** 父提交，默认 `HEAD`（工作树的起点）。 */
  readonly parentRef?: string;
  /** 临时索引路径，默认 `<jobDir>/.pi-bot/writeback.index`。 */
  readonly indexFile?: string;
}

export interface CreateWritebackCommitResult {
  readonly commit: string;
  readonly tree: string;
  readonly parent: string;
  readonly indexFile: string;
  /** 进索引的路径（即推送集）。 */
  readonly stagedPaths: readonly string[];
}

/** 校验路径都是「相对仓库根、无 `..`」再来喂 `git add`（第二道，不走运就算了）。 */
function assertAddablePaths(paths: readonly string[]): void {
  if (paths.length === 0) {
    throw new AppError('写回提交必须有至少 1 条路径（空交集不该走 commit-tree）', {
      code: 'WRITEBACK_EMPTY',
      failureClass: 'sandbox',
      retriable: false,
    });
  }
  for (const item of paths) {
    if (item.length === 0 || item.startsWith('-') || item.startsWith('/') || item.includes('\0')) {
      throw new AppError(`写回路径不合法：${JSON.stringify(item)}`, {
        code: 'WRITEBACK_PATH_INVALID',
        failureClass: 'sandbox',
        retriable: false,
        details: { path: item },
      });
    }
  }
}

export async function createWritebackCommit(
  input: CreateWritebackCommitInput,
): Promise<CreateWritebackCommitResult> {
  assertAddablePaths(input.paths);

  const indexFile = input.indexFile ?? path.join(input.jobDir, WRITEBACK_INDEX_REL);
  await mkdir(path.dirname(indexFile), { recursive: true });
  // 上一次失败留下的索引必须清掉：read-tree 会覆盖它，但「先删」让失败路径也无残留。
  await rm(indexFile, { force: true });

  const env = { GIT_INDEX_FILE: indexFile };
  const cwd = input.jobDir;
  const parentRef = input.parentRef ?? 'HEAD';

  const parent = gitOutput(await input.runGit(['rev-parse', '--verify', `${parentRef}^{commit}`], { cwd }));

  // 1) 从父提交的树起手：没被写回的路径保持与仓库一致，不会丢文件。
  await input.runGit(['read-tree', parent], { cwd, env, code: 'WRITEBACK_READ_TREE_FAILED' });

  // 2) 只把交集路径写进索引。`-A` 保证「删除」也算变更（否则删文件永远推不上去）。
  // `--` 之后一律按路径解释，避免某个文件名恰好长得像选项。
  await input.runGit(['add', '-A', '--', ...input.paths], { cwd, env, code: 'WRITEBACK_ADD_FAILED' });

  // 3) 写树。
  const tree = gitOutput(await input.runGit(['write-tree'], { cwd, env, code: 'WRITEBACK_WRITE_TREE_FAILED' }));

  // 4) 造提交对象（不跑钩子、不动 HEAD、不写 reflog）。
  const commit = gitOutput(
    await input.runGit(['commit-tree', tree, '-p', parent, '-m', input.message], {
      cwd,
      env,
      code: 'WRITEBACK_COMMIT_FAILED',
    }),
  );

  return { commit, tree, parent, indexFile, stagedPaths: [...input.paths] };
}

/** 一棵工作树的「真索引」路径（linked worktree 的 git-dir 在 `.git/worktrees/<name>`）。 */
export async function worktreeIndexPath(jobDir: string, runGit: RunGit): Promise<string> {
  const gitDir = gitOutput(await runGit(['rev-parse', '--git-dir'], { cwd: jobDir }));
  return path.resolve(jobDir, gitDir, 'index');
}

/**
 * 索引快照：`tree`（语义判据）+ 字节摘要（兜底）+ 文件 stat。
 *
 * `tree` 用真索引算出来的树：`git write-tree` 只读索引、不写索引，正好可以当作
 * 「索引里有哪些条目」的指纹。用它而不是文件字节，是因为 `git status`（闸门自己会调）
 * 会刷新索引缓存的 stat 信息并重写索引文件——那是 git 的正常行为，不是「我们动了索引」。
 */
export async function snapshotIndex(jobDir: string, runGit: RunGit): Promise<IndexSnapshot> {
  const indexPath = await worktreeIndexPath(jobDir, runGit);
  const treeResult = await runGit(['write-tree'], { cwd: jobDir, allowFailure: true });
  const tree = treeResult.code === 0 ? treeResult.stdout.trim() : null;
  try {
    const [stats, content] = await Promise.all([stat(indexPath), readFile(indexPath)]);
    return {
      path: indexPath,
      exists: true,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      sha256: createHash('sha256').update(content).digest('hex'),
      tree,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path: indexPath, exists: false, size: 0, mtimeMs: 0, sha256: null, tree };
    }
    throw error;
  }
}

/**
 * 两个快照是否一致。
 *
 * 优先比 `tree`（条目级语义）：索引被 git 刷新过 stat 缓存时字节会变，但树不变。
 * 树拿不到时才退回字节比较——那种情况下「内容有没有被动过」只能从文件本身说话。
 */
export function indexSnapshotsEqual(before: IndexSnapshot, after: IndexSnapshot): boolean {
  if (before.exists !== after.exists) {
    return false;
  }
  if (!before.exists) {
    return true;
  }
  if (before.tree !== null && after.tree !== null) {
    return before.tree === after.tree;
  }
  return before.sha256 === after.sha256;
}

/**
 * 给临时索引补一个 0600 权限（Win 上 no-op）：索引里没有秘密，但它是闸门的脚手架，
 * 不该被别人顺手写到。
 */
export async function restrictIndexPermissions(indexFile: string): Promise<void> {
  try {
    await chmod(indexFile, 0o600);
  } catch {
    // Windows / 只读挂载上 chmod 可能失败，不影响正确性。
  }
}
