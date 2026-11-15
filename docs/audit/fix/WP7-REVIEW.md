# WP7 独立审查（角度：需求契合）

- 被审对象：`docs/audit/fix/WP7.md` 的声称（SL-1 ~ SL-5）
- 需求依据：`docs/requirements.html` §6.7（`:1707-1739`，`id="s6-7"`）
- 基线：HEAD `fbfa029` + 工作区未提交改动
- 审查方式：只读（Read / Grep / Glob / 命令）。**未改任何代码，未 `git add` / `git commit`。**
- 审查时刻：2026-11-15 02:52–03:06（注意：审查期间**另有 session 正在修改本包的多个文件**，下文的「时刻」很关键，见第四节）

---

## 结论：**打回**

一句话：SL-3 / SL-5 站得住；SL-1 按需求口径应判**未实现**（不是「部分实现」）；SL-2 与 SL-4 各有一处**「纯函数对、装配层不对」**的可复现缺陷——存量仓库的老并发键在装配层彻底失效，`/review-pr` 的 30 分钟在装配层被静默压成 20。这两处都用真模块探针跑出来了，不是推断。

---

## 一、实跑结果

| 命令 | 时刻 | 结果 | 是否本包 |
|---|---|---|---|
| `cd apps/server; npx tsc --noEmit` | 02:52 | ❌ 2 类错误，全在 `test/v21-incremental-feed.test.ts`（`Duplicate identifier 'V21WebhookDeps'` 等 12 条） | **不属本包**（该文件是别的 WP 的在途新增，`git status` 里 `??`） |
| 同上 | 03:02 | ❌ `src/trigger/roles.ts(59,50)` + `test/v21-incremental-feed.test.ts(497/511)` | **不属本包**（roles.ts / incremental-feed 都在并行 session 手里） |
| 同上 | 03:05 | ❌ `src/app/compose.ts(1007/1049)`：`AgentSessionKey` 缺 `domain` | **不属本包**（并行 session 正在给 `AgentSessionKey` 加 `domain`） |
| `npx vitest run queue-quota / queue-turn-timeout / queue-concurrency-limit / v21-session-prompt / app-wiring / trigger-decide` | 02:53 | 70 passed / 4 skipped；`app-wiring` 整个 suite `ECONNREFUSED 127.0.0.1:5432`（当时 PG 没起） | 环境问题 |
| `npx vitest run test/app-wiring.test.ts`（PG 已起） | 03:01 | ✅ 4/4，**含用例④ `settings.agent.limits.concurrency` 真的生效** | 本包相关 |
| `npx vitest run test/queue test/jobs-queue-gate` | 02:54 | ❌ 3 files / 11 tests 红：`expireInSecondsForCommand is not a function`、`EXPECTED expireInSeconds undefined vs 1800`、`queue/index.ts` 解析失败（`QUEUE_GATE_STARVATION_*` 半成品） | **并行 session 的在途改动**（`definitions.ts` 2:54:23 被改写、`queue/index.ts` 2:59:56 写下时语法不完整） |
| 同上 | 03:04 | ✅ 11 files / 135 tests 全通过（并行 session 那一波改完的瞬间） | — |
| `npx vitest run test/queue-concurrency-limit.test.ts`（含并行 session 新加的观测用例） | 03:06 | ❌ 1 failed：`满载观测 SQL… > 只统计「已经等超粗筛阈值」的排队行`；该文件 03:05:55 刚被改写（4706 → 7467 字节） | **并行 session 在途**，不算本包 |
| `pnpm lint`（仓库根） | 03:00 | ✅ 0 error / 6 warning（全在 `scripts/spike/*.mjs`，与本次无关） | 与 WP7.md 声称一致 |

**结论：** 本包自带的 4 个新测试文件（quota / turn-timeout / concurrency-limit / session-prompt）+ app-wiring + trigger-decide 在 PG 可用时全绿；`pnpm lint` 干净。红的部分逐条归因后**没有一条落在 WP7 的交付物上**，全部是并行 session 的在途改动或环境（PG/容器）。

