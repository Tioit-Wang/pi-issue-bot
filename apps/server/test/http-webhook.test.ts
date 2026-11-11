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
import { createNullLogger } from '../../../packages/shared/src/index.ts';
import {
  decideWebhookTask,
  extractCommand,
  handleWebhook,
  idempotencyKeyFor,
  issueVersionHash,
  replayDelivery,
} from '../src/http/index.ts';
import { dispatchNextForIssue } from '../src/agent/index.ts';
import type { WebhookAck, WebhookDeps } from '../src/http/index.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';
import { validRepoSettings } from './helpers/repo-settings.ts';

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
  await db.pool.query(
    'truncate table tasks, webhook_deliveries, repos, runtime_flags, agent_messages, agent_denials, agent_sessions cascade',
  );
}

beforeEach(async () => {
  await resetTables();
});

/** 写一行 `repos`（配置走 `settings`；`installationId` 给安装准入的用例）。 */
async function seedRepo(
  repo: string,
  options: {
    readonly dryRun?: boolean;
    readonly enabled?: boolean;
    readonly settings?: unknown;
    readonly installationId?: string | null;
  } = {},
): Promise<void> {
  await db.pool.query(
    `insert into repos (repo_full_name, enabled, dry_run, settings, settings_valid, installation_id)
     values ($1, $2, $3, $4::jsonb, true, $5)`,
    [
      repo,
      options.enabled ?? true,
      options.dryRun ?? true,
      // `pipeline.managers` 非空是解析前提（§4.5 / Q4）：给形状里剩下的默认值才不是「配置无效」
      JSON.stringify(options.settings ?? validRepoSettings()),
      options.installationId ?? null,
    ],
  );
}

/** 让 `REPO`「开机」：写一行 `repos`（`dry_run` 由用例决定）。 */
async function enableRepo(options: {
  readonly dryRun: boolean;
  readonly enabled?: boolean;
  readonly config?: unknown;
  readonly installationId?: string | null;
}): Promise<void> {
  await seedRepo(REPO, {
    dryRun: options.dryRun,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    ...(options.config === undefined ? {} : { settings: options.config }),
    ...(options.installationId === undefined ? {} : { installationId: options.installationId }),
  });
}

type Harness = {
  readonly deps: WebhookDeps;
  /** 调用顺序："enqueue" / "reaction" / "any-reaction"，用来断言「应答在 handler 内」。 */
  readonly events: string[];
  readonly sends: Array<Record<string, unknown>>;
  readonly reactions: Array<Record<string, unknown>>;
  /** 通用 reaction（`confused` 等），与 eyes 分开记，断言「闸门/失败只用 confused」。 */
  readonly anyReactions: Array<Record<string, unknown>>;
};

