# Issue 工具面 v3 · 设计与选型（调研稿）

> 状态：方案已确认，**工具面与提示词已落地**（见 §11 实施记录）；写回执行器与读通道按 §7 分期继续。
> 目标：把 issue 全套操作（列表 / 读正文 / 贴表情 / 贴标签 / 评论 / 回复评论 / 给评论贴表情 / 提及 issue 或 PR）做成 agent 能用的工具。

## 0. 一句话结论

不引入新的 GitHub SDK —— **Octokit 就是官方 SDK，已经在我们依赖里**（`octokit@5.0.5` + `@octokit/auth-app@8.3.1`），缺的不是 HTTP 客户端，而是「工具面 + 通道 + 治理」。

而且必须**读写分治**：

- **写**继续走信封动作（在 `packages/envelope/src/v21.ts` 的七类动作上扩 payload），由平台执行，过写回闸门 / 槽位覆盖 / 去重标记 / 配额 / 审计；
- **读**现在**一条通路都没有**，只能靠「预取上下文」（无协议改动）+「只读工具轮」（多 turn）补，因为 RACP 的 `tools/advertise` 通道当前不存在。

---

## 1. 现状（每条都有代码坐标）

| 能力 | 现状 | 证据 |
|---|---|---|
| 工具名清单 | 16 个 issue 工具已冻结（读 4 / 检索 1 / 写 10 / 关联 1），是工具名的唯一事实源 | `packages/contract/src/issue-tools.ts` §3 |
| 能不能真调到 | **不能**：`EXECUTE_CHANNEL_AVAILABLE = false`，提示词只说「平台代你执行」 | `packages/contract/src/issue-tools.ts:322`；`apps/server/src/skills/prompt.ts:339-345` |
| 为什么调不到 | RACP 白名单 18 条 op 里没有 `tools/advertise`；`capabilities.toolRelay` 只是 schema 字段，Host 侧为 false（ADR 0285 未实现） | `packages/racp-client/src/ops.ts:44-62`；`packages/racp-client/src/schema.ts:304`；`docs/tech-plan.md:400` |
| 写入链路 | 单 turn → 解析信封 → 七类动作（verdict / label / comment / reaction / create_issue / open_pr / close_issue）→ `executeV21` 过闸门 | `packages/envelope/src/v21.ts:120-225`；`apps/server/src/writeback/v21/execute.ts:257-330` |
| 写回闸门 | 只有 3 类动作受项目开关约束（`GATED_ACTION_TYPES`），关掉时**整份拒绝**（不是跳过那一条） | `packages/envelope/src/v21.ts:47`；`execute.ts:236-243` |
| 模型能看到什么 | 只有 title / body / labels / 触发原话；**没有评论列表、没有相似 issue、没有 PR 列表** | `apps/server/src/skills/prompt.ts:529-551` |
| 提示词预算 | 整段 prompt 硬上限 20,000 字符，正文截到 4,000 | `apps/server/src/skills/prompt.ts` `PROMPT_LIMITS` |
| 表情 | `reaction` 动作只有 `op` + `content`，**只能贴主贴**；`agent/ack.ts` 的 eyes/confused 是平台自己打的，agent 声明不了 | `v21.ts:163-169`；`apps/server/src/agent/ack.ts` |
| 评论读取 | `listIssueComments` 只取第一页（>100 条要 paginate），返回值只有 `id` + `body`，**没有作者/时间** | `apps/server/src/github/octokit.ts:206-222`；`github/types.ts` `IssueComment` |
| 表情 API | 主贴 / 评论两条端点都已实现，含按 `reaction_id` 删除 | `apps/server/src/github/octokit.ts:368-428` |
| 回复评论 | **GitHub issue comment 没有 thread 字段**：`issues/create-comment` 的 body 只有 `body`（`in_reply_to_id` 属于 PR review comment） | `@octokit/openapi-types@29.0.1` `types.d.ts:123959`（`issues/create-comment`）与 `:30172`（PR review comment 的 `in_reply_to_id`） |

