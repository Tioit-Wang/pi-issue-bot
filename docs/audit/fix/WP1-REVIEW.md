# WP1 审查 · 留痕可查（BR-6 / FR-6.4③）

审查者：独立 review session（默认假设实现有问题，主动找反证）
被审对象：`docs/audit/fix/WP1.md` 的三项声称 —— ①未触发的投递（含 `switch-off`、`signature-invalid` 等）现在可按仓库 + 时间窗翻页查询；②新增只读查询层 + 契约 + 端点；③11 个用例、tsc 0 error。
需求原文：BR-6（`docs/requirements.html:1791`）「**不触发也留痕**：未通过开关或闸门的事件，必须记录判定结果与原因，**可在后台查询**」；FR-6.4③（`:1216`）「事件时间线：投递 → 判定 → 执行 → 写回，**被忽略的事件也能看到原因**」。

## 结论：**有条件通过**

核心声称成立，且比报告写的更扎实（纯增量、只读、无越界、测试断言具体值）。但报告对「12 个原因都可查」的表述**过宽**，且 `decision = null` 的口径会在真实流量下把「不在判定范围」显示成「未判定」。四条条件见文末，其中 C1 需要编排侧定口径，C2/C3 是几行改动，C4 是登记缺口。

审查口径声明：工作区同时有 WP2/WP4/WP5/WP7 的并行改动，`git status` 已远超 `_baseline-fix.txt` 记录的 27 个 M 文件（现在是 55 个 M + 24 个未跟踪），**git 无法按包归属**。我用「diff 里是否出现本包标识（`deliveries` / `DeliveryRow` / 查询 `decision_reason`）」判定本包足迹，下文的「本包 / 非本包」都按这个口径。

---

## 一、实跑结果（全部真跑，命令 + 输出摘要）

| # | 命令 | 结果 |
|---|---|---|
| 1 | `cd apps/server; npx tsc --noEmit` | exit 0，无输出 |
| 2 | `cd apps/server; npx vitest run test/queries-deliveries.test.ts` | **1 file / 11 tests passed**，2.76s |
| 3 | `cd apps/server; npx vitest run test/queries-deliveries.test.ts test/http-server.test.ts test/queries-issues.test.ts` | **3 files / 46 tests passed**（11 + 24 + 11），8.42s |
| 4 | `cd packages/contract; npx tsc -p tsconfig.json --noEmit` | exit 0，无输出 |
| 5 | `npx eslint` 7 个本包文件（含新测试） | exit 0，0 problem（lint zone 未放宽） |
| 6 | `pnpm -r typecheck`（我补跑，报告未列） | 6 个 project 全 Done，exit 0 |
| 7 | 真库 SQL 探针（脚本在 scratch，跑完自删探针仓库行） | 见下 |

第 7 项是为核「左闭右开」「`case` 收敛口径」而写的独立探针（`probe.cjs`，连 `pi_issue_bot_test`，只对临时仓库 `review/probe-wp1` 增删）：

```
A) SELECT 全部行（CASE 收敛后）: [{"delivery_id":"p-at-to","decision":"ignored","decision_reason":"switch-off"},
   {"delivery_id":"p-bad","decision":null,"decision_reason":"something-new"},
   {"delivery_id":"p-null","decision":null,"decision_reason":null},
   {"delivery_id":"p-at-from","decision":"ignored","decision_reason":"switch-off"}]
B) decision=pending 过滤命中: [{"delivery_id":"p-null"}]
C) decision=triggered 过滤命中: []
D) 时间窗 [03:00, 06:00) 命中: [p-bad, p-null, p-at-from]
E) limit+1 取到行数（limit=0 时 page 为空但 hasMore=true）: 1
```

读法：`p-bad`（`decision='error'`，契约外取值）被 `case` 收敛成 `null`，但**原因 `something-new` 原样保留**（→ 第 1 项核查结论：**没有任何真实原因值被吞掉**）；`p-at-from`（恰好等于 `from`）命中、`p-at-to`（恰好等于 `to`）不命中（→ 左闭右开在实现上成立）；B 里 `p-bad` 筛不到（→ 见问题 三-2）。

