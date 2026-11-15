# U11 5.4 提示词下发 · B

> 核查范围：docs/requirements.html 行 925-951
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| FR-4.1 | 部分实现 | 四段结构、触发词→技能路由、正文快照都有真实执行路径；但「顺序固定」只是内置默认模板的巧合，项目模板无任何顺序/首行校验，违反顺序既不报错也不告警 |
| FR-4.2 | 与需求冲突 | 默认模板在 `issues.edited`／评论／labeled／closed 上每次都重发整篇 `{{issue.content}}`，全仓无「首次全量／后续增量」判据，`payload.changes` 只在判定阶段用完即丢，同时影响 BR-4 |

## 逐条

### FR-4.1
- **状态**：部分实现
- **证据**：
  - `packages/contract/src/settings-v21.ts:473`-`549` — 五个事件的默认模板逐段拼接：首行 `/proposal-analysis`（475）、`/label-triage`（506）、`/issue-analysis`（519、532）；锚点与链接同一行 `#{{issue.number}} {{issue.url}}`（479、494、508、521、534）；正文快照在末段 `{{issue.content}}`（487、502、515、528、546）。
  - `apps/server/src/http/webhook-v21.ts:394`-`399` — 触发词被**真实消费**：只取渲染结果首行、`/^\/[a-z][a-z0-9-]{1,30}$/u` 整行匹配后产出 `skillIds`；`:514` 把它写进 `V21MessageBuild.skillIds`；`:1036` 传给 `insertMessage`；`apps/server/src/agent/store.ts:147`、`:331`-`332` 落 `agent_messages.skill_ids` 与 `tasks.agent_skill_ids`；`apps/server/src/agent/dispatcher.ts:106` 读回传给 `insertAgentTask`；`apps/server/src/app/worker-deps.ts:891`-`896` 作为第 1 优先级选出技能，`:982`-`993` 注入该技能正文。
  - `apps/server/src/app/compose.ts:1141`、`:1236`-`1252` — 渲染结果 `tasks.prompt_text` 真的进入本轮提示词（`## 这一条消息` 段），不是只落库。
  - 测试按**下标先后**断言顺序：`apps/server/test/v21-webhook-integration.test.ts:375`-`382`（项目模板，`numberAt > skillAt`、`linkAt > numberAt`、`snapshotAt > linkAt`）、`:398`-`401`（内置默认模板同样四个不等式）；`apps/server/test/agent-skill-wiring.test.ts:38`-`43` 断言 `skillIds` → `pickRequestedSkill` 真的选中技能。
- **缺口**：
  1. 「顺序固定」没有平台侧保证：模板 schema 只有长度上限（`packages/contract/src/settings-v21.ts:85` — `z.string().max(EVENT_PROMPT_MAX_CHARS)`），渲染器只做字面替换（`apps/server/src/prompt/render.ts:170`-`185`），没有任何「四段齐否／顺序对否」校验或告警；面板同样只校验长度（`apps/panel/src/components/settings/v21-events-section.tsx:623`、`:636`）。项目把正文快照写在第一行、触发词写在最后一行，平台照发不误。
  2. 「触发词是技能路由的唯一依据」在顺序被破坏时**静默退化**：首行不是触发词 → `v21SkillIdsOf` 返回空（`webhook-v21.ts:396`-`398`）→ `skill_ids` 空且**没有任何 warn**（`webhook-v21.ts:514` 无分支告警）；后续之所以还能加载技能，靠的是「触发文本兜底」`worker-deps.ts:903`-`908`（且要求名字已在已加载集合里），即首行并非硬约束。
  3. 上述两条都由测试钉在「合规模板」上：`v21-webhook-integration.test.ts:26`-`33` 的项目模板本身就是按四段手写的，因此用例只证明「合规模板按序渲染」，不证明「顺序被平台约束」。