**推论**：用户列的第 6、7 项（回复评论、给评论贴表情）都依赖「先读到 comment_id」，所以**读通道是这两个功能的前置条件**，不是优化项。

---

## 2. 逐项诉求 → 怎么落地

| 诉求 | 现状 | 落地方式 | GitHub 端点 |
|---|---|---|---|
| issue 列表 | 无 | `IssueList`（读通道） | `GET /repos/{o}/{r}/issues` |
| 读需求正文 / 详情 | 半个（预取了 title+body，无评论无关联） | `IssueGet` + 预取上下文 | `GET /repos/{o}/{r}/issues/{n}` |
| 贴表情（主贴） | 有 | `reaction` 动作（不变） | `POST /issues/{n}/reactions` |
| 贴表情（**评论**） | **无** | `reaction.payload.target='comment'` + `comment_id` | `POST /issues/comments/{id}/reactions` |
| 贴标签 | 有 | `label` 动作（目标态 + diff） | `POST/DELETE /issues/{n}/labels` |
| 评论 | 有 | `comment` 动作（槽位 + 去重标记） | `POST /issues/{n}/comments` |
| **回复评论** | 无 | 新工具 `IssueCommentReply` → 平台渲染引用块 + 定向 `@` + 独立去重 marker | 同上（**引用式**，非真 thread） |
| **提及其他 issue / PR** | 无 | 不新增工具：`IssueCommentCreate` 正文做**引用校验 + 转义**；关系用 `link` 动作走原生 API | 见 §5 |

关于「提及」为什么不单独做成工具：GitHub 的 `#123` 是**正文渲染**触发的（会自动生成 cross-reference 事件），没有"创建提及"的端点。所以它的真实需求是两件事：

1. **校验**：模型写的 `#123` 是否存在、是否属于本 repo（避免编造编号 → 无效引用 → 看起来像乱码）；
2. **关系表达**：duplicate / blocks / parent 这些 GitHub 已有原生结构（`state_reason=duplicate` + `duplicate_issue_id`、`dependencies/blocked_by`、`sub_issues`），比"带标记的关联评论"更可用。

因此建议：**正文引用 = 校验 + 转义**（纯函数，可单测）；**结构关系 = `link` 动作**（新增一类，见 §5）。现在的 `IssueLink` 工具描述写的是"写成带标记的关联评论"，这一条应改。

顺带一个安全点：PR 正文里的 `fixes #12` 会**在合并时自动关闭 issue**（我们没有合并权限，但人会合）。所以 `open_pr` 与评论正文都要过同一套转义。

---

## 3. 通道：四个选项

### A. 预取上下文（无协议改动，P0）
平台在组 prompt 时多取几样东西塞进 `## 任务上下文`：

- 最近 20 条评论（`id` / 作者 / 时间 / 正文前 400 字）；
- 相似 issue 候选（同 repo，按标签重合 + 标题关键词，取 5 条：编号 / 标题 / 状态 / 标签）；
- 当前 issue 的 sub-issue 摘要与 blocked_by（有就列）。

代价：prompt 从 ~4k 涨到 8–12k；硬上限 20k 还在。收益：triage 类任务立刻能用（"已有 #331 类似"这种判断现在完全靠猜）。

### B. 只读工具轮（推荐，P1）
在**同一 RACP session** 上跑多 turn（`agent_sessions.turns` 字段已存在，会话按 issue 常驻，本来就是多轮的）：

```
turn 1（prompt 带工具目录 + 预取上下文）
  → agent 产出 { tool_calls: [{name:'IssueSearch', input:{query:'...'}}], actions: [] }
  → 平台执行（Octokit，App 凭证，token 不进沙箱）
  → 结果写 run_events，按预算截断
turn 2（prompt 只追加「## 工具结果」段）
  → … 最多 3 turn / 共 6 次调用
turn 3 → 最终产出（无 tool_calls）→ 进 writeback
```

三条硬不变量：

