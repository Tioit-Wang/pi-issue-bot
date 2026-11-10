import type { ReactNode } from 'react';
import { cn } from '../lib/utils.ts';

/**
 * 工具条（`Toolbar`）：一屏里所有「筛选 / 切换 / 导出」都收在这一行。
 *
 * 布局：左侧筛选组可换行（`flex-wrap`）、右侧动作贴右；`min-w-0` + `overflow-x-auto`
 * 保证窄屏下是**这一行**横向滚动，而不是整页出现横向滚条。
 * 与内容之间只有一条 hairline，不做卡片头。
 */
export type ToolbarProps = {
  children: ReactNode;
  /** 右侧主/次动作。 */
  actions?: ReactNode;
  /** 左侧说明或计数（「共 128 条」）。 */
  meta?: ReactNode;
  className?: string;
};

export function Toolbar({ children, actions, meta, className }: ToolbarProps) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border pb-2',
        className,
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">{children}</div>
      <div className="flex shrink-0 items-center gap-2">
        {meta === undefined ? null : <span className="text-2xs tabular text-faint">{meta}</span>}
        {actions}
      </div>
    </div>
  );
}