# WP9 供应商与模型角色 + 面板身份（CFG-8.1 / 8.2 / 8.3 / 9.1 / 9.2 / AC-32）实现报告

- 需求依据：`docs/requirements.html` §6.8（表 1742–1759）、§6.9（表 1762–1773）、AC-32（表 1880）
- 审计依据：`docs/audit/v2/_unimplemented.md` §1.1 第 1/2/3/4/5 行、§1.3 第 16 行
- 基线：`docs/audit/fix/_baseline-fix.txt`（HEAD `fbfa029`，工作区已有改动未回滚）
- 本报告只覆盖 WP9。**需求文档未改**，**未 `git add` / `git commit`**

---

## 一、逐条对照

| 编号 | 需求原文（摘） | 改前 | 改后 | 证据 |
|---|---|---|---|---|
| **CFG-8.1** 供应商一条一行 | 「名称、base URL、key（界面只显示掩码与「已存/未配置」）、连通性（状态点 + 延迟，可手动测试）、该家可用的 model 列表。key 加密存储…解密失败必须报错，不许静默当成「未配置」」 | 全仓无供应商实体；只有部署级 env 三元组（`config.model.{apiKey,baseUrl,name}`，`app/config.ts:181-188`） | 新表 `model_providers`（`db/schema.ts:857-893`）：`id/name/base_url/key_enc/key_mask/models jsonb/enabled/status/latency_ms/checked_at/check_error`。key 只存 AES-256-GCM 密文 + 掩码（`saveProvider`→`encryptSecret`，`config/model-settings.ts:262-266`）；解密失败抛 `CRYPTO_DECRYPT_FAILED`（`readProviderKey` `:190-210`）。连通性 `POST /api/settings/providers/:id/check`（`http/api/settings.ts:196-249`） | `apps/server/src/config/model-settings.ts:120-330`；`apps/server/src/db/schema.ts:855-900` |
| **CFG-8.2** 模型角色四档 + 单价 | 「四个角色各绑定「供应商 + 模型」：`agent`、`format`、`classify`、兜底。每档显示输入 / 输出单价」 | 无角色概念；价目是写死两档常量（`cost/pricing.ts:29-32`） | 新表 `model_roles`（角色→供应商+模型）；单价挂在**模型目录**（`model_providers.models` 的 `[{model, price:{input_usd_per_mtok,output_usd_per_mtok}}]`）。`estimateDeepSeekCostUsd({ resolvePrice })` 优先用配置单价、`pricingSource: 'config'`，取不到退回官价表 `'static'`（`cost/pricing.ts:146-175`）；`createConfigPriceResolver` 把目录变成解析器（`cost/price-resolver.ts`） | `packages/contract/src/settings-v21.ts:711-800`；`apps/server/src/cost/pricing.ts:101-199`；`apps/server/src/cost/price-resolver.ts`；`apps/server/src/worker/run-task.ts:1614-1621` |
| **CFG-8.3** 全局默认 + 项目覆盖 | 「模型角色在全局配置；项目级『执行』里显示『继承全局（模型名）』，点开才允许覆盖。两处不并列摆放可直接选择的模型下拉」 | `repos.settings.model` 是**死字段**（`packages/contract/src/repo-config.ts:225-226`），全仓无读取 | 新表 `repo_model_roles`：**没有行 = 继承**，有行 = 覆盖（`repo_model_roles_repo_role_pk`）。契约 `modelRoleSelectionSchema` 是判别联合 `{mode:'inherit'} \| {mode:'override',provider_id,model}`（`settings-v21.ts:774-816`）。生效值唯一解析点 `resolveEffectiveRole()`（`config/model-settings.ts:487-517`），项目优先否则全局；`GET /api/repos/:owner/:name/models` 在 `inherit` 时把**全局值**填进 `effective`（`http/api/settings.ts:288-333`），面板据此显示「继承全局（模型名）」。执行面：`hostModelRoleEnv()` 把四档模型名写进 pi-host 环境（`app/model-env.ts:84-136`），`app/compose.ts` 启动 Host 时叠加 |
| **CFG-9.1** 面板身份（个人 PAT） | 「配置了个人 PAT 后，以该用户身份提交评论，需要 `issues: write` 权限…提供『检查权限』校验 scope 与过期时间」 | 身份模式只有 `app` / 部署级 `token` / `none` / `degraded`（`app/github-auth.ts:21`）；`X-OAuth-Scopes` / `getAuthenticated` 全仓 0 命中 | 新表 `panel_identities`（`login/token_enc/token_mask/scopes/token_expires_at/status/checked_at/check_detail`）。`PUT /api/settings/identity` 存 PAT（密文+掩码）；`POST /api/settings/identity/:login/check` 打 `GET /user` 读 `x-oauth-scopes` 与 `github-authentication-token-expiration`（`app/github-auth.ts:114-176` 的 `createGithubIdentityProbe`），落 scope 快照 + 三态；`createPersonalGithubClient()` 是「以该用户身份说话」的客户端（`github-auth.ts:152-158`） |
| **CFG-9.2** 令牌三态 + 退回 bot | 「令牌缺失、scope 不足或已过期时，写回失败原因要显式呈现，并退回 bot 身份；不得静默成功，也不得静默失败」 | 无个人 PAT 概念，三态不可能发生 | 三态判定的**唯一实现** `classifyIdentityState()`（`packages/contract/src/settings-v21.ts:871-899`）：`missing` / `insufficient-scope` / `expired`（另有 `ok` / `unchecked`）。`GET /api/settings/identity` 返回 `effective: 'bot'\|'user'` + `effective_reason`（显式呈现）；新表 `identity_fallbacks` 落「退回 bot」留痕，`GET /api/settings/identity/fallbacks` 可查。scope 等价集把经典 PAT 的 `repo` 认作满足 `issues:write`（避免假阴性） |
| **AC-32** 全局设置页（契约面） | 「供应商的 base URL、key 掩码、连通性与可用 model；四档模型角色各显示输入 / 输出单价；项目页显示『继承全局』而非并列的模型下拉」 | 依赖 CFG-8.1/8.2/8.3，全部不存在 | 契约与 API 齐备（见 §四 面板字段清单）；面板 UI 归 WP11 |

