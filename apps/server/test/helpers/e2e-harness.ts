/**
 * 端到端测试夹具（W4-P）：**自建的假 RACP host** + 一组可断言的假端口。
 *
 * 为什么不直接 import `packages/racp-client/test/mock-host.ts`：它是那个包的单测内部件
 * （导出面随时可变），端到端测试一旦依赖它，两个包的测试就耦在一起了。这里**另写一份**，
 * 只实现 vendor 契约里我们真正用到的 operation（`racp.schema.json` 尚未 vendored，
 * 形状按 `packages/racp-client/src/schema.ts` 的守卫取）：
 *
 * ```
 * connection/initialize → project/register → session/create → events/subscribe
 *   → turn/start（回 turn 后推事件）→ workspace/diff → session/archive
 * ```
 *
 * 为什么用**真 `ws` WebSocketServer**而不是假 socket：握手三层（路径 / 子协议 / Bearer）
 * 与帧层（JSON-RPC 2.0）只有真连一次才验得到，而这两层正是 `RacpClient` 与
 * `app/racp.ts` 最容易接错的地方。假 socket 会把装配错误变成「测试永远绿」。
 */
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import type { AppConfig, AppQueue, QueueStatsLike, WorkerPorts } from '../../src/app/index.ts';
import { readAppConfig } from '../../src/app/index.ts';
import type { GithubWriteApi } from '../../src/github/index.ts';
import type { Metrics, MetricsServer } from '../../src/http/index.ts';
import { createMetrics } from '../../src/http/index.ts';
import type { CreateQueueOptions, RunTaskJobData, TaskJob } from '../../src/queue/index.ts';
import { retentionForOutcome } from '../../src/sandbox/index.ts';
import type {
  ContainerStateSnapshot,
  SandboxContainerSpec,
  SandboxDocker,
  TaskOutcome,
} from '../../src/sandbox/index.ts';
import type {
  ExecProxyPort,
  HostEndpoint,
  HostPort,
  LifecycleDisposer,
  WorktreePort,
} from '../../src/worker/index.ts';

/* ── 常量 ─────────────────────────────────────────────────────────────────── */

/** RACP 的 WS 路径与子协议（tech-plan §4.2 的已验证事实）。 */
export const RACP_PATH = '/v1/racp/ws';
export const RACP_SUBPROTOCOL = 'pi-racp.v1.jsonrpc';
/** 事件推送的方法名（`RacpClient` 的 `EVENT_NOTIFICATION_METHOD`）。 */
export const EVENT_METHOD = 'events/event';

/** 假 host 自报的版本（本机没有 bundle；`PIN.json` 校验归 doctor）。 */
export const E2E_HOST_VERSION = '0.21.0';
/** RACP 协议版本（`RACP_PROTOCOL_VERSION`）。 */
export const E2E_PROTOCOL_VERSION = '1.0';

/** 假 host 认的设备令牌（`pdt1.` 前缀是 `assertBearerToken` 的要求）。 */
export const E2E_DEVICE_TOKEN = 'pdt1.e2etestdevicetoken0001';
/** webhook secret（测试里的固定值，不来自环境）。 */
export const E2E_WEBHOOK_SECRET = 'e2e-webhook-secret-0123456789';
/** 测试库 DSN（与 `queries-db.ts` 同一个来源）。 */
export const E2E_DSN =
  process.env['PI_BOT_TEST_DSN'] ?? 'postgres://postgres:postgres@127.0.0.1:5432/pi_issue_bot_test';

/* ── 假 RACP host ─────────────────────────────────────────────────────────── */

/** 一轮 turn 的脚本：推哪些事件、终态是什么。 */
export interface FakeTurnScript {
  /** `item.completed` 的 `payload.text`（要含 json 围栏里的信封；不含则 worker 判 parse 失败）。 */
  readonly text: string;
  readonly terminal?: 'turn.completed' | 'turn.interrupted' | 'turn.failed';
  /** 事件之间的间隔（默认 2ms：让 `turn/start` 的响应先回到客户端）。 */
  readonly delayMs?: number;
}

