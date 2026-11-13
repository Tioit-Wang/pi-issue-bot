/**
 * 仓库缓存与每任务工作树（tech-plan §5.5 / plan D4）。
 *
 * 形态：一个仓库**一份**缓存（`git clone --filter=blob:none --no-checkout`），
 * 每个任务从缓存 `git worktree add --detach <job_dir> <sha>` 拿一棵独立工作树。
 *
 * 为什么不是「每任务 clone 一次」：
 *   - clone 要拉全历史，任务级超时里最贵的一段就是这个；缓存后每任务只剩 checkout；
 *   - 缓存是**只读语义**的（永远不切分支、只 detach 到某个 sha），所以多个任务共用它
 *     不会互相踩；踩的是工作树，而工作树是每任务一份。
 *
 * 为什么 `--detach`：git 不允许同一个分支被两棵工作树同时检出。摘取检出等于「每任务
 * 一个不可变的起点」，而写回闸门产出的 commit 也是用 `commit-tree` 挂在 HEAD 上，
 * 全程不需要分支——分支只在最后 `push` 那一刻由 refspec 指定（见 `push.ts`）。
 *
 * 缓存目录命名：`<cacheRoot>/<owner>/<name>.git`。`.git` 后缀是有意义的——
 * 它表明「这是缓存，不是谁的工作目录」，谁想在里面改东西都得先想想。
 */
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { AppError } from './deps.ts';
import type { Logger } from './deps.ts';
import { gitOutput } from './run-git.ts';
import type { RunGit } from './run-git.ts';

/** `owner/name` 的每一段都必须是这个形状（挡住 `..`、盘符、以及奇怪的 Unicode 分隔符）。 */
const REPO_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const DEFAULT_CLONE_TIMEOUT_MS = 600_000;
const DEFAULT_FETCH_TIMEOUT_MS = 300_000;
/** fetch 重试的默认次数与退避基数（链路抖动时一次失败就判整条任务失败代价太高）。 */
const DEFAULT_FETCH_ATTEMPTS = 4;
const DEFAULT_FETCH_RETRY_DELAY_MS = 1_000;

export interface RepoCacheOptions {
  /** 缓存根目录（生产是宿主机上的一个目录；测试用临时目录）。 */
  readonly cacheRoot: string;
  /** **必须**是 `run-git.ts` 的执行器，这样基座参数（钩子/强推）才在。 */
  readonly runGit: RunGit;
  readonly logger?: Logger | undefined;
  readonly cloneTimeoutMs?: number;
  readonly fetchTimeoutMs?: number;
  /** fetch 失败时的重试次数（默认 3：链路抖动重发通常就好）。 */
  readonly fetchAttempts?: number;
  /** 重试退避基数：第 n 次重试等 `n * 该值` 毫秒（默认 1000，单测传 0）。 */
  readonly fetchRetryDelayMs?: number;
}

/** 一份缓存仓库。`created` 区分「这次真的 clone 了」与「复用了已有的」。 */
export interface CacheRepo {
  readonly repo: string;
  readonly dir: string;
  readonly created: boolean;
}

/** 一棵准备好了的工作树。 */
export interface PreparedWorktree {
  readonly repo: string;
  readonly taskId: string;
  readonly jobDir: string;
  readonly sha: string;
  readonly cacheDir: string;
}

/** 把 `owner/name` 拆成安全的两段（不允许为空、不允许 `.`/`..`）。 */
function splitRepo(repo: string): { owner: string; name: string } {
  const parts = repo.split('/');
  const owner = parts[0] ?? '';
  const name = parts[1] ?? '';
  if (parts.length !== 2 || !REPO_SEGMENT_RE.test(owner) || !REPO_SEGMENT_RE.test(name)) {
    throw new AppError(`仓库标识必须是 "owner/name" 形式，收到：${JSON.stringify(repo)}`, {
      code: 'REPO_ID_INVALID',
      failureClass: 'sandbox',
      retriable: false,
      details: { repo },
    });
  }
  return { owner, name };
}

export class RepoCache {
  readonly #options: RepoCacheOptions;
  readonly #cloneTimeoutMs: number;
  readonly #fetchTimeoutMs: number;

