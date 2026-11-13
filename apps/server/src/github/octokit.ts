/**
 * Octokit 工厂 + 限流头解析 + 「非 GET 调用」计数（B12；tech-plan §5.1–§5.3、§7.3）。
 *
 * 三件事，都为了「可测且可审计」：
 *  1. **构造器注入**：`OctokitCtor` 可替换，单测传一个记录调用的假构造器，
 *     于是「假 octokit」在测试里能拿到 `request(route, params)` 的全部入参做断言，
 *     而不需要发起任何 HTTP 请求。
 *  2. **限流归一化**：每次响应都把 `x-ratelimit-*` / `retry-after` 变成 `RateLimitState`，
 *     命中就回调 `onRateLimit`（上层拿 `retryAfterMs` 去 `boss.send(..., { startAfter })`）。
 *  3. **非 GET 计数**：M0 的「GitHub 零副作用」验收（dev-plan §6 M0 行）读这个计数；
 *     dry-run 期间它必须恒为 0，否则说明有写路径被真的走通了。
 */
import { Octokit } from 'octokit';
import type { AuthStrategyLike, OctokitAuthStrategyFactory } from './auth.ts';
import { GithubError, extractErrorHeaders, toGithubError } from './errors.ts';
import {
  FALLBACK_RETRY_AFTER_MS,
  detectMethod,
  parseRateLimitHeaders,
  readHeader,
} from './headers.ts';
import type {
  CommentRef,
  GithubClient,
  GithubClientMetrics,
  GithubIssueEditApi,
  GithubIssueReadApi,
  GithubReactionApi,
  GithubRequest,
  GithubWriteApi,
  IssueComment,
  IssueCommentDetail,
  IssueDetail,
  IssueListItem,
  IssuePage,
  IssueSnapshot,
  RateLimitSignal,
  ReactionEntry,
  ReactionRef,
  ReactionTarget,
  ResponseLike,
  TimelineEntry,
} from './types.ts';
import { splitRepo } from './types.ts';
// 关联评论（`duplicate` 的兜底说明）的正文格式与 v2 执行器共用一份纯函数：
// 两处各拼一遍必然漂移（零宽空格 / 标记前缀），而它是「人读到的一句话」。
import { buildLinkNote } from '../writeback/v21/markup.ts';

/** Octokit 构造器的形状（注入点）。真实 `Octokit` 只在这里被断言一次。 */
export type OctokitConstructor = new (options: Readonly<Record<string, unknown>>) => unknown;

const defaultOctokitConstructor: OctokitConstructor = Octokit as unknown as OctokitConstructor;

/** `createGithubClient()` 的入参。 */
export type CreateGithubClientOptions = {
  /** 替换构造器（测试用）。 */
  readonly OctokitCtor?: OctokitConstructor | undefined;
  /**
   * **认证（推荐）**：每次请求前取一个令牌（App installation token，`getToken()` 自带缓存与续期）。
   *
   * 为什么不把 `@octokit/auth-app` 的 `authStrategy` 交给 Octokit：两条路都踩过坑——
   * 传实例是 `Invalid auth type: undefined`，传工厂则它的 request 包装会把 route 参数误当成
   * body（打标 422：`issue_number, owner, repo are not permitted keys`）。令牌注入只改变
   * `Authorization`，请求语义与 `auth: token` 完全一致，行为可预测。
   */
  readonly authTokenProvider?: (() => Promise<string>) | undefined;
  /** 已建好的 strategy 实例（仅测试/特殊传输；生产用 `authTokenProvider`）。 */
  readonly authStrategy?: AuthStrategyLike | OctokitAuthStrategyFactory | undefined;
  readonly authToken?: string | undefined;
  /** GitHub Enterprise 的 API 根地址。 */
  readonly baseUrl?: string | undefined;
  readonly userAgent?: string | undefined;
  /** 单请求超时（毫秒）；默认 15s，与「10 秒应答」无关（应答在 handler 内完成）。 */
  readonly requestTimeoutMs?: number | undefined;
  /** 注入时钟（限流 reset 是绝对时间戳，测试要能固定）。 */
  readonly now?: (() => number) | undefined;
  /** 限流回调：拿到 `RateLimitSignal` 就交给队列层延迟重投。 */
  readonly onRateLimit?: ((signal: RateLimitSignal) => void) | undefined;
};

/**
 * 建一个 `GithubClient`。
 *
 * 认证三选一（`authTokenProvider` / `authStrategy` / `authToken`），**必须显式给一个**：
 * 悄悄退化成「匿名请求」会让限流额度从 5000/h 掉到 60/h，而且失败形态更隐蔽。
 */
