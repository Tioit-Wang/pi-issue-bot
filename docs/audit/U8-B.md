# U8-B 需求实现核查（反证视角）

- 需求文档：`C:\Code\NodeProjects\pi-issue-bot\docs\requirements.html`
- 审查范围：行 1133-1186「执行侧可用工具」；行 1707-1739「6.7 系统提示词与执行限额」
- 仓库：`C:\Code\NodeProjects\pi-issue-bot`（HEAD 工作区，含未提交改动；本次只读）
- 实际执行过的验证命令（均通过，作为「代码证据」的一部分，不作为唯一依据）：
  - `pnpm --filter @pi-issue-bot/contract test` → 6 文件 / 142 用例通过（含 `test/issue-tools.test.ts` 16 用例）
  - `npx vitest run test/runtime-approval-policy.test.ts test/skills-prompt.test.ts test/agent-skill-wiring.test.ts`（apps/server）→ 3 文件 / 51 用例通过

方法：对每条需求先假设「没真正实现」，再找能推翻它的**可执行代码路径**（不是注释、不是文档、不是测试里的假件）。注释与文档只用来解释代码为什么这样写，不用来证明实现。

---

## A) 行 1133-1186 执行侧可用工具

### A1 三段工具面 + 文件工具路径限制在工作树内 —— **已实现**

反证过程：假设文件工具没有路径限制。查审批层 `apps/server/src/runtime/approval-policy.ts`：

- `READ_ONLY_TOOLS = ['Read','Glob','Grep']`（:49）→ 无条件 allow，理由写明「路径已由 host-core 限制在 session root」（:236-238）。
- `WRITE_TOOLS = ['Write','Edit']`（:53）→ 必须给目标路径且 `isPathInsideWorktree()` 为真才 allow（:275-287），`path.resolve` 归一化 + `root + sep` 前缀比较（:166-177），越界写 `write-outside-worktree` deny。
- 三段里的 `Bash` 走 `SANDBOXED_TOOLS`（:51）。

结论：文件工具、命令工具、issue 工具集三段都在审批矩阵里有对应行；路径限制有真实判定函数，不是注释。

缺口：无（越界写有 deny 用例覆盖，`runtime-approval-policy.test.ts` 21 用例通过）。

### A2 `Bash` 不得做 issue 操作：gh issue / gh pr / gh api / gh search / api.github.com → deny + 审计 —— **已实现**

反证过程：假设只有文档写了这条。证据链三段齐：

1. 判据函数：`packages/contract/src/issue-tools.ts:338-351` `SHELL_ISSUE_DENY_PATTERNS`，含 `\bgh\s+issue\b`、`\bgh\s+pr\b`、`\bgh\s+api\b`、`\bgh\s+search\b`、`(curl|wget|xh|http)...api\.github\.com`、`api\.github\.com/(graphql|repos)`；`findShellIssueViolation()` 返回命中片段（:359-366）。
2. 审批层真调用：`approval-policy.ts:246-254`，命中即 `deny` + `rule: 'shell-issue-operation'` + 理由带命中片段。
3. 运行时真接线：`runtime/turn-driver.ts:578-598` —— `approval.requested` 事件里调 `decideApproval()`，`params.onAudit?.(decision.audit)` 落审计，`approvalRespond(racpDecisionFor(...))` 把 deny 回给宿主。所有 allow/deny 都产审计条目（纯函数设计，:194-221）。
4. 负向证据：`runtime-approval-policy.test.ts` 有针对 `mcp__`/`plugin_`/`Task` 等的 deny 断言，`issue-tools.test.ts:180-190` 断言七种 gh 命令命中。

缺口（边界已知，非缺陷）：正则匹配命令文本，`$(echo gh) issue` 之类拼接可绕过；代码在 `approval-policy.ts:31-32` 明确写了这个边界与为什么可接受（容器内无 GitHub 凭证、写回只能走闸门）。

### A3 16 个 issue 工具逐个存在 —— **已实现（但是超集：实际 19 个，与需求/文档冲突）**

反证过程：假设少一个。逐个对照 `packages/contract/src/issue-tools.ts:127-278`：

