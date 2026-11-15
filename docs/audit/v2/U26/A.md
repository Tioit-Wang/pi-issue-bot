# U26 10 验收标准 AC-1 ~ AC-17 · A

> 核查范围：docs/requirements.html 行 1849-1865
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| AC-1 | 已实现 | — |
| AC-2 | 已实现 | 两轮对话可查、会话复用已在代码里；「不再重复询问」属真模型行为，本节只证明平台侧上下文连续 |
| AC-3 | 部分实现 | `decision/decision_reason` 只有写入路径，全仓无读取方（无查询 / 无 API / 无面板），后台看不到「未触发及原因」 |
| AC-4 | 已实现 | — |
| AC-5 | 已实现 | — |
| AC-6 | 已实现 | — |
| AC-7 | 已实现 | — |
| AC-8 | 已实现 | — |
| AC-9 | 部分实现 | 缺「结果」：契约 `IssueToolCall` 只有 name/summary/at/ok，工具输出仅在无入参时占位到 summary |
| AC-10 | 部分实现 | 缺该轮 prompt/completion token：`usage_costs` 的 token 只进 `/api/costs` 分桶与 Top N，轮次/任务详情无 token 字段，面板读的 `envelope.usage` 是 agent 自填的 0 |
| AC-11 | 已实现 | — |
| AC-12 | 已实现 | — |
| AC-13 | 部分实现 | 「需补充信息」标签的移除没有专门实现，只在模型下一轮输出 `label` 目标态时被差集顺带删掉 |
| AC-14 | 已实现 | — |
| AC-15 | 与需求冲突 | `planLabelTargetState` 用 `add = desired − current`，人工删掉的标签下一轮必被加回；且既有 veto 只认「我们自己撤标」，人工在 GitHub 上删标签不写 `bot_labels.removed_at` |
| AC-16 | 已实现 | — |
| AC-17 | 已实现 | — |

## 逐条

### AC-1
- **状态**：已实现
- **证据**：`apps/server/src/agent/store.ts:156` — `saveSession` 是 `(repo, issue_number)` 上的 UPSERT，写入 `session_id/cursor/turns/started_at`，一个 issue 恒一行（`ON CONFLICT ... DO UPDATE`）；`apps/server/src/app/compose.ts:443` — `planAgentSession()` 在 `sessionId` 非空时返回 `{mode:'persistent', sessionId, after: cursor}`，只有首轮（`sessionId === null`）才 `{mode:'persistent'}` 新建；`apps/server/src/runtime/turn-driver.ts:359` — `persistent` 且有 `sessionId` 时先 `session/attach` 接管原会话，4xx/缺 operation 才新建并 `sessionReset=true`；`apps/server/src/app/compose.ts:1039` — run 结束后把本轮 `report.sessionId` 回写进 `agent_sessions.session_id`（复用轮沿用旧值）；`packages/racp-client/src/ops.ts:313` — `sessionAttach()` 已实现 `session/attach`。
- **判定依据**：`issues.opened` 与 `issues.edited` 都是 `tasks.source='agent'`，两次 run 走同一个 `planAgentSession()` → 第二次带第一次落库的 `sessionId` → `session/attach` 复用同一个 RACP 会话；`agent_sessions` 上没有删除/归档分支（`apps/server/src/agent/session-state.ts:69` 的 `SESSION_ACTIONS` 只有 create/reuse/recycle-sandbox），所以会话 id 不会因为非轮换原因变化。

