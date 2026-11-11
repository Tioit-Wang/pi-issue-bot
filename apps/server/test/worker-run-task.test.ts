/**
 * worker 闭环（B13）的单测：tech-plan §4.3 的九步 + §7.3 的失败优先级 + plan §9.3 的熔断处置。
 *
 * 全部外部件都是注入的假实现（本机没有 `vendor/pi-host` bundle、不能真连 GitHub）：
 *   - 调用序列靠**每个假实现自己往 `order` 里记一笔**，所以「谁真的被调用了」不是靠日志猜；
 *   - 落库内容靠内存 `RunStore` 断言（PG 实现另有 `worker-run-store.test.ts` 走真库）；
 *   - 事件流是普通数组，超时用例用一个「永不结束」的异步迭代器。
 */
import { describe, expect, it } from 'vitest';

import type { EventEnvelope } from '../src/worker/deps.ts';
import type { GithubWriteApi, GithubWriteApi as WriteApi } from '../src/github/index.ts';
import type { TurnDriverOps } from '../src/runtime/turn-driver.ts';
import { retentionForOutcome, toContainerPath } from '../src/sandbox/index.ts';
import type {
  ContainerStateSnapshot,
  SandboxContainerSpec,
  SandboxDocker,
  TaskOutcome,
} from '../src/sandbox/index.ts';
import { TASK_STEPS, createUnavailableWorktreePort, runTask } from '../src/worker/index.ts';
import type {
  ActionRecord,
  EnvelopeRecord,
  ExecProxyPort,
  HostPort,
  LifecycleDisposer,
  RunStore,
  TaskRunInput,
  TaskRunnerDeps,
  WorktreePort,
} from '../src/worker/index.ts';

const REPO = 'octo/demo';
const TARGET = 7;
const JOB_DIR = 'C:/jobs/task-1/work';
const CONTAINER_ID = 'container-1';
const SESSION_ID = 'session-1';
const TURN_ID = 'turn-1';

/** 一条事件（`EventEnvelope` 的必需字段够用即可，`as unknown as` 是因为 schema 未 vendored）。 */
function env(kind: string, payload: unknown, index = 0): EventEnvelope {
  return {
    eventId: `${kind}-${String(index)}`,
    scope: 'session',
    epoch: 'epoch-1',
    revision: 1,
    kind,
    occurredAt: '2026-06-01T00:00:00.000Z',
    payload,
  } as unknown as EventEnvelope;
}

/** 合法信封的 JSON 文本（`verdict` / `actions` / `usage` 三件套）。 */
function envelopeJson(actions: unknown[]): string {
  return JSON.stringify({
    verdict: {
      kind: 'issue',
      labels: ['bug'],
      evidence: [{ rule: 'has-repro-steps', quote: '复现步骤：…', passed: true }],
    },
    actions,
    usage: { inputTokens: 1_200, outputTokens: 300, costUsd: 0.02 },
  });
}

/** 一次成功 turn 的事件流：增量 → 带信封的 completed → 终态。 */
function successEvents(actions: unknown[]): readonly EventEnvelope[] {
  return [
    env('item.delta', { text: '正在阅读仓库…' }, 0),
    env('item.completed', { text: `产出如下：\n\`\`\`json\n${envelopeJson(actions)}\n\`\`\`` }, 1),
    env('turn.completed', { status: 'completed' }, 2),
  ];
}

interface HarnessOptions {
  readonly events?: (context: { sessionId: string; turnId: string }) => AsyncIterable<EventEnvelope>;
  readonly containerState?: ContainerStateSnapshot;
  readonly timeoutForCommand?: (command: string) => number;
  readonly allowPushBranch?: boolean;
  /** 提示词装配钩子（不传 = 不装配，用来钉住「注入前后行为」两种形态）。 */
  readonly promptEnricher?: TaskRunnerDeps['promptEnricher'];
  /** 无感反馈端口（W2-D）；不传 = 不打 reaction。 */
  readonly feedback?: TaskRunnerDeps['feedback'];
}

/** 内存 `RunStore`：断言落库内容用。 */
function createMemoryStore(): RunStore & {
  readonly runs: {
    runId: string;
    outcome?: string;
    failureClass?: string | null;
    failureDetail?: unknown;
    sessionId?: string;
    turnId?: string;
  }[];
  readonly runEvents: { cursor: number; kind: string; payload: unknown }[];
  readonly envelopes: EnvelopeRecord[];
  readonly actions: ActionRecord[];
  readonly degeneracyHits: { criterion: string; detail: unknown }[];
  readonly usageRows: {
    runId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }[];
  readonly tasks: { status: string; containerName?: string }[];
} {
  /**
   * `runs` 的内存替身：字段与 `runs` 表一致（含 `session_id` / `turn_id`），
   * 这样断言「失败路径也把会话 id 写进库」是有类型的、不是靠删断言过编译。
   */
  const runs: {
    runId: string;
    outcome?: string;
    failureClass?: string | null;
    failureDetail?: unknown;
    sessionId?: string;
    turnId?: string;
  }[] = [];
  const runEvents: { cursor: number; kind: string; payload: unknown }[] = [];
  const envelopes: EnvelopeRecord[] = [];
  const actions: ActionRecord[] = [];
  const degeneracyHits: { criterion: string; detail: unknown }[] = [];
  /** 记账行（`usage_costs`）：金额已按 DeepSeek 价目算好，测试只断言「写了什么」 */
  const usageRows: {
    runId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }[] = [];
  const tasks: { status: string; containerName?: string }[] = [];

  return {
    runs,
    runEvents,
    envelopes,
    actions,
    usageRows,
    degeneracyHits,
    tasks,
    async beginRun(input) {
      runs.push({ runId: input.runId });
    },
    async appendEvent(input) {
      runEvents.push({ cursor: input.cursor, kind: input.kind, payload: input.payload });
    },
    async recordEnvelope(record) {
      envelopes.push(record);
    },
    async recordAction(record) {
      actions.push(record);
    },
    async recordUsage(input) {
      usageRows.push({ ...input });
    },
    async recordDegeneracyHit(input) {
      degeneracyHits.push({ criterion: input.hit.criterion, detail: input.hit.detail });
    },
    async finishRun(input) {
      const run = runs.find((item) => item.runId === input.runId);
      if (run !== undefined) {
        run.outcome = input.outcome;
        run.failureClass = input.failureClass;
        run.failureDetail = input.failureDetail;
        run.sessionId = input.sessionId;
        run.turnId = input.turnId;
      }
    },
    async markTask(input) {
      tasks.push({
        status: input.status,
        ...(input.containerName === undefined ? {} : { containerName: input.containerName }),
      });
    },
  };
}

