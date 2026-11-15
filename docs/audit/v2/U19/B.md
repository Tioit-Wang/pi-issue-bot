# U19 6.6 评论触发配置 · B

> 核查范围：docs/requirements.html 行 1638-1705
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| CC-1 提及关键词 | 部分实现 | 契约与判定都支持「可多个 + 缺省不区分大小写」，但面板没有「是否区分大小写」开关，且面板编辑关键词时会把 `case_sensitive` 抹掉 |
| CC-2 角色清单 | 已实现 | 角色名 / 判别联合二选一 / 七个关联值 / 成员仅个人 login 全在契约与判定路径上；面板只能造 `by:'members'` 角色属于可用性缺口，不影响数据模型 |
| CC-3 login 解析成 user id 一起存 | 未实现 | 成员字段是 `string[]` 的 login 列表，全仓无 user id 字段、无 id 匹配；改名后旧 login 被他人注册即陌生人获得触发权限 |
| CC-4 保存时校验账号存在 | 未实现 | 保存路径只跑 zod 形状/跨字段校验，无任何 GitHub 用户查询；拼错静默失效 |

## 逐条
### CC-1
- **状态**：部分实现
- **证据**：
  - `packages/contract/src/settings-v21.ts:131` — `commentMentionSchema`：`keyword` 非空、≤50 字（`:137`），禁空白与 `@`（`:138`）；`case_sensitive: z.boolean().optional()`（`:140`），即缺省 undefined。
  - `packages/contract/src/settings-v21.ts:200` — `mentions: z.array(commentMentionSchema).min(1).max(MAX_COMMENT_KEYWORDS)`，`MAX_COMMENT_KEYWORDS = 10`（`:30`）：可配多个关键词，形状上落实「句柄 / 别名 / 历史叫法」。
  - `apps/server/src/config/v21-settings.ts:163` — `case_sensitive: mention.case_sensitive ?? false`：缺省补齐为 `false`（不区分）。
  - `apps/server/src/trigger/mention.ts:111` — `keyword.case_sensitive === true ? actual === keyword.keyword : actual.toLowerCase() === keyword.keyword.toLowerCase()`：确实做大小写归一。
  - `apps/server/src/trigger/decide.ts:181` — `if (gates.require_mention) { … findLegalMention(body, mentions) … }`：关键词被 webhook 判定真实消费，不是死字段。
  - `apps/server/test/trigger-mention.test.ts:61`、`:65` — 断言「缺省 @Pi-Bot 命中」「case_sensitive: true 时 @Pi-Bot 不命中」。
  - `apps/panel/src/components/settings/v21-events-section.tsx:117` — `draft.comment.mentions.map((m) => m.keyword)`；`apps/panel/src/components/settings/v21-events-section.tsx:125` — `mentions: next.map((keyword) => ({ keyword }))`：改写关键词时**只重建 keyword**，`case_sensitive` 被丢弃。
  - 面板全文无 `case_sensitive` 控件（在 `apps/panel/src` 全量检索 `case_sensitive|caseSensitive` 命中 0 处）。
