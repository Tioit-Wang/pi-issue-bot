# U17 6.4 配置示例 · B

> 核查范围：docs/requirements.html 行 1559-1587
> 代码基线：见 docs/audit/v2/_baseline.txt

视角说明：本节文档明写「字段名待设计阶段确定」，因此**只核字段面的语义是否存在并被消费**，命名差异不计为缺口。反证假设：每条都「大概率只有形似字段、没有真正生效」，逐条去证伪。

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| EX-1 按事件的 `enabled` 开关 | 部分实现 | 字段与消费路径齐全，但事件对象被「部分写入」时事件级默认值失效（`issues.closed: {prompt: x}` 会变成 `enabled: on`，而 FR-2.1 默认是关闭） |
| EX-2 按事件的 `prompt` 模板 | 已实现 | 字段、默认回落、渲染、落库快照四段齐全 |
| EX-3 `issues.edited` 只认正文变更 | 部分实现 | 开关存在且被判定消费，但同一「部分写入」路径下默认值退化成「任意编辑都触发」，且面板显示（勾选）与运行时判定（false）相反 |
| EX-4 评论四个闸门 | 已实现 | 四个闸门字段、默认值、判定顺序、载荷来源全部到位 |
| EX-5 项目级配置存储 | 已实现 | 载体是 DB jsonb（文档允许不同载体），写入走校验后落库 |

## 逐条

### EX-1
- **状态**：部分实现
- **证据**：
  - `packages/contract/src/settings-v21.ts:83` — `enabled: eventSwitchSchema.default('on')`，三态 `on/off/conditional`（`:69`）；`:328`-`:332` 逐事件预置默认值（opened `on`、edited `on`、labeled `conditional`+`[]`、closed `off`、comment `conditional`）。
  - `apps/server/src/trigger/decide.ts:226`-`:229` — `resolveEventTrigger()` 取出后 `enabled === 'off'` 直接 `skip(event, 'switch-off')`，且该分支在任何闸门之前，符合 FR-2.4「开关关闭时闸门一律不生效」。
  - `apps/server/src/config/v21-settings.ts:105`-`:116` — 开关被摊成业务语义值 `enabled`，非死字段。
- **缺口**：需求 FR-2.1 明写「未配置时继承平台默认值」（`docs/requirements.html:760`）。事件对象**部分写入**时这条不成立：`eventTriggerSchema` 的 `enabled` 自带 `.default('on')`，而 `:328`-`:332` 的 `prefault` 只在**整个事件键缺失**时才生效，于是 `issues.closed: { prompt: 'x' }` 解析出 `enabled: 'on'`（默认应为 `off`），`issues.labeled: { prompt: 'x' }` 同理退化成 `on` 而非 `conditional`。缺的子条件是「事件级默认值在部分写入时仍然继承」。
- **判定依据**：开关本身不是死字段（有解析、有判定、有面板三态），所以不是未实现；但默认值继承是需求明写的子条件，在一个真实可写入的配置形态（PUT 直接传 settings 对象）下反着来，故只能算部分实现。
- **反证过程**：
  1. 先假设「`enabled` 只是面板字段、判定侧不读」→ 被 `decide.ts:227` 的 `switch-off` 分支推翻。
  2. 再假设「三态是自造语义、不等于示例的布尔」→ 三态是语义超集（`off` 即示例的 `false`），按任务口径不算缺口，推翻的是「命名不同=缺口」。
  3. 再假设「默认值总会被填上，所以事件级默认一定生效」→ 用仓库内 zod 4.6.7 实测 `prefault` 语义：`'issues.closed': {}` → `{"enabled":"on"}`、`'issues.closed': {prompt:'x'}` → `{"enabled":"on","prompt":"x"}`。假设被推翻，缺口成立。
  4. 契约测试没有覆盖这一格：`packages/contract/test/settings-v21.test.ts:89`-`:95` 只测「只给 `issues.closed` 时其余事件取默认值」，未测「给 `issues.closed` 但只给部分字段」。

### EX-2
- **状态**：已实现
- **证据**：
  - `packages/contract/src/settings-v21.ts:85` — `prompt: z.string().max(EVENT_PROMPT_MAX_CHARS).nullable().default(null)`；`:307` 评论事件同形；`:473`-`:549` 五个事件的内置默认模板。
  - `apps/server/src/trigger/decide.ts:257`-`:258` — `trigger.prompt ?? ''`，空白一律回落内置模板（不是发空指令），并在未触发分支外才产出 `template`（`:260`-`:265`）。
  - `apps/server/src/http/webhook-v21.ts:464` — `decidedTemplate ?? v21TemplateOf(...)`；`:476` 渲染；`:1029`-`:1037` 把渲染结果作为消息正文落库（`body: build.text`）。