1. **含 `tool_calls` 的产出不执行任何写动作**（中间轮只读）。理由：否则模型第一轮就能发评论，绕过"最终结论"这层判断。
2. **写只在最终轮**，仍走原来的闸门 / 槽位 / 去重 / 配额，一行治理逻辑都不复刻。
3. **预算硬上限**：单 run ≤ 3 turn、≤ 6 次调用、单次返回 ≤ 20 条 / 单条正文 ≤ 400 字、累计注入 ≤ 6,000 字符。超限即强制收尾并在 `run_events` 记 `tool-budget-exhausted`。

审计：读调用写 `run_events`（工具名 / 入参摘要 / 返回条数 / 耗时 / 截断标记），**不进 `actions` 表**（它不是写操作，混进去会让"自动执行后被改回"的统计变形）。

### C. 原生 relay（长期，等 Host）
`connection/initialize` 的 `capabilities.toolRelay === true` 时，改成真的注入工具 schema（从 `ISSUE_TOOLS` 生成 zod → JSON Schema），走 `tools/advertise` + relay。那时 `issueToolAvailability()` 返回 `callable`，提示词措辞自动切换——**这个开关当初就是为这天留的**，不需要改文档措辞。

### D. MCP（否决）
两条独立理由：一是审批矩阵明确 deny `mcp__*`（`issue-tools.ts:33`）；二是 MCP 也需要一条 relay 通道，同样是缺的。用官方 github-mcp-server 反而多一个进程、多一份 token（还要给沙箱开网络出口），直接和 D2「token 不进沙箱」冲突。

---

## 4. 工具面 v3（19 个）

保留现有 16 个名字（已在提示词 / 审批矩阵 / 文档里，改名要三处一起动），增 3 个：

| 组 | 工具 | 变化 | 说明 |
|---|---|---|---|
| read | `IssueGet` `IssueList` `IssueCommentsList` `IssueTimeline` | 不变 | `IssueCommentsList` 返回值必须补 `id / author / created_at` —— 没有 `id` 就没法"给评论贴表情"或"回复评论" |
| read | `IssueSearch` | 不变 | 走 search API（配额独立，30/min），单 run 最多 1 次 |
| write | `IssueCreate` `IssueUpdate` `IssueCommentUpdate` `IssueCommentDelete` `IssueLabelAdd` `IssueLabelRemove` `IssueLabelSet` `IssueClose` `IssueReopen` | 不变 | `IssueClose` 的 `state_reason` 需补 `duplicate`（原生枚举就四个：completed / not_planned / duplicate / reopened） |
| write | `IssueCommentCreate` | 改造 | 正文过引用校验 + 转义 |
| write | **`IssueCommentReply`** | **新增** | `(number, comment_id, body)`；平台渲染成引用块 + 定向 `@author`，用独立槽位与 marker |
| write | **`IssueReactionAdd`** | **新增** | `(target: 'issue' \| 'comment', comment_id?, content)` |
| write | **`IssueReactionRemove`** | **新增** | 同上；只删自己打的那条（已有 `pickOwnReactionIds`） |
| meta | `IssueLink` | 改造 | `(number, target_number, relation)`；relation ∈ `duplicate` / `blocks` / `blocked_by` / `parent` / `relates`，映射到原生 API（§5） |

**为什么 reaction 用 `target` 而不是拆成 4 个工具**：模型选工具的成本高于填字段的成本，而"贴哪"是一个枚举而不是两种动作。反过来，「回复评论」单独成工具是因为它的**渲染格式是被规定死的**（引用块 + 定向 @），做成 `IssueCommentCreate` 的一个可选字段会让模型在 8 个可选字段里漏掉它。

---

## 5. 信封动作扩展（v2.2）

改动都在 `packages/envelope/src/v21.ts`，形状尽量小：

```ts
// 1) reaction：加目标（缺省 = 主贴，老产出仍然合法）
payload: { op, content, target: 'issue'|'comment' (default 'issue'), comment_id? }
// strictObject 里加两个可选字段 + refine：target==='comment' 时 comment_id 必填

// 2) comment：加回复目标
payload: { slot, body, reply_to?: number }   // comment_id

// 3) 新动作 link：结构关系，走原生 API
payload: { relation: 'duplicate'|'blocks'|'blocked_by'|'parent'|'relates', target_number }
```

