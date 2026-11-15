# U26 10 验收标准 AC-1 ~ AC-17 · B

> 核查范围：docs/requirements.html 行 1849-1865
> 代码基线：见 docs/audit/v2/_baseline.txt（HEAD fbfa02983d36d4923c0647f4c18aacd041d83375，工作区含 20 个已改文件，本次读的就是这份工作区）

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| AC-1 | 已实现 | 常态共用 `agent_sessions.session_id`；轮换（30 轮 / 7 天）与 `session/attach` 失败会换 id |
| AC-2 | 部分实现 | 缺「完整对话」：`item.delta` 不落库，会话视图只有触发正文 + 最终评论正文 + 工具名/摘要 |
| AC-3 | 部分实现 | 缺「后台可见」：`decision_reason` 全仓仅写入，无任何读查询 / 接口 / 契约字段 |
| AC-4 | 已实现 | — |
| AC-5 | 已实现 | — |
| AC-6 | 已实现 | — |
| AC-7 | 部分实现 | 串行只有应用层 `NOT EXISTS(running)` + 并发=1，无数据库唯一约束；顺序依赖 `created_at` 而非投递序 |
| AC-8 | 已实现 | — |
| AC-9 | 部分实现 | 缺「结果」：只有 `ok` 布尔，工具输出正文未进契约与查询 |
| AC-10 | 部分实现 | 缺「该轮 prompt/completion token 数」的读出口；v2 的 `envelopes.usage` 恒写 `null`，成本只有任务级和日级 |
| AC-11 | 已实现 | — |
| AC-12 | 已实现 | 事件模板每次投递现读库，无 TTL 缓存 |
| AC-13 | 部分实现 | 槽位覆盖有；「需补充信息」标签自动移除无实现路径（无 awaiting_info 状态、无补齐检测） |
| AC-14 | 已实现 | — |
| AC-15 | 与需求冲突 | 字面成立，但机理与 BR-11/FR-5.4「人工删除不构成永久否决」相反（v0.3 是永久 veto，v2 靠台账陈旧碰巧不加回） |
| AC-16 | 已实现 | — |
| AC-17 | 已实现 | — |

## 逐条

### AC-1
- **状态**：已实现
- **证据**：
  - `apps/server/src/agent/store.ts:147-150` — `insertTask` 写 `source='agent'`，`tasks` 有唯一幂等键。
  - `apps/server/src/app/compose.ts:423-480` — `planAgentSession()`：无 `session_id` → `{mode:'persistent'}`；有 id → `{mode:'persistent', sessionId, after: cursor}`（复用同一 id，`after` 防重放）。
  - `apps/server/src/runtime/turn-driver.ts:354-374` — `persistent` 且有 id 时先 `session/attach`，成功即沿用该 `sessionId`；只有 attach 失败才 `session/create` 新建（:372 只 warn）。
  - `apps/server/src/app/compose.ts:1039-1052` — 会话字段按 `report.sessionId` UPSERT 回 `agent_sessions`（一个 issue 一行）。
  - `apps/server/src/http/webhook-v21.ts:786-802` — 会话 SQL 只有 INSERT/UPDATE，**永远不 DELETE**。
- **判定依据**：`opened` 与 `edited` 都建 `source='agent'` 任务 → 走同一条 `planAgentSession` 复用分支 → 第二个事件拿第一个事件落库的 `session_id`。这是「共用同一会话 ID」的完整链路，非注释自述。
- **反证过程**：假设它不成立，会出现三处证据里的任一处：①有 archive/rotate 分支换 id；②`session_id` 没落库；③`events/subscribe` 从 0 重放导致第二轮其实是新会话。逐条查：③被 `compose.ts:466-479`（`cursor>0` 才传 `after`）+ `turn-driver.ts:395` 排除；②被 `compose.ts:1039-1052` 排除；①**确实存在**：`compose.ts:450-463` 在 `turns>=30`（`agent/constants.ts` 的 `AGENT_SESSION_POLICY.maxTurns=30`）或 `age>=7 天` 时 `rotate=true`，`archiveSessionId=旧 id` 且本轮 `session/create` 新会话；`turn-driver.ts:354-374` 的 attach 失败同样换 id。两条都是兜底/治理路径，不否定「两个事件共用 id」这一场景，故判已实现，但「共用」不是无条件不变量。

### AC-2
- **状态**：部分实现
- **证据**：
  - `apps/server/src/queries/issues.ts:908-963`（会话 = 人类轮 + 机器人轮 + 工具调用）；机器人轮正文只取 `envelopes.actions` 里 `intent='comment'` 的 `body`（`queries/issues.ts:889-899`）。
  - `apps/server/src/worker/run-task.ts:972-977` — `item.delta`（正文流式增量）明确**不落库**。
  - `apps/server/src/queries/issues.ts:930-991` — 只归并 `itemType='tool'` 的 `run_events`，`itemType='message'` 的内容不进会话视图。
  - `packages/contract/src/api.ts:931-963` — `IssueTurn` 没有任何「模型中间消息」字段。
