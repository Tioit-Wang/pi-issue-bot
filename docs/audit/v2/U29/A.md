# U29 12 附录 · 术语 · A

> 核查范围：docs/requirements.html 行 1951-1974
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览

| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| TERM-1 事件 | 已实现 | — |
| TERM-2 触发 | 已实现 | — |
| TERM-3 会话 | 与需求冲突 | 轮换（30 轮 / 7 天）时调 `session/archive` 归档旧会话并换掉 `session_id`，与「不归档、没有结束状态」相反 |
| TERM-4 轮次 | 已实现 | — |
| TERM-5 模板 | 已实现 | —（配置字段叫 `prompt`、运行时叫 `template`，两处同名异写但同源） |
| TERM-6 占位符 | 已实现 | — |
| TERM-7 闸门 | 部分实现 | 需求定义的「闸门」没有唯一名字：同词另指排队超时闸门与 git 推送集闸门 |
| TERM-8 写回 | 已实现 | — |
| TERM-9 目标态 | 已实现 | — |
| TERM-10 标签目录 | 部分实现 | 缺「与 GitHub 仓库保持一致」：`status:'retired'` 只读不写，无任何标签同步作业 |
| TERM-11 槽位 | 已实现 | — |
| TERM-12 提及关键词 | 部分实现 | 两套并存：`comment.mentions`（闸门用）与 `triggers.aliases`（仍被解析并用于摘正文 `@`） |
| TERM-13 角色清单 | 已实现 | — |

## 逐条

### TERM-1 事件
- **状态**：已实现
- **证据**：
  - `packages/contract/src/settings-v21.ts:56` — `EVENT_KEYS` 五个键全部是「类型.动作」形态：`issues.opened` / `issues.edited` / `issues.labeled` / `issues.closed` / `issue_comment.created`；`:66` `eventKeySchema = z.enum(EVENT_KEYS)` 是唯一可落库/可进配置的取值集。
  - `apps/server/src/http/webhook-v21.ts:85` — `v21EventKeyOf(event, action)`：入参就是「`X-GitHub-Event` + `payload.action`」，两者**共同**决定事件键（`event === 'issues'` 时按 `action` 分支，`:94-105`；`issue_comment` 只认 `created`，`:90-92`）。动作不在五键内时返回 `null`（`:104`、`:107`），不猜。
  - `apps/server/src/trigger/decide.ts:100` — `DecideEventInput` 把 `event: EventKey` 与 `action: string` 分列；`:102` 注释与用法一致：`action` 只随判定留痕，判定本身按 `EventKey` 分支。
  - `apps/server/src/trigger/decide.ts:63` — 非 issue 域用单独的字面量键 `'pull_request.*'`，不与五键混在一张表里。
- **缺口**：无。
- **判定依据**：需求定义「事件类型 + 动作共同确定」在代码里是一条可核对的函数（`v21EventKeyOf`），产物 `EventKey` 是可枚举字面量联合，配置、判定、留痕三处都用同一个类型；`pull_request.*` 的处置（只留痕、不建会话）也在同一处收口。有字段且有执行路径，故为已实现。

### TERM-2 触发
- **状态**：已实现
- **证据**：
  - `apps/server/src/trigger/decide.ts:209` — `decideEvent()` 是唯一判定入口，返回 `TriggerDecision`；`:53-59` 触发侧形状 `{ triggered: true, event, template, reason }`，`reason` 只有 `'enabled' | 'conditional-met'`（`:28`）。
  - `apps/server/src/trigger/decide.ts:225` — 开关判定：`trigger.enabled === 'off'` → `skip(..., 'switch-off')`，且注释与实现一致地「闸门一律不生效」；`:237-243` 闸门只在 `issue_comment.created` 上跑。
  - `packages/contract/src/settings-v21.ts:69` — `EVENT_SWITCHES = ['on','off','conditional']` 三态；`apps/server/src/config/v21-settings.ts:105` `resolveEventTrigger()` 把 `repos.settings` 摊成 `enabled/prompt/onlyBodyChanged/labels`。
  - `apps/server/src/http/webhook-v21.ts:188` — `v21DecisionRowOf()` 把结论落成 `decision: 'triggered' | 'ignored'` + `reason`，即「被允许进入处理」这一事实有持久化落点。
