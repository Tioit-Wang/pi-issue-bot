# 5.1 事件接入（FR-1.1 ~ FR-1.4）实现核查

- 需求来源：`docs/requirements.html` 第 727-754 行（§5.1）
- 核查对象：仓库 `C:\Code\NodeProjects\pi-issue-bot`，HEAD `fbfa029`（工作区有未提交改动，见文末说明）
- 核查方式：只读代码 + 测试；未运行任何测试（纯静态核查，凡需运行才能确认的已标「无法判定」）

---

## FR-1.1 接收 GitHub webhook（单一入口 / 原始请求体 / 三个请求头）

**状态：已实现**（有一个需注明的范围项，见缺口说明）

### 证据

1. **单一 HTTP 入口**
   - `apps/server/src/http/server.ts:265-268`：全仓只有这一处挂载 webhook 路由。
     ```
     // ── POST /webhook（唯一写入口，但只入队）───────────────────────────────
     registerWebhookRoute(scope.withTypeProvider<ZodTypeProvider>(), deps.webhook, {
       bodyLimitBytes: deps.bodyLimitBytes ?? 25 * 1024 * 1024,
     });
     ```
   - 路由定义唯一：`apps/server/src/http/webhook.ts:1923` `scope.post('/webhook', ...)`。全仓无第二个 webhook 入口（`webhook-v21.ts` 是判定模块，不注册路由）。

2. **原始请求体未先 JSON 解析**
   - `apps/server/src/http/webhook.ts:1913-1921`：在该路由的封装作用域内替换 `application/json` 解析器为 `parseAs: 'buffer'`，直接把 Buffer 原样交出去：
     ```
     scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit },
       (_request, body, done) => { done(null, body); });   // 原样交给 handler：HMAC 必须对原始字节验
     ```
     解析器注册在 `app.register(async (scope) => {...})` 内，作用域隔离，不会污染其它 JSON 路由。
   - `webhook.ts:1924-1928`：`rawBody` 由 Buffer 转 utf8 字符串，未经任何再序列化。
   - `webhook.ts:1074-1079`：验签拿到的是这份 `rawBody`（`deps.verify({ ..., rawBody: input.rawBody, signature })`），即 HMAC 对原始字节计算。
   - 说明：`webhook.ts:1052` 确实有 `JSON.parse(input.rawBody)`，但它只用于**取业务字段**（action / repository / installation），不作验签输入，也不回写原始体，因此不违反「不得先做 JSON 解析（否则签名无法校验）」的实质约束。

3. **三个请求头都读取**
   - `webhook.ts:147-151` 定义头名：`delivery: 'x-github-delivery'`、`event: 'x-github-event'`、`signature: 'x-hub-signature-256'`。
   - `webhook.ts:1930-1931` 读 delivery/event，缺失即 401；`webhook.ts:1941` 读 signature 并传给 handler。

4. **事件类型覆盖**
   - `issues` / `issue_comment`：`webhook.ts:551`（issue_comment 分支）、`webhook.ts:618`（issues 分支）；v2.1 判定侧 `webhook-v21.ts:90-95`。
   - `installation` 系列：`webhook.ts:827-835` 白名单 `installation: [created, deleted, suspend, unsuspend]`、`installation_repositories: [added, removed]`；处理在 `webhook.ts:1127-1140` → `applyInstallationEvent()`（`webhook.ts:876-955`，建行 / 批量禁用 / 写暂停位）。
   - `pull_request.*`：**能接收、能落库留痕**，但一律按未触发处理（`webhook-v21.ts:85-88` `if (event.startsWith('pull_request')) return 'pull_request.*'`，注释明写「§0『不纳入』：PR 事件本期一律按未触发留痕」）。

