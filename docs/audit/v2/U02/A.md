# U02 2.2 非目标 · A

> 核查对象：`docs/requirements.html` 第 2.2 小节（行 567-574，NG-1 ~ NG-5）。
> 口径说明：本节是「不该做的事」，因此「已实现」= **代码里确实没有该能力且有明确证据**。

## 结论速览

| 条目 | 状态 | 一句话说明 |
|---|---|---|
| NG-1 不合并 PR | 已实现 | 写面只到 `push_branch`/`open_pr`，`GithubWriteApi` 刻意无 merge，专用扫描测试通过 |
| NG-2 不做多托管平台 | 部分实现 | 无 GitLab/Gitee 适配与 SDK，但 `createGithubClient` 保留 GHES `baseUrl` 选项（无配置入口） |
| NG-3 不做审批流 | 已实现 | 无「事前审批」表/状态/端点；`approval-policy` 是工具调用的**自动**应答，不等人 |
| NG-4 不做多租户 | 已实现 | 全仓无 `tenant`；`repos`/`agent_sessions` 以 repo、issue 为键；`serve` 单进程单库 |
| NG-5 不处理 PR 事件 | 已实现 | `pull_request.*` 恒判 `pr-ignored` 只留痕不入队；残留 `/review-pr` 评论命令通道（见缺口） |

## 逐条

### NG-1

- 状态：已实现
- 证据：
  - `apps/server/src/github/types.ts:113` — `GithubWriteApi` 注释写明「这一层刻意**不含** merge —— 本项目没有合并权限，也没有对应代码路径」，接口方法集只有 comment / label / issue / close / updateComment / getIssue（`:115`-`:162`）。
  - `packages/envelope/src/actions.ts:16` — `ACTION_INTENTS = ['comment', 'label', 'create_issue', 'push_branch']`；`:20` 明确把模型自创的 `open_pr` / `close_issue` 判为 `unknown-intent` 丢弃。
  - `apps/server/src/github/executor.ts:17` — 写执行器的最远动作是 `open_pr → 只到 bot/* 分支`，没有后续合并步骤。
  - `apps/server/test/no-merge.test.ts:29`-`:32` — 专用扫描测试禁止四类模式：`.merge(`、`pulls.merge`、`mergePullRequest`、`merge_pull_request`；`:17`-`:24` 的扫描根覆盖 server/panel/contract/envelope/racp-client/shared 六个 src。
- 说明：能力边界在**类型层**（写面接口没有 merge 方法）、**契约层**（intent 白名单无合并）、**执行层**（最远到开 PR 分支）、**门禁层**（扫描测试）四处同时收口，任一层被绕过都会被另一层挡住。独立复核扫描（`apps/server/src`、`apps/panel/src`、`packages/{contract,envelope,shared}/src` 内搜 `.merge(`/`pulls.merge`/`mergePullRequest`/`merge_pull_request`/`git merge`）零命中；`git/branch-cleanup.ts:128` 用的是 `merge-base --is-ancestor`，只**读**合并状态用于判断分支能否删除，本身不产生合并。实跑 `test/no-merge.test.ts` 2 条用例全通过，说明扫描不是空转。
- 缺口：无。

### NG-2

- 状态：部分实现
- 证据：
  - `package.json:19`-`:25` — 依赖里只有 `@octokit/auth-app`、`@octokit/webhooks`、`octokit`，无任何 GitLab / Gitee / Bitbucket SDK。
  - `apps/server/src/github/octokit.ts:70`-`:71` — **残余入口**：`baseUrl?: string`，注释为「GitHub Enterprise 的 API 根地址」，`:108`-`:109` 会把它透传给 Octokit 构造器。全仓仅在测试里被使用（`apps/server/test/github-octokit.test.ts:107` 传 `https://ghe.invalid/api/v3`）。
  - `apps/server/src/app/github-auth.ts:81`、`:89`、`:101` — 三处生产装配调用 `createGithubClient()` 都**只传认证**，不传 `baseUrl`；`apps/server/src/app/worker-deps.ts:455` 同样如此。全仓无 `GITHUB_API_URL` / `GITHUB_BASE_URL` / `githubBaseUrl` 等环境变量读取点（扫描零命中）。
  - `apps/server/src/git/worktree-port.ts:29` — 另一处残余入口：`defaultRemoteUrl(repo, baseUrl = 'https://github.com')` 留了可替换主机参数；`:34` 的唯一调用点用默认值。
- 说明：适配层、SDK、webhook 验签、事件词表全部按单一 GitHub 形态实现（`http/webhook-v21.ts:85`-`:108` 的事件键就是 GitHub 的 `X-GitHub-Event` 词表），GitLab 那类平台在本仓没有落地路径。之所以不给「已实现」：GHES 的 `baseUrl` 选项与其 JSDoc 仍存在于生产代码中，虽然当前**没有任何配置/环境变量能激活它**（只有改代码或注入 `OctokitCtor` 才用得上），但它确实是一个指向「非 github.com 主机」的残留入口。
- 缺口：`octokit.ts:70`-`:71` 的 GHES 选项与 `worktree-port.ts:29` 的 `baseUrl` 形参属于「需求明说不考虑」却留在生产代码里的旋钮；若要字面落实 NG-2，应删掉或改写注释、只留测试私有注入点。

