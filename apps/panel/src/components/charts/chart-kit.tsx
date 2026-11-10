/**
 * 图表工具箱（D2 分析页共用）：轴、网格、tooltip、reduced-motion。
 *
 * 为什么集中在这里：四张图如果各写一遍 `<CartesianGrid stroke="var(--border)">`，
 * 迟早会有一张带着默认边框/阴影/recharts 蓝跑出来。这里把「轴只有 hairline、没有边框、
 * 数字等宽、颜色只取 `chartColor()`/`--brand`」定成一处，页面只描述数据。
 *
 * reduced-motion：动画只在 `prefers-reduced-motion: no-preference` 时开。
 * CSS 的全局归零能杀掉 CSS 动画，但 Recharts 用 JS 插值，所以必须显式关。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '../../lib/utils.ts';

/** 系统是否要求减少动效（SSR / jsdom 下默认 false）。 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const update = (): void => {
      setReduced(query.matches);
    };
    query.addEventListener('change', update);
    return () => {
      query.removeEventListener('change', update);
    };
  }, []);

  return reduced;
}

/** 类目轴（X 轴当类目用）：只有一条 hairline 基线，刻度字 10px 且是第三级灰。 */
export const CATEGORY_AXIS = {
  stroke: 'var(--border)',
  tick: { fill: 'var(--faint-foreground)', fontSize: 10 },
  tickLine: false,
  axisLine: { stroke: 'var(--border)' },
} as const;

/** 数值轴：不画轴线（留白即分层），刻度等宽数字。 */
export const VALUE_AXIS = {
  tick: { fill: 'var(--faint-foreground)', fontSize: 10 },
  tickLine: false,
  axisLine: false,
} as const;

/** 网格：只留水平 hairline，不做虚线（虚线在深色下会显得脏）。 */
export const GRID = {
  stroke: 'var(--border)',
  vertical: false,
} as const;

export type TipRow = { name: string; value: string; color?: string | undefined };

/**
 * 自定义 tooltip 内容：面 + hairline + 等宽数字。
 *
 * 不用 recharts 默认 tooltip 的原因：它带白底、边框与阴影，且数字不 tabular；
 * 在深色下默认样式几乎读不清。这里与 `Tooltip`（组件库那个）视觉一致：`shadow-overlay` 只给浮层。
 */
export function ChartTip({
  title,
  rows,
  footnote,
}: {
  title: ReactNode;
  rows: readonly TipRow[];
  footnote?: ReactNode;
}) {
  return (
    <div className="pointer-events-none min-w-32 rounded-md border border-border bg-card px-2 py-1.5 text-xs shadow-overlay">
      <p className="text-2xs text-faint">{title}</p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {rows.map((row) => (
          <li key={row.name} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              {row.color === undefined ? null : (
                <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: row.color }} />
              )}
              {row.name}
            </span>
            <span className="tabular text-foreground">{row.value}</span>
          </li>
        ))}
      </ul>
      {footnote === undefined ? null : <p className="mt-1 text-2xs text-faint">{footnote}</p>}
    </div>
  );
}

/**
 * 内联占比条（表格里用）：宽度 = 占比，轨道是 hairline 灰。
 *
 * 为什么不用饼图：一列数字旁边跟一根短条，扫视成本最低，也不需要图例；
 * `role="img"` + `aria-label` 让读屏用户听到「占比 61%」而不是「一根 div」。
 */
export function ShareBar({
  ratio,
  label,
  tone = 'brand',
  className,
}: {
  /** 0–1。负值/NaN 按 0 处理；>1 会夹到 100%。 */
  ratio: number | null;
  /** 读屏文案（例如「占比 61.3%」）。 */
  label: string;
  tone?: 'brand' | 'success' | 'warn' | 'danger' | 'neutral';
  className?: string;
}) {
  const safe = ratio === null || !Number.isFinite(ratio) ? 0 : Math.min(1, Math.max(0, ratio));
  const fill = {
    brand: 'bg-brand',
    success: 'bg-success',
    warn: 'bg-warn',
    danger: 'bg-danger',
    neutral: 'bg-neutral',
  }[tone];

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn('flex h-1.5 w-full min-w-16 items-center overflow-hidden rounded-full bg-border', className)}
    >
      <span
        className={cn('h-full rounded-full transition-[width] duration-[220ms] ease-out-quint', fill)}
        style={{ width: `${String(safe * 100)}%` }}
      />
    </span>
  );
}

/** 轴标签缩写：`acme/widgets` → `widgets`（否则类目名把轴挤满）。 */
export function shortKey(value: string): string {
  const slash = value.lastIndexOf('/');
  return slash === -1 ? value : value.slice(slash + 1);
}