需求点名的 16 个**全部存在**：IssueGet(:129)、IssueList(:136)、IssueCommentsList(:144)、IssueTimeline(:153)、IssueSearch(:161)、IssueCreate(:169)、IssueUpdate(:177)、IssueClose(:186)、IssueReopen(:195)、IssueCommentCreate(:203)、IssueCommentUpdate(:219)、IssueCommentDelete(:226)、IssueLabelAdd(:250)、IssueLabelRemove(:257)、IssueLabelSet(:264)、IssueLink(:271)。**无缺项**。

但契约里还有 3 个需求 §5.5 与文档表格都没有的工具：
`IssueCommentReply`（:211）、`IssueReactionAdd`（:233）、`IssueReactionRemove`（:242）→ 共 **19 个**（`enums.ts:226` 注释也自述 19 个；`issue-tools.test.ts:120-121` 断言写类 14 个 = 19 - 5 读）。

即：需求 1146 行写「issue 工具集（16 个）」、1152-1167 行的表格逐行列出 16 个，代码是 19 个 —— **文档与唯一事实源不一致**，且方向是「代码多、文档少」。

### A4 「清单唯一事实源是 issue-tools.ts，审批矩阵/技能 allowed-tools/提示词工具目录/文档表格全部从它派生」 —— **部分实现**

反证过程：分四路查「谁真的 import 了契约」。

- **issue 工具名（派生 ✔）**：
  - 审批矩阵：`approval-policy.ts:38-41` import `isIssueTool` / `ISSUE_WRITE_TOOL_NAMES` / `isRemovedTool` / `findShellIssueViolation`，判定在 :264-273。
  - 技能枚举：`packages/contract/src/enums.ts:232-240` `SKILL_ALLOWED_TOOLS = [...宿主 6 个字面量, ...ISSUE_TOOL_NAMES]`。
  - 提示词目录：`apps/server/src/skills/prompt.ts:20-25` import `ISSUE_TOOLS` / `ISSUE_TOOL_USAGE_NOTES` / `issueToolAvailability`，`renderToolCatalog()` :500-511 按 `ISSUE_TOOLS.filter(...)` 渲染，`renderIssueCapabilityCatalog()` :541-544 直接渲染全部。
  - 只读执行面：`runtime/issue-read-tools.ts:36-38` 按 `tool.group` 从 `ISSUE_TOOLS` 筛。
- **宿主文件/命令工具（未派生 ✘）**：契约导出了 `HOST_FILE_TOOLS` / `HOST_SHELL_TOOL`（`issue-tools.ts:73-74`），但全仓 grep 显示**只有 contract 自己的测试引用它们**（`packages/contract/test/issue-tools.test.ts:15-16,55`），`apps/server/src` 零引用。真实清单有三份手写副本：
  - `approval-policy.ts:49-53`：`READ_ONLY_TOOLS` / `SANDBOXED_TOOLS` / `WRITE_TOOLS` 三个字面量数组；
  - `skills/prompt.ts:310-317`：`HOST_TOOL_LINES` 的 6 个键；
  - `enums.ts:232-240`：`SKILL_ALLOWED_TOOLS` 前 6 个字面量。
  三处当前值一致（Read/Write/Edit/Glob/Grep/Bash），但契约里的 `HOST_FILE_TOOLS` 实际是**死常量**：改它不会改变任何运行时行为 —— 这正是「第二份清单」的定义。
- **文档表格（未派生 ✘）**：`docs/requirements.html:1152-1167` 是手写 HTML 表格，行数固定 16，缺 `IssueCommentReply` / `IssueReactionAdd` / `IssueReactionRemove`。全仓 grep `requirements.html` 在 `apps/server/test` 与 `packages/contract/test` 中**零命中** ⇒ 没有任何测试或生成脚本把表格与契约对齐。所以 1134 行「本表全部从它派生」这句在实现上不成立。
- **第五份影子清单（次要）**：`skills/prompt.ts:458` 手写「只读的这五个：`IssueGet(number)` / `IssueList(state?,...)` / …」整段签名，与契约 `ISSUE_TOOLS` 的 required/optional 重复描述（内容当前一致，但新增读工具时不会自动出现）。

缺口：契约→运行时的派生链只对「issue 工具集」闭环；「宿主工具面」与「文档表格」各有独立手写清单，`HOST_FILE_TOOLS`/`HOST_SHELL_TOOL` 未被消费。

### A5 已移除工具：`mcp__*` / `plugin_*` 按**前缀**匹配；`new_context` / `Task` / `TodoWrite` 移除且不在 allowed-tools 枚举 —— **已实现**

