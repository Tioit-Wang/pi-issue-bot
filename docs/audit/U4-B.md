# U4-B 需求实现核查（反证视角）：requirements §5.4 / §5.5 前半（行 925–1036）

- 需求文档：`C:\Code\NodeProjects\pi-issue-bot\docs\requirements.html` 行 925–1036
- 核查方式：**只读**静态阅读 + 逐条证伪。未运行任何测试/命令（未修改仓库任何文件）。
- 重要前置事实（影响全部结论的取证面）：
  - 仓库工作区**存在大量未提交改动**（`git status --short` 有 33 个 `M`，含 `apps/server/src/http/webhook.ts`、`packages/envelope/src/v21.ts`、`skills/builtin.ts`、`AGENTS.md` 等）。本报告读的是**工作区当前内容**，不是 HEAD。
  - 存在**两条并存的提示词通道**，必须分开取证：
    - v2.1 通道（`deps.v21` 注入即启用，生产装配点 `app/compose.ts:981`）：事件 → `decideV21Delivery()` → `buildV21AgentMessage()` → 模板渲染 → `agent_messages.comment_body`。
    - v0.3 legacy 通道（`agent/message.ts` 的 `AGENT_MESSAGE_TEMPLATES`，经 `http/webhook.ts:640` 的 `templateId` 分支）：只在**没有**注入 `deps.v21` 的旧装配里生效（`http/webhook.ts:1295` 注释自认）。
  - 下面凡涉及 FR-4.1 / FR-4.2，**结论以 v2.1 通道为准**；v0.3 通道只作为「同一仓库里存在与需求对不上的实现」的旁证列出。

---

## FR-4.1 提示词四段固定顺序（触发词 → issue 锚点 → 链接 → 正文快照；触发词是技能路由的唯一依据）

**状态：部分实现**

### 反证过程

1. 先假设「四段根本没拼，顺序是随机/模板自由发挥」。→ **部分被推翻**：内置默认模板在契约里定义成四段字面量，顺序与需求一致：
   - `packages/contract/src/settings-v21.ts:471` 注释「四段顺序固定」；`issues.opened` 模板 `settings-v21.ts:474-489` = 第 1 行 `/proposal-analysis`（触发词）→ `#{{issue.number}} {{issue.url}}`（锚点 + 链接）→ `正文快照：` + `{{issue.content}}`。
   - `issues.edited` / `issues.labeled` / `issues.closed` / `issue_comment.created` 四个模板同构（`settings-v21.ts:490-548`）。
   - 集成测试真的按**下标先后**断言了顺序（不是只断言「都包含」）：`apps/server/test/v21-webhook-integration.test.ts:374-382`（`skillAt < numberAt < linkAt < snapshotAt`），内置默认模板另有一条 `:390-404`。这条测试咬得住「顺序被打乱」。
2. 再假设「平台在拼装层强制了这四段」。→ **被推翻**：拼装层是**纯字面替换**，没有任何段序/段存在性校验：
   - `apps/server/src/prompt/render.ts:170-185` `renderTemplate()` 只做一次 `replace`；`:132-161` 是占位符白名单 switch，与段序无关。
   - 模板来源是项目配置优先、缺省回落内置：`apps/server/src/http/webhook-v21.ts:359-362` `v21TemplateOf()`。
   - 也就是说：**顺序只在「平台随附的默认模板」里成立**；项目把 `prompt` 改成任意文本（面板可编辑），四段可以缺失、可以换序，平台不会拒绝也不会告警（未知占位符只 warn 并按原文保留：`webhook-v21.ts:495-504`）。需求原文是「顺序固定」，代码层面是「默认值固定」。
