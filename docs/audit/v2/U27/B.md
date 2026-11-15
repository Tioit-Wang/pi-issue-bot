# U27 10 验收标准 AC-18 ~ AC-33 · B

> 核查范围：docs/requirements.html 行 1866-1881
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| AC-18 | 已实现 | 闸门 `require_role` → `matchCommentRole()` 有判定路径与用例 |
| AC-19 | 部分实现 | 第二次不再处理成立，但 `decision_reason` 里没有「重复内容」——`contentDuplicate` 从未被传入 |
| AC-20 | 与需求冲突 | 内容级 fingerprint 永久占键，失败后原样重发必被 `ON CONFLICT DO NOTHING` 吞掉 |
| AC-21 | 已实现 | 编号/状态/标题、排除 PR、超限补「共 N 条仅列最近 M 条」 |
| AC-22 | 已实现 | `needsRepoIssues(template)` 为假时连 provider 都不取 |
| AC-23 | 部分实现 | 会话行复用 ✓；「沙箱回收/重建」只是计划字段，装配层无容器动作 |
| AC-24 | 未实现 | 压缩引擎零生产调用方，仅识别 host 的 compaction 事件 |
| AC-25 | 部分实现 | 记录能落库，但 `listCompactions()` 零调用、无查询/面板读取面 |
| AC-26 | 与需求冲突 | `/costs` `/quality` `/audit` 仍在路由表且 `nav:true` |
| AC-27 | 未实现 | 会话页只有会话头 + 轮次列表，无原文卡、无系统提示词块 |
| AC-28 | 未实现 | 原文卡不存在，无从谈「不同时出现在两处」 |
| AC-29 | 未实现 | 系统提示词只在设置页可编辑，会话页无任何展示 |
| AC-30 | 部分实现 | 轮→组→单次调用与失败标记 ✓；`verdict`/`actions` 是常显 Section，未默认收起 |
| AC-31 | 未实现 | 设置页左栏 13rem、技能页 12rem 表格列，技能页没有左栏与选中态 |
| AC-32 | 未实现 | 全局设置无供应商区块；契约里没有模型角色与单价实体 |
| AC-33 | 部分实现 | 「重跑」禁用 + title 含接口名 ✓；「标记人工」「面板内发送」两个动作在面板上不存在 |

## 逐条

### AC-18
- **状态**：已实现
- **证据**：`apps/server/src/trigger/decide.ts:188` — `if (gates.require_role)` 调 `matchCommentRole({roles, allowRoles, authorAssociation, authorLogin})`，`allowed=false` 返回 `skip(event,'role-denied')`；判定本体在 `apps/server/src/trigger/roles.ts:99`（association 按 `any_of`、members 按 login，均 normalize 后比对）
- **判定依据**：闸门开关读的是 `settings-v21.ts:110` 的 `require_role`，`author_association`/`comment.user.login` 由 `webhook-v21.ts:150` 取自真实载荷；`apps/server/test/trigger-decide.test.ts:323` 断言 reason 为 `role-denied`，非只断言 200
- **反证过程**：唯一可攻击点是「留空 = 放行」——`roles.ts:70` 在 `allowRoles.length === 0` 时直接 `allowed:true`。面板把这条写成既定语义（`v21-events-section.tsx:455`「留空 = 不限定角色」），需求 AC-18 只约束「清单外的人被拒」，不约束空配置，故此反例不成立。另一条：若 `comment` 缺失则 `authorLogin=null` → `roleMatches` 返回 false → 拒；只在 `issue_comment.created` 分支调用，方向仍是拒而非放行。

