# WP7 执行限额（SL-1 ~ SL-5）实现报告

- 需求依据：`docs/requirements.html` §6.7（行 1707–1739）
- 基线：`docs/audit/fix/_baseline-fix.txt`（HEAD `fbfa029`）
- 本报告只覆盖 WP7；需求文档未改，未 `git add` / `git commit`。
- **收口（第二轮）见 [WP7-R](WP7-R.md)**：SL-1 状态裁定、SL-4 的 `expireIn` 收口、SL-2 的满载可观测都在那份里；
  本文对应的行若与 WP7-R 冲突，以 WP7-R 为准。

---

## 一、逐项状态

| 项 | 需求口径 | 状态 | 一句话结论 |
|---|---|---|---|
| SL-1 系统提示词 | 常驻、**每次调用都带**、项目级可配（未配置用内置默认） | **未实现（协议阻塞）** | 仅 `session/create` 一次；`agent_sessions.system_prompt` 只是留痕，不是下发。协议层没有第二个下发点（`turn/start` 无 system 槽位、`session/attach` 只吃 `sessionId`），详见 [WP7-R](WP7-R.md) |
| SL-2 并发数 | 同项目同时最多几个会话在跑；触顶 = **排队等待，不丢弃** | **已实现** | 生效字段改成 `agent.limits.concurrency`，老键标 deprecated（**老键仍生效**，有单测）；等槽任务被排队闸门**整批排除**；永久满载时另有结构化 warn 可观测（见 [WP7-R](WP7-R.md) 第 4 条） |
| SL-3 日配额 | 每天最多处理多少事件；触顶 = **拒绝处理并记录原因，可查** | **已实现** | `quota_counters` 原子占格；占不到 → 判定 `daily-quota` → 投递行 `decision_reason='daily-quota'` |
| SL-4 单轮超时 | 一轮最长时长；触顶 = **终止并记为超时，不自动重试** | **已实现** | 任务级 deadline 按项目值（`turn_timeout_minutes`，唯一事实源）；pg-boss 的 `expireIn` 已收口为**区间上界** 30min，不再抢跑（见 [WP7-R](WP7-R.md) 第 2 条） |
| SL-5 不设平台级业务限流 | 平台不做业务限流 | **已确认（无改动）** | 没有任何全局配额；全局并发 3 属部署层约束 |

> **审查（[WP7-REVIEW.md](WP7-REVIEW.md)）判「打回」的两条致命 bug，已在 [WP7-R](WP7-R.md) §二.0 修掉**：
> **F1** 装配层把「已过契约」的 settings 喂给 `resolveTurnTimeoutMinutes()`，空配置时 `/review-pr` 只拿到 20 分钟；
> **F2** 同一个原因让老键 `limits.concurrency_per_repo` 在装配层永远失效（JS 认 2、SQL 认 1）。
> 修法：装配层改喂**原始 jsonb**（`RepoPolicy.rawSettings` + 唯一入口 `executionLimitsOf()`），
> 并加装配级回归用例 `test/app-wiring.test.ts` ⑤。
---

## 二、改动点

### SL-1 系统提示词（**未实现**：协议阻塞；只做到「可查留痕」）

**协议事实（阻塞根因，已核实在代码里，不是推断）——「每次调用都带」在协议层做不到**
- `packages/racp-client/src/ops.ts:135-152`：`systemPrompt` 只属于 `SessionCreateParams`。
- `packages/racp-client/src/ops.ts:313-322`：`sessionAttach()` 只吃 `sessionId`，没有提示词位。
- `packages/racp-client/src/ops.ts:181-187`：`TurnStartParams` 只有 `input.{messageId,text}` + `admission` / `idempotencyKey`，**没有** system 槽位。
- 结论：`session/attach` 复用的轮次在协议层没有第二个下发点；把身份塞进 `input.text` 会变成「每轮重发一遍恒定内容」，与 §6.7 表格「系统提示词 vs 事件模板」的分工相反，不做。

**做到的那部分是「可查」，不是「下发」**：一次下发（建会话时）+ 一份留痕。需求表格「生效方式 = 每次调用都带」这一格**没有满足**：
1. `session/create` 是**唯一**的提示词下发点：`config/v21-settings.ts::resolveAgentExecution()`（空 → 内置
   `AGENT_IDENTITY_PROMPT`）→ 装配层每轮传（`app/compose.ts` 的 `v21.systemPrompt`）→ 新建会话时带上。
   复用轮次（`session/attach`）**不带**，`turn/start` 的载荷里也没有位置可带。
