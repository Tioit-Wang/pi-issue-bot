# CROSS-2 复核 CHECK-1 / CHECK-2

> 复核对象：`CHECK-1.md`（U01-U05）、`CHECK-2.md`（U06-U10）。
> 方法：不重做全量审查。只对 ① 改变结论方向的「反证裁决」、② CHECK-2 未抽验项中最易错者、③ CHECK-1 的 9 处分歧，亲自打开代码核验。行号为我本次实读结果。
> 基线：HEAD `fbfa029`，工作区含他人未提交改动；本次只写本文件，未改代码。

## 一、对「反证裁决」的验证（最高优先）

| 单元 | 条目 | CHECK-2 的裁决 | 我的核验 | 依据 |
|---|---|---|---|---|
| U07 | P4-4 输出只回调度、校验后执行 | 采信 A（已实现）。理由：`run-task.ts` 的 `!v21Handled` 前置「否掉」B 的「v2.1 链路同样可达」 | **推翻**。`!v21Handled` 只挡 `valid`/`rejected`，**不挡 `not-v21`**：else 分支只赋 `prepared`、不置 `v21Handled`，于是 `not-v21` + `prepared.valid=false` 时兜底评论照发。「不可达」是漏读第三条分支得出的 | `apps/server/src/worker/run-task.ts:1168`-`:1211`（三态：`valid`→置真；`rejected`→置真；`else` 走 `prepareEnvelope` **不置位**）；`:1036`（`taskSource==='agent' ? probeV21Output(captured) : not-v21`，模型不交 v2 信封即 `not-v21`）；`apps/server/src/worker/envelope.ts:137`-`:152`（`text===null` → `valid:false`/`missing-envelope`）；`:1238`-`:1243`（`!v21Handled && prepared!==null && (!prepared.valid` 或 `!hasCommentAction)`）；`apps/server/src/worker/fallback.ts:31`-`:35`、`:45`-`:53`（`agent:event`/`agent:mention` 在白名单内）；`apps/server/src/agent/store.ts:89`-`:90`（v2.1 任务命令就是 `agent:event`） |
| U07 | P4-5 配置改动不需要动 agent | 采信 A（已实现）。理由：`compose.ts:981` 无条件注入 v21，旧链 `webhook.ts:1579` 生产不可达 | **维持结论，修正论证**。CHECK-2 说「有 `deps.v21` 时提前 return」不精确：真正 return 的条件是 `outcome !== null`，而 `legacyCommand`（`/review-pr`）时 `handleV21Webhook` 返回 `null`，会落回旧管线。落点却是 `submitPlanTask`（建 command 任务），不是 `submitAgentMessage`，所以 `agent/message.ts` 的硬编码模板**确实**不可达 | `apps/server/src/http/webhook.ts:1261`（`legacyCommand`）、`:1284`-`:1286`（`outcome!==null` 才 return）、`:1296`（`decision.plan.agent!==undefined` 才走 `submitAgentMessage`）、`:1579`（唯一 `composeAgentMessage` 调用点）；`apps/server/src/http/webhook-v21.ts:984`-`:986`（`legacyCommand` → `return null`） |
| U07 | P4-3 Agent 不直连 GitHub | 采信 B（已实现）。理由：A 用一个「需求正文里不存在的子条件」（执行环境无凭证）自行加码 | **推翻理由，状态存疑**。「执行环境无 GitHub 凭证」不是 A 自造的：它是本单元的**条目定义原文**。CHECK 只查了 `requirements.html:717` 的 callout，漏查口径文件。事实层面 A 的观察也成立 | `docs/audit/verification-plan-v2.md:331`（「P4-3 **Agent 不直连 GitHub**（执行环境无 GitHub 凭证）」）；`apps/server/src/runtime/host-supervisor.ts:487`（`base = options.baseEnv ?? process.env`）；`apps/server/src/app/compose.ts:592`-`:601`（只传 `extraEnv`，未传 `baseEnv`）；`apps/server/src/app/model-env.ts:8`-`:9`（自述「不把整个 `process.env` 灌给子进程」） |
> **区间内自相矛盾（必须记录）**：同一处兜底评论，CHECK-1 的 U04 SA-5 判「生产可达 → 部分实现」，CHECK-2 的 U07 P4-4 判「不可达 → 已实现」。两者不可能同时成立。代码支持 CHECK-1（`not-v21` 分支）。

## 二、对 CHECK-2 未抽验条目的补验

挑选标准：涉及会话 / 去重 / 触发核心链路，共 5 条。

