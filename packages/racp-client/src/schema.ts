/**
 * 运行期校验 + 类型：只落我们真正要用的那几个对象。
 *
 * 来源：SDK 生成物 `@pi-desktop/shared` 的 `fixtures/racp.schema.json`
 *       （hostVersion **0.21.0** / `@pi-desktop/pi-host` 0.21.0，protocolVersion 1.0）
 *       — 与 `packages/shared/src/racp.ts` 的 typebox 定义同源。
 *       fixture SHA-256 = `e0e0a1f0…`（见 README「钉扎」一节；本包不 vendor fixture，
 *       只在 `doctor` 里按 tech-plan §2.2 校验 `vendor/pi-host/<version>/PIN.json`）。
 *
 * 用法：**形状错了就抛 `PROTOCOL_ERROR`**，不静默补默认值。规范 §14 第 1–2 条说
 * 「新字段是增量、客户端忽略不认识的字段」，所以守卫只校验**必填字段与枚举**，
 * 多余字段一律放过 —— 那和「放宽断言」是两件事。
 */

import { protocolError } from './errors.ts';

export type JsonRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isNonEmptyString = (value: unknown): value is string => isString(value) && value.length > 0;
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);
const isArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);
const oneOf =
  <T extends string>(values: readonly T[]) =>
  (value: unknown): value is T =>
    isString(value) && (values as readonly string[]).includes(value);

// ── 枚举（fixture 里的 const 联合） ──────────────────────────────────────
export const RACP_PROTOCOL_VERSION = '1.0';
export const SESSION_MODES = ['agent', 'plan', 'goal'] as const;
export const SESSION_STATUSES = ['idle', 'running', 'waiting_permission', 'aborted', 'error'] as const;
export const PLANNING_STATES = ['inactive', 'planning', 'awaiting_approval'] as const;
export const PERMISSION_MODES = ['ask', 'accept-edits', 'auto'] as const;
export const TURN_STATUSES = [
  'queued',
  'running',
  'waiting_approval',
  'waiting_input',
  'completed',
  'interrupted',
  'failed',
  'canceled',
] as const;

/** 握手自报身份：Host 的 `RacpInitializeParamsSchema.client` 是必填（`{name, version}`）。 */
export const RACP_CLIENT_NAME = 'pi-issue-bot';
/** 与 `packages/racp-client/package.json` 的版本保持一致（手动同步，这里只有一处引用）。 */
export const RACP_CLIENT_VERSION = '0.0.0';
export const TURN_ADMISSIONS = ['reject_if_busy', 'queue'] as const;
export const ITEM_TYPES = ['message', 'tool', 'compaction'] as const;
export const ITEM_STATUSES = ['streaming', 'completed'] as const;
export const EVENT_SCOPES = ['session', 'host'] as const;
export const APPROVAL_KINDS = ['tool', 'plan', 'goal'] as const;
export const APPROVAL_RISKS = ['low', 'medium', 'high'] as const;
export const TOOL_APPROVAL_DECISIONS = ['allow-once', 'allow-session', 'deny'] as const;
export const CONTRACT_APPROVAL_DECISIONS = ['approve', 'reject'] as const;
export const APPROVAL_DECISIONS = [...TOOL_APPROVAL_DECISIONS, ...CONTRACT_APPROVAL_DECISIONS] as const;
export const APPROVAL_RESULT_STATUSES = ['resolved', 'expired', 'canceled'] as const;
export const RACP_ROLES = ['viewer', 'controller', 'approver', 'owner'] as const;

export const EVENT_KINDS = [
  'session.created',
  'session.changed',
  'session.archived',
  'host.changed',
  'turn.queued',
  'turn.started',
  'turn.completed',
  'turn.interrupted',
  'turn.failed',
  'turn.canceled',
  'turn.activity',
  'item.started',
  'item.delta',
  'item.completed',
  'tool.progress',
  'terminal.changed',
  'terminal.output',
  'approval.requested',
  'approval.resolved',
  'input.requested',
  'input.resolved',
  'resync.required',
] as const;

/** §5.3：这四个是 ephemeral —— 不排序号、不进重放窗口、不参与 gap 检测。 */
export const EPHEMERAL_EVENT_KINDS = ['turn.activity', 'item.delta', 'tool.progress', 'terminal.output'] as const;

