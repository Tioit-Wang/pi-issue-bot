# P0-2 独立审查

## 结论

**有条件通过** —— 第 1 处（`insertMessage` 只对 `failed` 行 `DO UPDATE`）正确、必要且**充分**；第 2 处（`insertTask` 重置任务）**越界**：实现者给出的「否则整个 issue 队列卡死」论证经实测不成立，而这次重置本身引入了排队闸门（每分钟）与 `ended_at` 的新问题。建议保留改动 1、回退改动 2，或补齐后再上。

## 逐条核查

### 1 第 2 处改动是否越界

- **结论：越界。「队列卡死」论证不成立。** 只做改动 1 时，重投的重试链路本来就是通的。
- **调用链验证**（`apps/server/src/agent/dispatcher.ts:85-153`、`agent/store.ts:336-372`）：
  1. `insertMessage` 把 `failed` 消息重置成 `queued` → `inserted=true` → webhook 不判 duplicate，继续 `dispatchAgent`（`http/webhook.ts:1606`、`http/webhook-v21.ts:1038` 都是 `if (!saved.inserted)`）。
  2. `dispatchNextForIssue` → `claimNextForIssue` 把消息置 `running` → `insertAgentTask`。
  3. **关键**：旧实现 `INSERT … ON CONFLICT DO NOTHING RETURNING id` 冲突时 `rowCount = 0`（我实测，见下 §A），于是 `if (rowCount > 0) return {taskId: input.taskId}` 不成立，落到 `findTaskIdByKey(db, idempotencyKey)` → **返回上一轮那条失败任务的 id（非 null）**。
  4. `dispatcher.ts:108-116`：`taskId !== null` → 照常 `deps.enqueue({ taskId: 旧id, … })` → `queue.send` 的 `singletonKey` 是**消息粒度**（`app/compose.ts:877-886`：`agent:<repo>#<n>:<fingerprint>`，不是 taskId），上一轮的 job 已结束，`send` 成功。
  5. `run-task` 按 `taskId` 直接 `markTask(running)`（`worker/run-task.ts:665`），**不检查 `tasks.status`**，也确实不 `loadTask`，所以重跑一条 `status='failed'` 的旧行没有问题。
  6. 收尾 `compose.ts:1024-1062` → `finishMessageAndContinue` 把消息写回 `done`/`failed`，并取下一条。

  也就是说：**旧代码返回值本来就不是 `null`**，dispatcher 从来不会「以为投过了不投递」。报告 §2.4 的探针（步骤 6/7）只是证明「消息被领成 `running` 后停在那里」——那正是等 `run-task` 收尾的正常中间态，而探针里的 `enqueue` 是替身（返回 null/不动队列），所以「之后无人再动它」是探针本身的假象，不能作为卡死证据。
- 所以第 2 处不是「必要修复」，而是把「重跑同一 task 行」从**隐式**（靠 `findTaskIdByKey` 回填）改成**显式**（同时把行状态改回 `queued`），额外改了 `tasks` 的终态语义，超出 P0-2 的授权范围。

### 2 `WHERE` 子句的正确性

- `insertMessage`：`WHERE "agent_messages"."status" = 'failed'` —— **正确**。`failed` 之外 `queued`/`running`/`done` 都不重置，与 `:915`「同一 issue 内同一内容只处理一次」一致；实测 `queued` 行再投 `rowCount = 0`（§B2）。
- `insertTask`：`WHERE "tasks"."status" IN ('failed','timed-out')` —— `timed-out` 是**合法值**（`db/schema.ts:44` `timedOut: 'timed-out'`，居中还有 `running/succeeded/failed/cancelled_queue/cancelled`），不是编造。但**枚举不全**：`TASK_STATUS` 还有 `cancelled`、`cancelled_queue` 两个终态（`db/schema.ts:46-48`），需求「超时、**崩溃**或**未产出**」里的「未产出」包含排队闸门取消（`cancelled_queue`）与停机/人工取消（`cancelled`）。这类任务不会被重置，任务行永远停在取消态（消息侧仍会靠 `findTaskIdByKey` 回填被重投一次，行为与 `failed` 不一致）。
- 注意 `tasks.status` 是 `text`（`db/schema.ts:239`），库里没有 CHECK 约束，取值合法性只靠 `TASK_STATUS` 常量；本次 SQL 里的字符串是手写的 `'failed'`/`'timed-out'`，没引用常量（不是缺陷，但两处口径容易漂移）。

