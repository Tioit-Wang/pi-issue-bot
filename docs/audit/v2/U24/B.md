# U24 8 数据需求 · B

> 核查范围：docs/requirements.html 行 1804-1821
> 代码基线：见 docs/audit/v2/_baseline.txt（HEAD fbfa029，工作区含既有未提交改动；本次未改动任何文件）

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| DATA-1 事件投递 | 部分实现 | `decision`/`decision_reason` 写得很全，但全仓零读取方，后台查不到「为什么没处理」 |
| DATA-2 项目配置 | 部分实现 | 当前生效配置在，**「版本」完全不存在**（无版本列、无历史表） |
| DATA-3 会话 | 已实现 | — |
| DATA-4 轮次 | 已实现 | — |
| DATA-5 对话 | 部分实现 | 明细入库齐全，但「后台查看完整对话」被固定上限截断（50 工具调用 / 160 字符 / 500 轮、500 事件） |
| DATA-6 用量 | 已实现 | — |

## 逐条

### DATA-1 事件投递
- **状态**：部分实现
- **证据**：
  - `apps/server/src/db/schema.ts:88-135` — `webhook_deliveries` 有 `delivery_id`（主键/幂等键）、`event`、`action`、`repo`、`payload`（jsonb 原始请求体）、`signature_valid`、`decision`、`decision_reason`、`received_at`；`received_at` 上有索引（注释即「保留期清理（90 天）按接收时间扫」）。
  - `apps/server/src/http/webhook.ts:95-98` — INSERT 落 `event/action/repo/payload/signature_valid`；`:133` `readPayload` 供回放。
  - `apps/server/src/http/webhook.ts:1014-1025` — 判定留痕在外层统一写一次，覆盖验签失败/暂停/未知仓库/开关关闭等早退分支；UPDATE 本体在 `apps/server/src/http/webhook-v21.ts:200`（`SET "decision" = $2, "decision_reason" = $3`），行形状见 `webhook-v21.ts:188-195`（triggered/ignored 两侧都产行）。
  - `apps/server/src/jobs/retention-cleanup.ts:25` `RETENTION_DAYS = 90`；`:73-88` 与 `:213-230` 按 `received_at < cutoff` 分批删（每批 ≤1000）；`:54-71` + `:193-211` 同口径删 `run_events`。
  - `apps/server/src/queue/definitions.ts:220-224` cron `40 0 * * *`（UTC）；`apps/server/src/jobs/index.ts:107` 注册该作业且不设 `requires`（无 docker/github 也注册）；`apps/server/src/app/compose.ts:1547` 启动时注册。
  - 回放入口：`apps/server/src/http/webhook.ts:1801-1821` `replayDelivery()` 读原文重放（强制 dry-run、跳过验签与投递去重），CLI 命令 `apps/server/src/cli.ts:71-72`、调用点 `:344`。
- **缺口**：**「判定结果」只落库、不出门口。**`decision` / `decision_reason` 在 `apps/server/src/queries/*`、`packages/contract/src/*`、`apps/panel/src/*` 中零引用（grep `decision` 只命中审批事件的同名键，如 `queries/audit.ts:107`、`panel/src/routes/task-detail.tsx:198`），也没有任何 API/面板面显示投递的判定与原因。因此需求给的用途「排查『为什么没处理』」只能直连 PG 手写 SQL，BR-6「可在后台查询」不成立。次要缺口：项目级 `limits.data_retention_days` 有契约字段（`packages/contract/src/settings-v21.ts:244`、`apps/server/src/config/v21-settings.ts:218`），但清理作业从不读它（`retention-cleanup.ts:146` 只用入参/常量），改配置改不动保留期。
- **判定依据**：记录侧四个字段（原始请求体 / 事件类型 / 动作 / 判定结果）齐备且写入路径无遗漏，90 天保留与回放是真实实现；但需求给的用途之一是「排查为什么没处理」，判定列无查询出口 → 不能判已实现，且缺的是需求明写的用途子条件，故为部分实现。
- **反证过程**：
  1. *假设「判定结果」没有专用列* → 去 `db/schema.ts` 找：`decision`（:112）、`decision_reason`（:124）确实存在，且迁移真加了列（`migrations/0011_v21.sql:16`、`:18`）。假设被推翻。
  2. *再假设「有列但没写」* → 找到唯一 UPDATE 语句（`webhook-v21.ts:200`）与唯一调用点（`webhook.ts:1017`），且 `handleWebhook` 包一层正是为了让每个早退分支都写（`webhook.ts:979-993`）；`deps.v21` 在 serve 两条装配处都注入（`app/compose.ts:981`、`:1401`）。假设被推翻：写入是真的。
  3. *假设「回放只是个词」* → `replayDelivery` 有真实调用方（`cli.ts:344`）、读的是 `webhook_deliveries.payload` 原文、强制 dry-run。假设被推翻：回放有入口（仅 CLI，无 API/面板入口）。
  4. *假设「90 天清理是摆设」* → 查注册链：`JOB_SCHEDULES`（jobs/index.ts:107）→ `registerJobs`（compose.ts:1547）→ cron（queue/definitions.ts:221）。假设被推翻。
  5. *数据安全假设：「清理会误删长期保留的轮次或用量」* → 全仓 `delete from` 只有 5 处：`jobs/metrics-rollup.ts:156`（重算剪枝）、`jobs/retention-cleanup.ts:55` 与 `:74`（两张明细表）、`skills/store.ts:640-641`。`runs` / `usage_costs` / `actions` / `envelopes` 无任何删除路径。**该假设被推翻：不会误删长期数据。**但发现 90 天后 `tasks.delivery_id` 指向的投递行已删，读侧 `queries/issues.ts:824-832`（标题/链接/状态）与 `:647`（commentUrl）没有兜底，会退化为空，记入「额外问题」。

