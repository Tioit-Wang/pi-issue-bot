# U12 5.5 执行 + 执行侧可用工具 · B

> 核查范围：docs/requirements.html 行 954-1186
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览

| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| FR-5.1 | 与需求冲突 | 平台既有技能注册表，也有按事件类型写死技能触发词的默认模板表 |
| FR-5.2 | 部分实现 | 平台代执行的 issue 工具调用只记工具名与摘要，不记入参与返回正文 |
| FR-5.3 | 与需求冲突 | 动作全集是 12 类（需求 7 类），多出的 5 类照常执行 |
| FR-5.4 | 与需求冲突 | 「当前标签」取自 `bot_labels` 台账，人手动打的标签不在差集里，永远不会被删 |
| FR-5.5 | 部分实现 | v2 分支失败时只有后台告警，显式不发兜底反馈评论 |
| FR-5.6 | 未实现 | 压缩引擎零调用方，`windowTokens` 无来源，两档收尾提醒不存在 |
| TOOL-1 | 已实现 | — |
| TOOL-2 | 已实现 | — |
| TOOL-3 | 已实现 | 需求 16 个逐个存在；契约另有 3 个需求未列出的工具 |
| TOOL-4 | 已实现 | — |
| TOOL-5 | 部分实现 | deny 成立，审计事件写入 kind=`approval.audit`，审计查询按 `approval` 匹配不到 |
| TOOL-6 | 部分实现 | 写口只有一条；但 v2 动作行 intent=`v21:*`，面板/审计/质量的 intent 白名单把它全过滤掉 |
| TOOL-7 | 已实现 | — |
| TOOL-8 | 已实现 | — |

## 逐条

### FR-5.1
- **状态**：与需求冲突
- **证据**：
  - `packages/contract/src/settings-v21.ts:473` — `DEFAULT_EVENT_TEMPLATES` 按事件类型硬编码五份默认模板，且每份**首行写死技能触发词**：`:475` `/proposal-analysis`（issues.opened）、`:491` 同（issues.edited）、`:506` `/label-triage`（issues.labeled）、`:519` `/issue-analysis`（issues.closed）、`:532` 同（issue_comment.created）。
  - `apps/server/src/http/webhook-v21.ts:359-362` — `v21TemplateOf()` 在项目未配模板时**就用这张表**，是新路径（v2.1）的活代码，不是遗留分支。
  - `apps/server/src/skills/registry.ts:157` — `createSkillRegistry()`：平台在加载期合并「内置技能 + 仓库技能」，做同名覆盖、冲突判决、`requires-repo-config` 禁用判定，动机是维护一张技能命令表（注册表）。
  - `apps/server/src/skills/builtin.ts:438-449` + `apps/server/src/skills/defaults.ts:55` — 平台自带 8 个内置技能文件（`:439-448` 逐条），并给每个项目播种 3 个默认技能（`DEFAULT_PROJECT_SKILL_NAMES`，`builtin.ts:469-473`；`seedProjectDefaults`）。
  - `apps/server/src/agent/message.ts:163-170` — `eventSkillsOf()` 按事件模板 id（`opened`/`edited`）取技能 id，即「事件类型 → 技能」的硬编码映射（v0.3 路径，`apps/server/src/http/webhook.ts:1537` 消费）。
- **缺口**：需求明写「平台不维护技能注册表，也不按事件类型硬编码行为」。代码两边都占：有技能注册表（`registry.ts` + 内置技能 + 默认播种），也按事件类型在契约里写死了每个事件首行的技能名（`settings-v21.ts:475/491/506/519/532`）。要满足需求，这两个默认值必须从平台代码里挪走（改成项目配置项），而不是保留成平台默认行为。
- **判定依据**：反证要点 7 的检查点是「平台是否真存在技能注册表 / 按事件类型绑定的默认技能表」。两处都有可执行的实证据，且 `v21TemplateOf` 证明默认表在活路径上；`eventSkillsOf` + `webhook.ts:1537` 证明「事件模板没配技能就不投递」这条策略依赖该映射。
- **反证过程**：
  1. 假设「平台不决定处理内容」为真 → 则平台代码里不应出现事件类型到处理的映射。grep `DEFAULT_EVENT_TEMPLATES` 得到 `settings-v21.ts:473`，其值逐行含技能触发词；`v21TemplateOf`（`webhook-v21.ts:359`）直接引用它 → 假设不成立。
  2. 排除「这是文档/死代码」：`v21TemplateOf` 被 `buildV21AgentMessage`（`webhook-v21.ts:464`）调用，后者在 v2.1 webhook 分支上（`apps/server/src/http/webhook.ts:1260-1287`）。
  3. 排除「只是渲染占位符」：模板内容不是占位符替换，而是**固定首行技能名**——换一份提示词确实能改行为（这条成立），但平台仍决定「默认先加载哪个技能」。
  4. 反向查技能注册表：`createSkillRegistry` 在生产路径被 `apps/server/src/app/worker-deps.ts:919` 调用，不是仅测试。

### FR-5.2
- **状态**：部分实现
- **证据**：
  - `apps/server/src/worker/run-task.ts:1073-1079` — 平台代执行的只读工具每次调用写一条 `issue.tool.read`：`{ name, ok, items, summary, errorCode }`。**没有入参，没有返回正文**（`summary` 是 `IssueCommentsList #331 → 20 条` 这类一行摘要）。
  - `apps/server/src/worker/run-task.ts:975-977` — 宿主工具调用（Read/Bash/…）靠 RACP 事件原样落 `run_events`（除 `item.delta` 外全落），payload 里有 `event.toolName` / `event.args` / `event.partialResult`。
  - `apps/server/src/queries/issues.ts:936-949` — 面板确实从这些原始事件里取出 toolName、args、output；但 `:995-1002` 只输出 `name` + `summary`（`SUMMARY_CHARS = 160`，`:58`）。
  - `apps/server/src/runtime/approval-policy.ts:141-148` — 审批审计的入参是 `digestInput()` 的**脱敏 + 240 字截断**摘要，不是完整入参。
