# U23 7 业务规则 BR-1 ~ BR-12 · B

> 核查范围：docs/requirements.html 行 1779-1801
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| BR-1 会话唯一 | 部分实现 | 一对一映射有主键硬约束；「不允许并发创建」只有应用层快照 + dispatcher 并发=1，没有部分唯一索引或 advisory lock |
| BR-2 串行消费 | 部分实现 | 同 issue 串行靠 `NOT EXISTS(status='running')` 快照判定（代码自认有窗口）；且只约束 agent 消息任务，`source='command'` 的同 issue 任务不受约束 |
| BR-3 事件幂等 | 部分实现 | 三层去重在，「上一轮失败的不算重复」缺失：失败行占用 `(repo,issue,fingerprint)` 主键且判重不看 `status` |
| BR-4 增量投喂 | 与需求冲突 | 五个默认事件模板**全部**内联 `{{issue.content}}` 整篇正文 |
| BR-5 会话域隔离 | 与需求冲突 | 会话/消息/任务键都只有 `issue_number`，无 domain；PR 上的 `issue_comment` 直接落入同号 issue 的会话命名空间 |
| BR-6 不触发也留痕 | 未实现 | `decision` / `decision_reason` 只写不读：全仓无任何查询出口（API / 面板 / CLI 均无） |
| BR-7 失败可见 | 部分实现 | 失败只有 `confused` reaction；兜底评论被 `!v21Handled` 与 `turn.completed` 两道条件挡掉，超时 / OOM / host 不可用 / v2 分支全无评论 |
| BR-8 配置即快照 | 已实现 | 判定与渲染同用一次 `readRepoPolicy()` 读出的 `policy.settings`，渲染用判定已解析的 `decidedTemplate` |
| BR-9 标签以目录为准 | 部分实现 | 目录外不可打成立；「与 GitHub 保持一致」缺失——当前标签取自 `bot_labels`，v2.1 路径不与 GitHub 目录对账 |
| BR-10 删除留痕 | 部分实现 | 只有自由文本：owner(bot/human) 拼进 `actions.audit.detail`，`bot_labels` 无 `removed_by`/原因列，人工删除只留 `revert_kind` |
| BR-11 标签管辖边界 | 与需求冲突 | legacy 打标路径实现成「删过一次永久不加回」，且把**我们自己**的撤标也算成人工否决 |
| BR-12 无语义不删 | 已实现 | `missing-meaning` 的目录项既不进 `remove`，出现在 `desired` 里还整批拒绝 |

## 逐条

### BR-1
- **状态**：部分实现
- **证据**：
  - `apps/server/src/db/schema.ts:685` — `primaryKey({ columns: [t.repo, t.issueNumber] })`：`agent_sessions` 一 issue 一行，映射一对一由数据库硬约束保证。
  - `migrations/0006_agent.sql:27` — `CONSTRAINT "agent_sessions_repo_issue_number_pk" PRIMARY KEY("repo","issue_number")`，与 schema 一致。
  - `apps/server/src/agent/store.ts:156-163` — `saveSession` 是 `INSERT … ON CONFLICT DO UPDATE`（last-write-wins），没有锁、没有版本列。
  - `apps/server/src/runtime/turn-driver.ts:375-392` — `sessionId === undefined` 时直接 `sessionCreate()`，创建前没有库级互斥（全仓无 `pg_advisory_lock`，仅 `agent_messages` 的 `FOR UPDATE SKIP LOCKED`）。
  - `apps/server/src/agent/dispatcher.ts:20-23` — 代码自认「两个 dispatcher 真同时进 `claimOldest` 时仍可能各领到同一 issue 的不同消息……要彻底消灭需要一条部分唯一索引」。
- **缺口**：「不允许并发创建会话」这条子条件只有应用层快照判定（`agent/store.ts:124-139` 的 `NOT EXISTS (running)`）+ `agentDispatch` 并发 1（`queue/definitions.ts:152-153`）。两个同 issue 轮次同时读到 `session_id = NULL` 时会各自 `session/create`，后者覆盖前者，前一个 Host 会话成孤儿，且没有任何约束会拦下。
- **判定依据**：一对一映射达标（主键），但需求明写的「不允许并发创建」缺数据库级防护；这正是模板要求区分「存在」与「生效」的情形——约束存在，并发创建路径未被它覆盖。
- **反证过程**：
  1. 查「有没有 DB 级唯一约束」：`agent_sessions` 主键 `(repo, issue_number)`（schema.ts:685 / 0006:27）→ 推翻「连一行唯一都没有」的假设，但只约束行数，不约束 RACP 会话创建次数。
  2. 查「有没有并发创建的第二道闸」：`grep advisory|FOR UPDATE` 只命中 `agent/store.ts:132` 的 `claimOldest`（消息领取），`turn-driver.ts:375-392` 的 `sessionCreate` 无互斥 → 假设「并发创建被数据库挡住」不成立。
  3. 查「两条同 issue 任务能否真并行」：`queue/definitions.ts:93-95` run-task 并发 3，`http/webhook.ts:1316` 的 `submitPlanTask`（command 通道）不经 `agent_messages` 队列 → 同 issue 的命令任务与 agent 轮次可并行，创建竞态可达。
  4. 反向求证：若实现完备，应有「`(repo, issue_number) WHERE session_id IS NOT NULL` 部分唯一索引」或创建前的 `SELECT … FOR UPDATE` / advisory lock —— 全仓均无。

