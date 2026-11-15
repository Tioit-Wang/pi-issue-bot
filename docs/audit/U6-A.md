# 需求实现核查：requirements.html §5.6「记录与查询」（FR-6.1 ~ FR-6.4）

- 仓库：`C:\Code\NodeProjects\pi-issue-bot`（HEAD `fbfa029`，工作区有未提交改动，本次只读未改动）
- 需求正文：`docs/requirements.html:1189-1221`
- 核查口径：**只看有查询/API 暴露路径的实现**；「表里有列」不算通过。状态取值：已实现 / 部分实现 / 未实现 / 与需求冲突 / 无法判定。

---

## FR-6.1 完整对话记录（P0）

需求（`docs/requirements.html:1191-1196`）：会话内每一轮的用户输入、助手输出、工具调用与结果，全部按顺序落库；**必须由执行侧生成，不能依赖 agent 自述**。

**状态：已实现（有 3 处小缺口，见下）**

### 证据

1. **落点是执行侧的原始事件流，不是模型自述**
   - 表：`run_events`（`run_id` / `cursor` / `kind` / `payload` / `created_at`），`apps/server/src/db/schema.ts:296-314`。
   - 写入方是 worker（执行侧），由 turn-driver 的 `onEvent` 逐条喂给 `appendEvent`：
     `apps/server/src/worker/run-task.ts:931-978`（`appendEvent(event.kind, event.payload)`，仅过滤流式增量 `item.delta`）、
     `apps/server/src/worker/run-task.ts:602-611`（`deps.store.appendEvent`）、
     `apps/server/src/worker/run-store.ts:40-45`（`insert into run_events (run_id, cursor, kind, payload)`）。
   - 事件来源是 RACP 事件流本身：`apps/server/src/runtime/turn-driver.ts:550-620`（`runEventLoop`，每条事件先 `params.onEvent(event)` 再判定审批/终态）。
   - 因此 `kind/payload` 是宿主（pi-host）返回的原始事件，不经过模型回答文本解析。模型自述只影响 `envelopes`（`run-store.ts:47-66`），与对话记录是两条独立链路。

2. **顺序有单调序列保证**
   - 每 run 一个自增 `cursor`（`run-task.ts:600-611` 的 `cursor += 1` → `assigned`），DB 侧 `uniqueIndex('run_events_run_id_cursor_uidx').on(runId, cursor)`（`schema.ts:310`）。
   - 多轮（只读工具轮）在同一 `runId` 上继续累加同一 `cursor`（`run-task.ts:911-989` 的循环复用同一 `appendEvent` 闭包），所以「同一 run 内的轮次先后」也单调。
   - 查询按 `cursor` 升序返回：`apps/server/src/queries/tasks.ts:472-486`（`order by tail.created_at asc, tail.cursor asc`）。

3. **用户输入（执行侧真值）**
   - 入队时快照：`tasks.prompt_text`（webhook `apps/server/src/http/webhook.ts:116` 的 `insertTask`；DB 列由 `migrations/0001_task_prompt_text.sql` 加）。
   - 调 `turn/start` 的输入就是这份文本：`apps/server/src/runtime/turn-driver.ts:398-402`。

4. **助手输出**
   - 终态条目原文在 `item.completed.payload.text`（落 `run_events`，见上）；真实载荷形状对着真库核过：`apps/server/src/worker/fallback.ts:216`、`apps/server/src/worker/envelope.ts:31-50`。
   - 会话视图取最终正文走 `envelopes.actions` 的 `comment.body`：`apps/server/src/queries/issues.ts:889-899`、`apps/server/src/queries/issues.ts:236-252`。

5. **工具调用与结果**
   - 原始 `item.started`（`payload.event.toolName` / `event.args`）、`tool.progress`（`partialResult…output`）、`item.completed`（`event.isError`/`error`）全部原样落库，查询侧按 `toolCallId` 归并：`apps/server/src/queries/issues.ts:922-1006`（注释 `:924` 明确「真库里工具名只在 `item.started`」）。