- **缺口**：需求写「每次调用都要记录工具名、入参与返回」。宿主工具勉强够（原始事件里有），但**平台代执行的 5 个 issue 只读工具完全没有入参与返回**——这条恰是 v2.3 新链路（`run-task.ts:1069` 调 `readTools.executor({name, input})`，结果 `result.text` 被丢弃，只留 summary）。无法复盘「模型传了什么参数、拿到了什么数据」。
- **判定依据**：反证要点是「存在 ≠ 生效」。`issue.tool.read` 事件确实存在且落库，但字段集里没有 input、没有 text；面板展示路径也不还原它们。
- **反证过程**：
  1. 先查是否有别处补记：全仓搜 `appendEvent(` 的工具相关调用，只有 `issue.tool.read` 与 `tool.round`（`run-task.ts:1083-1087`，后者只记 `calls.map(c => c.name)`，连参数都没有）。
  2. 再查 `IssueReadResult` 是否含 text 且被消费：`apps/server/src/runtime/issue-read-tools.ts:44-57` 有 `text` 字段，`run-task.ts:1081` 只把 `readResults` 喂给 `renderToolResultsSection`（拼下一轮提示词），未入库。
  3. 宿主侧反向验证：`item.started` 事件是否真带 args —— `queries/issues.ts:75-81` 的 `sqlToolArgs()` 从 `e.payload -> 'event' -> 'args'` 取键，说明真实库里存在；但只取 `command/path/file_path/pattern/query/url` 之一，也不是完整入参。
  4. 结论：宿主工具部分成立、平台代执行工具不成立 → 部分实现。

### FR-5.3
- **状态**：与需求冲突
- **证据**：
  - `packages/envelope/src/v21.ts:40-53` — `OUTPUT_ACTION_TYPES` 有 **12 类**：verdict / label / comment / reaction / create_issue / open_pr / close_issue / reopen_issue / update_issue / update_comment / delete_comment / link。需求（行 980-986）写「动作全集」**7 类**。
  - `packages/envelope/src/v21.ts:63` — `GATED_ACTION_TYPES = ['create_issue','open_pr','close_issue']`，与需求「后三类默认关闭」一致。
  - `packages/envelope/src/v21.ts:523-547` + `:634-638` — 未知 `type` 在 `preflightDiscriminator()` 里前置判定，命中即 `return { ok: false, errors }`，整份拒绝，不进入 zod 逐条丢弃。
  - `packages/envelope/src/v21.ts:507-512, 642-646` — 错误路径转 JSON Pointer（`/actions/0/payload/slot`），可定位到字段。
  - `apps/server/src/writeback/v21/execute.ts:431-448` — 按数组顺序执行；失败 `stoppedAt = index; break`，已成功的保留在 `executed` 里不回滚。
  - `apps/server/src/worker/run-task.ts:1412-1419` — 校验错误写进 `envelopes.errors`。
  - `apps/server/src/writeback/v21/execute.ts:465-492` — `runAction()` 的 switch **实现了全部 12 类**，多出的 5 类不是"声明了不执行"。
  - 槽位五条：`apps/server/src/writeback/v21/comments.ts:53-55`（隐藏标记 HTML 注释）、`:98-114`（按标记查找）、`:161-177`（覆盖或新建）、`apps/server/src/writeback/v21/execute.ts:660-672`（原评论 404 → 重建并写 `原评论已不存在，重建`）。
- **缺口**：需求明写「动作全集里的七种之一，其他值一律拒绝」。代码的动作全集是 **12 类**，多出的 `reopen_issue / update_issue / update_comment / delete_comment / link` 在 `execute.ts` 的 switch 里有真实执行分支（如 `:1035-1046` 的 `link(duplicate)` 会关单）→ 这正是「集合外没被拒绝」。
- **判定依据**：其余子条件（五字段、三条校验规则、槽位五条）逐条可核且成立；唯一的偏差是集合成员数 7 vs 12，属于需求数字与代码常量不符，按口径计冲突。
- **反证过程**：
  1. 反证要点 3：怀疑未知 type 被 filter 掉继续执行。查 `v21.ts:634-638`，`preflight` 非空即 `ok:false`；`execute.ts:419-429` 在 `disabled.length > 0` 时 `executed: []` 直接返回。**不是 filter**，这条成立。
  2. 再查是否有多动作时逐条丢弃的旧路径混用：`packages/envelope/src/actions.ts:102` 的 `filterActions` 只服务旧 4-intent 信封；`v21.ts:10-12` 明确 v2 不用它。确认无混用。
  3. 攻集合大小：把需求 7 类与 `OUTPUT_ACTION_TYPES` 做差集 → 多出 5 类；再确认这 5 类有执行分支（`execute.ts:481-490` 的 case）→ 不是死枚举，冲突成立。
  4. 攻「遇失败即停」是否真停：`execute.ts:441-447` 的 `break` 在 catch 内，`stoppedAt = index` 后不再循环 ✓。
  5. 攻「槽位只保留一条」：`comments.ts:98-114` 取列表中第一条命中标记的评论，其余不删 —— 若历史上已存在两条同槽位（例如人手复制），不会收敛成一条。记为残余缺陷，不改变本条主判定。

