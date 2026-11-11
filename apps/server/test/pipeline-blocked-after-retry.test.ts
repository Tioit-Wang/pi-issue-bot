/**
 * 回归（P1-3）：**运行失败连续 2 次才 `blocked`**（`docs/plan-fixed-pipeline.md` §2 / §5）。
 *
 * 缺陷形状：`consecutiveFailures = params.row.attempt + 1`，而 `tasks.attempt` 全仓**没有自增**
 * （`markTask()` 只写 status/ended_at），于是「连续失败」恒为 1 →
 * `run-invalid` 的 `consecutive >= 2` 分支不可达 → 阶段任务重试耗尽后行停在 `format/pending`，
 * 门禁从此只打 eyes（与 P0-1 同一种卡死）。
 *
 * 修法：用 `executeTask()` 已有的 `input.attempt`（真实来源是队列载荷的 `job.data.attempt + 1`，
 * `queue/boss.ts` 重投时 +1）传给 `persistPipelineAfterRun()`。
 *
 * 两条断言：两次失败 → `blocked` + `blocked_reason` 非空；一次成功之后再失败一次 → 不 blocked。
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
import type { FakeRacpHost as FakeHost } from './helpers/e2e-harness.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';
import { validSettingsJson } from './helpers/repo-settings.ts';

const REPO = 'acme/widgets';
const NOW = new Date('2026-06-01T12:00:00.000Z');

/** 信封不合法（缺顶层 stage）：阶段 0 视为「运行失败」，连续 2 次即 blocked。 */
const INVALID_ENVELOPE_TEXT = [
  '看完了，但没给结论。',
  '```json',
  JSON.stringify({
    verdict: { kind: 'issue', labels: [], evidence: [{ rule: 'x', quote: 'y', passed: true }] },
    actions: [],
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
  }),
  '```',
].join('\n');

/** 合规信封：格式通过（首次 pass → 入队 classify）。 */
const PASS_ENVELOPE_TEXT = [
  '格式没问题，进入分类。',
  '```json',
  JSON.stringify({
    stage: { name: 'format', result: 'pass' },
    verdict: { kind: 'issue', labels: [], evidence: [{ rule: 'format', quote: '齐了', passed: true }] },
    actions: [],
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
  }),
  '```',
].join('\n');

let db: TestDb;
let app: Application;
let host: FakeHost;

beforeAll(async () => {
  db = await openTestDb(NOW);
  await db.truncate();
  await db.sql(
    `insert into repos (repo_full_name, enabled, dry_run, settings, settings_valid)
     values ($1, true, false, $2::jsonb, true)`,
    [REPO, validSettingsJson()],
  );
  host = await FakeRacpHost.start({ script: { text: INVALID_ENVELOPE_TEXT } });
  const github = createCountingGithubApi();
  const fakePorts = createFakePorts({ endpoint: host.endpoint(), github: github.api });
  app = createApplication(e2eConfig({ PI_BOT_DRY_RUN: 'false' }), {
    pool: poolWithNoopEnd(db.pool),
    queue: createFakeQueue(),
    ports: { ...fakePorts.ports, store: createPgRunStore({ pool: db.pool }) },
    metrics: quietMetrics(),
    metricsServer: stubMetricsServer(),
    ack: { addEyesReaction: async () => undefined },
  });
  await app.start();
}, 60_000);

afterAll(async () => {
  await app?.stop();
  await host?.close();
  await db?.close();
}, 60_000);

beforeEach(async () => {
  await db.sql('truncate table tasks, runs, run_events, envelopes, actions, webhook_deliveries, issue_pipeline cascade');
  host.setScript({ text: INVALID_ENVELOPE_TEXT });
});

