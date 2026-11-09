/**
 * **真 git** 验收：`bot/*` 分支回收（tech-plan §5.5 的清理）。
 *
 * 断言的是三条规则：只碰 `bot/`、只删已合并的、`dryRun` 不删任何东西。
 * 「未合并」用真提交造出来（在 main 之外多一个提交），不是假的标志位。
 */
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RepoCache, cleanupBotBranches, gitOutput } from '../src/git/index.ts';
import { createGitFixture, isGitAvailable } from './git-fixture.test.ts';
import type { GitFixture } from './git-fixture.test.ts';

const gitAvailable = await isGitAvailable();

describe.skipIf(!gitAvailable)('git/branch-cleanup（真 git）', { timeout: 120_000 }, () => {
  let fixture: GitFixture;
  let cache: RepoCache;
  let cacheDir: string;

  /** bare 仓库里当前的 bot/* 分支名（排序后）。 */
  async function botBranches(dir: string): Promise<string[]> {
    const result = await fixture.runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads/bot'], { cwd: dir });
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .sort();
  }

  beforeAll(async () => {
    fixture = await createGitFixture();
    cache = new RepoCache({ cacheRoot: fixture.cacheRoot, runGit: fixture.runGit });
    cacheDir = (await cache.ensureCache({ repo: fixture.repo, remoteUrl: fixture.remoteUrl })).dir;

    await fixture.runGit(['push', 'origin', 'main:bot/t1-merged', 'main:feature/human'], { cwd: fixture.sourceDir });

    // 未合并的 bot 分支：在 main 之外多一个提交。
    await fixture.runGit(['checkout', '-b', 'bot/t2-unmerged'], { cwd: fixture.sourceDir });
    await fixture.runGit(['commit', '--allow-empty', '-m', 'wip that is not merged'], { cwd: fixture.sourceDir });
    await fixture.runGit(['push', 'origin', 'bot/t2-unmerged'], { cwd: fixture.sourceDir });
    await fixture.runGit(['checkout', 'main'], { cwd: fixture.sourceDir });
  });

  afterAll(async () => {
    if (fixture !== undefined) {
      await fixture.cleanup();
    }
  });

  it('dryRun：列出可删的，不删任何东西', async () => {
    const before = await botBranches(fixture.bareDir);
    const result = await cleanupBotBranches({ cwd: cacheDir, runGit: fixture.runGit, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.deleted).toEqual([]);
    expect(result.matched.map((item) => item.branch)).toEqual(['bot/t1-merged']);
    expect(result.skipped.map((item) => item.branch)).toEqual(['bot/t2-unmerged']);
    expect(result.skipped[0]?.reason).toBe('unmerged');
    expect(await botBranches(fixture.bareDir)).toEqual(before);
  });

  it('真删：只删已合并的 bot 分支，未合并的跳过并给出原因，人类分支不动', async () => {
    const result = await cleanupBotBranches({ cwd: cacheDir, runGit: fixture.runGit });

    expect(result.deleted.map((item) => item.branch)).toEqual(['bot/t1-merged']);
    expect(result.skipped.map((item) => item.branch)).toEqual(['bot/t2-unmerged']);
    expect(result.skipped[0]?.detail).toContain('未合并');

    // bare 里：bot/t1-merged 没了，bot/t2-unmerged 与 feature/human 还在。
    expect(await botBranches(fixture.bareDir)).toEqual(['bot/t2-unmerged']);
    const human = await fixture.runGit(['rev-parse', '--verify', 'refs/heads/feature/human'], { cwd: fixture.bareDir });
    expect(human.code).toBe(0);
    expect(gitOutput(await fixture.runGit(['rev-parse', 'refs/heads/main'], { cwd: fixture.bareDir }))).toBe(fixture.initialSha);
  });

  it('前缀收敛：只清理指定 task 前缀下的分支', async () => {
    await fixture.runGit(['push', 'origin', 'main:bot/task-a1-x', 'main:bot/task-b1-y'], { cwd: fixture.sourceDir });

    const result = await cleanupBotBranches({
      cwd: cacheDir,
      runGit: fixture.runGit,
      prefix: 'bot/task-a1',
      dryRun: false,
    });

    expect(result.matched.map((item) => item.branch)).toEqual(['bot/task-a1-x']);
    expect(result.deleted.map((item) => item.branch)).toEqual(['bot/task-a1-x']);
    expect(await botBranches(fixture.bareDir)).toContain('bot/task-b1-y');
  });

  it('非 bot/ 前缀直接拒绝（永远不会去动别的人分支）', async () => {
    await expect(
      cleanupBotBranches({ cwd: cacheDir, runGit: fixture.runGit, prefix: 'feature/' }),
    ).rejects.toThrow();
    await expect(cleanupBotBranches({ cwd: cacheDir, runGit: fixture.runGit, prefix: 'bot/*' })).rejects.toThrow();
    // main 也还在：上面的拒绝发生在任何删除之前。
    expect(gitOutput(await fixture.runGit(['rev-parse', 'refs/heads/main'], { cwd: fixture.bareDir }))).toBe(fixture.initialSha);
  });

  it('删除不动本地缓存的工作树登记（回收分支 != 回收工作树）', async () => {
    const jobDir = path.join(fixture.jobRoot, 'cleanup-job');
    await cache.ensureWorktree({
      repo: fixture.repo,
      remoteUrl: fixture.remoteUrl,
      taskId: 'cleanup-job',
      jobDir,
      headSha: fixture.initialSha,
    });
    const listBefore = await cache.listWorktrees(cacheDir);
    await cleanupBotBranches({ cwd: cacheDir, runGit: fixture.runGit, dryRun: true });
    expect(await cache.listWorktrees(cacheDir)).toEqual(listBefore);
  });
});
