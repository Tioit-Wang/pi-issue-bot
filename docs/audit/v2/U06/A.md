# U06 3.4 场景 C：维护者在评论里追问 · A

> 核查范围：docs/requirements.html 行 603-610
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| SC-1 收到 `issue_comment.created` 能被接收 | 已实现 | — |
| SC-2 三个闸门都存在且生效 | 已实现 | — |
| SC-3 合法提及判定（@ + 关键词 + 分隔符） | 已实现 | — |
| SC-4 评论事件复用该 issue 已有会话 | 已实现 | — |
| SC-5 `{{comment.body}}` / `{{comment.author}}` 在该事件下可用 | 已实现 | — |
| SC-6 与场景 A 用不同槽位、互不覆盖 | 部分实现 | 平台只按 `slot` 字符串隔离，不决定槽位名；全仓唯一给出槽位名的提示是 `result`，两条场景默认撞同一槽位 |

## 逐条

### SC-1
- **状态**：已实现
- **证据**：
  - `apps/server/src/http/webhook.ts:1923` — `scope.post('/webhook')` 收任意事件，事件名取 `X-GitHub-Event` 头（`:1930-1936`），不按事件名白名单拒绝。
  - `apps/server/src/http/webhook-v21.ts:90-92` — `v21EventKeyOf()`：`event === 'issue_comment'` 且 `action === 'created'` → `'issue_comment.created'`。
  - `apps/server/src/http/webhook.ts:1255-1287` — 注入 `v21` 时取 `decideV21Delivery()` 的结果调 `handleV21Webhook()`，事件在此进入会话链路。
- **判定依据**：接收、事件键映射、进入 v2 分支三段都有实际调用路径，不是只有常量或类型。

### SC-2
- **状态**：已实现
- **证据**：
  - `apps/server/src/trigger/decide.ts:173-201` — `checkCommentGates()` 依次判 `ignore_bot`（:175）、`allow_closed`+`issue.state`（:178）、`require_mention`+`findLegalMention()`（:181-186）、`require_role`+`matchCommentRole()`（:188-198）；`decide.ts:238-243` 只在 `event === 'issue_comment.created'` 时调用。
  - `packages/contract/src/settings-v21.ts:105-118` — 四个闸门的默认值：`require_mention` 默认 `true`、`require_role` 默认 `false`、`ignore_bot` 默认 `true`、`allow_closed` 默认 `false`（与 FR-2.4 表格一致）。
  - `apps/server/src/config/v21-settings.ts:132-144` — `resolveCommentGates()` 从 `triggers.events['issue_comment.created'].gates` 读生效值，不是读 `comment` 段。
  - 生效链路：`apps/server/src/http/webhook.ts:1195-1201` 用 `policy.settings` 算判定 → `:1260-1272` 调 `handleV21Webhook()` → `webhook-v21.ts:988-994` 未触发即回 200 `ignored` 并 **return**，不落 `agent_messages`、不入队。
  - `apps/server/src/trigger/decide.ts:227-229` — 事件开关 `off` 在闸门之前返回（FR-2.4「开关关闭时闸门一律不生效」）。
  - 测试：`apps/server/test/trigger-decide.test.ts:229-292` 逐条断言 `reason` 为 `bot-self` / `closed-not-allowed` / `not-mentioned`，不是只断言 200。
- **判定依据**：四个闸门都有实现 + 有调用方 + 有改变结果的出口（未触发即不入队）；默认值与 FR-2.4 逐项相同。需求正文列的三个闸门（提及 / 角色 / 已关闭）全部覆盖，另有 `ignore_bot`。

### SC-3
- **状态**：已实现
- **证据**：
  - `apps/server/src/trigger/mention.ts:134-161` — `findLegalMention()`：先 `maskCodeRegions()` 蒙版（:142），`@` 前一个字符不得属于 `[A-Za-z0-9._@-]`（:67、:147-148），关键词后必须是分隔符（:70-75、:115-117），同一位置最长关键词优先（:96）。
  - `apps/server/src/trigger/mention.ts:50-58` — 分隔符白名单（含中文标点），据此实现 `@pi-bot你好` 不命中。
  - `apps/server/src/trigger/decide.ts:181-186` — 提及闸门就是调这个函数，返回值决定 `not-mentioned`。
