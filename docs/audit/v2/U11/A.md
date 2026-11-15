# U11 5.4 提示词下发 · A

> 核查范围：docs/requirements.html 行 925-951
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览

| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| FR-4.1 | 部分实现 | 四段顺序只在渲染层保序、只对内置默认模板成立；自定义模板无任何结构校验，且「触发词 → 技能选择」的结构化链路在取件时断了一环（`claimOldest` 不返回 `skill_ids`），当前靠正文文本兜底才路由得上 |
| FR-4.2 | 与需求冲突 | 五个事件模板**全部**含 `{{issue.content}}`，没有任何「首个事件 / 后续事件」分支，后续事件仍然整篇重发正文 |

## 逐条

### FR-4.1

- **状态**：部分实现
- **证据**：
  - `packages/contract/src/settings-v21.ts:473` — `DEFAULT_EVENT_TEMPLATES` 五个事件模板的唯一定义处；`issues.opened` 第 1 行是触发词 `/proposal-analysis`（`:475`），随后 `#{{issue.number}} {{issue.url}}`（`:479`，段 2 锚点与段 3 链接同行、锚点在前），再是 `正文快照：` + 三引号围栏 + `{{issue.content}}`（`:485`-`:488`）。`issues.edited:491`、`issues.labeled:506`、`issues.closed:519`、`issue_comment.created:532` 首行同样以触发词开头，四段顺序一致。
  - `packages/contract/src/settings-v21.ts:85` — 模板字段的约束只有 `z.string().max(EVENT_PROMPT_MAX_CHARS).nullable().default(null)`：**只限长度，不校验四段结构**。
  - `apps/server/src/prompt/render.ts:170` — 渲染用一次 `template.replace(PLACEHOLDER_PATTERN, …)` 做纯字面替换（`:173`-`:183`），返回值之外不重排、不删行、不裁剪；即渲染层**不会打乱**顺序。
  - `apps/server/src/http/webhook-v21.ts:359` — 项目模板与内置默认模板在此收敛成同一个字符串后一律交给 `renderTemplateAsync()`（`:361`），不存在「默认模板走私有渲染器」的分叉。
  - `apps/server/src/http/webhook-v21.ts:450` — `buildV21AgentMessage()` 渲染后只做一次「首行技能词替换」，不改其余段：`:512` `text: explicitSkill === null ? rendered.text : withSkillFirstLine(rendered.text, explicitSkill)`；`withSkillFirstLine`（`:420`-`:426`）只改首行或另起一行前置，正文各段原位不动。
  - `apps/server/src/app/compose.ts:1239` — 渲染结果作为 `## 这一条消息` 段原样拼在系统段之后（`:1251`），中间不解析、不重排。
  - `apps/server/src/skills/assemble.ts:397` — 装配层只做 `head` + 中间层 + `tail`（`:412`-`:422`），`basePrompt` 自身字节顺序不变；四段都落在 `tail` 里，内部顺序不受插入影响。
  - 触发词 → 技能选择链路（生效路径）：`apps/server/src/http/webhook-v21.ts:394` `v21SkillIdsOf()` 取渲染结果首行匹配 `^/([a-z][a-z0-9-]{1,30})$`（`:396`）→ `:514` 写入 `skillIds` → `:1036` 落 `agent_messages.skill_ids` → `apps/server/src/agent/dispatcher.ts:106` `skillIds: message.skillIds` → `apps/server/src/agent/store.ts:147` 写 `tasks.agent_skill_ids` → `apps/server/src/app/compose.ts:1304` 把同一份正文作为 `triggerText` 交给 enricher → `apps/server/src/app/worker-deps.ts:926` `pickRequestedSkill()` → `apps/server/src/skills/registry.ts:314` `resolve()` → `apps/server/src/app/worker-deps.ts:982` `renderSkillPrompt()` 注入该技能正文。默认模板里的 `/proposal-analysis`（`builtin.ts:178`）、`/label-triage`（`:247`）、`/issue-analysis`（`:297`）都是可加载的内置技能。
