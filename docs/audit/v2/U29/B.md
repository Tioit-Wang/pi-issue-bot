# U29 12 附录 · 术语 · B

> 核查范围：docs/requirements.html 行 1951-1974
> 代码基线：见 docs/audit/v2/_baseline.txt

本单元判的是「术语 vs 代码命名」。采用的判定口径（先写清，避免结论不可比）：

- 术语条目的**子条件** = ①文档定义的语义在代码里有对应实现且走得到；②该词在代码里**没有第二个活跃含义**（本章自称「统一口径，避免同一概念多种叫法」）。
- ②不满足（**同名异义**）→ 判「部分实现」并点名。**异名同义**（同一件事代码另起一个名）按任务口径只记录、不改状态，因为文档仍是唯一口径。
- 只有语义相反（例如需求说「没有结束状态」而代码有结束/归档路径）才判「与需求冲突」。

## 结论速览

| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| TERM-1 事件 | 已实现 | — |
| TERM-2 触发 | 已实现 | — |
| TERM-3 会话 | 与需求冲突 | 生产链路每次可达「30 轮 / 7 天轮换 → `session/archive` + 清空 `session_id`」，等于会话有结束状态且上下文不跨轮换保留 |
| TERM-4 轮次 | 已实现 | — |
| TERM-5 模板 | 部分实现 | 「模板」同时指项目事件提示词与内置 agent 消息模板（两套渲染器） |
| TERM-6 占位符 | 部分实现 | 「占位符」同时指 `{{a.b}}` 与 `{名字}`，两套语法、两套替换语义 |
| TERM-7 闸门 | 部分实现 | 同一个 `gate` 还指排队闸门、仓库级并发闸门、写回闸门，与「评论闸门」无关 |
| TERM-8 写回 | 部分实现 | `writeback` 还指 git 代码推送（`git/writeback.ts` + `writeback-gate.ts`），且术语表只列 5 类动作、代码有 6 类（缺 `push_branch`） |
| TERM-9 目标态 | 已实现 | — |
| TERM-10 标签目录 | 已实现 | —（异名：`labels.vocabulary` / 「词表」/ `CatalogEntry`） |
| TERM-11 槽位 | 部分实现 | 「槽位」还指提示词装配的层槽位（`SkillSlot` / `ProjectSlot`） |
| TERM-12 提及关键词 | 已实现 | —（异名：v0.3 的 `triggers.aliases` 仍在每次投递上跑） |
| TERM-13 角色清单 | 已实现 | — |

## 逐条

### TERM-1 事件

- **状态**：已实现
- **证据**：`packages/contract/src/settings-v21.ts:56` — `EVENT_KEYS` 五值（`issues.opened` / `issues.edited` / `issues.labeled` / `issues.closed` / `issue_comment.created`）；`apps/server/src/http/webhook-v21.ts:85` — `v21EventKeyOf(event, action)` 用 `X-GitHub-Event` + `payload.action` **共同**定键，正是「事件类型 + 动作」；`apps/server/src/db/schema.ts:93` — 落库侧把两者拆成 `event`（`issues`）+ `action`（`opened`）两列，`apps/server/src/db/schema.ts:131` 还按 `(event, action)` 建索引。
- **判定依据**：定义要求的「由事件类型 + 动作共同确定，如 `issues.opened`」在契约里是复合键、在库里是可分解的两列，两种粒度都被文档句子覆盖，不构成口径冲突。
- **反证过程**：（1）假设「事件」在代码里只有裸 `X-GitHub-Event`（`schema.ts:94` 存的确实是 `issues`）——翻 `webhook-v21.ts:85-94` 后否掉：判定键是复合值，裸值只出现在投递留痕列。（2）假设存在没有 `action` 也被当成事件的路径——`webhook-v21.ts:91` 对 `issue_comment` 只认 `created`，其它 action 返回 `null`（= 不接管），说明 `action` 是判定的一部分。（3）PR 走独立常量 `pull_request.*`（`apps/server/src/trigger/decide.ts:70`），不与五键混用。

### TERM-2 触发

