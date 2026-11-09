/**
 * RACP 错误分类（B5）。
 *
 * 两个来源，别混：
 * 1. 线上错误码 = 规范 §13 的表 + §14a 的实现细节（`HOST_DISCONNECTED`、
 *    `error.data` 里放 `RemoteError`、数字码 -32601 / -32602 / -32000）。
 * 2. `FailureClass` = 本项目 plan §7 的失败分类（入 `run_events.failure_class`）。
 *
 * **不做的事**：不认识的线上错误码**保留原名**，只把 `failureClass` 留空。
 * 硬塞进某个分类会让「未知错误」在统计里变成一个看起来正常的数字。
 *
 * `FailureClass` 此刻在 `@pi-issue-bot/shared` 还没有落地（那个包还是骨架），
 * 所以先在本地声明同一组字面量。TODO(owner: 后端控制面)：shared 有了之后改成
 * `import type { FailureClass } from '@pi-issue-bot/shared'`，映射表原样搬过去。
 */

/** plan §7 / tech-plan §7.3 的失败分类。顺序即优先级，和 §7.3 的表一致。 */
export const FAILURE_CLASSES = [
  'auth',
  'parse',
  'timeout',
  'github_api',
  'model',
  'sandbox',
  'rate_limit',
  'degenerate-output',
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** 错误从哪一层来。审计时要能分清「网络断了」和「Host 拒绝了」。 */
export type RacpErrorKind = 'rpc' | 'transport' | 'protocol' | 'timeout' | 'closed';

/**
 * 规范 §13 的 `retriable` 列（原样照抄）。
 * `HOST_DISCONNECTED` 等客户端码不在这张表里，见 `CLIENT_ERROR_SPEC`。
 */
export const REMOTE_ERROR_RETRIABLE = {
  UNAUTHORIZED: false,
  FORBIDDEN: false,
  PROTOCOL_MISMATCH: false,
  INVALID_ARGUMENT: false,
  NOT_FOUND: false,
  AGENT_UNAVAILABLE: true,
  AGENT_BUSY: false,
  CONFLICT: true,
  IDEMPOTENCY_CONFLICT: false,
  CURSOR_EXPIRED: false,
  CLIENT_TOO_SLOW: true,
  APPROVAL_EXPIRED: false,
  APPROVAL_STALE: false,
  PAYLOAD_TOO_LARGE: false,
  RATE_LIMITED: true,
  PAIRING_FAILED: false,
  PAIRING_TOKEN_EXPIRED: false,
  CAPABILITY_UNAVAILABLE: false,
  REMOTE_PATH_NOT_FOUND: false,
  REMOTE_PATH_FORBIDDEN: false,
  INTERNAL: 'maybe',
} as const satisfies Record<string, boolean | 'maybe'>;

export type RemoteErrorCode = keyof typeof REMOTE_ERROR_RETRIABLE;

/**
 * 只在客户端产生的码。`HOST_DISCONNECTED` 是规范点名的（§14a 最后一条），
 * `TIMEOUT` 沿用规范 §6.2.1 已经在用的名字；其余三个是本客户端内部的：
 * `ABORTED`（调用方 AbortSignal / 任务级时间闸）、`NOT_CONNECTED`（还没连过）、
 * `CLIENT_CLOSED`（`close()` 主动关闭）。
 * `HOST_VERSION_MISMATCH` 来自 tech-plan §4.1 第 4 条，表示握手协商失败。
 */
export const CLIENT_ERROR_SPEC = {
  HOST_DISCONNECTED: { retriable: true },
  HOST_VERSION_MISMATCH: { retriable: false },
  TIMEOUT: { retriable: true },
  ABORTED: { retriable: false },
  NOT_CONNECTED: { retriable: false },
  CLIENT_CLOSED: { retriable: false },
} as const satisfies Record<string, { retriable: boolean }>;

export type ClientErrorCode = keyof typeof CLIENT_ERROR_SPEC;

/**
 * 线上码 → plan §7 失败分类。
 *
 * 归类规则（一句话）：**出在我们这边请求形状上的 → `parse`；凭证 → `auth`；
 * 配额 → `rate_limit`；等不到 → `timeout`；其余全部属于「执行面不可用」→ `sandbox`**
 * （RACP 的失败几乎都是 agent 宿主/容器这一侧的事，plan §7 的八个桶里
 * `sandbox` 是唯一对得上的；`model` / `github_api` / `degenerate-output`
 * 永远不会由 RACP 产生，所以不出现）。
 */
export const CODE_FAILURE_CLASS: Record<string, FailureClass> = {
  // ── 认证与配对 ──────────────────────────────────────────────────
  UNAUTHORIZED: 'auth',
  FORBIDDEN: 'auth',
  PAIRING_FAILED: 'auth',
  PAIRING_TOKEN_EXPIRED: 'auth',

  // ── 我们发出的东西不对（形状/字段/大小） ──────────────────────────
  INVALID_ARGUMENT: 'parse',
  PAYLOAD_TOO_LARGE: 'parse',

  // ── 等不到 ────────────────────────────────────────────────────
  TIMEOUT: 'timeout',
  // setTimeout/AbortSignal 取消：tech-plan §4.7 用同一个 AbortSignal 实现任务级
  // 时间闸，所以「被取消」在统计上就该跟「超时」同桶，便于识别卡住的任务。
  ABORTED: 'timeout',

  // ── 配额 ──────────────────────────────────────────────────────
  RATE_LIMITED: 'rate_limit',

  // ── 执行面（agent 宿主 / 容器 / 会话）不可用 ──────────────────────
  HOST_DISCONNECTED: 'sandbox',
  // 版本/协议不匹配 = 这个 host 用不了，和「容器起不来」是同一类后果。
  HOST_VERSION_MISMATCH: 'sandbox',
  PROTOCOL_MISMATCH: 'sandbox',
  // METHOD_NOT_FOUND / CAPABILITY_UNAVAILABLE 在我们这里的实际含义是
  // 「host 版本比我们旧」，同样是执行面不可用，不是我们请求写错了。
  METHOD_NOT_FOUND: 'sandbox',
  CAPABILITY_UNAVAILABLE: 'sandbox',
  NOT_FOUND: 'sandbox',
  AGENT_UNAVAILABLE: 'sandbox',
  AGENT_BUSY: 'sandbox',
  CONFLICT: 'sandbox',
  IDEMPOTENCY_CONFLICT: 'sandbox',
  CURSOR_EXPIRED: 'sandbox',
  CLIENT_TOO_SLOW: 'sandbox',
  APPROVAL_EXPIRED: 'sandbox',
  APPROVAL_STALE: 'sandbox',
  REMOTE_PATH_NOT_FOUND: 'sandbox',
  REMOTE_PATH_FORBIDDEN: 'sandbox',
  TOOL_FAILED: 'sandbox',
  INTERNAL: 'sandbox',
  NOT_CONNECTED: 'sandbox',
  CLIENT_CLOSED: 'sandbox',
};

/** 线上码 → 失败分类；不认识的码返回 `undefined`（保留原名，不硬塞）。 */
export function failureClassFor(code: string): FailureClass | undefined {
  return Object.hasOwn(CODE_FAILURE_CLASS, code) ? CODE_FAILURE_CLASS[code] : undefined;
}

/** 规范 §14a：JSON-RPC 数字码只有两种是有语义的，其余一律 `-32000`。 */
export const JSONRPC_NUMERIC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  other: -32000,
} as const;

