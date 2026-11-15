# U06 3.4 场景 C：维护者在评论里追问 · B

> 核查范围：docs/requirements.html 行 603-610
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| SC-1 | 已实现 | — |
| SC-2 | 已实现 | — |
| SC-3 | 已实现 | — |
| SC-4 | 部分实现 | 会话在 30 轮 / 7 天后被 `sessionArchive` 归档并新建，不是「永远同一条」 |
| SC-5 | 已实现 | — |
| SC-6 | 部分实现 | 生产装配未接槽位索引，且回退列表只取前 100 条评论 → 老 issue 的同槽位会发成第二条 |

## 逐条

### SC-1
- **状态**：已实现
- **证据**：
  - `apps/server/src/http/webhook-v21.ts:90` — `v21EventKeyOf()` 对 `event === 'issue_comment'` 且 `action === 'created'` 返回 `'issue_comment.created'`（五个 EventKey 之一）。
  - `apps/server/src/http/webhook.ts:555` — 评论分支从载荷读 `payload.comment`（`id` / `body` / `user.login` / `author_association`）与 `payload.issue`（`number` / `state` / `pull_request`）。
  - `apps/server/src/http/webhook.ts:1195` — 注入 `v21` 时先 `decideV21Delivery()` 算判定；`apps/server/src/app/compose.ts:981` 在装配层注入 `v21: { db: pool, … }`，即生产路径启用。
  - `apps/server/src/http/webhook-v21.ts:983` — `handleV21Webhook()` 在触发时 `insertMessage()` 落 `agent_messages` 并 dispatch。
- **判定依据**：接收 → 载荷解析 → v2 判定 → 落消息 + 派发，四段都有执行路径（不是只有类型定义），且 `POST /webhook` 路由本身不按事件名过滤（`webhook.ts:1923`）。
- **反证过程**：先假设「评论事件在 v2 路径上根本没被识别，只是 v0.3 能吃」。查 `v21EventKeyOf` 的 action 分支：`created` 返回非 null；查 `decideV21Delivery` 返回 `TriggerDecision`（非 null）才进 v21 分支（`webhook.ts:1260`）；再查装配是否真注入 `deps.v21` —— `compose.ts:981` 恒注入（`v21RepoIssues` 缺省也不影响 `db`）。三个反证点都过，才推翻「未实现」。

### SC-2
- **状态**：已实现
- **证据**：
  - `apps/server/src/trigger/decide.ts:225` — ② 事件开关：`resolveEventTrigger(...).enabled === 'off'` 直接 `skip(switch-off)`，**在闸门之前**。
  - `apps/server/src/trigger/decide.ts:237` — ④ 评论闸门只在 `event === 'issue_comment.created'` 时执行，位置在开关与附加条件之后、去重/配额之前。
  - `apps/server/src/trigger/decide.ts:173` — 闸门实现：`ignore_bot → allow_closed → require_mention → require_role`，每个拒绝都有独立 reason（`bot-self` / `closed-not-allowed` / `not-mentioned` / `role-denied`）。
  - `packages/contract/src/settings-v21.ts:116` — `allow_closed: z.boolean().default(false)`（默认不响应已关闭 issue）；同处 `108/110/114` 为 `require_mention=true` / `require_role=false` / `ignore_bot=true`。
  - `apps/server/src/trigger/roles.ts:70` — `require_role: true` 但 `allow_roles` 为空 → `{allowed: true}`（放行，不是全拒）。
  - `apps/server/test/trigger-decide.test.ts:111` — 断言「评论事件被关掉时，缺提及也只记 switch-off（不记 not-mentioned）」，即开关优先于闸门的回归测试。
- **判定依据**：需求明写的三个闸门（提及 / 角色 / 已关闭）都有实现且被调用，顺序与 FR-2.4「闸门在事件开关之后」一致，默认值逐项对齐需求表；空清单行为有实现与用例。
- **反证过程**：三个可伪造点逐个打。①「顺序反了」：读 `decideEvent` 函数体顺序（⓪ 验签 → ① 仓库 → ② 开关 → ③ 条件 → ④ 闸门 → ⑤ 去重 → ⑥ 配额），开关行号 227 在闸门行 239 之前，且有用例钉住 switch-off 优先。②「`allow_closed` 默认是响应」：去契约读 default 值（false），再去 `v21-settings.ts:132` 确认闸门取值确实来自 `triggers.events['issue_comment.created'].gates`（不是 `comment` 段），链路成立。③「`require_role: true` + 空清单 = 谁都进不来」：`roles.ts:70` 先返回放行，被推翻。④ 再查「闸门有没有被绕过」：v2.1 分支不经 `submitAgentMessage()`，所以 `isManager` 这条权限不生效（见「额外问题」），但需求 3.4 只要求这三道闸门，闸门本身确实生效。

