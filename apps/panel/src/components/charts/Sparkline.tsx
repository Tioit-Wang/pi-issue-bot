import { Area, AreaChart, ResponsiveContainer } from 'recharts';
import { chartColor } from './chart-colors.ts';

/**
 * 迷你趋势（首页第 ④ 区块）：一根线，没有坐标轴、图例、tooltip。
 *
 * 为什么不做动画（`isAnimationActive={false}`）：这张图每 10s 跟一次轮询，
 * 有动画的话每次刷新都会重新「画一遍」，等于把数据变化藏进装饰性动效里。
 * 状态变化由数字和颜色表达，曲线只负责形状。
 *
 * 序列不足 2 点时**不画空图**：契约里 `p95Ms` 就是单点值（没有时间序列），
 * 这里如实显示「单点值」而不是画一条假线。
 */
export type SparklineProps = {
  values: readonly number[];
  /** `--chart-1..5` 的序号。 */
  colorIndex?: number;
  /** 无障碍标签（屏幕阅读器与 `title` 都用它）。 */
  label: string;
  height?: number;
  testId?: string;
};

export function Sparkline({ values, colorIndex = 0, label, height = 36, testId }: SparklineProps) {
  if (values.length < 2) {
    return (
      <div
        className="flex items-center text-[11px] text-muted-foreground"
        style={{ height }}
        data-testid={testId === undefined ? undefined : `${testId}-fallback`}
      >
        单点值（契约无时间序列）
      </div>
    );
  }

  const data = values.map((value, index) => ({ index, value }));

  return (
    <div role="img" aria-label={label} title={label} style={{ height }} data-testid={testId}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <Area
            type="monotone"
            dataKey="value"
            stroke={chartColor(colorIndex)}
            fill={chartColor(colorIndex)}
            fillOpacity={0.15}
            strokeWidth={1.5}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
