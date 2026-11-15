# U05 3.3 场景 B：作者补充信息，需要复核 · A

> 核查范围：docs/requirements.html 行 599-602
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览

| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| SB-1 | 已实现 | — |
| SB-2 | 部分实现 | 只判 `changes` 里有没有 `body` 键，不比对正文内容，纯空白改动照样触发 |
| SB-3 | 已实现 | — |
| SB-4 | 与需求冲突 | `issues.edited` 每轮仍把整篇正文重新下发（`{{issue.content}}`），没有「只发变更部分」的通道 |
| SB-5 | 已实现 | — |
| SB-6 | 已实现 | 依赖宿主 `session/attach`：失败即新建会话；另有 30 轮 / 7 天轮换 |

## 逐条

### SB-1
- **状态**：已实现
- **证据**：
  - `apps/server/src/http/webhook-v21.ts:93` — `v21EventKeyOf()` 的 `issues` 分支把 `action === 'edited'` 映射成 `'issues.edited'`（第 97-98 行），是五个合法 EventKey 之一，不会被丢弃。
  - `apps/server/src/http/webhook.ts:1195` — 投递进主流程后先做 `decideV21Delivery({ event, action, payload, settings, repoDisabled })`，`issues.edited` 由此进入判定。
  - `apps/server/src/http/webhook-v21.ts:176` — `decideV21Delivery()` 落到纯函数 `decideEvent()`；`apps/server/src/http/webhook.ts:1262` 把判定结果交 `handleV21Webhook()`。
  - `apps/server/src/app/compose.ts:981` — 生产装配**无条件**注入 `v21: { db, repoIssues }`，所以这条路径在线上是通的，不是只在测试里存在。
- **判定依据**：接收（事件键映射）→ 判定（decideEvent）→ 处置（handleV21Webhook）三段都有真实调用方，且装配层默认注入，不依赖任何开关。

### SB-2
- **状态**：部分实现
- **证据**：
  - `apps/server/src/http/webhook-v21.ts:138` — `changedFields: changes === null ? [] : Object.keys(changes)`，只取 `changes` 的**键名**，从不读 `changes.body.from`，也没有和当前正文做任何比对。
  - `apps/server/src/trigger/decide.ts:145` — `only_body_changed` 打开时只判 `changed.includes('body')`，缺 `body` 键 → `body-unchanged` 跳过（第 148-150 行）。
  - `packages/contract/src/settings-v21.ts:329` — `'issues.edited': eventTriggerSchema.prefault({ enabled: 'on', only_body_changed: true })`，即默认开启，标题/标签单独变更是被挡住的。
  - `apps/server/src/agent/fingerprint.ts:36` — 事件指纹 = `repo + issue + templateId + issue.updated_at`，不含正文；一旦被判触发，空白改动也会因为 `updated_at` 变了而落成一条**新**消息。
- **缺口**：需求写的是「判定正文确实变了（不是只改标题或**空白**）」。标题分支实现了（`changedFields` 不含 `body` 即跳过），**空白分支没有实现**：正文只增多一个空格/换行时 GitHub 同样会在 `changes` 里给 `body`，平台照触发，等于为一次格式噪声再烧一轮模型。缺的子条件就是「空白/等价正文不触发」。
- **判定依据**：代码里存在「只认 `body` 键」的判断（所以不是未实现），但「空白不算变更」需要的正文级比对在 `changedFields`（键名数组）这条数据通路上根本承载不了，故判部分实现并点名该子条件。

