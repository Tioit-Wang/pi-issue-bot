# U4-A 核查报告：5.4 提示词下发 + 5.5 前半（FR-4.1 / FR-4.2 / FR-5.1 ~ FR-5.3）

- 需求文档：`docs/requirements.html` 行 925-1036（第 5.4 节「提示词下发」= FR-4.1、FR-4.2；第 5.5 节前半 = FR-5.1 ~ FR-5.3）
- 仓库：`C:\Code\NodeProjects\pi-issue-bot`（工作区有未提交改动；本次只读核查，未改任何仓库文件）
- 核查方式：逐条找代码证据 + 已有测试断言；状态取「已实现 / 部分实现 / 未实现 / 与需求冲突 / 无法判定」

---

## FR-4.1 拼接结构（四段固定顺序）

**状态：部分实现**

### 证据

四段的载体是「事件模板」（字符串数据），平台内置默认模板按需求顺序写死：

- `packages/contract/src/settings-v21.ts:464-472` 文件头注释明写「四段顺序固定：技能触发词 → issue 锚点 `#编号` → 链接 → 正文快照」。
- `packages/contract/src/settings-v21.ts:474-489`（`issues.opened`）：第 1 行 `/proposal-analysis`（技能触发词）→ 第 3 行本轮指令 → `#{{issue.number}} {{issue.url}}`（锚点 + 链接）→ 末尾 `正文快照：` + 围栏 `{{issue.content}}`。
- 另外四个事件同构：`issues.edited` 490-504、`issues.labeled` 505-517、`issues.closed` 518-530、`issue_comment.created` 531-548。
- 渲染器只做字面替换、一次遍历、未知占位符原样保留：`apps/server/src/prompt/render.ts:170-185`、`193-204`。
- 渲染上下文的四个数据源齐备（锚点 = `issue.number`、链接 = `html_url`、快照 = `issue.body`）：`apps/server/src/http/webhook-v21.ts:300-339`。
- 模板选择收敛到同一条路径（项目模板与内置默认同一个渲染器）：`apps/server/src/http/webhook-v21.ts:359-362`、`464`。
- 触发词真的用于技能路由（不是装饰）：
  - 从渲染结果首行认触发词：`apps/server/src/http/webhook-v21.ts:394-399`（`v21SkillIdsOf`，只认首行 `^/name$`）。
  - 首行技能词换成用户点名的那一个：`apps/server/src/http/webhook-v21.ts:420-426`、`506-515`。
  - 落库为 `tasks.agent_skill_ids`：`apps/server/src/agent/store.ts:147`、`212-233`（`insertMessage`；`comment_body` 列定义在 95）；`apps/server/src/agent/dispatcher.ts:105-106`。
  - 运行期优先按结构化点名选技能并注入该技能正文：`apps/server/src/app/worker-deps.ts:879-909`（`pickRequestedSkill`）、`926-943`、`977-994`（`renderSkillPrompt`）。
- 测试钉住了顺序：`apps/server/test/v21-webhook-integration.test.ts:363-389`（技能词 → `#7` → 链接 → 正文快照）、`390-401`（内置默认模板也过同一渲染器）、`apps/server/test/trigger-decide.test.ts:469-476`。

### 缺口

1. **顺序只对内置默认模板成立，项目自定义模板无任何结构校验。** 配置项只校验长度：`packages/contract/src/settings-v21.ts:85`（`prompt` 最大 4000 字符，`nullable().default(null)`）。项目把锚点写到第一行不会报错，只会让 `v21SkillIdsOf()` 返回空数组，于是静默退化到「模型按技能目录自选」——正是需求要避免的「触发词失效却没人知道」。
2. **严格说不是「四段」而是「四段 + 一段本轮指令」。** `issues.opened` / `issues.edited` 在触发词与锚点之间插了一段自然语言指令（`settings-v21.ts:477`、`493`）；`issues.edited` 的锚点行还缺前置空行（`settings-v21.ts:493-494`）。保序性未被破坏，但与需求表格的字面结构不一致。
3. **锚点与链接被合并成同一行**（`#{{issue.number}} {{issue.url}}`），顺序仍满足 ②→③，但不是两个独立段。
4. **触发词是「首选」而非「唯一」依据。** `pickRequestedSkill()` 在结构化点名之后还有两级兜底：`command` 前缀（`worker-deps.ts:897-901`）、触发文本里出现的已加载 `/name`（`worker-deps.ts:902-908`）。需求写的是「技能路由的唯一依据」，实现是「优先依据 + 兜底」，属于刻意放宽（兼容老调用点），但与文字不符。