**与 WP1.md 自述的差异**：11 tests / tsc 0 error / 6 files 78 tests 之外的回归数字都对得上（我跑的是它第 3 条命令的子集，46 tests 通过）。差异两处：①WP1.md 未提 `pnpm -r typecheck`，我补跑通过；②`openapi/pi-bot.openapi.json` 的 `139 增 / 162 删` 不是本包产生的（本包 6 个声明文件全是纯增，见第四节），162 行删除来自并行契约改动（`settings-v21` 那批）混进同一份产物。

---

## 二、需求对照

### 2.1 「不触发也留痕 + 可查」逐原因核查（本包最可能漏的地方）

`SkippedReason` 共 **12** 个成员 + `TriggeredReason` **2** 个 = **14** 个取值（`apps/server/src/trigger/decide.ts:31-51`、`:28`），`pr-ignored` 另由 `decidePullRequest()` 给（`:274-276`）。逐个对照 `DECISION_SQL`（`apps/server/src/queries/deliveries.ts:59`）与 `deliveryDecisionSchema`（`packages/contract/src/api.ts:1128`）：

| 原因 | 写入方 | 读侧是否保留 | 结论 |
|---|---|---|---|
| `enabled` / `conditional-met` | `webhook-v21.ts:309-310` | 原样（`deliveries.ts:62,123-124`） | ✅ |
| `switch-off` | `decide.ts:227-229` | 原样 | ✅ 探针/用例双证 |
| `body-unchanged` / `label-not-matched` | `decide.ts:145-162` | 原样 | ✅ |
| `not-mentioned` / `role-denied` / `bot-self` / `closed-not-allowed` | `decide.ts:173-201` | 原样 | ✅ |
| `pr-ignored` | `decide.ts:274-276` | 原样 | ✅ |
| `content-duplicate` | `decide.ts:246-248`，**无调用方传 `true`** | 原样 | ⚠️ 读侧没问题，但该原因当前不可达（见三-6） |
| `daily-quota` | `webhook-v21.ts:228-265` | 原样 | ✅ |
| `repo-disabled` | `decide.ts:221-223` + 外层兜底 `webhook.ts:997-1014` | 原样 | ⚠️ 被四类投递复用（见三-3） |
| `signature-invalid` | `decide.ts:216-218`（经 `webhook.ts:1013`） | 原样 | ⚠️ **只覆盖「有签名但校验失败」**，缺签名不落行（见三-3） |

**第 1 项核查的直接回答**：`decision_reason` 在查询里是**原样字符串透传**（`deliveries.ts:62`，只做 64 字符截断，`stringOrNull` 定义在 `apps/server/src/queries/sql.ts:145`），契约侧也是 `z.string()`（`api.ts:1160`）而不是 `z.enum`。所以**没有任何一个真实原因值会被收敛成 `null`**；被收敛的只有 `decision` 列本身（`webhook_deliveries.decision` 是 `text` 无 CHECK，`db/schema.ts:112`）。这一条是本包做得最对的地方，报告的取舍说明也属实。

**实际写入 `decision_reason` 的字面量核查**：全仓只有一处写（`webhook-v21.ts:314-327` 的 `V21_DECISION_SQL.write`），值来自 `v21DecisionRowOf()`（`:304-312`）的 `decision.reason`，即恒等于 `TriggeredReason | SkippedReason` 的成员。**不存在 `decide.ts` 之外的自造字符串**（对比：`http/webhook.ts` 里那些 `reason: 'unknown-repo'` / `'installation-mismatch'` / `'repo-unusable'` 只进日志，不落库，见 `:1175`、`:1185`、`:1234`）。`daily-quota` 不在 `decide.ts` 的第 ⑥ 步之外另立——由 `decideDailyQuotaExceeded()`（`decide.ts:287-289`）统一出口，符合「不许两处各拼一份」的要求。

### 2.2 未进判定的投递（BR-6 的真正薄弱处）