- **缺口**：需求表把「是否区分大小写（否 / 默认不区分）」列为一条配置项（`docs/requirements.html:1647`）。契约层有该键、判定层消费该键，但**面板没有对应开关**，且面板任一关键词增删都会把已配的 `true` 静默重置为缺省 `false`——该配置项在实际编辑面上不可维护且会被丢数据。
- **判定依据**：主体（多关键词 + 默认不区分 + 归一化匹配 + 判定消费 + 断言具体）都有明确实现路径，故不是「未实现」；但需求明写的这一个子条件在面板侧缺失并伴随配置丢失，只能判「部分实现」。
- **反证过程**：
  - 假设「默认其实区分大小写」：查默认值落点 `settings-v21.ts:140`（optional，无默认）→ 补齐点 `v21-settings.ts:165`（`?? false`）→ 比较点 `mention.ts:111`（非 sensitive 分支走 `toLowerCase`）。三处一致，假设被推翻。
  - 假设「多关键词只是 schema 允许、判定只读第一个」：`mention.ts:105` 对所有 keyword 逐个试探、`:96` 按长度倒序（最长优先），`trigger-mention.test.ts:73` 断言 `pi` 与 `pi.bot` 取后者。假设被推翻。
  - 假设「`case_sensitive` 是死字段，全仓无消费方」：`v21-settings.ts:165` 显式补齐、`mention.ts:111` 分支使用、测试 `trigger-mention.test.ts:65` 断言差异行为。假设被推翻（字段有效），但由此反向发现面板侧未接线 → 缺口落在面板而非契约。
  - 假设「面板会保留已配的 `case_sensitive`」：`v21-events-section.tsx:125` 的对象字面量只有 `keyword`。假设被推翻，确认为缺陷。

### CC-2
- **状态**：已实现
- **证据**：
  - 角色名：`packages/contract/src/settings-v21.ts:162` — `roleNameSchema = z.string().trim().min(1).max(ROLE_NAME_MAX_CHARS)`（40 字，给人看）。
  - 判定方式二选一：`packages/contract/src/settings-v21.ts:170` — `z.discriminatedUnion('by', [...])`；`:171-178` 分支 `by:'association'` 且 `.strict()`（只许 `name/by/any_of`）；`:179-186` 分支 `by:'members'` 且 `.strict()`（只许 `name/by/members`）。两分支互斥且多余键被拒 → **不存在「两个字段都填」的歧义状态**，填了另一边字段会被 strict 拒收。
  - 七个作者关联值：`packages/contract/src/settings-v21.ts:147-155` — `OWNER / MEMBER / COLLABORATOR / CONTRIBUTOR / FIRST_TIME_CONTRIBUTOR / FIRST_TIMER / NONE` 七个俱全；`:159` `z.enum(ASSOCIATIONS)` 拒绝其它值。
  - 仅个人 login、不支持组织/团队：`packages/contract/src/settings-v21.ts:184` — `z.array(z.string().regex(MEMBER_LOGIN_RE, '成员必须是 GitHub login（不支持 org/team）'))`；`MEMBER_LOGIN_RE`（`:48`）为 `^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`，`acme/team` 形态必被拒。全仓无 team/org 成员字段或查询（检索 `teams|org_members|organization` 在 `apps/packages` 源码中无命中；唯一的 org 查询是面板登录鉴权的 TODO，`apps/server/src/http/api/auth.ts:16`，与角色清单无关）。
  - 判定消费：`apps/server/src/trigger/roles.ts:42` — `by:'association'` 用 `author_association` 与 `any_of` 归一化比对；`:59` — `by:'members'` 用成员 login 与作者 login 比对；调用点 `apps/server/src/trigger/decide.ts:190`。
  - 断言具体：`packages/contract/test/settings-v21.test.ts:143`（缺 `any_of` / 空数组拒收）、`:149`（缺 `members` 拒收）、`:157`（`members:['acme/team']` 拒收）、`:161`（`by:'org'` 拒收）、`:165`（`any_of:['ADMIN']` 拒收）、`:171`（七个值逐个比对）；判定侧 `apps/server/test/trigger-decide.test.ts:323`（关联不够 → `role-denied`）、`:347`（成员 login 命中，大小写不敏感）。
