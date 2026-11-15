# WP8 评论配置（CC-1 / CC-3 / CC-4）实现报告

- 需求依据：`docs/requirements.html` §6.6「评论触发配置」（行 1638–1705），「两个坑」callout 行 1672–1675
- 审计依据：`docs/audit/v2/_unimplemented.md` §1.1 第 7/8 行；`docs/audit/v2/U19/A.md`、`U19/B.md`
- 基线：工作区当前状态（HEAD `fbfa029` + 各并行 session 未提交改动，见 §七 第 6 条）
- 本报告只覆盖 WP8。**需求文档未改，未 `git add` / `git commit`，没有新增迁移文件**（原因见 §五）。

---

## 一、逐项状态

| 项 | 需求口径（原文摘要） | 状态 | 一句话结论 |
|---|---|---|---|
| **CC-1** 提及关键词 | 「关键词｜必填：是｜要命中的名字…可配多个」「是否区分大小写｜否｜默认不区分」 | **已实现（判定侧）**；本包只做取证 + 补测试 | 契约 `min(1)`（必填）+ 数组（多个）+ `case_sensitive ?? false` + `toLowerCase()` 判定全部就位，且有 `decide` 真实调用方；**唯一缺口在面板**（编辑关键词会抹掉 `case_sensitive`），属 WP11 的面板文件，本包不许碰 |
| **CC-3** 角色成员存 user id，匹配以 id 为准 | 「保存配置时把 login 解析成用户 id 一起存，匹配时以 id 为准」 | **已实现** | 成员新增 `{login, id}` 写法；保存时真查 GitHub 换 id；判定**两侧都有 id 时只比 id**（改名仍命中、旧 login 被抢注不命中）；缺 id 才降级按 login 且**强制留痕** |
| **CC-4** 保存时校验账号存在 | 「写错一个字母，那个人永远触发不了且没有报错。保存时校验账号是否存在，不存在就拒绝」 | **已实现** | 保存路径新增 `GET /users/{login}` 校验：不存在 → **400 拒存**并点名 login；查不了（没凭据 / GitHub 失败）→ **503 拒存**；两种情况都**不写库**（保留 last-known-good） |

---

## 二、CC-1 提及关键词（取证 + 补测试，无生产代码改动）

| 需求原文（`docs/requirements.html`） | 改前 | 改后 | 证据行号 |
|---|---|---|---|
| 行 1646「关键词｜必填：是｜…可配多个（句柄、别名、历史叫法）」 | 契约已强制非空 + 数组上限 10 | 不变 | `packages/contract/src/settings-v21.ts:131`（`commentMentionSchema`）、`:253`（`mentions: z.array(...).min(1).max(MAX_COMMENT_KEYWORDS)`） |
| 行 1647「是否区分大小写｜否｜默认不区分」 | 生效值补成显式 `false` | 不变 | `packages/contract/src/settings-v21.ts:140`（`case_sensitive: z.boolean().optional()`）、`apps/server/src/config/v21-settings.ts:197`（`mention.case_sensitive ?? false`） |
| 行 1651「命中规则见 FR-2.5：`@` 开头、紧跟关键词、关键词后必须是分隔符」 | 判定已实现 | 不变 | `apps/server/src/trigger/mention.ts:105`（逐关键词）、`:111`（默认 `toLowerCase` 折叠）、`:134`（`findLegalMention`）；调用方 `apps/server/src/trigger/decide.ts:214-217` |

- **判定依据**：三条子条件各有唯一落点，且判定函数有真实调用方（不是「有字段没人读」）。既有用例 `apps/server/test/trigger-mention.test.ts`（22 例）+ `apps/server/test/trigger-decide.test.ts`（38 例）覆盖两种大小写模式。
- **没改任何 CC-1 生产代码**：审计两个口径之争（A=已实现 / B=部分实现）的差别**只在面板**，而 `apps/panel/**` 是本包禁改面。缺口与证据见 §七 第 1 条。

---

## 三、CC-3 角色成员存 user id、匹配以 id 为准

### 3.1 需求原文（行 1674）

> **login 会变**：用户改名后旧 login 会被释放给他人注册。因此保存配置时把 login 解析成用户 id 一起存，匹配时以 id 为准。

### 3.2 改前（审计口径，逐条核对属实）

