# U03 3.1 角色 · A

## 结论速览

| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| ROLE-1 提交者 | 已实现 | 无（提 issue / 补信息 / 追问 三条入口都在，回复写回评论） |
| ROLE-2 维护者 | 已实现 | 无缺路径；「关闭」受 `agent.actions.close_issue` 开关（默认 false），需配置开启 |
| ROLE-3 平台配置者 | 已实现 | 触发规则与提示词模板可写且被消费；同一 settings 里 `agent.limits` 多半字段无消费方（见 ROLE-4） |
| ROLE-4 平台运维者 | 部分实现 | 「看后台」「查会话」有路径；「调并发」仅仓库级生效、全局是部署常量；「调配额」配置读得到但无消费方，配额判定用硬编码 10 且 `createdToday` 恒 0 |

## 逐条

### ROLE-1 提交者

- 状态：已实现
- 证据：
  - `apps/server/src/http/webhook.ts:1923` — `scope.post('/webhook', …)` 是唯一事件入口，`issues` / `issue_comment` 走白名单（`webhook.ts:618-619`）。
  - `apps/server/src/http/webhook-v21.ts:85`（`v21EventKeyOf`）与 `webhook-v21.ts:96-102` — 把 `issues.opened` / `issues.edited` / `issues.labeled` / `issues.closed` / `issue_comment.created` 映射成事件键，进入 v2.1 判定链。
  - 「提 issue」建/接会话：`apps/server/src/agent/session-state.ts:134-141`（`issues.opened` → `action:'reuse'`，复用会话并重建沙箱）。
  - 首次回执：`apps/server/src/agent/ack.ts:47`（`ackReceived()`）——「问题有没有被认真看」的直接支撑。
  - 「补信息」只认正文变更：`apps/server/src/trigger/decide.ts:145-151`（`issues.edited` 且 `only_body_changed` 时，`changes` 里没有 `body` 直接 `skip('body-unchanged')`）。
  - 「追问进展」：`apps/server/src/http/webhook.ts:551-615`（评论命中 `@别名` → `agent:mention` 任务）；闸门默认 `require_mention=true`、`require_role=false`（`packages/contract/src/settings-v21.ts:108-112`），因此非维护者的提交者也能叫起来；已关闭 issue 默认不处理（`trigger/decide.ts:178-180`，与 `gates.allow_closed` 同源）。
  - 答复落地：`apps/server/src/worker/run-task.ts:1354`（`v21Config.execute(...)`）→ `apps/server/src/writeback/v21/execute.ts:471`（`comment` 动作）。
- 缺口：无实现缺失。默认要求 `@提及`、且已关闭 issue 的追问默认忽略（`allow_closed=false`），属可配置策略而非缺路径。
- 判定依据：三条声明动作分别对应「webhook 事件入口 + 会话建立/复用 + 回执/评论写回」实链路，均有 `file:line`；不是文档自述。

### ROLE-2 维护者

- 状态：已实现
- 证据：
  - 「打标」：`apps/server/src/writeback/v21/execute.ts:469`（`case 'label'`）→ `apps/server/src/github/octokit.ts:246`（`addLabels`）/ `octokit.ts:259`（`removeLabel`）；台账只撤自己打过的标签：`apps/server/src/workflows/bot-labels.ts:22`（`insertActive` 写 `bot_labels`）。
  - 「要求补充」：`apps/server/src/writeback/v21/execute.ts:471`（`case 'comment'`）→ `apps/server/src/github/octokit.ts:234`（`createIssueComment`）；另有 `update_comment` 走同一槽位覆盖（`execute.ts:485`，`octokit.ts:295`），对应「结论追加在原评论下」。
  - 「关闭」：`apps/server/src/writeback/v21/execute.ts:479`（`case 'close_issue'`）→ `apps/server/src/github/octokit.ts:284`（`closeIssue`，`PATCH /issues/{n}` `state=closed`）；开关在 `apps/server/src/worker/run-task.ts:1328`（`actionsEnabled = resolved.actions`）与 `apps/server/src/http/webhook-v21.ts:685-689` 落地。
