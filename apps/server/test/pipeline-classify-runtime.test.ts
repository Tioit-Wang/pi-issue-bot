/**
 * `PIPELINE_RUNTIME_MODE`：**`pipeline:classify` 必须跑 sandboxed**（`docs/test-plan-fixed-pipeline.md` §6.2 P2-1 /
 * `plan-fixed-pipeline.md` D6 / §10.5）。
 *
 * 为什么单独钉：分类阶段要读代码、跑命令才能给出 `path:line` 证据，是三个命令里**唯一**留在
 * 容器里的那一段；映射表写错的症状是「流程照跑、分类也有结论」，但那结论是没看过代码猜的
 * （`defect` 会被 `stage-result` 降级成 `not-found`，看起来像「模型偷懒」）。现有用例只钉住了
 * `pipeline:format → light`，写错 `classify` 这一档不会有任何红。
 *
 * 两层断言：
 *  1. 表本身：三条流水线命令各归各的档，非流水线命令**不在表内**（走 `sandboxed` 缺省，
 *     不经过这张表）；
 *  2. 装配级：同一条 issue 上先跑 `pipeline:format`（light：零容器、零 worktree），再跑它入队的
 *     `pipeline:classify`（sandboxed：容器 1 次、worktree 1 次）——证明是**命令**在选运行时而
 *     不是别的东西。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApplication } from '../src/app/index.ts';
import type { Application } from '../src/app/index.ts';
import { PIPELINE_RUNTIME_MODE } from '../src/app/compose.ts';
import { PIPELINE_COMMANDS } from '../../../packages/contract/src/index.ts';
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
import type { FakePortsRecord, FakeRacpHost as FakeHost } from './helpers/e2e-harness.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';
import { validSettingsJson } from './helpers/repo-settings.ts';

const REPO = 'acme/widgets';
const NOW = new Date('2026-06-01T12:00:00.000Z');
const ISSUE = 31;

/** 阶段 0 通过（推进到 classify/pending，并入队 `pipeline:classify`）。 */
const FORMAT_PASS_TEXT = [
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

/** 阶段 1 结论 `other`：只打标签（本夹具词表为空 → 零写动作），直接 agent/ready。 */
const CLASSIFY_OTHER_TEXT = [
  '这条不是缺陷也不是需求，只是提问。',
  '```json',
  JSON.stringify({
    stage: { name: 'classify', result: 'other' },
    verdict: { kind: 'issue', labels: [], evidence: [{ rule: 'question', quote: '只是提问', passed: true }] },
    actions: [],
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
  }),
  '```',
].join('\n');

describe('P2-1：PIPELINE_RUNTIME_MODE 映射表', () => {
  it('format / notice → light，classify → sandboxed；非流水线命令不在表内', () => {
    expect(PIPELINE_RUNTIME_MODE['pipeline:format']).toBe('light');
    expect(PIPELINE_RUNTIME_MODE['pipeline:notice']).toBe('light');
    expect(PIPELINE_RUNTIME_MODE['pipeline:classify']).toBe('sandboxed');

    // 表就是这三条（多一条 = 有命令静默落到 light，白送一个「没看过代码的结论」）
    expect(Object.keys(PIPELINE_RUNTIME_MODE).sort()).toEqual([...PIPELINE_COMMANDS].sort());

    // 非流水线命令根本不查这张表（`compose.ts` 里 `pipelineCommand === null` → 直接 sandboxed）
    for (const command of ['/review-pr', '@answer', '/issue-triage', 'pipelineX:format']) {
      expect(Object.hasOwn(PIPELINE_RUNTIME_MODE, command)).toBe(false);
    }
    // 冻结：运行期改档位要抛（阈值/映射只该改代码，不该被注入污染）
    expect(Object.isFrozen(PIPELINE_RUNTIME_MODE)).toBe(true);
  });
});

describe('P2-1：装配级 —— classify 真的起容器、format 真的不起', () => {
  let db: TestDb;
  let app: Application;
  let host: FakeHost;
  let record: FakePortsRecord;

  beforeAll(async () => {
    db = await openTestDb(NOW);
    await db.truncate();
    await db.sql(
      `insert into repos (repo_full_name, enabled, dry_run, settings, settings_valid)
       values ($1, true, false, $2::jsonb, true)`,
      [REPO, validSettingsJson()],
    );
    host = await FakeRacpHost.start({ script: { text: FORMAT_PASS_TEXT } });
    const github = createCountingGithubApi();
    const fakePorts = createFakePorts({ endpoint: host.endpoint(), github: github.api });
    record = fakePorts.record;
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
    await db.sql(
      'truncate table tasks, runs, run_events, envelopes, actions, webhook_deliveries, issue_pipeline cascade',
    );
    host.setScript({ text: FORMAT_PASS_TEXT });
  });

  async function opened(deliveryId: string): Promise<void> {
    const body = JSON.stringify({
      action: 'opened',
      repository: { full_name: REPO },
      sender: { login: 'alice', type: 'User' },
      issue: {
        number: ISSUE,
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

  async function taskIdOf(command: string): Promise<string> {
    const rows = await db.sql(
      `select id from tasks where command = $1 and target_number = $2
       order by queued_at desc, id desc limit 1`,
      [command, ISSUE],
    );
    expect(rows).toHaveLength(1);
    return String(rows[0]?.['id']);
  }

  it('format → light（零容器 / 零 worktree），它入队的 classify → sandboxed（各 1 次）', async () => {
    await opened('d-runtime-open');

    // ① 阶段 0：light
    const formatReport = await app.executeTask({ taskId: await taskIdOf('pipeline:format') });
    expect(formatReport.outcome).toBe('succeeded');
    expect(formatReport.runtimeMode).toBe('light');
    expect(formatReport.containerId).toBeNull();
    expect(record.createdContainers).toHaveLength(0);
    expect(record.worktrees).toHaveLength(0);
    expect(record.disposed).toHaveLength(0);

    // 阶段 0 通过会把分类任务真的入队（这里是一条 `tasks` 行，source=pipeline）
    const classifyRows = await db.sql(
      `select command, source from tasks where command = 'pipeline:classify' and target_number = $1`,
      [ISSUE],
    );
    expect(classifyRows).toHaveLength(1);
    expect(classifyRows[0]).toMatchObject({ source: 'pipeline' });

    // ② 阶段 1：sandboxed（读代码要容器 + worktree）
    host.setScript({ text: CLASSIFY_OTHER_TEXT });
    const classifyReport = await app.executeTask({ taskId: await taskIdOf('pipeline:classify') });

    expect(classifyReport.outcome).toBe('succeeded');
    expect(classifyReport.runtimeMode).toBe('sandboxed');
    expect(classifyReport.containerId).toBe('container-e2e');
    expect(classifyReport.jobDir).not.toBeNull();
    // ★ 容器与 worktree **各 1 次**（上一轮 light 一次都没加）
    expect(record.createdContainers).toHaveLength(1);
    expect(record.worktrees).toHaveLength(1);
    // 九步序列里带着 worktree / container / proxy / diff / dispose
    expect(classifyReport.steps).toEqual([
      'worktree',
      'container',
      'proxy',
      'host',
      'turn',
      'diff',
      'validate',
      'execute',
      'dispose',
    ]);
    // 阶段 1 仍是 ephemeral 会话（不落 session_id，V13）
    expect(classifyReport.sessionMode).toBe('ephemeral');

    const row = await db.sql(
      'select stage, state, session_id from issue_pipeline where repo = $1 and issue_number = $2',
      [REPO, ISSUE],
    );
    expect(row[0]).toMatchObject({ stage: 'agent', state: 'ready', session_id: null });
  }, 120_000);
});
