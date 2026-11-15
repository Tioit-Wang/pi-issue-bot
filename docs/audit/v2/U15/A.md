# U15 6.1 两个层级 + 6.2 继承与覆盖 · A

> 核查范围：docs/requirements.html 行 1447-1479
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览

| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| 6.1-A 平台级只管「模型 + bot 身份」 | 部分实现 | 模型侧只有端点/模型名/密钥，**没有「调用参数」任何配置位**；且平台级另有业务类开关（`PI_BOT_FREE_MENTION` / `PI_BOT_DEFAULT_SETTINGS`） |
| 6.1-B 项目级·触发侧（事件开关 / 模板 / 关键词 / 角色） | 已实现 | — |
| 6.1-C 项目级·执行侧（提示词 / 并发 / 日配额 / 超时） | 部分实现 | 日配额与单轮超时的项目级字段**无消费方**；并发存在两份配置，其中 `agent.limits.concurrency` 是死字段 |
| 6.1-D 项目级·标签目录（与 GitHub 同步） | 部分实现 | 标签目录存在且被消费，但**没有任何「与 GitHub 同步」实现**（无 label CRUD / 无同步作业） |
| 6.1-E 项目级·数据保留期 | 部分实现 | `agent.limits.data_retention_days` 有字段、面板可写，**清理作业不读它**（写死 90 天） |
| 6.2-1 「默认」是内置默认，平台级不参与 | 部分实现 | 内置默认成立；但存在平台级业务默认入口 `PI_BOT_DEFAULT_SETTINGS`（建行时 seed 整份业务配置） |
| 6.2-2 未配置项回落内置默认 | 已实现 | — |
| 6.2-3 项目配置整体覆盖，不追加不拼接 | 已实现 | — |
| 6.2-4 改动对下一个事件生效，已开始那轮不受影响 | 部分实现 | 判定/渲染侧成立；但写回执行时**二次查库**，且系统提示词只在新建会话时下发 |
| 6.2-5 配置随事件打成快照，判定与渲染同一份 | 已实现 | 快照是请求级内存对象（不落库），但「判定 = 渲染」这条成立 |

## 逐条

### 6.1-A 平台级只管两件事（模型 + bot 身份）

- **状态**：部分实现
- **证据**：
  - `apps/server/src/app/config.ts:89-98` — 平台级模型相关的**全部**环境变量键：`PI_BOT_MODEL_API_KEY`、`PI_BOT_MODEL_BASE_URL`、`PI_BOT_MODEL_NAME`（含 `OPENAI_*` / `DEEPSEEK_*` 别名）；无任何 temperature / max_tokens / top_p 类键。
  - `apps/server/src/app/config.ts:173-180` — `AppConfig.model` 只有 `apiKey` / `baseUrl` / `name` 三个字段。
  - `apps/server/src/app/config.ts:410-414` — 三者从 env 装配；`:341-345` 配了 key 却没模型名启动即抛。
  - `apps/server/src/app/model-env.ts:36-51` — `hostModelEnv()` 把三者换算成 pi-host 子进程环境；消费点 `apps/server/src/app/compose.ts:601`（`extraEnv: hostModelEnv(config)`）→ 平台级模型配置**生效**。
  - `apps/server/src/app/config.ts:73-84` — bot 侧：`PI_BOT_GITHUB_TOKEN` / `PI_BOT_GITHUB_APP_ID` / 私钥路径 / `PI_BOT_GITHUB_INSTALLATION_ID` / `PI_BOT_MENTION`（句柄）。
  - `apps/server/src/app/github-auth.ts:53-82` — App 凭证三件齐全走 installation token，否则回落静态 token。
  - `apps/server/src/app/compose.ts:959,968` — App slug（句柄）进入触发别名与 ack 的 `appSlug`。
  - `apps/server/src/app/config.ts:65-68` — 平台级**另有** `PI_BOT_DRY_RUN`（覆盖全部仓库）、`PI_BOT_ALLOW_PUSH_BRANCH`、`PI_BOT_FREE_MENTION`（「纯 @ 提问」触发开关）；`freeMention` 的消费点 `apps/server/src/app/compose.ts:961` → `apps/server/src/http/webhook.ts:1248` → `:598`。