`link` 的平台映射（这是这份设计里唯一需要新写执行分支的地方）：

| relation | 平台动作 | 端点 |
|---|---|---|
| `duplicate` | `PATCH issue` `state_reason=duplicate` + `duplicate_issue_id`（需先 GET 拿 issue **id**，不是 number） | `PATCH /issues/{n}` |
| `blocks` / `blocked_by` | 加依赖 | `POST /issues/{n}/dependencies/blocked_by`（body 是 issue id） |
| `parent` | 把当前 issue 挂成 target 的子 issue | `POST /issues/{target}/sub_issues`（`sub_issue_id` = issue **id**；`replace_parent` 默认不动） |
| `relates` | 一条带标记的关联评论（兜底，没有原生结构） | `POST /issues/{n}/comments` |

开关口径：`duplicate` 等价于"关闭 issue"，**必须并入 `close_issue` 的项目开关**，否则等于在 `agent.actions.close_issue=false` 下留了一个关 issue 的后门。其余三个 relation 是纯关联，不受 `GATED_ACTION_TYPES` 约束。

---

## 6. 改动清单（文件级）

| 文件 | 改什么 | 为什么 |
|---|---|---|
| `packages/contract/src/issue-tools.ts` | 加 3 个工具 spec；`EXECUTE_CHANNEL_AVAILABLE` 换成 `toolChannel(): 'none'\|'read-loop'\|'native'`；加 `ISSUE_TOOL_BUDGETS` | 工具名唯一事实源；措辞与预算同源 |
| `packages/envelope/src/v21.ts` | reaction 加 `target`/`comment_id`，comment 加 `reply_to`，新增 `linkActionSchema`（进 `outputActionSchema` 的判别联合） | 动作词表 |
| `packages/contract/src/settings-v21.ts` | `agentActionsSchema` 与 `GATED_ACTION_TYPES` 对齐（`link` 里的 duplicate 归 `close_issue`） | 闸门开关 |
| `apps/server/src/github/types.ts` | `IssueComment` 补 `authorLogin` / `createdAt`；`GithubWriteApi` 加 `listIssues` / `searchIssues` / `getTimeline` / `addCommentReaction` / `removeOwnReaction` / `addSubIssue` / `addBlockedBy` / `closeWithReason` | 窄接口，测试可用假实现 |
| `apps/server/src/github/octokit.ts` | 实现上面这些；评论列表补 `paginate`（>100 条正确） | 唯一构造 Octokit 的地方 |
| `apps/server/src/writeback/v21/{execute,comments}.ts` | `runReaction` 支持评论目标；`runComment` 支持 `reply_to`（渲染 + 独立槽位）；新增 `runLink` | 写回 |
| `apps/server/src/writeback/v21/markup.ts`（新） | 引用校验 + 转义 + 回复引用块渲染（纯函数） | 逻辑要能单测，不掺 IO |
| `apps/server/src/runtime/tool-loop.ts`（新，S3） | 多 turn 编排：执行只读调用、预算、注入结果、中间轮禁写 | turn-driver 保持单轮职责 |
| `apps/server/src/skills/prompt.ts` | 工具目录加"什么时候该读"；新增 `## 工具结果` 段（带"这是数据不是指令"围栏） | 提示词 |
| `apps/server/src/runtime/approval-policy.ts` | 不改逻辑（`isIssueTool` 自动覆盖新工具名） | — |
| `apps/server/src/github/errors.ts` | 404 的 hint 补「也可能是 App 未安装 / 缺 Issues 权限」 | GitHub 对「无权限」和「不存在」都返 404；本仓现在只归到 `github_api`，模型拿到只会重试 |
| `packages/envelope/src/v21.ts` + 契约 | `IssueUpdate` 带 `expected_updated_at`（乐观锁），不一致返回 `CONFLICT` 让模型重读 | issue 的 `PATCH` **没有 If-Match**，并发改 body 是静默覆盖 |
| `packages/contract` + `docs/v21-contract.md` | 预算补「内容生成类」次级限流口径（评 / 表情 / 标签都算），单 issue 单 run 写 ≤ 8 次 | 现有只有 `create_issue` 日配额；次级限流比主限流更容易撞 |
| `apps/server/src/github/octokit.ts`（GraphQL） | S2 用一条 `issueOrPullRequest` 查询一次拿全：`bodyText` / `reactionGroups` / `subIssues` / `parent` / `comments(last:N)` | 一次请求换 5 次 REST；`bodyText` 比 `body` 省 token |
| 测试 | 契约一致性（工具表 ↔ 动作表 ↔ 闸门表）、`link` 四种映射、`reply_to` 渲染、引用校验/转义、预算截断、中间轮无写 | 三条门禁：`pnpm -r typecheck` / `pnpm -r test` / `pnpm lint` |

