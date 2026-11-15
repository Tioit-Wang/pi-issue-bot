# U7-B 需求实现核查：§5.7 面板导航与页面（FR-7.1 ~ FR-7.5）

核查基线：`C:\Code\NodeProjects\pi-issue-bot\docs\requirements.html` 行 1407-1438。
代码基线：`apps/panel/src` 与 `apps/panel/test`。**`design-refactor/*.html` 设计稿一律不作为实现证据。**
视角：反证。每条先构造「可能已经实现了」的假设，再找推翻它的代码事实。

被审代码版本：`git log` 最新面板提交 `54840eb feat(issue-tools): issue 全流程工具面 v3`。

---

## FR-7.1 三层结构（P0）

### 状态：**与需求冲突**

需求原文要点：面板只有三层 —— 项目上下文（左上角切换，含「全部项目」）+ 项目级导航（Issue / 设置 / 技能，放 dock）+ 全局（dock 最右「系统」打开模态框）。**不设总览、成本、质量、审计、系统五个独立页面。**

### 反证过程

1. 假设一：「五个页面只是被隐藏出导航，路由表里已经不存在了」。
   推翻：`PANEL_ROUTES` 里五条全局路由**全部在册且 `nav: true`**，不是隐藏。
   - `apps/panel/src/routes.tsx:55` `{ path: '/', label: '总览', nav: true, group: 'global', element: <OverviewPage /> }`
   - `apps/panel/src/routes.tsx:56` `{ path: '/costs', label: '成本', ... }`
   - `apps/panel/src/routes.tsx:57` `{ path: '/quality', label: '质量', ... }`
   - `apps/panel/src/routes.tsx:58` `{ path: '/audit', label: '审计', ... }`
   - `apps/panel/src/routes.tsx:59` `{ path: '/system', label: '系统', ... }`

2. 假设二：「`PANEL_ROUTES` 之外可能有过滤 / 白名单，实际注册时剔除了这几条」。
   推翻：注册处是全量 `map`，无任何过滤条件。
   - `apps/panel/src/routes.tsx:111` `{PANEL_ROUTES.map((route) => ...)}`

3. 假设三：「导航可能已按新三层重组，路由只是向后兼容的空壳」。
   推翻：导航表本身就是旧结构，且五项一字不差；页面是完整实现，不是空壳。
   - `apps/panel/src/layout/nav.ts:22-28` `GLOBAL_NAV` = 总览 / 成本 / 质量 / 审计 / 系统
   - `apps/panel/src/layout/Sidebar.tsx:66-72` 把 `GLOBAL_NAV` 整体渲染成左栏「全局」分组
   - 页面体量证明不是空壳：`routes/overview.tsx` 34,789 B、`routes/costs.tsx` 12,680 B、`routes/quality.tsx` 11,491 B、`routes/audit.tsx` 19,914 B、`routes/system.tsx` 16,951 B

4. 假设四：「dock 存在，只是我没找到」。
   推翻：全仓 `apps/panel/src` 搜 `dock|SystemModal|system-modal|系统.*模态` 零命中（唯一命中是 `mocks/fixtures.ts:357` 的 `docker-daemon`，与导航无关）。
   - 「系统」是完整路由页面 `apps/panel/src/routes/system.tsx:56` `export function SystemPage()`，顶部注释 `system.tsx:2` 自述「一屏三块 + 两条清单」，不是模态框。

5. 假设五：「项目切换器至少已经挪到左上角顶栏」。
   推翻：切换器仍在左栏内容流里，顶栏只有品牌 / ⌘K / 状态点 / 主题。
   - `apps/panel/src/layout/Sidebar.tsx:63` `<RepoSwitcher />`（左栏第一个子节点，`px-2 py-2` 内）
   - `apps/panel/src/layout/AppLayout.tsx:98-121` 顶栏内容 = 品牌 `pi-issue-bot` + 搜索按钮 + `<GlobalStatus />` + `<ThemeToggle />`，无仓库切换
   - 「全部项目」项确实存在，但它是下拉菜单里回全局总览的一项：`apps/panel/src/layout/RepoSwitcher.tsx:168`