### SB-3
- **状态**：已实现
- **证据**：
  - `apps/server/src/http/webhook.ts:1210` — 每个 v2 事件（含 `issues.edited`）都调 `applyV21SessionOnEvent()`，写库点在 webhook 侧、且只 UPDATE/INSERT。
  - `apps/server/src/http/webhook-v21.ts:799` — `reuse` 语句是 `UPDATE "agent_sessions" SET "state"='active', ...`，键是 `(repo, issue_number)`；`create` 语句（第 793 行）带 `ON CONFLICT ("repo","issue_number") DO NOTHING`，即使误走 create 也不会产生第二行。
  - `apps/server/src/agent/session-state.ts:155` — 非关闭类事件的常规分支返回 `action: 'reuse'`、`keepSession: true`，只有 `session === null`（该 issue 从未有会话）才 `create`（第 112-119 行）。
  - `apps/server/src/app/compose.ts:1157` — 执行侧按 `(repo, issue_number)` 读 `agent_sessions` 拿同一个 `session_id`，没有「按事件新建一行」的路径。
- **判定依据**：会话的身份是 `(repo, issue_number)`，数据库唯一约束 + 纯函数的 reuse 分支两层都指向「同 issue 同一行」，edited 走的就是这条分支。

### SB-4
- **状态**：与需求冲突
- **证据**：
  - `packages/contract/src/settings-v21.ts:500` — 内置 `issues.edited` 模板写的是「这是修改后的正文快照…」并在第 502 行插入 `{{issue.content}}`，即**整篇正文**。
  - `apps/server/src/prompt/render.ts:148` — `case 'issue.content': return stringify(ctx.issue.content)`；`apps/server/src/http/webhook-v21.ts:322` 的渲染上下文把 `content: str(issue, 'body')` 整段塞进去（第 322 行），没有任何 diff/delta 来源。
  - `apps/server/src/http/webhook-v21.ts:1029` — 渲染结果原样作为 `body: build.text` 写进 `agent_messages.comment_body`（第 1034 行），注释即「本轮发给 agent 的消息正文」。
  - `apps/server/src/app/compose.ts:1239` — 组装任务提示词时把该正文整段拼在 `## 这一条消息` 之后（第 1251 行），随后作为 `input.prompt` 交给 `driveTurn()`。
  - `packages/contract/src/settings-v21.ts:420` — 12 个可用占位符里没有任何「变更片段 / 前后对比」占位符，项目模板层也拿不到增量。
  - `apps/server/src/http/webhook.ts:632` — 载荷里唯一一次读 `changes` 只用于判断 `'title' in changes || 'body' in changes`，`changes.body.from` 全仓无读取（`Select-String "changes\.|changes\["` 仅命中两处键名判断）。
- **缺口**：需求「只把变更部分与本轮指令发过去」的实现完全缺失，实际行为是**每轮重发整篇正文**，与需求相反；同时命中第 5.4 节 FR-4.2「首次全量、后续增量」（docs/requirements.html:949），FR-4.2 也应同步判为未实现/冲突。
- **判定依据**：证据是「发出去的那条消息的字面内容」——模板固定嵌入 `{{issue.content}}`，渲染器照抄正文，`changes.body.from` 无人读取，三层都指向整篇重发；这不是粒度偏粗，而是与需求方向相反。

### SB-5
- **状态**：已实现
- **证据**：
  - `apps/server/src/writeback/v21/comments.ts:161` — `planSlotWrite()`：找到同槽位评论就返回 `op: 'update'` 且带 `commentId`（第 173 行），只有找不到才 `create`。
  - `apps/server/src/writeback/v21/execute.ts:630` — `runComment()` 先查槽位索引 `slotStore.get()`，索引没有才退回 `listIssueComments()` + `findSlotComment()` 按隐藏标记找（第 633-637 行）。
  - `apps/server/src/writeback/v21/execute.ts:653` — `op === 'update'` 走 `input.api.updateIssueComment({ commentId: plan.commentId, ... })`，即编辑原评论而不是新发；`createIssueComment` 只在第 665/675 行的重建/首写分支。
  - `apps/server/src/writeback/v21/execute.ts:696` — 写成功后 `slotStore.put()` 记下 `commentId`，下一轮直接命中索引（第 692 行先判 `slotStore` 是否注入）。
 - **判定依据**：「同槽位 → 更新原评论」是写回层的默认行为，且有索引 + 标记两条查找路径；发评论动作不存在「每次都新建」的分支。

