/**
 * RACP 客户端：请求/响应配对 + 每调用超时 + 断线语义 + 事件分发（tech-plan §4.3 / §4.7）。
 *
 * 三条必须写死的语义（brief 与本仓文档都点名了，这里逐条对着实现）：
 *
 * 1. **每调用一个超时**，走 `AbortSignal`：`options.signal`（调用方）与 `options.timeoutMs`
 *    （本客户端）合并，谁先到就谁生效。tech-plan §4.7 用同一个 `AbortSignal` 做任务级时间闸，
 *    所以超时归类为 `TIMEOUT`、取消归类为 `ABORTED`，两者的 `failureClass` 都是 `timeout`。
 * 2. **断线时在飞调用一律以 `HOST_DISCONNECTED` 拒绝，且不重发**（规范 §14a 最后一条 /
 *    tech-plan §1.1 第 3 条）。这里不写「重连后补发」——补发会让一个已经可能执行过的
 *    `turn/start` 执行两次；重试是上层的事，且必须带同一个 `idempotencyKey`。
 * 3. **`after` 游标由调用方给**：本客户端不认识「该从哪里开始重放」，`events/subscribe`
 *    的 `after` 原样透传（见 `ops.ts`）。断线重连后重订阅是调用方的决定。
 */

import { randomUUID } from 'node:crypto';
import {
  abortedError,
  closedError,
  disconnectedError,
  fromJsonRpcError,
  hostVersionMismatchError,
  invalidArgumentError,
  notConnectedError,
  protocolMismatchError,
  timeoutError,
  toRacpError,
  type RacpError,
} from './errors.ts';
import {
  InFlightTable,
  JsonRpcIdSequence,
  decodeIncomingFrame,
  encodeRequest,
  idKey,
  isErrorFrame,
  isNotificationFrame,
  type JsonRpcId,
  type JsonRpcIncomingFrame,
  type JsonRpcNotificationFrame,
  type JsonRpcResponseFrame,
} from './frames.ts';
import { previewRedacted } from './redact.ts';
import {
  RACP_PROTOCOL_VERSION,
  assertWith,
  isEventEnvelope,
  isInitializeResult,
  type EventEnvelope,
  type InitializeResult,
  type RequestContext,
} from './schema.ts';
import {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  RacpTransport,
  type CloseInfo,
  type WebSocketFactory,
} from './transport.ts';

/**
 * 事件推送用的通知方法名。
 *
 * **这是一条假设，不是已验证事实**：`racp.schema.json` 还没 vendored（`docs/dev-plan.md`
 * §13.1 已记账），所以「事件用哪个 method 推」只能取规范里最直白的形状。两种可能性都兜住了：
 * 收到 `params` 本身是合法 `EventEnvelope`，或者 `params.event` 是合法 `EventEnvelope`，
 * 都进 `onEvent`；其余进 `onNotification`（不会丢，运行时装配时看一眼日志就知道该改成什么）。
 * 接上真实 host 后如果方法名不同，用 `eventNotificationMethod` 选项覆盖，不必改代码。
 */
export const EVENT_NOTIFICATION_METHOD = 'events/event';

/** 单次调用默认超时。与 tech-plan §12 的 p95 目标（90s 量级）留出余量，但不是任务级时间闸。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type RacpClientState = 'idle' | 'connecting' | 'open' | 'disconnected' | 'closed';

export interface RequestOptions {
  /** 本次调用的超时（毫秒）。不传就用客户端的 `defaultTimeoutMs`。 */
  readonly timeoutMs?: number;
  /** 调用方取消（任务级时间闸 / 用户中断）。已 abort 的 signal 会立即拒绝。 */
  readonly signal?: AbortSignal;
  /** 幂等键，写进 `params.context.idempotencyKey`（重试用同一个值，规范 §4.2）。 */
  readonly idempotencyKey?: string;
  /** 乐观并发：写进 `params.context.expectedRevision`。 */
  readonly expectedRevision?: number;
}

