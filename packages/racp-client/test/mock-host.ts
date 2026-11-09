/**
 * Mock pi-host：同进程内起一个真 `WebSocketServer`（端口 0 随机），把 RACP 的协议行为固定下来。
 *
 * 为什么不是「假 socket」：本机的 `vendor/pi-host` 不存在（`docs/dev-plan.md` §13.1），实机
 * `initialize` 跑不了。但 handshake 的三个前置拒绝（Bearer / 子协议 / 路径）**只能在真握手里
 * 验证**，假 socket 恰好把这一层跳过了。所以这里起真服务器、用真 `ws` 客户端连，
 * 只在「业务响应内容」上做假。
 *
 * 与真 host 的差异（写在这里，免得把 mock 当契约）：
 * - `connection/initialize` 的结果按 `schema.ts` 的最小形状造，字段名对齐 fixture，
 *   但没有真实 capabilities/limits 语义；
 * - 事件推送方法名用 `events/event`（本包的假设，见 `client.ts` 的 `EVENT_NOTIFICATION_METHOD`）；
 * - 没有版本/能力协商逻辑，`hostVersion` 直接用构造参数；
 * - 配对令牌只校验前缀，不校验一次性消费；
 * - 不支持 server→client request（真 host 在 `serverRequests` 能力下可能发）。
 */

import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { encodeError, encodeNotification, encodeSuccess } from '../src/frames.ts';
import { EVENT_NOTIFICATION_METHOD } from '../src/client.ts';
import { RACP_WS_PATH, RACP_WS_SUBPROTOCOL } from '../src/transport.ts';
import type { JsonRecord } from '../src/schema.ts';

export const MOCK_HOST_VERSION = '0.21.0';
export const MOCK_PROTOCOL_VERSION = '1.0';
/** 引导期令牌（`--pair` 打印出来的那种）。 */
export const MOCK_PAIRING_TOKEN = 'ppt1.mockpairingtoken0001';
/** 配对换回来的设备令牌。 */
export const MOCK_DEVICE_TOKEN = 'pdt1.mockdevicetoken0001';

export interface MockRequestRecord {
  readonly id: string | number | undefined;
  readonly method: string;
  readonly params: unknown;
  readonly isBinary: boolean;
  readonly raw: string;
}

export type MockHandler = (
  params: unknown,
  host: MockHost,
) => unknown | Promise<unknown>;

export interface MockHostOptions {
  readonly hostVersion?: string;
  readonly protocolVersion?: string;
  /** 只接受这个 Bearer；默认 `MOCK_DEVICE_TOKEN`。 */
  readonly acceptedToken?: string;
  /** `false` 时 Host 不选任何子协议（模拟 handleProtocols 拒掉我们）。 */
  readonly acceptSubprotocol?: boolean;
  /** 覆盖某个 method 的响应。返回 `undefined` 表示「由 mock 自己回 `{}`」。 */
  readonly handlers?: Readonly<Record<string, MockHandler>>;
  /** 这些 method 不回响应（用来测超时）。 */
  readonly silentMethods?: readonly string[];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function delay(ms: number): Promise<void> {
  await sleep(ms);
}

/**
 * 一个最小可用的 RACP host。
 *
 * 用法：
 * ```ts
 * const host = await MockHost.start();
 * try { ... } finally { await host.close(); }
 * ```
 */
export class MockHost {
  readonly #server: WebSocketServer;
  readonly #options: MockHostOptions;
  readonly #sockets = new Set<WebSocket>();
  readonly #requests: MockRequestRecord[] = [];
  readonly #handlers = new Map<string, MockHandler>();
  readonly #afterReply: Array<() => void> = [];
  readonly #listeners = new Set<() => void>();

  /** 事件历史（供 `after` 游标重放）。 */
  readonly events: JsonRecord[] = [];

  private constructor(server: WebSocketServer, options: MockHostOptions) {
    this.#server = server;
    this.#options = options;
    for (const [method, handler] of Object.entries(options.handlers ?? {})) {
      this.#handlers.set(method, handler);
    }
    this.#server.on('connection', (socket) => this.#handleConnection(socket));
  }

  static async start(options: MockHostOptions = {}): Promise<MockHost> {
    const acceptedToken = options.acceptedToken ?? MOCK_DEVICE_TOKEN;
    const server = new WebSocketServer({
      port: 0,
      path: RACP_WS_PATH,
      // Host 侧只接受那一个子协议字面量；这里返回 false 等价于「没选中」。
      handleProtocols: (protocols) =>
        options.acceptSubprotocol === false
          ? false
          : protocols.has(RACP_WS_SUBPROTOCOL)
            ? RACP_WS_SUBPROTOCOL
            : false,
      verifyClient: (info, done) => {
        const header = info.req.headers.authorization;
        const expected = `Bearer ${acceptedToken}`;
        if (header === expected) {
          done(true);
          return;
        }
        // 缺 Authorization / 令牌不符一律 401（与 pi-host 的前置拒绝一致）。
        done(false, 401, 'Unauthorized');
      },
    });
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    return new MockHost(server, options);
  }