### FR-5.4
- **状态**：与需求冲突
- **证据**：
  - `apps/server/src/writeback/v21/labels.ts:187-197` — 删除集 = `current ∩ 可管理目录 − desired`。逻辑上不区分标签是谁打的，`deletionOwner()`（`:130-132`）也准备区分 bot/human。
  - `apps/server/src/app/compose.ts:1658-1677` — `readAppliedLabels()` 从 **`bot_labels`** 表读「当前生效的标签」（`select distinct "label" from "bot_labels" where applied_at is not null and removed_at is null`），不是读 issue 的实际标签。
  - `apps/server/src/app/compose.ts:859-863` — webhook 侧执行钩子：`currentLabels = readAppliedLabels(...)`，然后 `botLabels: currentLabels` —— **两个入参是同一个数组**。
  - `apps/server/src/app/compose.ts:1149` + `:1427` + `apps/server/src/app/worker-deps.ts:1080-1084` — worker 侧 `targets.load()` 返回的 `currentLabels` 是调用方传进来的同一份台账值，`botLabels` 由 `listBotLabels()` 从同一张表读。
  - 空集保护 `labels.ts:140-147` ✓；超限整批拒绝 `:150-156` ✓；作用域=目录 `:83-107` ✓；人工否决 `:100-101`（`managed=false`）+ v2 路径不读 `humanVetoed` ✓。
- **缺口**：「当前实际标签」的来源是自家台账而非 issue 现状。后果有三：
  1. **人手动打的标签永远不在 `current` 里**，因此永远不会进入 `remove` 集合 —— 需求「包括删除人手动打的标签」在运行期永不成立；
  2. `deletionOwner(label, botLabels)` 因 `remove ⊆ current = botLabels` 而**恒返回 `'bot'`**（`labels.ts:131`），「记录原主人是人还是机器」这条留痕实际是常量；
  3. 台账里有一条、GitHub 上已被人删掉时，代码仍按「现有」计算，会重复 `removeLabel`。
- **判定依据**：差集算法的纯函数（`labels.ts`）本身按需求写对了，但传入的 `current` 被 `compose.ts:863` 替换成台账，行为与需求相反 —— 这是「实现存在但输入被换掉」的典型，按「代码行为与需求相反」计冲突。
- **反证过程**：
  1. 反证要点 4：先假设「current 取自 issue 实际标签」。查 `readAppliedLabels` 的 SQL（`compose.ts:1665-1667`）→ 表名是 `bot_labels`，排除假设。
  2. 再查是否存在第二个 provider 会返回真实标签：`worker-deps.ts:1073-1086` 的 `createV21TargetContextPort.load()` 直接把 `options.currentLabels` 原样返回，`options` 由 `compose.ts:1427` 传入，仍是同一份 `readAppliedLabels` 结果；`webhook-v21.ts:702-703` 的 `ctx.currentLabels` 同样来自 `compose.ts:859`。
  3. 再查 `IssueGet` 读工具是否被用来取真实标签：`apps/server/src/runtime/issue-read-tools.ts:155-158` 会渲染 labels，但那是**提示词文本**，不回流到 `executeV21` 的 `currentLabels`。
  4. 攻击「owner 恒 bot」：`execute.ts:532-535` 对每个 `plan.remove` 调 `deletionOwner(label, input.botLabels)`；因 `plan.remove ⊆ current`（`labels.ts:192`）且 `current === botLabels`（`compose.ts:863`），`botLabels.includes(label)` 恒真 → 恒 `'bot'`。确认。
  5. 攻击「人工否决」：`apps/server/src/worker/writeback.ts:191-199` 经 `input.policy.humanVetoed(...)` 取否决集（`worker-deps.ts:581` 注入 `loadHumanVetoed`，实现在 `workflows/bot-labels.ts:73`），但那条是旧 4-intent 路径；`writeback/v21/labels.ts` 全文无 veto 读取 → 在 v2 路径上「人工删除不构成永久否决」成立（但成立原因是没实现否决，不是按 BR-11 显式契约实现）。BR-11 的「不自动管理」由 `catalog.managed=false` 承载（`labels.ts:100-101`）✓。

### FR-5.5
- **状态**：部分实现
- **证据**：
  - `apps/server/src/writeback/v21/execute.ts:441-447` — 动作失败 → `executed.push({outcome:'failed'})`、`errors.push`、`stoppedAt = index`、`break`；不抛。
  - `apps/server/src/worker/run-task.ts:1457-1477` — 落 `writeback.v21.result` 事件；`!result.ok` 时 `signals.push(signalFromParse(...))` → 进 `failure_class`（`:1583-1585`），即后台告警成立。
  - `apps/server/src/worker/run-task.ts:1241-1243` — **v2 分支显式不发兜底评论**：`if (!v21Handled && prepared !== null && (...))`，注释「v2 分支不发兜底评论」。
  - `apps/server/src/worker/run-task.ts:1173-1190` — `probe.kind === 'rejected'` 时只写 `envelopes`（`valid:false` + `errors`）+ `envelope.v21.rejected` + `signalFromParse`，不执行任何动作（标签/评论保持原状）✓；`valid` 分支（`:1169-1172`）只记动作条数。
  - `apps/server/test/no-merge.test.ts:28-33` — 扫 `.merge(` / `pulls.merge` / `mergePullRequest` / `merge_pull_request`；`apps/server/src/github/` 无 merge 调用 ✓。
  - dry_run 默认 true：`apps/server/src/app/config.ts:115`、`apps/server/src/db/schema.ts:152`、`apps/server/src/config/repo-config.ts:281`；dry-run 下每个动作分支提前返回（`execute.ts:538, 645, 739, 789, 814, 865, 883, 943, 964, 981, 1011`），且 `run-task.ts:1427` 不写 actions 行 ✓。