6. 假设六：「也许已经在测试层把旧页面删掉了」。
   推翻：测试反而把现状钉死为「可直达」。
   - `apps/panel/test/routes.test.tsx:104-107` 把 `/costs`→`成本`、`/quality`→`质量`、`/audit`→`审计`、`/system`→`系统` 列为「路由可达（h1）」用例

### 额外冲突（需求未要求的第四、五个项目级入口）

需求项目级导航只要 Issue / 设置 / 技能 三项；实际是五项，多了「工作台」「运行」：
- `apps/panel/src/layout/nav.ts:48-54` `REPO_NAV` = 工作台 / Issue 中心 / 运行 / 设置 / 技能
- `apps/panel/src/routes.tsx:62-73` 对应 `/repos/:repo`、`/repos/:repo/runs` 两条额外一级路由

### 缺口

- 五条全局路由必须从 `PANEL_ROUTES`、`GLOBAL_NAV`、`Sidebar`、`test/routes.test.tsx` 一并移除；当前是「路由表里存在」，直接违反 FR-7.1 的「不设」。
- dock 与「系统」模态框完全不存在，需要从零新建。
- 项目上下文从「左栏顶部下拉」改为「左上角（顶栏）切换」。
- 项目级导航需从 5 项收敛到 3 项（Issue / 设置 / 技能）。
- 这是**架构级**冲突，不是样式偏差：`docs/plan-multi-repo.md §9` 的「多仓库工作台 + 双组侧栏」与 FR-7.1 的三层结构是两套导航模型。

---

## FR-7.2 删掉的页面信息必须有去处（P0）

### 状态：**部分实现（5 条信息去处只有 1 条落地，1 条部分落地，3 条无去处）**

需求拆成 4 个去处：①顶栏状态带四数字+降级 chip；②系统健康进「系统」模态框第一屏；③单次成本以 token 数与单价出现在会话流；④被改回与审计落进写回行。

### 反证过程

**① 顶栏状态带（待处理 / 运行中 / 失败 / p95 四个数字 + 降级 chip）→ 未实现**

- 假设「顶栏至少有个状态带」。发现顶栏实际只有一个状态点 + 一个状态词，**没有任何数字**：
  - `apps/panel/src/layout/AppLayout.tsx:164-172` 状态只有五种枚举 `离线 / 429 熔断中 / pi-host 不可达 / 降级运行 / 正常`
  - `apps/panel/src/layout/AppLayout.tsx:177-193` 渲染 `<StatusDot>` + `<span>{state.label}</span>`，无计数值
- 用 grep 直接找四个指标名，在 `apps/panel/src/layout/` 下**零命中**（`p95|待处理|运行中|失败` 在 `layout/*.tsx` 只命中外加 `RepoSwitcher.tsx:96` 的「仓库清单读取失败」，与指标无关）。
- 降级 chip：不是 chip，是独立的 36px 横幅行，且挂在顶栏**下方**而非状态带内：
  - `apps/panel/src/layout/DegradedBanner.tsx:77` `className="flex h-9 shrink-0 items-center ... bg-warn-bg"`（`h-9` = 36px，整行）
  - `apps/panel/src/layout/AppLayout.tsx:124` `<DegradedBanner />` 位置在 `</header>` 之后、`<main>` 之前

**② 系统健康进「系统」模态框第一屏 → 未实现**

- 前提「系统模态框」不存在（见 FR-7.1 第 4 条反证），所以「进模态框第一屏」无处可落。
- 系统健康（doctor 各项 / 运行时开关 / 连接 / 只读常量）当前在**独立页面**：
  - `apps/panel/src/routes/system.tsx:2-8` 自述五块：版本与协议 / doctor 逐项 / 队列与保留策略 / 仓库 / 能力
  - `apps/panel/src/routes/system.tsx:137` `<Section first title="版本与协议">`
