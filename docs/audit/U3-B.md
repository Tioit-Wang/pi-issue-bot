# U3-B 需求实现核查（反证视角）：需求 §5.3 会话协调

- 需求文档：`docs/requirements.html` 858-922（FR-3.1 ~ FR-3.5）
- 审查方式：默认每条需求「没真正实现」，逐条去找能推翻「已实现」的代码；只有无争议证据才承认
- 仓库状态：工作区有未提交改动（`git status --short` 共 29 个文件，含 `agent/canonical-text.ts`、`agent/fingerprint.ts`、`http/webhook-v21.ts`），本报告读的是**工作区当前内容**，不是 HEAD
- 只读：未修改任何仓库文件

状态取值五选一：`已实现` / `基本实现`（正面路径齐、缺口不致命） / `部分实现`（关键分支缺或走偏） / `未实现` / `无法验证`

---

## FR-3.1 一个 issue 只对应一个会话

**状态：基本实现**

### 反证过程（试过的推翻检查点）

1. 「映射是否一对一」→ 推翻失败。`agent_sessions` 主键就是 `(repo, issue_number)`，一个 issue 只能有一行（`apps/server/src/db/schema.ts:658-686`，主键在 685 行）。写回走 UPSERT，同一个 issue 不会出现第二行（`apps/server/src/agent/store.ts:156-163`）。
2. 「首次创建、后续复用」→ 推翻失败。纯函数 `planSessionOnEvent()` 的 ①「没有会话 → create」、⑤「其余 → reuse」，`SessionAction` 里没有第三种建会话的取值（`apps/server/src/agent/session-state.ts:108-164`，69-71）。真库集成测试断言「第二轮走 `session/attach`，`session/create` 只发生 1 次」（`apps/server/test/agent-serial-queue.test.ts:246-250`）。
3. 「是否有第二个部件自行推断会话归属」→ **部分推翻成功**。会话行唯一来源是 `agent_sessions`，`queries/` 与 `http/api/` 里对 `agent_sessions` 的引用为 0（`rg agent_sessions apps/server/src/queries apps/server/src/http/api` 无命中），所以面板没有第二份映射。但装配层确实在**自行推断**会话相关输入：`v21EventOfCommand()` 从 `tasks.command` 字符串「保守推断」事件键，再喂给会话状态机（`apps/server/src/app/compose.ts:246-266`），这与「其他部件不得自行推断会话归属」的用意相抵（虽然推断的是事件而非会话 id）。
4. 「PR 与 issue 是否隔离」→ 隔离，但方式是「PR 整个不进门」。`decidePullRequest()` 把 PR 固定判成 `pr-ignored`，连模板都没有（`apps/server/src/trigger/decide.ts:69-74`、271-276）；`webhook-v21.ts` 里 PR 只走 `ignored` 分支。因此不存在「PR 会话与 issue 会话共享上下文」的可能——**但也没有 PR 自己的会话**，而且映射键里没有 `target_kind` 维度（`schema.ts:661-663`）：一旦哪天 PR 进管线，PR #7 与 issue #7 会静默共用同一行会话。
5. 「后续触发是否真的不新建会话」→ **推翻成功**（见 FR-3.4 缺口）：轮换策略会新建 RACP 会话。

### 证据

- 一对一映射：`apps/server/src/db/schema.ts:658-686`（PK 在 685）、`apps/server/src/db/schema.ts:656`（注释「一个 issue 一行」）
- UPSERT 复用：`apps/server/src/agent/store.ts:152-163`、`apps/server/src/app/compose.ts:280-293`
- 创建/复用判定：`apps/server/src/agent/session-state.ts:108-142`、`apps/server/src/http/webhook-v21.ts:829-855`（权威写入点）
- 测试：`apps/server/test/agent-serial-queue.test.ts:223-251`、`apps/server/test/agent-session-state.test.ts:55-147`

### 缺口

1. **轮换会新建会话**（与「后续触发复用，不新建」冲突），详见 FR-3.4 缺口 1：`apps/server/src/app/compose.ts:450-463`。
2. **映射键缺 `target_kind`**：PR 与同编号 issue 无法在数据层区分（`schema.ts:661-663`）；目前只靠 `decide.ts:275` 把 PR 全量挡在门外，不是「各自独立会话」而是「PR 无会话」。
3. 装配层用 `tasks.command` 字符串反推事件键（`compose.ts:253-266`），是「另一处推断」的雏形。