export function createGithubClient(options: CreateGithubClientOptions = {}): GithubClient {
  const hasStrategy = options.authStrategy !== undefined;
  const hasToken = options.authToken !== undefined && options.authToken !== '';
  const hasTokenProvider = options.authTokenProvider !== undefined;
  const authKinds = [hasStrategy, hasToken, hasTokenProvider].filter(Boolean).length;
  if (authKinds > 1) {
    throw new Error('createGithubClient: authTokenProvider / authStrategy / authToken 只能给一个');
  }
  if (authKinds === 0) {
    throw new Error('createGithubClient: 必须提供 authTokenProvider（推荐）、authStrategy 或 authToken');
  }

  const ctor = options.OctokitCtor ?? defaultOctokitConstructor;
  const now = options.now ?? Date.now;

  const ctorOptions: Record<string, unknown> = {};
  if (options.authStrategy !== undefined) {
    ctorOptions['authStrategy'] = options.authStrategy;
  } else if (options.authToken !== undefined) {
    ctorOptions['auth'] = options.authToken;
  }
  if (options.baseUrl !== undefined) {
    ctorOptions['baseUrl'] = options.baseUrl;
  }
  if (options.userAgent !== undefined) {
    ctorOptions['userAgent'] = options.userAgent;
  }
  ctorOptions['request'] = { timeout: options.requestTimeoutMs ?? 15_000 };

  const instance = new ctor(ctorOptions);
  const rawRequest = (instance as { readonly request?: unknown }).request;
  if (typeof rawRequest !== 'function') {
    throw new Error('createGithubClient: 构造出的 Octokit 实例没有 request() 方法');
  }
  const callOctokit = rawRequest as <T>(
    route: string,
    params?: Readonly<Record<string, unknown>>,
  ) => Promise<ResponseLike<T>>;

  let getCalls = 0;
  let nonGetCalls = 0;

  const request: GithubRequest = async <T>(
    route: string,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<ResponseLike<T>> => {
    const method = detectMethod(route, params);
    // 计数放在请求之前：失败/被拒的尝试同样是「对 GitHub 发起了非 GET」，
    // M0 的零副作用断言看的是「有没有尝试写」，不是「写成功了没有」。
    if (method === 'GET' || method === 'HEAD') {
      getCalls += 1;
    } else {
      nonGetCalls += 1;
    }

    let response: ResponseLike<T>;
    try {
      // App 认证：每次请求前取一次令牌（`getToken()` 自带缓存与提前续期），
      // 只覆盖 Authorization，route/params 语义与 `auth: token` 完全一致。
      const withAuth =
        options.authTokenProvider === undefined
          ? params
          : {
              ...(params ?? {}),
              headers: {
                ...((params?.['headers'] as Record<string, string> | undefined) ?? {}),
                authorization: `token ${await options.authTokenProvider()}`,
              },
            };
      response = await callOctokit<T>(route, withAuth);
    } catch (error) {
      const wrapped = toGithubError(error, now());
      if (wrapped.info.class === 'rate_limit') {
        const state = parseRateLimitHeaders(extractErrorHeaders(error), now());
        options.onRateLimit?.(
          state.kind === 'rate_limit'
            ? state
            : {
                kind: 'rate_limit',
                retryAfterMs: wrapped.info.retryAfterMs ?? FALLBACK_RETRY_AFTER_MS,
                remaining: null,
                resetAtMs: null,
                source: 'fallback',
              },
        );
      }
      throw wrapped;
    }

    const rateLimit = parseRateLimitHeaders(response.headers, now());
    if (rateLimit.kind === 'rate_limit') {
      options.onRateLimit?.(rateLimit);
    }
    return response;
  };

  return {
    request,
    getMetrics: (): GithubClientMetrics => ({ getCalls, nonGetCalls }),
    resetMetrics: () => {
      getCalls = 0;
      nonGetCalls = 0;
    },
  };
}

/** 列表接口的原始返回（只取我们要的两个字段）。 */
type RawIssueComment = { readonly id?: unknown; readonly body?: unknown };
type RawIssue = { readonly number?: unknown };
type RawComment = { readonly id?: unknown; readonly html_url?: unknown };

/** `GET /issues/{n}` 的原始返回（只取快照需要的字段，全部 `unknown` 后逐个收窄）。 */
type RawIssueDetail = {
  readonly number?: unknown;
  readonly title?: unknown;
  readonly body?: unknown;
  readonly state?: unknown;
  readonly labels?: unknown;
  readonly user?: { readonly login?: unknown } | null;
  readonly updated_at?: unknown;
  readonly pull_request?: unknown;
};

/**
 * 把 `GithubClient` 适配成写执行器需要的 `GithubWriteApi`。
 *
 * 为什么把 REST 细节集中在这里：executor.ts 只写「幂等与闸门」的纯逻辑，
 * 端点路径、分页参数、字段命名这些易漂移的东西全留在本文件，一处可改。
 *
 * TODO(owner: worker/http session)：分页。这里只取前 100 条评论（`per_page: 100`），
 * 足够覆盖「我们的评论是否已经存在」；超过 100 条的 issue 需要 `paginate`，
 * 但那条路径要真实 API，本机无法验证，留到 M1。
 */
export function createGithubWriteApi(client: GithubClient): GithubWriteApi {
  return {
    async listIssueComments(input): Promise<readonly IssueComment[]> {
      const { owner, repo } = splitRepo(input.repo);
      const response = await client.request<readonly RawIssueComment[]>(
        'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
        { owner, repo, issue_number: input.issueNumber, per_page: 100 },
      );
      const rows = Array.isArray(response.data) ? response.data : [];
      return rows
        .filter((row): row is RawIssueComment & { id: number } => typeof row.id === 'number')
        .map((row) => ({ id: row.id, body: typeof row.body === 'string' ? row.body : null }));
    },

    async createIssueComment(input): Promise<CommentRef> {
      const { owner, repo } = splitRepo(input.repo);
      const response = await client.request<RawComment>(
        'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
        { owner, repo, issue_number: input.issueNumber, body: input.body },
      );
      return {
        id: typeof response.data.id === 'number' ? response.data.id : 0,
        htmlUrl: typeof response.data.html_url === 'string' ? response.data.html_url : null,
      };
    },

    async addLabels(input): Promise<void> {
      if (input.labels.length === 0) {
        return;
      }
      const { owner, repo } = splitRepo(input.repo);
      await client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
        owner,
        repo,
        issue_number: input.issueNumber,
        labels: [...input.labels],
      });
    },

    async removeLabel(input): Promise<void> {
      const { owner, repo } = splitRepo(input.repo);
      await client.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
        owner,
        repo,
        issue_number: input.issueNumber,
        name: input.label,
      });
    },

    async createIssue(input): Promise<{ readonly number: number }> {
      const { owner, repo } = splitRepo(input.repo);
      const params: Record<string, unknown> = {
        owner,
        repo,
        title: input.title,
        body: input.body,
      };
      if (input.labels !== undefined && input.labels.length > 0) {
        params['labels'] = [...input.labels];
      }
      const response = await client.request<RawIssue>('POST /repos/{owner}/{repo}/issues', params);
      return { number: typeof response.data.number === 'number' ? response.data.number : 0 };
    },

    async closeIssue(input): Promise<void> {
      const { owner, repo } = splitRepo(input.repo);
      await client.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
        owner,
        repo,
        issue_number: input.issueNumber,
        state: 'closed',
        state_reason: input.reason ?? 'not_planned',
      });
    },

    async updateIssueComment(input): Promise<CommentRef> {
      const { owner, repo } = splitRepo(input.repo);
      const response = await client.request<RawComment>(
        'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
        { owner, repo, comment_id: input.commentId, body: input.body },
      );
      // 响应里没带 id 时回退成入参的 commentId：调用方要的是「这条评论的标识」，
      // 而 PATCH 成功本身就证明它就是这个 id（返回 0 会让槽位索引写进一个假 id）。
      return {
        id: typeof response.data.id === 'number' ? response.data.id : input.commentId,
        htmlUrl: typeof response.data.html_url === 'string' ? response.data.html_url : null,
      };
    },

    async getIssue(input): Promise<IssueSnapshot> {
      const { owner, repo } = splitRepo(input.repo);
      const response = await client.request<RawIssueDetail>(
        'GET /repos/{owner}/{repo}/issues/{issue_number}',
        { owner, repo, issue_number: input.issueNumber },
      );
      const data = response.data ?? {};
      const user = typeof data.user === 'object' && data.user !== null ? data.user : null;
      return {
        number: typeof data.number === 'number' ? data.number : input.issueNumber,
        title: typeof data.title === 'string' ? data.title : '',
        body: typeof data.body === 'string' ? data.body : '',
        state: typeof data.state === 'string' ? data.state : 'open',
        labels: normalizeLabelNames(data.labels),
        authorLogin: typeof user?.login === 'string' ? user.login : null,
        updatedAt: typeof data.updated_at === 'string' ? data.updated_at : '',
        isPullRequest: data.pull_request !== undefined && data.pull_request !== null,
      };
    },
  };
}