2. **留痕（只读留痕，不是下发）**：新增 `agent_sessions.system_prompt`
   「留痕」的含义是只能事后查、不参与渲染；把它读出来塞回某一轮的消息里就是「把系统提示词当事件模板用」，是本包明确不做的事。
   - 表结构：`apps/server/src/db/schema.ts:693`
   - 迁移：`migrations/0012_wp7_session_system_prompt.sql`（只加列，`IF NOT EXISTS`，不回填）
   - 写入：`apps/server/src/http/webhook-v21.ts:286`（`recordSessionSystemPrompt()`）、`:281`（`V21_SESSION_PROMPT_SQL`）、`:1421`（`handleV21Webhook()` 里成功入库后调用，失败只 warn）
   - 只在 `session_id IS NULL`（会话未建立 / 已轮换）时写：会话建好后身份已冻结，再写只会得到与宿主不一致的记录。

> 面板侧展示「当前会话用的系统提示词」需要 `queries/` + 契约字段 + 面板三处（属 WP6/WP11 的面板/契约面），本包只保证数据落库可查。

### SL-2 并发数（已实现）

- **字段唯一真相**：`apps/server/src/queue/repo-concurrency.ts:59` `concurrencyPerRepoOf()`
  - 读 `agent.limits.concurrency`（v2.1，需求 §6.7 指的那个）→ 没有再读 `limits.concurrency_per_repo`（存量兜底）→ 都没有用 2；越界夹到 1–8。
  - 老键在契约里标 `@deprecated`：`packages/contract/src/repo-config.ts:141`。
  - 装配层只调这一个函数：`apps/server/src/app/compose.ts:1483`（`gate.limitFor`）。
- **触顶不丢弃**：`apps/server/src/queue/queue-gate.ts:56` 的 `QUEUE_GATE_SQL` 增加 `NOT EXISTS` 子查询：
  本仓库 `tasks.status='running'` 的行数 >= 本仓库并发上限时，该仓库排队中的行**不进候选**，因此不会被改判 `cancelled_queue`。
  - 上限读数与 `concurrencyPerRepoOf()` 同优先级（先 `/agent/limits/concurrency`，再 `/limits/concurrency_per_repo`，否则 2）；
  - `jsonb_typeof(...)='number'` 守卫：手改库写成字符串时不会让整条定时任务抛错（闸门必须永远能工作）。
- `RepoConcurrencyLimiter.acquire()` 补注释：等槽是阻塞等待、不超时、不失败（`apps/server/src/queue/repo-concurrency.ts:88-101`）。

> 残余口径：`queue_wait_minutes` 仍然存在，但它现在只对「仓库并未满负荷、任务却一直没被取走」的情况生效（真正的卡住），不再惩罚容量排队。

> 可观测（WP7-R 第 4 条）：`queue/queue-gate.ts::QUEUE_GATE_STARVATION_SQL` + `jobs/queue-gate.ts` 的
> `logger.warn`——「某仓库满载、排队行已超过 `queue_wait_minutes`」会被记成结构化告警（repo / waiting /
> maxWaitSeconds / running / limit），**行为不变**（仍然不取消）。

### SL-3 日配额（已实现）

- 计数器模块（新）：`apps/server/src/queue/quota.ts`
  - `dailyQuotaWindowStart()`：UTC 自然日窗口（`:53`）
  - `QUOTA_SQL.reserve`：`INSERT ... ON CONFLICT DO UPDATE ... WHERE count < limit RETURNING count`（`:36`）——判断与自增压成一条语句，抢不到最后一格的那条**不写也不返回行**
  - `reserveDailyQuota()`（`:118`）/ `readDailyQuotaUsed()`
- 判定接线（新）：`apps/server/src/http/webhook-v21.ts:228` `decideV21DeliveryWithQuota()`
  - 先按契约 §2 顺序判完（开关 → 条件 → 闸门 → 去重）；**只有判出「要处理」才占一格**（被关掉/拒绝/重复的事件不吃额度）
  - 占不到 → `trigger/decide.ts:287` `decideDailyQuotaExceeded()` 给出 `{triggered:false, reason:'daily-quota'}`（与 `decideEvent()` 第 ⑥ 步同形，不另拼一份）
  - 配额表读不到 → **放行 + warn**（配额是限额，不是可用性开关）