5. **测试证据**
   - `apps/server/test/http-server.test.ts:374-390`：真 HTTP 路径（`app.inject` + 真 HMAC 签名）→ 200 accepted，用例名即「证明 raw body 解析器没被换成 JSON parser」。
   - `apps/server/test/http-webhook.test.ts:584-760`：installation 系列 6 条用例（created / repositories.added / repositories.removed / deleted / suspend / unsuspend）逐一断言落库结果。
   - `apps/server/test/v21-webhook-integration.test.ts:519`：PR 事件留 `pr-ignored` 且完全不入队。

### 缺口说明

- **`pull_request` 系列只落库、不产生处理**。需求原文「支持的事件类型至少包括 … `pull_request`」中的「支持」若按「接收 + 留痕」理解已满足；若按「必须处理 PR 事件」理解则不满足——代码是**有意**排除（`webhook-v21.ts:86` 注释引 §0「不纳入」）。这是一处需求口径与实现范围的落差，需要需求方确认「支持」的定义。
- 另外 `issues.labeled` / `issues.closed` 等 action 在 v0.3 白名单外（`webhook.ts:520-530` 注释），同样只留痕不建任务；这些不在 FR-1.1 明写的四类里，仅作背景。

---

## FR-1.2 签名校验（HMAC-SHA256 / 失败 401 / 失败仍落库留痕）

**状态：部分实现**（缺「缺签名头时也落库留痕」这一子条件）

### 证据

1. **HMAC-SHA256 校验**（实现路径完整，但校验本身在第三方库内，属可定位但未逐字节复核）
   - `apps/server/src/app/compose.ts:884`：`const verify = overrides.verify ?? createOctokitVerifier(config.webhook.secret);` —— 生产装配走真实实现。
   - `apps/server/src/http/webhook.ts:1826-1838`：
     ```
     export function createOctokitVerifier(secret: string): WebhookVerify {
       if (secret === '') throw new Error('... 空 secret 等于不验签');
       const webhooks = new Webhooks({ secret });
       return async (input) => { try { return await webhooks.verify(input.rawBody, input.signature); } catch { return false; } };
     }
     ```
     `@octokit/webhooks` 的 `verify()` 即 HMAC-SHA256 + `timingSafeEqual`，输入是原始 body 与 `x-hub-signature-256`。空 secret 直接抛错（不静默放行）。
   - 验签抛错按失败处理（不设宽容模式）：`webhook.ts:1080-1083`。
   - 测试：`http-server.test.ts:392-408`（签名与 body 不匹配 → 401）、`http-server.test.ts:374-390`（正确签名 → 200）。

2. **失败返回 401**
   - `webhook.ts:1084-1095`：`if (!valid) { ...落库...; return finish(401, errorBodyOf('unauthorized', '签名校验失败')); }`
   - 测试：`http-webhook.test.ts:197-221` 断言 `status === 401` 且 `error.code === 'unauthorized'`。

3. **失败仍落库留痕**
   - `webhook.ts:1086-1093`：
     ```
     await deps.db.query(WEBHOOK_SQL.insertDelivery, [input.deliveryId, input.event, action, project.repo, payload, false]);
     ```
     第 6 个参数 `false` → `signature_valid = false`；且该分支 `return` 在入队之前，**落库但不入队**。
   - 测试：`http-webhook.test.ts:211-220` 用真 PG 查 `webhook_deliveries`，断言 `rows[0].signature_valid === false`、`tasks` 0 行、`h.sends` 空。

### 缺口说明

- **缺签名头（`x-hub-signature-256` 缺失）时返回 401 但完全不落库**：`webhook.ts:1066-1069`
  ```
  if (signature === null) {
    log.warn('缺少 X-Hub-Signature-256');
    return finish(401, errorBodyOf('unauthorized', '缺少 X-Hub-Signature-256 请求头'));
  }
  ```
  这里没有 `insertDelivery`。测试把这一行为**固化为期望**：`http-webhook.test.ts:223-235`「缺签名头：401 且不写任何行」，`expect(await countRows('webhook_deliveries')).toBe(0)`。
  影响：需求要求「对**每个请求**做校验，校验失败返回 401 但仍要落库留痕，**便于排查配置错误**」。而「webhook secret 没配上 / 反代丢了签名头」恰恰是最典型的配置错误场景，此时库里零痕迹，只能翻日志（日志是 `warn` 级、非持久查询面），与需求目的直接相悖。
  同类但更轻的问题：请求头缺 `x-github-delivery` 或 `x-github-event` → 401 且不落库（`webhook.ts:1932-1936`）；body 非合法 JSON → 400 且不落库（`webhook.ts:1052-1056`）。缺 delivery 时无主键确实无法落库（可辩护）；缺签名时 delivery id 存在，属可实现而未实现。

