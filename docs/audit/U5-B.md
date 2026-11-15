# U5-B 需求实现核查（反证视角）

- 需求文档：`C:\Code\NodeProjects\pi-issue-bot\docs\requirements.html` 行 1038–1131（FR-5.4 / FR-5.5 / FR-5.6）
- 代码范围：`apps/server/src/compact/**`、`apps/server/src/writeback/v21/**`、`apps/server/src/worker/**`、`apps/server/src/github/**`、`apps/server/src/db/schema.ts`，以及装配层 `apps/server/src/app/{compose.ts,worker-deps.ts}`、提示词 `apps/server/src/skills/prompt.ts`、契约 `packages/envelope/src/v21.ts`
- 核查方式：先假设「没实现」，只接受无争议代码证据。为核对单测口径，实际跑了 `npx vitest run test/compact-engine.test.ts test/compact-truncate.test.ts test/compact-thresholds.test.ts test/compact-summary.test.ts test/writeback-v21-labels.test.ts` → 5 文件 / 79 用例全部通过（只读执行，未改仓库文件）。
- 背景事实（对全部条目都成立，先说一次）：`docs/v21-contract.md` 在本仓库**不存在**（`docs/` 下只有 requirements / project-overview / quickstart / testing-standards / panel-ui-versions），多个模块文件头引用的 `docs/v21-contract.md §5/§6` 无法核对。

---

## FR-5.4 标签目标态与删除权（requirements.html:1038-1050）

### 5.4-a 目标态对齐（多的删、少的加）——**部分实现**

**反证过程**：先找「加/删是否由一次差集算出」。`writeback/v21/labels.ts:135-200` `planLabelTargetState()` 确实一次算出 `add = desired − current`、`remove = current ∩ 可管理目录 − desired`，纯函数、有单测（`test/writeback-v21-labels.test.ts:122-144`）。然后反证关键输入 `current`（当前标签）从哪来——这是「删得掉」的前提。

`current` 并没有从 GitHub 读，而是从**我们自己的台账 `bot_labels`** 读：

- `apps/server/src/app/compose.ts:859`：`const currentLabels = await readAppliedLabels(pool, ctx.repo, ctx.issueNumber)`，而 `readAppliedLabels`（`compose.ts:1658-1679`）的 SQL 是 `select distinct "label" from "bot_labels" where … and "removed_at" is null`；
- `apps/server/src/app/compose.ts:862-863`：`currentLabels, botLabels: currentLabels` —— 两个字段塞同一个值；
- 直连路径同样：`worker/run-task.ts:1302-1309` 的 `target.currentLabels` 来自 `app/worker-deps.ts:1073-1087` `createV21TargetContextPort({ currentLabels })`，而装配点 `compose.ts:1427` 传的仍是 `readAppliedLabels(...)`（`compose.ts:1149`）；
- 全仓没有任何「读某个 issue 真实标签集」的读面：`github/types.ts:113` 之后只有 `addLabels` / `removeLabel`（写），无 `listIssueLabels`；`packages` 与 `runtime` 里也没有。

**结论**：目标态的差集**方向对、输入错**。`current` ⊂ `bot_labels`，于是人手动打的标签永远不在 `current` 里，`remove` 永远算不到它们；`skipped`（`labels.ts:187-197`）也不会把它们记成「不可管理」。现象：模型的 `desired` 里漏掉一个人打的标签，平台**不会删**；需求要求的「平台拥有删除权，包括删除人手动打的标签」在装配层被抵消。

**证据**：`apps/server/src/writeback/v21/labels.ts:135-200`；`apps/server/src/app/compose.ts:859-863`（另 `871-875`）、`1149`、`1427`、`1658-1679`；`apps/server/src/app/worker-deps.ts:1073-1087`；`apps/server/src/worker/run-task.ts:1302-1309`；`apps/server/src/github/types.ts:113`。

**缺口**：需要在执行前拿真实标签集（webhook payload 的 `issue.labels` 或 `GET /issues/{n}`），否则 FR-5.4 的删除权只是纸面能力。补测方向：以「人打的标签不在 bot_labels」为输入，断言 `remove` 命中它。

### 5.4-b 作用域：只作用于项目标签目录——**已实现**

**反证过程**：查「目录外标签是否可能被加/删」。`labels.ts:83-107` 把可管理集合定义为 `managed !== false && status === 'active' && meaning 非空`；`desired` 里出现不可管理项 → `unknown-label` 整批拒绝（`labels.ts:163-176`）；`current` 里出现不可管理项 → 进 `skipped`，既不删也不加（`labels.ts:187-197`）。目录来源是仓库设置 `settings.labels.vocabulary`（`config/v21-settings.ts:249-258` `resolveManagedCatalog` 全量返回，不提前筛）。

**证据**：`apps/server/src/writeback/v21/labels.ts:83-107,163-197`；`apps/server/src/config/v21-settings.ts:227-258`；`test/writeback-v21-labels.test.ts:146-161`。

**缺口**：无（目录外的来源只有一个「目录为空」的边界：空目录 → 全部 `not-in-catalog`，等于不动标签，属安全侧，`v21-settings.test.ts:273` 有断言）。

### 5.4-c 空集保护（空目标态默认不清空，需显式清空意图）——**已实现**

