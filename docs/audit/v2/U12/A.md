# U12 5.5 执行 + 执行侧可用工具 · A

> 核查范围：docs/requirements.html 行 954-1186
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览

| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| FR-5.1 平台不决定处理内容 | 已实现 | — |
| FR-5.2 工具调用与沙箱 | 部分实现 | Issue* 只读调用只记 `name/ok/items/summary`，**入参与返回正文未记录** |
| FR-5.3 产出契约 | 部分实现 | ① 动作集合是 **12 类**（需求定义 7 类封闭集合）；② `create_issue` 的指纹去重 + 日配额闸门**在生产装配里未注入**，等于不生效；③ 关单准入用模型的 `verdict=fail`，没有确定性条件 |
| FR-5.4 标签目标态与删除权 | 已实现 | — |
| FR-5.5 写回与失败处理 | 部分实现 | v2 路径**不发兜底反馈**（`!v21Handled` 才兜底）；没有独立告警通道，只有 `logger.warn` + `run_events` |
| FR-5.6 上下文压缩 | 部分实现 | ① 整套引擎**无生产调用方**（`compose.ts:880` 注释即承认），自动压缩未生效；② 临近边界「两档提醒」全仓无实现；③ 后台读取压缩点的查询路径缺失 |
| TOOL-1 三段工具面 | 已实现 | — |
| TOOL-2 清单唯一事实源 | 部分实现 | 审批矩阵/技能枚举/提示词目录确实派生；**需求文档表格未派生**（写 16 个，契约是 19 个） |
| TOOL-3 issue 工具集 16 个 | 已实现 | 16 个全部在；另有 3 个扩展（`IssueCommentReply`/`IssueReactionAdd`/`IssueReactionRemove`） |
| TOOL-4 移除项前缀禁止 | 已实现 | — |
| TOOL-5 Bash 不得做 issue 操作 | 已实现 | — |
| TOOL-6 写操作只有一条路 | 已实现 | — |
| TOOL-7 读操作走平台代理 | 已实现 | — |
| TOOL-8 `EXECUTE_CHANNEL_AVAILABLE` | 已实现 | — |

## 逐条

### FR-5.1
- **状态**：已实现
- **证据**：
  - 一个事件一份提示词，且项目可替换：`packages/contract/src/settings-v21.ts`:490-548 — `DEFAULT_EVENT_TEMPLATES` 按 `EventKey` 逐条给默认模板（`issues.edited` / `issues.labeled` / `issues.closed` / `issue_comment.created` …）；`apps/server/src/http/webhook-v21.ts`:359-362 — `v21TemplateOf()` 优先取项目配置 `resolveEventTrigger(settings,event).prompt`，为空才回落内置；`apps/server/src/trigger/decide.ts`:257-258 同一裁决。
  - 平台只做三件事：交输入 `webhook-v21.ts`:436-464（模板渲染 → 一条 agent 消息）；校验产出 `packages/envelope/src/v21.ts`:634-654（`validateOutputV21` 整份判定）；执行产出 `apps/server/src/writeback/v21/execute.ts`:414-457（`executeV21`）。
  - 平台不按事件类型硬编码行为：`execute.ts`:465-492 的 `switch` 只按 `action.type` 分派；`apps/server/src/worker/run-task.ts`:1168-1191 的产出分流只判**契约版本三态**（`valid`/`rejected`/`not-v21`），不判事件类型。
- **缺口**：（无）
- **判定依据**：换一份提示词（项目模板或技能）就换行为，链路上没有任何「事件类型 → 动作」的分支；三条职责各对应一个具名函数。平台确实有「技能库」（提示词模板），但那是提示词来源而非能力/行为决策表，与需求说的「技能注册表」不是同一物。

