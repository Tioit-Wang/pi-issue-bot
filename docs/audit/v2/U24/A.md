# U24 数据需求 · A

> 核查范围：docs/requirements.html 行 1804-1821
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| DATA-1 事件投递 | 部分实现 | 原始体/类型/动作/判定结果四项都落库、90 天常量与清理作业齐备，但「判定结果」全仓零读取出口，`webhook_deliveries.decision_reason` 只写不读 |
| DATA-2 项目配置 | 部分实现 | 当前生效配置有（`repos.settings` + last-known-good），但「版本」缺：只有 `settings.version` 这个格式常量 1 与 `settings_updated_at` 时间戳，无修订号、无版本历史（旧 `prompt_versions` 表已删） |
| DATA-3 会话 | 已实现 | — |
| DATA-4 轮次 | 已实现 | — |
| DATA-5 对话 | 部分实现 | 消息与工具调用明细确实落在 `run_events`，但保留策略不是需求写的「按需」，而是固定 90 天随明细一起硬删 |
| DATA-6 用量 | 已实现 | — |

## 逐条

### DATA-1
- **状态**：部分实现
- **证据**：
  - 记录什么：`apps/server/src/db/schema.ts:88`-`:135` —— `payload`（`:103`，原始载荷以 jsonb 存）、`event`（`:94`）、`action`（`:96`）、`decision`（`:112`）+ `decisionReason`（`:124`）。写入路径 `apps/server/src/http/webhook.ts:95`-`:98`（`insertDelivery` = `INSERT INTO "webhook_deliveries" ... ON CONFLICT DO NOTHING`）、`:1101`-`:1108`（第 3/4 步落库）、`:1086`-`:1093`（验签失败也落库，`signature_valid=false`）；判定回写 `apps/server/src/http/webhook-v21.ts:198`-`:211`（`UPDATE ... SET "decision" = $2, "decision_reason" = $3`），调用点 `apps/server/src/http/webhook.ts:987`-`:1027`（外层包装，`if (decision !== null)` 时无条件写，含早退分支）；`v21DecisionRowOf` 触发侧与未触发侧都给 reason（`apps/server/src/http/webhook-v21.ts:188`-`:196`）。
  - 保留 90 天：常量 `apps/server/src/jobs/retention-cleanup.ts:25`（`export const RETENTION_DAYS = 90`），cutoff 计算 `:159`，删除语句 `:73`-`:82`（`delete from webhook_deliveries where received_at < $1`，分批 ≤1000，`:28` `RETENTION_BATCH_SIZE = 1000`）；作业执行 `:213`-`:230`；调度 `apps/server/src/queue/definitions.ts:220`-`:225`（`cron: '40 0 * * *'`，UTC）；注册 `apps/server/src/jobs/index.ts:111`（`{ queue: QUEUE.retentionCleanup, job: 'retention-cleanup' }`）+ `apps/server/src/jobs/index.ts:162`；启动装配 `apps/server/src/app/compose.ts:1546`。清理对象确为「投递」而非别的东西：同一作业里另删 `run_events`（`:54`-`:64`）与常量自称保留的 `metrics_daily`/`actions` 只读计数不删（`:91`-`:95`、`:232`-`:235`）。断言级测试 `apps/server/test/jobs-retention.test.ts:101`-`:121`（91 天前的 `webhook_deliveries` 删 2 行、昨天的留 1 行）。
  - 用途：去重 = `delivery_id` 主键 + `ON CONFLICT DO NOTHING`（`apps/server/src/db/schema.ts:92`、`apps/server/src/http/webhook.ts:95`-`:97`）；回放 = `apps/server/src/http/webhook.ts:1801`-`:1821`（读 `payload`、`source:'replay'`、强制 dry-run）+ CLI `apps/server/src/cli.ts:71`-`:74`。
