/**
 * BR-6 / FR-6.4③ 的**写入口**：`webhook_deliveries.decision / decision_reason` 到底写了什么。
 *
 * 为什么单独一个文件（而不是塞进 `http-webhook.test.ts`）：那个文件断言的是 v0.3 九步管线，
 * 而且是**不注入 `v21`** 的旧装配 —— 它连判定列都不该写（「不注入 = 旧行为逐字节不变」）。
 * 留痕是 v2.1 的行为，必须用注入 `v21` 的装配来钉。
 *
 * 钉住五件事（每条都是上一轮复审的实测缺口，逐条对着需求原文）：
 *  1. `push` 这类**不在判定范围**的事件 → `ignored` / `out-of-scope`
 *     （BR-6 `:1791` + FR-6.4③ `:1216`：被忽略的事件也要能看到原因）；
 *  2. **缺 `X-Hub-Signature-256` → 401，但投递行仍在**，`signature_valid=false` /
 *     `signature-missing`（FR-1.2 `:741`：校验失败返回 401，但仍要落库留痕）；
 *  3. 外层兜底**按真实病因分开记**：暂停 `paused`、未知仓库 `unknown-repo`、
 *     安装事件 `installation-event`、安装不匹配 `installation-mismatch`
 *     （不是一律 `repo-disabled`；issue #30 那类误标的同一个坑）；
 *  4. `writeV21Decision()` 遇到 0 行更新 → 抛错（调用方记 warn），不再静默吞掉结论；
 *  5. 内容重复被丢弃 → `ignored` / `content-duplicate`，**不是** `triggered` / `enabled`
 *     （FR-3.5 `:918`：判定为重复时不静默丢弃，记一条「因重复内容跳过」）。
 *
 * 真 PostgreSQL（`helpers/queries-db.ts` 的 advisory lock）：这些断言的落点就是那一列，
 * 用假 SqlRunner 验等于自己实现一遍 `UPDATE` 再去断言自己。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createNullLogger } from '../../../packages/shared/src/index.ts';
import { handleWebhook } from '../src/http/webhook.ts';
import type { WebhookAck, WebhookDeps } from '../src/http/webhook.ts';
import type { V21WebhookDeps } from '../src/http/webhook-v21.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';
import { validRepoSettings } from './helpers/repo-settings.ts';

const REPO = 'acme/widgets';
/** 固定时钟：`runtime_flags.until` 与配额窗口都相对它摆位。 */
const FIXED_NOW = new Date('2026-06-01T12:00:00.000Z');

let db: TestDb;

beforeAll(async () => {
  db = await openTestDb(FIXED_NOW);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  // 只清本切片会写/断言的表；`agent_messages` 是内容级去重（第 5 条）的判据来源。
  await db.pool.query(
    'truncate table tasks, webhook_deliveries, repos, runtime_flags, agent_messages cascade',
  );
});

/** 一条投递行的留痕（缺失时为 `undefined`，让断言能区分「没有行」与「行里是 null」）。 */
async function traceOf(deliveryId: string): Promise<
  | {
      readonly event: string;
      readonly action: string | null;
      readonly decision: string | null;
      readonly decision_reason: string | null;
      readonly signature_valid: boolean;
    }
  | undefined
> {
  const rows = await db.sql(
    `select event, action, decision, decision_reason, signature_valid
from webhook_deliveries where delivery_id = $1`,
    [deliveryId],
  );
  const row = rows[0];
  if (row === undefined) {
    return undefined;
  }
  return {
    event: String(row['event']),
    action: typeof row['action'] === 'string' ? row['action'] : null,
    decision: typeof row['decision'] === 'string' ? row['decision'] : null,
    decision_reason: typeof row['decision_reason'] === 'string' ? row['decision_reason'] : null,
    signature_valid: row['signature_valid'] === true,
  };
}

async function seedRepo(options: {
  readonly enabled?: boolean;
  readonly installationId?: string | null;
} = {}): Promise<void> {
  await db.pool.query(
    `insert into repos (repo_full_name, enabled, dry_run, settings, settings_valid, installation_id)
     values ($1, $2, true, $3::jsonb, true, $4)`,
    [
      REPO,
      options.enabled ?? true,
      JSON.stringify(validRepoSettings()),
      options.installationId ?? null,
    ],
  );
}

type Harness = {
  readonly deps: WebhookDeps;
  /** 结构化的 warn 消息（留痕失败 / 降级等）。 */
  readonly warns: string[];
};

