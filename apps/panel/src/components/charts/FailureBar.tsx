import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { usePrefersReducedMotion } from './chart-kit.tsx';
import type { OverviewResponse } from '../../lib/contract.ts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.tsx';
import { chartColor } from './chart-colors.ts';

/**
 * 失败分类 Top5（总览页）：单序列横向条形，长度可以直接比较。
 *
 * 分类名保持契约的 kebab-case 原样（`sandbox-oom`），不翻译成中文——
 * 面板的定位是运维工具，和日志/代码里的名字一致比「好看」重要。
 */
export type FailureBarProps = {
  data: OverviewResponse['failureTop'];
  height?: number;
};

export function FailureBar({ data, height = 180 }: FailureBarProps) {
  const reduced = usePrefersReducedMotion();
  return (
    <Card>
      <CardHeader>
        <CardTitle>失败分类 Top5</CardTitle>
        <CardDescription>窗口内按数量降序</CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">窗口内没有失败</p>
        ) : (
          <ResponsiveContainer width="100%" height={height}>
            <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 24 }}>
              <XAxis type="number" allowDecimals={false} stroke="var(--muted-foreground)" fontSize={11} />
              <YAxis
                type="category"
                dataKey="failureClass"
                stroke="var(--muted-foreground)"
                fontSize={11}
                width={96}
              />
              <Tooltip contentStyle={{ fontSize: 12 }} />
              <Bar dataKey="count" name="次数" fill={chartColor(0)} radius={[0, 4, 4, 0]} barSize={14} isAnimationActive={!reduced} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
