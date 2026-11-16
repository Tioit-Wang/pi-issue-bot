import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select.tsx';
import { cn } from '../lib/utils.ts';

/**
 * 工具栏筛选下拉 —— **Radix `Select` 的项目层包装**（不是新原语）。
 *
 * 为什么不直接在页面里摊开 `Select / SelectTrigger / SelectContent / SelectItem`：
 * 三个列表页（Issue 队列 / 运行列表 / 仓库筛选）各有 4~7 个下拉，摊开写会得到
 * 7 份「哨兵值 ↔ 空字符串」的转换代码，这正是「同一个规则第二处真相」的起点。
 *
 * 唯一的规则：**`value === ''` 表示「不筛选」**（进 URL 时删键）。Radix 的
 * `SelectItem` 不允许空字符串 value（空串是它内部表示「没有值」的哨兵），
 * 所以这里用 `ALL` 做占位，进去 / 出来各转一次，页面只跟 `''` 打交道。
 *
 * 文案口径：`allLabel` 给「全部 X」；传 `null` 表示**必须选一个**（不提供清空项）。
 */
export type FilterOption = { value: string; label: string };

/** Radix 不接受空字符串 value 做选项，这是「不筛选」的内部占位。 */
const ALL = '__all__';

export type FilterSelectProps = {
  /** 无障碍名（`aria-label`）：同一页有多个筛选时必须是具体的（「状态筛选」而不是「筛选」）。 */
  label: string;
  /** 当前值；`''` = 不筛选。 */
  value: string;
  onChange: (next: string) => void;
  /** 候选项；其中有 `value === ''` 的项会被当作「全部」项渲染。 */
  options: readonly FilterOption[];
  /** 「全部」项的文案；不传则取 `options` 里 `value === ''` 的项，`null` 表示不提供该入口。 */
  allLabel?: string | null;
  disabled?: boolean;
  className?: string;
  testId?: string;
};

/** 一个筛选下拉（默认 `size="sm"`：工具栏里跟 `Button size="sm"` 同高）。 */
export function FilterSelect({
  label,
  value,
  onChange,
  options,
  allLabel,
  disabled = false,
  className,
  testId,
}: FilterSelectProps) {
  // `allLabel` 未给：沿用调用方写的「全部 X」；给了 `null`：这条筛选必须选一个
  const allOption = options.find((option) => option.value === '');
  const resolvedAll = allLabel === undefined ? (allOption?.label ?? null) : allLabel;
  const items = options.filter((option) => option.value !== '');

  return (
    <span className="inline-flex items-center gap-1.5" data-testid={testId}>
      <Select
        value={value === '' ? ALL : value}
        onValueChange={(next) => {
          onChange(next === ALL ? '' : next);
        }}
        disabled={disabled}
      >
        <SelectTrigger aria-label={label} size="sm" className={cn('min-w-32', className)}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {/* `SelectItem` 必须套在 `SelectGroup` 里（shadcn 组合规则，避免内容容器直接挂 item） */}
          <SelectGroup>
            {resolvedAll === null ? null : <SelectItem value={ALL}>{resolvedAll}</SelectItem>}
            {items.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </span>
  );
}
