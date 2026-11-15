# U02 2.2 非目标 · B

## 结论速览
| 条目 | 状态 | 一句话说明 |
|---|---|---|
| NG-1 不合并 PR | 已实现 | 写动作枚举里没有 merge，git 层只允许推 `bot/*`、逐次断言禁 force，且有扫描测试兜底 |
| NG-2 不做多代码托管平台 | 部分实现 | 只有一套 Octokit/GitHub 实现、无 provider 抽象；但 `createGithubClient` 留了 `baseUrl` 覆盖入口（未接配置） |
| NG-3 不做审批流 | 已实现 | 审批是纯函数自动应答的工具调用矩阵（每次留审计），不存在人卡点；异常走兜底评论 |
| NG-4 不做多租户 | 已实现 | `repos` 表以 `owner/name` 为主键、无租户列；单一 installation，来源不匹配即忽略 |
| NG-5 本期不处理 PR 事件 | 部分实现 | `pull_request.*` 恒判 `pr-ignored` 并留痕、不入队；但旧命令通道 `/review-pr` 仍能对 PR 起评审任务 |

## 逐条

### NG-1
- 状态：已实现
- 反证过程：
  1. 搜全部 `merge` 相关字样（`apps/` 下 16 个文件命中），逐条排除：`queries/issues.ts:965` 是 SQL CTE 别名、`git/branch-cleanup.ts:128` 是 `merge-base --is-ancestor`（只读判定）、`jobs/reconcile-reverts.ts:322` 只**读** PR 的 `merged` 字段做改回统计、`run-git.ts:139` 与 `writeback/v21/execute.ts:359` 是变量名 `merged`、面板两处是 `twMerge`。
  2. 找「不调 merge 接口但仍有合并能力」的路径：`git push` 是唯一能把提交送到远端的地方。`pushCommit` 先 `assertBotBranch(branch)`，refspec 硬拼为 `<commit>:refs/heads/bot/...`，分支名不匹配 `^bot\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` 直接抛 `BOT_BRANCH_INVALID`，因此不存在「推 base/main」的入口。
  3. 找强推这条旁路：`run-git.ts` 的 `assertNoForceArgs()` 在每次 git 调用前拦 `--force` / `--force-with-lease` / `--force-if-includes` / `--mirror`，只有 `worktree` 子命令例外；`pushCommit` 还额外断言 refspec 不以 `+` 开头。
  4. 找「动作枚举里偷加一类」：`github/executor.ts:917-973` 的 switch 只覆盖 `comment` / `label` / `create_issue` / `push_branch` / `open_pr` / `close_issue` / `reaction.add` / `reaction.remove`；契约 `ACTION_INTENTS` 也只有四类（`comment`/`label`/`create_issue`/`push_branch`），`open_pr` 是 `push_branch` 上的开关而非独立 intent。
  5. 有无回归守卫：`apps/server/test/no-merge.test.ts:29-32` 扫 `.merge(` / `pulls.merge` / `mergePullRequest` / `merge_pull_request`，`:65` 断言 src 下零命中。
- 证据：
  - `apps/server/src/github/types.ts:113` — 写端口注释「这一层刻意**不含** merge —— 本项目没有合并权限，也没有对应代码路径」。
  - `apps/server/src/github/executor.ts:944` — `push_branch` 分支存在，`:947` 是 `open_pr`，全 switch 无 merge 分支。
  - `apps/server/src/git/push.ts:27` — `BOT_BRANCH_RE` 白名单；`:210-212` — `assertBotBranch` + 唯一 refspec 拼接点；`:213-221` — 拒绝以 `+` 开头的 refspec。
  - `apps/server/src/git/run-git.ts:84-89` — `FORBIDDEN_ARG_TOKENS` 含 `--force`/`--mirror`；`:103-111` — `assertNoForceArgs` 抛 `GIT_FORCE_REFUSED`；`:212` — 每次调用都过这道闸。
  - `packages/contract/src/enums.ts:115` — `ACTION_INTENTS = ['comment','label','create_issue','push_branch']`。