### BR-2
- **状态**：部分实现
- **证据**：
  - `apps/server/src/agent/store.ts:106-115` — `queuedIssues` 用 `NOT EXISTS (… status = 'running')` 排除已有 running 的 issue。
  - `apps/server/src/agent/store.ts:124-139` — `claimOldest` 一条语句内 `UPDATE … IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`，并再判一次 `NOT EXISTS (running)`（仍是快照语义）。
  - `apps/server/src/queue/definitions.ts:93-95` — `run-task` 并发 3（跨 issue 并行的执行侧容量）。
  - `apps/server/src/queue/repo-concurrency.ts:5-7` — 仓库级并发默认 2，按仓库分槽。
  - `apps/server/src/agent/dispatcher.ts:20-23` — 已知窗口自认；`apps/server/src/queue/definitions.ts:146-159` 用 `agentDispatch` 并发 1 把窗口压小。
  - `apps/server/src/http/webhook.ts:1316` — command 通道的 `submitPlanTask` 直接建 `tasks` 入队，不经 agent 消息队列。
- **缺口**：① 同 issue 串行没有数据库级硬约束（缺 `(repo, issue_number) WHERE status='running'` 部分唯一索引，dispatcher 自己写在注释里）；② 串行只覆盖 `source='agent'` 的消息任务，`issues.labeled` / 命令类任务与 agent 轮次可对同一 issue 并行，需求写的是「同一 issue 的轮次串行」，未按 source 豁免。
- **判定依据**：跨 issue 并行成立（并发 3 + 仓库级 2），同 issue 串行的主体成立但依赖快照判定与单并发 dispatcher，属「主体在、子条件不完整」。
- **反证过程**：
  1. 假设「串行是数据库保证的」：找部分唯一索引 → `migrations/0006/0011` 里 `agent_messages` 只有 `(repo,issue,fingerprint)` 主键与 `(repo,issue,status,created_at)` 普通索引，**没有** running 部分唯一索引；且 `dispatcher.ts:20-23` 自己承认缺口 → 假设被推翻。
  2. 假设「一条语句就能原子领」：`store.ts:124-139` 是同一条 UPDATE，但 `NOT EXISTS` 子查询在 read-committed 下是快照，两个 dispatcher 交错时仍可能各置一条 `running` → 窗口存在，只是被 `agentDispatch` 并发 1 压到语句级。
  3. 假设「跨 issue 并行」：`definitions.ts:93-95` 并发 3 且 `repo-concurrency.ts` 每仓库 2 → 成立，不算缺口。
  4. 查串行的覆盖面：`grep submitPlanTask` 显示 command 任务不经过 `agent_messages`，`claimOldest` 的 `NOT EXISTS` 完全看不到它们 → 同一 issue 上 command 任务与 agent 轮次可并行，需求口径未达成。

### BR-3
- **状态**：部分实现
- **证据**：
  - 投递级：`apps/server/src/http/webhook.ts:95-99` — `INSERT INTO "webhook_deliveries" … ON CONFLICT DO NOTHING`（`delivery_id` 主键）；`webhook.ts:1231-1240`（内层 3 步）据此判重复投递。
  - 事件级：`apps/server/src/agent/fingerprint.ts:36-49` — `eventFingerprint` = `repo + issue + 'event' + templateId + issue.updated_at`；`apps/server/src/http/webhook-v21.ts:903-922` 按有无 `comment.id` 在内容级与事件级之间选择。
  - 投递级：`apps/server/src/http/webhook.ts:95-99` — `INSERT INTO "webhook_deliveries" … ON CONFLICT ("delivery_id") DO NOTHING`（`delivery_id` 主键）；`webhook.ts:1099-1121` 按 `rowCount === 0` 判「重复投递，直接回 200」并置 `trace.skipDecision`。
  - **失败仍占幂等键**：`apps/server/src/agent/store.ts:95-98` — `ON CONFLICT ("repo","issue_number","fingerprint") DO NOTHING`，`status` 不在冲突条件里；表定义侧 `apps/server/src/db/schema.ts:726-731` 主键同为 `(repo,issue_number,fingerprint)`，也不含 status。
  - 判重不看状态：`apps/server/src/http/webhook-v21.ts:1038-1044` — `if (!saved.inserted)` 直接返回 `duplicate`，没有读回 `row.status`；`apps/server/src/http/webhook.ts:1606-1621` 同形。
  - 二次封锁：`apps/server/src/agent/store.ts:147-150` — `tasks` 也 `ON CONFLICT ("idempotency_key") DO NOTHING`，键由 fingerprint 拼成（`store.ts:55-57`），失败重投即使消息被重排也会撞键；任务侧不重试（`queue/definitions.ts:354-360` 断言 `run-task.retryLimit` 必须为 0）。
  - 失败终态：`apps/server/src/app/compose.ts:1085` — `status: report.outcome === 'succeeded' ? 'done' : 'failed'`，行保留在表里。
  - 测试：`apps/server/test/agent-serial-queue.test.ts:145-156` 断言「同一句话第二次 @ → duplicate」，`apps/server/test/v21-webhook-integration.test.ts:338` 断言同内容只算一次；无「失败后同内容重投应重新处理」的用例。