### FR-5.2
- **状态**：部分实现
- **证据**：
  - 受控环境内调用工具与命令：`apps/server/src/runtime/approval-policy.ts`:194-293 — 每次工具审批都是纯函数判定（`Read/Glob/Grep` allow、`Bash` 走容器、`Write/Edit` 校验路径在 worktree 内、其余 deny），`turn-driver.ts`:584-595 真实调用并回 `allow-once`/`deny`。
  - 工具名与入参留痕：`approval-policy.ts`:202-221 每次判定产出一条审计（`tool` + `inputDigest`（脱敏后截断 240 字符）+ `rule` + `decision` + `reason`），`run-task.ts`:979-982 落成 `run_events(kind='approval.audit')`。
  - 返回值留痕（宿主工具）：`run-task.ts`:975-977 —— 除流式增量 `item.delta` 外，**所有** host 事件原样 `appendEvent(event.kind, event.payload)`，`appendEvent` 落库实现见 `run-task.ts`:601-611（失败只 warn，不吞任务）。
- **缺口**：issue 只读工具调用（`tool_calls` 那一路）的记录缺两个字段：`run-task.ts`:1073-1079 的 `issue.tool.read` 只有 `name/ok/items/summary/errorCode`，**没有入参**（`call.input` 未落），**没有返回正文**（`result.text` 未落）。需求要求「每次调用都要记录工具名、入参与返回」，这五条只读通道只满足第一项。
- **判定依据**：宿主工具那条链路靠原始事件 payload 覆盖了三项（入参与结果都在 host 的 `item.completed` payload 里）；只读工具那条链路是自己构造结构的，字段缺就是缺，能直接指出缺在哪一行。

### FR-5.3
- **状态**：部分实现
- **证据**：
  - 动作判别联合：`packages/envelope/src/v21.ts`:40-53（`OUTPUT_ACTION_TYPES`）、`:423-436`（`outputActionSchema`）、`:442-457`（`outputV21Schema`：`verdict` 可省、`evidence` 可选、`actions` 必填可空）；每类 payload 形状 `:244-420`。
  - 未知 type / 缺字段整份拒绝且可定位：`v21.ts`:523-547（先在 `/actions/N/type` 拦判别键，避免 `Invalid input`）、`:640-647`（zod 路径 → JSON Pointer）。
  - 顺序执行、遇失败即停、记录中断下标、已成功不回滚：`execute.ts`:431-448（`stoppedAt = index; break`）、`:249-257`（结果结构）。
  - 判定仅存档无副作用：`execute.ts`:497-507 `runVerdict` 只返回一句话；落库在 `run-task.ts`:1412-1419（`envelopes` 一行）。
  - 标签目标态 diff：`execute.ts`:515-559；评论槽位：`execute.ts`:589-684；reaction 幂等：`execute.ts`:710-756；开 PR 只允许 `bot/*`：`execute.ts`:802-808；关单前置 `verdict==='fail'`：`:838-850`。
  - 后三类默认关闭：`packages/contract/src/settings-v21.ts`:217-219（`z.boolean().default(false)`）、`execute.ts`:390-404（执行前整份拒绝 `action-disabled`）。
  - 槽位落地五条：`apps/server/src/writeback/v21/comments.ts`:53-55（隐藏 HTML 注释标记）、`:64-83`（解析）、`:161-176`（覆盖/新建/`recreated`）、`execute.ts`:651-672（404 → 重建并写「原评论已不存在」的 detail）。
- **缺口**：
  1. **动作集合超出需求的封闭七类**：需求行 978-986 与 1001 明写「七种之一，其他值一律拒绝」，代码是 12 类（`v21.ts`:40-53，多了 `reopen_issue`/`update_issue`/`update_comment`/`delete_comment`/`link`）。口径不一致，数字需对齐。
  2. **`create_issue` 的「指纹去重 + 日配额」在生产链路不生效**：执行器把闸门做成注入项（`execute.ts`:190-196、`:771-780`，未注入即 `decision='create'`），而两处装配都没注入 —— `apps/server/src/http/webhook-v21.ts`:696-709 与 `apps/server/src/app/compose.ts`:836-844 均未传 `createIssueGuard`，`run-task.ts`:1378-1391 的直连路径同样未传。全仓只有测试注入过。
  3. **关单「不采信模型自评」未落地**：准入条件就是模型产出的顶层 `verdict==='fail'`（`execute.ts`:846-850、`link(duplicate)` 同款 `:1035-1039`），没有任何确定性条件（复现命令/测试结果/门禁）参与判定。
