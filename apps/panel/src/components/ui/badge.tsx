import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils.ts';

/** 状态徽章：任务状态、动作状态、失败分类都用它（颜色只来自 CSS 变量）。 */
const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'border-border text-foreground',
        success: 'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
        warning: 'border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300',
        danger: 'border-transparent bg-destructive/15 text-destructive',
        muted: 'border-transparent bg-muted text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/** 任务/动作状态 → 徽章语义（唯一映射处，页面不要各写 switch）。 */
export function statusVariant(status: string): NonNullable<BadgeProps['variant']> {
  switch (status) {
    case 'succeeded':
    case 'applied':
    case 'success':
      return 'success';
    case 'failed':
    case 'rejected':
    case 'timed-out':
      return 'danger';
    case 'running':
    case 'dry-run':
      return 'warning';
    case 'queued':
    case 'skipped':
      return 'muted';
    case 'cancelled':
    case 'interrupted':
      return 'outline';
    default:
      return 'secondary';
  }
}

export { badgeVariants };
