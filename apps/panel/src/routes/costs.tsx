/**
 * 成本（`/api/costs`，每 15s 轮询）：**一条筛选条 + 一张主图 + 三张明细表**。
 *
 * 分工：
 *  - 主图（唯一一张）：按天成本折线，选中某天看那天的构成；
 *  - 明细表：按命令 / 仓库 / 模型三选一，每条带「占比」内联条（不用饼图）；
 *  - 最贵任务表：能点进任务详情。
 *
 * 数字口径：金额/token/百分比只经 `lib/format.ts`；`pricingCoverage < 1` 时**必须**说出来
 * （未命中价格表的 run 成本按 0 计，别当免费）。
 */
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { AsyncSection } from '../components/AsyncSection.tsx';
import { Section } from '../components/Section.tsx';
import { Toolbar } from '../components/Toolbar.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { ShareBar } from '../components/charts/chart-kit.tsx';
import { CostTrend } from '../components/charts/CostTrend.tsx';
import { RepoFilterSelect } from '../components/repo-filter.tsx';
import { Segmented } from '../components/ui/segmented.tsx';
import { Select } from '../components/ui/select.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.tsx';
import type { CostsResponse } from '../lib/contract.ts';
import { EMPTY, formatCount, formatPercent, formatTimeCell, formatTokens, formatUsd } from '../lib/format.ts';
import { useCosts } from '../lib/queries.ts';

type Dimension = 'command' | 'repo' | 'model';

/** 时间窗 → `from`（`to` 不传 = 服务端取到此刻）。 */
const RANGE_DAYS: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90 };

export function CostsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const repo = searchParams.get('repo') ?? '';
  const range = searchParams.get('range') ?? '7d';
  const command = searchParams.get('command') ?? '';
  const [dimension, setDimension] = useState<Dimension>('command');

  const query = useMemo(() => {
    const days = RANGE_DAYS[range] ?? null;
    return {
      top: 10,
      ...(repo === '' ? {} : { repo }),
      ...(days === null ? {} : { from: new Date(Date.now() - days * 86_400_000).toISOString() }),
    };
  }, [repo, range]);

  const { data, error, isLoading, refetch } = useCosts(query);

  const isEmpty =
    data !== undefined &&
    data.total.costUsd === 0 &&
    data.byRepo.length === 0 &&
    data.byCommand.length === 0 &&
    data.topTasks.length === 0;

  const setParam = (key: string, value: string): void => {
    const next = new URLSearchParams(searchParams);
    if (value === '') next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader
        title="成本"
        description="钱花在哪：按天的总成本、按命令 / 仓库 / 模型的构成、最贵的 10 个任务（每 15 秒刷新）"
        actions={
          error === null ? undefined : (
            <button
              type="button"
              onClick={() => {
                void refetch();
              }}
              className="h-7 rounded-md border border-border px-2 text-xs text-foreground hover:bg-muted"
            >
              重试
            </button>
          )
        }
      />

      <Toolbar
        meta={command === '' ? undefined : '命令筛选只收窄展示：/api/costs 不支持 command 参数'}
      >
        <span className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="costs-filters">
          <RepoFilterSelect testId="costs-repo-filter" />
          <Segmented
            label="时间窗"
            value={range}
            onChange={(next) => {
              setParam('range', next === '7d' ? '' : next);
            }}
            options={[
              { value: '7d', label: '7 天' },
              { value: '30d', label: '30 天' },
              { value: '90d', label: '90 天' },
            ]}
          />
          <Select
            aria-label="命令筛选"
            options={(data?.byCommand ?? []).map((bucket) => ({ value: bucket.key, label: bucket.key }))}
            placeholder="全部命令"
            value={command}
            onChange={(event) => {
              setParam('command', event.target.value);
            }}
          />
          {repo === '' ? null : <span className="text-2xs text-faint">{`只看 ${repo}`}</span>}
        </span>
      </Toolbar>

      <AsyncSection
        isLoading={isLoading}
        error={error}
        isEmpty={isEmpty}
        emptyText="窗口内没有用量记录（没跑过任务，或模型没回 usage）"
        testId="costs"
        skeletonRows={6}
      >
        {data === undefined ? null : (
          <CostsContent
            data={data}
            commandFilter={command}
            dimension={dimension}
            onDimensionChange={setDimension}
            onOpenTask={(taskId) => {
              void navigate(`/tasks/${encodeURIComponent(taskId)}`);
            }}
          />
        )}
      </AsyncSection>
    </div>
  );
}

