# WP7-R 执行限额收口报告（SL-1 ~ SL-5 三态裁定）

- 需求依据：`docs/requirements.html` §6.7（行 1707–1739；系统提示词表 1711–1726、限额表 1728–1739）
- 上一轮：[WP7.md](WP7.md)（本报告是它的收口；两处冲突以本报告为准，WP7.md 的 SL-1/SL-2/SL-4 行已同步改过）
- 本报告**未改需求文档**，未 `git add` / 未 `git commit`。

---

## 一、三态裁定（明确：已实现 / 部分实现 / 未实现）

| 项 | 需求口径 | 裁定 | 依据（一句话 + 证据） |
|---|---|---|---|
| **SL-1** 系统提示词 | 常驻、**每次调用都带**、项目级可配（未配置用内置默认） | **未实现（协议阻塞）** | 只有 `session/create` 一个下发点；`agent_sessions.system_prompt` 是**留痕**、不是下发。见 §二.1 |
| **SL-2** 并发数 | 同一项目同时最多几个会话在跑；触顶 = **排队等待，不丢弃** | **已实现** | `agent.limits.concurrency`（老键仍兜底）→ 闸门候选 SQL 整批排除等槽行；审查打回的 **F2（老键在装配层失效）已修**：装配层改喂原始 jsonb，与 SQL 同源。另补满载结构化 warn。见 §二.0、§二.4 |
| **SL-3** 日配额 | 每天最多处理多少事件；触顶 = **拒绝处理并记录原因，可查** | **已实现** | `quota_counters` 原子占格 → `daily-quota` → `webhook_deliveries.decision_reason`。本轮未改，仅复验 |
| **SL-4** 单轮超时 | 一轮最长时长；触顶 = **终止并记为超时，不自动重试** | **已实现** | 任务级 deadline 取项目值；pg-boss `expireIn` 收口为**区间上界**（不再抢跑）；审查打回的 **F1（空配置时 `/review-pr` 只有 20 分钟）已修**。见 §二.0、§二.2 |
| **SL-5** 不设平台级业务限流 | 平台不做业务限流 | **已实现（无改动）** | 全仓无全局业务配额；`run-task` 并发 3 属部署层（§9 允许）。本轮未新增任何全局限流 |

SL-3 / SL-5 本轮**只复验不改动**：`apps/server/test/queue-quota.test.ts`（12 例）与 `test/trigger-decide.test.ts`（38 例）在本轮全通过，见 §三。

> 审查（[WP7-REVIEW.md](WP7-REVIEW.md)）判「打回」，抓到两条**致命 bug**（F1 空配置时 `/review-pr` 只有 20 分钟、
> F2 老键在装配层不可能生效）。两条都在本轮**已修并加装配级回归钉**，见 §二.0。

---

## 二、改动（**先修审查打回的两条致命 bug**，再是四件事）

### 0. F1 + F2（同一个根因，一次修）

**根因（一句话）**：`apps/server/src/app/compose.ts` 把
`readRepoPolicy().settings`（**已过 `repoSettingsSchema`**）喂给两个「判项目有没有配」的读数；契约的
**prefault** 会给缺省字段补默认值（`agent.limits.concurrency: 2`、`agent.limits.turn_timeout_minutes: 20`），
于是「项目没配」与「项目配了默认值」在那一份对象里**不可区分**。

| 缺陷 | 改前 | 改后 |
|---|---|---|
| **F1** 空配置时 `/review-pr` 只有 20 分钟 | `turnTimeoutMsFor(command, resolveTurnTimeoutMinutes(policy.settings))`：函数永远拿到 20 → 永远返回 `20` → 命令默认的 30 被静默吃掉 | `resolveTurnTimeoutMinutes(policy.rawSettings)`（经 `executionLimitsOf()`）：空配置返回 `undefined` → `turnTimeoutMinutesFor()` 按命令给 20 / `/review-pr` 30 |
| **F2** 老键 `limits.concurrency_per_repo` 在装配层不可能生效 | `concurrencyPerRepoOf(policy.settings)`：prefault 的新键永远先赢 → 老键失效；而 `QUEUE_GATE_SQL` 读真库**原始 jsonb** → **JS 认 2、SQL 认 1**（两侧打架） | `concurrencyPerRepoOf(policy.rawSettings)`（同一个 `executionLimitsOf()`）：新键 → 老键 → 2，与 SQL 完全同源 |

