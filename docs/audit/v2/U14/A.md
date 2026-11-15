# U14 5.7 面板：导航与页面 · A

> 核查范围：docs/requirements.html 行 1407-1438
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览

| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| FR-7.1 | 与需求冲突 | 五个全局页（总览/成本/质量/审计/系统）仍是独立路由 + 左栏导航项；无 dock，「系统」是页面不是模态框 |
| FR-7.2 | 部分实现 | 顶栏只有一颗状态点，四个数字与降级 chip 都不在状态带；会话流无 token/单价、无写回行 |
| FR-7.3 | 部分实现 | 原文折叠卡、系统提示词、输入区、verdict/actions JSON、写回行、`⋯` 菜单全缺；契约里也没有对应字段 |
| FR-7.4 | 与需求冲突 | 三栏宽度 208px / 自适应 / 全宽表格，头部 10px 无计数，行高 28 与 32 并存，强调条 2px 非 3px |
| FR-7.5 | 部分实现 | 重跑、暂停全部做到了禁用 + title；「标记人工」与面板输入区（禁用发送键）根本不存在 |

## 逐条

### FR-7.1

- **状态**：与需求冲突
- **证据**：
  - `apps/panel/src/routes.tsx:55`-`59` — 路由表里 `/`（总览）、`/costs`（成本）、`/quality`（质量）、`/audit`（审计）、`/system`（系统）五条全是 `nav: true, group: 'global'`，并在 `routes.tsx:111`-`117` 逐条挂到 `<AppLayout>` 下真实渲染。需求明写「不设总览、成本、质量、审计、系统五个独立页面」——这五个页面一个不少地存在。
  - `apps/panel/src/layout/nav.ts:22`-`28` — `GLOBAL_NAV` 就是这五项，顺序 `总览 / 成本 / 质量 / 审计 / 系统`。
  - `apps/panel/src/layout/Sidebar.tsx:66`-`72` — 这五项作为左栏第一个分组「全局」渲染成链接；全仓 `dock` 关键字检索为 0 命中（只有 `docker` 的 mock），不存在 dock 这一形态。
  - `apps/panel/src/layout/Sidebar.tsx:54` — 骨架是 `<aside class="w-56 ...">` 的左侧常驻侧栏，不是「dock 最右」。
  - `apps/panel/src/routes.tsx:59` — 「系统」是 `/system` 路由（`system.tsx` 整页 `PageHeader` + 多个 `Section`），不是模态框；全仓唯一的 `Sheet` 是 `DegradedBanner.tsx:101` 的降级明细，与「系统」无关。
  - `apps/panel/src/layout/nav.ts:48`-`54` — 项目级导航是 5 项（工作台 / Issue 中心 / 运行 / 设置 / 技能），需求要的是 3 项（Issue / 设置 / 技能）。
  - 三层里唯一对上的是项目上下文：`apps/panel/src/layout/RepoSwitcher.tsx:168` 的「全部项目」项 + `:45`-`66` 的左上角切换器。
- **缺口**：① 五个全局页仍在路由与导航里（正是需求点名要删的五个）；② 没有 dock，也就没有「dock 最右的系统入口」；③「系统」以整页存在，未收敛为模态框；④ 项目级导航多了「工作台」「运行」两项。
- **判定依据**：需求对第三层的要求是「系统打开模态框」且「不设五个独立页面」；代码是「五个独立页面 + 系统也是独立页面 + 全局入口在左栏」。这是行为方向相反，不是缺一个子条件，故判冲突。冲突行为在 `routes.tsx:55`-`59` 与 `nav.ts:22`-`28`。

### FR-7.2

