/**
 * 阶段 2 的会话（`docs/plan-fixed-pipeline.md` §7 / §12 V13，S4）。
 *
 * 两组断言：
 *  1. **纯函数** `planAgentSession()`：什么时候复用、什么时候轮换、轮换时要不要 archive；
 *  2. **装配级**（真 PG + 假端口 + 假 RACP 通道）：连续两次 `@` 同一个 issue 时
 *     `session_id` 不变、`session_turns` +2、`session/archive` **0 次**；到 30 轮与超 7 天各自
 *     archive 1 次并换新 id + `blocked_reason='session-reset'`。
 *
 * 还有一条 D1 / V13 的硬约束：「阶段 0/1/2 的 `session_id` 两两不同」——
 * 阶段 0/1 是 ephemeral，**一列都不该落**（分类/格式跑完 `session_id` 仍是 NULL）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApplication } from '../src/app/index.ts';
import type { Application } from '../src/app/index.ts';
import { planAgentSession } from '../src/app/compose.ts';
import type { RacpChannel, RacpChannelFactory } from '../src/app/racp.ts';
import type { HostEndpoint } from '../src/worker/index.ts';
import { createPgRunStore } from '../src/worker/index.ts';
import type { TurnDriverOps } from '../src/runtime/turn-driver.ts';
import type { EventEnvelope } from '../src/runtime/deps.ts';
import { ensurePipeline, loadPipeline } from '../src/workflows/pipeline.ts';
import type { PipelineRow } from '../src/workflows/pipeline.ts';
import {
  createCountingGithubApi,
  createFakePorts,
  createFakeQueue,
  e2eConfig,
  poolWithNoopEnd,
  quietMetrics,
  stubMetricsServer,
} from './helpers/e2e-harness.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';
import { validSettingsJson } from './helpers/repo-settings.ts';

const REPO = 'test/agent-session';
const ISSUE = 88;
const NOW = new Date('2026-06-01T12:00:00.000Z');
const OLD_SESSION = 'session-old';
const NEW_SESSION = 'session-new';
const JOB_ROOT = '.agent-session-jobs';

/** 一条 `agent/ready` 的流水线行（会话字段由各用例摆位）。 */
function agentRow(over: Partial<PipelineRow> = {}): PipelineRow {
  return {
    repo: REPO,
    issueNumber: ISSUE,
    stage: 'agent',
    state: 'ready',
    category: 'requirement',
    formatAttempts: 1,
    formatFailCount: 0,
    classifyAttempts: 1,
    issueVersion: 'v1',
    infoRequestedAt: null,
    lastRecheckAt: null,
    mentionSentAt: null,
    mentionCategory: null,
    gateNoticeAt: null,
    sessionId: OLD_SESSION,
    sessionCursor: 3,
    sessionTurns: 4,
    sessionStartedAt: new Date('2026-05-31T12:00:00.000Z'),
    staleAt: null,
    blockedReason: null,
    readyAt: new Date('2026-05-31T00:00:00.000Z'),
    closedAt: null,
    createdAt: new Date('2026-05-30T00:00:00.000Z'),
    updatedAt: new Date('2026-05-31T00:00:00.000Z'),
    ...over,
  };
}