### AC-19
- **状态**：部分实现
- **证据**：`apps/server/src/http/webhook-v21.ts:1029` — `insertMessage()` 命中 `agent_messages` 唯一键后 `saved.inserted === false`，`:1043` 返回 200 `action:'duplicate'`，`:1042` 只写日志「消息幂等命中：不重复投递」
- **缺口**：缺「后台可查到『因重复内容跳过』」。`decide.ts:246` 的 `content-duplicate` 分支需要 `input.contentDuplicate===true`，但全仓只在 `webhook-v21.ts:117/154` 透传字段，`webhook.ts` 里 **0 处**传入（`contentDuplicate` 在 `apps/server/src/http/webhook.ts` 无匹配），因此 `webhook_deliveries.decision_reason` 永远写不到 `content-duplicate`；重复命中只落在 HTTP 响应 body 与进程日志里，`queries/` 也没有读 `decision_reason` 的路径
- **判定依据**：「不触发」有代码路径、「后台可查」需要写库 + 读取面，两者缺一即部分实现
- **反证过程**：假设这条成立，则 `webhook_deliveries` 里应有 `decision_reason='content-duplicate'` 的行。实际两条写入口都写不到：`v21DecisionRowOf()`（`webhook-v21.ts:188`）取的是外层 `decideEvent` 的结果（`:1195` 调用时还不知道消息重复），而 duplicate 分支在 `handleV21Webhook` 内部 return，不回调写库。

### AC-20
- **状态**：与需求冲突
- **证据**：`apps/server/src/agent/fingerprint.ts:59` — `commentFingerprint()` = `sha256(repo, issueNumber, 'comment', 归一化正文)`，正文不含轮次/时间/状态；主键写入在 `apps/server/src/agent/store.ts:95`，`:97` 是 `ON CONFLICT ("repo","issue_number","fingerprint") DO NOTHING`
- **缺口**：`agent_messages` 行一旦存在就永久占键，失败（`dispatcher.ts:139` 置 `failed`）也不清行——全仓 `DELETE FROM "agent_messages"` 零命中；原样重发落到 `webhook-v21.ts:1038` 的 `!saved.inserted`，直接 200 duplicate，不会重新入队
- **判定依据**：需求要求「上一轮失败后原样重发能正常触发」，代码行为相反，故为冲突而非缺失
- **反证过程**：先找「失败时删键或换键」的旁路：`store.ts` 只有 `markStatus`（`:124`），`claimOldest` 只捞 `status='queued'`（`:113`）——`failed` 行既不会回到 `queued`，也不会被新内容以外的键重新插入。**联动结论：AC-19 成立的前提正是这个永久内容键；同一套键下 AC-20 必然不成立。要同时满足两条，只能在失败路径上删除/迁移 fingerprint 行，或把「失败轮次」纳入键——这两处代码都不存在。**

### AC-21
- **状态**：已实现
- **证据**：`apps/server/src/prompt/repo-issues.ts:83` — `renderLine` 输出 `#${number} [${state}] ${title}`（只有编号/状态/标题）；`:121` `.filter((entry) => !entry.isPullRequest)`；`:127` 超限时 `lines.push('（共 N 条，仅列最近 200 条）')`
- **判定依据**：PR 过滤的输入字段来自真实载荷 `webhook-v21.ts:578` `row.pull_request !== undefined`，不是靠标题猜；上限常量 `REPO_ISSUES_MAX_ITEMS=200`（`:38`）与说明行同源
- **反证过程**：攻击点一「PR 靠名字过滤」——不成立，读的是 `pull_request` 字段。攻击点二「说明行的 N 不准」——`total` 取 `Link` 头解析（`webhook-v21.ts:573`），是 GitHub 全量计数，`>200` 才补说明，未超限不补（正确：未超限补了会让人以为还有）。攻击点三「`total` 未减 PR 数」：是唯一瑕疵，N 含 PR（`repo-issues.ts:112` 直接取 `result.total`），但 AC-21 只要求「有共 N 条仅列最近 M 条」的说明，未要求 N 排除 PR，故不推翻。

