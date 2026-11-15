# U15 6.1 两个层级 + 6.2 继承与覆盖 · B

> 核查范围：docs/requirements.html 行 1447-1479
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| 6.1-a 平台级只管模型与 bot 身份 | 部分实现 | 库内确实没有平台级业务配置表，但装配层 env 里带着整份业务默认（`PI_BOT_DEFAULT_SETTINGS`）与业务触发开关（`PI_BOT_FREE_MENTION`） |
| 6.1-b 项目级：agent 系统提示词 | 已实现 | — |
| 6.1-c 项目级：并发数 | 部分实现 | 面板改的 `agent.limits.concurrency` 无消费方；真正生效的是另一个字段 `limits.concurrency_per_repo` |
| 6.1-d 项目级：日配额 | 部分实现 | `agent.limits.daily_quota` 字段与面板入口都在，但全仓无计数/阈值消费方，`decideEvent` 的 `daily-quota` 分支入参永不为 true |
| 6.1-e 项目级：单轮超时 | 部分实现 | `turn_timeout_minutes` 无消费方；实际超时来自平台常量 20min / `/review-pr` 30min |
| 6.1-f 项目级：事件开关 | 已实现 | — |
| 6.1-g 项目级：事件提示词模板 | 已实现 | — |
| 6.1-h 项目级：评论提及关键词 | 已实现 | — |
| 6.1-i 项目级：角色清单 | 已实现 | — |
| 6.1-j 项目级：标签目录 | 已实现 | — |
| 6.1-k 项目级：数据保留期 | 部分实现 | `data_retention_days` 无消费方；保留期清理写死 90 天常量，面板/system 页也写死 90 |
| 6.2-a 默认是内置出厂默认，平台级不参与 | 部分实现 | 契约默认值在，但 `PI_BOT_DEFAULT_SETTINGS` 是平台/部署级整份业务默认（建行 seed 进项目配置） |
| 6.2-b 未配置项回落内置默认 | 已实现 | — |
| 6.2-c 项目配置整体覆盖、不拼接 | 部分实现 | 模板是整体替换（合规），但 `resolveAgentExecution()` 对 actions 做「两处配置取或」，属拼接 |
| 6.2-d 改动对下一个事件生效 | 部分实现 | 开关/模板/闸门每事件现读；系统提示词只在 `session/create` 下发，`persistent` 复用会话时改动不生效 |
| 6.2-e 配置随事件打成快照 | 部分实现 | 落库的是渲染后的文本，不是配置本体；同一事件在任务开始时又读了一次 `repos.settings` |

## 逐条

### 6.1-a 平台级只管两件事（模型 / bot 身份）
- **状态**：部分实现
- **证据**：
  - 平台级两类配置确实在 env 装配层：`apps/server/src/app/config.ts:173-180`（`model.apiKey/baseUrl/name`）、`apps/server/src/app/config.ts:403-409`（`github.token/appId/privateKeyPath/installationId/mention`）。
  - 库里没有「平台级业务配置」表：`apps/server/src/db/schema.ts` 的表清单（88/146/193/265/296/317/348/381/409/427/452/472/491/514/536/560/580/611/634/658/706/740/764/793）里没有 platform settings 一类；业务配置只存 `repos.settings`（`apps/server/src/db/schema.ts:155-162`）。→ 「平台级是否也有事件开关/模板默认值存在库里」这一反证点**排除**。
  - 但平台级也带业务配置：`apps/server/src/config/repo-config.ts:42` `REPO_SETTINGS_ENV='PI_BOT_DEFAULT_SETTINGS'`，`apps/server/src/config/repo-config.ts:55-93` 把 env 解析成**整份 `RepoConfig`**（含 events / comment / labels / agent）；`apps/server/src/config/repo-config.ts:404-407` 在建行时 seed 进 `repos.settings`。
  - 另一个平台级业务开关：`apps/server/src/app/config.ts:68,376` `PI_BOT_FREE_MENTION`，消费点 `apps/server/src/http/webhook.ts:598-599`（`freeMention===false` → `ignore`，即「纯 @ 提问要不要处理」由部署级决定）。