| 投递类别 | 有投递行？ | `decision` | 可查？ | 证据 |
|---|---|---|---|---|
| 开关关闭 / 闸门拒绝 / 条件不满足 | ✅ | `ignored` | ✅ 按仓库查得到 | `webhook.ts:1103` + `:1016-1026` |
| 有签名但验签失败 | ✅（专门补落） | `ignored` / `signature-invalid` | ✅ | `webhook.ts:1086-1097`、`:1013` |
| **缺 `X-Hub-Signature-256`** | ❌ **不落行** | — | ❌ **永远查不到** | `webhook.ts:1068-1072` 直接 401，`insertDelivery` 只在 `:1088`、`:1103` 调用 |
| **body 不是 JSON** | ❌ 不落行 | — | ❌ 查不到 | `webhook.ts:1052-1058` 早于落库 |
| 暂停 / 安装事件 / 安装不匹配 / 读策略 500 | ✅ | `ignored` / **`repo-disabled`**（原因失真） | 部分（安装事件 `repo=null` 查不到） | `webhook.ts:997-1014` 兜底统一 `repoDisabled: true` |
| 未知仓库（`repo=null`） | ✅ | `ignored` / `repo-disabled` | ❌ 本端点按仓库查，查不到（WP1 已披露） | `webhook.ts:1174-1176` |
| **不在 5 个 EventKey + PR 内的事件**（`push`、`label`、`issue_comment.deleted`、`issues.reopened`…） | ✅ | **`null` 且永久不变** | 「查得到但是未判定」 | `webhook-v21.ts:98-120`（返回 null）→ `:184-189` → `webhook.ts:1016` 不写 |

前两行是**写入口缺口**（HEAD 已如此，非本包引入），但直接推翻「`signature-invalid` 等 12 个原因现在可查」的字面含义：缺签名的 401 投递连行都没有。最后一行是本包**契约口径**的问题：`decision = null` 同时被用来表示「还没判定」（`api.ts:1124-1126`）和事实上的「不在判定范围」，二者在真实流量里无法区分（见三-1）。

### 2.3 FR-6.4③

本包交付的是「投递 → 判定」这一段（`api.ts:1118` 第 12 节、`http/api/index.ts:251-271`）。「执行 → 写回」两段要靠 `tasks` / `actions` 拼装，属 WP11 面板（`MASTER-PLAN.md:34` 把面板划给 WP11）。**接口层这一段是成立的**：一次投递的 event/action/receivedAt/decision/decisionReason/signatureValid 都在（`api.ts:1146-1166`），面板画时间线够用。所以「改动面 = queries + api + contract」符合 `MASTER-PLAN.md:24`，**不算漏做面板**。

---

## 三、发现的问题（严重度 + 文件:行号）

### 中-1 「不在判定范围」被显示成「未判定」，并污染 `decision=pending`

- 证据：`apps/server/src/http/webhook-v21.ts:98-120`（`v21EventKeyOf` 对 `push` / `label` / `issue_comment.edited|deleted` / `issues.reopened|assigned` 等一律返回 `null`）→ `:184-189`（`decideV21Delivery` 返回 `null`）→ `apps/server/src/http/webhook.ts:1016`（`decision !== null` 才写）；而投递行在 `:1103` 已经落库。
- 后果：这些行的 `decision` **永久为 `null`**，读侧（`apps/server/src/queries/deliveries.ts:59,69`）显示「未判定」；`decision=pending`（`:99-100`）会把它们和真正「正在处理 / v2.1 之前的历史行」混在一页。对一个组织级 webhook 来说，`push` 之类的量远大于 issue 事件，这条口径在真实库上会让「未判定」变成默认值。
- 归属：契约口径（本包定义 `null = 还没判定` 时未考虑此类），需要在 C1 里定调。
- 我方证据强度：静态（未做端到端投递实证，见第五节第 4 条）。

### 中-2 `decision=pending` 过滤与 `SELECT` 的 `case` 收敛口径不一致（实测）

- 证据：`apps/server/src/queries/deliveries.ts:59`（`case when w.decision in ('triggered','ignored') then w.decision end`）vs `:99-103`（`w.decision is null` / `w.decision = $`，都是**裸列**）。
- 实测（探针 A vs B）：`decision='error'` 的行在响应里是 `decision: null`（显示「未判定」），但 `decision=pending` 筛不到它、`triggered` / `ignored` 也筛不到 —— 三种筛选都查不到的一行，却出现在默认列表里。
- 影响：只在库里出现契约外取值时发生（当前唯一写入方不会产生），属**口径裂缝**而非现网故障；但它恰好发生在本包自己写的那段 `case` 上，且没有用例覆盖。修法一行：把过滤条件也写成同一个 `case` 表达式（`… is null` / `… = $`）。

