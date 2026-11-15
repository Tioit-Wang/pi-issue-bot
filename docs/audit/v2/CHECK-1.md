# CHECK-1 裁决（U01-U05）

> 基线：`_baseline.txt`（HEAD `fbfa0298`），工作区含他人未提交改动，本次裁决未修改任何代码。
> 方法：逐条比对 A / B 状态；状态相同 → 抽验 1 条证据并亲自打开 `file:line`；状态不同 → 亲自读代码裁决并写明采信哪边。

## 区间结论表

| 单元 | 条目 | A | B | 归类 | 最终判定 |
|---|---|---|---|---|---|
| U01 | G-1 | 已实现 | 部分实现 | 分歧 | **部分实现**（采信 B） |
| U01 | G-2 | 已实现 | 已实现 | 收敛 | 已实现 |
| U01 | G-3 | 部分实现 | 部分实现 | 收敛 | 部分实现 |
| U01 | G-4 | 已实现 | 部分实现 | 分歧 | **部分实现**（采信 B） |
| U02 | NG-1 | 已实现 | 已实现 | 收敛 | 已实现 |
| U02 | NG-2 | 部分实现 | 部分实现 | 收敛 | 部分实现 |
| U02 | NG-3 | 已实现 | 已实现 | 收敛 | 已实现 |
| U02 | NG-4 | 已实现 | 已实现 | 收敛 | 已实现 |
| U02 | NG-5 | 已实现 | 部分实现 | 分歧 | **部分实现**（采信 B） |
| U03 | ROLE-1 | 已实现 | 已实现 | 收敛 | 已实现 |
| U03 | ROLE-2 | 已实现 | 部分实现 | 分歧 | **已实现**（采信 A） |
| U03 | ROLE-3 | 已实现 | 部分实现 | 分歧 | **部分实现**（采信 B） |
| U03 | ROLE-4 | 部分实现 | 部分实现 | 收敛 | 部分实现 |
| U04 | SA-1 | 已实现 | 已实现 | 收敛 | 已实现 |
| U04 | SA-2 | 已实现 | 已实现 | 收敛 | 已实现 |
| U04 | SA-3 | 已实现 | 已实现 | 收敛 | 已实现 |
| U04 | SA-4 | 已实现 | 已实现 | 收敛 | 已实现 |
| U04 | SA-5 | 部分实现 | 已实现 | 分歧 | **部分实现**（采信 A） |
| U04 | SA-6 | 已实现 | 部分实现 | 分歧 | **已实现**（采信 A） |
| U05 | SB-1 | 已实现 | 已实现 | 收敛 | 已实现 |
| U05 | SB-2 | 部分实现 | 部分实现 | 收敛 | 部分实现 |
| U05 | SB-3 | 已实现 | 已实现 | 收敛 | 已实现 |
| U05 | SB-4 | 与需求冲突 | 与需求冲突 | 收敛 | **与需求冲突** |
| U05 | SB-5 | 已实现 | 部分实现 | 分歧 | **部分实现**（采信 B） |
| U05 | SB-6 | 已实现 | 部分实现 | 分歧 | **部分实现**（采信 B） |

小计：25 条，收敛 16 / 分歧 9。最终判定：已实现 13、部分实现 11、与需求冲突 1。
漏条目检查：两边条目集合一致（G-1~G-4、NG-1~NG-5、ROLE-1~4、SA-1~6、SB-1~6），**无漏条**。

## 分歧裁决

### U01 G-1
- A：已实现 / B：部分实现
- 裁决：**部分实现**
- 依据：
  - `apps/server/src/app/compose.ts:209-212` — `AGENT_SESSION_POLICY = { maxTurns: 30, maxAgeDays: 7 }`；`compose.ts:455-463` 命中即返回**不带 `sessionId`** 的 `{ session:{mode:'persistent'} }` + `archiveSessionId`（新会话）。
  - `apps/server/src/app/compose.ts:1195-1207` — `v21SessionEventActive` 只在 `input.sessionEvent !== undefined` 时为真；`compose.ts:1315` 的「不 archive」判据只挡归档、**不挡新建**。
  - `apps/server/src/app/compose.ts:1459-1464` — 生产队列入口 `onTaskJob` 调 `executeTask({ taskId, attempt })`，**不传 `sessionEvent`**（全仓仅此一处 `executeTask(` 调用点，见 `compose.ts:1461`）。
- 理由：A 把 30 轮/7 天轮换当「有界例外」，B 指出该分支在真实队列路径上照常执行且不传 `sessionEvent`。代码证实 B：`onTaskJob` 不传该字段，判据失效，轮换必然发生并换新会话，「历史可延续」被主动切断。主结构（一 issue 一行、UPSERT 复用）两边都成立，故取部分实现而非未实现。

