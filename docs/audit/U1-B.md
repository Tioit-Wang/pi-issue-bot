# U1-B 需求实现核查（反证视角）— 需求 §5.1 事件接入（FR-1.1 ~ FR-1.4）

- 需求来源：`C:\Code\NodeProjects\pi-issue-bot\docs\requirements.html` 行 727-754
- 审查对象：`C:\Code\NodeProjects\pi-issue-bot` 工作区**当前状态**（含未提交修改：`apps/server/src/http/webhook.ts`、`webhook-v21.ts`、`server.ts`、`test/http-webhook.test.ts`、`test/http-server.test.ts` 等均处于 `M` 状态）
- 方法：默认假设「未实现」，逐条找无争议代码证据；重点验证并行入口、内存去重、401 提前 return、请求体被提前 JSON 解析、测试只断言 200 这五个怀疑方向
- 说明：本次只读，未运行测试（真 PG 用例需要库）；结论全部基于源码与测试断言的静态核对

---

## FR-1.1 接收 GitHub webhook（单一入口 / 四类事件 / 原始 body / 三个请求头）

**状态：已实现**

**反证过程**

1. 「是否存在两条并行入口，其中一条不验签」→ 穷举 `apps/server/src` 全部路由声明（`scope.post|get` / `app.post|get`）：全仓只有一处 `POST /webhook`（`webhook.ts:1923`）。`webhook-v21.ts` **没有任何** `addContentTypeParser` / `post(` / `reply.status` / `registerWebhookRoute`，它只是被 `webhook.ts` 调用的内部判定/渲染模块（`handleV21Webhook`），不暴露 HTTP 面。否证成立 → 单一入口。
2. 「是否只在测试里 mock 掉验签」→ `test/http-server.test.ts:54/82/97` 用的是 `createOctokitVerifier(SECRET)` 真实现，`sign()` 是 `createHmac('sha256', secret)`（`:39-41`）；`POST /webhook` 三个用例（`:374/:392/:410`）跑在 `makeServer()` 装配的真实例上。`test/http-webhook.test.ts` 走 `handleWebhook` 直调并用注入假 verify（`signature: 'good-signature'`），属于端口注入的单元层，不是「唯一覆盖」。
3. 「请求体是否被中间件提前 JSON.parse」→ raw 解析器在 `registerWebhookRoute` 内部再包一层 `app.register` 作用域（`webhook.ts:1913-1921`，`parseAs: 'buffer'`，`done(null, body)`），只对该作用域内 `/webhook` 生效；`server.ts:164` 只给了 `bodyLimit`，没有全局替换 JSON 解析器。旁证：`http-server.test.ts:374` 用真 HMAC 对**未重排**的字符串验签通过，若 body 被 JSON 解析重序列化，该用例会 401。
4. 「三个请求头是否都读」→ `WEBHOOK_HEADERS`（`webhook.ts:147-151`）声明 delivery/event/signature 三项，路由 handler 逐个读取（`:1930-1941`），缺 delivery/event 直接 401（`:1932-1936`）。
5. 「四类事件是否真的各自走通」→ `issues`（`:618-666`）、`issue_comment`（`:551-616`）、`pull_request`（`webhook-v21.ts:85-89` → `:172-174 decidePullRequest()` → `:988-993` 回 200 ignored）、`installation` 系列（`webhook.ts:827-839 INSTALLATION_EVENTS` + `:876-954 applyInstallationEvent`，含 `installation.created/deleted/suspend/unsuspend`、`installation_repositories.added/removed`）。四类均有实现，且都有真库用例（`http-webhook.test.ts:585/616/650/670/690/716/749`、`:263`）。

**证据（文件:行号）**

- 唯一入口：`apps/server/src/http/webhook.ts:1923`（`scope.post('/webhook'`），由 `apps/server/src/http/server.ts:266` 注册
- raw body：`apps/server/src/http/webhook.ts:1913-1921`；验签用的是原始串 `:1074-1079`（`rawBody: input.rawBody`）
- 三个请求头：`apps/server/src/http/webhook.ts:147-151`、`:1930-1941`
- 事件面：`apps/server/src/http/webhook.ts:551-666`、`:827-954`；`apps/server/src/http/webhook-v21.ts:85-108`、`:161-177`
- 测试：`apps/server/test/http-server.test.ts:374-423`；`apps/server/test/http-webhook.test.ts:263-285`、`:585-761`

**缺口**

