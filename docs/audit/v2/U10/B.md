# U10 5.3 会话协调 · B

> 核查范围：docs/requirements.html 行 858-922
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| FR-3.1 | 部分实现 | 映射唯一性有 PK 保证、首建后续用成立；但无 domain 列，PR 评论（`issue_comment` 打在 PR 上）照样进 issue 会话域，且任务 `target_kind` 被写死 `'issue'` |
| FR-3.2 | 与需求冲突 | 第 30 轮 / 第 8 天触发轮换：`compose.ts:1315-1317` 归档旧会话并换新 `session_id`，第 31 轮起不再基于前轮历史 |
| FR-3.3 | 部分实现 | 串行只靠应用层 `NOT EXISTS (running)` 快照 + 进程内 concurrency=1，无数据库级部分唯一索引；多实例下同 issue 可两轮并行 |
| FR-3.4 | 与需求冲突 | 「不归档」被轮换路径违反（同一处 `sessionArchive`）；生产里 v2.1 免归档守卫永不生效 |
| FR-3.5 | 与需求冲突 | 规范化多做了去 `@`/去标点/合并全部换行/蒙版代码区（`canonical-text.ts:35`）；「上次失败放行」无分支，失败内容被永久锁死；「跳过留痕」只写日志不落库 |

## 逐条

### FR-3.1
- **状态**：部分实现
- **证据**：
  - `apps/server/src/db/schema.ts:685` — `agent_sessions` 主键 `(repo, issue_number)`，一个 issue 只能一行；迁移侧同口径 `migrations/0006_agent.sql:27`。
  - `apps/server/src/agent/store.ts:156` — `saveSession` 是 `INSERT … ON CONFLICT (repo, issue_number) DO UPDATE`，即 UPSERT，不会产生第二条。
  - `apps/server/src/agent/store.ts:152` — `loadSession` 按 `(repo, issue_number)` 点查，是唯一读取面。
  - `apps/server/src/app/compose.ts:443` — `sessionId` 为空 → `{mode:'persistent'}`（新建）；`compose.ts:465-479` — 有 `sessionId` → `{mode:'persistent', sessionId, after: cursor}`（复用，带游标防重放）。
  - `apps/server/test/agent-serial-queue.test.ts:223` — 断言两次触发后仍只有 1 行、`session_id` 相同、`turns` 递增、`session/create` 只 1 次、`session/attach` ≥1 次。
  - `apps/server/src/http/webhook.ts:1210` — PR 事件（`pull_request.*`）被排除在会话迁移之外；`webhook-v21.ts:86-89` 把 `pull_request*` 归到 `pull_request.*`，`trigger/decide.ts:274-276` 恒判 `pr-ignored`。
  - 反证命中的缺口：`apps/server/src/http/webhook-v21.ts:903-915` 对 `issue_comment` 只按 `(repo, issue_number, 正文)` 算键，**不看 `issue.pull_request`**；`webhook.ts:561/627` 里那两处 PR 判断属于旧判定链，注入 v21 后不走（`webhook.ts:1260-1286` 提前 return）。`apps/server/src/agent/store.ts:148` 建任务时 `target_kind` 写死 `'issue'`。
- **缺口**：
  1. PR 与 issue 没有分域字段（`agent_sessions` / `agent_messages` 都只有 `repo + issue_number`），隔离全靠「PR 不进门」；而 `issue_comment` 打在 PR 上时确实进门了——v2.1 分支会为 PR 建/复用 `(repo, PR 编号)` 的会话并投 agent 任务，`target_kind` 还被写成 `issue`。需求「PR 与 issue 各自独立会话，不共享上下文」的这一半没有代码兜底。
  2. 「唯一权威来源」被复制成两份 SQL：`app/compose.ts:280-293` 与 `http/webhook-v21.ts:786-802` 是同一条 create/recycle/reuse 的两个副本。
- **判定依据**：一对一与「首建后续用」有数据库主键 + UPSERT + 单测三处证据，够推翻「没实现」；但「PR 分域」这条明写的子条件在 v2.1 主路径上没有拦截点，故不能判已实现。

