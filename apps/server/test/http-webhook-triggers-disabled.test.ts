/**
 * `settings.triggers.enabled=false` 的**提及类触发**语义（`docs/plan-fixed-pipeline.md` P8 / V10）。
 *
 * P8 逐字：「`triggers.enabled` **不影响 issue 流水线**，只关 `@` 提及类触发」。
 * 本文件把这句话的两半都钉住：
 *
 * | 场景 | `enabled=false` 时期望 |
 * |---|---|
 * | `issues.opened|edited|reopened` | 照常建 `pipeline:format`（V10 不可绕过） |
 * | `@bot /review-pr`（issue 与 PR） | **0 条任务**，投递仍落 `webhook_deliveries`，**不打回执** |
 * | `@bot 提问`（自由问答） | **0 条任务** |
 * | `format/awaiting_info` 下作者普通评论 | 照常重跑 `pipeline:format`（补充通道不受影响） |
 * | `classify/awaiting_info` 下 managers 评论 | 照常重跑 `pipeline:classify` |
 * | `enabled=true`（含缺省） | 命令 / 提问照常建任务（防「改反了也全绿」） |
 *
 * 实现点：`webhook.ts::handleWebhook` 读完 policy 把 `triggersEnabled` 传给纯函数
 * `decideWebhookTask`（纯函数不查库），判定只作用在「有 @ 且被识别成命令/提问」的评论上，
 * `pipeline-supplement` 与 `pipeline:*` 路径一个字都不改。
 *
 * `issues.opened` 的那一半另有 `WH::V10 不可绕过：triggers.enabled=false 不影响流水线（P1-4）`
 * （`http-webhook-pipeline.test.ts`）逐行断言；这里保留一条**最小复核**，让本文件的语义表自洽。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createNullLogger } from '../../../packages/shared/src/index.ts';
import { ensurePipeline, loadPipeline } from '../src/workflows/pipeline.ts';
import { decideWebhookTask, handleWebhook } from '../src/http/index.ts';
import type { WebhookAck, WebhookDeps } from '../src/http/index.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

const REPO = 'acme/widgets';
const NOW = new Date('2026-06-01T12:00:00.000Z');

/** 合法配置：`pipeline.managers` 非空 + 词表带 role（否则 `readRepoPolicy` 判 settings 非法）。 */
const VALID_SETTINGS = {
  version: 1,
  pipeline: { managers: ['alice'] },
  labels: {
    vocabulary: [
      { name: '需求', role: 'requirement' },
      { name: '缺陷', role: 'defect' },
    ],
  },
  commands: { enabled: true, allowed: ['/review-pr'], author_associations: ['OWNER', 'MEMBER'] },
};

/** P8 的被测配置：只关触发开关，其余与 `VALID_SETTINGS` 一致。 */
const TRIGGERS_OFF = { ...VALID_SETTINGS, triggers: { enabled: false } };
/** 对照：显式打开（缺省即这个值）。 */
const TRIGGERS_ON = { ...VALID_SETTINGS, triggers: { enabled: true } };

let db: TestDb;

beforeAll(async () => {
  db = await openTestDb(NOW);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.sql('truncate table tasks, webhook_deliveries, repos, runtime_flags, issue_pipeline');
});

async function seedRepo(options: { readonly settings?: unknown } = {}): Promise<void> {
  await db.sql(
    `insert into repos (repo_full_name, enabled, dry_run, settings, settings_valid, installation_id)
     values ($1, true, false, $2::jsonb, true, null)`,
    [REPO, JSON.stringify(options.settings ?? VALID_SETTINGS)],
  );
}

type Harness = {
  readonly deps: WebhookDeps;
  readonly sends: Array<Record<string, unknown>>;
  readonly eyes: Array<Record<string, unknown>>;
};

/**
 * 夹具：`freeMention: true`（自由问答通道打开，否则「纯提问」会落到补充评论通道，
 * 那一路本来就与触发开关无关，测不出 P8）。
 */
function harness(): Harness {
  const sends: Array<Record<string, unknown>> = [];
  const eyes: Array<Record<string, unknown>> = [];
  const ack: WebhookAck = {
    addEyesReaction: async (input) => {
      eyes.push({ ...input });
    },
  };
  return {
    sends,
    eyes,
    deps: {
      verify: async (input) => input.signature === 'good-signature',
      db: db.pool,
      enqueue: async (data) => {
        sends.push({ ...data });
        return 'job-1';
      },
      ack,
      logger: createNullLogger(),
      now: () => NOW,
      freeMention: true,
    },
  };
}

