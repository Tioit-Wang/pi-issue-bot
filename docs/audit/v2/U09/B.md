# U09 5.2 事件触发配置 · B

> 核查范围：docs/requirements.html 行 756-855
> 代码基线：见 docs/audit/v2/_baseline.txt（HEAD fbfa029，工作区含已修改文件；本次读到的内容与基线一致，无 STALE）

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| FR-2.1 每事件开关 + 默认值表 | 已实现 | —（附注：条件事件上 `enabled='on'` 与 `'conditional'` 行为等价） |
| FR-2.2 每事件一份模板 | 已实现 | — |
| FR-2.3 占位符替换 | 部分实现 | 三条替换规则全对，但「后台记一条配置告警」只有一行 `logger.warn`（可选内存钩子），无落库/无查询路径，后台查不到 |
| FR-2.4 评论四闸门 + 默认值与顺序 | 已实现 | —（风险：`require_role:true` + `allow_roles:[]` 选择放行所有人为松侧） |
| FR-2.5 合法提及 | 已实现 | —（四个用例实测全部符合） |

## 逐条

### FR-2.1 每个事件一个触发开关 + 默认值表
- **状态**：已实现
- **证据**：
  - `packages/contract/src/settings-v21.ts:56-62` — `EVENT_KEYS` 只有五个事件，`pull_request.*` 刻意不在其中。
  - `packages/contract/src/settings-v21.ts:326-334` — `eventTriggersSchema` 每个键 `prefault` 默认值：opened `enabled:'on'`；edited `'on'` + `only_body_changed:true`；labeled `'conditional'` + `labels:[]`；closed `'off'`；comment `'conditional'` + 四闸门默认。实测 `eventTriggersSchema.parse({})` 输出与需求表逐格一致。
  - `apps/server/src/trigger/decide.ts:225-229` — 开关判定在第②步，`off` 直接 `switch-off`。
  - `apps/server/src/trigger/decide.ts:141-164` — 事件附加条件：edited 走 `changed.includes('body')`，`changedFields ?? []`（缺 `changes` → 空数组 → 判 `body-unchanged`，保守不触发）；labeled 走标签名 trim+小写比对，空表 = `label-not-matched`。
  - `apps/server/src/http/webhook-v21.ts:85-108` — 任何 `pull_request*` 映射为 `pull_request.*`；`apps/server/src/trigger/decide.ts:274-276` `decidePullRequest()` 恒 `pr-ignored` 且不带模板；`apps/server/src/http/webhook-v21.ts:988-994` 未触发即 200 `ignored` 不入队，`apps/server/src/http/webhook.ts:1284-1286` 命中后直接 return，不进 issue 会话。
  - `apps/server/src/config/v21-settings.ts:105-116` — `resolveEventTrigger` 是唯一读取口，`onlyBodyChanged` 对非 edited 恒 `false`。
- **缺口**：无。
- **判定依据**：默认值来自契约常量并被判定函数真实消费（探针逐事件实测一致，非死字段）；PR 有独立拒绝路径且拦截在实际 HTTP 返回之前。
- **反证过程**：
  1. 假设「默认值表只是文档/注释」→ 在 scratch 跑 `eventTriggersSchema.parse({})`，五格与 `decideEvent` 实际判定（opened→true、labeled→label-not-matched、closed→switch-off、comment→not-mentioned）处处接得上，推翻假设。
  2. 假设「`issues.edited` 只改标题也会触发」→ 因为需求说「仅正文变更」。实测 `changedFields:['title']` → `body-unchanged`；`changes` 缺失时（`v21DecisionInputOf` 第 138 行给 `[]`）同样 `body-unchanged`，是保守侧，未误触发。
  3. 假设「`issues.labeled` 是死字段」→ 实测 `labels:['Bug']` 配 `addedLabel:'bug'` 触发（大小写不敏感），空表永不触发，字段真的被消费。
  4. 假设「PR 会被当成 issue 处理」→ `decidePullRequest` 无模板、`handleV21Webhook` 在 PR 上直接返回 200 ignored，且该分支先于旧管线 return。
  5. 反向检查第三条态：显式写 `{enabled:'on'}` 的 labeled（空表）实测仍 `label-not-matched`。即 `on` 与 `conditional` 只差 `reason`（`enabled` / `conditional-met`），第三态对条件事件没有实际控制力。需求没定义这个三态，故不判冲突，记入额外问题。