### 3 AGENTS §7.4 红线（`command` / `actor_login` / `queued_at` 入队写死）

- **未触碰**。diff 里两条 `DO UPDATE` 的 `SET` 都只有 `"status"` 与 `"updated_at"`；`queued_at = now()` 只在 `VALUES`（新插入路径）里。实测重投后 `queued_at` 与原来相等（报告用例 `agent-serial-queue.test.ts:385` 也断言了这一点）。
- 但见 §1 的连带后果：正因为 `queued_at` 不改，重置成 `queued` 的行携带的是**上一轮**的时间戳（见问题 1）。

### 4 并发安全

- **推理正确**。PostgreSQL 的 `ON CONFLICT DO UPDATE … WHERE`：先对冲突行加行锁，锁定后按**最新版本**重新计算 `WHERE`（EvalPlanQual 语义），`WHERE` 不成立则该行既不更新也不 `RETURNING`。
- **实测**（§C）：同一条 `failed` 消息两路并发重投 → `rowCount = 1 / 0`，只有一条放行。不依赖内存去重，符合 AGENTS §9.4。

### 5 `RETURNING` 语义（最关键验证点）

- **实现者的注释与判定都对**。实测（§B、§B2）：
  - `DO UPDATE` 命中 `failed` 行 → `rowCount = 1`，`RETURNING created_at` / `RETURNING id` 都**出行**（`id = probe-task-1`）；
  - `WHERE` 不成立（`succeeded` / `queued` 行）→ `rowCount = 0`、`rows = []`。
  
  所以 `inserted = (rowCount ?? rows.length) > 0`（`store.ts:264-265`）在语义上正确：`DO UPDATE` 命中会出行，`inserted` **不会**被误判成 false。
- `insertAgentTask` 改成回填 `RETURNING id`（`store.ts:365-369`）：新插入返回 `input.taskId`（等价），命中可重跑旧行返回旧 id（与旧实现 `findTaskIdByKey` 的结果**相同**，见 §1 —— 这也再次说明第 2 处改动不改变返回值，只改变行状态）。
- 一处小冗余不是缺陷：`typeof returnedId === 'string'` 失败时仍会 `findTaskIdByKey`，与旧代码同路径。

### 6 是否与 `decideRetry()` 冲突

- **不冲突（有语义偏差，可接受）**。`decideRetry()` 决定的是「一次 run 失败后同一任务是否再跑」；`run-task` 的 `retryLimit` 仍是 0（`queue/definitions.ts` 未动），`decideRetry` 的分支逻辑未改。本处是「同一内容被再投一次 = 用户/事件产生的新一轮执行」，与 `/retry` 投同一 task 行的既有语义一致。
- 偏差在于：任何 `failed` 都会重跑，不看 `failure_class`。`decideRetry` 对 `quota` / `permission` 这类永久失败本会拒绝重试，这里会在「同内容再来」时照跑。因为触发条件是用户主动重发，成本可接受，但**不能**把重跑当成 `decideRetry` 的替代。

### 7 测试