/** 假 ops：只记录调用，不建任何连接。 */
function createFakeOps(order: string[]): TurnDriverOps & { readonly calls: string[]; readonly prompts: string[] } {
  const calls: string[] = [];
  /** 交给宿主的提示词正文（`turn/start` 的 `input.text`）：装配层改没改 prompt 只能在这里看。 */
  const prompts: string[] = [];
  const record = (name: string): void => {
    calls.push(name);
  };
  return {
    calls,
    prompts,
    async projectRegister() {
      record('project/register');
      return { projectId: 'project-1' };
    },
    async sessionCreate() {
      record('session/create');
      return { id: SESSION_ID };
    },
    async eventsSubscribe() {
      record('events/subscribe');
      return {};
    },
    async turnStart(params) {
      record('turn/start');
      order.push('turn');
      // 提示词是交给宿主的**实际**内容：装配层改没改它，只能在这里看（tech-plan §4.3 第 4 步）
      prompts.push(params.input.text);
      return { id: TURN_ID };
    },
    async turnInterrupt() {
      record('turn/interrupt');
      return {};
    },
    async approvalRespond() {
      record('approval/respond');
      return {};
    },
    async inputRespond() {
      record('input/respond');
      return {};
    },
    async workspaceDiff() {
      record('workspace/diff');
      order.push('diff');
      return { diff: 'diff --git a/a.ts b/a.ts' };
    },
    async sessionArchive() {
      record('session/archive');
      return {};
    },
  };
}

/**
 * 假 GitHub 写入面：记调用（含评论正文），评论幂等点（无既有评论 → 发）。
 *
 * `comments` 记**发出去的正文**：兜底回复的断言要看到标记与去掉信封后的文本，
 * 只记方法名做不到这件事（`calls` 保留给「发了哪些动作」这类断言）。
 */
function createFakeGithub(): GithubWriteApi & {
  readonly calls: string[];
  readonly comments: string[];
} {
  const calls: string[] = [];
  const comments: string[] = [];
  return {
    calls,
    comments,
    async listIssueComments() {
      calls.push('listIssueComments');
      return [];
    },
    async createIssueComment(input) {
      calls.push(`createIssueComment:${String(input.issueNumber)}`);
      comments.push(input.body);
      return { id: 4242, htmlUrl: null };
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
  };
}

function createHarness(options: HarnessOptions = {}): {
  readonly deps: TaskRunnerDeps;
  readonly order: string[];
  readonly store: ReturnType<typeof createMemoryStore>;
  readonly github: ReturnType<typeof createFakeGithub> & WriteApi;
  readonly ops: ReturnType<typeof createFakeOps>;
  readonly disposeCalls: { outcome: TaskOutcome; containerId: string }[];
  readonly specs: SandboxContainerSpec[];
} {
  const order: string[] = [];
  const store = createMemoryStore();
  const ops = createFakeOps(order);
  const github = createFakeGithub();
  const disposeCalls: { outcome: TaskOutcome; containerId: string }[] = [];
  const specs: SandboxContainerSpec[] = [];

  const containerState: ContainerStateSnapshot = options.containerState ?? {
    containerId: CONTAINER_ID,
    status: 'exited',
    running: false,
    exitCode: 0,
    oomKilled: false,
  };

  const worktree: WorktreePort = {
    async create() {
      order.push('worktree');
      return { taskId: 'task-1', repo: REPO, jobDir: JOB_DIR };
    },
  };

  const docker: SandboxDocker = {
    async ping() {},
    async createContainer(spec) {
      order.push('container');
      specs.push(spec);
      return CONTAINER_ID;
    },
    async inspectState() {
      return containerState;
    },
    async execStream() {
      throw new Error('worker 不应该自己 exec（命令走 exec 代理）');
    },
    async destroyContainer() {},
  };

  const proxy: ExecProxyPort = {
    async listen(input) {
      order.push('proxy');
      return { address: `unix:${input.jobDir}/.pi-bot/exec.sock`, socketPath: `${input.jobDir}/.pi-bot/exec.sock` };
    },
    async destroy() {},
  };

  const host: HostPort = {
    async ready() {
      order.push('host');
      return { hostId: 'host-1', port: 7777, version: '1.2.3' };
    },
    async stop() {},
  };

  const lifecycle: LifecycleDisposer = {
    async dispose(input) {
      order.push('dispose');
      disposeCalls.push({ outcome: input.outcome, containerId: input.containerId });
      return {
        outcome: input.outcome,
        retention: retentionForOutcome(input.outcome),
        state: containerState,
      };
    },
  };

  const deps: TaskRunnerDeps = {
    worktree,
    docker,
    proxy,
    host,
    lifecycle,
    store,
    ops,
    events:
      options.events ??
      (() => {
        // 默认：没有事件（用不到 events 的用例不会走到这里）
        return {
          [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true as const, value: undefined }) }),
        } as AsyncIterable<EventEnvelope>;
      }),
    github,
    image: 'pi-worker:node22',
    ...(options.timeoutForCommand === undefined
      ? {}
      : { timeoutForCommand: options.timeoutForCommand }),
    ...(options.allowPushBranch === undefined ? {} : { allowPushBranch: options.allowPushBranch }),
    ...(options.promptEnricher === undefined ? {} : { promptEnricher: options.promptEnricher }),
    ...(options.feedback === undefined ? {} : { feedback: options.feedback }),
    clock: () => 1_700_000_000_000,
    onStep: (step) => {
      if (step === 'validate' || step === 'execute') {
        order.push(step);
      }
    },
  };

  return { deps, order, store, github, ops, disposeCalls, specs };
}

