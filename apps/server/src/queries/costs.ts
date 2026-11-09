/**
 * `GET /api/costs` —— 按仓库 / 命令 / 模型拆分 + 最贵 N 个任务 + 按日趋势。
 *
 * 口径：
 * - **范围**：`usage_costs` 记账行，按**所属任务的 `queued_at`** 落在窗口内取（与 `/api/tasks`、
 *   `/api/overview` 的 today 同源，面板三个页面的数字才对得上）；`repo` 过滤同样读 `tasks.repo`。
 * - **按命令拆分读 `tasks.command`**（tech-plan §8.3 F9：那一列入队时写死，不解 jsonb）。
 * - **`pricingCoverage`**：契约的定义是「命中价格表的 run 占比」，但价格表还没落库（没有单价列）。
 *   这里用**有 usage 记账的 run / 窗口内的全部 run** 近似，恒 ≤ 1；
 *   接上价格表后把它换成「命中单价表的 usage 行占比」即可，字段语义不变。
 * - **`series`**：`usage_costs` 按 UTC 日聚合（含 token，覆盖 90 天明细期）；
 *   `metrics_daily` 只在「那一天没有明细」时补成本（覆盖明细期之外的永久趋势），token 记 0。
 *   两者 `full outer join` 到日期上，日升序。
 * - **`topTasks`**：按任务汇总成本降序，取 `top`（默认 10，上限 50）。
 */
import {
  Params,
  intOf,
  isoOrNull,
  ratioOf,
  resolveWindow,
  usdOf,
  type SqlRunner,
} from './sql.ts';
import type { CostBucket, CostsQuery, CostsResponse } from './types.ts';

const BUCKET_LIMIT = 100;

type TotalsRow = {
  input_tokens: number | string;
  output_tokens: number | string;
  cost_usd: string | number;
  run_total: number | string;
  run_priced: number | string;
};

type BucketRow = {
  key: string;
  input_tokens: number | string;
  output_tokens: number | string;
  cost_usd: string | number;
  tasks: number | string;
  runs: number | string;
};

type SeriesRow = { day: string; cost_usd: string | number; input_tokens: number | string; output_tokens: number | string };

type TopTaskRow = {
  id: string;
  repo: string;
  command: string;
  cost_usd: string | number;
  input_tokens: number | string;
  output_tokens: number | string;
  ended_at: Date | null;
};

/** 「窗口内的 usage 记账行」：三个聚合与 topTasks 共用，避免各自的 join 写法漂移。 */
function scopedCte(params: Params, query: CostsQuery, window: { from: string; to: string }): string {
  const where = [
    `t.queued_at >= ${params.add(window.from, 'timestamptz')}`,
    `t.queued_at < ${params.add(window.to, 'timestamptz')}`,
  ];
  if (query.repo !== undefined) {
    where.push(`t.repo = ${params.add(query.repo)}`);
  }
  return `with scoped as (
  select
    t.id as task_id,
    t.repo,
    t.command,
    t.ended_at,
    r.id as run_id,
    uc.model,
    uc.input_tokens,
    uc.output_tokens,
    uc.cost_usd
  from usage_costs uc
  join runs r on r.id = uc.run_id
  join tasks t on t.id = r.task_id
  where ${where.join('\n    and ')}
)`;
}

function toBucket(row: BucketRow): CostBucket {
  return {
    key: row.key,
    inputTokens: intOf(row.input_tokens),
    outputTokens: intOf(row.output_tokens),
    costUsd: usdOf(row.cost_usd),
    tasks: intOf(row.tasks),
    runs: intOf(row.runs),
  };
}