- 相关文件：`apps/server/test/agent-serial-queue.test.ts`（新增 5 条，报告说 3 条 + 2 条任务面，实际是 3 + 2）。
- **我自己跑**：`npx vitest run test/agent-serial-queue.test.ts` → `Test Files 1 passed (1)` / `Tests 12 passed (12)`。
- **与报告不符**：报告 §3.2 / §4.1 说该文件「1 failed（L-02）」，我这一轮是 **12/12 全绿**（`canonical-text` 那侧的归一化已被并行的改动收拾过）。报告数据已过期，属于陈述不实（不严重，但不能按报告口径相信「唯一红项」的说法）。
- 用例质量：断言的是可观察事实（`inserted`、`status`、`queued_at` 未变、表内行数），符合 AGENTS §6.3。缺口：失败态用 `update tasks set status='failed'` / `markMessage(...,'failed')` 直接构造，没走真实的「超时 / 容器 OOM / 进程崩溃」链路；没有并发用例（我补了只读探针验证，见下）。

### 8 类型检查

- `cd apps/server; npx tsc --noEmit` → 退出码 0，无输出。
- 额外跑了 `npx eslint apps/server/src/agent/store.ts apps/server/test/agent-serial-queue.test.ts` → 退出码 0，无输出。

## 我实际执行的验证

```powershell
# 1) 目标用例
cd C:\Code\NodeProjects\pi-issue-bot\apps\server
npx vitest run test/agent-serial-queue.test.ts
# → Test Files 1 passed (1) | Tests 12 passed (12)   （报告说 1 failed，不符）

# 2) 相关回归（store.ts 影响面：webhook / e2e / 消息幂等）
npx vitest run test/agent-message.test.ts test/agent-serial-queue.test.ts `
  test/v21-webhook-integration.test.ts test/e2e-dry-run.test.ts
# → Test Files 4 passed (4) | Tests 55 passed (55)

