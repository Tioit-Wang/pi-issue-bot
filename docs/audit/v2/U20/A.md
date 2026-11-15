# U20 agent 系统提示词与执行限额 · A

> 核查范围：docs/requirements.html 行 1707-1739
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| SL-1 系统提示词 | 部分实现 | 只在「新建会话」时作为 `session/create` 的 `systemPrompt` 下发；`session/attach` 复用轮次与同会话第 2+ 轮不再携带，不满足「每次调用都带」 |
| SL-2 并发数 | 部分实现 | §6.7 的面板字段 `agent.limits.concurrency` 无任何消费方（死字段）；真正生效的是旧段 `limits.concurrency_per_repo`，且等槽超过 `queue_wait_minutes` 会被闸门改成 `cancelled_queue`（有丢弃路径） |
| SL-3 日配额 | 未实现 | `agent.limits.daily_quota` 无消费方；`decideEvent()` 的 `dailyQuotaExceeded` 全仓无生产方（只有测试注入）；无按日计数、无 `daily-quota` 落库记录、无查询出口 |
| SL-4 单轮超时 | 部分实现 | 触顶行为对（终止 + `timed-out` + 不自动重试），但时长不可由项目配置：`turn_timeout_minutes` 无消费方，实际用命令常量 20/30 分钟 |
| SL-5 不设平台级业务限流 | 已实现 | 只有部署层面全局并发 3 与 429 熔断，没有平台级事件数/时间段业务限流 |

## 逐条

### SL-1
- **状态**：部分实现
- **证据**：
  - 配置面：`packages/contract/src/repo-config.ts:184`（`agent.system_prompt`，`max(SYSTEM_PROMPT_MAX_CHARS)`、空串默认）`:191`（`limits: agentExecutionSchema.prefault({})`）；字段定义 `packages/contract/src/settings-v21.ts:234`。
  - 「项目级 + 未配置用内置默认」成立：`apps/server/src/config/v21-settings.ts:200`-`:222` 是唯一裁决点，`:204`-`:207` 先取 `agent.system_prompt`（非空优先）再取 `limits.system_prompt`，`:209` 两处都空才回落 `AGENT_IDENTITY_PROMPT`（`apps/server/src/skills/prompt.ts:75`）。全仓只有这一处 `AGENT_IDENTITY_PROMPT` 引用（`grep` 结果仅 `prompt.ts` 与 `v21-settings.ts`）。
  - 「与事件模板分工」成立：事件模板是另一条链路（`packages/contract/src/settings-v21.ts:473` 的 `DEFAULT_EVENT_TEMPLATES` → `apps/server/src/http/webhook-v21.ts:1016` 用 `decidedTemplate` 渲染进 `agent_messages.comment_body`），身份文案不进任务提示词（`apps/server/src/runtime/turn-driver.ts:210`-`:213` 明确把两者分开）。
  - 「每次调用都带」不成立：装配层把身份当字符串注入一次（`apps/server/src/app/compose.ts:1407`）→ `apps/server/src/worker/run-task.ts:838`（`deps.v21?.systemPrompt`）`:916` → `apps/server/src/runtime/turn-driver.ts:384`-`:386` **只在 `sessionId === undefined`（新建会话）分支**放进 `sessionCreate({ systemPrompt })`；`:359`-`:374` 的 `session/attach` 分支不带。全仓 `sessionCreate(` 只有 `turn-driver.ts:377` 与包装层 `run-task.ts:551` 两处。
  - 该行为被测试**钉死**（不是疏漏而是设计选择）：`apps/server/test/runtime-turn-driver.test.ts:256` 用例名即「system 提示词只走「新建会话」：attach 复用不传，空串也不发」，`:282`-`:288` 断言 attach 分支的 `systemPrompt` 不会出现在任何请求里。
- **缺口**：需求明写「每次调用都携带」，实现是「每次**新建会话**携带」。两条具体不满足路径：① 阶段 2 `persistent` 复用的 `@` 轮次整轮不带身份；② 只读工具轮第 2/3 轮复用同一会话，也不带（`run-task.ts:836` 注释「第 2/3 轮复用的是同一个会话，不会重复发」）。影响：Host 侧若按 turn 级 system 语义处理，后续轮次的身份只靠会话状态隐式继承；一旦会话被每日清理或 attach 失败改新建，身份不会丢（新建会带），但「每轮显式携带」这一条需求事实不成立。
- **判定依据**：需求把「每次调用都携带」写成生效方式的核心差异（行 1717），代码明确只在会话创建时携带并有测试断言，属于「主体在、某个明写子条件缺失」，按规范判部分实现而非已实现。

