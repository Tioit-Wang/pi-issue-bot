# U28 11 决策记录 Q-1 ~ Q-9 · B

> 核查范围：docs/requirements.html 行 1886-1948
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| Q-1 占位符全部正式 | 已实现 | — |
| Q-2 未知占位符原样保留 + 记告警 | 已实现 | 告警只有一条进程日志（无落库、无面板面） |
| Q-3 会话无结束状态、只回收沙箱 | 与需求冲突 | 队列任务路径仍会 `session/archive` 轮换新会话（30 轮 / 7 天） |
| Q-4 自动压缩三处取舍 | 部分实现 | 三处取舍代码都对，但压缩引擎零生产调用方，「自动压缩」不生效 |
| Q-5 事件进不进会话由项目配置 | 已实现 | — |
| Q-6 一事件一提示词、平台不维护技能注册表 | 已实现 | 存在技能目录（非事件路由表）；另有遗留「事件→技能」映射 |
| Q-7 面板只留三项目页 | 与需求冲突 | 全局仍是 5 个页面、`/system` 仍是页面不是模态框，项目级仍是 5 页 |
| Q-8 Issue 页做成会话流 | 部分实现 | 缺原文折叠卡、系统提示词折叠块、写回居中行、输入区 |
| Q-9 面板内发送本版不做 | 已实现 | 确认无该能力（输入区也未画） |

## 逐条

### Q-1
- **状态**：已实现
- **证据**：`packages/contract/src/settings-v21.ts:420` — `PROMPT_PLACEHOLDERS` 是 12 条 `{ name, description }`，结构里**没有任何状态字段**（无「待定 / 候选」维度）；`apps/server/src/prompt/render.ts:132` — `resolvePlaceholder()` 的 switch 覆盖同样 12 个名字（`issue.author` … `event.action`）；`apps/server/test/prompt-render.test.ts:42` — `expect(PLACEHOLDER_NAMES).toHaveLength(12)` 且逐个断言可渲染。
- **判定依据**：需求 §6.3（行 1481-1502）表格正好 12 行，与代码清单逐名对齐；「不再区分待定」在代码里表现为**类型上不存在第二个状态**，不是靠注释声明。
- **反证过程**：先假设「存在一份标注待定的旧清单」——全仓检索 `待定 / PLACEHOLDER_STATUS / pending` 在占位符相关文件中零命中（`pending` 只出现在 `api.ts:685` 的队列计数与 `1086` 的 `pendingFeedback`，与占位符无关）。再查「面板是否自抄一份清单」——`apps/panel/src/components/settings/v21-events-section.tsx:30` 直接 import 契约的 `PROMPT_PLACEHOLDERS`，无第二份。唯一可见的漏洞是 `packages/contract/src/settings-v21.ts:446` 的 `PLACEHOLDER_NAMES` 由映射生成，仍属同一事实源，不构成缺口。