| 条目 | CHECK-2 判定 | 我的核验 | 依据 |
|---|---|---|---|
| U06 SC-1 收到 `issue_comment.created` | 已实现（未抽验） | **维持**，补记一条缺口：PR 上的评论仍进 issue 会话 | `apps/server/src/http/webhook-v21.ts:90`-`:92`（`issue_comment`+`created` → `issue_comment.created`）、`:86`-`:89`（只有 `pull_request*` 事件本身才判 PR，评论事件不看 `issue.pull_request`）；`apps/server/src/http/webhook.ts:1255`-`:1287`（v2 分支接管）。缺口依据：`apps/server/src/http/webhook-v21.ts:307`-`:310` 与 `:323` 只取 `issue.labels`/`issue.number`，无 PR 判别；`migrations/0006_agent.sql:42`（`agent_messages` 主键无 domain 维度），与 `docs/requirements.html:867`「PR 与 issue 各自独立会话」冲突 |
| U06 SC-2 三个闸门 | 已实现（未抽验） | **维持** | `apps/server/src/trigger/decide.ts:173`-`:200`（`ignore_bot`→`allow_closed`→`require_mention`→`require_role`，各带独立 reason）；`:238`-`:243`（只在评论事件调用）；`packages/contract/src/settings-v21.ts:105`-`:118`（默认值逐项对齐）；`apps/server/src/config/v21-settings.ts:132`-`:144`（读 `triggers.events['issue_comment.created'].gates`，不是 `comment` 段） |
| U08 FR-1.3 投递去重 | 已实现（未抽验） | **维持** | `apps/server/src/http/webhook.ts:95`-`:97`（`INSERT … ON CONFLICT (delivery_id) DO NOTHING`）、`:1100`-`:1121`（`rowCount=0` → 200 duplicate；含「上次验签失败、本次通过」的翻正分支，不当重复） |
| U09 FR-2.1 每事件一个开关 | 已实现（未抽验） | **维持** | `packages/contract/src/settings-v21.ts:326`-`:334`（五事件各自 `enabled` 默认值：opened/edited `on`、labeled `conditional`、closed `off`、comment `conditional`）；`apps/server/src/trigger/decide.ts:226`-`:229`（`off` 在闸门之前直接返回） |
| U10 FR-3.5 三层去重 | 与需求冲突（未抽验） | **维持结论，纠正引用**：A/B 指认的 `canonical-text.ts:30`-`:36` 实为 `escapeRegExp`/`stripAliases`，真正归一化在 `:21`-`:27`。CHECK-2 以「两边指认行一致」为由免抽验，此行号偏差因此漏检 | `apps/server/src/agent/canonical-text.ts:21`-`:27`（`maskCodeRegions` + 去 `@handle` + 去全部 `P*`/`S*` + 压平所有空白）；`apps/server/src/agent/store.ts:95`-`:98`（`ON CONFLICT DO NOTHING`）、`:235`（`inserted` 只看行数）、`:237`（回读的整行被返回但调用方不读 `status`）；`apps/server/src/http/webhook-v21.ts:1038`-`:1044`（命中即 duplicate，**不读**已有行 `status`，故需求 `docs/requirements.html:917`「上次失败不参与去重」未实现）；全仓 `contentDuplicate` 无生产者为 `true`（只有 `apps/server/src/trigger/decide.ts:246` 的消费与类型透传），故「因重复内容跳过、后台可查」无库内留痕 |

## 三、分歧裁决质疑（CHECK-1 的 9 处）

