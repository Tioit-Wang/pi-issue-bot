import type { SelectHTMLAttributes } from 'react';
import { cn } from '../../lib/utils.ts';

/**
 * 下拉选择：原生 `<select>`（可访问性与键盘行为免费拿到，内网工具没必要自研 listbox）。
 * 选项用 `options` 传，省掉 `<option>` 的重复样板。
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
        'h-9 rounded-md border border-input bg-card px-2 text-sm text-foreground shadow-xs outline-none',
        'focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
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
