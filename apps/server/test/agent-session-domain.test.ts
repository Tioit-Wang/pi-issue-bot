/**
 * BR-5 会话域隔离：**同仓库、同编号、不同域是两个会话行，互不影响**。
 *
 * 为什么必须真库（`openTestDb()`）而不是假 `SqlRunner`：这条缺陷的根因在**主键**
 * （`migrations/0014_wp2_session_domain.sql` 把 `(repo, issue_number)` 换成
 * `(repo, domain, issue_number)`）。假实现按语句前缀返回固定行，正好会把
 * 「UPSERT 覆盖了另一域的行」这种错判成通过 —— 那正是要修的东西。
 *
 * 断言的是可观察事实（库里的行），不是函数返回值：
 *  - 同号不同域 → `agent_sessions` 有**两行**，各自的 `session_id` 互不相同；
 *  - issue 关单回收沙箱 → PR 那一行**保持** `active`（旧实现会把它一起标 `idle`）；
 *  - 首轮判据（FR-4.2）按域各算各的：PR 的第一句话仍是「首轮」。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { insertMessage, loadSession, saveSession } from '../src/agent/index.ts';
import { applyV21SessionOnEvent, v21IsFirstEventOf } from '../src/http/webhook-v21.ts';
import { resetAgentTables } from './helpers/agent-harness.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

const REPO = 'acme/widgets';
/** 同一个编号，分别属于 issue 域与 PR 域（GitHub 的编号序列是共用的）。 */
const NUMBER = 42;

let db: TestDb;

beforeAll(async () => {
  db = await openTestDb();
}, 60_000);

afterAll(async () => {
  await db?.close();
}, 60_000);

beforeEach(async () => {
  await resetAgentTables(db);
});

/** 直接读行：断言的是库里到底有几行、各是什么值。 */
async function sessionRows(): Promise<Array<Record<string, unknown>>> {
  return db.sql(
    'select repo, domain, issue_number, session_id, state, sandbox_id, turns from agent_sessions order by domain',
  );
}

