# U04 3.2 场景 A · A

## 结论速览

| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| SA-1 | 已实现 | —（`POST /webhook` → 管线 → `issues.opened` 判定键可定位） |
| SA-2 | 已实现 | —（每事件独立开关，`issues.opened` 默认 `on`，与需求默认表一致） |
| SA-3 | 已实现 | —（按事件取模板 + 一次遍历渲染，未知占位符原样保留并告警） |
| SA-4 | 已实现 | —（消息按 `(repo, issue_number)` 落库并投进该 issue 的持久会话） |
| SA-5 | 部分实现 | 旧兜底评论路径会让平台**自己**决定给 `agent:event` 补发一条评论（无槽位、非产出动作）；但不存在「收到 opened 就发固定评论/打固定标签」的硬编码 |
| SA-6 | 已实现 | 代码路径完整；但标签「当前态」取自 `bot_labels` 台账而非 GitHub 实时标签，差集口径偏保守 |

## 逐条

### SA-1

- 状态：已实现
- 证据：
  - `apps/server/src/http/server.ts:266` — 装配层注册 webhook 路由（`registerWebhookRoute(scope.withTypeProvider<ZodTypeProvider>(), deps.webhook, …)`）。
  - `apps/server/src/http/webhook.ts:1913` — `app.register` 作用域内挂原始 body 解析器；`apps/server/src/http/webhook.ts:1923` — `scope.post('/webhook', …)` 是唯一入口。
  - `apps/server/src/http/webhook.ts:1938` — 路由把 `X-GitHub-Delivery` / `X-GitHub-Event` / 签名原文交给 `handleWebhook()`。
  - `apps/server/src/http/webhook.ts:987` — `handleWebhook()` 包住九步管线；`apps/server/src/http/webhook.ts:1052` 解析 payload、`apps/server/src/http/webhook.ts:1058` 取 `action`。
  - `apps/server/src/http/webhook-v21.ts:93` — `event === 'issues'` 分支；`apps/server/src/http/webhook-v21.ts:95` — `case 'opened'` → `'issues.opened'`。
  - `apps/server/src/http/webhook-v21.ts:161` — `decideV21Delivery()` 用该事件键进判定；`apps/server/src/trigger/decide.ts:209` — `decideEvent()` 是判定本体。
  - `apps/server/src/http/webhook.ts:384` — v0.3 侧 `ISSUE_ACTIONS` 同样含 `'opened'`（旧装配下也进入判定，未被丢掉）。
- 缺口：无。
- 判定依据：接收 → 事件键映射 → 判定函数三段都有实现路径，且 `issues.opened` 在两条路径（v2.1 / v0.3）里都被识别。

### SA-2

- 状态：已实现
- 证据：
  - `packages/contract/src/settings-v21.ts:81` — `eventTriggerSchema` 的 `enabled: eventSwitchSchema.default('on')`；`packages/contract/src/settings-v21.ts:73` — 三态 `on/off/conditional`。
  - `packages/contract/src/settings-v21.ts:326` — `eventTriggersSchema` 以事件名为键（每个事件一份配置）；`packages/contract/src/settings-v21.ts:328` — `'issues.opened': eventTriggerSchema.prefault({ enabled: 'on' })`。
  - `apps/server/src/config/v21-settings.ts:107` — `resolveEventTrigger()` 读 `settings.triggers.events[event]`，即「按项目配置、按事件」取值。
  - `apps/server/src/trigger/decide.ts:226` — `const trigger = resolveEventTrigger(input.settings, event)`；`apps/server/src/trigger/decide.ts:227` — `enabled === 'off'` 直接 `skip('switch-off')`，不建消息。
  - `apps/server/src/trigger/decide.ts:264` — `on` → `reason: 'enabled'`，`conditional` → `'conditional-met'`（开关语义落地）。
  - 需求默认值对照：`docs/requirements.html:766` 要求 `issues.opened` 平台默认为「触发」；代码默认 `enabled: 'on'` 与之相同（`issues.edited` 默认 `on` + `only_body_changed: true` 也对齐 `docs/requirements.html:767`）。
- 缺口：无。
- 判定依据：开关按「项目 + 事件」可配、默认值与需求默认表逐项一致、`off` 分支有明确实现。

### SA-3

