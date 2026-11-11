/**
 * `agent/` 的公开出口（v0.3 的 issue agent 运行时，S1）。
 *
 * 分层：
 *  - `canonical-text` 归一化（幂等口径）｜`fingerprint` 幂等键｜`permission` 权限与拒绝记账；
 *  - `message` 三条模板 + 组装（摘别名、扫技能、算 fingerprint）；
 *  - `store` `agent_messages` / `agent_sessions` / `tasks` 读写；
 *  - `dispatcher` 串行调度（每 10s 一轮 + 任务结束后立刻取下一条）；
 *  - `ack` reaction 回执（`feedback/` 的写面，没有写面时静默）。
 *
 * 依赖方向：`agent → {config, feedback, github}`；**不** import `worker/` / `http/`
 * （webhook 反过来用 `agent/`，不能成环）。
 */
export {
  AGENT_DISPATCH_INTERVAL_MS,
  AGENT_DISPATCH_MAX_ISSUES,
  AGENT_COMMAND_PREFIX,
  AGENT_DENIAL_REPLY,
  AGENT_FINGERPRINT_LENGTH,
  AGENT_MAX_BODY_CHARS,
  AGENT_MAX_CATALOG_ENTRIES,
  AGENT_MAX_PROJECT_PROMPT_CHARS,
  AGENT_MAX_TITLE_CHARS,
  AGENT_MESSAGE_KINDS,
  AGENT_MESSAGE_STATUSES,
  AGENT_TASK_ACTOR,
  AGENT_TEMPLATE_IDS,
} from './constants.ts';
export type { AgentMessageKind, AgentMessageStatus, AgentTemplateId } from './constants.ts';

export { normalizeForIdempotency, stripAliases } from './canonical-text.ts';
export { eventFingerprint, mentionFingerprint } from './fingerprint.ts';

export { AGENT_DENIAL_SQL, isManager, recordDenial } from './permission.ts';
export type { AgentDenialKey, AgentManagerSettings } from './permission.ts';

export {
  AGENT_MESSAGE_TEMPLATES,
  AGENT_SKILL_CATALOG_HEADER,
  AGENT_SKILL_DIRECTIVE,
  AGENT_EMPTY_BODY,
  AGENT_EMPTY_MENTION,
  composeAgentMessage,
  eventSkillsOf,
  eventTemplateSkillOf,
  renderCatalog,
  truncatedMarker,
} from './message.ts';
export type {
  AgentIssueSnapshot,
  AgentMessageSettings,
  AgentSkillCatalogEntry,
  ComposedAgentMessage,
  ComposeAgentMessageInput,
} from './message.ts';

export {
  AGENT_SQL,
  AGENT_TASK_KEY_PREFIX,
  agentTaskCommand,
  agentTaskIdempotencyKey,
  claimNextForIssue,
  countPending,
  findTaskIdByKey,
  insertAgentTask,
  insertMessage,
  listQueuedIssueKeys,
  loadSession,
  markMessage,
  parseAgentTaskIdempotencyKey,
  readMessage,
  saveSession,
} from './store.ts';
export type { AgentMessageKey, AgentMessageRow, AgentSessionRow } from './store.ts';

export {
  dispatchAgentMessages,
  dispatchNextForIssue,
  finishMessageAndContinue,
} from './dispatcher.ts';
export type {
  AgentDispatchDeps,
  AgentDispatchEnqueue,
  AgentDispatchLogger,
  AgentDispatchOutcome,
  AgentDispatchResult,
} from './dispatcher.ts';

export { ackDone, ackReceived } from './ack.ts';
export type { AgentAckDeps, AgentAckResult, AgentAckTarget } from './ack.ts';
