/**
 * 端到端（真 PG）：**webhook → tasks → run-task → 信封入库，GitHub 零副作用**。
 *
 * 这是 M0 的 DoD 主证据链（dev-plan §6 的两条 ⛔：`GitHub 零副作用` 与「幂等重投」的另一半）：
 *
 * ```
 * POST /webhook（真 HMAC 签名、真 raw body 解析、真去重 INSERT）
 *   → webhook_deliveries 1 行 · tasks 1 行 · boss.send 1 次
 *   → app.executeTask()（假 docker / 假 host / 假 GitHub，真 PG）
 *   → runs 1 行 succeeded · envelopes 1 行 valid · actions 0 行 · 非 GET 调用 0 次
 * ```
 *
 * 为什么不用 `handleWebhook()` 直接调：`/webhook` 的 raw body 解析器、验签、Fastify 注入
 * 恰好是「接错了也看不出来」的那一层；用 `inject` 才算端到端。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApplication } from '../src/app/index.ts';
import type { Application } from '../src/app/index.ts';
import { QUEUE } from '../src/queue/index.ts';
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
  readRunSnapshot,
  signBody,
  stubMetricsServer,
} from './helpers/e2e-harness.ts';
import type { CountingGithubApi, FakeQueue, FakeRacpHost as FakeHost } from './helpers/e2e-harness.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';
import { validSettingsJson } from './helpers/repo-settings.ts';

const REPO = 'acme/widgets';
const ISSUE_NUMBER = 7;
const DELIVERY_ID = 'e2e-dry-run-delivery-1';

/** 合法信封：一条 `comment` 动作（dry-run 下不该落 actions 行）。 */
const ENVELOPE_TEXT = [
  '看完了，信息齐全。',
  '```json',
  JSON.stringify({
    verdict: {
      kind: 'issue',
      labels: ['bug'],
      evidence: [{ rule: 'has-repro-steps', quote: '复现步骤：…', passed: true }],
    },
    actions: [{ intent: 'comment', body: '收到，信息齐全。' }],
    usage: { inputTokens: 1_200, outputTokens: 300, costUsd: 0.02 },
  }),
  '```',
].join('\n');

function issuesOpenedPayload(): string {
  return JSON.stringify({
    action: 'opened',
    issue: {
      number: ISSUE_NUMBER,
      updated_at: '2026-06-01T00:00:00.000Z',
      author_association: 'OWNER',
    },
    repository: { full_name: REPO },
    sender: { login: 'alice', type: 'User' },
  });
}