---

## 二、SL-1 ~ SL-5 逐条裁定

### SL-1 系统提示词：**未实现**（协议层没有第二个下发点）

按审查要求逐项核实，三条全部成立：

| 核实点 | 结论 | 证据 |
|---|---|---|
| `systemPrompt` 只属于 `SessionCreateParams` | ✅ 成立 | `packages/racp-client/src/ops.ts:135-152`（字段定义在 `SessionCreateParams` 里，注释也写明「只在新建会话时带」）；`sessionCreate()` 只在 `:306` 拼这个字段 |
| `sessionAttach()` 只吃 `sessionId` | ✅ 成立 | `packages/racp-client/src/ops.ts:313-322`，参数类型就是 `{ readonly sessionId: string }` |
| `TurnStartParams` 只有 `input.{messageId,text}` + `admission`/`idempotencyKey` | ✅ 成立 | `packages/racp-client/src/ops.ts:181-187` |

调用侧也只在这两个点带：`runtime/turn-driver.ts:421-434`（新建会话）、`:465-473 → :691-700`（压缩换会话时重建）。`session/attach` 分支（`:402-418`）**不带**任何提示词——协议没有位置可带。

→ **判定：`每次调用都带` 在协议层做不到 → 未实现。** WP7.md 第 13 行写「部分实现（协议阻塞）」是**口径错误**：需求第二列写的是「每次调用都携带」，复用轮次不带就是没实现，不能用「部分」含糊过去。

**`agent_sessions.system_prompt` 是留痕，不是下发，不能当实现**：
- 列：`apps/server/src/db/schema.ts:693`；迁移 `migrations/0012_wp7_session_system_prompt.sql:11`
- 写：`apps/server/src/http/webhook-v21.ts:281-293`（SQL）、`:1420-1430`（调用点）
- 它是 `UPDATE agent_sessions`，宿主侧看不到，复用轮次也不会重发 → 与「每次调用都带」无关。

**另外一个真 bug（重要）**：`V21_SESSION_PROMPT_SQL.record` 的条件是

```sql
WHERE repo = $1 AND issue_number = $2 AND ("session_id" IS NULL OR "system_prompt" IS NULL)
```

`:282`。注释（`:277-279`）与 WP7.md 都说「只在 `session_id IS NULL`（会话还没建立）时写，会话建好后身份已冻结」。可 `OR "system_prompt" IS NULL` 恰恰会把「**老会话**（列是后加的，值为 NULL）」写成本次触发的**当前**配置——这正是注释禁止的「拿当前项目配置去猜」。`apps/server/test/v21-session-prompt.test.ts:59-62` 的用例名叫「只在会话尚未建立时写」，但它只断言 SQL 字符串**包含**两段条件，没断言两者是 `AND` 关系，所以这个反例测不出来。

### SL-2 并发数：**部分实现**

**站得住的一半**：`QUEUE_GATE_SQL` 的等槽排除段在**真 PostgreSQL** 上逐场景验证通过。我把 WP7 交付版本的 SQL 逐字搬到一个一次性 schema（`wp7_probe`，同名 `tasks`/`repos`，`SET search_path`，不碰业务表）跑了 6 个场景：

```json
{
  "候选集（会被判 cancelled_queue 的仓库）": ["a/zero-running", "e/newkey-2", "f/no-repos-row"],
  "逐项核对": {
    "a/zero-running（0 个 running，上限 2）→ 应入选": true,
    "b/full-default（2 个 running，默认上限 2）→ 应排除": true,
    "c/legacy-1（1 个 running，老键 1）→ 应排除（老键在 SQL 里生效）": true,
    "d/newkey-1（1 个 running，新键 1 / 老键 3）→ 应排除（新键赢）": true,
    "e/newkey-2（1 个 running，新键 2 / 老键 1）→ 应入选（新键赢）": true,
    "f/no-repos-row（5 个 running，repos 里没这行）→ 应入选（JOIN 落空 = 照样取消）": true
  }
}
```

