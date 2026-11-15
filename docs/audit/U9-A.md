# U9-A 需求实现核查：配置模型（requirements.html §6.1–6.6 / §6.8 / §6.9）

- 需求正文：`C:\Code\NodeProjects\pi-issue-bot\docs\requirements.html`，审查范围行 1447–1773（逐节：6.1→1447、6.2→1467、6.3→1481、6.4→1559、6.5→1589、6.6→1638、6.8→1742、6.9→1762）。6.7（1707–1739）不在本次核查范围内，仅在引用时提及。
- 代码基线：工作区当前状态（`git log -3` 头部 `fbfa029 docs(requirements): 面板改版并入需求正文，撤掉面板内发送`），**工作区有大量未提交改动**（`apps/server/src/config/*`、`skills/builtin.ts`、`packages/envelope/src/v21.ts` 等），本报告以磁盘上的当前内容为准。
- 方法：只读静态核对（读契约、服务端、面板、迁移/表结构、测试用例名），并跑了 4 组相关单测作旁证（见文末“验证记录”）。**未修改任何仓库文件。**
- 状态取值：已实现 / 部分实现 / 未实现 / 与需求冲突 / 无法判定。

---

## 6.1 两个层级（平台级 = 模型 + bot 身份；其余全部项目级）

**状态：部分实现**

### 证据

平台级（只有模型与 bot 两组，且都只从环境变量来）：

- `apps/server/src/app/config.ts:89-98`：模型三项 `PI_BOT_MODEL_API_KEY` / `PI_BOT_MODEL_BASE_URL` / `PI_BOT_MODEL_NAME`（含 `OPENAI_*` / `DEEPSEEK_*` 别名）。
- `apps/server/src/app/config.ts:73-84`：bot 身份侧 `PI_BOT_GITHUB_APP_ID` / `PI_BOT_GITHUB_APP_PRIVATE_KEY_PATH` / `PI_BOT_GITHUB_INSTALLATION_ID` / `PI_BOT_GITHUB_TOKEN` / `PI_BOT_MENTION`（句柄）。
- `apps/server/src/app/config.ts:173-180`（`AppConfig.model`）、`:155-165`（`AppConfig.github`）、`:410-414`（装配）、`apps/server/src/app/model-env.ts:23-51`（换算成 pi-host 的 `PI_BOT_MODEL_*` / `OPENAI_*`）。
- 平台级没有任何业务默认值：`packages/contract/src/repo-config.ts:211-239` 的 `repoSettingsShapeSchema` 里只有业务段（triggers/comment/labels/skills/limits/agent）。

项目级（需求列举的每一项都有对应配置键）：

| 需求项 | 实现位置 |
|---|---|
| agent 系统提示词 | `packages/contract/src/settings-v21.ts:234`（`agentExecutionSchema.system_prompt`）、`repo-config.ts:184`（`agent.system_prompt`） |
| 并发数 / 日配额 / 单轮超时 | `settings-v21.ts:236-240`（`concurrency` 1–8 / `daily_quota` 1–1000 / `turn_timeout_minutes` 1–30） |
| 事件开关 + 事件提示词模板 | `settings-v21.ts:81-91`（`eventTriggerSchema`）、`:326-334`（五事件默认值表） |
| 评论提及关键词 | `settings-v21.ts:131-144` |
| 角色清单 | `settings-v21.ts:170-187` |
| 标签目录（含与 GitHub 同步） | `repo-config.ts:76-110`、`settings-v21.ts:275-292`（同步部分见 §6.5） |
| 数据保留期 | `settings-v21.ts:244`（`data_retention_days`，默认 90） |

面板侧读写这些项目级配置：`apps/panel/src/components/settings/v21-agent-section.tsx:31-59,145-190`（系统提示词 + 四个限额）、`v21-events-section.tsx:101-465`（事件开关/模板/闸门/关键词/角色）、`labels-section.tsx:71-333`。

### 缺口