- **缺口**：
  1. **四段结构只对内置默认模板成立，自定义模板不受约束**：契约只限长度（`settings-v21.ts:85`），面板侧也只提示长度（`apps/panel/src/components/settings/v21-events-section.tsx:114` 的 `EVENT_PROMPT_MAX_CHARS` 文案），没有「缺触发词 / 缺链接 / 顺序不对」的任何校验或告警。项目把段 1 删掉、或把触发词挪到第二行，保存即生效，此后提示词就不含段 1。
  2. **结构化技能点名在取件处断链**：`apps/server/src/agent/store.ts:139` 的 `claimOldest` 的 `RETURNING` 列表是 `"repo","issue_number","fingerprint","kind","status","comment_id","comment_body","actor_login","created_at"`，**不含 `skill_ids`**；而 `:201` 又是按 `row['skill_ids']` 读的。于是 `claimNextForIssue()` 返回的行 `skillIds` 恒为 `[]`，`tasks.agent_skill_ids` 恒写入 `[]`（`:148`），`pickRequestedSkill` 的结构化分支（`worker-deps.ts:891`-`:896`）在 v2.1 事件/评论消息上**永远走不到**，路由实际由第 3 条「正文文本兜底」（`worker-deps.ts:903`-`:908`）承担。眼下结果正确（首行是 `/名字`、且在已加载集合里），但这条链路与 `agent-skill-wiring.test.ts:39`「结构化点名是装配层唯一可信来源」的断言不一致：测试覆盖的是 `pickRequestedSkill()` 纯函数入参，没有覆盖「库里那一列是否真的取回来了」。
  3. 次生影响：因为 `v21SkillIdsOf()` 要求**整行只有** `/名字`（`webhook-v21.ts:396`），首行写成 `/issue-format 看一下` 这类（注释里自己的测试模板 `v21-webhook-integration.test.ts:27` 就是纯 `/issue-format`）时结构化名称为空，只剩文本兜底；再叠加第 2 条，一旦正文首行不是行首命令词，技能选择就退化到「按 description 自选」。
- **判定依据**：段 1-4 的内容与相对顺序在**内置默认模板**（`settings-v21.ts:473`-`549`）与**渲染/装配/拼接三层**（`render.ts:170`、`assemble.ts:397`、`compose.ts:1239`）都有可定位的实现，且被 `apps/server/test/v21-webhook-integration.test.ts:363`（断言 `skillAt < numberAt < linkAt < snapshotAt`）与 `:390`（内置默认模板同样断言）钉住，因此「顺序固定」这一子条件在默认路径上成立、不是纸面承诺。但需求定位的模板是**项目可编辑的**（同一份默认只是缺省值），代码对该字段零结构约束，加上结构化路由链路在 `claimOldest` 处断开，故只能判部分实现而非已实现。

### FR-4.2

- **状态**：与需求冲突
- **证据**：
  - `packages/contract/src/settings-v21.ts:487` — `issues.opened` 模板含 `{{issue.content}}`（`正文快照：` 段内）。
  - `packages/contract/src/settings-v21.ts:502` — `issues.edited` 模板含 `{{issue.content}}`，且前置说明是「这是修改后的正文快照」（`:500`）：发的是**改后整篇**，不是变更片段。
  - `packages/contract/src/settings-v21.ts:515` — `issues.labeled` 模板含 `{{issue.content}}`。
  - `packages/contract/src/settings-v21.ts:528` — `issues.closed` 模板含 `{{issue.content}}`。
  - `packages/contract/src/settings-v21.ts:546` — `issue_comment.created` 模板含 `{{issue.content}}`（`issue 正文快照：` 段内），即**评论事件也整篇重发**。
  - `apps/server/src/http/webhook-v21.ts:450` — `buildV21AgentMessage()` 的入参里没有任何「是否该 issue 首个事件」的信号（`settings/event/repo/eventAction/payload/deps/logger/deliveryId/decidedTemplate/aliases`），渲染分支唯一（`:476` 一次 `renderV21AgentText`）。
  - `apps/server/src/trigger/decide.ts:209` — 判定流程 ①-⑥（`:216`-`:253`）不含「首次 / 后续」判断；触发时给出的只有 `template`（`:260`-`:265`），模板文本与事件序无关。
  - `apps/server/src/http/webhook-v21.ts:787` — v2.1 会话侧只读写 `state / sandbox_id / session_id / turns / cursor`（`:786`-`:803`），`turns` 仅用于会话状态机与轮换，**没有**参与提示词渲染的取舍。