  get port(): number {
    const address = this.#server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('mock host 还没有监听端口');
    }
    return (address as AddressInfo).port;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}${RACP_WS_PATH}`;
  }

  /** 收到的全部帧（文本与 binary 都记，便于断言「不重发」）。 */
  get requests(): readonly MockRequestRecord[] {
    return this.#requests;
  }

  get connectionCount(): number {
    return this.#sockets.size;
  }

  /** 最近一条请求（断言「只发了一次」时用）。 */
  get lastRequest(): MockRequestRecord | undefined {
    return this.#requests.at(-1);
  }

  registerHandler(method: string, handler: MockHandler): void {
    this.#handlers.set(method, handler);
  }

  /** 等收到第 `count` 条请求（超时报错，而不是让测试挂住）。 */
  async waitForRequests(count: number, timeoutMs = 2_000): Promise<readonly MockRequestRecord[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.#requests.length < count) {
      if (Date.now() > deadline) {
        throw new Error(`mock host 只收到 ${this.#requests.length} 条请求，期望 ${count} 条`);
      }
      await sleep(5);
    }
    return this.#requests;
  }

  /** 推一条 durable 事件（进历史，供订阅重放）。 */
  pushEvent(event: JsonRecord): void {
    this.events.push(event);
  }

  /** 连上之后主动推一条通知（不走订阅）。 */
  sendNotification(method: string, params: unknown): void {
    const frame = encodeNotification({ method, params });
    for (const socket of this.#sockets) socket.send(frame);
  }

  /** 推一条事件通知（`events/event` 的假设形状：params 就是 EventEnvelope）。 */
  sendEvent(event: JsonRecord): void {
    this.pushEvent(event);
    this.sendNotification(EVENT_NOTIFICATION_METHOD, event);
  }

  /** 原始文本帧（用来造「不是合法 JSON」「形状不对」这类协议错误）。 */
  sendRaw(text: string): void {
    for (const socket of this.#sockets) socket.send(text);
  }

  /** binary 帧：RACP 只接受文本帧，客户端必须拒绝它。 */
  sendBinary(data: Uint8Array | string): void {
    for (const socket of this.#sockets) {
      socket.send(typeof data === 'string' ? Buffer.from(data) : data, { binary: true });
    }
  }

  /** 直接掐断连接（模拟 Host 崩了 / 网络断）：不带 close 帧，客户端看到 1006。 */
  terminateClients(): void {
    for (const socket of this.#sockets) socket.terminate();
    this.#sockets.clear();
  }

  /** 优雅关闭全部连接（1001）。 */
  closeClients(): void {
    for (const socket of this.#sockets) socket.close(1001, 'mock host shutdown');
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.terminate();
    this.#sockets.clear();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  // ── 内部 ─────────────────────────────────────────────────────────────

  #handleConnection(socket: WebSocket): void {
    this.#sockets.add(socket);
    socket.on('close', () => this.#sockets.delete(socket));
    socket.on('message', (data, isBinary) => {
      void this.#handleMessage(socket, data, isBinary);
    });
  }

  async #handleMessage(socket: WebSocket, data: unknown, isBinary: boolean): Promise<void> {
    const raw = toText(data);
    let frame: JsonRecord;
    try {
      frame = JSON.parse(raw) as JsonRecord;
    } catch {
      this.#requests.push({ id: undefined, method: '<invalid json>', params: raw, isBinary, raw });
      socket.send(
        encodeError({
          id: null,
          error: { code: -32700, message: 'Parse error' },
        }),
      );
      return;
    }
    const method = typeof frame.method === 'string' ? frame.method : '<no method>';
    const id = typeof frame.id === 'string' || typeof frame.id === 'number' ? frame.id : undefined;
    this.#requests.push({ id, method, params: frame.params, isBinary, raw });
    for (const listener of this.#listeners) listener();
    if (id === undefined) return; // 客户端发来的通知：不响应

    if (this.#options.silentMethods?.includes(method) === true) return;

    const handler = this.#handlers.get(method);
    let result: unknown;
    try {
      result = handler === undefined ? this.#defaultResult(method, frame.params) : await handler(frame.params, this);
    } catch (error) {
      socket.send(
        encodeError({
          id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
            data: { code: 'INTERNAL', message: 'mock handler 抛出', retriable: false, traceId: 'mock' },
          },
        }),
      );
      return;
    }
    if (result === MOCK_NO_RESPONSE) return;
    socket.send(encodeSuccess({ id, result: result ?? {} }));
    // 响应之后再发「重放」的事件，保证客户端先拿到 subscribe 的成功响应。
    const queued = this.#afterReply.splice(0);
    for (const run of queued) run();
  }

  #defaultResult(method: string, params: unknown): unknown {
    switch (method) {
      case 'connection/initialize':
        return buildInitializeResult(
          this.#options.hostVersion ?? MOCK_HOST_VERSION,
          this.#options.protocolVersion ?? MOCK_PROTOCOL_VERSION,
        );
      case 'connection/ping':
        return { pong: true };
      case 'connection/pair':
        return { deviceToken: MOCK_DEVICE_TOKEN, hostId: 'mock-host', deviceId: 'device-1' };
      case 'project/register':
        return { projectId: 'project-1', path: readString(params, 'path') ?? '/tmp/mock' };
      case 'session/create':
        return { session: mockSession() };
      case 'session/attach':
        return { snapshot: mockSnapshot() };
      case 'session/archive':
      case 'session/delete':
      case 'events/unsubscribe':
      case 'events/ack':
      case 'turn/stop':
      case 'input/respond':
        return {};
      case 'events/subscribe': {
        const after = readSequence(params);
        this.#afterReply.push(() => {
          for (const event of this.events) {
            const sequence = typeof event.sequence === 'number' ? event.sequence : 0;
            if (sequence > after) this.sendNotification(EVENT_NOTIFICATION_METHOD, event);
          }
        });
        return { subscriptionId: 'sub-1', cursor: { epoch: 'epoch-1', sequence: after } };
      }
      case 'turn/start':
        return { turn: mockTurn({ status: 'running' }) };
      case 'turn/get':
        return { turn: mockTurn({ status: 'running' }) };
      case 'turn/interrupt':
        return { turn: mockTurn({ status: 'interrupted' }) };
      case 'approval/respond':
        return { result: mockApprovalResult() };
      case 'workspace/diff':
        return { diff: '--- a\n+++ b\n', truncated: false };
      default:
        return undefined;
    }
  }
}

/** handler 返回它 = mock 不回响应（等同 `silentMethods`，但可以按参数决定）。 */
export const MOCK_NO_RESPONSE = Symbol('MOCK_NO_RESPONSE');

function toText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data as Uint8Array[]).toString('utf8');
  }
  return String(data);
}