describe('planAgentSession（纯函数）', () => {
  it('没有流水线行 / 不在 agent 阶段：ephemeral（不 attach、不 archive）', () => {
    for (const pipeline of [null, agentRow({ stage: 'classify', state: 'running' })]) {
      const plan = planAgentSession({ pipeline, at: NOW });
      expect(plan.session).toBeUndefined();
      expect(plan.rotate).toBe(false);
      expect(plan.archiveSessionId).toBeNull();
    }
  });

  it('第一轮（没有 session_id）：新建会话，不轮换', () => {
    const plan = planAgentSession({
      pipeline: agentRow({ sessionId: null, sessionTurns: 0, sessionStartedAt: null }),
      at: NOW,
    });
    expect(plan.session).toEqual({ mode: 'persistent' });
    expect(plan.rotate).toBe(false);
  });

  it('复用：带上 sessionId 与 cursor 作 after（防重放旧事件）', () => {
    const plan = planAgentSession({ pipeline: agentRow(), at: NOW });
    expect(plan.session).toEqual({ mode: 'persistent', sessionId: OLD_SESSION, after: 3 });
    expect(plan.rotate).toBe(false);
    expect(plan.archiveSessionId).toBeNull();
  });

  it('30 轮：轮换（archive 旧会话 + 新建）', () => {
    const plan = planAgentSession({ pipeline: agentRow({ sessionTurns: 30 }), at: NOW });
    expect(plan.rotate).toBe(true);
    expect(plan.rotateReason).toBe('turns');
    expect(plan.archiveSessionId).toBe(OLD_SESSION);
    expect(plan.session).toEqual({ mode: 'persistent' });
  });

  it('超过 7 天：轮换（age）', () => {
    const plan = planAgentSession({
      pipeline: agentRow({ sessionStartedAt: new Date('2026-05-24T00:00:00.000Z') }),
      at: NOW,
    });
    expect(plan.rotate).toBe(true);
    expect(plan.rotateReason).toBe('age');
    expect(plan.archiveSessionId).toBe(OLD_SESSION);
  });

  it('29 轮 / 6 天：还没到阈值，继续复用', () => {
    const plan = planAgentSession({
      pipeline: agentRow({
        sessionTurns: 29,
        sessionStartedAt: new Date('2026-05-26T13:00:00.000Z'),
      }),
      at: NOW,
    });
    expect(plan.rotate).toBe(false);
    expect(plan.session).toMatchObject({ mode: 'persistent', sessionId: OLD_SESSION });
  });
});

/* ── 装配级：真库 + 假 RACP 通道 ─────────────────────────────────────────────── */

type Call = { readonly method: string; readonly params: Record<string, unknown> };

/** 假 RACP 通道：记录每个 operation，按脚本推事件（与 `pipeline-session-mode.test.ts` 同形）。 */
function createFakeRacp(): RacpChannelFactory & {
  readonly calls: Call[];
  setScript(script: readonly { readonly kind: string; readonly sequence: number; readonly envelope?: string }[]): void;
} {
  const calls: Call[] = [];
  let script: readonly { readonly kind: string; readonly sequence: number; readonly envelope?: string }[] = [
    { kind: 'turn.started', sequence: 1 },
    { kind: 'turn.completed', sequence: 4 },
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
        return { id: NEW_SESSION };
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
    setScript: (next: readonly { readonly kind: string; readonly sequence: number; readonly envelope?: string }[]) => {
      script = next;
    },
  });
}

/** 一条合法信封（带一条 comment 动作）。 */
const ENVELOPE_TEXT = [
  '看过了。',
  '```json',
  JSON.stringify({
    verdict: { kind: 'issue', labels: [], evidence: [] },
    actions: [{ intent: 'comment', body: '收到，我来看看。' }],
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
  }),
  '```',
].join('\n');

let db: TestDb;
let app: Application;
let racp: ReturnType<typeof createFakeRacp>;
let taskSeq = 0;

