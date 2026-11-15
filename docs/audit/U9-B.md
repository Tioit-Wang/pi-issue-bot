# U9-B 需求实现核查（§6.1–6.6 / §6.8 / §6.9）

- 需求文档：`docs/requirements.html` 行 1447–1773
- 仓库：`C:\Code\NodeProjects\pi-issue-bot`
- 方法：反证视角 —— 默认「未真正实现」，只有代码里找到**不可辩驳的实现点**才推翻；文档、注释、测试名都不算证据，只看运行时被执行的代码路径。
- 只读：未修改仓库任何文件。

---

## 6.1 两个层级（平台级只管模型与 bot 身份；其余全部项目级）

**状态：部分实现**

### 反证过程

1. 先假定「项目级只是摆设，实际仍在平台级」。查平台配置面：`env` 键清单 + `AppConfig` 只有 DB/HTTP/metrics/webhook secret/日志/迁移目录/panel 开关/沙箱与 host 路径/GitHub 身份（app 或静态 token）/模型三件套。没有并发、日配额、超时、保留期、事件开关、模板、关键词、角色、标签目录、系统提示词的 env 入口。→ 平台级确实只剩「模型 + bot 身份 + 部署基础设施」。
2. 再假定「项目级字段在契约里有，但运行时没人读」。逐个查消费点：
   - 系统提示词：`resolveAgentExecution().system_prompt` → `app/compose.ts` 传给 `v21.systemPrompt` → `run-task` 的 `session/create`。**有消费点**。
   - 并发：真正生效的是 `concurrencyPerRepoOf()` 读**顶层** `settings.limits.concurrency_per_repo`，接到 `registerTaskWorker` 的队列闸门。**有消费点，但读的不是 v2.1 那个字段**。
   - 日配额：`dailyQuotaExceeded` 在全仓只有三处出现（两处类型定义、一处判定分支），**没有任何生产者**；`quota_counters` 表只有 schema 与导出，没有任何读写 SQL。→ **配了不生效**。
   - 单轮超时：`runTask` 的 `timeoutMs` 来自 `timeoutMsForCommand()`，该函数只返回 20 或 30 分钟常量；`compose.ts` 注入的 `timeoutForCommand` 调用的还是同一个常量函数。`turn_timeout_minutes` **没有读取方**。
   - 数据保留期：`retention-cleanup.ts` 用全局常量 `RETENTION_DAYS = 90`，不读仓库配置。
   - 标签目录 / 提及关键词 / 角色清单 / 事件开关 / 事件模板：均有真实消费点（见后文各节）。
3. 第三层反证：面板是否有对应的可编辑入口（否则等于没实现）。四个执行字段、legacy limits、mentions、roles、标签目录、事件开关与模板都有输入控件。

### 证据

- 平台级只有模型与 bot 身份：`apps/server/src/config/env.ts:14`、`apps/server/src/app/config.ts:30`、`apps/server/src/app/config.ts:155`、`apps/server/src/app/config.ts:173`
- 项目级契约：`packages/contract/src/settings-v21.ts:231`（system_prompt / concurrency / daily_quota / turn_timeout_minutes / actions / data_retention_days）、`packages/contract/src/settings-v21.ts:198`（mentions + roles）、`packages/contract/src/settings-v21.ts:326`（五事件开关）、`packages/contract/src/repo-config.ts:97`（labels.vocabulary）、`packages/contract/src/repo-config.ts:211`（repos.settings 整体形状）
- 面板编辑面：`apps/panel/src/components/settings/v21-agent-section.tsx:30`（四个执行字段）、`apps/panel/src/components/settings/v21-agent-section.tsx:243`（legacy limits 写顶层 `limits`）、`apps/panel/src/components/settings/v21-events-section.tsx:116`（mentions）、`apps/panel/src/components/settings/v21-events-section.tsx:500`（roles）、`apps/panel/src/components/settings/labels-section.tsx:155`（目录九列）
- 并发生效于 legacy 字段：`apps/server/src/queue/repo-concurrency.ts:30`、`apps/server/src/app/compose.ts:1513`
- 日配额无生产者：`apps/server/src/http/webhook-v21.ts:118`、`apps/server/src/trigger/decide.ts:119`、`apps/server/src/trigger/decide.ts:251`、`apps/server/src/db/schema.ts:634`
- 单轮超时被常量顶掉：`apps/server/src/worker/run-task.ts:457`、`apps/server/src/app/compose.ts:1389`
- 保留期全局常量：`apps/server/src/jobs/retention-cleanup.ts:25`
- 系统提示词真实落到 system 通道：`apps/server/src/app/compose.ts:1407`、`apps/server/src/worker/run-task.ts:838`