- **缺口**：
  1. 「调用参数」子条件完全缺失：代码里没有任何模型调用参数（温度、max_tokens 等）的配置位，`AppConfig.model` 也没有对应字段。影响：6.1 表格「平台级 · 模型相关」四分之一内容无落点。
  2. 「平台级只管两件事」不成立：`PI_BOT_FREE_MENTION` 是触发侧开关（需求要求触发侧全部下放项目级）、`PI_BOT_DEFAULT_SETTINGS` 是业务配置默认值（见 6.2-1）。
- **判定依据**：模型端点/模型名/密钥与 bot 身份/句柄/App 凭证都有平台级配置位，且能沿「env → AppConfig → pi-host extraEnv / App 认证 / 触发别名」找到真实消费方，主体成立；但「调用参数」无任何配置位，且平台级还管了需求未授权的触发侧开关，故为部分实现。

### 6.1-B 项目级 · 触发侧（事件开关 / 事件模板 / 提及关键词 / 角色清单）

- **状态**：已实现
- **证据**：
  - 配置位：`packages/contract/src/settings-v21.ts:326-334`（`triggers.events` 五事件，各带 `enabled` / `prompt`）、`:198-203`（`comment.mentions` / `comment.roles`）、`:105-118`（四闸门含 `allow_roles`）；全部落在 `repos.settings` jsonb，写入口 `apps/server/src/http/api/index.ts:319-331`（`PUT /api/repos/:owner/:name/settings`），面板入口 `apps/panel/src/components/settings/v21-events-section.tsx`。
  - 事件开关生效：`apps/server/src/config/v21-settings.ts:105-116` → `apps/server/src/trigger/decide.ts:226-229`（`enabled === 'off'` 直接 `switch-off`）。
  - 事件模板生效：`apps/server/src/trigger/decide.ts:255-258` 取项目模板，空前缀回退内置；`apps/server/src/http/webhook-v21.ts:359-362` 同一裁决的第二个入口，`:464` 渲染时优先用判定已解析的 `decidedTemplate`。
  - 提及关键词生效：`apps/server/src/trigger/decide.ts:182`（`resolveCommentConfig(...).mentions`）→ `apps/server/src/trigger/mention.ts`（边界判定），`apps/server/src/config/v21-settings.ts:159-175` 在此处补齐 `case_sensitive: false`。
  - 角色清单生效：`apps/server/src/trigger/decide.ts:189`（`roles`）+ `:174`（`resolveCommentGates` → `allow_roles`/`require_role`），跨字段校验 `packages/contract/src/repo-config.ts:301-317`（`allow_roles` 必须引用已定义角色）。
- **缺口**：无。
- **判定依据**：四项都有项目级配置位、都可从面板写、都有明确的判定/渲染消费方，且「开关 off 时闸门一律不生效」的优先级也在同一函数里体现 —— 存在且生效。

### 6.1-C 项目级 · 执行侧（系统提示词 / 并发 / 日配额 / 超时）

- **状态**：部分实现
- **证据**：
  - 系统提示词**生效**：`packages/contract/src/repo-config.ts:184,191`（`agent.system_prompt` / `agent.limits`）→ `apps/server/src/config/v21-settings.ts:200-222`（空则回落 `AGENT_IDENTITY_PROMPT`）→ `apps/server/src/app/compose.ts:1407`（`systemPrompt: resolveAgentExecution(policy.settings).system_prompt`）→ `apps/server/src/worker/run-task.ts:838,916` → `apps/server/src/runtime/turn-driver.ts:377-390`（`session/create` 的 `systemPrompt`）。
  - 并发**生效但有两份配置**：`packages/contract/src/repo-config.ts:135`（`limits.concurrency_per_repo`）→ `apps/server/src/queue/repo-concurrency.ts:30-42` → `apps/server/src/app/compose.ts:1515`（仓库级闸门）；另一份 `packages/contract/src/settings-v21.ts:236`（`agent.limits.concurrency`，默认 2）由 `apps/server/src/config/v21-settings.ts:210` 产出后**全仓无读取**。
  - 日配额**无消费方**：字段 `packages/contract/src/settings-v21.ts:238`，产出 `apps/server/src/config/v21-settings.ts:211`，此后无读取；判定侧 `apps/server/src/trigger/decide.ts:250-253` 读的是 `input.dailyQuotaExceeded`，而该入参在两个调用点（`apps/server/src/http/webhook.ts:1195-1201`、`:1259`）都**从未传入**，全仓无任何地方把它设为 `true`。面板仍把该项当可配项渲染并保存：`apps/panel/src/components/settings/v21-agent-section.tsx:45,176`。
  - 单轮超时**无消费方**：字段 `packages/contract/src/settings-v21.ts:240`，产出 `apps/server/src/config/v21-settings.ts:212`，此后无读取；实际闸门是常量 —— `apps/server/src/worker/run-task.ts:457-463`（`timeoutMsForCommand()` 只看命令名）+ `apps/server/src/runtime/turn-driver.ts:35-37`（20 分钟 / `/review-pr` 30 分钟）。