### Q-2
- **状态**：已实现
- **证据**：`apps/server/src/prompt/render.ts:175` — `if (value === null) { … return match; }`，未知占位符把**原始 `match` 原样返回**（不是空串）；`apps/server/src/prompt/render.ts:159` — `default: return null`，即任何不在 switch 里的名字走「未知」分支；`apps/server/src/http/webhook-v21.ts:495` — `if (rendered.unknown.length > 0)` 组 `V21UnknownPlaceholderWarning`（含 `unknown / event / repo / deliveryId`）并调用 `reportV21UnknownPlaceholders()`；`apps/server/src/http/webhook-v21.ts:372` — 该函数执行 `logger.warn({unknown, event, repo, deliveryId}, 'v2.1 模板含未知占位符：已原样保留…')`。
- **判定依据**：两个子条件都能追到生产路径上的消费方——渲染结果 `build.text` 在 `webhook-v21.ts:1034` 落 `agent_messages.comment_body`（原样保留生效），告警在 `webhook-v21.ts:502` 由 `buildV21AgentMessage()`（`webhook.ts:1262 → webhook-v21.ts:1007` 唯一生产调用点）实际触发。
- **反证过程**：① 先假设「未知被静默替换成空串」——`render.ts:173` 的 `replace` 回调只有两个返回点，`null` 分支返回 `match`，`void 0`/`''` 两种退化都不存在；`resolveRepoIssues()`（`render.ts:106`）在未准备数据时返回 `null` 而非 `''`，进一步排除「空串悄悄混入」。② 再问「告警是否只是死代码」——`reportV21UnknownPlaceholders` 在 `webhook-v21.ts:502` 被调用，其 logger 由 `webhook.ts:1264` 的 `log` 注入，落在 pino（`packages/shared/src/logger.ts:76` 的 `instance.warn`）→ stdout/journald。③ 追「是否有可查记录」——`input.deps.onUnknownPlaceholders?.()`（`webhook-v21.ts:503`）是唯一想接到面板/告警系统的端口，但全仓检索 `onUnknownPlaceholders` 只有类型声明、调用点与 `test/v21-webhook-integration.test.ts:218` 的假实现，**装配层 `app/compose.ts` 从未传它**，所以这条记录等于零。结论：需求原文只要求「记一条配置告警」，结构化 warn 成立故判已实现；但「可查」这一层（落库 / 面板可见）不存在，属加强项缺口，写入「发现的额外问题」。

### Q-3
- **状态**：与需求冲突
- **证据**：
  - `apps/server/src/app/compose.ts:450` — `const reason = (session.turns >= maxTurns) ? 'turns' : ageMs >= maxAgeDays*86400000 ? 'age' : null`，`maxTurns=30`、`maxAgeDays=7`（`compose.ts:209`）。
  - `apps/server/src/app/compose.ts:456-463` — `if (reason !== null) { … return { rotate: true, rotateReason: reason, archiveSessionId: sessionId } }`，命中即把旧会话**换掉**。
  - `apps/server/src/app/compose.ts:1315` — `if (!v21SessionEventActive && agentSession.archiveSessionId !== null) { await channel.ops.sessionArchive({ sessionId: agentSession.archiveSessionId }); }`，即真的发 `session/archive`（`packages/racp-client/src/ops.ts:78` = `'session/archive'`）。
  - `apps/server/src/app/compose.ts:1196` — `v21SessionEventActive` 只有 `input.sessionEvent !== undefined` 时才置 `true`；而 `sessionEvent` 的**唯一生产调用方不存在**：它只在 `compose.ts:533` 声明、`compose.ts:1196` 读取，队列作业路径 `compose.ts:1460-1464` 只传 `taskId/attempt`，全仓其余命中都在测试里。⇒ 生产中该标志恒为 `false`，上面那条 archive 分支是**活的**。
  - `apps/server/src/db/schema.ts:680` — `closedAt: timestamp('closed_at')`（`agent_sessions` 上的关闭时刻列存在）。
- **缺口**：需求 Q-3 说「会话没有结束状态、会话本身不归档、重开直接复用原会话」。代码在 agent 任务跑满 30 轮或存活超 7 天后**归档旧会话并新建会话**，历史上下文就此断掉（`compose.ts:1311-1312` 的注释也承认「archive 失败只告警（旧会话会被每日清理带走）」，说明清理预期存在）。另有 `agent_sessions.closed_at` 列：语义是「沙箱回收时刻」（`schema.ts:679`），`recycle` 写 `now()`、`reuse` 写回 `NULL`（`webhook-v21.ts:797` / `800`），且**没有任何读路径**（检索 `closed_at` 只命中写 SQL、schema 与测试），因此它本身不构成「结束状态」，但确实是「关闭时刻」字段，按要求列出。
- **判定依据**：`agent/session-state.ts:69` 的 `SESSION_ACTIONS = ['create','reuse','recycle-sandbox']` 与 `webhook-v21.ts:796-801` 的 recycle-only 更新确实做到了「关闭只回收沙箱」；但同一进程里另一条**未受 v2.1 状态机约束**的轮换分支仍在生产路径上执行归档，决策的实质（会话随时可重开、上下文不断）被破坏，故判冲突而非部分实现。
- **反证过程**：按任务要求逐词扫：`archived` → 命中 `archivedAt`（仓库归档，`repos` 表，与 issue 会话无关，`config/repo-config.ts:165`）；`ended` → 只剩 `app/racp.ts:90` 的**事件流**结束标志与 `panel/routes/costs.tsx:264` 的展示变量，不是会话状态；`closed_at` → 见上，`agent_sessions.closed_at` 存在但只写不读；`rotat` → 命中 `compose.ts:215 AgentSessionRotationReason`、`compose.ts:244`「轮换：先 archive 旧会话再新建」、`compose.ts:1315` 的归档调用（README/AGENTS 均未禁止）。再反向假设「这条轮换在 v2.1 下已关闭」：`compose.ts:1313` 的注释这么写，但守门条件是 `!v21SessionEventActive`，而该标志的生产值恒 false（上文已用「无生产调用方」证明）——注释与行为不一致，行为以 `1315` 那行为准。结论：存在归档/轮换代码路径且生效。