- 调用点：`apps/server/src/http/webhook.ts:1199`（主判定）、`:1266`（兜底判定）
- 留痕与可查：外层 `handleWebhook()` 原有的 `writeV21Decision()` 把 `decision_reason='daily-quota'` 写进 `webhook_deliveries`（BR-6 通道）。该原因**已可查询**——`apps/server/src/queries/deliveries.ts`（WP1 已建，本包**只读未改**）。
- 上限来源：`resolveAgentExecution(settings).daily_quota`（契约 1–1000，默认 100）；`clampDailyQuota()` 再夹一次。
- 窗口/语义测试：`apps/server/test/queue-quota.test.ts`（12 例）。

### SL-4 单轮超时（已实现）

- **唯一事实源**：`apps/server/src/queue/definitions.ts`
  - `DEFAULT_TURN_TIMEOUT_MINUTES = 20` / `REVIEW_PR_TURN_TIMEOUT_MINUTES = 30` / 区间 1–30
  - `turnTimeoutMinutesFor(command, configuredMinutes?)`（`:83`）：项目**显式**配了就用项目值（连 `/review-pr` 也一起），没配才按命令给 20/30
  - `turnTimeoutMsFor()` = 分钟 × 60000（**任务级闸门**，唯一事实源）
  - `EXPIRE_IN_SECONDS_MAX = MAX_TURN_TIMEOUT_MINUTES × 60`（=1800s）+ `enqueueExpireInSeconds()`：pg-boss 的
    `expireIn` **不再按命令分 20/30、也不读项目配置**，统一取区间上界（详见 [WP7-R](WP7-R.md) 第 2 条）
- 「显式值」的读取：`apps/server/src/config/v21-settings.ts:237` `resolveTurnTimeoutMinutes()` —— 原始 jsonb 里 1–30 的整数才算显式，否则 `undefined`（不能用契约默认值判「配没配」，否则 `/review-pr` 的 30 分钟会静默消失）
- 接线：`apps/server/src/app/compose.ts:1335` `timeoutForCommand: (command) => turnTimeoutMsFor(command, resolveTurnTimeoutMinutes(policy.settings))`
  - 超时后的记录仍走既有语义：`runs.outcome='timed-out'`、`tasks.status='timed-out'`，`run-task.retryLimit=0` 不变（不自动重试）
- 等值性测试：`apps/server/test/queue-turn-timeout.test.ts`（12 例）含「没配置时与 `worker/run-task.ts::timeoutMsForCommand()` 逐值一致」「契约默认值 = 默认表」「项目配 5 分钟 → 任务级 5 分钟、expireIn 更宽、超时记 `timed-out` 且 `retryLimit=0`」

### SL-5 不设平台级业务限流（确认，无改动）

- 全仓没有「全局事件配额 / 全局业务限流」：`quota_counters` 只按 `(repo, kind, window_start)` 分账，本包新增的唯一写入点也只传单个 repo。
- 现存的「上限」全是**项目级**：`settings.limits.max_comments_per_hour`、`max_actions_per_run`、`max_task_minutes`、`agent.limits.*`。
- 全局并发 3（`queue/definitions.ts` 的 `QUEUES.run-task`）是**部署层**约束，需求 §6.7 注释明确允许（见 §9 非功能需求）。
- 本包**没有**新增任何全局配额或全局限流。

---

## 三、迁移

- 新增：`migrations/0012_wp7_session_system_prompt.sql`（`ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "system_prompt" text;`）
- **没有自动应用**（AGENTS §7.1）：应用走 `pnpm cli -- migrate`。
- 说明：`pnpm --filter @pi-issue-bot/server exec drizzle-kit generate` 在本仓库**生成不出正确迁移**——
  `migrations/meta/_journal.json` 只登记了 `0000_init`，0010/0011 等是手写迁移，于是 drizzle 把「自 init 以来的全部 DDL」
  重新生成了一份（144 行建表语句）。我没提交该产物（已删除并还原 journal），改为按 0009–0011 的风格手写 0012。这是仓库既有的账本偏差，建议单独修（未在本包范围内动）。

---

## 四、超出白名单的改动（逐处说明，均为接线所必需）

