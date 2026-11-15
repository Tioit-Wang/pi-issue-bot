# U13 5.6 记录与查询 · A

> 核查范围：docs/requirements.html 行 1189-1221
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| FR-6.1 | 部分实现 | 落库侧只丢 `item.delta`（正文流式增量），来源要求（执行侧生成）满足；但**查询出口**的助手正文只读 `envelopes.actions[comment].body`，读不到 `run_events` 里已落的 `item.completed` 原文 |
| FR-6.2 | 部分实现 | 六项里「耗时」无字段、「argv + 退出码」完全没有；「入参」只有单键单行摘要，「返回摘要」被降级为入参的 fallback |
| FR-6.3 | 部分实现 | `usage_costs` 粒度是 **run** 不是 turn（多轮只记最后一轮）；聚合缺 **issue 维度**；**单轮成本无法下钻**（轮次响应无 cost 字段，面板读到的恒 null） |
| FR-6.4 | 部分实现 | 会话详情与成本视图骨架在；事件时间线只覆盖「执行→写回」（`decision_reason` 全仓无读取）；审计缺「失败了在哪一步」（steps 只在内存） |

## 逐条

### FR-6.1
- **状态**：部分实现
- **证据**：
  - `apps/server/src/worker/run-store.ts:42` — `insert into run_events (run_id, cursor, kind, payload)`；表与唯一键见 `apps/server/src/db/schema.ts:296`、`:310`（`uniqueIndex('run_events_run_id_cursor_uidx')`）。
  - `apps/server/src/worker/run-task.ts:931` — 事件记录由 worker（执行侧）逐条生成，不依赖 agent 自述：`onEvent: async (event) => { captured.push(...)`；唯一过滤在 `apps/server/src/worker/run-task.ts:975`：`if (event.kind !== 'item.delta')`。
  - `apps/server/src/worker/run-task.ts:602` — `appendEvent` 用自增 `cursor`（`cursor += 1`）并以 `appendChain` 串成一条 Promise 链，落库顺序由执行侧保证；失败只 warn（`:609`）。
  - `apps/server/src/queries/issues.ts:1008` — 会话按「轮」组装：`[...taskRows.map(toHumanTurn), ...groupBotRuns(...)]` 后 `sort(compareTurns)`；人类轮来自 `tasks`，机器人轮以 `runs` 为骨架（`:887`）。
  - `apps/server/src/queries/issues.ts:890` — 机器人一轮的正文**只从信封取**：`select a.value ->> 'body' from envelopes e ... where a.value ->> 'intent' = 'comment'`；人类轮正文取 `apps/server/src/queries/issues.ts:777`：`d.payload -> 'comment' ->> 'body' as comment_body`（`webhook_deliveries`），退回 `t.prompt_text`（`:774`）。
  - `apps/server/src/jobs/retention-cleanup.ts:74` — `delete from webhook_deliveries`（90 天，与 `docs/requirements.html:1812` 的「事件投递 90 天」一致）。
- **缺口**：
  1. **助手输出的查询出口与落库内容不一致**：`item.completed` 的 message 原文落在 `run_events.payload`，但「会话详情」的机器人正文只解析 `envelopes.actions[intent=comment].body`。信封不合法或模型没产出 `comment` 动作时（`envelopes` 每 run 只有一行，`apps/server/src/db/schema.ts:344`），该轮助手输出在后台显示为「本轮没有正文」（`apps/panel/src/routes/issue-detail.tsx:400`）。需求要求的「助手输出全部按顺序落库**并可查**」在查询侧不成立。
  2. **`item.delta` 不落库**（`apps/server/src/worker/run-task.ts:975`）。注释理由是「审计与面板不需要」；结果是正文只有 `item.completed` 的整段文本一条命，该事件缺失（断线、`stream-ended`）时这一轮正文永久为空。
  3. **人类轮正文有 90 天时限**：`toHumanTurn` 只读 `webhook_deliveries.payload.comment.body` 与 `tasks.prompt_text`，而 `prompt_text` 只在自由问答任务上写（`apps/server/src/http/webhook.ts:1361` 传 `plan.promptText ?? null`，其余为 `null`）。90 天后人类轮正文变 `null`，与「记录永久保留、后台随时可查完整对话」（`docs/requirements.html:895`）冲突。