- **缺口**：缺「**完整**对话」子条件：会话视图能给出每轮的人类输入、最终评论正文、工具名+摘要+ok，但模型中间的 assistant 输出、工具返回全文（`tool.progress` 的 output 只在缺 args 时借用作 summary）、以及历史轮次里的多步推理都没有读取出口。同一轮里模型先问后答的多段正文在会话页只剩最后那条评论。另：AC-2 的「第二轮不再重复询问第一轮已确认的信息」是模型行为，静态代码无法证明；它成立的前提 `session/attach` 失败会被静默降级为新建会话（`runtime/turn-driver.ts:372`），此时上下文立即丢失。
- **判定依据**：能查到「两轮」和「部分对话」，查不到「完整对话」，属主体在、子条件缺失。
- **反证过程**：先假设「完整对话」其实藏在别处。三个候选读法逐一排除：(a) `agent_messages` —— 只存触发消息（`agent/store.ts:212-238` `insertMessage`），无 assistant 内容；(b) `run_events` —— 有 `item.completed` 但 `item.delta` 被过滤（`run-task.ts:975`），且会话查询只取 tool 类事件；(c) 任务详情页的 `events` —— 那是单次任务的 `run_events` 尾巴（`queries/tasks.ts:472-486`，`DETAIL_EVENTS_LIMIT` 上限截断），不是「该 issue 会话的两轮完整对话」。三者都不构成 AC-2 要求的读出口。

### AC-3
- **状态**：部分实现
- **证据**：
  - 写入侧完整：`apps/server/src/trigger/decide.ts:216-229` — 验签失败/仓库不可用/开关 `off` 分别给 `signature-invalid` / `repo-disabled` / `switch-off`；`apps/server/src/http/webhook.ts:987-1027` — 外层对**每条投递**落一次判定；`apps/server/src/http/webhook-v21.ts:198-211` — `UPDATE webhook_deliveries SET decision, decision_reason`。
  - 列存在：`apps/server/src/db/schema.ts:124`（`decisionReason`）、`migrations/0011_v21.sql:18`。
  - **读取侧为空**：`apps/server/src/queries/*.ts` 与 `packages/contract/src/*.ts` 中 grep `decision_reason|decisionReason` **零命中**（命中项只有 `db/schema.ts:124`、`http/webhook*.ts` 的写入与注释、`panel/src/components/settings/v21-events-section.tsx:20` 的一句注释、`test/db-schema.test.ts` 的列断言）。`queries/overview.ts:77` 只 `count(*) from webhook_deliveries`，不选判定列。
- **缺口**：缺「后台能看到该事件被记为『未触发』及原因」子条件。判定与原因写进了库，但没有任何 API/查询/契约字段能读出来，面板也没有投递视图；「不触发也留痕」目前只对直接连库的人可见。这正是口径文件 §三.2 的反例形态：有列、有写入、无读取 = 判未满足。
- **判定依据**：「新事件不再进入处理」有实现（`decide.ts:226-229` → `webhook-v21.ts:988-994` 200 ignored 不入队）；「后台可见」无实现出口，故部分实现。
- **反证过程**：假设「其实有出口」，最可能是 (a) 面板某个投递/审计页、(b) `GET /api/audit`、(c) `run_events` 里也写了一份判定。查 (a)：`apps/panel/src/routes/*.tsx` 无 deliveries 路由，`layout/nav.ts` 也没有这一项；(b)：`queries/audit.ts` 的 SQL 只读 `actions` / `run_events` / `runs`，不含 `webhook_deliveries.decision*`；(c)：`handleV21Webhook` 的未触发分支只 `logger.info`（`webhook-v21.ts:989-992`），不写事件流。三条都不成立。

### AC-4
- **状态**：已实现
- **证据**：`apps/server/src/prompt/render.ts:90`（全局正则 `/\{\{([a-zA-Z0-9_.]+)\}\}/gu`）、`:170-185`（单次 `template.replace(...)`，回调逐个替换，不做「只替第一次」短路）、`:142-143`（`issue.number` 取值）。`apps/server/src/http/webhook-v21.ts:464-476` — 项目模板与内置默认模板都交给同一个 `renderTemplateAsync`。
- **判定依据**：`String.replace` + `g` 标志对每一处占位符各回调一次，写两次就替换两次；且「一次遍历」保证替换值不被二次扫描，与需求 FR-2.3 的两条规则一致。
- **反证过程**：假设只替第一处，检查点有三个：正则是否带 `g`（带）、是否 `break`/`return` 提前退出（无）、是否被拆成 `replaceAll(name…)` 循环（无，`render.ts:167-169` 注释即限制）。测试侧 `apps/server/test/prompt-render.test.ts` 存在且断言的是渲染结果文本，不是 200。

