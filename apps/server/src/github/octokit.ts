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
import { extractErrorHeaders, toGithubError } from './errors.ts';
import {
  FALLBACK_RETRY_AFTER_MS,
  detectMethod,
  parseRateLimitHeaders,
} from './headers.ts';
import type {
  CommentRef,
  GithubClient,
  GithubClientMetrics,
  GithubReactionApi,
  GithubRequest,
  GithubWriteApi,
  IssueComment,
  RateLimitSignal,
  ReactionEntry,
  ReactionRef,
  ReactionTarget,
  ResponseLike,
} from './types.ts';
import { splitRepo } from './types.ts';

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
  };
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