反证过程（最怀疑的是「逐个列举而非前缀」）：

- `issue-tools.ts:33` `REMOVED_TOOL_PREFIXES = ['mcp__', 'plugin_']`（数组而非枚举值），判定 `isRemovedTool()` :56-63：先去空白 + `toLowerCase()`，再精确比对 3 个名字，最后 `startsWith(prefix)` —— **前缀匹配**，不是逐个列举。
- 审批层置于**最前**判定：`approval-policy.ts:228-234`，命中 `removed-tool` deny，不进 unknown 兜底。
- 技能枚举：`SKILL_ALLOWED_TOOLS`（`enums.ts:232-240`）只含 6 个宿主工具名 + `ISSUE_TOOL_NAMES`，无任何移除项；测试 `issue-tools.test.ts:61-65` 逐个断言 `SKILL_ALLOWED_TOOLS` 里没有移除项。
- 提示词目录：`renderToolCatalog()` 用 `HOST_TOOL_LINES[tool]` 白名单查表（:494-497），`mcp__*` 无对应键 ⇒ 不渲染；`skills-prompt.test.ts:344-347` 断言不含 `new_context` / `TodoWrite` / `mcp__`。
- 大小写/空白绕过已覆盖：`issue-tools.test.ts:48-52`（`'  todowrite '`、`'MCP__github'`、`'TASK'`）。

缺口：无。唯一可提的是 `isRemovedTool` 用 `startsWith('plugin_')`，因此 `plugin_` 精确名本身也被拒 —— 属于保守方向，不是后门。

### A6 写操作仍只有一条路；读操作可给但走平台代理（App 凭证，token 不进沙箱）且只读可审计 —— **已实现**

反证过程：

- 写类工具不自己发 HTTP：`approval-policy.ts:258-273` 对 `isIssueTool` 的写类**放行但注明「让平台去执行」**，真正两道闸在 `writeback/`（项目动作开关 + 写回闸门）。工具→动作信封的映射被测试钉住：`issue-tools.test.ts:130-158` 断言 14 个写类工具逐个落进 `ACTION_INTENTS ∪ REACTION_ACTION_INTENTS`，且键集合与 `ISSUE_WRITE_TOOL_NAMES` 完全相等。
- 项目动作开关真实存在且默认关：`config/v21-settings.ts:213-217`（`create_issue`/`open_pr`/`close_issue`，`||` 合并两条路径），消费点 `http/webhook-v21.ts:685-689` → `executeV21({ actionsEnabled: switches, ... })`。
- 读操作走平台 App 凭证、token 不进沙箱：`runtime/issue-read-tools.ts:87+` `createIssueReadExecutor(api, ...)`，`api` 来自 `github/` 侧的 App 客户端（`app/compose.ts:806-807` 注释与注入点）；沙箱（`sandbox/`、`exec-proxy`）路径里没有任何 GitHub 凭证。
- 读调用可审计：`worker/run-task.ts:1067-1080` 每条读调用 `appendEvent('issue.tool.read', { name, ok, items, summary, errorCode })` ⇒ 落 `run_events`，面板可查。
- 只读轮预算与截止时间也在：`run-task.ts:851-858`（任务级 deadline）、:1055-1062（`tool.budget-exhausted`）。

缺口：无。

### A7 `EXECUTE_CHANNEL_AVAILABLE` 真实存在 + 「平台代执行」措辞由它切换 —— **已实现**

反证过程：假设只是文档提到。

- 常量真存在：`issue-tools.ts:383` `export const EXECUTE_CHANNEL_AVAILABLE = false;`
- 投影函数：:391-393 `issueToolAvailability()` → `'callable' | 'platform-executed'`。
- 提示词真按它选措辞：`skills/prompt.ts:481-484` —— `callable` 说「已注册，直接调用」，否则说「这些能力由**平台代你执行**」。
- 无「宣称可直接调用」的漏网：`renderToolCatalog()` 与 `renderIssueCapabilityCatalog()` 都走 `issueToolSectionLines()`，那一处是唯一出口（:428-489）。

缺口：无。当前值为 `false`，与需求 1185 行描述一致。

### A 段附：需求 1179 行关于「标准动作」的列举已落后于代码

