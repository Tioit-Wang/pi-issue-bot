# WP4-R · 增量投喂收口（S1 / S2 / S3 / S4 / S5 复核）

- 上游：`docs/audit/fix/WP4-REVIEW.md`（有条件通过 + 3 个必须修项）
- 范围裁决：`apps/panel/**` **不归本包**（与 WP11 面板重构冲突，编排侧改口）。S4 只出文案方案，不改面板、不跑面板测试。
- 实测命令见「五、命令与真实输出」；所有结论都能在给定行号上复核。

## 结论

| 项 | 裁定 | 一句话 |
|---|---|---|
| S1 模板选择口径与文档矛盾 | **已闭合** | `v21TemplateOf()` / `pickEventTemplate()` / `DEFAULT_EVENT_DELTA_TEMPLATES` 三处描述现在与代码一致；并补了两条**生产调用形态**用例钉住该分支 |
| S2 `sessionReset` 后 `turns` 未归零 | **已闭合** | `nextAgentTurns()` 返回 0，写回是 `0` 而不是 `null`；新增闭环用例（重置前=增量 → 重置后=全文 → 跑完=增量），断言到落库正文 |
| S3 增量模板丢围栏 | **已闭合** | 三个增量模板的 `{{issue.contentDelta}}` 与评论事件的 `{{comment.body}}` 都在 ``` 围栏内，写法与全文模板一致；用例正则看守 |
| S4 面板显示的不是「生效内容」 | **转出（本包只出文案）** | 见「四、面板应如何说明首轮/后续轮模板分支」，由 WP11 落地 |
| S5 机械保证只覆盖 1/4 | **已闭合** | 四个事件的「不含全文占位符」+ 围栏正则 + `opened` 增量版等于全文版都在；新增「一轮未跑完时连续两个事件都判首轮」用例 |

## 一、S1 裁定：已闭合

**代码行为（唯一事实）**：`apps/server/src/http/webhook-v21.ts:634-645` 的 `v21TemplateOf()` —— 项目 `prompt` 非空就原样返回（`:640-644` 之前的分支），只有为空时才按 `variant` 取平台默认那一套。

**三处描述逐条核对**：

| 位置 | 现在写的是 | 与代码一致 |
|---|---|---|
| `apps/server/src/http/webhook-v21.ts:649-662`（`pickEventTemplate` 头注释） | 「项目模板非空 → 原样返回；为空 → 按 `variant` 取平台默认那一套」；并明确「`decidedTemplate` 与默认串逐字相等**不足以**判定」 | ✅ |
| `packages/contract/src/settings-v21.ts:565-569`（`DEFAULT_EVENT_DELTA_TEMPLATES` 头注释） | 「平台决定用哪一套只发生在项目没自定义模板时；项目自定义模板（哪怕逐字照抄默认模板）一律原样使用」 | ✅ |
| `apps/server/src/http/webhook-v21.ts:631-632`（`v21TemplateOf` 头注释） | 「`variant='delta'` 只影响『项目没自定义模板』这一支」 | ✅ |

**第三处矛盾描述**：全仓 `src/`、`packages/`、`docs/audit/` 里提到「逐字」的只剩上述三处 + `WP4.md:62-63`。`WP4.md` 是上一轮的自述报告（审计留痕，不是规范来源），它的那句已经被本报告与 `WP4-REVIEW.md` 推翻，**不再改它**（改历史报告会让审计链断掉）。代码与契约里没有第四处矛盾说法。

**上一轮的零用例缺口已补**：`pickEventTemplate()` 未导出，但它是 `buildV21AgentMessage()` 内部唯一裁决者，而生产路径（`webhook-v21.ts:1388-1391`）**总会**把 `decideEvent()` 解析好的模板当 `decidedTemplate` 传进来。新增两条用例走同一调用形态：
- `decidedTemplate = DEFAULT_EVENT_TEMPLATES['issues.edited']` + 项目 `prompt = null` → 后续轮换成增量；
- 同串 + 项目逐字照抄该串 → 后续轮仍是全文。

## 二、S2 裁定：已闭合

**写入口径（不是本包文件，只读核对）**：

- `apps/server/src/app/compose.ts:461-469` `nextAgentTurns()`：`sessionReset ? 0 : previousTurns + 1`。
- `apps/server/src/app/compose.ts:1030-1033` 把它接进 `persistAgentSessionAfterRun()`；`:1046-1050` 写库。
- `apps/server/src/agent/store.ts:180-187` 的 UPSERT 把 `turns` 当**数字参数**写（`store.ts:412-424`），`0` 落库就是 `0`，**不会变成 `null`**；`apps/server/src/db/schema.ts:669` 是 `notNull().default(0)`。
- `apps/server/src/http/webhook-v21.ts:1203-1216` 判据 `row === undefined || num(row,'turns') <= 0`。

⇒ 两个函数的语义**接得上**：归零后下一条事件判首轮。附带说明：即使哪天真的写成 `null`，`turns <= 0` 与「行缺失」都走首轮分支，行为也不会反过来 —— 真正的风险是「不归零」，本轮用例盯的就是它。

**新增闭环用例**（`apps/server/test/v21-incremental-feed.test.ts`，describe「S2 闭环：运行时重置 → turns 归零 → 下一条事件重新拿全文」）：

1. 会话行 `turns=5` → 投递一次 → 正文含 `本轮变更：`、**不含**未改动行（增量）；
2. `turns = nextAgentTurns({ previousTurns: 5, sessionReset: true })` → 断言 `0` → 再投递 → 正文含 `正文快照` 与未改动行、**不含** `本轮变更：`（全文）；
3. `turns = nextAgentTurns({ previousTurns: 0, sessionReset: false })` → 断言 `1` → 再投递 → 又回到增量。

断言落在 `agent_messages.comment_body`（假库记录的 `$6`），是可观察事实，不是「函数返回了什么」。若把 `nextAgentTurns` 的重置改回 `previousTurns + 1`，第 2 步立刻红。

**早退条件用例**：`persistAgentSessionAfterRun()` 第一句是 `if (agentSession.session === undefined) return;`（`compose.ts:1025-1027`），而那个值来自 `planAgentSession()`。用例断言 `planAgentSession({ session: null, isAgentTask: false }).session` 是 `undefined`、`isAgentTask: true` 时不是 —— 直接钉住早退条件本身（`persistAgentSessionAfterRun` 未导出，不复制它的逻辑）。

## 三、S3 裁定：已闭合

**围栏位置逐个核对**（`packages/contract/src/settings-v21.ts`），与全文模板 `:492-495` / `:505-510` 的写法完全同形（`` '本轮变更：', '```', '{{issue.contentDelta}}', '```' ``）：

| 事件 | 增量模板行 | 围栏 |
|---|---|---|
| `issues.edited` | `:578-593` | `:590-592` |
| `issues.labeled` | `:594-606` | `:603-605` |
| `issues.closed` | `:607-621` | `:618-620` |
| `issue_comment.created` | `:622-634` | `{{comment.body}}` 在 `:628-630`（全文模板 `:544-546` 同形） |

**看守用例**：`apps/server/test/v21-incremental-feed.test.ts` 的「四个后续轮模板都不含全文占位符，且增量内容都包在 ``` 围栏里（I10）」用 `/```\r?\n\{\{issue\.contentDelta\}\}\r?\n```/` 逐个事件断言，评论事件单独断言 `{{comment.body}}` 的围栏。把任一围栏删掉（或改成裸拼）立刻红。