- 唯一称得上「模态框形态」的是降级明细 Sheet：`apps/panel/src/layout/DegradedBanner.tsx:101-130` `<Sheet ... title="系统降级">`，内容只有未满足条件列表（`DegradedBanner.tsx:122-129`），不含 doctor 逐项。**这一条算部分落地（降级原因有第一屏去处），但载体不是「系统」模态框。**

**③ 单次成本以 token 数与单价出现在会话流 → 未实现**

- 会话流里只有一个美元总额，没有 token 数、没有单价：
  - `apps/panel/src/routes/issue-detail.tsx:362-366` `{formatUsd(cost.costUsd)}`，`title="本轮成本（USD）"`
- 数据层也确实读不到 token 与单价：
  - `apps/panel/src/components/issues/contract-extras.ts:96-101` `RunCost` 只有 `durationMs` / `costUsd`
  - `apps/panel/src/components/issues/contract-extras.ts:104-111` `readRunCost` 只取 `durationMs` / `costUsd`
  - 契约侧 `issueTurnSchema`（`packages/contract/src/api.ts:931-964`）无 `tokens` / `inputTokens` / `outputTokens` / `unitPrice` 任一字段
- 结论：不是「忘了渲染」，是**数据面缺字段**。做到这条要改契约 + 查询层。

**④ 被改回与审计落进写回行 → 未实现（写回行本身不存在）**

- `apps/panel/src/routes/issue-detail.tsx` 全文 437 行，搜 `写回|writeback|revert|改回` 零命中（唯一相关命中在该文件 `:37` 的注释「判定与写回的审计在『运行』『审计』两页可查」——作者明确表示把这些信息**推给别处**，与 FR-7.2 要求相反）。
- 被改回 / 审计信息实际在独立页面：`apps/panel/src/routes/audit.tsx`、`apps/panel/src/routes/task-detail.tsx:49` `writeback: '写回'`、`task-detail.tsx:298-325` verdict 展开。

### 缺口

| # | 信息 | 需求去处 | 实际 | 判定 |
|---|---|---|---|---|
| ① | 待处理/运行中/失败/p95 | 顶栏四个数字 | 单个状态点+状态词 | 未实现 |
| ① | 降级 chip | 顶栏状态带内 chip | 顶栏下方 36px 整行横幅 | 形态不符 |
| ② | 系统健康 | 「系统」模态框第一屏 | 独立 `/system` 页；仅降级原因进 Sheet | 未实现（降级明细部分落地） |
| ③ | 单次成本 token 数与单价 | 会话流 | 仅 `$0.0xxx`；契约无 token 字段 | 未实现（缺数据面） |
| ④ | 被改回与审计 | 写回行 | 无写回行；推给 /audit 与 /runs/:id | 未实现 |

注：`apps/panel/src/routes/issue-detail.tsx:35-37` 的注释明确写了「刻意去掉……判定与写回的审计在『运行』『审计』两页可查」——这是本文件对 FR-7.2 的**反向声明**，不是漏实现。

---

## FR-7.3 Issue 页是会话流（P0）

### 状态：**部分实现（五个必备段落里 3 个完全缺失）**

需求自上而下：常驻标题行（编号、标题、状态、`⋯` 动作菜单）→ issue 原文折叠卡（默认收起，只露标题与「原文 · 作者 · N 条评论」）→ 系统提示词（居中、可折叠、markdown 原文）→ 消息流 → 输入区。
消息流内：人类/触发的输入在右 + 触发来源 chip + 事件元信息；agent 在左、无卡片、只有行/回答/三层工具（轮 → 组 → 单次调用）；verdict/actions JSON 默认收起；平台写回居中成行。

### 反证过程（逐段）

