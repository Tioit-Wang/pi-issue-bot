# U25 9 非功能需求 · B

> 核查范围：docs/requirements.html 行 1824-1841
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| NFR-1 规模 | 已实现 | —（<100 事件/天 是无代码可证的量级假设；项目级并发默认 2 已落地，入队/执行只依赖 PG + Docker） |
| NFR-2 响应 | 部分实现 | 「应答 < 10 秒」无硬保证：handler 内同步 `await` GitHub 写（eyes reaction）与 `{{repo.issues}}` 的 REST 取数，均无超时/异步化保护 |
| NFR-3 可靠 | 已实现 | —（投递/任务/消息三层去重全在 PG 唯一约束上，无内存去重表） |
| NFR-4 安全 | 已实现 | —（验签、容器 env 无凭证、写面 API 无 merge；「仓库权限最小化」不在仓库内，见边界） |
| NFR-5 可维护 | 已实现 | —（触发规则/模板/闸门逐次读库热生效；但 `settings.agent.limits.*` 有 4 个死字段，见额外问题） |
| NFR-6 可追溯 | 部分实现 | 用量线缺 issue 维度出口：issue 会话响应不含任何用量字段，面板读的 `turn.costUsd` 在契约里不存在 |

## 逐条

### NFR-1（规模：<100 事件/天；单项目默认 2–4 并发；不引入额外中间件；平台不设业务限流）
- **状态**：已实现
- **证据**：
  - `apps/server/package.json:21`–`apps/server/package.json:27` — 运行时依赖只有 `dockerode` / `fastify` / `pg` / `pg-boss`；全仓 `src` 下无 redis/kafka/rabbit/amqp 引用（仅 `pnpm-lock.yaml:1935` 出现 `@upstash/redis`，那是 `drizzle-orm` 的 **optional peer**，本仓库未装、未 import）。
  - `deploy/env.example:7` — 必填项只有 `PI_BOT_PG_DSN`；启动链路里唯一的外部服务是 PG 与 Docker socket（`apps/server/src/db/pool.ts`、`apps/server/src/sandbox/docker.ts:60`）。队列库 pg-boss 用同一个库、自带 schema（`apps/server/src/queue/definitions.ts:274`）。
  - `apps/server/src/queue/repo-concurrency.ts:18` — `DEFAULT_CONCURRENCY_PER_REPO = 2`（落在需求的 2–4 区间）；`:30`–`:43` 从 `repos.settings.limits.concurrency_per_repo` 读值并夹到 1–8。
  - `apps/server/src/queue/boss.ts:211`–`apps/server/src/queue/boss.ts:221` — worker 每取一条 job 先 `repoLimitOf(gate, job.data.repo)`，再 `limiter.run(repo, limit, handler)`：仓库级并发真的挡在 handler 前面。
  - `apps/server/src/app/compose.ts:1511`–`apps/server/src/app/compose.ts:1518` — `gate.limitFor` 走 `readRepoPolicy()`，即**每个任务开跑前读一次库**，配置改动不需要重启。
  - `apps/server/src/trigger/decide.ts:251` — 「日配额」分支存在，但 `dailyQuotaExceeded` 在全仓没有任何写入方（`grep dailyQuotaExceeded` 只有类型声明与 `...spread`），所以平台实际上没有生效的业务限流。