1179 行写「这些工具产出的仍是产出契约里的标准动作（`comment` / `label` / `create_issue` / `push_branch`）」。代码实际信封有 12 类动作（`skills/prompt.ts:345-415` 的 `ISSUE_ACTION_SHAPES`，含 `reaction` / `close_issue` / `reopen_issue` / `update_issue` / `update_comment` / `delete_comment` / `link` / `verdict` / `open_pr`），测试 `skills-prompt.test.ts` 亦对齐 `OUTPUT_ACTION_TYPES`。文档那句的括号内枚举是旧 4 类，属**文档滞后**，不改变「写操作只有一条路」的结论。

### **本节整体结论**

工具面的核心安全边界（Bash 禁 issue 操作 + 审计、移除工具前缀匹配、写操作单一出口、读操作平台代理可审计、通道状态常量）**全部有可执行代码与运行时接线，不是文档承诺**。真正站不住的是「唯一事实源」这一条的一半：issue 工具集是派生的，**宿主工具面（Read/Write/Edit/Glob/Grep/Bash）与需求文档表格不是派生的** —— 契约里的 `HOST_FILE_TOOLS`/`HOST_SHELL_TOOL` 无人消费，三处手写副本靠人肉同步；文档表格固定 16 行而契约是 19 个工具（多 `IssueCommentReply` / `IssueReactionAdd` / `IssueReactionRemove`），且没有任何测试校验表格与契约一致。这不构成安全后门（多出来的 3 个工具都在审批与提示词里按契约派生地生效），但构成「唯一事实源 = 已实现」的明确反例。

---

## B) 行 1707-1739 系统提示词与执行限额

### B1 系统提示词：常驻、每次调用都带、项目级（未配置用内置默认） —— **部分实现**

反证过程：

- 「项目级 + 内置默认」✔：`config/v21-settings.ts:200-209` —— `agent.system_prompt` 非空则用，否则 `agent.limits.system_prompt`，两者都空则回落 `AGENT_IDENTITY_PROMPT`（`skills/prompt.ts:75`）。默认值只在 `resolveAgentExecution()` 这一处裁决（:185-198 注释解释了为什么不在装配层再写一次默认）。
- 「进 system 通道而非任务提示词」✔：`app/compose.ts:1404-1407` 把 `resolveAgentExecution(policy.settings).system_prompt` 放进本轮 `deps.v21.systemPrompt`；`worker/run-task.ts:838,916` 传给 `driveTurn`；`runtime/turn-driver.ts:375-390` 只放进 `sessionCreate({ systemPrompt })`。
- 「每次调用都带」——**半条不成立**：`turn-driver.ts:375` 该分支只在 `sessionId === undefined`（新建会话）时进入；`persistent` 走 `session/attach` 分支（:359-374）时**不传** `systemPrompt`，代码在 :217-219 与 :382-383 明确写了这个设计（「再传一次等于给同一条会话两个身份来源」）。对需求「每次调用都带」的字面读法，复用的轮次里**没有**携带；对「常驻」的语义读法，身份在被复用会话的上下文里仍然存在。本仓无法断言宿主在 `session/attach` 后是否保留 system 消息 —— 那在 pi-host 侧，不在本仓。
- 「不是某一次事件的具体指令」✔：任务提示词与 system 分开（`turn-driver.ts:207-213` 注释 + `app/worker-deps.ts:296,355`）。

缺口：①「每次调用都带」只在新建会话分支成立，attach 分支不重传（设计如此，但与需求字面冲突，属**可判定为「与需求字面冲突」**而非「没实现」）；②宿主侧复用会话时是否真的保留了 system 消息，本仓无证据 ⇒ **无法判定**那半条。

### B2 并发数：项目级，触顶排队不丢弃 —— **已实现**

反证过程：假设只有配置字段。

- 配置字段存在两套：`packages/contract/src/settings-v21.ts:236` `agent.limits.concurrency`（1-8，默认 2）与 `repo-config.ts:135` `limits.concurrency_per_repo`（1-8，默认 2）。
- 真正生效的是**后者**：`queue/repo-concurrency.ts:25-42` 读 `limits.concurrency_per_repo`（越界夹到 1-8）；`app/compose.ts:1507-1515` 注入 `concurrencyPerRepoOf`；`queue/boss.ts:207-234` 在 `run-task` handler 里 `RepoConcurrencyLimiter` 取槽位。
- 「触顶排队不丢弃」✔：`repo-concurrency.ts:79-92` `acquire()` 在满时 `await new Promise` 挂进 `#waiters` 队列，`#releaser()` :113-133 把槽位**直接转移**给下一个等待者（注释说明为什么不是先减再加：避免插队）；没有丢弃分支、没有超时拒绝。
- 负向检验：全局并发 `queue/definitions.ts:94` `concurrency: 3`（基础设施层），不对应「业务限流」。

