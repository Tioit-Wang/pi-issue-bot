/**
 * 只读工具轮的单次执行：`tool_calls` 里的一条 → 一次 `GithubIssueReadApi` 调用 → 一段给模型看的文本。
 *
 * 为什么需要这一层（而不是让 run-task 直接调 api）：
 *  - **绝不抛异常**。模型会给出非法参数（`number: "abc"`、未知工具名），GitHub 也会 404/403/5xx。
 *    这些都不该杀掉整轮 —— 模型必须看到「错在哪、换个什么参数」再试。所以本文件把所有失败
 *    都收成 `ok:false` + 错误码，让编排层（`issue-tool-loop.ts`）与审计层各自读自己想读的字段。
 *  - **渲染集中在一处**。进提示词的每一行都是「人/模型读到的一句话」，格式要能一眼看出
 *    编号、状态、标签、时间；散落在各处拼字符串必然漂移。
 *  - **截断在这儿做**。单条正文 400 字、单次最多 20 条，与 `issue-tool-loop.ts` 的字符预算
 *    是两层闸门：这里保证「单条不失控」，那里保证「累计不超过 6k」。
 *
 * 依赖方向：本文件只认 `GithubIssueReadApi` 这一个 type-only import，不 import github 的实现、
 * 不发请求、不读时钟 —— 于是单测可以塞一个纯假的 api。
 */

import { ISSUE_TOOLS } from '../../../../packages/contract/src/index.ts';

/*
 * 这里只导入**类型**（`verbatimModuleSyntax` 会把 `import type` 整体擦除），运行时不存在
 * runtime → github 的依赖；门禁要挡的是「runtime 装配执行面实现」这件事，读工具的**接口形状**
 * 反而必须与 github 侧同一份定义 —— 抄一份过来必然漂移，而且接线处看不出差异。
 * 单测因此也只需要一个结构等价的假 api，不需要引入 octokit。
 */
// eslint-disable-next-line import-x/no-restricted-paths -- 仅类型导入，编译期擦除，不产生运行时依赖
import type { GithubIssueReadApi } from '../github/types.ts';

/**
 * 5 个只读工具的名字（`IssueGet` / `IssueList` / `IssueCommentsList` / `IssueTimeline` / `IssueSearch`）。
 *
 * 为什么从契约的工具目录里筛，而不是抄一份字面量：工具名是「模型会写什么」的事实源，
 * 抄一份就多一处必然漂移的清单（信封侧另有一份 `ISSUE_READ_TOOL_NAMES`，两份一旦不一致，
 * 校验通过的名字可能在执行侧变成 `unknown-tool`）。判据取「读组 + 检索组」而不是
 * `write === false`：将来若有新的只读类工具，不该被悄悄塞进读工具轮。
 */
export const ISSUE_READ_TOOL_NAMES: readonly string[] = ISSUE_TOOLS.filter(
  (tool) => tool.group === 'read' || tool.group === 'search',
).map((tool) => tool.name);

/** 一次调用的入参（`name` 是模型给的原文，未知名字也要能原样回显给审计）。 */
export type IssueReadCall = { readonly name: string; readonly input: Readonly<Record<string, unknown>> };

/** 一次调用的结果。 */
export type IssueReadResult = {
  readonly name: string;
  readonly ok: boolean;
  /** 一行摘要（进 `run_events` 与日志）：`IssueCommentsList #331 → 20 条`。 */
  readonly summary: string;
  /** 实际渲染进 `text` 的条目数（`IssueGet` 给 1，失败给 0）。 */
  readonly items: number;
  /** 渲染给模型的正文（已截断；失败时是错误说明）。 */
  readonly text: string;
  /** 是否真的截过东西（条数或正文）；没截过就是 `false`。 */
  readonly truncated: boolean;
  /** `ok:false` 时的错误码（`bad-input` / `github_error` / `unknown-tool`），进审计。 */
  readonly errorCode?: string | undefined;
};

/** 执行器：签名里只有一次调用，轮次与累计预算由 `issue-tool-loop.ts` 管。 */
export type IssueReadExecutor = (call: IssueReadCall) => Promise<IssueReadResult>;

/** 单次与单条的渲染上限。 */
export type IssueReadLimits = { readonly maxItems: number; readonly maxBodyChars: number };