→ 「等槽任务被整批排除、不会改判 `cancelled_queue`」**成立**；新键优先、老键兜底、都没有用 2 的优先级在 **SQL 侧**也成立。

**不成立的一半（致命）**：`concurrencyPerRepoOf()` 的优先级在**装配层**根本不生效。装配层传进去的不是原始 jsonb，而是已经过契约的 `RepoPolicy.settings`：

- `apps/server/src/app/compose.ts:1513-1516`：`limitFor: async (repo) => concurrencyPerRepoOf((await readRepoPolicy(pool, repo)).settings)`
- `apps/server/src/config/repo-config.ts:263,276`：`parseStoredSettings()` → `settings = settingsValid ? parsed.settings : null`，`parsed.settings` 是 `repoSettingsSchema.safeParse(...).data`
- `packages/contract/src/repo-config.ts:197`：`limits: agentExecutionSchema.prefault({})`
- `packages/contract/src/settings-v21.ts:236`：`concurrency: z.number().int().min(1).max(8).default(2)`

于是**任何**仓库解析后都带着 `agent.limits.concurrency`，老键永远读不到。探针（`$PI_SCRATCH_DIR/probe-wp7.mts`，真模块、真契约）输出：

```json
{
  "raw.limits": { "concurrency_per_repo": 1 },
  "parsed.agent.limits": { "concurrency": 2, "daily_quota": 100, "turn_timeout_minutes": 20, ... },
  "concurrencyPerRepoOf(raw)  // 单测口径": 1,
  "concurrencyPerRepoOf(parsed)  // 装配口径 readRepoPolicy().settings": 2
}
```

后果两层：**(a)** 存量仓库把 `limits.concurrency_per_repo` 配成 1 或 3，线上仍按 2 跑——静默改变行为，无日志无提示；**(b)** JS 侧与 SQL 侧口径打架（SQL 认老键 1 会保护排队，JS 认 2 直接双开），WP7.md 第 50 行「与 `concurrencyPerRepoOf()` 同优先级」只在「原始 jsonb」这个不存在的入口上成立。

**反证：永久满载 / 卡住的 running 行会不会让排队行永久挂起？**

- `tasks.status='running'` 由 `worker/run-task.ts:670` 写入；**没有任何作业回收 stale running**：`jobs/lifecycle-sweep.ts` 只处理 `succeeded/failed/timed-out/cancelled/cancelled_queue`（`:71`），全仓 grep 也没有「running 超时改状态」的路径。
- 所以进程崩溃留下 running 行 → 该仓库排队行被 `NOT EXISTS` 永久排除 → 任务既不被取消、也不被领走。
- **可观测性（WP7 交付态）：没有。** `jobs/queue-gate.ts:242-253` 的 stats 只有 `scanned/cancelled/reactions/jobsCancelled/repos`，「被挡下多少行」不出现；且只有 `cancelled > 0` 才打 info（`:250`）。也就是说「整仓卡住」在日志与指标里完全静默。

→ **判定：字面上符合「排队等待，不丢弃」（确实没丢），但「可能永久挂起 + 无任何可观测」是重要缺口**，WP7.md 第 148-149 行把它写成「前置假设」不够——假设要配一个能被发现的信号，否则它是一条永远没人知道的死锁。
（注：审查期间 03:00 前后，另一个 session 正在加 `QUEUE_GATE_STARVATION_SQL` / `starvationWarningOf`（`queue/queue-gate.ts:242-320`），方向正是补这个信号，但那是**本包之后**的改动。）

**次要**：SQL 与 JS 在越界值上口径不同——真库探针显示 `agent.limits.concurrency = 0` 时该仓库**永久**被排除（`count(*) >= 0` 恒真），而 `concurrencyPerRepoOf` 会把 0 夹到 1；另外仓库在 `repos` 表里没有行时 JOIN 落空 → 等槽保护失效（会被当成超时取消）。

### SL-3 日配额：**已实现**

