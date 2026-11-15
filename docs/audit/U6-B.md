# U6-B 需求核查：§5.6 记录与查询（FR-6.1 ~ FR-6.4）

核查对象：`docs/requirements.html` 行 1189–1221。
核查视角：反证。默认「未实现」，只有无争议代码证据才推翻。
核查仓：`C:\Code\NodeProjects\pi-issue-bot`（工作区有他人未提交改动，本次**只读**，未修改任何仓库文件）。
关键事实基线（全部经代码核对）：

- 落库表：`run_events`（含 `cursor` 单调列）、`envelopes`、`actions`、`usage_costs`、`webhook_deliveries`、`agent_messages`、`tasks`、`runs`。
- **全仓不存在** `tool_calls` / `transcript` / `turns` 这类独立对话表；`schema.ts` 共 24 张表（`schema.ts` 820–845），没有一张承载「助手输出 / 工具调用」的结构化行。
- 对话与工具调用的唯一实存载体是 `run_events.payload`（jsonb，无二级列）。

---

## FR-6.1 完整对话记录（P0）

**状态：部分实现（存储侧成立，查询/呈现侧不等价）**

### 反证尝试 1：对话记录是否来自「解析模型回答文本」而不是执行侧？

试图证伪「由执行侧生成」。结果：**存储侧确实是执行侧**，这一点被推翻（即需求满足）。

- 事件落库的唯一入口是 `run-task.ts:602-611` 的 `appendEvent(kind, payload)`，其 `kind` 直接取 RACP 事件流的 `event.kind`（`run-task.ts:964-977`：`appendEvent(event.kind, event.payload)`）。
- 事件流来自 `turn-driver` 订阅的 host 事件（`turn-driver.ts:242-245` 定义 `onEvent` 注入点，`turn-driver.ts:534`、`565-575` 逐条转出）。**这条链上没有「模型自述」参与**：模型只产出信封，事件由 host 侧发出。
- 助手原文确实在库里：`worker/envelope.ts:28-47` 明确注释「真 pi-host v0.22.0 的形状」是 `item.completed` 的 `{ event: { message: { role, content } } }`，即**助手输出整段文本落在 `run_events.payload.event.message.content`**。

### 反证尝试 2：是否有单调递增序列列，而不是靠时间戳？

试图证伪「顺序只是时间戳」。结果：**落库侧有序列**，需求这一条成立。

- `run_events.cursor` 是 `integer not null` + `uniqueIndex('run_events_run_id_cursor_uidx').on(t.runId, t.cursor)`（`db/schema.ts:296-313`）。
- 写入侧在进程内自增并串行化：`run-task.ts:600-611`（`cursor += 1`，`appendChain` 链式串行），不会并发抢号。

### 反证尝试 3：「全部按顺序落库」是否真的全？

试图证伪「全部都落了」。结果：**主动丢弃了一类事件**。

- `run-task.ts:972-977`：`item.delta`（正文流式增量）**明确不落库**，注释写「一次 turn 上百条，实机 125 条 / 27 秒」「落库只会把真正的事件挤出详情页（上限 500 条）」。所以库里没有逐字增量，只有 `item.completed` 的终态消息。按「完整对话记录」的语义，**终态可接受、流式过程不可见**；但这是有意的裁剪，不是零损失。

### 反证尝试 4：会话详情视图读的是不是这份执行侧记录？

试图证伪「面板看到的就是执行侧记录」。结果：**这一条被证实存在偏差**，是目前最实质的缺口。

- 会话详情的人类轮正文来自 `webhook_deliveries.payload.comment.body`，回退 `tasks.prompt_text`（`queries/issues.ts:644-645`、`766-792`）。
- 会话详情的**机器人轮正文来自 `envelopes.actions` 里 `intent='comment'` 的 `body`**（`queries/issues.ts:889-899` 取 `cm.body`；`queries/issues.ts:715-739` `toBotTurn` 写入 `text: longText(group.body)`）。
- 也就是说：面板展示的「助手输出」是**模型在信封里申报的那段评论正文**（agent 自述），而不是 `run_events.payload.event.message.content` 里执行侧捕获的原文。
- 后果可证伪地存在：信封不合法、写回被闸门丢弃、或模型这一轮只是在说话没产出信封时，会话详情里**这一轮的助手输出为空**（`groupBotRuns` 只在 `attempts` 里找 `body`，找不到就 `null`，`queries/issues.ts:696-706`），而执行侧原文仍在 `run_events` 里没有任何查询路径读它。

