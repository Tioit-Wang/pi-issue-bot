# U25 非功能需求 · A

> 核查范围：docs/requirements.html 行 1824-1841
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| NFR-1 规模 | 已实现 | 并发 2–4 落在项目级配置（`limits.concurrency_per_repo`，默认 2）+ 全局 3；队列/去重全部复用同一 PG，无额外中间件；无平台侧事件限流。「<100 事件/天」是容量假设，代码不设也不违背 |
| NFR-2 响应 | 已实现 | 应答路径只有落库 + 入队 + 一次 reaction，执行在 worker；应答体是 `status:'accepted'`。**无硬超时护栏**，只有 >2s 告警 |
| NFR-3 可靠 | 已实现 | 三层幂等全在 PG：投递主键 + `tasks.idempotency_key` 唯一索引 + pg-boss `singletonKey`；另有内容级 `agent_messages.fingerprint` |
| NFR-4 安全 | 已实现 | 验签强制（缺 secret 启动即失败、失败落审计）；容器 Env 无凭证、exec 通道不透传 env，模型 key 只给宿主 pi-host；源码扫描测试禁止 merge |
| NFR-5 可维护 | 已实现 | 开关/条件/模板/评论闸门/角色/提及词全在 `repos.settings`，面板 PUT 即生效；内置默认模板只有一个来源。「写回拒收清单」是硬编码（见额外问题，不属本节术语的「闸门」） |
| NFR-6 可追溯 | 已实现 | 对话（issue 轮次正文 + `run_events`）、工具（`toolCalls`）、用量（`envelopes.usage` + `usage_costs`）三线均有查询出口；用量需经「轮次 `taskId` → `/api/tasks/:id`」两跳 |

## 逐条

### NFR-1 规模
- **状态**：已实现
- **证据**：
  - `apps/server/src/queue/definitions.ts:91-160` — 七个队列的唯一事实源；`:93-100` `run-task` 并发 **3**（注释明确「2–4」区间与 8vCPU/16GB 取值理由）；`:342-344` `validateDefinitions()` 把「并发必须 1–4」变成可执行自检。
  - `apps/server/src/queue/repo-concurrency.ts:18` — `DEFAULT_CONCURRENCY_PER_REPO = 2`；`:30-43` `concurrencyPerRepoOf(settings)` 读 `settings.limits.concurrency_per_repo`，缺省/坏值回落 2，`:42` 夹到 1–8。
  - `apps/server/src/queue/boss.ts:201-221` — `registerTaskWorker()` 用 `localConcurrency: concurrency`（全局），`:218-219` 每个 job 先问 `repoLimitOf(gate, repo)` 再 `limiter.run(repo, limit, handler)`，即**按仓库限流**在同一进程内生效。
  - `apps/server/src/app/compose.ts:1511-1518` — 闸门注入真实实现：`limitFor` → `readRepoPolicy(pool, repo)` → `concurrencyPerRepoOf(policy.settings)`，说明配置真的被消费（不是死字段）。
  - `apps/server/src/app/compose.ts:1505` — worker 与 HTTP **同进程**（注释「同进程，§8.4 刻意不拆」），单机部署成立。
  - `apps/server/src/app/compose.ts:566-569` — 队列即 pg-boss 12，`connectionString: config.pgDsn`（与 `:749` 业务连接池同一个 DSN），`:569` 仅多一个 `applicationName`；`apps/server/src/queue/boss.ts:39-40` `new PgBoss({ connectionString })`。全仓 `redis|ioredis|kafka|rabbit|bullmq` 检索命中 **0**。
  - 无平台侧业务限流：`apps/server/src/http/server.ts:164,267` 只有 `bodyLimit`（请求体上限）；`apps/server/src/trigger/decide.ts:250-253` 的 `dailyQuotaExceeded` 是判定入参，但 `http/webhook.ts` 全文件**没有任何赋值处**（grep `dailyQuotaExceeded` 只命中类型与透传），即平台没有落地的日配额闸门；`github/executor.ts:384-395` 的 `dailyQuota` 只限制 `create_issue` 这一个写动作，不拦事件处理。
  - 测试（存在且断言具体）：`apps/server/test/queue-definitions.test.ts:92-95`（并发 1–4 且 `run-task` ≥2）、`apps/server/test/http-server.test.ts:250,267`（settings 默认 2、写入 4 后回读 4）、`apps/server/test/config-repo-config.test.ts:34,175`（默认 2）。