/** 其余全是 durable（带 `sequence`）。 */
export const DURABLE_EVENT_KINDS = EVENT_KINDS.filter(
  (kind) => !(EPHEMERAL_EVENT_KINDS as readonly string[]).includes(kind),
);

export const isDurableEventKind = (kind: string): boolean =>
  (DURABLE_EVENT_KINDS as readonly string[]).includes(kind);

// ── 类型 ──────────────────────────────────────────────────────────────
export type SessionMode = (typeof SESSION_MODES)[number];
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export type PlanningState = (typeof PLANNING_STATES)[number];
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type TurnStatus = (typeof TURN_STATUSES)[number];
export type TurnAdmission = (typeof TURN_ADMISSIONS)[number];
export type ItemType = (typeof ITEM_TYPES)[number];
export type EventScope = (typeof EVENT_SCOPES)[number];
export type EventKind = (typeof EVENT_KINDS)[number];
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];
export type ApprovalResultStatus = (typeof APPROVAL_RESULT_STATUSES)[number];
export type RacpRole = (typeof RACP_ROLES)[number];

/** §5 的 Cursor：`{ epoch, sequence }`，**不是数字**（见 README「与 tech-plan 的差异」）。 */
export interface Cursor {
  epoch: string;
  sequence: number;
}

/** §5.3 的 RemoteError（`error.data` 里的语义载荷）。 */
export interface RemoteError {
  code: string;
  message: string;
  retriable: boolean;
  traceId: string;
  details?: unknown;
}

/** §5 的 RequestContext，映射到 `params.context`（§4.2）。 */
export interface RequestContext {
  requestId: string;
  idempotencyKey?: string;
  expectedRevision?: number;
  traceparent?: string;
}