- **缺口**：无（判定只覆盖代码可证的三项；见判定依据）
- **判定依据**：需求此行四个子条件里，「不引入额外中间件」「单项目并发由项目级配置、默认 2–4」都能定位到实现与执行路径；「平台不设业务限流」由两个事实共同支撑：唯一的配额分支是死分支（`decide.ts:251` 无写入方），且 `quota_counters` 表（`apps/server/src/db/schema.ts:634`）无任何读路径。仍存在的 `runtime_flags.rate_limit_pause`（`apps/server/src/http/webhook.ts:1143`–`apps/server/src/http/webhook.ts:1153`）是 GitHub API 限流/安装暂停的保护，不是业务限流。「<100 事件/天」是容量假设，代码里没有任何断言或压测能证明它——这不是「未实现」，但也不能当成已验证。
- **反证过程**：
  1. 假设「悄悄引入了中间件」→ 查依赖清单、`deploy/env.example` 全文、`src` 下关键字扫描：只有 PG + Docker socket；pg-boss 只是同一 PG 内的表（`definitions.ts:274`）。无 Redis/Kafka/RabbitMQ，推翻「有中间件」。
  2. 假设「并发只是写在常量里、没有执行路径」→ 先找 `RepoConcurrencyLimiter` 的调用方：`queue/boss.ts:20` 导入、`:209` 实例化、`:219` 包住 handler；再找 `gate` 从哪来：`app/compose.ts:1511`。两跳都在生产装配路径上，不是死代码。
  3. 假设「需求说项目级并发，代码其实是全局并发」→ 全局确实还有一个 `concurrency: 3`（`queue/definitions.ts:94`），但它是本进程同时跑几个任务的上限，项目级 2 是叠在它下面的第二道闸（`repo-concurrency.ts:5`–`repo-concurrency.ts:10` 与实现一致）。默认值 2 满足「默认 2–4」。
  4. 反查「平台不设业务限流」是否被偷偷加上 → 发现两处候选（`trigger/decide.ts:251` 的 daily-quota、`github/executor.ts:384` 的创建 issue 配额）。逐个追写入方：前者无写入方；后者 `dailyQuota` 只来自 `worker/types.ts:263`，装配层从不赋值 → 默认值 `DEFAULT_DAILY_ISSUE_QUOTA`（`github/executor.ts:44`）只在 `input.dailyQuota ?? ...` 时生效，属于「配了就生效、没人配」的死开关。结论：没有生效的业务限流，不构成与需求冲突。
  5. 唯一残留风险：`concurrency_per_repo` 允许 1–8（`repo-concurrency.ts:22`），超出需求的「2–4」**上限**。需求写的是「默认 2–4」，默认值是 2，故不算冲突，但 8 这个上限在需求里没有出处。

### NFR-2（响应：webhook 应答 < 10 秒；处理异步）
- **状态**：部分实现
- **证据**：
  - `apps/server/src/http/webhook.ts:1404` — 「处理异步」成立：handler 只 `await deps.enqueue(...)`（pg-boss 任务行），真正的执行在 worker。
  - `apps/server/src/http/webhook.ts:1420`–`apps/server/src/http/webhook.ts:1430` — 但第 8 步的「回执」是 `await deps.ack.addEyesReaction(...)`，**在 handler 内同步等待一次 GitHub 写请求**；失败只 warn，但没有上限。
  - `apps/server/src/http/webhook-v21.ts:1057`–`apps/server/src/http/webhook-v21.ts:1067` — v2.1 分支同样在返回 200 前 `await rt.addEyesReaction(...)`，同一个 `createGithubWebhookAck`（`apps/server/src/http/webhook.ts:1846`）。
  - `apps/server/src/github/octokit.ts:114` — Octokit 的 `request.timeout` 默认 **15 000 ms**：单次 reaction 请求的上界已经超过需求的 10 秒。
  - `apps/server/src/http/webhook-v21.ts:465`–`apps/server/src/http/webhook-v21.ts:476`、`apps/server/src/http/webhook-v21.ts:559`–`apps/server/src/http/webhook-v21.ts:570` — 模板里写了 `{{repo.issues}}` 时，handler 内**同步** `GET /repos/{owner}/{repo}/issues`（有 5 分钟缓存，但冷启动那一次是同步的）。
  - `apps/server/src/http/webhook.ts:1042`–`apps/server/src/http/webhook.ts:1045` — 唯一与时限有关的代码是「超过 2000ms 记一条 warn 日志」，不影响返回；`http/webhook.ts` 与 `http/webhook-v21.ts` 全文无 `Promise.race` / `AbortSignal` / `setTimeout`；`apps/server/src/http/server.ts:164` 只有 `bodyLimit`，没有 `requestTimeout`。
