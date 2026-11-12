/**
 * `retention-cleanup`：保留期清理（tech-plan §7.6 表格里「90 天」那几行）。
 *
 * | 数据 | 保留 | 本作业怎么做 |
 * |---|---|---|
 * | webhook 原文 | 90 天 | 按 `received_at` 分批删 |
 * | `run_events` 明细 | 90 天 | **先确认那天已聚合进 `metrics_daily`，再**按 `created_at` 分批删 |
 * | `metrics_daily` / `actions` / 审计 | **永久** | **绝不删**，只写日志说明「跳过了哪些表」 |
 *
 * 两条实现要点：
 *  1. **先聚合再删**（§7.6 明文）：`run_events` 是 `sandbox-oom` 判定与耗时兜底的输入，
 *     删掉就再也算不回来了。所以对每个「有超期明细」的日期先检查 `metrics_daily` 有没有该天的行；
 *     该天有 `runs` 却没有指标 → 先跑一次 `metricsRollup({ day })`；补完还是没有 → **当天整批跳过**
 *     并记 warning（宁可不删，也不要先删后算）。
 *  2. **按批删，每批 ≤1000 行**：一条 `delete ... where created_at < x` 在百万行上会持有长事务、
 *     撑爆 vacuum，还可能把在线查询的锁等死。分批删让每批都是短事务，中断了也只是少删一批。
 *
 * `actions` 永久是有原因的（§7.6）：它是「被改回」可追溯的前提，删了等于质量指标归零。
 */
import type { JobLogger, JobPool, JobResult } from './types.ts';
import { countOf, finishJob, JOB_NULL_LOGGER, rowCountOf, systemClock } from './types.ts';
import { metricsRollup } from './metrics-rollup.ts';

/** 明细保留期（天）：webhook 原文与 run_events 共用 90 天。 */
export const RETENTION_DAYS = 90;

/** 每批删除的行数上限（再大就开始拉长事务）。 */
export const RETENTION_BATCH_SIZE = 1000;

/** 单表单轮最多删几批（防御：逻辑写错时不至于把库删空）。 */
const MAX_BATCHES = 1000;

/** 有超期明细的日期（按 UTC 日）。 */
const OVERDUE_DAYS_SQL = `
select distinct (created_at at time zone 'UTC')::date::text as day
  from run_events
 where created_at < $1::timestamptz
 order by 1
`;

const RUNS_ON_DAY_SQL = `
select count(*)::int as runs
  from runs
 where (started_at at time zone 'UTC')::date = $1::date
`;

const METRICS_ON_DAY_SQL = `
select count(*)::int as rows
  from metrics_daily
 where day = $1::date
`;

/** 分批删 `run_events`：`$2` 是被拦下的日期（那天还没聚合，一行都不许删）。 */
const RUN_EVENTS_DELETE_SQL = `
delete from run_events
 where id in (
   select id
     from run_events
    where created_at < $1::timestamptz
      and (created_at at time zone 'UTC')::date <> all($2::date[])
    order by id
    limit $3::int
 )
`;

const RUN_EVENTS_COUNT_SQL = `
select count(*)::int as rows
  from run_events
 where created_at < $1::timestamptz
   and (created_at at time zone 'UTC')::date <> all($2::date[])
`;

const WEBHOOK_DELETE_SQL = `
delete from webhook_deliveries
 where delivery_id in (
   select delivery_id
     from webhook_deliveries
    where received_at < $1::timestamptz
    order by received_at, delivery_id
    limit $2::int
 )
`;

const WEBHOOK_COUNT_SQL = `
select count(*)::int as rows
  from webhook_deliveries
 where received_at < $1::timestamptz
`;

/** 永久表：只读计数，写进日志证明「它们没被动过」。 */
const PERMANENT_COUNT_SQL = `
select
  (select count(*) from metrics_daily)::int as metrics_rows,
  (select count(*) from actions)::int as action_rows
`;

export type RetentionCleanupDeps = {
  readonly pool: JobPool;
  readonly clock?: () => number;
  readonly logger?: JobLogger;
  /**
   * 「该天还没聚合」时调用的补聚合（默认走 `metricsRollup({ day })`）。
   * 抽成注入点是为了让测试能断言「先聚合再删」这件事真的发生了。
   */
  readonly rollup?: (day: string) => Promise<unknown>;
};

export type RetentionCleanupOptions = {
  /** 保留期（天），默认 90。 */
  readonly retentionDays?: number;
  /** 每批行数，默认 1000（上限也是 1000，见 `RETENTION_BATCH_SIZE`）。 */
  readonly batchSize?: number;
  /** 只看不删（报告会删多少行）。dry-run 不补聚合，只报缺指标的日期。 */
  readonly dryRun?: boolean;
};

export type RetentionCleanupStats = {
  readonly retentionDays: number;
  readonly cutoff: string;
  readonly runEventsDeleted: number;
  readonly webhookDeliveriesDeleted: number;
  readonly batches: number;
  /** 因为「还没聚合」而被拦下、整批跳过的日期。 */
  readonly blockedDays: readonly string[];
  /** 本次补跑聚合的日期。 */
  readonly rollupDays: readonly string[];
  /** 永久表当前行数：证明它们一行都没少。 */
  readonly metricsDailyRows: number;
  readonly actionsRows: number;
};

/** 取第一行的窄断言（`SqlResult.rows` 是 `unknown[]`，断言只在这里出现）。 */
function countIn(result: { rows: unknown[] }, key: string): number {
  const first = result.rows[0] as Record<string, unknown> | undefined;
  return countOf(first?.[key]);
}

