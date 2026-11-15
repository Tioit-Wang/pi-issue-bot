# U23 7 业务规则 BR-1 ~ BR-12 · A

> 核查范围：docs/requirements.html 行 1779-1801
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览

| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| BR-1 会话唯一 | 部分实现 | 映射一对一由主键保证；「不允许并发创建」没有 DB 约束（无 `(repo,issue_number) WHERE status='running'` 部分唯一索引），代码自述并发窗口 |
| BR-2 串行消费 | 部分实现 | 排队/顺序/跨 issue 并行都在；同 issue「只跑一轮」是快照判定，并发认领时同一 issue 可同时两条 `running` |
| BR-3 事件幂等 | 部分实现 | 三层键都在；「上一轮失败的不算重复」未实现——失败行永久占用 fingerprint，同内容再来被判 duplicate |
| BR-4 增量投喂 | 与需求冲突 | 五条内置事件模板每条都带整篇正文快照，后续事件照样重发全文，且全仓无「首轮/后续」判别 |
| BR-5 会话域隔离 | 与需求冲突 | 会话键只有 `(repo, issue_number)`、任务 `target_kind` 写死 `'issue'`，PR 上的 `issue_comment` 不判 `pull_request` 就按 issue 会话处理 |
| BR-6 不触发也留痕 | 部分实现 | `decision`/`decision_reason` 写入完整；全仓零读取方，后台不可查；内容重复还被记成 `triggered` |
| BR-7 失败可见 | 已实现 | 兜底评论（评论类命令）+ `confused` 角标 + `run_events`/`runs.failure_class`；v2 分支不发兜底评论（有替代可见反馈） |
| BR-8 配置即快照 | 已实现 | 判定与渲染共用一次 `readRepoPolicy()` 的同一份 `policy.settings`，渲染复用 `decision.template` 不再二次解析 |
| BR-9 标签以目录为准 | 部分实现 | 「目录外不可打」已实现；「与 GitHub 保持一致」无同步/漂移路径，v2 加标签也不校验仓库是否真有该标签 |
| BR-10 删除留痕 | 部分实现 | 原主人只在 `actions.audit.detail` 一句话里（`label/human`），无结构化字段；删除原因没有落库；`/api/audit` 不输出 `detail` |
| BR-11 标签管辖边界 | 与需求冲突 | `managed=false` 既不删不加已实现；旧 4-intent 写回路径仍保留 `human-veto`（人删过就永久不加回），需求已明确取消 |
| BR-12 无语义不删 | 部分实现 | v2.1 路径按 `meaning` 保护；旧写回路径删除只看 `bot_labels`，不看目录含义 |

## 逐条

### BR-1

- **状态**：部分实现
- **证据**：
  - `apps/server/src/db/schema.ts:658` — `agent_sessions` 主键 `(repo, issue_number)`，一个 issue 只能有一行会话（同样见 `apps/server/src/db/schema.ts:685`）。
  - `apps/server/src/http/webhook-v21.ts:786` — 会话行创建 `INSERT ... ON CONFLICT ("repo","issue_number") DO NOTHING`（到 `:802`），并发建行被主键吃掉。
  - `apps/server/src/agent/store.ts:106` — `queuedIssues` 排除已有 `running` 的 issue；`apps/server/src/agent/store.ts:124` — `claimOldest` 用单条 `UPDATE … FOR UPDATE SKIP LOCKED` + `NOT EXISTS (running)` 认领（到 `:139`）。
  - `apps/server/src/agent/dispatcher.ts:20` — 文件头自述：「已知窗口：两个 dispatcher 真同时进 claimOldest 时仍可能各领到同一 issue 的不同消息……要彻底消灭需要一条部分唯一索引（`(repo, issue_number) WHERE status='running'`）」。
  - `apps/server/src/agent/store.ts:156` — `saveSession` 是 UPSERT 后写覆盖（到 `:163`、`:377-391`），会话 id 无 CAS。
  - `apps/server/src/app/compose.ts:978` — webhook 即时投递直接在请求里调 `dispatchNextForIssue`，与 cron 调度（`apps/server/src/jobs/agent-dispatch.ts:43`）并发；`apps/server/src/queue/definitions.ts:152` 的 `concurrency: 1` 只约束 agent-dispatch 队列本身。
  - `apps/server/src/app/compose.ts:1228` — 每轮 `planAgentSession()` 给 `{mode:'persistent'}`（无 sessionId），由 `apps/server/src/runtime/turn-driver.ts:375` 新建 RACP 会话。
  - `migrations/0006_agent.sql:45` — `agent_messages` 只有普通索引 `agent_messages_queue_idx`，无 `running` 部分唯一索引。
