import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils.ts';
import { TONE_BADGE, TONE_DOT, statusTone, type Tone } from './status.ts';

/**
 * 状态徽章 + 状态点。颜色**只来自** `ui/status.ts` 的映射表（页面不得自造颜色）。
 *
 * 旧变体名（`success` / `warning` / `danger` / `muted` / `outline` / `secondary` / `default`）
 * 全部保留：页面里已经用了上百处，改名收益为零，语义映射到新的 tone 即可。
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      variant: {
        /* 语义变体（新代码用这些）：一律「低饱和底 + 同色系文字」，小面积，不整行染色 */
        neutral: TONE_BADGE.neutral,
        success: TONE_BADGE.success,
        warn: TONE_BADGE.warn,
        danger: TONE_BADGE.danger,
        info: TONE_BADGE.info,
        brand: TONE_BADGE.brand,
        /* 兼容旧名（`default` 不再是实心品牌色，改为青色低饱和底） */
        warning: TONE_BADGE.warn,
        muted: TONE_BADGE.neutral,
        default: TONE_BADGE.brand,
        secondary: 'bg-muted text-muted-foreground',
        outline: 'border border-border text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export type BadgeProps = HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof badgeVariants> & {
    /** tone 优先于 variant（新代码只传 tone）。 */
    tone?: Tone;
    /** 前面加一个 6px 状态点（读屏时点本身 aria-hidden，语义由文字承担）。 */
    dot?: boolean;
  };

export function Badge({ className, variant, tone, dot = false, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), tone === undefined ? undefined : toneClass(tone), className)} {...props}>
      {dot ? <StatusDot tone={tone ?? 'neutral'} /> : null}
      {children}
    </span>
  );
}

/** tone → 徽章类名（`Badge` 的 `tone` 走这里，避免再维护一套变体名）。 */
function toneClass(tone: Tone): string {
  return TONE_BADGE[tone];
}

/** 状态点（6px 圆点）。`label` 给出读屏文案；不给则纯装饰。 */
export function StatusDot({
  tone = 'neutral',
  label,
  className,
  pulse = false,
}: {
  tone?: Tone;
  label?: string;
  className?: string;
  /** 运行中：外圈轻微呼吸（reduced-motion 下自动静止）。 */
  pulse?: boolean;
}) {
  return (
    <span
      aria-hidden={label === undefined ? true : undefined}
      {...(label === undefined ? {} : { role: 'img', 'aria-label': label })}
      data-tone={tone}
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        TONE_DOT[tone],
        pulse && 'animate-pulse',
        className,
      )}
    />
  );
}

/** 任务/动作状态 → 徽章 variant（**唯一映射处**，页面不要各写 switch）。 */
export function statusVariant(status: string): NonNullable<BadgeProps['variant']> {
  return statusTone(status);
}

export { badgeVariants };
