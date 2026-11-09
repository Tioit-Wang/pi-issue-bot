# 契约 · 数据库 · v1.0

> 上游：`docs/tech-plan.md` v1.1 §7.2（数据模型）、§7.6（保留期与聚合）、§5.4（写执行器幂等）、`docs/plan.md` v0.4 §6–§7。
> 下游：W1-B（`apps/server/src/db/**` + `migrations/**` 的 drizzle schema）、W2-H（`queries/` 面板只读查询）。
> 状态：已冻结（B3）。**枚举取值与 `packages/contract/src/enums.ts` 逐项一致**，改一处必须同 PR 改另一处。

---

## 0. 通用约定

| 项 | 约定 |
|---|---|
| 时间列 | 一律 `timestamptz`，写 UTC；「可空」用 `NULL` 表达「没有发生」，不用哨兵值 |
| 金额 | `numeric(12,4)`（USD，4 位小数）；API 里是 JSON number |
| token / 耗时 / 计数 | `integer` / `bigint`，非负；耗时单位毫秒（列名 `_ms`） |
| 主键 | 业务表用 `text`（cuid2 短 id，长度 ≤32）；事件表用 `bigserial` |
| 枚举列 | `text` + `CHECK` 约束（不用 PG `enum` 类型：加值要 `ALTER TYPE`，迁移成本高、回滚难） |
| jsonb | 只放「结构性内容」（payload、verdict、audit 摘要）；**面板查询不许解 jsonb**（tech-plan §8.3 F9） |
| 命名 | 表名复数 snake_case；外键 `<表名单数>_id`；唯一索引 `uq_`，普通索引 `ix_` |
| 时区 | 所有 `now()` 都是 UTC（PG 默认 `timestamptz`） |

数据库：PostgreSQL 16+，单实例只监听 `127.0.0.1`。pg-boss 自己的 `pgboss` schema 由库创建，
与业务表互不干扰（连接串显式 `search_path`）。

---

## 1. 16 张表

### 1.1 `webhook_deliveries` —— 去重 + 90 天原文 + replay 数据源

| 列 | 类型 | 可空 | 默认 | 约束 / 索引 | 用途 |
|---|---|---|---|---|---|
| `delivery_id` | text | 否 | — | **PK** | `X-GitHub-Delivery`，重投即命中 |
| `event` | text | 否 | — | `ix_webhook_deliveries_event_received` | `X-GitHub-Event`（`issues`/`pull_request`/`issue_comment`…） |
| `action` | text | 是 | NULL | 同上 | payload 里的 `action`（`opened`/`edited`…）；`ping` 之类没有 |
| `repo` | text | 是 | NULL | — | `owner/name`，从 payload 抽；非仓库事件为 NULL |
| `payload` | jsonb | 否 | — | — | 原始 body，**90 天**（tech-plan §7.6），`pi-bot replay` 的唯一来源 |
| `received_at` | timestamptz | 否 | `now()` | `ix_..._received_at` | 收到时间（用于保留期清理与重投观测） |
| `decision` | text | 是 | NULL | — | `enqueued`/`duplicate`/`ignored`/`unauthorized`/`paused`，与 `POST /webhook` 应答的 `action` 同值 |
| `task_id` | text | 是 | NULL | — | 该投递建出的任务（无任务为 NULL） |

**唯一性**：`delivery_id` 主键即去重键。写入顺序是「先 `INSERT … ON CONFLICT DO NOTHING`，影响行数 0 即视为重投」。

### 1.2 `repos` —— 仓库开关与 `.github/pi-bot.yml` 快照

| 列 | 类型 | 可空 | 默认 | 约束 / 索引 | 用途 |
|---|---|---|---|---|---|
| `repo_full_name` | text | 否 | — | **PK** | `owner/name` |
| `enabled` | boolean | 否 | `true` | — | 仓库开关（`pi-bot.yml` 的 `enabled`） |
| `dry_run` | boolean | 否 | `true` | — | dry-run（永久保留，plan §11） |
| `config` | jsonb | 否 | `'{}'` | — | 校验后的 `.github/pi-bot.yml`（形状见 `repoConfigSchema`） |
| `config_valid` | boolean | 否 | `false` | `ix_repos_config_valid` | schema 是否通过；false ⇒ 禁用该仓库并通知 owner（plan §10） |
| `config_error` | text | 是 | NULL | — | 第一条校验错误（给 `/api/system` 与通知用） |
| `config_sha` | text | 是 | NULL | — | 读取配置时的默认分支 sha（判断「配置是否换过」） |
| `config_loaded_at` | timestamptz | 是 | NULL | — | 最近一次加载时间 |

