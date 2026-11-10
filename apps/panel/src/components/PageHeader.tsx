import type { ReactNode } from 'react';
import { cn } from '../lib/utils.ts';
import { Breadcrumb, type Crumb } from './Breadcrumb.tsx';

/**
 * 页头（`PageHeader`）：面包屑 + 标题 + 说明 + 动作 + 「更新于」。
 *
 * 层级：`h1` 20px / 说明 13px / 更新时间 11px。**一页只有一个 `h1`**，
 * 分区标题用 `Section` 的 `h2`（15px）。
 *
 * `updatedAt` 是「这一页的数据最后一次成功刷新的时刻」（页脚轮询说明里的那个数），
 * 只写相对时间，别写绝对时间戳。
 */
export type PageHeaderProps = {
  title: ReactNode;
  /** 一句话定义这一页（口径、范围）。 */
  description?: ReactNode;
  /** 面包屑（仓库维度页面给：全部项目 / owner/name / 当前页）。 */
  breadcrumb?: readonly Crumb[];
  /** 右侧动作（主操作放最后一个）。 */
  actions?: ReactNode;
  /** 数据刷新时间（相对时间文案，例如「12s 前」）。 */
  updatedAt?: string;
  /** 标题行下方的状态徽章区（启用 / dry-run / 配置无效）。 */
  badges?: ReactNode;
  className?: string;
  testId?: string;
};

export function PageHeader({
  title,
  description,
  breadcrumb,
  actions,
  updatedAt,
  badges,
  className,
  testId,
}: PageHeaderProps) {
  return (
    <header className={cn('flex min-w-0 flex-col gap-1.5', className)} data-testid={testId}>
      {breadcrumb === undefined ? null : <Breadcrumb items={breadcrumb} testId={testId === undefined ? undefined : `${testId}-breadcrumb`} />}

      <div className="flex min-w-0 flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">{title}</h1>
          {description === undefined ? null : (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {actions}
          {updatedAt === undefined ? null : (
            <span className="text-2xs tabular text-faint">更新于 {updatedAt}</span>
          )}
        </div>
      </div>

      {badges === undefined ? null : <div className="flex flex-wrap items-center gap-1">{badges}</div>}
    </header>
  );
}