---

## 二、新表与新迁移全文

### `migrations/0013_wp9_model_providers.sql`（新建 5 张表）

```sql
CREATE TABLE IF NOT EXISTS "model_providers" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "base_url" text,
  "key_enc" text,
  "key_mask" text,
  "models" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "enabled" boolean NOT NULL DEFAULT true,
  "status" text NOT NULL DEFAULT 'unknown',
  "latency_ms" integer,
  "checked_at" timestamp with time zone,
  "check_error" text,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "model_roles" (
  "role" text PRIMARY KEY,
  "provider_id" text NOT NULL,
  "model" text NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "repo_model_roles" (
  "repo" text NOT NULL,
  "role" text NOT NULL,
  "provider_id" text NOT NULL,
  "model" text NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "repo_model_roles_repo_role_pk" PRIMARY KEY("repo", "role")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repo_model_roles_repo_idx" ON "repo_model_roles" ("repo");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "panel_identities" (
  "login" text PRIMARY KEY,
  "token_enc" text NOT NULL,
  "token_mask" text NOT NULL,
  "scopes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "token_expires_at" timestamp with time zone,
  "status" text NOT NULL DEFAULT 'unchecked',
  "checked_at" timestamp with time zone,
  "check_detail" text,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "identity_fallbacks" (
  "id" bigserial PRIMARY KEY,
  "login" text,
  "state" text NOT NULL,
  "operation" text NOT NULL,
  "target" text NOT NULL,
  "reason" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_fallbacks_created_at_idx" ON "identity_fallbacks" ("created_at");
```

### `migrations/0015_panel_identity_scopes_nullable.sql`（`scopes` 放宽为可空）

```sql
ALTER TABLE "panel_identities" ALTER COLUMN "scopes" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "panel_identities" ALTER COLUMN "scopes" DROP DEFAULT;
```

**为什么拆成 0015 而不是直接改 0013**：0013 已在测试库/目标机应用过，改文件内容会让
`schema_migrations` 的 sha256 校验失败（AGENTS §7.1「已应用文件 sha256 变了就拒绝启动」）。
`NULL` = 还没检查过（`unchecked`），`[]` = 检查了但一个 scope 都没有 —— 两者混同会让
「刚存进去的令牌」显示成「权限不足」（这是实现时被自己的用例抓到的真实缺陷）。

