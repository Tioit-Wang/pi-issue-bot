# U08 5.1 事件接入 · B

> 核查范围：docs/requirements.html 行 727-754
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| FR-1.1 | 部分实现 | 入口唯一、raw body 与三个头都真读到了，但 handler 在验签之前先 `JSON.parse`，与「不得先做 JSON 解析」字面相反（非法 JSON 直接 400 且零留痕） |
| FR-1.2 | 部分实现 | 「签名不匹配」这条落库留痕；「缺 X-Hub-Signature-256 头」与「body 非法 JSON」两条 return 路径不落库，且测试把「不写任何行」固化成期望 |
| FR-1.3 | 已实现 | 无缺口（持久层 `delivery_id` 主键 + `ON CONFLICT DO NOTHING`，全仓无投递级内存去重表） |
| FR-1.4 | 部分实现 | 处理确实异步（入队），但应答前串行 await 真实 GitHub 写/读（单次 15s 超时），全链路无硬超时保护 |

## 逐条

### FR-1.1
- **状态**：部分实现
- **证据**：
  - `apps/server/src/http/webhook.ts:1923` — `scope.post('/webhook', …)` 是本仓唯一的 webhook 路由；`apps/server/src/http/server.ts:266` 是它唯一的注册点。
  - `apps/server/src/http/webhook.ts:1914-1921` — `scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, …done(null, body))`：解析器只作用于该封装作用域，body 原样以 Buffer 交出，不做 JSON 解析。
  - `apps/server/src/http/webhook.ts:1924-1928` — `rawBody = Buffer.isBuffer(request.body) ? request.body.toString('utf8') : …`：handler 拿的是原始字节解出的文本。
  - `apps/server/src/http/webhook.ts:1930-1931`（`x-github-delivery` / `x-github-event`）、`1941`（`x-hub-signature-256`）— 三个头都读。
  - `apps/server/src/http/webhook.ts:1074-1079` — `deps.verify({ …, rawBody: input.rawBody, signature })`：HMAC 用的是原始文本。
- **缺口**：`apps/server/src/http/webhook.ts:1050-1056` 在验签（1064-1096）之前就 `JSON.parse(input.rawBody)`，解析失败直接 `return finish(400, …)`，既不验签也不写 `webhook_deliveries`。需求明写「不得先做 JSON 解析」，这里顺序反着来；可观察后果是「body 不是合法 JSON」的投递零留痕（签名本身不受损，因为验签用的是原文而不是 re-serialize 的结果）。
- **判定依据**：入口唯一、raw body 保留、三头齐全三项都能定位到执行路径，属于真实实现；但「不得先做 JSON 解析」这一子条件在 handler 内被违反，按规范只能判部分实现并点名。
- **反证过程**：
  - (a) **是否存在第二条入口**：全仓搜路由注册，`scope.post(` 只命中 `webhook.ts:1923`；`apps/server/src/http/api/*` 全是面板只读 GET 与 `POST /api/repos` 等管理写，不吃 GitHub 投递；`apps/server/src/http/webhook-v21.ts:983` 的 `handleV21Webhook` 是纯库函数，**没有任何路由注册**，由 `webhook.ts:1262` 在验签通过之后调用（同入口、同一次验签，不存在绕过验签的旁路）；`replayDelivery`（`webhook.ts:1801`，`source:'replay'` 跳过验签）只由 `apps/server/src/cli.ts:344` 调用，CLI 而非 HTTP，网络侧无法触发。→ 单入口成立。
  - (b) **raw body 是否被某个 parser 提前 JSON.parse 掉**：全仓 `addContentTypeParser` 仅两处 —— `webhook.ts:1914`（application/json→Buffer）与 `apps/server/src/http/api/skills.ts:180`（application/zip，技能包上传）；根实例（`server.ts:159-165`）没有替换默认 JSON 解析器。→ parser 层面干净。
  - (c) **三个头缺任意一个时的行为**：缺 delivery 或 event → `webhook.ts:1932-1936` 回 401；缺 signature → `webhook.ts:1066-1069` 回 401。三者都被读到，缺一个即拒。
  - (d) **但假设「handler 完全不解析 body」被推翻**：`1052` 行的 `JSON.parse` 确实早于 `1074` 行的验签。这一点只有在读执行顺序时才会暴露（注释与模块头都声称「原始 body … 不能用 JSON parser」，与实际顺序不符），故落到部分实现。

