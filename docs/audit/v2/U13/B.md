# U13 5.6 记录与查询 · B

> 核查范围：docs/requirements.html 行 1189-1221
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| FR-6.1 | 部分实现 | 助手输出**原文不落库**：`item.delta` 被显式丢弃，正文只能取到模型自己写在信封里的评论动作 |
| FR-6.2 | 部分实现 | 六项只有「工具名 / 成功与否」齐备；**耗时、argv、退出码全无**，入参只存 160 字单行摘要 |
| FR-6.3 | 部分实现 | 用量按 **run** 一行且取**最后一轮** turn；无轮次粒度 → 「按轮次」不成立；无 issue 维度聚合；单价不落库 |
| FR-6.4 | 部分实现 | 工具调用不能展开看入参；单轮成本无下钻；时间线只有写回段，**被忽略事件原因有列无出口**；审计无「哪一步」 |

## 逐条

### FR-6.1
- **状态**：部分实现
- **证据**：
  - `apps/server/src/db/schema.ts:296-313` — `run_events(run_id, cursor, kind, payload)`，`unique(run_id,cursor)`；只能承载「事件」，没有消息/轮次表。
  - `apps/server/src/runtime/turn-driver.ts:243-245`、`565-576` — 事件源是 RACP 事件流，每条事件过 `onEvent`；**落库由执行侧驱动**（这一点成立）。
  - `apps/server/src/worker/run-task.ts:602-611` — `appendEvent` 分配单调 `cursor` 后串行写 `run_events`（顺序有保证）。
  - `apps/server/src/worker/run-task.ts:972-977` — `if (event.kind !== 'item.delta')` → **正文流式增量一律不落库**（注释自陈：一次 turn 125 条）。
  - `apps/server/src/queries/issues.ts:889-899` — 机器人轮的 `text` 取自 `envelopes.actions` 里 `intent='comment'` 的 `body`，即**模型自己产出的信封字段**，不是事件流里的助手消息。
  - `apps/server/src/agent/store.ts:95-98`、`147-149` — 用户输入侧：`agent_messages.comment_body` / `tasks.prompt_text` 落的是消息体（人话/模板），执行侧写入 ✓。
  - `apps/server/src/worker/run-task.ts:1091`、`apps/server/src/runtime/turn-driver.ts:398-401` — 多轮工具循环里**每轮重新拼的 `turn/start` 文本**（`turnPrompt`）只发给 Host，不落任何表。
- **缺口**：三个子条件未满足：①助手输出原文（`item.delta` / 最终消息文本）不落库，能查到的「输出」是信封里的评论动作正文；②工具循环第 2..N 轮的用户侧输入（注入的工具结果提示词）不落库；③因此「每一轮的助手输出按顺序落库」只能靠 agent 自述的信封字段，而需求明文禁止这一点。
- **判定依据**：落库链路确实是执行侧事件流（不是从模型回答文本里解析），所以不是全无实现；但需求点名的「不能依赖 agent 自述」在助手输出这一侧恰恰被违反——唯一可查的输出正文来自模型自填字段。
- **反证过程**：假设「已实现」，则必能在库里找到与模型回答无关的助手输出序列。逐点证伪：(a) `run_events` 里 `item.delta` 不存在——代码显式过滤（`run-task.ts:975`），证据链断在第一处；(b) `item.completed` 虽落库，但 `queries/issues.ts:930-964` 只在 `payload->>'itemType'='tool'` 时读它，**没有任何查询读消息类 item 的正文**（有字段无消费方）；(c) 会话详情展示的 bot 正文溯源到 `envelopes.actions`（`issues.ts:889-899`），那是模型输出经 JSON 校验后的投影，属于「自述」；(d) 再查「用户输入」侧：首轮有 `tasks.prompt_text`，可第 2 轮起的 `turnPrompt`（`run-task.ts:1091`）在任何表里都查不到——用「多轮工具循环」这一必然场景就能把「全部按序落库」打掉。

