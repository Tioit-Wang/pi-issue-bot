# U03 3.1 角色 · B

> 反证视角：默认「每条动作都还没真正实现」，只有找到「写入 → 存储 → 读取 → 影响运行」四环贯通的代码证据才推翻假设。
> 核查对象：`docs/requirements.html` 行 587-590（四类角色的「在系统中的动作」）。

## 结论速览

| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| ROLE-1 提交者 | 已实现 | 三个动作（提 issue / 补信息 / 追问）都落在同一条会话链上；仅「旧命令通道」残留一处已失效的管理员断言（不影响本角色的三个动作） |
| ROLE-2 维护者 | 部分实现 | 「关闭」只回收沙箱/会话，**不取消已排队与在跑的任务**；「打标」的人工标签可被 bot 的目标态对齐删掉（`botLabels` 只作审计归属，不参与过滤） |
| ROLE-3 平台配置者 | 部分实现 | 改配置/改事件模板即时生效；但 `agent.system_prompt` **只在新建会话时下发**，已有持久会话里的改动不生效 |
| ROLE-4 平台运维者 | 部分实现 | 看后台、查会话贯通；「调并发」只有 `limits.concurrency_per_repo` 被消费（`agent.limits.concurrency` 无消费方）；「调配额」`daily_quota` 只有字段与一个永远为假的判定分支，**没有任何计数器与执行点** |

## 逐条

### ROLE-1

- 状态：已实现
- 反证过程：
  1. **假设「提 issue 没有入口」**——查事件键映射与默认开关：五个事件键里 `issues.opened` 默认 `on`，映射表把 `issues.opened` 直接映到该键，开关打开即触发，推翻。
  2. **假设「补信息（编辑正文）走不到会话」**——查 `only_body_changed` 的默认值与条件判定：默认 `true`，`changes` 里没有 `body` 才跳过；有 `body` 就继续走同一条链路，推翻。
  3. **假设「追问进展会新开一条会话」**——查会话迁移纯函数：issue 处于 open 的普通事件（含评论）走「复用会话，沙箱缺失才重建」，推翻。
  4. **假设「追问进展被角色闸门挡住（提交者不是维护者）」**——查四闸门默认值：`require_mention=true` / `require_role=false`，即默认只要 @ 到关键词就放行，不要求作者关联；推翻。
  5. **假设「触发后只留痕不入队」**——查 `handleV21Webhook` 的触发分支：渲染 → 落 `agent_messages` → 立即 `dispatchAgent`，`enqueued` 返回，推翻。
  6. **反向残留**：旧命令通道（`submitAgentMessage`）里那条「@ 仅管理员」断言读的是 `settings.managers`，而 `repoSettingsSchema` 已把该键搬到 `agent.managers` 且 `.strict()` 拒收顶层 `managers`；该分支只在 `deps.v21` 未注入或 `source==='command'` 时到达，v2.1 路径不经过它，因此不构成本角色三个动作的缺口（作为残留问题记在「本节整体结论」）。
- 证据：
  - `apps/server/src/http/webhook-v21.ts:85` — `v21EventKeyOf()` 把 `issues.opened/edited/labeled/closed`、`issue_comment.created` 映成事件键。
  - `packages/contract/src/settings-v21.ts:328` — `issues.opened` 默认 `enabled:'on'`；`:329` — `issues.edited` 默认 `on` + `only_body_changed:true`；`:332` — `issue_comment.created` 默认 `conditional` + 四闸门。
  - `packages/contract/src/settings-v21.ts:108` — `require_mention` 默认 `true`；`:110` — `require_role` 默认 `false`（提交者不被角色闸门排除）。
  - `apps/server/src/trigger/decide.ts:145` — `issues.edited` 只认正文变更的条件判定；`:173` — 四闸门顺序判定。
  - `apps/server/src/http/webhook.ts:1164` — 每条投递都 `readRepoPolicy()` 现读配置；`:1195` — 交给 `decideV21Delivery()` 判定。
  - `apps/server/src/http/webhook-v21.ts:1029` — 触发后把渲染结果写入 `agent_messages.comment_body`；`:1047` — 立即 `dispatchAgent` 领任务；`:1068` — 返回 `enqueued`。
  - `apps/server/src/agent/session-state.ts:155` — 常规事件（含评论）「复用会话」；`:123` — 关闭事件只回收沙箱。
  - `apps/server/src/writeback/v21/execute.ts:471` — `case 'comment'` 是 agent 回落评论的动作；`:638` — 走 `planSlotWrite()` 按 `(repo, issue, slot)` 覆盖（`writeback/v21/comments.ts:161`）。
