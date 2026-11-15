# WP4-REVIEW · 增量投喂（FR-4.2 / BR-4 / SB-4）

- 审查对象：`docs/audit/fix/WP4.md` 的声称（代码：`packages/contract/src/settings-v21.ts`、`apps/server/src/prompt/render.ts`、`apps/server/src/http/webhook-v21.ts`、`apps/server/test/v21-incremental-feed.test.ts`、`apps/server/test/prompt-render.test.ts`、`packages/contract/test/settings-v21.test.ts`）
- 审查方式：默认假定有问题，逐条找反证；实跑 + 两条一次性探针（放在会话 scratch，不入库）
- 基线：`docs/audit/fix/_baseline-fix.txt`（HEAD `fbfa029`）

## 结论

**有条件通过。**

代码主行为与 FR-4.2 一致（首轮全文、后续轮默认模板不含 `{{issue.content}}`、评论事件保留本轮指令与围栏），实跑全绿，无 `any` / 三个 0 违例，无越界证据。但有 3 个必须修的问题：

1. **WP4.md 自认的「逐字照抄默认模板 → 后续轮拿增量」与实测相反**（实测拿全文）。三处注释/文档对同一分支给出互相矛盾的描述，且该分支无任何用例。
2. **首轮判据把「运行时重置会话」（`sessionReset`）当成「还有历史」**，只下发增量——agent 既没有历史也没有正文。WP4 用来支撑该判据的「会话轮换 → turns 归零」理由已被 P0-1 删除，理由作废而漏洞仍在。
3. **增量模板把外部文本裸拼，丢了 ``` 围栏**（I10「外部文本永远是数据」被削弱），无用例看守。

---

## 一、实跑结果（真跑，命令 + 输出摘要）

| # | 命令 | 结果 |
|---|---|---|
| 1 | `cd apps/server; npx tsc --noEmit` | **0 错误、0 输出**（WP4.md:110-111 说还有 `runtime/turn-driver.ts`、`test/queries-deliveries.test.ts` 的错误——现已不存在，该段报告过期） |
| 2 | `cd apps/server; npx vitest run test/v21-incremental-feed.test.ts test/prompt-render.test.ts test/v21-webhook-integration.test.ts test/v21-integration.test.ts` | **4 files / 63 tests 全绿**（`v21-webhook-integration` 14、`v21-integration` 13、`v21-incremental-feed` 19、`prompt-render` 17）。WP4.md:115-127 记的 `v21-integration` ② 失败已不存在 |
| 3 | `cd packages/contract; npx vitest run` | **6 files / 142 tests 全绿** |
| 4 | `pnpm gen:openapi` | 输出 `9 paths / 51 schemas`；生成前后 `openapi/pi-bot.openapi.json` 的 SHA256 **完全一致**（`28A7CD89…CF238B`）⇒ 工作区里这份文件**就是生成器当前产物**，不是「还原到改动前」。`git diff` 为 `+139 / -162`，新增的只有 `DeliveriesResponse` / `DeliveryRow`（别的工作包），无 `contentDelta` / `isFirstEvent`。**WP4.md:106-108、128-131 的「已还原」不成立** |
| 5 | `npx eslint <本工作包 6 个文件>` | exit 0，无告警 |
| 6 | 探针 A（`npx tsx probe-verbatim.ts`，直接调 `buildV21AgentMessage`） | 见下 |
| 7 | 探针 B（`probe-webhook-verbatim.ts`，尝试走 `handleWebhook()`） | tsx/CJS 无法加载 `@octokit/webhooks-methods` 的 exports，**未跑通**，改用探针 A 显式传 `decidedTemplate`（与 `handleV21Webhook` 的调用形态一致，见 `webhook-v21.ts:1382-1390`） |

探针 A 输出（`issues.edited`，旧正文 `…\n环境：Windows 10`、新正文 `…\n环境：Windows 11`）：

```
prompt=null                    firstEvent=false: 全文=false 增量=true  未改动行=false
prompt=逐字默认模板            firstEvent=false: 全文=true  增量=false 未改动行=true
prompt=逐字默认模板+末尾换行   firstEvent=false: 全文=true  增量=false 未改动行=true
prompt=null                    firstEvent=true : 全文=true  增量=false 未改动行=true
prompt=逐字默认模板 decided=同一串 firstEvent=false: 全文=true 增量=false 未改动行=true   ← 反证
```

前四行符合预期；**第五行推翻了 WP4.md:62-63 的自认**。

## 二、需求对照

需求原文：`docs/requirements.html:948-951`（FR-4.2）、`:1789`（BR-4）、`:601`（场景 B）。

| 需求要点 | 结论 | 证据 |
|---|---|---|
| 首个事件下发完整正文 | ✅ | `DEFAULT_EVENT_TEMPLATES` 逐字未改（`packages/contract/src/settings-v21.ts:480-556`），`firstEvent=true` 走 `variant='full'`（`webhook-v21.ts:669`） |
| 后续事件「不重复整篇正文」 | ✅（默认模板）/ ⚠️（非空项目模板） | 四个增量模板均无 `{{issue.content}}`：`settings-v21.ts:573-586`（edited，只有 `{{issue.contentDelta}}` :585）、`:587-597`（labeled）、`:598-610`（closed）、`:611-623`（comment）；`issues.opened` 的增量版等于全文（`:572`）——opened 只会是首轮（重开走 `reopened`，本期五事件不含），可接受。**但见问题 1：项目 prompt 非空时（含逐字照抄默认）后续轮仍是全文** |
| 后续事件带上「本轮指令」 | ✅ | 技能词/指令行保留：`:574` `/proposal-analysis`、`:588` `/label-triage`、`:599` `/issue-analysis`、`:612` `/issue-analysis`；评论事件带 `` ```{{comment.body}}``` ``（`:617-619`） |
| 变更内容可读（场景 B） | ✅ 基本 | `v21ContentDeltaOf()`（`webhook-v21.ts:508-545`）给字段清单 + 行级多集差，40 行上限（`:416`、`:483-495`）；`payload.changes` 缺失时不崩、不猜 |
| 外部文本围栏（I10） | ❌ | 增量模板裸拼行级差异（`settings-v21.ts:584-585`、`:595-596`、`:608-609`），对照全文模板的围栏 `:492-495`、`:507-510`；`prompt/render.ts` 只做字面替换，无中和 |
| 「平台默认 vs 用户选择」 | 需求未规定 | FR-4.2/BR-4 只谈「首个/后续事件」，没有任何一句授权「模板内容等于默认即视为平台默认」。该口径是实现自定（`webhook-v21.ts:657-661`）——好在实测没有生效（问题 1），所以**不构成越权改动**，但文档口径必须改 |

## 三、发现的问题（按严重度）

### S1【中】「逐字照抄默认模板 → 后续轮拿增量」与实测相反；三处文档互相矛盾；该分支零用例

- 实测：`prompt = DEFAULT_EVENT_TEMPLATES['issues.edited']` + `decidedTemplate` 同为该串 + `firstEvent=false` → **全文**（探针第 5 行）。
- 原因：`pickEventTemplate()` 命中「等价」分支后调 `v21TemplateOf(settings, event, 'delta')`（`webhook-v21.ts:671-672`），而 `v21TemplateOf()` 看到 prompt 非空就原样返回（`:639-642`）——增量模板永远到不了手。
- 因此下列三处**互相矛盾**，其中两处与代码实际行为相反：
  - 错：`webhook-v21.ts:659-661`「逐字照抄默认模板的项目因此也会在后续轮拿到增量模板」；
  - 错：`docs/audit/fix/WP4.md:62-63` 同一说法（被审查者自认的口径）；
  - 对：`settings-v21.ts:566-568`「哪怕逐字照抄默认模板，一律原样使用」。
- 后果 1（需求覆盖被高估）：判定实际上退化成「prompt 为空才增量」。任何在面板里改过一个字、或用 API 写入非空模板的项目，后续轮**继续拿全文**，而且拿不到 `{{issue.contentDelta}}`（模板里没写）⇒ FR-4.2 对这些项目静默不生效。
- 后果 2（无人看守）：`pickEventTemplate` 未导出，19 个用例只测了 `v21TemplateOf` 的两个 variant（`v21-incremental-feed.test.ts:262-278`）。日后若有人「修正」`v21TemplateOf` 让 delta 优先，行为会突变，而现有用例一个都不会红。
- 严重度取「中」：不是安全越权，但 WP4.md 的自认与实测相反，属**误报（谎报）**；连带把需求覆盖说大了。

### S2【中】首轮判据把 `sessionReset` 当「还有历史」→ 只给增量，agent 既无历史也无正文

- `turns` 的写入口径只有一处：`apps/server/src/app/compose.ts:1003`（run 结束后 `+1`），UPSERT 见 `agent/store.ts:180-186`；`V21_SESSION_SQL.create`（`webhook-v21.ts:1124-1126`）只在行缺失时插入 `turns=0`。**没有任何归零路径**。
- WP4.md:18-20 与 `webhook-v21.ts:1194-1196` 的卖点「会话被轮换 → turns 归零 → 自动判首轮」**已失效**：P0-1 明确删掉了轮换（`compose.ts:203-215`、`:233-241`「决策只有三条规则，且没有第 4 条『轮换』」）。
- 而真正会「断历史」的路径没被覆盖：运行时重置会新建会话（`runtime/turn-driver.ts:388-403`，`sessionReset=true`），`compose.ts:1010-1015` 只记一条 `logger.info`，**既不清 `session_id` 也不清 `turns`** ⇒ 下一条事件判「后续轮」，只给增量，新会话里没有任何旧正文。
- 附带：`persistAgentSessionAfterRun` 在 run 结束后无条件调用（`compose.ts:1407-1413`，失败结论也走这条路）⇒ **失败轮也会 +1**，失败后下一条事件按后续轮投喂。无用例。

### S3【中】增量模板丢掉了外部文本围栏（I10）

- 行级差异与标签名直接拼进模板：`settings-v21.ts:584-585`（`'本轮变更：'` + `{{issue.contentDelta}}` 无围栏）、`:595-596`（标签名来自 `payload.label.name`）、`:608-609`。
- 对照全文模板：正文一律在 ``` 围栏内（`:492-495`、`:507-510`、`:520-523`、`:534-536`、`:551-554`），评论正文同样围栏（`:617-619`）。
- `prompt/render.ts:161-171` 只做字面替换，不中和；`maskCodeRegions` 在生产路径只用于评论技能词识别（`webhook-v21.ts:727`），不用于投喂正文。
- AGENTS.md I10 要求「外部文本永远是数据（围栏 + 蒙版 + `.strict()`）」。增量模板把这一层让掉了，且无任何用例断言围栏存在。

