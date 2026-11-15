# WP1 审查（第二轮）· 留痕可查（BR-6 / FR-6.4③）

审查者：独立 review session（角度：**需求契合**；默认假设实现有问题，先找反证）
被审对象：`docs/audit/fix/WP1.md` 的读侧交付 + 上一轮 `docs/audit/fix/WP1-REVIEW.md` 提出的 4 条条件的处理情况。
需求原文：BR-6（`docs/requirements.html:1791`）「未通过开关或闸门的事件，必须记录判定结果与原因，**可在后台查询**」；FR-6.4③（`:1216`）「事件时间线：投递 → 判定 → 执行 → 写回；**被忽略的事件也能看到原因**」；旁证：`:741` FR-1.2「校验失败返回 401，但**仍要落库留痕**」、`:918` FR-3.5「跳过要留痕：判定为重复时不静默丢弃，记一条「因重复内容跳过」，后台可查」、`:573`「本期不处理 PR 事件……按未触发处理并**留痕**」。

## 结论：**有条件通过**

读侧（本包真正交付的东西）没有问题，上一轮的 **C2 / C3 两条我判为真闭合**，而且我用真库做了变异实测，不是只读代码。
但 BR-6 作为一个整体**还不能算成立**：两条被我判为「必须修」的条件都不是新的排版问题 ——

1. **C1 未闭合**（`decision=null` 把「不在判定范围」也吞了；实测 `push` / `issues.reopened` 的投递行既无判定也无原因，且会出现在 `decision=pending` 里）；
2. **C4 的第一条是 FR-1.2 的明确违约**，不是「已知缺口」：缺 `X-Hub-Signature-256` 的投递**连行都没有**（实测 401 + 库空），而外层明明已经算出了 `signature-invalid` 这条结论 —— 它被一个不查 `rowCount` 的 `UPDATE` 静默吞掉了。

另外我发现一条上一轮没抓到的**读侧口径错误**（不是写侧缺口）：内容重复被丢弃的投递，留痕写的是 `triggered` / `enabled`（第四节 新-1）。这条直接违反 `requirements.html:918`。

审查口径声明：本轮工作区仍在并行改动（`apps/server/src/trigger/decide.ts` 在我审查期间从 289 行变成 330 行）。我引用的行号以**最后一次读取时刻**为准；`webhook.ts` 的 `+19/-3` 是日配额（§6.7 SL-3）与 `aliases` 那批并行改动，不是本包足迹，未评估。

---

## 一、C2 / C3 是否真的闭合

### C2 `decision=pending` 过滤口径 —— **闭合**

**① 「显示口径」与「过滤口径」是否同一处事实源：是。**
`apps/server/src/queries/deliveries.ts:59` 定义唯一常量 `DECISION_SQL`，三处引用：

| 位置 | 用法 |
|---|---|
| `queries/deliveries.ts:103` | `where.push(`${DECISION_SQL} is null`)`（pending） |
| `queries/deliveries.ts:105` | `where.push(`${DECISION_SQL} = ${values.add(query.decision)}`)`（triggered / ignored） |
| `queries/deliveries.ts:126` | `select …, ${DECISION_SQL} as decision, …`（显示） |

上一轮的「屏幕上一行、三种筛选都查不到」的裂缝在结构上已经不存在：任何对 `decision` 列的解释都必须经过同一个 `case`。注释 `:99-101` 也把「为什么不能写裸列」写成了理由而不是复述代码。

**② 新用例是否真的断言了可观察事实：是，而且我实测它能把修复前的实现判红。**
`apps/server/test/queries-deliveries.test.ts:175-199`：

- 种子 `v-weird`：`decision='error'`、`decision_reason='something-new'`（`:182-183`）；
- `:189` `expect(weird).toMatchObject({ decision: null, decisionReason: 'something-new' })` —— 收敛后的值与**原样保留的原因**都断言了；
- `:191-192` pending 筛出 `['v-pending','v-weird']`（具体 id 数组，不是长度）；
- `:195-198` triggered / ignored 都 `not.toContain('v-weird')`。

真库变异实测（探针脚本见第三节，临时仓库 `review/probe-wp1b`，跑完已删）：