### AC-2
- **状态**：已实现
- **证据**：`apps/server/src/queries/issues.ts:766` — 人类轮以 `tasks` 为骨架，正文取 `webhook_deliveries.payload.comment.body`（退回 `prompt_text`）；`apps/server/src/queries/issues.ts:872` — 机器人轮以 `runs`+`envelopes`+`actions` 为骨架（dry-run 也有 `envelopes`）；`apps/server/src/queries/issues.ts:1008` — `turns` = 人类轮 + 机器人轮按 `at` 升序合并（同刻人类在前），上限 500；`apps/server/src/runtime/turn-driver.ts:426` — `persistent` 轮**不** `session/archive`，会话历史留给下一轮 attach。
- **判定依据**：两轮各有一条 `tasks` + 一条 `runs`，都会被 `queryIssueSession()` 渲染成交替的 human/bot 轮次；上下文连续由「同一 RACP 会话 + 不归档 + `after` 游标防重放」保证，第二轮 prompt 只追加「## 这一条消息」（`apps/server/src/app/compose.ts:1239`），不会重建会话。**「第二轮不再重复询问第一轮已确认的信息」是模型看到会话历史后的行为，代码只能证明平台提供了历史**，见「核查边界」。

### AC-3
- **状态**：部分实现
- **证据**：`apps/server/src/trigger/decide.ts:226` — `resolveEventTrigger(...).enabled === 'off'` → `skip(event,'switch-off')`，判定顺序在评论闸门/去重之前；`apps/server/src/http/webhook-v21.ts:988` — `!decision.triggered` 时只 `logger.info` 并返回 200 `ignored`，**不建消息、不建任务**；`apps/server/src/http/webhook-v21.ts:200` — `UPDATE "webhook_deliveries" SET "decision" = $2, "decision_reason" = $3`；`apps/server/src/db/schema.ts:124` — `decisionReason: text('decision_reason')` 列存在。
- **缺口**：**`decision_reason` 全仓只有这一条写入语句，没有任何读取方**——`apps/server/src/queries/` 下（issues/overview/audit/tasks/costs/quality/system）都不 select 这两列，`packages/contract/src/` 没有投递/判定行的响应 schema，面板也没有对应页面。因此「新事件不再进入处理」成立，但「后台能看到该事件被记为『未触发』及原因」不成立：运维只能读日志或直连 PG。
- **判定依据**：按口径「区分存在与生效」，列存在 + 写入完整、但零读取路径 = 该子条件未实现，故整体判部分实现。附加观察：`decision_reason` 只有单值（`apps/server/src/trigger/roles.ts:66` 已注明角色名只能当补充证据），多个原因叠加时后台即使接上也只能看到第一个。

### AC-4
- **状态**：已实现
- **证据**：`apps/server/src/prompt/render.ts:90` — `const PLACEHOLDER_PATTERN = /\{\{([a-zA-Z0-9_.]+)\}\}/gu`（带 `g`）；`apps/server/src/prompt/render.ts:170` — `renderTemplate()` 用**一次** `template.replace(PLACEHOLDER_PATTERN, cb)`；`apps/server/src/prompt/render.ts:173` — 回调对每个匹配独立求值，未知才 `return match` 原样保留。
- **判定依据**：`g` 正则 + `replace` 逐匹配回调 ⇒ 模板里出现几次 `{{issue.number}}` 就替换几次，不存在「只替第一次」的短路；同时因为是一次遍历，替换进去的值不会被二次扫描（FR-2.3 第 1 条）。渲染入口在 `apps/server/src/http/webhook-v21.ts:476`（`renderV21AgentText` → `renderTemplateAsync` → `renderTemplate`），生产路径无第二个渲染器。

### AC-5
- **状态**：已实现
- **证据**：`apps/server/src/trigger/decide.ts:181` — `if (gates.require_mention) { ... findLegalMention(body, mentions) === null → skip('not-mentioned') }`；`apps/server/src/trigger/mention.ts:134` — `findLegalMention()` 返回第一个合法提及；`apps/server/src/config/v21-settings.ts:132` — 四闸门从 `triggers.events['issue_comment.created'].gates` 读出。
- **判定依据**：闸门开着且正文里没有合法提及 → `not-mentioned` → `handleV21Webhook` 不落库不投递；补上 `@` 后同一路径返回 triggered。判定是纯函数且被 webhook 与面板预览共用同一入口（`decideV21Delivery`）。

