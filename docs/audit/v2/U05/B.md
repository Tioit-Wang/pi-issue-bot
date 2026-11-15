# U05 3.3 场景 B：作者补充信息，需要复核 · B

> 核查范围：docs/requirements.html 行 599-602
> 代码基线：见 docs/audit/v2/_baseline.txt（HEAD fbfa0298，工作区 29 个已修改文件 + 未跟踪 docs/audit/）

## 结论速览

| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| SB-1 | 已实现 | — |
| SB-2 | 部分实现 | 只判 `changes` 里有没有 `body` 键，不比较正文内容；只加空白/空行仍会触发 |
| SB-3 | 已实现 | 会话键就是 `(repo, issue)`，第二轮走 `session/attach` 而非新建 |
| SB-4 | 与需求冲突 | `issues.edited` 默认模板带 `{{issue.content}}`（settings-v21.ts:502），每个事件重发整篇正文；全仓无「首轮全量/后续增量」分支 |
| SB-5 | 部分实现 | 生产装配未注入 `slotStore`；回落路径只列前 100 条评论（无分页），老 issue 会新建而非覆盖 |
| SB-6 | 部分实现 | 复用路径靠 `session/attach` 成立，但 30 轮/7 天轮换与 attach 失败都会静默新建会话，历史在那一点断开 |

## 逐条

### SB-1
- **状态**：已实现
- **证据**：
  - `apps/server/src/http/webhook-v21.ts:93-98` — `event === 'issues'` 的 `case 'edited'` 直接映射成 `'issues.edited'`，不是白名单外。
  - `apps/server/src/http/webhook.ts:1195-1201` — 注入 `deps.v21` 时调 `decideV21Delivery({event, action, payload, settings, repoDisabled})`，`issues.edited` 进入同一条判定链。
  - `apps/server/src/http/webhook.ts:1260-1285` — 判定结果非 `null` 时 `handleV21Webhook()` 接管并直接 `finish()` 返回，不再落到旧 `decideWebhookTask()` 白名单。
  - `apps/server/src/http/webhook-v21.ts:988-993` — 未触发只留痕、不入队；`webhook-v21.ts:1029-1037` 触发时 `insertMessage(... body: build.text)`。
- **判定依据**：接收（载荷→事件键）与判定（→`decideEvent`）两段都有调用方，不是孤立函数；`v21` 在 `apps/server/src/app/compose.ts:981-984` 生产装配里确实注入。
- **反证过程**：假设「`issues.edited` 其实被旧白名单挡掉」。若为真，`handleV21Webhook` 就不该在 `webhook.ts:1284-1286` 提前 `return finish(...)`。实际 `if (outcome !== null) return finish(...)` 在 `decision.action === 'ignore'` 分支（`webhook.ts:1289`）之前，所以 v2 判定确实先于旧白名单生效。另一个假设「`action='edited'` 大小写/拼写不一致」也不成立：`webhook-v21.ts:97` 与 GitHub 的 `action` 字段同字面量。此条无争议成立。

### SB-2
- **状态**：部分实现
- **证据**：
  - `apps/server/src/http/webhook-v21.ts:129` + `:138` — `changes = asRecord(payload['changes'])`，只取 `Object.keys(changes)` 当 `changedFields`；`changes` 缺失时给 `[]`。全文没有读 `changes.body.from`，即**不比较正文内容**。
  - `apps/server/src/trigger/decide.ts:145-150` — `onlyBodyChanged` 为真时只做 `changed.includes('body')`，没有就不触发（`body-unchanged`）。
  - `packages/contract/src/settings-v21.ts:329` — `'issues.edited': eventTriggerSchema.prefault({ enabled: 'on', only_body_changed: true })`，默认开关就是「只认正文」。
  - 缺失 `changes` 的行为：`apps/server/src/trigger/decide.ts:137-138` 的注释与实现一致（按未变更处理），测试 `apps/server/test/trigger-decide.test.ts:155-158` 断言 `reason === 'body-unchanged'`。
  - 只改标题：`apps/server/test/trigger-decide.test.ts:134-141` 断言 `changedFields: ['title']` → `{triggered:false, reason:'body-unchanged'}`；只改标签 `:144-153` 同理。
