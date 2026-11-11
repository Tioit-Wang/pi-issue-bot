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
// 仓库配置的形状（`repos.settings`）：`PUT /api/repos/*/settings` 的请求体就是它，所以两边必须同源。
import { repoSettingsSchema } from './repo-config.ts';

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

/**
 * `/api/overview` 的查询参数：时间窗 + 可选的 `repo`。
 *
 * 带 `repo` 时 `today.*` / `trend` / `outcomeDistribution` / `failureTop` 全部按该仓库口径算
 * （`webhook_deliveries.repo`、`tasks.repo`）；`queue` 与 `doctor` 是全局量，不随仓库变化。
 */
export const overviewQuerySchema = z
  .object({ ...timeRangeShape, repo: repoFullNameSchema.optional() })
  .strict();

export const overviewResponseSchema = timestamped({
  /** 本次统计的仓库口径；`null` = 全部仓库（不带 `?repo=` 时）。 */
  repo: repoFullNameSchema.nullable(),
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

/**
 * `/api/system` 的仓库行（W3-H 起改读 `repos` 表，不再是 `.github/pi-bot.yml` 快照）。
 *
 * `settingsValid` / `settingsError` 是新名字；`configValid` / `configError` 是**同值别名**，
 * 只为让还没迁移的面板读法（`lib/repos.ts` 的降级路径）继续工作（`docs/impl-multi-repo.md` §0.1：
 * 不推翻既有形状，只加字段）。
 */
export const systemRepoSchema = z
  .object({
    repo: repoFullNameSchema,
    /** `repos.enabled && archived_at is null` */
    enabled: z.boolean(),
    dryRun: z.boolean(),
    /** `repos.settings` 能否被 `repoSettingsSchema` 解析。 */
    settingsValid: z.boolean(),
    settingsError: z.string().max(500).nullable(),
    /** 仓库从哪来：面板手动添加 / GitHub App 安装事件。 */
    source: z.enum(['manual', 'installation']),
    /** 归档时刻；非空 = 不可用（不删行，保留审计与成本历史）。 */
    archivedAt: isoDateTimeSchema.nullable(),
    /** 最近一次活动（`tasks.queued_at` 与 `actions.applied_at` 的 max）；从没跑过为 `null`。 */
    lastActivityAt: isoDateTimeSchema.nullable(),
    /** @deprecated 用 `settingsValid`（同一值的别名，向后兼容保留）。 */
    configValid: z.boolean(),
    /** @deprecated 用 `settingsError`（同一值的别名，向后兼容保留）。 */
    configError: z.string().max(500).nullable(),
  })
  .strict()
  .meta({ id: 'SystemRepo' });

/** `/api/system` 的查询参数：`repo` 只收窄 `repos` / `flags` 两段（其余是全局量）。 */
export const systemQuerySchema = z
  .object({
    /** 只返回这个仓库的行；`flags` 也只留全局 + 该仓库的。 */
    repo: repoFullNameSchema.optional(),
  })
  .strict();

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
  repos: z.array(systemRepoSchema).max(200),
  skills: z.array(skillSummarySchema).max(64),
})
  .strict()
  .meta({ id: 'SystemResponse' });
export type SystemResponse = z.infer<typeof systemResponseSchema>;

// ══════════════════════════════════════════════════════════════════════════════════════════
// 7b. 仓库写面 —— `/api/repos`（列表）、`/api/repos/:owner/:name/settings`（读 / 写）
//
// 多仓库改造后**配置的唯一写入口**（`.github/pi-bot.yml` 已退役，`docs/impl-multi-repo.md` §0.2）。
// 只读的统计接口一律带 `?repo=`，写接口集中在这一组：面板不需要第二套形状。
// ══════════════════════════════════════════════════════════════════════════════════════════