---

## FR-1.3 投递去重（delivery ID 唯一键 / 重复返回成功 / 持久层去重）

**状态：已实现**

### 证据

1. **以投递 ID 为唯一键，在持久层**
   - 迁移：`migrations/0000_init.sql:161-167`
     ```
     CREATE TABLE "webhook_deliveries" (
       "delivery_id" text PRIMARY KEY NOT NULL,
       ...
     ```
   - schema 同源：`apps/server/src/db/schema.ts:88-92` `deliveryId: text('delivery_id').primaryKey()`，注释「主幂等键」。
   - 全仓无内存去重表：`apps/server/src` 下所有 `new Set` / `new Map` 无一用于投递 ID（`webhook.ts:1452` 的 `seen` 是技能目录去重，`webhook.ts:750` 的 `flags` 是暂停位查询缓存）；投递去重只有下面这一条 SQL 路径。

2. **去重靠数据库原子插入**
   - `webhook.ts:95-97`：
     ```
     insertDelivery: `INSERT INTO "webhook_deliveries" ("delivery_id", "event", "action", "repo", "payload", "signature_valid")
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT ("delivery_id") DO NOTHING
     RETURNING "delivery_id"`
     ```
   - `webhook.ts:1100-1122`：`rowCount === 0` 即命中重复 → 直接 200 `duplicate`，不再入队：
     ```
     if ((inserted.rowCount ?? 0) === 0) { ... return finish(200, accepted({ ..., action: 'duplicate', duplicate: true, ... })); }
     ```
     去重发生在入队/建任务**之前**，故重复投递不产生任务。

3. **重复投递返回成功（200）**
   - `webhook.ts:1117` 返回 200 + `duplicate: true`，符合「重复投递视为正常现象，直接返回成功」。

4. **第二层幂等（任务级）也在持久层**
   - `apps/server/src/db/schema.ts:253` `uniqueIndex('tasks_idempotency_key_uidx').on(t.idempotencyKey)`；`webhook.ts:1348-1397` 用 `insertTask` 的 `rowCount === 0` 判命中。
   - 键生成：`apps/server/src/queue/idempotency.ts:1-27`（`sha256([kind, repo, target, anchor, actor])` 前 32 位），文件头明写「幂等落在数据库，不靠内存去重」。

5. **测试证据**
   - `apps/server/test/http-webhook.test.ts:237-261`：同一 delivery 连投 20 次 → `webhook_deliveries` 1 行、`tasks` 1 行、入队 1 次，首条 `enqueued` 其余 19 条 `duplicate`。
   - `apps/server/test/e2e-idempotent.test.ts:83-128`：同 delivery 投 20 次 → deliveries 1 行 / tasks 1 行 / send 1 次。
   - `apps/server/test/e2e-idempotent.test.ts:129`：换 delivery 但同 `idempotency_key` → tasks 仍 1 行、不入队。
   - `v21-webhook-integration.test.ts:323`：重复投递不覆盖原判定（`decision` 不被重写）。

### 缺口说明

无。持久层唯一约束 + 原子 `ON CONFLICT` + 重复返回 200 三点均落在代码与迁移里，且有真 PG 用例覆盖。

---

## FR-1.4 应答时限（10 秒内 2xx / 实际处理异步）

**状态：已实现**

### 证据