### DATA-2 项目配置
- **状态**：部分实现
- **证据**：`apps/server/src/db/schema.ts:146-179` — `repos` 持有 `settings`（jsonb，形状 = `repoSettingsSchema`）、`settings_valid`、`settings_error`、`settings_updated_at`、`enabled`、`dry_run`、`archived_at`；`apps/server/src/config/repo-config.ts:162-170` `updateSettings` 是**直接覆盖写**（`SET settings = $2::jsonb, settings_updated_at = now()`），读取 `repo-config.ts:143-144`；配置从不改动即长期可读，`repos` 行也没有删除路径（面板明说没有 `DELETE /api/repos/:owner/:name`，`apps/panel/src/components/settings/general-section.tsx:110`）。
- **缺口**：**缺「版本」**。全仓搜 `settings_version|config_version|revision|configHistory|settingsHistory` 零命中；`db/schema.ts:820-845` 的 24 张表里没有配置版本/历史表，`migrations/` 到 `0011_v21.sql` 也没有；`settings_updated_at` / `updated_at` 只是时间戳，按模板口径「只有 updated_at 不算版本」。后果：覆盖写之后旧配置无从追溯，「这一轮判定用的是哪一版配置」答不出来，BR-8「配置即快照」只能靠事件内的内存快照而非持久版本。
- **判定依据**：需求写的是「当前生效的配置与版本」，前者有实现路径、后者完全找不到载体 → 部分实现并点名缺「版本」。
- **反证过程**：
  1. *假设版本藏在不叫 version 的列* → 查 API 契约的仓库详情字段（`packages/contract/src/api.ts:618-748` 只用 `settingsValid` / `archivedAt` / `settingsUpdatedAt`）与迁移文件，均无版本号。
  2. *假设历史在别处留档* → `skills` 确实有 `skill_versions`（`migrations/0002_skills.sql`、`apps/server/src/skills/store.ts`），但那是技能库，与仓库配置无关。
  3. *假设旧的 `repos.config` 列算历史版本* → `db/schema.ts:167-172` 标明 `@deprecated`「W1 之后不再读写」，且只存退役的 `.github/pi-bot.yml` 单一快照，没有多版本。三次反证全部失败 → 确认无版本概念。

### DATA-3 会话
- **状态**：已实现
- **证据**：`apps/server/src/db/schema.ts:658-686` — 主键 `(repo, issue_number)`，列 `session_id` / `state` / `sandbox_id` / `closed_at` / `turns` / `cursor`；`db/schema.ts:689-694` `AGENT_SESSION_STATE` 只有 `active` / `idle`。状态机 `apps/server/src/agent/session-state.ts:69`（`SESSION_ACTIONS` 只有 `create|reuse|recycle-sandbox`）、`:108-164`（`issues.closed` + 实时 closed → `recycle-sandbox`，`keepSession: true`）。落库 SQL `apps/server/src/http/webhook-v21.ts:786-802`：`read` + `create`(INSERT ON CONFLICT DO NOTHING) + `recycle`(UPDATE→idle、`sandbox_id=NULL`、`closed_at=now()`) + `reuse`(UPDATE→active)，**无 DELETE**。`apps/server/src/app/compose.ts:1187-1188` 同约定（只 UPDATE state/sandbox_id/closed_at）。
- **缺口**：无。（仅提示：`reuse` 会把 `closed_at` 置 NULL，`webhook-v21.ts:800`，属状态复位，不是删数据，不构成需求违背。）
- **判定依据**：映射、运行状态（活跃/空闲）、「关闭只回收沙箱不删会话」三件都有实现路径，且删除/归档能力在类型与 SQL 两层都不存在 → 全部子条件满足。
- **反证过程**：*假设有某条清理/归档路径会删会话* → 逐条排除：全仓 `delete from` 5 处无一指向 `agent_sessions`；`jobs/retention-cleanup.ts:73-88` 只处理 `webhook_deliveries`，`:54-71` 只处理 `run_events`；`jobs/lifecycle-sweep.ts` 经 `apps/server/src/sandbox/lifecycle.ts:142-183` 只回收容器与 worktree，不写库；`agent/session-state.ts:69` 的动作枚举把 `delete/archive/end` 从类型上排除。假设被推翻。