**怎么拿到原始 jsonb**：`config/repo-config.ts` 的 `RepoPolicy` 新增可选 `rawSettings`（`readRepoPolicy()`
在解析**之前**留一份 `row['settings']`；`UNKNOWN_REPO_POLICY` 为 `null`）。为什么可选：既有 fake 不必改，
缺省时两个读数落在**安全方向**（超时按命令默认、并发 2）—— 而 bug 的那个方向（把「没配」读成「配了 20」）
不会再出现。

**唯一入口**：`app/compose.ts::executionLimitsOf(policy)`（已导出）—— 装配层只剩这一处翻译，
`timeoutForCommand` 与 `gate.limitFor` 都从它取；参数只要 `{ rawSettings }`，
结构上就排除了「顺手把 `settings` 传进去」。

**为什么不是另外两条路**

- **不改契约默认值**（审查明确禁止）：那会把「契约里的默认值」变成 `undefined`，绕过契约，等于给默认值造第二处真相。
- **不把老键彻底废弃**：那要动 `packages/contract/**`（不在本包白名单），且会让存量仓库**静默改变行为**
  （配 1 或 3 的仓库突然按 2 跑），比保留兜底更危险。所以选「让老键**真的**生效」，并让 SQL 与 JS 对齐。

**探针证据（真模块 + 真契约 + 真 PG）**：审查给的 raw/parsed 两个值，我用同一条线上链路复现
（新增用例 `test/app-wiring.test.ts` ⑤：真库 → `readRepoPolicy()` → `executionLimitsOf()`）：

```
raw = { limits: { concurrency_per_repo: 1 } }      →  parsed.agent.limits.concurrency = 2
concurrencyPerRepoOf(parsed) = 2        ← 旧 bug（F2 现场，保留为对照断言）
concurrencyPerRepoOf(raw)    = 1
executionLimitsOf(policy).concurrency = 1          ← 装配层**现在**用的值

raw = {}（什么都没配）
executionLimitsOf(policy).turnTimeoutMinutes = undefined
turnTimeoutMsFor('/review-pr', undefined)  = 1800000 ms (30min)   ← 改前是 1200000 ms (20min)
turnTimeoutMsFor('auto:triage', undefined) = 1200000 ms (20min)

raw = { agent: { limits: { turn_timeout_minutes: 5 } } }
turnTimeoutMsFor('/review-pr', 5) = 300000 ms；turnTimeoutMsFor('auto:triage', 5) = 300000 ms
```

**顺带修掉审查的「次要」项（都在 `queue/queue-gate.ts`，我的文件）**

- 并发上限读数加 `GREATEST(1, LEAST(8, …))`：与 `concurrencyPerRepoOf()` 的 1–8 夹取**数值一致**
  （`concurrency = 0` / `99` 这类脏配置不再让两侧口径不同，上报的 `limit_value` 也合理）。
- `JOIN "repos"` → `LEFT JOIN`：`repos` 里没有这一行时按**默认 2** 算（JS 侧 `concurrencyPerRepoOf(null) = 2`），
  否则「等槽保护」对这类仓库直接失效（审查点名的第二个口径差）。
- `QUEUE_GATE_STARVATION_SQL` 同样夹取 + `COALESCE(…, 2)`，并去掉 `limit_value IS NOT NULL`（现在永远有值）。
- **真 PG 对拍**（隔离 schema `wp7r_probe`，不碰业务表，跑完 DROP）：

```
改前 QUEUE_GATE_SQL（候选行数/仓库）：{"c/ninety":2, "d/no-config-row":2}   ← d 无 repos 行 → 保护失效
改后 QUEUE_GATE_SQL（候选行数/仓库）：{"c/ninety":2}                        ← d 被默认 2 保护起来了
改后 QUEUE_GATE_STARVATION_SQL：
  [{"repo":"a/legacy",     "waiting":2,"max_wait_seconds":2411,"running":1,"limit_value":1},
   {"repo":"b/zero",       "waiting":2,"max_wait_seconds":2411,"running":1,"limit_value":1},  ← 0 夹到 1
   {"repo":"d/no-config-row","waiting":2,"max_wait_seconds":2411,"running":2,"limit_value":2}] ← COALESCE 默认 2
```