**A. 常驻标题行 → 部分实现**

- 存在编号 + 标题 + 状态：`apps/panel/src/routes/issue-detail.tsx:107-131`，编号 `kind#number`（`:109`）、标题（`:110-112`）、状态 Badge（`:120`）。
- 「`⋯` 动作菜单」**不存在**：`PageHeader` 的 `actions` 是自由插槽（`apps/panel/src/components/PageHeader.tsx:21` `<div className="flex shrink-0 items-center gap-1.5">{actions}</div>`），issue 页塞进去的是两个**平铺按钮**「复制链接」「打开 GitHub」：
  - `apps/panel/src/routes/issue-detail.tsx:134-143` 复制链接 Button
  - `apps/panel/src/routes/issue-detail.tsx:144-154` 打开 GitHub `<a>`
- grep `⋯|MoreHorizontal|DropdownMenu` 全仓只命中 `apps/panel/src/layout/RepoSwitcher.tsx:6,45,184`（仓库切换器），issue 页无动作菜单。

**B. issue 原文折叠卡（默认收起）→ 未实现**

- `apps/panel/src/routes/issue-detail.tsx` 全文无 `<details>` / 折叠原文卡 / 「原文 · 作者 · N 条评论」字样。会话主体从标题行直接进「对话栏」（`:196-226`）。
- 数据面也不支持：`issueSummarySchema`（`packages/contract/src/api.ts` 内 `issueSummary` 定义）只有 `repo/kind/number/title/url/state/stateStale/labels/participants/reactionState/pendingFeedback`，**没有 issue 正文、没有评论数**。
- 反证「可能在 Issue 列表页」：`apps/panel/src/routes/repo-issues.tsx:13-22` 只是把 `repoLock` 传给 `IssuesPage` 的表格，无折叠原文卡。

**C. 系统提示词（居中、可折叠、markdown 原文）→ 未实现**

- grep `系统提示词|systemPrompt` 在 `apps/panel/src` 只命中 `apps/panel/src/layout/nav.ts:70` 的一行注释（说明设置页「执行」分区里有系统提示词**编辑器**），issue 会话页零命中。
- 「markdown 原文展示」也不可能：会话正文的渲染器 `MessageText`（`apps/panel/src/routes/issue-detail.tsx:398-423`）的注释 `:397` 明写「正文按纯文本渲染（不解析 Markdown / HTML）；代码围栏用等宽块」，切分函数 `splitFences`（`:426-437`）只按 ``` 围栏切代码块，**不解析任何 markdown 结构**。所以即便有系统提示词，也不会是「markdown 原文表格/标题渲染」形态 —— 而需求要求的是「markdown 文本**原文**」，这一条在语义上反而接近，但入口不存在，故仍判未实现。
- 契约 `issueSessionResponseSchema` 只有 `{ issue, turns, generatedAt… }`，无提示词字段。

**D. 消息流 → 已实现（UI 骨架），但 3 个子要求未满足**

D-1 人类输入在右：**已实现**
- `apps/panel/src/routes/issue-detail.tsx:256-257` `<div className="flex min-w-0 justify-end">` + 气泡 `rounded-[18px] rounded-br-[4px] bg-foreground/[0.08]`

D-2 触发来源 chip + 事件元信息：**部分实现**
- 有 login、渠道词、时间：`apps/panel/src/routes/issue-detail.tsx:251-255`（`CHANNEL_LABEL` 定义在 `:59-63`，取值「被 @ / 命令 / 自动」）
- 缺需求示例里的事件名与 #号：需求要求 `issues.opened · #318 · 2026-05-31T08:24:11Z` 形态；实际无 `issues.opened` 这类事件名（契约 `issueTurnSchema` 无 event 字段），且渠道是**普通 `<span>` 文字**，不是 chip（无背景/圆角/边框类）。