### DATA-4 轮次
- **状态**：已实现
- **证据**：`apps/server/src/db/schema.ts:265-293` — `runs(id, task_id, attempt, session_id, turn_id, started_at, ended_at, outcome, failure_class, failure_detail, created_at)`。写入 `apps/server/src/worker/run-store.ts:31-38`（`beginRun` 写 `started_at`）、`:104-122`（`finishRun` 写 `outcome/failure_class/failure_detail/ended_at/session_id/turn_id`）；调用点 `apps/server/src/worker/run-task.ts:659`、`:1739`，失败分类来自 `:1583-1585`（`decideOutcome` / `pickHighestPrioritySignal`）。读取 `apps/server/src/queries/tasks.ts`、`queries/costs.ts`、`jobs/metrics-rollup.ts:166-171`。
- **缺口**：无。保留：无任何清理作业引用 `runs`（见 DATA-1 反证第 5 条）。
- **判定依据**：「每次执行的起止、结果、失败原因」三组字段齐全、写入与读取路径都在、且无删除路径 → 已实现。
- **反证过程**：*假设只有成功路径写 runs、失败/兜底路径漏写* → `finishRun` 在 `run-task.ts:1739` 收尾统一调用（非仅成功分支），且 `run_events` 一律 require 先插 `runs`（`run-store.ts:7-8` 的写入顺序约定 + `beginRun` 是第一个动作）；*假设 runs 会被清理* → delete 语句里没有它，反而 `retention-cleanup.ts:41-45`、`:170-178` 用 `RUNS_ON_DAY_SQL` 把 runs 当作「不许先删明细」的保护依据，反向证明 runs 必须长期在。假设均被推翻。

### DATA-5 对话
- **状态**：部分实现
- **证据**：明细表 `run_events`（`apps/server/src/db/schema.ts:296-314`：`run_id` / `cursor` / `kind` / `payload` / `created_at`，唯一索引 `(run_id, cursor)`），全量 append 在 `apps/server/src/worker/run-store.ts:40-45`。后台读取两处：issue 会话视图 `apps/server/src/queries/issues.ts:922-1005`（工具调用按 `toolCallId` 归并），任务详情 `apps/server/src/queries/tasks.ts:472-486`（事件流）；机器人轮正文来自 `envelopes.actions`（`queries/issues.ts:890-899`）。
- **缺口**：
  1. **「后台查看完整对话」缺**：issue 会话视图硬截断到每 run **前 50 条**工具调用（`queries/issues.ts:60`、`:987`、`:1004`）、参数/输出只留**首行 160 字符**（`:58`、`:998`）、轮次上限 **500**（`:64`、`:1015`）；任务详情只给**最近 500 条**事件、**20** 个 run（`queries/tasks.ts:60-61`、`:481`、`:467`）。库里明细是全的，任何接口/界面都拿不到全量。
  2. **保留不是「按需」而是固定 90 天硬删**：`apps/server/src/jobs/retention-cleanup.ts:54-71`（`delete from run_events where created_at < cutoff`）+ `:193-211`，`cutoff = now - 90 天`（`:25`、`:159`）。且面板把这条链叫 `transcriptDays`（`apps/server/src/queries/system.ts:38`），并无 transcript 表。
- **判定依据**：需求三列里「记录什么」与「保留按需」（90 天策略）都能对上，但「用途：后台查看完整对话」被固定上限截断，属明写用途缺失 → 部分实现。
- **反证过程**：
  1. *假设对话明细另有专表* → 全仓 `transcript` 只命中 `queries/system.ts:38` 的常量、`compact/summary.ts:82` 的渲染函数、面板展示文案与 `panel/src/mocks/handlers/system.ts:50`（还写成 30 天），schema 里没有 transcript 表 → 明细只能是 `run_events`。
  2. *假设明细被某清理作业按天删、且能写出天数* → `RUN_EVENTS_DELETE_SQL`（`:54-64`）分批删 `created_at < cutoff` 的行，天数 = **90**；另有保护：该天有 `runs` 但 `metrics_daily` 没聚合就整天跳过（`:164-191`），所以不会「先删后算」。
  3. *假设界面能给全量* → 两处查询都带 `limit`（issues 50/500/160，tasks 500/20），反证失败。