- **缺口**：（无硬缺口。面板可造性限制记入「发现的额外问题」第 2 条——`apps/panel/src/components/settings/v21-events-section.tsx:521` 新增角色固定 `by:'members'`，且成员取 `agent.managers`。）
- **判定依据**：任务给定的四个子条件（角色名、判定方式二选一、七个关联值、仅个人 login 不支持 org/team）逐条都能定位到 schema 约束 + 运行时判定 + 具体断言，四个子条件全满足。
- **反证过程**：
  - 假设「二选一只是两个可选字段，可同时填造成语义歧义」：`settings-v21.ts:170` 是 `discriminatedUnion`，两个分支都 `.strict()`。实测语义：`{by:'association', any_of:[…], members:[…]}` 因 `members` 是 association 分支的未声明键而被拒（`.strict()`），不是「两套都生效」。假设被推翻。
  - 假设「七个关联值缺一个」：逐项核对 `settings-v21.ts:148-154` 与需求 `:1661`，OWNER/MEMBER/COLLABORATOR/CONTRIBUTOR/FIRST_TIME_CONTRIBUTOR/FIRST_TIMER/NONE 一一对应，不缺。
  - 假设「成员其实支持组织/团队」：`settings-v21.ts:184` 的 regex 与错误文案；`settings-v21.test.ts:157` 断言 `acme/team` 被拒；仓储层 `apps/server/src/db/schema.ts` 无 org/team 成员表。假设被推翻。
  - 假设「角色清单只存在于 schema，没有任何判定读取」：`decide.ts:190` 调 `matchCommentRole`，`roles.ts:41-59` 有分支实现，`trigger-decide.test.ts:323/335/347` 断言三种结局。假设被推翻。
  - 假设「关联值匹配其实是按配置里写死的大写字符串硬比，大小写勤改即失效」：`roles.ts:36-38` 双侧 `trim().toLowerCase()`。假设被推翻。

### CC-3
- **状态**：未实现
- **证据**：
  - `packages/contract/src/settings-v21.ts:184` — 成员字段就是 `members: z.array(z.string().regex(MEMBER_LOGIN_RE))`：**纯 login 字符串数组，没有任何 `{login, id}` 结构，也没有并存 id 列**。全仓检索 `user_id|userId|github_id|numericId|member_ids` 在 `apps/` 与 `packages/` 源码中命中 0 处（唯一命中是 `apps/server/src/sandbox/paths.ts:51` 的无关注释）。
  - `apps/server/src/trigger/roles.ts:59` — `role.members.some((member) => normalize(member) === login)`：比较对象是**login 字符串**，`:55` 的 `login` 来自载荷 `authorLogin`（`apps/server/src/http/webhook-v21.ts:151` — `str(commentUser, 'login') ?? str(sender, 'login')`）。
  - `apps/server/src/http/webhook-v21.ts:131` — 只取了 `comment.user`，`:151` 只读 `login`；载荷里现成的 `user.id` **完全未被读取**，所以运行时也没有任何 id 可以用于匹配。
  - 存储侧：角色清单只落在 `repos.settings`（jsonb）里（`apps/server/src/config/repo-config.ts:193` 的 `updateSettings` 写 `settings`），没有独立成员表（`apps/server/src/db/schema.ts` 中 `panel_sessions.login`（`:566`）是唯一 login 列，与角色无关）。
  - 测试：`packages/contract/test/settings-v21.test.ts:137` 与 `apps/server/test/trigger-decide.test.ts:28` 的夹具成员都是裸 login 字符串，没有任何 id 断言——测试口径同样不支持 id 匹配。