> 诚实说明：`GREATEST/LEAST` 这一项**不改变闸门行为**（`count(*) >= 0` 与 `>= 1` 在有 running 行时等价），
> 它只是让两侧**数值**同口径、让告警里的 `limit_value` 可读；真正改变行为的是 `LEFT JOIN`（上面 d 那一行）。

### 1. SL-1 状态改准为「未实现（协议阻塞）」

**协议事实（复核过，不是推断）**

- `packages/racp-client/src/ops.ts:135` `SessionCreateParams.systemPrompt`（唯一出现点，`:151`）→ 只有 `sessionCreate()` 会带（`:306`）。
- `packages/racp-client/src/ops.ts:313` `sessionAttach()` 只吃 `sessionId`，没有提示词位。
- `packages/racp-client/src/ops.ts:181` `TurnStartParams` = `input.{messageId,text}` + `admission` / `idempotencyKey`，**无 system 槽位**。

**改前**：`WP7.md` 记「部分实现（协议阻塞）」，容易被读成「差一点就实现了」。

**改后**：

| 位置 | 改动 |
|---|---|
| `docs/audit/fix/WP7.md:15`（表格） | 状态改 **未实现（协议阻塞）**；一句话结论改为「仅 `session/create` 一次；`agent_sessions.system_prompt` 只是留痕，不是下发」 |
| `docs/audit/fix/WP7.md:25` | 小节标题改为「**未实现**：协议阻塞；只做到「可查留痕」」 |
| `docs/audit/fix/WP7.md:31-41` | 明确「一次下发（建会话时）+ 一份留痕」，并写明需求表「生效方式 = 每次调用都带」这一格**没有满足**；补「留痕只能事后查、不参与渲染」 |
| `docs/audit/fix/WP7.md:147-150`（阻塞项 1） | 冠以「**未实现**」字样 |
| `apps/server/src/http/webhook-v21.ts:293-306` | `V21_SESSION_PROMPT_SQL` 上方的注释**已按这个口径写**（原就写了「复用轮次里没有第二次下发点」），本轮补两句：「这一列是**留痕**，不是下发：§6.7 SL-1 的「每次调用都带」在协议层做不到」+「把这一列塞回 `input.text` 等于每轮重发恒定身份，与 §6.7 的表分工相反，不做」 |
| `apps/server/src/db/schema.ts:684-693` | 该列注释**原已写明**协议原因（「`session/create` 才带 … 复用轮次里做不到」）。**本轮未改该文件**（不在白名单）；残余措辞见 §四.3 |

**没有做的事（有意）**：没有把身份说明塞进 `turn/start` 的 `input.text` 每轮重发。理由：那会让系统提示词变成事件模板的一部分，直接违反 §6.7 那张表「回答什么 / 生效方式」两行的分工，而且每轮多烧一份恒定 token。

### 2. SL-4：pg-boss 的 `expireIn` 不再因项目配置提前杀 job

**选择了 (b)：`expireIn` 取区间上界（30min）**

理由（在报告里定案）：

1. **(a) 不可靠也不必要**：入队点有两处（`http/webhook.ts::createQueueEnqueuer`、`app/compose.ts` 的 agent-dispatch），它们现在**故意不读** `repos.settings`；把 settings 读进来只是把同一份配置在「入队时刻」再拍一张快照 —— 任务真正开跑前的配置改动会让快照过期，读错反而更糟。
2. **(b) 方向是对的**：`expireIn` 是**部署兜底**（job 处于 active 的最长时间），不是业务闸门。只要它 ≥ 任何合法项目值（1–30min），平台就**永远不早于**项目配置动手；真正的闸门只有任务级 deadline 一处。
3. **(b) 无额外 DB 读**：每轮少一次读库，且不存在快照偏差。

**改前 → 改后**