### Q-4
- **状态**：部分实现
- **证据**：
  - 取舍①（阈值现算不配置）：`apps/server/src/compact/thresholds.ts:97` — `hardLimit = windowTokens - reserve`，`autoLimit = 0.9 × hardLimit`（`thresholds.ts:47` `autoRatio: 0.9`、`thresholds.ts:98`），`windowTokens` 由调用方按**当前模型**传入（`engine.ts:98`），全仓检索 `context_window/window_tokens/auto_ratio` 在配置里**零命中**（确认没有配置项）。
  - 取舍②（追加 checkpoint 不改写历史）：`apps/server/src/compact/store.ts:33` — 只有 `INSERT INTO agent_compactions`；同文件 `latestGeneration`（`store.ts:39`）与 `listByIssue`（`store.ts:51`）都是 SELECT，**没有 UPDATE / DELETE**。
  - 取舍③（保留真实最近窗口，含助手输出与工具结果）：`apps/server/src/compact/engine.ts:479` — `selectRecentWindow()` 后 `viewMessages = stripOrphanToolResults(window.recent)`，返回 `view: { summary, messages: viewMessages }`（`engine.ts:512`）；`engine.ts:212-243` 的切窗按 token 预算从尾部取，**不过滤 role**（tool/assistant 一并带进窗口），与「只留用户消息」相反。
  - 关键反向证据：`apps/server/src/app/compose.ts:880` — `// 只暴露不调用：RACP 没有 history/compact 操作，请求前自动压缩尚属遗留`，`compose.ts:881` `compactor: createV21Compactor`；`apps/server/src/worker/run-task.ts:196-202` — `compactor?: unknown | undefined`，**run-task 内部零读取**（同文件检索 `compactor` 只命中 `197/202` 两行声明）；`apps/server/src/app/worker-deps.ts:1028` 注释同样写「本轮只暴露、不自动调用」。生产上真正落地的只有「识别 `itemType==='compaction'` 事件 → 追加一行记录」（`run-task.ts:419`、`webhook-v21.ts:764`）。