缺口（配置层面，不是行为层面）：`resolveAgentExecution()` 返回的 `concurrency`（`v21-settings.ts:210`）**无人消费** —— 全仓 grep 只有这一处写入。也就是说 `agent.limits.concurrency` 是死字段，改它不改变任何行为；生效值只能通过 `limits.concurrency_per_repo` 改。同一语义两个字段、其中一个不接线，是「配置写了没生效」的典型形态。

### B3 日配额：每天最多处理多少事件，触顶拒绝处理并记录原因、可查 —— **未实现（只有字段 + 一个永不触发的判定分支）**

反证过程（这条最需要反证，结论是确实没实现）：

1. 配置字段在：`settings-v21.ts:238` `agent.limits.daily_quota`（1-1000，默认 100）；解析在 `v21-settings.ts:211` `daily_quota: limits.daily_quota`。
2. 判定分支在：`trigger/decide.ts:251-252` `if (input.dailyQuotaExceeded === true) return skip(event, 'daily-quota')`。
3. **但没有任何生产者**：全仓 grep `dailyQuotaExceeded` 只有 4 处生产代码 —— `http/webhook-v21.ts:118,155,168`（参数声明与透传，`input.dailyQuotaExceeded === undefined ? {} : ...`）与 `trigger/decide.ts:119,251`（消费）。三个真实调用点 `http/webhook.ts:1005,1195,1259` 调 `decideV21Delivery()` 时**都没有传** `dailyQuotaExceeded`。唯一传 `true` 的地方是测试 `test/trigger-decide.test.ts:388`。
4. **没有计数器**：`db/schema.ts:634-644` 有 `quota_counters` 表（`(repo, kind, window_start)` 唯一索引），但全仓 grep `quotaCounters` 只在 `db/schema.ts`（定义 + 导出）与测试里出现 —— **没有任何读取或写入代码**。也就是说「今天这个仓库处理了几个事件」这个数根本没人算。
5. `resolveAgentExecution().daily_quota` 同样无人消费（与 `concurrency` 一样的死字段）。
6. 「记录原因、可查」的**基础设施**是有的：`webhook_deliveries.decision_reason`（`db/schema.ts:112-124`，注释列了 `daily-quota` 这个枚举值）+ `webhook-v21.ts::v21DecisionRowOf` 对触发与未触发都写；但既然判定分支永不触发，这一行永远不会写入 `daily-quota`。

结论：日配额**在行为上等于不存在** —— 超配额不会拒绝任何事件，也不会留任何原因。需求 1734 行「拒绝处理并记录原因，可查」的两半都不成立。

缺口：①缺「按 (repo, 日窗口) 计数」的读写路径（`quota_counters` 是空表定义）；②缺把计数结果喂进 `decideV21Delivery({ dailyQuotaExceeded })` 的接线；③`agent.limits.daily_quota` 死字段。

### B4 单轮超时：终止并记为超时，不自动重试 —— **部分实现（行为成立，但项目级配置不生效）**

反证过程：

- 「终止 + 记为超时」✔：`runtime/turn-driver.ts:326-346` `runWithDeadline({ ms: timeoutMs })`；超时 → `turn/interrupt` → `session/archive` → 抛 `failureClass: 'timeout'`（:324 注释 + `isTurnTimeout()` :623-625）；`worker/run-task.ts:466-472` `toTaskOutcome('timed-out') → 'timeout'`。
- 「不自动重试」✔：`queue/retry-policy.ts:124-125` `case FAILURE_CLASS.timeout: return noRetry(...)`，且 `run-task.retryLimit` 为 0（`queue/index.ts`/`boss.ts:112` 注释 + `decideRetry` 是唯一入口，`run-task.ts:1586`）。
- **但「项目级配置」不成立**：`settings-v21.ts:240` `turn_timeout_minutes`（1-30，默认 20）被 `v21-settings.ts:212` 解析出来，全仓**无人消费**。实际值来自两个硬编码常量：`turn-driver.ts:35-37` `DEFAULT_TURN_TIMEOUT_MS = 20min` / `REVIEW_PR_TURN_TIMEOUT_MS = 30min`；`run-task.ts:458-463` `timeoutMsForCommand()` 按命令名二选一。也就是说仓库把 `turn_timeout_minutes` 配成 5 分钟不会生效。
- 额外细节（不是缺口）：多轮只读工具轮不会把 20 分钟放大成 3×20 —— `run-task.ts:839-840,923-928` 用任务级 deadline 的剩余时间，并有上下界夹取。

