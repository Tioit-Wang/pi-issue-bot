import { useState, type ReactNode } from 'react';
import { cn } from '../../lib/utils.ts';

/**
 * 标签页：**数据驱动**（`items`）而不是 shadcn 的 context 三件套。
 *
 * 理由：面板只有详情页一处需要 Tabs（事件时间线 / 信封 / diff），
 * 数据驱动版本少 40 行样板、也不需要 `TabsContent` 的挂载顺序约定；
 * 需要受控时传 `value` + `onValueChange`。
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
};

export function Tabs({ items, value, onValueChange, className }: TabsProps) {
  const [internal, setInternal] = useState<string>(items[0]?.key ?? '');
  const active = value ?? internal;
  const current = items.find((item) => item.key === active) ?? items[0];

  const select = (key: string): void => {
    if (value === undefined) setInternal(key);
    onValueChange?.(key);
  };

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div role="tablist" className="inline-flex items-center gap-1 rounded-lg bg-muted p-1">
        {items.map((item) => {
          const selected = item.key === current?.key;
          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => {
                select(item.key);
              }}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors',
                selected ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {item.label}
              {item.count === undefined ? null : <span className="text-[10px] opacity-70">{item.count}</span>}
            </button>
          );
        })}
      </div>
      <div role="tabpanel">{current?.content}</div>
    </div>
  );
}