- **缺口**：需求说「平台级只管连哪个模型、用哪个 bot 身份」，而平台级还持有 (a) 一份可整体覆写出厂默认的业务配置来源、(b) 一个事件级触发开关。前者不是运行期回落（只在建行时 seed 一次），但它仍是「平台级能决定业务默认值」的能力；后者直接违反「事件开关是项目级」。
- **判定依据**：「库里无平台级业务默认」成立 → 不算违规的主要形态；但平台级存在两处业务可配项 → 不是「只管两件事」，只能判部分实现。
- **反证过程**：先假设违规形态是「平台级设置表里存着事件开关/模板默认值」→ 逐表检查 `schema.ts` 无此类表，该假设被推翻；再假设「合法」→ 搜 `PI_BOT_` 前缀里是否有业务语义项，命中 `PI_BOT_DEFAULT_SETTINGS`（整份业务配置）与 `PI_BOT_FREE_MENTION`（事件开关）。区分「内置出厂常量」（`packages/contract/src/settings-v21.ts:344-369`，合法）与「平台可配项」（上述两处 env，越界）后判部分实现。

### 6.1-b 项目级：agent 系统提示词
- **状态**：已实现
- **证据**：`packages/contract/src/repo-config.ts:184`（`agent.system_prompt`，带默认值，`.strict()` 容器在 198 行）；`packages/contract/src/settings-v21.ts:234`（`agentExecutionSchema.system_prompt`，内置默认在 561-572）；裁决 `apps/server/src/config/v21-settings.ts:200-222`（204-209：非空优先，空则 `AGENT_IDENTITY_PROMPT`）；消费 `apps/server/src/app/compose.ts:1404-1407` → `apps/server/src/worker/run-task.ts:838,916` → `apps/server/src/runtime/turn-driver.ts:377-390`（进 `session/create` 的 system 通道）。
- **判定依据**：有项目级配置位、有单一裁决点、有真实下发路径（不是注释承诺）。
- **反证过程**：假设它只是死字段 → 追调用方：`resolveAgentExecution(...).system_prompt` 在 `compose.ts:1407` 被取，`run-task.ts:916` 塞进 `driveTurn`，`turn-driver.ts:384-386` 进 `session/create`。链路闭合，假设被推翻。

### 6.1-c 项目级：并发数
- **状态**：部分实现
- **证据**：项目级字段两处：`packages/contract/src/settings-v21.ts:236`（`agent.limits.concurrency`，面板入口 `apps/panel/src/components/settings/v21-agent-section.tsx:31,38-43`、摘要 `apps/panel/src/components/settings/settings-chrome.tsx:70`）与 `packages/contract/src/repo-config.ts:135`（`limits.concurrency_per_repo`）。生效路径只认后者：`apps/server/src/queue/repo-concurrency.ts:30-42` `concurrencyPerRepoOf()` → `apps/server/src/app/compose.ts:1514-1515` → `apps/server/src/queue/boss.ts:230-234`。前者只被 `apps/server/src/config/v21-settings.ts:210` 读出到 `ResolvedAgentExecution`，全仓无第二个调用方（grep `resolveAgentExecution` 只有 `compose.ts:1407` 取 `system_prompt`、`run-task.ts:1316,1328` 取 `actions`）。
- **缺口**：需求要「并发数是项目级」，这一点由 `concurrency_per_repo` 满足；但面板与契约主推的 `agent.limits.concurrency` 是死字段——用户把面板上的「并发会话数」从 2 调到 8，闸门仍按 `concurrency_per_repo`（默认 2）执行，两处数字互不影响。
- **判定依据**：有项目级位且能生效的只有旧字段；新字段「有字段无消费方」按证据口径属未生效。
- **反证过程**：假设面板并发真的生效 → 搜 `concurrency` 的所有读取点：闸门读的是 `settings.limits.concurrency_per_repo`（`repo-concurrency.ts:38`），不是 `settings.agent.limits.concurrency`；再确认 `resolveAgentExecution().concurrency` 无调用方读取。假设被推翻。

