/**
 * 回归（P2-4）：**dry-run 仓库不入队下一阶段**（`docs/plan-fixed-pipeline.md` §11 M1 观察期）。
 *
 * 缺陷形状：dry-run 下 `executeFormatPlan()` **不写 transition**（零 GitHub 副作用），
 * 但 `persistPipelineAfterRun()` 仍按 `effects.enqueue` 入队下一阶段 → 行永远停在
 * `format/pending`，而分类任务跑在一个「还不是 classify」的行上（必然 `not-classify-running`），
 * 白花一次 sandboxed 调用；后续每个 `@` 还被门禁降级成 eyes。
 *
 * 修法：`dry_run` 为 true 时**不入队下一阶段**，并把「dry-run：仅推进内部状态」写进
 * `blocked_reason`（面板可见的位置），让人一眼看出「为什么这个 issue 一直停在格式检查」。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApplication } from '../src/app/index.ts';
import type { Application } from '../src/app/index.ts';
import { DRY_RUN_STAGE_NOTE } from '../src/app/compose.ts';
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

/** 合规信封：格式通过（正常仓库会入队 classify；dry-run 仓库不该入队）。 */
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
let github: ReturnType<typeof createCountingGithubApi>;

beforeAll(async () => {
  db = await openTestDb(NOW);
  await db.truncate();
  await db.sql(
    `insert into repos (repo_full_name, enabled, dry_run, settings, settings_valid)
     values ($1, true, true, $2::jsonb, true)`,
    [REPO, validSettingsJson()],
  );
  host = await FakeRacpHost.start({ script: { text: PASS_ENVELOPE_TEXT } });
  github = createCountingGithubApi();
  const fakePorts = createFakePorts({ endpoint: host.endpoint(), github: github.api });
  app = createApplication(e2eConfig(), {
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
  github.calls.length = 0;
});

async function opened(issueNumber: number): Promise<void> {
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
      'x-github-delivery': `d-dryrun-${String(issueNumber)}`,
      'x-github-event': 'issues',
      'x-hub-signature-256': signBody(E2E_WEBHOOK_SECRET, body),
    },
    payload: body,
  });
  expect(response.statusCode).toBe(200);
}

describe('dry-run 仓库不推进下一阶段（P2-4）', () => {
  it('格式通过但 dry-run：不入队 classify，行留在 format/pending + 可见留痕', async () => {
    await opened(31);
    const tasks = await db.sql('select id, command from tasks order by queued_at');
    expect(tasks.map((task) => task['command'])).toEqual(['pipeline:format']);

    const report = await app.executeTask({ taskId: String(tasks[0]?.['id']) });
    expect(report.dryRun).toBe(true);
    expect(report.outcome).toBe('succeeded');

    // ★ 不入队下一阶段
    const after = await db.sql('select command from tasks order by queued_at');
    expect(after.map((task) => task['command'])).toEqual(['pipeline:format']);

    // ★ dry-run 不写 GitHub
    expect(github.calls).toEqual([]);

    // ★ 面板可见：blocked_reason 写明「只推进内部状态」
    const row = await db.sql(
      'select stage, state, blocked_reason from issue_pipeline where repo = $1 and issue_number = 31',
      [REPO],
    );
    expect(row[0]).toMatchObject({
      stage: 'format',
      state: 'pending',
      blocked_reason: DRY_RUN_STAGE_NOTE,
    });
  }, 60_000);
});