### FR-1.2
- **状态**：部分实现
- **证据**：
  - `apps/server/src/http/webhook.ts:1084-1095` — `if (!valid) { … insertDelivery(…, false) …; return finish(401, errorBodyOf('unauthorized', '签名校验失败')) }`：验签失败先落一条 `signature_valid=false` 的审计行，再回 401，且不建任务。
  - `apps/server/src/http/webhook.ts:1080-1083` — 验签实现抛错时 `valid = false`，走同一个落库分支（不放过异常）。
  - `apps/server/src/http/webhook.ts:1826-1837` — `createOctokitVerifier`：`new Webhooks({ secret })` + `webhooks.verify(rawBody, signature)` → HMAC-SHA256（`x-hub-signature-256`），空 secret 直接抛。
  - `apps/server/src/http/errors.ts:77-84` — 401 映射 `unauthorized`（状态码不在 handler 里手写）。
- **缺口**：两条更早的 return 不落库，且都属于「校验失败」范畴：
  1. `apps/server/src/http/webhook.ts:1066-1069` 缺 `X-Hub-Signature-256` → 401，**没有** `insertDelivery`。此分支 `delivery_id` 已知、完全可落库，是纯遗漏。
  2. `apps/server/src/http/webhook.ts:1052-1056` body 非法 JSON → 400，无 `insertDelivery`（`payload` 是 `NOT NULL jsonb`，见 `migrations/0000_init.sql:161-168`，这条技术上有障碍）。
  3. 测试把这个缺口固化成期望：`apps/server/test/http-webhook.test.ts:223-235`，用例名「缺签名头：401 且不写任何行」，断言 `expect(await countRows('webhook_deliveries')).toBe(0)` —— 与需求「校验失败 … 但仍要落库留痕」直接相反。属于「测试断言了 ≠ 行为对」，不能拿它当通过依据。
- **判定依据**：需求只说「校验失败返回 401 但仍要落库留痕」，没区分「签名不匹配」与「缺签名头」；代码只覆盖了前者（`test/http-webhook.test.ts:197-221` 断言 `signature_valid=false`、`tasks` 0 行、未入队，这条完全达标），后者不留痕，故为部分实现。
- **反证过程**：把「每条失败路径都落库」逐条跑一遍：
  - (a) 签名不匹配（含 `sign()` 少一位、`verify` 抛错）→ 落库 ✓（`1086-1093`）。
  - (b) 缺 signature 头 → **不落库** ✗（`1066-1069`）。
  - (c) 缺 delivery 头 → 不落库（`1932-1936`）。技术上是死路：`webhook_deliveries.delivery_id` 是主键（`migrations/0000_init.sql:162`），没有 ID 写不进去，故此项不判为缺陷，但同样「无痕」。
  - (d) body 非法 JSON → 不落库 ✗（`1052-1056`），原因同 (c)：`payload NOT NULL jsonb`。
  - **反向证据（说明 (b) 是遗漏而非设计）**：`apps/server/src/http/webhook.ts:1100-1121` 对「同一 delivery 先前验签失败、这次通过」专门做了 `readDelivery` + `markSignatureValid` 翻正，说明审计行本身是被后续逻辑消费的真数据；既然 `signature_valid=false` 行有价值，缺签名头那条路径就更没有理由不写。
  - **测试口径核查**：`test/http-webhook.test.ts:234` 的断言是「总数 0」，在 `beforeEach` truncate 之后等价于「这次投递没写行」；它不是漏断言，而是把错误行为写成了期望。

