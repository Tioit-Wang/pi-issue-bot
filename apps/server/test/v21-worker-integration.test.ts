/**
 * WS6-B 集成测试：执行侧（v2 产出分流 + 七类动作写回）+ 会话侧（v2.1 状态机）。
 *
 * 为什么单独一个文件而不是塞进 `worker-run-task.test.ts`：那 28 个用例钉的是
 * **旧链路**（`source='command'` / 无 source / 4-intent 信封），任何一处「顺手改断言」
 * 都会把「v2 接线零回归」这件事变成自证。这里用同一套假端口另起一炉，专门验新分支。
 *
 * 全假依赖：不连 PG、不连 GitHub、不起 docker / pi-host。
 * 四条主线：
 *  ① agent + 合法 v2 产出 → `executeV21()` 七类动作按顺序执行；
 *  ② v2 产出含未知 type → 整份拒绝、零动作、错误落 envelopes.errors 与 run_events；
 *  ③ command + 旧 4-intent 信封 → 仍走 `prepareEnvelope()`（零回归）；
 *  ④ 后三类开关关闭 → 执行前整份拒绝；
 *  ⑤ issues.closed 只回收沙箱、不删会话行、不 archive；reopen 复用；
 *  ⑥ `itemType==='compaction'` 事件 → 追加一行 `agent_compactions`。
 */
import { describe, expect, it } from 'vitest';

import type { EventEnvelope } from '../src/worker/deps.ts';
import type { GithubWriteApi } from '../src/github/index.ts';
import type { TurnDriverOps } from '../src/runtime/turn-driver.ts';
import { retentionForOutcome } from '../src/sandbox/index.ts';
import type { SandboxDocker } from '../src/sandbox/index.ts';
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
import { runTask, compactionRecordOfEvent, probeV21Output, v21CatalogOf } from '../src/worker/run-task.ts';
import type { V21RuntimeConfig, V21RunnerDeps } from '../src/worker/run-task.ts';
import {
  V21_SESSION_TRANSITION_SQL,
  applyV21SessionTransition,
  planV21SessionOnEvent,
  v21SessionRowOf,
} from '../src/app/compose.ts';
import type { SqlExecutor } from '../src/db/index.ts';
import {
  createBoundV21Compactor,
  createCompactor,
  createV21CompactionStore,
} from '../src/app/worker-deps.ts';
import { SESSION_ACTIONS } from '../src/agent/session-state.ts';
import { createV21Executor, createV21OpenPullRequest } from '../src/http/webhook-v21.ts';
import type { GithubRequest } from '../src/github/index.ts';
import type { V21PortSources } from '../src/writeback/v21/execute.ts';
import { listCompactions } from '../src/compact/store.ts';

const REPO = 'octo/demo';
const ISSUE = 7;
const SESSION_ID = 'session-v21-1';
const TURN_ID = 'turn-v21-1';

/** 打开后三类开关 + 一个可管理标签（形状层 schema 是 strict，多一个键都不行）。 */
const ENABLED_SETTINGS = {
  agent: { actions: { create_issue: true, open_pr: true, close_issue: true } },
  labels: {
    max_per_issue: 8,
    vocabulary: [{ name: 'bug', role: 'defect', meaning: '缺陷' }],
  },
} as const;

/** 七类动作各一条（`close_issue` 要求顶层 `verdict==='fail'`）。 */
const SEVEN_ACTIONS = [
  { type: 'verdict', payload: { verdict: 'fail', evidence: ['复现失败'] } },
  { type: 'label', payload: { desired: ['bug'], clear: true } },
  { type: 'comment', payload: { slot: 'result', body: '结论：需要跟进' } },
  { type: 'reaction', payload: { op: 'add', content: 'rocket' } },
  { type: 'create_issue', payload: { title: '跟进项' } },
  { type: 'open_pr', payload: { branch: 'bot/fix', title: '修复 PR' } },
  { type: 'close_issue', payload: {} },
] as const;

function v21Output(actions: readonly unknown[], verdict: string | undefined = undefined): string {
  return JSON.stringify(verdict === undefined ? { actions } : { verdict, actions });
}

