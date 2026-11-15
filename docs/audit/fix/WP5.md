# WP5 压缩接线（FR-5.6 / AC-24 / AC-25）

- 包：WP5「压缩接线」，解除 P0-1（会话永不轮换 → 上下文无限增长）的阻塞。
- 需求：`docs/requirements.html` FR-5.6（`:1061-1131`）、AC-24（`:1871`）、AC-25（`:1872`）。
- 结论一句话：**检查点真的接上了**（`turn/start` 之前），过硬边界**不发请求**，压缩记录落库且可查；
  两处子项因 RACP 缺能力未完成，见 §4 阻塞项，代码里留了 `TODO(FR-5.6)`。

## 1. 调用点（这是本包的核心）

| 位置 | 内容 |
|---|---|
| `apps/server/src/runtime/turn-driver.ts:428` | 新增「第 3.5 步」：`events/subscribe` 之后、**`turn/start` 之前**调 `runCompactionCheckpoint()`。需求明写「检查点固定在请求发出前：新消息之前、每个轮次边界、工具批次之后」。 |
| `apps/server/src/runtime/turn-driver.ts:535` | `runCompactionCheckpoint()`：把 `session/attach` 快照还原成历史 → 调端口 → `send:false` 抛 `COMPACTION_HARD_LIMIT`（**`turn/start` 一条不发**）。 |
| `apps/server/src/runtime/turn-driver.ts:265` | `TurnDriverParams.compaction?: TurnCompactionPort`（不注入 = 提示词逐字节不变）。 |
| `apps/server/src/compact/turn-compaction.ts:329` | `createTurnCompaction()`：端口实现（历史 → 引擎 → 「这一轮发什么」）。 |
| `apps/server/src/compact/turn-compaction.ts:239` / `:181` | `composeTurnText()`（checkpoint 前缀 / 提醒拼装）、`messagesFromSnapshotItems()`（快照条目 → 压缩输入，容错抽取）。 |
| `apps/server/src/compact/remind.ts:46` / `:125` | 两档临边提醒判定与「每档只响一次」台账。 |
| `apps/server/src/compact/window.ts:78` | `resolveModelWindow()`：窗口从模型名现算（不做配置项）。 |
| `apps/server/src/app/worker-deps.ts:1097` | `createV21TurnCompaction()`：按任务绑 `repo` / `issue_number` 的生产端口工厂。 |
| `apps/server/src/app/compose.ts:1374` | 装配点（`executeTask` 的 per-run `v21` 闭包）：`compaction: createV21TurnCompaction({...})`；台账 `compactionReminderLedger` 在应用作用域建一次（`:809` 附近）。 |
| `apps/server/src/worker/run-task.ts:850` | `const compaction = deps.v21?.compaction`，随后作为 `driveTurn({ compaction })` 传入。 |
| `apps/server/src/queries/compactions.ts:78` | `queryCompactions()`：`agent_compactions` 只读读模型（时间正序、limit 夹到 [1,200]）。 |

历史来源：`session/attach` 快照的 `items` + `hasMoreHistory`（`SessionAttachResult` 扩了这两个可选字段）。
**没有**拿 `run_events` 冒充历史：那是我们"看到的事件"（`item.delta` 都不落库），不是宿主喂给模型的消息。

## 2. FR-5.6 逐子项状态

