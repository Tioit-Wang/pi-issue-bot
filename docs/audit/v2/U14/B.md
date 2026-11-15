# U14 5.7 面板：导航与页面 · B

> 核查范围：docs/requirements.html 行 1407-1438
> 代码基线：见 docs/audit/v2/_baseline.txt（HEAD fbfa029，工作区有未提交改动，但 `apps/panel/src` 无改动）

## 结论速览

| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| FR-7.1 | 与需求冲突 | 总览/成本/质量/审计/系统五个独立页面全部仍在路由表里（`routes.tsx:55-59`），且不存在 dock、系统不是模态框 |
| FR-7.2 | 部分实现 | 顶栏只有「一个状态点 + 一个状态词」，四个数字散在工作台页正文里；系统健康是整页 `/system` 不是模态框；会话流里没有 token 数与单价（契约层就没有字段）；没有写回行 |
| FR-7.3 | 部分实现 | 只有「标题行（无 ⋯ 菜单）」和「消息流」；issue 原文折叠卡、系统提示词块、verdict/actions JSON、平台写回行、底部输入区全缺；工具「组」层是写死的唯一组头 |
| FR-7.4 | 未实现 | 代码里没有 320 / 300 / 3px 任何一个数；三栏不同宽（224 / 208 / 无左栏），行高 33 不是 28，强调条 2px 不是 3px |
| FR-7.5 | 部分实现 | 重跑 / 暂停全部确实是 `disabled` + `title` 写了接口名；「标记人工」「面板内发消息（含输入区）」连禁用按钮都没有 |

## 逐条

### FR-7.1 三层结构，每层一个入口

- **状态**：与需求冲突
- **证据**：
  - `apps/panel/src/routes.tsx:55-59` — 五个全局页逐个仍在路由表：`{ path: '/', label: '总览', nav: true, group: 'global', element: <OverviewPage /> }`、`'/costs' 成本`、`'/quality' 质量`、`'/audit' 审计`、`'/system' 系统`。文件头 `routes.tsx:34` 自述「`global`：不带仓库（总览/成本/质量/审计/系统）」。
  - `apps/panel/src/layout/nav.ts:22-28` — `GLOBAL_NAV` 五个项全部 `nav: true`，注释写「全局导航（顺序 = 左栏顺序）」。
  - `apps/panel/src/layout/Sidebar.tsx:66-72` — 左栏 `NavGroup label="全局"` 把 `GLOBAL_NAV` 五项全部渲染成 `NavLink`。
  - `apps/panel/src/routes.tsx:59` + `apps/panel/src/routes/system.tsx:66-67` — 「系统」是 `path: '/system'` 的整页（`<PageHeader title="系统" />`），不是模态框；`apps/panel/src/components/ui/dialog.tsx` 的 `Dialog`/`Sheet` 只有两处调用方：`skill-editor-modal.tsx:140`（技能编辑器）与 `DegradedBanner.tsx:101`（降级明细），没有系统模态框。
  - `apps/panel/src/layout/RepoSwitcher.tsx:168` — 只有「全部项目」这一项符合需求（项目上下文 + 「全部项目」）；它挂在左栏顶部（`Sidebar.tsx:63`），不在左上角。
  - `apps/panel/src/layout/nav.ts:48-54` — 项目级导航是五项 `workspace/issues/runs/settings/skills`（工作台 / Issue 中心 / 运行 / 设置 / 技能），不是需求写的 Issue / 设置 / 技能三项。
  - 全仓 `apps/panel/src` 搜 `dock` 只有一处命中：`mocks/fixtures.ts:357` 的 `docker-daemon` 检查项。**没有 dock 组件**。