/** `/api/repos` 的一行（`repos` 表的投影，字段与 `listRepos()` 一一对应）。 */
export const repoSummarySchema = z
  .object({
    repo: repoFullNameSchema,
    /** `enabled && archivedAt === null`（归档 = 不可用，但不删行）。 */
    enabled: z.boolean(),
    dryRun: z.boolean(),
    settingsValid: z.boolean(),
    settingsError: z.string().max(500).nullable(),
    /** 最近一次写入 settings 的时刻；从没写过为 `null`。 */
    settingsUpdatedAt: isoDateTimeSchema.nullable(),
    source: z.enum(['manual', 'installation']),
    /** GitHub installation id（bigint 以十进制字符串给出，避免精度丢失）；`manual` 来源为 `null`。 */
    installationId: z.string().min(1).max(32).nullable(),
    archivedAt: isoDateTimeSchema.nullable(),
    /** 行更新时间。 */
    updatedAt: isoDateTimeSchema.nullable(),
  })
  .strict()
  .meta({ id: 'RepoSummary' });
export type RepoSummary = z.infer<typeof repoSummarySchema>;

export const reposResponseSchema = z
  .object({
    /** 全部仓库（`repo_full_name` 升序；排序由面板决定展示顺序）。 */
    items: z.array(repoSummarySchema).max(200),
  })
  .strict()
  .meta({ id: 'ReposResponse' });
export type ReposResponse = z.infer<typeof reposResponseSchema>;

/**
 * 单个仓库的配置视图。GET / PUT / POST 返回**同一个形状**，面板不用分三套解析。
 *
 * `settings` 在 `settingsValid = false` 时为 `null`：库里留着 last-known-good 的原文，
 * 但它不是这个 schema 的形状，硬塞给面板只会让页面在渲染时才炸。
 */
export const repoSettingsResponseSchema = z
  .object({
    repo: repoFullNameSchema,
    enabled: z.boolean(),
    dryRun: z.boolean(),
    settings: repoSettingsSchema.nullable(),
    settingsValid: z.boolean(),
    settingsError: z.string().max(500).nullable(),
    source: z.enum(['manual', 'installation']),
    installationId: z.string().min(1).max(32).nullable(),
    archivedAt: isoDateTimeSchema.nullable(),
  })
  .strict()
  .meta({ id: 'RepoSettingsResponse' });
export type RepoSettingsResponse = z.infer<typeof repoSettingsResponseSchema>;

/**
 * `PUT /api/repos/:owner/:name/settings` 的请求体：就是 settings 本身（校验失败不落库）。
 *
 * 直接用 `repoSettingsSchema`（不另包一层、也不换 meta id）：换 id 会在注册表里给同一个 schema
 * 挂上第二个组件名，OpenAPI 生成时两者会互相覆盖。
 */
export const saveRepoSettingsRequestSchema = repoSettingsSchema;
export type SaveRepoSettingsRequest = z.infer<typeof saveRepoSettingsRequestSchema>;

/** `POST /api/repos` 的请求体：只给 `owner/name`，其余用部署默认（`PI_BOT_DEFAULT_SETTINGS`）。 */
export const addRepoRequestSchema = z
  .object({ repo: repoFullNameSchema })
  .strict()
  .meta({ id: 'AddRepoRequest' });
export type AddRepoRequest = z.infer<typeof addRepoRequestSchema>;

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

// ══════════════════════════════════════════════════════════════════════════════════════════
// 9. 按 issue 聚合的会话视图 —— `GET /api/issues` 与 `GET /api/issues/:owner/:name/:kind/:number`
//    事实源：`docs/spec/ux-issue-sessions.md` §3（字段名与语义照抄，别在这里发明）
// ══════════════════════════════════════════════════════════════════════════════════════════

/**
 * GitHub 参与者标识。**不能复用 `loginSchema`**：App 机器人是 `xxx[bot]`，
 * 方括号不在 `loginSchema` 的正则里，而会话视图必须能显示机器人自己
 * （spec §3.2 的 `participants: ["Tioit-Wang", "pi-issue-bot-tioit[bot]"]`）。
 */