function harness(options: { readonly verify?: boolean } = {}): Harness {
  const events: string[] = [];
  const sends: Array<Record<string, unknown>> = [];
  const reactions: Array<Record<string, unknown>> = [];
  const anyReactions: Array<Record<string, unknown>> = [];
  const ack: WebhookAck = {
    addEyesReaction: async (input) => {
      events.push('reaction');
      reactions.push({ ...input });
    },
    addReaction: async (input) => {
      events.push('any-reaction');
      anyReactions.push({ ...input });
    },
  };
  return {
    events,
    sends,
    reactions,
    anyReactions,
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
      /**
       * agent 消息落库后**立刻**领一条：用的是真 `agent/dispatcher.ts`，只是把「投 run-task」
       * 换成这里的记账（`events`/`sends`），于是「入队发生在 handler 内」这条断言照旧成立。
       */
      dispatchAgent: (key: { readonly repo: string; readonly issueNumber: number }) =>
        dispatchNextForIssue(
          {
            db: db.pool,
            enqueue: async ({ taskId, repo, command }) => {
              events.push('enqueue');
              sends.push({ taskId, repo, command });
              return 'job-1';
            },
          },
          key,
        ),
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
    expect(h.reactions).toEqual([{ repo: REPO, issueNumber: 7, commentId: null }]);
    expect(result.elapsedMs).toBeLessThan(2000);
  });

  it('评论命令：ack 走 eyes reaction（不再回「已收到」评论）', async () => {
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
    // 只打表情 + 入队，不发「已收到」评论（用户要求：处理完只回最终结果）
    expect(h.events).toEqual(['enqueue', 'reaction']);
    // 评论级回执：reaction 打在那条评论（id=555）上，不是 issue 上
    expect(h.reactions).toEqual([{ repo: REPO, issueNumber: 12, commentId: 555 }]);
    // 零评论（§0.4）：命令通道也只有 reaction
    expect(h.anyReactions).toHaveLength(0);
    const body = result.body as { action: string; ackComment: string | null; taskId: string | null };
    expect(body.action).toBe('enqueued');
    expect(body.ackComment).toBeNull();
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
    expect(h.anyReactions).toHaveLength(0);
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

  it('issue 被编辑（updated_at 变）→ 产生第二条 agent 消息（同 issue 串行，第二条先排队）', async () => {
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
    // v0.3：编辑产生**新消息**（event 消息的 fingerprint 含 updated_at，L-07）；
    // 但同 issue 串行，第一条还在跑时不会并行建第二个任务（X-14）。
    const messages = await db.pool.query(
      'select fingerprint, status from agent_messages order by created_at',
    );
    expect(messages.rowCount).toBe(2);
    expect(messages.rows.map((row) => row['status'])).toEqual(['running', 'queued']);
    expect(await countRows('tasks')).toBe(1);
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
      commentId: null,
    };
    const key = idempotencyKeyFor({ ...base, command: 'auto:triage' }, REPO);
    expect(key).toHaveLength(32);
    expect(idempotencyKeyFor({ ...base, command: 'auto:triage' }, REPO)).toBe(key);
    expect(idempotencyKeyFor({ ...base, command: 'auto:triage', targetNumber: 8 }, REPO)).not.toBe(key);
  });
});

/* ── 第 4.5 步：项目解析 / 安装事件 / 两级暂停 ─────────────────────────────── */

/** 安装事件载荷：**没有 `repository`**，只有 `installation` + 仓库数组。 */
function installationPayload(
  action: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    action,
    installation: { id: 42, account: { login: 'acme' } },
    sender: { login: 'alice', type: 'User' },
    ...overrides,
  };
}

/** issue 事件 + installation（验证 installation 准入与安装级暂停）。 */
function issueOpenedFromInstallation(installationId: number, number = 70): Record<string, unknown> {
  return {
    action: 'opened',
    repository: { full_name: REPO },
    installation: { id: installationId },
    sender: { login: 'alice', type: 'User' },
    issue: { number, updated_at: '2026-05-31T00:00:00Z', author_association: 'OWNER' },
  };
}

async function repoRow(repo: string): Promise<Record<string, unknown> | undefined> {
  const rows = await db.sql(
    'select enabled, dry_run, source, installation_id, settings from repos where repo_full_name = $1',
    [repo],
  );
  return rows[0];
}

async function countRepos(): Promise<number> {
  const rows = await db.sql('select count(*)::int as n from repos');
  return Number(rows[0]?.['n'] ?? 0);
}

async function deliveryRepo(deliveryId: string): Promise<unknown> {
  const rows = await db.sql('select repo from webhook_deliveries where delivery_id = $1', [deliveryId]);
  return rows[0]?.['repo'];
}