- **缺口**：需求 `docs/requirements.html:1674` 的「保存配置时把 login 解析成用户 id 一起存，匹配时以 id 为准」整条缺失：既没有 `{login, id}`（或 `login + member_ids` 双写）的存储形状，也没有 id 比对逻辑。后果：用户改名后旧 login 会被释放给他人注册，若有人注册同名 login 并在被监控仓库发言，**将直接获得该角色的触发权限**（`roles.ts:59` 按 login 字符串命中即放行），这是权限旁路而不是显示问题；同时改名的原成员会静默失去触发权限且无任何报错。
- **判定依据**：任务规定的证伪标准是「若只存 login 不存 id，直接判未实现」。代码里成员字段确实是 `string[]` login，匹配确实按 login 字符串（`roles.ts:59`），存储、匹配、测试三处均无 id，故判未实现。
- **反证过程**：
  - 假设「id 存在别处（如 repos 表的附加列或成员子表）」：读 `apps/server/src/config/repo-config.ts:163-201` 的 `REPO_SQL`（列只有 enabled/dry_run/archived_at/settings/settings_valid/settings_error/source/installation_id/…），`apps/server/src/db/schema.ts` 全量检索 `user|login|member` 只有 `tasks.actor_login`、`panel_sessions.login`、`notifications.actor_login` 等与角色无关的列。假设被推翻：**没有 id 落点**。
  - 假设「虽然存 login，但匹配时用了 payload 的 user.id 做二次确认」：`webhook-v21.ts:131-152` 的 `v21DecisionInputOf` 只投出 `authorAssociation` / `authorLogin`，`roles.ts:18-27` 的输入类型里也没有 id 字段。假设被推翻。
  - 假设「需求这句只要求 login 稳定、id 是可选优化」：需求原文 `:1674` 明确写「因此保存配置时把 login 解析成用户 id 一起存，匹配时以 id 为准」，是硬要求且给了理由（旧 login 会被释放）。假设被推翻。
  - 假设「改名风险被别的机制兜住（如每次触发校验是否仍是同一人）」：`roles.ts:69-88` 只有「名字对不上就跳过」，无任何成员有效性复核；`v21-settings.ts:167-171` 的 `resolveCommentConfig` 只做形状 copy。假设被推翻。

### CC-4
- **状态**：未实现
- **证据**：
  - 保存入口 `apps/server/src/http/api/index.ts:319` — `PUT /api/repos/:owner/:name/settings`，body 直接挂 `repoSettingsSchema`（`:324`），处理体 `:331` 调 `updateRepoSettings` 后即写库，**中间没有任何外部查询**。
  - `apps/server/src/config/repo-config.ts:449` — `updateRepoSettings()` 唯一动作是 `validateRepoSettings(settings)`（`:454`）→ `db.query(REPO_SQL.updateSettings, …)`（`:458`）。`validateRepoSettings`（`:145-159`）只做 `repoSettingsSchema.safeParse`，纯 schema 校验。
  - 全仓检索 GitHub 用户查询能力：`apps/packages` 源码检索 `GET /users|users/|getByUsername|user_id` 命中 0 处；`apps/server/src/github/octokit.ts` 的请求清单里只有 `/repos/…/issues…` 一类路由，无 `/users/{username}`。
  - 唯一的 GitHub 成员查询是面板登录鉴权的 TODO（`apps/server/src/http/api/auth.ts:16`，且注明「TODO(owner: 面板切片)」——即使实现也是 `GET /orgs/{org}/members/{username}`，与「保存角色成员时校验账号存在」无关，且不在保存链路上）。
  - 形状校验只保证 login 长得像 login：`packages/contract/src/settings-v21.ts:184` 的 regex 通过 `alice2` 这类**不存在的**账号。