### 缺口

1. **v2.1 的 `agent.limits.concurrency` 是一个死字段**：面板给它挂了「并发会话数（1–8）」的控件，但队列闸门读的是顶层 `limits.concurrency_per_repo`。两个并发旋钮并存，只有老的那个有效。
2. **日配额完全不生效**：无计数、无闸门、无拒绝理由。需求要求「拒绝处理并记录原因，可查」。
3. **单轮超时不生效**：需求要求「单轮执行的最长时长」可配，实际恒为 20/30 分钟常量。
4. **数据保留期不生效**：需求把保留期列为项目级内容，实际是全局 90 天。
5. 附带（不影响本节结论）：平台级还残留 `PI_BOT_FREE_MENTION` 这类**业务**开关，严格按 §6.1 的「平台级只管两件事」应下放到项目级。

---

## 6.2 继承与覆盖（内置默认 / 整体覆盖 / 下一个事件生效 / 快照）

**状态：部分实现**

### 反证过程

1. 假定「业务默认来自平台级配置」。查 `resolveAgentExecution` / `v21TemplateOf` / `V21_DEFAULTS`：默认值全部是随程序发布的契约常量（`V21_DEFAULTS`、`DEFAULT_EVENT_TEMPLATES`、`AGENT_IDENTITY_PROMPT`），没有任何平台级 settings 表参与。→ 推翻，符合「内置出厂默认」。
2. 假定「项目模板与内置模板被拼接」（这是最容易假装实现的一条）。`v21TemplateOf()` 只有两个分支：`prompt === null || prompt.trim() === ''` → 内置模板；否则**整个**用项目模板。系统提示词同理（非空整体用，空则回落内置）。没有 `默认 + 项目` 的字符串拼接。→ 推翻。
3. 假定「快照只是注释」。查一次投递的调用链：`handleWebhook` 内 `readRepoPolicy()` 读一次得到 `policy`，随后 `decideV21Delivery({ settings: policy.settings })`（判定）与 `handleV21Webhook({ settings: policy.settings })`（模板选择 + 渲染 + 落库）用的是**同一个对象**。→ 判定与渲染同源，这条成立。
4. 继续追「开始的那一轮不受影响」。执行侧 `executeTask` **重新** `readRepoPolicy()`，并用这份新 settings 决定：系统提示词、标签词表注入、动作开关、标签目录（目标态）、max_per_issue。`createV21Executor` 甚至在**执行那一刻**再读一次库。→ 「判定之后、执行之前」改配置，本轮执行会吃到新配置。快照**没有落库**，也没有随任务携带。

### 证据

- 内置默认：`packages/contract/src/settings-v21.ts:344`（V21_DEFAULTS）、`packages/contract/src/settings-v21.ts:473`（五个默认事件模板）、`apps/server/src/skills/prompt.ts:75`（AGENT_IDENTITY_PROMPT）、`apps/server/src/config/v21-settings.ts:200`（回落裁决）
- 整体覆盖：`apps/server/src/http/webhook-v21.ts:359`（模板二选一，不拼接）、`apps/server/src/config/v21-settings.ts:204`（系统提示词非空整体用）
- 判定与渲染同一份：`apps/server/src/http/webhook.ts:1164`、`apps/server/src/http/webhook.ts:1195`、`apps/server/src/http/webhook.ts:1262`
- 执行期重新读：`apps/server/src/app/compose.ts:1113`、`apps/server/src/app/compose.ts:1403`、`apps/server/src/app/compose.ts:1407`、`apps/server/src/http/webhook-v21.ts:682`
- 测试绑定：`apps/server/test/prompt-render.test.ts`（12 个占位符）、`apps/server/test/v21-settings.test.ts`（默认值）