- **缺口**：需求写明的子条件「不允许并发创建」没有数据库级保证。缺一条 `(repo, issue_number) WHERE status='running'` 的部分唯一索引/会话创建锁；在上述窗口内两个 run 可各自 `session/create`，随后 `saveSession` 覆盖，映射仍只有一行但宿主侧存在两个会话，先建的那个成为孤儿。
- **判定依据**：一对一映射（PK）与建行幂等可以定位到生效代码，属实现；「同刻只一个活跃会话 + 不允许并发创建」依赖应用层快照判定，代码自己承认窗口存在且所需索引未建，故不能判已实现。

### BR-2

- **状态**：部分实现
- **证据**：
  - `apps/server/src/agent/store.ts:106` — 有待处理消息的 issue 列表排除已有 `running` 的 issue，按最老 `created_at` 排序。
  - `apps/server/src/agent/store.ts:124` — 认领语句 `ORDER BY "created_at" ASC, "fingerprint" ASC LIMIT 1 FOR UPDATE SKIP LOCKED` + `NOT EXISTS (running)`，置 `running` 与选中在同一条 UPDATE 内。
  - `apps/server/src/queue/definitions.ts:146` — `agent-dispatch` 并发 1（注释说明「不是性能取舍，是语义」）。
  - `apps/server/src/agent/dispatcher.ts:161` — 一轮扫描「每个 issue 只领一条」；`apps/server/src/agent/dispatcher.ts:192` — 任务结束立刻领同 issue 下一条。
  - 跨 issue 并行：`apps/server/src/queue/definitions.ts:88-96`（run-task 并发 3）+ `apps/server/src/queue/repo-concurrency.ts:18`（仓库级默认 2）。
  - `apps/server/test/agent-serial-queue.test.ts:178` — 真 PG 用例：连发 3 条全部入队、一次只跑一条、按 `created_at` 顺序；`:212` — 不同 issue 可并行。
- **缺口**：串行成立的前提是「已有一条 `running`」。并发认领（webhook 即时投递与 cron 调度同刻进 `claimOldest`，见 BR-1 证据）时 `SKIP LOCKED` 会让第二条语句跳过被锁的行、改选同一 issue 的下一条消息，而 `NOT EXISTS (running)` 读的是语句快照，于是两条同时被置 `running` → 同 issue 两轮并行。缺 DB 级唯一约束兜底。
- **判定依据**：队列、顺序、只领一条、跨 issue 并行都能定位到生效代码并有具体断言；但「同一时刻只允许一轮在跑」在并发认领下不成立，属子条件缺失。

### BR-3

