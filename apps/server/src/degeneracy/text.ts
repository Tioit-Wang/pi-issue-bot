/**
 * 文本判据共用的两个纯函数：**归一化**与**分词**。
 *
 * 归一化（plan §9.3 的字面要求「去空白、去标点」）只消除渲染上不可见的差异：
 *   - 去掉所有空白（含全角空格、换行）——否则「同一段换个换行」就能逃过段落计数；
 *   - 去掉标点与符号（Unicode `P*` / `S*`）——否则「同一段句末加感叹号」同理；
 *   - 保留大小写与字序：**任何语义改动都算内容变了**（同 `github/executor.ts` 对评论正文的口径）。
 *   刻意不做的：不做 Unicode 归一（NFKC）——全角转半角属于「改了字」而不是「改了排版」，
 *   而 NFKC 还会顺手把 `①` 变成 `1`，那已经超出「去标点」的范围。
 *
 * 分词用于低增量判据：拉丁词按词切，CJK 按**单字**切（CJK 没有空格分词，
 * 按字切能让 n-gram 在中文文本上同样有区分度；否则一整句中文就是一个 token，
 * 3-gram 永远只有 1 个，判据必然误报）。
 */

/** 归一化：去空白 + 去标点/符号。空输入返回空串。 */
export function normalizeText(input: string): string {
  return input
    .normalize('NFC')
    .replace(/[\s\u3000\u00a0\u200b]+/gu, '')
    // \p{P} 标点、\p{S} 符号（含 emoji 与货币符号）
    .replace(/[\p{P}\p{S}]+/gu, '');
}

/** CJK 与相关文字的单字切分范围（含扩展 A、兼容区、假名、韩文）。 */
const CJK = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af';

/** 一个 CJK 字符，或一段拉丁/数字字母串。 */
const TOKEN_PATTERN = new RegExp(`[${CJK}]|[^\\s${CJK}]+`, 'gu');

/** 单字 CJK 判据（模块级编译一次，不在分词循环里逐 token 造正则）。 */
const CJK_SINGLE = new RegExp(`^[${CJK}]$`, 'u');

/**
 * 分词：CJK 逐字，其余按连续非空白片段。
 * 片段内部再按非字母数字（`_` 也当分隔）切开，让 `foo(bar)` 变成 `foo` / `bar`。
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  for (const matched of input.normalize('NFC').matchAll(TOKEN_PATTERN)) {
    const piece = matched[0];
    if (CJK_SINGLE.test(piece)) {
      tokens.push(piece);
      continue;
    }
    for (const word of piece.split(/[^\p{L}\p{N}]+/u)) {
      if (word.length > 0) {
        tokens.push(word);
      }
    }
  }
  return tokens;
}

/**
 * 稳定序列化：对象键排序后 JSON。
 * 工具循环判据靠它比较「同参数」，而 `JSON.stringify` 的键顺序由插入顺序决定，
 * 同一个 `{a,b}` 换个来源就会被判成不同参数——那会把真正的循环放过。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

/** 取一段摘要（落 detail 用），避免把整个参数原样塞进 jsonb。 */
export function summarize(value: unknown, maxLength = 200): string {
  const text = typeof value === 'string' ? value : stableStringify(value);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}
