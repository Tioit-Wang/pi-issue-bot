# U3-A 需求实现核查：requirements.html §5.3 会话协调（FR-3.1 ~ FR-3.5）

- 需求正文：`docs/requirements.html` 行 858–922
- 审查基线：仓库当前工作区（只读，未修改任何文件，未运行测试）
- 状态取值：已实现 / 部分实现 / 未实现 / 与需求冲突 / 无法判定

---

## FR-3.1 一个 issue 只对应一个会话

**状态：部分实现**

### 证据

| 事实 | 证据 |
|---|---|
| 「仓库 + issue 编号 → 会话」映射表 | `apps/server/src/db/schema.ts:658-686` `agentSessions`（表 `agent_sessions`） |
| 一对一 + 数据库唯一兜底 | `apps/server/src/db/schema.ts:685` `primaryKey({ columns: [t.repo, t.issueNumber] })`（主键而非独立 unique index，约束效果等价：一个 issue 只有一行） |
| 唯一权威来源（读/写各一处） | `apps/server/src/agent/store.ts:43`（`AgentSessionRow` 注释「会话状态的**唯一**来源」）、`store.ts:152-163`（`loadSession` / `saveSession` UPSERT 一条 SQL）；装配层只经 `apps/server/src/app/compose.ts:122-124`、`:1007-1053` 调用 |
| 首次触发创建 | `apps/server/src/http/webhook.ts:1210-1222`（每条 v21 事件都 `applyV21SessionOnEvent`）→ `apps/server/src/http/webhook-v21.ts:829-855`（`create` 分支 INSERT，`ON CONFLICT DO NOTHING`，`:793-795`） |
| 后续复用不新建 | `apps/server/src/app/compose.ts:423-480` `planAgentSession()`：无 `session_id` → 新建；有 id → `{mode:'persistent', sessionId, after: cursor}`（复用 + attach）；`session-state.ts:112-120` 只为 `session === null` 产出 `create` |
| 测试 | `apps/server/test/agent-serial-queue.test.ts:223-251`（两次 @ → 同一 `session_id`，`session/create` 只调 1 次、`session/attach` ≥1 次，`turns` 1→2） |

### 缺口

1. **PR 侧没有会话**：`agent_sessions` 没有 `target_kind` 列（只按 `issue_number`）——见 `db/schema.ts:658-686`；而 PR 事件一律不纳入（`webhook-v21.ts:85-89`、`trigger/decide.ts:274-276` `pr-ignored`），`app/compose.ts:1157-1160` 对非 issue 目标直接读 `null`。需求「PR 与 issue 各自独立会话，不共享上下文」当前不是「两套独立会话」，而是「PR 无会话」。风险级别低（PR 本来就不纳入本轮范围），但需求文字与实现不一致，应写进文档边界说明。
2. **PR 编号会被写成一条垃圾会话行**：`apps/server/src/http/webhook.ts:1206-1217` 只用 `X-GitHub-Event` + `action` 推出事件键，**没有**检查 payload 的 `issue.pull_request`。PR 上的 `issue_comment.created` 因此也会 INSERT 一条 `(repo, PR 编号)` 的 `agent_sessions` 行（`state='active'`，永远没有消费者）。这是实现缺陷，不改变功能但污染映射表——需求说「映射是一对一且唯一权威来源」，多出来的行不属于任何 issue 会话。

---

## FR-3.2 多事件进入同一会话（追加一轮，建立在前轮历史之上）

**状态：已实现**

### 证据

| 事实 | 证据 |
|---|---|
| 复用同一会话（不是重开一段） | `apps/server/src/runtime/turn-driver.ts:354-392`：`persistent` + 有 `sessionId` → `session/attach` 接管，仅 attach 失败才新建（`:370-373`、`:479-497`） |
| 本轮建立在前轮历史之上 | `turn-driver.ts:394-402`：`events/subscribe { after }` 用上轮游标（`:331-332`、`:414-415`），`turn/start` 在**同一 sessionId** 上追加（不 new session） |
| 不归档（否则下一轮 attach 不到） | `turn-driver.ts:426-443`（只有 `ephemeral` 才 `session/archive`）、`:468-469`（persistent 失败也不归档） |
| 游标/轮数写回，供下一轮续接 | `apps/server/src/app/compose.ts:1023-1053`（`turns` 递增、`session_id`/`cursor` 落 `agent_sessions`）、`:465-479`（`after` 只在有游标时传，防重放） |
| 测试 | `apps/server/test/agent-serial-queue.test.ts:248-250`（第一轮 `session/create`，第二轮走 `session/attach`） |