describe('安装事件（payload 没有 repository）', () => {
  it('installation.created → 为每个仓库建行，但不开工（enabled=false, dry_run=true）', async () => {
    const h = harness();
    const result = await handleWebhook(h.deps, {
      deliveryId: 'dlv-install-created',
      event: 'installation',
      rawBody: JSON.stringify(
        installationPayload('created', {
          repositories: [{ full_name: 'acme/a' }, { full_name: 'acme/b' }],
        }),
      ),
      signature: 'good-signature',
      source: 'live',
    });

    expect(result.status).toBe(200);
    // 契约响应枚举里没有「installation」一档：安装事件统一报 ignored（它确实没建任务）
    expect(result.body).toMatchObject({ action: 'ignored', taskId: null });
    expect(await countRows('tasks')).toBe(0);
    expect(h.sends).toHaveLength(0);
    for (const repo of ['acme/a', 'acme/b']) {
      expect(await repoRow(repo)).toMatchObject({
        enabled: false,
        dry_run: true,
        source: 'installation',
        installation_id: '42',
      });
    }
    // 安装事件没有 repository：审计列仍然是 NULL
    expect(await deliveryRepo('dlv-install-created')).toBeNull();
  });

  it('installation_repositories.added → 建行；已有行不被覆盖（面板配置不丢）', async () => {
    await seedRepo('acme/existing', {
      enabled: true,
      dryRun: false,
      installationId: '42',
      settings: { version: 1, limits: { queue_wait_minutes: 3 } },
    });
    const h = harness();
    const result = await handleWebhook(h.deps, {
      deliveryId: 'dlv-install-added',
      event: 'installation_repositories',
      rawBody: JSON.stringify(
        installationPayload('added', {
          repositories_added: [{ full_name: 'acme/existing' }, { full_name: 'acme/new-one' }],
        }),
      ),
      signature: 'good-signature',
      source: 'live',
    });

    expect(result.body).toMatchObject({ action: 'ignored' });
    // 新仓库：建了行、没开工
    expect(await repoRow('acme/new-one')).toMatchObject({
      enabled: false,
      dry_run: true,
      source: 'installation',
      installation_id: '42',
    });
    // 老仓库：开关与 settings 都没被安装事件改掉（重新安装不该冲掉面板配置）
    const existing = await repoRow('acme/existing');
    expect(existing).toMatchObject({ enabled: true, dry_run: false });
    expect((existing?.['settings'] as { limits?: { queue_wait_minutes?: number } }).limits?.queue_wait_minutes).toBe(3);
  });

  it('installation_repositories.removed → 只禁用被移除的那个仓库', async () => {
    await seedRepo('acme/kept', { installationId: '42' });
    await seedRepo('acme/dropped', { installationId: '42' });
    const h = harness();
    await handleWebhook(h.deps, {
      deliveryId: 'dlv-install-removed',
      event: 'installation_repositories',
      rawBody: JSON.stringify(
        installationPayload('removed', { repositories_removed: [{ full_name: 'acme/dropped' }] }),
      ),
      signature: 'good-signature',
      source: 'live',
    });

    expect((await repoRow('acme/dropped'))?.['enabled']).toBe(false);
    expect((await repoRow('acme/kept'))?.['enabled']).toBe(true);
    // 行还在（禁用不是删除：成本与审计历史要留）
    expect(await countRepos()).toBe(2);
  });

  it('installation.deleted → 按 installation_id 批量禁用，不影响别人', async () => {
    await seedRepo('acme/a', { installationId: '42' });
    await seedRepo('acme/b', { installationId: '42' });
    await seedRepo('other/manual', { installationId: null });
    const h = harness();
    await handleWebhook(h.deps, {
      deliveryId: 'dlv-install-deleted',
      event: 'installation',
      rawBody: JSON.stringify(installationPayload('deleted')),
      signature: 'good-signature',
      source: 'live',
    });

    expect((await repoRow('acme/a'))?.['enabled']).toBe(false);
    expect((await repoRow('acme/b'))?.['enabled']).toBe(false);
    // 手动添加的仓库不属于这个 installation：不受影响
    expect((await repoRow('other/manual'))?.['enabled']).toBe(true);
    expect(await countRepos()).toBe(3);
  });

  it('installation.suspend → 写 pause:installation:<id>（repo NULL）；suspend 期间投递只记不入队', async () => {
    const h = harness();
    await handleWebhook(h.deps, {
      deliveryId: 'dlv-install-suspend',
      event: 'installation',
      rawBody: JSON.stringify(installationPayload('suspend')),
      signature: 'good-signature',
      source: 'live',
    });

    const flags = await db.sql(`select key, value, until, repo from runtime_flags where key = 'pause:installation:42'`);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ value: '1', until: null, repo: null });

    await enableRepo({ dryRun: false, installationId: '42' });
    const paused = await handleWebhook(h.deps, {
      deliveryId: 'dlv-while-suspended',
      event: 'issues',
      rawBody: JSON.stringify(issueOpenedFromInstallation(42)),
      signature: 'good-signature',
      source: 'live',
    });
    expect(paused.body).toMatchObject({ action: 'paused' });
    expect(await countRows('tasks')).toBe(0);
  });

  it('installation.unsuspend → value=0（写过去时间而不是删行），之后恢复接活', async () => {
    const h = harness();
    await handleWebhook(h.deps, {
      deliveryId: 'dlv-install-suspend-2',
      event: 'installation',
      rawBody: JSON.stringify(installationPayload('suspend')),
      signature: 'good-signature',
      source: 'live',
    });
    await handleWebhook(h.deps, {
      deliveryId: 'dlv-install-unsuspend',
      event: 'installation',
      rawBody: JSON.stringify(installationPayload('unsuspend')),
      signature: 'good-signature',
      source: 'live',
    });

    const flags = await db.sql(`select value, until from runtime_flags where key = 'pause:installation:42'`);
    expect(flags[0]?.['value']).toBe('0');
    expect((flags[0]?.['until'] as Date).getTime()).toBeLessThan(FIXED_NOW.getTime());

    await enableRepo({ dryRun: false, installationId: '42' });
    const resumed = await handleWebhook(h.deps, {
      deliveryId: 'dlv-after-unsuspend',
      event: 'issues',
      rawBody: JSON.stringify(issueOpenedFromInstallation(42, 71)),
      signature: 'good-signature',
      source: 'live',
    });
    expect(resumed.body).toMatchObject({ action: 'enqueued' });
    expect(await countRows('tasks')).toBe(1);
  });

  it('白名单外的事件（如 installation_repositories 的未知 action）不写库', async () => {
    const h = harness();
    const result = await handleWebhook(h.deps, {
      deliveryId: 'dlv-install-unknown',
      event: 'installation_repositories',
      rawBody: JSON.stringify(installationPayload('transferred', { repositories_added: [{ full_name: 'acme/a' }] })),
      signature: 'good-signature',
      source: 'live',
    });
    expect(result.body).toMatchObject({ action: 'ignored' });
    expect(await countRepos()).toBe(0);
  });
});

