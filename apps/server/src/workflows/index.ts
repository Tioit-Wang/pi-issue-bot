/**
 * `workflows/` 的公开出口。
 *
 * 分工（每个文件只回答一个问题）：
 *  - `command-gate.ts`    这句话该不该入队（权限 + 重复 sha）？
 *  - `triage.ts`          分类打标：判定 → 归一化 → 只增删自己打过的 + 缺信息打标/打 reaction
 *  - `normalize.ts`       打标归一化（词表 / 1:N / 互斥组 / 上限 / 人工否决）——纯函数
 *  - `label-decisions.ts` `label_decisions` 的写入面（每轮一行）
 *  - `close-gate.ts`      能不能关（只读 `issue_states` + `bot_labels`，不执行关闭）
 *  - `issue-state.ts`     `issue_states` 的读写（唯一写入面）
 *  - `bot-labels.ts`      `bot_labels` 的记账实现（`BotLabelLedger` 的 PG 版 + 归因列）
 *  - `ports.ts`           注入面（worker 的窄接口 + SQL / reaction / 标签目录端口）
 *  - `pipeline.ts`        `issue_pipeline` 的状态机 + 读写（`decideTransition` 纯函数，§2 转移表）
 *  - `stage-result.ts`    阶段信封的读取与校验（stage 配对 / `path:line` 强制降级）
 *  - `pipeline-labels.ts` 分类结论 → 词表标签（走 `normalizeDesired` 的互斥组 / 上限）
 *  - `pipeline-directives.ts` 管理员指令解析（`/recheck`、`/pipeline next|prev`）
 *
 * **已经删除的文件**：`compliance.ts`（合规评论）。缺信息不再发评论，改为
 * `needs-info` 标签 + `confused` reaction（`docs/impl-multi-repo.md` §0.3）。
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
  applyMissingSet,
  isHumanReplyActor,
  ISSUE_STATE_SQL,
  loadIssueState,
  markClosed,
  markNudged,
  recordHumanReply,
  toIssueStateSnapshot,
} from './issue-state.ts';
export {
  BOT_LABEL_SQL,
  createAttributedBotLabelLedger,
  createPgBotLabelLedger,
  listBotLabelHistory,
  listBotLabels,
  loadHumanVetoed,
} from './bot-labels.ts';
export type { BotLabelAttribution } from './bot-labels.ts';
export {
  BLOCKED_REASON_LIMIT,
  createPgLabelDecisionRecorder,
  LABEL_DECISION_SQL,
  listLabelDecisions,
  recordLabelDecision,
  summarizeBlockedReason,
} from './label-decisions.ts';
export type { LabelDecisionRecord, LabelDecisionRecorder } from './label-decisions.ts';
export { humanVetoedFrom, normalizeDesired, toLabelTargets, vocabularyIndex } from './normalize.ts';
export type {
  BlockedLabel,
  LabelBlockedReason,
  NormalizeDesiredInput,
  NormalizeDesiredResult,
} from './normalize.ts';
export {
  describeMissing,
  missingEvidenceOf,
  NEEDS_INFO_FALLBACK_LABEL,
  NEEDS_INFO_KEY,
  needsInfoLabelOf,
  REASON_QUOTE_LIMIT,
  runTriage,
} from './triage.ts';
export type {
  BotLabelLedgerFactory,
  MissingEvidence,
  TriageDeps,
  TriageFailureSignal,
  TriageInput,
  TriageOutcome,
  TriageResult,
} from './triage.ts';
export { toSqlRunner } from './ports.ts';
export {
  PIPELINE_SQL,
  applyTransition,
  buildUpdateStatement,
  createReadyRow,
  decideTransition,
  ensurePipeline,
  gateNoticeAllowed,
  isPipelineCommand,
  loadPipeline,
  pipelineAnchor,
  recheckCooldownElapsed,
  toPipelineRow,
} from './pipeline.ts';
export type {
  PipelineEffects,
  PipelineEvent,
  PipelineInit,
  PipelineKey,
  PipelineQueryable,
  PipelineRow,
  PipelineTransition,
  SupplementActor,
} from './pipeline.ts';
export {
  CODE_QUOTE_RE,
  CODE_RULE_PREFIX,
  CHECKED_RULE_PREFIX,
  classifyEvidenceScope,
  codeEvidenceOf,
  commentBodyOf,
  evidenceOf,
  readStageResult,
  stageOfPipelineCommand,
} from './stage-result.ts';
export type {
  StageResultRead,
  StageResultReadFail,
  StageResultReadOk,
  StageResultRejectReason,
} from './stage-result.ts';
export { labelsOfRole, pipelineLabelPlan, pipelineLabelsFor, pipelineLabelsToApply } from './pipeline-labels.ts';
export type { PipelineLabelLogger } from './pipeline-labels.ts';
export {
  appendMentions,
  describeDirective,
  isPipelineManager,
  managerMentions,
  parsePipelineDirective,
} from './pipeline-directives.ts';
export type { PipelineActor, PipelineDirective } from './pipeline-directives.ts';
export type {
  EnvelopeRunner,
  LabelCatalogPort,
  PgLikePool,
  ReactionContent,
  ReactionPort,
  RecordedQuery,
  RunSummary,
  SqlResult,
  SqlRunner,
} from './ports.ts';