### FR-1.3
- **状态**：已实现
- **证据**：
  - `migrations/0000_init.sql:161-168` — `CREATE TABLE "webhook_deliveries" ( "delivery_id" text PRIMARY KEY NOT NULL, … )`：唯一键在**迁移 SQL** 里，不只是 drizzle 声明（`apps/server/src/db/schema.ts:92` 的 `.primaryKey()` 只是 TS 侧同一声明）。
  - `apps/server/src/http/webhook.ts:95-98` — `INSERT INTO "webhook_deliveries" … ON CONFLICT ("delivery_id") DO NOTHING RETURNING "delivery_id"`：去重发生在持久层一次原子写。
  - `apps/server/src/http/webhook.ts:1100-1122` — `(inserted.rowCount ?? 0) === 0` → 读回 `signature_valid` → 为 true 时 `return finish(200, accepted({ action: 'duplicate', duplicate: true, … }))`：重复投递回 2xx、不建任务、不入队、`trace.skipDecision = true` 不覆写原判定。
  - `apps/server/test/http-webhook.test.ts:237-261` — 同一 delivery 重投 20 次：`webhook_deliveries` 1 行、`tasks` 1 行、`h.sends` 1 次，第 2-20 次 `duplicate === true`。
- **缺口**：无。
- **判定依据**：需求三个子条件（投递 ID 唯一键 / 重复投递回成功不重复处理 / 去重必须在持久层）各自都有可执行的代码路径与具体断言，且唯一约束能在迁移文件里核对到。
- **反证过程**：
  - **找内存去重表**：全仓 `new Set<` / `new Map<` 命中 50+ 处，逐个看键：`webhook.ts:1452` 的 `seen` 是技能目录去重、`webhook.ts:750` 是 `runtime_flags` 结果 Map、其余分散在 skills/prompt/queries/queue 中，**没有任何一处以 delivery_id 为键的投递缓存**。→ 「不许只靠内存」满足。
  - **唯一约束是否只存在于 drizzle**：`migrations/0000_init.sql:162` 是真实 DDL 主键；`db-schema.test.ts` 另有 DDL 断言（`apps/server/test/db-schema.test.ts:203`）。→ 在持久层。
  - **重复投递是否真的「成功」而不只是 200**：`1117` 返回 `status: 200` + `action:'duplicate'`，且有具体断言（`259-260`）。→ 是。
  - **反例排除**：`replayDelivery` 传 `skipDeliveryDedup: true`（`webhook.ts:1819`），但该函数只被 CLI 调用，不构成 HTTP 入口上的去重漏洞。

### FR-1.4
- **状态**：部分实现
- **证据**：
  - **异步化成立**：`apps/server/src/http/webhook.ts:1404` `const jobId = await deps.enqueue({ … })` → `createQueueEnqueuer` → `enqueueTask(boss, …)`；模型的真实执行在 worker 侧 `run-task`（`apps/server/src/worker/run-task.ts`），不在请求线程内。
  - **应答前有同步外部调用**：`apps/server/src/http/webhook.ts:1420-1425` `await deps.ack.addEyesReaction(...)`，真实实现 `apps/server/src/http/webhook.ts:1858` / `1866` 是两次真实 GitHub `POST …/reactions`；单次 HTTP 超时 15s（`apps/server/src/github/octokit.ts:114` `ctorOptions['request'] = { timeout: options.requestTimeoutMs ?? 15_000 }`），且该写调用没有单独的更短超时。
  - **v21 分支还有一次远程读**：`apps/server/src/http/webhook-v21.ts:476` `rendered = await renderV21AgentText(...)`，模板里出现 `{{repo.issues}}` 时经 `:337` 惰性调用 provider → `apps/server/src/http/webhook-v21.ts:564` `GET /repos/{owner}/{repo}/issues`，`apps/server/src/prompt/repo-issues.ts:44/109-110` 最多 2 页、超时同样 15s/次，只在 5 分钟内命中内存缓存（`repo-issues.ts:47`）。
  - **没有硬超时**：`apps/server/src/http/server.ts:159-165` 只设 `logger/trustProxy/bodyLimit`，未设 `requestTimeout` / `connectionTimeout`；`apps/server/src/http/webhook.ts:1040-1047` 只在 `elapsedMs >= 2000` 时 `log.warn`，不中断、不改状态码。
