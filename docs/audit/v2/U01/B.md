# U01 2.1 目标 · B

## 结论速览

| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| G-1 | 部分实现 | 会话行与复用都在，但 30 轮 / 7 天会 archive 旧会话并换新会话（`compose.ts:450-463`、`1315-1317`），队列路径未传 `sessionEvent` 让这层防护失效（`compose.ts:1460-1464`），「历史可延续」被主动切断 |
| G-2 | 已实现 | 五个事件的开关 / 模板 / 附加条件全部来自 `repos.settings`，改配置即改行为；仅「条件种类」（标签命中、只认正文）是代码固定的枚举 |
| G-3 | 部分实现 | 「完整对话」缺失：`item.delta`（模型正文增量）明确不落库（`run-task.ts:972-977`），详情页 token 取的是 agent 自填恒 0 的信封 `usage`，issue 级累计 token 只在注释里存在 |
| G-4 | 部分实现 | 「平台给默认、项目覆盖、互不干扰」成立；但项目级 `settings.model` 与技能 `model` 无任何消费点（全仓 0 处读取），模型实际只能平台级决定 |

## 逐条

### G-1

- 状态：部分实现
- 反证过程：
  1. 先假设「同一 issue 会有多行会话」→ 查约束：`agent_sessions` 主键就是 `(repo, issue_number)`，一条 issue 只可能有一行，推翻失败（该假设不成立，说明方向正确）。
  2. 再假设「issue 关闭或重开时会删/归档会话」→ 遍历会话动作集合只有 `create` / `reuse` / `recycle-sandbox`，闭包里根本没有 delete/archive 取值；recycle 的 SQL 只改 `state` / `sandbox_id` / `closed_at`；webhook 侧权威写入同样只 INSERT/UPDATE；保留期清理只删 `run_events` 与 `webhook_deliveries`；全仓 grep 无 `delete from agent_sessions`。推翻失败。
  3. 假设「重开 issue 会新建会话」→ 纯函数第 3 条分支对 `issues.opened` 且已有会话返回 `reuse` + `keepSession:true`，只重建沙箱。推翻失败。
  4. 假设「同一 issue 的每次处理都 attach 同一个 RACP session」→ 这里反证成功：存在 30 轮 / 7 天轮换，轮换时先 `session/archive` 旧会话、再以不带 `sessionId` 的 persistent 计划新建，并把库里的 `session_id` 覆盖成新值（甚至置 `null`），旧 id 不再被任何列保存。
  5. 检查这条轮换在**真实执行路径**上是否被 v2.1 的口径挡住 → 挡住的条件是 `v21SessionEventActive===true`，它只在 `executeTask` 收到 `input.sessionEvent` 时置真；而队列 job 入口调用 `executeTask` 时只传 `taskId` / `attempt`，于是该标志恒为 `false`，轮换分支照常执行。反证成立。
  6. 最后假设「同一 issue 还会产生第二个会话」→ 非 agent 任务（`/命令`、`@提问`）返回 `session: undefined`，按默认 `ephemeral` 每次新建并在跑完归档，同一 issue 上确实并存过按命令的临时会话（与「一个 issue 只对应一个 agent 会话」不完全一致，但属于任务内会话，不计为主缺口）。
- 证据：
  - `apps/server/src/db/schema.ts:685` — `primaryKey({ columns: [t.repo, t.issueNumber] })`：一个 issue 最多一行会话。
  - `apps/server/src/agent/store.ts:156-163` — `saveSession` 是 `ON CONFLICT ("repo","issue_number") DO UPDATE`，会话字段只有一个写入口。
  - `apps/server/src/agent/session-state.ts:69` — `SESSION_ACTIONS = ['create','reuse','recycle-sandbox']`，没有 `end` / `archive` / `delete`。
  - `apps/server/src/agent/session-state.ts:133-142` — `issues.opened` 且已有会话 → `reuse` + `keepSession:true` + `rebuildSandbox:true`（重开复用）。
  - `apps/server/src/app/compose.ts:287-292` — `recycle` 只 `SET state='idle', sandbox_id=NULL, closed_at=now()`，不动 `session_id`。
  - `apps/server/src/http/webhook-v21.ts:829-852` — `applyV21SessionOnEvent` 只有 create/recycle/reuse 三条语句（权威写入点不删会话）。
  - `apps/server/src/jobs/retention-cleanup.ts:54-74` — 保留期只删 `run_events` 与 `webhook_deliveries`，`agent_sessions` / `agent_messages` 不在清理范围。
  - `apps/server/src/app/compose.ts:209-212` — `AGENT_SESSION_POLICY = { maxTurns: 30, maxAgeDays: 7 }`。
  - `apps/server/src/app/compose.ts:450-463` — `reason !== null` → 返回 `{ session:{mode:'persistent'}, rotate:true, archiveSessionId: sessionId }`（不带旧 id）。
  - `apps/server/src/app/compose.ts:1315-1317` — `if (!v21SessionEventActive && agentSession.archiveSessionId !== null) await channel.ops.sessionArchive(...)`：轮换等于归档旧会话。
  - `apps/server/src/app/compose.ts:1036-1042` — 轮换那轮 `turns` 从 1 起、`sessionId` 换成新值或置 `null`、`startedAt` 重设：旧会话 id 不落任何列。
  - `apps/server/src/app/compose.ts:1195-1207` — `v21SessionEventActive` 只在 `input.sessionEvent !== undefined` 时为 `true`。
  - `apps/server/src/app/compose.ts:1460-1464` — `onTaskJob` 调 `executeTask({ taskId, attempt })`，不传 `sessionEvent` → 上面那道防护在生产队列路径上不生效。
  - `apps/server/src/app/compose.ts:1044-1047` — 轮换时自记日志 `'agent 会话重置：上下文断了一次'`，即代码自己承认历史被切断。