### 1.3 `tasks` —— 任务主体（面板列表与审计的主表）

| 列 | 类型 | 可空 | 默认 | 约束 / 索引 | 用途 |
|---|---|---|---|---|---|
| `id` | text | 否 | — | **PK** | cuid2 |
| `source` | text | 否 | — | `CHECK` | `webhook`/`command`/`cron` |
| `repo` | text | 否 | — | `ix_tasks_repo_queued` | `owner/name` |
| `target_kind` | text | 否 | — | `CHECK` | `issue`/`pr` |
| `target_number` | integer | 否 | — | — | issue / PR 编号 |
| `head_sha` | text | 是 | NULL | — | PR / 命令类的提交；issue 判定类为 NULL |
| `command` | text | 否 | — | `ix_tasks_command_queued` | `/review-pr` 或 `auto:triage` / `auto:compliance`；**入队时写死** |
| `actor_login` | text | 是 | NULL | — | 触发人 login（cron 为 NULL）；**入队时写死** |
| `queued_at` | timestamptz | 否 | `now()` | `ix_tasks_status_queued` | 入队时间；排队闸门只读它 |
| `started_at` | timestamptz | 是 | NULL | — | worker 开始时间 |
| `ended_at` | timestamptz | 是 | NULL | — | 终态时间 |
| `status` | text | 否 | `'queued'` | `CHECK`；`ix_tasks_status_queued` | `queued`/`running`/`succeeded`/`failed`/`cancelled` |
| `outcome` | text | 是 | NULL | `CHECK` | 最近一次 run 的结果维度（`success`/`failed`/`timed-out`/`degenerate-output`/`parse-failed`/`interrupted`） |
| `failure_class` | text | 是 | NULL | `CHECK`；`ix_tasks_failure_class` | 最近一次 run 的失败原因（10 个取值，见 §2） |
| `cost_usd` | numeric(12,4) | 是 | NULL | — | 任务累计成本；没有 usage 为 NULL，免费为 0 |
| `dry_run` | boolean | 否 | `true` | — | 本任务是否 dry-run（取入队时的仓库配置） |
| `container_name` | text | 是 | NULL | — | `pi-job-<id>`，销毁后置 NULL（F1：容器名由 bot 查表，不由路径推导） |
| `idempotency_key` | text | 否 | — | **UNIQUE** `uq_tasks_idempotency_key` | 见 §3.1 |

**为什么 `outcome` / `failure_class` / `cost_usd` 冗余在 `tasks` 上**：`/api/tasks` 列表要按失败分类筛选、
按成本排序，若每次 join `runs` 取最近一条，面板一次查询就变成 N 次子查询。写回时机固定在「run 结束」这一刻，
与 `runs` 同事务更新，因此不会漂移。

**`started_at` / `ended_at` / `dry_run` 是相对 tech-plan §7.2 的补充**，理由同上：列表页的耗时列与 dry-run 徽章
不该再回表。差异清单见 §5。

### 1.4 `runs` —— 一次执行（重试产生多行）

| 列 | 类型 | 可空 | 默认 | 约束 / 索引 | 用途 |
|---|---|---|---|---|---|
| `id` | text | 否 | — | **PK** | cuid2 |
| `task_id` | text | 否 | — | FK `tasks(id)` `ON DELETE CASCADE`；**UNIQUE(task_id, attempt)** | 所属任务 |
| `attempt` | integer | 否 | `0` | 同上 | 第几次尝试（0 起） |
| `session_id` | text | 是 | NULL | — | RACP `session/create` 返回的 id |
| `turn_id` | text | 是 | NULL | — | `turn/start` 返回的 id |
| `started_at` | timestamptz | 是 | NULL | `ix_runs_started_at` | 开始时间 |
| `ended_at` | timestamptz | 是 | NULL | 同上 | 结束时间（报表按它分桶） |
| `outcome` | text | 是 | NULL | `CHECK` | `runs.outcome`（同 `tasks.outcome`） |
| `failure_class` | text | 是 | NULL | `CHECK`；`ix_runs_failure_class` | **按 tech-plan §7.3 的优先级取唯一一个** |
| `failure_detail` | jsonb | 是 | NULL | — | 其余观测信号（容器退出码、OOMKilled、429 计数…）供审计，不参与决策 |