### 缺口

1. **配置快照不持久化**：判定的那一份 settings 只活在进程内存里，执行侧重新读库。需求原文要求「配置随事件打成快照，保证判定与渲染用同一份配置」——判定与渲染确实同一份，但「已经开始的那一轮不受影响」在跨到执行阶段后不成立（改动作开关/目录会立即影响在跑的那一轮的写回判定）。
2. 同一语义存在两条路径：`agent.system_prompt` 与 `agent.limits.system_prompt`（`packages/contract/src/repo-config.ts:180`、`apps/server/src/config/v21-settings.ts:204`），动作开关也是「两处取或」（`apps/server/src/config/v21-settings.ts:213`）。不是拼接，但它是「整体覆盖」的软肋：同一配置有两个存放点，判定靠优先级而不是靠唯一来源。

---

## 6.3 十二个占位符 / 标签列表格式 / issue 列表规模控制

**状态：已实现（两项细节偏差）**

### 反证过程

1. 假定「文档列了 12 个，代码里少几个」。契约清单 12 条；渲染器 `resolvePlaceholder()` 的 switch 逐条对应 12 个到 `''` 兜底前的分支。单测断言「清单就是 12 个，不多不少」+「每个都能渲染出值」+「取值口径逐项对得上需求表格」。→ 12 个齐全。
2. 假定「标签列表被 sort 过」。`RenderIssue.labels` 注释即写「保持 GitHub 返回的顺序，不排序」；`webhook-v21.ts` 从 payload 直接 map，无 sort；`join(', ')`；空集合渲染空串（`stringify` 前不填占位词）。单测有「保序：不做排序」。→ 未排序，符合。
3. 假定「repo.issues 的 200/open/排除 PR/惰性/5 分钟缓存里有几项只是文档」。逐项找实现：
   - 上限 200：`REPO_ISSUES_MAX_ITEMS = 200` + `.slice(0, 200)`；超出补「（共 N 条，仅列最近 200 条）」，未超不补。
   - 仅 open：`listIssues({ state: 'open' })`，类型层面 `state: 'open'` 是字面量。
   - 排除 PR：`!entry.isPullRequest`，适配器把 GitHub 的 `pull_request` 字段原样透传。
   - 倒序截断：`byUpdatedAtDesc`（时间倒序，同时间按编号倒序保证稳定）。
   - 惰性：两道闸 —— `needsRepoIssues(template)` 为假时连 provider 都不取，为真时才把函数交给 `renderTemplateAsync`，后者内部再判一次。
   - 5 分钟缓存：`REPO_ISSUES_DEFAULT_TTL_MS = 5*60*1000`，另有 in-flight 去重、代数（generation）防止失效后被旧结果覆盖；进程装配只建一份 provider（WeakMap 按 deps 复用）。
   → 六项都有实现，且都有对应单测（范围/排除/上限/缓存各一 describe）。
4. 继续找偏差，发现两处：
   - 「共 N 条」的 N 来自 GitHub issues 接口的 total（由 Link 头 `page=last × perPage` 推算），**含 PR**；而列表本体排除了 PR。于是「共 N 条」会比真实 open issue 数偏大（PR 越多偏得越多）。
   - 「范围默认仅 open，需要时按项目配置改」：`state: 'open'` 是硬编码字面量，`RepoIssuesLister` 的类型也只接受 `'open'`，没有项目级开关。

### 证据