/**
 * issue 的 `labels` 字段归一化成名字集合。
 *
 * GitHub 在某些端点上返回 `string[]`，在另一些返回 `{ name }[]`（历史遗留）。
 * 两种都接受，其它形状一律丢弃 —— 让「标签列表里混进一个 null」变成不可能，
 * 下游（目标态对齐）才敢直接拿它做集合运算。
 */
function normalizeLabelNames(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      names.push(item);
      continue;
    }
    if (typeof item === 'object' && item !== null) {
      const name = (item as { readonly name?: unknown }).name;
      if (typeof name === 'string') {
        names.push(name);
      }
    }
  }
  return names;
}

/* ── reaction：无感反馈的写面（W2-D） ────────────────────────────────────────── */

/** 一条 reaction 的原始返回（只取三个字段）。 */
type RawReaction = {
  readonly id?: unknown;
  readonly content?: unknown;
  readonly user?: { readonly login?: unknown } | null;
};

/**
 * 把 `GithubClient` 适配成 `GithubReactionApi`。
 *
 * 端点选择（实测口径，见 `docs/plan-multi-repo.md` §11）：
 *  - 主贴：`/repos/{owner}/{repo}/issues/{issue_number}/reactions` —— **PR 主贴同样可用**，
 *    因为 GitHub 的 PR 在 REST 里就是 issue；
 *  - 评论：`/repos/{owner}/{repo}/issues/comments/{comment_id}/reactions`（issue 评论与
 *    PR 的 issue 评论都走它；PR review comment 需要 `Pull requests:write`，本方案不引入，
 *    调用方因此不传 `commentId`）。
 *
 * 不在这里做「先查再写」：同 content 重复 POST 是幂等的（第二次返回同一个 id）。
 */