### S4【低】面板显示的不是「生效内容」

- `apps/panel/src/components/settings/v21-events-section.tsx:22` 声称「模板框里直接显示生效内容」，实现用 `DEFAULT_EVENT_TEMPLATES`（`:609-617`）；而后续轮实际下发的是 `DEFAULT_EVENT_DELTA_TEMPLATES`（`settings-v21.ts:571-624`）——面板没有入口，需求 §6.3 也没有它。
- 面板测试只数按钮个数（`apps/panel/src/routes/__tests__/repo-settings-v21.test.tsx:251`），不校验「显示 = 生效」。
- FR-2.2（`requirements.html:777-785`）说「每个事件能配置一份模板，事件触发时平台用这份模板」，现在被解释成「首轮用配置、后续轮平台另写死一套」。FR-4.2 本身是 P1 且注「待确认：增量粒度」（`:949-950`），属需确认的解读扩张，至少要写进文档。

### S5【低】机械保证只覆盖 1/4，「两个事件都判首轮」无用例

- 只断言了 `DEFAULT_EVENT_DELTA_TEMPLATES['issues.edited']` 不含 `{{issue.content}}`（`v21-incremental-feed.test.ts:269-270`）；labeled / closed / comment 没有同类断言；`issues.opened` 的增量版**等于**全文（`settings-v21.ts:572`）也没有断言——将来谁把 opened 也改成增量版会静默生效。
- 「一轮未跑完时连续两个事件 → 两次都判首轮、都给全文」（WP4.md:28-29、`:137`）没有任何用例；现有用例只钉了 `turns=0` / `2`（`v21-incremental-feed.test.ts:382-402`）。