- 12 个清单：`packages/contract/src/settings-v21.ts:420`
- 渲染实现：`apps/server/src/prompt/render.ts:132`
- 标签格式与空串：`apps/server/src/prompt/render.ts:150`；保序：`apps/server/src/prompt/render.ts:40`、`apps/server/src/http/webhook-v21.ts:307`
- repo.issues 四条硬约束：`apps/server/src/prompt/repo-issues.ts:38`、`apps/server/src/prompt/repo-issues.ts:106`、`apps/server/src/prompt/repo-issues.ts:120`、`apps/server/src/prompt/repo-issues.ts:127`
- 惰性：`apps/server/src/prompt/render.ts:93`、`apps/server/src/prompt/render.ts:193`、`apps/server/src/http/webhook-v21.ts:464`
- 5 分钟缓存 + 并发去重：`apps/server/src/prompt/repo-issues.ts:47`、`apps/server/src/prompt/repo-issues.ts:139`、`apps/server/src/http/webhook-v21.ts:257`
- 取数失败不伪造：`apps/server/src/http/webhook-v21.ts:477`
- 单测：`apps/server/test/prompt-render.test.ts:40`、`apps/server/test/prompt-render.test.ts:120`、`apps/server/test/prompt-repo-issues.test.ts:58`、`apps/server/test/prompt-repo-issues.test.ts:90`、`apps/server/test/prompt-repo-issues.test.ts:122`

### 缺口

1. 「共 N 条」把 PR 计入总数，与「排除 PR」自相矛盾（`apps/server/src/prompt/repo-issues.ts:112` + `:127`）。
2. 「仅 open 可按项目配置改」未实现（`apps/server/src/prompt/repo-issues.ts:30` 与 `:110` 都锁死 `'open'`）。

---

## 6.4 配置示例（triggers / enabled / prompt / only_body_changed / require_mention / require_role / ignore_bot / allow_closed）

**状态：已实现**（字段名属「待设计阶段确定」，允许与示例不同）

### 反证过程

逐一核对示例里的每个键是否在契约里存在且被运行时读取：
- `triggers.issues.opened|edited|labeled|closed|issue_comment.created` → `eventTriggersSchema` 五个键全预置默认值。
- `enabled` → 三态 `on/off/conditional`（比示例的布尔更强）。
- `prompt` → `string | null`，null = 内置默认。
- `only_body_changed` → 存在，且只有 `issues.edited` 才被解释（其它事件恒 false）。
- `require_mention` / `require_role` / `ignore_bot` / `allow_closed` / `allow_roles` → 都在 `gates` 子对象；比示例多一个 `allow_roles`（示例里也有）。
- `labels`（labeled 事件的触发标签）→ 存在，空数组 = 永不触发。

差异：示例把它们平铺在事件对象下，实现收进 `gates` 子对象。示例自己写了「字段名待设计阶段确定」，故不算冲突。

### 证据

- `packages/contract/src/settings-v21.ts:81`（eventTriggerSchema）、`packages/contract/src/settings-v21.ts:105`（commentGatesSchema）、`packages/contract/src/settings-v21.ts:304`（commentEventTriggerSchema，prompt 收紧为 conditional）、`packages/contract/src/settings-v21.ts:326`（五事件默认值）
- 运行时解释：`apps/server/src/config/v21-settings.ts:105`（onlyBodyChanged 只在 edited 生效）、`apps/server/src/config/v21-settings.ts:132`（gates）

### 缺口

无功能缺口。唯一可说的是「示例与实现的嵌套层级不同」，而示例已声明字段名待定，不构成偏差。

---

## 6.5 标签目录（五字段 / 三条同步规则 / 含义为空不进对齐 / 固定注入 / 行格式）

**状态：部分实现**，其中「同步规则」「按需刷新」「固定注入」三项实质缺失

### 反证过程

1. 五字段：契约条目有 name / role / meaning / color / description / group / managed / status；面板表头就是九列（name、角色、meaning、color、description、group、自动对齐、status、操作）。「名称不改写」由面板自由输入 + 保存时按 GitHub 同名匹配来体现（拼错走 `labels.missing` 策略）。→ 五字段齐（且多出 role/managed）。
2. 「含义为空不进自动对齐范围」：写回层有 `isManageableCatalogEntry()`（managed≠false && status='active' && meaning 非空）与 `unmanageableReason()` 返回 `missing-meaning`；`desired` 含不可管理标签 → 整条 `unknown-label` 拒绝；`remove` 只在可管理集合内产生，不可管理的当前标签进 `skipped` 留痕。→ **真实现**。
3. 「目录不作为模板占位符」：12 个正式占位符里没有目录类名字。→ 成立。
4. 「由平台固定注入、位置紧跟系统提示词」：
   - 注入函数存在（`renderLabelVocabulary`），但它挂在 `renderSkillPrompt()` 的**技能层内部**，位于 `## 指令`（技能正文）之后、`## 任务上下文` 之前。
   - 装配层序是 `head(系统提示词) → 项目约定 → AGENTS.md → 技能层`，目录在**最后一层里**。
   - 更硬的反证：**未命中技能**时 `projectPrompt` 只拼「技能目录 + issue 能力清单」，**完全没有标签词表**；此时 `basePrompt` 走 `buildTaskPrompt()`，词表在整条提示词的最末尾（输出契约之后、`## 这一条消息` 之前）。
   → 既不是「紧跟系统提示词」，也不是「无条件固定注入」。
