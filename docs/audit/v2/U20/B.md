# U20 agent 系统提示词与执行限额 · B

> 核查范围：docs/requirements.html 行 1707-1739
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| SL-1 系统提示词 | 部分实现 | 系统提示词只在 `session/create`（新建会话）时带；`session/attach` 复用分支不传，持久会话的后续每次调用都没有它 |
| SL-2 并发数 | 部分实现 | 生效的是 legacy `limits.concurrency_per_repo`；§6.7 的 `agent.limits.concurrency` 无人消费，且等待超 `queue_wait_minutes` 会被取消（丢弃） |
| SL-3 日配额 | 未实现 | `quota_counters` 表零读写、`dailyQuotaExceeded` 生产代码从不置真、触顶原因无从产生、`decision_reason` 也无查询出口 |
| SL-4 单轮超时 | 部分实现 | 终止/记超时/不重试都在，但超时值来自硬编码常量（20/30min），项目级 `turn_timeout_minutes` 是死字段 |
| SL-5 不设平台级业务限流 | 已实现 | 未发现全局业务配额或全局业务并发闸；只有部署级 `run-task` 并发 3（§9 允许） |

## 逐条

### SL-1
- **状态**：部分实现
- **证据**：
  - 装配侧把项目级提示词裁决成一份值：`apps/server/src/app/compose.ts:1407` — `systemPrompt: resolveAgentExecution(policy.settings).system_prompt`
  - 裁决与内置默认回落：`apps/server/src/config/v21-settings.ts:204`-`209` — 两处配置都空则 `configured === '' ? AGENT_IDENTITY_PROMPT : configured`；内置默认实体在 `apps/server/src/skills/prompt.ts:75`（`AGENT_IDENTITY_PROMPT`）
  - 项目级可配：`packages/contract/src/repo-config.ts:184`（`agent.system_prompt`）与 `packages/contract/src/settings-v21.ts:234`（`agent.limits.system_prompt`）
  - 传参链：`apps/server/src/worker/run-task.ts:838` → `916` → `apps/server/src/runtime/turn-driver.ts:328` 之后的 `driveTurn`
  - **只在新会话带**：`apps/server/src/runtime/turn-driver.ts:377`-`390`（`sessionCreate` 里 `...(params.systemPrompt === undefined || params.systemPrompt === '' ? {} : { systemPrompt: params.systemPrompt })` 位于 `if (sessionId === undefined)` 分支内）；`session/attach` 分支 `apps/server/src/runtime/turn-driver.ts:359`-`374` 不传；客户端侧同样只发非空值 `packages/racp-client/src/ops.ts:306`
  - 持久会话确实会发生「后续调用不带」：agent 任务首轮 `apps/server/src/app/compose.ts:443`-`445` 建 `persistent`，后续轮 `apps/server/src/app/compose.ts:466`-`475` 走 `sessionId + attach`