1. **平台级没有任何面板界面，也没有配置载体**：模型端点与 bot 身份只能改 `EnvironmentFile` 里的环境变量；面板没有“全局/供应商”入口（`apps/panel/src/routes/` 只有 `system.tsx` 诊断页与项目级 `repo-settings.tsx`）。§6.1 本身只规定“层级归属”，没规定界面，因此这算层级成立、形态缺失；但它直接压住了 §6.8/§6.9（见下）。
2. **“调用参数”未实现**：§6.1 平台级内容列了“端点地址、模型名、密钥、调用参数”，全仓无 `temperature` / `max_tokens` / `top_p` 之类的配置项（仅出现在 `doctor/checks/model-endpoint.ts:6` 的注释里）。
3. 项目级 `data_retention_days` 只有配置与解析（`config/v21-settings.ts:218`），清理作业用的是固定常量 `RETENTION_DAYS = 90`（`apps/server/src/jobs/retention-cleanup.ts:25`）——即“项目级保留期”目前不驱动清理。属 §6.1 列举项与运行行为没打通（严格说清理口径归 §7.6，此处只记录“配置已存在、未消费”）。

---

## 6.2 继承与覆盖（内置默认 / 回落 / 整体覆盖 / 下一个事件生效 / 配置快照）

**状态：部分实现**

### 证据

- **“默认”是内置默认（出厂值）**：`packages/contract/src/settings-v21.ts:338-369`（`V21_DEFAULT_EVENT_TRIGGERS` / `V21_DEFAULT_COMMENT` / `V21_DEFAULT_COMMENT_GATES` / `V21_DEFAULT_AGENT_EXECUTION` / `V21_DEFAULTS` 单一出口）、`:473-549`（五事件内置模板 `DEFAULT_EVENT_TEMPLATES`）、`:561-572`（内置系统提示词 `DEFAULT_SYSTEM_PROMPT`）、`apps/server/src/skills/prompt.ts:75`（`AGENT_IDENTITY_PROMPT`，运行期真正下发的那一份）、`repo-config.ts:370`（`DEFAULT_REPO_SETTINGS`）。
- **未配置回落到内置默认**：默认值全部写在 schema 里（`.default()` / `.prefault({})`，如 `settings-v21.ts:328-332`、`repo-config.ts:222-237`）；解析入口 `apps/server/src/config/v21-settings.ts:70-77`（`readV21Settings`，坏配置回落 `DEFAULT_REPO_SETTINGS` 且带 `ok:false`）。
- **整体覆盖、不追加不拼接**：模板二选一——`apps/server/src/http/webhook-v21.ts:359-362`（项目 `prompt` 非空则整体替换，`null`/空白才用内置模板，不存在拼接）；系统提示词二选一——`config/v21-settings.ts:200-222`（`agent.system_prompt` → `agent.limits.system_prompt` → `AGENT_IDENTITY_PROMPT`，逐级**替换**而非合并）。
- **改动对下一个事件生效**：配置按投递读取并由装配层注入（`apps/server/src/app/compose.ts:838` `settings: async (repo) => (await readRepoPolicy(pool, repo)).settings ?? null`，`:1403` 每轮用 `policy.settings`），旧一轮已在进行中的对象不被回写。
- **判定与渲染用同一份配置**：`webhook-v21.ts:983-1019` 里 `rt.settings` 同时喂 `decideEvent`（判定）与 `buildV21AgentMessage`（渲染）。

### 缺口

1. **“配置随事件打成快照”没有真正落库**：事件侧只把**渲染出的正文**存进 `agent_messages.comment_body`（`webhook-v21.ts:1029-1037`），`repos.settings` 本身没有随事件持久化（`apps/server/src/db/schema.ts` 的 `tasks` / `agent_messages` / `agent_sessions` 均无 settings/snapshot 列）。执行侧在跑任务时**重读**当前配置（`compose.ts:838`、`:1401-1403`；`apps/server/src/worker/run-task.ts:1313-1329` 现取 `deps.v21.settings`）。后果：需求里“已经开始的那一轮不受影响”只在**判定/渲染**这一层成立，**执行侧**（动作开关、标签目录、系统提示词）仍会被改成新值——即 `createV21Executor` 在执行时才读 settings（`webhook-v21.ts:682-695`）。
2. 严格说“判定/渲染同一份”是靠调用方只解析一次实现的，没有机制强制（无快照对象可用作证据），属实现方式脆弱点而非当前故障。

---

## 6.3 占位符清单（12 个 + 标签格式 + repo.issues 规模控制）

**状态：已实现（有 2 处细节偏差）**

### 证据

**12 个占位符逐个存在**（契约清单与服务端渲染一一对应）：