- 缺口：无（本角色的三个动作链路贯通）；不覆盖「追问进展」在 issue 已关闭时的表现（默认 `allow_closed=false`，属项目配置项，不是链路缺失）。
- 判定依据：三个动作各自找到「事件 → 判定 → 消息落库 → 派发 → 会话复用 → 回落评论」的完整代码路径，且默认配置下都能触发（`opened`/`edited` 默认 `on`，评论默认只需 @ 关键词、不限角色）。

### ROLE-2

- 状态：部分实现
- 反证过程：
  1. **假设「维护者打标在系统里没有反应」**——`issues.labeled` 事件键存在且默认为 `conditional`，附加条件是「命中所配标签」，默认标签表为空 = 永不触发。链路存在（配置后可用），但默认配置下这条动作没有任何系统反应 → 记为「链路可通、默认不通」。
  2. **假设「维护者打的标签会被 bot 撤掉」**——查目标态对齐：`remove = current ∩ 可管理目录 − desired`，`botLabels` 只用于 `deletionOwner()` 审计归属、注释明写「不参与过滤」；执行层逐条 `removeLabel()`。即「人在词表内打的标签」会被 bot 的完整目标态删掉，只有「人撤过我们的标签」（`human-veto`）这一种人工意图被尊重。此检查点被推翻（确实存在覆盖风险）。
  3. **假设「要求补充没有入口」**——维护者在评论区 @ 机器人走与 ROLE-1 相同的评论链路（四闸门 + 会话复用），并有 `comment` 写回动作；链路贯通。
  4. **假设「关闭 issue 会停止这个 issue 的任务」**——查 `issues.closed` 的处置：只更新会话状态（`recycle-sandbox`，`idle`，会话保留），webhook 侧只做会话迁移不做任务取消；全仓取消任务的入口只有排队闸门（按 `queue_wait_minutes` 超时取消）。即「维护者关单 → 已排队/在跑的任务照旧执行」，此检查点被推翻。
- 证据：
  - `packages/contract/src/settings-v21.ts:330` — `issues.labeled` 默认 `conditional` + `labels: []`（空 = 永不触发）；`:331` — `issues.closed` 默认 `off`。
  - `apps/server/src/trigger/decide.ts:154` — `labeled` 的「标签命中」附加条件；未命中记 `label-not-matched`。
  - `apps/server/src/workflows/normalize.ts:19` — 人工否决（人撤掉我们的标签）→ `human-veto`；`:218` — 否决项落 `blocked` 留痕；`apps/server/src/worker/writeback.ts:191` — 执行前读 `humanVetoed`。
  - `apps/server/src/writeback/v21/labels.ts:70` — `remove` 的集合公式（`current ∩ 可管理目录 − desired`）；`:62` — `botLabels`「决定删除的 owner（审计用，不参与过滤）」；`:130` — `deletionOwner()` 仅用于区分审计归属。
  - `apps/server/src/writeback/v21/execute.ts:555` — 逐条 `api.removeLabel()`；`:534` — 删除归属只写进 `owners` 审计。
  - `apps/server/src/agent/session-state.ts:123` — `issues.closed` + 已关闭 → `recycle-sandbox` / `idle` / `keepSession`。
  - `apps/server/src/http/webhook.ts:1210` — 关闭事件只调 `applyV21SessionOnEvent()`（会话迁移），无任务取消。
  - `apps/server/src/jobs/queue-gate.ts:8` — 唯一的任务取消口径是「排队超 `queue_wait_minutes`」→ `cancelled_queue`。
