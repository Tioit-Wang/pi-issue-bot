/**
 * JSON-RPC 2.0 帧层（tech-plan §4.4 / §2.2 自研项 S1 的「手写帧层」那一半）。
 *
 * 边界：
 * - 只做**编解码 + 形状校验 + id/在飞表**。谁发请求、超时多久、断线怎么办，都在 `client.ts`。
 * - **只接受文本帧**。binary 帧一律拒绝并抛 `BINARY_FRAME`（ADR 0285 §3 的四条前置拒绝之一；
 *   这不是「尽力解析」的场景，对端违约就该在帧层被拦下，而不是让它变成一个形状怪异的对象）。
 * - Host 发来的「带 id 的请求」（JSON-RPC 的 server→client request）**不支持**：本客户端不声明
 *   `capabilities.serverRequests`（tech-plan §4.4 的 operation 白名单里没有需要反向请求的项），
 *   遇到就抛 `PROTOCOL_ERROR` 并把原文附在 `details` 里 —— 静默忽略会让对端一直等一个永不到来的响应。
 */

import { binaryFrameError, protocolError } from './errors.ts';
import { previewRedacted } from './redact.ts';

export const JSONRPC_VERSION = '2.0';

export type JsonRpcId = string | number;

/** 客户端发出的请求帧。 */
export interface JsonRpcRequestFrame {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

/** 通知帧：没有 id，不需要响应。 */
export interface JsonRpcNotificationFrame {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly method: string;
  readonly params?: unknown;
}

/** 成功响应。 */
export interface JsonRpcSuccessFrame {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: JsonRpcId;
  readonly result: unknown;
}

/** 错误对象（规范 §14a：语义载荷在 `data`，数字码只用来兜底）。 */
export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** 错误响应。`id` 可以是 `null`（连 id 都没解析出来时，例如 parse error）。 */
export interface JsonRpcErrorFrame {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: JsonRpcId | null;
  readonly error: JsonRpcErrorObject;
}

export type JsonRpcResponseFrame = JsonRpcSuccessFrame | JsonRpcErrorFrame;

/** 从对端读进来的帧：要么是响应，要么是通知。 */
export type JsonRpcIncomingFrame = JsonRpcResponseFrame | JsonRpcNotificationFrame;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is JsonRpcId =>
  (typeof value === 'string' && value.length > 0) ||
  (typeof value === 'number' && Number.isFinite(value));

/** 响应帧（有 `id`、没有 `method`）。 */
export function isResponseFrame(frame: JsonRpcIncomingFrame): frame is JsonRpcResponseFrame {
  return !('method' in frame);
}

/** 通知帧（有 `method`）。 */
export function isNotificationFrame(frame: JsonRpcIncomingFrame): frame is JsonRpcNotificationFrame {
  return 'method' in frame;
}

export function isErrorFrame(frame: JsonRpcResponseFrame): frame is JsonRpcErrorFrame {
  return 'error' in frame;
}

/**
 * `id` → 在飞表的键。
 *
 * 为什么不是直接用 `id`：JSON-RPC 允许 number 和 string 两种 id，`1` 与 `"1"` 在 Map 里
 * 是两个键，但线上完全可能被对端回成另一个类型。归一化后 `1` 与 `"1"` 都能命中同一条在飞记录，
 * 又不至于把 `"n:1"` 这种字符串 id 和数字 1 混淆。
 */
export function idKey(id: JsonRpcId): string {
  return typeof id === 'number' ? `n:${id}` : `s:${id}`;
}

// ── 编码 ────────────────────────────────────────────────────────────────

function stringify(frame: Record<string, unknown>, what: string): string {
  try {
    return JSON.stringify(frame);
  } catch (error) {
    // 典型原因：params 里有循环引用或 BigInt。这是我们自己的问题，按参数错误抛出。
    throw protocolError(`${what} 无法序列化为 JSON（params 里有循环引用或不可序列化的值？）`, {
      cause: previewRedacted(error instanceof Error ? error.message : error),
    });
  }
}

export function encodeRequest(request: {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}): string {
  if (!isId(request.id)) throw protocolError('请求 id 必须是非空字符串或有限数字', { id: request.id });
  if (typeof request.method !== 'string' || request.method.length === 0) {
    throw protocolError('请求 method 必须是非空字符串', { method: request.method });
  }
  const frame: Record<string, unknown> = {
    jsonrpc: JSONRPC_VERSION,
    id: request.id,
    method: request.method,
  };
  if (request.params !== undefined) frame.params = request.params;
  return stringify(frame, `请求 ${request.method}`);
}

export function encodeNotification(notification: { method: string; params?: unknown }): string {
  if (typeof notification.method !== 'string' || notification.method.length === 0) {
    throw protocolError('通知 method 必须是非空字符串', { method: notification.method });
  }
  const frame: Record<string, unknown> = { jsonrpc: JSONRPC_VERSION, method: notification.method };
  if (notification.params !== undefined) frame.params = notification.params;
  return stringify(frame, `通知 ${notification.method}`);
}

export function encodeSuccess(response: { id: JsonRpcId; result: unknown }): string {
  return stringify(
    { jsonrpc: JSONRPC_VERSION, id: response.id, result: response.result ?? null },
    '成功响应',
  );
}

export function encodeError(response: { id: JsonRpcId | null; error: JsonRpcErrorObject }): string {
  return stringify(
    {
      jsonrpc: JSONRPC_VERSION,
      id: response.id,
      error: {
        code: response.error.code,
        message: response.error.message,
        ...(response.error.data === undefined ? {} : { data: response.error.data }),
      },
    },
    '错误响应',
  );
}

// ── 解码 ────────────────────────────────────────────────────────────────

/**
 * 把 `ws` 给出的 payload 转成文本。
 *
 * `ws` 的 message 事件给的是 `Buffer | ArrayBuffer | Buffer[]`（Node 侧几乎是 Buffer），
 * 所以这里按「可能拿到的三种」都处理；不做编码猜测，RACP 规定 UTF-8 文本帧。
 */
function payloadToText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload instanceof ArrayBuffer) return Buffer.from(payload).toString('utf8');
  if (ArrayBuffer.isView(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('utf8');
  }
  if (Array.isArray(payload)) {
    const buffers = payload.filter((part): part is Uint8Array => part instanceof Uint8Array);
    if (buffers.length === payload.length) return Buffer.concat(buffers).toString('utf8');
  }
  throw protocolError('无法读取的帧载荷类型（既不是字符串也不是字节）', {
    receivedType: typeof payload,
  });
}

