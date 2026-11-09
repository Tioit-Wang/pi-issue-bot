/**
 * `/api/costs`、`/api/quality/reverts`、`/api/audit`（含 CSV）、`/api/system` 的真库断言。
 *
 * 每个接口都做两件事：**数字**与手算/手写 SQL 相等，返回值能通过对应 `*ResponseSchema.parse()`。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AUDIT_CSV_COLUMNS,
  AUDIT_EXPORT_LIMIT,
  auditResponseSchema,
  costsResponseSchema,
  revertsResponseSchema,
  systemResponseSchema,
} from '../../../packages/contract/src/index.ts';
import { openTestDb, seedStandard, type TestDb } from './helpers/queries-db.ts';

describe('queries/costs（真库）', () => {
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

  it('合计 / 三维拆分 / 最贵任务：数字与手算一致', async () => {
    const response = await db.queries.costs({ from: '2026-05-31T12:00:00Z', to: '2026-06-01T12:00:00Z', top: 10 });
    expect(() => costsResponseSchema.parse(response)).not.toThrow();

    expect(response.currency).toBe('USD');
    expect(response.total.inputTokens).toBe(4_600);
    expect(response.total.outputTokens).toBe(1_850);
    expect(response.total.costUsd).toBeCloseTo(0.22, 6);
    // 5 个 run 都有 usage 记账 → 覆盖率 1
    expect(response.total.pricingCoverage).toBe(1);

    expect(response.byRepo.map((bucket) => bucket.key)).toEqual(['acme/widgets', 'other/lib']);
    expect(response.byRepo[0]).toMatchObject({ tasks: 3, runs: 3 });
    expect(response.byRepo[0]?.costUsd).toBeCloseTo(0.19, 6);
    expect(response.byRepo[1]).toMatchObject({ tasks: 1, runs: 2 });
    expect(response.byRepo[1]?.costUsd).toBeCloseTo(0.03, 6);

    // 按命令拆分读 tasks.command（不解 jsonb）
    expect(response.byCommand.map((bucket) => bucket.key)).toEqual(['/review-pr', 'auto:triage']);
    expect(response.byCommand[0]).toMatchObject({ tasks: 3, runs: 4 });
    expect(response.byCommand[0]?.costUsd).toBeCloseTo(0.12, 6);
    expect(response.byCommand[1]?.costUsd).toBeCloseTo(0.1, 6);

    expect(response.byModel.map((bucket) => bucket.key)).toEqual(['anthropic/claude-x', 'openai/gpt-y']);
    expect(response.byModel[0]?.costUsd).toBeCloseTo(0.19, 6);
    expect(response.byModel[1]?.costUsd).toBeCloseTo(0.03, 6);

    expect(response.topTasks.map((task) => task.taskId)).toEqual([
      't-fail-1',
      't-succ-1',
      't-old-1',
      't-fail-2',
    ]);
    expect(response.topTasks[0]?.costUsd).toBeCloseTo(0.1, 6);
    expect(response.topTasks[3]).toMatchObject({
      repo: 'other/lib',
      command: '/review-pr',
      inputTokens: 800,
      outputTokens: 150,
      endedAt: '2026-06-01T03:05:00.000Z',
    });

    expect(response.series.map((point) => point.day)).toEqual(['2026-05-31', '2026-06-01']);
    expect(response.series[0]).toMatchObject({ inputTokens: 800, outputTokens: 200 });
    expect(response.series[0]?.costUsd).toBeCloseTo(0.04, 6);
    expect(response.series[1]).toMatchObject({ inputTokens: 3800, outputTokens: 1650 });
    expect(response.series[1]?.costUsd).toBeCloseTo(0.18, 6);
  });

  it('series：明细期之外由 metrics_daily 补日成本（token 记 0）', async () => {
    const response = await db.queries.costs({
      from: '2026-05-01T00:00:00Z',
      to: '2026-06-01T12:00:00Z',
      top: 2,
    });
    expect(response.series.map((point) => point.day)).toEqual(['2026-05-20', '2026-05-31', '2026-06-01']);
    expect(response.series[0]).toEqual({
      day: '2026-05-20',
      costUsd: 7.77,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(response.topTasks).toHaveLength(2); // top=2 生效
  });

  it('repo 过滤：只统计该仓库', async () => {
    const response = await db.queries.costs({ repo: 'other/lib', top: 10 });
    expect(response.total.costUsd).toBeCloseTo(0.03, 6);
    expect(response.byRepo).toHaveLength(1);
    expect(response.byCommand.map((bucket) => bucket.key)).toEqual(['/review-pr']);
    expect(response.topTasks.map((task) => task.taskId)).toEqual(['t-fail-2']);
  });

  it('空库：全零、series 为空、pricingCoverage=0（避免 NaN）', async () => {
    await db.truncate();
    const response = await db.queries.costs({ top: 10 });
    expect(response.total).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      pricingCoverage: 0,
    });
    expect(response.byRepo).toEqual([]);
    expect(response.series).toEqual([]);
    expect(response.topTasks).toEqual([]);
  });
});

describe('queries/quality/reverts（真库）', () => {
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

  it('改回率：applied 计已落地动作，reverted 计置位行', async () => {
    const response = await db.queries.reverts({ from: '2026-05-31T12:00:00Z', to: '2026-06-01T12:00:00Z', limit: 50 });
    expect(() => revertsResponseSchema.parse(response)).not.toThrow();

    // a1,a2,a3,a5,a6 已应用（a4 未落地、a7 是契约外 intent），其中 a1/a5 被改回
    expect(response.overall).toEqual({ applied: 5, reverted: 2, rate: 0.4 });

    expect(response.byCommand.map((bucket) => bucket.key)).toEqual(['/review-pr', 'auto:triage']);
    expect(response.byCommand[0]).toEqual({ key: '/review-pr', applied: 4, reverted: 2, rate: 0.5 });
    expect(response.byCommand[1]).toEqual({ key: 'auto:triage', applied: 1, reverted: 0, rate: 0 });

    expect(response.byRepo.map((bucket) => bucket.key)).toEqual(['acme/widgets', 'other/lib']);
    expect(response.byRepo[0]).toMatchObject({ applied: 3, reverted: 1 });
    expect(response.byRepo[0]?.rate).toBeCloseTo(1 / 3, 6);
    expect(response.byRepo[1]).toEqual({ key: 'other/lib', applied: 2, reverted: 1, rate: 0.5 });

    // 逐条记录按 reverted_at 倒序
    expect(response.records.map((record) => record.actionId)).toEqual(['5', '1']);
    expect(response.records[1]).toMatchObject({
      taskId: 't-succ-1',
      repo: 'acme/widgets',
      command: '/review-pr',
      intent: 'comment',
      revertKind: 'comment-deleted',
      appliedAt: '2026-06-01T01:11:00.000Z',
      revertedAt: '2026-06-01T04:00:00.000Z',
      url: 'https://github.com/acme/widgets/issues/12#issuecomment-9001',
    });
    expect(response.hasMore).toBe(false);
    expect(response.nextCursor).toBeNull();
  });

  it('records 分页：limit=1 走两页', async () => {
    const first = await db.queries.reverts({ limit: 1 });
    expect(first.records).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    const second = await db.queries.reverts({ limit: 1, cursor: first.nextCursor ?? '' });
    expect(second.records).toHaveLength(1);
    expect(second.records[0]?.actionId).not.toBe(first.records[0]?.actionId);
    expect(second.hasMore).toBe(false);
  });

  it('applied=0 时 rate 必须是 null（契约的 refine）', async () => {
    const response = await db.queries.reverts({ from: '2020-01-01T00:00:00Z', to: '2020-01-02T00:00:00Z', limit: 50 });
    expect(response.overall).toEqual({ applied: 0, reverted: 0, rate: null });
    expect(response.byCommand).toEqual([]);
    expect(response.records).toEqual([]);
    expect(() => revertsResponseSchema.parse(response)).not.toThrow();
  });
});

describe('queries/audit（真库）', () => {
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

  it('审计行：谁触发 / 跑哪个 sha / 写了什么 / 审批判定', async () => {
    const response = await db.queries.audit({ from: '2026-05-31T12:00:00Z', to: '2026-06-01T12:00:00Z', limit: 50 });
    expect(() => auditResponseSchema.parse(response)).not.toThrow();

    // 契约外的 intent（open_pr）不出现；按 created_at 倒序
    expect(response.items.map((row) => row.id)).toEqual(['6', '5', '4', '3', '2', '1']);
    expect(response.truncated).toBe(false);
    expect(response.exportLimit).toBe(AUDIT_EXPORT_LIMIT);

    const byId = new Map(response.items.map((row) => [row.id, row]));
    expect(byId.get('1')).toMatchObject({
      repo: 'acme/widgets',
      taskId: 't-succ-1',
      runId: 'r1',
      actor: { login: 'alice', association: null },
      command: '/review-pr',
      target: { kind: 'comment', number: 12, ref: null },
      intent: 'comment',
      status: 'applied',
      headSha: 'abcdef1234567',
      externalRef: '9001',
      approval: { tool: 'Bash', decision: 'deny', rule: 'deny-network' },
      revertedAt: '2026-06-01T04:00:00.000Z',
      revertKind: 'comment-deleted',
      dryRun: false,
    });

    // 写回闸门拒收的行：status 从 audit.rejectedReason 推出，分支类目标带 ref
    expect(byId.get('4')).toMatchObject({
      intent: 'push_branch',
      status: 'rejected',
      target: { kind: 'branch', number: null, ref: 'pi-bot/fix-3' },
      actor: { login: 'carol' },
      headSha: 'deadbeef1234',
    });

    // r2 没有审批事件 → approval 为 null
    expect(byId.get('3')?.approval).toBeNull();
    expect(byId.get('3')?.actor.login).toBe('bob');
  });

  it('筛选 intent / repo 与分页', async () => {
    const labels = await db.queries.audit({ intent: 'label', limit: 50 });
    expect(labels.items.map((row) => row.id)).toEqual(['6', '2']);

    const other = await db.queries.audit({ repo: 'other/lib', limit: 50 });
    expect(other.items.map((row) => row.id)).toEqual(['6', '5', '4']);

    const first = await db.queries.audit({ limit: 2 });
    expect(first.items.map((row) => row.id)).toEqual(['6', '5']);
    expect(first.hasMore).toBe(true);
    const second = await db.queries.audit({ limit: 2, cursor: first.nextCursor ?? '' });
    expect(second.items.map((row) => row.id)).toEqual(['4', '3']);
  });

  it('CSV：BOM + 契约列顺序 + RFC 4180 转义', async () => {
    const csv = await db.queries.auditCsv({ from: '2026-05-31T12:00:00Z', to: '2026-06-01T12:00:00Z', limit: 50 });
    expect(csv.startsWith('\uFEFF')).toBe(true);

    const lines = csv.replace(/^\uFEFF/, '').trimEnd().split('\r\n');
    expect(lines[0]).toBe(AUDIT_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(1 + 6); // 表头 + 6 行
    expect(lines[1]).toContain('other/lib');

    const header = AUDIT_CSV_COLUMNS.join(',');
    expect(header.startsWith('id,at,repo,task_id,run_id,actor_login,actor_association,command')).toBe(true);
    // actor_association 目前没有来源列 → 空串（不是 "null"）
    const row4 = lines.find((line) => line.startsWith('4,'));
    expect(row4?.includes(',null,')).toBe(false);
  });
});

describe('queries/system（真库）', () => {
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

  it('版本 / 协议 / host / doctor 占位，队列配置读 pgboss，flags 与 repos 读表', async () => {
    const response = await db.queries.system();
    expect(() => systemResponseSchema.parse(response)).not.toThrow();

    expect(response.version).toEqual({ app: '0.0.0', contract: '1.0.0', host: null, hostPinned: false });
    expect(response.protocol).toEqual({ wsPath: '/v1/racp/ws', wsSubprotocol: 'pi-racp.v1.jsonrpc' });
    expect(response.host).toEqual({ status: 'unknown', lastPingAt: null, sessions: 0 });
    expect(response.doctor).toEqual({ status: 'not-run', checkedAt: null, checks: [] });
    expect(response.retention).toEqual({
      webhookDays: 90,
      runEventDays: 90,
      transcriptDays: 90,
      metricsForever: true,
    });
    expect(response.skills).toEqual([]);

    // 队列：内部队列（__pgboss__*）不展示，配置来自 pgboss.queue
    const runTask = response.queue.find((queue) => queue.name === 'run-task');
    expect(runTask).toBeDefined();
    expect(runTask).toMatchObject({ retryLimit: 0, expireInMs: 1_200_000, pending: 2, active: 1 });
    expect(response.queue.every((queue) => !queue.name.startsWith('__pgboss__'))).toBe(true);

    // flags：过期的不返回（maintenance 的 until 在 5 月）
    expect(response.flags).toEqual([
      { key: 'rate_limit_pause', value: '1', until: '2026-06-01T12:15:00.000Z' },
    ]);

    expect(response.repos).toEqual([
      { repo: 'acme/widgets', enabled: true, dryRun: false, configValid: true, configError: null },
      {
        repo: 'other/lib',
        enabled: true,
        dryRun: true,
        configValid: false,
        configError: 'outputs 越界：pr 但没有 paths',
      },
    ]);
  });

  it('空库：零值而非 null（契约允许空数组）', async () => {
    await db.truncate();
    const response = await db.queries.system();
    expect(response.flags).toEqual([]);
    expect(response.repos).toEqual([]);
    expect(response.queue.every((queue) => queue.pending === 0 && queue.active === 0)).toBe(true);
    expect(response.retention.metricsForever).toBe(true);
  });
});
