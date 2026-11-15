# U01 2.1 目标 · A

## 结论速览

| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| G-1 | 已实现 | 无缺口；仅有一个有界例外：超过 30 轮或 7 天会轮换新会话（旧会话归档，上下文不延续） |
| G-2 | 已实现 | 无缺口；「哪些事件可配」是代码里固定的 5 个 `EventKey`，新增事件类型仍需改代码 |
| G-3 | 部分实现 | 缺「issue 会话视图里的 token 消耗」（契约 `IssueSessionResponse` 无 token 字段，页面注释写了但未实现）；另缺逐轮 assistant 文本，只有落库的评论正文 |
| G-4 | 已实现 | 平台默认只在建行时 seed 一次，事后改平台默认不回溯已存在仓库；且平台默认只能改环境变量、需重启 |

## 逐条

### G-1

- 状态：已实现
- 证据：
  - `apps/server/src/db/schema.ts:658` — `agentSessions` 表 `agent_sessions`；`apps/server/src/db/schema.ts:685` — 主键 `primaryKey({ columns: [t.repo, t.issueNumber] })`，一个 issue 只有一行会话游标。
  - `apps/server/src/agent/store.ts:152` — `loadSession` 按 `(repo, issue_number)` 点查；`apps/server/src/agent/store.ts:156` — `saveSession` 是 `INSERT … ON CONFLICT ("repo","issue_number") DO UPDATE`，一个 issue 一条会话记录。
  - `apps/server/src/app/compose.ts:423` `planAgentSession()`：`apps/server/src/app/compose.ts:443` 无 `sessionId` 才新建；`apps/server/src/app/compose.ts:466` 有 id 则返回 `{ mode:'persistent', sessionId, …(cursor>0 ? {after:cursor} : {}) }` — 复用同一会话并带 `after` 游标防重放。
  - `apps/server/src/runtime/turn-driver.ts:359` — 给了 `plan.sessionId` 就先 `session/attach` 接管已有会话；`apps/server/src/runtime/turn-driver.ts:375` — 只有拿不到会话 id 时才走 `session/create`。
  - `apps/server/src/app/compose.ts:1023` — `persistAgentSessionAfterRun()` 每轮结束后 UPSERT 回 `agent_sessions`（`turns` 递增、`cursor` 更新），下一轮才能续上。
  - `apps/server/src/agent/session-state.ts:69` — `SESSION_ACTIONS = ['create','reuse','recycle-sandbox']`，类型上不存在 `delete`/`archive`/`end`；`apps/server/src/app/compose.ts:280` — `V21_SESSION_TRANSITION_SQL` 只有 INSERT/UPDATE，无 DELETE。issue 关闭只回收沙箱（`apps/server/src/agent/session-state.ts:123`），会话与历史保留。
- 缺口：会话轮换是明写的例外 —— `apps/server/src/app/compose.ts:210` `maxTurns: 30`、`apps/server/src/app/compose.ts:211` `maxAgeDays: 7`，命中后 `apps/server/src/app/compose.ts:456` 返回 `session: { mode:'persistent' }`（不带 `sessionId`）+ `archiveSessionId` 旧会话，本轮起在新会话里跑，上一轮上下文不延续。
- 判定依据：达成标志「同一 issue 的多次处理共享 session，历史可延续」在常规路径（open 状态的连续触发、重开 issue、关闭后评论）都由 `planSessionOnEvent()` → `planAgentSession()` → `turn-driver` attach 三段落到实处，且「一个 issue 只有一个会话行」由主键与 UPSERT 保证。轮换是资源/成本上限，不是「一个事件一个会话」，属于有界例外而非反着来，故判已实现并把例外写进缺口。

### G-2

- 状态：已实现
- 证据：
  - 事件是否触发：`apps/server/src/trigger/decide.ts:226` — 读 `resolveEventTrigger(settings, event)`；`apps/server/src/trigger/decide.ts:227` — `trigger.enabled === 'off'` 直接 `switch-off`；`apps/server/src/config/v21-settings.ts:105` — `resolveEventTrigger()` 从 `settings.triggers.events[event]` 取值，纯函数、不查库。
  - 条件与闸门同样来自配置：`apps/server/src/trigger/decide.ts:146`（`only_body_changed`）、`apps/server/src/trigger/decide.ts:160`（`labels` 命中）、`apps/server/src/config/v21-settings.ts:132`（四项评论闸门）、`apps/server/src/config/v21-settings.ts:159`（提及关键词与角色）。
  - 用哪套提示词（事件模板）：`apps/server/src/trigger/decide.ts:257` — `trigger.prompt`，空白则回落 `DEFAULT_EVENT_TEMPLATES[event]`（`apps/server/src/trigger/decide.ts:258`）；`apps/server/src/http/webhook-v21.ts:1016` — 落库正文直接用 `decision.template` 渲染。
  - 用哪套提示词（身份/system 通道）：`apps/server/src/config/v21-settings.ts:200` — `resolveAgentExecution()` 取 `agent.system_prompt`，两处都空才回落内置 `AGENT_IDENTITY_PROMPT`；`apps/server/src/app/compose.ts:1407` — 装配层把结果交给任务；`apps/server/src/runtime/turn-driver.ts:386` — 只在新建会话时作为 `session/create` 的 `systemPrompt` 生效。
  - 改配置不改代码的闭环：`apps/server/src/http/api/index.ts:319` — `PUT /api/repos/:owner/:name/settings`；`apps/server/src/config/repo-config.ts:193` — `updateSettings` 写 `repos.settings` 并同步 `enabled`/`dry_run` 列；面板侧 `apps/panel/src/lib/api.ts:216` — `saveRepoSettings` 发 PUT，`apps/panel/src/components/settings/use-settings-draft.ts:81` — 设置页的 mutation 真的调它。