- **缺口**：需求的两个「不许」与一个「必须有」都不成立——①五个独立页面既在路由表也在导航里（需求：不设）；②没有 dock，项目级导航是左栏纵向五项、比需求多「工作台」「运行」；③「系统」是整页而非 dock 最右打开的模态框。
- **判定依据**：需求原文是「不设总览、成本、质量、审计、系统五个独立页面」，而 `routes.tsx:55-59` 五行正好一一对应这五个页面且 `nav: true`，属于「代码行为与需求相反」，故判与需求冲突而不是未实现（未实现是找不到东西；这里有明确的反向实现）。
- **反证过程**：假设「页面其实已经删了、只是导航里没显示」。逐个查了三个可能藏身的层：①路由数组 `PANEL_ROUTES`（`routes.tsx:53-94`）——五行都在，`group: 'global'`；②导航常量 `GLOBAL_NAV`（`nav.ts:22-28`）——五项都在且 `nav: true`；③渲染处 `Sidebar.tsx:66-72`——无过滤条件，`.map` 直出。`legacy.tsx` 那四条只重定向旧 `/tasks`、`/issues`，与这五页无关。再看 dock：全目录 `dock` 零命中（唯一命中是 docker-daemon），`Sidebar` 是纵向 `<aside>`（`Sidebar.tsx:54` `w-56`），不是横排 dock。最后看「系统」：`routes.tsx:59` 有 `/system` 路由，`system.tsx:66` 有 `h1`，`dialog.tsx` 的调用方只有技能编辑器和降级明细两处 —— 模态框形态不成立。

### FR-7.2 删掉的页面，信息必须有去处

- **状态**：部分实现
- **证据**：
  - 顶栏实况：`apps/panel/src/layout/AppLayout.tsx:77`（`header h-12`）内只有品牌、⌘K、`<GlobalStatus />`（`:119`）、主题切换；`AppLayout.tsx:156-195` 的 `GlobalStatus` 渲染的是**一个** `StatusDot` + 一句状态词（`正常` / `降级运行` / `429 熔断中` / `pi-host 不可达` / `离线`），**没有任何数字**。
  - 四个数字的真实位置在「工作台」页正文：`apps/panel/src/routes/overview.tsx:646` — `队列 ${queueDepth} 待处理 / ${queueActive} 执行中 · 最老等待 …`；`overview.tsx:758` — `p50/p95 …`（悬停 title 里）；失败数走 `failureTop`/待办行，不在顶栏。
  - 降级 chip：`DegradedBanner` 是顶栏**下方**独立 36px 一行的横幅（`AppLayout.tsx:124`、`DegradedBanner.tsx:33`），不是状态带里的 chip；真正的 chip 形态只有 `GlobalStatus` 里 warn/danger 时的 pill（`AppLayout.tsx:174`）。
  - 系统健康：整页 `apps/panel/src/routes/system.tsx:66`（`PageHeader title="系统"`）+ `:94-104` 的 `AsyncSection`，不是模态框第一屏。
  - 单次成本 token 与单价：`apps/panel/src/routes/issue-detail.tsx:280` 取 `readRunCost(turn)`；`components/issues/contract-extras.ts:104-110` 只读 `durationMs` / `costUsd`；而契约 `packages/contract/src/api.ts:931-963` 的 `issueTurnSchema`（`.strict()`）**没有** `durationMs`、`costUsd`、token 数、单价任一字段 → 真实响应里这些字段恒为 `undefined`，`readRunCost` 恒回 `{null, null}`，脚注不渲染。全仓搜「单价 / pricePer / unitPrice」零命中，`formatTokens` 只在成本页图表用（`CostTrend.tsx:46`）。
  - 写回行：`routes/issue-detail.tsx` 全文件无「写回」渲染（仅 `:37` 注释提到判定与写回在别的页可查）。