### 数据库约束遵守情况
- 只建表/加索引，**未改任何旧列**；**不建外键**；时间列一律 `timestamptz`
- 全部 `IF NOT EXISTS` / 幂等 DDL；未跑 `drizzle-kit generate`
- `0012_wp7_session_system_prompt.sql`、`0014_wp2_session_domain.sql` 未触碰

---

## 三、API 签名

写接口全部走 `writeGuard`（鉴权 + `PI_BOT_PANEL_WRITE` + 来源 + `X-Pi-Bot-CSRF`）；
**不注入 `deps.settings` 时这组路由整组不存在**（`http/api/index.ts:318-338`）。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/settings/providers` | — | `ModelProvidersResponse { items: ModelProvider[] }` |
| PUT | `/api/settings/providers/:id` | `SaveModelProviderRequest { name?, base_url?, key?, clear_key?, models?, enabled? }` | `ModelProvider` |
| POST | `/api/settings/providers/:id/check` | 无 body | `ProviderCheckResponse { provider_id, status, latency_ms, checked_at, error, models }`（**失败也 200**） |
| GET | `/api/settings/models` | — | `ModelRolesResponse { items: ModelRoleRow[4] }` |
| PUT | `/api/settings/models/:role` | `SaveModelRoleRequest { provider_id, model }` | `{ ok: true }` |
| GET | `/api/repos/:owner/:name/models` | — | `RepoModelRolesResponse { repo, items: RepoModelRoleRow[4] }` |
| PUT | `/api/repos/:owner/:name/models/:role` | `SaveRepoModelRoleRequest { mode:'inherit' } \| { mode:'override', provider_id, model }` | `{ ok: true }` |
| GET | `/api/settings/identity` | — | `PanelIdentityResponse { effective, effective_reason, identity, generated_at }` |
| PUT | `/api/settings/identity` | `SavePanelIdentityRequest { login, token }` | `{ ok: true, identity }` |
| POST | `/api/settings/identity/:login/check` | 无 body | `IdentityCheckResponse { identity, remote_checked, generated_at }` |
| DELETE | `/api/settings/identity/:login` | 无 body | `{ ok: true, deleted }` |
| GET | `/api/settings/identity/fallbacks` | `?from&to&login&cursor&limit` | `IdentityFallbacksResponse { items, nextCursor, hasMore }` |

错误语义：供应商不存在 / 没存过 PAT → 404；`key` 与 `clear_key` 同时给、模型不在目录里 → 400；
未注入探测端口 → 503（**不假成功**）。

---

## 四、面板需要读的契约字段（转给 WP11 —— AC-32）

全部来自 `packages/contract/src/api.ts`（`openapi/pi-bot.openapi.json` 的组件名同右列）。

### 4.1 全局设置页 · 供应商表格（`GET /api/settings/providers`）

| 需求项 | 字段路径（`items[]` 每行） | 组件 |
|---|---|---|
| 名称 | `items[].name` | `ModelProvider.name` |
| base URL | `items[].base_url`（`null` = 用 pi-host 默认端点） | `ModelProvider.base_url` |
| key 掩码 | `items[].key_mask` | `ModelProvider.key_mask` |
| 「已存 / 未配置」 | `items[].key_configured`（`false` → 显示「未配置」） | `ModelProvider.key_configured` |
| 连通性状态点 | `items[].status`（`'ok' \| 'fail' \| 'unknown'`） | `ModelProvider.status` |
| 连通性延迟 | `items[].latency_ms`（毫秒；**`null` = 没测过或失败**，不要当 0） | `ModelProvider.latency_ms` |
| 上次测定时刻 | `items[].checked_at` | `ModelProvider.checked_at` |
| 测定失败原因 | `items[].check_error` | `ModelProvider.check_error` |
| 该家可用 model | `items[].models[].model` | `ModelProvider.models` → `ModelCatalogEntry` |
| 该 model 单价 | `items[].models[].price.input_usd_per_mtok` / `.output_usd_per_mtok` | `ModelPrice` |
| 编辑时回填 | `items[].id`（`PUT` 的路径片段）、`items[].enabled` | `ModelProvider.id` |

> **明文 key 永不返回**：契约里没有 `key` / `key_enc` 字段，面板无法也不该读到真值。
> 保存时 `PUT` 传 `key`（明文）或 `clear_key: true`；两者同时给会被拒。

### 4.2 全局设置页 · 四档角色 + 单价（`GET /api/settings/models`，固定 4 行）

| 需求项 | 字段路径 | 组件 |
|---|---|---|
| 档位（固定顺序 agent/format/classify/fallback） | `items[].role` | `ModelRoleRow.role` |
| 是否已配 | `items[].configured`（`false` → 显示「未配置」，**仍然渲染这一行**） | `ModelRoleRow.configured` |
| 绑定的供应商 | `items[].provider_id` / `items[].provider_name` | `ModelRoleRow` |
| 绑定的模型 | `items[].model` | `ModelRoleRow.model` |
| **输入单价** | `items[].price.input_usd_per_mtok` | `ModelPrice` |
| **输出单价** | `items[].price.output_usd_per_mtok` | `ModelPrice` |
| 单价未知（目录里没这个模型） | `items[].price === null` → 显示「单价未知」，**不要显示 $0** | `ModelRoleRow.price` |

### 4.3 项目页「执行」· 继承 / 覆盖（`GET /api/repos/:owner/:name/models`，固定 4 行）

| 需求项（CFG-8.3） | 字段路径 | 说明 |
|---|---|---|
| 「继承全局（模型名）」 | `items[].selection.mode === 'inherit'` + `items[].effective.model` | 文案直接用 `effective` 里的模型名：**「继承全局（deepseek-v4-pro）」** |
| 覆盖态 | `items[].selection.mode === 'override'`，`selection.provider_id` / `selection.model` | 此时显示下拉与「恢复继承」按钮 |
| 生效中的单价 | `items[].effective_price`（`null` = 单价未知） | 覆盖后单价仍然查得到（单价挂在模型上） |
| 写回 | `PUT .../models/:role`，body `{ mode:'inherit' }`（删覆盖行）或 `{ mode:'override', provider_id, model }` | **不要**把「继承」表达成空字符串/空对象 |

> 「两处不并列摆放可直接选择的模型下拉」由面板实现：项目页默认只读展示 `selection.mode === 'inherit'`
> 的那一行（点开才变成下拉）；契约已保证两种状态可区分。

### 4.4 面板身份（`GET /api/settings/identity`、`POST /api/settings/identity/:login/check`）

| 需求项 | 字段路径 | 说明 |
|---|---|---|
| 默认 bot | `effective === 'bot'` + `effective_reason` | 未配 PAT 时的一切写回署名；`identity === null` |
| 切换为个人账号 | `effective === 'user'` | 此时 `effective_reason` 形如「以 alice 身份提交评论与写回」 |
| 退回原因显式呈现（CFG-9.2） | `effective_reason`（一句话）、`identity.state_reason` | 例：「个人 PAT 缺 issues:write 权限，已退回 bot 身份」 |
| 三态 | `identity.state`：`'ok' \| 'missing' \| 'insufficient-scope' \| 'expired' \| 'unchecked'` | `unchecked` = 存了但还没点「检查权限」，**不要画成绿色** |
| key 掩码 | `identity.token_mask` | 明文永不返回 |
| 缺哪些 scope | `identity.missing_scopes[]`（如 `["issues:write"]`） | 「检查权限」后可展示具体缺项 |
| scope 快照 | `identity.scopes[] \| null`（`null` = 还没检查过） | 与 `unchecked` 配套 |
| 过期时间 | `identity.token_expires_at` | `null` = GitHub 说不过期 |
| 「检查权限」按钮 | `POST /api/settings/identity/:login/check` → `IdentityCheckResponse.remote_checked` | 真实打了 GitHub 才是 `true` |
| 退回留痕（可查） | `GET /api/settings/identity/fallbacks` → `items[].{state, operation, target, reason, created_at, login}` | 面板展示「最近为什么是以 bot 署名」 |

### 4.5 面板写请求必须带的头

`X-Pi-Bot-CSRF: 1`（+ 同源/loopback 来源）。缺它一律 403，且不改库。

---

## 五、命令与真实输出

```text
$ cd apps/server; npx tsc --noEmit
（exit 0，无输出）