```
C  case 口径 (${DECISION_SQL} is null)   → ["b-weird","b-null"]
C1 旧实现 裸列 (w.decision is null)      → ["b-null"]      ← 少一行
=> 用例期望 ['v-pending','v-weird'] 在旧实现下会变成 ['v-pending'] → 红
```

结论：这条用例**不是弱断言**，它钉住了「契约外取值也必须出现在 pending 里」。

唯一可挑的微瑕：`:196`/`:198` 只用 `not.toContain`，若某天 `ignored` 筛出**空集**，这两行仍然绿。但 `:227-245` 的「筛选：decision=triggered/ignored/pending 与 event 各自收窄」用 `toEqual` 钉了同一组筛选的完整结果，所以不构成实质风险，不阻断。

**③ 这个「契约外取值显示成未判定」的口径本身：仍然是个问题，建议至少补一个可区分的取值。**
现在 `decision=null` 一个值要同时承载三种含义：

| 含义 | 现在的表示 | 谁能区分 |
|---|---|---|
| 还没判定（v2.1 之前的历史行 / 正在处理） | `null` | 不能 |
| **不在判定范围**（push / label / issues.reopened…，见 C1） | `null` | 不能 |
| **契约外取值**（手工修库 / 未来新值） | `null` | 只能靠 `decisionReason` 原样保留来猜 |

更要紧的是：`db/schema.ts:106-112` 用「前者会重试」来解释 `null`，而**这句话在现网不成立**——投递级幂等命中后 `trace.skipDecision = true`（`http/webhook.ts:1117-1119`），同一条已存在的投递不会再被重判、也不会重试；真正「正在处理中」的窗口只有一次请求的毫秒级。所以 `null` 事实上已经退化成「**没有结论的行**」，而契约注释（`packages/contract/src/api.ts:1124-1126`）还写着「还会重试/待补」。

建议（按成本排序）：

1. **最小**：契约加一个只读派生字段 `decisionState: 'triggered' | 'ignored' | 'pending' | 'unknown'`（纯加、不改名，符合 AGENTS §8.1），`unknown` 即「库里是契约外取值」；面板既能显示「这条数据脏了」，也不必整页 `parse()` 失败。
2. 或者：行里多带一个 `decisionRaw: string | null`（原始列值），把「怎么展示」交给面板。
3. **不推荐**只保留现在的 `case` 静默收敛 —— 它把脏数据变成沉默，而这接口的用途恰恰是「出问题时来查」。

### C3 左闭右开是否钉死 —— **闭合（我推演并在真库上跑了变异）**

用例 `apps/server/test/queries-deliveries.test.ts:147-159`：

| 断言 | 数据 | 若实现改坏会怎样 |
|---|---|---|
| `:147-152` `from = 02:00`（恰等于 `v-switch-off`）→ 期望 `['v-triggered','v-switch-off']` | 窗口 `[02:00, 04:00)` | 把 `>=` 改 `>`：`v-switch-off` 掉出 → 探针 A1 = `["b-mid"]` → **红**。把 `<` 改 `<=`：`v-sig-bad` 恰在 `04:00 = to` → 探针 A2 = `["b-to","b-mid","b-from"]` → **红**（这一点是额外收获：右端也被这条压住了） |
| `:154-159` `to = 02:00`（恰等于 `v-switch-off`）→ 期望 `['v-unmentioned']` | 窗口 `[01:00, 02:00)` | 把 `>=` 改 `>`：`v-unmentioned` 恰在 `01:00` 掉出 → 探针 B1 = `[]` → **红**。把 `<` 改 `<=`：`v-switch-off` 混进 → 探针 B2 = `["b-from","b-low"]` → **红** |

补充一条隐性前提，我也核了：`resolveWindow`（`queries/sql.ts:158-167`）用 `toISOString()` 原样返回边界，**不做取整/截断**，所以「恰好等于」是真相等，不是靠毫秒精度侥幸。结论：**两个方向、两端边界都被钉住，C3 闭合。**

---

## 二、C1 / C4 裁决：BR-6 现在到底成不成立

**一句话**：「判定过的都查得到」成立；「没判定的也留了痕」只做到了一半 —— **留了行，没留原因**。

### C1 `decision = null` 的「不在判定范围」口径 —— **未闭合（判为部分未实现 FR-6.4③）**

实测（真 `handleWebhook` + 真库，探针见第三节）：