- 解析顺序轻微倒挂：`JSON.parse(input.rawBody)` 在验签**之前**（`webhook.ts:1051-1056`），之后才 verify（`:1074`）。原始 body 没被丢弃、HMAC 仍对原始串校验，所以不触发需求担心的「签名无法校验」；但后果是**未认证的请求可以让解析器先跑**，且非法 JSON + 错签名返回 400 而非 401（鉴权与解析的优先级与需求「先验签」的读法不一致）。
- raw body 实际是 `Buffer.toString('utf8')` 后的字符串（`webhook.ts:1924-1928`），不是字节级原文；对非 UTF-8 载荷理论上会改变签名输入。
- 契约里 `webhookHeadersSchema`（`packages/contract/src/api.ts:830-837`，含 `^sha256=[0-9a-f]{64}$` 正则）**未被任何代码引用**，也没进 `schemas.ts` 注册表 —— 头部格式的运行时校验实际上只由验签器间接兜住，契约里那份声明是死代码。

---

## FR-1.2 签名校验（HMAC-SHA256 / 失败 401 / 失败仍落库留痕）

**状态：部分实现**

**反证过程**

1. 「算法是不是 HMAC-SHA256」→ `createOctokitVerifier` 用 `@octokit/webhooks` 的 `webhooks.verify(rawBody, signature)`（`webhook.ts:1826-1838`），该实现是 `sha256=` 前缀 + `createHmac('sha256')` + `timingSafeEqual`；没有 sha1 回落，也没有自定义比较。
2. 「secret 能否为空 = 变相不验签」→ `createOctokitVerifier` 对空 secret 直接 throw（`:1827-1829`）；`config/env.ts:126-129` 缺 `PI_BOT_WEBHOOK_SECRET` 启动即失败（`readString` 把空串也归一成 null，`env.ts:readString`）；全仓 grep 无 `SKIP_VERIFY` / `skipVerify` / `verify: async () => true` 之类的旁路（`verify: async () => true` 只出现在 `/healthz`、`openapi` 两个不相关装配里：`http-server.test.ts:154`、`:447`）。
3. 「签名失败是否 return 401 但提前 return 跳过落库」→ **不成立**：失败分支先 `INSERT webhook_deliveries ... signature_valid=false`（`webhook.ts:1084-1093`），再 `return finish(401, ...)`（`:1095`）。补充：`verify` 抛错也按失败处理（`:1080-1083`），同样落库。用例 `http-webhook.test.ts:197-221` 真库断言 `signature_valid=false`、行存在、`tasks` 0 行、入队 0 次。
4. 「缺签名头这条路径是否也落库」→ **不落库**：`webhook.ts:1064-1070` 直接 `return finish(401, ...)`，没有任何 INSERT；并且 `http-webhook.test.ts:223-235` 把它固化成了断言（`expect(await countRows('webhook_deliveries')).toBe(0)`）。这是需求「校验失败返回 401，但**仍要落库留痕**（便于排查配置错误）」的直接缺口 —— 缺签名头恰恰是最典型的「secret 配错 / 反向代理丢了头」场景。
5. 「重复投递里签名先好后坏，留痕是否失真」→ 失败分支的 INSERT 带 `ON CONFLICT (delivery_id) DO NOTHING`（`:95-98`），同一 delivery 已存在 `signature_valid=true` 的行时，后来的坏签名**不会**被记下来。
6. 「落库失败会不会把 401 变成 500」→ 会：失败分支的 `await deps.db.query(...)` 没有 try/catch（`:1086-1093`），DB 不可用时异常冒到路由（`webhook.ts:1938-1945` 无 try/catch），最终由 `errors.ts` 映射成 500。

**证据（文件:行号）**

- 验签实现与 fail-closed：`apps/server/src/http/webhook.ts:1826-1838`、`apps/server/src/config/env.ts:126-129`
- 失败即落库 + 401：`apps/server/src/http/webhook.ts:1084-1096`；SQL `:95-98`
- 缺头即 401 不落库：`apps/server/src/http/webhook.ts:1064-1070`；测试 `apps/server/test/http-webhook.test.ts:223-235`
- 用例（真库）：`apps/server/test/http-webhook.test.ts:197-221`、`apps/server/test/http-server.test.ts:392-408`

**缺口**

