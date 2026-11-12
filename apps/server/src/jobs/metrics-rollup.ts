/**
 * `metrics-rollup`：把某一天（默认昨天）的 `runs` / `usage_costs` / `run_events` 聚合进 `metrics_daily`。
 *
 * tech-plan §7.6 的两条硬要求，本文件逐条实现：
 *  1. **必须幂等**：`UNIQUE (day, repo, outcome)` + `INSERT ... ON CONFLICT DO UPDATE`，
 *     `run_count` / `p50_ms` / `p95_ms` / `cost_usd` **全量覆盖而不是累加**——重跑某一天、
 *     补跑漏掉的日期，结果完全一致。
 *     为了「覆盖」这个语义真正成立，本作业在 upsert 之后还会按 key 清掉**本次没有算出来的旧行**
 *     （某个 (day, repo, outcome) 分组在重算后消失了，只靠 upsert 会让旧行永远留着）。
 *     顺序是**先写后删**，且两条语句都自身原子（不包事务）：中途崩了最多留下多余的旧行
 *     （下一轮重跑会清掉），绝不会出现「先删了再也没算回来」——`metrics_daily` 是永久数据。
 *     删除范围只包含「**当天确实有 run**」的日期：`runs` 明细的保留期有限，
 *     绝不能因为「今天算不出东西」把历史指标抹掉。
 *  2. **必须带质量维度**：`revert_count`（当天 `actions.reverted_at` 落在该天的计数）与
 *     `command_cost_usd`（按 `tasks.command` 拆的成本 jsonb，键保持三列才能 UPSERT）。
 *
 * 口径（写死在 SQL 里，改动等于改面板数字）：
 *  - **日界**：UTC，`runs.started_at` 落在哪一天就算哪一天；
 *  - **耗时**：`ended_at - started_at`，`ended_at` 为空时退化用该 run 最后一条 `run_events.created_at`
 *    （`ended_at` 是收尾写的，崩溃的 run 只能靠事件流兜底——这就是 `run_events` 参与聚合的地方）；
 *  - **成本**：`usage_costs.cost_usd` 按 run 求和，归属该 run 的那一天（不看成本的 `created_at`，
 *    否则跨零点的 run 会把成本算到第二天）；
 *  - **改回数**：按「置位那一天」计数，且只挂到**当天有 run 的 (repo, outcome) 组**上——
 *    键只有三列，没有 run 的分组不存在，硬造一行 `run_count=0` 反而会覆盖掉历史值。
 */
import type { JobLogger, JobPool, JobResult } from './types.ts';
import {
  assertIsoDay,
  eachDay,
  finishJob,
  JOB_NULL_LOGGER,
  rowCountOf,
  systemClock,
  utcDayOf,
} from './types.ts';

/** 默认重算「昨天」（00:10 跑，昨天的数据已经齐了；当天还在跑，聚合出来一定是半成品）。 */
export const ROLLUP_DEFAULT_OFFSET_DAYS = 1;

/** 单次重算的日期上限（补跑上千年没有意义，只会把面板等死）。 */
const MAX_ROLLUP_DAYS = 400;

/**
 * 幂等 upsert 的唯一一条 SQL（`$1` = 本次请求的全部日期，`$2` = 允许整组重写的日期）。
 *
 * `$2` 只包含「当天有 run」的日期：`keys` 用它过滤，于是 revert-only 的分组不会写出
 * `run_count=0` 的新行；`$1` 用于限定扫描范围（走 `runs_outcome_started_at_idx` 的时间窗）。
 * `returning` 把本次写出的 key 交回来，供「清掉消失的分组」那一步使用。
 */