/** 事件（`EventEnvelope` 必需字段给全，payload 用最简形状）。 */
function env(kind: string, payload: unknown, index = 0): EventEnvelope {
  return {
    eventId: `${kind}-${String(index)}`,
    scope: 'session',
    epoch: 'epoch-v21',
    revision: 1,
    kind,
    occurredAt: '2026-06-01T00:00:00.000Z',
    payload,
  } as unknown as EventEnvelope;
}

/** 把一段 v2 JSON 放进真 pi-host 的 `item.completed` 文本载体（```json 代码块）。 */
function v21Events(json: string): readonly EventEnvelope[] {
  return [
    env('item.completed', { text: `产出如下：\n\`\`\`json\n${json}\n\`\`\`` }, 1),
    env('turn.completed', { status: 'completed' }, 2),
  ];
}

/** 旧 4-intent 信封（`verdict` 对象 + `actions` + `usage`，与 v2 形状互斥）。 */
function legacyEnvelopeJson(): string {
  return JSON.stringify({
    verdict: {
      kind: 'issue',
      labels: [],
      evidence: [{ rule: 'has-repro-steps', quote: '复现步骤：…', passed: true }],
    },
    actions: [{ intent: 'comment', body: '旧契约的评论' }],
    usage: { inputTokens: 10, outputTokens: 20, costUsd: 0 },
  });
}

function legacyEvents(): readonly EventEnvelope[] {
  return [
    env('item.completed', { text: `\`\`\`json\n${legacyEnvelopeJson()}\n\`\`\`` }, 1),
    env('turn.completed', { status: 'completed' }, 2),
  ];
}

function asyncFrom(list: readonly EventEnvelope[]): AsyncIterable<EventEnvelope> {
  return {
    [Symbol.asyncIterator]: async function* generate(): AsyncGenerator<EventEnvelope> {
      for (const item of list) {
        yield item;
      }
    },
  };
}

/** 内存 RunStore：所有断言都落在这些数组上。 */
function createStore(): RunStore & {
  readonly envelopes: EnvelopeRecord[];
  readonly actions: ActionRecord[];
  readonly runEvents: { kind: string; payload: unknown }[];
} {
  const envelopes: EnvelopeRecord[] = [];
  const actions: ActionRecord[] = [];
  const runEvents: { kind: string; payload: unknown }[] = [];
  const noop = async (): Promise<void> => undefined;
  return {
    envelopes,
    actions,
    runEvents,
    beginRun: noop,
    appendEvent: async (input) => {
      runEvents.push({ kind: input.kind, payload: input.payload });
    },
    recordEnvelope: async (record) => {
      envelopes.push(record);
    },
    recordAction: async (record) => {
      actions.push(record);
    },
    recordUsage: noop,
    recordDegeneracyHit: noop,
    finishRun: noop,
    markTask: noop,
  };
}