- **缺口**：①四个数字不在顶栏（在工作台页正文，且「失败」没有独立数字）；②降级态是横幅不是状态带 chip；③系统健康是整页不是模态框第一屏；④会话流里没有 token 数与单价——契约层就没有这两个字段，改面板改不出来；⑤没有写回行，被改回/审计事件仍只在「质量」「审计」两页。
- **判定依据**：`GlobalStatus` 全文（`:156-195`）只有 `tone`+`label` 两个输出，数字为零，这一项直接不成立；`issueTurnSchema` 无字段 + `readRunCost` 恒空说明「token 与单价进会话流」在契约层被堵死，不是「漏画」；`/system` 是独立 `PageHeader` 页，模态框只剩技能编辑器一个用例。主体（状态点/降级入口/健康页/成本页）都在，只是去处与需求指定的位置不同，故判部分实现。
- **反证过程**：假设「数字其实在顶栏，只是我没认出」。把 `AppLayout.tsx` 全文件读完：`header` 子节点依次是 跳转链接、`Sidebar` 切换按钮、品牌 `pi-issue-bot`、`span`「搜索页面 / 仓库…」、`<GlobalStatus />`、`<ThemeToggle />` —— 没有 `formatCount`、没有 `.tabular`（在 `layout/` 目录搜 `formatCount|tabular|数字`，只命中 `DegradedBanner.tsx:86` 的摘要 span）。再假设「单价字段藏在别处」：`formatTokens` 的调用方只有 `CostTrend.tsx:46/83`（成本页图表），`issueTurnSchema` 是 `.strict()`，服务端 `queries/issues.ts:637-738` 的 `toHumanTurn`/`toBotTurn` 逐字段赋值里也没有成本/用量 —— 两头都没有，不是显示层遗漏。最后验证「系统健康是否已在模态框」：`dialog.tsx` 的两个调用方都不含 doctor，`system.tsx` 的 doctor 逐项检查（`:176-220`）在整页里。

### FR-7.3 Issue 页是会话流，不是分区卡片

- **状态**：部分实现
- **证据**（自上而下逐元素）：
  - 标题行：`routes/issue-detail.tsx:100-157` — `PageHeader` 有编号（`:109` `issue#17`）、标题（`:110`）、状态徽章（`:120` `ISSUE_STATE_LABEL`）；但 `actions` 是「复制链接 / 打开 GitHub」两个按钮（`:132-156`），**没有 `⋯` 动作菜单**（全文件无 `DropdownMenu` / `MoreHorizontal` 引用）。
  - issue 原文折叠卡：**不存在**。`routes/issue-detail.tsx` 全文无「原文」，`issue` 只用到 `title/url/state/labels/participants/reactionState`（契约 `api.ts:1070-1090` 的 `issueSummarySchema` 本身也没有正文、作者、评论数）。
  - 系统提示词块：**不存在**于本页（`系统提示词` 只出现在设置页 `components/settings/v21-agent-section.tsx:213`）。
  - 消息流：`issue-detail.tsx:229-233`（`<ol data-testid="issue-detail-turns">`）。
  - 人类在右：`issue-detail.tsx:256-257`（`justify-end` + 气泡 `rounded-br-[4px]`）；`channel` 只渲染成「被 @ / 命令 / 自动」文字（`:59-63`、`:253`），与 `login`、`<time>` 同行（`:251-255`），**没有** `issues.opened · #318 · 时间戳` 这种事件 chip（契约 `issueTurnSchema` 无事件类型字段）。
  - agent 在左、无卡片：`issue-detail.tsx:288`（`<li className="… border-t border-border …">`，无卡片容器）；输出块 `:344-358`。
  - 三层工具：`:290-306` 轮标题（`aria-expanded` 折叠）→ `:317-331` 第二层——这里是**一个写死的组头**「工具调用 · N 次操作」，不是按组数据渲染（`issueToolCallSchema`（`api.ts:908-919`）只有 `name/summary/at/ok`，无 group 字段）→ `:385-395` 第三层单次调用。
  - verdict / actions JSON：**本页不存在**（只在运行详情页 `routes/task-detail.tsx:298-325`）。
  - 平台写回居中成行：**不存在**。
  - 输入区：**不存在**（全仓 `apps/panel/src` 搜 `发送` 零命中；`textarea` 只在设置页表单 `components/settings/form.tsx:271`）。