### AC-6
- **状态**：已实现
- **证据**：`apps/server/src/trigger/decide.ts:178` — `if (!gates.allow_closed && input.issueState === 'closed') return skip('closed-not-allowed')`；`apps/server/src/http/webhook-v21.ts:140` — `issueState` 由载荷 `issue.state` 映射（`'closed' | 'open' | null`）。
- **判定依据**：`allow_closed=false`（=「是否响应已关闭」关闭）且 issue 已关闭 → 直落 `closed-not-allowed`，不落 `agent_messages`、不入队；判定顺序上 `ignore_bot` / `allow_closed` 先于 `require_mention`，所以留痕原因指向真正的病因。

### AC-7
- **状态**：已实现
- **证据**：`apps/server/src/agent/store.ts:124` — `claimOldest`：`UPDATE ... WHERE (repo,issue_number,fingerprint) IN (SELECT ... WHERE status='queued' ORDER BY created_at ASC, fingerprint ASC LIMIT 1 FOR UPDATE SKIP LOCKED) AND NOT EXISTS (status='running' 的另一条)`；`apps/server/src/agent/store.ts:106` — 有排队消息的 issue 按 `MIN(created_at) ASC` 排，先到先领；`apps/server/src/agent/dispatcher.ts:167` — 一轮里每个 issue 只领一条；`apps/server/src/agent/dispatcher.ts:192` — `finishMessageAndContinue()` 先写终态再**立刻**领该 issue 的下一条；`apps/server/src/queue/definitions.ts:152` — `agent-dispatch` 的 `concurrency: 1`。
- **判定依据**：串行由三层叠加：同 issue 只允许一条 `running`（SQL 的 `NOT EXISTS`）、领件按 `created_at` 升序、调度作业并发 1；下一条必须等上一条写终态才可见，因此不会并发交错。残余窗口已在 `apps/server/src/agent/dispatcher.ts:20` 自陈（两个进程同时进 `claimOldest` 的语句级窗口），见「核查边界」。

### AC-8
- **状态**：已实现
- **证据**：`apps/server/src/http/webhook.ts:95` — `INSERT INTO "webhook_deliveries" ... ON CONFLICT ("delivery_id") DO NOTHING`；`apps/server/src/http/webhook.ts:1101` — `rowCount===0` → 200 `duplicate` + `trace.skipDecision = true`（不覆写原判定）；`apps/server/src/http/webhook-v21.ts:903` — 消息级指纹：评论事件用 `commentFingerprint(repo,issue,规范化正文)`，其余事件用 `eventFingerprint(repo,issue,模板id,issue.updated_at)`；`apps/server/src/agent/store.ts:95` — `INSERT ... ON CONFLICT (repo,issue_number,fingerprint) DO NOTHING RETURNING`；`apps/server/src/http/webhook-v21.ts:1038` — `!saved.inserted` → 直接返回 `duplicate`，不 dispatch、不建任务。
- **判定依据**：同 delivery id 重投在投递级被挡；换 delivery id 的重放（GitHub 的 redeliver 会换 GUID）仍会被消息级指纹挡：事件级指纹里 `issue.updated_at` 与模板不变、内容级指纹里正文不变 → 命中 `ON CONFLICT` → 不产生新轮次。三层里没有内存去重表，符合 I6。