export function createGithubReactionApi(client: GithubClient): GithubReactionApi {
  /** reaction 的端点（主贴 / 评论二选一）。 */
  const routeOf = (
    method: 'GET' | 'POST' | 'DELETE',
    input: ReactionTarget & { readonly reactionId?: number },
  ): { readonly route: string; readonly params: Record<string, unknown> } => {
    const { owner, repo } = splitRepo(input.repo);
    if (input.commentId !== undefined && input.commentId !== null) {
      const base = `/repos/{owner}/{repo}/issues/comments/{comment_id}/reactions`;
      const params: Record<string, unknown> = { owner, repo, comment_id: input.commentId };
      if (input.reactionId !== undefined) {
        params['reaction_id'] = input.reactionId;
      }
      return {
        route:
          input.reactionId === undefined
            ? `${method} ${base}`
            : `${method} ${base}/{reaction_id}`,
        params,
      };
    }
    const base = `/repos/{owner}/{repo}/issues/{issue_number}/reactions`;
    const params: Record<string, unknown> = { owner, repo, issue_number: input.issueNumber };
    if (input.reactionId !== undefined) {
      params['reaction_id'] = input.reactionId;
    }
    return {
      route: input.reactionId === undefined ? `${method} ${base}` : `${method} ${base}/{reaction_id}`,
      params,
    };
  };

  return {
    async addReaction(input): Promise<ReactionRef> {
      const { route, params } = routeOf('POST', input);
      const response = await client.request<RawReaction>(route, { ...params, content: input.content });
      return { id: typeof response.data.id === 'number' ? response.data.id : 0 };
    },

    async listReactions(input): Promise<readonly ReactionEntry[]> {
      const { route, params } = routeOf('GET', input);
      const response = await client.request<readonly RawReaction[]>(route, {
        ...params,
        content: input.content,
        per_page: input.perPage ?? 100,
      });
      const rows = Array.isArray(response.data) ? response.data : [];
      return rows
        .filter((row): row is RawReaction & { id: number } => typeof row.id === 'number')
        .map((row) => ({
          id: row.id,
          content: typeof row.content === 'string' ? row.content : '',
          userLogin: typeof row.user?.login === 'string' ? row.user.login : null,
        }));
    },

    async removeReaction(input): Promise<void> {
      const { route, params } = routeOf('DELETE', input);
      await client.request(route, params);
    },
  };
}

/* ── issue 编辑面：写类 issue 工具的 REST 落点 ─────────────────────────────── */

/** `GET/PATCH /issues/{n}` 里编辑面关心的字段（全部 `unknown` 后逐个收窄）。 */
type RawIssueEdit = { readonly id?: unknown; readonly updated_at?: unknown };

/** `GET /issues/comments/{id}` 的原始返回（回复/改/删都要作者）。 */
type RawIssueCommentDetail = {
  readonly id?: unknown;
  readonly body?: unknown;
  readonly user?: { readonly login?: unknown } | null;
};

/**
 * 判断一个错误是不是 404「不存在」。
 *
 * 为什么需要它：`issueExists()` 要把 404 翻译成 `false`（编号不存在是**业务结论**），
 * 而权限/网络错误必须照抛 —— 把 403 当成「不存在」会让执行器给出「编号写错了」这种
 * 完全错的建议。状态码在 `GithubError.info.status`（`github/errors.ts`），
 * 假客户端可能直接抛 `{ status: 404 }`，两种都认。
 */
function isNotFoundError(error: unknown): boolean {
  if (error instanceof GithubError) {
    return error.info.status === 404;
  }
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const record = error as Record<string, unknown>;
  if (record['status'] === 404) {
    return true;
  }
  const info = record['info'];
  return typeof info === 'object' && info !== null && (info as Record<string, unknown>)['status'] === 404;
}

/**
 * 把 `GithubClient` 适配成 `GithubIssueEditApi`（写类 issue 工具的执行面）。
 *
 * 三条刻意的取舍：
 *  1. **只把给了的字段放进 params**：PATCH 的语义是「给了就覆盖」，把
 *     `title: undefined` 塞进请求既不必要，也让日志里的请求体读不出「到底改了什么」。
 *     `milestone: null` 是例外 —— 它**有语义**（清空里程碑），所以只判 `undefined`。
 *  2. **`duplicate` 的说明评论在这里发**：GitHub 的 PATCH 没有 `duplicate_issue_id`，
 *     「重复」只能靠 `state_reason=duplicate` + 一条指向原 issue 的评论表达。
 *     发在这一层而不是执行器里，是为了保证 `close_issue` 与 `link(duplicate)`
 *     两条入口**都只有一条**说明评论（执行器那边不再补发）。
 *  3. **`getIssueId()` 单独存在**：`sub_issues` / `dependencies/blocked_by` 要的是
 *     issue 的数字 id，不是 number；把它抽出来也让 `issueExists()` 能复用它。
 */