describe('e2e dry-run：webhook → worker → 信封（真 PG，GitHub 零副作用）', () => {
  let db: TestDb;
  let app: Application;
  let host: FakeHost;
  let queue: FakeQueue;
  let github: CountingGithubApi;

  beforeAll(async () => {
    db = await openTestDb();
    await db.truncate();
    await db.sql(
      `insert into repos (repo_full_name, enabled, dry_run, settings, settings_valid)
       values ($1, true, true, $2::jsonb, true)`,
      [REPO, validSettingsJson()],
    );

    host = await FakeRacpHost.start({ script: { text: ENVELOPE_TEXT } });
    queue = createFakeQueue();
    github = createCountingGithubApi();

    const fakePorts = createFakePorts({ endpoint: host.endpoint(), github: github.api });
    app = createApplication(e2eConfig(), {
      pool: poolWithNoopEnd(db.pool),
      queue,
      ports: {
        ...fakePorts.ports,
        // 真落库：runs / run_events / envelopes / actions 全走 PG
        store: createPgRunStore({ pool: db.pool }),
      },
      metrics: quietMetrics(),
      metricsServer: stubMetricsServer(),
      // 假的 ack：dry-run 下它一次都不该被调用
      ack: {
        addEyesReaction: async () => {
          throw new Error('dry-run 不该打 reaction');
        },
      },
    });
    await app.start();
  }, 60_000);

  afterAll(async () => {
    await app?.stop();
    await host?.close();
    await db?.close();
  }, 60_000);

  it('一条投递：deliveries 1 行 · tasks 1 行 · boss.send 1 次', async () => {
    const body = issuesOpenedPayload();
    const response = await app.server.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': DELIVERY_ID,
        'x-github-event': 'issues',
        'x-hub-signature-256': signBody(E2E_WEBHOOK_SECRET, body),
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    const accepted = response.json<{ action: string; taskId: string | null; duplicate: boolean }>();
    expect(accepted.action).toBe('enqueued');
    expect(accepted.duplicate).toBe(false);
    expect(accepted.taskId).not.toBeNull();

    // 1) 投递行
    const deliveries = await db.sql('select * from webhook_deliveries where delivery_id = $1', [
      DELIVERY_ID,
    ]);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.['signature_valid']).toBe(true);

    // 2) 任务行（command / actor / queued_at 在入队时写死，F9）
    const tasks = await db.sql('select * from tasks');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.['id']).toBe(accepted.taskId);
    // E1 全量切换后 issue 事件一律进三段流水线（老的判定任务已删除，§16.1 第 2 条）
    expect(tasks[0]?.['command']).toBe('pipeline:format');
    expect(tasks[0]?.['source']).toBe('pipeline');
    expect(tasks[0]?.['actor_login']).toBe('alice');
    expect(tasks[0]?.['status']).toBe('queued');

    // 3) 入队恰好一次（singletonKey = taskId）
    expect(queue.record.sent).toHaveLength(1);
    expect(queue.record.sent[0]?.name).toBe(QUEUE.runTask);
    expect(queue.record.sent[0]?.data.taskId).toBe(accepted.taskId);
  }, 30_000);

  it('跑一次任务：runs succeeded · envelopes valid=true · actions 0 行 · 非 GET 调用 0', async () => {
    const tasks = await db.sql('select id from tasks');
    const taskId = String(tasks[0]?.['id']);

    const report = await app.executeTask({ taskId });

    // 1) 报告层（worker 自己的结论）
    expect(report.outcome).toBe('succeeded');
    expect(report.failureClass).toBeNull();
    expect(report.dryRun).toBe(true);
    expect(report.envelope?.valid).toBe(true);
    expect(report.actions.map((action) => action.status)).toEqual(['dry-run']);

    // 2) 落库层（真 PG）
    const snapshot = await readRunSnapshot(db.sql, taskId);
    expect(snapshot.runs).toHaveLength(1);
    // worker 的 `RUN_OUTCOMES` 写 'succeeded'（`queries/sql.ts` 的归一函数同时认 'success'）
    expect(snapshot.runs[0]?.['outcome']).toBe('succeeded');
    expect(snapshot.runs[0]?.['session_id']).toBe('session-e2e');
    expect(snapshot.envelopes).toHaveLength(1);
    expect(snapshot.envelopes[0]?.['valid']).toBe(true);

    // ★ M0 ⛔：dry-run 下 actions 一行都不许有
    const allActions = await db.sql('select * from actions');
    expect(allActions).toHaveLength(0);

    // ★ M0 ⛔：GitHub 一次写都没发生（非 GET 计数 = 0）
    expect(github.nonGetCount()).toBe(0);
    // 连 GET 都没必要：dry-run 连「读现有评论」都不做
    expect(github.calls).toHaveLength(0);

    // 3) 装配确实连到了 host（否则上面全是空跑）
    expect(host.calls.map((call) => call.method)).toContain('turn/start');
    expect(host.calls.map((call) => call.method)).toContain('session/archive');

    // 贴给 PM 的证据行（`npx vitest run apps/server/test/e2e-dry-run.test.ts` 时可见）
    console.log(
      `[e2e-dry-run] deliveries=${String((await db.sql('select * from webhook_deliveries')).length)}` +
        ` tasks=${String((await db.sql('select * from tasks')).length)}` +
        ` bossSend=${String(queue.record.sent.length)}` +
        ` runs=${String(snapshot.runs.length)} outcome=${String(snapshot.runs[0]?.['outcome'])}` +
        ` envelopes=${String(snapshot.envelopes.length)} valid=${String(snapshot.envelopes[0]?.['valid'])}` +
        ` actions=${String(allActions.length)}` +
        ` githubNonGet=${String(github.nonGetCount())}` +
        ` hostOps=${host.calls.map((call) => call.method).join(',')}`,
    );
  }, 60_000);
});