- **判定依据**：需求明写的四个可核子条件都有「配置 → 消费方 → 行为」的完整链路：并发区间由定义表 + 自检测试固定；「项目级配置」由 `repos.settings.limits.concurrency_per_repo` 逐任务读库生效；「不引入额外中间件」由 pg-boss 复用同一 PG + 全仓无 MQ/缓存依赖证实；「平台不设业务限流」由「无 rate-limit 插件 + 日配额输入无赋值点」证实。「<100 事件/天」是容量前提而非代码约束，代码里没有与之冲突的阈值。

### NFR-2 响应
- **状态**：已实现
- **证据**：
  - `apps/server/src/http/webhook.ts:1923-1946` — `POST /webhook` 路由体只有一段：取 `delivery`/`event` 头 → `await handleWebhook(...)` → `reply.status(result.status).send(result.body)`；无容器启动、无模型调用、无轮询等待。
  - `apps/server/src/http/webhook.ts:1402-1410` — 第 7 步只是 `await deps.enqueue({ taskId, command, repo })`（`createQueueEnqueuer` → pg-boss `send`，`:1841-1843`）；`:1412-1433` 第 8/9 步打一次 reaction 后立即 200，注释写明「★ 10 秒应答就在 handler 内（不经过队列）」。
  - `apps/server/src/http/webhook.ts:691-700` — 应答体 `{ status: 'accepted', deliveryId, taskId, duplicate, action, ackComment }`：只表达「已收到 / 已去重 / 已忽略 / 已暂停」，不含任何处理结果字段。
  - 异步执行成立：worker 在启动路径装配（`apps/server/src/app/compose.ts:1511-1519` 注册 `run-task` worker），与 HTTP 请求生命周期无关。
  - 观测：`apps/server/src/http/webhook.ts:1040-1047` 每次应答算 `elapsedMs`，≥2000ms 记 warn；`apps/server/src/http/metrics.ts:83-90,130` 有 `http_request_duration_seconds` 直方图（桶到 5s）。
  - 测试（存在且断言具体）：`apps/server/test/http-server.test.ts:374-390` 合法签名 → 200 且 body `{ status:'accepted', action:'enqueued', duplicate:false }`。
- **判定依据**：「处理异步」与「应答只表示已收到」两条由代码结构直接证明（handler 内无执行面，应答体是 accepted 信封）。「<10 秒」是性能目标，代码用「应答路径只做短事务 DB + 一次入队 + 一次 reaction」保证，且 2s 就有告警、有延迟直方图可核。
- **缺口**：（无。但需记录残余风险：应答路径上 `deps.ack.addEyesReaction`（`webhook.ts:1420-1425`）是一次 GitHub 网络调用，被 `try/catch` 包住却**没有超时**；GitHub 侧慢时会直接拉长应答时间，代码里没有 10s 硬护栏，只有事后 warn。）

