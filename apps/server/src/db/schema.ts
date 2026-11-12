/**
 * 数据模型唯一事实源 —— docs/tech-plan.md §7.2 的 16 张表 + 多仓库改造新增的 4 张表 + v0.3 issue agent 的 3 张表。
 *
 * 约定（本文件是后续 `queries/`、`worker/`、`http/` 的共同底座，改列名等于改契约）：
 *  - 列名 snake_case，TS 字段 camelCase；时间列一律 `timestamptz`（§7.2「时间列一律带时区」）。
 *  - **不建外键**：保留期清理（§7.6）与队列重投会跨表删改，外键只会把「删一行」变成「先解一堆约束」；
 *    关联完整性由写入方（worker）在同一事务里保证，面板查询只读不依赖级联。
 *  - `tasks` 的 `command` / `actor_login` / `queued_at` 三列**入队时写死**（§5.3 第 6 步、F9），
 *    面板的按命令拆分、按触发人审计都直接读列，不在查询期解 jsonb。
 *  - 本文件**不引入 `@pi-issue-bot/contract`**：数据层零契约依赖，schema 就是数据库的真相。
 *
 * 迁移产物在仓库根 `migrations/`（序号规则见 docs/spec/dev-setup.md §5，M0 段 0000–0099）。
 */
import { getTableName, sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** 任务状态取值（写库处引用这些常量，避免各模块各写一份字符串）。 */
export const TASK_STATUS = {
  /** 已入队、尚未被执行器取走 —— 排队闸门（§4.7 第三行）只扫这个状态 */
  queued: 'queued',
  /** 执行器已取走，正在跑 */
  running: 'running',
  /** 成功结束 */
  succeeded: 'succeeded',
  /** 失败结束（具体原因见 runs.failure_class） */
  failed: 'failed',
  /** 任务级超时（plan §9.1「记 timed-out」，不自动重试） */
  timedOut: 'timed-out',
  /** 排队超 10min 被闸门取消（§4.7） */
  cancelledQueue: 'cancelled_queue',
  /** 其他取消（人工 /retry 覆盖、停机） */
  cancelled: 'cancelled',
} as const;

/** `tasks.source`：任务从哪来。 */
export const TASK_SOURCE = {
  webhook: 'webhook',
  command: 'command',
  cron: 'cron',
  /** v0.3 的 issue agent（事件 opened/edited 与 `@别名` 提及） */
  agent: 'agent',
} as const;

/** `tasks.target_kind`：任务指向的对象类型。 */
export const TARGET_KIND = {
  issue: 'issue',
  pr: 'pr',
} as const;

/** `runtime_flags` 的已知 key（§7.4 全局 429 熔断等）。 */
export const RUNTIME_FLAG_KEY = {
  /** 全局 429 熔断：连续 5 次 429 → 暂停 15min，worker 取任务前读 */
  rateLimitPause: 'rate_limit_pause',
} as const;

/** 一次运行的 `failure_class` 取值（优先级见 queue/failure-class.ts，与 §7.3 表格一一对应）。 */
export const FAILURE_CLASS = {
  timeout: 'timeout',
  interrupt: 'interrupt',
  degenerateOutput: 'degenerate-output',
  sandboxOom: 'sandbox-oom',
  sandboxCrash: 'sandbox-crash',
  auth: 'auth',
  rateLimit: 'rate_limit',
  model: 'model',
  parse: 'parse',
  githubApi: 'github_api',
  unknown: 'unknown',
} as const;

/** webhook 去重 + 90 天原文保留 + replay 数据源（§5.3 第 3 步的主幂等点）。 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    /** GitHub 投递 id（`X-GitHub-Delivery`），主幂等键 */
    deliveryId: text('delivery_id').primaryKey(),
    /** `X-GitHub-Event`，如 `issues` */
    event: text('event').notNull(),
    /** payload 里的 `action`，如 `opened`；部分事件没有 */
    action: text('action'),
    /**
     * 投递属于哪个仓库（`owner/name`）。
     * 可空：载荷里没有仓库、或还没解析出来时留 NULL；**未知仓库的投递也写这一列**（W1-B 排查用）。
     */
    repo: text('repo'),
    /** 原始 payload 原文，replay 直接用它重放（plan §10「本地可复现」） */
    payload: jsonb('payload').notNull(),
    /** 验签结果：验签失败也落库（审计要求），但不入队 */
    signatureValid: boolean('signature_valid').notNull().default(true),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 保留期清理（90 天）按接收时间扫
    index('webhook_deliveries_received_at_idx').on(t.receivedAt),
    // 面板审计按事件类型过滤
    index('webhook_deliveries_event_action_idx').on(t.event, t.action),
    // 「这个仓库最近的投递」：安装/调试面板按仓库翻审计
    index('webhook_deliveries_repo_received_at_idx').on(t.repo, t.receivedAt),
  ],
);