### NG-3

- 状态：已实现
- 证据：
  - `apps/server/src/db/schema.ts:34`-`:49` — `TASK_STATUS` 只有 `queued / running / succeeded / failed / timed-out / cancelled_queue / cancelled`，**没有** `pending_approval`、`blocked`、`waiting_for_human` 之类「等人点头」的状态。
  - `apps/server/src/runtime/turn-driver.ts:578`-`:598` — 收到 `approval.requested` 后立刻用 `decideApproval()` 算结论并 `approvalRespond()` **自动应答**，中间没有任何等待人工的环节。
  - `apps/server/src/runtime/approval-policy.ts:1`-`:8` — 文件头写明这是「**自动**审批策略」，用 `permissionMode:'ask'` + 自动应答是为了让每次 allow/deny 都成为**审计条目**，而不是把决定权交给人。
  - `apps/server/src/http/api/index.ts:344`（唯一的仓库写入口）+ `apps/server/src/http/api/{auth,queries,skills}.ts:291`-`:588` — HTTP 写端点里没有任何 `approve` / `reject` 类路由（扫描 `approve|reject|approval` 在 `http/api/` 零命中），`apps/panel/src/routes/` 也没有审批动作页（扫到的「审批」只是审计表格的表头与工具调用的 allow/deny 展示，见 `apps/panel/src/routes/audit.tsx:379`）。
  - `apps/server/src/queue/retry-policy.ts:39`、`:195`-`:196` — 失败处理的出口是「进 `runs.failure_detail` 与异常兜底通知」；`apps/server/src/worker/fallback.ts:1`-`:21` 是这条兜底通知的实现（只发评论、不改结局、不新增失败信号）。
- 说明：这里的「审批」一词在仓库里指**容器内工具调用的自动判定**（`approval-policy`），是人不在环的机器策略，恰好与需求要的「无人工卡点」一致；它带来的只是审计条目，不是卡点。真正的「事前审批流」所需的三个部件——待审批状态、审批写入端点、人工阻塞等待——都不存在，异常一律走兜底通知（评论 + 失败详情 + 日志）。另核对无 `manualApproval` / `humanApproval` / `waiting_for` / `人工确认` / `人工卡点` 等关键词命中。
- 缺口：无功能性缺口。附带说明：兜底通知的落点是 issue 评论与 `runs.failure_detail`/日志，没有独立的对外告警通道（这是需求另一侧的增强点，不影响「不做审批流」这条结论）。

### NG-4

- 状态：已实现
- 证据：
  - `apps/server/src/db/schema.ts:146`-`:148` — `repos` 表以 `repo_full_name` 为**主键**（`owner/name` 全库唯一），没有「组织」「租户」维度列。
  - `apps/server/src/db/schema.ts:658`-`:663` — `agent_sessions` 以 `(repo, issue_number)` 定位会话，仍是「仓库 + issue」两级，不是「租户 + 仓库 + issue」三级。
  - 全仓（`apps/`、`packages/`，含 `.ts/.tsx/.sql`）扫 `\btenant\b|tenant_id`：**零命中**；`db/schema.ts` 的 24 张表（`:88`-`:793`）里没有租户/组织表。
  - `apps/server/src/cli.ts:58` — `serve` 的语义是「HTTP + worker 同进程启动控制面（默认形态）」，单进程单库；`:46` 的五个子命令里没有多实例/多租户编排。
  - `apps/server/src/http/api/auth.ts:9`-`:16`、`:106`-`:113` — 面板鉴权是**单组织**成员校验（`GET /orgs/{org}/members/{username}`，未注入则跳过并 warn），不是多租户隔离模型。
- 说明：数据模型、鉴权模型、部署模型三者都停留在「单组织 + 少量仓库 + 单机」，任何一处要支持多租户都得改主键与鉴权契约，说明这条非目标没有被悄悄突破。
- 缺口：无。

### NG-5