- **缺口**：
  1. 「日配额」项目级只有字段没有执行路径：`daily-quota` 判定分支永远进不去，`quota_counters` 表也没有对应的写/读路径接到该字段。
  2. 「超时」项目级字段 `agent.limits.turn_timeout_minutes` 不被使用，真实超时是硬编码常量，改配置不改变行为。
  3. 并发有两个同名语义的配置位（`limits.concurrency_per_repo` 生效、`agent.limits.concurrency` 死字段），面板同时暴露两者，属于「配了不生效」的高发点。
- **判定依据**：系统提示词与并发（经 `concurrency_per_repo`）有真实消费方；但需求这一格里写明「并发数 / 日配额 / 超时」三项，其中两项只有字段没有执行路径，按「有字段 ≠ 被消费」口径只能判部分实现。

### 6.1-D 项目级 · 标签目录（与 GitHub 同步）

- **状态**：部分实现
- **证据**：
  - 目录配置位与消费：`packages/contract/src/repo-config.ts:97-110`（`labels.vocabulary`，含 `managed` / `status`）→ `apps/server/src/config/v21-settings.ts:249-258`（`resolveManagedCatalog`）→ 执行侧 `apps/server/src/http/webhook-v21.ts:690`、`apps/server/src/worker/run-task.ts:391,1329`；提示词注入 `apps/server/src/skills/prompt.ts:716-717`；词表过滤与互斥组 `apps/server/src/workflows/normalize.ts:112-154`。
  - 标签写回只作用于 issue：`apps/server/src/github/executor.ts:310-345`（`planLabelDelta` → `addLabels` / `removeLabel`）。
  - 仓库级标签资源（label CRUD：`POST/DELETE /labels`、`PATCH /labels/{name}`）在 `apps/server/src/github/` 下**不存在**；全仓检索 `createLabel` / `deleteLabel` / `updateLabel` 只命中 `apps/server/src/app/worker-deps.ts:567` 的 `createLabelWritebackPolicy`（策略工厂，不是 GitHub 标签同步）。
- **缺口**：「与 GitHub 同步」这一子条件缺失 —— 没有把目录与 GitHub 标签表双向对齐的实现（不建、不删、不改颜色/描述，也没有 `retired` 由 GitHub 侧回填的作业）。影响：目录里 `status: 'retired'` 与 `color` / `description` 只能人工维护，与 GitHub 实际标签会漂移。
- **判定依据**：目录本身是项目级配置且真正决定了模型可用的标签与打标范围（存在且生效）；但需求这一格括号里明写「与 GitHub 同步」，该子条件找不到任何实现路径，故部分实现。

### 6.1-E 项目级 · 数据保留期

- **状态**：部分实现
- **证据**：
  - 配置位：`packages/contract/src/settings-v21.ts:243-244`（`agent.limits.data_retention_days`，1-365，默认 90）；面板可写 `apps/panel/src/components/settings/v21-agent-section.tsx:59,178`。
  - 消费侧不读它：`apps/server/src/jobs/retention-cleanup.ts:25`（`RETENTION_DAYS = 90` 常量）、`:146`（`options.retentionDays ?? RETENTION_DAYS`）；调度装配 `apps/server/src/jobs/index.ts:162`（`retentionCleanup(pickCommonDeps(deps))`）不传任何仓库级天数。
  - 全仓检索 `data_retention_days` 仅命中 `apps/server/src/config/v21-settings.ts:218`（产出）与契约/面板，无第三个读取点。
- **缺口**：项目级「数据保留期」只有字段与面板输入框，清理作业按全局常量 90 天执行，且清理本身没有「按仓库」维度。影响：面板改保留期不改变任何行为，需求承诺的项目级可控项落空。
- **判定依据**：字段存在、可写、能被 `resolveAgentExecution()` 返回，但没有任何消费方改变行为，按「有字段 ≠ 被消费」判部分实现（缺「生效」这一半）。

