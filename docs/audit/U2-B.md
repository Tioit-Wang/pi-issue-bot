# U2-B 需求实现核查（第 5.2 节 FR-2.1 ~ FR-2.5）

审查对象：`C:\Code\NodeProjects\pi-issue-bot`（需求：`docs/requirements.html` 行 756-855）
方法：反证。每条需求先假设「没真正实现」，只有在代码 + 实测双证据下才推翻假设。
只读核查，未改仓库任何文件。工作区存在他人在改的文件（`git status` 有 26 个 M），未触碰。

已执行验证：

- `pnpm --filter @pi-issue-bot/server exec vitest run test/trigger-decide.test.ts test/trigger-mention.test.ts test/prompt-render.test.ts test/v21-settings.test.ts`
  → 4 文件 / 99 用例全绿（21ms + 21ms + 8ms + 10ms）。
- 自写探针 `$env:PI_SCRATCH_DIR\probe-mention.ts`（`pnpm exec tsx`）直接调用生产代码 `findLegalMention`，跑 18 条评论指纹 + 1 条配置指纹，逐条比对 FR-2.5 表格与边界。

---

## FR-2.1 每个事件一个触发开关（默认值表 + edited 只认正文 + labeled 标签清单）

**状态：已实现（本体无争议）；端到端有一处「未受测试保护的映射」缺口。**

### 反证过程（我试过的推翻检查点）

1. **默认值表是否如实给**：怀疑点「文档写 issues.edited 触发，代码可能默认 off」。
   查 `packages/contract/src/settings-v21.ts` 的 `eventTriggersSchema`：`issues.opened → enabled:'on'`、`issues.edited → enabled:'on' + only_body_changed:true`、`issues.labeled → 'conditional' + labels:[]`、`issues.closed → 'off'`、`issue_comment.created → 'conditional' + gates:{}`。与需求表格逐行一致。`prefault` 保证「键缺失 = 过一遍 schema」，所以未配置即继承默认，且内层默认值只有一份来源。
2. **`issues.edited` 是否真的校验「只改标题不触发」**：怀疑点「是不是根本没做前后正文对比，或做成了永远触发」。
   实现**没有**做 before/after 正文 diff，而是信任 GitHub `changes` 键：`webhook-v21.ts:129,138` 把 `payload.changes` 的 key 集合塞进 `changedFields`；`trigger/decide.ts:145-153` 在 `only_body_changed` 为真时要求 `changedFields.includes('body')`，否则 `body-unchanged`。我实测了四种载荷：`['title']`→skip、`['labels']`→skip、`['title','body']`→触发、**载荷缺失 `changes` → `[]` → skip（保守方向）**。结论：语义等价于「只认正文变更」，且失败方向是「不触发」而非「乱触发」。
   - 需要点明的边界：这不是字面意义的「对比前后 body」，而是「相信 GitHub 声明的变更集」。若某天 `changes` 结构变了，退化为永不触发（静默，但安全侧）。
3. **`issues.labeled` 的命中标签清单从哪来**：怀疑点「写死 `bug`/`critical` 之类的常量」。
   清单来自配置：`config/v21-settings.ts:112` `labels: [...(trigger.labels ?? [])]`，`decide.ts:154-161` 与 `addedLabel`（`webhook-v21.ts:139` ← `payload.label.name`）做 trim + lowercase 比对。默认 `labels: []` = 永不触发（`decide.ts:139` 注释与实现一致）。无任何硬编码标签名。