### 缺口

需求层面的「每轮都建立在前一轮的历史之上」被 **30 轮 / 7 天的会话轮换**打断，见 FR-3.4 缺口 ②（同一处代码，不重复计数）。

---

## FR-3.3 同 issue 串行、跨 issue 并行

**状态：已实现**（单实例部署成立；多实例有已知窗口）

### 证据

| 事实 | 证据 |
|---|---|
| 排队语义落在 `agent_messages`（不用 pg-boss `singletonKey`，否则第二条会被丢） | `apps/server/src/agent/dispatcher.ts:1-24`、`apps/server/src/agent/store.ts:5-13` |
| 同一时刻只允许一轮在跑 | `store.ts:106-115`（`queuedIssues` 用 `NOT EXISTS (running)` 排除已有 running 的 issue）、`store.ts:124-139`（`claimOldest`：`FOR UPDATE SKIP LOCKED` + 第二条 `NOT EXISTS (running)`，选中即置 `running`，单语句原子） |
| 到达即入队、不丢 | `store.ts:95-98` `insertMessage` 无条件 `INSERT … ON CONFLICT (repo, issue, fingerprint) DO NOTHING`（不因 running 丢弃）；`dispatcher.ts:85-116` 领不到就留 queued |
| 按到达顺序消费 | `store.ts:130` `ORDER BY "created_at" ASC, "fingerprint" ASC`；`store.ts:114` 跨 issue 也按最老 queued 排序 |
| 一轮结束立刻取下一条（不等 cron） | `dispatcher.ts:192-207` `finishMessageAndContinue` |
| agent-dispatch 并发 = 1（语义要求，非性能） | `apps/server/src/queue/definitions.ts:146-159`（`concurrency: 1`）；cron 只是兜底 `definitions.ts:226-240` |
| 跨 issue 真并行（不被全局 1 卡死） | 执行侧是独立队列：`definitions.ts:92-99` `run-task` `concurrency: 3`；仓库级另限 2（`apps/server/src/queue/repo-concurrency.ts:18`，可配置 1–8） |
| 测试 | `apps/server/test/agent-serial-queue.test.ts:179-210`（连发 3 条 → `['running','queued','queued']`，一次只跑一条，`runs` 时间段不重叠）、`:212-219`（不同 issue 同时两条 running） |

### 缺口 / 残余风险

1. **串行不是队列级 `singletonKey` 语义，而是「DB 状态 + 进程内并发 1」**。`dispatcher.ts:20-23` 自承：两个 dispatcher 进程同时进 `claimOldest` 时，`NOT EXISTS (running)` 是快照判定，可能各领到同一 issue 的两条；彻底解决需要部分唯一索引 `(repo, issue_number) WHERE status='running'`（代码里没有）。**单实例部署（cron + concurrency=1）下成立，多实例/滚动发布期间不成立**。
2. 仓库级并发默认 2 会让同一仓库的不同 issue 排队，这是资源闸（`repo-concurrency.ts:5-11` 明确说明），不是会话串行——但若需求验收要求「不同 issue 一定同时在跑」，需注意这是可配置上限。
3. 顺序依据是 `created_at`（= 入库时刻，`store.ts:96` `now()`），不是 GitHub 事件发生时刻；对正常投递等价，对乱序重投不等价。

---

## FR-3.4 会话常驻，沙箱随 issue 关闭回收

**状态：部分实现**（会话侧合规；沙箱侧只有账面状态，无真实资源对应；另有一处归档行为与需求冲突）

### 证据（合规部分）

