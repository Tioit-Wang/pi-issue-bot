/**
 * `GET /api/overview` —— 吞吐、结果分布、p50/p95、队列深度、熔断状态、doctor 摘要。
 *
 * 口径（写清楚比省几次查询重要，面板的四个大数字全靠它）：
 *
 * - **窗口**：`from`/`to` 缺省最近 24h（`resolveWindow`）；`trend` 不受窗口影响，
 *   固定是「到当前整点为止的 24 个整点」（契约写的就是「最近 24 小时趋势」）。
 * - **today**：UTC 自然日 `[00:00Z, 次日 00:00Z)` 的四个数字。`deliveries` 数的是
 *   `webhook_deliveries`（**含重复投递**，去重率不在这个接口里）；`tasks` 按 `tasks.queued_at`；
 *   `succeeded`/`failed` 数任务状态（`timed-out` 也算 failed，与面板列表同口径）；
 *   `successRate` 的分母是**有结论的任务**（succeeded + failed），分母为 0 时为 `null`。
 * - **p50/p95**：今日**已结束**任务的耗时（`ended_at - 最早 run 的 started_at`），
 *   样本为空时两个都是 `null`。
 * - **queue**：读 pg-boss 自己的 `pgboss.job`（契约注释要求的 `created`/`retry` 与 `active`）；
 *   `oldestQueuedMs` 是「最老的一条排队 job 已经等了多久」，队列空为 `null`。
 *   测试库/未启动 serve 的环境没有 `pgboss` schema 时按 0 处理（`to_regclass` 探测，不抛错）。
 * - **doctor**：**占位**。doctor 的产物还没有落库（`apps/server/src/doctor/` 属于 W3-L），
 *   所以这里返回 `status: 'not-run'`、`checkedAt: null`、`failedChecks: []`；
 *   W3-L 落库后把 `doctorSummary()` 换成一条 select 即可（本文件只有这一处要改）。
 */
import {
  Params,
  intOf,
  isoOf,
  isoOrNull,
  ratioOf,
  resolveWindow,
  roundHourDown,
  sqlFailureClass,
  sqlOutcome,
  utcDayStart,
  DAY_MS,
  HOUR_MS,
  msBetween,
  type SqlRunner,
} from './sql.ts';
import type { OverviewQuery, OverviewResponse } from './types.ts';

/** 趋势点的个数（契约：最近 24 个点，上限 48）。 */
const TREND_POINTS = 24;

type TodayRow = {
  deliveries: number | string;
  tasks: number | string;
  succeeded: number | string;
  failed: number | string;
  cost_usd: string | number;
};

type PercentileRow = { p50_ms: number | string | null; p95_ms: number | string | null };

type QueueRow = { pending: number | string; active: number | string; oldest: Date | null };

type TrendRow = { at: Date; tasks: number | string; succeeded: number | string; failed: number | string };

type CountKeyRow = { key: string; count: number | string };

type FlagRow = { until: Date | null };