- **缺口**：需求写明「每次调用都携带」（行 1717）。代码只在**新建会话那一次**携带；`persistent` 复用轮次（`session/attach` 分支）不带，且同一次 run 内第 2 轮起的只读工具轮也复用会话（`apps/server/src/worker/run-task.ts:874`-`878`），因此这些「调用」都没有系统提示词。实现方的理由（身份由创建那一刻决定）写在 `apps/server/src/runtime/turn-driver.ts:217`-`219`，但那是设计选择，不是需求口径。另一处细节：空串一律不发（`packages/racp-client/src/ops.ts:306`），这与「未配置回落到内置默认」不冲突（默认值在 `v21-settings.ts:209` 已补齐），所以缺口只在「每次调用都带」这一条子条件。
- **判定依据**：项目级配置与内置默认回落可定位到完整路径（装配 → worker → driver → `session/create`），但「每次调用」这个子条件被 `if (sessionId === undefined)` 收窄成「每次建会话」，属需求明写子条件缺失，故部分实现。测试只钉住「只在新会话带」这一行为（`apps/server/test/runtime-turn-driver.test.ts:256`-`302`），没有、也不可能断言「每次调用都带」。
- **反证过程**：先假设「它其实每次调用都带」。构造判据：在 `turn/start` 或 attach 路径里找 `systemPrompt` 的第二条发送点。检索全仓 `systemPrompt` 共 7 个非测试写入点，全部落在 `session/create` 一侧（`ops.ts:306`、`turn-driver.ts:115/386`、`run-task.ts:916`、`compose.ts:1407`、`v21-settings.ts:209`）；`turn/start` 的载荷只有 `input.{messageId,text}`（`packages/racp-client/src/ops.ts:401`-`418`）。再验证「是否存在某条路径让 attach 也重发」：`attachSession()` 只调 `sessionAttach({sessionId})`（`apps/server/src/runtime/turn-driver.ts:479`-`497`），无 `systemPrompt` 形参。最后验证唯一可能推翻假设的情况——是否所有任务都是 `ephemeral`（每轮都新建会话，于是等价于每次都带）：`compose.ts:443`/`466` 证明 agent 任务恒为 `persistent` 且带 `sessionId` 复用。假设被推翻，维持部分实现。另单独验证「未配置是否真回落内置默认」：`v21-settings.ts:209` 与 `apps/server/test/v21-settings.test.ts:216`-`222`（两处都空/空白 → `AGENT_IDENTITY_PROMPT`）成立，这条子条件无争议通过。

### SL-2
- **状态**：部分实现
- **证据**：
  - 生效链路：`apps/server/src/app/compose.ts:1511`-`1518` 注册 worker 时注入 `gate.limitFor = concurrencyPerRepoOf(policy.settings)`；`apps/server/src/queue/boss.ts:218`-`219` 取到上限后 `await limiter.run(job.data.repo, limit, () => handler(taskJob))`；等待语义在 `apps/server/src/queue/repo-concurrency.ts:79`-`92`（`activeCount < safeLimit` 否则 push 到 `#waiters` 并 await，行 85-89）
  - 生效字段是 legacy：`apps/server/src/queue/repo-concurrency.ts:38` 读 `limits.concurrency_per_repo`；契约 `packages/contract/src/repo-config.ts:135`
  - §6.7 字段被算出来但没人消费：`apps/server/src/config/v21-settings.ts:210` `concurrency: limits.concurrency`；全仓唯一的 `resolved.concurrency` 消费点是 `apps/server/src/queue/boss.ts:208`，那是 `TaskWorkerOptions.concurrency`（全局并发），与仓库配置无关
  - 全局并发是部署常量：`apps/server/src/queue/definitions.ts:94`（`run-task` `concurrency: 3`），`apps/server/src/queue/boss.ts:208` 未传时取它
  - 触顶不等待的旁路：`apps/server/src/jobs/queue-gate.ts:122`-`136` 把排队超时行改 `cancelled_queue`，阈值来自 `apps/server/src/queue/queue-gate.ts:104`（`queue_wait_minutes`，默认 10 见 `queue/queue-gate.ts:21`），并且会撤销 pg-boss job（`apps/server/src/app/compose.ts:1540`）