### FR-2.2 每事件一份提示词模板（项目 + 事件维度，未配置用内置）
- **状态**：已实现
- **证据**：
  - `packages/contract/src/settings-v21.ts:81-91` — 每个事件带 `prompt: string|null`，`null` = 内置默认；`packages/contract/src/settings-v21.ts:304-312` 评论事件同形状。
  - `apps/server/src/trigger/decide.ts:255-265` — `rawPrompt.trim()===''` → `DEFAULT_EVENT_TEMPLATES[event]`，否则**原样**用 `rawPrompt`（未做任何拼接）。
  - `apps/server/src/http/webhook-v21.ts:359-362` — `v21TemplateOf` 同一条裁决，供面板预览/直接调用方使用；`apps/server/src/http/webhook-v21.ts:464` 热路径优先用 `decidedTemplate`，两路取值逻辑一致（`apps/server/test/v21-webhook-integration.test.ts:427` 有等价性断言）。
  - `packages/contract/src/settings-v21.ts:473-549` — 五份内置默认模板，均以技能触发词开头。
- **缺口**：无。
- **判定依据**：项目模板与内置模板在代码里是**二选一**（`?:` 表达式），不存在字符串拼接或继承，符合 §6.2「整体覆盖，不追加、不拼接」。
- **反证过程**：
  1. 假设「项目模板与内置模板拼接」→ 实测 `prompt:'CUSTOM {{issue.number}}'` 的返回值逐字节等于 `'CUSTOM {{issue.number}}'`，内置的 `/proposal-analysis` 与正文快照段一个都没出现，推翻假设。
  2. 假设「空白模板会发出空指令」→ 实测 `prompt:'   '` 回落到内置默认模板首行，面板清空输入框不会让 agent 空转。
  3. 假设「面板显示的与实发的是两份」→ 两边都 import `packages/contract/src/settings-v21.ts:473` 的同一常量（`apps/panel/src/components/settings/v21-events-section.tsx:30`、`apps/server/src/trigger/decide.ts:84`），不存在第二份默认值。
  4. 假设「模板字段有但没人读」→ 三条消费链都能追到：判定侧 `decide.ts:257`、预览侧 `webhook-v21.ts:360`、面板侧 `v21-events-section.tsx:260`。

### FR-2.3 占位符替换（重复全替换 / 一次遍历 / 未知原样 + 配置告警）
- **状态**：部分实现
- **证据**：
  - `apps/server/src/prompt/render.ts:170-185` — 单个 `template.replace(PLACEHOLDER_PATTERN, cb)`；`resolvePlaceholder` 返回 `null` 时 `return match`（原样保留）并把名字去重收进 `unknown`。
  - `apps/server/src/prompt/render.ts:90` — 占位符语法 `/\{\{([a-zA-Z0-9_.]+)\}\}/`。
  - `apps/server/src/prompt/render.ts:132-161` — 12 个已知名走 switch，`default: return null` 即未知。
  - `apps/server/src/http/webhook-v21.ts:495-504` + `372-385` — `unknown.length>0` 时 `logger.warn({unknown,event,repo,deliveryId}, …)`，并调用可选钩子 `deps.onUnknownPlaceholders?.()`。
  - `apps/server/src/app/compose.ts:981-984` — 生产装配只注入 `{db, repoIssues}`，**没有注入 `onUnknownPlaceholders`**。
  - 全仓 `grep onUnknownPlaceholders`：仅定义处、调用处、测试夹具三处；`apps/server/src/db/schema.ts` 无任何告警表（`webhook_deliveries` 只有 `decision` / `decision_reason` 两列，`schema.ts:112-124`），也无对应查询与面板读取。