### 中-3（既有写入口，非本包引入）`repo-disabled` 被四类投递复用；缺签名 401 无留痕行

- 证据：`apps/server/src/http/webhook.ts:997-1014` 的兜底对**所有** `trace.decision === null && payload !== null` 的投递一律 `repoDisabled: true`，于是：暂停（`:1151-1155`）、安装事件（`:1129-1141`）、`installation` 不匹配（`:1180-1192`）、读仓库策略失败 500（`:1167-1170`）、未知仓库（`:1174-1176`）全部落成 `repo-disabled`。
- 这正是 `:1004-1005` 注释里记的 issue #30 那类误标的**同一个坑，换了分支**：运维看到 `repo-disabled` 去查 `repos.enabled`，而真正原因是暂停 / secret / 内部 500。BR-6 要的是「原因」，这里给的是「仓库不可用」。
- 另有：缺签名 401（`:1068-1072`）与非 JSON 400（`:1052-1058`）**没有投递行**，而 `writeV21Decision` 是 `UPDATE`（`webhook-v21.ts:316`）且**不校验 `rowCount`**（`:320-327`），0 行更新静默成功 —— 所以连「留痕失败」的 warn 都不会打。
- 归属：HEAD 已有（`handleWebhook` 包装与 `V21_DECISION_SQL` 都是已提交代码，diff 里没有新增行）。**不是本包越界**，但本包报告把它算进了「12 个原因都可查」，需要在 C4 里登记。
- 测试缺口：全仓无任何用例钉住「暂停 / 安装事件 → reason 是什么」，也无用例断言缺签名 401 后的投递行（`apps/server/test/http-server.test.ts:392-423` 只断言状态码与错误码）。

### 低-1 时间窗「左闭右开」在测试里没被真正钉住

- 证据：`apps/server/test/queries-deliveries.test.ts:144-158` 用 `01:30~03:30` 命中 `03:00`/`02:00`，**没有任何一行恰好等于 `from` 或 `to`**。把实现改成 `>` / `<=` 这套用例照样绿。
- 我的探针 D 证明当前实现是正确的（`p-at-from` 命中、`p-at-to` 不命中，对应 `deliveries.ts:93-94`），但**证据来自我的临时探针，不在仓库用例里**。补两行种子即可（见 C3）。

### 低-2 `case` 收敛分支无测试

- `deliveries.ts:59` 的 `case` 是为「契约外取值不让整页 `parse()` 失败」而写的，但没有任何用例构造过契约外取值（测试种子只有 `null` / `triggered` / `ignored`，`queries-deliveries.test.ts:39-47`）。我探针 A 手工验过行为符合设计。

### 低-3 `limit=0` 直连查询层 → `items: []` 但 `hasMore: true`、`nextCursor: null`

- 证据：`deliveries.ts:89`（`Math.min(query.limit ?? 50, 200)`，无下界）→ `:134-142`（`page` 为空、`last` 为 `undefined` → `nextCursor` 落 `null`，但 `hasMore` 仍为 `true`）。探针 E 证实取到 1 行。
- 影响：HTTP 层被契约 `pageLimitSchema.min(1)`（`packages/contract/src/common.ts:95`）拦住，只有绕过契约直接调 `queries` 才会触发（面板若直接 import 查询层就会踩到）。属防御性缺口，不阻断。

### 低-4 `repo is null` 的投递查不到（已披露，但影响面被低估）

- WP1.md 第四节第 2 条已披露。补充：安装事件（`webhook.ts:1129-1141`）正是 `repo = null` 这一类，且它们的 `decision_reason` 被写成 `repo-disabled`（见中-3）—— 既查不到又记错原因。

### 低-5 `content-duplicate` 当前不可达

- `decide.ts:246-248` 只经入参 `contentDuplicate: true` 触发，而 `webhook-v21.ts:167` / `:238` 只做转发，`webhook.ts` 从不传 `true`（grep 全仓无调用方）。读侧不需要改（原样透传没丢），但这条原因现在写不进库，别把它算进「已覆盖」。