export async function queryOverview(runner: SqlRunner, now: Date, query: OverviewQuery): Promise<OverviewResponse> {
  const window = resolveWindow(query, now);
  const dayStart = utcDayStart(now);
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);

  /* 1. 今日四个数字（+ 今日成本） */
  const todayRows = (
    await runner.query(
      `select
         (select count(*) from webhook_deliveries d
           where d.received_at >= $1::timestamptz and d.received_at < $2::timestamptz) as deliveries,
         count(*) as tasks,
         count(*) filter (where t.status = 'succeeded') as succeeded,
         count(*) filter (where t.status in ('failed', 'timed-out')) as failed,
         (select coalesce(sum(uc.cost_usd), 0)
            from usage_costs uc
            join runs r on r.id = uc.run_id
            join tasks t2 on t2.id = r.task_id
           where t2.queued_at >= $1::timestamptz and t2.queued_at < $2::timestamptz) as cost_usd
       from tasks t
       where t.queued_at >= $1::timestamptz and t.queued_at < $2::timestamptz`,
      [dayStart.toISOString(), dayEnd.toISOString()],
    )
  ).rows as TodayRow[];
  const today = todayRows[0];
  const succeeded = intOf(today?.succeeded);
  const failed = intOf(today?.failed);
  const taskCount = intOf(today?.tasks);

  /* 2. 今日耗时分位数（样本为空 → null，不是 0） */
  const percentileRows = (
    await runner.query(
      `select
         round(percentile_cont(0.5) within group (order by d.ms)::numeric)::int as p50_ms,
         round(percentile_cont(0.95) within group (order by d.ms)::numeric)::int as p95_ms
       from (
         select extract(epoch from (t.ended_at - first_run.started_at)) * 1000 as ms
         from tasks t
         join lateral (
           select min(r.started_at) as started_at from runs r where r.task_id = t.id
         ) first_run on true
         where t.ended_at is not null
           and first_run.started_at is not null
           and t.ended_at >= first_run.started_at
           and t.queued_at >= $1::timestamptz
           and t.queued_at < $2::timestamptz
       ) d`,
      [dayStart.toISOString(), dayEnd.toISOString()],
    )
  ).rows as PercentileRow[];
  const percentiles = percentileRows[0];

  /* 3. 队列深度（pg-boss）+ 全局 429 熔断 */
  const queue = await readQueue(runner, now);

  /* 4. 24 小时趋势（整点，升序，空小时补 0） */
  const lastHour = roundHourDown(now);
  const firstHour = new Date(lastHour.getTime() - (TREND_POINTS - 1) * HOUR_MS);
  const trendRows = (
    await runner.query(
      `select
         gs as at,
         count(t.id) as tasks,
         count(t.id) filter (where t.status = 'succeeded') as succeeded,
         count(t.id) filter (where t.status in ('failed', 'timed-out')) as failed
       from generate_series($1::timestamptz, $2::timestamptz, interval '1 hour') as gs
       left join tasks t on t.queued_at >= gs and t.queued_at < gs + interval '1 hour'
       group by gs
       order by gs asc`,
      [firstHour.toISOString(), lastHour.toISOString()],
    )
  ).rows as TrendRow[];

  /* 5. 结果分布（窗口内，按 run 的 started_at；没出现的 outcome 不占位） */
  const outcomeRows = (
    await runner.query(
      `select s.outcome as key, count(*) as count
       from (
         select ${sqlOutcome('r.outcome')} as outcome
         from runs r
         where r.started_at >= $1::timestamptz and r.started_at < $2::timestamptz
       ) s
       where s.outcome is not null
       group by s.outcome
       order by count desc, s.outcome asc`,
      [window.from, window.to],
    )
  ).rows as CountKeyRow[];

  /* 6. 失败分类 Top5（窗口内） */
  const failureRows = (
    await runner.query(
      `select s.failure_class as key, count(*) as count
       from (
          select ${sqlFailureClass('r.failure_class')} as failure_class
         from runs r
         where r.started_at >= $1::timestamptz and r.started_at < $2::timestamptz
       ) s
       where s.failure_class is not null
       group by s.failure_class
       order by count desc, s.failure_class asc
       limit 5`,
      [window.from, window.to],
    )
  ).rows as CountKeyRow[];

  return {
    generatedAt: now.toISOString(),
    window,
    today: {
      deliveries: intOf(today?.deliveries),
      tasks: taskCount,
      succeeded,
      failed,
      successRate: ratioOf(succeeded, succeeded + failed),
      p50Ms: percentiles?.p50_ms === null || percentiles?.p50_ms === undefined ? null : intOf(percentiles.p50_ms),
      p95Ms: percentiles?.p95_ms === null || percentiles?.p95_ms === undefined ? null : intOf(percentiles.p95_ms),
      costUsd: roundUsd(today?.cost_usd),
    },
    queue,
    doctor: doctorSummary(),
    trend: trendRows.map((row) => ({
      at: isoOf(row.at, now.toISOString()),
      tasks: intOf(row.tasks),
      succeeded: intOf(row.succeeded),
      failed: intOf(row.failed),
    })),
    outcomeDistribution: outcomeRows.map((row) => ({
      outcome: row.key as OverviewResponse['outcomeDistribution'][number]['outcome'],
      count: intOf(row.count),
    })),
    failureTop: failureRows.map((row) => ({
      failureClass: row.key as OverviewResponse['failureTop'][number]['failureClass'],
      count: intOf(row.count),
    })),
  };
}

function roundUsd(value: unknown): number {
  const raw = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : 0;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.round(raw * 10_000) / 10_000;
}

/**
 * 队列深度与熔断状态。
 *
 * `pgboss.job` 是 pg-boss 自己建的 schema（§7.2「两套互不干扰」），可能不存在：
 * 用 `to_regclass` 探测一次，缺席时返回零值而不是抛错——面板在「只有业务表」的环境里仍要能开。
 */
async function readQueue(
  runner: SqlRunner,
  now: Date,
): Promise<OverviewResponse['queue']> {
  const pausedParams = new Params();
  const pausedAt = pausedParams.add(now.toISOString(), 'timestamptz');
  const flagRows = (
    await runner.query(
      `select f.until from runtime_flags f
       where f.key = 'rate_limit_pause' and (f.until is null or f.until > ${pausedAt})`,
      pausedParams.list(),
    )
  ).rows as FlagRow[];
  const pausedUntil = flagRows.length === 0 ? null : isoOrNull(flagRows[0]?.until);

  const presence = (
    await runner.query("select to_regclass('pgboss.job') is not null as present")
  ).rows as Array<{ present: boolean }>;
  if (presence[0]?.present !== true) {
    return { depth: 0, active: 0, oldestQueuedMs: null, pausedUntil };
  }

  const queueRows = (
    await runner.query(
      `select
         count(*) filter (where j.state in ('created', 'retry')) as pending,
         count(*) filter (where j.state = 'active') as active,
         min(j.created_on) filter (where j.state in ('created', 'retry')) as oldest
       from pgboss.job j`,
    )
  ).rows as QueueRow[];
  const row = queueRows[0];
  const depth = intOf(row?.pending);
  const oldest = row?.oldest ?? null;

  return {
    depth,
    active: intOf(row?.active),
    oldestQueuedMs: depth === 0 || oldest === null ? null : msBetween(oldest, now),
    pausedUntil,
  };
}

/**
 * doctor 摘要占位（W3-L 落库后改这里）。
 * 契约允许 `not-run`，面板据此显示「尚未体检」而不是「一切正常」。
 */
function doctorSummary(): OverviewResponse['doctor'] {
  return { status: 'not-run', checkedAt: null, failedChecks: [] };
}