function makeInput(overrides: Partial<TaskRunInput> = {}): TaskRunInput {
  return {
    taskId: 'task-1',
    runId: 'run-1',
    command: '/issue-triage',
    repo: REPO,
    targetKind: 'issue',
    targetNumber: TARGET,
    prompt: '请判定这个 issue 是否符合报告标准',
    ...overrides,
  };
}

/** 一个永不结束的事件流（测任务级超时）。 */
function hangingEvents(): AsyncIterable<EventEnvelope> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<EventEnvelope>>(() => {}),
    }),
  };
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

describe('worker 全链（tech-plan §4.3）', () => {
  it('一次成功：九步顺序 + 落库 + 写执行 + 处置（成功即时销毁）', async () => {
    const harness = createHarness({ events: () => asyncFrom(successEvents([{ intent: 'comment', body: '收到，信息齐全。' }])) });

    const report = await runTask(makeInput(), harness.deps);

    // 1) 九步顺序（两份证据：worker 自己记的 steps + 假实现真实被调用的顺序）
    expect(report.steps).toEqual([...TASK_STEPS]);
    expect(harness.order).toEqual([
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

    // 2) 结局
    expect(report.outcome).toBe('succeeded');
    expect(report.failureClass).toBeNull();
    expect(report.terminal).toBe('turn.completed');

    // 3) 落库：runs / envelopes / actions / run_events
    expect(harness.store.runs[0]?.outcome).toBe('succeeded');
    expect(harness.store.runs[0]?.sessionId).toBe(SESSION_ID);
    expect(harness.store.envelopes).toHaveLength(1);
    expect(harness.store.envelopes[0]?.valid).toBe(true);
    expect(harness.store.envelopes[0]?.errors).toEqual([]);
    expect(harness.store.actions).toHaveLength(1);
    expect(harness.store.actions[0]?.intent).toBe('comment');
    expect(harness.store.actions[0]?.externalRef).toBe('4242');
    expect(harness.store.actions[0]?.appliedAt).not.toBeNull();
    // run_events 的游标从 1 开始且单调
    const cursors = harness.store.runEvents.map((item) => item.cursor);
    expect(cursors).toEqual(cursors.slice().sort((left, right) => left - right));
    expect(cursors[0]).toBe(1);

    // 4) 容器规格与处置
    expect(harness.specs[0]?.name).toBe('pi-job-task-1');
    // 身份挂载：源是宿主 job 目录，目标是**容器内**路径（Windows 开发机上 `toContainerPath` 会映射成 `/c/...`）
    expect(harness.specs[0]?.HostConfig.Binds?.[0]).toBe(`${JOB_DIR}:${toContainerPath(JOB_DIR)}:rw`);
    expect(harness.specs[0]?.WorkingDir).toBe(toContainerPath(JOB_DIR));
    expect(harness.disposeCalls).toEqual([{ outcome: 'success', containerId: CONTAINER_ID }]);
    expect(report.disposed).toBe(true);
    expect(report.containerState?.exitCode).toBe(0);
  });

  it('dry_run=1：不写 actions 行、不打 GitHub，计划落 run_events', async () => {
    const harness = createHarness({ events: () => asyncFrom(successEvents([{ intent: 'comment', body: '收到。' }])) });

    const report = await runTask(makeInput({ dryRun: true }), harness.deps);

    expect(report.outcome).toBe('succeeded');
    expect(report.dryRun).toBe(true);
    // 关键断言：actions 行数 = 0
    expect(harness.store.actions).toHaveLength(0);
    expect(harness.github.calls).toEqual([]);
    expect(report.actions.map((item) => item.status)).toEqual(['dry-run']);
    // 计划仍然可审计
    const dryRunEvent = harness.store.runEvents.find((item) => item.kind === 'writeback.dry-run');
    expect(dryRunEvent).toBeDefined();
    expect(harness.store.envelopes[0]?.valid).toBe(true);
  });
});

describe('信封与动作过滤（plan §5 / tech-plan §5.6）', () => {
  it('push_branch 缺 paths：整封信封判不合规（Ajv oneOf），失败分类 parse 且不重试', async () => {
    const harness = createHarness({
      events: () => asyncFrom(successEvents([{ intent: 'push_branch', branch: 'bot/fix-7' }])),
    });

    const report = await runTask(makeInput(), harness.deps);

    expect(report.envelope?.valid).toBe(false);
    // Ajv 的 oneOf 失败会同时给父路径与各分支的子错误；只断言「错误落在 actions 上」，
    // 不去猜 Ajv 具体给哪一条（猜错了就是把实现细节当契约）。
    expect(report.envelope?.errors.some((issue) => issue.path.includes('/actions'))).toBe(true);
    expect(report.outcome).toBe('failed');
    expect(report.failureClass).toBe('parse');
    expect(report.retry.retry).toBe(false);
    expect(harness.store.envelopes[0]?.valid).toBe(false);
    // 不合规信封的动作一条都不执行（`report.actions` 是「信封里被接受的动作」清单）。
    expect(report.actions).toHaveLength(0);
    // `actions` 表里只允许出现**兜底评论**那一行（信封动作仍然 0 行）：
    // 这一段文本是「产出如下：」+ 信封，摘掉信封后还剩人话，于是兜底路径会发一条评论。
    expect(harness.store.actions.map((item) => item.intent)).toEqual(['fallback']);
    // 安全边界：不合规信封**不许打标**（标签只能来自合规信封）。
    expect(harness.github.calls).not.toContain('addLabels');
  });

  it('allowPushBranch=false：信封仍然合规，只有该动作被丢弃（valid 语义不受影响）', async () => {
    const harness = createHarness({
      allowPushBranch: false,
      events: () =>
        asyncFrom(
          successEvents([
            { intent: 'push_branch', branch: 'bot/fix-7', paths: ['src/a.ts'] },
            { intent: 'comment', body: '已修复。' },
          ]),
        ),
    });

    const report = await runTask(makeInput(), harness.deps);

    expect(report.envelope?.valid).toBe(true);
    expect(report.envelope?.accepted.map((item) => item.intent)).toEqual(['comment']);
    expect(report.envelope?.dropped.map((item) => item.reason)).toEqual(['push-branch-disabled']);
    const dropped = harness.store.runEvents.find((item) => item.kind === 'writeback.dropped');
    expect(dropped).toBeDefined();
    // 好动作不受坏动作连累
    expect(harness.store.actions.map((item) => item.intent)).toEqual(['comment']);
  });
});

describe('兜底回复（信封不可信 → 只发评论；worker/fallback.ts）', () => {
  /** 不合规信封：`push_branch` 缺 `paths`（契约要求非空数组）。 */
  const invalidEnvelope = (): string =>
    JSON.stringify({
      verdict: {
        kind: 'issue',
        labels: ['bug'],
        evidence: [{ rule: 'has-repro-steps', quote: '复现步骤：…', passed: true }],
      },
      actions: [{ intent: 'push_branch', branch: 'bot/fix-7' }],
      usage: { inputTokens: 900, outputTokens: 200, costUsd: 0.01 },
    });

  it('信封不合规 + 有人话 → 发兜底评论（带隐藏标记），run 仍是 parse、不打标', async () => {
    const harness = createHarness({
      events: () =>
        asyncFrom([
          env('item.completed', { text: `结论：这是权限问题。\n\`\`\`json\n${invalidEnvelope()}\n\`\`\`` }, 0),
          env('turn.completed', { status: 'completed' }, 1),
        ]),
    });

    const report = await runTask(makeInput(), harness.deps);

    // 质量统计不能失真：信封不可信就是 parse，且不重试
    expect(report.outcome).toBe('failed');
    expect(report.failureClass).toBe('parse');
    expect(report.retry.retry).toBe(false);
    // 信封里的动作 0 条；兜底单独一栏
    expect(report.actions).toHaveLength(0);
    expect(report.fallback?.intent).toBe('fallback');
    expect(report.fallback?.status).toBe('applied');

    // 评论正文 = 人话 + 兜底标记 + pi-bot 去重标记；机器段（信封）不许出现在评论里
    expect(harness.github.comments).toHaveLength(1);
    const body = harness.github.comments[0] ?? '';
    expect(body).toContain('结论：这是权限问题。');
    expect(body).toContain('<!-- pi-issue-bot:fallback -->');
    expect(body).toContain('<!-- pi-bot:octo/demo#7:fallback:');
    expect(body).not.toContain('verdict');

    // 安全边界：不打标；`actions` 表只有兜底那一行；`run_events` 留痕
    expect(harness.github.calls).not.toContain('addLabels');
    expect(harness.store.actions.map((item) => item.intent)).toEqual(['fallback']);
    expect(harness.store.runEvents.some((item) => item.kind === 'writeback.fallback')).toBe(true);
  });

  it('完全没有信封（missing-envelope）也兜底 —— 这条正是「@ 了没反应」的真实故障', async () => {
    const harness = createHarness({
      events: () =>
        asyncFrom([
          env('item.completed', { text: '结论：EACCES 不是只读挂载造成的。\n\n依据：只读挂载返回 EROFS。' }, 0),
          env('turn.completed', { status: 'completed' }, 1),
        ]),
    });

    const report = await runTask(makeInput({ command: '@answer' }), harness.deps);

    expect(report.envelope?.errors[0]?.keyword).toBe('missing-envelope');
    expect(report.failureClass).toBe('parse');
    expect(report.fallback?.status).toBe('applied');
    expect(harness.github.comments[0]).toContain('EACCES 不是只读挂载造成的');
  });

  it('真 pi-host 形状（payload.event.message.content）也能取出人话，且跳过 tool 消息', async () => {
    const content = `结论：这是 uid 不匹配。\n\`\`\`json\n${invalidEnvelope()}\n\`\`\``;
    const harness = createHarness({
      events: () =>
        asyncFrom([
          env(
            'item.completed',
            {
              event: { type: 'message_end', message: { role: 'tool', content: '{"content":[],"isError":false}' } },
              itemId: 'tool-1',
              itemType: 'message',
            },
            0,
          ),
          env(
            'item.completed',
            { event: { type: 'message_end', message: { role: 'assistant', content } }, itemId: 'msg-1', itemType: 'message' },
            1,
          ),
          env('turn.completed', { event: { type: 'agent_end', messageIds: [] } }, 2),
        ]),
    });

    const report = await runTask(makeInput({ command: '@answer' }), harness.deps);

    // 信封现在能找到（不再退化成 missing-envelope），只是不合规 → 仍然是 parse
    expect(report.envelope?.errors[0]?.keyword).not.toBe('missing-envelope');
    expect(report.failureClass).toBe('parse');
    const body = harness.github.comments[0] ?? '';
    expect(body).toContain('结论：这是 uid 不匹配。');
    expect(body).not.toContain('verdict');
    expect(body).not.toContain('isError');
  });

  it('/review-pr 不兜底（不可信的审查结论不该发出去）', async () => {
    const harness = createHarness({
      events: () => asyncFrom([env('item.completed', { text: '看起来没问题。' }, 0), env('turn.completed', {}, 1)]),
    });

    const report = await runTask(makeInput({ command: '/review-pr' }), harness.deps);

    expect(report.fallback).toBeNull();
    expect(harness.github.comments).toEqual([]);
    expect(harness.store.actions).toHaveLength(0);
    expect(harness.store.runEvents.some((item) => item.kind === 'writeback.fallback-skipped')).toBe(true);
  });

  it('dry-run 不兜底（零副作用 + actions 0 行）', async () => {
    const harness = createHarness({
      events: () => asyncFrom([env('item.completed', { text: '结论：……' }, 0), env('turn.completed', {}, 1)]),
    });

    const report = await runTask(makeInput({ dryRun: true }), harness.deps);

    expect(report.dryRun).toBe(true);
    expect(report.fallback).toBeNull();
    expect(harness.github.calls).toEqual([]);
    expect(harness.store.actions).toHaveLength(0);
  });

  it('只能看到信封、没有人话 → 兜不了（不凭空发明内容）', async () => {
    const harness = createHarness({
      events: () =>
        asyncFrom([
          env('item.completed', { text: `\`\`\`json\n${invalidEnvelope()}\n\`\`\`` }, 0),
          env('turn.completed', {}, 1),
        ]),
    });

    const report = await runTask(makeInput(), harness.deps);

    expect(report.failureClass).toBe('parse');
    expect(report.fallback).toBeNull();
    expect(harness.github.comments).toEqual([]);
    expect(harness.store.actions).toHaveLength(0);
  });

  it('信封合规 → 不兜底（正式动作照旧执行，只发那一条评论）', async () => {
    const harness = createHarness({
      events: () => asyncFrom(successEvents([{ intent: 'comment', body: '正式回复：缺复现步骤。' }])),
    });

    const report = await runTask(makeInput(), harness.deps);

    expect(report.envelope?.valid).toBe(true);
    expect(report.fallback).toBeNull();
    expect(harness.github.comments).toHaveLength(1);
    expect(harness.github.comments[0]).toContain('正式回复：缺复现步骤。');
    expect(harness.github.comments[0]).not.toContain('pi-issue-bot:fallback');
  });
});

describe('失败分类优先级（tech-plan §7.3 第一张表）', () => {
  it('同时「任务级超时 + 容器非零退出」→ timeout（不落到 sandbox-crash）', async () => {
    const harness = createHarness({
      events: () => hangingEvents(),
      timeoutForCommand: () => 20,
      containerState: {
        containerId: CONTAINER_ID,
        status: 'exited',
        running: false,
        exitCode: 137,
        oomKilled: false,
      },
    });

    const report = await runTask(makeInput({ command: '/review-pr' }), harness.deps);

    expect(report.outcome).toBe('timed-out');
    expect(report.failureClass).toBe('timeout');
    expect(report.signals.map((item) => item.failureClass)).toContain('sandbox-crash');
    expect(report.retry.retry).toBe(false);
    // 超时也照样处置容器（§6.3：立即销毁）
    expect(harness.disposeCalls).toEqual([{ outcome: 'timeout', containerId: CONTAINER_ID }]);
    // 失败路径同样要把会话 id 写进 runs（面板详情页靠它回查 Host，见 recordingOps()）
    expect(harness.store.runs[0]?.sessionId).toBe(SESSION_ID);
    expect(harness.store.runs[0]?.turnId).toBe(TURN_ID);
  });

  it('OOM 且非零退出 → sandbox-oom（先看 OOM 再看退出码）', async () => {
    const harness = createHarness({
      events: () => asyncFrom([env('turn.failed', { reason: 'oom' })]),
      containerState: {
        containerId: CONTAINER_ID,
        status: 'exited',
        running: false,
        exitCode: 137,
        oomKilled: true,
      },
    });

    const report = await runTask(makeInput(), harness.deps);

    expect(report.failureClass).toBe('sandbox-oom');
    expect(report.outcome).toBe('failed');
    expect(report.retry.retry).toBe(false);
  });

  it('只有非零退出 → sandbox-crash（可自动重试 1 次）', async () => {
    const harness = createHarness({
      events: () => asyncFrom([env('turn.failed', { reason: 'boom' })]),
      containerState: {
        containerId: CONTAINER_ID,
        status: 'exited',
        running: false,
        exitCode: 1,
        oomKilled: false,
      },
    });

    const report = await runTask(makeInput(), harness.deps);

    expect(report.failureClass).toBe('sandbox-crash');
    expect(report.retry.retry).toBe(true);
    expect(report.retry.failureClass).toBe('sandbox-crash');
  });

  it('解析失败 → parse 且 decideRetry 返回不重试', async () => {
    const harness = createHarness({
      events: () => asyncFrom([env('turn.completed', { text: '这就是我的结论：看起来不错，没有 JSON。' })]),
    });

    const report = await runTask(makeInput(), harness.deps);

    expect(report.outcome).toBe('failed');
    expect(report.failureClass).toBe('parse');
    expect(report.retry.retry).toBe(false);
    expect(harness.store.envelopes[0]?.valid).toBe(false);
    expect(harness.store.envelopes[0]?.errors).toBeTruthy();
  });

  it('setup 阶段失败（worktree 未装配）→ 不起容器，failure_class 归 sandbox-crash', async () => {
    const harness = createHarness({ events: () => asyncFrom([]) });
    // 用**真正的默认实现**：它抛 AppError{failureClass:'sandbox', code:'WORKTREE_UNAVAILABLE'}，
    // 归一后落 sandbox-crash（优先级 3）。这里不伪造错误，免得把「默认端口是失败实现」这件事测丢。
    const deps: TaskRunnerDeps = { ...harness.deps, worktree: createUnavailableWorktreePort() };

    const report = await runTask(makeInput(), deps);

    expect(report.outcome).toBe('failed');
    expect(report.failureClass).toBe('sandbox-crash');
    expect(report.steps).toEqual(['worktree', 'diff', 'validate', 'execute', 'dispose']);
    expect(harness.specs).toHaveLength(0);
  });
});

describe('重复输出熔断（plan §9.3）', () => {
  it('段落重复命中 → turn/interrupt + degeneracy_hits + degenerate-output + 不重试', async () => {
    // 200 字符单元重复 3 次 + 同一事件里带一封信封（验证「已产出结果照样校验入库」）
    const unit = 'ab'.repeat(100);
    const text = `${unit}${unit}${unit}\n\`\`\`json\n${envelopeJson([{ intent: 'comment', body: '（退化状态下产出的评论）' }])}\n\`\`\``;

    const harness = createHarness({
      events: () => asyncFrom([env('item.completed', { text }, 0), env('turn.completed', {}, 1)]),
    });

    const report = await runTask(makeInput(), harness.deps);

    expect(report.outcome).toBe('degenerate-output');
    expect(report.failureClass).toBe('degenerate-output');
    expect(report.retry.retry).toBe(false);
    expect(harness.ops.calls).toContain('turn/interrupt');
    expect(harness.store.degeneracyHits).toHaveLength(1);
    expect(harness.store.degeneracyHits[0]?.criterion).toBe('paragraph-repeat');
    // 信封照样入库，但退化状态下的动作不发布
    expect(harness.store.envelopes[0]?.valid).toBe(true);
    expect(harness.store.actions).toHaveLength(0);
    expect(harness.github.calls).toEqual([]);
    // 熔断与超时同档：立即销毁
    expect(harness.disposeCalls[0]?.outcome).toBe('circuit-open');
  });

  it('正常的多段输出不会误触发熔断', async () => {
    const harness = createHarness({
      events: () =>
        asyncFrom([
          env('item.delta', { text: '第一步：读 issue 模板，确认复现步骤是否齐全。'.repeat(3) }, 0),
          env('item.completed', { text: envelopeJson([{ intent: 'comment', body: '信息齐全。' }]) }, 1),
          env('turn.completed', {}, 2),
        ]),
    });

    const report = await runTask(makeInput(), harness.deps);

    expect(report.outcome).toBe('succeeded');
    expect(harness.store.degeneracyHits).toHaveLength(0);
    expect(report.degeneracy?.textChars).toBeGreaterThan(0);
  });
});

/**
 * M1：提示词装配钩子（`TaskRunnerDeps.promptEnricher`）。
 *
 * 背景（真 bug）：上游的 `prompt` 在 worktree 创建**之前**就拼好了，而 AGENTS.md 与仓库技能
 * 文件都在 worktree 里 —— 所以 `renderSkillPrompt()` 从来没被调用过，技能正文没进提示词。
 * 这里钉住三件事：不注入时行为完全不变；注入后被替换；装配失败不影响任务结局。
 */
describe('提示词装配钩子（M1）', () => {
  it('没有注入 promptEnricher：交给宿主的 prompt 就是 input.prompt（行为不变）', async () => {
    const harness = createHarness({
      events: () => asyncFrom(successEvents([{ intent: 'comment', body: '收到，信息齐全。' }])),
    });
    const input = makeInput();

    const report = await runTask(input, harness.deps);

    expect(report.outcome).toBe('succeeded');
    expect(harness.ops.prompts).toEqual([input.prompt]);
  });

  it('注入了 promptEnricher：拿到 worktree/basePrompt/command，返回值替换 prompt', async () => {
    const seen: { worktreeDir?: string; basePrompt?: string; command?: string | null }[] = [];
    const harness = createHarness({
      events: () => asyncFrom(successEvents([])),
      promptEnricher: async (input) => {
        seen.push({ ...input });
        return `${input.basePrompt}\n\n## 仓库约定（AGENTS.md）\n构建用 pnpm。`;
      },
    });
    const input = makeInput();

    const report = await runTask(input, harness.deps);

    expect(report.outcome).toBe('succeeded');
    // 时序：worktree 建好之后才装配（否则 worktreeDir 是空的）
    expect(seen).toHaveLength(1);
    expect(seen[0]?.worktreeDir).toBe(JOB_DIR);
    expect(seen[0]?.basePrompt).toBe(input.prompt);
    expect(seen[0]?.command).toBe('/issue-triage');
    // 宿主收到的是装配后的提示词
    expect(harness.ops.prompts).toHaveLength(1);
    expect(harness.ops.prompts[0]).toContain('构建用 pnpm。');
    expect(harness.ops.prompts[0]).toContain(input.prompt);
  });

  it('enricher 抛错：回退到 basePrompt，任务照常成功（九步不变）', async () => {
    const harness = createHarness({
      events: () => asyncFrom(successEvents([{ intent: 'comment', body: '收到。' }])),
      promptEnricher: async () => {
        throw new Error('装配炸了');
      },
    });
    const input = makeInput();

    const report = await runTask(input, harness.deps);

    expect(report.outcome).toBe('succeeded');
    expect(report.failureClass).toBeNull();
    expect(report.steps).toEqual([...TASK_STEPS]);
    expect(harness.ops.prompts).toEqual([input.prompt]);
  });

  it('enricher 返回空串：回退到 basePrompt（不把空提示词发给宿主）', async () => {
    const harness = createHarness({
      events: () => asyncFrom(successEvents([])),
      promptEnricher: async () => '',
    });
    const input = makeInput();

    const report = await runTask(input, harness.deps);

    expect(report.outcome).toBe('succeeded');
    expect(harness.ops.prompts).toEqual([input.prompt]);
  });

  it('setup 阶段失败（没建出 worktree）：不调用 enricher', async () => {
    const harness = createHarness({ events: () => asyncFrom([]) });
    let called = false;
    const deps: TaskRunnerDeps = {
      ...harness.deps,
      worktree: createUnavailableWorktreePort(),
      promptEnricher: async () => {
        called = true;
        return '不该被用到这里';
      },
    };

    const report = await runTask(makeInput(), deps);

    expect(called).toBe(false);
    expect(report.steps).toEqual(['worktree', 'diff', 'validate', 'execute', 'dispose']);
  });
});

describe('无感反馈：终态 reaction（W2-D）', () => {
  /** 内存台账：唯一键 = (stage, anchor)，与 PG 唯一索引同构。 */
  function createFakeFeedback(): {
    readonly deps: NonNullable<TaskRunnerDeps['feedback']>;
    readonly claims: { stage: string; anchor: string }[];
    readonly applied: { reactionId: number | null; appliedAt: Date }[];
    readonly calls: string[];
    readonly added: string[];
    readonly removed: number[];
  } {
    const claims: { stage: string; anchor: string }[] = [];
    const applied: { reactionId: number | null; appliedAt: Date }[] = [];
    const calls: string[] = [];
    const added: string[] = [];
    const removed: number[] = [];
    const rows = new Map<string, { id: number; appliedAt: Date | null; reactionId: number | null }>();
    let nextId = 500;

    return {
      claims,
      applied,
      calls,
      added,
      removed,
      deps: {
        ledger: {
          async claim(input) {
            claims.push({ stage: input.stage, anchor: input.anchor });
            const key = `${input.stage}/${input.anchor}`;
            const existing = rows.get(key);
            if (existing !== undefined) {
              return { inserted: false, row: { id: existing.id, content: input.content, reactionId: existing.reactionId, appliedAt: existing.appliedAt } };
            }
            nextId += 1;
            const row = { id: nextId, appliedAt: null, reactionId: null };
            rows.set(key, row);
            return { inserted: true, row: { id: row.id, content: input.content, reactionId: null, appliedAt: null } };
          },
          async markApplied(input) {
            applied.push({ reactionId: input.reactionId, appliedAt: input.appliedAt });
            for (const row of rows.values()) {
              if (row.id === input.id) {
                row.appliedAt = input.appliedAt;
                row.reactionId = input.reactionId;
              }
            }
          },
          async markFailed() {},
        },
        reactions: {
          async addReaction(input) {
            calls.push(`add:${input.content}`);
            added.push(input.content);
            nextId += 1;
            return { id: nextId };
          },
          async listReactions(input) {
            calls.push(`list:${input.content}`);
            // 入队阶段打过 eyes（本 App），终态就该删掉它
            return input.content === 'eyes'
              ? [{ id: 77, content: 'eyes', userLogin: 'pi-issue-bot[bot]' }]
              : [];
          },
          async removeReaction(input) {
            calls.push(`remove:${String(input.reactionId)}`);
            removed.push(input.reactionId);
          },
        },
      },
    };
  }

  it('成功 → 先删 eyes 再加 rocket，台账回填 reaction_id（锚点取 idempotencyKey）', async () => {
    const feedback = createFakeFeedback();
    const harness = createHarness({
      events: () => asyncFrom(successEvents([{ intent: 'comment', body: '收到，信息齐全。' }])),
      feedback: feedback.deps,
    });

    const report = await runTask(makeInput({ idempotencyKey: 'idem-abc' }), harness.deps);

    expect(report.outcome).toBe('succeeded');
    expect(report.feedback?.status).toBe('applied');
    expect(report.feedback?.stage).toBe('succeeded');
    expect(feedback.calls).toEqual(['list:eyes', 'remove:77', 'add:rocket']);
    expect(feedback.claims).toEqual([{ stage: 'succeeded', anchor: 'idem-abc' }]);
    expect(feedback.applied).toHaveLength(1);
    expect(feedback.applied[0]?.reactionId).toBe(report.feedback?.reactionId);
    // run_events 里留下「打了什么」
    expect(harness.store.runEvents.some((item) => item.kind === 'feedback.result')).toBe(true);
  });

  it('超时 → confused（失败路径同样有收尾）', async () => {
    const feedback = createFakeFeedback();
    const harness = createHarness({
      events: () => hangingEvents(),
      timeoutForCommand: () => 20,
      feedback: feedback.deps,
    });

    const report = await runTask(makeInput({ command: '/review-pr', idempotencyKey: 'idem-timeout' }), harness.deps);

    expect(report.outcome).toBe('timed-out');
    expect(report.feedback?.stage).toBe('timed-out');
    expect(report.feedback?.content).toBe('confused');
    expect(feedback.calls).toEqual(['list:eyes', 'remove:77', 'add:confused']);
    expect(feedback.claims).toEqual([{ stage: 'timed-out', anchor: 'idem-timeout' }]);
  });

  it('dry-run：一个 reaction 都不打、不写台账，只落 feedback.planned', async () => {
    const feedback = createFakeFeedback();
    const harness = createHarness({
      events: () => asyncFrom(successEvents([{ intent: 'comment', body: '收到。' }])),
      feedback: feedback.deps,
    });

    const report = await runTask(makeInput({ dryRun: true }), harness.deps);

    expect(report.feedback?.status).toBe('planned');
    expect(feedback.calls).toEqual([]);
    expect(feedback.claims).toEqual([]);
    const planned = harness.store.runEvents.find((item) => item.kind === 'feedback.planned');
    expect(planned).toBeDefined();
    // 零副作用口径不变：actions 一行都没有
    expect(harness.store.actions).toHaveLength(0);
  });
});

describe('兜底回复（信封合规但没给 comment 动作：v0.3「默认一条评论」）', () => {
  /** 合规信封，但 `actions` 是空数组 —— 实机上模型把结论写在第一段里就是这样。 */
  const verdictOnlyEnvelope = (): string =>
    JSON.stringify({
      verdict: {
        kind: 'issue',
        labels: [],
        evidence: [{ rule: 'repro-steps', quote: '复现步骤：…', passed: true }],
      },
      actions: [],
      usage: { inputTokens: 900, outputTokens: 200, costUsd: 0.01 },
    });

  it('agent:mention 只给 verdict → 补发第一段评论，run 仍然 succeeded', async () => {
    const harness = createHarness({
      events: () =>
        asyncFrom([
          env('item.completed', { text: `结论：还缺复现步骤与版本号。\n\`\`\`json\n${verdictOnlyEnvelope()}\n\`\`\`` }, 0),
          env('turn.completed', { status: 'completed' }, 1),
        ]),
    });

    const report = await runTask(makeInput({ command: 'agent:mention' }), harness.deps);

    // 信封是合规的：run 不该被记成 parse 失败
    expect(report.outcome).toBe('succeeded');
    expect(report.failureClass).toBeNull();
    expect(report.actions).toHaveLength(0);
    expect(report.fallback?.intent).toBe('fallback');
    expect(report.fallback?.status).toBe('applied');

    // 第一段原样补发，机器段（信封）不许出现在评论里
    expect(harness.github.comments).toHaveLength(1);
    const body = harness.github.comments[0] ?? '';
    expect(body).toContain('结论：还缺复现步骤与版本号。');
    expect(body).not.toContain('verdict');
    const event = harness.store.runEvents.find((item) => item.kind === 'writeback.fallback');
    expect(event?.payload).toMatchObject({ cause: 'no-comment-action' });
  });

  it('已经给了 comment 动作 → 不重复兜底（只发信封里那一条）', async () => {
    const harness = createHarness({
      events: () =>
        asyncFrom([
          env(
            'item.completed',
            {
              text:
                '结论：信息齐全。\n```json\n' +
                JSON.stringify({
                  verdict: { kind: 'issue', labels: [], evidence: [] },
                  actions: [{ intent: 'comment', body: '信封里的正式回复' }],
                  usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
                }) +
                '\n```',
            },
            0,
          ),
          env('turn.completed', { status: 'completed' }, 1),
        ]),
    });

    const report = await runTask(makeInput({ command: 'agent:mention' }), harness.deps);

    expect(report.fallback).toBeNull();
    expect(harness.github.comments).toHaveLength(1);
    expect(harness.github.comments[0]).toContain('信封里的正式回复');
    expect(harness.store.runEvents.some((item) => item.kind === 'writeback.fallback')).toBe(false);
  });
});