- 成员就是裸 login 字符串：原 `packages/contract/src/settings-v21.ts` 是 `members: z.array(z.string().regex(MEMBER_LOGIN_RE)).min(1)…`，同文件没有任何 id 字段。
- 判定按字符串比：原 `apps/server/src/trigger/roles.ts` 是 `role.members.some((member) => normalize(member) === login)`。
- 判定入参没有作者 id：`trigger/decide.ts` 的 `DecideComment` 只有 `authorLogin`；`http/webhook-v21.ts` 解析载荷也只取 `login`。
- 全仓没有 login→id 解析：保存路径零 GitHub 请求（也就是 CC-4 的缺口）。

### 3.3 改后（四层，各层唯一职责）

| 层 | 做了什么 | 证据行号 |
|---|---|---|
| **契约** | 成员一格 = `{login, id}`（`id` 必须是正整数）**或**旧写法裸 login（兼容存量 jsonb）。`resolveRoleMembers()` 只做形状归一，**不猜 id**：旧写法 → `{login, id: null}` | `packages/contract/src/settings-v21.ts:172`（`roleMemberSchema`）、`:191`（`legacyRoleMemberSchema`）、`:196`（`roleMemberEntrySchema` 联合）、`:201`（`ResolvedRoleMember`）、`:212`（`resolveRoleMembers`）、`:236-237`（`members: z.array(roleMemberEntrySchema)`） |
| **配置解析** | `resolveCommentConfig()` 把成员摊成 `{login, id}`，判定侧只有一种输入形状；`ResolvedCommentRole` 成为判定入参类型 | `apps/server/src/config/v21-settings.ts:161`（`ResolvedCommentRole`）、`:191`（`resolveCommentConfig`）、`:201`（`resolveRoleMembers(role.members)`） |
| **保存期解析** | 逐成员 `GET /users/{login}`，写回 **GitHub 的规范 login + 用户 id** | `apps/server/src/config/comment-members.ts:85`（`verifyCommentRoleMembers`）、`:113`/`:119`（不存在 / 请求失败分别收集）；端口与实现：`apps/server/src/github/users.ts:25`（`GithubUserLookup`）、`:42`（`createGithubUserLookup`）、`:52`（`GET /users/{username}`） |
| **判定** | **两侧都有 id → 只比 id**（id 不等就 `continue`，绝不再降级按 login，否则「改名后旧 login 被抢注」原样复活）；任一侧缺 id → 按 login 比并**必须**记 `loginFallbacks` | `apps/server/src/trigger/roles.ts:68`（`roleMatches`）、`:88-93`（id 优先且不降级）、`:95-107`（降级 + 留痕）、`:119-138`（`matchCommentRole` 回传 `loginFallbacks`） |
| **载荷** | 作者 id 进判定链：`comment.user.id`，缺失退 `sender.id`，都没有才是 `null`（判定降级并留痕） | `apps/server/src/http/webhook-v21.ts:92`（`positiveIdOrNull`）、`:179`（`authorId:`）；`apps/server/src/trigger/decide.ts:109`（`DecideComment.authorId`） |
| **留痕（不许静默）** | 降级结果挂到判定结果上（`roleLoginFallbacks`），并在 webhook 侧 `logger.warn` 一条结构化日志；纯函数不自己写日志 | `apps/server/src/trigger/decide.ts:61`/`:69`（两个判定变体上的可选字段）、`:150`（`withRoleFallbacks`）、`:276-279`/`:306`（两处出口）；`apps/server/src/http/webhook-v21.ts:256-266`（`logger.warn` + 明细 `角色:@login(原因)`） |

### 3.4 向后兼容策略（**本包关键**）