- 缺口：①30 轮 / 7 天轮换会在同一 issue 上产生**先后多个** RACP 会话，且旧 `session_id` 被覆盖（不是「可回查的旧会话」），上下文不延续；②该轮换在队列 job 路径上未被 v2.1 语义挡住（`sessionEvent` 未传），所以不是「只在直连调用时才发生」的边角；③压缩（`createV21Compactor`）只暴露不调用，无法把旧会话历史带进新会话（`compose.ts:879-881`）。
- 判定依据：数据库层面「一个 issue 一行会话、关单只回收沙箱、重开复用」都有无争议证据，足以推翻「未实现」；但达成标志里的「同一 issue 的多次处理共享 session，历史可延续」被 30 轮 / 7 天的 `sessionArchive` + `session_id` 覆盖明确打破，属「主体在、明写子条件缺失」，故为部分实现（不是「与需求冲突」：v2.1 路径已刻意不 archive，冲突来自遗留的 v0.3 轮换分支仍在生产路径上跑）。

### G-2

- 状态：已实现
- 反证过程：
  1. 假设「事件是否触发写在代码里」→ 判定的第一道与第二道闸全部读 `repos.settings`：开关三态来自 `resolveEventTrigger`，`issues.edited` 的「只认正文」与 `issues.labeled` 的标签白名单来自同一 schema；评论四闸门（忽略机器人 / 关单是否允许 / 是否必须提及 / 是否限定角色）来自 `resolveCommentGates` 与 `resolveCommentConfig`。没有按事件名硬编码的 if 分支能绕过配置。推翻失败。
  2. 假设「用哪套提示词写在代码里」→ 每个事件有 `prompt` 字段（`null` = 用内置默认），未触发时不给模板；渲染前把「项目模板」与「内置默认」收敛成同一字符串再走同一个 `renderTemplateAsync`，不存在两套渲染器。系统提示词另有 `agent.system_prompt`（非空优先，否则 `agent.limits.system_prompt`，再否则内置身份）。推翻失败。
  3. 假设「改配置要重启或改代码」→ 每条投递都重新 `readRepoPolicy` 读库（不是启动期快照）；每轮任务都重新读 `policy.settings` 与仓库技能快照。推翻失败。
  4. 主动找反例：PR 事件永远 `pr-ignored`，不可配 → 但需求 §2.2 明写「本期不处理 PR 事件」，是约定而非缺口；`issues.labeled` 的条件只能是「标签名命中」、`issues.edited` 只有一个布尔 `only_body_changed`，条件**种类**是代码固定枚举，但需求只要求「是否触发」可配，故不构成冲突。
  5. 技能层是否也算「提示词的一部分」→ 内置技能正文随二进制发布，但同名可被仓库上传的技能覆盖（注册表有 `builtin-overridden` 语义），仓库还可关掉项目技能目录扫描。属配置可掌控的范围。
