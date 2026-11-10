/**
 * RACP operation 的类型化封装（tech-plan §4.4 的**白名单**，只此一张表）。
 *
 * 两条纪律：
 * 1. **表外的 operation 不导出**。`terminal/*`、`attachment/*`、`tools/advertise`、
 *    `workspace/toolExecute` 等被 §4.4 明确列成「不用」，它们的理由与「用到的」同等重要
 *    （面板不提供交互终端、MVP 不做附件、方向相反的 relayed tool）。真需要时先改文档再改这里，
 *    而不是「顺手加一个反正没坏处」——多一个 operation 就多一条权限面与一条维护面。
 * 2. **结果形状按「容忍嵌套」的方式取**：fixture（`racp.schema.json`）尚未 vendored，
 *    `session/create` 到底返回 `Session` 还是 `{ session }` 只能从 §5 的类型推断。
 *    所以每个 `extract*` 接受两种常见嵌套，但字段校验仍走 `schema.ts` 的守卫；
 *    两种都对不上就抛 `PROTOCOL_ERROR` —— 不静默返回 `undefined`，否则错误会漂到很远的地方。
 */

import type { RacpClient, RequestOptions } from './client.ts';
import { randomUUID } from 'node:crypto';
import { invalidArgumentError, protocolError } from './errors.ts';
import { previewRedacted } from './redact.ts';
import {
  assertWith,
  isApprovalResult,
  isRecord,
  isSession,
  isSessionSnapshot,
  isTurn,
  type ApprovalDecision,
  type ApprovalResult,
  type Cursor,
  type EventEnvelope,
  type JsonRecord,
  type PermissionMode,
  type RacpRole,
  type Session,
  type SessionMode,
  type SessionSnapshot,
  type Turn,
  type TurnAdmission,
} from './schema.ts';
import { assertBearerToken } from './transport.ts';

// ── 白名单 ──────────────────────────────────────────────────────────────

/** tech-plan §4.4「用到的」那一列，逐条照抄。顺序即文档顺序。 */
export const RACP_OPERATIONS = [
  'connection/initialize',
  'connection/ping',
  'connection/pair',
  'project/register',
  'session/create',
  'session/attach',
  'session/archive',
  'session/delete',
  'events/subscribe',
  'events/unsubscribe',
  'events/ack',
  'turn/start',
  'turn/get',
  'turn/interrupt',
  'turn/stop',
  'approval/respond',
  'input/respond',
  'workspace/diff',
] as const;

export type RacpOperation = (typeof RACP_OPERATIONS)[number];

/**
 * 方法名 → operation。这张表是「导出面 = 白名单」的唯一事实源：
 * `test/ops.test.ts` 断言它的键集合等于 `RacpOps` 的原型方法集合，值集合等于 `RACP_OPERATIONS`。
 */
export const OPS_OPERATION_BY_METHOD = {
  initialize: 'connection/initialize',
  ping: 'connection/ping',
  pair: 'connection/pair',
  projectRegister: 'project/register',
  sessionCreate: 'session/create',
  sessionAttach: 'session/attach',
  sessionArchive: 'session/archive',
  sessionDelete: 'session/delete',
  eventsSubscribe: 'events/subscribe',
  eventsUnsubscribe: 'events/unsubscribe',
  eventsAck: 'events/ack',
  turnStart: 'turn/start',
  turnGet: 'turn/get',
  turnInterrupt: 'turn/interrupt',
  turnStop: 'turn/stop',
  approvalRespond: 'approval/respond',
  inputRespond: 'input/respond',
  workspaceDiff: 'workspace/diff',
} as const satisfies Record<string, RacpOperation>;

export type OpsMethodName = keyof typeof OPS_OPERATION_BY_METHOD;

/**
 * 连接级 operation（握手与配对）：**不带** `params.context`。
 *
 * 理由：`RequestContext`（规范 §5）里的 `requestId` / `traceparent` 是业务请求的关联标识，
 * 而 `connection/initialize` 发生在「有 connectionId 之前」，`connection/pair` 发生在
 * 「有设备身份之前」。给它们塞 context 只可能让严格的 Host 判参数非法，不会带来任何信息。
 */
