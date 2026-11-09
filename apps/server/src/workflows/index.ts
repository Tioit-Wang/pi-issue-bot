/**
 * `workflows/` 的公开出口（W4-M：M1 能力的确定性部分）。
 *
 * 分工（每个文件只回答一个问题）：
 *  - `command-gate.ts`  这句话该不该入队（权限 + 重复 sha）？
 *  - `triage.ts`        分类打标：判定键 → 仓库标签 → 只增删自己打过的
 *  - `compliance.ts`    标准合规：缺失项集合 → `issue_states` → 只在集合变化时催办
 *  - `close-gate.ts`    能不能关（只读 `issue_states` + `bot_labels`，不执行关闭）
 *  - `issue-state.ts`   `issue_states` 的读写（唯一写入面）
 *  - `bot-labels.ts`    `bot_labels` 的记账实现（`BotLabelLedger` 的 PG 版）
 *  - `ports.ts`         注入面（worker 的窄接口 + SQL 端口）
 *
 * 依赖方向：`workflows → skills, github, queue, worker(类型), contract`。
 * 它**不**依赖 `http/`（接入层调用流程，不是反过来）。
 */
export {
  CLOSE_GRACE_MS,
  DEFAULT_NEEDS_INFO_LABEL,
  evaluateCloseGate,
  loadCloseGateDecision,
} from './close-gate.ts';
export type { CloseGateCheck, CloseGateCheckId, CloseGateDecision, CloseGateInput } from './close-gate.ts';
export {
  commandIdempotencyKey,
  commandKind,
  evaluateCommandGate,
  targetOf,
} from './command-gate.ts';
export type { CommandActor, CommandGateDecision, CommandGateInput, CommandGateRejectReason } from './command-gate.ts';
export {
  applyCompliance,
  buildComplianceComment,
  evaluateCompliance,
  missingSetHashOf,
  NEEDS_INFO_KEY,
  QUOTE_LIMIT,
  resolveLabel,
} from './compliance.ts';
export type {
  ComplianceDeps,
  ComplianceInput,
  ComplianceOutcome,
  ComplianceResult,
  ComplianceRuleVerdict,
  ComplianceVerdict,
  LabelResolution,
} from './compliance.ts';
export {
  applyMissingSet,
  isHumanReplyActor,
  ISSUE_STATE_SQL,
  loadIssueState,
  markClosed,
  markNudged,
  recordHumanReply,
  toIssueStateSnapshot,
} from './issue-state.ts';
export type { IssueStateSnapshot } from './issue-state.ts';
export { BOT_LABEL_SQL, createPgBotLabelLedger, listBotLabels } from './bot-labels.ts';
export { toSqlRunner } from './ports.ts';
export type { EnvelopeRunner, PgLikePool, RecordedQuery, RunSummary, SqlResult, SqlRunner } from './ports.ts';
export { mapVerdictLabels, runTriage } from './triage.ts';
export type { TriageDeps, TriageInput, TriageOutcome, TriageResult } from './triage.ts';