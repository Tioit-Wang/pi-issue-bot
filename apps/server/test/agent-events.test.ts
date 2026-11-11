/**
 * 事件投递规则（真 PG + 真 webhook + 真 dispatcher）。
 *
 * 覆盖 `docs/test-plan-issue-agent.md`：E-01（opened）、E-02（标题/正文变更）、E-03（仅 label 变）、
 * E-04（reopened）、E-06/E-07（labeled / assigned / closed）、E-08（bot 自己）、E-09（dependabot /
 * renovate）、E-10（正文 @ 不产生 mention），以及 CF-02 / CF-03（模板置空 = 不投递）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleWebhook } from '../src/http/index.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';
import {
  AGENT_REPO,
  agentHarness,
  commentPayload,
  issuesPayload,
  resetAgentTables,
  seedAgentRepo,
} from './helpers/agent-harness.ts';

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
  await seedAgentRepo(db);
});

/** 投一次 webhook；`deliveryId` 每次唯一（投递级幂等不参与本文件的判定）。 */
async function deliver(
  deps: Parameters<typeof handleWebhook>[0],
  event: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; action: string; duplicate: boolean }> {
  deliverySeq += 1;
  const result = await handleWebhook(deps, {
    deliveryId: `dlv-agent-${String(deliverySeq)}`,
    event,
    rawBody: JSON.stringify(payload),
    signature: 'good-signature',
    source: 'live',
  });
  const body = result.body as { action?: string; duplicate?: boolean };
  return { status: result.status, action: body.action ?? '', duplicate: body.duplicate ?? false };
}

async function messages(): Promise<Array<Record<string, unknown>>> {
  return db.sql('select * from agent_messages order by created_at, fingerprint');
}

async function taskCount(): Promise<number> {
  const rows = await db.sql('select count(*)::int as n from tasks');
  return Number(rows[0]?.['n'] ?? 0);
}

describe('E-01 / E-10：issues.opened', () => {
  it('非 bot 新 issue → 1 条 event 消息 + 1 个任务，模板点名 format-check', async () => {
    const h = agentHarness(db, { skills: ['/format-check'] });
    const outcome = await deliver(h.deps, 'issues', issuesPayload({ action: 'opened' }));

    expect(outcome.status).toBe(200);
    expect(outcome.action).toBe('enqueued');
    const rows = await messages();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['kind']).toBe('event');
    expect(String(rows[0]?.['comment_body'])).toContain('登录按钮没反应');
    expect(String(rows[0]?.['comment_body'])).toContain('先加载技能');
    expect(String(rows[0]?.['comment_body'])).toContain('format-check');
    expect(await taskCount()).toBe(1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.command).toBe('agent:event');
  });

  it('E-10：正文里 @ 了机器人不会额外产生 mention 消息（只有 opened 这一条）', async () => {
    const h = agentHarness(db);
    await deliver(
      h.deps,
      'issues',
      issuesPayload({ action: 'opened', body: '复现步骤：点一下 @pi-bot 这里要不要看下' }),
    );
    const rows = await messages();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['kind']).toBe('event');
    expect(h.sent).toHaveLength(1);
  });
});

describe('E-02 / E-03：issues.edited 只认标题与正文变更', () => {
  it('标题或正文变了 → 投递 edited 模板', async () => {
    const h = agentHarness(db);
    const outcome = await deliver(
      h.deps,
      'issues',
      issuesPayload({
        action: 'edited',
        updatedAt: '2026-06-01T10:00:00Z',
        changes: { body: { from: '旧正文' } },
      }),
    );
    expect(outcome.action).toBe('enqueued');
    const rows = await messages();
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.['comment_body'])).toContain('被修改过');
    expect(h.sent).toHaveLength(1);
  });

  it('只改了标签（changes 里没有 title/body）→ 0 消息', async () => {
    const h = agentHarness(db);
    const outcome = await deliver(
      h.deps,
      'issues',
      issuesPayload({ action: 'edited', changes: { labels: [{ name: 'bug' }] } }),
    );
    expect(outcome.action).toBe('ignored');
    expect(await messages()).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });

  it('L-07：同一 issue 连续两次 edited（文本相同、updated_at 不同）→ 2 条消息', async () => {
    const h = agentHarness(db);
    await deliver(
      h.deps,
      'issues',
      issuesPayload({
        action: 'edited',
        updatedAt: '2026-06-01T10:00:00Z',
        changes: { body: { from: 'a' } },
      }),
    );
    await deliver(
      h.deps,
      'issues',
      issuesPayload({
        action: 'edited',
        updatedAt: '2026-06-01T11:00:00Z',
        changes: { body: { from: 'b' } },
      }),
    );
    const rows = await messages();
    expect(rows).toHaveLength(2);
    // 同 issue 串行：第一条在跑，第二条排队（不是被丢掉，X-14）
    expect(rows.map((row) => row['status'])).toEqual(['running', 'queued']);
    expect(h.sent).toHaveLength(1);
  });

  it('同一 updated_at 的重复投递 → 只有 1 条消息（幂等单位是「一次内容变更」）', async () => {
    const h = agentHarness(db);
    const payload = issuesPayload({ action: 'edited', changes: { body: { from: 'a' } } });
    await deliver(h.deps, 'issues', payload);
    const second = await deliver(h.deps, 'issues', payload);
    expect(second.action).toBe('duplicate');
    expect(second.duplicate).toBe(true);
    expect(await messages()).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
  });
});

