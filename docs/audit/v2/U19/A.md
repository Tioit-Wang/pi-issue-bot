# U19 6.6 评论触发配置 · A

> 核查范围：docs/requirements.html 行 1638-1705
> 代码基线：见 docs/audit/v2/_baseline.txt（HEAD fbfa0298，工作区含未提交改动，本文件结论对应此状态）

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| CC-1 提及关键词 | 已实现 | 无（必填 / 可配多个 / 默认不区分大小写三项齐备且有判定路径） |
| CC-2 角色清单 | 已实现 | 无契约缺口；面板只能造「指定成员」角色，作者关联分支无法在 UI 里配（见额外问题） |
| CC-3 login 会变 → 存 user id、按 id 匹配 | 未实现 | 只存 login 字符串，匹配也按 login 字符串，全仓没有任何 user id 字段或按 id 比较的逻辑 |
| CC-4 拼错静默失效 → 保存时校验账号存在 | 未实现 | 保存路径是纯同步 zod 校验，不发任何 GitHub 请求，拼错的 login 照样入库 |

## 逐条

### CC-1 提及关键词
- **状态**：已实现
- **证据**：
  - `packages/contract/src/settings-v21.ts:200` — `mentions: z.array(commentMentionSchema).min(1).max(MAX_COMMENT_KEYWORDS)`，非空即「必填」，数组即「可配多个」（上限 10，见同文件 `:30`）。
  - `packages/contract/src/settings-v21.ts:133-138` — `keyword` 经 `trim().min(1)` 且 `regex(/^[^\s@]+$/u)`，空关键词直接解析失败；`:140` `case_sensitive: z.boolean().optional()`，注释与实现一致：缺省不区分。
  - `apps/server/src/config/v21-settings.ts:163-166` — 生效值把 `case_sensitive` 补成显式布尔：`mention.case_sensitive ?? false`，默认「不区分」只此一处落地。
  - `apps/server/src/trigger/mention.ts:111` — 判定时 `keyword.case_sensitive === true ? actual === keyword.keyword : actual.toLowerCase() === keyword.keyword.toLowerCase()`，默认分支确实做了大小写折叠。
  - `apps/server/src/trigger/mention.ts:105` — `for (const keyword of keywords)` 逐个匹配全部关键词；`:96` 按长度倒序保证「最长优先」，说明多关键词不是摆设，是真的参与判定。
  - `apps/server/src/trigger/decide.ts:181-187` — 闸门 `require_mention` 开启时调用 `findLegalMention(body, mentions)`，`mentions` 来自 `resolveCommentConfig()`，配置→判定链路闭合。
  - `apps/panel/src/components/settings/v21-events-section.tsx:116-128` — 面板把 `comment.mentions` 渲染成可增删的关键词列表，且 `if (next.length === 0) return;` 阻止把数组删空（与服务端 min 1 对齐）。
- **判定依据**：需求三条子条件（必填 / 可配多个 / 默认不区分大小写）分别对应上面的 schema 约束、数组与循环、`?? false` + `toLowerCase()`；不是「有字段没人读」，判定函数有 `decide.ts:184` 的真实调用方，测试 `apps/server/test/trigger-mention.test.ts:60-70` 断言了默认不区分与 `case_sensitive: true` 严格两种可观察结果。