**反证过程**：怀疑「空数组被当成清空」。`labels.ts:139-147`：`desired.length === 0 && !clear` → `ok:false, reason:'empty-without-clear'`，且执行器 `execute.ts:528-530` 直接抛 `ERROR_LABEL_PLAN` → 一条写都不发（`execute.ts:512-513` 注释与 `541-557` 的实际顺序一致：先判 plan，再 dry-run，再 add/remove）。`clear` 在契约里是显式字段（`packages/envelope/src/v21.ts:259-264` `clear: z.boolean().optional()`），没被默认成 true。空白串也会被 `normalizeNames` 归成空集（`labels.ts:110-122`），不会绕过保护。

**证据**：`apps/server/src/writeback/v21/labels.ts:139-147`；`apps/server/src/writeback/v21/execute.ts:515-559`；`packages/envelope/src/v21.ts:253-264`；`test/writeback-v21-labels.test.ts:51-91`。

**缺口**：无。

### 5.4-d 超限整批拒绝、不截断——**已实现（v2 路径）/ 存在一条会截断的旁路 → 部分**

**反证过程**：`labels.ts:149-156` 在算差集**之前**判 `desired.length > maxPerIssue` → `over-limit` 整批拒绝，返回对象里连 `add`/`remove` 字段都没有（单测 `writeback-v21-labels.test.ts:104-105` 显式断言 `'add' in plan === false`）。契约层还有第二道：`packages/envelope/src/v21.ts:190-191,262` `MAX_DESIRED_LABELS = 32` + `.max(32)`，超 32 是 zod 拒绝（整份产出拒绝），不是 slice。

但另有一条老路径会**截断**：`workflows/normalize.ts:199-206` `const max = labels.max_per_issue; const afterMax = afterGroups.slice(0, max)` —— 超出部分逐个进 `blocked`（`reason: 'max-per-issue'`），前 max 个照打，即「打了一半」。这条路径由 `createLabelWritebackPolicy`（`app/worker-deps.ts:567-589`）+ `compose.ts:1130,1380` 装配，仍然在用（旧 `label` intent 走 `worker/writeback.ts`）。

**证据**：`apps/server/src/writeback/v21/labels.ts:149-156`；`packages/envelope/src/v21.ts:190-191,253-264`；`apps/server/src/workflows/normalize.ts:199-206`；`apps/server/src/app/worker-deps.ts:567-589`。

**缺口**：需求文字没区分新旧路径；若模型按提示词里的旧形状产出（见 5.4-g），实际落到的正是会截断的老路径。要么删掉老路径的截断语义，要么明确 FR-5.4 只约束 v2.1 并在提示词里堵住旧形状。

### 5.4-e 删除留痕记录「原主人是人还是机器」，后台可查——**与需求冲突**

**反证过程**：三步。① 有没有 owner 概念？有：`labels.ts:124-132` `deletionOwner(label, botLabels)` → `'bot' | 'human'`。② owner 怎么算的？`bot_labels.includes(label)`。③ 生产路径传进来的 `botLabels` 是什么？`compose.ts:863` `botLabels: currentLabels`，而 `currentLabels` 又来自 `bot_labels`（5.4-a）。于是 `deletionOwner()` 对每个要删的标签**恒返回 'bot'**，`'human'` 分支在生产装配下不可达 —— 「原主人是机器」被无条件记录，恰好与事实相反（能进 `remove` 的正是我们自己打过的标签，但需求关心的是「人打的标签被平台删掉」这一情形，而这条路径永远算不到它）。

第二步更硬：`runLabel` 算出的 owner 只进了**人读字符串** `describeLabelDelta`（`execute.ts:562-573` `删 [标签/human]`），结构化 `actions.audit` 里没有 `owner` 字段（`worker/run-task.ts:1435-1443` 只写 `source/contract/index/type/outcome/detail/dryRun`）。

第三步：**生产路径连这句字符串都丢了**。`compose.ts:871-875` 把 `executed` 映射成 `{index, type, outcome}`，**丢掉了 `detail`**；`run-task.ts:1362-1366` 再映射一次，同样没有 `detail`；随后 `1435-1443` 的 `audit.detail = item.detail ?? null`、`1457-1468` 的 `run_events.executed[].detail` 因此都是 `null`。直连路径（未注入 `execute` 钩子）才保留 `detail`。

**结论**：「每次删除记录原主人是人还是机器、后台可查、可复盘」在生产装配下无从复核：既没有结构化 owner 列，连承载 owner 的自由文本也被装订层砍掉。`bot_labels.remove<Label>`（`run-task.ts:370-377`）只记「标签被撤了 + 时间」，`bot_labels` 本身没有 `removed_by` 列（`db/schema.ts:381-405`）。

**证据**：`apps/server/src/writeback/v21/labels.ts:124-132,207-222`；`apps/server/src/writeback/v21/execute.ts:532-536,562-573`；`apps/server/src/app/compose.ts:859-875`；`apps/server/src/worker/run-task.ts:1360-1374,1424-1468`；`apps/server/src/db/schema.ts:348-405`。

