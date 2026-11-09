/**
 * 面板 API 契约（tech-plan §8.3 的 9 个接口）。
 *
 * 只有两种写入口之外的通道：这里全是**只读**（GET）+ 一个 `POST /webhook`。
 * 面板不做任何写操作（MVP 没有「重跑」按钮，`/retry` 走 GitHub 评论指令）。
 *
 * 分文件不划算（子 schema 互相引用），所以集中在 `src/api.ts` 一个文件里，
 * 由 `src/schemas.ts` 给出「接口名 → schema」的注册表供 OpenAPI 生成与单测使用。
 */
import { z } from 'zod';
import { isoDateTimeSchema, isoDateSchema, usdAmountSchema, ratioSchema, countSchema, durationMsSchema, gitShaSchema, repoFullNameSchema, shortIdSchema, labelNameSchema, loginSchema, eventCursorSchema, pageInfoShape, pageLimitSchema, pageCursorSchema, timeRangeShape, timestamped, DEFAULT_PAGE_LIMIT } from './common.ts';
import { actionStatusSchema, executorActionIntentSchema, failureClassSchema, outcomeSchema, revertKindSchema, runEventKindSchema, taskSourceSchema, taskStatusSchema, targetKindSchema, type FailureClass } from './enums.ts';

// ══════════════════════════════════════════════════════════════════════════════════════════
// 可复用的响应片段
// ══════════════════════════════════════════════════════════════════════════════════════════

/** token 与金额的合计。`pricingKnown: false` 时金额只是「已知单价部分」的下限。 */
export const usageTotalsSchema = z
  .object({
    inputTokens: countSchema,
    outputTokens: countSchema,
    costUsd: usdAmountSchema,
    /** 成本覆盖率：参与了单价计算的 run 占全部 run 的比例；价格表缺条目时 < 1。 */
    pricingCoverage: ratioSchema,
  })
  .strict()
  .meta({ id: 'UsageTotals' });
export type UsageTotals = z.infer<typeof usageTotalsSchema>;

/** 按某个维度（仓库 / 命令 / 模型）聚合的一格。`key` 是维度值本身。 */
export const costBucketSchema = z
  .object({
    key: z.string().min(1).max(200),
    inputTokens: countSchema,
    outputTokens: countSchema,
    costUsd: usdAmountSchema,
    /** 该维度下的任务数。 */
    tasks: countSchema,
    /** 该维度下的 run 数（一个任务可能重试多次）。 */
    runs: countSchema,
  })
  .strict()
  .meta({ id: 'CostBucket' });
export type CostBucket = z.infer<typeof costBucketSchema>;

/** 改回率的一格：`rate = reverted / applied`；`applied = 0` 时 `rate` 必须为 `null`（不能用 0 冒充）。 */
export const revertBucketSchema = z
  .object({
    key: z.string().min(1).max(200),
    applied: countSchema,
    reverted: countSchema,
    rate: ratioSchema.nullable(),
  })
  .strict()
  .refine((bucket) => (bucket.applied === 0 ? bucket.rate === null : bucket.rate !== null), {
    message: 'applied = 0 时 rate 必须为 null；applied > 0 时 rate 不能为 null',
    path: ['rate'],
  })
  .meta({ id: 'RevertBucket' });
export type RevertBucket = z.infer<typeof revertBucketSchema>;

// ══════════════════════════════════════════════════════════════════════════════════════════
// 1. GET /api/overview —— 吞吐、结果分布、p50/p95、队列深度、熔断、doctor 摘要
// ══════════════════════════════════════════════════════════════════════════════════════════

/** 统计窗口（服务端默认最近 24h；带 `from`/`to` 时按请求）。 */
export const overviewWindowSchema = z
  .object({ from: isoDateTimeSchema, to: isoDateTimeSchema })
  .strict()
  .meta({ id: 'OverviewWindow' });

/** 「今天」（UTC 自然日 00:00 起）的四个顶部数字。 */
export const overviewTodaySchema = z
  .object({
    /** 收到的 webhook 投递数（含重复投递）。 */
    deliveries: countSchema,
    /** 新建任务数。 */
    tasks: countSchema,
    succeeded: countSchema,
    failed: countSchema,
    /** 成功率；`tasks = 0` 时为 `null`（不是 0）。 */
    successRate: ratioSchema.nullable(),
    /** 耗时分位数；样本为空时为 `null`。 */
    p50Ms: durationMsSchema.nullable(),
    p95Ms: durationMsSchema.nullable(),
    costUsd: usdAmountSchema,
  })
  .strict()
  .meta({ id: 'OverviewToday' });