- **缺口**：两个子条件都不干净。①**字段错位**：需求 §6.7 指向的 `agent.limits.concurrency` 是死字段（只有 `v21-settings.ts:210` 赋值与单测/面板，无执行侧消费），真正生效的是 legacy `limits.concurrency_per_repo`；面板同时暴露两个可编辑数字（`apps/panel/src/components/settings/v21-agent-section.tsx:38`-`43` 与 `:98`-`103`），改前者不会改变任何行为。②**「不丢弃」有反例**：等槽位期间 `tasks.status` 仍是 `queued`（`status` 在开跑时才置 `running`，见 `apps/server/src/worker/run-task.ts:665`），等待超过 `queue_wait_minutes` 就被 queue-gate 取消并撤 job，任务实际上被丢弃。
- **判定依据**：仓库级信号量确实实现「超过上限就阻塞等待」（`repo-concurrency.ts:79`-`92`），主体在；但需求所指字段无人消费、且等待有取消上限，两个子条件均可举出代码反例，故部分实现而非已实现。
- **反证过程**：假设「根本没限并发，或者限的不是需求说的那个」。第一步查「有没有一条从 `agent.limits.concurrency` 到限流的链路」：以 `\.concurrency\b` 全仓检索（非测试），命中 `v21-settings.ts:210`（赋值）、`boss.ts:208`（另一类型）、`definitions.ts:342`（校验）、`panel`（显示）——没有一条把仓库配置的并发数喂给 `RepoConcurrencyLimiter`。第二步查「真正生效的那个数从哪来」：`boss.ts:230`-`236` → `gate.limitFor` → `compose.ts:1514`-`1515` → `concurrencyPerRepoOf` → `repo-concurrency.ts:38`，确认是 legacy 字段，且默认 2（`repo-concurrency.ts:18`）。第三步反向验证「等待是否真存在」：`repo-concurrency.ts:85`-`89` 是显式 Promise 等待、`#releaser` 做槽位转移（行 113-133），且装配级测试用真 PG 断言了「同仓库第二条连 worktree 都没建」`apps/server/test/app-wiring.test.ts:327`-`364` —— 等待机制确实存在，不是空壳。第四步构造反例攻击「不丢弃」：沿 `queued` 状态找会取消它的代码，得到 `jobs/queue-gate.ts:122`-`136` 与 `compose.ts:1540`。三点合起来：机制在、字段错、有丢弃路径。

### SL-3
- **状态**：未实现
- **证据**：
  - 计数表存在但零读写：表定义 `apps/server/src/db/schema.ts:634`-`645`、迁移 `migrations/0003_multi_repo.sql:83`-`90`；全仓（`apps/`、`packages/`）检索 `quota_counters` / `quotaCounters` 只命中 schema 自身、`db/index.ts` 的再导出与两条 schema 结构测试（`apps/server/test/db-schema.test.ts:245`），**没有任何 INSERT/SELECT/UPDATE**
  - 判定入参生产侧从不置真：字段声明 `apps/server/src/trigger/decide.ts:119`，判定分支 `apps/server/src/trigger/decide.ts:251`-`253`（`if (input.dailyQuotaExceeded === true) return skip(event, 'daily-quota')`）；透传层 `apps/server/src/http/webhook-v21.ts:118`/`155`/`168`。三处生产调用点全部不传该参数：`apps/server/src/http/webhook.ts:1005`-`1012`、`1195`-`1201`、`1259`
  - 配置项无人消费：`apps/server/src/config/v21-settings.ts:211` `daily_quota: limits.daily_quota`（默认 100 见 `packages/contract/src/settings-v21.ts:238`），除赋值与单测/面板外无消费方
  - 落库通道虽在但无内容可落：`apps/server/src/http/webhook-v21.ts:198`-`211`（`UPDATE webhook_deliveries SET decision/decision_reason`）、列定义 `apps/server/src/db/schema.ts:124`；`daily-quota` 只是 `SkippedReason` 的一个字面量（`apps/server/src/trigger/decide.ts:41`）
  - 查询出口缺失：`decision_reason` 全仓无读路径——`apps/server/src/queries/issues.ts:152`、`278`、`827` 三处 `from webhook_deliveries` 都不选 `decision`/`decision_reason`；`apps/server/src/queries/audit.ts` 只读 `actions`；`openapi/pi-bot.openapi.json` 无 `decision`/`decisionReason` 字段