- **缺口**：无。
- **判定依据**：需求把「触发」定义为「通过开关与闸门判断、被允许进入处理」，代码同时具备判定纯函数、开关三态、闸门顺序与落库列，且 `triggered` 的语义与文档完全一致。遗留的 v0.3 别名解析（`packages/contract/src/trigger.ts:171 parseTriggerBody`）只出现在 `apps/server/src/http/webhook.ts:215/491/593` 的旧判定路径，注入 v2.1 后其结论被丢弃（`apps/server/src/http/webhook.ts:1260-1286` 先走 v2.1 分支），因此不构成「触发」的第二个语义。

### TERM-3 会话
- **状态**：与需求冲突
- **证据（符合部分）**：
  - `apps/server/src/agent/session-state.ts:19` — `SESSION_STATES = ['active','idle']`；`:69` `SESSION_ACTIONS = ['create','reuse','recycle-sandbox']`，注释明写「没有 `end` / `archive` / `delete`」；`:167` 类型守卫只认这两个值。
  - `apps/server/src/db/schema.ts:655` — 主键 `(repo, issue_number)`，「一个 issue 一行」即需求要的映射；`:673` 注释「**没有 `ended`**」；`:689-694` `AGENT_SESSION_STATE` 只有 `active` / `idle`。
  - `apps/server/src/http/webhook.ts:1212` — `applyV21SessionOnEvent()` 是会话状态的权威写入点，只 INSERT/UPDATE（`apps/server/src/app/compose.ts:280-293` 的三条 SQL 无 DELETE）。
- **证据（反着来的那一行）**：
  - `apps/server/src/app/compose.ts:1315-1317` — `if (!v21SessionEventActive && agentSession.archiveSessionId !== null) { await channel.ops.sessionArchive({ sessionId: ... }) }`：当轮换触发时**真的调用 RACP 归档**旧会话。
  - `apps/server/src/app/compose.ts:1040` — 轮换那一轮把 `agent_sessions.session_id` 换成新 id（或在拿不到新 id 时置 `NULL`），`:1036` 同时把 `turns` 重置为 1、`:1042` 重置 `started_at`。
  - `apps/server/src/app/compose.ts:209-212` — 轮换阈值为系统常量 `maxTurns: 30` / `maxAgeDays: 7`；`apps/server/src/app/compose.ts:1228` 每次任务都调 `planAgentSession()`，`:450-463` 命中阈值即返回 `rotate: true` + `archiveSessionId`。
  - 可达性：生产队列路径 `onTaskJob` 只传 `{ taskId, attempt }`（`apps/server/src/app/compose.ts:1460-1464`），不含 `sessionEvent`，而 `v21SessionEventActive` 只在 `input.sessionEvent !== undefined` 时才为真（`:1196`），因此该归档分支在正常队列执行中**是活的**，不是死代码。
- **缺口**：需求「会话与该 issue 同生命周期：创建后一直有效，不归档、不释放映射」「会话**没有「结束」这个状态**」（docs/requirements.html 行 888-890）被轮换逻辑破坏。具体缺：会话 id 只能有一个、且不得归档。影响：第 31 轮（或第 8 天）后 RACP 侧旧会话被归档、`session_id` 被替换，agent 失去跨事件历史上下文——正是需求「任何归档动作都会让重开的 issue 失去上下文」（行 888）要排除的情形；同时与 `docs/requirements.html:1063`「不应强行开新会话」相反。
- **判定依据**：状态机本身（active/idle、不删行）与文档一致，但「不归档」这条子条件是需求明写的硬约束，代码在 `compose.ts:1315-1317` 存在真实的归档调用，且该路径在队列执行中可达——属于「需求写不归档、代码有 archive 分支」的冲突型，不是部分缺失。

