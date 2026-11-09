import { createColumnHelper } from '@tanstack/react-table';
import { useNavigate } from 'react-router';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AsyncSection } from '../components/AsyncSection.tsx';
import { chartColor } from '../components/charts/chart-colors.ts';
import { StatCard } from '../components/charts/StatCard.tsx';
import { DataTable } from '../components/tables/DataTable.tsx';
import { panelTableFeatures } from '../components/tables/features.ts';
import { Button } from '../components/ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.tsx';
import type { CostsResponse } from '../lib/contract.ts';
import { formatCount, formatPercent, formatTimeCell, formatTokens, formatUsd } from '../lib/format.ts';
import { useCosts } from '../lib/queries.ts';
import { PageShell } from './PageShell.tsx';

/**
 * 成本（S4，数据源 `/api/costs`，每 15 秒轮询）。
 *
 * 呈现（tech-plan §9.3）：顶部合计（成本 / token / 定价覆盖率）→ 按仓库与按模型的**堆叠柱**
 * （输入 + 输出 token 同柱堆叠，长度之和就是该维度的 token 消耗）→ 按命令的条形（横排，长度 = 成本）
 * → 最贵 10 个任务的表（点行进 `/tasks/:id`，与任务列表共用同一套列格式）。
 *
 * 两个着色与格式约定：
 * - 颜色只从 `chartColor()` 取（背后是 `--chart-1..5`），页面里不出现色值字面量；
 * - 金额/token/百分比/时间**只**经 `lib/format.ts`；`endedAt` 为 `null`（还在跑）显示 `—`。
 */
const helper = createColumnHelper<typeof panelTableFeatures, CostsResponse['topTasks'][number]>();

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
  helper.accessor('inputTokens', {
    header: 'token 入 / 出',
    cell: (info) => (
      <span className="tabular-nums text-xs">
        {formatTokens(info.getValue())} / {formatTokens(info.row.original.outputTokens)}
      </span>
    ),
  }),
  helper.accessor('costUsd', {
    header: '成本',
    cell: (info) => <span className="tabular-nums text-xs">{formatUsd(info.getValue())}</span>,
  }),
  helper.accessor('endedAt', {
    header: '结束',
    cell: (info) => {
      const cell = formatTimeCell(info.getValue());
      return (
        <time title={cell.title} className="text-xs text-muted-foreground">
          {cell.text}
        </time>
      );
    },
  }),
]);

export function CostsPage() {
  const navigate = useNavigate();
  const { data, error, isLoading, refetch } = useCosts({ top: 10 });

  // 空态：窗口内既没花钱也没有任何一个维度出现（见 `costsEmptyFixture`）
  const isEmpty =
    data !== undefined &&
    data.total.costUsd === 0 &&
    data.byRepo.length === 0 &&
    data.byCommand.length === 0 &&
    data.topTasks.length === 0;

  return (
    <PageShell
      title="成本"
      description="窗口内按仓库 / 模型 / 命令拆分，含最贵 10 个任务（每 15 秒刷新）"
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
        emptyText="窗口内没有用量记录（没跑过任务，或模型没回 usage）"
        testId="costs"
        skeletonHeight="h-40"
      >
        {data === undefined ? null : (
          <CostsContent
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

function CostsContent({ data, onOpenTask }: { data: CostsResponse; onOpenTask: (taskId: string) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="总成本" value={formatUsd(data.total.costUsd)} hint={`币种 ${data.currency}`} />
        <StatCard
          label="输入 token"
          value={formatTokens(data.total.inputTokens)}
          hint={`输出 ${formatTokens(data.total.outputTokens)}`}
        />
        <StatCard
          label="定价覆盖率"
          value={formatPercent(data.total.pricingCoverage)}
          tone={data.total.pricingCoverage < 1 ? 'warning' : 'success'}
          hint="命中价格表的 run 占比；未命中时成本按 0 计，别当免费"
        />
        <StatCard
          label="维度规模"
          value={formatCount(data.byRepo.length)}
          hint={`仓库 / 模型 ${formatCount(data.byModel.length)} · 命令 ${formatCount(data.byCommand.length)}`}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <TokenStackChart
          title="按仓库的 token"
          description="输入 / 输出同柱堆叠，长度 = token 消耗（成本降序）"
          buckets={data.byRepo}
        />
        <TokenStackChart
          title="按模型的 token"
          description="未命中价格表的模型成本记为 0（契约：0 ≠ null）"
          buckets={data.byModel}
        />
      </div>

      <CommandCostChart buckets={data.byCommand} />

      <Card>
        <CardHeader>
          <CardTitle>最贵的 10 个任务</CardTitle>
          <CardDescription>点任意一行进任务详情看回放</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            data={data.topTasks}
            getRowId={(row) => row.taskId}
            onRowClick={(row) => {
              onOpenTask(row.taskId);
            }}
            emptyText="窗口内没有用量"
            testId="costs-top-tasks"
          />
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        {`统计窗口 ${formatTimeCell(data.window.from).title} — ${formatTimeCell(data.window.to).title} · 生成于 ${formatTimeCell(data.generatedAt).text}`}
      </p>
    </div>
  );
}

/** 横轴标签只留 `/` 之后的部分（`acme/widgets` → `widgets`），否则仓库/模型名会把 X 轴挤满。 */
function shortKey(value: string): string {
  const slash = value.indexOf('/');
  return slash === -1 ? value : value.slice(slash + 1);
}

/** 堆叠柱：同一维度的输入 / 输出 token 叠在一根柱子上，便于比较「总量」与「读写比」。 */
function TokenStackChart({
  title,
  description,
  buckets,
}: {
  title: string;
  description: string;
  buckets: CostsResponse['byRepo'];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {buckets.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">这个维度没有数据</p>
        ) : (
          <ResponsiveContainer width="100%" height={230}>
            <BarChart data={buckets} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="key" tickFormatter={shortKey} stroke="var(--muted-foreground)" fontSize={11} />
              <YAxis
                stroke="var(--muted-foreground)"
                fontSize={11}
                tickFormatter={(value: number) => formatTokens(value)}
              />
              <Tooltip
                contentStyle={{ fontSize: 12 }}
                formatter={(value) => formatTokens(typeof value === 'number' ? value : Number(value))}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="inputTokens" name="输入" stackId="tokens" fill={chartColor(0)} barSize={28} />
              <Bar
                dataKey="outputTokens"
                name="输出"
                stackId="tokens"
                fill={chartColor(1)}
                radius={[4, 4, 0, 0]}
                barSize={28}
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

/** 按命令的条形（横排）：刻度直接是金额，一眼能看出哪个命令在烧钱。 */
function CommandCostChart({ buckets }: { buckets: CostsResponse['byCommand'] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>按命令的成本</CardTitle>
        <CardDescription>横轴是金额（USD，4 位小数）；重试会让 run 数大于任务数</CardDescription>
      </CardHeader>
      <CardContent>
        {buckets.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">这个维度没有数据</p>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={buckets} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 8 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" horizontal={false} />
              <XAxis
                type="number"
                stroke="var(--muted-foreground)"
                fontSize={11}
                tickFormatter={(value: number) => formatUsd(value)}
              />
              <YAxis
                type="category"
                dataKey="key"
                width={120}
                stroke="var(--muted-foreground)"
                fontSize={11}
              />
              <Tooltip
                contentStyle={{ fontSize: 12 }}
                formatter={(value) => formatUsd(typeof value === 'number' ? value : Number(value))}
              />
              <Bar dataKey="costUsd" name="成本" fill={chartColor(2)} radius={[0, 4, 4, 0]} barSize={16} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
