/**
 * V13 的**三阶段会话隔离**（`docs/test-plan-fixed-pipeline.md` §6.2 P2-6 / `docs/plan-fixed-pipeline.md`
 * §7 + D1 / §12 V13）。
 *
 * 判据（同一条 issue 依次走完三段）：
 * ```
 * pipeline:format   （light，ephemeral）→ 跑完 session_id 仍是 NULL
 * pipeline:classify （sandboxed，ephemeral）→ 跑完 session_id 仍是 NULL
 * @ 第 1 次         （persistent）→ 新建会话，落 session_id
 * @ 第 2 次         （persistent）→ attach 同一个会话，session_turns 递增
 * ```
 * 计数口径：`session/create` 3 次（两个 ephemeral 各 1 + 首轮 `@` 1）、`session/archive` 2 次
 * （两个 ephemeral 各归档 1，两次 `@` 一次都没有）、`session/attach` 1 次（第二次 `@`）。
 *
 * 为什么必须一条用例跑完三段：`format = NULL` 已有断言，但 `classify` 没有装配级用例，
 * 「三个阶段两两不同」实际只被验证了三分之一；两段都绿、中间那一阶段悄悄复用会话是很典型的回归
 * （复用之后阶段 0/1 的临时会话会泄漏成阶段 2 的长期上下文）。
 *
 * 用假 RACP **通道工厂**（不连 pi-host，但走同一段 `executeTask()` / `driveTurn` 代码），
 * 因为只有它能逐个 operation 数 `session/create|attach|archive`。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApplication } from '../src/app/index.ts';
import type { Application } from '../src/app/index.ts';
import type { RacpChannel, RacpChannelFactory } from '../src/app/racp.ts';
import type { HostEndpoint } from '../src/worker/index.ts';
import { createPgRunStore } from '../src/worker/index.ts';
import type { TurnDriverOps } from '../src/runtime/turn-driver.ts';
import type { EventEnvelope } from '../src/runtime/deps.ts';
import { ensurePipeline, loadPipeline } from '../src/workflows/pipeline.ts';
import {
  createFakePorts,
  createFakeQueue,
  e2eConfig,
  poolWithNoopEnd,
  quietMetrics,
  stubMetricsServer,
} from './helpers/e2e-harness.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';
import { validSettingsJson, vocabularyWithRoles } from './helpers/repo-settings.ts';

const REPO = 'acme/session-isolation';
const ISSUE = 42;
const NOW = new Date('2026-06-01T12:00:00.000Z');
const FRESH_SESSION = 'session-fresh';

/** 合法配置（词表按 role 各一条，`repoSettingsSchema` 的跨字段约束）。 */
const SETTINGS = {
  labels: { vocabulary: vocabularyWithRoles([{ name: '需求' }, { name: '缺陷' }]) },
};

/** 阶段 0 通过（→ 入队分类，零评论）。 */
const FORMAT_PASS_TEXT = envelopeText({
  stage: { name: 'format', result: 'pass' },
  verdict: { kind: 'issue', labels: [], evidence: [{ rule: 'format', quote: '齐了', passed: true }] },
});

/** 阶段 1 结论 `other`（→ 只打标签/无动作，直接 agent/ready）。 */
const CLASSIFY_OTHER_TEXT = envelopeText({
  stage: { name: 'classify', result: 'other' },
  verdict: { kind: 'issue', labels: [], evidence: [{ rule: 'question', quote: '只是提问', passed: true }] },
});

/** 阶段 2 的一条普通回答（带一条 comment 动作）。 */
const ANSWER_TEXT = envelopeText({
  verdict: { kind: 'issue', labels: [], evidence: [] },
  actions: [{ intent: 'comment', body: '这个原因是……' }],
});

function envelopeText(body: Record<string, unknown>): string {
  return [
    '看过了。',
    '```json',
    JSON.stringify({
      // `actions` 是契约必填（省略会被判 parse 失败）；各脚本可按需覆盖
      actions: [],
      ...body,
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
    }),
    '```',
  ].join('\n');
}

/* ── 假 RACP 通道（与 `pipeline-agent-session.test.ts` 同形：逐个 operation 记账）────────── */

type Call = { readonly method: string; readonly params: Record<string, unknown> };
type ScriptItem = { readonly kind: string; readonly sequence: number; readonly envelope?: string };