### 缺口
- **`item.delta` 不落库**（`run-task.ts:972-977`）：正文流式增量被刻意丢弃（每轮上百条会把详情页挤爆）。终态 `item.completed` 有全文，所以「最终输出」没丢，但「逐 token 的中间态」没有。
- **轮次归属没有列**：`runs.turn_id` 只存最后一次尝试的 turnId（`run-store.ts:104-124` 的 `coalesce($7, turn_id)`），多轮 run 里「第几轮」只能从事件 `payload`/`turn.*` 事件名反推，没有 `turn_seq` 之类的单调列。
- **`tasks.prompt_text` 没进 drizzle schema**：`apps/server/src/db/schema.ts:193-262` 的 `tasks` 定义里没有 `promptText`，但查询在用（`queries/issues.ts:255`）、迁移里有（`migrations/0001_task_prompt_text.sql`）。schema 与真库存在漂移，靠人工记忆而不是 schema 事实源。

---

## FR-6.2 工具调用记录（P0）

需求（`docs/requirements.html:1197-1200`）：每次工具调用记录 工具名、入参、返回摘要、耗时、成功与否；**命令类还要记录 argv、退出码**。

**状态：部分实现**（6 个要求字段里，2 个真正实现，2 个只有「原始 payload 里有、查询不暴露」，2 个缺失）

### 逐字段核对

| 要求 | 状态 | 证据 |
|---|---|---|
| 工具名 | 已实现 | `queries/issues.ts:941`（`payload #>> '{event,toolName}'`）→ 契约 `IssueToolCall.name`（`packages/contract/src/api.ts:911`） |
| 入参 | 部分 | 原始入参 `payload.event.args` 整份在 `run_events.payload`（jsonb）里；但查询只按固定键取**一行摘要**：`queries/issues.ts:72`（`TOOL_ARG_KEYS`）、`:943`、`:998`（截到 160 字）；契约只有 `summary` 一个字段（`api.ts:913`），没有 `args` |
| 返回摘要 | 部分 | 返回内容只在 `tool.progress` 的 `partialResult…output`（`queries/issues.ts:945-949`），且**仅在拿不到 args 时才回退成摘要**（`:998`）；契约同样只有 `summary` |
| 耗时 | **未实现** | 无列、无计算：`usage_costs`/`run_events`/`actions` 都没有耗时字段；`issues.ts:965-973` 只取 `min(created_at)` 当开始时刻，没有配对的结束时刻，`IssueToolCall` 只有 `at`/`ok`（`api.ts:908-918`） |
| 成功与否 | 已实现 | `queries/issues.ts:950-957`（`item.completed` 带 `error`/`isError=true` → `failed`）、`:1001`（`ok: row.failed !== true`） |
| argv（命令类） | **未实现** | `argv` 只存在于平台自己的执行通道（`sandbox/protocol.ts:24`、`sandbox/exec-plan.ts`、`git/run-git.ts:25`），与 agent 的工具调用记录无关；agent 的 Bash 调用只把整条脚本放在 `args.command`，没有拆 argv，也没有落库列 |
| 退出码（命令类） | **未实现** | 唯一从事件里读 `exitCode` 的地方是失败分类（`worker/failure.ts:151-163`，只判 124/137 是否超时），结果进 `runs.failure_detail` 的自由文本 `detail`；查询层没有任何 `exitCode` 字段（`packages/contract/src/api.ts:908-918` 的 `IssueToolCall` 无此字段） |

### 缺口
- 缺 `durationMs`：需要 `item.started` / `item.completed` 配对（同 `toolCallId` 的 `min/max(created_at)`），现在只取了 `min`。
- 缺 argv / 退出码的**结构化**留存：即便宿主事件里有（`partialResult.details.exitCode` 之类），也没有解析、没有列、没有查询。
- 入参/返回「完整 vs 摘要」的取舍没做成可见能力：`/api/issues/.../session` 里只能看到 160 字。

---

## FR-6.3 token 与成本（P0）

需求（`docs/requirements.html:1202-1206`）：**按轮次**记录 prompt token 与 completion token 并折算成本；可汇总到 **issue、仓库、时间** 维度。

**状态：部分实现**（token 分列 + 成本折算 + 执行侧取数都成立；「按轮次」与「issue 维度」两处不成立）

### 证据（成立的部分）

