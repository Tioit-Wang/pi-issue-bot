# U8-A 核查报告：§5.5「执行侧可用工具」+ §6.7「agent 系统提示词与执行限额」

- 需求正文：`C:\Code\NodeProjects\pi-issue-bot\docs\requirements.html`（行 1133-1186 / 行 1707-1739）
- 核查方式：逐条读代码 + 跑针对性单测；**只读**，未改仓库文件（工作区里已有的他人改动未被触碰）
- 结论记号：已实现 / 部分实现 / 未实现 / 与需求冲突 / 无法判定

---

## A 段（§5.5 末尾 · 行 1133-1186）

### A1 工具面分三段（文件 / 执行 / issue 工具集）

**状态：已实现**

证据：
- 契约定义三段：`packages/contract/src/issue-tools.ts:73` `HOST_FILE_TOOLS = ['Read','Write','Edit','Glob','Grep']`、`:74` `HOST_SHELL_TOOL = 'Bash'`、`:127` `ISSUE_TOOLS`。
- 审批矩阵按三段分别判定：`apps/server/src/runtime/approval-policy.ts:49`（只读）、`:51`（`Bash` 沙箱内）、`:53`（写类）、`:264`（issue 工具集）。
- 路径限制在工作树内：`approval-policy.ts:275-287` 逐个文件写工具校验目标路径，`:166-177` `isPathInsideWorktree()` 做 `resolve` 归一化 + `root+sep` 前缀比较（`:164` 注释点明 `/jobs/1` 与 `/jobs/10` 的坑）。`Read/Glob/Grep` 的边界由 host-core 的 session root 兜底（`:14`、`:27-30` 注释写明「本函数是第二道」）。

缺口：无（`Read/Glob/Grep` 的路径约束依赖 host-core，本仓只能声明并做第二道；这是已写明的边界，不是缺口）。

### A2 清单唯一事实源 = `packages/contract/src/issue-tools.ts`，四处从它派生

**状态：已实现**（文档表格是唯一例外，见 A3 缺口）

- 契约（唯一事实源）：`issue-tools.ts:127` `ISSUE_TOOLS`、`:284` `ISSUE_TOOL_NAMES`、`:298` `ISSUE_WRITE_TOOL_NAMES`、`:33` `REMOVED_TOOL_PREFIXES`、`:46` `REMOVED_TOOLS`、`:56` `isRemovedTool()`、`:338` `SHELL_ISSUE_DENY_PATTERNS`、`:359` `findShellIssueViolation()`、`:383` `EXECUTE_CHANNEL_AVAILABLE`。
- ① 审批矩阵派生：`approval-policy.ts:37-42` 只 import 契约的 `findShellIssueViolation / isIssueTool / isRemovedTool / ISSUE_WRITE_TOOL_NAMES`，文件里没有第二份工具名清单（`:24-25` 注释说明理由）。
- ② 技能 `allowed-tools` 枚举派生：`packages/contract/src/enums.ts:232-240` `SKILL_ALLOWED_TOOLS = ['Read','Write','Edit','Glob','Grep','Bash', ...ISSUE_TOOL_NAMES]`（展开而非另抄）。
- ③ 提示词工具目录派生：`apps/server/src/skills/prompt.ts:20-25` 从契约取 `ISSUE_TOOLS / ISSUE_TOOL_GROUPS / ISSUE_TOOL_USAGE_NOTES / issueToolAvailability`；`:428-448` 按分组渲染、`:490-511` `renderToolCatalog()`、`:535-545` `renderIssueCapabilityCatalog()`；宿主工具说明只写在 `:310-317` 的 `HOST_TOOL_LINES` 里（渲染层，不是名字的事实源）。
- ④ 文档表格**没有**派生：`docs/requirements.html:1136-1170` 是手写 HTML 表，见 A3。

### A3 16 个 issue 工具逐个存在？

**状态：已实现（并超出 3 个）；但与需求文档冲突（文档仍是 16）**

16 个逐个都有，行号（`issue-tools.ts`）：
`IssueGet:129`、`IssueList:136`、`IssueCommentsList:144`、`IssueTimeline:153`、`IssueSearch:161`、`IssueCreate:169`、`IssueUpdate:177`、`IssueClose:186`、`IssueReopen:195`、`IssueCommentCreate:203`、`IssueCommentUpdate:219`、`IssueCommentDelete:226`、`IssueLabelAdd:250`、`IssueLabelRemove:257`、`IssueLabelSet:264`、`IssueLink:271`。

缺哪几个：**一个都不缺**。