D-3 agent 在左、无卡片：**已实现**
- `apps/panel/src/routes/issue-detail.tsx:288` `<li className="flex min-w-0 flex-col gap-1.5 border-t border-border py-2.5">` —— 只有上边框分隔线，无卡片容器（无 `rounded`/`bg-card`/`shadow`），内容左对齐。

D-4 三层工具折叠（轮 → 组 → 单次调用）：**名义三层，中间层是假的**
- 第一层（轮）：`apps/panel/src/routes/issue-detail.tsx:291-306` 折叠按钮，`aria-expanded={toolsOpen}`，`◂▸` 指示符
- 第二层（组）：`apps/panel/src/routes/issue-detail.tsx:318-331` —— **只有一个写死的组头**「工具调用 · N 次操作」，`toolsOpen` 为真时它无条件渲染，且不可能出现第二个组。它不是「按组折叠」，只是给工具列表加了一行标题。
- 第三层（单次调用）：`apps/panel/src/routes/issue-detail.tsx:385-395` `ToolRow`，成功/失败用 `StatusDot`（`:388` 绿/红）
- 为什么中间层无法做真：`issueToolCallSchema`（`packages/contract/src/api.ts:908-919`）字段只有 `name / summary / at / ok`，**没有 group / category 字段**，分组所需的维度在数据面不存在。
- 结论：视觉上有三段缩进层级，语义上只有「轮折叠 → 工具列表」，与需求的「轮→组→单次」不是一回事。判**部分实现**。

D-5 verdict / actions JSON 默认收起：**未实现**
- `apps/panel/src/routes/issue-detail.tsx` 全文 437 行无 `verdict` / `actions`（检索零命中）。
- 对照：`apps/panel/src/routes/task-detail.tsx:298-325` 有 verdict 展开，但那是**运行详情页**，且不是「默认收起」的会话流内联块。
- 契约层同样缺：`issueTurnSchema` 无 `verdict` / `actions` 字段。

D-6 平台写回居中成行：**未实现**
- 无任何写回行组件；`issue-detail.tsx` 中 `写回` 只出现在 `:37` 的「去别页看」注释里。

D-7 额外层（需求没有的）：「对话栏」
- `apps/panel/src/routes/issue-detail.tsx:196-226` 在标题行与消息流之间插入一条 `bg-muted/40` 的会话级元信息栏（Issue / 轮次 / 人类 / 机器人 / labels）。需求序列里没有这一层，属于多余结构。

**E. 输入区 → 未实现**

- `apps/panel/src/routes/issue-detail.tsx` 全文件结束于 `splitFences`（`:426-437`），会话主体 `SessionBody`（`:189-236`）以 `</ol>` 收尾，**无输入区、无 textarea、无发送按钮**。
- 全仓 grep `发送` 在 `apps/panel/src/**/*.tsx` 零命中。FR-7.5 说的「发送按钮为禁用态」连禁用按钮都没有。

**F. 旧的分区卡片式 issue 详情 → 未发现残留**

- 反证通过：`apps/panel/src/routes/issue-detail.tsx:35-37` 声明已删掉结论正文 / 标签与理由 / 缺哪些信息 / run 时间线表格 / reaction 台账；代码核对一致，会话区（`:194-235`）确实只有元信息栏 + 轮次列表，无 `Section`/`Card` 分区。

### 缺口

1. 原文折叠卡（含作者、时间、标签、正文、评论数）全缺，且需先补契约（`issueSummary` 无 body / 评论数）。
2. 系统提示词段落全缺，且契约无字段。
3. 标题行动作用 `⋯` 菜单收纳，当前是两个平铺按钮。
4. 三层工具折叠的「组」层是写死的单组；要真分组须给 `IssueToolCall` 加分组维度。
5. verdict / actions JSON（默认收起）在会话流内不存在。
6. 写回行（居中成行、`✓ 写回 标签 + 评论 slot=format-review · 2/2 成功`、失败换红）不存在。
7. 输入区（底部呈现形态 + 禁用发送按钮）不存在。
8. 人类轮的事件元信息缺事件名与 #号，渠道词未做成 chip。
9. 多余的「对话栏」层需要决定去留。

