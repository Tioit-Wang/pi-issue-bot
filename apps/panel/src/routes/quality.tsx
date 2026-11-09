import { createColumnHelper } from '@tanstack/react-table';
import { useNavigate } from 'react-router';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AsyncSection } from '../components/AsyncSection.tsx';
import { chartColor } from '../components/charts/chart-colors.ts';
import { DataTable } from '../components/tables/DataTable.tsx';
import { panelTableFeatures } from '../components/tables/features.ts';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.tsx';
import type { RevertsResponse } from '../lib/contract.ts';
import { formatCount, formatPercent, formatTimeCell } from '../lib/format.ts';
import { useReverts } from '../lib/queries.ts';
import { PageShell } from './PageShell.tsx';

/**
 * 质量（S5，数据源 `/api/quality/reverts`，每 15 秒轮询）。
 *
 * 面板唯一的「干得好不好」信号：**自动执行后被人改回的比例**（tech-plan §7.5）。
 * 口径由契约的 zod `refine` 强制：`rate = reverted / applied`；`applied = 0` 时 `rate` 必须是 `null`。
 * 所以页面这里**不能**把 null 画成 0%：`formatPercent(null) === '—'`，`/summarize` 那一行就是这样。
 *
 * 三段呈现（tech-plan §9.3）：改回率大数字 → 按命令分组的堆叠条形（应用 vs 改回）
 * → 逐条改回记录（点行进 `/tasks/:taskId`，`revertKind` 用徽章标出「怎么被改回的」）。
 */
const helper = createColumnHelper<typeof panelTableFeatures, RevertsResponse['records'][number]>();

const columns = helper.columns([
  helper.accessor('taskId', {
    header: '任务',
    cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
  }),
  helper.accessor('repo', {
    header: '仓库',
    cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
  }),
  helper.accessor('command', {
    header: '命令',
    cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
  }),
  helper.accessor('intent', {
    header: '写的是什么',
    cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
  }),
  helper.accessor('revertKind', {
    header: '改回方式',
    cell: (info) => (
      <Badge variant="outline" className="font-mono">
        {info.getValue()}
      </Badge>
    ),
  }),
  helper.accessor('appliedAt', {
    header: '落地',
    cell: (info) => {
      const cell = formatTimeCell(info.getValue());
      return (
        <time title={cell.title} className="text-xs text-muted-foreground">
          {cell.text}
        </time>
      );
    },
  }),
  helper.accessor('revertedAt', {
    header: '被改回',
    cell: (info) => {
      const cell = formatTimeCell(info.getValue());
      return (
        <time title={cell.title} className="text-xs">
          {cell.text}
        </time>
      );
    },
  }),
]);

export function QualityPage() {
  const navigate = useNavigate();
  const { data, error, isLoading, refetch } = useReverts({ limit: 50 });

  // 空态：窗口内一个动作都没落地（此时 rate 必为 null）
  const isEmpty = data !== undefined && data.overall.applied === 0;

  return (
    <PageShell
      title="质量"
      description="改回率 = 被改回的动作 / 已应用的动作（窗口内，每 15 秒刷新）"
      actions={
        error === null ? undefined : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void refetch();
            }}
          >
            重试
          </Button>
        )
      }
    >
      <AsyncSection
        isLoading={isLoading}
        error={error}
        isEmpty={isEmpty}
        emptyText="窗口内没有已应用的动作（没有可评估的样本）"
        testId="quality"
        skeletonHeight="h-40"
      >
        {data === undefined ? null : (
          <QualityContent
            data={data}
            onOpenTask={(taskId) => {
              void navigate(`/tasks/${encodeURIComponent(taskId)}`);
            }}
          />
        )}
      </AsyncSection>
    </PageShell>
  );
}

