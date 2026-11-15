# U22 6.9 面板身份（GitHub 令牌） · A

> 核查范围：docs/requirements.html 行 1762-1773
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览

| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| CFG-9.1 | 部分实现 | 「默认 bot 署名」成立；但「个人 PAT」无存储位、无 CRUD、无身份切换点，「检查权限」连调用 GitHub 的接口都没有 |
| CFG-9.2 | 未实现 | 缺失 / scope 不足 / 已过期三种失败态与「退回 bot 身份」全无对应分支——因为没有个人身份可退 |

## 逐条

### CFG-9.1

- **状态**：部分实现
- **证据**：
  - `apps/server/src/app/compose.ts:759` — 写面注释与实现同处：写面优先用 App 认证的客户端，「评论/打标会显示成 `<app-slug>[bot]`」；`apps/server/src/app/compose.ts:761` 才是真代码 `{ github: createGithubWriteApi(baseGithubClient) }`。**这半边（默认 bot 署名）有实现路径。**
  - `apps/server/src/app/github-auth.ts:56` — App 认证（appId + privateKey + installationId）取 installation token 作为身份来源；`:98` 才是 `<appId === null && token !== null>` 的静态 token 兜底；`:106` 两者皆无 → `none`。
  - `apps/server/src/app/config.ts:155` — `readonly github: { token, appId, privateKeyPath, installationId, mention }`，`:72-79` 全是**部署级 env**（`PI_BOT_GITHUB_TOKEN` / `PI_BOT_GITHUB_APP_*`），**没有任何按用户的 PAT 字段**。
  - `apps/server/src/db/schema.ts:146` — `repos` 表 14 个数据列（`:147-173`）里没有 token / pat / identity 一类列；`migrations/0000_init.sql:91` 同形。全库唯一的密文令牌表是 `host_credentials.token_enc`（`db/schema.ts:518`），那是 RACP 设备令牌，与 GitHub 身份无关。
  - `apps/server/src/http/api/index.ts:295-358` — 面板写面只有 `GET/POST /api/repos`、`GET/PUT /api/repos/:owner/:name/settings`、`POST /api/skills/*`；**不存在填 PAT / 检查权限 / 切换身份的路由**。
  - `apps/panel/src/layout/nav.ts:73` — 设置分区只有 `general` / `events` / `labels` / `execution` 四项，无「身份 / 令牌」分区；`apps/panel/src/components/settings/general-section.tsx:24` 的「仓库身份」是**仓库来源与 installationId 的只读展示**，不是操作者身份。
- **缺口**：
  1. **个人 PAT 这个实体不存在**：无存储位（DB 无列、env 无键、契约无字段）、无 CRUD（无 API 路由、无面板表单）、无身份切换点（写面在 `compose.ts:761` 与 `worker-deps.ts:455` 一次性定型，运行期无第二个身份可选）。
  2. **「以该用户身份提交评论」无法发生**：写回只经 `createGithubWriteApi(baseGithubClient)`（`compose.ts:761`），client 的凭据来自 App installation token 或部署级静态 token（`github-auth.ts:81` / `:101`），二者都不带操作者 login。
  3. **`issues: write` 权限无从校验**：既然没有个人令牌，就没有可施加 `issues: write` 的对象。
  4. **「检查权限」功能完全缺失**：全仓（`apps/server/src`、`apps/panel/src`、`packages/contract/src`）检索 `X-OAuth-Scopes` / `x-oauth-scopes` / `scopes` / `getAuthenticated` / `users.getAuthenticated` 均无命中；`github/errors.ts:112-140` 只搬运 `x-github-request-id` 与限流头，从不读 scope 头。**因此「校验 scope 与过期时间」的接口、按钮、返回结构都不存在。**
  5. 关于「不做 OAuth device flow」：仓库确实没有 device flow（`app/compose.ts:644` 与 `http/api/auth.ts:15` 的 OAuth 都是面板登录侧的 TODO，与个人 PAT 无关），这条「不做」是被动满足，不构成实现证据。
- **判定依据**：需求本条由四个子条件组成——(a) 未配个人令牌时以 bot 署名、(b) 配了个人 PAT 以该用户身份提交评论、(c) 手动填 PAT 不做 device flow、(d) 提供「检查权限」校验 scope 与过期时间。(a) 有明确实现路径（`compose.ts:759-761` + `github-auth.ts:56-83`，且 `worker-deps.ts:540` / `execute.ts:375` 有 `isOwn(appSlug)` 识别自身 bot login），故本条不是「未实现」；但 (b) (c) (d) 三个子条件在存储、CRUD、身份切换、scope 校验四个层面全无落地，故只能判**部分实现**，且缺的正是招牌功能「可切换为个人账号」。

### CFG-9.2

