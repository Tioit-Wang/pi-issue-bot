# U10 5.3 会话协调 · A

> 核查范围：docs/requirements.html 行 858-922
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| FR-3.1 一个 issue 只对应一个会话 | 部分实现 | 映射与复用路径成立，但轮换分支（30 轮 / 7 天）会给同一 issue **新建**第二个会话并归档旧的；另有三个模块各持一份会话 SQL |
| FR-3.2 多事件进入同一会话 | 部分实现 | attach + `turn/start` 是「追加一轮」，但同一处轮换分支把历史切断一次（每 30 轮 / 每 7 天） |
| FR-3.3 同 issue 串行、跨 issue 并行 | 已实现 | 队列语义落在 `agent_messages` + `FOR UPDATE SKIP LOCKED` + `NOT EXISTS(running)`，未丢弃、按 `created_at` 消费 |
| FR-3.4 会话常驻、沙箱随 issue 关闭回收 | 与需求冲突 | `compose.ts:1315` 在队列真实路径上**会** `sessionArchive()` 旧会话；且 `sandbox_id` 从未真实写入，回收只是记账 |
| FR-3.5 幂等三层去重 | 与需求冲突 | ④「上次失败不参与去重」反着来：`failed` 的同一内容仍判 duplicate；② 规范化远超「去首尾空白 + 合并连续空行」；⑤ 跳过只在日志里，库中无痕 |

## 逐条

### FR-3.1
- **状态**：部分实现
- **证据**：
  - `apps/server/src/db/schema.ts:658` — `agentSessions` 主键 `(repo, issue_number)`，`session_id` nullable（NULL = 还没开过会话）；一个 issue 一行，映射本身是 1:1 且是唯一落库位置。
  - `apps/server/src/app/compose.ts:442` — `const sessionId = input.session?.sessionId ?? null;`，`443-445`：没有 id → `{mode:'persistent'}`（首次新建）；`466-479`：有 id → `{mode:'persistent', sessionId, after: cursor}`（复用，不新建）。
  - `apps/server/src/app/compose.ts:1157` — 只有 `row.targetKind === 'issue'` 才读会话行；`1029-1053` 只有 agent 计划存在时才写会话字段 ⇒ PR 任务不读不写 `agent_sessions`，与 issue 不共享上下文（满足「PR 与 issue 各自独立会话」）。
  - `apps/server/src/app/compose.ts:456` — `(input.session?.turns ?? 0) >= maxTurns ? 'turns' : ageMs >= maxAgeDays*86400000 ? 'age' : null`，命中即 `{session:{mode:'persistent'}, rotate:true, archiveSessionId: sessionId}`（`456-463`）；阈值常量在 `compose.ts:209-212`（`maxTurns:30`, `maxAgeDays:7`）。
  - `apps/server/src/app/compose.ts:1039` — 轮换轮把库里 `session_id` 换成**本轮新建**的 id。
- **缺口**：
  1. 「后续触发复用，不新建」在轮换时被违反：`turns>=30` 或存活 >7 天时同一 issue 会拿到第二个会话 id，旧 id 进 `sessionArchive()`（详见 FR-3.4）。映射仍是「一行一 id」，但「一个 issue 只对应一个会话」在时间维度上不成立。
  2. 「唯一权威来源」不严格：会话 SQL 存在三份（`agent/store.ts:152-163`、`app/compose.ts:280-293`、`http/webhook-v21.ts:786-802`），写入面也分离（webhook 侧写 `state/sandbox_id`，compose 侧写 `session_id/cursor/turns`）。
  3. `app/compose.ts:253-266` 用 `tasks.command` **推断**事件类型（`v21EventOfCommand`）来「交叉校验」，属需求明令禁止的「自行推断会话归属」；当前只写 `logger.debug`（`1182-1185`），无状态副作用，故记为瑕疵而非致命。
- **判定依据**：一对一映射、首次创建、后续复用、PR/issue 隔离四条子条件都能定位到实现路径；但轮换分支把「不新建」写反了，因此不能判「已实现」。

