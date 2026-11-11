/**
 * `workflows/` 的公开出口。
 *
 * 分工（每个文件只回答一个问题）：
 *  - `normalize.ts`       打标归一化（词表 / 1:N / 互斥组 / 上限 / 人工否决）——纯函数
 *  - `label-decisions.ts` `label_decisions` 的写入面（每轮一行）
 *  - `bot-labels.ts`      `bot_labels` 的记账实现（`BotLabelLedger` 的 PG 版 + 归因列）
 *  - `ports.ts`           注入面（worker 的窄接口 + SQL / reaction / 标签目录端口）
 *  - `labels.ts`          `needs-info` 标签名（`needsInfoLabelOf`，平台级「缺信息」打标）
 *  - `evidence.ts`        缺必填信息的判据（`missingEvidenceOf` / `describeMissing`）
 *
 * **已经删除的文件**（`docs/dev-plan-issue-agent.md` §1，v0.3 退役「固定流水线」）：
 *  - `pipeline.ts` / `pipeline-format.ts` / `pipeline-classify.ts` / `pipeline-directives.ts`：
 *    三段流水线状态机、阶段执行、管理员指令——v0.3 没有「阶段」概念；
 *  - `stage-result.ts` / `pipeline-labels.ts`：阶段结论读取与「结论 → 标签」；其中仍在用的
 *    纯函数已搬家到 `evidence.ts` 与 `labels.ts`；
 *  - `command-gate.ts`（`/命令` 门禁）与 `compliance.ts`（合规评论）：v0.3 里 `/名字` 归技能、
 *    「缺信息」不再发评论。
 *
 * 护栏：`test/no-dead-workflows.test.ts`（源码里不许再出现那批已删模块的名字）。
 *
 * 依赖方向：`workflows → skills, github, queue, worker(类型), contract`。
 * 它**不**依赖 `http/`（接入层调用流程，不是反过来）。
 */
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
export { NEEDS_INFO_FALLBACK_LABEL, NEEDS_INFO_KEY, needsInfoLabelOf } from './labels.ts';
export { toSqlRunner } from './ports.ts';
export { REASON_QUOTE_LIMIT, describeMissing, missingEvidenceOf } from './evidence.ts';
export type { MissingEvidence } from './evidence.ts';
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