beforeAll(async () => {
  db = await openTestDb();
  racp = createFakeRacp();
  const queue = createFakeQueue();
  const github = createCountingGithubApi();
  const fakePorts = createFakePorts({ endpoint: { hostId: 'host-1', port: 7777, version: '1.0.0', token: 'pdt1.t' }, github: github.api, jobRoot: JOB_ROOT });
  app = createApplication(e2eConfig({ PI_BOT_DRY_RUN: 'false' }), {
    pool: poolWithNoopEnd(db.pool),
    queue,
    ports: { ...fakePorts.ports, store: createPgRunStore({ pool: db.pool }) },
    metrics: quietMetrics(),
    metricsServer: stubMetricsServer(),
    // 假 RACP 通道：不连 pi-host，但走**同一段** `executeTask` / `driveTurn` 代码
    racp,
    now: () => NOW,
  });
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.sql('delete from issue_pipeline where repo = $1', [REPO]);
  await db.sql('delete from tasks where repo = $1', [REPO]);
  await db.sql('delete from runs where task_id not in (select id from tasks)');
  await db.sql('delete from repos where repo_full_name = $1', [REPO]);
  await db.sql(
    `insert into repos (repo_full_name, enabled, dry_run, settings, settings_valid)
     values ($1, true, false, $2::jsonb, true)`,
    [REPO, validSettingsJson()],
  );
  racp.calls.length = 0;
  racp.setScript([
    { kind: 'turn.started', sequence: 1 },
    { kind: 'item.completed', sequence: 2, envelope: ENVELOPE_TEXT },
    { kind: 'turn.completed', sequence: 4 },
  ]);
});
/** 种一条阶段 2 的任务行（`@` 提问：`source='command'`，正文在 `prompt_text`）。 */
async function seedAgentTask(): Promise<string> {
  taskSeq += 1;
  const id = `task-agent-${String(taskSeq)}`;
  await db.sql(
    `insert into tasks
       (id, source, repo, target_kind, target_number, head_sha, command, actor_login,
        queued_at, idempotency_key, status, attempt, prompt_text, target_title, target_body, target_supplement)
     values ($1, 'command', $2, 'issue', $3, null, '@answer', 'alice', now(), $4, 'queued', 0, $5, $6, $7, '[]'::jsonb)`,
    [id, REPO, ISSUE, `key-${id}`, '这个保存失败是什么原因？', '保存时偶发 500', '点击保存后偶发 500。'],
  );
  return id;
}

/** 把流水线行摆到一个特定状态（会话字段由参数给）。 */
async function seedAgentRow(over: {
  readonly sessionId?: string | null;
  readonly sessionCursor?: number;
  readonly sessionTurns?: number;
  readonly sessionStartedAt?: Date | null;
}): Promise<void> {
  await ensurePipeline(
    db.pool,
    { repo: REPO, issueNumber: ISSUE },
    { stage: 'agent', state: 'ready', category: 'requirement', readyAt: NOW },
  );
  await db.sql(
    `update issue_pipeline
        set session_id = $3, session_cursor = $4, session_turns = $5, session_started_at = $6
      where repo = $1 and issue_number = $2`,
    [
      REPO,
      ISSUE,
      over.sessionId === undefined ? OLD_SESSION : over.sessionId,
      over.sessionCursor ?? 3,
      over.sessionTurns ?? 4,
      over.sessionStartedAt === undefined ? new Date('2026-05-31T12:00:00.000Z') : over.sessionStartedAt,
    ],
  );
}

const callsOf = (method: string): Call[] => racp.calls.filter((call) => call.method === method);
const row = async (): Promise<PipelineRow | null> =>
  loadPipeline(db.pool, { repo: REPO, issueNumber: ISSUE });

describe('连续两次 @ 同一个 issue（V13）', () => {
  it('session_id 不变、session_turns +2、session/archive 0 次、订阅用 cursor 当 after', async () => {
    await seedAgentRow({ sessionCursor: 3, sessionTurns: 4 });

    const first = await app.executeTask({ taskId: await seedAgentTask(), dryRun: false });
    expect(first.outcome).toBe('succeeded');
    const second = await app.executeTask({ taskId: await seedAgentTask(), dryRun: false });
    expect(second.outcome).toBe('succeeded');

    // attach 两次，都是同一个会话
    const attachments = callsOf('session/attach');
    expect(attachments.map((call) => call.params['sessionId'])).toEqual([OLD_SESSION, OLD_SESSION]);
    // 一次都不能 archive（归档了下一轮就没得 attach）
    expect(callsOf('session/archive')).toHaveLength(0);
    // 也不再 create（create 了就是新会话）
    expect(callsOf('session/create')).toHaveLength(0);
    // 订阅起点：第一轮 3（上一轮游标），第二轮 4（本轮最后一条事件的 sequence）
    expect(callsOf('events/subscribe').map((call) => call.params['after'])).toEqual([3, 4]);

    const after = await row();
    expect(after?.sessionId).toBe(OLD_SESSION);
    expect(after?.sessionTurns).toBe(6);
    expect(after?.sessionCursor).toBe(4);
    // 会话起始时间不变（没轮换）
    expect(after?.sessionStartedAt).toEqual(new Date('2026-05-31T12:00:00.000Z'));
    expect(after?.blockedReason).toBeNull();
  });
});