1. **存量配置不改库、不回填、不加迁移**：`members` 的契约是**联合类型**，`['alice']` 依然合法（`packages/contract/test/settings-v21-members.test.ts` 专门用例）。所以升级后「面板能打开、webhook 能判定」，不会出现「老配置解析失败 → `settings_valid=false` → 整仓被忽略」这种最糟的升级事故。
2. **旧写法在判定时是「显式降级」而不是「等价」**：`resolveRoleMembers()` 把它摊成 `{login, id: null}`，判定走降级分支并回传 `loginFallbacks`（`reason: 'member-without-id'`），webhook 打一条 warn。运维看日志就知道「这个仓库的角色还在按可能被顶替的 login 匹配」。
3. **升级路径就是「重新保存一次配置」**：只要有人在面板保存一次（哪怕什么都不改），保存期解析就会把每个成员写成 `{login, id}`，降级消失。不需要手工改库。
4. **混写允许**：同一条角色里可以同时有 `'alice'` 与 `{login:'bob', id:2002}`（有用例），所以面板不必一次性改造完（面板是 WP11）。
5. **保存时以 GitHub 真值为准**：即使请求里带了 id，也会被 `GET /users/{login}` 的结果覆盖（用例「新写法（已有 id）也会被 GitHub 的真值覆盖」）。理由：id 只能来自 GitHub，客户端传什么都不可信。

### 3.5 判定语义（review 只需记这三条）

- **id 命中 = 唯一权威**：`member.id !== null && authorId !== null` 时只比 id；不命中就 `continue`，不做二次 login 兜底。
- **降级只在「数据不全」时发生**，两种原因分开记：`member-without-id`（旧配置）/ `author-without-id`（载荷没给）。
- **不猜 id**：`resolveRoleMembers()` 不会用 login 合成假 id —— 那样「降级」会永远看起来像「按 id 命中」，坑一就再也查不出来。

---

## 四、CC-4 保存时校验账号存在

### 4.1 需求原文（行 1674）

> **拼错会静默失效**：写错一个字母，那个人永远触发不了且没有报错。保存时校验账号是否存在，不存在就拒绝。

### 4.2 改前

`PUT /api/repos/:owner/:name/settings` 只跑 zod：`apps/server/src/config/repo-config.ts` 的 `validateRepoSettings()`（同步、零 IO）→ `updateRepoSettings()` 直接写 jsonb。`alcie`（拼错的 `alice`）完全合法，能保存，然后永久静默失效。

### 4.3 改后（保存路径，顺序固定）

`apps/server/src/http/api/index.ts` 的 `PUT /api/repos/:owner/:name/settings`：

1. `validateRepoSettings(request.body)` —— 与原来同一份校验器，只是为了拿到「可以送去查 GitHub」的解析值（`:367`）。
2. `verifyCommentRoleMembers(validated.settings, deps.users)` —— 校验 + 解析 + 改写成员（`:373`）。
3. 校验通过 → `updateRepoSettings(deps.db, repo, verified.settings)`，写回的是**已补 id** 的配置（`:383`）。
4. 校验不通过 → **一个字都不写**，按 `kind` 映射 HTTP 语义（`:374-381`）。

**为什么没改 `config/repo-config.ts`**：它文件头写明那里是「写库前的同步 zod 校验」，塞进 GitHub IO 会把「配置校验」变成「配置校验 + 网络调用」；而「校验失败回什么 HTTP」本来就属 HTTP 层。所以这段落在 `http/api` + 新的 `config/comment-members.ts`（纯函数 + 注入端口）。**任务书允许改 `repo-config.ts`，但没必要改，这里点名说明**：`updateRepoSettings()` 的唯一生产调用方就是这条路由（`registerRepoRoutes`），所以「保存必须校验」这条闸门没有旁路。

### 4.4 用户可见错误（面板 `describeError` / `details.issues` 直接可展示）

| 场景 | HTTP | `error.code` | `error.message`（原文，已截 500 字） | `details.issues` 逐条 |
|---|---|---|---|---|
| 账号不存在（拼错） | **400** | `bad-request` | `角色成员账号不存在：@alcie（拼错的 login 会让该成员永久无法触发，已拒绝保存）` | `['comment.roles.members: GitHub 上不存在账号 @alcie']` |
| 本部署没有 GitHub 凭据 | **503** | `unavailable` | `本部署没有可用的 GitHub 凭据（未配置 GitHub App / token），无法校验角色成员账号，已拒绝保存；去掉「指定成员」角色后可以保存，或在配置好凭据后重试（否则拼错的 login 会让该成员永久无法触发且没有任何提示）` | `['comment.roles: 无法校验 @alice（缺少 GitHub 凭据）']` |
| GitHub 请求失败（401/403/5xx/网络） | **503** | `unavailable` | `校验角色成员账号失败（GitHub 请求未成功，未保存）：@alice: 查询 GitHub 账号失败：@alice（[…] HTTP 502 …）` | 逐条 `@login: 原因` |
| 不带成员角色的配置 | 200 | — | 与以前完全一致（一次请求都不发） | — |

