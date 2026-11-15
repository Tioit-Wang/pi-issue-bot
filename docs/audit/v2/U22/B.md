# U22 面板身份（GitHub 令牌） · B

> 核查范围：docs/requirements.html 行 1762-1773
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| CFG-9.1 | 未实现 | 全仓只有「App installation token / 部署级静态 `PI_BOT_GITHUB_TOKEN` / none」三种身份，**不存在「按用户存的个人 PAT」**；无手动填 PAT 的入口、无「检查权限」（scope / 过期） |
| CFG-9.2 | 未实现 | 无个人 PAT 即无「回退到 bot」这回事；三种失败态里只有「写面完全不可用」会抛错留痕，且**失败原因文本不进契约**（`audit.reason` 被查询层丢弃），更无 scope 不足 / 过期的判别 |

## 逐条

### CFG-9.1
- **状态**：未实现
- **证据**：
  - `apps/server/src/app/github-auth.ts:21` — `export type GithubAuthMode = 'app' | 'token' | 'none' | 'degraded'`：身份模式只有这四种，**没有 `user` / `personal` 一类**。
  - `apps/server/src/app/github-auth.ts:98-103` — `token !== null` 分支直接 `createGithubClient({ authToken: token })`，`detail` 写「静态 token 认证（PI_BOT_GITHUB_TOKEN）」。这个 token 是**部署级单值**，不带任何 user 维度。
  - `apps/server/src/app/config.ts:71-79` — 键表里与身份相关的只有 `PI_BOT_GITHUB_TOKEN` / `PI_BOT_GITHUB_APP_ID` / `PI_BOT_GITHUB_APP_PRIVATE_KEY_PATH` / `PI_BOT_GITHUB_INSTALLATION_ID`，全部来自宿主进程环境变量；**没有任何可被面板写入的令牌配置项**。
  - `apps/server/src/app/compose.ts:753-761` — 所有写面（评论 / 打标 / reaction / 关单）共用**同一个** `baseGithubClient`：`createGithubWriteApi(baseGithubClient)`；`:885-889` 的 webhook ack 也是它。全仓无「按操作者选客户端」的分支。
  - `packages/contract/src/api.ts:646-724` — `/api/system` 响应只有 `version` / `protocol` / `host` / `doctor` / `queue` / `retention` / `flags` / `repos`，**没有任何身份或令牌字段**；`.strict()` 下加字段会红，面板根本拿不到「当前以谁的身份写回」。
  - `apps/panel/src/layout/nav.ts:73-78` — 设置分区只有 `general` / `events` / `labels` / `execution` 四项，**没有「身份」分区**；`apps/server/src/http/api/index.ts:101-235`（全局）与 `:292-358`（仓库）的路由表里也没有任何令牌提交端点。
  - 「检查权限」：`apps/`、`packages/` 下所有 `*.ts`/`*.tsx` 搜 `X-OAuth-Scopes` / `oauth-scope` / `scopes` / `checkToken` / `GET /user` / `getAuthenticated` **零命中**；`apps/server/package.json:19-25` 只依赖 `@octokit/auth-app` 与 `octokit`，`@octokit/auth-oauth-*` 仅作为 `pnpm-lock.yaml` 里的传递依赖存在，源码未引用。
- **缺口**：
  1. 「配置个人 PAT 后以该用户身份提交评论（需 `issues: write`）」——**整个能力不存在**：没有个人 PAT 的存储位（表 / 列 / 契约字段）、没有面板输入入口、没有按用户切换客户端的写路径。
  2. 「手动填 PAT」的取法——无处可填。
  3. 「检查权限」按钮校验 scope 与过期时间——零实现（连读取 `X-OAuth-Scopes` 的代码都没有）。
  唯一成立的是前置事实「默认以 bot 身份写回」（App / 静态 token），而它不是本条的主体。
- **判定依据**：需求本条的主体是「可切换为个人账号」。代码里与身份有关的只有一条全局单例认证链（App 优先 → 静态 token → none → degraded），**不存在 user 维度的凭据模型**；状态五值里只有「未实现」符合「找不到实现」。
- **反证过程**：
  1. **先假设「系统根本不能以个人身份写回」**：核对身份枚举（`github-auth.ts:21`）= app / token / none / degraded，四者全是**部署级**；核对装配（`compose.ts:753-761`）所有 GitHub 写请求共用同一个 client。反证成立 → CFG-9.1 判未实现。
  2. **避免张冠李戴（AES-GCM）**：全仓 `createCipheriv('aes-256-gcm')` 只在 `apps/server/src/runtime/crypto.ts:126`；其唯一生产调用点是 `apps/server/src/runtime/bootstrap.ts:347` 的 `encryptSecret(paired.deviceToken, …)`，落 `host_credentials.token_enc`（`apps/server/src/db/schema.ts:513-523`，列注释「RACP 设备令牌」）。**它加密的是 pi-host 配对设备令牌，不是个人 PAT**，不能作为本条达标证据。另外 `panel_sessions`（`schema.ts:560-571`）只存 `sid` / `login` / `expires_at`，没有存任何令牌。
  3. **「检查权限」假设完全没实现**：按要点 3 全仓搜 `X-OAuth-Scopes` / `checkToken` / `/user` 调用 → 零命中（见上）。`github/auth.ts:83-100` 的校验只检查 `appId` 是正整数、`privateKey` 是 PEM 形状，**不查 scope、不查过期**。假设成立。
  4. **反向排除「面板侧偷偷实现了」**：`apps/panel/src` 全量搜「令牌 / PAT / 身份 / 你的账号」→ 仅命中设计令牌（`--radius` 之类）与「仓库身份（只读）」（`general-section.tsx:24`，内容为 repo / source / installationId / 归档，没有身份切换）。排除。
  5. **结论区分**：不是「有一半」，而是**完全没这个概念**——「个人」在 `apps/`、`packages/` 内只命中 `v21-events-section.tsx:515` 的角色成员 login 说明，与写回身份无关。

