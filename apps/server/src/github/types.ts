/**
 * GitHub 层的窄接口（B12；对应 tech-plan §5.1–§5.4、§7.3）。
 *
 * 为什么自己声明类型，而不是直接用 Octokit 的类类型：
 *  - 本层**不允许发真实请求**（本机没有 GitHub App、没有网络凭证）。单元测试需要一个
 *    「假的 octokit」来记录调用，如果签名钉死在 `Octokit` 实例上，假实现就得伪造庞大的类。
 *  - 本层不 import `packages/contract`（信封契约由契约 owner session 定义），
 *    这里只描述「写执行器需要的最小形状」；契约 → 本层的映射由 worker 负责。
 * 结论：真实 Octokit 只在 `octokit.ts` 一处被构造，其余模块只认下面的 interface。
 */

/** HTTP 响应头取值（Octokit 的 headers 是普通对象；测试里也可能直接给字符串）。 */
export type HeaderValue = string | number | readonly string[] | null | undefined;

/** HTTP 响应头集合（键名大小写由 `readHeader()` 归一化）。 */
export type HeaderBag = Readonly<Record<string, HeaderValue>>;

/** Octokit 响应的最小切片：我们只关心这四项。 */
export type ResponseLike<T = unknown> = {
  readonly status: number;
  readonly headers: HeaderBag;
  readonly data: T;
};

/** 传给 `request()` 的路径参数与查询参数。 */
export type RequestParams = Readonly<Record<string, unknown>>;

/**
 * 一次 GitHub 调用：`request('POST /repos/{owner}/{repo}/issues', params)`。
 *
 * route 允许带方法前缀（Octokit 的写法）；不带前缀时按 `params.method` 或 GET 处理。
 */
export type GithubRequest = <T = unknown>(
  route: string,
  params?: RequestParams,
) => Promise<ResponseLike<T>>;

/**
 * 调用计数：M0 的「GitHub 零副作用」验收（dev-plan §6 M0 行）读 `nonGetCalls`——
 * dry-run 期间必须恒为 0。计数发生在**发起请求之前**，失败的重试也算一次尝试。
 */
export type GithubClientMetrics = {
  readonly getCalls: number;
  readonly nonGetCalls: number;
};

/** 限流归一化结果：命中限流。`retryAfterMs` 直接喂给 `boss.send(..., { startAfter })`。 */
export type RateLimitSignal = {
  readonly kind: 'rate_limit';
  readonly retryAfterMs: number;
  readonly remaining: number | null;
  readonly resetAtMs: number | null;
  readonly source: 'retry-after' | 'x-ratelimit-reset' | 'fallback';
};

/** 限流归一化结果：未命中限流。 */
export type RateLimitOk = {
  readonly kind: 'ok';
  readonly remaining: number | null;
  readonly resetAtMs: number | null;
};

/** 限流头归一化后的两种状态（tech-plan §7.3 第一行：优先读 `retry-after`）。 */
export type RateLimitState = RateLimitSignal | RateLimitOk;

/** 注入式客户端：http 与 worker session 只依赖这个形状。 */
export type GithubClient = {
  readonly request: GithubRequest;
  getMetrics(): GithubClientMetrics;
  resetMetrics(): void;
};

/** 一条 issue/PR 评论（只取幂等判定需要的字段）。 */
export type IssueComment = {
  readonly id: number;
  readonly body: string | null;
};

/** 新建评论后的引用。 */
export type CommentRef = {
  readonly id: number;
  readonly htmlUrl: string | null;
};

/**
 * 一个 issue / PR 主贴的**只读**快照（`docs/v21-contract.md` §5 的槽位与占位符用）。
 *
 * 为什么要进这一层而不是让调用方自己发请求：v2.1 的槽位/占位符逻辑在
 * `writeback/v21/`（纯逻辑、可单测），它们必须先拿到「这个 issue 现在长什么样」，
 * 但那一层不认识 octokit。把它做成 `GithubWriteApi` 的一个方法，
 * 端口就仍然是「唯一出口」，假实现也仍然只有一处要补。
 *
 * `labels` 归一化成名字字符串（GitHub 返回的是对象数组），
 * `isPullRequest` 来自 `pull_request` 字段是否存在（REST 里 PR 就是 issue）。
 */
export type IssueSnapshot = {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  /** `open` / `closed`（GitHub 目前只有这两个，但保留 string 以免 422 时炸掉）。 */
  readonly state: string;
  readonly labels: readonly string[];
  readonly authorLogin: string | null;
  /** ISO 时间串（`updated_at`）；取不到时是空串。 */
  readonly updatedAt: string;
  readonly isPullRequest: boolean;
};

/**
 * 写执行器依赖的「有副作用的最小动作集」。
 *
 * 真实实现由 `createGithubWriteApi(client)` 给出（走 REST route），测试用假实现记录调用；
 * 这一层刻意**不含** merge —— 本项目没有合并权限，也没有对应代码路径（plan §7.1）。
 */