function QualityContent({ data, onOpenTask }: { data: RevertsResponse; onOpenTask: (taskId: string) => void }) {
  const { overall } = data;

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader>
          <CardTitle>改回率</CardTitle>
          <CardDescription>
            口径：改回数 / 已应用动作数；`applied = 0` 时为 null，显示 `—`（不是 0%）
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-8">
          <div>
            <div className="text-4xl font-semibold tabular-nums" data-testid="quality-rate">
              {formatPercent(overall.rate)}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {`被改回 ${formatCount(overall.reverted)} / 已应用 ${formatCount(overall.applied)}`}
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-1 text-xs">
            <dt className="text-muted-foreground">已应用动作</dt>
            <dd className="tabular-nums">{formatCount(overall.applied)}</dd>
            <dt className="text-muted-foreground">被改回</dt>
            <dd className="tabular-nums">{formatCount(overall.reverted)}</dd>
            <dt className="text-muted-foreground">命令 / 仓库分组</dt>
            <dd className="tabular-nums">
              {formatCount(data.byCommand.length)} / {formatCount(data.byRepo.length)}
            </dd>
          </dl>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <CommandRevertChart buckets={data.byCommand} />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>按仓库</CardTitle>
            <CardDescription>同一口径，按仓库分组</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1.5 text-xs">
            {data.byRepo.length === 0 ? (
              <p className="text-muted-foreground">窗口内没有已应用的动作</p>
            ) : (
              data.byRepo.map((bucket) => (
                <div key={bucket.key} className="flex items-center justify-between gap-2">
                  <span className="font-mono">{bucket.key}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {`${formatCount(bucket.reverted)} / ${formatCount(bucket.applied)} · ${formatPercent(bucket.rate)}`}
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
          <CardDescription>
            按改回时间倒序，点行进任务详情；`revertKind` 是「怎么被改回的」（摘标签 / 请求改动 / 关 PR / 删评论 / 回滚提交）
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {data.hasMore ? (
            <p className="text-[11px] text-muted-foreground">
              {`还有更多记录（当前展示 ${formatCount(data.records.length)} 条，游标分页）`}
            </p>
          ) : null}
          <DataTable
            columns={columns}
            data={data.records}
            getRowId={(row) => row.actionId}
            onRowClick={(row) => {
              onOpenTask(row.taskId);
            }}
            emptyText="窗口内没有被改回的动作"
            testId="quality-records"
          />
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        {`统计窗口 ${formatTimeCell(data.window.from).title} — ${formatTimeCell(data.window.to).title} · 生成于 ${formatTimeCell(data.generatedAt).text}`}
      </p>
    </div>
  );
}

/**
 * 按命令的堆叠条形：应用数（长）与改回数（短）叠在一根上，右边的比率是逐命令口径。
 * `rate` 为 null 的桶（applied = 0）如实显示 `—`。
 */
function CommandRevertChart({ buckets }: { buckets: RevertsResponse['byCommand'] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>按命令的改回分布</CardTitle>
        <CardDescription>横轴是动作数；旁边比率 = 改回 / 应用（`—` 表示窗口内没有已应用的动作）</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {buckets.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">窗口内没有已应用的动作</p>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={Math.max(120, buckets.length * 42)}>
              <BarChart data={buckets} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" allowDecimals={false} stroke="var(--muted-foreground)" fontSize={11} />
                <YAxis type="category" dataKey="key" width={112} stroke="var(--muted-foreground)" fontSize={11} />
                <Tooltip contentStyle={{ fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="applied" name="已应用" stackId="reverts" fill={chartColor(1)} barSize={16} />
                <Bar
                  dataKey="reverted"
                  name="被改回"
                  stackId="reverts"
                  fill={chartColor(0)}
                  radius={[0, 4, 4, 0]}
                  barSize={16}
                />
              </BarChart>
            </ResponsiveContainer>
            <ul className="flex flex-col gap-1 text-xs">
              {buckets.map((bucket) => (
                <li key={bucket.key} className="flex items-center justify-between gap-2">
                  <span className="font-mono">{bucket.key}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {`${formatCount(bucket.reverted)} / ${formatCount(bucket.applied)} · ${formatPercent(bucket.rate)}`}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