### SC-3
- **状态**：已实现
- **证据**：
  - `apps/server/src/trigger/mention.ts:50` — `SEPARATOR_CHARS` 是**白名单**（半角标点 + 中文标点），中文汉字不在其中。
  - `apps/server/src/trigger/mention.ts:70` — `isMentionSeparator()`：空串（结尾）或 `\s` 或白名单字符才算分隔符。
  - `apps/server/src/trigger/mention.ts:115` — 关键词命中后 `if (!isMentionSeparator(masked.charAt(end))) continue;`，即 `@机器人你好` 一定不命中。
  - `apps/server/src/trigger/mention.ts:142` — 先 `maskCodeRegions()` 蒙版，代码块/行内代码里的 `@` 不算提及。
  - `apps/server/test/trigger-mention.test.ts:23`、`test/trigger-mention.test.ts:115` — 断言 `@pi-bot帮我看看这条` 与 `@小豆你好` 均不命中，`@小豆 你好` 命中。
- **判定依据**：需求 FR-2.5 的两条（`@` 紧跟关键词、关键词后必须是分隔符）与需求明确点出的「中文不算分隔符」都被实现，且有正向 + 反向用例。
- **反证过程**：假设「用了 `\W` 或「非字母数字即分隔符」的实现，中文会被当成边界」。读实现：不是正则字符类，而是显式集合 + `\s`，中文落在集合外 → 反证失败，实现成立。第二个假设「关键词写成正则，`@机器人` 与 `@机器人2` 前缀冲突」：`matchKeywordAt` 是 slice 逐字符比较 + 分隔符校验，且 `normalizeKeywords` 按长度倒序（`mention.ts:96`），前缀冲突被正确处理。第三个假设「代码块里写 `@pi-bot` 也会触发」：`maskCodeRegions` 在 `mention.ts:142` 先执行，且有用例（`trigger-mention.test.ts:43`）。

### SC-4
- **状态**：部分实现
- **证据**：
  - `apps/server/src/app/compose.ts:423` — `planAgentSession()`：`sessionId` 为空才新建（`persistent`），否则复用并带 `after: cursor`；会话行来自 `loadAgentSession()`，键是 `(repo, issue_number)`（`compose.ts:1157` → `agent/store.ts:152`）。
  - `apps/server/src/app/compose.ts:209` — `AGENT_SESSION_POLICY = { maxTurns: 30, maxAgeDays: 7 }`；`compose.ts:450` 算出 `reason`（`turns` / `age`），`compose.ts:456` 返回 `{ session: { mode: 'persistent' }, rotate: true, archiveSessionId }`（**不带 sessionId = 新会话**）。
  - `apps/server/src/app/compose.ts:1315` — `if (!v21SessionEventActive && agentSession.archiveSessionId !== null) await channel.ops.sessionArchive(...)`：旧会话被归档，本轮新建。
  - `apps/server/src/app/compose.ts:1460` — 队列路径 `onTaskJob` 只传 `taskId` / `attempt`，不传 `sessionEvent` → `v21SessionEventActive` 恒 `false`，所以上面的归档分支在**生产队列路径上真的会执行**。
- **缺口**：缺子条件「同一 issue 永远同一条会话」。正常复用成立（同一 `AgentSessionRow` → 同一个 RACP `sessionId`），但第 31 轮或第 8 天起 `.sessionArchive` + 新建会话，与需求 `docs/requirements.html:609`「会话必须是同一条」相反；若按 FR-3.4「创建后一直有效，不归档」判，这一段是明显冲突（冲突行：`apps/server/src/app/compose.ts:209`、`compose.ts:456`、`compose.ts:1315`）。
- **判定依据**：主体（评论事件进入已有会话、按 `(repo, issue)` 一对一）有完整执行路径，故不是「未实现」；但轮换会在中途换掉会话，且该分支在队列路径生效，故不能判「已实现」。
- **反证过程**：假设「评论事件被当成新会话」。逐条查：会话键含 `issue_number`（`agent/store.ts:152` 的 `WHERE "repo"=$1 AND "issue_number"=$2`），`planAgentSession` 在 `sessionId` 非空时走 `reuse` → 反证失败，复用成立。再假设「轮换只是死代码」：查 `archiveSessionId` 的使用点，唯一闸门是 `v21SessionEventActive`，而该变量只在 `executeTask({ sessionEvent })` 时置 true，队列 job（`compose.ts:1460`）不传 → 轮换**活着**。B 视角据此从「已实现」下调为「部分实现」。

