# U7-A 需求实现核查：requirements.html §5.7 面板：导航与页面（FR-7.1 ~ FR-7.5）

- 需求正文：`C:\Code\NodeProjects\pi-issue-bot\docs\requirements.html` 行 1407–1438
- 审查基线：仓库 `main` @ `fbfa029`，`apps/panel` 无未提交改动（`git status --short apps/panel` 为空；工作区其余改动与本核查无关）
- 判定依据：只采信 `apps/panel` 的实际代码；`design-refactor/e-unified.html` 仅作对照
- 状态取值：已实现 / 部分实现 / 未实现 / 与需求冲突 / 无法判定
- 只读核查，未修改仓库任何文件，未运行测试

**一句话前置结论**：`apps/panel` 仍是「五个全局页 + 五个仓库页 + 左栏两组导航」的旧形态，§5.7 描述的 D 版（三层结构 + 会话流）尚未落地。

---

## FR-7.1 三层结构，每层一个入口 —— 状态：与需求冲突

需求要求：面板只有三层 —— ① 项目上下文（左上角切换，含「全部项目」）② 项目级导航（Issue / 设置 / 技能，放 dock）③ 全局（dock 最右「系统」打开模态框）；**不设总览、成本、质量、审计、系统五个独立页面**。

### 证据

| 事实 | 证据 |
|---|---|
| 五个全局独立页面**全部存在**且在导航里 | `apps/panel/src/routes.tsx:55`（`/` 总览）、`:56`（`/costs` 成本）、`:57`（`/quality` 质量）、`:58`（`/audit` 审计）、`:59`（`/system` 系统），全部 `nav: true`、`group: 'global'` |
| 全局导航表本身就是这五项 | `apps/panel/src/layout/nav.ts:22-28` `GLOBAL_NAV = [总览, 成本, 质量, 审计, 系统]` |
| 左栏渲染成「全局 + 当前仓库」两组（旧分组导航，不是三层） | `apps/panel/src/layout/Sidebar.tsx:65-89`：`<NavGroup label="全局">` + `<NavGroup label="当前仓库">`；文件头 `:11-31` 明确写「一列、两个分组」 |
| 项目级导航是五项，多了工作台与运行 | `apps/panel/src/layout/nav.ts:48-54` `REPO_NAV = [工作台, Issue 中心, 运行, 设置, 技能]` |
| 「系统」是独立页面 `SystemPage`，不是模态框 | `apps/panel/src/routes.tsx:22` + `:59`；`apps/panel/src/routes/system.tsx`（整页，`PageHeader` + 多个 `Section`） |
| 项目上下文切换器存在，含「全部项目」 | `apps/panel/src/layout/RepoSwitcher.tsx:44-64`（左栏顶部触发器）、`:152-169`（`全部项目` 项，`navigate('/')`）、`:170-180`（`管理仓库…` → `/system`） |
| 无 dock 形态 | 全仓 `apps/panel/src` 检索 `dock` 只命中 mock 里的 `docker-*` doctor 项（`mocks/handlers/system.ts:34-35`），无 dock 组件/样式 |
| 无「系统模态框」 | 检索 `SystemModal` / `system-modal` 无命中；模态框组件只用于技能编辑与降级明细（`components/ui/dialog.tsx`、`components/skills/skill-editor-modal.tsx:46`） |
| 测试把五行全局导航钉死 | `apps/panel/test/routes.test.tsx:80` `expect(NAV_ITEMS.map(...)).toEqual(['/', '/costs', '/quality', '/audit', '/system'])`；`:57-76` 钉住全部 17 条路由 |

### 缺口

1. **直接冲突**：需求明确「不设总览、成本、质量、审计、系统五个独立页面」，实现里这五个页面连同路由、导航项、页面组件、测试断言全部在册（`routes.tsx:55-59`、`nav.ts:22-28`、`test/routes.test.tsx:80`）。这是 §5.7 里最硬的冲突项。
2. 第三层没有落地形态：无 dock，无「系统」模态框；`/system` 是整页。
3. 第二层多了「工作台」「运行」两个入口，需求只列 Issue / 设置 / 技能。
4. 只有第①层（项目上下文）基本符合：左上角切换且含「全部项目」，但其「管理仓库…」仍跳 `/system` 整页。

---

## FR-7.2 删掉的页面信息必须有去处 —— 状态：未实现

