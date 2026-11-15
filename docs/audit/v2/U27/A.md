# U27 10 验收标准 AC-18 ~ AC-33 · A

> 核查范围：docs/requirements.html 行 1866-1881
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览

| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| AC-18 | 部分实现 | 「限定角色」开启但 `allow_roles` 留空时放行所有作者（`roles.ts:70`），不在角色清单内的人照样触发 |
| AC-19 | 部分实现 | 第二次确实不触发，但没有「因重复内容跳过」的落库记录：`content-duplicate` 无任何生产写入方，仅一条 `logger.info` |
| AC-20 | 与需求冲突 | 失败消息行保留同 fingerprint，原样重发命中 `ON CONFLICT DO NOTHING` → 直接判 `duplicate`，不再投递 |
| AC-21 | 已实现 | 编号/状态/标题、滤 PR、200 条上限与「共 N 条，仅列最近 200 条」说明都在同一处 |
| AC-22 | 已实现 | 模板没写占位符时连 provider 都不取，渲染器也不会 await，`listIssues` 零请求 |
| AC-23 | 已实现 | 关闭只置 `idle` + 清 `sandbox_id`，会话行与 `session_id` 保留；重开走 attach + 本轮重建沙箱 |
| AC-24 | 无法判定 | 摘要六段（含目标/约束）与增量逻辑在，但压缩引擎无生产调用方，且「模型仍能复述」需真模型 |
| AC-25 | 部分实现 | 记录会写（`agent_compactions` + `compact.recorded` 事件），但无专用读取面；后台只能看运行详情里的原始 JSON |
| AC-26 | 与需求冲突 | 全局导航有 5 项（总览/成本/质量/审计/系统），仓库导航有 5 项且五个全局页面都在路由表里 |
| AC-27 | 未实现 | Issue 详情首屏没有「收起的原文卡」与「收起的系统提示词」 |
| AC-28 | 未实现 | 原文卡不存在，作者/时间/标签/正文无从展开 |
| AC-29 | 未实现 | issue 页没有任何系统提示词展示位，更没有完整 markdown 原文 |
| AC-30 | 部分实现 | 轮→组→单次调用与失败标记有；`verdict`/`actions` 在运行详情里是直接铺开的，不折叠 |
| AC-31 | 未实现 | 三个「左栏」都不存在（Issue 用工具条筛选、设置分区无固定宽、技能是平铺列表），无双列宽度/选中态口径 |
| AC-32 | 未实现 | 全局设置页无供应商 base URL / key 掩码 / 连通性 / 可用 model，无四档角色单价；项目页是「默认模型」文本框而非「继承全局」 |
| AC-33 | 部分实现 | 重跑与「暂停全部」是禁用态且 `title` 写明缺接口；「标记人工」「面板内发送」在界面上根本没有控件 |

## 逐条

### AC-18

- **状态**：部分实现
- **证据**：`apps/server/src/trigger/decide.ts:188` — `if (gates.require_role)` 时取 `resolveCommentConfig(input.settings).roles` 与 `gates.allow_roles` 交 `matchCommentRole()`，`!allowed` 即 `skip(event,'role-denied')`（`decide.ts:196-198`）；`apps/server/src/trigger/roles.ts:41-60` 按 `author_association` 或成员 login 归一化比对；`apps/server/src/http/webhook-v21.ts:145-152` 把 `comment.author_association` 与 `comment.user.login` 填进判定输入；面板开关见 `apps/panel/src/components/settings/v21-events-section.tsx:435-439`。
- **缺口**：`apps/server/src/trigger/roles.ts:70` — `if (input.allowRoles.length === 0) return { allowed: true }`。当「是否限定角色」开启但 `allow_roles` 还没选任何角色（契约默认就是空数组，`packages/contract/src/settings-v21.ts:112`，且 `require_role=true` 时并不强制非空）时，不在角色清单内的作者也会触发，与 AC-18 的子条件相反；面板文案把这种配置解释为「留空 = 不限定角色」（`v21-events-section.tsx:454-455`），即按面板操作就会踩到。
- **判定依据**：常规路径（`allow_roles` 非空）确实拦住了非授权作者并有具体断言用例；但需求没有为「空 = 放行」开例外，故按「主体在 + 一个子条件缺失」判部分实现。