**缺口**：需要 (1) 真实 `current`/`botLabels` 分家（否则 owner 永远 bot）；(2) 结构化留痕（`actions.audit` 加 `removed: [{label, owner}]` 或单独一行 `bot_labels.removed_by`）；(3) 装订层别丢 `detail`。现有单测全部只测纯函数（`deletionOwner('人工标签', ['缺陷']) === 'human'`，`test/writeback-v21-labels.test.ts:191-194`），装配层的值错误没有用例覆盖。

### 5.4-f 人工删除不构成永久否决 + BR-11「不自动管理」标记——**与需求冲突（老路径）/ 部分实现（v2 路径）**

**反证过程**：先查 BR-11 的显式标记是否真在 schema / 设置 / 对齐逻辑里。有：`settings.labels.vocabulary[].managed`（`config/v21-settings.ts:231-238`，`resolveManagedCatalog` 补齐 `managed: boolean`），对齐逻辑按它过滤（`labels.ts:83-107,100-102`），面板有可勾选项（`apps/panel/src/components/settings/labels-section.tsx:270-280`，注释写着「关掉 managed = 不删不加」）。`status: retired`（GitHub 上已删）也走同一分支。这一半成立。

但「人工删除不构成永久否决」被**另一条仍在装配中的路径**直接违反：`app/worker-deps.ts:581` 注入 `humanVetoed: ({repo,targetNumber}) => loadHumanVetoed(...)`，`workflows/bot-labels.ts:73-79` + `humanVetoedFrom(history)` 的语义是「曾由 bot 打过、后被撤下且之后没再打回来的标签 → 永久否决」，`workflows/normalize.ts:191-199` 用它把标签从 `desired` 里剔掉。这正是 requirements.html:425 明确写「BR-11 改为显式『不自动管理』标记（取消『人删过永久不加回』）」要废止的行为，而代码里仍在生效（`compose.ts:1130` 装配、`worker/writeback.ts:190-199` 调用）。

v2.1 路径没有这段否决（`executeV21` 的 `runLabel` 不读 `humanVetoed`），所以只说「v2 路径合规」。另有一处行为偏差：`desired` 里出现 `managed=false` 的标签时，实现是**整批拒绝**（`unknown-label`，`labels.ts:163-176`），而不是「跳过这个标签、其余照对齐」；且 `skills/prompt.ts:254-290` 渲染的标签词表**不显示 `managed`/`status`**，模型看不到哪个标签被标了「不自动管理」，只能撞上去被拒。

**证据**：`apps/server/src/config/v21-settings.ts:227-258`；`apps/server/src/writeback/v21/labels.ts:83-107,163-176`；`apps/panel/src/components/settings/labels-section.tsx:270-280`；`apps/server/src/app/worker-deps.ts:581`；`apps/server/src/workflows/bot-labels.ts:73-79`；`apps/server/src/workflows/normalize.ts:191-206`；`apps/server/src/app/compose.ts:1130`；`apps/server/src/skills/prompt.ts:254-290`。

**缺口**：删掉老路径的 `humanVetoed`（或把它改成读 `managed=false`）；标签词表渲染加上「不自动管理」标注；明确 desired 含不可管理标签时是整批拒绝还是静默跳过（现在与 BR-11「既不删也不加」的字面有缝）。

### 5.4-g 前置条件「执行侧输入必须包含当前全部标签与完整目录」——**部分实现**

**反证过程**：目录侧成立——`skills/prompt.ts:717` 渲染 `## 项目标签`（名字 + 含义 + 互斥组，上限 40 条）；当前标签侧在 webhook 装配里成立（`http/webhook-v21.ts:317` `labels: labelNames` 来自 payload 真实标签，`render.ts:150-152` 渲染 `{{issue.labels}}`，`skills/prompt.ts:726` 还有一行「当前标签」）。但同一份提示词里**两条互相矛盾的标签动作语法**：

- `skills/prompt.ts:266`：「标签的生效方式是信封 `actions` 里的 label 动作：`{"intent":"label","add":["<标签名>"],"remove":[]}`」——旧 4-intent 形状；
- `skills/prompt.ts:356-359`：`{"type":"label","payload":{"desired":["<标签>"],"clear":false}}`——v2.1 形状。

模型若照前者产出，`parseOutputV21Json` 判 `not-v21`（`worker/run-task.ts:1155-1161,1191-1197`）→ 落回老路径，于是 5.4-a 的目标态语义、5.4-d 的「不截断」全部绕过。

**证据**：`apps/server/src/skills/prompt.ts:266,356-359,717,726`；`apps/server/src/http/webhook-v21.ts:317`；`apps/server/src/worker/run-task.ts:1155-1197`。

**缺口**：`prompt.ts:266` 必须改成 v2.1 目标态写法（这是第二处事实源，且是错的）。

---

## FR-5.5 写回与失败处理（requirements.html:1052-1059）

### 5.5-a 动作按序执行——**已实现**

**反证过程**：`writeback/v21/execute.ts:431-448` 用 `for` 串行 `await runAction`，无 `Promise.all`；失败即 `stoppedAt = index; break`。单测 `test/writeback-v21-execute.test.ts:223` `describe('顺序执行：遇失败即停')`。

**证据**：`apps/server/src/writeback/v21/execute.ts:414-457`。