- **缺口**：缺 ①标题行的 `⋯` 动作菜单；②issue 原文折叠卡（且契约 `issueSummarySchema` 无正文/作者/评论数字段）；③居中可折叠的系统提示词 markdown 原文块；④人类输入的事件元信息 chip（事件类型字段契约里没有）；⑤真正的「组」层（现为写死唯一组头，名义三层）；⑥默认收起的 `verdict`/`actions` JSON；⑦居中成行、失败换红的写回行；⑧底部输入区。会话流骨头（无卡片消息流 + 人类右 agent 左 + 工具可展开）成立。
- **判定依据**：需求列了 5 段结构与 6 个流内元素，代码只实到「标题行（残缺）+ 消息流（部分）」；且 `IssueToolCall` 无分组字段、`IssueTurn` 无事件类型字段，说明②④⑤不是「画漏了」而是数据结构没有；但「不是分区卡片、人类右气泡、agent 左无卡片、工具可折叠」确实成立，故判部分实现而非未实现。
- **反证过程**：先假设「原文卡和系统提示词在别的组件里，只是本页组合」。把 `issue-detail.tsx`（437 行）整读：从 `IssueDetailPage` 到 `splitFences`，渲染树只有 `PageHeader` + `AsyncSection` + `SessionBody`（会话栏 `:197-226` + `<ol>` 消息行），函数只有 `HumanRow`/`BotRow`/`ToolRow`/`MessageText`，没有第三块可插原文卡/提示词的挂点；再在 `apps/panel/src` 全局搜「原文」——命中全是技能/设置页（`repo-skills.tsx`、`skill-editor-modal.tsx`），与 issue 页无关。再假设「三层工具是真的三层」：读 `issue-detail.tsx:317-341`，第二层标题是字面量「工具调用」+ `toolCount`，`toolCalls.map` 直接把每条塞进同一个 `<ul>`（`:332-336`），没有按任何键分组；再查 `issueToolCallSchema`（`api.ts:908-919`）——无 group 字段；服务端 `queries/issues.ts:922-1003` 按 `toolCallId` 合并后原样 `toolCalls: [...toolCalls]`（`:736`）——所以「组」层是形式上的唯一组头，不是数据结构。最后核「人类右侧的事件元信息」：`:251-255` 只有 `login` / `CHANNEL_LABEL` / `<time>`，`CHANNEL_LABEL` 取值是「被 @ / 命令 / 自动」（`:59-63`），没有 `issues.opened` 这种事件名，也没有 `#318`。

### FR-7.4 三个左栏画法一致

- **状态**：未实现
- **证据**：
  - 320 / 300：`apps/panel/src` 全目录搜 `320px`、`300px`、`w-80`、`w-[300px]` 均零命中（`300px` 只在 `overview.tsx:172/461` 的注释里谈空白）。实际宽度：全局左栏 `layout/Sidebar.tsx:54` `w-56`（224px）；设置分区 `routes/repo-settings.tsx:203` `lg:grid-cols-[13rem_minmax(0,1fr)]`（208px）；技能列表 `routes/repo-skills.tsx:286` `md:grid-cols-[minmax(0,12rem)_…]`（192px 首列、不是左栏）；Issue 中心甚至没有左栏——`routes/issues.tsx:573` `xl:grid-cols-[minmax(0,1fr)_22rem]`，条目是 `components/issues/issue-table.tsx:64` 的 `<Table className="min-w-[56rem]">`，22rem（352px）那块是**右**侧概要栏。
  - 行高 28：`index.css:92` `--row-height: 2.0625rem; /* 33px：表格 / 列表行 */`，`components/ui/table.tsx:76` 单元格 `h-[var(--row-height)]` → 33px。28px 只作为控件高度存在（`index.css:89` `--control-sm: 1.75rem`、`Sidebar.tsx:148` 的 `h-7`）。
  - 强调条 3px：`Sidebar.tsx:152` `before:… before:w-0.5`（2px）；`components/settings/settings-chrome.tsx:219-220` `lg:border-l-2`（2px）；`components/issues/issue-table.tsx:150` `border-l-2`（2px）。全目录搜 `3px` 只命中阴影/圆角（`index.css:85`、`:378`）。
  - 30px 小标 + 计数：`index.css:90` 的 30px 是 `--control-md`（控件高度），不是表头；三处列表头分别是 `micro-label`（`index.css:394`，约 9.5px）、`TableHead`（`table.tsx:67`，`h-7` + `text-2xs`）、`Section` 的 `h2`（15px）。计数只在 `Section` 的 `count` prop（`components/Section.tsx:11-12`）上出现，三处左栏都没用。
  - 选中态：`bg-brand-soft` 三处都有（`Sidebar.tsx:152`、`settings-chrome.tsx:219`、`table.tsx:55`），但左侧条分别是 2px / 2px / 2px，且形状不同（伪元素圆条 / 边框 / 表格首列边框）。