| # | 子项（需求原文要点） | 状态 | 证据 / 说明 |
|---|---|---|---|
| 1 | 阈值从当前模型窗口**现算**，不做配置项 | 已实现（取数降级） | `compact/window.ts`：模型名 → 窗口表 + 保守下限 32_768（`matched=false` 可观测）。第 1/2 档来源（provider `/models`、宿主上报）不可用，见 §4 B1。 |
| 2 | 两条线：自动压缩线 = 安全预算 90%、硬边界 = 安全预算本身 | 已实现 | 引擎 `thresholds.ts` 原有；本包把它接上：`autoLimit` 触发压缩，`hardLimit` 触发**拒发**。 |
| 3 | 过硬边界**不发送请求** | **已实现并接线** | `driveTurn` 抛 `COMPACTION_HARD_LIMIT`（`failureClass:'model'`、`retriable:false`、`details` 带 `beforeTokens/hardLimit/layers`）；用例断言 `turn/start` 一次都没被调用。 |
| 4 | 检查点固定在「请求发出前」：新消息之前、每个轮次边界、工具批次之后 | 已实现（轮次边界） | `turn-driver.ts:428`。每轮 `driveTurn` 一次 → 天然覆盖"每个轮次边界"；"工具批次之后"没有宿主回调，靠轮次边界的下一次检查点覆盖（设计决定，非遗漏）。 |
| 5 | 两档临边提醒（还能用多少 / 现在就把必须留存的写下来），**每档只响一次** | 已实现 | `remind.ts`：0.75×hardLimit → `room`，0.85×hardLimit → `save-now`（都在 0.9 自动线以下，保证"提醒先到"）。台账为进程级有界 FIFO ⇒ 重启后可能再响一次（见 §4 B4）。 |
| 6 | 结构化摘要覆盖切点前**全部**消息 | 已实现（生产走兜底） | 引擎阶 2–4 原有；生产摘要模型不可用 → 稳定落阶 5 兜底 checkpoint（`fallback=true`），不伪造"模型摘要"。见 §4 B2/B3。 |
| 7 | 摘要保留目标/约束/进度/决策/下一步/关键上下文；**精确路径、函数名、报错原文原样保留** | 提示词侧已实现 | `summary.ts` 六段硬要求 + 逐条"原样照抄"指令（未改）。兜底路径由系统补：首条用户消息摘录 + 文件清单。 |
| 8 | 压缩区间内读写过的文件清单由系统追加 | 已实现 | `collectFileMentions()` + `withFileListNote()`（引擎原有）；用例断言 `src/compact/engine.ts`、`docs/requirements.html` 逐字出现在 checkpoint 里。 |
| 9 | **追加一条 checkpoint，不改写历史**；原始对话一条不少 | 已实现 | 只 `INSERT` 一行 `agent_compactions`；引擎不改消息数组（用例用 `JSON.stringify` 前后比对钉住）。 |
| 10 | 喂给模型的内容 = 从最新 checkpoint **重建** | **阻塞（降级）** | `turn/start` 只接受 `{messageId,text}`，没有替换会话上下文的手段。当前降级：checkpoint 作为**本轮提示词前缀**进入会话（于是它自己也成为宿主历史的一部分）。见 §4 B3。 |
| 11 | 重建时保留最近一段真实消息 | 引擎已算、投递阻塞 | 引擎返回 `view.messages`（含 assistant / toolResult，已剔孤儿）；无法投递 = 同 #10。 |
| 12 | 第二次压缩用**更新式**提示词（不重压全量） | 提示词已实现；生产路径不适用（有理由） | 每次喂的是快照**全量**历史，`window.old` 就是"切点前全部"——正是首次语义的正确输入；此时走增量会把同一段历史计两遍。分块链式摘要仍用更新语义（`carried`）。见 §4 B4（缺 `summary` 列，上一版摘要原文复不了）。 |
| 13 | 区间过长分块链式摘要，**不拼接** | 已实现 | 引擎阶 4（`planChunks` + 每块带上一块摘要）。 |
| 14 | 工具输出三层：执行时落文件 | **未实现（越界）** | 属 sandbox 抓取层（`sandbox/`），不在本包允许改动的面。见 §4 B5。 |
| 15 | 拼摘要时单条工具结果截断 **2000** 字符，带"已截断 N 字符" | 已实现 | 引擎阶 2（`TRUNCATE_LIMITS.first`，原有）。 |
| 16 | 仍超预算降到 **500** 字符并丢思考块，正文与工具入参不动、不删消息 | 已实现 | 引擎阶 3（`dropThinking:true`，原有）。 |
| 17 | 保留**真实最近窗口**（含助手输出与工具结果），按 token 预算裁剪 | 引擎已实现、投递阻塞 | `selectRecentWindow` 原有（用例：至少留最后一条、不从 tool 开头）。 |
| 18 | **剔除「工具调用已不在窗口内的孤儿结果」** | 已实现 | `stripOrphanToolResults` 原有；快照适配层保留 `toolCalls` 才能算孤儿（有用例）。 |
| 19 | 降级①预检（不发注定失败的请求） | 已实现 | 引擎阶 1（原有）。 |
| 20 | 降级②摘要短重试 3 次、退避 2/4/8；鉴权/配额首次即返回 | 已实现 | 引擎阶 2（原有）；装配层用 `isFatal: isSummarizeUnavailable` 让"没有摘要模型"立即落阶 5，不白等 14 秒（用例断言 `sleeps=[]`）。 |
| 21 | 降级③一次有界削减（500 字符 + 丢思考块） | 已实现 | 引擎阶 3（原有）。 |
| 22 | 降级④分块摘要 | 已实现 | 引擎阶 4（原有）。 |
| 23 | 降级⑤兜底 checkpoint（上版摘要 + 真实最近窗口 + **明确标记**） | 已实现（标记加强） | 引擎 `buildFallbackSummary` 原有；本包让**提示词侧**也自称兜底，并禁止兜底说"旧历史已不在上下文里"（历史其实一条没少，说那句会让模型白白重读）。 |
| 24 | 降级⑥仍超硬边界 → 拒绝发送 + **记录失败原因** | 已实现 | `COMPACTION_LIMIT_CODE` + warn 日志 + AppError `details`（可被 `runs`/面板读到）。 |
| 25 | **空摘要视为失败** | 已实现 | `parseSummary` 返回 `reason:'empty'` → 引擎走降级（原有用例）。 |
| 26 | 可观测：每次压缩记前后 token、摘要长度、是否兜底、第几代 | 已实现 | `agent_compactions` 五列 + `CompactionNote` + info 日志（含 `estimatedViewTokens`、`historyComplete`）。 |
| 27 | 后台会话详情能**标出压缩点** | 部分 | 只读出口 `queries/compactions.ts` 已加；HTTP 路由与面板未加（见 §4 B6）；精确切点需新列（§4 B4）。 |
| AC-24 | 压缩两次后仍能复述目标与硬约束 | 部分 | 兜底路径靠"首条用户消息摘录 + 文件清单 + 明确缺口标记"；**没有**真模型摘要 → 不能声称靠摘要复述全部约束。真摘要打通后此条才成立。 |
| AC-25 | 后台可见压缩记录（前后 token/是否兜底/第几代）且**原始对话一条不少** | 是 | 记录：用例断言 `{repo,issueNumber,sessionId,generation:1,fallback:true,beforeTokens>afterTokens,summaryChars>0}`；原文：`JSON.stringify(history)` 前后完全相等。 |