const CONNECTION_LEVEL_OPERATIONS: ReadonlySet<RacpOperation> = new Set([
  'connection/initialize',
  'connection/ping',
  'connection/pair',
]);

// ── 参数与结果类型 ───────────────────────────────────────────────────────

/** `connection/pair` 的参数。`pairingToken` 来自 `PI_HOST_PAIRING_TOKEN` 那行 stdout。 */
export interface PairParams {
  readonly pairingToken: string;
  readonly deviceName?: string;
  readonly requestedRoles?: readonly RacpRole[];
}

/** `connection/pair` 的结果。`deviceToken` 必须以 `pdt1.` 开头（Host 侧的约定）。 */
export interface PairResult {
  readonly deviceToken: string;
  readonly deviceId?: string;
  readonly hostId?: string;
  readonly expiresAt?: string;
}

export interface ProjectRegisterParams {
  /** 任务 worktree 的绝对路径；Host 负责规范化与校验，已注册则复用。 */
  readonly path: string;
}

export interface ProjectRegisterResult {
  readonly projectId: string;
  readonly path?: string;
  readonly workspaceLabel?: string;
}

export interface SessionCreateParams {
  readonly projectId?: string;
  readonly title?: string;
  readonly mode?: SessionMode;
  readonly permissionMode?: PermissionMode;
}

export interface EventsSubscribeParams {
  readonly sessionId: string;
  /**
   * 重放游标：**原样透传，客户端不猜**。
   *
   * `tech-plan` §4.3 写的是 `after: 0`（从零开始），fixture 的 `Cursor` 是 `{epoch, sequence}`。
   * 两种都接受，由调用方决定（本包里客户端从不自己维护游标：断线重连后重订阅也必须由
   * 调用方拿出自己存的那个游标，否则「重放」变成「漏事件」）。
   */
  readonly after?: Cursor | number;
}

export interface EventsSubscribeResult {
  readonly subscriptionId?: string;
  readonly cursor?: Cursor;
}

export interface EventsUnsubscribeParams {
  readonly subscriptionId?: string;
  readonly sessionId?: string;
}

export interface EventsAckParams {
  readonly sessionId: string;
  readonly cursor: Cursor;
}

export interface TurnStartParams {
  readonly sessionId: string;
  readonly input: { readonly messageId: string; readonly text: string };
  readonly admission?: TurnAdmission;
  /** 重试幂等键：同一 key 重发不会产生第二个 turn（Host 侧去重）。 */
  readonly idempotencyKey?: string;
}

export interface TurnRefParams {
  readonly sessionId: string;
  readonly turnId: string;
}

export interface ApprovalRespondParams {
  readonly approvalId: string;
  readonly decision: ApprovalDecision;
  readonly permissionMode?: PermissionMode;
}

export interface InputRespondParams {
  readonly inputId: string;
  /** `null` = 该问题被跳过（规范 §5.5 规则 3）。 */
  readonly answers: readonly (readonly string[] | null)[];
}

export interface WorkspaceDiffParams {
  readonly sessionId: string;
}

/** `workspace/diff` 的结果。只读单点，不做 `list`/`read`（tech-plan §4.4）。 */
export interface WorkspaceDiff {
  readonly diff: string;
  readonly truncated?: boolean;
}

// ── 实现 ────────────────────────────────────────────────────────────────

/**
 * operation 白名单的类型化外壳。
 *
 * 不做重试、不做熔断、不缓存 —— 那些属于 `worker/` 与 `runtime/`（tech-plan §8.2 的依赖方向）。
 * 本类只负责「填 `context`、调 `client.request`、按 §5 校验结果形状」。
 */
export class RacpOps {
  readonly client: RacpClient;

  constructor(client: RacpClient) {
    this.client = client;
  }

  /** `connection/initialize`。日常建连走 `client.connect()`，这里给 doctor / 手工探活用。 */
  async initialize(params?: JsonRecord, options?: RequestOptions): Promise<unknown> {
    return await this.#call('connection/initialize', params ?? {}, options);
  }

  /** `connection/ping`：健康检查。结果形状未在 fixture 里固定，按对象返回、不解析。 */
  async ping(options?: RequestOptions): Promise<JsonRecord> {
    const result = await this.#call('connection/ping', {}, options);
    return isRecord(result) ? result : { value: result };
  }