$ cd packages/contract; npx tsc -p tsconfig.json --noEmit
（exit 0，无输出）

$ pnpm -r typecheck
apps/panel typecheck: Done
apps/server typecheck: Done
packages/contract typecheck: Done
packages/envelope typecheck: Done
packages/racp-client typecheck: Done
packages/shared typecheck: Done
（exit 0）

$ cd packages/contract; npx vitest run
 Test Files  7 passed (7)
      Tests  152 passed (152)

$ cd apps/server; npx vitest run test/db-schema.test.ts
 Test Files  1 passed (1)
      Tests  22 passed (22)          ← 断言已同步为 29 张表

$ cd apps/server; npx vitest run \
    test/model-settings.test.ts test/http-settings.test.ts test/settings-identity.test.ts \
    test/db-schema.test.ts test/cost-pricing.test.ts test/app-github-auth.test.ts test/app-model-endpoint.test.ts
 Test Files  7 passed (7)
      Tests  101 passed (101)

$ pnpm gen:openapi
openapi: 9 paths / 77 schemas -> C:\Code\NodeProjects\pi-issue-bot\openapi\pi-bot.openapi.json
（20 个 WP9 组件逐一核对均已在 `components.schemas` 中：ModelProvider / ModelProvidersResponse /
  SaveModelProviderRequest / ProviderCheckResponse / ModelRoleRow / ModelRolesResponse /
  SaveModelRoleRequest / ModelRoleSelection / ModelTarget / ModelCatalogEntry / ModelPrice /
  RepoModelRoleRow / RepoModelRolesResponse / SaveRepoModelRoleRequest / PanelIdentity /
  PanelIdentityResponse / SavePanelIdentityRequest / IdentityCheckResponse / IdentityFallbackRow /
  IdentityFallbacksResponse）