### TERM-4 轮次
- **状态**：已实现
- **证据**：
  - `apps/server/src/runtime/turn-driver.ts:326` — `driveTurn()` 是「一条提示词 → 一次完整执行」的唯一驱动；`:8` 协议注释写明第 4 步 `turn/start { input.text: <任务提示词> }` 返回 `turnId`，`:402` 真实取 `turn.id`，`:179` 结果带 `turnId`。
  - `apps/server/src/runtime/turn-driver.ts:623` — `isTurnTimeout()` 把「单轮超时」判成轮次级事实（与句柄超时区分）。
  - `apps/server/src/db/schema.ts:669` — `agent_sessions.turns` = 该会话已用轮数，由装配层按轮累加（`apps/server/src/app/compose.ts:1036`）。
  - `apps/server/src/runtime/turn-driver.ts:467-469` — 异常收尾按 `{ sessionId, turnId }` 定位中断，说明「轮」是有 id 的一等对象。
- **缺口**：无。
- **判定依据**：需求「会话内的一次完整执行，由一条提示词驱动」在代码里就是 `driveTurn(turn/start)` + `turnId` + `turns` 计数，三处同名（turn / 轮次），无第二种叫法。

### TERM-5 模板
- **状态**：已实现
- **证据**：
  - `packages/contract/src/settings-v21.ts:85` — 每个事件的配置项 `prompt: z.string().max(EVENT_PROMPT_MAX_CHARS).nullable().default(null)`，`null` = 用内置默认（不是空模板）；`:81-91` 该字段与开关、附加条件同属「项目配置里的事件提示词」。
  - `packages/contract/src/settings-v21.ts:473` — `DEFAULT_EVENT_TEMPLATES` 五个事件各一份内置默认；`:552` `defaultEventTemplate(event)`。
  - `apps/server/src/trigger/decide.ts:257` — 触发时选模板：`trigger.prompt` 去空白后为空则回落到内置默认，产物字段名就叫 `template`（`:57`）。
  - `apps/server/src/http/webhook-v21.ts:464` — `const template = input.decidedTemplate ?? v21TemplateOf(...)`，随后 `:476` 渲染；`:512` 渲染结果即「发给 agent 的指令」。
- **缺口**：无。
- **判定依据**：需求定义「项目配置里的事件提示词，含占位符，触发时渲染成实际指令」三段全部可核：配置项在 `triggers.events[*].prompt`（需求 §6.6 的 YAML 示例同样用 `prompt`，见 docs/requirements.html 行 1566/1574/1583，故字段命名与文档一致），含占位符（TERM-6 已核），触发时渲染（`webhook-v21.ts:464-476`）。代码在运行时把该值称 `template`、在配置里称 `prompt`，属同源两称，不影响「已实现」判定，但记入术语一致性备注。

### TERM-6 占位符
- **状态**：已实现
- **证据**：
  - `packages/contract/src/settings-v21.ts:420-433` — `PROMPT_PLACEHOLDERS` 12 项，含需求举例的 `issue.author`；`:446` `PLACEHOLDER_NAMES`；`:458` `placeholderToken()` 拼 `{{name}}`。
  - `apps/server/src/prompt/render.ts:90` — 语法正则 `/\{\{([a-zA-Z0-9_.]+)\}\}/gu`；`:132-161` 逐名取值，`comment.*` 在非评论事件渲染空串、未知名字返回 `null`。
  - `apps/server/src/prompt/render.ts:173-183` — 单次 `replace` 一次遍历：替换进去的值不会被二次扫描（需求「重复占位符全部替换」+「不二次替换」），未知占位符 `return match` 原样保留并收集进 `unknown`。
  - `apps/server/src/http/webhook-v21.ts:495-503` — 未知占位符 → `reportV21UnknownPlaceholders()` 告警，证明「原样保留」有消费方。
