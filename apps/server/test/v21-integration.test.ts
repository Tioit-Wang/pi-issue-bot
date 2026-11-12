/**
 * v2.1 全链路集成用例（WS6 / `docs/v21-contract.md` §2、§3、§4、§6）。
 *
 * 全部用**内存假实现**：不需要 PostgreSQL、不需要 pi-host、不打真实 GitHub。
 * 五条对应用户点名的验收面：
 *  ① 未触发事件也留痕（decision=ignored + 具体 reason）
 *  ② 模板渲染进 agent 消息正文，未知占位符原样保留
 *  ③ `source='agent'` 的 v2 产出走 v2 执行器（旧信封路径一次都不碰）
 *  ④ `source='command'` 的旧 4-intent 信封仍走旧路径（零回归）
 *  ⑤ `issues.closed` 只回收沙箱、不删会话行
 */
import { describe, expect, it } from 'vitest';
import { createNullLogger } from '../../../packages/shared/src/index.ts';
import { validRepoSettings } from './helpers/repo-settings.ts';
import { handleWebhook } from '../src/http/index.ts';
import type { WebhookAck, WebhookDeps, WebhookInput } from '../src/http/index.ts';
import {
  V21_DECISION_SQL,
  V21_SESSION_SQL,
  applyV21SessionOnEvent,
  compactionRecordOf,
  createV21Executor,
  decideV21Delivery,
  renderV21AgentText,
  v21RenderContextOf,
} from '../src/http/webhook-v21.ts';
import { createRepoIssuesProvider } from '../src/prompt/repo-issues.ts';
import { runTask } from '../src/worker/run-task.ts';
import type { V21RunExecution, V21RunnerDeps } from '../src/worker/run-task.ts';
import type { EventEnvelope } from '../src/worker/deps.ts';
import type { GithubWriteApi } from '../src/github/index.ts';
import type {
  ActionRecord,
  EnvelopeRecord,
  ExecProxyPort,
  HostPort,
  LifecycleDisposer,
  RunStore,
  TaskRunInput,
  WorktreePort,
} from '../src/worker/index.ts';
import type { SandboxDocker } from '../src/sandbox/index.ts';
import type { TurnDriverOps } from '../src/runtime/turn-driver.ts';

const REPO = 'octo/demo';
const FIXED_NOW = new Date('2026-11-12T08:00:00.000Z');

/* ── 内存 SQL 假实现 ─────────────────────────────────────────────────────── */

type QueryCall = { readonly sql: string; readonly values: readonly unknown[] };