- 缺口：
  1. 「关闭」缺最后一环：`issues.closed` 不取消该 issue 已 `queued` 的任务、也不中断 `running` 任务（只有排队超时与生命周期扫描会收尾），「关单即停」不成立。
  2. 「打标」的人工意图保护不完整：只有「人撤过我们的标签」被记为否决；人**新加**的、且在可管理词表内的标签会被下一次目标态对齐删除（不变量 `标签只撤 bot_labels 记过的` 在这一支上未落实）。
  3. 「打标」默认不产生系统动作（`labels: []`），要维护者先在面板配触发标签，否则 `issues.labeled` 一律 `label-not-matched`。
- 判定依据：三个动作都有代码路径，但「关闭」缺少「停止在途任务」这一段、「打标」缺少「人打的标签不被覆盖」这一段，且默认配置下打标不触发，故不足以判「已实现」。

### ROLE-3

- 状态：部分实现
- 反证过程：
  1. **假设「没有配置写入 API」**——`PUT /api/repos/:owner/:name/settings` 存在，注入 `pool` 后挂载；另有 `GET /api/repos`、`POST /api/repos`。推翻。
  2. **假设「写进去但没人读/要重启才生效」**——写侧只落 `repos.settings`（jsonb）+ 同步 `enabled/dry_run` 两列；读侧每条 webhook 投递现读一次、每个任务开跑前现读一次，装配层注释明确「避免仓库配置改了但 worker 还读旧值」。推翻（热生效成立）。
  3. **假设「非法配置会把线上弄哑」**——写库前必校验，失败一字不写（last-known-good），webhook 继续按旧值工作。推翻。
  4. **假设「事件提示词模板改了不被读取」**——`decideEvent()` 用 `resolveEventTrigger().prompt` 解析（空白回落内置默认），渲染走 `renderTemplateAsync`，模板正文进 `agent_messages.comment_body`。推翻。
  5. **假设「项目补充提示词字段是死字段」**——`project_prompt` 进事件消息正文（`{project_prompt}` 段）。推翻。
  6. **假设「系统提示词改了对当前会话生效」**——`system_prompt` 经 `session/create` 下发，注释明写「只在新建会话时生效」，轮换/新会话才吃新值。此检查点被推翻（缺一环）。
- 证据：
  - `apps/server/src/http/api/index.ts:319` — `PUT /api/repos/:owner/:name/settings`；`:331` — 调 `updateRepoSettings()`；`:94` — `/api/*` 前置鉴权。
  - `apps/server/src/http/server.ts:280` — `repos: { db: deps.pool }`（写面在真实装配里挂载）。
  - `apps/server/src/config/repo-config.ts:449` — 校验失败不写库（last-known-good）；`:193` — `updateSettings` 同时同步 `enabled/dry_run`。
  - `apps/panel/src/lib/api.ts:216` — 面板 `saveRepoSettings()` → `PUT .../settings`；`apps/panel/src/components/settings/use-settings-draft.ts:80` — 保存 mutation。
  - `apps/server/src/http/webhook.ts:1164` — 每条投递现读策略；`apps/server/src/app/compose.ts:838` — v2.1 执行器的 `settings(repo)` 每次现读；`:1113` — 任务开跑前再读一次；`:1399` — 注释「避免仓库配置改了但 worker 还读旧值」。
  - `apps/server/src/config/v21-settings.ts:105` — `resolveEventTrigger()` 取事件模板；`apps/server/src/http/webhook-v21.ts:359` — 空白模板回落内置默认；`:464` — 渲染用判定侧已解析的模板；`:476` — `renderV21AgentText()`。
  - `apps/server/src/agent/message.ts:278` — `project_prompt` 进消息正文。
  - `apps/server/src/config/v21-settings.ts:200` — `resolveAgentExecution()` 裁决 `system_prompt`（空则内置默认）；`apps/server/src/app/compose.ts:1407` — 交给 `session/create`；`apps/server/src/worker/run-task.ts:833` — 注释「只会进 `session/create`」；`:915` — 「只在新建会话时生效」。
