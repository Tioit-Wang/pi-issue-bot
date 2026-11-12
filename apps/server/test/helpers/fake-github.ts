/**
 * 测试用的「假 GitHub」。
 *
 * 本机没有 GitHub App、没有网络凭证，也不允许发真实请求（dev-plan §13.4 第 5 条）。
 * 所以测试里所有 GitHub 交互都走这两个假实现：
 *  - `createFakeWriteApi()`：实现 `GithubWriteApi`，把每次调用记进 `calls`；
 *  - `createFakeOctokit()`：一个**构造器**，`createGithubClient({ OctokitCtor })` 用它，
 *    于是连 `request(route, params)` 的入参都能断言。
 *
 * 文件放在 `test/helpers/` 且不叫 `*.test.ts`，因此不会被 vitest 当用例收集。
 */
import type { OctokitConstructor } from '../../src/github/octokit.ts';
import type { GithubWriteApi, IssueComment, ResponseLike } from '../../src/github/types.ts';

/** 一次写调用的记录。 */
export type RecordedWriteCall = {
  readonly method: string;
  readonly input: Record<string, unknown>;
};

/** 假写接口：`calls` 可断言，`comments` 可预置。 */
export type FakeWriteApi = GithubWriteApi & {
  readonly calls: RecordedWriteCall[];
  /** 已存在的评论（`listIssueComments` 的数据源）。 */
  readonly comments: IssueComment[];
};

/**
 * 建一个假写接口。
 *
 * `createIssueComment` 会把新评论追加进 `comments`——这正好能测「第二次调用应当跳过」。
 */
export function createFakeWriteApi(
  seed: { readonly comments?: readonly IssueComment[] } = {},
): FakeWriteApi {
  const calls: RecordedWriteCall[] = [];
  const comments: IssueComment[] = [...(seed.comments ?? [])];
  let nextId = 1000;

  const api: FakeWriteApi = {
    calls,
    comments,

    listIssueComments: async (input) => {
      calls.push({ method: 'listIssueComments', input: { ...input } });
      return [...comments];
    },

    createIssueComment: async (input) => {
      calls.push({ method: 'createIssueComment', input: { ...input } });
      nextId += 1;
      comments.push({ id: nextId, body: input.body });
      return { id: nextId, htmlUrl: `https://example.invalid/#issuecomment-${String(nextId)}` };
    },

    addLabels: async (input) => {
      calls.push({ method: 'addLabels', input: { ...input, labels: [...input.labels] } });
    },

    removeLabel: async (input) => {
      calls.push({ method: 'removeLabel', input: { ...input } });
    },

    createIssue: async (input) => {
      calls.push({ method: 'createIssue', input: { ...input } });
      nextId += 1;
      return { number: nextId };
    },

    closeIssue: async (input) => {
      calls.push({ method: 'closeIssue', input: { ...input } });
    },

    updateIssueComment: async (input) => {
      calls.push({ method: 'updateIssueComment', input: { ...input } });
      // 覆盖语义：同一条评论的正文被替换，评论条数不变（槽位「覆盖而非新增」的前提）。
      const index = comments.findIndex((comment) => comment.id === input.commentId);
      if (index >= 0) {
        comments[index] = { id: input.commentId, body: input.body };
      }
      return { id: input.commentId, htmlUrl: `https://example.invalid/#issuecomment-${String(input.commentId)}` };
    },

    getIssue: async (input) => {
      calls.push({ method: 'getIssue', input: { ...input } });
      return {
        number: input.issueNumber,
        title: `fake issue #${String(input.issueNumber)}`,
        body: '',
        state: 'open',
        labels: [],
        authorLogin: null,
        updatedAt: '1970-01-01T00:00:00Z',
        isPullRequest: false,
      };
    },
  };

  return api;
}

/** 假 Octokit 构造器的产物。 */
export type FakeOctokit = {
  readonly OctokitCtor: OctokitConstructor;
  /** 每次 `request()` 的入参与所属实例序号。 */
  readonly requests: Array<{ readonly route: string; readonly params: Record<string, unknown> | undefined }>;
  /** 每次 `new Octokit(options)` 的 options（用来断言 authStrategy 被传进去）。 */
  readonly constructions: Array<Readonly<Record<string, unknown>>>;
};

/** 一次请求的应答（或一次失败）。 */
export type FakeResponder = (
  route: string,
  params: Record<string, unknown> | undefined,
) => ResponseLike<unknown> | Promise<ResponseLike<unknown>>;

/**
 * 建一个假构造器。
 *
 * 注意这是 `class`：`createGithubClient()` 用 `new ctor(options)`，箭头函数不可构造。
 */
export function createFakeOctokit(responder: FakeResponder): FakeOctokit {
  const requests: FakeOctokit['requests'] = [];
  const constructions: FakeOctokit['constructions'] = [];

  class FakeOctokitClass {
    readonly request: (
      route: string,
      params?: Record<string, unknown>,
    ) => Promise<ResponseLike<unknown>>;

    constructor(options: Record<string, unknown>) {
      constructions.push(options);
      this.request = async (route, params) => {
        requests.push({ route, params });
        return responder(route, params);
      };
    }
  }

  return {
    OctokitCtor: FakeOctokitClass as unknown as OctokitConstructor,
    requests,
    constructions,
  };
}