- **缺口**：缺「请求发出前真的自动压缩」这一条——引擎与阈值全是纯函数 + 注入式，`compactSession()` 的唯一调用方是 `createCompactor()`（`engine.ts:698`），而后者在生产只被挂成常量（`compose.ts:881`）、无人 invoke；于是「阈值现算」虽然写对，却没有任何生产消费方，90% 线与硬边界在真实链路上不会触发。
- **判定依据**：需求 Q-4 的落点（行 1909-1914）是「做自动压缩」+ 三处取舍。三处取舍按代码逐条对上（①②③均可定位到实现路径且无反向证据），主体也在，故不是「未实现」；但「自动压缩」本身没有生效路径，属于需求明写的运行子条件缺失 → 部分实现。
- **反证过程**：① 先假设「压缩引擎有生产调用点」——全仓检索 `createCompactor|compactSession|createBoundV21Compactor`：`createCompactor` 命中仅在 `engine.ts`、`worker-deps.ts:1032`（再导出）、`compose.ts:111`（import）与测试；`createBoundV21Compactor`（`worker-deps.ts:1059`）只被 `test/v21-worker-integration.test.ts:44` 引用，无 `src` 调用方。② 假设「run-task 会用它」——`run-task.ts:202` 的 `compactor?: unknown` 连类型都退化成 `unknown`，函数体内无一处读取。③ 逐个验证三处取舍：① `thresholds.ts:97-98` 用窗口现算且配置层无阈值字段；② `store.ts:33-57` 只有 INSERT/SELECT，`engine.ts:8` 声明「追加不改写」与代码一致；③ 检查是否照搬参考实现「只留用户消息」——`engine.ts:220-235` 按 `estimateMessageTokens` 从尾切、不判 role，`engine.ts:238` 还特意把 tool 孤儿切点前移，属「保留真实最近窗口」的**加强**而非相反。结论：取舍三条成立，运行能力缺失。

### Q-5
- **状态**：已实现
- **证据**：`packages/contract/src/settings-v21.ts:326` — `eventTriggersSchema` 逐事件预置默认（`issues.opened / edited / labeled / closed / issue_comment.created`），字段是 `enabled / prompt / labels / only_body_changed / gates`；`apps/server/src/trigger/decide.ts:226` — `const trigger = resolveEventTrigger(input.settings, event)`，`decide.ts:227` `if (trigger.enabled === 'off') return skip(..., 'switch-off')`；`decide.ts:257-258` — 只有配置 `prompt` 为空时才回落 `DEFAULT_EVENT_TEMPLATES[event]`；`apps/server/src/config/v21-settings.ts:105` — `resolveEventTrigger()` 从 `read.settings.triggers.events[event]` 取值；内置默认值本身也在契约（`settings-v21.ts:473`）。
- **判定依据**：开关、附加条件（`only_body_changed` / `labels`）、模板三件事全部由项目级 schema 提供并被判定函数读取（`decide.ts:145-162` / `257`），平台侧只提供一份可被覆盖的默认模板——与决策逐字一致。
- **反证过程**：先假设「事件语义被硬编码」——检索是否有绕过 settings 的 `switch(event)` 分支决定行为：`v21EventKeyOf()`（`webhook-v21.ts:85`）确实按事件名映射 `EventKey`，但那是**事件词汇表**（GitHub 事件 → 领域事件），不改判定结论；真正的判定逻辑（`decide.ts:209-266`）每条都先读 `resolveEventTrigger` / `resolveCommentGates` / `resolveCommentConfig`，无一处写死「opened 必须如何」。再查「默认值是否是第二处真相」——面板 `v21-events-section.tsx:30` 与服务端默认都 import 同一份契约常量，无第二份。唯一可疑项是 `issues.closed` 默认 `enabled: 'off'`（`settings-v21.ts:331`）：这是「内置默认值」，项目可改，符合「平台只给一套内置默认」，不构成冲突。

