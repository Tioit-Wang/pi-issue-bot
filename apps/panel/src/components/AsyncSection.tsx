import type { ReactNode } from 'react';
import { ApiError } from '../lib/api.ts';
import { Alert, AlertDescription, AlertTitle } from './ui/alert.tsx';
import { Skeleton } from './ui/skeleton.tsx';
import { cn } from '../lib/utils.ts';

/**
 * 「加载 / 错误 / 空 / 有数据」四态的统一出口。
 *
 * 为什么要抽出来：七个页面如果各写一遍 `if (isLoading) … if (error) …`，
 * 四态就必然各页不一致（有的显示骨架、有的显示空白）。这里把四态收敛成一处，
 * 页面只描述「有数据时长什么样」。
 *
 * `testId` 的约定：`${testId}-loading` / `-error` / `-empty` / `-content`，
 * 供四态测试直接定位（W3 的页面沿用同一约定即可）。
 */
export type AsyncSectionProps = {
  isLoading: boolean;
  error: unknown;
  isEmpty?: boolean;
  emptyText?: string;
  skeleton?: ReactNode;
  skeletonHeight?: string;
  testId?: string;
  className?: string;
  children: ReactNode;
};

/** 错误 → 一句人话（401 单独文案：面板要提示「重新登录」而不是「重试」）。 */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return `会话已过期或未登录（${error.message}）`;
    if (error.status === 403) return `没有权限（${error.message}）`;
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return '未知错误';
}

export function AsyncSection({
  isLoading,
  error,
  isEmpty = false,
  emptyText = '暂无数据',
  skeleton,
  skeletonHeight = 'h-32',
  testId,
  className,
  children,
}: AsyncSectionProps) {
  if (error !== null && error !== undefined) {
    return (
      <Alert variant="destructive" data-testid={testId === undefined ? 'error' : `${testId}-error`}>
        <AlertTitle>读取失败</AlertTitle>
        <AlertDescription>{describeError(error)}</AlertDescription>
      </Alert>
    );
  }

  if (isLoading) {
    return (
      <div data-testid={testId === undefined ? 'loading' : `${testId}-loading`}>
        {skeleton ?? <Skeleton className={cn('w-full', skeletonHeight)} />}
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div
        data-testid={testId === undefined ? 'empty' : `${testId}-empty`}
        className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground"
      >
        {emptyText}
      </div>
    );
  }

  return (
    <div data-testid={testId === undefined ? 'content' : `${testId}-content`} className={className}>
      {children}
    </div>
  );
}