export interface FakeRacpHostOptions {
  readonly token?: string;
  readonly script?: FakeTurnScript;
}

/** 一次收到的请求（断言「发了哪些 operation」）。 */
export interface RecordedCall {
  readonly method: string;
  readonly params: unknown;
}

const defaultScript: FakeTurnScript = { text: '（默认脚本：不给信封）', terminal: 'turn.completed' };

/**
 * 假 pi-host：一条连接、一批 JSON-RPC operation、按脚本推事件。
 *
 * 它**不**实现：会话持久化、审批策略、能力协商、游标重放。端到端要验的是
 * 「装配是否把东西连起来了」，不是 pi-host 的完整语义。
 */
export class FakeRacpHost {
  readonly calls: RecordedCall[] = [];
  readonly #server: WebSocketServer;
  readonly #token: string;
  readonly #sockets = new Set<WebSocket>();
  #script: FakeTurnScript;
  #sequence = 0;

  private constructor(server: WebSocketServer, options: FakeRacpHostOptions) {
    this.#server = server;
    this.#token = options.token ?? E2E_DEVICE_TOKEN;
    this.#script = options.script ?? defaultScript;
    this.#server.on('connection', (socket) => {
      this.#sockets.add(socket);
      socket.on('close', () => {
        this.#sockets.delete(socket);
      });
      socket.on('message', (data) => {
        void this.#handle(socket, String(data));
      });
    });
  }

  static async start(options: FakeRacpHostOptions = {}): Promise<FakeRacpHost> {
    const token = options.token ?? E2E_DEVICE_TOKEN;
    const server = new WebSocketServer({
      port: 0,
      path: RACP_PATH,
      // Host 侧只接受那一个子协议字面量；不选就等于拒绝（transport 会报握手错）
      handleProtocols: (protocols) => (protocols.has(RACP_SUBPROTOCOL) ? RACP_SUBPROTOCOL : false),
      verifyClient: (info, done) => {
        if (info.req.headers.authorization === `Bearer ${token}`) {
          done(true);
          return;
        }
        done(false, 401, 'Unauthorized');
      },
    });
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    return new FakeRacpHost(server, options);
  }

  get port(): number {
    const address = this.#server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('假 host 还没有监听端口');
    }
    return (address as AddressInfo).port;
  }

  get url(): string {
    return `ws://127.0.0.1:${String(this.port)}${RACP_PATH}`;
  }

  /** 换脚本（同一个 host 可以先后跑「合规信封」与「不合规信封」两个场景）。 */
  setScript(script: FakeTurnScript): void {
    this.#script = script;
  }

  /** 本 host 交给 `HostPort` 的端点形状。 */
  endpoint(): HostEndpoint {
    return {
      hostId: 'fake-host-e2e',
      port: this.port,
      version: E2E_HOST_VERSION,
      token: this.#token,
    };
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) {
      socket.terminate();
    }
    this.#sockets.clear();
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
  }

  async #handle(socket: WebSocket, raw: string): Promise<void> {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      socket.send(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
      );
      return;
    }
    const method = typeof frame['method'] === 'string' ? frame['method'] : '<no method>';
    const params = frame['params'];
    this.calls.push({ method, params });
    const id = frame['id'];
    if (id === undefined || id === null) {
      // 客户端发来的通知：不回
      return;
    }
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, result: this.#resultOf(method, params) }));
    if (method === 'turn/start') {
      this.#emitScript(socket);
    }
  }

  #resultOf(method: string, params: unknown): unknown {
    switch (method) {
      case 'connection/initialize':
        return {
          protocolVersion: E2E_PROTOCOL_VERSION,
          server: { name: 'pi-host', version: E2E_HOST_VERSION, hostId: 'fake-host-e2e' },
          connectionId: 'connection-e2e',
          principal: { subject: 'device:e2e', roles: ['owner'] },
          capabilities: { eventReplay: true, snapshot: true, approvals: true, inputRequests: true },
          limits: {
            maxFrameBytes: 8 * 1024 * 1024,
            maxPromptBytes: 256 * 1024,
            maxAttachmentBytes: 1,
            maxSubscriptionsPerConnection: 8,
            maxQueuedTurnsPerSession: 2,
            replayWindowEvents: 1000,
          },
          policy: {
            remoteMaxPermissionMode: 'ask',
            applyCeilingToPairedDevices: true,
            approvalLifetimeMs: 600_000,
          },
        };
      case 'project/register':
        return { projectId: 'project-e2e', path: readString(params, 'path') ?? '/tmp/e2e' };
      case 'session/create':
        return { session: fakeSession() };
      case 'events/subscribe':
        return { subscriptionId: 'sub-e2e', cursor: { epoch: 'epoch-e2e', sequence: 0 } };
      case 'turn/start':
        return { turn: fakeTurn({ status: 'running' }) };
      case 'turn/interrupt':
        return { turn: fakeTurn({ status: 'interrupted' }) };
      case 'turn/get':
        return { turn: fakeTurn({ status: 'running' }) };
      case 'workspace/diff':
        return {
          diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n',
          truncated: false,
        };
      case 'approval/respond':
        return {
          result: {
            approvalId: 'approval-e2e',
            status: 'resolved',
            decision: 'allow-once',
            alreadyResolved: false,
            revision: 2,
          },
        };
      case 'session/archive':
      case 'session/delete':
      case 'events/unsubscribe':
      case 'events/ack':
      case 'turn/stop':
      case 'input/respond':
        return {};
      default:
        return {};
    }
  }

  /** 推脚本事件：`item.completed`（带信封）+ 终态。 */
  #emitScript(socket: WebSocket): void {
    const script = this.#script;
    const delay = script.delayMs ?? 2;
    const events = [
      { kind: 'item.completed', payload: { text: script.text } },
      { kind: script.terminal ?? 'turn.completed', payload: { status: 'completed' } },
    ];
    events.forEach((event, index) => {
      setTimeout(
        () => {
          this.#sequence += 1;
          const envelope = {
            eventId: `evt-${String(this.#sequence)}`,
            scope: 'session',
            sessionId: 'session-e2e',
            epoch: 'epoch-e2e',
            revision: this.#sequence,
            kind: event.kind,
            occurredAt: new Date().toISOString(),
            payload: event.payload,
          };
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ jsonrpc: '2.0', method: EVENT_METHOD, params: envelope }));
          }
        },
        delay * (index + 1),
      );
    });
  }
}