### FR-6.2
- **状态**：部分实现
- **证据**：
  - `packages/contract/src/api.ts:908-918` — `issueToolCallSchema` 只有 `name / summary / at / ok` 四个字段（`.strict()`）。
  - `apps/server/src/queries/issues.ts:72-81` — `TOOL_ARG_KEYS = ['command','path','file_path','pattern','query','url']`，只按优先级取**一个字符串值**当摘要源。
  - `apps/server/src/queries/issues.ts:993-1005` — `summary: firstLine(args_raw, 160)`：入参被裁成 160 字单行；`name` 取不到时填 `unknown`。
  - `apps/server/src/worker/run-task.ts:1073-1079` — 平台代执行的只读工具只在 `run_events` 写 `{name, ok, items, summary, errorCode}`：**没有入参、没有耗时**。
  - `apps/server/src/db/schema.ts:296-313` — `run_events` 无 `duration`、无 `exit_code`、无 `argv` 列；全仓 `grep exitCode` 只命中 docker 容器状态与 CLI/doctor（`worker/run-task.ts:1556`、`jobs/lifecycle-sweep.ts:430`），与工具调用无关。
- **缺口**：逐项点名——①**入参**：只存 160 字单行摘要，多行 `Bash` 脚本只留第一行（`issues.ts:997` 注释自陈），完整值仅以原始 `run_events.payload` 形式躺在 jsonb 里且无契约字段；②**返回摘要**：同样是首行 160 字，不是摘要字段，规则是「没有 args 才退回输出首行」（`issues.ts:998`）；③**耗时**：无字段、无计算（只有 `at`= 该 toolCallId 最早事件时刻）；④**argv**：无；⑤**退出码**：无。可用的只有工具名与 `ok`（`item.completed` 里 `error`/`isError` 推断，`issues.ts:950-957`）。
- **判定依据**：需求五项 + 命令类两项共七个数据点，只有「工具名」「成功与否」是完整可查字段，其余或缺失或被截断成摘要，故为部分实现而非已实现。
- **反证过程**：假设六项都存在。(a) 耗时：搜 `durationMs` 在契约里只出现在 `p95Ms/p50Ms/oldestQueuedMs/timeoutMs` 等无关字段（`api.ts:87,88,101,198,603`），`issueToolCallSchema` 内没有 → 缺失；(b) argv：`argv` 全仓只在 `git/run-git.ts:25`、`git/push.ts:202` 与 `cli.ts:129` 出现，工具调用记录链路上零命中 → 缺失；(c) 退出码：`exitCode` 在仓内只有 docker 容器状态（`worker/run-task.ts:1556`、`jobs/lifecycle-sweep.ts:430`）、CLI/doctor（`cli.ts:396-400`、`doctor/index.ts:245`）与 `git/run-git.ts:184-187` 三处来源，**没有任何代码把它写进工具调用记录**——这正是「有值 ≠ 有记录」；(d) 入参：契约 `.strict()` 四字段把口子堵死，面板即使想展开也没有字段可展开（`issue-detail.tsx:384-395` 单行渲染，`title` 只挂 `summary`）；(e) 返回摘要：`firstLine(output_raw,160)` 是按需截取，不是落库摘要，长输出不可复现。

### FR-6.3
- **状态**：部分实现
- **证据**：
  - `apps/server/src/db/schema.ts:452-468` — `usage_costs(run_id, model, input_tokens, output_tokens, cost_usd, created_at)`：键是 **run**，没有 `turn_id`、没有 `issue`、没有单价/价版本列。
  - `apps/server/src/worker/run-store.ts:83-95` — 「一个 run 一行」；注释明写「调用方只在 turn 结束后写一次」。
  - `apps/server/src/worker/run-task.ts:1594-1607` — `usageTurnId = turnId ?? recordedIds.turnId`：只读**最后一个 turn** 的用量；工具循环的中间轮 token 不进账。
  - `apps/server/src/worker/run-task.ts:1604` — 落库的 `inputTokens = usage.inputTokens + usage.cacheReadTokens`：prompt 侧的「缓存命中/未命中」被合并，只留一个总量。
  - `apps/server/src/queries/costs.ts:132-187` — 三个维度是 `repo / command / model`；`235-254` 的 `topTasks` 按 `task_id`，**没有 issue 维度**。
  - `apps/server/src/queries/costs.ts:204-233` — 时间维度：按 UTC 日聚合 ✓。
  - `apps/server/src/cost/pricing.ts:29-41` — 价目写死为代码常量，`PRICE_VERSION = 'deepseek-2026-11-10'` 只是常量；`usage_costs` 无 `price_version` 列（`schema.ts:452-468`）。
  - `apps/server/src/queries/costs.ts:8-10` — 自陈「价格表还没落库（没有单价列）」，`pricingCoverage` 是近似值。