- **缺口**：需求明写「同时在后台记一条配置告警」，而实现只有一行结构化 `warn` 日志 + 一个默认不注入的内存回调。缺「可查记录」这一子条件：无落库列/表，无 `http/api` 读取路径，面板无任何未知占位符视图，运维只能去 grep journald。附带缺陷：`{{ repo }}`（占位符内有空格）不匹配 `PLACEHOLDER_PATTERN`，被当成普通文本原样输出且**不进 `unknown`**，即「写错格式的占位符」连日志告警都没有。
- **判定依据**：三条替换规则可实测证实且都符合；但「后台记一条配置告警」按证据口径 §三.2 属「有函数/有日志 ≠ 有可查记录」，默认装配下不产生任何可查询痕迹，故只能判部分实现。
- **反证过程**：
  1. 假设「用 `replace` 只替换第一次就停」→ 实测模板 `A={{issue.number}} B={{issue.number}}` 得 `A=1950 B=1950`，两处都换，推翻假设（且代码里没有 `String.prototype.replace` 的单次字符串重载，用的是正则回调）。
  2. 假设「替换结果被二次替换」→ 构造 `issue.content='正文里有 {{issue.url}} 和 {{issue.foo}}'`，实测输出里 `{{issue.url}}` / `{{issue.foo}}` **原封不动**留在正文，说明值没有被再扫一遍；再构造 `actor='{{issue.title}}'`，输出 `actor={{issue.title}} then T` —— 值里的占位符保留、模板自身的 `{{issue.title}}` 正常替换，二次替换确实不存在。
  3. 假设「未知占位符被替换成空串」→ 实测 `{{a.b}} {{c_d}}` → 输出 `{{a.b}} … {{c_d}}`，`unknown:["a.b","c_d"]`，不是空串。
  4. 假设「告警只是测试里的断言」→ 追生产消费方：`reportV21UnknownPlaceholders` 真的调 `logger.warn`（pino），但 `compose.ts:981` 未注入钩子、库表无对应列、面板无读取点 → 结论是「有日志、无可查记录」，缺口成立而非空穴来风。
  5. 假设「带空格的占位符也会被告警」→ 实测 `{{ repo }}` 原样输出且不在 `unknown` 里，假设被推翻（这是缺口的一部分）。
  6. 假设「未知占位符会污染其它已知替换」→ 实测 `{{a.b}} {{issue.number}} {{c_d}}` 中 `{{issue.number}}` 正常渲染为 `1`，互不影响。

### FR-2.4 评论事件的额外闸门 + 默认值 + 顺序
- **状态**：已实现
- **证据**：
  - `packages/contract/src/settings-v21.ts:105-118` — 默认 `require_mention:true` / `require_role:false` / `ignore_bot:true` / `allow_closed:false` / `allow_roles:[]`；实测 `parse({})` 一致，逐格对上需求「是 / 否 / 是 / 否」。
  - `apps/server/src/trigger/decide.ts:225-243` — 顺序为「② 开关 → ③ 事件条件 → ④ 评论闸门 → ⑤ 去重 → ⑥ 配额」，闸门确实在开关之后；`switch-off` 时函数已在第 229 行 return。
  - `apps/server/src/trigger/decide.ts:173-201` — 四闸门各自有独立 `SkippedReason`（`bot-self` / `closed-not-allowed` / `not-mentioned` / `role-denied`）。
  - `apps/server/src/config/v21-settings.ts:132-144` — 闸门从 `triggers.events['issue_comment.created'].gates` 取，是事件级而非 `comment` 段，可单独配置。
  - `packages/contract/src/repo-config.ts:301-309` — `allow_roles` 引用不存在的角色名保存即报错，满足「只能从角色清单里选」。