1. **prompt / completion 分列**：`usage_costs.input_tokens` / `output_tokens`（`apps/server/src/db/schema.ts:459-460`），金额 `cost_usd numeric(12,6)`（`:462`）。
2. **数据源是执行侧真值，不是模型自述**：`apps/server/src/cost/host-usage.ts:1-16`（读 pi-host 自己的 `pi.sqlite`.`turns`）；写入点 `apps/server/src/worker/run-task.ts:1589-1627`，注释 `:1591` 明写「不信信封里的 `usage`（那是 agent 自己填的，实测恒为 0）」。
3. **成本折算**：`apps/server/src/cost/pricing.ts:102-135`（DeepSeek 官方价目 + 峰谷 + 缓存命中三段分别计价，`PRICE_VERSION` 版本化 `:41`）。
4. **仓库维度**：`queries/costs.ts:132-149`（`byRepo`）。
5. **时间维度**：`queries/costs.ts:189-233`（`series`，UTC 日；明细期外用 `metrics_daily` 补），持久日汇总 `jobs/metrics-rollup.ts`。
6. **任务/单次尝试维度**：`queries/costs.ts:235-254`（`topTasks`）、`queries/tasks.ts:143-148,174`（`TaskListItem.costUsd` = 该任务所有 run 的 `usage_costs` 之和）。
7. API：`GET /api/costs`（`apps/server/src/http/api/index.ts:136-145`）。

### 缺口

- **「按轮次」不成立**：`usage_costs` 没有 `turn_id`（schema `:452-469`，迁移 `migrations/0000_init.sql:151` 也只有 `run_id`），写入侧只读**最后一次** turn 的用量（`run-task.ts:1594` `const usageTurnId = turnId ?? recordedIds.turnId`）。只读工具轮的多轮 run 里，前面几轮的 token 直接丢掉 → 粒度是「run（≈任务一次尝试）」，不是「轮次」。
- **issue 维度不成立**：`CostsResponse` 只有 `total / byRepo / byCommand / byModel / series / topTasks`（`packages/contract/src/api.ts:409-422`），没有 `byIssue`；按 issue 汇总只能靠 `TaskListItem.costUsd` 手工加。面板成本页的维度选择也只有 command/repo/model（`apps/panel/src/routes/costs.tsx:155`）。
- **「单轮成本可下钻」不成立**：能从 `topTasks.taskId` 进到 `/api/tasks/:id`，但 `RunSummary` 没有 usage 字段（`api.ts:238-252`），`envelopes.usage` 是 agent 自述（恒 0，`run-task.ts:1591`），所以**单个 run / 单轮的成本在任何 API 上都读不到**。

---

## FR-6.4 后台查询四视图（P0）


需求（`docs/requirements.html:1207-1221`）。逐视图核对「查询层 + API 层是否真有路径」。

### ① 会话详情：**部分实现**

- 有：`queryIssueSession`（`apps/server/src/queries/issues.ts:1008-1041`，人轮来自 `tasks`、bot 轮来自 `runs` 合并，`MAX_TURNS=500`），按轮分组 + 每轮 `toolCalls`；API `GET /api/issues/:owner/:name/:kind/:number`（`apps/server/src/http/api/index.ts:213-230`）；面板页 `apps/panel/src/routes/issue-detail.tsx`。
- 缺：**「每条工具调用可展开看入参」做不到** —— 契约 `issueToolCallSchema` 只有 `{name, summary(≤200), at, ok}`（`packages/contract/src/api.ts:908-918`），面板只渲染 `call.summary` 的 truncate 文本（`apps/panel/src/routes/issue-detail.tsx:390-391`）。完整入参只存在于 `/api/tasks/:id` 的 `run_events[].payload`（`queries/tasks.ts:474-486`，契约 `api.ts:256-266` 保留原始 `payload`），即要跨到另一个页面看原始 jsonb。
- 另：按轮分组没有「轮次序号」，人轮/bot 轮是两段拼接后按时间排序（`issues.ts:1008-1015`）。

### ② 成本与用量：**部分实现**

- 有：`/api/costs`（仓库/命令/模型 + 日趋势 + 最贵任务），见 FR-6.3 证据。
- 缺：issue 维度聚合（无 `byIssue`）、单轮成本下钻（见 FR-6.3 缺口两条）。

### ③ 事件时间线（投递 → 判定 → 执行 → 写回；被忽略也能看原因）：**部分实现**