export const actorHandleSchema = z.string().min(1).max(100);

/** issue / PR 的状态；payload 里取不到时为 `unknown`（不是 `null`，面板用一个 chip 显示）。 */
export const issueStateSchema = z.enum(['open', 'closed', 'unknown']);
export type IssueState = z.infer<typeof issueStateSchema>;

/** 人类这一轮的触发渠道：`@` 提及 / `/命令` / 自动（`auto:*` 与 cron）。 */
export const issueTurnChannelSchema = z.enum(['mention', 'command', 'auto']);
export type IssueTurnChannel = z.infer<typeof issueTurnChannelSchema>;

/** 一轮的方向：人类提问 / 机器人产出。 */
export const issueTurnRoleSchema = z.enum(['human', 'bot']);
export type IssueTurnRole = z.infer<typeof issueTurnRoleSchema>;

/**
 * 一次工具调用（来源：`run_events.kind = 'tool.progress'`，按 `cursor` 升序）。
 *
 * `name` 一定是字符串：真库的 `tool.progress` 没有稳定的工具名字段（`payload.tool` 还可能是对象），
 * 取不到时由查询层填 `unknown`——面板不用再判空。
 */
/**
 * 无感反馈台账（`issue_feedback`）的一行 —— 面板用它表达「我收到 / 我做完了 / 我卡住了」。
 *
 * `stage` 的取值来自写入侧（`feedback/stage.ts`）：`received` 是入队时的 `+eyes`，
 * 其余四个是终态（成功 `+rocket`，失败/超时/取消 `+confused`，且都会先 `-eyes`）。
 */
export const issueFeedbackEventSchema = z
  .object({
    stage: z.enum(['received', 'succeeded', 'failed', 'timed-out', 'cancelled']),
    /** reaction 的 content；库里有契约外取值时为 `null`（不猜、也不丢这一行）。 */
    content: z.enum(['eyes', 'rocket', 'confused']).nullable(),
    /** 实际打上 / 摘掉的时刻；dry-run 或计划了没落地为 `null`。 */
    appliedAt: isoDateTimeSchema.nullable(),
    /** 记台账的时刻（`issue_feedback.created_at`）。 */
    at: isoDateTimeSchema,
    /** 打在评论上时的评论 id；打在 issue / PR 主贴时为 `null`。 */
    commentId: z.string().max(64).nullable(),
  })
  .strict()
  .meta({ id: 'IssueFeedbackEvent' });
export type IssueFeedbackEvent = z.infer<typeof issueFeedbackEventSchema>;

/**
 * 打标判定的摘要（`label_decisions`）。
 *
 * 契约里的 `labels` 是**已经落地的标签**；这里补的是「想要什么、为什么没打上」：
 * `desired` 与 `applied` 的差集就是被拦下的部分，`blocked` 按 `blocked_reason` 聚合。
 */
export const issueLabelDecisionSummarySchema = z
  .object({
    /** 最近一次判定的时刻；从没判定过为 `null`。 */
    lastAt: isoDateTimeSchema.nullable(),
    /** 最近一次「想要打」的标签（词表过滤 → 1:N 展开 → 互斥组 → 上限之后）。 */
    desired: z.array(labelNameSchema).max(50),
    /** 最近一次真正打上的标签。 */
    applied: z.array(labelNameSchema).max(50),
    /** 最近一次面向人的一句话理由（面板直接展示）。 */
    reason: z.string().max(500).nullable(),
    /** 被拦原因计数（按 `blocked_reason` 聚合，数量降序，最多 20 条）。 */
    blocked: z
      .array(z.object({ reason: z.string().min(1).max(120), count: countSchema }).strict())
      .max(20),
  })
  .strict()
  .meta({ id: 'IssueLabelDecisionSummary' });
export type IssueLabelDecisionSummary = z.infer<typeof issueLabelDecisionSummarySchema>;