### SC-5
- **状态**：已实现
- **证据**：
  - `apps/server/src/prompt/render.ts:153` — `case 'comment.author'` / `comment.body` 从 `ctx.comment` 取值。
  - `apps/server/src/http/webhook-v21.ts:326` — 载荷有 `comment` 对象时填 `comment: { author: comment.user.login, body: stripAliasMentions(comment.body, aliases) }`。
  - `packages/contract/src/settings-v21.ts:428` — 占位符清单注册 `comment.author` / `comment.body`，可用事件标为「评论」；内置默认模板 `settings-v21.ts:536`、`settings-v21.ts:538` 真的用了这两个占位符。
  - `apps/server/src/http/webhook-v21.ts:1007` — 渲染结果作为 `insertMessage().body` 落 `agent_messages.comment_body`；`apps/server/src/app/compose.ts:1236` 起把这条消息拼进本轮 `prompt`（`## 这一条消息`）。
  - `apps/server/src/prompt/render.ts:129` — 非评论事件时 `comment.*` 是「已知但为空」→ 渲染空串而不是未知占位符（不产生 unknown 告警）。
- **判定依据**：两个占位符既有取值实现，又在评论事件下真的被填值、真的进入发给 agent 的提示词；非评论事件下的行为也符合需求 6.3「可用事件 = 评论」。
- **反证过程**：① 假设「占位符存在但取值永远空」：追取值链 `v21RenderContextOf` → `renderTemplateAsync` → `resolvePlaceholder`，`comment` 只在载荷有 `comment` 时注入，评论事件必然有；且 `comment.body` 经 `stripAliasMentions` 摘掉 `@别名`（避免把噪声传进去）。② 假设「渲染了但没进提示词」：追 `build.text` → `insertMessage(body)` → `compose.ts:1236` 的 prompt 拼接，链路完整。③ 假设「全局可写导致别的事件渲染成空串＝缺陷」：需求 6.3 明确标「可用事件：评论」，空串是该事件的正确表现，不算缺口。

### SC-6
- **状态**：部分实现
- **证据**：
  - `packages/envelope/src/v21.ts:294` — `comment` 动作 `slot` 必填（`SLOT_PATTERN`），槽位名由执行侧声明。
  - `apps/server/src/writeback/v21/comments.ts:44` — 标记正则含 `:slot`；`comments.ts:86` — 「同槽位」判定按 `(repo, issueNumber, slot)` 三元组比较（repo 大小写归一），**只按名字隔离**，不同名字互不影响。
  - `apps/server/src/writeback/v21/execute.ts:627` — `historyCommentId = input.slotStore === undefined ? null : await input.slotStore.get(...)`；`execute.ts:630` — 索引为空时回退 `findSlotComment(await input.api.listIssueComments(...), marker)`。
  - `apps/server/src/writeback/v21/execute.ts:228` — `slotStore` 是可选端口；`apps/server/src/http/webhook-v21.ts:627` — `V21ExecuteContext` 里**没有** `slotStore` 字段，`createV21Executor` 也无法透传。
  - `apps/server/src/app/compose.ts:836`、`compose.ts:1401` — 两处 v2.1 装配（`createV21Executor` 与 `runTask` 的 `v21` 配置）都没有 `slotStore`；全仓 `apps/server/src` 无 `comment_slots` 的写语句（只有 `db/schema.ts:765`、`migrations/0011_v21.sql:30`）。
  - `apps/server/src/github/octokit.ts:222` — `listIssueComments` 单次请求 `per_page: 100`，**不分页**。
  - `apps/server/src/skills/prompt.ts:364` — 提示词里 `comment` 动作样例固定写 `slot:"result"`（`issues.opened` 与 `issue_comment.created` 看到的是同一份样例）。