- **状态**：已实现
- **证据**：`apps/server/src/trigger/decide.ts:209` — `decideEvent()` 顺序固定为「验签 → 仓库可用 → 事件开关 → 事件附加条件 → 评论闸门 → 去重 → 日配额」；`…/decide.ts:226` 读 `resolveEventTrigger()` 的 `enabled`（`'on' | 'off' | 'conditional'`，见 `packages/contract/src/settings-v21.ts:69`）；`…/decide.ts:154` 是「事件附加条件」的实现（labeled 的标签命中）；结果落 `decision` + `decision_reason`（`apps/server/src/http/webhook-v21.ts:188` 生成行，`…/webhook-v21.ts:200` 的 UPDATE 语句，列见 `apps/server/src/db/schema.ts:112`、`:124`）。
- **判定依据**：「通过开关与闸门判断、被允许进入处理」= `enabled` 开关 + 附加条件/闸门 + `triggered: true` 三分支，全部有实现且写回留痕。
- **反证过程**：（1）假设「触发」只是「入队成功」的别名——否掉：`decide.ts:246` 起 `content-duplicate` / `daily-quota` 都在入队前就返回 `triggered:false`，且未触发也写 `decision_reason`。（2）假设开关关着仍会走闸门（顺序错）——`decide.ts:227` 开关 `off` 立刻返回 `switch-off`，闸门不执行。（3）剩下的同名风险：技能侧的「触发词」不是事件触发（`decide.ts:82` 只作为模板段名出现），且被修饰词限定，不判冲突。

### TERM-3 会话

- **状态**：与需求冲突
- **证据**：状态枚举本身合规——`apps/server/src/agent/session-state.ts:19`（`SESSION_STATES = ['active','idle']`）、`:69`（`SESSION_ACTIONS = ['create','reuse','recycle-sandbox']`）、`apps/server/src/db/schema.ts:689`（`AGENT_SESSION_STATE` 只有两值）。**但**存在一条生产可达的结束路径：`apps/server/src/app/compose.ts:209`（`maxTurns: 30 / maxAgeDays: 7`）→ `…/compose.ts:450`（`turns >= maxTurns` 或超龄 → `rotate:true`、`archiveSessionId: sessionId`）→ `…/compose.ts:1315`（`if (!v21SessionEventActive && agentSession.archiveSessionId !== null)`）→ `…/compose.ts:1317` `channel.ops.sessionArchive(...)`；随后 `…/compose.ts:1039` 把 `agent_sessions.session_id` 写成 `null`（新会话下一轮才建）。该行「v2.1 生效就不归档」的保护形同虚设：`v21SessionEventActive` 只在 `input.sessionEvent !== undefined` 时置真（`…/compose.ts:1196`、`:1207`），而唯一调用方 `onTaskJob` 只传 `taskId`/`attempt`（`…/compose.ts:1460`），全仓没有任何调用点传 `sessionEvent`（`…/compose.ts:533` 只有类型定义），故该标志恒为 `false`。
- **缺口**：① 需求写「没有结束状态」，代码在 30 轮 / 7 天后对会话执行 `session/archive`（结束），即**有**结束路径；② 需求写「与 issue 同生命周期，持有历史上下文」，轮换后 `session_id` 被清空、上下文不延续（这正是 `…/compose.ts:1313` 注释自称要避免的事）；③ 字段命名反向误导：`apps/server/src/db/schema.ts:679` 的 `closed_at` 叫「关闭」，实际语义是「issue 关闭导致的**沙箱**回收时刻」（`:680` 注释），`apps/server/src/app/compose.ts:291` 复用时又置回 `NULL`。
- **判定依据**：状态字段层面与需求一致（两值、无 `ended`），但生命周期层面代码行为与「没有结束状态」相反，且该路径在队列主链路上默认生效——按状态定义属「代码行为与需求相反」。
- **反证过程**：假设「归档只作用于非 agent 任务」→ 否掉：`…/compose.ts:1230` `isAgentTask: row.source === 'agent'`，agent 任务由 `apps/server/src/http/webhook.ts:605`、`:646` 以 `source:'agent'` 建行，`apps/server/src/agent/dispatcher.ts:13` 也写明 `source='agent'`。假设「轮换分支被 v2.1 标志挡住」→ 否掉（见上，标志恒 `false`）。假设「`session/archive` 只是资源回收、不是结束状态」→ 部分成立但不足以推翻：它同时清空 `session_id`，下一轮必然新建 RACP 会话，历史上下文不跨轮换保留，与「与 issue 同生命周期」直接相反；且仓库自己的注释（`…/compose.ts:1313`）把归档定义为违背 FR-3.4 的动作。另核对是否有 `archived` / `ended` 会话字段：`agent_sessions` 无（`schema.ts:658-686`），但 `repos.archived_at`（`schema.ts:154`）与 `tasks.ended_at`（`:249`）、`runs.ended_at`（`:277`）属于别的对象，不算会话结束状态。