- **缺口**：缺「10 秒」的硬保护。① 回执 reaction 没有超时、没有异步化（octokit 单请求上限 15s，已超线）；② `{{repo.issues}}` 的冷缓存取数在同一同步路径上；③ 没有 Fastify `requestTimeout`，也没有对 `handleWebhook()` 包 `Promise.race`，因此最坏耗时由外部依赖决定，而不是由代码保证。
- **判定依据**：需求的两个子条件里「处理异步」能定位到实现（入队即返回，执行在 `run-task` worker）；「应答 < 10 秒」只能找到「超时后写日志」和一条注释（`apps/server/src/http/webhook.ts:13` 的「10 秒应答在 handler 内」），注释不算证据，代码里没有任何强制手段。按「存在 ≠ 生效」的口径，不能判已实现；同时它也确实不是「与需求冲突」（回执失败只 warn，返回码仍是 200），故判部分实现。
- **反证过程**：
  1. 假设「handler 里其实没有同步外部调用」→ 逐行读 `runWebhookPipeline`：验签（本地 HMAC）→ `insertDelivery`（PG）→ `readRepoPolicy`（PG）→ `decide*`（纯函数）→ `enqueue`（PG）→ **`addEyesReaction`**（HTTPS 出站）→ 200。最后一步推翻假设。
  2. 假设「有超时保护只是藏在别处」→ 在 `http/webhook.ts`、`http/webhook-v21.ts` 搜 `Promise.race|AbortSignal|setTimeout|withTimeout`：0 命中；在 `http/server.ts` 搜 `timeout`：只有 `bodyLimit`。推翻「有保护」。
  3. 假设「reaction 很快，不会有问题」→ 找客户端默认超时：`github/octokit.ts:114` = 15 s，逐跳重定向/慢响应都在预算内，因此单这一次调用就可能吃掉 1.5 倍需求预算。
  4. 再找第二个同步出站点 → `webhook-v21.ts:465` 的 `repoIssuesProviderOf` + `:564` 的 `GET /repos/{owner}/{repo}/issues`。虽然 `needsRepoIssues()` 为 false 时不发请求（`:441` 的注释与 `:465` 的实现一致），但模板写了占位符时它就是同步的。
  5. 反向确认「不是部分实现而是无法判定」的理由不成立：不需要真 GitHub 就能确认「代码里没有超时保护」这一事实，所以选部分实现而不是无法判定。

### NFR-3（可靠：重复投递不产生重复处理；去重在持久层）
- **状态**：已实现
- **证据**：
  - `migrations/0000_init.sql:161`–`migrations/0000_init.sql:162` — `webhook_deliveries.delivery_id text PRIMARY KEY`：投递级去重是表的主键，不是缓存。
  - `apps/server/src/http/webhook.ts:95`–`apps/server/src/http/webhook.ts:98` — `INSERT ... ON CONFLICT ("delivery_id") DO NOTHING RETURNING`；`:1109`–`apps/server/src/http/webhook.ts:1118` — `rowCount === 0` → 200 `duplicate`，**在入队之前**返回。
  - `migrations/0000_init.sql:187` — `CREATE UNIQUE INDEX "tasks_idempotency_key_uidx"`；写入处 `apps/server/src/http/webhook.ts:116`–`apps/server/src/http/webhook.ts:119`（`ON CONFLICT ("idempotency_key") DO NOTHING`），命中分支 `:1367`–`apps/server/src/http/webhook.ts:1396`（不入队、只补回执）。
  - `migrations/0006_agent.sql:42` — `agent_messages` 主键 `(repo, issue_number, fingerprint)`；`migrations/0011_v21.sql:37` — `comment_slots` 主键 `(repo, issue_number, slot)`（评论按槽位覆盖，不刷屏）。
  - `apps/server/src/queue/boss.ts:110`–`apps/server/src/queue/boss.ts:116` — 第三层：pg-boss `singletonKey = taskId`，同一任务不在队列里堆两份。
  - 全仓无内存去重表：`http/webhook.ts` / `http/webhook-v21.ts` / `agent/*` / `queue/*` 的 `new Set(` / `new Map(` 全部是别名去重、定义自检或 endpoint 登记（`http/webhook.ts:1452` 是 skill id 去重），没有跨请求存活的投递表。