- 唯一索引：`migrations/0003_multi_repo.sql:90`（`quota_counters_repo_kind_window_uidx`），`apps/server/src/db/schema.ts:644` 同步 ✅ 所以 `ON CONFLICT ("repo","kind","window_start")` 有合法的冲突目标。
- **并发不超卖：真 PostgreSQL 实测通过。** 20 条独立连接并发打与 `queue/quota.ts:63-68` 逐字一致的语句，上限 5：

```json
{ "并发连接数": 20, "上限": 5, "拿到行的条数": 5, "表里的最终计数": 5, "超卖": false }
```

  机理确认（与审查要求给的判断依据一致）：`ON CONFLICT DO UPDATE` 对已存在的行先加行锁，后来者在锁释放后**按新版本重新判 `WHERE "count" < $4`**，判不过就既不写也不返回行；空表情况下并发 INSERT 由唯一索引保证只有一条走 INSERT、其余走 DO UPDATE。故**不会超卖**，这一点不用含糊。
- 触顶后原因可查链路完整：`http/webhook.ts:1199`（主判定）、`:1266`（兜底判定）→ `http/webhook-v21.ts:228-265`（占格失败 → `decideDailyQuotaExceeded`）→ `trigger/decide.ts:287`（`reason:'daily-quota'`）→ `handleWebhook()` `:1016-1027` 落 `writeV21Decision` → `http/webhook-v21.ts:314-327`（`decision_reason = decision.reason`）→ 读取方 `queries/deliveries.ts:127`（`w.decision_reason` 原样返回 `decisionReason`）✅ 真的查得到。
- 顺序也对：只有 `base.triggered` 才占格（`webhook-v21.ts:242-244`），被开关/闸门/去重拒掉的事件不吃额度（`queue-quota.test.ts:189-202` 用「一次库调用都不该发生」断言）。

**「配额表读不到 → 放行 + warn」**：这是有意的可用性取舍，我不判它违规（需求写的是「触顶拒绝」，没说「库坏了也拒绝」）。但配套缺口是**重要度次要**的真实问题：`quota_counters` **没有**进启动自检表清单（`apps/server/src/app/compose.ts:684-701` 只有 tasks/runs/…/agent_denials），所以「迁移没跑到 0003」这种环境会**正常启动**，然后每天每条投递只打一条 warn、限额整天静默失效。按 AGENTS §7.3 的口径（缺表 → `MIGRATIONS_PENDING`），它应该进那张表。

### SL-4 单轮超时：**部分实现**

**站得住的部分**：
- `queue/definitions.ts`（WP7 交付版本）里 `DEFAULT_TURN_TIMEOUT_MINUTES=20 / REVIEW_PR=30 / 区间 1–30`，`turnTimeoutMinutesFor()`（`:83`）→ `turnTimeoutMsFor()`（`:94`）→ `expireInSecondsForCommand()`（`:105`）同源，`EXPIRE_IN_SECONDS_*` 由分钟表推算，没有第二份数字（该文件已在 02:54 被并行 session 改写，见第四节）。
- **等值性是逐值断言的，不是「不为空」**：`apps/server/test/queue-turn-timeout.test.ts:76-79` 用 `for (const command of ['auto:triage','/review-pr','/review-pr 12','auto:notice']) expect(turnTimeoutMsFor(command)).toBe(timeoutMsForCommand(command))`，另 `:70` 断言契约默认值 = 默认表。✅
- 超时后 `runs.outcome='timed-out'` / `tasks.status='timed-out'`、`run-task.retryLimit=0`（`queue-definitions.test.ts` 与 `queue-turn-timeout.test.ts:123-124` 都钉住了）→「不自动重试」成立。

**不成立的部分（致命）**：装配层把「项目有没有配」判成了「配了」。
- `apps/server/src/app/compose.ts:1365-1366`：`turnTimeoutMsFor(command, resolveTurnTimeoutMinutes(policy.settings))`
- `apps/server/src/config/v21-settings.ts:242`：`rawObject(rawObject(rawObject(settings,'agent'),'limits'),'turn_timeout_minutes')` —— 它假设 `settings` 是**原始 jsonb**
- 但 `compose.ts:1111` 的 `policy = await readRepoPolicy(...)`，`policy.settings` 是**解析后**的对象，`turn_timeout_minutes` 被契约补上了默认 20