- 证据：
  - `packages/contract/src/settings-v21.ts:81-91` — `eventTriggerSchema`：`enabled`（on/off/conditional）、`prompt`（模板）、`only_body_changed`、`labels`。
  - `packages/contract/src/settings-v21.ts:328-332` — 五个事件的默认开关逐条给出（`issues.closed` 默认 off、`issue_comment.created` 默认 conditional）。
  - `packages/contract/src/settings-v21.ts:105-118` — `commentGatesSchema`：`require_mention` / `require_role` / `allow_roles` / `ignore_bot` / `allow_closed`。
  - `apps/server/src/trigger/decide.ts:226-229` — 判定第二道读 `resolveEventTrigger(settings, event)`，`enabled==='off'` 直接不触发。
  - `apps/server/src/trigger/decide.ts:141-164` — 事件附加条件全部来自 `trigger`（配置）而非事件类型常量。
  - `apps/server/src/trigger/decide.ts:173-201` — 评论四闸门读 `resolveCommentGates` / `resolveCommentConfig`。
  - `apps/server/src/trigger/decide.ts:255-258` — 模板取自 `trigger.prompt`，空白回落内置默认；`:260-265` 返回 `template`。
  - `apps/server/src/config/v21-settings.ts:105` / `:200-209` — `resolveEventTrigger` 与 `resolveAgentExecution`（系统提示词三级回落）。
  - `apps/server/src/app/compose.ts:1407` — `systemPrompt: resolveAgentExecution(policy.settings).system_prompt`：系统提示词进执行面。
  - `apps/server/src/http/webhook-v21.ts:359-361`、`:464`、`:1016-1017` — 项目模板与内置默认收敛为同一 `template` 再渲染，渲染结果进 `agent_messages` 正文。
  - `apps/server/src/http/webhook.ts:1164` — 每条投递重新 `readRepoPolicy(deps.db, repo)`：改配置无需重启、无需改代码。
  - `apps/server/src/http/webhook.ts:1236-1239` — 触发别名 `configured: policy.settings?.triggers` 覆盖部署默认。
- 缺口：无明显缺口。限制（非缺口）：可配的「附加条件」只有 `only_body_changed` 与标签白名单两种，新增条件种类要改代码；PR 事件固定忽略（需求明写的非目标）。
- 判定依据：五类事件的触发判定、模板、闸门、系统提示词、项目补充提示词与触发别名全部由 `repos.settings` 驱动，且读配置发生在每次投递 / 每轮任务上，「改配置即可改变行为」有代码证据支撑，未找到需要改代码才能改行为的触发分支。

### G-3

- 状态：部分实现
- 反证过程：
  1. 假设「只有表里有列、没有查询出口」→ 逐个找出入口：issue 会话接口返回 turns + 每轮 toolCalls；任务详情接口返回 runs / events / envelopes / actions / diff。推翻失败（出口存在）。
  2. 假设「完整对话可查」→ 这里反证成功：人类轮正文取 `webhook_deliveries.payload.comment.body`（无评论时回退 `tasks.prompt_text`），机器人轮正文取最终评论正文；而模型正文的流式增量 `item.delta` 被**明确排除**在落库之外，注释写明「审计与面板不需要」。也就是说中间回复、被模型丢弃的草稿、每次工具调用的完整输入输出都不在库里。
  3. 再假设「历史永久可查」→ 反证成功：事件流上限 500 条（契约），且 `run_events` 与 `webhook_deliveries` 都按 90 天分批删除；90 天后人类轮原文与事件流消失（`prompt_text` 只能兜住 agent 消息正文，评论原文与 issue 标题/状态降级）。
  4. 假设「每次工具调用都可查」→ 部分成立：按 `toolCallId` 把 `item.started` / `tool.progress` / `item.completed` 归并成一条（名字只在 started 里有），但每轮上限 50 条、摘要压到 160–200 字，参数与输出都做了压缩，超出置 `truncated`。
  5. 假设「token 消耗可查」→ 部分成立：真实 token 落在 `usage_costs`（来源是 pi-host 自己的 sqlite `turns` 表），成本页有汇总与 top 任务；但任务详情展示的 per-envelope token 读的是信封 `usage`，而 worker 注释明说信封 `usage` 是 agent 自填、实测恒 0；issue 会话契约里根本没有 token 字段，面板 issue 详情头部「累计 token」只存在于注释里。