### SL-2
- **状态**：部分实现
- **证据**：
  - §6.7 的字段：`packages/contract/src/settings-v21.ts:236`（`concurrency`，1–8，默认 2，注释即「超出的排队等待，不丢弃」）；面板 `apps/panel/src/components/settings/v21-agent-section.tsx:38`-`:42`（label「并发会话数（1–8）」，hint 与需求原文一致）。
  - 该字段**无消费方**：`apps/server/src/config/v21-settings.ts:210` 只是把它拷进 `resolveAgentExecution()` 返回值；`grep concurrency` 在 `apps/server/src` 下只剩这一处写入 + 旧段 `concurrency_per_repo`。`run-task.ts:1316`-`:1328` 只消费 `resolved.actions`，`webhook-v21.ts:684`-`:689` 同理；`compose.ts:1407` 只消费 `system_prompt`。
  - 真正生效的并发是**另一段**（旧 v0.3 段）：`packages/contract/src/repo-config.ts:135`（`limits.concurrency_per_repo`，1–8，默认 2）→ `apps/server/src/queue/repo-concurrency.ts:30`-`:43` 读值 → `apps/server/src/app/compose.ts:1511`-`:1518` 注入 `registerTaskWorker({ gate })` → `apps/server/src/queue/boss.ts:211`-`:221` 每个 job 前 `limiter.run(repo, limit, …)`。
  - 「排队等待，不丢弃」在信号量层成立：`queue/repo-concurrency.ts:79`-`:92` 满槽时 `await new Promise` 挂在 `#waiters`，`:113`-`:133` 释放时把槽位**直接转移**给下一个等待者（注释明确「不先减再加，避免插队」）。有一个装配级测试断言该配置真的改变行为：`apps/server/test/app-wiring.test.ts:327`（「同仓库串行、另一仓库并行」）。
  - 但「不丢弃」有第二个出口对不上：任务在 DB 里仍是 `status='queued'`（`apps/server/src/worker/run-task.ts:665` 的 `markTask(running)` 在 `runTask` 内部，即闸门放行之后才执行），而排队闸门会扫 `status='queued'` 且超过 `settings.limits.queue_wait_minutes`（默认 10 分钟）的行，改成 `cancelled_queue` 并撤 pg-boss job：`apps/server/src/jobs/queue-gate.ts:96`-`:117`、`apps/server/src/queue/queue-gate.ts:92`-`:105`（判定）、`:154`-`:156`（UPDATE 语句）、配置面 `packages/contract/src/repo-config.ts:137`、面板 `v21-agent-section.tsx:105`-`:109`（hint 自述「排队超过这个时长就取消」）。
  - 「同时最多几个会话」在 issue 会话路径上另有一道**平台级**串行：`apps/server/src/queue/definitions.ts:152`-`:153`（`agentDispatch` 并发 1），但那是「领消息→投 run-task」的调度并发（`apps/server/src/agent/dispatcher.ts:10`-`:14`），不是项目级会话上限。
- **缺口**：缺两个子条件。①「项目级并发额度」这条链路不完整：契约/面板里的 `agent.limits.concurrency` 是死字段，改它不改变任何行为，生效值只能改旧段 `limits.concurrency_per_repo`（同一语义两个字段、其中一个不接线）。② 触顶行为不是无条件「排队等待，不丢弃」：等槽超过 `queue_wait_minutes` 的任务会被改判 `cancelled_queue` 并撤 job，与「不丢弃」直接相反（若任务此刻已挂在信号量上，DB 行被改成 cancelled 后 worker 仍会继续跑，另有一致性风险）。
- **判定依据**：主体（仓库级信号量 + 等待不丢弃 + 满槽挂起）在，且测试断言生效；但需求这一条的两个明写要素——「配置项就是 §6.7 那个并发数」与「触顶只排队不丢弃」——各有一处对不上，故部分实现。