### NFR-3 可靠
- **状态**：已实现
- **证据**：
  - 投递级（持久层）：`apps/server/src/http/webhook.ts:95-98` `INSERT INTO "webhook_deliveries" ... ON CONFLICT ("delivery_id") DO NOTHING RETURNING "delivery_id"`；`:1100-1121` 插入 0 行 → 读回原行 → 回 200 `action:'duplicate'` 且 `trace.skipDecision = true`（不覆写原判定）。持久层依据：`apps/server/src/db/schema.ts:92` `deliveryId: text('delivery_id').primaryKey()`；`migrations/0000_init.sql:161-168` `"delivery_id" text PRIMARY KEY NOT NULL`。
  - 任务级（持久层）：`apps/server/src/http/webhook.ts:116-119` 建任务用 `ON CONFLICT ("idempotency_key") DO NOTHING`；`apps/server/src/db/schema.ts:253` `uniqueIndex('tasks_idempotency_key_uidx')`；`migrations/0000_init.sql:187` 同索引落在 DDL 里。`apps/server/src/queue/idempotency.ts:64-73` 幂等键 = sha256(kind/repo/target/anchor/trigger_actor) 前 32 位，`http/webhook.ts:1371-1397` 命中时也给回执（eyes）并回 `duplicate`。
  - 队列级：`apps/server/src/queue/boss.ts:110-116` `singletonKey: taskId`（同任务在队列里只一份）；`webhook.ts:1404-1405` 拿到 `null` 即记「任务已在队列中」。
  - 消息级（持久层）：`apps/server/src/http/webhook.ts:1595-1622` agent 消息按 `agent_messages` 的 (repo, issue, fingerprint) 幂等插入，`saved.inserted === false` → 回 `duplicate` 且不投模型。
  - 无内存去重：`apps/server/src/queue/idempotency.ts:5` 注释与实际实现一致——去重结论来自唯一索引冲突（`inserted.rowCount === 0`），而 `repo-concurrency.ts` 里的 Map 只是并发槽位，不参与去重。
  - 测试（存在且断言具体）：`apps/server/test/e2e-idempotent.test.ts:1-9,44` 真 PG 上同一 delivery POST 20 次 → 1 行投递 + 1 个任务（并含「换 delivery 同事件」第二档）；`apps/server/test/v21-webhook-integration.test.ts:323-336` 重复投递回 `duplicate` 且不重写 decision；`apps/server/test/agent-serial-queue.test.ts:145` 同一句话第二次 @ → duplicate、任务不增。
- **判定依据**：需求两个子条件分别对应「唯一约束」与「冲突后不重复执行」；三处唯一索引都在 schema 与迁移 DDL 中，且触发去重的读/写路径都在 `webhook.ts` 里可追（`rowCount === 0` → duplicate），不依赖任何进程内表。测试同时覆盖「同 delivery 重放」与「不同 delivery 同事件」两种真实重投形态。

### NFR-4 安全
- **状态**：已实现
- **证据**：
  - **签名校验（强制，无宽容模式）**：`apps/server/src/http/webhook.ts:1064-1096` 缺 `x-hub-signature-256` → 401 且不入队；`:1072-1083` 验签抛错一律按失败；`:1084-1096` 失败仍落库（`signature_valid=false`）但 401。实现方 `:1826-1838` `createOctokitVerifier`（`webhooks.verify(rawBody, signature)`，空 secret 直接抛错）；装配 `apps/server/src/app/compose.ts:884`；secret 缺失启动即失败 `apps/server/src/config/env.ts:126-129`；原始字节解析 `webhook.ts:1914-1920`（`parseAs: 'buffer'`）。
  - **模型凭证不进执行环境**：`apps/server/src/sandbox/hostconfig.ts:164-170` 容器 `Env` 只有 `NODE_OPTIONS` / `HOME` / `CI` / `TERM` 四项（注释「**不含任何凭证**」）；`:99-134` HostConfig 整段无 Env 透传。exec 通道表达 `apps/server/src/sandbox/exec-plan.ts:53-54,88` 只组一个 `PI_CMD_ID` 标记；`apps/server/src/sandbox/exec-proxy.ts:21`「不透传 env」。模型 key 只进宿主侧 pi-host 子进程：`apps/server/src/app/model-env.ts:36-52` `hostModelEnv()` 白名单出 `PI_BOT_MODEL_API_KEY` 等，`apps/server/src/app/compose.ts:601` `extraEnv: hostModelEnv(config)`。
  - **仓库权限最小化 / 不授予合并权**：`apps/server/test/no-merge.test.ts:28-33` 定义四条禁止模式（`.merge(`、`pulls.merge`、`mergePullRequest`、`merge_pull_request`），`:65-84` 扫描 `apps/server/src`、`apps/panel/src`、`packages/contract|envelope|racp-client|shared` 六个源码树并断言 violations 为空；`:61-63` 还有「扫描到源码」防呆断言（防空转）。
  - 测试（存在且断言具体）：`apps/server/test/http-webhook.test.ts:197-221` 验签失败 → 401 且审计行 `signature_valid=false`；`:223-230` 缺签名头 → 401 且不写行；`apps/server/test/http-server.test.ts:392-412` 签名与 body 不匹配 → 401（同时证明 raw body 未被换成 JSON parser）；`apps/server/test/e2e-dry-run.test.ts:129-145` 真 HMAC 投递落 `signature_valid=true`。