- 契约：`packages/contract/src/settings-v21.ts:420-446`，`PROMPT_PLACEHOLDERS` 共 12 项——`issue.author` / `issue.number` / `issue.url` / `issue.content` / `issue.labels` / `issue.title` / `repo.issues` / `comment.author` / `comment.body` / `repo` / `actor` / `event.action`，与需求 1488–1499 表格逐条一致（`PLACEHOLDER_NAMES`、`PLACEHOLDER_NAME_SET`、`placeholderToken()` 同处）。
- 渲染：`apps/server/src/prompt/render.ts:132-162`（`resolvePlaceholder()` 的 switch 12 个 case，缺一即 `default: null` → 原样保留）。测试 `apps/server/test/prompt-render.test.ts` 有 “清单就是 12 个，不多不少” + “每个占位符都能渲染出值” 两条断言（已跑，见验证记录）。

**标签列表格式/边界**：

- 逗号加空格、空集空串：`render.ts:150-152`（`labels.map(...).join(', ')`，空集得 `''`，不填“无”）。
- 顺序沿用 GitHub 返回顺序、不排序：`render.ts:40-41`（`RenderIssue.labels` 注明“保持 GitHub 返回的顺序，不排序”）+ `webhook-v21.ts:307-310,323`（按载荷 labels 数组原序映射）。
- 快照取事件发生时：`webhook-v21.ts:302-325` 全部取自 webhook 载荷的 `issue`/`comment`/`sender`，不回查 GitHub。

**`{{repo.issues}}` 四项规模约束 + 惰性 + 缓存，逐项成立**（`apps/server/src/prompt/repo-issues.ts`）：

| 约束 | 实现 |
|---|---|
| 字段只有编号+状态+标题 | `repo-issues.ts:17-27`（`RepoIssueEntry` 只有 number/state/title/isPullRequest/updatedAt）、`:80-84`（`renderLine` = `#1942 [open] 标题`） |
| 仅 open | `repo-issues.ts:30-35`（`RepoIssuesLister` 入参类型把 `state` 收窄成字面量 `'open'`）、`:110`（请求固定 `state: 'open'`） |
| 上限 200 / 倒序截断 / 末尾补总数 | `repo-issues.ts:38`（`REPO_ISSUES_MAX_ITEMS = 200`）、`:71-78`（`updatedAt` 倒序）、`:120-123`（`slice(0, 200)`）、`:127-129`（`（共 N 条，仅列最近 200 条）`） |
| 排除 PR | `repo-issues.ts:120-121`（`filter((entry) => !entry.isPullRequest)`） |
| 惰性（没写就不拉） | `prompt/render.ts:92-95`（`needsRepoIssues()`）、`:193-204`（`renderTemplateAsync()` 只在命中时 `await source()`）；接线 `webhook-v21.ts:334-337`（`repoIssues` 是函数，惰性求值） |
| 缓存 5 分钟、同一波共用 | `repo-issues.ts:46-47`（`5 * 60 * 1000`）、`:139-161`（按仓库缓存 + in-flight 去重 + 代数失效）、`:163-174`（`invalidate`）；进程内只造一份：`webhook-v21.ts:257-276`（`WeakMap` 缓存 provider）、`compose.ts:831-835` |
| 是索引不是全文 | `repo-issues.ts` 全文无正文/评论字段；入参无 body |

测试：`apps/server/test/prompt-repo-issues.test.ts`（13 例，含“只 open”“排除 PR”“按 updatedAt 倒序”“超 200 补说明行”“5 分钟缓存/过期重取/并发只发一次/invalidate 代数”），已跑通过。

### 缺口（偏差）

1. **“共 N 条”会偏大**：`total` 直接用 GitHub 响应的 `total`（`repo-issues.ts:111-112`），而 GitHub 的 `issues` 接口把 PR 也算进总数，所以 `（共 N 条…）` 的 N 含 PR；同时因为先取 200 行再过滤 PR（`:120-123`），若首屏混入 PR，实际列出的 issue 会少于 200 而文案仍写“仅列最近 200 条”。需求 1530/1531 要求“总数说明 + 排除 PR”，此处两项组合下不精确。
2. **标签分隔符不可配**：需求 1516-1519 的“边界”条说“GitHub 允许标签名含逗号，若某仓库这么用，分隔符需改成换行或 `|`——届时按项目配置指定”，当前写死 `', '`（`render.ts:152`），配置里没有对应键。属需求显式点名的“届时可配”能力，未实现（需求自己说“届时”，可视为后续项，但清单里应显式记录）。
3. 次要：`{{repo.issues}}` 未准备数据时按“未知占位符”原样保留 + warn（`render.ts:71-77,105-124`、`webhook-v21.ts:364-380`），而非渲染空串。这与需求“惰性”不冲突，但意味着模板里写了它、而部署没注入 lister 时会露出 `{{repo.issues}}` 字面量（有 warn，不静默）。