### CFG-9.2
- **状态**：未实现
- **证据**：
  - 前提缺失：无个人 PAT（见 CFG-9.1），因此「退回 bot 身份」在本身份模型下**不存在可退回的另一侧**。与 GitHub 相关的「回退」只有 `github-auth.ts:86-95` 的 `degraded`（App 半配置时「暂用 PI_BOT_GITHUB_TOKEN 兜底」），那是 **App → 静态 token**，不是「个人 → bot」。
  - 缺失态：`apps/server/src/app/worker-deps.ts:451-455` 在 `config.github.token === null` 时返回 `createUnavailableGithubWriteApi('未配置 PI_BOT_GITHUB_TOKEN')`，其 `fail`（`:103-123`）抛 `AppError('GitHub 写面不可用：…', { failureClass: 'unknown', retriable: false })`。**只覆盖「连 bot 凭据都没有」**，不覆盖「个人 PAT 缺失」。
  - 失败原因呈现：`apps/server/src/worker/writeback.ts:634-661` 失败时写 `actions.audit = { status:'failed', reason, failureClass, httpStatus }`；但查询层 `apps/server/src/queries/tasks.ts:395-409` 只把 `audit` 映射成 `declared/actual/intersect/dropped/rejectedReason` 五项，**`reason` 被丢弃**；契约 `packages/contract/src/api.ts:331-342` 也无 `reason` 字段。面板因此只能看到状态徽章（`apps/panel/src/routes/task-detail.tsx:356` 的 `action.status`）、闸门计数与 `rejectedReason`（`:363-373`），**看不到失败原因文本**；聚合层只剩粗粒度 `failure_class`（`task-detail.tsx:187`）。
  - scope 不足 / 已过期：`apps/server/src/github/errors.ts:129-132` 把 401 与非限流的 403 统一归 `auth`（限流判定见 `errors.ts:88` 的 `RATE_LIMIT_MESSAGE_PATTERN`），不做「scope 不足」与「已过期」的区分；`describeGithubError`（`errors.ts:167-173`）只拼 `[class] HTTP <status> <message> (retry)`，全仓除测试外**无调用方**。过期只对 **installation token** 有处理（`apps/server/src/github/auth.ts:70` 的 `DEFAULT_TOKEN_TTL_SKEW_MS`、`:205-231` 的缓存续期），语义是「自动续期」，不是「显式报错」。
- **缺口**：
  1. 「缺失」：只有 bot 凭据整体缺失时才硬失败；个人 PAT 缺失这一态无法发生，也无法呈现。
  2. 「scope 不足」：无 scope 读取与判别；403 一律归 `auth`，最终压成 `auth` / `github_api` 失败类，**没有「权限不足，需要 issues: write」这类显式原因**。
  3. 「已过期」：个人 PAT 连存都没存，无过期信息可判；可判的只有 installation token，且行为是静默续期而非显式呈现。
  4. 「退回 bot 身份」：无实现（单身份模型下不存在该分支）。
  5. 「不得静默失败」：写失败有 `actions` 行与事件留痕（不算完全静默），但**原因文本在契约层被裁掉**，对面板等于半静默。
