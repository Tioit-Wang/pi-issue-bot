import type { SelectHTMLAttributes } from 'react';
import { cn } from '../../lib/utils.ts';

/**
 * 下拉选择：原生 `<select>`（键盘、可访问性、移动端选择器全部免费）。
 *
 * 高 32px 与按钮 `md` 对齐；只给 hairline 描边，**不用阴影**。
 */
export type SelectOption = { value: string; label: string };

export type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> & {
  options: readonly SelectOption[];
  /** 空值选项的文案（例如「全部仓库」）；传 `null` 表示不显示空项。 */
  placeholder?: string | null;
};

export function Select({ className, options, placeholder = '全部', ...props }: SelectProps) {
  return (
    <select
      className={cn(
        'h-8 min-w-0 rounded-md border border-input bg-card px-2 text-sm text-foreground',
        'transition-[border-color,background-color] duration-[120ms] ease-out-quint',
        'hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
        'disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {placeholder === null ? null : <option value="">{placeholder}</option>}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}