### SB-6
- **状态**：已实现
- **证据**：
  - `apps/server/src/app/compose.ts:465` — `planAgentSession()` 在第 2 轮起返回 `{ mode: 'persistent', sessionId, after: cursor }`（第 467-475 行），`after` 取上一轮游标以免重放旧事件。
  - `apps/server/src/runtime/turn-driver.ts:359` — `persistent` 且有 `sessionId` 时先 `session/attach` 接管原会话，接管成功即沿用同一 `sessionId`（第 362 行），随后 `turn/start { sessionId, input:{ messageId, text } }`。
  - `apps/server/src/app/compose.ts:1049` — 每轮结束后 `saveSession()` 把 `sessionId` / `cursor` / `turns` UPSERT 回 `agent_sessions`，下一轮才 attach 得上（`apps/server/src/app/compose.ts:1007` 读回）。
  - `apps/server/src/jobs/agent-dispatch.ts:63` — agent 消息经 dispatcher 串行投递，同一 issue 一条一条跑，不会并发开新会话。
- **判定依据**：会话历史由 RACP 侧的 `session/attach` 承担，平台侧把 `session_id` 持久化并在下一轮显式复用，中间不重建会话、也不重放历史。
- **残留边界**（不改变结论）：`session/attach` 是可选 operation（`apps/server/src/runtime/turn-driver.ts:155` 声明为 `sessionAttach?`），宿主不提供或会话已被清理时降级新建并标 `sessionReset`（第 371 行），此时「基于已有上下文」这一轮实际不成立；另有 `AGENT_SESSION_POLICY`（`apps/server/src/app/compose.ts:209`）在 30 轮 / 7 天后主动轮换会话，上下文会断一次。两者都属运行时/策略边界，不是缺实现。

## 本节整体结论

本节**不能**整体判为「已实现」，卡点在 SB-4。事件接收、只认正文键、同会话复用、同槽位覆盖、会话历史延续这五项在代码里都能定位到真实执行路径；但需求的核心诉求之一「只把变更部分与本轮指令发过去」在代码里恰好反着做——`issues.edited` 的内置模板每轮都嵌入 `{{issue.content}}` 并把整篇正文写进 `agent_messages.comment_body` 发给模型。SB-2 另有「空白改动不算变更」这一子条件缺失，会让格式噪声也触发一轮复核。SB-4 同时构成第 5.4 节 FR-4.2 的冲突证据，联合定级时应把两处一起改。

## 核查边界

- 是否执行了命令：只执行只读命令——`git status --short` / `git log --oneline -3`（工作区与 `_baseline.txt` 一致，HEAD `fbfa029`）、`Get-ChildItem` 列 `apps/server/src` 与 `packages/*/src`、多次 `Select-String` 定位符号。**未运行任何测试**（`pnpm -r test` / `vitest` 均未执行），测试结论仅为「测试存在且断言具体」层面的观察，不代表跑过且绿。
- 未覆盖的条目及原因：无（SB-1~SB-6 均已核）。
- 发现的额外问题（不属本节范围但值得记录）：
  1. `apps/server/src/agent/message.ts:53` 的 v0.3 `edited` 模板同样整篇内联 `{body}`；该路径只在未注入 `deps.v21` 的旧装配下走（`apps/server/src/http/webhook.ts:1296`），生产不启用，但若有人回退装配，SB-4 的冲突会以同一形态复现。
  2. 会话状态迁移在 webhook 侧对**所有** v2 事件无条件执行（`apps/server/src/http/webhook.ts:1210`），包括随后被判定为 `switch-off` / `body-unchanged` 的事件；即一条不触发的 `issues.edited` 也会给该 issue 建出 `agent_sessions` 行，与「未触发不留副作用」的口径存在张力。
  3. `apps/server/test/trigger-decide.test.ts:133` 覆盖了「只改标题 / 只改标签 / 无 `changes`」三种情况，但没有「正文只改空白」的用例，与 SB-2 的缺口一致；这是缺测试而非误报。