### SL-3
- **状态**：未实现
- **证据**：
  - 字段存在但无消费方：`packages/contract/src/settings-v21.ts:238`（`daily_quota`，1–1000，默认 100）；`apps/server/src/config/v21-settings.ts:211` 只做拷贝；`apps/server/src/worker/run-task.ts:1316`-`:1328` 只取 `actions`。
  - 判定分支存在但输入恒为 `undefined`：`apps/server/src/trigger/decide.ts:250`-`:253`（`dailyQuotaExceeded === true` → `skip(event,'daily-quota')`，reason 见 `:41`）；该布尔的生产方**全仓为零**：`grep dailyQuotaExceeded` 只命中 `trigger/decide.ts:119,251`、`http/webhook-v21.ts:118,155,168`（两处都是透传形参）；唯一真实调用点 `apps/server/src/http/webhook.ts:1195`-`:1201` 调 `decideV21Delivery()` 时**没有**传这个字段。唯一把它置 true 的地方是测试注入：`apps/server/test/trigger-decide.test.ts:388`。
  - 没有按日计数：`tasks`/`webhook_deliveries` 上没有任何「今日处理了多少事件」的统计进入判定（`grep quota` 在 `apps/server/src` 只剩 `create_issue` 的日配额 `github/executor.ts:380`-`:402` 与 `quota_counters` 表 `db/schema.ts:634`，那是「每仓库每天最多建几个 issue」，不是「每天最多处理多少事件」）。
  - 「记录原因，可查」两层都不成立：写入层 `webhook_deliveries.decision_reason` 有落（`http/webhook-v21.ts:198`-`:211`、列 `db/schema.ts:124`），但读取层为零 —— `grep decision_reason` 在 `apps/server/src` 只有写语句与注释，`apps/server/src/queries/` 下 `grep decision` 只命中审批相关的 `queries/audit.ts:107`-`:110`；面板也没有该字段的展示（`grep decision_reason apps/panel/src` 只有一处注释）。
- **缺口**：三个子条件全缺。①「每天最多处理多少个事件」没有任何执行路径（字段死、无计数）；②「触顶拒绝处理」的实现只是 `decideEvent()` 里一个无输入的开关；③「记录原因可查」既不产生 `daily-quota` 记录（因为永远不会触发），也未对已存在的其它 reason 提供查询出口（`decision_reason` 只写不读）。面板 hint（`v21-agent-section.tsx:49`「超出的拒绝处理并记录原因（可在审计里查）」）承诺的能力在代码里不存在。
- **判定依据**：按口径「有字段 ≠ 被消费、有函数 ≠ 有调用方」，此处字段、判定分支、落库列三者都在，但接线全部断裂，找不到任何「配额用尽 → 拒绝」的实现路径，故判未实现而不是部分实现。

### SL-4
- **状态**：部分实现
- **证据**：
  - 触顶行为成立：任务级 deadline 由 `runWithDeadline` 实施（`apps/server/src/runtime/turn-driver.ts:35` 默认 20 分钟、`:341`-`:346`）；超时后分类为 `timeout` 并**先 `turn/interrupt` 再抛**（`turn-driver.ts:466`-`:470`）；`apps/server/src/worker/run-task.ts:505`-`:527`（`decideOutcome`：最高优先级信号是 `timeout` → `'timed-out'`）、`:483`-`:488`（`tasks.status='timed-out'`）；不自动重试有两道保证：`apps/server/src/queue/retry-policy.ts:124`-`:125`（`timeout` 恒 `noRetry`，「只接受人工 /retry」）与 `apps/server/src/queue/definitions.ts:96`（`run-task` 的 `retryLimit: 0`）。
  - 但「时长」不可项目级配置：`packages/contract/src/settings-v21.ts:240`（`turn_timeout_minutes`，1–30，默认 20）→ `apps/server/src/config/v21-settings.ts:212` 拷进返回值，**全仓无第二个消费点**（`grep turn_timeout` 仅 `v21-settings.ts:212` 与 `test/v21-settings.test.ts`）。实际时长来自命令常量：`apps/server/src/worker/run-task.ts:458`-`:463`（`timeoutMsForCommand`：`/review-pr` 30min，其余 20min）→ `:575`（`timeoutMs = (deps.timeoutForCommand ?? timeoutMsForCommand)(input.command)`）→ `apps/server/src/app/compose.ts:1389`（装配注入）→ `run-task.ts:911`-`:928` 逐轮传剩余预算。
  - 相邻的同类旋钮也没接线：`packages/contract/src/repo-config.ts:133`（`limits.max_task_minutes`，面板「单任务上限」`v21-agent-section.tsx:91`-`:95`）同样无消费方（`grep max_task_minutes` 在 `apps/server/src` 为零命中）。
- **缺口**：需求这一条的「项」是可配置的限额，代码把时限写成了部署常量：改 `turn_timeout_minutes`（或 `max_task_minutes`）不改变任何行为，面板却把它们当生效旋钮展示（`v21-agent-section.tsx:52`-`:56`）。触顶行为三项（终止 / 记 `timed-out` / 不自动重试）均满足。
- **判定依据**：触顶行为是这一条最实质的部分且实现完整、有断言（`test/runtime-turn-driver.test.ts:305`-`:309` 断言两个常量；`queue-retry-policy` 用例覆盖 timeout 不重试），但「项目级单轮超时」这个字段完全没被消费，属于明写子条件缺失，故部分实现。

