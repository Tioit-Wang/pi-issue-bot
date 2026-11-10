import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils.ts';

/**
 * 卡片：**只在「同级的几块内容」之间使用**（图表、表格容器、独立结论块）。
 *
 * 规则（DESIGN.md）：不要卡片套卡片；页面主体优先用 `Section`（连续分区 + hairline），
 * 卡片是例外而非常规。层级只靠 hairline 描边表达，**不用阴影**。
 */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('min-w-0 rounded-lg border border-border bg-card text-card-foreground', className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-0.5 px-3 pt-3', className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-base font-semibold tracking-tight', className)} {...props} />;
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-xs text-muted-foreground', className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('min-w-0 px-3 py-3', className)} {...props} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex items-center gap-2 border-t border-border px-3 py-2', className)}
      {...props}
    />
  );
}