### 反证尝试 5：轮次顺序是否可信？

- 轮次排序是 `compareTurns`：先按 `at`，同时刻强制 human 在前，再按 `id` 字典序（`queries/issues.ts:741-747`）。同毫秒的两次 bot run 用 run uuid 决定先后，**不是真实先后**。这是可观察的弱点，但影响面小（同一 issue 同毫秒两次 run 极罕见）。
- 工具调用排序用 `row_number() over (partition by run_id order by at, call_id)`（`queries/issues.ts:978-984`），同样没用 `cursor`。

### 缺口

1. 助手输出的**展示路径**依赖信封自述，与「不能依赖 agent 自述」的判定口径正相反（存储侧合规，视图侧不合规）。
2. `item.delta` 不落库（有意裁剪，需在文档里承认「完整」= 终态级）。
3. 轮次/工具调用排序未使用已有的 `cursor`。
4. 没有独立的对话表；只有 `run_events.payload` 一棵 jsonb 树，无法按列索引对话内容。

---

## FR-6.2 工具调用记录（P0）

**状态：部分实现（仅「工具名 + 一行摘要 + 成功与否」，其余四项缺失或退化）**

需求拆成 6 项，逐项反证：

| 项 | 结论 | 证据 |
|---|---|---|
| 工具名 | 已实现 | 取 `item.started` 的 `payload.event.toolName`（`queries/issues.ts:941-942`）；取不到填 `unknown`（`queries/issues.ts:996`，契约 `packages/contract/src/api.ts:908-918`） |
| 入参 | **降级实现** | 只按 6 个固定键（`command/path/file_path/pattern/query/url`）取**第一个字符串**、且**只留首行 160 字**（`queries/issues.ts:72-82` `TOOL_ARG_KEYS` + `sqlToolArgs()`，`:997-998` `firstLine(..., SUMMARY_CHARS)`）。完整 `args` 只以原始 jsonb 存在于 `run_events.payload.event.args`，**没有任何查询把入参返回** |
| 返回摘要 | 已实现（退化） | 只取 `tool.progress` 第一条 `partialResult...text` 或 `details.output`（`queries/issues.ts:945-949`），同样只留首行（`:998`）。多段输出只有第一段 |
| 耗时 | **未实现** | 全仓工具调用无耗时字段。`issueToolCallSchema` 只有 `name/summary/at/ok`（`packages/contract/src/api.ts:908-918`）；`at` 是该 `toolCallId` **最早**一条事件时间（`queries/issues.ts:969` `min(created_at)`），没有结束时间，也没有 `durationMs` |
| 成功与否 | 降级实现（启发式） | `ok = row.failed !== true`（`queries/issues.ts:1001`），而 `failed` 靠「`item.completed` 里存在 `error` 字段或 `isError='true'`」猜（`queries/issues.ts:950-957`）。没有显式 status 字段，非错误型失败（例如输出里写了失败）会被记为成功 |
| argv | **未实现** | 全仓 `argv` 零命中（`apps/server/src/queries|http|cost|trigger|worker`、`packages/contract/src` 均无）。Bash 只有 `args.command` 整串，且只留首行 |
| 退出码 | **未实现（按调用维度）** | 全仓库只有两处 `exitCode`：容器终态 `State.ExitCode`（`sandbox/docker.ts:174`、`lifecycle.ts:221`、`run-task.ts:1556`）与命令级超时的 `record.exitCode`（`worker/failure.ts:151-161`）。**都不挂在某一次工具调用上**，`issueToolCallSchema` 里也没有该字段 |

### 反证的关键一击

试图证明「入参在面板可展开」：契约 `IssueToolCall` 无 `args` 字段（`packages/contract/src/api.ts:908-918`），面板拿不到；`/api/tasks/:id` 的 `payload` 是原样透出（`queries/tasks.ts:325-333` `recordOf(row.payload)`），所以**理论上**能从原始事件里看到 `event.args`，但那不是「每次工具调用可展开看入参」，而是让用户自己读原始事件 JSON，且受 500 条尾部截断（`queries/tasks.ts:61`、`472-486`）。

