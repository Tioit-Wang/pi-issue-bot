import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils.ts';
import { TONE_BORDER, TONE_SURFACE, TONE_TEXT, type Tone } from './status.ts';

/**
 * 提示条：错误态、降级横幅、离线提示的**唯一出口**。
 *
 * 旧变体名（`default` / `info` / `warning` / `destructive`）保留，映射到新的 tone；
 * 新代码可以直接传 `tone`。左缘 2px 色条 + 8~12% 底色，不用阴影。
 */
const alertVariants = cva('relative w-full rounded-md border border-border px-3 py-2 text-sm', {
  variants: {
    variant: {
      default: 'bg-card text-card-foreground',
      info: `border-l-2 ${TONE_BORDER.info} ${TONE_SURFACE.info} ${TONE_TEXT.info}`,
      warning: `border-l-2 ${TONE_BORDER.warn} ${TONE_SURFACE.warn} ${TONE_TEXT.warn}`,
      destructive: `border-l-2 ${TONE_BORDER.danger} ${TONE_SURFACE.danger} ${TONE_TEXT.danger}`,
      success: `border-l-2 ${TONE_BORDER.success} ${TONE_SURFACE.success} ${TONE_TEXT.success}`,
      neutral: `border-l-2 ${TONE_BORDER.neutral} ${TONE_SURFACE.neutral} ${TONE_TEXT.neutral}`,
    },
  },
  defaultVariants: { variant: 'default' },
});

/** tone → variant（新代码传 `tone`，老代码传 `variant`，两者等价）。 */
const TONE_VARIANT: Record<Tone, NonNullable<AlertProps['variant']>> = {
  neutral: 'neutral',
  success: 'success',
  warn: 'warning',
  danger: 'destructive',
  info: 'info',
  brand: 'default',
};

export type AlertProps = HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof alertVariants> & { tone?: Tone };

export function Alert({ className, variant, tone, role = 'alert', ...props }: AlertProps) {
  const resolved = tone === undefined ? variant : TONE_VARIANT[tone];
  return <div role={role} className={cn(alertVariants({ variant: resolved }), className)} {...props} />;
}

export function AlertTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h5 className={cn('mb-0.5 text-sm leading-snug font-semibold tracking-tight', className)} {...props} />;
}

export function AlertDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <div className={cn('text-xs leading-relaxed opacity-90', className)} {...props} />;
}

export { alertVariants };