### 1.5 `run_events` —— 事件时间线（90 天；先聚合进 metrics_daily）

| 列 | 类型 | 可空 | 默认 | 约束 / 索引 | 用途 |
|---|---|---|---|---|---|
| `id` | bigserial | 否 | — | **PK** | — |
| `run_id` | text | 否 | — | FK `runs(id)` `ON DELETE CASCADE`；**UNIQUE(run_id, cursor)** | 所属 run |
| `cursor` | integer | 否 | — | 同上 | 单调递增，断线重放与详情页排序的唯一依据 |
| `kind` | text | 否 | — | `CHECK` | `session`/`turn`/`tool-call`/`approval`/`command`/`sandbox`/`envelope`/`action`/`writeback`/`notice` |
| `at` | timestamptz | 否 | `now()` | `ix_run_events_at` | 事件时间 |
| `payload` | jsonb | 否 | `'{}'` | — | 事件内容（审批判定、命令 argv 与退出码、信封校验错误…） |

### 1.6 `envelopes` —— 结构化产出（校验失败的也留）

| 列 | 类型 | 可空 | 默认 | 约束 / 索引 | 用途 |
|---|---|---|---|---|---|
| `id` | text | 否 | — | **PK** | — |
| `run_id` | text | 否 | — | FK；**UNIQUE** `uq_envelopes_run_id` | 一次 run 一封（重试是新 run） |
| `verdict` | jsonb | 是 | NULL | — | `{kind, labels[], evidence[]}`；坏输出为 NULL |
| `actions` | jsonb | 否 | `'[]'` | — | 原始动作数组（含被丢弃的，审计要看原文） |
| `usage` | jsonb | 否 | `'{}'` | — | `{inputTokens, outputTokens, costUsd}` |
| `valid` | boolean | 否 | `false` | `ix_envelopes_valid` | Ajv 校验是否通过；false ⇒ 该 run 记 `parse` 失败 |
| `raw_sha256` | text | 是 | NULL | — | 原文摘要（不存原文全文；全文在 transcript，90 天） |
| `received_at` | timestamptz | 否 | `now()` | — | — |

### 1.7 `actions` —— 写操作审计 + 「被改回」关联点