  /** `connection/pair`：仅引导期（`pi-bot bootstrap-host`）用一次，换设备令牌。 */
  async pair(params: PairParams, options?: RequestOptions): Promise<PairResult> {
    if (typeof params.pairingToken !== 'string' || params.pairingToken.length === 0) {
      throw invalidArgumentError('connection/pair 需要配对令牌（PI_HOST_PAIRING_TOKEN 那行的 token）');
    }
    // 配对令牌必须以 ppt1. 开头：把设备令牌当配对令牌用是装配错误，本地就该拦住。
    if (!params.pairingToken.startsWith('ppt1.')) {
      throw invalidArgumentError('connection/pair 的 pairingToken 必须以 ppt1. 开头（设备令牌只在配对之后用）');
    }
    const payload: JsonRecord = { pairingToken: params.pairingToken };
    if (params.deviceName !== undefined) payload.deviceName = params.deviceName;
    if (params.requestedRoles !== undefined) payload.requestedRoles = [...params.requestedRoles];

    const result = await this.#call('connection/pair', payload, options);
    const record = asRecord(result, 'connection/pair');
    const token = record.deviceToken;
    if (typeof token !== 'string' || token.length === 0) {
      throw protocolError('connection/pair 未返回 deviceToken', { received: previewRedacted(record) });
    }
    // 只校验前缀、不回显令牌体（tech-plan §10.2 的值级脱敏在 RacpError 里，但这里根本不带）。
    assertBearerToken(token);
    return {
      deviceToken: token,
      ...(typeof record.deviceId === 'string' ? { deviceId: record.deviceId } : {}),
      ...(typeof record.hostId === 'string' ? { hostId: record.hostId } : {}),
      ...(typeof record.expiresAt === 'string' ? { expiresAt: record.expiresAt } : {}),
    };
  }

  /** `project/register`：把任务 worktree 注册成 project（已注册则复用，返回同一个 id）。 */
  async projectRegister(
    params: ProjectRegisterParams,
    options?: RequestOptions,
  ): Promise<ProjectRegisterResult> {
    assertNonEmptyString(params.path, 'project/register 的 path');
    const result = await this.#call('project/register', { path: params.path }, options);
    const record = asRecord(result, 'project/register');
    // 真实的 Host（v0.22.0，`packages/racp/src/operations.ts`）返回 `{ project: { id, … } }`；
    // 早期按文档字面量写的扁平 `{ projectId }` 仍然接受，避免夹具与真实 Host 二选一。
    const projectValue = record['project'];
    const project = isRecord(projectValue) ? projectValue : {};
    const rawId = project['id'] ?? record['projectId'];
    if (typeof rawId !== 'string' || rawId.length === 0) {
      throw protocolError('project/register 未返回 project.id', { received: previewRedacted(record) });
    }
    return {
      projectId: rawId,
      ...(typeof project['path'] === 'string'
        ? { path: project['path'] }
        : typeof record['path'] === 'string'
          ? { path: record['path'] }
          : {}),
      ...(typeof record['workspaceLabel'] === 'string' ? { workspaceLabel: record['workspaceLabel'] } : {}),
    };
  }

  /** `session/create`：一个任务一个 session。 */
  async sessionCreate(params: SessionCreateParams = {}, options?: RequestOptions): Promise<Session> {
    const payload: JsonRecord = {};
    if (params.projectId !== undefined) payload.projectId = params.projectId;
    if (params.title !== undefined) payload.title = params.title;
    if (params.mode !== undefined) payload.mode = params.mode;
    if (params.permissionMode !== undefined) payload.permissionMode = params.permissionMode;

    const result = await this.#call('session/create', payload, options);
    return extractSession(result, 'session/create');
  }

  /** `session/attach`：拿快照（进程重启后接管一个已有 session 时用）。 */
  async sessionAttach(
    params: { readonly sessionId: string },
    options?: RequestOptions,
  ): Promise<SessionSnapshot> {
    assertNonEmptyString(params.sessionId, 'session/attach 的 sessionId');
    const result = await this.#call('session/attach', { sessionId: params.sessionId }, options);
    const candidate =
      isRecord(result) && isRecord(result.snapshot) ? result.snapshot : result;
    return assertWith(isSessionSnapshot, candidate, 'session/attach 的结果');
  }