  constructor(options: RepoCacheOptions) {
    this.#options = options;
    this.#cloneTimeoutMs = options.cloneTimeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS;
    this.#fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  }

  get runGit(): RunGit {
    return this.#options.runGit;
  }

  /** 某个仓库的缓存目录（不创建、不校验存在）。 */
  cacheDirFor(repo: string): string {
    const { owner, name } = splitRepo(repo);
    return path.join(this.#options.cacheRoot, owner, `${name}.git`);
  }

  /**
   * 目录是否已经是一个可用的 git 仓库（clone 失败留下的半成品会被判 false）。
   *
   * 先 `stat` 再问 git：目录不存在时 `execFile` 只会报 `spawn git ENOENT`，
   * 那会被误判成「机器上没有 git」。一次 stat 换来确定的语义。
   */
  async isRepo(dir: string): Promise<boolean> {
    try {
      const stats = await stat(dir);
      if (!stats.isDirectory()) {
        return false;
      }
    } catch {
      return false;
    }
    const result = await this.#options.runGit(['rev-parse', '--git-dir'], { cwd: dir, allowFailure: true });
    return result.code === 0;
  }

  /**
   * 确保缓存存在并更新到最新远端状态。
   *
   * 复用时只做 `fetch`（`--prune` 清掉远端已删的分支）：
   * 「缓存永远不 checkout，所以 fetch 不会踩任何人的工作树」是这个类的不变式。
   *
   * **fetch 失败不立刻判死**（2026-11-12 实测：本机到 github 的出口会整段不可用，
   * 而缓存里的 main 仍是上次同步时的完整历史）：拉不到最新不等于缓存不可用，
   * 这里只记 warn，让调用方照常建工作树；若真的缺了要用的 ref/sha，
   * 后续 `resolveSha()` 会明确报「解析不到」，错误信息比「fetch 失败」更贴近事实。
   */
  async ensureCache(input: { repo: string; remoteUrl: string }): Promise<CacheRepo> {
    const dir = this.cacheDirFor(input.repo);
    if (await this.isRepo(dir)) {
      try {
        await this.fetch(dir);
      } catch (error) {
        this.#options.logger?.warn(
          { repo: input.repo, dir, err: error instanceof Error ? error.message : String(error) },
          '拉取远端失败，改用缓存里的既有历史继续（可能不是最新）',
        );
      }
      return { repo: input.repo, dir, created: false };
    }

    // 半成品目录（上次 clone 中途被杀）必须先清掉，否则 clone 会以「目录非空」失败。
    await rm(dir, { recursive: true, force: true });
    await mkdir(path.dirname(dir), { recursive: true });
    await this.#options.runGit(
      ['clone', '--filter=blob:none', '--no-checkout', '--origin', 'origin', '--quiet', input.remoteUrl, dir],
      {
        code: 'GIT_CLONE_FAILED',
        timeoutMs: this.#cloneTimeoutMs,
      },
    );
    if (!(await this.isRepo(dir))) {
      throw new AppError('clone 之后目录不是 git 仓库（缓存不可用）', {
        code: 'GIT_CACHE_INVALID',
        failureClass: 'sandbox',
        retriable: true,
        details: { dir, repo: input.repo },
      });
    }
    this.#options.logger?.info({ repo: input.repo, dir }, '已建立仓库缓存');
    return { repo: input.repo, dir, created: true };
  }