/** 注入 `v21` 的装配：判定的留痕只在这一段启用。 */
function harness(options: { readonly verify?: boolean } = {}): Harness {
  const warns: string[] = [];
  const ack: WebhookAck = { addEyesReaction: async () => undefined };
  const logger = createNullLogger();
  const capturing = {
    ...logger,
    warn: (fields: unknown, message?: string) => {
      warns.push(message ?? String(fields));
    },
    child: () => capturing,
  };
  const v21: V21WebhookDeps = { db: db.pool };
  return {
    warns,
    deps: {
      // 验签只看签名串：默认 `good-signature`，其余一律失败
      verify: async (input) => (options.verify ?? true) && input.signature === 'good-signature',
      db: db.pool,
      enqueue: async () => null,
      ack,
      logger: capturing as unknown as WebhookDeps['logger'],
      now: () => FIXED_NOW,
      v21,
    },
  };
}

function issueOpenedPayload(): Record<string, unknown> {
  return {
    action: 'opened',
    repository: { full_name: REPO },
    sender: { login: 'alice', type: 'User' },
    issue: { number: 7, updated_at: '2026-05-31T00:00:00Z', author_association: 'OWNER' },
  };
}

function pushPayload(): Record<string, unknown> {
  return {
    ref: 'refs/heads/main',
    repository: { full_name: REPO },
    sender: { login: 'alice', type: 'User' },
    commits: [{ id: 'abc' }],
  };
}

/* ── 1. C1：不在判定范围的事件也要留原因 ─────────────────────────────────── */

describe('C1：不在本期判定范围的事件（push / issues.reopened）', () => {
  it('★ push → ignored / out-of-scope（不再是 decision=null 混进 pending）', async () => {
    await seedRepo();
    const { deps } = harness();
    const result = await handleWebhook(deps, {
      deliveryId: 'trace-push',
      event: 'push',
      rawBody: JSON.stringify(pushPayload()),
      signature: 'good-signature',
      source: 'live',
    });

    // 应答仍是 200 ignored（它确实没建任务），判定在投递行里
    expect(result.status).toBe(200);
    expect(await traceOf('trace-push')).toMatchObject({
      event: 'push',
      action: null,
      decision: 'ignored',
      decision_reason: 'out-of-scope',
      signature_valid: true,
    });
    // 没有判定为触发的行：确实什么都没跑
    expect(await db.sql('select id from tasks')).toHaveLength(0);
  });

  it('★ issues.reopened → ignored / out-of-scope（与 push 同一语义）', async () => {
    await seedRepo();
    const { deps } = harness();
    await handleWebhook(deps, {
      deliveryId: 'trace-reopened',
      event: 'issues',
      rawBody: JSON.stringify({ ...issueOpenedPayload(), action: 'reopened' }),
      signature: 'good-signature',
      source: 'live',
    });
    expect(await traceOf('trace-reopened')).toMatchObject({
      event: 'issues',
      action: 'reopened',
      decision: 'ignored',
      decision_reason: 'out-of-scope',
    });
  });

  it('对照：判定范围内的事件仍走真实原因（不是被 out-of-scope 吃掉）', async () => {
    await seedRepo();
    const { deps } = harness();
    await handleWebhook(deps, {
      deliveryId: 'trace-opened',
      event: 'issues',
      rawBody: JSON.stringify(issueOpenedPayload()),
      signature: 'good-signature',
      source: 'live',
    });
    expect(await traceOf('trace-opened')).toMatchObject({
      decision: 'triggered',
      decision_reason: 'enabled',
    });
  });

  it('★ 已验签通过的同一条 delivery 被未验签重投时，不覆写原判定（审计不可抹）', async () => {
    await seedRepo();
    const { deps } = harness();
    // 第一次：合法签名、正常处理
    await handleWebhook(deps, {
      deliveryId: 'trace-replay-sig',
      event: 'issues',
      rawBody: JSON.stringify(issueOpenedPayload()),
      signature: 'good-signature',
      source: 'live',
    });
    expect(await traceOf('trace-replay-sig')).toMatchObject({
      decision: 'triggered',
      decision_reason: 'enabled',
      signature_valid: true,
    });

    // 第二次：同一条 delivery 但没带签名 —— 401，但**不得**把已处理的审计改成 signature-missing
    const replay = await handleWebhook(deps, {
      deliveryId: 'trace-replay-sig',
      event: 'issues',
      rawBody: JSON.stringify(issueOpenedPayload()),
      signature: null,
      source: 'live',
    });
    expect(replay.status).toBe(401);
    expect(await traceOf('trace-replay-sig')).toMatchObject({
      decision: 'triggered',
      decision_reason: 'enabled',
      signature_valid: true,
    });
  });
});

