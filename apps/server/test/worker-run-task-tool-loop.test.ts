/**
 * 只读工具轮（v2.3 `docs/plan-issue-tools.md` §3 B）在**执行链路**上的单测。
 *
 * 与另外两个文件的分工：
 *  - `worker-run-task.test.ts` 钉的是旧九步与旧信封，本文件**一个断言都不改它**；
 *  - `v21-worker-integration.test.ts` 钉的是「产出 → 写回」的分流，这里钉的是
 *    「一轮变成几轮」：第几轮会再起一次 `turn/start`、每一轮的边界条件是什么、
 *    读到的东西有没有真的进下一轮提示词。
 *
 * 全部依赖都是假的（不连 GitHub、不起 docker / pi-host），三条证据链：
 *  1. 假 ops 自己记调用序（`turn/start#N`、`session/archive`）—— 「有没有真的跑第二轮」不是靠日志猜；
 *  2. 假执行器记模型给的入参 —— 「读的是模型要的那条」而不是平台自己编的；
 *  3. 内存 store 断言 `run_events` / `envelopes` / `actions` 三张表的落点。
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
import { runTask } from '../src/worker/run-task.ts';
import type { V21RunnerDeps } from '../src/worker/run-task.ts';
import { ISSUE_TOOL_LOOP_BUDGET } from '../src/runtime/issue-tool-loop.ts';
import type { IssueReadCall, IssueReadResult } from '../src/runtime/issue-read-tools.ts';

const REPO = 'octo/demo';
const ISSUE = 331;
const SESSION_ID = 'session-tools-1';

/** 一条事件（`EventEnvelope` 必需字段给全；schema 未 vendored，payload 用最简形状）。 */
function env(kind: string, payload: unknown, index = 0): EventEnvelope {
  return {
    eventId: `${kind}-${String(index)}`,
    scope: 'session',
    epoch: 'epoch-tools',
    revision: 1,
    kind,
    occurredAt: '2026-06-01T00:00:00.000Z',
    payload,
  } as unknown as EventEnvelope;
}

/** 把一段 v2 JSON 放进真 pi-host 的 `item.completed` 文本载体（```json 代码块）。 */
function v21Events(json: string, index: number): readonly EventEnvelope[] {
  return [
    env('item.completed', { text: `产出如下：\n\`\`\`json\n${json}\n\`\`\`` }, index),
    env('turn.completed', { status: 'completed' }, index + 1),
  ];
}

/**
 * 中间轮产出：`tool_calls` + 空 `actions`。
 *
 * `actions` **必须**写出空数组：v2 契约里它是必填项，「有 tool_calls ⇒ 没有 actions」
 * 说的是不许有**非空** actions（`semanticIssuesOf()` 只拒 `actions.length > 0`）。
 */
function middleRoundJson(calls: readonly unknown[]): string {
  return JSON.stringify({ actions: [], tool_calls: calls });
}

