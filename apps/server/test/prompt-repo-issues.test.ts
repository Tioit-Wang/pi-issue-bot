import { describe, expect, it } from 'vitest';
import {
  REPO_ISSUES_DEFAULT_TTL_MS,
  REPO_ISSUES_MAX_ITEMS,
  createRepoIssuesProvider,
} from '../src/prompt/repo-issues.ts';
import type { RepoIssueEntry, RepoIssuesLister } from '../src/prompt/repo-issues.ts';

/**
 * `{{repo.issues}}` 的数据源（§6.3「issue 列表的规模控制」）。
 *
 * 五条硬约束各有对应用例：只 open、排除 PR、200 条截断 + 说明行、缓存 5 分钟、并发只发一次。
 * 这些都是**规模**问题：仓库只有 3 条 issue 时怎么写都对，几万条时才看出第一条少过滤了 PR。
 */

/** 夹具时间基准：2026-11-12T00:00:00Z（与需求文档同一批日期，方便读）。 */
const UPDATED_AT_BASE = Date.UTC(2026, 10, 12, 0, 0, 0);

/** 造一条列表项；`updatedAt` 随编号递增（编号越大越新），方便断言「倒序」。 */
function item(
  number: number,
  options: { isPullRequest?: boolean; title?: string; state?: string } = {},
): RepoIssueEntry {
  return {
    number,
    title: options.title ?? `issue ${String(number)}`,
    state: options.state ?? 'open',
    isPullRequest: options.isPullRequest ?? false,
    updatedAt: new Date(UPDATED_AT_BASE + number * 60_000).toISOString(),
  };
}

type ListIssuesCall = {
  readonly repo: string;
  readonly state: 'open';
  readonly perPage: number;
  readonly page: number;
};

type FakeLister = {
  readonly lister: RepoIssuesLister;
  /** 收到的每次请求（断言分页次数与参数用） */
  readonly calls: ListIssuesCall[];
};

/** 分页假实现：`pages` 一页一个数组，`total` 由用例给（GitHub 的 total 每页相同）。 */
function fakeLister(pages: readonly (readonly RepoIssueEntry[])[], total: number): FakeLister {
  const calls: ListIssuesCall[] = [];
  return {
    calls,
    lister: async (input) => {
      calls.push({ ...input });
      return { total, items: pages[input.page - 1] ?? [] };
    },
  };
}

describe('范围与排除', () => {
  it('只 open：请求参数固定 state=open、perPage=100', async () => {
    const { lister, calls } = fakeLister([[item(1)]], 1);
    const provider = createRepoIssuesProvider({ listIssues: lister });
    await provider.render('org/repo');
    expect(calls[0]).toMatchObject({ repo: 'org/repo', state: 'open', perPage: 100, page: 1 });
  });

  it('排除 PR（GitHub 的 issues 接口会把 PR 混进来）', async () => {
    const { lister } = fakeLister(
      [[item(10), item(11, { isPullRequest: true }), item(12), item(13, { isPullRequest: true })]],
      4,
    );
    const provider = createRepoIssuesProvider({ listIssues: lister });
    const text = await provider.render('org/repo');
    expect(text.split('\n')).toEqual(['#12 [open] issue 12', '#10 [open] issue 10']);
  });

  it('按 updatedAt 倒序（最近的排最前）', async () => {
    const { lister } = fakeLister([[item(1), item(3), item(2)]], 3);
    const provider = createRepoIssuesProvider({ listIssues: lister });
    const text = await provider.render('org/repo');
    expect(text.split('\n')).toEqual(['#3 [open] issue 3', '#2 [open] issue 2', '#1 [open] issue 1']);
  });

  it('空列表渲染成空串（不带任何说明行）', async () => {
    const { lister } = fakeLister([[]], 0);
    const provider = createRepoIssuesProvider({ listIssues: lister });
    expect(await provider.render('org/repo')).toBe('');
  });
});