- **缺口**：无
- **判定依据**：需求两个子条件都能落到具体行：「重复投递不产生重复处理」由主键 + `ON CONFLICT` + `rowCount===0` 分支给出，且分支位置在入队之前（不会先建任务再去重）；「去重在持久层」由三处 PG 约束（投递、任务、消息/槽位）与 pg-boss 的 `singletonKey` 给出，代码里找不到任何内存去重结构。
- **反证过程**：
  1. 假设「去重其实在内存里」→ 扫 `http/`、`agent/`、`queue/` 的 `new Set/Map`：命中的全是单次调用内的去重（skill 目录、队列定义自检、endpoint 登记），没有任何模块级容器跨越两次请求存活。推翻假设。
  2. 假设「唯一约束只写在 schema.ts 里、迁移没有」→ 直接读迁移文件：`0000_init.sql:161-162`（PK）、`:187`（unique index）、`0006_agent.sql:42`、`0011_v21.sql:37` 都在 SQL 里；`schema.ts` 的 `uniqueIndex('run_events_run_id_cursor_uidx')`（`apps/server/src/db/schema.ts:310`）只是同源声明。
  3. 假设「去重发生在入队之后，先跑了再说」→ 读执行顺序：第 3/4 步（`:1100`–`:1122`）→ 第 6 步建任务（`:1350`）→ 第 7 步入队（`:1404`）。重复投递在第 4 步就 return，永远到不了入队。
  4. 假设「同一内容换个 delivery id 就能重复处理」→ 这是需求另一条（AC-19/AC-20 内容去重）的口径，本单元不看；但顺带确认第二层存在：`tasks.idempotency_key` 由 `issueVersionHash` 参与（`apps/server/src/http/webhook.ts:651`），同版本事件重投会撞唯一索引。
  5. 残余：`skipDeliveryDedup: true` 的 replay 路径（`apps/server/src/http/webhook.ts:1812`–`apps/server/src/http/webhook.ts:1820`）会跳过投递级去重，但它是人工 CLI 且强制 dry-run，不构成「重复投递自动重跑」。

### NFR-4（安全：签名校验；模型凭证不进执行环境；不授予合并权）
- **状态**：已实现
- **证据**：
  - `apps/server/src/http/webhook.ts:1064`–`apps/server/src/http/webhook.ts:1096` — live 投递：缺 `X-Hub-Signature-256` → 401；验签抛错按失败处理（`:1080`–`apps/server/src/http/webhook.ts:1083`，无宽容模式）；失败仍落 `webhook_deliveries(signature_valid=false)` 但不入队。
  - `apps/server/src/sandbox/hostconfig.ts:164`–`apps/server/src/sandbox/hostconfig.ts:170` — 容器 `Env` 只有 `NODE_OPTIONS` / `HOME` / `CI` / `TERM`，注释即实现；`sandbox/docker.ts:144`、`sandbox/docker.ts:186` 只转发这份 `spec.Env` 与 exec 计划里的 env。
  - `apps/server/src/sandbox/exec-plan.ts:53`–`apps/server/src/sandbox/exec-plan.ts:54`、`:88` — `docker exec -e` 只带 `PI_CMD_ID=<uuid>`（兜底 kill 用），不透传任何客户端 env。
  - `apps/server/src/sandbox/protocol.ts:34`–`apps/server/src/sandbox/protocol.ts:54` — 请求帧白名单 `['argv','cwd','clientPid']`，多一个键就 `BAD_REQUEST`（不是忽略未知键）。
  - `apps/server/src/app/model-env.ts:36`–`apps/server/src/app/model-env.ts:52` 产出模型变量，唯一消费点是 `apps/server/src/app/compose.ts:601` 的 `extraEnv: hostModelEnv(config)`——即给**宿主** pi-host 子进程（`runtime/host-supervisor.ts:484`–`apps/server/src/runtime/host-supervisor.ts:504`），不进容器。
  - `apps/server/src/github/types.ts:109`–`apps/server/src/github/types.ts:162` — 写面 `GithubWriteApi` 只有 list/create comment、add/remove label、create/close issue、update comment、getIssue，**没有 merge**；`apps/server/src/github/types.ts:113` 明写「这一层刻意不含 merge」。兜底扫描：`apps/server/test/no-merge.test.ts:33`–`:39` 对 `apps/server/src`、`apps/panel/src`、`packages/*/src` 扫 `.merge(` / `pulls.merge` / `mergePullRequest` / `merge_pull_request` 四个模式；我按同样模式手工搜过 `src`，只命中 `git/branch-cleanup.ts` 的 `merge-base --is-ancestor`（本地 git，不是 GitHub 合并）与 `queries/issues.ts:965` 的 SQL CTE 别名 `merged`。