export function createGithubIssueEditApi(client: GithubClient): GithubIssueEditApi {
  const getIssueId = async (input: { readonly repo: string; readonly issueNumber: number }): Promise<number> => {
    const { owner, repo } = splitRepo(input.repo);
    const response = await client.request<RawIssueEdit>('GET /repos/{owner}/{repo}/issues/{issue_number}', {
      owner,
      repo,
      issue_number: input.issueNumber,
    });
    const id = response.data.id;
    if (typeof id !== 'number') {
      // 没有 id 就没法做结构化关联，这里必须炸而不是回 0：0 会被当成一个合法 id 发出去。
      throw new Error(`GitHub 响应缺少 issue id（${input.repo}#${String(input.issueNumber)}）`);
    }
    return id;
  };

  return {
    async updateIssue(input): Promise<{ readonly updatedAt: string }> {
      const { owner, repo } = splitRepo(input.repo);
      const params: Record<string, unknown> = { owner, repo, issue_number: input.issueNumber };
      if (input.title !== undefined) {
        params['title'] = input.title;
      }
      if (input.body !== undefined) {
        params['body'] = input.body;
      }
      if (input.assignees !== undefined) {
        params['assignees'] = [...input.assignees];
      }
      if (input.milestone !== undefined) {
        params['milestone'] = input.milestone;
      }
      const response = await client.request<RawIssueEdit>(
        'PATCH /repos/{owner}/{repo}/issues/{issue_number}',
        params,
      );
      // 拿不到 `updated_at` 就给空串：它是乐观锁的**输入**，空串会让执行器判成冲突，
      // 比编一个当前时间（永远匹配）安全。
      return { updatedAt: typeof response.data.updated_at === 'string' ? response.data.updated_at : '' };
    },

    async getIssueUpdatedAt(input): Promise<string> {
      const { owner, repo } = splitRepo(input.repo);
      const response = await client.request<RawIssueEdit>('GET /repos/{owner}/{repo}/issues/{issue_number}', {
        owner,
        repo,
        issue_number: input.issueNumber,
      });
      return typeof response.data.updated_at === 'string' ? response.data.updated_at : '';
    },

    async reopenIssue(input): Promise<void> {
      const { owner, repo } = splitRepo(input.repo);
      await client.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
        owner,
        repo,
        issue_number: input.issueNumber,
        state: 'open',
        // GitHub 的 `state_reason` 枚举里 `reopened` 是重开的产物，只能这么发。
        state_reason: 'reopened',
      });
    },

    async closeIssueWithReason(input): Promise<void> {
      const { owner, repo } = splitRepo(input.repo);
      await client.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
        owner,
        repo,
        issue_number: input.issueNumber,
        state: 'closed',
        state_reason: input.reason,
      });
      if (input.reason === 'duplicate' && input.duplicateOf !== undefined) {
        await client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
          owner,
          repo,
          issue_number: input.issueNumber,
          body: buildLinkNote({
            relation: 'duplicate',
            repo: input.repo,
            issueNumber: input.issueNumber,
            targetNumber: input.duplicateOf,
          }),
        });
      }
    },

    async getIssueComment(input): Promise<IssueCommentDetail> {
      const { owner, repo } = splitRepo(input.repo);
      const response = await client.request<RawIssueCommentDetail>(
        'GET /repos/{owner}/{repo}/issues/comments/{comment_id}',
        { owner, repo, comment_id: input.commentId },
      );
      const data = response.data ?? {};
      const user = typeof data.user === 'object' && data.user !== null ? data.user : null;
      return {
        id: typeof data.id === 'number' ? data.id : input.commentId,
        authorLogin: typeof user?.login === 'string' ? user.login : null,
        body: typeof data.body === 'string' ? data.body : null,
      };
    },

    async deleteIssueComment(input): Promise<void> {
      const { owner, repo } = splitRepo(input.repo);
      await client.request('DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}', {
        owner,
        repo,
        comment_id: input.commentId,
      });
    },

    getIssueId,

    async issueExists(input): Promise<boolean> {
      try {
        await getIssueId(input);
        return true;
      } catch (error) {
        if (isNotFoundError(error)) {
          return false;
        }
        // 其它错误（403 / 5xx / 网络）照抛：那说明「我们不知道」，不是「不存在」。
        throw error;
      }
    },

    async addBlockedBy(input): Promise<void> {
      const { owner, repo } = splitRepo(input.repo);
      await client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by', {
        owner,
        repo,
        issue_number: input.issueNumber,
        issue_id: input.blockedByIssueId,
      });
    },

    async addSubIssue(input): Promise<void> {
      const { owner, repo } = splitRepo(input.repo);
      await client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues', {
        owner,
        repo,
        // 路径里的 `issue_number` 是**父** issue，body 里的 `sub_issue_id` 是子 issue 的数字 id。
        issue_number: input.parentNumber,
        sub_issue_id: input.subIssueId,
      });
    },
  };
}