describe('BR-5：issue 与 PR 各自独立会话', () => {
  it('同仓库同编号不同域 → 两行，各自的 session_id 不互相覆盖', async () => {
    await saveSession(
      db.pool,
      { repo: REPO, domain: 'issue', issueNumber: NUMBER },
      { sessionId: 'session-issue', cursor: 0, turns: 1, startedAt: null },
    );
    await saveSession(
      db.pool,
      { repo: REPO, domain: 'pr', issueNumber: NUMBER },
      { sessionId: 'session-pr', cursor: 0, turns: 1, startedAt: null },
    );

    const rows = await sessionRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row['domain'])).toEqual(['issue', 'pr']);
    expect(rows.map((row) => row['session_id'])).toEqual(['session-issue', 'session-pr']);

    // 点查也分开：多读一次确认不是「写了两行但读的是同一行」
    expect((await loadSession(db.pool, { repo: REPO, domain: 'issue', issueNumber: NUMBER }))?.sessionId).toBe(
      'session-issue',
    );
    expect((await loadSession(db.pool, { repo: REPO, domain: 'pr', issueNumber: NUMBER }))?.sessionId).toBe(
      'session-pr',
    );
  });

  it('UPSERT 只改自己那一域：写 PR 的 turns 不动 issue 的行', async () => {
    const key = (domain: 'issue' | 'pr') => ({ repo: REPO, domain, issueNumber: NUMBER });
    await saveSession(db.pool, key('issue'), { sessionId: 'session-issue', cursor: 3, turns: 5, startedAt: null });
    await saveSession(db.pool, key('pr'), { sessionId: 'session-pr', cursor: 0, turns: 1, startedAt: null });

    await saveSession(db.pool, key('pr'), { sessionId: 'session-pr', cursor: 7, turns: 2, startedAt: null });

    const rows = await sessionRows();
    expect(rows).toHaveLength(2);
    const issueRow = rows.find((row) => row['domain'] === 'issue');
    const prRow = rows.find((row) => row['domain'] === 'pr');
    // issue 那一行原样（游标 3 / 轮数 5 没被 PR 的写入覆盖）
    expect(Number(issueRow?.['turns'])).toBe(5);
    expect(issueRow?.['session_id']).toBe('session-issue');
    expect(Number(prRow?.['turns'])).toBe(2);
    expect(prRow?.['session_id']).toBe('session-pr');
  });

  it('issue 关单回收沙箱，PR 那一行不受影响（旧实现会一起标 idle）', async () => {
    await saveSession(
      db.pool,
      { repo: REPO, domain: 'issue', issueNumber: NUMBER },
      { sessionId: 'session-issue', cursor: 0, turns: 1, startedAt: null },
    );
    // 两域的运行状态都得先落成「活跃 + 有沙箱」：复用分支才会保持 active。
    await applyV21SessionOnEvent(db.pool, {
      repo: REPO,
      domain: 'issue',
      issueNumber: NUMBER,
      event: 'issues.edited',
      issueState: 'open',
      sandboxId: 'sbx-issue',
    });
    await applyV21SessionOnEvent(db.pool, {
      repo: REPO,
      domain: 'pr',
      issueNumber: NUMBER,
      event: 'issues.edited',
      issueState: 'open',
      sandboxId: 'sbx-pr',
    });

    const closed = await applyV21SessionOnEvent(db.pool, {
      repo: REPO,
      domain: 'issue',
      issueNumber: NUMBER,
      event: 'issues.closed',
      issueState: 'closed',
    });
    expect(closed.action).toBe('recycle-sandbox');

    const rows = await sessionRows();
    expect(rows).toHaveLength(2);
    const issueRow = rows.find((row) => row['domain'] === 'issue');
    const prRow = rows.find((row) => row['domain'] === 'pr');
    // issue 域被回收成 idle，PR 域仍是 active 且沙箱还在
    expect(issueRow?.['state']).toBe('idle');
    expect(issueRow?.['sandbox_id']).toBeNull();
    expect(prRow?.['state']).toBe('active');
    expect(prRow?.['sandbox_id']).toBe('sbx-pr');
  });

  it('首轮判据按域各算各的：issue 跑过一轮后，PR 的第一句话仍是首轮（FR-4.2）', async () => {
    const warn = (error: unknown): void => {
      throw error;
    };
    // 还没建会话：两域都算首轮
    expect(await v21IsFirstEventOf(db.pool, { repo: REPO, domain: 'issue', issueNumber: NUMBER }, warn)).toBe(true);
    expect(await v21IsFirstEventOf(db.pool, { repo: REPO, domain: 'pr', issueNumber: NUMBER }, warn)).toBe(true);

    // 只有 issue 域跑过一轮
    await saveSession(
      db.pool,
      { repo: REPO, domain: 'issue', issueNumber: NUMBER },
      { sessionId: 'session-issue', cursor: 1, turns: 1, startedAt: null },
    );

    expect(await v21IsFirstEventOf(db.pool, { repo: REPO, domain: 'issue', issueNumber: NUMBER }, warn)).toBe(false);
    // PR 域没有旧正文历史 → 必须仍然判成首轮（否则 PR 的第一句话只收到增量、缺全文）
    expect(await v21IsFirstEventOf(db.pool, { repo: REPO, domain: 'pr', issueNumber: NUMBER }, warn)).toBe(true);
  });

  it('域列取值面被库约束收口（只允许 issue / pr）', async () => {
    // 写一个越界域必须被 CHECK 拒绝：串域的代价是数据事故，不该只靠应用层约定。
    await expect(
      db.sql(
        'insert into agent_sessions (repo, domain, issue_number, session_id, cursor, turns, updated_at) values ($1, $2, $3, null, 0, 0, now())',
        [REPO, 'pull_request', NUMBER],
      ),
    ).rejects.toThrow(/agent_sessions_domain_check|violates check constraint/iu);
  });
});

describe('FR-3.1 残余：会话行不去污染消息行', () => {
  it('同号不同域的两条消息各占一行（消息层口径不变，会话层才分域）', async () => {
    /**
     * 本包只改「会话」这一层：`agent_messages` 的主键 `(repo, issue_number, fingerprint)`
     * 刻意保持不变（消息层没有域列，且它在别人的文件面里）。这条例钉住的是
     * **会话域隔离没有顺手改坏消息去重**：两条不同内容的消息仍是两行。
     */
    const first = await insertMessage(db.pool, {
      key: { repo: REPO, issueNumber: NUMBER, fingerprint: 'fp-issue' },
      kind: 'mention',
      commentId: 9001,
      body: 'issue 侧的一句话',
      actorLogin: 'alice',
    });
    const second = await insertMessage(db.pool, {
      key: { repo: REPO, issueNumber: NUMBER, fingerprint: 'fp-pr' },
      kind: 'mention',
      commentId: 9002,
      body: 'PR 侧的一句话',
      actorLogin: 'alice',
    });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(true);

    const messages = await db.sql(
      'select fingerprint from agent_messages where repo = $1 and issue_number = $2 order by fingerprint',
      [REPO, NUMBER],
    );
    expect(messages.map((row) => row['fingerprint'])).toEqual(['fp-issue', 'fp-pr']);
    // 会话行一条都没被这条路径创建：消息去重与会话生命周期是两件事
    expect(await sessionRows()).toHaveLength(0);
  });
});