- **缺口**：①「按轮次」不成立：无 turn 粒度行，多轮工具循环只记最后一轮（`run-task.ts:1594`）；②prompt token 未按缓存命中/未命中分列（合并进 `input_tokens`）；③聚合维度缺 **issue**（只有 repo/command/model + task 级 topN）；④单价不可追溯：金额落地时依赖的单价只存在于代码常量，行里没有版本戳，改价后无法复核历史金额（`logger.info` 里的 `priceVersion` 也没有入库，`run-task.ts:1608-1619`）。
- **判定依据**：token 与成本确实记了、也确实折算并落库，时间和仓库维度可聚合，故非「未实现」；但需求明写的「按轮次」与「issue 维度」两项缺失，单价版本不可回溯，故为部分实现。
- **反证过程**：假设「按轮次记录」成立，则库中应存在「一次 turn 一行」。逐点证伪：(a) `usage_costs` 主键/索引只有 `run_id`（`schema.ts:465-468`），全仓唯一插入点在 `run-store.ts:91`，参数里没有 turnId；(b) 若多轮循环存在，则 `turnId` 变量必被覆盖——`run-task.ts:921-922` 每轮用 `runId:attempt:rN` 的 messageId 起新一轮，`1594` 只取最后一次赋值，因此前几轮 token 结构性丢失；(c) 查 `agent_compactions` 是否补了轮次维度：只有 `before/after tokens`（`schema.ts:793-812`），非计费数据；(d) 查 `envelopes.usage`（`schema.ts:326-327`）是否兜底：`cost/host-usage.ts:4-8` 明写信封 usage 实测恒为 0，且 `queries/tasks.ts:335-342` 仍把它当展示值读出——用它兜底等于用模型自述的 0 计价。

### FR-6.4
- **状态**：部分实现
- **证据**：
  - **会话详情**：`apps/server/src/queries/issues.ts:755`（`queryIssueSession`）+ `apps/server/src/http/api/index.ts:216`（路由）+ `packages/contract/src/api.ts:931-963`（`issueTurnSchema`，含 `toolCalls`）三者齐备；轮次分组在 `queries/issues.ts:1008-1015`。
  - **工具调用可展开看入参**：`packages/contract/src/api.ts:908-918` 四字段；`apps/panel/src/routes/issue-detail.tsx:384-395` `ToolRow` 是单行 `<li>`，无展开状态、无入参字段。
  - **成本与用量**：`apps/server/src/http/api/index.ts:138` + `apps/server/src/queries/costs.ts:96`；契约维度 `repo/command/model`+`series`+`topTasks`。
  - **单轮下钻**：`apps/panel/src/components/issues/contract-extras.ts:103` 自陈「契约**还没**提供 `durationMs`/`costUsd` 这两个字段时返回 null」；`issueTurnSchema` 里确实没有这两个字段（`api.ts:931-963`），故详情页 `readRunCost`（`issue-detail.tsx:280`）恒为 null。
  - **事件时间线**：`apps/panel/src/components/EventTimeline.tsx:25-28` props 是 `AuditRow[]`，数据源是 `actions`（写回段），不含投递与判定。
  - **被忽略事件原因**：列与写入都存在——`apps/server/src/db/schema.ts:106-124`（`decision` / `decision_reason`）、`apps/server/src/http/webhook-v21.ts:200`、`apps/server/src/http/webhook.ts:1016`（「不触发也写」）；但 `apps/server/src/queries/` 对 `decision` / `decision_reason` **零引用**（grep 命中仅 `issues.ts:152/259/278/780/827` 读 `payload`，`overview.ts:77` 只 `count(*)`）。
  - **审计**：`apps/server/src/queries/audit.ts:85-136` 给出 `actor.login`、`intent/target/status`、`approval`、`revertKind`；**没有步骤字段**；`apps/server/src/worker/run-task.ts:587-590` 的 `steps` 只进内存报告，`apps/server/src/app/compose.ts:1428-1430` 的唯一消费方是 `logger.debug`。
