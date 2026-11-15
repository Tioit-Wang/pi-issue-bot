# WP4 · 增量投喂（FR-4.2 / BR-4 / SB-4 / FR-4.1）

- 需求原文：`docs/requirements.html:948-951`（FR-4.2）、`:1789`（BR-4）、`:601`（场景 B）
- 结论：首个事件下发全文；后续事件只下发**本轮变更 + 本轮指令**。项目自定义模板写
  `{{issue.content}}` 时行为不变（仍拿全文），平台默认模板分「全文 / 增量」两套。

## 1. 首轮判据：`agent_sessions.turns`

**判据**：`SELECT "turns" FROM "agent_sessions" WHERE repo = $1 AND issue_number = $2`；
行缺失或 `turns <= 0` → 首轮（全文）；`turns > 0` → 后续事件（增量）。

**为什么选它，而不是 `agent_messages` 里有没有 `done` 记录**：

1. **语义就是「历史里有几轮」**：`turns` 由执行面在**一轮真正跑完**之后加一
   （`app/compose.ts`），恰好等于「会话历史里已经有过多少轮对话」。`agent_messages` 数的
   是「投递了几条消息」，一条已入队但还没跑的消息会让判据提前变成「后续轮」——
   那会让 agent 既没有历史、又拿不到全文，是最坏的组合。
2. **与「历史由会话承担」自洽**：若会话被轮换（新会话行、`turns` 归零），本条自动判成首轮
   ——新会话确实没有旧正文历史，必须重新下发全文。任何「按 issue 累计计数」的判据都会在
   轮换后给出错误的「后续轮」。
3. **没有新读路径**：`V21_SESSION_SQL.read` 已在本文件里（会话状态迁移用它），
   不新增 SQL、不新增对 `agent/store.ts` 的依赖（WP2 正在改会话域，避免交叉）。
4. **成本**：一次主键查询，与「读会话状态」同一条索引；判断发生在投递热路径上，
   `agent_messages` 计数（`count(*)`）反而更贵。

**已知取舍**（写进代码注释与本文）：

- 一轮**还没跑完**时到的新事件仍按首轮处理（多给一次全文）。方向是保守的：宁可多给，
  不可让 agent 缺上下文。
- 读库失败 → 按首轮 + 一条 `warn`（`v2.1 首轮判据读取失败：按首轮（全文）投喂`），
  不让投递 500。

## 2. 新增占位符（契约 `PROMPT_PLACEHOLDERS`，12 → 14）

| 占位符 | 取值 | 说明 |
|---|---|---|
| `issue.content` | 全文快照 | **语义未变**（原来是「全文」，现在还是全文） |
| `issue.contentDelta` | 本轮变更 | 首轮恒为空串（**已知但为空**，同 `comment.*` 口径，不是未知占位符） |
| `issue.isFirstEvent` | `true` / `false` | 缺省（调用方没给）按 `true` 渲染 |

`issue.contentDelta` 的取值（`v21ContentDeltaOf()`，只在 `firstEvent=false` 时非空）：

- `issues.edited`：`变更字段：正文` + 正文的**行级增删**（`payload.changes.body.from` 是旧正文）。
  行级差异用多集差（`v21LineDeltaOf()`），只列 `+ 新增行` / `- 删除行`，未改动的行不出现；
  每侧最多 40 行（`CONTENT_DELTA_MAX_LINES`），超出只报行数——不设上限会让「整段重写」
  又把整篇正文带回来，增量投喂就白做了。
- `issues.labeled`：`新增标签：<name>`
- `issues.closed`：`状态：open → closed`
- `issue_comment.created`：空串（评论正文本来就由 `{{comment.body}}` 单独给）
- 缺 `changes`：`变更字段：未知（载荷未提供 changes）`；明写 `changes` 有 `body` 但没给
  `from` 时给「无法列出增删行（需要原文请自己读 issue）」。两种情况都**不崩、不猜**。

## 3. 默认模板改动前后对照

选择发生在 `pickEventTemplate()`（`apps/server/src/http/webhook-v21.ts`）：

1. `firstEvent=true` → `DEFAULT_EVENT_TEMPLATES`（与改造前逐字节相同）；
2. `firstEvent=false` + 项目**自定义**模板 → 项目模板原样使用；
3. `firstEvent=false` + 平台默认 → `DEFAULT_EVENT_DELTA_TEMPLATES`（契约新增）。

判定「平台默认」的等价条件：`decidedTemplate === DEFAULT_EVENT_TEMPLATES[event]`
（`decide.ts` 在项目模板为空时恰好回落到这一串）。**逐字照抄默认模板的项目**因此在后续轮
也会拿到增量模板——这是刻意且已在代码注释里写明：抄的就是平台默认，语义上不是「项目要求全文」。

| 事件 | 改动前（`DEFAULT_EVENT_TEMPLATES`，仍是首轮用的） | 后续轮（`DEFAULT_EVENT_DELTA_TEMPLATES`） |
|---|---|---|
| `issues.opened` | 全文快照 | 不变（opened 只会是首轮） |
| `issues.edited` | 「修改后的正文快照」+ 全文 | 「本轮只给变更」+ `{{issue.contentDelta}}`，**不含** `{{issue.content}}` |
| `issues.labeled` | 标题/标签 + 正文快照全文 | 标题/标签 + `本轮变更：{{issue.contentDelta}}`（新增标签名） |
| `issues.closed` | 收尾复盘 + 正文快照全文 | 收尾复盘（明说「正文历史在会话里，不重复下发」）+ 变更 |
| `issue_comment.created` | 评论正文 + issue 正文快照全文 | 评论正文 + 标题/标签（去掉正文快照） |

