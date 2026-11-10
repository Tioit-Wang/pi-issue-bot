/**
 * 成本主图：按天的成本折线 + 选中点明细。
 *
 * 为什么只有一张图：这一页要回答「钱在哪天、哪个命令上」，折线给趋势，明细给构成，
 * 其余维度用表格（明细表里的占比条不是第二张图）。选中点用**真按钮**列表而不是
 * recharts 的点事件：键盘能选、读屏能读，也不依赖图表库的事件类型。
 */
import { useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { CostsResponse } from '../../lib/contract.ts';
import { formatPercent, formatTokens, formatUsd } from '../../lib/format.ts';
import { cn } from '../../lib/utils.ts';
import { CATEGORY_AXIS, ChartTip, GRID, VALUE_AXIS, usePrefersReducedMotion } from './chart-kit.tsx';

export function CostTrend({ series }: { series: CostsResponse['series'] }) {
  const reduced = usePrefersReducedMotion();
  const [picked, setPicked] = useState<string | null>(null);
  const last = series.at(-1) ?? null;
  const selected = series.find((point) => point.day === picked) ?? last;
  const windowTotal = series.reduce((sum, point) => sum + point.costUsd, 0);
  const max = Math.max(0, ...series.map((point) => point.costUsd));
  const share = selected === null || windowTotal <= 0 ? null : selected.costUsd / windowTotal;

  if (series.length === 0) {
    return <p className="py-6 text-sm text-muted-foreground">窗口内没有按天的用量记录</p>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="costs-trend">
      <div className="h-56 w-full" role="img" aria-label={`按天成本折线，共 ${String(series.length)} 天`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="day" {...CATEGORY_AXIS} tickFormatter={(value: string) => value.slice(5)} minTickGap={12} />
            <YAxis {...VALUE_AXIS} width={56} tickFormatter={(value: number) => formatUsd(value)} />
            <Tooltip
              cursor={{ stroke: 'var(--border-strong)' }}
              content={({ active, label }) => {
                const point = series.find((entry) => entry.day === String(label));
                if (active !== true || point === undefined) return null;
                return (
                  <ChartTip
                    title={point.day}
                    rows={[
                      { name: '成本', value: formatUsd(point.costUsd), color: 'var(--brand)' },
                      { name: '输入', value: formatTokens(point.inputTokens) },
                      { name: '输出', value: formatTokens(point.outputTokens) },
                    ]}
                    footnote={windowTotal > 0 ? `占窗口 ${formatPercent(point.costUsd / windowTotal)}` : undefined}
                  />
                );
              }}
            />
            <Line
              type="monotone"
              dataKey="costUsd"
              name="成本"
              stroke="var(--brand)"
              strokeWidth={1.75}
              dot={false}
              activeDot={{ r: 3 }}
              isAnimationActive={!reduced}
            />
            {selected === null ? null : (
              <ReferenceDot
                x={selected.day}
                y={selected.costUsd}
                r={3.5}
                fill="var(--brand)"
                stroke="var(--card)"
                strokeWidth={1.5}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1" data-testid="costs-trend-detail">
          <span className="text-sm text-foreground">{selected?.day ?? '—'}</span>
          <span className="tabular text-sm font-medium text-foreground">{formatUsd(selected?.costUsd)}</span>
          <span className="tabular text-xs text-muted-foreground">
            入 {formatTokens(selected?.inputTokens)} · 出 {formatTokens(selected?.outputTokens)}
          </span>
          <span className="tabular text-xs text-faint">占窗口 {formatPercent(share)}</span>
          <span className="text-xs text-faint">峰值日 {formatUsd(max)}</span>
        </div>
        <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-0.5" role="group" aria-label="选择某一天">
          {series.map((point) => {
            const active = point.day === selected?.day;
            return (
              <button
                key={point.day}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setPicked(point.day);
                }}
                className={cn(
                  'shrink-0 rounded-sm px-1.5 py-0.5 text-2xs tabular transition-colors duration-[120ms] ease-out-quint',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
                  active ? 'bg-brand-soft text-brand' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {point.day.slice(5)} · {formatUsd(point.costUsd)}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}