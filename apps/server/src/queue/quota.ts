/**
 * 项目**日配额**（需求 §6.7 SL-3：「每天最多处理多少个事件」）。
 *
 * 触顶行为是需求原文定的：**拒绝处理并记录原因，可查** ——
 * 所以这里只提供两件事：
 *  1. `reserveDailyQuota()`：原子的「占一格」，占不到就返回 `granted:false`
 *     （拒绝由调用方决定：判定返回 `daily-quota`，投递行落 `decision_reason='daily-quota'`）；
 *  2. `readDailyQuotaUsed()`：只读计数（面板 / 日志 / 排查）。
 *
 * 为什么用「占一格」而不是「先查后加」：`webhook_deliveries` 是并发到达的，查与加之间的窗口
 * 会让同一分钟里的 N 条投递全部看到「还剩最后一格」并一起放行。`INSERT ... ON CONFLICT DO UPDATE
 * ... WHERE count < limit` 把判断与自增压进一条语句，由行锁保证只有一条能拿到最后一格。
 *
 * 为什么占位发生在「判定已经决定要处理」之后：配额数的是**处理过的事件**，不是收到的事件。
 * 被开关关掉 / 闸门拒绝 / 内容重复的事件不该吃掉配额（那会让「扰动一次配置」把一天的额度耗光）。
 *
 * 窗口：UTC 自然日（`window_start` = 当日 00:00:00Z）。与 `metrics_daily`、cron 的时区口径一致
 * （§7.6 全部按 UTC），不引入本地时区的第二套「一天」。
 *
 * 平台不设业务限流（需求 SL-5）：这是**项目级**旋钮（`agent.limits.daily_quota`，1–1000，默认 100），
 * 每个仓库各记各的账，互不影响。
 */
import type { SqlRunner } from '../config/repo-config.ts';

/** 计数器种类：按天、按事件。`quota_counters` 的唯一键是 `(repo, kind, window_start)`。 */
export const DAILY_QUOTA_KIND = 'events:day';

/** 契约 `agentExecutionSchema.daily_quota` 的默认值（1–1000，默认 100）。 */
export const DAILY_QUOTA_DEFAULT = 100;

/** 契约允许的区间（`agentExecutionSchema.daily_quota` 的 min/max）。 */
export const MIN_DAILY_QUOTA = 1;
export const MAX_DAILY_QUOTA = 1000;

/** 某时刻所属的 UTC 自然日窗口起点（当日 00:00:00Z）。 */
export function dailyQuotaWindowStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** 已用数是否触顶（`>=`：正好用满最后一个额度就算触顶）。 */
export function isDailyQuotaExhausted(used: number, limit: number): boolean {
  return used >= limit;
}

/** 把任意输入夹到契约允许区间（读坏了配置也不能让配额变成 0 或无穷）。 */
export function clampDailyQuota(limit: number): number {
  if (!Number.isFinite(limit)) {
    return DAILY_QUOTA_DEFAULT;
  }
  return Math.min(MAX_DAILY_QUOTA, Math.max(MIN_DAILY_QUOTA, Math.trunc(limit)));
}

export const QUOTA_SQL = {
  /** 读计数（没有行 = 0）。参数：`$1 = repo`、`$2 = kind`、`$3 = window_start`。 */
  read: `SELECT "count" FROM "quota_counters"
WHERE "repo" = $1 AND "kind" = $2 AND "window_start" = $3`,
  /**
   * 原子占一格。参数：`$1 = repo`、`$2 = kind`、`$3 = window_start`、`$4 = 上限`。
   *
   * `DO UPDATE ... WHERE "count" < $4` 是整条语句的关键：条件不成立时**什么都不写、
   * 也不返回行**，于是「拿到行 = 抢到最后一格」这件事由 PostgreSQL 的行锁保证。
   */
  reserve: `INSERT INTO "quota_counters" ("repo", "kind", "window_start", "count")
VALUES ($1, $2, $3, 1)
ON CONFLICT ("repo", "kind", "window_start") DO UPDATE
  SET "count" = "quota_counters"."count" + 1
  WHERE "quota_counters"."count" < $4
RETURNING "count"`,
} as const;

/** 一次配额判定的结果（调用方据此决定「拒绝」还是「放行」）。 */
export type QuotaReservation = {
  /** `true` = 已占到一格，可以处理；`false` = 当日额度已满，必须拒绝 */
  readonly granted: boolean;
  /** 已用数（拒绝时是当日的真实计数） */
  readonly used: number;
  /** 生效上限（已夹到 1–1000） */
  readonly limit: number;
  readonly kind: string;
  /** 窗口起点（UTC 当日 00:00:00） */
  readonly windowStart: Date;
};

export type QuotaInput = {
  readonly repo: string;
  /** 项目级上限（`resolveAgentExecution(settings).daily_quota`） */
  readonly limit: number;
  readonly now: Date;
  readonly kind?: string;
};

/** 读一行里的 `count`；行缺失 / 值不是数字一律按 0。 */
function countOf(rows: readonly unknown[]): number {
  const row = rows[0];
  if (typeof row !== 'object' || row === null) {
    return 0;
  }
  const value = (row as Record<string, unknown>)['count'];
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : Number(value) || 0;
}

/** 当日已用数（没有计数器行 = 0）。 */
export async function readDailyQuotaUsed(
  db: SqlRunner,
  input: { readonly repo: string; readonly now: Date; readonly kind?: string },
): Promise<number> {
  const kind = input.kind ?? DAILY_QUOTA_KIND;
  const result = await db.query(QUOTA_SQL.read, [input.repo, kind, dailyQuotaWindowStart(input.now)]);
  return countOf(result.rows);
}

/**
 * 占一格当日配额。
 *
 * 拒绝时**再读一次**计数而不是拿猜的数：面板要能显示「已用多少 / 上限多少」，
 * 用一个假的 `limit` 当已用数会让排查看到错误的现场。这次读只发生在拒绝路径（每天最多一条）。
 */
export async function reserveDailyQuota(db: SqlRunner, input: QuotaInput): Promise<QuotaReservation> {
  const kind = input.kind ?? DAILY_QUOTA_KIND;
  const limit = clampDailyQuota(input.limit);
  const windowStart = dailyQuotaWindowStart(input.now);
  const result = await db.query(QUOTA_SQL.reserve, [input.repo, kind, windowStart, limit]);
  // 判定口径只有一条：`RETURNING` 有没有吐出**行**。有行 = 抢到格子（前提是 `count < limit`）；
  // 没行 = 已经触顶。不看 `rowCount` 是因为它依驱动而异，而 `rows` 是 `RETURNING` 的直接结果。
  if (result.rows.length > 0) {
    return { granted: true, used: countOf(result.rows), limit, kind, windowStart };
  }
  const current = await readDailyQuotaUsed(db, { ...input, kind });
  return { granted: false, used: current, limit, kind, windowStart };
}