```
C1 push            status=200 action=ignored row={"delivery_id":"p2-push","event":"push","action":null,
                                                  "decision":null,"decision_reason":null,"signature_valid":true}
C1 issues.reopened status=200 action=ignored row={"delivery_id":"p2-reopened","event":"issues","action":"reopened",
                                                  "decision":null,"decision_reason":null,"signature_valid":true}
```

链路：`http/webhook-v21.ts:98-121`（`v21EventKeyOf` 对 `push` / `label` / `issue_comment.edited|deleted` / `issues.reopened|assigned` 一律 `null`）→ `:173-190`（`decideV21Delivery` 返回 `null`）→ `http/webhook.ts:1016`（只有非 `null` 才写）→ 而投递行在 `:1103` 已经落库。

**我的裁决：按 BR-6 字面「部分成立」，按 FR-6.4③ 与 §8 判「未实现」。** 理由三条，第二条最关键：

1. BR-6 的字面只说「未通过**开关或闸门**的事件」——`push` 没进开关也没进闸门，字面上不覆盖它，所以不能说「违反 BR-6」；这一点我给实现方一半的免罪。
2. **但实现内部自相矛盾**：需求 `:573` 写的是「本期不处理 PR 事件……按未触发处理并**留痕**」，实现也确实照做了（`decidePullRequest()` → `ignored` + `pr-ignored`，`trigger/decide.ts:312-316`）。同一个「不纳入本期范围」的语义，PR 上有原因、`push` 上什么都没有 —— 这不是口径选择，是**同一个决定没有铺到同类事件**上。
3. FR-6.4③ 要的是「**被忽略的事件**也能看到原因」，§8 数据需求把「事件投递」的用途写成「排查**为什么没处理**」。`push` 的投递行既给不出原因，`action` 也是 `null`（实测），面板画时间线时「判定」那段只能空着。

**影响不是理论上的**：这些行因为 `case` 收敛后就是 `null`，所以会出现在 `decision=pending` 里（这正是 C2 的同一处口径）。组织级 webhook 上 `push` 的量远大于 issue 事件，**「待处理」视图会被永不判定的行淹没**，这一列在面板上等于废掉。另外注意：目前 `apps/panel` 里还没有任何 `deliveries` 消费方（我 grep 过，0 命中），所以现在**只有 API 层被污染**，WP11 做面板前必须先把这条口径定下来。

**最小修法（我推荐的顺序）**：

1. 在 `http/webhook.ts:997-1015` 那个统一写判定的位置加一条：先按现状试 `decideV21Delivery(...)`，若仍为 `null`，就写常量 `decision='ignored', decision_reason='out-of-scope'`。**不要**硬造一个假 `EventKey` 塞进 `decideEvent()`——那会污染 §2 的判定顺序语义（`decide.ts:32-52` 的联合也没有对应成员）。
2. 配套：`SkippedReason` 加 `'out-of-scope'`（`trigger/decide.ts:32-52`）、`packages/contract/src/api.ts:1140-1142` 的已知取值注释同步、`db/schema.ts:116-120` 同步。
3. 补 1 条用例：`push` 投递 → `decision=ignored` / `decision_reason=out-of-scope`，且 `decision=pending` 筛不到它。成本约 10 行 + 1 用例。

**我不推荐的替代方案**：只在契约注释里写明「`null` 同时含未判定与不在判定范围」，然后要求面板不把 `pending` 当「待补」。那等于承认「留痕」对组织级 webhook 的主要流量不成立；而且面板要自己维护一份「哪些事件在判定范围」的白名单，就是第二处事实源（第一处是 `v21EventKeyOf`），迟早分叉。

### C4 写入口缺口 —— 逐条严重度

上一轮判定这些是 HEAD 已有的、非本包引入。**我复核后同意归属判断**（`git diff` 里 `webhook.ts` 只有 quota 与 `aliases` 那几行，`handleWebhook` 包装与 `V21_DECISION_SQL` 都没有新增行），但**归属不等于可以放过**：BR-6 是需求条目，不是本包私有义务。