- **缺口**：需求明写的子条件「上一轮失败的不算重复」未实现。一次故障（超时 / OOM / 模型错误 / 沙箱不可用）把消息置 `failed` 后，同一内容重投永远判 `duplicate`，`tasks.idempotency_key` 也永久挡住重新入队 → **一次故障永久锁死该内容**，人工重贴同句话无效。
- **判定依据**：三层去重的三层都能定位到实现（投递 / 事件 / 内容），但第四个子条件（失败不算重复）在判重路径上完全缺席，属部分实现。
- **反证过程**：
  1. 假设「失败行不占幂等键」：读 `store.ts:95-98`，冲突目标就是全主键、`DO NOTHING` 无条件；再读 `schema.ts:726-731`，主键不含 `status` → 失败行与成功行在唯一性上不可区分，假设被推翻。
  2. 假设「调用侧会把 failed 行重新排队」：`grep markMessage(` 只有 dispatcher 写 `failed`/`done` 与投递失败写 `failed`；`grep 'queued'` 无任何「failed → queued」回滚调用点 → 不存在补偿路径。
  3. 假设「有测试覆盖失败后重投」：检索 `上一轮失败|requeue|retryFail` 全仓无命中；`agent-events.test.ts:160`、`agent-serial-queue.test.ts:155` 断言的都是成功后再投 → 相反方向没测。
  4. 假设「两处判重中至少有一处看 status」：`webhook-v21.ts:1038-1044`、`webhook.ts:1606-1621` 两处都只判 `inserted` → 无遗漏分支。

### BR-4
- **状态**：与需求冲突
- **证据**：
  - `packages/contract/src/settings-v21.ts:487`（`issues.opened`）、`:502`（`issues.edited`）、`:515`（`issues.labeled`）、`:528`（`issues.closed`）、`:546`（`issue_comment.created`）— 五个内置默认事件模板**每一个**都含 `{{issue.content}}` 整篇正文快照（模板定义在 `settings-v21.ts:473-549`）。
  - `apps/server/src/agent/message.ts:11` — 模块头自述「事件消息（`opened`/`edited`）的正文里**内联**了 issue 标题、正文、`project_prompt`」；模板见 `message.ts:35-60`（同样带「正文：」段）。
  - `apps/server/src/http/webhook-v21.ts:359-362` + `:464` — 项目没配模板时直接回落到上述默认模板，即整篇正文随每条事件下发。
- **缺口**：需求要求「后续事件只下发变更与指令，不重复整篇正文」，代码在每条事件消息里都带上全文快照，方向相反。后果：同一 issue 的长正文会被反复塞进上下文（与 `compact/` 的压缩压力、token 成本直接相关），且 `issues.edited` 也无法表达「改了哪一段」。
- **判定依据**：五处模板字面量可直接核对，冲突点明确到行；不存在任何「只发 diff / 只发变更字段」的实现分支（全仓 `grep 增量` 只命中压缩与退化判据，与事件投喂无关）。
- **反证过程**：
  1. 逐条点名五个事件模板里是否都有 `{{issue.content}}`：`settings-v21.ts:487/502/515/528/546` —— 五条全中，符合任务书里「有则整篇重发 = 与需求冲突」的判据。
  2. 假设「只有默认模板如此，项目模板可以是增量的」：`webhook-v21.ts:359-362` 只做「项目模板 or 默认模板」的二选一，渲染仍是同一次全量替换（`renderTemplateAsync`），没有 diff 机制；不带模板时必然整篇。
  3. 假设「v0.3 的事件消息另有增量实现」：`agent/message.ts:35-60` 的 `opened`/`edited` 模板同样内联「正文：」段。
  4. 假设「有隐藏的变更字段过滤」：`decideEvent` 里 `changedFields` 只用于 `only_body_changed` 判定（`trigger/decide.ts:145-152`），不参与消息组装 → 无增量下发路径。

### BR-5
- **状态**：与需求冲突
- **证据**：
  - `apps/server/src/db/schema.ts:658-686` — `agent_sessions` 只有 `repo` + `issue_number`，**没有** `target_kind` / `domain` 列（主键 schema.ts:685）。
  - `apps/server/src/http/webhook-v21.ts:85-108` — `v21EventKeyOf` 仅按 `X-GitHub-Event` 是否以 `pull_request` 开头分流；`issue_comment` 一律映射成 `issue_comment.created`，**不看** `payload.issue.pull_request`。
  - `apps/server/src/trigger/decide.ts:209-266` — `decideEvent` 全程没有 `pull_request` 判定，PR 上的评论与 issue 上的评论走同一批闸门。
  - `apps/server/src/http/webhook.ts:1206-1217` — 会话状态迁移用 `payload.issue.number`，PR 上的 `issue_comment.created` 因此写进同号 issue 的 `agent_sessions` 行。
  - `apps/server/src/http/webhook-v21.ts:1029-1037` — 命中触发后 `insertMessage` 的键是 `{repo, issueNumber}`（PR 号），与 issue 同号共享命名空间；v0.3 侧同形：`apps/server/src/http/webhook.ts:561-575` 计算出 `targetKind: 'pr'` 后，`webhook.ts:1529/1594` 仍以 `plan.targetNumber` 作 `issueNumber` 落 `agent_messages`。
  - `apps/server/src/agent/store.ts:147-148` — agent 建任务时 `target_kind` 硬编码 `'issue'`，PR 号会被记成 issue #N。