- **缺口**：无（`require_role:true` + `allow_roles:[]` 的取值属需求未定义区，见额外问题）。
- **判定依据**：默认值、四个闸门的存在、判定顺序三者都有可执行路径，且顺序被探针实测证实（开关关闭时 reason 是 `switch-off` 而不是 `not-mentioned`）。
- **反证过程**：
  1. 假设「闸门顺序在开关之前」→ 实测评论事件 `enabled:'off'` + 正文「没有提及」→ `reason:'switch-off'`（不是 `not-mentioned`），`decide.ts:227-229` 的提前 return 生效，假设推翻。
  2. 假设「默认值表写反」→ 逐格比对：需求 是/否/是/否，代码 `true/false/true/false`，实测默认设置下「机器人自己」→ `bot-self`、「已关闭 issue」→ `closed-not-allowed`、「无提及」→ `not-mentioned`，三者都按默认值拦。
  3. 假设「闸门字段有但没人读」→ `resolveCommentGates` 是唯一出口，`decide.ts:174` 每次评论都调；关掉某闸门后行为随之改变（`apps/server/test/trigger-decide.test.ts:241,271,311` 覆盖）。
  4. 假设「`allow_roles` 可以随意填写」→ `repo-config.ts:301-306` 用 `findUnknownAllowRoles` 硬校验，超集会被拒。
  5. 检查松侧组合：`require_role:true` + `allow_roles:[]` 实测 `{allowed:true, matchedRoles:[]}`，即**放行所有人**（`apps/server/src/trigger/roles.ts:69-72`，且 `apps/server/test/trigger-decide.test.ts:359-369` 把这条行为写成了用例）。需求未定义该组合，选择松的一侧确有风险，但不构成「与需求相反」，故不判冲突。

### FR-2.5 合法提及（@ + 关键词 + 分隔符，四用例）
- **状态**：已实现
- **证据**：
  - `apps/server/src/trigger/mention.ts:134-161` — 先 `maskCodeRegions`，再逐个 `@` 位置判前导字符与关键词/分隔符。
  - `apps/server/src/trigger/mention.ts:100-121` — 关键词必须紧贴 `@`，且 `masked.charAt(end)` 必须是分隔符，否则 `continue`。
  - `apps/server/src/trigger/mention.ts:50-58` + `70-75` — 分隔符白名单：空白/换行/半角与全角标点/字符串结尾；中文**不在**名单内（`isMentionSeparator('你') === false`，实测）。
  - `apps/server/src/trigger/mention.ts:67,78-80` — 前导禁区 `[A-Za-z0-9._@-]`，`foo@pi-bot` / `@@pi-bot` 不算。
  - `apps/server/test/trigger-mention.test.ts:13-30` — 需求表格四条各有一个用例，断言的是 `findLegalMention` 的返回值而非状态码。
- **缺口**：无。
- **判定依据**：四个用例逐条实测（见反证），命中/不命中与需求表格完全一致；判定不是用 `includes` 或未锚定正则，而是「位置定位 + 分隔符白名单」。
- **反证过程**（逐条实测，`tsx` 直调 `findLegalMention`，关键词 `pi-bot`）：
  1. `@pi-bot 帮我看看这条` → `{keyword:'pi-bot', start:0, end:7}` **命中**，与需求「合法」一致。
  2. `@pi-bot`（只有提及无正文）→ 命中（end=7，`charAt(7)===''` → 字符串结尾算分隔符），与需求「合法」一致。
  3. `@pi-bot帮我看看这条` → **null**，因为 `charAt(7)==='帮'` 不在 `SEPARATOR_CHARS`、`\s` 也不匹配，与需求「不合法」一致。
  4. `@pi-botx 帮我看看` → **null**，因为 `charAt(7)==='x'` 不是分隔符；这不是前缀匹配漏判，是分隔符白名单挡住了更长的名字，与需求「不合法」一致。
  5. 额外反证「中文被当成边界」→ `isMentionSeparator('你') === false`，与需求 §5.2 注意条「`@pi-bot你好` 不会被识别」一致（不是缺陷）。
  6. 额外反证「前缀/邮箱误命中」→ `mail foo@pi-bot 帮看` → null（前导 `o` 命中禁区）；`@@pi-bot 帮看` → null。
  7. 额外反证「用 includes 未锚定」→ 若用 `body.includes('@pi-bot')`，第 4 例会误命中；实测第 4 例为 null，证明实现不是 `includes` 语义。
  8. 额外反证「代码区也触发」→ 围栏块内 `@pi-bot` → null（复用契约 `maskCodeRegions`）。