function readString(params: unknown, key: string): string | undefined {
  if (typeof params !== 'object' || params === null) {
    return undefined;
  }
  const value = (params as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** `isSession` 要求的完整形状（缺字段会 `PROTOCOL_ERROR`）。 */
export function fakeSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = '2026-06-01T00:00:00.000Z';
  return {
    id: 'session-e2e',
    title: 'e2e session',
    mode: 'agent',
    status: 'idle',
    planningState: 'inactive',
    permissionMode: 'ask',
    queuedTurnIds: [],
    revision: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** `isTurn` 要求的完整形状。 */
export function fakeTurn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'turn-e2e',
    sessionId: 'session-e2e',
    status: 'queued',
    admission: 'reject_if_busy',
    effectivePermissionMode: 'ask',
    ...overrides,
  };
}

/* ── 假 worker 端口 ───────────────────────────────────────────────────────── */

export interface FakePortsRecord {
  readonly createdContainers: SandboxContainerSpec[];
  readonly destroyedContainers: string[];
  readonly disposed: TaskOutcome[];
  readonly worktrees: string[];
  readonly hostStops: number;
  readonly proxyDestroyed: string[];
}

export interface FakePortsOptions {
  readonly endpoint: HostEndpoint;
  readonly github?: GithubWriteApi;
  readonly jobRoot?: string;
  readonly containerState?: ContainerStateSnapshot;
}

/** `RunStore` 哨兵：端到端测试必须注入真 PG 实现（`createPgRunStore`）。 */
function unconfiguredRunStore(): WorkerPorts['store'] {
  const unset = async (): Promise<never> => {
    throw new Error('端到端测试必须注入真 RunStore（createPgRunStore），不能落到这个哨兵');
  };
  return {
    beginRun: unset,
    appendEvent: unset,
    recordEnvelope: unset,
    recordAction: unset,
    recordDegeneracyHit: unset,
    finishRun: unset,
    markTask: unset,
  };
}

/** 一套不碰 docker / pi-host 的 worker 端口，附带可断言的记录。 */
export function createFakePorts(options: FakePortsOptions): {
  ports: WorkerPorts;
  record: FakePortsRecord;
} {
  const jobRoot = options.jobRoot ?? path.join(process.cwd(), '.e2e-jobs');
  const createdContainers: SandboxContainerSpec[] = [];
  const destroyedContainers: string[] = [];
  const disposed: TaskOutcome[] = [];
  const worktrees: string[] = [];
  const proxyDestroyed: string[] = [];
  let hostStops = 0;
  const containerState: ContainerStateSnapshot = options.containerState ?? {
    containerId: 'container-e2e',
    status: 'exited',
    running: false,
    exitCode: 0,
    oomKilled: false,
  };

  const docker: SandboxDocker = {
    async ping() {},
    async createContainer(spec) {
      createdContainers.push(spec);
      return 'container-e2e';
    },
    async inspectState() {
      return containerState;
    },
    async execStream() {
      throw new Error('worker 不该自己 exec（命令走 exec 代理）');
    },
    async destroyContainer(containerId) {
      destroyedContainers.push(containerId);
    },
  };

  const worktree: WorktreePort = {
    async create(input) {
      const jobDir = path.join(jobRoot, input.taskId);
      worktrees.push(jobDir);
      return { taskId: input.taskId, repo: input.repo, jobDir };
    },
    async release() {},
  };

  const proxy: ExecProxyPort = {
    async listen(input) {
      const socketPath = `${input.jobDir}/.pi-bot/exec.sock`;
      return { address: `unix:${socketPath}`, socketPath };
    },
    async destroy(target) {
      proxyDestroyed.push(target.jobId);
    },
  };

  const host: HostPort = {
    async ready() {
      return options.endpoint;
    },
    async stop() {
      hostStops += 1;
    },
  };

  const lifecycle: LifecycleDisposer = {
    async dispose(input) {
      disposed.push(input.outcome);
      return {
        outcome: input.outcome,
        retention: retentionForOutcome(input.outcome),
        state: containerState,
      };
    },
  };

  const record: FakePortsRecord = {
    createdContainers,
    destroyedContainers,
    disposed,
    worktrees,
    get hostStops() {
      return hostStops;
    },
    proxyDestroyed,
  };

  return {
    ports: {
      worktree,
      docker,
      proxy,
      host,
      lifecycle,
      // 端到端测试要验的是**真**落库（PG），store 由测试用 `createPgRunStore` 覆盖；
      // 这里放一个「用了就炸」的哨兵，忘了注入能立刻发现
      store: unconfiguredRunStore(),
      github: options.github ?? createCountingGithubApi().api,
    },
    record,
  };
}

/* ── 假 GitHub（数「非 GET」调用）──────────────────────────────────────────── */

export interface GithubCallRecord {
  readonly method: string;
  /** `GET` 之外的调用就是「写」（M0 的 ⛔ 项要求它为 0）。 */
  readonly nonGet: boolean;
}

export interface CountingGithubApi {
  readonly api: GithubWriteApi;
  readonly calls: GithubCallRecord[];
  /** 非 GET 调用次数（= 0 才算「GitHub 零副作用」）。 */
  nonGetCount(): number;
}

/**
 * 记账用的假写面。
 *
 * 只有 `listIssueComments` 是 GET（`GET /repos/…/issues/…/comments`），其余都是写：
 * `createIssueComment`(POST) / `addLabels`(POST) / `removeLabel`(DELETE) /
 * `createIssue`(POST) / `closeIssue`(PATCH)。
 */
export function createCountingGithubApi(): CountingGithubApi {
  const calls: GithubCallRecord[] = [];
  const record = (method: string, nonGet: boolean): void => {
    calls.push({ method, nonGet });
  };
  let nextId = 5_000;

  const api: GithubWriteApi = {
    async listIssueComments() {
      record('listIssueComments', false);
      return [];
    },
    async createIssueComment(input) {
      record(`createIssueComment:${String(input.issueNumber)}`, true);
      nextId += 1;
      return { id: nextId, htmlUrl: null };
    },
    async addLabels(input) {
      record(`addLabels:${input.labels.join(',')}`, true);
    },
    async removeLabel() {
      record('removeLabel', true);
    },
    async createIssue() {
      record('createIssue', true);
      nextId += 1;
      return { number: nextId };
    },
    async closeIssue() {
      record('closeIssue', true);
    },
  };

  return {
    api,
    calls,
    nonGetCount: () => calls.filter((call) => call.nonGet).length,
  };
}

/* ── 假队列（结构满足 AppQueue，不连 pg-boss）────────────────────────────── */

export interface FakeQueueRecord {
  readonly sent: Array<{ name: string; data: RunTaskJobData; options: unknown }>;
  readonly createdQueues: string[];
  readonly schedules: string[];
  readonly workers: string[];
  readonly stopped: Array<{ graceful?: boolean; timeout?: number }>;
  starts: number;
}

export interface FakeQueue extends AppQueue {
  readonly record: FakeQueueRecord;
}

/** 有记录的假队列：`send` 计数就是「入队了几次」，`work` 只记名字不执行。 */
export function createFakeQueue(): FakeQueue {
  const record: FakeQueueRecord = {
    sent: [],
    createdQueues: [],
    schedules: [],
    workers: [],
    stopped: [],
    starts: 0,
  };
  const queues = new Map<string, unknown>();
  let jobSeq = 0;

  return {
    record,
    async start() {
      record.starts += 1;
      return undefined;
    },
    async stop(options?: { graceful?: boolean; timeout?: number }) {
      record.stopped.push({ ...options });
    },
    async send(name: string, data: object | null, options?: unknown) {
      jobSeq += 1;
      record.sent.push({ name, data: (data ?? {}) as RunTaskJobData, options });
      return `job-${String(jobSeq)}`;
    },
    async cancel() {
      return undefined;
    },
    async findJobs() {
      return [];
    },
    async work(name: string) {
      record.workers.push(name);
      return `worker-${name}`;
    },
    async getQueue(name: string) {
      return queues.get(name) ?? null;
    },
    async createQueue(name: string, options: CreateQueueOptions) {
      record.createdQueues.push(name);
      queues.set(name, { name, ...options });
    },
    async schedule(name: string) {
      record.schedules.push(name);
    },
    async getQueueStats(): Promise<readonly QueueStatsLike[]> {
      return [{ queuedCount: 0, activeCount: 0 }];
    },
  };
}

/* ── 配置 / 签名 / 指标 / 库 ──────────────────────────────────────────────── */

/** 端到端用的 `AppConfig`（端口 0、dry-run 默认开、数据目录在 cwd 下但不落盘）。 */
export function e2eConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return readAppConfig({
    PI_BOT_PG_DSN: E2E_DSN,
    PI_BOT_WEBHOOK_SECRET: E2E_WEBHOOK_SECRET,
    PI_BOT_DATA_DIR: path.join(process.cwd(), '.e2e-data'),
    PI_BOT_DRY_RUN: 'true',
    PI_BOT_HTTP_HOST: '127.0.0.1',
    PI_BOT_PORT: '0',
    PI_BOT_METRICS_HOST: '127.0.0.1',
    PI_BOT_METRICS_PORT: '0',
    ...overrides,
  });
}