### TERM-4 轮次

- **状态**：已实现
- **证据**：`apps/server/src/runtime/turn-driver.ts:8` — 一轮 = `turn/start { sessionId, input:{ messageId, text: <任务提示词> } }` 拿到 `turnId`，以 `turn/*` 终态退出（`:20`、`:79` 的 `TERMINAL_TURN_EVENT_KINDS`）；`apps/server/src/db/schema.ts:274` — `runs.turn_id` 落库；`apps/server/src/db/schema.ts:668` — `agent_sessions.turns` 计「已用轮数」（`apps/server/src/app/compose.ts:1036` 每轮 +1）。
- **判定依据**：「会话内的一次完整执行，由一条提示词驱动」= 一个 `turn/start`（输入就是这一轮的提示词）+ 一个终态，且有 `turn_id` 可核。
- **反证过程**：（1）假设 `turn` 还有第二个活跃含义（如「轮询」/「回合数上限」）→ 逐个看：`packages/racp-client/src/ops.ts:144` 强调 `turn/start` 的 `input.text` 是「这一轮要做什么」，与会话级恒定物分开；`apps/server/src/cost/host-usage.ts:73` 读 pi-host 的 `turns` 表也是「一轮的用量」，同一含义。（2）假设「轮次」在代码里被当成「任务」的同义词（一个任务多次尝试）→ 否掉：`runs` 一行是「一次尝试」（`schema.ts:271` `attempt`），一行里才有 `turn_id`，层级是任务 → run → turn。（3）假设轮次没有独立承载（只靠日志）→ 否掉：`runs.turn_id` 列存在且在 `apps/server/src/worker/run-task.ts` 的落库路径上（`report`/store 写入），消费方是面板详情（`apps/panel/src/mocks/handlers/task-detail.ts:92` 的形状一致）。

### TERM-5 模板

- **状态**：部分实现
- **证据**：主体在——`packages/contract/src/settings-v21.ts:307` 事件配置带 `prompt`（项目自己写的提示词），`apps/server/src/http/webhook-v21.ts:359` `v21TemplateOf()` 在「项目模板」与内置默认模板 `DEFAULT_EVENT_TEMPLATES`（`packages/contract/src/settings-v21.ts:473`）之间收敛成同一字符串，再由 `…/webhook-v21.ts:464`、`:476` 渲染成实际指令。同名异义——`apps/server/src/agent/message.ts:35` 另有 `AGENT_MESSAGE_TEMPLATES`（三条内置中文「消息模板」），由 `…/message.ts:273`、`:299` 渲染，生产路径 `apps/server/src/http/webhook.ts:1579` `composeAgentMessage()` 仍在调用。
- **缺口**：缺的子条件是「同一概念只有一种口径」：代码里「模板」既指**项目事件提示词**（用户可配、面板「提示词模板」）又指**内置 agent 消息模板**（写死在代码里、另一套 `{名字}` 语法），两者都活着、都与「渲染成指令」有关，术语表未区分。
- **判定依据**：定义要求的三件事（项目配置里、含占位符、触发时渲染）都满足；缺口是命名/口径层面的同名异义，按本单元口径判「部分实现」而非「未实现」。
- **反证过程**：（1）假设「模板」在代码里只有事件提示词一种 → 否掉：`agent/message.ts:1` 自称「消息模板与组装」，`webhook.ts:1579` 是生产调用点。（2）假设内置消息模板已是死代码 → 否掉（同上；它产出的是 `agent_messages.comment_body`，见 `apps/server/src/db/schema.ts:719` 的列注释「事件消息是模板渲染结果」）。（3）反过来假设「项目模板其实没被用上、只用了默认模板」→ 否掉：`webhook-v21.ts:361` 项目 `prompt` 非空即优先，空才回默认；`decide.ts:257` 同口径。（4）面板侧用词与文档一致（`apps/panel/src/layout/nav.ts:67`「提示词模板」），说明用户可见面只有一种「模板」，风险主要落在代码阅读面。

