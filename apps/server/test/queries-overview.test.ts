/**
 * `/api/overview` 的真库断言：数字必须与手写 SQL 相等，且返回值能通过 `overviewResponseSchema.parse()`。
 *
 * 种子见 `helpers/queries-db.ts`（固定时钟 `2026-06-01T12:00:00Z`）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { overviewResponseSchema } from '../../../packages/contract/src/index.ts';
import { QueryError } from '../src/queries/index.ts';
import { FIXED_NOW, openTestDb, seedStandard, type TestDb } from './helpers/queries-db.ts';

describe('queries/overview（真库）', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await openTestDb();
  });

  afterAll(async () => {
    await db.truncate();
    await db.close();
  });

  beforeEach(async () => {
    await db.truncate();
    await seedStandard(db);
  });

  it('today：投递 / 任务 / 成功 / 失败 / 成功率 / 成本与手写 SQL 相等', async () => {
    const response = await db.queries.overview({});
    expect(() => overviewResponseSchema.parse(response)).not.toThrow();

    const [handTask] = await db.sql(
      `select
         count(*) as tasks,
         count(*) filter (where status = 'succeeded') as succeeded,
         count(*) filter (where status in ('failed', 'timed-out')) as failed
       from tasks
       where queued_at >= '2026-06-01T00:00:00Z' and queued_at < '2026-06-02T00:00:00Z'`,
    );
    const [handDelivery] = await db.sql(
      `select count(*) as deliveries from webhook_deliveries
       where received_at >= '2026-06-01T00:00:00Z' and received_at < '2026-06-02T00:00:00Z'`,
    );
    const [handCost] = await db.sql(
      `select coalesce(sum(uc.cost_usd), 0) as cost
       from usage_costs uc
       join runs r on r.id = uc.run_id
       join tasks t on t.id = r.task_id
       where t.queued_at >= '2026-06-01T00:00:00Z' and t.queued_at < '2026-06-02T00:00:00Z'`,
    );

    expect(response.today.tasks).toBe(Number(handTask?.['tasks']));
    expect(response.today.tasks).toBe(4);
    expect(response.today.deliveries).toBe(Number(handDelivery?.['deliveries']));
    expect(response.today.deliveries).toBe(3);
    expect(response.today.succeeded).toBe(Number(handTask?.['succeeded']));
    expect(response.today.succeeded).toBe(1);
    expect(response.today.failed).toBe(Number(handTask?.['failed']));
    expect(response.today.failed).toBe(2);
    // 成功率的分母是「有结论的任务」：1/(1+2)
    expect(response.today.successRate).toBeCloseTo(1 / 3, 6);
    expect(response.today.costUsd).toBeCloseTo(Number(handCost?.['cost']), 6);
    expect(response.today.costUsd).toBeCloseTo(0.18, 6);
  });

  it('today.p50/p95：三个已结束任务的耗时（600s / 1200s / 300s）', async () => {
    const response = await db.queries.overview({});
    // 样本升序 [300000, 600000, 1200000] → p50 = 600000；p95 = 600000 + 0.9*(1200000-600000)
    expect(response.today.p50Ms).toBe(600_000);
    expect(response.today.p95Ms).toBe(1_140_000);

    const [hand] = await db.sql(
      `select
         round(percentile_cont(0.5) within group (order by d.ms)::numeric)::int as p50,
         round(percentile_cont(0.95) within group (order by d.ms)::numeric)::int as p95
       from (
         select extract(epoch from (t.ended_at - r.started_at)) * 1000 as ms
         from tasks t
         join lateral (select min(started_at) as started_at from runs where task_id = t.id) r on true
         where t.ended_at is not null and r.started_at is not null and t.ended_at >= r.started_at
           and t.queued_at >= '2026-06-01T00:00:00Z' and t.queued_at < '2026-06-02T00:00:00Z'
       ) d`,
    );
    expect(response.today.p50Ms).toBe(Number(hand?.['p50']));
    expect(response.today.p95Ms).toBe(Number(hand?.['p95']));
  });

  it('queue：深度 / 执行中 / 最老等待 / 熔断解除时间', async () => {
    const response = await db.queries.overview({});
    const [hand] = await db.sql(
      `select
         count(*) filter (where state in ('created','retry')) as pending,
         count(*) filter (where state = 'active') as active,
         extract(epoch from ($1::timestamptz - min(created_on) filter (where state in ('created','retry')))) * 1000 as oldest_ms
       from pgboss.job`,
      [FIXED_NOW.toISOString()],
    );

    expect(response.queue.depth).toBe(Number(hand?.['pending']));
    expect(response.queue.depth).toBe(2);
    expect(response.queue.active).toBe(Number(hand?.['active']));
    expect(response.queue.active).toBe(1);
    expect(response.queue.oldestQueuedMs).toBe(Math.round(Number(hand?.['oldest_ms'])));
    expect(response.queue.oldestQueuedMs).toBe(600_000); // 11:50 → 12:00
    expect(response.queue.pausedUntil).toBe('2026-06-01T12:15:00.000Z');
  });

  it('trend：24 个整点、升序、按小时分桶', async () => {
    const response = await db.queries.overview({});
    expect(response.trend).toHaveLength(24);
    const points = response.trend;

    expect(points[0]?.at).toBe('2026-05-31T13:00:00.000Z');
    expect(points[0]?.tasks).toBe(1); // t-old-1
    expect(points[23]?.at).toBe('2026-06-01T12:00:00.000Z');

    const byHour = new Map(points.map((point) => [point.at, point]));
    expect(byHour.get('2026-06-01T01:00:00.000Z')).toEqual({
      at: '2026-06-01T01:00:00.000Z',
      tasks: 1,
      succeeded: 1,
      failed: 0,
    });
    expect(byHour.get('2026-06-01T03:00:00.000Z')).toEqual({
      at: '2026-06-01T03:00:00.000Z',
      tasks: 1,
      succeeded: 0,
      failed: 1,
    });
    expect(byHour.get('2026-06-01T11:00:00.000Z')?.tasks).toBe(1); // t-queue-1
    // 累计 = 窗口内任务总数（5 个）
    expect(points.reduce((sum, point) => sum + point.tasks, 0)).toBe(5);
    // 升序
    const timestamps = points.map((point) => Date.parse(point.at));
    expect([...timestamps].sort((left, right) => left - right)).toEqual(timestamps);
  });

  it('outcomeDistribution / failureTop：窗口内按 run 计数（含数据库取值 → 契约取值的映射）', async () => {
    const response = await db.queries.overview({});
    expect(response.outcomeDistribution).toEqual([
      { outcome: 'failed', count: 2 },
      { outcome: 'success', count: 2 },
      { outcome: 'timed-out', count: 1 },
    ]);
    // rate_limit → rate-limit，sandbox_crash → sandbox-crash，三者各 1，按分类名升序
    expect(response.failureTop).toEqual([
      { failureClass: 'rate-limit', count: 1 },
      { failureClass: 'sandbox-crash', count: 1 },
      { failureClass: 'timeout', count: 1 },
    ]);
  });

  it('window：缺省最近 24h；doctor 为 not-run 占位', async () => {
    const response = await db.queries.overview({});
    expect(response.window).toEqual({
      from: '2026-05-31T12:00:00.000Z',
      to: '2026-06-01T12:00:00.000Z',
    });
    expect(response.generatedAt).toBe(FIXED_NOW.toISOString());
    expect(response.doctor).toEqual({ status: 'not-run', checkedAt: null, failedChecks: [] });
  });

  it('from > to：抛 unprocessable（http 层据此回 422）', async () => {
    await expect(
      db.queries.overview({ from: '2026-06-02T00:00:00Z', to: '2026-06-01T00:00:00Z' }),
    ).rejects.toThrowError(QueryError);

    await expect(
      db.queries.overview({ from: '2026-06-02T00:00:00Z', to: '2026-06-01T00:00:00Z' }),
    ).rejects.toMatchObject({ code: 'unprocessable' });
  });

  it('空库：返回零值而不是 null（分位数与成功率除外，它们是 null）', async () => {
    await db.truncate();
    const response = await db.queries.overview({});
    expect(() => overviewResponseSchema.parse(response)).not.toThrow();
    expect(response.today).toEqual({
      deliveries: 0,
      tasks: 0,
      succeeded: 0,
      failed: 0,
      successRate: null,
      p50Ms: null,
      p95Ms: null,
      costUsd: 0,
    });
    expect(response.queue).toEqual({ depth: 0, active: 0, oldestQueuedMs: null, pausedUntil: null });
    expect(response.trend).toHaveLength(24);
    expect(response.trend.every((point) => point.tasks === 0)).toBe(true);
    expect(response.outcomeDistribution).toEqual([]);
    expect(response.failureTop).toEqual([]);
  });
});