- 状态：已实现
- 证据：
  - `apps/server/src/trigger/decide.ts:255` — `rawPrompt = trigger.prompt`；`apps/server/src/trigger/decide.ts:258` — 空白/`null` 回落到 `DEFAULT_EVENT_TEMPLATES[event]`，并把结果放进 `TriggerDecision.template`（`apps/server/src/trigger/decide.ts:260`）。
  - `apps/server/src/config/v21-settings.ts:105` — 模板来源是 `triggers.events[event].prompt`（按事件维度取用，不是全局一份）。
  - `packages/contract/src/settings-v21.ts:474` — `issues.opened` 的内置默认模板（含 `/proposal-analysis`、`{{issue.number}}`、`{{issue.url}}`、`{{issue.author}}`、`{{issue.title}}`、`{{issue.labels}}`、`{{issue.content}}`）。
  - `apps/server/src/http/webhook-v21.ts:464` — 渲染时优先用判定阶段已解析的 `decidedTemplate`；`apps/server/src/http/webhook-v21.ts:476` — `renderV21AgentText()` → `renderTemplateAsync()`。
  - `apps/server/src/http/webhook-v21.ts:1017` — 调用点确实传 `decidedTemplate: decision.template`（项目模板与内置默认收敛为同一字符串，无第二套渲染器）。
  - `apps/server/src/prompt/render.ts:173` — 单次 `replace` 完成全部替换（重复占位符全换、替换结果不再二次替换）；`apps/server/src/prompt/render.ts:175` — 未知占位符 `return match` 原样保留并收集到 `unknown`。
  - `apps/server/src/http/webhook-v21.ts:495` — `unknown` 非空时记结构化告警（`reportV21UnknownPlaceholders`，`apps/server/src/http/webhook-v21.ts:372`）。
  - 渲染上下文 12 个占位符的取值：`apps/server/src/prompt/render.ts:132` 起 `resolvePlaceholder()`；数据来源 `apps/server/src/http/webhook-v21.ts:293` `v21RenderContextOf()`。
- 缺口：无。
- 判定依据：模板按事件取用 → 渲染 → 正文落库三段齐备，且三项 FR-2.3 硬规则（重复替换、一次遍历、未知保留+告警）在 `prompt/render.ts` 有实现级保证。

### SA-4

- 状态：已实现
- 证据：
  - 消息按该 issue 落库：`apps/server/src/agent/store.ts:95` — `insertMessage` 的 `ON CONFLICT ("repo","issue_number","fingerprint")`；`apps/server/src/http/webhook-v21.ts:1029` — v2.1 分支调用 `insertMessage(... body: build.text ...)`（渲染结果就是 agent 看到的正文，`apps/server/src/http/webhook-v21.ts:1034`）。
  - 事件幂等锚含事件键与 `issue.updated_at`：`apps/server/src/http/webhook-v21.ts:916` `eventFingerprint()`。
  - 立即投递到该 issue：`apps/server/src/http/webhook-v21.ts:1049` → `dispatchAgent({ repo, issueNumber })`；装配侧 `apps/server/src/app/compose.ts:978` — `dispatchAgent: (key) => dispatchNextForIssue(agentDispatch, key)`。
  - `apps/server/src/agent/dispatcher.ts:89` — `claimNextForIssue(deps.db, key)` 按 `(repo, issueNumber)` 领最老一条；`apps/server/src/agent/store.ts:124` — `claimOldest` 的 `WHERE "repo"=$1 AND "issue_number"=$2`。
  - 任务行绑定 issue：`apps/server/src/agent/store.ts:147` — `insertTask` 写 `source='agent'`、`target_kind='issue'`、`target_number=$3`，`prompt_text` 即消息正文。
  - 正文进会话：`apps/server/src/app/compose.ts:1141` — `agentMessageBody = row.promptText`；`apps/server/src/app/compose.ts:1236` — agent 任务把「## 这一条消息」+ 该正文拼成 prompt。
  - 会话就是「这个 issue 的会话」（一 issue 一行、持久）：`apps/server/src/agent/store.ts:152` — `loadSession ... WHERE "repo"=$1 AND "issue_number"=$2`；`apps/server/src/agent/store.ts:156` — `saveSession` UPSERT `("repo","issue_number")`；`apps/server/src/app/compose.ts:1159` — `loadAgentSession({ repo, issueNumber: row.targetNumber })`；`apps/server/src/app/compose.ts:1228` — `planAgentSession(...)` 产出 `persistent` 会话计划；`apps/server/src/worker/run-task.ts:874` — 复用已有 `sessionId`（`sessionPlan` 带 `sessionId` / `after` 游标）。
  - 会话在事件侧即被建立/激活：`apps/server/src/http/webhook.ts:1210` — `issues.*` 事件里 `applyV21SessionOnEvent(...)`；`apps/server/src/http/webhook-v21.ts:847` — `transition.action === 'create'` 时 INSERT `agent_sessions`，否则复用。
- 缺口：无。
- 判定依据：消息 → 任务 → 会话三跳都以 `(repo, issue_number)` 为键，未出现「每次触发新开会话」的分支（v2.1 路径下也不 archive 会话，见 `apps/server/src/app/compose.ts:1315`）。

### SA-5