- **缺口**：无（「仓库权限最小化」不由代码决定，见核查边界）
- **判定依据**：「签名校验」有拒绝路径（缺签名/验签失败/抛错三条都 401）而非「有开关」；「模型凭证不进执行环境」在两个边界上同时成立：容器 env 是固定四项、exec 通道白名单不允许 env，而模型 key 的去处是宿主 pi-host（AGENTS.md §10 允许的范围）；「不授予合并权」由写面类型定义（无方法）+ 源码扫描兜底，属于能力层缺失，不是「有代码但没调用」。
- **反证过程**：
  1. 假设「验签可以绕过」→ 找入口：`registerWebhookRoute`（`apps/server/src/http/webhook.ts:1923`）不读 body 里的 signature，只读 header；`source==='live'` 时 `signature === null` 直接 401（`:1065`–`:1070`）；`verify` 抛错被当作 false（`:1080`–`:1083`）。唯一的免验签路径是 `source==='replay'`（人工 CLI，强制 dry-run，`:1819`）。无绕过。
  2. 假设「模型 key 进了容器」→ 沿着 key 走：`config.model.apiKey` → `hostModelEnv` → `compose.ts:601 extraEnv` → `HostSupervisor.#buildCommand`（`host-supervisor.ts:493`）→ `spawn(node)` 的 env。容器侧 `buildContainerCreateOptions` 的 Env 是硬编码四项、没有透传 `process.env` 的代码。推翻「进容器」。反方向还要看 exec：`parseExecRequest` 白名单拒绝 `env` 字段，`buildExecPlan` 只塞 `PI_CMD_ID`。两条路都堵住。
  3. 假设「有 merge 能力只是没被调用」→ 不看测试先看能力面：`GithubWriteApi` 的方法集里没有 merge；`GithubClient.request` 是泛型（理论上可 POST 任意 route），所以再加一层源码扫描：`src` 下 `.merge(` 只在 `git/branch-cleanup.ts:128` 的 `git merge-base --is-ancestor` 出现，`mergePullRequest` / `merge_pull_request` 零命中。能力与调用都不存在。
  4. 假设「GitHub token 在容器里」→ `git/push.ts:30` 的 `PI_BOT_GIT_TOKEN` 只经 `GIT_ASKPASS`（`git/push.ts:62`–`apps/server/src/git/push.ts:87`）给宿主 git 进程，脚本只回显环境变量、不落 token 到磁盘。容器只拿到挂在 jobDir 上的工作区，而 `.pi-bot/` 脚手架在使用后立即删除（`git/push.ts:98`–`apps/server/src/git/push.ts:104` 在删除失败时直接抛错）。
  5. 反例记录（不属本节但与本条相关）：`runtime/host-supervisor.ts:487`–`apps/server/src/runtime/host-supervisor.ts:492` 把**整个 `process.env`** 交给 pi-host，与 `app/model-env.ts:8` 的自述「只导出这一组变量（白名单）」相反。pi-host 是可信侧、不是执行环境，因此不违反本条需求，但 webhook secret / App 私钥路径也会一并进子进程——见额外问题。

### NFR-5（可维护：改配置不改代码；触发规则、模板、闸门都在配置层）
- **状态**：已实现
- **证据**：
  - `apps/server/src/config/repo-config.ts:255` — `readRepoPolicy()` 每次调用都查 `repos` 行；调用点是**每次投递**（`apps/server/src/http/webhook.ts:1164`）与**每个任务开跑前**（`apps/server/src/app/compose.ts:1513`–`apps/server/src/app/compose.ts:1516`），无进程内缓存。
  - `apps/server/src/config/v21-settings.ts:105`–`apps/server/src/config/v21-settings.ts:119` — 触发规则（`triggers.events[event].enabled` / `prompt` / `only_body_changed` / `labels`）全部读自 settings，判定发生在 `apps/server/src/trigger/decide.ts:226`–`apps/server/src/trigger/decide.ts:258`（每次投递）。
  - `apps/server/src/trigger/decide.ts:173`–`apps/server/src/trigger/decide.ts:200` — 四个评论闸门（ignore_bot / allow_closed / require_mention / require_role）读自 `resolveCommentGates(settings)`，无硬编码。
  - `apps/server/src/http/api/index.ts:319`–`apps/server/src/http/api/index.ts:331` — 配置写面 `PUT /api/repos/:owner/:name/settings`，写前校验（`config/repo-config.ts:449` 起的 `updateRepoSettings`）；写入后下一条事件即读到新值（因为上一条证据：无缓存）。