### TERM-6 占位符

- **状态**：部分实现
- **证据**：主体在——`apps/server/src/prompt/render.ts:90` `PLACEHOLDER_PATTERN = /\{\{([a-zA-Z0-9_.]+)\}\}/`，`…/render.ts:132` 起 `resolvePlaceholder()` 逐个实现 12 个名字（`issue.author` / `issue.number` / `comment.body` / `repo.issues` 等），未知名字原样保留并收集（`…/render.ts:175`）。同名异义——`apps/server/src/agent/message.ts:220` 的 `SINGLE_PLACEHOLDER = /^\{([A-Za-z_]+)\}$/` 与 `…/message.ts:32` 的注释「占位符（`{名字}`）…整行消失」是另一套占位符：单花括号、额外带「空值行删除」语义，由 `…/message.ts:229` `renderTemplate()` 处理。
- **缺口**：缺「一种语法一种语义」这一子条件：`{{a.b}}` 是**字面替换**（`prompt/render.ts:8` 明确「一个字都不改」），`{名字}` 是**行级删除糖**（`agent/message.ts:223-249`）。两处都自称「占位符」，读术语表的人无法知道该用哪套。
- **判定依据**：文档定义的 `{{issue.author}}` 形态完全落地且有单测绑定（`prompt/render.ts:23` 提到 12 个名字逐个断言），故不是「未实现」；口径不唯一 → 「部分实现」。
- **反证过程**：（1）假设只有一套占位符、`{名字}` 已废弃 → 否掉：`composeAgentMessage()` 是生产调用（`apps/server/src/http/webhook.ts:1579`）。（2）假设两套其实是同一套的别名（比如 `{名字}` 也走 `{{}}` 正则）→ 否掉：正则完全不同（`prompt/render.ts:90` vs `agent/message.ts:220`），`prompt/render.ts:4` 自己写明「刻意不是一套东西」。（3）假设未知占位符会被静默吞掉（导致「看起来实现了其实丢数据」）→ 否掉：`…/render.ts:175` 原样返回 `match` 并 push 到 `unknown`，`apps/server/src/http/webhook-v21.ts:383` 还打 warn。（4）核对术语表用词与面板：面板「点一下插入」按钮共用同一份 `PROMPT_PLACEHOLDERS`（`prompt/render.ts:19` 注释），用户侧面只有一套——风险在代码面。

### TERM-7 闸门

- **状态**：部分实现
- **证据**：主体在——`packages/contract/src/settings-v21.ts:105` `commentGatesSchema`（`require_mention` / `require_role` / `allow_roles` / `ignore_bot` / `allow_closed`），`apps/server/src/trigger/decide.ts:173` `checkCommentGates()`，且只在评论事件上生效（`…/decide.ts:238`）；生效值 `apps/server/src/config/v21-settings.ts:132`。同名异义（同一 `gate`/闸门 的其它活跃含义）：
  - 排队闸门：`apps/server/src/jobs/queue-gate.ts:2`（「排队闸门作业」）、`apps/server/src/queue/definitions.ts:8`、`:21`（`queueGate: 'queue-gate'`）；
  - 仓库级并发闸门：`apps/server/src/queue/boss.ts:188`（「`gate` 是仓库级并发」）、`:196`（`readonly gate?: RepoConcurrencyGate`）、`apps/server/src/app/compose.ts:1507`（`gate:` 装配）；
  - 写回闸门：`apps/server/src/git/writeback-gate.ts:2`（「写回闸门」）、`:207` `evaluateWriteback()`、`apps/server/src/git/writeback.ts:81`（局部变量就叫 `gate`）。