| 位置 | 改前 | 改后 |
|---|---|---|
| `queue/definitions.ts:74` | —（无此常量） | `EXPIRE_IN_SECONDS_MAX = MAX_TURN_TIMEOUT_MINUTES × 60`（1800s），附「为什么取上界」的完整理由 |
| `queue/definitions.ts:105` | `expireInSecondsForCommand(command, configuredMinutes?)` = 分钟 × 60（项目感知，但入队点拿不到项目值，实际只用命令默认 20/30） | **删除**；改由 `enqueueExpireInSeconds()`（`:115`）= `EXPIRE_IN_SECONDS_MAX` |
| `queue/definitions.ts:151` | `run-task` 队列 `expireInSeconds: EXPIRE_IN_SECONDS_DEFAULT`（1200） | `expireInSeconds: EXPIRE_IN_SECONDS_MAX`（1800） |
| `queue/boss.ts:117` | `queueJobOptions(taskId, command)` → `expireInSecondsForCommand(command)` | `queueJobOptions(taskId)` → `enqueueExpireInSeconds()`（`:120`）；`enqueueTask`（`:126`）、`enqueueRetry`（`:149`）同步 |
| `app/compose.ts:940` | `expireInSeconds: expireInSecondsForCommand(command)`（agent-dispatch 入队） | `expireInSeconds: enqueueExpireInSeconds()` |
| `app/compose.ts`（原 `:1402`，现 `:1476`） | `turnTimeoutMsFor(command, resolveTurnTimeoutMinutes(policy.settings))`（**F1 的现场**） | `turnTimeoutMsFor(command, executionLimitsOf(policy).turnTimeoutMinutes)` —— 喂原始 jsonb，空配置时返回 `undefined`（见 §二.0） |
| `queue/index.ts:17,26` | 导出 `EXPIRE_IN_SECONDS_DEFAULT/REVIEW_PR`、`expireInSecondsForCommand` | 导出 `EXPIRE_IN_SECONDS_MAX`、`enqueueExpireInSeconds` |

**验收（项目配 5 分钟）**：`apps/server/test/queue-turn-timeout.test.ts:100-127` 新增一组三例

- `turnTimeoutMsFor(command, resolveTurnTimeoutMinutes({agent:{limits:{turn_timeout_minutes:5}}}))` **= 300000**（`/review-pr` 也一样）—— 这就是 5 分钟终止的那把闸；
- `enqueueExpireInSeconds() * 1000 > 300000` 且 `queueJobOptions(...).expireInSeconds === enqueueExpireInSeconds()` —— pg-boss 抢不了跑；
- `decideOutcome([{failureClass:'timeout'}], null, false) === 'timed-out'`、`queueSpecOf('run-task').retryLimit === 0`、`queueJobOptions(...).retryLimit === 0` —— 记为超时、**不自动重试**。

### 3. `app-wiring.test.ts` 用例④：补回旧键用例

**上一轮的问题**：用例④从旧键改成了新键，旧键一度没有用例，而旧键其实**仍然生效**（`queue/repo-concurrency.ts:60-62` 的 `v21ConcurrencyOf() ?? legacyConcurrencyOf() ?? 2`）。

**本轮做法（分两层，因为缺陷也分两层）**：

1. **纯函数层**（口径本身）：`queue-concurrency-limit.test.ts` 的旧键用例（下面 1、2、3 条）；
2. **装配层**（F2 真正出事的地方）：`app-wiring.test.ts` 用例⑤ —— 真库写入**只有旧键**的原始 jsonb，
   经 `readRepoPolicy()`（真契约解析）后断言 `concurrencyPerRepoOf(parsed) = 2`（旧 bug，作对照）而
   `executionLimitsOf(policy).concurrency = 1`（装配层现在真正用的值）。
   为什么不把它做成「两个任务并发跑」的行为用例：那就得在 e2e 里再造一套并发时序，
   而**缺陷的位置是读数**不是调度器；直接钉读数更准、也不 flaky。