---

## FR-3.2 事件以「追加一轮」进入同一会话，每轮基于前轮历史

**状态：基本实现**

### 反证过程（试过的推翻检查点）

1. 「是不是每轮重开一段」→ 推翻失败（正面）。agent 任务拿到 `persistent` 会话计划：有 `session_id` 就 `session/attach`，没有才 `session/create`（`apps/server/src/runtime/turn-driver.ts:354-390`、`apps/server/src/app/compose.ts:465-480`）；`persistent` 会话跑完**不 archive**（`turn-driver.ts:424-456`、`apps/server/src/worker/run-task.ts:1096-1123` 明确「第 1 轮就是 persistent 时绝不能归档」）。测试断言 `session/create` 恰好 1 次、`session/attach` ≥1 次（`apps/server/test/agent-serial-queue.test.ts:248-250`）。
2. 「上一轮历史真的在上下文里吗」→ 部分证实：第二轮提示词里只有「这一条消息」，系统段靠会话历史延续（`compose.ts:1236-1252` 注释「会话是 persistent，任务说明还在上下文里」；`run-task.ts:1088`）。是「靠会话 attach 承载历史」，不是「每轮重放历史」——符合需求的「追加一轮」。
3. 「有没有把历史切断的路径」→ **推翻成功，两条**：
   - **轮换**：`turns >= 30` 或存活 `> 7 天` 就 `rotate`，计划里**不带 sessionId**，于是 `driveTurn` 新建会话、旧会话被 archive，`started_at` 重置、`turns` 重置为 1（`compose.ts:450-463`、`compose.ts:1033-1042`、常量 `compose.ts:209-212`）。7 天是硬期限：任何存活超过 7 天的 issue 都会被强制切断一次上下文。
   - **attach 失败**：新建会话继续跑，只留 `sessionReset` 标记与一条 warn（`turn-driver.ts:359-374`、`compose.ts:1043-1048`）。
4. 「轮换那段的 archive 有没有被 v2.1 守卫拦住」→ **没有，守卫是死代码**。`compose.ts:1315` 用 `v21SessionEventActive` 作条件，而该变量只在 `input.sessionEvent !== undefined` 时为 true（`compose.ts:1195-1207`）；`executeTask` 的 `sessionEvent` 入参**在全仓没有任何构造者**（`rg "sessionEvent"` 只命中类型声明 `compose.ts:533`、读取点 1196/1201-1203，以及 `webhook.ts:1206` 的同名局部变量——那里调的是 `applyV21SessionOnEvent`，没有传给 `executeTask`）。真实队列路径（`compose.ts:1460-1464` 的 `onTaskJob`）永远不传，所以 `v21SessionEventActive` 恒 false，归档照发。

### 证据

- `apps/server/src/runtime/turn-driver.ts:354-374`（attach 复用 / 失败新建）
- `apps/server/src/app/compose.ts:465-480`（复用分支，`after` 游标防重放）
- `apps/server/src/worker/run-task.ts:1096-1123`（persistent 首轮不归档）
- `apps/server/src/app/compose.ts:450-463`、`1033-1053`、`1311-1338`（轮换 + archive）
- 测试：`apps/server/test/agent-serial-queue.test.ts:223-251`、`apps/server/test/e2e-dry-run.test.ts:200`

### 缺口

1. **30 轮 / 7 天轮换直接违反「追加一轮而不是重开一段」**：`compose.ts:450-463`（阈值 `compose.ts:209-212`）。且这条路径**没有任何测试**（`rg planAgentSession apps/server/test` 无命中，`rg "轮换|maxTurns" apps/server/test` 只命中一句注释），属于「写了但没人验证」。
2. **`compose.ts:1315` 的 v2.1 守卫永远不生效**（`sessionEvent` 无调用者），所以「FR-3.4 明令不归档」这条注释在真实链路上是假的。
3. attach 失败 / `report.sessionReset` 时上下文静默断掉，只有日志可查（`turn-driver.ts:370-373`、`compose.ts:1043-1048`）。

---

## FR-3.3 同 issue 串行，跨 issue 并行

**状态：部分实现**

### 反证过程（试过的推翻检查点）