- **判定依据**：前两条是需求明写的子条件缺失/口径相反，且都能指到装配缺参的具体行；第三条把「自评」当成了准入判据。其余子条件（校验三规则、槽位五条、四类默认开放、超限/空集保护、顺序执行）均有可核对的实现与具体断言测试（`apps/server/test/writeback-v21-execute.test.ts`:224-289、`writeback-v21-labels.test.ts`:54-83）。

### FR-5.4
- **状态**：已实现
- **证据**：
  - 目标态对齐 + 拥有删除权（含人手动打的标签）：`apps/server/src/writeback/v21/labels.ts`:135-200 —— `add = desired − current`、`remove = current ∩ 可管理目录 − desired`；`botLabels` 只参与归属判定（`:130-132`），不参与过滤，所以人打的标签同样会被删。
  - 边界①作用域仅项目标签目录：`labels.ts`:93-107（`not-in-catalog`/`retired`/`unmanaged`/`missing-meaning` 四类原因）、`:163-176`（`desired` 内有目录外即整条拒绝）。
  - 边界②空集保护：`labels.ts`:140-147（`desired` 空且 `clear!==true` → `empty-without-clear`）；契约侧 `clear` 许可字段 `v21.ts`:259-265。
  - 边界③超限整批拒绝不截断：`labels.ts`:150-156（`over-limit`），上限来自 `maxPerIssue`（`execute.ts`:524）。
  - 边界④删除留痕（人 / 机器）：`labels.ts`:130-132 `deletionOwner()`；`execute.ts`:532-536 逐条算 owner、`:562-574` 写进 `detail`（`删 [x/human]`），该 detail 进 `actions.audit`（`run-task.ts`:1435-1443）。
  - 边界⑤人工删除不构成永久否决：每轮从 `currentLabels` 现算（`execute.ts`:519-526 入参、`labels.ts`:179-197），代码里没有「曾被删除 → 不再管理」的状态表；显式契约走 BR-11 的 `managed=false`（`labels.ts`:100-102）。
- **缺口**：（无）
- **判定依据**：五条边界各有独立分支与错误码，且拒绝发生在写任何标签之前（`labels.ts` 先整批算 plan，`execute.ts`:528-530 不 ok 就抛，不留半套）。需求明写的「包含删除人手动打的标签」由「`botLabels` 不参与过滤」这一行代码直接支撑。

### FR-5.5
- **状态**：部分实现
- **证据**：
  - 顺序执行、失败即停、已成功不回滚、记录中断位置：`apps/server/src/writeback/v21/execute.ts`:6-9（语义声明）、`:431-448`（实现）。
  - 失败不静默：`run-task.ts`:1406-1477 —— 执行错误 → `envelopes.errors`（`:1412-1419`）+ `run_events('writeback.v21.result')`（`:1457-1469`）+ `signalFromParse`（`:1470-1477`）；逐条 `actions` 行带 `outcome/detail`（`:1421-1456`）。
  - 兜底反馈（旧路径）：`apps/server/src/worker/fallback.ts`:281-348 `postFallbackComment()` 只发一条 comment 并落 `actions` 行（失败也只留痕不抛）。
  - 不合并 PR：`apps/server/src/github/types.ts`:113 —— 写面「刻意不含 merge」；全仓无 merge 调用（`git/branch-cleanup.ts`:128 只用 `merge-base` 判祖先）。
  - 无产出时保持原状：`run-task.ts`:1168-1191（`rejected`/`not-v21` 不进执行分支）、`:1299`（`v21Handled && v21Plan !== null` 才执行）。