- **缺口**：无。
- **判定依据**：需求「模板中形如 `{{issue.author}}` 的变量，渲染时替换为真实值」在代码里是同一个正则 + 一张 12 项清单 + 一次遍历替换，且有未知占位符的显式留痕路径（非死字段）。

### TERM-7 闸门
- **状态**：部分实现
- **证据（需求语义已实现）**：
  - `packages/contract/src/settings-v21.ts:105-120` — `commentGatesSchema` 五项：`require_mention` / `require_role` / `allow_roles` / `ignore_bot` / `allow_closed`，且整段挂在评论事件的配置下（`:304-312` `commentEventTriggerSchema.gates`）。
  - `apps/server/src/config/v21-settings.ts:132` — `resolveCommentGates()` 只从 `triggers.events['issue_comment.created'].gates` 取值。
  - `apps/server/src/trigger/decide.ts:173` — `checkCommentGates()` 按 `ignore_bot → allow_closed → require_mention → require_role` 固定顺序判，先命中先返回（`:175-199`）；`:238` 仅当 `event === 'issue_comment.created'` 才调用。
  - `apps/server/src/trigger/roles.ts:69` / `apps/server/src/trigger/mention.ts:134` — 闸门引用的两个判定都是纯函数，可单测。
- **缺口**：缺的是「同一个词只有一个意思」。全仓 `gate` 承载三种互不相干的判定，需求定义的只是第一种：
  1. 评论闸门（本术语）：`gates` / `CommentGates` / `checkCommentGates`；
  2. **排队**闸门：`apps/server/src/queue/queue-gate.ts:1-9`（排队超时 → `cancelled_queue`），且是活的定时作业（`apps/server/src/jobs/index.ts:108` 注册、`apps/server/src/queue/definitions.ts:191-196` 每分钟跑）；
  3. **写回**闸门：`apps/server/src/git/writeback-gate.ts:1-4`（推送集 = `declared ∩ actual`），同样活着（`apps/server/src/git/index.ts:81` 导出 `runWriteback`）。
  影响：按术语表搜索「闸门 / gate」会同时命中三处，读者无法从命名判断指的是「评论事件附加条件」。实测 `apps/server/src/trigger/decide.ts:12` 的判定顺序注释里「闸门」指的是第 1 种，而 `apps/server/src/runtime/approval-policy.ts:24` 的「写回闸门」注释指的是第 3 种——同一文件族内已出现两种指代。
- **判定依据**：需求语义（评论事件特有的附加判断条件）有完整、单一、可执行的实现，因此不是「未实现」；但术语表本身要求「统一口径，避免同一概念多种叫法」，而代码反向出现「同一叫法三种概念」，故判部分实现。附带确认一点：审批（approval）与闸门**未**混用——`apps/server/src/runtime/approval-policy.ts:59` 用 `ApprovalOutcome/APPROVAL_RULES/ApprovalAudit` 一整套独立命名。

### TERM-8 写回
- **状态**：已实现
- **证据**：
  - `packages/contract/src/settings-v21.ts:215-221` — `agentActionsSchema`：`create_issue` / `open_pr` / `close_issue` **默认全 `false`**，即需求「后三类默认关闭，需项目显式开启」。
  - `apps/server/src/writeback/v21/execute.ts:390-404` — `preflightSwitches()` 在动手前扫一遍开关，未开则**整份拒绝**（`ERROR_ACTION_DISABLED`），不是跳过单条。
  - `apps/server/src/writeback/v21/execute.ts:467-489` — 动作分派覆盖需求点名的五类（`comment` / `label` / `create_issue` / `open_pr` / `close_issue`）以及 `verdict` / `reaction` / `reopen_issue` / `update_issue` / `update_comment` / `delete_comment` / `link`（超集，不冲突）。
  - `apps/server/src/worker/run-task.ts:1297` — 注释与实线一致：v2 七类动作由 `executeV21()` 执行；`:1378` 直连路径真实调用；装配路径见 `apps/server/src/app/compose.ts:836` `createV21Executor`。
  - `apps/server/src/writeback/v21/execute.ts:549-556` — 标签写回真的落到 GitHub：`api.addLabels(...)` / `api.removeLabel(...)`；端口实现在 `:1187-1188`。