5. 「只列含义非空的」：渲染函数对 `meaning === undefined` 的条目**照样输出一行**（只有名字的裸项）；单测甚至钉住了这个行为（断言 `label-59` 存在而它的 meaning 是 undefined）。另外也不按 `managed` / `status: retired` 过滤。→ **与需求冲突**。
6. 「每行 名称 | 含义 | 分组」：实际是 `- \`名称\`：含义；互斥组：X（同组只打一个）`，测试同样钉住了该格式。信息齐全但形式不符。
7. 三条同步规则 + 目录有效期：全仓只有一个 GitHub labels 调用点（`GET/POST /repos/:o/:r/labels`），用途是 `labels.missing` 策略下的「缺哪个建哪个」。没有任何「把仓库标签拉进 `settings.labels.vocabulary`」「给新增标签建空含义条目」「把被删标签标 retired」的代码；也没有目录刷新时机 / TTL。→ **未实现**，且 `missing='create'` 会**反向在 GitHub 上创建标签**，与「平台不发明标签、不反向创建」直接冲突（opt-in 但存在）。

### 证据

- 字段：`packages/contract/src/repo-config.ts:76`、`packages/contract/src/settings-v21.ts:275`（labelStatusSchema `:253`）、面板 `apps/panel/src/components/settings/labels-section.tsx:155`
- 含义为空过滤：`apps/server/src/writeback/v21/labels.ts:82`、`apps/server/src/writeback/v21/labels.ts:103`、`apps/server/src/writeback/v21/labels.ts:163`、`apps/server/src/writeback/v21/labels.ts:187`
- 目录注入点：`apps/server/src/skills/prompt.ts:254`、`apps/server/src/skills/prompt.ts:717`
- 未命中技能时不注入词表：`apps/server/src/app/worker-deps.ts:958`（只拼技能目录与能力清单）、`apps/server/src/app/worker-deps.ts:977`（只有命中技能才走 `renderSkillPrompt`）
- 层序：`apps/server/src/skills/assemble.ts:397`、`apps/server/src/skills/assemble.ts:408`
- 只列含义非空未实现（含单测反向钉住）：`apps/server/src/skills/prompt.ts:270`、`apps/server/src/skills/prompt.ts:282`、`apps/server/test/skills-prompt.test.ts:213`
- 行格式：`apps/server/src/skills/prompt.ts:282`、`apps/server/test/skills-prompt.test.ts:207`
- 唯一 labels 通道（含反向创建）：`apps/server/src/app/worker-deps.ts:609`、`apps/server/src/app/worker-deps.ts:622`、`packages/contract/src/repo-config.ts:105`

### 缺口

1. **无 GitHub → 目录同步**：新增标签不会自动进目录（含义为空待补）、删除标签不会标 retired。需求的三条同步规则一条都没有落地代码。
2. **目录无有效期/无按需刷新**：不存在刷新时机，也就谈不上「避免拿过期目录做删除判断」。
3. **目录不是固定注入**：未命中技能的轮次完全拿不到目录；命中技能时也不在系统提示词之后，而在技能正文之后。
4. **没有按「含义非空」筛行**，也没排除 retired/managed=false；这与同仓写回层的可管理集合口径（`labels.ts:82`）不一致 —— 提示词给模型看的候选集比目标态允许的更大，正是需求警告的「盲删」场景的相对面（模型看到不能用的标签）。
5. **行格式与需求不同**（`名称：含义；互斥组：…` vs `名称 | 含义 | 分组`）。
6. `labels.missing = 'create'` 与「平台不发明标签、不反向创建」冲突（需产品确认：是需求该放宽，还是这个选项该删）。