/**
 * 仓库行 —— 多仓库改造后的**配置与开关的唯一载体**。
 *
 * `.github/pi-bot.yml` 已整体退役（`docs/impl-multi-repo.md` §0.2）：配置只存在于 `settings`（jsonb，
 * 形状 = `repoSettingsSchema`），由面板写入；新建仓库时用部署默认（`PI_BOT_DEFAULT_SETTINGS`）seed。
 *
 * `config / config_valid / config_error` 是过渡期列（W1 之后不再读，W3 可删），保留它们是为了让
 * 尚未迁移的查询侧（`queries/system.ts` 等）继续编译与读数据。
 */
export const repos = pgTable('repos', {
  /** `owner/name`，全库唯一 */
  repoFullName: text('repo_full_name').primaryKey(),
  /** 机器人对该仓库是否启用（`settings_valid=false` 或归档都视为不可用） */
  enabled: boolean('enabled').notNull().default(true),
  /** 首周强制 dry-run（plan §11 M1 观察期）；与 `settings.dry_run` 保持同步（写 settings 时一并更新） */
  dryRun: boolean('dry_run').notNull().default(true),
  /** 仓库归档时刻；非空 = 不可用（不删行，保留审计与成本历史） */
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  /** 全部配置（`repoSettingsSchema` 的形状）。缺省 `{}` = 全默认值 */
  settings: jsonb('settings').notNull().default({}),
  /** `settings` 是否能被 schema 解析；false 时 webhook 忽略该仓库的投递 */
  settingsValid: boolean('settings_valid').notNull().default(true),
  /** 解析失败的原因（面板展示；截断到 500 字） */
  settingsError: text('settings_error'),
  /** 最近一次写入 `settings` 的时刻 */
  settingsUpdatedAt: timestamp('settings_updated_at', { withTimezone: true }),
  /** 仓库从哪来：`manual`（面板手动添加）/ `installation`（GitHub App 安装事件） */
  source: text('source').notNull().default('manual'),
  /** GitHub App 的 installation id（`installation` 来源才有） */
  installationId: bigint('installation_id', { mode: 'number' }),
  /** @deprecated 过渡期列：旧 `.github/pi-bot.yml` 快照，W1 之后不再读写 */
  config: jsonb('config'),
  /** @deprecated 过渡期列：旧配置是否合法 */
  configValid: boolean('config_valid').notNull().default(false),
  /** @deprecated 过渡期列：旧配置错误原因 */
  configError: text('config_error'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // 安装生命周期事件按 installation_id 批量停用（W1-B）
  index('repos_installation_id_idx').on(t.installationId),
  // 面板列表默认按更新时间倒序
  index('repos_updated_at_idx').on(t.updatedAt),
]);

/** `repos.source` 的取值。 */
export const REPO_SOURCE = {
  /** 面板手动添加（`POST /api/repos`） */
  manual: 'manual',
  /** GitHub App 安装事件带进来的 */
  installation: 'installation',
} as const;

/**
 * 任务主体。**入队即定型**：`command` / `actor_login` / `queued_at` 由 webhook handler
 * 在第 6 步写死（§5.3、F9），worker 不得回填。
 */
export const tasks = pgTable(
  'tasks',
  {
    /** 任务 id（`crypto.randomUUID()`），也是 pg-boss 的 `singletonKey` */
    id: text('id').primaryKey(),
    /** webhook / command / cron */
    source: text('source').notNull(),
    /** `owner/name` */
    repo: text('repo').notNull(),
    /** issue / pr */
    targetKind: text('target_kind').notNull(),
    /** issue 或 PR 号 */
    targetNumber: integer('target_number').notNull(),
    /** 目标提交；判定类任务可为空（issue 判定用 missing_set_hash 锚定） */
    headSha: text('head_sha'),
    /**
     * issue/PR 标题与正文的**入队时快照**（`docs/plan-fixed-pipeline.md` §4.2）。
     *
     * 为什么不读 `webhook_deliveries.payload`：那批原文只留 90 天（§7.6），而阶段任务可能在
     * `awaiting_info` 里等用户补充好几天；快照随任务走，不受保留期影响，也不产生额外 API 调用。
     * `target_body` 入队时截到 8000 字符（`PIPELINE_TARGET_BODY_MAX_CHARS`），进提示词时再截 4000。
     */
    targetTitle: text('target_title'),
    targetBody: text('target_body'),
    /**
     * 补充评论段（E4「评论优先」）：`[{author, body, commentId, createdAt}]` 形状的 **jsonb 数组**。
     * 不混进 `target_body`：正文与补充要分开渲染（补充置顶），且补充只留最近 3 条 × 每条 1000 字符。
     * 默认 `[]` 而不是 NULL：读侧不必分支判断，`jsonb_array_elements` 也只在数组上成立。
     */
    targetSupplement: jsonb('target_supplement').notNull().default([]),
    /**
     * 这条 agent 任务**点名**的技能 id（`["label-triage"]`，不带前导 `/`）。
     *
     * 为什么落库：消息组装时 `@bot /label-triage` 里的 token 已被摘掉并改写成一句指令，
     * 装配层从正文里再也找不到它（issue #26）。
     */
    agentSkillIds: jsonb('agent_skill_ids').notNull().default([]),
    /** 命令名：`/review-pr` 等；固定流水线的阶段任务记 `pipeline:format|classify|notice`（§4.6） */
    command: text('command').notNull(),
    /** 触发者 GitHub login；`/retry` 与 webhook 重投靠它区分（§7.2） */
    actorLogin: text('actor_login').notNull(),
    /** 入队时刻：排队闸门按它算等待时长（§4.7），`now() - queued_at > 10min` */
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    /** 任务级幂等键（§7.2 公式，见 queue/idempotency.ts），unique */
    idempotencyKey: text('idempotency_key').notNull(),
    /** TASK_STATUS 之一 */
    status: text('status').notNull().default(TASK_STATUS.queued),
    /** 任务容器名 `pi-job-<taskId>`（§6.3 生命周期清理按它找孤儿容器） */
    containerName: text('container_name'),
    /** 已尝试次数（`/retry` 与自动重投都会 +1，供面板看次数分布） */
    attempt: integer('attempt').notNull().default(0),
    /** webhook 原文外键（可空：cron 任务没有投递记录） */
    deliveryId: text('delivery_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** 结局时刻（成功/失败/取消/超时都写） */
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    // 任务级幂等落在唯一索引上，不靠内存去重（§5.3）
    uniqueIndex('tasks_idempotency_key_uidx').on(t.idempotencyKey),
    // 排队闸门每分钟扫 `status='queued' and now()-queued_at > 10min`
    index('tasks_status_queued_at_idx').on(t.status, t.queuedAt),
    // 面板列表：按仓库 + 时间范围
    index('tasks_repo_created_at_idx').on(t.repo, t.createdAt),
    // 面板列表：按命令类型与目标过滤
    index('tasks_command_idx').on(t.command),
    index('tasks_target_idx').on(t.repo, t.targetKind, t.targetNumber),
  ],
);

/** 一次执行（一个任务可能多次尝试）。失败分类是面板的统计维度。 */
export const runs = pgTable(
  'runs',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull(),
    /** 第几次尝试，从 1 起 */
    attempt: integer('attempt').notNull().default(1),
    /** RACP `session/create` 返回的会话 id */
    sessionId: text('session_id'),
    /** 本轮 turn id */
    turnId: text('turn_id'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /** 结局：succeeded / failed / timed-out / cancelled / degenerate-output …… */
    outcome: text('outcome'),
    /** 最高优先级的失败分类（§7.3，重试决策只读它） */
    failureClass: text('failure_class'),
    /** 其余观测到的全部信号（审计用，不参与重试决策） */
    failureDetail: jsonb('failure_detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('runs_task_id_idx').on(t.taskId),
    // 面板趋势 / 聚合任务：按 outcome + 时间窗直查（§7.6）
    index('runs_outcome_started_at_idx').on(t.outcome, t.startedAt),
    // 保留期清理
    index('runs_started_at_idx').on(t.startedAt),
  ],
);

/** 事件流落库：详情页时间线与断线重放（`after` 游标）。 */
export const runEvents = pgTable(
  'run_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: text('run_id').notNull(),
    /** RACP 事件流游标，同一 run 内单调递增且唯一 */
    cursor: integer('cursor').notNull(),
    /** 事件种类，如 `turn/started`、`tool/shell`、`writeback_rejected`（§5.6 第 4 条） */
    kind: text('kind').notNull(),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 断线重放按 (run_id, cursor) 增量读
    uniqueIndex('run_events_run_id_cursor_uidx').on(t.runId, t.cursor),
    // 保留期清理按时间扫（90 天）
    index('run_events_created_at_idx').on(t.createdAt),
  ],
);

/** 结构化产出（plan §5）。校验失败的也留，`valid=false` + `errors` 记原因。 */
export const envelopes = pgTable(
  'envelopes',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: text('run_id').notNull(),
    /** verdict 原文（`kind` / `labels` / `evidence`） */
    verdict: jsonb('verdict'),
    /** actions 原文（执行前） */
    actions: jsonb('actions'),
    /** usage 原文（token / cost） */
    usage: jsonb('usage'),
    /**
     * 阶段结论的**投影列**（`docs/plan-fixed-pipeline.md` §4.3）：`stage_name` = format/classify，
     * `stage_result` = pass/fail/requirement/defect/not-found/other。
     *
     * 为什么从 `verdict`/`actions` 的 jsonb 里另存两列：面板要按「这个 issue 各阶段结论」筛选与
     * 画时间线，解 jsonb 既写不出索引也读不动；阶段结论还会被回放与对账反复查。
     * 可空：Agent 阶段的老信封没有 `stage`，此时保持 NULL 而不是补默认值（NULL 才表示「不是阶段任务」）。
     */
    stageName: text('stage_name'),
    stageResult: text('stage_result'),
    /** Ajv 校验是否通过 */
    valid: boolean('valid').notNull().default(false),
    /** 校验错误明细（字段路径 + message） */
    errors: jsonb('errors'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('envelopes_run_id_uidx').on(t.runId)],
);

/** 每次写操作的审计 + 「被改回」的关联点（§5.6、§7.5）。 */
export const actions = pgTable(
  'actions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: text('run_id').notNull(),
    /** comment / label / create_issue / push_branch / open_pr / close_issue */
    intent: text('intent').notNull(),
    /** 写操作指向的对象，如 `owner/name#123`；reconcile 按它重查现状 */
    target: text('target').notNull(),
    /** 外部引用 id：comment id / PR 号 / commit sha */
    externalRef: text('external_ref'),
    /** 写成功时刻；NULL 表示未落地（写回闸门丢弃等） */
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    /** 被人改回的时刻（§7.5） */
    revertedAt: timestamp('reverted_at', { withTimezone: true }),
    /** label-removed / changes-requested / pr-closed */
    revertKind: text('revert_kind'),
    /** 写回闸门的 declared/actual/intersect/dropped 摘要与 `writeback_rejected` 原因 */
    audit: jsonb('audit'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('actions_run_id_idx').on(t.runId),
    // 改回关联：同 target + 7 天窗口
    index('actions_target_idx').on(t.target, t.appliedAt),
    // 每小时 reconcile 扫「最近 7 天已应用」的 actions（§7.5 第 4 条）
    index('actions_applied_at_idx').on(t.appliedAt),
    // 面板按命令/仓库分组统计改回率
    index('actions_revert_kind_idx').on(t.revertKind),
  ],
);

/** 我们打过哪些标签（plan §6.1「只动自己的」）。 */
export const botLabels = pgTable(
  'bot_labels',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    repo: text('repo').notNull(),
    issueNumber: integer('issue_number').notNull(),
    label: text('label').notNull(),
    /** `labels.map` 里的判定键（回溯「这个标签是按哪条判定打的」） */
    sourceKey: text('source_key'),
    /** 当时的判定快照哈希（同一判定重复打标幂等） */
    judgementHash: text('judgement_hash'),
    /** 面向人的一句话理由（面板展示；不是评论） */
    reason: text('reason'),
    /** 产出这条结论的 run id（uuid，与 `run_events` / `envelopes` 关联） */
    runId: uuid('run_id'),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (t) => [
    // 「当前是否由我们持有该标签」= 存在 removed_at IS NULL 的行；重复打标不得产生第二条当前行
    uniqueIndex('bot_labels_active_uidx')
      .on(t.repo, t.issueNumber, t.label)
      .where(sql`removed_at is null`),
    index('bot_labels_repo_issue_idx').on(t.repo, t.issueNumber),
  ],
);

/** 主动建 issue 的去重键（plan §6.3 `(repo, 指纹)`）。 */
export const issueFingerprints = pgTable(
  'issue_fingerprints',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    repo: text('repo').notNull(),
    /** 如 `dep-vuln:x`、`review:<sha>:<slug>` */
    fingerprint: text('fingerprint').notNull(),
    /** 命中的 issue 号（命中则追加评论，不新开） */
    issueNumber: integer('issue_number'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('issue_fingerprints_repo_fp_uidx').on(t.repo, t.fingerprint)],
);

/**
 * plan §6.2「只在缺失项集合变化时再回复」与 §7 关闭条件的**唯一判定源**（§7.2 F4）。
 * 写入点只有两处：合规判定产出之后、收到 `issue_comment.created`。
 */
export const issueStates = pgTable(
  'issue_states',
  {
    repo: text('repo').notNull(),
    issueNumber: integer('issue_number').notNull(),
    /** `sha256(sorted(未通过规则 id))`；NULL = 当前无缺失项 */
    missingSetHash: text('missing_set_hash'),
    /** 当前这批缺失项首次出现时刻；集合没变就不推进（关闭判定读它） */
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }),
    /** 最近一次**人工**回复时刻（机器人自己的评论不推进） */
    lastHumanReplyAt: timestamp('last_human_reply_at', { withTimezone: true }),
    /** 最近一次催办时刻（「同一句话不催第二次」） */
    lastNudgeAt: timestamp('last_nudge_at', { withTimezone: true }),
    /** 关闭时刻（关闭是唯一不可回收动作，置位后不再重复关） */
    closedAt: timestamp('closed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.repo, t.issueNumber] }),
    // 关闭判定扫描：48h 未变 + 无人工回复
    index('issue_states_close_scan_idx').on(t.firstSeenAt, t.lastHumanReplyAt),
  ],
);

/** 成本面板（按 run 记账，聚合走 metrics_daily + 短窗口直查）。 */
export const usageCosts = pgTable(
  'usage_costs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: text('run_id').notNull(),
    /** 模型标识（如 `anthropic/claude-*`） */
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    /** 金额走 numeric，不用 float（浮点累加会失真） */
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('usage_costs_run_id_idx').on(t.runId),
    index('usage_costs_model_created_at_idx').on(t.model, t.createdAt),
  ],
);