- **状态**：部分实现
- **证据**：
  - 投递级：`apps/server/src/http/webhook.ts:95` — `INSERT … ON CONFLICT ("delivery_id") DO NOTHING`，命中即 `200 duplicate`（`apps/server/src/http/webhook.ts:1100-1122`）。
  - 事件级：`apps/server/src/agent/fingerprint.ts:36` — `eventFingerprint = sha256(repo, issue, 'event', templateId, issue.updated_at)`，作为 `agent_messages` 主键第三段（`apps/server/src/db/schema.ts:727`）；任务侧另有 `tasks.idempotency_key` 唯一索引。
  - 内容级：`apps/server/src/agent/fingerprint.ts:59` — `commentFingerprint = sha256(repo, issue, 'comment', 归一化正文)`（与作者无关、issue 内作用域）；入口 `apps/server/src/http/webhook-v21.ts:903`（到 `:922`）。
  - 同 issue 同内容只处理一次：`apps/server/src/agent/store.ts:95`（`ON CONFLICT … DO NOTHING`，冲突即 `inserted=false`）；`apps/server/src/http/webhook-v21.ts:1038` 命中即返回 `duplicate`。
  - 失败释放：`apps/server/src/agent/dispatcher.ts:136` 投递失败、`apps/server/src/app/compose.ts:1085` 任务失败都只把消息置 `failed`；`apps/server/src/agent/store.ts:279` 的 `markMessage` 只有 UPDATE，全仓无 `DELETE FROM agent_messages`（`apps/server/src/jobs/retention-cleanup.ts:55`、`:74` 只清 `run_events` 与 `webhook_deliveries`）。
  - 跳过留痕：`apps/server/src/trigger/decide.ts:246` 的 `content-duplicate` 分支无生产调用方（`apps/server/src/http/webhook-v21.ts:117` 只声明参数，`apps/server/src/http/webhook.ts:1195` 未传），重复内容在投递行里仍记 `triggered`（`apps/server/src/http/webhook-v21.ts:188`）。
- **缺口**：两个子条件。
  1. **「上一轮失败的不算重复」未实现**：`agent_messages` 主键永久占位且 `insertMessage` 不看 `status`，`failed` 行会让同内容的下一次投递命中去重（`apps/server/src/agent/store.ts:97`）——正是需求 §FR-3.5 明令禁止的「一次故障把这个内容永久锁死」。
  2. 内容级去重命中只写 `logger.info`（`apps/server/src/http/webhook-v21.ts:1042`），`decision_reason` 里没有 `content-duplicate`（该 reason 分支不可达）。
- **判定依据**：三层键与「同 issue 同内容只一次」都能定位到生效代码；「失败不参与去重」行为与需求相反（失败行永久占位），故整条只能判部分实现。

### BR-4

- **状态**：与需求冲突
- **证据**：
  - `packages/contract/src/settings-v21.ts:485` — `issues.opened` 默认模板含「正文快照 `{{issue.content}}`」（到 `:488`）。
  - `packages/contract/src/settings-v21.ts:500` — `issues.edited` 默认模板带「这是修改后的正文快照」整篇正文（到 `:503`）。
  - `packages/contract/src/settings-v21.ts:513`、`:527`、`:544` — `issues.labeled` / `issues.closed` / `issue_comment.created` 三条默认模板同样内联 `{{issue.content}}`。
  - `apps/server/src/http/webhook-v21.ts:322` — 渲染上下文每次都从载荷填 `issue.content`（无「首轮/后续」分支）。
  - `apps/server/src/agent/message.ts:53` — v0.3 事件模板（`edited`）亦每轮内联 `{body}`；全仓无 diff/增量渲染代码（`apps/server/src/prompt/render.ts` 只做占位符替换）。
- **缺口**：需求「后续事件只下发变更与指令，不重复整篇正文」没有被实现，代码行为相反——每一个事件（含 `labeled` / `closed` / 评论）都把整篇正文快照重发一遍。
- **判定依据**：这不是「找不到实现」，而是默认产出把需求禁止的内容重复发出去（`settings-v21.ts:485-488`、`:500-503` 即为反着来的具体行），故判与需求冲突。

### BR-5