### AC-5
- **状态**：已实现
- **证据**：`apps/server/src/trigger/decide.ts:181-187` — `require_mention` 开启时 `findLegalMention(body, mentions) === null` → `not-mentioned`；`packages/contract/src/settings-v21.ts:108` — `require_mention` 默认 `true`；`apps/server/src/trigger/mention.ts:134-161` — 提及判定（`@` 紧邻、前导字符禁区、后接分隔符、最长优先）。
- **判定依据**：闸门是事件判定的第四步（`decide.ts:237-243`），只作用于 `issue_comment.created`；未命中直接返回 200 ignored（`webhook-v21.ts:988-994`），不入队 → 不处理。@ 之后 `findLegalMention` 返回非 null → 继续走后面的去重/配额 → 触发。
- **反证过程**：假设「提到也不触发」，可能断点：①`mentions` 为空数组则永不命中（`mention.ts:135-141` 返回 null）—— 这是配置前提，需求同样假设关键词已配；②命中后仍被后续闸门/去重挡掉 —— `decide.ts:188-199` 的 `require_role`、`:246-248` 的 `content-duplicate` 都会让「@ 了也不触发」，但那是另外两条独立规则，不否定 `require_mention` 本身；③判定顺序被写反（先记 `not-mentioned` 再判开关）—— `decide.ts:226-243` 顺序确实为开关→条件→闸门。结论：本条的判据链（开启→无 @ 不触发、有 @ 通过该闸门）成立。

### AC-6
- **状态**：已实现
- **证据**：`apps/server/src/trigger/decide.ts:178-180` — `!gates.allow_closed && issueState === 'closed'` → `closed-not-allowed`；`packages/contract/src/settings-v21.ts:116` — `allow_closed` 默认 `false`；`apps/server/src/http/webhook-v21.ts:132-140` — `issueState` 直接取载荷里 `issue.state`。
- **判定依据**：已关闭 issue 上的新评论在评论闸门处被拦，返回 ignored、不入队（`webhook-v21.ts:988-994`），因此不产生轮次。
- **反证过程**：假设会触发，断点只可能在 ①`issueState` 取不到（`str(issue,'state')` 为 null 时上面那条不成立 → 会放行）；②闸门解读反了。查 ①：`webhook-v21.ts:140` 对 `closed`/`open`/其它分别给 `'closed'|'open'|null`，评论事件载荷必带 `issue.state`，`null` 只在异常载荷出现；查 ②：`:178` 的否定条件与 AC 语义一致。另查闸门顺序：`ignore_bot` 在前（`:175-177`），只影响留痕原因，不改变「不触发」的结论。

### AC-7
- **状态**：部分实现
- **证据**：
  - 串行：`apps/server/src/agent/store.ts:102-139` — `queuedIssues` 排除已有 `running` 的 issue；`claimOldest` 用 `FOR UPDATE SKIP LOCKED` + `NOT EXISTS (running)` 只领**最老**一条。
  - `apps/server/src/queue/definitions.ts:146-159` — `agent-dispatch` 并发 1。
  - `apps/server/src/agent/dispatcher.ts:20-23` — 自述「两个 dispatcher 真同时进 `claimOldest` 时仍可能各领到同一 issue 的不同消息（`NOT EXISTS (running)` 是快照判定）」，彻底消灭需一条部分唯一索引，**尚未做**。
  - 顺序依据是 `ORDER BY m.created_at ASC, m.fingerprint ASC`（`store.ts:114`、`:130`）。
- **缺口**：缺「数据库级串行保证」：串行只由「一条 SQL 的快照判定 + 队列并发=1」维持，没有 `(repo, issue_number) WHERE status='running'` 的部分唯一索引兜底；多实例/多进程部署或 dispatcher 与 `finishMessageAndContinue()`（`dispatcher.ts:192-207`）交叉执行时存在并发交错窗口。顺序也依赖 `created_at`（插入时的 `now()`），同一时间戳时用随机 `fingerprint` 兜底（`store.ts:130`），与「到达顺序」不是同一件事。
- **判定依据**：主链路（同一 issue 一条 `running`、任务结束立刻取下一条）在，但需求说的是「没有并发交错」，代码自认这是有窗口的近似，属子条件不完整。
- **反证过程**：假设「其实是数据库级保证」，去查三样东西：①`agent_messages` 上有没有部分唯一索引 —— `apps/server/src/db/schema.ts:706-740` 该表只有普通索引/唯一键 `(repo, issue_number, fingerprint)`，没有 `status='running'` 的部分唯一索引；②领号语句是不是单条原子语句 —— 是单条 `UPDATE ... WHERE … IN (SELECT … FOR UPDATE SKIP LOCKED)`，但 `NOT EXISTS (running)` 与 `SET status='running'` 在同一条语句里对**另一个事务的未提交行**不可见；③并发闸是不是只有 1 —— `definitions.ts:153` 是 1，但那是**单进程**的 pg-boss 并发，跨进程不构成互斥（`claimOldest` 注释 `store.ts:120-122` 也这么写）。三样都说明：串行是应用层尽力保证。