### AC-9
- **状态**：部分实现
- **证据**：`apps/server/src/queries/issues.ts:931` — 工具调用按 `toolCallId` 归并 `item.started`(名字/参数) + `tool.progress`(输出) + `item.completed`(失败标记)，只认 `payload.itemType='tool'`；`apps/server/src/queries/issues.ts:996` — 输出 `{ name: oneLine(name) ?? 'unknown', summary: firstLine(args) ?? firstLine(output), at, ok }`；`packages/contract/src/api.ts:908` — `issueToolCallSchema` 的字段只有 `name / summary / at / ok`；`apps/panel/src/routes/issue-detail.tsx:390` — 面板只渲染 `call.summary`（`ok` 决定状态点）。
- **缺口**：**「结果」不可查**。`output_raw`（`tool.progress` 的 `partialResult.content[0].text` 或 `details.output`）唯一去向是 `summary` 的兜底分支，即「只有在没有入参时才显示输出」；一次 Bash 调用（有 `command`）在后台只能看到命令名与命令行，看不到它的输出，也没有独立的 `result`/`output` 字段或展开入口。
- **判定依据**：AC-9 要求「名称、入参摘要与结果」三项齐全，前两项已具备，第三项在契约层就不存在字段，故判部分实现而非已实现。

### AC-10
- **状态**：部分实现
- **证据**：`apps/server/src/worker/run-task.ts:1594` — 任务收尾时从 pi-host 的 sqlite 读 `turns` 表用量，`estimateDeepSeekCostUsd()` 折成本后写 `usage_costs(run_id, model, input_tokens, output_tokens, cost_usd)`；`apps/server/src/cost/host-usage.ts:4` — 明确「不用信封里的 `usage`：那是 agent 自己填的，实测恒为 0」；`apps/server/src/worker/run-task.ts:1416` — v2 信封 `usage: null`；`apps/server/src/queries/tasks.ts:174` — 任务列表只暴露 `costUsd`（`usage_costs` 求和），无 token 拆分；`apps/server/src/queries/costs.ts:236` — `topTasks` 是唯一按任务给 `inputTokens/outputTokens/costUsd` 的读路径（窗口内 Top N，`limit` 默认 10、上限 50）；`apps/panel/src/routes/task-detail.tsx:289` — 任务详情展示的是 `envelope.usage` 的 token/cost；`apps/panel/src/components/issues/contract-extras.ts:104` — issue 详情读 `durationMs`/`costUsd`，契约 `issueTurnSchema` 没有这两个字段 → 恒 `null`。
- **缺口**：**「该轮」的 prompt/completion token 数没有正确的读取路径**。真实 token 全在 `usage_costs`，但它只被聚合成仓库/命令/模型/按日分桶；按轮展示的两处都不可用：任务详情的 `envelope.usage` 在 v2 路径写 `null`（旧路径写的是 agent 自填的 0），issue 会话的轮次契约里根本没有 usage 字段。成本一侧可用（`/api/tasks` 的 `costUsd`、`/api/costs`）。
- **判定依据**：AC-10 两个子条件（token 数、折算成本）只成立一个半：成本可按任务查到；token 只在 `topTasks`（Top N 排名）里按任务可见，且轮次视图上显示的是错的源。故判部分实现。

### AC-11
- **状态**：已实现
- **证据**：`apps/server/src/trigger/decide.ts:257` — `const rawPrompt = trigger.prompt ?? ''; const template = rawPrompt.trim() === '' ? DEFAULT_EVENT_TEMPLATES[event] : rawPrompt;`（空白等同 `null`，防「面板清空输入框」变成发空指令）；`apps/server/src/trigger/decide.ts:84` — `DEFAULT_EVENT_TEMPLATES` 直接再导出契约 `packages/contract/src/settings-v21.ts` 的那一份；`apps/server/src/http/webhook-v21.ts:359` — `v21TemplateOf()` 同口径回落。
- **判定依据**：两种模板在 `decideEvent` 里收敛成同一个字符串，之后一律走 `renderTemplateAsync()`（`apps/server/src/http/webhook-v21.ts:464`→`476`），没有「默认模板另一套私有渲染器」的分叉，所以行为与内置一致；契约侧的默认模板同时被面板「恢复默认」复用，不会出现「看到 A、发出 B」。

