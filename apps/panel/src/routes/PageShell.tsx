import type { ReactNode } from 'react';

/**
 * 页面外壳：标题 + 一句话说明 + 右侧操作区（导出按钮、筛选器等）。
 *
 * 七个路由都用它，保证标题层级（`h1`）与间距一致——四态测试也按 `h1` 文本断言「页面到了」。
 */
export type PageShellProps = {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
};

export function PageShell({ title, description, actions, children }: PageShellProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
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