- **缺口**：需求写「判定正文确实变了（**不是只改标题或空白**）」，代码只实现了「不是只改标题」，**没实现「不是只改空白」**——GitHub 对「只加一个空格/一行空行」同样在 `changes` 里给出 `body` 键，`decide.ts:148` 只看键存在与否，于是仍会触发一轮完整评审。需求 3.3 明写的这个子条件缺失。
- **判定依据**：只认正文这一侧（含 `changes` 缺失的兜底）有实现、有断言；但「空白算不算变更」在 `trigger/decide.ts` 与 `http/webhook-v21.ts` 两处都没有内容级比较（`DecideEventInput` 里根本没有正文入参，`decide.ts:100-124`），因此不能判已实现。
- **反证过程**：默认假设是「它其实只按 action 判」。证伪路径一：若只按 `action==='edited'` 判，`trigger-decide.test.ts:134` 的 `title` 用例应触发，实际不触发 → 说明确实读了 `changes`。证伪路径二：若存在隐藏的正文比较（比如在某处比 `from` 与 `issue.body`），应当能搜到读取 `from` 或规范化正文的代码；全仓 `changes` 的出现点只有 `webhook-v21.ts:129/138`、`webhook.ts:632-633`、`trigger/decide.ts:106/136`，全是键名/键存在判断，**没有一处读 `from`**，也没有把正文喂给 `decideEvent` → 「空白」这一子条件确实缺。另注：把 `only_body_changed` 配成 `false`（`settings-v21.ts:86` 允许）后只改标题也会触发，这是配置面与需求「不是只改标题」相冲的地方，但默认值挡住了主路径，只在「配置被改」时才反着来。

### SB-3
- **状态**：已实现
- **证据**：
  - `apps/server/src/agent/store.ts:156-163` — `agent_sessions` 的 UPSERT 以 `(repo, issue_number)` 为唯一键，一个 issue 只有一行会话。
  - `apps/server/src/app/compose.ts:1157-1160` — 每轮任务按 `{repo, issueNumber}` 读该行；`compose.ts:1228-1233` 交给 `planAgentSession()`。
  - `apps/server/src/app/compose.ts:465-475` — 有 `session_id` 就返回 `{mode:'persistent', sessionId, after: cursor}`。
  - `apps/server/src/runtime/turn-driver.ts:359-373` — `persistent` + 有 id ⇒ `attachSession()`，不是 `sessionCreate()`。
  - `apps/server/test/agent-serial-queue.test.ts:248-250` — 断言第二轮 `session/attach` 至少有一次（不是重新开会话）。
- **判定依据**：会话标识的键、读取点、attach 调用三处齐备，且有测试钉住「第二轮 attach」这一可观察事实。
- **反证过程**：默认假设「第二轮其实新建了会话」。两个可构造的证伪点是轮换与 attach 失败：`compose.ts:209-212` 定 `maxTurns: 30 / maxAgeDays: 7`，`compose.ts:448-463` 到阈值就返回**不带 `sessionId`** 的 persistent（= 新建），`turn-driver.ts:370-373` attach 失败也新建。但这两个都是**条件分支**，场景 B（A 之后一两轮内的编辑）落在 `turns<30 且 age<7d` 的常规分支 `compose.ts:466-479`，走的是同一个 `sessionId`。因此「同一 issue 复用同一会话」在场景 B 下成立；轮换本身记在 SB-6 的反证里，不推翻本条。

