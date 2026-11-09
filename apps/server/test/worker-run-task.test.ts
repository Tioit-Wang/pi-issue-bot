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
  const tasks: { status: string; containerName?: string }[] = [];

  return {
    runs,
    runEvents,
    envelopes,
    actions,
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
function createFakeOps(order: string[]): TurnDriverOps & { readonly calls: string[] } {
  const calls: string[] = [];
  const record = (name: string): void => {
    calls.push(name);
  };
  return {
    calls,
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
    async turnStart() {
      record('turn/start');
      order.push('turn');
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

/** 假 GitHub 写入面：记调用，评论幂等点（无既有评论 → 发）。 */
function createFakeGithub(): GithubWriteApi & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async listIssueComments() {
      calls.push('listIssueComments');
      return [];
    },
    async createIssueComment(input) {
      calls.push(`createIssueComment:${String(input.issueNumber)}`);
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
    expect(harness.store.actions).toHaveLength(0);
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