export type GithubWriteApi = {
  listIssueComments(input: {
    readonly repo: string;
    readonly issueNumber: number;
  }): Promise<readonly IssueComment[]>;
  createIssueComment(input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly body: string;
  }): Promise<CommentRef>;
  addLabels(input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly labels: readonly string[];
  }): Promise<void>;
  removeLabel(input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly label: string;
  }): Promise<void>;
  createIssue(input: {
    readonly repo: string;
    readonly title: string;
    readonly body: string;
    readonly labels?: readonly string[];
  }): Promise<{ readonly number: number }>;
  closeIssue(input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly reason?: 'completed' | 'not_planned';
  }): Promise<void>;
  /**
   * 改一条已存在的评论正文（`docs/v21-contract.md` §5 的槽位语义：同 issue 同槽位只保留一条）。
   *
   * 为什么必须有它：槽位写回的正确行为是「覆盖」而不是「再发一条」。没有 update 的话，
   * 每次触发都会堆一条评论，`recreated` 与「同槽位一条」两个约束都无从实现。
   *
   * 必填而非可选：可选会让每个调用点在运行期判空，而「没有 update 能力」的执行器
   * 实际上无法正确实现槽位语义——宁可让假实现在编译期就补齐。
   */
  updateIssueComment(input: {
    readonly repo: string;
    readonly commentId: number;
    readonly body: string;
  }): Promise<CommentRef>;
  /** 读一个 issue / PR 主贴的快照（纯 GET，无副作用）。 */
  getIssue(input: { readonly repo: string; readonly issueNumber: number }): Promise<IssueSnapshot>;
};

/**
 * GitHub 的 8 种 reaction content（`docs/plan-multi-repo.md` §5 只用前三个里的
 * `eyes` / `rocket` / `confused`；其余保留，方便测试与将来扩展）。
 */
export const REACTION_CONTENTS = [
  '+1',
  '-1',
  'laugh',
  'confused',
  'heart',
  'hooray',
  'rocket',
  'eyes',
] as const;

export type ReactionContent = (typeof REACTION_CONTENTS)[number];

/** `+eyes` 成功后 GitHub 返回的引用（`reaction_id` 落 `issue_feedback`）。 */
export type ReactionRef = {
  readonly id: number;
};

/** 列出来的单条 reaction（删之前要按 `userLogin` 判是不是自己打的）。 */
export type ReactionEntry = {
  readonly id: number;
  readonly content: string;
  readonly userLogin: string | null;
};

/**
 * reaction 的目标。
 *
 * `commentId` 给了就打**评论级** reaction（`/issues/comments/{id}/reactions`），
 * 否则打**主贴**（`/issues/{n}/reactions`，PR 主贴同样走这个端点）。
 *
 * PR review comment 的 reaction 需要 `Pull requests:write`（本方案不引入该权限），
 * 所以 review comment 触发时调用方必须把 reaction 打在主贴上（不传 `commentId`）。
 */
export type ReactionTarget = {
  readonly repo: string;
  readonly issueNumber: number;
  readonly commentId?: number | null;
};

/**
 * reaction 的窄接口（`docs/impl-multi-repo.md` W2-D）。
 *
 * 与 `GithubWriteApi` 分开的理由：既有写面已有多处假实现，往里加两个方法会让
 * 与无感反馈无关的测试一起改签名；reaction 是独立能力，独立注入。
 *
 * 同 content 重复 POST 是幂等的（实测：第一次 201、第二次 200，返回同一个 id），
 * 所以**发之前不需要查重**；`listReactions` 只在「删自己的」与面板回显时才需要。
 */
export type GithubReactionApi = {
  addReaction(input: ReactionTarget & { readonly content: ReactionContent }): Promise<ReactionRef>;
  listReactions(
    input: ReactionTarget & { readonly content: ReactionContent; readonly perPage?: number },
  ): Promise<readonly ReactionEntry[]>;
  removeReaction(input: ReactionTarget & { readonly reactionId: number }): Promise<void>;
};

/** `owner/name` 形式的仓库标识。 */
export type RepoRef = {
  readonly owner: string;
  readonly repo: string;
};

const REPO_PATTERN = /^([\w.-]+)\/([\w.-]+)$/;

/**
 * 把 `owner/name` 拆成 Octokit 的路径参数。
 *
 * 只接受 `owner/name` 两段（GitHub 的仓库全名形态）；不合法直接抛错，
 * 避免把用户输入拼进 URL 路径。
 */
export function splitRepo(fullName: string): RepoRef {
  const matched = REPO_PATTERN.exec(fullName);
  if (!matched) {
    throw new Error(`仓库标识必须是 "owner/name" 形式，收到：${JSON.stringify(fullName)}`);
  }
  const owner = matched[1];
  const repo = matched[2];
  if (owner === undefined || repo === undefined) {
    throw new Error(`仓库标识必须是 "owner/name" 形式，收到：${JSON.stringify(fullName)}`);
  }
  return { owner, repo };
}
