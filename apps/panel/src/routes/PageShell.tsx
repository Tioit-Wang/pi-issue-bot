import type { ReactNode } from 'react';
import { cn } from '../lib/utils.ts';

/**
 * 页面外壳：标题 + 一句话说明 + 右侧操作区（导出按钮、筛选器等）。
 *
 * 还没有换成 `PageHeader` 的页面用它，保证标题层级（`h1`）与间距一致 ——
 * 四态测试按 `h1` 文本断言「页面到了」。
 *
 * 侧栏式外壳改造后新增两个可选 prop（**旧调用方不用改**）：
 * - `testId`：整页的锚点（`shell-breadcrumb` 之外，页面自己也要能被定位）；
 * - `fill`：不让内容按文档流自然撑高，而是接住外壳给的高度（`h-full min-h-0`），
 *   给「整页不滚、内部某块自己滚」的页面用（如事件绑定设置）。
 */
export type PageShellProps = {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  /** 整页的 `data-testid`。 */
  testId?: string;
  /** 接住外壳高度（内部自己滚动的页面用）。 */
  fill?: boolean;
  className?: string;
};

export function PageShell({
  title,
  description,
  actions,
  children,
  testId,
  fill = false,
  className,
}: PageShellProps) {
  return (
    <div
      className={cn('flex min-w-0 flex-col gap-4', fill && 'h-full min-h-0', className)}
      data-testid={testId}
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">{title}</h1>
          {description === undefined ? null : (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          )}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}