- 缺 `X-Hub-Signature-256` 头时返回 401 但**不落任何审计行**（`webhook.ts:1066-1070`，并被用例 `http-webhook.test.ts:223-235` 固化为期望）。需求文义要求「失败仍要落库留痕」，此处 delivery id 是已知的，完全可以落一行 `signature_valid=false`。
- 路由层缺 `X-GitHub-Delivery` / `X-GitHub-Event` 时同样只 401 不落库（`webhook.ts:1932-1936`）——这个可辩解（缺 delivery id 无主键可落），但与上一条合起来意味着「非 HMAC 失败类的 401」全都没有痕迹，而需求正文里排查配置错误正是靠这些痕迹。
- 同日 delivery 先成功后失败的场景不会刷新 `signature_valid`（`ON CONFLICT DO NOTHING`），审计会有「看起来一直正常」的假象。
- 失败分支的 INSERT 未包裹异常处理，DB 故障时 401 会退化成 500。

---

## FR-1.3 投递去重（投递 ID 唯一键 / 重投返回成功不重复处理 / 必须在持久层）

**状态：已实现**

**反证过程**

1. 「是否只用了内存 Map/Set」→ 对 `apps/server/src` 全量 grep `new Set<string>()` / `new Map<string, boolean>` / `seenDeliver` / `deliveryCache`：命中项全是去重以外用途（技能目录、标签、markup、run-task 结果等），webhook 管线与 `queue/` 里**没有**投递级内存去重表。`webhook.ts:18-19` 的头部注释也把「幂等只在数据库」写成不可让渡的约束。
2. 「持久层唯一键是否存在」→ `webhook_deliveries.delivery_id` 是**主键**（`src/db/schema.ts`：`deliveryId: text('delivery_id').primaryKey()`；`migrations/0000_init.sql:162`：`"delivery_id" text PRIMARY KEY NOT NULL`），INSERT 走 `ON CONFLICT ("delivery_id") DO NOTHING` + `RETURNING`（`webhook.ts:95-98`），靠 `rowCount === 0` 判重投（`:1109-1121`）。重启安全性由 PK 保证，与进程内状态无关。
3. 「重复投递是否返回成功」→ `finish(200, accepted({ action: 'duplicate', duplicate: true, taskId: null }))`（`:1117`），且 `trace.skipDecision = true` 避免覆盖首次判定。
4. 「是否只有任务级去重而没有投递级」→ 两层都在：投递级如上，任务级另有 `tasks_idempotency_key_uidx` 唯一索引 + `insertTask ... ON CONFLICT DO NOTHING`（`webhook.ts:116-119`、`schema.ts`）。
5. 「有没有绕过去重的入口」→ `skipDeliveryDedup` 只在 `replayDelivery()`（`:1819`）里置 true，那是 CLI `replay` 的内部通道，HTTP 路由不传该字段（`:1938-1944`），无法从外部触发。
6. 「20 次重投是否真的只处理一次」→ 真库用例 `http-webhook.test.ts:237-261`：投递行 1、任务行 1、`sends` 1 次，第 1 次 `enqueued`、其余 19 次 `duplicate: true` —— 断言的是可观察事实，不是「200 就算过」。

**证据（文件:行号）**

- 投递级 INSERT/判重：`apps/server/src/http/webhook.ts:95-101`、`:1100-1122`
- 持久层唯一键：`apps/server/src/db/schema.ts`（`webhook_deliveries.deliveryId ... primaryKey()`）、`migrations/0000_init.sql:162`
- 任务级去重：`apps/server/src/http/webhook.ts:116-119`
- 用例：`apps/server/test/http-webhook.test.ts:237-261`

**缺口**

- 语义边界：同一 delivery 先验签失败、后验签通过时**会**继续处理（`webhook.ts:1109-1121` 的 `signature_valid` 翻正分支）。这是有意的修正逻辑，但与需求字面「同一投递 ID 一律不重复处理」不同；若被当作严格判据会算差异。
- 无「投递 ID 长度/格式」上限校验（主键是 text，`webhookHeadersSchema` 里的 `max(128)` 未接线），超长 delivery id 会直接落库——只影响审计表体积，不影响去重正确性。

---

## FR-1.4 应答时限（10 秒内 2xx，实际处理异步）

**状态：已实现**

**反证过程**