1. 「串行是不是只靠进程内 Promise/Map」→ 推翻失败（正面部分）。排队语义落在 `agent_messages` 表上，没有第二套内存队列（`apps/server/src/agent/store.ts:1-14` 注释 + 全文无 Map/Promise 队列）。领件是单条 SQL：`UPDATE … WHERE (repo,issue,fingerprint) IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1) AND NOT EXISTS (running)`（`store.ts:124-139`），列表侧也排除已有 running 的 issue（`store.ts:106-115`）。
2. 「事件到达会不会被丢」→ 推翻失败（正面）。没有用 pg-boss 的 `singletonKey` 排队（那会丢第二条，`apps/server/src/agent/dispatcher.ts:1-8` 说明），消息先落 `agent_messages`（`insertMessage` `ON CONFLICT DO NOTHING`，`store.ts:95-98`）。测试断言连发 3 条后状态是 `['running','queued','queued']`、共 3 个任务（`apps/server/test/agent-serial-queue.test.ts:179-210`）。
3. 「按到达顺序消费」→ 基本成立，顺序键是 `created_at ASC`，第二排序键是 `fingerprint ASC`（哈希，`store.ts:130`）。同一 `created_at`（`now()` 为事务时间，同毫秒级）时顺序由哈希决定，不是严格到达序。
4. 「`agent-dispatch` 并发是否为 1」→ 是（`apps/server/src/queue/definitions.ts:146-159`，`concurrency: 1`），且 `validateDefinitions` 会拦 1–4 之外的值（`definitions.ts:342-344`）。
5. 「并发只靠 concurrency=1 吗、这个闸能不能被绕过」→ **推翻成功**。pg-boss 的 concurrency 是**进程内**的，而 webhook 落库后**在队列之外**直接调用 `dispatchNextForIssue`（`apps/server/src/app/compose.ts:978` 接线，`apps/server/src/http/webhook-v21.ts:1047-1053`、`apps/server/src/http/webhook.ts:1625-1631` 调用），完全不受 `agent-dispatch` 的 concurrency=1 约束。
6. 「`claimOldest` 的 `NOT EXISTS (running)` 能否挡住并发领件」→ **挡不住**。两个事务并发时，各自在**同一快照**里看不到对方刚置的 running，`SELECT … FOR UPDATE SKIP LOCKED` 又只是锁住**自己**选中的那一行（不同 fingerprint → 不冲突），于是两条都被置 running。数据库层**没有**部分唯一索引兜底：`agent_messages` 只有主键和 `(repo,issue,status,created_at)` 普通索引（`apps/server/src/db/schema.ts:726-730`），迁移里也没有（`migrations/0006_agent.sql`、`0011_v21.sql`）。dispatcher 文件头自己承认这个窗口：「两个 dispatcher 真同时进 `claimOldest` 时仍可能各领到同一 issue 的不同消息……要彻底消灭需要一条部分唯一索引，见 S1 报告的『没做完』一节」（`dispatcher.ts:20-23`）。
7. 「多实例部署会怎样」→ 每个实例各跑一份 pg-boss cron（`definitions.ts:226-240`），concurrency 是每实例计数，也没有 advisory lock / 数据库唯一约束 → N 个实例 = N 个可并发领件的 dispatcher。
8. 「跨 issue 能否并行」→ 能，串行键是 `(repo, issue_number)`；测试断言两个 issue 同时 running（`agent-serial-queue.test.ts:212-219`）。

### 证据

- `apps/server/src/agent/store.ts:106-139`（串行两道闸）、`apps/server/src/agent/store.ts:143-145`
- `apps/server/src/queue/definitions.ts:146-159`（concurrency=1）、`definitions.ts:342-344`
- `apps/server/src/agent/dispatcher.ts:85-153`（领一条 + 建任务）、`192-207`（跑完立刻取下一条）
- 绕过闸的入口：`apps/server/src/app/compose.ts:978`、`apps/server/src/http/webhook-v21.ts:1047-1053`、`apps/server/src/http/webhook.ts:1625-1631`
- 无部分唯一索引：`apps/server/src/db/schema.ts:726-730`、`migrations/0006_agent.sql`、`migrations/0011_v21.sql`
- 测试：`apps/server/test/agent-serial-queue.test.ts:178-220`（3 条全入队 + runs 时间区间不重叠 + 跨 issue 并行）

### 缺口