### SB-4
- **状态**：与需求冲突
- **证据**：
  - `packages/contract/src/settings-v21.ts:490-504` — `issues.edited` 的内置默认模板；其中 **`:502` 就是 `'{{issue.content}}'`**，`:500` 的说明文字是「这是修改后的正文快照」。
  - `apps/server/src/http/webhook-v21.ts:317-325` — 渲染上下文的 `issue.content = str(issue, 'body') ?? ''`，即 GitHub 上的**完整当前正文**。
  - `apps/server/src/http/webhook-v21.ts:464-472` + `:1007-1019` — `issues.edited` 每次都拿同一份模板重新渲染并整条落 `agent_messages.comment_body`（`insertMessage`，`:1029-1037`），没有「首轮全量 / 后续增量」的选择。
  - 反证关键：全仓搜 `增量`/`首次全量` 在 `apps/server/src` 只命中 `compact/*`（摘要增量）、`degeneracy/*`（低增量判据）、`writeback/v21/labels.ts:4`（标签目标态），**提示词侧一处都没有**；`changes.body.from`（上一版正文）从未被读取（`webhook-v21.ts:129/138` 只取键名），因此平台连「变更部分」都算不出来。
- **缺口**：需求（3.3 与 FR-4.2，`docs/requirements.html:601`、`:949`）要求「只把变更部分与本轮指令发过去，不重复整篇正文」；实际每个 `issues.edited` 都把整篇正文再发一遍，历史在会话里已有、正文又整篇重发，属于**行为与需求相反**。模板里确实有「本轮指令」（`settings-v21.ts:493`），所以只有后半句成立。
- **判定依据**：冲突点是模板中的占位符本身（`settings-v21.ts:502`）加上渲染侧无条件的 `issue.content` 填充（`webhook-v21.ts:322`）；这是默认路径（`v21TemplateOf` 在项目未自定义时即用它，`webhook-v21.ts:359-361`），不是可选分支。按 §七「需求写 X，代码反着来 → 与需求冲突」判定。
- **反证过程**：先假设「增量逻辑在别处（比如组装消息时裁剪）」。检查三条可能藏身之处：(1) `agent/message.ts:266-293` 的 `composeAgentMessage` 事件分支同样把 `body` 整段塞进 `{body}`（`message.ts:277`），且 v2 路径根本不走它（`webhook-v21.ts:390-392` 注释说明 v2 正文是模板渲染结果）；(2) `app/compose.ts:1239-1252` 只是把整条 `agent_messages.comment_body` 原样接在系统段后面，无裁剪；(3) `prompt/render.ts:148-149` 的 `issue.content` 直接 `stringify(ctx.issue.content)`。三处都没有「只给差量」的实现。第二个假设「模板被项目自定义后就不带正文」也不构成实现：默认模板带，且 `resolveEventTrigger().prompt` 为空时回落默认（`decide.ts:255-258`），所以默认部署必然整篇重发。据此推翻「已实现」，判冲突。

### SB-5
- **状态**：部分实现
- **证据**：
  - `apps/server/src/writeback/v21/comments.ts:44-55` — 槽位标记 `<!-- pi-bot:slot repo#issue:slot -->`；`:98-114` `findSlotComment()` 按标记在评论列表里找；`:161-177` `planSlotWrite()`：找到 → `op:'update'`，找不到 → `op:'create'`。
  - `apps/server/src/writeback/v21/execute.ts:630-643` — 索引优先（`slotStore.get`），没有索引就 `listIssueComments()` + `findSlotComment()`。
  - `apps/server/src/writeback/v21/execute.ts:651-659` — `update` 走 `updateIssueComment`（改旧评论）、`:675-683` 走 `createIssueComment`。
  - `apps/server/test/writeback-v21-execute.test.ts:395-407` — 断言「槽位已存在 → `updateIssueComment`，且 `not.toContain('createIssueComment')`」；`writeback-v21-comments.test.ts:91-101` 断言 `op:'update'` 带 `commentId`。