### AC-12
- **状态**：已实现
- **证据**：`apps/server/src/http/webhook.ts:1164` — 每条投递都 `policy = await readRepoPolicy(deps.db, repo)`（直查 `repos`，该函数无进程内缓存）；`apps/server/src/trigger/decide.ts:105` — `resolveEventTrigger()` 每次从传入 settings 现解析 `prompt`；`apps/server/src/agent/store.ts:147` — 消息正文在**入队时**写进 `tasks.prompt_text`；`apps/server/src/app/compose.ts:1239` — 执行期 prompt = 系统段 + 已落库的 `agentMessageBody`，不再回读模板。
- **判定依据**：模板只在「收到投递 → 判定 → 渲染 → 落 `agent_messages`/`tasks`」这一段被读取，且每次投递重读 `repos.settings`，所以改完模板的下一个事件立即生效；进行中的轮次用的是已固化的正文，改模板不影响它。注意：`/api/costs` 等查询侧有 5 分钟缓存的只有 `{{repo.issues}}` 索引（`apps/server/src/http/webhook-v21.ts:257`），与事件模板无关。

### AC-13
- **状态**：部分实现
- **证据**：`apps/server/src/writeback/v21/comments.ts:161` — `planSlotWrite()` 命中 `existing` 就返回 `op:'update'`（含 `commentId`），只有找不到才 `create`（带 `recreated` 留痕）；`apps/server/src/writeback/v21/execute.ts:651` — `updateIssueComment()` 覆盖同一槽位，404 时按「重建」处理而不是失败；`apps/server/src/writeback/v21/execute.ts:627` — 找现有评论：槽位索引优先，索引缺失才列评论按隐藏标记找。
- **缺口**：**「需补充信息」标签的自动移除没有专门实现**。全仓没有任何「作者补齐 → 移除 needs-info」的代码路径（`NEEDS_INFO_KEY` 只用于判定「本轮是否缺信息」以决定 `confused` reaction，`apps/server/src/worker/writeback.ts:220`）。实际能否移除取决于模型下一轮**是否输出 `label` 动作且 `desired` 里不含该标签**——那时由目标态差集 `apps/server/src/writeback/v21/labels.ts:187` 顺带删掉；若模型只给 `comment` 动作，标签会一直挂着。
- **判定依据**：前半句（同槽位编辑不新增）已具备且是覆盖语义的唯一实现；后半句缺「平台侧保证」，是模型行为的副作用，故判部分实现。

### AC-14
- **状态**：已实现
- **证据**：`apps/server/src/writeback/v21/labels.ts:88` — `isMeaningFilled()`：`null`/空串/纯空白一律算「没填含义」；`apps/server/src/writeback/v21/labels.ts:93` — `unmanageableReason()` 对 `missing-meaning` 排在目录外/retired/unmanaged 之后；`apps/server/src/writeback/v21/labels.ts:187` — 删除只发生在可管理集合内：当前标签不在可管理目录里就**不删**，push 进 `skipped{label, reason:'missing-meaning'}`；`apps/server/src/writeback/v21/execute.ts:570` — `describeLabelDelta()` 把 `保留 [x/missing-meaning]` 拼进 action 的 `detail`，随 `executed` 落 `run_events`。
- **判定依据**：含义为空的标签永远进不了 `plan.remove`（因此 `removeLabel` 不会被调用），且原因以结构化 `reason` + 人读 detail 两个形态留痕；另一条路径是把这个标签写进 `desired`，则 `labels.ts:170` 整条动作 `label-plan-rejected / unknown-label` 拒绝，同样不落任何写。