- 三种失败**全部不写库**：库里继续是 last-known-good，webhook 行为不变。
- **404 与「请求失败」严格区分**：`github/users.ts` 只在 `info.status === 404` 时返回 `null`（= 账号不存在），其它失败**抛**。混成一个 `null` 就等于「网络抖一下就把拼错的账号放进去」，正是坑二的成因。
- 同一个 login 只查一次（按小写归一缓存），50 个成员不会打 50 次重复请求（用例断言 `calls` 只有 `['alice']`）。

---

## 五、改动文件清单

**生产代码**

| 文件 | 改动 |
|---|---|
| `packages/contract/src/settings-v21.ts` | **只加评论角色成员段**：`roleMemberSchema` / `legacyRoleMemberSchema` / `roleMemberEntrySchema` / `ResolvedRoleMember` / `resolveRoleMembers()`，`members` 改成联合元素。`DEFAULT_EVENT_TEMPLATES` / `DEFAULT_EVENT_DELTA_TEMPLATES` / `PROMPT_PLACEHOLDERS` **未动** |
| `apps/server/src/config/v21-settings.ts` | `resolveCommentConfig()` 摊成员；新增 `ResolvedCommentMention` / `ResolvedCommentRole` 类型 |
| `apps/server/src/config/comment-members.ts`（新） | 保存期校验 + login→id 解析（纯函数 + 注入端口），并**再出口**端口类型（`http/api` 的 eslint zone 不许它直接 import `github/`） |
| `apps/server/src/github/users.ts`（新） | `GithubUserLookup` 端口 + `createGithubUserLookup(client)`（`GET /users/{username}`，404 → `null`，其它抛） |
| `apps/server/src/github/index.ts` | 加一行 `export * from './users.ts'` |
| `apps/server/src/trigger/roles.ts` | id 优先匹配 + `loginFallbacks` 留痕；入参换成 `ResolvedCommentRole`、新增 `authorId` |
| `apps/server/src/trigger/decide.ts` | `DecideComment.authorId`；`checkCommentGates` 返回 `{skipped, roleFallbacks}`；`withRoleFallbacks()` 把留痕挂到判定结果 |
| `apps/server/src/http/webhook-v21.ts` | 解析 `comment.user.id` / `sender.id`（`positiveIdOrNull`）；降级匹配打 warn |
| `apps/server/src/http/api/index.ts` | `RepoApiWiring.users`；PUT 保存路径加「zod → 成员校验 → 写库」，按 `kind` 映射 400/503 |
| `apps/server/src/http/server.ts` | `BuildServerDeps.githubUsers`（可选）+ `repos: { db, users? }` 一行注入 |
| `apps/server/src/app/compose.ts` | **只加** `githubUsers: createGithubUserLookup(baseGithubClient)` 一行（+ 对应 import）。`panelDistDir` / `nextAgentTurns` / 压缩 / 标签 / 限额 / 会话行**未动** |
| `packages/contract/src/api.ts`、`packages/contract/src/schemas.ts` | **未动**（本包没有新端点、没有新响应体；也不在别人的契约文件里抢行） |
| 迁移 / `db/schema.ts` / `agent_sessions` | **零改动**。成员存在 `repos.settings`（jsonb）里，加字段不需要 DDL |

**测试**