- **缺口**：issue 与 PR 没有独立命名空间（会话、消息、任务三处都按裸编号），PR 上的评论进入同号 issue 的会话，上下文互通。只有 `pull_request.*` 事件本身被判 `pr-ignored`（`trigger/decide.ts:274-276`），而 GitHub 上 PR 评论/PR 上的 issue 事件走的是 `issue_comment` / `issues` 通道，完全绕过了这个判定。
- **判定依据**：数据模型层面无可区分域，代码行为与「各自独立会话，上下文不互通」相反，且能指出具体行（`webhook-v21.ts:85-108` 不看 `issue.pull_request`）。
- **反证过程**：
  1. 假设「PR 评论有 domain 字段兜底」：查 `agent_sessions` / `agent_messages` / `tasks` 三处键 → 前两处只有 `(repo, issue_number[, fingerprint])`，`tasks` 有 `target_kind` 但 agent 路径硬编码 `'issue'`（`store.ts:147-148`）→ 无区分。
  2. 假设「PR 事件在 `v21EventKeyOf` 就被挡住」：该函数只对 `X-GitHub-Event = pull_request*` 返回 `pull_request.*`；PR 上的评论是 `issue_comment`（GitHub 语义），返回 `issue_comment.created` → 假设被推翻。
  3. 假设「`decideEvent` 里还有一道 `pull_request` 闸」：`trigger/decide.ts:209-266` 逐行读，只有 signature / repo / switch / condition / comment gates / duplicate / quota 七段，无 PR 判定 → 不成立。
  4. 假设「会话迁移至少不会给 PR 建行」：`webhook.ts:1210` 只排除 `pull_request.*`，`issue_comment.created` 会走到 `applyV21SessionOnEvent`（`webhook-v21.ts:786-802`、`:829-855`），用 PR 号 INSERT/UPDATE → 同号 issue 的会话行被 PR 事件改写。
  5. 对照 v0.3 通道：`decideWebhookTask` 明明算出了 `targetKind:'pr'`（`webhook.ts:567`），但消息落库键仍用 `targetNumber`（`webhook.ts:1529`、`1594`）→ 连自己做出来的域信息也没被使用。

### BR-6
- **状态**：未实现
- **证据**：
  - 写入侧（在）：`apps/server/src/http/webhook-v21.ts:198-211` — `writeV21Decision` 执行 `UPDATE "webhook_deliveries" SET "decision" = $2, "decision_reason" = $3`；`webhook.ts:995-1020` 在返回前统一写（含未知仓库 / 验签失败 / 投递重复的三种兜底判定）；列定义见 `apps/server/src/db/schema.ts:112`、`:124`。
  - 读取侧（无）：`apps/server/src/queries/*.ts` 全目录内 `decision` 只命中 `queries/audit.ts:107/247`（审批判定的 `payload.decision`，与投递判定无关）。
  - `apps/server/src/queries/issues.ts:152`、`:259`、`:278`、`:780`、`:827` 用到 `webhook_deliveries`，取的都是 `payload` 里的评论正文，不取 `decision` / `decision_reason`。
  - 出口侧（无）：`apps/server/src/http/api/index.ts` 的路由清单里没有投递/判定相关端点（只有 overview / tasks / costs / quality / audit / system / issues / repos）；`packages/contract/src/api.ts` 无对应 schema；`apps/server/src/cli.ts:506-514` 只有 `serve|migrate|replay|bootstrap-host|doctor`，`replay` 读的是 payload（`webhook.ts:1796`）。
  - 覆盖还更窄：`apps/server/src/http/webhook-v21.ts:93-105` 只把五个 action + PR 映射成事件键，`issues.unlabeled` / `issues.reopened` 等返回 `null` → `handleV21Webhook` 不接管 → 该投递连 `decision` 都不写。
- **缺口**：需求要求「必须记录判定结果与原因，**可在后台查询**」。记录成立，但全仓没有任何读取出口（无 API、无查询函数、无面板、无 CLI），且五类之外的事件不写判定。「可在后台查询」这一子条件整条缺失。
- **判定依据**：按 `_TASK-TEMPLATE.md` §三.2 的明文反例（`decision_reason` 写入完整但全仓无读取 → 判未实现），该条正是这个形态；写入存在不等于实现。
- **反证过程**：
  1. 找读取方：对 `apps/server/src/queries`、`http/api`、`packages/contract`、`apps/panel/src` 四个面 grep `decision_reason|decisionReason` → 零命中；grep `decision` 只命中审批域（`queries/audit.ts:107`、`panel/src/routes/audit.tsx:505`）→ 无消费方。
  2. 假设「投递行经其他 query 顺带返回」：逐个看 `queries/issues.ts` 里 5 处 `webhook_deliveries` join 的 select 列表，只有 `payload -> comment -> body` → 不含判定列。
  3. 假设「有 CLI 能查」：`cli.ts:506-514` 五个子命令全看过，`replay` 只按 delivery_id 取 payload 重放 → 不是「查判定」。
  4. 假设「至少所有事件都留了痕」：`v21EventKeyOf`（`webhook-v21.ts:93-105`）对 `issues.unlabeled|reopened|assigned|…` 返回 `null`，`decideV21Delivery` 返回 `null`，`writeV21Decision` 因此不被调用 → 留痕覆盖面也不完整。