---

## 6.4 配置示例（triggers / issues.opened.enabled / prompt / only_body_changed / require_mention / require_role / ignore_bot / allow_closed / prompt）

**状态：已实现（字段名与载体按设计阶段落定，与“示意”不同但需求已声明字段名待定）**

### 证据

- `issues.opened.enabled` / `prompt`：`packages/contract/src/settings-v21.ts:81-91`（`eventTriggerSchema.enabled` 为三态 `on|off|conditional`，`:69-73`；`prompt: string | null`）。
- `issues.edited.only_body_changed`：`settings-v21.ts:87`、消费点 `apps/server/src/config/v21-settings.ts:111`（只对 `issues.edited` 生效）。
- `issue_comment.created` 的四个闸门：`settings-v21.ts:105-118`（`require_mention` / `require_role` / `allow_roles` / `ignore_bot` / `allow_closed`），挂在事件配置下（`commentEventTriggerSchema.gates`，`:304-312`）。判定侧 `apps/server/src/trigger/decide.ts:173-197`。
- 默认值表即需求 6.4 示例的语义：`settings-v21.ts:323-333`（opened on / edited on+only_body_changed / labeled conditional / closed off / comment conditional）。

### 缺口（与示例的差异，均为设计阶段已确定的形态差异）

1. **载体不同**：示例是 `.github/pi-bot.yml`，实现是面板写 `repos.settings`（jsonb），yaml 配置整体退役——`apps/server/src/config/repo-config.ts:1-10` 文件头明确“**不读仓库里的配置文件**（yaml 整体退役），配置只从 `repos.settings` 来”，`apps/server/src/config/yaml.ts` 仅剩旧路径。需求 1560 写“字段名待设计阶段确定”，且未规定载体，故不算冲突，但与示例的字面形态不一致。
2. **`enabled` 是三态而非布尔**（`on/off/conditional`），示例写 `true`；`require_role: false` 在实现里对应 `gates.require_role`（嵌套一层）。
3. 示例的 `only_body_changed` 之外，实现多了 `labels`（`issues.labeled` 触发标签表，`settings-v21.ts:89`）——扩展，不冲突。

---

## 6.5 标签目录（五个字段 / 三条同步规则 / 空含义保护 / 刷新时机 / 注入形态）

**状态：部分实现**

### 证据（已成立的部分）

- **五个字段齐**：`packages/contract/src/repo-config.ts:76-94`（`name` / `role` / `meaning` / `color` / `description` / `group` / `managed` / `status`）与 `packages/contract/src/settings-v21.ts:275-292`（v2.1 目录条目，`managed` 默认 `true`、`status` 默认 `'active'`）；`status` 取值 `active|retired`（`settings-v21.ts:253`）。
- **“分组”与“状态”存在且被判定侧使用**：`apps/server/src/config/v21-settings.ts:249-258`（`resolveManagedCatalog()` 补齐 `managed`/`status`，`meaning` 缺省 `null`，并**故意不过滤**，把两类调用方分开）。
- **含义为空不进自动对齐范围（需求 1612-1615 的保护）**：`apps/server/src/writeback/v21/labels.ts:25`（`LabelSkipReason = 'not-in-catalog' | 'retired' | 'unmanaged' | 'missing-meaning'`）、`:89`（meaning 纯空白等价于没填）、`:98`（retired）；`planLabelTargetState` 的 `remove` 只取可管理集合。测试 `apps/server/test/writeback-v21-labels.test.ts` 有 “meaning 为空 / retired / managed=false / 目录外一律不动（不删不加）” 与 “meaning 是纯空白也等价于没填”，已跑通过。
- **目录不作为模板占位符**：`settings-v21.ts:420-446` 的 12 个占位符里没有目录项；目录走固定注入路径 `apps/server/src/skills/prompt.ts:254-289`（`renderLabelVocabulary()`），调用点 `apps/server/src/app/worker-deps.ts:344`（任务提示词尾部）与 `apps/server/src/skills/prompt.ts:717`（在 `renderSkillPrompt()` 内部注入）。
- 面板可维护含义/分组/状态/颜色/描述：`apps/panel/src/components/settings/labels-section.tsx:212-304`。

