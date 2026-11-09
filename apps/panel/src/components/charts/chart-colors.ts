/**
 * 图表配色：**只来自 CSS 变量**（`--chart-1..5`，tech-plan §9.4「配色不硬编码」）。
 * Recharts 的 `stroke` / `fill` 接受 CSS 变量字符串，暗色切换由 `index.css` 的媒体查询完成。
 */
export const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
] as const;

/** 按序号取色（超出 5 色循环，图表里最多也就 5 类）。 */
export function chartColor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length] ?? CHART_COLORS[0];
}