- **判定依据**：构成、路由、快照三件事都能追到执行路径并以可观察断言覆盖（消息正文、`skillIds`、注入的技能正文），故不是「未实现」；但需求明写的「顺序固定」只有默认字符串与用例断言，没有平台保证，属点名一个子条件缺失 → 部分实现。
- **反证过程**：
  - (a) 假设「顺序只是默认模板凑巧」→ 成立：顺序信息只存在于 `settings-v21.ts:473`-`549` 的字面量里，`render.ts` 与 `webhook-v21.ts` 均不感知段序 → 顺序**不是**硬约束。
  - (b) 自定义模板能否违反顺序而不报错 → 能：`eventTriggerSchema.prompt` 只限长度（`settings-v21.ts:85`），`renderTemplate` 原样替换（`render.ts:170`-`185`），`buildV21AgentMessage` 无段序检查（`webhook-v21.ts:450`-`516`）；`test/v21-webhook-integration.test.ts:406`-`430` 的等价性用例只比较模板串相等，另加 `startsWith(expectedSkill)`（`:429`）—— 仅约束「触发词在最前」，不检查四段整体顺序。
  - (c) 是否有按下标断言的测试 → 有，但只覆盖合规输入（见证据 4 条）：`v21-webhook-integration.test.ts:375`-`382`、`:398`-`401` 是 `toBeGreaterThan` 下标比较（比「包含」强），可它们对「不合规模板」无断言 —— 属于「测试存在且断言具体，但覆盖面=合规输入」。
  - (d) 触发词是否真被解析用于技能选择 → 是（`webhook-v21.ts:394`-`399` → `store.ts:331` → `dispatcher.ts:106` → `worker-deps.ts:891`-`896`），但存在文本兜底 `worker-deps.ts:903`-`908`，所以「唯一依据」实际上是「首选依据」。
  - (e) 是否存在违反四段顺序且仍可被激活的旧通道 → 代码里有：`apps/server/src/agent/message.ts:35`-`69` 的 `AGENT_MESSAGE_TEMPLATES.opened/edited` 没有触发词段，段序是 仓库→编号→标题→正文→项目规范→技能指令→目录（`:37`-`52`），与 FR-4.1 完全不同。它在生产是否可达：`apps/server/src/http/webhook.ts:1294`-`1307` 只在 `deps.v21 === undefined` 时接管，而生产装配固定注入 `v21`（`apps/server/src/app/compose.ts:981`-`984`），故生产不可达，仅测试/其他装配可达 —— 记为额外风险而非本节违规。

### FR-4.2
- **状态**：与需求冲突
- **证据**：
  - `packages/contract/src/settings-v21.ts:490`-`504` — `issues.edited` 默认模板每次都发整篇正文：`:500` 文案「这是修改后的正文快照」+ `:502` `{{issue.content}}`；「后续事件只下发变更」被**反着实现**。
  - 同文件 `:513`-`516`（labeled）、`:524`-`529`（closed）、`:544`-`547`（issue_comment.created）同样在每次事件都带 `{{issue.content}}`。
  - `apps/server/src/http/webhook-v21.ts:450`-`516` — 唯一的 v2 消息构建路径，只有一个 `template`、一次 `renderTemplateAsync`，**没有**「这条 issue 是不是第一个事件」的分支；`webhook-v21.ts:464` 直接取模板，`:1029`-`1037` 原样落库。
  - `apps/server/src/prompt/render.ts:64`-`77` — `RenderContext` 里没有 `changes` 字段，渲染阶段拿不到「改了哪些字段」，也没有「变更片段」占位符：12 个占位符清单 `packages/contract/src/settings-v21.ts:420`-`433` 里没有任何增量类占位符。
  - `payload.changes` 的生命周期：`apps/server/src/http/webhook-v21.ts:129`-`138` 抽成 `changedFields` → 只喂判定 `apps/server/src/trigger/decide.ts:145`-`153`（`only_body_changed` 闸门）→ 用完即丢，不进渲染上下文。
  - 第二处全量载体：`apps/server/src/skills/prompt.ts:737` 在装配提示词时**无条件**渲染 `### issue 正文`（`context.body`），也不区分首轮/后续；该产出经 `apps/server/src/app/worker-deps.ts:982`-`993` 每轮注入。
  - 全仓检索 `firstEvent` / `first_event` / `isFirst` / `首次全量` / `首次事件` / `增量`（限 `apps/server/src`、`apps/panel/src`、`packages/contract/src`）：命中全部属于压缩摘要（`compact/summary.ts`）、流式增量（`degeneracy/*`、`run-task.ts`）、写回增量（`worker/writeback.ts`），**没有一处**与「事件下发首轮全量 / 后续增量」相关。