4. **「未配置继承默认」是否被部分配置破坏**：用 `{triggers:{events:{'issues.opened':{enabled:'off'}}}}` 试，其余四个事件仍取各自默认（`trigger-decide.test.ts:102-109` 与 `v21-settings.test.ts:312` 钉住）。
5. **是否真有配置面**：`triggersConfigSchema`（`packages/contract/src/trigger.ts:50-57`）→ `repoSettingsShapeSchema.triggers`（`repo-config.ts:222`）→ `PUT /api/repos/:owner/:name/settings`（`apps/server/src/http/api/index.ts:318-341`，body 直接就是 `repoSettingsSchema`）→ 面板 `apps/panel/src/components/settings/v21-events-section.tsx`（逐事件开关 163-232、`issues.edited` 的「只认正文」勾选 279-281、`labeled` 标签多选 290-304，候选来自 `draft.labels.vocabulary`）。三层齐备。
6. **`pull_request.*` 独立**：`EVENT_KEYS`（`settings-v21.ts:56-62`）**不含** PR；`decidePullRequest()`（`decide.ts:274-276`）恒 `pr-ignored`，且刻意不带模板。

### 证据

- 默认值：`packages/contract/src/settings-v21.ts:304-334`；`V21_DEFAULT_EVENT_TRIGGERS` 在 `:344`
- 判定：`apps/server/src/trigger/decide.ts:209-266`（顺序）、`:226-229`（开关）、`:141-164`（附加条件）
- 载荷映射：`apps/server/src/http/webhook-v21.ts:110-158`
- 配置解析：`apps/server/src/config/v21-settings.ts:105-116`
- 契约/API/面板：`packages/contract/src/trigger.ts:50-57`、`apps/server/src/http/api/index.ts:318-341`、`apps/panel/src/components/settings/v21-events-section.tsx:163-304`
- 测试：`apps/server/test/trigger-decide.test.ts:46-226`（默认值表、开关、edited、labeled 共 17 例）、`apps/server/test/v21-settings.test.ts:47,75-81,312`

### 缺口

- **`payload.changes → changedFields` 这条映射没有测试**：全仓检索 `v21DecisionInputOf`，测试引用为 **0**；`v21-*.test.ts` 里也没有一个 `issues.edited` 的集成用例（`body-unchanged` 只出现在 `trigger-decide.test.ts` 的纯函数层）。也就是说「webhook 真的把 `changes` 传对了」这一点只有代码可信、无断言保护。这是本需求最薄的一环。
- **判定层的 ⑤去重 / ⑥日配额在生产不可达**：`decideEvent` 有 `content-duplicate` / `daily-quota` 分支（`decide.ts:246-253`），但 `webhook.ts:1195` 只传 `repoDisabled`，`v21DecisionInputOf` 的这两个入参（`webhook-v21.ts:117-119`）无人填。`daily_quota`（`v21-settings.ts:211`）因此只在配置读取层出现，事件判定层未生效；去重实际靠 `insertMessage` 指纹兜底。顺序本身没问题（在闸门之后），但那两格是死代码。（严格说属 FR-1.3/配额范畴，因报告口径涉及「判定顺序」一并列出。）

---

## FR-2.2 每个事件一份提示词模板（按项目+事件，未配置用内置默认）

**状态：已实现。**

### 反证过程

1. **「整体覆盖」还是「拼接内置默认」**：怀疑点「实现把项目模板 append 到内置模板后面，导致技能触发词出现两次」。
   实际是整体替换：`decide.ts:255-258`（空白串 → 内置默认，否则原样）、`webhook-v21.ts:359-362` 的 `v21TemplateOf` 同一口径。渲染只发生一次，不存在「先拼再渲染」。
2. **是否两套默认值（面板一套、服务端一套）**：怀疑点「面板填充 A、线上发 B」。
   `DEFAULT_EVENT_TEMPLATES` 定义在契约 `settings-v21.ts:473-549`，`trigger/decide.ts:84` 只做再导出，面板 `v21-events-section.tsx:30` 从契约 import。**单一来源**成立。
3. **内置默认是否真的可用（四段结构）**：`trigger-decide.test.ts:469-478` 逐事件断言「技能触发词开头 + `#{{issue.number}}` + `{{issue.url}}` + 代码块内正文」。
4. **两条取值路径是否等价**：`v21-webhook-integration.test.ts:406-434`「②-C 显式模板解析与 `decideEvent().template` 等价」覆盖了项目模板与内置默认两种。
5. **模板长度/上限是否有约束**：`EVENT_PROMPT_MAX_CHARS=4000`（`settings-v21.ts:22,85`），面板有超限提示（`v21-events-section.tsx:110-114`）。