### 6.1-d 项目级：日配额
- **状态**：部分实现
- **证据**：字段 `packages/contract/src/settings-v21.ts:237-238`（`daily_quota`，1–1000，默认 100）、面板入口 `apps/panel/src/components/settings/v21-agent-section.tsx:44-50`；读取点仅 `apps/server/src/config/v21-settings.ts:211`（进 `ResolvedAgentExecution`，其 `daily_quota` 无消费方）。判定侧只剩一个入参：`apps/server/src/trigger/decide.ts:250-253`（`input.dailyQuotaExceeded===true` → `skip(event,'daily-quota')`），而该入参在全仓**没有任何生产者**——只出现在类型与透传里：`apps/server/src/http/webhook-v21.ts:118,155,168`。
- **缺口**：缺「计数 + 阈值比较 + 置位」这一整条子条件。日配额达上限时不会有任何拒绝，`daily-quota` 这一 skip 原因不可达；面板上的「日配额」改了对行为零影响。
- **判定依据**：字段与 UI 存在不等于实现（证据口径第 2 条）；本条的生效路径不存在。
- **反证过程**：假设配额已实现 → 从 `daily-quota` 这个 reason 反推生产者：grep `dailyQuotaExceeded` 仅 6 处，全部是类型声明/参数转发，`quota_counters` 表（`apps/server/src/db/schema.ts:634-644`）也无读写方。所谓「实现」只是一条 dormant 分支，假设被推翻。

### 6.1-e 项目级：单轮超时
- **状态**：部分实现
- **证据**：字段 `packages/contract/src/settings-v21.ts:239-240`（`turn_timeout_minutes` 1–30，默认 20）、面板入口 `apps/panel/src/components/settings/v21-agent-section.tsx:51-55`；读取点仅 `apps/server/src/config/v21-settings.ts:212`，无第二个消费方。真实超时来源是平台常量：`apps/server/src/runtime/turn-driver.ts:35-37`（`DEFAULT_TURN_TIMEOUT_MS=20min`、`REVIEW_PR_TURN_TIMEOUT_MS=30min`）→ `apps/server/src/worker/run-task.ts:458-462` `timeoutMsForCommand()` → `apps/server/src/worker/run-task.ts:575`；装配层注入的也是这条常量 `apps/server/src/app/compose.ts:1388-1389`。
- **缺口**：项目级超时字段不参与任何时限计算；项目把它配成 5 分钟或 30 分钟，任务仍然按平台常量跑。若按「生效行为」看，超时实际被平台级常量决定，与「超时下放项目级」相反。
- **判定依据**：字段/校验/UI 在，生效路径缺 → 部分实现。
- **反证过程**：假设项目超时生效 → 追 `timeoutMs` 的唯一来源：`run-task.ts:575` 来自 `deps.timeoutForCommand`，装配层给的是 `timeoutMsForCommand(command)`（`compose.ts:1389`），该函数只认命令名与两个常量（`run-task.ts:458-462`），完全不读 settings。假设被推翻。

### 6.1-f 项目级：事件开关
- **状态**：已实现
- **证据**：`packages/contract/src/settings-v21.ts:81-91`（`enabled: on/off/conditional`）、`326-334`（五个事件各自的默认值）；解析 `apps/server/src/config/v21-settings.ts:105-116`；判定 `apps/server/src/trigger/decide.ts:225-229`（`off` → `skip('switch-off')`，且闸门不再判）。
- **判定依据**：配置位 + 解析 + 判定消费三处齐全，且 `off` 有明确短路行为。
- **反证过程**：假设开关只在库里不生效 → 找判定入口：`decideEvent()`（`decide.ts:209`）第一步读 `resolveEventTrigger(input.settings,event)` 并据 `enabled` 短路；v2 分支 `webhook-v21.ts:987-994` 用判定结果决定不入队。假设被推翻。

### 6.1-g 项目级：事件提示词模板
- **状态**：已实现
- **证据**：`packages/contract/src/settings-v21.ts:84-85`（`prompt: string|null`，`null`=用内置）；内置默认 `packages/contract/src/settings-v21.ts:473-549`；选择与回落 `apps/server/src/trigger/decide.ts:255-258`、`apps/server/src/http/webhook-v21.ts:359-362`；实际渲染 `apps/server/src/http/webhook-v21.ts:464,1007-1019`（用 `decision.template`）。
- **判定依据**：模板取值单点、渲染单点，且未配置/空白回落到内置模板。
- **反证过程**：假设项目中配的模板没被真正使用 → 追 `buildV21AgentMessage` 的 `template`：优先 `decidedTemplate`（`webhook-v21.ts:464`），webhook 侧传的是 `decision.template`（`1007-1017`），即 `decideEvent` 拿项目 `prompt` 或内置默认算出的那一份。假设被推翻。