- **缺口**：需求要求「首个事件下发完整正文；后续事件只下发变更内容与本轮指令」。代码每条事件都按同一模板渲染，模板里写死了 `{{issue.content}}`（整篇），因此后续事件必然整篇重发；`issues.edited` 也没有取 `payload.changes.body.from` 之类的前后对比，只有改后全文。反向缺口：没有任何「首个事件」的判定点（无 `turns === 0` / 无 `agent_messages` 历史计数分支），两级语义压根没有实现，谈不上增量粒度选取（需求把粒度留给了 Q-4，但「是否首发」这一层是 FR-4.2 自身要求）。
- **判定依据**：需求明写「后续事件只下发变更内容……不重复整篇正文」，而五个默认模板（含评论事件）各自都带正文占位符，逐行行号已列出；渲染入口与判定入口均无首发/后续分支。这是代码行为与需求方向相反，且能用具体行号指出「反着来」的那一处（`settings-v21.ts:546` 最直接：评论这类最常见的「后续事件」也在发整篇正文），故判与需求冲突，而非「未实现」（实现是有的，且实现的是反面语义）。

## 本节整体结论

FR-4.1 的渲染与拼接是真实实现、顺序在默认模板与三层处理上都保得住，但「四段」只是默认模板的写法，不是被强制的契约，且触发词到技能选择的结构化链路在 `claimOldest` 取件处断了（`store.ts:139` 无 `skill_ids`），当前正确性依赖正文文本兜底 —— 属于「主链路对、有明确瑕疵」，判部分实现。FR-4.2 与需求相反：五个模板（含评论事件）都整篇下发正文，无首发/后续分支，判与需求冲突。因此本节**不能**判为已实现。

## 核查边界

- 是否执行了命令：执行 `npx vitest run test/v21-webhook-integration.test.ts test/v21-comment-skill.test.ts test/agent-skill-wiring.test.ts test/prompt-render.test.ts`（工作目录 `apps/server`），结果 4 个文件 43 个用例全通过。另尝试用 `npx tsx` 跑一段脚本直接验证「首行触发词 → `pickRequestedSkill()`」的取值，因仓库内有依赖的 `exports` 缺失（`@octokit/auth-unauthenticated`）在 import 阶段失败，**未得到运行结果**，该结论改由静态读码 + 上述单测支撑。
- 未覆盖的条目及原因：无（本节只 FR-4.1 / FR-4.2 两条，均已核）。未覆盖的部分子条件：真实模型侧「是否真的按注入的技能正文执行」需真模型，属 FR-5.x 范围，本节不外推。
- 发现的额外问题（不属本节范围但值得记录）：
  1. `apps/server/src/agent/store.ts:139` 的 `claimOldest` 缺 `skill_ids`（属技能装配层问题，本节已作为 FR-4.1 缺口记录；因它同时影响 FR-1.x 的「点名即路由」，建议单独立项）。
  2. `{{issue.content}}` 在 v2 渲染里**没有长度上限**：`apps/server/src/prompt/render.ts:148` 直接 `stringify(ctx.issue.content)`，而 v0.3 路径有 `AGENT_MAX_BODY_CHARS = 4_000`（`apps/server/src/agent/constants.ts:14`、`agent/message.ts:187`）。超长 issue 会挤爆提示词预算，最终由 `apps/server/src/skills/assemble.ts:443` 的丢弃策略兜底，而那里的移除顺序是「先 project（`:452`）、后技能正文（`:455`）」—— 丢掉的正是触发词对应的那个技能。
  3. 命中技能时正文在最终提示词里出现**两次**：`apps/server/src/app/compose.ts:1251`（`## 这一条消息` 段，整段渲染结果）与 `apps/server/src/skills/prompt.ts:737`（技能层的 `### issue 正文` 段，另经 `sanitizeUntrustedText` 上限 4_000，见 `:634`）。只在该轮命中技能时发生（`apps/server/src/app/worker-deps.ts:977`-`:994` 仅 `skill !== undefined` 才渲染技能正文）。FR-4.2 的「不重复整篇正文」因此又多一处同源重复。
  4. `apps/server/src/http/webhook-v21.ts:984` — `legacyCommand` 为真时 v2.1 分支直接 `return null`，回落到 v0.3 的 `composeAgentMessage()`（`apps/server/src/agent/message.ts:266`）；那条消息体没有链接段（模板见 `:36`-`:52`），触发词也被改写成「按技能 `x` 的要求执行」（`:85`）而非 `/x`，即命令通道不满足 FR-4.1 的四段。是否算违规取决于命令通道是否属于本节口径，交由汇总侧判。
  5. 核查用目录列举时看到了 `docs/audit/v2/U11/` 下除本文件外的文件名（未读取其内容），按规范属越界动作，一并如实记录。