- **判定依据**：三个子条件各自有「拒绝路径」的代码与断言——验签是缺头/不匹配/抛错三档都拒；凭证侧是容器 Env 与 exec env 两处都没有凭证入口，模型 key 只出现在 `hostModelEnv` → pi-host `extraEnv` 这条宿主链路；合并权是扫描测试覆盖全部源码树。
- **缺口**：（无。需说明边界：GitHub App 实际申请的权限清单在 GitHub 侧配置，代码只能保证「没有 merge 调用、写动作限于执行器白名单」，这一条属环境侧，见「核查边界」。）

### NFR-5 可维护
- **状态**：已实现
- **证据**：
  - **触发规则在配置层且被消费**：`apps/server/src/config/v21-settings.ts:105-116` `resolveEventTrigger(settings, event)` 读 `triggers.events[event].enabled/prompt/only_body_changed/labels`；消费方 `apps/server/src/trigger/decide.ts:225-235`（开关 → 附加条件）、`:255-258`（模板为空串/空白 = 用 `DEFAULT_EVENT_TEMPLATES[event]`）。
  - **模板在配置层**：`packages/contract/src/settings-v21.ts:81-93` `eventTriggerSchema.prompt`（`null` = 平台默认）、`:326-336` 五个事件的配置与缺省值、`:344` `V21_DEFAULT_EVENT_TRIGGERS`；契约 `:473` `DEFAULT_EVENT_TEMPLATES` 是唯一一份内置模板，`trigger/decide.ts:84` 只做再导出。
  - **评论闸门在配置层**：`apps/server/src/config/v21-settings.ts:132-144` `resolveCommentGates()` 读 `triggers.events['issue_comment.created'].gates`；消费方 `apps/server/src/trigger/decide.ts:173-201` 依次判 `ignore_bot` / `allow_closed` / `require_mention` / `require_role`；`:181-187` 提及关键词、`:188-198` 角色清单分别来自 `resolveCommentConfig(settings)`（`:159-175`，`comment.mentions` / `comment.roles`）。
  - **改配置不改代码、不用重启**：写入 `apps/server/src/http/api/index.ts:319-341` `PUT /api/repos/:owner/:name/settings`（body 即 settings，非法配置不落库并回 400）→ `apps/server/src/config/repo-config.ts:449-473` `updateRepoSettings()` 校验后 `REPO_SQL.updateSettings` 写库；读取在每个事件请求内发生（`apps/server/src/http/webhook.ts:1163-1164` `readRepoPolicy(deps.db, repo)`），所以下一个事件即生效。
  - 测试（存在且断言具体）：`apps/server/test/http-server.test.ts:240-267` 读默认 → PUT 改 `concurrency_per_repo/queue_wait_minutes` → 回读为新值；`apps/server/test/trigger-decide.test.ts` 覆盖开关/条件/闸门各分支；`apps/server/test/v21-settings.test.ts` 覆盖坏配置回落默认。