- 说明：合并动作只有人能做：平台产出的上限是「推 `bot/*` 分支 + 开 PR + 评论」，且 `git/branch-cleanup.ts:6` 还明确只删「已合并」的 `bot/*` 分支（删分支不是合并）。
- 缺口：无。

### NG-2
- 状态：部分实现
- 反证过程：
  1. 搜 `gitlab|gitea|bitbucket|GHES|ghe.|github-enterprise`：`apps/`、`packages/` 的 `.ts/.tsx/.json` 全部 0 命中真实代码（唯一命中的 `pickHighestPrioritySignal` 是正则误匹配 "highest"）。可插拔 provider 抽象也搜不到（`interface *Provider` / `ScmProvider` / `VcsProvider` / `hosting` 均 0 命中）。
  2. 找所有出口：`createGithubClient()` 只有 `octokit` 一个实现（`app/github-auth.ts:81,89,101`、`app/worker-deps.ts:455` 三处调用点都指向它），默认构造器就是 `new Octokit(...)`。
  3. 找「环境变量里能换宿主」：`app/config.ts` 的 GitHub 键只有 `PI_BOT_GITHUB_APP_ID` / `PRIVATE_KEY_PATH` / `INSTALLATION_ID` / token 一类（`:75-79`），没有任何 host / base URL 键；出现过 `baseUrl` 的地方是模型供应商（`app/config.ts:92-95`）。
  4. 残余入口：`createGithubClient` 的入参里确实有 `baseUrl`，并会透传给 Octokit 构造器（`github/octokit.ts:108-109`），单测 `test/github-octokit.test.ts:107-111` 就是拿 `https://ghe.invalid/api/v3` 验它。这条只在测试里用过，生产装配（`app/github-auth.ts`、`app/worker-deps.ts`）从不传。
- 证据：
  - `apps/server/src/github/octokit.ts:108-109` — `if (options.baseUrl !== undefined) ctorOptions['baseUrl'] = options.baseUrl;`（宿主覆盖点）。
  - `apps/server/src/app/worker-deps.ts:455` — 生产唯一构造方式：`createGithubWriteApi(createGithubClient({ authToken: ... }))`，未传 `baseUrl`。
  - `apps/server/src/app/config.ts:75-79` — GitHub 相关环境变量清单，无 host 覆盖项。
- 说明：多平台适配层不存在，RFC 行为（webhook 头、comment/label/issue/push 语义）全部按 GitHub REST 写死；GHES 走同一套 REST，但当前没有配置面能把它切过去。
- 缺口：`github/octokit.ts` 的 `baseUrl` 选项是可被将来一行代码激活的 GHES 入口（现在仅测试使用，属死接口）。

### NG-3
- 状态：已实现
- 反证过程：
  1. 区分两种「审批」：需求禁的是「人卡点」。代码里的审批确实存在，但它是**工具调用审批矩阵**，不是等人点同意。
  2. 查它是否会自动作答：`turn-driver.ts:578-598` 收到 `approval.requested` 后直接调 `decideApproval()`（纯函数），拿到 allow/deny 就 `ops.approvalRespond(...)` 回给 agent，并 `onAudit(decision.audit)` 落审计——没有排队、没有等人、没有超时等待。
  3. 查面板是否有「批准/拒绝」写接口：契约里 `approval` 只出现在只读响应（`api.ts:501-502` 的 `approval` 字段，`api.ts:564-566` 的 `approval_tool/decision/rule` 事件列）与 `enums.ts:161` 的 `run_events` 分类，没有任何 approval 写端点；面板 `routes/audit.tsx:379`、`routes/task-detail.tsx:217` 都只是展示判定。
  4. 查异常是否走兜底通知：`worker/fallback.ts:1-22` 是「信封不可信但 agent 说了人话」的窄出口（只发一条评论、不改结局、dry-run 下不做），`fallback.ts:47-52` 限定评论类命令。
  5. agent 反问也不让人卡：`runtime/approval-policy.ts:20` 规定 `input/request` 一律应答「无法提供，按现有信息继续」，`turn-driver.ts:601-610` 立即回。
