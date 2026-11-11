/**
 * `/api/tasks` 与 `/api/tasks/:id` 的真库断言：筛选、游标分页、状态/失败分类映射、详情四件套。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { taskDetailResponseSchema, tasksResponseSchema } from '../../../packages/contract/src/index.ts';
import { openTestDb, seedStandard, type TestDb } from './helpers/queries-db.ts';

describe('queries/tasks（真库）', () => {
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

  it('列表：按 queued_at 倒序，字段映射成契约取值', async () => {
    const response = await db.queries.tasks({ limit: 50 });
    expect(() => tasksResponseSchema.parse(response)).not.toThrow();
    expect(response.items.map((item) => item.id)).toEqual([
      't-queue-1',
      't-fail-2',
      't-fail-1',
      't-succ-1',
      't-old-1',
    ]);
    expect(response.totalEstimate).toBe(5);
    expect(response.hasMore).toBe(false);
    expect(response.nextCursor).toBeNull();

    const byId = new Map(response.items.map((item) => [item.id, item]));

    // succeeded：耗时可算、成本 0.05、dry_run 取仓库级开关（acme/widgets=false）
    expect(byId.get('t-succ-1')).toMatchObject({
      status: 'succeeded',
      outcome: 'success',
      failureClass: null,
      startedAt: '2026-06-01T01:00:00.000Z',
      endedAt: '2026-06-01T01:10:00.000Z',
      durationMs: 600_000,
      costUsd: 0.05,
      dryRun: false,
      actorLogin: 'alice',
    });

    // 库里的 timed-out → 契约的 failed（映射在 SQL 里，面板不认新状态）
    expect(byId.get('t-fail-1')).toMatchObject({
      status: 'failed',
      outcome: 'timed-out',
      failureClass: 'timeout',
      headSha: null,
      durationMs: 1_200_000,
      costUsd: 0.1,
    });

    // 多次尝试取「最后一次 run」：failure_class=sandbox_crash → sandbox-crash，成本是两次之和
    expect(byId.get('t-fail-2')).toMatchObject({
      status: 'failed',
      outcome: 'failed',
      failureClass: 'sandbox-crash',
      durationMs: 300_000,
      dryRun: true // other/lib 是 dry-run 仓库
    });
    expect(byId.get('t-fail-2')?.costUsd).toBeCloseTo(0.03, 6);

    // 还在排队：没有 run → startedAt/outcome/failureClass/durationMs/costUsd 全 null
    expect(byId.get('t-queue-1')).toMatchObject({
      status: 'queued',
      outcome: null,
      failureClass: null,
      startedAt: null,
      endedAt: null,
      durationMs: null,
      costUsd: null,
    });
  });

  it('筛选：repo / status / command / failureClass / from-to', async () => {
    expect((await db.queries.tasks({ repo: 'other/lib', limit: 50 })).items.map((i) => i.id)).toEqual([
      't-queue-1',
      't-fail-2',
    ]);

    // status=failed 要同时命中库里的 failed 与 timed-out
    const failed = await db.queries.tasks({ status: 'failed', limit: 50 });
    expect(failed.items.map((i) => i.id)).toEqual(['t-fail-2', 't-fail-1']);
    expect(failed.totalEstimate).toBe(2);

    expect((await db.queries.tasks({ status: 'cancelled', limit: 50 })).items).toEqual([]);

    const byCommand = await db.queries.tasks({ command: '/review-pr', limit: 50 });
    expect(byCommand.items.map((i) => i.id)).toEqual(['t-fail-2', 't-succ-1', 't-old-1']);
    expect(byCommand.totalEstimate).toBe(3);

    // failureClass 过滤发生在映射之后（sandbox-crash 在库里写作 sandbox_crash）
    const byFailure = await db.queries.tasks({ failureClass: 'sandbox-crash', limit: 50 });
    expect(byFailure.items.map((i) => i.id)).toEqual(['t-fail-2']);
    expect(byFailure.totalEstimate).toBe(1);

    const byWindow = await db.queries.tasks({
      from: '2026-06-01T00:00:00Z',
      to: '2026-06-01T06:00:00Z',
      limit: 50,
    });
    expect(byWindow.items.map((i) => i.id)).toEqual(['t-fail-2', 't-fail-1', 't-succ-1']);
    expect(byWindow.totalEstimate).toBe(3);
  });

  it('游标分页：limit=2 走三页，不重不漏，末页 hasMore=false', async () => {
    const first = await db.queries.tasks({ limit: 2 });
    expect(first.items.map((i) => i.id)).toEqual(['t-queue-1', 't-fail-2']);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = await db.queries.tasks({ limit: 2, cursor: first.nextCursor ?? '' });
    expect(second.items.map((i) => i.id)).toEqual(['t-fail-1', 't-succ-1']);
    expect(second.hasMore).toBe(true);

    const third = await db.queries.tasks({ limit: 2, cursor: second.nextCursor ?? '' });
    expect(third.items.map((i) => i.id)).toEqual(['t-old-1']);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeNull();
    // totalEstimate 与分页无关，每页都一样
    expect(third.totalEstimate).toBe(5);
  });

  it('游标非法：抛 bad-request', async () => {
    await expect(db.queries.tasks({ limit: 2, cursor: 'not-a-cursor' })).rejects.toMatchObject({
      code: 'bad-request',
    });
  });

  it('详情：runs + 事件时间线 + 信封 + 动作 + diff', async () => {
    const detail = await db.queries.taskDetail('t-succ-1');
    expect(detail).not.toBeNull();
    if (detail === null) return;
    expect(() => taskDetailResponseSchema.parse(detail)).not.toThrow();

    expect(detail.task.id).toBe('t-succ-1');
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]).toMatchObject({
      id: 'r1',
      attempt: 1,
      sessionId: 'sess-1',
      outcome: 'success',
      failureClass: null,
      failureDetail: null,
    });

    // 事件按时间升序；契约外 kind 归入 notice
    expect(detail.events.map((event) => event.kind)).toEqual(['session', 'approval', 'notice', 'notice']);
    expect(detail.events.map((event) => event.cursor)).toEqual([1, 2, 3, 4]);
    expect(detail.events[1]?.payload).toEqual({ tool: 'Bash', decision: 'deny', rule: 'deny-network' });

    expect(detail.envelopes).toHaveLength(1);
    expect(detail.envelopes[0]).toMatchObject({
      runId: 'r1',
      valid: true,
      actionCount: 2,
      usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.05 },
    });
    expect(detail.envelopes[0]?.verdict).toEqual({
      kind: 'pr',
      labels: ['needs-info'],
      evidence: [{ rule: 'missing-test', quote: '没有新增测试', passed: false }],
    });

    // 动作：contract 里的 5 个 intent 才返回；a1 带写回闸门摘要与「被改回」
    expect(detail.actions.map((action) => action.id)).toEqual(['1', '2']);
    expect(detail.actions[0]).toMatchObject({
      intent: 'comment',
      status: 'applied',
      target: {
        kind: 'comment',
        number: 12,
        ref: null,
        url: 'https://github.com/acme/widgets/issues/12#issuecomment-9001',
      },
      externalRef: '9001',
      revertedAt: '2026-06-01T04:00:00.000Z',
      revertKind: 'comment-deleted',
      dryRun: false,
    });
    expect(detail.actions[0]?.audit).toEqual({
      declared: ['src/a.ts'],
      actual: ['src/a.ts'],
      intersect: ['src/a.ts'],
      dropped: [],
      rejectedReason: null,
    });

    expect(detail.diff.available).toBe(true);
    expect(detail.diff.truncated).toBe(false);
    expect(detail.diff.baseSha).toBe('abcdef1234567');
    expect(detail.diff.text).toContain('diff --git a/src/a.ts');
  });


  it('事件 kind 归一：RACP 原始名映射到契约枚举，只有真未知才落 notice', async () => {
    await db.pool.query(`
      insert into run_events (run_id, cursor, kind, payload, created_at)
      values
        ('r1', 10, 'turn.started', '{}'::jsonb, '2026-06-01T01:08:00Z'),
        ('r1', 11, 'item.completed', '{}'::jsonb, '2026-06-01T01:09:00Z'),
        ('r1', 12, 'approval.requested', '{}'::jsonb, '2026-06-01T01:10:00Z'),
        ('r1', 13, 'sandbox.inspected', '{}'::jsonb, '2026-06-01T01:11:00Z'),
        ('r1', 14, 'writeback.fallback', '{}'::jsonb, '2026-06-01T01:12:00Z')
    `);

    const detail = await db.queries.taskDetail('t-succ-1');
    const kinds = new Map((detail?.events ?? []).map((event) => [event.cursor, event.kind]));

    // 实机（2026-11-11）：这些原始名以前全部落进 notice，详情页整页「通知」
    expect(kinds.get(10)).toBe('turn');
    expect(kinds.get(11)).toBe('tool-call');
    expect(kinds.get(12)).toBe('approval');
    expect(kinds.get(13)).toBe('sandbox');
    expect(kinds.get(14)).toBe('writeback');
    // 真未知（种子里的 `weird-custom`）仍然兜底成 notice
    expect(kinds.get(4)).toBe('notice');
  });
  it('详情：校验失败的信封（verdict=null、usage 归零）与没有 diff 的任务', async () => {
    const detail = await db.queries.taskDetail('t-fail-1');
    expect(detail).not.toBeNull();
    if (detail === null) return;
    expect(() => taskDetailResponseSchema.parse(detail)).not.toThrow();

    expect(detail.runs[0]?.failureDetail).toEqual({ exitCode: 137 });
    expect(detail.envelopes).toHaveLength(1);
    expect(detail.envelopes[0]).toMatchObject({
      valid: false,
      verdict: null,
      actionCount: 0,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    });
    expect(detail.actions.map((action) => action.intent)).toEqual(['close_issue']);
    expect(detail.diff).toEqual({ available: false, text: null, truncated: false, baseSha: null, headSha: null });
  });

  it('详情：任务不存在返回 null（http 层映射 404）', async () => {
    expect(await db.queries.taskDetail('nope')).toBeNull();
  });

  it('详情：库内没有时间锚（t-queue-1）时 startedAt/endedAt 都是 null，事件与动作都为空', async () => {
    const detail = await db.queries.taskDetail('t-queue-1');
    expect(detail?.runs).toEqual([]);
    expect(detail?.events).toEqual([]);
    expect(detail?.envelopes).toEqual([]);
    expect(detail?.actions).toEqual([]);
    expect(detail?.task.queuedAt).toBe('2026-06-01T11:00:00.000Z');
    expect(detail?.task.durationMs).toBeNull();
  });

  it('列表：空库返回空数组 + totalEstimate=0（不是 null）', async () => {
    await db.truncate();
    const response = await db.queries.tasks({ limit: 50 });
    expect(response.items).toEqual([]);
    expect(response.hasMore).toBe(false);
    expect(response.nextCursor).toBeNull();
    expect(response.totalEstimate).toBe(0);
  });
});
