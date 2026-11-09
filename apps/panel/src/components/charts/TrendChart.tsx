import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { OverviewResponse } from '../../lib/contract.ts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.tsx';
import { chartColor } from './chart-colors.ts';

/**
 * 24 小时吞吐折线（总览页）：`tasks` / `succeeded` / `failed` 三条线。
 *
 * 数据源是 `/api/overview` 的 `trend`（契约：24 个整点、升序、空小时补 0），
 * 所以这里**不做任何补点或排序**——图表只负责画。
 * 时间轴只显示 `HH:mm`（UTC，契约的时间一律 UTC，面板不做时区换算）。
 */
export type TrendChartProps = {
  points: OverviewResponse['trend'];
  height?: number;
};

export function TrendChart({ points, height = 260 }: TrendChartProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>24 小时吞吐</CardTitle>
        <CardDescription>按小时（UTC）聚合，含空小时</CardDescription>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={height}>
          <LineChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="at"
              tickFormatter={(value: string) => value.slice(11, 16)}
              stroke="var(--muted-foreground)"
              fontSize={11}
              minTickGap={24}
            />
            <YAxis stroke="var(--muted-foreground)" fontSize={11} allowDecimals={false} />
            <Tooltip contentStyle={{ fontSize: 12 }} labelFormatter={(value) => String(value).slice(0, 16).replace('T', ' ')} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" dataKey="tasks" name="任务" stroke={chartColor(0)} strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="succeeded" name="成功" stroke={chartColor(1)} strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="failed" name="失败" stroke={chartColor(3)} strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