- **判定依据**：需求列的三类东西（触发规则、模板、闸门）都没有硬编码在执行路径里，而是 zod 校验过的 `repos.settings` jsonb，且有 HTTP 写面 + 每次请求读库两端的完整链路，满足「改配置不改代码」。术语口径按需求术语表（`docs/requirements.html:1965`「闸门＝评论事件特有的附加判断条件」）取评论四闸门，故成立。

### NFR-6 可追溯
- **状态**：已实现
- **证据**：
  - **对话线（落库 + 出口）**：人类正文源 `apps/server/src/queries/issues.ts:637-656`（`payload.comment.body` 优先，退回 `tasks.prompt_text`），机器人正文 `:715-739`（`envelopes.actions[intent=comment].body`）；原文落库 `apps/server/src/http/webhook.ts:95-98`（`webhook_deliveries.payload`）、`apps/server/src/worker/run-store.ts:49-65`（`envelopes`）；事件级明细 `run_events`（`apps/server/src/worker/run-task.ts:975-977` 只丢流式增量 `item.delta`，`item.completed` 等照落）。出口 `GET /api/issues/:owner/:name/:kind/:number`（`apps/server/src/http/api/index.ts:215-230`，查询 `queries/issues.ts:755 queryIssueSession`）。
  - **工具线**：`apps/server/src/queries/issues.ts:922-1003` 从 `run_events`（`item.started` / `tool.progress` / `item.completed`，只认 `itemType='tool'`）按 `toolCallId` 归并成 `toolCalls[]`（名称 + 入参摘要 + 结果 + ok），上限 50 见 `:57-60,72`；契约 `packages/contract/src/api.ts:957-959`。
  - **用量线**：写入 `apps/server/src/worker/run-task.ts:1589-1607`（从 pi-host turns 读真 token，按价目算 `costUsd`）→ `apps/server/src/worker/run-store.ts:89-95` `insert into usage_costs`；信封里也留一份 `envelopes.usage`（`run-store.ts:49-64`）。出口 `GET /api/tasks/:id`（`apps/server/src/http/api/index.ts:120-134`）返回 `runs` / `events` / `envelopes[]`（契约 `packages/contract/src/api.ts:363-376`），信封用量见 `:292-306` `envelopeRecordSchema.usage`；查询实现 `apps/server/src/queries/tasks.ts:335-352`（`usageOf`）、`:446-523`（`queryTaskDetail` 返回 `envelopes`）、`:145-148,174`（任务级 `costUsd` 汇总）；按仓库/命令/模型聚合走 `GET /api/costs`（`http/api/index.ts:136-144`，实现 `queries/costs.ts`）。
  - **三线入口可串起来**：issue 轮次带 `taskId`（契约 `packages/contract/src/api.ts:953-954`），点进去就是该任务的 `events`（对话/工具明细）与 `envelopes[].usage`，因此「任一 issue 的处理过程」可从一条 issue 会话回放到单轮事件 + 用量 + 动作。
  - 测试（存在且断言具体）：`apps/server/test/queries-issues.test.ts:209-253`（轮次 id 顺序、human/bot 正文字段）、`:289-313`（`toolCalls` 长度 50、第 1/2/50 条内容、正文流与 message 条目不混入）；`apps/server/test/queries-tasks.test.ts:160-170,230-242`（信封 `usage {inputTokens,outputTokens,costUsd}` 有断言）。
- **判定依据**：三线各自「有落库、有读取方、有 HTTP 出口」，且均能从 issue 会话一路追到任务详情，符合「任一 issue 的处理过程可回放」。用量线不是挂在轮次上，而是经 `taskId` 两跳到任务详情/成本页——这是入口深度上的差异，不是缺线。
- **缺口**：（无。需记录两条阅读限制：`run_events` 明细与 `webhook_deliveries.payload` 只保留 90 天（`queries/system.ts:38`、`jobs/retention-cleanup.ts`），超期后回放只剩聚合与 `usage_costs`；任务详情事件上限 500 条（契约 `api.ts:368`）。）