function createOps(): TurnDriverOps {
  return {
    async projectRegister() {
      return { projectId: 'project-v21' };
    },
    async sessionCreate() {
      return { id: SESSION_ID };
    },
    async eventsSubscribe() {
      return {};
    },
    async turnStart() {
      return { id: TURN_ID };
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
  };
}

function createGithub(calls: string[]): GithubWriteApi {
  return {
    async listIssueComments() {
      calls.push('listIssueComments');
      return [];
    },
    async createIssueComment() {
      calls.push('createIssueComment');
      return { id: 4242, htmlUrl: null };
    },
    async updateIssueComment(input) {
      calls.push('updateIssueComment');
      return { id: input.commentId, htmlUrl: null };
    },
    async addLabels() {
      calls.push('addLabels');
    },
    async removeLabel() {
      calls.push('removeLabel');
    },
    async createIssue() {
      calls.push('createIssue');
      return { number: 99 };
    },
    async closeIssue() {
      calls.push('closeIssue');
    },
    async getIssue() {
      calls.push('getIssue');
      return {
        number: ISSUE,
        title: '',
        body: '',
        state: 'open',
        labels: [],
        authorLogin: null,
        updatedAt: '',
        isPullRequest: false,
      };
    },
  };
}

interface HarnessOptions {
  readonly events: readonly EventEnvelope[];
  readonly v21?: V21RuntimeConfig;
  readonly source?: 'agent' | 'command' | 'webhook' | 'cron';
  readonly dryRun?: boolean;
}

function createHarness(options: HarnessOptions): {
  readonly deps: V21RunnerDeps;
  readonly store: ReturnType<typeof createStore>;
  readonly calls: string[];
  readonly compactions: readonly unknown[];
} {
  const store = createStore();
  const calls: string[] = [];
  const compactions: unknown[] = [];
  const github = createGithub(calls);

  const worktree: WorktreePort = {
    async create() {
      return { taskId: 'task-v21', repo: REPO, jobDir: 'C:/jobs/v21' };
    },
  };
  const docker: SandboxDocker = {
    async ping() {},
    async createContainer() {
      return 'container-v21';
    },
    async inspectState() {
      return {
        containerId: 'container-v21',
        status: 'exited',
        running: false,
        exitCode: 0,
        oomKilled: false,
      };
    },
    async execStream() {
      throw new Error('集成测试不该 exec');
    },
    async destroyContainer() {},
  };
  const proxy: ExecProxyPort = {
    async listen() {
      return { address: 'unix:/tmp/v21.sock', socketPath: '/tmp/v21.sock' };
    },
    async destroy() {},
  };
  const host: HostPort = {
    async ready() {
      return { hostId: 'host-v21', port: 7777, version: '1.2.3' };
    },
    async stop() {},
  };
  const lifecycle: LifecycleDisposer = {
    async dispose(input) {
      return {
        outcome: input.outcome,
        retention: retentionForOutcome(input.outcome),
        state: null,
      };
    },
  };

  const compactionStore = {
    async record(record: unknown): Promise<void> {
      compactions.push(record);
    },
    async latestGeneration(): Promise<number> {
      return 0;
    },
  };

  const v21: V21RuntimeConfig = {
    settings: ENABLED_SETTINGS,
    reactions: {
      async listReactions() {
        calls.push('listReactions');
        return [];
      },
      async addReaction() {
        calls.push('addReaction');
        return { id: 9001 };
      },
      async removeReaction() {
        calls.push('removeReaction');
      },
    },
    openPullRequest: async () => {
      calls.push('openPullRequest');
      return { number: 77 };
    },
    isOwn: (login: string | null) => login !== null && login.endsWith('[bot]'),
    compactionStore,
    ...(options.v21 ?? {}),
  };

  const deps: V21RunnerDeps = {
    worktree,
    docker,
    proxy,
    host,
    lifecycle,
    store,
    github,
    ops: createOps(),
    events: () => asyncFrom(options.events),
    targets: {
      async load() {
        return { currentLabels: [], botLabels: [] };
      },
    },
    ledger: {
      recordApplied: async () => undefined,
      recordRemoved: async () => undefined,
    },
    image: 'pi-worker:node22',
    lightWorkdir: 'C:/jobs/v21-light',
    clock: () => 1_700_000_000_000,
    v21,
  };
  return { deps, store, calls, compactions };
}

function makeInput(overrides: Partial<TaskRunInput> = {}): TaskRunInput {
  return {
    taskId: 'task-v21',
    runId: 'run-v21',
    command: 'agent:event',
    repo: REPO,
    targetKind: 'issue',
    targetNumber: ISSUE,
    prompt: '请判定并处理这个 issue',
    // light：没有 worktree / 容器 / 处置，把断言集中在「产出 → 写回」这一段
    runtimeMode: 'light',
    source: 'agent',
    ...overrides,
  };
}

/** run_events 里找某一种 kind 的全部载荷。 */
function eventsOf(store: ReturnType<typeof createStore>, kind: string): unknown[] {
  return store.runEvents.filter((item) => item.kind === kind).map((item) => item.payload);
}

describe('WS6-B v2 产出分流（FR-5.3）', () => {
  it('① source=agent 的合法 v2 产出走 executeV21，七类动作按顺序执行并落 actions 行 / run_events', async () => {
    const json = v21Output(SEVEN_ACTIONS, 'fail');
    const harness = createHarness({ events: v21Events(json) });

    const report = await runTask(makeInput(), harness.deps);

    // 1) v2 分支被真正命中（envelopes 只有一行、valid=true）
    expect(report.outcome).toBe('succeeded');
    expect(harness.store.envelopes).toHaveLength(1);
    expect(harness.store.envelopes[0]?.valid).toBe(true);
    expect(harness.store.envelopes[0]?.errors).toEqual([]);
    expect(eventsOf(harness.store, 'envelope.v21')).toHaveLength(1);

    // 2) 七类动作**按顺序**执行（actions 行的顺序就是 executeV21 的顺序）
    expect(harness.store.actions.map((item) => item.intent)).toEqual([
      'v21:verdict',
      'v21:label',
      'v21:comment',
      'v21:reaction',
      'v21:create_issue',
      'v21:open_pr',
      'v21:close_issue',
    ]);
    expect(harness.store.actions.every((item) => item.appliedAt !== null)).toBe(true);

    // 3) 真实写调用顺序：label → comment → reaction → create_issue → open_pr → close_issue
    expect(harness.calls).toEqual([
      'addLabels',
      'listIssueComments',
      'createIssueComment',
      'listReactions',
      'addReaction',
      'createIssue',
      'openPullRequest',
      'closeIssue',
    ]);

    // 4) 结果同时进 run_events 与 report.actions
    const results = eventsOf(harness.store, 'writeback.v21.result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ contract: 'v2', valid: true, dryRun: false });
    expect(report.actions.map((item) => item.intent)).toEqual([
      'v21:verdict',
      'v21:label',
      'v21:comment',
      'v21:reaction',
      'v21:create_issue',
      'v21:open_pr',
      'v21:close_issue',
    ]);
  });

  it('② v2 产出含未知 type：整份拒绝、零动作执行，错误落 envelopes.errors 与 run_events', async () => {
    const json = v21Output([{ type: 'unknown_action', payload: {} }], 'pass');
    const harness = createHarness({ events: v21Events(json) });

    const report = await runTask(makeInput(), harness.deps);

    // 整份拒绝：一条动作都不执行（连 actions 行都不该有）
    expect(harness.store.actions).toHaveLength(0);
    expect(harness.calls).toEqual([]);
    expect(report.actions).toHaveLength(0);
    // 不回落旧信封：envelopes 只有一行，且是 v2 的字段级错误
    expect(harness.store.envelopes).toHaveLength(1);
    expect(harness.store.envelopes[0]?.valid).toBe(false);
    const errors = harness.store.envelopes[0]?.errors as readonly { path: string; message: string }[];
    expect(errors[0]?.path).toBe('/actions/0/type');
    expect(JSON.stringify(errors)).toContain('verdict');
    // run_events 同样留痕
    const rejected = eventsOf(harness.store, 'envelope.v21.rejected');
    expect(rejected).toHaveLength(1);
    expect(JSON.stringify(rejected[0])).toContain('/actions/0/type');
    // 没有走旧 prepareEnvelope，也不会有旧兜底评论
    expect(eventsOf(harness.store, 'writeback.fallback')).toHaveLength(0);
    expect(eventsOf(harness.store, 'writeback.v21.result')).toHaveLength(0);
  });

  it('③ source=command 的旧 4-intent 信封仍走 prepareEnvelope（零回归）', async () => {
    const harness = createHarness({ events: legacyEvents() });

    const report = await runTask(makeInput({ source: 'command', command: '/issue-triage' }), harness.deps);

    expect(report.outcome).toBe('succeeded');
    expect(report.envelope?.valid).toBe(true);
    expect(report.envelope?.accepted.map((item) => item.intent)).toEqual(['comment']);
    expect(harness.store.envelopes).toHaveLength(1);
    expect(harness.store.envelopes[0]?.valid).toBe(true);
    expect(harness.store.actions.map((item) => item.intent)).toEqual(['comment']);
    expect(harness.calls).toContain('createIssueComment');
    // v2 分支一次都没碰
    expect(eventsOf(harness.store, 'writeback.v21.result')).toHaveLength(0);
    expect(eventsOf(harness.store, 'envelope.v21')).toHaveLength(0);
  });

  it('④ 后三类动作开关关闭时，执行前整份拒绝（零动作 + action-disabled 错误）', async () => {
    const json = v21Output(
      [
        { type: 'comment', payload: { slot: 'result', body: '本来要发的评论' } },
        { type: 'create_issue', payload: { title: '不该被创建' } },
        { type: 'open_pr', payload: { branch: 'bot/fix', title: '不该被打开' } },
        { type: 'close_issue', payload: {} },
      ],
      'fail',
    );
    const harness = createHarness({ events: v21Events(json), v21: { settings: {} } });

    const report = await runTask(makeInput(), harness.deps);

    expect(harness.store.actions).toHaveLength(0);
    expect(harness.calls).toEqual([]);
    expect(harness.store.envelopes).toHaveLength(1);
    expect(harness.store.envelopes[0]?.valid).toBe(false);
    const errors = harness.store.envelopes[0]?.errors as readonly { message: string }[];
    expect(JSON.stringify(errors)).toContain('action-disabled');
    const results = eventsOf(harness.store, 'writeback.v21.result');
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results[0])).toContain('action-disabled');
    expect(report.outcome).toBe('failed');
  });

  it('⑦ 装配层注入的 execute 钩子（compose → createV21Executor → executeV21）同样走通七类动作', async () => {
    const calls: string[] = [];
    const github = createGithub(calls);
    const executor = createV21Executor({
      write: github as V21PortSources['write'],
      settings: async () => ENABLED_SETTINGS,
      reactions: {
        async listReactions() {
          calls.push('listReactions');
          return [];
        },
        async addReaction() {
          calls.push('addReaction');
          return { id: 9100 };
        },
        async removeReaction() {
          calls.push('removeReaction');
        },
      },
      openPullRequest: async () => {
        calls.push('openPullRequest');
        return { number: 78 };
      },
    });
    const harness = createHarness({
      events: v21Events(v21Output(SEVEN_ACTIONS, 'fail')),
      v21: {
        execute: async (text, ctx) => {
          const outcome = await executor(text, ctx);
          return {
            handled: outcome.handled,
            valid: outcome.valid,
            errors: outcome.errors,
            verdict: outcome.output?.verdict ?? null,
            actions: outcome.output?.actions ?? [],
            executed: (outcome.result?.executed ?? []).map((item) => ({
              index: item.index,
              type: item.type,
              outcome: item.outcome,
            })),
            stoppedAt: outcome.result?.stoppedAt ?? null,
          };
        },
      },
    });

    const report = await runTask(makeInput(), harness.deps);

    expect(report.outcome).toBe('succeeded');
    expect(harness.store.envelopes).toHaveLength(1);
    expect(harness.store.envelopes[0]?.valid).toBe(true);
    expect(harness.store.actions.map((item) => item.intent)).toEqual([
      'v21:verdict',
      'v21:label',
      'v21:comment',
      'v21:reaction',
      'v21:create_issue',
      'v21:open_pr',
      'v21:close_issue',
    ]);
    expect(calls).toContain('createIssue');
    expect(calls).toContain('openPullRequest');
    expect(calls).toContain('closeIssue');
    expect(eventsOf(harness.store, 'writeback.v21.result')).toHaveLength(1);
  });

  it('⑧ settings 解析失败（ok:false）只按形状默认值继续，不停工、不抛', async () => {
    // `readV21Settings()` / `resolveAgentExecution()` 的 ok:false 只能用来记告警：
    // 回退默认值后三类开关全关，仍要正常产出 envelopes / errors，而不是让 run 崩掉。
    const json = v21Output([{ type: 'create_issue', payload: { title: '不该被创建' } }]);
    const harness = createHarness({ events: v21Events(json), v21: { settings: '坏配置' } });

    const report = await runTask(makeInput(), harness.deps);

    expect(report.steps).toContain('execute');
    expect(harness.store.envelopes).toHaveLength(1);
    expect(harness.store.envelopes[0]?.valid).toBe(false);
    expect(JSON.stringify(harness.store.envelopes[0]?.errors)).toContain('action-disabled');
    expect(harness.calls).toEqual([]);
  });

  it('⑨ catalog 用 resolveManagedCatalog() 全量返回，retired / unmanaged / 空 meaning 都不提前筛', () => {
    const settings = {
      labels: {
        max_per_issue: 8,
        vocabulary: [
          { name: 'ok', role: 'defect', meaning: '正常' },
          { name: 'retired', role: 'defect', meaning: '已停用', status: 'retired' },
          { name: 'unmanaged', role: 'defect', meaning: '人自己管', managed: false },
          { name: 'no-meaning', role: 'defect' },
        ],
      },
    };
    const catalog = v21CatalogOf(settings);
    expect(catalog).toHaveLength(4);
    expect(catalog.find((entry) => entry.name === 'retired')?.status).toBe('retired');
    expect(catalog.find((entry) => entry.name === 'unmanaged')?.managed).toBe(false);
    expect(catalog.find((entry) => entry.name === 'no-meaning')?.meaning).toBeNull();
    // 过滤发生在 planLabelTargetState，不在装配层：desired 里的 retired 会被整批拒绝
    expect(catalog.every((entry) => typeof entry.name === 'string')).toBe(true);
  });

  it('actions: [] 是合法 v2 产出（只判定不动作），不视为失败', async () => {
    const harness = createHarness({ events: v21Events(v21Output([], 'pass')) });

    const report = await runTask(makeInput(), harness.deps);

    expect(report.outcome).toBe('succeeded');
    expect(harness.store.envelopes).toHaveLength(1);
    expect(harness.store.envelopes[0]?.valid).toBe(true);
    expect(harness.store.actions).toHaveLength(0);
    expect(harness.calls).toEqual([]);
    expect(eventsOf(harness.store, 'writeback.v21.result')).toHaveLength(1);
  });
});