export const overviewQueueSchema = z
  .object({
    /** 排队中（pg-boss `created`/`retry`）的数量。 */
    depth: countSchema,
    /** 正在执行的数量。 */
    active: countSchema,
    /** 最老的一个排队任务已经等了多久；队列空时为 `null`。 */
    oldestQueuedMs: durationMsSchema.nullable(),
    /** 全局 429 熔断的解除时间（`runtime_flags.rate_limit_pause`）；未熔断为 `null`。 */
    pausedUntil: isoDateTimeSchema.nullable(),
  })
  .strict()
  .meta({ id: 'OverviewQueue' });

export const doctorStatusSchema = z.enum(['ok', 'warn', 'fail', 'unknown', 'not-run']);
export type DoctorStatus = z.infer<typeof doctorStatusSchema>;

export const overviewDoctorSchema = z
  .object({
    status: doctorStatusSchema,
    /** 最近一次 doctor 的时间；从未跑过为 `null`。 */
    checkedAt: isoDateTimeSchema.nullable(),
    /** 未通过的检查项 id（最多 20 条），面板顶部横幅直接用。 */
    failedChecks: z.array(z.string().min(1).max(64)).max(20),
  })
  .strict()
  .meta({ id: 'OverviewDoctor' });

/** 趋势图的一个点（按小时聚合，最近 24 个点）。 */
export const overviewTrendPointSchema = z
  .object({
    /** 该小时的起点（UTC，整点）。 */
    at: isoDateTimeSchema,
    tasks: countSchema,
    succeeded: countSchema,
    failed: countSchema,
  })
  .strict()
  .meta({ id: 'OverviewTrendPoint' });

export const overviewOutcomeCountSchema = z
  .object({ outcome: outcomeSchema, count: countSchema })
  .strict()
  .meta({ id: 'OverviewOutcomeCount' });

export const overviewFailureCountSchema = z
  .object({ failureClass: failureClassSchema, count: countSchema })
  .strict()
  .meta({ id: 'OverviewFailureCount' });

export const overviewQuerySchema = z.object({ ...timeRangeShape }).strict();

export const overviewResponseSchema = timestamped({
  window: overviewWindowSchema,
  today: overviewTodaySchema,
  queue: overviewQueueSchema,
  doctor: overviewDoctorSchema,
  /** 最近 24 小时趋势（按小时升序）。 */
  trend: z.array(overviewTrendPointSchema).max(48),
  /** 结果分布（窗口内）。没有出现的 outcome 不占位。 */
  outcomeDistribution: z.array(overviewOutcomeCountSchema).max(16),
  /** 失败分类 Top5（窗口内，按数量降序）。 */
  failureTop: z.array(overviewFailureCountSchema).max(5),
})
  .strict()
  .meta({ id: 'OverviewResponse' });
export type OverviewResponse = z.infer<typeof overviewResponseSchema>;

// ══════════════════════════════════════════════════════════════════════════════════════════
// 2. GET /api/tasks —— 列表 + 筛选 + 游标分页
// ══════════════════════════════════════════════════════════════════════════════════════════

export const taskListItemSchema = z
  .object({
    id: shortIdSchema,
    repo: repoFullNameSchema,
    source: taskSourceSchema,
    /** 命令：`/review-pr`（命令类）或 `auto:triage` / `auto:compliance`（判定类）。 */
    command: z.string().min(1).max(64),
    targetKind: targetKindSchema,
    targetNumber: z.number().int().positive(),
    /** 没有提交可锚时为 `null`（issue 判定类）。 */
    headSha: gitShaSchema.nullable(),
    status: taskStatusSchema,
    /** 失败原因；未失败为 `null`。 */
    failureClass: failureClassSchema.nullable(),
    /** run 结果维度；任务没跑到有 run 时为 `null`。 */
    outcome: outcomeSchema.nullable(),
    /** 触发人 login；cron 任务为 `null`。 */
    actorLogin: loginSchema.nullable(),
    queuedAt: isoDateTimeSchema,
    startedAt: isoDateTimeSchema.nullable(),
    endedAt: isoDateTimeSchema.nullable(),
    /** 耗时；未结束为 `null`。 */
    durationMs: durationMsSchema.nullable(),
    /** 成本；没有 usage 为 `null`，跑了但免费为 0。 */
    costUsd: usdAmountSchema.nullable(),
    dryRun: z.boolean(),
  })
  .strict()
  .meta({ id: 'TaskListItem' });