1. **串行不是硬保证**：webhook 的即时 dispatch 绕过 `concurrency: 1`；`NOT EXISTS` 是快照判定；缺 `(repo, issue_number) WHERE status='running'` 部分唯一索引（`schema.ts:726-730`）。两个几乎同时到达的同 issue 事件仍可能并行跑，正是需求 §5.3 点名的「硬约束」场景（需求 883 行「并发写同一会话会导致上下文交错」）。
2. **多实例失效**：所有串行保护都是「单进程 + 单语句快照」，跨进程没有任何数据库级互斥（无 advisory lock、无唯一索引）。
3. 顺序的 tie-break 是 `fingerprint`（随机哈希），同一 `created_at` 的到达顺序不被保证（`store.ts:130`）。

---

## FR-3.4 会话常驻、无结束状态、issue 关闭只回收沙箱

**状态：部分实现**

### 反证过程（试过的推翻检查点）

1. 「session 状态枚举是否超过两个值」→ 推翻失败（正面）。`SESSION_STATES = ['active','idle']`（`apps/server/src/agent/session-state.ts:19`）；`AGENT_SESSION_STATE` 也只有两个键（`apps/server/src/db/schema.ts:688-694`）；迁移只加列不给 CHECK（`migrations/0011_v21.sql:22`）。测试显式断言「不含 `ended` / `archived`」（`apps/server/test/agent-session-state.test.ts:33-51`）。
2. 「是否存在会话 关闭/归档/cleanup 路径（jobs/、sandbox/、retention）」→ 大部分推翻失败（正面）。全仓 `delete from` 只有三处：`run_events`、`webhook_deliveries`、`metrics_daily`（`apps/server/src/jobs/retention-cleanup.ts:55,74`、`jobs/metrics-rollup.ts:156`），**没有一处碰 `agent_sessions` / `agent_messages`**；`jobs/lifecycle-sweep.ts` 只动 tasks/runs/run_events 与容器/worktree。会话表相关 SQL 只有 INSERT/UPDATE（`webhook-v21.ts:786-802` 注释「永远不 DELETE」、`compose.ts:276-293`）。
3. 「issue 关闭只回收沙箱吗、重开复用吗」→ 纯函数与 SQL 层都成立：`issues.closed` + 实时 closed → `recycle-sandbox`（`state='idle'`、`sandbox_id=NULL`、`closed_at=now()`，行保留）；`issues.opened` → `reuse`（`state='active'`、`closed_at=NULL`）；关闭事件但实时仍 open 时不砸沙箱（`session-state.ts:122-142`、`webhook-v21.ts:796-801`）。矩阵测试覆盖 `session × issueState × event` 全组合并断言「`archiveSessionId` 恒 null、`deleteSession` 恒 false」（`test/agent-session-state.test.ts:186-230`）。
4. 「会话真的从不被归档、不重建吗」→ **推翻成功**。`planAgentSession()` 在 `turns >= 30` 或存活 `> 7 天` 时返回 `rotate: true` + `archiveSessionId`，本轮**新建**会话（`apps/server/src/app/compose.ts:450-463`）；`compose.ts:1315-1338` 真的调 `sessionArchive`。注释「v2.1 会话状态机生效时不 archive」依赖的 `v21SessionEventActive` 在真实队列路径恒 false（见 FR-3.2 缺口 2）。所以说「会话没有结束状态、不归档」在**数据行层面**成立，在**会话实例层面**不成立：7 天后必被归档重建一次。
5. 「状态列能不能出现第三个值」→ 类型层能挡住，数据库层挡不住：`state` 是无约束 `text`（`migrations/0011_v21.sql:22`），脏值（如遗留 `ended`）会被 `v21SessionRowOf` **静默归一成 idle**（`webhook-v21.ts:817`、`compose.ts:373`），既不报错也不留痕。
6. 「active = 沙箱存在 是否真的成立」→ **不成立（名义值）**。权威写入点 `applyV21SessionOnEvent` 从不传 `sandboxId`（`webhook.ts:1212-1217` → `webhook-v21.ts:846-848`），`create` 写 `sandbox_id=NULL` 而 `state='active'`；装配层注释直接写「本仓库的容器是 runTask 每轮创建、结束即销毁的临时沙箱，并没有常驻的 per-session 沙箱可拉起」（`compose.ts:386-388`）。后果是 `planSessionOnEvent` 的 ⑤ 分支每次都 `sandboxId===null → rebuildSandbox=true`（`session-state.ts:155-163`），而实际什么也没重建；「关闭时回收沙箱」也谈不到回收（本来每轮就销毁）。