- **缺口**：需求「失败不得静默：至少**有兜底反馈（如普通评论）与后台告警**」。后台告警成立；**兜底反馈在 v2 路径上不存在**——`run-task.ts:1241-1243` 的条件把 `v21Handled` 排除在兜底之外，失败时 issue 上不会出现任何说明。
- **判定依据**：两个子条件（兜底反馈 / 后台告警）一成立一不成立；「不合并 PR」「无产出保持原状」「dry-run 零写」都可核成立。
- **反证过程**：
  1. 反证要点 6：怀疑 dry_run 默认不是 true。查三处默认值（`app/config.ts:115`、`db/schema.ts:152`、`repo-config.ts:281` 的 `row['dry_run'] !== false`）全部为 true；再查 dry-run 是否有一条真写漏网：逐分支看 `execute.ts` 的 `if (input.dryRun) return` —— `runLabel` 在 dryRun 下仍会执行 `planLabelTargetState` 纯计算（无副作用）✓；`assertRefsResolvable` 在 dryRun 下跳过 GET（`:340-342`）✓；`putSlot` 只在真实写入分支后调用 ✓。零真写成立。
  2. 攻「无产出保持原状」：`probe.kind === 'not-v21'`（超时/崩溃/纯人话）时会走旧路径 `prepareEnvelope` + 兜底评论（`run-task.ts:1243-1291`），对 agent 任务（`source='agent'`）命令名在 `COMMENT_FALLBACK_COMMANDS`（`apps/server/src/worker/fallback.ts:47-52`）内 → **会发一条评论**。这与「输出不合契约 → 标签与评论保持原状」冲突，但同一条需求又要求「失败不得静默」——两条需求张力，此处按兜底反馈缺失记缺口，不额外判冲突。
  3. 攻「不合并 PR」：`apps/server/src/writeback/v21/execute.ts:817-823` 的 `open_pr` 走 `POST /repos/{owner}/{repo}/pulls`（`webhook-v21.ts:612-619`），无 merge 调用；`no-merge.test.ts` 是静态扫描，非运行期证据，记入核查边界。

### FR-5.6
- **状态**：未实现
- **证据**：
  - 算法齐备（存在但未生效）：`apps/server/src/compact/engine.ts:436` `compactSession()` 六阶降级；`apps/server/src/compact/thresholds.ts:77-114` 阈值现算（`autoRatio=0.9`、`hardLimit`）、非配置项；`apps/server/src/compact/truncate.ts:26-31` 2000/500 分层、`:130-147` 孤儿 toolResult 剔除；`apps/server/src/compact/summary.ts:199-206` 空摘要视为失败；`apps/server/src/compact/engine.ts:37` 退避 2/4/8。
  - **零调用方**：`apps/server/src/app/worker-deps.ts:1032` 把 `createCompactor` 再导出；`apps/server/src/app/compose.ts:881` 把它挂成 `v21RunnerHooks.compactor`；`apps/server/src/worker/run-task.ts:196-202` 声明的 `readonly compactor?: unknown` 在整个 `run-task.ts` 里**没有任何一次调用**（全仓搜 `compactSession(` 只出现在 `compact/engine.ts` 内部与测试；`createCompactor(` 只出现在 `engine.ts:698` 定义、`worker-deps.ts:1063` 与测试）。
  - `apps/server/src/worker/run-task.ts:196-202` 的注释自认：「本轮只暴露、不自动调用」。
  - `windowTokens` 无来源：`CompactInput.windowTokens`（`apps/server/src/compact/engine.ts:98`）要求调用方给出模型窗口，但没有任何配置或装配把模型窗口传进来 —— 除 `compact/*` 与测试外，`windowTokens` 只出现在 `apps/server/src/degeneracy/incremental-novelty.ts`（那是 n-gram 窗口，语义无关）；`packages/contract`、`apps/server/src/config` 均无模型窗口字段 → 即使接上调用也没有输入。
  - 「临近边界两档提醒模型收尾」：全仓无实现 —— 搜 `compactWarning|warnRatio|nearLimit|两档` 零命中；`收尾` 只出现在任务终态语义与只读工具预算提示（`apps/server/src/runtime/issue-tool-loop.ts:65` 的 `TOOL_RESULTS_CLAMP_NOTICE`、`:178` 的预算用尽提示），与上下文压缩无关。
  - 可观测断链：`agent_compactions` 只有写入路径（`run-task.ts:946-962` 识别 host 报的 compaction 事件），`apps/server/src/queries/` 与 `apps/panel/src/` 全无引用 → 「后台会话详情能标出压缩点」不存在。
  - 运行期实际发生的是「观测」：`run-task.ts:933-963` 只把 host 报的 `itemType==='compaction'` 如实落一行，不自已压缩。
- **缺口**：需求要求「超过模型窗口时必须自动压缩」。运行期不存在压缩调用点，`windowTokens` 无数据来源，两档提醒与后台压缩点标注均未实现。算法完整、单测齐全，但按「有函数无调用方 = 死代码」的口径计未实现。
- **判定依据**：反证要点 1 的检查点是「找压缩入口的调用方」。零调用方；阈值虽不是配置项（符合），但阈值计算从不被触发。
- **反证过程**：
  1. 假设存在调用链：从 `run-task.ts` 搜 `compactor` → 只有 `:197` 注释与 `:202` 声明，无 `deps.v21.compactor(`；从 `compose.ts` 搜 → 只有 `:881` 挂载；从 `worker-deps.ts` 搜 → 只有 `:1032` 再导出、`:1059-1067` 的 `createBoundV21Compactor`（仅被测试 `v21-worker-integration.test.ts:840-842` 断言 `typeof === 'function'`）。三层都断。
  2. 排除「host 侧自己做压缩」：`packages/racp-client/src/ops.ts:44-63` 的 operation 白名单无 compact/history；`docs` 原话见 `worker-deps.ts:1028-1030`「RACP 客户端没有 session/history 与 compact 操作」。
  3. 排除「阈值是配置项」：`thresholds.ts:39-50` 的 `COMPACTION_DEFAULTS` 是代码常量而非 `repo-config`/env 字段，且 `planCompaction` 从 `windowTokens` 现算 → 这一子条件其实成立，因此缺口不能算在阈值上。
  4. 攻击可观测：假定 `agent_compactions` 有读取方 → 全仓 grep `agent_compactions|listCompactions|compaction`（排除 node_modules）只命中 `compact/store.ts` 自身、`worker-deps.ts`、`run-task.ts`、`webhook-v21.ts`，`queries/`、`panel/src/` 零命中。