describe('installation 准入与未知仓库审计', () => {
  it('installation 不匹配 → 200 ignored，不建任务', async () => {
    await enableRepo({ dryRun: false, installationId: '111' });
    const h = harness();
    const result = await handleWebhook(h.deps, {
      deliveryId: 'dlv-installation-mismatch',
      event: 'issues',
      rawBody: JSON.stringify(issueOpenedFromInstallation(222)),
      signature: 'good-signature',
      source: 'live',
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ action: 'ignored', taskId: null });
    expect(await countRows('tasks')).toBe(0);
    expect(h.sends).toHaveLength(0);
    // 投递仍然落库（审计），并且带 repo
    expect(await deliveryRepo('dlv-installation-mismatch')).toBe(REPO);
  });

  it('installation 一致 → 正常建任务', async () => {
    await enableRepo({ dryRun: false, installationId: '111' });
    const h = harness();
    const result = await handleWebhook(h.deps, {
      deliveryId: 'dlv-installation-ok',
      event: 'issues',
      rawBody: JSON.stringify(issueOpenedFromInstallation(111)),
      signature: 'good-signature',
      source: 'live',
    });
    expect(result.body).toMatchObject({ action: 'enqueued' });
    expect(await countRows('tasks')).toBe(1);
  });

  it('仓库行没有 installation_id（面板手动添加）→ 不因 installation 缺失被挡', async () => {
    await enableRepo({ dryRun: false, installationId: null });
    const h = harness();
    const result = await handleWebhook(h.deps, {
      deliveryId: 'dlv-manual-repo',
      event: 'issues',
      rawBody: JSON.stringify(issueOpenedFromInstallation(999)),
      signature: 'good-signature',
      source: 'live',
    });
    expect(result.body).toMatchObject({ action: 'enqueued' });
  });

  it('未知仓库：200 ignored，但 repo 写进 webhook_deliveries.repo（不再静默）', async () => {
    const h = harness();
    const result = await handleWebhook(h.deps, {
      deliveryId: 'dlv-unknown-repo-audit',
      event: 'issues',
      rawBody: JSON.stringify(issueOpenedPayload()),
      signature: 'good-signature',
      source: 'live',
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ action: 'ignored' });
    expect(await countRows('tasks')).toBe(0);
    expect(await deliveryRepo('dlv-unknown-repo-audit')).toBe(REPO);
  });
});

