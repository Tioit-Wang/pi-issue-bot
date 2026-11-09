/**
 * 契约枚举（W1-A · B3 契约冻结）。
 *
 * 单一事实源：`packages/contract/src/**`。DB 列、API 响应、面板类型、信封校验都从这里取枚举，
 * 不接受第二份手写清单（`docs/spec/contract-db.md` / `contract-api.md` 与本文件逐项一致）。
 *
 * 取值风格：**一律 kebab-case**（例：`sandbox-oom`）。
 * 上游 `plan.md` §10 与 `tech-plan.md` §7.3 的失败分类命名本身不统一（`rate_limit` vs `sandbox-oom`），
 * 统一成一个风格是契约冻结时的取舍，映射见 `docs/spec/contract-db.md` 末尾的差异清单。
 *
 * 时间一律 ISO8601 UTC（带 `Z`），金额 USD（4 位小数），token 与耗时都是整数。
 */
import { z } from 'zod';

// ── 任务状态（tasks.status）───────────────────────────────────────────────────────────────
//
// 为什么没有 `skipped`：幂等命中时**根本不会建任务**（`tasks.idempotency_key` 唯一），
// 所以「空操作」不是一个状态，而是一次没有发生的插入。面板的「重复投递」看 `webhook_deliveries`。
export const TASK_STATUSES = [
  'queued', // 已入队，worker 未开始
  'running', // worker 正在跑（容器已拉起或正在拉起）
  'succeeded', // 信封已入库、动作已执行（或 dry-run 只入库）
  'failed', // 终态失败，细分看 runs.failure_class
  'cancelled', // 排队闸门 >10min 取消 / 人工取消
] as const;
export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/** 终态：不再变化的状态。面板统计与排队闸门都以它为准。 */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['succeeded', 'failed', 'cancelled'];

// ── 任务来源（tasks.source）───────────────────────────────────────────────────────────────
export const TASK_SOURCES = ['webhook', 'command', 'cron'] as const;
export const taskSourceSchema = z.enum(TASK_SOURCES);
export type TaskSource = z.infer<typeof taskSourceSchema>;

// ── 目标类型（tasks.target_kind）──────────────────────────────────────────────────────────
export const TARGET_KINDS = ['issue', 'pr'] as const;
export const targetKindSchema = z.enum(TARGET_KINDS);
export type TargetKind = z.infer<typeof targetKindSchema>;

// ── 一次 run 的结果（runs.outcome / metrics_daily.outcome）────────────────────────────────
//
// 对应 plan §6.5 的结果分布：成功 / 失败 / 超时 / 熔断 / 解析失败，另加 `interrupted`（收到取消信号）。
// `outcome` 是**维度**，`failure_class` 是**原因**；两者不同步推导：`interrupted` 的
// failure_class 是 `interrupt`，但 `sandbox-oom` 的 outcome 仍是 `failed`（要重试的那类失败）。
export const OUTCOMES = [
  'success', // 信封入库且（非 dry-run 时）动作全部执行完
  'failed', // 走到失败终态
  'timed-out', // 任务级 deadline 触发
  'degenerate-output', // plan §9.3 重复输出熔断
  'parse-failed', // 信封校验失败 / 动作不合规被丢弃导致的失败
  'interrupted', // turn/interrupt 或人工取消
] as const;
export const outcomeSchema = z.enum(OUTCOMES);
export type Outcome = z.infer<typeof outcomeSchema>;

// ── 失败分类（runs.failure_class）─────────────────────────────────────────────────────────
export const FAILURE_CLASSES = [
  'timeout',
  'interrupt',
  'degenerate-output',
  'sandbox-oom',
  'sandbox-crash',
  'auth',
  'rate-limit',
  'model',
  'parse',
  'github-api',
] as const;
export const failureClassSchema = z.enum(FAILURE_CLASSES);
export type FailureClass = z.infer<typeof failureClassSchema>;

/**
 * tech-plan §7.3 的判定优先级：一次 run 可能同时「像崩溃」又「像超时」，
 * 必须按固定优先级取**一个**类写进 `runs.failure_class`，重试决策只读那一个。
 * 数字越小优先级越高（1 = 不自动重试）。
 */
export const FAILURE_CLASS_PRIORITY_GROUPS = [
  ['timeout', 'interrupt', 'degenerate-output'],
  ['sandbox-oom'],
  ['sandbox-crash'],
  ['auth', 'rate-limit', 'model', 'parse', 'github-api'],
] as const;

/** 取某个失败分类的优先级（1 最高）。未知分类返回 4（最低）。 */
export function failureClassPriority(failureClass: FailureClass): 1 | 2 | 3 | 4 {
  for (const [index, group] of FAILURE_CLASS_PRIORITY_GROUPS.entries()) {
    if ((group as readonly string[]).includes(failureClass)) {
      return (index + 1) as 1 | 2 | 3 | 4;
    }
  }
  return 4;
}

