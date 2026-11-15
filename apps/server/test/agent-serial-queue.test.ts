/**
 * 串行 / 幂等 / 会话复用（真 PG + 假 RACP host + 整台应用装配）。
 *
 * 覆盖 `docs/test-plan-issue-agent.md`：
 *  - L-01：同一句话第二次 @ → `turn/start` **0 次**、不建新任务；
 *  - R-02：幂等命中即「不建任务、不调模型」；
 *  - R-03 / X-14：同 issue 3 条消息**全部入队**（不是被 `singletonKey` 丢掉 2 条），按
 *    `created_at` 串行执行；
 *  - 会话复用：两次 @ 同一个 issue → 同一个 `session_id`，`agent_sessions.turns` 递增；
 *  - 需求「上次失败不参与去重」：`failed` 的同一 fingerprint 再投必须放行成 `queued`，
 *    而 `queued` / `running` / `done` 仍然判 duplicate（否则一次故障会永久锁死这条内容）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApplication } from '../src/app/index.ts';
import type { Application } from '../src/app/index.ts';
import {
  claimNextForIssue,
  insertAgentTask,
  insertMessage,
  markMessage,
} from '../src/agent/index.ts';
import { createPgRunStore } from '../src/worker/index.ts';
import {
  E2E_WEBHOOK_SECRET,
  FakeRacpHost,
  createCountingGithubApi,
  createFakePorts,
  createFakeQueue,
  e2eConfig,
  poolWithNoopEnd,
  quietMetrics,
  signBody,
  stubMetricsServer,
} from './helpers/e2e-harness.ts';
import type { FakeQueue } from './helpers/e2e-harness.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';
import { resetAgentTables } from './helpers/agent-harness.ts';
import { validSettingsJson } from './helpers/repo-settings.ts';

const REPO = 'acme/widgets';
const ISSUE = 21;

/** 一个**合法**信封：让 run 收尾成 `succeeded`（否则消息会落 failed，串行断言就不好读）。 */
const ENVELOPE_TEXT = [
  '好的，我看过了。',
  '',
  '```json',
  JSON.stringify({
    verdict: { kind: 'issue', labels: [], evidence: [] },
    actions: [],
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
  }),
  '```',
].join('\n');

let db: TestDb;
let app: Application;
let host: FakeRacpHost;
let queue: FakeQueue;

beforeAll(async () => {
  db = await openTestDb();
  host = await FakeRacpHost.start({ script: { text: ENVELOPE_TEXT, terminal: 'turn.completed' } });
  queue = createFakeQueue();
  const github = createCountingGithubApi();
  const fakePorts = createFakePorts({ endpoint: host.endpoint(), github: github.api });

  app = createApplication(e2eConfig(), {
    pool: poolWithNoopEnd(db.pool),
    queue,
    ports: { ...fakePorts.ports, store: createPgRunStore({ pool: db.pool }) },
    metrics: quietMetrics(),
    metricsServer: stubMetricsServer(),
    ack: { addEyesReaction: async () => undefined },
    skipSchedules: true,
  });
  await app.start();
}, 60_000);

afterAll(async () => {
  await app?.stop();
  await host?.close();
  await db?.close();
}, 60_000);

beforeEach(async () => {
  await resetAgentTables(db);
  host.calls.length = 0;
  queue.record.sent.length = 0;
  await db.pool.query(
    `insert into repos (repo_full_name, enabled, dry_run, settings, settings_valid)
     values ($1, true, true, $2::jsonb, true)`,
    [REPO, validSettingsJson({ agent: { managers: ['alice'] } })],
  );
});

let deliverySeq = 0;

/** 投一条「@pi-bot 正文」的评论。 */
async function postMention(
  body: string,
  input: { readonly commentId?: number; readonly issue?: number } = {},
): Promise<{ action: string; duplicate: boolean; taskId: string | null }> {
  deliverySeq += 1;
  const payload = JSON.stringify({
    action: 'created',
    repository: { full_name: REPO },
    sender: { login: 'alice', type: 'User' },
    issue: {
      number: input.issue ?? ISSUE,
      updated_at: '2026-06-01T00:00:00Z',
      title: '登录按钮没反应',
      body: '复现步骤：点一下登录',
      author_association: 'OWNER',
    },
    comment: {
      id: input.commentId ?? deliverySeq,
      body,
      author_association: 'OWNER',
      user: { login: 'alice', type: 'User' },
    },
  });
  const response = await app.server.inject({
    method: 'POST',
    url: '/webhook',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': `dlv-serial-${String(deliverySeq)}`,
      'x-github-event': 'issue_comment',
      'x-hub-signature-256': signBody(E2E_WEBHOOK_SECRET, payload),
    },
    payload,
  });
  const json = response.json<{ action: string; duplicate: boolean; taskId: string | null }>();
  return { action: json.action, duplicate: json.duplicate, taskId: json.taskId };
}

