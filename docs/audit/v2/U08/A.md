# U08 5.1 事件接入 · A

> 核查范围：docs/requirements.html 行 727-754
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| FR-1.1 接收 GitHub webhook | 已实现 | — |
| FR-1.2 签名校验 | 部分实现 | 缺 `X-Hub-Signature-256` 的 401 不落库（验签失败落库、缺头不落库） |
| FR-1.3 投递去重 | 已实现 | — |
| FR-1.4 应答时限 | 部分实现 | 无任何 10s 强制点；handler 内 await 的 GitHub reaction 超时为 15s（>10s） |

## 逐条

### FR-1.1
- **状态**：已实现
- **证据**：
  - 单一入口：`apps/server/src/http/server.ts:266` — 唯一的 `registerWebhookRoute(...)` 调用；`apps/server/src/http/webhook.ts:1923` — `scope.post('/webhook', ...)`。全仓无第二个 webhook 路由注册点（`/webhook-v21` 之类不存在；`webhook-v21.ts` 只被 `webhook.ts:78-86` 以函数方式 import）。
  - 原始 body：`apps/server/src/http/webhook.ts:1914-1921` — 在**封装作用域**里 `scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit }, (_request, body, done) => done(null, body))`，注释「原样交给 handler：HMAC 必须对原始字节验」；`webhook.ts:1924-1928` — `Buffer.isBuffer(request.body) ? request.body.toString('utf8') : ...` 取出原始字符串。全实例的中间件只有 `server.ts:225-251` 的 onRequest/onResponse 计时与日志，无 preParsing/JSON 解析；`server.ts:159-165` 的 `Fastify({...})` 未改 content type parser，默认 JSON 解析器在 `/webhook` 作用域内被上面的 buffer 解析器覆盖。
  - 先取原始字节再解析：`webhook.ts:1050-1052` — `JSON.parse(input.rawBody)` 是**在**拿到 `input.rawBody`（1924-1928）之后，且验签用的是同一个 `input.rawBody`（`webhook.ts:1077`）。
  - 三个请求头：`webhook.ts:147-151` — `WEBHOOK_HEADERS = { delivery: 'x-github-delivery', event: 'x-github-event', signature: 'x-hub-signature-256' }`；读取点 `webhook.ts:1930-1931`（delivery/event）、`webhook.ts:1941`（signature）。
  - 四类事件：
    - `issues`：`webhook.ts:618`（`if (input.event === 'issues')`）、`webhook-v21.ts:93-105`（opened/edited/labeled/closed → EventKey）
    - `issue_comment`：`webhook.ts:551`、`webhook-v21.ts:90-92`
    - `pull_request`：`webhook-v21.ts:86-88` — `event.startsWith('pull_request')` → `'pull_request.*'`；`webhook-v21.ts:172-174` → `decidePullRequest()`（按「未触发」留痕），与需求行 573「收到后按未触发处理并留痕」一致
    - `installation` 系列：`webhook.ts:827-830` — `INSTALLATION_EVENTS = { installation: ['created','deleted','suspend','unsuspend'], installation_repositories: ['added','removed'] }`；判定 `webhook.ts:833-839`，执行 `webhook.ts:1127-1139`
- **缺口**：无
- **判定依据**：四个子条件各自有可定位的实现路径且都在实际调用链上（`server.ts:266` → `webhook.ts:1907` → `handleWebhook` → `runWebhookPipeline`）。「不先 JSON 解析」不只是注释：解析器显式 `parseAs: 'buffer'`，且 `test/http-server.test.ts:374-390` 用真 `@octokit/webhooks` 对 inject 的原始 body 验签拿到 200，能反证「body 被 JSON parser 改写过就会 401」。