超出（代码有、需求 §5.5 表格没有）3 个：`IssueCommentReply:211`、`IssueReactionAdd:233`、`IssueReactionRemove:242` → 契约总计 **19**，代码自己也这么写（`issue-tools.ts:105` 注释「19 个工具」、`enums.ts:226`「19 个」）。
- 文档口径相反：`requirements.html:1146`「issue 工具集（16 个…）」、`:1185`「所以现在这 16 个工具以『平台代执行』的形式生效」。
- 单测把 19 当现状钉住：`packages/contract/test/issue-tools.test.ts:93-94` 断言 `IssueReactionAdd/Remove` 存在、`:121` 断言写类 14 个。
- **缺口**：需求正文表格滞后于代码 3 项（回复评论 / 加表情 / 撤表情），按 AGENTS.md §1「文档与代码冲突时先核实代码，再同批修文档」，应补进 §5.5 表格。

### A4 已移除工具：`mcp__*` / `plugin_*` 前缀禁止 + `new_context` / `Task` / `TodoWrite` 不在枚举

**状态：已实现**

- 前缀禁止是真前缀：`issue-tools.ts:33` `REMOVED_TOOL_PREFIXES = ['mcp__','plugin_']`；`:56-63` `isRemovedTool()` 先 `trim().toLowerCase()`，再精确匹配 3 个名字、再 `startsWith(prefix)`。测试覆盖任意后缀：`test/issue-tools.test.ts:42-45`（`mcp__anything`、`plugin_whatever` 都为 true）。
- 审批层 deny + 留审计：`approval-policy.ts:228-234`（排在所有判定之前，含 allow 路径），rule 为 `removed-tool`（`:74`），审计条目结构 `:81-100`，实际落库为 `run_events`：`apps/server/src/worker/run-task.ts:979-981` `appendEvent('approval.audit', audit)`。
- 枚举里确实没有三者：`enums.ts:232-240` 是 6 个宿主工具 + issue 工具展开，不含 `new_context/Task/TodoWrite`；技能 frontmatter 用 `z.enum(SKILL_ALLOWED_TOOLS)` 校验（`packages/contract/src/skills.ts:112`、`:140`），枚举外名字在加载期报错——测试 `apps/server/test/skills-bundle.test.ts:213-219`（`WebFetch` → 「allowed-tools 不合规」），`:61-63`+`test/issue-tools.test.ts:61-63` 断言枚举里没有任何移除项。
- 提示词不渲染：`prompt.ts:310-317` 白名单映射 + 测试 `apps/server/test/skills-prompt.test.ts:342-348`。

实现细节差异（不算缺口，需知道）：**前缀匹配只在审批层**；技能声明层是白名单枚举，动态名字根本表达不出来，等效闭合。

### A5 `Bash` 里 `gh issue` / `gh pr` / `gh api` / `gh search` / `api.github.com` 一律 deny 且留审计

**状态：已实现**

- 判据：`issue-tools.ts:338-351` 六条正则（`gh issue`、`gh pr`、`gh api`、`gh search`、`curl|wget|xh|http ... api.github.com`、`api.github.com/(graphql|repos)`），`:359-366` `findShellIssueViolation()` 返回命中片段（拒绝理由可读）。
- 放行 `Bash` 前调用：`approval-policy.ts:240-256`，命中即 `deny` + rule `shell-issue-operation`（`:72`）+ 理由点名「必须走 Issue* 工具集」；审计同样经 `run-task.ts:981` 落 `run_events`。
- 测试：`apps/server/test/runtime-approval-policy.test.ts:136`（`gh` → deny）、`:145`（直接打 GitHub API → deny）、`:153`（跑测试仍 allow）；契约侧 `test/issue-tools.test.ts:180-206`（四条 gh 子命令 + curl/wget + 大小写变体 + 正常命令不误伤）。

缺口（已知边界，代码自己写了）：正则匹配文本，`$(echo gh) issue` 这类拼接能绕过——`approval-policy.ts:31-32` 说明该路径已在容器内、无凭证、写不回去。

### A6 写操作只有一条路（工具产出标准动作 → 平台执行 → 闸门 → 审计）

**状态：已实现**（未逐行核验 `writeback/v21/execute.ts` 的完整闸门，只核验到入口与开关）

