import { AsyncSection } from '../components/AsyncSection.tsx';
import { DistributionBar } from '../components/charts/DistributionBar.tsx';
import { FailureBar } from '../components/charts/FailureBar.tsx';
import { StatCard } from '../components/charts/StatCard.tsx';
import { TrendChart } from '../components/charts/TrendChart.tsx';
import { formatCount, formatDuration, formatPercent, formatUsd } from '../lib/format.ts';
import { useOverview } from '../lib/queries.ts';
import { PageShell } from './PageShell.tsx';

/**
 * 总览（S1，数据源 `/api/overview`，每 10s 轮询）。
 *
 * P0 已接真数据：4 张 StatCard + 趋势线 + 结果分布 + 失败 Top5。
 * W3-J 在这里继续做的是「呈现细节」（配色、hover、异常空窗提示），数据链路不用再动。
 */
export function OverviewPage() {
  const { data, error, isLoading } = useOverview();

  return (
    <PageShell title="总览" description="今日吞吐、最近 24 小时趋势、队列与熔断状态（每 10 秒刷新）">
      <AsyncSection
        isLoading={isLoading}
        error={error}
        isEmpty={data === undefined}
        emptyText="还没有任何数据（服务刚启动？）"
        testId="overview"
        skeletonHeight="h-40"
      >
        {data === undefined ? null : (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label="今日任务"
                value={formatCount(data.today.tasks)}
                hint={`成功 ${formatCount(data.today.succeeded)} · 失败 ${formatCount(data.today.failed)}`}
              />
              <StatCard
                label="成功率"
                value={formatPercent(data.today.successRate)}
                tone={
                  data.today.successRate === null
                    ? 'neutral'
                    : data.today.successRate >= 0.9
                      ? 'success'
                      : 'warning'
                }
                hint={`webhook 投递 ${formatCount(data.today.deliveries)} 次`}
              />
              <StatCard
                label="今日成本"
                value={formatUsd(data.today.costUsd)}
                hint={`p50 ${formatDuration(data.today.p50Ms)} · p95 ${formatDuration(data.today.p95Ms)}`}
              />
              <StatCard
                label="队列深度"
                value={formatCount(data.queue.depth)}
                tone={data.queue.depth > 5 ? 'warning' : 'neutral'}
                hint={`执行中 ${formatCount(data.queue.active)} · 最老等待 ${formatDuration(data.queue.oldestQueuedMs)}`}
              />
            </div>

            {data.queue.pausedUntil === null ? null : (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                全局 429 熔断中，解除时间 {data.queue.pausedUntil}
              </p>
            )}

            <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
              <div className="xl:col-span-2">
                <TrendChart points={data.trend} />
              </div>
              <div className="flex flex-col gap-3">
                <DistributionBar data={data.outcomeDistribution} />
                <FailureBar data={data.failureTop} />
              </div>
            </div>

            <p className="text-[11px] text-muted-foreground">
              统计窗口 {data.window.from} — {data.window.to} · doctor {data.doctor.status} · 生成于{' '}
              {data.generatedAt}
            </p>
          </div>
        )}
      </AsyncSection>
    </PageShell>
  );
}