### 6.1-h 项目级：评论提及关键词
- **状态**：已实现
- **证据**：`packages/contract/src/settings-v21.ts:131-142`（关键词 + `case_sensitive`）、`198-203`（`comment.mentions` 至少 1 个）；解析 `apps/server/src/config/v21-settings.ts:159-175`；消费 `apps/server/src/trigger/decide.ts:181-187`（`require_mention` 时 `findLegalMention(body, mentions)`）。
- **判定依据**：关键词从项目配置取值并直接决定判定结果。
- **反证过程**：假设判定用的是硬编码句柄而不是项目配置 → 读 `decide.ts:182` 取值来源是 `resolveCommentConfig(input.settings)`，`settings` 由 webhook 从 `repos.settings` 读出（`webhook.ts:1164`）；默认值 `pi-bot` 只是 schema 默认（`settings-v21.ts:341`），可被项目覆盖。假设被推翻。

### 6.1-i 项目级：角色清单
- **状态**：已实现
- **证据**：`packages/contract/src/settings-v21.ts:170-187`（判别联合 `by: association|members`）、`198-203`（`comment.roles`）；跨字段校验 `packages/contract/src/repo-config.ts:301-317`（`allow_roles` 只能引用已定义角色、角色名不许重名）；解析 `apps/server/src/config/v21-settings.ts:159-175`；消费 `apps/server/src/trigger/decide.ts:188-199`（`require_role` 时 `matchCommentRole`）。
- **判定依据**：定义、引用校验、判定消费齐全。
- **反证过程**：假设角色清单只是展示用 → 追 `matchCommentRole` 的 `roles`：来自 `resolveCommentConfig(input.settings)`（`decide.ts:189`），不匹配即 `skip('role-denied')`。假设被推翻。

### 6.1-j 项目级：标签目录
- **状态**：已实现
- **证据**：`packages/contract/src/repo-config.ts:76-110`（`labels.vocabulary` + `max_per_issue`）、`packages/contract/src/settings-v21.ts:275-292`（`managed`/`status`）；解析 `apps/server/src/config/v21-settings.ts:249-258`；消费两处：写回执行 `apps/server/src/http/webhook-v21.ts:690-705`、`apps/server/src/worker/run-task.ts:390-397,1329`。
- **判定依据**：目录是项目级唯一事实源，并被写回判定真正读取（不是只做展示）。
- **反证过程**：假设目录只是面板展示 → 追 `catalog` 参数：`executeV21({catalog, ...})`（`webhook-v21.ts:696-705`）、`v21CatalogOf(rawSettings)`（`run-task.ts:1329`），都来自项目 settings。假设被推翻。
- （说明：与 GitHub 的实际同步动作不属本节「层级归属」判定范围，未在此核实。）

### 6.1-k 项目级：数据保留期
- **状态**：部分实现
- **证据**：字段 `packages/contract/src/settings-v21.ts:243-244`（`data_retention_days` 1–365，默认 90）、面板入口 `apps/panel/src/components/settings/v21-agent-section.tsx:31,57-60`；读取点仅 `apps/server/src/config/v21-settings.ts:218`，无第二个消费方。真实保留期是全局常量：`apps/server/src/jobs/retention-cleanup.ts:25`（`RETENTION_DAYS=90`）、`146`（`options.retentionDays ?? RETENTION_DAYS`），清理 SQL 不含仓库维度；面板/system 页展示的也是写死的 90：`apps/server/src/queries/system.ts:38`（`webhookDays:90, runEventDays:90, transcriptDays:90`）。
- **缺口**：缺「按项目生效」这一子条件。项目把保留期配成 30 天，清理作业仍按 90 天删；而且清理语句没有 repo 维度，意味着即使接上也只能取一个全局值——「保留期是项目级」在当前数据访问形状下无法成立。
- **判定依据**：字段/UI 在、消费方缺 → 部分实现。
- **反证过程**：假设保留期已按项目生效 → 找 `retentionDays` 的来源：`jobs/retention-cleanup.ts:110,146` 只接受显式 options 或常量；`jobs/index.ts:162` 调用时未传该选项（`retentionCleanup(pickCommonDeps(deps))`）。假设被推翻。

