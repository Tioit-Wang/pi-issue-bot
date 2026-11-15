# U2-A｜requirements.html §5.2「事件触发配置」实现核查

- 需求文档：`C:\Code\NodeProjects\pi-issue-bot\docs\requirements.html`（§5.2，行 756-855）
- 仓库：`C:\Code\NodeProjects\pi-issue-bot`
- 核查方式：读源码 + 读测试 + **实跑**（vitest 4 个相关测试文件 99 用例全绿；另用两个 tsx 探针直接调用 `findLegalMention` / `renderTemplate` / `resolveEventTrigger` / `resolveCommentGates` 验证边界与默认值）
- 结论摘要：**五条需求全部「已实现」**；唯一实质缺口是 FR-2.3 的「配置告警」只有结构化日志形态（不落库、无面板提示）。

---

## FR-2.1 每个事件一个触发开关 —— 已实现

### 证据

1. 事件全集与开关三态（`on` / `off` / `conditional`）：
   - [settings-v21.ts](/C:/Code/NodeProjects/pi-issue-bot/packages/contract/src/settings-v21.ts:56) `EVENT_KEYS = ['issues.opened','issues.edited','issues.labeled','issues.closed','issue_comment.created']`；行 69-73 `EVENT_SWITCHES = ['on','off','conditional']`。
   - 每个事件一条配置对象：[settings-v21.ts](/C:/Code/NodeProjects/pi-issue-bot/packages/contract/src/settings-v21.ts:81) `eventTriggerSchema{ enabled, prompt, only_body_changed, labels }`（`.strict()`），评论事件另有 `commentEventTriggerSchema`（行 304-313，`gates`）。
2. **未配置继承平台默认**（逐事件预置默认值，不是"缺了就 undefined"）：
   - [settings-v21.ts](/C:/Code/NodeProjects/pi-issue-bot/packages/contract/src/settings-v21.ts:326) `eventTriggersSchema` 五键全部 `prefault({...})`：
     - `issues.opened` → `on`
     - `issues.edited` → `on` + `only_body_changed: true`
     - `issues.labeled` → `conditional` + `labels: []`
     - `issues.closed` → `off`
     - `issue_comment.created` → `conditional` + `gates: {}`
   - 行 344 `V21_DEFAULT_EVENT_TRIGGERS`、行 365 并入 `DEFAULT_REPO_SETTINGS`。
   - **实跑** `resolveEventTrigger({}, key)`（未配置）逐个确认：
     `opened=on` / `edited=on, onlyBodyChanged=true` / `labeled=conditional, labels=[]` / `closed=off` / `comment=conditional`。与需求表格四列默认值逐格一致。
3. 判定侧读开关：[v21-settings.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/config/v21-settings.ts:105) `resolveEventTrigger()`；`onlyBodyChanged` 对非 `issues.edited` 恒为 `false`（行 111）。
4. 判定顺序里开关是第二道：[decide.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/trigger/decide.ts:225) `if (trigger.enabled === 'off') return skip(event,'switch-off')`（此处在 `repoDisabled` 之后、附加条件与闸门之前）。
5. 附加条件（"仅正文变更" / "命中所配标签"）：
   - [decide.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/trigger/decide.ts:145) `issues.edited`：`onlyBodyChanged` 打开时 `changes` 不含 `body` → `body-unchanged`；载荷没给 `changes` 时按未变更处理（行 147）。
   - [decide.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/trigger/decide.ts:154) `issues.labeled`：`addedLabel` 为空或未命中配置标签（`trim().toLowerCase()` 比较）→ `label-not-matched`；`labels: []` = 永不触发。
6. `pull_request.*` 独立、不进 issue 会话：[webhook-v21.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/http/webhook-v21.ts:86) `event.startsWith('pull_request')` → `'pull_request.*'`；[decide.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/trigger/decide.ts:274) `decidePullRequest()` 恒返回 `pr-ignored` 且**没有 template**；`v21DecisionInputOf()` 对 PR 返回 `null`（行 122），不会构造 issue 会话输入。
7. 事件键映射只认 `issue_comment.created`：[webhook-v21.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/http/webhook-v21.ts:90) `action === 'created'` 才算，`edited`/`deleted` 返回 `null`。
8. 面板逐事件开关：[v21-events-section.tsx](/C:/Code/NodeProjects/pi-issue-bot/apps/panel/src/components/settings/v21-events-section.tsx:227) 每个事件一个 `Segmented` 三态控件（`patchEvent(state, active.key, { enabled })`）。