describe('两级暂停：仓库级熔断不拖累别的仓库', () => {
  it('runtime_flags 的仓库行只停这个仓库（全局行不存在时别的仓库照常建任务）', async () => {
    await enableRepo({ dryRun: false });
    await seedRepo('other/lib', { dryRun: false });
    await db.pool.query(
      `insert into runtime_flags (key, repo, value, until)
       values ('rate_limit_pause', $1, '1', '2026-06-01T12:10:00Z')`,
      [REPO],
    );

    const h = harness();
    const paused = await handleWebhook(h.deps, {
      deliveryId: 'dlv-repo-paused',
      event: 'issues',
      rawBody: JSON.stringify(issueOpenedPayload()),
      signature: 'good-signature',
      source: 'live',
    });
    expect(paused.body).toMatchObject({ action: 'paused' });

    const other = await handleWebhook(h.deps, {
      deliveryId: 'dlv-other-repo',
      event: 'issues',
      rawBody: JSON.stringify({
        action: 'opened',
        repository: { full_name: 'other/lib' },
        sender: { login: 'bob', type: 'User' },
        issue: { number: 5, updated_at: '2026-05-31T00:00:00Z', author_association: 'OWNER' },
      }),
      signature: 'good-signature',
      source: 'live',
    });
    expect(other.body).toMatchObject({ action: 'enqueued' });
    expect(await countRows('tasks')).toBe(1);
  });

  it('全局行（repo IS NULL）停全部仓库；仓库级的行不会被当成全局', async () => {
    await enableRepo({ dryRun: false });
    await db.pool.query(
      `insert into runtime_flags (key, repo, value, until)
       values ('rate_limit_pause', $1, '0', '2026-05-01T00:00:00Z')`,
      [REPO],
    );
    const h = harness();
    // 仓库行 value=0（且已过期）→ 不暂停
    const alive = await handleWebhook(h.deps, {
      deliveryId: 'dlv-repo-flag-off',
      event: 'issues',
      rawBody: JSON.stringify(issueOpenedPayload()),
      signature: 'good-signature',
      source: 'live',
    });
    expect(alive.body).toMatchObject({ action: 'enqueued' });

    // 再写全局行 → 停
    await db.pool.query(
      `insert into runtime_flags (key, repo, value, until)
       values ('rate_limit_pause', null, '1', '2026-06-01T12:10:00Z')`,
    );
    const paused = await handleWebhook(h.deps, {
      deliveryId: 'dlv-global-flag-on',
      event: 'issues',
      rawBody: JSON.stringify(issueOpenedPayload({ updated_at: '2026-06-01T09:00:00Z' })),
      signature: 'good-signature',
      source: 'live',
    });
    expect(paused.body).toMatchObject({ action: 'paused' });
  });
});