需求要求：顶栏状态带给「待处理 / 运行中 / 失败 / p95」四个数字 + 一个降级 chip；系统健康（doctor 各项、运行时开关、连接、只读常量）进「系统」模态框第一屏；单次成本以 token 数与单价出现在会话流里；被改回与审计事件落进写回行。

### 证据

| 需求项 | 现状 | 证据 |
|---|---|---|
| 顶栏状态带四个数字 | **不存在**。顶栏只有品牌、⌘K 输入、一个状态点、主题切换 | `apps/panel/src/layout/AppLayout.tsx:77-122`（header 内容）；`:119` 挂 `<GlobalStatus />` |
| 状态点 | 单个点 + 一个词（离线 / 429 熔断中 / pi-host 不可达 / 降级运行 / 正常），**无数字** | `AppLayout.tsx:156-195`（`GlobalStatus`），`:164-172` 状态表，`:188-192` 只渲染一个 `StatusDot` + 一个 label |
| 降级 chip | 有降级提示，但形态是**独立一行横幅**（36px，`h-9`）+ 抽屉明细，不是顶栏 chip | `apps/panel/src/layout/DegradedBanner.tsx:71-99`（横幅）、`:101-109`（`Sheet` 明细） |
| 四个数字的数据源 | 有，但只在**总览页**里用 | 待处理/运行中：`routes/overview.tsx:646`（`队列 N 待处理 / M 执行中`）；失败：`:203`（`useTasks({status:'failed'})`）；p95：`routes/overview.tsx:758`、`routes/repo-workspace.tsx:256` |
| 系统健康（doctor / 运行时开关 / 连接 / 只读常量） | 内容齐全，但落在**独立 `/system` 页面**上，不是模态框第一屏 | `routes/system.tsx:140-143`（版本与 PIN）、`:177-194`（doctor 逐项）、`:257-262`（runtime flags）、`:281`（`只读` 徽章） |
| 单次成本 = token 数 + 单价，出现在会话流 | **未实现**。会话流里只有 USD 金额一个数，且契约未提供该字段 | `routes/issue-detail.tsx:362-366`（只渲染 `formatUsd(cost.costUsd)`）；`components/issues/contract-extras.ts:104-111`（读 `durationMs`/`costUsd`，注释「契约还没提供这两个字段时返回 null」）；契约 `packages/contract/src/api.ts:931-964` `issueTurnSchema` 无 `usage`/`inputTokens`/`outputTokens`/`costUsd` 字段（token 计数只存在于 `TaskDetail` 的 `usage`，见 `api.ts:301`） |
| 被改回与审计事件落进写回行 | **未实现**。会话流里没有「写回行」这一元素 | `routes/issue-detail.tsx` 全文无写回行；`TurnRow` 仅 `HumanRow`（`:247-273`）/`BotRow`（`:276-382`）；`apps/panel/src` 检索「写回」在 `routes/issue-detail.tsx` 只出现在 `:37` 的注释里（说明审计去「运行」「审计」两页看） |

### 缺口

1. 顶栏状态带（4 数字 + 降级 chip）整体缺失 —— 这是 FR-7.2 的「此刻什么状态」主入口。
2. 系统健康仍在独立页面；需求要求的第一屏归位（模态框）不存在。
3. 会话流里的 token 数与单价无法显示：面板侧连字段都没有（契约 `IssueTurn` 缺 `usage`），只显示 USD，且该 USD 值在当前契约下恒为 `null`（`contract-extras.ts:109`）。
4. 写回行、改回/审计事件在会话流里没有任何呈现。

---

## FR-7.3 Issue 页是会话流，不是分区卡片 —— 状态：部分实现

需求顺序：常驻一行标题（编号、标题、状态、⋯ 动作菜单）→ issue 原文折叠卡（默认收起，只露标题 + 「原文 · 作者 · N 条评论」，展开才是作者/时间/标签/正文）→ 系统提示词（居中、可折叠、markdown 原文）→ 消息流 → 输入区。消息流内：人类/触发在右带来源 chip 与事件元信息；agent 在左无卡片、行 + 回答 + 三层工具 + 默认收起的 verdict/actions JSON；平台写回居中成行，失败换红。

### 证据（逐个元素）

