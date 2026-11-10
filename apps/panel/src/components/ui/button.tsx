import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/utils.ts';

/**
 * 按钮（D1 原语）：四个语义变体 × 三个高度档（28 / 32 / 36px）。
 *
 * - `primary`：品牌实底，**一屏只留给最重要的那一个动作**；
 * - `secondary`：面 + hairline，最常见的「次要动作」；
 * - `ghost`：无底无边，工具条/行内动作；
 * - `danger`：破坏性动作（删除、强制重跑），必须二次确认。
 *
 * 兼容层：页面里既有的 `default` / `outline` / `destructive` 继续可用，指向新变体，
 * 免得为了改个名字去动七个页面。
 *
 * 状态：`loading` 时内联 spinner + `aria-busy`，**宽度不变**（子节点保留占位，
 * 用 `invisible` 隐藏文字），所以按钮不会在提交时抖动；`disabled` 与 `loading` 都不可再点。
 */
const buttonVariants = cva(
  [
    'relative inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md',
    'font-medium select-none',
    'transition-[background-color,border-color,color,opacity] duration-[120ms] ease-out-quint',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
    'disabled:pointer-events-none disabled:opacity-50',
    'aria-busy:cursor-progress',
  ],
  {
    variants: {
      variant: {
        primary: 'bg-brand text-brand-foreground hover:bg-brand/90 active:bg-brand/95',
        secondary:
          'border border-border bg-card text-foreground hover:bg-muted active:bg-muted/80',
        ghost: 'bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
        danger: 'bg-danger text-white hover:bg-danger/90 active:bg-danger/95',
        /* 兼容旧名 */
        default: 'bg-brand text-brand-foreground hover:bg-brand/90 active:bg-brand/95',
        outline: 'border border-border bg-card text-foreground hover:bg-muted active:bg-muted/80',
        destructive: 'bg-danger text-white hover:bg-danger/90 active:bg-danger/95',
      },
      size: {
        sm: 'h-7 px-2 text-xs',
        md: 'h-8 px-2.5 text-sm',
        lg: 'h-9 px-3.5 text-sm',
        /** 只放一个图标（正方形）。 */
        icon: 'h-8 w-8 p-0',
        'icon-sm': 'h-7 w-7 p-0',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> &
  VariantProps<typeof buttonVariants> & {
    /** 提交中：显示内联 spinner，宽度不变，自动 `aria-busy` + 禁点。 */
    loading?: boolean;
    children?: ReactNode;
  };

export function Button({
  className,
  variant,
  size,
  loading = false,
  disabled = false,
  type = 'button',
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      <span className={cn('inline-flex items-center gap-2', loading && 'invisible')}>{children}</span>
      {loading ? (
        <span
          aria-hidden="true"
          data-testid="button-spinner"
          className="absolute inset-0 flex items-center justify-center"
        >
          <span className="size-3.5 animate-spin-fast rounded-full border-[1.5px] border-current border-t-transparent" />
        </span>
      ) : null}
    </button>
  );
}

export { buttonVariants };