- **缺口**：两处，都影响「真的覆盖而不是新发」：
  1. **生产装配没有注入 `slotStore`**：`apps/server/src/app/compose.ts:836-844` 的 `createV21Executor({...})` 只给了 `write/settings/reactions/issueEdit/openPullRequest`，全仓 `slotStore` 的出现点只有 `writeback/v21/execute.ts:170/228/627/692/696` 与测试 `writeback-v21-execute.test.ts:414-420`。于是生产里 `historyCommentId` 恒为 `null`，每次都退化成「列评论按标记找」。
  2. **列表只取前 100 条且不分页**：`apps/server/src/github/octokit.ts:216-232` 的 `listIssueComments` 固定 `per_page: 100`，文件头 `:216-218` 自己写着「超过 100 条的 issue 需要 `paginate`…留到 M1」。评论超过 100 条的 issue 上，标记找不到 → `planSlotWrite` 返回 `create` → 每轮**新发**一条，正是需求要避免的「刷屏」。
  3. 附带：槽位名由模型在 `actions` 里自己给（`apps/server/src/skills/prompt.ts:361-365` 只给 `"slot":"result"` 的示例），平台不强制「场景 A 用的那个槽位」在 B 轮继续用；同槽位覆盖因此依赖模型输出稳定。
- **判定依据**：覆盖语义与标记查找本身实现完整且有具体断言（`calls` 里 `updateIssueComment` 有、`createIssueComment` 无），所以不是未实现；但「同槽位被编辑更新而非新发」在生产装配下不保证成立（索引未接、分页缺失），故判部分实现并点名缺哪两个子条件。
- **反证过程**：默认假设「每次都是新建评论」。证伪点一：`planSlotWrite` 在 `existing !== null` 时返回 `update`，且执行器真的调 `updateIssueComment`（`execute.ts:651-659`）——所以不是无条件新建。再反过来假设「总是覆盖」也不成立：`execute.ts:627` 的 `input.slotStore === undefined ? null : ...` 在生产路径恒为 `null`（`compose.ts:836-844` 无该字段），说明覆盖只能靠列表标记兜底；而兜底受 `octokit.ts:226` 的 `per_page: 100` 上限约束，第 101 条以后的槽位评论永远找不到。两个方向都推不通「已实现」，落在部分实现。

### SB-6
- **状态**：部分实现
- **证据**：
  - `apps/server/src/runtime/turn-driver.ts:359-374` — attach 成功即复用原会话，并用快照游标兜底 `after`（`:364-369`）。
  - `apps/server/src/runtime/turn-driver.ts:394-395` — `events/subscribe({sessionId, after})` 用游标接上历史之后的事件，不重放旧事件。
  - `apps/server/src/runtime/turn-driver.ts:426-433` — `persistent` 会话在正常结束时**不归档**，留给下一轮 attach。
  - `apps/server/src/app/compose.ts:1049-1053` — 每轮把 `session_id/cursor/turns/started_at` UPSERT 回 `agent_sessions`，下一轮靠它 attach。
  - `apps/server/test/agent-serial-queue.test.ts:250` — 断言第二次处理走 `session/attach`。
- **缺口**：两条路径会让「历史」在中途断掉，而需求（3.3「agent 基于已有上下文给出增量结论」、共性段 `docs/requirements.html:609`「会话必须是同一条」）没有为它们留例外：
  1. **轮换**：`apps/server/src/app/compose.ts:450-463` 在 `turns>=30` 或存活超 `7` 天时返回 `{session: {mode:'persistent'}}`（不带 `sessionId`）→ `turn-driver.ts:375-391` 走 `sessionCreate()`，新会话里没有 A 轮的结论；`compose.ts:1315-1338` 还会 archive 旧会话。阈值来自 `compose.ts:209-212`（`maxTurns: 30 / maxAgeDays: 7`）。
  2. **attach 失败静默新建**：`turn-driver.ts:370-373` 只记 `warn` + `sessionReset = true`，本轮照样用空历史跑完，只在 `compose.ts:1043-1048` 留一条 info。