| 列 | 类型 | 可空 | 默认 | 约束 / 索引 | 用途 |
|---|---|---|---|---|---|
| `id` | text | 否 | — | **PK** | 审计行 id（`/api/audit` 的 `id`） |
| `run_id` | text | 是 | NULL | FK `runs(id)`（SET NULL） | 产生的 run；`close_issue` 可能来自 cron，故可空 |
| `task_id` | text | 否 | — | `ix_actions_task` | 冗余任务 id，审计查询不 join |
| `repo` | text | 否 | — | `ix_actions_repo_applied_at` | `owner/name` |
| `command` | text | 否 | — | `ix_actions_command` | 冗余 `tasks.command`（按命令分组不 join） |
| `intent` | text | 否 | — | `CHECK` | `comment`/`label`/`create_issue`/`push_branch`/**`close_issue`** |
| `status` | text | 否 | — | `CHECK` | `applied`/`dry-run`/`skipped`/`rejected`/`failed` |
| `target_kind` | text | 否 | — | — | `issue`/`pr`/`comment`/`branch` |
| `target_number` | integer | 是 | NULL | — | issue/PR 编号 |
| `target_ref` | text | 是 | NULL | — | 分支名 / 评论 id / commit sha |
| `external_ref` | text | 是 | NULL | — | GitHub 侧引用（评论 id、PR 号、commit sha） |
| `applied_at` | timestamptz | 是 | NULL | `ix_actions_repo_applied_at` | 写成功的时刻（改回率的分母） |
| `reverted_at` | timestamptz | 是 | NULL | `ix_actions_reverted_at` | 被改回的时刻（分子）；**永久保留** |
| `revert_kind` | text | 是 | NULL | `CHECK` | `label-removed`/`changes-requested`/`pr-closed`/`comment-deleted`/`revert-commit` |
| `audit` | jsonb | 是 | NULL | — | 写回闸门的 `declared`/`actual`/`intersect`/`dropped` 摘要与 `writeback_rejected` 原因（tech-plan §5.6） |
| `approval` | jsonb | 是 | NULL | — | 该动作链路上工具调用的审批判定 `{tool, decision, rule}` |
| `dry_run` | boolean | 否 | `true` | — | dry-run 不写 GitHub，但仍留审计行 |

### 1.8 `bot_labels` —— 我们打过哪些标签（plan §6.1 只动自己的）

| 列 | 类型 | 可空 | 默认 | 约束 / 索引 | 用途 |
|---|---|---|---|---|---|
| `id` | bigserial | 否 | — | **PK** | — |
| `repo` | text | 否 | — | **UNIQUE(repo, issue_number, label)** `uq_bot_labels_target` | — |
| `issue_number` | integer | 否 | — | 同上 | — |
| `label` | text | 否 | — | 同上 | 标签名（仓库里已存在的名字） |
| `applied_at` | timestamptz | 否 | `now()` | — | 打标时间 |
| `removed_at` | timestamptz | 是 | NULL | `ix_bot_labels_active` | 撤标时间；`IS NULL` 即当前仍生效 |

**唯一性用 (repo, issue_number, label) 三列**：同一标签重复「打→撤→打」是 `UPDATE removed_at`，
不新增行——否则「只动自己打过的」会随历史行数变得不可判定。

### 1.9 `issue_fingerprints` —— 主动建 issue 去重键（plan §6.3）

| 列 | 类型 | 可空 | 默认 | 约束 / 索引 | 用途 |
|---|---|---|---|---|---|
| `repo` | text | 否 | — | **UNIQUE(repo, fingerprint)** `uq_issue_fingerprints` | — |
| `fingerprint` | text | 否 | — | 同上 | `dep-vuln:lodash` 这类稳定串（形状见信封契约 `FINGERPRINT_RE`） |
| `issue_number` | integer | 否 | — | — | 命中/新建的 issue 号 |
| `first_created_at` | timestamptz | 否 | `now()` | — | 首次创建时间 |
| `last_seen_at` | timestamptz | 否 | `now()` | — | 最近一次命中（命中则追加评论，不新开） |

### 1.10 `issue_states` —— 「不重复催办」与「48h 关闭」的唯一判定源（F4）

| 列 | 类型 | 可空 | 默认 | 约束 / 索引 | 用途 |
|---|---|---|---|---|---|
| `repo` | text | 否 | — | **PK(repo, issue_number)** | — |
| `issue_number` | integer | 否 | — | 同上 | — |
| `missing_set_hash` | text | 是 | NULL | `ix_issue_states_hash` | `sha256(sorted(未通过规则 id))`；NULL = 当前无缺失项 |
| `first_seen_at` | timestamptz | 是 | NULL | — | 当前这组缺失项首次出现的时间（集合变了就重置） |
| `last_human_reply_at` | timestamptz | 是 | NULL | — | 最近一次**人工**回复（机器人自己的评论不算） |
| `last_nudge_at` | timestamptz | 是 | NULL | — | 最近一次催办评论时间（`missing_set_hash` 未变时不再催） |
| `closed_at` | timestamptz | 是 | NULL | — | 我们关闭该 issue 的时间；非空即不再处理 |
| `updated_at` | timestamptz | 否 | `now()` | — | UPSERT 时刷新 |

### 1.11 `usage_costs` —— 成本明细（成本面板）

| 列 | 类型 | 可空 | 默认 | 约束 / 索引 | 用途 |
|---|---|---|---|---|---|
| `id` | bigserial | 否 | — | **PK** | — |
| `run_id` | text | 否 | — | FK `runs(id)` `ON DELETE CASCADE`；**UNIQUE(run_id, model)** | 一次 run 可能跨两个模型 |
| `model` | text | 否 | — | 同上 | `provider/model` |
| `input_tokens` | integer | 否 | `0` | `CHECK (>= 0)` | — |
| `output_tokens` | integer | 否 | `0` | `CHECK (>= 0)` | — |
| `cost_usd` | numeric(12,4) | 否 | `0` | `CHECK (>= 0)` | 按价格表算出；价格表缺条目时该列为 0 并置 `priced=false` |
| `priced` | boolean | 否 | `true` | — | 是否命中价格表（面板据此算覆盖率，不把「没算」当「免费」） |
| `created_at` | timestamptz | 否 | `now()` | `ix_usage_costs_created_at` | — |

### 1.12 `degeneracy_hits` —— 重复输出熔断留痕（plan §9.3）

| 列 | 类型 | 可空 | 默认 | 约束 / 索引 | 用途 |
|---|---|---|---|---|---|
| `id` | bigserial | 否 | — | **PK** | — |
| `run_id` | text | 否 | — | FK `runs(id)` `ON DELETE CASCADE`；`ix_degeneracy_hits_run` | — |
| `criterion` | text | 否 | — | `CHECK` | `paragraph-repeat`/`low-delta`/`tool-loop` |
| `detail` | jsonb | 否 | `'{}'` | — | 命中的窗口哈希、重复次数、工具调用签名等 |
| `detected_at` | timestamptz | 否 | `now()` | — | 触发时间 |

### 1.13 `metrics_daily` —— 每日预聚合（指标永久，tech-plan §7.6）

| 列 | 类型 | 可空 | 默认 | 约束 / 索引 | 用途 |
|---|---|---|---|---|---|
| `day` | date | 否 | — | **UNIQUE(day, repo, outcome)** `uq_metrics_daily` | UTC 自然日 |
| `repo` | text | 否 | — | 同上；`ix_metrics_daily_repo_day` | — |
| `outcome` | text | 否 | — | 同上；`CHECK` | 6 个 outcome 之一 |
| `count` | integer | 否 | `0` | — | 该格 run 数 |
| `p50_ms` | integer | 是 | NULL | — | 样本为空为 NULL（不是 0） |
| `p95_ms` | integer | 是 | NULL | — | 同上 |
| `cost_usd` | numeric(12,4) | 否 | `0` | — | — |
| `revert_count` | integer | 否 | `0` | — | 当天置位 `actions.reverted_at` 的计数（写操作维度，不塞进 outcome） |
| `command_cost_usd` | jsonb | 否 | `'{}'` | — | `{"/review-pr": 0.42, "auto:triage": 0.03}` 近似拆分 |
| `updated_at` | timestamptz | 否 | `now()` | — | 每次 UPSERT 刷新（便于发现「哪天没算」） |

### 1.14 `host_credentials` —— RACP 设备令牌（AES-256-GCM）

| 列 | 类型 | 可空 | 默认 | 约束 / 索引 | 用途 |
|---|---|---|---|---|---|
| `host_id` | text | 否 | — | **PK** | pi-host 标识（`bootstrap-host` 配对时生成） |
| `token_enc` | bytea | 否 | — | — | 密文（含 nonce 与 tag）；密钥来自 `EnvironmentFile`，不进库 |
| `version` | integer | 否 | `1` | — | 令牌版本，轮换时 +1 |
| `expires_at` | timestamptz | 是 | NULL | — | 过期时间；NULL = 不过期（当前实现为 NULL） |
| `created_at` | timestamptz | 否 | `now()` | — | — |
| `updated_at` | timestamptz | 否 | `now()` | — | — |

### 1.15 `runtime_flags` —— 全局熔断 / 暂停开关

| 列 | 类型 | 可空 | 默认 | 约束 / 索引 | 用途 |
|---|---|---|---|---|---|
| `key` | text | 否 | — | **PK** | `rate_limit_pause` / `worker_pause` / `dry_run_all` |
| `value` | text | 否 | — | — | 字符串值（`'1'`/`'0'`/原因文本） |
| `until` | timestamptz | 是 | NULL | `ix_runtime_flags_until` | 生效截止；NULL = 一直有效 |
| `updated_at` | timestamptz | 否 | `now()` | — | — |

读取规则：`until IS NULL OR until > now()` 才算生效；过期的行保留（用于事后复盘），worker 不删。

### 1.16 `panel_sessions` —— 面板会话（服务端存，便于吊销）

| 列 | 类型 | 可空 | 默认 | 约束 / 索引 | 用途 |
|---|---|---|---|---|---|
| `sid` | text | 否 | — | **PK** | cookie 里唯一的身份载体（HttpOnly/Secure/SameSite=Lax） |
| `login` | text | 否 | — | `ix_panel_sessions_login` | GitHub login（组织成员校验通过后写入） |
| `created_at` | timestamptz | 否 | `now()` | — | — |
| `expires_at` | timestamptz | 否 | — | `ix_panel_sessions_expires_at` | 7 天（tech-plan R3） |
| `revoked_at` | timestamptz | 是 | NULL | — | 单条吊销；非空即失效（不删行，保留审计） |

---

## 2. 枚举取值（与 `packages/contract/src/enums.ts` 同源）

| 枚举 | 取值 |
|---|---|
| `tasks.status` | `queued` `running` `succeeded` `failed` `cancelled` |
| `tasks.source` | `webhook` `command` `cron` |
| `target_kind` | `issue` `pr` |
| `runs.outcome` / `metrics_daily.outcome` | `success` `failed` `timed-out` `degenerate-output` `parse-failed` `interrupted` |
| `runs.failure_class` | `timeout` `interrupt` `degenerate-output` `sandbox-oom` `sandbox-crash` `auth` `rate-limit` `model` `parse` `github-api` |
| `actions.intent` | `comment` `label` `create_issue` `push_branch` `close_issue` |
| `actions.status` | `applied` `dry-run` `skipped` `rejected` `failed` |
| `actions.revert_kind` | `label-removed` `changes-requested` `pr-closed` `comment-deleted` `revert-commit` |
| `run_events.kind` | `session` `turn` `tool-call` `approval` `command` `sandbox` `envelope` `action` `writeback` `notice` |
| `degeneracy_hits.criterion` | `paragraph-repeat` `low-delta` `tool-loop` |

失败分类的判定优先级（tech-plan §7.3）在契约里也有机器可读版本：
`FAILURE_CLASS_PRIORITY_GROUPS` = `[timeout, interrupt, degenerate-output]` < `[sandbox-oom]` < `[sandbox-crash]` < `[auth, rate-limit, model, parse, github-api]`。

---

## 3. 三条评审点名的规则

### 3.1 `tasks.idempotency_key` 的生成公式（F9）

```
idempotency_key = hex(sha256([kind, repo, target, anchor, trigger_actor].join("\n"))).slice(0, 32)
```

| 组成 | 取值 |
|---|---|
| `kind` | `triage` / `compliance` / `command:/review-pr` / `create_issue`（短串，前缀区分判定类与命令类） |
| `repo` | `owner/name` |
| `target` | `issue:123` / `pr:456`（带类型前缀，避免 issue#7 与 pr#7 撞键） |
| `anchor` | **按 `kind` 二选一**：PR / 命令类 = `head_sha`；issue 判定类 = `missing_set_hash` |
| `trigger_actor` | 触发人 login；cron 为 `cron`；`/retry` 为发起重跑的人 |

三条定理由：

1. **`anchor` 二选一**：命令类要满足 plan §6.4「同一 `head_sha` 重跑是空操作」——提交没变时必须是同一个键；
   而 issue 判定类没有提交可锚（issue 没有 head），重复回复的判据是「同一批缺失项」，所以锚在 `missing_set_hash` 上。
   两者若统一用 `head_sha`，issue 类的键会退化成常量，同一 issue 的第二次合规检查会被唯一键吃掉，催办逻辑直接失效。
2. **`trigger_actor` 进键**：人工 `/retry` 与 webhook 重投必须能区分。重投是「同一个事件又来了一遍」（应被去重），
   `/retry` 是「人对同一次失败要求再跑」（必须能落成新任务）。少了这一项，`/retry` 会被唯一键吃掉——而这正是 plan §9.1
   「超时任务只接受人工 `/retry`」唯一的补偿手段。
3. **32 位十六进制**：碰撞概率在 `#(同 kind+repo+target)` 量级上可忽略，且够短，能进日志与面板 URL。
   不用完整 64 位是因为它只做去重，不做任何安全判定（不当作 id 或签名的替代品）。

写入时机：**入队事务内**（与 `webhook_deliveries.decision` 同事务）。冲突即「已处理过」，webhook 应答 `duplicate: true`。

### 3.2 `issue_states` 的 UPSERT 时机与关闭判定（F4）

**只有两个写入点**（`INSERT … ON CONFLICT (repo, issue_number) DO UPDATE`）：

1. **合规判定产出之后**（每次合规任务结束）：

```sql
INSERT INTO issue_states (repo, issue_number, missing_set_hash, first_seen_at, last_nudge_at, updated_at)
VALUES (:repo, :n, :hash, now(), NULL, now())
ON CONFLICT (repo, issue_number) DO UPDATE
   SET missing_set_hash = EXCLUDED.missing_set_hash,
       first_seen_at    = CASE WHEN issue_states.missing_set_hash = EXCLUDED.missing_set_hash
                               THEN issue_states.first_seen_at ELSE now() END,
       updated_at       = now();
```

   - 回复条件：`新 hash ≠ 旧 hash` **或** `last_nudge_at IS NULL`；催过且 hash 未变则**不再回复**（plan §6.2）。
     发完置 `last_nudge_at = now()`。
   - 缺失项清空（`hash IS NULL`）时 `first_seen_at` 置 NULL，并按「只动自己打过的」撤掉 `needs-info`。
2. **收到该 issue 的 `issue_comment.created`**（`author_association ∈ {MEMBER, OWNER, COLLABORATOR}` 且作者不是机器人）：
   `UPDATE issue_states SET last_human_reply_at = now()`。这是**唯一**推进该字段的事件——机器人自己的评论、
   `edited` 事件都不算。

**关闭判定只读这一张表**，不发 GitHub 请求、不看 `actions` 历史：

```
needs-info 在标签里
  ∧ missing_set_hash IS NOT NULL
  ∧ now() - first_seen_at >= interval '48 hours'
  ∧ (last_human_reply_at IS NULL OR last_human_reply_at <= first_seen_at)
  ∧ closed_at IS NULL
```

满足则关闭并写 `closed_at`，任一不满足什么都不做。把条件压到一张表上，是因为「关闭」是 plan 里唯一不可回收的
自动动作——判定链越短越好核（tech-plan §7.2）。注意 `needs-info` 的标签状态仍要查 GitHub 或本地 `bot_labels`：
**只用 `bot_labels`**（`removed_at IS NULL`）即可，不需要再问 GitHub，这个决定让关闭路径完全是本地判定。

### 3.3 `metrics_daily` 的 `UNIQUE(day, repo, outcome)` + 全量 UPSERT

```sql
INSERT INTO metrics_daily (day, repo, outcome, count, p50_ms, p95_ms, cost_usd, revert_count, command_cost_usd, updated_at)
VALUES (...)
ON CONFLICT (day, repo, outcome) DO UPDATE
   SET count = EXCLUDED.count,
       p50_ms = EXCLUDED.p50_ms,
       p95_ms = EXCLUDED.p95_ms,
       cost_usd = EXCLUDED.cost_usd,
       revert_count = EXCLUDED.revert_count,
       command_cost_usd = EXCLUDED.command_cost_usd,
       updated_at = now();
```

- **全量覆盖，不累加**：重跑某一天、或补跑漏掉的日期，结果都一样。反过来（`count = count + EXCLUDED.count`）
  会让「重跑一次聚合」把数字翻倍，而面板数字是取消阈值后唯一的质量信号，翻倍等于失真。
- 键只有三列 `(day, repo, outcome)`：`revert_count` 单独成列而不是往 `outcome` 里加值，因为「被改回」是写操作维度的
  信号、不是 run 结果维度；按命令拆分塞不进这个键，用 `command_cost_usd` jsonb 承载，精确拆分仍走
  `usage_costs` + `actions` 的短窗口直查。
- 聚合任务每天 00:10 跑（pg-boss cron），写的是**前一天**；`day` 用 UTC 自然日。

---

## 4. 索引与保留期小结

| 数据 | 保留 | 机制 |
|---|---|---|
| `webhook_deliveries.payload` | 90 天 | 每日 cron 清 payload（保留行与 `decision` 做去重） |
| `run_events` | 90 天 | 先聚合进 `metrics_daily`，再删明细 |
| transcript（host-core SQLite） | 90 天 | `session/delete` |
| `metrics_daily` / `actions` | **永久** | 不删（`actions` 永久是「被改回」可追溯的前提） |
| `tasks` / `runs` / `envelopes` | 永久 | 面板详情页要能打开历史任务 |

必备索引（性能相关的只有 6 个，其余靠主键/唯一键）：

```sql
CREATE INDEX ix_tasks_status_queued        ON tasks (status, queued_at);
CREATE INDEX ix_tasks_repo_queued          ON tasks (repo, queued_at DESC);
CREATE INDEX ix_tasks_command_queued       ON tasks (command, queued_at DESC);
CREATE INDEX ix_tasks_failure_class        ON tasks (failure_class) WHERE failure_class IS NOT NULL;
CREATE INDEX ix_actions_repo_applied_at    ON actions (repo, applied_at DESC);
CREATE INDEX ix_actions_reverted_at        ON actions (reverted_at) WHERE reverted_at IS NOT NULL;
```

---

## 5. 相对 tech-plan §7.2 的差异清单

| # | 差异 | 为什么 |
|---|---|---|
| D1 | `tasks` 增加 `started_at` / `ended_at` / `outcome` / `failure_class` / `cost_usd` / `dry_run` | 列表页的耗时、状态徽章、失败筛选、成本排序与 dry-run 徽章都要读它们；每次 join `runs` 取最近一条会把面板查询变成子查询，违反 §8.3「不许解 jsonb、要纯列扫描」的用意 |
| D2 | `actions` 增加 `task_id` / `repo` / `command` / `status` / `target_kind` / `target_number` / `target_ref` / `approval` / `dry_run` | tech-plan 只写了 `target`（单列）。拆成明确的列是为了 `/api/audit` 能按 repo/command 过滤、按 target 展示，且不解析 jsonb（F9）；`approval` 是 §8.3「审批判定」的唯一落点 |
| D3 | `envelopes` 增加 `raw_sha256` / `received_at` | 原文全文不重复入库（在 transcript），只留摘要做「同一份输出」比对；`received_at` 用于详情页排序 |
| D4 | `usage_costs` 增加 `priced` | 没有它，面板无法区分「免费」与「价格表缺条目算不出来」，`pricingCoverage` 就成了猜的 |
| D5 | `bot_labels` 用 `(repo, issue_number, label)` 唯一 + `removed_at` 软删 | 避免「打→撤→打」不断新增行，让「我们当前打过哪些」永远是一次 `removed_at IS NULL` 查询 |
| D6 | `issue_fingerprints` 增加 `last_seen_at` | 命中去重键时要能显示「最近一次命中时间」，否则 `/api/system` 与面板无法判断指纹是否还活着 |
| D7 | 失败分类取值统一成 kebab-case（`rate-limit` / `github-api` / `sandbox-crash`） | plan §10 与 tech-plan §7.3 本身的命名不一致（`rate_limit` vs `sandbox-oom`）。契约冻结时统一成 kebab-case，DB 与 API 同值，不需要两套映射 |
| D8 | plan §10 的粗分类 `sandbox` 拆成 `sandbox-oom` / `sandbox-crash` | tech-plan §7.3 的优先级表已经把两者分开（OOM 不重试、崩溃重试 1 次）；保留粗分类会让重试决策无值可读 |
| D9 | `wikis` 等未列入（原文也没有） | tech-plan §7.2 的 16 张表全部落地，未增未减 |
| D10 | `tasks.container_name` 在容器销毁后置 NULL（未在 tech-plan 写明） | 容器名只是运行期映射；保留脏值会让「这个 job 还有容器吗」出现第二种判断依据（应以 exec 代理的映射表为准） |
