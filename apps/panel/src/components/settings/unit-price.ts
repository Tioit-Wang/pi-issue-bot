/**
 * 单价口径：USD / 1M tokens（`CFG-8.2`）。
 *
 * 为什么不复用 `formatUsd`（4 位小数）：那是「一次花掉多少钱」的口径；这里是价目表，
 * 每百万 token 3 美元写成 `$3.0000` 只会让人以为精度更高。单位写在所在分区的脚注里。
 */
export function formatUnitPrice(input: number, output: number): string {
  return `$${trimPrice(input)} / $${trimPrice(output)}`;
}

/** 价目表用两位小数够（没有供应商报到第三位）；整数不带小数点尾巴。 */
function trimPrice(value: number): string {
  const fixed = value.toFixed(2);
  return fixed.endsWith('.00') ? fixed.slice(0, -3) : fixed;
}
