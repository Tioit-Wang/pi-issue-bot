import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RepoCache } from '../src/git/repo-cache.ts';
import type { RunGit } from '../src/git/run-git.ts';

/** 只关心「fetch 会不会重试」，所以 runGit 用一个可编程的桩。 */
function makeCache(failures: number): { cache: RepoCache; calls: () => number } {
  let calls = 0;
  const runGit = (async () => {
    calls += 1;
    if (calls <= failures) {
      throw new Error('GIT_FETCH_FAILED: Could not connect to server');
    }
    return { code: 0, stdout: '', stderr: '' };
  }) as unknown as RunGit;
  const cache = new RepoCache({
    cacheRoot: 'unused',
    runGit,
    fetchAttempts: 3,
    fetchRetryDelayMs: 0,
  });
  return { cache, calls: () => calls };
}

describe('RepoCache.fetch 的有限重试', () => {
  it('前两次失败、第三次成功：不抛错，共调用 3 次', async () => {
    const { cache, calls } = makeCache(2);
    await expect(cache.fetch('C:/tmp/cache.git')).resolves.toBeUndefined();
    expect(calls()).toBe(3);
  });

  it('一直失败：用尽次数后把最后一次错误抛出去（不吞异常）', async () => {
    const { cache, calls } = makeCache(99);
    await expect(cache.fetch('C:/tmp/cache.git')).rejects.toThrow(/Could not connect/u);
    expect(calls()).toBe(3);
  });

  it('一次成功就不重试', async () => {
    const { cache, calls } = makeCache(0);
    await cache.fetch('C:/tmp/cache.git');
    expect(calls()).toBe(1);
  });
});

describe('RepoCache.ensureCache：拉不到远端不等于缓存不可用', () => {
  it('缓存已在、fetch 一直失败 → 仍返回 created=false，不抛错', async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), 'pi-cache-'));
    const repo = 'acme/widgets';
    // 先让 isRepo 判真：stat 需要真实目录，rev-parse 由桩返回 0。
    const dir = join(cacheRoot, 'acme', 'widgets.git');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });

    const runGit = (async (args: readonly string[]) => {
      if (args[0] === 'rev-parse') {
        return { code: 0, stdout: '.git', stderr: '' };
      }
      throw new Error('GIT_FETCH_FAILED: TLS connect error');
    }) as unknown as RunGit;

    const cache = new RepoCache({ cacheRoot, runGit, fetchAttempts: 2, fetchRetryDelayMs: 0 });
    const result = await cache.ensureCache({ repo, remoteUrl: 'https://example/acme/widgets.git' });
    expect(result.created).toBe(false);
    expect(result.dir).toBe(cache.cacheDirFor(repo));
  });
});
