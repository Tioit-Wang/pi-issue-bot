/**
 * 数据模型唯一事实源 —— docs/tech-plan.md §7.2 的 16 张表。
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
  ],
);

/** 仓库开关与 `.github/pi-bot.yml` 快照。 */
export const repos = pgTable('repos', {
  /** `owner/name`，全库唯一 */
  repoFullName: text('repo_full_name').primaryKey(),
  /** 机器人对该仓库是否启用（非法配置禁用，plan §10） */
  enabled: boolean('enabled').notNull().default(true),
  /** 首周强制 dry-run（plan §11 M1 观察期） */
  dryRun: boolean('dry_run').notNull().default(true),
  /** `.github/pi-bot.yml` 解析后的原文快照 */
  config: jsonb('config'),
  /** schema 校验是否通过；false 时该仓库的机器人禁用并通知 owner */
  configValid: boolean('config_valid').notNull().default(false),
  /** 配置校验失败原因（面板展示用） */
  configError: text('config_error'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

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
    /** 命令名：`/review-pr` 等；判定类记 `auto:triage` / `auto:compliance`（§7.2） */
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

/** 全局熔断 / 暂停开关（§7.4）。`until` 过了即视为关断，不需要额外清理任务。 */
export const runtimeFlags = pgTable('runtime_flags', {
  /** 如 `rate_limit_pause` */
  key: text('key').primaryKey(),
  /** 字符串值（`'1'` / ISO 时间等），避免为每种 flag 加列 */
  value: text('value').notNull(),
  /** 该 flag 的失效时刻；NULL = 不过期 */
  until: timestamp('until', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

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
} as const;

/** 表名清单（单测断言「§7.2 的 16 张表都在」用它）。 */
export const ALL_TABLE_NAMES: readonly string[] = Object.freeze(
  Object.values(ALL_TABLES).map((table) => getTableName(table)),
);