### TOOL-1
- **状态**：已实现
- **证据**：
  - `packages/contract/src/issue-tools.ts:73` — `HOST_FILE_TOOLS = ['Read','Write','Edit','Glob','Grep']`；`:74` — `HOST_SHELL_TOOL = 'Bash'`；`:127-278` — `ISSUE_TOOLS`（19 个 issue 工具）。
  - `apps/server/src/runtime/approval-policy.ts:49-53` — 审批矩阵按同一分段：`READ_ONLY_TOOLS` / `SANDBOXED_TOOLS` / `WRITE_TOOLS`，加 `:264-273` 的 `isIssueTool` 分支。
  - `apps/server/src/skills/prompt.ts:310` `HOST_TOOL_LINES`（宿主文件/命令工具的调用形状）、`:490-511` `renderToolCatalog()` 先渲染宿主段再渲染 issue 段。
- **判定依据**：三段（宿主文件 / 宿主命令 / issue 工具集）在契约、审批矩阵、提示词三处都是显式分离的同一份数据。
- **反证过程**：
  1. 假设只有两段（宿主工具 + 其它）：查 `ISSUE_TOOLS` 的分组 `ISSUE_TOOL_GROUPS = ['read','write','search','meta']`（`issue-tools.ts:79`），与宿主工具是并列的同级数组而非子集 → 三段成立。
  2. 攻「宿主段在运行期真的给了」：`approval-policy.ts:236-238` 对 Read/Glob/Grep 直接 allow、`:275-287` 对 Write/Edit 校验路径，`:240-256` 对 Bash 扫命令 → 三段都在审批矩阵上有独立规则，不是文档摆设。

### TOOL-2
- **状态**：已实现
- **证据**：
  - 唯一事实源：`packages/contract/src/issue-tools.ts:127-278`（`ISSUE_TOOLS`）+ `:284` `ISSUE_TOOL_NAMES`。
  - 派生 1 审批矩阵：`apps/server/src/runtime/approval-policy.ts:37-42` 从 `packages/contract/src/index.ts` 导入 `isIssueTool` / `ISSUE_WRITE_TOOL_NAMES` / `isRemovedTool` / `findShellIssueViolation`，`:264` 用 `isIssueTool(tool)`。
  - 派生 2 技能 `allowed-tools` 枚举：`packages/contract/src/enums.ts:232-240` `SKILL_ALLOWED_TOOLS = ['Read','Write','Edit','Glob','Grep','Bash', ...ISSUE_TOOL_NAMES]`；`packages/contract/src/skills.ts:112` 用它做 `z.enum()`。
  - 派生 3 提示词工具目录：`apps/server/src/skills/prompt.ts:19-26` 导入 `ISSUE_TOOLS`，`:500-502` `ISSUE_TOOLS.filter(...)` 渲染。
  - 派生 4（需求表格）：`docs/requirements.html:1146-1170` 是手写静态 HTML，没有生成脚本（`scripts/` 下仅 `spike`、`sandbox-bash`）。
- **判定依据**：三处代码派生都是 import 级别的单一来源，改契约必然同步；需求表格是文档产物，不参与机器校验（记入核查边界，不影响本条）。
- **反证过程**：
  1. 假设存在第二份清单：搜 `IssueGet` 字面量 —— 除契约 `issue-tools.ts` 外，`packages/envelope/src/v21.ts:141-147` 的 `ISSUE_READ_TOOL_NAMES` 是一份**手写副本**（5 个读工具）。它不是需求点名的四派生之一（需求只列审批矩阵 / allowed-tools / 提示词目录 / 本表），且 `packages/envelope/test/v21.test.ts:330-336` 用测试钉住等值（注释说明两包刻意互不 import）。因此不计为本条缺口，但确属第二处事实源，列入额外问题。
  2. 攻「提示词目录是否真的从契约取」：`prompt.ts:500` 是 `ISSUE_TOOLS.filter`，不是字符串数组 → 成立。
  3. 攻「allowed-tools 是否另有硬编码」：`skills.ts:112` 的 `z.enum(SKILL_ALLOWED_TOOLS)`，而 `SKILL_ALLOWED_TOOLS` 展开 `ISSUE_TOOL_NAMES` → 成立。

### TOOL-3
- **状态**：已实现
- **证据**：
  - 需求 16 个（`docs/requirements.html:1146-1170`）：IssueGet / IssueList / IssueCommentsList / IssueTimeline / IssueSearch / IssueCreate / IssueUpdate / IssueClose / IssueReopen / IssueCommentCreate / IssueCommentUpdate / IssueCommentDelete / IssueLabelAdd / IssueLabelRemove / IssueLabelSet / IssueLink。
  - 契约 `packages/contract/src/issue-tools.ts:127-278` 逐个存在（`name:` 行 19 条），上面 16 个全在其中；差集为空。
  - 契约多出 3 个：`IssueCommentReply`（`:211`）、`IssueReactionAdd`（`:233`）、`IssueReactionRemove`（`:242`）。
- **判定依据**：本条问的是「逐个存在」，16 个全部存在且各有 `description` + `required` 声明；多出的 3 个是扩展，不构成缺失。
- **反证过程**：
  1. 假设有遗漏：把需求 16 个名字逐个在 `issue-tools.ts` 里 grep，无 0 命中项 → 无遗漏。
  2. 攻「存在 ≠ 能用」：这 16 个在 `EXECUTE_CHANNEL_AVAILABLE = false`（`issue-tools.ts:383`）下都不可被 host 直接调用，但需求本身也承认这一点（`docs/requirements.html:1185-1186` 的「当前的落地状态」说明以「平台代执行」生效），故「是否存在」按契约计，执行方式见 TOOL-8。
  3. 攻数量口径：需求写 16、契约 19 —— 已列差集，按「逐个存在」判已实现；数量偏差写入额外问题。

