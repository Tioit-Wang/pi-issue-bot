/**
 * 左栏（rail）的**唯一**外壳零件：头部 + 一列可选条目。
 *
 * 为什么要有这个文件：`FR-7.4` / `AC-31` 要求三个左栏（Issue 队列 / 设置分区 / 技能列表）
 * 「同宽、同款头部、同行高、同选中态」。如果三处各写一遍 `w-...` + `h-...` + `border-l-...`，
 * 它们必然再次漂移（改造前就是 224 / 208 / 表格三种画法，强调条 2px）。
 * 所以：**数值只在 `index.css` 的 `--rail-*` 令牌里**，这里只组合工具类。
 *
 * 数值（需求原文，`FR-7.4`）：宽 320px（窄屏 300px，`w-rail` 带断点）、
 * 头部 30px「小标签 + 计数」（`rail-head`）、行高 28px（`rail-row`）、
 * 选中态「左侧 3px 强调条 + 浅强调底」（`rail-row-selected`）。
 */
import type { ReactNode } from 'react';
import { cn } from '../lib/utils.ts';

export type RailProps = {
  /** 头部小标签（大写微标）。 */
  label: string;
  /** 头部右侧计数（`12 项` / `4 分区`）；不传就不显示。 */
  count?: ReactNode;
  /** `aria-label`：与可见标签不同时（例如可见标签是缩写）用它。 */
  ariaLabel?: string;
  testId?: string;
  className?: string;
  children: ReactNode;
};

/**
 * 一列可选条目。
 *
 * 为什么用 `<nav>` 而不是 `<ul>`：三处的内容都是**地址**（能贴给别人、刷新不丢），
 * 读屏也要按导航语义读；`ul` 会让「点击即可跳转」这件事少一层语义。
 */
export function Rail({ label, count, ariaLabel, testId, className, children }: RailProps) {
  return (
    <div
      // `h-full`：`Rail` 内部是 `flex-col` + `nav flex-1`，需要父级给出确定高度
      // 才算得出剩余空间。三个调用点的父级有 flex 也有 block，`h-full` 两头都能接。
      className={cn(
        'flex h-full min-h-0 w-rail shrink-0 flex-col border-r border-border bg-card',
        className,
      )}
      data-testid={testId}
    >
      <div className="rail-head">
        <span className="min-w-0 truncate">{label}</span>
        {count === undefined ? null : <span className="rail-head-count tabular">{count}</span>}
      </div>
      <nav aria-label={ariaLabel ?? label} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {children}
      </nav>
    </div>
  );
}

/** 一行可选条目（`rail-row` + 可选的选中态）。`rail-row` 上的样式就三件事：高度、左缘、颜色。 */
export function railRowClass(selected: boolean, className?: string): string {
  return cn('rail-row', selected ? 'rail-row-selected' : 'hover:bg-muted hover:text-foreground', className);
}

/** 头部右侧的计数文案：`12 项`（空列表也给 0，而不是省略）。 */
export function railCount(total: number, unit: string): string {
  return `${String(total)} ${unit}`;
}