### Q-6
- **状态**：已实现
- **证据**：`apps/server/src/trigger/decide.ts:260-265` — 判定命中时返回**一个** `template` 字符串；`apps/server/src/http/webhook-v21.ts:464` — `const template = input.decidedTemplate ?? v21TemplateOf(...)`，一份模板渲染成一条消息；`apps/server/src/http/webhook-v21.ts:514` — `skillIds` 最多一个（`v21SkillIdsOf()` 只取首行一个 `/name`，见 `webhook-v21.ts:394-399`）；平台侧动作集合是封闭枚举 `OUTPUT_ACTION_TYPES`（12 项，`packages/envelope/src/v21.ts:40-53`），其中需项目开关的 3 项由 `GATED_ACTION_TYPES`（`v21.ts:63`）单列——平台只校验与执行，不决定产出哪一种。技能侧的结构是**清单**：`apps/server/src/skills/registry.ts:58-71` 的 `SkillRegistry` 只有 `list / summaries / get / resolve / enabledNames / diagnostics`，键是**命令名**，没有任何 `event → skill` 字段。
- **判定依据**：「一个事件一份提示词」在生产路径上成立（`webhook-v21.ts:1007` 唯一入口，一次 `build.text` 落一条消息）；「平台不维护技能注册表」按可用证据无争议——注册表是按文件清单合并的目录（内置 + 仓库技能，`registry.ts:240-303` 是覆盖/冲突判决），不是按事件路由的表；多技能串行在平台侧零实现（无串联逻辑）。
- **反证过程**：① 直接找「按事件路由的表」：检索 `EVENT_SKILL / eventSkill / event → skill`，命中 `apps/server/src/agent/message.ts:163-170` 的 `eventSkillsOf()`（用 `settings.agent.on_opened/on_edited`）——但这属 **v0.3 旧链路**，其唯一入口 `submitAgentMessage()`（`webhook.ts:1508`）只在 `decision.plan.agent !== undefined` 且 v2.1 分支未接管时到达（`webhook.ts:1260-1287` 先返回）；生产装配注入了 `v21`（`compose.ts:981`），`issues.opened/edited` 已被 v2.1 接管，故这条映射在主链路上不可达，记为遗留（写入额外问题）而非冲突。② 检查注册表是否被用来「决定做什么」：`worker-deps.ts:919-932` 用它把提示词首行解析成一个技能再注入正文——输入来自**项目模板**而非事件类型，故属「清单 + 解析」，可辩护。③ 检查是否有多技能串联：`v21SkillIdsOf()` 只返回 1 个元素，无串联代码。

### Q-7
- **状态**：与需求冲突
- **证据**：`apps/panel/src/layout/nav.ts:22-28` — `GLOBAL_NAV` 仍是 5 项：`总览 / 成本 / 质量 / 审计 / 系统`（含被要求取消的 `总览`、`成本`、`质量`、`审计`）；`apps/panel/src/routes.tsx:55-59` — 五条全局路由各自渲染 `OverviewPage / CostsPage / QualityPage / AuditPage / SystemPage`，即「五个旧页面」**全部仍在**；`apps/panel/src/routes.tsx:59` — `/system` 是一个**页面**（`<SystemPage />`），不是 dock 最右的模态框（全仓无「系统」模态框组件，`ui/dialog.tsx` 只是通用对话框）；`apps/panel/src/layout/Sidebar.tsx:67-71` — 左栏把 `GLOBAL_NAV` 五项全部渲染出来；项目级也不止三页：`nav.ts:48-54` 的 `REPO_NAV` 是 5 项（`工作台 / Issue 中心 / 运行 / 设置 / 技能`），`routes.tsx:62/71` 还注册了工作台与运行两条路由。
- **缺口**：需求要求「项目级只有 Issue / 设置 / 技能；全局只剩一个系统模态框；总览、成本、质量、审计、系统五页取消」。代码里五个全局页一个没删、系统仍是独立页面且没有模态框形态；项目级还多出「工作台」「运行」两页。
- **判定依据**：这是行为与需求相反（页面存在且可达），不是「部分实现」，故判冲突。`routes.tsx:25-40` 的注释也自述路由表是「多仓库工作台版」，与 Q-7 的收敛目标不同代。
- **反证过程**：先假设「新导航另有其表，旧表只是兼容导出」——`Sidebar.tsx:7` 直接 import `GLOBAL_NAV` 并 `map` 渲染（`67-71`），是唯一左栏来源，不存在第二份被过滤的表；`routes.tsx:102` 的 `NAV_ITEMS` 只是 `GLOBAL_NAV` 的映射别名。再假设「页面文件在但路由已摘」——`PANEL_ROUTES`（`routes.tsx:53-94`）逐条列了五个全局页并 `map` 进 `<Routes>`（`111-117`），可直接访问。再查「系统是否另有模态框实现」——检索 `aria-modal` 只命中 `ui/dialog.tsx` 与 `CommandPalette.tsx`，无「系统」模态框。最后查顶栏状态带是否需要（FR-7.2 的去处）——属实现深度问题，不影响本条的冲突判定。