async function deliver(
  h: Harness,
  input: { readonly deliveryId: string; readonly event: string; readonly payload: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const result = await handleWebhook(h.deps, {
    deliveryId: input.deliveryId,
    event: input.event,
    rawBody: JSON.stringify(input.payload),
    signature: 'good-signature',
    source: 'live',
  });
  return result.body as unknown as Record<string, unknown>;
}

function issuePayload(action: string): Record<string, unknown> {
  return {
    action,
    repository: { full_name: REPO },
    sender: { login: 'alice', type: 'User' },
    issue: {
      number: 7,
      title: '登录时报 500',
      body: '复现步骤：……',
      state: 'open',
      user: { login: 'author' },
      author_association: 'OWNER',
      updated_at: '2026-05-31T00:00:00Z',
    },
  };
}

function commentPayload(input: {
  readonly body: string;
  readonly login?: string;
  readonly association?: string;
  readonly commentId?: number;
  readonly pullRequest?: boolean;
}): Record<string, unknown> {
  const issue: Record<string, unknown> = {
    number: 7,
    title: '登录时报 500',
    body: '复现步骤：……',
    user: { login: 'author' },
    author_association: 'OWNER',
    updated_at: '2026-05-31T00:00:00Z',
  };
  if (input.pullRequest === true) {
    issue['pull_request'] = { url: 'https://example.invalid/pr/7' };
  }
  return {
    action: 'created',
    repository: { full_name: REPO },
    sender: { login: input.login ?? 'alice', type: 'User' },
    issue,
    comment: {
      id: input.commentId ?? 555,
      body: input.body,
      author_association: input.association ?? 'OWNER',
      user: { login: input.login ?? 'alice', type: 'User' },
    },
  };
}

async function taskCommands(): Promise<string[]> {
  const rows = await db.sql('select command, source from tasks order by queued_at, command');
  return rows.map((row) => String(row['command']));
}

async function deliveryCount(): Promise<number> {
  const rows = await db.sql('select count(*)::int as n from webhook_deliveries');
  return Number(rows[0]?.['n'] ?? 0);
}

describe('triggers.enabled=false：流水线照跑（P8 的前半句，V10 不可绕过）', () => {
  it('① issues.opened → 仍建 1 条 pipeline:format，并推进到 format/pending', async () => {
    await seedRepo({ settings: TRIGGERS_OFF });
    const h = harness();
    const body = await deliver(h, { deliveryId: 'd-off-open', event: 'issues', payload: issuePayload('opened') });

    expect(body).toMatchObject({ action: 'enqueued' });
    expect(await taskCommands()).toEqual(['pipeline:format']);
    const row = await loadPipeline(db.pool, { repo: REPO, issueNumber: 7 });
    expect(row).toMatchObject({ stage: 'format', state: 'pending' });
  });
});

describe('triggers.enabled=false：提及类触发被关掉（P8 的后半句）', () => {
  it('② issue 上的 `@bot /review-pr` → 0 条任务、投递仍落库、不打回执', async () => {
    await seedRepo({ settings: TRIGGERS_OFF });
    const h = harness();
    const body = await deliver(h, {
      deliveryId: 'd-off-cmd-issue',
      event: 'issue_comment',
      payload: commentPayload({ body: '@pi-bot /review-pr 看下' }),
    });

    expect(body).toMatchObject({ action: 'ignored', taskId: null });
    expect(await taskCommands()).toEqual([]);
    // 审计不丢：事件照样落 `webhook_deliveries`（1 行），恢复开关后可用 replay 重放
    expect(await deliveryCount()).toBe(1);
    // 「配置关掉就安静」：连 eyes 都不打（reason=triggers-disabled 只进日志）
    expect(h.eyes).toEqual([]);
    expect(h.sends).toEqual([]);
  });

  it('② PR 上的 `@bot /review-pr` → 同样 0 条任务（P8 只排除流水线，不排除 PR）', async () => {
    await seedRepo({ settings: TRIGGERS_OFF });
    const h = harness();
    const body = await deliver(h, {
      deliveryId: 'd-off-cmd-pr',
      event: 'issue_comment',
      payload: commentPayload({ body: '@pi-bot /review-pr 看下', pullRequest: true }),
    });

    expect(body).toMatchObject({ action: 'ignored' });
    expect(await taskCommands()).toEqual([]);
    expect(await deliveryCount()).toBe(1);
    expect(h.eyes).toEqual([]);
  });

  it('③ 纯提问 `@bot 为什么…` → 0 条任务（自由问答同受约束）', async () => {
    await seedRepo({ settings: TRIGGERS_OFF });
    const h = harness();
    const body = await deliver(h, {
      deliveryId: 'd-off-ask',
      event: 'issue_comment',
      payload: commentPayload({ body: '@pi-bot 为什么这里会报 500？' }),
    });

    expect(body).toMatchObject({ action: 'ignored' });
    expect(await taskCommands()).toEqual([]);
    expect(h.eyes).toEqual([]);
  });

  it('④ format/awaiting_info 下作者普通评论 → 仍重跑 pipeline:format（补充通道不受影响）', async () => {
    await seedRepo({ settings: TRIGGERS_OFF });
    await ensurePipeline(
      db.pool,
      { repo: REPO, issueNumber: 7 },
      { stage: 'format', state: 'awaiting_info', infoRequestedAt: NOW },
    );
    const h = harness();
    const body = await deliver(h, {
      deliveryId: 'd-off-supplement',
      event: 'issue_comment',
      payload: commentPayload({
        body: '补充：只在登录后第一次请求时报 500',
        login: 'author',
        association: 'OWNER',
        commentId: 1301,
      }),
    });

    expect(body).toMatchObject({ action: 'enqueued' });
    expect(await taskCommands()).toEqual(['pipeline:format']);
    const rows = await db.sql('select source, target_supplement from tasks');
    expect(rows[0]).toMatchObject({ source: 'pipeline' });
    expect(rows[0]?.['target_supplement']).toEqual([
      {
        commentId: 1301,
        author: 'author',
        body: '补充：只在登录后第一次请求时报 500',
        at: NOW.toISOString(),
      },
    ]);
  });

  it('⑤ classify/awaiting_info 下 managers 评论 → 仍重跑 pipeline:classify（重分类不受影响）', async () => {
    await seedRepo({ settings: TRIGGERS_OFF });
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: 7 }, { stage: 'classify', state: 'awaiting_info' });
    const h = harness();
    const body = await deliver(h, {
      deliveryId: 'd-off-reclassify',
      event: 'issue_comment',
      payload: commentPayload({
        body: '补充：已确认这是缺陷，影响所有登录用户',
        login: 'alice',
        association: 'MEMBER',
        commentId: 1302,
      }),
    });

    expect(body).toMatchObject({ action: 'enqueued' });
    expect(await taskCommands()).toEqual(['pipeline:classify']);
  });

  it('⑥ 纯函数：`decideWebhookTask(triggersEnabled: false)` → ignore，reason 带 triggers-disabled', async () => {
    const decision = decideWebhookTask({
      event: 'issue_comment',
      action: 'created',
      payload: commentPayload({ body: '@pi-bot /review-pr 看下' }),
      aliases: ['pi-bot'],
      triggersEnabled: false,
    });
    expect(decision.action).toBe('ignore');
    if (decision.action !== 'ignore') return;
    expect(decision.reason).toContain('triggers-disabled');

    // 同一份载荷把开关打开就照常建任务（同一个纯函数的两个分支都在这里可见）
    const allowed = decideWebhookTask({
      event: 'issue_comment',
      action: 'created',
      payload: commentPayload({ body: '@pi-bot /review-pr 看下' }),
      aliases: ['pi-bot'],
      triggersEnabled: true,
    });
    expect(allowed.action).toBe('task');
  });
});