/* ── 读面：5 个只读工具的 REST 落点（`tool_calls` 的执行面） ─────────────────── */

/**
 * 一页的缺省条数（20）。
 *
 * 为什么是 20：只读调用的结果要**渲染进下一轮提示词**，而提示词里还要装技能、
 * issue 正文与工具清单。20 条 × 约 80 字 ≈ 1.6k 字，是「够看懂、又挤不掉别的段落」的量级；
 * 要更多就靠 cursor 翻页，而不是一次拉满。
 */
const READ_PAGE_DEFAULT_LIMIT = 20;

/**
 * 一页的上限（50）。
 *
 * 为什么不设成 GitHub 的 `per_page` 上限 100：读工具的结果会进提示词，100 条评论直接
 * 吃掉整轮注入预算（6k 字符），模型反而看不到任务描述本身。这个上限也是
 * `runtime/issue-read-tools.ts` 里 `maxItems` 缺省值的来源。
 */
const READ_PAGE_MAX_LIMIT = 50;

/**
 * 把调用方给的 `limit` 收进 [1, 50]。
 *
 * 超上限**直接截到 50 而不是报错**：读工具不该因为模型多要几条就整轮失败 ——
 * 截断后的结果依然是有效数据，而一次失败会让模型把整轮预算花在换参数重试上。
 */
function clampReadLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) {
    return READ_PAGE_DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), READ_PAGE_MAX_LIMIT);
}

/**
 * cursor → `page`。
 *
 * **cursor 是 `page` 的不透明包装，调用方不许解析**：这里用十进制 page 只是本文件的实现细节，
 * 将来换成 Link 头里的完整 URL 也不该影响任何调用方。认不出来的值退回第 1 页 ——
 * 模型会自己编参数，一个坏 cursor 不该让整轮读工具失败（与「超上限截断而不报错」同一个判断）。
 */
function cursorToPage(cursor: string | null | undefined): number {
  if (cursor === undefined || cursor === null) {
    return 1;
  }
  const matched = /^[1-9]\d{0,5}$/.exec(cursor.trim());
  if (matched === null) {
    return 1;
  }
  return Number.parseInt(matched[0], 10);
}

/**
 * 下一页的 cursor（没有下一页给 `null`）。
 *
 * 两条判据都要满足：GitHub 在 `Link` 头里声明了 `rel="next"`，且这一页**拿满了** `per_page` 条。
 * 只看条数，会在「恰好剩最后一页大小」时多要一次空页；只看 Link 头，则会在代理丢掉
 * Link 时指一个不存在的页 —— 两种都会让模型白花一次调用额度。
 */
function nextCursorOf(
  response: ResponseLike<unknown>,
  page: number,
  rows: number,
  perPage: number,
): string | null {
  if (rows < perPage) {
    return null;
  }
  const link = readHeader(response.headers, 'link');
  if (link === undefined || !/rel="?next"?/.test(link)) {
    return null;
  }
  return String(page + 1);
}

/** 列表/检索里的原始条目（只取渲染需要的字段，全部 `unknown` 后逐个收窄）。 */
type RawIssueReadItem = {
  readonly number?: unknown;
  readonly title?: unknown;
  readonly state?: unknown;
  readonly labels?: unknown;
  readonly updated_at?: unknown;
  readonly pull_request?: unknown;
};

/** `GET /issues/{n}` 的原始返回（详情比列表多正文/作者/指派人/里程碑/创建时间）。 */
type RawIssueReadDetail = RawIssueReadItem & {
  readonly body?: unknown;
  readonly user?: { readonly login?: unknown } | null;
  readonly assignees?: readonly { readonly login?: unknown }[] | null;
  readonly milestone?: { readonly title?: unknown } | null;
  readonly created_at?: unknown;
};

/** `GET /issues/{n}/comments` 的原始条目。 */
type RawIssueReadComment = {
  readonly id?: unknown;
  readonly body?: unknown;
  readonly user?: { readonly login?: unknown } | null;
};

/** `GET /issues/{n}/timeline` 的原始事件（每种 `event` 只用其中几个字段）。 */
type RawTimelineEvent = {
  readonly event?: unknown;
  readonly actor?: { readonly login?: unknown } | null;
  readonly created_at?: unknown;
  readonly label?: { readonly name?: unknown } | null;
  readonly assignee?: { readonly login?: unknown } | null;
  readonly source?: { readonly issue?: { readonly number?: unknown } | null } | null;
  readonly body?: unknown;
};

/** `GET /search/issues` 的原始返回。 */
type RawIssueSearch = {
  readonly total_count?: unknown;
  readonly items?: readonly RawIssueReadItem[] | null;
};