## 3. 改动文件

新增：

- `apps/server/src/compact/window.ts`（窗口现算）
- `apps/server/src/compact/remind.ts`（两档提醒 + 台账）
- `apps/server/src/compact/turn-compaction.ts`（端口契约 + 快照适配 + 提示词拼装 + 生产端口）
- `apps/server/src/queries/compactions.ts`（只读读模型）
- `apps/server/test/compact-turn-port.test.ts`（17 例）
- `apps/server/test/compact-turn-driver.test.ts`（7 例）
- `apps/server/test/compact-query.test.ts`（4 例）

修改：

- `apps/server/src/runtime/turn-driver.ts`（+ 第 3.5 步、端口字段、`SessionAttachResult` 扩 `items`/`hasMoreHistory`）
- `apps/server/src/worker/run-task.ts`（**越界说明**：`compactor?: unknown` → `compaction?: TurnCompactionPort`，并在 `driveTurn({...})` 加一行传入。不传就永远接不上，见 §5）
- `apps/server/src/app/worker-deps.ts`（+ `createV21TurnCompaction()`、`isSummarizeUnavailable()`）
- `apps/server/src/app/compose.ts`（**只动装配压缩相关的行**：import、`compactionReminderLedger`、per-run `compaction:` 装配；删掉 `v21RunnerHooks.compactor`（原来就是"只暴露不调用"的死字段）。未动 `panelDistDir` 与他人改动）