| 事实 | 证据 |
|---|---|
| 运行状态只有两种 | `apps/server/src/agent/session-state.ts:19-21` `SESSION_STATES = ['active','idle']`；`db/schema.ts:689-694` `AGENT_SESSION_STATE` 只有 active/idle；DB 列 `schema.ts:676` `state text NOT NULL DEFAULT 'idle'` |
| 没有「结束」状态，动作集类型级禁止删除/归档 | `session-state.ts:64-71` `SESSION_ACTIONS = ['create','reuse','recycle-sandbox']`（注释明写「永远不允许存在」）；测试 `test/agent-session-state.test.ts:33-51,194-201`、`test/v21-worker-integration.test.ts:650-656` |
| issue 关闭 → 只回收沙箱（会话行与记录保留） | `session-state.ts:122-131`（`recycle-sandbox` / `state='idle'` / `keepSession=true`）；落库 SQL 只有 `SELECT` + `UPDATE`：`app/compose.ts:280-293`、`http/webhook-v21.ts:788-801`（`state='idle', sandbox_id=NULL, closed_at=now()`） |
| 永不 DELETE / 永不 archive 会话行 | `compose.ts:276-278`（注释）、`:300-303`（`deleteSession: false`、`archiveSessionId: null`）；全仓源码无 `DELETE FROM "agent_sessions"`（grep 结果只有 INSERT/UPDATE） |
| issue 重开直接复用原会话 | `session-state.ts:133-142`（`reuse` + `rebuildSandbox=true`）；`webhook-v21.ts:799-801`（`state='active'`，`sandbox_id = COALESCE(sandbox_id, $3)`） |
| 竞态保护 | `session-state.ts:100-102`（事件说关了但实时状态 open → 按未关处理） |
| 测试 | `test/agent-session-state.test.ts:82-147,186-225`、`test/v21-worker-integration.test.ts:632-676`、`test/v21-integration.test.ts:475-500` |

### 缺口

1. **「沙箱随 issue 关闭回收」没有可回收对象，`sandbox_id` 在生产里永远是 NULL。**
   `app/compose.ts:399,414-418`：只有注入了 `hooks.createSandbox()` 才会写 `sandbox_id`；全仓 `src/` 内**没有任何调用方传这个 hook**（grep `createSandbox` 只有 `compose.ts:414` 使用处与 `sandbox/docker.ts` 的同名工厂函数）。`compose.ts:386-388` 自述：本仓库的容器是「runTask 每轮创建、结束即销毁」的临时沙箱，`sandbox/lifecycle.ts` 的保留期规则（`:33-105`）也只针对 job 容器。因此 `state` / `closed_at` 只是账面上的两个字段，`issue 关闭 → 回收 agent 沙箱` 这条资源动作**没有实现**（既没有常驻沙箱，也没有 issue 关闭时的 docker 回收路径）。
2. **会话轮换会 archive 旧会话 —— 与「不归档、没有结束状态」冲突。**
   `app/compose.ts:1315-1338`：`if (!v21SessionEventActive && agentSession.archiveSessionId !== null) await channel.ops.sessionArchive(...)`；而 `v21SessionEventActive` 只在调用方显式传 `input.sessionEvent` 时为 true（`compose.ts:1196-1207`），生产调用方**一个都没传**（全仓 grep：只有 `compose.ts` 内部读它，`src/` 与 `test/` 都没有传参点；唯一的 `executeTask` 生产调用在 `compose.ts:1461` 的队列 job 分支，不带 `sessionEvent`）。于是队列路径恒为 false，`planAgentSession()`（`compose.ts:450-463`，阈值 `AGENT_SESSION_POLICY.maxTurns=30`、`maxAgeDays=7`）在 `turns>=30` 或存活超 7 天时**先 archive 旧 RACP 会话再新建一条 session_id**。映射行保留，但上下文被切断——正是需求 FR-3.4 点名要避免的事故（「任何归档动作都会让重开的 issue 失去上下文」）。`archiveSessionId` 在 v2.1 纯函数侧恒为 null（`compose.ts:302-303`），说明这是未被 v2.1 收编的老路径。
3. 「沙箱随 issue 关闭回收」与「重开时按需重建」的分支只在纯函数里成立（`session-state.ts:156-162` `idle-sandbox` 判定），没有对应的资源实现可验证。

---

## FR-3.5 幂等：三层去重

**状态：部分实现**（投递级、事件级、内容级键都在；但规范化口径超出需求、失败不复用未实现、留痕未落库）