### AC-15
- **状态**：与需求冲突
- **证据**：`apps/server/src/writeback/v21/labels.ts:183` — `const add = desired.filter((name) => !currentSet.has(name));` 目标态对齐只做「当前集合差集」，`planLabelTargetState()` 的入参里没有「人工否决」这一项，`LabelPlanInput`（`labels.ts:51`）也没有该字段；`apps/server/src/writeback/v21/execute.ts:548` — 只要 `plan.add` 非空就 `addLabels()`。旧的否决机制只存在于 v0.3 写回：`apps/server/src/workflows/normalize.ts:212` 从 `humanVetoed` 集合剔除，而该集合由 `apps/server/src/workflows/bot-labels.ts:73` 用 `bot_labels` 历史推（`normalize.ts:241` 判「最后一条 `removed_at` 非空」）——`removed_at` 只由我们自己的 `recordRemoved` 写入（`apps/server/src/workflows/bot-labels.ts:134`），维护者在 GitHub 上手动删标签**不会**写它；`apps/server/src/jobs/reconcile-reverts.ts:303` 发现标签被摘也只置 `actions.reverted_at`，不回写 `bot_labels`。
- **缺口**：维护者手动删掉某标签后，下一轮目标态里若仍含它，`add` 会算出它并立即 `addLabels()` 加回——与 AC-15「不会被自动加回」正相反。既有的唯一否决实现（v0.3 路径）对「人工删除」根本不触发，因为它推的是我们自己的撤标记录。
- **判定依据**：代码行为与条目要求方向相反，且不是「没实现」而是「实现了相反的策略」（差集重打）。同时点出与 BR-11 的关系：AC-15 只要求「一次对齐不加回」，BR-11 明确「人工删除不构成**永久**否决」（`docs/requirements.html:1047` 亦写「下一轮按目标态重新对齐」，`docs/requirements.html:425` 记录 BR-11 已改为显式「不自动管理」标记、取消「人删过永久不加回」）。现状是**两个方向都没有**：既没有「一次不加回」的临时否决，也没有 BR-11 要求的显式「不自动管理」判定（`isManageableCatalogEntry()` 只看 `managed/status/meaning`，与「人是否删过」无关）；而旧路径那个由 `bot_labels.removed_at` 推出的否决是**持续生效**的，若把它接到 v2 就会反过来与 BR-11 冲突。**结论：AC-15 与 BR-11 无法同时由当前代码满足，且当前代码两侧都不满足。**

### AC-16
- **状态**：已实现
- **证据**：`apps/server/src/worker/run-task.ts:1016` — `driveTurn()` 抛错时 `turnResult = undefined; terminal = null; lastProbe = { kind:'not-v21' }` 并 `break`；`apps/server/src/worker/run-task.ts:1154` — 信封校验/落库整段包在 `if (turnResult !== undefined)` 里，超时路径完全跳过；`apps/server/src/worker/run-task.ts:1299` — 十二类写动作要求 `v21Handled && v21Plan !== null`（超时路径恒 `false`/`null`）；`apps/server/src/worker/run-task.ts:1255` — 兜底评论额外要求 `terminal === 'turn.completed'`（超时为 `null`）。
- **判定依据**：超时后没有任何一条 `addLabels/removeLabel/createIssueComment/updateIssueComment` 被调用：v2 执行器不进入、旧 4-intent 写回不进入（`prepared` 未生成）、兜底评论被 terminal 条件挡住。收尾仍会写 `usage_costs`/`issue_feedback` 与一条 `confused` reaction（`run-task.ts:1629`），但那不是「标签与评论」，不违反本条。

### AC-17
- **状态**：已实现
- **证据**：`apps/server/src/trigger/mention.ts:70` — `isMentionSeparator()`：空串（串尾）或 `\s` 或 `SEPARATOR_CHARS`；`apps/server/src/trigger/mention.ts:50` — 分隔符白名单（半角标点 + 中文句读/成对符号），**不含中文汉字**；`apps/server/src/trigger/mention.ts:115` — `matchKeywordAt()` 在 `!isMentionSeparator(masked.charAt(end))` 时 `continue`（该关键词不算命中）；`apps/server/src/trigger/mention.ts:43` — 文件头把「`@pi-bot你好` 必须不命中」写成本条的实现目标。
- **判定依据**：`@pi-bot帮我看看` 里关键词 `pi-bot` 后紧跟 `帮`（不在 `\s`、不在标点白名单）→ 不命中 → `require_mention` 时判 `not-mentioned` 不触发；`@pi-bot 帮我看看` 后紧跟空格 → 命中 → 触发。另两条相邻约束同样成立：`@pi-botx` 因分隔符判定不命中，`foo@pi-bot` 因前导字符禁区（`mention.ts:67`）不命中。