- `apps/server/test/queue-concurrency-limit.test.ts:56` 新增 `describe('concurrencyPerRepoOf：老键仍然生效…')`：
  - `:57-62` 旧键=1 / 3、新键缺失 → 得 1 / 3；空 `agent` 段也不许压掉旧键；
  - `:64-72` 旧键是字符串 `'1'` / `NaN` / `limits` 不是对象 → 回落 `DEFAULT_CONCURRENCY_PER_REPO`（2），不是 0 或 NaN；
  - `:74-77` 旧键 0 / 99 → 夹到 1 / 8。
- `apps/server/test/app-wiring.test.ts:331-334` 在原位加注释，指向上面那组用例并写明「e2e 里配旧键会被契约默认值掩盖」；
  **装配层的真实生效**由同一文件的用例⑤ 钉住（§二.0）。
- 新键用例**一条没删**（`queue-concurrency-limit.test.ts:21-52`、`app-wiring.test.ts:330-「④」`）。

### 4. SL-2 的「永久挂起」加可观测（不改行为）

**问题**：`QUEUE_GATE_SQL`（`queue/queue-gate.ts:56-79`）的 `NOT EXISTS` 保护让等槽行不被取消（这是需求要的），代价是**某仓库真的永久满载**（任务卡 `running` 没人推进）时，该仓库的排队行会被永远排除在候选之外，闸门一声不响。

**改后**（纯新增，取消逻辑一字未动）：

| 位置 | 内容 |
|---|---|
| `queue/queue-gate.ts:242` | `QUEUE_GATE_STARVATION_BATCH_LIMIT = 20`（日志上限，不是业务限额） |
| `queue/queue-gate.ts:264-297` | `QUEUE_GATE_STARVATION_SQL`：按仓库聚合「已等超粗筛阈值 **且** 本仓库 running ≥ 并发上限」的行，返回 `repo` / `waiting` / `max_wait_seconds` / `running` / `limit_value`；并发上限读数与 `QUEUE_GATE_SQL` **同优先级**（`agent.limits.concurrency` → `limits.concurrency_per_repo` → 2）且同样带 `jsonb_typeof` 守卫；**语句里没有任何 UPDATE/DELETE/INSERT** |
| `queue/queue-gate.ts:300-313` | `QueueGateStarvedRepo` 类型 |
| `queue/queue-gate.ts:315-333` | `starvationWarningOf(row, limitMinutes)`：与取消判据**同一条线**（最长等待**严格大于** `queue_wait_minutes`，600s 整不算超），否则 `null` |
| `queue/index.ts:74,75,84,90` | 三个名字 + 类型的出口 |
| `jobs/queue-gate.ts:100-134` | `readStarvedRepos()`：只读；参数与粗筛秒数同 `QUEUE_GATE_SQL` |
| `jobs/queue-gate.ts:205-239` | 每轮跑一次观测；命中就 `logger.warn({ repo, waiting, maxWaitSeconds, running, limit }, …)`；**刻意不进 `warnings`**（满载是设计内状态，不该把作业健康度打成 false）；观测查询自己抛错才 push 一条 warning（不推翻本轮取消） |
| `jobs/queue-gate.ts:65,248` | `stats.starved`（本轮报了几个仓库） |

**测试**（`apps/server/test/jobs-queue-gate.test.ts`，假池 + 抓取式 logger）：

- `:291-318` 满载且超阈值 → **恰好一条** warn，`fields` 与 `{repo:'full/repo',waiting:3,maxWaitSeconds:3600,running:2,limit:2}` 全等；**没有任何 `QUEUE_GATE_CANCEL_SQL` 调用**；`ok === true`。
- `:320-333` 600s 整（=10 分钟阈值）→ 不报、`starved === 0`（边界与取消判据一致）。
- `:335-352` 观测查询抛错 → 一条 warning 含「满载观测查询失败」+ 原始错误，`cancelled` 仍为 1。
- `apps/server/test/queue-concurrency-limit.test.ts:135-156` 钉住 SQL 性质：无写动作、读数优先级顺序、粗筛条件、`>= limit_value`。

---

## 三、验证（实际跑过的命令与真实结果）

