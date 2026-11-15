# WP1-R · 留痕可查收口（写入口）

- 任务书：`docs/audit/fix/WP1-REVIEW2.md`（第二轮复审）。上一轮读侧已交付并通过复审（C2 / C3 判为闭合），本包只补**写入口**的四个缺口 + 一条新发现。
- 需求原文：BR-6（`docs/requirements.html:1791`）「未通过开关或闸门的事件，必须记录判定结果与原因，**可在后台查询**」；FR-6.4③（`:1216`）「事件时间线……**被忽略的事件也能看到原因**」；旁证：`:741` FR-1.2「校验失败返回 401，但**仍要落库留痕**」、`:918` FR-3.5「跳过要留痕……记一条「因重复内容跳过」」、`:573`「本期不处理 PR……按未触发处理并**留痕**」。
- 未改需求文档。未 `git add` / `git commit`。未碰 `compact/**` `runtime/**` `queries/**` `writeback/**` `workflows/**` `agent/**` `queue/**` `db/schema.ts` `migrations/**` `apps/panel/**` `packages/contract/**`。
- **没有需要契约 owner 先做的事就能落地**（详见第五节：只有两处注释建议同步，不改 schema、不需要 `gen:openapi`）。

## 一、逐条对照

### ① C1：`push` 等出范围事件 `decision` 永久为 null —— **已修**

| 复审原文（`WP1-REVIEW2.md:90-117`） | 改前 | 改后 |
|---|---|---|
| `push` / `issues.reopened` 落行后 `decision=null, decision_reason=null`，且必然出现在 `decision=pending` 里 | 外层兜底只对「`decideV21Delivery()` 能判的事件」写判定；`v21EventKeyOf()` 返回 `null` 的事件（`push` / `issues.reopened|assigned` / `issue_comment.edited|deleted`）拿不到判定，`decision` 永远 `null` | 外层统一出口 `resolveTraceDecision()`：都没算出来 → `ignored` + 新原因 `out-of-scope`。**不再只改注释**，面板不必自己维护「哪些事件在判定范围」的白名单 |

证据：

- `apps/server/src/http/webhook.ts:1045` `resolveTraceDecision()`（单一留痕出口，三段口径写在同一处注释里）
- `apps/server/src/http/webhook.ts:1056` `return reasonOnlyDecision(trace.earlyExit ?? 'out-of-scope');`
- `apps/server/src/trigger/decide.ts:81` `| 'out-of-scope';`（联合新增，附「为什么需要它」的理由，引 `:573` 的 PR 同理）
- `apps/server/src/trigger/decide.ts:372` `reasonOnlyDecision()`（**不**硬造假 `EventKey`；复审第 113 行明确反对把假键塞进 `decideEvent()`）

用例：`apps/server/test/v21-webhook-trace.test.ts:153`（`push` → `ignored` / `out-of-scope`，且 `tasks` 0 行）、`:177`（`issues.reopened` 同）、`:195`（对照组：`issues.opened` 仍记 `triggered` / `enabled`，没被 `out-of-scope` 吃掉）。

> 复审第 115 行建议的「再补一个可区分取值」按最小面做完：`out-of-scope` 是新增原因，`decision=null` 不再承载「不在判定范围」。DB 层 `decision` 仍是 `triggered|ignored|null`（`db/schema.ts` 不在本包范围），`pending` 现在只剩「真没判定」的行。

### ② 缺签名 401 不落行（高，FR-1.2 明确违约）—— **已修**

| 复审原文（`WP1-REVIEW2.md:125`） | 改前 | 改后 |
|---|---|---|
| 缺 `X-Hub-Signature-256` → 401 且**连行都没有**；外层已算出 `signature-invalid` 却被不查 `rowCount` 的 `UPDATE` 静默吞掉 | `http/webhook.ts` 的 `signature === null` 分支直接 `return finish(401, …)`，早于 `insertDelivery` | **先落投递行，再判 401**；行带 `signature_valid=false` + `decision='ignored'` + `decision_reason='signature-missing'` |

证据：

- `apps/server/src/http/webhook.ts:1425` `recordUnauthenticatedDelivery()`——缺签名与验签失败**共用**这一个落库点（旧代码里验签失败那段是内联 INSERT，现在两处一个形状）
- `apps/server/src/http/webhook.ts:1112` `trace.earlyExit = 'signature-missing';`
- `apps/server/src/http/webhook.ts:1137` `trace.earlyExit = 'signature-invalid';`
- `apps/server/src/trigger/decide.ts:60` `| 'signature-missing'`（**新增**原因）