- **缺口**：四个子条件全缺。(a) 计数无读写 → 无法知道「今天处理了几个事件」；(b) `dailyQuotaExceeded` 在生产路径恒为 `undefined`，判定分支永不进入；(c) 因此不存在「触顶拒绝」这一动作，也就没有原因可落；(d) 即便落了 `decision_reason`，也没有任何查询/接口/面板能读它，「可查」不成立。
- **判定依据**：需求的三段（含义＝每天最多处理多少事件；触顶＝拒绝处理并记录原因；可查）在代码里找不到任何一段的真实执行路径——表是空的、判定的入参永远是空、写出的原因无人读。属于「存在 ≠ 生效」的典型：字段、表、分支、列全部存在，但串起来的生产链路为零。
- **反证过程**：假设「它其实实现了，只是藏在别处」。逐条构造检查点：①(a) 计数：检索 `quota_counters`（表名）与 `quotaCounters`（符号）全仓文件清单，只有 schema/index/tests，无仓储层；再查是否用别的表计数（`tasks where queued_at::date = today`）——`apps/server/src/queries/overview.ts:68`-`77` 只是面板展示「今日投递数/任务数」，没有任何代码把它回灌给判定。②(b) 入参：以 `dailyQuotaExceeded` 精确检索，生产侧仅 4 处（`decide.ts` 声明+判断、`webhook-v21.ts` 两处透传），三个 `decideV21Delivery` 调用点（`webhook.ts:1005`/`1195`/`1259`）均未传；再确认是否存在第二套配额判定（`github/executor.ts:353`-`400` 的 `quota_exceeded`）：那是「建 issue 动作的日配额」，与「每天最多处理多少个事件」不是同一个量，且它读的 `createdToday` 只由 `worker/types.ts:259` 端口提供，实现 `apps/server/src/app/worker-deps.ts:1073`-`1086` 只返回 `currentLabels`/`botLabels`，`createdToday` 恒缺省为 0（`apps/server/src/worker/writeback.ts:445`）——所以连它也不生效。③(c) 落库：即便 (b) 成立，`webhook.ts:1014`-`1017` 会把 `decision` 写进表，这条通道是通的，但没有触发者。④(d) 可查：检索 `decision_reason`/`decisionReason` 全部命中写入侧（`webhook-v21.ts:200`、`schema.ts:124`）与测试；`queries/` 无一处 SELECT，openapi 无该字段，故「可查」为假。四问四否，判未实现。

### SL-4
- **状态**：部分实现
- **证据**：
  - 终止：`apps/server/src/runtime/turn-driver.ts:341`-`346`（`runWithDeadline({ ms: timeoutMs, label: turn:… })`），超时后先 `turn/interrupt` 再 `session/archive`（同文件 `463`-`471`、`500`-`526`）
  - 记超时：`apps/server/src/worker/run-task.ts:517`-`520`（`case 'timeout': return 'timed-out'`）、`1583`-`1585`、`1748`-`1753`（`markTask` 写 `timed-out`），`runs.failure_class` 见 `1739`-`1747`
  - 不自动重试：`apps/server/src/queue/retry-policy.ts:124`-`125`（timeout → `noRetry`）、`apps/server/src/queue/definitions.ts:96`（`run-task` `retryLimit: 0`）、`apps/server/src/queue/boss.ts:118`（入队 `retryLimit: 0`）、重投仅当 `report.retryable`（`apps/server/src/app/compose.ts:1466`）
  - **超时值来源是硬编码**：`apps/server/src/runtime/turn-driver.ts:35`、`37`（20min / 30min 常量），`apps/server/src/worker/run-task.ts:458`-`463`（`timeoutMsForCommand` 按命令名二选一），实参在 `apps/server/src/worker/run-task.ts:575`（`deps.timeoutForCommand ?? timeoutMsForCommand`）；`apps/server/src/app/compose.ts:1389` 注入的就是该常量函数
  - 项目级配置存在但无人消费：`packages/contract/src/settings-v21.ts:240`（`turn_timeout_minutes`，1–30，默认 20）、`apps/server/src/config/v21-settings.ts:212`（赋值），除单测与面板外无消费方
  - 面板却承诺它生效：`apps/panel/src/components/settings/v21-agent-section.tsx:52`-`57`（提示「超时终止并记 timed-out，不自动重试」）
