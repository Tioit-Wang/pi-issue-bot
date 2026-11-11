/**
 * 触发体系（plan-multi-repo §4）：别名解析 + 正文蒙版 + 命令/问答解析。
 *
 * 为什么单独一个纯函数模块：
 *  - webhook 要用它决定「建不建任务」，worker 要用它回放「这句话为什么没触发」，面板要用它做
 *    「触发词命中预览」——三处必须是同一套判定，否则面板告诉你"能触发"而线上不触发；
 *  - 现有正则（`http/webhook.ts:117-152`）有三个真 bug：大小写敏感、`foo@ibot` 误命中、
 *    前导字符只认空白；且命令参数在解析处被丢掉。要修就得有一次重写，而不是继续叠正则。
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

/** 触发人：`all` 或 login 名单。空数组不是 `all`（`.min(1)` 让配置非法，而不是悄悄谁都放行）。 */
export const triggerUsersSchema = z.union([
  z.literal('all'),
  z
    .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u))
    .min(1)
    .max(50),
]);

export const triggersConfigSchema = z
  .object({
    /** 总开关：false = 该仓库任何触发都不算（自动面也关） */
    enabled: z.boolean().default(true),
    /** 追加别名（1–8 个）；缺省用部署默认 */
    aliases: z.array(triggerAliasSchema).min(1).max(8).optional(),
    /** true（默认）= 与部署默认别名并集；false = 只用 aliases */
    merge_defaults: z.boolean().default(true),
    /** 从并集里摘掉的别名（默认名撞真人用户名时用） */
    remove: z.array(triggerAliasSchema).max(8).default([]),
    /** 触发人：`all` 或 login 名单。只约束提及类触发，不约束自动面 */
    users: triggerUsersSchema.default('all'),
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
 * `settings.triggers`。合并规则写死在这里，避免 webhook 与面板各算一遍。
 */
export function resolveTriggerAliases(input: {
  readonly configured?: TriggersConfig | undefined;
  readonly deployment?: readonly string[] | undefined;
}): readonly string[] {
  const deployment = (input.deployment ?? DEFAULT_TRIGGER_ALIASES).map(normalizeTriggerAlias);
  const configured = input.configured;
  const base =
    configured === undefined
      ? deployment
      : configured.merge_defaults
        ? [...deployment, ...(configured.aliases ?? [])]
        : (configured.aliases ?? deployment);
  const removed = new Set((configured?.remove ?? []).map(normalizeTriggerAlias));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const alias of base) {
    const normalized = normalizeTriggerAlias(alias);
    if (normalized.length < 2 || removed.has(normalized) || seen.has(normalized)) {
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

export type TriggerParseKind = 'command' | 'question' | 'none';

export type TriggerParse = {
  /** command = 带 `/命令`；question = 只 @ 了并说了话；none = 只 @ 了一下 */
  readonly kind: TriggerParseKind;
  /** 命中的别名（最长优先），`null` = 没命中任何别名 */
  readonly alias: string | null;
  /** `/review-pr`（**不含**参数） */
  readonly command: string | null;
  /** 命令参数：`123 --deep` */
  readonly args: string | null;
  /** 自由问答正文（≤4000 字符） */
  readonly question: string | null;
  /** 蒙版后的正文（调试/面板预览用；不含代码区） */
  readonly masked: string;
};

export const EMPTY_TRIGGER_PARSE: TriggerParse = Object.freeze({
  kind: 'none' as const,
  alias: null,
  command: null,
  args: null,
  question: null,
  masked: '',
});

const COMMAND_PATTERN = /^\/([a-z][a-z0-9-]{1,30})(?=\s|$)/iu;
/** 别名之后的引导标点：`@ibot, /issue-triage` / `@ibot：帮我看看` */
const LEADING_PUNCTUATION = /^[\s,，。．!！?？：:;；、]+/u;

/**
 * 解析一条正文：命中哪个别名、后面跟的是命令还是问题。
 *
 * 只认**第一个**别名命中点（多段 `@ibot ... @ibot ...` 取最前面那段），因为一次评论只该
 * 产生一个任务；多条命令请拆成多条评论（比"悄悄取第一条"更好解释）。
 */
export function parseTriggerBody(body: string, aliases: readonly string[]): TriggerParse {
  const masked = maskCodeRegions(body);
  const hits = findAliasHits(masked, aliases);
  const hit = hits[0];
  if (hit === undefined) {
    return { ...EMPTY_TRIGGER_PARSE, masked };
  }
  const rest = masked.slice(hit.end).replace(LEADING_PUNCTUATION, '');
  const commandMatch = COMMAND_PATTERN.exec(rest);
  if (commandMatch !== null) {
    const command = commandMatch[1]?.toLowerCase() ?? null;
    const args = rest.slice(commandMatch[0].length).trim();
    return {
      kind: 'command',
      alias: hit.alias,
      command: command === null ? null : `/${command}`,
      args: args.length === 0 ? null : args.slice(0, 1000),
      question: null,
      masked,
    };
  }
  const question = rest.trim();
  if (question.length === 0) {
    return { kind: 'none', alias: hit.alias, command: null, args: null, question: null, masked };
  }
  return {
    kind: 'question',
    alias: hit.alias,
    command: null,
    args: null,
    question: question.slice(0, 4000),
    masked,
  };
}

/** 触发人门禁：`all` 放行；名单必须精确匹配 login。 */
export function isTriggerUserAllowed(users: 'all' | readonly string[], login: string): boolean {
  if (users === 'all') {
    return true;
  }
  return users.some((allowed) => allowed.toLowerCase() === login.toLowerCase());
}