- **判定依据**：`@` + 关键词 + 分隔符三条规则都在实现里且有第二个约束（前导字符、代码区蒙版），并且是闸门判定的唯一入口，不是无人调用的工具函数。

### SC-4
- **状态**：已实现
- **证据**：
  - 会话键 = `(repo, issue_number)`：`apps/server/src/http/webhook-v21.ts:786-802` 的 `V21_SESSION_SQL` 全部按 `repo` + `issue_number` 定位，`create` 用 `ON CONFLICT ("repo","issue_number") DO NOTHING`，只有 INSERT/UPDATE、无 DELETE。
  - `apps/server/src/http/webhook.ts:1210-1222` — 每条投递（含 `issue_comment.created`）都调 `applyV21SessionOnEvent()` 做状态迁移；`apps/server/src/agent/session-state.ts:108-163` 中已有会话走 `reuse`（保留 `session_id`，`keepSession: true`），只有「没有会话」才 `create`。
  - 执行侧复用：`apps/server/src/app/compose.ts:1157-1160` 从 `agent_sessions` 读该 issue 的会话行 → `:1228-1233` `planAgentSession()` 给出 `{mode:'persistent', sessionId, after?}`（`compose.ts:466-479`）→ `:1360` 传进 `runTask()`。
  - `apps/server/src/runtime/turn-driver.ts:359-373` — `persistent` 且有 `sessionId` 时 `session/attach` 接管那个会话，只有 attach 失败才新建并置 `sessionReset`。
  - 写回：`apps/server/src/app/compose.ts:1049-1053` 每轮结束 UPSERT 会话 id / 游标；`apps/server/src/agent/store.ts:156-163` 的 `saveSession` 也是按 `(repo, issue_number)` UPSERT（一个 issue 一行）。
- **判定依据**：会话不是按任务或按事件新建的，而是按 issue 定位并从库里读 id 后 attach；评论事件与 `issues.opened` 走同一行 `agent_sessions`，因此 B、C 阶段天然接在 A 的会话上。测试侧有 `apps/server/test/v21-integration.test.ts:488-503` 断言评论事件在已关闭 issue 上仍是 `keepSession: true`。

### SC-5
- **状态**：已实现
- **证据**：
  - `apps/server/src/prompt/render.ts:153-156` — `resolvePlaceholder()` 显式实现 `comment.author` / `comment.body`（无评论时为空串、不算未知占位符）。
  - `packages/contract/src/settings-v21.ts:428-429` — 占位符清单包含 `comment.author` / `comment.body`（面板按同一份渲染「插入」按钮）。
  - `apps/server/src/http/webhook-v21.ts:326-333` — 渲染上下文只在载荷有 `comment` 时填 `comment: { author: comment.user.login, body: stripAliasMentions(comment.body, aliases) }`，即 `issue_comment.created` 下必然可用。
  - `apps/server/src/http/webhook-v21.ts:450-516` — `buildV21AgentMessage()` 用该上下文渲染并落 `agent_messages.comment_body`（`:1029-1037`）。
  - `packages/contract/src/settings-v21.ts:531-548` — `issue_comment.created` 的内置默认模板本身就用了 `{{comment.author}}`（:536）与 `{{comment.body}}`（:538）。
- **判定依据**：占位符既有解析实现、又有数据源、又在内置默认模板里被真实使用，属于「存在且生效」。

### SC-6
- **状态**：部分实现
- **证据**：
  - 隔离机制在：`apps/server/src/writeback/v21/comments.ts:161-176` `planSlotWrite()` 按槽位键判覆盖/新建；`apps/server/src/writeback/v21/execute.ts:590-596` 用 `payload.slot` 生成标记并作为槽位键；`apps/server/src/db/schema.ts:764-782` `comment_slots` 主键 = `(repo, issue_number, slot)`；`execute.ts:627-638` 缺索引时回落 `findSlotComment()`（按标记精确匹配）。
  - 槽位名的唯一来源是模型产出：`apps/server/src/writeback/v21/execute.ts:594` `slot: payload.slot`，平台侧不做任何事件→槽位映射。
  - 全仓提示词里唯一出现的槽位示例是 `result`：`apps/server/src/skills/prompt.ts:361-364` `{"type":"comment","payload":{"slot":"result",...}}`；`skills/` 下各技能正文没有任何「按用途换槽位」的指示（`grep slot` 在 `apps/server/src/skills/*.ts` 只命中 `assemble.ts` 与 `prompt.ts` 这一行）。
  - 代码里唯一的固定槽位常量是关闭评论：`apps/server/src/writeback/v21/execute.ts:280` `CLOSE_COMMENT_SLOT = 'close'`（与普通评论不同的槽位，:863）。