- 工具声明写明「`write:true` 不改变写回只有一条路」，产出仍是信封 intent：`issue-tools.ts:82-102`（`:85-88` 注释）。
- 工具 → 动作形状的映射渲染进提示词：`prompt.ts:345-415` `ISSUE_ACTION_SHAPES`（`label/comment/reaction/create_issue/close_issue/reopen_issue/update_issue/update_comment/delete_comment/link/open_pr/verdict`）；一致性由 `skills-prompt.test.ts` 盯（`prompt.ts:342-343` 注释）。
- 项目动作开关：`packages/contract/src/settings-v21.ts:241-242`、resolver `apps/server/src/config/v21-settings.ts:213-217`、消费点 `apps/server/src/http/webhook-v21.ts:684-701`（`actionsEnabled`）与 `apps/server/src/worker/run-task.ts:1316-1325`。
- 写回闸门本身在 `apps/server/src/writeback/`（`v21/execute.ts:181` 注释：动作开关来源）——属 §5.4 范围，本次只确认「写类工具不是旁路」。

### A7 读操作：走平台代理（App 凭证，token 不进沙箱）+ 只读可审计

**状态：已实现**

- 平台代理：`apps/server/src/app/compose.ts:810-811` `createGithubIssueReadApi(baseGithubClient)`（宿主进程的 App 客户端）；`compose.ts:1413-1419` 注入执行器并把 `repo` 绑死（`:1410-1412` 注释：模型的 `tool_calls` 里没有 `repo`）。凭证只在宿主，容器内不出现。
- 只读集合从契约筛：`apps/server/src/runtime/issue-read-tools.ts:36-38`（`group==='read'||'search'`），未知工具名回 `unknown-tool` 不崩：`:99-110`。
- 每次调用可审计：`run-task.ts:1068-1080` 每条读调用 `appendEvent('issue.tool.read', {name, ok, items, summary, errorCode})`；轮次汇总 `:1083-1087` `tool.round`。注释 `:1071-1072` 明确「读调用不进 `actions` 表，但每条要能在 `run_events` 里查到」。
- 预算与围栏：`apps/server/src/runtime/issue-tool-loop.ts:31-36`（3 轮 / 6 次 / 6000 字符）、`:55-62` 围栏头、`:131-165` 按字符预算在条目边界截断（围栏放不下就整段不发）。
- 测试：`apps/server/test/issue-read-tools.test.ts`、`issue-tool-loop.test.ts`、`worker-run-task-tool-loop.test.ts`。

### A8 「当前的落地状态」callout：`EXECUTE_CHANNEL_AVAILABLE` 存在且提示词按它选措辞

**状态：已实现**

- 常量：`issue-tools.ts:383` `EXECUTE_CHANNEL_AVAILABLE = false`；投影函数 `:391-393` `issueToolAvailability()`。
- 措辞切换：`prompt.ts:481-487`，`'callable'` 才说「已注册到本次会话，直接按上面的形状调用」，否则说「由**平台代你执行**」。
- 通道确实没通（可核对）：`packages/racp-client/src/ops.ts:5-7` 明确把 `tools/advertise`、`workspace/toolExecute` 列在「不用」表外，全仓无实现。
- 提示词没有宣称「可直接调用工具名」：读能力改为 `tool_calls` 信封写法（`prompt.ts:454-464`），并在 `:486` 重申 `gh` 会被拒。
- 残留观感差异：`prompt.ts:435` 仍以 `IssueGet(number)` 形式渲染签名——那是「调用形状说明」，不是「已注入」的声明，与 callout 要求一致。

---

## B 段（§6.7 · 行 1707-1739）

### B1 系统提示词：常驻角色设定、每次调用都带、项目级、未配置用内置默认

**状态：部分实现**

- 项目级字段：`packages/contract/src/settings-v21.ts:233-234`（`system_prompt`，注释「每次调用都带、不参与压缩；空串 = 用内置默认」）；`packages/contract/src/repo-config.ts:184`（`settings.agent.system_prompt`，`:178-183` 说明与 `limits.system_prompt` 同为两条路径）。
- 裁决唯一：`apps/server/src/config/v21-settings.ts:200-222`（`agent.system_prompt` 非空优先 → 否则 `limits.system_prompt` → 空则 `AGENT_IDENTITY_PROMPT`）。
- 内置默认：`apps/server/src/skills/prompt.ts:56-72`（`AGENT_IDENTITY_PROMPT`，注释写明「唯一一份身份 + 工作方式说明」）。
- 投递链路：`compose.ts:1407` → `run-task.ts:838,916` → `apps/server/src/runtime/turn-driver.ts:383-386`（`session/create` 的 `systemPrompt`）。
- 测试：`apps/server/test/v21-settings.test.ts:163-221`、`apps/server/test/runtime-turn-driver.test.ts:262-301`。
- **缺口**：`turn-driver.ts:111` 注释与 `:383-386` 实现都表明 `systemPrompt` **只在新建会话时**发送，`session/attach` 与后续 turn 不带。需求表格写「每次调用都携带」（`requirements.html:1717`）。因为会话按 issue 常驻，效果上「每个会话一次」；但字面口径不一致，需二者之一对齐（turn 也带，或改文档为「每会话携带」）。