/* ── 2. C4-1：缺签名也要落行（FR-1.2） ──────────────────────────────────── */

describe('FR-1.2：缺 X-Hub-Signature-256 → 401，但投递行仍在', () => {
  it('★ 缺签名 → 401 + signature_valid=false + ignored/signature-missing', async () => {
    await seedRepo();
    const { deps } = harness();
    const result = await handleWebhook(deps, {
      deliveryId: 'trace-no-sig',
      event: 'issues',
      rawBody: JSON.stringify(issueOpenedPayload()),
      signature: null,
      source: 'live',
    });

    // 应答不变：不设宽容模式，依旧是 401
    expect(result.status).toBe(401);
    expect((result.body as { error: { code: string } }).error.code).toBe('unauthorized');

    // 需求 `:741`「校验失败返回 401，但**仍要落库留痕**，便于排查配置错误」
    expect(await traceOf('trace-no-sig')).toMatchObject({
      event: 'issues',
      action: 'opened',
      decision: 'ignored',
      decision_reason: 'signature-missing',
      signature_valid: false,
    });
    // 安全边界：只落痕，没有进入任何业务分支
    expect(await db.sql('select id from tasks')).toHaveLength(0);
  });

  it('验签失败的行与缺签名能区分（signature-invalid vs signature-missing）', async () => {
    await seedRepo();
    const { deps } = harness();
    const result = await handleWebhook(deps, {
      deliveryId: 'trace-bad-sig',
      event: 'issues',
      rawBody: JSON.stringify(issueOpenedPayload()),
      signature: 'sha256=deadbeef',
      source: 'live',
    });
    expect(result.status).toBe(401);
    expect(await traceOf('trace-bad-sig')).toMatchObject({
      decision: 'ignored',
      decision_reason: 'signature-invalid',
      signature_valid: false,
    });
  });
});

/* ── 3. C4-3：病因分开记（不再一律 repo-disabled） ───────────────────────── */

describe('外层兜底按真实病因分开记（issue #30 那类误标）', () => {
  it('★ 暂停 → paused（不是 repo-disabled），且仓库开关仍是 true', async () => {
    await seedRepo();
    await db.pool.query(
      `insert into runtime_flags (key, repo, value, until) values ('rate_limit_pause', null, '1', null)`,
    );
    const { deps } = harness();
    const result = await handleWebhook(deps, {
      deliveryId: 'trace-paused',
      event: 'issues',
      rawBody: JSON.stringify(issueOpenedPayload()),
      signature: 'good-signature',
      source: 'live',
    });
    expect(result.status).toBe(200);
    expect((result.body as { action: string }).action).toBe('paused');
    expect(await traceOf('trace-paused')).toMatchObject({
      decision: 'ignored',
      decision_reason: 'paused',
    });
    // 病因指对了：`repos.enabled` 没变，问题在暂停
    const repos = await db.sql('select enabled from repos where repo_full_name = $1', [REPO]);
    expect(repos[0]?.['enabled']).toBe(true);
  });

  it('★ 未知仓库（repos 没有这一行）→ unknown-repo', async () => {
    // 故意不 seedRepo()
    const { deps } = harness();
    await handleWebhook(deps, {
      deliveryId: 'trace-unknown',
      event: 'issues',
      rawBody: JSON.stringify(issueOpenedPayload()),
      signature: 'good-signature',
      source: 'live',
    });
    expect(await traceOf('trace-unknown')).toMatchObject({
      decision: 'ignored',
      decision_reason: 'unknown-repo',
    });
  });

  it('仓库已禁用 → repo-disabled（这一条本来就是它）', async () => {
    await seedRepo({ enabled: false });
    const { deps } = harness();
    await handleWebhook(deps, {
      deliveryId: 'trace-disabled',
      event: 'issues',
      rawBody: JSON.stringify(issueOpenedPayload()),
      signature: 'good-signature',
      source: 'live',
    });
    expect(await traceOf('trace-disabled')).toMatchObject({
      decision: 'ignored',
      decision_reason: 'repo-disabled',
    });
  });

  it('★ 安装事件 → installation-event（它没有 repository，不该记成仓库问题）', async () => {
    const { deps } = harness();
    const result = await handleWebhook(deps, {
      deliveryId: 'trace-install',
      event: 'installation',
      rawBody: JSON.stringify({
        action: 'created',
        installation: { id: 42 },
        sender: { login: 'alice', type: 'User' },
        repositories: [{ full_name: 'acme/installed' }],
      }),
      signature: 'good-signature',
      source: 'live',
    });
    expect(result.status).toBe(200);
    expect((result.body as { action: string }).action).toBe('ignored');
    expect(await traceOf('trace-install')).toMatchObject({
      decision: 'ignored',
      decision_reason: 'installation-event',
    });
    // 安装事件照常建行（行为不变）
    const repos = await db.sql('select repo_full_name from repos where repo_full_name = $1', [
      'acme/installed',
    ]);
    expect(repos).toHaveLength(1);
  });

  it('★ installation 不匹配 → installation-mismatch（不是 repo-disabled）', async () => {
    await seedRepo({ installationId: '111' });
    const { deps } = harness();
    await handleWebhook(deps, {
      deliveryId: 'trace-mismatch',
      event: 'issues',
      rawBody: JSON.stringify({ ...issueOpenedPayload(), installation: { id: 222 } }),
      signature: 'good-signature',
      source: 'live',
    });
    expect(await traceOf('trace-mismatch')).toMatchObject({
      decision: 'ignored',
      decision_reason: 'installation-mismatch',
    });
  });
});