3. 再假设「触发词不是路由依据，只是装饰」。→ **被推翻**：路由确实只认首行触发词，且是结构化落库：
   - `apps/server/src/http/webhook-v21.ts:394-399` `v21SkillIdsOf()` **只取 `text.split('\n',1)[0]`** 匹配 `^/[a-z][a-z0-9-]{1,30}$`；
   - 结果写进 `agent_messages.skill_ids`：`webhook-v21.ts:1029-1037`；
   - 装配层按 `tasks.agent_skill_ids` 找技能正文并注入提示词：`apps/server/src/app/worker-deps.ts:871-892`（结构化点名优先，`command` 显式命令次之）。
   - 例外（对「唯一依据」的削弱）：评论里点名的技能会**覆盖**模板首行——`webhook-v21.ts:506-515`（`explicitSkillOfComment()` + `withSkillFirstLine()`）。这不算违规（仍是「触发词」驱动，只是把评论里的 token 也当触发词），但「唯一依据 = 模板首行」这句话在实现上不成立，准确表述是「首行触发词 或 评论首个技能 token」。
4. 反向查「有没有别的地方按事件类型塞触发词」。→ 有，但只在 v0.3 legacy：`agent/message.ts:162-170` `eventSkillsOf()` 读 `settings.agent.on_opened/on_edited`，而 `packages/contract/src/repo-config.ts:153` 明确写「旧的 `on_opened`/`on_edited` 保留但**不再由新路径读取**」。v0.3 模板本身也**违反四段顺序**（`agent/message.ts:36-52`：首行是行为指令而非触发词，`{skills}` 指令在**末尾**而非首段，且**没有链接段**）。这条通道在生产装配下不会被走到，但代码仍在、仍在编译、仍有测试（`apps/server/test/agent-message.test.ts`）。

### 证据（文件:行号）

- `C:\Code\NodeProjects\pi-issue-bot\packages\contract\src\settings-v21.ts:471`（四段顺序声明）、`:474`–`:489`（opened 模板）、`:490`–`:548`（其余四事件模板）
- `C:\Code\NodeProjects\pi-issue-bot\apps\server\src\prompt\render.ts:170`–`:185`（纯字面替换，无段序校验）
- `C:\Code\NodeProjects\pi-issue-bot\apps\server\src\http\webhook-v21.ts:359`–`:362`（模板来源）、`:394`–`:399`（首行触发词→skillIds）、`:506`–`:515`（评论触发词覆盖）、`:1029`–`:1037`（落库）
- `C:\Code\NodeProjects\pi-issue-bot\apps\server\src\app\worker-deps.ts:871`–`:892`（按 skillIds 解析技能）
- 测试：`C:\Code\NodeProjects\pi-issue-bot\apps\server\test\v21-webhook-integration.test.ts:374`–`:382`、`:390`–`:404`
- 反例（legacy 通道）：`C:\Code\NodeProjects\pi-issue-bot\apps\server\src\agent\message.ts:36`–`:52`、`:162`–`:170`；`C:\Code\NodeProjects\pi-issue-bot\apps\server\src\http\webhook.ts:640`（`action === 'opened' ? 'opened' : 'edited'` 硬编码）

### 缺口

1. **段序没有平台级约束**：四段顺序只由内置默认模板保证，项目模板可任意违反，平台不校验、不告警、不补位。需求「顺序固定」在实现上是「默认值固定」。
2. **「唯一依据」表述与实现不符**：`issue_comment.created` 上评论里的技能 token 会覆盖模板首行（`webhook-v21.ts:508-512`），路由依据实际是两处。
3. **legacy 通道仍存在且违反四段顺序**（无链接段、触发词不在首段），只是生产装配不走到；一旦有人不注入 `deps.v21` 就静默回到不合规通道。
4. 触发词在 v2.1 只是「首行长得像 `/xxx`」；技能不存在时按普通文本处理（`webhook-v21.ts:411-417` 注释），不报错——路由失败是静默的。

---

## FR-4.2 首次全量、后续增量（后续事件只发变更与本轮指令）

**状态：未实现**

### 反证过程

1. 假设「存在增量分支」。→ 逐点搜索后**找不到任何分支**：
   - 全仓搜 `增量` / `incremental` / `首次全量` / `only-changes` / `onlyChanges`：39 处命中**没有一处属于提示词下发**——分布在 `compact/*`（摘要增量）、`degeneracy/*`（低增量判据）、`worker/writeback.ts`（标签增量集合）、`queries/issues.ts`（流式增量不落库）、`sandbox/protocol.ts`（帧解码）。零命中在 `prompt/`、`webhook-v21.ts`、`agent/message.ts`。
   - 「首个事件 / 后续事件」的判据同样不存在：搜 `全量` 只有 `skills/builtin.ts` 的「不要跑全量测试」、`metrics-rollup` 的「全量覆盖」等无关命中。
