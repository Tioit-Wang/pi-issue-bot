/**
 * `jobs/retention-cleanup` 的**真库**测试（tech-plan §7.6）。
 *
 * 断言的是四件具体的事：
 *  1. **只删 90 天以外的**：91 天前的 `run_events` / `webhook_deliveries` 没了，昨天的一行不少；
 *  2. **`metrics_daily` 与 `actions` 一行都不动**（永久保留，§7.6 的「不删」）；
 *  3. **先聚合再删**：超期明细所属的那天若有 run 却没指标，先跑 rollup；补不出来就整批跳过并告警；
 *  4. **按批删**：1200 条超期事件分两批（1000 + 200）删完，不是一条长事务。
 *
 * 时间基准写死：`now = 2026-06-01T12:00:00Z` → 90 天前 = `2026-03-03T12:00:00Z`。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { metricsRollup, retentionCleanup } from '../src/jobs/index.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

const NOW = Date.parse('2026-06-01T12:00:00.000Z');
const YESTERDAY = '2026-05-31';

let db: TestDb;
const clock = (): number => NOW;

async function countOf(table: string, where = 'true'): Promise<number> {
  const result = await db.pool.query(`select count(*)::int as n from ${table} where ${where}`);
  return (result.rows[0] as { n: number }).n;
}

async function seed(): Promise<void> {
  // 超期明细：91 天前（2026-02-20/21），且对应的 run 已经不在了（没有可保护的东西）
  await db.pool.query(`
    insert into run_events (run_id, cursor, kind, payload, created_at)
    values ('r-purged', 1, 'turn/started', '{}'::jsonb, '2026-02-20T00:00:00Z'),
           ('r-purged', 2, 'turn/ended',   '{}'::jsonb, '2026-02-20T00:05:00Z'),
           ('r-purged', 3, 'turn/ended',   '{}'::jsonb, '2026-02-21T00:00:00Z')
  `);

  // 昨天的明细：必须留下
  await db.pool.query(`
    insert into run_events (run_id, cursor, kind, payload, created_at)
    values ('r-yesterday', 1, 'turn/started', '{}'::jsonb, '2026-05-31T10:00:00Z'),
           ('r-yesterday', 2, 'turn/ended',   '{}'::jsonb, '2026-05-31T10:01:00Z')
  `);

  await db.pool.query(`
    insert into webhook_deliveries (delivery_id, event, action, payload, received_at)
    values ('old-1', 'issues', 'opened', '{}'::jsonb, '2026-01-15T00:00:00Z'),
           ('old-2', 'issues', 'opened', '{}'::jsonb, '2026-01-16T00:00:00Z'),
           ('new-1', 'issues', 'opened', '{}'::jsonb, '2026-05-31T00:00:00Z')
  `);

  // 永久数据：metrics_daily 一行 + actions 一行
  await db.pool.query(`
    insert into tasks (id, source, repo, target_kind, target_number, command, actor_login, idempotency_key, status)
    values ('t-y', 'command', 'acme/widgets', 'pr', 12, '/review-pr', 'alice', 'ret-k1', 'succeeded')
  `);
  await db.pool.query(`
    insert into runs (id, task_id, attempt, started_at, ended_at, outcome)
    values ('r-yesterday', 't-y', 1, '2026-05-31T09:00:00Z', '2026-05-31T10:00:00Z', 'succeeded')
  `);
  await db.pool.query(`
    insert into metrics_daily (day, repo, outcome, run_count, p50_ms, p95_ms, cost_usd, revert_count, command_cost_usd)
    values ('${YESTERDAY}', 'acme/widgets', 'succeeded', 1, 3600000, 3600000, 0.050000, 1, '{"/review-pr":0.05}'::jsonb)
  `);
  await db.pool.query(`
    insert into actions (run_id, intent, target, external_ref, applied_at, reverted_at, revert_kind)
    values ('r-yesterday', 'label', 'acme/widgets#12', null, '2026-05-31T10:02:00Z', '2026-05-31T11:00:00Z', 'label-removed')
  `);
}

/** 造一天「有 run、有明细、但还没聚合」的 91 天前数据（用于验证「先聚合再删」）。 */
async function seedUnrolledOldDay(): Promise<void> {
  await db.pool.query(`
    insert into tasks (id, source, repo, target_kind, target_number, command, actor_login, idempotency_key, status)
    values ('t-old', 'command', 'acme/widgets', 'pr', 21, '/review-pr', 'bob', 'ret-k2', 'succeeded')
  `);
  await db.pool.query(`
    insert into runs (id, task_id, attempt, started_at, ended_at, outcome)
    values ('r-old', 't-old', 1, '2026-01-10T00:00:00Z', '2026-01-10T00:01:00Z', 'succeeded')
  `);
  await db.pool.query(`
    insert into run_events (run_id, cursor, kind, payload, created_at)
    values ('r-old', 1, 'turn/started', '{}'::jsonb, '2026-01-10T00:00:30Z')
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

describe('jobs/retention-cleanup（PG 实现）', () => {
  it('只删 90 天以外的明细，永久表一行不动', async () => {
    const result = await retentionCleanup({ pool: db.pool, clock });

    expect(result.ok).toBe(true);
    expect(result.stats.retentionDays).toBe(90);
    expect(result.stats.cutoff).toBe('2026-03-03T12:00:00.000Z');
    expect(result.stats.runEventsDeleted).toBe(3);
    expect(result.stats.webhookDeliveriesDeleted).toBe(2);
    expect(result.stats.blockedDays).toEqual([]);

    expect(await countOf('run_events')).toBe(2);
    expect(await countOf('run_events', "run_id = 'r-purged'")).toBe(0);
    expect(await countOf('webhook_deliveries')).toBe(1);
    expect(await countOf('webhook_deliveries', "delivery_id = 'new-1'")).toBe(1);
    // 永久表：metrics_daily / actions 既不删也不改写
    expect(result.stats.metricsDailyRows).toBe(1);
    expect(result.stats.actionsRows).toBe(1);
    expect(await countOf('metrics_daily')).toBe(1);
    expect(await countOf('actions')).toBe(1);
    expect(await countOf('actions', 'revert_kind is not null')).toBe(1);
  });

  it('该天有 run 却没指标：先补跑 rollup 再删明细', async () => {
    await seedUnrolledOldDay();
    expect(await countOf('metrics_daily', "day = '2026-01-10'")).toBe(0);

    const rolledUp: string[] = [];
    const result = await retentionCleanup(
      {
        pool: db.pool,
        clock,
        // 注入一个「真的会聚合」的补跑，顺便记录被补的日期
        rollup: async (day: string) => {
          rolledUp.push(day);
          await metricsRollup({ pool: db.pool, clock }, { day });
        },
      },
      { retentionDays: 90 },
    );

    expect(rolledUp).toEqual(['2026-01-10']);
    expect(result.stats.rollupDays).toEqual(['2026-01-10']);
    expect(result.stats.blockedDays).toEqual([]);
    // 补聚合先落地，明细才被删
    const metrics = await db.pool.query(
      "select run_count, p50_ms, cost_usd::text as cost from metrics_daily where day = '2026-01-10'",
    );
    expect(metrics.rows[0]).toEqual({ run_count: 1, p50_ms: 60000, cost: '0.000000' });
    expect(await countOf('run_events', "run_id = 'r-old'")).toBe(0);
    expect(result.stats.runEventsDeleted).toBe(4);
  });

  it('补聚合仍拿不到指标：当天明细整批跳过并告警（宁可不删）', async () => {
    await seedUnrolledOldDay();

    const result = await retentionCleanup({
      pool: db.pool,
      clock,
      // 补跑「失败」：什么也没做
      rollup: async () => undefined,
    });

    expect(result.ok).toBe(false);
    expect(result.stats.blockedDays).toEqual(['2026-01-10']);
    expect(result.stats.rollupDays).toEqual(['2026-01-10']);
    expect(result.warnings).toHaveLength(1);
    // 被拦下的那天一行都不删
    expect(await countOf('run_events', "run_id = 'r-old'")).toBe(1);
    // 其它超期明细照删
    expect(result.stats.runEventsDeleted).toBe(3);
  });

  it('按批删：1200 条超期事件分两批（1000 + 200）', async () => {
    await db.pool.query(`
      insert into run_events (run_id, cursor, kind, payload, created_at)
      select 'r-bulk', g, 'turn/step', '{}'::jsonb, '2026-01-01T00:00:00Z'::timestamptz
        from generate_series(1, 1200) as g
    `);

    const result = await retentionCleanup({ pool: db.pool, clock });
    expect(result.stats.runEventsDeleted).toBe(1203);
    // 2 批 run_events（1000 + 203）+ 1 批 webhook（0 条也要走一次收尾）
    expect(result.stats.batches).toBe(3);
    expect(await countOf('run_events', "run_id = 'r-bulk'")).toBe(0);
    expect(await countOf('run_events')).toBe(2);
  });

  it('dry-run：只报告会删多少，一行都不删', async () => {
    const result = await retentionCleanup({ pool: db.pool, clock }, { dryRun: true });

    expect(result.stats.runEventsDeleted).toBe(3);
    expect(result.stats.webhookDeliveriesDeleted).toBe(2);
    expect(await countOf('run_events')).toBe(5);
    expect(await countOf('webhook_deliveries')).toBe(3);
  });

  it('入参自检：保留期与批量大小的边界', async () => {
    await expect(retentionCleanup({ pool: db.pool, clock }, { retentionDays: 0 })).rejects.toThrow(/正整数/);
    await expect(retentionCleanup({ pool: db.pool, clock }, { batchSize: 5000 })).rejects.toThrow(/1–1000/);
  });
});