- **判定依据**：本条要求对个人令牌的三种不可用态逐一显式呈现并回退。逐态核对结果：三种态均无判别代码，回退分支不存在，原因文本不可达面板。子条件全部缺失 → 未实现；且不是「部分实现」，因为主体（个人令牌状态机）整体缺失。
- **反证过程**：
  1. **假设三态都在某处实现**：逐态搜——`scope` / `Scopes` 在 `apps/`、`packages/` 内只命中 Fastify `scope`、`skillScopeSchema`、`EVENT_SCOPES` 等无关同名；「过期」仅命中 installation token TTL、`runtime_flags.until` 与面板会话过期（`http/api/auth.ts:97-99`，那是**面板会话**，不是 GitHub 令牌）。三态均无实现，假设被推翻。
  2. **假设「静默失败」已避免**：`writeback.ts:646-658` 确实写了 `applied_at=null` + `audit.reason`，看似达标；但继续追消费方 → `queries/tasks.ts:400-409` 的 `audit` 白名单不含 `reason`，契约 `api.ts:332-342` 也 `.strict()` 无 `reason`，面板 `task-detail.tsx:344-374` 只渲染 `status` / 闸门计数 / `dropped` / `rejectedReason`。**写了但读不到**，按证据口径 2「有写入 ≠ 生效」。假设被推翻。
  3. **假设「403 被当成权限不足显式呈现」**：`errors.ts:88` 的 `RATE_LIMIT_MESSAGE_PATTERN`（`/rate limit|secondary rate|abuse detection/i`）只用于排除限流，其余 403 归 `auth`（`errors.ts:131-132`）；`failure.ts:116-129` 再把它压成 `failureClass: 'auth' | 'github_api'` 与一句「GitHub 写失败：auth（HTTP 403）…」。这是**按 HTTP 码分类**，不是按 scope / 过期判因，且该文本同样进不了面板（见第 2 点）。假设被推翻。
  4. **假设「退回 bot」= `degraded` 分支**：`github-auth.ts:86-95` 的回退是 App 半配置 → 静态 token，两侧都是**部署级凭据**，与「个人 PAT 不可用时退回 bot 署名」不是同一件事；用错对象不算达标。
  5. **结论区分**：与 CFG-9.1 同源——**整个概念不存在**，不是「有一半」。若将来加个人 PAT，本条所需的三态判别与原因透出（契约加 `reason`、查询层放行、面板渲染）都还要新建。

## 本节整体结论

本节两条都不能判「已实现」，也都不能判「部分实现」：代码里的身份模型是 app / 部署级静态 token / none / degraded 四种**部署级**模式（`github-auth.ts:21`），全仓不存在「按用户存的个人 PAT」这一概念——没有存储列、没有面板入口、没有按用户切换的写路径、没有 scope / 过期校验，AES-GCM 加密的对象是 pi-host 设备令牌而非 PAT。因此 CFG-9.1 的三块（个人身份写回、手动填 PAT、检查权限）全缺；CFG-9.2 的三种失败态在该身份模型下不可能发生，「回退到 bot」也没有另一侧可退回，且写失败的原因文本在查询层与契约层被裁掉，面板只看到 `failed` 徽章。本节整体判定为**未实现**。

## 核查边界
- 是否执行了命令：**未执行测试 / 构建 / 类型检查**，纯静态核查。执行过的只读检索：`git status --short`（与 `_baseline.txt` 一致）；`Select-String` / `Grep` 全仓搜 `X-OAuth-Scopes|oauth-scope|scopes|checkToken|GET /user|getAuthenticated`、`PAT|个人|identity|token`、`检查权限|校验令牌`、`aes-256-gcm|createCipheriv`、`PI_BOT_GITHUB_TOKEN|github.token|config.github`、`githubAuthMode`、`/api/*` 路由表、`migrations/*.sql` 的 `token|identity|CREATE TABLE`、`package.json` 的 octokit 依赖；并逐文件读了 `apps/server/src/github/auth.ts`、`github/errors.ts`、`app/github-auth.ts`、`app/config.ts`、`app/compose.ts`、`app/worker-deps.ts`、`worker/writeback.ts`、`worker/failure.ts`、`queries/tasks.ts`、`db/schema.ts`、`runtime/bootstrap.ts`、`http/api/auth.ts`、`http/api/index.ts`、`packages/contract/src/api.ts`、`apps/panel/src/layout/nav.ts`、`apps/panel/src/components/settings/general-section.tsx`、`apps/panel/src/routes/task-detail.tsx`、`apps/panel/src/routes/system.tsx`。
- 未覆盖的条目及原因：无（CFG-9.1、9.2 均覆盖）。真 GitHub 侧行为（例如现配的静态 token 是否真有 `issues: write`）未验证，但那不影响本条判定。
- 发现的额外问题（不属本节范围）：
  - **写失败原因对面板不可达**（越出本节，但影响 BR-7「失败可见」）：`worker/writeback.ts:652-657` 写入 `audit.reason`，`queries/tasks.ts:400-409` 与 `packages/contract/src/api.ts:331-342` 都放行不到面板。
  - `describeGithubError`（`github/errors.ts:167-173`）无生产调用方，`[auth] HTTP 403 …` 这类人读原因只出现在测试里。
  - `/api/system` 完全没有 GitHub 认证状态字段（`packages/contract/src/api.ts:646-724`）；认证模式只进宿主日志（`app/config.ts:456` 的 `githubTokenConfigured`、`app/compose.ts:662-664` 的 `githubAuthMode`、`compose.ts:1488` 的 `describeAppConfig`）。
  - 会话身份与写回身份是两套东西：`panel_sessions.login`（`db/schema.ts:565-568`）已有「当前登录的 GitHub 用户」，但写回侧从不消费它——「以谁的身份写回」所需的用户标识其实已存在，缺口在凭据存储与装配，不在身份来源。