- **缺口**：用途里的「排查『为什么没处理』」在代码层没有消费方——`decision` / `decision_reason` 在 `apps/server/src/queries/**` 零引用（`queries/audit.ts:107`-`:110` 命中的是审批 `approval.decision`，同名不同义），`packages/contract/src/**` 只有审批判定的 `decision: z.enum(['allow','deny'])`（`packages/contract/src/api.ts:505`），`apps/panel/src/**` 只有一处注释提及。也就是说判定结果写得很完整，但后台没有任何读取路径，只能靠人连库查。
- **判定依据**：「记录什么」四项与「保留 90 天」都有实现路径 + 具体常量 + 实际调度 + 断言测试，足以单独判已实现；但需求同一行给了「用途=去重、回放、排查『为什么没处理』」，第三项只有写没有读，按「列存在 ≠ 被消费」的口径只能判部分实现。

### DATA-2
- **状态**：部分实现
- **证据**：
  - 当前生效配置：`apps/server/src/db/schema.ts:146`-`:179` —— `settings`（`:156`，`repoSettingsSchema` 形状）、`settingsValid`（`:158`）、`settingsError`（`:160`）、`enabled`/`dryRun`（`:150`/`:152`）与 settings 内同名开关同步；写入 `apps/server/src/config/repo-config.ts:193`-`:201`（`updateSettings` 同时写 `settings`/`settings_updated_at`/`enabled`/`dry_run`），校验失败不写库、保留 last-known-good（`apps/server/src/config/repo-config.ts:449`-`:473`）；读取作为判定依据 `apps/server/src/config/repo-config.ts:255`（`readRepoPolicy`），消费方 `apps/server/src/http/webhook.ts:1164`、`:1195`-`:1200`（`settings: policy.settings` 进判定）。
  - 保留长期：`repos` 行没有任何删除路径（全仓 `delete from` 只出现在 `run_events`/`webhook_deliveries`/`metrics_daily`/`skills*`），仓库下线走 `archivedAt` 标记（`apps/server/src/db/schema.ts:154`，注释明确「不删行，保留审计与成本历史」）。
  - 版本：唯一带「版本」语义的是配置格式常量 `version: z.literal(1)`（`packages/contract/src/repo-config.ts:214`，注释写的是「配置格式版本，改结构时升版本号」）——它随 `PUT settings` 一起落进 jsonb，但全仓无读取方（`apps/server/src/config/*.ts` 里 `version` 零命中），也不随修改递增，恒为 1；对外契约 `RepoSettingsResponse`（`packages/contract/src/api.ts:771`-`:785`）没有版本字段，`RepoSummary` 只有时间戳 `settingsUpdatedAt`（`packages/contract/src/api.ts:744`）。曾经的配置版本表 `prompt_versions` 已被删除（`migrations/0006_agent.sql:73` `DROP TABLE IF EXISTS "prompt_versions"`）。
- **缺口**：「版本」子条件缺失——没有配置修订号（改一次 +1）、没有版本历史、没有「这条判定用的是第几版配置」的锚点；只有 `settings_updated_at` / `updated_at` 两个时间戳和恒为 1 的格式常量。影响：BR-8「配置即快照」在事后无法自证「当时判定用的是哪一版配置」，只能看到当前值。
- **判定依据**：「该仓库当前生效的配置」有表、有写、有读、有消费路径；「与版本」这一半只有时间戳与一个无消费方的字面量常量，按需求原文（`docs/requirements.html:1813`「当前生效的配置与版本」）属明确点名的子条件，故判部分实现。