- 缺口：「调提示词模板」中的 `agent.system_prompt` 对**已存在的持久会话**不生效（只在新建会话 / 轮换后生效）；`agent.limits.system_prompt` 这条备用路径同样如此。事件模板与 `project_prompt` 无此问题。
- 判定依据：配置写入、存储、读取、热生效四环对「改项目配置」与「事件模板/项目补充提示词」都贯通；`system_prompt` 的「影响运行」一环受会话生命周期限制，故只判部分实现。

### ROLE-4

- 状态：部分实现
- 反证过程：
  1. **假设「没有后台读面」**——`GET /api/overview|tasks|tasks/:id|costs|quality/reverts|audit|audit/export.csv|system|issues` 全部注册并挂契约 schema，面板有对应路由页。推翻。
  2. **假设「查不了会话」**——`GET /api/issues/:owner/:name/:kind/:number` 走 `queryIssueSession()`，返回 issue 摘要 + `turns`（人/自动/机器人轮次、工具调用、截断标记），面板 `issueSession` 查询直接消费。推翻。
  3. **假设「调并发只存在于 schema」**——分两个旋钮查：
     - `settings.limits.concurrency_per_repo`：面板可写 → 落库 → 每次领任务前 `readRepoPolicy()` 现读 → `RepoConcurrencyLimiter.run()` 按仓库限流；`queue/boss.ts` 在 handler 里真的 `await limiter.run(...)`。贯通。
     - `settings.agent.limits.concurrency`（面板「并发会话数（1–8）」）：只被 `resolveAgentExecution()` 复制到返回值，**全仓无消费方**（调用方只用 `system_prompt` 与 `actions`）。判「只有字段」。
  4. **假设「日配额只有字段、没有计数器」**——查三处：
     - 契约默认 `daily_quota: 100`，面板有输入框并承诺「超出的拒绝处理并记录原因」；
     - `decideEvent()` 有 `daily-quota` 跳过分支，但**没有任何生产调用方传 `dailyQuotaExceeded`**（`webhook.ts` 只传 `repoDisabled`）；
     - 库里有 `quota_counters` 表，但全仓没有一处读写它。
     结论：写入 → 存储 → 读取（`resolveAgentExecution`）→ **影响运行（无）**，此检查点未被推翻。
- 证据：
  - `apps/server/src/http/api/index.ts:100` — `GET /api/overview`；`:110` — `/api/tasks`；`:137` — `/api/costs`；`:157` — `/api/audit`；`:192` — `/api/system`；`:204` — `/api/issues`。
  - `apps/server/src/http/api/index.ts:215` — `GET /api/issues/:owner/:name/:kind/:number`；`apps/server/src/queries/issues.ts:755` — `queryIssueSession()`；`:1008` — 组装 `turns`；`apps/panel/src/lib/queries.ts:171` — 面板消费该接口。
  - `apps/panel/src/components/settings/v21-agent-section.tsx:38` — 「并发会话数（1–8）」写 `agent.limits.concurrency`；`:98` — 「仓库级并发（1–8）」写 `limits.concurrency_per_repo`。
  - `apps/server/src/app/compose.ts:1511` — worker 注册时注入仓库级闸门；`:1513` — `limitFor` 每次现读 `readRepoPolicy()`；`apps/server/src/queue/boss.ts:218` — 领到任务先问上限；`:219` — `limiter.run(repo, limit, …)`；`apps/server/src/queue/repo-concurrency.ts:30` — `concurrencyPerRepoOf()` 只读 `limits.concurrency_per_repo`（带 1–8 夹取）。
  - `apps/server/src/config/v21-settings.ts:210` — `concurrency: limits.concurrency` 仅透传，调用方（`compose.ts:1407`、`run-task.ts:1328`、`webhook-v21.ts:686`）都不读它。
  - `packages/contract/src/settings-v21.ts:238` — `daily_quota` 默认 100（面板 `v21-agent-section.tsx:45` 承诺「超出的拒绝处理并记录原因」）。
  - `apps/server/src/trigger/decide.ts:251` — `dailyQuotaExceeded === true → skip('daily-quota')`；`apps/server/src/http/webhook.ts:1195` — 生产调用只传 `repoDisabled`（不传配额）；`apps/server/src/http/webhook-v21.ts:168` — 该入参只是可选透传。
  - `apps/server/src/db/schema.ts:634` — `quota_counters` 表（`(repo, kind, window_start)` 唯一）；全仓除 schema 声明外无任何读写（`grep quota_counters` 只命中 `db/schema.ts` 与导出清单）。