### FR-3.2
- **状态**：部分实现
- **证据**：
  - `apps/server/src/runtime/turn-driver.ts:359` — `persistent && plan.sessionId` 时 `attachSession(plan.sessionId)`；attach 成功即沿用原会话 id（`362`），未给 `after` 时用快照游标兜底（`364-369`）。
  - `apps/server/src/runtime/turn-driver.ts:395` — `eventsSubscribe({sessionId, after})`，`398-402` — `turnStart({sessionId, input:{messageId, text}})` ⇒ 同一会话上**追加**一轮而非重开。
  - `apps/server/src/app/compose.ts:1036-1053` — 本轮结束把 `turns`（轮换轮从 1 起）与 `cursor` 回写 `agent_sessions`；下一轮 `planAgentSession` 靠它们判断复用 / 轮换，`turn-driver` 靠 `after` 防重放。
  - `apps/server/test/agent-serial-queue.test.ts:223-247` — 断言两次 `@` 后 `session_id` 相同、`turns` 从 1 递增到 2（具体断言，非仅 200）。
- **缺口**：轮换时（`compose.ts:1315-1337`）先归档旧会话再新建，那一轮**不**建立在前一轮历史之上——与「每一轮都建立在前一轮的历史之上」直接矛盾，只是发生频率低（30 轮 / 7 天一次）。
- **判定依据**：主路径（attach + turn 追加 + 游标）齐全且有用例；轮换分支使该条不能无条件成立，故为部分实现。

### FR-3.3
- **状态**：已实现
- **证据**：
  - `apps/server/src/agent/store.ts:95-98` — 入队是 `INSERT … ON CONFLICT (repo, issue_number, fingerprint) DO NOTHING`，到达即落一行 `status='queued'`（不因前一轮在跑而丢弃；只有同指纹才算重复，属 FR-3.5 的事）。
  - `apps/server/src/agent/store.ts:106-115` — `queuedIssues` 用 `NOT EXISTS (… status='running')` 排除已有在跑的 issue，`ORDER BY MIN(created_at)` ⇒ 按到达顺序、一次只放一个 issue。
  - `apps/server/src/agent/store.ts:124-139` — `claimOldest`：一条 `UPDATE … WHERE (…) IN (SELECT … ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) AND NOT EXISTS (running)`，把「选中 + 置 running」放进同一语句，另一条闸是 `NOT EXISTS` 子查询。
  - `apps/server/src/agent/dispatcher.ts:161-184` — 一轮扫描每个 issue 只领一条；`192-207 finishMessageAndContinue` 在任务结束后**立刻**领该 issue 的下一条（串行的「立刻」）。
  - `apps/server/src/queue/definitions.ts:93-96` — `run-task` `concurrency: 3`（跨 issue 并行）；`152-155` — `agent-dispatch` `concurrency: 1`（把 repeat 窗口收到一次语句）。
  - `apps/server/src/queue/repo-concurrency.ts:14` — 仓库级并发默认 2，同仓不同 issue 仍可并行。
  - `apps/server/test/agent-serial-queue.test.ts:179-199` — 连发 3 条断言 `['running','queued','queued']`、任务只有 1 条、逐条跑完后 `turn/start` 共 3 次、消息状态全 `done`。
- **缺口**：（无实现缺口）残余风险：`dispatcher.ts:20-23` 自述两个 dispatcher 真并发时 `NOT EXISTS` 是快照判定，可能各领同一 issue 的不同消息；当前靠 `agent-dispatch` 单进程 `concurrency=1` 收住，多实例部署时该窗口未被库约束（缺部分唯一索引）堵死。
- **判定依据**：「到达即入队」「同一时刻只跑一轮」「按到达顺序消费」「跨 issue 并行」四条都能落到具体 SQL/常量，并有针对性断言；残余窗口是已知且在单实例部署下关闭的量级问题，不构成子条件缺失。

### FR-3.4
- **状态**：与需求冲突
- **证据（需求反着来的那一行）**：
  - `apps/server/src/app/compose.ts:1315` — `if (!v21SessionEventActive && agentSession.archiveSessionId !== null) { … await channel.ops.sessionArchive({ sessionId: agentSession.archiveSessionId }) }`（归档发生在 `1317`）。
  - `apps/server/src/app/compose.ts:1195-1196` — `v21SessionEventActive` 仅在 `input.sessionEvent !== undefined` 时为 `true`；而队列真实路径 `onTaskJob`（`compose.ts:1460-1464`）只传 `{taskId, attempt}`，从不传 `sessionEvent` ⇒ 生产路径上 `sessionEvent` 恒缺失，`archiveSessionId` 一旦非空（`turns>=30` / 存活 >7 天）就一定归档并发新会话。需求原文（requirements 行 887-890）：「会话**没有「结束」这个状态**……任何归档动作都会让重开的 issue 失去上下文」。
