import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { TONE_BADGE, TONE_DOT, type Tone } from '@/components/ui/status.ts';

/**
 * 状态点 + 状态徽章（**项目层**，不是 shadcn 原语）。
 *
 * 为什么不做进 `components/ui/badge.tsx`：官方 `Badge` 的 6 个变体（default / secondary /
 * destructive / outline / ghost / link）描述的是「这个标签有多重」；本产品需要的是另一件事 ——
 * 「这个状态属于哪一档语义」。两者混在一个 cva 里，改官方组件就改不动了，也没法解释
 * 「为什么这里不是 destructive」。
 *
 * 所以分工固定：
 * - `ui/status.ts`：tone 的**唯一**定义处（六档 + 状态字符串到 tone 的映射）；
 * - 本文件：tone → 类名（徽章低饱和底、6px 圆点、动效）；
 * - 页面：只传 `tone`，不写颜色类名（不写 `text-emerald-500`）。
 */
export type StatusBadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: Tone;
  /** 前面加一个 6px 状态点（读屏时点本身 aria-hidden，语义由文字承担）。 */
  dot?: boolean;
};

/** 状态徽章：低饱和底 + 同色系文字，小面积，不整行染色。 */
export function StatusBadge({ tone = 'neutral', dot = false, className, children, ...props }: StatusBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn('gap-1 border-transparent px-1.5 py-0.5 font-medium', TONE_BADGE[tone], className)}
      {...props}
    >
      {dot ? <StatusDot tone={tone} /> : null}
      {children}
    </Badge>
  );
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
      className={cn('inline-block size-1.5 shrink-0 rounded-full', TONE_DOT[tone], pulse && 'animate-pulse', className)}
    />
  );
}