### BR-7
- **状态**：部分实现
- **证据**：
  - 唯一的「评论级」反馈：`apps/server/src/worker/run-task.ts:1243` — `if (!v21Handled && prepared !== null && (!prepared.valid || !hasCommentAction))`，即**v2 分支一律不发兜底评论**（同处 `:1241-1242` 注释明写「v2 分支不发兜底评论」）。
  - `apps/server/src/worker/run-task.ts:1255-1256` — `terminal !== 'turn.completed'` 时 `blocked`，不评论；超时 / OOM / 崩溃 / host 不可用都不会有 `turn.completed`。
  - `apps/server/src/worker/run-task.ts:1253-1254` — 命令不在白名单（`/review-pr` 等）也不评论。
  - 失败时实际只有 reaction：`apps/server/src/feedback/stage.ts:22-28` — `failed` / `timed-out` / `cancelled` → `confused`（并先删 `eyes`）；`apps/server/src/worker/run-task.ts:1636-1660` 在 `decideOutcome()` 之后统一打。
  - 该 reaction 可整体缺席：`apps/server/src/app/compose.ts:1377-1378` 与 `:1408` — 没有可用 reaction 写面时 `feedback === null`，此时失败只剩 `runs.outcome` / 面板行，无任何对外信号。
  - 准备阶段失败（worktree / container / host.ready）会被收成信号而不抛（`run-task.ts:758-772`），所以确实会走到 reaction 收尾——可见性只停在 reaction。
- **缺口**：需求要求「兜底评论**或后台告警**」两者之一必须存在。现实是：v2.1 分支零兜底评论；超时 / OOM / host 不可用 / 命令类任务零兜底评论；没有任何「后台告警」通道（无 webhook 出站、无告警端点）。全部失败类型共用的只有一枚 `confused` reaction，而它在未配置 reaction 写面时连这枚都没有。逐类型看：超时（无评论）、OOM（无评论）、模型错误（`turn.failed` → 无评论）、host 不可用（无评论）——**没有一类有兜底评论**。
- **判定依据**：需求写的是「必须有可见反馈」，主体只有 reaction 这一层，而评论/告警两个明写通道均不覆盖这些失败类型，属部分实现。
- **反证过程**：
  1. 逐个失败类型找可见反馈：超时 → `run-task.ts:1255` 拦；OOM → 容器状态信号（`worker/failure.ts:79-84`）后 turn 未完成 → 同样被拦；模型错误 → `turn.failed`（`run-task.ts:1141-1142`）→ 被拦；host 不可用 → `run-task.ts:758-764` 只记 error 日志 + 信号 → 无评论。四类全部只有 reaction。
  2. 假设「v2 分支有兜底」：`run-task.ts:1241-1243` 的 `!v21Handled` 与注释都排除 v2 → 推翻。
  3. 假设「至少有一处后台告警」：grep 告警/通知通道（无出站 webhook、无 alert 端点；`panel/src/layout/DegradedBanner.tsx` 只反映 system 降级）→ 不存在按 run 失败的告警。
  4. 假设「reaction 足以算可见反馈」：`feedback/stage.ts:22-28` 确实给了 `confused`，但 `compose.ts:1377-1378` 的 `feedback === null` 分支让它在缺写面时彻底消失，且 requirement 明写的是「兜底评论或后台告警」两种形式 → 不能据此判已实现。

### BR-8
- **状态**：已实现
- **证据**：
  - `apps/server/src/http/webhook.ts:1164` — 每次投递只 `readRepoPolicy(deps.db, repo)` 一次，`policy.settings` 就是本事件的配置快照（`grep readRepoPolicy` 在 `http/` 下仅此一处）。
  - `apps/server/src/http/webhook.ts:1195-1201` — 判定用 `settings: policy.settings`。
  - `apps/server/src/http/webhook.ts:1270` — 渲染侧传的也是同一个 `settings: policy.settings`。
  - `apps/server/src/http/webhook-v21.ts:464` — 模板取 `input.decidedTemplate ?? v21TemplateOf(input.settings, input.event)`；热路径由 `webhook-v21.ts:1017` 传入判定侧已解析的 `decision.template`，即不二次解析。
  - 渲染只用传入的模板 + 载荷（`webhook-v21.ts:466-476`），`repoIssues` 是 GitHub 数据（5 分钟缓存），不是配置。
- **缺口**：（无）
- **判定依据**：判定与渲染读的是同一次库读取产出的同一个对象，模板也由判定侧单向下传；不存在「两次读库 = 没快照」的形态。
- **反证过程**：
  1. 假设「渲染各自再读一次库」：`grep readRepoPolicy` 在 `apps/server/src/http/` 只命中 `webhook.ts:1164` 一处；渲染链路（`buildV21AgentMessage`）没有任何 `db.query` → 推翻。
  2. 假设「渲染会重新解析 settings 得到不同模板」：`webhook-v21.ts:464` 优先用 `decidedTemplate`，且 `:1017` 确实传了 `decision.template`；`v21-webhook-integration.test.ts:406`（「显式模板解析与 decideEvent().template 等价」）从测试侧钉住两条路径同值 → 不成立。
  3. 假设「中间夹了第二次配置读取」：`applyV21SessionOnEvent`（`webhook.ts:1206-1222`）只读写 `agent_sessions`，不读 `repos.settings` → 无第二次读。
  4. 边界确认：任务执行期的 `compose.ts:1113` 是**另一次**（后续时刻，另一个事件）读取，不属于「同一事件内」，不计入本条缺口。