---

## FR-4.2 首次全量、后续增量

**状态：未实现**

### 证据

- 每条事件都用同一份模板渲染整篇正文：`apps/server/src/http/webhook-v21.ts:450-516`（`buildV21AgentMessage` 全程没有「这是不是该 issue 的首个事件」这一判断，也没有任何历史消息查询）。
- 五个内置默认模板**每一次**都带完整正文快照，包括「后续事件」语义最强的 `issue_comment.created`：`packages/contract/src/settings-v21.ts:531-548`（`issue 正文快照：` + 围栏 `{{issue.content}}`）。
- 「历史由会话承担」这一半是真的：会话复用 + `persistent` attach 不归档，历史留在会话里 —— `apps/server/src/runtime/turn-driver.ts:42-52`、`150-158`；会话状态机 `apps/server/src/agent/session-state.ts:99-166`。
- 全仓没有任何「首次全量 / 后续增量」的分支或字段：在 `apps/server/src` 搜 `增量|incremental|首次全量` 只命中 `compact/*`（上下文压缩，另一件事）与 `degeneracy/*`（低增量熔断），与提示词下发无关。

### 缺口

- 缺少「首个事件 → 全量，后续事件 → 只发变更 + 本轮指令」的分支；当前是**每次都全量**。
- 缺少增量粒度（仅变更片段 / 变更前后对比）的实现，也未查到「上一次下发的快照」这一持久化依据（`agent_messages` 只存组装后的正文，见 `apps/server/src/agent/store.ts:221-233`，没有可供 diff 的旧正文列）。
- 注：需求本身在此条下挂了「**待确认**：增量粒度见 Q-4」（`docs/requirements.html:950`），所以「未实现」部分可解释为口径未定；但代码里连「首次 vs 后续」的判定入口都不存在，不属于「口径未定」能覆盖的范围。

---

## FR-5.1 平台不决定处理内容

**状态：部分实现**

### 证据（成立的部分）

- 一个事件对应一份提示词：`apps/server/src/trigger/decide.ts:255-265`（`decideEvent()` 返回 `template`，空/空白回落内置默认），`apps/server/src/http/webhook-v21.ts:359-362`。
- 平台只做三件事（交输入 / 校验 / 执行）：
  - 交输入：模板渲染后作为消息正文入队，`apps/server/src/http/webhook-v21.ts:450-516` + `apps/server/src/agent/store.ts:147`。
  - 校验：`packages/envelope/src/v21.ts:634-654`（`validateOutputV21`）、`apps/server/src/worker/run-task.ts:1168-1191`（三态判定：valid → 执行 / rejected → 整份拒绝 / not-v21 → 回落旧信封）。
  - 执行：`apps/server/src/writeback/v21/execute.ts:414-457`（`executeV21`）。
- 「同一事件换一份提示词，行为就改变而平台代码不动」成立：行为来自模板（settings 数据）+ 技能正文（仓库文件/内置文件），执行器对 `type` 做的是**通用**分派（`execute.ts:465-492`），不区分事件类型。
- 执行/写回层确实**没有**按事件类型分支：`grep "event ==="` 在 `writeback/`、`worker/` 无命中；事件相关的分支只出现在触发侧闸门（`trigger/decide.ts:232-243`）。

### 缺口 / 与需求文字的张力