---

## 7. 分期

| 期 | 内容 | 通道依赖 | 验收 |
|---|---|---|---|
| **S1** | 信封 + 写回扩展（reaction 评论目标、reply_to、link）+ markup 纯函数 + 测试 | 无 | 模型说"给 #331 的第 2 条评论贴 eyes""这条与 #300 重复"，平台能正确落库并审计 |
| **S2** | 上下文预取（评论列表 + 相似 issue 候选 + sub-issue 摘要） | 无 | triage 提示词里能看到"已有相似 issue"，且 prompt 仍在 20k 内 |
| **S3** | 只读工具轮（`tool-loop.ts`）+ 预算 + `run_events` 审计 | 自研 | `IssueSearch` 返回 3 条后模型改变结论；超预算时强制收尾 |
| **S4** | 原生 relay（`capabilities.toolRelay` 探测 → `ISSUE_TOOLS` 生成 schema 注入） | 等 Host | 能力探测为 true 时 `issueToolAvailability()` 返回 `callable`，提示词自动换措辞 |

S1 值得先做：**它不需要任何新通道**，而现在"给评论贴表情"这类话模型说不出来，是因为动作词表里根本没有这个位置。

---

## 8. SDK 选型调研（核验日期：2026-11-13）

| 候选 | 事实 | 结论 |
|---|---|---|
| **`octokit@5.0.5`**（官方，MIT） | 已在 `apps/server/package.json`；内含 `@octokit/core@7.0.8`、`plugin-rest-endpoint-methods@17.0.0`、`plugin-paginate-rest@14.0.0`、`plugin-paginate-graphql@6.0.0`、`plugin-retry@8.1.1`、`plugin-throttling@11.0.5`、`@octokit/webhooks@14.2.0`、`@octokit/app@16.1.4` | ✅ **就是它**。issue 全套端点（含 reactions / sub_issues / dependencies / timeline / search）都有；`request()` 已在 `octokit.ts` 单点封装，限流头归一化和 `GithubClientMetrics` 都在 |
| `@octokit/auth-app@8.3.1` | 已依赖（安装级 token，1 小时） | ✅ 不变 |
| `@octokit/graphql@9.0.5` | 由 `@octokit/core@7.0.8` 传递进来（`pnpm-lock.yaml:3831`）；实测 `octokit.graphql` 与 `octokit.graphql.paginate` 运行期都在，但**类型面只声明了 `graphql.paginate`**（`octokit/dist-types/octokit.d.ts`），裸 `octokit.graphql()` 无类型 | ⚠️ 不需要额外装包：GraphQL 走 `octokit.graphql.paginate()` 即可；只有要用裸 `graphql()` 才需显式装 `@octokit/graphql` 拿类型。v3 用 REST 就够 |
| **`github/github-mcp-server`**（官方，MIT，34,419★，Go，2026-11-12 仍在推） | `issue_read(method: get/get_comments/get_sub_issues/get_parent/get_labels)`、`issue_write(method: create/update)`、`add_issue_comment` 把**评论与 reaction 合在一个工具**（`body` 与 `reaction` 二选一，`comment_id` 指定贴哪条评论）、`update_issue_comment`、`list_issues`、`search_issues`、`sub_issue_write`、`label_write`、`list_label` | ⚠️ **只借语义，不接入**：Go 进程 + MCP 协议；我们审批矩阵 deny `mcp__*`，且没有 relay；还要给沙箱开出口。但它的工具切分（method 派发、评论/表情合一）值得对照——见 §4 的取舍说明 |
| `@modelcontextprotocol/server-github@2025.4.8` | npm 上标 `deprecated: Archived and unmaintained; no security guarantees` | ❌ 禁用 |
| **`@github-tools/sdk@1.22.0`**（vercel-labs，MIT，139★，周下载 ~5.2 万，2026-11-10 仍在发版） | 97 个工具；`issue-triage` preset 恰好覆盖用户列的全部诉求：`listIssues` `getIssueContext` `listIssueComments` `createIssue` `addIssueComment` `updateIssueComment` `deleteIssueComment` `closeIssue` `updateIssue` `addLabels` `removeLabel` `addIssueReaction` `addCommentReaction` `listCommentReactions` `listSubIssues` `addSubIssue` `searchIssues`；自带 approval、dry-run、输出裁剪。依赖 `octokit@^5.0.5`（与我们同版本） | ⚠️ **不能直接当我们的工具层**：① `peerDependencies` 里有非可选的 `ai`，且 `dist` 模块级 `import { tool, asSchema } from "ai"`——用它就得为一个包装函数引入 `ai`；② 它的审批是**自己的** human-approval，接上等于把我们唯一的写回闸门 / 槽位覆盖 / 去重标记 / 配额 / 审计整段绕开；③ 它的工具名与我们已经冻结的 16 个名字不同（`addIssueComment` vs `IssueCommentCreate`），换过去要改提示词、审批矩阵、文档三处。**可以用作 schema 与输出裁剪形状的参考**，也可以只在 S3 的只读轮里试验性地用它几个 read 工具 |
| `issue-parser@7.0.2`（MIT，gr2m 等维护，CJS） | 解析 `#123` / `#123 #456` / `owner/repo#1` / `@user` / closing keywords | ⚠️ 可选。它连 GitLab/Bitbucket 语法一起做（5 个 lodash 微依赖），我们只用 GitHub 一小撮 → **建议自己写 ~40 行正则 + 单测**，符合本仓"契约层纯函数"风格 |
| `probot@14.3.7` | 已决策不用（README「关键决策」D2 段：不用 Probot） | ❌ 不变 |