- 证据：
  - `apps/server/src/runtime/approval-policy.ts:4-8` — 「`permissionMode: 'ask'` + 自动应答…本文件是**纯函数**」。
  - `apps/server/src/runtime/turn-driver.ts:584-598` — 判定即应答，无人工通道。
  - `apps/server/src/worker/fallback.ts:10-15` — 兜底只发评论、不改结局、dry-run 不写。
  - `packages/contract/src/api.ts:501-502` — 审批判定只作为任务详情里的只读字段回显。
- 说明：审批矩阵保留是审计与最小权限的要求（每次 allow/deny 都是一条审计），与被禁的「事前人工审批流」是两件事：任务入队与执行都不等任何人。
- 缺口：无。

### NG-4
- 状态：已实现
- 反证过程：
  1. 搜 `tenant|multiTenant|organization_id|orgId`：0 命中。搜到的 `installationId` 是 GitHub App 安装号，不是租户维度。
  2. 查数据模型是否按「组织」隔离：`repos` 表主键就是 `repo_full_name`（`db/schema.ts:148`），列里只有 enabled/dryRun/settings/installationId 这类仓库级字段，没有任何 tenant/org 列；`tests`、`tasks` 等表都以 repo + issue 定位。
  3. 查是否会为一个部署服务多个 installation：`webhook.ts:960-968` 的 `installationMismatch()` 在「仓库记录的 installation 与本次投递不一致」时返回原因串，`:1178-1189` 直接回 200 `ignored` 不入队——单一 installation 是被强制的不变式，不是缺省值。
  4. 查配置面是否支持多 App：`app/config.ts:158-162` 只有一组 `appId` / `privateKeyPath` / `installationId`（`PI_BOT_GITHUB_APP_ID` / `..._INSTALLATION_ID`，`:75-79`），单进程单凭证。
  5. 查是否有租户切换 UI：面板 `apps/panel/src` 搜「租户/tenant」0 命中，只有仓库级路由（`lib/repo-route.test.ts:58`）。
- 证据：
  - `apps/server/src/db/schema.ts:146-179` — `repos` 表结构与索引，无租户维度。
  - `apps/server/src/http/webhook.ts:965-968` — installation 不匹配即拒绝。
  - `apps/server/src/app/config.ts:158-162` — 单 App / 单 installation 的配置结构。
- 说明：单组织、少仓库、单机部署的形态在数据模型、凭证结构与准入判定三处一致，不存在可被开启的多租户开关。
- 缺口：无。

### NG-5
- 状态：部分实现
- 反证过程：
  1. 查事件入口：`http/webhook-v21.ts:85-89` 把所有 `pull_request*` 事件归一成通配键 `pull_request.*`；`:171-177` 直接返回 `decidePullRequest()`；`trigger/decide.ts:268-276` 的实现恒为 `{ triggered:false, reason:'pr-ignored' }` 且刻意不给模板（防止有人从「空模板」推出「配个模板就能处理 PR」）。
  2. 查是否真的不入队：`:122-124` 遇 `pull_request.*` 时 `v21DecisionInputOf` 返回 null（不参与五事件判定）；`webhook.ts:1210` 的会话状态迁移显式跳过 `sessionEvent !== 'pull_request.*'`，即不为 PR 建/改会话。
  3. 查是否留痕：`webhook.ts:1101-1108` 无论事件类型先写 `webhook_deliveries`；`:1014-1017` 在返回前调用 `writeV21Decision()`（`webhook-v21.ts:200` 的 `UPDATE ... SET decision, decision_reason`），注释写明「不触发也写」。集成测试 `test/v21-webhook-integration.test.ts:519-524` 断言 PR 投递留 `pr-ignored` 且完全不入队。
  4. 查「不起 PR 评审会话」是否有旁路：`webhook.ts:1243-1261` 判定出 `source='command'` 时把 `legacyCommand` 交给 v2 分支，`webhook-v21.ts:984-986` 对命令通道返回 null（不接管），于是旧管线继续走 `webhook.ts:1289-1322` 建任务。`webhook.ts:577-590` 对 `issue_comment.created`（issue 载荷里带 `pull_request` 字段的评论）命中 `/review-pr` 时生成 `command:/review-pr` 任务，`targetKind='pr'`；`skills/builtin.ts:37-38,439` 内置该技能，`fallback.ts:16` 也承认「`/review-pr` 会改变 PR 的去留」。