### 6.2-1 业务侧的「默认」是内置默认，不是平台级配置

- **状态**：部分实现
- **证据**：
  - 内置默认确实存在且是业务默认的唯一来源：`packages/contract/src/settings-v21.ts:344-369`（`V21_DEFAULT_EVENT_TRIGGERS` / `V21_DEFAULT_COMMENT` / `V21_DEFAULT_AGENT_EXECUTION` / `V21_DEFAULTS`）、`:473-549`（`DEFAULT_EVENT_TEMPLATES`）、`:561-572`（`DEFAULT_SYSTEM_PROMPT`）、`packages/contract/src/repo-config.ts:370`（`DEFAULT_REPO_SETTINGS` = 形状默认值）。
  - 但平台级有业务默认入口：`apps/server/src/config/repo-config.ts:42`（`REPO_SETTINGS_ENV = 'PI_BOT_DEFAULT_SETTINGS'`）、`:55-93`（`loadDefaultRepoSettings()`：内联 JSON 或文件 → 严格校验）、`:99-102`（进程内缓存）、`:120-135`（`defaultRepoSettingsStatus()`）；建行时用它 seed：`apps/server/src/config/repo-config.ts:399-407`（`upsertRepo` 未给 settings 就走部署默认）；面板/API 侧同口径注释 `apps/server/src/http/api/index.ts:261`。
  - 另有平台级触发开关 `PI_BOT_FREE_MENTION`：`apps/server/src/app/config.ts:68,119,376` → `apps/server/src/app/compose.ts:961` → `apps/server/src/http/webhook.ts:1248,598`。
- **缺口**：需求 1468 行写明「平台级只有模型与 bot 两组配置，不参与业务默认值」，代码里 `PI_BOT_DEFAULT_SETTINGS` 恰恰是平台/部署侧供给的**整份业务配置**（五事件开关、模板、关键词、角色、词表、限额全部可被它预置）。影响：同一份内置默认之外多了一条不写在需求里的平台级业务默认来源，运维改一个环境变量就能改所有新接入仓库的业务行为。
- **判定依据**：「业务默认 = 随程序发布的出厂值」这一半成立（schema `.default()` / `.prefault()` + 三个默认常量，且面板与服务端共用同一份）；「平台级不参与业务默认值」这一半被 `PI_BOT_DEFAULT_SETTINGS` 直接反证，故部分实现。

### 6.2-2 项目未配置的项回落到内置默认

- **状态**：已实现
- **证据**：
  - 形状层给每段默认值：`packages/contract/src/repo-config.ts:211-239`（`triggers` / `comment` / `labels` / `skills` / `limits` / `agent` 全部 `.prefault({})`）；事件级默认表 `packages/contract/src/settings-v21.ts:326-334`（各事件 `enabled` / `prompt: null` / `gates`）。
  - 解析层回落：`apps/server/src/config/v21-settings.ts:70-77`（解析失败也回 `DEFAULT_REPO_SETTINGS`）、`:209`（系统提示词空 → `AGENT_IDENTITY_PROMPT`）、`:255-257`（`managed` / `status` 缺省补齐）。
  - 判定层回落：`apps/server/src/trigger/decide.ts:255-258`（`prompt` 为 `null` 或空白 → `DEFAULT_EVENT_TEMPLATES[event]`）；渲染层同口径 `apps/server/src/http/webhook-v21.ts:359-362`。
  - 测试断言：`apps/server/test/trigger-decide.test.ts:457-467`（空白 prompt → 内置默认模板）、`apps/server/test/v21-settings.test.ts:166,208,215`（未配 / 空白 system_prompt → 内置默认而非空串）。
- **缺口**：无（`data_retention_days` / `daily_quota` 等「回落了但没人用」的问题已在 6.1-C、6.1-E 记）。
- **判定依据**：默认值单点在契约 schema，四个消费层（判定 / 渲染 / 执行 / 面板）都从同一份取；未配置项落到内置默认有代码路径也有具体断言（不是只断言 200）。

### 6.2-3 项目配置整体覆盖内置默认，不追加、不拼接