### 证据

| 层 | 证据 |
|---|---|
| 投递级（GitHub 投递 ID） | `apps/server/src/http/webhook.ts:1100-1122`（`INSERT … ON CONFLICT`，`rowCount=0` → 200 `duplicate`；`:1115-1116` 不覆盖原判定） |
| 事件级（事件自身键） | `apps/server/src/agent/fingerprint.ts:36-49` `eventFingerprint` = `sha256(repo, issue, 'event', templateId, issue.updated_at)`；`http/webhook-v21.ts:903-916` `v21MessageFingerprint` 选键规则 |
| 内容级（同一 issue 内评论正文） | `fingerprint.ts:59-64` `commentFingerprint` = `sha256(repo, issue, 'comment', 规范化正文)`（**无作者、无 issue.updated_at**）；`webhook-v21.ts:908-915` 评论正文非空时走它 |
| 内容级唯一性靠数据库 | `db/schema.ts:726-730` `primaryKey(repo, issue_number, fingerprint)`；`agent/store.ts:95-98` `insertMessage` `ON CONFLICT DO NOTHING`；命中即 `duplicate`：`http/webhook-v21.ts:1038-1044`、`http/webhook.ts:1606-1621` |
| 作用域只看 issue 内 | `fingerprint.ts:59-64` 把 `repo` + `issueNumber` 纳入 hash；测试 `test/v21-webhook-integration.test.ts:338-361` |
| 与作者无关 | 同上（hash 里没有 `actorLogin`）；`webhook-v21.ts:908-914` 只传 `text` |
| 不转小写 | `agent/canonical-text.ts:8`（注释「**不转小写**（OQ-10 未采纳）」）、测试 `test/agent-message.test.ts:41-43` |
| 测试 | `test/agent-serial-queue.test.ts:163-176`（归一化等价 / 换说法是新消息）、`test/v21-webhook-integration.test.ts:338-361` |

### 缺口

1. **「规范化」超出需求口径 —— 与需求冲突。**
   需求只允许「去首尾空白 + 合并连续空行」。实现是 `canonical-text.ts:30-36`：
   - 先 `maskCodeRegions()` 把代码区整体挖空（`:34`，`packages/contract` 提供）；
   - 去 `@handle`（`:15,35`）；
   - 去**全部标点与符号** `[\p{P}\p{S}]`（`:18,35`，中英文标点、`/`、`_`、emoji）；
   - **所有**空白（含换行）压成一个空格（`:21,35`），不是「合并连续空行」；
   - 最后 `trim()`。
   副作用：`「修好了。」` 与 `「修好了」`、`「看这里→A」` 与 `「看这里 A」`、只改标点的两段不同指令都会撞同一个 fingerprint 而被判重复丢弃；多行指令的行结构差异也被吃掉。测试 `test/agent-message.test.ts:35-38` 明确断言了「去标点后等价」，即这是刻意实现，不是 bug —— 因此归为**与需求文字冲突**（实现比需求宽，方向是「少烧钱」，代价是把不同内容判成重复）。
2. **「上次失败不参与去重（必须放行）」未实现 —— 与需求冲突。**
   `store.ts:95-98` 只有 `ON CONFLICT DO NOTHING`，没有按现有行 `status` 分支；命中后的两条 duplicate 分支（`webhook.ts:1606-1621`、`webhook-v21.ts:1038-1044`）都只读 `inserted=false`，**不看 `saved.row.status`**；全仓没有把 `failed` 消息重置为 `queued` 的调用方（`markMessage(..., 'queued')` 存在但零调用，grep 结果只有 `dispatcher.ts:136,201` 传 `failed`/`done`）。后果：上一轮超时 / 崩溃后，用户重贴同一句话 → 被判 duplicate → 静默不处理，正是需求点名的「一次故障永久锁死」。这一条同时是对「需求 §5 永久幂等」与「§5.3 FR-3.5 失败放行」矛盾的取舍，目前选的是前者，但没有实现后者提供的逃生口。
