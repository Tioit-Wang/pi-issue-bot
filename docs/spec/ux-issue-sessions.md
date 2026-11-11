# UX 重构：按 issue 的会话视图（调研 + 契约）

> 状态：v1（PM 定稿，2026-11-10）。**本文件是这次重构的唯一事实源**，与 `contract-api.md` 冲突时以本文件为准（改完回填 `contract-api.md`）。
> 涉及需求：R1 回执改评论级表情 + 完成后 @ 提问者；R2 回复里不出现任务编号；R3 面板新增 issue 会话视图；R4 面板只读。

## 1. 现状调研

### 1.1 面板（`apps/panel`）

- 技术栈：React 19 + Vite 8 + Tailwind 4 + TanStack Query/Table + react-router 8；`main.tsx` 用 `BrowserRouter`，测试用 `MemoryRouter`。
- 路由在 `src/routes.tsx` 的 `PANEL_ROUTES` **一处冻结**（7 条：`/`、`/tasks`、`/tasks/:id`、`/costs`、`/quality`、`/audit`、`/system`）。加页面只改这个数组。
- 数据层：`src/lib/api.ts`（`api.overview/tasks/taskDetail/costs/reverts/audit/system`）、`src/lib/queries.ts`（`useOverview/useTasks/...`，轮询间隔 `overview 10s / list 15s / detail 5s`）、`src/lib/contract.ts`（类型从 `packages/contract` 的 zod 取）。
- 呈现组件：`components/AsyncSection.tsx`（四态：loading/error/empty/content）、`components/ui/*`、`components/tables/DataTable.tsx`、`components/charts/*`。
- **当前没有任何输入框**（`<textarea|<input` 在 `routes/**` 里 0 命中）→ R4「不允许直接对话」现状已满足，新页面同样不得引入 composer。
- 页面基线都是「列表 + 筛选 + 游标分页」或「详情 + Tabs」，还没有任何**会话 / 时间线**形态的页面。

### 1.2 HTTP 只读接口（`apps/server/src/http/api/index.ts`）

现有 7 条（契约 `contract-api.md`）：`/api/overview`、`/api/tasks`、`/api/tasks/:id`、`/api/costs`、`/api/quality/reverts`、`/api/audit`、`/api/system`（+`/healthz`、`/metrics` 独立端口）。
**没有**「按 issue 聚合」的接口 —— 这是本次新增的两条。

### 1.3 数据现状（真库实测，`pi_issue_bot`）

| 表 | 关键列 | 对本需求的用处 |
|---|---|---|
| `tasks` | `repo,target_kind,target_number,command,actor_login,prompt_text,delivery_id,queued_at,status` | 一条 = 一次「人类触发」；`prompt_text` 是自由提问正文，`command` 是 `/命令` 或 `@answer` |
| `webhook_deliveries` | `delivery_id, event, action, payload(jsonb), received_at` | `tasks.delivery_id` join 它可拿到**人类评论原文、作者、评论 html_url** |
| `runs` | `task_id, attempt, session_id, turn_id, started_at, ended_at, outcome, failure_class, failure_detail` | 每个任务的执行结果（`succeeded/failed/timed-out…`） |
| `run_events` | `run_id, cursor, kind, payload(jsonb)` | **`kind` 是 pi-host 原始事件名**（实测：`item.delta/item.completed/item.started/tool.progress/turn.activity/approval.*/sandbox.inspected/writeback.fallback`），**不是** contract 的 `RUN_EVENT_KINDS` |
| `envelopes` | `run_id, verdict(jsonb), actions(jsonb), usage, valid, errors` | 机器人**要发什么**（`actions[].body` 就是最终回复正文） |
| `actions` | `run_id, intent, target, external_ref, applied_at, revert_kind, audit` | 机器人**实际做了什么**；**没有正文列**（要正文得回查 `envelopes.actions`） |
| `bot_labels` | `repo, issue_number, label, applied_at, removed_at` | 打过哪些标 |