/**
 * 缺省上限：20 条 / 400 字。
 *
 * 为什么是这两个数：一次只读调用的结果要在下一轮提示词里与技能、issue 正文竞争空间（整轮 6k 字符）。
 * 20 条 × 约 80 字已经把「列表类结果」的合理阅读量占满；400 字够读完一条评论的结论，
 * 又不至于让一条长评论独占整轮预算。
 */
export const DEFAULT_ISSUE_READ_LIMITS: IssueReadLimits = { maxItems: 20, maxBodyChars: 400 };

/** 截断标记（条数截断与正文截断共用同一个字面量，测试与面板按它找）。 */
export const TRUNCATION_SUFFIX = '…（已截断）';

/** 渲染的一行（`truncated` 表示这一行本身被压过）。 */
type RenderedLine = { readonly line: string; readonly truncated: boolean };

/**
 * 建一个「按工具名执行一次只读调用」的执行器。
 *
 * `bindings.repo` 是平台注入的当前仓库：模型的 `tool_calls` 里**没有** `repo`（模型不该、
 * 也不需要知道仓库全名，写错就是读到别的仓库）。为兼容两种接线方式 `input.repo` 也接受，
 * 但它同样只当作平台传下来的值。
 */
export function createIssueReadExecutor(
  api: GithubIssueReadApi,
  limits: Partial<IssueReadLimits> = {},
  bindings: { readonly repo?: string | undefined } = {},
): IssueReadExecutor {
  const maxItems = normalizeBudget(limits.maxItems, DEFAULT_ISSUE_READ_LIMITS.maxItems);
  const maxBodyChars = normalizeBudget(limits.maxBodyChars, DEFAULT_ISSUE_READ_LIMITS.maxBodyChars);

  return async (call: IssueReadCall): Promise<IssueReadResult> => {
    const name = typeof call.name === 'string' ? call.name.trim() : '';
    const input = call.input;

    if (!ISSUE_READ_TOOL_NAMES.includes(name)) {
      // 未知工具名是**模型的错**，不是平台崩溃：回一段可用清单，它会自己改。
      return {
        name: name === '' ? 'unknown' : name,
        ok: false,
        summary: `${name === '' ? 'unknown' : name} → 未知工具`,
        items: 0,
        text: `未知工具：${name === '' ? '（空）' : name}。可用的只读工具只有：${ISSUE_READ_TOOL_NAMES.join(' / ')}。`,
        truncated: false,
        errorCode: 'unknown-tool',
      };
    }

    const repo = bindings.repo ?? readString(input['repo']);
    if (repo === null || repo === '') {
      return badInput(
        name,
        '',
        '缺少 repo：只读调用必须由平台绑定仓库（`owner/name`），模型不需要也不应该自己写。',
      );
    }

    try {
      switch (name) {
        case 'IssueGet':
          return await runIssueGet(api, repo, input, maxBodyChars);
        case 'IssueList':
          return await runIssueList(api, repo, input, maxItems);
        case 'IssueCommentsList':
          return await runIssueCommentsList(api, repo, input, maxItems, maxBodyChars);
        case 'IssueTimeline':
          return await runIssueTimeline(api, repo, input, maxItems);
        case 'IssueSearch':
          return await runIssueSearch(api, repo, input, maxItems);
        default:
          // 理论到不了（上面已筛过名字），但 switch 需要一个穷尽出口。
          return badInput(name, '', `未实现的只读工具：${name}。`);
      }
    } catch (error) {
      return githubFailure(name, targetOf(input), error);
    }
  };
}

/* ── 每个工具：校验入参 → 调 api → 渲染 ─────────────────────────────────────── */

async function runIssueGet(
  api: GithubIssueReadApi,
  repo: string,
  input: Readonly<Record<string, unknown>>,
  maxBodyChars: number,
): Promise<IssueReadResult> {
  const issueNumber = readPositiveInt(input['number']);
  if (issueNumber === null) {
    return badInput('IssueGet', targetOf(input), '`number` 必须是正整数（issue 编号），例如 331。');
  }
  const detail = await api.getIssueDetail({ repo, issueNumber });
  const head = `#${String(detail.number)} [${detail.state}] ${detail.title}（${dateOnly(detail.updatedAt)} 更新）`;
  const labels = detail.labels.length === 0 ? 'labels: 无' : `labels: ${detail.labels.join(',')}`;
  const assignees =
    detail.assignees.length === 0
      ? '指派: 无'
      : `指派: ${detail.assignees.map((login) => `@${login}`).join(',')}`;
  const meta = [
    labels,
    `作者: ${detail.authorLogin === null ? '未知' : `@${detail.authorLogin}`}`,
    assignees,
    `里程碑: ${detail.milestone ?? '无'}`,
    `创建: ${dateOnly(detail.createdAt)}`,
    detail.isPullRequest ? '类型: PR' : '类型: issue',
  ].join(' ｜ ');
  const body = truncateText(detail.body, maxBodyChars);
  return {
    name: 'IssueGet',
    ok: true,
    summary: `IssueGet #${String(detail.number)} → 1 条`,
    items: 1,
    text: [head, meta, `正文: ${body.text}`].join('\n'),
    truncated: body.truncated,
  };
}

