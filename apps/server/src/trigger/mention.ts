/**
 * 「合法提及」判定（FR-2.5 / `docs/v21-contract.md` §2）。
 *
 * 为什么要单独一个纯函数，而不是在评论闸门里写一段正则：
 *  - 判定规则有**四条互相牵制**的约束（`@` 紧邻、后接分隔符、前导字符、最长优先），
 *    写成一条正则时最先崩的就是「`@pi-botx` 不许命中 `pi-bot`」这种前缀冲突；
 *  - webhook 判定、面板「这句评论能不能触发」预览、单测三处必须是**同一套**判定，
 *    否则面板说能触发、线上不触发（v0.3 的 `trigger.ts` 文件头记过同一个教训）。
 *
 * 与 `packages/contract/src/trigger.ts` 的 `findAliasHits` 的关系：
 * 后者是 v0.3 的**别名**命中（别名只可能是 `[A-Za-z0-9._-]`，所以词边界只需一条否定断言）；
 * 本模块是 v2.1 的**提及关键词**（§6.6 明确允许中文关键词，例如 `小豆`），
 * 「关键词后必须是分隔符」这条在白名单意义上更严、也必须能表达「中文不是分隔符」。
 * **蒙版复用**（`maskCodeRegions`）：代码区里贴 `@pi-bot` 是用例说明，不是叫人，两边口径必须一致。
 */
import { maskCodeRegions } from '../../../../packages/contract/src/index.ts';

/** 一个合法的提及命中。 */
export type LegalMention = {
  /** 命中的关键词（**配置里的原样写法**，便于日志/面板直接回显） */
  readonly keyword: string;
  /** `@` 的位置 */
  readonly start: number;
  /** 关键词结束后的位置（`@` + 关键词之后；不含分隔符） */
  readonly end: number;
};

/**
 * 关键词的形状与 `settings.comment.mentions` 一致。
 *
 * 用结构化类型而不是直接 import `CommentMention`：判定侧只关心这两项，
 * 而 `resolveCommentConfig()` 产出的 `case_sensitive` 是**已补齐的布尔**（`false`），
 * 这里允许缺失（`undefined` 一律按「不区分大小写」），两种调用方都能直接传。
 */
export type MentionKeyword = {
  readonly keyword: string;
  readonly case_sensitive?: boolean | undefined;
};

/**
 * 关键词之后允许出现的**标点**（空白与换行由 `\s` 单独判）。
 *
 * 为什么是白名单而不是「非字母数字即分隔符」：`@pi-bot你好` 必须**不**命中
 * （§6.6 的注意条：为了不误伤 `@pi-botx` 这类名字而故意付出的代价），
 * 而中文字符在任何正则里都不是标点/空白——用白名单才能把「中文不属于分隔符」写清楚。
 *
 * 为什么收 `-` 以外的常见标点：`@pi-bot,` / `@pi-bot.` / `@pi-bot（帮看下）` 都是真实写法；
 * `-` `_` `.` 之外还刻意**不收** `#` `+` `=`（它们更容易是标识符的一部分）。
 */
const SEPARATOR_CHARS: ReadonlySet<string> = new Set([
  // 半角标点
  ',', '.', '!', '?', ':', ';', '(', ')', '[', ']', '{', '}', '<', '>',
  '"', "'", '/', '\\', '|', '~', '`', '*', '&', '%', '^', '$', '@',
  // 全角 / 中文标点（含中文句读与成对符号）
  '，', '。', '．', '！', '？', '：', '；', '、',
  '（', '）', '【', '】', '《', '》', '「', '」', '『', '』',
  '“', '”', '‘', '’', '…', '—', '～',
]);

/**
 * 前导字符禁区：`@` 前面不能紧贴这些字符，否则算「粘在别的标识符里」。
 *
 * - 字母数字与 `_`：`foo@pi-bot` 是邮箱形态，不是叫人；
 * - `.` 与 `-`：`a.b@pi-bot` / `x-@pi-bot` 同属粘连；
 * - `@`：`@@pi-bot` 是「叫了别人又顺手打错」，不该算命中。
 */