缺口：`agent.limits.turn_timeout_minutes` 是死字段；「单轮超时」当前是**部署级常量**（按命令名分档），不是需求要求的项目级可配值。

### B5 不设平台级业务限流 —— **已实现（无反证成立）**

反证过程：找「全局业务限流」的证据。全局并发只有 `QUEUES[run-task].concurrency = 3`（`queue/definitions.ts:94`，进程级执行能力）、`agent-dispatch` 并发必须为 1（语义要求，同文件 :103）。没有任何按仓库/按事件类型的全局拒绝路径；配额语义只落在项目级字段（且如 B3 尚未接线）。`skills/prompt.ts` 的字符预算（单轮 6k）属于提示词装配，不是业务限流。

缺口：无。

### **本节整体结论**

「系统提示词」的裁决逻辑与内置默认是真的、且确实走 system 通道；但「每次调用都带」只在新建会话分支成立，attach 分支不重传（设计取舍，与需求字面冲突），宿主侧是否保留本仓无法判定。三项限额里只有**并发数**真正生效（且用的是 `concurrency_per_repo`，`agent.limits.concurrency` 是死字段）；**单轮超时**的行为（终止/记超时/不自动重试）完整，但 `turn_timeout_minutes` 死字段 ⇒ 不是项目级可配；**日配额是空的** —— 字段有、判定分支有、`quota_counters` 表有，唯独没有计数与传递，`dailyQuotaExceeded` 在生产代码里没有任何生产者，触顶拒绝与「记录原因可查」都不会发生。

---

## 汇总（缺口清单，按严重度）

| # | 需求点 | 状态 | 缺口 |
|---|---|---|---|
| 1 | 6.7 日配额（触顶拒绝 + 记录原因可查） | **未实现** | 无计数读写（`quota_counters` 空表）；`dailyQuotaExceeded` 无生产者；三个 `decideV21Delivery()` 调用点均未传；`daily_quota` 死字段 |
| 2 | §5.5 文档表格「从契约派生」+ 16 个 | **与需求冲突 / 部分实现** | 表格手写固定 16 行，契约 19 个（缺 `IssueCommentReply`/`IssueReactionAdd`/`IssueReactionRemove`）；无生成脚本、无测试校验表格 |
| 3 | §5.5 宿主工具面「从契约派生」 | **部分实现** | `HOST_FILE_TOOLS`/`HOST_SHELL_TOOL` 全仓无消费；`approval-policy.ts:49-53`、`skills/prompt.ts:310-317`、`enums.ts:232-240` 三处手写副本 |
| 4 | 6.7 单轮超时（项目级） | **部分实现** | `turn_timeout_minutes` 解析后无消费；实际硬编码 20/30min |
| 5 | 6.7 并发数（项目级） | **已实现，但配置双份** | `agent.limits.concurrency` 死字段；生效值是 `limits.concurrency_per_repo` |
| 6 | 6.7 系统提示词「每次调用都带」 | **部分实现 / 部分无法判定** | attach 复用会话不重传 `systemPrompt`（`turn-driver.ts:359-390`）；宿主是否保留本仓无证据 |
| 7 | §5.5 写操作「标准动作」（1179 行句内枚举） | **文档滞后** | 文档写 4 类，信封实际 12 类（`skills/prompt.ts:345-415`） |
| 8 | 提示词内只读工具签名清单 | 次要重复 | `skills/prompt.ts:458` 手写 5 个工具签名，与契约 `required/optional` 重复 |

已确认**无问题**（有可执行代码与负向测试）：Bash 的 gh/api.github.com deny 与审计；`mcp__*`/`plugin_*` 前缀匹配；`new_context`/`Task`/`TodoWrite` 不在任何白名单与工具目录；写操作单一出口 + 项目动作开关默认关；读操作平台代理 + `issue.tool.read` 审计；`EXECUTE_CHANNEL_AVAILABLE` 与措辞切换；并发触顶排队不丢弃；超时不自动重试；无平台级业务限流。