function stringOr(raw: unknown, fallback: string): string {
  return typeof raw === 'string' ? raw : fallback;
}

/** `<user>` / `<actor>` 这类「可能给不出作者」的对象里取 login（幽灵用户给不出）。 */
function loginOf(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record: { readonly login?: unknown } = raw;
  return typeof record.login === 'string' && record.login !== '' ? record.login : null;
}

/** 列表/检索条目 → `IssueListItem`；缺 `number` 的行丢掉（没有编号的条目没法再用）。 */
function mapIssueListItem(row: RawIssueReadItem): IssueListItem | null {
  if (typeof row.number !== 'number') {
    return null;
  }
  return {
    number: row.number,
    title: stringOr(row.title, ''),
    state: stringOr(row.state, 'open'),
    labels: normalizeLabelNames(row.labels),
    updatedAt: stringOr(row.updated_at, ''),
    isPullRequest: row.pull_request !== undefined && row.pull_request !== null,
  };
}

/** 把多行正文压成一行（时间线摘要每行只放一句话）。 */
function oneLine(raw: string, maxChars: number): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxChars)}…`;
}

/**
 * 一条时间线事件 → 一句人能读的话。
 *
 * 为什么在 REST 层就压成一句话：时间线的原始事件有 20 多种 `event`，各自字段完全不同；
 * 让上层（渲染器）认识这些分支，等于把「GitHub 的事件表」复制到提示词那一侧。
 * 不认识的事件直接给事件名 —— 它会显得生硬，但**不会说谎**，也不会丢信息。
 */
function timelineSummaryOf(event: RawTimelineEvent, kind: string): string {
  switch (kind) {
    case 'labeled': {
      const name = event.label?.name;
      return `加了标签 ${typeof name === 'string' ? name : '（未知标签）'}`;
    }
    case 'unlabeled': {
      const name = event.label?.name;
      return `移除了标签 ${typeof name === 'string' ? name : '（未知标签）'}`;
    }
    case 'closed':
      return '状态 → closed';
    case 'reopened':
      return '状态 → open';
    case 'assigned': {
      const login = event.assignee?.login;
      return `指派给 ${typeof login === 'string' ? `@${login}` : '（未知用户）'}`;
    }
    case 'unassigned': {
      const login = event.assignee?.login;
      return `取消指派 ${typeof login === 'string' ? `@${login}` : '（未知用户）'}`;
    }
    case 'cross-referenced':
    case 'referenced': {
      const number = event.source?.issue?.number;
      return typeof number === 'number' ? `引用了 #${String(number)}` : kind;
    }
    case 'commented': {
      const body = typeof event.body === 'string' ? oneLine(event.body, 120) : '';
      return body === '' ? kind : body;
    }
    default:
      return kind;
  }
}

/**
 * 拼搜索的 `q`。
 *
 * 为什么标签要加引号：标签名可以含空格（`good first issue`），不加引号会被 GitHub
 * 解析成两个限定词，检索结果莫名其妙。`state=all` 时**不加** `state:` —— 这是 GitHub
 * 搜索表达「不限状态」的写法（没有 `state:all`）。
 */
function buildSearchQuery(input: {
  readonly repo: string;
  readonly query: string;
  readonly labels?: readonly string[] | undefined;
  readonly state?: 'open' | 'closed' | 'all' | undefined;
}): string {
  const parts = [`repo:${input.repo}`, input.query.trim()];
  for (const label of input.labels ?? []) {
    parts.push(`label:"${label.replace(/"/g, '')}"`);
  }
  if (input.state !== undefined && input.state !== 'all') {
    parts.push(`state:${input.state}`);
  }
  return parts.filter((part) => part !== '').join(' ');
}

/**
 * 把 `GithubClient` 适配成 `GithubIssueReadApi`（5 个只读工具的执行面）。
 *
 * 三条取舍：
 *  1. **列表里不过滤 PR**：REST 的 `/issues` 本来就把 PR 一起返回，文档口径如此；
 *     调用方需要区分时看 `isPullRequest`。在这里静默过滤会让「列出的条数」和
 *     GitHub 页面上看到的不一致，反而更难解释。
 *  2. **每条都做字段收窄**：GitHub 的响应里 `body` 可能为 null、`user` 可能是空对象，
 *     直接喂给渲染器就是一堆 `undefined` 进提示词。
 *  3. **分页只做到「一页 + cursor」**：只为读工具轮服务，调用方按 `nextCursor` 再要一次；
 *     一次性 paginate 到底会不可控地烧掉注入预算。
 */
