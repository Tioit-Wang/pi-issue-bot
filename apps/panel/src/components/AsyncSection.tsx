import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../lib/api.ts';
import { Alert, AlertDescription, AlertTitle } from './ui/alert.tsx';
import { Button } from './ui/button.tsx';
import { Skeleton } from './ui/skeleton.tsx';
import { cn } from '../lib/utils.ts';

/**
 * 「加载 / 错误 / 空 / 有数据」四态的统一出口（+ 第五态：离线）。
 *
 * 为什么抽出来：七个页面如果各写一遍 `if (isLoading) … if (error) …`，
 * 四态就必然各页不一致（有的显示骨架、有的显示空白）。这里把四态收敛成一处，
 * 页面只描述「有数据时长什么样」。
 *
 * 五态的呈现规则（D1 设计系统）：
 * - **加载**：与最终布局同形的骨架（`skeletonRows` 行，行高 32px），骨架不跳高；
 * - **错误**：一句人话（`describeError`）+ 重试按钮 + 折叠的技术细节；
 * - **空**：一句事实 + 一个可行动作（`emptyAction`）；
 * - **有数据**：`children`；
 * - **离线**：`navigator.onLine === false` 或请求本身是网络错误 → 顶部 pill
 *   「离线 · 数据可能过期」，并在给了 `onRetry` 时每 5s 自动重试一次。
 *
 * `testId` 的约定：`${testId}-loading` / `-error` / `-empty` / `-content`，
 * 供四态测试直接定位（W3 的页面沿用同一约定即可）。
 */
export type AsyncSectionProps = {
  isLoading: boolean;
  error: unknown;
  isEmpty?: boolean;
  emptyText?: string;
  /** 空态的可行动作（「去系统页确认安装」）。 */
  emptyAction?: ReactNode;
  /** 空态的第二行：为什么可能是空的。 */
  emptyHint?: string;
  skeleton?: ReactNode;
  /** 骨架行数：与最终列表行数一致，避免加载完成时跳高。 */
  skeletonRows?: number;
  skeletonHeight?: string;
  /** 错误态的重试回调；给了才显示「重试」按钮。 */
  onRetry?: () => void;
  testId?: string;
  className?: string;
  children: ReactNode;
};

/** 错误 → 一句人话（401 单独文案：面板要提示「重新登录」而不是「重试」）。 */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return `会话已过期或未登录（${error.message}）`;
    if (error.status === 403) return `没有权限（${error.message}）`;
    if (error.status >= 500) return `服务端出错（${error.message}）`;
    return error.message;
  }
  if (error instanceof TypeError) return `网络不可达（${error.message}）`;
  if (error instanceof Error) return error.message;
  return '未知错误';
}

/** 是否是网络层失败（fetch 抛 TypeError / 浏览器报告离线）。 */
export function isOffline(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  return error instanceof TypeError;
}

/** 技术细节（折叠）：状态码 / 错误码 / 堆栈第一行。 */
function describeDetails(error: unknown): string | null {
  if (error instanceof ApiError) {
    const parts = [`status: ${String(error.status)}`, `code: ${error.code}`];
    if (error.details !== undefined) parts.push(`details: ${JSON.stringify(error.details)}`);
    return parts.join('\n');
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return null;
}

/** 监听浏览器在线状态（SSR / jsdom 下默认在线）。 */
function useBrowserOffline(): boolean {
  const [offline, setOffline] = useState(
    () => typeof navigator !== 'undefined' && navigator.onLine === false,
  );

  useEffect(() => {
    const update = (): void => {
      setOffline(typeof navigator !== 'undefined' && navigator.onLine === false);
    };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  return offline;
}

export function AsyncSection({
  isLoading,
  error,
  isEmpty = false,
  emptyText = '暂无数据',
  emptyAction,
  emptyHint,
  skeleton,
  skeletonRows,
  skeletonHeight = 'h-32',
  onRetry,
  testId,
  className,
  children,
}: AsyncSectionProps) {
  const browserOffline = useBrowserOffline();
  const offline = browserOffline || isOffline(error);

  // 离线时自动重试：只在「确实离线」且调用方给了重试入口时进行
  useEffect(() => {
    if (!offline || onRetry === undefined) return;
    const timer = setInterval(() => {
      onRetry();
    }, 5000);
    return () => {
      clearInterval(timer);
    };
  }, [offline, onRetry]);

  const pill = offline ? (
    <p
      data-testid={testId === undefined ? 'offline-pill' : `${testId}-offline`}
      className="inline-flex w-fit items-center gap-1.5 rounded-sm bg-warn-bg px-1.5 py-0.5 text-xs text-warn-fg"
    >
      <span aria-hidden className="size-1.5 rounded-full bg-warn" />
      离线 · 数据可能过期{onRetry === undefined ? '' : ' · 正在自动重试'}
    </p>
  ) : null;

  if (error !== null && error !== undefined) {
    const details = describeDetails(error);
    const detailsId = `${testId ?? 'async'}-error-details`;
    return (
      <div className="flex min-w-0 flex-col gap-2">
        {pill}
        <Alert
          variant="destructive"
          data-testid={testId === undefined ? 'error' : `${testId}-error`}
          className="flex flex-col gap-1.5"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <AlertTitle>读取失败</AlertTitle>
              <AlertDescription>{describeError(error)}</AlertDescription>
            </div>
            {onRetry === undefined ? null : (
              <Button variant="secondary" size="sm" onClick={onRetry}>
                重试
              </Button>
            )}
          </div>
          {details === null ? null : (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground select-none hover:text-foreground">
                技术细节
              </summary>
              <pre
                id={detailsId}
                className="mt-1 overflow-x-auto rounded-sm bg-foreground/5 px-2 py-1 leading-relaxed text-muted-foreground"
              >
                {details}
              </pre>
            </details>
          )}
        </Alert>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex min-w-0 flex-col gap-2">
        {pill}
        <div data-testid={testId === undefined ? 'loading' : `${testId}-loading`} className="flex flex-col">
          {skeleton ??
            (skeletonRows === undefined ? (
              <Skeleton className={cn('w-full', skeletonHeight)} />
            ) : (
              Array.from({ length: skeletonRows }, (_, index) => (
                <Skeleton
                  key={`skeleton-row-${String(index)}`}
                  className="h-8 w-full rounded-none border-b border-border last:border-0"
                />
              ))
            ))}
        </div>
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div className="flex min-w-0 flex-col gap-2">
        {pill}
        <div
          data-testid={testId === undefined ? 'empty' : `${testId}-empty`}
          className="flex flex-col items-start gap-1.5 rounded-lg border border-dashed border-border px-4 py-8"
        >
          <p className="text-sm text-foreground">{emptyText}</p>
          {emptyHint === undefined ? null : (
            <p className="text-xs leading-relaxed text-muted-foreground">{emptyHint}</p>
          )}
          {emptyAction}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {pill}
      <div data-testid={testId === undefined ? 'content' : `${testId}-content`} className={cn('min-w-0', className)}>
        {children}
      </div>
    </div>
  );
}