- **缺口**：无（示例里的 `prompt` 块标量写法见「发现的额外问题」第 1 条，属载体差异不属本节缺口）。
- **判定依据**：字段存在、有默认回落、有渲染消费方、结果进入真实消息体，四段都能定位到实现路径，符合「存在且生效」。
- **反证过程**：
  1. 假设「`prompt` 只是存着、判定侧不用」→ `decide.ts:257` 直接读它，推翻。
  2. 假设「为空串时会发一条空指令」（最危险的形似实现）→ `:258` 用 `trim() === ''` 判定并回落内置模板，推翻。
  3. 假设「解析出模板但下游另取一份 settings，导致面板看到 A、实际发 B」→ `webhook-v21.ts:1017` 传 `decidedTemplate: decision.template`，`:445`-`:448` 写明热路径优先用它，推翻。
  4. 假设「模板渲染结果不落库、事后无法追溯」→ `:1034` 落 `agent_messages.comment_body`，推翻。

### EX-3
- **状态**：部分实现
- **证据**：
  - `packages/contract/src/settings-v21.ts:87` — `only_body_changed: z.boolean().optional()`；`:329` — `'issues.edited': eventTriggerSchema.prefault({ enabled: 'on', only_body_changed: true })`。
  - `apps/server/src/config/v21-settings.ts:111` — `event === 'issues.edited' ? trigger.only_body_changed === true : false`（其余事件恒 `false`）。
  - `apps/server/src/trigger/decide.ts:145`-`:153` — 开关为真时 `changed.includes('body')` 才放行，否则 `body-unchanged`；`:138` 判定入口由 `webhook-v21.ts:138` 从 payload 的 `changes` 键取。
- **缺口**：两个子条件不成立。
  1. 默认值：`only_body_changed` 无字段级 `.default()`，仅靠 `:329` 的 `prefault`，因此**只要事件对象被部分写入**（例如只改模板 `issues.edited: { prompt: '...' }`），解析结果就没有该键，`v21-settings.ts:111` 的 `=== true` 得到 `false` → 「任意编辑都触发」，与 FR-2.1「仅正文变更时触发」（`docs/requirements.html:767`）相反。实测 zod 4.6.7：`{'issues.edited': {prompt:'x'}}` → `{"enabled":"on","prompt":"x"}`。
  2. 面板与判定侧不一致：`apps/panel/src/components/settings/v21-events-section.tsx:279` 用 `only_body_changed !== false`（缺省视为开），`v21-settings.ts:111` 用 `=== true`（缺省视为关）。同一份 settings 面板显示「正文变更才触发」为勾选，运行时却按「任意编辑都触发」执行。
- **判定依据**：字段与判定链路都在，不是缺失字段的形似实现；但「默认只认正文变更」这条被需求明确的语义在部分写入路径上不成立，且面板与运行时相反，故为部分实现并点名该子条件。
- **反证过程**：
  1. 假设「代码里只有任意编辑都触发」（任务点名的形似实现）→ 被 `decide.ts:146`-`:150` 推翻：开关为真时确实比对 `changes` 里的 `body`。
  2. 假设「开关写了但没人读」→ `v21-settings.ts:111` 消费，且 `trigger-decide.test.ts:134`-`:141`、`:144`-`:152` 断言只改标题/标签得 `body-unchanged`，推翻。
  3. 假设「默认值一定会被填上」→ 同 EX-1 的实测：`prefault` 只在整个事件键缺失时生效，部分写入时键为空 → `onlyBodyChanged` 为 `false`。契约测试只覆盖了整体缺省（`packages/contract/test/settings-v21.test.ts:63`、`:93`），没有覆盖部分写入，所以这个缺口不会被现有测试发现。
  4. 假设「面板只是显示问题，不影响行为」→ 面板显示与 `PUT /api/repos/:owner/:name/settings` 写入的是同一份对象（`apps/server/src/http/api/index.ts:324` 的 body 就是 `repoSettingsSchema`），面板「看着是开」的对象直接落库，行为与显示分叉，两处都不是无害。