export const issueToolCallSchema = z
  .object({
    /** 工具名（`payload.tool.name` → `payload.tool`（字符串才用）→ `payload.name` → `payload.title`）；取不到为 `unknown`。 */
    name: z.string().min(1).max(200),
    /** 一行摘要（已折叠空白、截到 160 字）；取不到为 `null`。 */
    summary: z.string().max(200).nullable(),
    at: isoDateTimeSchema,
    ok: z.boolean(),
  })
  .strict()
  .meta({ id: 'IssueToolCall' });
export type IssueToolCall = z.infer<typeof issueToolCallSchema>;

/**
 * 会话里的一轮。
 *
 * - 人类：一次任务 = 一轮，`id = task:<taskId>`，正文取触发评论原文（`webhook_deliveries`）。
 * - 机器人：一次任务 = 一轮（**多次 attempt 合并**，`attempts` 只作脚注），`id = run:<最后一次 runId>`。
 *   骨架是 `runs` 而不是 `actions`：dry-run 仓库不写 `actions` 行，但 `envelopes` 一定有。
 *
 * 字段是两种角色的并集（spec §3.2 的例子按角色各写了一部分）：没有意义的字段给 `null`
 * （bot 轮的 `channel`、human 轮的 `failureClass`/`taskId`），不用可选字段——契约 §0 的约定。
 */
export const issueTurnSchema = z
  .object({
    /** `task:<id>` 或 `run:<id>`（React key）。 */
    id: z.string().min(1).max(80),
    role: issueTurnRoleSchema,
    /** 谁说的话；人类 login 或机器人自身（`xxx[bot]`，取不到为 `null`）。 */
    login: actorHandleSchema.nullable(),
    at: isoDateTimeSchema,
    /** 人类轮的触发渠道；机器人轮恒为 `null`。 */
    channel: issueTurnChannelSchema.nullable(),
    /** 正文；都没有为 `null`。 */
    text: z.string().max(40_000).nullable(),
    /** 该轮对应评论的 id（`actions.external_ref`，**不是** URL）；没有为 `null`。 */
    commentId: z.string().max(64).nullable(),
    /** 该轮对应评论的链接（服务端拼 `…/issues/<n>#issuecomment-<id>`）；没有为 `null`。 */
    commentUrl: z.string().max(500).nullable(),
    /** 本轮打过的标签（机器人轮有意义；人类轮为 `[]`）。 */
    labels: z.array(labelNameSchema).max(50),
    /** 任务级状态（`tasks.status` 映射后的契约取值）—— human 与 bot 轮同一个口径。 */
    status: taskStatusSchema,
    /** 该轮 run 的失败分类；未失败为 `null`。 */
    failureClass: failureClassSchema.nullable(),
    /** 这一轮背后的任务 id；**仅供面板跳转 `/tasks/:id`**，不得出现在任何 GitHub 评论里（R2）。 */
    taskId: shortIdSchema.nullable(),
    /** 机器人轮合并了几次 attempt（人类轮恒为 1）；失败那几次只在右栏作脚注。 */
    attempts: z.number().int().min(1),
    /** 工具调用；单轮最多 50 条，超出部分丢弃并把 `truncated` 置 true。 */
    toolCalls: z.array(issueToolCallSchema).max(50),
    /** 该轮工具调用是否被截断（>50 条）。 */
    truncated: z.boolean(),
  })
  .strict()
  .meta({ id: 'IssueTurn' });
export type IssueTurn = z.infer<typeof issueTurnSchema>;

/** 结果分布：键是任务状态，值是任务数（没有出现的状态不占位，故用 partialRecord）。 */
export const issueOutcomeCountsSchema = z.partialRecord(taskStatusSchema, countSchema);