**缺口**：无。注意 `runLabel` 内部是「先加后删」（`execute.ts:545-557`），不属于「动作间隔序」的违反，但会在改名场景短暂多一个标签，需求未规定，记录备查。

### 5.5-b 失败不得静默（兜底反馈或后台告警）——**部分实现**

**反证过程**：分两条链路看。

后台告警侧成立：v2 执行 `!result.ok` → `signals.push(signalFromParse(...))`（`run-task.ts:1470-1477`）→ `decideOutcome`/`pickHighestPrioritySignal` → `runs.failure_class` 与 `report.signals`（`run-task.ts:1529-1586,1705,1742,1759-1760`），面板可按 run 查；`errors` 同时写 `envelopes.errors`（`1412-1419`）与 `run_events`（`1457-1469`）。逐动作失败还落 `actions` 行 `status=failed`、`applied_at=null`（`1424-1448`）。

兜底反馈侧**明确关闭**：`run-task.ts:1243` `if (!v21Handled && …)`，注释在 `1241-1242`「v2 分支**不发兜底评论**」。也就是说 v2 路径动作失败时，issue 上不会出现任何说明；用户可见的只有终态 reaction（`compose.ts:1376-1378` 注入的 `feedback`，文档口径 `-eyes +robot/confused`）。

如果读作「至少要有兜底反馈**与**后台告警」→ 缺一半；如果读作「至少要有一项」→ 满足。

**证据**：`apps/server/src/worker/run-task.ts:1241-1243,1470-1477`；`apps/server/src/worker/fallback.ts:9-22`（兜底评论的四条纪律）；`apps/server/src/app/compose.ts:1376-1378`。

**缺口**：v2 路径失败无面向人的反馈；若判定必须二者兼备，需给 v2 补一条受槽位约束的失败说明评论。

### 5.5-c 不合并 PR——**已实现**

**反证过程**：全仓搜 `merge`：`github/types.ts:113` 明写「这一层刻意**不含** merge」；`writeback/v21/execute.ts` 的 12 类动作里没有合并（`ISSUE_ACTION_SHAPES` 与 `runAction` 的 switch `465-491`）；`git/` 里只有 `merge-base` 判定（`branch-cleanup.ts:128`）。扫描测试 `apps/server/test/no-merge.test.ts` 存在。

**证据**：`apps/server/src/github/types.ts:113`；`apps/server/src/writeback/v21/execute.ts:465-491`；`apps/server/test/no-merge.test.ts`。

**缺口**：无。

### 5.5-d 执行侧无产出（超时/崩溃/输出不合契约）时标签与评论保持原状——**大体实现，一处存疑**

**反证过程**：`run-task.ts:1154` 整段校验包在 `if (turnResult !== undefined)` 里，`v21Handled` 只在该块内被置 true（`1169-1175`）；写执行器 `1299` 又要求 `v21Handled && v21Plan !== null`。所以 turn 抛错 / 无结果 → 一个写方法都不调。输出不合契约（`rejected`）→ 只写 `envelopes.errors` + `run_events` + signal，不执行任何动作（`1173-1190`）。

存疑点：`turnResult !== undefined` 但 `terminal` 不是 `turn.completed`（`turn.failed` / `turn.interrupted` / `stream-ended`）时，`1169` 仍会因 `lastProbe.kind === 'valid'` 进入执行分支——即「本轮崩了/被中断但事件流里已落过一份完整合规信封」时会照常写回。需求写的是「超时、崩溃…时标签与评论保持原状」。这算不算「有产出」有两种读法，代码里没有把 `terminal` 纳入执行门槛。

**证据**：`apps/server/src/worker/run-task.ts:1141-1150,1152-1213,1294-1299`。

**缺口**：把 `terminal === 'turn.completed'` 加成执行前置（或明确「已落合规信封即视为有产出」并写进需求）。现无对应用例。

---

## FR-5.6 上下文压缩（requirements.html:1061-1131）

**先说全节最重的一条反证结果**：`apps/server/src/compact/` 的六个模块是一套**从未被调用的库**。全仓调用点只有两处，都是「暴露」而非「使用」：

- `app/worker-deps.ts:1022-1032`：`export { createCompactor, createCompactor as createV21Compactor }`，文件头注释 `1028-1030`：「**本轮只暴露、不自动调用**……真正的自动压缩留作遗留项」；
- `app/compose.ts:879-881`：`// 只暴露不调用：RACP 没有 history/compact 操作，请求前自动压缩尚属遗留（见最终报告）`；`worker-deps.ts:1051-1056` 同义；
- `worker/run-task.ts:411-418,933-937`：事件流里认出 `itemType==='compaction'` 只**写一行记录**，「这里**不发起压缩**」；
- `http/webhook-v21.ts:720-727`：同义。

因此需求里所有「请求发出前」「不发请求」「喂给模型的内容」相关的语义，在运行期**没有任何代码执行**；能跑起来的只有「host 自己报了压缩 → 落一行 `agent_compactions`」。下面的子项按「模块自身实现」与「运行期是否生效」两栏分别给结论。

### 5.6-1 阈值从当前模型窗口现算、不做成配置项——**部分实现（公式在，窗口数据无来源）**

