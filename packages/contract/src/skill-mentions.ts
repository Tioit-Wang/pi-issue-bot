/**
 * 技能命中（`docs/req-issue-agent.md` §1.3 / §2.3，照抄 pi-desktop 的 `findSkillMentions`）。
 *
 * 规则只有三条，但每一条都不能少：
 *  1. **任意位置**：`@bot /label-triage`、`@bot 看看格式 /format-check` 都算命中；
 *  2. **`/` 前必须是行首或空白**：`@bot/label-triage` 不命中（那是句柄的一部分）；
 *  3. **id 精确匹配目录**：`/label-tri` 不命中，且**不报错**（当普通自然语言，需求 C8 / X-02）。
 *
 * 代码区（围栏块与行内代码）先过 `maskCodeRegions` 换成等长空白再扫：贴着用法的
 * `` `/label-triage` `` 是「引用」不是「调用」（沿用 `trigger.ts` 的同一套蒙版）。
 *
 * 命中后**把 token 从正文里摘掉**（只摘 `/id` 本身，保留前后空白再由调用方收）；
 * 未命中时正文**逐字返回**（不是 `trim()` 过的副本），这样 `findSkillMentions` 对
 * 「没有技能的自然语言」永远是零副作用。
 */
import { maskCodeRegions } from './trigger.ts';

/** 一次技能命中。 */
export type SkillMentionHit = {
  /** 命中的技能 id（与目录里的 id 逐字相等，**区分大小写**） */
  readonly skillId: string;
  /** `/` 在正文里的位置 */
  readonly start: number;
  /** id 结束后的位置（不含） */
  readonly end: number;
};

/** 扫描结果。 */
export type SkillMentionScan = {
  /** 命中的技能 id（按出现顺序去重；空数组 = 没有命中） */
  readonly skillIds: readonly string[];
  /** 摘掉命中 token 之后的正文（没命中时与入参逐字相等） */
  readonly text: string;
  /** 每一处命中（调试与顺序断言用） */
  readonly hits: readonly SkillMentionHit[];
};

/** `/` 前必须是行首或空白；token 到下一个空白为止。 */
const SKILL_TOKEN_PATTERN = /(^|\s)\/([^\s]+)/gu;

/** token 尾部的标点（`/format-check.` 仍应命中）。 */
const TRAILING_PUNCTUATION = /[.,;:!?，。；：！？、)）\]】]+$/u;

/** 连在一起的空白收成一个（摘掉 token 后常留双空格）。 */
const SPACE_RUN = /[ \t]{2,}/gu;

function removeHits(text: string, hits: readonly SkillMentionHit[]): string {
  let out = text;
  // 从后往前删：位置不用重算
  for (let index = hits.length - 1; index >= 0; index -= 1) {
    const hit = hits[index];
    if (hit === undefined) {
      continue;
    }
    out = `${out.slice(0, hit.start)}${out.slice(hit.end)}`;
  }
  return out.replace(SPACE_RUN, ' ').trim();
}

/**
 * 扫一遍正文，返回 `{skillIds, text}`。
 *
 * `ids` 是**当前可用技能的 id 列表**（目录）；空目录 → 什么都不命中（需求 X-03 的
 * 「目录为空时整段不出现」由提示词渲染侧负责，不是这里）。
 */
export function findSkillMentions(text: string, ids: readonly string[]): SkillMentionScan {
  if (text === '' || ids.length === 0) {
    return { skillIds: [], text, hits: [] };
  }
  const known = new Set(ids);
  const masked = maskCodeRegions(text);
  const hits: SkillMentionHit[] = [];
  const skillIds: string[] = [];

  for (const match of masked.matchAll(SKILL_TOKEN_PATTERN)) {
    const token = (match[2] ?? '').replace(TRAILING_PUNCTUATION, '');
    if (token === '' || !known.has(token)) {
      continue;
    }
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    hits.push({ skillId: token, start, end: start + 1 + token.length });
    if (!skillIds.includes(token)) {
      skillIds.push(token);
    }
  }

  if (hits.length === 0) {
    return { skillIds: [], text, hits: [] };
  }
  return { skillIds, text: removeHits(text, hits), hits };
}
