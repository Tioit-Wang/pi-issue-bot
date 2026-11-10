import { describe, expect, it } from 'vitest';
import { fromSystemRepos, normalizeRepoList } from './repos.ts';

/**
 * `/api/repos` 的**容错边界**：W1-A 的接口与 `/api/system` 的老字段并存一段时间，
 * 面板必须两种都认、缺字段也不炸（左栏切换器是全局组件，它抛错等于整页白屏）。
 */
describe('normalizeRepoList', () => {
  it('契约形状：`{repos: [...]}` 原样读出，并按 repo 排序', () => {
    const result = normalizeRepoList({
      repos: [
        { repo: 'other/lib', enabled: false, dryRun: false, settingsValid: true, archivedAt: null, lastActivityAt: null },
        { repo: 'acme/widgets', enabled: true, dryRun: true, settingsValid: true, archivedAt: null, lastActivityAt: '2026-06-01T12:00:00.000Z' },
      ],
    });

    expect(result.map((repo) => repo.repo)).toEqual(['acme/widgets', 'other/lib']);
    expect(result[0]).toMatchObject({ enabled: true, dryRun: true, settingsValid: true });
    expect(result[0]?.lastActivityAt).toBe('2026-06-01T12:00:00.000Z');
  });

  it('裸数组也认（服务端将来直接返回数组时不用改面板）', () => {
    expect(normalizeRepoList([{ repo: 'acme/widgets' }])).toHaveLength(1);
  });

  it('缺字段按保守值补齐：enabled=false、dryRun=true、settingsValid=true', () => {
    const [repo] = normalizeRepoList({ repos: [{ repo: 'acme/widgets' }] });
    expect(repo).toMatchObject({ enabled: false, dryRun: true, settingsValid: true, settingsError: null });
  });

  it('老字段 `configValid` / `configError` 视作 settings 合法性与错误信息', () => {
    const [repo] = normalizeRepoList({
      repos: [{ repo: 'other/lib', enabled: true, dryRun: false, configValid: false, configError: 'outputs 越界' }],
    });
    expect(repo).toMatchObject({ settingsValid: false, settingsError: 'outputs 越界' });
  });

  it('脏数据不炸：非对象项、缺 repo、重复 repo 都被吞掉/去重', () => {
    const result = normalizeRepoList({
      repos: [null, 'nope', { repo: '' }, { repo: 'acme/widgets' }, { repo: 'acme/widgets', enabled: true }],
    });
    expect(result).toHaveLength(1);
    // 后出现的覆盖前面的（同一仓库只留一行，且取后面的字段）
    expect(result[0]).toMatchObject({ repo: 'acme/widgets', enabled: true });
  });

  it('形状完全不对（null / 字符串 / 空对象）→ 空数组', () => {
    expect(normalizeRepoList(null)).toEqual([]);
    expect(normalizeRepoList('oops')).toEqual([]);
    expect(normalizeRepoList({})).toEqual([]);
    expect(normalizeRepoList({ repos: 'oops' })).toEqual([]);
  });
});

describe('fromSystemRepos（降级路径）', () => {
  it('`/api/system` 的 repos[] 映射成同一形状（W3-H 起字段已齐，不再从 configValid 别名推）', () => {
    const result = fromSystemRepos([
      {
        repo: 'other/lib',
        enabled: false,
        dryRun: false,
        settingsValid: false,
        settingsError: 'outputs 越界',
        source: 'manual',
        archivedAt: '2026-05-20T08:00:00.000Z',
        lastActivityAt: null,
        configValid: false,
        configError: 'outputs 越界',
      },
      {
        repo: 'acme/widgets',
        enabled: true,
        dryRun: true,
        settingsValid: true,
        settingsError: null,
        source: 'installation',
        archivedAt: null,
        lastActivityAt: '2026-06-01T11:40:00.000Z',
        configValid: true,
        configError: null,
      },
    ]);

    expect(result.map((repo) => repo.repo)).toEqual(['acme/widgets', 'other/lib']);
    expect(result[1]).toMatchObject({
      settingsValid: false,
      settingsError: 'outputs 越界',
      archivedAt: '2026-05-20T08:00:00.000Z',
      lastActivityAt: null,
    });
    expect(result[0]).toMatchObject({
      settingsValid: true,
      archivedAt: null,
      lastActivityAt: '2026-06-01T11:40:00.000Z',
    });
  });
});
