import { AsyncSection } from '../components/AsyncSection.tsx';
import { StatCard } from '../components/charts/StatCard.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.tsx';
import { formatCount, formatPercent, formatTokens, formatUsd } from '../lib/format.ts';
import { useCosts } from '../lib/queries.ts';
import { PageShell } from './PageShell.tsx';

/**
 * 成本（S4，数据源 `/api/costs`，每 15s 轮询）。
 *
 * P0：合计（token / 金额 / 计价覆盖率）+ 按仓库/命令/模型的拆分 + 最贵任务。
 * W3-J 继续做的是堆叠柱与日趋势图的呈现（`DistributionBar` 的同类画法可直接复用）。
 */
export function CostsPage() {
  const { data, error, isLoading } = useCosts({ top: 10 });
  const isEmpty = data !== undefined && data.total.costUsd === 0 && data.byRepo.length === 0;

  return (
    <PageShell title="成本" description="窗口内按仓库 / 命令 / 模型拆分，含最贵 10 个任务">
      <AsyncSection
        isLoading={isLoading}
        error={error}
        isEmpty={isEmpty}
        emptyText="窗口内没有用量记录"
        testId="costs"
        skeletonHeight="h-40"
      >
        {data === undefined ? null : (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="总成本" value={formatUsd(data.total.costUsd)} hint={data.currency} />
              <StatCard
                label="输入 token"
                value={formatTokens(data.total.inputTokens)}
                hint={`输出 ${formatTokens(data.total.outputTokens)}`}
              />
              <StatCard
                label="计价覆盖率"
                value={formatPercent(data.total.pricingCoverage)}
                tone={data.total.pricingCoverage < 1 ? 'warning' : 'success'}
                hint="有 usage 记账的 run 占比（价格表未落库时的近似口径）"
              />
              <StatCard label="涉及仓库" value={formatCount(data.byRepo.length)} hint={`模型 ${formatCount(data.byModel.length)} 个`} />
            </div>

            <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
              <BreakdownTable title="按仓库" rows={data.byRepo} />
              <BreakdownTable title="按命令" rows={data.byCommand} />
              <BreakdownTable title="按模型" rows={data.byModel} />
            </div>

            <Card>
              <CardHeader>
                <CardTitle>最贵的任务</CardTitle>
              </CardHeader>
              <CardContent>
                {data.topTasks.length === 0 ? (
                  <p className="text-sm text-muted-foreground">窗口内没有用量</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="py-1">任务</th>
                        <th className="py-1">仓库</th>
                        <th className="py-1">命令</th>
                        <th className="py-1 text-right">token</th>
                        <th className="py-1 text-right">成本</th>
                        <th className="py-1 text-right">结束</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.topTasks.map((task) => (
                        <tr key={task.taskId} className="border-t border-border">
                          <td className="py-1 font-mono">{task.taskId}</td>
                          <td className="py-1 font-mono">{task.repo}</td>
                          <td className="py-1 font-mono">{task.command}</td>
                          <td className="py-1 text-right tabular-nums">
                            {formatTokens(task.inputTokens + task.outputTokens)}
                          </td>
                          <td className="py-1 text-right tabular-nums">{formatUsd(task.costUsd)}</td>
                          <td className="py-1 text-right text-muted-foreground">
                            {task.endedAt === null ? '—' : task.endedAt.slice(0, 16).replace('T', ' ')}
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

function BreakdownTable({ title, rows }: { title: string; rows: Array<{ key: string; costUsd: number; inputTokens: number; outputTokens: number; tasks: number; runs: number }> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">没有数据</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1">维度</th>
                <th className="py-1 text-right">任务</th>
                <th className="py-1 text-right">run</th>
                <th className="py-1 text-right">成本</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-t border-border">
                  <td className="py-1 font-mono">{row.key}</td>
                  <td className="py-1 text-right tabular-nums">{formatCount(row.tasks)}</td>
                  <td className="py-1 text-right tabular-nums">{formatCount(row.runs)}</td>
                  <td className="py-1 text-right tabular-nums">{formatUsd(row.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