### U01 G-4
- A：已实现 / B：部分实现
- 裁决：**部分实现**
- 依据：`packages/contract/src/repo-config.ts:219-220` 声明项目级 `model`（注释「技能可以覆盖」）、`packages/contract/src/skills.ts:115-116` 声明技能级 `model`；对 `apps/server/src` + `packages/contract/src` 全量检索 `settings.model` → **0 命中**；`resolveAgentExecution()` 的调用方只读 `system_prompt` / `actions`（`compose.ts:1407`、`run-task.ts:1316-1328`、`webhook-v21.ts:684`）。
- 理由：需求达成标志是「项目级**可覆盖**平台默认」。默认分层与仓库隔离成立（A 与 B 无争议），但模型这一项的项目级覆盖字段是死字段，属明写子条件缺失，判部分实现。

### U02 NG-5
- A：已实现 / B：部分实现
- 裁决：**部分实现**
- 依据：需求 `docs/requirements.html:573` 明写「收到后按『未触发』处理并留痕，**不做评审**、不开 PR 评审会话」；代码里 `/review-pr` 通道仍在生产路径：`apps/server/src/http/webhook.ts:561`（`issue.pull_request` → `targetKind='pr'`）、`:567`、`:577`（注释「`/review-pr` 仍是命令通道」）、`apps/server/src/skills/builtin.ts:38`（`/review-pr` 技能）、`:453`（命令名注册）。
- 理由：事件层「恒 `pr-ignored`、不入队、不动会话」确实成立（A、B 均无误），但需求第 573 行同时禁止「评审」，而 `@bot /review-pr` 仍能对 PR 起一轮评审任务。A 把这条仅记为「需产品确认」却仍给已实现，与需求字面不符；采信 B 的部分实现。

### U03 ROLE-2
- A：已实现 / B：部分实现
- 裁决：**已实现**
- 依据：B 的两条缺口逐一核：
  - 「人打的标签会被目标态删除」**不成立**：标签「当前态」取自 `bot_labels` 台账 —— `apps/server/src/app/compose.ts:1658-1673` 的 `readAppliedLabels()` 查 `bot_labels`（`applied_at is not null and removed_at is null`），调用点 `compose.ts:859`（v21 钩子）与 `compose.ts:1149`（任务执行）、`apps/server/src/app/worker-deps.ts:1084`（`currentLabels` 由调用方给、`botLabels` 读同一张台账）。人打的标签从不进 `current`，因此**不可能**进入 `remove`；这也正是 `AGENTS.md` I4「标签只撤 `bot_labels` 记过的」的实现方式。B 引的 `labels.ts:62` 注释虽写「不参与过滤」，但过滤集合本身是台账而非 GitHub 实时标签，推论错误。
  - 「关闭不取消在途任务」是真的（`apps/server/src/http/webhook.ts:1210` 只做 `applyV21SessionOnEvent`，`webhook.ts` 全文无 `cancel` 命中），但需求 3.1 表（`docs/requirements.html:588`）只列维护者的动作「打标、要求补充、关闭」，三条写回路径都在（`writeback/v21/execute.ts` 的 `label` / `comment` / `close_issue`）。「关单是否中断在途任务」不是 3.1 的动作缺项，属其他小节行为边界。
- 理由：B 的主缺口依据被代码推翻，次缺口超出本条范围；采信 A，并把「关单不取消在途任务」作为待评估行为记录（不计入本条判定）。

### U03 ROLE-3
- A：已实现 / B：部分实现
- 裁决：**部分实现**
- 依据：`apps/server/src/runtime/turn-driver.ts:381-388` — `systemPrompt` 只在 `session/create` 分支透传，注释「**只在这一分支**（新建会话）带；`session/attach` 那条路径不带」；`apps/server/src/worker/run-task.ts:915` 注释同义。而 `apps/server/src/app/compose.ts:1407` 每轮都把 `systemPrompt` 传下去。
- 理由：需求 3.1 该行含「调提示词模板」。事件模板与 `project_prompt` 热生效成立，但 `agent.system_prompt` 对已存在的持久会话不生效，四环（写入/存储/读取/影响运行）缺最后一环。A 未处理这一点，采信 B。

### U04 SA-5
- A：部分实现 / B：已实现
- 裁决：**部分实现**
- 依据：
  - `apps/server/src/http/webhook-v21.ts:1029-1031` — v2.1 触发消息 `kind: 'event'`；`apps/server/src/agent/store.ts:89-90` — `agentTaskCommand()` = `agent:${kind}`，即任务命令为 `agent:event`。
  - `apps/server/src/worker/fallback.ts:47-51` — `COMMENT_FALLBACK_COMMANDS` 含 `'agent:event'`；`:69-77` `supportsCommentFallback()` 放行。
  - `apps/server/src/worker/run-task.ts:1170/1174` 只对 `valid` / `rejected` 置 `v21Handled = true`；`:1243` `if (!v21Handled && prepared !== null && (!prepared.valid || !hasCommentAction))` → 模型**没给 v2 信封**（`not-v21`）时会走 `postFallbackComment`，即平台自决补发一条无槽位评论。
- 理由：B 只排除了「事件 → 固定文案/固定标签」的硬编码，未处理 A 点名的兜底评论出口；该出口在 v2.1 任务命令（`agent:event`）上仍可达，故「平台只执行产出动作」在失败路径不完全成立。采信 A。