**反证过程**：`compact/thresholds.ts:77-114` 的 `planCompaction` 是纯函数，`hardLimit = window − reserve`、`autoLimit = 0.9 × hardLimit`，`reserve = max(16k, min(25%窗口, 输出上限), 5%窗口)`；`windowTokens` 是**入参**。全仓搜 `windowTokens` 只命中 `compact/*` 与 `degeneracy/incremental-novelty.ts`（无关的文本窗口），没有任何地方给出模型上下文窗口：配置层（`config/**`）无该字段（因此不存在「做成配置项」的违反），但 `packages/racp-client` 也不暴露模型元信息（`schema.ts` 里 `context` 是请求关联标识），`runtime/**` 亦无。`CompactInput.windowTokens` 无默认值、无调用方 → 「从当前模型的上下文窗口现算」这一步在运行期不存在。

另注意 `COMPACTION_DEFAULTS.minimumWindowTokens = 32_000`（`thresholds.ts:49,79-82`）：窗口信息缺失时一律按 32k 算，对真实 8k 窗口的模型会把 `hardLimit` 抬高约 3 倍（门槛偏松），是「宁可失败也不发注定被拒的包」的反向风险。

**证据**：`apps/server/src/compact/thresholds.ts:39-50,77-114`；`apps/server/src/compact/engine.ts:93-106`；全仓无 `windowTokens` 的调用方（`grep` 结果仅 `compact/*`）。

**缺口**：需要一条模型窗口的事实源（racp 或 host 元信息）并在请求前调用 `compactSession`；`minimumWindowTokens` 的下限保护应只用于「未知」而非覆盖已知的小窗口。

### 5.6-2 两条线 + 过硬边界不发请求——**部分实现（判定在，阻断不在）**

**反证过程**：`thresholds.ts:103-104` 用 `>=` 判 `hard` / `auto`；`engine.ts:450-467` 未过自动线直接 `below` 返回（不调模型、不落库）；`engine.ts:516-527` 与 `680-689` 两处都返回 `compacted:false, reason:'hard-limit'` + 明确 `error` 文本。单测覆盖了两个拒发分支（`test/compact-engine.test.ts:344-391`）。但运行期没有调用方（见上），所以「过了硬边界不发送请求」实际由 host 自己决定，平台侧没有阻断点。

**证据**：`apps/server/src/compact/thresholds.ts:96-114`；`apps/server/src/compact/engine.ts:447-467,516-527,669-689`；`test/compact-engine.test.ts:125-147,344-391`。

**缺口**：与 5.6-1 同一个接线缺口。

### 5.6-3 检查点固定在「请求发出前」——**未实现（无接线点）**

**反证过程**：`engine.ts:4-12` 的注释写着「在请求发出前」，但搜遍 `runtime/turn-driver.ts`、`worker/run-task.ts` 的 turn 驱动前后，没有任何「发送前」钩子调用 `compactSession`；`compose.ts:880` 直接写明「尚属遗留」。`run-task.ts:933-937` 的钩子是**事后**读事件。

**证据**：`apps/server/src/app/compose.ts:879-881`；`apps/server/src/app/worker-deps.ts:1022-1032`；`apps/server/src/worker/run-task.ts:411-418,933-937`。

**缺口**：需要 racp 侧 `session/history` + `compact` 操作，或由平台在 `turn/start` 前注入压缩后的历史。

### 5.6-4 临近边界两档提醒、每档只响一次——**未实现**

**反证过程**：全仓搜 `提醒|remind|Reminder|budgetNotice|nearLimit`，只命中 `skills/bundle.ts:78`（附件数量 warn）与 `cli.ts:553`（未使用导出提醒），与压缩无关。`compact/` 六个文件里也没有「距边界多少」「写下来」这类提示词或状态位。

**证据**：`grep '提醒|remind|Reminder|budgetNotice|nearLimit'` 于 `apps/server/src` → 仅两处无关命中；`apps/server/src/compact/**` 无相关实现。

**缺口**：两档提醒 + 「每档只响一次」的代数/状态位（可以存在 `agent_compactions` 或会话表）全部缺失。

### 5.6-5 摘要覆盖切点前全部消息——**已实现（提示词 + 结构保证）**

**反证过程**：`engine.ts:479-481` `old = window.old` 是切点之前的**全量**；`531-544` 把 `old`（截断后）整段塞进 `buildSummaryPrompt`，`summary.ts:131-146` 首次提示词写「下面列出的**全部消息**，一条都不能漏」。

**证据**：`apps/server/src/compact/engine.ts:479-544`；`apps/server/src/compact/summary.ts:116-172`。

**缺口**：无（模型不照做的风险由 `parseSummary` 的六段校验部分兜住）。

### 5.6-6 摘要保留六要素 + 精确路径/函数名/报错原文原样保留——**已实现（提示词层）**

**反证过程**：`summary.ts:27-34` 六段固定；`121-129` 硬性要求第 1 条「精确的文件路径、函数名、命令、行号、报错原文必须**原样照抄**」，第 4 条要求进度分「已完成/进行中/受阻」；`parseSummary`（`199-211`）对缺段判失败。

**证据**：`apps/server/src/compact/summary.ts:27-34,121-129,199-211`。

**缺口**：这是「靠指令约束模型」，无程序化校验（例如摘要里是否真的含有原文片段）。需求允许这种实现方式（原文说「必须保留」），但可观测性上拿不到反例，属于残余风险。