1. **平台代码里存在「事件类型 → 技能」的默认硬绑定。** `packages/contract/src/settings-v21.ts:474-548` 把 5 个事件分别钉到 `/proposal-analysis`、`/label-triage`、`/issue-analysis`（`474/505/518/531` 各自首行）。这属于「默认值」，可被项目模板覆盖，但确实是代码里按事件类型给出的行为。
2. **平台维护着一份技能注册表。** `apps/server/src/skills/registry.ts:1-17`（内置 + 仓库两批文件合成命令表）、`apps/server/src/skills/builtin.ts:453-472`（8 个内置技能：`/review-pr`、`/issue-triage`、`/issue-repro`、`/proposal-analysis`、`/label-triage`、`/issue-analysis`、`/req-analysis`、`/bug-analysis`）。需求原文「平台不维护技能注册表」与代码字面冲突。
   - 可辩护的解释：这里维护的是「技能目录（正文由仓库/内置 md 承载）」，不是「事件 → 处理」的注册表；且仓库可用同名技能整体替换内置（`registry.ts:8`）。
3. **平台为评论事件特判了技能选择。** `apps/server/src/http/webhook-v21.ts:506-515`：`issue_comment.created` 时用评论正文里的显式 `/name` 覆盖首行触发词，注释直言「默认模板首行写死了 `/issue-analysis`，于是 `@bot /bug-analysis` 永远跑通用分析」（实测缺陷）。这是平台代码按事件类型打的补丁。
4. **v0.3 老路径仍在用，且那条路径把处理内容写死在代码里。** `apps/server/src/agent/message.ts:35-72` 三条事件模板内含「先按项目规范检查格式是否合规；不合规就告诉作者要补什么」这类具体指令，`eventSkillsOf()` 按 `settings.agent.on_opened/on_edited` 绑定技能（`message.ts:162-179`）；该路径由 `apps/server/src/http/webhook.ts:1537` 使用。若 v2.1 已全量切换，这条路径属于待清理的第二处真相；若未切换，则 FR-5.1 在前台实际上不成立。

---

## FR-5.2 工具调用与沙箱

**状态：部分实现**

### 证据

- 执行侧能在受控环境调工具与命令：
  - 只读工具轮（GitHub 读面 5 个工具）：`apps/server/src/runtime/issue-read-tools.ts`、预算与轮次 `apps/server/src/runtime/issue-tool-loop.ts:31-45`、worker 侧执行循环 `apps/server/src/worker/run-task.ts:1035-1094`（每轮最多 3 轮、每条调用经 `readTools.executor`）。
  - 契约层把工具名做成封闭枚举：`packages/envelope/src/v21.ts:141-165`（`ISSUE_READ_TOOL_NAMES` + `issueToolCallSchema`，`z.enum`）。
  - 沙箱命令通道独立于宿主：`apps/server/src/sandbox/exec-proxy.ts`、`exec-plan.ts`（命令计划单独成型）。
- 记录工具名 / 入参 / 返回：
  - 整条 RACP 事件流落 `run_events`，面板查询从事件里抽出三元组：`apps/server/src/queries/issues.ts:928-1003`（`item.started` → `payload #>> '{event,toolName}'` 作为 `name`、`sqlToolArgs()` 作为 `args_raw`、`tool.progress` → `output_raw`，按 `call_id` 合并、每 run 取前 50 条）。
  - 只读工具轮另有专门的审计事件：`apps/server/src/worker/run-task.ts:1071-1080`（`appendEvent('issue.tool.read', { name, ok, items, summary, errorCode })`），命中预算上限也留痕 `1055-1062`（`tool.budget-exhausted`）。

### 缺口