function readString(params: unknown, key: string): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const value = (params as JsonRecord)[key];
  return typeof value === 'string' ? value : undefined;
}

/** 从 `events/subscribe` 的 params 里读游标：数字（0）或 `{epoch, sequence}`。 */
function readSequence(params: unknown): number {
  if (typeof params !== 'object' || params === null) return 0;
  const after = (params as JsonRecord).after;
  if (typeof after === 'number') return after;
  if (typeof after === 'object' && after !== null) {
    const sequence = (after as JsonRecord).sequence;
    if (typeof sequence === 'number') return sequence;
  }
  return 0;
}

/** 与 `schema.ts::isInitializeResult` 对齐的最小合法结果。 */
export function buildInitializeResult(
  hostVersion = MOCK_HOST_VERSION,
  protocolVersion = MOCK_PROTOCOL_VERSION,
): JsonRecord {
  return {
    protocolVersion,
    server: { name: 'pi-host', version: hostVersion, hostId: 'mock-host' },
    connectionId: 'connection-1',
    principal: { subject: 'device:mock', roles: ['owner'] },
    capabilities: { eventReplay: true, snapshot: true, approvals: true, inputRequests: true },
    limits: {
      maxFrameBytes: 8 * 1024 * 1024,
      maxPromptBytes: 256 * 1024,
      maxAttachmentBytes: 1,
      maxSubscriptionsPerConnection: 8,
      maxQueuedTurnsPerSession: 2,
      replayWindowEvents: 1_000,
    },
    policy: {
      remoteMaxPermissionMode: 'ask',
      applyCeilingToPairedDevices: true,
      approvalLifetimeMs: 600_000,
    },
  };
}

export function mockSession(overrides: JsonRecord = {}): JsonRecord {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: 'session-1',
    title: 'mock session',
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

export function mockTurn(overrides: JsonRecord = {}): JsonRecord {
  return {
    id: 'turn-1',
    sessionId: 'session-1',
    status: 'queued',
    admission: 'reject_if_busy',
    effectivePermissionMode: 'ask',
    ...overrides,
  };
}

export function mockApprovalResult(overrides: JsonRecord = {}): JsonRecord {
  return {
    approvalId: 'approval-1',
    status: 'resolved',
    decision: 'allow-once',
    alreadyResolved: false,
    revision: 2,
    ...overrides,
  };
}

export function mockSnapshot(): JsonRecord {
  return {
    session: mockSession(),
    queuedTurns: [],
    items: [],
    activeItems: [],
    pendingApprovals: [],
    pendingInputs: [],
    hasMoreHistory: false,
    cursor: { epoch: 'epoch-1', sequence: 0 },
    revision: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** 造一条 durable 事件（`sequence` 递增，供 `after` 重放测试用）。 */
export function mockEvent(sequence: number, overrides: JsonRecord = {}): JsonRecord {
  return {
    eventId: `event-${sequence}`,
    scope: 'session',
    sessionId: 'session-1',
    epoch: 'epoch-1',
    sequence,
    revision: sequence,
    kind: 'turn.started',
    occurredAt: '2026-01-01T00:00:00.000Z',
    payload: {},
    ...overrides,
  };
}