| 元素 | 存在 | 证据 |
|---|---|---|
| 常驻标题行 | 部分 | `routes/issue-detail.tsx:100-114`：`PageHeader` 的 `title` = `issue#N` + 标题；`data-testid="issue-detail-title"` |
| 标题里的状态 | 有 | `:116-131` `badges`：状态徽章（`ISSUE_STATE_LABEL/TONE`）+ 状态过期徽章 + reaction chip |
| `⋯` 动作菜单 | **无** | `:132-156` `actions` 只有「复制链接」按钮与「打开 GitHub」链接；文件内无 `DropdownMenu`/`MoreHorizontal` 引用（检索无命中） |
| issue 原文折叠卡（默认收起） | **无** | 文件全文无原文卡；契约 `IssueSummary`（`packages/contract/src/api.ts:1070-1090`）只有 `title/url/state/labels/participants/reactionState/pendingFeedback`，**没有 `body`/`author`/`createdAt`**，也没有评论条数——「作者·时间·正文·N 条评论」在数据层拿不到 |
| 「原文 · 作者 · N 条评论」一行摘要 | **无** | 同上 |
| 系统提示词（居中、可折叠、markdown 原文） | **无** | `routes/issue-detail.tsx` 全文无「系统提示词」；检索全面板「系统提示词」只命中设置页编辑区（`components/settings/v21-agent-section.tsx:213,365`），那是可编辑输入框，不是会话流展示；契约 `IssueSessionResponse`（`api.ts:1092-1099`）只有 `issue` 与 `turns`，无 prompt 字段 |
| 消息流 | 有 | `:229-233` `<ol data-testid="issue-detail-turns">`，逐轮渲染 `TurnRow` |
| 人类/触发输入在**右** | 有 | `:256-257`：`flex justify-end` + 气泡（`rounded-[18px] max-w-[min(82%,37.5rem)]`） |
| 触发来源 chip | 部分 | `:251-255` 顶部一行是 login + `CHANNEL_LABEL`（被 @ / 命令 / 自动）+ 时间；**不是**需求举例的 `issues.opened · #318 · <ISO 时间>` 事件键形态，`IssueTurn` 也没有事件名/投递 id 字段 |
| 事件元信息 | 部分 | 同上：只有 `channel` + 时间（`:248,254`），无事件类型、无 issue 编号回显 |
| agent 在**左**、无卡片 | 有 | `:288`：`<li className="flex flex-col border-t border-border py-2.5">`，无卡片边框 |
| 回答（正文） | 有 | `:344-358`「输出」块 + `MessageText`（`:398-423`，按纯文本 + 代码围栏渲染，不解析 Markdown） |
| 三层工具：轮 → 组 → 单次 | 有 | 轮级折叠按钮 `:291-306`（`data-testid="issue-detail-tools-toggle"`，`aria-expanded`）；组 `:318-341`（`data-testid="issue-detail-tool-calls"`，显示 N 次操作 / N 次失败）；单次调用 `:332-336` → `ToolRow :385-395` |
| 工具成功/失败可见 | 有 | `:388` `<StatusDot tone={call.ok ? 'success' : 'danger'} />` |
| verdict / actions JSON（默认收起） | **无** | `routes/issue-detail.tsx` 全文无 `verdict`/`actions` 渲染（检索 `verdict` 只命中 `task-detail.tsx:298-325` 与设置页预览）；`IssueTurn`（`api.ts:931-964`）也无这两个字段；测试还显式断言它们被移除（`routes/__tests__/issue-detail.test.tsx:182-201`，含 `issue-detail-result`、`issue-detail-cost`、`issue-detail-rerun-button` 均须为 null） |
| 平台写回居中成行（`✓ 写回 标签 + 评论 slot=…`，失败换红） | **无** | 全文无写回行；`:361-379` 脚注只有成本、任务链接、评论链接 |
| 输入区（本版只呈现形态、发送禁用） | **无** | 文件内无 `<textarea>`/输入区/发送按钮（检索 `textarea`、`composer`、`发送` 在该文件与全面板无命中）；`IssueSession` 结构到消息流就结束（`:194-236`） |

### 缺口

1. **结构首两段缺失**：没有 issue 原文折叠卡，也没有系统提示词块；因此需求要求的「自上而下」五段只剩「标题 → 消息流」。
2. **数据层不支持**：`IssueSummary` 无 `body/author/createdAt`，`IssueSessionResponse` 无系统提示词字段（`api.ts:1070-1099`）——不扩契约无法补齐这两段。
3. 标题行缺 `⋯` 动作菜单。
4. 消息流缺三样：verdict/actions JSON 折叠块、平台写回行、输入区（含禁用发送）。而且现有测试（`routes/__tests__/issue-detail.test.tsx:182-201`）正在**反向加固**这些缺口的现状（断言它们不渲染），改需求实现时必须连带改测试。
5. agent 侧「无卡片只有行」、三层工具、人类右侧气泡、成本金额脚注这四点符合；「回答按 markdown 渲染」不符合（`MessageText :398-423` 只做纯文本 + 代码围栏），但需求只要求系统提示词是 markdown 原文，此处不单独计缺口。

