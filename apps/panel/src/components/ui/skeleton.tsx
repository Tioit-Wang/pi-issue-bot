import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils.ts';

/**
 * 骨架屏：加载态统一用它（tech-plan §9.4「加载骨架由 Skeleton 统一」）。
 * `data-testid="skeleton"` 是给四态测试用的稳定锚点。
 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-testid="skeleton"
      aria-hidden="true"
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  );
}
