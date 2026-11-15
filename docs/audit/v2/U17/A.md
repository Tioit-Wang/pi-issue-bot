# U17 6.4 配置示例 · A

> 核查范围：docs/requirements.html 行 1559-1587
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览

| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| EX-1 `triggers.<event>.enabled` 开关 | 已实现 | 无缺口（布尔被三态枚举 `on/off/conditional` 取代，语义为超集） |
| EX-2 `triggers.<event>.prompt` 事件提示词模板 | 已实现 | 无缺口 |
| EX-3 `issues.edited.only_body_changed` | 已实现 | 无缺口 |
| EX-4 评论四闸门 `require_mention`/`require_role`/`ignore_bot`/`allow_closed` | 已实现 | 无缺口（示例平摊在事件下，实际嵌在 `gates`） |
| EX-5 项目级配置载体 | 已实现 | 载体为 DB `repos.settings` jsonb，非 YAML；快照仅进程内，未按事件持久化 |

## 逐条

### EX-1 `triggers` 可按事件配置 `enabled`

- **状态**：已实现
- **证据**：
  - `packages/contract/src/settings-v21.ts:83` — `eventTriggerSchema` 的 `enabled: eventSwitchSchema.default('on')`；`:69-73` 定义 `EVENT_SWITCHES = ['on','off','conditional']`，`:306` 评论事件条目 `enabled` 默认 `conditional`。
  - `packages/contract/src/settings-v21.ts:326-333` — `eventTriggersSchema` 逐事件给默认值（opened `on`、edited `on`、labeled `conditional`、closed `off`、comment `conditional`），挂在 `triggers.events`（`packages/contract/src/trigger.ts:55`）。
  - 消费方：`apps/server/src/config/v21-settings.ts:109` 把 `trigger.enabled` 摊进 `ResolvedEventTrigger`；`apps/server/src/trigger/decide.ts:227-229` `trigger.enabled === 'off'` → `skip(event,'switch-off')`，`:264` 触发原因区分 `enabled` / `conditional-met`。
  - 调用链完整：`apps/server/src/http/webhook-v21.ts:176` `decideEvent(decideInput)`，`webhook.ts:1194` 注明交给 `decideEvent()`。
- **缺口**：无。示例写布尔 `enabled: true`，实际是 `on|off|conditional` 三态枚举；`on`/`off` 覆盖布尔两种取值，`conditional` 是「过附加条件才触发」的超集。按本单元口径（命名/形态不同不算缺口）判已实现。
- **判定依据**：字段在 schema 有默认值，且存在「读配置 → 决定不触发并留痕」的执行路径与断言型测试（`apps/server/test/trigger-decide.test.ts` 覆盖 `switch-off` 分支）；不是死字段。

### EX-2 `triggers.<event>.prompt` 事件提示词模板

- **状态**：已实现
- **证据**：
  - `packages/contract/src/settings-v21.ts:85` — `prompt: z.string().max(EVENT_PROMPT_MAX_CHARS).nullable().default(null)`（`null` = 用内置默认，`:22` 上限 4000）；评论事件同字段在 `:307`。
  - 内置默认模板与项目模板同源：`packages/contract/src/settings-v21.ts:473-549` `DEFAULT_EVENT_TEMPLATES`、`:552` `defaultEventTemplate()`。
  - 消费方：`apps/server/src/config/v21-settings.ts:110` 取 `trigger.prompt`；`apps/server/src/trigger/decide.ts:257-258` 解析 —— 空白/null 回落 `DEFAULT_EVENT_TEMPLATES[event]`，否则用项目模板，结果放进 `TriggeredDecision.template`。
  - 真正生效到消息：`apps/server/src/http/webhook-v21.ts:1017` `decidedTemplate: decision.template` → `:464` `renderTemplateAsync(input.template, input.ctx)` → `:1034` `body: build.text` 落 `agent_messages.comment_body`。`:359-360` 另有 `v21TemplateOf()` 供非判定路径读同一字段。
- **缺口**：无。
- **判定依据**：有字段、有解析、有渲染、有落库写入点，四段全通；且「空串等同 null 用内置」的分支在 `decide.ts:257` 显式处理，不是只声明不消费。

### EX-3 `issues.edited` 的「只认正文变更」开关