### B2 并发数（同项目同时最多几个会话在跑；触顶排队不丢弃）

**状态：部分实现**

- 需求字段存在但**无消费方**：`settings-v21.ts:236` `concurrency`（默认 2）→ `v21-settings.ts:210` 只是把它读进 `ResolvedAgentExecution`；全仓除 resolver 与测试外没有任何读取点（`grep concurrency` 已核）。
- 真正生效的是另一套（v0.3 字段）：`packages/contract/src/repo-config.ts:135` `limits.concurrency_per_repo`（默认 2）→ `apps/server/src/queue/repo-concurrency.ts:30-42` `concurrencyPerRepoOf()` → `compose.ts:1507-1515` 作为 gate 注入 → `apps/server/src/queue/boss.ts:184-234` `RepoConcurrencyLimiter` 在 pg-boss worker 上收住「同仓库同时 N 个」。装配级测试：`apps/server/test/app-wiring.test.ts:327`（同仓库串行、跨仓库并行）。
- 排队而非丢弃：任务进 pg-boss 队列（`queue/definitions.ts:94` `run-task.concurrency: 3` 全局），超限等待。
- **张力（需产品确认，非纯代码缺陷）**：`repo-config.ts:137` `queue_wait_minutes`（默认 10）会把排队超时任务置 `cancelled_queue`（`apps/server/src/queue/queue-gate.ts:92-105`、`:129-148`；定时侧 `apps/server/src/jobs/queue-gate.ts`）。这与「触顶排队等待，**不丢弃**」（`requirements.html:1733`）在字面上冲突：等 10 分钟就被取消。
- **缺口**：`agent.limits.concurrency` 是死配置；同语义能力由 `limits.concurrency_per_repo` 承担，字段名与需求/面板入口不一致。

### B3 日配额（每天最多处理多少个事件；触顶拒绝处理并记录原因可查）

**状态：未实现**

- 字段存在、被 resolver 读出，但**无任何消费方**：`settings-v21.ts:237-238` → `v21-settings.ts:211`；全仓除 resolver/测试外无读取点。
- 计数表存在但**无读写代码**：`apps/server/src/db/schema.ts:633-645` `quota_counters(repo, kind, window_start, count)`——`grep quotaCounters` 只命中 schema 与 `test/db-schema.test.ts`、`test/helpers/queries-db.ts`。没有任何函数 UPSERT 或读取它（`grep 'create_issue:day'` 只命中 schema 注释）。
- 拒绝路径存在但**没有生产者**：`apps/server/src/trigger/decide.ts:41`（`SkippedReason` 含 `'daily-quota'`）、`:251-252`（`dailyQuotaExceeded===true → skip('daily-quota')`）；`apps/server/src/http/webhook-v21.ts:118,155` 只把这个标志**透传**为可选字段，`grep 'dailyQuotaExceeded\s*[:=]'` 找不到任何计算赋值处。测试 `test/trigger-decide.test.ts:388` 是注入式断言，不能证明链路上有生产者。
- 唯一的配额执行是「建 issue 日配额」，与 §6.7「处理事件数」不是同一件事：`apps/server/src/github/executor.ts:44` `DEFAULT_DAILY_ISSUE_QUOTA = 10`、`:384-395`（`quota_exceeded` → 写待办而不建）；但其输入 `createdToday` 来自 `apps/server/src/worker/types.ts:259`（可选）、由 `apps/server/src/worker/writeback.ts:445` 读 `context.target.createdToday ?? 0`，而装配侧 target 端口只提供 `{ pool, currentLabels }`（`compose.ts:1427`）→ **恒为 0**，配额实际永不触发。
- **缺口**：§6.7 的日配额（按事件、按项目、触顶拒绝且原因可查）整条链缺失：无计数写入、无阈值比较、无 `tasks` 拒绝落库。

### B4 单轮超时（一轮执行最长时长；触顶终止记超时、不自动重试）

**状态：部分实现**（物理闸与不重试都成立；项目级配置不生效）