### AC-19

- **状态**：部分实现
- **证据**：`apps/server/src/http/webhook-v21.ts:1023-1027` 用 `v21MessageFingerprint()`（评论走 `commentFingerprint`，`apps/server/src/agent/fingerprint.ts:59-64` = `sha256(repo, issue, 'comment', 归一化正文)`）；`apps/server/src/agent/store.ts:95-98` 是 `INSERT ... ON CONFLICT ("repo","issue_number","fingerprint") DO NOTHING`；`webhook-v21.ts:1038-1044` 命中即返回 `{status:200, action:'duplicate', duplicate:true}`，不建任务、不调模型。
- **缺口**：没有任何「因重复内容跳过」的留痕。`SkippedReason` 里的 `content-duplicate`（`apps/server/src/trigger/decide.ts:40,246-248`）依赖 `input.contentDuplicate`，而全仓没有任何调用方把它置 true（只有 `webhook-v21.ts:117,154,167` 的类型透传）；重复命中时只写 `logger.info`（`webhook-v21.ts:1042`），`webhook_deliveries.decision_reason` 此时仍是判定阶段的 `enabled`（`webhook-v21.ts:188-196` 写的是触发原因），HTTP 响应里的 `duplicate` 不回写数据库。
- **判定依据**：「第二次不触发」在代码上成立（唯一索引 + 指纹）；「后台可查到记录」只有日志、没有可查询的落库事实，属需求明写的子条件缺失。

### AC-20

- **状态**：与需求冲突
- **证据**：失败时消息行只被改状态：`apps/server/src/agent/dispatcher.ts:201-205`（`finishMessageAndContinue` → `markMessage(...,'failed')`）与 `apps/server/src/agent/store.ts:140-142`（`UPDATE agent_messages SET status = $4`），行与 fingerprint 保留；用户原样重发时 `webhook-v21.ts:903-915` 重算出**同一个** `commentFingerprint`，`store.ts:95-98` 的 `ON CONFLICT DO NOTHING` 不再插入，`webhook-v21.ts:1038-1043` 直接返回 `duplicate` 且不再 `dispatchAgent`。
- **缺口**：不存在「上次为 `failed` 则允许重新入队」的分支（全仓无 `requeue`/重建 fingerprint 逻辑）；`agent_messages` 的 fingerprint 唯一索引把「同内容重发」永久压成一条。需求要求失败后重发能正常触发，代码行为相反（`webhook-v21.ts:1038`）。
- **判定依据**：需求句子的两个动作（失败 → 原样重发）在代码里都走同一条 `ON CONFLICT` 路径，冲突是确定性的，不依赖运行环境。

### AC-21

- **状态**：已实现
- **证据**：`apps/server/src/prompt/repo-issues.ts:81-84` 每行只渲染 `#编号 [state] 标题`；`repo-issues.ts:120-123` 先 `filter(entry => !entry.isPullRequest)` 再按 `updatedAt` 倒序 `slice(0, REPO_ISSUES_MAX_ITEMS)`；`repo-issues.ts:38` 常量 `REPO_ISSUES_MAX_ITEMS = 200`（与需求「上限 200 条」一致，requirements.html:455）；`repo-issues.ts:127-129` 超限时追加 `（共 ${total} 条，仅列最近 200 条）`；生产装配 `apps/server/src/app/compose.ts:831-835` + `981-984` 把 provider 注入 webhook，`webhook-v21.ts:559-583` 走 `GET /repos/{owner}/{repo}/issues` 并透出 `pull_request` 供过滤。
- **判定依据**：四个子条件（字段集合、排除 PR、上限、超限说明）都能定位到具体行，且说明文案与需求的「共 N 条，仅列最近 M 条」同形；断言级测试在 `apps/server/test/prompt-repo-issues.test.ts:91-101`。

