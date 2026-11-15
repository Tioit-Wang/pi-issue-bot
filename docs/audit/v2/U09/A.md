# U09 5.2 事件触发配置 · A

> 核查范围：docs/requirements.html 行 756-855
> 代码基线：见 docs/audit/v2/_baseline.txt（HEAD `fbfa029`，工作区含未提交改动，与 baseline 一致）

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| FR-2.1 每个事件一个触发开关 | 已实现 | 五事件开关 + 默认值表逐格一致；PR 投递固定 `pr-ignored` |
| FR-2.2 每个事件一份提示词模板 | 已实现 | 项目/事件两级模板，未配置回落平台内置且同一渲染器 |
| FR-2.3 占位符替换 | 部分实现 | 「重复全替换 / 一次遍历 / 未知原样保留」都对，但「后台记一条配置告警」只有 pino 日志一行，无落库、无读取路径 |
| FR-2.4 评论事件额外闸门四项 | 已实现 | 四项及默认值齐备；开关关闭时闸门不生效；`allow_roles` 只能引用项目角色 |
| FR-2.5 提及关键词与合法提及 | 已实现 | 四条判定用例实测与文档一致；分隔符含中文标点、不含中文字符 |

## 逐条

### FR-2.1
- **状态**：已实现
- **证据**：
  - `packages/contract/src/settings-v21.ts:81-91` — `eventTriggerSchema{ enabled: 'on'|'off'|'conditional', prompt, only_body_changed?, labels? }`，`.strict()`，每个事件一条配置对象。
  - `packages/contract/src/settings-v21.ts:326-334` — `eventTriggersSchema` 对五个键各用 `.prefault(...)`：`issues.opened`=`on`；`issues.edited`=`on` + `only_body_changed:true`；`issues.labeled`=`conditional` + `labels:[]`；`issues.closed`=`off`；`issue_comment.created`=`conditional` + `gates:{}`。`prefault` 语义是「键缺失 = 过一遍 schema」，所以「未配置继承平台默认」成立。
  - `apps/server/src/config/v21-settings.ts:105-116` — `resolveEventTrigger()` 是判定侧唯一读取口；`onlyBodyChanged` 只对 `issues.edited` 取值，其余事件恒 `false`（第 111 行）。
  - `apps/server/src/trigger/decide.ts:226-229` — 开关是第二道判定（仓库可用性之后），`enabled === 'off'` 直接 `switch-off`，不建任务。
  - `apps/server/src/trigger/decide.ts:145-153` — `issues.edited`：`only_body_changed` 为真时要求 `changedFields` 含 `body`，否则 `body-unchanged`（只改标题/标签不触发）；`changedFields` 来自 `apps/server/src/http/webhook-v21.ts:138` `Object.keys(payload.changes)`，即 GitHub 的 `changes` 键集合，不做 before/after diff。
  - `apps/server/src/trigger/decide.ts:154-162` — `issues.labeled`：`addedLabel` 与 `trigger.labels` 大小写不敏感比对，未命中 → `label-not-matched`；空标签表 = 永不触发。
  - `apps/server/src/trigger/decide.ts:274-276` + `apps/server/src/http/webhook-v21.ts:86-89` — `pull_request*` → 固定 `{ triggered:false, reason:'pr-ignored' }`，不进 issue 会话、不带模板。
  - 实测（`node --experimental-strip-types` 探针）：`eventTriggersSchema.parse({})` 输出 `opened on / edited on+only_body_changed:true / labeled conditional labels:[] / closed off / comment conditional + 四闸门默认`，与需求 766-771 行表格逐格一致。
  - 测试存在且断言具体：`apps/server/test/trigger-decide.test.ts:46-99`（五个默认值行为）、`:133-179`（edited 四情况）、`:181-227`（labeled 命中/未命中）、`:481-489`（PR 恒 `pr-ignored`）；`packages/contract/test/settings-v21.test.ts:54-95`（默认值表 + prefault 逐键生效）；`apps/server/test/v21-webhook-integration.test.ts:519-528`（PR 投递 `decision=ignored/reason=pr-ignored`、零入队）。