### 缺口 / 观察

- `issues.labeled` 默认 `conditional` + `labels: []`：默认状态下该事件**永不触发**（没有"所配标签"）。这与"命中所配标签才触发"的字面语义一致，但需求表格把它写成"条件"而未说明"默认无标签即永不触发"；面板已用提示兜住（[v21-events-section.tsx](/C:/Code/NodeProjects/pi-issue-bot/apps/panel/src/components/settings/v21-events-section.tsx:298) "未选标签 = 该事件永不触发"）。
- 需求表格要求 `pull_request.*` 默认"独立（属 PR 会话域）"；本期实现是**完全不处理**（`pr-ignored`，无 PR 会话），属于需求正文 §0「不纳入」的取舍，判定结果"不进 issue 会话"这一条满足。

---

## FR-2.2 触发时发送的提示词模板 —— 已实现

### 证据

1. "项目 + 事件"维度：模板存在 `repos.settings.triggers.events[eventKey].prompt`（[settings-v21.ts](/C:/Code/NodeProjects/pi-issue-bot/packages/contract/src/settings-v21.ts:85) `prompt: z.string().max(EVENT_PROMPT_MAX_CHARS).nullable().default(null)`）；`settings` 挂在 `repos` 上，故维度正是"项目 × 事件"。
2. 纯文本 + 可含占位符：`z.string()`（无结构约束），占位符清单 `PROMPT_PLACEHOLDERS`（[render.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/prompt/render.ts:25) 再导出，渲染在 `resolvePlaceholder`）。
3. 未配置用平台内置默认模板：
   - 内置默认模板定义在契约（面板与服务端共用一份）：[settings-v21.ts](/C:/Code/NodeProjects/pi-issue-bot/packages/contract/src/settings-v21.ts:473) `DEFAULT_EVENT_TEMPLATES`，五个事件各一份，四段顺序（技能触发词 / `#编号` / 链接 / 正文快照）由行 471 的注释承诺。
   - 取值裁决在判定里：[decide.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/trigger/decide.ts:257) `rawPrompt.trim() === '' ? DEFAULT_EVENT_TEMPLATES[event] : rawPrompt`（空白串同样回退，行 255-256 注释说明为何空串不能当"发空指令"）。
4. 模板确实用于生成发给 agent 的指令：[webhook-v21.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/http/webhook-v21.ts:464) `const template = input.decidedTemplate ?? v21TemplateOf(...)` → 渲染 → 行 1029 `insertMessage({ ..., body: build.text })` 落 `agent_messages.comment_body` 作为本轮消息正文。
5. 模板含技能触发词：内置默认模板首行即 `/proposal-analysis` / `/label-triage` / `/issue-analysis`（行 475 / 506 / 519）；评论事件还会用用户点名的 `/skill` 覆盖首行（[webhook-v21.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/http/webhook-v21.ts:508)）。
6. 面板：未自定义时输入框显示内置默认模板，改动保存为 `prompt`，改回默认（逐字相同、换行归一化）则写回 `null`：[v21-events-section.tsx](/C:/Code/NodeProjects/pi-issue-bot/apps/panel/src/components/settings/v21-events-section.tsx:269)。

### 缺口

- 无（面板侧"恢复默认"通过"写回 `null`"实现，契约里只有一种"没写"，不存在 `''` 与 `null` 二义）。

---

## FR-2.3 占位符替换 —— 已实现（告警形态偏弱，见缺口）

### 证据

