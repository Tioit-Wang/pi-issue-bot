/**
 * 横向条形列表（带数值）：质量页的改回率、失败/改回分类分布都用它。
 *
 * 为什么不用 recharts：行数少、每条都要带一个精确数字与「n / N」口径，
 * HTML 行比 SVG 更省高度、能换行、能聚焦，也不会在窄屏被裁掉。
 */
import { cn } from '../../lib/utils.ts';
import { ShareBar } from './chart-kit.tsx';

export type BarListItem = {
  key: string;
  /** 条形长度用的量（比率或计数）。 */
  value: number;
  /** 右侧的文字（已经格式化）。 */
  display: string;
  /** 左侧标签下方的小字（口径、分母）。 */
  note?: string;
  tone?: 'brand' | 'success' | 'warn' | 'danger' | 'neutral';
};

export function BarList({
  items,
  max,
  emptyText,
  testId,
}: {
  items: readonly BarListItem[];
  /** 条形的满格值；默认取最大值（缺失时按 1）。 */
  max?: number;
  emptyText: string;
  testId?: string;
}) {
  if (items.length === 0) return <p className="py-4 text-sm text-muted-foreground">{emptyText}</p>;

  const scale = max ?? Math.max(...items.map((item) => item.value), 1);
  const denom = scale <= 0 ? 1 : scale;

  return (
    <ul className="flex flex-col gap-1.5" data-testid={testId}>
      {items.map((item) => (
        <li key={item.key} className="grid min-w-0 grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto] items-center gap-2">
          <div className="min-w-0">
            <span className="block truncate font-mono text-xs text-foreground" title={item.key}>
              {item.key}
            </span>
            {item.note === undefined ? null : <span className="block truncate text-2xs text-faint">{item.note}</span>}
          </div>
          <ShareBar
            ratio={item.value / denom}
            label={`${item.key}：${item.display}`}
            tone={item.tone ?? 'brand'}
            className={cn('min-w-8')}
          />
          <span className="tabular shrink-0 text-xs text-foreground">{item.display}</span>
        </li>
      ))}
    </ul>
  );
}