## 本节整体结论
六条非功能需求全部可判为「已实现」：规模与并发落在「定义表（全局 3）+ 项目级 `limits.concurrency_per_repo`（默认 2）」两层且由 pg-boss 复用同一 PG，无额外中间件，也无平台侧业务限流；webhook 应答路径只做落库/入队/回执，执行在 worker；去重三层全在数据库唯一约束上（含真 PG 的 20 次重投用例）；验签强制且失败留痕，容器 Env 与 exec 通道都没有凭证入口，模型 key 只在宿主 pi-host，merge 能力由扫描测试禁止；触发规则/模板/评论闸门全在 `repos.settings`，面板 PUT 即生效；对话/工具/用量三线均有落库与查询出口。
唯一需要向读者点明的是「<10 秒」与「<100 事件/天」是目标值而非代码里的硬阈值：前者只有 2s 告警与延迟直方图，且应答路径上的 reaction 调用没有超时；后者的量化前提无法静态验证。
因此本节可判为整体「已实现」，无需降级为部分实现。

## 核查边界
- 是否执行了命令：**未执行测试/构建命令**（未跑 `pnpm -r test` / `pnpm -r typecheck` / `pnpm lint`），因此本报告中「测试」一律只声明「存在且断言具体」，**不声明跑过、不声明为绿**。实际做的是纯静态核查 + 只读检索（Read / Grep / `Select-String`）。
- 未覆盖的条目及原因：
  - NFR-1「<100 事件/天」「单组织、少量仓库」是容量与部署前提，无法用代码证实或证伪；只能确认代码没有与之冲突的阈值。
  - NFR-2「应答 < 10 秒」的实测需要真 GitHub + 真 PG 才能压出数字，本次未跑，只核了应答路径的构成。
  - NFR-4「仓库权限最小化」的权限清单在 GitHub App 设置里，代码侧只能证明「没有 merge 调用 + 写动作过执行器白名单（`writeback/v21/execute.ts`）」。
  - NFR-6「回放」的实机效果需要真库数据；本次核的是落库点与查询出口两侧代码。
- 发现的额外问题（不属本节范围但值得记录）：
  1. **写回拒收清单硬编码**：`apps/server/src/git/paths.ts:24-25,42` 的 `WRITEBACK_PROTECTED_PATTERNS` 由 `packages/envelope` 的 `PROTECTED_PATH_PATTERNS` 展开，属代码常量而非配置项。按需求术语表「闸门」只指评论四闸门，故不影响 NFR-5 判定；但若有人把「闸门」读成「写回闸门」，「闸门都在配置层」就不成立。
  2. **日配额是死配置**：`apps/server/src/config/v21-settings.ts:211` 暴露 `limits.daily_quota`，`apps/server/src/trigger/decide.ts:250-253` 有 `daily-quota` 分支，但 `http/webhook.ts` 从不给 `dailyQuotaExceeded` 赋值（全仓仅类型与透传），`resolveAgentExecution(...).daily_quota` 也无消费方——配置项写了不生效。方向与 NFR-1「平台不设业务限流」一致，但属「字段存在 ≠ 生效」。
  3. **`limits.concurrency`（agent 执行并发）同为零消费**：`config/v21-settings.ts:210` 透出该值，`worker/run-task.ts`、`http/webhook-v21.ts`、`app/compose.ts` 均未读它（真实并发只来自 `QUEUES` 与 `limits.concurrency_per_repo`）。
  4. **应答路径上的 reaction 没有超时**：`apps/server/src/http/webhook.ts:1420-1425`（及 `:1642-1647`）在应答前 `await` 一次 GitHub 写调用且无 AbortSignal/超时；GitHub 抖动时会直接吃 10s 预算。
  5. **流式正文不落库**：`apps/server/src/worker/run-task.ts:972-977` 刻意丢弃 `item.delta`，因此「完整对话」的粒度到 item（`item.completed`），不是逐 token；对 NFR-6 的三线齐全不构成缺口，但对「逐字回放」的期望要提前说明。