- **判定依据**：需求这条的全部子条件（每事件独立开关、未配置继承默认、六行默认值）都能定位到「配置 schema → 默认值 → 判定消费 → 留痕」的完整执行路径，不是只有字段。

### FR-2.2
- **状态**：已实现
- **证据**：
  - `packages/contract/src/settings-v21.ts:85` — 模板字段 `prompt: z.string().max(4000).nullable().default(null)`，`null` = 用平台内置；`eventTriggersSchema` 把它放在 `triggers.events[事件]` 下，即「项目（`repos.settings`）+ 事件」两个维度。
  - `packages/contract/src/settings-v21.ts:473-549` — `DEFAULT_EVENT_TEMPLATES` 五份内置默认模板，均以技能触发词开头（`/proposal-analysis`、`/label-triage`、`/issue-analysis`），随后是 `#{{issue.number}} {{issue.url}}`、正文快照，符合「模板通常含技能触发词」。
  - `apps/server/src/http/webhook-v21.ts:359-362` — `v21TemplateOf()`：`prompt === null || trim() === ''` → 内置默认，否则用项目原文；两种来源**收敛成同一个字符串**后再交给同一渲染器（`:464`、`:476`）。
  - `apps/server/src/trigger/decide.ts:255-258` — 触发放行时的 `template` 同样按「项目 prompt 优先、空白回落内置」裁决，热路径直接用它的结论（`webhook-v21.ts:1017` 传 `decidedTemplate`）。
  - `apps/server/src/http/webhook-v21.ts:1029-1037` — 渲染结果落 `agent_messages.comment_body`（`insertMessage` 的 `body`）；`apps/server/src/agent/store.ts:147-150`（`insertTask` 写入 `prompt_text`）与 `:324-332`（`input.body` 为该列实参）把它带到任务行，`apps/server/src/app/compose.ts:1239-1252` 再拼进最终 prompt。
  - 面板同源：`apps/panel/src/components/settings/v21-events-section.tsx:258-272`、`:609-610`、`:637` — 未自定义时输入框显示 `DEFAULT_EVENT_TEMPLATES[eventKey]`，并渲染占位符快捷插入按钮（契约 `PROMPT_PLACEHOLDERS`）。
  - 测试存在且断言具体：`apps/server/test/v21-webhook-integration.test.ts:363-388`（项目模板渲染结果进 `comment_body`，断言四段顺序且 `{{issue.url}}` 已被替换）、`:390-405`（`prompt=null` 时内置模板过同一渲染器）、`:406-434`（显式解析与 `decideEvent().template` 等价）；`apps/server/test/trigger-decide.test.ts:443-479`（配置优先/空白回退/内置模板四段结构）。
- **判定依据**：「按项目+事件配置」「未配置用内置」「纯文本含占位符」「含技能触发词」四条都有落点，且模板来自配置而非硬编码，面板与服务端共用契约常量，无「看到 A 实发 B」。