- **缺口**：无（`settings` 里有 4 个死字段，见额外问题）
- **判定依据**：需求列举的三类都在配置层且热生效：触发规则与模板由 `resolveEventTrigger()` 逐次读库（含 `prompt` 为空回落到内置模板 `trigger/decide.ts:255`–`:258`），闸门由 `resolveCommentGates()` 逐次读库；配置写面存在且写前校验，不需要改代码也不需要重建会话。
- **反证过程**：
  1. 假设「某些配置改了要重启」→ 逐个追消费点：settings 从 `repos.settings` 每次读（`repo-config.ts:255` → `webhook.ts:1164` / `compose.ts:1514`）；仓库级并发、排队阈值（`queue/queue-gate.ts:176`–`:190`）也是每次读库。三处都没有缓存层。推翻「要重启」。
  2. 假设「有缓存藏在中间层」→ 找唯一的缓存：`prompt/repo-issues.ts` 的 5 分钟缓存只缓存 **issue 列表内容**，不缓存 settings；`skills/assemble.ts` 每轮重新装配。不构成配置缓存。
  3. 真的需要重启的确实是另一类（部署级 env，不是需求列举的三类）：`compose.ts:884`（webhook secret 在装配时固化）、`:959`（deployment aliases）、`:961`（`PI_BOT_FREE_MENTION`）、`:601`（模型端点/key）。这些是进程启动参数，改它们要重启进程——但改的是配置不是代码，且不在需求的「触发规则/模板/闸门」范围内。
  4. 反向查「既然号称都在配置层，有没有配置项写了没用」→ 命中 4 个：`settings.agent.limits.concurrency` / `daily_quota` / `turn_timeout_minutes` / `data_retention_days` 都在 `config/v21-settings.ts:212`–`:218` 被读出，但全仓无消费方（`grep turn_timeout_minutes` 只有这一行；`daily_quota` 只到 `resolveAgentExecution` 就断了）。这些字段不属「触发规则/模板/闸门」，故不改本条状态，但它们是「改了配置没效果」的真实样本——记入额外问题。
  5. 再确认配置改动对**进行中的轮次**不生效（需求 AC-12 期望的行为）：`compose.ts:1514` 在任务开跑前读一次，运行中不重读，行为符合需求但本单元不判。

### NFR-6（可追溯：任一 issue 的处理过程可回放；对话 + 工具 + 用量三线齐全）
- **状态**：部分实现
- **证据**：
  - 对话线（有）：`apps/server/src/queries/issues.ts:755` 起的 `queryIssueSession()` 把 `runs` + `run_events` + `actions` 拼成轮次；消息原文落 `agent_messages.comment_body`（`apps/server/src/db/schema.ts:706` 起的表定义，写入 `apps/server/src/http/webhook-v21.ts:1029`–`apps/server/src/http/webhook-v21.ts:1037`）。
  - 工具线（有）：`apps/server/src/queries/issues.ts:922`–`apps/server/src/queries/issues.ts:1004` — 按 `toolCallId` 归并 `item.started` / `tool.progress` / `item.completed`，输出名称 + 入参摘要 + `ok`；契约字段 `packages/contract/src/api.ts:908`–`packages/contract/src/api.ts:918`（`name` / `summary` / `at` / `ok`）。原始事件（含工具结果 payload）在任务详情里可查：`apps/server/src/queries/tasks.ts:472`–`apps/server/src/queries/tasks.ts:486`。
  - 用量线（缺 issue 维度）：用量真实数字落 `usage_costs`（`apps/server/src/worker/run-task.ts:1595`–`apps/server/src/worker/run-task.ts:1607` → `apps/server/src/worker/run-store.ts:89`–`apps/server/src/worker/run-store.ts:95`），表里只有 `run_id`（`apps/server/src/db/schema.ts:452` 起）。
  - 出口只有聚合：`apps/server/src/queries/costs.ts:256`–`apps/server/src/queries/costs.ts:284` 返回 total / byRepo / byCommand / byModel / series / topTasks——**没有任何 issue 维度**（`topTasks` 只给 `taskId` + `repo` + `command`）。
  - 任务列表只给成本不给 token：`apps/server/src/queries/tasks.ts:130`（`costUsd` 子查询）、`apps/server/src/queries/tasks.ts:174`（映射），返回体 `packages/contract/src/api.ts:200`（`costUsd` 可空），无 token 字段。
  - issue 会话响应无任何用量字段：`packages/contract/src/api.ts:931`–`packages/contract/src/api.ts:963`（`IssueTurn` 只有 role/text/toolCalls/status/taskId…）、`packages/contract/src/api.ts:1092`–`packages/contract/src/api.ts:1099`（`IssueSessionResponse` = issue + turns）。
  - 面板确实想显示，但字段不存在：`apps/panel/src/routes/issue-detail.tsx:280` → `apps/panel/src/components/issues/contract-extras.ts:103`–`apps/panel/src/components/issues/contract-extras.ts:111` 读 `turn.costUsd` / `turn.durationMs`，注释自己写明「契约**还没**提供这两个字段时返回 null」；`queries/issues.ts` 全文无 `cost` 字样。即 `issue-detail.tsx:362` 的成本永远是 `null`。
