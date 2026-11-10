import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../../lib/utils.ts';

/**
 * 标签页：**数据驱动**（`items`）而不是 shadcn 的 context 三件套。
 *
 * 视觉：下划线式（当前项 2px 品牌下划线 + 文字转前景色），不是胶囊高亮 ——
 * 与左栏「当前项 = 品牌色 8% 底 + 左缘色条」保持同一套「选区」语言。
 *
 * 键盘：`←/→` 在标签间移动并切换（`role=tablist` + `aria-selected`），Tab 落进面板。
 */
export type TabItem = {
  key: string;
  label: string;
  content: ReactNode;
  /** 右侧的小数字（例如「事件 12」），可选。 */
  count?: number;
};

export type TabsProps = {
  items: readonly TabItem[];
  /** 受控值；不传则用内部状态（默认第一项）。 */
  value?: string;
  onValueChange?: (key: string) => void;
  className?: string;
  /** 面板的 `aria-label`（一个页面有多个 tablist 时必须给）。 */
  label?: string;
};

export function Tabs({ items, value, onValueChange, className, label }: TabsProps) {
  const [internal, setInternal] = useState<string>(items[0]?.key ?? '');
  const active = value ?? internal;
  const current = items.find((item) => item.key === active) ?? items[0];

  const select = (key: string): void => {
    if (value === undefined) setInternal(key);
    onValueChange?.(key);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const index = items.findIndex((item) => item.key === current?.key);
    if (index < 0) return;
    event.preventDefault();
    const next =
      event.key === 'ArrowRight' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    const target = items[next];
    if (target === undefined) return;
    select(target.key);
    // 焦点跟着选区走（roving tabindex）
    const button = event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next];
    button?.focus();
  };

  return (
    <div className={cn('flex min-w-0 flex-col gap-3', className)}>
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className="flex items-center gap-4 border-b border-border"
      >
        {items.map((item) => {
          const selected = item.key === current?.key;
          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                select(item.key);
              }}
              className={cn(
                'relative -mb-px inline-flex items-center gap-1.5 border-b-2 px-0.5 py-1.5 text-sm font-medium',
                'transition-[color,border-color] duration-[120ms] ease-out-quint',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
                selected
                  ? 'border-brand text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {item.label}
              {item.count === undefined ? null : (
                <span className="text-2xs tabular text-faint">{item.count}</span>
              )}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" className="min-w-0">
        {current?.content}
      </div>
    </div>
  );
}