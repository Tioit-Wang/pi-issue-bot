/**
 * issue 正文/评论里的**引用与提及**处理（纯函数，零 IO）。
 *
 * 为什么单独成文件而不是塞进 `execute.ts`：这四件事全是字符串运算，
 * 而字符串运算最容易写错、也最值得单测 —— 掺进「有副作用的执行器」之后，
 * 想验证「`@someone` 会不会真的把人 @ 到」就必须先造一个假的 GitHub 端口。
 *
 * 四件事，对应 `docs/plan-issue-tools.md` §2 的四条结论：
 *
 *  1. **提及不是工具，是正文语义**：GitHub 的 `#123` / `@user` 由渲染触发，
 *     没有「创建提及」的端点。所以「提及其他 issue / PR」要落在正文处理上：
 *     编号**校验**（不存在就整条拒绝，避免模型编造编号）+ 无关的人**中和**
 *     （不让 agent 随手 @ 一整排人）。
 *  2. **回复评论 = 引用块 + 定向 @**：issue 评论没有 thread 字段
 *     （`in_reply_to_id` 属于 PR review comment），所以「回复」只能这样表达，
 *     格式由平台规定死，模型只写正文。
 *  3. **关联关系兜底**：GitHub 没有原生「相关」结构，`relates` 落成一条带标记的评论；
 *     标记让后续轮次能认出「这条关联是我们写的」。
 *  4. **closing keyword**：`fixes #12` 会在 PR 合并时自动关 issue，人的合并动作
 *     不该被模型一句话牵着走，所以 PR 正文里的 closing keyword 一律中和。
 */

/** 一条 issue / PR 引用（`#123`、`owner/repo#123`、或完整 URL）。 */
export type IssueReference = {
  /** 原文片段（用于错误消息与审计）。 */
  readonly raw: string;
  /** issue / PR 编号。 */
  readonly number: number;
  /** 带仓库前缀时的仓库名（`owner/name`）；没有前缀时 `null`。 */
  readonly repo: string | null;
};

/**
 * 引用编号的模式（三种写法，一次扫）。
 *
 * 顺序有意义：完整 URL 先在，否则 `https://github.com/o/r/issues/12` 里的 `#` 不存在、
 * 但 `r/issues/12` 的 `12` 会被后面的 `#` 规则漏掉。`g` 标志每次 `matchAll` 新建状态。
 */