## 四、面板应如何说明首轮/后续轮模板分支（S4，交给 WP11 落地）

**为什么需要说明**：模板框里填的是 `DEFAULT_EVENT_TEMPLATES`（首轮 / 项目自定义那一套），而后续轮在「项目没自定义模板」时实际下发的是 `DEFAULT_EVENT_DELTA_TEMPLATES`（不含整篇正文）。面板目前（`apps/panel/src/components/settings/v21-events-section.tsx:22` 的头注释、`:609-617` 的 `fallback`）没有把这个分支告诉用户。

**放在哪里**：`apps/panel/src/components/settings/v21-events-section.tsx` 的 `TemplateField`（`:601-654`）里，紧贴「提示词模板」输入框下方一行小字（和现有的字符计数行同一区域，`text-2xs text-faint`，建议加 `data-testid={\`v21-event-prompt-delta-note-${eventKey}\`}` 便于断言）。**不要**新增输入框、开关或配置项。

**建议文案（一句话，直接可用）**：

> 首轮（这条 issue 第一次叫醒 agent）按上面的模板发全文；后续事件如果这里保持内置默认，平台会换成「只发本轮变更」的增量模板 —— 自己改过这里，就两种轮次都按你写的发。

`issues.opened` 面板可换个说法（该事件的增量模板与全文模板是同一份）：**「新开事件只会是首轮，两种轮次用的是同一份模板。」**