**关于「`signature-invalid` 还是新增 `signature-missing`」（任务书要求自己判断并说明）**：选了新增。两者都是 401，但一个要修 secret（对不上），一个要修投递链路（代理/中转没透传请求头）；混成一档，运维会拿着「签名对不上」去核对一个压根没发签名的请求——这正是 issue #30（驳回里 `decide.ts:47-51` 的教训）的同一种错。代价是一个新取值，面板按 `decisionReason` 字符串兜底展示，不需要改契约（`decisionReason` 是 `z.string()`，见 `packages/contract/src/api.ts:1186` 附近）。

**安全边界没有放宽**：缺签名分支只 `insertDelivery`（审计行）+ 立刻 `return finish(401, …)`，不进入任何业务分支；用例 `v21-webhook-trace.test.ts:248` 同时断言 `tasks` 0 行 + 401 + 行的三列值。

**顺带堵的一个新洞（复审没报，我自己加断言钉住）**：`insertDelivery` 是 `ON CONFLICT DO NOTHING`。如果同一条 delivery 之前**已验签通过并处理过**，一次未验签的重投原本会把它的 `decision` 覆写成 `signature-missing` —— 人为抹掉一次合法处理的审计。现在只有「刚插入的新行」或「原本就是 `signature_valid=false` 的行」才交给外层写判定（`webhook.ts:1445-1466`）。用例：`v21-webhook-trace.test.ts:211`。

### ③ `V21_DECISION_SQL.write` 是 UPDATE 且不校验 `rowCount` —— **已修**

| 复审原文（`WP1-REVIEW2.md:128`） | 改前 | 改后 |
|---|---|---|
| 0 行更新静默成功，连「留痕失败」的 warn 都没有；它是 #1 的放大器 | `await db.query(V21_DECISION_SQL.write, …)`，不看返回值 | 0 行 → 抛错，调用方 `catch` 记 warn（含 `deliveryId` + `reason`），静默丢失变可观测 |

证据：

- `apps/server/src/http/webhook-v21.ts:382` `if ((result.rowCount ?? 0) === 0) {` → 抛 `判定留痕没有落到任何投递行：delivery_id=… reason=…`
- `apps/server/src/http/webhook.ts:1018` 写入点（唯一）
- `apps/server/src/http/webhook.ts:1025` warn 消息：`v2.1 判定留痕失败（不影响应答）：delivery_id=… reason=…`（结构化字段里也带同两项）

注意复审建议的「`if ((r.rowCount ?? 0) === 0) throw`」原样采纳——调用方 `webhook.ts:1017-1027` 本来就有 catch → warn，改完即闭环，不需要新增日志通道。

用例：`apps/server/test/v21-webhook-trace.test.ts:400`（用 `source:'replay'` + `skipDeliveryDedup` 让 `UPDATE` 打空行 → 断言行确实不存在 **且** 有一条 warn 同时含 `trace-ghost` 与 `delivery_id=trace-ghost`）。变异实测：把 `if ((result.rowCount ?? 0) === 0)` 改成 `if (false && …)`，该用例单独变红（其余 12 条仍绿），见第四节。

### ④ 外层兜底把所有非 issue 投递记成 `repo-disabled`（原因失真）—— **已修**

| 复审原文（`WP1-REVIEW2.md:127`） | 改前 | 改后 |
|---|---|---|
| 暂停（`action=paused`）却 `reason=repo-disabled`；安装事件 / 安装不匹配 / 读策略 500 / 未知仓库同样 | 外层只看得见 `status` 与 `payload`，从这两样反推病因必然压成一档，即 `repoDisabled: true` | 病因由**内层**在各 return 点写进 `trace.earlyExit`，外层照写；六类各自一个原因 |

证据（`webhook.ts` 行号 → `decide.ts` 里的取值）：

| 分支 | 写入点 | 原因 |
|---|---|---|
| 暂停（全局/安装/仓库） | `webhook.ts:1197` | `paused`（`decide.ts:62`） |
| 安装事件（`installation.*` / `installation_repositories.*`） | `webhook.ts:1183` | `installation-event`（`decide.ts:64`） |
| 载荷没有 `repository.full_name` | `webhook.ts:1205` | `repo-missing`（`decide.ts:66`） |
| `repos` 没有这一行 | `webhook.ts:1222` | `unknown-repo`（`decide.ts:68`） |
| installation 不匹配 | `webhook.ts:1238` | `installation-mismatch`（`decide.ts:70`） |
| 读 `repos` 策略抛错（500） | `webhook.ts:1214` | `repo-read-failed`（`decide.ts:72`） |

