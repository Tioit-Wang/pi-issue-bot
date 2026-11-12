/**
 * `jobs/` 的公共类型与小工具（tech-plan §6.3 / §7.5 / §7.6 四个定时作业共用）。
 *
 * 四个作业统一成 `(deps, options?) => Promise<JobResult>`，理由是三条：
 *  1. **可测**：时钟、池子、docker、GitHub 全部注入，测试不读 `process.env`、不发真请求；
 *  2. **可观测**：每次跑完返回一份可序列化的 `stats`，直接进日志与面板；
 *  3. **可重放**：手工补跑（`retention` 的「先聚合再删」、运维补一天 metrics）调的是同一个函数，
 *     不存在「线上跑的路径和补跑的不一样」这种只在事故里才发现的偏差。
 *
 * 依赖方向（tech-plan §8.2）：本目录只依赖 `db/`、`sandbox/`、`github/`、`queue/`（队列名常量），
 * 不依赖 `worker/` 与 `http/`；日志面用结构性类型 `JobLogger`，与 `@pi-issue-bot/shared` 的
 * `Logger` 天然兼容（那边多出的 `debug/child/level` 不影响赋值），于是本目录不需要
 * `apps/server/package.json` 里尚未声明的 workspace 依赖。
 */
import type { SqlExecutor, TransactionalPool } from '../db/index.ts';

/** 五个定时作业的名字（与 `queue/SCHEDULES` 一一对应，见 `index.ts` 的映射表）。 */
export type JobName =
  | 'metrics-rollup'
  | 'reconcile-reverts'
  | 'retention-cleanup'
  | 'lifecycle-sweep'
  /** 排队闸门（每分钟）：`status=queued` 且超过该仓库的 `queue_wait_minutes` → `cancelled_queue` */
  | 'queue-gate'
  /** issue agent 的串行调度（每分钟兜底）：每个 issue 投最老的一条 `agent_messages` */
  | 'agent-dispatch';

/**
 * 作业的日志面：只用到三个方法。
 * 与 shared 的 `LogMethod`（`(fields | string, message?) => void`）同形，故真 logger 可直接传入。
 */
export type JobLogger = {
  info: (fields: Record<string, unknown> | string, message?: string) => void;
  warn: (fields: Record<string, unknown> | string, message?: string) => void;
  error: (fields: Record<string, unknown> | string, message?: string) => void;
  /** 可选：`sandbox/` 的 `SandboxLogger` 需要它，本目录只在适配时透传。 */
  debug?: (fields: Record<string, unknown> | string, message?: string) => void;
};

/** 静默 logger：单测与 `--quiet` 用。 */
export const JOB_NULL_LOGGER: JobLogger = Object.freeze({
  info: () => {},
  warn: () => {},
  error: () => {},
});

/** 作业需要的池子：能查（`SqlExecutor`）+ 能开事务（`TransactionalPool`）。 */
export type JobPool = SqlExecutor & TransactionalPool;

/** 注入时钟（ms epoch）。定时作业里所有「现在」都从这里取，测试才能断言具体数字。 */
export type JobClock = () => number;

/** 默认时钟。 */
export const systemClock: JobClock = () => Date.now();

/**
 * `stats` 的取值域：只放可 JSON 序列化的标量与字符串数组/数值字典。
 * 不放行数组（`row` 之类），因为作业结果会原样进日志。
 */
export type JobStatValue = number | string | boolean | readonly string[] | Readonly<Record<string, number>>;

export type JobStats = Readonly<Record<string, JobStatValue>>;

/** 一次作业的产出。`ok=false` 表示「跑完了但有一部分没做成」（例如保留期清理有被拦下的日期）。 */
export type JobResult<TStats extends JobStats = JobStats> = {
  readonly job: JobName;
  readonly ok: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly stats: TStats;
  /** 需要人看一眼的告警（不抛错但也不正常）。 */
  readonly warnings: readonly string[];
};

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` 形态（`metrics_daily.day` 的 `date` 列口径：UTC 日界）。 */
const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 校验并归一化一个 UTC 日（非法即抛：日期是作业的入参，静默纠正只会让人算错数）。 */
export function assertIsoDay(day: string, field = 'day'): string {
  if (!ISO_DAY_PATTERN.test(day)) {
    throw new Error(`${field} 必须是 YYYY-MM-DD，收到：${JSON.stringify(day)}`);
  }
  const epoch = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(epoch)) {
    throw new Error(`${field} 不是合法日期：${JSON.stringify(day)}`);
  }
  // 2026-02-30 这类「格式对但日子不存在」的输入会被 Date 顺延到 03-02，用回读比对挡掉
  if (new Date(epoch).toISOString().slice(0, 10) !== day) {
    throw new Error(`${field} 不是合法日期：${JSON.stringify(day)}`);
  }
  return day;
}

/** ms epoch → UTC 日字符串。 */
export function utcDayOf(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** 日期加减（按 UTC 日，不受本地时区/夏令时影响）。 */
export function shiftDay(day: string, deltaDays: number): string {
  const epoch = Date.parse(`${assertIsoDay(day)}T00:00:00.000Z`);
  return utcDayOf(epoch + deltaDays * DAY_MS);
}

/** 闭区间 `[from, to]` 的全部 UTC 日；`limit` 防止一次补跑上千年。 */
export function eachDay(from: string, to: string, limit = 400): string[] {
  const start = assertIsoDay(from, 'from');
  const end = assertIsoDay(to, 'to');
  if (start > end) {
    throw new Error(`日期区间颠倒：from=${start} to=${end}`);
  }
  const days: string[] = [];
  for (let cursor = start; cursor <= end; cursor = shiftDay(cursor, 1)) {
    days.push(cursor);
    if (days.length > limit) {
      throw new Error(`日期区间超过上限 ${limit} 天：from=${start} to=${end}`);
    }
  }
  return days;
}

/** 收尾：把「开始时刻 + 统计 + 告警」拼成统一结果（`durationMs` 用同一个时钟算）。 */
export function finishJob<TStats extends JobStats>(
  job: JobName,
  startedAtMs: number,
  clock: JobClock,
  stats: TStats,
  warnings: readonly string[] = [],
): JobResult<TStats> {
  const finishedAtMs = clock();
  return {
    job,
    ok: warnings.length === 0,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: Math.max(0, finishedAtMs - startedAtMs),
    stats,
    warnings,
  };
}

/** 把 `unknown` 里的 `rowCount` 读成数字（`pg` 的 `rowCount` 可空）。 */
export function rowCountOf(result: { rowCount?: number | null; rows: unknown[] }): number {
  return result.rowCount ?? result.rows.length;
}

/** `bigint` 主键在 `pg` 里回来是字符串，统一转成数字给 stats 用。 */
export function countOf(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** 金额列（`numeric(12,6)`）回来是字符串，统一转成数字用于比较与展示。 */
export function amountOf(value: unknown): number {
  return countOf(value);
}