const ROLLUP_UPSERT_SQL = `
with run_scope as (
  select
    r.id as run_id,
    t.repo as repo,
    t.command as command,
    coalesce(nullif(r.outcome, ''), 'unknown') as outcome,
    (r.started_at at time zone 'UTC')::date as day,
    case
      when r.ended_at is not null then
        round(extract(epoch from (r.ended_at - r.started_at)) * 1000)
      else
        -- 崩溃/被杀的 run 没有 ended_at：用事件流的最后一条兜底（run_events 的用途）
        (select round(extract(epoch from (max(e.created_at) - r.started_at)) * 1000)
           from run_events e where e.run_id = r.id)
    end as duration_ms
  from runs r
  join tasks t on t.id = r.task_id
  where (r.started_at at time zone 'UTC')::date = any($1::date[])
),
run_cost as (
  select uc.run_id, sum(uc.cost_usd) as cost_usd
    from usage_costs uc
   where uc.run_id in (select run_id from run_scope)
   group by uc.run_id
),
agg as (
  select
    s.day,
    s.repo,
    s.outcome,
    count(*)::int as run_count,
    round(percentile_cont(0.5) within group (order by s.duration_ms)
            filter (where s.duration_ms is not null))::int as p50_ms,
    round(percentile_cont(0.95) within group (order by s.duration_ms)
            filter (where s.duration_ms is not null))::int as p95_ms,
    coalesce(sum(rc.cost_usd), 0)::numeric(12,6) as cost_usd
  from run_scope s
  left join run_cost rc on rc.run_id = s.run_id
  group by s.day, s.repo, s.outcome
),
cmd_agg as (
  select s.day, s.repo, s.outcome, s.command,
         coalesce(sum(rc.cost_usd), 0) as cost_usd
    from run_scope s
    left join run_cost rc on rc.run_id = s.run_id
   group by s.day, s.repo, s.outcome, s.command
),
cmd_json as (
  select day, repo, outcome,
         jsonb_object_agg(command, round(cost_usd, 6)) as command_cost_usd
    from cmd_agg
   group by day, repo, outcome
),
revert_agg as (
  -- 「被改回」是写操作维度的信号：按 reverted_at 落在哪一天计数，再沿 run → task 归到 (repo, outcome)
  select
    (a.reverted_at at time zone 'UTC')::date as day,
    t.repo as repo,
    coalesce(nullif(r.outcome, ''), 'unknown') as outcome,
    count(*)::int as revert_count
  from actions a
  join runs r on r.id = a.run_id
  join tasks t on t.id = r.task_id
  where a.reverted_at is not null
    and (a.reverted_at at time zone 'UTC')::date = any($1::date[])
  group by 1, 2, 3
),
keys as (
  select day, repo, outcome from agg where day = any($2::date[])
  union
  select day, repo, outcome from revert_agg where day = any($2::date[])
)
insert into metrics_daily
  (day, repo, outcome, run_count, p50_ms, p95_ms, cost_usd, revert_count, command_cost_usd, updated_at)
select
  k.day,
  k.repo,
  k.outcome,
  coalesce(a.run_count, 0),
  a.p50_ms,
  a.p95_ms,
  coalesce(a.cost_usd, 0),
  coalesce(rv.revert_count, 0),
  coalesce(cj.command_cost_usd, '{}'::jsonb),
  now()
from keys k
left join agg a on a.day = k.day and a.repo = k.repo and a.outcome = k.outcome
left join cmd_json cj on cj.day = k.day and cj.repo = k.repo and cj.outcome = k.outcome
left join revert_agg rv on rv.day = k.day and rv.repo = k.repo and rv.outcome = k.outcome
on conflict (day, repo, outcome) do update set
  run_count = excluded.run_count,
  p50_ms = excluded.p50_ms,
  p95_ms = excluded.p95_ms,
  cost_usd = excluded.cost_usd,
  revert_count = excluded.revert_count,
  command_cost_usd = excluded.command_cost_usd,
  updated_at = excluded.updated_at
returning day::text as day, repo, outcome
`;

/**
 * 清掉「本次重算后已经不存在」的分组：`$1` = 重写日期，`$2/$3/$4` = 本次写出的 key。
 * 先写后删，所以这一步失败也只是留下旧行，不会丢数据。
 */
const ROLLUP_PRUNE_SQL = `
delete from metrics_daily m
 where m.day = any($1::date[])
   and not exists (
     select 1
       from unnest($2::date[], $3::text[], $4::text[]) as kept(day, repo, outcome)
      where kept.day = m.day and kept.repo = m.repo and kept.outcome = m.outcome
   )
`;

/** 当天有 run 的日期（决定「允许整组重写」与「要不要删旧行」）。 */
const DAYS_WITH_RUNS_SQL = `
select distinct (r.started_at at time zone 'UTC')::date::text as day
  from runs r
 where (r.started_at at time zone 'UTC')::date = any($1::date[])
 order by 1
`;

/** 回读，用于 stats 与断言（`day` 显式转文本，避免 `pg` 把 `date` 解析成本地零点的 Date）。 */
const ROLLUP_READBACK_SQL = `
select
  day::text as day,
  repo,
  outcome,
  run_count,
  p50_ms,
  p95_ms,
  cost_usd::text as cost_usd,
  revert_count,
  command_cost_usd
from metrics_daily
where day = any($1::date[])
order by day, repo, outcome
`;

export type MetricsRollupDeps = {
  readonly pool: JobPool;
  /** 注入时钟：默认日期与 `updated_at` 都按它算。 */
  readonly clock?: () => number;
  readonly logger?: JobLogger;
};

export type MetricsRollupOptions = {
  /** 单日重算（`YYYY-MM-DD`）。与 `from`/`to` 互斥。 */
  readonly day?: string;
  /** 区间补跑起点（含），需与 `to` 同时给出。 */
  readonly from?: string;
  /** 区间补跑终点（含）。 */
  readonly to?: string;
};

export type MetricsRollupStats = {
  /** 本次重算的日期（升序）。 */
  readonly days: readonly string[];
  /** 其中确实有 run、因此被整组重写的日期。 */
  readonly rewrittenDays: readonly string[];
  /** 重算后 `metrics_daily` 里这些日期的行数。 */
  readonly rows: number;
  readonly runCount: number;
  readonly revertCount: number;
  readonly costUsd: number;
  /** 被「清掉消失分组」这一步删掉的旧行数（正常应为 0）。 */
  readonly prunedRows: number;
};

