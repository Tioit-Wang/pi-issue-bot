/**
 * `{{repo.issues}}` 的数据源与项目级缓存（§6.3「issue 列表的规模控制」/ §3 第 5 条）。
 *
 * 这个占位符和 `{{issue.labels}}` 不是一回事：标签最多十几个，issue 可能几千条。
 * 所以这里有四条**硬约束**，缺一条这个占位符在真实仓库上就不可用：
 *  1. **只给索引**：编号 + 状态 + 标题，不带正文/评论/标签（要正文就自己去读那一条）；
 *  2. **仅 open**：已关闭的不参与判重；
 *  3. **上限 200 条**：按更新时间倒序截断，超出时末尾补一行说明总数；
 *  4. **排除 PR**：GitHub 的 issues 接口会把 PR 混进来，必须过滤。
 *
 * 另两条工程约束（§6.3「惰性 / 缓存」）：
 *  - **惰性**由调用方保证（`prompt/render.ts` 的 `needsRepoIssues()` 判模板里有没有写）；
 *    本模块只负责「真要数据时怎么取」；
 *  - **缓存 5 分钟 + 同一波并发只发一次**：一次 webhook 风暴里几十条事件共用一份列表，
 *    判重不需要秒级新鲜度。
 */
/** 列表里的一项：只要索引字段，**不带正文/评论/标签**（§6.3「字段」条）。 */
export type RepoIssueEntry = {
  readonly number: number;
  readonly title: string;
  /** GitHub 的 `state`（只会是 `open`，仍原样带上以便留痕对得上） */
  readonly state: string;
  /** GitHub 的 issues 接口会把 PR 混进来，靠这个字段过滤 */
  readonly isPullRequest: boolean;
  /** `updated_at`（ISO 8601），排序依据 */
  readonly updatedAt: string;
};

/** 列 issue 的能力（形状对齐 `GitHubClient` 的 `listIssues`，实现由集成侧注入）。 */
export type RepoIssuesLister = (input: {
  readonly repo: string;
  readonly state: 'open';
  readonly perPage: number;
  readonly page: number;
}) => Promise<{ readonly total: number; readonly items: readonly RepoIssueEntry[] }>;

/** 列表上限（§6.3 表格：200 条）。 */
export const REPO_ISSUES_MAX_ITEMS = 200;

/** 单页条数：GitHub 允许到 100，取满能少发一半请求。 */
export const REPO_ISSUES_PER_PAGE = 100;

/** 最多翻几页（100 × 2 = 200，正好覆盖上限；再翻就只是为了拿 `total`，不值）。 */
export const REPO_ISSUES_MAX_PAGES = 2;

/** 默认缓存时长：5 分钟（§6.3「缓存」条）。 */
export const REPO_ISSUES_DEFAULT_TTL_MS = 5 * 60 * 1000;

/** 注入的依赖：只取「列 issue」这一个能力，不把整个 octokit 拉进来（单测直接给假实现）。 */
export type RepoIssuesDeps = {
  readonly listIssues: RepoIssuesLister;
  /** 时钟（默认 `Date.now`）：单测里拨快时间验证过期，不用真等 5 分钟 */
  readonly now?: (() => number) | undefined;
  /** 缓存时长（默认 5 分钟） */
  readonly ttlMs?: number | undefined;
};

export type RepoIssuesProvider = {
  /** 取渲染好的列表文本（只含列表行与可能的截断说明；空列表为空串） */
  render(repo: string): Promise<string>;
  /** 让缓存失效；不传 `repo` = 全清。在途请求不会被取消，但它的结果不会覆盖新缓存 */
  invalidate(repo?: string): void;
};

type CacheEntry = {
  readonly text: string;
  readonly expiresAt: number;
};

/** `updatedAt` 倒序（相同时间按编号倒序，保证同一份数据两次渲染结果稳定可比对）。 */
function byUpdatedAtDesc(a: RepoIssueEntry, b: RepoIssueEntry): number {
  const left = Number.isNaN(Date.parse(a.updatedAt)) ? 0 : Date.parse(a.updatedAt);
  const right = Number.isNaN(Date.parse(b.updatedAt)) ? 0 : Date.parse(b.updatedAt);
  if (left !== right) {
    return right - left;
  }
  return b.number - a.number;
}