### AC-8
- **状态**：已实现
- **证据**：`apps/server/src/http/webhook.ts:95-97` — `INSERT … ON CONFLICT ("delivery_id") DO NOTHING`；`:1099-1117` — `rowCount=0` 即 200 `duplicate`，直接 return（不建任务、不进判定后续步骤）；`apps/server/src/http/webhook-v21.ts:1029-1044` — 即使走到消息层，`insertMessage` 幂等（`agent/store.ts:96-98` `ON CONFLICT (repo, issue_number, fingerprint) DO NOTHING`）→ `duplicate`，不再 dispatch。
- **判定依据**：同一个 `X-GitHub-Delivery` 第二次到达时，第一层（投递行）就短路，第二层（消息指纹）再兜一次，两层都不产生新的 `runs`。幂等在持久层，不靠内存。
- **反证过程**：假设重放会产生新一轮，断点候选：①`ON CONFLICT` 条件写错列（查：`schema.ts:88-133` 上该表主键是 `delivery_id`，SQL 匹配）；②duplicate 分支之后仍继续走任务创建（查：`webhook.ts:1117` 直接 `return finish(...)`）；③重投时 `skipDecision` 相关逻辑把行删了重建（查：`webhook-v21.ts:198-211` 只有 UPDATE，没有 DELETE；`webhook.ts:990-993` 重复投递时 `trace.skipDecision` 为真即不覆盖判定）。三条都不成立。

### AC-9
- **状态**：部分实现
- **证据**：
  - 查询侧：`apps/server/src/queries/issues.ts:930-1005` — 按 `toolCallId` 归并 `item.started` / `tool.progress` / `item.completed`，产出 `{name, summary, at, ok}`；`:996-1002` — `name` 取 `event.toolName`（截 200 字）、`summary` 取 **args 首行**（`firstLine(args_raw) ?? firstLine(output_raw)`）、`ok = !failed`。
  - 契约：`packages/contract/src/api.ts:908-919` — `IssueToolCall = {name, summary, at, ok}`。
  - 面板：`apps/panel/src/routes/issue-detail.tsx:333`、`:385-391` — 逐行渲染 name / summary / 状态点。
- **缺口**：缺「**结果**」这个子条件。名称、入参摘要可查；结果只暴露成 `ok: boolean`（失败标记），工具返回的正文只在「没有 args」时才被借到 `summary` 里（`issues.ts:998`），正常调用时输出一个字都读不到；`tool.progress` 的 `partialResult` 明明已落 `run_events`（`:945-949`）却没有读取出口。
- **判定依据**：AC-9 三个并列项（名称 / 入参摘要 / 结果），实现了两项半。
- **反证过程**：假设「结果也能查」，三个可能的读法：①`IssueToolCall` 有 output 字段 —— 契约 `api.ts:908-919` 是 `.strict()` 的四个键，没有；②任务详情页的 `run_events.payload` 能看到 —— 能看到原始 `tool.progress`（`queries/tasks.ts:472-486`），但那是**单任务事件流尾部 500 条**，不是「该轮每次工具调用的结果」，且超限截断；③`ok` 就算结果 —— `ok` 只表达成功/失败，AC-9 要的是结果内容。结论：缺结果。

### AC-10
- **状态**：部分实现
- **证据**：
  - 记账侧完整：`apps/server/src/worker/run-task.ts:1591-1620` — 不信任信封里的 `usage`，按 `turnId` 从 host 取真实用量，`inputTokens = usage.inputTokens + cacheReadTokens`、`outputTokens`、`estimateDeepSeekCostUsd()` 折算成本后 `recordUsage`；表 `apps/server/src/db/schema.ts:452-469`（`usage_costs`：`run_id / model / input_tokens / output_tokens / cost_usd`）。
  - 读取侧：`apps/server/src/queries/tasks.ts:143-148` — 任务级只 `sum(cost_usd)`；`:488-498` — 每 run 只取 `envelopes.usage`；`packages/contract/src/api.ts:300-302` — `EnvelopeRecord.usage = {inputTokens, outputTokens, costUsd}`；`api.ts:382-385` — 成本曲线是**按天**的 `inputTokens/outputTokens`。
  - v2 路径把 `envelopes.usage` 写死 `null`：`apps/server/src/worker/run-task.ts:1181`、`:1416`。