/** 列表的一行 = 一个 `(repo, kind, number)`（只出现被处理过的）。 */
export const issueListItemSchema = z
  .object({
    repo: repoFullNameSchema,
    kind: targetKindSchema,
    number: z.number().int().positive(),
    /** 该 issue 最新一条投递里的标题；取不到为 `null`。 */
    title: z.string().max(500).nullable(),
    /** …html_url；取不到为 `null`。 */
    url: z.string().max(500).nullable(),
    state: issueStateSchema,
    /** `state` 不是来自投递事件时为 true：此时的值从 `issue_states.closed_at` 推断，面板应提示「可能过期」。 */
    stateStale: z.boolean(),
    /** 四源 max：`tasks.queued_at`、`actions.applied_at`、`runs.ended_at`、`bot_labels.applied_at`。 */
    lastActivityAt: isoDateTimeSchema,
    /** 人类触发次数（`tasks.source = 'command'`）。 */
    humanTurns: countSchema,
    /** 自动触发次数（`auto:*` / cron，`tasks.source <> 'command'`）。 */
    autoTurns: countSchema,
    /** 机器人动作次数（`actions` 行数，含 label；与 `runs` 不是同一个口径）。 */
    botTurns: countSchema,
    /**
     * 最后一条**机器人回复**的时间（`actions.intent in ('comment','fallback')` 的 `applied_at` max）。
     * dry-run 仓库不写 `actions` 行 → `null`，面板要当「未知」而不是「没回过」。
     */
    lastReplyAt: isoDateTimeSchema.nullable(),
    /** 最后一次在 issue 里说话的人/机器人的 login（来自投递的 `sender`）；投递过期后为 `null`。 */
    lastActorLogin: z.string().max(100).nullable(),
    /** 「最后说话的是谁」：`human` = `sender.type === 'User'`，`bot` = 其余（Bot/Organization 等）。 */
    lastActorKind: z.enum(['human', 'bot']).nullable(),
    /**
     * **我方欠一个回答**（唯一口径，见 `docs/spec/ux-issue-sessions.md` §3.1）：
     * `state === 'open'` ∧ 最后说话的是人 ∧（没有回复 ∨ 回复早于他这次发言）。
     *
     * 为什么不复用 `issue_states.last_human_reply_at`：那个字段衡量「人欠机器人信息」（needs-info 关闭闸门），
     * 与这里的「机器人欠人回答」是反方向；而且它当前没有任何写入点（恒 NULL）。
     */
    awaitingReply: z.boolean(),
    /** `bot_labels` 里未移除的标签。 */
    labels: z.array(labelNameSchema).max(50),
    outcomes: issueOutcomeCountsSchema,
    /** 最后一条机器人正文前 120 字；没有就用最后一条人类提问；都没有为 `null`。 */
    lastPreview: z.string().max(200).nullable(),
    /**
     * 这个 issue 当前的 reaction 状态（`issue_feedback` 里**最新一个终态**）；
     * 没跑完 / 从没打过 reaction（dry-run）为 `null`。
     */
    reactionState: issueFeedbackEventSchema.nullable(),
    /** 最近一轮打标的判定摘要；从没判定过为 `null`。 */
    labelDecisions: issueLabelDecisionSummarySchema.nullable(),
    /** 反馈时间线（升序，最多 20 条；含 `received` 与各终态）。 */
    feedback: z.array(issueFeedbackEventSchema).max(20),
  })
  .strict()
  .meta({ id: 'IssueListItem' });
export type IssueListItem = z.infer<typeof issueListItemSchema>;

/**
 * 列表页的「派生状态」——**面板与服务端共用同一条定义**，别再各写一套：
 *
 *   running  ⇐ `outcomes.running > 0`
 *   queued   ⇐ 上面不成立且 `outcomes.queued > 0`
 *   failed   ⇐ 上面都不成立且 `failed > 0 && succeeded === 0`（「曾经成功、后来某次失败」不算）
 *   answered ⇐ 上面都不成立且 `succeeded > 0`
 *   idle     ⇐ 以上都没有（只有自动触发、还没跑出结果）
 *
 * 顺序即优先级；面板的 `deriveStatus()` 与 `queries/issues.ts` 的 WHERE 子句都照这个顺序写。
 */