### S6【低】测试改的是值不是语义，但有一处能力弱化

- 12→14 的数量、名字清单、逐项取值都是等价机械同步（`prompt-render.test.ts:46`、`:74-75`；`settings-v21.test.ts:341`、`:349-366`），**没有**把应当失败的用例改成永远通过，`PLACEHOLDER_NAME_SET.has('issue.foo') === false` 这类反向断言保留（`settings-v21.test.ts:367-374` 区段）。
- 但 `prompt-render.test.ts:36-38` 给 `makeContext()` 补了 `contentDelta` / `firstEvent` 后，`:49-57`「每个占位符都能渲染出值」只证明「渲染器会替换」，不再证明「真上下文里有数据源」；两个新占位符的数据源目前只被 `handleWebhook` 端到端间接覆盖，**没有 `v21RenderContextOf()` 的直接断言**（对比 `webhook-v21.ts:576-590`）。

### S7【低·流程】openapi 结论与现状相反；需求正文未同批更新

- 见「一、4」：WP4.md:106-108、128-131 说「已还原」，实际当前文件 = 生成器产物（含别的包的 `DeliveriesResponse`）。不是 WP4 引入的错误，但报告不实，且「产物必须同批提交」这件事仍悬空。
- 需求正文 §6.3 的占位符表格（`requirements.html:1481-1522`）仍是 12 条，新增的 `{{issue.contentDelta}}` / `{{issue.isFirstEvent}}` 没进去 ⇒ 契约领先于需求，AGENTS.md §1「同批修文档」欠账。