- **缺口**：
  1. **v2 路径没有兜底反馈**：`run-task.ts`:1243 的条件是 `if (!v21Handled && prepared !== null && ...)`，且 `:1241-1242` 明确写「v2 分支不发兜底评论」。于是 v2 产出被整份拒绝或执行中途失败时，issue 上**一个字都不会有**，人只能通过后台看到失败。
  2. **没有后台告警通道**：全仓无告警模块，失败只落 `logger.warn` + `run_events` + `actions` 行；需求写「至少有兜底反馈与后台告警」，前者在 v2 路径缺失、后者只有日志与事件流。
- **判定依据**：两条缺口都能指到具体行（条件表达式与缺失模块），不是「实现得不够漂亮」。「不合并 PR」「无产出保持原状」两条可判通过。

### FR-5.6
- **状态**：部分实现
- **证据**：
  - 阈值从窗口现算、不做配置项、两条线 90% / 硬边界：`apps/server/src/compact/thresholds.ts`:77-113（`hardLimit = 窗口 − 预留`、`autoLimit = 0.9 × hardLimit`、`reason: below|auto|hard`）、`:39-50`（魔数常量）；过硬边界不发请求：`engine.ts`:680-689。
  - 摘要覆盖切点前全部消息 + 六段结构 + 系统追加文件清单：`engine.ts`:479-488、`:531-547`（`buildSummaryPrompt(old)`）、`compact/summary.ts`:27-34（六段）、`:5-8`（原样保留路径/报错原文的提示词约束）、`engine.ts`:397-403 `withFileListNote`。
  - 追加 checkpoint 不改写历史：`compact/store.ts`:10、`:33-37`（只有 `INSERT`，无 UPDATE/DELETE）；视图从 checkpoint + 真实最近窗口重建：`engine.ts`:478-486、`:491-514`（返回 `view`）、`:512`。
  - 二次压缩增量、分块链式不拼接：`summary.ts`:74-79（`isIncremental`）、`engine.ts`:610-663（逐块把上一块摘要当 `previousSummary` 串下去，最终只取最后一块）。
  - 工具输出三层：`compact/truncate.ts`:26-31（2000 / 500）、`:59-82`、`engine.ts`:531-536（第一层 2000）、`:570-575`（第二层 500 + `dropThinking`）；剔除孤儿 toolResult：`truncate.ts`:130-147 + `engine.ts`:480。
  - 六步降级：`engine.ts`:447-467（预检）→ `:529-566`（3 次重试，退避 `:37-40` 2/4/8s，鉴权配额首次即返回 `:159-192`）→ `:568-607`（一次有界削减）→ `:610-663`（分块）→ `:669-678`（兜底 checkpoint）→ `:680-689`（拒发并记原因）。
  - 空摘要视为失败：`summary.ts`:38-46（`reason: 'empty' | 'missing-sections'`）+ `engine.ts`:556-559（解析失败继续降级）。
  - 可观测四项：`engine.ts`:57-66（记录字段：`beforeTokens/afterTokens/summaryChars/fallback/generation`）、`:491-502`（落库）。
- **缺口**：
  1. **没有生产调用方 → 自动压缩不生效**：`compactSession()` 只有测试调用；`apps/server/src/app/compose.ts`:880-881 注释写明「只暴露不调用」，`run-task.ts`:199-202 也把 `compactor` 声明为「只暴露、不自动调用」，`:933-935` 同样说明不做压缩。因此阈值判断、摘要、视图重建这些「实现」在实际链路里一次都不会跑。
  2. **「临近边界两档提醒、每档只响一次」全仓无实现**：`compact/` 与 `runtime/`、`worker/` 里没有任何提醒档位/去重标记的代码路径（搜不到对应导出与调用）。
  3. **后台标出压缩点无读取路径**：`agent_compactions` 只有写入与 `latestGeneration`（`compact/store.ts`:33-55），`apps/server/src/queries/` 无任何读取引用 → 面板无法标出「哪段历史已不在模型上下文里」。