export interface RacpClientOptions {
  /** `PI_HOST_READY` 首行里的 port。 */
  readonly port: number;
  /** 默认 `127.0.0.1`。 */
  readonly host?: string;
  /** `ppt1.…`（引导期）或 `pdt1.…`。 */
  readonly token: string;
  /**
   * `PIN.json` 里的 `hostVersion`。给了就必须与 `connection/initialize` 协商出的
   * `server.version` 相等，否则抛 `HOST_VERSION_MISMATCH`（tech-plan §2.2 第 2 条）。
   */
  readonly expectedHostVersion?: string;
  /** `connection/initialize` 的 params 骨架。fixture 未 vendored，故默认 `{}`。 */
  readonly initializeParams?: unknown;
  readonly defaultTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly websocketFactory?: WebSocketFactory;
  readonly eventNotificationMethod?: string;
  /** 请求 id 生成器（测试可注入）；默认 1,2,3… */
  readonly idSequence?: JsonRpcIdSequence;
  /** `context.requestId` 生成器（测试可注入）；默认 `crypto.randomUUID()`。 */
  readonly requestIdFactory?: () => string;
  /** 本客户端标识，写进 initialize params 的 `client` 字段（若 Host 要）。 */
  readonly clientInfo?: { readonly name: string; readonly version: string };
}

export interface DisconnectInfo extends CloseInfo {
  /** 被拒绝的在飞调用数（>0 说明这次断线丢掉了未完成的请求，它们**不会**被重发）。 */
  readonly rejectedInFlight: number;
}

export interface NotificationEnvelope {
  readonly method: string;
  readonly params: unknown;
}

interface PendingCall {
  readonly method: string;
  readonly id: JsonRpcId;
  readonly startedAt: number;
  resolve(value: unknown): void;
  reject(error: RacpError): void;
  cleanup(): void;
}

/**
 * 一个连接一个客户端。
 *
 * 断线后可以再次 `connect()`：语义是「新 transport + 重新 initialize」，在飞调用**不重放**、
 * 订阅**不自动恢复**（调用方拿自己存的游标重新 `events/subscribe`）。这条边界写在
 * tech-plan §4.3 的第 3 步与 §1.1 第 3 条里——重放由游标表达，而不是由客户端猜。
 */
export class RacpClient {
  readonly #options: RacpClientOptions;
  readonly #idSequence: JsonRpcIdSequence;
  readonly #requestIdFactory: () => string;
  readonly #defaultTimeoutMs: number;
  readonly #eventMethod: string;

  #transport: RacpTransport | undefined;
  #state: RacpClientState = 'idle';
  #initializeResult: InitializeResult | undefined;
  readonly #inflight = new InFlightTable<PendingCall>();

  readonly #eventListeners = new Set<(event: EventEnvelope) => void>();
  readonly #notificationListeners = new Set<(notification: NotificationEnvelope) => void>();
  readonly #disconnectListeners = new Set<(info: DisconnectInfo) => void>();
  readonly #errorListeners = new Set<(error: RacpError) => void>();