---

## 6.6 评论触发配置（提及关键词 / 角色清单 / 两个坑）

**状态：部分实现**（关键词已实现；角色清单**缺用户 id、缺账号存在性校验**，面板只支持一半判定方式）

### 反证过程

1. 关键词：数组、`min(1).max(10)`、`case_sensitive` 可选缺省 false；判定器做大小写归一比较、`@` 前导字符禁区、关键词后必须分隔符、同位置最长优先、代码区先蒙版。→ **真实现**。
2. 判定方式二选一：契约是**判别联合**（`by: 'association' | 'members'`），能表达示例里的 `any_of: [OWNER, MEMBER, COLLABORATOR]` 与 `members: [alice, bob]`；七种 association 取值齐全。运行时 `roleMatches` 分别按 association 归一比较 / 按 members 的 login 小写比较。→ 契约与判定都实现了两种方式。
3. 坑一「login 会变，要同时存用户 id，匹配以 id 为准」：全仓搜 `member_id` / `memberId` / `user_id` / `userId` —— **零命中**；契约里 members 就是 `z.array(login)`，没有任何 id 字段；判定只比 login。→ **未实现**。
4. 坑二「保存时校验账号存在，不存在就拒绝」：搜 `users/{login}` / `getUser` / `checkToken` —— **零命中**。保存期校验只有「角色名重复」「allow_roles 引用了未定义角色」「关键词重复」。面板新增角色时成员**直接取项目管理员 login**（不查存在性，注释也承认「避免凭空造出不存在的 login」）。→ **未实现**。
5. 附加反证（面板）：`RoleEditor` 只能新增 `by: 'members'` 的角色，没有「作者关联」录入路径，也没有编辑成员列表的控件；`setMentions` 重建 mentions 时只写 `{ keyword }`，会把已有的 `case_sensitive: true` 抹掉；面板没有「是否区分大小写」开关。→ 需求里「可配多个 + 可选大小写 + 二选一判定方式 + 只支持个人 login」在面板上只落地了一部分。

### 证据

- 关键词契约：`packages/contract/src/settings-v21.ts:131`；判定：`apps/server/src/trigger/mention.ts:100`、`apps/server/src/trigger/mention.ts:134`
- 角色契约：`packages/contract/src/settings-v21.ts:147`（七种 association）、`packages/contract/src/settings-v21.ts:170`（判别联合）、`packages/contract/src/settings-v21.ts:184`（members 只收 login）
- 运行时匹配只看 login：`apps/server/src/trigger/roles.ts:41`、`apps/server/src/trigger/roles.ts:59`
- 保存期校验只有引用/重名：`packages/contract/src/settings-v21.ts:380`、`packages/contract/src/settings-v21.ts:395`、`packages/contract/src/repo-config.ts:294`
- 面板只能造成员型角色且成员取自管理员：`apps/panel/src/components/settings/v21-events-section.tsx:512`
- 面板保存 mentions 丢弃 case_sensitive：`apps/panel/src/components/settings/v21-events-section.tsx:117`

### 缺口

1. **成员只存 login，不存 GitHub 用户 id**；匹配以 login 为准 —— 需求明确点出的「改名后被他人注册即误授权」风险原样存在。
2. **保存时不校验账号是否存在** —— 需求点名的「拼错静默失效」原样存在（拼错只会让那个人永远触发不了，没有任何报错）。
3. 面板无法配置「作者关联」型角色，也无法编辑成员列表；`case_sensitive` 没有 UI 且保存会被重置为默认。

---

## 6.8 供应商与模型角色（CFG-8.1 / 8.2 / 8.3）

**状态：未实现**

### 反证过程