---

## FR-7.4 三个左栏画法一致（320 / 窄屏 300 / 30px 小标 + 计数 / 行高 28 / 3px 强调条） —— 状态：与需求冲突

### 证据（逐个数值）

| 要求 | 现状 | 证据 |
|---|---|---|
| 左栏同宽 320px，窄屏 300 | **无 320 / 300 的布局宽度**。全 `apps/panel/src` 检索：`320` 只命中一个 mock token 数（`mocks/handlers/task-detail.ts:133` `outputTokens: 1_320`），`300` 只命中超时毫秒 / 字符上限 / issue 编号（`routes/issues.tsx:186`、`mocks/handlers/skills.ts:594`、`routes/__tests__/issues.test.tsx:126`）——两处都与左栏宽度无关。左栏实际 224px | `layout/Sidebar.tsx:54` `w-56`（=14rem=224px）；三处「左栏」宽度各不相同：Issue 页用表格 + 右侧 22rem 概要（`routes/issues.tsx:573` `xl:grid-cols-[minmax(0,1fr)_22rem]` + `:586` `aside`），设置页分区导航无固定宽（`components/settings/settings-chrome.tsx:192-198`），技能页是表格行（`routes/repo-skills.tsx:286` `md:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]`） |
| 同款头部（30px 小标 + 计数） | **不一致**。侧栏分组头是 `micro-label`（无计数、无 30px） | `layout/Sidebar.tsx:119` `<p className="micro-label px-2 pb-1">`；`index.css:385-392` `.micro-label { font-size: var(--text-2xs) }`，`index.css` 里 `--text-2xs: 0.59375rem`（≈9.5px）。`--control-md: 1.875rem; /* 30px */`（`index.css:90`）存在，但未被用作分组头高度。计数样式只在 `Section` 里有（`components/Section.tsx:52-62`，`text-base` 的 `h2` + `(N)`） |
| 行高 28 | **不一致**。侧栏项 28（`h-7`）符合；表格行 33px，设置项 `py-1.5`，技能行 `py-1.5` | `layout/Sidebar.tsx:148` `h-7`；`index.css:92` `--row-height: 2.0625rem; /* 33px */` + `components/ui/table.tsx:76` `h-[var(--row-height)]`；`components/settings/settings-chrome.tsx:215` `py-1.5`；`routes/repo-skills.tsx:286` `py-1.5` |
| 选中态：左侧 3px 强调条 + 浅强调底 | **2px**，不是 3px | `layout/Sidebar.tsx:152` `before:inset-y-1 before:left-0 before:w-0.5`（`w-0.5`=2px）；`components/settings/settings-chrome.tsx:219` `lg:border-l-2`（2px，且只在 `lg` 有）；`components/issues/issue-table.tsx:150` `border-l-2`（2px）；文件头 `Sidebar.tsx:22` 也自述「2px 品牌条」 |

### 缺口
1. 三条左栏事实不成立：宽度（224 / 12rem / 22rem / 自适应，各不相同）、头部（无统一 30px 小标 + 计数）、行高（28 / 33 / `py-1.5` 混用）。
2. 选中态强调条统一为 **2px**，需求是 3px；且设置页只在 `lg` 断点有强调条，窄屏没有。
3. 需求里 320 / 300 两个具体数值没有作为布局宽度出现在代码或样式中（宽度实际是 224 / 12rem / 22rem / 自适应），不是「差一点」而是未引入该尺度。

---

## FR-7.5 缺写接口的动作不许假装成功 —— 状态：部分实现

需求：没有对应写接口的动作（重跑、标记人工、暂停全部、面板内发消息）只画禁用按钮，并在 `title` 写明缺哪个接口；本版**面板内发送消息不做**，输入区只呈现形态，发送按钮禁用。

### 证据

