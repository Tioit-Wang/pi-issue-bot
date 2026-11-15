import { screen, waitFor } from '@testing-library/react';
import type { userEvent } from '@testing-library/user-event';
import { expect } from 'vitest';

/**
 * 筛选下拉的**测试驱动**（Radix `Select`，不是原生 `<select>`）。
 *
 * 为什么单独一个文件：`user.selectOptions()` 只能作用于原生 `<select>`；
 * Radix 的 `Select` 是一个 `role="combobox"` 的触发器 + 一层 portal 出来的
 * `role="option"` 列表。两处列表页（Issue 队列 / 运行列表）各有 5~7 个筛选，
 * 把「点开 → 点项」写两遍就会有一处忘记等列表出现（Radix 是异步挂载的）。
 *
 * 断言仍然只看**可观察事实**：点完项之后 URL 变没变、页面上行数变没变。
 */
export async function pickFilterOption(
  user: ReturnType<typeof userEvent.setup>,
  filterLabel: string,
  optionName: string,
): Promise<void> {
  await user.click(screen.getByRole('combobox', { name: filterLabel }));
  await user.click(await screen.findByRole('option', { name: optionName }));
  // Radix 在选中后卸载列表：等它真的关掉再让调用方断言 URL / 行数
  await waitFor(() => {
    expect(screen.queryByRole('option', { name: optionName })).toBeNull();
  });
}

/** 触发器当前显示的文字（= 选中的那一项的文案），用来断言「刷新后筛选还在」。 */
export function filterDisplayValue(filterLabel: string): string {
  return screen.getByRole('combobox', { name: filterLabel }).textContent ?? '';
}
