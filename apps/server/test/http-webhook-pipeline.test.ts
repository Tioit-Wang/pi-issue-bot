/**
 * 固定流水线的**接入层与门禁**（`http/webhook.ts` 第 5.5 步）
 * —— `docs/plan-fixed-pipeline.md` §1.3 / §8 / §16.1 / §16.2。
 *
 * 门禁矩阵逐行（§8）：
 * | 当前状态 | 期望 |
 * |---|---|
 * | 无行 | 放行 + 懒创建 `agent/ready` 行 |
 * | `format/pending` / `classify/pending` / 任意 `running` | 只打 `eyes`，零任务 |
 * | `format/awaiting_info` | 命令被拦，只产 `pipeline:notice` |
 * | `classify/awaiting_info` / `blocked` | 同上（限速内） |
 * | `closed` | 静默 |
 * | `ready` | 正常建命令任务 |
 * | PR | 完全不受影响 |
 *
 * 另外三条：`commands.enabled=false` 照样跑流水线（§16.1 第 3 条）、
 * 评论补充触发重跑且锚含 commentId（§16.2）、编辑在评论后 120s 内让位（§16.2 第 3 条）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createNullLogger } from '../../../packages/shared/src/index.ts';
import { ensurePipeline, loadPipeline } from '../src/workflows/pipeline.ts';
import { handleWebhook } from '../src/http/index.ts';
import type { WebhookAck, WebhookDeps } from '../src/http/index.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

const REPO = 'acme/widgets';
const NOW = new Date('2026-06-01T12:00:00.000Z');
const HOUR = 3_600_000;

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

let db: TestDb;

beforeAll(async () => {
  db = await openTestDb(NOW);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.sql('truncate table tasks, webhook_deliveries, repos, runtime_flags, issue_pipeline cascade');
});

async function seedRepo(options: { readonly dryRun?: boolean; readonly settings?: unknown } = {}): Promise<void> {
  await db.sql(
    `insert into repos (repo_full_name, enabled, dry_run, settings, settings_valid, installation_id)
     values ($1, true, $2, $3::jsonb, true, null)`,
    [REPO, options.dryRun ?? false, JSON.stringify(options.settings ?? VALID_SETTINGS)],
  );
}

type Harness = {
  readonly deps: WebhookDeps;
  readonly events: string[];
  readonly sends: Array<Record<string, unknown>>;
  readonly eyes: Array<Record<string, unknown>>;
};

function harness(): Harness {
  const events: string[] = [];
  const sends: Array<Record<string, unknown>> = [];
  const eyes: Array<Record<string, unknown>> = [];
  const ack: WebhookAck = {
    addEyesReaction: async (input) => {
      events.push('reaction');
      eyes.push({ ...input });
    },
  };
  return {
    events,
    sends,
    eyes,
    deps: {
      verify: async (input) => input.signature === 'good-signature',
      db: db.pool,
      enqueue: async (data) => {
        events.push('enqueue');
        sends.push({ ...data });
        return 'job-1';
      },
      ack,
      logger: createNullLogger(),
      now: () => NOW,
    },
  };
}

async function deliver(h: Harness, input: {
  readonly deliveryId: string;
  readonly event: string;
  readonly payload: Record<string, unknown>;
}) {
  return handleWebhook(h.deps, {
    deliveryId: input.deliveryId,
    event: input.event,
    rawBody: JSON.stringify(input.payload),
    signature: 'good-signature',
    source: 'live',
  });
}

function issuePayload(action: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
      ...overrides,
    },
  };
}

function commentPayload(input: {
  readonly body: string;
  readonly login?: string;
  readonly association?: string;
  readonly commentId?: number;
  readonly pullRequest?: boolean;
  readonly number?: number;
}): Record<string, unknown> {
  const issue: Record<string, unknown> = {
    number: input.number ?? 7,
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
      author_association: input.association ?? 'MEMBER',
      user: { login: input.login ?? 'alice', type: 'User' },
    },
  };
}

async function tasks(): Promise<Array<Record<string, unknown>>> {
  return db.sql('select command, source, target_title, target_body, target_supplement, actor_login from tasks order by queued_at, command');
}

describe('issue 事件 → pipeline:format（E1 全量切换）', () => {
  it('issues.opened → pipeline:format 任务 + format/pending 行 + 正文快照', async () => {
    await seedRepo();
    const h = harness();
    const result = await deliver(h, { deliveryId: 'd-open', event: 'issues', payload: issuePayload('opened') });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ action: 'enqueued' });
    expect(h.sends).toEqual([{ taskId: expect.any(String), command: 'pipeline:format', repo: REPO }]);
    // §12 V1：不再有老的判定任务
    const rows = await tasks();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      command: 'pipeline:format',
      source: 'pipeline',
      target_title: '登录时报 500',
      target_body: '复现步骤：……',
    });
    expect(rows[0]?.['target_supplement']).toEqual([]);
    expect(h.eyes).toEqual([{ repo: REPO, issueNumber: 7, commentId: null }]);

    const row = await loadPipeline(db.pool, { repo: REPO, issueNumber: 7 });
    expect(row).toMatchObject({ stage: 'format', state: 'pending' });
  });

  it('commands.enabled=false 不影响流水线（§16.1 第 3 条：绕开命令门禁）', async () => {
    await seedRepo({
      settings: { ...VALID_SETTINGS, commands: { ...VALID_SETTINGS.commands, enabled: false } },
    });
    const h = harness();
    const result = await deliver(h, { deliveryId: 'd-cmd-off', event: 'issues', payload: issuePayload('opened') });
    expect(result.body).toMatchObject({ action: 'enqueued' });
    expect((await tasks())[0]).toMatchObject({ command: 'pipeline:format' });
  });

  it('issues.closed → 只推进状态机，不建任务', async () => {
    await seedRepo();
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: 7 });
    const h = harness();
    const result = await deliver(h, { deliveryId: 'd-closed', event: 'issues', payload: issuePayload('closed') });
    expect(result.body).toMatchObject({ action: 'ignored' });
    expect(await tasks()).toHaveLength(0);
    const row = await loadPipeline(db.pool, { repo: REPO, issueNumber: 7 });
    expect(row).toMatchObject({ stage: 'closed', state: 'closed' });
  });
});

describe('阶段闸门（§8）', () => {
  it('无行 → 放行命令任务，并懒创建 agent/ready 行（§1.3）', async () => {
    await seedRepo();
    const h = harness();
    const result = await deliver(h, {
      deliveryId: 'd-norow',
      event: 'issue_comment',
      payload: commentPayload({ body: '@pi-bot /review-pr 看下' }),
    });
    expect(result.body).toMatchObject({ action: 'enqueued' });
    expect(h.sends.map((send) => send['command'])).toEqual(['/review-pr']);
    const row = await loadPipeline(db.pool, { repo: REPO, issueNumber: 7 });
    expect(row).toMatchObject({ stage: 'agent', state: 'ready' });
  });

  it('ready → 正常建命令任务', async () => {
    await seedRepo();
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: 7 }, { stage: 'agent', state: 'ready' });
    const h = harness();
    await deliver(h, {
      deliveryId: 'd-ready',
      event: 'issue_comment',
      payload: commentPayload({ body: '@pi-bot /review-pr 看下' }),
    });
    expect(h.sends.map((send) => send['command'])).toEqual(['/review-pr']);
  });

  it('format/awaiting_info → 命令被拦，只产 pipeline:notice（不建命令任务）', async () => {
    await seedRepo();
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: 7 }, { stage: 'format', state: 'awaiting_info' });
    const h = harness();
    const result = await deliver(h, {
      deliveryId: 'd-awaiting',
      event: 'issue_comment',
      payload: commentPayload({ body: '@pi-bot /review-pr 看下' }),
    });
    expect(result.body).toMatchObject({ action: 'enqueued' });
    expect(h.sends.map((send) => send['command'])).toEqual(['pipeline:notice']);
    const rows = await tasks();
    expect(rows.map((row) => row['command'])).toEqual(['pipeline:notice']);
    expect(rows[0]).toMatchObject({ source: 'pipeline' });
    // 闸门回执的时间戳落库（限速用）
    const row = await loadPipeline(db.pool, { repo: REPO, issueNumber: 7 });
    expect(row?.gateNoticeAt?.toISOString()).toBe(NOW.toISOString());
  });

  it('同一小时内的第二条 @ 只打 eyes（回执限速，§8）', async () => {
    await seedRepo();
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: 7 }, { stage: 'format', state: 'awaiting_info' });
    const h = harness();
    await deliver(h, {
      deliveryId: 'd-rate-1',
      event: 'issue_comment',
      payload: commentPayload({ body: '@pi-bot /review-pr 一', commentId: 601 }),
    });
    await deliver(h, {
      deliveryId: 'd-rate-2',
      event: 'issue_comment',
      payload: commentPayload({ body: '@pi-bot /review-pr 二', commentId: 602 }),
    });
    expect(h.sends.map((send) => send['command'])).toEqual(['pipeline:notice']);
    // 两次都打了 eyes（回执可以省，回应不能省）
    expect(h.eyes).toHaveLength(2);
  });

  it('format/running → 只打 eyes，零任务（回执是噪音）', async () => {
    await seedRepo();
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: 7 }, { stage: 'format', state: 'running' });
    const h = harness();
    const result = await deliver(h, {
      deliveryId: 'd-running',
      event: 'issue_comment',
      payload: commentPayload({ body: '@pi-bot /review-pr 看下' }),
    });
    expect(result.body).toMatchObject({ action: 'ignored' });
    expect(h.sends).toHaveLength(0);
    expect(await tasks()).toHaveLength(0);
    expect(h.eyes).toHaveLength(1);
  });

  it('blocked → notice（提示用 /recheck --force 或 /pipeline next）', async () => {
    await seedRepo();
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: 7 }, { stage: 'classify', state: 'blocked' });
    const h = harness();
    await deliver(h, {
      deliveryId: 'd-blocked',
      event: 'issue_comment',
      payload: commentPayload({ body: '@pi-bot /review-pr 看下' }),
    });
    expect(h.sends.map((send) => send['command'])).toEqual(['pipeline:notice']);
  });

  it('closed → 静默（不建任务、不打 eyes）', async () => {
    await seedRepo();
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: 7 }, {
      stage: 'closed',
      state: 'closed',
      closedAt: NOW,
    });
    const h = harness();
    const result = await deliver(h, {
      deliveryId: 'd-closed-cmd',
      event: 'issue_comment',
      payload: commentPayload({ body: '@pi-bot /review-pr 看下' }),
    });
    expect(result.body).toMatchObject({ action: 'ignored' });
    expect(h.sends).toHaveLength(0);
    expect(h.eyes).toHaveLength(0);
  });

  it('PR 完全不受闸门影响（同样的 issue 号哪怕在 awaiting_info 也照常建命令任务）', async () => {
    await seedRepo();
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: 7 }, { stage: 'format', state: 'awaiting_info' });
    const h = harness();
    const result = await deliver(h, {
      deliveryId: 'd-pr',
      event: 'issue_comment',
      payload: commentPayload({ body: '@pi-bot /review-pr 看下', pullRequest: true }),
    });
    expect(result.body).toMatchObject({ action: 'enqueued' });
    expect(h.sends.map((send) => send['command'])).toEqual(['/review-pr']);
    const rows = await tasks();
    expect(rows[0]).toMatchObject({ command: '/review-pr', source: 'command' });
  });
});

describe('评论补充（E4 评论优先，§16.2）', () => {
  it('format/awaiting_info + 作者普通评论 → 立即重跑，锚含 commentId，state 回 pending', async () => {
    await seedRepo();
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: 7 }, { stage: 'format', state: 'awaiting_info' });
    const h = harness();
    const result = await deliver(h, {
      deliveryId: 'd-supplement',
      event: 'issue_comment',
      payload: commentPayload({ body: '补上复现步骤：1. 打开 2. 点击', login: 'author', commentId: 777 }),
    });

    expect(result.body).toMatchObject({ action: 'enqueued' });
    expect(h.sends.map((send) => send['command'])).toEqual(['pipeline:format']);
    const rows = await tasks();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['target_supplement']).toEqual([
      { commentId: 777, author: 'author', body: '补上复现步骤：1. 打开 2. 点击', at: NOW.toISOString() },
    ]);
    const row = await loadPipeline(db.pool, { repo: REPO, issueNumber: 7 });
    expect(row?.state).toBe('pending');
    expect(row?.infoRequestedAt).toBeNull();
    expect(row?.lastRecheckAt?.toISOString()).toBe(NOW.toISOString());
  });

  it('同一条评论的变化会换锚（不同 commentId → 两条任务；同一条重投 → 幂等）', async () => {
    await seedRepo();
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: 7 }, { stage: 'format', state: 'awaiting_info' });
    const h = harness();
    const payload = { body: '补充一下', login: 'author', commentId: 801 };
    await deliver(h, { deliveryId: 'd-s1', event: 'issue_comment', payload: commentPayload(payload) });
    // 同一条评论（内容与 id 都一样）再投一次：幂等键命中，不新增任务
    await deliver(h, { deliveryId: 'd-s2', event: 'issue_comment', payload: commentPayload(payload) });
    expect(await tasks()).toHaveLength(1);

    // 换一条评论：状态已被打回 pending，需要再回到 awaiting_info 才会重跑
    await db.sql(`update issue_pipeline set state = 'awaiting_info', info_requested_at = now()`);
    await deliver(h, {
      deliveryId: 'd-s3',
      event: 'issue_comment',
      payload: commentPayload({ ...payload, commentId: 802 }),
    });
    expect(await tasks()).toHaveLength(2);
  });

  it('评论触发后的 120s 内，issues.edited 让位（§16.2 第 3 条）', async () => {
    await seedRepo();
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: 7 }, { stage: 'format', state: 'awaiting_info' });
    const h = harness();
    await deliver(h, {
      deliveryId: 'd-yield-1',
      event: 'issue_comment',
      payload: commentPayload({ body: '补充信息', login: 'author', commentId: 901 }),
    });
    const before = await tasks();
    expect(before).toHaveLength(1);

    // 同一时刻的编辑（< 120s）→ 不再单独触发重跑
    const edit = await deliver(h, { deliveryId: 'd-yield-2', event: 'issues', payload: issuePayload('edited') });
    expect(edit.body).toMatchObject({ action: 'ignored' });
    expect(await tasks()).toHaveLength(1);
  });

  it('classify/awaiting_info 的普通（非 managers）评论不触发重分类', async () => {
    await seedRepo();
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: 7 }, { stage: 'classify', state: 'awaiting_info' });
    const h = harness();
    const result = await deliver(h, {
      deliveryId: 'd-cls-author',
      event: 'issue_comment',
      payload: commentPayload({ body: '我是作者，补充一下', login: 'author', association: 'NONE' }),
    });
    expect(result.body).toMatchObject({ action: 'ignored' });
    expect(h.sends).toHaveLength(0);
  });

  it('classify/awaiting_info + managers 评论 → 重跑分类（info_requested_at 保持 NULL）', async () => {
    await seedRepo();
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: 7 }, { stage: 'classify', state: 'awaiting_info' });
    const h = harness();
    await deliver(h, {
      deliveryId: 'd-cls-manager',
      event: 'issue_comment',
      payload: commentPayload({ body: '这个是缺陷，证据在 src/a.ts:10', login: 'alice', association: 'MEMBER' }),
    });
    expect(h.sends.map((send) => send['command'])).toEqual(['pipeline:classify']);
    const row = await loadPipeline(db.pool, { repo: REPO, issueNumber: 7 });
    expect(row?.state).toBe('pending');
    expect(row?.infoRequestedAt).toBeNull();
  });

  it('评论补充重跑时 target_supplement 整体替换（最多 3 条）', async () => {
    await seedRepo();
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: 7 }, { stage: 'format', state: 'awaiting_info' });
    const h = harness();
    for (const [index, commentId] of [11, 12, 13, 14].entries()) {
      if (index > 0) {
        await db.sql(`update issue_pipeline set state = 'awaiting_info', info_requested_at = now()`);
      }
      await deliver(h, {
        deliveryId: `d-multi-${String(commentId)}`,
        event: 'issue_comment',
        payload: commentPayload({ body: `补充 ${String(commentId)}`, login: 'author', commentId }),
      });
    }
    const rows = await db.sql(
      `select target_supplement from tasks order by queued_at desc, id desc limit 1`,
    );
    const supplements = rows[0]?.['target_supplement'] as Array<Record<string, unknown>>;
    expect(supplements.map((item) => item['commentId'])).toEqual([12, 13, 14]);
  });
});

describe('非 issue 的事件与回执', () => {
  it('普通评论（既没命令也没 @）在 ready 之后不建任务（交回 Agent 自己处理）', async () => {
    await seedRepo();
    await ensurePipeline(db.pool, { repo: REPO, issueNumber: 7 }, { stage: 'agent', state: 'ready' });
    const h = harness();
    const result = await deliver(h, {
      deliveryId: 'd-plain-ready',
      event: 'issue_comment',
      payload: commentPayload({ body: '顺便问一句，这个什么时候上线？', login: 'author' }),
    });
    expect(result.body).toMatchObject({ action: 'ignored' });
    expect(h.sends).toHaveLength(0);
  });

  it('限速窗口过后（> 1 小时）可以再发一条回执', async () => {
    await seedRepo();
    await db.sql(
      `insert into issue_pipeline (repo, issue_number, stage, state, gate_notice_at)
       values ($1, 7, 'format', 'awaiting_info', $2)`,
      [REPO, new Date(NOW.getTime() - HOUR - 1000)],
    );
    const h = harness();
    await deliver(h, {
      deliveryId: 'd-notice-again',
      event: 'issue_comment',
      payload: commentPayload({ body: '@pi-bot /review-pr 看下' }),
    });
    expect(h.sends.map((send) => send['command'])).toEqual(['pipeline:notice']);
  });
});

/**
 * P1-1：评论优先的**反向**（`docs/test-plan-fixed-pipeline.md` §6.1，§16.2 第 3 条末句
 * 「反过来，评论本身仍然立即触发」）。
 *
 * 两条实现事实决定了本用例的形状（写用例时逐行确认过，见 `webhook.ts`）：
 *  - 冷却只挡编辑：`pipelineTransitionFor()` 仅在 `action === 'edited'` 时读
 *    `recheckCooldownElapsed(lastRecheckAt, …)`；评论走 `decideSupplementOutcome()`，那里没有冷却判断；
 *  - 但 `issues.edited` 自己会把行推进成 `format/pending`，而评论在 `pending` / `running` 下按 §8
 *    是「正在跑 → 只打 eyes，不建任务」。所以「编辑先到、紧接着评论」要能看到第 2 行任务，
 *    必须让编辑那一轮先跑完（不通过 → 回到 `format/awaiting_info`）——这就是下面那行 UPDATE
 *    模拟的一步（与 `WH::同一条评论的变化会换锚` 用同一手法）。
 */