未改：`db/schema.ts`、`packages/contract/`、`agent/`、`writeback/`、`queries/deliveries.ts`、`apps/panel/`。
（本包没有新增错误码到契约：`COMPACTION_HARD_LIMIT` 是 `AppError.code`，不进面板 `ErrorCode` 枚举，目前也没有面板路由暴露它。）

## 4. 阻塞项（因**外部依赖**未完成，不假装完成）

| 编号 | 阻塞项 | 当前降级行为 | 打通后改哪一处 |
|---|---|---|---|
| B1 | **窗口来源**：provider `/models` 未接（架构上 bot 不做 provider 客户端）；RACP 的 `Session` / `InitializeResult` 不报窗口 | 模型名 → 窗口表；表外模型退保守下限 32_768（代价：1M 窗口的未知模型会更早压缩） | `compact/window.ts::resolveModelWindow()` 换成从能力上报取，本表退化为兜底（文件头 `TODO(FR-5.6)` 已写） |
| B2 | **摘要模型**：RACP 无"替我摘要"操作；bot 自己不说模型协议（`app/model-env.ts` 的分工）；本包不允许新增 provider 客户端 | `createUnavailableSummarize()` → 引擎稳定落**阶 5 兜底 checkpoint**（`fallback=true`，提示词自称兜底） | 只换 `compact/turn-compaction.ts::createUnavailableSummarize()` 的实现；端口、引擎、装配都不用动 |
| B3 | **视图投递**：`turn/start` 只接受 `{messageId,text}`，RACP 没有"替换/写入会话上下文"的 operation | checkpoint 作为**本轮提示词前缀**进入会话；宿主历史一条没删（所以"从 checkpoint 重建视图"不成立，只是"把 checkpoint 递进去"） | `runtime/turn-driver.ts:428` + `compact/turn-compaction.ts` 新增 `view` 投递分支（文件头 `TODO(FR-5.6)` 已写） |
| B4 | **schema**：`agent_compactions` 没有 `summary text`（上一版摘要原文）、`checkpoint_seq`（切点）、`reminders`（提醒台账持久化） | 增量摘要退化为首次语义（本设计下仍正确，见 #12）；压缩点只能按 `created_at` 标；提醒台账放内存（重启后可能重复一次） | schema 工作包加三列 + 一次迁移；`compact/store.ts` 与 `queries/compactions.ts` 各加一个字段 |
| B5 | **工具输出"执行时落文件"**：属 `sandbox/` 抓取层 | 没有上限截断落盘；后续两层（2000 / 500）已实现 | `sandbox/` 抓取层（本包范围外） |
| B6 | **HTTP 路由**：`http/api/index.ts` 与 `queries/index.ts` 正被 WP1 改动，本包只加自己的文件 | 读模型 `queryCompactions()` 已可用，但还没有 `/api/...` 路由挂上 | WP1/WP11 收口时在 `http/api/index.ts` 挂一条只读路由 + `packages/contract` 里加 `compactionRowSchema`（本次刻意不碰，避免与 WP1 撞车） |

## 5. 越界说明（改了不允许清单之外的两个文件）

1. `apps/server/src/worker/run-task.ts` —— 只改两处：`V21RuntimeConfig.compactor?: unknown` → `compaction?: TurnCompactionPort`（+ 注释），以及 `driveTurn({...})` 里加一行 `...(compaction === undefined ? {} : { compaction })`。
   理由：`driveTurn` 的端口只能由它的调用方传；`recordingOps()` 是逐方法显式委托（`{...ops}` 会丢原型方法，见那里的注释），所以**没法**把端口挂在 `ops` 上。不改这一行 = 压缩永远接不上，等于本包没做。