function createFakeRacp(): RacpChannelFactory & {
  readonly calls: Call[];
  setScript(script: readonly ScriptItem[]): void;
} {
  const calls: Call[] = [];
  let script: readonly ScriptItem[] = [
    { kind: 'turn.started', sequence: 1 },
    { kind: 'turn.completed', sequence: 3 },
  ];
  const record = (method: string, params: Record<string, unknown>): void => {
    calls.push({ method, params });
  };

  const factory = (async (_endpoint: HostEndpoint): Promise<RacpChannel> => {
    const ops: TurnDriverOps = {
      projectRegister: async (params) => {
        record('project/register', { ...params });
        return { projectId: 'project-1' };
      },
      sessionCreate: async (params) => {
        record('session/create', { ...params });
        return { id: FRESH_SESSION };
      },
      eventsSubscribe: async (params) => {
        record('events/subscribe', { ...params });
        return {};
      },
      turnStart: async (params) => {
        record('turn/start', { text: params.input.text });
        return { id: 'turn-1' };
      },
      turnInterrupt: async (params) => {
        record('turn/interrupt', { ...params });
        return {};
      },
      approvalRespond: async () => ({}),
      inputRespond: async () => ({}),
      workspaceDiff: async () => ({ diff: '' }),
      sessionArchive: async (params) => {
        record('session/archive', { ...params });
        return {};
      },
      sessionAttach: async (params) => {
        record('session/attach', { ...params });
        return { cursor: { sequence: 5 } };
      },
    };

    const events = (): AsyncIterable<EventEnvelope> => ({
      [Symbol.asyncIterator]: async function* generate() {
        for (const item of script) {
          yield {
            eventId: `e-${String(item.sequence)}`,
            scope: 'session',
            sessionId: 'session-x',
            epoch: 'epoch-1',
            sequence: item.sequence,
            revision: item.sequence,
            kind: item.kind,
            occurredAt: '2026-06-01T00:00:00.000Z',
            payload: item.envelope === undefined ? { status: 'ok' } : { text: item.envelope },
          } as unknown as EventEnvelope;
        }
      },
    });

    return { ops, events, close: async () => undefined };
  }) as RacpChannelFactory & { readonly calls: Call[] };

  return Object.assign(factory, {
    calls,
    setScript: (next: readonly ScriptItem[]) => {
      script = next;
    },
  });
}

let db: TestDb;
let app: Application;
let racp: ReturnType<typeof createFakeRacp>;
let worktreeDir: string;
let taskSeq = 0;

beforeAll(async () => {
  db = await openTestDb(NOW);
  await db.truncate();
  await db.sql(
    `insert into repos (repo_full_name, enabled, dry_run, settings, settings_valid)
     values ($1, true, false, $2::jsonb, true)`,
    [REPO, validSettingsJson(SETTINGS)],
  );
  // 阶段 1/2 会读 worktree 里的 AGENTS.md：给一个真空目录，别让它去碰真实工作区
  worktreeDir = await mkdtemp(path.join(os.tmpdir(), 'pi-bot-v13-'));
  await mkdir(worktreeDir, { recursive: true });
  await writeFile(path.join(worktreeDir, 'AGENTS.md'), '提交前跑 typecheck。\n', 'utf8');

  racp = createFakeRacp();
  const fakePorts = createFakePorts({
    endpoint: { hostId: 'host-1', port: 7777, version: '1.0.0', token: 'pdt1.t' },
    jobRoot: worktreeDir,
  });
  app = createApplication(e2eConfig({ PI_BOT_DRY_RUN: 'false' }), {
    pool: poolWithNoopEnd(db.pool),
    queue: createFakeQueue(),
    ports: { ...fakePorts.ports, store: createPgRunStore({ pool: db.pool }) },
    metrics: quietMetrics(),
    metricsServer: stubMetricsServer(),
    racp,
    now: () => NOW,
  });
}, 60_000);

afterAll(async () => {
  await app?.stop();
  await rm(worktreeDir, { recursive: true, force: true });
  await db?.close();
}, 60_000);

beforeEach(async () => {
  await db.sql(
    'truncate table tasks, runs, run_events, envelopes, actions, webhook_deliveries, issue_pipeline cascade',
  );
  racp.calls.length = 0;
  // 默认脚本 = 一轮「通过且没有任何动作」：各阶段自己用 setScript 换
  racp.setScript([
    { kind: 'turn.started', sequence: 1 },
    { kind: 'item.completed', sequence: 2, envelope: FORMAT_PASS_TEXT },
    { kind: 'turn.completed', sequence: 3 },
  ]);
});

const callsOf = (method: string): Call[] => racp.calls.filter((call) => call.method === method);
const pipelineRow = async () => loadPipeline(db.pool, { repo: REPO, issueNumber: ISSUE });

/** 种一条阶段任务（`prompt_text` / 正文快照都给，分类与 `@` 都要用）。 */
async function seedTask(input: {
  readonly command: string;
  readonly source?: string;
  readonly promptText?: string | null;
}): Promise<string> {
  taskSeq += 1;
  const id = `task-v13-${String(taskSeq)}`;
  await db.sql(
    `insert into tasks
       (id, source, repo, target_kind, target_number, head_sha, command, actor_login,
        queued_at, idempotency_key, status, attempt, prompt_text, target_title, target_body, target_supplement)
     values ($1, $2, $3, 'issue', $4, null, $5, 'alice', now(), $6, 'queued', 0, $7, $8, $9, '[]'::jsonb)`,
    [
      id,
      input.source ?? 'pipeline',
      REPO,
      ISSUE,
      input.command,
      `key-${id}`,
      input.promptText ?? null,
      '保存时偶发 500',
      '点击保存后偶发 500。',
    ],
  );
  return id;
}