- **缺口**：缺「按轮（该轮）查 prompt 与 completion token 数」的出口。`usage_costs` 有分列数据但没有任何查询/接口按 run 返回 `input_tokens/output_tokens`；`EnvelopeRecord.usage` 在 v2 任务上恒为 0（写的是 `null`，`queries/tasks.ts:335-341` 兜成 0），成本只有任务级求和（`:174`）与按天聚合（`api.ts:383`）。
- **判定依据**：AC-10 两个子条件：token 分列（按轮）——无出口；折算成本——有。部分实现。
- **反证过程**：假设「按轮 token 能查」，候选读法：(a) `RunSummary` 带 usage —— `api.ts:237-253` 没有该字段；(b) `TaskListItem.costUsd` —— 只有成本，没有 token（`api.ts:199-200`）；(c) 成本页按模型/命令拆 —— `queries/costs.ts:136-181` 的 scoped 聚合维度是 day/model/command，不是 run。另外「costUsd 有值」这件事本身也要打问号：v2 任务的 `envelopes.usage=null`（`run-task.ts:1416`），面板如果从 envelopes 读就永远显示 0，必须从 `usage_costs` 走 `tasks.ts:143-148` 那条路才不为 0 —— 两条口径并存。

### AC-11
- **状态**：已实现
- **证据**：`apps/server/src/trigger/decide.ts:255-265` — `trigger.prompt` 空白则用 `DEFAULT_EVENT_TEMPLATES[event]`；`apps/server/src/http/webhook-v21.ts:359-362` — `v21TemplateOf()` 同一口径；`apps/server/src/trigger/decide.ts:84-89` — 默认模板再导出自契约 `packages/contract/src/settings-v21.ts`，面板与服务端同一份；`webhook-v21.ts:450-516` — 两条来源最终都进同一个 `renderTemplateAsync`。
- **判定依据**：未配置（`null` 或空串）→ 平台默认模板，且渲染器只有一份，因此「行为与内置一致」不是靠复制代码保证，而是靠同一函数。
- **反证过程**：假设默认模板走了另一套渲染，检查点：`v21TemplateOf` 之后是否还有分支 —— `webhook-v21.ts:464-476` 只有一次 `renderV21AgentText()`；`decide.ts` 返回的 `template` 也只是字符串。另查「空白串」是否被当作「发空指令」—— `:257-258` 显式把 `trim()===''` 归到默认模板，`:361` 同。未发现第二套渲染器。

### AC-12
- **状态**：已实现
- **证据**：`apps/server/src/http/webhook.ts:1164` — 每条投递都 `await readRepoPolicy(deps.db, repo)` 现读 `repos.settings`；`:1241-1270` — 判定与渲染都用这一份；`apps/server/src/config/repo-config.ts:96-106` 的缓存只缓存「env 里的默认 settings」（`loadDefaultRepoSettings`），不缓存仓库行；`apps/server/src/http/webhook-v21.ts:1029-1037` — 渲染结果落 `agent_messages.comment_body`，之后不再重渲染。
- **判定依据**：改模板 → 下一条投递重新读库 → 新模板生效；已经在跑的轮次用的是已经落进 `agent_messages.comment_body` 的旧正文，不回写，因此「进行中的轮次不受影响」。
- **反证过程**：假设「需要重建会话才生效」，要找的是 TTL 缓存或会话级模板快照。查：①`worker-deps.ts:763-843` 的 5 分钟缓存只针对 `AGENTS.md`，与事件模板无关；②`agent_messages.comment_body` 是**渲染后正文**，`tasks.prompt_text` 也是落库快照 —— 这是「不受影响」的实现，不是「需要重建会话」；③系统提示词另说：`runtime/turn-driver.ts:214-221` 明确 `systemPrompt` 只在 `session/create` 时生效，`session/attach` 分支传了也没用 —— 这条与 AC-12 的「项目模板」不是同一对象，但确实是「改配置要重建会话才生效」的那类项，记进额外问题。

### AC-13
- **状态**：部分实现
- **证据**：
  - 槽位覆盖（前半段）已实现：`apps/server/src/writeback/v21/comments.ts:53-55`（隐藏标记 `<!-- pi-bot:slot repo#issue:slot -->`）、`:98-114`（按标记在评论列表里找同槽位）、`:161-177`（有 existing → `op:'update'`）；`apps/server/src/writeback/v21/execute.ts:627-683` — 先查 `slotStore`，再 `findSlotComment` 兜底，命中即 `updateComment`，重建时记 `slot-unresolved`。
  - 标签自动移除（后半段）无实现路径：全仓 grep `awaiting_info|补充信息|补齐` 只命中 `db/schema.ts:212`、`http/webhook.ts:114` 的**注释**（都已经不存在的 `issue_pipeline` 时代），无状态机、无「作者补齐」检测、无标签联动；会话/任务状态里也没有这类取值（`packages/contract/src/enums.ts` 的 `taskStatus`）。标签只由模型当轮输出的 `label` 目标态驱动（`writeback/v21/labels.ts:135-199`）。