探针（真模块）：
```json
{
  "resolveTurnTimeoutMinutes(parsedEmpty)  // 装配口径": 20,
  "/review-pr 分钟（raw 空配置）": 30,
  "/review-pr 分钟（装配空配置）": 20
}
```
→ **项目什么都没配时，`/review-pr` 拿到的是 20 分钟，不是 30。** 恰恰是 `v21-settings.ts:229-231` 注释里点名要避免的那个 bug（「那一份永远有值 → `/review-pr` 的 30 分钟会被无条件压到 20」），只是它换个位置又出现了：纯函数对了，喂进去的东西不是它以为的东西。WP7.md 第 77、80 行的声称与实现相反。

**关于 `expireInSeconds` 入队点不感知项目配置（WP7.md 自认「无害」）——不成立，方向是错的**：
WP7 版本是 `expireInSecondsForCommand(command)`，只按命令给 20/30 分钟。项目把普通命令配成 25 分钟时，任务级 deadline 是 25 分钟，而 pg-boss 会在第 20 分钟把 job 判过期——**上界小于项目值就是提前杀**，与被谁终止、失败怎么归类都不一致；`retryLimit=0` 只保证不重试，不保证不被提前杀。所以这不是「影响面有限」，而是「项目把超时调大」这条配置在 20–30 分钟区间内不生效。
→ 审查期间另一个 session 已把这一层改成固定取区间上界（`EXPIRE_IN_SECONDS_MAX = MAX_TURN_TIMEOUT_MINUTES * 60 = 1800`，`queue/definitions.ts:74` + `enqueueExpireInSeconds()` `:115`），方向正确（「绝不早于任何合法项目配置」），但那不是 WP7 的结论。

**次要**：`apps/server/src/runtime/turn-driver.ts:40,42` 仍各写一份 `20 * 60 * 1000` / `30 * 60 * 1000`（`DEFAULT_TURN_TIMEOUT_MS` / `REVIEW_PR_TURN_TIMEOUT_MS`），与「唯一事实源在 `queue/definitions.ts`」冲突；它只是 `params.timeoutMs` 缺省时的兜底（`:352`），而 `run-task.ts:580` 总会传值，所以目前不致命，但**没有任何断言**把这两个常量钉在分钟表上——下一个改默认值的人不会知道还有第三处。

### SL-5 不设平台级业务限流：**已实现（确认，无改动）**

- 全仓无「全局事件配额」：`quota_counters` 唯一键 `(repo, kind, window_start)`，本包唯一写入点只传单个 `repo`（`webhook-v21.ts:249`）。
- 现存上限都是项目级：`limits.max_comments_per_hour` / `agent.limits.{concurrency,daily_quota,turn_timeout_minutes}`。
- 全局并发 3（`queue/definitions.ts` 的 `QUEUES[runTask].concurrency`）是部署层约束，需求 §6.7 注释允许。
- 补充确认：`queue/circuit-breaker.ts:143-161` 有一个 `#global` 的限流熔断器（GitHub 429 保护），但它不是业务配额，且该文件**未被本包改动**（不在 `git status` 里）。

---

## 三、发现的问题

### 致命

| # | 问题 | 位置 |
|---|---|---|
| F1 | SL-4 装配层把「项目没配」判成「配了」：项目空配置时 `/review-pr` 从 30min 掉到 20min（正是被注释点名要避免的 bug） | `apps/server/src/app/compose.ts:1365-1366` + `apps/server/src/config/v21-settings.ts:237-247` + `apps/server/src/config/repo-config.ts:263,276` + `packages/contract/src/settings-v21.ts:240` |
| F2 | SL-2 老键 `limits.concurrency_per_repo` 在装配层彻底失效（被契约默认 2 遮蔽），存量仓库并发配置静默改变；JS 与 SQL 判据同时打架 | `apps/server/src/app/compose.ts:1513-1516` + `apps/server/src/queue/repo-concurrency.ts:42-63` + `packages/contract/src/repo-config.ts:197` + `packages/contract/src/settings-v21.ts:236` |