- 缺口：可配的是每个事件「开/关、附加条件、闸门、模板」与 system prompt；事件类型本身是代码里固定的 5 个键（`apps/server/src/agent/session-state.ts:30` 的 `SESSION_EVENT_KEYS`），新增事件种类仍需改代码。
- 判定依据：需求写的是「事件是否触发、用哪套提示词由配置决定」，两件事都有「配置 → 判定 → 执行」的完整路径，且写入面在面板设置页可达，无需改代码即可改行为。事件类型枚举固定不在该句语义内，只作注释。

### G-3

- 状态：部分实现
- 证据（已有）：
  - 事件全量落库：`apps/server/src/worker/run-task.ts:975` — 除 `item.delta`（流式增量）外每条事件都 `appendEvent`；`apps/server/src/db/schema.ts:296` — `run_events` 表，`apps/server/src/db/schema.ts:310` 有 `(run_id, cursor)` 唯一索引。
  - 每次工具调用可查：`apps/server/src/queries/issues.ts:958` — 从 `run_events` 取 `item.started`/`tool.progress`/`item.completed` 且 `payload->>'itemType'='tool'`；`apps/server/src/queries/issues.ts:965` 按 `toolCallId` 归并成一次调用（名字取 `item.started` 的 `toolName`，`apps/server/src/queries/issues.ts:941`）；出口在 `apps/server/src/queries/issues.ts:995` 填 `IssueToolCall`，契约 `packages/contract/src/api.ts:958`（`toolCalls` 最多 50 条 + `truncated`）。
  - 完整对话（轮次视图）：`apps/server/src/queries/issues.ts:1008` 人类轮 + 机器人轮合并排序，正文取 `packages/contract/src/api.ts:942` 的 `text`（≤40k）；面板渲染在 `apps/panel/src/routes/issue-detail.tsx:229`（逐轮）与 `apps/panel/src/routes/issue-detail.tsx:333`（工具调用列表）。
  - token 有真实采集路径：`apps/server/src/worker/run-task.ts:1595` — 从 pi-host `pi.sqlite` 的 `turns` 读真实用量（`apps/server/src/cost/host-usage.ts:73`），`apps/server/src/worker/run-task.ts:1600` 调 `recordUsage`；`apps/server/src/worker/run-store.ts:91` — `insert into usage_costs`。
  - token 有页面出口（但不是 issue 会话页）：`apps/server/src/queries/costs.ts:78` 按窗口汇总；`apps/server/src/queries/tasks.ts:145` 任务级 `costUsd`；面板 `apps/panel/src/routes/costs.tsx:170` 展示入/出 token，`apps/panel/src/routes/task-detail.tsx:289` 展示单轮 token 与金额。
- 缺口（点名两个）：
  1. **issue 会话视图没有 token 消耗**：契约 `packages/contract/src/api.ts:1092` 的 `IssueSessionResponse` 只有 `issue` + `turns`，`IssueTurn`（`packages/contract/src/api.ts:931`）没有任何 token/成本字段；页面注释 `apps/panel/src/routes/issue-detail.tsx:33` 写着「头部一条会话栏（会话 id / issue / 轮次 / 累计 token）」，但实际表头 `apps/panel/src/routes/issue-detail.tsx:196` 只渲染 Issue / 轮次 / 人类 / 机器人 / 标签 —— 注释承诺了、实现没有，查询层也没聚合。
  2. **「完整对话」只到落库的评论正文**：`IssueTurn.text` 取的是该轮产出的评论正文（一次任务一轮），没有逐轮 assistant 文本/推理流；`apps/server/src/queries/system.ts:38` 的 `RETENTION.transcriptDays: 90` 只出现在保留期常量里，全仓没有 transcript 表、写入或查询出口。
- 判定依据：三项子条件里「每次工具调用」与「完整对话（评论级）」已实现，「token 消耗」在后台（成本页/任务详情）可见但 issue 会话页缺失，且页面注释与实现不符 —— 属于需求明写的子条件在指定视图缺失，判部分实现。

