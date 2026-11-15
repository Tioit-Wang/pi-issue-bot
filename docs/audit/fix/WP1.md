# WP1 · 留痕可查（BR-6 / FR-6.4③）

- 需求：`docs/requirements.html:1791` BR-6「不触发也留痕……**可在后台查询**」；`:1216` FR-6.4③ 事件时间线「被忽略的事件也能看到原因」。
- 结论：`webhook_deliveries` 的 `decision` / `decision_reason` 从「只写不读」变成「有读取方」——新增**只读查询层 + 契约 + API 端点**，未触发的投递（含 `switch-off`、`signature-invalid` 等 12 个原因）现在可按仓库 + 时间窗翻页查询。
- 未改需求文档、未 `git add` / `git commit`、未碰 `agent/` `app/compose.ts` `writeback/`。

## 一、改了什么

| 文件 | 位置 | 内容 |
|---|---|---|
| `apps/server/src/queries/deliveries.ts`（新） | `:32` `DeliveriesParams`、`:59` `DECISION_SQL`、`:83` `queryDeliveries` | 只读查询：`webhook_deliveries` 按 `repo` + `received_at` 时间窗（左闭右开）+ 可选 `event` / `decision` 过滤，`received_at desc, delivery_id desc` 的 keyset 分页；`decision` 用 `case` 收敛成契约取值（契约外 → `null` = 未判定），`decision_reason` 原样返回 |
| `apps/server/src/queries/types.ts` | `:40-49` `DeliveriesQuery`、`:60-61` `DeliveriesResponse`、`:73` `DeliveryRow` | 类型一律由契约 `z.infer` 派生，不手抄 DTO（E8）。`DeliveriesQuery` 把 `limit` 放宽成可选（`pageLimitSchema` 有 `.default(50)`，输出类型会把它变成必填；「没传就按默认值」是契约的意思，路由与测试都不必硬塞 `limit`） |
| `apps/server/src/queries/index.ts` | `:22` import、`:88` 接口、`:112` 实现 | `Queries.deliveries(params, query)`；时间窗走 `resolveWindow`（默认最近 24h，`from > to` → `QueryError('unprocessable')`） |
| `packages/contract/src/api.ts` | `:1128` `deliveryDecisionSchema`、`:1132` `deliveryDecisionFilterSchema`、`:1146` `deliveryRowSchema`、`:1169` `deliveriesQuerySchema`、`:1182` `deliveriesResponseSchema` | 第 12 节（投递留痕）。行字段：`deliveryId` `event` `action` `repo` `receivedAt` `decision` `decisionReason` `signatureValid` |
| `packages/contract/src/schemas.ts` | `:83-84`、`:97` | 注册 `DeliveryRow` / `DeliveriesResponse` / `deliveriesQuery`（只加不改名） |
| `apps/server/src/http/api/index.ts` | `:251-271` | 新增 `GET /api/repos/:owner/:name/deliveries`（只挂查询面，不依赖 `deps.repos`；`preHandler: guard` 带鉴权 + `no-store`） |
| `apps/server/test/queries-deliveries.test.ts`（新） | 全文 | 11 个用例（见「三」） |
| `openapi/pi-bot.openapi.json` | — | `pnpm gen:openapi` 产物（9 paths / 51 schemas，含 `DeliveryRow` `DeliveriesResponse`） |

两处刻意的取舍（写在代码注释里）：
1. **`decisionReason` 是字符串不是枚举**。原因取值的事实源是 `trigger/decide.ts` 的 `TriggeredReason | SkippedReason`；在契约里复制成 `z.enum` 后，将来加一个原因就会让留痕接口自己 `parse()` 失败——而它正是「出问题时来查」的接口。契约注释里列了 13 个已知取值供面板对齐。
2. **`decision = null` 表示「还没判定」**（v2.1 之前的历史行 / 正在处理的投递），与 `ignored`（终态）严格区分；查询参数多一个 `decision=pending` 用来筛「还没判定」。

## 二、端点

```
GET /api/repos/{owner}/{name}/deliveries?from=&to=&decision=&event=&cursor=&limit=
```

- 路径两段（`owner/:name`）而不是 `:repo`：`repo` 含 `/`，`:repo` 会吞掉后面的段。
- 查询参数：`from` / `to`（ISO8601，缺省最近 24h，左闭右开）、`decision`（`triggered|ignored|pending`）、`event`、`cursor`（不透明游标，原样回传）、`limit`（1–200，默认 50）。
- 错误：参数非法 → 400 `bad-request`；`from > to` → 422 `unprocessable`。

请求示例：

```
GET /api/repos/acme/widgets/deliveries?from=2026-05-31T12:00:00Z&to=2026-06-01T12:00:00Z&decision=ignored&limit=2
```

响应示例（200，`DeliveriesResponse.parse()` 通过）：

```json
{
  "items": [
    {
      "deliveryId": "v-pr",
      "event": "pull_request",
      "action": "opened",
      "repo": "acme/widgets",
      "receivedAt": "2026-06-01T06:00:00.000Z",
      "decision": "ignored",
      "decisionReason": "pr-ignored",
      "signatureValid": true
    },
    {
      "deliveryId": "v-sig-bad",
      "event": "issues",
      "action": "opened",
      "repo": "acme/widgets",
      "receivedAt": "2026-06-01T04:00:00.000Z",
      "decision": "ignored",
      "decisionReason": "signature-invalid",
      "signatureValid": false
    }
  ],
  "nextCursor": "MjAyNi0wNi0wMVQwNDowMDowMC4wMDBaCnYtc2lnLWJhZA",
  "hasMore": true
}
```