export function createGithubIssueReadApi(client: GithubClient): GithubIssueReadApi {
  return {
    async getIssueDetail(input): Promise<IssueDetail> {
      const { owner, repo } = splitRepo(input.repo);
      const response = await client.request<RawIssueReadDetail>(
        'GET /repos/{owner}/{repo}/issues/{issue_number}',
        { owner, repo, issue_number: input.issueNumber },
      );
      const data: RawIssueReadDetail = response.data ?? {};
      const assignees: string[] = [];
      if (Array.isArray(data.assignees)) {
        for (const entry of data.assignees) {
          const login = entry.login;
          if (typeof login === 'string' && login !== '') {
            assignees.push(login);
          }
        }
      }
      const milestoneTitle = data.milestone?.title;
      return {
        number: typeof data.number === 'number' ? data.number : input.issueNumber,
        title: stringOr(data.title, ''),
        body: stringOr(data.body, ''),
        state: stringOr(data.state, 'open'),
        labels: normalizeLabelNames(data.labels),
        authorLogin: loginOf(data.user),
        assignees,
        milestone: typeof milestoneTitle === 'string' ? milestoneTitle : null,
        updatedAt: stringOr(data.updated_at, ''),
        createdAt: stringOr(data.created_at, ''),
        isPullRequest: data.pull_request !== undefined && data.pull_request !== null,
      };
    },

    async listIssues(input): Promise<IssuePage<IssueListItem>> {
      const { owner, repo } = splitRepo(input.repo);
      const page = cursorToPage(input.cursor);
      const perPage = clampReadLimit(input.limit);
      const params: Record<string, unknown> = { owner, repo, per_page: perPage, page };
      if (input.state !== undefined) {
        params['state'] = input.state;
      }
      if (input.labels !== undefined && input.labels.length > 0) {
        // REST 的 labels 是逗号分隔字符串（多个标签是「与」），不是数组。
        params['labels'] = input.labels.join(',');
      }
      if (input.assignee !== undefined && input.assignee !== '') {
        params['assignee'] = input.assignee;
      }
      if (input.milestone !== undefined && input.milestone !== '') {
        // `*` / `none` / 里程碑数字编号，全是 GitHub 原生写法，这里只透传。
        params['milestone'] = input.milestone;
      }
      const response = await client.request<readonly RawIssueReadItem[]>(
        'GET /repos/{owner}/{repo}/issues',
        params,
      );
      const rows = Array.isArray(response.data) ? response.data : [];
      const items = rows
        .map(mapIssueListItem)
        .filter((item): item is IssueListItem => item !== null);
      return { items, nextCursor: nextCursorOf(response, page, rows.length, perPage) };
    },

    async listIssueComments(input): Promise<IssuePage<IssueCommentDetail>> {
      const { owner, repo } = splitRepo(input.repo);
      const page = cursorToPage(input.cursor);
      const perPage = clampReadLimit(input.limit);
      const response = await client.request<readonly RawIssueReadComment[]>(
        'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
        { owner, repo, issue_number: input.issueNumber, per_page: perPage, page },
      );
      const rows = Array.isArray(response.data) ? response.data : [];
      const items = rows
        .filter((row): row is RawIssueReadComment & { id: number } => typeof row.id === 'number')
        .map((row) => ({
          id: row.id,
          authorLogin: loginOf(row.user),
          body: typeof row.body === 'string' ? row.body : null,
        }));
      return { items, nextCursor: nextCursorOf(response, page, rows.length, perPage) };
    },

    async getIssueTimeline(input): Promise<IssuePage<TimelineEntry>> {
      const { owner, repo } = splitRepo(input.repo);
      const page = cursorToPage(input.cursor);
      const perPage = clampReadLimit(input.limit);
      const response = await client.request<readonly RawTimelineEvent[]>(
        'GET /repos/{owner}/{repo}/issues/{issue_number}/timeline',
        { owner, repo, issue_number: input.issueNumber, per_page: perPage, page },
      );
      const rows = Array.isArray(response.data) ? response.data : [];
      const items: TimelineEntry[] = rows.map((row) => {
        const kind = stringOr(row.event, 'unknown');
        return {
          kind,
          actorLogin: loginOf(row.actor),
          createdAt: stringOr(row.created_at, ''),
          summary: timelineSummaryOf(row, kind),
        };
      });
      return { items, nextCursor: nextCursorOf(response, page, rows.length, perPage) };
    },

    async searchIssues(input): Promise<{ readonly items: readonly IssueListItem[]; readonly total: number }> {
      // 仍然走一次 `splitRepo`：搜索的 `q` 里带 `repo:owner/name`，非法仓库名不该被拼进查询串。
      const { owner, repo } = splitRepo(input.repo);
      const perPage = clampReadLimit(input.limit);
      const response = await client.request<RawIssueSearch>('GET /search/issues', {
        q: buildSearchQuery({ ...input, repo: `${owner}/${repo}` }),
        per_page: perPage,
      });
      const data: RawIssueSearch = response.data ?? {};
      // 搜索结果**不分页**：`total` 已经告诉模型「还有多少」，翻页靠收紧 query 更省预算。
      const rows = Array.isArray(data.items) ? data.items : [];
      const items = rows
        .map(mapIssueListItem)
        .filter((item): item is IssueListItem => item !== null);
      return {
        items,
        total: typeof data.total_count === 'number' ? data.total_count : items.length,
      };
    },
  };
}