### 证据

- `apps/server/src/trigger/decide.ts:255-265`、`apps/server/src/http/webhook-v21.ts:351-362`
- `packages/contract/src/settings-v21.ts:473-554`
- 测试：`apps/server/test/trigger-decide.test.ts:443-479`、`apps/server/test/v21-webhook-integration.test.ts:363-434`

### 缺口

无（该条不需要额外的持久化：模板存在 `repos.settings` 的 jsonb 里，随仓库配置走）。

---

## FR-2.3 占位符替换（重复全替换 / 一次遍历 / 未知原样保留 + 配置告警）

**状态：两条硬规则「已实现」；第三条「配置告警」只做到进程日志，**部分实现**（无落库、无指标、无面板或查询入口，且生产未接 hook）。**

### 反证过程

1. **是否只替换第一次**：怀疑点「用了 `replace` 不带 `g`，或 `replaceAll` 循环按名字替换」。
   实现是单次正则 `replace` + 全局标志：`render.ts:90` `/\{\{([a-zA-Z0-9_.]+)\}\}/gu`、`:170-185`。同一占位符出现多次逐处回调。`prompt-render.test.ts:78-82` 断言 `#1950 和 #1950`。
2. **是否二次替换**：怀疑点「先替换正文再整体扫描一遍」。
   `String.replace` 的回调返回值不会被再次扫描；`prompt-render.test.ts:84-96` 用「正文里写字面 `{{issue.url}}`」验证输出仍是字面量，且 `unknown` 为空（证明没进第二遍扫描）。
3. **未知占位符是否静默变空串**：怀疑点「`resolvePlaceholder` 默认返回 `''`」。
   `render.ts:159-160` 默认分支返回 `null`；`:175-181` 遇到 `null` 时 `return match`——**原样返回匹配文本**，同时按首次出现顺序去重收集进 `unknown`。`prompt-render.test.ts:98-102` 断言 `'{{issue.foo}} / {{issue.bar}} / {{issue.foo}}'` 原样 + `unknown=['issue.foo','issue.bar']`。**这条我重点证伪，结论是实现正确，没有静默清空。**
4. **是否有「配置告警」的生产消费方**：怀疑点「`unknown` 只在测试里被断言，跑起来没人知道」。
   `webhook-v21.ts:372-384` 结构化 `logger.warn({unknown,event,repo,deliveryId}, ...)`，`:495-504` 在 `rendered.unknown.length>0` 时调用，并额外给可选钩子 `deps.onUnknownPlaceholders`。集成测试 `v21-webhook-integration.test.ts:435-465` 断言了 warn 字段与钩子入参。**所以不是「只在测试里」**。
   - 但继续追问「告警落到哪里」：`db/schema.ts` 的 20 张表里**没有**任何告警/配置异常表；`compose.ts:979-985` 生产装配 `v21` deps 时**没有**注入 `onUnknownPlaceholders`（全仓仅测试注入）；面板未使用 `PLACEHOLDER_NAME_SET`，模板框下方只渲染「点一下插入」按钮（`v21-events-section.tsx:30`），没有「你写了未知占位符」的提示。→ 结论：告警 = pino 日志一行，不进库、不进指标、面板不可见。
5. **另测一条静默失效路径**：`{{ issue.foo }}`（带空格）不匹配 `PLACEHOLDER_PATTERN` → 既不替换、也不进 `unknown`、也不告警。需求 §6.3 表格的写法一律无空格（`requirements.html:1488-1499`），故**不算违约**，但属「用户手打空格 → 完全静默」的坑，代码里没有注释提到它。

### 证据

- `apps/server/src/prompt/render.ts:89-95,132-162,170-185,193-204`
- `apps/server/src/http/webhook-v21.ts:215-247,364-384,495-504`
- 契约占位符清单：`packages/contract/src/settings-v21.ts:420-460`
- 测试：`apps/server/test/prompt-render.test.ts:77-118,153-177`、`apps/server/test/v21-webhook-integration.test.ts:435-518`