- **状态**：已实现
- **证据**：
  - `apps/server/src/trigger/decide.ts:255-258` — `const rawPrompt = trigger.prompt ?? ''; const template = rawPrompt.trim() === '' ? DEFAULT_EVENT_TEMPLATES[event] : rawPrompt;`：三元互斥，**没有任何 `${builtin}${project}` 或数组拼接**。
  - `apps/server/src/http/webhook-v21.ts:359-362` — 同一裁决的第二入口，同样三元。
  - 渲染只吃一个字符串：`apps/server/src/http/webhook-v21.ts:342-347`（`renderTemplateAsync(input.template, ...)` 单入参），不存在「默认模板 + 项目模板」两次渲染再合并。
  - 系统提示词同样整体替换：`apps/server/src/config/v21-settings.ts:204-209`（`primaryPrompt` 非空即整段采用，否则才看 `limits.system_prompt`，两处都空才用内置，**无拼接**）。
  - 测试断言：`apps/server/test/trigger-decide.test.ts:444-455`（配了模板 → `decision.template` **等于**配置原文，含空白与换行）。
- **缺口**：无（唯一可商量处是 `agent.system_prompt` 与 `agent.limits.system_prompt` 两条路径并存，但那是「同一份语义的两个存放位置」二选一，不是拼接）。
- **判定依据**：覆盖语义由单个三元表达式实现、渲染入口只有一个字符串参数、并有「等于配置原文」的精确断言 —— 与「整体覆盖」一致，不存在追加/拼接路径。

### 6.2-4 改动对下一个事件生效；已经开始的那一轮不受影响

- **状态**：部分实现
- **证据**：
  - 每投递读一次库、无缓存：`apps/server/src/http/webhook.ts:1164`（`policy = await readRepoPolicy(deps.db, repo)`），随后同一份 `policy` 用于判定 `:1195-1201` 与渲染 `:1262-1270` → 配置改完后**下一个事件**立刻用新值。
  - 每任务读一次库：`apps/server/src/app/compose.ts:1113`（任务开始时 `readRepoPolicy`），`:1403,1407`（`settings` / `systemPrompt` 取自这一份），`:1123`（dry-run 三来源并集）。
  - 但写回时**二次查库**：`apps/server/src/app/compose.ts:836-838`（`createV21Executor({ settings: async (repo) => (await readRepoPolicy(pool, repo)).settings ?? null })`），该执行器由 `:847-864` 的 `execute` 钩子进入，被 `apps/server/src/worker/run-task.ts:1351-1359` 在**本轮写回步骤**调用 → 受限动作开关 / 标签目录 / `max_per_issue` 取的是写回那一刻的库值，而不是本轮开始时的那份。`run-task` 自己在 `:1313-1328` 算出的 `actionsEnabled` 只服务于 `:1375-1391` 的直连分支（生产总是注入 `execute`，该分支不走）。
  - 系统提示词只在新建会话时下发：`apps/server/src/runtime/turn-driver.ts:375-390`（`session/create` 分支带 `systemPrompt`，`session/attach` 路径不带，注释写在 `:382-383`）；会话按 issue 持久、永不删（`apps/server/src/http/webhook-v21.ts:786-800`）→ 已有会话上改 `agent.system_prompt` 对后续事件不生效。
- **缺口**：
  1. 「已经开始的那一轮不受影响」在写回侧不成立：同一轮 turn 内部若有人改了 `agent.actions` / 标签目录 / `max_per_issue`，写回步骤会读到新值（配置漂移窗口 = 一个 turn 的时长）。
  2. 「对下一个事件生效」对系统提示词不成立：只在 `session/create` 时生效，issue 已有会话时改了配置要到会话重建才生效。
- **判定依据**：判定/渲染侧确实是「每事件读一次、下一事件生效」，主体成立；但执行侧在同一轮里二次读取、系统提示词有会话级粘滞，两条都可定位到具体行，故部分实现。

### 6.2-5 配置随事件打成快照，保证「判定」与「渲染」用同一份配置