### 缺口

- 无 `durationMs`（FR-6.2 明列的「耗时」整项缺失）。
- 无 `argv`、无逐调用 `exitCode`（命令类工具的记录要求整项缺失）。
- 入参只留「一个键 / 首行 / 160 字」，不是入参。
- 成功与否是启发式推断，不是记录值。

---

## FR-6.3 token 与成本（P0）

**状态：部分实现**

### 反证尝试 1：token 是否只有总数、没有 prompt/completion 分开？

被推翻（即需求满足）：`usage_costs.input_tokens` / `output_tokens` 两列独立（`db/schema.ts:459-460`），且是 provider 口径的真数——「为什么不信信封里的 usage：那是 agent 自己填的，实测恒为 0」+「从 pi-host 的 turns 表读」（`run-task.ts:1589-1593`）。**这一点是加分的，执行侧真值而非自述。**

### 反证尝试 2：是否真的「按轮次」记录？

**被证伪**。这是本条最硬的缺口：

- 记账在任务收尾只执行**一次**，且只用**最后一个** `turnId`：`const usageTurnId = turnId ?? recordedIds.turnId;`（`run-task.ts:1594-1607`）。
- `turnId` 每轮被覆盖：`turnId = turnResult.turnId`（`run-task.ts:994`）。
- 而 worker 是**多轮只读工具循环**（`run-task.ts:851-880` `for(;;) toolRound += 1`，每轮重新 `driveTurn`）。
- 结论：**第 1..N-1 轮的 token 与成本全部丢失**，`usage_costs` 里只有最后一轮。`recordUsage` 注释也自认「一个 run 一行」（`worker/run-store.ts:83-95`），即记账粒度 = run，不是 turn。多 attempt 由新 run 承载（`run-task.ts:86-87` 注释），但**同一 run 内的多轮不拆**。
- 附带缺口：`input_tokens` 存的是「未命中 + 命中缓存」的合计（`run-task.ts:1603-1604`），缓存命中/未命中两段在库里不可分（库里没有 `cache_read_tokens` 列），只有 `cost_usd` 里隐含了差异。

### 反证尝试 3：成本是否只存数字、没有单价来源？

**证实**（需求意义上的缺口）：

- `usage_costs` 只有 `model / input_tokens / output_tokens / cost_usd`（`db/schema.ts:452-469`），**没有单价列、没有 `price_version`、没有 peak/tier**。
- 计价实现在 `cost/pricing.ts`（`DEEPSEEK_PRICES` 29-32、`PRICE_VERSION='deepseek-2026-11-10'` 40-41、`estimateDeepSeekCostUsd` 102-120），`priceVersion`/`tier`/`peak` 只进了 **日志**（`run-task.ts:1608-1620`），没进库。
- `queries/costs.ts:8-10` 自己写着：「`pricingCoverage` 的契约定义是命中价格表的 run 占比，**但价格表还没落库（没有单价列）**」，实际用「有 usage 记账的 run / 全部 run」近似，**恒 ≤ 1 且不是它声称的语义**。
- 后果：单价换版后历史金额无法复核，也无法回答「这条 run 按什么价算的」。

### 反证尝试 4：三个聚合维度（issue / 仓库 / 时间）是否都有查询函数？

- 仓库：有。`byRepo`（`queries/costs.ts:132-149`）。
- 时间：有。`series` 按 UTC 日，`full outer join metrics_daily`（`queries/costs.ts:204-233`）。
- **issue：没有**。`queries/costs.ts` 的桶是 `byRepo / byCommand / byModel`（132-187）+ `topTasks`（236-254）。`topTasks` 是**任务**粒度（`group by task_id, repo, command`），而一个 issue 通常对应多个 task；`queries/issues.ts` 全文**零** `cost` 命中（已 grep），`issueListItemSchema` / `issueTurnSchema` 也没有成本字段（`packages/contract/src/api.ts:970-1022`、`931-963`）。
- 结论：「issue 维度汇总」不存在，只有「最贵 N 个任务」。