- **缺口**：需求 `docs/requirements.html:1674` 的「保存时校验账号是否存在，不存在就拒绝」整条缺失。后果与需求点名的坑一致：成员 login 拼错一个字母即通过保存、静默入库，该成员永远触发不了且日志里没有任何报错（`roles.ts:59` 比不中就是不命中，`:10-11` 明确「认不出的角色名不报错」，成员不命中同样静默），排障只能靠人工逐字比对。
- **判定依据**：任务规定的证伪标准是「去找配置保存的写入路径，看是否有调用 GitHub API 查询用户是否存在」。两条写路径（`PUT /settings`、`POST /api/repos`）都只走 zod 校验；GitHub 客户端根本没有用户查询方法，故判未实现（不是「无法判定」——缺的是代码而非运行环境）。
- **反证过程**：
  - 假设「校验发生在面板侧（前端先查一遍）」：`apps/panel/src/components/settings/v21-events-section.tsx:512-525` 的 `addRole` 只做非空与重名判断，成员直接取 `draft.agent.managers`；面板无任何用户存在性请求（`apps/panel/src` 检索 `users/` 无命中）。假设被推翻。
  - 假设「校验发生在另一个写路径，只是 PUT 没接」：读 `apps/server/src/config/repo-config.ts:399-432` 的 `upsertRepo`，同样只有 `validateRepoSettings`。假设被推翻：**两条写路径都没有**。
  - 假设「有校验但被开关关掉了」：检索 `apps/server/src` 无 `checkLoginExists|validateMembers|用户不存在` 一类符号或分支，不存在「关掉的校验」。假设被推翻。
  - 假设「zod 的 login 正则够用，等于校验了账号存在」：`settings-v21.ts:48` 的 `^[A-Za-z0-9][A-Za-z0-9-]{0,38}$` 只校验字符集，任何拼写错误的合法字符串都通过。假设被推翻。

## 本节整体结论
§6.6 的四个小条目里只有「角色清单」的数据模型（CC-2）无争议成立：判别联合把「二选一」做成了解析期约束，七个关联值与「仅个人 login」都有正向与拒绝路径的具体断言。
CC-1 的判定侧（多关键词、缺省不区分大小写、归一化比较）真实生效，但面板缺开关且会丢弃 `case_sensitive`，只能判部分实现。
CC-3 与 CC-4 是需求「两个坑」段落里的两条硬要求，代码里**完全不存在**对应实现：成员只以 login 字符串存储与比较（改名即权限旁路），保存链路上没有任何 GitHub 账号校验（拼错即静默失效）。
因此本节整体**不能**判为「已实现」，应判为「部分实现」：主链路在，两个防坑条件全缺。

## 核查边界
- 是否执行了命令：**未执行任何测试 / 构建 / typecheck 命令**（纯静态核查）。仅用只读检索（`Select-String` / `Grep` / `Read`）读取源码与测试；结论中的测试均为「存在且断言具体」，未声明为「跑过且绿」。
- 未覆盖的条目及原因：无（CC-1..CC-4 四条全部核查）。`GET /api/repos/:owner/:name/settings` 之外的面板保存链路未逐行追踪（`state.save` 的请求构造未读），但服务端保存路径已按两条写入口全覆盖。
- 发现的额外问题（不属本节范围但值得记录）：
  1. `apps/panel/src/components/settings/v21-events-section.tsx:125` — 面板编辑关键词时 `mentions: next.map((keyword) => ({ keyword }))` 会把 `case_sensitive` 丢掉（CC-1 缺口的直接成因）。
  2. `apps/panel/src/components/settings/v21-events-section.tsx:521` — 面板新增角色固定 `by: 'members'` 且成员取 `draft.agent.managers`，无法定义 `by:'association'` 角色、也无法编辑成员列表；`apps/panel/src` 全量检索 `any_of|'association'` 无命中。association 维度只能靠直接调 PUT 接口写。
  3. `apps/panel/src/components/settings/v21-events-section.tsx:521` — `members.length === 0 ? [''] : members` 会产生空串成员，必然被 `MEMBER_LOGIN_RE` 拒收 → 管理员为空的仓库新增角色后保存直接 400。
  4. `packages/contract/src/settings-v21.ts:395-404` — 角色重名校验是精确匹配，而判定侧 `apps/server/src/trigger/roles.ts:36-38`、`:77` 归一化大小写 → `Admin` 与 `admin` 可同时存在且判定时等价，与 `repoSettingsSchema` 第 6 条注释「重名会让闸门选的是哪一个变成不确定」的意图不符。
  5. `packages/contract/src/settings-v21.ts:184` — 同一角色内 `members` 重复 login 无校验（只有 min/max/regex），重复项会白白占用 50 条上限。