- **状态**：已实现
- **证据**：
  - 快照对象：`apps/server/src/http/webhook-v21.ts:924-954`（`V21WebhookRuntime.settings: unknown`，注释即「运行时快照」）；装填点 `apps/server/src/http/webhook.ts:1262-1270`（`settings: policy.settings`，与判定用的 `:1195-1201` 是**同一个** `policy` 对象）→ 尾随判定只读 `trace.decision`，不重读库（`apps/server/src/http/webhook.ts:1255-1259`）。
  - 判定产出的模板直接交给渲染：`apps/server/src/http/webhook-v21.ts:1016-1019`（`decidedTemplate: decision.template`）→ `:464`（`input.decidedTemplate ?? v21TemplateOf(input.settings, input.event)`，热路径不再二次 `resolveEventTrigger`）。
  - 渲染结果落库定型：`apps/server/src/http/webhook-v21.ts:1029-1037`（`body: build.text` → `agent_messages.comment_body`），后续投递重放读的是这份正文。
  - 执行侧也从同一份 rawSettings 派生：`apps/server/src/http/webhook-v21.ts:682-695`（`readV21Settings` / `resolveAgentExecution` / `resolveManagedCatalog` 全部吃 `rawSettings`）。
  - 库表**没有**事件级 settings 快照列：`apps/server/src/db/schema.ts:140-162`（`repos.settings` 只存「当前」值 + `settings_updated_at`）。
- **缺口**：无（若按更严口径要求「快照必须落库可回放」，则缺一份持久化；但需求这句话的目的——判定与渲染不各读一次库——已用请求内单对象 + 渲染结果落库达成）。
- **判定依据**：需求这句要防的是「判定读一次库、渲染又读一次库」。代码里一次投递只读一次 `repos.settings`，判定结果（含模板）随 `decision` 传进渲染，渲染正文落 `agent_messages` —— 目的达成，且能定位到「同一对象贯穿两条路径」的具体行。

## 本节整体结论

6.1 的层级切分骨架是成立的：平台级拿模型端点/模型名/密钥与 bot 身份/句柄/App 凭证，项目级五段（执行侧 / 触发侧 / 标签 / 其他）都真有 `repos.settings` 配置位与面板写入口。但项目级有四格只有字段没有执行路径或执行路径不完整——日配额、单轮超时、数据保留期三项完全无消费方，标签目录缺「与 GitHub 同步」，并发存在一份死配置。6.2 的四条机制里，「回落内置默认」「整体覆盖不拼接」「判定与渲染同一份快照」三条扎实；「默认不是平台级配置」被 `PI_BOT_DEFAULT_SETTINGS` 破， 「已开始那轮不受影响」被写回时的二次查库与系统提示词的会话级粘滞破。因此**本节不能整体判为「已实现」**，只能是：6.1「部分实现」、6.2「部分实现」。

## 核查边界

- 是否执行了命令：未执行测试/构建，纯静态核查（git status 与 baseline 一致：HEAD `fbfa029`，工作区改动清单同 `_baseline.txt`）。
- 未覆盖的条目及原因：
  - 6.1「调用参数」的具体期望字段需求未列举（无字段清单可比），只能判「代码里一个都没有」，无法判「缺哪几个参数」。
  - 「与 GitHub 同步」是否由尚未合并的分支/另一单元实现，本单元只按当前工作区代码判「不存在」。
  - 面板写入链路只核到「有输入框 + 有 PUT 接口」，未跑真面板验证保存后回读一致（需 PG + 浏览器）。
- 发现的额外问题（不属本节范围但值得记录）：
  1. `apps/server/src/config/v21-settings.ts:196-198` 让 `agent.actions` 与 `agent.limits.actions` 取「或」，同一语义存在两份存储路径；面板写前者、迁移可能写后者，长期是漂移点（虽注释已说明取舍）。
  2. `apps/server/src/app/compose.ts:1123` 的 `dryRun = input.dryRun || config.dryRun || policy.dryRun`（`apps/server/src/http/webhook.ts:1241` 是同一并集的另一半）使平台级 `PI_BOT_DRY_RUN` 可单向覆盖项目级 `settings.dry_run`——与 6.1「仓库之间差异只体现在项目配置」有张力，但方向上属安全侧，未计入状态判定。
  3. `apps/server/src/app/config.ts:66-68` 的注释块与键定义错位（`freeMention` 上方注释描述的是「接管评论开关」，该键已不存在），容易误导后来者以为还有第三个平台级业务开关。
  4. `apps/server/src/db/schema.ts:156` 的 `settings` 列默认 `{}` 与「严格校验不通过即该仓库不可用」叠加时，新仓库在 `PI_BOT_DEFAULT_SETTINGS` 未配置的情况下必然 `settings_valid=false`（`repo-config.ts:399-407`），面板首次打开必然报错——这是设计取舍，但与「未配置项回落内置默认」（6.2-2）在语义上容易混淆：回落的是**单项**，不是**整份**。