`DEFAULT_EVENT_DELTA_TEMPLATES['issues.edited']` 不含 `{{issue.content}}` 这件事由单测钉住
（机械保证「不重复整篇正文」）。

## 4. 改动文件

| 文件 | 改动 |
|---|---|
| `packages/contract/src/settings-v21.ts` | 占位符 12→14；新增 `DEFAULT_EVENT_DELTA_TEMPLATES`、`EventTemplateVariant`；`defaultEventTemplate(event, variant='full')` 保持向后兼容 |
| `apps/server/src/prompt/render.ts` | `RenderContext` 增 `contentDelta` / `firstEvent`；`resolvePlaceholder()` 增两条 case |
| `apps/server/src/http/webhook-v21.ts` | 新增 `v21LineDeltaOf` / `v21ContentDeltaOf` / `v21IsFirstEventOf` / `pickEventTemplate` / `v21TemplateOf(..., variant)`；`v21RenderContextOf` / `buildV21AgentMessage` 接 `firstEvent`；`handleV21Webhook` 读 turns 后传入 |
| `apps/server/test/v21-incremental-feed.test.ts` | **新增** 19 个用例（见下） |
| `apps/server/test/prompt-render.test.ts` | 占位符数量 12→14 + 新占位符取值断言（原断言写死 12，不改必红） |
| `packages/contract/test/settings-v21.test.ts` | 同上：数量与名字清单 12→14（**超出本包文件清单，但契约改了必须同批改，否则 `pnpm -r test` 红**） |

## 5. 测试

新用例（`apps/server/test/v21-incremental-feed.test.ts`，19 个）：

- 行级差异：未改动行不出现；重复行按次数算差；
- `{{issue.contentDelta}}`：首轮空串；`edited` 给字段+增删行；缺 `changes` 不崩；
  `labeled` / `closed` / `comment` 的取值；
- 模板选择：空白 prompt 首轮=全文、后续轮=增量；项目自定义模板两种变体都原样返回；
- 渲染：`{{issue.content}}` 仍全文；首轮 delta 渲染成空串而不是未知；`isFirstEvent`
  缺省为 `true`；
- `buildV21AgentMessage`：首轮含全文 / 后续轮不含全文且含增删行 / 自定义模板写
  `{{issue.content}}` 仍拿全文；
- `v21IsFirstEventOf`：无行 / `turns=0` / `turns>0`；读库失败→首轮 + 1 条 warn；
- 端到端 `handleWebhook()`：同一份 `issues.edited` 载荷，`turns=0` 正文含「正文快照」，
  `turns=2` 正文只有「本轮变更：」，且不含未改动行、无残留 `{{`。

实跑命令与结果：

```
pnpm gen:openapi                     → 9 paths / 51 schemas（本次契约改动不产生 schema 变化；
                                       openapi/pi-bot.openapi.json 生成物里没有 contentDelta/isFirstEvent，
                                       已把该文件还原到改动前内容，避免把其他工作包的在途 schema 混进来）
pnpm --filter @pi-issue-bot/contract typecheck → 通过
cd apps/server; npx tsc --noEmit     → 我改的三个文件 0 错误（仓库其余错误来自并行工作包：
                                       src/runtime/turn-driver.ts、test/queries-deliveries.test.ts）
npx vitest run test/prompt-render.test.ts test/v21-incremental-feed.test.ts \
  test/v21-webhook-integration.test.ts → 3 files / 50 tests 全绿
npx eslint <改动的 6 个文件>          → 无告警
npx vitest run (apps/server 全量)     → 125 files 通过 / 2 failed：
    test/app-wiring.test.ts ④「concurrency_per_repo 生效」
    test/v21-integration.test.ts ②「模板渲染进 agent_messages.comment_body」
```

## 6. 跳过项与残余风险

- **上面 2 个失败不是我引入的**：WP7（执行限额）在 16:25 之后把 `handleWebhook()` 的判定
  换成 `decideV21DeliveryWithQuota()`（`webhook.ts:1199`），日配额靠
  `INSERT INTO "quota_counters" ... RETURNING "count"`；任何**没有**为这条语句返回行的假
  `SqlRunner` 都会拿到 `granted:false` → 判定改成 `daily-quota` → 不入队。
  证据：`test/v21-webhook-integration.test.ts` 在我跑全量时也因同一原因红，随后该文件的假库
  被加上 `quota_counters` 分支就绿了；`test/v21-integration.test.ts` 还没有这个分支。
- `openapi/pi-bot.openapi.json`：按规范跑了 `gen:openapi`（产物 9 paths / 51 schemas）。本次改动
  **不产生** OpenAPI schema 差异（产物里没有 `contentDelta` / `isFirstEvent`）；该文件当前在
  `git status` 里是 M，差异全部来自其他工作包在途的契约（`DeliveriesResponse` 等），
  我没有替其他工作包决定要不要提交这份产物。
  我没有改那两个测试文件（不在 WP4 范围，且正被并行工作包编辑）；我的端到端用例自己处理了
  这条 SQL，所以不受影响。
- 首轮判据依赖 `agent_sessions.turns` 的写入口径（轮完加一）。WP2 正在改会话域隔离，
  若它改了 `agent_sessions` 的主键/隔离列，`V21_SESSION_SQL.read` 的 `WHERE` 需要同批跟随
  （该 SQL 在 `webhook-v21.ts` 内，不在我的改动面上）。
- 并发投递的两次事件都在「上一轮未跑完」时到达 → 两次都按首轮给全文（保守方向，已记录）。