### G-4

- 状态：已实现
- 证据：
  - 平台级默认：`apps/server/src/config/repo-config.ts:42` — `REPO_SETTINGS_ENV = 'PI_BOT_DEFAULT_SETTINGS'`；`apps/server/src/config/repo-config.ts:55` — `loadDefaultRepoSettings()` 解析内联 JSON 或文件，未设置则用契约默认 `DEFAULT_REPO_SETTINGS`（`apps/server/src/config/repo-config.ts:61`）；`apps/server/src/config/repo-config.ts:99` — 进程内缓存的 `defaultRepoSettings()`；`apps/server/src/config/repo-config.ts:120` — `defaultRepoSettingsStatus()` 判它是否算合法运行配置。
  - 项目级可覆盖：`apps/server/src/db/schema.ts:156` — `repos.settings` jsonb（每仓库一份）；`apps/server/src/config/repo-config.ts:399` `upsertRepo()` 在建行时把平台默认 seed 进 `repos.settings`（默认分支见 `apps/server/src/config/repo-config.ts` 内 `input.settings === undefined` → `defaultRepoSettingsStatus()`），之后只认库里的值；`apps/server/src/config/repo-config.ts:193` — `updateSettings` 覆盖；写入面 `apps/server/src/http/api/index.ts:319`（PUT）+ `apps/server/src/http/api/index.ts:344`（POST 添加仓库时 seed），面板 `apps/panel/src/components/settings/use-settings-draft.ts:81`。
  - 不同仓库互不干扰：所有业务表带 `repo` 列且按仓隔离 —— `apps/server/src/db/schema.ts:662`（`agent_sessions.repo` + 主键含 `issue_number`）、`apps/server/src/db/schema.ts:709`（`agent_messages`）、`apps/server/src/db/schema.ts:637`（`quota_counters.repo`，配额按仓库计）；查询按仓库过滤，如 `apps/server/src/queries/issues.ts:788`（`where t.repo = $1 …`）、`apps/server/src/queries/issues.ts:916`；未知仓库一律不开工：`apps/server/src/config/repo-config.ts:239` — `UNKNOWN_REPO_POLICY`（`enabled:false`）。
- 缺口：平台默认只来自进程环境变量且**只在建行时 seed 一次**（`apps/server/src/config/repo-config.ts:179` 的 UPSERT 明确「冲突时不覆盖 settings」），所以事后调整平台默认既需要重启进程、也不会回溯已存在的仓库；没有运行时可编辑的「平台设置」表/页面。
- 判定依据：达成标志的两半——「平台级给默认」「项目级可覆盖」——分别由环境变量默认值与 `repos.settings` + PUT 写面实现，互不干扰由全表 `repo` 列、按仓库配额与未知仓库默认拒绝保证。平台默认不可运行时编辑属于配置来源的限制，不推翻分层默认与隔离这两项事实。

## 本节整体结论

四条目标里 G-1、G-2、G-4 有完整的「配置/状态 → 执行」路径，不是只有表结构：会话复用在 `planAgentSession()` → `turn-driver` attach 上落地，事件与提示词由 `repos.settings` 经 `decideEvent()` / `resolveAgentExecution()` 生效，平台默认与项目覆盖走 `PI_BOT_DEFAULT_SETTINGS` seed + `repos.settings` 覆盖。G-3 是唯一有实质缺口的一条：工具调用与轮次正文可查，但 token 消耗在 issue 会话视图里既没有契约字段也没有查询聚合，页面注释承诺的「累计 token」并不存在；同时「完整对话」实际只是每轮落库的评论正文，保留期常量里的 transcript 没有对应存储。两处都值得在文档或实现上收口，而不是留在注释里。

## 核查边界

- 是否执行了命令：只执行了只读的检索命令（`git status --short`、`Get-ChildItem`、`Select-String` 定位 `file:line`）；未运行 `pnpm typecheck` / `pnpm lint` / 任何测试，未启动服务，未连接 PG 或 Docker。
- 未覆盖的条目及原因：无条目被跳过。但以下判定依赖运行环境、本次未验证：① G-1 的 `session/attach` 是否在真 host 上成功（失败会退化为新建会话，`apps/server/src/runtime/turn-driver.ts:372` 只是 warn 不阻塞），需真 host 才能确认实际延续率；② G-3 的 token 是否非零，取决于宿主 `pi.sqlite` 的 `turns` 表是否有数据 —— 读不到时 `apps/server/src/cost/host-usage.ts:87` 静默返回 `null`，`usage_costs` 不写、页面显示无用量；③ G-4 的平台默认 seed 是否生效取决于部署是否设置了 `PI_BOT_DEFAULT_SETTINGS`，以及库里 `repos.settings` 的既有值。此外本报告只认代码与 `file:line`，未采信文档自述；`apps/panel/dist` 构建产物未纳入核查。