### U04 SA-6
- A：已实现 / B：部分实现
- 裁决：**已实现**
- 依据：
  - 评论槽位覆盖：`apps/server/src/writeback/v21/comments.ts:161-177`（`planSlotWrite` update/create）+ `apps/server/src/writeback/v21/execute.ts:651-683`（`updateIssueComment` / `createIssueComment`），真实 REST 在 `apps/server/src/github/octokit.ts:237` / `:298`。
  - 标签目标态：`apps/server/src/writeback/v21/labels.ts:178-197`（`add = desired − current`、`remove = current ∩ 可管理目录 − desired`）+ `execute.ts:545-558` 先加后删。
  - 「当前态」来源：`apps/server/src/app/compose.ts:1658-1673` `readAppliedLabels()` 读 `bot_labels`（`applied_at is not null and removed_at is null`），注释写明「`bot_labels` 就是我们写回后的权威副本」「读失败退化为空集，只会只加不删」。
- 理由：B 的唯一实质缺口是「当前态不是 GitHub 实时标签」。但用台账做当前态正是 `AGENTS.md` I4 的要求（只撤 `bot_labels` 记过的），且失败方向是「只加不删」（安全侧），不构成需求 3.2 的缺项；`dry_run` 默认 true 是既定安全默认（I2），不算实现缺失。采信 A，把「台账 vs 实时标签」记为语义偏差而非缺口。

### U05 SB-5
- A：已实现 / B：部分实现
- 裁决：**部分实现**
- 依据：
  - 生产装配确实没注入 `slotStore`：`apps/server/src/app/compose.ts:836-844` 的 `createV21Executor({ write, settings, reactions, issueEdit, openPullRequest })` 无该字段；`slotStore` 只出现在 `apps/server/src/writeback/v21/execute.ts:170/228/627/692/696` 与测试。
  - 退化路径受 `per_page: 100` 限制：`apps/server/src/github/octokit.ts:216-232` 固定 `per_page: 100`，文件头 TODO 自认「超过 100 条需要 `paginate`…留到 M1」，无分页。
- 理由：覆盖语义本身实现完整（`planSlotWrite` + `updateIssueComment` 有测试钉住），但生产路径只剩「列前 100 条评论按标记找」，长评论 issue 上会新发而非覆盖，直接触碰 I5「评论按 `(repo, issue, slot)` 覆盖」。A 未核装配点与分页上限，采信 B。

### U05 SB-6
- A：已实现 / B：部分实现
- 裁决：**部分实现**
- 依据：`apps/server/src/app/compose.ts:455-463` 轮换返回不带 `sessionId` 的 persistent；`apps/server/src/runtime/turn-driver.ts:359-373` attach 失败只 `warn` + `sessionReset`，本轮用空历史跑完；与 G-1 同一处代码。
- 理由：需求 3.3（`docs/requirements.html:601`）要求「复用场景 A 建立的会话、agent 基于已有上下文给增量结论」，轮换与 attach 失败都会静默切断上下文。常规路径（attach + 游标续接）成立故非未实现，但存在会断的分支，判部分实现；必须与 G-1 同判定，否则区间内自相矛盾。

## 抽验记录

| 单元 | 来源 | 引用 | 存在 | 相符 |
|---|---|---|---|---|
| U01 | A（G-3） | `apps/server/src/worker/run-task.ts:975` | 是 | 相符：`if (event.kind !== 'item.delta')` 才 `appendEvent`，正文增量不落库（`:972` 注释说明理由） |
| U02 | B（NG-1） | `packages/contract/src/enums.ts:115` | 是 | 相符：`ACTION_INTENTS = ['comment','label','create_issue','push_branch']`；配套 `apps/server/test/no-merge.test.ts:29-32` 四条禁 merge 模式确实存在 |
| U03 | A+B（ROLE-4） | `apps/server/src/db/schema.ts:634-644` | 是 | 相符：`quota_counters` 表 + `(repo,kind,window_start)` 唯一索引；全仓检索 `quota_counters` 仅命中 schema 声明与索引，**0 处读写** |
| U04 | A（SA-3） | `apps/server/src/prompt/render.ts:175`（`return match`） | 是 | 近似相符：`return match` 实际在 `:180`，`:175` 是 `if (value === null) {`；内容一致，仅 ±5 行偏移（见 STALE） |
| U05 | A+B（SB-4） | `packages/contract/src/settings-v21.ts:502` | 是 | 相符：`issues.edited` 内置模板第 502 行就是 `'{{issue.content}}'`，`:500` 为「这是修改后的正文快照」 |

## STALE

无「代码已变 / 行号不存在」的失效引用。唯一瑕疵是轻微行号偏移，不属代码变更：

- `U04/SA-3`：A 引 `apps/server/src/prompt/render.ts:175` 作为「未知占位符 `return match`」，实际该语句在 `:180`（`:175` 为 `if (value === null) {`）。不影响结论。