### 重要

| # | 问题 | 位置 |
|---|---|---|
| I1 | SL-1 判定口径应为「未实现」，`WP7.md` 写「部分实现（协议阻塞）」；需求第二列是「每次调用都携带」 | `docs/audit/fix/WP7.md:13`；协议证据 `packages/racp-client/src/ops.ts:135-152,181-187,313-322` |
| I2 | `recordSessionSystemPrompt` 的 SQL 多了 `OR "system_prompt" IS NULL`：给「老会话」写当前配置，与注释/用例名相反；用例只断言「包含」不断言组合 | `apps/server/src/http/webhook-v21.ts:277-282`；`apps/server/test/v21-session-prompt.test.ts:59-62` |
| I3 | 等槽保护没有 stale-running 自愈路径，也没有可观测信号：崩溃留下的 running 行会让整仓排队永久静默挂起（WP7 交付态） | `apps/server/src/queue/queue-gate.ts:61-77`（WP7 版本）；`apps/server/src/jobs/lifecycle-sweep.ts:71`（只处理终态）；`apps/server/src/jobs/queue-gate.ts:242-253`（stats 无「被挡下」计数） |
| I4 | `expireIn` 只按命令默认 20/30 → 项目把超时调大时 job 早于 deadline 被杀（WP7 自认「无害」不成立）。**并行 session 已修**（`EXPIRE_IN_SECONDS_MAX=1800`） | `apps/server/src/queue/definitions.ts:60-63,105-107`（WP7 版本） |

### 次要

| # | 问题 | 位置 |
|---|---|---|
| M1 | SQL 与 JS 在越界值上口径不同：`concurrency: 0` 时该仓库被**永久**排除排队取消（`count(*) >= 0` 恒真），JS 侧会夹到 1；小数按 `::int` 四舍五入 vs JS `Math.trunc` | `apps/server/src/queue/queue-gate.ts:68-76` vs `:59-63` |
| M2 | 仓库在 `repos` 表里没有行时 `JOIN` 落空 → 等槽保护失效，排队行照常被取消（探针场景 f） | `apps/server/src/queue/queue-gate.ts:61-67` |
| M3 | `quota_counters` 未纳入启动自检表清单 → 迁移没跑全也能启动，日配额整天静默失效 | `apps/server/src/app/compose.ts:684-701` |
| M4 | `runtime/turn-driver.ts` 保留第二份 20/30 毫秒常量，无等值断言 | `apps/server/src/runtime/turn-driver.ts:40,42,352` |
| M5 | 迁移账本偏差：`migrations/meta/_journal.json` 只登记 `0000_init`，`drizzle-kit generate` 不可用（WP7 已自认） | `migrations/meta/_journal.json` |

### 迁移与测试是否被改弱（两个专项）

**迁移 `0012`（手写）能否被发现：能。** `apps/server/src/db/migrate.ts:280-299` 的 `readMigrationsFromDir()` 是 `readdir` 文件扫描 + `parseMigrationFileName()` 正则（`:90-100`），**不读 journal**；`0012_wp7_session_system_prompt.sql` 符合 `NNNN_snake_case.sql` 且只有一条语句（无 `--> statement-breakpoint` 也能被 `splitSqlStatements()` 整体保留，`:113-129`）。间接证据：`test/app-wiring.test.ts` 走 `openTestDb()` → `migrate()`（`test/helpers/queries-db.ts:58`），03:01 实跑通过，说明迁移（含 0012）在真库上应用成功。文件编码是 UTF-8，`Get-Content` 显示的乱码只是控制台代码页问题。