const REFERENCE_PATTERNS: readonly RegExp[] = [
  // https://github.com/owner/repo/issues/12 或 /pull/12
  /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)/gu,
  // owner/repo#12
  /\b([\w.-]+)\/([\w.-]+)#(\d+)\b/gu,
  // #12（本仓库）
  /(^|[^\w/&#])#(\d+)\b/gu,
];

/** 一条 `@提及`。 */
export type MentionRef = {
  readonly raw: string;
  readonly login: string;
};

/** 兼容 `@user` 与 GitHub 的 `@org/team`（后者按第一个斜杠前段取 login）。 */
const MENTION_PATTERN = /(^|[^\w/`@])@([A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})?)/gu;

/** 零宽空格：插进 login/编号中间，人看不到，但 GitHub 的渲染不再命中提及/引用。 */
const ZWSP = '\u200b';

/**
 * 抽出正文里的全部 issue / PR 引用（去重，按出现顺序）。
 *
 * 只做**抽取**，不做校验：校验要去问 GitHub（编号存不存在），那是执行器的事。
 * 这里纯粹是字符串工作，因此可以单测到每一条正则。
 */
export function findIssueReferences(body: string): IssueReference[] {
  const found: IssueReference[] = [];
  const seen = new Set<string>();
  const push = (reference: IssueReference): void => {
    const key = `${reference.repo ?? ''}#${String(reference.number)}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    found.push(reference);
  };

  for (const match of body.matchAll(REFERENCE_PATTERNS[0] ?? /$^/gu)) {
    const owner = match[1];
    const repo = match[2];
    const number = match[3];
    if (owner === undefined || repo === undefined || number === undefined) continue;
    push({ raw: match[0], number: Number.parseInt(number, 10), repo: `${owner}/${repo}` });
  }
  for (const match of body.matchAll(REFERENCE_PATTERNS[1] ?? /$^/gu)) {
    const owner = match[1];
    const repo = match[2];
    const number = match[3];
    if (owner === undefined || repo === undefined || number === undefined) continue;
    push({ raw: match[0], number: Number.parseInt(number, 10), repo: `${owner}/${repo}` });
  }
  for (const match of body.matchAll(REFERENCE_PATTERNS[2] ?? /$^/gu)) {
    const number = match[2];
    if (number === undefined) continue;
    push({ raw: `#${number}`, number: Number.parseInt(number, 10), repo: null });
  }
  return found;
}

/** 抽出正文里的全部 `@提及`（去重）。 */
export function findMentions(body: string): MentionRef[] {
  const found: MentionRef[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(MENTION_PATTERN)) {
    const candidate = match[2];
    if (candidate === undefined) continue;
    const login = candidate.split('/')[0] ?? candidate;
    if (login === '') continue;
    const key = login.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    found.push({ raw: candidate, login });
  }
  return found;
}

/** 一次提及中和的结果：改写后的正文 + 被中和的 login（进审计）。 */
export type NeutralizeMentionsResult = {
  readonly body: string;
  readonly neutralized: readonly string[];
};

/**
 * 把**不允许**被 @ 到的人中和掉。
 *
 * 为什么是「中和」而不是「拒绝整条」：模型写「@所有人看一下」这类话很常见，
 * 整条拒绝会让它反复重试同一个错；而悄悄删掉 `@` 又会让正文读起来像漏字。
 * 插一个零宽空格既不改变人读到的内容，也不构成提及 —— 这是唯一同时满足
 * 「不打扰人」与「正文仍然可读」的做法。
 *
 * 允许清单由调用方给（issue 作者 + 本轮触发人）：这两类人本来就在等这条回复。
 */
export function neutralizeMentions(body: string, allowedLogins: readonly string[]): NeutralizeMentionsResult {
  const allowed = new Set(allowedLogins.filter((login) => login !== '').map((login) => login.toLowerCase()));
  const neutralized: string[] = [];
  const rewritten = body.replace(MENTION_PATTERN, (whole, prefix: string, candidate: string) => {
    const login = candidate.split('/')[0] ?? candidate;
    if (allowed.has(login.toLowerCase())) {
      return whole;
    }
    neutralized.push(login);
    return `${prefix}@${candidate.startsWith(login) ? ZWSP + candidate : candidate}`;
  });
  return { body: rewritten, neutralized };
}

/**
 * 把 closing keyword（`fixes #12` / `closes #12` / `resolves #12`）中和掉。
 *
 * 只用在 **PR 正文**上：`fixes #12` 会在 PR 合并时自动关闭 issue，而合并是人做的事。
 * agent 一句话把「人肉合并」变成「自动关单」，等于绕过了「关单只发生在 verdict=fail」
 * 这条闸门（§5 第六行）。评论正文不需要它 —— 评论不触发关闭。
 */
export function neutralizeClosingKeywords(body: string): string {
  return body.replace(
    /\b(fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)(\s+)(#\d+)/giu,
    (_whole, keyword: string, space: string, ref: string) => `${keyword}${space}${ZWSP}${ref}`,
  );
}

/**
 * 渲染一条「回复评论」的正文。
 *
 * 格式固定成：
 *
 * ```
 * > **@someone** wrote:
 * > 原评论第一行
 * > 原评论第二行
 *
 * @someone 正文
 * ```
 *
 * 三条约束（`docs/plan-issue-tools.md` R5）：
 *  - 引用块必须**逐行加 `>`**：不加的话原评论里的空行会把引用截断成两段，
 *    人读到的是「半句原文 + 我们的回复」；
 *  - 定向 `@` 一定在正文前：GitHub 的评论折叠后只看得到第一段，
 *    作者名进不去就等于没回复到人；
 *  - 原文按 `maxQuoteChars` 截断并显式标注：不需要把一条三千字的评论整段搬过来。
 */
export function renderReplyBody(input: {
  readonly authorLogin: string | null;
  readonly originalBody: string | null;
  readonly body: string;
  /** 引用原文的最大字数（缺省 400，与提示词里「正文前后 400 字」同口径）。 */
  readonly maxQuoteChars?: number;
}): string {
  const limit = input.maxQuoteChars ?? 400;
  const author = input.authorLogin === null || input.authorLogin === '' ? null : input.authorLogin;
  const quoted = quoteBlock(input.originalBody ?? '', limit);
  const head = author === null ? '> 原评论：' : `> **@${author}** wrote:`;
  const mention = author === null ? '' : `@${author} `;
  const body = input.body.trim();
  if (quoted.length === 0) {
    // 原评论是空正文（只有图片/表情）：不硬造空引用块，但仍然标明回复的是谁。
    return author === null ? body : `${mention}${body}`;
  }
  const quoteLines = [head, ...quoted];
  return [...quoteLines, '', `${mention}${body}`].join('\n');
}

/** 把一段原文变成引用块的行（逐行 `> `，超长截断并标注）。 */
function quoteBlock(raw: string, limit: number): string[] {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return [];
  }
  const chars = [...trimmed];
  const clipped = chars.length > limit ? `${chars.slice(0, limit).join('')}…（原评论共 ${String(chars.length)} 字，已截断）` : trimmed;
  return clipped.split(/\r?\n/u).map((line) => (line.trim() === '' ? '>' : `> ${line}`));
}

/** `link` 关系落成评论时的标记前缀（`<!-- pi-bot:link ... -->`）。 */
export const LINK_MARKER_PREFIX = 'pi-bot:link';

/** 关联评论里关系的说明文案（人读到的那一句）。 */
const LINK_TEXT: Readonly<Record<'duplicate' | 'blocks' | 'blocked_by' | 'parent' | 'relates', string>> = {
  duplicate: '与本仓库的另一个 issue 重复',
  blocks: '会阻塞',
  blocked_by: '被阻塞于',
  parent: '是它的子任务',
  relates: '与它相关',
};

/**
 * 生成一条「结构关系」的兜底评论正文（含隐藏标记）。
 *
 * 只有 `duplicate`（留一条指向原 issue 的说明）与 `relates`（GitHub 无原生结构）
 * 会用到它；`blocks` / `blocked_by` / `parent` 都有原生端点，不该再发散评论 ——
 * 那会让同一个关系在 issue 上出现两次（一次结构、一次文字）。
 *
 * 标记而非标题前缀的理由与槽位一致：`<!-- ... -->` 在渲染结果里不可见，
 * 人读到的是干净的一句话。
 */
export function buildLinkNote(input: {
  readonly relation: 'duplicate' | 'blocks' | 'blocked_by' | 'parent' | 'relates';
  readonly repo: string;
  readonly issueNumber: number;
  readonly targetNumber: number;
}): string {
  const text = `与 #${String(input.targetNumber)} ${LINK_TEXT[input.relation]}。`;
  const marker = `<!-- ${LINK_MARKER_PREFIX} ${input.relation} ${input.repo}#${String(input.issueNumber)}->#${String(input.targetNumber)} -->`;
  return `${text}\n\n${marker}`;
}

/** 一条正文是不是我们写的关联评论（后续轮次识别用）。 */
export function isLinkNote(body: string | null | undefined): boolean {
  return typeof body === 'string' && body.includes(`<!-- ${LINK_MARKER_PREFIX} `);
}