### FR-2.3
- **状态**：部分实现
- **证据**：
  - `apps/server/src/prompt/render.ts:170-185` — 单次 `template.replace(PLACEHOLDER_PATTERN, cb)`：**一次遍历**完成全部替换，替换进去的值不回扫（不会二次替换）；同一个占位符在模板里出现几次回调就调几次，**每处都替换**。
  - `apps/server/src/prompt/render.ts:90` — 占位符语法 `/\{\{([a-zA-Z0-9_.]+)\}\}/gu`。
  - `apps/server/src/prompt/render.ts:173-183` — 未知（`resolvePlaceholder` 返回 `null`）时 `return match`，即**原样保留**，并把名字按首次出现顺序去重收集到 `unknown`。
  - 实测（探针）：`'a={{ repo }} b={{repo}} c={{issue.foo}} d={{issue.foo}}'` → `text='a={{ repo }} b=o/n c={{issue.foo}} d={{issue.foo}}'`、`unknown=['issue.foo']`（重复未知去重、已知多处替换、带空格的 `{{ repo }}` 不认作占位符）。
  - 告警侧（**这是缺口所在的子条件**）：`apps/server/src/http/webhook-v21.ts:495-504` 在 `unknown.length > 0` 时调 `reportV21UnknownPlaceholders(input.logger, warning)` 并调可选钩子 `deps.onUnknownPlaceholders?.(warning)`；`:372-385` 的实现体只有一条 `logger.warn({ unknown, event, repo, deliveryId }, '…')`。
  - `apps/server/src/app/compose.ts:981-984` — 生产装配 `v21` deps 只给 `db` 与 `repoIssues`，**没有注入 `onUnknownPlaceholders`**；该钩子全仓只有三处：`webhook-v21.ts:246`（类型定义）、`:503`（调用）、`apps/server/test/v21-webhook-integration.test.ts:218`（测试注入），即无生产消费方。
  - `apps/server/src/db/schema.ts` 共 24 张表（`webhookDeliveries`、`agentMessages`… 见 `:88`、`:706` 等），**没有任何告警/配置异常表**；`apps/server/src/queries/*` 也无读取未知占位符的查询；`webhook_deliveries` 只写 `decision` / `decision_reason`（`webhook-v21.ts:198-201`），不含 `unknown` 列表。
  - 测试存在且断言具体（前三条）：`apps/server/test/prompt-render.test.ts:78-81`（重复每处替换）、`:84-95`（值内占位符不被二次替换）、`:98-101`（未知原样保留 + 顺序去重）；`apps/server/test/v21-webhook-integration.test.ts:435-465`（结构化 warn 的 `unknown/event/repo` 字段 + 钩子拿到同一份）。
- **缺口**：缺「**在后台记一条配置告警**」这一子条件。现状是进程日志里一行 warn：不进库、不进指标（`compose.ts:822` 的 metrics 实例未被任何未知占位符路径使用）、面板与只读 API 都查不到（`webhook_deliveries` 无此字段，无对应表/查询）。影响：模板写错 `{{issue.foo}}` 时，只有能看服务端日志的运维知道；面板使用者唯一可见的信号是提示词里留着一个 `{{issue.foo}}` 字面量。
- **判定依据**：三条替换规则逐条有实现级保证并被测试钉住；第四条「后台可查的记录」按证据口径 2（写入 ≠ 可查；钩子存在 ≠ 有生产消费方）不成立——写入通道只有一行进程日志，读取通道完全不存在，因此只能是部分实现。

### FR-2.4
- **状态**：已实现
- **证据**：
  - `packages/contract/src/settings-v21.ts:105-118` — `commentGatesSchema`：`require_mention` 默认 `true`、`require_role` 默认 `false`、`allow_roles` 默认 `[]`、`ignore_bot` 默认 `true`、`allow_closed` 默认 `false`，`.strict()`；`:310-332` 把它挂在 `issue_comment.created` 的 `gates` 上。
  - `apps/server/src/config/v21-settings.ts:132-144` — `resolveCommentGates()` 只从 `triggers.events['issue_comment.created'].gates` 取，是判定侧唯一入口。
  - `apps/server/src/trigger/decide.ts:225-243` — 顺序固定：事件开关（`:226-229`，`off` → `switch-off` 直接返回）→ 事件附加条件（`:232`）→ 评论闸门（`:238-243`）。**开关关闭时闸门不被调用**，即「开关关闭时闸门一律不生效」。
  - `apps/server/src/trigger/decide.ts:173-201` — 四项闸门全部落地：`bot-self`（`:175-177`）、`closed-not-allowed`（`:178-180`）、`not-mentioned`（`:181-187`）、`role-denied`（`:188-199`）。
  - `apps/server/src/trigger/roles.ts:69-87` — 角色闸门只按名字引用 `allow_roles` 到 `comment.roles`，逐角色按 `author_association`（`any_of`）或成员 login 比对；`allow_roles` 为空时放行（未限定）。
  - `packages/contract/src/repo-config.ts:301-309` — 保存即硬校验：`allow_roles` 里出现 `comment.roles` 未定义的名字 → `addIssue`（「只能从角色清单选，不能临时填写」在契约层成立）。
  - 面板：`apps/panel/src/components/settings/v21-events-section.tsx:421-488` 四个闸门开关（`require_mention` / `require_role` / `ignore_bot` / `allow_closed`）外加 `allow_roles` 多选（`:444-466`）；`:101-105` 的角色候选只来自 `draft.comment.roles`，无候选时禁用并提示，与「只能从角色清单里选」一致。该分区由 `apps/panel/src/routes/repo-settings.tsx:40` 挂载。
  - 测试存在且断言具体：`apps/server/test/trigger-decide.test.ts:228-371`（四闸门逐个命中与关闭）、`:101-130`（评论事件 `off` 时缺提及也只记 `switch-off`，不记 `not-mentioned`）；`packages/contract/test/settings-v21.test.ts:72-78`（默认值）、`:200-230`（未定义角色被拒、`findUnknownAllowRoles` 具体名字）。