2. 假设「判据藏在会话状态里」（会话已存在 ⇒ 只发增量）。→ **被推翻**：`buildV21AgentMessage()` 的入参里没有任何会话/轮次信息（`webhook-v21.ts:450-463`：只有 settings/event/repo/eventAction/payload/deps/logger/deliveryId/decidedTemplate/aliases），渲染上下文也没有（`:293-339`）。会话存在与否只影响 worker 侧 `session` 计划（`app/compose.ts:1228-1233`、`:1315`），**不影响消息正文**。
3. 假设「按事件类型分流就等于增量」（`issues.opened` 全量、`issues.edited` 只发变更）。→ **被推翻**：`issues.edited` 的默认模板**整篇重发正文**（`settings-v21.ts:490-504`：`这是修改后的正文快照…{{issue.content}}`）；`issues.labeled`（`:505-517`）、`issues.closed`（`:518-530`）、`issue_comment.created`（`:531-548`）同样各自带 `{{issue.content}}` 全文。五个默认模板**全是全量**，没有一条是增量。
4. 假设「增量在 prompt 预算/压缩层实现」。→ **被推翻**：压缩是会话历史（`compact/*`，FR-5.6），与「本条消息只带变更」是两件事；`skills/assemble.ts:311-314` 的层面裁剪也不按事件轮次。

### 证据（文件:行号）

- `C:\Code\NodeProjects\pi-issue-bot\apps\server\src\http\webhook-v21.ts:450`–`:463`（构建入参无轮次/会话维度）
- `C:\Code\NodeProjects\pi-issue-bot\apps\server\src\http\webhook-v21.ts:983`–`:1037`（每次触发都渲染完整模板并整条落库，无「首次/后续」分支）
- `C:\Code\NodeProjects\pi-issue-bot\packages\contract\src\settings-v21.ts:474`–`:548`（五个默认模板全部含 `{{issue.content}}`）
- `C:\Code\NodeProjects\pi-issue-bot\apps\server\src\trigger\decide.ts:255`–`:259`（模板选择只有「项目配置 / 内置默认」两态，与第几次事件无关）

### 缺口

1. FR-4.2 **完全没有实现**：不存在「首事件全量 / 后续只发变更」的判据，也不存在变更片段抽取（对比 `issues.edited` 的 `changes` 只用于触发条件判断：`trigger/decide.ts:145-153`，判完即丢弃，不参与渲染）。
2. 现网后果：每次 `edited`/`labeled`/`comment` 事件都把 issue 全文再发一遍（正文截断上限由 `PROMPT_LIMITS.body` / 模板原样决定），与会话持久化（`agent_sessions`）叠加后属于重复上下文。需求原文的「历史由会话承担」这半句有实现（会话复用），前半句没有。
3. 需求里 FR-4.2 标注为 P1 且「增量粒度待确认（Q-4）」——缺口语义上被需求自身留白，但代码侧连占位/开关都没有。

---

## FR-5.1 平台不决定处理内容、不维护技能注册表、不按事件类型硬编码

**状态：部分实现**

### 反证过程

1. 假设「存在按事件类型 switch 的硬编码行为」。→ 对 `apps/server/src` 全文搜 `case 'issues.` / `case 'issue_comment` / `case 'pull_request`：**0 命中**。事件→处置的映射集中在两处，且都是**数据驱动**：
   - `trigger/decide.ts:209-266` `decideEvent()`：顺序固定（验签 → 仓库 → 开关 → 附加条件 → 评论闸门 → 去重 → 配额），产出 `{triggered, template}`；模板来自 `resolveEventTrigger(settings, event).prompt`（`config/v21-settings.ts:105-116`），缺省回落内置默认（`trigger/decide.ts:257-258`）。
   - `webhook-v21.ts:983-1068`：触发就把渲染结果当消息，不按事件名分叉写回行为。