describe('评论优先的反向（P1-1）', () => {
  it('issues.edited 先到（冷却起点 = NOW），这一轮跑完后作者评论仍立即触发（第 2 行仍是 pipeline:format）', async () => {
    await seedRepo();
    await ensurePipeline(
      db.pool,
      { repo: REPO, issueNumber: 7 },
      { stage: 'format', state: 'awaiting_info', infoRequestedAt: NOW },
    );
    const h = harness();

    // ① 编辑先到：自己触发一轮重跑
    const edit = await deliver(h, { deliveryId: 'd-rev-1', event: 'issues', payload: issuePayload('edited') });
    expect(edit.body).toMatchObject({ action: 'enqueued' });
    const afterEdit = await tasks();
    expect(afterEdit).toHaveLength(1);
    expect(afterEdit[0]).toMatchObject({ command: 'pipeline:format', source: 'pipeline' });

    // 编辑把这行推进成 `format/pending`，并把冷却起点写成 NOW（120s 从这里算）
    const edited = await loadPipeline(db.pool, { repo: REPO, issueNumber: 7 });
    expect(edited).toMatchObject({ stage: 'format', state: 'pending' });
    expect(edited?.lastRecheckAt?.toISOString()).toBe(NOW.toISOString());

    // ② 编辑那一轮跑完但不通过 → 回到 awaiting_info（`last_recheck_at` 仍是 NOW，冷却窗口没走完）
    await db.sql(
      `update issue_pipeline set state = 'awaiting_info', info_requested_at = now()
        where repo = $1 and issue_number = 7`,
      [REPO],
    );

    // ③ 同一时刻（< 120s）作者补了一条评论：冷却不该挡评论
    const comment = await deliver(h, {
      deliveryId: 'd-rev-2',
      event: 'issue_comment',
      payload: commentPayload({ body: '补充：只在登录后第一次请求时报 500', login: 'author', commentId: 1301 }),
    });
    expect(comment.body).toMatchObject({ action: 'enqueued' });

    const rows = await tasks();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ command: 'pipeline:format', source: 'pipeline' });
    // 补充正文真的进了第 2 行（不是「建了个空任务」）
    expect(rows[1]?.['target_supplement']).toEqual([
      {
        commentId: 1301,
        author: 'author',
        body: '补充：只在登录后第一次请求时报 500',
        at: NOW.toISOString(),
      },
    ]);
    const afterComment = await loadPipeline(db.pool, { repo: REPO, issueNumber: 7 });
    expect(afterComment?.state).toBe('pending');
    expect(afterComment?.infoRequestedAt).toBeNull();

    // ④ 冷却窗口的**正向**在同一行上再确认一次：评论之后的编辑让位，任务数不涨
    const secondEdit = await deliver(h, {
      deliveryId: 'd-rev-3',
      event: 'issues',
      payload: issuePayload('edited'),
    });
    expect(secondEdit.body).toMatchObject({ action: 'ignored' });
    expect(await tasks()).toHaveLength(2);
  });
});

