/**
 * `jobs/metrics-rollup` 的**真库**测试（dev-plan §13.1：本机有 PG 18，数据相关验收必须真跑）。
 *
 * 这个作业的 DoD 只有一句话：**同一天跑两次，`metrics_daily` 的每一列数值完全相同**。
 * 所以断言全部是具体数字（`run_count` / `p50_ms` / `p95_ms` / `cost_usd` / `revert_count` /
 * `command_cost_usd`），不是「不为空」。种子数据刻意手算得出：
 *
 * - `acme/widgets` + `succeeded`：3 个 run，耗时 10000 / 20000 / 30000 ms
 *   → `p50=20000`、`p95=29000`（`percentile_cont(0.95)` 在 3 个样本上是插值 1.9 → 29000）；
 * - 成本：0.05 + 0.10 + 0.05 = **0.200000**，全部来自 `/review-pr` → `command_cost_usd = {"/review-pr": 0.2}`；
 * - 改回：当天置位 2 条 action → `revert_count = 2`；
 * - `other/lib` 那条 run **没有 `ended_at`**，靠 `run_events` 最后一条兜底 → 耗时 7000 ms。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { metricsRollup } from '../src/jobs/index.ts';
import type { MetricsDailySnapshot } from '../src/jobs/index.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

/** 固定时钟：默认日期 = 2026-05-31（昨天），让「不给 day」的分支也能断言。 */
const NOW = Date.parse('2026-06-01T00:10:00.000Z');
const DAY = '2026-05-31';
const PREV_DAY = '2026-05-30';

let db: TestDb;
const clock = (): number => NOW;

async function readMetrics(days: readonly string[]): Promise<MetricsDailySnapshot[]> {
  const result = await db.pool.query(
    `select day::text as day, repo, outcome, run_count, p50_ms, p95_ms,
            cost_usd::text as cost_usd, revert_count, command_cost_usd
       from metrics_daily
      where day = any($1::date[])
      order by day, repo, outcome`,
    [days],
  );
  return result.rows as MetricsDailySnapshot[];
}

async function seed(): Promise<void> {
  await db.pool.query(`
    insert into tasks (id, source, repo, target_kind, target_number, command, actor_login, idempotency_key, status)
    values
      ('t-a', 'command', 'acme/widgets', 'pr',  12, '/review-pr',  'alice', 'rollup-k1', 'succeeded'),
      ('t-b', 'webhook', 'acme/widgets', 'issue', 7, 'auto:triage', 'bob',   'rollup-k2', 'failed'),
      ('t-c', 'command', 'other/lib',    'pr',   3, '/review-pr',  'carol', 'rollup-k3', 'succeeded')
  `);

  await db.pool.query(`
    insert into runs (id, task_id, attempt, started_at, ended_at, outcome, failure_class)
    values
      -- 当天 acme/widgets + succeeded：3 个样本，耗时 10s / 30s / 20s
      ('r1', 't-a', 1, '2026-05-31T01:00:00Z', '2026-05-31T01:00:10Z', 'succeeded', null),
      ('r2', 't-a', 1, '2026-05-31T02:00:00Z', '2026-05-31T02:00:30Z', 'succeeded', null),
      ('r3', 't-a', 1, '2026-05-31T03:00:00Z', '2026-05-31T03:00:20Z', 'succeeded', null),
      -- 当天 acme/widgets + failed：1 个样本，5s
      ('r4', 't-b', 1, '2026-05-31T04:00:00Z', '2026-05-31T04:00:05Z', 'failed', 'timeout'),
      -- 当天 other/lib + succeeded：**ended_at 为空**，靠 run_events 兜底算 7s
      ('r5', 't-c', 1, '2026-05-31T05:00:00Z', null, 'succeeded', null),
      -- 前一天：用于「删掉某天再重算」的补跑断言
      ('r6', 't-a', 1, '2026-05-30T01:00:00Z', '2026-05-30T01:00:01Z', 'succeeded', null)
  `);

  await db.pool.query(`
    insert into run_events (run_id, cursor, kind, payload, created_at)
    values ('r5', 1, 'turn/started', '{}'::jsonb, '2026-05-31T05:00:01Z'),
           ('r5', 2, 'turn/ended',   '{}'::jsonb, '2026-05-31T05:00:07Z')
  `);

  await db.pool.query(`
    insert into usage_costs (run_id, model, input_tokens, output_tokens, cost_usd, created_at)
    values ('r1', 'anthropic/claude-x', 100, 50, 0.050000, '2026-05-31T01:00:10Z'),
           ('r2', 'anthropic/claude-x', 100, 50, 0.100000, '2026-05-31T02:00:30Z'),
           ('r3', 'anthropic/claude-x', 100, 50, 0.050000, '2026-05-31T03:00:20Z'),
           ('r4', 'anthropic/claude-x',  10, 10, 0.020000, '2026-05-31T04:00:05Z'),
           ('r5', 'anthropic/claude-x',  10, 10, 0.040000, '2026-05-31T05:00:07Z'),
           ('r6', 'anthropic/claude-x',  10, 10, 0.010000, '2026-05-30T01:00:01Z')
  `);

  await db.pool.query(`
    insert into actions (run_id, intent, target, external_ref, applied_at, reverted_at, revert_kind)
    values ('r1', 'label',   'acme/widgets#12', null, '2026-05-31T01:01:00Z', '2026-05-31T06:00:00Z', 'label-removed'),
           ('r1', 'comment', 'acme/widgets#12', '9001', '2026-05-31T01:02:00Z', null, null),
           ('r3', 'label',   'acme/widgets#12', null, '2026-05-31T03:01:00Z', '2026-05-31T08:00:00Z', 'changes-requested')
  `);
}