- 证据：
  - `apps/server/src/db/schema.ts:296-314` — `run_events`（`run_id` + `cursor` 唯一、`kind`、`payload`）：事件流落库是「过程可查」的骨架。
  - `apps/server/src/db/schema.ts:452-467` — `usage_costs`（`input_tokens` / `output_tokens` / `cost_usd`，按 `run_id`、`model+created_at` 建索引）。
  - `apps/server/src/worker/run-task.ts:972-977` — `if (event.kind !== 'item.delta') appendEvent(...)`：正文增量**不落库**（注释给的理由是怕把 500 条上限吃光）。
  - `apps/server/src/worker/run-task.ts:1591-1607` — 真实用量从 pi-host 读（不信信封），写 `recordUsage`。
  - `apps/server/src/cost/host-usage.ts:1-16`、`:64-86` — 只读打开 `pi.sqlite` 的 `turns` 表取 `input_tokens` / `output_tokens` / `cacheReadTokens` / `model_id`。
  - `apps/server/src/queries/issues.ts:922-991` — 工具调用按 `toolCallId` 归并后进 issue 会话（`TOOL_CALL_LIMIT=50`，参数按 `command/path/...` 优先级取一条）。
  - `packages/contract/src/api.ts:908-919`、`:958` — `issueToolCallSchema`（name/summary/at/ok，摘要 ≤200）、每轮 `toolCalls` ≤50 且带 `truncated`。
  - `apps/server/src/queries/issues.ts:637-655`、`:777-780` — 人类轮正文来自 `webhook_deliveries` 的 `comment.body`，无则回退 `prompt_text`。
  - `apps/server/src/queries/issues.ts:715-738` — 机器人轮正文取信封/评论正文，多次 attempt 合并成一轮。
  - `apps/server/src/jobs/retention-cleanup.ts:24-25`、`:54-74` — `RETENTION_DAYS = 90`，删 `run_events` 与 `webhook_deliveries`。
  - `packages/contract/src/api.ts:363-376` — 任务详情：`events` ≤500、`runs` ≤20、`actions` ≤100。
  - `packages/contract/src/api.ts:300-303` + `apps/server/src/queries/tasks.ts:335-340` — 信封 `usage` 直接取自 `envelopes.usage`（agent 自填）。
  - `apps/panel/src/routes/task-detail.tsx:289` — 详情页 token 显示的就是上面那个信封 `usage`。
  - `apps/panel/src/routes/issue-detail.tsx:33` 对比 `:198-217` — 注释写「会话 id / 轮次 / 累计 token」，实际头部只渲染 Issue / 轮次 / 人类 / 机器人，没有 token。
  - `packages/contract/src/api.ts:931-963` — `issueTurnSchema` 无 token/用量字段（issue 级 token 无出口）。
  - `apps/panel/src/routes/costs.tsx:170-171`、`:202`、`:250` — 真实 token 只在成本页（总量 + 按桶 + 最贵任务）可见。
- 缺口：①「完整对话」不成立：`item.delta`（模型正文增量）不落库，中间回复与工具完整输入输出都查不到；②事件流与投递原文 90 天后删除、单次任务事件上限 500 条，「全过程」有时间窗与条数截断；③面板任务详情的 token 是信封自填值（实测恒 0）而不是 `usage_costs` 真值，issue 级累计 token 契约里没有字段、面板也没渲染。
- 判定依据：三个子项里「每次工具调用」有明确出口（有上限与摘要压缩），「token 消耗」有真实账（成本页）但详情页取错来源，「完整对话」被代码主动排除在落库之外 —— 主体结构在、明写子条件缺一项半，故为部分实现。

### G-4

- 状态：部分实现
- 反证过程：
  1. 假设「没有平台级默认」→ 有：`PI_BOT_DEFAULT_SETTINGS`（内联 JSON 或文件），未设置时退回契约形状默认。推翻失败。
  2. 假设「项目级不能覆盖」→ 能：每仓库一份 `repos.settings`（jsonb），写入口是 `PUT /api/repos/:owner/:name/settings`，非法配置不写库、回给面板 400，last-known-good 继续生效。推翻失败。
  3. 假设「平台默认改动会自动下发到已有仓库」→ 反证成功：默认 settings 只在**建行时**写入，冲突不覆盖，所以平台默认变化对存量仓库无影响（单据化的快照语义）。
  4. 假设「项目级能覆盖平台级给的东西」→ 反证成功：契约里有 `settings.model`（注释还写「技能可以覆盖」）与技能级 `model`，但全仓没有任何读取点；模型端点只经 `hostModelEnv(config)` 从平台 env 灌给 pi-host，RACP `session/create` 也没有模型参数。即模型只能平台级决定，项目级那条覆盖字段是死的。
  5. 假设「仓库之间有共享状态会串」→ 逐条查边界：未知仓库 / 安装不匹配直接忽略（不建任务）；每仓库并发上限独立（默认 2，全局 3，吵的仓库最多占两槽）；技能按仓库作用域读；配置写入按仓库校验；会话、标签、配额、反馈都按 `repo` 作键。未找到跨仓库共享的可变业务状态（Host 进程与镜像属平台资源，符合设计）。