### 证据

- 两态枚举：`apps/server/src/agent/session-state.ts:19-21`、`apps/server/src/db/schema.ts:688-694`、`migrations/0011_v21.sql:22-26`
- 动作集不含 end/archive/delete：`apps/server/src/agent/session-state.ts:64-71`
- 只 INSERT/UPDATE：`apps/server/src/http/webhook-v21.ts:786-802`、`apps/server/src/app/compose.ts:280-293`、`apps/server/src/app/compose.ts:1187-1225`
- 无常驻沙箱：`apps/server/src/app/compose.ts:380-388`、`webhook.ts:1210-1222`（不传 sandboxId）
- 无定时清理碰会话：`apps/server/src/jobs/retention-cleanup.ts:1-19,73-95`、`jobs/lifecycle-sweep.ts`
- 测试：`apps/server/test/agent-session-state.test.ts:33-51,82-147,186-230`、`apps/server/test/v21-worker-integration.test.ts:48`（`SESSION_ACTIONS` 断言）

### 缺口

1. **轮换 = 归档 + 重建会话**，与「创建后一直有效，不归档」「重开时直接复用原会话、不需要重建」直接冲突（`compose.ts:450-463`、`1315-1338`）。且 v2.1 守卫是死代码（见 FR-3.2）。
2. **状态列无数据库约束**，脏值被静默归一到 idle（`migrations/0011_v21.sql:22`、`webhook-v21.ts:805-822`）。
3. **active/idle 与真实资源解耦**：`sandbox_id` 永不写入，`state` 是名义值，「沙箱随 issue 关闭回收」在实现上无对应动作（`compose.ts:386-388`）。需求允许「空闲=沙箱已回收，下次触发重建」，但本实现是「根本没有会话级沙箱」，属于语义降级而非违规，可以在文档里说明，但当前代码注释一边说「沙箱随 issue 关闭回收」一边说「每轮创建销毁」，两处口径不一致。

---

## FR-3.5 幂等：三层去重

**状态：部分实现（含口径偏离）**

### 反证过程（试过的推翻检查点）

1. 「三层是否都在」→ 推翻失败（正面）。
   - 投递级：`webhook_deliveries.delivery_id` 主键（`apps/server/src/db/schema.ts:88-92`）。
   - 事件级：`eventFingerprint(repo, issue, 'event', templateId, issue.updated_at)`（`apps/server/src/agent/fingerprint.ts:36-49`），v2.1 非评论事件用它（`webhook-v21.ts:916-921`）。
   - 内容级：`commentFingerprint(repo, issue, 'comment', normalize(text))`（`fingerprint.ts:51-65`），v2.1 评论走它（`webhook-v21.ts:903-914`）。这层是本次工作区新加的（`git diff` 显示 `commentFingerprint` 为新增未提交代码），修的是「v2.1 曾用事件级键给评论算 fingerprint，同一秒两条不同评论互相顶掉」的缺陷（回归测试见 `test/v21-webhook-integration.test.ts:338-361`）。