**老键是否仍生效 → 一个「是」，一个「否」，必须分开说：**
- `concurrencyPerRepoOf()` 的**兜底代码**还在（`repo-concurrency.ts:59-63`，「两条路径读出不同数字时新字段永远赢」），并有纯函数用例（`test/queue-concurrency-limit.test.ts:27` 用**原始 jsonb** `{ limits: { concurrency_per_repo: 3 } }` 断言 3）。
- 但**装配路径上老键已经不可能生效**（F2），所以「老键仍生效」这句话在真实系统里是假的。
- **判决：把 `test/app-wiring.test.ts` 用例④ 从旧键改成新键，属于「改测试而非改实现」的掩盖。** 正确处理是二选一：要么在契约解析处保住「原始 jsonb 有没有老键」的信息（让 `concurrencyPerRepoOf` 收到未注入默认值的对象），要么在用例里**同时**保留一条老键装配用例（配 `limits.concurrency_per_repo: 1`，断言同仓库串行仍成立）。现状是「纯函数级有覆盖、装配级没有」，而 F2 恰好只存在于装配级。用例④ 改名与参数本身（`:163-166`）技术上没错——新键确实是 v2.1 的唯一真相——错在删掉了唯一那条老键的装配断言。

---

## 四、越界与误伤（`git status --short` 共 82 项）

### 属本包（与 `WP7.md` 第四节自述一致，我逐处核对过）

- 新增：`apps/server/src/queue/quota.ts`、`migrations/0012_wp7_session_system_prompt.sql`、`apps/server/test/{queue-quota,queue-turn-timeout,queue-concurrency-limit,v21-session-prompt}.test.ts`
- 修改：`apps/server/src/queue/{definitions,queue-gate,repo-concurrency,index}.ts`、`apps/server/src/http/{webhook-v21,webhook}.ts`、`apps/server/src/app/compose.ts`（4 处）、`apps/server/src/db/schema.ts`（`agent_sessions.system_prompt`）、`apps/server/test/app-wiring.test.ts`、`apps/server/test/{v21-integration,v21-webhook-integration}.test.ts`（假件各加一条 `quota_counters` 分支）

### 不属本包（别的 WP 的在途改动，本审查未计入）

`apps/server/src/compact/*`（3 个新文件）、`apps/server/src/queries/{compactions.ts,deliveries.ts,index.ts,types.ts}`、`apps/server/src/config/comment-members.ts`、`apps/server/src/github/{index.ts,users.ts}`、`apps/server/src/prompt/render.ts`、`apps/server/src/agent/*`、`apps/server/src/trigger/roles.ts`、`apps/server/src/runtime/turn-driver.ts`（压缩部分）、`apps/server/src/{cli,doctor/http,skills/builtin,app/config,app/worker-deps,config/*}.ts` 的其余改动、`packages/contract/src/{api,schemas,settings-v21}.ts`、`packages/envelope/src/v21.ts`、`openapi/*`、`docs/*`、`AGENTS.md`、`README.md`、`eslint.config.js`、以及对应测试（`compact-*`、`queries-deliveries`、`app-agent-session-plan`、`v21-incremental-feed` 等）。

### 审查期间被**另一个 session 改掉的本包文件**（重要，影响本报告的时效）