### AC-22
- **状态**：已实现
- **证据**：`apps/server/src/http/webhook-v21.ts:465` — `const provider = needsRepoIssues(template) ? repoIssuesProviderOf(input.deps) : undefined;`；`apps/server/src/prompt/render.ts:198` — `resolved = needsRepoIssues(template) ? await source() : undefined;`
- **判定依据**：两道闸都在「取/调」之前，模板不含占位符时 `provider` 为 undefined，`renderTemplateAsync` 也不会 await，`listIssues` 零请求；`needsRepoIssues` 是纯字符串包含判断（`render.ts:94`）
- **反证过程**：找「无条件预取」的旁路：`app/compose.ts:835` 只 `createRepoIssuesProvider(...)`（构造 provider，不发请求），`repo-issues.ts:106` 的 `load()` 在 `render()` 内才执行——没有启动期或 webhook 入口的预热调用。再查 `renderTemplateAsync` 的调用方只有 `renderV21AgentText`（`webhook-v21.ts:346`），单一入口，无法绕开判据。

### AC-23
- **状态**：部分实现
- **证据**：`apps/server/src/agent/session-state.ts:123` — `issues.closed` 且 `issueState==='closed'` 返回 `recycle-sandbox` + `keepSession:true`；`:134` `issues.opened` 返回 `reuse` + `rebuildSandbox:true`
- **缺口**：缺「沙箱被回收 / 自动重建」。`webhook-v21.ts:846` 调 `applyV21SessionOnEvent` 时不传 `sandboxId`，`compose.ts:386-388` 明写本仓库容器是 `runTask` 每轮创建、结束即销毁，没有常驻 per-session 沙箱，`rebuildSandbox` 只留在返回的计划里；`applyV21SessionTransition` 的 `hooks.createSandbox` 在 `compose.ts:1198` 调用点未注入
- **判定依据**：「复用原会话、历史仍在」有 `turn-driver.ts:354` 的 `session/attach` 支撑；「沙箱回收/重建」无执行路径，故部分实现
- **反证过程**：假设沙箱部分真做了，则应能找到「关闭时销毁容器」的调用。`agent/session-state.ts:125` 只是纯函数判定，`compose.ts:287` 的 `recycle` SQL 只把 `sandbox_id` 置 NULL（写库，不动作容器）。`turn-driver.ts:217` 明说 attach 分支不传 systemPrompt，与沙箱无关。

### AC-24
- **状态**：未实现
- **证据**：`apps/server/src/worker/run-task.ts:199` — `readonly compactor?: unknown`，紧接注释「本轮**只暴露、不自动调用**：RACP 客户端没有 session/history 与 compact 操作」；`:934` 同口径注释；`apps/server/src/app/compose.ts:881` 唯一注入点是 `compactor: createV21Compactor`
- **缺口**：压缩引擎（`compact/engine.ts:436` `compactSession`、`:698` `createCompactor`）在生产链路上零调用方，唯一落地的是「识别 `itemType==='compaction'` 写一行记录」（`run-task.ts:933-952`），压缩本身由 host 决定
- **判定依据**：需求要「压缩两次后模型仍能复述第一轮目标」，前提是压缩真的发生且摘要被注入；有函数无调用方 = 死代码，按证据口径第 2 条判未实现
- **反证过程**：搜三类调用点：`createCompactor(` 只有 `worker-deps.ts:1063`（装配层导出的柯里化入口）；`compactSession(` 只在 engine 自身与测试；`hooks.compactor` / `deps.v21.compactor` 在 `run-task.ts` 内只出现在类型声明（`:202`），无 `.compactor(` 调用。故「零生产调用点」结论成立，AC-24 与 AC-25 的「压缩发生」前提都不具备。

### AC-25
- **状态**：部分实现
- **证据**：`apps/server/src/compact/store.ts:33` — `INSERT INTO agent_compactions (... before_tokens, after_tokens, summary_chars, fallback, created_at)`；`:127` `listCompactions()` 定义
- **缺口**：缺「后台能看到的压缩记录」。`listCompactions` 全仓**零调用方**（仅定义处命中），`apps/server/src/queries/` 无 `agent_compactions` 查询，契约里 `issueSessionResponseSchema`（`packages/contract/src/api.ts:1092`）只有 `issue` + `turns`，面板无压缩区块（`apps/panel/src` 搜 `compactions` 0 命中）。「原始对话一条不少」成立：`compact/engine.ts:8` 追加不改写，且无任何 DELETE
- **判定依据**：写入存在 ≠ 后台可见；读取面缺失，按证据口径第 2 条判部分实现
- **反证过程**：先查「记录会不会写进去」——`run-task.ts:946` 走 `deps.v21.compactionStore`，装配在 `compose.ts:1423`，这条链通。但再查「谁读」：`queries/*.ts` 无该表，面板无该字段，等于只写不读。另有一条更前置的风险：压缩本身零调用（见 AC-24），若 host 不主动报 compaction 事件，这张表可能长期为空。