---

## FR-7.4 三个左栏画法一致（P1）

### 状态：**未实现（前提不成立：三个左栏不存在）**

需求：Issue 队列、设置分区、技能列表同宽（320px，窄屏统一降 300）、同款头部（30px 小标 + 计数）、行高 28、选中态统一「左侧 3px 强调条 + 浅强调底」。

### 反证过程

1. 假设「三个左栏存在，只是宽度没对齐」。逐个查三处布局，结果是**都没有左栏**：

| 左栏（需求） | 对应页面 | 实际布局 | 证据 |
|---|---|---|---|
| Issue 队列 | `/repos/:repo/issues` | 全宽数据表格，无左栏 | `apps/panel/src/routes/repo-issues.tsx:13-22` → `IssuesPage repoLock`；`apps/panel/src/routes/issues.tsx` 32 KB 表格页 |
| 设置分区 | `/repos/:repo/settings` | 两列 grid，左列 **13rem = 208px** | `apps/panel/src/routes/repo-settings.tsx:203` `'grid min-w-0 gap-4 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-6'` |
| 技能列表 | `/repos/:repo/skills` | 单表格，行内 grid 列，无左栏 | `apps/panel/src/routes/repo-skills.tsx:286` `grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]`（这是**表格行**内的列定义，不是左栏） |

2. 假设「320px 可能在别处以像素值写死」。
   推翻：全仓 `apps/panel/src` 搜 `320|w-80|300px|min-w-[300` 只有两条命中，且都是**注释**里描述总览页留白，与左栏无关：
   - `apps/panel/src/routes/overview.tsx:172` 注释「在 1851 宽下会在中间留出 300px 空白」
   - `apps/panel/src/routes/overview.tsx:461` 同类注释
   - **`320` 在整个 `apps/panel/src` 零命中**（含 `index.css`）。

3. 假设「窄屏 300 可能有响应式断点」。
   推翻：`apps/panel/src/index.css` 无 `--sidebar-width` / `--col-*` 之类栏宽 token（grep `--sidebar|--col` 零命中），也无 300 值。

4. 假设「行高 28 已经作为全局 token 存在」。
   部分推翻：确有两个相关 token，但都不是「左栏行高」：
   - `apps/panel/src/index.css:89` `--control-sm: 1.75rem; /* 28px */` —— 控件高度（按钮等）
   - `apps/panel/src/index.css:92` `--row-height: 2.0625rem; /* 33px：表格 / 列表行 */` —— **表格/列表行高是 33px，不是 28px**
   - 三个左栏中唯一用到 28px 行的，是**全局侧栏** `apps/panel/src/layout/Sidebar.tsx:148` `'relative flex h-7 items-center rounded-sm px-2 text-sm'`（`h-7` = 28px）—— 但这是左侧导航栏，不是需求说的三个左栏。

5. 假设「选中态至少做到了 3px 强调条」。
   推翻：唯一的选中态是 2px，且在侧栏：
   - `apps/panel/src/layout/Sidebar.tsx:152` `isActive ? 'bg-brand-soft font-medium text-foreground before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-brand'`
   - `before:w-0.5` = **2px**，不是 3px。`Sidebar.tsx:22-23` 的注释也自述「品牌色 8% 底 + 左缘 **2px** 品牌条」。
   - 「浅强调底」用的是 `bg-brand-soft`（品牌色），侧栏注释 `Sidebar.tsx:22` 明确说「不是胶囊高亮」，方向与需求的「浅强调底」不完全一致。

6. 假设「至少有一个共用的左栏组件保证将来一致」。
   推翻：`apps/panel/src/components/` 下无 `SidePanel` / `ListPanel` / `NavList` 之类共用左栏组件（目录清单只有 `Section.tsx`、`Toolbar.tsx` 等通用件）。