- **缺口**：缺「用量」在 issue 维度的出口。具体：① `IssueTurn` / `IssueSessionResponse` 没有任何 token 或成本字段，`queryIssueSession()` 也不 join `usage_costs`；② `/api/costs` 只按 repo/command/model/日/task 聚合，`/api/tasks` 只给任务级 `costUsd`（无 token，且没有 target 过滤），因此「某个 issue 用了多少 token」后台查不到；③ 面板该位置读的字段在契约里不存在，等于这条线在 UI 上也是空的。
- **判定依据**：需求写明三条线都要齐。对话线、工具线都能定位到持久化 + 出口（且工具有名称/入参/成功标志）；用量线只有仓库/命令/模型/任务四个粒度，issue 粒度缺失，且不是「需要运行环境才能确认」的问题——契约与查询代码里根本没有这个字段，属静态可证缺失，故判部分实现。
- **反证过程**：
  1. 假设「issue 维度用量藏在别的地方」→ 在 `queries/issues.ts` 搜 `cost`/`usage`/`token`：0 命中；在契约里搜 `costUsd` 的四个出现点（`api.ts:25/39/89/200`）分别属于 `UsageTotals` / `CostBucket` / `OverviewToday` / `TaskListItem`，都不在 issue 相关 schema 内。推翻「有出口」。
  2. 假设「面板显示的 per-turn 成本就是证据」→ 顺着 `issue-detail.tsx:280` 找到 `readRunCost`，它读 `costUsd` / `durationMs`；但 `IssueTurn` 是 `.strict()`（`api.ts:962`），服务端从不发送这两个字段。面板代码等于在猜未来的契约——UI 上是空的，不是「有出口」。
  3. 假设「task 详情里的 token 能顶替」→ 读 `queries/tasks.ts:344`–`queries/tasks.ts:351`：token 来自 `envelopes.usage`（agent 自己填的信封字段），而 worker 注释明确说「那是 agent 自己填的，实测恒为 0」（`apps/server/src/worker/run-task.ts:1591`），真数在 `usage_costs`。所以任务详情展示的 token 很可能恒为 0，不能当成用量线。
  4. 假设「回放靠 replay 命令就够了」→ `apps/server/src/http/webhook.ts:1801`–`apps/server/src/http/webhook.ts:1821` 的 `replayDelivery()` 是「按 delivery 重放一次（强制 dry-run）」，回答的是「为什么没处理」，不是「这个 issue 处理过程中模型说了什么、调了什么、花了多少」。需求的「可回放」需要三线数据都在，故 replay 不能补位。
  5. 反证#6 的时窗：对话/工具明细依赖 `run_events`，而 `run_events` 有 90 天保留期（`migrations/0000_init.sql` 的 `run_events_created_at_idx` 注释 + `jobs/retention-cleanup.ts` 的口径），90 天后再看同一 issue，对话与工具线会缺行、用量线仍在（`usage_costs` 永久）。这属于 §8 数据需求的既有取舍（对话「按需」），本单元不判冲突，但会让「任一 issue 可回放」在时间上退化为 90 天。