2. 假设「平台有一张『事件 → 技能』的注册表」。→ **需要分开看，结论是「没有事件路由表，但确有技能登记与内置技能」**：
   - `apps/server/src/skills/registry.ts:1-60` 确有「技能注册表」对象，但它是 **文件驱动的命令表**（内置 Markdown + 仓库 `.github/pi-bot/skills/*.md`，冲突/禁用规则见 `:8-16`），不是「哪个事件用哪个技能」。技能选择只看 `agent_messages.skill_ids` / 显式命令（`app/worker-deps.ts:871-892`）。
   - 但 `packages/contract/src/settings-v21.ts:462-549` 里的 `DEFAULT_EVENT_TEMPLATES` **按事件类型给出了带具体处理步骤与技能的默认提示词**（例：`issues.opened` 默认写死 `/proposal-analysis` + 「① 先判类型（bug / 需求 / 无关 / 滥用）② …」`settings-v21.ts:474-489`）。这是「平台按事件类型决定了一版默认处理内容」，项目可覆盖但不覆盖就按平台的来。严格按需求字面（「平台不决定处理内容」），这一条**只能算部分成立**：默认值层面平台决定了内容。
3. 假设「同一事件换一份提示词，平台代码不动」。→ **被推翻**：成立。改 `triggers.events[event].prompt` 即改行为，代码路径 `resolveEventTrigger` → `v21TemplateOf` 不动；测试 `v21-webhook-integration.test.ts:363-388` 就是拿项目模板跑出完全不同的正文。
4. 假设「还有别处按事件类型决定行为」。→ 两处需要点名（都属「触发条件」而非「处理内容」，但仍是事件类型硬编码）：
   - `config/v21-settings.ts:111`：`onlyBodyChanged` 对非 `issues.edited` 恒 false；
   - `trigger/decide.ts:141-164`：`issues.edited` / `issues.labeled` 各有专属附加条件。
   这两处是「要不要跑」的开关，不涉及「跑什么」，且写成注释说明过口径，判定为**不违规**。

### 证据（文件:行号）

- `C:\Code\NodeProjects\pi-issue-bot\apps\server\src\trigger\decide.ts:141`–`:164`、`:209`–`:266`（无事件行为分叉，只有触发条件）
- `C:\Code\NodeProjects\pi-issue-bot\apps\server\src\http\webhook-v21.ts:983`–`:1019`（触发即渲染模板，不按事件改行为）
- `C:\Code\NodeProjects\pi-issue-bot\packages\contract\src\settings-v21.ts:462`–`:549`（**平台随附的按事件默认内容**，包含技能名与处理步骤）
- `C:\Code\NodeProjects\pi-issue-bot\apps\server\src\skills\registry.ts:1`–`:16`（技能注册表 = 文件驱动的命令表）
- `C:\Code\NodeProjects\pi-issue-bot\apps\server\src\config\v21-settings.ts:105`–`:116`（配置驱动取模板）

### 缺口

1. **默认内容由平台决定**：五个 `DEFAULT_EVENT_TEMPLATES` 把「处理什么、用哪个技能、分几步」写进契约包（`settings-v21.ts:474-548`）；不覆盖配置的项目实际跑的就是平台预设的处理流程，与「平台不决定处理内容」的字面冲突。合理化解是「默认值可覆盖」，但需求没给这个豁免。
2. **技能注册表存在**（`skills/registry.ts`）——若按需求字面把「技能注册表」理解为「平台侧技能清单」，则与 FR-5.1 冲突；若理解为「事件→技能路由表」，则不冲突（代码里没有这种表）。
3. 平台仍随附内置技能正文（`apps/server/src/skills/builtin.ts`，含 `/issue-format`、`/label-triage` 等流程文本），即「处理内容」的一部分住在平台代码里。

---

## FR-5.2 工具调用与沙箱；每次调用记录工具名 / 入参 / 返回

**状态：部分实现**

### 反证过程