| 文件 | 内容 |
|---|---|
| `packages/contract/test/settings-v21-members.test.ts`（新，7 例） | 成员 id 必须是正整数（0/负数/小数/字符串/缺失全拒）；未知键拒收；org/team 拒收；旧写法裸 login 合法；混写合法；`resolveRoleMembers` 不猜 id |
| `apps/server/test/trigger-roles-members.test.ts`（新，9 例） | 改名仍命中（按 id）；**旧 login 被抢注 → 不命中**；id 不同不命中；旧配置降级命中且 `loginFallbacks` 有值；载荷缺 id → `author-without-id`；降级不是放行；association 分支不受影响 |
| `apps/server/test/config-comment-members.test.ts`（新，8 例） | 拼错 → `unknown-user` 点名 `@alcie`；多成员只错一个 → 整体拒绝；旧写法写回成 `{login, id}` 且仍过契约；已有 id 被 GitHub 真值覆盖；同 login 只查一次；无成员角色零请求；请求失败 → `lookup-failed`；无凭据 → `lookup-unavailable` |
| `apps/server/test/http-comment-members.test.ts`（新，4 例，真库） | HTTP 语义：拼错 → 400 + `details.issues` + **库里没写**；成功 → 200 且落库成员为 `{login, id}`；未注入凭据 → 503 且不写库；无成员角色照旧 200 |
| `apps/server/test/v21-author-id.test.ts`（新，6 例） | 载荷 → 判定接线：`v21DecisionInputOf` 取到 `authorId`；id 一致无留痕；改名仍触发；抢注不触发（`role-denied`）；旧配置触发但带 `member-without-id`；载荷缺 id 带 `author-without-id` |
| `apps/server/test/v21-settings.test.ts`（改 1 例） | 原断言 `members: ['alice']` 改为断归一的视图 `[{login:'alice', id:null}]`，并补一条新写法 `[{login:'bob', id:1002}]`。形状确实变了才改，**不是放宽**：新旧两种写法仍各有一条断言 |

**产物**

| 文件 | 改动 |
|---|---|
| `openapi/pi-bot.openapi.json` | `pnpm gen:openapi` 重新生成（`RepoSettings.comment.roles[].members.items` 现在是 `anyOf: [{object login+id 必填}, {string login}]`）。这次重生成同时带入了并行 session 已在源码里但未重生成的 `DeliveryRow` / `DeliveriesResponse` 组件 |

---

## 六、命令与真实输出（全部为本机实际执行）

### 6.1 `cd apps/server; npx tsc --noEmit`

最后一次输出——**本包改动的文件零报错**，4 条错误全在 WP9 并行 session 的新文件里：

```
src/config/model-settings.ts(33,8): error TS2307: Cannot find module '../../../packages/contract/src/index.ts' or its corresponding type declarations.
src/config/model-settings.ts(375,31): error TS7006: Parameter 'role' implicitly has an 'any' type.
src/config/model-settings.ts(445,31): error TS7006: Parameter 'role' implicitly has an 'any' type.
src/config/model-settings.ts(490,72): error TS2551: Property 'model' does not exist on type '{ readonly mode: "inherit"; } | { readonly mode: "override"; readonly provider_id: string; readonly model: string; }'. Did you mean 'mode'?
```

同一命令在本次会话的三个中间快照（说明是并行 session 在动，不是本包）：

```
# 快照 A：2 条，在 compose.ts 的 agent 会话键
src/app/compose.ts(1015,46): error TS2345: ... Property 'domain' is missing in type ... 'AgentSessionKey'
src/app/compose.ts(1057,7):  error TS2345: ... Property 'domain' is missing in type ... 'AgentSessionKey'

# 快照 B：39 条，全在 test/v21-integration.test.ts（该文件当时被并行 session 写成 GBK 乱码）
test/v21-integration.test.ts(132,33): error TS1002: Unterminated string literal.
...（共 39 条，全部同一文件；随后被其 owner 修好）

# 快照 C：7 条，全在 src/queries/trace.ts（并行新增）
src/queries/trace.ts(...): ...
```

**结论**：本包触碰的 11 个生产文件 + 6 个测试文件没有一条 TS 报错；`apps/server` 整体 typecheck 目前红在并行 session 的 `src/config/model-settings.ts`（WP9）。

### 6.2 `cd packages/contract; npx tsc -p tsconfig.json --noEmit`

```
（无输出，退出码 0）
```

### 6.3 `cd apps/server; npx vitest run test/roles 2>$null; npx vitest run test/v21-settings`

```
$ npx vitest run test/roles
No test files found, exiting with code 1        # 仓库里没有 test/roles 这个文件（角色判定此前零测试）
```

按语义替换成实际相关的文件跑：