## 本节整体结论
**本节不能整体判为「已实现」：17 条里 11 条已实现，5 条部分实现，1 条与需求冲突。** 三条主链路（会话复用与两轮可见、事件判定与模板渲染、串行与幂等）在代码上成立且证据充分；两个「后台可查」类条目（AC-3 未触发原因、AC-9 工具结果）缺的是读取路径而不只是展示，属结构缺口。最需要决策的是 AC-10（按轮 token 显示的是 agent 自填的 0）与 AC-15（差集重打与 BR-11 双双不满足，且 `docs/requirements.html` 内部对「人工删除」的表述已自相矛盾）。AC-13 的标签移除、AC-2 的「不再重复询问」依赖模型每轮的具体产出，属有条件成立。

## 核查边界
- **是否执行了命令**：未执行 `pnpm test` / `typecheck` / `lint` 等验证命令，也未连真库、未起 Docker、未调真模型；只做了只读检索与阅读（`Grep` / `Get-ChildItem` / `Read`），以及 `New-Item -Force` 建本期产出目录。因此本报告只声明「实现存在且调用方明确」，不声明「测试跑过且绿」。
- **未覆盖的条目及原因**：
  - AC-2 的「第二轮不再重复询问第一轮已确认的信息」：属真模型行为，需真实 pi-host 跑两轮才能确认；本节只证明同一 `session_id` 复用且历史保留。
  - AC-1 的运行时前提：`session/attach` 是否被部署的 Host 真正支持（`apps/server/src/runtime/turn-driver.ts:484` 在 Host 不提供该 operation 时降级为「新建会话 + `sessionReset`」）无法静态确认；若 Host 不支持，AC-1 会在运行时退化为每轮新会话。
  - AC-5 / AC-6 / AC-17 的端到端效果未用真 GitHub 载荷验证；判定本身是纯函数，`issueState` / `comment` 的取值依赖 `apps/server/src/http/webhook-v21.ts:140` 的载荷映射，本报告只核到映射代码。
- **发现的额外问题（不属本节范围）**：
  1. `apps/server/src/writeback/v21/labels.ts:187` 会删除**任何**不在目标态里的可管理标签，包括人手工打上的（只在 `owner` 里记成 `human`）。这与 AC-15/BR-11 的「管辖边界」是同一个根问题：目前没有「这个标签归谁管」的判定，只有「在不在目录里」。
  2. `apps/panel/src/components/issues/contract-extras.ts:104` 的 `readRunCost()` 读 `durationMs`/`costUsd`，而 `packages/contract/src/api.ts:931` 的 `issueTurnSchema` 没有这两个字段——该函数在详情页恒返回 `null`（耗时显示 `—`、成本不显示），属静默失效而非报错。
  3. `apps/server/src/trigger/decide.ts:31` 的 `SkippedReason` 有 12 个取值，其中 `body-unchanged` / `label-not-matched` / `role-denied` 等按设计只落单值；`decision_reason` 单列无法同时表达「开关关着」与「没提及」这类叠加原因（`apps/server/src/trigger/roles.ts:66` 已自陈）。
  4. AC-12 的「下一个事件立即生效」在**面板保存 → webhook 到达**之间没有一致性校验（无 settings 版本号/`ETag`），并发保存与投递同时发生时本轮用的可能是旧快照；按需求口径可接受，但复盘时会看到「明明改了却按旧模板跑」。