### AC-22

- **状态**：已实现
- **证据**：`apps/server/src/http/webhook-v21.ts:465` — `const provider = needsRepoIssues(template) ? repoIssuesProviderOf(input.deps) : undefined`，模板没写占位符时连 provider 都不创建（`repoIssuesProviderOf` 是唯一 `listIssues` 持有者，`webhook-v21.ts:259-276`）；第二道闸在 `apps/server/src/prompt/render.ts:193-201`，`typeof source === 'function'` 时只有 `needsRepoIssues(template)` 为真才 `await source()`；`render.ts:93-95` 的判据就是字面 `template.includes('{{repo.issues}}')`。
- **判定依据**：请求只可能由 `provider.render()` 发出，而它在两条惰性闸之后才会被调用，故「模板没有该占位符 → 零 issue 列表请求」在代码上是闭合的。

### AC-23

- **状态**：已实现
- **证据**：`apps/server/src/agent/session-state.ts:123-131` — `issues.closed` 且实时状态为 `closed` 时返回 `recycle-sandbox` + `state:'idle'` + `keepSession:true`；`session-state.ts:133-142` — 重开返回 `reuse` + `rebuildSandbox:true`；落库只改状态不动会话：`apps/server/src/http/webhook-v21.ts:796-802`（`recycle` 只置 `state/sandbox_id/closed_at`，`reuse` 用 `COALESCE("sandbox_id", $3)` 且不改 `session_id`），`webhook.ts:1210-1222` 用载荷里的真实事件与 `issue.state` 触发；执行侧 `apps/server/src/app/compose.ts:1157-1160` 读 `agent_sessions`，`compose.ts:442-479`（有 `session_id` → `{mode:'persistent', sessionId, after}`）→ `apps/server/src/runtime/turn-driver.ts:359-372` 走 `session/attach` 复用原会话；沙箱按轮创建/销毁（`compose.ts:386-388` 与 `sandbox/lifecycle.ts` 的 `planSweep`），没有常驻 per-session 容器。
- **判定依据**：三个子条件都有实现路径：关闭只回收资源（DB 状态 + 容器生命周期）、会话行与 `session_id` 从不删除（无 DELETE 语句，`webhook-v21.ts:790-792` 注释与 SQL 一致）、重开复用并重建沙箱。附注：`turn-driver.ts:485-490` 的 attach 失败会降级为新建会话（记 warn），那是容错分支而非语义，不改变结论。

### AC-24

- **状态**：无法判定
- **证据**：摘要提示词强制六段并含「目标」「约束与偏好」：`apps/server/src/compact/summary.ts:27-34`，增量语义（上一版摘要 + 新增消息，不重压全量）在 `summary.ts:74-79`；引擎声明「追加不改写」`apps/server/src/compact/engine.ts:8`。但压缩**不会在本仓运行**：装配层只注入不调用（`apps/server/src/app/compose.ts:880-881`「只暴露不调用」），worker 明确「不发起压缩」（`apps/server/src/worker/run-task.ts:933-936`、`run-task.ts:412-418`：RACP 无 session/history 与 compact 操作）。
- **判定依据**：需求验证的是「压缩两次之后模型还能复述第一轮目标与硬约束」，这是模型行为，静态代码只能证明摘要模板里要求了这两段；同时生产路径上不存在触发两次压缩的调用方，压缩只能由 host 侧报事件，故既不能判已实现也不构成确定的冲突，归为无法判定。

### AC-25