### Q-8
- **状态**：部分实现
- **证据**：已有的一半——`apps/panel/src/routes/issue-detail.tsx:256-269` 人类输入**右对齐气泡**并带事件元信息（`252-254` 的 `login / channel / time`）；`issue-detail.tsx:288-315` 机器人**在左、无卡片**（只有 `border-t` 分隔线，没有卡片容器）；`issue-detail.tsx:291-306`（轮，第 1 层）→ `317-341`（工具组，第 2 层）→ `384-395`（单次调用，第 3 层）三层折叠，且失败可见（`328` 失败计数、`388` 状态点）。缺的一半——`apps/panel/src/routes/issue-detail.tsx:98-186` 的页头之后直接是 `SessionBody`（`189-236`）：既没有「issue 原文折叠卡（默认收起，露标题与『原文 · 作者 · N 条评论』）」，也没有「系统提示词居中折叠块」，也没有「平台写回居中断行（`✓ 写回 标签 + 评论 slot=…`）」，更没有底部输入区；`issue-detail.tsx:35-37` 的注释明确写「刻意去掉：结论正文、标签与理由、缺哪些信息…」，与写回行需求相反。
- **缺口**：缺子条件 4 项——① issue 原文折叠卡（默认收起）② 系统提示词按 markdown 原文居中折叠 ③ 平台写回居中断行（失败换红）④ 底部输入区形态。其中 ②③ 还受数据面限制：`packages/contract/src/api.ts:1092-1099` 的 `issueSessionResponseSchema` 只有 `issue + turns`，`issueTurnSchema`（`api.ts:931-963`）没有 `systemPrompt` / 写回结果字段，故界面拿不到内容，属「数据面也没下发」。
- **判定依据**：消息流的三条形态（人在右、agent 在左无卡片、工具三层）已在代码里成立，主体在；但 §FR-7.3（行 1423-1424）点名的原文卡、系统提示词、写回行、输入区四项一项都没有 → 部分实现而非已实现。
- **反证过程**：① 逐个找 testid：`issue-detail` / `issue-detail-session` / `turns` / `tools-toggle` / `tool-calls` 存在（`195/229/295/319`），而「原文卡 / system-prompt / writeback / composer」类 testid 在 `issue-detail.tsx` 零命中（全文 437 行已通读）。② 假设这些块在别的组件里——检索 `写回|系统提示词|原文` 在 `apps/panel/src` 的命中全部落在设置页与技能页（`v21-agent-section.tsx` 的系统提示词**编辑框**、`settings-chrome.tsx` 的写回开关文案），无会话流渲染组件。③ 假设「写回信息走了脚注」——`issue-detail.tsx:361-379` 脚注只有成本、`taskId` 链接、评论链接，没有写回成功/失败行，也没有 `slot` 名。④ 反向确认「不是照搬旧分区卡」——旧产出卡的 testid（`issue-detail-result` 等）已被测试断言移除（`apps/panel/src/routes/__tests__/issue-detail.test.tsx:182-201`），说明去卡片这半确实做了，但补会话流元素这半没做。