### DATA-6 用量
- **状态**：已实现
- **证据**：`apps/server/src/db/schema.ts:452-469` — `usage_costs(run_id, model, input_tokens, output_tokens, cost_usd numeric(12,6), created_at)`。写入 `apps/server/src/worker/run-store.ts:89-95`（每 run 一行 INSERT），调用点 `apps/server/src/worker/run-task.ts:1595-1607`：读 pi-host 的真 token 数，用 `estimateDeepSeekCostUsd` 本地计价；usage 读取器在 `apps/server/src/app/compose.ts:1374` 注入（`createHostUsageReader`）。读取 `apps/server/src/queries/costs.ts:78`、`:116-120`、`:212`，`queries/tasks.ts:145`，聚合 `jobs/metrics-rollup.ts:72`。
- **缺口**：无。（若未注入 usage 读取器或拿不到 `turnId` 就整条不写，`run-task.ts:1595`——是缺行而非 0 记账，成本面板按 `null` 区分，属设计取舍。）
- **判定依据**：token 与成本两类数值都有列、有真实写入、有读聚合，且无删除路径 → 已实现。
- **反证过程**：*假设成本是模型自填的假数* → `run-task.ts:1589-1593` 明确不信信封里的 `usage`（实测恒 0），改读宿主 `turns` 表并本地计价，读取失败也不影响任务结局；*假设 usage_costs 会被 retention 清掉* → delete 语句无该表；*假设 metrics-rollup 的剪枝会动用量* → `ROLLUP_PRUNE_SQL`（`jobs/metrics-rollup.ts:155-163`）只删 `metrics_daily` 中重算后已不存在的分组，不触及 `usage_costs`。三个假设均被推翻。

## 本节整体结论
6 条中 DATA-3 / DATA-4 / DATA-6 无争议已实现。保留期是本节最实的一块：90 天清理真实注册并按日执行，且只删 `webhook_deliveries` 与 `run_events` 两张明细表，`runs` / `usage_costs` / `actions` / `envelopes` 全无删除路径，不存在「清理误删长期保留数据」的实现缺陷。但 DATA-1（判定结果零读取方）、DATA-2（无配置版本）、DATA-5（后台拿不到完整对话）各缺一个需求明写的子条件。故本节**不能**判为已实现。

## 核查边界
- 是否执行了命令：**未执行测试或起库**，纯静态核查（只做只读 grep 与文件读取）；`git rev-parse --short HEAD` = `fbfa029`，与 `_baseline.txt` 记录的 HEAD 一致，本次未修改任何仓库文件（仅写本文件）。
- 未覆盖的条目及原因：90 天清理在**真库**上的实际行为（分批删除是否收敛、`metrics_daily` 缺行时是否真整天跳过、rows 计数）需 PG 才能确认，未运行；pg-boss 定时在部署实例里是否真的注册成功同样需运行环境。
- 发现的额外问题（不属本节主线的判据，但值得记录）：
  1. `limits.data_retention_days`（`packages/contract/src/settings-v21.ts:244`、`apps/server/src/config/v21-settings.ts:218`）无消费方，保留期硬编码在 `jobs/retention-cleanup.ts:25`——配置项是死字段，且与作业常量构成第二处真相（`queries/system.ts:38` 又抄了一遍 90）。
  2. 90 天后投递行被删，读侧无兜底：`queries/issues.ts:824-832` 的 issue 标题/链接/状态取自「该 issue 最近一条投递」的 payload，`queries/issues.ts:647` 的 `commentUrl` 取自 payload——长期保留的人类轮正文有 `prompt_text` 兜底（`:645`），但标题/链接/状态没有，会退化为空并置 `state_stale`。这是「长期保留的数据依赖 90 天数据」的结构性隐患。
  3. `queries/system.ts:38` 的 `transcriptDays: 90` 指向不存在的 transcript 表；面板 mock 写成 30（`apps/panel/src/mocks/handlers/system.ts:50`），演示值与服务端不一致。
  4. `agent_sessions.closed_at` 在 issue 重开时被 `reuse` 置 NULL（`apps/server/src/http/webhook-v21.ts:800`），「曾经关闭过」在会话表里不留痕，只能回查投递表（而投递表 90 天）。
  5. `repos` 的 `config / config_valid / config_error` 过渡期列仍在（`db/schema.ts:167-172`）与 `settings*` 并存，读侧 `queries/system.ts` 仍有引用，易被误读为两套配置来源。
