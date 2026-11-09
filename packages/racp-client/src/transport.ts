/**
 * RACP-WS 传输层：URL / 子协议 / Bearer 三个握手常量 + 连接生命周期（tech-plan §4.2）。
 *
 * 这一层的职责只有一个：**把三个字面量写对，并且在该失败的时候明确失败**。
 *
 * tech-plan §4.2 的原话是「缺子协议、错路径、非 loopback 绑定、binary frame 这四种一律被拒——
 * 它们是 Host 的前置拒绝，不是我们的策略选择」，所以本层不做任何「换个姿势再试一次」的
 * 兜底：非 loopback、缺 Bearer、端口非法在**本地**就抛（`INVALID_ARGUMENT`），
 * 子协议/协议版本不符抛 `PROTOCOL_MISMATCH`，连接被拒抛 `HOST_DISCONNECTED`（可重试，
 * 交给 `apps/server/src/runtime` 的退避重启，而不是本层自己重试）。
 *
 * 三个常量在这里导出，供 `doctor` / `PIN.json` 校验复用（tech-plan §2.2 第 5 条）。
 */

import { WebSocket as WsWebSocket } from 'ws';
import {
  closedError,
  disconnectedError,
  handshakeRejectedError,
  handshakeTimeoutError,
  invalidArgumentError,
  notConnectedError,
  protocolMismatchError,
  RacpError,
} from './errors.ts';
import { previewRedacted } from './redact.ts';

// ── 握手常量（tech-plan §4.2 的表格，逐字照抄，不许改成「见规范 §x」） ─────────

/** RACP 的 WS 路径。Host 侧 `/v1/racp/ws` 之外一律 404。 */
export const RACP_WS_PATH = '/v1/racp/ws';

/** `Sec-WebSocket-Protocol` 的值。Host 侧 `handleProtocols` 只接受这一个值。 */
export const RACP_WS_SUBPROTOCOL = 'pi-racp.v1.jsonrpc';

/**
 * 允许的主机。
 *
 * 只列 Host 真会绑的地址：`PI_HOST_BIND` 默认 `127.0.0.1`，非 loopback 会被 pi-host 直接拒绝。
 * `localhost` 放进来是因为引导脚本里人可能这么写；`127.0.0.2` 一类别名**不**放行 ——
 * 它们是 loopback 但不是 Host 的绑定地址，放行只会把「连不上」伪装成「连上了」。
 */
export const RACP_LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'] as const;

export type RacpLoopbackHost = (typeof RACP_LOOPBACK_HOSTS)[number];

export const DEFAULT_RACP_HOST: RacpLoopbackHost = '127.0.0.1';

/** 握手超时默认值。比单次调用超时短：握手卡住说明 Host 根本没起来，没必要等业务超时。 */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/** 引导期令牌前缀（`--pair` 打印出来的那一行）。 */
export const PAIRING_TOKEN_PREFIX = 'ppt1.';

/** 设备令牌前缀（`connection/pair` 换回来的长期凭证）。 */
export const DEVICE_TOKEN_PREFIX = 'pdt1.';

// ── 最小 WebSocket 抽象（可注入，测试用假实现） ──────────────────────────────

/**
 * `ws` 的 `WebSocket` 里我们真用到的那一部分。
 *
 * 为什么不直接用 `ws` 的类型：`transport` 的失败路径（握手被拒、子协议选错、binary 帧）
 * 必须能用**假实现**精确复现，而不是靠「造一个真服务器让它出错」。真 `WebSocket` 结构性满足
 * 本接口（`defaultWebSocketFactory` 会做类型检查）。
 */
export interface WebSocketLike {
  readonly readyState: number;
  /** 握手协商出的子协议；Host 没选就等于空串。 */
  readonly protocol?: string;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close', listener: (code: number, reason: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface WebSocketHandshakeOptions {
  /** 小写与否都行：`ws` 原样写进请求头。 */
  readonly headers: Readonly<Record<string, string>>;
  readonly protocols: readonly string[];
}

export type WebSocketFactory = (url: string, options: WebSocketHandshakeOptions) => WebSocketLike;