1. **`issue.tool.read` 只记工具名与摘要，不记入参与返回原文**（`run-task.ts:1073-1079`）。入参/返回原文只有在 Host 报出 `item.started` / `tool.progress` 并带上 `event.toolName` / `partialResult.*` 时才通过 `run_events` 存下来；Host 不报这些字段时平台没有兜底记录 —— 也就是说「每次调用都要记录工具名、入参与返回」依赖上游事件形状，不是平台自己保证的。
2. **沙箱命令（`Bash` 之类）没有独立的逐条审计落库**：`apps/server/src/sandbox/exec-proxy.ts:247-301` 只有结构化日志（info/warn/error），没有「命令 + 入参 + 返回」的持久化行。容器内的命令行为同样只能靠 `run_events` 里的 tool 事件还原。
3. 需求里的「读文件、检索、执行命令」中，「检索/读文件」由 Host 工具矩阵（`Read/Glob/Grep/Bash`）承担，平台侧没有对这些调用的入参做任何校验或限白（除只读工具轮的 5 个名字外，其余调用平台只是旁观者）。

---

## FR-5.3 产出契约：动作与格式

**状态：已实现（主链路成立，有 1 处真实缺口 + 3 处与文字不一致）**

### 证据（逐条对齐）

**封闭动作集合 + 七类动作**

- 动作全集与判别联合：`packages/envelope/src/v21.ts:40-53`（`OUTPUT_ACTION_TYPES`）、`423-436`（`z.discriminatedUnion`）、`442-457`（`outputV21Schema`，`strictObject`）。
- 七类逐一对得上：
  - 判定（存档无副作用）：`execute.ts:497-507`（`runVerdict` 只拼一句话，不调任何写端口）；测试 `packages/envelope/test/v21.test.ts:56-59`（`actions: []` 合法）。
  - 标签（目标态）：`execute.ts:515-560` + `apps/server/src/writeback/v21/labels.ts:135-190`（`remove = current ∩ 可管理目录 − desired`，`labels.ts:17`、`69-71`）。
  - 评论（槽位名 + 正文）：`execute.ts:589-684`。
  - reaction（幂等）：`execute.ts:710-756`（`add` 已有自己的同 content 就跳过；`remove` 只删自己的）。
  - 建 issue（指纹去重 + 日配额，默认关闭）：schema `v21.ts:318-329`；执行 `execute.ts:758-799`。
  - 开 PR（只允许 `bot/*`，永不 force push，默认关闭）：schema `v21.ts:207-208`、`332-339`；执行 `execute.ts:802-824`（二次正则校验 `806-808`，正文里的 closing keyword 全部中和 `809-812`；全程没有任何 push，只调 `openPullRequest`；`apps/server/src/git/run-git.ts` 另挡 `--force`/`--mirror`）。
  - 关闭 issue（仅确定性条件，不采信模型自评，默认关闭）：`execute.ts:838-879` 的 `846-850`（顶层 `verdict !== 'fail'` 直接 `close-without-fail`）；测试 `apps/server/test/writeback-v21-execute.test.ts:352-392`。
- 后三类默认关闭的开关真的存在且默认 `false`：`packages/contract/src/settings-v21.ts:215-219`（`create_issue/open_pr/close_issue: z.boolean().default(false)`）；两处配置取「或」：`apps/server/src/config/v21-settings.ts:213-217`；装配进执行器：`apps/server/src/worker/run-task.ts:1328`（`const actionsEnabled: V21ActionSwitches = resolved.actions;`）。
- `link`+`duplicate` 等价关单，因此受 `close_issue` 开关约束（防「换个动作名关单」的后门）：`packages/envelope/src/v21.ts:78-96`；测试 `writeback-v21-execute.test.ts:837`、`v21.test.ts:260-263`。

**产出格式字段**

- `verdict`（pass/fail，可省）：`v21.ts:444`。
- `evidence`（可选字符串数组，不参与执行）：`v21.ts:445`；执行侧只计数：`execute.ts:501`。
- `actions[]`（必填，可空数组）：`v21.ts:446`；空数组合法且有测试：`v21.test.ts:56-59`、`writeback-v21-execute.test.ts:248-262`。
- `actions[].type` / `actions[].payload`：`v21.ts:423-436`（判别联合，payload 按 type 各自 `strictObject`）。
- 顶层多余字段也拒绝（`strictObject`）：`v21.ts:442`，测试 `v21.test.ts:143-148`。