- **缺口**：「触顶终止 / 记超时 / 不自动重试」三条行为成立，但**超时值不读项目配置**：§6.7 明写这组在项目级（需求行 1708），`agent.limits.turn_timeout_minutes` 却被硬编码常量取代，用户在面板改 1–30 分钟无效，实际恒为 20 分钟（`/review-pr` 恒 30 分钟）。
- **判定依据**：三处触顶行为均可定位到执行路径且互相一致；但「单轮超时」作为项目级限额的取值链路断了（配置 → 执行侧无消费），属于需求明写的归属子条件缺失，故部分实现。
- **反证过程**：先假设「超时其实是配置驱动的」。构造判据：从 `turn_timeout_minutes` 反向追消费方。以该名全仓检索，命中只有契约定义、`v21-settings.ts:212`、面板字段、两处测试断言；没有一处传给 `timeoutMs`/`driveTurn`/`runTask` 的任一超时参数。再正向追超时值：`run-task.ts:575` ← `deps.timeoutForCommand`（`apps/server/src/app/compose.ts:1389` 注入 `timeoutMsForCommand`）← `run-task.ts:458`-`463` 两个常量 ← `turn-driver.ts:35`/`37`，链路里没有 settings。接着反向排除「也许有第二条按仓库配的超时」：检索 `timeoutMs`/`max_task_minutes`，`max_task_minutes`（`packages/contract/src/repo-config.ts:133`）同样只出现在契约/面板/配置测试，无执行侧消费。最后验证三处行为是否真的成立（避免把「部分」判成「已实现」的反向错误）：`turn-driver.ts:463`-`471` 证明超时确实 interrupt 而非放任继续跑，`run-task.ts:517`-`520` 证明落 `timed-out`，`retry-policy.ts:124`-`125` + `boss.ts:118` + `compose.ts:1466` 三处共同证明不自动重投（测试口径：`apps/server/test/queue-retry-policy.test.ts:94`-`96`、`115`）。行为成立、取值不成立 → 部分实现。

### SL-5
- **状态**：已实现
- **证据**：
  - 唯一「全局」量是部署级队列并发：`apps/server/src/queue/definitions.ts:94`（`run-task` `concurrency: 3`），`apps/server/src/queue/boss.ts:208`、`211` 以 `localConcurrency` 生效；需求 §9 明确允许部署层总量级约束（`docs/requirements.html:1832`「单项目默认 2–4 并发……并发由项目级配置，平台不设业务限流」）
  - 没有全局业务并发闸：`apps/server/src/app/compose.ts:1511`-`1518` 只注入**按仓库**的 `gate`；`repo-concurrency.ts` 的计数按 repo 分组（`repo-concurrency.ts:53`-`54`）
  - 没有全局日配额：`daily_quota` 只出现在项目级配置（`packages/contract/src/settings-v21.ts:238`），无平台级同名/同义量（全仓 `quota` 检索见 SL-3）
  - 项目级限流项各自独立：`max_comments_per_hour` / `max_actions_per_run` / `max_task_minutes` / `concurrency_per_repo` / `queue_wait_minutes` 全在 `packages/contract/src/repo-config.ts:129`-`137`，均无平台级兜底值
  - 批量上限不是业务限流：`apps/server/src/agent/constants.ts:11`（`AGENT_DISPATCH_MAX_ISSUES = 20`）是单轮调度批量，`apps/server/src/jobs/queue-gate.ts:113`（`QUEUE_GATE_BATCH_LIMIT`）是单次扫描批量
- **缺口**：（无）
- **判定依据**：找不到任何「卡所有项目」的业务限流；唯一的全局数字是部署级并发 3，且需求 §9 与 §6.7 结尾的注（行 1739）都把它归到部署层，不属业务限流。
- **反证过程**：假设「它偷偷加了全局业务限流」。构造三个检查点：①全局并发闸：检索 `Semaphore`/`p-limit`/`global.*concurrency` 一类实现，只有 `RepoConcurrencyLimiter`，其键是 repo（`repo-concurrency.ts:53`）；`TaskWorkerOptions.concurrency` 若被填成配置值就是全局闸——但装配层从未传它（`compose.ts:1511`-`1518` 只给 `gate`），故恒为部署常量 3。②全局日/小时配额：检索 `daily_quota`/`quota`，项目级之外无任何全局计数器（且项目级那个也没生效，见 SL-3）。③伪装成安全机制的业务限流：`apps/server/src/queue/circuit-breaker.ts:27`-`31` 有「15 分钟 5 次 429 → 全局暂停」，看似全局限流；但它由 GitHub 429 触发、是外部限流后的保护动作，不是平台自设的业务配额，且 `new CircuitBreaker(` 在 `apps/server/src` 里零调用方（仅单测），连这条保护都未接线。三点均不构成平台级业务限流；反向证据（§9 与行 1739 明说平台不做业务限流）落回代码一致，故维持已实现。

