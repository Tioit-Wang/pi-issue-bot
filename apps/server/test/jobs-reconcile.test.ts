/**
 * `jobs/reconcile-reverts` 的**真库**测试（tech-plan §7.5 第 4 条）。
 *
 * 三个已应用的 action + 一个「看起来像改回但其实不是」的 action，用假 `GithubClient`
 * 分别返回「标签被删」「人提交 changes-requested」「PR 已关闭且未合并」「一切正常 + 只有机器人
 * 提了 changes-requested」，断言：
 *  1. 前三个的 `reverted_at` 都被置位且 `revert_kind` 精确匹配；
 *  2. 第四个**不置位**（机器人的 review 不算「被人改回」）；
 *  3. `push_branch` 的 target 形如 `owner/name#branch` → 记为 skipped，不会瞎猜；
 *  4. 再跑一次：已置位的不重复处理（`reverted_at` 时间戳不变）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { GithubClient, ResponseLike } from '../src/github/index.ts';
import { reconcileReverts } from '../src/jobs/index.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

/** 对账时刻：所有 action 的 `applied_at` 都落在 7 天窗口内。 */
const NOW = Date.parse('2026-06-01T12:00:00.000Z');

const ROUTES: Readonly<Record<string, unknown>> = Object.freeze({
  // 1) 标签被摘掉：issue 上已经没有 needs-info
  'GET /repos/acme/widgets/issues/12': { state: 'open', labels: [] },
  // 2) 人提交了 changes-requested
  'GET /repos/acme/widgets/issues/34': { state: 'open', labels: [], pull_request: { url: 'pr/34' } },
  'GET /repos/acme/widgets/pulls/34': { state: 'open', merged: false, merged_at: null, closed_at: null },
  'GET /repos/acme/widgets/pulls/34/reviews': [
    { state: 'CHANGES_REQUESTED', submitted_at: '2026-06-01T02:00:00Z', user: { login: 'alice', type: 'User' } },
  ],
  // 3) PR 已关闭且未合并
  'GET /repos/other/lib/issues/7': { state: 'closed', labels: [], pull_request: { url: 'pr/7' } },
  'GET /repos/other/lib/pulls/7': { state: 'closed', merged: false, merged_at: null, closed_at: '2026-06-01T03:00:00Z' },
  // 4) 标签还在 + 只有机器人提了 changes-requested → 不应置位
  'GET /repos/other/lib/issues/9': { state: 'open', labels: [{ name: 'bug' }], pull_request: { url: 'pr/9' } },
  'GET /repos/other/lib/pulls/9': { state: 'open', merged: false, merged_at: null, closed_at: null },
  'GET /repos/other/lib/pulls/9/reviews': [
    { state: 'CHANGES_REQUESTED', submitted_at: '2026-06-01T05:00:00Z', user: { login: 'pi-bot[bot]', type: 'Bot' } },
  ],
});

let db: TestDb;
const clock = (): number => NOW;

type FakeGithub = { github: Pick<GithubClient, 'request'>; calls: string[] };

/** 按完整 route 字符串命中的假客户端；未登记的 route 直接抛，防止测试悄悄错位。 */
function createFakeGithub(routes: Readonly<Record<string, unknown>> = ROUTES): FakeGithub {
  const calls: string[] = [];
  const request = async <T = unknown>(route: string): Promise<ResponseLike<T>> => {
    calls.push(route);
    if (!(route in routes)) {
      throw new Error(`假 GithubClient 没有登记这条 route：${route}`);
    }
    return { status: 200, headers: {}, data: routes[route] as T };
  };
  return { github: { request }, calls };
}