### TOOL-4
- **状态**：已实现
- **证据**：
  - `packages/contract/src/issue-tools.ts:33` — `REMOVED_TOOL_PREFIXES = ['mcp__', 'plugin_']`；`:62` — `isRemovedTool()` 用 `normalized.startsWith(prefix)` 做**前缀**匹配（`normalized` 已 `trim().toLowerCase()`，`:57`）。
  - `:46` — `REMOVED_TOOLS = ['new_context', 'Task', 'TodoWrite']`；`:59-61` 大小写不敏感精确匹配。
  - `apps/server/src/runtime/approval-policy.ts:228-234` — 移除名单**排在所有判定之前**，命中即 deny 且 rule=`removed-tool`（`:74`）。
  - 不在 `allowed-tools` 枚举：`packages/contract/src/enums.ts:232-240` 的 `SKILL_ALLOWED_TOOLS` 只展开 `ISSUE_TOOL_NAMES` 与 6 个宿主工具，不含这三者；`packages/contract/src/skills.ts:112` 用 `z.enum(SKILL_ALLOWED_TOOLS)`，写进 frontmatter 会整份非法（schema 自 `:93` 起、`.strict()` 在 `:128`）。
- **判定依据**：前缀匹配是真前缀（`startsWith`），不是逐个列举；三者既进不了 allowed-tools 枚举，也在审批层被前置 deny，双重收口。
- **反证过程**：
  1. 反证要点 2：怀疑「逐个列举」而非前缀。读 `issue-tools.ts:56-63` 的实现 → `REMOVED_TOOL_PREFIXES.some(p => normalized.startsWith(p))`，是真前缀。
  2. 攻前缀是否漏：构造 `mcp__github__create_issue`、`plugin_pi_todo_todo_manage` → 命中；构造 `MCP__X` → 因 `toLowerCase()` 命中；构造 `mcp-x`（单下划线）→ 不命中，但 MCP 的命名约定是双下划线，可按需求「前缀匹配」接受。
  3. 攻「工具名层面禁止 ≠ 加载期拒绝」：`skills.ts:128` 的 `.strict()` + `:112` 的 `z.enum()` → 写进 frontmatter 的 `allowed-tools` 会整份 schema 失败，符合「写进去会在加载期整份被拒」。
  4. 攻 `new_context` 是否真的不可达：`approval-policy.ts:228` 前置 deny，且 `SKILL_ALLOWED_TOOLS` 无它 → 两条路都堵。

### TOOL-5
- **状态**：部分实现
- **证据**：
  - 模式表 `packages/contract/src/issue-tools.ts:338-351`：`gh issue` / `gh pr` / `gh api` / `gh search` / `curl|wget|xh|http … api.github.com` / `api.github.com/(graphql|repos)`；`findShellIssueViolation()`（`:359-366`）返回命中片段。
  - 审批侧 deny：`apps/server/src/runtime/approval-policy.ts:246-254`，rule=`shell-issue-operation`（`:72`），理由里带命中片段。
  - 审计写入：`apps/server/src/runtime/turn-driver.ts:584-589` `params.onAudit?.(decision.audit)`；`apps/server/src/worker/run-task.ts:979-982` `appendEvent('approval.audit', audit)`。
  - 审计查询：`apps/server/src/queries/audit.ts:78` — `where e.run_id = a.run_id and e.kind = 'approval'`。
- **缺口**：写入的 kind 是 **`approval.audit`**（`run-task.ts:981`），查询按 **`approval`** 精确匹配（`audit.ts:78`），两者不相等 → `/api/audit` 的 `approval` 列**恒为 null**。`apps/server/src/queries/sql.ts:330` 有 `like 'approval.%' → 'approval'` 的归一化，但那只用于 run event 分类展示，审计 join 用的是原始 `e.kind`。即「留审计」写入成立、「后台可查」不成立。
- **判定依据**：deny + 审计事件落库两条都在；但需求语境里的「留审计」要被复盘用，读不出来就等于只有半条。
- **反证过程**：
  1. 先确认 deny 真的会触发：`turn-driver.ts:578-598` 在 `approval.requested` 上调用 `decideApproval` → `racpDecisionFor` → `approvalRespond('deny')`，是活路径。
  2. 再确认审计落库：`run-task.ts:979-982` 的 `appendEvent` 走 `run-store.ts:40-45` 的 `insert into run_events` → 落库成立。
  3. 攻「后台读得到吗」：读 `audit.ts:75-81` 的 lateral join，条件写死 `e.kind = 'approval'`；再 grep 全仓 `appendEvent('approval` → 只命中 `run-task.ts:981` 的 `'approval.audit'`。无任何地方写 `kind = 'approval'` → 该 join 永不命中。
  4. 排除「有别的读路径」：`queries/tasks.ts:325-333` 的 `toRunEvent` 会把 `run_events` 原样返回，事件详情里能看到 `approval.audit`；但审计导出/审计页走的是 `audit.ts` → 「面板审计页查不到审批判定」这条成立。

### TOOL-6
- **状态**：部分实现
- **证据**：
  - 架构上只有一条写路：`packages/contract/src/issue-tools.ts:82-89` 声明写类工具「产出的仍是标准动作信封」；执行只有 `apps/server/src/writeback/v21/execute.ts:414` 的 `executeV21()`（另加旧 4-intent 路径 `apps/server/src/worker/writeback.ts`），无「工具自己发 HTTP」的实现。
  - agent 侧无凭证：`apps/server/src/sandbox/hostconfig.ts:164-170` 容器 `Env` 只有 `NODE_OPTIONS/HOME/CI/TERM`，注释「不含任何凭证」；`apps/server/src/sandbox/exec-plan.ts:88` 的 `docker exec -e` 只带 `PI_CMD_ID`；`apps/server/src/sandbox/exec-proxy.ts:21` 明确「不透传 env」。
  - 每步进审计：`apps/server/src/worker/run-task.ts:1424-1456` 为每条 executed 写一行 `actions`，audit 里带 `{source:'v21', contract:'v2', index, type, outcome, detail, dryRun}`。
  - 但 `run-task.ts:1431` / `:1450` 把 `intent` 写成 **`v21:${item.type}`**；`apps/server/src/queries/sql.ts:368` 的 `ACTION_INTENTS_SQL` 是 `('comment','label','create_issue','push_branch','close_issue','reaction.add','reaction.remove')`，**不含 `v21:*`**。
  - 消费该白名单的三处：`apps/server/src/queries/tasks.ts:511`（任务详情 actions）、`apps/server/src/queries/audit.ts:58`（审计导出）、`apps/server/src/queries/quality.ts:54`（质量统计）。