- 执行 + 写回有：`/api/tasks/:id` 返回按 `cursor` 升序的 `run_events`（`queries/tasks.ts:472-486`）+ `actions`（`:500-516`，含 `audit.declared/actual/dropped/rejectedReason`，`queries/tasks.ts:400-409`）；`kind` 归一保留了 `writeback.*`（`queries/sql.ts:315-337`）。面板 `apps/panel/src/components/EventTimeline.tsx` + `routes/task-detail.tsx`。
- **投递段与判定段没有查询路径**：`webhook_deliveries.decision` / `decision_reason` 两列存在且确有写入（`db/schema.ts:107-124`；写入 `http/webhook-v21.ts:180-200`，`http/webhook.ts:1016`；判定纯函数 `trigger/decide.ts`），但**全仓 `queries/` 里没有任何一处 select 这两列**（`apps/server/src/queries` 全目录 grep `decision` 只命中 `audit.ts` 里审批判定的同名字段），也没有 deliveries/时间线接口（路由清单 `http/api/index.ts:99-250`：overview / tasks / tasks:id / costs / quality/reverts / audit / audit/export.csv / system / issues / issues:… / repos / skills）。
- 因此「**被忽略的事件也能看到原因**」这一条**未实现**：数据在库里，读不出来。

### ④ 审计（谁触发、改了什么、失败了在哪一步）：**已实现（第三项要靠下钻）**

- 有：`queryAudit` / `queryAuditCsv`（`apps/server/src/queries/audit.ts:56-210`）—— `actor_login`（谁触发，`audit.ts:101,124`）、`intent/target/external_ref/status/headSha`（改了什么，`:89-100`）、审批判定 `approval{tool,decision,rule}`（`:75-82,104-111`）、CSV 导出按契约列序 + BOM（`:197-210`）。
- API：`GET /api/audit`、`GET /api/audit/export.csv`（`http/api/index.ts:156-190`）；面板 `routes/audit.tsx`。
- 「失败了在哪一步」：审计行本身**没有 step 列**（`AUDIT_COLUMNS` `audit.ts:85-102`），只有 `status`（applied/dry-run/skipped/rejected/failed，`queries/sql.ts:348-356`）。真正的「哪一步」在 `runs.failure_class` + `failure_detail`（`run-task.ts:1703-1734`，含 signals / actions / fallback / containerState）里，经 `/api/tasks/:id` 的 `RunSummary.failureDetail`（`api.ts:249`、`queries/tasks.ts:311-322`）可见；`TaskStep` 九步序列**只写 debug 日志**（`app/compose.ts:1428-1430`），没有落库。

---

## 本节整体结论

- **1 条已实现、3 条部分实现**：FR-6.1 已实现（3 处小缺口）；FR-6.2 / FR-6.3 / FR-6.4 均为部分实现（逐项见上）。

| 需求 | 状态 | 一句话 |
|---|---|---|
| FR-6.1 完整对话记录 | 已实现（3 处小缺口） | 执行侧原始事件流 + `(run_id,cursor)` 唯一索引，顺序与来源都站得住；缺 delta 增量、缺轮次序号列、`prompt_text` 不在 drizzle schema |
| FR-6.2 工具调用记录 | 部分实现 | 名称/成功与否有；入参与返回只有 160 字摘要；**耗时、argv、退出码三项都没有** |
| FR-6.3 token 与成本 | 部分实现 | token 分列 + 峰谷计价 + 仓库/时间维度都对；**「按轮次」与 issue 维度不成立，单 run/单轮成本无 API** |
| FR-6.4 四视图 | 部分实现 | ①有会话流但入参不可展开；②缺 issue 维度与单轮下钻；③**投递/判定段与「被忽略原因」无查询路径**；④审计三项齐，第三步靠 `failure_detail` 下钻 |

**最该先补的三件事**（按需求优先级排序）：

1. FR-6.4③：给 `webhook_deliveries.decision / decision_reason` 一条查询路径（deliveries 时间线接口）—— 数据已齐，只差读出来，成本最低、缺口最硬。
2. FR-6.3：`usage_costs` 加 `turn_id`（或在 run 内逐轮写行）、`CostsResponse` 加 `byIssue`，让「按轮次」与「issue 维度」成立。
3. FR-6.2：`run_events` 侧按 `toolCallId` 配对出 `durationMs`，并给命令类事件抽 `argv`/`exitCode` 落结构化字段（列或投影），契约 `IssueToolCall` 加 `args`/`durationMs`/`exitCode`。

**核查过程说明**：全部为静态阅读（`apps/server/src/db/schema.ts`、`queries/*`、`worker/run-*.ts`、`runtime/turn-driver.ts`、`cost/*`、`packages/contract/src/api.ts`、`migrations/*`、`apps/panel/src/routes/*`），未修改任何仓库文件，未运行测试。