- **判定依据**：单看 `compact/` 这套模块，绝大多数子条件都成立且有具体断言的测试（`compact-engine.test.ts`:125-392、`compact-thresholds.test.ts`、`compact-truncate.test.ts`）；但证据口径要求区分「存在」与「生效」——没有调用方就是没生效，因此不能判已实现。第 2、3 条是彻底缺失的子条件。

### TOOL-1
- **状态**：已实现
- **证据**：`packages/contract/src/issue-tools.ts`:73（`HOST_FILE_TOOLS = Read/Write/Edit/Glob/Grep`）、`:74`（`HOST_SHELL_TOOL='Bash'`）；路径限制在工作树内：`apps/server/src/runtime/approval-policy.ts`:275-287（`Write/Edit` 越界 deny）+ `:166-177`（`isPathInsideWorktree` 用 `resolve` 归一后比前缀）；`Bash` 经容器执行：`approval-policy.ts`:240-256（`sandboxed-bash`）。
- **缺口**：（无）
- **判定依据**：三段工具面各自的放行/拒绝分支与路径闸门都在生效链路上（`turn-driver.ts`:584-595 真实调用 `decideApproval`）。

### TOOL-2
- **状态**：部分实现
- **证据**：
  - 契约是唯一事实源：`packages/contract/src/issue-tools.ts`:127-284（`ISSUE_TOOLS` + `ISSUE_TOOL_NAMES` + `ISSUE_WRITE_TOOL_NAMES`）。
  - 审批矩阵派生：`approval-policy.ts`:264-273 用 `isIssueTool()` / `ISSUE_WRITE_TOOL_NAMES` 分流，不在策略里写字面量。
  - 技能 `allowed-tools` 枚举派生：`packages/contract/src/enums.ts`:232-240（`...ISSUE_TOOL_NAMES`），枚举外工具在加载期整份拒绝：`packages/contract/src/skills.ts`:112（`z.enum(SKILL_ALLOWED_TOOLS)`）。
  - 提示词工具目录派生：`apps/server/src/skills/prompt.ts`:490-521（`renderToolCatalog` 用 `ISSUE_TOOLS.filter(...)` + `HOST_TOOL_LINES`）、`:541-545`（`renderIssueCapabilityCatalog` 直接渲染 `ISSUE_TOOLS`）。
- **缺口**：**需求文档的表格没有从契约派生**：`docs/requirements.html`:1146 写「issue 工具集（16 个）」，表格（1152-1167）列 16 个；契约 `issue-tools.ts`:127-278 是 **19 个**（多 `IssueCommentReply`/`IssueReactionAdd`/`IssueReactionRemove`），`issue-tools.ts`:105 的注释也写 19。需求自己声明的「本表全部从它派生」这条不成立。
- **判定依据**：三处代码消费方全部派生、没有第二份字面量清单；失配只发生在文档侧，属于「同一份事实的渲染没同步」，不是代码里存在第二事实源。

### TOOL-3
- **状态**：已实现
- **证据**：需求表格列的 16 个在契约里逐个存在 —— `IssueGet`:128-134、`IssueList`:135-142、`IssueCommentsList`:143-151、`IssueTimeline`:152-159、`IssueSearch`:160-167、`IssueCreate`:168-175、`IssueUpdate`:176-184、`IssueClose`:185-193、`IssueReopen`:194-201、`IssueCommentCreate`:202-209、`IssueCommentUpdate`:218-224、`IssueCommentDelete`:225-231、`IssueLabelAdd`:249-255、`IssueLabelRemove`:256-262、`IssueLabelSet`:263-269、`IssueLink`:270-277。另有三条扩展：`IssueCommentReply`:210-217、`IssueReactionAdd`:232-240、`IssueReactionRemove`:241-248。只读那 5 个已真跑：`apps/server/src/runtime/issue-read-tools.ts`:36-38（从契约筛 read+search 组）、`run-task.ts`:1055-1082（预算 → 逐条执行 → 渲染进下一轮）。
- **缺口**：无缺项；唯一偏差是集合规模（19 > 16），与 TOOL-2 记录的文档失配同源。
- **判定依据**：需求点名的 16 个名字逐字存在且带 `required/optional` 形状；「每个生命周期环节都有专用工具」由分组字段 `issue-tools.ts`:79 与 19 条覆盖（12 个环节）满足。

