/**
 * light 运行时（`worker/run-task.ts` 的 `runtimeMode: 'light'`，§5 / §10.5 / V1）。
 *
 * 断言的是**调用次数**，不是「看起来跑通了」：
 *  - worktree / 容器 / exec 代理 / 生命周期处置 / diff 采集一次都不能发生；
 *  - 保留的只有 `host.ready()` + 一次 turn + 信封校验 + 写执行器 + 落库；
 *  - 步骤序列在 light 下是 `host → turn → validate → execute`（没有 worktree/container/proxy/diff/dispose）；
 *  - 同一份输入换成 sandboxed 时那些调用**各发生一次**（证明是开关在起作用，不是代码被删了）。
 */
import { describe, expect, it } from 'vitest';

import { runTask } from '../src/worker/index.ts';
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
import type { EventEnvelope } from '../src/worker/deps.ts';
import type { ContainerStateSnapshot, SandboxDocker } from '../src/sandbox/index.ts';
import { retentionForOutcome } from '../src/sandbox/lifecycle.ts';
import type { GithubWriteApi } from '../src/github/index.ts';
import type { TurnDriverOps } from '../src/runtime/turn-driver.ts';

const REPO = 'acme/widgets';
const TARGET = 7;
const JOB_DIR = 'C:/jobs/task-1/work';
const CONTAINER_ID = 'container-1';
const SESSION_ID = 'session-1';
const TURN_ID = 'turn-1';

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

/** 阶段 0 的信封（`stage` 是唯一扩展，§4.1）。 */
const FORMAT_ENVELOPE = JSON.stringify({
  stage: { name: 'format', result: 'pass' },
  verdict: { kind: 'issue', labels: [], evidence: [] },
  actions: [],
  usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
});

function successEvents(): readonly EventEnvelope[] {
  return [
    env('item.completed', { text: `结论：\n\`\`\`json\n${FORMAT_ENVELOPE}\n\`\`\`` }, 1),
    env('turn.completed', { status: 'completed' }, 2),
  ];
}

const containerState: ContainerStateSnapshot = {
  containerId: CONTAINER_ID,
  status: 'exited',
  running: false,
  exitCode: 0,
  oomKilled: false,
};

type Harness = {
  readonly deps: TaskRunnerDeps;
  readonly calls: Record<string, number>;
};