### 缺口

1. 多轮工具循环下只记最后一轮 token/成本（按轮次记录未成立）。
2. 单价 / 价目版本 / peak 与 tier 不落库，成本不可追溯、`pricingCoverage` 语义是假的。
3. 缺 issue 维度聚合；`/api/costs` 与 `/api/issues` 之间没有成本字段。
4. 缓存命中 token 不可分（明细丢失）。
5. `envelopes.usage` 里还留着一份「agent 自填、实测恒 0」的 usage，并在任务详情原样返回（`queries/tasks.ts:335-341` `usageOf`），存在被误读为真实用量的风险。

---

## FR-6.4 后台查询四视图（P0）

### ① 会话详情（按轮次分组，工具调用可展开看入参）

**状态：部分实现**

- 存在性：`GET /api/issues/:owner/:name/:kind/:number`（`http/api/index.ts:213-231`）→ `queryIssueSession`（`queries/issues.ts:755-1040`）；面板路由 `/repos/:repo/issues/:kind/:number`（`apps/panel/src/routes.tsx:64-69`）。
- 按轮次分组：成立（human 轮来自 `tasks`，bot 轮来自 `runs` 且合并 attempt，`queries/issues.ts:664-713`、`1008-1015`）。
- 「可展开看入参」：**不成立**。契约 `IssueToolCall` 只有 `name/summary/at/ok`（`packages/contract/src/api.ts:908-918`），`summary` 是「一个键 + 首行 + 160 字」（见 FR-6.2）。面板无从展开。
- 单轮上限 50 条工具调用、超出置 `truncated`（`queries/issues.ts:987`、`packages/contract/src/api.ts:957-960`）；轮次上限 500（`queries/issues.ts:66-67`）。

### ② 成本与用量（三聚合维度，单轮可下钻）

**状态：部分实现**

- 存在性：`GET /api/costs`（`http/api/index.ts:136-145`）→ `queryCosts`；面板 `/costs`（`routes.tsx:56`）。
- 三聚合维度：**只有 2.5 个**——仓库 ✓、时间 ✓、issue ✗（见 FR-6.3）。
- 「**单轮**成本可下钻」：**不成立**。`IssueTurn` 无任何成本字段（`packages/contract/src/api.ts:931-963`）；`topTasks` 是任务级入口，可从任务详情看成本（`queries/tasks.ts:11`、`145`），但会话详情里看不到「这一轮花了多少」。

### ③ 事件时间线（投递 → 判定 → 执行 → 写回；被忽略的事件也能看到原因）

**状态：部分实现 —— 「投递 → 判定」与「被忽略的原因」在数据层存在，但无任何查询路径**

- 存在性：`GET /api/tasks/:id` 返回 `events`（`http/api/index.ts:119-135`；`queries/tasks.ts:472-486`），面板 `/repos/:repo/runs/:id`（`routes.tsx:72`）。
- 「执行 → 写回」：成立（`run_events` 里 `turn.* / item.* / tool.* / envelope.* / action.* / writeback.*`，映射见 `queries/sql.ts` 的 `sqlRunEventKind`）。
- 「投递 → 判定」：**时间线里没有**。时间线只查 `run_events`（`queries/tasks.ts:472-486`），且最旧只到该 task 的 run 起；投递与判定在 `webhook_deliveries`。
- 「被忽略的事件也能看到原因」：**数据写全了，查询一处都没有**。
  - 列存在且两侧都写：`decision` / `decision_reason` 两列（`db/schema.ts:106-124`）+ 迁移 `migrations/0011_v21.sql:18`；写入侧 `http/webhook.ts:103-108`、`http/webhook-v21.ts:182-195`（`triggered` 与 `ignored` 都写，含全部 `SkippedReason`）。
  - 但**全仓 `queries/` 与 `packages/contract/src` 对 `decision_reason` / `decision` 零命中**（已 grep：只有 schema 与 webhook 写入侧，`queries/` 只有 `issues.ts` 读 `payload.comment.body`）。没有任何 API 返回被忽略投递及其原因。
  - 时间线还有硬截断：只取最近 500 条 `run_events`（`queries/tasks.ts:61`、`474-483` `order by created_at desc ... limit`），长任务前段事件被丢弃。