- **缺口**：需求 `docs/requirements.html:1032`「同一 issue 上同一槽位只保留一条」在两种情况下不成立：① 槽位索引 `comment_slots` 在生产装配里没有写入方（`slotStore` 未接，`V21ExecuteContext` 也没这个字段），只剩「按标记翻列表」一条路；② 翻列表只取前 100 条评论，槽位评论落在第 101 条之后时会「找不到 → 新建」，于是同槽位出现第二条。按名字隔离本身是对的（不同 slot 互不影响），故不是「未实现」。
- **判定依据**：槽位键与标记机制完整且被 `planSlotWrite` 消费，但「一槽一条」的持久化快路径未接、回退路径有上限，属缺子条件。
- **反证过程**：① 假设「所有评论共用一个槽位，会互相覆盖」：读 `isSameSlot`（需 `slot` 相等）与 `comment_slots` 主键 `(repo, issue_number, slot)`，名字不同即不同槽位 → 反证失败，「按名隔离」成立。② 假设「槽位索引在生产里也生效」：全仓搜索 `slotStore` 的赋值点，只有 `apps/server/test/writeback-v21-execute.test.ts:414` 一处；`createV21Executor` 的 options 与 `V21ExecuteContext` 都没有该字段 → 索引在生产永远是 `undefined`，`comment_slots` 是「有表无写者」。③ 假设「回退路径总能找回旧评论」：`octokit.ts:222` 无 `Link` 分页处理，`per_page` 固定 100 → 长 issue（本仓 issue #1942/#1950 量级）上会新建重复评论。④ 关于「与场景 A 是否不同槽位」：平台按需求不预设槽位名（`requirements.html:1028`），但提示词样例只给 `result`（`skills/prompt.ts:364`），A 与 C 极可能都写 `result` 而互相覆盖——这是配置/提示词层面的风险，不是判定层的违规，列入「额外问题」。

## 本节整体结论
场景 C 的主链路成立：`issue_comment.created` 能被接收、按「开关 → 条件 → 四闸门」顺序判定、合法提及（分隔符白名单，中文不算）与默认「不响应已关闭 issue」都生效，两个评论占位符真的进了发给 agent 的提示词。不能判本节「已实现」的原因有两个：会话在第 31 轮 / 第 8 天会被 `sessionArchive` 归档并新建会话，与「必须是同一条会话」相反且该分支在队列路径生效；槽位索引在生产装配里没有写入方，回退又只翻前 100 条评论，「同槽位只保留一条」在最需要它的长 issue 上不成立。

## 核查边界
- 是否执行了命令：未执行测试。仅执行只读检索（`git status --short`、`Select-String` 在 `apps/`、`packages/`、`docs/requirements.html` 上取行号与片段、`Get-ChildItem` 列 `apps/server/src` 与 `apps/server/test` 文件名）。**未跑 `pnpm -r test` / `typecheck`**，所有「测试」结论只声明「存在且断言具体」，不声明「跑过且绿」。
- 未覆盖的条目及原因：
  - SC-1 的端到端（真实 GitHub 投递 → HTTP → 队列 → RACP 会话）需 PG + 队列 + Docker + 真模型，未跑。
  - SC-4 的「同一 sessionId」需真 RACP host 才能看到会话 id 复用，静态只能追到 `planAgentSession()` 的 `persistent + sessionId`。
  - SC-6 的实际覆盖/新建行为需真 GitHub（>100 条评论的 issue），未验证。
- 发现的额外问题（不属本节范围但值得记录）：
  1. **v2.1 评论分支绕过管理员权限**：`webhook.ts:1260` 命中 `handleV21Webhook` 后直接返回（`1260-1287`），不再走 `submitAgentMessage()` 的 `isManager`（`webhook.ts:1548`），所以非 `settings.agent.managers` 的人 @ 也能触发一轮（仅受 `require_role` 约束）。与 v0.3「@ 仅管理员」的口径不一致。
  2. **`PI_BOT_FREE_MENTION=false` 在 v2.1 路径不生效**：该开关只在 `decideWebhookTask()` 里判（`webhook.ts:598`），而 v2.1 分支用 `v21Decision`（`webhook.ts:1255`），不看 `decision.freeMention`。
  3. **v2.1 提及关键词只认 `settings.comment.mentions`**（`v21-settings.ts:159`），部署级 `PI_BOT_MENTION`（`apps/server/src/app/config.ts:408`）只用于 v0.3 与摘别名；App slug 不是 `pi-bot` 且项目没配关键词的部署，`@真实句柄` 不会触发。
  4. **提示词样例只给 `slot:"result"`**（`skills/prompt.ts:364`），`issues.opened` 与 `issue_comment.created` 共用，两个场景的结论会互相覆盖（需求不禁止，但与「各自一条」的预期不符）。