**三条校验规则**

1. **未知 type 拒绝整份产出，不执行任何一条** —— 真的「整份」而不是「跳过该条继续」：
   - 前置判别键检查：`packages/envelope/src/v21.ts:523-547`（`preflightDiscriminator`，命中即 `{ ok: false }`，路径 `/actions/<i>/type`）。
   - 统一入口先跑前置检查再跑 zod：`v21.ts:634-654`。
   - worker 侧拿到 `rejected` 后**不回落旧信封、不执行任何动作**：`apps/server/src/worker/run-task.ts:1173-1191`（写 `envelopes.valid=false` + `run_events: envelope.v21.rejected` + 失败信号）；`v21Handled = true` 保证不会二次走旧路径。
   - 测试：`packages/envelope/test/v21.test.ts:105-118`（`comment` 合法 + `merge_pr` 非法 → 整份 `ok:false`，错误指向 `/actions/1/type`）。
2. **缺必填字段拒绝，错误可定位到字段**：`v21.ts:640-647`（zod issue.path → JSON Pointer），`120-132`（测试断言路径以 `/actions/1/payload` 开头）；跨字段语义校验同样精确到字段：`v21.ts:560-625`（`semanticIssuesOf`），测试 `228-253`。
3. **按数组顺序执行、遇失败即停、已成功的不回滚、记录中断位置**：
   - `execute.ts:431-448`（`for` 顺序执行，`catch` 里 `stoppedAt = index; break;`），返回结构带 `stoppedAt`：`execute.ts:249-257`。
   - 执行前整份拒绝时 `stoppedAt = null`（一条都没开始）：`execute.ts:419-429`。
   - 中断位置落库：`apps/server/src/worker/run-task.ts:1412-1419`（`envelopes.errors` 逐条带 `/actions/<i>/<type>`）、`1457` 附近（`writeback.v21.result` 事件）。
   - 测试：`writeback-v21-execute.test.ts:223-262`（第 2 条失败 → `stoppedAt=1`，第 1 条不回滚，第 3 条不执行）。

**槽位落地**

- 槽位名由执行侧声明、平台不校验语义（只校验形状 `^[a-z0-9][a-z0-9._-]{0,63}$`）：`v21.ts:204-205`、`231`；执行侧不解释语义：`comments.ts:4-9`。
- 平台在自己发的评论**末尾**写隐藏 HTML 注释（issue 编号 + 槽位名）：`apps/server/src/writeback/v21/comments.ts:53-55`（`<!-- pi-bot:slot repo#issue:slot -->`）、`123-128`（`composeSlotBody`：正文 + 空行 + 标记，标记在最后）；渲染可见性说明 `11-14`。
- 覆盖时按标记查找，找到就编辑、找不到就新建：`comments.ts:98-114`（`findSlotComment`）、`161-177`（`planSlotWrite`）；执行侧 `execute.ts:627-683`。
- **原评论被删 → 新建并留痕**：两条路径都有
  - 索引里有历史 id、列表里找不到 → `op: 'create'` 且 `recreated: true`（`comments.ts:146-148`、`174-176`），执行侧返回「槽位 X 重建」（`execute.ts:681-683`）；
  - 更新时收到 404 → 按重建处理，返回「槽位 X 的原评论已不存在，重建」（`execute.ts:660-672`，其中 `293-309` 的 `isNotFoundError()` 区分「被删」与「网络/权限错误」，后者仍然失败）。
- 同一 issue 同一槽位只保留一条、不同槽位互不影响：`comments.ts:6-9`、`85-88`（`isSameSlot` 只比 `(repo, issue, slot)`）；测试 `apps/server/test/writeback-v21-comments.test.ts:28-135`。

### 缺口 / 不一致