### 缺口

1. 告警**没有持久化**：无库表、无 counter、`onUnknownPlaceholders` 生产未接。需求原文是「同时在后台记一条配置告警」——若「后台」指可事后查询的配置异常记录，则**未满足**；若接受结构化日志，则满足。建议按前者补一条（写 `webhook_deliveries` 附列或独立表 + 面板提示）。
2. `{{ issue.foo }}`（含空格）既不替换也不告警，静默。需求未定义该写法，属可容忍但应加注释或面板正则提示。
3. 未知占位符告警只在**事件触发后**渲染时产生；开关关着、模板里写着错占位符时永远不会有人被告知（配置保存期没有校验）。`PUT /api/repos/.../settings` 只跑 `repoSettingsSchema`（`api/index.ts:324`），不校验模板里的占位符是否合法。

---

## FR-2.4 评论四闸门（提及 / 限定角色 / 忽略机器人 / 已关闭 issue，且在开关之后）

**状态：已实现（默认值、顺序、角色引用校验全部符合）。补一条需求未定义组合的语义缺口。**

### 反证过程

1. **默认值四格**：怀疑点「`ignore_bot` 或 `allow_closed` 的默认被写成放宽侧」。
   `settings-v21.ts:105-118`：`require_mention:true`、`require_role:false`、`allow_roles:[]`、`ignore_bot:true`、`allow_closed:false`。与需求表（是/否/是/否）逐格一致。我实机跑 `commentGatesSchema.parse({})` 的输出与 `V21_DEFAULT_COMMENT_GATES`（`:353`）一致。
2. **顺序是否真在开关之后**：怀疑点「有分支先判闸门，导致开关关着却记 `not-mentioned`」。
   `decide.ts:209-243` 是单一线性函数：`signature-invalid → repo-disabled → 开关(switch-off) → 事件附加条件 → 评论闸门 → 去重 → 配额`，闸门在 `:238` 且**仅** `issue_comment.created` 进入。`trigger-decide.test.ts:111-130` 是专门的负例：「评论事件被关掉 + 缺提及 → 只记 `switch-off`」。集成层 `v21-webhook-integration.test.ts:276-322`（①-A 开关关闭留痕 switch-off、①-B 未提及 not-mentioned / 机器人 bot-self）说明生产管线也走同一条。
   - 额外反证：webhook 里 v0.3 的 `decideWebhookTask()`（自带 mention 门禁）确实在 v2 判定**之后**才跑（`webhook.ts:1243`），且其结果只用来算 `legacyCommand`（`:1261`），v2 接管分支（`:1260-1287`）在 `decision.action==='ignore'` 之前就 return——即 v0.3 的提及门禁**不会**抢在 v2 闸门之前掐掉事件。这条我原本最怀疑，查完确认没有倒序。
3. **「限定角色只能从角色清单里选」是否硬校验**：怀疑点「面板下拉限制、服务端不校验」。
   `repo-config.ts:301-309` 的 `superRefine` 用 `findUnknownAllowRoles` 硬拒未定义角色名，错误落到 `triggers.events.issue_comment.created.gates.allow_roles` 路径 → 保存 400。面板候选也来自 `comment.roles`（`v21-events-section.tsx:101-108,446-460`）。
4. **机器人与已关闭判断的数据源**：`actorIsBot` 由 `sender.type==='Bot'` / `comment.user.type==='Bot'` / login 以 `[bot]` 结尾三路合成（`webhook-v21.ts:141-144`）；`issueState` 取 `payload.issue.state`（`:132,140`）。都来自载荷，不猜测。
5. **闸门之间的先后**：实现是 `ignore_bot → allow_closed → require_mention → require_role`，与需求表格排列不同（需求未规定闸门内部顺序，只规定「闸门在开关之后」）。文件头 `decide.ts:166-172` 给了理由（环境性拒绝优先，避免留痕指向错病因）。**不构成违约。**