**为什么不算新增配置项**：需求 §6.3 与 FR-2.2 只规定「每个事件能配置**一份**模板」，没有「增量模板」这一项；FR-4.2 是 P1 且自带「待确认：增量粒度」。所以正确做法是把**平台既有行为**解释清楚，而不是为用户造出第二个可配项 —— 增量模板的选择完全由「项目模板是否为空 + 是否首轮」决定（`webhook-v21.ts:663-675`），用户想改就改那一份模板。

**面板测试（WP11 落地时）建议**：一条 `.tsx` 用例断言该事件下面那行说明存在且含「后续事件」字样，另一条断言 `issues.opened` 用的是「同一份模板」的措辞 —— 不必断言整句逐字（文案是给人看的，钉死会让改文案变成改测试）。

## 五、命令与真实输出

| # | 命令 | 结果 |
|---|---|---|
| 1 | `cd apps/server; npx tsc --noEmit` | 首次 **失败**，2 处错误都在**别的 session 的在途改动**里：`src/trigger/roles.ts(59,50)` TS2345、`src/queue/index.ts(72,75)`/`(89,90)` TS2300 `Duplicate identifier`；本包文件无报错。随后重跑：**exit 0，零输出** |
| 2 | `cd apps/server; npx vitest run test/v21-incremental-feed.test.ts test/prompt-render.test.ts test/v21-webhook-integration.test.ts test/v21-integration.test.ts test/app-agent-session-plan.test.ts` | **5 files / 81 tests 全绿**（`v21-webhook-integration` 14、`v21-integration` 13、`v21-incremental-feed` 28、`prompt-render` 17、`app-agent-session-plan` 9） |
| 3 | `cd packages/contract; npx vitest run` | **6 files / 142 tests 全绿** |
| 4 | `npx eslint apps/server/test/v21-incremental-feed.test.ts` | exit 0，无输出 |
| 5 | `git status --short apps/panel` / `git diff --stat -- apps/panel` | **两条都空** —— 面板一行未动（中途误改过 `v21-events-section.tsx:22` 的一行注释，已原样还原） |
| 6 | `pnpm --filter @pi-issue-bot/panel test` / `typecheck` | **按范围裁决未跑**（该目录有别的 session 在改，跑了看到的是别人的在途状态） |

## 六、新增 / 修改的用例清单

只改了一个测试文件：`apps/server/test/v21-incremental-feed.test.ts`（现在 28 条 `it`，**本包新增 7 条**）。为支持新用例，假件做了两处等价扩展（不改断言强度）：

- `createFakeDb()` 的 `turns` 参数接受 `number | null | (() => number | null)`：每次查询现取，这样两条投递之间可以「跑完一轮」改写会话行；原有用例传数字，行为不变。
- 抽出 `deliverWith(db, settings, c)`：让「同一个 issue 连来两条投递」能共用同一份假库；`deliverEdited()` 变成它的一层包装。