async function messages(): Promise<Array<Record<string, unknown>>> {
  return db.sql('select * from agent_messages order by created_at, fingerprint');
}

async function tasks(): Promise<Array<Record<string, unknown>>> {
  return db.sql('select * from tasks order by queued_at');
}

function turnStarts(): number {
  return host.calls.filter((call) => call.method === 'turn/start').length;
}

describe('L-01 / R-02：人消息永久幂等', () => {
  it('同一句话第二次 @ → duplicate、任务不增、`turn/start` 只发生一次', async () => {
    const first = await postMention('@pi-bot 打个标签', { commentId: 1001 });
    expect(first.action).toBe('enqueued');

    const before = await tasks();
    expect(before).toHaveLength(1);
    await app.executeTask({ taskId: String(before[0]?.['id']) });
    expect(turnStarts()).toBe(1);

    const again = await postMention('@pi-bot 打个标签', { commentId: 1002 });
    expect(again.action).toBe('duplicate');
    expect(again.duplicate).toBe(true);
    expect(await tasks()).toHaveLength(1);
    expect(await messages()).toHaveLength(1);
    // 幂等命中不调模型：`turn/start` 仍是 1 次（R-02）
    expect(turnStarts()).toBe(1);
  });

  it('L-02：标点 / 行内空白差异**不再**等价（口径收窄到「去首尾空白 + 合并连续空行」）', async () => {
    /**
     * 口径依据（`docs/requirements.html:915`）：「比较规范化后的正文：去首尾空白、合并连续空行；
     * **不做语义近似判断**——措辞不同就是不同内容，宁可多处理一次，也不能把新问题误判成旧问题」。
     *
     * 旧实现在 normalize 里还额外做了「摘 `@别名` / 压行内空白 / 删全部标点 / 抹代码区」，
     * 于是「打个标签」与「打个标签！」被判成同一句话，新问题会被永久吞掉 —— 这正是 P0-3 修的缺陷。
     *
     * 现在只有两种情况仍是同一条消息：正文**完全一致**，或者只差首尾空白 / 连续空行。
     * v2.1 的评论路径直接拿评论原文算指纹（`webhook-v21.ts:903-915`，不经 `stripAliases`），
     * 所以行内多个空格也算「不同内容」。
     */
    await postMention('@pi-bot 打个标签', { commentId: 1101 });

    // 只多一个感叹号：按需求必须是**新**消息。
    const punctuationOnly = await postMention('@pi-bot 打个标签！', { commentId: 1102 });
    expect(punctuationOnly.action).toBe('enqueued');

    // 行内多几个空格：同样是不同内容（differ 不是「首尾空白」）。
    const extraSpaces = await postMention('@pi-bot    打个标签', { commentId: 1103 });
    expect(extraSpaces.action).toBe('enqueued');
    expect(await messages()).toHaveLength(3);

    // 完全一致 → 真重复。
    const identical = await postMention('@pi-bot 打个标签', { commentId: 1104 });
    expect(identical.action).toBe('duplicate');
    expect(await messages()).toHaveLength(3);

    // 只差首尾空白 → 归一化后被 trim 掉，仍是同一条。
    const trailingSpace = await postMention('  @pi-bot 打个标签  ', { commentId: 1105 });
    expect(trailingSpace.action).toBe('duplicate');
    expect(await messages()).toHaveLength(3);
  });

  it('换一种说法 → 新消息（P3 的已知副作用：同一句话只烧一次钱）', async () => {
    await postMention('@pi-bot 打个标签', { commentId: 1201 });
    const other = await postMention('@pi-bot 帮我重新打标签', { commentId: 1202 });
    expect(other.action).toBe('enqueued');
    expect(await messages()).toHaveLength(2);
  });
});