- **证据（做对的部分）**：
  - `apps/server/src/agent/session-state.ts:19` — `SESSION_STATES = ['active','idle']`（无 `ended`/`archived`）；`69` — `SESSION_ACTIONS = ['create','reuse','recycle-sandbox']`（无 delete/archive/end，靠类型强制）。
  - `apps/server/src/agent/session-state.ts:123-131` — `issues.closed` 且实时状态 closed → `recycle-sandbox`：`keepSession:true`、`rebuildSandbox:false`；`134-141` 重开 → `reuse` + 重建沙箱。
  - `apps/server/src/http/webhook.ts:1206-1217` — 权威写入点在 webhook（有真实 `X-GitHub-Event` + `issue.state`）；`apps/server/src/http/webhook-v21.ts:786-802` 只有 `INSERT`/`UPDATE`（`recycle` 置 `state='idle', sandbox_id=NULL, closed_at=now()`），**无 DELETE**。
  - `apps/server/src/db/schema.ts:676-680` — `state` 默认 `'idle'`、`sandbox_id` 可空、`closed_at` 注释明确「资源动作，不是数据动作」；`apps/server/src/jobs/retention-cleanup.ts:54,73` 只删 `run_events` / `webhook_deliveries`，**不删** `agent_sessions`（映射不会被保留期清掉）。
  - `apps/server/test/agent-session-state.test.ts:220-232` — 断言迁移动词里不存在 `deleteSession`/`archiveSession`/`ended`。
- **缺口**：
  1. 「不归档」在队列真实路径上被违反（`compose.ts:1315-1317`，触发条件 `compose.ts:450-463`）。
  2. 「issue 关闭只回收 agent 沙箱」只是记账：`sandbox_id` 在唯一权威写入点从不传值（`webhook.ts:1212-1217` 未传 `sandboxId`），`applyV21SessionTransition` 的 `createSandbox` 钩子在装配层也无人注入（`compose.ts:390-421` 的 `hooks` 默认空）；实际容器是「每轮创建、结束即销毁」（`sandbox/lifecycle.ts:144-180` 的 sweep 与 `compose.ts:386-388` 注释），所以并不存在「随 issue 关闭回收的常驻沙箱」。
  3. 「会话常驻」本仓只保证映射行不丢；会话实体在宿主侧，attach 失败即新建会话并落 `session-reset`（`runtime/turn-driver.ts:370-373`、`457-460`），上下文会断。
- **判定依据**：状态枚举、关闭只改资源列、行永不删除、重开复用四条主证据都在；但需求对「不归档」是明令禁止，而代码在真实执行路径上保留并会走到 `sessionArchive()`，属行为与需求相反，只能判冲突，并给出确切行号。

### FR-3.5
- **状态**：与需求冲突
- **证据（做对的部分）**：
  - 投递级：`apps/server/src/http/webhook.ts:1100-1121` — `insertDelivery` 撞 `webhook_deliveries.delivery_id` 唯一键 → `200 duplicate`（另含「上次验签失败、本次通过」的翻正分支 `1119-1120`）。
  - 内容级作用域与作者无关：`apps/server/src/agent/fingerprint.ts:59-65` — `digest([repo, issue_number, 'comment', 规范化正文])`，键里没有作者、且带 `issue_number`（不跨 issue）。
  - 内容级入口：`apps/server/src/http/webhook-v21.ts:903-922` — 带 `comment.id` 且正文非空用 `commentFingerprint`（内容级），否则回落 `eventFingerprint`（模板 + `issue.updated_at`）。
- **证据（反着来的那一行）**：
  - `apps/server/src/http/webhook-v21.ts:1038-1044` — `if (!saved.inserted) { … return v21Accepted(… 'duplicate', existing, true) }`：只看「行是否新插入」，**不看**已存在那行的 `status`；`insertMessage`（`agent/store.ts:95-98`）是 `ON CONFLICT DO NOTHING`，`failed` 行同样让插入返回 0 行 ⇒ 上一轮超时/崩溃/未产出后，同内容再来一次被判 `duplicate` 丢弃。旧路径同样：`apps/server/src/http/webhook.ts:1606-1621`。需求（requirements 行 917）：「上次失败不参与去重……否则一次故障会把这个内容永久锁死」。
  - 规范化尺度不符：`apps/server/src/agent/canonical-text.ts:30-36` — 先 `maskCodeRegions`，再 `.replace(AT_HANDLE,' ')`（去掉一切 `@handle`）、`.replace(/[\p{P}\p{S}]/gu,' ')`（去掉全部标点与符号）、`.replace(/\s+/gu,' ')`（所有空白含换行并成一个空格）、`.trim()`。需求（行 915）只允许「去首尾空白、合并连续空行」。测试把这种超范围归一化钉成了预期：`apps/server/test/agent-serial-queue.test.ts:163-168`（多空格 + 标点差异 → `duplicate`）。
  - 跳过留痕未落库：`apps/server/src/http/webhook-v21.ts:1042`、`apps/server/src/http/webhook.ts:1608-1611` 只有 `logger.info`；`decision_reason` 里虽定义了 `'content-duplicate'`（`apps/server/src/trigger/decide.ts:40,246-247`）与对应入参（`webhook-v21.ts:117,154`），但全仓**无任何调用方**传 `contentDuplicate: true`（只在 `test/trigger-decide.test.ts:373-401` 里出现），且 `decision_reason` 是在内容去重之前就写好的（`webhook.ts:1014-1017`）。因此「因重复内容跳过、后台可查」没有任何一条数据库记录。