- **判定依据**：常规路径（同一 `session_id` attach + 游标续接）有实现、有测试断言，所以不是未实现；但「历史真的被延续」存在两个会静默切断的分支，且都不在需求允许的例外里，故判部分实现并点名。
- **反证过程**：默认假设「每次都是新会话，历史其实是空的」。证伪点：`planAgentSession` 在 `session_id` 存在且未到阈值时确实回填 `sessionId`（`compose.ts:466-479`），`turn-driver.ts:359` 有 id 才 attach，`agent-serial-queue.test.ts:250` 断言了 attach 被调用 → 常规路径不是空历史。反向假设「历史永远延续」也不成立：`compose.ts:456-463` 的 rotate 分支明确返回不带 id 的 persistent，注释（`:458`）自称「`driveTurn` 会新建会话」，说明轮换必然换会话；`compose.ts:1315` 那段 archive 逻辑只按 `v21SessionEventActive` 跳过归档，**并不阻止新建**——所以「队列 job 路径（`compose.ts:1460-1464` 不传 `sessionEvent` → `v21SessionEventActive === false`）到 30 轮/7 天就断历史」是可复现的。另需点名：host 侧 attach 是否真的带回历史属运行时行为，静态代码只能确认「平台交出了同一个 sessionId」。

## 本节整体结论

场景 B 的**入口链路成立**（`issues.edited` 能进判定、会话按 issue 复用、槽位覆盖机制存在），但需求 3.3 的两个核心承诺都没有落地：一是「只把变更部分发过去」被默认模板里的 `{{issue.content}}`（`packages/contract/src/settings-v21.ts:502`）直接反着做——每个编辑事件都重发整篇正文，且全仓没有任何「首轮全量 / 后续增量」分支；二是「不是只改空白」只做了「不是只改标题」，「空白」这一子条件在判定链里根本没有比较对象。此外槽位的「覆盖」在生产装配下缺 `slotStore`、`comment` 列表又只有前 100 条，老 issue 上仍会新发。

因此本节**不能判为已实现**：一条与需求冲突（SB-4），三条部分实现（SB-2 / SB-5 / SB-6），只有 SB-1 与 SB-3 成立。

## 核查边界

- 是否执行了命令：未执行 `pnpm -r test` / `typecheck` / `lint`。仅做静态核查，另用 `git status --short`（结果与 `_baseline.txt` 一致，未新增改动）、`Select-String` 全仓检索（用于证伪 SB-4 的「增量分支」、SB-5 的 `slotStore` 装配点）与 `Get-ChildItem` 列出测试文件名。测试文件的断言内容只按源码阅读确认，**未获知是否跑绿**。
- 未覆盖的条目及原因：无未覆盖条目；SB-6 中「host 侧 attach 是否真的带回历史」需要真 pi-host 运行，静态代码无法确认（本条仍按平台侧实现判部分实现，缺口按可核实的轮换/失败分支计）。
- 发现的额外问题（不属本节范围但值得记录）：
  1. `apps/server/src/app/compose.ts:456-463` + `:1315-1338` 的轮换会 archive 旧会话，与 FR-3.4「会话没有结束状态、不归档」（`docs/requirements.html` FR-3.4 段）相冲；且 `:1315` 的判据只挡归档、不挡新建。
  2. `apps/server/src/writeback/v21/execute.ts:170-179` 定义的 `V21SlotStore` 与 `db/schema.ts:764-782` 建好的 `comment_slots` 表之间**没有适配器**，表有、写路径没有，属于「有表无用」。
  3. `apps/server/src/github/octokit.ts:216-218` 自己留的 TODO（分页）会让槽位与内容去重在长评论 issue 上双双退化。
  4. `packages/contract/src/settings-v21.ts:86` 允许把 `only_body_changed` 关掉，与需求「不是只改标题」的绝对表述不一致，属配置面缺口而非实现缺口。