### 缺口

1. **三条 GitHub 同步规则全部未实现**：全仓没有“列仓库标签”的调用（无 `listLabels`/标签同步作业；`grep listLabels|syncLabels` 无命中），因此
   - “GitHub 是身份事实源（名称/颜色/是否存在以仓库为准）”——不成立：`name`/`color`/`description` 全靠人在面板手填（`labels-section.tsx:176-256`）；
   - “仓库新增标签自动进目录但含义为空”——不存在该流程；
   - “仓库删除标签自动标记失效”——`status: 'retired'` 只能人手在下拉里选（`labels-section.tsx:293-304`）。
   即 §6.5 的“与 GitHub 保持同步”这一核心前提缺失；`db/schema.ts` 也没有标签目录表（表清单见 `schema.ts:88-793`，只有 `bot_labels` / `label_decisions`），目录只活在 `repos.settings.labels.vocabulary` 里。
2. **“时机：处理事件前按需刷新（有有效期）”未实现**：目录直接读 `repos.settings`（`config/v21-settings.ts:249-258` 纯函数、无缓存无 TTL），既没有“按需刷新”，也没有“有效期”。
3. **注入形态与需求不符**：需求 1628 要求每行「名称 | 含义 | 分组」，**只列含义非空的**。实现是 Markdown 列表 `- \`名称\`：含义；互斥组：X（同组只打一个）`（`skills/prompt.ts:270-283`），且**不过滤 meaning 为空**（`:276` 只有 `if (entry.meaning !== undefined)`，空串照样渲染成 `- \`名称\``）。含义为空的标签因此会出现在“可管理范围”的表里——与需求“只列含义非空的（即可管理范围）”相反。
4. **注入位置不是“紧跟系统提示词”**：系统提示词走 system 通道（`config/v21-settings.ts:209` → `run-task.ts:838,916` 的 `systemPrompt`），目录拼在**任务提示词**层的尾部/技能层（`worker-deps.ts:344`、`:982-993` 经 `renderSkillPrompt`）。且只在命中技能时才经 `renderSkillPrompt` 注入（`worker-deps.ts:977-994`：`skill === undefined` 时 `projectPrompt` 里只有技能目录与能力目录，**没有标签目录**）——即“平台固定注入”在当前路径上不成立。
5. 面板展示侧有一套“可管理集合”过滤（`apps/panel/src/components/settings/settings-chrome.tsx:62`：`status !== 'retired' && managed !== false && meaning.trim() !== ''`），与 §6.5 保护一致，但只影响面板展示，不影响注入（见第 3 条）。

---

## 6.6 评论触发配置（提及关键词 / 角色清单 / 两个坑）

**状态：部分实现**

### 证据

- **提及关键词：必填、可配多个、大小写默认不敏感**：`packages/contract/src/settings-v21.ts:131-144`（`keyword` 必填 1–50 字符，`case_sensitive` 可选，缺省不区分）、`:198-203`（`mentions` `min(1).max(10)`）；默认值 `pi-bot`（`:341-350`）；解析补默认 `config/v21-settings.ts:159-175`（`case_sensitive ?? false`）。
- **命中规则（`@` 开头、紧跟关键词、后必须分隔符）**：`apps/server/src/trigger/mention.ts:50-75`（分隔符白名单，中文不算分隔符）、`:100-121`（`@` 紧邻 + 最长优先）、`:134-161`（前导字符禁区 + 代码区蒙版）。测试 `trigger-mention.test.ts` 22 例（含 `@pi-botx` 不命中、大小写两态），已跑通过。
- **角色清单：判定方式二选一（判别联合）**：`settings-v21.ts:170-187`（`by: 'association'` + `any_of` / `by: 'members'` + `members`）；七个作者关联取值 `:147-159` 与需求 1661 完全一致。
- **指定成员只支持个人 login**：`settings-v21.ts:184`（`members` 走 `MEMBER_LOGIN_RE`，`:48`，注释“不支持 org/team”）。
- **闸门只能选、不能临时填**：`settings-v21.ts:112`（`allow_roles` 是名字数组）+ 跨字段硬校验 `packages/contract/src/repo-config.ts:301-309`（`findUnknownAllowRoles`，写错/未定义即保存 400）；面板用候选下拉（`apps/panel/src/components/settings/v21-events-section.tsx:101-108,445-465`，`options={roleCandidates}`）。
- **角色重名/关键词重复校验**：`repo-config.ts:310-325`。
- 判定侧：`apps/server/src/trigger/roles.ts:69-88` + `trigger/decide.ts:188-197`（`role-denied` 留痕原因）。