- **状态**：部分实现
- **证据**：字段齐全：`apps/server/src/compact/store.ts:32-37` 写入 `generation / before_tokens / after_tokens / summary_chars / fallback / created_at`，只 INSERT 不 UPDATE/DELETE（`store.ts:9-11`）；生产写路径在 `apps/server/src/worker/run-task.ts:946-958`（`store.record()` + 追加 `compact.recorded` 事件，payload 含 generation/beforeTokens/afterTokens/summaryChars/fallback），装配注入见 `apps/server/src/app/compose.ts:845-846, 1423`。
- **缺口**：没有专门的读取面。`apps/server/src/compact/store.ts:51-61` 的 `listByIssue` 零调用方（`apps/server/src/queries/**`、`apps/server/src/http/**`、`apps/panel/src/**` 均无 `agent_compactions` 引用）；后台唯一可见途径是运行详情的事件流，把 `compact.recorded` 归成 `notice` 后原样打印 JSON（`apps/server/src/queries/sql.ts:336`、`apps/panel/src/routes/task-detail.tsx:192-226`），既没有「压缩记录」视图，也无法按会话/代数查询。
- **判定依据**：记录写入与「只追加」成立，但需求写的「后台能看到压缩记录（前后 token、是否兜底、第几代）」缺少面向该表的读路径，属子条件缺失；「原始对话一条不少」在本仓只体现为 `agent_messages`/`run_events` 无删除路径，原始对话本体在 host 侧，静态无法证实。

### AC-26

- **状态**：与需求冲突
- **证据**：`apps/panel/src/layout/nav.ts:22-27` — `GLOBAL_NAV` 就是 5 项：`/`(总览)、`/costs`(成本)、`/quality`(质量)、`/audit`(审计)、`/system`(系统)；`nav.ts:48-53` — `REPO_NAV` 是 5 项：工作台、Issue 中心、运行、设置、技能；`apps/panel/src/routes.tsx:53-82` — `PANEL_ROUTES` 里总览/成本/质量/审计/系统五条全部存在且 `element` 是真页面；`apps/panel/src/layout/Sidebar.tsx:66-88` 把两组都渲染出来。
- **缺口**：需求要求「项目级导航只有 Issue / 设置 / 技能三项、全局只有一个『系统』入口、五个页面在路由表里不存在」；实际是全局 5 + 项目 5，且五页全部在路由表里，逐条相反（`nav.ts:23-27`、`routes.tsx:55-59`）。
- **判定依据**：导航与路由是同一份常量的事实源，代码里不存在第二套收敛后的导航；冲突可直接按行指出。

### AC-27

- **状态**：未实现
- **证据**：`apps/panel/src/routes/issue-detail.tsx:100-157` 首屏是 `PageHeader`（标题行 + 状态徽标 + 复制链接/打开 GitHub），紧接着 `issue-detail.tsx:159-183` 直接进 `AsyncSection` 的会话体，`issue-detail.tsx:229-233` 是轮次列表。文件头明确写了「刻意去掉的东西」（`issue-detail.tsx:35-37`），其中不含原文卡/系统提示词这两块，但代码里也确实没有它们。
- **缺口**：首屏四段里只有「标题行」与「第一条人类输入」存在；「收起的原文卡」「收起的系统提示词」两段完全没有渲染节点（全仓 `apps/panel/src` 无原文卡/系统提示词展示组件，`system_prompt` 只出现在设置页 `components/settings/v21-agent-section.tsx:341-383`）。
- **判定依据**：需求给的是自上而下的四段顺序，缺两段即整条不成立。

### AC-28

- **状态**：未实现
- **证据**：`apps/panel/src/routes/issue-detail.tsx:189-236` 的 `SessionBody` 只有「对话栏 + 轮次列表」；作者/时间只出现在人类轮气泡的元信息行（`issue-detail.tsx:251-255`），标签只在对话栏里以 Badge 平铺（`issue-detail.tsx:217-225`），issue 正文（`issue.body`）在面板侧从未取用（`apps/panel/src` 无 `issue.body` 引用）。
- **缺口**：没有原文卡，因此「展开原文卡能看到作者、时间、标签与正文」无从满足；「同一条评论不会同时出现在原文卡与会话流里」这个约束也失去对象。
- **判定依据**：AC-28 的两个子条件都挂在原文卡上，卡不存在即未实现。