实测坑（务必按此实现）：
1. `run_events.kind` 存的不是契约枚举值。工具调用取 **`tool.progress`**（另有 `item.started/item.completed` 可作补充），**不要**按 `'tool-call'` 过滤（永远 0 行）。
2. `actions` 没有 `body` 列，且当前几乎为空（只有 `intent='fallback'` 两行）。机器人回复正文的事实源是 `envelopes.actions`。
3. 同一 issue 会有多条 `tasks`（多次提问 / 多次命令），`target_kind` 可能是 `issue` 也可能是 `pr` —— 会话视图按 `(repo, target_kind, target_number)` 聚合，`target_kind='pr'` 单独展示。
4. `webhook_deliveries.payload` 是 `jsonb`。**不要**在面板接口里 `jsonb` 深挖整份 payload（契约 §8.3 禁止解 jsonb 的既有约定对「对话正文」放宽一次：只取 `payload.comment.body/html_url/user.login` 与 `payload.issue.title/html_url/state` 这几个键）。

### 1.4 回执与回复（**已落地**，2026-11-10 实测通过）

- 入队后 eyes reaction 打在**触发的那条评论**上（`POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions`）；
  `WebhookTaskPlan.commentId` 从 `issue_comment` 载荷取，issue 级事件（`issues.opened`）为 `null` 时回落 issue 级。
- 回执文案里的任务编号已删净（用户可见文案不再出现内部 id）；`git/commit-tree.ts` 的提交主题仍带
  `<intent> / <taskId>`，那是分支内的审计信息、不是给用户的回复，**保留**。
- 最终回复 = 信封 `actions[].body`，写回时由 `worker/writeback.ts::withMention()` 加 `@<tasks.actor_login>` 前缀
  （已以 `@…` 开头则不重复）。实测：`#17` 上 `@pi-issue-bot-tioit 用一句话说明这个仓库是做什么的。`
  → 评论级 eyes + 一条署名 `@Tioit-Wang` 的回答，无回执评论、无任务编号。
- 去重也要有回执：同一句话换条评论再问，会走「任务级幂等」分支，该分支现在同样打 eyes
  （否则用户看到的是「@ 了但毫无反应」）；自由问答的幂等键含**评论 id**，所以换个评论问同一句话会重新回答。

### 1.5 GitHub 侧事实（回答「为什么 @ 不到 bot」）

实测结论（同一 issue 连续投三条探测评论，取 REST `application/vnd.github.html+json` 的 `body_html`）：

| 写法 | 渲染结果 |
|---|---|
| `@torvalds` / `@Tioit-Wang` | `<a class="user-mention">` 链接 ✅ |
| `@github-actions[bot]` | 纯文本 ❌ |
| `@pi-issue-bot-tioit` / `@pi-issue-bot-tioit[bot]` | 纯文本 ❌ |
| `@dependabot[bot]` / `@coderabbitai[bot]` / `@renovate[bot]` | `@dependabot` 被链接到 **org/user**，`[bot]` 留作纯文本 |

`GET /users/pi-issue-bot-tioit` → **404**；`GET /users/pi-issue-bot-tioit%5Bbot%5D` → 200，`type: "Bot"`。
结论：**GitHub 的 mention 解析只认真实 user/org 账号，`xxx[bot]` 不是可 mention 的实体**（dependabot 那几个之所以「看起来能 @」是因为存在同名 org/user）。所以：
- App bot **不会**出现在 @ 自动补全里，写了也不会变蓝、不会发通知；
- 但它照样能收到 `issue_comment` webhook（评论创建事件与 @ 无关），**功能路径是「webhook 正文里做字符串匹配」**，我们已经是这么做的；
- 因此 R1 的「@ 该用户」是**我们去 @ 人**（人可被 @），不是等人 @ 我们。
- 用户侧要能「看起来 @ 到我们」，只能：① 用 `/命令` 或直接提问（无需 @）；② 若必须视觉上一蓝，就再注册一个同名 org/user 占位（像 dependabot），**不是**本次范围。

## 2. 需求与验收

| 编号 | 需求 | 验收（实测） |
|---|---|---|
| R1 | 收到 @（或命令）后，在**该条评论**上加 `eyes` reaction；处理完成后以 `@<提问者>` 开头回复结果。**回执仍是 reaction、不回评论**（本行语义不变）；固定流水线的阶段业务通知是**另一条通道**，它是评论（下方两栏写明边界） | 在测试仓库发一条 `@… 问题`：`GET /repos/{o}/{r}/issues/comments/{id}/reactions` 里有 `eyes` 且 `user.login='pi-issue-bot-tioit[bot]'`；最终评论以 `@Tioit-Wang` 开头。另验：不合规 issue 会收到阶段 0 的**一条**评论，且该评论属于阶段业务通知（不是回执） |
| R2 | 任何面向用户的回复/评论都**不出现任务编号** | 全仓 grep 用户可见文案无 `taskId`/`（任务 …）`；实测评论里没有 8 位 id |
| R3 | 面板新增按 issue 的视图：列表（处理过/回复过/打过标的）+ 点进去看会话（人问 AI 答，多轮）+ 侧栏（做了什么 / 结果） | `http://localhost:5173/issues` 能看到真库里的 `#17`；点进去看到至少 2 轮问答；工具调用默认折叠，可展开 |
| R4 | 面板只读，不提供对话入口 | 新页面无 `<input>/<textarea>/<button>发送`；接口全是 GET |