## 本节整体结论
不能判为「已实现」。六条里三条代码可证地完整：规模（PG-only + 项目级并发 2 + 无生效业务限流）、可靠（三层去重全在 PG 约束上）、安全（验签有拒绝路径、容器 env 无凭证、写面无 merge 能力）。两条有实质缺口：响应线的「应答 < 10 秒」没有硬保护——handler 内同步 `await` 一次 GitHub 写（octokit 超时 15 s）与一次可选的 issue 列表 REST 取数，最坏耗时由外部依赖决定；可追溯线的「用量」缺 issue 维度出口，issue 会话契约里连字段都没有，面板读的是不存在的 `costUsd`。可维护线的三项（触发规则/模板/闸门）确实热生效，但有 4 个 settings 字段只读不用，属「改了没效果」的样本，未纳入本条判定。

## 核查边界
- 是否执行了命令：只执行了只读检索——`git rev-parse --short HEAD`（fbfa029，与 `_baseline.txt` 的 `fbfa02983d36d4923c0647f4c18aacd041d83375` 一致）、`Select-String` / `Get-Content` 若干次（用于定位行号与全文扫描）。**未运行** `pnpm -r test` / `pnpm lint` / `pnpm typecheck`，未连 PG、未连 Docker、未调真 GitHub、未调真模型；所有结论均为静态核查，测试文件只作「断言存在」类旁证（`test/no-merge.test.ts`）。
- 未覆盖的条目及原因：
  - 「<100 事件/天」与「应答 < 10 秒」的实际耗时：需要真 PG + 真 GitHub + 压测才能给数字，本节只判「有无硬保证」，未测实际值。
  - 「仓库权限最小化」：GitHub App 的授权清单不在仓库内（`deploy/` 只有 `env.example` / `nftables.conf` / `docker-network.md`，无 App manifest），只能人工在 App 设置页核对；代码侧只能证明「没有 merge 能力」。
  - pg-boss 是否真的按 `localConcurrency=3` 与本进程并发取件：需运行时确认，本节只确认调用形式（`queue/boss.ts:211`）。
  - `usage_costs` 是否每轮都有行：`deps.usage` 在装配处是否注入未逐一确认（`app/compose.ts` 的 usage 端口），若未注入则该轮不记账——需运行时或读装配全文确认，本节未展开。
- 发现的额外问题（不属本节范围，但值得记录）：
  1. **四组配置字段只读不用**：`settings.agent.limits.concurrency` / `daily_quota` / `turn_timeout_minutes` / `data_retention_days` 在 `apps/server/src/config/v21-settings.ts:212`–`apps/server/src/config/v21-settings.ts:218` 被解析，全仓无消费方（只有 `system_prompt` 与 `actions` 被用）。用户改了这些设置不会有任何效果。
  2. **两个死分支/死表**：`apps/server/src/trigger/decide.ts:251` 的 `daily-quota` 分支没有任何写入方（`dailyQuotaExceeded` 全仓从未被置 true）；`quota_counters` 表（`apps/server/src/db/schema.ts:634`–`apps/server/src/db/schema.ts:644`）无任何读路径。
  3. **整个 `process.env` 交给 pi-host**：`apps/server/src/runtime/host-supervisor.ts:487`–`apps/server/src/runtime/host-supervisor.ts:493` 复制 base env 全部键，与 `apps/server/src/app/model-env.ts:8`「只导出这一组变量（白名单），不把整个 process.env 灌给子进程」的自述相反；webhook secret、`PI_BOT_GITHUB_APP_PRIVATE_KEY_PATH` 等也会进该子进程。pi-host 是可信侧，不违反「凭证不进容器」，但白名单意图没有落地。
  4. **面板读未存在的字段**：`apps/panel/src/routes/issue-detail.tsx:280` + `apps/panel/src/components/issues/contract-extras.ts:103`–`:111` 读 `turn.costUsd` / `turn.durationMs`，`IssueTurn`（`packages/contract/src/api.ts:931`–`:963`）无此二字段，注释自承「契约还没提供」。该处成本与耗时永远为空。
  5. **任务详情的 token 可能恒为 0**：`apps/server/src/queries/tasks.ts:344`–`:351` 的 token 取自 `envelopes.usage`，而 `apps/server/src/worker/run-task.ts:1591` 明写信封 `usage` 实测恒为 0，真数在 `usage_costs`；面板 `apps/panel/src/routes/task-detail.tsx:289` 展示的正是信封值。
  6. **`concurrency_per_repo` 上限 8**（`apps/server/src/queue/repo-concurrency.ts:22`）超出需求「2–4」的区间；默认值 2 合规，但上限在需求里没有出处。