- **缺口**：①会话详情：工具调用不可展开、入参不可见（契约四字段）；②成本用量：**单轮下钻不可能**（无轮次行、契约无单轮成本/耗时）；③事件时间线：只有「写回」段，**没有「投递 → 判定」两段**，被忽略事件的原因**有列无出口**（无查询、无路由、无契约字段）；④审计：只能看到 `status=failed/rejected` + `failure_class`，看不到「失败在哪一步」。
- **判定依据**：四个视图各自都有「查询出口 + 路由 + 契约字段」的骨架（故非未实现），但每个视图都缺需求表格里点名的那一个差异化能力，故为部分实现。
- **反证过程**：假设四视图齐备，逐个去找「三者齐备」。①会话详情里的「展开看入参」：契约 `.strict()` 锁死四字段（`api.ts:908-917`），面板单行渲染（`issue-detail.tsx:384-395`）——「不可展开」是硬事实，不是样式细节；②单轮成本：先查表（无 turn 列，`schema.ts:452-468`），再查契约（`IssueTurn` 无 cost），再查面板（自认拿不到），三处一致地空；③被忽略原因：这是「有列 ≠ 有出口」的典型——写入侧 `webhook.ts:1016` 与迁移 `migrations/0011_v21.sql:18` 都在，`trigger/decide.ts:30` 定义了原因枚举，但**唯一读这些列的路径不存在**（`queries/` 零命中），所以需求「后台能看到被忽略的原因」判为未实现；④审计的「失败在哪一步」：`steps` 数组确实存在（`run-task.ts:587`），但落点是日志——用 `grep onStep` 确认生产装配只 `logger.debug`（`compose.ts:1428-1430`），没有入库路径。

## 本节整体结论
不能判为已实现。落库骨架（`run_events` 事件流 + `usage_costs` 记账 + 四个查询出口）是真实存在的，且事件流确实由执行侧驱动，这一点比「全靠 agent 自述」好得多。但需求在本节挑出的四个差异化能力——助手输出不依赖自述、工具调用六项含耗时/argv/退出码、按轮次计费、四视图里「入参可展开 / 单轮下钻 / 被忽略原因 / 失败在哪一步」——逐条都能反证为空或缺字段。四条全部判为部分实现，其中 FR-6.2 的缺失项最多（耗时、argv、退出码三项零实现）。

## 核查边界
- 是否执行了命令：`git status --short` + `git log --oneline -3`（与 `_baseline.txt` 一致，HEAD `fbfa029`，工作区同为 29 个 M + `docs/audit/` 未跟踪）；`grep`/`Select-String` 若干次静态检索。**未运行任何测试、未连真库**，`run_events` 里的真实事件形状（`itemType`/`toolCallId`）按代码注释与查询条件推断，未取样核对。
- 未覆盖的条目及原因：无（本节 4 条全覆盖）。不含「面板视觉是否像 pi-desktop 对话界面」（属 5.6 示例段，不在 FR-6.1~6.4 表格内）。
- 发现的额外问题（不属本节范围但值得记录）：
  1. **schema 漂移**：`migrations/0009_task_agent_skill_ids.sql:14` 与 `apps/server/src/agent/store.ts:95-98` 都在读写 `agent_messages.skill_ids`，但 `apps/server/src/db/schema.ts:706-731` 的 `agentMessages` 没有该列——drizzle 模型与真库不一致，`db-schema.test.ts` 的列断言不会发现。
  2. `queries/tasks.ts:335-342` 的 `EnvelopeRecord.usage` 直接展示模型自填的 usage（实测恒 0），与 `cost/host-usage.ts:4-8` 的口径冲突，面板上会出现「免费」假象。
  3. `apps/server/src/queries/issues.ts:1004` 用 `if (intOf(row.total) > TOOL_CALL_LIMIT)` 逐个 run 置 `truncated`，而截断发生在 SQL 的 `rn <= 50`（`issues.ts:987`）—— 语义正确但阈值重复定义两处（`issues.ts:60` 与契约 `api.ts:958`），改一处会漂移。