### 低-6 报告里的数字错了

- `WP1.md:21` 写「契约注释里列了 13 个已知取值」，实际是 **14** 个（`packages/contract/src/api.ts:1140-1142`：`enabled`、`conditional-met` + 12 个 skipped）。`WP1.md:4` 的「12 个原因」指 skipped 那一半，字面没错，但和上一句放在一起容易被读成总数。

### 低-7 新端点没有 OpenAPI path

- 实测 `openapi/pi-bot.openapi.json` 是 **9 paths / 51 schemas**，paths 里没有 `/api/repos/{owner}/{name}/deliveries`；组件 `DeliveryRow`（`:1118`）/ `DeliveriesResponse`（`:1086`）在，字段与本包契约一致（`maxLength: 128`、`items.maxItems: 200`）。
- 原因属实：生成器 `packages/contract/scripts/gen-openapi.ts:34` 的 `Endpoint.pathParam` 是单个字符串，`:244` 只塞一个 path 参数，写不出两段路径。WP1 没改生成器，符合「只改 queries / api / contract / openapi / test」的边界。
- 残留：WP11 面板做事件时间线时**不能**从 OpenAPI 派生出这个端点，只能直接从 `packages/contract` 导 `DeliveryRow` / `DeliveriesResponse` 类型（AGENTS §8.4 允许，因为事实源是 zod）。

---

## 四、越界与误伤

- **声明文件全为纯增**（`git diff --numstat`）：`http/api/index.ts` 24/0、`queries/index.ts` 19/0、`queries/types.ts` 17/0、`packages/contract/src/api.ts` 74/0、`schemas.ts` 11/0；两个新文件未跟踪（`?? queries/deliveries.ts`、`?? test/queries-deliveries.test.ts`）。**没有一行删除/改签名**，符合 AGENTS §8.1「只许加，不许改名」。
- **`openapi/pi-bot.openapi.json` 139 增 / 162 删不是本包造成的**：本包只往里加两个组件（5 行含 `Delivery` 的 diff 全在新增侧），162 行删除来自并行 `settings-v21` 契约改动混进同一份产物 —— 与 WP1.md 第四节第 4 条自述（产物被外部覆盖过）一致。合并前应重跑一次 `gen:openapi`（见第五节）。
- **未碰禁改目录**：在 `apps/server/src/{agent,app,writeback,worker,runtime}` 的 diff 里搜 `deliver|Deliver`，唯一命中是既有 `insertTask` 的 `delivery_id` 列名（`webhook.ts` 原有 SQL），与留痕查询无关。`agent/` `runtime/` `worker/` `writeback/` 的改动来自本基线已记录的 WPs / 并行 session，本包没有足迹。
- **`http-server.test.ts` 的 +87 行不是本包的**：内容是 `describe('面板静态资源（panelDistDir）')` 两个用例，属 P0-1/静态托管那条线；WP1.md 的文件表也没声称改它。
- **误伤核对**：`apps/server/src/app/compose.ts:920` 的 `panelDistDir` 注入完好；`apps/server/src/agent/canonical-text.ts` 的 `normalizeForIdempotency`（`:27`）、`stripAliases`（`:46`）、`stripAliasMentions`（`:57`）三个函数都还在且互相独立。**未发现误伤。**
- **只读约束**：`apps/server/src/queries/deliveries.ts` 全文只有一条 `select`（`:117-131`），import 只有 `./sql.ts`（`Params`/游标/窗口工具）与 `./types.ts`（契约派生类型），**不含任何业务模块**；`npx eslint` 覆盖 lint zone 后 exit 0。
- **AGENTS §11**：无 `any` / `@ts-ignore` / `@ts-expect-error`（grep 0 命中）；新模块 145 行（≤500）；注释写「为什么」（`deliveries.ts:10-19`、`:54-58`、`:71-73`）。
- **一处越界式表述**（文档而非代码）：`WP1.md:114` 的残余风险第 3 条说「如果将来库里出现第三种判定值，面板会显示未判定而不是错误」—— 这正是中-2 的裂缝，报告把它当成了纯粹的「已知取舍」，但没提 `decision=pending` 会因此筛不到这些行。