**结论**：官方并没有"Issue 工具 SDK"这种东西——官方的两部分是 **Octokit（HTTP 层）** 和 **MCP server（进程 + 协议层）**。我们能直接用的 SDK 只有 Octokit，其余候选要么是进程协议（MCP），要么自带一套和我们冲突的审批模型。工具层必须自己做，而这层薄封装的价值恰恰在于治理语义（槽位 / 去重 / 配额 / 审计 / token 不进沙箱），不是 GitHub 调用本身。

---

## 9. 风险与待确认

| # | 风险 | 现状与对策 |
|---|---|---|
| R1 | **同一 session 多次 `turn/start` 未在实机验证** | `agent_sessions.turns` 字段与"会话按 issue 常驻"都指向多轮，但 `driveTurn()` 目前只驱动一轮（`runtime/turn-driver.ts:305`）。S3 开工前先用真实 bundle 跑一次两连 turn（`docs/spec/b0-spike.md` 那套脚本） |
| R2 | 文本协议的解析失败率 | 工具调用走信封里的结构化字段（zod 校验），不是从自然语言里抠；解析失败按"整份拒绝 + 让模型重写"处理，与现有信封同一条路 |
| R3 | search API 配额（30/min） | 单 run ≤ 1 次 `IssueSearch`；已有限流归一化（`octokit.ts:155`）会把它变成 `retryAfterMs` |
| R4 | sub-issues / dependencies / `state_reason=duplicate` 需要真实 App 权限验证 | 三者都在 `issues: write` 下（OpenAPI 已核），但"够不够"要装 App 后实测；`sub_issue_id` 是 issue **id** 不是 number，容易写错（已写进 §5 表） |
| R5 | 引用式"回复"不是真 thread，人可能误读 | 渲染格式固定成 `> **@someone** wrote:` 引用块 + 一行定位说明；不承诺它能折叠成 thread |
| R6 | 预取把 prompt 撑大 | S2 落地时必须带预算：评论 ≤ 20 条 / 每条 400 字 / 相似 issue ≤ 5 条，并在单测里断言最终 prompt < 20k |