/** plan §9.3 的熔断留痕（重复输出 / 低增量 / 工具循环）。 */
export const degeneracyHits = pgTable(
  'degeneracy_hits',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: text('run_id').notNull(),
    /** paragraph-repeat / low-novelty / tool-loop */
    criterion: text('criterion').notNull(),
    /** 命中细节：窗口、重复次数、n-gram 占比、工具名与参数摘要 */
    detail: jsonb('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('degeneracy_hits_run_id_idx').on(t.runId)],
);

/**
 * 每日预聚合（指标永久，明细只留 90 天，§7.6 F10）。
 * **必须幂等**：`UNIQUE (day, repo, outcome)` + `ON CONFLICT DO UPDATE` 全量覆盖而不是累加，
 * 重跑某一天 / 补跑漏掉的日期结果都一样。`count` 在 SQL 里是保留字，用 `run_count` 承载。
 */
export const metricsDaily = pgTable(
  'metrics_daily',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** 聚合日期（UTC 日界） */
    day: date('day', { mode: 'string' }).notNull(),
    repo: text('repo').notNull(),
    /** run 结局维度 */
    outcome: text('outcome').notNull(),
    runCount: integer('run_count').notNull().default(0),
    p50Ms: integer('p50_ms'),
    p95Ms: integer('p95_ms'),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    /** 当天置位的 actions.reverted_at 计数（「被改回」是写操作维度的信号，不塞进 outcome） */
    revertCount: integer('revert_count').notNull().default(0),
    /** 按 command 拆的成本 `{"/review-pr": 1.23}`：键必须保持三列才能 UPSERT，故用 jsonb 承载 */
    commandCostUsd: jsonb('command_cost_usd'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('metrics_daily_day_repo_outcome_uidx').on(t.day, t.repo, t.outcome)],
);

/** RACP 设备令牌（AES-256-GCM 密文，明文永不落库，tech-plan §4.2）。 */
export const hostCredentials = pgTable('host_credentials', {
  /** host 标识（配对时生成） */
  hostId: text('host_id').primaryKey(),
  /** 密文：`v1:<iv>:<tag>:<ciphertext>` 形式，密钥在系统密钥库 */
  tokenEnc: text('token_enc').notNull(),
  /** 密钥轮换版本号 */
  version: integer('version').notNull().default(1),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 熔断 / 暂停开关（§7.4）。`until` 过了即视为关断，不需要额外清理任务。
 *
 * 多仓库后**按仓库区分**：`repo` 为 NULL = 全局 flag（如全局 429 熔断），非空 = 该仓库的独立状态。
 * 唯一性因此拆成两条 partial 索引（PG 的唯一索引把 NULL 视为互不相等，不能直接 (key, repo)）：
 * - 全局：`(key) WHERE repo IS NULL`
 * - 仓库级：`(key, repo) WHERE repo IS NOT NULL`
 *
 * 迁移段提示（`apps/server/src/queue/circuit-breaker.ts` 的 `ON CONFLICT`）：写成
 * `ON CONFLICT ("key") WHERE "repo" IS NULL`（全局）或 `ON CONFLICT ("key","repo")`（仓库级）。
 */
export const runtimeFlags = pgTable(
  'runtime_flags',
  {
    /** 如 `rate_limit_pause` / `pause:installation:<id>` */
    key: text('key').notNull(),
    /** 归属仓库；NULL = 全局 */
    repo: text('repo'),
    /** 字符串值（`'1'` / ISO 时间等），避免为每种 flag 加列 */
    value: text('value').notNull(),
    /** 该 flag 的失效时刻；NULL = 不过期 */
    until: timestamp('until', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('runtime_flags_global_uidx')
      .on(t.key)
      .where(sql`repo is null`),
    uniqueIndex('runtime_flags_repo_uidx')
      .on(t.key, t.repo)
      .where(sql`repo is not null`),
  ],
);

/** 面板会话（服务端存，便于吊销）。 */
export const panelSessions = pgTable(
  'panel_sessions',
  {
    /** 会话 id（cookie 值，随机 32 字节 hex） */
    sid: text('sid').primaryKey(),
    /** GitHub login（org 成员校验通过后落库） */
    login: text('login').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('panel_sessions_expires_at_idx').on(t.expiresAt)],
);
/* ── 多仓库改造新增的四张表（`docs/impl-multi-repo.md` §2）──────────────────── */

/**
 * 无感反馈台账（`docs/impl-multi-repo.md` §0.4 / W2-D）。
 *
 * 一个 (目标, 阶段, 锚点) 只应该有一次终态反馈，所以唯一键把这三者与 `repo` 一起钉住。
 * `anchor` 用空串而不是 NULL：PG 的唯一索引把 NULL 视为互不相等，用 NULL 就等于没有唯一约束。
 */
export const issueFeedback = pgTable(
  'issue_feedback',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    repo: text('repo').notNull(),
    /** issue / pr */
    targetKind: text('target_kind').notNull(),
    targetNumber: integer('target_number').notNull(),
    /** 评论 id（`+eyes` 打在评论上时有值） */
    commentId: bigint('comment_id', { mode: 'number' }),
    /** 阶段：`queued` / `succeeded` / `failed` / `cancelled` …… */
    stage: text('stage').notNull(),
    /** reaction 的 content（`eyes` / `rocket` / `confused`） */
    content: text('content').notNull(),
    /** 幂等锚点（默认空串 = 该 (目标, 阶段) 只有一条） */
    anchor: text('anchor').notNull().default(''),
    /** GitHub 返回的 reaction id；取消 reaction 时按它删 */
    reactionId: bigint('reaction_id', { mode: 'number' }),
    /** 实际打上/摘掉的时刻；NULL = 计划过但没落地（dry-run） */
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    /** dry-run 与失败的细节 */
    audit: jsonb('audit'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('issue_feedback_stage_uidx').on(t.repo, t.targetKind, t.targetNumber, t.stage, t.anchor),
    index('issue_feedback_target_idx').on(t.repo, t.targetKind, t.targetNumber),
  ],
);

/** 每轮打标的判定与结果（W2-E）：`desired` 是想要的、`applied` 是真正落地的，两者不等就是被拦了。 */
export const labelDecisions = pgTable(
  'label_decisions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    repo: text('repo').notNull(),
    targetNumber: integer('target_number').notNull(),
    /** 判定快照哈希（同一判定重复跑不重复记账的锚） */
    judgementHash: text('judgement_hash'),
    /** 词表过滤 / 1:N 展开 / 互斥组 / 上限之后想要的标签 */
    desired: jsonb('desired'),
    /** 实际打上的标签 */
    applied: jsonb('applied'),
    /** 被拦的原因：`max_per_issue` / `not-in-vocabulary` / `human-veto` …… */
    blockedReason: text('blocked_reason'),
    /** 面向人的一句话理由（面板展示） */
    reason: text('reason'),
    runId: uuid('run_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('label_decisions_repo_target_idx').on(t.repo, t.targetNumber, t.createdAt)],
);

/** 配额计数器（建 issue 日配额等）：`(repo, kind, window_start)` 一行，UPSERT 累加。 */
export const quotaCounters = pgTable(
  'quota_counters',
  {
    repo: text('repo').notNull(),
    /** 配额种类，如 `create_issue:day` */
    kind: text('kind').notNull(),
    /** 窗口起点（日/小时窗的第一刻，UTC） */
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [uniqueIndex('quota_counters_repo_kind_window_uidx').on(t.repo, t.kind, t.windowStart)],
);

/* ── issue agent（v0.3，`docs/dev-plan-issue-agent.md` §4）────────────────────────── */

/**
 * 一个 issue 一个**持久会话**的游标（v1.5 里它住在 `issue_pipeline`，那张表已随流水线退役删除）。
 *
 * 为什么单独一张表：会话连续性是 agent 的**唯一有状态资产**——流水线删掉、阶段状态删掉，
 * 但「同一个 issue 的第二句话还能接着上一轮」必须保留（v1 计划就踩过这个坑）。
 *
 * 主键 `(repo, issue_number)`：一个 issue 一行，读写都是点查 + UPSERT。
 * `session_id` 为 NULL = 还没开过会话（第一次投递会新建）。
 */
export const agentSessions = pgTable(
  'agent_sessions',
  {
    /** `owner/name`，与 `tasks.repo` 同口径 */
    repo: text('repo').notNull(),
    issueNumber: integer('issue_number').notNull(),
    /** RACP 会话 id（`session/create` 的返回值）；NULL = 还没开过会话 */
    sessionId: text('session_id'),
    /** `events/subscribe` 的 `after` 游标：防重放旧事件污染本轮信封 */
    cursor: integer('cursor').notNull().default(0),
    /** 该会话已用轮数（达到上限会轮换新会话） */
    turns: integer('turns').notNull().default(0),
    /** 会话创建时刻（超过上限天数 → 轮换） */
    startedAt: timestamp('started_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.repo, t.issueNumber] })],
);

/**
 * agent 消息 + **永久幂等**的落点（需求 §1.2 / §5 规则 2）。
 *
 * `fingerprint` 的口径由应用层决定（人消息 = 正文 + 作者的稳定摘要；事件消息 = 模板 id +
 * `issue.updated_at`，见 `docs/dev-plan-issue-agent.md` §2.1），数据层只保证
 * 「同一 `(repo, issue, fingerprint)` 只有一行」。
 *
 * 这张表**同时是队列**（S1 的 dispatcher 按 issue 取最老一条），所以 `status` 与
 * `(repo, issue_number, status, created_at)` 索引都在这里定好。
 */
export const agentMessages = pgTable(
  'agent_messages',
  {
    repo: text('repo').notNull(),
    issueNumber: integer('issue_number').notNull(),
    /** 幂等键（`sha256(...)` 的前 64 位十六进制） */
    fingerprint: text('fingerprint').notNull(),
    /** `mention` = 人消息（永久幂等）| `event` = 模板消息（key 含 `updated_at`） */
    kind: text('kind').notNull().default('mention'),
    /** `queued` | `running` | `done` | `failed` */
    status: text('status').notNull().default('queued'),
    /** 发出这条消息的评论 id（事件消息为 NULL） */
    commentId: bigint('comment_id', { mode: 'number' }),
    /** 消息原文（人消息是原话，事件消息是模板渲染结果） */
    commentBody: text('comment_body'),
    /** 触发人 login（人消息 = 评论作者，事件消息 = issue 作者）：回复靠它加 `@login` */
    actorLogin: text('actor_login'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.repo, t.issueNumber, t.fingerprint] }),
    // 队列取件（dispatcher 按 issue 取最老一条）+ 面板按状态筛
    index('agent_messages_queue_idx').on(t.repo, t.issueNumber, t.status, t.createdAt),
  ],
);

/**
 * 权限拒绝的**独立记账**（需求 §1.2：`status='denied'` 不得参与幂等命中）。
 *
 * 为什么单独一张表而不是塞进 `agent_messages.status`：拒绝是一次「对某个人的回复」，
 * 按 `(repo, issue, actor)` 只回一次；若混进消息幂等，该用户日后被提成管理员，
 * 同一句话会被永久静默且查不到原因。
 */
export const agentDenials = pgTable(
  'agent_denials',
  {
    repo: text('repo').notNull(),
    issueNumber: integer('issue_number').notNull(),
    /** 被拒的 login */
    actorLogin: text('actor_login').notNull(),
    /** 已经回过一次拒绝的时刻 */
    repliedAt: timestamp('replied_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.repo, t.issueNumber, t.actorLogin] })],
);

/** schema 里的全部表（启动自检、迁移覆盖度检查、queries 生成都用得上）。 */
export const ALL_TABLES = {
  webhookDeliveries,
  repos,
  tasks,
  runs,
  runEvents,
  envelopes,
  actions,
  botLabels,
  issueFingerprints,
  issueStates,
  usageCosts,
  degeneracyHits,
  metricsDaily,
  hostCredentials,
  runtimeFlags,
  panelSessions,
  issueFeedback,
  labelDecisions,
  quotaCounters,
  agentSessions,
  agentMessages,
  agentDenials,
} as const;

/** 表名清单（单测断言「`db/schema.ts` 里的每一张表都在库里」用它）。 */
export const ALL_TABLE_NAMES: readonly string[] = Object.freeze(
  Object.values(ALL_TABLES).map((table) => getTableName(table)),
);