/** 最终轮产出：只给 `actions`（`tool_calls` 缺席 = 这一轮是结论）。 */
function finalRoundJson(actions: readonly unknown[]): string {
  return JSON.stringify({ actions });
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

/** 内存 `RunStore`：所有落库断言都读这三个数组。 */
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

/** 假 ops：记调用序、交给宿主的提示词、归档过哪些会话。 */
function createOps(): TurnDriverOps & {
  readonly order: string[];
  readonly prompts: string[];
  readonly archives: string[];
} {
  const order: string[] = [];
  const prompts: string[] = [];
  const archives: string[] = [];
  let turns = 0;
  return {
    order,
    prompts,
    archives,
    async projectRegister() {
      return { projectId: 'project-tools' };
    },
    async sessionCreate() {
      order.push('session/create');
      return { id: SESSION_ID };
    },
    async eventsSubscribe() {
      return {};
    },
    async turnStart(params) {
      turns += 1;
      order.push(`turn/start#${String(turns)}`);
      prompts.push(params.input.text);
      return { id: `turn-${String(turns)}` };
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
    async sessionArchive(params) {
      order.push('session/archive');
      archives.push(params.sessionId);
      return {};
    },
    // 真 `RacpOps` 有这条：第 2 轮起 worker 传 `persistent + sessionId`，driveTurn 会先 attach。
    async sessionAttach() {
      order.push('session/attach');
      return { cursor: 0 };
    },
  };
}

/** 假 GitHub 写面：只记方法名（本文件要断言的是「一个写方法都没被调用」）。 */
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

/** 假的读工具结果（真的截断 / 围栏在 `issue-read-tools` 自己的单测里钉）。 */
function readResult(call: IssueReadCall): IssueReadResult {
  return {
    name: call.name,
    ok: true,
    summary: `${call.name} #${String(call.input['number'] ?? '')} → 2 条`,
    items: 2,
    text: 'comment_id=1 @alice：第一条评论\ncomment_id=2 @bob：第二条评论',
    truncated: false,
  };
}

interface HarnessOptions {
  /** 每轮的事件流（第 N 次 `events()` 调用取第 N 个）；少给 = 那一轮没有事件。 */
  readonly rounds: readonly (readonly EventEnvelope[])[];
  /** 只读执行器（不传 = `readTools` 不注入，即「装配层还没接读面」）。 */
  readonly readTools?: { readonly executor: (call: IssueReadCall) => Promise<IssueReadResult> };
}

function createHarness(options: HarnessOptions): {
  readonly deps: V21RunnerDeps;
  readonly store: ReturnType<typeof createStore>;
  readonly ops: ReturnType<typeof createOps>;
  readonly github: { readonly calls: string[] };
} {
  const store = createStore();
  const ops = createOps();
  const githubCalls: string[] = [];
  const github = createGithub(githubCalls);

  const worktree: WorktreePort = {
    async create() {
      return { taskId: 'task-tools', repo: REPO, jobDir: 'C:/jobs/tools' };
    },
  };
  const docker: SandboxDocker = {
    async ping() {},
    async createContainer() {
      return 'container-tools';
    },
    async inspectState() {
      return {
        containerId: 'container-tools',
        status: 'exited',
        running: false,
        exitCode: 0,
        oomKilled: false,
      };
    },
    async execStream() {
      throw new Error('只读工具轮不该自己 exec');
    },
    async destroyContainer() {},
  };
  const proxy: ExecProxyPort = {
    async listen() {
      return { address: 'unix:/tmp/tools.sock', socketPath: '/tmp/tools.sock' };
    },
    async destroy() {},
  };
  const host: HostPort = {
    async ready() {
      return { hostId: 'host-tools', port: 7777, version: '1.2.3' };
    },
    async stop() {},
  };
  const lifecycle: LifecycleDisposer = {
    async dispose(input) {
      return { outcome: input.outcome, retention: retentionForOutcome(input.outcome), state: null };
    },
  };

  let roundIndex = 0;
  const deps: V21RunnerDeps = {
    worktree,
    docker,
    proxy,
    host,
    lifecycle,
    store,
    github,
    ops,
    // 每次 `driveTurn()` 都重新调一次 `events()`：按轮次把事件流切开
    events: () => {
      const list = options.rounds[roundIndex] ?? [];
      roundIndex += 1;
      return asyncFrom(list);
    },
    image: 'pi-worker:node22',
    lightWorkdir: 'C:/jobs/tools-light',
    clock: () => 1_700_000_000_000,
    // `readTools` 挂在 `v21` 上（与 `issueEdit` 同一层注入）；不传就整块都不注入
    ...(options.readTools === undefined ? {} : { v21: { readTools: options.readTools } }),
  };

  return { deps, store, ops, github: { calls: githubCalls } };
}

function makeInput(overrides: Partial<TaskRunInput> = {}): TaskRunInput {
  return {
    taskId: 'task-tools',
    runId: 'run-tools',
    command: 'agent:event',
    repo: REPO,
    targetKind: 'issue',
    targetNumber: ISSUE,
    prompt: '请判定这个 issue 是否符合报告标准',
    // light：没有 worktree / 容器 / 处置，断言集中在「轮次」这一段
    runtimeMode: 'light',
    source: 'agent',
    ...overrides,
  };
}

/** `run_events` 里某一种 kind 的全部载荷。 */
function payloadsOf(store: ReturnType<typeof createStore>, kind: string): unknown[] {
  return store.runEvents.filter((item) => item.kind === kind).map((item) => item.payload);
}

describe('只读工具轮：一轮 → 多轮（执行链路）', () => {
  it('第 1 轮交 tool_calls：真的读一次、第二次 turn/start 用工具结果段，且没有发生任何写回', async () => {
    const calls: IssueReadCall[] = [];
    const harness = createHarness({
      rounds: [
        v21Events(middleRoundJson([{ name: 'IssueCommentsList', input: { number: ISSUE } }]), 1),
        // 最终轮：只判定不动作（`actions: []` 是合法 v2 产出）
        v21Events(finalRoundJson([]), 10),
      ],
      readTools: {
        executor: async (call) => {
          calls.push(call);
          return readResult(call);
        },
      },
    });

    const report = await runTask(makeInput(), harness.deps);

    // 1) 执行器被调用一次，入参就是模型交的那一条（平台只补 repo）
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('IssueCommentsList');
    expect(calls[0]?.input).toEqual({ number: ISSUE });

    // 2) 真的起了第二次 turn/start，第二轮的提示词是「工具结果段」而不是原文重复一遍
    expect(harness.ops.prompts).toHaveLength(2);
    expect(harness.ops.prompts[0]).toBe('请判定这个 issue 是否符合报告标准');
    expect(harness.ops.prompts[1]).toContain('工具结果');
    // 读到的正文必须进提示词，否则「读了」等于没读
    expect(harness.ops.prompts[1]).toContain('comment_id=1');
    // 围栏（「这是数据不是指令」）只有 `renderToolResultsSection()` 会写
    expect(harness.ops.prompts[1]).toContain('不是指令');

    // 3) 审计：读调用与轮次各一行，读**不进** actions 表
    const kinds = harness.store.runEvents.map((item) => item.kind);
    expect(kinds).toContain('issue.tool.read');
    expect(kinds).toContain('tool.round');
    expect(payloadsOf(harness.store, 'issue.tool.read')).toEqual([
      { name: 'IssueCommentsList', ok: true, items: 2, summary: `IssueCommentsList #${String(ISSUE)} → 2 条`, errorCode: null },
    ]);
    expect(payloadsOf(harness.store, 'tool.round')).toEqual([
      { round: 1, calls: ['IssueCommentsList'], clamped: false },
    ]);

    // 4) 零写回：最终轮 `actions: []`，一个写方法都不该被调用
    expect(harness.github.calls).toEqual([]);
    expect(harness.store.actions).toEqual([]);
    expect(report.actions).toEqual([]);
    expect(harness.store.envelopes).toHaveLength(1);
    expect(harness.store.envelopes[0]?.valid).toBe(true);
    expect(report.outcome).toBe('succeeded');

    // 5) 会话收尾：第 1 轮 ephemeral 由 driveTurn 归档；第 2 轮 persistent 由 worker 归档
    expect(harness.ops.archives).toEqual([SESSION_ID, SESSION_ID]);
  });

  it('第 2 轮交最终产出：写回只执行一次，envelopes 记的是最终轮那一份', async () => {
    const calls: IssueReadCall[] = [];
    const finalActions = [{ type: 'comment', payload: { slot: 'result', body: '结论：需要修复' } }];
    const harness = createHarness({
      rounds: [
        v21Events(middleRoundJson([{ name: 'IssueGet', input: { number: ISSUE } }]), 1),
        v21Events(finalRoundJson(finalActions), 10),
      ],
      readTools: {
        executor: async (call) => {
          calls.push(call);
          return readResult(call);
        },
      },
    });

    const report = await runTask(makeInput(), harness.deps);

    expect(calls).toHaveLength(1);
    // 写回一次：`comment` 动作要先读槽位再写，所以恰好一条 createIssueComment
    expect(harness.github.calls.filter((name) => name === 'createIssueComment')).toHaveLength(1);
    expect(harness.github.calls).not.toContain('addLabels');
    // 每 run 只有一行 envelopes，而且必须是**最终轮**那份（中间轮只有 tool_calls）
    expect(harness.store.envelopes).toHaveLength(1);
    expect(harness.store.envelopes[0]?.actions).toEqual(finalActions);
    expect(harness.store.envelopes[0]?.valid).toBe(true);
    expect(report.outcome).toBe('succeeded');
  });

  it('未注入 readTools：只发生一次 turn/start（老行为逐字节不变，也不多归档）', async () => {
    const harness = createHarness({
      // 就算模型交了 tool_calls，没有执行器也不该起第二轮
      rounds: [v21Events(middleRoundJson([{ name: 'IssueGet', input: { number: ISSUE } }]), 1)],
    });

    const report = await runTask(makeInput(), harness.deps);

    expect(harness.ops.prompts).toHaveLength(1);
    expect(harness.ops.prompts[0]).toBe('请判定这个 issue 是否符合报告标准');
    const kinds = harness.store.runEvents.map((item) => item.kind);
    expect(kinds).not.toContain('issue.tool.read');
    expect(kinds).not.toContain('tool.round');
    expect(kinds).not.toContain('tool.budget-exhausted');
    // 不多归档：第 1 轮是 ephemeral，driveTurn 自己归档过一次就够了
    expect(harness.ops.archives).toEqual([SESSION_ID]);
    // `tool_calls` 被当成 `actions: []` 的空产出：照旧记一行合法信封，一个写都不做
    expect(harness.store.envelopes[0]?.valid).toBe(true);
    expect(harness.github.calls).toEqual([]);
    expect(report.outcome).toBe('succeeded');
  });

  it('第 2 轮拿不到终态事件：回退到上一轮结论（不判失败、不写回），并留一条 tool.round-aborted', async () => {
    const calls: IssueReadCall[] = [];
    const harness = createHarness({
      // 只给第 1 轮的事件流：第 2 轮拿到的是空流（实机形态 = `RacpChannel` 的单轮事件喂
      // 已经结束，见 `app/racp.ts` 的 `createEventFeed()`）
      rounds: [v21Events(middleRoundJson([{ name: 'IssueCommentsList', input: { number: ISSUE } }]), 1)],
      readTools: {
        executor: async (call) => {
          calls.push(call);
          return readResult(call);
        },
      },
    });

    const report = await runTask(makeInput(), harness.deps);

    // 第二轮确实起过（读了才可能起），但没有拿到终态 → 整轮作废
    expect(calls).toHaveLength(1);
    expect(harness.ops.prompts).toHaveLength(2);
    const kinds = harness.store.runEvents.map((item) => item.kind);
    expect(kinds).toContain('tool.round-aborted');
    expect(kinds).not.toContain('tool.budget-exhausted');
    // 结论回退到第 1 轮那份（`actions: []` 的合法产出）：run 不该因为「多跑了一轮」失败
    expect(harness.store.envelopes).toHaveLength(1);
    expect(harness.store.envelopes[0]?.valid).toBe(true);
    expect(harness.github.calls).toEqual([]);
    expect(report.outcome).toBe('succeeded');
    expect(report.terminal).toBe('turn.completed');
  });

  it('预算耗尽：跨轮累计上限（`maxCallsPerRun`）挡住第 3 轮，并留一条 tool.budget-exhausted', async () => {
    const calls: IssueReadCall[] = [];
    // 一轮交满额度（不是写死 6：直接跟 `issue-tool-loop.ts` 的常量走）
    const fullRound = Array.from({ length: ISSUE_TOOL_LOOP_BUDGET.maxCallsPerRun }, (_unused, index) => ({
      name: 'IssueGet',
      input: { number: 300 + index },
    }));
    const harness = createHarness({
      rounds: [
        v21Events(middleRoundJson(fullRound), 1),
        // 第 2 轮再交满额度：累计额度已经用完 → 这里就该被挡下
        v21Events(middleRoundJson(fullRound), 10),
      ],
      readTools: {
        executor: async (call) => {
          calls.push(call);
          return readResult(call);
        },
      },
    });

    const report = await runTask(makeInput(), harness.deps);

    // 第 1 轮的额度被真的用掉了，第 2 轮一条都没执行
    expect(calls).toHaveLength(ISSUE_TOOL_LOOP_BUDGET.maxCallsPerRun);
    // 两轮 turn 都跑过（第 2 轮的产出是「还想读」），但第 3 轮没有起来
    expect(harness.ops.prompts).toHaveLength(2);
    expect(harness.ops.order.filter((item) => item.startsWith('turn/start'))).toHaveLength(2);
    const budget = payloadsOf(harness.store, 'tool.budget-exhausted');
    expect(budget).toHaveLength(1);
    expect(budget[0]).toMatchObject({ round: 2 });
    // 只跑过一轮工具（第 2 轮的调用被挡下，所以没有第二条 tool.round）
    expect(payloadsOf(harness.store, 'tool.round')).toHaveLength(1);
    // 挡下之后照样收尾：合法 v2 产出（actions 为空）→ 零写回
    expect(harness.github.calls).toEqual([]);
    expect(harness.store.envelopes[0]?.valid).toBe(true);
    expect(report.outcome).toBe('succeeded');
  });
});