```
$ npx vitest run test/trigger-roles-members test/config-comment-members test/v21-author-id test/v21-settings test/trigger-decide test/trigger-mention
 ✓ test/v21-settings.test.ts (22 tests) 21ms
 ✓ test/config-comment-members.test.ts (8 tests) 28ms
 ✓ test/trigger-roles-members.test.ts (9 tests) 19ms
 ✓ test/v21-author-id.test.ts (6 tests) 11ms
 ✓ test/trigger-mention.test.ts (22 tests) 8ms
 ✓ test/trigger-decide.test.ts (38 tests)
 Test Files  6 passed (6)
      Tests  105 passed (105)
```

`packages/contract`：

```
$ npx vitest run
 ✓ test/settings-v21-members.test.ts (7 tests) 14ms
 ✓ test/settings-v21.test.ts (26 tests) 40ms
 ✓ test/config.test.ts (30 tests) / test/trigger.test.ts (27) / test/issue-tools.test.ts (16) / test/skill-mentions.test.ts (13)
 Test Files  7 passed (7)
      Tests  149 passed (149)          # 当时的快照：本包 schema 全部能出 JSON Schema
```

复查时的最新一次（WP9 并行 session 往注册表加了新组件之后）：

```
$ npx vitest run
 ❯ test/contract.test.ts (30 tests | 1 failed)
   × 每个响应 schema 都能生成 draft 2020-12 的 JSON Schema
   AssertionError: SaveRepoModelRoleRequest: expected undefined to be truthy
 Test Files  1 failed | 6 passed (7)
      Tests  1 failed | 148 passed (149)
```

唯一的红是 `SaveRepoModelRoleRequest`——WP9 刚注册进 `packages/contract/src/schemas.ts` 的模型角色请求体，本包没碰那个 schema；`RepoSettings`（含本包改的 `members`）仍然正常生成（产物见 §6.5）。

真库那条（`test/http-comment-members`）**现在跑不了**，原因与全仓所有 DB 测试相同（并行 session 迁移撞号）：

```
# 撞号出现之前（真实通过）：
 ✓ test/http-comment-members.test.ts (4 tests) 249ms
      Tests  4 passed (4)

# 撞号出现之后：
Error: 迁移序号重复：13（并行开发撞号，先改号再跑）
 ❯ openTestDb test/helpers/queries-db.ts:58:3
 Test Files  1 failed (1) / Tests  4 skipped (4)
```

### 6.4 `cd apps/server; npx vitest run`（全量）

```
 Test Files  30 failed | 103 passed (133)
      Tests  5 failed | 1438 passed | 236 skipped (1679)
```

失败归类（**没有一条属于本包**）：

| 失败 | 条数/文件 | 病因 | 归属 |
|---|---|---|---|
| `迁移序号重复：13（并行开发撞号，先改号再跑）` | 52 处，30 个文件（含本包 `http-comment-members`） | 并行 session 同时提交了 `migrations/0013_wp2_session_domain.sql` 与 `migrations/0013_wp9_model_providers.sql` | WP2 / WP9 |
| `db-migrate > 序号唯一`：`expected 14 to be 15` | 1 | 同上（两个 0013 撞号） | WP2 / WP9 |
| `db-schema > 24 张表`：`expected 29 to be 24` | 1 | 并行 session 新加了 5 张表（供应商 / 模型角色） | WP9 |
| `doctor-real > postgres`（`fail`） | 1 | 迁移撞号 → 真 PG 探针 fail | WP2 / WP9 |
| `v21-worker-integration > ⑤c`：`['octo/demo', undefined, 7, 'sandbox-rebuilt']` | 1 | `agent_sessions` 新增 `domain` 列后，reuse 的 SQL 参数多了一个 `undefined` | WP2 |

### 6.5 `pnpm gen:openapi`

```
openapi: 9 paths / 51 schemas -> C:\Code\NodeProjects\pi-issue-bot\openapi\pi-bot.openapi.json
```

产物 diff：`1 file changed, 164 insertions(+), 164 deletions(-)`。

### 6.6 `pnpm -r typecheck`

```
packages/shared typecheck: Done
apps/panel typecheck: src/routes/__tests__/repo-nav.test.tsx(18,21): error TS2305: Module '"../../routes.tsx"' has no exported member 'NAV_ITEMS'.
apps/panel typecheck: src/layout/AppLayout.tsx(33,20): error TS2552: Cannot find name 'useNavigate'. Did you mean 'navigate'?
apps/panel typecheck: src/layout/AppLayout.tsx(80,36): error TS2741: Property 'degradedLabel' is missing ...
apps/panel typecheck: src/layout/StatusStrip.tsx(54,15): error TS18047: 'counts.failed' is possibly 'null'.
apps/panel typecheck: Failed
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @pi-issue-bot/panel@0.0.0 typecheck
```