| # | 缺口 | 严重度 | 证据（实测 / 静态） |
|---|---|---|---|
| 1 | **缺 `X-Hub-Signature-256` → 401 且不落行** | **高（FR-1.2 违约）** | 实测：`status=401 row=undefined`。`http/webhook.ts:1068-1072` 的 `return` 在 `insertDelivery`（`:1088`/`:1103`）之前。更糟：外层已经算出结论（`:1007-1014` 对 `status===401` 传 `signatureInvalid: true` → `signature-invalid`），却由 `writeV21Decision`（`webhook-v21.ts:314-327`）发 `UPDATE` 打空、`rowCount` 不校验 → **连 warn 都没有**。FR-1.2（`:741`）原话是「校验失败返回 401，但**仍要落库留痕**」 |
| 2 | body 不是 JSON → 400 且不落行 | **低** | 实测 `status=400 row=undefined`。`:1052-1058` 早于落库；此时 `trace.payload` 保持 `null`，连决策都不算。要落行得先存原始文本，而 `payload` 列是 `jsonb` —— 属「改表结构 or 接受」，登记即可 |
| 3 | **暂停 / 安装事件 / 安装不匹配 / 读策略 500 / 未知仓库 全记 `repo-disabled`** | **中** | 实测：暂停（`action=paused`）的行 `decision_reason=repo-disabled`；未知仓库（`repos` 无行）也是 `repo-disabled`。对照组：有签名但验签失败的行是 `signature-invalid` —— 说明作者**已经知道**「病因必须分开记」（`decide.ts:47-51` 的注释就是 issue #30 的教训），只是没铺到这五条路径。源码在 `http/webhook.ts:997-1014` 的兜底 `repoDisabled: true`，分叉点在 `:1151-1155`（暂停）、`:1129-1141`（安装事件）、`:1180-1191`（安装不匹配）、`:1167-1170`（500）、`:1174-1176`（未知仓库） |
| 4 | `V21_DECISION_SQL.write` 是 `UPDATE` 且**不校验 `rowCount`** | **中** | `http/webhook-v21.ts:314-327`：0 行更新静默成功。它是 #1 的放大器（算出了结论、写不进去、还没人知道）。修法约 3 行：`const r = await db.query(...); if ((r.rowCount ?? 0) === 0) throw new Error(...)` —— 调用方 `webhook.ts:1020-1026` 已有 catch → warn，改完「静默丢失」就变成可观测 |
| 5 | `content-duplicate` 当前不可达 | **中（且比上一轮写的更严重）** | 见下面「新-1」：不是「原因写不进库」，而是**留痕主动写错** |

**BR-6 成不成立的完整判定**：

- **读侧**：成立。只读、纯增量、`decisionReason` 原样透传（`deliveries.ts:62`）、契约 `z.string()` 而非 `z.enum`（`api.ts:1160`）—— 这三点做得对，我上一轮的判断维持不变。
- **写侧 · 判定过的事件**：成立。12 个 skipped 原因里 11 个可达且可查（`decide.ts:32-52` 的联合，加上 `TriggeredReason` 2 个共 14 个取值）；不可达的只有 `content-duplicate`，而它的替代路径写错了（新-1）。
- **写侧 · 没进入判定的事件**：**不成立**（C1）。
- **写侧 · 连行都没有的投递**：**不成立**（C4-1 缺签名，C4-2 非 JSON）。

所以：**「留痕可查」这道需求现在只覆盖了「有判定结论的投递」。** 对 BR-6 最典型的验收场景（「我明明没让它跑，为什么它跑了 / 为什么它没跑」）来说，第 1 类（开关关掉、闸门拒绝、配额触顶、验签失败）已经能回答；第 2、3 类还不能。

---

## 三、实跑结果（命令 + 真实输出）

环境前提必须先声明：**开工时 PostgreSQL 不在**（`127.0.0.1:5432` 拒绝连接，本机无 `psql`/`pg_ctl`、无 postgres 服务、WSL 里也没有，Docker Desktop 是停的）。我起了 `com.docker.service` + Docker Desktop，`postgres18` 容器（`postgres:18`，`127.0.0.1:5432->5432`）随之起来后才跑通。**这对我之外的 session 是环境变化。**