- **状态**：部分实现
- **证据**：
  - `apps/panel/src/layout/AppLayout.tsx:119` — 顶栏里与状态有关的只有 `<GlobalStatus />`；`:156`-`195` 的实现是一颗 `StatusDot` + 一个状态词（离线/429 熔断中/pi-host 不可达/降级运行/正常）。顶栏没有「待处理 / 运行中 / 失败 / p95」四个数字。
  - 这四个数字只存在于页面内：`apps/panel/src/routes/overview.tsx:646`（`队列 N 待处理 / M 执行中 · 最老等待 …`）、`overview.tsx:758`（`p50/p95`）、`apps/panel/src/routes/repo-workspace.tsx:253`-`256`（今日任务/成功率/今日成本/p95 耗时）。距离「顶栏状态带」隔着一次页面跳转。
  - `apps/panel/src/layout/DegradedBanner.tsx:71`-`99` — 降级信息是 `h-9`（36px）的整行横幅 + 「详情」按钮 + `Sheet`，不是状态带里的 chip。
  - 系统健康内容确实存在但挂在页面上：`apps/panel/src/routes/system.tsx:137`（版本与协议）、`:177`（doctor 逐项检查）、`:222`（队列与保留策略）、`:256`-`274`（runtime flags 清单）、`:251`-`254`（保留期常量）。缺的是「模态框第一屏」这个形态。
  - 单次成本：`apps/panel/src/routes/issue-detail.tsx:361`-`366` 只渲染 `cost.costUsd`（有值才显示），数据来自 `components/issues/contract-extras.ts:104`-`111` 读 `durationMs`/`costUsd`；而契约 `packages/contract/src/api.ts:931`-`961` 的 `IssueTurn` 没有 `costUsd`、`durationMs`、token 或单价字段，因此该读取恒为 `null`，界面上永远不出现数字。全仓 panel 源码中 token 数字只出现在 `routes/task-detail.tsx:289`（信封 usage）与 `routes/costs.tsx:171`，会话流里没有；「单价」零命中。
  - 写回行：`routes/issue-detail.tsx` 全文（437 行）无任何「写回」字样，被改回/审计事件没有落点。
- **缺口**：① 顶栏状态带没有四个数字（数字散在总览与工作台两页）；② 降级 chip 不存在（是横幅）；③ 系统健康不在模态框第一屏（是 `/system` 整页）；④ 会话流没有 token 数与单价——`IssueTurn` 根本没这两个字段；⑤ 会话流没有写回行，被改回与审计事件无处可看。
- **判定依据**：五条去处里能对上「信息有地方可看」的只有系统健康与降级提示，但形态与位置全部不同；成本与写回两条连数据都没有（契约缺字段即不可能渲染），故只能判部分实现。

### FR-7.3

- **状态**：部分实现
- **证据（逐个元素）**：
  - 常驻标题行（编号、标题、状态）：`apps/panel/src/routes/issue-detail.tsx:107`-`114` 标题含 `#编号` + 标题，`:120` 状态 `Badge`。
  - `⋯` 动作菜单：**缺**。`issue-detail.tsx:132`-`156` 的 `actions` 是两个平铺控件（「复制链接」按钮 + 「打开 GitHub」链接），不是折叠的 `⋯` 菜单。
  - issue 原文折叠卡：**缺**。会话主体从 `issue-detail.tsx:197`-`226` 的「对话栏」（Issue / 轮次 / 人类 / 机器人 / labels）直接开始，没有原文卡、没有「原文 · 作者 · N 条评论」、没有展开态。数据也不存在：`packages/contract/src/api.ts:1070`-`1090` 的 `IssueSummary` 只有 `title/url/state/labels/participants/reactionState/pendingFeedback`，没有正文、作者、创建时间、评论数。
  - 系统提示词（居中、可折叠、markdown 原文）：**缺**。全 panel 源码检索「系统提示词」只在设置页（`components/settings/` 的配置项）出现，会话页无渲染点；`IssueSessionResponse`（`api.ts:1092`-`1095`）只有 `issue` + `turns`，没有提示词字段。
  - 消息流：✓ `issue-detail.tsx:229`-`233` 的 `<ol data-testid="issue-detail-turns">`。
  - 输入区：**缺**。`issue-detail.tsx` 全文无 textarea / 输入框 / 发送按钮；FR-7.5 要求的「发送按钮为禁用态」的载体不存在。
  - 人类输入在右：✓ `issue-detail.tsx:256`-`270`（`justify-end` 气泡）。触发来源：`issue-detail.tsx:253` 渲染 `CHANNEL_LABEL[turn.channel]`（`被 @` / `命令` / `自动`，定义在 `:59`-`63`）——是纯文本，不是 chip。
  - 事件元信息（`issues.opened · #318 · 时间`）：**部分缺**。`issue-detail.tsx:254` 只有时间，事件类型与编号没有；`IssueTurn`（`api.ts:931`-`961`）没有事件名字段。
  - agent 在左、无卡片：✓ `issue-detail.tsx:288`（`<li>` 无卡片壳）；回答 `:344`-`358`。
  - 三层工具（轮 → 组 → 单次调用）：✓ `issue-detail.tsx:291`-`306`（轮级折叠按钮）、`:318`-`341`（组）、`:385`-`395`（`ToolRow` 单次调用，`StatusDot` 区分成败）。
  - `verdict` / `actions` JSON（默认收起）：**缺**。`IssueTurn` 无 `verdict`/`actions` 字段；这两个 JSON 被渲染在另一个页面：`routes/task-detail.tsx:298` 与 `:339`（运行详情页的信封卡）。
  - 平台写回居中成行（`✓ 写回 标签 + 评论 slot=…`，失败换红）：**缺**。`issue-detail.tsx` 无此元素；`IssueTurn` 也没有写回结果字段。