export interface RemoteErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly retriable: boolean;
  readonly traceId: string;
  readonly details?: unknown;
}

export interface RacpErrorInit {
  code: string;
  message: string;
  retriable?: boolean;
  traceId?: string;
  details?: unknown;
  kind?: RacpErrorKind;
  cause?: unknown;
}

/**
 * 客户端看到的统一错误。`code` 永远是**线上原名**或 `ClientErrorCode`，
 * 从不翻译成别的名字 —— 上层的分类逻辑集中在 `failureClass` 上。
 */
export class RacpError extends Error {
  readonly code: string;
  readonly retriable: boolean;
  readonly traceId: string | undefined;
  readonly details: unknown;
  readonly kind: RacpErrorKind;
  /** plan §7 分类；不认识的码为 `undefined`。 */
  readonly failureClass: FailureClass | undefined;

  constructor(init: RacpErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'RacpError';
    this.code = init.code;
    this.traceId = init.traceId;
    this.details = init.details;
    this.kind = init.kind ?? 'rpc';
    this.retriable =
      init.retriable ??
      (Object.hasOwn(REMOTE_ERROR_RETRIABLE, init.code)
        ? REMOTE_ERROR_RETRIABLE[init.code as RemoteErrorCode] === true
        : Object.hasOwn(CLIENT_ERROR_SPEC, init.code)
          ? CLIENT_ERROR_SPEC[init.code as ClientErrorCode].retriable
          : false);
    this.failureClass = failureClassFor(init.code);
  }