1. CFG-8.1「供应商一条一行」：查三处 —— 表（`db/schema.ts` 全部 `pgTable` 清单里没有 providers/供应商表）、API（`http/api/index.ts` 路由清单只有 overview/tasks/costs/quality/audit/system/issues/repos/settings）、面板（`system.tsx` 只有「版本与协议 / doctor 逐项检查 / 队列与保留策略 / 仓库」四段）。→ 无供应商实体、无 CRUD、无连通性测试、无 model 列表、无 key 掩码展示。
2. 模型配置实际形态：单一端点的三个 env（key / baseUrl / name），换算成 pi-host 子进程的 `OPENAI_*` 环境变量。没有「多家供应商」概念。
3. CFG-8.1 的安全条「key 加密存储、解密失败必须报错」：AES-256-GCM 加解密模块确实存在且 `decryptSecret()` 失败会抛 `CRYPTO_DECRYPT_FAILED`（不静默）—— 但它服务的是 **RACP 设备令牌**（`host_credentials.token_enc`），与模型 key 无关；模型 key 是从 env 读进来的明文，既不入库也不解密。
4. CFG-8.2「四档角色 + 单价」：没有 `agent` / `format` / `classify` / 兜底 四档配置；只有一个全局模型名。单价不是界面字段而是**写死在代码里的 DeepSeek 两档价目**（flash / pro，各含 cacheHit / cacheMiss / output），按模型名里是否含 `pro` 判档。成本页在需求里已被删除，但单价也没有出现在任何「模型角色」界面上。
5. CFG-8.3「全局默认，项目可覆盖；项目级显示『继承全局（模型名）』点开才允许覆盖」：项目级只有一个自由文本「默认模型（provider/model，可留空）」，不是「继承全局（模型名）」的点开态；更关键的是 **这个字段没有任何读取方** —— 全仓搜 `limits.model` / `settings.model` 的消费点为零，运行时模型只来自 env。→ 项目级覆盖是死字段。

### 证据

- 无供应商表：`apps/server/src/db/schema.ts:146` 起至 `apps/server/src/db/schema.ts:793` 的表清单（repos/tasks/runs/.../agent_compactions，无供应商）
- 无相关 API：`apps/server/src/http/api/index.ts:101`–`:345`（路由清单）
- 面板无供应商分区：`apps/panel/src/routes/system.tsx:137`、`:176`、`:222`、`:278`
- 模型只有 env 单端点：`apps/server/src/app/config.ts:173`、`apps/server/src/app/model-env.ts:36`
- 单价写死在代码、仅两档：`apps/server/src/cost/pricing.ts:29`、`apps/server/src/cost/pricing.ts:47`
- 加解密存在但用于设备令牌：`apps/server/src/runtime/crypto.ts:146`、`apps/server/src/runtime/crypto.ts:186`
- 项目级模型字段及其中文标签：`packages/contract/src/repo-config.ts:219`、`apps/panel/src/components/settings/v21-agent-section.tsx:262`
- 该字段无运行时消费点（`limits.model` / `settings.model` 无命中）

### 缺口

1. CFG-8.1 全部缺失：供应商行、连通性状态点与手动测试、可用 model 列表、key 掩码（已存/未配置）、key 加密入库。
2. CFG-8.2 全部缺失：四档角色（agent / format / classify / 兜底）、每档绑定的「供应商 + 模型」、每档输入/输出单价展示。
3. CFG-8.3 缺失：没有「继承全局（模型名）」的继承态与点开覆盖交互；现存的项目级 `model` 字段是死字段（写了不影响运行）。
4. 附带风险：需求把「单价」定为界面上唯一能解释费用的依据，而当前单价只能看代码常量 —— 面板上无处显示。

---

## 6.9 面板身份（CFG-9.1 默认 bot / 可切个人 PAT；CFG-9.2 令牌不可用必须说清楚）

**状态：未实现**

### 反证过程