describe('R-03 / X-14：同 issue 串行', () => {
  it('连发 3 条 → 全部入队；一次只跑一条，按 created_at 顺序执行', async () => {
    await postMention('@pi-bot 第一条', { commentId: 2001 });
    await postMention('@pi-bot 第二条', { commentId: 2002 });
    await postMention('@pi-bot 第三条', { commentId: 2003 });

    const queued = await messages();
    expect(queued).toHaveLength(3);
    // 只有最老的一条被领走（其余排队，不是被丢掉）
    expect(queued.map((row) => row['status'])).toEqual(['running', 'queued', 'queued']);
    expect(await tasks()).toHaveLength(1);

    // 一条一条跑：每跑完一条，下一条立刻被领走
    for (let index = 0; index < 3; index += 1) {
      const pending = (await tasks()).filter((row) => row['status'] === 'queued');
      expect(pending).toHaveLength(1);
      await app.executeTask({ taskId: String(pending[0]?.['id']) });
    }

    expect(turnStarts()).toBe(3);
    expect(await tasks()).toHaveLength(3);
    expect((await messages()).map((row) => row['status'])).toEqual(['done', 'done', 'done']);

    // runs 的时间区间不重叠（严格串行）
    const runs = await db.sql('select started_at, ended_at from runs order by started_at');
    expect(runs.length).toBeGreaterThanOrEqual(3);
    const firstThree = runs.slice(0, 3);
    for (let index = 1; index < firstThree.length; index += 1) {
      const previousEnd = Date.parse(String(firstThree[index - 1]?.['ended_at']));
      const currentStart = Date.parse(String(firstThree[index]?.['started_at']));
      expect(currentStart).toBeGreaterThanOrEqual(previousEnd);
    }
  });

  it('不同 issue 可以并行（串行键是 issue 粒度，不是仓库粒度）', async () => {
    await postMention('@pi-bot 一号 issue', { commentId: 3001, issue: 31 });
    await postMention('@pi-bot 二号 issue', { commentId: 3002, issue: 32 });

    const running = (await messages()).filter((row) => row['status'] === 'running');
    expect(running).toHaveLength(2);
    expect(new Set(running.map((row) => Number(row['issue_number'])))).toEqual(new Set([31, 32]));
  });
});

describe('会话复用：一个 issue 一个持久会话', () => {
  it('两次 @ 复用同一个 session_id，`agent_sessions.turns` 递增', async () => {
    await postMention('@pi-bot 第一句', { commentId: 4001 });
    const firstTask = (await tasks())[0];
    await app.executeTask({ taskId: String(firstTask?.['id']) });

    const afterFirst = await db.sql('select * from agent_sessions where repo = $1 and issue_number = $2', [
      REPO,
      ISSUE,
    ]);
    expect(afterFirst).toHaveLength(1);
    const firstSessionId = afterFirst[0]?.['session_id'];
    expect(typeof firstSessionId).toBe('string');
    expect(Number(afterFirst[0]?.['turns'])).toBe(1);

    await postMention('@pi-bot 第二句', { commentId: 4002 });
    const secondTask = (await tasks()).find((row) => row['status'] === 'queued');
    await app.executeTask({ taskId: String(secondTask?.['id']) });

    const afterSecond = await db.sql('select * from agent_sessions where repo = $1 and issue_number = $2', [
      REPO,
      ISSUE,
    ]);
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]?.['session_id']).toBe(firstSessionId);
    expect(Number(afterSecond[0]?.['turns'])).toBe(2);
    // 第一轮 session/create，第二轮走 session/attach（不是重新开一个会话）
    expect(host.calls.filter((call) => call.method === 'session/create')).toHaveLength(1);
    expect(host.calls.filter((call) => call.method === 'session/attach').length).toBeGreaterThanOrEqual(1);
  });

  it('agent 任务的提示词里带「这一条消息」（原话），任务段仍是 `buildTaskPrompt`', async () => {
    await postMention('@pi-bot 帮我看看格式', { commentId: 4101 });
    const task = (await tasks())[0];
    await app.executeTask({ taskId: String(task?.['id']) });

    const turnStart = host.calls.find((call) => call.method === 'turn/start');
    const text = String((turnStart?.params as { input?: { text?: string } } | undefined)?.input?.text ?? '');
    expect(text).toContain('## 这一条消息');
    expect(text).toContain('帮我看看格式');
    expect(text).not.toContain('@pi-bot');
    // 任务提示词只剩「这次要做什么 + 约束 + 输出契约」：
    // 身份说明已搬到 system 通道（`session/create` 的 `systemPrompt`），这里不该再出现。
    expect(text).toContain('这次要做的事：处理');
    expect(text).not.toContain('你是 pi-bot');
    expect(text).toContain('```json');
  });
});