- **判定依据**：来源要求（执行侧生成、带 `cursor` 序）满足，四类内容都有落点；但「按顺序可查」在助手输出一侧断在查询层，人类轮正文另有时限，属明写子条件未满足 → 部分实现。

### FR-6.2
- **状态**：部分实现
- **证据**：
  - **工具名**：`apps/server/src/queries/issues.ts:941` — `when e.kind = 'item.started' then nullif(e.payload #>> '{event,toolName}', '')`；取不到给 `UNKNOWN_TOOL`（`:66`）。真库断言见 `apps/server/test/queries-issues.test.ts:296`（`name: 'read/fetch-spans'`）。
  - **入参**：`apps/server/src/queries/issues.ts:75` — `sqlToolArgs()` 按 `TOOL_ARG_KEYS = ['command','path','file_path','pattern','query','url']`（`:72`）取**第一个字符串值**，截到 `SUMMARY_CHARS = 160`（`:58`）；断言见 `apps/server/test/queries-issues.test.ts:303`（Bash 多行脚本只留第一行 `summary: 'npm test'`）。
  - **返回摘要**：`apps/server/src/queries/issues.ts:945` — `when e.kind = 'tool.progress' then coalesce(...)` 从 `event.partialResult.content[0].text`（`:946`）/ `details.output`（`:947`）取；但 `:998` 的取值是 `firstLine(args_raw, …) ?? firstLine(output_raw, …)`：入参能摘出东西时返回值摘要不展示。
  - **成功与否**：`apps/server/src/queries/issues.ts:950` — `item.completed` 且 `payload` 带 `event.error` / `error` / `event.isError === 'true'` 即 `failed`（`:950-957`）；`:1001` 的 `ok: row.failed !== true`。断言见 `apps/server/test/queries-issues.test.ts:307`（`ok: false`）。
  - **契约字段**：`packages/contract/src/api.ts:908` — `issueToolCallSchema` 只有 `{name, summary, at, ok}`（`:911-915`），`.strict()`，**无入参全文、无耗时、无 argv / 退出码**。
  - **命令类 argv + 退出码**：`apps/server/src/sandbox/exec-proxy.ts:380` 拿到 `result`，`:382-385` 只把 `result.exitCode` 写回 socket 末帧，不落 `run_events`；`apps/server/src/queries/sql.ts:331` 虽保留 `command.%` 的事件分类分支，但 `apps/server/src/worker/run-task.ts` 全部 `appendEvent(...)` 调用点（`:856`/`:952`/`:981`/`:1005`/`:1056`/`:1073`/`:1083`/`:1172`/`:1185`/`:1210`/`:1263`/`:1278`/`:1350`/`:1457`/`:1517`/`:1551`/`:1685`）**没有任何 `command.*`**。
- **缺口**：
  1. **耗时缺失**：`IssueToolCall` 无 `durationMs`；`at` 是该 toolCallId 最早一条事件的时间（`apps/server/src/queries/issues.ts:1000`），既不是耗时也不是结束时间。`run_events` 的 started / completed `created_at` 差足以算耗时，但没有任何查询算它。
  2. **命令类 argv 与退出码缺失**：`run_events` 里没有承载二者的任何事件；`exec-proxy` 的 `exitCode` 只走 socket 帧，进程结束即丢。
  3. **入参只是摘要**：`sqlToolArgs()` 只挑一个键、只留 160 字，对象 / 数组 / 其余键全部丢弃；契约也没有承载完整入参的字段 —— 这正是 FR-6.4「每条工具调用可展开看入参」无法满足的根因。
  4. **返回摘要常常不可见**：`args_raw ?? output_raw` 的优先级让「返回摘要」成为入参的 fallback（`:998`）。