export type TaskListItem = z.infer<typeof taskListItemSchema>;

/** `/api/tasks` 的筛选参数。参数名与面板 URL 查询参数一一对应（`from`/`to` 一律 ISO8601 UTC）。 */
export const tasksQuerySchema = z
  .object({
    repo: repoFullNameSchema.optional(),
    status: taskStatusSchema.optional(),
    failureClass: failureClassSchema.optional(),
    command: z.string().min(1).max(64).optional(),
    from: isoDateTimeSchema.optional(),
    to: isoDateTimeSchema.optional(),
    cursor: pageCursorSchema,
    limit: pageLimitSchema,
  })
  .strict();

export const tasksResponseSchema = z
  .object({
    items: z.array(taskListItemSchema).max(200),
    ...pageInfoShape,
    /** 满足筛选条件的总条数估计（`count(*)` 的缓存值）；未统计好时为 `null`。 */
    totalEstimate: countSchema.nullable(),
  })
  .strict()
  .meta({ id: 'TasksResponse' });
export type TasksResponse = z.infer<typeof tasksResponseSchema>;

// ══════════════════════════════════════════════════════════════════════════════════════════
// 3. GET /api/tasks/:id —— 详情：runs、事件时间线、信封、动作、diff
// ══════════════════════════════════════════════════════════════════════════════════════════