/**
 * 默认工厂：真的连。
 *
 * `protocols` 走构造参数（`new WebSocket(url, protocols, options)`），`Authorization` 走
 * `headers`——这是 `ws` 支持的两种写法里语义最直白的一种。
 */
export const defaultWebSocketFactory: WebSocketFactory = (url, options) =>
  new WsWebSocket(url, [...options.protocols], {
    headers: { ...options.headers },
  });

// ── 握手常量的校验与拼装（doctor / bootstrap-host 会直接调用这几个） ─────────

/** 端口必须是 1..65535 的整数。`--port 0`（随机）由 Host 打印出来，不归我们挑。 */
export function assertRacpPort(port: unknown): number {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw invalidArgumentError('port 必须是 1..65535 的整数（取 PI_HOST_READY 首行里的 port）', {
      port: previewRedacted(port),
    });
  }
  return port;
}

/** 主机必须是 `RACP_LOOPBACK_HOSTS` 之一（大小写不敏感，`[::1]` 的方括号会被去掉）。 */
export function assertLoopbackHost(host: unknown): RacpLoopbackHost {
  if (typeof host !== 'string') {
    throw invalidArgumentError('host 必须是字符串（默认 127.0.0.1）', { host: previewRedacted(host) });
  }
  const normalized = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  const match = RACP_LOOPBACK_HOSTS.find((candidate) => candidate === normalized);
  if (match === undefined) {
    throw invalidArgumentError(
      `连 pi-host 只能用 loopback（${RACP_LOOPBACK_HOSTS.join(' / ')}），收到 ${JSON.stringify(host)}：` +
        '非 loopback 绑定在 pi-host 侧会被直接拒绝（tech-plan §4.2）',
      { host, allowed: RACP_LOOPBACK_HOSTS },
    );
  }
  return match;
}

/**
 * 令牌必须是 `ppt1.` 或 `pdt1.` 开头且后面非空。
 *
 * 为什么在本地严格校验前缀：`Authorization: Bearer ` 少一个字符，Host 只会回一个 401，
 * 而 401 在日志里长得和「令牌被吊销」一模一样，排查会绕远路。前缀错了是我们自己的 bug。
 */
export function assertBearerToken(token: unknown): string {
  if (typeof token !== 'string' || token.length === 0) {
    throw invalidArgumentError(
      '缺少 pi-host 令牌：Authorization 需要 `Bearer <ppt1.…|pdt1.…>`（tech-plan §4.2）',
      { tokenPresent: typeof token === 'string' },
    );
  }
  const trimmed = token.trim();
  if (!trimmed.startsWith(PAIRING_TOKEN_PREFIX) && !trimmed.startsWith(DEVICE_TOKEN_PREFIX)) {
    throw invalidArgumentError(
      `令牌前缀必须 ${PAIRING_TOKEN_PREFIX} 或 ${DEVICE_TOKEN_PREFIX}（引导期用配对令牌，之后用设备令牌）`,
      // 只报前缀，不报令牌体（tech-plan §10.2）。
      { prefix: trimmed.slice(0, 5) },
    );
  }
  if (trimmed.length <= (trimmed.startsWith(PAIRING_TOKEN_PREFIX) ? PAIRING_TOKEN_PREFIX.length : DEVICE_TOKEN_PREFIX.length)) {
    throw invalidArgumentError('令牌只有前缀、没有令牌体', { prefix: trimmed });
  }
  return trimmed;
}

/** `ws://<host>:<port>/v1/racp/ws`，IPv6 用方括号。 */
export function buildRacpUrl(port: number, host: string = DEFAULT_RACP_HOST): string {
  const safePort = assertRacpPort(port);
  const safeHost = assertLoopbackHost(host);
  const hostPart = safeHost.includes(':') ? `[${safeHost}]` : safeHost;
  return `ws://${hostPart}:${safePort}${RACP_WS_PATH}`;
}

/** `Authorization` 头的值。单独抽出来是为了让测试能直接比对字面量。 */
export function buildAuthorizationHeader(token: string): string {
  return `Bearer ${assertBearerToken(token)}`;
}

