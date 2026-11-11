/**
 * 触发体系（v0.3 收窄）：别名解析 + 正文蒙版 + 「这条消息是不是给我的」判定。
 *
 * 为什么单独一个纯函数模块：
 *  - webhook 要用它决定「建不建任务」，面板要用它做「触发词命中预览」——两处必须是同一套判定，
 *    否则面板告诉你"能触发"而线上不触发；
 *  - 正则实现有三个真 bug（大小写敏感、`foo@ibot` 误命中、前导字符只认空白），要修就得有一次重写，
 *    而不是继续叠正则。
 *
 * v0.3 删掉了**命令语义**（`/命令` 归技能，见 `docs/req-issue-agent.md` §2.3）：`parseTriggerBody`
 * 只回答「有没有 @ 我的别名 + 原文是什么」，`kind` 收敛为 `'mention' | 'none'`。
 *
 * 硬规则：
 *  1. **别名大小写不敏感**：`@IssueBot` 与 `@issuebot` 等价（GitHub login 本身不区分大小写）；
 *  2. **代码区不触发**：围栏代码块与行内代码里的 `@ibot` 是"贴用法说明"，不是叫人；
 *  3. **词边界**：`foo@ibot` / `@ibotx` 不算命中；
 *  4. **最长别名优先**：同时配了 `ibot` 与 `issuebot` 时，`@issuebot` 不能只吃到 `@ibot` 的语义。
 */

import { z } from 'zod';

/** 部署默认别名（约束：默认 `@issuebot`、`@IssueBot`、`@ibot` 都能触发）。 */
export const DEFAULT_TRIGGER_ALIASES: readonly string[] = Object.freeze(['issuebot', 'ibot']);

/**
 * 别名：裸名或带 `@` 前缀都可以写（GitHub 上人人带 `@`），大小写随意。
 *
 * 刻意**不在 schema 里 transform 归一化**：带 transform 的 schema 生成不了 JSON Schema，
 * 而 `schemas.ts` 的注册表测试要求每个 schema 都能出 JSON Schema。归一化统一在
 * `normalizeTriggerAlias()`（解析与合并两处都走它）。
 */
export const triggerAliasSchema = z
  .string()
  .trim()
  .min(2)
  .max(39)
  .regex(/^@?[A-Za-z0-9][A-Za-z0-9._-]{1,38}$/u, '别名只能是字母/数字/._-，且长度为 2–39');

/**
 * `settings.triggers`：v0.3 只剩**别名**（`docs/dev-plan-issue-agent.md` §2.6）。
 * `enabled` / `users` / `merge_defaults` / `remove` 已删：「谁能 @」改由 `agent.managers` 决定。
 */
export const triggersConfigSchema = z
  .object({
    /** 追加别名（1–8 个）；缺省用部署默认 */
    aliases: z.array(triggerAliasSchema).min(1).max(8).optional(),
  })
  .strict();

export type TriggersConfig = z.infer<typeof triggersConfigSchema>;

/** 解析后的触发规则（webhook/worker/面板共用的唯一形状）。 */
export type TriggerRules = {
  readonly enabled: boolean;
  readonly aliases: readonly string[];
  readonly users: 'all' | readonly string[];
};

/** `@IssueBot` / `IssueBot` / ` @issuebot ` → `issuebot`。 */
export function normalizeTriggerAlias(raw: string): string {
  return raw.trim().replace(/^@+/u, '').toLowerCase();
}

/**
 * 配置 → 生效别名集合（小写、去重、最长优先排序）。
 *
 * `deployment` 是部署级默认（`PI_BOT_TRIGGERS` / App slug），`configured` 是仓库配置里的
 * `settings.triggers`：仓库配了 `aliases` 就是**它自己**（不与部署默认并集，v0.3 只有一个来源）。
 * 合并规则写死在这里，避免 webhook 与面板各算一遍。
 */
