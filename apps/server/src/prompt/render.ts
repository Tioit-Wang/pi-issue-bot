/**
 * 占位符渲染（FR-2.3 / §6.3，接口见 `docs/v21-contract.md` §3）。
 *
 * 与 `agent/message.ts` 的 `renderTemplate`（v0.3 那套 `{名字}`）**刻意不是一套东西**：
 *  - 旧实现有「整行只有一个占位符且解析为空 → 整行消失」的语法糖，那是给内置消息模板排版用的；
 *  - v2.1 的模板是**项目自己写的**（面板里一段纯文本），若有这种隐式删行规则，
 *    用户会看到「我写的段落凭空没了」而找不到原因（FR-2.3 只要求字面替换）。
 * 所以这里只做**字面替换**：模板长什么样，除了占位符替换之外一个字都不改（空白、空行全保留）。
 *
 * 三条硬规则（FR-2.3）：
 * 1. **一次遍历**：`String.prototype.replace` 天然满足——替换进去的值不会被再扫一遍，
 *    所以「评论正文里写了 `{{issue.url}}`」不会被二次替换；
 * 2. **重复占位符全部替换**：正则的 `replace` 逐个回调，不做「只替第一次」的 short-circuit；
 * 3. **未知原样保留**并收集到 `unknown`（调用方记配置告警）：`{{issue.foo}}` 发出去还是那样。
 */

/* ── 1. 占位符清单（§6.3） ─────────────────────────────────────────────────── */

/**
 * 12 个正式占位符（§6.3 的表格，一格一个）。
 *
 * 顺序照需求表格排（issue 族 → repo → actor/event → comment），
 * 让「面板能选哪些占位符」与需求文档逐行对得上；这里只是**清单**，
 * 取值仍在 `resolvePlaceholder()` 的 switch 里，两边由单测绑定（数量 + 逐个可渲染）。
 */
export const PLACEHOLDER_NAMES = [
  'issue.author',
  'issue.number',
  'issue.url',
  'issue.content',
  'issue.labels',
  'issue.title',
  'repo.issues',
  'comment.author',
  'comment.body',
  'repo',
  'actor',
  'event.action',
] as const satisfies readonly string[];

export type PlaceholderName = (typeof PLACEHOLDER_NAMES)[number];

/**
 * 「这个名字是不是正式占位符」的判断视图。
 *
 * 为什么不直接 `PLACEHOLDER_NAMES.includes(name)`：上面的元组是**字面量类型**，
 * `includes()` 的参数被收窄成那 12 个字面量的联合，传一个普通 `string` 会编译不过。
 * 面板做「未知占位符高亮」时拿到的是普通字符串，所以给一份 `ReadonlySet<string>`。
 */
export const PLACEHOLDER_NAME_SET: ReadonlySet<string> = new Set(PLACEHOLDER_NAMES);

/** 一次渲染要用的 issue 快照（事件发生时的版本，§6.3「快照」条）。 */
export type RenderIssue = {
  readonly author: string;
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly content: string;
  /** 保持 GitHub 返回的顺序，不排序（§6.3「顺序」条） */
  readonly labels: readonly string[];
  /** `issue.updated_at`（本期没有对应占位符，留给留痕与幂等用） */
  readonly updatedAt: string;
};

/** 评论快照；非评论事件没有。 */
export type RenderComment = {
  readonly author: string;
  readonly body: string;
};

/**
 * `{{repo.issues}}` 的**同步**来源：调用方已 `await` 过的文本，或一个同步函数。
 *
 * 为什么不在这里 async：渲染器必须是纯同步函数——它同时被 webhook（需要 await）与单元测试
 * （不想为了一个字符串变成 async）调用。异步入口是 `renderTemplateAsync()`，
 * 只有模板里真的出现 `{{repo.issues}}` 时它才去 await（§6.3 的「惰性」要求）。
 */
export type RepoIssuesSource = string | (() => string);

/** 异步入口用的来源（契约 §3 的 `repoIssues?: () => Promise<string>`）。 */
export type RepoIssuesAsyncSource = string | (() => string | Promise<string>);

export type RenderContext = {
  readonly repo: string;
  readonly actor: string;
  /** `opened` / `edited` / `labeled` / `closed` / `created` */
  readonly eventAction: string;
  readonly issue: RenderIssue;
  readonly comment?: RenderComment | undefined;
  /**
   * `undefined` = 本轮没准备 issue 索引。
   * 此时模板里的 `{{repo.issues}}` 按**未知占位符**处理（原样保留 + 记 unknown），
   * 而不是渲染成空串——空串会让模板看起来「正常但少了数据」，没人会发现漏取。
   */
  readonly repoIssues?: RepoIssuesSource | undefined;
};