/* ── 4. C4-4：0 行 UPDATE 必须可观测 ───────────────────────────────────── */

describe('C4-4：判定留痕 0 行更新 → 抛错并可观测（不再静默）', () => {
  it('★ 投递行不存在时记一条带 deliveryId / reason 的 warn', async () => {
    // 不落任何行的装配：投递级去重被跳过（模拟「行本该在却不在」）
    const { deps, warns } = harness();
    await handleWebhook(
      { ...deps, verify: async () => false },
      {
        deliveryId: 'trace-ghost',
        event: 'issues',
        rawBody: JSON.stringify(issueOpenedPayload()),
        // `source:'replay'` 跳过验签与投递 INSERT，于是 UPDATE 打空行
        signature: null,
        source: 'replay',
        skipDeliveryDedup: true,
        forcedDryRun: true,
      },
    );
    // 行确实不存在
    expect(await traceOf('trace-ghost')).toBeUndefined();
    // 但「算出了结论却写不进去」不能静默：必须有一条 warn，且点明是哪条投递
    const warned = warns.find((message) => message.includes('判定留痕失败'));
    expect(warned).toBeDefined();
    expect(warned).toContain('trace-ghost');
    expect(warned).toContain('delivery_id=trace-ghost');
  });
});

/* ── 5. 新发现：内容重复被丢弃的投递不能记成「已触发」 ─────────────────── */

describe('FR-3.5：内容重复被丢弃 → content-duplicate（不是 triggered / enabled）', () => {
  it('★ 同一段评论贴两次：第二次记 ignored / content-duplicate', async () => {
    await seedRepo();
    const { deps } = harness();
    // 评论事件：`content-duplicate` 的判据是 `agent_messages` 的内容级唯一键
    const commentPayload = {
      action: 'created',
      repository: { full_name: REPO },
      sender: { login: 'bob', type: 'User' },
      issue: { number: 7, updated_at: '2026-06-01T00:00:00Z', state: 'open' },
      comment: {
        id: 9001,
        body: '@pi-bot 打个标签',
        author_association: 'MEMBER',
        user: { login: 'bob', type: 'User' },
      },
    };

    const first = await handleWebhook(deps, {
      deliveryId: 'trace-dup-1',
      event: 'issue_comment',
      rawBody: JSON.stringify(commentPayload),
      signature: 'good-signature',
      source: 'live',
    });
    expect(first.status).toBe(200);
    expect(await traceOf('trace-dup-1')).toMatchObject({
      decision: 'triggered',
      decision_reason: 'conditional-met',
    });

    // 同一句话再贴一次（只差首尾空白）：内容级去重命中，什么都没跑
    const second = await handleWebhook(deps, {
      deliveryId: 'trace-dup-2',
      event: 'issue_comment',
      rawBody: JSON.stringify({
        ...commentPayload,
        comment: { ...commentPayload.comment, id: 9002, body: '  @pi-bot 打个标签\n\n' },
      }),
      signature: 'good-signature',
      source: 'live',
    });
    expect(second.status).toBe(200);
    expect((second.body as { duplicate: boolean }).duplicate).toBe(true);

    // 需求 `:918`「跳过要留痕：判定为重复时不静默丢弃，记一条『因重复内容跳过』，后台可查」
    expect(await traceOf('trace-dup-2')).toMatchObject({
      decision: 'ignored',
      decision_reason: 'content-duplicate',
    });
  });
});