> **背景（必须一起读）**：本轮期间有其他 session 在同一个工作区并发开发（会话域 `AgentSessionDomain` 重构、
> `secretsKey`/模型供应商、面板页面、`http/api/settings.ts`、`test/v21-*.test.ts` 等）。同一命令我反复跑了多轮，
> **结论会在几分钟内变**（这一轮报 A 文件、下一轮报 B 文件、再过一会儿又全绿），因为别人正在保存中间态。
> 下面先贴「绿」的真实输出，再单列「红」的输出属于谁 —— WP7 的四个改动面（`queue/**`、
> `config/v21-settings.ts`、`trigger/decide.ts`、`jobs/queue-gate.ts` 与我这几个测试文件）
> **从未出现在任何一次失败清单里**。

### 0. 修完 F1/F2 之后的最终实跑（这一节是最新证据，下面的 1–5 是更早的历史记录）

```
cd apps/server
npx vitest run test/queue-quota.test.ts test/queue-turn-timeout.test.ts \
  test/queue-concurrency-limit.test.ts test/v21-session-prompt.test.ts \
  test/app-wiring.test.ts test/jobs-queue-gate.test.ts test/trigger-decide.test.ts
#  Test Files  7 passed (7)
#       Tests  96 passed (96)        ← 比修 F1/F2 前多 1 例（app-wiring 用例⑤）
#    Duration  6.31s                （exit 0）

npx vitest run test/queue
#  Test Files  10 passed (10)
#       Tests  133 passed (133)     （exit 0）

npx tsc --noEmit
# src/app/compose.ts(638,27): error TS2345 … ResolvedModelRole      ← 别人在写的模型角色层
# src/app/config.ts(463,5): error TS2322 … Uint8Array              ← 别人的 secretsKey
# 我的文件（queue/**、config/repo-config.ts、config/v21-settings.ts、app/compose.ts 的限额行、
#   app/index.ts、jobs/queue-gate.ts 与 6 个测试文件）零错误。

npx eslint <我的改动面：queue/**、config/repo-config.ts、config/v21-settings.ts、app/compose.ts、
  app/index.ts、jobs/queue-gate.ts、app-wiring.test.ts、queue-*.test.ts、jobs-queue-gate.test.ts、
  v21-session-prompt.test.ts>
# → 我的改动面 0 problems；仓库级 `pnpm lint` 最后的 7 条 error 全在别人的文件：
#   compose.ts:90/107（别人加的重复 cost 导入）、http/api/index.ts:54/55、http/api/settings.ts:37、
#   webhook-v21.ts:467（正在写的中间态，解析错误）、test/model-settings.test.ts:16
```
另外**真 PG 探针**（`$PI_SCRATCH_DIR/probe-wp7r-gate.mts`，隔离 schema、跑完 DROP）的输出见 §二.0 最后一段。

### 1. `cd apps/server; npx tsc --noEmit`

**绿的那次**：与 §三.4 同一窗口（`apps/server typecheck: Done`），`npx tsc --noEmit` 无输出（exit 0）。

**红的那几次**（同一命令、不同时刻；每次只报别人的文件）：

```
src/app/compose.ts(1015,46): error TS2345: ... Property 'domain' is missing ... 'AgentSessionKey'
src/config/comment-members.ts(20,8): error TS1005: '(' expected.     ← 别人新建的文件（写到一半）
src/config/model-settings.ts: Cannot find module '../../../packages/contract/src/index.ts'
src/http/api/settings.ts / src/http/api/index.ts(49,39)              ← 别人的新文件 / 导入方向
src/app/config.ts(386,3): error TS2741: Property 'secretsKey' is missing ... 'AppConfig'
test/v21-integration.test.ts(132,33): error TS1002: Unterminated string literal.
test/v21-worker-integration.test.ts(633,42): ... 'domain' is missing ...
test/v21-incremental-feed.test.ts(439,83): ... 'domain' is missing ...
```

→ 结论：**我的改动面 typecheck 干净**（每次统计错误文件清单，只有上面这些别人的文件）；仓库级绿灯取决于别人收尾。

顺带修掉一处**确实由我负责**的连带错误：并发 session 给 `recordSessionSystemPrompt()` 加了 `domain` 入参
（`webhook-v21.ts:307` 的 SQL 变成 `$4`），我把 `test/v21-session-prompt.test.ts:34-62` 的入参与断言
（`values` 顺序、`"system_prompt" = $4`）同步更新 —— 断言没有放宽，参数顺序反而钉得更死。