1. **【真实缺口】`create_issue` 的「指纹去重 + 日配额」在 v2.1 执行路径上没有接线。**
   - 执行器只认一个可选的 `createIssueGuard` 钩子：`execute.ts:190-196`、`229`、`771-788`。
   - 生产装配处**没有注入**它：`apps/server/src/app/compose.ts:1401-1424` 的 `v21` 钩子集合里只有 `reactions` / `issueEdit` / `readTools` / `openPullRequest` / `compactionStore`。全仓 `grep createIssueGuard` 仅命中 `execute.ts`（另一处是测试 `writeback-v21-execute.test.ts:434`、`440` 自己造假的 guard）。
   - 于是生产路径恒走 `decision === 'create'`（`execute.ts:771-780`），**既不去重也不查配额**。
   - 旧的实现（`decideCreateIssue()`：指纹去重优先于配额、默认配额 10）在 `apps/server/src/github/executor.ts:361-402`，但只服务旧 pipeline 路径，v2.1 不经过它。
   - 影响面有限（该动作默认关闭，`settings-v21.ts:217`），但一旦项目显式打开，需求承诺的两道防线都不存在。
2. **动作集合被扩到 12 类，与需求「七类」不一致。** `v21.ts:40-53` 在七类之后又加了 `reopen_issue` / `update_issue` / `update_comment` / `delete_comment` / `link`（注释称 v2.2 增补，理由见 `30-39`）；执行器 `switch` 覆盖 12 类（`execute.ts:465-492`）。方向上是超集、「封闭集合」原则未被破坏，但需求正文仍是「七类」，二者需要对齐（要么改需求，要么承认这是未文档化的契约扩张）。
3. **「同一 issue 同一槽位只保留一条」只保证「不再新增」，不保证「清理重复」。** `findSlotComment()` 命中多条时取列表第一条（`comments.ts:95-113`），多余的同槽位评论不会被删除。人手工制造重复后，不变量在数据上仍处于被破坏状态。
4. **「原评论已不存在，已新建」文案与实现的措辞不同**（实现为「原评论已不存在，重建」，`execute.ts:671`；dry-run 为「原评论已不存在，重建」，`648`）。语义一致，若后台文案要与需求逐字对齐需改字。

---

## 本节整体结论

- **主链路（产出契约 + 执行）是这套设计里最扎实的一段。** 「未知 type 整份拒绝」真的是整份拒绝（前置判别键检查 + 整份 `ok:false` + worker 不回落不执行），「遇失败即停」真的有 `stoppedAt` 并落库，「槽位覆盖」真的按隐藏 HTML 注释标记查找，「原评论被删」真的有两条重建路径并留痕 —— 这四条是需求里最容易被做成「看起来对」的地方，实现都做到了，且都有测试钉住。
- **提示词下发这一段与需求差距最大。** 四段顺序只存在于「内置默认模板」这份字符串里：项目自定义模板没有任何结构约束，顺序错了平台不报错只会静默失去技能路由；FR-4.2 的「首次全量、后续增量」完全没有实现（每次事件都全量重发整篇正文，包括评论事件），只有「历史由会话承担」这一半成立。
- **FR-5.1 是「原则成立、字面不成立」。** 「同一事件换一份提示词行为就变」在 v2.1 路径上确实成立（执行器不按事件类型分支），但平台代码里仍有事件→技能的默认绑定、有一份内置技能注册表、还有一处为评论事件打的技能覆盖补丁；v0.3 老路径（`agent/message.ts`）更是把处理内容写死在代码里且仍在被 `http/webhook.ts` 使用。
- **一处必须修的实质缺陷：`create_issue` 的指纹去重与日配额在 v2.1 上没有接线**（`createIssueGuard` 无生产注入）。这是「默认关闭所以影响小」的类型，不是「无所谓」的类型。
- 另需产品侧裁决两件事：动作集合是七类还是十二类；FR-4.2 的增量粒度（需求自己挂了 Q-4 待确认，可直接降级或明确推迟）。
- 附注：需求文档自身编号与章节错位（第 5.4 节里放的是 FR-4.1 / FR-4.2），引用时容易与第 4 章混淆，建议同批修正。
