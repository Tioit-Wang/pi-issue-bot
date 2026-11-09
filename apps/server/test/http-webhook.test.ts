/**
 * webhook 管线（`http/webhook.ts`）的测试 —— **真 PostgreSQL**（dev-plan §13.1/§13.4 第 5 条）。
 *
 * 覆盖任务书点名的七件事：
 *  1. 验签失败 → 401，且落一条 `signature_valid=false` 的审计行
 *  2. 同一 `X-GitHub-Delivery` 重复 20 次 → `webhook_deliveries` 1 行、`tasks` 1 行、入队 1 次
 *  3. 非白名单事件 → 200 但不建任务
 *  4. **10 秒应答在 handler 内**：reaction 在 `boss.send` 之后、且在 handler 返回之前发生
 *  5. dry-run 仓库 → 不产生任何 GitHub 写动作（reaction 一次都不调）
 *  6. `replay` 强制 dry-run（投递行已存在，仍只入队不写）
 *  7. 仓库开关 / 命令门禁 / 任务级幂等
 *
 * 幂等的断言只看**行数与调用次数**，不看时间戳：时间戳由注入时钟固定，行数不会骗人。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseRepoConfig } from '../../../packages/contract/src/index.ts';
import { createNullLogger } from '../../../packages/shared/src/index.ts';
import {
  checkCommandGate,
  decideWebhookTask,
  extractCommand,
  handleWebhook,
  idempotencyKeyFor,
  issueVersionHash,
  replayDelivery,
} from '../src/http/index.ts';
import type { WebhookAck, WebhookDeps } from '../src/http/index.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

const REPO = 'acme/widgets';
const FIXED_NOW = new Date('2026-06-01T12:00:00.000Z');

let db: TestDb;

beforeAll(async () => {
  db = await openTestDb(FIXED_NOW);
});

afterAll(async () => {
  await db.close();
});

/**
 * 每个用例前只清**本切片会写**的表。
 *
 * 为什么不用 `db.truncate()`（清全部业务表）：真库是多个测试文件共用的，
 * 而并行 session 里有文件不走 advisory lock（例如 `runtime-credentials-pg.test.ts` 只碰
 * `host_credentials`）。清全库会把别人的行擦掉，制造「有时红有时绿」。
 */
async function resetTables(): Promise<void> {
  await db.pool.query('truncate table tasks, webhook_deliveries, repos, runtime_flags cascade');
}

beforeEach(async () => {
  await resetTables();
});

/** 让仓库「开机」：写一行 `repos`，`dry_run` 由用例决定。 */
async function enableRepo(options: { readonly dryRun: boolean; readonly enabled?: boolean; readonly config?: unknown }): Promise<void> {
  await db.pool.query(
    `insert into repos (repo_full_name, enabled, dry_run, config, config_valid)
     values ($1, $2, $3, $4::jsonb, true)`,
    [REPO, options.enabled ?? true, options.dryRun, JSON.stringify(options.config ?? { version: 1 })],
  );
}

type Harness = {
  readonly deps: WebhookDeps;
  /** 调用顺序："enqueue" / "reaction" / "comment"，用来断言「应答在 handler 内」。 */
  readonly events: string[];
  readonly sends: Array<Record<string, unknown>>;
  readonly reactions: Array<Record<string, unknown>>;
  readonly comments: Array<Record<string, unknown>>;
};

function harness(options: { readonly verify?: boolean } = {}): Harness {
  const events: string[] = [];
  const sends: Array<Record<string, unknown>> = [];
  const reactions: Array<Record<string, unknown>> = [];
  const comments: Array<Record<string, unknown>> = [];
  const ack: WebhookAck = {
    addEyesReaction: async (input) => {
      events.push('reaction');
      reactions.push({ ...input });
    },
    postAckComment: async (input) => {
      events.push('comment');
      comments.push({ ...input });
    },
  };
  return {
    events,
    sends,
    reactions,
    comments,
    deps: {
      // 验签成功只看签名串：默认 "good-signature"，其余一律失败
      verify: async (input) => (options.verify ?? true) && input.signature === 'good-signature',
      db: db.pool,
      enqueue: async (data) => {
        events.push('enqueue');
        sends.push({ ...data });
        return 'job-1';
      },
      ack,
      logger: createNullLogger(),
      now: () => FIXED_NOW,
    },
  };
}

function issueOpenedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'opened',
    repository: { full_name: REPO },
    sender: { login: 'alice', type: 'User' },
    issue: {
      number: 7,
      updated_at: '2026-05-31T00:00:00Z',
      author_association: 'OWNER',
      ...overrides,
    },
  };
}

function commandPayload(): Record<string, unknown> {
  return {
    action: 'created',
    repository: { full_name: REPO },
    sender: { login: 'alice', type: 'User' },
    issue: { number: 12, pull_request: { url: 'https://example.invalid/pr/12' } },
    comment: {
      id: 555,
      body: '@pi-bot /review-pr 看一下这个改动',
      author_association: 'MEMBER',
      user: { login: 'alice', type: 'User' },
    },
  };
}

async function countRows(table: 'webhook_deliveries' | 'tasks'): Promise<number> {
  const rows = await db.sql(`select count(*)::int as n from ${table}`);
  return Number(rows[0]?.['n'] ?? 0);
}

describe('webhook 九步管线（真 PG）', () => {
  it('验签失败：401 + 落审计行（signature_valid=false）+ 不入队', async () => {
    await enableRepo({ dryRun: false });
    const h = harness({ verify: false });
    const result = await handleWebhook(h.deps, {
      deliveryId: 'dlv-bad-sig',
      event: 'issues',
      rawBody: JSON.stringify(issueOpenedPayload()),
      signature: 'sha256=deadbeef',
      source: 'live',
    });

    expect(result.status).toBe(401);
    expect((result.body as { error: { code: string } }).error.code).toBe('unauthorized');

    const rows = await db.sql(
      'select delivery_id, signature_valid, event, action from webhook_deliveries where delivery_id = $1',
      ['dlv-bad-sig'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['signature_valid']).toBe(false);
    expect(rows[0]?.['event']).toBe('issues');
    expect(rows[0]?.['action']).toBe('opened');
    expect(await countRows('tasks')).toBe(0);
    expect(h.sends).toHaveLength(0);
  });

  it('缺签名头：401 且不写任何行', async () => {
    await enableRepo({ dryRun: false });
    const h = harness();
    const result = await handleWebhook(h.deps, {
      deliveryId: 'dlv-no-sig',
      event: 'issues',
      rawBody: JSON.stringify(issueOpenedPayload()),
      signature: null,
      source: 'live',
    });
    expect(result.status).toBe(401);
    expect(await countRows('webhook_deliveries')).toBe(0);
  });

  it('同一 delivery 重投 20 次：投递 1 行、任务 1 行、入队 1 次', async () => {
    await enableRepo({ dryRun: false });
    const h = harness();
    const rawBody = JSON.stringify(issueOpenedPayload());
    const results = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      results.push(
        await handleWebhook(h.deps, {
          deliveryId: 'dlv-dup',
          event: 'issues',
          rawBody,
          signature: 'good-signature',
          source: 'live',
        }),
      );
    }

    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(await countRows('webhook_deliveries')).toBe(1);
    expect(await countRows('tasks')).toBe(1);
    expect(h.sends).toHaveLength(1);
    // 第 1 次是 enqueued，其余 19 次都是 duplicate
    expect(results[0]?.body).toMatchObject({ action: 'enqueued', duplicate: false });
    expect(results.slice(1).every((result) => (result.body as { duplicate: boolean }).duplicate)).toBe(true);
  });

  it('非白名单事件（pull_request.opened）：200 ignored 且不建任务', async () => {
    await enableRepo({ dryRun: false });
    const h = harness();
    const result = await handleWebhook(h.deps, {
      deliveryId: 'dlv-pr',
      event: 'pull_request',
      rawBody: JSON.stringify({
        action: 'opened',
        repository: { full_name: REPO },
        sender: { login: 'alice', type: 'User' },
        pull_request: { number: 3 },
      }),
      signature: 'good-signature',
      source: 'live',
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ action: 'ignored', taskId: null, duplicate: false });
    expect(await countRows('tasks')).toBe(0);
    expect(h.sends).toHaveLength(0);
    // 投递本身仍要落库（审计）
    expect(await countRows('webhook_deliveries')).toBe(1);
  });

  it('★ 10 秒应答在 handler 内：reaction 在入队之后、handler 返回之前完成', async () => {
    await enableRepo({ dryRun: false });
    const h = harness();
    const result = await handleWebhook(h.deps, {
      deliveryId: 'dlv-ack',
      event: 'issues',
      rawBody: JSON.stringify(issueOpenedPayload()),
      signature: 'good-signature',
      source: 'live',
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ action: 'enqueued' });
    // 顺序：入队 → 打 reaction；两者都在 await 返回之前（handler 内），不经过 worker
    expect(h.events).toEqual(['enqueue', 'reaction']);
    expect(h.reactions).toEqual([{ repo: REPO, issueNumber: 7 }]);
    expect(result.elapsedMs).toBeLessThan(2000);
  });

  it('评论命令：ack 走「一行已收到」评论，并在响应里回带文案', async () => {
    await enableRepo({ dryRun: false });
    const h = harness();
    const result = await handleWebhook(h.deps, {
      deliveryId: 'dlv-cmd',
      event: 'issue_comment',
      rawBody: JSON.stringify(commandPayload()),
      signature: 'good-signature',
      source: 'live',
    });

    expect(result.status).toBe(200);
    expect(h.events).toEqual(['enqueue', 'comment']);
    const body = result.body as { action: string; ackComment: string | null; taskId: string | null };
    expect(body.action).toBe('enqueued');
    expect(body.ackComment).toContain('/review-pr');
    expect(body.taskId).not.toBeNull();
    // 命令任务落库的三列（F9：入队即定型）
    const rows = await db.sql('select source, command, actor_login, target_kind, target_number from tasks');
    expect(rows[0]).toMatchObject({
      source: 'command',
      command: '/review-pr',
      actor_login: 'alice',
      target_kind: 'pr',
      target_number: 12,
    });
  });

  it('dry_run 仓库：建任务 + 入队，但一个 GitHub 写动作都不发', async () => {
    await enableRepo({ dryRun: true });
    const h = harness();
    const result = await handleWebhook(h.deps, {
      deliveryId: 'dlv-dry',
      event: 'issues',
      rawBody: JSON.stringify(issueOpenedPayload()),
      signature: 'good-signature',
      source: 'live',
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ action: 'enqueued', ackComment: null });
    expect(h.events).toEqual(['enqueue']);
    expect(h.reactions).toHaveLength(0);
    expect(h.comments).toHaveLength(0);
    expect(await countRows('tasks')).toBe(1);
  });

  it('仓库被禁用（enabled=false）：200 ignored，不建任务', async () => {
    await enableRepo({ dryRun: false, enabled: false });
    const h = harness();
    const result = await handleWebhook(h.deps, {
      deliveryId: 'dlv-disabled',
      event: 'issues',
      rawBody: JSON.stringify(issueOpenedPayload()),
      signature: 'good-signature',
      source: 'live',
    });
    expect(result.body).toMatchObject({ action: 'ignored' });
    expect(await countRows('tasks')).toBe(0);
  });

  it('仓库还没同步过配置（repos 无此行）：200 ignored', async () => {
    const h = harness();
    const result = await handleWebhook(h.deps, {
      deliveryId: 'dlv-unknown-repo',
      event: 'issues',
      rawBody: JSON.stringify(issueOpenedPayload()),
      signature: 'good-signature',
      source: 'live',
    });
    expect(result.body).toMatchObject({ action: 'ignored' });
    expect(await countRows('tasks')).toBe(0);
  });

  it('命令门禁：author_association=NONE 且不在白名单 → 200 unauthorized', async () => {
    await enableRepo({ dryRun: false });
    const payload = commandPayload();
    (payload['comment'] as Record<string, unknown>)['author_association'] = 'NONE';
    const h = harness();
    const result = await handleWebhook(h.deps, {
      deliveryId: 'dlv-gate',
      event: 'issue_comment',
      rawBody: JSON.stringify(payload),
      signature: 'good-signature',
      source: 'live',
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ action: 'unauthorized' });
    expect(await countRows('tasks')).toBe(0);
    expect(h.sends).toHaveLength(0);
  });

  it('任务级幂等：不同 delivery、同一 (kind, repo, target, 版本锚, actor) → 只建一个任务', async () => {
    await enableRepo({ dryRun: false });
    const h = harness();
    const rawBody = JSON.stringify(issueOpenedPayload());
    const first = await handleWebhook(h.deps, {
      deliveryId: 'dlv-a',
      event: 'issues',
      rawBody,
      signature: 'good-signature',
      source: 'live',
    });
    const second = await handleWebhook(h.deps, {
      deliveryId: 'dlv-b',
      event: 'issues',
      rawBody,
      signature: 'good-signature',
      source: 'live',
    });

    expect(first.body).toMatchObject({ action: 'enqueued' });
    expect(second.body).toMatchObject({ action: 'duplicate', duplicate: true });
    expect(await countRows('tasks')).toBe(1);
    expect(h.sends).toHaveLength(1);
  });

  it('issue 被编辑（updated_at 变）→ 产生新任务', async () => {
    await enableRepo({ dryRun: false });
    const h = harness();
    await handleWebhook(h.deps, {
      deliveryId: 'dlv-edit-1',
      event: 'issues',
      rawBody: JSON.stringify(issueOpenedPayload()),
      signature: 'good-signature',
      source: 'live',
    });
    await handleWebhook(h.deps, {
      deliveryId: 'dlv-edit-2',
      event: 'issues',
      rawBody: JSON.stringify(issueOpenedPayload({ updated_at: '2026-06-01T10:00:00Z' })),
      signature: 'good-signature',
      source: 'live',
    });
    expect(await countRows('tasks')).toBe(2);
  });

  it('熔断中（runtime_flags.rate_limit_pause 生效）：200 paused，不建任务', async () => {
    await enableRepo({ dryRun: false });
    await db.pool.query(
      `insert into runtime_flags (key, value, until) values ('rate_limit_pause', '1', '2026-06-01T12:10:00Z')`,
    );
    const h = harness();
    const result = await handleWebhook(h.deps, {
      deliveryId: 'dlv-paused',
      event: 'issues',
      rawBody: JSON.stringify(issueOpenedPayload()),
      signature: 'good-signature',
      source: 'live',
    });
    expect(result.body).toMatchObject({ action: 'paused' });
    expect(await countRows('tasks')).toBe(0);
  });

  it('replay：投递行已存在也强制 dry-run（不写 GitHub，只入队）', async () => {
    await enableRepo({ dryRun: false });
    const payload = issueOpenedPayload();
    await db.pool.query(
      `insert into webhook_deliveries (delivery_id, event, action, payload, signature_valid)
       values ($1, $2, $3, $4::jsonb, true)`,
      ['dlv-replay', 'issues', 'opened', JSON.stringify(payload)],
    );

    const h = harness({ verify: false });
    const result = await replayDelivery(h.deps, 'dlv-replay');
    expect(result).not.toBeNull();
    expect(result?.status).toBe(200);
    expect(result?.body).toMatchObject({ action: 'enqueued', duplicate: false });
    expect(h.events).toEqual(['enqueue']);
    expect(h.reactions).toHaveLength(0);
    expect(await countRows('tasks')).toBe(1);
  });

  it('replay：投递不存在 → null（CLI 据此以 EXIT_FAILURE 退出）', async () => {
    const h = harness();
    expect(await replayDelivery(h.deps, 'dlv-missing')).toBeNull();
  });

  it('body 不是 JSON → 400 bad-request', async () => {
    await enableRepo({ dryRun: false });
    const h = harness();
    const result = await handleWebhook(h.deps, {
      deliveryId: 'dlv-json',
      event: 'issues',
      rawBody: 'not-json',
      signature: 'good-signature',
      source: 'live',
    });
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe('bad-request');
  });
});