- **缺口**：术语表把「闸门」限定为「评论事件特有的附加判断条件」，但代码里**未加限定的 `gate`** 指的是并发/写回，加限定词的「闸门」另有三义；同一个词四个含义，术语表只收了一个。
- **判定依据**：评论闸门本身完整（四个条件 + 固定优先级 + 只对评论事件生效），故不是未实现；「同一概念多种叫法／同一个词多种含义」这一子条件不满足 → 部分实现。
- **反证过程**：（1）假设这些 `gate` 其实都是评论闸门的同一套抽象（同一个类型/同一个模块）→ 否掉：`CommentGates`（契约 schema）、`RepoConcurrencyGate`（`boss.ts:196`）、`WritebackGateInput`（`git/writeback-gate.ts:109`）、`QUEUE_GATE_*` 四条 SQL 之间无任何共享类型或 import 关系，语义分别对应「判定/并发限流/推送白名单/排队超时」。（2）假设未限定 `gate` 不会撞车（都带中文限定词）→ 部分成立：中文注释基本都带限定词，但**代码标识符**（`gate`、`gateAck`、`QUEUE_GATE_*`、`writeback-gate`）不带，搜索/跳转时会串。（3）假设评论闸门被别的事件误用 → 否掉：`decide.ts:238` 只在 `issue_comment.created` 上执行，与定义「评论事件特有」一致。

### TERM-8 写回

- **状态**：部分实现
- **证据**：主体在——`apps/server/src/writeback/v21/execute.ts:467` 起 12 个动作分支，其中定义所列五类都有执行路径：`comment`（`:589` `runComment`，槽位覆盖）、`label`（`:515` `runLabel` → 目标态差集）、`create_issue`（`:758`）、`open_pr`（`:802` → `:817` `api.openPullRequest`，生产注入见 `apps/server/src/app/compose.ts:843`、`:1422`）、`close_issue`（`:827`，仅 `verdict=fail` 允许）；后三类默认关闭：`packages/contract/src/settings-v21.ts:217`（`create_issue/open_pr/close_issue` 全 `default(false)`）+ 执行前 `preflightSwitches()`（`…/execute.ts:390`、`:420`）。同名异义——`writeback` 还指「把容器里改的代码推回仓库」：`apps/server/src/git/writeback.ts:77` `runWriteback()`、`apps/server/src/git/writeback-gate.ts:2`。
- **缺口**：① 术语表列 5 类，代码是一等公民的动作有 6 类：`packages/contract/src/enums.ts:115` `ACTION_INTENTS` 含 `push_branch`（术语表未提）；② 同一个 `writeback` 同时是「平台落结果到 GitHub」的目录名（`apps/server/src/writeback/`）与「代码推送」的模块名（`apps/server/src/git/writeback.ts`），术语表只定义了前者。
- **判定依据**：文档五个子条件（五类动作 + 后三类默认关）全部满足，所以不是未实现；缺口是动作清单与词义两处口径不齐 → 部分实现。
- **反证过程**：（1）假设「开 PR」只是纸面能力（存在≠生效）→ 实测代码链路：`…/execute.ts:1139` 是可选注入，但装配层确实注入了 `createV21OpenPullRequest`（`apps/server/src/app/compose.ts:843`、`:1422`），并传导到 worker（`apps/server/src/worker/run-task.ts:1341`），所以开关打开时能真开 PR；反过来 `push_branch` 走旧 `DelegatedPlan`（`apps/server/src/github/executor.ts:945`）且 `runWriteback()` 全仓无生产调用方（只有 `apps/server/test/git-writeback.test.ts`），即**代码推送侧的写回目前不执行**（记在额外问题）。（2）假设三类动作的开关没被消费（死字段）→ 否掉：`…/execute.ts:394` 读 `switches[gated]`，`:420` 整批预检，装配层从 `resolveAgentExecution().actions` 取值（`apps/server/src/http/webhook-v21.ts:685`、`apps/server/src/worker/run-task.ts:1328`）。（3）假设「写回」在代码里另有第三种含义 → 未发现；`git/writeback.ts:12` 自述与 `DelegatedPlan` 的关系，仍落在「把结果落到 GitHub」的大类下，但对象是代码而非评论文本，属同名异义。

### TERM-9 目标态