1. 「handler 里是否同步跑了模型/turn」→ 没有。触发路径只做：落库 → 读 `repos` → 判定 → 落 `agent_messages`/`tasks` → `enqueue()` 到 pg-boss（`webhook.ts:1402-1410`），真正的 turn 由 worker 消费 `run-task`。`submitAgentMessage` / `handleV21Webhook` 里的 `dispatchAgent` 也只建任务 + 入队（`agent/dispatcher.ts:85-134`），`send()` 后即返回。
2. 「有没有 handler 内阻塞的长任务」→ `renderTemplateAsync` 只在模板含 `{{repo.issues}}` 时打 GitHub，且上限固定：`REPO_ISSUES_MAX_PAGES = 2`、`REPO_ISSUES_PER_PAGE = 100`、TTL 5 分钟缓存（`prompt/repo-issues.ts:38-47`、`:109-123`）；回执只有一次 reaction REST 调用（`webhook.ts:1420-1430`），失败只 warn。
3. 「超时有没有可观测证据」→ `finish()` 在 `elapsedMs >= 2000` 时打 warn（`:1040-1047`），超时口径是自定的 2s 目标，比需求的 10s 更严。
4. 「用例是否只断言了 200」→ `http-webhook.test.ts:287-304` 同时断言：`status 200`、`action: 'enqueued'`、调用顺序 `['enqueue', 'reaction']`（reaction 在入队之后、handler 返回之前）、`elapsedMs < 2000`；`:237-261` 的 20 次重投也断言了 `sends` 次数——不是「只测 200」。
5. 「是否有点上 202 + 后台处理却仍在请求里 await 全部工作」→ 应答体是 `{status:'accepted', action}`，`action` 枚举含 `enqueued|duplicate|ignored|unauthorized|paused`（`packages/contract/src/api.ts` webhookAcceptedResponseSchema），语义上「已受理」而非「已完成」。

**证据（文件:行号）**

- 入队即返回：`apps/server/src/http/webhook.ts:1402-1433`
- 回执单次往返：`apps/server/src/http/webhook.ts:1420-1430`
- 有界外部调用：`apps/server/src/prompt/repo-issues.ts:38-47`、`:109-123`
- 耗时观测：`apps/server/src/http/webhook.ts:1040-1047`
- 用例：`apps/server/test/http-webhook.test.ts:287-304`

**缺口**

- 没有任何**硬性**时限保护：没有 `AbortController`/超时竞速，handler 全程串行 await（DB 若干次 + 可能 1~2 次 GitHub + 1 次 reaction）。慢依赖叠加时唯一后果是一条 warn 日志，不会提前回 2xx。
- 没有任何用例断言「端到端 HTTP 响应 < 10s」或「重依赖变慢时仍按时返回」；`elapsedMs < 2000` 是在假 ack/假 enqueue 下测的，不能证明真实网络下的时限。
- `elapsedMs` 在 `submitPlanTask` 的重复/成功分支被硬编码成 `0`（`webhook.ts:1395`、`:1415`、`:1433`），这些分支的耗时上限完全不可观测（外部只有 `onResponse` 的 HTTP 直方图兜底）。

---

## 本节整体结论

四条需求的主干都真实落地，且不是靠测试桩撑起来的：`/webhook` 是全仓**唯一**的 GitHub 投递入口（`webhook-v21.ts` 无 HTTP 面，不存在「第二条不验签的分支」）；验签是 `@octokit/webhooks` 的 HMAC-SHA256 对**原始串**校验，secret 缺失启动即失败、无任何跳过开关；去重落在 `webhook_deliveries.delivery_id` 主键 + `ON CONFLICT DO NOTHING`，全仓无投递级内存去重表；处理异步经 pg-boss/`run-task`，handler 只做入队与一次回执。测试也基本不是「只断言 200」：验签失败路径真库断言 `signature_valid=false` 且 0 任务，20 次重投断言「1 行投递 / 1 行任务 / 1 次入队」，另有用例用真 HMAC 证明 raw body 没被 JSON 解析器吃掉。

真正站得住的缺口集中在三处，且都不大：**（1）FR-1.2 的留痕不完整** —— 缺 `X-Hub-Signature-256` 头时 return 401 却不落库，而这条路径正被 `http-webhook.test.ts:223-235` 固化成期望，与需求「校验失败仍要落库留痕」正面冲突（HMAC 比对失败那条路径是合规的）；（2）FR-1.1 的顺序倒挂 —— `JSON.parse` 在验签之前，原始串没丢所以不影响签名正确性，但未认证请求能先触发解析，且非法 JSON + 错签名返回 400 而非 401；（3）FR-1.4 无硬性时限保护、也无端到端时限用例，慢依赖只能靠一条 2s warn 日志被人看见。

另有两条值得记在账上但不构成需求失败：契约里的 `webhookHeadersSchema`（含 sha256 格式正则）完全未被引用，头部格式校验实际只由验签器间接兜住；同 delivery 先成功后坏签名时 `signature_valid` 不会被翻成 false，审计视图存在假象。