### 2.1 两条通道分开写（2026-11 落地，别混）

| | 回执通道（有 `@` 就有） | 阶段业务通知通道（固定流水线专有） |
|---|---|---|
| 载体 | **reaction**，不发评论 | **评论**（AI 自由撰写，无服务端模板） |
| 打在哪 | 触发的那条评论（issue 级事件回落到 issue 主贴） | issue 主贴 |
| 时机 | 入队 `eyes`；终态 `-eyes` + `rocket`/`confused` | 阶段结论产生时 |
| 内容 | 无正文 | 格式不通过缺什么、复查通过确认、分类结论（含 `@managers`）、未 ready 时被拦下的回执 |
| 频率 | 每任务一次 | 按阶段幂等键去重；门禁回执每 issue 每小时 1 条 |
| 事实源 | `issue_feedback` | `envelopes.actions`（正文）+ `actions`（审计） |

一句话记法：**「我收到了」用 reaction，「流程走到哪一步 / 结果是什么」用评论**。回执永远不占评论，阶段通知永远不是回执。阶段侧状态机与文案规则见 `docs/impl-fixed-pipeline.md` §3。

## 3. 新增接口契约（R3）

两条 GET，前缀 `/api/issues`，鉴权沿用 `requireAuth`（本机 `PI_BOT_PANEL_AUTH=off`）。

### 3.1 `GET /api/issues`

查询参数：`repo?`（`owner/name`）、`kind?`（`issue|pr`，默认 `issue`）、`limit?`（1..100，默认 30）、`cursor?`（不透明字符串）、`q?`（标题/编号模糊，可选）。

```jsonc
{
  "generatedAt": "2026-11-10T08:00:00.000Z",
  "issues": [
    {
      "repo": "Tioit-Wang/pi-issue-bot-test",
      "kind": "issue",
      "number": 17,
      "title": "…",                       // 取不到就 null
      "url": "https://github.com/.../issues/17",  // 取不到就 null

      "state": "open",                    // open|closed|unknown
      "lastActivityAt": "…",              // max(最后一条 task.queued_at, 最后一件 action.applied_at)
      "humanTurns": 4,                    // 人类触发次数（tasks 行数）
      "botTurns": 3,                      // 机器人发言/动作次数（actions 行数，含 label）
      "labels": ["bug", "needs-info"],    // bot_labels 里未移除的
      "outcomes": { "succeeded": 2, "failed": 2 },
      "lastPreview": "回答正文前 120 字"   // 取最后一条机器人正文，取不到用最后一条人类问题，再取不到 null
    }
  ],
  "hasMore": false,
  "nextCursor": null
}
```

**（v2 增补，2026-11-10）列表行还带 4 个派生字段**，全部由服务端算好，面板不再自己拼：

| 字段 | 含义 / 取法 |
|---|---|
| `lastReplyAt` | 最后一条机器人回复时间：`actions.intent in ('comment','fallback')` 的 `applied_at` max。dry-run 不写 `actions` → `null`（面板按「未知」显示） |
| `lastActorLogin` / `lastActorKind` | 最后一次在 issue 里说话的人：取该 issue **最新一条 `issue_comment` 投递**的 `payload.sender`；`type==='User'` → `human`，其余 → `bot`，`sender` 缺失 → `null`（**不要**默认成 bot） |
| `awaitingReply` | **我方欠一个回答**：`state==='open'` ∧ `lastActorKind==='human'` ∧（`lastReplyAt` 为空 ∨ 早于他这次发言）。`state` 非 `open`（含 `unknown`）一律 `false` |

**查询参数（v2）**：`status=running|queued|failed|answered|idle`（优先级与面板 `deriveStatus` 逐条一致）、
`state=open|closed|unknown`、`awaiting=true`。三者都在 `agg` 之后过滤（`state` 由投递派生，走不上索引）。