- 状态：已实现
- 证据：
  - `packages/contract/src/settings-v21.ts:52`-`:62` — `EVENT_KEYS` 只有 `issues.opened` / `issues.edited` / `issues.labeled` / `issues.closed` / `issue_comment.created`，注释写明「`pull_request.*` **刻意不在其中**」。
  - `apps/server/src/trigger/decide.ts:274`-`:275` — `decidePullRequest()` 恒返回 `{ triggered: false, event: 'pull_request.*', reason: 'pr-ignored' }`，且 `:271`-`:272` 明确「**没有模板**」，防止有人从空白模板推断出「配个模板就能处理 PR」。
  - `apps/server/src/http/webhook-v21.ts:85`-`:89` — `event.startsWith('pull_request')` 一律映射成 `'pull_request.*'`，注释为「§0『不纳入』：PR 事件本期一律按未触发留痕，不进 issue 会话」。
  - `apps/server/src/http/webhook-v21.ts:203`-`:211` — `writeV21Decision()` 把判定写进 `webhook_deliveries`（`decision` + `decision_reason`），这是**留痕**的实现；`:988`-`:993` — 未触发时只记日志、返回 200 `ignored`，**不入队**。
  - `apps/server/src/http/webhook.ts:526`、`:665` — 旧判定链路也把 `pull_request.*` 与其它未白名单事件一起判为 `ignore`（`事件 … 不在白名单`）。
  - `apps/server/src/http/webhook.ts:1210` — 会话状态迁移显式排除 `'pull_request.*'`，PR 事件不会推动任何 issue 会话状态。
  - 测试佐证：`apps/server/test/trigger-decide.test.ts:482`-`:487`、`apps/server/test/v21-integration.test.ts:215`-`:222`、`apps/server/test/v21-webhook-integration.test.ts:519`-`:524`（「PR 事件留 `pr-ignored` 且完全不入队」）。
- 说明：「接收并留痕」与「真正处理」在这里是分开的两个函数：`webhook_deliveries` 落库 → `decidePullRequest()` 恒不触发 → `handleV21Webhook()` 在 `!decision.triggered` 分支直接返回 `ignored`。事件层没有任何通往任务的出口，符合「本期不处理 PR 事件」。
- 缺口：残余入口——人工命令通道 `/review-pr` 仍可在 **PR 评论**上触发一次 PR 评审任务：`apps/server/src/http/webhook.ts:561`-`:570` 依据 `issue.pull_request` 把 `targetKind` 置为 `'pr'`，`:577`-`:589` 把它派成 `command:/review-pr` 任务（`skills/builtin.ts:36`-`:48` 是对应的内置技能，`outputs: [comment, pr]`）。它不依赖 `pull_request.*` 事件、且 `apps/server/src/app/compose.ts:241` 标明这类任务 `ephemeral`（**不开 PR 评审会话**），因此不影响本条的「事件不处理」结论；但若把需求里「不做评审」按字面执行，这条通道需单独决策（保留 / 下线）。

## 本节整体结论

五条非目标里有四条半被代码明确守住：不合并 PR 有类型层 + 契约层 + 扫描测试三重收口（且扫描实测通过），不做审批流与不做多租户都已落到「状态机里没有这一档、表结构里没有这一维」，PR 事件则被 `decidePullRequest()` 恒定判为 `pr-ignored` 只留痕不入队。唯一的偏离是 NG-2 的两处残留入口：`createGithubClient` 的 GHES `baseUrl` 选项与 `defaultRemoteUrl` 的 `baseUrl` 形参虽无任何配置可激活，但注释与形参仍指向「非 github.com 主机」，属于应清理的旋钮。NG-5 的 `/review-pr` 评论命令通道是需求文档之间既有的张力点（保留既有通道 vs 不做评审），不构成事件处理的越界，但需要产品确认。整体看，本节非目标与代码现状一致，缺口集中在「注释/形参级别的残留」，而非能力实现。

## 核查边界

- 是否执行了命令：是。只读扫描与门禁复核：
  - `pnpm --filter @pi-issue-bot/server exec vitest run test/no-merge.test.ts` → 2 passed（NG-1 的扫描测试不是空转）。
  - 只读 grep 扫描：`\.merge\(|pulls\.merge|mergePullRequest|merge_pull_request|git merge`（六个 src 根，零命中）；`gitlab|gitee|bitbucket|GHES`（src 零命中）；`GITHUB_API_URL|GITHUB_BASE_URL|githubBaseUrl|enterprise`（仅 `octokit.ts:70` 注释命中）；`\btenant\b|tenant_id`（`apps`/`packages` 零命中）；`pending_approval|approveTask|manualApproval|humanApproval|人工审批|事前审批|人工卡点`（零命中）；`approve|reject|approval`（`http/api/` 零命中）。
  - 未执行：`pnpm -r typecheck`、`pnpm lint`、`pnpm -r test` 全量——本次为只读核查，未改动任何代码（工作区原有的 `M` 状态改动未触碰）。
- 未覆盖的条目及原因：无条目被跳过。边界内的两组细微判断已写在对应「缺口」里：① NG-2 的 GHES 选项是否算「能力」取决于是否承认「只有改代码才能激活」的旋钮，本次按「部分实现」从严记录；② NG-5 的 `/review-pr` 是否算「做评审」取决于需求两条通道的口径，本次按「事件不处理 = 已实现 + 记录残余通道」记录。另有一项需运行环境才能完全确认、本次未验证：真实 GitHub App 投递 `pull_request.*` 时 `webhook_deliveries.decision_reason` 是否稳定写入 `pr-ignored`（代码路径与单测均已覆盖，未连真实 webhook 复放）。