export function resolveTriggerAliases(input: {
  readonly configured?: TriggersConfig | undefined;
  readonly deployment?: readonly string[] | undefined;
}): readonly string[] {
  const deployment = (input.deployment ?? DEFAULT_TRIGGER_ALIASES).map(normalizeTriggerAlias);
  const base = input.configured?.aliases ?? deployment;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const alias of base) {
    const normalized = normalizeTriggerAlias(alias);
    if (normalized.length < 2 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  // 最长优先：面板/日志里"命中的是哪个别名"要稳定
  return Object.freeze(out.sort((a, b) => b.length - a.length || a.localeCompare(b)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * 把代码区替换成等长空白（保留换行与偏移）。
 *
 * 只蒙版**代码**，不蒙版引用块：引用块里 @ 机器人是常见用法（引用一条报错再提问）。
 */
export function maskCodeRegions(body: string): string {
  return body
    .replace(/```[\s\S]*?```/gu, (block) => block.replace(/[^\n]/gu, ' '))
    .replace(/`[^`\n]*`/gu, (inline) => ' '.repeat(inline.length));
}

export type AliasHit = {
  readonly alias: string;
  /** `@` 的位置 */
  readonly start: number;
  /** 别名结束后的位置（`@` + alias 之后） */
  readonly end: number;
};

/**
 * 找出正文里的别名命中（已蒙版代码区）。
 *
 * 词边界用「前一个字符不是 `[A-Za-z0-9._-]` 且不是 `@`」+「后一个字符不是 `[A-Za-z0-9_-]`」，
 * 后者刻意**不含** `.`：`@ibot.` 是句末句号，应该命中。
 */
export function findAliasHits(maskedBody: string, aliases: readonly string[]): readonly AliasHit[] {
  const hits: AliasHit[] = [];
  for (const alias of aliases) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9._@-])@${escapeRegExp(alias)}(?![A-Za-z0-9_-])`, 'giu');
    for (const match of maskedBody.matchAll(pattern)) {
      const index = match.index ?? 0;
      const start = index + (match[1]?.length ?? 0);
      hits.push({ alias: normalizeTriggerAlias(alias), start, end: start + 1 + alias.length });
    }
  }
  return hits.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
}

/** `mention` = 命中别名且带了正文；`none` = 没命中别名，或只 @ 了一下没说事。 */
export type TriggerParseKind = 'mention' | 'none';

export type TriggerParse = {
  readonly kind: TriggerParseKind;
  /** 命中的别名（最长优先），`null` = 没命中任何别名 */
  readonly alias: string | null;
  /** 别名之后的原文（去掉前导标点，≤4000 字符）；只 @ 了一下则为 `null` */
  readonly text: string | null;
  /** 蒙版后的正文（调试/面板预览用；不含代码区） */
  readonly masked: string;
};

export const EMPTY_TRIGGER_PARSE: TriggerParse = Object.freeze({
  kind: 'none' as const,
  alias: null,
  text: null,
  masked: '',
});

/** 别名之后的引导标点：`@ibot, 帮我看看` / `@ibot：帮我看看` */
const LEADING_PUNCTUATION = /^[\s,，。．!！?？：:;；、]+/u;

/**
 * 解析一条正文：有没有 @ 我的别名、原文是什么。
 *
 * 只认**第一个**别名命中点（多段 `@ibot ... @ibot ...` 取最前面那段），因为一次评论只该
 * 产生一条消息。`/技能名` 的扫描与改写由 `skill-mentions.ts` 负责（S1），这里原样保留。
 */
export function parseTriggerBody(body: string, aliases: readonly string[]): TriggerParse {
  const masked = maskCodeRegions(body);
  const hits = findAliasHits(masked, aliases);
  const hit = hits[0];
  if (hit === undefined) {
    return { ...EMPTY_TRIGGER_PARSE, masked };
  }
  const text = masked.slice(hit.end).replace(LEADING_PUNCTUATION, '').trim();
  if (text.length === 0) {
    return { kind: 'none', alias: hit.alias, text: null, masked };
  }
  return { kind: 'mention', alias: hit.alias, text: text.slice(0, 4000), masked };
}

/**
 * 触发人门禁的**纯函数**形态：`all` 放行；名单必须精确匹配 login。
 *
 * v0.3 里「谁能 @」改由 `settings.agent.managers` 判（`agent/permission.ts`，S3），
 * 本函数只作为契约层的公共小工具保留（面板预览与将来的管理员名单判定共用）。
 */
export function isTriggerUserAllowed(users: 'all' | readonly string[], login: string): boolean {
  if (users === 'all') {
    return true;
  }
  return users.some((allowed) => allowed.toLowerCase() === login.toLowerCase());
}