- **状态**：与需求冲突
- **证据**：
  - `apps/server/src/http/webhook-v21.ts:86` — `pull_request*` 事件一律映射为 `pull_request.*`，`decidePullRequest()` 恒不触发（`apps/server/src/trigger/decide.ts:274`），且 `apps/server/src/http/webhook.ts:1210` 不对 PR 做会话迁移。
  - `apps/server/src/http/webhook-v21.ts:90` — `issue_comment.created` 不看载荷里的 `issue.pull_request`；`apps/server/src/http/webhook-v21.ts:872`（`v21MessageIdentityOf`，到 `:889`）只取 `issue.number` / 正文。
  - `apps/server/src/http/webhook.ts:1260` — v2 分支在旧路径的 PR 判定（`apps/server/src/http/webhook.ts:561`、`:627`）之后仍先接管 `issue_comment.created`。
  - `apps/server/src/db/schema.ts:685` / `:727` — 会话行与消息行的键都只有 `(repo, issue_number)`，没有 `target_kind`/域字段。
  - `apps/server/src/agent/store.ts:147` — dispatcher 建任务时 `target_kind` 写死 `'issue'`（到 `:150`）。
- **缺口**：需求要求「issue 与 PR 各自独立会话，上下文不互通」。实现里根本没有 PR 会话域：PR 上的 `issue_comment` 不判 `pull_request`，会以 issue 会话身份落 `agent_messages`/`agent_sessions`，任务 `target_kind` 还被写成 `'issue'`，等于把 PR 当 issue 处理（PR 顶层事件只被 `pr-ignored` 挡掉，评论路径没挡）。
- **判定依据**：`pull_request.*` 事件确实被留痕忽略，但「PR 有独立会话域」没有实现，且评论事件把 PR 拉进 issue 会话空间，与需求相反。

### BR-6

- **状态**：部分实现
- **证据**：
  - 写侧：`apps/server/src/http/webhook-v21.ts:198` — `UPDATE "webhook_deliveries" SET "decision" = $2, "decision_reason" = $3`（到 `:211`）。
  - 覆盖所有提前返回：`apps/server/src/http/webhook.ts:987` 外层包装在返回前统一落判定（到 `:1027`），包括 401（`signature-invalid`）、仓库禁用/未知（`repo-disabled`）。
  - 原因枚举：`apps/server/src/trigger/decide.ts:31`（`switch-off` / `body-unchanged` / `label-not-matched` / `not-mentioned` / `role-denied` / `bot-self` / `closed-not-allowed` / `pr-ignored` / `content-duplicate` / `daily-quota` / `repo-disabled` / `signature-invalid`）。
  - 读侧：`apps/server/src/db/schema.ts:124`（列定义）与 `apps/server/src/http/webhook-v21.ts:200`（唯一写入点）之外，`apps/server/src/queries/**`、`apps/server/src/http/api/**`、`apps/panel/src/**`、`packages/contract/src/api.ts`、`openapi/` 均无 `decision` / `decision_reason` 的 SELECT；`apps/server/src/queries/issues.ts:131-161` 读 `webhook_deliveries` 只取 `payload` 里的标题/状态；`packages/contract/src/api.ts:79` 只有 `deliveries` 计数。
- **缺口**：「可在后台查询」缺失——`decision` / `decision_reason` 有写入、全仓无读取，没有任何查询/接口/面板能查「为什么没处理」。另外内容级重复被判 `triggered`（见 BR-3），留痕与事实不一致。
- **判定依据**：记录判定与原因能定位到生效代码（含未触发与 401 分支）；按 §三.2「列存在且写入完整但全仓无读取 → 后台可查判未实现」，本子条件缺失。

### BR-7

- **状态**：已实现
- **证据**：
  - 兜底评论：`apps/server/src/worker/fallback.ts:47` 白名单含 `agent:mention` / `agent:event`；`apps/server/src/worker/fallback.ts:281`（`postFallbackComment`）发评论并落 `actions` 行；触发条件在 `apps/server/src/worker/run-task.ts:1243`（到 `:1291`，含 5 条前置与跳过留痕）。
  - 终态可见反馈：`apps/server/src/feedback/stage.ts:25`（`failed` / `timed-out` / `cancelled` → `confused`），落地在 `apps/server/src/worker/run-task.ts:1640`（到 `:1701`）。
  - 队列超时另有 `confused`：`apps/server/src/queue/queue-gate.ts:30`。
  - 后台可查：`apps/server/src/worker/run-task.ts:1457`（`writeback.v21.result`）+ `:1703`（`failureDetail`）；`apps/server/src/queries/tasks.ts:120`（`failure_class` 进任务列表，`:167` 映射到 `TaskListItem.failureClass`）。