async function runIssueList(
  api: GithubIssueReadApi,
  repo: string,
  input: Readonly<Record<string, unknown>>,
  maxItems: number,
): Promise<IssueReadResult> {
  const parsed = parseListFilters(input);
  if (!parsed.ok) {
    return badInput('IssueList', '', parsed.message);
  }
  const page = await api.listIssues({
    repo,
    state: parsed.state,
    labels: parsed.labels,
    assignee: parsed.assignee,
    milestone: parsed.milestone,
    cursor: parsed.cursor,
    limit: clampLimit(input['limit'], maxItems),
  });
  const target = parsed.state === undefined ? 'IssueList' : `IssueList（state:${parsed.state}）`;
  const rendered = renderItems(page.items, maxItems, renderIssueListItem);
  return {
    name: 'IssueList',
    ok: true,
    summary: `${target} → ${String(rendered.items)} 条`,
    items: rendered.items,
    text: rendered.lines.join('\n'),
    truncated: rendered.truncated || page.nextCursor !== null,
  };
}

async function runIssueCommentsList(
  api: GithubIssueReadApi,
  repo: string,
  input: Readonly<Record<string, unknown>>,
  maxItems: number,
  maxBodyChars: number,
): Promise<IssueReadResult> {
  const issueNumber = readPositiveInt(input['number']);
  if (issueNumber === null) {
    return badInput('IssueCommentsList', targetOf(input), '`number` 必须是正整数（issue 编号），例如 331。');
  }
  const cursor = readCursor(input['cursor']);
  if (cursor === undefined && input['cursor'] !== undefined && input['cursor'] !== null) {
    return badInput('IssueCommentsList', targetOf(input), '`cursor` 必须是上一次结果里原样给出的字符串。');
  }
  const page = await api.listIssueComments({
    repo,
    issueNumber,
    cursor,
    limit: clampLimit(input['limit'], maxItems),
  });
  const rendered = renderItems(page.items, maxItems, (comment): RenderedLine => {
    const body = truncateText(comment.body ?? '', maxBodyChars);
    const author = comment.authorLogin === null ? '@未知' : `@${comment.authorLogin}`;
    return { line: `comment_id=${String(comment.id)} ${author}：${body.text}`, truncated: body.truncated };
  });
  return {
    name: 'IssueCommentsList',
    ok: true,
    summary: `IssueCommentsList #${String(issueNumber)} → ${String(rendered.items)} 条`,
    items: rendered.items,
    text: rendered.lines.join('\n'),
    truncated: rendered.truncated || page.nextCursor !== null,
  };
}

async function runIssueTimeline(
  api: GithubIssueReadApi,
  repo: string,
  input: Readonly<Record<string, unknown>>,
  maxItems: number,
): Promise<IssueReadResult> {
  const issueNumber = readPositiveInt(input['number']);
  if (issueNumber === null) {
    return badInput('IssueTimeline', targetOf(input), '`number` 必须是正整数（issue 编号），例如 331。');
  }
  const cursor = readCursor(input['cursor']);
  if (cursor === undefined && input['cursor'] !== undefined && input['cursor'] !== null) {
    return badInput('IssueTimeline', targetOf(input), '`cursor` 必须是上一次结果里原样给出的字符串。');
  }
  const page = await api.getIssueTimeline({
    repo,
    issueNumber,
    cursor,
    limit: clampLimit(input['limit'], maxItems),
  });
  const rendered = renderItems(page.items, maxItems, (entry): RenderedLine => {
    const actor = entry.actorLogin === null ? '' : ` @${entry.actorLogin}`;
    return { line: `${dateOnly(entry.createdAt)}${actor}：${entry.summary}`, truncated: false };
  });
  return {
    name: 'IssueTimeline',
    ok: true,
    summary: `IssueTimeline #${String(issueNumber)} → ${String(rendered.items)} 条`,
    items: rendered.items,
    text: rendered.lines.join('\n'),
    truncated: rendered.truncated || page.nextCursor !== null,
  };
}