$ npx eslint <WP9 涉及的 23 个文件>
（exit 0，0 problems）

$ pnpm lint
✖ 6 problems (0 errors, 6 warnings)
  （6 条 warning 全在 scripts/spike/**，是既有的运维脚本，非本次改动）
（exit 0）
```

期间 `pnpm lint` 曾短暂报过一条 error，但两次分别落在 `http/webhook.ts:81`（未使用变量）与
`test/agent-events.test.ts:290`（解析错）——都是并行 session 正在写入的文件，等其落盘后即恢复
0 error。WP9 自己的 23 个文件单独 `npx eslint` 全程 exit 0、0 problems。


---

## 六、跳过项与残余风险

### 6.1 明确的外部依赖（做不到的部分，逐条写清）

| 能力 | 现状 | 缺什么 |
|---|---|---|
| **`format` / `classify` / `fallback` 三档运行期生效** | 配置与面板齐备；`hostModelRoleEnv()` 已把它们写进 pi-host 环境（`PI_BOT_MODEL_FORMAT_NAME` 等），但 RACP 协议当前**没有对应槽位**（`session/create` 只带 `systemPrompt`，`turn/start` 只带 `input.text`） | 需要 pi-host 侧协议支持「按角色请求模型」。**执行档 `agent` 已真实生效**（覆盖 `PI_BOT_MODEL_NAME` / `OPENAI_MODEL`） |
| **项目级覆盖在 worker 单次任务内生效** | `resolveEffectiveRole()` + `createDbModelRoleResolver()` 已提供唯一解析入口；但 pi-host 是**进程级常驻**（一份 Host，启动时传环境变量），任务级换模型需要 RACP 支持 per-session 模型参数 | 同上一行，同一个协议缺口 |
| **供应商连通性探测的「可用 model 清单回填」** | `POST .../check` 只判断连通性与延迟（`GET {baseUrl}/models` 的 2xx），**不解析**返回体覆盖目录 | 各供应商 `/models` 返回形状不一致（OpenAI `{data[].id}` / Gemini `{models[].name}`），现在不猜；`ProviderCheckResponse.models` 刻意返回 `null`。要回填需按供应商类型写适配 |
| **多人同时配 PAT** | `GET /api/settings/identity` 取**第一行**（login 升序）并说明；写回通道（worker → GitHub）此刻没有「谁在操作」这个概念 | 需要 `tasks` / 写回链路带上 operator 身份。已在契约里保留多身份的能力（`listIdentities`），只差调用侧接线 |
| **提交身份真正落到 GitHub 写回** | `createPersonalGithubClient()` 已就绪，但 worker 的 `GithubWriteApi` 目前只有 bot 一份 | 需要 WP 层的写回选择器（「这次用谁的客户端」）；属 `worker/` 与 `writeback/` 面，不在 WP9 独占文件内 |

### 6.2 取舍与理由（容易被误读的地方）

1. **单价挂在「模型」上而不是「角色」上**（与需求字面「每档显示单价」一致，但存储位置不同）：
   同一模型被两档共用时单价只需维护一次；且**项目覆盖换模型后单价仍然查得到**——
   挂在角色上时覆盖行没有单价列，面板会显示成「$0」，那是错误信息。
2. **`scopes` 可空**（`NULL` vs `[]`）：见 §二 说明，是实测抓到的缺陷。
3. **`panel_identities.status` 列不参与判定**：判态一律由 `classifyIdentityState()` 现算
   （scope/过期是事实，状态是推导）。列里那份只作历史留痕，避免「库里写 ok、事实是过期」。

### 6.3 已知残余风险

- **`PI_BOT_SECRETS_KEY` 未配置时**：`/api/settings/*` 整组**不挂载**（启动 warn），
  不静默降级成明文存储。部署时必须在 `EnvironmentFile` 里加 64 hex 字符。
- **模型目录与角色绑定的引用是软引用**（不建外键，AGENTS §7.4）：删供应商会留下孤儿角色行。
  读侧兜底为「供应商不存在 → `provider_name`/`price` 为 `null`」，不 500。
- **`identity_fallbacks` 无保留期清理**：量很小（只在退回 bot 时写），但长期会涨；
  若将来要清，按 AGENTS §7.5 需先确认已聚合。
- **`createDefaultHostPort` 的四档取值是「异步刷新 + 同步读上一次结果」**：
  Host 第一次启动时若配置还没读回来，只会带部署级模型名（行为与改前一致），
  之后的启动/重启都带最新四档。

---

## 七、改动文件清单

**新建**
- `migrations/0013_wp9_model_providers.sql`
- `migrations/0015_panel_identity_scopes_nullable.sql`
- `apps/server/src/config/model-settings.ts`（供应商/角色/身份存储层，唯一明文出入口）
- `apps/server/src/app/settings-deps.ts`（装配工厂 + 两个探测端口实现）
- `apps/server/src/app/model-role-resolver.ts`（「项目覆盖优先、否则全局」的唯一实现）
- `apps/server/src/cost/price-resolver.ts`（模型目录 → `PriceResolver`）
- `apps/server/src/http/api/settings.ts`（12 条路由）
- `apps/server/test/model-settings.test.ts`（14 例，真库）
- `apps/server/test/http-settings.test.ts`（16 例，真库 + 假探测）
- `apps/server/test/settings-identity.test.ts`（17 例，纯函数）

**修改**
- `packages/contract/src/settings-v21.ts`（§11/§12 新段；未动 `DEFAULT_EVENT_TEMPLATES` / `DEFAULT_EVENT_DELTA_TEMPLATES` / `PROMPT_PLACEHOLDERS`）
- `packages/contract/src/api.ts`（§13 新段；未动 `delivery*` / `compaction*`）
- `packages/contract/src/schemas.ts`（注册新组件）
- `openapi/pi-bot.openapi.json`（77 schemas）
- `apps/server/src/db/schema.ts`（5 张新表 + `ALL_TABLES`；**未动 `agent_sessions`**）
- `apps/server/src/app/github-auth.ts`（`GithubIdentityProbe` / `createGithubIdentityProbe` / `createPersonalGithubClient` / `parseScopesHeader`）
- `apps/server/src/app/model-env.ts`（`HOST_MODEL_ROLE_ENV_KEYS` / `hostModelRoleEnv` / `hostEndpointEnv`）
- `apps/server/src/app/config.ts`（`PI_BOT_SECRETS_KEY` → `secretsKey`；只报「配没配」）
- `apps/server/src/cost/pricing.ts`（`resolvePrice` 可选；`pricingSource`）
- `apps/server/src/cost/index.ts`（导出）
- `apps/server/src/worker/types.ts`（`TaskRunnerDeps.resolvePrice?`）
- `apps/server/src/worker/run-task.ts`（计价传入 `resolvePrice`）
- `apps/server/src/app/worker-deps.ts`（`createWorkerBaseDeps` 透传 `resolvePrice`）
- `apps/server/src/http/api/index.ts`（挂载 `/api/settings/*` + `ApiWriteWiring`）
- `apps/server/src/http/server.ts`（`settings` 注入点）
- `apps/server/src/app/compose.ts`（仅接线：`settingsWiring` / `resolvePrice` / `resolveModelRole` / `hostModelRoleEnv`）
- `apps/server/src/app/index.ts`（导出）
- `apps/server/test/db-schema.test.ts`（29 张表 + 0013/0015 断言）