/**
 * P1-4：V10「全量切换 / 不可绕过」（§16.1 第 3 条）。
 *
 * ① `triggers.enabled=false` 也挡不住流水线（`webhook.ts` 只取 `triggers` 的别名、不读 `enabled`）；
 * ② 「不存在 `auto:triage` 任务分支」由源码级用例钉（`no-auto-triage.test.ts`，照 `no-merge.test.ts` 的范式）。
 */
describe('V10 不可绕过：triggers.enabled=false 不影响流水线（P1-4）', () => {
  it('triggers.enabled=false + issues.opened → 仍然建 pipeline:format（source=pipeline）', async () => {
    await seedRepo({
      settings: { ...VALID_SETTINGS, triggers: { enabled: false } },
    });
    const h = harness();
    const result = await deliver(h, { deliveryId: 'd-trig-off', event: 'issues', payload: issuePayload('opened') });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ action: 'enqueued' });
    expect(h.sends).toEqual([{ taskId: expect.any(String), command: 'pipeline:format', repo: REPO }]);

    const rows = await tasks();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ command: 'pipeline:format', source: 'pipeline' });

    const row = await loadPipeline(db.pool, { repo: REPO, issueNumber: 7 });
    expect(row).toMatchObject({ stage: 'format', state: 'pending' });
  });
});