async function runIssueSearch(
  api: GithubIssueReadApi,
  repo: string,
  input: Readonly<Record<string, unknown>>,
  maxItems: number,
): Promise<IssueReadResult> {
  const query = readString(input['query']);
  if (query === null || query.trim() === '') {
    return badInput(
      'IssueSearch',
      '',
      '`query` 必须是非空字符串（关键词，不要自己写 `repo:` —— 平台会加）。',
    );
  }
  const parsed = parseListFilters(input);
  if (!parsed.ok) {
    return badInput('IssueSearch', '', parsed.message);
  }
  const result = await api.searchIssues({
    repo,
    query: query.trim(),
    labels: parsed.labels,
    state: parsed.state,
    limit: clampLimit(input['limit'], maxItems),
  });
  const rendered = renderItems(result.items, maxItems, renderIssueListItem);
  const head = `共 ${String(result.total)} 条命中，返回前 ${String(rendered.items)} 条`;
  return {
    name: 'IssueSearch',
    ok: true,
    summary: `IssueSearch "${query.trim()}" → ${String(rendered.items)}/${String(result.total)} 条`,
    items: rendered.items,
    text: [head, ...rendered.lines].join('\n'),
    truncated: rendered.truncated || result.items.length < result.total,
  };
}

/* ── 渲染 ──────────────────────────────────────────────────────────────────── */

/**
 * 列表/检索里的一行。
 *
 * 形如 `#331 [open] 标题（labels: bug,ui）（2026-11-01 更新）（PR）`：编号/状态在前，
 * 模型扫一眼就能挑出要深读的那条；PR 单独标出来，因为「列表里混着 PR」是 REST 的原生行为。
 */
function renderIssueListItem(item: {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly labels: readonly string[];
  readonly updatedAt: string;
  readonly isPullRequest?: boolean | undefined;
}): RenderedLine {
  const labels = item.labels.length === 0 ? 'labels: 无' : `labels: ${item.labels.join(',')}`;
  const pr = item.isPullRequest === true ? '（PR）' : '';
  return {
    line: `#${String(item.number)} [${item.state}] ${item.title}（${labels}）（${dateOnly(item.updatedAt)} 更新）${pr}`,
    truncated: false,
  };
}

/**
 * 按 `maxItems` 截条目，并在截断时补一行标记。
 *
 * 为什么在**条目边界**截：半条 issue 标题比没有这条更误导（模型会以为标题就这么短）。
 */
function renderItems<T>(
  items: readonly T[],
  maxItems: number,
  render: (item: T) => RenderedLine,
): { readonly lines: readonly string[]; readonly items: number; readonly truncated: boolean } {
  const kept = items.slice(0, maxItems);
  const lines: string[] = [];
  let truncated = kept.length < items.length;
  for (const item of kept) {
    const rendered = render(item);
    lines.push(rendered.line);
    truncated = truncated || rendered.truncated;
  }
  if (lines.length === 0) {
    lines.push('（没有结果）');
  }
  if (kept.length < items.length) {
    lines.push(`${TRUNCATION_SUFFIX} 只显示前 ${String(kept.length)} 条，共 ${String(items.length)} 条`);
  }
  return { lines, items: kept.length, truncated };
}

/**
 * 截一段正文（压成一行 + 按字数截）。
 *
 * 为什么压成一行：多行评论会把工具结果段撑成「看起来像新指令」的一大块，
 * 而围栏只护住整段的一次性说明；一行一条也让「哪条评论说了什么」更容易对齐。
 */
function truncateText(raw: string, maxChars: number): { readonly text: string; readonly truncated: boolean } {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (maxChars <= 0 || collapsed.length <= maxChars) {
    return { text: collapsed === '' ? '（空）' : collapsed, truncated: false };
  }
  return { text: `${collapsed.slice(0, maxChars)}${TRUNCATION_SUFFIX}`, truncated: true };
}

/** ISO 时间 → `2026-11-01`；给不出就写「未知时间」（空串进提示词会被读成「没有时间」）。 */
function dateOnly(raw: string): string {
  const matched = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  return matched?.[1] ?? '未知时间';
}

/* ── 入参校验 ──────────────────────────────────────────────────────────────── */

const ALLOWED_STATES = ['open', 'closed', 'all'] as const;