载体：`apps/server/src/http/webhook-v21.ts:477` `earlyExit: SkippedReason | null;`（注释写明「为什么由内层记而不是让外层从状态码反推」，并点名这是 issue #30 换了条分支又踩一次）。

用例（`v21-webhook-trace.test.ts`）：`:297` 暂停 → `paused`（并断言 `repos.enabled` 仍是 `true`，把「病因指对了」也钉住）、`:321` 未知仓库 → `unknown-repo`、`:337` 仓库禁用 → `repo-disabled`（这条本来就是对的原因，防止改过头）、`:353` 安装事件 → `installation-event`（顺带断言安装事件照旧建 `repos` 行）、`:380` 安装不匹配 → `installation-mismatch`。

### 新-1：内容重复被丢弃的投递，留痕写的是 `triggered` / `enabled` —— **已修**

| 复审原文（`WP1-REVIEW2.md:193-199`） | 改前 | 改后 |
|---|---|---|
| 去重发生在 `webhook-v21.ts:1494-1500`（`insertMessage` 之后），晚于 `webhook.ts:1200` 的判定 → 一条「因重复内容什么都没跑」的投递被记成 `triggered` / `enabled`；不是漏记，是**主动记错** | 判定先写、去重后知，先写的那份留在了库里 | 去重命中时置 `trace.contentDuplicate`，唯一出口把 `content-duplicate` 排在**第一优先级**覆盖掉已算出的判定 |

证据：

- `apps/server/src/http/webhook.ts:1047-1049` `if (trace.contentDuplicate) { return reasonOnlyDecision('content-duplicate'); }`（排在 `trace.decision` 之前，注释写明「需求 `:918` 要的恰恰是这条留痕」）
- `apps/server/src/http/webhook.ts:1365` `trace.contentDuplicate = true;`（`handleV21Webhook` 返回 `duplicate` 处，含完整理由注释）
- `apps/server/src/http/webhook-v21.ts:482` `contentDuplicate: boolean;`（trace 字段）
- 顺带：「`content-duplicate` 当前不可达」也一起解决——现在它由这条覆盖路径产生（`decideEvent()` 的 `contentDuplicate` 入参仍是给「上游已知重复」的调用方留的，那条不被删）

用例：`apps/server/test/v21-webhook-trace.test.ts:429`（同一段评论贴两次，第二次 `duplicate: true` 且行里是 `ignored` / `content-duplicate`；第一条断言 `triggered` / `conditional-met` 作对照）。

## 二、改动文件

| 文件 | 范围 |
|---|---|
| `apps/server/src/trigger/decide.ts` | 只动 `SkippedReason` 联合（+8 个取值，各带「为什么分开记」的注释）+ 新增 `reasonOnlyDecision()` 出口。**未动** `decideDailyQuotaExceeded()` / `decideEvent()` / 判定顺序 |
| `apps/server/src/http/webhook-v21.ts` | 只动留痕写入相关行：`V21Trace` 加 `earlyExit` / `contentDuplicate` / `deliveryRecorded` 三个字段（+注释）、`v21DecisionRowOf()` 入参放宽成 `{triggered, reason}`、`writeV21Decision()` 加 `rowCount` 校验、`import type` 加 `SkippedReason`。**未动** `v21TemplateOf` / `pickEventTemplate` / `v21ContentDeltaOf` / `v21IsFirstEventOf` / `buildV21AgentMessage` / 配额判定行 / 会话 SQL 行（逐段核对过：这些符号在 HEAD 与新文件的出现次数一致） |
| `apps/server/src/http/webhook.ts` | 外层包装重写（`resolveTraceDecision()` 单一出口）、缺签名先落行、六个 return 点写 `earlyExit`、内容重复覆写、`recordUnauthenticatedDelivery()` 新函数 |
| `apps/server/test/v21-webhook-trace.test.ts`（新） | 13 个用例，真 PostgreSQL，断言库里的具体列值 |
| `apps/server/test/http-webhook.test.ts` | 1 个用例：`缺签名头：401 且不写任何行` → `401，但仍要落一行审计（FR-1.2）`。**这是唯一一个被我改断言的既有用例**，见第四节说明 |

## 三、命令与真实输出

全部在 `C:\Code\NodeProjects\pi-issue-bot` 下执行。