- **缺口**：④ 失败参与去重（行为相反，逐行可核对）；② 规范化做了去 `@`、去标点/符号、压平所有换行、屏蔽代码区，超出需求允许的两步；⑤ 跳过只留日志与 HTTP 响应，库中无痕且 `content-duplicate` 是无生产者的死参数；另：事件级键用 `issue.updated_at` + 事件名（`fingerprint.ts:36-49`）而非「事件自身唯一标识」（如 `comment.id`），同秒两条不同事件可能互相顶掉（`fingerprint.ts:8-9` 注释自认）。
- **判定依据**：三层里投递级与内容级的骨架、作用域、作者无关都成立，但④是需求专门点名的行为且代码写反，⑤缺数据库痕迹，②超出允许的归一化范围，故不能判「部分实现」而是「与需求冲突」。

## 本节整体结论
5.3 的四条「结构」约束里，FR-3.3（串行/并行）是唯一能判已实现的：队列语义落在 `agent_messages` + `FOR UPDATE SKIP LOCKED`，并有针对 `['running','queued','queued']` 与 `turn/start` 次数的断言。FR-3.1/FR-3.2 主链路（一对一映射、attach 追加轮次）都在，但被同一处 30 轮/7 天「轮换」分支打断，且该分支在队列真实路径上会真调 `sessionArchive()`，于是 FR-3.4 的「不归档」被判与需求冲突。FR-3.5 三层骨架存在，但「上次失败不参与去重」写反、跳过未落库、规范化范围过大。因此本节**不能**判为已实现。

## 核查边界
- 是否执行了命令：仅执行只读命令（`git status --short`、`git log --oneline -3`、`Select-String` 定向检索与文件行数统计）。**未执行** `pnpm -r test` / `typecheck` / 迁移，所以测试只声明「存在且断言具体」，不声明「跑过且绿」；`agent-serial-queue.test.ts`、`v21-webhook-integration.test.ts` 依赖真 PG（`openTestDb`），本次未起库。
- 未覆盖的条目及原因：无（FR-3.1～FR-3.5 均已逐条取证）。需运行环境才能确认的部分：轮换分支在真实 RACP host 上的 `session/archive` 效果、会话实体在宿主侧是否被每日清理（`turn-driver.ts:356` 注释提到这层可能），本次只按代码路径判定。
- 发现的额外问题（不属本节范围但值得记录）：
  1. 会话 SQL 有三份拷贝：`agent/store.ts:152-163`、`app/compose.ts:280-293`、`http/webhook-v21.ts:786-802`，字段口径已开始分叉（前一份不含 `state/sandbox_id`），违反「规则被复制成第二处真相」。
  2. `planAgentSession()`（含轮换与 archive）在全仓测试里**零覆盖**：`Select-String` 在 `apps/server/test` 下找不到 `planAgentSession|AGENT_SESSION_POLICY`。
  3. `agent/session-state.ts:167 isSessionState` 导出后无调用方（死代码）；`agent_sessions.state` 是裸 `text`，无枚举/CHECK 约束，只有 `webhook-v21.ts:817` 的读侧强制归一到 `active|idle`。
  4. `trigger/decide.ts:40 content-duplicate` 与 `webhook-v21.ts:117 contentDuplicate` 无生产调用方（死参数），面板按 reason 聚合永远看不到这类跳过。
  5. `compose.ts:253-266 v21EventOfCommand` 用 `tasks.command` 猜事件类型（猜不中按 `issues.edited`），是「自行推断会话归属」的雏形，目前只进 debug 日志。
