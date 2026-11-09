import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils.ts';

/**
 * 提示条：**错误态与降级横幅的唯一出口**（tech-plan §9.4「错误提示由 Alert 统一」）。
 * 四态测试里的 `error` / `unauthorized` 都用它的 `destructive` 变体。
 */
const alertVariants = cva('relative w-full rounded-lg border px-4 py-3 text-sm', {
  variants: {
    variant: {
      default: 'border-border bg-card text-card-foreground',
      info: 'border-sky-500/40 bg-sky-500/10 text-sky-900 dark:text-sky-200',
      warning: 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200',
      destructive: 'border-destructive/50 bg-destructive/10 text-destructive',
    },
  },
  defaultVariants: { variant: 'default' },
});

export type AlertProps = HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>;

export function Alert({ className, variant, role = 'alert', ...props }: AlertProps) {
  return <div role={role} className={cn(alertVariants({ variant }), className)} {...props} />;
}

export function AlertTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h5 className={cn('mb-1 font-semibold leading-none tracking-tight', className)} {...props} />;
}

export function AlertDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-sm leading-relaxed opacity-90', className)} {...props} />;
}

export { alertVariants };