### AC-29

- **状态**：未实现
- **证据**：issue 详情页没有任何提示词展示位（`apps/panel/src/routes/issue-detail.tsx:100-236` 全部节点已核对）；面板里对 `system_prompt` 的唯一展示是设置页的可编辑 textarea（`apps/panel/src/components/settings/v21-agent-section.tsx:341-383`），那是配置编辑，不是「展开本轮系统提示词看完整 markdown 原文」。
- **缺口**：既没有折叠态的「系统提示词」入口，也没有任何按轮展示完整 markdown（含 `# 角色`、`## 硬约束`）的渲染；接口侧也没有把本轮系统提示词带给面板。
- **判定依据**：需求要求「展开后看到完整 markdown 原文，不是分层表格或摘要」，代码里连展示位都不存在。

### AC-30

- **状态**：部分实现
- **证据**：三层结构成立：轮级按钮 `apps/panel/src/routes/issue-detail.tsx:291-306`（`aria-expanded` + `issue-detail-tools-toggle`）→ 组行 `issue-detail.tsx:318-331`（`N 次操作` / `M 次失败`）→ 单次调用 `issue-detail.tsx:385-395`（`ToolRow`）；失败可见：`issue-detail.tsx:388` 用 `StatusDot tone={call.ok ? 'success' : 'danger'}`，并在组行统计失败次数（`issue-detail.tsx:325-330`）。
- **缺口**：`verdict`/`actions` 没有「默认收起」的折叠态 —— 运行详情里 `EnvelopesSection` 直接把 `verdict`、`evidence`、`actions` 三栏铺开渲染（`apps/panel/src/routes/task-detail.tsx:296-341`），issue 详情页则完全不显示这两项。
- **判定依据**：前两个子条件有具体实现与可见标记，第三个子条件（折叠且默认收起）没有任何 `aria-expanded`/展开控件，只能判部分实现。

### AC-31

- **状态**：未实现
- **证据**：三个所谓左栏都不是左栏：Issue 队列页用工具条筛选与右侧抽屉，正文里没有左侧列表（`apps/panel/src/routes/issues.tsx:425` 是筛选输入框，`issues.tsx:586-602` 是 `hidden ... xl:block` 的**右**侧 `aside`）；设置分区是横向可滚动的 `<nav>`，`lg` 起才转纵向且无固定宽度（`apps/panel/src/components/settings/settings-chrome.tsx:192-215`，`lg:w-full` + `min-w-40`）；技能页是平铺表格行（`apps/panel/src/routes/repo-skills.tsx:272-286`，`grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]`）。
- **缺口**：不存在统一宽度的三个左栏，也就没有「宽度一致、选中态一致」；「只有一个位置（`⋯` 或 dock）能触发页面切换以外的动作」也没有对应物 —— 动作散落在工具条、表行按钮与设置头部的保存条（`components/settings/save-bar.tsx:102-113`）。
- **判定依据**：需求描述的版面结构在代码里没有对应实现，不是样式偏差而是结构缺失。

### AC-32

- **状态**：未实现
- **证据**：系统页只有版本与协议、doctor 检查、队列与保留策略、仓库列表四个区块（`apps/panel/src/routes/system.tsx:137, 176-220, 222-276, 278-326`），全程没有供应商 / base URL / key 掩码 / 连通性 / 可用 model 的字段；面板源码里没有任何「供应商」「掩码」「model 单价」渲染（`apps/panel/src` 检索 `baseUrl|掩码|供应商|价格` 无命中，`baseUrl` 仅出现在审计页的导出链接 `routes/audit.tsx:133`）；项目页的模型字段是一个自由文本输入「默认模型（provider/model，可留空）」（`components/settings/v21-agent-section.tsx:264-276`），不是「继承全局」的展示；价目只在服务端写死两档（`apps/server/src/cost/pricing.ts:16-31`，`flash|pro`），面板没有四档角色的输入/输出单价展示。
- **缺口**：三个子条件全缺：全局供应商信息（base URL/掩码/连通性/可用 model）、四档模型角色各自输入/输出单价、项目页「继承全局」而非并列下拉（现状是可直接填 provider/model 的文本框，语义相反）。
- **判定依据**：相关 UI 与契约字段都不存在，无法用「别处实现」补救。