/** 由格式检查自己入队的那条分类任务（`enqueueStageTask` 落库的）。 */
async function classifyTaskId(): Promise<string> {
  const rows = await db.sql(
    `select id from tasks where repo = $1 and target_number = $2 and command = 'pipeline:classify'
      order by queued_at desc, id desc limit 1`,
    [REPO, ISSUE],
  );
  expect(rows).toHaveLength(1);
  return String(rows[0]?.['id']);
}

describe('V13：三个阶段（format / classify / agent）的会话两两不同（P2-6）', () => {
  it('format、classify 跑完 session_id 仍为 NULL；两次 @ 共用同一会话、archive 共 2 次、create 共 3 次', async () => {
    await ensurePipeline(
      db.pool,
      { repo: REPO, issueNumber: ISSUE },
      { stage: 'format', state: 'pending', issueVersion: 'v1' },
    );

    /* ① 阶段 0：light + ephemeral */
    const formatReport = await app.executeTask({
      taskId: await seedTask({ command: 'pipeline:format' }),
      dryRun: false,
    });
    expect(formatReport.outcome).toBe('succeeded');
    expect(formatReport.sessionMode).toBe('ephemeral');
    // 自己的临时会话建了一次、归档一次
    expect(callsOf('session/create')).toHaveLength(1);
    expect(callsOf('session/archive')).toHaveLength(1);
    expect(callsOf('session/attach')).toHaveLength(0);
    const afterFormat = await pipelineRow();
    expect(afterFormat).toMatchObject({ stage: 'classify', state: 'pending', sessionId: null });
    expect(afterFormat?.sessionTurns).toBe(0);

    /* ② 阶段 1：sandboxed + ephemeral（同一条 issue，刚被阶段 0 交接过来） */
    racp.setScript([
      { kind: 'turn.started', sequence: 1 },
      { kind: 'item.completed', sequence: 2, envelope: CLASSIFY_OTHER_TEXT },
      { kind: 'turn.completed', sequence: 3 },
    ]);
    const classifyReport = await app.executeTask({ taskId: await classifyTaskId(), dryRun: false });
    expect(classifyReport.outcome).toBe('succeeded');
    expect(classifyReport.sessionMode).toBe('ephemeral');
    expect(classifyReport.runtimeMode).toBe('sandboxed');
    // 第二个临时会话：create 2 / archive 2（各阶段自己的，互不继承）
    expect(callsOf('session/create')).toHaveLength(2);
    expect(callsOf('session/archive')).toHaveLength(2);
    expect(callsOf('session/attach')).toHaveLength(0);
    const afterClassify = await pipelineRow();
    expect(afterClassify).toMatchObject({ stage: 'agent', state: 'ready', sessionId: null });
    expect(afterClassify?.sessionTurns).toBe(0);

    /* ③ 阶段 2 第一次 @：persistent，新建会话 */
    racp.setScript([
      { kind: 'turn.started', sequence: 1 },
      { kind: 'item.completed', sequence: 2, envelope: ANSWER_TEXT },
      { kind: 'turn.completed', sequence: 3 },
    ]);
    const first = await app.executeTask({
      taskId: await seedTask({ command: '@answer', source: 'command', promptText: '这个 500 是什么原因？' }),
      dryRun: false,
    });
    expect(first.outcome).toBe('succeeded');
    expect(first.sessionMode).toBe('persistent');
    // 首轮是 create（第 3 次），不是 attach
    expect(callsOf('session/create')).toHaveLength(3);
    expect(callsOf('session/attach')).toHaveLength(0);
    const afterFirstAt = await pipelineRow();
    expect(afterFirstAt?.sessionId).toBe(FRESH_SESSION);
    expect(afterFirstAt?.sessionTurns).toBe(1);

    /* ④ 阶段 2 第二次 @：attach 同一会话，turns 递增，零 create / 零 archive */
    const second = await app.executeTask({
      taskId: await seedTask({ command: '@answer', source: 'command', promptText: '那怎么修？' }),
      dryRun: false,
    });
    expect(second.outcome).toBe('succeeded');
    expect(second.sessionMode).toBe('persistent');

    const attachments = callsOf('session/attach');
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.params['sessionId']).toBe(FRESH_SESSION);
    // ★ 总计：三个阶段只有一个「真会话」，两个临时会话各自归档一次
    expect(callsOf('session/create')).toHaveLength(3);
    expect(callsOf('session/archive')).toHaveLength(2);
    const afterSecondAt = await pipelineRow();
    expect(afterSecondAt?.sessionId).toBe(FRESH_SESSION);
    expect(afterSecondAt?.sessionTurns).toBe(2);
    // 会话起始时间在第一轮 `@` 落库后就不再变（复用不会刷新它）
    expect(afterSecondAt?.sessionStartedAt).toEqual(afterFirstAt?.sessionStartedAt);
  }, 120_000);
});