## 本节整体结论
本节 5 条中只有 SL-5 可判已实现（且它是一条「没有做某事」的约束，证据是反向检索而非执行路径）。SL-1 与 SL-4 行为主体都在，但都踩在同一类缺口上：**项目级配置算出来了却没人消费**（`turn_timeout_minutes`），或**只在一个调用点生效**（`system_prompt` 只在建会话）。SL-2 的并发闸真实可用，但生效字段是 legacy `concurrency_per_repo`，§6.7 的 `agent.limits.concurrency` 是死字段，且排队超时会被取消，与「不丢弃」相反。SL-3 日配额整条链路为空：计数表零读写、判定入参从不置真、原因无查询出口，直接影响「每天最多处理多少事件」与「可查」两项可验收能力。因此本节不可判为已实现；三个限流项（并发/配额/超时）实际处于「一项字段错位、一项完全缺失、一项取值写死」的状态。

## 核查边界
- 是否执行了命令：**未执行任何测试/构建/类型检查**（未跑 `pnpm -r test`、`pnpm lint`、`pnpm -r typecheck`）。仅执行了只读检索：`git status --short`（与 `_baseline.txt` 一致，HEAD 未变）、`Get-ChildItem | Select-String` 关键词检索、按行读取文件。测试口径因此只能声明「测试存在且断言具体」，不声明「跑过且绿」。
- 未覆盖的条目及原因：
  - 「同一项目同时最多几个会话在跑」的**真实并发观测**未验证（需要 PG + pg-boss + 真 RACP host 才能看到两次 `session/create` 的时序）；本文只以 `repo-concurrency.ts` + 装配代码 + `apps/server/test/app-wiring.test.ts` 的断言作为间接证据。
  - 日配额若被实现后能否「次日恢复」未覆盖（无实现可依）。
  - 未实际打开面板验证 `agent.limits.concurrency` / `turn_timeout_minutes` 改动后无效果（纯静态推断，依据是消费方检索为零）。
- 发现的额外问题（不属本节范围但值得记录）：
  1. `agent.limits.data_retention_days` 同样是死字段：`apps/server/src/config/v21-settings.ts:218` 赋值，但保留期作业用硬编码 `RETENTION_DAYS = 90`（`apps/server/src/jobs/retention-cleanup.ts:25`、`146`），配置改不动保留期。
  2. `limits.concurrency_per_repo` 与 `agent.limits.concurrency` 在面板同一分区并列可编辑（`apps/panel/src/components/settings/v21-agent-section.tsx:38`-`43` 与 `:98`-`103`），且 hint 文案都声称控制「同时跑几个」，用户无法分辨哪个生效。
  3. `resolveAgentExecution()` 返回的 `concurrency` / `daily_quota` / `turn_timeout_minutes` / `data_retention_days` 四个数值字段中，只有 `actions` 与 `system_prompt` 有真实消费方（`apps/server/src/http/webhook-v21.ts:686`-`688`、`apps/server/src/worker/run-task.ts:1328`、`apps/server/src/app/compose.ts:1407`）——限额段整体接近「配置形状已就绪、执行侧未接线」。
  4. 全局限流保护未接线：`apps/server/src/queue/circuit-breaker.ts` 的 `CircuitBreaker` 在 `apps/server/src` 零实例化（`new CircuitBreaker(` 只出现在 `apps/server/test/queue-circuit-breaker.test.ts:108`），`runtime_flags` 的 `rate_limit_pause` 只有 `installation.suspend` 会写（`apps/server/src/http/webhook.ts:946`-`952`），429 触发的全局熔断实际不会发生（读侧 `apps/server/src/http/webhook.ts:793`-`816` 是通的）。