### DATA-3
- **状态**：已实现
- **证据**：
  - 映射与状态：`apps/server/src/db/schema.ts:658`-`:686` —— 主键 `(repo, issue_number)`（`:685`，一个 issue 一行）、`session_id`（`:665`）、`state`（`:676`）、`sandbox_id`（`:678`）、`closed_at`（`:680`）；状态取值只有两种 `apps/server/src/db/schema.ts:689`-`:694`（`active` / `idle`，注释明确「没有 ended」）。写入：会话 id/轮数/游标 `apps/server/src/agent/store.ts:156`-`:163`（`saveSession` UPSERT），调用点 `apps/server/src/app/compose.ts:1049`-`:1053`；状态列由状态机写 `apps/server/src/http/webhook-v21.ts:786`-`:802`（`V21_SESSION_SQL.create/recycle/reuse`）、`:829`-`:855`（`applyV21SessionOnEvent` 读→算→写），调用点 `apps/server/src/http/webhook.ts:1210`-`:1217`。
  - 关闭 issue 只回收沙箱不删会话：纯函数 `apps/server/src/agent/session-state.ts:123`-`:131`（`issues.closed` 且实时状态 closed → `action: 'recycle-sandbox'`、`state: 'idle'`、`keepSession: true`、`rebuildSandbox: false`），动作枚举里根本没有删除/归档取值（`apps/server/src/agent/session-state.ts:69`-`:71`：`['create','reuse','recycle-sandbox']`）；SQL 层 `apps/server/src/app/compose.ts:280`-`:293`（只有 INSERT/UPDATE；`recycle` = `state='idle', sandbox_id=NULL, closed_at=now()`，会话语义行原样保留）与 `apps/server/src/http/webhook-v21.ts:789`-`:801`（注释「永远不 DELETE」）。计划对象把「不删」写进类型：`apps/server/src/app/compose.ts:300`-`:303`（`deleteSession: false`、`archiveSessionId: null`）。
  - 保留与 issue 同生命周期：全仓 `delete from` 结果里没有 `agent_sessions`（只在 `run_events`/`webhook_deliveries`/`metrics_daily`/`skills*` 上出现），retention 作业的两条删除语句也不涉及会话表（`apps/server/src/jobs/retention-cleanup.ts:54`-`:64`、`:73`-`:82`）。
- **判定依据**：需求三个子条件（映射、两态运行状态、关闭只回收沙箱且会话随 issue 生命周期保留）各自都能定位到写入 SQL 与调用方，且「不删」有类型级与 SQL 级双重约束，无需运行环境即可判定。

### DATA-4
- **状态**：已实现
- **证据**：
  - 起止与结果、失败原因：`apps/server/src/db/schema.ts:265`-`:293` —— `startedAt`（`:276`）、`endedAt`（`:277`）、`outcome`（`:279`）、`failureClass`（`:281`）、`failureDetail`（`:283`）；写入 `apps/server/src/worker/run-store.ts:31`-`:38`（`beginRun` = `insert into runs (id, task_id, attempt, started_at)`）、`:104`-`:124`（`finishRun` = `update runs set outcome, failure_class, failure_detail, ended_at, session_id, turn_id`），调用点 `apps/server/src/worker/run-task.ts:659`-`:664` 与 `:1739`-`:1747`（`outcome`/`failureClass`/`failureDetail` 由 `decideOutcome` + `pickHighestPrioritySignal` 产出，见 `:1583`-`:1587`）；消费方 `apps/server/src/queries/tasks.ts:119`-`:140`（`run_outcome`、`last_run.failure_class`、`first_run.started_at`）、`apps/server/src/queries/issues.ts:874`-`:918`。
  - 长期保留：`runs` 无任何删除路径——retention 作业只删 `run_events`（`apps/server/src/jobs/retention-cleanup.ts:54`-`:64`）与 `webhook_deliveries`（`:73`-`:82`），`metrics-rollup` 的删除只针对 `metrics_daily`（`apps/server/src/jobs/metrics-rollup.ts:155`-`:163`）。
- **判定依据**：三个「记录什么」子条件都有写入列与 UPDATE 语句、有真实调用方、有查询消费方；「长期」由「全仓没有任何 delete 指向 runs」正面取证。不需要 PG/Docker 即可判定。