- **缺口**：无（注意点：v2 分支按设计不发兜底评论，见 `apps/server/src/worker/run-task.ts:1241-1243`，可见性由 `confused` 角标 + `run_events`/面板承担）。
- **判定依据**：失败路径同时具备「GitHub 侧可见」（角标/兜底评论）与「后台留痕」（`actions` + `run_events` + `runs.failure_class`），满足「不得静默」。

### BR-8

- **状态**：已实现
- **证据**：
  - `apps/server/src/http/webhook.ts:1164` — 一次投递只读一次 `readRepoPolicy()`。
  - `apps/server/src/http/webhook.ts:1195` — 判定用这份 `policy.settings`（到 `:1201`）。
  - `apps/server/src/http/webhook.ts:1270` — 渲染侧拿到的 `settings` 是同一个 `policy.settings`；`apps/server/src/http/webhook-v21.ts:1017` 把 `decision.template` 作为 `decidedTemplate` 传入，`apps/server/src/http/webhook-v21.ts:464` 命中后不再二次解析 settings。
- **缺口**：无（执行期另读一份 settings 属另一阶段，不在本条口径内，见「核查边界」）。
- **判定依据**：判定与渲染共享同一对象引用，且渲染没有第二次 `resolveEventTrigger()`，符合「同一份快照」。

### BR-9

- **状态**：部分实现
- **证据**：
  - 目录外不可打：`apps/server/src/writeback/v21/labels.ts:163` — `desired` 里出现目录外 / `retired` / `managed=false` / 没填 `meaning` → 整条动作 `unknown-label` 拒绝（到 `:176`）。
  - 只删可管理集合：`apps/server/src/writeback/v21/labels.ts:187`（到 `:197`），`add = desired − current`（`:183`）。
  - 目录来源单一：`apps/server/src/config/v21-settings.ts:249` — 只取 `settings.labels.vocabulary`（到 `:258`）。
  - 与 GitHub 一致：`apps/server/src/app/worker-deps.ts:609`（`createGithubLabelCatalog`：`GET/POST /repos/:o/:r/labels`，到 `:633`）只被旧写回路径的 `labels.missing` 使用（`apps/server/src/worker/writeback.ts:203`、`:249`）；v2 执行器加标签直接调 `addLabels`（`apps/server/src/writeback/v21/execute.ts:548-553`），不查仓库是否存在；全仓无「把 GitHub 标签同步进 vocabulary / 标 `retired`」的作业（`apps/server/src/jobs/` 只有 7 个作业，无标签同步）。
- **缺口**：「目录外不存在可打的标签」已实现；「与 GitHub 保持一致」（§6.5 三条同步规则：新增入目录、删除标失效、名字/颜色以仓库为准）没有实现路径，v2 加一个仓库里不存在的目录标签会直接 422（`apps/server/src/writeback/v21/labels.ts:16` 自述）。
- **判定依据**：作用域与拒绝规则可定位到生效代码；一致性/漂移那半只有平台侧手工维护，无同步代码，故部分实现。

### BR-10

- **状态**：部分实现
- **证据**：
  - 归属计算：`apps/server/src/writeback/v21/labels.ts:130` — `deletionOwner(label, botLabels)` 返回 `'bot' | 'human'`。
  - 使用点：`apps/server/src/writeback/v21/execute.ts:532`（owners 表）→ `:562-574`（`describeLabelDelta` 拼成一句话 `删 [label/human]`）→ `apps/server/src/worker/run-task.ts:1435-1443` 写入 `actions.audit.detail`（jsonb 里的**字符串**）。
  - 原因：`apps/server/src/workflows/bot-labels.ts:27` — `markRemoved` 只 `SET "removed_at"`，无 reason/owner 列；`bot_labels` 的四列归因（`source_key` / `judgement_hash` / `reason` / `run_id`）只在 `recordApplied`（`:118-133`）写。
  - 复盘出口：`apps/server/src/queries/audit.ts:85-102` 只从 `actions.audit` 取 `dryRun`，`detail` 未出现在 `AuditRow`（`apps/server/src/queries/types.ts:54` 派生自契约 `AuditResponse`）。
