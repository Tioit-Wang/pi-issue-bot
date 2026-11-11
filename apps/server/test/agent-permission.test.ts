/**
 * 权限（真 PG）：`docs/test-plan-issue-agent.md` C-10 / L-08 / R-01 / X-09。
 *
 * 三条硬口径：
 *  1. `@` 仅管理员（`settings.agent.managers`），非管理员**一条消息都不产生**；
 *  2. 拒绝记账在 `agent_denials`（PK `repo + issue + actor`），**不参与幂等** ——
 *     同一个人被提成管理员后，同一句话必须能执行（L-08）；
 *  3. 「只回一次」按 **issue** 维度：同一个 actor 换一个 issue 还会回一次（X-09）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleWebhook } from '../src/http/index.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';
import { agentHarness, commentPayload, resetAgentTables, seedAgentRepo } from './helpers/agent-harness.ts';

let db: TestDb;
let deliverySeq = 0;

beforeAll(async () => {
  db = await openTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await resetAgentTables(db);
  deliverySeq = 0;
  await seedAgentRepo(db, { managers: ['alice'] });
});

async function mention(
  harness: ReturnType<typeof agentHarness>,
  input: { body: string; number?: number; login?: string; commentId?: number },
): Promise<{ action: string; duplicate: boolean }> {
  deliverySeq += 1;
  const result = await handleWebhook(harness.deps, {
    deliveryId: `dlv-perm-${String(deliverySeq)}`,
    event: 'issue_comment',
    rawBody: JSON.stringify(commentPayload(input)),
    signature: 'good-signature',
    source: 'live',
  });
  const body = result.body as { action?: string; duplicate?: boolean };
  return { action: body.action ?? '', duplicate: body.duplicate ?? false };
}

async function denials(): Promise<Array<Record<string, unknown>>> {
  return db.sql('select * from agent_denials order by actor_login');
}

async function messageCount(): Promise<number> {
  const rows = await db.sql('select count(*)::int as n from agent_messages');
  return Number(rows[0]?.['n'] ?? 0);
}

describe('C-10 / R-01：非管理员只回一次', () => {
  it('非管理员 @ → 0 消息、`agent_denials` 1 行、回一次「无权限」', async () => {
    const h = agentHarness(db);
    const outcome = await mention(h, { body: '@pi-bot 帮我打个标签', login: 'bob' });

    expect(outcome.action).toBe('ignored');
    expect(await messageCount()).toBe(0);
    const rows = await denials();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['repo']).toBe('acme/widgets');
    expect(Number(rows[0]?.['issue_number'])).toBe(7);
    expect(rows[0]?.['actor_login']).toBe('bob');
    expect(h.deniedReplies).toHaveLength(1);
    expect(h.deniedReplies[0]?.text).toContain('管理员');
    expect(h.sent).toHaveLength(0);
  });

  it('同 issue 同 actor 再说一句 → 静默（`agent_denials` 仍 1 行、不再回话）', async () => {
    const h = agentHarness(db);
    await mention(h, { body: '@pi-bot 帮我打个标签', login: 'bob' });
    const second = await mention(h, { body: '@pi-bot 换一句话', login: 'bob' });

    expect(second.action).toBe('ignored');
    expect(await denials()).toHaveLength(1);
    expect(h.deniedReplies).toHaveLength(1);
    expect(await messageCount()).toBe(0);
  });

  it('X-09：「只回一次」按 issue 维度 —— 换一个 issue 仍回一次', async () => {
    const h = agentHarness(db);
    await mention(h, { body: '@pi-bot 帮我打个标签', login: 'bob', number: 7 });
    await mention(h, { body: '@pi-bot 帮我打个标签', login: 'bob', number: 8 });

    expect(h.deniedReplies).toHaveLength(2);
    const rows = await denials();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => Number(row['issue_number'])))).toEqual(new Set([7, 8]));
  });

  it('管理员发言照常执行（同一句话换成 alice）', async () => {
    const h = agentHarness(db);
    const outcome = await mention(h, { body: '@pi-bot 帮我打个标签', login: 'alice' });

    expect(outcome.action).toBe('enqueued');
    expect(await messageCount()).toBe(1);
    expect(await denials()).toHaveLength(0);
    expect(h.sent).toHaveLength(1);
  });

  it('dry-run 仓库：拒绝照样记账，但**不发**任何 GitHub 写动作（不回话）', async () => {
    await seedAgentRepo(db, { dryRun: true, managers: ['alice'] });
    const h = agentHarness(db);
    await mention(h, { body: '@pi-bot 帮我打个标签', login: 'bob' });

    expect(await denials()).toHaveLength(1);
    expect(h.deniedReplies).toHaveLength(0);
  });
});

describe('L-08：拒绝记录不参与幂等', () => {
  it('同一个人被加入 managers 后，同一句话可以执行', async () => {
    const h = agentHarness(db);
    const body = '@pi-bot 打个标签';
    const denied = await mention(h, { body, login: 'bob', commentId: 900 });
    expect(denied.action).toBe('ignored');
    expect(await messageCount()).toBe(0);

    // 把 bob 提成管理员（面板上就是这么改的）
    await seedAgentRepo(db, { managers: ['alice', 'bob'] });

    const promoted = await mention(h, { body, login: 'bob', commentId: 901 });
    expect(promoted.action).toBe('enqueued');
    expect(await messageCount()).toBe(1);
    expect(h.sent).toHaveLength(1);
    // 拒绝记录留着（审计），但它不影响这条消息
    expect(await denials()).toHaveLength(1);
  });
});