### AC-26
- **状态**：与需求冲突
- **证据**：`apps/panel/src/routes.tsx:56` — `{ path: '/costs', label: '成本', nav: true, ... }`，`:57` `/quality`、`:58` `/audit` 同样 `nav: true`；`apps/panel/src/layout/nav.ts:24-26` 把三者列进 `GLOBAL_NAV`
- **缺口**：需求要求「总览、成本、质量、审计、系统五个页面在路由表里不存在」，代码里四个都还在路由表且出现在全局导航；项目级 `REPO_NAV`（`nav.ts:53-59`）是五项（工作台/Issue 中心/运行/设置/技能），不是「只有 Issue/设置/技能」
- **判定依据**：需求明写「路由表里不存在」而不是「导航隐藏」，`PANEL_ROUTES` 是唯一路由来源（`routes.tsx:177` 由它渲染 `<Route>`），故为反向冲突
- **反证过程**：先排除「只是隐藏」：`routes.tsx:56-58` 的 `nav:false` 才是不进导航，这三条是 `nav:true`，且 `/`（总览）也在 `:55` 且 `nav:true`。再查是否有重定向兜底把它们跳走：`routes/legacy.tsx` 只处理 `/tasks*` 与 `/issues*`（`routes.tsx:96-110`），不含 `/costs` `/quality` `/audit`——即它们是真页面。

### AC-27
- **状态**：未实现
- **证据**：`apps/panel/src/routes/issue-detail.tsx:194` — `SessionBody` 结构只有会话头（`:197`）+ `<ol>` 轮次列表（`:229`）
- **缺口**：首屏缺少「收起的原文卡」与「收起的系统提示词」两块，实际顺序是 页面标题行 → 会话元信息条 → 轮次列表，第 3、4 个位置不存在
- **判定依据**：需求逐项列出四个位置，代码只有第 1 与第 4 项，主体结构缺一半
- **反证过程**：搜「原文」「系统提示词」在 `apps/panel/src` 的命中：只有 `repo-settings` 系列（编辑态）与技能编辑器，issue-detail 内没有 `<details>`/折叠容器（`:189-236` 全文无 `details`）。`issueSessionResponseSchema` 也不含 issue 原文或 systemPrompt 字段（`packages/contract/src/api.ts:1092-1096`），后端根本没给这两块数据——不是「前端没画」，而是契约层缺失。

### AC-28
- **状态**：未实现
- **证据**：`apps/panel/src/routes/issue-detail.tsx:189` — `SessionBody({data})` 只消费 `issue` 与 `turns`，无原文卡组件；`issueSummarySchema`（`packages/contract/src/api.ts:1070`）无正文/作者/标签合并的原文对象
- **缺口**：原文卡整体不存在，因此「含作者、时间、标签、正文」与「同一条评论不同时出现在两处」都无从判定
- **判定依据**：两个子条件都依赖原文卡这个载体，载体缺失即未实现
- **反证过程**：找「另一种原文卡」的可能：`queries/issues.ts:645` 确实把评论正文塞进 `turn.text`，`issue-detail.tsx:258` 用 `MessageText` 渲染——但那是会话流里的气泡，不是独立原文卡。再查是否有独立组件被别处引用：`apps/panel/src/components` 下无 issue 原文卡组件（目录清单里只有 `issues/issue-table.tsx` 等列表件）。