### 1) `cd apps/server; npx tsc --noEmit`

```
exit=0        （无输出）
```

### 2) `cd apps/server; npx vitest run test/http-server.test.ts test/http-webhook-free-mention.test.ts test/v21-webhook-integration.test.ts test/trigger-decide.test.ts`

```
 ✓ test/http-server.test.ts (24 tests) 642ms
 ✓ test/v21-webhook-integration.test.ts (14 tests) 58ms
 ✓ test/trigger-decide.test.ts (38 tests) 18ms
 ✓ test/http-webhook-free-mention.test.ts (8 tests) 7ms

 Test Files  4 passed (4)
      Tests  84 passed (84)
```

追加跑本包新增/改动的两个写入口文件：

```
cd apps/server; npx vitest run test/v21-webhook-trace.test.ts test/http-webhook.test.ts
 Test Files  2 passed (2)
      Tests  45 passed (45)
```

（13 条新用例 + 32 条 `http-webhook.test.ts`。前者含真库断言，后者是 v0.3 九步管线的回归面。）

### 3) `cd apps/server; npx vitest run`（全量）

```
结论：8 ok / 5 warn / 0 fail  →  worst=warn，退出码 0（…）
 ❯  @pi-issue-bot/server  test/app-config.test.ts (8 tests | 1 failed) 12ms
 FAIL   @pi-issue-bot/server  test/app-config.test.ts > 脱敏 > describeAppConfig：吐「配没配」，不吐任何令牌值
 AssertionError: expected '{"pgDsn":"postgres://pi:***@127.0.0.1…' not to contain 'secret'

 Test Files  1 failed | 138 passed (139)
      Tests  1 failed | 1762 passed | 2 skipped (1765)
```

**失败项归类（逐个说明，不混进「全部通过」）**：

| 文件 | 归属 | 依据 |
|---|---|---|
| `test/app-config.test.ts` | **别人的并行改动**（`apps/server/src/app/config.ts`，工作区 M 状态，本会话期间被改过多次） | 断言在读 `describeAppConfig()` 的 DSN 脱敏；那是 `app/config.ts:515` 的 `redactDsn()`，与 webhook 留痕无交集。我未改这个文件，也未改它的被测代码 |

补充：中途全量跑过 5 次，失败集合随**其他 session 的写入进度**变化过（出现过 `writeback-v21-execute.test.ts` 13 条、`agent-events.test.ts` 3 条、`queries-issues.test.ts` 5 条），每次都是别人写到一半的文件导致的夹具报错或契约字段未同步，最后一次稳定在只剩 `app-config` 1 条。同一时段 `npx tsc --noEmit` 也在 0 error 与「`src/queries/issues.ts` 缺 `totalEstimate` / `verdict` / `systemPromptAt`」之间来回——那是 `packages/contract/src/api.ts`（别人在改）与 `queries/issues.ts` 未同步造成的，**不在本包改动面**。在本包改动面上（`http/webhook*.ts` / `trigger/decide.ts`）tsc 始终 0 error。

### 4) `pnpm lint`（仓库根）

```
✖ 6 problems (0 errors, 6 warnings)
```

6 条 warning 全在 `scripts/spike/lib/*.mjs`（`no-empty` / `no-unused-expressions`），HEAD 已有的存量，与本包无关；本包文件 0 error 0 warning。

### 5) 变异实测（自我证伪，确认用例不是弱断言）

| 变异 | 结果 |
|---|---|
| `resolveTraceDecision()` 的兜底改成 `return null;`（等价于「外层不写病因」） | `v21-webhook-trace.test.ts` **10/13 红**（`push`、`issues.reopened`、缺签名、验签失败、暂停、未知仓库、安装事件、安装不匹配、0 行 warn、content-duplicate 全红），3 条对照用例仍绿——正是想要的分辨力 |
| `writeV21Decision()` 的 `rowCount` 校验改成 `if (false && …)` | 只 `★ 投递行不存在时记一条带 deliveryId / reason 的 warn` 变红（1 failed / 11 skipped / 11 passed） |

两次变异都改回原样后复跑全绿（下面第四节的命令就是复原后的）。

## 四、被改断言的既有用例（单独说明）

`apps/server/test/http-webhook.test.ts:223` 原来是：

```ts
it('缺签名头：401 且不写任何行', async () => {
  …
  expect(await countRows('webhook_deliveries')).toBe(0);   // ← 这条断言本身就是 FR-1.2 的违约
});
```

