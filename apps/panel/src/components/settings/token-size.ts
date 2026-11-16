/**
 * token 数的展示口径（上下文窗口 / 最大输出）。
 *
 * 为什么不是千分位：目录 chip 只有几十像素宽，`1,048,576` 会把它撑爆，而运维认的是
 * `1M` / `393K` 这种写法（各家文档也是这么写的）。精确值留在 `title` 里。
 *
 * 为什么不四舍五入成整数再分档：1,048,576 按 1e6 取整是 1M（对），但 1,050,000 若先
 * 取整成 1.05 再 toFixed(1) 会变成 `1.1M` —— 差 5 万 token 写到标签上不合适，所以
 * 保留一位再去掉 `.0`。
 */
function trimOneDecimal(value: number): string {
  const fixed = value.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

/** `1_048_576 → "1M"`、`393_216 → "393K"`、`8_192 → "8K"`、`512 → "512"`。 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${trimOneDecimal(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${String(Math.round(tokens / 1_000))}K`;
  return String(tokens);
}

/** 「窗口 + 输出上限」的一句话（两个都未知时为 `null`，calling 处不要渲染空占位）。 */
export function formatModelLimits(
  contextWindow: number | undefined,
  maxOutputTokens: number | undefined,
): string | null {
  if (contextWindow === undefined && maxOutputTokens === undefined) return null;
  const window = contextWindow === undefined ? '未知' : formatTokenCount(contextWindow);
  const output = maxOutputTokens === undefined ? '未知' : formatTokenCount(maxOutputTokens);
  return `上下文 ${window} · 输出 ${output}`;
}