- **缺口**：无。
- **判定依据**：五类写回动作均有「开关 → 校验 → 调 GitHub 端口」的完整执行链，且默认关闭这条子条件可在 schema 默认值与被拒绝路径两处核对。代码另有一层 `apps/server/src/git/writeback.ts:77` `runWriteback()`（分支推送），与需求 FR-5.3 把 `push_branch` 也计入写回动作一致（docs/requirements.html 行 1179），不构成同名异义。

### TERM-9 目标态
- **状态**：已实现
- **证据**：
  - `apps/server/src/writeback/v21/labels.ts:135` — `planLabelTargetState()`：入参 `desired` 是**完整期望集合**，函数自己算差集。
  - `apps/server/src/writeback/v21/labels.ts:183` — `add = desired − current`；`:184-197` `remove = current ∩ 可管理目录 − desired`，即需求「多的删、少的加」。
  - `apps/server/src/writeback/v21/labels.ts:140-147` — 空集保护：`desired` 空且 `clear !== true` → 整条拒绝（`empty-without-clear`）。
  - `apps/server/src/writeback/v21/execute.ts:515-521` — `runLabel()` 从产出 `payload.desired` 直接喂给 `planLabelTargetState`，`:519-525` 组装 `current` / `catalog` / `maxPerIssue`；`:549-556` 执行。
- **缺口**：无。
- **判定依据**：「执行侧给完整集合、平台与当前对齐」既有纯函数（可逐格断言 add/remove），也有真实执行路径（`execute.ts:549-556` 调 GitHub 端口），不是只有类型定义。

### TERM-10 标签目录
- **状态**：部分实现
- **证据（已实现的一半）**：
  - `packages/contract/src/settings-v21.ts:275-292` — `labelCatalogEntryV21Schema`：`name` + `meaning` + `group` + `color` + `managed` + `status`，即「语义（含义、分组）由平台侧补充」的落点。
  - `apps/server/src/config/v21-settings.ts:249` — `resolveManagedCatalog()` 返回**全部**条目（含 `retired` / `managed=false`），`:251-258` 补齐默认值。
  - `apps/server/src/writeback/v21/labels.ts:83-84` — `isManageableCatalogEntry()` 用 `managed` + `status` + `meaning` 三条件界定「可自动对齐集合」；`:98` `retired` → 跳过（`LabelSkipReason = 'retired'`，`:25`）。
  - `apps/server/src/skills/prompt.ts:717` — 目录按项目渲染进提示词（`renderLabelVocabulary`），有消费方。
- **缺口**：缺「身份与 GitHub 仓库一致」这一子条件，两个方向都没有实现路径：
  1. `status: 'retired'` 在全仓**只有读**（`apps/server/src/writeback/v21/labels.ts:98`、`apps/server/src/config/v21-settings.ts:240` 注释），没有任何代码把它写成 `retired`——仓库侧删了标签，目录不会知道；
  2. 定时作业表里没有标签同步作业：`apps/server/src/jobs/index.ts:106-115` 只有 `queue-gate` / `metrics-rollup` / `reconcile-reverts` / `retention-cleanup` / `lifecycle-sweep` / `agent-dispatch`；目录只能由人经 `PUT /api/repos/:owner/:name/settings`（`apps/server/src/http/api/index.ts:320`）手写覆盖。
  影响：`docs/requirements.html` 行 1609「仓库新增的标签自动进目录但含义为空；仓库删除的标签标记失效」无实现，目录与 GitHub 会静默漂移，而「目录即全量」（行 1043）正是目标态删除权的前提。
- **判定依据**：目录的数据形状、语义字段、可管理集合判定、提示词注入、目标态作用域全部到位，但术语定义里「身份与 GitHub 仓库一致」需要一个同步/失效写入方，代码里既无该作业也无该写入，故判部分实现并点名缺哪一个子条件。