### FR-1.2
- **状态**：部分实现
- **证据**：
  - 算法：`apps/server/src/http/webhook.ts:1826-1838` — `createOctokitVerifier(secret)` 用 `new Webhooks({ secret })` + `webhooks.verify(input.rawBody, input.signature)`（HMAC-SHA256）；空 secret 直接抛（`webhook.ts:1827-1829`）。
  - 生产装配：`apps/server/src/app/compose.ts:884` — `overrides.verify ?? createOctokitVerifier(config.webhook.secret)`，`compose.ts:955` 注入 webhook deps。
  - 验签失败 → 401 且**落库**：`webhook.ts:1084-1096` — `if (!valid)` 先 `insertDelivery`（`webhook.ts:1086-1093`，`signature_valid=false`）再 `finish(401, ...)`；落库语句 `webhook.ts:95-98`。
  - 缺少签名头 → 401 且**不落库**：`webhook.ts:1066-1069` — `if (signature === null) { log.warn(...); return finish(401, ...) }`，这条分支前面没有任何 `insertDelivery`。
  - 缺 delivery / event 头 → 401 且不落库：`webhook.ts:1932-1936`（路由层，早于 `handleWebhook`）。
  - 测试口径：`apps/server/test/http-webhook.test.ts:197-221` 断言验签失败后 `webhook_deliveries` 有 1 行且 `signature_valid=false`、`tasks` 0 行；`apps/server/test/http-webhook.test.ts:223-235` 标题即「缺签名头：401 且不写任何行」，并显式 `expect(await countRows('webhook_deliveries')).toBe(0)`。
- **缺口**：需求「校验失败返回 401，但**仍要落库留痕**」在「缺 `X-Hub-Signature-256`」这一种失败上不成立——代码与测试都把「不写任何行」当成期望行为（`webhook.ts:1066-1069` + `http-webhook.test.ts:234`）。影响：secret 配错、反向代理丢掉签名头的现场在 `webhook_deliveries` 里查不到，只能翻日志，而这条需求的存在理由正是「便于排查配置错误」。签名不匹配这一种失败已满足。
- **判定依据**：主体（HMAC-SHA256 + 401 + 失败落库）全在，但需求明写的子条件「失败仍要落库」只在「签名不匹配」时成立，缺头这一分支代码与测试都明确不落库 → 按口径只能是**部分实现**并点名该子条件。附带口径问题：`delivery_id` 是主键且 NOT NULL（`migrations/0000_init.sql:162`），「缺 delivery 头」在物理上无法按该键落库，属可接受的约束性缺失；「缺签名头」有 delivery id 却仍不落库，不属此列。

### FR-1.3
- **状态**：已实现
- **证据**：
  - 持久层唯一键：`migrations/0000_init.sql:161-168` — `CREATE TABLE "webhook_deliveries" ( "delivery_id" text PRIMARY KEY NOT NULL, ... )`；ORM 侧 `apps/server/src/db/schema.ts:92` — `deliveryId: text('delivery_id').primaryKey()`（注释「主幂等键」）。
  - 去重执行点：`apps/server/src/http/webhook.ts:95-98` — `INSERT INTO "webhook_deliveries" ... ON CONFLICT ("delivery_id") DO NOTHING RETURNING "delivery_id"`；调用与判定 `webhook.ts:1100-1121` — `rowCount === 0` 时读 `signature_valid`，为 true 则 200 `duplicate`（`webhook.ts:1113-1117`）。
  - 顺序：去重（1099-1122）在安装事件（1127）、暂停（1142）、建任务（1347）之前，重复投递不会走到任何副作用分支。
  - 无内存去重：去重判定只有一个来源（上面那条 SQL 的 `rowCount`），`webhook.ts` 里不存在 delivery 级 `Set`/`Map`。
  - 测试：`apps/server/test/http-webhook.test.ts:237-261` — 同一 delivery 连投 20 次，断言 `webhook_deliveries` 1 行、`tasks` 1 行、`h.sends` 1 次、后 19 次 `duplicate:true`。
- **缺口**：无
- **判定依据**：唯一约束在迁移里（主键），不在应用层判断；命中后直接 200（GitHub 重投是常态）；「不能只在内存」由「唯一键是 DB 主键 + 判定靠 INSERT 的 rowCount」直接满足。测试断言的是行数与入队次数这种可观察事实，不是只看状态码。