  /** `session/archive`：任务结束时立刻做（tech-plan §4.3 第 9 步）。 */
  async sessionArchive(
    params: { readonly sessionId: string },
    options?: RequestOptions,
  ): Promise<JsonRecord> {
    assertNonEmptyString(params.sessionId, 'session/archive 的 sessionId');
    return asRecordOrEmpty(await this.#call('session/archive', { sessionId: params.sessionId }, options));
  }

  /** `session/delete`：超过保留期后由每日清理调用。 */
  async sessionDelete(
    params: { readonly sessionId: string },
    options?: RequestOptions,
  ): Promise<JsonRecord> {
    assertNonEmptyString(params.sessionId, 'session/delete 的 sessionId');
    return asRecordOrEmpty(await this.#call('session/delete', { sessionId: params.sessionId }, options));
  }

  /** `events/subscribe`：游标原样透传（`after` 由调用方给，客户端不猜）。 */
  async eventsSubscribe(
    params: EventsSubscribeParams,
    options?: RequestOptions,
  ): Promise<EventsSubscribeResult> {
    assertNonEmptyString(params.sessionId, 'events/subscribe 的 sessionId');
    if (params.after !== undefined && typeof params.after !== 'number') {
      // `after` 要么是数字（tech-plan §4.3 的 0），要么是 Cursor；别的一律是调用方写错了。
      if (!isRecord(params.after) || typeof params.after.epoch !== 'string') {
        throw invalidArgumentError('events/subscribe 的 after 必须是数字或 {epoch, sequence} 游标', {
          after: previewRedacted(params.after),
        });
      }
    }
    // 真实 Host（v0.22.0）的 `SubscribeParams.scope` 是**必填**联合（`session|host`）：
    // 白名单只订阅单个 session，所以恒发 `session`。
    const payload: JsonRecord = { scope: 'session', sessionId: params.sessionId };
    // 真实 Host 的 `after` 只接受 `{epoch, sequence}` 游标（v0.22.0 实测）：
    // 传数字会被 typebox 拒成 `invalid params: must be object`。
    // 调用方传 0 的语义是「从头订阅」——那正是 Host 省略 `after` 时的默认行为，所以不发。
    if (isRecord(params.after) && typeof params.after.epoch === 'string') payload.after = params.after;
    const result = await this.#call('events/subscribe', payload, options);
    const record = asRecordOrEmpty(result);
    const cursor = record.cursor;
    const subscriptionId = record.subscriptionId;
    return {
      ...(typeof subscriptionId === 'string' ? { subscriptionId } : {}),
      ...(isRecord(cursor) && typeof cursor.epoch === 'string' && typeof cursor.sequence === 'number'
        ? { cursor: { epoch: cursor.epoch, sequence: cursor.sequence } }
        : {}),
    };
  }

  async eventsUnsubscribe(
    params: EventsUnsubscribeParams,
    options?: RequestOptions,
  ): Promise<JsonRecord> {
    if (params.subscriptionId === undefined && params.sessionId === undefined) {
      throw invalidArgumentError('events/unsubscribe 需要 subscriptionId 或 sessionId 之一');
    }
    const payload: JsonRecord = {};
    if (params.subscriptionId !== undefined) payload.subscriptionId = params.subscriptionId;
    if (params.sessionId !== undefined) payload.sessionId = params.sessionId;
    return asRecordOrEmpty(await this.#call('events/unsubscribe', payload, options));
  }

  /** `events/ack`：把已消费的游标告诉 Host（Host 才会推进重放窗口）。 */
  async eventsAck(params: EventsAckParams, options?: RequestOptions): Promise<JsonRecord> {
    assertNonEmptyString(params.sessionId, 'events/ack 的 sessionId');
    if (!isRecord(params.cursor) || typeof params.cursor.epoch !== 'string') {
      throw invalidArgumentError('events/ack 的 cursor 必须是 {epoch, sequence}', {
        cursor: previewRedacted(params.cursor),
      });
    }
    return asRecordOrEmpty(
      await this.#call('events/ack', { sessionId: params.sessionId, cursor: params.cursor }, options),
    );
  }

  /** `turn/start`：prompt 由技能模板 + 仓库配置 + 任务上下文拼好，这里只负责发。 */
  async turnStart(params: TurnStartParams, options?: RequestOptions): Promise<Turn> {
    assertNonEmptyString(params.sessionId, 'turn/start 的 sessionId');
    assertNonEmptyString(params.input?.text, 'turn/start 的 input.text');
    assertNonEmptyString(params.input?.messageId, 'turn/start 的 input.messageId');
    // 真实 Host 的 `TurnStartParams` 还要求 `context.requestId`（必填，v0.22.0 实测），
    // 且 `idempotencyKey` 属于请求上下文；缺 `context` 会被拒成 `INVALID_ARGUMENT`。
    const payload: JsonRecord = {
      sessionId: params.sessionId,
      input: { messageId: params.input.messageId, text: params.input.text },
      context: {
        requestId: randomUUID(),
        ...(params.idempotencyKey === undefined ? {} : { idempotencyKey: params.idempotencyKey }),
      },
    };
    if (params.admission !== undefined) payload.admission = params.admission;
    const result = await this.#call('turn/start', payload, options);
    return extractTurn(result, 'turn/start');
  }

  async turnGet(params: TurnRefParams, options?: RequestOptions): Promise<Turn> {
    assertTurnRef(params, 'turn/get');
    const result = await this.#call('turn/get', { ...params }, options);
    return extractTurn(result, 'turn/get');
  }

  /** `turn/interrupt`：三层时间闸的落地手段（tech-plan §4.7），幂等。 */
  async turnInterrupt(params: TurnRefParams, options?: RequestOptions): Promise<Turn | undefined> {
    assertTurnRef(params, 'turn/interrupt');
    const result = await this.#call('turn/interrupt', { ...params }, options);
    const candidate = isRecord(result) && isRecord(result.turn) ? result.turn : result;
    return isTurn(candidate) ? candidate : undefined;
  }

  async turnStop(params: TurnRefParams, options?: RequestOptions): Promise<JsonRecord> {
    assertTurnRef(params, 'turn/stop');
    return asRecordOrEmpty(await this.#call('turn/stop', { ...params }, options));
  }

  /** `approval/respond`：自动审批策略的应答口（每一条 allow/deny 都是审计条目）。 */
  async approvalRespond(
    params: ApprovalRespondParams,
    options?: RequestOptions,
  ): Promise<ApprovalResult> {
    assertNonEmptyString(params.approvalId, 'approval/respond 的 approvalId');
    const payload: JsonRecord = { approvalId: params.approvalId, decision: params.decision };
    if (params.permissionMode !== undefined) payload.permissionMode = params.permissionMode;
    const result = await this.#call('approval/respond', payload, options);
    const candidate = isRecord(result) && isRecord(result.result) ? result.result : result;
    return assertWith(isApprovalResult, candidate, 'approval/respond 的结果');
  }

  /** `input/respond`：agent 反问时按策略应答（MVP：明确回「无法提供，按现有信息继续」）。 */
  async inputRespond(
    params: InputRespondParams,
    options?: RequestOptions,
  ): Promise<JsonRecord> {
    assertNonEmptyString(params.inputId, 'input/respond 的 inputId');
    if (!Array.isArray(params.answers)) {
      throw invalidArgumentError('input/respond 的 answers 必须是 (string[] | null)[]', {
        answers: previewRedacted(params.answers),
      });
    }
    const answers = params.answers.map((answer) => (answer === null ? null : [...answer]));
    return asRecordOrEmpty(
      await this.#call('input/respond', { inputId: params.inputId, answers }, options),
    );
  }

  /** `workspace/diff`：面板展示改动，只读单点。 */
  async workspaceDiff(params: WorkspaceDiffParams, options?: RequestOptions): Promise<WorkspaceDiff> {
    assertNonEmptyString(params.sessionId, 'workspace/diff 的 sessionId');
    const result = await this.#call('workspace/diff', { sessionId: params.sessionId }, options);
    if (typeof result === 'string') return { diff: result };
    // 真实 Host（v0.22.0）把 `workspace.diff()` 的原样结果交回来，字段名不是文档字面量里的
    // `diff`（实测没有这一项）。这里按「第一个看起来像 diff 的字符串」取，认不出来才报错——
    // 但**把 `files` 数组当成空 diff**：没有改动是 triage 的正常结果，不该算失败。
    const record = asRecord(result, 'workspace/diff');
    const direct = ['diff', 'patch', 'unified', 'text', 'patchText']
      .map((key) => record[key])
      .find((value): value is string => typeof value === 'string');
    const fromFiles = Array.isArray(record['files'])
      ? (record['files'] as unknown[])
          .map((file) => {
            const entry = isRecord(file) ? file : {};
            const patch = entry['patch'] ?? entry['unified'] ?? entry['diff'];
            return typeof patch === 'string' ? patch : '';
          })
          .filter((patch) => patch.length > 0)
          .join('\n')
      : '';
    const diff = direct ?? fromFiles;
    if (diff.length === 0 && !Array.isArray(record['files']) && Object.keys(record).length > 0) {
      throw protocolError('workspace/diff 未返回可识别的 diff', { received: previewRedacted(record) });
    }
    return {
      diff,
      ...(typeof record['truncated'] === 'boolean' ? { truncated: record['truncated'] } : {}),
    };
  }

  // ── 内部 ─────────────────────────────────────────────────────────────

  async #call(operation: RacpOperation, params: JsonRecord, options?: RequestOptions): Promise<unknown> {
    const payload = CONNECTION_LEVEL_OPERATIONS.has(operation)
      ? params
      : { ...params, context: this.client.createContext(options ?? {}) };
    return await this.client.request(operation, payload, options ?? {});
  }
}

// ── 形状提取 ────────────────────────────────────────────────────────────

function asRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) {
    throw protocolError(`${label} 的结果不是对象`, { received: previewRedacted(value) });
  }
  return value;
}

/** 有些 operation 的成功结果是 `{}` 或 `null`（例如 `session/archive`），统一成对象返回。 */
function asRecordOrEmpty(value: unknown): JsonRecord {
  if (value === undefined || value === null) return {};
  return asRecord(value, 'operation');
}

function extractSession(result: unknown, label: string): Session {
  const candidate = isRecord(result) && isRecord(result.session) ? result.session : result;
  return assertWith(isSession, candidate, `${label} 的结果`);
}

function extractTurn(result: unknown, label: string): Turn {
  const candidate = isRecord(result) && isRecord(result.turn) ? result.turn : result;
  return assertWith(isTurn, candidate, `${label} 的结果`);
}

function assertNonEmptyString(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidArgumentError(`${label} 必须是非空字符串`, { received: previewRedacted(value) });
  }
}