### EX-4
- **状态**：已实现
- **证据**：
  - `packages/contract/src/settings-v21.ts:108`-`:116` — `require_mention` 默认 `true`、`require_role` 默认 `false`、`ignore_bot` 默认 `true`、`allow_closed` 默认 `false`，四个都是字段级 `.default()`（与 EX-1/EX-3 不同，部分写入也不会丢默认）；`:310` 评论事件把 `gates` 以 `prefault({})` 挂进事件。
  - `apps/server/src/config/v21-settings.ts:132`-`:144` — 四个闸门整段取出（含 `allow_roles`），不是死字段。
  - `apps/server/src/trigger/decide.ts:175`-`:199` — 四闸门依次判定：`ignore_bot`→`bot-self`、`!allow_closed && state==='closed'`→`closed-not-allowed`、`require_mention`→`not-mentioned`、`require_role`→`role-denied`；`:238` 只在评论事件上调用。
  - 载荷来源真实存在：`apps/server/src/http/webhook-v21.ts:140`（`issue.state`）、`:141`-`:144`（`sender.type` / `comment.user.type` / `[bot]` 后缀）、`:150`（`author_association`）、`:151`（login）。
- **缺口**：无。四闸门默认值与需求表格一致。
- **判定依据**：需求 FR-2.4 表格四个闸门逐格核对：要求提及=是 `/true/`、限定角色=否 `/false/`、忽略机器人=是 `/true/`、响应已关闭=否 `/false/`，与 `docs/requirements.html:808`、`:813`、`:818`、`:823` 完全一致；且每个闸门都有真实载荷输入与具体留痕原因，属「存在且生效」。
- **反证过程**：
  1. 逐格对默认值（任务点 2）：`settings-v21.ts:108/110/114/116` = `true/false/true/false`，需求 = 是/否/是/否，一一对应，未被推翻；`packages/contract/test/settings-v21.test.ts:72`-`:78` 用 `toEqual` 整体断言这一组值，不是 `toBe(200)` 式弱断言。
  2. 假设「默认值对但判定不看」→ `decide.ts:175`-`:199` 四处分支各返回独立 reason，`trigger-decide.test.ts:229`-`:238`（bot-self）、`:255`-`:267`（closed-not-allowed）、`:283`-`:292`（not-mentioned）、`:323`-`:332`（role-denied）逐项断言，推翻。
  3. 假设「闸门读的是构造值、线上载荷拿不到」→ `webhook-v21.ts:140`-`:152` 从 GitHub payload 提取 `state`/`type`/`author_association`/`login` 并传入 `decideEvent`，推翻。
  4. 假设「`require_role` 打开后没有任何角色可判、永远放行」→ `decide.ts:188`-`:198` 调 `matchCommentRole()`，`v21-settings.ts:167`-`:171` 把定义侧 `comment.roles` 一并摊平传入，不成立。
  5. 剩余可疑点（记录未计缺口）：`allow_roles` 引用合法性靠 `repoSettingsSchema` 的 superRefine（`packages/contract/src/repo-config.ts:269`），若绕过 `PUT /api/repos/.../settings`（例如手改 jsonb），拼错的角色名仍会静默失效——但那属 §6.6 的引用校验范围，不属本节四闸门默认值。

### EX-5
- **状态**：已实现
- **证据**：
  - `apps/server/src/db/schema.ts:156` — `settings: jsonb('settings').notNull().default({})`；`:158`-`:160` 另有 `settings_valid` / `settings_error`；`:162` `settings_updated_at`。`:140`-`:141` 明确 `.github/pi-bot.yml` 已退役，配置只存在于 `settings`。
  - `packages/contract/src/repo-config.ts:211`、`:268` — 形状层 `repoSettingsShapeSchema` 与带跨字段校验的 `repoSettingsSchema` 就是这份 jsonb 的形状。
  - 写入路径：`apps/server/src/http/api/index.ts:319`-`:340`（`PUT /api/repos/:owner/:name/settings`，body 直接是 `repoSettingsSchema`）→ `apps/server/src/config/repo-config.ts:449`-`:473`（先 `validateRepoSettings()`，非法一个字都不写，last-known-good 继续生效）。
  - 读取路径：`apps/server/src/config/v21-settings.ts:70`-`:77` `readV21Settings()` + 四个 `resolve*`，判定与执行都从这里取值。