1. 假设「工具调用完全不落库」。→ **被推翻**：宿主工具调用按 RACP 原始事件整体落 `run_events`：`worker/run-task.ts:931-977`（`onEvent` 内 `appendEvent(event.kind, event.payload)`，仅剔除 `item.delta` 流式正文）；`run_events.payload` 是 jsonb 原样存（`db/schema.ts:296-312`）。工具名/入参在事件载荷里的位置也被显式解析过：`runtime/turn-driver.ts:282-288`（`toolName`、`tool.input` / `input` / `args`）。
2. 假设「只记了工具名，入参和返回没记」。→ **对宿主工具：不成立**（原始载荷整体落库，含输入与输出文本；面板侧也确实按 `toolCallId` 归并、从 `item.started` 取 `toolName`、从 `item.completed` 取输出：`queries/issues.ts:922-970`）。**对只读 issue 工具：成立**——见下一条。
3. 假设「`tool_calls` 的只读调用也记了入参」。→ **被推翻**：`worker/run-task.ts:1068-1080` 的记录体只有 `{ name, ok, items, summary, errorCode }`，**没有 `call.input`**；`tool.round` 事件只记 `calls: string[]`（工具名数组，`:1083-1087`）；测试把这个形状**锁死**了：`test/worker-run-task-tool-loop.test.ts:373-378`（期望值里没有 input 字段）。→ 只读工具轮（v2.3 新面）**不记录入参**，无法从审计回答「它按什么参数去读的」。
4. 假设「沙箱执行面另有完整记录」。→ 未推翻也未证成：沙箱命令通道（`sandbox/exec-proxy.ts` / `exec-plan.ts`）有审计事件，但本题范围未要求逐命令核对；本条只判「工具调用记录」。

### 证据（文件:行号）

- `C:\Code\NodeProjects\pi-issue-bot\apps\server\src\worker\run-task.ts:931`–`:977`（宿主事件整体落库，剔除 `item.delta`）
- `C:\Code\NodeProjects\pi-issue-bot\apps\server\src\runtime\turn-driver.ts:282`–`:288`（toolName / toolInput 提取）
- `C:\Code\NodeProjects\pi-issue-bot\apps\server\src\db\schema.ts:296`–`:312`（`run_events.payload` jsonb 原样）
- `C:\Code\NodeProjects\pi-issue-bot\apps\server\src\queries\issues.ts:922`–`:970`（从事件还原工具名与输出）
- `C:\Code\NodeProjects\pi-issue-bot\apps\server\src\worker\run-task.ts:1068`–`:1087`（只读工具调用记录缺 input）
- `C:\Code\NodeProjects\pi-issue-bot\apps\server\test\worker-run-task-tool-loop.test.ts:371`–`:378`（断言固化了「无 input」）

### 缺口

1. **`issue.tool.read` 缺入参**：`run-task.ts:1073-1079` 只记 name/ok/items/summary/errorCode，`call.input` 丢了；需求明写「每次调用都要记录工具名、入参与返回」，这是硬缺口。
2. **两套记录口径不一致**：宿主工具靠「原始事件整体透传」（字段名随宿主变化、无统一形状），issue 工具靠手写字段；不存在统一的「工具调用记录」契约，面板要按两种形状各写一遍解析（`queries/issues.ts` 的 SQL 就是这么做的）。
3. `item.delta` 有意不落库（`run-task.ts:972-977`），属设计取舍，不影响本条（delta 是正文流不是工具调用）。

---

## FR-5.3 产出契约：七类封闭动作 + 格式字段 + 三条校验规则 + 槽位落地

**状态：部分实现（核心语义成立，封闭集合与两条槽位细节不符需求）**

### 反证过程

1. 假设「未知 action type 被 filter 掉、其余继续执行」。→ **被推翻（对 v2.1 通道）**：`packages/envelope/src/v21.ts:523-547` `preflightDiscriminator()` 先把未知/缺失 `type` 判成 `/actions/<i>/type` 并**整份**返回失败；`validateOutputV21()`（`:634-654`）= 判别键 → zod 形状 → 语义交叉，任一失败 `ok:false`，调用方一条都不执行（`writeback/v21/execute.ts:419-429` 前置拒绝先跑）。测试直接断言拒绝路径：`packages/envelope/test/v21.test.ts:105`（未知 type → 整份拒绝、路径到字段）、`:120`（缺必填 → 整份拒绝）、`:134`（缺 actions 拒绝）、`:143`（多余字段拒绝）。
   **但要注意**：旧 4-intent 契约里确实存在「逐条丢弃、其余继续」的实现（`packages/envelope/src/actions.ts:96-236` `filterActions()`，注释自认「逐个丢弃而不是整封信封失败」）。它服务 `source='pipeline'|'command'` 的老路径，与 v2.1 并存；对 FR-5.3 的判定不适用，但如果有人按「信封」找代码，会先看到那一份。