1. CFG-9.1「未配置个人令牌用 bot 署名，配置了个人 PAT 用该用户身份」：查身份解析 —— 只有四种模式 `app` / `token` / `none` / `degraded`，其中 `token` 是**部署级**静态 token（`PI_BOT_GITHUB_TOKEN`），不是「面板里切换的个人 PAT」。没有按用户存储 PAT 的列（`db/schema.ts` 里唯一的密文列是 `host_credentials.token_enc`，属于 RACP 设备令牌），没有相关 API，面板也没有身份设置项。
2. 「提供『检查权限』校验 scope 与过期时间」：搜 `X-OAuth-Scopes` / `x-oauth` / `checkToken` / `users/{}` 全部零命中；`github/auth.ts` 只做 App 认证（appId + PEM → installation token），完全不涉及 PAT scope 或过期时间。
3. CFG-9.2「令牌缺失 / scope 不足 / 已过期时，写回失败原因显式呈现，并退回 bot 身份」：这三种失败态在当前身份模型下**不可能发生**（没有个人令牌参与写回），因此也没有对应的呈现逻辑与「退回」路径。可对得上的是另一件事：认证缺配置时 `github-auth.ts` 会给出 `degraded` / `none` 并把原因写进 `detail`（不是静默），`crypto.ts` 解密失败也必抛 —— 但都不是需求所指的「个人 PAT 不可用」。

### 证据

- 身份只有四种模式：`apps/server/src/app/github-auth.ts:21`、`apps/server/src/app/github-auth.ts:52`、`apps/server/src/app/github-auth.ts:106`
- App 认证唯一实现、不涉及 PAT：`apps/server/src/github/auth.ts:83`、`apps/server/src/github/auth.ts:205`
- 无 scope / 过期检查（全仓 `X-OAuth-Scopes` / `checkToken` 零命中）
- 无指纹相关表/接口：`apps/server/src/db/schema.ts:514`（host_credentials 是设备令牌）、`apps/server/src/http/api/index.ts:101`（路由清单无身份接口）
- 缺配置时的显式降级（非静默的旁证，但不是 9.2）：`apps/server/src/app/github-auth.ts:56`、`apps/server/src/app/github-auth.ts:86`、`apps/server/src/runtime/crypto.ts:186`

### 缺口

1. CFG-9.1 全部缺失：个人 PAT 的录入、加密存储、掩码显示、「以该用户身份提交评论」、`issues: write` 权限要求、以及「检查权限」的 scope 与过期时间校验。
2. CFG-9.2 全部缺失：令牌缺失 / scope 不足 / 过期三种态的显式呈现与「退回 bot 身份」的降级路径都不存在（因为个人 PAT 这个前置概念不存在）。

---

## 本节整体结论

- **真实现的部分**集中在「一个事件的配置读取 + 模板渲染」这条链上：12 个占位符（含标签逗号分隔/不排序/空串/事件时快照）、`{{repo.issues}}` 的四条硬约束与惰性/5 分钟缓存/并发去重、事件开关与模板的整体覆盖（不拼接）、内置出厂默认、提及关键词的合法提及判定、标签目录「含义为空不进自动对齐」、以及写回层的目录外/retired/unmanaged/missing-meaning 四类拒绝。
- **表面实现但运行时不通**的一类是项目级限额：`agent.limits` 的并发/日配额/单轮超时/保留期四项中，三项（日配额、单轮超时、保留期）没有任何执行面读取；并发实际由另一处 legacy 字段（`limits.concurrency_per_repo`）生效，v2.1 那个并发字段是死字段。
- **结构性缺失**两章：§6.8 供应商与四档模型角色（含单价、key 加密、继承/覆盖）与 §6.9 面板身份（个人 PAT、检查权限、失败显式呈现+退回 bot）**都没有任何实现**，模型仍只有「一个 env 端点 + 写死价目」，身份仍只有「App / 部署级静态 token」。
- **需求点名的两个坑原样存在**：角色清单只存 login 不存用户 id、保存时不校验账号存在 —— 改名误授权与拼错静默失效都还是开放风险。
- **标签目录最偏离**：五字段与「含义为空不进对齐」做到了，但三条同步规则、目录有效期刷新、以及「固定注入且紧跟系统提示词、只列含义非空、每行『名称 | 含义 | 分组』」全部不成立；未命中技能的轮次干脆看不到目录，而提示词里列出的候选集比目标态允许的更大（未按含义/retired/managed 过滤），与需求「看不到全量标签却输出目标态 = 盲删」的防护意图相反。
- 另一处需产品裁决的冲突：`labels.missing = 'create'` 会在 GitHub 上反向创建标签，与 §6.5「平台不发明标签、不反向创建」直接矛盾。