// ── 动作 intent ──────────────────────────────────────────────────────────────────────────
//
// 两个集合是刻意的，不要合并：
//
// 1. `ACTION_INTENTS` = 信封里 agent **可以声明**的动作，只有 plan §5 那 4 类。
//    `open_pr` 不是 intent：开 PR 是 `push_branch` 上的 `openPr: true`（plan §5 的字面形状）。
// 2. `EXECUTOR_ACTION_INTENTS` = 写执行器**会记录**的动作。多出来的 `close_issue`
//    由控制面按 plan §7 的确定性条件触发（只读 issue_states），agent 永远不能声明它。
export const ACTION_INTENTS = ['comment', 'label', 'create_issue', 'push_branch'] as const;
export const actionIntentSchema = z.enum(ACTION_INTENTS);
export type ActionIntent = z.infer<typeof actionIntentSchema>;

export const EXECUTOR_ONLY_ACTION_INTENTS = ['close_issue'] as const;
export const EXECUTOR_ACTION_INTENTS = [...ACTION_INTENTS, ...EXECUTOR_ONLY_ACTION_INTENTS] as const;
export const executorActionIntentSchema = z.enum(EXECUTOR_ACTION_INTENTS);
export type ExecutorActionIntent = z.infer<typeof executorActionIntentSchema>;

/** 写执行器对一个动作的处置结果（`actions.audit.status`）。 */
export const ACTION_STATUSES = [
  'applied', // 已写回 GitHub
  'dry-run', // 只测算，没写
  'skipped', // 幂等命中（隐藏标记 / 去重键 / 已有 PR），没有新写
  'rejected', // 写回闸门拒收（writeback_rejected）或 skill outputs 越界
  'failed', // 调用 GitHub 失败
] as const;
export const actionStatusSchema = z.enum(ACTION_STATUSES);
export type ActionStatus = z.infer<typeof actionStatusSchema>;

// ── 被改回的方式（actions.revert_kind，plan §6.5 / tech-plan §7.5）────────────────────────
export const REVERT_KINDS = [
  'label-removed', // issues.unlabeled（人撤掉我们打的标签）
  'changes-requested', // pull_request_review 里 human 的 request_changes
  'pr-closed', // pull_request.closed 且未合并
  'comment-deleted', // 我们的评论被删
  'revert-commit', // 推的提交被 revert
] as const;
export const revertKindSchema = z.enum(REVERT_KINDS);
export type RevertKind = z.infer<typeof revertKindSchema>;

// ── run_events.kind（详情页时间线）────────────────────────────────────────────────────────
export const RUN_EVENT_KINDS = [
  'session', // session/create / attach
  'turn', // turn/start / interrupt / get
  'tool-call', // 工具调用
  'approval', // approval/respond 的判定
  'command', // 容器内命令（含超时处置）
  'sandbox', // 容器生命周期
  'envelope', // 信封校验
  'action', // 写执行器
  'writeback', // 写回闸门（declared ∩ actual）
  'notice', // 其它（异常兜底通知等）
] as const;
export const runEventKindSchema = z.enum(RUN_EVENT_KINDS);
export type RunEventKind = z.infer<typeof runEventKindSchema>;

// ── 面板 API 错误码（`{error:{code,message,details?}}`）──────────────────────────────────
export const ERROR_CODES = [
  'bad-request', // 400 参数不合法
  'unauthorized', // 401 无会话 / 会话过期
  'forbidden', // 403 已登录但不在组织内
  'not-found', // 404 资源不存在
  'conflict', // 409 并发冲突
  'payload-too-large', // 413
  'unprocessable', // 422 语义不合法（例如 from > to）
  'internal', // 500
  'unavailable', // 503 降级（doctor fail / DB 不可用）
] as const;
export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** 错误码 → HTTP 状态。鉴权语义在 `contract-api.md`「鉴权」一节逐条说明。 */
export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  'bad-request': 400,
  unauthorized: 401,
  forbidden: 403,
  'not-found': 404,
  conflict: 409,
  'payload-too-large': 413,
  unprocessable: 422,
  internal: 500,
  unavailable: 503,
};

// ── 仓库配置 / 技能共用的模型名 ───────────────────────────────────────────────────────────
/** `provider/model`，与 `contract-skill.md` §2 的 `model` 约束同源。 */
export const MODEL_NAME_RE = /^[a-z0-9-]+\/[a-z0-9._-]+$/;

/** 技能（命令）的 `outputs` 枚举，与 `contract-skill.md` §2 一致。 */
export const SKILL_OUTPUTS = ['comment', 'labels', 'issue', 'pr'] as const;
export type SkillOutput = (typeof SKILL_OUTPUTS)[number];

/**
 * `outputs` → 允许的信封 intent（`contract-skill.md` §2 的映射表）。
 * `pr` 隐含 `push_branch`（必须带 `paths`）。注意表里没有 `open_pr`：
 * 开 PR 不是一个 intent，是 `push_branch.openPr`。
 */
export const SKILL_OUTPUT_INTENTS: Readonly<Record<SkillOutput, readonly ActionIntent[]>> = {
  comment: ['comment'],
  labels: ['label'],
  issue: ['create_issue'],
  pr: ['push_branch'],
};

/** 技能的允许工具枚举（技术方案 §4.6 的审批矩阵同源；枚举外工具在加载期整份拒绝）。 */
export const SKILL_ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'] as const;
export type SkillAllowedTool = (typeof SKILL_ALLOWED_TOOLS)[number];