**为什么不用 `issue_states.last_human_reply_at`**：那是 close-gate 的「人欠机器人信息」（needs-info 关闭闸门），
方向相反，而且当前没有任何写入点（恒 NULL）。两条链不交叉。

- 排序：`lastActivityAt` 降序。游标：`base64url(lastActivityAt + '|' + repo + '#' + kind + number)`，服务端按 `(lastActivityAt, repo, number)` 严格小于游标继续。
- 聚合口径：先按 `tasks` 分组出 `(repo,target_kind,target_number)`（**只出现有人类触发过的**），再左连 `actions`/`bot_labels`/`runs`。
- `title/url/state`：从该 issue **最新一条** `tasks.delivery_id → webhook_deliveries.payload` 里取 `issue.title/html_url/state`；没有则 `null`/`"unknown"`。

### 3.2 `GET /api/issues/:repo/:kind/:number`

`repo` 含 `/`，路由里用 `:repo` 会吞斜杠 —— **路径写成 `/api/issues/:owner/:name/:kind/:number`**（四段），或接受 `repo` 走 query。**选定：`/api/issues/:owner/:name/:kind/:number`。**

```jsonc
{
  "generatedAt": "…",
  "issue": { "repo": "…", "kind": "issue", "number": 17, "title": "…", "url": "…", "state": "open",
             "labels": ["bug"], "participants": ["Tioit-Wang", "pi-issue-bot-tioit[bot]"] },
  "turns": [
    // 人类：一次任务 = 一轮
    { "id": "task:8f3c…", "role": "human", "login": "Tioit-Wang",
      "at": "2026-11-10T07:13:40.866Z", "channel": "mention",   // mention|command|auto
      "text": "这个 EACCES 报错一般是什么原因？", "commentUrl": "https://…/#issuecomment-…",
      "toolCalls": [], "status": "succeeded" },                 // status 是该任务的 run 结果
    // 机器人：一次 run 的产出（comment / label 合并到同一轮）
    { "id": "run:9a1b…", "role": "bot", "login": "pi-issue-bot-tioit[bot]", "at": "…",
      "text": "……回答正文……",            // envelopes.actions 里 intent=comment 的 body；没有则 null
      "commentUrl": "…",                  // actions.external_ref
      "labels": ["bug", "needs-info"],    // 本轮打的标（actions intent=label）
      "status": "succeeded",              // runs.outcome
      "failureClass": null,
      "taskId": "8f3c…",                  // ⚠仅接口字段，**不得**出现在任何 GitHub 评论里
      "toolCalls": [ { "name": "read/fetch-spans", "summary": "读 src/a.ts", "at": "…", "ok": true } ] }
  ]
}
```

- `toolCalls`：从该 run 的 `run_events` 里取 `kind='tool.progress'`（并可含 `item.started/item.completed`），`name` 取 `payload.name|payload.tool|payload.title` 中第一个字符串，`summary` 取 `payload.summary|payload.detail|payload.text` 前 160 字，`ok` 取 `payload.ok ?? payload.success ?? true`；**排序按 `cursor`**；单轮最多 50 条，超出置 `truncated: true`（放 `toolCalls` 同级字段）。
- 404：`(repo,kind,number)` 没有任何 `tasks` 行 → `not-found`。
- 轮次排序：`at` 升序；`at` 相同则人类在前。

## 4. 文件所有权（session 之间零重叠）

| 归属 | 文件 |
|---|---|
| S-A（API 数据面） | `packages/contract/src/{api,schemas,index}.ts`（新增 issue 相关 schema/类型）、`apps/server/src/queries/issues.ts`（新）、`apps/server/src/queries/index.ts`（挂 `issues`/`issueSession`）、`apps/server/src/http/api/index.ts`（注册两条路由）、`apps/server/test/queries-issues.test.ts`（新）、`docs/spec/contract-api.md`（回填两节） |
| S-B（面板） | `apps/panel/src/routes/issues.tsx`（新）、`apps/panel/src/routes/issue-detail.tsx`（新）、`apps/panel/src/routes.tsx`（加两条 route：`/issues`、`/issues/:owner/:name/:kind/:number`）、`apps/panel/src/lib/{api,queries,contract}.ts`、`apps/panel/src/mocks/handlers/{issues.ts,index.ts}`、`apps/panel/src/routes/__tests__/issues.test.tsx`（新） |
| PM（主会话） | `apps/server/src/http/webhook.ts`（回执改评论级、去任务编号）、`apps/server/src/github/*`（reaction 到评论）、`apps/server/src/worker/writeback.ts`（回复加 @ 提问者，**等 f45d1951 收工后**）、`docs/plan.md`、本文件、`git` 操作 |