### DATA-5
- **状态**：部分实现
- **证据**：
  - 记录什么：事件流 `apps/server/src/db/schema.ts:296`-`:314`（`kind`、`payload` 逐条落库，按 `(run_id, cursor)` 唯一），写入 `apps/server/src/worker/run-store.ts:40`-`:45`（`insert into run_events (run_id, cursor, kind, payload)`），调用点 `apps/server/src/worker/run-task.ts:602`-`:611`（串行 append）与 `:975`-`:977`（除 `item.delta` 流式增量外全部落库）；工具调用明细由 `item.started` / `tool.progress` / `item.completed` 三类事件承载并被读出 `apps/server/src/queries/issues.ts:930`-`:989`（按 `toolCallId` 归并成 `IssueToolCall`）；结构化产出另存 `envelopes`（`apps/server/src/db/schema.ts:317` 起，`verdict`/`actions`/`usage`/`errors`）；消息原文 `agent_messages.comment_body`（`apps/server/src/db/schema.ts:720`）与 `tasks.prompt_text`。
  - 保留「按需」：实现是**固定 90 天硬删**——`apps/server/src/jobs/retention-cleanup.ts:25`（`RETENTION_DAYS = 90`）、`:34`-`:39`（按 UTC 日列出超期明细所在日）、`:54`-`:64`（分批删除 `run_events`）；没有任何开关/配置项能让「按需」延长或选择性保留（`RetentionCleanupOptions` 只有 `retentionDays`/`batchSize`/`dryRun`，且默认值直接取常量，`apps/server/src/jobs/retention-cleanup.ts:108`-`:115`、`:146`-`:147`；`private` 调用点 `apps/server/src/jobs/index.ts:162` 不传 options）。面板把这条策略对外说成「transcript 90 天」：`apps/server/src/queries/system.ts:38`（`transcriptDays: 90`），而库里并没有独立的 transcript 表，对应实体就是 `run_events`。
- **缺口**：需求写「保留=按需」，实现是「固定 90 天自动删除」，两者不等价：①没有保留期配置项，运营无法按需延长；②90 天后 `run_events`（含 `item.completed` 的助手正文原文与工具调用明细）整体消失，`envelopes`/`agent_messages` 虽无清理路径，但「每轮的消息 + 工具调用明细」这一粒度只能回看 90 天。③另有一处刻意裁剪：`item.delta`（正文流式增量）从不落库（`apps/server/src/worker/run-task.ts:972`-`:977`），作为设计取舍记录在此，不算缺口。
- **判定依据**：「每轮的消息与工具调用明细」有明确的写入侧与读取侧，可判成立；「按需」这个保留子条件在实现里被替换成固定周期清理，属需求点名的策略未实现，故判部分实现。

### DATA-6
- **状态**：已实现
- **证据**：
  - token 数与成本：`apps/server/src/db/schema.ts:452`-`:469` —— `runId`（`:456`）、`model`（`:458`）、`inputTokens`（`:459`）、`outputTokens`（`:460`）、`costUsd`（`:462`，`numeric(12,6)`，注释说明不用 float）；写入 `apps/server/src/worker/run-store.ts:89`-`:95`（`insert into usage_costs (run_id, model, input_tokens, output_tokens, cost_usd)`），唯一调用点 `apps/server/src/worker/run-task.ts:1595`-`:1607`（读 pi-host `turns` 的真数 → `estimateDeepSeekCostUsd` → `recordUsage`），成本口径与价目版本 `apps/server/src/cost/pricing.ts:29`-`:32`、`:40`-`:41`（`PRICE_VERSION`）、`:102`-`:135`（三段分别计价、按 6 位小数收敛）；生产注入 `apps/server/src/app/compose.ts:1374`（`usage: createHostUsageReader(...)`）。
  - 保留长期：`usage_costs` 无任何删除路径（全仓 `delete from` 不涉及该表）；聚合产物 `metrics_daily.cost_usd`（`apps/server/src/db/schema.ts:503`）同样只读不删（`apps/server/src/jobs/retention-cleanup.ts:91`-`:95`、`:232`-`:235`），且 retention 作业的注释与日志明确「`metrics_daily` / `actions` 永久」（`:250`）。
  - 消费方（成本核算）：`apps/server/src/queries/costs.ts:75`-`:93`（按 run 读 token/金额）、`:109`-`:111`（区间求和）、`:138`-`:143`；任务级 `apps/server/src/queries/tasks.ts:145`-`:147`；总览 `apps/server/src/queries/overview.ts:83`-`:91`。