3. **「跳过要留痕（记『因重复内容跳过』）」只到日志与 HTTP 响应，未落库。**
   - `trigger/decide.ts:40,246-248` 有 `content-duplicate` 这个 `SkippedReason` 与分支；
   - 但 `contentDuplicate` 入参在全仓**没有任何调用方传**（grep：只有 `decide.ts:117`、`webhook-v21.ts:117,154,167` 的定义与透传），所以该分支是死代码；
   - 内容级重复实际发生在 `insertMessage` 之后，此时判定行已按「触发」写入：`webhook.ts:1014-1017` + `webhook-v21.ts:188-211`（`decision='triggered'`、`decision_reason='enabled'`），而 `webhook_deliveries` 没有记录「本次结果 = duplicate」的列（`db/schema.ts:88-135`）。
   → 后台按 `decision_reason` 查不到任何「因重复内容跳过」的记录，只有应用日志（`webhook.ts:1608-1611`、`webhook-v21.ts:1042`）与响应体 `action:'duplicate'`。需求「后台可查」不满足。
4. **事件级键不是「事件自身唯一标识」。** `fingerprint.ts:42-48` 用模板 + `issue.updated_at`（秒级精度）代替事件 id（payload 里的 `id`/`delivery_id` 未参与）。同一秒内同模板的两次不同事件（如连续两次 `labeled`）会互相当重复吞掉；`delivery_id` 已被投递级挡住，但跨投递的不同事件没有保护。风险轻微，属于口径偏差。
5. 空正文评论回落到事件级键（`webhook-v21.ts:909-916`，`body.trim()===''` 时）+ `commentId` 判断——两条内容为空但不同的评论无法区分，这是有意取舍（注释 `:900-901`），记录在案。

---

## 本节整体结论

| 需求 | 状态 | 一句话缺口 |
|---|---|---|
| FR-3.1 一 issue 一会话 | 部分实现 | 映射与唯一性（PK）成立；PR 侧根本没有会话，且 PR 上的评论会被误写一条 `agent_sessions` 垃圾行（`webhook.ts:1210` 未过滤 `issue.pull_request`） |
| FR-3.2 多事件同一会话追加一轮 | 已实现 | persistent attach + 游标续接都在；上下文会被 30 轮/7 天的轮换切断（见 FR-3.4 缺口 2） |
| FR-3.3 同 issue 串行、跨 issue 并行 | 已实现（单实例） | 串行靠 `agent_messages` 状态 + dispatcher concurrency=1，不是队列级 singletonKey，多实例有「各领一条」的已知窗口（无部分唯一索引） |
| FR-3.4 会话常驻、沙箱随关闭回收 | 部分实现 | 状态机与 SQL 层合规（只有 active/idle、无 DELETE/archive）；但没有任何生产代码创建 per-session 沙箱，`sandbox_id` 恒 NULL，「回收沙箱」无对象；且队列路径仍会在轮换时 `session/archive` 旧会话 |
| FR-3.5 三层去重 | 部分实现（含 1 条冲突） | 三层键都在且内容级落库唯一；但规范化做了去标点/去@/压换行（超出需求的 trim+合并空行），「上次失败不参与去重」没有分支（重贴会被永久判重），「因重复内容跳过」只进日志不进库（`content-duplicate` 是死分支） |

**优先修的三件事**（按需求优先级）：
1. FR-3.5 失败放行：`insertMessage` 命中时若现有行 `status='failed'`，重置为 `queued` 并重新 dispatch；同时把 `contentDuplicate` 真正算出来喂给 `decideEvent`，并在 `webhook_deliveries` 落一条 `content-duplicate` 判定（或新增结果列）。
2. FR-3.4 归档：把 `planAgentSession` 的轮换 archive 分支在 v2.1 路径上关掉（或让队列路径传 `sessionEvent`），否则「会话常驻」在 30 轮后自动失效。
3. FR-3.3/FR-3.4 资源与并发：补 `(repo, issue_number) WHERE status='running'` 部分唯一索引；明确 `sandbox_id` 是否真要落地（若不落地，需求应改为「沙箱按轮创建」，别让 `active/idle` 变成空承诺）。

**未做的验证**：本次为只读代码核查，未运行 `pnpm -r test` / `pnpm -r typecheck`，上述结论全部来自源码与既有测试的静态阅读（引用的测试用例未实际执行）。