type FilterParse =
  | {
      readonly ok: true;
      readonly state: 'open' | 'closed' | 'all' | undefined;
      readonly labels: readonly string[] | undefined;
      readonly assignee: string | undefined;
      readonly milestone: string | undefined;
      readonly cursor: string | null | undefined;
    }
  | { readonly ok: false; readonly message: string };

/**
 * 解析列表/检索共用的筛选参数。
 *
 * 为什么不合法就 `bad-input`（而不是悄悄丢掉）：`state: "opened"` 被忽略后，模型会拿到
 * 一批状态不对的 issue 而完全不知道为什么 —— 报错才能让它改对参数。
 */
function parseListFilters(input: Readonly<Record<string, unknown>>): FilterParse {
  let state: 'open' | 'closed' | 'all' | undefined;
  const rawState = input['state'];
  if (rawState !== undefined && rawState !== null) {
    const normalized = readString(rawState)?.trim().toLowerCase() ?? '';
    const matched = ALLOWED_STATES.find((candidate) => candidate === normalized);
    if (matched === undefined) {
      return {
        ok: false,
        message: `\`state\` 只能是 ${ALLOWED_STATES.join(' / ')}，收到：${String(rawState)}`,
      };
    }
    state = matched;
  }

  let labels: readonly string[] | undefined;
  const rawLabels = input['labels'];
  if (Array.isArray(rawLabels)) {
    labels = rawLabels.filter((label): label is string => typeof label === 'string' && label !== '');
  } else if (typeof rawLabels === 'string' && rawLabels !== '') {
    // 模型常把数组写成 "bug,ui"；拆开它比拒绝更有用。
    labels = rawLabels
      .split(',')
      .map((label) => label.trim())
      .filter((label) => label !== '');
  } else if (rawLabels !== undefined && rawLabels !== null) {
    return { ok: false, message: '`labels` 必须是字符串数组（例如 ["bug","ui"]）。' };
  }
  // 空数组等价于「没筛标签」：把 `labels: []` 原样发给 GitHub 会返回零条（它是「与」语义）。
  const resolvedLabels = labels !== undefined && labels.length === 0 ? undefined : labels;

  const assignee = parseOptionalString(input['assignee'], 'assignee');
  if (assignee !== null && !assignee.ok) {
    return { ok: false, message: assignee.message };
  }
  const milestone = parseOptionalString(input['milestone'], 'milestone');
  if (milestone !== null && !milestone.ok) {
    return { ok: false, message: milestone.message };
  }
  const cursor = readCursor(input['cursor']);
  if (cursor === undefined && input['cursor'] !== undefined && input['cursor'] !== null) {
    return { ok: false, message: '`cursor` 必须是上一次结果里原样给出的字符串。' };
  }

  return {
    ok: true,
    state,
    labels: resolvedLabels,
    assignee: assignee === null ? undefined : assignee.value,
    milestone: milestone === null ? undefined : milestone.value,
    cursor,
  };
}

type OptionalString = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly message: string };

/** 可选的字符串参数；没给返回 `null`（与「给了但非法」区分开）。 */
function parseOptionalString(raw: unknown, field: string): OptionalString | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const value = readString(raw);
  if (value === null) {
    return { ok: false, message: `\`${field}\` 必须是字符串。` };
  }
  return { ok: true, value };
}

/** 字符串原样返回；其它类型返回 `null`（不回退成空串，避免「有值」与「没值」混淆）。 */
function readString(raw: unknown): string | null {
  return typeof raw === 'string' ? raw : null;
}

/**
 * 正整数入参（issue 编号）。
 *
 * 为什么接受 `"331"` 这种字符串：模型经常把编号写成带引号的字符串，拒绝它会让整轮白跑，
 * 而「数字字符串 → 数字」是零风险的归一化。`0` / 负数 / 小数一律非法（GitHub 没有 issue #0）。
 */
function readPositiveInt(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^\d{1,9}$/.test(trimmed)) {
      return null;
    }
    const value = Number.parseInt(trimmed, 10);
    return value > 0 ? value : null;
  }
  return null;
}

/** cursor 只接受字符串；`null` / 未给都是「从头读」。 */
function readCursor(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  return typeof raw === 'string' ? raw : undefined;
}