- **判定依据**：记录项（token 数与成本）与保留项（长期、无删除路径）都能正面取证，且有查询出口支撑「成本核算」用途。残余变异（用量只在 `deps.usage` 注入且 `turnId` 存在时才落库、读取失败静默跳过）写在核查边界，不影响本条判定。

## 本节整体结论
六个数仓对象的「记录什么」全部有真实写入路径与列定义，除 DATA-2 的「版本」外没有缺项；「保留」侧 DATA-1 的 90 天与 DATA-3/DATA-4/DATA-6 的长期保留都能正面取证（前者有常量 + 每日 00:40 UTC 调度 + 断言测试，后者靠「全仓无 delete 指向该表」）。不合格的两处都是需求明写的子条件：DATA-1 的「判定结果」只写不读、没有排查出口；DATA-5 的「按需」被实现成固定 90 天硬删。因此本节**不能**整体判为「已实现」，按条目记为 3 项已实现 + 3 项部分实现（DATA-1、DATA-2、DATA-5）。最小补法：给 `webhook_deliveries.decision/decision_reason` 一条只读查询出口；给 `repos` 增加配置修订号或落一份判定时的配置快照；把保留期从硬编码常量提成可配置项并决定 transcript 的口径。

## 核查边界
- 是否执行了命令：只执行了只读检索类命令（`git status --short`、`git log --oneline -3`，以及 `Select-String` / Grep 全文检索）；**未**运行 `pnpm -r test` / `typecheck` / `lint`，也未连真实 PG。结论全部为静态核查。
- 未覆盖的条目及原因：无条目被跳过。DATA-1 的「原始请求体」按字面是字节级原文，实现里存的是 `JSON.parse` 之后的 jsonb（`apps/server/src/http/webhook.ts:1101`-`:1108` 传 `payload` 对象），回放靠 `JSON.stringify(payload)` 重建（`:1811`）——语义等价但丢弃了原始字节与空白，属于口径细节，未计入缺口。
- 发现的额外问题（不属本节范围但值得记录）：
  1. `apps/server/src/db/schema.ts:290`-`:291` 给 `runs_started_at_idx` 的注释写「保留期清理」，但全仓没有任何删除 `runs` 的语句；该索引目前只服务查询（如 `apps/server/src/queries/overview.ts:166`-`:170`）。注释与代码不一致，容易被下次审计误读成「runs 也在 90 天清理之列」。
  2. `apps/server/src/queries/system.ts:38` 对外声明 `transcriptDays: 90`，但库里没有 transcript 表，实际被 90 天删掉的是 `run_events`；面板据此展示的保留说明与数据落点名称不对应。
  3. 会话 `sandbox_id` 恒为 NULL：写入侧只有 `create/reuse` 带入的 `sandboxId`（`apps/server/src/app/compose.ts:283`-`:292`、`apps/server/src/http/webhook-v21.ts:793`-`:801`），而生产上容器是「runTask 每轮创建、结束即销毁」（`apps/server/src/app/compose.ts:386`-`:388` 注释），webhook 调用点也不传 `sandboxId`（`apps/server/src/http/webhook.ts:1212`-`:1217`）。结果是 `state='active'` 实际只代表「会话可续」，不代表真有沙箱；需求只要求记录两态，故未计入 DATA-3 缺口，但状态字段的语义与 `apps/server/src/db/schema.ts:677`「`state='active'` 时非空」的注释相反。
  4. `usage_costs` 写入是「有则记、读不到就不记」的软路径（`apps/server/src/worker/run-task.ts:1595`-`:1625` 的 try/warn 与 `usage === null` 分支），因此「token 数与成本」在某些轮次会静默缺失，成本视图会把「没记账」和「零消耗」当成同一件事（`apps/server/src/queries/tasks.ts:11` 注释承认按 `null` 区分，但数据层无法追溯缺失原因）。