- **状态**：已实现
- **证据**：`apps/server/src/writeback/v21/labels.ts:135` `planLabelTargetState()` — 输入 `desired`（完整期望集合）、`current`、目录；`add = desired − current`（`:183`）、`remove = current ∩ 可管理目录 − desired`（`:187-197`），即「多的删、少的加」；消费方 `apps/server/src/writeback/v21/execute.ts:519`（`runLabel` 调它，`:548`、`:555` 真加/真删）。
- **判定依据**：文档两句话（执行侧给完整集合、平台与当前对齐）在纯函数里逐字对应，且有真实写方法调用。
- **反证过程**：（1）假设代码实现的是「增量」（只 add/remove 给定项）→ 否掉：`labels.ts:4` 与函数体都是「以 desired 为全集重算差集」，`desired` 为空且无 `clear` 时整批拒绝（`:140`）。（2）假设该函数没有生产调用方（死代码）→ 否掉：`execute.ts:26` import、`:519` 调用，`runLabel` 由 `:469` 分派，`execute` 由 `apps/server/src/http/webhook-v21.ts:701` 起执行。（3）假设「目标态」在别处另有一义 → 未发现：`apps/server/src/db/schema.ts:620`（`label_decisions.desired`）、`apps/server/src/worker/writeback.ts:423` 都是同一含义（另有一个 v0.3 的 `planLabelDelta`，但同样是「期望集合 vs 当前」）。

### TERM-10 标签目录

- **状态**：已实现
- **证据**：`packages/contract/src/settings-v21.ts:275` `labelCatalogEntryV21Schema` — `name`（与 GitHub 标签同名）+ 平台侧补充的 `meaning` / `group`（互斥组）/ `color` / `description` / `managed` / `status`；解析 `apps/server/src/config/v21-settings.ts:249` `resolveManagedCatalog()`（全量返回、不过滤）；消费 `apps/server/src/http/webhook-v21.ts:690` 转成 `CatalogEntry[]` → `apps/server/src/writeback/v21/execute.ts:523` → `planLabelTargetState()` 用目录判「可管理/目录外」。提示词侧也吃同一份词表：`apps/server/src/skills/prompt.ts:254` `renderLabelVocabulary()`。
- **判定依据**：「身份与仓库一致（`name`）+ 语义由平台补充（`meaning`/`group`）」两点都有字段与消费路径；目录不是死数据（没填 `meaning` 的标签不进自动对齐，`labels.ts:103`）。
- **反证过程**：（1）假设目录只有 schema、没人读（死字段）→ 否掉：三处消费（写回、提示词、面板 mock 的形状）。注意 `resolveManagedCatalog` 本身**不在** `writeback` 层调用，而是由装配层转换后注入（`webhook-v21.ts:690`、`worker/run-task.ts:391`），仍算生效。（2）假设「身份与 GitHub 一致」只是口号（目录里可以有仓库不存在的标签）→ 部分成立：目录是配置项，代码不主动拉 GitHub 标签列表做同步，`retired` 只能由人写配置（`retired` 全仓只出现在契约/schema/判定侧，无自动写入口）；但术语表这一句要求的是「名字用 GitHub 标签名」，这一点成立（`workflows/normalize.ts:22` 词表存的就是仓库标签名），故不判缺口，只记在额外问题。（3）异名同义核对：文档「标签目录」，代码主力叫法是 `labels.vocabulary` / 「词表」/「目录」/`CatalogEntry`（`apps/panel/src/layout/nav.ts:69` 面板写「词表」）——按本单元口径只记录，不改状态。

### TERM-11 槽位