### AC-29
- **状态**：未实现
- **证据**：`apps/panel/src/components/settings/v21-agent-section.tsx:213` — `<Section first title="系统提示词">`，`:365` 是唯一的 `label="项目级系统提示词"` 输入框，位于**设置页**
- **缺口**：会话页（`issue-detail.tsx`）没有任何系统提示词展示块，「展开看到完整 markdown 原文」无从发生
- **判定依据**：需求位置是「打开任一 issue 的会话页展开系统提示词」，代码只在设置页可编辑，位置不对即未实现
- **反证过程**：查后端有没有把渲染后的 system prompt 给面板：`queries/issues.ts` 无 `system_prompt` 字段，`issueSessionResponseSchema` 无该字段——后端未提供，前端即便想画也无数据。

### AC-30
- **状态**：部分实现
- **证据**：`apps/panel/src/routes/issue-detail.tsx:291` — 轮级按钮 `aria-expanded={toolsOpen}`；`:319` 组行「工具调用 · N 次操作」；`:333` 逐条 `<ToolRow>`；`:388` `<StatusDot tone={call.ok ? 'success' : 'danger'} />`，`:325-329` 另给「N 次失败」红字
- **缺口**：缺「`verdict`/`actions` 默认收起」。`apps/panel/src/routes/task-detail.tsx:288` 把 verdict 与 actions 放在常开的 `<Section>` grid 里（`:290` `verdict`、`:339` `actions`），没有 `<details>`/折叠态
- **判定依据**：三层展开与失败标记两个子条件成立（失败既有色点也有文字，不是只靠颜色），第三个子条件不成立
- **反证过程**：先确认「轮→组→单次」不是两层：`:318` 的组容器在 `toolsOpen` 为真时出现，`:333` 在其内逐条渲染，三层俱全；失败标记单靠色点会不达标，但 `:328` 同时给了 `N 次失败` 文本，故此项过关。再查 verdict/actions 是否在别处有折叠版本：`task-detail.tsx` 内无 `details`/`summary` 元素，`:198-217` 的 `decision` 只用于事件流徽章。

### AC-31
- **状态**：未实现
- **证据**：`apps/panel/src/routes/repo-settings.tsx:203` — `lg:grid-cols-[13rem_minmax(0,1fr)]`；`apps/panel/src/routes/repo-skills.tsx:271` — `md:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]`（技能页是列表行三列，不是左栏 nav）；`apps/panel/src/routes/issues.tsx:573` — `xl:grid-cols-[minmax(0,1fr)_22rem]`
- **缺口**：三处宽度分别是 13rem / 12rem / 22rem 且语义各不相同（设置页是真左栏 nav，Issue 是右侧 aside，技能页没有左栏，选中态只在 `settings-chrome.tsx:192-215` 存在）
- **判定依据**：需求要求「三个左栏宽度一致、选中态一致」，代码里只有一处是左栏 nav，第三处无左栏可谈，故不成立
- **反证过程**：先找是否有统一左栏容器被三处复用：`components/Section.tsx` 是通用分区，不含列宽；`layout/Sidebar.tsx:54` 的 `w-56` 是全局侧栏，不属这三处。再查技能页是否存在 nav 语义：`repo-skills.tsx` 内无 `<nav>`/`aria-current`，选中态是打开编辑弹窗（`:279` `aria-expanded`），与设置页的「选中分区」不是同一语义。

### AC-32
- **状态**：未实现
- **证据**：`packages/contract/src/api.ts:646` — `systemResponseSchema` 只有 `version/protocol/host/doctor/queue/retention/flags/repos`，无 provider / baseUrl / key 掩码 / 可用 model 字段；`apps/panel/src/routes/system.tsx:137` 起的四个 Section 是「版本与协议 / doctor 逐项 / 队列与保留策略 / 仓库」
- **缺口**：①全局设置无供应商区块（base URL、key 掩码、连通性、可用 model 全缺）②「四档模型角色各显示输入/输出单价」没有实体：`repo-config.ts:220` 只有一个 `model: z.string()`，`queries/costs.ts:8` 明写「价格表还没落库（没有单价列）」③项目页模型是自由文本框（`v21-agent-section.tsx:264` `label="默认模型（provider/model，可留空）"`），没有任何「继承全局」表达
- **判定依据**：三个子条件全部缺失，且缺口在契约层（后端不提供数据），不是视觉遗漏
- **反证过程**：先查是否藏在 doctor 检查里：`doctorCheckSchema` 输出的是 `id/status/detail`，`modelBaseUrl` 只进 host 子进程环境变量（`app/model-env.ts:44`），不回读给面板——「存在环境变量 ≠ 面板可见」。再查单价是否在成本页：`queries/costs.ts:264` 的 `pricingCoverage` 用「有 usage 记账的 run 占比」近似单价命中率，注释自认价格表未落库，四档角色与单价实体根本不存在。