| # | 命令（`apps/server` 下） | 结果 |
|---|---|---|
| 1 | `npx tsc --noEmit` | exit 0，无输出 |
| 2 | `npx vitest run test/queries-deliveries.test.ts` | **1 file / 12 tests passed**，2.00s（上一轮是 11 个 → 新增的 C2 用例在位） |
| 3 | `npx vitest run test/queries-deliveries.test.ts test/http-server.test.ts` | **2 files / 36 tests passed**（12 + 24），4.44s |
| 4 | 真库变异探针 `probe-wp1b.cjs`（只碰临时仓库 `review/probe-wp1b`，跑完自删） | 见下 |
| 5 | 真库写入口探针 `probe-wp1d.test.ts`（真 `handleWebhook`，临时仓库 `review/probe-wp1b2`，跑完自删） | 见下 |
| 6 | 清理核对：`webhook_deliveries` / `repos` / `runtime_flags` 里 `p2-%`、`b-%`、`review/%` 残留 | 全部 **0** |

**探针 4（C2/C3 变异）真实输出**：

```
=== C3：时间窗 [02:00, 04:00) 左闭右开 ===
A  正确实现 (>= from and < to)      ["b-mid","b-from"]
A1 变异 from: >                     ["b-mid"]
A2 变异 to: <=                      ["b-to","b-mid","b-from"]
=== C3：时间窗 [01:00, 02:00) 两端恰好压住种子 ===
B  正确实现                         ["b-low"]
B1 变异 from: >                     []
B2 变异 to: <=                      ["b-from","b-low"]
=== C2：pending 过滤（case 口径 vs 裸列口径）===
C  case 口径 (${DECISION_SQL} is null)  ["b-weird","b-null"]
C1 旧实现 裸列 (w.decision is null)     ["b-null"]
D  ignored 用 case                      ["b-to","b-from","b-low"]
D1 triggered 用 case                    ["b-mid"]
判读：A/A1/A2/B/B1/B2 六条都与用例期望值对应 —— 两个方向的变异都会红
```

**探针 5（写入口）真实输出**（库里的行，`undefined` = 没有这一行）：

```
C1 push             status=200 action=ignored  row={"event":"push","action":null,"decision":null,"decision_reason":null,"signature_valid":true}
C1 issues.reopened  status=200 action=ignored  row={"event":"issues","action":"reopened","decision":null,"decision_reason":null,"signature_valid":true}
C4-1 缺签名        status=401 row=undefined
C4-2 非JSON        status=400 row=undefined
C4-3 验签失败      status=401 row={"decision":"ignored","decision_reason":"signature-invalid","signature_valid":false}   ← 对照组：正常
C4-4 暂停          status=200 action=paused  row={"decision":"ignored","decision_reason":"repo-disabled",...}
C4-5 仓库禁用      status=200 action=ignored row={"decision":"ignored","decision_reason":"repo-disabled",...}
C4-6 未知仓库      status=200 action=ignored row={"decision":"ignored","decision_reason":"repo-disabled",...}
```

（探针 5 的 vitest 断言我写错了条数，用例本身报红 —— 这是**我的**脚本问题，与仓库无关；上面这 8 行是它跑出来的真实库内容，不影响结论。）

---

## 四、发现的新问题

### 新-1（中）内容重复的投递，留痕写的是「已触发 / enabled」

- 事实链：`http/webhook-v21.ts:1403-1418` 在 `insertMessage()` 之后才发现 `saved.inserted === false`（内容级去重命中），返回 `duplicate`；而结论是在**更早**的 `webhook.ts:1199` 算出来的（`triggered` / `enabled`），并由 `:1019` 在管线返回后写进投递行。所以：**一条被判为「重复内容、什么都没跑」的投递，`decision=triggered`、`decision_reason=enabled`。**
- 需求对照：`requirements.html:918`「跳过要留痕：判定为重复时不静默丢弃，记一条「因重复内容跳过」，后台可查」—— 现在不但没记「因重复跳过」，还记成了「已触发」。
- 这比上一轮的「`content-duplicate` 不可达」严重：不可达只是漏记，这里是**读出来的结论主动错了**，面板上会显示成「这条事件处理过了」。
- 修法（择一）：① `handleV21Webhook` 返回 `duplicate` 时，让外层把投递行改写成 `ignored` / `content-duplicate`（`webhook.ts:1299-1301` 已经拿到 `outcome`，位置现成）；② 或者把内容级去重的判据前移到 `decideEvent()` 之前（那要动 FR-3.5 的三层顺序，属另一个工作包）。
- 证据强度：**静态**（代码顺序清楚）。探针 5 里我想实证，但合成仓库的 `settings` 过不了 v2.1 校验，走不到 `triggered` 分支（见第五节 1）。