- **缺口**：三个子条件只部分满足。①「原主人（人 / 机器）」只以 `label/human` 形式拼进 `actions.audit.detail` 一句话，没有结构化字段（无 owner 列、`audit` 里也无 owner 键），不能按主人过滤/统计；②「删除原因」没有记录（`bot_labels.markRemoved` 无 reason，`audit.detail` 只有差集摘要）；③后台复盘路径不输出 `audit.detail`，`/api/audit` 看不到归属。
- **判定依据**：归属有实际计算并写入文本，但需求要求的是「记录原主人与删除原因，可复盘」；结构化字段、原因、查询出口三项都不成立。

### BR-11

- **状态**：与需求冲突
- **证据**：
  - 「不自动管理」标记生效：`apps/server/src/writeback/v21/labels.ts:100` — `managed === false` → `'unmanaged'`；`:163-176` 使 `desired` 含未托管标签时整条动作被拒（不加），`:187-197` 使当前未托管标签进 `skipped`（不删）；面板可切换：`apps/panel/src/components/settings/labels-section.tsx:270-282`。
  - v2 路径无「人工删除 = 永久否决」：`apps/server/src/writeback/v21/labels.ts:61` 注明 `botLabels` 仅用于判 owner，不参与过滤；删除集只由 `current ∩ 可管理目录 − desired` 决定。
  - 旧路径仍实现永久否决：`apps/server/src/workflows/normalize.ts:212-226` — 命中 `humanVetoed` 即 `blocked: 'human-veto'`，文案「曾被人工撤下且之后没有重新打：不再自动加回（人说了算）」；`apps/server/src/workflows/normalize.ts:241-263`（`humanVetoedFrom`：`bot_labels` 最后一条 `removed_at` 非空即为否决）。
  - 该路径仍在生产接线：`apps/server/src/app/worker-deps.ts:581`（`humanVetoed: loadHumanVetoed`）→ `apps/server/src/app/compose.ts:1130`（每轮建 `labelPolicy`）→ `apps/server/src/app/compose.ts:1380`（注入 worker）→ `apps/server/src/worker/run-task.ts:1507` → `apps/server/src/worker/writeback.ts:190-201`（`normalizeDesired({ humanVetoed })`）。
  - 需求已取消该机制：`docs/requirements.html:1796`（BR-11 明文「人工删除不构成永久否决」）、`docs/requirements.html:425`（修订说明「BR-11 改为显式『不自动管理』标记（取消『人删过永久不加回』）」）、`docs/requirements.html:1047`。
- **缺口**：前半（`managed=false` 既不删也不加）已实现；后半被一条仍在接线的代码路径反着实现——`human-veto` 把「人删过一次」变成永久不加回，正是需求明确取消的机制（且 `recordRemoved` 由我们自己的撤标也会写 `removed_at`，被撤的标签连「我们自己的删除」都会变成否决）。
- **判定依据**：需求这条有两半，其中一半存在与之相反且可定位到具体行的实现（`apps/server/src/workflows/normalize.ts:215-224`），故判与需求冲突，而非部分实现。

### BR-12

- **状态**：部分实现
- **证据**：
  - `apps/server/src/writeback/v21/labels.ts:83` — `isManageableCatalogEntry` 要求 `meaning` 非空（到 `:90`）。
  - `apps/server/src/writeback/v21/labels.ts:103` — `meaning` 为空 → `'missing-meaning'`；`:187-197` 该原因的当前标签进 `skipped`，**不删**；`:163-176` 使 `desired` 含无含义标签时整条拒绝（不加）。
  - `apps/server/test/writeback-v21-labels.test.ts:146` — 断言「meaning 为空 / retired / managed=false / 目录外一律不动（不删不加）」；`:162` — 纯空白等价于没填。
  - 旧写回路径没有这一判据：`apps/server/src/worker/writeback.ts:541-550`（`planLabelWriteback`）→ `apps/server/src/workflows/normalize.ts:110-155`（只按词表名过滤，不看 `meaning`）→ `apps/server/src/github/executor.ts:263-281`（`planLabelDelta`：`current ∩ botLabels − desired` 即删）。