  /** 从 §13 的 `RemoteError` 构造。 */
  static fromPayload(payload: RemoteErrorPayload, kind: RacpErrorKind = 'rpc'): RacpError {
    return new RacpError({
      code: payload.code,
      message: payload.message,
      retriable: payload.retriable,
      traceId: payload.traceId,
      details: payload.details,
      kind,
    });
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retriable: this.retriable,
      traceId: this.traceId,
      failureClass: this.failureClass,
      kind: this.kind,
      details: this.details,
    };
  }
}

export function isRacpError(value: unknown): value is RacpError {
  return value instanceof RacpError;
}

export function isRemoteErrorPayload(value: unknown): value is RemoteErrorPayload {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.code === 'string' &&
    typeof record.message === 'string' &&
    typeof record.retriable === 'boolean' &&
    typeof record.traceId === 'string'
  );
}

/**
 * JSON-RPC 错误对象 → `RacpError`。
 *
 * §14a：语义载荷在 `error.data`，数字码只用来兜底。两者都没有时按
 * `PROTOCOL_ERROR` 处理 —— 那意味着对端发的不是 RACP 的错误形状。
 */
export function fromJsonRpcError(error: { code: number; message: string; data?: unknown }): RacpError {
  if (isRemoteErrorPayload(error.data)) {
    return RacpError.fromPayload(error.data);
  }
  const fallbackCode =
    error.code === JSONRPC_NUMERIC.methodNotFound
      ? 'METHOD_NOT_FOUND'
      : error.code === JSONRPC_NUMERIC.invalidParams
        ? 'INVALID_ARGUMENT'
        : 'INTERNAL';
  return new RacpError({
    code: fallbackCode,
    message: error.message,
    retriable: fallbackCode === 'INTERNAL',
    kind: 'rpc',
    details: { jsonrpcCode: error.code, data: error.data },
  });
}

/** 协议层面读不动对方的帧（不是业务错误，是契约被破坏）。 */
export function protocolError(message: string, details?: unknown, cause?: unknown): RacpError {
  return new RacpError({ code: 'PROTOCOL_ERROR' as string, message, details, cause, kind: 'protocol' });
}

export function abortedError(reason?: unknown): RacpError {
  return new RacpError({
    code: 'ABORTED',
    message: '请求被调用方取消（AbortSignal）',
    kind: 'timeout',
    details: reason === undefined ? undefined : { reason: String(reason) },
  });
}

export function timeoutError(method: string, timeoutMs: number): RacpError {
  return new RacpError({
    code: 'TIMEOUT',
    message: `${method} 超过 ${timeoutMs}ms 未返回（规范 §12 的 deadline）`,
    kind: 'timeout',
    details: { method, timeoutMs },
  });
}

/** 连接掉了：in-flight 一律以此失败，且**不重发**（§14a 最后一条）。 */
export function disconnectedError(details?: unknown, cause?: unknown): RacpError {
  return new RacpError({
    code: 'HOST_DISCONNECTED',
    message: '与 pi-host 的连接已断开（in-flight 调用不会重发，重试请带同一个 idempotencyKey）',
    kind: 'transport',
    details,
    cause,
  });
}

export function notConnectedError(): RacpError {
  return new RacpError({ code: 'NOT_CONNECTED', message: '还没有调用 connect()', kind: 'closed' });
}

export function closedError(): RacpError {
  return new RacpError({ code: 'CLIENT_CLOSED', message: '客户端已被 close() 关闭', kind: 'closed' });
}

/** 任意抛出物 → `RacpError`（非 RacpError 一律按 `INTERNAL` 包一层，保住 cause）。 */
export function toRacpError(error: unknown, fallbackMessage = '未预期的错误'): RacpError {
  if (error instanceof RacpError) return error;
  if (error instanceof Error) {
    return new RacpError({ code: 'INTERNAL', message: error.message || fallbackMessage, kind: 'rpc', cause: error });
  }
  return new RacpError({ code: 'INTERNAL', message: fallbackMessage, details: { thrown: String(error) } });
}
