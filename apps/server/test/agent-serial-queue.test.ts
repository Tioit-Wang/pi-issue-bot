/**
 * 串行 / 幂等 / 会话复用（真 PG + 假 RACP host + 整台应用装配）。
 *
 * 覆盖 `docs/test-plan-issue-agent.md`：
 *  - L-01：同一句话第二次 @ → `turn/start` **0 次**、不建新任务；
 *  - R-02：幂等命中即「不建任务、不调模型」；
 *  - R-03 / X-14：同 issue 3 条消息**全部入队**（不是被 `singletonKey` 丢掉 2 条），按
 *    `created_at` 串行执行；
 *  - 会话复用：两次 @ 同一个 issue → 同一个 `session_id`，`agent_sessions.turns` 递增。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApplication } from '../src/app/index.ts';
import type { Application } from '../src/app/index.ts';
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

  it('L-02：归一化等价（多空格 / 标点 / 不同别名）→ 同一条消息', async () => {
    await postMention('@pi-bot 打个标签', { commentId: 1101 });
    const equivalent = await postMention('@pi-bot   打个标签！', { commentId: 1102 });
    expect(equivalent.action).toBe('duplicate');
    expect(await messages()).toHaveLength(1);
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

  it('agent 任务的提示词里带「这一条消息」（原话），系统段仍是 `buildTaskPrompt`', async () => {
    await postMention('@pi-bot 帮我看看格式', { commentId: 4101 });
    const task = (await tasks())[0];
    await app.executeTask({ taskId: String(task?.['id']) });

    const turnStart = host.calls.find((call) => call.method === 'turn/start');
    const text = String((turnStart?.params as { input?: { text?: string } } | undefined)?.input?.text ?? '');
    expect(text).toContain('## 这一条消息');
    expect(text).toContain('帮我看看格式');
    expect(text).not.toContain('@pi-bot');
    // 系统段还在（`buildTaskPrompt` 的身份行与输出契约）
    expect(text).toContain('你是 pi-bot');
    expect(text).toContain('```json');
  });
});