export const issueStatusFilterSchema = z.enum(['running', 'queued', 'failed', 'answered', 'idle']);
export type IssueStatusFilter = z.infer<typeof issueStatusFilterSchema>;

/**
 * `GET /api/issues` 的查询参数。
 *
 * **没有标题搜索参数**：标题只存在于 `webhook_deliveries.payload`（jsonb），按 §0 的约定不做 jsonb 深挖；
 * 按标题检索留给后续的物化列（见 `docs/spec/contract-api.md` §10）。
 */
export const issuesQuerySchema = z
  .object({
    repo: repoFullNameSchema.optional(),
    /** 默认只看 issue；`pr` 是单独一组（spec §1.3 坑 3）。 */
    kind: targetKindSchema.default('issue'),
    /** 派生状态筛选（见 `issueStatusFilterSchema` 的优先级定义）。 */
    status: issueStatusFilterSchema.optional(),
    /** issue 状态筛选；`unknown` 表示「取不到 issue 元数据」。 */
    state: issueStateSchema.optional(),
    /** 「我方欠一个回答」（`awaitingReply`）：服务端按同一口径过滤，面板摘要点进来就是它。 */
    awaiting: z.enum(['true', 'false']).optional(),
    /** 1–100，默认 30（比其它列表小：一屏按会话读）。 */
    limit: z.coerce.number().int().min(1).max(100).default(30),
    cursor: pageCursorSchema,
  })
  .strict();

export const issuesListResponseSchema = timestamped({
  issues: z.array(issueListItemSchema).max(100),
  ...pageInfoShape,
})
  .strict()
  .meta({ id: 'IssuesListResponse' });
export type IssuesListResponse = z.infer<typeof issuesListResponseSchema>;

/** 会话页头部：issue 本身的信息（计数在列表行里）。 */
export const issueSummarySchema = z
  .object({
    repo: repoFullNameSchema,
    kind: targetKindSchema,
    number: z.number().int().positive(),
    title: z.string().max(500).nullable(),
    url: z.string().max(500).nullable(),
    state: issueStateSchema,
    /** 同 `IssueListItem.stateStale`。 */
    stateStale: z.boolean(),
    labels: z.array(labelNameSchema).max(50),
    /** 参与者：人类触发者，以及能解析到的机器人自身（`repos.config.bot.login`，取不到就不列）。 */
    participants: z.array(actorHandleSchema).max(100),
    /** 同 `IssueListItem.reactionState`：这个 issue 当前的 reaction 状态。 */
    reactionState: issueFeedbackEventSchema.nullable(),
    /** 已记台账但**还没落地**的反馈（`applied_at is null`：dry-run 计划 / 排队中），升序最多 20 条。 */
    pendingFeedback: z.array(issueFeedbackEventSchema).max(20),
  })
  .strict()
  .meta({ id: 'IssueSummary' });
export type IssueSummary = z.infer<typeof issueSummarySchema>;

export const issueSessionResponseSchema = timestamped({
  issue: issueSummarySchema,
  /** 全部轮次（`at` 升序；同一时刻人类在前）。 */
  turns: z.array(issueTurnSchema).max(500),
})
  .strict()
  .meta({ id: 'IssueSessionResponse' });
export type IssueSessionResponse = z.infer<typeof issueSessionResponseSchema>;

/**
 * `GET /api/issues/:owner/:name/:kind/:number` 的路径参数。
 *
 * 为什么是四段而不是 `:repo`：`repo` 含 `/`，`:repo` 会吞掉后面的段（spec §3.2 末段）。
 * `number` 用 coerce：路径参数在 HTTP 里是字符串。
 */
export const issueSessionParamsSchema = z
  .object({
    owner: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
    name: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
    kind: targetKindSchema,
    number: z.coerce.number().int().positive(),
  })
  .strict();
export type IssueSessionParams = z.infer<typeof issueSessionParamsSchema>;