- **缺口**：缺「补齐信息后『需补充信息』标签被自动移除」子条件。代码里没有任何一处把「作者补充了正文/评论」与「撤掉某个标签」连起来：要靠模型在那一轮恰好产出不含该标签的 `label` 目标态；若模型只发评论或 `actions: []`，标签就留在 issue 上。同时也没有任何「缺失信息 → 打标签」的自动化，因此这条验收在代码层面无法闭环。
- **判定依据**：槽位编辑更新有完整实现路径（需求的第一句成立）；标签自动移除找不到实现，属子条件缺失。
- **反证过程**：假设「标签移除其实由别处做」，候选：①`writeback/v21/execute.ts` 的 `label` 动作 —— 需要模型输出该动作，不构成自动；②`jobs/reconcile-reverts.ts` —— 它只做「我们做的写操作被改回」的对账（`reconcile-reverts.ts:299-306` 的 `label-removed` 是**观测**写进 `actions.revert_kind`），不撤标签；③`feedback/apply.ts` —— 只打 reaction（`:281` `addReaction`），评论/标签一概不动；④面板/CLI 有没有「补齐后手动触发」—— 没有对应接口（AC-33 也提到重跑接口缺失）。四处都不构成实现。另查「同槽位是否真按隐藏标记查找」：`execute.ts:627-638` 是「索引优先 + 标记兜底」双路，符合 AC-13 的意图。

### AC-14
- **状态**：已实现
- **证据**：`apps/server/src/writeback/v21/labels.ts:92-107` — `unmanageableReason()` 把 `not-in-catalog` / `retired` / `unmanaged` / **`missing-meaning`** 判成不可管理；`:187-197` — 当前标签若不可管理就进 `skipped` 而不是 `remove`（即：不删）；`apps/server/src/writeback/v21/execute.ts:519-536` + `:562-571` — `describeLabelDelta()` 生成「保留 [标签/missing-meaning]」的人读原因；`apps/server/src/worker/run-task.ts:1435-1443`（`actions.audit.detail`）与 `:1457-1468`（`run_events` `writeback.v21.result` 的 `executed[].detail`）把原因落库。
- **判定依据**：目标态缺一个含义为空的标签 → 该标签不进 `remove` → 不发 `removeLabel`（`execute.ts:555-559` 只遍历 `plan.remove`）；原因以结构化 detail 落 `run_events` 与 `actions.audit`，可查。
- **反证过程**：假设「其实删了」，要看三处：①`isMeaningFilled()` 是否把空白当填过 —— `labels.ts:88-90` 只要 `trim()!==''`，空白判空，正确；②`remove` 的构造是否绕过了可管理判定 —— `:187-197` 逐条判，绕不过；③原因是否只在内存里 —— detail 进了 `writeback.v21.result` 事件（`run-task.ts:1457-1468`）。注意一个真实瑕疵（不影响本条判定）：`actions.audit` 走契约后 `detail` 会被丢掉（`queries/tasks.ts:399-421` 只挑 declared/actual/intersect/dropped/rejectedReason），所以原因在「任务详情的事件时间线」可见，在「动作列表」不可见。

### AC-15
- **状态**：与需求冲突
- **证据**：
  - 需求侧：`docs/requirements.html:1796`（BR-11）「未标记的标签按目标态正常对齐——**人工删除不构成永久否决**」；`docs/requirements.html:1047`「人工删除不构成永久否决：下一轮按目标态重新对齐……确实不想让平台碰某个标签，用项目级的『不自动管理』标记」；`docs/requirements.html:425` 也写明「BR-11 改为显式『不自动管理』标记（取消『人删过永久不加回』）」。
  - 代码侧（v0.3 写回路径）：`apps/server/src/worker/writeback.ts:190-199` — 每轮先 `policy.humanVetoed(...)` 取「人撤过的标签」，喂给 `normalizeDesired({ … humanVetoed: vetoed })`；`apps/server/src/workflows/normalize.ts:215-218` — 命中即 `reason: 'human-veto'` 丢弃；`:234-263` — `humanVetoedFrom()` 的判定口径是「该标签**最后一次**记录是 `removed_at` 非空」。这就是永久否决，与 BR-11 正相反。
  - 代码侧（v2 写回路径）：`writeback/v21/labels.ts:135-199` 完全没有 veto 入参；`apps/server/src/app/compose.ts:1149` / `:859-863` 的 `currentLabels` 取自 `bot_labels` 台账（`readAppliedLabels`），不是 GitHub 现状；而 `bot_labels.removed_at` 只在**我们自己撤标**时写（`github/executor.ts:336-347` + `workflows/bot-labels.ts:134-144`），人工在 GitHub 上删标签不会产生任何 `bot_labels` 行。
