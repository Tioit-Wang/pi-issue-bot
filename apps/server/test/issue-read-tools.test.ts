/**
 * `runtime/issue-read-tools.ts` 的单测。
 *
 * 重点不在「能不能调通」，而在三条硬约束：
 *  1. **五个工具各自打到 `GithubIssueReadApi` 的哪个方法、传了什么**（名字与入参对齐模型写的参数）；
 *  2. **任何错误都不许抛**（非法入参 / 未知工具名 / GitHub 报错），否则一次读失败会杀掉整轮；
 *  3. **截断要看得见**（`…（已截断）` + `truncated`），否则模型会把截断当成「内容就这么少」。
 *
 * 全部用假 api：本机没有 GitHub 凭证，也不允许发真实请求。
 */
import { describe, expect, it } from 'vitest';

import type {
  GithubIssueReadApi,
  IssueCommentDetail,
  IssueDetail,
  IssueListItem,
  TimelineEntry,
} from '../src/github/types.ts';
import {
  DEFAULT_ISSUE_READ_LIMITS,
  ISSUE_READ_TOOL_NAMES,
  TRUNCATION_SUFFIX,
  createIssueReadExecutor,
} from '../src/runtime/issue-read-tools.ts';

const REPO = 'acme/widgets';

/** 一次被记录下来的 api 调用。 */
type RecordedCall = { readonly method: string; readonly input: Record<string, unknown> };

/** 假 api 的预置数据（缺省给一份「正常」的返回）。 */
type FakeSeed = {
  readonly detail?: IssueDetail | undefined;
  readonly issues?: readonly IssueListItem[] | undefined;
  readonly comments?: readonly IssueCommentDetail[] | undefined;
  readonly timeline?: readonly TimelineEntry[] | undefined;
  readonly search?: { readonly items: readonly IssueListItem[]; readonly total: number } | undefined;
  readonly failures?: Readonly<Record<string, unknown>> | undefined;
};

function detailOf(issueNumber: number): IssueDetail {
  return {
    number: issueNumber,
    title: `标题 #${issueNumber}`,
    body: '这是正文',
    state: 'open',
    labels: ['bug', 'ui'],
    authorLogin: 'alice',
    assignees: ['bob'],
    milestone: 'v2.1',
    updatedAt: '2026-11-01T10:00:00Z',
    createdAt: '2026-10-01T10:00:00Z',
    isPullRequest: false,
  };
}

function itemOf(issueNumber: number): IssueListItem {
  return {
    number: issueNumber,
    title: `标题 #${issueNumber}`,
    state: 'open',
    labels: ['bug'],
    updatedAt: '2026-11-01T10:00:00Z',
    isPullRequest: false,
  };
}

/**
 * 假 `GithubIssueReadApi`：记录每次调用的方法与入参，按名字注入失败。
 *
 * `failures` 的键是方法名；给了就让那个方法抛对应的错误对象（用来验证「不抛、收成 github_error」）。
 */
function createFakeApi(seed: FakeSeed = {}): { readonly api: GithubIssueReadApi; readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const failIfNeeded = (method: string): void => {
    const failure = seed.failures?.[method];
    if (failure !== undefined) {
      throw failure;
    }
  };

  const api: GithubIssueReadApi = {
    getIssueDetail: async (input) => {
      calls.push({ method: 'getIssueDetail', input: { ...input } });
      failIfNeeded('getIssueDetail');
      return seed.detail ?? detailOf(input.issueNumber);
    },
    listIssues: async (input) => {
      calls.push({ method: 'listIssues', input: { ...input } });
      failIfNeeded('listIssues');
      return { items: seed.issues ?? [itemOf(12), itemOf(13)], nextCursor: null };
    },
    listIssueComments: async (input) => {
      calls.push({ method: 'listIssueComments', input: { ...input } });
      failIfNeeded('listIssueComments');
      return {
        items:
          seed.comments ?? [
            { id: 9001, authorLogin: 'alice', body: '第一条评论' },
            { id: 9002, authorLogin: null, body: null },
          ],
        nextCursor: null,
      };
    },
    getIssueTimeline: async (input) => {
      calls.push({ method: 'getIssueTimeline', input: { ...input } });
      failIfNeeded('getIssueTimeline');
      return {
        items:
          seed.timeline ?? [
            {
              kind: 'labeled',
              actorLogin: 'alice',
              createdAt: '2026-11-01T10:00:00Z',
              summary: '加了标签 bug',
            },
          ],
        nextCursor: null,
      };
    },
    searchIssues: async (input) => {
      calls.push({ method: 'searchIssues', input: { ...input } });
      failIfNeeded('searchIssues');
      return seed.search ?? { items: [itemOf(12)], total: 3 };
    },
  };

  return { api, calls };
}