### BR-9
- **状态**：部分实现
- **证据**：
  - 目录为身份来源（成立）：`apps/server/src/writeback/v21/labels.ts:163-176` — `desired` 里出现目录外 / `retired` / `managed=false` / 没填 `meaning` 的标签 → 整条动作 `unknown-label` 拒绝；`labels.ts:82-107` 的 `isManageableCatalogEntry` / `unmanageableReason` 是唯一判定入口；`remove` 只在 `labels.ts:187-197` 的可管理集合内产生。
  - 目录来自项目配置：`apps/server/src/config/v21-settings.ts:227-250`（`ManagedCatalogEntry` + `resolveManagedCatalog`），`worker/run-task.ts:1329` 把 `v21CatalogOf(rawSettings)` 全量喂给执行器。
  - **当前标签不来自 GitHub**：`apps/server/src/app/worker-deps.ts` 的 `createV21TargetContextPort` 把 `options.currentLabels` 原样返回；该值由 `apps/server/src/app/compose.ts:1149` → `readAppliedLabels()` 提供，SQL 在 `compose.ts:1665-1666`：`select distinct "label" from "bot_labels" where … "removed_at" is null`。
  - v2.1 路径没有「目录 ↔ GitHub 标签」校验：`worker/writeback.ts:203-240`（`labels.missing` 的 `warn|create|ignore`）只在 legacy 路径生效，靠 `createGithubLabelCatalog`（`worker-deps.ts:609-633`）读 GitHub；v2.1 执行器（`writeback/v21/execute.ts:515-559`）只按 settings 目录 + `bot_labels` 判定，不发任何目录查询。
- **缺口**：「与 GitHub 保持一致」这一子条件缺失且无替代：当前标签取自我们自己的 `bot_labels` 台账（人打的标签完全不可见；人删掉我们打的标签后该标签仍被当成「当前存在」），v2.1 也从不校验目录里的标签在 GitHub 上是否存在（目录里配一个 GitHub 上不存在的标签，会在 `addLabels` 阶段才 422）。
- **判定依据**：「目录外不存在可打的标签」达标，「与 GitHub 保持一致」既没有同步也没有校验，属部分实现。
- **反证过程**：
  1. 假设「current 来自 GitHub」：追 `createV21TargetContextPort` → 返回 `options.currentLabels`（装配时传入）→ 追到 `compose.ts:1149` → `readAppliedLabels` 的 SQL 是 `bot_labels`（`compose.ts:1665`）→ 假设被推翻，且注释（`compose.ts:1652-1656`）明确说「为什么读自己的记账表而不是打一次 GitHub API」。
  2. 假设「有定时对账 jobs 把台账与 GitHub 对齐」：`jobs/` 下只有 queue-gate / lifecycle-sweep / metrics-rollup / reconcile-reverts / retention-cleanup；`reconcile-reverts` 只置 `revert_kind`（`jobs/reconcile-reverts.ts:306`），不回写 `bot_labels`、不校验目录 → 无对账。
  3. 假设「v2.1 至少会用 `labels.missing` 拦 422」：`writeback/v21/execute.ts:515-559` 无 `catalog.list` 调用（`V21PortSources` 里也没有目录读端口）→ 不成立。
  4. 反向求证「目录外不可打」是否真的成立：`labels.ts:140-176` 空集保护 + 超限拒绝 + 目录外拒绝三道，测试 `apps/server/test/writeback-v21-labels.test.ts:108-115` 断言 `unknown-label` → 该子条件成立，不误判为缺口。

### BR-10
- **状态**：部分实现
- **证据**：
  - 删除归属（算出来的）：`apps/server/src/writeback/v21/labels.ts:130-132` — `deletionOwner(label, botLabels)` 返回 `'bot' | 'human'`；用法在 `writeback/v21/execute.ts:532-536`。
  - 但归属只进自由文本：`writeback/v21/execute.ts:562-573` — `describeLabelDelta` 把 `删 [label/bot, …]` 拼成一句话，作为 `detail` 写入；落库路径 `apps/server/src/worker/run-task.ts:1424-1448` → `actions.audit = { …, detail: item.detail }`（jsonb 里的字符串，无结构化字段）。
  - 记账表无「谁删的 / 为什么删」列：`apps/server/src/workflows/bot-labels.ts:26-29` — `markRemoved` 只 `SET "removed_at" = $4`；表定义 `apps/server/src/db/schema.ts:381-398` 只有 `source_key / judgement_hash / reason / run_id / applied_at / removed_at`，`reason` 是**打标**时的理由，撤标不复用、也没有 `removed_by`。
  - 人工删除只有间接痕迹：`apps/server/src/jobs/reconcile-reverts.ts:306` — 轮询发现标签没了 → `revert_kind='label-removed'` + `evidence{label,currentLabels}`（`reconcile-reverts.ts:241-261`），不含删除人、不含原因。
  - legacy 路径同理：`apps/server/src/github/executor.ts:337-347` 调 `removeLabel` 后 `ledger.recordRemoved`，无 actor / reason 入参（`executor.ts:290-296` 的端口签名）。