### 5.6-7 文件清单系统追加——**已实现**

**反证过程**：`collectFileMentions`（`summary.ts:219-246`）从**消息正文正则**抠路径，不依赖模型记忆；`engine.ts:488` 对 `old` 求清单，`539-543` 作为 `fileList` 进提示词块（`summary.ts:100-109`），成功收口时再用 `withFileListNote`（`engine.ts:397-403`）追加一句「系统追加·本段历史涉及的文件」到 checkpoint 末尾。

**证据**：`apps/server/src/compact/summary.ts:100-109,219-246`；`apps/server/src/compact/engine.ts:397-403,488,560,597,658`。

**缺口**：只覆盖「正文里出现过的路径」，`Write` 类工具入参里的路径若不在正文里不会命中（下限可用，上限不足）。

### 5.6-8 追加 checkpoint、不改写历史——**模块层已实现 / 运行期无从验证**

**反证过程**：`compact/store.ts:32-43` 只有 `INSERT INTO agent_compactions`，`store.ts:9-13` 约定「只追加：不 UPDATE、不 DELETE」；全文件无 `UPDATE`/`DELETE` 语句；`agent_compactions` 也没有承载「替换原消息」的列（`db/schema.ts:793-817`），迁移在 `migrations/0011_v21.sql`。`agent_messages` 从未被压缩模块写入。所以「原始对话一条不删」在模块层成立。

但「追加一条 checkpoint 供后续请求使用」的后半段不成立：没有代码把 checkpoint 读回来拼装请求（见 5.6-9）。

**证据**：`apps/server/src/compact/store.ts:10-13,32-62,99-114`；`apps/server/src/db/schema.ts:786-817`；`migrations/0011_v21.sql`。

**缺口**：无（模块内），但需要 5.6-9 的重建方。

### 5.6-9 喂给模型的内容 = 从最新 checkpoint 重建 + 保留最近真实消息——**部分实现（视图构造在，投递不在）**

**反证过程**：`engine.ts:484-514` 的 `view = { summary, messages: viewMessages }`，`viewMessages = stripOrphanToolResults(window.recent)`，`afterTokens` 与视图同口径估算（注释 `119-125` 说明这是刻意的单一事实源）。`selectRecentWindow`（`212-243`）从尾部按 token 预算切，且至少留一条、不从句首 tool 消息开始（两条例外都有单测 `test/compact-engine.test.ts:484-505`）。但 `CompactSuccess.view` 的消费方不存在：全仓 `compactSession|createCompactor` 的调用点为 0（除测试），`run-task` 的 turn 只发 `prompt`（`run-task.ts:911-930`），没有「重建后的历史」入口。

**证据**：`apps/server/src/compact/engine.ts:108-126,196-243,479-514`；`apps/server/src/worker/run-task.ts:911-930`。

**缺口**：`view` 需要接到 `turn/start` 的历史字段上。

### 5.6-10 第二次压缩用更新式提示词、不重压全量——**已实现**

**反证过程**：`summary.ts:74-79` `isIncremental` = `generation > 1 && previousSummary 非空`；`148-171` 是 UPDATE 语义提示词（PRESERVE / ADD / MOVE，显式禁止「把上一版整段贴回来再追加」）。`engine.ts:539-543` 把 `input.previousSummary` 传下去；分块链里每块把上一块摘要当 `previousSummary` 并强制 `chunkGeneration = max(generation, 2)`（`617-636`）。

**证据**：`apps/server/src/compact/summary.ts:68-79,148-171`；`apps/server/src/compact/engine.ts:614-655`；`test/compact-engine.test.ts:260-294`。

**缺口**：无。

### 5.6-11 分块链式摘要、不允许拼接多份摘要——**已实现**

**反证过程**：`planChunks`（`engine.ts:251-289`）按 token 切，最多 16 块（超了把尾部并进最后一块，宁可块大也不超块数）；链式循环 `617-655` 每块 `previousSummary = carried`，最终 `chained` 只取**最后一块的输出**（`653-654`），`657-663` 直接 `withFileListNote(chained)` —— 代码里不存在 `summaries.join(...)` 之类的拼接路径（全文件搜 `join` 只有提示词渲染与块切分）。断链即 `chained = null` 落阶 5（`638-651`）。

**证据**：`apps/server/src/compact/engine.ts:251-289,609-663`。

**缺口**：无。

### 5.6-12 工具输出三层（执行时落文件 / 2000 / 500+丢思考块且不删消息）——**部分实现（第二三层对，第一层缺「落文件」）**

**反证过程**：第二、三层对：`truncate.ts:26-31` `TRUNCATE_LIMITS = {first: 2_000, second: 500}`；`49-51` 标记 `[已截断 N 字符]`；`59-82` 只动 `role==='tool'` 正文、未超限返回同一引用、`dropThinking` 时置空 `thinking` 而非删字段；`130-147` 孤儿剔除（`toolCallId` 缺失也算孤儿）。`engine.ts:531-536` 拼摘要前先按 2000 截，`570-575` 阶 3 降 500 + 丢思考块。全程无 `filter` 掉正文消息（只有孤儿 toolResult 会被剔，且需求明确要求这么做）。