# 3) 类型 + lint
npx tsc --noEmit                              # → EXIT=0
npx eslint src/agent/store.ts test/agent-serial-queue.test.ts   # → EXIT=0
```

```powershell
# 4) 真库只读探针（$env:PI_SCRATCH_DIR\p02-review-probe.mjs，只碰 pi_issue_bot_test，跑完 delete 自己插的行）
node "$env:PI_SCRATCH_DIR\p02-review-probe.mjs"
```

输出：

```
A) 旧实现 DO NOTHING 命中: rowCount = 0  rows = []
A) 旧实现随后 findTaskIdByKey 回填 = [{"id":"probe-task-1"}] → 非 null 时 dispatcher 会调用 enqueue
B) DO UPDATE 命中 failed 行: rowCount = 1  id = {"id":"probe-task-1"}
B) DO UPDATE 命中 succeeded 行: rowCount = 0  rows = []
B2) failed 行重置: rowCount = 1  rows = [{"created_at":"2026-11-14T07:42:24.479Z"}]
B2) queued 行再投: rowCount = 0 （0 = 判 duplicate，符合预期）
C) 并发重投 rowCount = 1 / 0 （1/0 = 只放行一条）
D) 重置后的任务被排队闸门扫到 = [{"id":"probe-gate","queued_at":"2026-11-11T07:42:24.523Z","waited":{"days":3,...}}]
D) 该任务行 = [{"id":"probe-gate","status":"queued","queued_at":"2026-11-11T07:42:24.523Z","ended_at":null}]
```

- A 否证「dispatcher 不投递导致卡死」的论证。
- B/B2/C 证实 `RETURNING` 与并发推理。
- D 证实「重置成 `queued` + 旧 `queued_at` = 立刻成为排队闸门的候选」。

## 发现的问题

| 严重度 | 问题 | 位置 | 建议 |
|---|---|---|---|
| 高 | 第 2 处改动越界：「否则整个 issue 队列卡死」论证不成立（旧代码 `DO NOTHING` 命中 `rowCount=0` → `findTaskIdByKey` 回填旧 id → dispatcher 本来就会 `enqueue`）。报告 §2.4 的探针只证明了「消息停在 running」这一正常中间态，`enqueue` 是替身，不能当卡死证据 | `apps/server/src/agent/store.ts:160-178`、`store.ts:365-369`、报告 §2.4 | 回退改动 2，只保留改动 1；或另立缺陷重新论证动机 |
| 高 | 改动 2 把任务行改回 `queued` 却保留旧的 `queued_at`（§7.4 不许改），而排队闸门按 `now() - queued_at > queue_wait_minutes` 判定（`queue/queue-gate.ts:43-49`，每分钟跑一次）→ 重试任务**必然**成为候选，被写成 `cancelled_queue` 并补 `ended_at`；`jobs/lifecycle-sweep.ts:41-71` 又把 `cancelled_queue` 当终态去销毁 `tasks.container_name`，可能销毁正在跑的重试容器。改动 1 不碰 `tasks`，没有这个副作用 | `apps/server/src/agent/store.ts:173-178`；`apps/server/src/queue/queue-gate.ts:43-49`；`apps/server/src/jobs/lifecycle-sweep.ts:43-71` | 回退改动 2；若确需「显式重跑」，必须同时解决排队计时（例如另起一行 / 用 `runs.started_at` 判定闸门 / 设计新的等待起点），这属于设计决策，需先改文案与需求口径 |
| 中 | 重置后 `ended_at` 未清空：`status='queued'` 却带着上一轮失败时刻，`queries/tasks.ts:126-127` 的 `durationMs = ended_at - started_at`、`lifecycle-sweep` 的 `coalesce(ended_at, updated_at)` 排序都会被这一行污染，面板会出现「排队中但已有结束时刻」 | `apps/server/src/agent/store.ts:175-177` | 若要保留改动 2，`SET` 里补 `"ended_at" = NULL`（不改 §7.4 三个字段） |
| 中 | `WHERE` 少了 `cancelled` / `cancelled_queue`：需求「超时、崩溃或**未产出**」包含排队闸门取消与停机取消，这两类任务不会被重置，任务行永久停在取消态，与 `failed`/`timed-out` 口径不一致 | `apps/server/src/agent/store.ts:177`；`apps/server/src/db/schema.ts:34-49` | 明确这两个状态的语义；要么纳入重跑判定，要么在注释里写明为什么排除 |
| 中 | 需求 917 里的「崩溃」只覆盖到「run-task 已经把消息写回 `failed`」。进程被杀 / OOM 时消息停在 `running`，`insertMessage` 的 `WHERE status='failed'` 不放行；而 `claimOldest` 的 `NOT EXISTS (running)`（`store.ts:148-152`）与 `queuedIssues` 会因这条 `running` 消息跳过整个 issue → **仍然永久卡死**，本次修复对这条路径无效 | `apps/server/src/agent/store.ts:107-156` | 单列缺陷：给 `running` 加「超时回收」（如 `updated_at` 超过命令级超时 → 置 `failed`），或说明由哪个作业兜底；报告的 §4.4 只写了「没跑 e2e」，低估了这条缺口 |
| 低 | 报告数据过期/不实：§3.2 与 §4.1 声称 `agent-serial-queue.test.ts` 有 1 条红（L-02），我实测 12/12 全绿；§4.2 说「队列重投靠 pg-boss 的 `singletonKey = taskId`」，实际是**消息粒度** key（`app/compose.ts:877-886`） | 报告 §3.2 / §4.1 / §4.2 | 交付前重跑并更新；`singletonKey` 口径改正 |
| 低 | 重跑后 `tasks.attempt` 不递增，`runs.attempt` 取 `tasks.attempt + 1`（`app/compose.ts:483`），于是同一条任务的两次 run `attempt` 都是 1，审计与面板无法区分第几次 | `apps/server/src/agent/store.ts:175-177`；`apps/server/src/app/compose.ts:483` | 报告 §4.2 已披露；若保留改动 2，建议同批递增 `attempt`（属 `runs` 口径变更，需单独立项） |

**其余判定为「正确、可放行」的项**：`insertMessage` 的 `WHERE status='failed'` 边界；`created_at` 不动（保留排队位置）；`RETURNING`/`inserted` 判定；并发只放行一条；§7.4 未越线（只写 `status`/`updated_at`）；`timed-out` 是合法枚举；类型与 lint 干净；新增用例断言的是可观察事实。