### TERM-11 槽位
- **状态**：已实现
- **证据**：
  - `apps/server/src/writeback/v21/comments.ts:21` — 标记前缀 `pi-bot:slot`；`:53` `buildSlotMarker()` 写 `<!-- pi-bot:slot <repo>#<issue>:<slot> -->`；`:64` `parseSlotMarkers()` 反解。
  - `apps/server/src/writeback/v21/comments.ts:161` — `planSlotWrite()`：有 `existing` → `op:'update'`（覆盖），否则 `create`；`:98` `findSlotComment()` 按**槽位键**匹配而非逐字匹配。
  - `apps/server/src/db/schema.ts:764-784` — `comment_slots` 表主键 `(repo, issue_number, slot)`：「同一槽位只保留一条」在数据库层被约束，`:773` 存 `comment_id`，`:775` `body_hash`（没变就跳过写回）。
- **缺口**：无。
- **判定依据**：需求「同一槽位只保留一条评论，更新时覆盖而不是新发」有两道独立保证：数据库主键 + `planSlotWrite` 的覆盖决策，且覆盖真的调 GitHub 更新接口（由 `execute.ts` 的 `comment` 分支使用），不是只有标记字符串。

### TERM-12 提及关键词
- **状态**：部分实现
- **证据（需求语义已实现）**：
  - `packages/contract/src/settings-v21.ts:131-144` — `commentMentionSchema`：`keyword`（禁空白与 `@`，允许中文）+ `case_sensitive`；`:341` 默认关键词 `pi-bot`；`:200` `mentions` 至少 1 个。
  - `apps/server/src/trigger/mention.ts:134` — `findLegalMention()`：`@` 紧跟关键词、后接**分隔符**（`:50-58` 白名单含中文标点，`:70-75` 空串/空白也算）、前导字符禁区（`:67`）、最长优先（`:96`），并先蒙版代码区（`:142`）。
  - `apps/server/src/trigger/decide.ts:181-187` — 闸门里只用 `resolveCommentConfig().mentions` 判「是否提及」。
- **缺口**：缺「项目级触发名字只有一处来源」。同一件事在代码里还有第二套活的机制：
  - `packages/contract/src/trigger.ts:24` — `DEFAULT_TRIGGER_ALIASES = ['issuebot','ibot']`，`:80` `resolveTriggerAliases()`，`:129` `findAliasHits()`；
  - 该配置段仍在 schema 里（`packages/contract/src/repo-config.ts:221-222` `triggers: triggersConfigSchema.prefault({})`，段内只剩 `aliases` + v2.1 的 `events`）；
  - 且仍在运行期被使用：`apps/server/src/app/compose.ts:959` 把别名注入 v2.1 运行时，`apps/server/src/http/webhook-v21.ts:331` 用 `stripAliasMentions(body, aliases)` 摘掉正文里的 `@别名`。
  影响：默认值分叉（`pi-bot` vs `issuebot`/`ibot`）。同一条评论「算不算被提及」由 `comment.mentions` 决定，但「正文里的 `@xxx` 要不要摘掉」由 `triggers.aliases` 决定，两处配不一致时模板里的 `{{comment.body}}` 会残留或误删 `@`。
- **判定依据**：需求定义的「@ 关键词且其后是分隔符」有唯一、完整、可测的实现（`findLegalMention`），所以不是未实现；但同一概念在配置层与运行期还留着一套不同名的机制（`triggers.aliases`）并参与正文加工，属于「同一概念多种叫法」，按术语表口径判部分实现。