function fakeDb(options: { readonly settings?: unknown; readonly dryRun?: boolean } = {}): {
  readonly query: (text: string, values?: readonly unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
  readonly calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  return {
    calls,
    async query(text, values = []) {
      calls.push({ sql: text, values });
      if (text.includes('FROM "repos"') || text.includes('from repos')) {
        return {
          rows: [
            {
              enabled: true,
              dry_run: options.dryRun ?? true,
              // 必须是**严格层合法**的配置：readRepoPolicy 会用 validateRepoSettings 再校验一次，
              // 给 `{}` 会因 managers 为空 / 词表缺角色而判成 settings_valid=false → repo-disabled。
              settings: options.settings ?? validRepoSettings(),
              settings_valid: true,
              settings_error: null,
              archived_at: null,
              installation_id: null,
              source: 'github',
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('INSERT INTO "webhook_deliveries"')) {
        return { rows: [{ delivery_id: 'delivery-1' }], rowCount: 1 };
      }
      if (text.includes('FROM "agent_sessions" WHERE')) {
        return {
          rows: [{ state: 'active', sandbox_id: 'sbx-1', session_id: 'session-1', turns: 1, cursor: 0 }],
          rowCount: 1,
        };
      }
      if (text.includes('agent_messages') && text.includes('INSERT')) {
        return { rows: [{ id: 'msg-1' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
}

function webhookDeps(db: ReturnType<typeof fakeDb>, withV21: boolean): WebhookDeps {
  return {
    verify: async () => true,
    db: { query: db.query },
    enqueue: async () => 'job-1',
    ack: {} as unknown as WebhookAck,
    logger: createNullLogger(),
    now: () => FIXED_NOW,
    isPaused: async () => false,
    ...(withV21 ? { v21: { db: { query: db.query } } } : {}),
  };
}

function webhookInput(event: string, payload: unknown): WebhookInput {
  return {
    deliveryId: 'delivery-1',
    event,
    rawBody: JSON.stringify(payload),
    signature: 'sha256=test',
    source: 'live',
  } as WebhookInput;
}

function issuePayload(action: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action,
    repository: { full_name: REPO },
    sender: { login: 'alice', type: 'User' },
    issue: {
      number: 42,
      title: '导出按钮点击后闪退',
      body: '用户在 iOS 18 上导出闪退…',
      html_url: `https://github.com/${REPO}/issues/42`,
      state: 'open',
      labels: [{ name: 'bug' }],
      user: { login: 'alice' },
      updated_at: FIXED_NOW.toISOString(),
      ...overrides,
    },
  };
}

function sqlCalls(db: ReturnType<typeof fakeDb>, needle: string): readonly QueryCall[] {
  return db.calls.filter((call) => call.sql.includes(needle));
}

/* ── ① ② 判定留痕与模板渲染 ─────────────────────────────────────────────── */

describe('webhook 侧 v2.1 判定与消息渲染', () => {
  it('① 未触发事件也留痕：decision=ignored、reason=switch-off', async () => {
    const db = fakeDb();
    const result = await handleWebhook(
      webhookDeps(db, true),
      webhookInput('issues', issuePayload('closed')),
    );
    expect(result.status).toBe(200);
    const writes = sqlCalls(db, V21_DECISION_SQL.write);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.values).toEqual(['delivery-1', 'ignored', 'switch-off']);
  });

  it('不注入 v21 时一个判定 UPDATE 都不发（旧路径零回归）', async () => {
    const db = fakeDb();
    await handleWebhook(webhookDeps(db, false), webhookInput('issues', issuePayload('closed')));
    expect(sqlCalls(db, V21_DECISION_SQL.write)).toHaveLength(0);
  });

  it('② 模板渲染进 agent_messages.comment_body，未知占位符原样保留', async () => {
    const settings = validRepoSettings({
      triggers: {
        events: {
          'issues.opened': {
            enabled: 'on',
            prompt: '/issue-format #{{issue.number}} {{issue.url}} {{issue.foo}}',
          },
        },
      },
    });
    const db = fakeDb({ settings });
    const result = await handleWebhook(
      webhookDeps(db, true),
      webhookInput('issues', issuePayload('opened')),
    );
    expect(result.status).toBe(200);
    const inserts = sqlCalls(db, 'agent_messages').filter((call) => call.sql.includes('INSERT'));
    expect(inserts).toHaveLength(1);
    const bodies = inserts[0]?.values.filter((value) => typeof value === 'string') ?? [];
    expect(bodies.some((body) => body.includes('#42 https://github.com/octo/demo/issues/42'))).toBe(true);
    // FR-2.3：未知占位符不做替换，原文照发
    expect(bodies.some((body) => body.includes('{{issue.foo}}'))).toBe(true);
    // 触发了的投递也要留痕（BR-6：触发侧同样写具体 reason，不再留 NULL）
    expect(sqlCalls(db, V21_DECISION_SQL.write)[0]?.values).toEqual([
      'delivery-1',
      'triggered',
      'enabled',
    ]);
  });

  it('模板未写 {{repo.issues}} 时零列表请求（惰性）', async () => {
    let calls = 0;
    const provider = createRepoIssuesProvider({
      listIssues: async () => {
        calls += 1;
        return { total: 0, items: [] };
      },
    });
    const ctx = v21RenderContextOf({
      repo: REPO,
      eventAction: 'opened',
      payload: issuePayload('opened'),
      repoIssues: provider,
    });
    const rendered = await renderV21AgentText({ template: '#{{issue.number}}', ctx });
    expect(rendered.text).toBe('#42');
    expect(rendered.unknown).toEqual([]);
    expect(calls).toBe(0);
  });

  it('PR 事件固定 pr-ignored；五个事件默认值可独立判定', () => {
    const pr = decideV21Delivery({
      event: 'pull_request',
      action: 'opened',
      payload: {},
      settings: {},
    });
    expect(pr).toEqual({ triggered: false, event: 'pull_request.*', reason: 'pr-ignored' });
    const opened = decideV21Delivery({
      event: 'issues',
      action: 'opened',
      payload: issuePayload('opened'),
      settings: {},
    });
    expect(opened?.triggered).toBe(true);
  });
});

/* ── ③ ④ worker 侧产出分流 ─────────────────────────────────────────────── */

type MemoryStore = RunStore & {
  readonly envelopes: EnvelopeRecord[];
  readonly actions: ActionRecord[];
  readonly events: { readonly kind: string; readonly payload: unknown }[];
};

function memoryStore(): MemoryStore {
  const envelopes: EnvelopeRecord[] = [];
  const actions: ActionRecord[] = [];
  const events: { kind: string; payload: unknown }[] = [];
  return {
    envelopes,
    actions,
    events,
    async beginRun() {},
    async appendEvent(input) {
      events.push({ kind: input.kind, payload: input.payload });
    },
    async recordEnvelope(record) {
      envelopes.push(record);
    },
    async recordAction(record) {
      actions.push(record);
    },
    async recordUsage() {},
    async recordDegeneracyHit() {},
    async finishRun() {},
    async markTask() {},
  };
}

function event(kind: string, payload: unknown, index = 0): EventEnvelope {
  return {
    eventId: `${kind}-${String(index)}`,
    scope: 'session',
    epoch: 'epoch-1',
    revision: 1,
    kind,
    occurredAt: FIXED_NOW.toISOString(),
    payload,
  } as unknown as EventEnvelope;
}

function asyncEvents(list: readonly EventEnvelope[]): () => AsyncIterable<EventEnvelope> {
  return () => ({
    async *[Symbol.asyncIterator]() {
      for (const item of list) {
        yield item;
      }
    },
  });
}

function workerHarness(events: readonly EventEnvelope[]): { deps: V21RunnerDeps; store: MemoryStore; executeCalls: string[] } {
  const store = memoryStore();
  const executeCalls: string[] = [];
  const ops = {
    async projectRegister() {
      return { projectId: 'project-1' };
    },
    async sessionCreate() {
      return { id: 'session-1' };
    },
    async eventsSubscribe() {
      return {};
    },
    async turnStart() {
      return { id: 'turn-1' };
    },
    async turnInterrupt() {
      return {};
    },
    async approvalRespond() {
      return {};
    },
    async inputRespond() {
      return {};
    },
    async workspaceDiff() {
      return { diff: '' };
    },
    async sessionArchive() {
      return {};
    },
  } as unknown as TurnDriverOps;
  const worktree = {
    async create() {
      return { taskId: 'task-1', repo: REPO, jobDir: '/tmp/task-1' };
    },
  } as WorktreePort;
  const docker = {
    async ping() {},
    async createContainer() {
      return 'container-1';
    },
    async inspectState() {
      return { containerId: 'container-1', status: 'exited', running: false, exitCode: 0, oomKilled: false };
    },
    async execStream() {
      throw new Error('not used');
    },
    async destroyContainer() {},
  } as unknown as SandboxDocker;
  const proxy = {
    async listen() {
      return { address: 'unix:/tmp/task-1/sock', socketPath: '/tmp/task-1/sock' };
    },
    async destroy() {},
  } as ExecProxyPort;
  const host = {
    async ready() {
      return { hostId: 'host-1', port: 7777, version: '1.2.3' };
    },
    async stop() {},
  } as HostPort;
  const lifecycle = {
    async dispose() {
      return {
        outcome: 'success',
        retention: 'none',
        state: { containerId: 'container-1', status: 'exited', running: false, exitCode: 0, oomKilled: false },
      };
    },
  } as unknown as LifecycleDisposer;
  const github = {
    async listIssueComments() {
      return [];
    },
    async createIssueComment() {
      return { id: 4242, htmlUrl: null };
    },
    async addLabels() {},
    async removeLabel() {},
    async createIssue() {
      return { number: 99 };
    },
    async closeIssue() {},
    async updateIssueComment() {
      return { id: 1, htmlUrl: null };
    },
    async getIssue() {
      return { number: 42, title: '', body: '', state: 'open', labels: [], authorLogin: null, updatedAt: '', isPullRequest: false };
    },
  } as unknown as GithubWriteApi;

  const stubExecute = async (text: string): Promise<V21RunExecution> => {
    executeCalls.push(text);
    return {
      handled: true,
      valid: true,
      errors: [],
      verdict: null,
      actions: [],
      executed: [],
      stoppedAt: null,
    };
  };

  const deps: V21RunnerDeps = {
    worktree,
    docker,
    proxy,
    host,
    lifecycle,
    store,
    ops,
    events: asyncEvents(events),
    github,
    image: 'pi-worker:node22',
    clock: () => FIXED_NOW.getTime(),
    logger: createNullLogger(),
    v21: { execute: stubExecute },
  };
  return { deps, store, executeCalls };
}

function taskInput(overrides: Partial<TaskRunInput> = {}): TaskRunInput {
  return {
    taskId: 'task-1',
    runId: 'run-1',
    command: 'agent:opened',
    repo: REPO,
    targetKind: 'issue',
    targetNumber: 42,
    prompt: '请检查 issue 格式',
    ...overrides,
  };
}

const V21_OUTPUT_TEXT = JSON.stringify({
  actions: [{ type: 'comment', payload: { slot: 'summary', body: '已检查完毕' } }],
});

const OLD_ENVELOPE_TEXT = JSON.stringify({
  verdict: { kind: 'issue', labels: [], evidence: [] },
  actions: [],
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
});

function completedEvents(text: string): readonly EventEnvelope[] {
  return [
    event('item.completed', { text: `\`\`\`json\n${text}\n\`\`\`` }, 0),
    event('turn.completed', { status: 'completed' }, 1),
  ];
}

describe('worker 侧 v2 / 旧信封分流', () => {
  it('③ source=agent 的 v2 产出走 v2 执行器，不回落旧信封', async () => {
    const harness = workerHarness(completedEvents(V21_OUTPUT_TEXT));
    await runTask(taskInput({ source: 'agent' }), harness.deps);
    expect(harness.executeCalls).toHaveLength(1);
    expect(harness.store.events.some((item) => item.kind === 'envelope.v21')).toBe(true);
    // 旧路径的 prepareEnvelope 没有产生 `writeback.dropped` / 旧信封校验错误
    expect(harness.store.events.some((item) => item.kind === 'writeback.dropped')).toBe(false);
  });

  it('④ source=command 的旧 4-intent 信封仍走旧路径，v2 执行器不被调用', async () => {
    const harness = workerHarness(completedEvents(OLD_ENVELOPE_TEXT));
    await runTask(taskInput({ source: 'command', command: '/issue-triage' }), harness.deps);
    expect(harness.executeCalls).toHaveLength(0);
    expect(harness.store.events.some((item) => item.kind === 'envelope.v21')).toBe(false);
    expect(harness.store.envelopes).toHaveLength(1);
  });

  it('v2 整份拒绝时不回落、错误写进 envelopes', async () => {
    const harness = workerHarness(
      completedEvents(JSON.stringify({ actions: [{ type: 'not-a-real-action', payload: {} }] })),
    );
    await runTask(taskInput({ source: 'agent' }), harness.deps);
    expect(harness.executeCalls).toHaveLength(0);
    expect(harness.store.envelopes[0]?.valid).toBe(false);
    expect(harness.store.events.some((item) => item.kind === 'envelope.v21.rejected')).toBe(true);
  });
});

/* ── ⑤ 会话状态与压缩留痕 ───────────────────────────────────────────────── */

describe('会话状态（FR-3.4 / AC-23）与压缩观测', () => {
  it('⑤ issues.closed 只回收沙箱：state=idle、sandbox_id=NULL、closed_at 写入，且没有 DELETE', async () => {
    const db = fakeDb();
    const transition = await applyV21SessionOnEvent(
      { query: db.query },
      { repo: REPO, issueNumber: 42, event: 'issues.closed', issueState: 'closed' },
    );
    expect(transition.action).toBe('recycle-sandbox');
    expect(transition.state).toBe('idle');
    expect(transition.keepSession).toBe(true);
    expect(sqlCalls(db, V21_SESSION_SQL.recycle)).toHaveLength(1);
    expect(db.calls.some((call) => /\bDELETE\b/iu.test(call.sql))).toBe(false);
  });

  it('issue 重开或关闭后其它事件 → reuse + active，永不删行', async () => {
    const db = fakeDb();
    const transition = await applyV21SessionOnEvent(
      { query: db.query },
      { repo: REPO, issueNumber: 42, event: 'issues.opened', issueState: 'open' },
    );
    // 已有会话行时 `issues.opened` = 重开：复用会话、重建沙箱（FR-3.4 规则 ③）
    expect(transition.action).toBe('reuse');
    expect(transition.state).toBe('active');
    expect(transition.rebuildSandbox).toBe(true);

    const reuse = await applyV21SessionOnEvent(
      { query: db.query },
      { repo: REPO, issueNumber: 42, event: 'issue_comment.created', issueState: 'closed' },
    );
    expect(reuse.action).toBe('reuse');
    expect(reuse.state).toBe('active');
    expect(reuse.keepSession).toBe(true);
    expect(db.calls.some((call) => /\bDELETE\b/iu.test(call.sql))).toBe(false);
  });

  it('itemType=compaction 的事件能转成一条只追加的压缩记录', () => {
    const record = compactionRecordOf(
      {
        itemType: 'compaction',
        checkpoint: { generation: 2, beforeTokens: 90_000, afterTokens: 20_000, summary: '摘要', fallback: false },
      },
      { repo: REPO, issueNumber: 42, sessionId: 'session-1' },
    );
    expect(record).toEqual({
      repo: REPO,
      issueNumber: 42,
      sessionId: 'session-1',
      generation: 2,
      beforeTokens: 90_000,
      afterTokens: 20_000,
      summaryChars: 2,
      fallback: false,
    });
    expect(compactionRecordOf({ itemType: 'message' }, { repo: REPO, issueNumber: 42, sessionId: 's' })).toBeNull();
  });
});

/* ── v2 执行器：解析 + 七类动作写回 ─────────────────────────────────────── */

describe('createV21Executor（FR-5.3 / FR-5.4）', () => {
  it('合规 v2 产出 → handled=true 且 comment 动作真的写回', async () => {
    const comments: string[] = [];
    const write = {
      async listIssueComments() {
        return [];
      },
      async createIssueComment(input: { readonly body: string }) {
        comments.push(input.body);
        return { id: 1 };
      },
      async updateIssueComment() {
        return { id: 1 };
      },
      async addLabels() {},
      async removeLabel() {},
      async createIssue() {
        return { number: 1 };
      },
      async closeIssue() {},
    };
    const executor = createV21Executor({ write, settings: async () => ({}) });
    const outcome = await executor(V21_OUTPUT_TEXT, {
      repo: REPO,
      issueNumber: 42,
      dryRun: false,
    });
    expect(outcome.handled).toBe(true);
    expect(outcome.valid).toBe(true);
    expect(comments).toHaveLength(1);
    expect(outcome.result?.executed).toHaveLength(1);
  });

  it('旧 4-intent 信封 → handled=false，调用方回落旧路径', async () => {
    const executor = createV21Executor({
      write: {
        async listIssueComments() {
          return [];
        },
        async createIssueComment() {
          return { id: 1 };
        },
        async updateIssueComment() {
          return { id: 1 };
        },
        async addLabels() {},
        async removeLabel() {},
        async createIssue() {
          return { number: 1 };
        },
        async closeIssue() {},
      },
      settings: async () => ({}),
    });
    const outcome = await executor(OLD_ENVELOPE_TEXT, {
      repo: REPO,
      issueNumber: 42,
      dryRun: false,
    });
    expect(outcome.handled).toBe(false);
    expect(outcome.result).toBeNull();
  });
});