## 四、越界与误伤

- `writeback/` **未变**；`apps/server/src/app/compose.ts` 的 `panelDistDir` 注入完好（`:920`）。
- `contentDelta` / `isFirstEvent` / `DEFAULT_EVENT_DELTA_TEMPLATES` 在全仓 `src` / `test` 的命中只有声称的 6 个文件（3 个源码 + 3 个测试），没有泄漏到 `agent/`、`worker/`、`runtime/`、`compact/`、`queries/`、`trigger/`。
- 三个 0 保持：全仓 `apps/server/{src,test}`、`apps/panel/src`、`packages`（排除 `node_modules`）内 `vi.mock(`、`toMatchSnapshot`、`useFakeTimers` **命中 0**；本工作包 6 个文件内无 `any`（`render.ts:131` 的 `as any` 是既有注释正文）、无 `@ts-ignore`。
- **归因提示**：工作区里 `agent/`、`runtime/turn-driver.ts`、`worker/run-task.ts`、`queries/`、`queue/`、`db/schema.ts`、`http/api/`、`compact/`（新文件）全部是 M/??，`webhook-v21.ts` 的 diff 里也混着配额（WP7）、评论指纹、会话系统提示词、别名剥离等其他工作包的改动。**不能**用工作区 `git diff` 当作 WP4 的改动集来判越界——本报告只能证明「这些文件的改动内容与增量投喂无关」，无法证明归属。

## 五、不确定处

1. 未跑 `apps/server` 全量与面板 vitest：前者因并行工作包在途、噪声无法归因；后者本工作包未改面板，但 S4 建议补一条「显示 = 生效」用例。
2. 「失败轮也 +1」是按 `compose.ts:1003` + `:1407-1413` 推断，没有专门时序用例（真依赖需要 Docker/宿主）。
3. 生产里「项目 prompt 非空」的比例未知，S1 的需求覆盖影响面无法量化。
4. `handleWebhook()` 全链路的逐字照抄场景没跑（探针 B 被 tsx 的 CJS 互操作挡住，`@octokit/webhooks-methods` 无 exports 主入口）。结论用的探针 A 显式对齐了 `handleV21Webhook` 的调用形态（`webhook-v21.ts:1377-1391`），且 `trigger/decide.ts:258` 保证「prompt 非空 → `decidedTemplate === rawPrompt`」，与探针一致；若要用生产路径复核，需在 vitest 里写临时用例。
5. WP2 若改会话域隔离列，`V21_SESSION_SQL.read`（`webhook-v21.ts:1117-1119`）的 `WHERE` 要同批跟随——WP4.md:134-136 已提，此处仍成立。
