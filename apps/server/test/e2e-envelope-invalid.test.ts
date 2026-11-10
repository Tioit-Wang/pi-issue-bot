/**
 * 端到端（真 PG）：**不合规信封**也必须入库，且不产生任何写动作。
 *
 * 为什么这条是 M0 的必测项（tech-plan §5.6 / plan §5）：
 *  - 信封不合规时**报错退出**看起来「更安全」，实际会把「模型没按格式给」变成一次静默失败 ——
 *    面板上看不到任何证据；正确做法是落 `envelopes(valid=false)` + `runs.failure_class='parse'`；
 *  - 同时**一条动作都不许执行**：校验失败的整封信封被视为不可信，`actions` 表 0 行、
 *    GitHub 非 GET 调用 0 次（与 dry-run 那条 ⛔ 同源）。
 *
 * 本用例用「`push_branch` 缺 `paths`」触发 Ajv 的 `oneOf` 失败（契约里 `push_branch` 必带
 * `paths`），而不是「根本没有 JSON」——后者只能测到「找不到信封」，测不到「找到了但不合规」。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
  readRunSnapshot,
  signBody,
  stubMetricsServer,
} from './helpers/e2e-harness.ts';
import type { CountingGithubApi, FakeRacpHost as FakeHost } from './helpers/e2e-harness.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

const REPO = 'acme/widgets';

/** 不合规信封：`push_branch` 缺 `paths`（契约要求非空数组）。 */
const INVALID_ENVELOPE_TEXT = [
  '修复完成。',
  '```json',
  JSON.stringify({
    verdict: {
      kind: 'issue',
      labels: ['bug'],
      evidence: [{ rule: 'has-repro-steps', quote: '复现步骤：…', passed: true }],
    },
    actions: [{ intent: 'push_branch', branch: 'bot/fix-7' }],
    usage: { inputTokens: 900, outputTokens: 200, costUsd: 0.01 },
  }),
  '```',
].join('\n');

function issuesOpenedPayload(): string {
  return JSON.stringify({
    action: 'opened',
    issue: { number: 21, updated_at: '2026-06-02T00:00:00.000Z', author_association: 'OWNER' },
    repository: { full_name: REPO },
    sender: { login: 'bob', type: 'User' },
  });
}

describe('e2e 信封不合规：envelopes.valid=false · actions 0 行 · failure_class=parse', () => {
  let db: TestDb;
  let app: Application;
  let host: FakeHost;
  let github: CountingGithubApi;

  beforeAll(async () => {
    db = await openTestDb();
    await db.truncate();
    await db.sql(
      `insert into repos (repo_full_name, enabled, dry_run, config, config_valid, config_error)
       values ($1, true, true, '{}'::jsonb, true, null)`,
      [REPO],
    );

    host = await FakeRacpHost.start({ script: { text: INVALID_ENVELOPE_TEXT } });
    github = createCountingGithubApi();
    const queue = createFakeQueue();
    const fakePorts = createFakePorts({ endpoint: host.endpoint(), github: github.api });

    app = createApplication(e2eConfig(), {
      pool: poolWithNoopEnd(db.pool),
      queue,
      ports: { ...fakePorts.ports, store: createPgRunStore({ pool: db.pool }) },
      metrics: quietMetrics(),
      metricsServer: stubMetricsServer(),
      ack: {
        addEyesReaction: async () => undefined,
      },
    });
    await app.start();

    const body = issuesOpenedPayload();
    const response = await app.server.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'e2e-invalid-envelope-delivery',
        'x-github-event': 'issues',
        'x-hub-signature-256': signBody(E2E_WEBHOOK_SECRET, body),
      },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
  }, 60_000);

  afterAll(async () => {
    await app?.stop();
    await host?.close();
    await db?.close();
  }, 60_000);

  it('不合规信封：valid=false、failure_class=parse、actions 0 行、非 GET 0 次', async () => {
    const tasks = await db.sql('select * from tasks');
    expect(tasks).toHaveLength(1);
    const taskId = String(tasks[0]?.['id']);

    const report = await app.executeTask({ taskId });

    // 1) 报告层：信封被判不合规，失败分类是 parse（不是 unknown / sandbox-*）
    expect(report.envelope?.valid).toBe(false);
    expect(report.envelope?.errors.length ?? 0).toBeGreaterThan(0);
    expect(report.envelope?.errors.some((issue) => issue.path.includes('/actions'))).toBe(true);
    expect(report.outcome).toBe('failed');
    expect(report.failureClass).toBe('parse');
    // parse 类不重试（重试只会更贵，不会更合规）
    expect(report.retry.retry).toBe(false);

    // 2) 落库层：信封照样入库（valid=false + errors），这是「可审计」的关键
    const snapshot = await readRunSnapshot(db.sql, taskId);
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]?.['outcome']).toBe('failed');
    expect(snapshot.runs[0]?.['failure_class']).toBe('parse');
    expect(snapshot.envelopes).toHaveLength(1);
    expect(snapshot.envelopes[0]?.['valid']).toBe(false);
    expect(Array.isArray(snapshot.envelopes[0]?.['errors'])).toBe(true);

    // 3) ★ 一行动作都不许有（校验失败 = 整封信封不可信）
    expect(snapshot.actions).toHaveLength(0);
    expect(await db.sql('select * from actions')).toHaveLength(0);

    // 4) ★ GitHub 零副作用
    expect(github.nonGetCount()).toBe(0);

    // 5) 容器照样被处置（不留垃圾）
    expect(report.disposed).toBe(true);

    // 6) dry-run 下**兜底评论也不发**：`actions` 0 行、非 GET 0 次这两条是 M0 的口径，
    //    兜底回复（`worker/fallback.ts`）只在真实写回时才生效，所以这里 `fallback` 必须是 null。
    //    这条断言的作用是防止有人为了「用户体验」把兜底塞进 dry-run，把零副作用验收悄悄破坏掉。
    expect(report.fallback).toBeNull();

    console.log(
      `[e2e-envelope-invalid] runs=${String(snapshot.runs.length)}` +
        ` outcome=${String(snapshot.runs[0]?.['outcome'])}` +
        ` failureClass=${String(snapshot.runs[0]?.['failure_class'])}` +
        ` envelopes=${String(snapshot.envelopes.length)} valid=${String(snapshot.envelopes[0]?.['valid'])}` +
        ` actions=${String(snapshot.actions.length)} githubNonGet=${String(github.nonGetCount())}`,
    );
  }, 60_000);
});