async function seed(): Promise<void> {
  await db.pool.query(`
    insert into tasks (id, source, repo, target_kind, target_number, command, actor_login, idempotency_key, status)
    values
      ('t1', 'command', 'acme/widgets', 'pr',  12, '/review-pr',      'alice', 'recon-k1', 'succeeded'),
      ('t2', 'command', 'acme/widgets', 'pr',  34, '/review-pr',      'bob',   'recon-k2', 'succeeded'),
      ('t3', 'command', 'other/lib',    'pr',   7, '/review-pr',      'carol', 'recon-k3', 'succeeded'),
      ('t4', 'command', 'other/lib',    'pr',   9, '/issue-triage',   'dave',  'recon-k4', 'succeeded')
  `);

  await db.pool.query(`
    insert into runs (id, task_id, attempt, started_at, ended_at, outcome)
    values
      ('r1', 't1', 1, '2026-06-01T00:59:00Z', '2026-06-01T01:00:00Z', 'succeeded'),
      ('r2', 't2', 1, '2026-06-01T01:09:00Z', '2026-06-01T01:10:00Z', 'succeeded'),
      ('r3', 't3', 1, '2026-06-01T01:19:00Z', '2026-06-01T01:20:00Z', 'succeeded'),
      ('r4', 't4', 1, '2026-06-01T01:29:00Z', '2026-06-01T01:30:00Z', 'succeeded')
  `);

  // intent 依次是：label / comment / open_pr / label / push_branch
  await db.pool.query(`
    insert into actions (run_id, intent, target, external_ref, applied_at, audit)
    values
      ('r1', 'label',       'acme/widgets#12', 'needs-info', '2026-06-01T01:00:00Z', '{"status":"applied"}'::jsonb),
      ('r2', 'comment',     'acme/widgets#34', '9001',       '2026-06-01T01:10:00Z', '{"status":"applied"}'::jsonb),
      ('r3', 'open_pr',     'other/lib#7',     null,         '2026-06-01T01:20:00Z', '{"status":"applied"}'::jsonb),
      ('r4', 'label',       'other/lib#9',     'bug',        '2026-06-01T01:30:00Z', '{"status":"applied"}'::jsonb),
      ('r3', 'push_branch', 'other/lib#branch', 'pi-bot/fix', '2026-06-01T01:40:00Z', '{"status":"applied"}'::jsonb)
  `);
}

async function readActions(): Promise<
  { id: string; target: string; revert_kind: string | null; reverted_at: string | null; audit: unknown }[]