/** `X-Hub-Signature-256` 的值（GitHub 用 `sha256=<hex hmac>`）。 */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** 不真监听的 metrics 实例（省掉一个端口，也让测试更快）。 */
export function stubMetricsServer(): MetricsServer {
  return {
    instance: null as unknown as FastifyInstance,
    host: '127.0.0.1',
    port: 0,
    listen: async () => ({ host: '127.0.0.1', port: 0 }),
    close: async () => undefined,
  };
}

/** 不带进程级默认采集的 metrics（`defaultMetrics: true` 会起定时器，拖慢测试退出）。 */
export function quietMetrics(): Metrics {
  return createMetrics({ defaultMetrics: false });
}

/**
 * 包一层 `Pool`，只把 `end()` 变成空操作。
 *
 * 为什么需要：`app.stop()` 会关掉注入的池（正确的生产语义），而端到端测试的库夹具还要用
 * 同一个池做「释放 advisory lock + 真关池」。让 app 拿到 `end()` 为 no-op 的视图，
 * 两边语义都保住：app 认为自己关了，夹具负责真正关。
 */
export function poolWithNoopEnd(pool: Pool): Pool {
  return new Proxy(pool, {
    get(target, property) {
      if (property === 'end') {
        return async () => undefined;
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as unknown as Pool;
}

/** 一个任务的 run / 信封 / 动作（断言用）。 */
export async function readRunSnapshot(
  query: (text: string, values?: unknown[]) => Promise<Array<Record<string, unknown>>>,
  taskId: string,
): Promise<{
  runs: Array<Record<string, unknown>>;
  envelopes: Array<Record<string, unknown>>;
  actions: Array<Record<string, unknown>>;
}> {
  const runs = await query('select * from runs where task_id = $1 order by started_at', [taskId]);
  const runIds = runs.map((row) => String(row['id']));
  if (runIds.length === 0) {
    return { runs, envelopes: [], actions: [] };
  }
  const envelopes = await query('select * from envelopes where run_id = any($1::text[])', [runIds]);
  const actions = await query('select * from actions where run_id = any($1::text[])', [runIds]);
  return { runs, envelopes, actions };
}

/** 造一个 `RunTaskJobData` 的子集（断言 `send` 载荷时用）。 */
export function expectedJobData(input: {
  taskId: string;
  command?: string;
  repo?: string;
}): Partial<RunTaskJobData> {
  return {
    taskId: input.taskId,
    ...(input.command === undefined ? {} : { command: input.command }),
    ...(input.repo === undefined ? {} : { repo: input.repo }),
  };
}

/** 让出一个 tick（等假 host 的事件推完）。 */
export function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 等一条满足条件的任务行出现（webhook handler 落库是异步的）。 */
export async function waitForTask(
  query: (text: string, values?: unknown[]) => Promise<Array<Record<string, unknown>>>,
  predicate: (row: Record<string, unknown>) => boolean,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await query('select * from tasks');
    const hit = rows.find(predicate);
    if (hit !== undefined) {
      return hit;
    }
    if (Date.now() > deadline) {
      throw new Error(`等任务行超时（${String(timeoutMs)}ms）：tasks 里只有 ${String(rows.length)} 行`);
    }
    await tick(5);
  }
}

/** `queue` 里的 job 形状（假队列从不真正投递，这里只补个类型别名）。 */
export type FakeTaskJob = TaskJob;