### TOOL-4
- **状态**：已实现
- **证据**：前缀禁止 `packages/contract/src/issue-tools.ts`:33（`REMOVED_TOOL_PREFIXES = ['mcp__','plugin_']`）、`:46`（`REMOVED_TOOLS = ['new_context','Task','TodoWrite']`）、`:56-63`（`isRemovedTool` 前缀 + 精确、大小写不敏感）；审批一律 deny 且 rule 可区分：`apps/server/src/runtime/approval-policy.ts`:223-234（`removed-tool`，排在所有判定最前）；不在 `allowed-tools` 枚举：`packages/contract/src/enums.ts`:232-240（只含宿主五个 + `Bash` + `ISSUE_TOOL_NAMES`），写进 frontmatter 会在 `packages/contract/src/skills.ts`:112 整份被拒。
- **缺口**：（无）
- **判定依据**：前缀匹配是唯一的「闭合」写法，代码用的就是前缀；三处（枚举、审批、加载期校验）互相兜住。

### TOOL-5
- **状态**：已实现
- **证据**：判据 `packages/contract/src/issue-tools.ts`:338-351（`gh issue` / `gh pr` / `gh api` / `gh search` / `curl|wget|xh|http … api.github.com` / GraphQL 直连）+ `:359-366`（`findShellIssueViolation` 返回命中片段）；审批层调用并 deny + 留审计：`apps/server/src/runtime/approval-policy.ts`:240-256（`shell-issue-operation`，理由里带命中片段）；审计落库：`apps/server/src/worker/run-task.ts`:979-982（`approval.audit` 进 `run_events`）。
- **缺口**：（无）
- **判定依据**：拒绝发生在放行 `Bash` 之前，且 `rule` 单独一档（面板可分「命令里有 issue 操作」与「未知工具」）；审计走的是每次判定都产出条目的同一条路。

### TOOL-6
- **状态**：已实现
- **证据**：工具产出的仍是标准动作 —— 契约把这条写成硬约束并给出映射：`issue-tools.ts`:82-89、`:297-300`（写类清单）；平台侧执行仍过项目动作开关（`writeback/v21/execute.ts`:390-404 执行前整份拒绝 `action-disabled`）与逐条审计（`run-task.ts`:1421-1456 每条动作一行 `actions`，`audit` 含 `source:'v21'`/`index`/`type`/`outcome`/`detail`）；文件写回闸门只作用于 push 路径：`git/run-git.ts`:85-111（强推令牌一律拒绝）、`:212`（每次调用都校验）—— v2 没有任何 push 动作，`open_pr` 只从已有分支开 PR（`execute.ts`:817-823）。
- **缺口**：（无）
- **判定依据**：模型侧工具没有把参数转成 HTTP 的代码路径，写只发生在一个入口（`executeV21`），且该项目里更硬的 git 侧约束（禁强推）也在。

### TOOL-7
- **状态**：已实现
- **证据**：读操作走平台代理、token 不进沙箱：`apps/server/src/runtime/issue-read-tools.ts`:87-120（执行器只依赖 `GithubIssueReadApi` 这个 type-only 端口，`repo` 由平台绑定、模型不给 `repo`），装配在宿主进程里：`apps/server/src/app/compose.ts`:1417 `createIssueReadExecutor(v21IssueRead, {}, { repo: row.repo })`；只读白名单：`issue-read-tools.ts`:36-38、`:99-110`（未知工具 → `unknown-tool` 回给模型）；可审计：`run-task.ts`:1068-1080（每条读调用一行 `issue.tool.read`）。
- **缺口**：（无）
- **判定依据**：端口是只读五工具（`read`/`search` 组），没有写方法可调；凭证留在宿主侧（沙箱里没有任何 GitHub 凭证的传递路径）。