### 缺口

- 三个「一列可选项」的左栏形态本身不存在（Issue 是表格、设置是 208px 两列、技能是表格），FR-7.4 的四个「同」字（同宽 / 同头部 / 同行高 / 同选中态）无从落地。
- 需先抽出共用左栏组件，再统一 320px（窄屏 300）、30px 小标+计数、28px 行高、3px + 浅强调底。
- 现有唯一近似物是全局侧栏（`w-56` = 224px、`h-7`、2px 条），与需求数值均不符，不能直接复用。
- 另注：需求说「30px 小标」，侧栏分组标题现有实现是 `micro-label` 文字标签（`apps/panel/src/layout/Sidebar.tsx:119`），无 30px 高度、无计数。

---

## FR-7.5 缺写接口的动作不许假装成功（P0）

### 状态：**部分实现（4 个动作里 2 个合规，2 个没有 UI）**

需求：重跑、标记人工、暂停全部、面板内发消息这四类动作，在没有对应写接口时只画**禁用按钮**，并在 `title` 里写明缺哪个接口。本版面板内发送**不做**，会话流底部输入区只呈现形态，发送按钮为禁用态。

### 反证过程

1. 「重跑」→ **合规**（但位置错：在需求要求不存在的总览页）
   - `apps/panel/src/routes/overview.tsx:199` `const RERUN_DISABLED = '缺少写接口：POST /api/tasks/:id/rerun 尚未实现，面板不会假装发出请求';`
   - 挂载：`apps/panel/src/routes/overview.tsx:234` `{ label: '重跑', disabledReason: RERUN_DISABLED }`
   - 真 `disabled` 属性：`apps/panel/src/routes/overview.tsx:561` `disabled`（在 `:540` 的 `action.disabledReason === undefined ? ... :` 分支内）
   - `title` 真写明接口：`apps/panel/src/routes/overview.tsx:562` `title={action.disabledReason}`
   - 判定：**真禁用（HTML `disabled`）+ title 真写接口名**，不是仅样式变灰。

2. 「暂停全部」→ **合规**（同样在总览页）
   - `apps/panel/src/routes/overview.tsx:870-874`：`disabled` + `title="缺少写接口：POST /api/flags（暂停全部）尚未实现"`，按钮文案在 `:874` `{overview.queue.pausedUntil === null ? '暂停全部' : '已全局熔断'}`
   - 判定：合规。总览页注释 `overview.tsx:58` 亦声明「只读红线：整页没有任何写请求（『暂停全部』等缺接口的动作只画禁用按钮）」。

3. 「标记人工」→ **未实现**
   - 全仓 grep `标记人工|人工接管` 在 `apps/panel/src` 零命中。既没有按钮，也没有禁用按钮。

4. 「面板内发消息」→ **未实现（连禁用按钮都没有）**
   - 会话流底部无输入区（见 FR-7.3 E 条）：`apps/panel/src/routes/issue-detail.tsx:189-236` 以 `<ol>` 收尾。
   - 全仓 grep `发送` 零命中，grep `textarea` 在 issue-detail 零命中。
   - 判定：需求说「发送按钮为禁用态」，实际是「没有按钮」。这比合规更保守，但不满足需求明确要求的「只画禁用按钮」形态，属**未实现**而非合规。

5. 反向核查（是否存在「假装成功」的假动作，即点了没反应或弹假成功）：
   - 未发现。`overview.tsx` 的两个禁用按钮无 `onClick`；`apps/panel/src/routes/issue-detail.tsx:134-143` 的「复制链接」是真实剪贴板写入（`:85-94` `navigator.clipboard.writeText`），不是假装。
   - 唯一 `disabled` 但 `title` 不写接口的是业务性禁用，不属于 FR-7.5 范围：`apps/panel/src/routes/overview.tsx:887` `disabled title="先在左栏选择一个仓库"`、`apps/panel/src/routes/tasks.tsx:198`、`apps/panel/src/routes/audit.tsx:269`（清筛选）、`apps/panel/src/routes/issues.tsx:610`（翻页）。