### 缺口

1. **坑 1（login 会变 → 存用户 id、匹配以 id 为准）未实现**：`commentRoleSchema.members` 就是 `string[]` login（`settings-v21.ts:184`），匹配也只比 login（`trigger/roles.ts:52-59`）；全仓无用户 id 解析、无 `users/{login}` 调用、`comment.roles` 无 id 字段（`grep userId|user_id|getUser` 在 `apps`/`packages` 下 0 命中）。即改名后旧 login 被他人注册即可冒充。
2. **坑 2（保存时校验账号是否存在，不存在就拒绝）未实现**：保存路径只跑 `repoSettingsSchema` 的形状与跨字段校验（`repo-config.ts:268-341`），没有任何 GitHub 账号存在性校验；`PUT` 保存“alicee”这种拼错 login 会 200 成功，且永远不会触发。
3. **面板丢失 `case_sensitive`**：编辑关键词时重建对象为 `{ keyword }`（`v21-events-section.tsx:116-128`），会静默清掉已有条目的 `case_sensitive: true`；面板也没有任何大小写开关（`grep case_sensitive` 在 `apps/panel/src` 下 0 命中）。需求 1647 要求“是否区分大小写”可配，当前只能手改库。
4. **面板把“指定成员”收窄成“项目管理员”**：新增角色只能从 `agent.managers` 取成员（`v21-events-section.tsx:512-525`，注释“成员取项目管理员”），且没有“作者关联型角色”的编辑入口（关联型只能靠保存已有 JSON）。需求 1654/1662 要求“每个角色要么按作者关联定义，要么按具体人定义”，面板只做了后者的一个子集。
5. 需求 6.6 示例把 `case_sensitive` 放在 `comment.mentions` 段级（`requirements.html:1688`），实现是**每个关键词一条**（`settings-v21.ts:140`）。语义上行（默认不区分），但同一项目不能统一设一次。

---

## 6.8 供应商与模型角色（全局）

**状态：未实现**

### 证据（当前实际形态）

- 模型侧只有**一个**端点、且只从环境变量读：`apps/server/src/app/config.ts:89-98,173-180,327-345,410-414`；换算 `apps/server/src/app/model-env.ts:23-51`（`PI_BOT_MODEL_API_KEY` / `_BASE_URL` / `_NAME`）。
- 仓库里**没有**供应商表、模型角色表、单价表：`apps/server/src/db/schema.ts:88-793` 的全部 `pgTable` 中无 providers / model_roles / prices（表清单：webhook_deliveries, repos, tasks, runs, run_events, envelopes, actions, bot_labels, issue_fingerprints, issue_states, usage_costs, degeneracy_hits, metrics_daily, host_credentials, runtime_flags, panel_sessions, issue_feedback, label_decisions, quota_counters, agent_sessions, agent_messages, agent_denials, comment_slots, agent_compactions）。
- 契约与 API 里没有供应商 / 模型角色实体：`packages/contract/src/api.ts` 只在成本桶与一处枚举里出现 `model`（`:20-27,415,850`），没有 provider CRUD、没有四档角色、没有输入/输出单价。
- 面板无对应界面：`apps/panel/src/routes/` 无全局设置页（`system.tsx` 是版本/doctor/队列/仓库/能力的诊断页，`system.tsx:1-9` 的文件头即其职责），`settings/` 下 12 个组件全是**项目级**（general/labels/triggers/v21-agent/v21-events）；`grep 供应商|模型角色|personal` 在 `apps/` 下只命中 3 处注释（`app/model-env.ts:6`、`doctor/checks/model-endpoint.ts:8`、`test/app-model-endpoint.test.ts:4`）。
- 单价是硬编码的 DeepSeek 价目，不是“每档角色各自的输入/输出单价”：`apps/server/src/cost/pricing.ts:29`（`DEEPSEEK_PRICES`）、`:41`（`PRICE_VERSION`）、`:112-132`；`cost/costs.ts:8` 自述“价格表还没落库（没有单价列）”。
- 密钥加密只在**宿主设备令牌**这一条路径上成立：`apps/server/src/runtime/crypto.ts:106-146`（AES-256-GCM，随机 IV）、`:146-190`（`decryptSecret` 失败一律抛 `CRYPTO_DECRYPT_FAILED`，`:186`）、`apps/server/src/runtime/bootstrap.ts:346-366`（加密写 `host_credentials`）；模型 key 本身是**明文环境变量**，没有加密存储、没有“界面只显示掩码/已存/未配置”。
- 连通性/可用模型列表有一份**doctor 预检**（不是供应商行）：`apps/server/src/doctor/checks/model-endpoint.ts:58-108`（`GET {base}/models`、计 `elapsedMs`、401/403 判失败、`parseModelIds()` 解析可用模型，`:39-56`）。