- **缺口**：①没有 320px（窄屏 300px）任何一处；②三处宽度 224 / 208 / 无左栏（Issue 队列根本不是左栏，是整宽表格），既不同宽也不同构；③行高 33px ≠ 28px；④强调条 2px ≠ 3px；⑤没有「30px 小标 + 计数」同款头部。
- **判定依据**：需求点名的四个量（320/300、28、3px、30px 小标 + 计数）在 `apps/panel/src` 里逐个搜过，全部不存在或不匹配；三条左栏中两条宽度互不相同、第三条（Issue 队列）根本不是左栏。需求要求的形态整体缺席，判未实现；其中 33 vs 28、2px vs 3px 属于数值正面相反。
- **反证过程**：假设「用了设计令牌而不是字面值，所以搜数字搜不到」。改为搜令牌与布局类：`--row-height`（`index.css:92`）= 33px，被 `table.tsx:76` 消费；`--control-sm` = 28px，被按钮/设置控件消费（`button.tsx:47`），不是列表行高。假设「宽度用栅格而不是 w-*」：设置页 `repo-settings.tsx:203` 是 `13rem`（208px），技能页 `repo-skills.tsx:286` 是 `12rem`（192px），全局栏 `Sidebar.tsx:54` 是 `w-56`（224px）——三个数，三个值，都不等于 320/300。假设「Issue 队列在别处是左栏」：`routes/issues.tsx:565-603` 是表格 + 右侧 `aside`（`:586` `border-l pl-3`），左栏不存在。假设「3px 由 0.5 单位换算」：Tailwind 的 `w-0.5` = 2px、`border-l-2` = 2px，`3px` 全目录只出现在阴影 spread 与 border-radius。

### FR-7.5 缺写接口的动作不许假装成功

- **状态**：部分实现
- **证据**：
  - 重跑：`routes/overview.tsx:199` `const RERUN_DISABLED = '缺少写接口：POST /api/tasks/:id/rerun 尚未实现，面板不会假装发出请求'`，消费于 `:234`（待办行动作）与 `:556-566` —— 渲染的是 `<Button variant="ghost" size="sm" disabled title={action.disabledReason}>`，**真 `disabled` 属性**（`components/ui/button.tsx:80` `disabled={disabled || loading}`）。
  - 暂停全部：`routes/overview.tsx:867-875` `<Button variant="secondary" size="sm" disabled title="缺少写接口：POST /api/flags（暂停全部）尚未实现">`。
  - 标记人工：全目录搜「标记人工」零命中；「人工」只命中两处无关文案（`v21-agent-section.tsx:127` 风险说明、`repo-skills.test.tsx:165`）。**没有按钮、也没有禁用按钮**。
  - 面板内发消息：全目录搜「发送」零命中；`routes/issue-detail.tsx` 无输入区（无 `<textarea>`，`textarea` 只在 `settings/form.tsx:271`）。**没有输入区、也没有禁用的发送按钮**。
