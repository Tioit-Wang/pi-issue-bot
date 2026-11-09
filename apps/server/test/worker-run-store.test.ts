/**
 * `worker/run-store.ts` 的**真库**测试（dev-plan §13.1：本机有 PG 18，数据相关验收必须真跑）。
 *
 * 为什么必须走真库：这一层全是 SQL。参数化、`::jsonb` 转换、`ON CONFLICT` 与 `coalesce`
 * 的任何一处写错，内存假实现都测不出来——而它们决定的正是「面板能不能看到这一轮发生了什么」。
 *
 * 只碰测试库（`pi_issue_bot_test`）；表由 `openTestDb()` 里的 `migrate()` 建，用完 truncate。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgRunStore } from '../src/worker/index.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

const TASK_ID = 'task-w3i-1';
const RUN_ID = 'run-w3i-1';

let db: TestDb;

beforeAll(async () => {
  db = await openTestDb();
  await db.truncate();
  await db.pool.query(
    `insert into tasks (id, source, repo, target_kind, target_number, command, actor_login, idempotency_key)
     values ($1, 'command', 'acme/widgets', 'issue', 7, '/issue-triage', 'alice', 'w3i-key-1')`,
    [TASK_ID],
  );
});

afterAll(async () => {
  await db.close();
});

describe('worker RunStore（PG 实现）', () => {
  it('beginRun → 事件 / 信封 / 动作 / 熔断 / finishRun → markTask 全部落到正确的列', async () => {
    const store = createPgRunStore({ pool: db.pool });
    const startedAt = new Date('2026-06-01T10:00:00.000Z');
    const endedAt = new Date('2026-06-01T10:05:00.000Z');

    await store.beginRun({ runId: RUN_ID, taskId: TASK_ID, attempt: 1, startedAt });

    await store.appendEvent({ runId: RUN_ID, cursor: 1, kind: 'turn.started', payload: { a: 1 } });
    await store.appendEvent({
      runId: RUN_ID,
      cursor: 2,
      kind: 'item.completed',
      payload: { text: '你好', nested: { ok: true } },
    });

    // 先落一份不合规的、再补一份合规的：验证 `ON CONFLICT (run_id) DO UPDATE`
    await store.recordEnvelope({
      runId: RUN_ID,
      verdict: null,
      actions: null,
      usage: null,
      valid: false,
      errors: [{ path: '/', keyword: 'missing-envelope', message: '没找到信封' }],
    });
    await store.recordEnvelope({
      runId: RUN_ID,
      verdict: { kind: 'issue', labels: ['bug'], evidence: [] },
      actions: [{ intent: 'comment', body: 'hi' }],
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
      valid: true,
      errors: [],
    });

    await store.recordAction({
      runId: RUN_ID,
      intent: 'comment',
      target: 'acme/widgets#7',
      externalRef: '4242',
      appliedAt: new Date('2026-06-01T10:02:00.000Z'),
      audit: { status: 'posted' },
    });
    await store.recordAction({
      runId: RUN_ID,
      intent: 'push_branch',
      target: 'acme/widgets#bot/fix-7',
      externalRef: null,
      appliedAt: null,
      audit: { status: 'delegated', owner: 'git' },
    });

    await store.recordDegeneracyHit({
      runId: RUN_ID,
      hit: { criterion: 'low-novelty', detail: { noveltyRatio: 0.01 }, at: 1_780_000_000_000 },
    });

    await store.finishRun({
      runId: RUN_ID,
      outcome: 'timed-out',
      failureClass: 'timeout',
      failureDetail: { signals: [{ failureClass: 'timeout' }], dryRun: false },
      endedAt,
      sessionId: 'sess-w3i',
      turnId: 'turn-w3i',
    });
    await store.markTask({
      taskId: TASK_ID,
      status: 'timed-out',
      endedAt,
      containerName: 'pi-job-task-w3i-1',
    });

    const run = (await db.sql('select * from runs where id = $1', [RUN_ID]))[0];
    expect(run?.['outcome']).toBe('timed-out');
    expect(run?.['failure_class']).toBe('timeout');
    expect(run?.['session_id']).toBe('sess-w3i');
    expect(run?.['turn_id']).toBe('turn-w3i');
    // jsonb 是对象而不是字符串（写错 `::jsonb` 这里会拿到 string）
    expect((run?.['failure_detail'] as Record<string, unknown>)['dryRun']).toBe(false);
    expect(run?.['ended_at']).toBeInstanceOf(Date);

    const events = await db.sql('select cursor, kind, payload from run_events where run_id = $1 order by cursor', [
      RUN_ID,
    ]);
    expect(events.map((row) => row['cursor'])).toEqual([1, 2]);
    expect((events[1]?.['payload'] as Record<string, unknown>)['text']).toBe('你好');

    const envelopes = await db.sql('select * from envelopes where run_id = $1', [RUN_ID]);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.['valid']).toBe(true);
    expect((envelopes[0]?.['verdict'] as Record<string, unknown>)['kind']).toBe('issue');

    const actions = await db.sql('select * from actions where run_id = $1 order by id', [RUN_ID]);
    expect(actions).toHaveLength(2);
    expect(actions[0]?.['external_ref']).toBe('4242');
    expect(actions[0]?.['applied_at']).toBeInstanceOf(Date);
    expect(actions[1]?.['applied_at']).toBeNull();
    expect((actions[1]?.['audit'] as Record<string, unknown>)['owner']).toBe('git');

    const hits = await db.sql('select criterion, detail from degeneracy_hits where run_id = $1', [RUN_ID]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.['criterion']).toBe('low-novelty');
    expect((hits[0]?.['detail'] as Record<string, unknown>)['noveltyRatio']).toBe(0.01);

    const task = (await db.sql('select status, container_name, ended_at from tasks where id = $1', [TASK_ID]))[0];
    expect(task?.['status']).toBe('timed-out');
    expect(task?.['container_name']).toBe('pi-job-task-w3i-1');
    expect(task?.['ended_at']).toBeInstanceOf(Date);
  });

  it('envelopes 唯一索引在 run_id 上：同一个 run 只会有一行', async () => {
    const rows = await db.sql('select count(*)::int as n from envelopes where run_id = $1', [RUN_ID]);
    expect(rows[0]?.['n']).toBe(1);
  });
});