| 文件 | 最后写入 | 变化 |
|---|---|---|
| `apps/server/src/queue/definitions.ts` | 2026-11-15 02:54:23 | 16746 → 17626 字节：删 `EXPIRE_IN_SECONDS_DEFAULT/_REVIEW_PR` 与 `expireInSecondsForCommand()`，改 `EXPIRE_IN_SECONDS_MAX=1800` + `enqueueExpireInSeconds()` |
| `apps/server/src/app/compose.ts` | 02:55:24 | 追加其它 WP 的接线（`AgentSessionKey.domain` 相关，tsc 现红） |
| `apps/server/src/queue/boss.ts` | 02:55:56 | 改用 `enqueueExpireInSeconds()`（`queueJobOptions`） |
| `apps/server/src/queue/queue-gate.ts` | 02:59:51 | 10588 → 15228 字节：新增 `QUEUE_GATE_STARVATION_BATCH_LIMIT / _SQL / starvationWarningOf` |
| `apps/server/src/queue/index.ts` | 03:00:36 | 导出随之调整（02:59:56 那一刻是半成品，导致过一次 suite 解析失败） |
| `apps/server/test/queue-turn-timeout.test.ts` | 02:58:19 | 8 → 12 例，改测 `enqueueExpireInSeconds()` |
| `apps/server/test/{queue-definitions,queue-boss}.test.ts` | 02:56 | 跟随上界 1800 |
| `apps/server/test/jobs-queue-gate.test.ts` | 03:04:54 | 6906 → 13719 字节 |
| `apps/server/test/queue-concurrency-limit.test.ts` | 03:05:55 | 4706 → 7467 字节，新增「满载观测 SQL」用例（03:06 实跑时它自己红着） |

→ 所以本报告对 **SL-4 的 expireIn 方向性**与 **SL-2 的可观测性**两处，描述的是「WP7 交付态 + 已被别人改走」的情况；这两点如果按当前工作区判定，已经由后续 session 处理（质量另评，不在本包）。

---

## 五、我不确定的地方（诚实列出）

1. **「协议层做不到」的证据强度**：RACP 的真身（Host v0.22.0 的 `packages/racp/src/operations.ts`）不在本仓库，我只能核对本仓库的封装 `packages/racp-client/src/ops.ts`。如果上游协议其实有「每轮 system」槽位而本仓库封装没跟上，SL-1 的结论要从「协议阻塞」改成「封装没实现」。这一点我无法在本仓库内证伪。
2. **pg-boss 12 在 `expireIn` 到期时对「已进入 handler 的 job」的确切处置**（是否只改库状态、是否会影响正在等槽的 handler）我没有实跑（要真 boss + 真等 20 分钟）。I4 的结论只依赖「`expireIn` 是 job active 的最长时间、`retryLimit=0` 不重试」这两条可读事实，没有验证「handler 仍在跑而 job 已被判过期」之后的收尾。
3. **F1/F2 的链路结论**：我用真模块 + 真契约探针验证了「解析后的 settings 一定带 `concurrency: 2` / `turn_timeout_minutes: 20`」，并读了 `readRepoPolicy()` 的代码确认它返回解析结果。我没有在真库里造一条 `settings_valid=true` 的历史仓库行、再跑一遍完整装配去观察 `/review-pr` 的实际 deadline（`app-wiring` 的夹具本身也是 `parseValidSettings()` 过了一遍的，等价但不算端到端观测）。
4. **等槽等待的真实时长**：`RepoConcurrencyLimiter` 在**已经取到 job 之后**才排队（`queue/boss.ts:211-220`），此时 job 已是 active，`expireIn` 的计时已经在走。这个「等待期吃掉 job 寿命」的耦合我没有实测，只在代码上成立。
5. **时效性**：审查期间并行 session 一直在改同一批文件（上表）。本报告所有结论标注了时刻；03:06 之后的改动可能让其中某条（尤其 SL-2 可观测性、SL-4 expireIn）不再适用。
6. **`pnpm -r typecheck` 未跑**：我按审查清单只跑了 `apps/server` 的 `npx tsc --noEmit`，且它三次都因别人在途改动变红，没能得到一次干净的 `apps/server` 全绿。契约包与面板包的 typecheck 我没跑。

---

## 附：本次审查用过的一次性探针（都在 scratch，未入库）

- `$PI_SCRATCH_DIR/probe-wp7.mts`：真模块 + 真契约，验 F1/F2（`node --experimental-strip-types`）
- `$PI_SCRATCH_DIR/probe-quota.mjs`：真 PG，20 并发 / 上限 5，验 SL-3 不超卖
- `$PI_SCRATCH_DIR/probe-queue-gate.mjs`：真 PG + 隔离 schema `wp7_probe`，验 SL-2 的 `QUEUE_GATE_SQL` 六场景