2. 「作用域是否只看 issue 内」→ 推翻失败（正面）。三条键都含 `repo + issue_number`，没有跨 issue 判重（`fingerprint.ts:32,42-48,64`）。
3. 「是否与作者无关」→ 推翻失败（正面）。fingerprint 输入里没有 actor（同上）。
4. 「规范化口径是否超出需求」→ **推翻成功（越界）**。需求口径是「去首尾空白、合并连续空行」，并明确「不做语义近似判断——措辞不同就是不同内容」「宁可多处理一次，也不能把新问题误判成旧问题」（需求 915 行）。实现 `normalizeForIdempotency()` 做的是：
   - 先用 `maskCodeRegions()` 把 ``` 代码块与行内代码**整体抹成等长空白**（`apps/server/src/agent/canonical-text.ts:34`、`packages/contract/src/trigger.ts:109-113`）→ **只改了代码块的同一句话落到同一 fingerprint**（`canonical-text.ts:26-28` 注释把这当刻意设计）；
   - 再删掉所有 `@handle`（`canonical-text.ts:15,35`）；
   - 再删掉 Unicode `P*`（标点）与 `S*`（符号、emoji）（`canonical-text.ts:18,35`）；
   - 再把**所有**空白（含换行）压成一个空格（`canonical-text.ts:21,35`）——需求只要求「合并连续空行」，这里连单换行与空行结构一起丢了。
   等价后果：`修复 bug！` 与 `修复 bug？` 判成同一条；`a-b` 与 `a b` 判成同一条；同一段话只改了代码块判成同一条。测试把这套口径**当特性钉死**：`test/v21-webhook-integration.test.ts:355-360`（`'@pi-bot 打个标签'` 与 `'@pi-bot   打个标签！'` 必须同键）、`test/agent-serial-queue.test.ts:163-168`（L-02「归一化等价（多空格 / 标点）」）。没有一条测试断言「只差标点 = 不同内容」。
   （唯一符合需求的一点：不转小写，`canonical-text.ts:8`。）
5. 「上次失败是否真的放行」→ **推翻成功：未实现**。命中判定只看数据库唯一键，不看既有行状态：`insertMessage` 是 `ON CONFLICT (repo, issue, fingerprint) DO NOTHING RETURNING created_at`（`apps/server/src/agent/store.ts:95-98,225-238`），调用方拿到 `inserted=false` 就一律返回 `duplicate`（`webhook-v21.ts:1038-1044`、`webhook.ts:1606-1622`），`saved.row.status` 从未被读。也就是说：上一轮超时/崩溃/未产出（`agent_messages.status='failed'`），把**同一段话**再贴一次 → 直接 `duplicate`，永远不放行。第二道锁：`tasks.idempotency_key` 唯一索引（`store.ts:147-150`），即使消息层放行，任务层也会命中。全仓没有任何 `status='failed' → 允许重新插入/重置为 queued` 的路径（`markMessage` 只会写状态，`store.ts:279-291`）。也没有任何测试覆盖这个场景（`rg "上次失败|失败放行" apps/server/test` 无命中）。
6. 「跳过是否留痕（后台可查）」→ **推翻成功：只写日志**。判定为重复时只有：`logger.info(... 'v2.1 消息幂等命中：不重复投递')`（`webhook-v21.ts:1042`）、`logger.info(... 'agent 消息幂等命中：不建任务、不调模型')`（`webhook.ts:1608-1611`），以及 HTTP 响应体的 `duplicate: true`（`webhook-v21.ts:1043`）。**数据库里没有一条「因重复内容跳过」的记录**。契约层其实留了口子：`SkippedReason` 含 `'content-duplicate'`（`apps/server/src/trigger/decide.ts:40`），`decideEvent` 支持 `contentDuplicate: true → skip('content-duplicate')`（`decide.ts:246-248`），`webhook_deliveries` 也有 `decision_reason` 列并列入该值（`db/schema.ts:107-118`）——但生产代码**从不传 `contentDuplicate`**：`decideV21Delivery` 的两个调用点（`webhook.ts:1195-1201`、`1258-1259`）都没传，`rg "contentDuplicate"` 除定义/转发/单测外无生产赋值。判定又发生在落库去重**之前**，所以去重命中时投递行已经写成 `decision='triggered'`（`webhook.ts:1005-1017`、`webhook-v21.ts:987-993`），面板看到的仍是「触发」，只是没有任务。
   另外，重复跳过也不会写 `webhook_deliveries` 之外的任何审计表（`actions` / `run_events` 都是任务侧产物）。
7. 「三层会不会互相替代/漏层」→ 评论正文为空时回落到事件级键（`webhook-v21.ts:900-921`），同一秒的两条空正文评论仍会互相顶掉——边缘情况，注释里已自认。

### 证据

- 三层键：`apps/server/src/db/schema.ts:88-92`、`apps/server/src/agent/fingerprint.ts:36-65`、`apps/server/src/http/webhook-v21.ts:890-922`
- 越界规范化：`apps/server/src/agent/canonical-text.ts:15-36`、`packages/contract/src/trigger.ts:109-113`
- 失败不放行：`apps/server/src/agent/store.ts:95-98`、`apps/server/src/http/webhook-v21.ts:1029-1044`、`apps/server/src/http/webhook.ts:1595-1622`、`apps/server/src/agent/store.ts:147-150`
- 跳过只写日志：`apps/server/src/http/webhook-v21.ts:1038-1044`、`apps/server/src/http/webhook.ts:1606-1612`
- `content-duplicate` 是死分支：`apps/server/src/trigger/decide.ts:40,246-248`、`apps/server/src/http/webhook-v21.ts:110-177`（转发参数）、`apps/server/src/http/webhook.ts:1195,1258`（调用点不传）
- 测试：`apps/server/test/v21-webhook-integration.test.ts:338-361`、`apps/server/test/agent-serial-queue.test.ts:144-176`、`apps/server/test/agent-message.test.ts:71-97`、`apps/server/test/trigger-decide.test.ts:373-401`（只测纯函数）

### 缺口

1. **规范化越界（与需求正面冲突）**：抹掉代码区、删标点/符号、压掉换行，都会把「新问题」判成「旧问题」——需求 915 行明确禁止（「宁可多处理一次」）。现有测试反而把这套口径固化。`apps/server/src/agent/canonical-text.ts:26-36`。
2. **「上次失败不参与去重」完全没实现**：只按唯一键判重，`status='failed'` 的内容被永久锁死（`store.ts:95-98` + `webhook-v21.ts:1038-1044`）。这是需求点名的「一次故障会把这个内容永久锁死」事故场景。
3. **「跳过要留痕」不达标**：只有进程日志 + HTTP 响应，库里查不到；`content-duplicate` 这条已经准备好的留痕通道无人使用（`decide.ts:246-248` 无生产调用者）。
4. 空正文评论回落到事件级键（`webhook-v21.ts:900-921`），同秒多条空评论会互顶。
5. 三层之外没有「人工重试」通道去解锁失败内容（`tasks.idempotency_key` 唯一索引同样会命中）。

---

## 本节整体结论

§5.3 会话协调的**骨架是做了的，且大部分正面约束有代码 + 测试**：一对一映射（`agent_sessions` PK）、创建/复用判定（纯函数 + 真库集成测试）、只 INSERT/UPDATE 的会话写入、两态枚举、无任何定时作业删会话、消息表即队列且不丢事件、`agent-dispatch` 并发 1、评论内容级 fingerprint 与作者无关且不跨 issue——这些都是无争议的实现，不是文档承诺。

但有四处**硬伤**，属于「需求明确禁止、代码实际在违反」：

1. **FR-3.4 / FR-3.2：会话会被归档重建。** `planAgentSession()` 在 30 轮或 7 天时轮换，`compose.ts:1315-1338` 真的发 `session/archive` 并新建会话；拦住它的 v2.1 守卫因为 `executeTask({sessionEvent})` 全仓无调用者而恒不生效。需求写的是「没有『结束』这个状态」「不归档」「重开时直接复用原会话」，实现是「7 天后强制断一次上下文」。这条路径没有任何测试。
2. **FR-3.5：上次失败不放行。** 去重只看主键冲突，不看既有行 `status`，失败内容的同一段话再贴 = `duplicate`，永久锁死——正是需求 917 行要防的事故。
3. **FR-3.5：内容级规范化越界。** 抹代码区 + 删标点符号 + 压换行，把「措辞不同就是不同内容」变成了「去掉标点代码空白就算同一内容」，与「不能把新问题误判成旧问题」正面冲突，且被测试固化。
4. **FR-3.3：串行不是硬保证。** webhook 即时 dispatch 绕过 `concurrency: 1`，`NOT EXISTS (running)` 是快照判定，缺 `(repo, issue_number) WHERE status='running'` 部分唯一索引，多实例下所有保护都失效。dispatcher 文件头自己承认这是「已知窗口」，但需求把并发写同一会话定性为「硬约束而非优化项」。

次要问题：跳过留痕只在日志里（`content-duplicate` 分支无人调用）、`state` 列无数据库约束且脏值被静默归一到 idle、`active/idle` 与真实沙箱完全解耦、映射键缺 `target_kind` 使 PR/issue 隔离只靠「PR 不进门」、按到达顺序消费的 tie-break 是哈希。

判断：§5.3 的**数据模型与状态机**可信；**「会话永不结束」和「失败必须放行」这两条 P0 语义没有真正兑现**；FR-3.5 的规范化口径需要按需求收窄（或修改需求正文承认这套更激进的去重）。