| 单元 | 条目 | 原裁决 | 我的态度 | 我的依据 |
|---|---|---|---|---|
| U01 | G-1 一 issue 一会话 | 部分实现（采信 B） | **维持** | `apps/server/src/app/compose.ts:450`-`:463`（`turns>=30` 或 `age>=7d` → 返回不带 `sessionId` 的 persistent + `archiveSessionId`）；`:1315`（`!v21SessionEventActive && archiveSessionId!==null` → `sessionArchive`）；`:1460`-`:1464`（`onTaskJob` 只传 `taskId`/`attempt`）；`:1196`（`sessionEvent` 缺省 → 守卫恒假）；`:1036`（`turns = rotate ? 1 : (turns??0)+1`，轮换可达） |
| U01 | G-4 按项目分区 | 部分实现（采信 B） | **维持** | `packages/contract/src/repo-config.ts:219`-`:220`（项目级 `model` 字段，注释称「技能可以覆盖」）；实际消费点全为平台级 `config.model`（`apps/server/src/app/config.ts:410`、`apps/server/src/app/model-env.ts:37`），**无一处读 `settings.model`**，属死字段 |
| U02 | NG-5 不处理 PR 事件 | 部分实现（采信 B） | **维持，但需换锚点**：裁决引「需求第 573 行同时禁止『评审』」表述不严谨——`:573` 的主语是 `pull_request.*` 事件与「PR 评审会话」；针对本条的准确锚点是「PR 上的评论命令仍能起一轮 PR 评审任务」 | `apps/server/src/http/webhook.ts:561`（`issue.pull_request` → `targetKind='pr'`）、`:579`-`:589`（`REVIEW_PR_COMMAND` → `source='command'` 建任务）；`apps/server/src/skills/builtin.ts` 中 `/review-pr` 技能与命令注册仍在交付面 |
| U03 | ROLE-2 维护者 | 已实现（采信 A） | **维持（条目口径内）**，但必须补记跨节冲突：裁决把「当前态取台账」当作无问题，同一事实在 FR-5.4 是硬冲突——需求明写「平台拥有删除权，包括删除人手动打的标签」，而代码只删台账内的，人手打的标签永不被删 | 维持依据：`apps/server/src/app/compose.ts:1658`-`:1676`（`readAppliedLabels` 只读 `bot_labels`）、`apps/server/src/writeback/v21/labels.ts:179`-`:197`（`remove ⊆ current`，`current` 即台账）。补记依据：`docs/requirements.html:1040`（删除权含人手打的标签）、`:1049`（执行侧输入必须是「当前全部标签」）；`apps/server/src/http/webhook-v21.ts:307`-`:310`（`{{issue.labels}}` 取 payload 真实标签，与 `label` 目标态的 `current` **不同源**，同一轮里提示词与写回看到两套「当前标签」） |
| U03 | ROLE-3 平台配置者 | 部分实现（采信 B） | **维持** | `apps/server/src/runtime/turn-driver.ts:359`-`:373`（`session/attach` 分支不带 `systemPrompt`）、`:375`-`:391`（只有 `sessionCreate` 带）；`apps/server/src/app/compose.ts:1407`（每轮都传，故对已存在的持久会话失效） |
| U04 | SA-5 平台不预设动作 | 部分实现（采信 A） | **维持**（详见第一节：此处方向正确，与 P4-4 的「不可达」互斥） | `apps/server/src/worker/run-task.ts:1243`、`:1265`；`apps/server/src/worker/fallback.ts:31`-`:35`、`:45`-`:53`、`:244`-`:253`（直接 `dispatchWriteAction({kind:'comment'})`，无槽位、无契约校验） |
| U04 | SA-6 端到端落到 GitHub | 已实现（采信 A） | **推翻 → 应判部分实现**。条目定义是「**端到端**：评论（带槽位）与标签（目标态）能真正落到 GitHub」。`current` 只取台账 ⇒ 台账为空（首跑 / 读失败退化 `[]`）时任何既有标签都进不了 `remove`，目标态落不成。这与「失败方向安全」是两回事：需求要的是目标态成立，不是「只增不删也算对」 | `docs/audit/verification-plan-v2.md:310`（条目原文「端到端…能真正落到 GitHub」）；`apps/server/src/app/worker-deps.ts:1073`-`:1087`（`currentLabels` 由调用方给、`botLabels` 同读台账）；`apps/server/src/app/compose.ts:1149`（`currentLabels = readAppliedLabels(...)`）、`:1675`-`:1677`（读失败 `return []`）；`apps/server/src/writeback/v21/labels.ts:183`-`:197`（`remove` 只在 `current` 内产生）；`apps/server/src/writeback/v21/execute.ts:548`-`:557`（先加后删，删除只对 `plan.remove`）。评论槽位侧无缺口，与 A/B 一致 |
| U05 | SB-5 复用已有会话给增量结论 | 部分实现（采信 B） | **维持** | `slotStore` 只在 `apps/server/src/writeback/v21/execute.ts:170`/`:228`/`:627`/`:692`/`:696` 与测试出现；`apps/server/src/app/compose.ts:836`-`:844` 的 `createV21Executor` 无该字段；`apps/server/src/github/octokit.ts:222`-`:227`（固定 `per_page: 100`，无分页），长评论 issue 上会新发而非覆盖 |
| U05 | SB-6 | 部分实现（采信 B） | **维持** | 同 G-1 同一处：`apps/server/src/app/compose.ts:1315`（轮换归档断上下文）；`apps/server/src/runtime/turn-driver.ts:370`-`:373`（attach 失败只 `sessionReset=true` + warn，本轮用空历史跑完） |

## 四、漏审检查

逐单元点名（对照 `docs/audit/v2/Uxx/{A,B}.md` 的 `^### ` 条目与我实读的裁决表）：