describe('webhook 纯函数', () => {
  it('extractCommand：只认 @pi-bot /cmd，且不误吃普通评论', () => {
    expect(extractCommand('@pi-bot /review-pr 看下')).toBe('/review-pr');
    expect(extractCommand('前面一句\n@pi-bot /issue-triage')).toBe('/issue-triage');
    expect(extractCommand('没有命令的评论')).toBeNull();
    expect(extractCommand('@other /review-pr')).toBeNull();
    expect(extractCommand(undefined)).toBeNull();
  });

  it('issueVersionHash：确定性且随 updated_at 变化', () => {
    expect(issueVersionHash('2026-05-31T00:00:00Z')).toBe(issueVersionHash('2026-05-31T00:00:00Z'));
    expect(issueVersionHash('2026-05-31T00:00:00Z')).not.toBe(issueVersionHash('2026-06-01T00:00:00Z'));
    expect(issueVersionHash('2026-05-31T00:00:00Z')).toHaveLength(16);
  });

  it('decideWebhookTask：机器人账号忽略', () => {
    const decision = decideWebhookTask({
      event: 'issues',
      action: 'opened',
      payload: {
        sender: { login: 'renovate[bot]', type: 'Bot' },
        repository: { full_name: REPO },
        issue: { number: 1, updated_at: '2026-06-01T00:00:00Z' },
      },
    });
    expect(decision.action).toBe('ignore');
  });

  it('checkCommandGate：非命令任务不受门禁约束', () => {
    expect(
      checkCommandGate(
        {
          command: 'auto:triage',
          kind: 'triage',
          source: 'webhook',
          targetKind: 'issue',
          targetNumber: 1,
          headSha: null,
          issueVersionHash: 'x',
          actorLogin: 'alice',
          association: 'NONE',
          ackStyle: 'reaction',
        },
        null,
      ),
    ).toEqual({ allowed: true });
  });

  it('checkCommandGate：命令任务在 association 不达标时被拒', () => {
    // 用契约的 parseRepoConfig 造配置：默认值只有一处来源，测试不手抄 schema 默认值
    const config = parseRepoConfig({
      version: 1,
      dry_run: false,
      commands: { allowed: ['/review-pr'], author_associations: ['OWNER'] },
    });
    const plan = {
      command: '/review-pr',
      kind: 'command:/review-pr',
      source: 'command' as const,
      targetKind: 'pr' as const,
      targetNumber: 12,
      headSha: null,
      issueVersionHash: null,
      actorLogin: 'bob',
      association: 'CONTRIBUTOR',
      ackStyle: 'comment' as const,
    };
    const denied = checkCommandGate(plan, { ...config });
    expect(denied.allowed).toBe(false);
    expect(checkCommandGate({ ...plan, association: 'OWNER' }, { ...config })).toEqual({ allowed: true });
  });

  it('idempotencyKeyFor：命令任务与判定任务各自稳定', () => {
    const base = {
      kind: 'triage',
      source: 'webhook' as const,
      targetKind: 'issue' as const,
      targetNumber: 7,
      headSha: null,
      issueVersionHash: 'abc',
      actorLogin: 'alice',
      association: null,
      ackStyle: 'reaction' as const,
    };
    const key = idempotencyKeyFor({ ...base, command: 'auto:triage' }, REPO);
    expect(key).toHaveLength(32);
    expect(idempotencyKeyFor({ ...base, command: 'auto:triage' }, REPO)).toBe(key);
    expect(idempotencyKeyFor({ ...base, command: 'auto:triage', targetNumber: 8 }, REPO)).not.toBe(key);
  });
});