const LEADING_FORBIDDEN = /^[A-Za-z0-9._@-]$/u;

/** 关键词之后的字符是否算分隔符（空串 = 字符串结尾，也算）。 */
export function isMentionSeparator(char: string): boolean {
  if (char === '') {
    return true;
  }
  return /\s/u.test(char) || SEPARATOR_CHARS.has(char);
}

/** 关键词之前的字符是否允许（`undefined` = 字符串开头，允许）。 */
function isLegalLeadingChar(previous: string | undefined): boolean {
  return previous === undefined || !LEADING_FORBIDDEN.test(previous);
}

/** 参与判定的关键词（去掉空串，按长度倒序：同一位置上最长者优先）。 */
function normalizeKeywords(mentions: readonly MentionKeyword[]): readonly MentionKeyword[] {
  const cleaned: MentionKeyword[] = [];
  for (const mention of mentions) {
    const keyword = mention.keyword.trim();
    // 空关键词会命中任意 `@`，把整条评论都变成触发——只能是配置被手改坏了，直接丢弃。
    if (keyword === '') {
      continue;
    }
    cleaned.push({
      keyword,
      case_sensitive: mention.case_sensitive === true,
    });
  }
  return cleaned.sort((a, b) => b.keyword.length - a.keyword.length || a.keyword.localeCompare(b.keyword));
}

/** `masked` 在 `at` 处是否紧跟某个关键词，且关键词之后是分隔符。 */
function matchKeywordAt(
  masked: string,
  at: number,
  keywords: readonly MentionKeyword[],
): MentionKeyword | null {
  for (const keyword of keywords) {
    const end = at + keyword.keyword.length;
    if (end > masked.length) {
      continue;
    }
    const actual = masked.slice(at, end);
    const hit = keyword.case_sensitive === true ? actual === keyword.keyword : actual.toLowerCase() === keyword.keyword.toLowerCase();
    if (!hit) {
      continue;
    }
    if (!isMentionSeparator(masked.charAt(end))) {
      continue;
    }
    return keyword;
  }
  return null;
}

/**
 * 找出正文里**第一个**合法提及（FR-2.5）。
 *
 * 四条规则（顺序即实现顺序）：
 *  1. 代码区先蒙版（围栏块与行内代码里的 `@pi-bot` 不算）；
 *  2. `@` 紧跟关键词，且 `@` 前一个字符不能是 `[A-Za-z0-9._@-]`；
 *  3. 关键词之后必须是分隔符（空白 / 换行 / 标点）或字符串结尾；
 *  4. 同一 `@` 上多个关键词都能命中时**最长优先**（`@pi.bot` 配了 `pi` 与 `pi.bot` 取后者）。
 *
 * 返回**最早出现**的那一个：一次评论只该产生一轮处理，取最靠前的那次呼唤。
 */
export function findLegalMention(body: string, mentions: readonly MentionKeyword[]): LegalMention | null {
  if (body === '' || mentions.length === 0) {
    return null;
  }
  const keywords = normalizeKeywords(mentions);
  if (keywords.length === 0) {
    return null;
  }
  const masked = maskCodeRegions(body);
  let cursor = masked.indexOf('@');
  while (cursor !== -1) {
    // 刻意不用 `masked.at(cursor - 1)`：`at(-1)` 会绕回**最后一个**字符，
    // 于是 `@pi-bot` 开头的评论会被误判成「前面粘了个字符」而永不触发。
    const previous = cursor === 0 ? undefined : masked.charAt(cursor - 1);
    if (isLegalLeadingChar(previous)) {
      const hit = matchKeywordAt(masked, cursor + 1, keywords);
      if (hit !== null) {
        return {
          keyword: hit.keyword,
          start: cursor,
          end: cursor + 1 + hit.keyword.length,
        };
      }
    }
    cursor = masked.indexOf('@', cursor + 1);
  }
  return null;
}

/** 只要布尔结果的薄封装（gate 判定处读起来更直白）。 */
export function isLegalMention(body: string, mentions: readonly MentionKeyword[]): boolean {
  return findLegalMention(body, mentions) !== null;
}