- 缺口：无缺路径。`close_issue` 默认关闭（`packages/contract/src/settings-v21.ts:219` `default(false)`），要维护者这条动作自动发生必须先在仓库配置里打开——是既定安全默认，不是实现缺失。
- 判定依据：三个动作都能在 `execute.ts` 的 case 分支里找到，并各自落到 `octokit.ts` 的真实 REST 调用；开关只决定是否允许，不影响路径存在。

### ROLE-3 平台配置者

- 状态：已实现
- 证据：
  - 「改项目配置」写面：`apps/server/src/http/api/index.ts:319-341`（`PUT /api/repos/:owner/:name/settings`，body 直接是 `repoSettingsSchema`）→ `apps/server/src/config/repo-config.ts:449`（`updateRepoSettings`，先校验后写库，非法值一字不写）→ 读面 `repo-config.ts:255`（`readRepoPolicy`，每次读库，无长缓存）。
  - 触发规则被真正消费：`apps/server/src/config/v21-settings.ts:111`（`onlyBodyChanged`）/ `v21-settings.ts:159-175`（`resolveCommentConfig`：提及关键词 + 角色）→ `apps/server/src/trigger/decide.ts:145-163`、`decide.ts:173-181`（四道评论闸门）。
  - 「调提示词模板」：模板字段 `packages/contract/src/settings-v21.ts:85`（`triggers.events[*].prompt`，`null` = 内置默认）→ `apps/server/src/http/webhook-v21.ts:359`（`v21TemplateOf`）与 `webhook-v21.ts:464-476`（`buildV21AgentMessage` 渲染成指令文本），占位符清单与渲染在 `apps/server/src/prompt/render.ts:170`/`render.ts:193`。
  - 面板写模板的入口：`apps/panel/src/components/settings/v21-events-section.tsx:270`（`patchEvent(..., { prompt })`，清空回 `null` → 内置默认）。
  - 常驻角色设定：`apps/server/src/app/compose.ts:1407`（`resolveAgentExecution(policy.settings).system_prompt` 注入 `session/create`）。
  - 技能正文（另一种「提示词模板」）写面：`apps/server/src/http/api/skills.ts:291`/`skills.ts:325`/`skills.ts:358`（POST/PATCH 落到 `skills/store.ts`）。
- 缺口：无缺路径。同一份 settings 里 `agent.limits` 的多数旋钮（`concurrency` / `daily_quota` / `turn_timeout_minutes` / `data_retention_days`）以及 `limits.max_comments_per_hour` / `limits.max_task_minutes` 存在但无消费方——那部分归 ROLE-4 的「调并发与配额」，不影响触发规则与模板两条路径。
- 判定依据：配置写入路径存在（PUT + 校验 + 落库），且触发规则、事件模板、system prompt、技能正文四个取值点都有代码在读并用于判定/渲染，不是「字段存在但没人读」。

### ROLE-4 平台运维者