### 缺口

- 「标记人工」需新增禁用按钮 + title 写明缺失接口（若确无接口）。
- 「面板内发消息」需先建会话流底部输入区（形态），再放禁用发送按钮 + title 写明缺失接口。
- 两个已合规的禁用按钮（重跑 / 暂停全部）当前位于总览页；一旦按 FR-7.1 删掉总览页，这两个按钮需要迁移到有归属的页面，否则合规证据会随页面一起消失。

---

## 本节整体结论

**§5.7 整体：未按需求实现（1 条直接冲突、1 条部分、1 条部分、1 条未实现、1 条部分）。**

| 需求 | 状态 | 一句话 |
|---|---|---|
| FR-7.1 三层结构 | **与需求冲突** | 五个被点名禁止的独立页面在路由表与导航表里**全部健在且 `nav: true`**（`routes.tsx:55-59`、`nav.ts:22-28`），dock 与「系统」模态框零命中；项目级导航还多出「工作台」「运行」两项 |
| FR-7.2 信息去处 | **部分实现** | 5 条里只有「降级明细」落地（且是 36px 横幅 + Sheet，不是状态带 chip）；四数字状态带、系统模态框第一屏、token/单价、写回行均不存在，其中 token/单价与写回行是**契约缺字段**，不是漏渲染 |
| FR-7.3 会话流 | **部分实现** | 消息流左右分栏、agent 无卡片这两点真做到了；但原文折叠卡、系统提示词、verdict/actions、写回行、输入区**五段全缺**；「三层工具折叠」的中间「组」层是写死的唯一组头，契约无分组字段，属名义三层 |
| FR-7.4 三栏一致 | **未实现** | 三个左栏形态本身不存在（表格 / 208px 两列 / 表格）；`320` 全目录零命中，列表行高 token 是 33px，唯一选中条是侧栏 2px |
| FR-7.5 禁用按钮 | **部分实现** | 重跑、暂停全部两个是**真 `disabled` + title 写明接口**（合规但位于总览页）；标记人工、面板内发送连按钮都没有 |

关键判定：面板当前实现的是 `docs/plan-multi-repo.md §9` 的「多仓库工作台」（全局五页 + 仓库五页的双组侧栏），**与 FR-7.1 的「三层 + dock + 系统模态框」是两套互斥的导航模型**。FR-7.2 / FR-7.3 / FR-7.4 中缺失的部分（token 与单价、原文卡、系统提示词、verdict/actions、写回行、三层工具分组）多数不是 UI 遗漏，而是**契约与查询层没有对应字段**——这意味着 §5.7 不是一轮前端改造能补齐的，需要契约先动。

另需注意：`apps/panel/src/routes/issue-detail.tsx:35-37` 的文件头注释与 `apps/panel/src/layout/Sidebar.tsx:12-31` 的结构图，都把这套旧结构写成了「刻意设计」。代码是自洽的、有测试钉住的（`apps/panel/test/routes.test.tsx:104-107`），所以这不是「实现了但写错」，而是「按另一份设计文档实现的」。改 §5.7 必须同时改这两处注释与相关测试，否则下一个人会照着注释改回去。

### 本次核查的边界

- 只读，未修改仓库任何文件。
- 未运行 `pnpm` 任何命令（`typecheck` / `lint` / `test`）；结论全部来自静态阅读源码与测试文件，未做运行时验证。
- 未审查 `design-refactor/` 下 HTML 设计稿（按任务要求不算实现）。
- 未审查 `apps/panel/src/mocks/**`（MSW 假数据，属测试脚手架，不构成产品行为证据）。