describe('triggers.enabled=true（含缺省）：命令 / 提问照常建任务（防改反）', () => {
  it('缺省（配置里没有 triggers 段）→ `@bot /review-pr` 建命令任务', async () => {
    await seedRepo();
    const h = harness();
    const body = await deliver(h, {
      deliveryId: 'd-on-cmd',
      event: 'issue_comment',
      payload: commentPayload({ body: '@pi-bot /review-pr 看下' }),
    });

    expect(body).toMatchObject({ action: 'enqueued' });
    expect(await taskCommands()).toEqual(['/review-pr']);
    expect(h.eyes).toHaveLength(1);
  });

  it('显式 enabled=true → PR 命令照常建任务', async () => {
    await seedRepo({ settings: TRIGGERS_ON });
    const h = harness();
    const body = await deliver(h, {
      deliveryId: 'd-on-cmd-pr',
      event: 'issue_comment',
      payload: commentPayload({ body: '@pi-bot /review-pr 看下', pullRequest: true }),
    });

    expect(body).toMatchObject({ action: 'enqueued' });
    expect(await taskCommands()).toEqual(['/review-pr']);
  });

  it('显式 enabled=true → 纯提问照常建 `@answer` 任务', async () => {
    await seedRepo({ settings: TRIGGERS_ON });
    const h = harness();
    const body = await deliver(h, {
      deliveryId: 'd-on-ask',
      event: 'issue_comment',
      payload: commentPayload({ body: '@pi-bot 为什么这里会报 500？' }),
    });

    expect(body).toMatchObject({ action: 'enqueued' });
    expect(await taskCommands()).toEqual(['@answer']);
  });
});