### 6.2-a 业务默认是内置出厂默认，不是平台级配置
- **状态**：部分实现
- **证据**：出厂默认确实在契约里、且是唯一来源：`packages/contract/src/settings-v21.ts:344-369`（`V21_DEFAULTS` 单一出口）、`repo-config.ts:370`（`DEFAULT_REPO_SETTINGS = repoSettingsShapeSchema.parse({})`）。但平台级另有一份业务默认入口：`apps/server/src/config/repo-config.ts:42`（`PI_BOT_DEFAULT_SETTINGS`）、`55-93`（可内联 JSON 或文件，解析成整份 `RepoConfig`）、`defaultRepoSettings()`（99-102）、seed 点 `404-407`（`upsertRepo` 用它建行）。
- **缺口**：需求明写「业务侧的『默认』是内置默认，不是平台级配置」。代码里存在一个平台/部署级入口，能把整份业务配置（事件开关、模板、角色、标签、限额）当成「新仓库的默认」写进项目。它不是运行期回落（只在建行时用一次，之后只认库里的值），但能力本身越界。
- **判定依据**：判定点为「默认值从哪来」。出厂默认那条成立；「平台级不得参与业务默认」这条被 `PI_BOT_DEFAULT_SETTINGS` 打破。
- **反证过程**：假设这条 env 只是「部署期一次性种子、不算平台级配置」→ 查它是否参与读路径：`readRepoPolicy()`（255-293）只读库列，不合并默认值 → 种子假设成立一半；再查它是否覆盖出厂默认：`loadDefaultRepoSettings()` 用 env 内容整体替换默认（88-92 用 env 解析结果返回）。因此「平台级能改业务默认值」为真，判部分实现而非已实现。

### 6.2-b 未配置项回落内置默认
- **状态**：已实现
- **证据**：默认值写在 schema：`packages/contract/src/settings-v21.ts:81-91,105-118,231-246,275-292`，段级 `prefault({})` 在 `packages/contract/src/repo-config.ts:222,229,233,234,235,237`；解析即补默认 `apps/server/src/config/v21-settings.ts:70-77`（失败回落 `DEFAULT_REPO_SETTINGS`）；空值回落的内置内容：系统提示词 `v21-settings.ts:204-209`、事件模板 `apps/server/src/trigger/decide.ts:255-258`、`apps/server/src/http/webhook-v21.ts:359-362`。
- **判定依据**：三处「未配置」都有明确回落点，且回落目标是程序内置值而不是平台配置。
- **反证过程**：假设存在第二份回落默认（漂移）→ 搜 `??`/`||` 拼默认值的写法：没有发现业务字段在 resolver 之外再拼默认；写库路径 `repo-config.ts:449-473` 先 `validateRepoSettings()`，未配置项由 schema 补齐。假设被推翻。

### 6.2-c 项目配置整体覆盖，不追加、不拼接
- **状态**：部分实现
- **证据**：
  - 合规面：模板是整体替换，没有与内置模板拼接——`apps/server/src/http/webhook-v21.ts:359-362`（项目 `prompt` 非空白就整份替换，空白才用 `DEFAULT_EVENT_TEMPLATES[event]`）；`apps/server/src/trigger/decide.ts:255-258` 同一口径；写库是整份覆盖 `apps/server/src/config/repo-config.ts:449-473`（PUT 整份 settings，无字段级 merge）。
  - 违规面：`apps/server/src/config/v21-settings.ts:213-217` 对 actions 做 `agent.actions.X || limits.actions.X`——两处项目配置**取或**，任一处为 true 即开；`196-198` 的注释自述「用『或』而不是『与』」。同一函数里 `system_prompt` 是「两处取其一」（`204-207`，属覆盖语义，可接受）。