第一层**缺**：需求「抓取有上限，超出部分落文件，正文留截断标记与文件路径」。`truncate.ts:5` 注释说「在 sandbox 侧做，不在本模块」，但 sandbox 侧只有 1MB 截断 + 末帧 `truncated` 标志（`sandbox/protocol.ts:16,99-125`；`sandbox/exec-proxy.ts:131,343,381-384`），**没有落文件、没有文件路径、没有把路径交给模型**。全仓搜 `落文件|spillToFile|truncatedPath` 只有 `truncate.ts:5` 那句注释。

**证据**：`apps/server/src/compact/truncate.ts:20-147`；`apps/server/src/compact/engine.ts:529-575`；`apps/server/src/sandbox/protocol.ts:16,99-125`；`apps/server/src/sandbox/exec-proxy.ts:343-384`。

**缺口**：第一层缺「超出部分落文件 + 正文留标记与路径」。

### 5.6-13 保留真实最近窗口按 token 裁剪 + 剔除孤儿工具结果——**已实现（模块层）**

**反证过程**：`selectRecentWindow` 见 5.6-9；孤儿剔除 `stripOrphanToolResults`（`truncate.ts:130-147`）按窗口内 assistant 的 `toolCalls` 反查，`engine.ts:480` 应用，单测 `test/compact-engine.test.ts:420-467` 断言「孤儿被剔除且原始消息一条不少」。

**证据**：`apps/server/src/compact/engine.ts:212-243,479-482`；`apps/server/src/compact/truncate.ts:118-147`。

**缺口**：无（模块层）；投递侧同 5.6-9。

### 5.6-14 失败降级六步（预检 → 3 次 2/4/8 且鉴权配额首次即返回 → 有界削减 → 分块 → 兜底带标记 → 拒发记录原因）——**模块层已实现**

**反证过程**：逐阶对齐。
① 预检：`engine.ts:447-467`，用真实要发的内容估算（`estimateMessagesTokens`）。
② 重试：`SUMMARY_RETRY_BACKOFF_MS = [2_000, 4_000, 8_000]`（`engine.ts:31-40`），`runSummarize` 循环 `attempt <= maxRetries`（`352-380`），单人路径 `maxRetries = SUMMARY_MAX_RETRIES = 3` → 共 4 次请求、退避 2/4/8；致命错误首次即返回（`367-370`），`isFatalSummarizeError` 覆盖 401/403/429 与 quota/rate limit/billing 等（`159-192`）。
③ 有界削减：`568-607` 用 500 + 丢 thinking 再试一次（`maxRetries:0`）。
④ 分块：`609-663`。
⑤ 兜底：`669-678` + `buildFallbackSummary`（`302-347`）带 `[兜底 checkpoint · <ISO>] … 降级链已用尽` 明确标记；有上版摘要时原文沿用 + 说明，不重写不拼接。
⑥ 拒发：`680-689` 返回 `reason:'hard-limit'` + `error`（含 hardLimit 与兜底视图 token）。

单测逐个分支都有（`test/compact-engine.test.ts:148-390`），含「空摘要算失败」（`205-228`，`parseSummary` `summary.ts:199-203` 判 `empty`）与「鉴权/配额首次即返回」（`175-204`）。

**缺口**：模块内无缺口；但「记录失败原因」只把 `error` 放进返回值，没有任何 logger 调用（`engine.ts` 全文无 logger/告警），调用方若忽略返回值就静默了。运行期没有调用方，所以这一步事实上未发生。

**证据**：`apps/server/src/compact/engine.ts:31-40,159-192,352-380,447-689`；`apps/server/src/compact/summary.ts:190-211`。

### 5.6-15 空摘要视为失败——**已实现**

**反证过程**：`summary.ts:199-203` 空/纯空白 → `{ok:false, reason:'empty'}`；`engine.ts:555-566` 把不可解析的摘要一律不当成功（`layers` 记 `summary:empty` / `summary:missing-sections`），继续降级。单测 `test/compact-engine.test.ts:205-228`。

**证据**：`apps/server/src/compact/summary.ts:190-211`；`apps/server/src/compact/engine.ts:555-566`。

**缺口**：无。

### 5.6-16 可观测：前后 token / 摘要长度 / 是否兜底 / 第几代，后台能标出压缩点——**部分实现**

**反证过程**：记录侧成立：`agent_compactions` 有 `generation / before_tokens / after_tokens / summary_chars / fallback`（`db/schema.ts:793-817`），`engine.ts:491-514` 在成功收口写一行；纯函数与落库分开（`store.ts`）。

「后台能标出压缩点」**不成立**：`listCompactions`（`store.ts:127-138`）除自身与 `test/compact-store.test.ts` 外**没有任何调用方**；`apps/server/src/queries/**` 与 `apps/panel/src/**` 全仓搜索 `compaction` / `agent_compactions` 零命中（面板里没有展示组件，也没有对应 API 路由）。schema 注释 `790` 说「面板要按 issue 画第几代 checkpoint」，实际没画。

另外注意一个语义风险：`engine.ts:461` 落库的「压缩」只在使用 `compactSession` 时产生，而运行期实际写的行是 `run-task.ts:948-959` 从**host 事件**里还原的 —— 两者的 `generation`/`beforeTokens` 语义不同（一个是平台估的，一个是 host 报的），同一张表混两种来源，暂无字段区分。