/** `limit` 收进 [1, maxItems]；没给或非法就用 `maxItems`（多要几条不该让整轮失败）。 */
function clampLimit(raw: unknown, maxItems: number): number {
  const parsed = readPositiveInt(raw);
  if (parsed === null) {
    return maxItems;
  }
  return Math.min(parsed, maxItems);
}

/** 预算项收窄：非正整数一律回落到缺省（配置写错不该让读工具全废）。 */
function normalizeBudget(raw: number | undefined, fallback: number): number {
  if (raw === undefined || !Number.isFinite(raw) || raw < 1) {
    return fallback;
  }
  return Math.floor(raw);
}

/** 摘要里回显「这次读的是哪个目标」（审计与日志要能对上模型写的参数）。 */
function targetOf(input: Readonly<Record<string, unknown>>): string {
  const issueNumber = readPositiveInt(input['number']);
  if (issueNumber !== null) {
    return ` #${String(issueNumber)}`;
  }
  const query = readString(input['query']);
  return query === null ? '' : ` "${query}"`;
}

/* ── 失败 ──────────────────────────────────────────────────────────────────── */

/** 入参不合法：**不抛**，把「错在哪」写回给模型。 */
function badInput(name: string, target: string, message: string): IssueReadResult {
  return {
    name,
    ok: false,
    summary: `${name}${target} → 参数不合法`,
    items: 0,
    text: `${name}${target} 调用失败：${message}`,
    truncated: false,
    errorCode: 'bad-input',
  };
}

/**
 * GitHub 报错 → 一段可读说明。
 *
 * 404 必须同时写「可能不存在」与「可能没有权限」：GitHub 对「资源不存在」和「App 没有该仓库的
 * issues 读取权限」**都返 404**，只写一半会让模型得出完全错误的结论（去改编号，而不是去查权限）。
 * 这里不 import `github/errors.ts`：runtime 目录的架构门禁禁止依赖 github/，而且读工具轮只需要
 * 「状态码 + 一句话」，不需要重试建议。
 */
function githubFailure(name: string, target: string, error: unknown): IssueReadResult {
  const status = readStatus(error);
  const detail = readMessage(error);
  let reason: string;
  if (status === 404) {
    reason = 'GitHub 返回 404：可能不存在，也可能 App 缺少 issues 读取权限（GitHub 对这两种情况都返 404）。';
  } else if (status === 401) {
    reason = 'GitHub 返回 401：App 凭证无效或已过期，需要重新安装/续期。';
  } else if (status === 403) {
    reason = 'GitHub 返回 403：权限不足或已被限流（稍后重试可能有用）。';
  } else if (status !== null && status >= 500) {
    reason = `GitHub 返回 ${String(status)}：服务端错误，属于临时故障。`;
  } else if (status !== null) {
    reason = `GitHub 返回 ${String(status)}：请求被拒绝。`;
  } else {
    reason = '没有得到 HTTP 状态（网络中断或超时）。';
  }
  return {
    name,
    ok: false,
    summary: `${name}${target} → 读取失败`,
    items: 0,
    text: `${name}${target} 读失败：${reason}${detail === '' ? '' : `（${detail}）`}`,
    truncated: false,
    errorCode: 'github_error',
  };
}

/**
 * 从任意错误里取 HTTP 状态码。
 *
 * 三种形状都认：Octokit 的 `RequestError.status`、`GithubError.info.status`、以及
 * `response.status`（假客户端/中间层常见）。取不到就 `null` —— 「不知道」不能当 404 用。
 */
function readStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const record = error as Record<string, unknown>;
  const direct = record['status'];
  if (typeof direct === 'number' && Number.isFinite(direct)) {
    return direct;
  }
  for (const key of ['info', 'response']) {
    const nested = record[key];
    if (typeof nested !== 'object' || nested === null) {
      continue;
    }
    const status = (nested as Record<string, unknown>)['status'];
    if (typeof status === 'number' && Number.isFinite(status)) {
      return status;
    }
  }
  return null;
}

/**
 * 错误的 message（只取一行；不搬 error 对象，避免把请求细节带进提示词）。
 *
 * 两种形状都认：`Error`（Octokit / `GithubError` 走这条）与普通对象里的 `message`
 * （假客户端、部分中间层会直接抛 `{ status, message }`）。带上一行原文，
 * 模型才看得出「是权限、是速率，还是编号写错了」。
 */
function readMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null
        ? (error as Record<string, unknown>)['message']
        : undefined;
  if (typeof raw !== 'string') {
    return '';
  }
  return raw.replace(/\s+/g, ' ').trim();
}
