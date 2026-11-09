import { AsyncSection } from '../components/AsyncSection.tsx';
import { DistributionBar } from '../components/charts/DistributionBar.tsx';
import { FailureBar } from '../components/charts/FailureBar.tsx';
import { StatCard } from '../components/charts/StatCard.tsx';
import { TrendChart } from '../components/charts/TrendChart.tsx';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import type { OverviewResponse } from '../lib/contract.ts';
import { formatCount, formatDuration, formatPercent, formatTimeCell, formatUsd } from '../lib/format.ts';
import { useOverview } from '../lib/queries.ts';
import { PageShell } from './PageShell.tsx';

/**
 * 总览（S1，数据源 `/api/overview`，每 10 秒轮询）。
 *
 * 呈现分工（tech-plan §9.3）：
 * - 顶部 4 张 StatCard：今日事件数（webhook 投递）/ 成功率 / p95 耗时 / 队列深度；
 * - 折线画 24 个小时点的 `tasks / succeeded / failed`（数据点由契约补齐，本页不补点不排序）；
 * - 结果分布与失败 Top5 复用 `components/charts/*`（配色只来自 `--chart-*`，不硬编码）；
 * - 熔断（`queue.pausedUntil`）与 doctor 未全绿这两个**降级信号**放在统计卡下面，
 *   用 `Alert` 而不是彩色文字（tech-plan §9.4：提示统一走 Alert）。
 *
 * 数字与时间**只**经 `lib/format.ts`：`null` 一律显示 `—`（例如 `tasks = 0` 时的成功率），
 * 绝不用 0 冒充（契约 §0 的 `null ≠ 0`）。四态由 `AsyncSection` 统一（`overview-*` 四个锚点），
 * 错误态的「重试」放在页头右侧（`AsyncSection` 是只读组件，错误分支不接受 children）。
 */
export function OverviewPage() {
  const { data, error, isLoading, refetch } = useOverview();

  // 空态：窗口内既没有投递也没有任务（服务刚启动），此时率与分位数都是 null
  const isEmpty =
    data !== undefined &&
    data.today.deliveries === 0 &&
    data.today.tasks === 0 &&
    data.trend.every((point) => point.tasks === 0);

  return (
    <PageShell
      title="总览"
      description="今日吞吐、最近 24 小时趋势、队列与熔断状态（每 10 秒刷新）"
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
        emptyText="还没有任何数据（服务刚启动？）"
        testId="overview"
        skeletonHeight="h-40"
      >
        {data === undefined ? null : <OverviewContent data={data} />}
      </AsyncSection>
    </PageShell>
  );
}

function OverviewContent({ data }: { data: OverviewResponse }) {
  const successRate = data.today.successRate;
  const paused = data.queue.pausedUntil;
  const doctorNeedsAttention = data.doctor.status === 'warn' || data.doctor.status === 'fail';

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="今日事件"
          value={formatCount(data.today.deliveries)}
          hint={`任务 ${formatCount(data.today.tasks)} · 成功 ${formatCount(data.today.succeeded)} · 失败 ${formatCount(data.today.failed)}`}
        />
        <StatCard
          label="成功率"
          value={formatPercent(successRate)}
          tone={
            successRate === null ? 'neutral' : successRate >= 0.9 ? 'success' : successRate >= 0.7 ? 'warning' : 'danger'
          }
          hint={`今日成本 ${formatUsd(data.today.costUsd)}`}
        />
        <StatCard
          label="p95 耗时"
          value={formatDuration(data.today.p95Ms)}
          hint={`p50 ${formatDuration(data.today.p50Ms)}`}
        />
        <StatCard
          label="队列深度"
          value={formatCount(data.queue.depth)}
          tone={data.queue.depth > 5 ? 'warning' : 'neutral'}
          hint={`执行中 ${formatCount(data.queue.active)} · 最老等待 ${formatDuration(data.queue.oldestQueuedMs)}`}
        />
      </div>

      {paused === null ? null : (
        <Alert variant="warning" data-testid="overview-paused">
          <AlertTitle>全局 429 熔断中</AlertTitle>
          <AlertDescription>
            {`解除时间 ${formatTimeCell(paused).text}（${formatTimeCell(paused).title}）· 熔断期间新事件只入队不占并发`}
          </AlertDescription>
        </Alert>
      )}

      <Alert variant={doctorNeedsAttention ? 'warning' : 'default'} data-testid="overview-doctor">
        <AlertTitle>{doctorNeedsAttention ? 'doctor 未全绿' : 'doctor 状态'}</AlertTitle>
        <AlertDescription>
          {`${DOCTOR_LABEL[data.doctor.status] ?? data.doctor.status} · 最近体检 ${formatTimeCell(data.doctor.checkedAt).text}`}
          {data.doctor.failedChecks.length === 0
            ? ' · 没有未通过的检查项'
            : ` · 未通过项：${data.doctor.failedChecks.join('、')}`}
        </AlertDescription>
      </Alert>

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
        {`统计窗口 ${formatTimeCell(data.window.from).title} — ${formatTimeCell(data.window.to).title} · 生成于 ${formatTimeCell(data.generatedAt).text}`}
      </p>
    </div>
  );
}

/** doctor 状态的展示文案（`/api/overview` 与 `/api/system` 共用同一套枚举，各自翻译成中文）。 */
const DOCTOR_LABEL: Record<string, string> = {
  ok: '通过',
  warn: '有告警',
  fail: '未通过',
  unknown: '状态未知',
  'not-run': '还没跑过',
};