- **缺口 / 冲突点**：AC-15 字面上「不会被自动加回」在两处都成立，但机理都和 BR-11 相反或无关：(1) v0.3 路径把它实现成**永久否决**（`worker/writeback.ts:199` + `normalize.ts:215-218`），直接违反 `requirements.html:1796` 的「人工删除不构成永久否决」；(2) v2 路径根本没有否决机制，只是因为「当前标签」读的是自己的台账（`compose.ts:1149`），人工删除后台账仍认为标签在，于是 `add = desired − current` 恰好为空 —— 一旦台账被刷新或 `removed_at` 被写（例如我们自己撤过一次再被人重打），同一目标态就会把它加回。两处都不是实现 BR-11 的正解：正解应读「不自动管理」标记（`labels.ts:100-105` 的 `unmanaged` 已支持该语义）。
- **判定依据**：代码存在与需求正文（BR-11 / FR-5.4）方向相反的实现，且反向实现的位置可以点名到行；同时 AC-15 与 BR-11 在需求文档内部互相矛盾（AC-15 说「不会加回」，BR-11 说「人工删除不构成永久否决」），故按口径判「与需求冲突」并点名反着来的那一行。
- **反证过程**：先假设「AC-15 已被正确实现（有不自动管理的显式管辖）」。检查点：①是否存在按 `labels.catalog[].managed=false` 的过滤 —— 有，`labels.ts:100-105`，但那与「人删过」无关；②是否有把「人工删除」写进台账的路径 —— `reconcile-reverts.ts:299-306` 只在 `actions` 上记 `revert_kind='label-removed'`，`bot_labels` 一行不写（`workflows/bot-labels.ts` 的 `markRemoved` 只由 `recordRemoved` 调用，而 `recordRemoved` 只在 `executeLabelPlan` 删成功后调用，`github/executor.ts:341-347`）；③veto 是否被 v2 消费 —— `writeback/v21/execute.ts:205-233` 的入参里没有 `humanVetoed`，`webhook-v21.ts:696-709` 的 `executeV21` 调用同样没有。因此「AC-15 成立」是巧合，「与 BR-11 冲突」是事实。

### AC-16
- **状态**：已实现
- **证据**：
  - 只有「产出合规 + 通过校验」才执行写动作：`apps/server/src/worker/run-task.ts:1160-1172`（`v21Plan` 只在 probe ok 时赋值）、`:1340-1420`（执行块以 `v21Plan !== null` 为前提，且 `executeV21` 先整份校验、失败一条都不执行 —— `writeback/v21/execute.ts:416-452`）。
  - 超时不写回：`:1243` 起「兜底回复」要求 `terminal === 'turn.completed'`，否则 `blocked = 'turn 未正常收尾'` → 只 `appendEvent('writeback.fallback-skipped')`（`:1255-1263`）；v2 分支一律不发兜底评论（`:1241-1243`）。
  - 超时路径本身：`apps/server/src/runtime/turn-driver.ts:499-523` — `turn/interrupt` → `session/archive`，不涉及任何 GitHub 写。
  - `dry_run` 默认 `true`：`apps/server/src/app/config.ts:115`、`apps/server/src/config/repo-config.ts:242`、`apps/server/src/db/schema.ts:152`（`boolean('dry_run').notNull().default(true)`），且 `webhook.ts:1241` 用 `policy.dryRun || forcedDryRun` 合成最终值。
- **判定依据**：超时 = `terminal !== 'turn.completed'` → 无合规产出 → 既不执行 `label`/`comment`，也不走兜底评论；唯一的外部副作用是回执 reaction（`webhook-v21.ts:1057-1067`，且 dry-run 下也不打）。因此标签与评论保持执行前状态。默认 `dry_run=true` 进一步保证开箱即零副作用。
- **反证过程**：假设超时后仍有写入，可能的漏口四个：①部分执行（执行器边解析边写）—— `execute.ts:416-452` 是「先全量校验、后逐条执行」，且 `stoppedAt` 语义在 `execute.ts` 头部注释里；②兜底评论在超时后仍发 —— `run-task.ts:1255-1263` 明确挡掉；③标签在失败时被「恢复原状」而误删 —— 没有任何回滚/复原代码路径；④dry-run 下仍打 reaction / 仍写 `actions` —— `webhook-v21.ts:1057` 与 `run-task.ts:1427`（`if (!dryRun)` 才 `recordAction`）都排除。四条都不成立。