// ── 连接 ────────────────────────────────────────────────────────────────

export type TransportState = 'idle' | 'connecting' | 'open' | 'closed';

export interface CloseInfo {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
  /** `true` = 我们调的 `close()`；`false` = Host 掉线 / 网络断（客户端据此决定要不要重连）。 */
  readonly initiatedByClient: boolean;
}

export interface RacpTransportOptions {
  /** `PI_HOST_READY` 首行里的 port。 */
  readonly port: number;
  /** 默认 `127.0.0.1`；非 loopback 直接抛 `INVALID_ARGUMENT`。 */
  readonly host?: string;
  /** `ppt1.…`（引导期）或 `pdt1.…`（日常）。 */
  readonly token: string;
  /** 测试注入点；默认 `ws`。 */
  readonly websocketFactory?: WebSocketFactory;
  readonly handshakeTimeoutMs?: number;
}

type FrameListener = (data: unknown, isBinary: boolean) => void;
type CloseListener = (info: CloseInfo) => void;
type ErrorListener = (error: RacpError) => void;

interface HandshakeWaiter {
  readonly resolve: () => void;
  readonly reject: (error: RacpError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * 一条 WS 连接。
 *
 * 生命周期：`idle → connecting → open → closed`。`closed` 之后不可重开（重连请新建实例，
 * 由 `RacpClient` 负责把「重连」翻译成「新 transport + 重新 initialize + 按游标重订阅」）。
 */
export class RacpTransport {
  readonly url: string;
  readonly host: RacpLoopbackHost;
  readonly port: number;

  readonly #token: string;
  readonly #factory: WebSocketFactory;
  readonly #handshakeTimeoutMs: number;

  #socket: WebSocketLike | undefined;
  #state: TransportState = 'idle';
  #clientClosed = false;
  #handshake: HandshakeWaiter | undefined;
  #closeNotified = false;

  readonly #frameListeners = new Set<FrameListener>();
  readonly #closeListeners = new Set<CloseListener>();
  readonly #errorListeners = new Set<ErrorListener>();

  constructor(options: RacpTransportOptions) {
    this.port = assertRacpPort(options.port);
    this.host = assertLoopbackHost(options.host ?? DEFAULT_RACP_HOST);
    this.#token = assertBearerToken(options.token);
    this.#factory = options.websocketFactory ?? defaultWebSocketFactory;
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    if (!Number.isInteger(this.#handshakeTimeoutMs) || this.#handshakeTimeoutMs < 1) {
      throw invalidArgumentError('handshakeTimeoutMs 必须是 >=1 的整数', {
        handshakeTimeoutMs: this.#handshakeTimeoutMs,
      });
    }
    this.url = buildRacpUrl(this.port, this.host);
  }

  get state(): TransportState {
    return this.#state;
  }

  /** 握手协商出的子协议（连接未建立时为 `undefined`）。 */
  get negotiatedProtocol(): string | undefined {
    return this.#socket?.protocol;
  }

  onFrame(listener: FrameListener): () => void {
    this.#frameListeners.add(listener);
    return () => this.#frameListeners.delete(listener);
  }

  onClose(listener: CloseListener): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  onError(listener: ErrorListener): () => void {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }

  /** 建立连接。失败时抛分类化的 `RacpError`，并把自己置为 `closed`（不可重试，新建实例）。 */
  async open(): Promise<void> {
    if (this.#state === 'open') return;
    if (this.#state === 'connecting') throw invalidArgumentError('open() 正在等待握手，不要重复调用');
    if (this.#state === 'closed') {
      throw this.#clientClosed ? closedError() : disconnectedError({ url: this.url });
    }

    this.#state = 'connecting';
    const socket = this.#createSocket();
    this.#socket = socket;
    this.#attach(socket);

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const waiter = this.#handshake;
          this.#handshake = undefined;
          waiter?.reject(handshakeTimeoutError(this.url, this.#handshakeTimeoutMs));
        }, this.#handshakeTimeoutMs);
        // 不要让一个待握手连接把进程钉住（脚本/测试里尤其重要）。
        timer.unref?.();
        this.#handshake = { resolve, reject, timer };
      });
    } catch (error) {
      // 握手失败：不留半开状态。socket 由 Host 侧的错误/关闭事件收尾，这里只封状态。
      this.#state = 'closed';
      throw error;
    }
  }

  /** 发一帧文本。连接未建立 / 已关一律显式失败（不排队、不缓存）。 */
  send(text: string): void {
    const socket = this.#socket;
    if (socket === undefined) throw notConnectedError();
    if (this.#state === 'closed') {
      throw this.#clientClosed ? closedError() : disconnectedError({ url: this.url });
    }
    if (this.#state !== 'open') throw notConnectedError();
    try {
      socket.send(text, (error) => {
        if (error) this.#emitError(toTransportError(error, this.url));
      });
    } catch (error) {
      throw toTransportError(error, this.url);
    }
  }

  /** 主动关闭。幂等；等 close 事件（最多 1s，之后 `terminate`）。 */
  async close(code = 1000, reason = 'client close'): Promise<void> {
    this.#clientClosed = true;
    const socket = this.#socket;
    if (socket === undefined || this.#state === 'closed') {
      this.#state = 'closed';
      return;
    }
    this.#state = 'closed';
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          socket.terminate?.();
        } catch {
          // terminate 只是兜底，失败无所谓。
        }
        finish();
      }, 1_000);
      timer.unref?.();
      socket.on('close', () => finish());
      try {
        socket.close(code, reason);
      } catch {
        finish();
      }
    });
  }

  #createSocket(): WebSocketLike {
    try {
      return this.#factory(this.url, {
        headers: { Authorization: buildAuthorizationHeader(this.#token) },
        protocols: [RACP_WS_SUBPROTOCOL],
      });
    } catch (error) {
      this.#state = 'closed';
      throw handshakeRejectedError(
        `创建 WebSocket 失败：${error instanceof Error ? error.message : String(error)}`,
        error,
        { url: this.url },
      );
    }
  }

  #attach(socket: WebSocketLike): void {
    socket.on('open', () => this.#handleOpen(socket));
    socket.on('message', (data, isBinary) => this.#emitFrame(data, isBinary === true));
    socket.on('error', (error) => this.#handleSocketError(error));
    socket.on('close', (code, reason) => this.#handleClose(code, reason));
  }

  #handleOpen(socket: WebSocketLike): void {
    const waiter = this.#takeHandshake();
    const negotiated = socket.protocol ?? '';
    if (negotiated !== RACP_WS_SUBPROTOCOL) {
      const error = protocolMismatchError(
        `Host 没有选中 RACP 子协议：期望 ${RACP_WS_SUBPROTOCOL}，协商得到 ${JSON.stringify(negotiated)}（Host 侧 handleProtocols 只接受那一个值）`,
        { url: this.url, expected: RACP_WS_SUBPROTOCOL, negotiated },
      );
      this.#state = 'closed';
      try {
        socket.close(1002, 'subprotocol mismatch');
      } catch {
        // 已经关了就算了。
      }
      waiter?.reject(error);
      return;
    }
    this.#state = 'open';
    waiter?.resolve();
  }

  #handleSocketError(error: Error): void {
    const mapped = toTransportError(error, this.url);
    const waiter = this.#takeHandshake();
    if (waiter !== undefined) {
      waiter.reject(mapped);
      return;
    }
    this.#emitError(mapped);
  }

  #handleClose(code: number, reason: unknown): void {
    // `previous` 可能是 `closed`：`close()` 先把状态置为 closed 再等 socket 的 close 事件，
    // 那种情况下仍要通知监听器（否则「谁关的」这条信息就丢了）。去重由 `#closeNotified` 负责。
    const previous = this.#state;
    this.#state = 'closed';
    this.#takeHandshake()?.reject(
      handshakeRejectedError('WS 连接在握手完成前被关闭（Host 拒绝了 upgrade？）', undefined, {
        url: this.url,
        code,
        reason: previewRedacted(reasonText(reason)),
      }),
    );
    if (previous === 'idle') return;
    if (this.#closeNotified) return;
    this.#closeNotified = true;
    const info: CloseInfo = {
      code,
      reason: reasonText(reason),
      // 1000/1001 算正常关闭；其余（含 1006 异常断开）都是不要脸地消失。
      wasClean: code === 1000 || code === 1001,
      initiatedByClient: this.#clientClosed,
    };
    for (const listener of this.#closeListeners) {
      guardListener('transport.onClose', () => listener(info));
    }
  }

  #takeHandshake(): HandshakeWaiter | undefined {
    const waiter = this.#handshake;
    if (waiter === undefined) return undefined;
    this.#handshake = undefined;
    clearTimeout(waiter.timer);
    return waiter;
  }

  #emitFrame(data: unknown, isBinary: boolean): void {
    for (const listener of this.#frameListeners) {
      guardListener('transport.onFrame', () => listener(data, isBinary));
    }
  }

  #emitError(error: RacpError): void {
    for (const listener of this.#errorListeners) {
      guardListener('transport.onError', () => listener(error));
    }
  }
}