async function opened(issueNumber: number, deliveryId: string): Promise<void> {
  const body = JSON.stringify({
    action: 'opened',
    repository: { full_name: REPO },
    sender: { login: 'alice', type: 'User' },
    issue: {
      number: issueNumber,
      title: '登录时报 500',
      body: '复现步骤：……',
      user: { login: 'author' },
      author_association: 'OWNER',
      updated_at: '2026-05-31T00:00:00Z',
    },
  });
  const response = await app.server.inject({
    method: 'POST',
    url: '/webhook',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': deliveryId,
      'x-github-event': 'issues',
      'x-hub-signature-256': signBody(E2E_WEBHOOK_SECRET, body),
    },
    payload: body,
  });
  expect(response.statusCode).toBe(200);
}

async function formatTaskId(issueNumber: number): Promise<string> {
  const rows = await db.sql(
    `select id from tasks where command = 'pipeline:format' and target_number = $1
     order by queued_at desc, id desc limit 1`,
    [issueNumber],
  );
  expect(rows).toHaveLength(1);
  return String(rows[0]?.['id']);
}

async function pipelineRow(issueNumber: number): Promise<Record<string, unknown> | null> {
  const rows = await db.sql(
    'select stage, state, blocked_reason, format_attempts, format_fail_count, issue_version from issue_pipeline where repo = $1 and issue_number = $2',
    [REPO, issueNumber],
  );
  return rows[0] ?? null;
}

describe('连续失败 2 次才 blocked（P1-3）', () => {
  it('第一次失败：留在 format/pending（不 blocked）；第二次失败：blocked + blocked_reason', async () => {
    await opened(21, 'd-blocked-open-21');
    const taskId = await formatTaskId(21);

    // 第一次尝试（job.data.attempt 缺省 → 1）
    await app.executeTask({ taskId, attempt: 1 });
    const first = await pipelineRow(21);
    expect(first).toMatchObject({ stage: 'format', state: 'pending' });
    expect(first?.['blocked_reason']).toBeNull();
    // 重投（`boss.ts` 把 attempt +1 → 2）
    // 注意：`report.outcome` 仍是 `succeeded`（turn 跑完了、信封也合法），
    // 失败的是「阶段结论缺失」—— `planFormatOutcome()` 按 `run-invalid` 处理，所以只断言状态行。
    await app.executeTask({ taskId, attempt: 2 });
    const after = await pipelineRow(21);
    expect(after).toMatchObject({ stage: 'format', state: 'blocked' });
    expect(String(after?.['blocked_reason'])).toContain('连续 2 次');
  }, 90_000);

  it('一次成功之后再失败一次：不 blocked（成功那轮把尝试计数归零）', async () => {
    await opened(22, 'd-blocked-open-22');
    const firstTask = await formatTaskId(22);

    // 第一次：失败（还在 pending）
    await app.executeTask({ taskId: firstTask, attempt: 1 });
    expect(await pipelineRow(22)).toMatchObject({ stage: 'format', state: 'pending' });

    // 第二次：通过 → classify/pending（不是 blocked）
    host.setScript({ text: PASS_ENVELOPE_TEXT });
    await app.executeTask({ taskId: firstTask, attempt: 2 });
    const passed = await pipelineRow(22);
    expect(passed).toMatchObject({ stage: 'classify', state: 'pending' });
    expect(passed?.['blocked_reason']).toBeNull();

    // 再过一轮（新的 issue 事件重置到 format/pending，新任务的第一次尝试）→ 失败也不 blocked
    host.setScript({ text: INVALID_ENVELOPE_TEXT });
    await opened(22, 'd-blocked-open-22-again');
    const nextTask = await formatTaskId(22);
    await app.executeTask({ taskId: nextTask, attempt: 1 });
    const last = await pipelineRow(22);
    expect(last).toMatchObject({ stage: 'format', state: 'pending' });
    expect(last?.['blocked_reason']).toBeNull();

    // 阶段交接的 classify 任务确实入队了（P2-2：锚只拼一次、列里存裸版本）
    const classify = await db.sql(
      `select command from tasks where command = 'pipeline:classify' and target_number = 22`,
    );
    expect(classify).toHaveLength(1);
    expect(String(passed?.['issue_version'])).toMatch(/^[0-9a-z]+$/u);
    expect(String(passed?.['issue_version'])).not.toContain('pipeline:');
  }, 90_000);
});