### AC-33

- **状态**：部分实现
- **证据**：缺接口的动作确实是禁用态且 `title` 点名接口：`apps/panel/src/routes/overview.tsx:199` 定义 `RERUN_DISABLED = '缺少写接口：POST /api/tasks/:id/rerun 尚未实现…'`，`overview.tsx:234` 挂到「重跑」，渲染处 `overview.tsx:539-563` 用 `disabled` + `title={action.disabledReason}`；「暂停全部」同样禁用并写明 `POST /api/flags`（`overview.tsx:866-871`）。
- **缺口**：需求点名的「标记人工」「面板内发送」在界面上根本没有控件（`apps/panel/src` 检索 `标记人工|面板内发送` 无命中，issue 详情页无输入框/发送按钮），因此谈不上「都是禁用态、`title` 写明缺失接口名」；目前只有重跑与暂停两项被这样处理。
- **判定依据**：已有动作的禁用与 `title` 口径正确，也没有发现伪造的「已完成」提示；但需求枚举的三类动作里有两类缺失控件，属子条件缺失。

## 本节整体结论

16 条里只有 AC-21、AC-22、AC-23 三条可以判为已实现，且都是后端单点能力（占位符渲染 / 惰性取数 / 会话状态机）。AC-18、AC-19、AC-25、AC-30、AC-33 主体在但各自缺一个明确子条件（空 `allow_roles` 放行、重复跳过无留痕、压缩记录无读取面、verdict/actions 不折叠、两类动作无控件）。AC-20 与 AC-26 是方向性冲突：去重把失败重发也挡住；导航与路由保留了需求要求删掉的五个页面。面板侧 AC-27 ~ AC-29、AC-31、AC-32 的版式与模型配置视图基本未落地。因此本节整体**不能**判为已实现。

## 核查边界

- 是否执行了命令：只执行了只读检索（`git status --short`、`Get-ChildItem`、`Select-String`、逐文件 `Read`）；**未**执行任何构建、测试或运行时命令（`pnpm -r test` / `pnpm lint` / 起 PG / 起 Docker / 调真模型均未跑），故所有结论都是静态取证，未声明任何测试「跑过且绿」。
- 未覆盖的条目及原因：无遗漏条目；但 AC-23 的「历史上下文仍在」与 AC-24 的「模型复述」依赖 RACP host 与真模型，静态只能核到代码路径；AC-25 的「原始对话一条不少」需 host 侧会话存储才能确认。
- 发现的额外问题（不属本节范围但值得记录）：
  1. `content-duplicate` 作为契约里的 `SkippedReason`（`trigger/decide.ts:40`）在生产上永不会出现，属死分支；若后续要用它做留痕，需要先把去重结果回灌到判定输入。
  2. `agent_compactions.listByIssue`（`compact/store.ts:51-61`）是为面板画的查询，但没有任何调用方，等于第二处真相未接线。
  3. `compact.recorded` 不在 `RUN_EVENT_KINDS` 枚举里（`packages/contract/src/enums.ts`），落库后经 `sqlRunEventKind` 被归成 `notice`（`queries/sql.ts:336`），面板因此只能看到「通知 + 原始 JSON」，语义丢失。
  4. `apps/panel/src/routes/issue-detail.tsx:35-37` 的注释与需求 §5 的「完整对话」demo 已经分叉：注释说去掉了结论正文等视图，但需求 AC-27/28/29 要求补回原文卡与系统提示词，注释与验收标准需要同批对齐。