beforeAll(async () => {
  db = await openTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.truncate();
  await seed();
});

describe('jobs/metrics-rollup（PG 实现）', () => {
  it('单日聚合写出的每一列都是具体数字', async () => {
    const result = await metricsRollup({ pool: db.pool, clock }, { day: DAY });

    expect(result.ok).toBe(true);
    expect(result.stats.days).toEqual([DAY]);
    expect(result.stats.rewrittenDays).toEqual([DAY]);
    expect(result.stats.runCount).toBe(5);
    expect(result.stats.revertCount).toBe(2);
    expect(result.stats.costUsd).toBe(0.26);

    const rows = await readMetrics([DAY]);
    expect(rows).toHaveLength(3);

    const succeeded = rows.find((row) => row.repo === 'acme/widgets' && row.outcome === 'succeeded');
    expect(succeeded).toBeDefined();
    expect(succeeded?.run_count).toBe(3);
    expect(succeeded?.p50_ms).toBe(20000);
    expect(succeeded?.p95_ms).toBe(29000);
    expect(succeeded?.cost_usd).toBe('0.200000');
    expect(succeeded?.revert_count).toBe(2);
    expect(succeeded?.command_cost_usd).toEqual({ '/review-pr': 0.2 });

    const failed = rows.find((row) => row.repo === 'acme/widgets' && row.outcome === 'failed');
    expect(failed?.run_count).toBe(1);
    expect(failed?.p50_ms).toBe(5000);
    expect(failed?.p95_ms).toBe(5000);
    expect(failed?.cost_usd).toBe('0.020000');
    expect(failed?.revert_count).toBe(0);
    expect(failed?.command_cost_usd).toEqual({ 'auto:triage': 0.02 });

    // ended_at 为空 → 用 run_events 最后一条兜底（7000 ms 而不是 null）
    const otherLib = rows.find((row) => row.repo === 'other/lib');
    expect(otherLib?.run_count).toBe(1);
    expect(otherLib?.p50_ms).toBe(7000);
    expect(otherLib?.p95_ms).toBe(7000);
    expect(otherLib?.cost_usd).toBe('0.040000');
  });

  it('幂等：同一天连跑两次，每一列完全相同（不累加、不漂移）', async () => {
    const first = await metricsRollup({ pool: db.pool, clock }, { day: DAY });
    const snapshotA = await readMetrics([DAY]);

    const second = await metricsRollup({ pool: db.pool, clock }, { day: DAY });
    const snapshotB = await readMetrics([DAY]);

    expect(second.stats.runCount).toBe(first.stats.runCount);
    expect(second.stats.rows).toBe(first.stats.rows);
    expect(snapshotB).toEqual(snapshotA);
    // 再确认一次「不是靠空表碰巧相等」：数字本身就得是对的
    expect(snapshotB.map((row) => [row.run_count, row.p50_ms, row.p95_ms, row.cost_usd, row.revert_count])).toEqual([
      [1, 5000, 5000, '0.020000', 0],
      [3, 20000, 29000, '0.200000', 2],
      [1, 7000, 7000, '0.040000', 0],
    ]);
  });

  it('补跑：删掉某天再重算，数字与原来一致', async () => {
    await metricsRollup({ pool: db.pool, clock }, { day: PREV_DAY });
    const before = await readMetrics([PREV_DAY]);
    expect(before).toHaveLength(1);
    expect(before[0]?.run_count).toBe(1);
    expect(before[0]?.p50_ms).toBe(1000);
    expect(before[0]?.cost_usd).toBe('0.010000');

    await db.pool.query('delete from metrics_daily where day = $1::date', [PREV_DAY]);
    expect(await readMetrics([PREV_DAY])).toHaveLength(0);

    const result = await metricsRollup({ pool: db.pool, clock }, { day: PREV_DAY });
    expect(result.stats.rewrittenDays).toEqual([PREV_DAY]);
    expect(await readMetrics([PREV_DAY])).toEqual(before);
  });

  it('区间补跑：两天都重算，且互不影响', async () => {
    const result = await metricsRollup({ pool: db.pool, clock }, { from: PREV_DAY, to: DAY });
    expect(result.stats.days).toEqual([PREV_DAY, DAY]);
    expect(result.stats.rewrittenDays).toEqual([PREV_DAY, DAY]);
    expect(result.stats.rows).toBe(4);

    const rows = await readMetrics([PREV_DAY, DAY]);
    expect(rows.map((row) => [row.day, row.repo, row.run_count])).toEqual([
      ['2026-05-30', 'acme/widgets', 1],
      ['2026-05-31', 'acme/widgets', 1],
      ['2026-05-31', 'acme/widgets', 3],
      ['2026-05-31', 'other/lib', 1],
    ]);
  });

  it('不给日期就聚合「昨天」（UTC）', async () => {
    const result = await metricsRollup({ pool: db.pool, clock });
    expect(result.stats.days).toEqual([DAY]);
    expect(result.stats.runCount).toBe(5);
  });

  it('没有 run 的日期：一行都不写，也不删历史指标', async () => {
    await metricsRollup({ pool: db.pool, clock }, { day: DAY });
    const before = await readMetrics([DAY]);

    const result = await metricsRollup({ pool: db.pool, clock }, { day: '2026-05-20' });
    expect(result.stats.rewrittenDays).toEqual([]);
    expect(result.stats.rows).toBe(0);
    // 永久指标没有被「空日期」抹掉
    expect(await readMetrics([DAY])).toEqual(before);
  });

  it('入参自检：day 与 from/to 不能同时给，非法日期直接抛', async () => {
    await expect(metricsRollup({ pool: db.pool, clock }, { day: DAY, from: DAY, to: DAY })).rejects.toThrow(
      /不能同时给/,
    );
    await expect(metricsRollup({ pool: db.pool, clock }, { day: '2026-05-32' })).rejects.toThrow(/不是合法日期/);
    await expect(metricsRollup({ pool: db.pool, clock }, { from: DAY, to: PREV_DAY })).rejects.toThrow(/颠倒/);
  });
});