### FR-3.2
- **状态**：与需求冲突
- **证据**：
  - 正常追加：`apps/server/src/app/compose.ts:465-479`（复用 + `after: cursor`）、`apps/server/src/runtime/turn-driver.ts:359-374`（`session/attach` 复用同 id）、`turn-driver.ts:433`（`persistent` 结束**不**归档）。
  - 反着来的一行：`apps/server/src/app/compose.ts:1315-1317` — `if (!v21SessionEventActive && agentSession.archiveSessionId !== null) { await channel.ops.sessionArchive({ sessionId: agentSession.archiveSessionId }) }`。
  - 触发条件：`compose.ts:209-212`（`maxTurns: 30`、`maxAgeDays: 7`）、`compose.ts:450-463`（`turns >= maxTurns` 或 `age >= 7d` → `rotate: true`、`archiveSessionId = sessionId`、`session` 不再带 id）。
  - 后果落库：`compose.ts:1036`（轮换那轮 `turns` 从 1 起）、`compose.ts:1039-1040`（旧 id 已归档 → 新 `session_id` 覆盖列）。
  - 另一条切断历史的路径：`apps/server/src/worker/run-task.ts:1109-1123`（工具轮结束时归档）——它有 `!firstRoundPersistent` 守卫，不会砸持久会话，不构成缺口。
- **缺口**：第 31 轮或第 8 天起，本轮不再建立在前轮历史之上——旧会话被 `session/archive` 归档、`session_id` 换成新的，`turns` 归零重计。需求写的是「追加一轮，每轮建立在前一轮历史之上」，这里是把历史断开重开一段。
- **判定依据**：不是「缺失」，是代码主动做了需求禁止的动作，且有明确的归档调用行与换 id 行；同时 `v21SessionEventActive` 在生产恒为 `false`（`executeTask` 唯一生产调用点 `compose.ts:1460-1464` 不传 `sessionEvent`），所以「v2.1 生效就不归档」的守卫根本不生效。

### FR-3.3
- **状态**：部分实现
- **证据**：
  - 队列即表：`apps/server/src/agent/store.ts:95-98`（入队 `status='queued'`，同 `(repo, issue, fingerprint)` 幂等）、`store.ts:106-115`（`queuedIssues`：排除已有 `running` 的 issue，按最老 queued 排序）。
  - 原子领件：`store.ts:124-139` — `UPDATE … WHERE (…) IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1) AND NOT EXISTS (running)`，一段语句里「选中 + 置 running」。
  - 串行第二道闸 + 承认的窗口：`apps/server/src/agent/dispatcher.ts:20-23` 自述「两个 dispatcher 真同时进 `claimOldest` 仍可能各领到同一 issue 的不同消息（`NOT EXISTS (running)` 是快照判定）……要彻底消灭需要一条部分唯一索引」；`queue/definitions.ts:152-153` 用 `concurrency: 1` 收窗口。
  - 顺序与不丢弃：`store.ts:130` 按 `created_at ASC, fingerprint ASC` 取；入队用 `singletonKey = taskId`（`queue/boss.ts:114-120`），按消息唯一而非按 issue，故第二条不会被丢（`dispatcher.ts:4-6` 解释了为何不用 pg-boss 的 issue 级 singletonKey）。
  - 跨 issue 并行：`dispatcher.ts:161-179` 一轮对每个 issue 各领一条；`apps/server/test/agent-serial-queue.test.ts:212-219` 断言两个 issue 同时 `running`；`test/agent-serial-queue.test.ts:179-210` 断言三条全入队、逐条消费、`runs` 时间区间不重叠。
- **缺口**：
  1. 串行的最终保证只在应用层：`migrations/0006_agent.sql:46` 只有 `(repo, issue_number, status, created_at)` 普通索引，**没有** `(repo, issue_number) WHERE status='running'` 部分唯一索引；`agent-dispatch` 的 `concurrency=1` 是 pg-boss 的进程内并发，多实例部署即失效。需求把并发写同一会话定性为「硬约束而非优化项」，这里只做到「通常在单实例下成立」。
  2. 「到达即入队不丢弃」到位，但「必然被消费」不到位：`jobs/index.ts:106-115` 六个作业（queue-gate / metrics-rollup / reconcile-reverts / retention-cleanup / lifecycle-sweep / agent-dispatch）没有一个扫 `agent_messages.status='running'`，全仓也无回退语句；进程在「claim 成功、`finishMessageAndContinue` 之前」崩溃时，该 issue 的队列被这条 `running` 永久堵住（`store.ts:134-138` 的 `NOT EXISTS (running)` 会一直拦）。