1. **handler 内只做「落库 + 入队 + 回执」，不做实际处理**
   - `webhook.ts:1402-1410`：`await deps.enqueue({ taskId, command, repo })` 只把任务交给 pg-boss，不等待执行。
   - `webhook.ts:1412-1433`：第 7 步入队后立即返回 200 `enqueued`（注释：「★ 10 秒应答就在 handler 内（不经过队列）」）。
   - 真正的 turn 在 worker 侧：`apps/server/src/queue/*` 的 `registerTaskWorker` → `worker/run-task.ts`（`compose.ts` 装配），与 HTTP 响应路径解耦。
   - installation 事件同样在 handler 内完成、直接 200 `ignored`（`webhook.ts:1138-1139`），不排队。

2. **超时自观测**
   - `webhook.ts:1041-1045`：`elapsedMs >= 2000` 打 `warn`「webhook 处理超过 2s（目标 < 2s）」，把耗时作为返回值 `elapsedMs` 一并给出。
   - `apps/server/src/http/server.ts:228-251`：`onResponse` 钩子按路由记直方图与请求日志（含 `deliveryId`）。

3. **测试证据**
   - `apps/server/test/http-webhook.test.ts:287-304`：断言 `result.status === 200`、`h.events === ['enqueue','reaction']`（顺序证明 reaction 在入队之后、handler 返回之前）、`result.elapsedMs < 2000`。

### 缺口说明

- **没有强制的 10s 硬上限**（无 handler 级超时/中断）。响应路径上唯一的同步外部调用是回执 reaction（`webhook.ts:1420-1430`，失败只 warn 不改变状态码），但它走 `GithubClient.request`，超时依赖 octokit/HTTP 默认值，代码里未给这条路径单独设 timeout。若 GitHub API 长时间挂起，200 可能被拖过 10s。这是「异步已实现、时限未硬保证」的残余风险，不是需求未实现的判定——正常路径的 2xx 明确早于任何 AI 处理返回。

---

## 本节整体结论

四条需求里 **FR-1.1 / FR-1.3 / FR-1.4 落到实现且有可定位测试**：单一 `/webhook` 入口 + 路由作用域内的 raw buffer 解析器（`webhook.ts:1913-1928`）保证验签对原始字节成立；去重是真持久层的 `delivery_id PRIMARY KEY` + `ON CONFLICT DO NOTHING`（`migrations/0000_init.sql:161`、`webhook.ts:95-97`），重复投递返回 200 `duplicate`，`http-webhook.test.ts:237` 的 20 次重投用例直接对应验收要点；应答在入队后立刻 200，处理异步，`http-webhook.test.ts:287` 用事件顺序固定了这一点。

**唯一需要修的点在 FR-1.2**：`webhook.ts:1066-1069` 缺签名头时返回 401 却**不写任何留痕行**，并且 `http-webhook.test.ts:223-235` 把「不写任何行」写成了期望值。需求明写「校验失败…仍要落库留痕，便于排查配置错误」，而 secret 没配 / 反代丢头正是该条要覆盖的场景。建议把该分支改为写 `signature_valid=false` 的投递行（delivery id 此时可用），并同步改那条测试断言。

**另一处需要需求方定口径**：`pull_request.*` 只接收+留痕、不处理（`webhook-v21.ts:85-88`，有意为之）。按「入口接收」理解 FR-1.1 达标；按「必须处理 PR 事件」理解则为部分实现。这不是代码缺陷，是范围声明与需求措辞的差异。

### 附：核查边界

- 未运行任何测试/构建（本任务只读核查），上述「通过」均指存在对应断言，不代表本地实跑结论。
- `webhook.ts`、`webhook-v21.ts`、`server.ts`、`compose.ts` 在当前工作区处于**未提交修改**状态（`git status --short` 显示 M），本报告结论对应工作区文件内容，非 HEAD 内容。
- HMAC 运算本体在 `@octokit/webhooks` 依赖内，未逐行审阅其实现（属库契约范围）。