**证据**：`apps/server/src/compact/store.ts:32-62,127-138`；`apps/server/src/db/schema.ts:786-817`；`apps/server/src/worker/run-task.ts:933-963`；`apps/server/src/http/webhook-v21.ts:764-780`；`apps/panel/src` 与 `apps/server/src/queries` 无 `compaction` 命中。

**缺口**：缺 `queries/` 读模型 + API + 面板「压缩点」标注；缺「记录来源（平台/host）」区分。

### 5.6-17 测试覆盖情况——**模块层较好，接线层为零**

**反证过程**：`compact-*.test.ts` 五个文件 79 个用例，覆盖了预检、重试次数与退避序列、致命错误短路、空摘要、有界削减、分块链、兜底、硬边界拒发、视图与孤儿剔除、记录字段 —— 不是 happy path 单打。反证的是接线：`test/v21-worker-integration.test.ts:781-878`「压缩观测（FR-5.6，本轮只做识别 + 记录）」全部断言围绕「写一行记录」与「工厂可构造」，没有一条用例断言「请求发出前发生了压缩」「过线不发请求」「两档提醒」。也就是说测试集恰好把缺口写成了预期行为。

**证据**：`apps/server/test/compact-engine.test.ts`、`compact-thresholds.test.ts`、`compact-truncate.test.ts`、`compact-summary.test.ts`、`compact-store.test.ts`；`apps/server/test/v21-worker-integration.test.ts:781-878`（用例名「本轮只做识别 + 记录」）。

**缺口**：缺端到端用例（压缩 → 重建视图 → 发起 turn）。

---

## 本节整体结论

**FR-5.4：部分实现，且有两处在运行期与需求相反。** 纯函数层（空集保护、超限整批拒绝、目录作用域、`clear` 显式许可）经得起反证，单测也钉得住。真正失效的是**输入与留痕**：`current` / `botLabels` 都取自我们自己的 `bot_labels`（`compose.ts:859-863`、`1658-1679`），于是（a）人手动打的标签永远进不了 `remove`，「删除权包含人打的标签」不成立；（b）`deletionOwner` 恒为 `'bot'`，「原主人是人还是机器」的记录无条件失真；（c）生产装订层（`compose.ts:871-875` → `run-task.ts:1362-1366`）把承载 owner 的 `detail` 丢掉，`actions.audit.detail` 与 `run_events` 都是 `null`，后台连自由文本都查不到。此外老路径仍保留 `humanVetoed`（`worker-deps.ts:581` + `workflows/bot-labels.ts:73-79`）＝「人删过永久不加回」，与 requirements.html:425 明确取消的语义冲突；提示词 `skills/prompt.ts:266` 还在教模型用旧 `intent/add/remove` 形状，会把标签动作整体导回那条老路径。

**FR-5.5：基本成立，一处读法分歧。** 顺序执行、遇失败即停、不合并 PR、无产出/不合契约时不写回都有代码与用例支撑。唯一实质缺口是「失败不得静默」的兜底反馈面：v2 路径**明确不发兜底评论**（`run-task.ts:1241-1243`），只有后台 signal + 终态 reaction；若需求要求「反馈与告警」兼备，则缺一半。另一处需产品裁决：`terminal !== 'turn.completed'` 但事件流里已有合规信封时会照常写回（`run-task.ts:1154-1175`）。

**FR-5.6：核心未实现，模块层质量高但整体是死代码。** `compact/` 六文件的公式、六阶降级、三层截断数字（2000/500）、空摘要判失败、孤儿剔除、更新式增量提示词、链式分块不拼接、只追加落库，逐条都能找到干净证据，单测 79 例全绿——这一点必须如实记上，不能算假实现。但「超过模型窗口时自动压缩」的运行期语义一项都不存在：没有窗口数据源（`windowTokens` 无来源）、没有请求前调用点（`compose.ts:879-881`、`worker-deps.ts:1022-1032` 两处注释自认「只暴露不调用」「留作遗留项」）、没有提示词两档提醒（全仓零命中）、没有 checkpoint 重建后投递给 `turn/start` 的通道、没有 `queries/`/面板的压缩点展示（`listCompactions` 零调用方），工具输出第一层「超出落文件 + 路径」也缺（sandbox 只标 `truncated`）。当前唯一在生产中发生的行为是「host 自己报了 compression 事件 → 落一行记录」，这与需求要求的「平台主动压缩」不是一件事；`test/v21-worker-integration.test.ts:781` 的用例名「本轮只做识别 + 记录」把这个缺口写成了预期。

**核查边界与残余风险**：（1）`docs/v21-contract.md` 不存在，多个模块把它当规范引用，契约一致性无法核对；（2）本次只做静态审查 + 五个纯函数单测文件的实际执行，未跑集成测试、未连 PG/Docker，也未验证 host 侧是否真的会报 `compaction` 事件；（3）`compact/thresholds.ts:122-124` `summaryBudgetFor`、`compact/truncate.ts:96-116` `layeredTruncate`、`compact/summary.ts:253-255` `promptTokens` 三个导出只有测试调用，属未接线代码，进一步印证模块层与运行期之间的断裂。