2. 假设「遇失败后 catch 继续下一条」。→ **被推翻**：`writeback/v21/execute.ts:431-448` 顺序 for 循环，`catch` 里 `stoppedAt = index; break;`，已成功的保留不回滚（`:443-446`）；`stoppedAt` 显式进返回值（`:249-257`）。测试：`test/writeback-v21-execute.test.ts:224`（第 2 条失败 → 后续不执行、`stoppedAt=1`、第一条不回滚）、`:248`（全成功 `stoppedAt=null`）。
3. 假设「后三类动作默认关闭只是硬编码允许/禁止，没有配置项」。→ **被推翻**：开关是契约里的真配置项，默认全 false：`packages/contract/src/settings-v21.ts:215-221`（`create_issue/open_pr/close_issue` 各 `.default(false)`），映射到项目配置 `repo-config.ts:197`；执行前整份拒绝：`execute.ts:390-404`（`preflightSwitches()`，返回**全部**不合规下标）+ `:419-429`。测试：`writeback-v21-execute.test.ts:265`（三开关全关 → 一条都不执行）、`:295`（只关一个 → 前面的允许动作也照样整份拒绝）、`:837`（`link(duplicate)` 被 `close_issue` 开关挡住，防「换个动作名关单」）。
4. 假设「开 PR 不限制 `bot/*`、能 force push」。→ **部分被推翻**：`bot/*` 双处校验（契约 `v21.ts:332-339` + 执行器 `execute.ts:806-808`）；force push 在 git 层硬墙：`git/run-git.ts:85-101` 的 `assertNoForceArgs` 对 `--force` / `--force-with-lease` / `--force-if-includes` / `--mirror` 一律抛错，唯一例外是 `worktree remove --force`（无强推语义）。测试：`packages/envelope/test/v21.test.ts:77`（`open_pr` 只接受 `bot/*`）。**但**：`open_pr` 的执行端口只发 `POST /repos/{owner}/{repo}/pulls`（`http/webhook-v21.ts:602-621`），也就是说**平台只开 PR，不推分支**——`bot/*` 分支必须事先存在；「永不 force push」在这个动作里是「没有那条代码路径」，不是「被检查过」。
5. 假设「槽位标记不是 HTML 注释、不在末尾」。→ **被推翻**：标记是 HTML 注释且拼在正文**之后**：`writeback/v21/comments.ts:53-55`（`<!-- pi-bot:slot repo#issue:slot -->`）、`:123-129` `composeSlotBody()`（`正文 + 空行 + 标记`），注释里写明「为什么用注释不用标题前缀」（`:11-13`）。按标记查找覆盖：`:98-114` `findSlotComment()`（按槽位键语义匹配，容忍空白被手工改过）→ `planSlotWrite()`（`:161-177`：有 existing → update；无 existing 但有历史 id → create + `recreated:true`）。测试：`test/writeback-v21-comments.test.ts:29`–`:133` 逐条覆盖。
6. 假设「没有『原评论已不存在』的检测分支」。→ **被推翻**：两条分支都在——(a) 索引有 id、列表找不到 → `recreated:true`（`comments.ts:150-176`，测试 `writeback-v21-comments.test.ts:110`）；(b) update 撞 404 → 重建并**在返回值里留痕**：`execute.ts:660-672`（`isNotFoundError()` 区分「被人删了」与「网络/权限错」，后者照常抛错）+ `:293-309`；测试 `writeback-v21-execute.test.ts:409`（404 → 重建，不算失败）。
7. 假设「`同一 issue 同槽位只保留一条` 被保证」。→ **未完全证成**：只保证「后续写都打在**第一条**命中的评论上」（`comments.ts:98-114` 返回首个命中，多个命中不清理、不报错）。若历史上已存在同槽位两条评论（例如索引丢失期间重建、或人手工复制），剩余那条**永久留在 issue 上**，无人删。测试只覆盖「命中即覆盖」，没有覆盖「已有多条 → 收敛为一条」（`writeback-v21-comments.test.ts` 的 it 列表里没有这一条）。
8. 假设「动作集合就是需求那七类」。→ **被推翻（需求侧不符）**：`packages/envelope/src/v21.ts:40-53` 是 **12 类**（前七类 + v2.2 新增 `reopen_issue/update_issue/update_comment/delete_comment/link`，注释 `:28-38` 说明由来）。需求文档（行 973-989）写的是「封闭的动作集合…七类，集合外一律拒绝」。代码把封闭集合**扩到了 12**，需求没有这一版；且新增五类里 **4 类不受任何项目开关约束**（`GATED_ACTION_TYPES` 只有 3 个，见 `v21.ts:63`），其中 `update_issue`（改标题/正文）、`delete_comment`（删评论）是实打实的外溢写操作。按需求字面，这五类属「集合外」应被拒绝。
9. 假设「格式字段不符（verdict/evidence 形状）」。→ **基本符合**：`verdict` 可省（`v21.ts:442-446`，需求允许纯问答省略）、`evidence` 为字符串数组可选（`:445`、`:224-226`）、`actions[]` 必填可空数组、`actions[].type`/`payload` 必填（`discriminatedUnion`，`:423-436`）。差异：需求写 `actions[].type` 只能是七种之一，代码是十二种（同上）。
10. 假设「关单不采信模型自评」。→ **逻辑上有张力**：闸门是「顶层 `verdict === 'fail'` 才允许关」（`execute.ts:846-850`，`link(duplicate)` 同闸 `:1035-1039`），而 `verdict` **正是模型自评**。实现把它解释成「模型说已解决（pass）不能关，说没解决（fail）才允许关」，与需求「仅在确定性条件满足时执行，不采信模型自评」的严格读法不是一回事——这里是「换成另一个模型字段把关」，不是「用平台可验证的确定性条件把关」。