**需要你拍板（3 个）**：

1. **S3 的只读工具轮要不要做**？不做的话，"issue 列表 / 检索"只能靠预取喂什么吃什么，模型无法按需查（比如复盘时想看三个月前的同类 issue）。
2. **`duplicate` 关掉 issue 要不要并入 `close_issue` 开关**（我倾向：要，否则是个后门）。
3. **GraphQL 要不要用**？`octokit.graphql.paginate()` 现在就能调（零新增依赖），能把 timeline + sub-issues 合成一次往返，但要多写查询串；不用也能做。

---

## 10. 与外部通用方案比对（2026-11-13 收到一份设计稿）

那份稿子的结论和我们一致（Octokit 是正解、不整体接 MCP、按任务动作切工具、读写分离、幂等 + 风险分级），但它**没有看过本仓**，且前提是「模型直接拿到工具 schema」——本仓还没有这条通道（§1、§3）。逐条比对：

### 10.1 本仓已经做了、而且更严的（不动）

| 它的建议 | 本仓现状 |
|---|---|
| 互斥状态标签原子切换：先 add 再 remove，避免中间态被 webhook 误触发 | **已实现，理由几乎一字不差**：`writeback/v21/execute.ts:378-390` |
| 回环保护：`sender.type === 'Bot'` 直接 return | **已实现两处**：`trigger/decide.ts:176` → `bot-self`；`http/webhook-v21.ts:135` |
| 评论去重靠 `dedupe_key` 入参 | **更强**：隐藏 marker + 槽位索引（`runComment` 注释：索引优先，一次 GET 都不用），模型无法 opt-out |
| 提供 `gh_label_catalog`，否则模型凭空造标签 | **更强**：`settings.labels.vocabulary` 直接注入提示词，`planLabelTargetState` 拒收目录外标签，连 422 都不会发生 |
| `setLabels` 全量覆盖危险 → 默认不暴露 | 我们暴露 `IssueLabelSet`，但要求目标态 + `clear` 显式许可 + 只动目录内标签（BR-9 空集保护）——同样安全，表达力更强 |
| 表情 200/201 归一成「已贴过」 | 已有：add 信任返回值，删只删 `[bot]` 后缀 / App slug 的（`pickOwnReactionIds`，`github/executor.ts:699`） |

### 10.2 吸收的四个真缺口

就是 §6 新增的 4 行。其中两个值得单独说：

- **404 歧义**：GitHub 对「无权限」和「不存在」都返 404。我们 `errors.ts` 统一归 `github_api`，hint 里没有第二种可能，模型会拿同一条命令反复重试。
- **乐观锁**：issue 的 `PATCH` 没有 `If-Match`，两个人同时改 body 是**静默覆盖**。`expected_updated_at` 是唯一可行的检测手段，成本是一个可选字段。

### 10.3 不采纳

| 它的做法 | 为什么不 |
|---|---|
| 假设模型直接 function calling 调 L2 工具 | RACP 没有 `tools/advertise`、`EXECUTE_CHANNEL_AVAILABLE=false`。这正是 §3 要补的洞，不是可以假设掉的前提 |
| Probot 做 webhook 入口 | 既有决策 D2 已排除；本仓已有 Fastify webhook 九步管线 |
| 每个工具带 `dry_run` 入参 | 平台侧已有 dry-run（`execute.ts:371`，且 `nonGetCalls` 必须为 0），不需要模型逐个传 |
| 工具命名 `gh_*`、18 个 | 16 个 `Issue*` 已在提示词 / 审批矩阵 / 文档三处冻结，改名成本 > 收益；19 与 18 的切法本来就一致 |
| 组织级 issue types | 单 org、少量仓库（D1），收益低，先不做 |
| 手动 `ensureLabel(name, color)` 造标签 | 与「只能加目录内标签」相冲：造标签要人改配置，不该由 agent 现造 |