- 状态：部分实现
- 证据（边界成立的部分）：
  - `apps/server/src/http/webhook-v21.ts:1057` — 触发后平台**只**做一件事：`addEyesReaction`（`apps/server/src/http/webhook-v21.ts:1059`），没有任何 comment/label 写入；dry-run 连这个都不打（`apps/server/src/http/webhook-v21.ts:1056`）。
  - `apps/server/src/http/webhook-v21.ts:1038` — 幂等命中直接返回 `duplicate`，同样不产生评论/标签。
  - 仓库内检索 `需补充信息` 无命中（无场景里的固定标签字面量）；默认标签词表来自 `packages/contract/src/settings-v21.ts:251` 的 `labels.vocabulary`（默认 `parse({})` 为空，`packages/contract/src/repo-config.ts:370`），不存在内置「opened → 打某标签」映射。
  - 评论走产出动作：`apps/server/src/writeback/v21/execute.ts:471` — `case 'comment': return runComment(...)`；标签：`apps/server/src/writeback/v21/execute.ts:469` — `case 'label': return runLabel(...)`；动作只来自 `OutputV21.actions`（`apps/server/src/writeback/v21/execute.ts:433` 遍历 `input.output.actions`）。
  - 旧流水线那条「事件来了发固定回执」已在代码中消失：`pipeline:notice` / `postGateNotice` / `executeFormatPlan` 只剩注释提及（`apps/server/src/worker/run-task.ts:1485`、`apps/server/src/app/compose.ts:1280`），无实现。
- 证据（缺口所在）：
  - `apps/server/src/worker/run-task.ts:1243` — `if (!v21Handled && prepared !== null && (!prepared.valid || !hasCommentAction))` 时由 worker 补发一条兜底评论；`apps/server/src/worker/run-task.ts:1265` 调用 `postFallbackComment(...)`。
  - `apps/server/src/worker/fallback.ts:47` — 兜底白名单含 `'agent:event'`（即 opened/edited 触发的任务），`apps/server/src/worker/fallback.ts:69` `supportsCommentFallback()` 放行。
  - 该路径的写面是 `apps/server/src/worker/fallback.ts:285` `dispatchWriteAction({ kind: 'comment', … })` —— 评论正文取自模型最后一段人话（`apps/server/src/worker/fallback.ts:250` `buildFallbackCommentBody`），**没有槽位**（不带 `pi-bot:slot` 标记，只有 `apps/server/src/worker/fallback.ts:31` 的 `pi-bot:fallback` 标记）。
  - 触发条件：仅当 v2 探针为 `not-v21`（模型没给 v2 信封）才走旧路径，`apps/server/src/worker/run-task.ts:1173` 的 `rejected` 与 `apps/server/src/worker/run-task.ts:1169` 的 `valid` 都会置 `v21Handled = true`，因此不会叠加这条兜底。
- 缺口：平台仍保留一条「按命令类别（`agent:event`）自行决定发一条评论」的旧兜底通道，评论不出自产出动作、也不进槽位（`apps/server/src/worker/run-task.ts:1243` + `apps/server/src/worker/fallback.ts:47`）。它不改变「不存在收到 opened 就发某条**固定**评论/打某个**固定**标签的硬编码」这一条——正文永远来自模型文本，标签只来自 `label` 动作。
- 判定依据：正常路径（v2 产出）完全符合「平台不预设动作」；失败路径留了一个平台自决的评论出口，因此不能判「已实现」，但也不能判「与需求冲突」——它不是按 `issues.opened` 硬编码的固定文案/固定标签。

### SA-6

- 状态：已实现
- 证据（评论 + 槽位）：
  - `apps/server/src/writeback/v21/execute.ts:589` — `runComment()`：`buildSlotMarker(...)`（`apps/server/src/writeback/v21/execute.ts:593`）生成 `<!-- pi-bot:slot owner/name#N:slot -->`（`apps/server/src/writeback/v21/comments.ts:53`）。
  - `apps/server/src/writeback/v21/comments.ts:161` — `planSlotWrite()`：同槽位已有评论 → `update`，否则 `create`（覆盖语义，`apps/server/src/writeback/v21/comments.ts:172`）。
  - `apps/server/src/writeback/v21/execute.ts:651` — `updateIssueComment`；`apps/server/src/writeback/v21/execute.ts:675` — `createIssueComment`；404 走 `apps/server/src/writeback/v21/execute.ts:661` 的重建分支。
  - 真实 REST：`apps/server/src/github/octokit.ts:237` — `POST /repos/{owner}/{repo}/issues/{issue_number}/comments`；`apps/server/src/github/octokit.ts:298` — `PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}`。