- 证据：
  - `apps/server/src/config/repo-config.ts:30-42`、`:99-101` — 平台级默认 settings（`PI_BOT_DEFAULT_SETTINGS`，未设则契约默认），进程内缓存一次。
  - `apps/server/src/config/repo-config.ts:255-292` — `readRepoPolicy` 按仓库读 `repos.settings` 并解析；解析失败 = 该仓库不可用（`settings: null`）。
  - `apps/server/src/config/repo-config.ts:238-252` — 没有 `repos` 行 → `UNKNOWN_REPO_POLICY`（`enabled:false`）：未知仓库一律不开工。
  - `apps/server/src/config/repo-config.ts:388-407` — 建行时用部署默认；**冲突时不覆盖**（`only writes settings on insert`）——平台默认是快照，不随平台改动下发。
  - `apps/server/src/http/api/index.ts:318-341` — `PUT /api/repos/:owner/:name/settings`：按仓库写，`updateRepoSettings` 失败即 400 且不写库。
  - `packages/contract/src/repo-config.ts:219-237` — 项目级可配段：`model` / `triggers` / `skills` / `limits` / `agent`。
  - `apps/server/src/queue/repo-concurrency.ts:1-18`、`:30-43` — 全局并发 3、仓库级默认 2，按 `repos.settings.limits.concurrency_per_repo` 分组限流（隔离的硬边界）。
  - `apps/server/src/http/webhook.ts:1172-1189` — 未知仓库 / installation 不匹配 → `ignored`，不建任务（错仓库不会用错 token 干活）。
  - `apps/server/src/app/compose.ts:1146` — 技能快照按 `row.repo` 读（`skillStore.activeSkillFiles(row.repo)`）。
  - `apps/server/src/app/model-env.ts:36-51` — 模型 key / base URL / 模型名只从平台 `config.model` 生成 pi-host 环境变量。
  - `apps/server/src/app/compose.ts:599-601` — `extraEnv: hostModelEnv(config)`：执行面拿到的模型只来自平台配置。
  - `packages/contract/src/repo-config.ts:220` 与 `packages/contract/src/skills.ts:115-116` — 声明了项目级 / 技能级 `model`，但 `settings.model` 全仓 0 处读取（检索 `settings.model` / `config.model?.` 无命中），执行面也没有模型参数。
- 缺口：①项目级模型覆盖是死字段（契约声明、无消费点），「项目级可覆盖」在模型这一项上不成立；②平台默认只在建行时快照，之后平台改默认不对存量仓库生效（要让所有仓库跟进必须逐仓库写配置）。
- 判定依据：「平台级给默认 + 项目级覆盖 + 不同仓库互不干扰」三条骨架都有无争议代码证据（默认源、每仓库 jsonb、按仓库限流/技能/写入闸门、未知仓库忽略）；但存在一个被声明却完全没接线的项目级覆盖字段（模型），属「主体在、某个明写子条件缺失」，故为部分实现。

## 本节整体结论

四条目标的主体结构都真实存在，不是纸面承诺：会话表用 `(repo, issue_number)` 做主键且没有任何删除/归档路径，触发判定与提示词模板全部由 `repos.settings` 驱动，过程数据有 `run_events` / `usage_costs` 两条出口，多仓库靠每仓库一份 settings 加仓库级限流隔离。四处缺口都在「达成标志的后半句」上：G-1 被遗留的 30 轮 / 7 天会话轮换切断历史（且队列路径没传 `sessionEvent`，v2.1 的「永不 archive」没挡住它）；G-3 把模型正文增量主动排除在落库之外，详情页 token 又取了 agent 自填的恒 0 信封值；G-4 的项目级 `model` 覆盖字段无人读取。这些缺口都不是「没做」而是「做了另一套口径」，其中 G-1 的轮换与需求原文直接相反，是本节最需要收口的一条。G-2 未发现缺口。

## 核查边界

- 是否执行了命令：是。只执行只读检索（`git status --short`、`git log --oneline`、`Get-ChildItem` 列文件、`Select-String` 检索、`Get-Content` 读片段），未运行测试、未启动服务、未连接数据库、未修改任何既有文件（除本文件）。`git status` 显示工作区有他人未提交改动，本次核查未触碰。
- 未覆盖的条目及原因：无遗漏条目（G-1 ~ G-4 均逐条核查）。但以下几点**未经验证、需运行环境才能确认**，不计入任一结论：①pi-host 侧 `session/attach` 对同一 `session_id` 的实际复用效果（需真 Host）；②90 天保留期清理在真库上的执行节奏（需真 PG + cron）；③真实 provider 返回的 token 与 `usage_costs` 是否逐轮对齐（需真实跑一轮）。