### 10.4 新增待拍板（第 4 个）

**要不要支持 PR review comment？** 那份稿子点出一个真实陷阱：issue comment 与 review comment 的 **id 是两个命名空间**，数值可能相同但指向完全不同的对象，表情 / 回复 / 编辑端点全不同。本仓 `ReactionTarget` 现在只有 `commentId`、没有 kind（`github/types.ts`）。两条路选一：

- 不支持 → 工具入参与文档明写「只接受 issue comment id」，`kind` 字段不加；
- 支持 → 加 `comment_kind: 'issue' | 'review'`，`addCommentReaction` / 回复在 L1 按 kind 路由到 `/pulls/comments/{id}/reactions` 与 `pullRequestReviewComment` 端点。

---

## 11. 实施记录（工具面 + 提示词，2026-11-13）

**已落地**

| 位置 | 改动 |
|---|---|
| `packages/contract/src/issue-tools.ts` | 16 → **19 个工具**：新增 `IssueCommentReply`、`IssueReactionAdd`、`IssueReactionRemove`；`IssueUpdate` 加 `expected_updated_at`，`IssueClose` 加 `duplicate_of` 与 4 个 `state_reason`，`IssueCommentsList` 说明补「返回值带 `comment_id`」，`IssueCommentCreate` 说明补「`#123` / `@人` 会被校验」，`IssueLink` 说明改为原生关系（duplicate / blocks / blocked_by / parent / relates） |
| 同上 | 新增 `ISSUE_TOOL_USAGE_NOTES`（7 条使用规范）：提示词只从这一处取，避免「工具加了但没人说什么时候用」 |
| `apps/server/src/skills/prompt.ts` | issue 段抽成 `issueToolSectionLines()`；清单后追加「**使用规范**」块（写法对照系统默认提示词的「工具使用规范」）；写分组标题改为「写（评论 / 回复 / 表情 / 标签 / 状态）」 |
| 同上 | 新增 `renderIssueCapabilityCatalog()`：**没有命中技能**的轮次也要拿到完整能力清单（`## issue 操作能力`）。理由：审批矩阵对 `Issue*` 工具不按技能开关（`isIssueTool()` 一律放行），所以这份清单对任何一轮都是准确描述 |
| `apps/server/src/app/worker-deps.ts` | `skill === undefined` 时把能力清单拼在技能目录之后（`\n\n` 分隔）；命中技能时不重复注入 |
| `packages/contract/src/enums.ts` | 注释同步 19 个（`SKILL_ALLOWED_TOOLS` 本来就从 `ISSUE_TOOL_NAMES` 派生，无需改枚举本身） |
| 测试 | 契约：写类 14 个 + 映射加 `reaction.add` / `reaction.remove` + 使用规范覆盖；`skills-prompt`：新工具形状、使用规范位置、能力清单兜底；`app-prompt-enricher`：no-skill 注入、命中技能不重复 |

**未落地（按 §7 分期，仍在排队）**

- 信封 payload：`reaction.target` / `comment_id`、`comment.reply_to`、`link` 动作（`packages/envelope/src/v21.ts`）；
- 写回执行器与 `octokit` 写面：评论目标的表情、引用式回复、`duplicate_issue_id` / sub_issues / dependencies；
- `octokit` 读面：`listIssues` / `searchIssues` / `getTimeline` / 评论 `paginate` + 作者与时间；
- 只读工具轮（S3）与预取上下文（S2）。

**一句实话**：现在这 19 个工具的**语义**已经在契约与提示词里生效，但「贴评论表情」「回复评论」还落不成写回动作 —— 这就是 S1 剩下一半的活儿。第 3、7 节里说的「平台代你执行」在 S1 完成前只对旧 16 个工具成立。