- **缺口**：`actions` 的「或合并」是拼接语义：项目把 `agent.actions.open_pr` 显式设为 false，只要 `agent.limits.actions.open_pr` 还是 true，动作仍开——「显式关掉」被另一处配置顶回。需求要求项目配置整体覆盖、不拼接。
- **判定依据**：需求附带说明「整体覆盖意味着项目一旦配了模板，就不再继承内置模板的任何内容」，模板侧成立；但同一份项目配置内部存在跨路径合并分支，属子条件缺失。
- **反证过程**：假设存在 deepMerge → 全仓 grep `deepMerge|mergeWith|mergeDefaults` 为零命中，`node_modules` 外的合并只有 zod 的 `prefault`（逐字段补默认，属「未配置项回落」，合规）与 `v21-settings.ts:213-217` 的 `||`。据此把「逐字段回落」判为合规、「`||` 合并」判为拼接。

### 6.2-d 配置改动对下一个事件生效
- **状态**：部分实现
- **证据**：
  - 生效面：每次投递都现读配置——`apps/server/src/http/webhook.ts:1162-1168`（`readRepoPolicy`）→ `handleV21Webhook(rt)` 的 `rt.settings`（`webhook-v21.ts:933,1007-1019`）。开关/模板/闸门/关键词/角色/标签目录都不需要重启或重建会话。
  - 失效面（系统提示词）：只在 `session/create` 那一个分支带 system 通道——`apps/server/src/runtime/turn-driver.ts:375-391`（`359-374` 走 `session/attach` 复用时不带，注释 383 明示）；而 v2 消息的会话是 `persistent` 且会被复用：`apps/server/src/app/compose.ts:242-243,444-445,467-469`。
  - 失效面（限额类）：见 6.1-c/d/e/k——`concurrency`（`agent.limits`）、`daily_quota`、`turn_timeout_minutes`、`data_retention_days` 改完不改变任何行为。
- **缺口**：需求说「配置改动对下一个事件生效」。对已有会话的 issue，改系统提示词后下一个事件仍是旧提示词（要等会话 attach 失败重建或新建会话）；四个限额字段的改动永远不生效。缺「改动即对下一事件生效」这一子条件。
- **判定依据**：事件面配置满足；会话级 + 限额类配置不满足，属子条件缺失。
- **反证过程**：假设系统提示词每轮都下发 → 读 `turn-driver.ts:359-391`：`session/attach` 成功后 `sessionId` 已定，跳过整个 `session/create` 分支，`params.systemPrompt` 不再使用。再查会话是否真会复用：`compose.ts:467-469` 给 `{mode:'persistent', sessionId, after}`，`agent_sessions` 行存在即复用（`webhook-v21.ts:786-802` 只 INSERT/UPDATE，不 DELETE）。假设被推翻。

### 6.2-e 配置随事件打成快照，判定与渲染用同一份配置
- **状态**：部分实现
- **证据**：
  - 同一份配置在 webhook 内部成立：`apps/server/src/http/webhook.ts:1164` 读一次 → 判定 `apps/server/src/http/webhook-v21.ts:987`（`rt.decision`）→ 渲染用 `decision.template`（`webhook-v21.ts:464,1017`），中间不二次读库（该文件 445-448 注释与实现一致）。
  - 落库的「快照」只有渲染结果：`apps/server/src/http/webhook-v21.ts:1029-1037`（`body: build.text` 写 `agent_messages.comment_body`）；表结构只到文本级 `apps/server/src/db/schema.ts:706-725`（`commentBody` 在 720），`tasks`（193-262）与 `agent_messages` 都没有 settings/config 快照列。
  - 执行侧又读了一次：`apps/server/src/app/compose.ts:1111-1113`（任务开始时 `readRepoPolicy`）→ `apps/server/src/app/compose.ts:1399-1407`（`v21.settings`、`systemPrompt`）→ `apps/server/src/worker/run-task.ts:1313-1329`（再 `readV21Settings`/`resolveAgentExecution`/`v21CatalogOf`）；`compose.ts:1399` 的注释明说是为了「避免仓库配置改了但 worker 还读旧值」，即**有意**在任务开始时重读。