门禁（**串行**跑，并行会假失败）：`pnpm -r typecheck`、`pnpm -r test`、`pnpm lint`，三者都要 exit 0（失败只准落在他人文件时点名，不许改他人文件）。
sessions 禁止：`pnpm add/install`、`git add/commit/push`、改 `docs/plan.md` / `docs/tech-plan.md` / 本文件的「契约」章节以外的部分。

## 5. 设计要点（R3 的呈现）

- 一个 issue = 一个 session。**视觉对齐 PI-Desktop 的会话消息列**（`apps/desktop/src/styles/messages.css` +
  `chat-shell.css`，即用户说的 ailistmessage 观感），规则如下（已落地，改样式时按此为准）：
  - 行：`flex`、行间距 12px、上下内边距 12px（`py-3`）；不再用卡片包住整轮。
  - **人类**：右对齐（`justify-end`）、shrink-wrap 气泡，宽度上限 `min(82%, 600px)`；
    圆角 18px、**右下角 4px**（`rounded-[18px] rounded-br-[4px]`）；底色是前景色 8%
    （`bg-foreground/[0.08]`，等价 PI-Desktop 的 `color-mix(in oklab, var(--ds-text-primary) 8%, transparent)`）；
    内边距 `10px 15px`；正文 15px / 行高 1.65、`whitespace-pre-wrap`。
  - **机器人**：左对齐、**纯正文**——无气泡、无边框、无底色、无内边距，行宽上限 720px（`max-w-[45rem]`）；
    正文与人类同一套字号行高。
  - 元信息（login / 渠道 / status / 时间）是一行 11px 的 muted 文本，不再挂「人类/机器人」徽章：
    角色由对齐方式表达（与 PI-Desktop 一致）。
  - **工具调用**是安静的一行：`▸ 工具调用（N）`，透明底、hover 才提亮、默认收起；展开后是紧凑表
    （名字/摘要/时间/ok），无表头底色与竖线，摘要单行截断。折叠区内**不放 `item.delta` 原始流**。
  - 右侧栏「本轮详情」保持 `lg` 以上 sticky、窄屏置顶；卡片降噪（`shadow-none`、浅底）。
- 右侧栏（≥lg 断点固定，窄屏为顶部折叠块）：「做了什么」（本轮 actions：评论/标签/推送，按 `intent` 分色）、「结果」（outcome、failureClass、耗时、成本、任务链接 `/tasks/:id`）、「标签变更」（`bot_labels`）。
- 列表页：每行 `repo#number 标题`、状态 chip、`humanTurns/botTurns`、最后活跃相对时间、最后一条预览（一行省略号）。点击进详情。
- 只读：整个新视图只有导航与展开/折叠交互，**没有输入框、没有发送按钮**。

### 5.1 列表页 `/issues`（2026-11-10 改版，按三个评审 session 的结论收敛）

**这一页要回答的是「有没有事等我」**，不是「有多少轮对话」。真数据验证过旧版的失败：
18 条里 14 条显示「人 0 · 机 0」、预览 `—`，而后台其实是 `failed:1` —— 最要紧的失败完全看不见。

- **每行三层**（对齐 PI-Desktop 的会话行：13px 标题 + 11px muted 时间，行高紧凑、无分隔线）：
  1. `7px 色点（ring 3px / 15%）` + **标题**（单行 truncate）+ **相对时间**（右对齐、常显）。
  2. **派生状态词**（进行中/失败/已回复/已排队/无结果）· `repo#number`（单仓库时省略 owner）·
     `open/closed` chip · `待人回答` chip · `状态可能过期` · `人 N · 自动 M · 机 K` · 标签 chips。
  3. **预览**（11px 单行，带 `机：`/`人：` 来源前缀；`null` 显示 `—`）。
- **派生状态**只在面板算，不改契约：
  `running>0 → 进行中`；`queued>0 → 已排队`；`failed>0 且 succeeded===0 → 失败`；
  `succeeded>0 → 已回复`；否则 `无结果`。「曾经成功、后来某次失败」**不**判整行失败。