function CostsContent({
  data,
  commandFilter,
  dimension,
  onDimensionChange,
  onOpenTask,
}: {
  data: CostsResponse;
  commandFilter: string;
  dimension: Dimension;
  onDimensionChange: (next: Dimension) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const totalCost = data.total.costUsd;
  const buckets =
    dimension === 'command' ? data.byCommand : dimension === 'repo' ? data.byRepo : data.byModel;
  const rows = commandFilter === '' ? buckets : buckets.filter((bucket) => bucket.key === commandFilter);
  const tasks = commandFilter === '' ? data.topTasks : data.topTasks.filter((task) => task.command === commandFilter);
  const window = `${formatTimeCell(data.window.from).title} — ${formatTimeCell(data.window.to).title}`;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Section
        first
        title="按天的成本"
        description="按 UTC 自然日聚合（metrics_daily，明细保留 90 天）"
      >
        <CostTrend series={data.series} />
        <p className="mt-1.5 text-xs text-muted-foreground" data-testid="costs-summary">
          <span className="tabular text-foreground">{formatUsd(totalCost)}</span> 合计 · 输入{' '}
          <span className="tabular">{formatTokens(data.total.inputTokens)}</span> / 输出{' '}
          <span className="tabular">{formatTokens(data.total.outputTokens)}</span> token · 定价覆盖率{' '}
          <span className="tabular">{formatPercent(data.total.pricingCoverage)}</span>
          {data.total.pricingCoverage < 1 ? (
            <span className="text-warn-fg">（未命中价格表的 run 成本按 0 计，别当免费）</span>
          ) : null}
        </p>
      </Section>

      <Section
        title="明细"
        description="一个任务重试多次会让 run 数大于任务数"
        actions={
          <Segmented
            label="明细维度"
            value={dimension}
            onChange={(next) => {
              onDimensionChange(next as Dimension);
            }}
            options={[
              { value: 'command', label: '按命令' },
              { value: 'repo', label: '按仓库' },
              { value: 'model', label: '按模型' },
            ]}
          />
        }
      >
        <Table stickyFirst>
          <TableHeader>
            <TableRow>
              <TableHead>{dimension === 'command' ? '命令' : dimension === 'repo' ? '仓库' : '模型'}</TableHead>
              <TableHead className="text-right">任务 / run</TableHead>
              <TableHead className="text-right">token 入 / 出</TableHead>
              <TableHead className="text-right">成本</TableHead>
              <TableHead className="w-40">占比</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                  这个维度没有数据
                </TableCell>
              </TableRow>
            ) : (
              rows.map((bucket) => {
                const share = totalCost <= 0 ? null : bucket.costUsd / totalCost;
                return (
                  <TableRow key={bucket.key} data-testid={`costs-bucket-${bucket.key}`}>
                    <TableCell className="font-mono text-xs">{bucket.key}</TableCell>
                    <TableCell className="tabular text-right text-xs text-muted-foreground">
                      {formatCount(bucket.tasks)} / {formatCount(bucket.runs)}
                    </TableCell>
                    <TableCell className="tabular text-right text-xs text-muted-foreground">
                      {formatTokens(bucket.inputTokens)} / {formatTokens(bucket.outputTokens)}
                    </TableCell>
                    <TableCell className="tabular text-right text-xs">{formatUsd(bucket.costUsd)}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <ShareBar ratio={share} label={`占比 ${formatPercent(share)}`} />
                        <span className="tabular w-12 shrink-0 text-right text-2xs text-muted-foreground">
                          {formatPercent(share)}
                        </span>
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Section>

      <Section title="最贵的任务">
        <Table stickyFirst>
          <TableHeader>
            <TableRow>
              <TableHead>任务</TableHead>
              <TableHead>仓库</TableHead>
              <TableHead>命令</TableHead>
              <TableHead className="text-right">token 入 / 出</TableHead>
              <TableHead className="text-right">成本</TableHead>
              <TableHead className="text-right">结束</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
                  窗口内没有用量
                </TableCell>
              </TableRow>
            ) : (
              tasks.map((task) => {
                const ended = formatTimeCell(task.endedAt);
                return (
                  <TableRow
                    key={task.taskId}
                    className="cursor-pointer"
                    onClick={() => {
                      onOpenTask(task.taskId);
                    }}
                  >
                    <TableCell className="font-mono text-xs">
                      <button
                        type="button"
                        className="hover:text-brand hover:underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenTask(task.taskId);
                        }}
                      >
                        {task.taskId}
                      </button>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{task.repo}</TableCell>
                    <TableCell className="font-mono text-xs">{task.command}</TableCell>
                    <TableCell className="tabular text-right text-xs text-muted-foreground">
                      {formatTokens(task.inputTokens)} / {formatTokens(task.outputTokens)}
                    </TableCell>
                    <TableCell className="tabular text-right text-xs">{formatUsd(task.costUsd)}</TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {task.endedAt === null ? (
                        <span className="text-faint">{EMPTY}</span>
                      ) : (
                        <time title={ended.title}>{ended.text}</time>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
        <p className="text-2xs text-faint">统计窗口 {window} · 生成于 {formatTimeCell(data.generatedAt).text} · 币种 {data.currency}</p>
      </Section>
    </div>
  );
}