export type AsyncRenderContext = Omit<RenderContext, 'repoIssues'> & {
  readonly repoIssues?: RepoIssuesAsyncSource | undefined;
};

export type RenderResult = {
  readonly text: string;
  /** 原样保留的占位符名（按首次出现顺序、已去重），调用方据此记配置告警 */
  readonly unknown: readonly string[];
};

/** 占位符语法：`{{a.b_c1}}`（只认字母数字下划线与点，避免把 `{{ 空格 }}` 也当占位符）。 */
const PLACEHOLDER_PATTERN = /\{\{([a-zA-Z0-9_.]+)\}\}/gu;

/** 模板里是否真的写了 `{{repo.issues}}`（惰性求值的判据）。 */
export function needsRepoIssues(template: string): boolean {
  return template.includes('{{repo.issues}}');
}

/** 值统一按字符串输出：`null` / `undefined` 一律空串（§3「所有值做 String()」）。 */
function stringify(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

/** 解析 `{{repo.issues}}`：未准备 → `null`（= 未知占位符）。 */
function resolveRepoIssues(source: RepoIssuesSource | undefined): string | null {
  if (source === undefined) {
    return null;
  }
  if (typeof source === 'string') {
    return source;
  }
  const produced: unknown = source();
  if (typeof produced === 'string') {
    return produced;
  }
  // 走到这里说明调用方把**异步**来源塞进了同步渲染（类型不允许，但 `as any` 或 JS 调用方可以）。
  // 不 throw、不 await：按「未解析」处理（保留占位符 + 记 unknown），并挂一个空 catch，
  // 免得那个已经启动的 Promise 变成 unhandled rejection 把进程日志刷满。
  if (typeof (produced as { readonly catch?: unknown }).catch === 'function') {
    void (produced as Promise<unknown>).catch(() => undefined);
  }
  return null;
}

/**
 * 按名字取值；`null` = 未知（原样保留）。
 *
 * `comment.*` 在没有评论（非评论事件）时是**已知但为空**：渲染成空串而不是未知，
 * 因为配置里写 `{{comment.author}}` 是合法模板，只是这次事件没有评论可填。
 */
function resolvePlaceholder(name: string, ctx: RenderContext): string | null {
  switch (name) {
    case 'repo':
      return stringify(ctx.repo);
    case 'actor':
      return stringify(ctx.actor);
    case 'event.action':
      return stringify(ctx.eventAction);
    case 'issue.author':
      return stringify(ctx.issue.author);
    case 'issue.number':
      return stringify(ctx.issue.number);
    case 'issue.url':
      return stringify(ctx.issue.url);
    case 'issue.title':
      return stringify(ctx.issue.title);
    case 'issue.content':
      return stringify(ctx.issue.content);
    case 'issue.labels':
      // 逗号 + 空格分隔；空集为空串（**不填「无」**，§6.3「格式」条）
      return (ctx.issue.labels ?? []).map((label) => stringify(label)).join(', ');
    case 'comment.author':
      return stringify(ctx.comment?.author);
    case 'comment.body':
      return stringify(ctx.comment?.body);
    case 'repo.issues':
      return resolveRepoIssues(ctx.repoIssues);
    default:
      return null;
  }
}

/**
 * 渲染模板（同步）。
 *
 * 一次 `replace` 走完整个模板：这是「替换结果不参与二次替换」的**实现级**保证
 * （若改成 `for (name of names) text = text.replaceAll(...)`，先替换的值就会被后一个名字扫到）。
 */
export function renderTemplate(template: string, ctx: RenderContext): RenderResult {
  const unknown: string[] = [];
  const seen = new Set<string>();
  const text = template.replace(PLACEHOLDER_PATTERN, (match, rawName: string) => {
    const value = resolvePlaceholder(rawName, ctx);
    if (value === null) {
      if (!seen.has(rawName)) {
        seen.add(rawName);
        unknown.push(rawName);
      }
      return match;
    }
    return value;
  });
  return { text, unknown };
}

/**
 * 异步渲染：只为 `{{repo.issues}}` 存在。
 *
 * 惰性（§6.3）：模板里没写这个占位符时**根本不会调用** `repoIssues`——
 * 否则每条事件都要跑一两次分页请求，而绝大多数模板并不需要 issue 索引。
 */
export async function renderTemplateAsync(template: string, ctx: AsyncRenderContext): Promise<RenderResult> {
  const source = ctx.repoIssues;
  let resolved: RepoIssuesSource | undefined;
  if (typeof source === 'function') {
    // 没写就不调用；写了才 await，并把结果交给同步渲染（同步渲染只认字符串）
    resolved = needsRepoIssues(template) ? await source() : undefined;
  } else {
    resolved = source;
  }
  const syncContext: RenderContext = { ...ctx, repoIssues: resolved };
  return renderTemplate(template, syncContext);
}