- **待人回答** = `humanTurns>0 && botTurns===0`（人说过话、机器人一个字没说）。
- **按本地日历日分组**：今天 / 昨天 / 更早，组标题带条数（`今天 · 12`）；组内仍按 `lastActivityAt` 倒序，
  **不把运行中置顶**（插队会毁掉「刚发生」的语义）。
- **顶部摘要**：`已加载 N · 进行中 X · 失败 Y · 待人回答 Z`（只统计已加载页，措辞如实说「已加载」）。
- **筛选**：`repo` + `kind`（Issue / Pull request）。`kind` 是本次补上的缺口——契约 `kind` 默认 `issue`，
  旧版没有这个筛选，PR 会话根本进不来。
- **空态分两种**：无筛选 → 「还没有处理过的 Issue 会话 + 触发方式 + 去系统页确认」；
  有筛选 → 「当前筛选下没有会话」+ 清除筛选。**都不给按钮式写操作**。
- 分隔线不用 `border`，改用 `gap-px` + `rounded-[10px]` hover 底（PI-Desktop 的做法）。
- **不要做**（评审判定「最容易被人顺手加上」的三类）：① 行内「重跑 / 再问一次 / 重新打标」按钮（本质是 POST）；
  ② 标题/全文搜索框（契约没有 `q`，标题只在 jsonb）；③ 把 chip 做成可写（点标签打标、右键认领、已读状态写 URL/localStorage）。
- 空态/错误/加载沿用 `AsyncSection` 的四态 id 约定：`issues-{loading,error,empty,content}`、`issue-detail-{loading,error,empty,content}`。
- 轮询：列表 `15s`、详情 `5s`（复用 `REFETCH_INTERVAL.list/detail`）。

- **待人回答 = 服务端 `awaitingReply`**（`state='open'` ∧ 最后一条 `issue_comment` 的 `sender.type='User'` ∧
  `lastReplyAt` 为空或早于他这次发言）。**不要**用「`humanTurns>0 && botTurns===0`」当代理：
  `botTurns` 数的是 `actions` 行数，机器人发过评论但没写 `actions` 时会被误判成「没回答」（真数据里的 #16）。

## 6. 已知道路风险


1. `gh webhook forward` 进程会僵尸（转发静默失效，DB 里 `webhook_deliveries` 不再增长）。R1 的实测前先确认投递在增长。
2. App bot 不可被 @（§1.5）。测试「@」触发时，正文里写 `@pi-issue-bot-tioit` 即可命中我们的字符串匹配，不必是蓝色链接。
3. 本机 `PI_BOT_PANEL_AUTH=off` 只对 loopback 生效；新增接口必须走 `requireAuth`，不要另开后门。

## 7. 列表查询的索引（dev 库已直连建好，**不在 migrations 里**）

2026-11-10 按数据面评审（L-B）用 `EXPLAIN (ANALYZE,BUFFERS)` 的证据，在**本机 dev 库 `pi_issue_bot` 直接建了 4 条索引**
（用户明确：开发环境不做迁移，直接覆盖）。生产/新环境要复现时，把下面这段原样跑一遍：

```sql
create index if not exists webhook_deliveries_repo_received_idx
  on webhook_deliveries (((payload -> 'repository' ->> 'full_name')), received_at desc);
create index if not exists tasks_target_activity_idx
  on tasks (repo, target_kind, target_number, queued_at desc) include (source, status);
create index if not exists runs_task_recent_idx
  on runs (task_id, attempt desc, ended_at desc);
create index if not exists actions_run_reply_idx
  on actions (run_id, applied_at desc) include (intent) where applied_at is not null;
```

- **为什么第一条最重要**：`webhook_deliveries` 是唯一无限增长的表（90 天保留），旧计划里它吃掉 85% buffer。
- `bot_labels` 不用新建：既有的 `bot_labels_active_uidx (repo, issue_number, label) where removed_at is null` 已覆盖。
- 当前 dev 库只有几十行，规划器仍会选 seq scan（成本更低），这**不是**索引失效；
  用 `set enable_seqscan=off` 可以验证四条都被选中（`webhook_deliveries_repo_received_idx` / `tasks_target_activity_idx` /
  `runs_task_recent_idx` / `actions_run_reply_idx`，其中 `runs_task_recent_idx` 在会话详情里已被实际使用）。