- **缺口**：需求要「记录原主人（人/机器）与删除原因，可复盘」。原主人是**运行时算出来再拼进自由文本**（`actions.audit.detail`），不是可查询的结构化字段；删除原因只有「desired − current」的差集描述，没有原因码；人工在 GitHub 上删除我们的标签时，只有 `revert_kind='label-removed'`，既无原主人也无法复盘原因。
- **判定依据**：按任务口径「只有自由文本不算」——`bot_labels` 无 `removed_by`/`removed_reason` 之类结构化列，`actions.audit.detail` 是给人读的字符串，无法按删除人/原因聚合查询。
- **反证过程**：
  1. 找结构化字段：`schema.ts:381-398` 与 `migrations/0000_init.sql:14-22` 的 `bot_labels` 列清单里没有 `removed_by` / `removed_reason` / `removed_kind`；`actions` 表只有 `intent/target/audit(jsonb)` → 无结构化删除归属。
  2. 假设「audit jsonb 里其实有键」：`run-task.ts:1435-1443` 的 audit 只有 `source/contract/index/type/outcome/detail/dryRun`，owner 只在 `detail` 字符串里 → 推翻。
  3. 假设「人工删除能从 webhook 拿到删除人」：`webhook-v21.ts:93-105` 不接收 `issues.unlabeled`（返回 `null`），`webhook.ts:384` 的 `ISSUE_ACTIONS = ['opened','edited']` + `:619-620` 的白名单判定也把它判 ignore → 没有删除人来源；只能靠 `reconcile-reverts` 轮询到「没了」。
  4. 假设「`reason` 列够用」：`bot-labels.ts:22-25` 的 `insertActive` 只在打标时写 `reason`，`markRemoved`（`:27-29`）不写 → 撤标后该列仍是打标理由，不能当删除原因。

### BR-11
- **状态**：与需求冲突
- **证据**：
  - 与需求相反的一侧（legacy 打标路径）：`apps/server/src/workflows/normalize.ts:212-226` — `if (vetoed.has(item.label))` → `blocked.reason='human-veto'`、`warnings.push('…是人工撤下的：本轮不加回')`，即「删过一次就永久不加回」。
  - 否决集合的算法把**我们自己的撤销**也算成人工：`apps/server/src/workflows/normalize.ts:231-264` — `humanVetoedFrom` 的判据是「某标签最后一次记录 `removed_at` 非空」（`:234` 注释直说「人（或我们的撤标）」）；而 `removed_at` 正是我们自己写回的撤标动作写的：`apps/server/src/workflows/bot-labels.ts:134-144`（`recordRemoved`）+ 两个调用点 `apps/server/src/github/executor.ts:341-346`（legacy 删标后）与 `apps/server/src/worker/run-task.ts:370-377`（v2.1 删标后）。
  - 这条规则在生效路径上：`apps/server/src/app/worker-deps.ts:581` 把 `humanVetoed` 注入 `LabelWritebackPolicy`；`apps/server/src/worker/writeback.ts:190-199` 每轮都读并喂给 `normalizeDesired`；调用点在 `apps/server/src/worker/run-task.ts:1488-1512`（信封不是合法 v2 时的 legacy 写回），`labelPolicy` 由 `apps/server/src/app/compose.ts:1130-1135`、`:1380` 无条件注入。
  - 未真接收 `issues.unlabeled`：`apps/server/src/http/webhook-v21.ts:93-105`（`default: return null`）与 `apps/server/src/http/webhook.ts:384`（`ISSUE_ACTIONS` 只有 `opened`/`edited`，`:619-620` 据此 ignore）→ 真实人工删除既不进判定也不进消息，只能由 `jobs/reconcile-reverts.ts` 轮询发现。
  - 符合需求的一侧（v2.1 目标态路径）：`apps/server/src/writeback/v21/labels.ts:100-102`（`managed === false` → `unmanaged` → `skipped`，既不删也不加）、`:178-197`（`remove` 只在可管理集合内），且 v2.1 路径不读 human-veto。
- **缺口**：需求明写「未标记的标签按目标态正常对齐——**人工删除不构成永久否决**」，而 legacy 打标路径实现的正是相反语义（永久否决），且触发条件是「`removed_at` 非空」——这既包含真人工删除，也包含**平台自己的撤标**（`run-task.ts:370-377`、`executor.ts:341-346`）。因此平台删过一次的标签，之后在 legacy 路径上再也不会被自动加回；真人工删除也没有被 `issues.unlabeled` 识别（靠轮询），无法区分「人删的」与「我们自己删的」。
- **判定依据**：代码行为与需求方向相反，且能指到具体行（`normalize.ts:212-226` 与 `:234-260`），并给出它被接线的路径；同一条在两套路径上语义相反本身就是缺陷，但按「有相反实现即算冲突」的口径判冲突。
- **反证过程**：
  1. 假设「human-veto 只是死代码」：追注入链 `worker-deps.ts:581` → `compose.ts:1130/1380` → `worker/writeback.ts:191-199` → `run-task.ts:1507`，再到实际调用 `run-task.ts:1495-1512`（`prepared.valid` 时执行 legacy 写回）→ 是活路径，不是死代码。
  2. 假设「否决集只来自人工」：读 `humanVetoedFrom`（`normalize.ts:241-263`）只看「最后一行的 `removed_at` 是否非空」，不知道是谁删的；再读 `markRemoved`（`bot-labels.ts:27-29`）没有任何 actor 入参 → 我方撤标与人工撤标在数据上不可区分，满足任务书「若证据来自我们自己的删除动作 → 方向相反」的判据。
  3. 假设「v2.1 路径也有同样否决」：`writeback/v21/labels.ts` 全文无 veto 逻辑，`execute.ts:515-559` 也不读 veto → v2.1 符合需求；冲突集中在 legacy 路径，属「两套路径语义相反」。
  4. 假设「至少真收到了 `issues.unlabeled` 来区分人工删除」：`v21EventKeyOf`（`webhook-v21.ts:93-105`）对 `unlabeled` 返回 `null`，`webhook.ts:384` 的 `ISSUE_ACTIONS` 也不含它 → 没有真实人工删除事件源，只有轮询（`reconcile-reverts.ts:306`）。
  5. 假设「项目级『不自动管理』标记根本没实现」：`labels.ts:100-102` + `config/v21-settings.ts:227-250`（`managed` 字段）→ 该子条件实现，故缺口只记在「永久否决」这一侧。