- **缺口**：① `⋯` 动作菜单；② issue 原文折叠卡（含「原文 · 作者 · N 条评论」及展开态作者/时间/标签/正文）——契约无正文/作者/评论数字段；③ 系统提示词块——契约无字段；④ 输入区；⑤ 人类轮的触发来源是纯文本不是 chip；⑥ 事件元信息缺事件名与编号；⑦ 消息流内的 verdict/actions JSON（现落在运行详情页）；⑧ 平台写回行。
- **判定依据**：需求把本页定义为「会话流」并逐项列了七个自上而下的区块与三类消息行。代码里消息流骨架、左右分侧、三层工具都在并且有测试（`routes/__tests__/issue-detail.test.tsx:123`、`:149`），但上三块（原文卡、提示词、输入区）与三处行内信息（菜单、verdict/actions、写回行）缺失，且部分是契约层缺字段，故为部分实现。

### FR-7.4

- **状态**：与需求冲突
- **证据（四个比对项，逐个给两侧数字）**：
  - **同宽 320px**：
    - 设置左栏 = `13rem`（208px）：`apps/panel/src/routes/repo-settings.tsx:203` `lg:grid-cols-[13rem_minmax(0,1fr)]`。
    - Issue 队列不是左栏，是整页表格 + 右栏预览：`apps/panel/src/routes/issues.tsx:573` `xl:grid-cols-[minmax(0,1fr)_22rem]`（右栏 352px，左栏自适应）。
    - 技能列表没有左栏：`apps/panel/src/routes/repo-skills.tsx:272`-`286` 是一个全宽 `<ul>` + `md:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]` 的行内网格。
    - 需求 320 / 窄屏 300；代码 208 / 352 / 无固定宽，且全 panel 源码检索 `320`、`300px` 无命中。
  - **同款头部（30px 小标 + 计数）**：`apps/panel/src/components/settings/settings-chrome.tsx:224` 用 `text-sm font-medium`（14px）作分区名、`:232` 用 `text-2xs`（9.5px）摘要，两处都没有计数；`apps/panel/src/layout/Sidebar.tsx:119` 的分组标题是 `micro-label`，其字号为 `index.css:395` → `var(--text-2xs)` = `index.css:295` 的 `0.59375rem`（9.5px），同样无计数。需求 30px + 计数，代码 14px / 9.5px 且无计数。
  - **行高 28**：`apps/panel/src/layout/Sidebar.tsx:148` 是 `h-7`（28px）✓，但 `apps/panel/src/routes/overview.tsx:481` 的行是 `h-8`（32px），`settings-chrome.tsx:215` 的导航项是 `px-2 py-1.5` 双行（约 52px）。同一「一列可选条目」存在 28 / 32 / 52 三种高度。
  - **选中态「左侧 3px 强调条 + 浅强调底」**：强调条宽度是 2px 而非 3px —— `apps/panel/src/layout/Sidebar.tsx:152` `before:w-0.5`（0.5 = 2px）；`apps/panel/src/components/settings/settings-chrome.tsx:219`-`220` `lg:border-l-2`（2px）。强调底（`bg-brand-soft`）一致 ✓，但宽度数字不符。
- **缺口**：宽度（320/300 vs 208/352/无）、头部字号与计数（30px + 计数 vs 14px/9.5px 无计数）、行高（28 vs 28/32/52 三种）、强调条（3px vs 2px）。其中宽度与强调条是数值相反，行高与头部是「存在但不统一」。
- **判定依据**：模板规定「需求数字与代码常量不符 → 与需求冲突，列出两个数字」。本条四个子条件里有三个落在「数字不符」上，且三栏的形态本身（表格/整页网格 vs 一列可选条目）就不同，故判冲突而非部分实现。

### FR-7.5