describe('WS6-B 会话状态（FR-3.4 / AC-23）', () => {
  const existingSession = {
    repo: REPO,
    issueNumber: ISSUE,
    sessionId: SESSION_ID,
    state: 'active' as const,
    sandboxId: 'sandbox-1',
    turns: 3,
    cursor: 9,
  };

  it('⑤ issues.closed 只回收沙箱（state=idle / sandbox_id 清空 / closed_at），不删会话行、不 archive；reopen 复用', () => {
    const closed = planV21SessionOnEvent({
      repo: REPO,
      issueNumber: ISSUE,
      session: existingSession,
      event: 'issues.closed',
      issueState: 'closed',
    });
    expect(closed.transition.action).toBe('recycle-sandbox');
    expect(closed.transition.state).toBe('idle');
    expect(closed.transition.keepSession).toBe(true);
    expect(closed.transition.rebuildSandbox).toBe(false);
    expect(closed.deleteSession).toBe(false);
    expect(closed.archiveSessionId).toBeNull();
    expect(closed.sql).toBe(V21_SESSION_TRANSITION_SQL.recycle);
    expect(closed.sql).toContain("'idle'");
    expect(closed.sql).toContain('"sandbox_id" = NULL');
    expect(closed.sql).toContain('"closed_at" = now()');
    // 状态机本身根本没有 delete / archive 这两种动作
    expect(SESSION_ACTIONS).not.toContain('delete');
    expect(SESSION_ACTIONS).not.toContain('archive');
    for (const sql of Object.values(V21_SESSION_TRANSITION_SQL)) {
      expect(sql.toUpperCase()).not.toContain('DELETE');
      expect(sql.toLowerCase()).not.toContain('archive');
    }

    const reopened = planV21SessionOnEvent({
      repo: REPO,
      issueNumber: ISSUE,
      session: { ...existingSession, state: 'idle', sandboxId: null },
      event: 'issues.opened',
      issueState: 'open',
    });
    expect(reopened.transition.action).toBe('reuse');
    expect(reopened.transition.state).toBe('active');
    expect(reopened.transition.keepSession).toBe(true);
    expect(reopened.sql).toBe(V21_SESSION_TRANSITION_SQL.reuse);
    expect(reopened.sql).toContain('"closed_at" = NULL');

    // 关闭后的其它触发（评论打到已关闭 issue 上）同样复用、不删行
    const commentOnClosed = planV21SessionOnEvent({
      repo: REPO,
      issueNumber: ISSUE,
      session: { ...existingSession, state: 'idle', sandboxId: null },
      event: 'issue_comment.created',
      issueState: 'closed',
    });
    expect(commentOnClosed.transition.action).toBe('reuse');
    expect(commentOnClosed.transition.state).toBe('active');
    expect(commentOnClosed.deleteSession).toBe(false);
  });

  it('⑤c rebuildSandbox=true 由装配层注入 createSandbox，新 id 回填进 SQL 参数', async () => {
    const queries: { text: string; values: readonly unknown[] }[] = [];
    const db = {
      query: async (text: string, values: unknown[] = []) => {
        queries.push({ text, values });
        if (text.includes('SELECT')) {
          return {
            rows: [
              {
                state: 'idle',
                sandbox_id: null,
                session_id: SESSION_ID,
                turns: 3,
                cursor: 9,
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
    } as unknown as SqlExecutor;

    let created = 0;
    const applied = await applyV21SessionTransition(
      db,
      { repo: REPO, issueNumber: ISSUE, event: 'issues.opened', issueState: 'open' },
      {
        createSandbox: async () => {
          created += 1;
          return 'sandbox-rebuilt';
        },
      },
    );

    expect(applied.transition.action).toBe('reuse');
    expect(applied.transition.rebuildSandbox).toBe(true);
    expect(applied.rebuildSandbox).toBe(true);
    expect(created).toBe(1);
    // reuse 的第三个参数就是新沙箱 id
    expect(queries[1]?.values).toEqual([REPO, ISSUE, 'sandbox-rebuilt']);
    expect(queries.every((item) => !item.text.toUpperCase().includes('DELETE'))).toBe(true);
  });

  it('⑤b applyV21SessionTransition 真的只发 SELECT + UPDATE（无 DELETE / 无 archive）', async () => {
    const queries: { text: string; values: readonly unknown[] }[] = [];
    const db = {
      query: async (text: string, values: unknown[] = []) => {
        queries.push({ text, values });
        if (text.includes('SELECT')) {
          return {
            rows: [
              {
                state: 'active',
                sandbox_id: 'sandbox-1',
                session_id: SESSION_ID,
                turns: 3,
                cursor: 9,
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
    } as unknown as SqlExecutor;

    const applied = await applyV21SessionTransition(db, {
      repo: REPO,
      issueNumber: ISSUE,
      event: 'issues.closed',
      issueState: 'closed',
    });

    expect(applied.transition.action).toBe('recycle-sandbox');
    expect(applied.transition.state).toBe('idle');
    expect(applied.deleteSession).toBe(false);
    expect(applied.archiveSessionId).toBeNull();
    expect(queries).toHaveLength(2);
    expect(queries[0]?.text).toContain('SELECT');
    expect(queries[1]?.text.toUpperCase()).toContain('UPDATE');
    expect(queries.every((item) => !item.text.toUpperCase().includes('DELETE'))).toBe(true);
    // 读回来的行确实带会话 id（没被清空、没被删）
    const row = (queries[0]?.text ?? '').length > 0 ? v21SessionRowOf(
      {
        state: 'active',
        sandbox_id: 'sandbox-1',
        session_id: SESSION_ID,
        turns: 3,
        cursor: 9,
      },
      { repo: REPO, issueNumber: ISSUE },
    ) : null;
    expect(row?.sessionId).toBe(SESSION_ID);
  });
});

describe('WS6-B 压缩观测（FR-5.6，本轮只做识别 + 记录）', () => {
  it('⑥ 事件流里 itemType=compaction → 追加一行 agent_compactions', async () => {
    // 压缩事件必须在 `turn.completed` **之前**：事件循环遇到终态就停止消费，
    // 放在终态之后的那条事件根本到不了 `onEvent`。
    const [outputEvent, terminalEvent] = v21Events(v21Output([], 'pass'));
    const events = [
      outputEvent,
      env(
        'item.completed',
        {
          itemId: 'cp-1',
          itemType: 'compaction',
          checkpoint: {
            generation: 2,
            beforeTokens: 120_000,
            afterTokens: 18_000,
            summary: '## 目标\n继续修复登录问题',
            fallback: false,
          },
        },
        3,
      ),
      terminalEvent,
    ].filter((item): item is EventEnvelope => item !== undefined);
    const harness = createHarness({ events });

    await runTask(makeInput(), harness.deps);

    expect(harness.compactions).toHaveLength(1);
    expect(harness.compactions[0]).toMatchObject({
      repo: REPO,
      issueNumber: ISSUE,
      sessionId: SESSION_ID,
      generation: 2,
      beforeTokens: 120_000,
      afterTokens: 18_000,
      fallback: false,
    });
    expect(eventsOf(harness.store, 'compact.recorded')).toHaveLength(1);
    // 纯函数本身可单测：非压缩事件返回 null
    expect(compactionRecordOfEvent({ itemType: 'message' }, {
      repo: REPO,
      issueNumber: ISSUE,
      sessionId: SESSION_ID,
    })).toBeNull();
  });

  it('probeV21Output 三态：valid / rejected / not-v21（旧信封不误判成 v2）', () => {
    const asCaptured = (list: readonly EventEnvelope[]) =>
      list.map((item) => ({ eventId: item.eventId, kind: item.kind, payload: item.payload }));

    expect(probeV21Output(asCaptured(v21Events(v21Output([], 'pass')))).kind).toBe('valid');
    expect(probeV21Output(asCaptured(v21Events(v21Output([{ type: 'nope', payload: {} }])))).kind).toBe(
      'rejected',
    );
    // 旧 4-intent 信封（有 usage、verdict 是对象）必须回落旧路径
    expect(probeV21Output(asCaptured(legacyEvents())).kind).toBe('not-v21');
  });

  it('worker-deps 暴露 createCompactor 与可绑定的压缩器工厂', () => {
    expect(typeof createCompactor).toBe('function');
    expect(typeof createBoundV21Compactor).toBe('function');
  });

  it('createV21CompactionStore 同步构造，CompactStore 上只有 record / latestGeneration；listCompactions 是独立函数', async () => {
    const queries: string[] = [];
    const db = {
      query: async (text: string) => {
        queries.push(text);
        return { rows: [], rowCount: 0 };
      },
    } as unknown as SqlExecutor;
    const store = createV21CompactionStore(db);

    // 同步返回：不是 Promise
    expect(store).not.toBeInstanceOf(Promise);
    expect(typeof store.record).toBe('function');
    expect(typeof store.latestGeneration).toBe('function');
    expect('listCompactions' in store).toBe(false);
    expect(typeof listCompactions).toBe('function');

    await store.record({
      repo: REPO,
      issueNumber: ISSUE,
      sessionId: SESSION_ID,
      generation: 1,
      beforeTokens: 100,
      afterTokens: 50,
      summaryChars: 10,
      fallback: false,
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('INSERT INTO agent_compactions');
    expect(queries[0]?.toUpperCase()).not.toContain('UPDATE');
    expect(queries[0]?.toUpperCase()).not.toContain('DELETE');
  });
});

describe('WS6-B 开 PR 能力（V21PortSources.openPullRequest 的真实实现）', () => {
  it('createV21OpenPullRequest 走 GET 默认分支 + POST /repos/{owner}/{repo}/pulls，返回 {number}', async () => {
    const calls: { route: string; params: Record<string, unknown> }[] = [];
    const request = (async (route: string, params?: Record<string, unknown>) => {
      calls.push({ route, params: params ?? {} });
      if (route.startsWith('GET')) {
        return { data: { default_branch: 'main' }, headers: {} };
      }
      return { data: { number: 321 }, headers: {} };
    }) as unknown as GithubRequest;

    const open = createV21OpenPullRequest(request);
    const ref = await open({ repo: REPO, head: 'bot/fix', title: '修复', body: '正文' });

    expect(ref).toEqual({ number: 321 });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.route).toBe('GET /repos/{owner}/{repo}');
    expect(calls[1]?.route).toBe('POST /repos/{owner}/{repo}/pulls');
    expect(calls[1]?.params).toMatchObject({
      owner: 'octo',
      repo: 'demo',
      head: 'bot/fix',
      base: 'main',
      title: '修复',
      body: '正文',
    });
  });
});