### Q-9
- **状态**：已实现
- **证据**：面板写面只有配置类与技能类——`apps/panel/src/lib/api.ts:216-229`（`PUT …/settings`、`POST /api/repos`）、`api.ts:255/278/292/311/329/337/345`（技能上传 / 覆盖 / 补丁 / 删除 / 文件保存），**没有任何**写评论、落 agent 消息或直接入队的调用；服务端写路由同样只有这两类：`apps/server/src/http/api/index.ts:319`（PUT settings）、`index.ts:344`（POST repos）、`http/api/skills.ts:291/325/358/380/409/442/522/588`；会话页没有输入区/发送控件：`apps/panel/src/routes/issue-detail.tsx`（437 行）无 `textarea`、无发送按钮、无 `onSubmit`。
- **判定依据**：Q-9 是「明确不做」，判定口径是「代码里确实没有该能力」。写面检索与组件检索双向为空 → 与决策一致，判已实现。
- **反证过程**：先假设「能力以隐藏形式存在」——检索 `sendMessage|writeComment|composer|代发|入队` 于 `apps/panel/src`：命中只有「已回复」状态文案（`issues/status.ts:27`、`routes/issues.tsx:92`）与 `overview.tsx:451` 的「去 GitHub 回复」外链，都是**只读/外跳**，不是写路径。再检查契约是否已埋该接口——`packages/contract/src/api.ts` 无 `commentWrite` / `enqueue` 类 schema，`http/api/*` 也无对应路由。第三点（可疑处）：需求同时要求「输入区只呈现形态，发送按钮为禁用态」（FR-7.5，行 1436-1437），而代码里连输入区都没有——这不改变「本版不做发送」的判定（能力确实不存在），但构成 Q-8 的缺口项，已在 Q-8 点名。

## 本节整体结论
Q-1 / Q-5 / Q-6 / Q-9 四条与拍板结论一致，且都能追到生产消费方（占位符清单、项目级事件判定、单模板单技能、无面板发送写面）。Q-2 的「未知原样保留」与「记告警」两条都在生产路径上成立，只是「可查」止于日志。真正不能放过的是 Q-3：`compose.ts:1315` 的 `session/archive` 轮换在队列任务路径上仍然生效（`v21SessionEventActive` 恒 false），这与「会话没有结束状态、不归档」直接相反；Q-7 的五张全局页一张没删、系统仍是页面而非模态框，也与决策相反。Q-4 与 Q-8 属主体在而关键子条件缺：压缩引擎三处取舍全对但零生产调用方，Issue 页三条消息流形态已对但原文卡/系统提示词/写回行/输入区四项未做。因此本节**不能**判为「已实现」，存在 2 条冲突 + 2 条部分实现。

## 核查边界
- 是否执行了命令：未执行测试/类型检查，**纯静态核查**。仅执行了只读检索：`git status --short`（与基线一致：29 个 ` M` + `?? docs/audit/`，路径逐条相同）、`Select-String` / `Get-ChildItem` 全仓关键词检索、`Get-Content` 计行。未跑 `pnpm -r test`、`pnpm lint`，不声明任何测试为绿。
- 未覆盖的条目及原因：无条目被跳过；Q-4 的「压缩在真实链路上是否被 host 侧触发」需 RACP 真实会话（无 Docker / 无 host）才能进一步确认，按代码只到「无调用方」这一层；Q-3 的「归档后 host 是否真的丢上下文」需真模型/真 host 才能观测，本轮只凭 `session/archive` 调用与 `agent_compactions` 的 `session_id` 归属推断。
- 发现的额外问题（不属本节范围但值得记录）：
  1. `apps/server/src/http/webhook-v21.ts:503` 的 `deps.onUnknownPlaceholders` 端口**零生产接线**（`app/compose.ts` 未传），「未知占位符告警」因此只有一条 stdout 日志，没有落库、没有面板可见面；若要「配置告警可查」，需接线并持久化。
  2. `apps/server/src/agent/message.ts:163` 的 `eventSkillsOf()`（`settings.agent.on_opened / on_edited` → 技能）是「事件 → 技能」硬映射的遗留物，仅在未注入 v2.1 的旧装配上可达；它与 Q-6 的「一事件一提示词」是两套口径，属第二处真相，建议在旧链路退役时一并删除。
  3. `apps/server/src/trigger/decide.ts:251` 的 `dailyQuotaExceeded` 判定分支没有任何生产调用方计算该值（`webhook-v21.ts:155` 只做透传），日配额闸门实际不生效——影响「不触发也留痕」的原因准确性。
  4. `apps/server/src/app/compose.ts:1228` 的交叉校验把 `issueState` 写死为 `'open'`、`state` 写死为 `'active'`（`compose.ts:1174-1179`），该 debug 留痕的结论永远与真实状态无关，排障时会误导。