---

## 五、不确定处（诚实标注未验证项）

1. **`openapi` 是否与当前契约完全同步 —— 未验证**。我没跑 `pnpm gen:openapi`：产物是共享的跟踪文件，此刻其它 session 正在改 `packages/contract/src/settings-v21.ts`，重跑可能把别人写了一半的契约固化进去（WP1.md 第四节第 4 条记录过同类事故）。我只核了本包自己的两个组件（`DeliveryRow` / `DeliveriesResponse`）与契约逐字段一致。**合并前必须重跑一次并确认 9 paths / 51 schemas。**
2. **全量测试未复跑**。并行改动使失败归因不可判；WP1.md 报的两个失败项（`app-wiring` 的 `concurrency_per_repo`、`v21-integration` 的模板渲染进 `comment_body`）我既没复核也没反驳，交由编排侧在全量轮次判定。
3. **「缺签名 401 无留痕行」是静态证据**：`insertDelivery` 全仓只有 `webhook.ts:1088`、`:1103` 两处调用，而 `:1071` 的 401 return 在两者之前 —— 逻辑上不可能有行；`writeV21Decision` 是 `UPDATE` 且不查 `rowCount`。我**没有**写临时用例实证（会改动仓库测试目录，超出「不改代码」约束）。
4. **中-1（出范围事件永久 `null`）未做端到端实证**：需要在真实装配下投一次 `push` 事件再查库。静态链路（`v21EventKeyOf` 返回 `null` → `decideV21Delivery` 返回 `null` → 只在非 `null` 时写）是闭合的，但没有运行时证据。
5. **中-3 的归属判断依赖「HEAD 已有」这一事实**：`git diff -U0 -- apps/server/src/http/webhook.ts` 里没有新增 `handleWebhook` / `V21_DECISION_SQL` / `skipDecision` 行（只有 quota 相关的 3 行新代码），所以我判定兜底逻辑与「401 落行」都是已提交行为。若编排侧认定这段在本轮被改过，严重度需重估。
6. **`decision` 列没有 DB 层约束**（`db/schema.ts:112` 是裸 `text`）：本包靠 `case` 兜底是对的，但也意味着「库里出现第三种值」不会被任何机制挡住。是否加 CHECK / 枚举迁移，属 schema 工作包，不在本包范围。

---

## 六、结论与条件

**有条件通过。** 本包把 BR-6 缺的那一半（读）补上了，实现是只读、纯增量、断言具体值，且「原因原样透传」的取舍正确 —— 没有把任何真实原因收敛成 `null`。不通过的点都不在「本包写错了」，而在「口径没说全」与「把既有写入口缺口算成了已覆盖」。

终态通过的四条条件：

| # | 条件 | 归属 |
|---|---|---|
| C1 | 定「不在判定范围」的口径：要么让 `webhook.ts` 对 `v21EventKeyOf === null` 的投递写一条明确判定（如 `ignored` + 新原因 `out-of-scope`，需同步 `decide.ts` 联合与契约注释），要么在契约注释里写明 `null` 同时含「未判定」与「不在判定范围」，并让 `decision=pending` 在面板上不当作「待补」 | 编排侧决策 + 契约（WP1 收尾） |
| C2 | 把 `decision=pending` 的过滤改成与 `deliveries.ts:59` 同一个 `case` 表达式，消除「显示未判定但三种筛选都查不到」的裂缝；补一个契约外取值的用例 | WP1，2 行 + 1 用例 |
| C3 | 时间窗用例补两行种子（恰好等于 `from`、恰好等于 `to`），把左闭右开钉死在测试里（探针 D 已证明实现正确） | WP1，测试 |
| C4 | 把「缺签名 401 / 非 JSON 400 无留痕行」「暂停 / 安装事件 / 500 被记成 `repo-disabled`」「`repo is null` 查不到」「`content-duplicate` 无写入方」登记为缺口（`docs/project-overview.html` §10 或后续工作包清单），并把 `WP1.md` 里「12 个原因都可查」「13 个取值」两处说法改准（实为 14 个） | 编排侧 + 文档 |

报告任何一处与本次实测不符的，以本文为准。