### 新-2（中）`db/schema.ts` 的列注释解释了错的理由

`apps/server/src/db/schema.ts:106-112`：「`null` = 还没判定完……**前者会重试**」。实际：投递级幂等命中后 `trace.skipDecision = true`（`http/webhook.ts:1117-1119`），已存在的投递**不会再判一次**。加上 C1 那批永久 `null` 的行，注释里描述的那类「会重试的 null」在现网几乎不存在。AGENTS §11 要求注释写「为什么」，这里写的是一个不成立的为什么 —— 建议在 C1 定调时同批改。

### 新-3（低）`limit` 无下界（上一轮低-3，仍未修）

`queries/deliveries.ts:89` `const limit = Math.min(query.limit ?? 50, 200)`：直接调查询层传 `limit: 0` → `items: []` 但 `hasMore: true`、`nextCursor: null`（`hasMore` 由多取一行的 `rows.length > limit` 决定）。HTTP 层被契约 `pageLimitSchema.min(1)` 拦住，只有绕过契约（例如面板直接 import `queries`）才踩到。加 `Math.max(1, …)` 一行即可。

### 新-4（低）OpenAPI 仍无 `deliveries` 路径

实测 `openapi/pi-bot.openapi.json`：**9 paths / 51 schemas**，paths 里没有 `/api/repos/{owner}/{name}/deliveries`；组件 `DeliveryRow` / `DeliveriesResponse` 在。原因是生成器 `Endpoint.pathParam` 只支持单段（`packages/contract/scripts/gen-openapi.ts`），WP1.md 已披露。残留：WP11 面板做事件时间线时**不能**从 OpenAPI 派生该端点。

### 新-5（低）`WP1.md` 的「12 个原因」容易读错

`WP1.md:4` 与 `:21`（「契约注释里列了 13 个已知取值」）—— 实际 `trigger/decide.ts:29-52` 是 `TriggeredReason` 2 个 + `SkippedReason` 12 个 = **14**，`packages/contract/src/api.ts:1140-1142` 列的也是 14 个。上一轮已提，仍未改。

### 新-6（观察）`push` 这类事件的投递行 `action` 为 `null`

实测（探针 5 C1）：`event="push"` 的行 `action=null`。面板画时间线时「投递」那段需要用 `event` 兜底文案，别假设 `action` 一定有值（契约 `api.ts:1153` 允许 nullable，这一点契约是对的）。

---

## 五、我不确定的地方

1. **新-1 只有静态证据，没做成端到端**。探针 5 的合成仓库 `settings = {"version":1}` 过不了 v2.1 校验，四次调用全部落在 `repo-disabled`（`action=ignored`），走不到 `triggered` → 无法把「内容重复」这一条实证出来。要实证需要一份合法 settings 或改库里的 `repos` 行，超出「只读审查」的范围。
2. **C4-3 里的归因细节**：「暂停」这一条我用 `action=paused` 与 `decision_reason=repo-disabled` 的**并存**把它干净地隔离出来了；但「仓库禁用」与「未知仓库」两条在库里长得一样，我只能靠静态读码（`:1174-1176` 在 `:1194` 之前 return）判定它们走的是外层兜底。这个区分不了本身**就是**问题，但我无法从数据层证伪。
3. **我动了环境**：起了 `com.docker.service` 与 Docker Desktop（`postgres18` 容器随之启动）。如果这不该由审查者做，请停掉；我不会再动。
4. **`decide.ts` 在本轮审查中被并行 session 改动**（289 → 330 行），我给的 `decide.ts` 行号是最后一次读取时的状态；`webhook.ts` 的 quota 改动我**未**评估（属另一工作包）。
5. **全量测试没跑**（按任务只跑指定三条）。`openapi` 我也没重跑 `gen:openapi`：契约（`settings-v21.ts` 等）正在被别人改，重跑会把半成品固化进产物（WP1.md 第四节记录过一次同类事故）。
6. **面板侧无法评估**：`apps/panel` 里目前 0 处 `deliveries` 引用，C1 里「`pending` 在面板上不该当待补」这一半要等 WP11 落地才能验。

---

报告任何一处与本文实测不符的，以本文为准。**我没有改任何代码，也没有 `git add` / `commit`。**