### 证据

- 契约默认值：`packages/contract/src/settings-v21.ts:105-118,352-353`
- 判定：`apps/server/src/trigger/decide.ts:166-243`
- 解析：`apps/server/src/config/v21-settings.ts:132-175`
- 跨字段校验：`packages/contract/src/repo-config.ts:293-317`
- 管线接管顺序：`apps/server/src/http/webhook.ts:1192-1201,1250-1292`
- 测试：`apps/server/test/trigger-decide.test.ts:101-131,228-370`、`apps/server/test/v21-webhook-integration.test.ts:289-322`

### 缺口

- **`require_role: true` + `allow_roles: []` = 放行所有人**（`decide.ts:188-199`：`allow_roles` 为空时 `matchCommentRole` 直接允许；`trigger-decide.test.ts:359-369` 把这条固化成「闸门没限定 → 放行」）。需求只说「只允许项目级已定义的角色触发」，没定义「开了限定但一个角色都没选」这种组合。实现选了**放行侧**，且面板文案也写「留空 = 不限定角色」。这是有意为之且两边一致，但安全含义偏松：用户勾上「限定角色」却没选角色时，会误以为已经收紧。建议：要么服务端在 `require_role===true` 时要求 `allow_roles` 非空，要么面板在留空时给显式告警。
- 四个闸门只有 4 个默认值是需求的；`allow_roles` 是第 5 个字段（`gates` 里的引用表），需求表格把它并进「是否限定角色」一行，契约里拆成了 `require_role` + `allow_roles` 两键——不算违约，但配置语义比需求多一层。

---

## FR-2.5 合法提及（@ + 关键词 + 分隔符；四条判定用例）

**状态：已实现，四条用例实测全部符合；额外 14 条边界也正确。**

### 反证过程

1. **是否用 `includes`/宽松正则导致 `@pi-botx` 也命中**：怀疑点「`body.includes('@pi-bot')` 一把梭」。
   实现是「定位 `@` → 逐关键词 compare → **检查关键词后一个字符必须是分隔符**」：`mention.ts:100-121`（`isMentionSeparator` 不通过就 `continue`）、`:143-159` 遍历所有 `@`。我实机验证（`probe-mention.ts` 输出）：
   - `@pi-bot 帮我看看这条` → HIT（需求：合法）
   - `@pi-bot` → HIT（需求：合法，字符串结尾算分隔符，`isMentionSeparator('')===true`）
   - `@pi-bot帮我看看这条` → **NO**（需求：不合法）
   - `@pi-botx 帮我看看` → **NO**（需求：不合法，`x` 不是分隔符）
   - 追加：`@pi-bot_foo` NO、`@pi-bot-foo` NO、`@pi-bot2 看下` NO、`@pi-botx`（结尾）NO、`foo@pi-bot` NO、`@@pi-bot` NO、`@pi-bot你好` **NO**（与需求注意条一致）
   - 正向：换行 / Tab / 中文逗号 / 中文句号 / 中文冒号 / 前导空白 全部 HIT；`@PI-BOT` 缺省大小写不敏感命中。
2. **分隔符集合里有没有中文正文**：怀疑点「白名单里混进了汉字，导致 `@pi-bot你好` 合法」。
   `SEPARATOR_CHARS`（`mention.ts:50-58`）只含半角标点 + **全角/中文标点**（`，。．！？：；、（）【】《》「」『』""''…—～`），**不含汉字**；空白/换行由 `/\s/u` 单独判。中文标点算分隔符与需求「空格、换行或标点」一致。