- **状态**：未实现
- **证据**：
  - `apps/server/src/app/worker-deps.ts:103` — 唯一的「令牌不可用」分支是 `createUnavailableGithubWriteApi(reason)`：**整个写面替换成一个「一调就抛」的桩**，调用点在 `worker-deps.ts:454`，`reason` 是 `'未配置 PI_BOT_GITHUB_TOKEN'`（同一字面量也出现在 webhook 回执桩 `compose.ts:888` 上）。它处理的是「部署级令牌缺失 → 写面整体不可用」，**不是「个人令牌不可用 → 退回 bot」**，方向相反：这里是把 bot 自己关掉了。
  - `apps/server/src/github/errors.ts:131` — `status === 401 || status === 403` 统一归 `'auth'` 类，`:17` 的注释把「权限不足 / 令牌失效 / 安装被移除」并成一类。**scope 不足与已过期是两个需求明写的失败态，代码里没有把它们区分出来的分支**，只有一个笼统的 401/403。
  - `apps/server/src/worker/writeback.ts:645` — 失败留痕是 `applied_at = null` + `audit.reason`，`:654-655` 把 `reason` 与 `failureClass` 写进审计。这是「失败可见」的通用机制（对应 BR-7），**不是** CFG-9.2 要求的三态显式呈现。
  - `packages/contract/src/api.ts:646` — `/api/system` 响应无任何 GitHub 令牌 / 身份字段；令牌状态只在进程日志里（`app/config.ts:456` `githubTokenConfigured`、`compose.ts:662-664` `githubAuthMode`）。**面板侧读不到「令牌为什么不可用」。**
- **缺口**：
  1. **三种失败态无一被显式区分**：缺失有桩（`worker-deps.ts:103`）但语义相反；scope 不足与已过期在 `github/errors.ts:131` 被并入同一个 `'auth'`，没有独立判定、没有独立文案。
  2. **「退回 bot 身份」这个动作没有实现，也无法实现**：需要「当前身份 ≠ bot」这个前提，而系统里只有一个身份（App / 部署 token）。`compose.ts:761` 的写面在装配期就唯一确定，运行期不存在可回退的第二身份。
  3. **「写回失败原因显式呈现」没有面向面板的通道**：`/api/system`（`api.ts:646-722`）不含身份字段，面板无任何组件渲染令牌状态（检索 `apps/panel/src` 的 `githubToken` / `authMode` 零命中；`令牌` 的 5 处命中全是 CSS 设计令牌，如 `components/settings/form.tsx:11`，与 GitHub 无关）。
- **判定依据**：本条的三个子条件——(a) 缺失 / scope 不足 / 已过期三态显式呈现、(b) 退回 bot 身份、(c) 不得静默成功也不得静默失败——(a) 只有最粗的「部署级令牌缺失 → 写面不可用」一个桩且方向相反，(b) 完全没有可退避的身份对，(c) 有通用失败留痕（`writeback.ts:645-655`）但不针对身份语义。三者均不满足，且缺的是整条需求的骨架，故判**未实现**。

## 本节整体结论

本节**不能**判为「已实现」。CFG-9.1 只有「默认 bot 署名」这一半是真的（App 认证 + `isOwn` 识别），另一半即需求标题所指的「可切换为个人账号」在存储、CRUD、身份切换点、scope 校验四处全空——个人 PAT 在系统里**不作为实体存在**。CFG-9.2 依赖 CFG-9.1 的个人身份才有意义，因此三态呈现与「退回 bot」同样落空；现存代码里最近似的两处（`createUnavailableGithubWriteApi` 与 401/403 归 `auth`）都是部署级、笼统的，不能顶替。建议在实现个人 PAT 之前，本节整体记为未交付。

## 核查边界

- 是否执行了命令：执行了只读检索，均为静态核查，未运行测试、未连数据库、未连 GitHub。具体为：`Get-ChildItem -Recurse ... | Select-String`（在 `apps/server/src`、`apps/panel/src`、`packages/contract/src` 上检索 `personal|PAT|githubToken|scopes|X-OAuth|getAuthenticated|identity|个人|令牌`，命中项已逐条读取核对）、`Select-String -Path migrations/0000_init.sql -Pattern "CREATE TABLE"`（确认 16 张表无 GitHub 令牌列）、`Test-Path docs/audit/v2/U22`（原本不存在，已创建目录）。未执行 `pnpm test` / `pnpm -r typecheck`。
- 未覆盖的条目及原因：无。本节分配的 CFG-9.1、CFG-9.2 两条均已取证完毕。需要真 GitHub 才能确认的部分（如「配置了个人 PAT 后评论确实署名为该用户」）因功能本身不存在而无从验证，已计入缺口而非「无法判定」。
- 发现的额外问题（不属本节范围但值得记录）：
  1. **面板登录侧的 OAuth 是 TODO，且与本节的 GitHub 写身份是两套东西**：`apps/server/src/http/api/auth.ts:15` 与 `apps/server/src/app/compose.ts:952` 都留着「OAuth + isOrgMember 待接」的 TODO；`compose.ts:644` 因此允许 `PI_BOT_PANEL_AUTH=off`。若将来实现个人 PAT，需要明确它与面板登录身份是否共用一份凭据——目前看两者独立，容易做成两份真相。
  2. **`/api/system` 缺身份/令牌状态段**：`packages/contract/src/api.ts:646-722` 的 `systemResponseSchema` 是被 `.strict()` 钉住的，令牌状态只进日志（`config.ts:456`）。这不只影响 CFG-9.2，也让任何「面板上显示 GitHub 连通性」的需求都缺通道。
  3. **`PI_BOT_GITHUB_TOKEN` 的定位已在代码注释里自我降级**：`app/config.ts:72` 写「只用于 webhook 的 10 秒应答；worker 的写面走 App 认证」，而 `worker-deps.ts:455` 实际仍用它造写面。注释与实现不一致，若后续要在此处接个人 PAT，需先纠正这个错位。
