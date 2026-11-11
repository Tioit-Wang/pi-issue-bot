/**
 * 幂等归一化（`docs/req-issue-agent.md` §5 规则 2 / §7 P3）。
 *
 * 口径（已定，别再改）：
 *  - 去 `@别名`（任何 `@handle`：别名就是句子里的噪声，去不去掉不该影响「同一句话」的判定）；
 *  - 压空白（换行 / 制表 / 多空格都算一个空格）；
 *  - 去标点（Unicode `P*` 与 `S*`：中英文标点、`/`、`_`、emoji 一并去掉）；
 *  - **不转小写**（OQ-10 未采纳）：`Fix It` 与 `fix it` 是两条不同的消息。
 *
 * 「同一句话在同一 issue 上永远只烧一次钱」是刻意的副作用（需求 §7 P3 末段）。
 */
import { maskCodeRegions } from '../../../../packages/contract/src/index.ts';

/** `@handle`：GitHub login 允许字母数字与 `._-`。 */
const AT_HANDLE = /@[A-Za-z0-9][A-Za-z0-9._-]*/gu;

/** 标点（`P*`）与符号（`S*`，含 emoji 与 `$+<=>`）。 */
const PUNCTUATION_OR_SYMBOL = /[\p{P}\p{S}]/gu;

/** 任何空白（含换行）。 */
const WHITESPACE = /\s+/gu;

/**
 * 幂等归一化。
 *
 * 代码区内的内容**整体不参与**归一化（先过 `maskCodeRegions` 换成等长空白）：代码里的
 * `@x` 不是提及、代码里的标点也是内容；于是「只改了代码块的同一句话」会落到同一个
 * fingerprint 上 —— 与需求 §5「同一句话只烧一次钱」一致（要重跑就换说法，§7 P3）。
 */
export function normalizeForIdempotency(text: string): string {
  if (text === '') {
    return '';
  }
  const masked = maskCodeRegions(text);
  return masked.replace(AT_HANDLE, ' ').replace(PUNCTUATION_OR_SYMBOL, ' ').replace(WHITESPACE, ' ').trim();
}

/** 转义正则字面量（别名来自配置，不能直接拼进正则）。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * 从正文里摘掉 `@别名`。
 *
 * 与 `normalizeForIdempotency` 分开：这里是**给人看/给 agent 看**的正文改写（`@bot 打个标签`
 * → `打个标签`），而幂等只看归一化后的 hash。两者共同的边界是「词边界」：`foo@ibot` 与
 * `@ibotx` 都不算提及（沿用 `trigger.ts::findAliasHits` 的口径）。
 *
 * 只压平**行内**空白（`[ \t]`），不动换行：多行指令的行结构要保住。
 */
export function stripAliases(text: string, aliases: readonly string[]): string {
  const ordered = [...new Set(aliases.map((alias) => alias.trim().replace(/^@+/u, '')).filter((a) => a !== ''))].sort(
    (a, b) => b.length - a.length || a.localeCompare(b),
  );
  let out = text;
  for (const alias of ordered) {
    out = out.replace(
      new RegExp(`(^|[^A-Za-z0-9._@-])@${escapeRegExp(alias)}(?![A-Za-z0-9_-])`, 'giu'),
      (_match, prefix: string) => prefix,
    );
  }
  return out.replace(/[ \t]{2,}/gu, ' ').trim();
}
