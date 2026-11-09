import { AsyncSection } from '../components/AsyncSection.tsx';
import { StatCard } from '../components/charts/StatCard.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.tsx';
import { formatCount, formatPercent, formatTimeCell } from '../lib/format.ts';
import { useReverts } from '../lib/queries.ts';
import { PageShell } from './PageShell.tsx';

/**
 * 质量（S5，数据源 `/api/quality/reverts`，每 15s 轮询）。
 *
 * 这是 plan 里唯一的质量信号：**自动执行后被人改回的比例**（tech-plan §7.5）。
 * `rate` 为 `null` 时显示 `—`（分母为 0，不能用 0 冒充）。
 */
export function QualityPage() {
  const { data, error, isLoading } = useReverts({ limit: 50 });

  return (
    <PageShell title="质量" description="改回率 = 被改回的动作 / 已应用的动作（窗口内）">
      <AsyncSection
        isLoading={isLoading}
        error={error}
        isEmpty={data !== undefined && data.overall.applied === 0}
        emptyText="窗口内没有已应用的动作"
        testId="quality"
        skeletonHeight="h-40"
      >
        {data === undefined ? null : (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StatCard
                label="改回率"
                value={formatPercent(data.overall.rate)}
                tone={data.overall.rate === null ? 'neutral' : data.overall.rate > 0.2 ? 'danger' : 'success'}
                hint={`${formatCount(data.overall.reverted)} / ${formatCount(data.overall.applied)}`}
              />
              <StatCard label="已应用动作" value={formatCount(data.overall.applied)} />
              <StatCard label="被改回" value={formatCount(data.overall.reverted)} />
            </div>

            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>按命令</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-1 text-xs">
                  {data.byCommand.length === 0 ? (
                    <p className="text-muted-foreground">没有数据</p>
                  ) : (
                    data.byCommand.map((bucket) => (
                      <div key={bucket.key} className="flex items-center justify-between gap-2">
                        <span className="font-mono">{bucket.key}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {formatCount(bucket.reverted)} / {formatCount(bucket.applied)} · {formatPercent(bucket.rate)}
                        </span>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>按仓库</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-1 text-xs">
                  {data.byRepo.length === 0 ? (
                    <p className="text-muted-foreground">没有数据</p>
                  ) : (
                    data.byRepo.map((bucket) => (
                      <div key={bucket.key} className="flex items-center justify-between gap-2">
                        <span className="font-mono">{bucket.key}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {formatCount(bucket.reverted)} / {formatCount(bucket.applied)} · {formatPercent(bucket.rate)}
                        </span>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>逐条改回记录</CardTitle>
              </CardHeader>
              <CardContent>
                {data.records.length === 0 ? (
                  <p className="text-sm text-muted-foreground">窗口内没有被改回的动作</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="py-1">任务</th>
                        <th className="py-1">仓库</th>
                        <th className="py-1">命令</th>
                        <th className="py-1">方式</th>
                        <th className="py-1 text-right">改回时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.records.map((record) => (
                        <tr key={record.actionId} className="border-t border-border">
                          <td className="py-1 font-mono">{record.taskId}</td>
                          <td className="py-1 font-mono">{record.repo}</td>
                          <td className="py-1 font-mono">{record.command}</td>
                          <td className="py-1">{record.revertKind}</td>
                          <td className="py-1 text-right text-muted-foreground">
                            {formatTimeCell(record.revertedAt).text}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </AsyncSection>
    </PageShell>
  );
}