### 缺口（逐条对 CFG-8.1 / 8.2 / 8.3）

- **CFG-8.1（供应商一条一行）未实现**：没有供应商实体、没有多供应商、没有 base URL/key 的增删改查接口（`apps/server/src/http/api/index.ts` 无 provider 路由），面板没有掩码展示、“已存/未配置”状态、手动连通性测试按钮、该家可用 model 列表。现有 `doctor/model-endpoint` 只覆盖“当前这一个 env 端点”的探活，且不可在面板触发。
- **CFG-8.2（四档角色各带单价）未实现**：没有 `agent` / `format` / `classify` / 兜底四档，也没有“供应商 + 模型”绑定；没有每档输入/输出单价展示（`pricing.ts` 是 DeepSeek 三档价目 + 峰谷，按 token 计费，与角色无关）。降级（429/超时后换模型）也没有对应配置。
- **CFG-8.3（全局默认 + 项目覆盖，且两处不并列）未实现**：项目级只有 `repos.settings.model`（`packages/contract/src/repo-config.ts:220`，`provider/model` 字符串，注释“只影响成本归集”），面板没有“继承全局（模型名）→ 点开才覆盖”的交互，也没有全局侧的默认值。
- **CFG-8.1 安全条**：key 加密存储 + 宿主进程解密不进容器，只有 `host_credentials` 一条路径满足；“解密失败必须报错”在该路径成立（`crypto.ts:186`，测试 `test/runtime-crypto.test.ts` 12 例含“换错 key / 篡改一个字节 / 版本不对”均失败，已跑通过），但**没有一条路径把模型 key 加密存起来**——现在它只活在 `EnvironmentFile` 明文里。

---

## 6.9 面板身份（GitHub 令牌）

**状态：未实现**

### 证据

- 写回身份只有一种：GitHub App installation token。`apps/server/src/github/auth.ts:20-30`（`AppCredentials` / `InstallationToken`）、`:174-240`（`createInstallationTokenProvider`，内存缓存、1 小时续期）；`apps/server/src/app/config.ts:73-84,155-165,403-409`（App ID / 私钥路径 / installation ID / 可选静态 `PI_BOT_GITHUB_TOKEN`）。
- 没有“个人 PAT”概念：全仓无 `personal` / 用户级 PAT 存储、无 `X-OAuth-Scopes` 读取、无过期时间校验（`grep personal|X-OAuth-Scopes|scopes` 在 `apps`/`packages` 下 0 命中）；`host_credentials` 表存的是 **pi-host 设备令牌**（`apps/server/src/db/schema.ts:514-535`、`runtime/bootstrap.ts:104-134`），不是面板身份。
- 面板没有身份配置界面：`apps/panel/src/routes/system.tsx` 无令牌表单；`grep 掩码|已存|未配置` 在面板只命中标签/技能文案。

### 缺口