### 2. `cd apps/server; npx vitest run test/queue-quota.test.ts test/queue-turn-timeout.test.ts test/queue-concurrency-limit.test.ts test/v21-session-prompt.test.ts test/app-wiring.test.ts test/jobs-queue-gate.test.ts test/trigger-decide.test.ts`

```
 ✓ test/app-wiring.test.ts (4 tests)          ← 真 PG + 假 host，不是 skip
   ✓ ④ `settings.agent.limits.concurrency` 真的生效（同仓库串行、另一仓库并行）
 ✓ test/trigger-decide.test.ts (38 tests)
 ✓ test/queue-quota.test.ts (12 tests)
 ✓ test/jobs-queue-gate.test.ts (11 tests)
 ✓ test/queue-turn-timeout.test.ts (12 tests)
 ✓ test/v21-session-prompt.test.ts (3 tests)
 Test Files  7 passed (7)
      Tests  95 passed (95)
```

→ **通过**（exit 0，两次运行同结果）。

### 3. `cd apps/server; npx vitest run test/queue`

```
 ✓ test/queue-gate.test.ts (16 tests) 22ms
 ✓ test/queue-circuit-breaker.test.ts (17 tests) 11ms
 ✓ test/queue-retry-policy.test.ts (20 tests) 10ms
 ✓ test/queue-concurrency-limit.test.ts (15 tests) 9ms
 ✓ test/queue-quota.test.ts (12 tests) 14ms
 ✓ test/queue-boss.test.ts (10 tests) 28ms
 ✓ test/queue-definitions.test.ts (14 tests) 15ms
 ✓ test/queue-turn-timeout.test.ts (12 tests) 11ms
 ✓ test/queue-idempotency.test.ts (10 tests) 7ms
 ✓ test/queue-failure-class.test.ts (7 tests) 15ms
 Test Files  10 passed (10)
      Tests  133 passed (133)
```

→ **通过**。

### 4. `pnpm -r typecheck`

**绿的那次**（紧接着 §三.2 的测试批次之后）：

```
packages/envelope typecheck: Done
packages/racp-client typecheck: Done
packages/contract typecheck: Done
packages/shared typecheck: Done
apps/panel typecheck: Done
apps/server typecheck: Done
```

→ **通过（6/6，exit 0）**。

**但几分钟后又红了**（别人的改动继续落地）：

```
apps/server typecheck: test/v21-integration.test.ts(536,3): error TS1005: ',' expected.
apps/server typecheck: ... Failed
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @pi-issue-bot/server@0.0.0 typecheck
```

→ 所以本报告**不声称**「仓库此刻 typecheck 全绿」：我只声称「我跑通过一次 6/6，之后红在别人的文件上」。

### 5. `pnpm lint`

**未通过**，两次运行的 error 全部在别人的文件里：

```
# 早一次：✖ 8 problems (2 errors, 6 warnings)
apps/server/src/http/api/index.ts
  49:39  error  Unexpected path "../../github/users.ts" imported in restricted zone.
# 晚一次：✖ 15 problems (9 errors, 6 warnings)
apps/panel/src/...:19:10  error  'useEffect' is defined but never used          ← 面板页面
apps/panel/src/...:217:9  error  'summary' is assigned a value but never used
apps/server/src/http/api/settings.ts:54,55  '.../skills.ts' imported multiple times
apps/server/src/queries/types.ts:47,53      imported multiple times
```

6 条 warning 是既有 `scripts/spike/*.mjs`（与本次无关）。→ **0 条 error 在我的改动面**。

**对本次改动面的定向 lint（exit 0）**：

```
npx eslint apps/server/src/queue apps/server/src/jobs/queue-gate.ts apps/server/src/config/v21-settings.ts \
  apps/server/src/trigger/decide.ts apps/server/src/http/webhook.ts apps/server/src/http/webhook-v21.ts \
  apps/server/src/app/compose.ts apps/server/test/queue-definitions.test.ts apps/server/test/queue-boss.test.ts \
  apps/server/test/queue-turn-timeout.test.ts apps/server/test/queue-concurrency-limit.test.ts \
  apps/server/test/jobs-queue-gate.test.ts apps/server/test/app-wiring.test.ts \
  apps/server/test/v21-session-prompt.test.ts
# 无输出，exit=0
```