3. **是否会误命中邮箱/粘连**：`LEADING_FORBIDDEN = /^[A-Za-z0-9._@-]$/`（`:67`），`@` 前不能是字母数字/`._@-`；中文前缀放行（`你好@pi-bot` 命中，需求未涉及，属合理扩展）。
4. **代码区里的 `@pi-bot` 算不算**：`maskCodeRegions` 蒙版围栏块与行内代码（`mention.ts:142`，复用契约 `trigger.ts:109-113`）。需求没写这条，是实现加的保守约束，方向正确（不是放宽）。
5. **最长优先 / 首个命中**：`normalizeKeywords` 按长度倒序（`:96`），同一 `@` 上取最长；`findLegalMention` 返回**最早**出现的一个（`:132`）。需求未规定，属补强。
6. **关键词清单从配置来**：`resolveCommentConfig(settings).mentions`（`v21-settings.ts:159-175`），默认 `[{keyword:'pi-bot'}]`（`repo-config.ts:229-232`）。我另外试了「配置里手写 `@pi-bot`（带 @）」→ 返回 `null`（永不命中）；好在 `commentMentionSchema` 的 `^\S+@...$` 规则（`settings-v21.ts:138`）禁掉了含 `@` 的关键词，配置存不进来。

### 证据

- `apps/server/src/trigger/mention.ts:50-58,67,70-80,100-121,134-166`
- 复用蒙版：`packages/contract/src/trigger.ts:109-113`
- 闸门接线：`apps/server/src/trigger/decide.ts:181-187`
- 测试：`apps/server/test/trigger-mention.test.ts:13-40`（需求四条用例逐条）、`:42-135`；闸门层 `apps/server/test/trigger-decide.test.ts:283-309`
- 实测：本报告「已执行验证」第 2 项的探针输出

### 缺口

无功能缺口。可记的观察：
- 分隔符白名单偏保守（`#` `+` `=` `-` `_` 都不收），`me@pi-bot.com` 这类邮箱形态被 `LEADING_FORBIDDEN` 挡住是正确方向；但 `@pi-bot#123` 不命中——需求未涉及，属有意取舍（`mention.ts:46-48` 有注释说明）。
- `@pi-bot，你好`（中文逗号）算合法提及，与「中文正文粘连不合法」的注意条不冲突，但两者相邻，容易被读成矛盾；需求文档注意条（`requirements.html:851-854`）只提了 `@pi-bot你好`，未提中文标点场景。建议文档补一句。

---

## 本节整体结论

FR-2.1 ~ FR-2.5 的**判定本体是真实实现，不是壳**：五个事件默认值与需求表格逐格一致；`issues.edited` 用 GitHub `changes` 实现「只认正文」（缺 `changes` 时保守不触发）；`issues.labeled` 的标签清单真读配置且默认空 = 不触发；评论四闸门默认值正确、顺序严格在事件开关之后（有专门的「开关关着只记 switch-off」负例）；模板按「项目+事件」整体覆盖内置默认且默认模板只有契约一份来源；占位符是单次遍历 `replace`，重复全替、未知**原样保留**（重点证伪过，没有静默清空）；合法提及的关键词后分隔符白名单实测能正确拒绝 `@pi-botx` / `@pi-bot你好` / `@pi-bot_foo`，四条需求用例 4/4 符合。

反证后仍未推翻的真缺口（按严重度）：

1. **`payload.changes → changedFields` 无任何测试**（`v21DecisionInputOf` 测试引用 0 个），`issues.edited` 在 v2.1 webhook 层也**没有**集成用例。行为靠代码正确，一条断言都没有；一旦 GitHub 载荷结构变动会静默退化成「edited 永不触发」。
2. **FR-2.3 的「配置告警」只到进程日志**：无库表、无指标、面板不可见，生产装配（`compose.ts:981`）也没接 `onUnknownPlaceholders` 钩子。若「后台记一条」指可查询记录，则未满足。
3. **`require_role: true` + `allow_roles: []` 放行所有人**，且被测试固化；需求未定义该组合，实现选了松的一侧。
4. **判定层的 `content-duplicate` / `daily-quota` 分支生产不可达**（webhook 从不传这两个入参），属死代码；`daily_quota` 配置在事件判定层实际不生效。
5. 轻微：`{{ issue.foo }}`（含空格）既不替换也不告警；配置保存期不校验模板占位符合法性；未知占位符只在事件已触发时才被告警。

无「功能未实现」级别的问题；无「与需求冲突」级别的实现。