- **状态**：已实现
- **证据**：
  - `packages/contract/src/settings-v21.ts:87` — `only_body_changed: z.boolean().optional()`；默认值在 `:329` `eventTriggerSchema.prefault({ enabled: 'on', only_body_changed: true })`，与示例 `true` 一致。
  - 消费方：`apps/server/src/config/v21-settings.ts:111` — `onlyBodyChanged: event === 'issues.edited' ? trigger.only_body_changed === true : false`（其它事件恒 false，防误读）。
  - 判定：`apps/server/src/trigger/decide.ts:145-152` — 开关打开且 `changedFields` 不含 `body` → `skip(...,'body-unchanged')`；`:147` 载荷缺 `changes` 时按「未变更」处理。
  - 测试：`apps/server/test/trigger-decide.test.ts:134-157`（只改标题/只改标签 → `body-unchanged`）、`:170-174`（关掉开关后只改标题也触发）。
- **缺口**：无。
- **判定依据**：开关两侧行为都有断言（开 → 拦；关 → 放行），证明它真的参与判定而非仅存在于契约。

### EX-4 `issue_comment.created` 的四个闸门

- **状态**：已实现
- **证据**：
  - 契约：`packages/contract/src/settings-v21.ts:105-118` `commentGatesSchema` —— `require_mention`（默认 `true`）、`require_role`（`false`）、`allow_roles`（`[]`）、`ignore_bot`（`true`）、`allow_closed`（`false`）；挂在评论事件 `:310` `gates: commentGatesSchema.prefault({})`。跨字段校验（`allow_roles` 必须引用已定义角色）在 `packages/contract/src/repo-config.ts:301-309`。
  - 读取：`apps/server/src/config/v21-settings.ts:132-144` `resolveCommentGates()` 逐字段摊出四个闸门。
  - 消费：`apps/server/src/trigger/decide.ts:173-201` —— `:175` `ignore_bot` → `bot-self`；`:178` `!allow_closed` + 已关闭 → `closed-not-allowed`；`:181-186` `require_mention` → `not-mentioned`；`:188-199` `require_role` + `matchCommentRole` → `role-denied`。判定顺序（环境性闸门在前）在 `:169-171` 说明且与需求 FR-2.4 优先级一致。
  - 测试：`apps/server/test/trigger-decide.test.ts:229-238`（`bot-self`）、`:255-275`（`allow_closed` 默认拦 / 打开后放行）；`apps/server/test/v21-webhook-integration.test.ts:294-319` 端到端留痕 `bot-self`；`apps/server/test/v21-settings.test.ts:99-123` 闸门取值解析。
- **缺口**：无。示例把四个键平摊在事件下，实际多一层 `gates` 容器（且多一个 `allow_roles`）；按本单元口径属形态差异，不算缺口。
- **判定依据**：四个闸门各有独立拒绝原因码（`bot-self` / `closed-not-allowed` / `not-mentioned` / `role-denied`），说明它们分别被判定逻辑消费，不是写进 schema 后无人读取。

### EX-5 配置载体是项目级

- **状态**：已实现
- **证据**：
  - 存储：`apps/server/src/db/schema.ts:156` `settings: jsonb('settings').notNull().default({})`，`:137-141` 注释明确「多仓库改造后的**配置与开关的唯一载体**」「`.github/pi-bot.yml` 已整体退役」；配套列 `settings_valid`（`:158`）、`settings_error`（`:160`）、`settings_updated_at`（`:162`）。
  - 形状：`packages/contract/src/repo-config.ts:211-239` `repoSettingsShapeSchema`（`triggers` / `comment` / `labels` / `skills` / `limits` / `agent` 六段），严格层 `:268` `repoSettingsSchema`，`:350` 注明旧名 `repoConfigSchema` 属 `.github/pi-bot.yml` 时代、已 deprecated。
  - 读路径：`apps/server/src/config/repo-config.ts:255-293` `readRepoPolicy()` 读行 → `parseStoredSettings` → `settingsValid`；装配处 `apps/server/src/app/compose.ts:838` `settings: async (repo) => (await readRepoPolicy(pool, repo)).settings ?? null`，随 `rt.settings` 进入判定与渲染（`apps/server/src/http/webhook-v21.ts:1008`）。
  - 写路径：`apps/server/src/config/repo-config.ts:182` `upsert`（含 `settings` / `settings_valid` / `settings_updated_at`）。
  - 覆盖语义：`packages/contract/src/settings-v21.ts:326-334` 每个事件键 `prefault` 默认值；`repo-config.ts:222` `triggers: triggersConfigSchema.prefault({})` —— 项目配置整体覆盖内置默认，不追加。