describe('五个只读工具各自打到哪个方法', () => {
  it('IssueGet → getIssueDetail，正文含状态/标签/作者/指派/里程碑', async () => {
    const fake = createFakeApi();
    const execute = createIssueReadExecutor(fake.api, {}, { repo: REPO });

    const result = await execute({ name: 'IssueGet', input: { number: 331 } });

    expect(result.ok).toBe(true);
    expect(result.name).toBe('IssueGet');
    expect(result.items).toBe(1);
    expect(result.summary).toBe('IssueGet #331 → 1 条');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.method).toBe('getIssueDetail');
    expect(fake.calls[0]?.input).toEqual({ repo: REPO, issueNumber: 331 });
    expect(result.text).toContain('#331 [open] 标题 #331');
    expect(result.text).toContain('labels: bug,ui');
    expect(result.text).toContain('作者: @alice');
    expect(result.text).toContain('指派: @bob');
    expect(result.text).toContain('里程碑: v2.1');
    expect(result.text).toContain('创建: 2026-10-01');
    expect(result.text).toContain('正文: 这是正文');
    expect(result.errorCode).toBeUndefined();
  });

  it('IssueList → listIssues，筛选参数原样透传，缺省 limit 用 maxItems', async () => {
    const fake = createFakeApi();
    const execute = createIssueReadExecutor(fake.api, {}, { repo: REPO });

    const result = await execute({
      name: 'IssueList',
      input: { state: 'OPEN', labels: ['bug'], assignee: 'bob', milestone: 'v2.1', cursor: '2' },
    });

    expect(result.ok).toBe(true);
    expect(result.items).toBe(2);
    expect(fake.calls[0]?.method).toBe('listIssues');
    expect(fake.calls[0]?.input).toEqual({
      repo: REPO,
      state: 'open',
      labels: ['bug'],
      assignee: 'bob',
      milestone: 'v2.1',
      cursor: '2',
      limit: DEFAULT_ISSUE_READ_LIMITS.maxItems,
    });
    expect(result.text).toContain('#12 [open] 标题 #12');
    expect(result.text).toContain('2026-11-01 更新');
  });

  it('IssueCommentsList → listIssueComments，每条带 comment_id 与作者', async () => {
    const fake = createFakeApi();
    const execute = createIssueReadExecutor(fake.api, {}, { repo: REPO });

    const result = await execute({ name: 'IssueCommentsList', input: { number: 331 } });

    expect(result.ok).toBe(true);
    expect(result.items).toBe(2);
    expect(result.summary).toBe('IssueCommentsList #331 → 2 条');
    expect(fake.calls[0]?.method).toBe('listIssueComments');
    expect(fake.calls[0]?.input).toMatchObject({ repo: REPO, issueNumber: 331 });
    expect(result.text).toContain('comment_id=9001 @alice：第一条评论');
    // 作者给不出（幽灵用户）与空正文都要有可读的兜底，而不是 `undefined`。
    expect(result.text).toContain('comment_id=9002 @未知：（空）');
  });

  it('IssueTimeline → getIssueTimeline，一行一条带日期与摘要', async () => {
    const fake = createFakeApi();
    const execute = createIssueReadExecutor(fake.api, {}, { repo: REPO });

    const result = await execute({ name: 'IssueTimeline', input: { number: 331 } });

    expect(result.ok).toBe(true);
    expect(result.items).toBe(1);
    expect(fake.calls[0]?.method).toBe('getIssueTimeline');
    expect(result.text).toContain('2026-11-01 @alice：加了标签 bug');
  });

  it('IssueSearch → searchIssues，query/labels/state 透传，正文含命中总数', async () => {
    const fake = createFakeApi();
    const execute = createIssueReadExecutor(fake.api, {}, { repo: REPO });

    const result = await execute({
      name: 'IssueSearch',
      input: { query: ' 崩溃 ', labels: ['bug'], state: 'open' },
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toBe('IssueSearch "崩溃" → 1/3 条');
    expect(fake.calls[0]?.method).toBe('searchIssues');
    expect(fake.calls[0]?.input).toMatchObject({
      repo: REPO,
      query: '崩溃',
      labels: ['bug'],
      state: 'open',
    });
    expect(result.text).toContain('共 3 条命中，返回前 1 条');
    expect(result.text).toContain('#12 [open] 标题 #12');
    // 命中的比返回的多，算「截断」（模型要知道还有更多）。
    expect(result.truncated).toBe(true);
  });
});

describe('入参不合法：ok:false 且不抛', () => {
  it.each([
    ['IssueGet', { number: 'abc' }],
    ['IssueGet', { number: 0 }],
    ['IssueGet', { number: -3 }],
    ['IssueCommentsList', { number: 3.5 }],
    ['IssueTimeline', {}],
    ['IssueSearch', { query: '   ' }],
    ['IssueSearch', {}],
  ])('%s 的非法入参 → bad-input', async (name, input) => {
    const fake = createFakeApi();
    const execute = createIssueReadExecutor(fake.api, {}, { repo: REPO });

    const result = await execute({ name, input });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('bad-input');
    expect(result.items).toBe(0);
    expect(result.text).toContain('调用失败');
    // 一次请求都不该发出去。
    expect(fake.calls).toHaveLength(0);
  });

  it('非法 state → bad-input（不静默忽略，模型才知道要改）', async () => {
    const fake = createFakeApi();
    const execute = createIssueReadExecutor(fake.api, {}, { repo: REPO });

    const result = await execute({ name: 'IssueList', input: { state: 'opened' } });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('bad-input');
    expect(result.text).toContain('open / closed / all');
    expect(fake.calls).toHaveLength(0);
  });

  it('缺 repo → bad-input（仓库由平台绑定，模型不该自己写）', async () => {
    const fake = createFakeApi();
    const execute = createIssueReadExecutor(fake.api);

    const result = await execute({ name: 'IssueGet', input: { number: 331 } });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('bad-input');
    expect(result.text).toContain('缺少 repo');
    expect(fake.calls).toHaveLength(0);
  });

  it('limit 超上限被截到 maxItems', async () => {
    const fake = createFakeApi();
    const execute = createIssueReadExecutor(fake.api, { maxItems: 5 }, { repo: REPO });

    await execute({ name: 'IssueCommentsList', input: { number: 331, limit: 500 } });

    expect(fake.calls[0]?.input['limit']).toBe(5);
  });

  it('条目数超过 maxItems：在条目边界截断并标 truncated', async () => {
    const many = Array.from({ length: 8 }, (_unused, index) => itemOf(100 + index));
    const fake = createFakeApi({ issues: many });
    const execute = createIssueReadExecutor(fake.api, { maxItems: 3 }, { repo: REPO });

    const result = await execute({ name: 'IssueList', input: {} });

    expect(result.items).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain(TRUNCATION_SUFFIX);
    expect(result.text).toContain('共 8 条');
    expect(result.text).not.toContain('#103 ');
  });
});

describe('未知工具名', () => {
  it('→ unknown-tool，并列出可用的只读工具（不抛）', async () => {
    const fake = createFakeApi();
    const execute = createIssueReadExecutor(fake.api, {}, { repo: REPO });

    const result = await execute({ name: 'IssueCreate', input: { title: 'x', body: 'y' } });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('unknown-tool');
    expect(result.name).toBe('IssueCreate');
    expect(result.summary).toBe('IssueCreate → 未知工具');
    for (const name of ISSUE_READ_TOOL_NAMES) {
      expect(result.text).toContain(name);
    }
    // 写类工具不在只读名单里 —— 这条断言锁住「5 个」这个数字的来源。
    expect(ISSUE_READ_TOOL_NAMES).toHaveLength(5);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('GitHub 报错：收成 github_error，不抛', () => {
  it('404 要同时说明「可能不存在」与「可能缺权限」', async () => {
    const fake = createFakeApi({ failures: { getIssueDetail: { status: 404, message: 'Not Found' } } });
    const execute = createIssueReadExecutor(fake.api, {}, { repo: REPO });

    const result = await execute({ name: 'IssueGet', input: { number: 331 } });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('github_error');
    expect(result.items).toBe(0);
    expect(result.text).toContain('404');
    expect(result.text).toContain('可能不存在');
    expect(result.text).toContain('缺少 issues 读取权限');
    expect(result.text).toContain('Not Found');
  });

  it('403 / 5xx / 无状态码各自给出不同说明', async () => {
    const cases: ReadonlyArray<{ readonly error: unknown; readonly expectText: string }> = [
      { error: { status: 403 }, expectText: '403' },
      { error: { status: 502 }, expectText: '服务端错误' },
      { error: new Error('socket hang up'), expectText: '没有得到 HTTP 状态' },
      { error: { response: { status: 401 } }, expectText: '401' },
    ];

    for (const item of cases) {
      const fake = createFakeApi({ failures: { listIssueComments: item.error } });
      const execute = createIssueReadExecutor(fake.api, {}, { repo: REPO });

      const result = await execute({ name: 'IssueCommentsList', input: { number: 331 } });

      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe('github_error');
      expect(result.text).toContain(item.expectText);
    }
  });
});

describe('正文截断', () => {
  it('单条正文超过 maxBodyChars → 末尾标 `…（已截断）` 且 truncated', async () => {
    const longBody = 'x'.repeat(1_000);
    const fake = createFakeApi({
      comments: [{ id: 1, authorLogin: 'alice', body: longBody }],
    });
    const execute = createIssueReadExecutor(fake.api, { maxBodyChars: 20 }, { repo: REPO });

    const result = await execute({ name: 'IssueCommentsList', input: { number: 331 } });

    expect(result.truncated).toBe(true);
    expect(result.text).toContain(TRUNCATION_SUFFIX);
    // 20 个字 + 标记，不该把 1000 字原样塞进提示词。
    expect(result.text.length).toBeLessThan(120);
  });

  it('没超就不标（否则模型会以为内容不全）', async () => {
    const fake = createFakeApi({
      comments: [{ id: 1, authorLogin: 'alice', body: '短评论' }],
    });
    const execute = createIssueReadExecutor(fake.api, { maxBodyChars: 400 }, { repo: REPO });

    const result = await execute({ name: 'IssueCommentsList', input: { number: 331 } });

    expect(result.truncated).toBe(false);
    expect(result.text).not.toContain(TRUNCATION_SUFFIX);
  });
});