- **判定依据**：串行 + 并行 + 顺序 + 不丢弃四条都有可指认实现与具体断言，主体成立；但需求强调的「硬约束」缺数据库级兜底，且存在永久卡死路径，故为部分实现并点名这两处。

### FR-3.4
- **状态**：与需求冲突
- **证据**：
  - 状态只有两值：`apps/server/src/agent/session-state.ts:19`（`['active','idle']`）、`db/schema.ts:689-694`、`migrations/0011_v21.sql:22`（`state` 默认 `'idle'`）。
  - 迁移动词不含删/归档：`session-state.ts:69`（`['create','reuse','recycle-sandbox']`）；`session-state.ts:112-163` 全矩阵只产出这三种。
  - 关闭只回收沙箱：`http/webhook-v21.ts:796-798`（`state='idle'`、`sandbox_id=NULL`、`closed_at=now()`，会话行保留）、`webhook.ts:1212` 权威写入点；重开：`session-state.ts:134-142`（复用 + 标记重建沙箱）。
  - 全仓无删会话的 SQL：`migrations/` 与 `apps/server/src/` 内 `DELETE FROM "agent_sessions"` 命中 0；`jobs/retention-cleanup.ts:55/74` 只删 `run_events` 与 `webhook_deliveries`。
  - 反着来的一行：`apps/server/src/app/compose.ts:1315-1317` — 轮换时对旧会话发 `sessionArchive`；配套 `compose.ts:1039-1040` 把 `session_id` 换成新 id、`compose.ts:1036` 把 `turns` 归 1。需求原句：「会话没有『结束』这个状态……任何归档动作都会让重开的 issue 失去上下文」「不归档、不释放映射」。
  - 守卫不生效：`compose.ts:1195-1207` 的 `v21SessionEventActive` 仅当 `input.sessionEvent !== undefined` 为真；生产唯一入口 `compose.ts:1460-1464`（`onTaskJob`）不传该字段，全仓也无其它调用点传它。
- **缺口**：
  1. 「不归档」被轮换路径实质违反：第 30 轮 / 第 8 天后旧会话被 RACP 归档、映射指向新会话，重开的 issue 拿到的是「轮换后」的新上下文，旧历史只能靠归档侧是否还留着（代码侧不再引用）。
  2. 「活跃（沙箱存在）」只有状态位、没有真实资源：`applyV21SessionTransition` 的 `createSandbox` 钩子生产未注入（`compose.ts:399/414`，仅 `test/v21-worker-integration.test.ts:712` 注入），因此 `sandbox_id` 生产恒为 `NULL`，`state='active'` 与「沙箱存在」不再等价（`session-state.ts:56` 的「idle 时必为 null」反向不成立）。
- **判定依据**：数据侧（不删行、两态、关闭只置 idle）证据充分且无争议；但「不归档」这条被同一模块的轮换路径反着做，且守卫条件在生产恒假——需求原文明确禁止，故判冲突而非部分实现。

### FR-3.5
- **状态**：与需求冲突
- **证据（三层在）**：
  - 投递级：`apps/server/src/http/webhook.ts:1100-1121` — `INSERT … ON CONFLICT (delivery_id) DO NOTHING`，`rowCount=0` 即 200 duplicate。
  - 事件级：`apps/server/src/agent/fingerprint.ts:36-49`（`repo|issue|'event'|templateId|issue.updated_at`），接在 `webhook-v21.ts:916-921`。
  - 内容级：`fingerprint.ts:59-65`（`repo|issue|'comment'|归一化正文`），接在 `webhook-v21.ts:903-915`；作用域只含 issue（不跨 issue）✔，摘要不含作者（与作者无关）✔。
- **证据（口径冲突）**：`apps/server/src/agent/canonical-text.ts:35` —
  `masked.replace(AT_HANDLE, ' ').replace(PUNCTUATION_OR_SYMBOL, ' ').replace(WHITESPACE, ' ').trim()`，
  即：① 代码区整体蒙版（`canonical-text.ts:34` → `maskCodeRegions`，代码内容完全不参与比较）；② 去掉所有 `@handle`；③ 去掉全部 Unicode `P*`/`S*`（中英文标点、emoji）；④ 把换行/制表/多空格一律压成一个空格。需求口径只有「去首尾空白、合并连续空行」，并明写「不做语义近似判断——措辞不同就是不同内容」。