→ **通过（0 problems）**。

---

## 四、跳过项与残余风险

0. **审查打回的 F1 / F2 都已修**（§二.0），并且**不是改断言**：`test/app-wiring.test.ts` ⑤ 在真库上钉住
   「空配置 `/review-pr` = 30 分钟」「老键在装配层 = 1」「配 5 分钟两条命令都是 5」；
   旧的错误口径（`concurrencyPerRepoOf(parsed) = 2`）作为**对照断言**留在同一个用例里，
   谁把 `policy.settings` 又传回去，它立刻红。
1. **仓库级三条门禁不是稳定绿**：`pnpm -r typecheck` 我跑通过一次（6/6），但同一工作区里其他 session 仍在并发写代码，
   几分钟后 `apps/server` 又因别人的改动报错（`src/app/config.ts` 的 `secretsKey`、`src/app/compose.ts` 的模型角色层、
   `test/v21-*.test.ts` 等）；`pnpm lint` 的 error 也全在别人的文件（面板页面、`http/api/settings.ts`、
   `queries/types.ts`、以及 compose.ts 里别人新加的重复 `cost/index.ts` 导入）。
   **本轮改动面自身 typecheck/lint 干净**（证据见 §三.0），但「仓库此刻全绿」这句话我不能写 ——
   需要等那些 session 收尾后由他们再跑一遍。
2. **SL-1 仍未实现**（协议阻塞）：要满足「每次调用都带」，需要 Host/RACP 侧给 `turn/start`（或 `session/update`）加 system 槽位。本报告只保证「用的是哪一份」可查；面板侧展示还需 `queries/` + 契约 + 面板三处（属 WP6/WP11）。
3. **`db/schema.ts:684` 的列注释措辞**仍写着「本会话**实际使用**的系统提示词快照（…「常驻、每次调用都带」的可查留痕）」。虽然同一段下文已解释「复用轮次里做不到」，但「实际使用」四个字容易被读成「每轮都下发了」。**该文件不在我的白名单**（`db/schema.ts` 属「不许碰」），故只在此记录：建议改成「本会话**创建时**使用的系统提示词快照（留痕，不是每轮下发）」。
4. **`expireIn` 取上界带来的口径变化**：项目把 `turn_timeout_minutes` 配成 5 分钟时，pg-boss 的 job 上限仍是 30 分钟 —— 任务会在 5 分钟由任务级 deadline 终止并释放 job，不存在「提前杀」；但如果 worker 进程整个崩掉、任务级 deadline 也来不及执行，job 要到 30 分钟才被 pg-boss 判过期（比原来的 20 分钟晚 10 分钟）。这是取上界的已知代价，与「绝不早于项目配置动手」的取舍一致。
5. **满载可观测依赖 `tasks.status='running'` 的准确性**：若 `running` 行是脏数据（进程崩溃后无人清理），告警会持续报「满载」。这正是它的用途（能看见），但要提醒：**告警多不等于有活任务**。现有 task 级超时 + 生命周期清理会收尾。
6. **`queue_wait_minutes` 的语义没变**：它只对「仓库未满负荷却一直没被取走」的任务生效；满载排队不受它惩罚（这是 SL-2 要的），也因此需要 §二.4 那条告警来代替。
7. **`QUEUE_GATE_STARVATION_SQL` 的自动化覆盖仍是假池**（`jobs-queue-gate.test.ts` 注入假池 + 文本级断言），
   本轮**另用真 PG 探针**（隔离 schema `wp7r_probe`）跑通过它并给出了具体输出（§二.0 末段），
   但那份探针是 scratch 里的一次性脚本，**不在 CI 里**。要长期钉住，需要把它做成 `skipIf(没有 PG)` 的集成用例
   —— 本包未做（属可用性风险：这条查询坏掉只会让观测缺失并记一条 warning，不影响取消）。
