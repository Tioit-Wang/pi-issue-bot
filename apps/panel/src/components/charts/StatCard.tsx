import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.tsx';
import { cn } from '../../lib/utils.ts';

/**
 * 顶部数字卡（tech-plan §9.3：总览页 4 个 StatCard）。
 * `value` 已经是格式化后的字符串（由 `lib/format.ts` 产出），卡片不做任何数字加工。
 */
export type StatCardProps = {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  /** 语义色调：只影响数字颜色（成功绿 / 失败红 / 中性）。 */
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
  className?: string;
  testId?: string;
};

const TONE_CLASS: Record<NonNullable<StatCardProps['tone']>, string> = {
  neutral: 'text-foreground',
  success: 'text-success-fg',
  warning: 'text-warn-fg',
  danger: 'text-danger-fg',
};

export function StatCard({ label, value, hint, tone = 'neutral', className, testId }: StatCardProps) {
  return (
    <Card className={className} data-testid={testId}>
      <CardHeader>
        <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent className="pt-2">
        <div className={cn('text-2xl font-semibold tabular-nums', TONE_CLASS[tone])}>{value}</div>
        {hint === undefined ? null : <CardDescription className="mt-1">{hint}</CardDescription>}
      </CardContent>
    </Card>
  );
}