- **判定依据**：六项中「工具名 / 成功与否」由执行侧事件驱动并有具体断言；「入参」退化为单键摘要、「返回摘要」被降级、「耗时」与「argv + 退出码」完全缺失，四项子条件不满足 → 部分实现。

### FR-6.3
- **状态**：部分实现
- **证据**：
  - **记账粒度是 run**：`apps/server/src/db/schema.ts:452` — `usage_costs` 的维度是 `run_id`（`:456` `runId: text('run_id').notNull()`，索引 `:466`），每行 `(run_id, model, input_tokens, output_tokens, cost_usd)`；写入注释明写「一个 run 一行」（`apps/server/src/worker/run-store.ts:86`）。
  - **写入点每 run 一次**：`apps/server/src/worker/run-task.ts:1600` — `deps.store.recordUsage({ runId: input.runId, … })`；多轮只读工具轮（同一 run 内循环调 `driveTurn`，`:911`）只取**最后一个** `turnId`（`:1594` 的 `const usageTurnId = turnId ?? recordedIds.turnId`），此前轮次用量不单独记账。
  - **token 来源本身是按轮**：`apps/server/src/cost/host-usage.ts:73` — `select model_id, input_tokens, output_tokens, usage_json from turns where id = ?`（`turnId` 为唯一参数），说明 host 侧有轮级数据，我们只取一次、只写一行。
  - **成本折算**：`apps/server/src/worker/run-task.ts:1599` — `estimateDeepSeekCostUsd({ model: usage.modelId, tokens: usage, at: endedAt })`（导出见 `apps/server/src/cost/index.ts:11`）。
  - **聚合维度**：`apps/server/src/queries/costs.ts:144`（`group by repo`）、`:163`（`group by command`）、`:182`（`group by model`）、`:206`（按 UTC 日 `by_detail` + `metrics_daily` 的 `series`）；契约 `packages/contract/src/api.ts:409` 的 `costsResponseSchema` 只有 `byRepo / byCommand / byModel / series / topTasks`。
  - **单轮成本下钻**：`packages/contract/src/api.ts:931` 的 `issueTurnSchema` 无 `costUsd` / `durationMs`；面板靠 `apps/panel/src/components/issues/contract-extras.ts:104` 的 `readRunCost()` 读 `record['costUsd']`，响应里没这个字段 → 恒 `null`，`apps/panel/src/routes/issue-detail.tsx:362` 因此永不渲染本轮成本。
- **缺口**：
  1. **「按轮次记录」不成立**：粒度是 run（`run_id`）；一个 run 内有多次 `turn/start` 时只有最后一轮的 token 进库，前面几轮（含工具轮的中间轮）成本被算进最后一轮或干脆丢失。
  2. **三个聚合维度缺 issue**：只有仓库 / 命令 / 时间（`costs.ts:144`、`:163`、`:206`），`byIssue` 在全仓零命中；`topTasks`（`:238` 按 `task_id` 分组）是最贵任务 Top N，不是「按 issue 聚合」。
  3. **单轮成本无法下钻**：查询与契约都没有轮级成本字段（`api.ts:931`、`queries/issues.ts:1008`），面板读到的恒 null（`contract-extras.ts:104`、`issue-detail.tsx:362`）。
- **判定依据**：成本折算与聚合维度里的「仓库 / 时间」确有实现路径且真库断言具体（`apps/server/test/queries-costs-audit.test.ts:32` 手算对齐、`:81` 明细期外补齐、`:97` 仓库过滤）；但「按轮次」与「issue 维度 + 单轮下钻」是明写子条件且均缺失 → 部分实现。