function reasonText(reason: unknown): string {
  if (typeof reason === 'string') return reason;
  if (reason instanceof Uint8Array) return Buffer.from(reason).toString('utf8');
  if (reason === undefined || reason === null) return '';
  return String(reason);
}

/**
 * 监听器异常不能打死连接：一个 throw 会污染 `ws` 的事件派发，把整条连接带崩。
 * 这里吞掉并打到 stderr（`logger` 由 `@pi-issue-bot/shared` 提供，本包不引 logger）。
 */
function guardListener(where: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    process.stderr.write(
      `[racp-client] ${where} 监听器抛出异常：${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

/**
 * socket 错误 → `RacpError`。
 *
 * `ws` 在握手被拒时给的是一个字符串错误（`Unexpected server response: 401`），HTTP 状态码是
 * 唯一可用的线索。401/403 折成规范里已有的 `UNAUTHORIZED` / `FORBIDDEN`（这两个码的
 * `failureClass` 是 `auth`，上层据此判定「令牌不对，别急着重试」），400 说明
 * 子协议/路径被拒，其余归 `HANDSHAKE_REJECTED`；纯网络层错误归可重试的 `HOST_DISCONNECTED`。
 */
export function toTransportError(error: unknown, url: string): RacpError {
  if (error instanceof RacpError) return error;
  const raw = error instanceof Error ? error.message : String(error);
  const details = { url, raw: previewRedacted(raw) };

  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up/i.test(raw)) {
    return disconnectedError(details, error);
  }
  const status = /Unexpected server response:\s*(\d{3})/.exec(raw)?.[1];
  if (status === '401') {
    return new RacpError({
      code: 'UNAUTHORIZED',
      message: 'Host 拒绝了握手：Authorization 令牌无效或已过期（401，需要重新 bootstrap-host --repair）',
      details,
      cause: error,
      kind: 'transport',
    });
  }
  if (status === '403') {
    return new RacpError({
      code: 'FORBIDDEN',
      message: 'Host 拒绝了握手：令牌有效但权限不足（403）',
      details,
      cause: error,
      kind: 'transport',
    });
  }
  // `ws` 客户端在「Host 没选中我们提供的子协议」时给的是这两句：
  // `Server sent no subprotocol` / `Server sent an invalid subprotocol`。
  if (/no subprotocol|invalid subprotocol/i.test(raw)) {
    return protocolMismatchError(
      `Host 没有选中 RACP 子协议 ${RACP_WS_SUBPROTOCOL}（Host 侧 handleProtocols 只接受那一个值，tech-plan §4.2）`,
      details,
    );
  }
  if (status === '400') {
    return protocolMismatchError(
      'Host 拒绝了握手（400）：路径或 Sec-WebSocket-Protocol 与 Host 的绑定不一致（tech-plan §4.2）',
      details,
    );
  }
  return handshakeRejectedError(`WS 连接失败：${raw}`, error, details);
}