### BR-12
- **状态**：已实现
- **证据**：
  - `apps/server/src/writeback/v21/labels.ts:88-90` — `isMeaningFilled`：`null` / 空串 / 纯空白都算「没填含义」。
  - `apps/server/src/writeback/v21/labels.ts:103-105` — `unmanageableReason` 对没填含义的目录项返回 `'missing-meaning'`。
  - `apps/server/src/writeback/v21/labels.ts:163-176` — `desired` 里出现 `missing-meaning` 的标签 → 整条动作 `unknown-label` 拒绝（不知道语义就不替它做判断）。
  - `apps/server/src/writeback/v21/labels.ts:187-197` — 当前挂着但不可管理的标签（含 `missing-meaning`）只落 `skipped`，**不进 `remove`**。
  - 目录语义字段定义与保护说明：`apps/server/src/config/v21-settings.ts:227-236`（`meaning: null` = 没人填过含义 → 不进自动对齐范围）。
  - 测试：`apps/server/test/writeback-v21-labels.test.ts:86`、`:139`、`:174` 断言 `missing-meaning` 进 `skipped` 且不被删除。
- **缺口**：（无）
- **判定依据**：对齐逻辑（唯一的目标态对齐实现 `planLabelTargetState`）在「加」和「删」两侧都过滤了含义为空：删除侧落 `skipped`，加侧整批拒绝。需求要求的是「不参与自动对齐」，实测为「既不加也不删」。
- **反证过程**：
  1. 假设「只过滤了 not-in-catalog，没过滤空 meaning」：`unmanageableReason`（`labels.ts:93-107`）四个分支逐个看，`missing-meaning` 独立成一支，且 `remove` 循环（`:187-197`）只接受 `reason === null` → 推翻。
  2. 假设「`clear: true` 能绕过」：`labels.ts:140-147` 的 `clear` 只解除空集保护，删除集合仍由 `:187-197` 的可管理判定产生 → 空含义标签在清空时同样保留。
  3. 假设「desired 里硬塞空含义标签会被放行」：`:163-176` 命中即整批 `unknown-label` 拒绝 → 不成立。
  4. 反向求证「是不是根本没有含义字段」：`config/v21-settings.ts:227-236` 有 `meaning` 且契约侧 `ManagedCatalogEntry` 同形；面板标签目录可填含义 → 字段真实存在且被消费，不是死字段。

## 本节整体结论
12 条里只有 BR-8（配置即快照）与 BR-12（无语义不删）可以用无争议证据判为已实现，且两者都集中在 v2.1 写回/渲染这一侧。**本节整体不能判为「已实现」**。硬缺口三处：BR-4（五个默认模板全量重发正文）与 BR-5（issue/PR 无命名空间隔离）是与需求方向相反的实体行为；BR-6 是「只写不读」，后台无法查询判定。BR-3 的「上一轮失败不算重复」完全缺席，会造成一次故障永久锁死同一内容，是本节后果最重的一条。BR-1 / BR-2 / BR-9 / BR-10 / BR-11 属「主体在、硬约束或结构化留痕缺失」，其中 BR-11 在 legacy 打标路径上实现的语义（删过一次永久不加回）与需求相反，且证据来自平台自己的撤标动作。

## 核查边界
- 是否执行了命令：**未执行**测试、构建、typecheck、迁移；只执行了只读检索（`git status --short`、`git rev-parse HEAD`、`Select-String` / `Get-Content` 读取源码与 SQL）。因此本报告只声明「测试存在且断言具体」（如 `writeback-v21-labels.test.ts:108-115`、`agent-serial-queue.test.ts:145-156`），不声明任何测试「跑过且绿」。
- 未覆盖的条目及原因：BR-1 / BR-2 的「并发是否真会发生」需要运行环境（PG + 多进程 dispatcher / 真实 Host）才能确认竞态是否可复现，本报告只据代码结构与注释判定「无数据库级防护」；BR-7 的 reaction 可见性依赖真实 GitHub 写面，未实测。BR-9 的「目录 ↔ GitHub」若未来由面板保存流程补齐，需重新核对，本次未读到任何保存期校验。
- 发现的额外问题（不属本节范围但值得记录）：
  1. `issues.unlabeled` / `issues.reopened` 等事件既不写 `decision`（`webhook-v21.ts:93-105` → `handleV21Webhook` 不接管）也不投递（`webhook.ts:384` 的 `ISSUE_ACTIONS` + `:619-620`），其投递行永远是「未判定」，与 BR-6 的留痕语义冲突。
  2. v2.1 路径的撤标也会写 `bot_labels.removed_at`（`run-task.ts:370-377`），从而污染 legacy 的否决集合（`normalize.ts:241-263`）——两套写回路径共用一个没有 actor 维度的记账表，跨路径互相下毒。
  3. `currentLabels` 取自 `bot_labels`（`compose.ts:1658-1678`）导致的双向失真：人删掉我们打的标签后仍被视为「当前存在」（于是 `desired` 里有也不会重加），而人打的标签永远不可见（于是永远不会被对齐删除）。
  4. `agent_messages` 缺 `(repo, issue_number) WHERE status='running'` 部分唯一索引（`dispatcher.ts:20-23` 自认），BR-1 / BR-2 的共同根因。