1. **可重复出现，每处都替换**：[render.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/prompt/render.ts:173) `template.replace(PLACEHOLDER_PATTERN, cb)`——正则 `/\{\{([a-zA-Z0-9_.]+)\}\}/gu`（行 90）带 `g`，`replace` 对每处命中各调一次回调，无"只替第一次"的短路。
2. **一次遍历，替换结果不参与二次替换**：同上，单次 `replace` 就地扫描**原模板**，回调返回值不再被扫描。文件头行 11-13 明确记载这是实现级保证，并说明为什么不能用 `for (name of names) text = text.replaceAll(...)`（行 168 同）。
3. **未知占位符原样保留 + 收集**：[render.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/prompt/render.ts:175) `value === null` 时 `return match`（原样）并 push 到 `unknown`（按首次出现去重，行 176-179）；`resolvePlaceholder` 的 `default: return null`（行 159）就是"未知"。
4. **实跑证据**（探针直接调用 `renderTemplate`）：
   - 模板 `#{{issue.number}} {{issue.number}} | {{issue.content}} | {{issue.foo}} {{issue.foo}}`
   - 输出 `#12 12 | 正文里写了 {{issue.url}} 与 {{issue.foo}} | {{issue.foo}} {{issue.foo}}`，`unknown = ['issue.foo']`
   - 结论：重复占位符两处都替换；`issue.content` 值里字面存在的 `{{issue.url}}` / `{{issue.foo}}` **没有被二次替换**；未知占位符两次出现都原样保留，`unknown` 只记一次。
5. **告警**：[webhook-v21.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/http/webhook-v21.ts:372) `reportV21UnknownPlaceholders()` 落一条结构化 `logger.warn`，字段含 `event / repo / unknown / deliveryId`；调用点 [webhook-v21.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/http/webhook-v21.ts:495)（`rendered.unknown.length > 0` 才触发）。

### 缺口

- 告警**只到日志**：`deps.onUnknownPlaceholders` 钩子（[webhook-v21.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/http/webhook-v21.ts:246)）全仓只有定义与调用两处，`app/compose.ts` 等装配层**未注入**，`db/schema.ts` 也没有任何"配置告警"表（`webhook_deliveries` / `actions` 等 25 张表里无此类）。因此"后台记一条配置告警"目前等于"进程日志里有一条 warn"：进程重启/日志轮转后不可追，面板也不会提示模板写错了。
- 面板侧不做占位符白名单校验（`TemplateField` 只提供插入按钮与长度校验，[v21-events-section.tsx](/C:/Code/NodeProjects/pi-issue-bot/apps/panel/src/components/settings/v21-events-section.tsx:623)），所以写错占位符时用户当场看不到任何反馈。

---

## FR-2.4 评论事件的额外闸门 —— 已实现

### 证据

1. 四闸门与其默认值（契约唯一来源）：[settings-v21.ts](/C:/Code/NodeProjects/pi-issue-bot/packages/contract/src/settings-v21.ts:105) `commentGatesSchema`：
   - 行 108 `require_mention: default(true)` → 需求"是" ✔
   - 行 110 `require_role: default(false)` → 需求"否" ✔
   - 行 114 `ignore_bot: default(true)` → 需求"是" ✔
   - 行 116 `allow_closed: default(false)` → 需求"否" ✔
   - 行 112 `allow_roles: default([])`（角色白名单，只能引用已定义角色）
   - **实跑** `resolveCommentGates({})` 输出 `{require_mention:true, require_role:false, allow_roles:[], ignore_bot:true, allow_closed:false}`（`ok:true`），与需求表格四行逐格一致。
2. 闸门判定实现：[decide.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/trigger/decide.ts:173) `checkCommentGates()`：`ignore_bot && actorIsBot` → `bot-self`；`!allow_closed && issueState==='closed'` → `closed-not-allowed`；`require_mention` → `findLegalMention(...) === null` → `not-mentioned`；`require_role` → `matchCommentRole(...)` 不通过 → `role-denied`。
3. **闸门在事件开关之后，开关关闭时闸门一律不生效**：[decide.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/trigger/decide.ts:227) ② 先返回 `switch-off`，④（行 238）才进闸门；文件头行 11-14 把顺序写成不可调换的约束。测试钉住：[trigger-decide.test.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/test/trigger-decide.test.ts:111)「评论事件被关掉时，缺提及也只记 `switch-off`（不记 `not-mentioned`）」。
4. "是否限定角色，只能从项目角色清单里选"：契约跨字段校验 [repo-config.ts](/C:/Code/NodeProjects/pi-issue-bot/packages/contract/src/repo-config.ts:302) `findUnknownAllowRoles()`，任何不在 `comment.roles` 里的名字 → 保存即报错（行 304-308）。
5. 角色判定：[roles.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/trigger/roles.ts:69) `matchCommentRole()`：`allow_roles` 为空 = 未限定（放行，行 70-72）；按 `association` 或 `members` 匹配，login/association 大小写不敏感（行 36-38、50、59）。
6. 闸门入参确实从载荷接线（不是永远拿不到数据）：[webhook-v21.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/http/webhook-v21.ts:138) `changedFields / addedLabel / issueState / actorIsBot（sender.type==='Bot' 或 comment.user.type==='Bot' 或 login 以 [bot] 结尾）/ comment{body,authorAssociation,authorLogin}`。
7. 面板：四个闸门与关键词、角色清单在同一屏维护（[v21-events-section.tsx](/C:/Code/NodeProjects/pi-issue-bot/apps/panel/src/components/settings/v21-events-section.tsx:318) → `CommentEventConfig`；`allow_roles` 候选只来自 `draft.comment.roles`，行 373-375）。