空列表（仓库没有投递）返回 200 + `{items: [], nextCursor: null, hasMore: false}`：**查不到 ≠ 查不了**，未知仓库的投递（`repo is null`）本来就不属于任何仓库的列表。

## 三、测试

`apps/server/test/queries-deliveries.test.ts`（真 PostgreSQL，`openTestDb` + advisory lock；种子在本文件内自建，不动共享的 `seedStandard`）：

1. ★ 未触发的投递也能查到，`decisionReason` = `switch-off` / `not-mentioned`；触发侧记 `enabled`；未判定行 `decision/decisionReason` 都是 `null`。
2. ★ 验签失败（`signatureValid=false` + `signature-invalid`）的投递在列表里。
3. 仓库隔离：别的仓库与 `repo is null` 的投递不串台。
4. 时间窗：`01:30~03:30` 只命中 `03:00`/`02:00` 两行；放大窗口才看得到窗口外的行。
5. 分页：`limit=2` 三页取完，末页 `hasMore=false` / `nextCursor=null`，三页合并无重无漏。
6. 筛选：`decision=triggered|ignored|pending` 与 `event=pull_request` 各自收窄。
7. `from > to` 抛 `QueryError`（`code='unprocessable'`）。
8. 端点：200 + `deliveriesResponseSchema.parse()` + `cache-control: no-store`；查询参数透传；`limit=0` → 400；`from > to` → 422；未知仓库 → 200 空列表。

实际执行（PowerShell，仓库根/`apps/server`）：

```
pnpm gen:openapi
  → openapi: 9 paths / 51 schemas -> openapi/pi-bot.openapi.json

cd packages/contract; npx tsc -p tsconfig.json --noEmit     → 0 error
cd apps/server;      npx tsc --noEmit                       → 0 error

cd apps/server; npx vitest run test/queries-deliveries.test.ts
  → 11 passed (1 file)

cd apps/server; npx vitest run test/queries-costs-audit.test.ts test/queries-issues.test.ts \
    test/queries-overview.test.ts test/queries-tasks.test.ts test/http-server.test.ts \
    test/queries-deliveries.test.ts
  → 6 files / 78 tests passed（回归：既有读接口与 /api/* 装配未受影响）

npx eslint <本次改动的 7 个文件>                          → 0 problem

cd apps/server; npx vitest run（全量，最后一次复跑）
  → 129 files | 127 passed | 2 failed
    失败项与本包无关（见「四」第 5 条）
```

## 四、跳过与残余风险

1. **OpenAPI 只有契约组件、没有新 path**。`packages/contract/scripts/gen-openapi.ts` 的 `Endpoint.pathParam` 只支持**单个**路径参数，写不出 `/api/repos/{owner}/{name}/deliveries`；现有的 `/api/repos/*` 与 `/api/issues/*` 同样不在 `ENDPOINTS` 里（同一原因）。本次遵守「只改 queries / api / contract / openapi / test」的边界，**没有改生成器**，所以 `openapi/pi-bot.openapi.json` 只有新组件（`DeliveryRow`、`DeliveriesResponse`）。建议后续单独做「多路径参数」支持并补齐这批端点（`openapi-typescript` 生成失败也是同类基础设施缺口，AGENTS §8.4）。
2. **`repo is null` 的投递（未知仓库）无法从本端点查到**。按「按仓库查」的口径实现的；要覆盖「未知仓库的投递」需要另加一个全局端点或 `includeUnknown` 参数。已在测试里显式断言这个边界，避免以后被误当成 bug。
3. **`decision` 契约外取值被当成 `null`（未判定）**。这是有意的收敛（宁可显示「未判定」也不让整页 `parse()` 失败），但如果将来库里出现第三种判定值，面板会显示「未判定」而不是错误——排查时要看库本身。
4. **共享工作区的并发写**：本轮期间其它 session 正在改 `src/config/v21-settings.ts`、`src/http/webhook-v21.ts`、`packages/contract/src/settings-v21.ts`。实测出现过两次「读取到别人写到一半的文件」导致 `vitest` 解析失败（重试即恢复），以及一次 `openapi/pi-bot.openapi.json` 被外部覆盖（已重新生成并核对含新组件）。合并前应以本包自己的 `gen:openapi` 结果为准再跑一次。
5. **全量测试的 2 个失败与本包无关**（不修，属其它工作包；最后一次全量复跑的状态）：
   - `test/app-wiring.test.ts`：「`settings.limits.concurrency_per_repo` 真的生效」失败（WP7 执行限额面）。
   - `test/v21-integration.test.ts`：「模板渲染进 `agent_messages.comment_body`」期望 1 行、实得 0 行；同一时刻其它 session 正在改 `src/http/webhook.ts`、`src/app/compose.ts`、`src/worker/run-task.ts`，与本包改动的文件（queries / api / contract / openapi）无交集。
   - 另：`packages/contract` 全量测试有 3 个失败，均在 `test/settings-v21.test.ts` 的「占位符清单正好 12 个」断言（其它工作包把占位符加到 14 个，测试未同步），与本包改动无交集。
   - 上一轮全量里还出现过 `test/doctor-real.test.ts` 因「待执行 0012_wp7_session_system_prompt」失败，本轮已被其它 session 应用迁移后自愈。
