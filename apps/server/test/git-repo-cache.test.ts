/**
 * **真 git** 验收：clone 缓存 + 每任务工作树（tech-plan §5.5 / plan D4）。
 *
 * 本机有 git 2.56（Windows），所以这些不是 mock：真建 bare 仓库、真 clone、真 worktree。
 * git 不可用时整组 skip（不假装跑过）。
 *
 * 覆盖：
 *   - `clone --filter=blob:none --no-checkout` 落到缓存目录，`rev-parse HEAD` 等于远端头；
 *   - 第二次 `ensureCache` 复用缓存（`created === false`）并拉取新提交；
 *   - 两棵工作树互不干扰（A 里写文件不影响 B 的 `status`/`HEAD`）；
 *   - `worktree remove --force` + `prune` 之后登记里不再有它；
 *   - `createRepoWorktreePort` 与 worker 的 `WorktreePort` 形状一致（create/release 都走通）；
 *   - 全程 argv 里没有 `--force` 类令牌（worktree remove 的 `--force` 是允许的那一个例外，
 *     这里断言的是 push 语义上的强推，见 `git-writeback.test.ts`）。
 */
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RepoCache, createRepoWorktreePort, gitOutput } from '../src/git/index.ts';
import { commitInSource, createGitFixture, isGitAvailable } from './git-fixture.test.ts';
import type { GitFixture } from './git-fixture.test.ts';

const gitAvailable = await isGitAvailable();

describe.skipIf(!gitAvailable)('git/repo-cache（真 git）', { timeout: 120_000 }, () => {
  let fixture: GitFixture;
  let cache: RepoCache;

  beforeAll(async () => {
    fixture = await createGitFixture();
    cache = new RepoCache({ cacheRoot: fixture.cacheRoot, runGit: fixture.runGit });
  });

  afterAll(async () => {
    if (fixture !== undefined) {
      await fixture.cleanup();
    }
  });

  it('clone 到缓存目录（--no-checkout），HEAD 等于远端头', async () => {
    const repo = await cache.ensureCache({ repo: fixture.repo, remoteUrl: fixture.remoteUrl });
    expect(repo.created).toBe(true);
    expect(repo.dir.startsWith(fixture.cacheRoot)).toBe(true);

    const head = await cache.resolveSha(repo.dir, 'HEAD');
    expect(head).toBe(fixture.initialSha);

    // --no-checkout 的意义：缓存目录里没有工作树内容。
    await expect(stat(path.join(repo.dir, 'src', 'a.ts'))).rejects.toThrow();
  });

  it('复用缓存时只做 fetch，并能拿到新提交', async () => {
    const first = await cache.ensureCache({ repo: fixture.repo, remoteUrl: fixture.remoteUrl });
    const second = await cache.ensureCache({ repo: fixture.repo, remoteUrl: fixture.remoteUrl });
    expect(second.created).toBe(false);

    const newSha = await commitInSource(fixture, { 'src/a.ts': 'export const a = 99;\n' }, 'bump a');
    await cache.fetch(first.dir);
    expect(await cache.resolveSha(first.dir, newSha)).toBe(newSha);

    const jobDir = path.join(fixture.jobRoot, 'task-new');
    const prepared = await cache.ensureWorktree({
      repo: fixture.repo,
      remoteUrl: fixture.remoteUrl,
      taskId: 'task-new',
      jobDir,
      headSha: newSha,
    });
    expect(prepared.sha).toBe(newSha);

    const content = await fixture.runGit(['show', 'HEAD:src/a.ts'], { cwd: jobDir });
    expect(content.stdout).toContain('99');
  });

  it('两棵工作树互不干扰', async () => {
    const jobA = path.join(fixture.jobRoot, 'task-a');
    const jobB = path.join(fixture.jobRoot, 'task-b');
    const a = await cache.ensureWorktree({ repo: fixture.repo, remoteUrl: fixture.remoteUrl, taskId: 'task-a', jobDir: jobA });
    const b = await cache.ensureWorktree({ repo: fixture.repo, remoteUrl: fixture.remoteUrl, taskId: 'task-b', jobDir: jobB });

    expect(gitOutput(await fixture.runGit(['rev-parse', 'HEAD'], { cwd: jobA }))).toBe(a.sha);
    expect(gitOutput(await fixture.runGit(['rev-parse', 'HEAD'], { cwd: jobB }))).toBe(b.sha);
    expect(a.sha).toBe(b.sha);

    await writeFile(path.join(jobA, 'only-a.txt'), 'a\n', 'utf8');
    const statusA = await fixture.runGit(['status', '--porcelain'], { cwd: jobA });
    const statusB = await fixture.runGit(['status', '--porcelain'], { cwd: jobB });
    expect(statusA.stdout).toContain('only-a.txt');
    expect(statusB.stdout.trim()).toBe('');

    const list = await cache.listWorktrees(cache.cacheDirFor(fixture.repo));
    expect(list.some((item) => item.endsWith('task-a'))).toBe(true);
    expect(list.some((item) => item.endsWith('task-b'))).toBe(true);
  });

  it('回收：remove+prune 之后目录消失、登记也消失，另一棵不受影响', async () => {
    const jobA = path.join(fixture.jobRoot, 'task-a');
    const jobB = path.join(fixture.jobRoot, 'task-b');
    await cache.releaseWorktree({ repo: fixture.repo, jobDir: jobA });

    await expect(stat(jobA)).rejects.toThrow();
    const list = await cache.listWorktrees(cache.cacheDirFor(fixture.repo));
    expect(list.some((item) => item.endsWith('task-a'))).toBe(false);
    expect(list.some((item) => item.endsWith('task-b'))).toBe(true);

    // 回收一棵不影响另一棵：B 仍然干净可用。
    const statusB = await fixture.runGit(['status', '--porcelain'], { cwd: jobB });
    expect(statusB.stdout.trim()).toBe('');
  });

  it('createRepoWorktreePort 与 worker 的 WorktreePort 形状一致', async () => {
    const port = createRepoWorktreePort({
      cache,
      jobRoot: fixture.jobRoot,
      remoteUrl: () => fixture.remoteUrl,
    });
    const handle = await port.create({ taskId: 'task-port', repo: fixture.repo });
    expect(handle.jobDir).toBe(path.join(fixture.jobRoot, 'task-port'));
    expect(handle.repo).toBe(fixture.repo);
    expect(handle.headSha).toBeDefined();
    expect(await stat(path.join(handle.jobDir, 'src', 'a.ts'))).toBeDefined();

    await port.release?.(handle);
    await expect(stat(handle.jobDir)).rejects.toThrow();
  });

  it('缓存目录按 owner/name.git 组织，非法仓库标识直接拒绝', async () => {
    expect(cache.cacheDirFor('acme/demo')).toBe(path.join(fixture.cacheRoot, 'acme', 'demo.git'));
    expect(() => cache.cacheDirFor('../escape/x')).toThrow();
    expect(() => cache.cacheDirFor('acme')).toThrow();
  });
});