function assertTurnRef(params: TurnRefParams, label: string): void {
  assertNonEmptyString(params.sessionId, `${label} 的 sessionId`);
  assertNonEmptyString(params.turnId, `${label} 的 turnId`);
}

/**
 * 事件推送的订阅辅助：把 `client.onEvent` 收进一个数组，并在 `n` 条之后停止。
 *
 * 为什么在 ops 里：`runtime/` 需要「订阅 → 等到某个终态事件」的短循环，而它只依赖
 * `racp-client`（tech-plan §8.2）。这 20 行放在这里，好过让 runtime 自己数事件。
 */
export function collectEvents(
  client: RacpClient,
  options: { readonly max?: number; readonly signal?: AbortSignal } = {},
): { readonly events: EventEnvelope[]; readonly stop: () => void; readonly done: Promise<EventEnvelope[]> } {
  const events: EventEnvelope[] = [];
  let resolveDone: (value: EventEnvelope[]) => void = () => {};
  const done = new Promise<EventEnvelope[]>((resolve) => {
    resolveDone = resolve;
  });
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    options.signal?.removeEventListener('abort', stop);
    resolveDone(events);
  };
  const unsubscribe = client.onEvent((event) => {
    events.push(event);
    if (options.max !== undefined && events.length >= options.max) stop();
  });
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted === true) stop();
  return { events, stop, done };
}
