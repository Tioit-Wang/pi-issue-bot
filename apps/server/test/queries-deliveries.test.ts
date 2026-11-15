/**
 * `/api/repos/{owner}/{name}/deliveries` 的留痕读路径（BR-6 / FR-6.4③）。
 *
 * 需求（`docs/requirements.html:1791`）：「未通过开关或闸门的事件，必须记录判定结果与原因，
 * **可在后台查询**」。写入侧早就完整（`http/webhook-v21.ts::writeV21Decision`），
 * 本文件钉的是**读**：未触发的投递能查出来、原因正确、验签失败也在、分页与时间窗生效，
 * 且返回值能通过契约 `deliveriesResponseSchema.parse()`。
 *
 * 用真 PostgreSQL（`helpers/queries-db.ts` 建库 + advisory lock），种子在本文件内自己插：
 * 共享的 `seedStandard` 里的 `webhook_deliveries` 行没有 `repo` / `decision`，改它会影响别人。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deliveriesResponseSchema } from '../../../packages/contract/src/index.ts';
import { createNullLogger } from '../../../packages/shared/src/index.ts';
import { buildServer, createAllowAllAuth } from '../src/http/index.ts';
import type { ZodFastify } from '../src/http/index.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

/** 测试时钟（`received_at` 与「最近 24h」都相对它摆位）。 */
const FIXED_NOW = new Date('2026-06-01T12:00:00.000Z');
const REPO = 'acme/widgets';
const OTHER_REPO = 'other/lib';

let db: TestDb;
let app: ZodFastify;

/**
 * 本文件自己的投递种子（窗口内 6 行 + 窗口外 1 行）。
 *
 * `received_at` 全部落在 `2026-05-31T12:00Z ~ 2026-06-01T12:00Z` 内，只有 `v-old` 在窗口外，
 * 断言里出现的顺序全部按 `received_at desc, delivery_id desc` 手算好。
 */
async function seedDeliveries(): Promise<void> {
  await db.pool.query(`
    insert into webhook_deliveries
      (delivery_id, event, action, repo, payload, signature_valid, decision, decision_reason, received_at)
    values
      ('v-pr',        'pull_request', 'opened',  '${REPO}',       '{}'::jsonb, true,  'ignored',   'pr-ignored',        '2026-06-01T06:00:00Z'),
      ('v-pending',   'issues',       'edited',  '${REPO}',       '{}'::jsonb, true,  null,        null,                '2026-06-01T05:00:00Z'),
      ('v-sig-bad',   'issues',       'opened',  '${REPO}',       '{}'::jsonb, false, 'ignored',   'signature-invalid', '2026-06-01T04:00:00Z'),
      ('v-triggered', 'issues',       'opened',  '${REPO}',       '{}'::jsonb, true,  'triggered', 'enabled',           '2026-06-01T03:00:00Z'),
      ('v-switch-off','issues',       'labeled', '${REPO}',       '{}'::jsonb, true,  'ignored',   'switch-off',        '2026-06-01T02:00:00Z'),
      ('v-unmentioned','issues',      'opened',  '${REPO}',       '{}'::jsonb, true,  'ignored',   'not-mentioned',     '2026-06-01T01:00:00Z'),
      ('v-old',       'issues',       'opened',  '${REPO}',       '{}'::jsonb, true,  'ignored',   'body-unchanged',    '2026-05-20T00:00:00Z'),
      ('v-other',     'issues',       'opened',  '${OTHER_REPO}', '{}'::jsonb, true,  'ignored',   'repo-disabled',     '2026-06-01T02:30:00Z'),
      ('v-unknown',   'issues',       'opened',  null,            '{}'::jsonb, true,  'ignored',   'repo-disabled',     '2026-06-01T02:40:00Z')
  `);
}