- **状态**：部分实现
- **证据**：
  - 重跑：`apps/panel/src/routes/overview.tsx:199` 常量 `RERUN_DISABLED = '缺少写接口：POST /api/tasks/:id/rerun 尚未实现，面板不会假装发出请求'`，`:234` 挂到 `{ label: '重跑', disabledReason: RERUN_DISABLED }`，`:557`-`566` 渲染为 `disabled` 的 `<Button title={action.disabledReason}>`。✓ 禁用 + title 写明缺哪个接口。
  - 暂停全部：`apps/panel/src/routes/overview.tsx:867`-`875` — `disabled` + `title="缺少写接口：POST /api/flags（暂停全部）尚未实现"`。✓
  - 标记人工：**缺**。全 panel 源码检索「标记人工」「人工」均无对应按钮（命中项都是 mock 文案、`source: 'manual'` 数据、设置页说明文字）。既没有禁用按钮，也没有 title 说明。
  - 面板内发消息：**缺**。会话页没有输入区（`issue-detail.tsx` 437 行全文无输入控件），因此 FR-7.5 要求「输入区只呈现形态、发送按钮为禁用态」的载体整体不存在——不是「按钮没禁用」，是连按钮都没有。
  - 顺带做对的一处：`apps/panel/src/components/settings/general-section.tsx:7` 注释 + 实现——归档/删除没有接口时只放 `Alert` 说明，不做假按钮。
- **缺口**：① 「标记人工」动作完全没有出现（应画禁用按钮 + title 写明缺什么接口）；② 会话页输入区不存在，禁用态发送按钮无从谈起（本版范围明确要求「只呈现形态」）。
- **判定依据**：四种缺接口动作里两种完全达标（有 `disabled` 属性 + 具体接口名的 title，可核对到行）、两种完全不存在。缺失的是子条目而非细节，故判部分实现。

## 本节整体结论
本节五条**不能**判为已实现。FR-7.1 与 FR-7.4 是与需求反向的冲突：需求要删的五个全局页都还在路由与导航里，需求给定的 320px / 30px / 28px / 3px 四个数字在代码里分别是 208px（或 352px / 无）、14px 与 9.5px、28px 与 32px、2px。FR-7.3 的会话流骨架做对了一半（消息流、左右分侧、三层工具、轮级折叠），但自上而下的三块结构（原文卡、系统提示词、输入区）与三处行内信息（`⋯` 菜单、verdict/actions、写回行）整体缺失，其中原文卡与提示词在 `packages/contract` 层面就没有字段，补界面之前要先补契约。FR-7.2 与 FR-7.5 属于「做了一半的迁移」：信息都在，但落在需求明写不要的独立页面上（顶栏数字→总览/工作台、系统健康→`/system` 整页），或者只覆盖了部分动作。

## 核查边界

- 是否执行了命令：仅执行 `git rev-parse HEAD` 与 `git status --short`（确认工作区与 `_baseline.txt` 一致，HEAD = fbfa0298…，改动文件清单逐条吻合）。**未执行**任何 `pnpm` 测试或构建，全部结论为纯静态核查（读代码，不认注释与文档自述）。
- 未覆盖的条目及原因：无（5 条全部覆盖）。像素值均取 Tailwind 类名换算（`h-7`=28px、`h-8`=32px、`w-0.5`=2px、`border-l-2`=2px、`13rem`=208px、`22rem`=352px），未在浏览器里实测渲染；若 `index.css` 覆盖了这些工具类，数字需复核（已核对 `micro-label` → `var(--text-2xs)` = `0.59375rem` ≈ 9.5px，见 `index.css:295`）。
- 发现的额外问题（不属本节范围，仅记录）：
  1. `apps/panel/src/routes/__tests__/repo-nav.test.tsx:81` 用例名写「仓库组 **4 条链接**」，而 `layout/nav.ts:48`-`54` 的 `REPO_NAV` 已是 5 项（新增「技能」）——测试标题疑似未同步。
  2. `apps/panel/src/routes/issue-detail.tsx:33` 注释声称会话栏含「累计 token」，但 `:197`-`226` 的实际渲染只有 Issue / 轮次 / 人类 / 机器人 / labels，没有 token——注释与实现不一致（这是 FR-7.2 单次成本缺口的同源现象）。
  3. `design-refactor/` 下的 `e-unified.html` 设计稿未作为任何证据使用（按规范只认 `apps/panel/src` 的代码）。
