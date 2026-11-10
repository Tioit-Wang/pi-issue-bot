import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../../lib/utils.ts';

/**
 * 分段控件（2~4 个互斥小选项）：触发面 `off / mention / auto`、时间窗、视图切换。
 *
 * 为什么不用 `Select`：选项少且需要一眼看全当前值（设置页的触发面尤其如此）；
 * 为什么不用三个按钮：那会变成三个独立的「动作」，而这里语义是**单选**。
 *
 * 可访问性：`role="radiogroup"` + `role="radio"` + `aria-checked`，
 * `←/→/Home/End` 移动并选中（roving tabindex）。
 */
export type SegmentedOption<T extends string> = {
  value: T;
  label: ReactNode;
  /** 选项说明（读屏用，界面上不显示）。 */
  hint?: string;
  disabled?: boolean;
};

export type SegmentedProps<T extends string> = {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** `aria-label`：这一组在问什么（「触发方式」）。 */
  label: string;
  className?: string;
  size?: 'sm' | 'md';
};

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
  size = 'sm',
}: SegmentedProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  const move = (event: KeyboardEvent<HTMLDivElement>): void => {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const enabled = options
      .map((option, index) => ({ option, index }))
      .filter((entry) => entry.option.disabled !== true);
    if (enabled.length === 0) return;
    const position = enabled.findIndex((entry) => entry.index === current);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? enabled.length - 1
          : event.key === 'ArrowRight'
            ? (position + 1) % enabled.length
            : (position - 1 + enabled.length) % enabled.length;
    const target = enabled[next];
    if (target === undefined) return;
    onChange(target.option.value);
    refs.current[target.index]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={move}
      data-testid="segmented"
      className={cn(
        'inline-flex items-center rounded-md border border-border bg-muted p-px',
        className,
      )}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.hint}
            tabIndex={selected ? 0 : -1}
            disabled={option.disabled}
            onClick={() => {
              onChange(option.value);
            }}
            className={cn(
              'rounded-sm font-medium whitespace-nowrap transition-[background-color,color] duration-[120ms] ease-out-quint',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
              'disabled:pointer-events-none disabled:opacity-50',
              size === 'sm' ? 'h-6 px-2 text-xs' : 'h-7 px-2.5 text-sm',
              selected
                ? 'bg-card text-foreground shadow-[inset_0_0_0_1px_var(--border)]'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}