### 缺口 / 观察

- **闸门之间的判定顺序与需求表格列举顺序不同**（需求表格列：提及 → 角色 → 忽略机器人 → 已关闭；实现：`ignore_bot` → `allow_closed` → `require_mention` → `require_role`）。需求正文只规定"闸门在事件开关之后"，未规定四闸门内部顺序，故不构成冲突；差异只影响 `decision_reason` 归因（实现刻意把"环境性拒绝"提前，见 [decide.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/trigger/decide.ts:169) 的注释）。若运维按需求表格顺序读留痕原因，可能与直觉不同。
- `require_role=true` 但 `allow_roles=[]` 时实现**放行**（[roles.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/trigger/roles.ts:70)），需求未定义该组合（"只能从清单里选"未说"必须选"）；面板另有保存校验兜半成品配置。
- 需求说 issue 关闭后"新评论默认不处理"；实现用的是载荷里 `issue.state`，不看会话状态，语义一致。

---

## FR-2.5 提及关键词与合法提及 —— 已实现

### 证据

1. 分隔符定义（白名单，含中文标点）：[mention.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/trigger/mention.ts:50) `SEPARATOR_CHARS` 含半角 `, . ! ? : ; ( ) [ ] { } < > " ' / \ | ~ \` * & % ^ $ @`，全角/中文 `，。．！？：；、（）【】《》「」『』“”‘’…—～`；[mention.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/trigger/mention.ts:70) `isMentionSeparator()`：`''`（串尾）与 `\s`（空格/换行/制表）也算。
2. **完全匹配而非前缀匹配 + 关键词后必须是分隔符**：[mention.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/trigger/mention.ts:100) `matchKeywordAt()` 先按关键词长度切片比较（行 106-113），命中后**再判关键词后的那一个字符**是否分隔符（行 115），不是分隔符就 `continue` 试下一个关键词、最终返回 `null`。所以 `@pi-botx` 不会命中 `pi-bot`（`x` 不是分隔符）。
3. 多个关键词、最长优先：[mention.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/trigger/mention.ts:96) 按长度倒序排序；[mention.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/trigger/mention.ts:134) `findLegalMention()` 逐 `@` 扫描取最早出现。
4. 关键词可多个、项目级维护：[settings-v21.ts](/C:/Code/NodeProjects/pi-issue-bot/packages/contract/src/settings-v21.ts:200) `mentions: z.array(commentMentionSchema).min(1).max(MAX_COMMENT_KEYWORDS)`；默认清单 `pi-bot`（实跑 `resolveCommentConfig({})` → `[{keyword:'pi-bot', case_sensitive:false}]`）；重复关键词保存即拒（[repo-config.ts](/C:/Code/NodeProjects/pi-issue-bot/packages/contract/src/repo-config.ts:318)）。
5. **需求表格四条用例实跑结果**（探针直接调 `findLegalMention`，关键词 `pi-bot`）：

   | 需求判定 | 评论内容 | 实跑结果 |
   |---|---|---|
   | 合法 | `@pi-bot 帮我看看这条` | 合法 `{keyword:'pi-bot',start:0,end:7}` ✔ |
   | 合法 | `@pi-bot` | 合法 `{keyword:'pi-bot',start:0,end:7}` ✔（串尾算分隔符） |
   | 不合法 | `@pi-bot帮我看看这条` | `null` ✔（`帮` 不在分隔符白名单） |
   | 不合法 | `@pi-botx 帮我看看` | `null` ✔（`x` 不是分隔符；非前缀匹配） |

   追加边界实跑：`@pi-bot，帮看下` / `@pi-bot。` / `@pi-bot）看下` / `@pi-bot\n下一行` / `@pi-bot\t正文` / `@PI-BOT 看下`（缺省不区分大小写）→ 均合法；`@pi-bot-x` / `@pi-bot_` / `foo@pi-bot` / `@小豆你好` → 均不合法。分隔符逐字符：`。，、）！？：/` = true，`- _ # x 你` = false。