describe('轮换（§7：30 轮 / 超 7 天）', () => {
  it('session_turns >= 30：先 archive 旧会话再新建，落 session-reset', async () => {
    await seedAgentRow({ sessionTurns: 30 });

    await app.executeTask({ taskId: await seedAgentTask(), dryRun: false });

    const archives = callsOf('session/archive');
    expect(archives).toHaveLength(1);
    expect(archives[0]?.params['sessionId']).toBe(OLD_SESSION);
    // 轮换这一轮必须是**新建**（不能 attach 旧会话）
    expect(callsOf('session/attach')).toHaveLength(0);
    expect(callsOf('session/create')).toHaveLength(1);

    const after = await row();
    expect(after?.sessionId).toBe(NEW_SESSION);
    expect(after?.blockedReason).toBe('session-reset');
    // 新会话的计数从 1 起（这一轮就属于新会话）
    expect(after?.sessionTurns).toBe(1);
    expect(after?.sessionStartedAt).toEqual(NOW);
  });

  it('会话超过 7 天：同样 archive 旧会话 + 新建', async () => {
    await seedAgentRow({
      sessionTurns: 2,
      sessionStartedAt: new Date('2026-05-20T00:00:00.000Z'),
    });

    await app.executeTask({ taskId: await seedAgentTask(), dryRun: false });

    expect(callsOf('session/archive')).toHaveLength(1);
    const after = await row();
    expect(after?.sessionId).toBe(NEW_SESSION);
    expect(after?.blockedReason).toBe('session-reset');
  });

  it('第一轮（还没有 session_id）：不 archive，落新 id 与 session_started_at', async () => {
    await seedAgentRow({ sessionId: null, sessionCursor: 0, sessionTurns: 0, sessionStartedAt: null });

    await app.executeTask({ taskId: await seedAgentTask(), dryRun: false });

    expect(callsOf('session/archive')).toHaveLength(0);
    expect(callsOf('session/attach')).toHaveLength(0);
    const after = await row();
    expect(after?.sessionId).toBe(NEW_SESSION);
    expect(after?.sessionTurns).toBe(1);
    expect(after?.sessionStartedAt).toEqual(NOW);
  });
});

describe('阶段 0/1 不落 session_id（D1 / V13「三阶段两两不同」）', () => {
  it('pipeline:format（light + ephemeral）：跑完 session_id 仍是 NULL', async () => {
    await ensurePipeline(
      db.pool,
      { repo: REPO, issueNumber: ISSUE },
      { stage: 'format', state: 'pending', issueVersion: 'v1' },
    );
    taskSeq += 1;
    const taskId = `task-format-${String(taskSeq)}`;
    await db.sql(
      `insert into tasks
         (id, source, repo, target_kind, target_number, head_sha, command, actor_login,
          queued_at, idempotency_key, status, attempt, prompt_text, target_title, target_body, target_supplement)
       values ($1, 'pipeline', $2, 'issue', $3, null, 'pipeline:format', 'alice', now(), $4, 'queued', 0, null, $5, $6, '[]'::jsonb)`,
      [taskId, REPO, ISSUE, `key-${taskId}`, '保存时偶发 500', '点击保存后偶发 500。'],
    );
    // 阶段 0 的结论：pass（推进到 classify/pending，零评论）
    racp.setScript([
      { kind: 'item.completed', sequence: 2, envelope: JSON.stringify({
        stage: { name: 'format', result: 'pass' },
        verdict: { kind: 'issue', labels: [], evidence: [] },
        actions: [],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      }) },
      { kind: 'turn.completed', sequence: 3 },
    ]);

    const report = await app.executeTask({ taskId, dryRun: false });

    expect(report.outcome).toBe('succeeded');
    expect(report.sessionMode).toBe('ephemeral');
    // 阶段 0 归档自己的会话（ephemeral），但**不写** issue_pipeline.session_id
    expect(callsOf('session/archive')).toHaveLength(1);
    const after = await row();
    expect(after?.stage).toBe('classify');
    expect(after?.sessionId).toBeNull();
    expect(after?.sessionTurns).toBe(0);
    expect(after?.sessionCursor).toBe(0);
  });
});