- **证据（失败放行缺失）**：`apps/server/src/agent/store.ts:95-98` — `INSERT … ON CONFLICT (repo, issue_number, fingerprint) DO NOTHING`；调用侧 `webhook-v21.ts:1038-1044` 与 `webhook.ts:1606-1621` 只看 `saved.inserted` 就直接返回 `duplicate`，**从不读** `saved.row.status`（`insertMessage` 已在 `store.ts:236-237` 把该行读回来了，就是没人用）。`failed` 的产生路径存在：`dispatcher.ts:136-140`（投递失败置 `failed`）、`compose.ts:1085`（`outcome !== 'succeeded'` → `failed`）。
- **证据（跳过留痕缺失）**：`webhook-v21.ts:1042` 只有 `logger.info('v2.1 消息幂等命中：不重复投递')` + 响应体 `action:'duplicate'`（`webhook-v21.ts:1043`）；`webhook_deliveries.decision` 由外层 `webhook.ts:1014-1017` 写成 `triggered`（不是 `content-duplicate`）；`trigger/decide.ts:246-247` 的 `contentDuplicate → 'content-duplicate'` 分支**零调用方**（全仓只有类型定义与透传，见 `webhook-v21.ts:117/154`）；`apps/server/src/queries`、`http/api`、`apps/panel` 内对 `agent_messages` 的引用为 0，后台无读取面。
- **缺口**：
  1. 规范化多做四步，其中「去标点」「代码区蒙版」「合并全部换行」直接制造需求禁止的语义近似：`Fix it!` 与 `Fix it`、只改代码块的两次求助会被判成同一内容。
  2. 「上次失败不参与去重」完全没有分支：永久幂等 + 失败不清理 → 一次超时/崩溃就把这段正文永久锁死，正是需求点名要避免的场景。
  3. 「跳过要留痕（后台可查）」只有日志与 HTTP 响应字段，没有落库行、没有 `content-duplicate` 判定原因、没有面板/查询读面。
- **判定依据**：三层结构真实存在且各有一处实现与断言；但五条内容级口径里第 2、4、5 条与需求相反或缺失，且第 2 条是需求用「必须放行」明确规定的——按模板属「代码行为与需求相反」，指认行是 `canonical-text.ts:35` 与 `store.ts:97`。

## 本节整体结论
不能判为「已实现」。会话映射的数据库唯一性、首建后续用、三层去重骨架、同 issue 串行的主链路都在，且有可指认的断言；但四条硬口径被违反或缺失：轮换路径归档旧会话并更换 `session_id`（与 FR-3.4「不归档」、FR-3.2「基于前轮历史」正面冲突，且生产守卫恒假），串行缺数据库级兜底、多实例下不成立，内容级规范化大幅超出「只去空白与合并空行」并缺「上次失败放行」，「跳过留痕」未落库。建议按 FR-3.4 > FR-3.5 > FR-3.3 > FR-3.1 顺序整改，FR-3.1 的 PR 分域需先确定是否引入 domain 维度。

## 核查边界
- 是否执行了命令：执行了 `cd apps/server; npx vitest run test/agent-session-state.test.ts test/agent-message.test.ts` → 2 文件 / 38 用例全通过（`agent-session-state` 15、`agent-message` 23）。其余为静态核查。
- 未覆盖的条目及原因：`test/agent-serial-queue.test.ts`、`test/v21-webhook-integration.test.ts`、`test/agent-events.test.ts` 均依赖 `openTestDb()`（PostgreSQL），本轮未起库，故这些用例只按源码断言内容计入「测试存在且断言具体」，不声明「跑过且绿」。未启动 Docker / pi-host，故 RACP 侧 `session/archive` 的真实效果（旧会话是否真的不可 attach）未实测。
- 发现的额外问题（不属本节范围但值得记录）：
  1. `apps/server/src/agent/store.ts:148` 建任务时 `target_kind` 写死 `'issue'`，PR 来源的 agent 消息无法在 `tasks` 侧被区分。
  2. `apps/server/src/agent/dispatcher.ts:109-116` 幂等键命中时返回 `enqueued: true` 但并没有入队，统计口径会虚高。
  3. `apps/server/src/app/compose.ts:280-293` 与 `http/webhook-v21.ts:786-802` 是同一组会话 SQL 的两份副本（第二处真相）。
  4. `apps/server/src/worker/run-task.ts:1109-1123` 的归档只在「首轮非 persistent」时触发，逻辑正确但依赖注释维持，无测试锁定该守卫。