需求 `:741` 原文是「校验失败返回 401，但**仍要落库留痕**」，所以「不写任何行」是被需求直接否掉的旧行为。现在断言反过来并更严：行存在、`signature_valid=false`、`tasks` 0 行、`sends` 0 次（`http-webhook.test.ts:223-247`）。

**这不是「放宽断言让测试变绿」**：条数从 `count === 0` 变成「取行 + 三个字段的 `toMatchObject` + 两条旁证断言」，比原来更严。另外这个文件**不注入 `v21`**，所以 `decision` / `decision_reason` 两列留空是正确行为（「不注入 v21 = 旧行为逐字节不变」），判定原因由新建的 `test/v21-webhook-trace.test.ts` 钉住——两个文件的分工写在各自的文件头注释里。

## 五、需要契约 owner / 别人做的事

**没有阻塞项。** 下面两处只是注释与新取值不同步，不改 schema、不改契约类型、不需要 `pnpm gen:openapi`（`decisionReason` 是 `z.string()`，新取值原样透传，不留痕接口不会因为多了一种原因而 `parse()` 失败）：

1. `packages/contract/src/api.ts` 里 `deliveryRowSchema` 上方那段「未触发侧已知取值」的注释（当前列到 `signature-invalid`）建议补上新增的 8 个：`signature-missing` / `paused` / `installation-event` / `repo-missing` / `unknown-repo` / `installation-mismatch` / `repo-read-failed` / `out-of-scope`。
2. `apps/server/src/db/schema.ts:113-122` 的 `decisionReason` 列注释同样列了一份取值清单，建议同步；**并且**该注释里「可空：v2.1 之前的历史投递没有值」这句建议顺手澄清（复审 新-2 已指出它解释的「`null` 会重试」在现网不成立：投递级幂等命中后 `trace.skipDecision = true`，同一条不会重判）。

两处都是**注释**，不影响运行、不影响测试。按任务书「`packages/contract/**` 与 `db/schema.ts` 不归你」，我没有改。

## 六、跳过与残余风险

1. **跨交付范围的判定链改动会在别的分支上** —— 本包只保证「外层的四个缺口 + 内容重复覆写」，`SkippedReason` 联合新增的 8 个取值里，`paused` / `installation-event` / `repo-missing` / `unknown-repo` / `installation-mismatch` / `repo-read-failed` / `signature-missing` / `out-of-scope` **不会**由 `decideEvent()` 产出（它们来自外层包装的分支，或来自「根本进不了 `decideEvent()`」的投递）。如果将来有人只看 `decideEvent()` 就来判断「有哪些原因」，会漏掉这 8 个——已在 `decide.ts` 的联合注释与 `reasonOnlyDecision()` 的注释里写清分工。
2. **`decision=null` 仍然存在**：`payload` 不是 JSON 的投递（400）不落行（`payload` 列是 jsonb，**属「改表结构 or 接受」**，复审 `:126` 已判为「低、登记即可」）。本包没有改表，所以这类投递仍然没有行、也没有判定——`resolveTraceDecision()` 的 `!trace.deliveryRecorded` 分支就是为它留的，注释写明「没有可写的对象」。要覆盖它需要单独的一次迁移（存原始文本列或放宽 `payload` 可空），不在本包。
3. **`db/schema.ts` 与契约注释未同步**（见第五节）——功能上无影响，但「一个原因值在三处列了清单」这种第二真值还剩两处。
4. **面板侧未验**：`apps/panel` 里目前仍 0 处 `deliveries` 消费方（复审 `:230` 的观察仍成立）。新原因（尤其 `out-of-scope` 会成为组织级 webhook 的高频行）在面板上长什么样，要等 WP11 落地才能验；本包只保证库里有值、值是真话。
5. **并发工作区的干扰已如实记录**（第三节）：全量 test 与 tsc 的失败集合在本会话期间随别人的写入变化过，最后一次稳定结果是 `tsc 0 error` / 全量 `1762 passed, 1 failed（app-config，别人的 config.ts）`。合并前建议在无人并发改动时再复跑一次 `pnpm -r typecheck` + `cd apps/server; npx vitest run`。
6. **`v21-webhook-trace.test.ts` 依赖真 PostgreSQL**（`helpers/queries-db.ts` 的 advisory lock）。本机 `postgres18` 容器在跑、库可用；CI 无库时该文件会先失败在 `beforeAll`（与 `queries-*` 系列同一个前提），不是 `skipIf`——因为这里的断言对象就是库里的列，跳过等于不测。