- **缺口**：写口唯一这条成立；但「每步进审计」在面板/审计/质量三处**全部不可见**——v2 写回的动作行因 intent 前缀不在白名单而被过滤。`actions` 表里有行、`run_events` 里有 `writeback.v21.result`，但结构化查询读不到。
- **判定依据**：需求这一条含两句：写口唯一（成立）+ 过写回闸门与项目动作开关、每步进审计（审计可读性不成立）。
- **反证过程**：
  1. 攻「是否真有第二条写路」：搜 `createPullRequest|createComment|addLabels` 的平台侧调用 —— 只在 `execute.ts` 的端口实现与 `github/` 网关注入；`sandbox/` 无 HTTP 客户端、无 token → 无第二条。
  2. 攻「写回闸门是否真的过」：`git/writeback-gate.ts:207` 的 `evaluateWriteback()` 只被 `apps/server/src/git/writeback.ts:81` 调用，而 `runWriteback` 在全仓**只有测试调用**（`apps/server/test/git-writeback.test.ts`），生产装配里没有 `push_branch` 执行者（`worker/writeback.ts:454-461` 只产出 `{kind:'push_branch'}` 计划）。v2 的 `open_pr` 走 `POST /repos/{owner}/{repo}/pulls`（`webhook-v21.ts:612-619`），不经过 `evaluateWriteback`。→ 「过写回闸门」在 v2 的 open_pr 上不成立（v2 无 push_branch 动作，故也无路径可过）。
  3. 攻「审计可见」：拿 `ACTION_INTENTS_SQL`（`sql.ts:368`）与写入值 `v21:label` 比对 → 不在集合内；再确认 `tasks.ts:511` 确实用该常量而非别的条件 → 确认被过滤。
  4. 排除「面板另走 run_events」：`queries/tasks.ts` 确实同时返回 `events`，`approval.audit`/`writeback.v21.result` 可见；但需求说的「每步进审计」在结构化 `actions` 视图下不可见，且审计导出（`audit.ts`）与质量统计（`quality.ts`）完全看不到 v2 动作 → 缺口成立。

### TOOL-7
- **状态**：已实现
- **证据**：
  - 只读工具在**宿主进程**执行、用平台 App 凭证：`apps/server/src/app/compose.ts:810-811` `v21IssueRead = createGithubIssueReadApi(baseGithubClient)`；`:1416-1418` 注入 `readTools.executor = createIssueReadExecutor(v21IssueRead, {}, { repo: row.repo })`。
  - 执行器本身不碰凭证，只认一个窄接口：`apps/server/src/runtime/issue-read-tools.ts:87-95`，且 `repo` 由平台绑定（`:83-85` 注释 + `compose.ts:1417` 传 `repo`）。
  - 沙箱无 token：`apps/server/src/sandbox/hostconfig.ts:164-170`、`apps/server/src/sandbox/exec-plan.ts:88`、`apps/server/src/sandbox/exec-proxy.ts:21`（同 TOOL-6 证据）。
  - 每次调用记入工具记录：`apps/server/src/worker/run-task.ts:1073-1079` `appendEvent('issue.tool.read', ...)`。
- **判定依据**：「走平台代理」「只读」两条都可核；「token 不进沙箱」由容器 Env 白名单与 exec 不过传 env 两处共同保证。
- **反证过程**：
  1. 攻「token 是否可能进沙箱」：`hostconfig.ts:165-170` 的 Env 是**字面量数组**（非从 process.env 透传）；`exec-plan.ts:88` 的 `env` 只有 `PI_CMD_ID`；`exec-proxy.ts:21` 注释「不透传 env」。三处独立证据。
  2. 攻「读工具是否真在宿主跑」：`createIssueReadExecutor` 在 `compose.ts:1417` 构造，`run-task.ts:1069` 在 worker 进程内 await → 不在容器内。
  3. 攻「是否只读」：`ISSUE_READ_TOOL_NAMES`（`issue-read-tools.ts:36-38`）只筛 `group === 'read' || 'search'`，执行器 `:122-136` 的 switch 只有 5 个只读分支 → 只读成立。
  4. 攻「每次调用记入工具记录」：`run-task.ts:1073` 在 for 循环内、每条结果写一次 → 成立（但记录内容不完整，见 FR-5.2）。

### TOOL-8
- **状态**：已实现
- **证据**：
  - `packages/contract/src/issue-tools.ts:383` — `export const EXECUTE_CHANNEL_AVAILABLE = false;`；`:391-393` — `issueToolAvailability()` 返回 `'platform-executed'`。
  - 消费方：`apps/server/src/skills/prompt.ts:482-484` 按 `issueToolAvailability() === 'callable'` 二选一措辞，false 时说「这些能力由平台代你执行」。
  - 测试钉住：`packages/contract/test/issue-tools.test.ts:233-234`（`expect(EXECUTE_CHANNEL_AVAILABLE).toBe(false)`、`issueToolAvailability()` 为 `'platform-executed'`）、`apps/server/test/skills-prompt.test.ts:310-322`（断言提示词不说「你可以调用」）。
  - 通道本身确实不通：`packages/racp-client/src/ops.ts:5` 注释明列 `tools/advertise` 不在白名单；`packages/racp-client/src/schema.ts:304` 的 `toolRelay?: boolean` 是可选字段，无生产方把它置 true。