- **U01** G-1~G-4：A/B 各 4 条，CHECK-1 表 4 条 → 无漏。
- **U02** NG-1~NG-5：A/B 各 5 条，表 5 条 → 无漏。
- **U03** ROLE-1~ROLE-4：A/B 各 4 条，表 4 条 → 无漏。
- **U04** SA-1~SA-6：A/B 各 6 条，表 6 条 → 无漏。
- **U05** SB-1~SB-6：A/B 各 6 条，表 6 条 → 无漏。
- **U06** SC-1~SC-6：A/B 各 6 条，表 6 条 → 无漏。
- **U07** P4-1~P4-5：A/B 各 5 条，表 5 条 → 无漏。
- **U08** FR-1.1~FR-1.4：A/B 各 4 条，表 4 条 → 无漏。
- **U09** FR-2.1~FR-2.5：A/B 各 5 条，表 5 条 → 无漏。
- **U10** FR-3.1~FR-3.5：A/B 各 5 条，表 5 条 → 无漏。

**条目编号无遗漏。** 但有三处「覆盖口径」缺口 —— 不是漏条，是漏证据：

1. CHECK-2 的 P4-3 只查了需求正文 `requirements.html:717`，**漏查本单元条目定义** `docs/audit/verification-plan-v2.md:331`（明确写着「执行环境无 GitHub 凭证」），导致裁决理由建立在错误前提上，并把 A 的正确取证判成「自行加码」。
2. CHECK-2 自认 15 条「仅比对两边一致」即定案，但其中 FR-3.5 两边指认的行号实际不一致（都写 `canonical-text.ts:30`-`:36`，实为 `:21`-`:27`），「指认行互不矛盾」这一免抽验前提在此不成立。
3. 两份裁决都**未做跨裁决一致性检查**：同一处 `run-task.ts:1243` 兜底路径被 SA-5 判「可达」、被 P4-4 判「不可达」，且 CHECK-2 未引用 CHECK-1 对该处的结论。

## 五、结论

**维持 14 条 / 推翻 2 条 / 存疑 1 条**（共核验 17 项：第一节 3、第二节 5、第三节 9）。

- **维持 14 条**：P4-5、SC-1、SC-2、FR-1.3、FR-2.1、FR-3.5、G-1、G-4、NG-5、ROLE-2、ROLE-3、SA-5、SB-5、SB-6。其中 **NG-5 / ROLE-2 / FR-3.5 / P4-5 结论维持，但理由或引用行号需按上表改正**。
- **推翻 2 条**：
  - **U07 P4-4** → 应判**部分实现**。CHECK-2 的「旧链路生产不可达」不成立：`!v21Handled` 不拦 `not-v21`（`run-task.ts:1191`-`:1211` 的 else 分支不置位），而 `agent:event`/`agent:mention` 正是 v2.1 的生产命令（`agent/store.ts:89`-`:90`），兜底评论照发。
  - **U04 SA-6** → 应判**部分实现**。条目要求「端到端落到 GitHub」，而标签目标态的 `current` 只取 `bot_labels` 台账（`compose.ts:1149`、`worker-deps.ts:1084`），台账与 GitHub 漂移时 `add = desired − current` 会把已缺的标签判为「已有」而永不补加；读失败退化空集时则整轮不删。
- **存疑 1 条**：**U07 P4-3**。CHECK-2 推翻 A 的唯一理由（「需求正文里没有这个子条件」）被条目定义 `verification-plan-v2.md:331` 证伪；但「执行环境」是否包含 pi-host 子进程属需求侧解释，我不越权裁定，故记存疑而非推翻。

### 最需要重做的一条

**U07 P4-4。** 它不是口径分歧，而是一处**可判定的事实错误**：

1. 守卫 `run-task.ts:1243` 前的三态里，`valid` 与 `rejected` 置 `v21Handled = true`，`not-v21` **不置位**；而 `not-v21` 恰恰是「模型没交 v2 信封」的常态分支（`probeV21Output` 在没有任何 v2 形状文本时返回 `not-v21`）。
2. 此时 `prepareEnvelope(null)` 返回 `valid:false`（`envelope.ts:137`-`:152`），守卫 `(!prepared.valid || !hasCommentAction)` 成立，`postFallbackComment` 把模型最后一段人话发成一条**无槽位**评论（`fallback.ts:244`-`:253`）。
3. 三个后果叠加，使它必须重做：① 把 B 的正确发现判成「已被反证」；② 与同批 CHECK-1 的 SA-5 结论直接互斥，区间统计不可合并；③ 真正的缺项会从整改清单消失 —— 信封不合规时平台仍自决发文，与 `requirements.html:1057`「输出不合契约时标签与评论保持原状」相反。

重做时须同时裁定 `requirements.html:1054`（要求兜底反馈）与 `:1057`（要求保持原状）这对互斥条款的优先级，再定该条状态；否则同一段代码会被两条需求拉向相反结论。
