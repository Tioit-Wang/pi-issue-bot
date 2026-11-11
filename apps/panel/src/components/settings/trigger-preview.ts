/**
 * 触发命中预览的**判定内核**（W3-I）。
 *
 * 这里一行判定逻辑都不新写：别名合并、代码区蒙版、命令/问答解析全部来自
 * `packages/contract/src/trigger.ts`（webhook 用的就是这一份）。面板只做两件契约之外的事：
 *  1. 把 `parse.masked` 与原文对比，回列出「被代码块蒙版挡住」的片段（解释为什么没触发）；
 *  2. 把「命中什么」翻译成「这次评论会不会开工」（`triggers.enabled`；事件面已由固定流水线接管，
 *     `triggers.faces` 按 P7 删除，面板不再提供逐面开关）。
 *
 * 注意：预览**不校验触发人**（`triggers.users` 的名单只在 webhook 里按 `sender.login` 比对，
 * 预览框里没有「谁在说话」这个输入）。这一点必须写在界面上，否则「预览说能触发、线上没反应」。
 */
import {
  findAliasHits,
  normalizeTriggerAlias,
  parseTriggerBody,
  resolveTriggerAliases,
  triggerAliasSchema,
  type TriggerParse,
  type TriggersConfig,
} from '../../../../../packages/contract/src/trigger.ts';

export type TriggerPreview = {
  /** 生效别名（部署默认 ∪ 配置，去掉 `remove`，最长优先）。 */
  aliases: readonly string[];
  /** 命中的别名（按出现顺序去重；`parse.alias` 取第一个）。 */
  hits: readonly string[];
  parse: TriggerParse;
  /** 这次评论会不会产生任务。 */
  willTrigger: boolean;
  /** 一句话理由（界面直接显示，不做二次解释）。 */
  reason: string;
  /** 被代码区蒙版挡住的片段（判断「为什么没命中」的唯一依据）。 */
  codeRegions: readonly string[];
};

/** 生效别名（与 webhook 同一函数：`resolveTriggerAliases({configured})`）。 */
export function resolveAliasesFor(triggers: TriggersConfig): readonly string[] {
  return resolveTriggerAliases({ configured: triggers });
}

/**
 * 原文 ∩ 蒙版 → 代码区片段。
 *
 * 只比较两个字符串，不复制蒙版正则：`maskCodeRegions` 把非换行字符替换成空格、换行原样保留，
 * 所以「蒙版后是空格 but 原文不是」= 被挡住；换行不断开（一个多行围栏块算一段），
 * 段落首尾的空白用 `trim()` 去掉。
 */
export function codeRegionsOf(body: string, masked: string): readonly string[] {
  const regions: string[] = [];
  if (body.length === 0 || masked.length !== body.length) return regions;

  let start = -1;
  let hitBlank = false;

  const flush = (end: number): void => {
    if (start < 0 || !hitBlank) return;
    const text = body.slice(start, end).trim();
    if (text !== '') regions.push(text);
  };

  for (let index = 0; index < body.length; index += 1) {
    const original = body[index] ?? '';
    const blanked = masked[index] ?? '';
    // 换行在两边都保留：不断开当前片段（一个多行围栏块算一段）
    if (original === '\n') continue;
    const looksMasked = blanked === ' ' && (original !== ' ' || start >= 0);
    if (!looksMasked) {
      flush(index);
      start = -1;
      hitBlank = false;
      continue;
    }
    if (start < 0) start = index;
    if (blanked !== original) hitBlank = true;
  }
  flush(body.length);
  return regions;
}

/** 命中 → 是否会开工（事件面由固定流水线接管，只剩 `triggers.enabled` 这一个开关）。 */
export function previewTrigger(input: { body: string; triggers: TriggersConfig }): TriggerPreview {
  const aliases = resolveAliasesFor(input.triggers);
  const parse = parseTriggerBody(input.body, aliases);
  const hits = [...new Set(findAliasHits(parse.masked, aliases).map((hit) => hit.alias))];
  const codeRegions = codeRegionsOf(input.body, parse.masked);

  if (!input.triggers.enabled) {
    return {
      aliases,
      hits,
      parse,
      willTrigger: false,
      reason: '触发总开关关着（triggers.enabled = false）：该仓库任何触发都不生效。',
      codeRegions,
    };
  }

  if (parse.alias === null) {
    return {
      aliases,
      hits,
      parse,
      willTrigger: false,
      reason:
        codeRegions.length === 0
          ? '没命中任何别名 → 不处理。'
          : '没命中任何别名：正文里的 @ 都在代码区（围栏块 / 行内代码），被蒙版挡住了，不算叫人。',
      codeRegions,
    };
  }

  const what =
    parse.kind === 'command'
      ? `命令 ${parse.command ?? ''}${parse.args === null ? '' : `（参数：${parse.args}）`}`
      : parse.kind === 'question'
        ? '自由提问 → 会有一条最终回答'
        : '只 @ 了一下（没有命令也没有问题）→ 不建任务';

  return {
    aliases,
    hits,
    parse,
    willTrigger: parse.kind !== 'none',
    reason:
      parse.kind === 'none'
        ? `命中了 @${parse.alias}，但后面既没有 /命令 也没有提问：不建任务。`
        : `命中了 @${parse.alias} → ${what}`,
    codeRegions,
  };
}

/** 别名输入 → 归一化值 / 拒绝原因（`triggerAliasSchema` 是契约里那份，不另写正则）。 */
export function acceptAlias(raw: string, existing: readonly string[]): { value: string } | { error: string } {
  const normalized = normalizeTriggerAlias(raw);
  const result = triggerAliasSchema.safeParse(normalized);
  if (!result.success) {
    return { error: result.error.issues[0]?.message ?? '别名不合法' };
  }
  if (existing.some((entry) => normalizeTriggerAlias(entry) === normalized)) {
    return { error: `@${normalized} 已经在列表里（大小写与 @ 前缀不影响判重）` };
  }
  return { value: normalized };
}

/** login 名单的输入校验（契约 `triggerUsersSchema` 的字符集；不引 zod 只为一条正则）。 */
const LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u;

export function acceptLogin(raw: string, existing: readonly string[]): { value: string } | { error: string } {
  const value = raw.trim().replace(/^@+/u, '');
  if (!LOGIN_PATTERN.test(value)) return { error: 'GitHub login 只能是字母/数字/-，长度 1–39' };
  if (existing.some((entry) => entry.toLowerCase() === value.toLowerCase())) {
    return { error: `${value} 已经在名单里` };
  }
  return { value };
}