beforeAll(async () => {
  db = await openTestDb(FIXED_NOW);
  app = buildServer({
    logger: createNullLogger(),
    pool: db.pool,
    queries: db.queries,
    requireAuth: createAllowAllAuth('tester'),
    webhook: {
      verify: async () => true,
      db: db.pool,
      enqueue: async () => null,
      ack: { addEyesReaction: async () => undefined },
      logger: createNullLogger(),
      now: () => FIXED_NOW,
    },
    appVersion: 'test',
    now: () => FIXED_NOW,
  });
});

afterAll(async () => {
  await app.close();
  await db.truncate();
  await db.close();
});

beforeEach(async () => {
  await db.truncate();
  await seedDeliveries();
});

describe('queries/deliveries（真库）', () => {
  it('★ 未触发的投递也查得到，且 decisionReason 是判定时写下的原因', async () => {
    const response = await db.queries.deliveries({ repo: REPO }, {});
    expect(() => deliveriesResponseSchema.parse(response)).not.toThrow();

    // 窗口内 6 行（v-old 在 24h 之外），按 received_at 倒序
    expect(response.items.map((item) => item.deliveryId)).toEqual([
      'v-pr',
      'v-pending',
      'v-sig-bad',
      'v-triggered',
      'v-switch-off',
      'v-unmentioned',
    ]);

    const switchOff = response.items.find((item) => item.deliveryId === 'v-switch-off');
    expect(switchOff).toMatchObject({
      event: 'issues',
      action: 'labeled',
      repo: REPO,
      receivedAt: '2026-06-01T02:00:00.000Z',
      decision: 'ignored',
      decisionReason: 'switch-off',
      signatureValid: true,
    });

    const mentioned = response.items.find((item) => item.deliveryId === 'v-unmentioned');
    expect(mentioned?.decision).toBe('ignored');
    expect(mentioned?.decisionReason).toBe('not-mentioned');

    // 触发侧也留原因（enabled），面板时间线的「判定」一段不会空白
    const triggered = response.items.find((item) => item.deliveryId === 'v-triggered');
    expect(triggered).toMatchObject({ decision: 'triggered', decisionReason: 'enabled' });

    // 还没判定的投递：decision / decisionReason 都是 null（与「判定为忽略」可区分）
    const pending = response.items.find((item) => item.deliveryId === 'v-pending');
    expect(pending).toMatchObject({ decision: null, decisionReason: null });
  });

  it('★ 验签失败的投递同样查得到（signatureValid=false + signature-invalid）', async () => {
    const response = await db.queries.deliveries({ repo: REPO }, {});
    const bad = response.items.find((item) => item.deliveryId === 'v-sig-bad');
    expect(bad).toMatchObject({
      decision: 'ignored',
      decisionReason: 'signature-invalid',
      signatureValid: false,
    });
  });

  it('仓库隔离：只看该仓库，别的仓库与「未知仓库」的投递不串台', async () => {
    const mine = await db.queries.deliveries({ repo: REPO }, {});
    expect(mine.items.every((item) => item.repo === REPO)).toBe(true);

    const other = await db.queries.deliveries({ repo: OTHER_REPO }, {});
    expect(other.items.map((item) => item.deliveryId)).toEqual(['v-other']);
    expect(other.items[0]).toMatchObject({ decisionReason: 'repo-disabled', signatureValid: true });

    // `repo is null` 的投递（载荷里没有仓库）不属于任何仓库的列表
    const ids = mine.items.map((item) => item.deliveryId);
    expect(ids).not.toContain('v-unknown');
  });

  it('时间窗过滤：窗口内的留下，窗口外的（v-old）不出现；放大窗口才看得到', async () => {
    // 左闭右开钉死在「恰好等于 from / to」这两行上：种子里的 02:00 / 03:00 / 05:00
    // 都不在边界，用它们做窗口改坏了实现照样绿（审查报告 低-1）。
    const atFrom = await db.queries.deliveries(
      { repo: REPO },
      // from 恰好 = v-switch-off 的 02:00 → 必须命中
      { from: '2026-06-01T02:00:00Z', to: '2026-06-01T04:00:00Z' },
    );
    expect(atFrom.items.map((item) => item.deliveryId)).toEqual(['v-triggered', 'v-switch-off']);

    const atTo = await db.queries.deliveries(
      { repo: REPO },
      // to 恰好 = v-switch-off 的 02:00 → 必须不命中
      { from: '2026-06-01T01:00:00Z', to: '2026-06-01T02:00:00Z' },
    );
    expect(atTo.items.map((item) => item.deliveryId)).toEqual(['v-unmentioned']);

    const narrow = await db.queries.deliveries(
      { repo: REPO },
      { from: '2026-06-01T01:30:00Z', to: '2026-06-01T03:30:00Z' },
    );
    expect(narrow.items.map((item) => item.deliveryId)).toEqual(['v-triggered', 'v-switch-off']);

    const wide = await db.queries.deliveries(
      { repo: REPO },
      { from: '2026-05-01T00:00:00Z', to: FIXED_NOW.toISOString() },
    );
    expect(wide.items.map((item) => item.deliveryId)).toContain('v-old');
    expect(wide.items).toHaveLength(7);
  });

  it('契约外判定值：收敛成未判定，且 pending 筛选也能定位到（不让它变成黑户）', async () => {
    // `decision` 列是裸 text 无 CHECK（db/schema.ts:112）。手工修库 / 未来新取值都可能写进来。
    // 它必须**只表现为「未判定」**这一种口径：列表里显示未判定，`decision=pending` 也能筛到。
    // 若过滤写裸列而 SELECT 写 case，这一行会「屏幕上有一行、三种筛选都查不到」。
    await db.pool.query(`
      insert into webhook_deliveries
        (delivery_id, event, action, repo, payload, signature_valid, decision, decision_reason, received_at)
      values ('v-weird', 'issues', 'opened', '${REPO}', '{}'::jsonb, true, 'error', 'something-new',
              '2026-06-01T07:00:00Z')
    `);

    const all = await db.queries.deliveries({ repo: REPO }, {});
    const weird = all.items.find((item) => item.deliveryId === 'v-weird');
    // 取值被收敛，但原因原样保留 —— 排查时还看得见真实值
    expect(weird).toMatchObject({ decision: null, decisionReason: 'something-new' });

    const pending = await db.queries.deliveries({ repo: REPO }, { decision: 'pending' });
    expect(pending.items.map((item) => item.deliveryId).sort()).toEqual(['v-pending', 'v-weird']);

    // 反向：它不能出现在 triggered / ignored 里
    const ignored = await db.queries.deliveries({ repo: REPO }, { decision: 'ignored' });
    expect(ignored.items.map((item) => item.deliveryId)).not.toContain('v-weird');
    const triggered = await db.queries.deliveries({ repo: REPO }, { decision: 'triggered' });
    expect(triggered.items.map((item) => item.deliveryId)).not.toContain('v-weird');
  });

  it('分页：limit=2 逐页取完，不重不漏，末页 hasMore=false 且 nextCursor=null', async () => {
    const first = await db.queries.deliveries({ repo: REPO }, { limit: 2 });
    expect(first.items.map((item) => item.deliveryId)).toEqual(['v-pr', 'v-pending']);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = await db.queries.deliveries(
      { repo: REPO },
      { limit: 2, ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }) },
    );
    expect(second.items.map((item) => item.deliveryId)).toEqual(['v-sig-bad', 'v-triggered']);
    expect(second.hasMore).toBe(true);

    const third = await db.queries.deliveries(
      { repo: REPO },
      { limit: 2, ...(second.nextCursor === null ? {} : { cursor: second.nextCursor }) },
    );
    expect(third.items.map((item) => item.deliveryId)).toEqual(['v-switch-off', 'v-unmentioned']);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeNull();

    // 三页拼起来正好是全集（keyset 不会漏行也不会重行）
    const ids = [...first.items, ...second.items, ...third.items].map((item) => item.deliveryId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('筛选：decision=triggered / ignored / pending 与 event 各自收窄', async () => {
    const triggered = await db.queries.deliveries({ repo: REPO }, { decision: 'triggered' });
    expect(triggered.items.map((item) => item.deliveryId)).toEqual(['v-triggered']);

    const ignored = await db.queries.deliveries({ repo: REPO }, { decision: 'ignored' });
    expect(ignored.items.map((item) => item.deliveryId)).toEqual([
      'v-pr',
      'v-sig-bad',
      'v-switch-off',
      'v-unmentioned',
    ]);

    // pending = decision is null（还没判定），不能把「判定为忽略」混进来
    const pending = await db.queries.deliveries({ repo: REPO }, { decision: 'pending' });
    expect(pending.items.map((item) => item.deliveryId)).toEqual(['v-pending']);

    const prs = await db.queries.deliveries({ repo: REPO }, { event: 'pull_request' });
    expect(prs.items.map((item) => item.deliveryId)).toEqual(['v-pr']);
  });

  it('from 晚于 to → 422（QueryError code=unprocessable，与 /api/audit 同口径）', () => {
    // 与 `audit` 一致：时间窗在 `createQueries` 里同步补齐，越界直接抛（http 层映射 422）
    const run = (): unknown =>
      db.queries.deliveries(
        { repo: REPO },
        { from: '2026-06-02T00:00:00Z', to: '2026-06-01T00:00:00Z' },
      );
    expect(run).toThrowError(/from 不能晚于 to/u);
    expect(run).toThrowError(expect.objectContaining({ code: 'unprocessable' }));
  });
});

describe('GET /api/repos/:owner/:name/deliveries', () => {
  it('★ 200 + 契约形状：未触发的投递带原因返回', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/repos/${REPO}/deliveries?from=2026-05-31T12:00:00Z&to=2026-06-01T12:00:00Z`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');

    const parsed = deliveriesResponseSchema.parse(response.json());
    expect(parsed.items).toHaveLength(6);
    expect(parsed.items[0]).toMatchObject({ deliveryId: 'v-pr', decisionReason: 'pr-ignored' });
    expect(parsed.hasMore).toBe(false);
    expect(parsed.nextCursor).toBeNull();
  });

  it('查询参数透传：decision=ignored&limit=2 生效', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/repos/${REPO}/deliveries?decision=ignored&limit=2&from=2026-05-31T12:00:00Z&to=2026-06-01T12:00:00Z`,
    });
    expect(response.statusCode).toBe(200);
    const parsed = deliveriesResponseSchema.parse(response.json());
    expect(parsed.items.map((item) => item.deliveryId)).toEqual(['v-pr', 'v-sig-bad']);
    expect(parsed.hasMore).toBe(true);
  });

  it('非法 limit → 400 bad-request；from > to → 422 unprocessable', async () => {
    const badLimit = await app.inject({
      method: 'GET',
      url: `/api/repos/${REPO}/deliveries?limit=0`,
    });
    expect(badLimit.statusCode).toBe(400);
    expect((badLimit.json() as { error: { code: string } }).error.code).toBe('bad-request');

    const badWindow = await app.inject({
      method: 'GET',
      url: `/api/repos/${REPO}/deliveries?from=2026-06-02T00:00:00Z&to=2026-06-01T00:00:00Z`,
    });
    expect(badWindow.statusCode).toBe(422);
    expect((badWindow.json() as { error: { code: string } }).error.code).toBe('unprocessable');
  });

  it('没有投递的仓库返回空列表（不是 404：查不到 ≠ 查不了）', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/repos/nobody/nothing/deliveries' });
    expect(response.statusCode).toBe(200);
    expect(deliveriesResponseSchema.parse(response.json())).toMatchObject({
      items: [],
      hasMore: false,
      nextCursor: null,
    });
  });
});