- 证据：
  - `apps/server/src/http/webhook.ts:1014-1017` / `apps/server/src/http/webhook-v21.ts:200` — 判定与原因落 `webhook_deliveries`（留痕）。
  - `apps/server/src/http/webhook-v21.ts:86-88` — PR 事件统一归 `pull_request.*`。
  - `apps/server/src/http/webhook.ts:627-629` — `issues` 事件来自 PR 时按「不在 agent 范围」忽略。
  - `apps/server/src/trigger/decide.ts:274-275` — `decidePullRequest()` 恒 `pr-ignored`、无模板。
  - `apps/server/src/http/webhook.ts:580-589` — `/review-pr` 生成 PR 评审命令任务（残余入口）。
  - `apps/server/src/skills/builtin.ts:37` — 内置 `/review-pr` 技能正文。
- 说明：NG-5 的主干（不处理 PR 事件）确实做到了：`pull_request.*` 恒未触发、不入队、不碰会话、留痕有测试。但「不做评审」这一分句在代码里并不成立——`@bot /review-pr` 这条评论命令仍在，会拿 PR 的 base sha 跑一轮评审并回评论；它挂的是 `issue_comment.created` 而非 `pull_request.*`，且任务是 ephemeral（`app/compose.ts:241`：`/review-pr` 与 `@answer` 都不建常驻会话），所以「不开 PR 评审会话」成立、字面上的「不做评审」不成立。
- 缺口：`/review-pr` 命令通道（`webhook.ts:580`、`skills/builtin.ts:37`）是 PR 评审能力，与新文档「本期不做评审」冲突；代码注释称其为「保留既有通道（PR 审查不在 v0.3 agent 范围内）」，即历史遗留而非本期新增，需要产品侧明确是保留还是下线。

## 本节整体结论
五条非目标里有四条在代码中确实不存在对应能力：没有 merge 动作也没有推主分支的路，只有一套 GitHub 实现，审批是自动应答的工具矩阵而非人卡点，数据模型与凭证结构都是单组织单机。两处需要产品确认：一是 `createGithubClient` 留了 `baseUrl` 覆盖点（未接配置，现仅测试使用），属 GHES 的死接口；二是 `/review-pr` 这条历史命令通道仍在，`@bot /review-pr` 会对 PR 跑一轮评审并回评论，与新文档「本期不做评审」字面冲突，但它不建 PR 常驻会话、也不经 `pull_request.*` 事件路径。PR 事件本身的处理完全符合需求：恒 `pr-ignored`、留痕、不入队、不动会话。

## 核查边界
- 是否执行了命令：是，只读命令（`git status --short`、`Select-String` / `Get-Content` 读取源码与 `docs/requirements.html` 的 567-574 行），未运行测试、未运行构建、未修改任何仓库文件。
- 未覆盖的条目及原因：无条目遗漏；但 NG-2 的「运行期是否真能连 GHES」与 NG-5 的「`/review-pr` 在当前部署里是否被配置关闭」需要运行环境/部署配置才能确认，本次仅据代码与配置面判定（配置面里找不到关闭它的开关）。