describe('E-04 / E-06 / E-07：不该投递的事件', () => {
  it('E-04：issues.reopened → 0 消息（永不回填，B-04）', async () => {
    const h = agentHarness(db);
    const outcome = await deliver(h.deps, 'issues', issuesPayload({ action: 'reopened' }));
    expect(outcome.action).toBe('ignored');
    expect(await messages()).toHaveLength(0);
  });

  it('E-06：labeled → 0 消息（避免 AI 自己打标后触发自己）', async () => {
    const h = agentHarness(db);
    const outcome = await deliver(h.deps, 'issues', issuesPayload({ action: 'labeled' }));
    expect(outcome.action).toBe('ignored');
    expect(await messages()).toHaveLength(0);
  });

  it('E-07：assigned / closed → 0 消息', async () => {
    const h = agentHarness(db);
    expect((await deliver(h.deps, 'issues', issuesPayload({ action: 'assigned' }))).action).toBe('ignored');
    expect((await deliver(h.deps, 'issues', issuesPayload({ action: 'closed' }))).action).toBe('ignored');
    expect(await messages()).toHaveLength(0);
  });
});

describe('E-08 / E-09：机器人账号', () => {
  it('E-08：sender.type = Bot → 0 消息', async () => {
    const h = agentHarness(db);
    const outcome = await deliver(
      h.deps,
      'issues',
      issuesPayload({ action: 'opened', sender: { login: 'pi-bot[bot]', type: 'Bot' } }),
    );
    expect(outcome.action).toBe('ignored');
    expect(await messages()).toHaveLength(0);
  });

  it('E-09：dependabot[bot] / renovate[bot] 各自 0 消息（哪怕 type 不是 Bot）', async () => {
    const h = agentHarness(db);
    for (const login of ['dependabot[bot]', 'renovate[bot]']) {
      const outcome = await deliver(
        h.deps,
        'issues',
        issuesPayload({ action: 'opened', sender: { login, type: 'User' } }),
      );
      expect(outcome.action).toBe('ignored');
    }
    expect(await messages()).toHaveLength(0);
  });
});

describe('CF-02 / CF-03：事件模板置空 = 不投递', () => {
  it('on_opened 为空串 → 新 issue 0 消息', async () => {
    await seedAgentRepo(db, { agent: { on_opened: '' } });
    const h = agentHarness(db, { skills: ['/format-check'] });
    const outcome = await deliver(h.deps, 'issues', issuesPayload({ action: 'opened' }));
    expect(outcome.action).toBe('ignored');
    expect(await messages()).toHaveLength(0);
  });

  it('on_opened 为 null → 同样 0 消息（不是投一条没技能的模板）', async () => {
    await seedAgentRepo(db, { agent: { on_opened: null } });
    const h = agentHarness(db, { skills: ['/format-check'] });
    await deliver(h.deps, 'issues', issuesPayload({ action: 'opened' }));
    expect(await messages()).toHaveLength(0);
  });

  it('on_edited 为空串 → 编辑 0 消息', async () => {
    await seedAgentRepo(db, { agent: { on_edited: '' } });
    const h = agentHarness(db);
    const outcome = await deliver(
      h.deps,
      'issues',
      issuesPayload({ action: 'edited', changes: { title: { from: '旧标题' } } }),
    );
    expect(outcome.action).toBe('ignored');
    expect(await messages()).toHaveLength(0);
  });
});

describe('issue_comment：mention 消息（E-05 的口径）', () => {
  it('@别名 → 1 条 mention 消息，正文是原话（摘掉 @）', async () => {
    const h = agentHarness(db);
    const outcome = await deliver(h.deps, 'issue_comment', commentPayload({ body: '@pi-bot 帮看下这个报错' }));
    expect(outcome.action).toBe('enqueued');
    const rows = await messages();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['kind']).toBe('mention');
    expect(rows[0]?.['comment_body']).toBe('帮看下这个报错');
    // bigint 列在 `pg` 里回来是字符串
    expect(Number(rows[0]?.['comment_id'])).toBe(555);
    expect(h.sent).toHaveLength(1);
    // 回执打在那条评论上
    expect(h.reactions).toEqual([{ repo: AGENT_REPO, issueNumber: 7, commentId: 555 }]);
  });

  it('没有 @ 别名 → 0 消息', async () => {
    const h = agentHarness(db);
    const outcome = await deliver(h.deps, 'issue_comment', commentPayload({ body: '随便说一句' }));
    expect(outcome.action).toBe('ignored');
    expect(await messages()).toHaveLength(0);
  });
});