- 闸：`apps/server/src/runtime/turn-driver.ts:35` `DEFAULT_TURN_TIMEOUT_MS = 20min`、`:37` `REVIEW_PR_TURN_TIMEOUT_MS = 30min`；取闸 `run-task.ts:458-463` `timeoutMsForCommand()`，装配 `compose.ts:1389`，使用 `run-task.ts:575`、`:716-721`（`runWithDeadline`）、`:840` 任务级 deadline、`:854-856`（工具轮不再起新一轮并记 `tool.deadline-exceeded`）、`:928`（每轮拿剩余时间）。
- 结局：`run-task.ts:505-519` → `timed-out`；`:487-488` → `tasks.status = timed-out`。
- 不自动重试：`apps/server/src/queue/retry-policy.ts:124-125`（`timeout → noRetry('任务级超时：只接受人工 /retry')`）；`run-task.ts:19` 注释同口径。
- **缺口**：`settings-v21.ts:240` `turn_timeout_minutes`（默认 20，1–30）**从未被消费**（`grep turn_timeout_minutes` 仅 resolver 与测试）；旧字段 `repo-config.ts:133` `max_task_minutes` 同样没被消费（仅测试/面板 mock）。所以「项目级可配」不成立，实际恒为 20（`/review-pr` 30）分钟——数值上与契约默认相同，容易误判为已生效。

### B5 不设平台级业务限流

**状态：已实现**

- 平台侧只有部署级并发常量：`apps/server/src/queue/definitions.ts:94` `run-task.concurrency: 3`、其余队列 1（`:103-153`），以及部署层阈值校验 `:342-343`。
- 业务阈值全部落在项目级：`repo-config.ts:126-138`（`max_comments_per_hour` / `max_actions_per_run` / `max_task_minutes` / `concurrency_per_repo` / `queue_wait_minutes`）、`settings-v21.ts:233-244`（`agent.limits`）。
- 没有全局限流器/令牌桶之类实现（`grep` 未见 rate-limit 全局门）。

---

## 验证命令与结果

```
cd packages\contract; npx vitest run test/issue-tools.test.ts
  → 1 file passed, 16 tests passed
cd apps\server; npx vitest run test/runtime-approval-policy.test.ts test/issue-read-tools.test.ts test/issue-tool-loop.test.ts
  → 3 files passed, 60 tests passed (21 + 21 + 18)
```

未跑：`pnpm -r typecheck`、`pnpm lint`、全量 `pnpm -r test`（本次是文档核查，只读；且工作区有他人未提交改动，全量门禁结果不能归因于本次结论）。

---

## 本节整体结论

**A 段（§5.5 执行侧可用工具）：基本落地，可用。** 三段工具面、契约唯一事实源、审批矩阵/技能枚举/提示词目录三处派生、`mcp__*`/`plugin_*` 前缀禁止 + 精确移除项 deny 并留 `approval.audit`、`Bash` 的 `gh issue|pr|api|search` 与 `api.github.com` deny 且理由可读、读操作走宿主 App 凭证代理并按次落 `issue.tool.read`、`EXECUTE_CHANNEL_AVAILABLE=false` 且提示词据此改口——逐条有代码与测试支撑。
A 段唯一实质问题是**文档滞后**：契约现有 19 个 issue 工具（多 `IssueCommentReply` / `IssueReactionAdd` / `IssueReactionRemove`），需求表格与 callout 仍写 16 个，且 §5.5 表格没有任何一处提到表情与回复评论——属「代码是事实源、文档需同批更新」的情形。

**B 段（§6.7）：系统提示词可用，三项限额只有两项有实现路径，且都不是按需求的字段生效。**
- 系统提示词：项目级 + 内置默认 + 走 `session/create` 的 system 通道，成立；但只在新建会话时携带，与「每次调用都带」的字面口径不一致。
- 并发数：能力成立，但生效字段是 v0.3 的 `limits.concurrency_per_repo`，§6.7 的 `agent.limits.concurrency` 是死配置；且 `queue_wait_minutes` 到点把排队任务置 `cancelled_queue`，与「排队不丢弃」冲突，需产品裁决。
- 单轮超时：闸与「不重试」都成立，但 `turn_timeout_minutes` 从未被消费，实际固定 20/30 分钟。
- 日配额：**未实现**——字段无消费方、`quota_counters` 表无读写、`daily-quota` skip 分支无生产者、唯一的 `create_issue` 配额因 `createdToday` 恒为 0 而不可能触发。

优先级建议（按需求优先级排序）：① 日配额补计数器 + 阈值门 + 拒绝落库；② `turn_timeout_minutes` 接入 `timeoutForCommand`（或删字段并改文档）；③ 并发字段二选一（把 `agent.limits.concurrency` 接到 gate，或从 §6.7 删掉并指向 `concurrency_per_repo`）；④ 需求 §5.5 表格补齐 `IssueCommentReply` / `IssueReaction*` 并改 16→19；⑤ 系统提示词「每次调用」口径对齐。