- **判定依据**：常量存在、被提示词消费、被两侧测试钉住，且底层通道（RACP operation 白名单）确实没有 advertise/relay。
- **反证过程**：
  1. 攻「常量是否是死字段」：`prompt.ts:482` 读它决定措辞 → 有消费方。
  2. 攻「是否偷偷宣称可调用」：`prompt.ts:484` 的 false 分支文案是「由平台代你执行」，`skills-prompt.test.ts:310-322` 断言不含「你可以调用」→ 成立。
  3. 攻「通道是否其实已通」：`racp-client/src/ops.ts:5` 的排除清单含 `tools/advertise`；`schema.ts:304` 的 `toolRelay` 无赋值点 → 仍不通，常量值正确。

## 本节整体结论

本节不能判为「已实现」。13 条里 6 条存在实质缺口，其中 3 条与需求相反：

- **执行侧的输入被换掉了**：FR-5.4 的「当前标签」来自 `bot_labels` 台账而非 issue 现状（`compose.ts:863`），使「删除人手动打的标签」与「删除留痕区分人/机器」两条需求在运行期恒不成立。
- **压缩只有算法，没有运行期**：FR-5.6 的引擎零调用方、`windowTokens` 无来源、两档提醒与后台压缩点标注都不存在。
- **契约集合比需求大**：FR-5.3 的动作全集 12 类 vs 需求 7 类，多出的 5 类有真实执行分支。

另有 3 条「写入成立、读回断链」的同类问题：TOOL-5 的审批审计（kind `approval.audit` vs 查询 `approval`）、TOOL-6 的 v2 动作行（intent `v21:*` 不在 `ACTION_INTENTS_SQL`）、FR-5.2 的只读工具调用记录（无入参/返回）。这类问题的形态一致：数据落库了，但结构化查询/面板拿不到，属「存在 ≠ 生效」。

工具面本身（TOOL-1/2/3/4/7/8）质量较高，契约单一事实源、前缀禁止、平台代理读、通道状态标记都成立且被测试钉住。

## 核查边界

- **是否执行了命令**：只执行了只读检索命令（`git status --short`、`git rev-parse HEAD`、`Select-String` 全文/按路径检索、`Get-Content` 行窗口、`Select-Object` 计数）。**未执行** `pnpm -r typecheck` / `pnpm lint` / `pnpm -r test` / `pnpm --filter @pi-issue-bot/panel test` / `pnpm gen:openapi`。因此本报告的所有结论均为**静态核查**，不含「测试跑过且绿」的声明；文中提到的测试只按「断言内容是否覆盖」评估，不代表已运行。
- **基线一致性**：`git rev-parse HEAD` = `fbfa02983d36d4923c0647f4c18aacd041d83375`，与 `_baseline.txt` 记录的 HEAD 一致；`git status --short` 为 30 行（baseline 记录 30 项，含 `?? docs/audit/`），未发现 STALE。本单元是新建目录 `docs/audit/v2/U12/`，只写本文件。
- **未覆盖的条目及原因**：
  - FR-5.6 的「压缩请求是否被 provider 拒绝」这类运行期行为，需要真模型与真 RACP 通道才能确认；本报告只判「调用点不存在」这一静态事实。
  - FR-5.4 的 `maxPerIssue` 超限阈值取自 `settings.labels.max_per_issue`（`apps/server/src/worker/run-task.ts:1387`），默认 6（`packages/contract/src/repo-config.ts:108`）；需求说「项目约定的上限」，未给数字，故未做数字比对。
  - FR-5.5 的「不合并 PR」只按 `no-merge.test.ts` 的静态扫描 + `writeback/v21/execute.ts` 与 `github/` 的调用面判定，未跑该测试文件。
  - TOOL-2 的「需求表格从契约派生」无法核 —— 需求文档是手写 HTML，仓库内无生成脚本。
- **发现的额外问题（不属本节范围但值得记录）**：
  1. `apps/server/src/queries/audit.ts:78` 的 `e.kind = 'approval'` 与 `apps/server/src/worker/run-task.ts:981` 写入的 `'approval.audit'` 不匹配 → `/api/audit` 的 `approval` 列恒为 null（`apps/server/src/queries/sql.ts:330` 的 `like 'approval.%'` 归一化只覆盖事件展示，不覆盖这个 join）。
  2. `apps/server/src/worker/run-task.ts:1431/1450` 写入 `intent = 'v21:<type>'`，但 `apps/server/src/queries/sql.ts:368` 的 `ACTION_INTENTS_SQL` 不含该前缀 → v2 动作在任务详情 actions（`tasks.ts:511`）、审计导出（`audit.ts:58`）、质量统计（`quality.ts:54`）三处全部被过滤。
  3. `packages/envelope/src/v21.ts:141-147` 的 `ISSUE_READ_TOOL_NAMES` 是契约 `ISSUE_TOOLS` 读组的手写副本（两包刻意互不 import），等值靠 `packages/envelope/test/v21.test.ts:330-336` 的硬编码断言守；契约新增读工具时该断言不会自动失败，会静默漂移。
  4. `apps/server/src/app/compose.ts:863` 同时把同一数组传给 `currentLabels` 与 `botLabels`，使 `deletionOwner()`（`apps/server/src/writeback/v21/labels.ts:131`）在 v2 路径恒为 `'bot'`；`apps/server/src/app/worker-deps.ts:1080-1084` 的 worker 路径同源。
  5. `apps/server/src/writeback/v21/comments.ts:98-114` 的 `findSlotComment` 只返回列表里第一条命中标记的评论，若历史上同一槽位已存在多条（人手复制/合并），不会收敛为一条，与「同一 issue 上同一槽位只保留一条」有残余偏差。
  6. `runGit` / `runWriteback` 在生产装配中无调用方（`apps/server/src/git/writeback.ts:77` 仅被 `apps/server/test/git-writeback.test.ts` 调用），v2 的 `open_pr` 直接 `POST /pulls`（`apps/server/src/http/webhook-v21.ts:612-619`）→ 「过写回闸门」对 v2 写回路径没有实际约束力。