export interface Session {
  id: string;
  title: string;
  projectId?: string;
  workspaceLabel?: string;
  mode: SessionMode;
  status: SessionStatus;
  planningState: PlanningState;
  permissionMode: PermissionMode;
  activeTurnId?: string;
  queuedTurnIds: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface Turn {
  id: string;
  sessionId: string;
  status: TurnStatus;
  admission: TurnAdmission;
  queuePosition?: number;
  effectivePermissionMode: PermissionMode;
  idempotencyKey?: string;
  startedAt?: string;
  endedAt?: string;
  error?: RemoteError;
}

export interface EventEnvelope {
  eventId: string;
  scope: EventScope;
  sessionId?: string;
  turnId?: string;
  epoch: string;
  /** durable 才有。 */
  sequence?: number;
  /** ephemeral 才有：最后一条 durable 事件的序号。 */
  afterSequence?: number;
  revision: number;
  kind: EventKind;
  occurredAt: string;
  parentToolCallId?: string;
  nestedParentToolCallId?: string;
  agentName?: string;
  payload: unknown;
}

export interface ItemSummary {
  id: string;
  turnId: string;
  itemType: ItemType;
  status: (typeof ITEM_STATUSES)[number];
  sequence?: number;
  createdAt: string;
  parentToolCallId?: string;
  nestedParentToolCallId?: string;
  agentName?: string;
  content: unknown;
}

export interface SessionSnapshot {
  session: Session;
  activeTurn?: Turn;
  queuedTurns: Turn[];
  items: ItemSummary[];
  activeItems: ItemSummary[];
  pendingApprovals: ApprovalRequest[];
  pendingInputs: InputRequest[];
  hasMoreHistory: boolean;
  cursor: Cursor;
  revision: number;
  generatedAt: string;
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  turnId: string;
  kind: ApprovalKind;
  summary: string;
  expiresAt: string;
  revision: number;
  toolName?: string;
  risk?: (typeof APPROVAL_RISKS)[number];
  agentName?: string;
  parentToolCallId?: string;
  nestedParentToolCallId?: string;
  title?: string;
  question?: string;
  artifact?: { relativePath: string; sha256: string; sizeBytes: number };
  allowedDecisions: ApprovalDecision[];
  allowedPermissionModes?: PermissionMode[];
}

export interface ApprovalResponse {
  approvalId: string;
  decision: ApprovalDecision;
  permissionMode?: PermissionMode;
  context: RequestContext;
}

export interface ApprovalResult {
  approvalId: string;
  status: ApprovalResultStatus;
  decision?: ApprovalDecision;
  permissionMode?: PermissionMode;
  alreadyResolved: boolean;
  revision: number;
}

export interface InputQuestion {
  id: string;
  question: string;
  options: string[];
  multiSelect: boolean;
}

export interface InputRequest {
  id: string;
  sessionId: string;
  turnId: string;
  expiresAt: string;
  agentName?: string;
  parentToolCallId?: string;
  nestedParentToolCallId?: string;
  questions: InputQuestion[];
}

export interface InputResponse {
  inputId: string;
  /** `null` = 该问题被跳过（§5.5 规则 3）。 */
  answers: (string[] | null)[];
  context: RequestContext;
}

export interface Limits {
  maxFrameBytes: number;
  maxPromptBytes: number;
  maxAttachmentBytes: number;
  maxSubscriptionsPerConnection: number;
  maxQueuedTurnsPerSession: number;
  replayWindowEvents: number;
  replayWindowMs?: number;
  maxConnectedClients?: number;
  terminalReplayRingBytes?: number;
  maxOpenTerminalsPerSession?: number;
}

export interface Policy {
  remoteMaxPermissionMode: PermissionMode;
  applyCeilingToPairedDevices: boolean;
  approvalLifetimeMs: number;
}

export interface ServerCapabilities {
  eventReplay?: boolean;
  snapshot?: boolean;
  approvals?: boolean;
  inputRequests?: boolean;
  attachments?: boolean;
  serverRequests?: boolean;
  turnQueue?: boolean;
  hostEvents?: boolean;
  history?: boolean;
  remoteHostProfile?: boolean;
  toolRelay?: boolean;
  terminal?: boolean;
  notifications?: boolean;
  bindings?: string[];
}

export interface InitializeResult {
  protocolVersion: string;
  server: { name: string; version: string; hostId?: string };
  connectionId: string;
  principal: { subject: string; roles: RacpRole[] };
  capabilities: ServerCapabilities;
  limits: Limits;
  policy: Policy;
}

// ── 守卫 ──────────────────────────────────────────────────────────────

type Field = readonly [name: string, ok: (value: unknown) => boolean, expected: string];

/** 返回第一处问题（人可读），全对返回 `null`。`undefined` 视为缺失。 */
function checkObject(value: unknown, label: string, fields: readonly Field[]): string | null {
  if (!isRecord(value)) return `${label}: 应为对象`;
  for (const [key, ok, expected] of fields) {
    const field = value[key];
    if (field === undefined) return `${label}.${key}: 缺失（应为 ${expected}）`;
    if (!ok(field)) return `${label}.${key}: 应为 ${expected}`;
  }
  return null;
}

const everyItem = (ok: (value: unknown) => boolean) => (value: unknown) =>
  isArray(value) && value.every((item) => ok(item));

const cursorCheck = (value: unknown, label: string): string | null =>
  checkObject(value, label, [
    ['epoch', isNonEmptyString, '非空字符串'],
    ['sequence', (v) => isInt(v) && (v as number) >= 0, '>=0 的整数'],
  ]);

export const isCursor = (value: unknown): value is Cursor => cursorCheck(value, 'cursor') === null;

export const isSession = (value: unknown): value is Session =>
  checkObject(value, 'session', [
    ['id', isNonEmptyString, '非空字符串'],
    ['title', isString, '字符串'],
    ['mode', oneOf(SESSION_MODES), 'agent|plan|goal'],
    ['status', oneOf(SESSION_STATUSES), 'idle|running|waiting_permission|aborted|error'],
    ['planningState', oneOf(PLANNING_STATES), 'inactive|planning|awaiting_approval'],
    ['permissionMode', oneOf(PERMISSION_MODES), 'ask|accept-edits|auto'],
    ['queuedTurnIds', everyItem(isString), '字符串数组'],
    ['revision', (v) => isInt(v) && (v as number) >= 0, '>=0 的整数'],
    ['createdAt', isString, '字符串'],
    ['updatedAt', isString, '字符串'],
  ]) === null;

export const isTurn = (value: unknown): value is Turn =>
  checkObject(value, 'turn', [
    ['id', isNonEmptyString, '非空字符串'],
    ['sessionId', isNonEmptyString, '非空字符串'],
    ['status', oneOf(TURN_STATUSES), TURN_STATUSES.join('|')],
    ['admission', oneOf(TURN_ADMISSIONS), 'reject_if_busy|queue'],
    ['effectivePermissionMode', oneOf(PERMISSION_MODES), 'ask|accept-edits|auto'],
  ]) === null;

export const isItemSummary = (value: unknown): value is ItemSummary =>
  checkObject(value, 'item', [
    ['id', isNonEmptyString, '非空字符串'],
    ['turnId', isNonEmptyString, '非空字符串'],
    ['itemType', oneOf(ITEM_TYPES), 'message|tool|compaction'],
    ['status', oneOf(ITEM_STATUSES), 'streaming|completed'],
    ['createdAt', isString, '字符串'],
    ['content', () => true, '任意（可为 null）'],
  ]) === null;

export const isEventEnvelope = (value: unknown): value is EventEnvelope =>
  checkObject(value, 'event', [
    ['eventId', isNonEmptyString, '非空字符串'],
    ['scope', oneOf(EVENT_SCOPES), 'session|host'],
    ['epoch', isNonEmptyString, '非空字符串'],
    ['revision', (v) => isInt(v) && (v as number) >= 0, '>=0 的整数'],
    ['kind', oneOf(EVENT_KINDS), 'EventKind'],
    ['occurredAt', isString, '字符串'],
    ['payload', () => true, '任意'],
  ]) === null;

export const isApprovalRequest = (value: unknown): value is ApprovalRequest =>
  checkObject(value, 'approval', [
    ['id', isNonEmptyString, '非空字符串'],
    ['sessionId', isNonEmptyString, '非空字符串'],
    ['turnId', isNonEmptyString, '非空字符串'],
    ['kind', oneOf(APPROVAL_KINDS), 'tool|plan|goal'],
    ['summary', isString, '字符串'],
    ['expiresAt', isString, '字符串'],
    ['revision', (v) => isInt(v) && (v as number) >= 0, '>=0 的整数'],
    ['allowedDecisions', everyItem(oneOf(APPROVAL_DECISIONS)), 'ApprovalDecision[]'],
  ]) === null;

export const isApprovalResult = (value: unknown): value is ApprovalResult =>
  checkObject(value, 'approvalResult', [
    ['approvalId', isNonEmptyString, '非空字符串'],
    ['status', oneOf(APPROVAL_RESULT_STATUSES), 'resolved|expired|canceled'],
    ['alreadyResolved', isBoolean, '布尔'],
    ['revision', (v) => isInt(v) && (v as number) >= 0, '>=0 的整数'],
  ]) === null;

export const isInputRequest = (value: unknown): value is InputRequest =>
  checkObject(value, 'input', [
    ['id', isNonEmptyString, '非空字符串'],
    ['sessionId', isNonEmptyString, '非空字符串'],
    ['turnId', isNonEmptyString, '非空字符串'],
    ['expiresAt', isString, '字符串'],
    [
      'questions',
      everyItem((question) =>
        checkObject(question, 'question', [
          ['id', isNonEmptyString, '非空字符串'],
          ['question', isString, '字符串'],
          ['options', everyItem(isString), '字符串数组'],
          ['multiSelect', isBoolean, '布尔'],
        ]) === null,
      ),
      '{id,question,options,multiSelect}[]',
    ],
  ]) === null;

export const isSessionSnapshot = (value: unknown): value is SessionSnapshot => {
  const problem = checkObject(value, 'snapshot', [
    ['session', isSession, 'Session'],
    ['queuedTurns', everyItem(isTurn), 'Turn[]'],
    ['items', everyItem(isItemSummary), 'ItemSummary[]'],
    ['activeItems', everyItem(isItemSummary), 'ItemSummary[]'],
    ['pendingApprovals', everyItem(isApprovalRequest), 'ApprovalRequest[]'],
    ['pendingInputs', everyItem(isInputRequest), 'InputRequest[]'],
    ['hasMoreHistory', isBoolean, '布尔'],
    ['cursor', isCursor, 'Cursor'],
    ['revision', (v) => isInt(v) && (v as number) >= 0, '>=0 的整数'],
    ['generatedAt', isString, '字符串'],
  ]);
  if (problem !== null) return false;
  const activeTurn = (value as JsonRecord).activeTurn;
  return activeTurn === undefined || isTurn(activeTurn);
};

export const isRemoteError = (value: unknown): value is RemoteError =>
  checkObject(value, 'remoteError', [
    ['code', isNonEmptyString, '非空字符串'],
    ['message', isString, '字符串'],
    ['retriable', isBoolean, '布尔'],
    ['traceId', isString, '字符串'],
  ]) === null;

/**
 * `connection/initialize` 的结果。
 *
 * 这里比 fixture **故意宽松一处**：§3 的示例 `limits` 只列 6 个字段，而 fixture
 * 要求 10 个（多了 `replayWindowMs` / `maxConnectedClients` / `terminalReplayRingBytes`
 * / `maxOpenTerminalsPerSession`）。我们只硬校验**要用到的 6 个**，其余「有就校验类型、
 * 没有就算了」—— 否则一个只按 §3 示例实现的老 Host 会被判成协议错误，而这几个字段
 * 我们根本不读。见 README「与规范的差异」。
 */
export const isInitializeResult = (value: unknown): value is InitializeResult => {
  const problem = checkObject(value, 'initializeResult', [
    ['protocolVersion', isNonEmptyString, '非空字符串'],
    ['server', (v) => checkObject(v, 'server', [['name', isString, '字符串'], ['version', isString, '字符串']]) === null, '{name,version,hostId?}'],
    ['connectionId', isNonEmptyString, '非空字符串'],
    [
      'principal',
      (v) =>
        checkObject(v, 'principal', [
          ['subject', isNonEmptyString, '非空字符串'],
          ['roles', everyItem(oneOf(RACP_ROLES)), 'RacpRole[]'],
        ]) === null,
      '{subject,roles}',
    ],
    ['capabilities', isRecord, '对象'],
    [
      'limits',
      (v) =>
        checkObject(v, 'limits', [
          ['maxFrameBytes', (n) => isInt(n) && (n as number) >= 1, '>=1 的整数'],
          ['maxPromptBytes', (n) => isInt(n) && (n as number) >= 1, '>=1 的整数'],
          ['maxAttachmentBytes', (n) => isInt(n) && (n as number) >= 1, '>=1 的整数'],
          ['maxSubscriptionsPerConnection', (n) => isInt(n) && (n as number) >= 1, '>=1 的整数'],
          ['maxQueuedTurnsPerSession', (n) => isInt(n) && (n as number) >= 0, '>=0 的整数'],
          ['replayWindowEvents', (n) => isInt(n) && (n as number) >= 1, '>=1 的整数'],
        ]) === null,
      'Limits',
    ],
    [
      'policy',
      (v) =>
        checkObject(v, 'policy', [
          ['remoteMaxPermissionMode', oneOf(PERMISSION_MODES), 'ask|accept-edits|auto'],
          ['applyCeilingToPairedDevices', isBoolean, '布尔'],
          ['approvalLifetimeMs', (n) => isInt(n) && (n as number) >= 1, '>=1 的整数'],
        ]) === null,
      'Policy',
    ],
  ]);
  if (problem !== null) return false;
  const record = value as JsonRecord;
  const limits = record.limits as JsonRecord;
  const optionalNumbers = ['replayWindowMs', 'maxConnectedClients', 'terminalReplayRingBytes', 'maxOpenTerminalsPerSession'];
  for (const key of optionalNumbers) {
    const field = limits[key];
    if (field !== undefined && !isInt(field)) return false;
  }
  const hostId = (record.server as JsonRecord).hostId;
  return hostId === undefined || isNonEmptyString(hostId);
};

/** 守卫失败就抛 `PROTOCOL_ERROR`，`details` 里带标签与收到的值（截断）。 */
export function assertWith<T>(
  guard: (value: unknown) => value is T,
  value: unknown,
  label: string,
): T {
  if (guard(value)) return value;
  throw protocolError(`${label}: 响应不是规范形状（§5）`, {
    label,
    received: preview(value),
  });
}

function preview(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const text = JSON.stringify(value);
  return text.length > 400 ? `${text.slice(0, 400)}…` : JSON.parse(text);
}