### AC-33
- **状态**：部分实现
- **证据**：`apps/panel/src/routes/overview.tsx:199` — `RERUN_DISABLED = '缺少写接口：POST /api/tasks/:id/rerun 尚未实现…'`，`:234` `{ label: '重跑', disabledReason: RERUN_DISABLED }`，`:544` `disabled` + `:562` `title={action.disabledReason}`
- **缺口**：缺「标记人工」与「面板内发送」两个动作的禁用态——这两个动作在面板上**根本不存在**（`apps/panel/src` 搜「标记人工」「面板内发送」零命中），没有按钮就没有「禁用 + title 写明接口名」
- **判定依据**：「缺接口的动作都是禁用态且 title 写明接口名」对「重跑」成立（`POST /api/tasks/:id/rerun` 与 `:871` 的 `POST /api/flags` 都点名了接口）；两个需求点名的动作缺失，故部分实现
- **反证过程**：先查是否有「已完成」假提示（第三个子条件）：`apps/panel/src` 搜「已完成」0 命中，此项通过，不能据此推翻。再查「重跑」是否只是视觉禁用而按钮仍可点：`:544` 是原生 `disabled` 属性，且 `:546` 的 testid 区分 `rerun`/`disabled`，`routes/__tests__/overview.test.tsx:364` 断言 title 含 `POST /api/flags`，说明至少有一条禁用态是被用例钉住的。

## 本节整体结论
本节 16 条里只有 AC-18、AC-21、AC-22 三条可判「已实现」，且都集中在后端纯判定/渲染层。面板侧的六条（AC-26~29、AC-31、AC-32）全部不成立，其中 AC-26 与需求明确相反（旧路由仍在路由表并被导航）；AC-27~29 缺的不是样式而是**契约层不给数据**（`issueSessionResponseSchema` 无原文/系统提示词字段）。压缩两条（AC-24/25）根因同一个：压缩引擎零生产调用方，因此既不能验证「压缩两次仍记得目标」，也只能「写记录却无人读取」。AC-19 与 AC-20 是本节最硬的内部矛盾：内容级指纹永久占键使 AC-19 成立的同时必然否定 AC-20。**本节整体不可判为「已实现」**。

## 核查边界
- 是否执行了命令：未执行测试或构建；仅用 `Get-Content` / `Select-String` / `Grep` 做静态取证（HEAD `fbfa0298`，工作区较 `_baseline.txt` 有未提交改动，本报告读的是当前工作区内容）
- 未覆盖的条目及原因：AC-23 的「沙箱真的回收/重建」、AC-30 的「失败标记在真浏览器里可见」需要 Docker / 真 host 才能确认；本报告只按代码路径判定，未起容器验证
- 发现的额外问题（不属本节范围但值得记录）：
  1. `webhook.ts` 从未传 `contentDuplicate`，`decide.ts:246` 的 `content-duplicate` 分支在生产上是死分支（影响 AC-19）。
  2. `status='failed'` 的 `agent_messages` 行既不会被 `claimOldest`（`store.ts:113` 只捞 `queued`）重新领取，也没有任何清理/重试入口——失败消息实际需要人工改库（这是 AC-20 冲突的直接后果）。
  3. `listCompactions()`（`compact/store.ts:127`）与 `latestCompactionGeneration()`（`:117`）均为零调用方，属未接线存储层。
  4. `repo-issues.ts:112` 的 `total` 含 PR 数，超限说明里的 N 比实际 issue 数偏大。