## 本节整体结论
FR-2.1 / FR-2.2 / FR-2.4 / FR-2.5 四条可以判为已实现：默认值表逐格对上契约常量并被判定函数真实消费，模板是二选一整体覆盖（实测无拼接），四闸门默认值与顺序经实测确认（开关关闭时不会被闸门抢走 reason），合法提及四个用例逐条实测全部符合。FR-2.3 的三条替换规则全部正确（重复全替换、一次遍历不二次替换、未知原样保留），但「未知占位符在后台记一条配置告警」只有一行 `logger.warn`（生产装配未注入告警钩子、库中无告警列/表、面板无读取点），因此判**部分实现**。整个 5.2 小节**不能**判为「已实现」，缺口集中在 FR-2.3 的告警可查性。

## 核查边界
- 是否执行了命令：
  - `git status --short`、`git log --oneline -3` — 与 `_baseline.txt` 一致。
  - `node_modules/.bin/tsx <scratch>/probe-u09.ts`（仓库外临时脚本，只 import 实现里的纯函数，未改仓库）— 输出：四用例命中/不命中符合需求；`eventTriggersSchema.parse({})` 五格默认值；渲染三条规则；`require_role+allow_roles=[]` 放行。
  - `node_modules/.bin/tsx <scratch>/probe-u09b.ts` — 输出：`labeled on + labels[]` → `label-not-matched`；`edited only_body_changed=false` → 触发；`{{ repo }}` 原样输出且不在 `unknown`；值内含占位符不会被二次替换。
  - **未执行** `vitest`（本单元为静态 + 纯函数探针核查，测试只按「存在且断言具体」口径声明，未声明为绿）。
- 未覆盖的条目及原因：无遗漏条目。「告警是否真的进 journald」属运行环境，未验证（不影响本单元结论：可查性缺口在代码层已可判定）。
- 发现的额外问题（不属本节范围，仅记录）：
  1. `enabled` 三态在条件事件上无差别：`issues.labeled` 配 `enabled:'on'` 但 `labels:[]` 仍 `label-not-matched`，`on` 与 `conditional` 只影响 `decision_reason`（`enabled` vs `conditional-met`），第三态对条件事件没有实际控制力，面板上「触发」这个选项容易被理解成「无条件触发」。
  2. `require_role:true` + `allow_roles:[]` = 放行所有人（`trigger/roles.ts:69-72`，且已有用例 `test/trigger-decide.test.ts:359` 固化该行为）。需求未定义该组合，实现选择了松的一侧；若面板允许保存这种半成品配置，等于把「限定角色」静默降级为「不限定」。
  3. `{{ repo }}`（占位符内含空格）这类格式写错既不替换也不进 `unknown`，即无名无告警，与「未知占位符要记告警」的意图不一致（`prompt/render.ts:90` 的正则不接受空格）。
  4. `webhook_deliveries` 只有 `decision` / `decision_reason` 两列，未触发原因靠 `SkippedReason` 字符串承载；若将来要为「未知占位符告警」做可查视图，需要新增列或表（当前 `compose.ts:981` 的注入点已经预留了钩子，落库侧是空的）。