/** 一行一条：`#1942 [open] 导出按钮点击后闪退`（§6.3「渲染形态」）。 */
function renderLine(entry: RepoIssueEntry): string {
  const state = entry.state.trim() === '' ? 'open' : entry.state.trim();
  return `#${entry.number} [${state}] ${entry.title}`;
}

/**
 * 建一个项目级 issue 索引提供者。
 *
 * 为什么缓存键是「仓库全名」而不是「仓库 + 分支」：issue 是仓库级实体，与分支无关。
 */
export function createRepoIssuesProvider(deps: RepoIssuesDeps): RepoIssuesProvider {
  const now = deps.now ?? ((): number => Date.now());
  const ttlMs = deps.ttlMs ?? REPO_ISSUES_DEFAULT_TTL_MS;

  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<string>>();
  /**
   * 代数：`invalidate()` 时自增。
   *
   * 为什么需要它：在途请求无法取消，它 resolve 之后会写缓存。若不管代数，
   * `invalidate()` 之后紧接着完成的旧请求会把**旧数据**写回缓存，等于失效没生效
   * （典型时序：人刚关掉一个 issue → 面板点刷新 → 又看到它还在）。
   */
  const generations = new Map<string, number>();

  async function load(key: string, generation: number): Promise<string> {
    const collected: RepoIssueEntry[] = [];
    let total = 0;
    for (let page = 1; page <= REPO_ISSUES_MAX_PAGES; page += 1) {
      const result = await deps.listIssues({ repo: key, state: 'open', perPage: REPO_ISSUES_PER_PAGE, page });
      // `total` 每页都一样（GitHub 语义），取最后一次赋值即可
      total = result.total;
      collected.push(...result.items);
      // 本页没取满 = 没有下一页；已够上限也不必再翻
      if (result.items.length < REPO_ISSUES_PER_PAGE || collected.length >= REPO_ISSUES_MAX_ITEMS) {
        break;
      }
    }

    const openIssues = collected
      .filter((entry) => !entry.isPullRequest)
      .sort(byUpdatedAtDesc)
      .slice(0, REPO_ISSUES_MAX_ITEMS);

    const lines = openIssues.map(renderLine);
    // 超限时才补说明行（未超限补了会让人以为还有没列出来的）
    if (total > REPO_ISSUES_MAX_ITEMS) {
      lines.push(`（共 ${total} 条，仅列最近 ${REPO_ISSUES_MAX_ITEMS} 条）`);
    }
    const text = lines.join('\n');

    // 只有「代数没变」才写缓存：过期失效与主动失效都不会被旧结果覆盖
    if ((generations.get(key) ?? 0) === generation) {
      cache.set(key, { text, expiresAt: now() + ttlMs });
    }
    return text;
  }

  return {
    render(repo: string): Promise<string> {
      const key = repo.trim();
      const cached = cache.get(key);
      if (cached !== undefined && cached.expiresAt > now()) {
        return Promise.resolve(cached.text);
      }
      const running = inflight.get(key);
      if (running !== undefined) {
        return running;
      }
      const generation = generations.get(key) ?? 0;
      // 显式标注类型：`finally` 的回调里要引用自身（判断「我是不是当前那一份」），
      // 不标注类型时 TS 会因自引用报「无法推断类型」。
      const task: Promise<string> = load(key, generation).finally(() => {
        // 只清自己这一份，避免把「失效后重新发起」的新请求误删
        if (inflight.get(key) === task) {
          inflight.delete(key);
        }
      });
      inflight.set(key, task);
      return task;
    },

    invalidate(repo?: string): void {
      if (repo === undefined) {
        cache.clear();
        for (const key of generations.keys()) {
          generations.set(key, (generations.get(key) ?? 0) + 1);
        }
        return;
      }
      const key = repo.trim();
      cache.delete(key);
      generations.set(key, (generations.get(key) ?? 0) + 1);
    },
  };
}