/**
 * 需求「上次失败不参与去重」（`docs/requirements.html` 第 917 行）在存储层的落地。
 *
 * 这一组用例直接打 `insertMessage` / `markMessage`（不起 RACP、不跑任务）：要断言的是
 * **`agent_messages` 那一行的 status 与主键占用**，而不是上层返回体。
 */
describe('上次失败不参与去重（存储层）', () => {
  const issue = 77;

  /** 造一个本组用例专用的 fingerprint（跨用例靠 `beforeEach` 的清库隔开）。 */
  function fp(name: string): string {
    return `p02-${name}`;
  }

  /** 以「同一条内容」的姿态再投一次（kind / body / 评论 id 都一样）。 */
  async function insertContent(fingerprint: string) {
    return insertMessage(db.pool, {
      key: { repo: REPO, issueNumber: issue, fingerprint },
      kind: 'mention',
      commentId: 9001,
      body: '同一句话',
      actorLogin: 'alice',
    });
  }

  async function rowOf(fingerprint: string): Promise<Record<string, unknown> | undefined> {
    const rows = await db.sql(
      'select status, created_at, updated_at from agent_messages where repo = $1 and issue_number = $2 and fingerprint = $3',
      [REPO, issue, fingerprint],
    );
    expect(rows.length).toBeLessThanOrEqual(1);
    return rows[0];
  }

  /** 时间列 → 毫秒数：`pg` 给 `Date`（毫秒精度），`db.sql` 也可能给字符串，两种都收。 */
  function msOf(value: unknown): number {
    return value instanceof Date ? value.getTime() : Date.parse(String(value));
  }

  it('failed 之后同 fingerprint 再投 → inserted=true、status 回 queued、updated_at 刷新', async () => {
    const fingerprint = fp('failed');
    const first = await insertContent(fingerprint);
    expect(first.inserted).toBe(true);
    expect(first.row?.status).toBe('queued');
    const createdAt = first.row?.createdAt;

    await markMessage(db.pool, { repo: REPO, issueNumber: issue, fingerprint }, 'running');
    await markMessage(db.pool, { repo: REPO, issueNumber: issue, fingerprint }, 'failed');
    expect((await rowOf(fingerprint))?.['status']).toBe('failed');
    // 把 updated_at 推到一小时前：同一毫秒内 `now()` 可能相等，不断言「变大」就测不出刷新。
    await db.pool.query(
      `update agent_messages set updated_at = now() - interval '1 hour'
       where repo = $1 and issue_number = $2 and fingerprint = $3`,
      [REPO, issue, fingerprint],
    );

    const retry = await insertContent(fingerprint);
    expect(retry.inserted).toBe(true);
    expect(retry.row?.status).toBe('queued');

    const row = await rowOf(fingerprint);
    expect(row?.['status']).toBe('queued');
    // 重置必须刷新 updated_at（否则「什么时候重试过」就丢了；一小时前的那次更新证明它被写回）
    expect(msOf(row?.['updated_at'])).toBeGreaterThan(msOf(createdAt));
    expect(Date.now() - msOf(row?.['updated_at'])).toBeLessThan(60_000);
    // created_at 不动：重试保留它在队列里的原始位置
    expect(msOf(row?.['created_at'])).toBe(msOf(createdAt));
  });

  it('done 之后同 fingerprint 再投 → inserted=false，状态仍 done（幂等不放行）', async () => {
    const fingerprint = fp('done');
    await insertContent(fingerprint);
    await markMessage(db.pool, { repo: REPO, issueNumber: issue, fingerprint }, 'running');
    await markMessage(db.pool, { repo: REPO, issueNumber: issue, fingerprint }, 'done');

    const again = await insertContent(fingerprint);
    expect(again.inserted).toBe(false);
    expect(again.row?.status).toBe('done');
    expect((await rowOf(fingerprint))?.['status']).toBe('done');
  });

  it('queued / running 时同 fingerprint 再投 → inserted=false，状态不变', async () => {
    const queuedFp = fp('queued');
    await insertContent(queuedFp);
    const againQueued = await insertContent(queuedFp);
    expect(againQueued.inserted).toBe(false);
    expect(againQueued.row?.status).toBe('queued');

    const runningFp = fp('running');
    await insertContent(runningFp);
    await markMessage(db.pool, { repo: REPO, issueNumber: issue, fingerprint: runningFp }, 'running');
    const againRunning = await insertContent(runningFp);
    expect(againRunning.inserted).toBe(false);
    expect(againRunning.row?.status).toBe('running');

    expect((await rowOf(queuedFp))?.['status']).toBe('queued');
    expect((await rowOf(runningFp))?.['status']).toBe('running');
    // 两条都在，没有因为重投多出第三行
    const all = await db.sql('select fingerprint from agent_messages where repo = $1 and issue_number = $2', [
      REPO,
      issue,
    ]);
    expect(all).toHaveLength(2);
  });
});