6. 与需求"注意条"（[requirements.html](/C:/Code/NodeProjects/pi-issue-bot/docs/requirements.html:853) `@pi-bot你好` 故意不识别）一致：中文不是分隔符，实现与文档口径相同，没有任何"关键词后紧跟中文也算"的放宽。
7. 代码区蒙版（同级要求）：[mention.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/trigger/mention.ts:142) 先 `maskCodeRegions(body)`，围栏/行内代码里的 `@pi-bot` 不算提及。
8. 测试：`apps/server/test/trigger-mention.test.ts` 22 用例逐条对齐需求表格（行 14-29 四条主用例，行 31-39 分隔符/换行，行 112-118 中文关键词）。

### 缺口 / 观察

- 分隔符是**白名单枚举**：`-` `_` `#` `+` `=` 与所有中文字符不算分隔符（有意，行 47-48 注释解释为了不误伤标识符）。若将来要"任意标点都算"，需要扩 `SEPARATOR_CHARS` 表而不是改判定结构。
- 前导禁区 `[A-Za-z0-9._@-]`（[mention.ts](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/trigger/mention.ts:67)）是需求未写、实现补的"防粘连"规则（`foo@pi-bot` 不算），属加强而非放宽。

---

## 本节整体结论

| 需求 | 状态 | 一句话 |
|---|---|---|
| FR-2.1 每个事件一个触发开关 | 已实现 | 五键 `on/off/conditional` 全预置默认值，判定侧开关先于条件与闸门，PR 恒 `pr-ignored` 不进 issue 会话 |
| FR-2.2 触发时发送的提示词模板 | 已实现 | 模板按"项目 × 事件"存在 `triggers.events[*].prompt`，空/空白回退契约内置默认模板，渲染结果即 agent 消息正文 |
| FR-2.3 占位符替换 | 已实现（告警偏弱） | 单次 `replace` 一次遍历、重复占位符每处替换、结果不再二次替换、未知占位符原样保留；**但"配置告警"只写结构化日志，未落库、钩子未接线、面板无提示** |
| FR-2.4 评论事件四闸门 | 已实现 | 四个默认值与需求逐格一致（是/否/是/否），开关关闭时闸门不生效并有测试钉住；角色只能引用已定义角色由保存期 superRefine 硬校验 |
| FR-2.5 提及关键词与合法提及 | 已实现 | 完全匹配 + 关键词后必须是分隔符（白名单含中文标点、中文不算分隔符），需求四条用例实跑结果与文档判定完全一致 |

**残留缺口（按严重度）**

1. FR-2.3「未知占位符记一条配置告警」只有 `logger.warn`：无落库表、`onUnknownPlaceholders` 钩子在装配层未注入、面板不校验占位符名 —— 模板写错时用户侧完全无感。
2. FR-2.4 闸门内部顺序与需求表格列举顺序不同（不影响是否触发，只影响 `decision_reason` 归因）。
3. FR-2.1 `issues.labeled` 默认 `conditional + labels: []` → 默认永不触发；需求表格未点明该副作用（面板有文字提示）。

**验证命令与结果**

- `pnpm --filter @pi-issue-bot/server exec vitest run test/trigger-mention.test.ts test/trigger-decide.test.ts test/prompt-render.test.ts test/v21-settings.test.ts` → 4 文件 99 用例全通过。
- 两个只读探针（`$env:PI_SCRATCH_DIR\probe-52.ts`、`probe-52b.ts`，用 `tsx` 直接 import 源码）输出见上文各条"实跑"。
- 未执行：服务端全量 `pnpm -r test`、`pnpm lint`、`typecheck`（本次为只读核查，未改仓库代码，故不触发 §5 验证矩阵）。
- 本核查**未修改仓库任何文件**。