/** 一次执行（`runs` 一行）。重试会产生多行，`attempt` 从 0 起。 */
export const runSummarySchema = z
  .object({
    id: shortIdSchema,
    attempt: countSchema,
    /** RACP session/turn 标识；未建立为 `null`。 */
    sessionId: z.string().min(1).max(128).nullable(),
    turnId: z.string().min(1).max(128).nullable(),
    startedAt: isoDateTimeSchema.nullable(),
    endedAt: isoDateTimeSchema.nullable(),
    outcome: outcomeSchema.nullable(),
    failureClass: failureClassSchema.nullable(),
    /** 观测到的其余信号（优先级较低的分类、容器退出码等），供审计，不参与决策。 */
    failureDetail: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict()
  .meta({ id: 'RunSummary' });
export type RunSummary = z.infer<typeof runSummarySchema>;

/** 事件时间线一行（`run_events`）。`cursor` 单调递增，可用来断线重放。 */
export const runEventSchema = z
  .object({
    runId: shortIdSchema,
    cursor: eventCursorSchema,
    kind: runEventKindSchema,
    at: isoDateTimeSchema,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict()
  .meta({ id: 'RunEvent' });
export type RunEventRecord = z.infer<typeof runEventSchema>;

/** 判定证据一条：命中的规则 + 原文片段（plan §5 的 `evidence`）。 */
export const verdictEvidenceSchema = z
  .object({
    rule: z.string().min(1).max(120),
    quote: z.string().min(1).max(2000),
    /** 该规则是否通过；判定类技能必填，只做分类时为 `null`。 */
    passed: z.boolean().nullable(),
  })
  .strict()
  .meta({ id: 'VerdictEvidence' });

export const verdictSchema = z
  .object({
    kind: z.enum(['issue', 'pr']),
    labels: z.array(labelNameSchema).max(16),
    evidence: z.array(verdictEvidenceSchema).max(32),
  })
  .strict()
  .meta({ id: 'Verdict' });
export type Verdict = z.infer<typeof verdictSchema>;

/**
 * 信封入库记录（`envelopes` 一行）。校验失败的也留（`valid: false`，面板要能看到坏输出）。
 */
export const envelopeRecordSchema = z
  .object({
    runId: shortIdSchema,
    valid: z.boolean(),
    /** 校验失败或没有 verdict 时为 `null`。 */
    verdict: verdictSchema.nullable(),
    /** 动作条数（含被丢弃的）；原始正文不重复给出，走 run_events 的 `envelope` 事件。 */
    actionCount: countSchema,
    usage: z
      .object({ inputTokens: countSchema, outputTokens: countSchema, costUsd: usdAmountSchema })
      .strict(),
  })
  .strict()
  .meta({ id: 'EnvelopeRecord' });
export type EnvelopeRecord = z.infer<typeof envelopeRecordSchema>;

/** 写执行器的一行（`actions`）。`close_issue` 只会出现在这里，不会出现在信封里。 */
export const actionRecordSchema = z
  .object({
    id: shortIdSchema,
    runId: shortIdSchema,
    intent: executorActionIntentSchema,
    status: actionStatusSchema,
    /** 动作对象：issue/PR 编号或分支名。 */
    target: z
      .object({
        kind: z.enum(['issue', 'pr', 'comment', 'branch']),
        /** `comment`/`branch` 没有编号时必须为 `null`。 */
        number: z.number().int().positive().nullable(),
        ref: z.string().min(1).max(200).nullable(),
        /** GitHub 侧链接；dry-run 或未写成时为 `null`。 */
        url: z.string().min(1).max(500).nullable(),
      })
      .strict(),
    /** 外部引用（评论 id、commit sha、PR 号）；未写成为 `null`。 */
    externalRef: z.string().min(1).max(200).nullable(),
    appliedAt: isoDateTimeSchema.nullable(),
    revertedAt: isoDateTimeSchema.nullable(),
    revertKind: revertKindSchema.nullable(),
    /** 写回闸门的四个集合摘要（tech-plan §5.6）；非 push 类动作为 `null`。 */
    audit: z
      .object({
        declared: z.array(z.string().max(400)).max(200),
        actual: z.array(z.string().max(400)).max(200),
        intersect: z.array(z.string().max(400)).max(200),
        dropped: z.array(z.string().max(400)).max(200),
        /** `writeback_rejected` 的原因；未拒收为 `null`。 */
        rejectedReason: z.string().max(500).nullable(),
      })
      .strict()
      .nullable(),
    dryRun: z.boolean(),
  })
  .strict()
  .meta({ id: 'ActionRecord' });
export type ActionRecord = z.infer<typeof actionRecordSchema>;

/** worktree diff（来自 `workspace/diff`，不用容器内 git 产出，tech-plan R9）。 */
export const taskDiffSchema = z
  .object({
    available: z.boolean(),
    /** unified diff 原文；不可用或为空时为 `null`。 */
    text: z.string().nullable(),
    /** 超过 200 KB 被截断（面板显示提示，不提供全文）。 */
    truncated: z.boolean(),
    baseSha: gitShaSchema.nullable(),
    headSha: gitShaSchema.nullable(),
  })
  .strict()
  .meta({ id: 'TaskDiff' });

export const taskDetailResponseSchema = z
  .object({
    task: taskListItemSchema,
    runs: z.array(runSummarySchema).max(20),
    /** 事件时间线（按 cursor 升序）。详情页只取最近 500 条。 */
    events: z.array(runEventSchema).max(500),
    /** 每次 run 的信封（按 runs 顺序）。 */
    envelopes: z.array(envelopeRecordSchema).max(20),
    actions: z.array(actionRecordSchema).max(100),
    diff: taskDiffSchema,
  })
  .strict()
  .meta({ id: 'TaskDetailResponse' });
export type TaskDetailResponse = z.infer<typeof taskDetailResponseSchema>;

// ══════════════════════════════════════════════════════════════════════════════════════════
// 4. GET /api/costs —— 按仓库/命令/模型拆分 + 最贵十个任务
// ══════════════════════════════════════════════════════════════════════════════════════════

export const costSeriesPointSchema = z
  .object({ day: isoDateSchema, costUsd: usdAmountSchema, inputTokens: countSchema, outputTokens: countSchema })
  .strict()
  .meta({ id: 'CostSeriesPoint' });

export const costTopTaskSchema = z
  .object({
    taskId: shortIdSchema,
    repo: repoFullNameSchema,
    command: z.string().min(1).max(64),
    costUsd: usdAmountSchema,
    inputTokens: countSchema,
    outputTokens: countSchema,
    endedAt: isoDateTimeSchema.nullable(),
  })
  .strict()
  .meta({ id: 'CostTopTask' });

export const costsQuerySchema = z
  .object({
    ...timeRangeShape,
    repo: repoFullNameSchema.optional(),
    /** 返回多少个最贵任务，默认 10，上限 50。 */
    top: z.coerce.number().int().min(1).max(50).default(10),
  })
  .strict();

export const costsResponseSchema = timestamped({
  window: overviewWindowSchema,
  currency: z.literal('USD'),
  total: usageTotalsSchema,
  byRepo: z.array(costBucketSchema).max(100),
  byCommand: z.array(costBucketSchema).max(100),
  byModel: z.array(costBucketSchema).max(100),
  /** 按日聚合（来自 metrics_daily，可以跨越 90 天明细保留期）。 */
  series: z.array(costSeriesPointSchema).max(400),
  topTasks: z.array(costTopTaskSchema).max(50),
})
  .strict()
  .meta({ id: 'CostsResponse' });
export type CostsResponse = z.infer<typeof costsResponseSchema>;

// ══════════════════════════════════════════════════════════════════════════════════════════
// 5. GET /api/quality/reverts —— 改回次数与比例，按命令与仓库
// ══════════════════════════════════════════════════════════════════════════════════════════

export const revertRecordSchema = z
  .object({
    actionId: shortIdSchema,
    taskId: shortIdSchema,
    repo: repoFullNameSchema,
    command: z.string().min(1).max(64),
    intent: executorActionIntentSchema,
    revertKind: revertKindSchema,
    appliedAt: isoDateTimeSchema,
    revertedAt: isoDateTimeSchema,
    /** 被改回的那个 GitHub 对象链接。 */
    url: z.string().min(1).max(500).nullable(),
  })
  .strict()
  .meta({ id: 'RevertRecord' });

export const qualityQuerySchema = z
  .object({
    ...timeRangeShape,
    repo: repoFullNameSchema.optional(),
    command: z.string().min(1).max(64).optional(),
    cursor: pageCursorSchema,
    limit: pageLimitSchema,
  })
  .strict();

export const revertsResponseSchema = timestamped({
  window: overviewWindowSchema,
  /** 口径：置位的 actions / 已应用的 actions（tech-plan §7.5 末段）。 */
  overall: z
    .object({ applied: countSchema, reverted: countSchema, rate: ratioSchema.nullable() })
    .strict(),
  byCommand: z.array(revertBucketSchema).max(100),
  byRepo: z.array(revertBucketSchema).max(100),
  records: z.array(revertRecordSchema).max(200),
  ...pageInfoShape,
})
  .strict()
  .meta({ id: 'RevertsResponse' });
export type RevertsResponse = z.infer<typeof revertsResponseSchema>;

// ══════════════════════════════════════════════════════════════════════════════════════════
// 6. GET /api/audit —— 谁触发、跑哪个 sha、写了什么、审批判定
// ══════════════════════════════════════════════════════════════════════════════════════════

export const auditRowSchema = z
  .object({
    /** 审计行 id（`actions.id`）。 */
    id: shortIdSchema,
    at: isoDateTimeSchema,
    repo: repoFullNameSchema,
    taskId: shortIdSchema,
    runId: shortIdSchema.nullable(),
    /** 谁触发（`tasks.actor_login` 与投递里的 association，入队时写死）。 */
    actor: z
      .object({
        login: loginSchema.nullable(),
        association: z.enum(['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'NONE', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR', 'MANNEQUIN']).nullable(),
      })
      .strict(),
    command: z.string().min(1).max(64),
    target: z
      .object({
        kind: z.enum(['issue', 'pr', 'comment', 'branch']),
        number: z.number().int().positive().nullable(),
        ref: z.string().min(1).max(200).nullable(),
      })
      .strict(),
    intent: executorActionIntentSchema,
    status: actionStatusSchema,
    /** 跑的是哪个提交（没有提交可锚时为 `null`）。 */
    headSha: gitShaSchema.nullable(),
    externalRef: z.string().min(1).max(200).nullable(),
    /** 审批判定（`approval/respond`）；本次没有工具调用被审批时为 `null`。 */
    approval: z
      .object({
        tool: z.string().min(1).max(64),
        decision: z.enum(['allow', 'deny']),
        /** 命中矩阵里的哪条规则，例如 `read-only` / `deny-web-tools`。 */
        rule: z.string().min(1).max(120),
      })
      .strict()
      .nullable(),
    revertedAt: isoDateTimeSchema.nullable(),
    revertKind: revertKindSchema.nullable(),
    dryRun: z.boolean(),
  })
  .strict()
  .meta({ id: 'AuditRow' });
export type AuditRow = z.infer<typeof auditRowSchema>;

export const auditQuerySchema = z
  .object({
    ...timeRangeShape,
    repo: repoFullNameSchema.optional(),
    command: z.string().min(1).max(64).optional(),
    intent: executorActionIntentSchema.optional(),
    cursor: pageCursorSchema,
    limit: pageLimitSchema,
  })
  .strict();

export const auditResponseSchema = z
  .object({
    items: z.array(auditRowSchema).max(200),
    ...pageInfoShape,
    /** 命中条数超过导出口径（见 `contract-api.md`）时为 true，面板提示「请缩小范围」。 */
    truncated: z.boolean(),
    /** 单次导出上限（行），面板据此提示。 */
    exportLimit: countSchema,
  })
  .strict()
  .meta({ id: 'AuditResponse' });
export type AuditResponse = z.infer<typeof auditResponseSchema>;

/**
 * `GET /api/audit/export.csv` 的列（顺序即表头顺序）。
 * CSV 不是 JSON，不进 OpenAPI 的 schema 体系，但列名要与 `auditRowSchema` 一一对应，
 * 所以列清单放这里，由 `contract-api.md` 与面板导出代码共同引用。
 */
export const AUDIT_CSV_COLUMNS = [
  'id',
  'at',
  'repo',
  'task_id',
  'run_id',
  'actor_login',
  'actor_association',
  'command',
  'target_kind',
  'target_number',
  'target_ref',
  'intent',
  'status',
  'head_sha',
  'external_ref',
  'approval_tool',
  'approval_decision',
  'approval_rule',
  'reverted_at',
  'revert_kind',
  'dry_run',
] as const;
export type AuditCsvColumn = (typeof AUDIT_CSV_COLUMNS)[number];

/** 单次 CSV 导出的行数上限（超过就截断并在响应头给出提示）。 */
export const AUDIT_EXPORT_LIMIT = 50_000;

// ══════════════════════════════════════════════════════════════════════════════════════════
// 7. GET /api/system —— host 版本/能力、pi-host 状态、队列配置、保留期
// ══════════════════════════════════════════════════════════════════════════════════════════

export const doctorCheckSchema = z
  .object({
    /** 检查项 id（`docker-daemon` / `disk-space` / `canary-network` / `pin-sha256` / `exec-roundtrip` …）。 */
    id: z.string().min(1).max(64),
    status: z.enum(['ok', 'warn', 'fail', 'skip']),
    /** 一句话说明（失败原因 / 观测值）；无补充为 `null`。 */
    detail: z.string().max(500).nullable(),
  })
  .strict()
  .meta({ id: 'DoctorCheck' });

export const skillSummarySchema = z
  .object({
    /** 归一化后的命令名，例如 `/review-pr`。 */
    name: z.string().min(1).max(33),
    source: z.enum(['builtin', 'repo']),
    /** `false` 表示该命令不可用（契约 §3：被禁用的技能仍要在面板可见）。 */
    enabled: z.boolean(),
    /** 禁用原因（`skill_invalid` / `skill_conflict` / `repo-config-missing` …）；可用为 `null`。 */
    disabledReason: z.string().max(200).nullable(),
    /** 生效的 `outputs`（用于解释「为什么这个命令不会推分支」）。 */
    outputs: z.array(z.enum(['comment', 'labels', 'issue', 'pr'])).max(4),
    /** 生效的单任务超时（已被截断到 30m 上限时等于上限）。 */
    timeoutMs: durationMsSchema,
  })
  .strict()
  .meta({ id: 'SkillSummary' });

export const systemResponseSchema = timestamped({
  version: z
    .object({
      /** 本程序版本。 */
      app: z.string().min(1).max(32),
      /** 契约版本（`CONTRACT_VERSION`），面板可据此提示「后端已升级」。 */
      contract: z.string().min(1).max(32),
      /** 协商出的 pi-host 版本；未连上为 `null`。 */
      host: z.string().min(1).max(64).nullable(),
      /** `PIN.json` 的哈希校验是否通过（tech-plan §2.2）。 */
      hostPinned: z.boolean(),
    })
    .strict(),
  /** RACP 握手常量（tech-plan §4.2 / E2）。 */
  protocol: z
    .object({
      wsPath: z.string().min(1).max(200),
      wsSubprotocol: z.string().min(1).max(100),
    })
    .strict(),
  host: z
    .object({
      status: z.enum(['ok', 'degraded', 'down', 'unknown']),
      lastPingAt: isoDateTimeSchema.nullable(),
      sessions: countSchema,
    })
    .strict(),
  doctor: z
    .object({
      status: doctorStatusSchema,
      checkedAt: isoDateTimeSchema.nullable(),
      checks: z.array(doctorCheckSchema).max(64),
    })
    .strict(),
  queue: z
    .array(
      z
        .object({
          name: z.string().min(1).max(64),
          pending: countSchema,
          active: countSchema,
          retryLimit: countSchema,
          /** job 存活上限（`expireIn`，注意它不等于排队时长，tech-plan §5.3 F5）。 */
          expireInMs: durationMsSchema,
        })
        .strict(),
    )
    .max(32),
  retention: z
    .object({
      webhookDays: countSchema,
      runEventDays: countSchema,
      transcriptDays: countSchema,
      /** 指标永久（tech-plan §7.6）：固定为 true，面板据此不显示「保留期」。 */
      metricsForever: z.boolean(),
    })
    .strict(),
  /** `runtime_flags`（全局熔断 / 暂停开关）。 */
  flags: z
    .array(
      z
        .object({
          key: z.string().min(1).max(64),
          value: z.string().max(200),
          until: isoDateTimeSchema.nullable(),
        })
        .strict(),
    )
    .max(32),
  repos: z
    .array(
      z
        .object({
          repo: repoFullNameSchema,
          enabled: z.boolean(),
          dryRun: z.boolean(),
          /** `.github/pi-bot.yml` 是否通过 schema 校验。 */
          configValid: z.boolean(),
          configError: z.string().max(500).nullable(),
        })
        .strict(),
    )
    .max(200),
  skills: z.array(skillSummarySchema).max(64),
})
  .strict()
  .meta({ id: 'SystemResponse' });
export type SystemResponse = z.infer<typeof systemResponseSchema>;

// ══════════════════════════════════════════════════════════════════════════════════════════
// 8. POST /webhook —— GitHub 投递（唯一写入口，但只入队）
// ══════════════════════════════════════════════════════════════════════════════════════════

/**
 * 应答体。**10 秒内必须返回**（plan §6.4）：排队与执行都在应答之后发生。
 * 重复投递返回同一形状的 `duplicate: true`，HTTP 仍为 200（GitHub 会看 2xx 决定是否重投）。
 */
export const webhookAcceptedResponseSchema = z
  .object({
    status: z.literal('accepted'),
    /** `X-GitHub-Delivery`。 */
    deliveryId: z.string().min(1).max(128),
    /** 本次投递建出来的任务 id；没有建任务（忽略 / 重复）时为 `null`。 */
    taskId: shortIdSchema.nullable(),
    /** 是否命中 `webhook_deliveries` 去重（同一 delivery 重投）。 */
    duplicate: z.boolean(),
    /** 处置结论。 */
    action: z.enum(['enqueued', 'duplicate', 'ignored', 'unauthorized', 'paused']),
    /** 给评论回复用的确认文案（命令类才有）；其余为 `null`。 */
    ackComment: z.string().max(500).nullable(),
  })
  .strict()
  .meta({ id: 'WebhookAcceptedResponse' });
export type WebhookAcceptedResponse = z.infer<typeof webhookAcceptedResponseSchema>;

/** 请求头里我们真正依赖的三个字段（其余不校验）。 */
export const webhookHeadersSchema = z
  .object({
    'x-github-delivery': z.string().min(1).max(128),
    'x-github-event': z.string().min(1).max(64),
    'x-hub-signature-256': z.string().regex(/^sha256=[0-9a-f]{64}$/),
  })
  .strict();

/** 默认分页大小，导出给面板/MSW 用（避免两边各写一个 50）。 */
export const DEFAULT_LIMIT = DEFAULT_PAGE_LIMIT;

/** 失败分类列表的稳定顺序（面板图例按它排序，避免每次请求颜色乱跳）。 */
export const FAILURE_CLASS_DISPLAY_ORDER: readonly FailureClass[] = [
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
];