### TOOL-8
- **状态**：已实现
- **证据**：标记与派生函数 `packages/contract/src/issue-tools.ts`:383（`EXECUTE_CHANNEL_AVAILABLE = false`）、`:391-393`（`issueToolAvailability()`）；提示词据此换措辞且**不**宣称可直接调用工具名：`apps/server/src/skills/prompt.ts`:476-487（`callable` → 「已注册到本次会话」；否则 → 「由平台代你执行」）。
- **缺口**：（无）
- **判定依据**：常量只有一处，措辞分支只有一处，且分支真的读了这个常量（不是死字段）；`prompt.ts`:458 的 `tool_calls` 写法段也只描述「交 `tool_calls`」，与通道不可用时的语义一致。

## 本节整体结论

5.5 的骨架是完整的：提示词驱动（FR-5.1）、封闭动作集合与校验/执行语义（FR-5.3 主体）、标签目标态五条边界（FR-5.4）、工具面三段与四条工具约束（TOOL-1/4/5/7/8）都能指到具体实现行，且有断言具体的单测。因此**不能判「本节已实现」**，原因是四处「存在但不生效/缺失」：压缩引擎整体没有生产调用方（FR-5.6）、`create_issue` 的指纹与配额闸门在生产装配里未注入（FR-5.3）、v2 路径不发兜底反馈且没有告警通道（FR-5.5）、只读工具调用缺入参与返回留痕（FR-5.2）。另有两处口径失配需要与文档对齐：动作集合 7 类 vs 12 类、需求表格 16 个工具 vs 契约 19 个。

## 核查边界

- 是否执行了命令：**未执行任何测试或构建命令**（纯静态核查）。文中的「有测试」只声明「测试存在且断言具体」——例如 `apps/server/test/writeback-v21-execute.test.ts`:224-289 断言 `stoppedAt` 为中断下标、开关全关时一条都不执行且错误含 `action-disabled`；`writeback-v21-labels.test.ts`:54-83 断言 `empty-without-clear`。**没有**声明这些测试跑过且绿。
- 未覆盖的条目及原因：无条目被跳过；但以下子条件**无法纯静态判定**，需运行环境：
  1. 「宿主文件工具路径限制在工作树内」的最终强度依赖 host-core 的 `PATH_OUTSIDE_WORKSPACE`（`approval-policy.ts`:27-32 自述这是第二道），本仓只能看到自己这一道。
  2. 真实 host 是否把「工具名 + 入参 + 返回」完整放进 `item.completed` payload（决定 FR-5.2 宿主工具那条链路的覆盖度），需要真 pi-host 事件流才能确认。
  3. `issueToolAvailability()` 切到 `callable` 之后的行为需要 RACP `tools/advertise` + tool relay，本仓无该通道。
- 发现的额外问题（不属本节范围但值得记录）：
  1. `comment_slots` 表（`apps/server/src/db/schema.ts`:765-782）只有建表与索引，全仓无读写实现；`V21SlotStore` 也从未在生产装配注入（`compose.ts`:836-844、`webhook-v21.ts`:696-709）。当前靠「列评论按标记找」兜底，语义一致，但那张表是死表，且每次覆盖多一次 `listIssueComments`。
  2. `agent_compactions` 的 `compactionRecordOfEvent`（`run-task.ts`:419-452）与 `compactionRecordOf`（`webhook-v21.ts`:728-752）是两份同义实现，前者还宽松认 `type:'compaction'`；两份都在用（`run-task.ts`:946-970 二选一），语义漂移会写进同一张表。
  3. 「不合并 PR」目前只有一条依据：`apps/server/src/github/types.ts`:113 的写面形状与注释（该层不含 merge）。注释属于自述，真正兜底的应是 `apps/server/test/no-merge.test.ts` 的扫描断言 —— 该文件我没逐行读，建议单独核一次它扫的范围（是否覆盖 `github/` 之外）。