- **状态**：部分实现
- **证据**：主体在——`apps/server/src/db/schema.ts:764` `comment_slots`（主键 `(repo, issue_number, slot)`，`:780`），标记协议 `apps/server/src/writeback/v21/comments.ts:21`（`pi-bot:slot`）、`:53` `buildSlotMarker()`、`:161` `planSlotWrite()`（有则 update、无则 create），执行侧 `apps/server/src/writeback/v21/execute.ts:593`（`runComment` 先按标记找同槽位评论再覆盖），索引端口 `…/execute.ts:170` `V21SlotStore`。同名异义——`apps/server/src/skills/assemble.ts:151` `type SkillSlot`、`:156` `type ProjectSlot`、`:192`（注释「P1 槽位 → 文本」）、`:193` `renderProjectSlot()`：这里「槽位」指**提示词装配层在预算不足时被丢弃的占位**，与评论槽位无关。
- **缺口**：缺「槽位只有一种含义」这一子条件：一个指 GitHub 评论的固定位置（有 DB 主键、有正文标记），一个指提示词分层装配的内部形状（无落库、只影响上下文预算）。此外 `comment_slots` 表在生产**没有写入方**（`V21SlotStore.put` 只在 `execute.ts:696` 被调用，而 `slotStore` 全仓未注入，仅测试显式传入），槽位语义目前靠正文标记兜住（`…/execute.ts:627` 的分支）。
- **判定依据**：文档定义（固定位置标识 + 同槽位只留一条 + 覆盖）完全实现并且是唯一生效语义；缺口是词义冲突 + 索引旁路（旁路不影响语义，因为标记找法等价，见 `…/execute.ts:167` 注释）。
- **反证过程**：（1）假设「覆盖」其实实现成了「新发」→ 否掉：`comments.ts:161` `planSlotWrite()` 按 `existing === null` 决定 create/update，`execute.ts:593` 先 `findSlotComment()`。（2）假设 `slot` 还有第三种含义（如队列槽位）→ 未发现（`queue/` 无 slot）。（3）假设 `slotStore` 未注入就代表槽位索引功能其实是半成品 → 记录：表存在但无写入路径，属「存在≠生效」，不影响术语表这一条的语义判定，单列在额外问题。（4）确认同名异义不是我能忽略的重命名：`assemble.ts:192` 用的就是裸「槽位」二字，与 `writeback/v21/comments.ts:4` 的「同一个 `(repo, issue, slot)`…槽位」并列出现。

### TERM-12 提及关键词

- **状态**：已实现
- **证据**：`packages/contract/src/settings-v21.ts:131` `commentMentionSchema`（`keyword` + 可选 `case_sensitive`），默认值 `packages/contract/src/settings-v21.ts:341` `DEFAULT_COMMENT_KEYWORD = 'pi-bot'`（与术语表举例一致）；判定 `apps/server/src/trigger/mention.ts:134` `findLegalMention()`：蒙版代码区（`:142`）→ `@` 前导字符禁区（`:67`、`:148`）→ **其后必须是分隔符**（`:70`、`:115`，白名单见 `:50-58`，中文不算分隔符）→ 同位置最长优先（`:96`）；闸门接电 `apps/server/src/trigger/decide.ts:181`；配置解析 `apps/server/src/config/v21-settings.ts:159`。
- **判定依据**：「@ 关键词 + 其后是分隔符才算合法提及」逐条对应，默认关键词就是 `pi-bot`。
- **反证过程**：（1）假设「分隔符」没有实现（只要前缀匹配就算）→ 否掉：`:115` 显式要求 `isMentionSeparator`，且 `:43` 注释给了反例 `@pi-bot你好` 不命中。（2）假设只有 `{{}}` 之前的别名机制在生效（v0.3 路径），v2.1 关键词没接上 → 否掉：`decide.ts:184` 用 `findLegalMention`，闸门只在评论事件执行（`:238`）。（3）异名同义（记录、不改状态）：同一件事还有一套 `triggers.aliases`（`packages/contract/src/trigger.ts:24` `DEFAULT_TRIGGER_ALIASES = ['issuebot','ibot']`、`:171` `parseTriggerBody()`），并且在每次投递上仍被执行——`apps/server/src/http/webhook.ts:1243` `decideWebhookTask()`，其内部 `…/webhook.ts:593` 调 `parseTriggerBody`；两套匹配规则不同（别名：词边界 + 只看有没有正文；关键词：分隔符白名单 + 支持中文）。因为文档口径明确指向「提及关键词」，故不判缺口，但这是本单元最值得跟进的命名/实现冗余。（4）假设代码里有「组织/团队」式的提及（与角色清单混用）→ 未发现。

### TERM-13 角色清单