### FR-6.4
- **状态**：部分实现
- **证据**：
  - **会话详情**：路由 `apps/server/src/http/api/index.ts:215`（`GET /api/issues/:owner/:name/:kind/:number`）→ `apps/server/src/queries/issues.ts:755`（四段 SQL：人类轮 / 头部 / 机器人轮 / 工具调用，见 `:752` 的说明）→ 契约 `packages/contract/src/api.ts:1092` → 面板 `apps/panel/src/routes/issue-detail.tsx:229`（逐轮渲染）与 `:318`（工具组展开，`:291` 的 `issue-detail-tools-toggle` 可点）。
  - **成本与用量**：路由 `apps/server/src/http/api/index.ts:137`（`GET /api/costs`）→ `apps/server/src/queries/costs.ts:96`；面板 `apps/panel/src/routes/costs.tsx:91`（时间窗）+`:103`（命令）+ `RepoFilterSelect`（仓库）、`:243`（最贵任务可点进任务详情）。
  - **事件时间线**：`apps/server/src/http/api/index.ts:157`（`GET /api/audit`）→ `apps/server/src/queries/audit.ts:56` 的 `auditSelect`，骨架在 `:72-74`：`from actions a join runs r on r.id = a.run_id join tasks t on t.id = r.task_id`，**没有任何 `webhook_deliveries` 关联**；面板时间线 `apps/panel/src/components/EventTimeline.tsx:93` 消费的正是 `AuditRow`，接线处 `apps/panel/src/routes/overview.tsx:622`。
  - **判定原因只写不读**：SQL 定义在 `apps/server/src/http/webhook-v21.ts:200`（`UPDATE "webhook_deliveries" SET "decision" = $2, "decision_reason" = $3 WHERE "delivery_id" = $1`），共享常量在 `apps/server/src/http/webhook.ts:111`（`markDecision: V21_DECISION_SQL.write`），调用点 `apps/server/src/http/webhook.ts:1014-1017`（`if (decision !== null)` 不触发也写）；但 `decision_reason` 在 `apps/server/src/queries/*.ts` 与 `packages/contract/src/*.ts` 里零读取。
  - **审计**：`apps/server/src/queries/audit.ts:85` 的列清单覆盖「谁触发」（`t.actor_login`，`:101`）、「跑哪个 sha」（`t.head_sha`，`:100`）、「改了什么」（`a.intent` / `a.target` / `status` / `approval`）；`apps/server/src/queries/audit.ts:124` 的 `actor.association` 恒为 `null`（`:6` 自陈缺口），面板对应单元格永不渲染（`apps/panel/src/routes/audit.tsx:467`）。
  - **「失败了在哪一步」无落点**：`apps/server/src/worker/run-task.ts:587` 的 `steps` 是纯内存数组，`:590` 只回调 `deps.onStep`；唯一接线 `apps/server/src/app/compose.ts:1428` 是 `logger.debug`，不写库；`TaskRunReport.steps`（`apps/server/src/worker/types.ts:459`）只回给调用方，契约里没有 steps 字段。
- **缺口**：
  1. **事件时间线缺「投递 → 判定」两段**：`/api/audit` 以 `actions` 为骨架，`webhook_deliveries.decision` / `decision_reason` 只写不读，「被忽略的事件也能看到原因」不成立（列存在 ≠ 有查询出口，正是本节最该防的错判）。
  2. **会话详情「可展开看入参」只到摘要**：`IssueToolCall.summary` 是单键单行摘要（`queries/issues.ts:75`、`api.ts:912`），展开后看不到完整入参。
  3. **成本视图缺「按 issue 聚合」与「单轮下钻」**：见 FR-6.3 缺口 2 / 3。
  4. **审计缺「失败了在哪一步」**：`steps` 只在内存（`run-task.ts:587`）与 debug 日志（`compose.ts:1428`），面板只能看 `failure_class` 与原始事件串（`apps/panel/src/routes/task-detail.tsx:196`）。