/**
 * 解码一帧。
 *
 * @param payload `ws` 的 message 载荷
 * @param isBinary `ws` 的 isBinary 标志（`true` 一定拒绝）
 *
 * 形状错误一律 `PROTOCOL_ERROR`，binary 帧一律 `BINARY_FRAME` —— 两者都带「分类」，上层
 * 不需要再猜是哪种失败（`RacpError.kind` + `failureClass`）。
 */
export function decodeIncomingFrame(payload: unknown, isBinary: boolean): JsonRpcIncomingFrame {
  if (isBinary) {
    throw binaryFrameError({ payloadBytes: payloadByteLength(payload) });
  }
  const text = payloadToText(payload);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw protocolError('帧不是合法 JSON', {
      preview: previewRedacted(text, 200),
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return assertFrame(parsed);
}

function payloadByteLength(payload: unknown): number | undefined {
  if (payload instanceof ArrayBuffer) return payload.byteLength;
  if (ArrayBuffer.isView(payload)) return payload.byteLength;
  if (Array.isArray(payload)) return payload.length;
  return undefined;
}

/** 严格形状校验（多字段放过，缺字段/类型错就抛 —— 与 `schema.ts` 的宽松策略一致）。 */
function assertFrame(value: unknown): JsonRpcIncomingFrame {
  if (!isRecord(value)) {
    throw protocolError('帧不是 JSON 对象', { preview: previewRedacted(value) });
  }
  if (value.jsonrpc !== JSONRPC_VERSION) {
    throw protocolError('帧缺少 `jsonrpc: "2.0"`', {
      received: previewRedacted(value.jsonrpc),
    });
  }

  const hasMethod = Object.hasOwn(value, 'method');
  const hasResult = Object.hasOwn(value, 'result');
  const hasError = Object.hasOwn(value, 'error');
  const hasId = Object.hasOwn(value, 'id');

  if (hasMethod) {
    if (typeof value.method !== 'string' || value.method.length === 0) {
      throw protocolError('通知的 `method` 必须是非空字符串', { received: previewRedacted(value.method) });
    }
    if (hasId) {
      throw protocolError(
        'Host 发来了带 id 的请求（server→client request）：本客户端不声明 serverRequests 能力，不支持反向请求',
        { method: value.method, id: previewRedacted(value.id) },
      );
    }
    if (hasResult || hasError) {
      throw protocolError('通知帧不得同时带 `result` / `error`', { method: value.method });
    }
    return value.params === undefined
      ? { jsonrpc: JSONRPC_VERSION, method: value.method }
      : { jsonrpc: JSONRPC_VERSION, method: value.method, params: value.params };
  }

  if (hasResult && hasError) {
    throw protocolError('响应帧不得同时带 `result` 与 `error`', { id: previewRedacted(value.id) });
  }
  if (!hasResult && !hasError) {
    throw protocolError('帧既不是请求/通知，也不是响应（缺 `method` 与 `result`/`error`）', {
      preview: previewRedacted(value),
    });
  }

  if (hasError) {
    const id = value.id;
    if (id !== null && !isId(id)) {
      throw protocolError('错误响应的 `id` 必须是字符串、数字或 null', { received: previewRedacted(id) });
    }
    const error = value.error;
    if (!isRecord(error)) throw protocolError('错误响应的 `error` 必须是对象', { preview: previewRedacted(error) });
    const code = error.code;
    if (typeof code !== 'number' || !Number.isInteger(code)) {
      throw protocolError('错误响应的 `error.code` 必须是整数', { received: previewRedacted(code) });
    }
    const message = error.message;
    if (typeof message !== 'string') {
      throw protocolError('错误响应的 `error.message` 必须是字符串', { received: previewRedacted(message) });
    }
    return {
      jsonrpc: JSONRPC_VERSION,
      id,
      error: {
        code,
        message,
        ...(error.data === undefined ? {} : { data: error.data }),
      },
    };
  }

  if (!isId(value.id)) {
    throw protocolError('成功响应的 `id` 必须是非空字符串或有限数字', {
      received: previewRedacted(value.id),
    });
  }
  return { jsonrpc: JSONRPC_VERSION, id: value.id, result: value.result };
}

// ── id 生成与在飞表 ──────────────────────────────────────────────────────

/**
 * 单调递增的请求 id。
 *
 * 为什么用数字而不是 uuid：JSON-RPC 的 id 只要求「在本连接内唯一」，数字可读、日志短，
 * 排查时能直接按顺序比对。跨连接复用同一个客户端时会拿到新的序列，不做持久化。
 */
export class JsonRpcIdSequence {
  #next: number;

  constructor(start = 1) {
    this.#next = start;
  }

  next(): number {
    const id = this.#next;
    this.#next += 1;
    return id;
  }
}

/**
 * 在飞调用表。
 *
 * 单独一个类而不是散在 client 里的 Map：**「断线时在飞调用一律拒绝且不重发」**这条要求
 * 需要有唯一一处「把整张表排空」的语义，`drain()` 就是它。
 */
export class InFlightTable<T> {
  readonly #entries = new Map<string, T>();

  get size(): number {
    return this.#entries.size;
  }

  set(id: JsonRpcId, entry: T): void {
    const key = idKey(id);
    if (this.#entries.has(key)) {
      throw protocolError('请求 id 冲突：同一个 id 已在在飞表中', { id, key });
    }
    this.#entries.set(key, entry);
  }

  get(id: JsonRpcId): T | undefined {
    return this.#entries.get(idKey(id));
  }

  /** 取出并删除（响应到达时用：一个 id 只会被消费一次）。 */
  take(id: JsonRpcId): T | undefined {
    const key = idKey(id);
    const entry = this.#entries.get(key);
    if (entry !== undefined) this.#entries.delete(key);
    return entry;
  }

  /** 排空：断线时把所有在飞调用交给调用方逐个拒绝，之后表为空。 */
  drain(): Array<{ id: string; entry: T }> {
    const entries = [...this.#entries.entries()].map(([id, entry]) => ({ id, entry }));
    this.#entries.clear();
    return entries;
  }
}

