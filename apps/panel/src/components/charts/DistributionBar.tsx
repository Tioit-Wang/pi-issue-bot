import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { usePrefersReducedMotion } from './chart-kit.tsx';
import type { OverviewResponse } from '../../lib/contract.ts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.tsx';
import { chartColor } from './chart-colors.ts';

/**
 * 结果分布（总览页）：一份「横向堆叠柱」——x 轴是数量，y 轴只有一个类目。
 *
 * 为什么不是饼图：分布只有 2–6 个桶，堆叠条比饼图更容易比较长度，也更省高度。
 * 每段的颜色按**契约枚举的固定顺序**取（`overcome` 字母序在查询层已定），
 * 同一 outcome 在不同刷新里颜色不会跳。
 */
export type DistributionBarProps = {
  data: OverviewResponse['outcomeDistribution'];
  height?: number;
};

const OUTCOME_LABEL: Record<string, string> = {
  success: '成功',
  failed: '失败',
  'timed-out': '超时',
  'degenerate-output': '熔断',
  'parse-failed': '解析失败',
  interrupted: '中断',
};

export function DistributionBar({ data, height = 96 }: DistributionBarProps) {
  const reduced = usePrefersReducedMotion();
  const point = { label: '结果', ...Object.fromEntries(data.map((item) => [item.outcome, item.count])) };

  return (
    <Card>
      <CardHeader>
        <CardTitle>结果分布</CardTitle>
        <CardDescription>窗口内按 run 计数（没出现的 outcome 不占位）</CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">窗口内没有 run</p>
        ) : (
          <ResponsiveContainer width="100%" height={height}>
            <BarChart data={[point]} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }}>
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="label" hide />
              <Tooltip contentStyle={{ fontSize: 12 }} />
              {data.map((item, index) => (
                <Bar
                  key={item.outcome}
                  dataKey={item.outcome}
                  name={OUTCOME_LABEL[item.outcome] ?? item.outcome}
                  stackId="outcomes"
                  fill={chartColor(index)}
                  radius={[0, 0, 0, 0]}
                  isAnimationActive={!reduced}
                >
                  {data.map((cell) => (
                    <Cell key={cell.outcome} fill={chartColor(index)} />
                  ))}
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