- **判定依据**：四个视图都有真实出口（路由 + 查询函数 + 契约字段）且各有面板页面；但每个视图都缺需求明写的关键列：时间线缺投递与判定、会话缺完整入参、成本缺 issue 维度与单轮下钻、审计缺失败所在步骤 → 部分实现。

## 本节整体结论

5.6 的「记录」侧基本成立且来源要求过关：事件流由执行侧按 `cursor` 顺序落 `run_events`，不依赖 agent 自述。但**后台读的那份不是库里存的那份** —— 会话视图的助手正文只解析信封，`item.completed` 的原文躺在 `run_events` 里没有读取方。工具调用六项里耗时与 argv/退出码完全没有落点，入参退化成单键摘要。成本按 run 记账而非按轮，且缺 issue 维度与单轮下钻。四个查询视图都有真实出口，但时间线漏掉「投递 / 判定」（`decision_reason` 写而无人读）、审计看不到失败在哪一步。

因此本节**不能**判为「已实现」。最吻合需求的最小补法：会话正文回落到 `run_events` 的 `item.completed`；给 `run_events` 增加命令类事件（argv + exitCode）并给 `IssueToolCall` 补完整入参与耗时；`usage_costs` 改按 `turn_id` 记账、`/api/costs` 补 `byIssue`、会话轮次补 `costUsd`；把 `webhook_deliveries.decision_reason` 接进时间线、把 `steps` 落库供审计。

## 核查边界

- 是否执行了命令：**未执行，纯静态核查**。只跑了 `git status --short`、`git log --oneline -3`（确认与 `_baseline.txt` 一致：HEAD `fbfa029`，工作区 27 个 M + `?? docs/audit/`），以及若干只读 `Select-String` / `Get-Content` 取行号。`pnpm -r typecheck`、`pnpm lint`、`pnpm -r test` 一律未跑。
- 未覆盖的条目及原因：
  - `run_events` 的 `(run_id, cursor)` 唯一约束在真库上的实际行为（`apps/server/src/db/schema.ts:310`）—— 需 PG，未跑。
  - `pi-host` 的 `pi.sqlite` `turns` 表是否真的按轮返回非零 token（`apps/server/src/cost/host-usage.ts:73`）—— 需宿主数据目录，未跑。
  - 真实 host 事件流里 `item.completed` 是否稳定携带整段助手文本（推断依据仅为测试夹具 `apps/server/test/worker-fallback.test.ts:31` 的注释「对着 `run_events` 里的真实事件核过」）—— 需真模型 / 真 host，未跑。
- 发现的额外问题（不属本节范围但值得记录）：
  1. **CSV 双 BOM**：`apps/server/src/queries/audit.ts:209` 的 `queryAuditCsv()` 已返回带 `\uFEFF` 的字符串，`apps/server/src/http/api/index.ts:187` 又 `reply.send(\`\uFEFF${csv}\`)` —— 导出文件开头两个 BOM；面板 `apps/panel/src/routes/audit.tsx:95` 的 `countCsvRows` 会把差值算进行数。
  2. **diff 采集了但没落库**：`apps/server/src/worker/run-task.ts:1131` 只 `logger.debug({ diffBytes })`，`driveTurn` 返回的 `turnResult.diff` 从未 `appendEvent`；而 `apps/server/src/queries/tasks.ts:431` 的 `diffOf()` 依赖 `run_events.payload.diff` → 任务详情 diff 区块恒 `available: false`（相邻的「回放」范畴，仅记录）。
  3. **`pendingFeedback` 无消费方**：`apps/server/src/queries/issues.ts:1037` 会算它、`apps/panel/src/components/issues/contract-extras.ts:80` 会读它，但 `issue-detail.tsx` 已不渲染（该文件头 `:35` 自陈移除），属一段白搬运。