- **缺口**：缺「配置本体随事件快照」这一子条件。需求给出的目的是「判定」与「渲染」同一份——这层在 webhook 内成立；但一条事件从触发到写回要跨两次读库（触发时 / 任务开始时），事件后改配置会让「这一轮按哪份模板发的」与「这一轮按哪份目录/开关写回」不一致，A 事件读到 B 事件的配置。
- **判定依据**：有「快照」的替代物（渲染文本），但没有配置快照；且存在明确的两条独立读取路径（webhook 触发时、任务开始时）。
- **反证过程**：按任务给的检查点「假设快照不存在——找判定路径与渲染路径是否各自独立读了一次配置」：判定与渲染**不是**各自读，而是共享 webhook 那一次读（`decidedTemplate` 直传）；但把范围延伸到执行/写回（目录、动作开关、系统提示词）后，出现第二个读取点（`compose.ts:1113`）。因此「快照」不是完全没有，而是只覆盖到渲染文本，配置本体没有随事件冻结 → 判部分实现而非未实现。

## 本节整体结论
6.1 的层级归属大体成立：库里没有平台级业务配置表，事件开关、事件模板、提及关键词、角色清单、标签目录、系统提示词都是项目级并且真的被判定/执行侧消费。但「其余全部下放到项目级」有四处硬缺口：日配额、单轮超时、数据保留期三项「只有字段与面板入口、没有消费方」，并发数则存在「面板改的字段不生效、真正生效的是另一个字段」的双轨。平台级本身也越界带了两处业务配置（`PI_BOT_DEFAULT_SETTINGS`、`PI_BOT_FREE_MENTION`）。
6.2 的四条里，「未配置回落内置默认」完全成立，「整体覆盖」在模板侧成立但被 actions 的 `||` 合并破坏，「下一个事件生效」对系统提示词（会话复用时）与四个限额字段不成立，「配置随事件快照」只到渲染文本、配置本体在任务开始时被重读。
因此本节**不能**判为「已实现」，结论为部分实现，缺口集中在「限额类字段无消费方」与「会话级/执行期配置的两条读取路径」。

## 核查边界
- 是否执行了命令：执行了只读命令 —— `git status --short`、`git log --oneline -3`（HEAD `fbfa029`，工作区与 `_baseline.txt` 一致）、以及多次 `Select-String` 全文检索（键名 `daily_quota`/`dailyQuotaExceeded`/`turn_timeout_minutes`/`data_retention_days`/`concurrency`/`retention`/`snapshot`/`deepMerge`/`mergeWith`/`max_task_minutes`/`queue_wait_minutes`/`freeMention`/`resolveAgentExecution`/`resolveEventTrigger`/`resolveCommentGates`/`resolveCommentConfig`/`resolveManagedCatalog`/`readV21Settings`/`dailyQuota` 等）。**未执行**测试、typecheck、lint、构建，结论全部为静态核查。
- 未覆盖的条目及原因：标签目录与 GitHub 的「同步」动作不在 6.1/6.2 的层级判定范围内，未核实；`pull_request.*`、事件闸门的判定正确性属其他单元；`dry_run` 的三层来源（进程/仓库/调用方）是否违反 6.1 未展开（它既是平台级 env 又是项目级字段，值得单独核）。
- 发现的额外问题（不属本节范围但值得记录）：
  1. `settings.model`（`packages/contract/src/repo-config.ts:219-220`，注释称「该仓库默认模型」）在 `apps/server/src` 无消费方；同时它与 6.1「模型归平台级」的方向相反，属死字段 + 反向越界。
  2. `limits.max_task_minutes`（`packages/contract/src/repo-config.ts:132-133`）只有校验与测试引用，无消费方（`grep maxTaskMinutes|taskMinutes` 零命中）。
  3. `agent.actions` 与 `agent.limits.actions` 是同一语义的两条路径（`packages/contract/src/repo-config.ts:191-197`），`v21-settings.ts:213-217` 用「或」裁决，导致面板显式关闭可能被另一处配置顶回。
  4. 日配额判定分支 `trigger/decide.ts:250-253` 与 `quota_counters` 表（`db/schema.ts:634-644`）都无人使用，容易被误读成「已实现」。