- **缺口**：无功能缺口（载体不同按本单元口径不算缺口）。需记录的载体差异与影响：
  1. 示例载体是仓库内 `.github/pi-bot.yml`（受版本控制、随代码走），实际载体是**平台 DB 的 `repos.settings` jsonb**（`db/schema.ts:140` 明文写「已整体退役」）。对需求 6.2「配置随事件打成快照」而言，DB 载体**不比**文件载体更差：文件载体在 webhook 读取与 agent 执行之间可能被 push 改动，DB 载体同样是可变行，两者都需要显式快照。
  2. 实际快照只做到**进程内**：`webhook-v21.ts:1008` 把 `rt.settings` 交给 `buildV21AgentMessage`，同一份用于判定模板与渲染（`decide.ts:257` + `webhook-v21.ts:464`），满足 BR-8「同一事件内判定与渲染同一份」。但该份快照**未随事件持久化**——重放/回溯时读的是当时的 `repos.settings`，不是事件时刻快照。此点属 6.2/BR-8 范围，此处仅记录。
  3. 载体差异带来的可见副作用：`.github/pi-bot.yml` 时代的 `repos.config` 列为过渡期保留列（`db/schema.ts:167-168`，`@deprecated`），旧配置文件内容不再被读取。
- **判定依据**：项目级配置存储存在（DB 列 + 严格 schema + 读/写/校验路径齐全），配置项按仓库作用域生效，满足 EX-5 的唯一实质要求「有项目级配置存储」。

## 本节整体结论

6.4 示例里出现的五类配置面（事件开关、事件提示词模板、`issues.edited` 的只认正文变更、评论四闸门、项目级配置载体）在契约 schema 中**全部存在**，且每一项都能追到「读它 → 改变判定结果」的消费路径，并配有断言具体原因的测试，不存在死字段或死开关。示例与实现的三处差异属形态而非语义：`enabled` 由布尔升为 `on/off/conditional` 三态（超集）、四个闸门多套一层 `gates` 容器、载体由 YAML 文件改为 DB jsonb。文档自身声明「字段名待设计阶段确定」，按本单元口径这三处均不构成缺口，故本节判定为**已实现**。唯一需要跨节留意的不是 6.4 的字段面，而是 6.2 的快照强度：配置在单次投递内是同一份，但不落库，重放取不到事件时刻的配置版本。

## 核查边界

- 是否执行了命令：未执行，纯静态核查（仅 Read / Grep；未运行测试、未起 PG、未跑 typecheck），结论对应 `_baseline.txt` 记录的 HEAD `fbfa029` 与工作区状态。
- 未覆盖的条目及原因：无未覆盖条目。示例中的 `prompt` 模板正文（`/issue-format-check#{{issue.number}} ...`）与占位符细节属 6.3 范围，本条只核「有可配置模板位」；技能 id 是否存在未展开核查。
- 发现的额外问题（不属本节范围但值得记录）：
  1. **配置快照未持久化**（对应 6.2 / BR-8）：`webhook-v21.ts:1008` 起判定与渲染共用同一份内存 settings，但仓库无「按事件/投递存 settings 快照」的写入点；`webhook_deliveries` 只存 `decision` / `decision_reason`（`webhook-v21.ts:199` 注释），重放时用当前配置。若 BR-8 要求「事后可证明当时用的是哪份配置」，此处不足。
  2. **示例不可直接解析**：`triggers.events.*.enabled` 是 `.strict()` 上下文里的枚举（`settings-v21.ts:69-73`），示例的布尔 `true` 与平摊的闸门键会因未知键被拒。文档已标注「示意」，但读者照抄会失败。
  3. **同一语义两条路径**：`agent.system_prompt` 与 `agent.limits.system_prompt`、`agent.actions` 与 `agent.limits.actions` 各存在两份（`repo-config.ts:184-197`），靠 `resolveAgentExecution()`（`v21-settings.ts:200-222`）裁决优先级。不影响 6.4，但增加配置面理解成本。
  4. `issues.edited` 的 `only_body_changed` 在载荷缺 `changes` 时按「未变更」拦下（`decide.ts:147`），这是安全侧取舍，但与「只认正文变更」的字面含义存在解读空间，建议文档补一句。