- **缺口**：需求要求「后续事件只下发变更内容与本轮指令，不重复整篇正文——历史由会话承担」；代码在 `issues.edited` 等**每一次**后续事件上主动重发整篇正文（`:500`-`503` 明确写着「修改后的正文快照」）。缺的子条件就是「后续事件不下发整篇正文」这一半，且第一半（首事件全量）虽满足但因为没有分支，无法区分首轮与后续。这同时影响 BR-4（上下文预算 / 会话复用收益）：会话已有历史，却每轮再灌一遍全文。
- **判定依据**：不是「找不到实现」（那是未实现），而是代码行为与需求字面相反且能指到具体行（`settings-v21.ts:500`-`503`、`:515`、`:528`、`:546` 在后续事件上重发全文），按模板口径属「与需求冲突」。
- **反证过程**：
  - 假设「增量根本没实现」→ 结果为真，且比「没实现」更强：不是漏做，而是默认模板主动重复全量。
  - 检查所有默认事件模板是否都含 `{{issue.content}}` → 五个全含（`settings-v21.ts:487`、`:502`、`:515`、`:528`、`:546`），没有「后续事件」变体。
  - 检查 `issues.edited` 的 `changes` 是否在**渲染阶段**被使用 → 否：`webhook-v21.ts:129`-`138` 只产 `changedFields` 给 `decide.ts:145`-`153`；`render.ts:64`-`77` 的 `RenderContext` 根本没有这个字段，占位符清单也没有对应项。
  - 检查是否有「会话已有历史就省掉正文」的旁路 → 没有：`compose.ts:1228`-`1233` 的会话计划只决定复用/新建 session，`compose.ts:1236`-`1252` 无论会话新旧都把整条消息（含模板渲染出的全文）拼进提示词。
  - 检查是否靠技能层兜住 → 反而更糟：`skills/prompt.ts:737` 每轮再注入一次 issue 正文，等于两条通道都在重发全文。

## 本节整体结论
FR-4.1 的骨架是真的：默认模板四段齐全、锚点与链接同段、正文快照收尾，触发词经 `skill_ids` 一路到「注入哪份技能正文」都有可观察断言。但「顺序固定」只存在于那份默认字符串与两个合规用例里，模板 schema 与渲染器都不校验段序，项目改坏顺序时平台既不报错也不告警，首行触发词失配时结构化点名静默变空（只靠文本兜底捡回来），因此只能判**部分实现**。FR-4.2 判**与需求冲突**：`issues.edited` 等后续事件的默认模板每次都重发整篇正文，全仓没有首轮/增量判据，`changes` 停在判定层。综合看，本节**不能**判为「已实现」。

## 核查边界
- 是否执行了命令：执行了只读检索，未跑测试/构建。`git log --oneline -1` → `fbfa029 docs(requirements): 面板改版并入需求正文，撤掉面板内发…`（与 `_baseline.txt` 的 HEAD 一致）；`Select-String` 全仓检索（`issue.content`、`changes`、`skillIds`、`firstEvent/增量`、`DEFAULT_EVENT_TEMPLATES`、`renderTemplate`、`triggerText` 等）；`Get-ChildItem` 列 `apps/server/src/skills`、`apps/server/src/prompt`。静态阅读的文件：`packages/contract/src/settings-v21.ts`、`apps/server/src/prompt/render.ts`、`apps/server/src/http/webhook-v21.ts`、`apps/server/src/http/webhook.ts`（节选）、`apps/server/src/agent/message.ts`、`apps/server/src/agent/store.ts`（节选）、`apps/server/src/agent/dispatcher.ts`（节选）、`apps/server/src/app/worker-deps.ts`（节选）、`apps/server/src/app/compose.ts`（节选）、`apps/server/src/skills/prompt.ts`（节选）、`apps/server/src/trigger/decide.ts`（节选）、`apps/server/test/v21-webhook-integration.test.ts`（节选）、`apps/server/test/agent-skill-wiring.test.ts`。
- 未覆盖的条目及原因：无（本节仅 FR-4.1、FR-4.2 两条）。未验证「会话历史是否真的被 pi-host 复用」这一运行时事实（需真模型会话，`无法判定` 级别的旁证，不影响上述两条结论）；未运行 `pnpm -r test`，所有测试口径仅声明「存在且断言具体」。
- 发现的额外问题（不属本节范围但值得记录）：
  1. `apps/server/src/agent/message.ts:35`-`69` 的 v0.3 事件模板违反 FR-4.1 四段结构（无触发词段、段序不同）；生产装配 `compose.ts:981`-`984` 固定注入 `v21`，故不可达，但代码仍在（`webhook.ts:1294`-`1307` 保留接管条件）。
  2. `packages/contract/src/settings-v21.ts:490`-`494` 的 `issues.edited` 默认模板在指令段与锚点段之间**缺空行**（其余模板有空行），面板里看到的默认值与其它四个事件排版不一致。
  3. `apps/server/src/skills/prompt.ts:737` 与事件模板是两条独立的「issue 正文」下发通道，任一改动都要同时改两处，目前没有测试绑定二者口径。