（另一次快照里先红在 `apps/server`（`src/config/model-settings.ts`，WP9）。`apps/panel` 是 WP11 的在改文件，本包禁碰。）

### 6.7 `npx eslint`（本包全部改动文件，共 15 个）

```
（无输出，退出码 0）
```

修过一次真实门禁违规：`http/api/index.ts` 起初直接 `import '../../github/users.ts'`，被 `import-x/no-restricted-paths` 判红（「http/api 只能经由 queries/ 取数，不得直接碰 worker 或执行面」）。改法：端口类型经 `config/comment-members.ts` **再出口**，`http/api` 只 import config —— 不复制定义，唯一声明仍在 `github/users.ts`。

---

## 七、跳过项与残余风险

1. **CC-1 的面板缺口（未修，属 WP11）**：`apps/panel/src/components/settings/v21-events-section.tsx:125` 编辑关键词时写 `mentions: next.map((keyword) => ({ keyword }))`，会把 `case_sensitive` 抹掉；同文件 `:521` 造角色时 `members.length === 0 ? [''] : members` 会写空串占位（空串过不了 `MEMBER_LOGIN_RE`，现在保存会直接 400）。两处都在本包禁改的 `apps/panel/**`，留给 WP11。
2. **面板目前还不会写 `{login, id}`**（它只发裸 login）。这不阻塞：保存期解析会补 id（用例「旧写法（裸 login）→ 写回后是 `{login, id}`」就是这条路径）。但**只有有人在面板保存过一次，老配置的降级匹配才会消失** —— 迁移策略是「读兼容 + 保存即升级」，不做批量回填（回填要跑 GitHub 请求，属另一件事，且需要迁移作业）。
3. **CC-3 的一个边界取舍**：若配置里的 `login` 已过期（用户改了名）而 `id` 仍正确，保存时仍会因 `GET /users/{旧login}` 404 被拒。这是**故意的**：需求要求「保存时校验账号存在」，而 GitHub 没有「按 id 查 login」的公开端点。代价是改名后要重填一次成员 login；收益是绝不会静默存下一个查不到的账号。
4. **未注入 GitHub 凭据的部署无法保存「指定成员」角色**（503）。这是「不许静默放行」的直接后果，错误文案已给出两条出路。若评审认为这类部署应能配成员，那是产品取舍（需要单独的「允许跳过校验」开关）；本包按需求原文选择拒绝。
5. **成员只有一份事实源**：成员只存在 `repos.settings`（jsonb），所以**没有**「库里 id 与配置不一致」的可能；反过来，谁手改 jsonb 把 id 写错，判定就按错误 id 匹配（无交叉校验）。这是单一事实源的代价，记录在此。
6. **不是本包造成的、但会让验证不完整的环境状态**（并行 session 同时在同一个工作区里写）：
   - `migrations/0013_wp2_session_domain.sql` 与 `migrations/0013_wp9_model_providers.sql` 撞号 → **全仓 30 个 DB 测试文件当前全红**（含本包唯一那条真库用例）。需要其中一方改号后重跑；本包不加迁移，改别人的迁移号不在授权范围内。
   - `apps/server` typecheck 现红在 `src/config/model-settings.ts`（WP9）；`apps/panel` typecheck 红在 `routes.tsx` / `AppLayout.tsx`（WP11）；`test/v21-worker-integration.test.ts` 红在沙箱 SQL 参数（WP2）。本次会话中途还观察到 `test/v21-integration.test.ts` 被写成 GBK 乱码（39 条 TS1002），随后被其 owner 修好。
   - 因此本报告里「全量 `vitest` 绿」这一项**无法给出**：它是红的，且红的原因全部在上述并行文件里（逐条列在 §6.4 表）。
7. **没有新增 `vi.mock` / 快照 / `useFakeTimers` / `sleep`**：新用例全部用「构造注入的端口 + 纯函数」；三个 0 保持不变。本包新逻辑没有引入任何时间依赖（没有新增 `now()` 调用，也没有 `Date.now()`）。