- **缺口**：「10 秒内返回 2xx」没有任何强制机制。应答路径上最少 1 次真实 GitHub 写（reaction），v21 触发时再加 ≤2 次 GitHub 读，全部串行 await，任一慢到 15s 就直接把响应推过 10 秒 —— 而 10 秒正是需求点名的「会被 GitHub 判超时并重投」阈值。
- **判定依据**：「实际处理异步进行」子条件满足（入队后由 worker 跑）；「必须 10 秒内返回」子条件只有观测（2000ms warn），无保护手段，且存在 15s 上限的外部调用，不能判已实现。
- **反证过程**：
  - **有没有硬超时**：在 webhook 链路上搜 `requestTimeout` / `AbortSignal` / `setTimeout` —— `server.ts` 无相关设置，`webhook.ts` 无；`setTimeout` 命中都在别的模块（exec-proxy / turn-driver / host-supervisor / pool）。→ 无保护。
  - **handler 内有没有同步外部调用**：有两条 —— `addEyesReaction`（`webhook.ts:1421`，v21 分支在 `webhook-v21.ts:1059`）与 `{{repo.issues}}` 渲染（`webhook-v21.ts:564`）。两者都在 `return finish(...)` 之前 await。
  - **测试是否把风险固化成期望**：`apps/server/test/http-webhook.test.ts:287-304` 用例名「★ 10 秒应答在 handler 内」，断言 `expect(h.events).toEqual(['enqueue', 'reaction'])`，即**要求** reaction 在 handler 内返回前完成 —— 这条断言证明的是「回执顺序」，不是「10s 时限」；`elapsedMs < 2000` 用的是注入的假 ack（同步返回），不能外推到真实链路。拿这条用例证明 FR-1.4 达标属于误判。
  - **是否可能在天花板上侥幸合规**：不能。GitHub 侧网络抖动 + 15s 客户端超时意味着最坏情况 ≥10s，且 v21 渲染是 2 次串行 GET。

## 本节整体结论
事件接入的主链路是真实的：唯一 `POST /webhook` 入口、作用域内 raw body Buffer parser、三头齐全、验签后落库、持久层 `delivery_id` 主键去重，都能定位到执行路径并有具体断言，不存在第二条绕过验签的 HTTP 入口，也没有内存投递缓存。但按需求字面不能满足「全部子条件」：FR-1.1 的「不得先做 JSON 解析」被 handler 内的 `JSON.parse` 破坏（后果是非法 body 零留痕）；FR-1.2 在「缺签名头」与「非法 JSON」两条路径上不留痕，且被 `http-webhook.test.ts:223-235` 固化成期望；FR-1.4 只有 2000ms 观测、没有 10s 硬保护，应答路径上还串行 await 了 15s 上限的 GitHub 调用。因此本节**不能**判为「已实现」：FR-1.3 已实现，其余三条为部分实现。

## 核查边界
- 是否执行了命令：只执行了只读检索（`git status --short`、`git log --oneline -3`、`Select-String` / `Grep` 定位、`Read` 读文件）。**未**运行 `pnpm -r test` / `typecheck`，未连 PostgreSQL，未发送真实 webhook。文中所有「测试断言了」均指读过断言内容，不代表跑过或通过。
- 未覆盖的条目及原因：
  - 「非法 JSON 是否真会零留痕」只做了静态推断（`1052-1056` 在 `insertDelivery` 之前 return），未用真库复现。
  - 缺 delivery / event 头时是否还有其它落库通道（如访问日志或 metrics）未逐个排查，只确认 `webhook_deliveries` 无行。
  - `content-type` 变体（`application/json; charset=utf-8`、GitHub 若配成表单编码）下的 parser 命中情况未实测。
  - 需求正文在 PowerShell 下按 GBK 显示为乱码，条目文本按 UTF-8 语义复原后使用；行号 727-754 与 `FR-1.1`~`FR-1.4` 四个 `div.req` 一一对应无歧义。
- 发现的额外问题（不属本节范围但值得记录）：
  1. `apps/server/src/http/webhook.ts:1100-1101` 的投递落库发生在暂停/禁用/未知仓库判定之前，因此被 `paused` 的投递在 GitHub 重投时会命中 `duplicate`（`1117`）而不再处理，恢复后只能靠 CLI `replay`；这是刻意的设计选择（`1150` 注释），但它使「GitHub 重投 = 再给一次机会」不成立，建议在运维文档点名。
  2. `apps/server/src/http/webhook.ts:1095` 与 `1069` 都返回同一个 `unauthorized` 文案系，但只有前者落库；排查「secret 配错」时看到的是一半有痕迹、一半没有，正是 FR-1.2 想避免的场景。