describe('重试要真的再跑一次（任务面）', () => {
  const issue = 78;

  async function taskRows(): Promise<Array<Record<string, unknown>>> {
    return db.sql('select id, status, queued_at from tasks where repo = $1 and target_number = $2', [
      REPO,
      issue,
    ]);
  }

  function msOf(value: unknown): number {
    return value instanceof Date ? value.getTime() : Date.parse(String(value));
  }

  it('上一轮任务 failed/timed-out 时重投 → 同一任务回到 queued（不新建行、queued_at 不变）', async () => {
    const key = { repo: REPO, issueNumber: issue, fingerprint: 'p02-task' };
    const agentTask = { taskId: 'p02-task-a', key, kind: 'mention' as const, body: '同一句话', actorLogin: 'alice' };

    await insertMessage(db.pool, { key, kind: 'mention', commentId: 9101, body: '同一句话', actorLogin: 'alice' });
    expect((await insertAgentTask(db.pool, agentTask)).taskId).toBe('p02-task-a');
    // 上一轮跑失败（消息终态与任务终态一起写成失败）
    await db.pool.query(`update tasks set status = 'failed' where id = $1`, ['p02-task-a']);
    await markMessage(db.pool, key, 'running');
    await markMessage(db.pool, key, 'failed');
    const queuedAtBefore = (await taskRows())[0]?.['queued_at'];

    // 同内容再投 → 消息放行；dispatcher 领走后要建任务
    const retry = await insertMessage(db.pool, {
      key,
      kind: 'mention',
      commentId: 9102,
      body: '同一句话',
      actorLogin: 'alice',
    });
    expect(retry.inserted).toBe(true);
    expect((await claimNextForIssue(db.pool, { repo: REPO, issueNumber: issue }))?.status).toBe('running');

    const again = await insertAgentTask(db.pool, { ...agentTask, taskId: 'p02-task-b' });
    // 拿回上一轮的 id 才意味着「真的会重跑一次」；否则 dispatcher 会以为已投递，消息永远停在 running
    expect(again.taskId).toBe('p02-task-a');
    const rows = await taskRows();
    expect(rows).toHaveLength(1);
    /**
     * 任务行**保持 `failed`**：P0-2 只负责「让同内容重新被处理一次」，
     * 不负责改写 `tasks` 的状态机（`failed → queued` 的语义归重试策略 `decideRetry()` 与队列层，
     * 见 AGENTS §9）。`run-task` 按 taskId 直接开跑、不看 `tasks.status`，所以这行停在 `failed`
     * 不影响重跑；收尾时再被写成新的终态。
     *
     * 曾经把这里改成 `queued`（连 `insertTask` 一起 DO UPDATE），复核确认是多余改动：
     * 既改了终态语义，又没解决任何真实问题（旧 id 本来就能回填、dispatcher 照常入队）。
     */
    expect(rows[0]?.['status']).toBe('failed');
    // queued_at 是入队时写死的审计字段，任何路径都不改它（重跑次数记在 runs.attempt）
    expect(msOf(rows[0]?.['queued_at'])).toBe(msOf(queuedAtBefore));
  });

  it('上一轮任务 succeeded 时重投不放行 → 状态仍 succeeded，不重跑', async () => {
    const key = { repo: REPO, issueNumber: issue, fingerprint: 'p02-task-done' };
    const agentTask = { taskId: 'p02-task-c', key, kind: 'mention' as const, body: '同一句话', actorLogin: 'alice' };

    await insertMessage(db.pool, { key, kind: 'mention', commentId: 9201, body: '同一句话', actorLogin: 'alice' });
    expect((await insertAgentTask(db.pool, agentTask)).taskId).toBe('p02-task-c');
    await db.pool.query(`update tasks set status = 'succeeded' where id = $1`, ['p02-task-c']);
    await markMessage(db.pool, key, 'running');
    await markMessage(db.pool, key, 'done');

    const again = await insertAgentTask(db.pool, { ...agentTask, taskId: 'p02-task-d' });
    expect(again.taskId).toBe('p02-task-c');
    expect((await taskRows()).map((row) => row['status'])).toEqual(['succeeded']);
  });
});