export async function queryCosts(runner: SqlRunner, now: Date, query: CostsQuery): Promise<CostsResponse> {
  const window = resolveWindow(query, now);

  /* 1. 合计 + 覆盖率 */
  const totalsParams = new Params();
  const from = totalsParams.add(window.from, 'timestamptz');
  const to = totalsParams.add(window.to, 'timestamptz');
  const repoFilter = query.repo === undefined ? '' : `\n    and t.repo = ${totalsParams.add(query.repo)}`;
  const repoFilterRun = query.repo === undefined ? '' : `\n      and t2.repo = ${totalsParams.add(query.repo)}`;
  const repoFilterPriced = query.repo === undefined ? '' : `\n      and t3.repo = ${totalsParams.add(query.repo)}`;
  const totalsRows = (
    await runner.query(
      `select
         coalesce(sum(uc.input_tokens), 0) as input_tokens,
         coalesce(sum(uc.output_tokens), 0) as output_tokens,
         coalesce(sum(uc.cost_usd), 0) as cost_usd,
         (select count(*)
            from runs r2 join tasks t2 on t2.id = r2.task_id
           where t2.queued_at >= ${from} and t2.queued_at < ${to}${repoFilterRun}) as run_total,
         (select count(distinct uc2.run_id)
            from usage_costs uc2
            join runs r3 on r3.id = uc2.run_id
            join tasks t3 on t3.id = r3.task_id
           where t3.queued_at >= ${from} and t3.queued_at < ${to}${repoFilterPriced}) as run_priced
       from usage_costs uc
       join runs r on r.id = uc.run_id
       join tasks t on t.id = r.task_id
       where t.queued_at >= ${from} and t.queued_at < ${to}${repoFilter}`,
      totalsParams.list(),
    )
  ).rows as TotalsRow[];
  const totals = totalsRows[0];
  const runTotal = intOf(totals?.run_total);
  const runPriced = intOf(totals?.run_priced);

  /* 2. 三个维度拆分（各自独立 CTE：参数编号互不干扰，读起来也不用回头数占位符） */
  const byRepoParams = new Params();
  const byRepoRows = (
    await runner.query(
      `${scopedCte(byRepoParams, query, window)}
select
  repo as key,
  sum(input_tokens) as input_tokens,
  sum(output_tokens) as output_tokens,
  sum(cost_usd) as cost_usd,
  count(distinct task_id) as tasks,
  count(distinct run_id) as runs
from scoped
group by repo
order by sum(cost_usd) desc, repo asc
limit ${BUCKET_LIMIT}`,
      byRepoParams.list(),
    )
  ).rows as BucketRow[];

  const byCommandParams = new Params();
  const byCommandRows = (
    await runner.query(
      `${scopedCte(byCommandParams, query, window)}
select
  command as key,
  sum(input_tokens) as input_tokens,
  sum(output_tokens) as output_tokens,
  sum(cost_usd) as cost_usd,
  count(distinct task_id) as tasks,
  count(distinct run_id) as runs
from scoped
group by command
order by sum(cost_usd) desc, command asc
limit ${BUCKET_LIMIT}`,
      byCommandParams.list(),
    )
  ).rows as BucketRow[];

  const byModelParams = new Params();
  const byModelRows = (
    await runner.query(
      `${scopedCte(byModelParams, query, window)}
select
  model as key,
  sum(input_tokens) as input_tokens,
  sum(output_tokens) as output_tokens,
  sum(cost_usd) as cost_usd,
  count(distinct task_id) as tasks,
  count(distinct run_id) as runs
from scoped
group by model
order by sum(cost_usd) desc, model asc
limit ${BUCKET_LIMIT}`,
      byModelParams.list(),
    )
  ).rows as BucketRow[];

  /* 3. 按日趋势：明细（含 token）+ metrics_daily（只有成本，覆盖明细期之外） */
  const seriesParams = new Params();
  const seriesWhere = [
    `t.queued_at >= ${seriesParams.add(window.from, 'timestamptz')}`,
    `t.queued_at < ${seriesParams.add(window.to, 'timestamptz')}`,
  ];
  const metricWhere = [
    `m.day >= (${seriesParams.add(window.from, 'timestamptz')} at time zone 'UTC')::date`,
    `m.day < (${seriesParams.add(window.to, 'timestamptz')} at time zone 'UTC')::date`,
  ];
  if (query.repo !== undefined) {
    const repoValue = query.repo;
    seriesWhere.push(`t.repo = ${seriesParams.add(repoValue)}`);
    metricWhere.push(`m.repo = ${seriesParams.add(repoValue)}`);
  }
  const seriesRows = (
    await runner.query(
      `with by_detail as (
  select
    (uc.created_at at time zone 'UTC')::date as day,
    sum(uc.cost_usd) as cost_usd,
    sum(uc.input_tokens) as input_tokens,
    sum(uc.output_tokens) as output_tokens
  from usage_costs uc
  join runs r on r.id = uc.run_id
  join tasks t on t.id = r.task_id
  where ${seriesWhere.join('\n    and ')}
  group by 1
), by_metric as (
  select m.day as day, sum(m.cost_usd) as cost_usd
  from metrics_daily m
  where ${metricWhere.join('\n    and ')}
  group by m.day
)
select
  to_char(coalesce(d.day, m.day), 'YYYY-MM-DD') as day,
  coalesce(d.cost_usd, m.cost_usd, 0) as cost_usd,
  coalesce(d.input_tokens, 0) as input_tokens,
  coalesce(d.output_tokens, 0) as output_tokens
from by_detail d
full outer join by_metric m on m.day = d.day
order by 1 asc`,
      seriesParams.list(),
    )
  ).rows as SeriesRow[];

  /* 4. 最贵 N 个任务 */
  const topParams = new Params();
  const topRows = (
    await runner.query(
      `${scopedCte(topParams, query, window)}
select
  task_id as id,
  repo,
  command,
  sum(cost_usd) as cost_usd,
  sum(input_tokens) as input_tokens,
  sum(output_tokens) as output_tokens,
  max(ended_at) as ended_at
from scoped
group by task_id, repo, command
order by sum(cost_usd) desc, task_id asc
limit ${topParams.add(query.top, 'int')}`,
      topParams.list(),
    )
  ).rows as TopTaskRow[];

  return {
    generatedAt: now.toISOString(),
    window,
    currency: 'USD',
    total: {
      inputTokens: intOf(totals?.input_tokens),
      outputTokens: intOf(totals?.output_tokens),
      costUsd: usdOf(totals?.cost_usd),
      pricingCoverage: ratioOf(runPriced, runTotal) ?? 0,
    },
    byRepo: byRepoRows.map(toBucket),
    byCommand: byCommandRows.map(toBucket),
    byModel: byModelRows.map(toBucket),
    series: seriesRows.map((row) => ({
      day: row.day,
      costUsd: usdOf(row.cost_usd),
      inputTokens: intOf(row.input_tokens),
      outputTokens: intOf(row.output_tokens),
    })),
    topTasks: topRows.map((row) => ({
      taskId: row.id,
      repo: row.repo,
      command: row.command,
      costUsd: usdOf(row.cost_usd),
      inputTokens: intOf(row.input_tokens),
      outputTokens: intOf(row.output_tokens),
      endedAt: isoOrNull(row.ended_at),
    })),
  };
}