### CC-2 角色清单
- **状态**：已实现
- **证据**：
  - `packages/contract/src/settings-v21.ts:170-187` — `commentRoleSchema = z.discriminatedUnion('by', [...])`，两个分支 `by: 'association'` / `by: 'members'`，是判别联合而非「两个可选字段」，因此「判定方式二选一」在解析期就被强制（写 `{by:'association'}` 缺 `any_of`、写 `{by:'members'}` 缺 `members`、写 `by:'org'` 全部失败，见 `packages/contract/test/settings-v21.test.ts:143-166`）。
  - `packages/contract/src/settings-v21.ts:147-155` — `ASSOCIATIONS` 七个值逐个核对：`OWNER`、`MEMBER`、`COLLABORATOR`、`CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR`、`FIRST_TIMER`、`NONE`，与需求行 1661 完全一致，`:159` 由 `z.enum(ASSOCIATIONS)` 约束 `any_of` 的元素。
  - `packages/contract/src/settings-v21.ts:184` — `members: z.array(z.string().regex(MEMBER_LOGIN_RE, '成员必须是 GitHub login（不支持 org/team）'))`，`MEMBER_LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u`（`:48`），`acme/team` 这类团队写法直接不被接受（测试 `packages/contract/test/settings-v21.test.ts:154-159`）；结构上不存在「组织/团队」这一种取值。
  - `apps/server/src/trigger/roles.ts:42-59` — 两个分支都有判定实现：`association` 分支比较 `author_association`（`:50`），`members` 分支比较 login（`:59`），且 `:83` 被 `matchCommentRole` 消费。
  - `apps/server/src/trigger/decide.ts:188-199` — `require_role` 开启时用 `roles` + `gates.allow_roles` + `authorAssociation` + `authorLogin` 调 `matchCommentRole`，命中不了记 `role-denied`；`authorLogin`/`authorAssociation` 来自载荷解析（`apps/server/src/http/webhook-v21.ts:151`）。
  - 「闸门里只能选」：`packages/contract/src/repo-config.ts:302-308` — `findUnknownAllowRoles(settings.comment, commentGates.allow_roles)` 命中即 `addIssue`（「闸门只能引用已定义的角色」），而该 superRefine 就是保存路径的校验器（`apps/server/src/config/repo-config.ts:145-146` → `http/api/index.ts:331` 的 `PUT /api/repos/:owner/:name/settings`）；`apps/panel/src/components/settings/v21-events-section.tsx:101-105,447` — 面板的 `allow_roles` 候选只来自 `draft.comment.roles` 的名字，是复选框而不是自由输入框；角色为空时该控件被禁用（`apps/panel/src/routes/__tests__/repo-settings-v21.test.tsx:303-310`）。
- **判定依据**：需求列出的四个字段（角色名 / 判定方式二选一 / 七个作者关联值 / 成员为个人 login）在契约里逐项可指认，且两个分支都在 `roles.ts` 有判定实现并被 `decide.ts` 调用；闸门引用的是角色名并有两道闸（面板只给已有名字、服务端 superRefine 拒未知名字）。因此按「全部子条件满足 + 有实现路径」判已实现。缺口不在契约而在面板编辑能力，见「发现的额外问题」。

### CC-3 坑一「login 会变」：存 user id、按 id 匹配
- **状态**：未实现
- **证据**：
  - `packages/contract/src/settings-v21.ts:184` — 成员就是 `z.array(z.string().regex(...))`，元素类型是裸 login 字符串，同一文件里没有任何 id 字段；`commentConfigSchema`（`:198-203`）也只有 `mentions` / `roles` 两段。
  - `apps/server/src/trigger/roles.ts:55-59` — 匹配逻辑是 `const login = normalize(authorLogin); ... role.members.some((member) => normalize(member) === login)`，即**按 login 字符串相等比较**，需求要求的「以 id 为准」不存在。
  - `apps/server/src/trigger/decide.ts:97` — 判定输入的作者信息只有 `authorAssociation` 与 `authorLogin`，没有 `authorId`；`apps/server/src/http/webhook-v21.ts:151` 解析载荷时也只取 `login`（`str(commentUser, 'login') ?? str(sender, 'login')`），用户 id 从未进入判定链。
  - 全仓检索 `user_id|userId|github_user_id|node_id|getUser` 在 `**/*.ts` 下匹配 0 处（见「核查边界」），即既没有「保存时把 login 解析成 id」的字段，也没有任何解析调用。
- **缺口**：缺两个子条件——(1) 配置结构里没有存 user id 的字段，保存时也不做 login→id 解析；(2) 匹配完全按 login 字符串比较。影响：用户改名后旧 login 被他人注册，对方即自动获得该角色（闸门放行陌生人），这正是需求行 1674 点名的风险。
- **判定依据**：需求明写「保存配置时把 login 解析成用户 id 一起存，匹配时以 id 为准」，代码里字段与比较两处都是 login 字符串，属于「找不到实现」，且 `roles.ts:59` 是明确的反向实现（按 login 比）。