- **状态**：已实现
- **证据**：`packages/contract/src/settings-v21.ts:170` `commentRoleSchema` 判别联合：`by:'association'` 用 `any_of`（七个 `ASSOCIATIONS`，见 `:147`），`by:'members'` 用 `members`（`:184` 正则 + 文案「不支持 org/team」）；判定 `apps/server/src/trigger/roles.ts:41` `roleMatches()`（按关联或按 login，大小写不敏感）、`:69` `matchCommentRole()`（只按名字引用 `allow_roles`，拼错不报错）；闸门接线 `apps/server/src/trigger/decide.ts:188`；保存期硬校验 `packages/contract/src/settings-v21.ts:380` `findUnknownAllowRoles()`（闸门只能引用已定义角色名）。
- **判定依据**：四点（项目级定义、两种判定方式、闸门只引用名字、不支持组织团队）全部有实现，且「不支持 org/team」是 schema 层的硬约束而非注释。
- **反证过程**：（1）假设闸门可以临时填人（绕过角色清单）→ 否掉：`allow_roles` 是 `string[]` 名字数组（`settings-v21.ts:112`），`roles.ts:77` 只按 `role.name` 匹配，非清单项直接跳过。（2）假设「不支持组织与团队」只写在注释里 → 否掉：`settings-v21.ts:184` 的 `MEMBER_LOGIN_RE` 在解析期就拒（错误文案点名 org/team）。（3）假设角色清单是死配置（保存了但判定不读）→ 否掉：`resolveCommentConfig()`（`apps/server/src/config/v21-settings.ts:159`、`:167`）把 roles 规范化后交给 `decide.ts:189`。（4）假设 `allow_roles` 为空时行为与文档相反（变成谁都不许）→ 否掉：`roles.ts:70` 空列表 = 未限定 = 放行，`roles.ts:8` 写明理由。

## 本节整体结论

13 个术语在代码里都有对应实现，没有「找不到实现」的条目，用户可见面（面板设置分区 `apps/panel/src/layout/nav.ts:67-69`）用的就是这套词，说明术语表与产品语言是对齐的。真正的与需求冲突只有一条：**会话**在 30 轮 / 7 天后仍会被 `session/archive` 并清空 `session_id`，而该保护条件的开关在生产链路上恒为 `false`——这既是术语问题（「没有结束状态」名不副实），也是 FR-3.4 的实现问题。另有 5 条属**同名异义**（模板、占位符、闸门、写回、槽位）与若干**异名同义**（提及关键词/别名、标签目录/词表、目标态/desired），都是命名层的不统一、不是功能缺失。因此本节**不能**整体判为「已实现」：术语表自称统一口径，而代码里同一个词至少 5 处指两个以上不同机制。

## 核查边界

- 是否执行了命令：执行了只读命令 `git status --short`、`git log --oneline -3`（工作区与 `docs/audit/v2/_baseline.txt` 一致，HEAD `fbfa029`），以及 `Select-String` 全文检索与 `Read` 定点取证；**未**执行 `pnpm -r test` / `typecheck` / `lint`，测试结论仅声明「测试存在且断言具体」，不声明「跑过且绿」。
- 未覆盖的条目及原因：无（13 条全部核过）。但 TERM-3 的「轮换归档在真实运行中是否真的触发」需要真 PG + 真 pi-host 才能观测到 `session/archive` 的实际调用，本报告只做静态可达性论证（标志恒 false + 唯一调用方不传参），若要线上确证需跑一次满 30 轮的会话。
- 发现的额外问题（不属本节范围但值得记录）：
  1. `V21SlotStore` / `comment_slots` 表在生产**没有写入方**：全仓只有 `writeback/v21/execute.ts:696` 会 `put`，而 `slotStore` 未在 `apps/server/src/app/compose.ts` / `http/webhook-v21.ts` 注入（仅测试传入）——「槽位索引」是死表，写回退化成每次列评论。
  2. `git/writeback.ts:77` 的 `runWriteback()` 全仓无生产调用方（只有 `apps/server/test/git-writeback.test.ts` 调），`push_branch` / 旧 `open_pr` 只到 `DelegatedPlan`（`apps/server/src/github/executor.ts:945`、`:948`）并在 worker 记 `status:'delegated'`（`apps/server/src/worker/writeback.ts:796`、`:890`），即代码推送这一半的写回尚未接通。
  3. `apps/server/src/app/compose.ts:1166` 的「v2.1 会话状态机交叉校验」把 `state` 恒传 `'active'`、`issueState` 恒传 `'open'`（`:1174`、`:1179`），输入是常量时这条校验不可能发现问题，属自我实现的断言。
  4. `apps/server/src/trigger/mention.ts:12` 的注释提到「§6.6 明确允许中文关键词」，而 `packages/contract/src/settings-v21.ts:138` 的正则 `^[^\s@]+$` 也确实放行中文——两处一致，仅记录该约定只存在于注释与正则之间，没有独立的常量或测试名承载（`apps/server/test/trigger-mention.test.ts` 是否覆盖中文未核）。