- 缺口：
  1. 「调并发」：`agent.limits.concurrency`（面板叫「并发会话数」）无消费方，改它不改变任何运行行为；真正生效的是 `limits.concurrency_per_repo`，且全局并发被 `QUEUES.run-task` 的常量 3 钉死。
  2. 「调配额」：`agent.limits.daily_quota` 没有任何计数器与执行点——`quota_counters` 表空转，`decideEvent()` 的 `daily-quota` 分支在生产路径永不触发，「超出拒绝并记录原因」不成立。
- 判定依据：「看后台」「查会话」两条动作链路贯通；「调并发」两个旋钮只通一个；「调配额」四环只通两环（写入/存储/读取，缺计数与执行），故整体判部分实现。

## 本节整体结论

四类角色的动作里，提交者那条链最完整：`opened` / `edited` / 评论三个事件都能独立走到「渲染 → 落消息 → 派发 → 复用同一会话 → 回落评论」，默认配置下不需要额外设置就能跑通。维护者的三条动作都有入口，但「关闭」止步于会话与沙箱回收，不打断在途任务；「打标」在词表内的标签会被 bot 的目标态对齐收回，人工意图只有「撤标」这一种被记住。平台配置者的写入/读取/热生效链条是通的（每条投递、每个任务都现读 `repos.settings`），唯一断点是 `system_prompt` 只在新会话下发。运维者的两个「旋钮」问题同源：契约与面板都有字段，但 `agent.limits.concurrency` 与 `agent.limits.daily_quota` 在服务端没有消费方——`quota_counters` 表建了却没有读写，`daily-quota` 判定分支没有任何调用方传值，属于典型的「配置项存在但不生效」。另外发现一处与本表无直接关系、但值得登记的残留：旧命令通道 `webhook.ts:1550` 用 `settings.managers` 判管理员，而该键已迁到 `agent.managers`（`repoSettingsSchema` 顶层 `managers` 会被 `.strict()` 拒收），这条断言在旧通道上恒为假——v2.1 路径不经过它，因此不影响 U03 的四条判定，但会让「未注入 v2.1 的装配」里所有 @ 被拒。

## 核查边界

- 是否执行了命令：执行了只读命令 `git status --short`（确认工作区状态，未改动任何文件）与 `grep`/文件读取检索；未运行
  `pnpm -r test`、`pnpm lint`、`typecheck`、任何迁移或服务启动，未连接真实数据库/GitHub，未对 dry-run 或真实投递做运行时验证。
- 未覆盖的条目及原因：
  - 未做运行时验证（无 DB / 无 GitHub App / 无 Docker）：所有「生效」结论都基于调用链静态阅读，尤其 ROLE-4 的仓库级并发闸门只在装配层看到 `limitFor` 注入，未实测限流效果。
  - 「提交者对已关闭 issue 追问」「维护者角色闸门 `allow_roles` 的实战表现」属于触发规则（§6.6 / FR-2.4）配置面，本表未展开。
  - 未核查面板侧各页面的可用性（仅确认路由与查询函数存在），未核查 `apps/panel/dist` 是否与源码同步（`dist` 为构建产物，未作为证据）。
  - 未读取 `docs/audit/v2/` 下任何其他文件（按任务约束）。