### 证据（文件:行号）

- 整份拒绝：`C:\Code\NodeProjects\pi-issue-bot\packages\envelope\src\v21.ts:523`–`:547`、`:634`–`:654`；测试 `packages\envelope\test\v21.test.ts:105`、`:120`、`:134`、`:143`
- 顺序执行遇失败即停：`C:\Code\NodeProjects\pi-issue-bot\apps\server\src\writeback\v21\execute.ts:431`–`:448`；测试 `apps\server\test\writeback-v21-execute.test.ts:224`、`:248`
- 三类开关：`C:\Code\NodeProjects\pi-issue-bot\packages\contract\src\settings-v21.ts:215`–`:221`；`execute.ts:390`–`:404`、`:419`–`:429`；测试 `writeback-v21-execute.test.ts:265`、`:295`、`:837`
- 十二类（非七类）：`C:\Code\NodeProjects\pi-issue-bot\packages\envelope\src\v21.ts:40`–`:53`、`:63`
- 开 PR `bot/*`：`v21.ts:332`–`:339`、`execute.ts:806`–`:808`；不推分支：`apps\server\src\http\webhook-v21.ts:602`–`:621`
- 禁止强推：`C:\Code\NodeProjects\pi-issue-bot\apps\server\src\git\run-git.ts:85`–`:101`
- 槽位标记与覆盖/重建：`C:\Code\NodeProjects\pi-issue-bot\apps\server\src\writeback\v21\comments.ts:53`–`:55`、`:98`–`:114`、`:123`–`:129`、`:150`–`:177`；`execute.ts:589`–`:684`、`:286`–`:309`；测试 `apps\server\test\writeback-v21-comments.test.ts:29`–`:133`、`writeback-v21-execute.test.ts:395`、`:409`
- 关单闸门：`execute.ts:826`–`:879`、`:1035`–`:1039`；测试 `writeback-v21-execute.test.ts:352`–`:379`、`:782`