- **判定依据**：四项闸门各有独立配置项、默认值与需求表格一致，且「闸门在开关之后、开关关闭则不生效」由判定函数的调用顺序与专门用例双重保证；`allow_roles` 的「只能引用项目已定义角色」有契约级硬校验。

### FR-2.5
- **状态**：已实现
- **证据**：
  - `packages/contract/src/settings-v21.ts:131-142` — 提及关键词是项目级配置（`comment.mentions[].keyword`，禁空白与 `@`，允许中文），`settings-v21.ts:198-203` 要求至少 1 个。
  - `apps/server/src/config/v21-settings.ts:159-175` — `resolveCommentConfig()` 把关键词（含 `case_sensitive` 补齐为布尔）交给判定侧。
  - `apps/server/src/trigger/mention.ts:70-75` — `isMentionSeparator()`：`''`（字符串结尾）算分隔符，`\s`（空格/换行/制表）算，白名单标点算；`:50-58` 的白名单**含中文标点**（`，。！？：；、（）【】《》「」『』“”‘’…—～`）。
  - `apps/server/src/trigger/mention.ts:134-161` — `findLegalMention()`：找 `@` → `@` 后紧跟关键词（`:149` `matchKeywordAt` 在 `cursor+1`）→ 关键词之后必须是分隔符（`:115-117`）→ 同位置最长关键词优先（`:96` 按长度倒序）。
  - 四条判定用例逐条实测（探针，关键词 `pi-bot`）：`@pi-bot 帮我看看这条` → 命中 `{start:0,end:7}`；`@pi-bot` → 命中；`@pi-bot帮我看看这条` → `null`；`@pi-botx 帮我看看` → `null`。附加实测：`@pi-bot，帮看下` / `@pi-bot：帮看下` 命中（中文标点属分隔符）。
  - 测试存在且断言具体：`apps/server/test/trigger-mention.test.ts:13-40`（需求表格四条 + 换行 + 中文标点）、`:112-119`（`@小豆 你好` 命中、`@小豆你好` 不命中，即中文不是分隔符）；判定接入闸门：`apps/server/test/trigger-decide.test.ts:283-309`。
- **判定依据**：需求的两条合法条件（`@` 紧邻关键词、关键词后必须是分隔符或串尾）逐条可定位，且四条判定用例的期望结果与文档表格完全一致；分隔符集合包含中文标点、明确不含中文字符，与需求 851-854 行「`@pi-bot你好` 不会被识别」的取舍一致。

## 本节整体结论
FR-2.1 / FR-2.2 / FR-2.4 / FR-2.5 可以判为已实现：五事件开关与默认值表、按项目+事件的提示词模板、评论四闸门及其优先级、合法提及的四条判定，都能追到「配置 → 判定 → 渲染 → 落库 → 发给 agent」的实际执行路径，并有断言具体的测试。FR-2.3 只能判部分实现：三条替换规则（重复全替换、一次遍历、未知原样保留）是严格满足的，但需求要求的「在后台记一条配置告警」只落到一行 pino `warn`，既没有落库也没有任何后台读取路径，运维之外的读者看不到。因此本节整体**不能**判为「已实现」，缺的是 FR-2.3 的告警可查性这一个子条件。