### CC-4 坑二「拼错会静默失效」：保存时校验账号存在
- **状态**：未实现
- **证据**：
  - `apps/server/src/config/repo-config.ts:145-159` — `validateRepoSettings()` 是**同步**函数，函数体只有 `repoSettingsSchema.safeParse(input)` 与错误格式化，没有任何 IO 或 GitHub 调用。
  - `apps/server/src/http/api/index.ts:329-340` — 保存入口 `PUT /api/repos/:owner/:name/settings` 直接 `await updateRepoSettings(deps.db, repo, request.body)`；`apps/server/src/config/repo-config.ts:454-457` 只是再跑一次 `validateRepoSettings()`，失败就 `bad-request`，成功就写 jsonb，全程不触碰 `deps` 里的 GitHub 客户端。
  - `packages/contract/src/settings-v21.ts:184` — 对成员的唯一校验是 `MEMBER_LOGIN_RE` 形状正则；`alcie`（拼错的 `alice`）完全合法，能通过保存。
  - 全仓检索 `getUser|users/|octokit.rest|searchUsers|账号不存在|用户不存在|校验账号` 在源码下匹配 0 处；`apps/server/src/doctor/checks/` 的 13 个检查里也没有账号存在性检查——即不存在「换个入口补上」的隐藏实现。
- **缺口**：缺「保存时请求 GitHub 校验 login 是否存在、不存在则拒绝」这一子条件。影响：拼错一个字母的角色成员永久无法触发，且保存时无任何报错，用户只能靠「怎么 @ 都没反应」倒查；需求把这个坑单列为必须堵的点。
- **判定依据**：需求指定了动作（保存时校验）、副作用（真的查 GitHub）与失败语义（拒绝保存）。代码里保存路径是纯 zod 同步校验 + 写库，形状正则不等于存在性校验，故判未实现。

## 本节整体结论
§6.6 的两组定义源（提及关键词、角色清单）在契约层与判定层都已成型：关键词非空、可多个、默认不区分大小写，七个作者关联值与个人 login 约束都能逐项对上，闸门「只能选已定义角色」在面板与服务端各有一道拦截，这两条可判已实现。但需求在同一小节用醒目 callout 点出的两个坑（login 会变、拼错静默失效）完全没有落地：成员只存 login 字符串并按 login 比较，保存时也不查账号是否存在。因此本节整体**不能**判为已实现，应为部分实现——四条目中 CC-1、CC-2 已实现，CC-3、CC-4 未实现。

## 核查边界
- 是否执行了命令：未执行测试或构建，纯静态核查；仅执行了只读检索（`git rev-parse HEAD` 得 `fbfa02983d36d4923c0647f4c18aacd041d83375`，与 `_baseline.txt` 一致；以及多次 `Select-String` / 内容检索确认 `user_id|userId|github_user_id|getUser|users/|账号不存在|用户不存在` 在源码内命中 0 处）。
- 未覆盖的条目及原因：CC-3 / CC-4 属于「找不到实现」，无法再验证运行期行为；需求行 1646-1651 提到的「命中规则见 FR-2.5」的边界判定细节属其他单元，未展开。数据库一侧只确认 `repos.settings` 为 jsonb（`apps/server/src/config/repo-config.ts:165-168` 的查询与 `:458-463` 的写入），未连库验证存量数据形状。
- 发现的额外问题（不属本节范围但值得记录）：
  1. **角色判定零测试**：全仓检索 `matchCommentRole` 只有定义（`apps/server/src/trigger/roles.ts:69`）与调用（`apps/server/src/trigger/decide.ts:190`），没有任何测试文件引用，`association` / `members` 两个分支的命中与不命中都没有断言覆盖。
  2. **面板无法配置「作者关联」角色**：`apps/panel/src/components/settings/v21-events-section.tsx:512-525` 的 `addRole` 固定写 `by: 'members'`，且 `members` 直接复制 `draft.agent.managers`，既不能选「按作者关联」，也不能增删成员——契约支持的两条分支里只有一条能做出来。
  3. **面板会写出非法成员**：同处 `members.length === 0 ? [''] : members`，当 `agent.managers` 为空时写入空串占位，空串过不了 `MEMBER_LOGIN_RE`，保存会被服务端 400；面板测试还把该行为当作期望断言（`apps/panel/src/routes/__tests__/repo-settings-v21.test.tsx:329-330`）。
  4. `apps/server/src/http/api/auth.ts:16` 的 `isOrgMember` 仍是 TODO 注释（真实实现应 `GET /orgs/{org}/members/{username}`），与本节「成员只支持个人」不同源，仅记录。