- **CFG-9.1（默认 bot，可切换个人账号）未实现**：未配置个人令牌时“以 bot 身份署名”成立（App installation 写回），但“配置个人 PAT 后以该用户身份提交评论”整条链路不存在——没有存储、没有解密、没有 per-user Octokit、没有 `issues: write` 权限校验、没有“检查权限”（scope + 过期时间）动作。
- **CFG-9.2（令牌不可用时必须说清楚 + 退回 bot 身份）未实现**：因为个人令牌路径不存在，“缺失 / scope 不足 / 已过期”三种状态没有产生点，也没有“失败原因显式呈现 + 退回 bot 身份”的分支。当前可说的只有通用写回失败：`executeV21` 的整批拒绝会把每条错误以 `path`/`message` 回传（`apps/server/src/http/webhook-v21.ts:710-714`），以及 `apps/server/src/github/errors.ts` 的错误分类——这些与 §6.9 要求的“身份降级可见”不是一回事。
- 附带观察（不属 6.9，但与 CFG-9.1 相邻）：静态 `PI_BOT_GITHUB_TOKEN` 存在时身份取决于该 token 的归属（个人 PAT 就是个人身份、不是 bot），这条“隐式身份切换”没有面板提示，也没有 scope/过期校验——需求要求的“显式可切换 + 可检查”目前被一个环境变量隐含掉了。

---

## 本节整体结论

1. **项目级配置模型（§6.1 项目侧 / §6.2 回落与整体覆盖 / §6.3 占位符 / §6.4 字段面 / §6.6 形状与判定）已经落地且被单测钉住**：12 个占位符一个不缺；`{{repo.issues}}` 的 200 条上限、仅 open、排除 PR、按更新时间倒序、末尾总数说明、惰性、5 分钟缓存**逐项成立**；标签列表的“逗号+空格 / 空集空串 / 保留 GitHub 顺序 / 事件时快照”成立；事件开关、事件模板、四道评论闸门、提及关键词（默认不区分大小写）、角色清单（判别联合 + 七个作者关联 + 只支持 login 不支持 org/team）与闸门引用校验都在契约层硬约束并通过 `superRefine` 保存即拒。
2. **三处明确不达标（本期真缺口）**：
   - §6.2 “配置随事件打成快照”：只冻住了渲染文本，配置本身没有快照，执行侧仍重读当前配置；
   - §6.5 标签目录的**三条 GitHub 同步规则 + 按需刷新 + 目录注入形态（只列含义非空、名称|含义|分组）**：同步与刷新完全没有实现，注入不过滤空含义、位置也不是紧跟系统提示词；
   - §6.6 的**两个坑**：成员只按 login 存与匹配（未存用户 id）、保存时不校验账号存在性；面板还会丢 `case_sensitive`。
3. **§6.8 与 §6.9 整体未实现**：供应商行、四档模型角色与输入/输出单价、“继承全局→点开才覆盖”、个人 PAT 身份切换与“检查权限”、令牌不可用时的显式失败与身份退回，全部只存在于需求正文与设计原型（`docs/panel-ui-versions.html:255,261,273`、`design-refactor/e-unified.html`），代码与契约里没有对应实体，数据库也没有对应表。密钥加密与“解密失败必须报错”只在宿主设备令牌这一条既有路径上成立，模型 key 目前是明文环境变量。
4. **与需求冲突的细节两处**：§6.5 的“颜色/描述由 GitHub 同步、平台不单独维护”——实现里颜色与描述是面板手填字段（`repo-config.ts:84,86`、`labels-section.tsx:224-256`）；§6.3 的“总数说明”把 PR 计入总数（`repo-issues.ts:111-128`）。

## 验证记录（实际执行的命令与结果）

在 `C:\Code\NodeProjects\pi-issue-bot\apps\server` 下执行（只读，未改任何文件）：

| 命令 | 结果 |
|---|---|
| `npx vitest run test/prompt-render.test.ts test/prompt-repo-issues.test.ts test/trigger-mention.test.ts` | 3 文件 52 例全通过（13 / 17 / 22） |
| `npx vitest run test/v21-settings.test.ts test/writeback-v21-labels.test.ts test/trigger-decide.test.ts` | 3 文件 71 例全通过（22 / 11 / 38） |
| `npx vitest run test/runtime-crypto.test.ts` | 1 文件 12 例全通过 |

未执行（不在本次核查所需范围，且工作区存在大量他人未提交改动）：`pnpm -r typecheck`、`pnpm lint`、`pnpm -r test` 全量、面板测试（`apps/panel`）。