  /**
   * 拉取全部远端分支引用（不含 tag，省一次对象遍历）。
   *
   * **带有限重试**：链路抖动（`Could not connect to server` / TLS eof）一次 fetch 失败就会让整条
   * 任务判成 `sandbox-crash`，而重发一次通常就好了（2026-11-12 实测：约 1/5 成功）。
   * 只重试可恢复的传输失败，次数与间隔都可注入，便于单测。
   */
  async fetch(cacheDir: string): Promise<void> {
    const attempts = Math.max(1, this.#options.fetchAttempts ?? DEFAULT_FETCH_ATTEMPTS);
    const delayMs = this.#options.fetchRetryDelayMs ?? DEFAULT_FETCH_RETRY_DELAY_MS;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.#options.runGit(
          ['fetch', '--prune', '--no-tags', '--quiet', 'origin', '+refs/heads/*:refs/remotes/origin/*'],
          {
            cwd: cacheDir,
            code: 'GIT_FETCH_FAILED',
            timeoutMs: this.#fetchTimeoutMs,
          },
        );
        return;
      } catch (error) {
        if (attempt >= attempts) {
          throw error;
        }
        this.#options.logger?.warn(
          { attempt, attempts, err: error instanceof Error ? error.message : String(error) },
          'fetch 失败，退避后重试',
        );
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs * attempt).unref?.();
        });
      }
    }
  }

  /** 把 ref/sha 解析成完整 commit sha；解析不到返回 null（不抛）。 */
  async resolveSha(cwd: string, ref: string): Promise<string | null> {
    const result = await this.#options.runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd,
      allowFailure: true,
    });
    const sha = gitOutput(result);
    return result.code === 0 && sha.length > 0 ? sha : null;
  }

  /** 远端默认分支的 sha（`origin/HEAD` 优先，其次 main / master）。 */
  async remoteHeadSha(cacheDir: string): Promise<string> {
    for (const ref of ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/remotes/origin/master']) {
      const sha = await this.resolveSha(cacheDir, ref);
      if (sha !== null) {
        return sha;
      }
    }
    throw new AppError('无法确定远端默认分支（origin/HEAD、main、master 都解析不到）', {
      code: 'GIT_DEFAULT_BRANCH_MISSING',
      failureClass: 'sandbox',
      retriable: false,
      details: { cacheDir },
    });
  }

  /**
   * 从缓存开一棵工作树。
   *
   * 目标目录若已存在（同 taskId 重跑、上次回收失败）先删掉：
   * 让 `worktree add` 面对一个确定的状态，而不是让 git 报一个需要人肉介入的错。
   */
  async createWorktree(input: { cacheDir: string; jobDir: string; sha: string }): Promise<void> {
    const sha = await this.resolveSha(input.cacheDir, input.sha);
    if (sha === null) {
      throw new AppError(`缓存里没有这个提交：${input.sha}（fetch 之后仍不存在，说明它不在远端）`, {
        code: 'WORKTREE_SHA_MISSING',
        failureClass: 'sandbox',
        retriable: false,
        details: { cacheDir: input.cacheDir, sha: input.sha },
      });
    }
    await rm(input.jobDir, { recursive: true, force: true });
    await mkdir(path.dirname(input.jobDir), { recursive: true });
    await this.#options.runGit(['worktree', 'add', '--detach', input.jobDir, sha], {
      cwd: input.cacheDir,
      code: 'WORKTREE_ADD_FAILED',
    });
  }

  /** 回收工作树：`worktree remove --force` → 兜底 `rm -rf` → `prune`。 */
  async removeWorktree(input: { cacheDir: string; jobDir: string }): Promise<void> {
    const result = await this.#options.runGit(['worktree', 'remove', '--force', input.jobDir], {
      cwd: input.cacheDir,
      allowFailure: true,
    });
    if (result.code !== 0) {
      // 工作树里有容器留下的文件（构建产物、被改过的源文件）时 remove 可能失败，
      // 兜底直接删目录，再靠 prune 清掉 `.git/worktrees/<name>` 的残留登记。
      await rm(input.jobDir, { recursive: true, force: true });
    }
    await this.prune(input.cacheDir);
  }

  /** 清掉已不存在的工作树登记。 */
  async prune(cacheDir: string): Promise<void> {
    await this.#options.runGit(['worktree', 'prune', '--expire=now'], { cwd: cacheDir, allowFailure: true });
  }

  /** 列出缓存登记的工作树路径（测试与运维都用它看「有没有泄漏」）。 */
  async listWorktrees(cacheDir: string): Promise<string[]> {
    const result = await this.#options.runGit(['worktree', 'list', '--porcelain'], { cwd: cacheDir, allowFailure: true });
    if (result.code !== 0) {
      return [];
    }
    return result.stdout
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length).trim());
  }

  /**
   * 一步到位：缓存 → 解析 sha → 工作树。
   *
   * `headSha` 缺省时用远端默认分支的头：`WorktreePort.create` 允许不传 sha，
   * 而「不传就检出默认分支头」是唯一说得通的解释。
   */
  async ensureWorktree(input: {
    repo: string;
    remoteUrl: string;
    taskId: string;
    jobDir: string;
    headSha?: string | undefined;
  }): Promise<PreparedWorktree> {
    const cache = await this.ensureCache({ repo: input.repo, remoteUrl: input.remoteUrl });
    const target = input.headSha ?? (await this.remoteHeadSha(cache.dir));
    await this.createWorktree({ cacheDir: cache.dir, jobDir: input.jobDir, sha: target });
    const sha = await this.resolveSha(input.jobDir, 'HEAD');
    this.#options.logger?.debug({ repo: input.repo, jobDir: input.jobDir, sha }, '已建立任务工作树');
    return {
      repo: input.repo,
      taskId: input.taskId,
      jobDir: input.jobDir,
      sha: sha ?? target,
      cacheDir: cache.dir,
    };
  }

  /** 回收一棵由 `ensureWorktree` 建立的工作树（缓存目录按 repo 反推）。 */
  async releaseWorktree(input: { repo: string; jobDir: string }): Promise<void> {
    await this.removeWorktree({ cacheDir: this.cacheDirFor(input.repo), jobDir: input.jobDir });
  }
}