- **缺口**：v2.1 主路径已满足；旧 4-intent 写回路径删除判断不看目录 `meaning`，我们打过但含义为空的标签在不再被 desired 时会照删。
- **判定依据**：主用路径（`executeV21`）三条规则齐全且有具体断言；但同仓仍有在用的写回路径缺「不知道语义就不做删除判断」，故判部分实现。

## 本节整体结论

本节 12 条**不能整体判为已实现**：仅 BR-7（失败可见）与 BR-8（配置即快照）两条无缺口。BR-3、BR-6、BR-10 是「主链路在但关键子条件缺失」的典型：失败消息永久占用幂等键、判定原因后台零读取、删除归属只落在文本一句话里。BR-4、BR-5、BR-11 三条与需求反向：每个事件都重发整篇正文、PR 评论按 issue 会话处理、旧打标路径仍保留被需求取消的「人删过就不加回」否决。BR-1/BR-2 共用同一根因——同 issue 串行只靠应用层快照判定，缺 `(repo, issue_number) WHERE status='running'` 部分唯一索引。

## 核查边界

- 是否执行了命令：未执行测试/构建，纯静态核查。仅执行了只读检索命令（`git status --short`、`git log --oneline -3`、`Select-String` 系列、`Get-ChildItem` 目录列举）。
- 未覆盖的条目及原因：无（12 条均已逐条取证）。BR-1/BR-2 的并发窗口、BR-9 的目录漂移、BR-11 的旧路径是否仍被真实任务触发属运行期行为，本次只给静态证据链，未起 PG/队列实测。
- 发现的额外问题（不属本节范围但值得记录）：
  1. `apps/server/src/http/webhook-v21.ts:90`：v2 分支处理 `issue_comment.created` 时完全不看 `payload.issue.pull_request`，PR 评论会被当作 issue 事件入队（同时影响 BR-5 与「本期不处理 PR」的非目标）。
  2. `apps/server/src/trigger/decide.ts:246` 的 `content-duplicate` 分支不可达：全仓无调用方把 `contentDuplicate` 置 true，`apps/server/src/http/webhook.ts:1195` 也没传；`FR-3.5`「跳过要留痕」因此落空，重复内容的投递行仍记 `decision='triggered'`（`apps/server/src/http/webhook-v21.ts:188`）。
  3. `apps/server/src/http/webhook.ts:1149-1152`：暂停（`paused`）分支在外层包装里被记成 `repo-disabled`（`apps/server/src/http/webhook.ts:1005-1012` 只区分 401 与其余），留痕原因与病因不符。
  4. 执行期会二次读配置：`apps/server/src/app/compose.ts:1403` 注入本轮 `policy.settings`，而 `apps/server/src/http/webhook-v21.ts:682`（`createV21Executor`）在执行时又 `options.settings(ctx.repo)` 读一次；判定/渲染同一快照（BR-8）成立，但执行用的开关与标签目录可能与本轮快照不同。
  5. `apps/server/src/db/schema.ts:706-731` 的 `agentMessages` 未声明 `skill_ids` 列，而 `migrations/0009_task_agent_skill_ids.sql:14` 已加该列、`apps/server/src/agent/store.ts:95` 也在写它——表结构与 schema 文件存在漂移。
  6. `apps/server/src/agent/dispatcher.ts:109-116`：`idempotency_key` 命中时直接返回 `enqueued: true` 但没有真的入队，若该消息曾被置 `running` 会停在 `running`（异常组合下可卡住该 issue 队列）。