### FR-1.4
- **状态**：部分实现
- **证据**：
  - 异步主体：`apps/server/src/http/webhook.ts:1404` — `await deps.enqueue({ taskId, ... })` 把 `run-task` 投进 pg-boss（`apps/server/src/app/compose.ts:916-925` `queue.send(QUEUE.runTask, ...)`）；真正的 agent turn 由 worker 跑，不在请求内。
  - handler 内同步做完的事：`webhook.ts:1086-1093`（投递落库）、`webhook.ts:1164`（读仓库策略）、`webhook.ts:1350-1365`（建任务）、`webhook.ts:1404`（入队）、`webhook.ts:1421-1425`（`await` 打 GitHub eyes reaction）、`webhook.ts:1433` 返回 200；v2.1 路径同样 `await insertMessage`（`webhook-v21.ts:1029-1037`）、`await dispatchAgent`（`webhook-v21.ts:1049`）、`await addEyesReaction`（`webhook-v21.ts:1059-1063`）。
  - 无 10s 强制点：唯一与时限相关的是 `webhook.ts:1042-1045` — `if (elapsedMs >= 2000) log.warn(...)`，只记日志，既不中断也不降级；全仓 `handleWebhook`/路由层没有超时、`reply.raw` 提前应答或 deadline 参数。
  - 单点超时已超预算：`apps/server/src/github/octokit.ts:114` — `ctorOptions['request'] = { timeout: options.requestTimeoutMs ?? 15_000 }`；webhook 的回执客户端由 `apps/server/src/app/compose.ts:885-889` 用默认参数构造（`github-auth.ts:81/89/101` 的 `createGithubClient` 都不传 `requestTimeoutMs`）。
  - 测试：`apps/server/test/http-webhook.test.ts:287-304` — 断言 `h.events` 顺序为 `['enqueue','reaction']`、`result.elapsedMs < 2000`；这是注入假件下的顺序与本地耗时，不构成「10s 上限」的验证。
- **缺口**：需求写的是硬时限「必须在 10 秒内返回 2xx」，代码没有任何强制机制：handler 内 `await` 的 GitHub reaction 走 15s 超时（`octokit.ts:114`），一次慢响应就可能越过 10s 而仍被当成成功返回；超时后没有任何自限或提前 2xx 的兜底。影响：正是需求点名的后果——超 10s 会被 GitHub 判失败并重投，而重投在此处只靠 `webhook_deliveries` 主键挡住副作用，放大的是请求与并发压力。异步性（实际处理进队列）这一子条件已满足。
- **判定依据**：两个子条件里「实际处理异步进行」有清晰路径（`webhook.ts:1404` + `compose.ts:916-925`），但「必须 10 秒内返回」既无强制点，又与 handler 内唯一的外部网络调用超时（15s）矛盾；按口径属主体在、明确子条件缺失 → **部分实现**，并点名缺失项。

## 本节整体结论
§5.1 的主链路是真实接通的：单一 `POST /webhook`、原始字节验签（`parseAs: 'buffer'` 且验签用 rawBody）、数据库主键级投递去重、任务入队后立即应答，都不是「有字段没消费方」的空壳。四类事件里 `pull_request` 按需求行 573 的口径「接收并留痕、不处理」，不算缺口。两处不能算「已实现」：缺签名头的 401 不落库（代码与测试都把不落库当期望），以及 10s 应答没有任何强制点、handler 内 await 的 reaction 超时反而大于预算。因此本节不能整体判为「已实现」。

## 核查边界
- 是否执行了命令：仅执行了只读的 `git rev-parse HEAD` / `git status --short`（HEAD = fbfa02983d36d4923c0647f4c18aacd041d83375，与 `_baseline.txt` 一致）与若干 `Select-String`/文件读取；**未执行测试**（`apps/server/test/http-webhook.test.ts` 依赖真 PostgreSQL，`openTestDb()`），故对测试只声明「存在且断言具体」，不声明「跑过且绿」。
- 未覆盖的条目及原因：无（FR-1.1 ~ FR-1.4 全部覆盖）。
- 发现的额外问题（不属本节范围但值得记录）：
  1. `apps/server/src/http/webhook.ts:1050-1056` — body 不是合法 JSON 时在验签**之前**返回 400 且不落库；伪造请求可绕过「验签失败也留痕」，也无法按 delivery_id 复盘。
  2. `apps/server/src/http/webhook.ts:1932-1936` — 缺 delivery/event 头的 401 只在 `onResponse` 日志里可见（`server.ts:240-250`），`webhook_deliveries` 无痕迹；受主键约束限制，属已知取舍但未被文档记录。
  3. `apps/server/src/http/webhook.ts:1118-1121` — 同一 delivery 先前验签失败、这次通过时会把 `signature_valid` 翻正并继续处理；若两次请求来自不同来源（一次伪造一次真实），这行会掩盖第一段历史。