### AC-17
- **状态**：已实现
- **证据**：`apps/server/src/trigger/mention.ts:50-58` — 分隔符是白名单标点集合，**不含任何中文字符**；`:70-75` — 空串（结尾）或 `\s` 或白名单标点才算分隔符；`:115-117` — 关键词后不是分隔符就 `continue`（不命中）；`:134-161` — 一次评论只取**最早**的合法命中。
- **判定依据**：`@pi-bot帮我看看`：关键词 `pi-bot` 之后是 `帮`（既非空白也非白名单标点）→ `isMentionSeparator` 为 false → 该 `@` 不命中 → `findLegalMention` 返回 null → `require_mention` 闸门返回 `not-mentioned`（`decide.ts:181-187`）→ 不触发。`@pi-bot 帮我看看`：后接空格 → 命中 → 通过闸门继续判定。
- **反证过程**：假设「无分隔符也触发」，要检查的是分隔符判定的实现方向：如果写成「非字母数字即分隔符」（`/[^\w]/`），中文字符会被当成分隔符 → `@pi-bot你好` 会触发，正是需求点名要避免的误判。实际实现是白名单集合（`SEPARATOR_CHARS`，`:50-58`）而不是取反，`isMentionSeparator` 只认 `\s` 与集合成员（`:74`），因此中文不构成分隔符。另查「粘在别的标识符里」的分支：`:67` 的 `LEADING_FORBIDDEN` 与 `@pi-botx` 的冲突由「关键词必须最长优先 + 后接分隔符」两处共同挡住（`:96` 长度倒序、`:115` 分隔符判定）。

## 本节整体结论
17 条里只有 10 条能判「已实现（具备通过能力）」：AC-1、AC-4、AC-5、AC-6、AC-8、AC-11、AC-12、AC-14、AC-16、AC-17（其中 AC-1 仅在轮换与 attach 失败之外成立）。**本节整体不能判为已实现**：AC-2、AC-3、AC-9、AC-10 四条卡在「有写入、无读取出口」这同一个病根上（`decision_reason`、工具结果、按轮 token、模型中间正文），AC-7 的串行只是应用层近似，AC-13 的标签自动移除没有实现路径。AC-15 与需求正文 BR-11 正面冲突（AC-15 与 BR-11 在文档内部也互相矛盾），是最需要立刻拍板的一条：要么改 AC-15 的措辞，要么改 BR-11 并承认「人工删除即永久否决」。建议把「四个读取出口」当成一组整体排期——它们各自只差一个查询/契约字段，但缺一个，对应的验收就永远勾不上。

## 核查边界
- **是否执行了命令**：执行了只读检索（`git log -1`、`git status --short`、若干 `Select-String` 精确检索、`dir` 列目录）。**未执行**任何 `pnpm` 测试 / typecheck / lint，也未起 PG 或 Docker；本文所有测试相关表述都只声明「测试存在且断言具体」，未声明「跑过且绿」。
- **未覆盖的条目及原因**：无遗漏（AC-1~AC-17 逐条给出了结论）。但下列子条件需要运行环境才能定论，本文只给静态判断：AC-1 的「attach 成功率高到不会换 id」、AC-2 的「第二轮不再重复询问」、AC-7 的「真实并发下无交错」、AC-10 的「`deps.usage(turnId)` 在真 host 上确实返回非空」。
- **发现的额外问题**（不属本节范围，仅记录）：
  1. `apps/server/src/worker/run-task.ts:1181` / `:1416` 给 v2 的 `envelopes.usage` 写死 `null`，而契约 `packages/contract/src/api.ts:300-302` 把它当必填对象、`queries/tasks.ts:335-341` 把 `null` 兜成 0 —— 面板上 v2 任务的 token 会稳定显示 0，与 `usage_costs` 里的真实值不一致（两份口径并存）。
  2. `apps/server/src/queries/tasks.ts:399-421` 只挑 `declared/actual/intersect/dropped/rejectedReason`，于是 v2 写的 `actions.audit.detail`（含「保留 [标签/missing-meaning]」这类原因）在动作列表里被吞掉，只留在 `run_events`。
  3. `apps/server/src/app/compose.ts:1149` 的 `currentLabels` 取自 `bot_labels` 台账而非 GitHub 现状，人工在 GitHub 上加/删标签不会被反映 → `remove` 会对已经不存在的标签发 `removeLabel`（可能 404 计失败），`add` 会漏掉「人删了又该加回」的场景。这是 AC-15 那条冲突的结构性原因。
  4. `apps/server/src/runtime/turn-driver.ts:214-221`：`systemPrompt` 只在 `session/create` 生效，`persistent` 复用的轮次里改系统提示词/技能注入不生效 —— 与 AC-12「改配置下一个事件立即生效」同类，但对象不同（AC-12 只说项目模板），建议单列一条核查。
  5. `apps/server/src/agent/dispatcher.ts:20-23` 自述缺少 `(repo, issue_number) WHERE status='running'` 的部分唯一索引；`agent/store.ts:120-122` 同样承认窗口 —— 与 AC-7 直接相关，修法是加索引，不是改注释。