### ④ 审计（谁触发、改了什么、失败了在哪一步）

**状态：部分实现**

- 存在性：`GET /api/audit` + `/api/audit/export.csv`（`http/api/index.ts:156-189`）→ `queries/audit.ts:165`；面板 `/audit`（`routes.tsx:58`）。
- 「谁触发」：**降级**。`actor.login` 有（`tasks.actor_login`，`queries/audit.ts:101`、`124`），但 `actor.association` **恒为 `null`**，代码自认缺口：入队时没落列，唯一来源是 `webhook_deliveries.payload`，而查询期解 payload 被 F9 禁止（`queries/audit.ts:5-8`）。
- 「改了什么」：成立（`intent` / `target` / `external_ref` / `status` / `revertKind`，`queries/audit.ts:85-102`、`113-136`）。
- 「失败了在哪一步」：**不成立**。`AUDIT_COLUMNS`（`queries/audit.ts:85-102`）没有 `failure_class`、没有 `failure_detail`、没有步骤列；`sqlActionStatus` 最多给到 `failed` 这一档（`queries/sql.ts` `sqlActionStatus`）。九步链路的 `onStep` **只打 debug 日志、不落库**（`app/compose.ts:1428-1430`）。因此审计视图能回答「哪个动作失败了」，不能回答「在哪一步失败」；要回答得跳到任务详情看 `failureClass` + 事件流。

### 缺口

1. ① 的工具调用不能展开看入参（契约缺字段）。
2. ② 缺 issue 维度、缺单轮/单会话成本下钻。
3. ③ 缺「投递 → 判定」段与「被忽略原因」的查询路径（表有列、无 API，属于「表里有列但无查询路径 = 未实现」）。
4. ③ 时间线 500 条尾部截断，长任务无法看到开头（含投递/判定这一段本来就不在）。
5. ④ `actor.association` 恒 null；无步骤/失败步骤列。

---

## 本节整体结论

**§5.6 四条 FR 无一完全达成，两条为「部分实现」偏弱，两条为「部分实现」。**

- 做得最实的是**「不依赖自述」的存储侧**：事件由 RACP 事件流驱动落 `run_events`（`run-task.ts:964-977` + `turn-driver.ts:565-575`），`cursor` 提供单调序（`db/schema.ts:296-313`），token 取自 pi-host 真值而非信封自述（`run-task.ts:1589-1593`）。这三点推翻了「一定是自述」的怀疑。
- 破得最明显的是**「按轮次」**：多轮工具循环只记最后一轮的 token/成本（`run-task.ts:1594` + `:994` + `:851-880`），`usage_costs` 粒度是 run 不是 turn（`run-store.ts:83-95`）。
- **FR-6.2 有四项硬缺失**：耗时、argv、逐调用退出码、完整入参——契约 `IssueToolCall` 只有 `name/summary/at/ok` 四个字段（`packages/contract/src/api.ts:908-918`），这是判定 FR-6.2「未达标」的决定性证据。
- **FR-6.4 的四个视图都存在且能打开**，但每个都缺一件需求明写的东西：①缺入参、②缺 issue 维度与单轮下钻、③缺投递/判定段与「被忽略原因」的查询路径、④缺「失败在哪一步」。
- 最有迷惑性的一处：`webhook_deliveries.decision_reason` 写得很完整（两侧都写、枚举齐全），但**没有任何代码读它**——数据齐、视图缺，正是需求「被忽略的事件也能看到原因」的落空点。
- 成本可用的前提「单价可追溯」不成立：库里没有单价/价目版本列（`db/schema.ts:452-469`），`pricingCoverage` 是近似值（`queries/costs.ts:8-10` 自认）。

综合判定：**FR-6.1 部分实现（存储合规、视图依赖自述）；FR-6.2 部分实现（6 项中 2 项达标、1 项退化、3 项缺失）；FR-6.3 部分实现（按轮次与单价可追溯不成立、issue 维度缺失）；FR-6.4 部分实现（四视图齐全，各缺一项明写能力）。**