### 缺口

1. **动作集合 7 → 12**：需求写死七类、集合外拒绝；代码扩到十二类，且新增五类中 4 类无项目开关（`update_issue` 改标题/正文、`update_comment`、`delete_comment`、`reopen_issue`），只需模型在 `actions` 里写出来即可执行（仅 tool-loop 与写回闸门另有限制）。这是与需求正文最实质的偏差。
2. **「同一 issue 同槽位只保留一条」未闭环**：只保证「打第一条」，不清理重复的历史槽位评论，也没有测试覆盖「已存在多条」的收敛。
3. **关单的「不采信模型自评」靠 `verdict=fail`（模型产出）把关**：属口径漂移，不是平台可验证的确定性条件。
4. **`open_pr` 没有分支存在性校验**：不推分支，`bot/*` 未预先存在时 GitHub 会 404，错误面落在执行阶段而非契约/前置检查。

---

## 本节整体结论

- **FR-4.1 部分实现**：v2.1 通道的内置默认模板严格符合四段顺序，且测试按**下标先后**钉住了顺序；触发词确实是结构化路由依据（首行 → `skill_ids` → 技能正文）。但顺序只由默认值保证，拼装层是纯字面替换，项目模板可任意违反；「唯一依据」在评论事件的覆盖逻辑下不成立；legacy 通道（`agent/message.ts`）仍违反四段顺序且仍可被激活。
- **FR-4.2 未实现**：全仓没有任何「首事件全量 / 后续只发变更」的判据或分支，五个默认事件模板全部带 `{{issue.content}}` 全文；`issues.edited` 的 `changes` 只用于触发判断后即丢弃。「历史由会话承担」那一半有实现（持久会话），前半句没有。
- **FR-5.1 部分实现**：没有任何按事件类型分叉「处理什么」的代码（搜 `case 'issues.` 零命中），行为完全由可配模板驱动——「换一份提示词行为就变」成立。但平台在契约包里随附了**按事件类型写死处理步骤与技能名的默认模板**，并随附内置技能正文；技能注册表（`skills/registry.ts`）是文件驱动的命令表而非事件路由表。是否算违规取决于怎么读「平台不维护技能注册表」，按字面是部分冲突。
- **FR-5.2 部分实现**：宿主工具调用通过 RACP 原始事件整体落 `run_events`（含名称/入参/返回，jsonb 原样）；**只读 issue 工具调用缺入参**（`run-task.ts:1073-1079`，且测试把「无 input」固化下来）；两套记录口径不统一，无工具调用记录契约。
- **FR-5.3 部分实现（核心校验语义成立）**：未知 type 整份拒绝、缺必填整份拒绝（错误精确到字段路径）、按序执行失败即停且记录 `stoppedAt`、已成功不回滚——四条都有实现 + 拒绝路径测试；后三类开关是真配置项（默认全 false）+ 执行前整份拒绝；槽位用文末隐藏 HTML 注释、按标记覆盖、404 / 索引失效两条「原评论已不存在」重建分支都在且有测试；开 PR 限 `bot/*`、git 层禁强推。**两处实质缺口**：动作集合从需求的 7 类扩到 12 类且新增五类里 4 类无开关（需求写「集合外一律拒绝」）；「同槽位只保留一条」只做「覆盖第一条」不做收敛。

### 附：未完成的核查与残余风险

- 未运行 `pnpm -r test` / `pnpm -r typecheck`（任务要求只读，未执行命令）；上面对测试的引用是**读代码**得到的，不是跑出来的结果。
- 工作区有 33 个未提交改动（含 `packages/envelope/src/v21.ts`、`http/webhook.ts`），本报告结论只对**当前工作区内容**成立；与 HEAD 的差异未逐行比对。
- 「七类 vs 十二类」的定性需要产品侧确认：如果 v2.2 是需求的正式增量（`docs/plan-issue-tools.md` §5），则需求文档 §5.4/§5.5 应同步为十二类并明确后五类的开关口径；否则是四类写操作突破了「封闭集合」这条安全边界。