### SL-5
- **状态**：已实现
- **证据**：
  - 唯一的平台级总量约束是部署常量并发，不是业务限流：`apps/server/src/queue/definitions.ts:88`-`:94`（`run-task` 并发 3，注释即「8 vCPU/16GB 目标机上留一份给宿主」）、`apps/server/src/queue/boss.ts:208`-`:211`（`localConcurrency`）。
  - 平台侧没有按事件数/时间窗限流的代码：`grep -i "rate_?limit|throttle|per_minute"` 在 `apps/server/src` 命中的全部是 GitHub 响应限流归一化与重试退避（`github/headers.ts:74`-`:110`、`github/octokit.ts:159`-`:178`、`queue/retry-policy.ts:156`-`:168`）以及**失败驱动**的熔断（`queue/circuit-breaker.ts:27`-`:37`：全局 15min/5 次 429、仓库 10min/3 次 429），不是按业务量卡配额。`apps/server/src/config/env.ts` 里也没有任何事件/请求数上限（只有 `PI_BOT_BODY_LIMIT_BYTES`，属请求体大小）。
  - 业务限额旋钮都在项目级：`packages/contract/src/repo-config.ts:126`-`:139`（`limits` 五段：评论/动作/任务时长/仓库级并发/排队闸门）、`settings-v21.ts:231`-`:246`（执行段），读取全部走 `repos.settings`（`config/v21-settings.ts:70`-`:77`），没有平台级配置表参与。
- **缺口**：无（附带说明：正因为 SL-2/SL-4 的字段没接线，「不设平台级业务限流」这一条反而更容易成立——平台确实没有兜底限流，但项目那些旋钮也未全部生效，属 SL-2/SL-4 的缺口，不计入本条）。
- **判定依据**：需求行 1739 与 §9（行 1832「并发由项目级配置，平台不设业务限流」）要求的两件事——平台不做业务限流、只在部署层给总量约束——代码逐项对得上：无条件/无配额的平台级限流器，只有部署常量并发与失败驱动的熔断。

## 本节整体结论
本节不能整体判为「已实现」。5 条里只有 SL-5（不设平台级业务限流）完全成立；SL-1 与 SL-4 的「消费链路」正确（身份走 system 通道、超时终止并记 `timed-out` 不重试），但生效时机/时长与需求口径不同（身份只在建会话时带、时限是常量而非项目配置）；SL-2 存在「同一语义两个字段、§6.7 那个不接线」，且等槽超时会被闸门取消，与「不丢弃」相反；SL-3 三个子条件全缺，是本节唯一完全未实现的条目。最典型的共同形态是死字段：`agent.limits.{concurrency, daily_quota, turn_timeout_minutes}` 三个（面板都在展示、都能保存）在 `resolveAgentExecution()` 之后没有任何消费方，而真正生效的是旧段 `limits.concurrency_per_repo` 与命令常量时限。

## 核查边界
- 是否执行了命令：**未执行任何构建/测试命令，纯静态核查**。执行过的只有只读命令：`git status --short` / `git log --oneline -3`（确认与 `_baseline.txt` 的 HEAD `fbfa029` 与工作区清单一致）、`Get-ChildItem`（列测试文件名）、`Test-Path`（确认产出目录）。测试结论一律为「存在且断言具体」，未声明跑过且绿。
- 未覆盖的条目及原因：无（SL-1…SL-5 全部覆盖）。未逐行核对面板保存链路（`apps/panel/src/routes/__tests__/repo-settings-v21.test.tsx:379`-`:382` 只证明字段能被保存/回读），因为它不影响本节「是否生效」的判定。
- 发现的额外问题（不属本节范围但值得记录）：
  1. `repos.settings` 里同一语义存在两套字段（`agent.limits.{concurrency,actions}` 与 `limits.{concurrency_per_repo,…}`、`agent.system_prompt` 与 `agent.limits.system_prompt`），只靠 `resolveAgentExecution()` 的优先级注释维持一致；三处死字段都出自这套并行结构。
  2. `webhook_deliveries.decision_reason` 只写不读（无 queries/无面板字段），所有「未触发原因后台可查」类需求都受影响（本条只记录，不展开）。
  3. 排队闸门与仓库级并发信号量的交界：任务在信号量上等待时 DB 仍是 `queued`，闸门可把它改成 `cancelled_queue` 并撤 job，但已进入 handler 的 worker 不会因此停下，存在「已取消却仍在跑」的状态错位风险。