> {
  const result = await db.pool.query(
    `select id::text as id, target, revert_kind, reverted_at::text as reverted_at, audit
       from actions order by id`,
  );
  return result.rows as { id: string; target: string; revert_kind: string | null; reverted_at: string | null; audit: unknown }[];
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

describe('jobs/reconcile-reverts（PG + 假 GithubClient）', () => {
  it('三类反查分别置位 label-removed / changes-requested / pr-closed', async () => {
    const { github, calls } = createFakeGithub();
    const result = await reconcileReverts({ pool: db.pool, github, clock });

    expect(result.stats.checked).toBe(4);
    expect(result.stats.reverted).toBe(3);
    expect(result.stats.skipped).toBe(1);
    expect(result.stats.windowDays).toBe(7);
    expect(result.stats.byKind).toEqual({ 'label-removed': 1, 'changes-requested': 1, 'pr-closed': 1 });

    const rows = await readActions();
    const byTarget = new Map(rows.map((row) => [row.target, row]));
    expect(byTarget.get('acme/widgets#12')?.revert_kind).toBe('label-removed');
    expect(byTarget.get('acme/widgets#34')?.revert_kind).toBe('changes-requested');
    expect(byTarget.get('other/lib#7')?.revert_kind).toBe('pr-closed');
    // 标签还在 + 只有机器人 review：不置位
    expect(byTarget.get('other/lib#9')?.revert_kind).toBeNull();
    expect(byTarget.get('other/lib#9')?.reverted_at).toBeNull();
    // push_branch 的 target 不可解析：不置位（也不该去查 GitHub）
    expect(byTarget.get('other/lib#branch')?.revert_kind).toBeNull();
    expect(calls.some((route) => route.includes('#branch'))).toBe(false);

    // 置位时把证据写进 audit，便于面板/审计追溯
    const audit = byTarget.get('other/lib#7')?.audit as { reconcile?: { revertKind?: string; evidence?: unknown } };
    expect(audit.reconcile?.revertKind).toBe('pr-closed');
    expect(audit.reconcile?.evidence).toEqual({ state: 'closed', merged: false, closedAt: '2026-06-01T03:00:00Z' });
  });

  it('再跑一次：已置位的不重复处理，时间戳不变', async () => {
    const fake = createFakeGithub();
    await reconcileReverts({ pool: db.pool, github: fake.github, clock });
    const afterFirst = await readActions();
    expect(afterFirst.filter((row) => row.revert_kind !== null)).toHaveLength(3);

    const second = await reconcileReverts({ pool: db.pool, github: fake.github, clock });
    // 只剩「标签还在但没改回」的那条会被再查一次，外加 push_branch 的跳过
    expect(second.stats.checked).toBe(1);
    expect(second.stats.reverted).toBe(0);
    expect(second.stats.skipped).toBe(1);
    expect(await readActions()).toEqual(afterFirst);
  });

  it('dry-run：重查并报告命中，但一行都不写库', async () => {
    const { github } = createFakeGithub();
    const result = await reconcileReverts({ pool: db.pool, github, clock }, { dryRun: true });

    expect(result.stats.checked).toBe(4);
    expect(result.stats.reverted).toBe(0);
    expect(result.stats.byKind).toEqual({ 'label-removed': 1, 'changes-requested': 1, 'pr-closed': 1 });
    const rows = await readActions();
    expect(rows.every((row) => row.reverted_at === null && row.revert_kind === null)).toBe(true);
  });

  it('窗口外的 action 不参与对账（默认 7 天）', async () => {
    await db.pool.query(
      `insert into tasks (id, source, repo, target_kind, target_number, command, actor_login, idempotency_key)
       values ('t-old', 'command', 'acme/widgets', 'pr', 99, '/review-pr', 'erin', 'recon-k5')`,
    );
    await db.pool.query(
      `insert into runs (id, task_id, attempt, started_at, ended_at, outcome)
       values ('r-old', 't-old', 1, '2026-05-20T00:00:00Z', '2026-05-20T00:01:00Z', 'succeeded')`,
    );
    await db.pool.query(
      `insert into actions (run_id, intent, target, external_ref, applied_at, audit)
       values ('r-old', 'label', 'acme/widgets#99', 'needs-info', '2026-05-20T00:01:00Z', '{"status":"applied"}'::jsonb)`,
    );

    const { github } = createFakeGithub();
    const result = await reconcileReverts({ pool: db.pool, github, clock });
    expect(result.stats.checked).toBe(4);
    expect(result.stats.reverted).toBe(3);

    const oldRows = await db.pool.query(
      "select revert_kind from actions where target = 'acme/widgets#99'",
    );
    expect((oldRows.rows[0] as { revert_kind: string | null }).revert_kind).toBeNull();
  });

  it('GitHub 出错只记 skipped，不影响同一轮其它 action', async () => {
    const failing: Pick<GithubClient, 'request'> = {
      request: async () => {
        throw new Error('502 Bad Gateway');
      },
    };
    const result = await reconcileReverts({ pool: db.pool, github: failing, clock });
    expect(result.stats.reverted).toBe(0);
    expect(result.stats.skipped).toBe(5);
    expect(result.stats.checked).toBe(0);
  });

  it('入参自检：windowDays / limit 必须是正整数', async () => {
    const { github } = createFakeGithub();
    await expect(reconcileReverts({ pool: db.pool, github, clock }, { windowDays: 0 })).rejects.toThrow(/正整数/);
    await expect(reconcileReverts({ pool: db.pool, github, clock }, { limit: -1 })).rejects.toThrow(/正整数/);
  });
});