- 状态：部分实现
- 证据：
  - 「看后台」（有）：8 条只读路由 `apps/server/src/http/api/index.ts:101`（overview）/ `:138`（costs）/ `:193`（system）/ `:157`（audit）/ `:148`（quality/reverts）；面板页面存在 `apps/panel/src/routes/overview.tsx`、`costs.tsx`、`system.tsx`、`quality.tsx`、`tasks.tsx`、`audit.tsx`。
  - 「查会话」（有）：`apps/server/src/queries/issues.ts:755`（`queryIssueSession`，返回 `turns`/`events`/轮次计数）→ 路由 `apps/server/src/http/api/index.ts:216`（`GET /api/issues/:owner/:name/:kind/:number`）→ 面板 `apps/panel/src/routes/issue-detail.tsx`。
  - 「调并发」（半条）：
    - 仓库级并发真的生效：`apps/server/src/queue/repo-concurrency.ts:30-43`（读 `limits.concurrency_per_repo`，1–8 夹取）→ `apps/server/src/app/compose.ts:1507-1515`（注入 gate）→ `apps/server/src/queue/boss.ts:230-234` 与 `boss.ts:211`（`localConcurrency` + 仓库槽位）。
    - 全局并发不可调：`apps/server/src/queue/definitions.ts:93-94`（`run-task` `concurrency: 3` 常量），`boss.ts:208` 直接取它；`apps/server/src/config/env.ts` 无任何并发/配额相关 env 键。
    - `agent.limits.concurrency`（`packages/contract/src/settings-v21.ts:236`、面板 `apps/panel/src/components/settings/v21-agent-section.tsx:31`）只在 `apps/server/src/config/v21-settings.ts:210` 映射出来，全仓无第二个调用点——改它不生效。
  - 「调配额」（缺）：
    - `agent.limits.daily_quota`（`packages/contract/src/settings-v21.ts:238`）同样只在 `config/v21-settings.ts:211` 被映射；`http/webhook-v21.ts:684` 取 `resolveAgentExecution()` 后只用 `actions`，`worker/run-task.ts:1316-1328` 亦同。
    - 执行侧配额判定用的是硬编码默认值：`apps/server/src/github/executor.ts:44`（`DEFAULT_DAILY_ISSUE_QUOTA = 10`）、`executor.ts:384`（`input.dailyQuota ?? DEFAULT_DAILY_ISSUE_QUOTA`）。
    - 装配层的现状端口根本不填这两个字段：`apps/server/src/app/worker-deps.ts:1079-1085`（只返回 `{ currentLabels, botLabels }`），于是 `apps/server/src/worker/writeback.ts:445` 的 `createdToday` 恒为 `0`、`dailyQuota` 恒走默认。
    - `quota_counters` 表建了但无读写方：`apps/server/src/db/schema.ts:634`，全仓除 schema 与测试外无引用；`dailyQuotaExceeded` 只在 `trigger/decide.ts:251` 被消费，生产代码里没有任何一处把它算出来。
    - 同类死旋钮还有：`limits.max_comments_per_hour`（`packages/contract/src/repo-config.ts:129`）与 `limits.max_task_minutes`（`repo-config.ts:133`）无消费方；`turn_timeout_minutes` 被部署常量取代（`apps/server/src/runtime/turn-driver.ts:35`、`worker/run-task.ts:461-462`）；`data_retention_days` 被 `apps/server/src/jobs/retention-cleanup.ts:25`（`RETENTION_DAYS = 90`）取代。
    - 唯一真正生效的运维旋钮是排队闸门：`apps/server/src/jobs/queue-gate.ts:190`（读 `limits.queue_wait_minutes`）。
- 缺口：「调配额」没有实现路径——日配额既不读仓库配置、也不计数（`quota_counters` 空转、`createdToday` 恒 0），面板上的「日配额」是纯展示值；「调并发」只能调仓库级，全局并发与 `agent.limits.concurrency` 无效。
- 判定依据：三个动作里两个有真实读路径（GET 路由 + `queryIssueSession`），并发只有一半（仓库级生效、全局常量、`agent.limits.concurrency` 死字段），配额一条完全断在「配置字段存在但无人消费」，故取部分实现。

## 本节整体结论

四类角色里，提交者、维护者、平台配置者的声明动作都能在代码里找到从入口到写回的完整路径：提交者靠 `/webhook` 五类事件 + 会话复用，维护者靠 v2.1 信封的 `label`/`comment`/`close_issue` 动作，配置者靠 `PUT /api/repos/:owner/:name/settings` 与事件模板渲染。短板集中在平台运维者：**看后台**与**查会话**已实现，但「调并发与配额」只有仓库级并发是真的，全局并发是部署常量，`agent.limits.concurrency` 是死字段，`daily_quota` 更是「面板能改、代码不读」——执行侧配额仍用硬编码 10，且缺少任何计数来源（`quota_counters` 无读写、`createdToday` 恒 0）。这类「字段存在但未消费」的偏差最容易让人误以为已经能调，属于需求 3.1 里唯一实质缺口。

## 核查边界

- 是否执行了命令：仅只读检索，未跑测试/构建。执行了 `git status --short`（确认工作区有他人改动，全程未修改）、`Get-ChildItem`（列目录）、`Select-String`（全仓 grep）、以及对目标文件的局部 `Read`。
- 未覆盖的条目及原因：无越界核查；`docs/audit/v2/` 下其他文件按要求未读取、未列目录。运行期行为（配额是否在别处由外部作业补齐、`agent.limits` 是否被面板以外的部署脚本消费）需真实环境验证，本次仅以静态代码为据；`skills/` 写面的具体落盘细节只核到路由与 store 调用点，未逐一追踪文件 IO。