| 动作 | 现状 | 证据 |
|---|---|---|
| 重跑 | **符合**（但不在 Issue 页，在总览待办行） | `routes/overview.tsx:199` `const RERUN_DISABLED = '缺少写接口：POST /api/tasks/:id/rerun 尚未实现，面板不会假装发出请求';`；`:234` 动作表；`:556-566` 渲染 `<Button disabled title={action.disabledReason}>`；测试 `routes/__tests__/overview.test.tsx:357` 附近断言禁用 + 原因 |
| 暂停全部 | **符合**（总览「快捷」区） | `routes/overview.tsx:866-875` `<Button ... disabled title="缺少写接口：POST /api/flags（暂停全部）尚未实现">`；`routes/__tests__/overview.test.tsx:22,357` |
| 标记人工 | **完全不存在**（既没禁用按钮，也没 title） | 全 `apps/panel/src` 检索 `标记人工` 无命中；`issue-detail.tsx` 无任何人工接管相关控件 |
| 面板内发消息 | **不存在**（连「只呈现形态」的输入区都没有） | 全 `apps/panel/src` 检索 `textarea` 无 `issue-detail` 命中、`发送`/`composer` 无命中；`IssueSession`（`issue-detail.tsx:194-236`）到消息流即结束。检索 `缺少写接口` 只有 `overview.tsx:199,871` 两处 |
| 是否有「假装成功」的写请求 | 无（面板整体只读，`routes/overview.tsx:58` 注释自述「整页没有任何写请求」） | 同上 |

### 缺口

1. 「重跑」「暂停全部」两条做对了（禁用 + title 写缺口），但都挂在**总览页**；§5.7 要删总览，这两处的落点（Issue 页标题行 `⋯` 菜单 / dock）都不存在，等于随总览一起消失。
2. 「标记人工」缺失 —— 需求要求的是**画禁用按钮**，现在是根本没有这个动作。
3. 「面板内发消息」的输入区形态缺失 —— 需求明确「只呈现形态 + 禁用发送按钮」，现在连形态都没有；而且契约里没有 `POST` 草稿/发送接口，需先确认 `title` 该写哪个接口名。

---

## 本节整体结论

**§5.7 五条需求：0 条「已实现」；2 条「部分实现」（FR-7.3、FR-7.5）；1 条「未实现」（FR-7.2）；2 条「与需求冲突」（FR-7.1、FR-7.4）。整体判定：本版面板尚未落地 §5.7。**

- **FR-7.1（P0）与需求冲突**：需求点名要删的五个独立页面（总览/成本/质量/审计/系统）在 `routes.tsx:55-59` 与 `nav.ts:22-28` 中全部在册，导航与测试断言（`test/routes.test.tsx:80`）还把这一形态钉死；无 dock、无系统模态框。只有「项目上下文切换（含全部项目）」这一层基本成立（`RepoSwitcher.tsx:152-169`）。
- **FR-7.2（P0）未实现**：顶栏状态带四个数字 + 降级 chip 不存在（顶栏只有一个状态点，`AppLayout.tsx:156-195`）；系统健康仍在 `/system` 整页；会话流只有 USD 金额且契约无 token/单价字段；写回行不存在。
- **FR-7.3（P0）部分实现**：会话流的「人类右 / agent 左 / 三层工具 / 成功失败可见 / 成本金额」符合；缺 issue 原文折叠卡、系统提示词块、`⋯` 动作菜单、verdict/actions JSON、平台写回行、输入区。前两项是**契约层缺字段**（`api.ts:1070-1099`），不只是界面欠账；现有测试还在反向加固现状（`issue-detail.test.tsx:182-201`）。
- **FR-7.4（P1）与需求冲突**：320/300 不存在（侧栏 224px），三处左栏宽度各不相同，行高 28/33/py-1.5 混用，强调条统一为 2px 而非 3px，无 30px 小标 + 计数头部。
- **FR-7.5（P0）部分实现**：重跑、暂停全部的「禁用 + title 写缺口」做对了，但落在将被删除的总览页；标记人工完全没有；输入区形态也没有。

**给实现方的顺序建议**（仅从依赖关系看，不改需求）：先把「会话流五段」所需字段补进契约（issue 正文/作者/时间/评论数、系统提示词、轮次 token 与单价、verdict/actions、写回行），否则 FR-7.3 / FR-7.2 的界面部分无法开工；FR-7.1 的删页与 FR-7.5 的按钮落点必须同批改，并与 `test/routes.test.tsx`、`routes/__tests__/issue-detail.test.tsx`、`routes/__tests__/overview.test.tsx` 的断言一起改。

**核查未覆盖（诚实声明）**：未运行任何测试（只读核查），因此「测试是否通过」不在本报告结论内；`design-refactor/e-unified.html` 只用于确认需求方向，未作为实现证据。