### TERM-13 角色清单
- **状态**：已实现
- **证据**：
  - `packages/contract/src/settings-v21.ts:170-187` — `commentRoleSchema` 是判别联合：`by:'association'` + `any_of`（七种 `author_association`，`:147-155`）或 `by:'members'` + `members`；`:184` 成员正则的错误文案明写「不支持 org/team」。
  - `packages/contract/src/repo-config.ts:301-309` — 闸门只能引用：`findUnknownAllowRoles()` 校验 `gates.allow_roles` 里每个名字都存在于 `comment.roles`，否则保存即报错；`:310-317` 角色不许重名。
  - `apps/server/src/trigger/roles.ts:69` — `matchCommentRole()`：`allow_roles` 为空 = 未限定（放行），否则按名字引用、大小写不敏感、返回命中列表；`:41-59` 按 `by` 分别判关联或 login。
  - `apps/server/src/trigger/decide.ts:188-199` — 闸门只在 `require_role` 为真时调用它。
- **缺口**：无。
- **判定依据**：「按作者关联或指定成员判定」「闸门只能从中引用」「不支持组织与团队」三条子条件各有独立落点（schema 判别联合 / superRefine 引用校验 / login 正则文案），且判定函数有真实调用方（`decide.ts:188`），不是死代码。

## 本节整体结论

术语表 13 条中 10 条在代码里能找到明确、单一、可执行的对应，其中「事件 / 触发 / 轮次 / 模板 / 占位符 / 写回 / 目标态 / 槽位 / 角色清单」命名与文档基本一一对应，可用作口径基准。

不能判为已实现的三条：TERM-3 会话存在与需求直接相反的归档路径（`compose.ts:1315-1317` 在 30 轮 / 7 天轮换时归档旧会话并更换 `session_id`），这是本节唯一的硬冲突，且队列路径可达。

另两条是命名层面的瑕疵而非功能缺失：TERM-7 的「闸门」在代码里同时指排队超时闸门与 git 推送集闸门；TERM-12 的「提及关键词」旁边还活着一套 `triggers.aliases`。TERM-10 则缺「与 GitHub 仓库一致」的同步实现（`retired` 只读不写、无同步作业），属于实质缺口。

因此本节**不能**整体判为「已实现」：1 条与需求冲突、2 条部分实现（其中 TERM-10 为实质缺口）、1 条术语同名异义较重。

## 核查边界

- **是否执行了命令**：执行了两条只读命令——`git status --short` + `git log --oneline -3`（结果与 `docs/audit/v2/_baseline.txt` 一致，HEAD `fbfa029`，工作区改动集合相同）；若干 `Select-String` 定位检索与 `Get-Content` 行数统计。**未**执行 `pnpm -r test` / `typecheck` / `lint`，本轮结论全部为静态取证，未验证任何测试是否绿。
- **未覆盖的条目及原因**：无遗漏条目。但以下判定只到静态可达性，未在真环境验证：TERM-3 的归档分支是否真的会跑到第 31 轮（需要真 RACP + 真库），我只核到「队列路径不传 `sessionEvent` → `v21SessionEventActive` 恒 false → 归档分支未被互斥条件挡住」；TERM-10 的目录漂移同理属静态推断（无同步写入方），未跑真库确认存量 `settings` 里是否已有人手工填过 `retired`。
- **发现的额外问题（不属本节范围）**：
  1. `apps/server/src/http/webhook.ts:1243` 在注入 v2.1 时仍先算一遍 `decideWebhookTask()`（含 `parseTriggerBody`），结论随后被 `:1260` 的 v2.1 分支丢弃——每条投递多做一次无用解析。
  2. 会话事件键在两处各写一份：`packages/contract/src/settings-v21.ts:56` 与 `apps/server/src/agent/session-state.ts:30`（后者注释说明是刻意复制）。当前取值一致，但改一处不会让另一处编译失败。
  3. `packages/contract/src/repo-config.ts:330-336` 把 `labels.vocabulary` 必须含 `requirement` 与 `defect` 两类角色做成硬校验；存量仓库若没配这两类标签，`settingsValid=false` 会让整个仓库判为不可用（`apps/server/src/http/webhook.ts:1225-1230` 直接 ignored）。
  4. 本节的 `STALE` 检查：所有引用行号均与当前文件内容一致，未发现 `STALE`。