- 证据（标签 + 目标态）：
  - `apps/server/src/writeback/v21/execute.ts:519` — `planLabelTargetState({ current, desired, clear, catalog, maxPerIssue, botLabels })`；`apps/server/src/writeback/v21/labels.ts:135` — 目标态差集实现（空集保护 `labels.ts:140`、超限整批拒绝 `labels.ts:150`、目录外拒绝 `labels.ts:170`、删除只发生在可管理集合内 `labels.ts:187`）。
  - `apps/server/src/writeback/v21/execute.ts:548` — `addLabels`（先加）；`apps/server/src/writeback/v21/execute.ts:556` — 逐条 `removeLabel`（后删）。
  - 真实 REST：`apps/server/src/github/octokit.ts:251` — `POST … /issues/{issue_number}/labels`；`apps/server/src/github/octokit.ts:261` — `DELETE … /labels/{name}`。
- 证据（执行链装配）：
  - `apps/server/src/worker/run-task.ts:1351` — 注入式执行器 `/` `apps/server/src/worker/run-task.ts:1378` 直连 `executeV21()`（两条路都落同一结论形状）；`apps/server/src/worker/run-task.ts:1354` 传 `currentLabels` / `botLabels` / `issueNumber`。
  - `apps/server/src/app/compose.ts:836` — `createV21Executor({ write: ports.github, … })`；`apps/server/src/app/compose.ts:860` — 调用 `v21Executor(text, { currentLabels, botLabels, … })`。
  - 端口到写面：`apps/server/src/writeback/v21/execute.ts:1184` 起 `createV21PortFromGithub()` 把 `write.*` 转发给 `GithubWriteApi`（`apps/server/src/worker/run-task.ts:354` `v21WritePort()` 逐项转发并同步 `bot_labels` 台账）。
  - dry-run 只算不写：`apps/server/src/writeback/v21/execute.ts:538` / `apps/server/src/writeback/v21/execute.ts:645`。
- 缺口：标签「当前态」不是从 GitHub 实时标签读的：`apps/server/src/app/compose.ts:859` 用 `readAppliedLabels(pool, …)`（`bot_labels` 台账），`apps/server/src/app/worker-deps.ts:1073` 的 `createV21TargetContextPort()` 也把 `currentLabels` 由调用方给、只额外读同一张台账。后果是「人手工打的标签」不在 `current` 里，因此只可能被 `add`（GitHub 端幂等）而不会被误删——安全侧偏保守，但与「目标态 = GitHub 当前态」的字面口径有差距。
- 判定依据：评论（槽位覆盖）与标签（目标态差集）都有执行器实现 + 真实 REST 端点 + 装配注入，写回顺序与失败即停也符合 §5；未在本环境向真实 GitHub 发请求（见核查边界）。

## 本节整体结论

场景 A 的端到端链路成立：`issues.opened` 投递被验签/去重后进入判定（SA-1），判定读项目配置里该事件的三态开关、默认 `on`（SA-2），用该事件的模板（项目配置优先，否则内置默认）渲染占位符成指令（SA-3），把渲染结果按 `(repo, issue_number)` 落 `agent_messages` 并投进这个 issue 的持久会话（SA-4），会话产出 `comment`（槽位覆盖）与 `label`（目标态差集）后由执行器经 REST 落到 GitHub（SA-6）。

唯一与「平台不预设动作」有出入的是 SA-5 的旧兜底评论：当模型没有给出合法的 v2 产出、但有一段人话时，worker 仍会替它发一条无槽位评论（`apps/server/src/worker/run-task.ts:1243`、`apps/server/src/worker/fallback.ts:47`）。这条路径不产生固定文案、也不打任何固定标签，因此不影响「正文只写一句『导出闪退，急』→ 得到缺项清单 + 补信息标签」这个业务结果，但「平台只执行产出动作」在失败路径上不完全成立。

## 核查边界

- 是否执行了命令：是，但只读。执行了 `git status --short`、`Get-ChildItem`、`Select-String`（仅用于定位 `file:line`），未运行 `pnpm test` / `typecheck`，未启动服务，未向真实 GitHub 或模型端点发起任何请求。
- 未覆盖的条目及原因：
  - SA-6 的「真正落到 GitHub」只按代码路径判定（执行器 → 端口 → `octokit` 的 REST 调用），未做真实 API 调用；需要 App 安装与令牌才能实测，属运行环境。
  - SA-5 的兜底评论实际触发率未测（需要真实模型产出「非 v2 信封」才能复现），只按分支条件判定可达。
  - 未核查面板侧「事件开关 / 模板」的编辑入口（属于其他小节范围），本节只认定服务端按配置取值这一侧。
  - 未核查 dry-run 下 `PI_BOT_DRY_RUN` 的默认值链路（属其他小节），本节只引用执行器自身的 dry-run 分支。