describe('上限 200 条与截断说明', () => {
  it('总量超过 200：只列 200 条，末尾补「（共 N 条，仅列最近 200 条）」', async () => {
    const page1 = Array.from({ length: 100 }, (_unused, index) => item(index + 1));
    const page2 = Array.from({ length: 100 }, (_unused, index) => item(index + 101));
    const { lister, calls } = fakeLister([page1, page2], 1243);
    const provider = createRepoIssuesProvider({ listIssues: lister });

    const lines = (await provider.render('org/repo')).split('\n');
    expect(lines).toHaveLength(REPO_ISSUES_MAX_ITEMS + 1);
    expect(lines[0]).toBe('#200 [open] issue 200');
    expect(lines[REPO_ISSUES_MAX_ITEMS - 1]).toBe('#1 [open] issue 1');
    expect(lines[REPO_ISSUES_MAX_ITEMS]).toBe(`（共 1243 条，仅列最近 ${String(REPO_ISSUES_MAX_ITEMS)} 条）`);
    // 最多翻 2 页：100 × 2 正好覆盖上限，再翻只是为了拿 total，不值
    expect(calls.map((call) => call.page)).toEqual([1, 2]);
  });

  it('未超限时**不**补说明行（补了会让人以为还有没列出来的）', async () => {
    const { lister } = fakeLister([[item(1), item(2), item(3)]], 3);
    const provider = createRepoIssuesProvider({ listIssues: lister });
    const lines = (await provider.render('org/repo')).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.some((line) => line.startsWith('（共'))).toBe(false);
  });

  it('第一页没取满就不再翻第二页', async () => {
    const { lister, calls } = fakeLister([[item(1), item(2)]], 2);
    const provider = createRepoIssuesProvider({ listIssues: lister });
    await provider.render('org/repo');
    expect(calls).toHaveLength(1);
  });
});

describe('缓存（默认 5 分钟）与并发去重', () => {
  it('同一个仓库第二次渲染命中缓存，不再请求', async () => {
    let clock = 1_000;
    const { lister, calls } = fakeLister([[item(1)]], 1);
    const provider = createRepoIssuesProvider({ listIssues: lister, now: () => clock });

    expect(await provider.render('org/repo')).toBe('#1 [open] issue 1');
    clock += REPO_ISSUES_DEFAULT_TTL_MS - 1;
    expect(await provider.render('org/repo')).toBe('#1 [open] issue 1');
    expect(calls).toHaveLength(1);
  });

  it('缓存过期后重新拉取', async () => {
    let clock = 1_000;
    const { lister, calls } = fakeLister([[item(1)]], 1);
    const provider = createRepoIssuesProvider({ listIssues: lister, now: () => clock });

    await provider.render('org/repo');
    clock += REPO_ISSUES_DEFAULT_TTL_MS + 1;
    await provider.render('org/repo');
    expect(calls).toHaveLength(2);
  });

  it('不同仓库各自一份缓存', async () => {
    const { lister, calls } = fakeLister([[item(1)]], 1);
    const provider = createRepoIssuesProvider({ listIssues: lister });
    await provider.render('org/a');
    await provider.render('org/b');
    expect(calls).toHaveLength(2);
  });

  it('同一波并发只发一次请求（in-flight 去重）', async () => {
    const { lister, calls } = fakeLister([[item(1)]], 1);
    const provider = createRepoIssuesProvider({ listIssues: lister });
    const [first, second, third] = await Promise.all([
      provider.render('org/repo'),
      provider.render('org/repo'),
      provider.render('org/repo'),
    ]);
    expect(first).toBe('#1 [open] issue 1');
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(calls).toHaveLength(1);
  });

  it('invalidate 之后重新拉取；invalidate() 清全部', async () => {
    const { lister, calls } = fakeLister([[item(1)]], 1);
    const provider = createRepoIssuesProvider({ listIssues: lister });

    await provider.render('org/a');
    await provider.render('org/b');
    expect(calls).toHaveLength(2);

    provider.invalidate('org/a');
    await provider.render('org/a');
    expect(calls).toHaveLength(3);

    provider.invalidate();
    await provider.render('org/a');
    await provider.render('org/b');
    expect(calls).toHaveLength(5);
  });

  it('invalidate 发生在请求在途时，旧结果不会覆盖新缓存', async () => {
    // 手工可控的 lister：拿到 resolve 句柄，由用例决定什么时候让它完成
    const pending: { resume: ((value: { total: number; items: readonly RepoIssueEntry[] }) => void) | null } = {
      resume: null,
    };
    let requests = 0;
    const lister: RepoIssuesLister = () => {
      requests += 1;
      return new Promise((resolve) => {
        pending.resume = resolve;
      });
    };
    const provider = createRepoIssuesProvider({ listIssues: lister });

    const inFlight = provider.render('org/repo');
    provider.invalidate('org/repo');
    pending.resume?.({ total: 1, items: [item(1)] });
    expect(await inFlight).toBe('#1 [open] issue 1');

    // 旧结果不写缓存 → 再渲染必须重新请求
    const second = provider.render('org/repo');
    expect(requests).toBe(2);
    pending.resume?.({ total: 1, items: [item(1)] });
    expect(await second).toBe('#1 [open] issue 1');
  });
});