/** 记录「每个端口被调用了几次」的最小假实现。 */
function createHarness(): Harness {
  const calls: Record<string, number> = {};
  const bump = (name: string): void => {
    calls[name] = (calls[name] ?? 0) + 1;
  };

  const worktree: WorktreePort = {
    async create() {
      bump('worktree.create');
      return { taskId: 'task-1', repo: REPO, jobDir: JOB_DIR };
    },
    async release() {
      bump('worktree.release');
    },
  };
  const docker: SandboxDocker = {
    async ping() {},
    async createContainer() {
      bump('docker.createContainer');
      return CONTAINER_ID;
    },
    async inspectState() {
      return containerState;
    },
    async execStream() {
      throw new Error('worker 不应该自己 exec');
    },
    async destroyContainer() {},
  };
  const proxy: ExecProxyPort = {
    async listen(input) {
      bump('proxy.listen');
      return { address: `unix:${input.jobDir}/exec.sock`, socketPath: `${input.jobDir}/exec.sock` };
    },
    async destroy() {
      bump('proxy.destroy');
    },
  };
  const host: HostPort = {
    async ready() {
      bump('host.ready');
      return { hostId: 'host-1', port: 7777, version: '1.2.3' };
    },
    async stop() {},
  };
  const lifecycle: LifecycleDisposer = {
    async dispose(input) {
      bump('lifecycle.dispose');
      return {
        outcome: input.outcome,
        retention: retentionForOutcome(input.outcome),
        state: containerState,
      };
    },
  };

  const store: RunStore & { readonly events: { kind: string }[]; readonly envelopes: EnvelopeRecord[] } = {
    events: [],
    envelopes: [],
    async beginRun() {},
    async appendEvent(input) {
      store.events.push({ kind: input.kind });
    },
    async recordEnvelope(record) {
      store.envelopes.push(record);
    },
    async recordAction(_record: ActionRecord) {},
    async recordUsage() {},
    async recordDegeneracyHit() {},
    async finishRun() {},
    async markTask() {},
  };

  const ops: TurnDriverOps = {
    projectRegister: async () => {
      bump('ops.projectRegister');
      return { projectId: 'project-1' };
    },
    sessionCreate: async () => {
      bump('ops.sessionCreate');
      return { id: SESSION_ID };
    },
    eventsSubscribe: async () => {
      bump('ops.eventsSubscribe');
      return {};
    },
    turnStart: async () => {
      bump('ops.turnStart');
      return { id: TURN_ID };
    },
    turnInterrupt: async () => ({}),
    approvalRespond: async () => ({}),
    inputRespond: async () => ({}),
    workspaceDiff: async () => {
      bump('ops.workspaceDiff');
      return { diff: '' };
    },
    sessionArchive: async () => {
      bump('ops.sessionArchive');
      return {};
    },
  };

  const github: GithubWriteApi = {
    listIssueComments: async () => [],
    createIssueComment: async () => {
      bump('github.createIssueComment');
      return { id: 1, htmlUrl: null };
    },
    addLabels: async () => {
      bump('github.addLabels');
    },
    removeLabel: async () => undefined,
    createIssue: async () => {
      bump('github.createIssue');
      return { number: 1 };
    },
    closeIssue: async () => {
      bump('github.closeIssue');
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
    events: () => ({
      [Symbol.asyncIterator]: async function* generate() {
        for (const item of successEvents()) {
          yield item;
        }
      },
    }),
    github,
    image: 'pi-worker:node22',
    clock: () => 1_700_000_000_000,
    logger: {
      child: () =>
        ({
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
          child: () => {
            throw new Error('unused');
          },
        }) as unknown as ReturnType<NonNullable<TaskRunnerDeps['logger']>['child']>,
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as unknown as NonNullable<TaskRunnerDeps['logger']>,
  };

  return { deps, calls };
}

function makeInput(over: Partial<TaskRunInput> = {}): TaskRunInput {
  return {
    taskId: 'task-1',
    runId: 'run-1',
    command: 'pipeline:format',
    repo: REPO,
    targetKind: 'issue',
    targetNumber: TARGET,
    prompt: '【任务】判断格式…',
    source: 'pipeline',
    runtimeMode: 'light',
    session: { mode: 'ephemeral' },
    dryRun: false,
    ...over,
  };
}

describe('light 运行时：零容器 / 零 worktree（V1）', () => {
  it('一次成功：只有 host + turn，四步序列，容器与 worktree 都没被碰过', async () => {
    const { deps, calls } = createHarness();

    const report = await runTask(makeInput(), deps);

    expect(report.outcome).toBe('succeeded');
    // 步骤序列：没有 worktree/container/proxy/diff/dispose
    expect(report.steps).toEqual(['host', 'turn', 'validate', 'execute']);
    // 五个「不该发生」的调用，次数必须是 0
    expect(calls['worktree.create'] ?? 0).toBe(0);
    expect(calls['docker.createContainer'] ?? 0).toBe(0);
    expect(calls['proxy.listen'] ?? 0).toBe(0);
    expect(calls['proxy.destroy'] ?? 0).toBe(0);
    expect(calls['lifecycle.dispose'] ?? 0).toBe(0);
    // diff 也不采（light 没有 worktree，采了必然是空）
    expect(calls['ops.workspaceDiff'] ?? 0).toBe(0);
    // 保留的：host 一次、一次 turn、一次归档（ephemeral）
    expect(calls['host.ready']).toBe(1);
    expect(calls['ops.turnStart']).toBe(1);
    expect(calls['ops.sessionArchive']).toBe(1);
    // 报告里也不该有容器/目录
    expect(report.runtimeMode).toBe('light');
    expect(report.containerId).toBeNull();
    expect(report.jobDir).toBeNull();
    expect(report.disposed).toBe(false);
    expect(report.sessionMode).toBe('ephemeral');
  });

  it('下游照样落库：信封 + run_events + 结束状态（light 不是「跳过一切」）', async () => {
    const { deps } = createHarness();
    const store = deps.store as unknown as {
      events: { kind: string }[];
      envelopes: EnvelopeRecord[];
    };

    const report = await runTask(makeInput(), deps);

    expect(store.envelopes).toHaveLength(1);
    expect(report.envelope?.valid).toBe(true);
    // 信封里的 stage 结论原样留在 prepared 里（阶段 0 的判定靠它）
    expect(store.envelopes[0]?.valid).toBe(true);
    expect(store.events.map((item) => item.kind)).toContain('turn.completed');
  });

  it('light 不调 promptEnricher（提示词已由装配层拼好）', async () => {
    const { deps } = createHarness();
    let enricherCalls = 0;
    const withEnricher: TaskRunnerDeps = {
      ...deps,
      promptEnricher: async () => {
        enricherCalls += 1;
        return '不该被调用';
      },
    };

    await runTask(makeInput(), withEnricher);

    expect(enricherCalls).toBe(0);
  });

  it('host 起不来：跳过 turn，失败体面收场（不碰容器，也不抛）', async () => {
    const { deps, calls } = createHarness();
    const failing: TaskRunnerDeps = {
      ...deps,
      host: {
        ready: async () => {
          throw new Error('HOST_UNAVAILABLE');
        },
        stop: async () => undefined,
      },
    };

    const report = await runTask(makeInput(), failing);

    expect(report.outcome).toBe('failed');
    // 与 sandboxed 的准备阶段失败同形：已经记过的步骤留着，后面的 validate/execute 照记
    expect(report.steps).toEqual(['host', 'validate', 'execute']);
    expect(calls['ops.turnStart'] ?? 0).toBe(0);
    expect(calls['docker.createContainer'] ?? 0).toBe(0);
  });
});

describe('sandboxed（缺省）行为不变', () => {
  it('不传 runtimeMode：worktree / 容器 / 代理 / 处置各一次，步骤仍是九步', async () => {
    const { deps, calls } = createHarness();

    const report = await runTask(makeInput({ runtimeMode: undefined, command: '/issue-triage' }), deps);

    expect(calls['worktree.create']).toBe(1);
    expect(calls['docker.createContainer']).toBe(1);
    expect(calls['proxy.listen']).toBe(1);
    expect(calls['host.ready']).toBe(1);
    expect(calls['ops.workspaceDiff']).toBe(1);
    expect(calls['lifecycle.dispose']).toBe(1);
    expect(report.runtimeMode).toBe('sandboxed');
    expect(report.steps).toEqual([
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
  });
});