/** 一行 `metrics_daily` 的回读形状（测试也用这个断言具体数字）。 */
export type MetricsDailySnapshot = {
  readonly day: string;
  readonly repo: string;
  readonly outcome: string;
  readonly run_count: number;
  readonly p50_ms: number | null;
  readonly p95_ms: number | null;
  readonly cost_usd: string;
  readonly revert_count: number;
  readonly command_cost_usd: Record<string, number> | null;
};

/** 把入参归一成「要重算哪几天」：单日 / 区间 / 默认昨天。 */
export function resolveRollupDays(nowMs: number, options: MetricsRollupOptions = {}): string[] {
  const hasRange = options.from !== undefined || options.to !== undefined;
  if (options.day !== undefined && hasRange) {
    throw new Error('metrics-rollup：`day` 与 `from`/`to` 不能同时给');
  }
  if (hasRange) {
    if (options.from === undefined || options.to === undefined) {
      throw new Error('metrics-rollup：`from` 与 `to` 必须成对给出');
    }
    return eachDay(options.from, options.to, MAX_ROLLUP_DAYS);
  }
  if (options.day !== undefined) {
    return [assertIsoDay(options.day)];
  }
  return [utcDayOf(nowMs - ROLLUP_DEFAULT_OFFSET_DAYS * 86_400_000)];
}

export async function metricsRollup(
  deps: MetricsRollupDeps,
  options: MetricsRollupOptions = {},
): Promise<JobResult<MetricsRollupStats>> {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger ?? JOB_NULL_LOGGER;
  const startedAt = clock();
  const days = resolveRollupDays(startedAt, options);

  // 1) 哪些日期确实有 run：只有这些日期允许「整组重写 + 清理消失的分组」
  const dayRows = (await deps.pool.query(DAYS_WITH_RUNS_SQL, [days])).rows as { day: string }[];
  const rewrittenDays = dayRows.map((row) => row.day);

  if (rewrittenDays.length === 0) {
    logger.info({ job: 'metrics-rollup', days }, 'metrics 聚合：这段日期没有 run，跳过（不删任何历史指标）');
    const readback = (await deps.pool.query(ROLLUP_READBACK_SQL, [days])).rows as MetricsDailySnapshot[];
    return finishJob('metrics-rollup', startedAt, clock, buildStats(days, rewrittenDays, readback, 0), []);
  }

  // 2) 全量覆盖写入（ON CONFLICT DO UPDATE，值是重算值而不是累加值）
  const written = (
    await deps.pool.query(ROLLUP_UPSERT_SQL, [days, rewrittenDays])
  ).rows as { day: string; repo: string; outcome: string }[];

  // 3) 清掉本次没算出来的旧分组（先写后删：失败只是留下旧行，下一轮会清）
  //    `written` 为空说明这次一个 key 都没算出来——那就**不删**（空 unnest 会让 not exists 恒真）
  const prunedRows =
    written.length === 0
      ? 0
      : rowCountOf(
          await deps.pool.query(ROLLUP_PRUNE_SQL, [
            rewrittenDays,
            written.map((row) => row.day),
            written.map((row) => row.repo),
            written.map((row) => row.outcome),
          ]),
        );

  // 4) 回读：stats 里的数字就是面板会读到的数字（也是幂等测试的断言来源）
  const readback = (await deps.pool.query(ROLLUP_READBACK_SQL, [days])).rows as MetricsDailySnapshot[];

  logger.info(
    {
      job: 'metrics-rollup',
      days,
      rewrittenDays,
      written: written.length,
      pruned: prunedRows,
      rows: readback.length,
    },
    'metrics 聚合完成',
  );

  return finishJob(
    'metrics-rollup',
    startedAt,
    clock,
    buildStats(days, rewrittenDays, readback, prunedRows),
    [],
  );
}

function buildStats(
  days: readonly string[],
  rewrittenDays: readonly string[],
  readback: readonly MetricsDailySnapshot[],
  prunedRows: number,
): MetricsRollupStats {
  return {
    days,
    rewrittenDays,
    rows: readback.length,
    runCount: sumOf(readback, 'run_count'),
    revertCount: sumOf(readback, 'revert_count'),
    costUsd: costOf(readback),
    prunedRows,
  };
}

function sumOf(rows: readonly MetricsDailySnapshot[], key: 'run_count' | 'revert_count'): number {
  return rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
}

function costOf(rows: readonly MetricsDailySnapshot[]): number {
  // 金额按 6 位小数四舍五入，避免浮点累加出现 0.30000000000000004
  return Math.round(rows.reduce((total, row) => total + Number(row.cost_usd ?? 0), 0) * 1e6) / 1e6;
}