export async function retentionCleanup(
  deps: RetentionCleanupDeps,
  options: RetentionCleanupOptions = {},
): Promise<JobResult<RetentionCleanupStats>> {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger ?? JOB_NULL_LOGGER;
  const startedAt = clock();

  const retentionDays = options.retentionDays ?? RETENTION_DAYS;
  const batchSize = options.batchSize ?? RETENTION_BATCH_SIZE;
  const dryRun = options.dryRun === true;

  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    throw new Error(`retention：retentionDays 必须是正整数，收到 ${String(retentionDays)}`);
  }
  if (!Number.isInteger(batchSize) || batchSize <= 0 || batchSize > RETENTION_BATCH_SIZE) {
    throw new Error(
      `retention：batchSize 必须在 1–${String(RETENTION_BATCH_SIZE)} 之间，收到 ${String(batchSize)}`,
    );
  }

  const cutoffIso = new Date(startedAt - retentionDays * 86_400_000).toISOString();
  const warnings: string[] = [];
  const rollupDays: string[] = [];
  const blockedDays: string[] = [];

  // 1) 超期明细都在哪些天：这些日期必须先有 metrics_daily 行
  const overdueDays = ((await deps.pool.query(OVERDUE_DAYS_SQL, [cutoffIso])).rows as { day: string }[]).map(
    (row) => row.day,
  );
  const rollup = deps.rollup ?? ((day: string) => metricsRollup(buildRollupOptions(deps), { day }));

  for (const day of overdueDays) {
    const runsOnDay = countIn(await deps.pool.query(RUNS_ON_DAY_SQL, [day]), 'runs');
    if (runsOnDay === 0) {
      // 明细还在、runs 已经不在（例如 replay 造的孤儿事件）：没有可保护的东西
      continue;
    }
    if (countIn(await deps.pool.query(METRICS_ON_DAY_SQL, [day]), 'rows') > 0) {
      continue;
    }
    if (dryRun) {
      warnings.push(`${day} 有 ${String(runsOnDay)} 个 run 但 metrics_daily 还没聚合（dry-run 不补跑）`);
      blockedDays.push(day);
      continue;
    }
    logger.info({ job: 'retention-cleanup', day }, '保留期清理：该天还没聚合，先补跑 metrics-rollup');
    await rollup(day);
    rollupDays.push(day);
    if (countIn(await deps.pool.query(METRICS_ON_DAY_SQL, [day]), 'rows') === 0) {
      blockedDays.push(day);
      warnings.push(`${day} 补跑聚合后 metrics_daily 仍无数据：当天明细整批跳过，不冒险删`);
    }
  }

  // 2) run_events：按批删（被拦下的日期不参与）
  let runEventsDeleted = 0;
  let batches = 0;
  if (dryRun) {
    runEventsDeleted = countIn(await deps.pool.query(RUN_EVENTS_COUNT_SQL, [cutoffIso, blockedDays]), 'rows');
  } else {
    for (;;) {
      const deleted = rowCountOf(await deps.pool.query(RUN_EVENTS_DELETE_SQL, [cutoffIso, blockedDays, batchSize]));
      runEventsDeleted += deleted;
      batches += 1;
      if (deleted === 0 || deleted < batchSize) {
        break;
      }
      if (batches >= MAX_BATCHES) {
        warnings.push(`run_events 删除批数达到上限 ${String(MAX_BATCHES)}，本轮提前收手`);
        break;
      }
    }
  }

  // 3) webhook_deliveries：同样按批删（原文只用于 replay，90 天后没有回放价值）
  let webhookDeliveriesDeleted = 0;
  if (dryRun) {
    webhookDeliveriesDeleted = countIn(await deps.pool.query(WEBHOOK_COUNT_SQL, [cutoffIso]), 'rows');
  } else {
    for (;;) {
      const deleted = rowCountOf(await deps.pool.query(WEBHOOK_DELETE_SQL, [cutoffIso, batchSize]));
      webhookDeliveriesDeleted += deleted;
      batches += 1;
      if (deleted === 0 || deleted < batchSize) {
        break;
      }
      if (batches >= MAX_BATCHES) {
        warnings.push(`webhook_deliveries 删除批数达到上限 ${String(MAX_BATCHES)}，本轮提前收手`);
        break;
      }
    }
  }

  // 4) 永久表自证清白（§7.6：metrics_daily / actions 不删）
  const permanent = await deps.pool.query(PERMANENT_COUNT_SQL);
  const metricsDailyRows = countIn(permanent, 'metrics_rows');
  const actionsRows = countIn(permanent, 'action_rows');

  logger.info(
    {
      job: 'retention-cleanup',
      retentionDays,
      cutoff: cutoffIso,
      dryRun,
      runEventsDeleted,
      webhookDeliveriesDeleted,
      blockedDays,
      skippedTables: ['metrics_daily', 'actions'],
      metricsDailyRows,
      actionsRows,
    },
    '保留期清理完成（metrics_daily / actions 永久保留，已跳过）',
  );

  return finishJob(
    'retention-cleanup',
    startedAt,
    clock,
    {
      retentionDays,
      cutoff: cutoffIso,
      runEventsDeleted,
      webhookDeliveriesDeleted,
      batches,
      blockedDays,
      rollupDays,
      metricsDailyRows,
      actionsRows,
    },
    warnings,
  );
}

/** 补聚合时沿用本作业的池子与时钟（时钟必须一致，否则补出来的日期会和删除窗口错开）。 */
function buildRollupOptions(deps: RetentionCleanupDeps): {
  pool: JobPool;
  clock?: () => number;
  logger: JobLogger;
} {
  return {
    pool: deps.pool,
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
    logger: deps.logger ?? JOB_NULL_LOGGER,
  };
}