  constructor(options: RacpClientOptions) {
    this.#options = options;
    // 端口/主机/令牌的校验在 transport 的构造函数里做，这里为了「配错就立刻炸」先建一个。
    this.#transport = new RacpTransport({
      port: options.port,
      host: options.host,
      token: options.token,
      websocketFactory: options.websocketFactory,
      handshakeTimeoutMs: options.handshakeTimeoutMs,
    });
    this.#idSequence = options.idSequence ?? new JsonRpcIdSequence();
    this.#requestIdFactory = options.requestIdFactory ?? (() => randomUUID());
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isInteger(this.#defaultTimeoutMs) || this.#defaultTimeoutMs < 1) {
      throw invalidArgumentError('defaultTimeoutMs 必须是 >=1 的整数', {
        defaultTimeoutMs: this.#defaultTimeoutMs,
      });
    }
    this.#eventMethod = options.eventNotificationMethod ?? EVENT_NOTIFICATION_METHOD;
    this.#attach(this.#transport);
  }

  get state(): RacpClientState {
    return this.#state;
  }

  /** 连接成功后 `connection/initialize` 的完整结果（未连接时为 `undefined`）。 */
  get initializeResult(): InitializeResult | undefined {
    return this.#initializeResult;
  }

  /** 协商出的 hostVersion（= `initializeResult.server.version`）。 */
  get hostVersion(): string | undefined {
    return this.#initializeResult?.server.version;
  }

  get connectionId(): string | undefined {
    return this.#initializeResult?.connectionId;
  }

  /** 当前在飞调用数（观测用；断线后必为 0）。 */
  get inFlightCount(): number {
    return this.#inflight.size;
  }

  /** 当前连接的 URL（日志/doctor 用；不含令牌）。 */
  get url(): string {
    return this.#transport?.url ?? '';
  }

  onEvent(listener: (event: EventEnvelope) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  onNotification(listener: (notification: NotificationEnvelope) => void): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  onDisconnect(listener: (info: DisconnectInfo) => void): () => void {
    this.#disconnectListeners.add(listener);
    return () => this.#disconnectListeners.delete(listener);
  }

  /** 连接级错误（发帧失败、帧读不动等）。**不**包含被拒绝的调用 —— 那些走各自 promise 的 reject。 */
  onError(listener: (error: RacpError) => void): () => void {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }

  /**
   * 建连 + `connection/initialize` + 版本比对。
   *
   * 失败时把客户端置为 `disconnected`（可再 `connect()`），已注册的监听器保留。
   */
  async connect(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<InitializeResult> {
    if (this.#state === 'open') return assertInitialized(this.#initializeResult);
    if (this.#state === 'connecting') throw invalidArgumentError('connect() 正在进行中，不要并发调用');
    if (this.#state === 'closed') throw closedError();

    const transport = this.#recreateTransportIfNeeded();
    this.#state = 'connecting';
    try {
      await transport.open();
      const params = this.#buildInitializeParams();
      const result = await this.request<unknown>('connection/initialize', params, {
        timeoutMs: options.timeoutMs ?? this.#defaultTimeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const initializeResult = assertWith(isInitializeResult, result, 'initializeResult');
      this.#checkProtocolVersion(initializeResult);
      this.#checkHostVersion(initializeResult);
      this.#initializeResult = initializeResult;
      this.#state = 'open';
      return initializeResult;
    } catch (error) {
      // 握手失败不留半开状态：transport 已经 closed，等下一次 connect() 新建一个。
      this.#state = 'disconnected';
      throw toRacpError(error, 'RACP 连接失败');
    }
  }

  /** 主动关闭。在飞调用以 `CLIENT_CLOSED` 拒绝（不是 `HOST_DISCONNECTED`：这次是我们自己关的）。 */
  async close(code = 1000, reason = 'client close'): Promise<void> {
    if (this.#state === 'closed') return;
    const transport = this.#transport;
    this.#state = 'closed';
    this.#rejectInFlight(() => closedError());
    await transport?.close(code, reason);
  }

  /**
   * 发一个请求并等响应。
   *
   * `params` 原样发送（不做形状猜测）；`context` 的装配在 `ops.ts`。这里只管配对与超时。
   */
  async request<T = unknown>(method: string, params?: unknown, options: RequestOptions = {}): Promise<T> {
    this.#ensureSendable(method);
    const transport = this.#transport;
    if (transport === undefined) throw notConnectedError();

    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw invalidArgumentError('timeoutMs 必须是 >=1 的整数', { timeoutMs, method });
    }
    const signal = options.signal;
    if (signal?.aborted === true) throw abortedError(signal.reason);

    const id = this.#idSequence.next();
    const frame = encodeRequest({ id, method, params });

    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        this.#inflight.take(id);
        finish(() => reject(timeoutError(method, timeoutMs)));
      }, timeoutMs);
      timeout.unref?.();

      const onAbort = (): void => {
        this.#inflight.take(id);
        finish(() => reject(abortedError(signal?.reason)));
      };
      const removeAbort = (): void => {
        signal?.removeEventListener('abort', onAbort);
      };
      const finish = (settle: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        removeAbort();
        settle();
      };

      const pending: PendingCall = {
        method,
        id,
        startedAt: Date.now(),
        resolve: (value) => finish(() => resolve(value as T)),
        reject: (error) => finish(() => reject(error)),
        cleanup: () => {
          clearTimeout(timeout);
          removeAbort();
        },
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      this.#inflight.set(id, pending);
      try {
        transport.send(frame);
      } catch (error) {
        this.#inflight.take(id);
        pending.cleanup();
        finish(() => reject(toRacpError(error, `发送 ${method} 失败`)));
      }
    });
  }

  /** `context` 的装配（`ops.ts` 与 `connect()` 共用）。 */
  createContext(options: RequestOptions = {}): RequestContext {
    return {
      requestId: this.#requestIdFactory(),
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
      ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
    };
  }

  // ── 内部 ───────────────────────────────────────────────────────────────

  #recreateTransportIfNeeded(): RacpTransport {
    const existing = this.#transport;
    if (existing !== undefined && existing.state !== 'closed') return existing;
    const transport = new RacpTransport({
      port: this.#options.port,
      host: this.#options.host,
      token: this.#options.token,
      websocketFactory: this.#options.websocketFactory,
      handshakeTimeoutMs: this.#options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    });
    this.#transport = transport;
    this.#attach(transport);
    return transport;
  }

  #attach(transport: RacpTransport): void {
    transport.onFrame((data, isBinary) => this.#handleFrame(data, isBinary));
    transport.onClose((info) => this.#handleClose(info));
    transport.onError((error) => this.#emitError(error));
  }

  /**
   * 状态闸。
   *
   * `connecting` 是**允许**发请求的：`connect()` 内部要先发 `connection/initialize`，
   * 那一刻状态还没变成 `open`。真正的「连上了吗」由 transport 判（未 open 就 `NOT_CONNECTED`），
   * 这里只管「客户端被关掉/还没连过」这两种调用方错误。
   */
  #ensureSendable(method: string): void {
    switch (this.#state) {
      case 'open':
      case 'connecting':
        return;
      case 'closed':
        throw closedError();
      case 'idle':
      case 'disconnected':
        throw notConnectedError(`${method} 需要先 connect()（当前状态 ${this.#state}）`, {
          method,
          state: this.#state,
        });
    }
  }

  #handleFrame(data: unknown, isBinary: boolean): void {
    let frame: JsonRpcIncomingFrame;
    try {
      frame = decodeIncomingFrame(data, isBinary);
    } catch (error) {
      const racpError = toRacpError(error, '帧解码失败');
      // binary 帧 / 形状错误都不该让整条连接静默继续：报给 onError，调用方决定是否断开。
      this.#emitError(racpError);
      return;
    }

    if (isNotificationFrame(frame)) {
      this.#dispatchNotification(frame);
      return;
    }
    this.#dispatchResponse(frame);
  }

  #dispatchResponse(frame: JsonRpcResponseFrame): void {
    // 连 id 都没有的错误（parse error / invalid request）：没有在飞调用能接住它。
    // 成功响应的 id 一定是字符串或数字（解码层保证了这一点），所以 `id === null` 只可能是错误。
    if (isErrorFrame(frame) && frame.id === null) {
      this.#emitError(fromJsonRpcError(frame.error));
      return;
    }
    if (frame.id === null) return;
    const pending = this.#inflight.take(frame.id);
    if (pending === undefined) {
      // 迟到的响应（通常是超时之后才回）。**丢弃**，不进 onError，避免把正常超时刷成错误噪音。
      return;
    }
    pending.cleanup();
    if (isErrorFrame(frame)) {
      pending.reject(fromJsonRpcError(frame.error));
      return;
    }
    pending.resolve(frame.result);
  }

  #dispatchNotification(frame: JsonRpcNotificationFrame): void {
    if (frame.method === this.#eventMethod) {
      const params = frame.params;
      const candidate =
        typeof params === 'object' && params !== null && 'event' in params
          ? (params as { event: unknown }).event
          : params;
      if (isEventEnvelope(candidate)) {
        for (const listener of this.#eventListeners) {
          safely(`client.onEvent(${frame.method})`, () => listener(candidate));
        }
        return;
      }
      // 事件方法名对上了但载荷不是 EventEnvelope：照样交给通知通道，别让事件消失。
    }
    const envelope: NotificationEnvelope = { method: frame.method, params: frame.params };
    for (const listener of this.#notificationListeners) {
      safely(`client.onNotification(${frame.method})`, () => listener(envelope));
    }
  }

  #handleClose(info: CloseInfo): void {
    if (this.#state === 'closed') return;
    const wasOpen = this.#state === 'open';
    this.#state = info.initiatedByClient ? 'closed' : 'disconnected';
    const rejected = this.#rejectInFlight((pending) =>
      disconnectedError(
        {
          url: this.#transport?.url,
          code: info.code,
          reason: previewRedacted(info.reason),
          method: pending.method,
          id: idKey(pending.id),
          startedAt: pending.startedAt,
        },
        undefined,
      ),
    );
    if (!wasOpen) return;
    const disconnectInfo: DisconnectInfo = { ...info, rejectedInFlight: rejected };
    for (const listener of this.#disconnectListeners) {
      safely('client.onDisconnect', () => listener(disconnectInfo));
    }
  }

  /** 排空在飞表并逐个拒绝；返回拒绝个数。断线路径的**唯一**实现（不重发，见类注释第 2 条）。 */
  #rejectInFlight(makeError: (pending: PendingCall) => RacpError): number {
    const drained = this.#inflight.drain();
    for (const { entry } of drained) {
      entry.cleanup();
      entry.reject(makeError(entry));
    }
    return drained.length;
  }

  #emitError(error: RacpError): void {
    for (const listener of this.#errorListeners) {
      safely('client.onError', () => listener(error));
    }
  }

  #buildInitializeParams(): unknown {
    if (this.#options.initializeParams !== undefined) return this.#options.initializeParams;
    const params: Record<string, unknown> = { protocolVersion: RACP_PROTOCOL_VERSION };
    if (this.#options.clientInfo !== undefined) params.client = this.#options.clientInfo;
    return params;
  }

  #checkProtocolVersion(result: InitializeResult): void {
    if (result.protocolVersion !== RACP_PROTOCOL_VERSION) {
      throw protocolMismatchError(
        `协议版本不符：期望 ${RACP_PROTOCOL_VERSION}，协商得到 ${result.protocolVersion}`,
        { expected: RACP_PROTOCOL_VERSION, negotiated: result.protocolVersion },
      );
    }
  }

  #checkHostVersion(result: InitializeResult): void {
    const expected = this.#options.expectedHostVersion;
    if (expected === undefined) return;
    const actual = result.server.version;
    if (actual !== expected) throw hostVersionMismatchError(expected, actual);
  }
}

function assertInitialized(result: InitializeResult | undefined): InitializeResult {
  if (result === undefined) throw notConnectedError();
  return result;
}

/** 监听器异常不打断派发（一个坏监听器不该让后面的监听器收不到事件）。 */
function safely(where: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    process.stderr.write(
      `[racp-client] ${where} 监听器抛出异常：${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}