- **缺口**：无。载体与示例的 `.github/pi-bot.yml` 不同（DB jsonb 而非仓库内 YAML 文件），按任务约定不算缺口。
- **判定依据**：项目级配置有唯一载体、有 schema 形状、有校验后写入、有判定/执行侧读取，满足「配置存在且被使用」；载体差异已被任务显式豁免。
- **反证过程**：
  1. 假设「配置仍只能通过仓库内 YAML 提供」→ `config/index.ts:8`-`:9` 写明 YAML 解析器「`.github/pi-bot.yml` 退役后已无生产调用者」，生产路径是 DB jsonb，推翻。
  2. 假设「jsonb 是死列、真正生效的是别的来源」→ `v21-settings.ts:70`-`:77` 是判定侧唯一入口（`decide.ts:226` 即 `resolveEventTrigger(input.settings, event)`），推翻。
  3. 载体差异对两条要求的影响（任务点 3）：
     - **改配置不改代码**：DB 载体**更容易**——面板/HTTP 写入即生效（`api/index.ts:319`），不必 commit、不必发版，`repo-config.ts:449` 还保证非法配置不覆盖最后合法值。YAML 载体则需要改仓库文件 + 提交 + 拉取。
     - **配置随事件打快照**：DB 载体**更难**——仓库里只有 `settings`（原地覆盖）与 `settings_updated_at`（`:162`），没有配置版本历史；全仓搜不到 `settings_snapshot` 之类的按事件留存的配置副本。当前唯一可追溯的是**渲染后的模板正文**落进消息体（`webhook-v21.ts:1034`）。相比之下 YAML 在 git 里天然带版本历史。结论：改配置更容易，配置快照更难；若要求「事后能还原当时生效的整份配置」，需要在写任务时另存一份 settings，目前没有。
  4. 反向核对（任务点 4）——schema 里属于触发配置、但本节示例未出现的字段：`triggers.events['issues.labeled'].labels`（`settings-v21.ts:89`，示例无 labeled 段）；`gates.allow_roles`（`:112`，示例只有布尔 `require_role`，没有角色选择面）；`comment.mentions` / `comment.roles`（`:198`-`:203`，属 §6.6）；`agent.limits.*` 与 `agent.actions`（`:231`-`:246`）；`labels.vocabulary`（`repo-config.ts:100`）。实现比示例丰富，不算缺口，但会影响文档同步：读者按 6.4 的示例理解，会以为评论闸门只有四个布尔、没有 `allow_roles`。

## 本节整体结论
本节五条都以「字段面是否存在且被消费」为准，EX-2 / EX-4 / EX-5 可判为已实现，证据链完整（字段 → 解析 → 判定 → 留痕/渲染/落库）。EX-1 与 EX-3 不能判为已实现：两者都是同一根因——事件级默认值靠 `eventTriggerSchema.prefault(...)`，而 `prefault` 只在**整个事件键缺失**时生效，字段本身又没有 `only_body_changed` 的 `.default()`，导致「只写 enabled/prompt 的事件」解析后拿到字段级默认（`enabled: 'on'`）或空值，`issues.closed` 会被误开、`issues.edited` 退化成任意编辑都触发；EX-3 还多一处面板（`!== false`）与运行时（`=== true`）语义相反。因此本节整体应判「部分实现」，缺口集中在默认值继承，不在字段命名或载体选择。

## 核查边界
- 是否执行了命令：执行了三条只读命令，均未写入仓库。① `node -e` 在 `apps/server` 下用仓库内 zod 4.6.7 复现 `prefault` 语义（`{}` → 默认齐全；`{'issues.edited': {enabled:'on'}}` → 无 `only_body_changed`；`{'issues.closed': {prompt:'x'}}` → `enabled:'on'`）；② `Get-ChildItem apps\server\src\http\api` + `Select-String` 定位 settings 写入端点；③ `Test-Path` 检查产出目录。**未执行** `pnpm test` / `typecheck`，测试结论均为「测试存在且断言具体」，不是「测试跑过且绿」。
- 未覆盖的条目及原因：无（EX-1 ~ EX-5 全部给出结论）。面板渲染的完整交互（切换事件标签页后 defaults 如何回填）未逐屏核对，只核到 `v21-events-section.tsx:274`-`:286` 的开关与 `:279` 的判空方向。
- 发现的额外问题（不属本节范围但值得记录）：
  1. 示例用 `prompt: |` 块标量，而仓库的受限 YAML 子集解析器明确拒绝块标量（`apps/server/src/config/yaml.ts:245`-`:247`）。因 YAML 载体现已退役（`config/index.ts:8`），这不影响运行时，但若把 6.4 的示例当成「可直接抄进 .github/pi-bot.yml 的文件」会加载失败；同时也说明文档 6.4 的载体表述与实现已不一致，需要同批同步。
  2. 面板 `v21-events-section.tsx:279` 与 `v21-settings.ts:111` 对同一个缺省值给出相反解释，属跨层默认值重复定义（应是两处真相），建议默认值只留在契约一处。
  3. `apps/server/src/config/yaml.ts` 全体模块已无生产调用者（`config/index.ts:8`），只有测试与 `skills/frontmatter.ts` 复用；`config/index.ts:9` 自己标注「W3 之后可整体删除」，与本节的配置载体结论同源，可作为文档同步时的依据。
