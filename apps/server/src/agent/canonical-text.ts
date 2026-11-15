/**
 * 幂等归一化（`docs/requirements.html` §5「内容级去重的口径」）。
 *
 * 口径（已定，别再改）：**只做两件事** —— 去首尾空白、把连续空行合并成一个空行。
 *  - 不做语义近似判断：措辞、标点、大小写、代码块任何一处变了就是**不同内容**；
 *  - 不摘 `@提及`、不抹代码区、不压行内空白、不把多行压成一行。
 *
 * 为什么刻意这么窄：需求写的是「宁可多处理一次，也不能把新问题误判成旧问题」。此前做过
 * 「去 `@别名` / 压空白 / 去标点」的归一化，代价是「只改了一个感叹号」或「只挪了代码块」
 * 被判成同一段话、新问题被永久吞掉 —— 越界归一化省下的那点 token 由用户的问题买单。
 */

/**
 * 连续空行：3 个以上换行（空行里只含空格/制表符也算空行）。
 *
 * 只吃「空行之间」的空白，不吃下一行正文的缩进：`[ \t]*` 必须紧跟着换行，缩进列表与
 * 代码块才不会因为前面的空行被吃掉空格。
 */
const CONSECUTIVE_BLANK_LINES = /\r?\n(?:[ \t]*\r?\n){2,}/gu;

/**
 * 幂等归一化：去首尾空白 + 合并连续空行，别的什么都不做。
 *
 * 行内多空格、行结构、标点、`@handle`、代码区一律原样参与 hash —— 需求 §5 明确
 * 「措辞不同就是不同内容」，重复处理一次是可接受的代价，误判成旧问题不可接受。
 */
export function normalizeForIdempotency(text: string): string {
  // 顺序要紧：先合并空行（此时首尾换行还在，含空白的空行才连得上），再整体 trim。
  return text.replace(CONSECUTIVE_BLANK_LINES, '\n\n').trim();
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
  return stripAliasMentions(text, aliases).replace(/[ \t]{2,}/gu, ' ').trim();
}

/**
 * 只摘掉 `@别名` 本身，**完全不动空白**（不压、不 trim）。
 *
 * 为什么需要一个「不动空白」的版本：v2.1 的消息正文是整份模板渲染结果，里面常有代码块与
 * 缩进列表；`stripAliases()` 末尾那句「压平行内空白」会把缩进吃掉（演示代码变了意思）。
 * 这里只做「别名是噪声」这一件事，边界口径与 `stripAliases()` 共用一份实现。
 */
export function stripAliasMentions(text: string, aliases: readonly string[]): string {
  const ordered = aliasPatternsOf(aliases);
  let out = text;
  for (const pattern of ordered) {
    out = out.replace(pattern, (_match, prefix: string) => prefix);
  }
  return out;
}

/** 每个别名一条「词边界 + 别名」正则（长别名先替换，避免短别名抢跑）。 */
function aliasPatternsOf(aliases: readonly string[]): readonly RegExp[] {
  const ordered = [...new Set(aliases.map((alias) => alias.trim().replace(/^@+/u, '')).filter((a) => a !== ''))].sort(
    (a, b) => b.length - a.length || a.localeCompare(b),
  );
  return ordered.map(
    (alias) => new RegExp(`(^|[^A-Za-z0-9._@-])@${escapeRegExp(alias)}(?![A-Za-z0-9_-])`, 'giu'),
  );
}