| 文件:行 | 改动 | 为什么必须 |
|---|---|---|
| `apps/server/src/http/webhook.ts:82-83`、`:1199`、`:1266` | 把裸 `decideV21Delivery()` 换成 `decideV21DeliveryWithQuota()`（**只加配额入参**） | `decideV21Delivery` 的唯一调用点在这里，且它是同步纯函数、配额读库是异步的，所以「计算 `dailyQuotaExceeded` 并传入」只能发生在调用点。除此之外未改动该文件任何逻辑 |
| `apps/server/src/app/compose.ts:34`、`:73-74`、`:1335-1339`、`:1483` 注释 | 引入 `resolveTurnTimeoutMinutes` / `turnTimeoutMsFor`，`timeoutForCommand` 那两行改为项目感知 | 单轮闸门的装配点就在这里（`deps.timeoutForCommand`）；`gate.limitFor` 只改注释 |
| `apps/server/test/app-wiring.test.ts:11`、`:163-166`、`:330` | 用例④ 从 `limits.concurrency_per_repo: 1` 改为 `agent: { limits: { concurrency: 1 } }`，并改名 | 该用例先把 settings 过 `repoSettingsSchema`，老键一旦过契约就会被补上 `agent.limits.concurrency: 2`，老键从此不可区分；字段真相换成 v2.1 键后用例语义不变（同仓库串行、另一仓库并行） |
| `apps/server/test/v21-webhook-integration.test.ts:107-112`、`test/v21-integration.test.ts:92-95` | 两个假件各加一条 `INSERT INTO "quota_counters"` 分支 | 新增了一条 DB 语句，假件不认识它（返回空行）会被当成「今日额度已满」。**只加分支，未改任何断言** |

`app/compose.ts` 的 `panelDistDir` 行未动。

---

## 五、验证（实际跑过的命令与结果）

```
cd apps/server
npx tsc --noEmit                     # 通过（仅剩另一位 WP 的在途改动曾报 createReminderLedger，其已自愈）
npx vitest run test/trigger-decide.test.ts test/queue-quota.test.ts \
  test/queue-turn-timeout.test.ts test/queue-concurrency-limit.test.ts \
  test/v21-session-prompt.test.ts    # 5 文件 / 70 例 全通过
npx vitest run test/queue test/jobs-queue-gate test/v21-settings \
  test/v21-webhook-integration test/db-schema test/v21-session-prompt
                                     # 15 文件 / 188 例 全通过
npx vitest run                       # 129 文件 / 1603+ 例 全通过（2 skipped 为既有 Docker/真 git 用例）

cd ../..
pnpm -r typecheck                    # 6 个项目全部 Done
pnpm lint                            # 0 error（6 条 warning 全在 scripts/spike/*.mjs，与本次无关）
```

新增测试文件：
- `apps/server/test/queue-quota.test.ts`（SL-3，12 例）
- `apps/server/test/queue-turn-timeout.test.ts`（SL-4，8 例）
- `apps/server/test/queue-concurrency-limit.test.ts`（SL-2，9 例）
- `apps/server/test/v21-session-prompt.test.ts`（SL-1 留痕，3 例）

---

## 六、阻塞项与残余风险

1. **SL-1「每次调用都带」在协议层做不到**（**未实现**，阻塞，需 Host/RACP 侧支持）：
   除非 RACP 增加「每轮 system 提示词」槽位（例如 `turn/start` 的 `systemPrompt`，或 `session/update`），
   否则复用轮次只能依赖会话上下文里那份创建时的身份说明。本包只给出「这条会话用的是哪一份」的**可查留痕**
   （`agent_sessions.system_prompt`），它不参与渲染、也**不能**声称「每次调用都带」。
2. ~~pg-boss `expireInSeconds` 的入队点仍用命令默认值~~ → **已在 WP7-R 收口**（2026-11-14）：
   `expireIn` 统一取区间上界 1800s（`EXPIRE_IN_SECONDS_MAX` / `enqueueExpireInSeconds()`），
   两个入队点（`http/webhook.ts::createQueueEnqueuer`、`app/compose.ts` 的 agent-dispatch）都经它；
   真正的单轮闸门只有任务级 deadline 一处（项目值）。详见 [WP7-R](WP7-R.md) 第 2 条。
3. **等槽保护依赖 `tasks.status='running'` 的准确性**：若某个任务卡在 running 却无人推进（进程崩溃且无清理），
   该仓库的排队会被一直「保护」下去。现有 task 级超时 + 生命周期清理会收尾，但这是本方案的前置假设，记在此处。
4. **迁移账本偏差**（见第三节）：drizzle 生成器当前不可用于新增迁移，需单独修 `migrations/meta/_journal.json`。
5. **面板侧「当前会话的系统提示词」展示**未做（属 WP11/契约面）；数据已落库，查询可直接读 `agent_sessions.system_prompt`。
