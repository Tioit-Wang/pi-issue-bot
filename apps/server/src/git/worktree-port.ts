/**
 * `WorktreePort` 的真实实现：把 `RepoCache` 接到 worker 的窄接口上。
 *
 * 为什么适配层放在 `git/` 而不是 `worker/`：接口的**语义**归 worker 定（它只知道
 * 「给我一棵树」），实现归 `git/`。这里只用 `import type` 引 `worker/types.ts`，
 * 编译后一行不剩——所以 `worker → git`（调用方向）与 `git → worker/types`
 * （仅类型）不会形成运行时循环。
 *
 * 注入方式（worker 侧一行）：
 *   `{ ...createWorkerDeps(), worktree: createRepoWorktreePort({ cache, jobRoot }) }`
 * 不注入就仍然走 `createUnavailableWorktreePort()`（明确失败，不静默降级）。
 */
import path from 'node:path';

import type { Logger } from './deps.ts';
import type { RepoCache } from './repo-cache.ts';
import type { WorktreeHandle, WorktreePort } from '../worker/types.ts';

export interface RepoWorktreePortOptions {
  readonly cache: RepoCache;
  /** 每任务 job 目录的根（生产上就是绑定进容器的那个目录的父目录）。 */
  readonly jobRoot: string;
  /** 仓库 → 远端 URL；缺省 `https://github.com/<owner/name>.git`。 */
  readonly remoteUrl?: (repo: string) => string;
  readonly logger?: Logger | undefined;
}

/** 默认远端地址（GitHub 公网）。企业版由调用方给 `remoteUrl`。 */
export function defaultRemoteUrl(repo: string, baseUrl: string = 'https://github.com'): string {
  return `${baseUrl.replace(/\/+$/, '')}/${repo}.git`;
}

export function createRepoWorktreePort(options: RepoWorktreePortOptions): WorktreePort {
  const remoteUrl = options.remoteUrl ?? ((repo: string) => defaultRemoteUrl(repo));

  return {
    async create(input): Promise<WorktreeHandle> {
      const jobDir = path.join(options.jobRoot, input.taskId);
      const prepared = await options.cache.ensureWorktree({
        repo: input.repo,
        remoteUrl: remoteUrl(input.repo),
        taskId: input.taskId,
        jobDir,
        ...(input.headSha === undefined ? {} : { headSha: input.headSha }),
      });
      return { taskId: input.taskId, repo: input.repo, jobDir: prepared.jobDir, headSha: prepared.sha };
    },

    async release(handle: WorktreeHandle): Promise<void> {
      await options.cache.releaseWorktree({ repo: handle.repo, jobDir: handle.jobDir });
      options.logger?.debug({ taskId: handle.taskId, jobDir: handle.jobDir }, '工作树已回收');
    },
  };
}