- **缺口**：缺「不同场景使用不同槽位」这一子条件。平台只保证「同槽位覆盖、不同槽位互不影响」，但槽位名由模型自选，而产物提示只给了一个 `result` 示例，也没有任何技能/模板告诉它「答复提问」要换名字。结果是场景 C 的答复与场景 A 的评审评论默认落在同一 `result` 槽位，后写覆盖先写 —— 需求 5.5（docs/requirements.html:1032）举的「『格式评审』和『答复提问』各自一条」在默认配置下不成立。
- **判定依据**：机制侧（键、标记、主键、覆盖判定）四条证据齐全，可直接判「隔离真存在」；但 SC-6 问的是「评论触发后的产出是否与场景 A 用不同槽位」，代码里不存在任何把事件或用途映射到槽位名的实现，提示词还朝单一槽位引导，故只能判部分实现并点名缺的是哪一条。

## 本节整体结论
场景 C 的主链路成立：`issue_comment.created` 能被接收并映射为事件键，四个评论闸门（提及 / 角色 / 已关闭 / 忽略机器人）都在事件开关之后生效且未触发时确实不入队，提及判定按「@ + 关键词 + 分隔符」实现并含代码区蒙版与前导字符约束。会话侧按 `(repo, issue_number)` 定位 `agent_sessions`，已有会话走 `reuse` 并由 `session/attach` 接管，评论事件与 opened/edited 共用同一条会话，符合「进入同一会话回答」。`{{comment.body}}` / `{{comment.author}}` 既有解析、又有数据源、也出现在该事件的默认模板里。唯一不满足的是「不同槽位互不影响」的场景级保证：槽位名由模型自选，提示词里只有 `result` 一个示例，因此本节的「已实现」应带一张附加条件——槽位差异化不是平台行为。据此本节整体判为**部分实现**（1 条部分实现，其余 5 条已实现）。

## 核查边界
- 是否执行了命令：执行了只读命令 `git rev-parse HEAD`（= `fbfa02983d36d4923c0647f4c18aacd041d83375`）与 `git status --short`（与 `_baseline.txt` 一致）；其余为 `Select-String` 只读检索与逐文件 `Read`。**未执行**测试（`pnpm -r test` 等），故本文只声明「测试存在且断言具体」，不声明「测试跑过且绿」。
- 未覆盖的条目及原因：无（SC-1 ~ SC-6 均已核）。SC-4 的「同一会话」结论基于代码路径与假件测试，未在真 Host 上跑 `session/attach`，属运行期行为，静态不可再强化。
- 发现的额外问题（不属本节范围但值得记录）：
  1. 注入 `v21` 后 `handleV21Webhook()`（`apps/server/src/http/webhook-v21.ts:983-1068`）直接接管并 return，`settings.agent.managers` 的管理员判定只存在于旧通道 `apps/server/src/http/webhook.ts:1550`，v2 评论触发不再过这道权限门（改由 FR-2.4 的角色闸门承担）。
  2. v2 把评论消息也落成 `agent_messages.kind='event'`（`apps/server/src/http/webhook-v21.ts:1031`），dispatcher 生成的任务命令统一为 `agent:event`（`apps/server/src/agent/store.ts:328`）；`v21EventOfCommand('agent:event')` 落到 `issues.edited` 兜底（`apps/server/src/app/compose.ts:253-266`），评论事件的真实事件名在这一层丢失（只影响交叉校验与留痕）。
  3. `apps/server/src/app/compose.ts:1166-1181` 的会话交叉校验把 `state` 硬编码 `'active'`、`issueState` 硬编码 `'open'`，与真实值无关，只用于一条 debug 日志。