| # | 用例 | 盯的是 |
|---|---|---|
| 1 | buildV21AgentMessage「生产形态：decidedTemplate = 内置默认串、项目没写模板 → 后续轮换成增量」 | S1：`pickEventTemplate()` 的等价分支（此前零用例） |
| 2 | buildV21AgentMessage「生产形态：decidedTemplate = 内置默认串、项目逐字照抄了默认模板 → 后续轮仍是全文」 | S1 反向：别把「显式选择全文」当平台默认 |
| 3 | 上下文注入「后续轮：contentDelta 取自事件与载荷，isFirstEvent 渲染成 false」 | `v21RenderContextOf()` 的数据源（WP4-REVIEW S6 指出的「只证明渲染器会替换」） |
| 4 | 上下文注入「首轮：contentDelta 是空串，isFirstEvent 渲染成 true」 | 同上 |
| 5 | S2 闭环「重置前给增量；重置归零后给全文；跑完（turns=1）又回到增量」 | S2 的核心闭环 |
| 6 | S2「非 agent 任务不写会话行：`planAgentSession()` 的 session 是 undefined」 | 早退条件 |
| 7 | S5「同一个 issue 连来两条 edited 投递（turns 始终是 0）→ 两次正文都含全文」 | WP4.md 自认缺的那条用例 |

## 七、改了哪些文件

| 文件 | 改动 |
|---|---|
| `apps/server/test/v21-incremental-feed.test.ts` | 上面 7 条用例 + 假件两处等价扩展 + 文件头/段落注释补「为什么」 |
| `docs/audit/fix/WP4-R.md` | 本报告（新建） |

**未改动**（本包独占但本轮不需要动）：`packages/contract/src/settings-v21.ts`（S3 的围栏与 S1 的头注释上一轮已改准，本轮核对一致，不再动）、`apps/server/src/http/webhook-v21.ts`、`apps/server/src/prompt/render.ts`、`apps/server/test/prompt-render.test.ts`、`packages/contract/test/settings-v21.test.ts`。
**未触碰**：`apps/panel/**`、`app/compose.ts`、`agent/**`、`runtime/**`、`queries/**`、`writeback/**`、`workflows/**`、`db/schema.ts`、`migrations/**`、`packages/contract/src/{api,repo-config}.ts`。没有 `git add` / `commit`。

## 八、跳过项与残余风险

1. **面板测试未跑**（范围裁决）。S4 的文案由 WP11 落地，本包只给方案。
2. **「失败轮也 `turns + 1`」仍未解决**（WP4-REVIEW S2 附带项，`compose.ts:1438-1450` 无条件调用 `persistAgentSessionAfterRun()`）：首轮跑失败后 `turns` 变成 1，下一条事件按「后续轮」只发增量，而 agent 手里可能既没有历史也没有正文。**最小修法**（在 `compose.ts`，非本包文件）：调用处只在成功时推进 —— `previousTurns: report.outcome === 'succeeded' ? params.session?.turns : (params.session?.turns ?? 0) - 1` 这种写法太绕，干净的写法是给 `nextAgentTurns` 增加一个 `succeeded: boolean` 并在 `false` 时返回 `previousTurns ?? 0`（保守方向：宁可多给一次全文）。本包没有权限改，也没写会因此变红的用例 —— 属于**未闭合**。
3. **需求正文 §6.3 占位符表格仍是 12 条**（WP4-REVIEW S7）：`{{issue.contentDelta}}` / `{{issue.isFirstEvent}}` 没进需求正文。不归本包（不许改需求文档），仍是欠账。
4. **`docs/audit/fix/WP4.md:62-63` 的错误口径没有回头修**：那是上一轮的自述报告，属审计留痕；本报告已明确推翻，代码/契约里无同类错误描述。
5. **首轮判据的时序窗口未端到端验证**：一轮还在队列里/正在跑时连来两个事件，靠「`turns` 只在跑完后才 +1」判成两条都首轮。用例用「`turns` 恒为 0」模拟这个窗口（S5 第 7 条），**没有**真的起队列跑并发；真依赖（pg-boss + 宿主）未在本次验证内。
6. 全仓 `vi.mock(` / `toMatchSnapshot` / `useFakeTimers` 三个 0 在本次改动后保持（新增用例只用手写端口假件，时间用 `FIXED_NOW`）。