## 核查边界
- 是否执行了命令：
  - `pnpm --filter @pi-issue-bot/server exec vitest run test/trigger-mention.test.ts test/trigger-decide.test.ts test/prompt-render.test.ts` → 3 文件 77 用例全部通过。
  - `node --experimental-strip-types $env:PI_SCRATCH_DIR\probe-u09a.mjs`（临时探针，只 import 仓库源码，未改仓库）→ 输出：默认值表逐格一致；`issue_comment.created` 配 `on` 且无提及 → `not-mentioned`；`issues.labeled` 配 `on` 但标签表空 → `label-not-matched`；`{{ repo }}` 原样保留且不进 `unknown`；四条提及用例结果与文档一致。
  - `node --experimental-strip-types $env:PI_SCRATCH_DIR\probe-u09a-pr.mjs` → `issue_comment` 落在 PR 上时 `decision = { triggered:true, reason:'conditional-met' }`（见下方额外问题 1）。
- 未覆盖的条目及原因：无。面板渲染只做静态核查（未启动面板，未跑 `apps/panel` 的 vitest 套件），因此「面板交互是否真的写回 settings」只按代码路径判定，未做端到端点击验证。
- 发现的额外问题（不属本节范围但值得记录）：
  1. **PR 上的评论会进 issue 会话**（超出 FR-2.1 表格的 `pull_request.*` 行，但与 573 行「本期不处理 PR 事件、不开 PR 评审会话」的边界相冲）：`apps/server/src/http/webhook-v21.ts:85-108` 只按 `X-GitHub-Event` 头判 PR，`issue_comment` 一律映射成 `issue_comment.created`；判定入口 `:111-158` 也不看 `issue.pull_request`。探针实测：载荷 `issue.pull_request` 存在、评论为 `@pi-bot 帮我看看这个 PR` 时，v2 判定返回 `triggered:true` 并用内置 `/issue-analysis` 模板（正文里的 `{{issue.*}}` 会填 PR 数据）。旧路径在同文件 `apps/server/src/http/webhook.ts:627-629` 有「issues 事件来自 PR → ignore」的护栏，新分支没有对等护栏。
  2. **三态开关 `on` 与面板文案不一致**：面板 `apps/panel/src/components/settings/v21-events-section.tsx:54` 说「`on` = 事件一到就交给 agent，**不看附加条件**」，但 `apps/server/src/trigger/decide.ts:145-162`（附加条件）与 `:238-243`（评论闸门）对 `enabled === 'on'` 同样执行——探针实测 `on` + 无提及 → `not-mentioned`、`on` + 空标签表 → `label-not-matched`。需求只规定「开关关闭时闸门不生效」，所以不构成 FR-2.4 缺口，但面板文案会让人误判。
  3. **`only_body_changed` 可被关掉**：`packages/contract/src/settings-v21.ts:86-87` 与面板 `v21-events-section.tsx:274-286` 都允许把「正文变更才触发」关掉，关掉后只改标题也会触发（`trigger-decide.test.ts:170-179`），与需求 767 行「只改标题或标签不触发」的绝对表述不一致（默认值方向上无问题）。
  4. **合法提及比需求多两条未写明的约束**：`apps/server/src/trigger/mention.ts:67` 的前导字符禁区（`[A-Za-z0-9._@-]` 之后不算命中，如 `x-@pi-bot`、`a.b@pi-bot`）与 `:142` 的代码区蒙版（代码块/行内代码里的 `@pi-bot` 不算）都不在需求 FR-2.5 的两条条件里，属更严格实现；`x-@pi-bot 看下` 这类写法会被静默漏触发。
  5. **`{{ repo }}`（含空格）静默不替换也不告警**：`apps/server/src/prompt/render.ts:90` 的正则不允许空格，因此它既不进 `unknown` 也没有告警，模板里写错一个空格就永久留字面量且无人提示——与 FR-2.3「未知占位符要记告警」的意图相关，建议并入 FR-2.3 的告警可查性一起修。