- **缺口**：①「标记人工」完全没有按钮（需求要求画成禁用按钮 + title 写接口）；②「面板内发消息」连输入区形态都没有，自然也没有禁用态发送按钮（需求：输入区只呈现形态 + 发送禁用）；③已实现的两个禁用按钮都挂在「工作台」页（`overview.tsx`），而该页按 FR-7.1 属于应删除的页面，需求语境里它们应在 Issue 页。
- **判定依据**：两个动作（重跑、暂停全部）的 `disabled` 属性与「缺哪个接口」的 title 均可逐字核对，这部分成立；另两个动作连禁用形态都不存在，属于「需求明写的子条件缺失」，故部分实现。
- **反证过程**：假设「禁用只是样式变灰」。`components/ui/button.tsx:77-83` 显式传 `disabled` 到原生 `<button>`，`:28` 的 `disabled:pointer-events-none disabled:opacity-50` 是附加样式而非替代——两处禁用按钮在 `overview.test.tsx:357` 也被断言过，可确认真禁用。假设「标记人工在别处叫别的名字」：搜「人工」「标记」「转人工」「assignee」——`标记` 三处命中都是视觉/脏标记注释（`field.tsx:24`、`Sidebar.tsx:22`、`repo-settings.tsx:92`），无动作按钮。假设「发送按钮藏在 issue-detail 某个子组件」：`issue-detail.tsx` 全文读完后渲染树只有 `PageHeader`/`AsyncSection`/`SessionBody`，且全目录「发送」零命中——形态不存在。

## 本节整体结论

本节 5 条**无一可判「已实现」**。FR-7.1 是与需求正面冲突：需求明令删除的五个独立页面（`routes.tsx:55-59`）全部在路由表、在导航、可直达，dock 与系统模态框都不存在，面板仍是「左栏两组、全局五项」的多仓库工作台形态。FR-7.2/7.3/7.5 是部分实现，且缺的都不是画法细节而是数据：`IssueTurn`/`IssueToolCall`/`IssueSummary` 三个契约没有 token 与单价、没有工具分组、没有事件类型、没有 issue 正文/作者/评论数、没有 verdict/actions，面板侧无论怎么改都补不出 FR-7.2 与 FR-7.3 的点名元素。FR-7.4 是纯数值层面的全面不一致（224/208/无左栏 vs 320；33 vs 28；2px vs 3px）。此外本节所需的改动会被现有测试当成「破坏」：`test/routes.test.tsx:57-95` 把「全局 5 条 + 仓库 5 条」写成冻结断言，`routes/__tests__/issue-detail.test.tsx:182-201` 把「没有成本块（`issue-detail-cost`）」写成必须为 `null` 的断言——后者与 FR-7.2「单次成本进会话流」直接对立。

## 核查边界

- 是否执行了命令：未跑 `pnpm` 任何测试/类型检查；只做了只读检索与读取（`git log`/`git status`、`Select-String` 关键词检索、逐文件 `Read`）。所有结论为纯静态核查，未启动面板、未在浏览器里看实际渲染。
- 未覆盖的条目及原因：无（本条范围 5 条全部覆盖）。设计稿 `design-refactor/e-unified.html`、`docs/panel-ui-versions.html` 未作为判据（按任务口径，设计稿不算实现），也未打开。
- 发现的额外问题（不属本节范围，仅记录）：
  1. `routes/__tests__/issue-detail.test.tsx:193` 断言 `issue-detail-cost` 必须为 `null`，与 FR-7.2「单次成本出现在会话流」正面冲突；按需求改需求先删/改这条断言，否则看起来像「破坏测试」。
  2. `test/routes.test.tsx:57-95` 把「全局 5 条 + 当前仓库 5 条」冻结成期望值（`toEqual` 全表），FR-7.1 的任何落地都必须同步改这张表，否则整组失败。
  3. `apps/panel/src/mocks/handlers/issues.ts:141-180` 的会话 fixture 缺 `attempts`/`truncated`（契约 `issueTurnSchema` 必填），MSW 层能跑通是因为面板不校验响应；真实接口缺字段会被 `issueSessionResponseSchema` 拦下——测试与契约不同步。
  4. `mocks/fixtures.ts:42/70` 已有 `p95Ms`，但 `overview.tsx:758` 只把它塞进 `title`，顶栏若要「p95 数字」需要新的取数落点（`/api/overview` 的 `queue` 无 p95，p95 在 `today`）。