2. `apps/server/src/app/compose.ts` —— 只动"装配压缩"的行（见 §3），并删掉一处已死的"只暴露不调用"字段与它们的注释。`panelDistDir` 注入与他人改动一行未碰。

## 6. 命令与结果

在 `C:\Code\NodeProjects\pi-issue-bot` 下：

| 命令 | 结果 |
|---|---|
| `cd apps/server; npx tsc --noEmit` | **通过**（无输出、退出码 0） |
| `pnpm -r typecheck` | **6 个包全部 Done** |
| `npx vitest run test/compact-*.test.ts`（等价：逐个列出 8 个 compact 文件） | **8 files / 107 passed**（含新增 28 例） |
| `npx vitest run`（全量） | **129 test files · 127 passed / 2 failed** —— 两条失败与压缩无关且**单跑均通过**，见下 |
| `npx eslint`（本包新增/改动的源文件与用例，逐个列出） | **0 problems** |
| `pnpm lint`（全仓） | **1 error / 6 warnings** —— 见下，非本包 |

全量里两条失败（**均为并行会话的进行中改动，与压缩无关**）：

- `test/app-wiring.test.ts > ④ settings.limits.concurrency_per_repo 真的生效` —— 单跑该文件 **通过**；失败只在全量并发跑真 PG 时出现（WP7 正在改限额相关的装配）。
- `test/v21-integration.test.ts > ② 模板渲染进 agent_messages.comment_body` —— 单跑 **13 passed**；同上，属 WP4 的模板渲染面。

`pnpm lint` 的 1 个 error：`apps/server/src/app/compose.ts:92 'timeoutMsForCommand' is defined but never used`。
**不是本包造成的**：`git diff` 显示 WP7 把 `timeoutForCommand: (command) => timeoutMsForCommand(command)` 换成了 `turnTimeoutMsFor(command, resolveTurnTimeoutMinutes(policy.settings))`，import 成了孤儿。本包没有删它（避免与 WP7 的进行中改动同文件抢占），交给 WP7 或收口批清理。
6 个 warning 全在 `scripts/spike/lib/*.mjs`，改动前既有。

**没跑的命令**：`pnpm gen:openapi`（未改契约 / schema）；Docker / 真 git 的执行面用例（本包不触及执行面；全量里 `skipIf` 的 2 条跳过项属既有环境条件）。

## 7. 残余风险

1. **兜底兜得住、但不等于压缩到位**：摘要模型不可用期间，每次越线写下的都是规则化兜底 checkpoint（`fallback=true`）。它保证"不静默丢历史 + 后台可查 + 模型被明确告知要收尾"，但**不能**替模型保住全部约束。B2 打通前，长任务的实际体验是"提示词里多一段兜底说明"，不是"上下文真的变小了"。
2. **估算口径是下界（可能低估）**：`hasMoreHistory=true` 时只读得到快照第一页，`beforeTokens` 是下界，因此可能在真正过线后才触发（甚至撞 provider 400）。已用 `historyComplete=false` 让它可观测；精确口径需要 B3 的分页读。
3. **`send:false` 会让任务失败**：这是需求要的行为（"宁可失败也不发一个注定被拒的包"），但意味着**没有任何自动恢复**——同一份历史重投一次还是同一个 token 数。真实运维需要人工介入（或等 B2/B3 打通后靠真压缩腾出空间）。
4. **提醒台账在内存**：重启后同一档可能再响一次（建议性文案，代价可忽略）；要"绝不重复"需要 B4 的持久化列。
5. **端口失败一律 fail-open**：压缩器自身抛错时按原文发送（不判死任务），代价是那时会一路撞到 provider 上限——但有 warn 日志可发现，且不会静默丢历史。
6. **未跑真机**：本机没有 pi-host bundle，`session/attach` 快照的真实条目形状（`ItemSummary.content`）只能靠 `packages/racp-client/src/schema.ts` 的类型与容错抽取覆盖。适配层写的是"能抠就抠、抠不出就跳过"，不会炸，但真机上抽出来的文本可能比预期少（少 = token 估算偏低，属第 2 条风险）。
