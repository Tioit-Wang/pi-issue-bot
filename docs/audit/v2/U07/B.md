# U07 4.1 平台内部四个部件与边界 · B

> 核查范围：docs/requirements.html 行 638-718
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| P4-1 | 已实现 | 四块在目录与依赖方向上可辨认；但 `agent/` 目录名与实际归属（调度）不符，且 `SqlRunner` 这类 DB 端口类型寄居在 `config/`，造成「谁都依赖 config」的假依赖 |
| P4-2 | 已实现 | 执行面（`runtime/` + `sandbox/`）零引用业务配置，配置只在装配层读成字符串下发；唯一缺口是 `runtime ✗→ config` 没进 lint zone，靠约定 |
| P4-3 | 已实现 | 容器 Env 白名单四条、exec 不透传 env、无裸 `api.github.com` 调用、shell 里 issue 操作被审批拒绝 |
| P4-4 | 部分实现 | 「不合规产出也会落地」的子条件被兜底评论打破：信封无效时仍会把模型最后一段人话当评论发出去（run-task.ts:1243-1291），与 FR-5.5「输出不合契约时评论保持原状」相反 |
| P4-5 | 部分实现 | v2.1 链路成立（模板/系统提示词/目录全在配置里）；但仍在交付的 v0.3 链路把事件文案硬编码在 `agent/message.ts:35-72`，老链路改文案必须改 agent 代码 |

## 逐条

### P4-1
- **状态**：已实现
- **证据**：
  - 配置：`packages/contract/src/settings-v21.ts:326` — `eventTriggersSchema` 固定事件全集与默认开关（opened/edited/labeled/closed/comment）；`:234` — `system_prompt` 字段；`apps/server/src/config/v21-settings.ts:200` — `resolveAgentExecution()` 是「配置值优先、空则内置默认」的唯一裁决点。
  - 调度：`apps/server/src/http/webhook.ts:1049` — 验签（缺签名 401，不设宽容模式）；`:95`、`:99` — `webhook_deliveries` 投递级幂等；`apps/server/src/trigger/decide.ts:209`、`:226` — `decideEvent()` 经 `resolveEventTrigger()` 取事件配置；`apps/server/src/agent/store.ts:147` — 任务入队 SQL；`apps/server/src/queue/definitions.ts:18` — `singletonKey = taskId` 的队列定义。
  - Agent：`apps/server/src/runtime/turn-driver.ts:29`-`:32` — 轮次驱动只依赖审批策略与 RACP 契约；`apps/server/src/runtime/host-supervisor.ts:500` — 拉起 pi-host（模型调用在宿主侧进程）；`apps/server/src/sandbox/hostconfig.ts:99` — 容器规格纯函数；`apps/server/src/app/worker-deps.ts:953` — `assemblePrompt()` 在装配层合成上下文。
  - 记录：`apps/server/src/db/schema.ts:296`、`:317`、`:348`、`:706` — `run_events` / `envelopes` / `actions` / `agent_messages` 四张留痕表；`apps/server/src/queries/audit.ts:72`-`:94` — 只读查询 `actions` 与 `run_events` 拼审计视图。
- **判定依据**：四块各自有独占目录且依赖方向被 `eslint.config.js:41-90` 的 `import-x/no-restricted-paths` 硬拦（`queries` 不得引业务模块、`http/api` 只能走 `queries`、`http/webhook` 只能依赖 `github`+`queue`、`worker ✗→ http`、`runtime ✗→ worker/http/queries/sandbox/git/github/queue`），不存在循环依赖：`config → skills/prompt.ts`（`config/v21-settings.ts:35`）是单向的。
- **反证过程**：
  1. 假设「四块只是目录改名」→ 逐条查依赖方向：`runtime/` 与 `sandbox/` 的 import 列表里没有 `worker`/`http`/`github`/`queue`；`queries/audit.ts` 只 import `db` 与 `sql.ts`。方向是真实存在的，不是命名。
  2. 假设「跨层直连存在」→ 找 `agent/` 的出边：`agent/ack.ts:11`-`:12` 直接 `import { removeOwnReaction } from '../feedback/index.ts'` 与 `GithubReactionApi`（`github/` 类型）。这说明 **`agent/` 目录属调度块**（会话映射/消息表/回执），不是需求里的「Agent 部件」；若把目录名当部件名会得出错误结论。
  3. 假设「职责边界有门禁」→ 发现 `agent/` **完全没有 zone 覆盖**（`eslint.config.js` 的 `dependencyZones` 里无 `agent`；AGENTS.md §3 自述「其余模块（如 `agent/`）靠约定与评审」）。这是「可辨认」而非「被强制」，但本条目只要求可辨认，故不降级。
  4. 顺带核 `SqlRunner`：`config/repo-config.ts:23` 定义了这个通用 DB 端口类型，`agent/store.ts:17`、`agent/dispatcher.ts:35`、`agent/permission.ts:11` 都以 `import type { SqlRunner } from '../config/repo-config.ts'` 取得它——「agent 依赖 config」在类型层面成立，但运行时无耦合（`import type` 被 `verbatimModuleSyntax` 擦除），且该类型与「配置」无关，属归属错位。

### P4-2
- **状态**：已实现
- **证据**：
  - `apps/server/src/app/compose.ts:1401`-`:1407` — 装配层从 `policy.settings` 算出 `systemPrompt: resolveAgentExecution(policy.settings).system_prompt`，作为 `deps.v21` 的字符串注入 worker。
  - `apps/server/src/app/worker-deps.ts:953` — `assemblePrompt({...})` 在装配层把系统提示词、AGENTS.md、技能、项目提示词合成一段文本。
  - `apps/server/src/worker/run-task.ts:784`-`:800`、`:838`、`:916` — worker 只接收 `input.prompt` / `deps.v21.systemPrompt` 字符串，再交给宿主；没有一处回头读 settings 决定「说什么」。
  - `apps/server/src/sandbox/hostconfig.ts:165`-`:170` — 容器 Env 只有 `NODE_OPTIONS` / `HOME` / `CI` / `TERM` 四项。
- **判定依据**：「不直读配置」指的是执行侧（`runtime/`、`sandbox/`、容器）不碰业务配置。这四处证据覆盖了执行侧全部入口：环境、上下文、轮次提示词。业务配置类入库只发生在 `app/`（装配）与 `worker/`（执行编排，读 `repos.settings` 判动作开关，见 `run-task.ts:1313`-`:1329`）。
- **反证过程**：
  1. 假设「agent 侧偷偷读配置表」→ 全量搜 `runtime/*.ts`、`sandbox/*.ts` 的 `settings|repo-config|v21-settings|repos.settings`：**零命中**；搜 `process.env`：仅 `host-supervisor.ts:487`（子进程基准环境）与 `docker.ts:61`（docker socket 覆盖）。
  2. 假设「模型 key 读 env 算违反」→ 按任务口径排除：`app/model-env.ts:36` 把 `config.model.*` 转成 `PI_BOT_MODEL_*`/`OPENAI_*` 交给 pi-host（宿主可信侧），且 `compose.ts:601` 注释与 `hostconfig.ts:165` 的 Env 断言表明 key 不进容器。属平台级模型配置，不计违反。
  3. 假设「配置文案其实硬编码在 agent」→ 找到 `agent/message.ts:35`-`:72` 的三条模板。但追调用方：`http/webhook.ts:1579` 是唯一调用点，且 `webhook.ts:1250`-`:1272` 明确「注入 v21 时走独立分支，不共用这条组装链」，生产装配 `compose.ts:981` 始终注入 v21。故该硬编码不在生效链路上（对 P4-5 另有记账，见该条）。
  4. 假设「配置在容器里可读」→ `hostconfig.ts:123`-`:126` 的 `Binds` 只有 job 目录与只读缓存卷，无配置挂载；`exec-plan.ts:53`-`:54`、`exec-proxy.ts:21` 明确 `docker exec -e` 只带 `PI_CMD_ID`，`sandbox-exec-proxy.test.ts:297`-`:306` 断言请求里带 `env` 直接 `BAD_REQUEST` 且不发生 exec。
  5. 剩下的弱点：`eslint.config.js:86`-`:90` 的 runtime zone 只列了 `worker/http/queries/sandbox/git/github/queue`，**没有 `config`**。即「runtime 不读配置」今天靠约定成立，门禁不拦。

### P4-3
- **状态**：已实现
- **证据**：
  - `apps/server/src/sandbox/hostconfig.ts:165`-`:170` — 容器 Env 白名单：「不含任何凭证」四条字面量。
  - `apps/server/src/sandbox/exec-plan.ts:53`-`:54` — `docker exec -e` 只有 `PI_CMD_ID` 兜底标记，不透传客户端 env；`apps/server/src/sandbox/exec-proxy.ts:21` 同口径。
  - `apps/server/src/runtime/approval-policy.ts:246`-`:254` — `Bash` 命令命中 `findShellIssueViolation()` 即 `deny`（`gh issue` / `gh api` / 直打 `api.github.com`）。
  - `apps/server/src/runtime/approval-policy.ts:272` — issue 读工具「平台用自身 App 凭证代理，token 不进沙箱」。
  - 全仓 `api.github.com` 仅出现在判据与提示词文本（`packages/contract/src/issue-tools.ts:347`、`skills/prompt.ts:486`），**无任何裸 HTTP 调用**。
- **判定依据**：三件事同时成立才算「Agent 不直连 GitHub」：(1) 容器拿不到凭证——Env 白名单 + exec 不透传 + 无凭证挂载；(2) 执行侧没有直连代码路径——无 `api.github.com` 调用、无 octokit 引入（`runtime/issue-read-tools.ts:26` 只用 type-only `GithubIssueReadApi`，且该行带 `eslint-disable` 说明「runtime 目录的架构门禁禁止依赖 github/」）；(3) 模型想绕道 shell 会被拒——审批层判据。三条都有代码。
- **反证过程**：
  1. 假设「凭证能从父进程漏进容器」→ 查 `docker.ts:144`（create 用 `spec.Env`）、`:186`（exec 用 `request.env`），两者分别来自 `hostconfig.ts:165` 与 `exec-plan.ts:88`，都不含凭证；`sandbox-exec-proxy.test.ts:300` 用 `GITHUB_TOKEN: 'leak'` 反证请求被拒、`execCalls` 为 0。
  2. 假设「有隐藏的 GitHub 写路径」→ 搜全仓 `GITHUB_TOKEN|PRIVATE_KEY|api.github.com`：凭证字符串只出现在 `app/config.ts:73`-`:77`（env 键名）、`app/github-auth.ts`、`github/auth.ts`（宿主侧认证）；`runtime/`、`sandbox/`、`agent/` 内零命中。
  3. 假设「模型读 issue 就等于直连」→ 查需求侧：requirements 行 431 明确「平台补的两个只读工具」，行 1164 列出 `IssueLabelAdd` 等写工具但契约强制「有 `tool_calls` ⇒ 没有 `actions`」（`run-task.ts:820` 注释与 `:1037`-`:1048` 的分流），且 `run-task.ts:1067` 只接只读执行器。读经平台代理、写只走信封，属设计内。
  4. 逐条找漏洞：`hostconfig.ts:128` 的 `NetworkMode` 是 `pi-jobs` bridge，容器**能出公网**——无凭证情况下只可能做匿名读，写不了东西；审批层再挡 `gh`/`curl api.github.com`（只是正则，`approval-policy.ts:31`-`:32` 自述可被绕，但绕过去也没凭证）。
  5. 反证结论：唯一「凭证与本进程同行」的地方是 pi-host 子进程，见「发现的额外问题」第 4 条；它不进容器，不构成对本条的推翻。

### P4-4
- **状态**：部分实现
- **证据**：
  - 校验：`apps/server/src/worker/run-task.ts:1169`-`:1190` — v2 产出三态分流，`rejected` 时「整份拒绝，一条动作都不执行」；`:1191`-`:1211` — 旧 4-intent 信封走 `prepareEnvelope()`，不合规则只落 `envelopes(valid=false, errors)`。
  - 契约校验实现：`apps/server/src/worker/envelope.ts:194` — `validateEnvelope(parsed)` 不过即返回 `valid:false` + issues；`packages/envelope/src/v21.ts` 的 `strictObject` 系列（`:244` 起）实现「未知 type/多余字段整份拒绝」。
  - 执行：`apps/server/src/writeback/v21/execute.ts:181` — 三类受限动作开关在执行前整份裁决；`run-task.ts:1299`-`:1328` 只在 `v21Handled && v21Plan !== null` 时执行。
  - **反证命中点**：`apps/server/src/worker/run-task.ts:1243`-`:1291` — `!v21Handled && (!prepared.valid || !hasCommentAction)` 时用 `findLastAgentText()` 取模型最后一段人话，`postFallbackComment()` 直接发 GitHub 评论；`fallback.ts:250`-`:257` 只做长度截断与打标记，**没有任何契约校验**。
- **缺口**：子条件「产出只回到调度后**经契约校验才执行**」在兜底路径不成立——信封被判 `valid=false`（含 `missing-envelope`）时，模型原文仍会以评论形式写进 issue（`run-task.ts:1277` 的 `cause: 'invalid-envelope'` 即此分支）。这一点还与 requirements 行 1057「执行侧没有产出（…输出不合契约）时，标签与评论**保持原状**」直接相反；同时行 1054 又要求「失败不得静默，至少有兜底反馈（如普通评论）」，两条需求本身互斥，代码选择了 1054（并由 `worker-run-task.test.ts:568`、`:602` 钉住）。
- **判定依据**：「产出只回到调度」成立——模型没有任何直写 GitHub 的能力（无工具、无凭证，见 P4-3），所有写动作都在 `worker/` 里发起。但「执行前必过契约」被一条有意的兜底旁路破坏，故只能是部分实现，且必须点名该旁路。
- **反证过程**：
  1. 假设「模型能直接落地」→ 先找写面调用点：`createIssueComment/updateIssueComment/addLabels/removeLabel/createIssue/closeIssue` 只在 `worker/run-task.ts:358`-`:379` 与 `worker/writeback.ts` 被调用，都在 worker 内；`runtime/`、`sandbox/`、`agent/` 无 GitHub 写调用（`agent/ack.ts` 例外，见下条）。
  2. 假设「绕开校验」→ 追 `prepared.accepted` 的唯一消费者：`run-task.ts:1495` `executeActions()` 只吃过滤后的动作；v2 路径只吃 `probe.output`（已过 `parseOutputV21Json`）。主链路确实「不合规即零动作」，`apps/server/test/e2e-envelope-invalid.test.ts:141`-`:146` 断言 `actions` 0 行 + GitHub 非 GET 0 次。
  3. 假设「有第二个写面」→ 找到 `postFallbackComment`，并在 `fallback.ts:281` 确认它直接调 `api.createIssueComment`；再核触发条件是否可达：`run-task.ts:1253` 的白名单含 `agent:mention` / `agent:event`，而这两个正是 v2.1 入队时写的 `tasks.command`（`agent/store.ts:88`-`:90`、`:328`），**v2.1 链路同样可达**。反证成立。
  4. 假设「不一样的信封也算合规」→ `envelope.ts:156`-`:172` 证明 `text === null` 直接判 `missing-envelope`（不是「通过」），因此兜底分支的输入确实是「已被判不合规的产出」。
  5. 兜底是否仍受其它闸门约束：`run-task.ts:1249`-`:1259` 要求非 dry-run、未熔断、`turn.completed`、非空正文；`fallback.ts:31` 用 HTML 注释标记去重。这是「收窄的旁路」，不是「无约束直写」，但收窄不改变「未经契约校验」这一事实。

### P4-5
- **状态**：部分实现
- **证据**：
  - 配置面齐全：`packages/contract/src/settings-v21.ts:473` — `DEFAULT_EVENT_TEMPLATES`（五个事件的内置默认模板）；`:552` — `defaultEventTemplate()`；`:326`-`:344` — 事件开关/标签触发/评论闸门默认值；`:275` — 标签目录条目；`:561` — `DEFAULT_SYSTEM_PROMPT`。
  - 渲染在调度侧：`apps/server/src/http/webhook-v21.ts:354`-`:361` — `resolveEventTrigger(settings, event).prompt`，空则回落 `DEFAULT_EVENT_TEMPLATES[event]`；`:346` — `renderTemplateAsync()`；`apps/server/src/prompt/render.ts:492` — `renderTemplate`。
  - 装配不读配置：`apps/server/src/app/compose.ts:1403`-`:1407`；系统提示词走 system 通道，`run-task.ts:838`/`:916` 只转发字符串。
  - **反例**：`apps/server/src/agent/message.ts:35`-`:72` — 三条中文模板硬编码（`opened` / `edited` / `mention`），`agent/constants.ts:39` 的 `AGENT_TEMPLATE_IDS = ['opened','edited']` 为硬编码事件集；这些只在 `webhook.ts:1579` 的旧链路生效。
- **缺口**：v2.1 生效链路满足「改配置不动 agent」；但仓库仍在交付的 v0.3 链路（未注入 `deps.v21` 的装配，`webhook.ts:988`、`:1250` 有显式分支）把事件文案与技能指令写死在 `agent/` 里。在这条链路上改事件提示词文案，必须改 `agent/message.ts`——即「配置改动不需要动 agent」不是无条件成立。
- **判定依据**：「配置改动不需要动 agent」的可验证形式是：配置项（系统提示词/事件模板/闸门/限额/标签目录）到模型输入的路径上，不经过 `runtime/`、`sandbox/`，且文案不落在这两层。生产链路（`compose.ts:981` 注入 v21）满足；旧链路不满足且代码仍在、仍被单测调用，因此不是「已实现」。
- **反证过程**：
  1. 假设「改模板要改代码」→ 在 v2.1 上找不到反例：模板文本来自 `settings.triggers.events[key].prompt`（`settings-v21.ts:85`）+ 内置默认（`:473`），加事件只需扩配置 schema（契约层），`runtime/` 无改动。反例确实存在但只在旧链路。
  2. 假设「存在按事件类型/技能名硬编码的分支」→ 找 `decide.ts`：`decideEvent()`（`:209`）用 `resolveEventTrigger()` 按事件键查表，不是 `switch`；`webhook-v21.ts:394`-`:399` 的 `v21SkillIdsOf()` 只取模板首行 `/id`，技能 id 由项目配置决定，不硬编码名字；`worker/fallback.ts:47` 的 `COMMENT_FALLBACK_COMMANDS` 是命令白名单（属兜底策略，不是配置分支）。
  3. 顺带核「系统提示词改造要不要动 agent」：`resolveAgentExecution()`（`config/v21-settings.ts:200`-`:209`）中配置优先、空回落 `AGENT_IDENTITY_PROMPT`，改默认身份文案要改 `skills/prompt.ts`（提示词层，不是 `agent/`、`runtime/`）。符合需求「平台给一套内置默认值」（requirements 行 1921）。
  4. 反证结论：把「旧链路仍在交付」计入后判部分实现；若只认生产装配，本条可升为已实现。此处按仓库实际交付内容判定，不按理想接线判定。

## 本节整体结论
四块职责在代码结构上真实存在且方向基本受门禁约束，核心边界（Agent 不读配置、不持凭证、写动作只在平台侧）在生产链路上成立。两条判为部分实现：P4-4 因「信封不合规仍发兜底评论」这条有意旁路，与 FR-5.5 的「保持原状」相反；P4-5 因仍在交付的 v0.3 链路把事件文案硬编码在 `agent/message.ts`。因此本节不能整体判为「已实现」——按 callout「边界」的严格口径，需先处置兜底评论的需求归属，并明确旧链路是否还属交付面。

## 核查边界
- 是否执行了命令：未执行测试/构建，纯静态核查。只运行了仓库内只读检索（`git status --short`、`Select-String`、目录列举），未修改、未提交任何代码。
- 未覆盖的条目及原因：
  - 「容器内实际是否能联网写 GitHub」需真 Docker + 真凭证环境，未运行；只核了 `HostConfig.NetworkMode` 与 Env 白名单。
  - `pi-host` 自身的网络与工具行为属外部 bundle，仓库内不可读，按契约与接线推断。
  - lint 是否真的拦得住：只读了 `eslint.config.js` 的 zone 定义，未跑 `pnpm lint`。
- 发现的额外问题（不属本节范围但值得记录）：
  1. `apps/server/src/http/webhook-v21.ts:10` 头部声明「本模块**不碰** `trigger/**`、`prompt/**`、`config/**` 的实现」，但同文件 `:21`、`:23`、`:25` 直接 import `config/v21-settings.ts`、`trigger/decide.ts`、`prompt/render.ts`——注释与实现不符。
  2. `apps/server/src/config/v21-settings.ts:35` 让**配置层反向依赖**提示词层（`AGENT_IDENTITY_PROMPT`）。该方向不在任何 lint zone 覆盖范围内，属新增的层间耦合。
  3. `apps/server/src/config/repo-config.ts:23` 把通用 DB 端口类型 `SqlRunner` 定义在「配置」目录，导致 `agent/`、`queries/`、`db/` 等对 `config/` 产生类型级依赖（`agent/store.ts:17`、`agent/dispatcher.ts:35`、`agent/permission.ts:11`），模糊了「agent 不依赖 config」这条边界。
  4. `apps/server/src/runtime/host-supervisor.ts:487` 的 `baseEnv` 缺省为 `process.env`，而 `compose.ts:592`-`:601` 只传 `extraEnv: hostModelEnv(config)`、未传 `baseEnv`，于是 pi-host 子进程**继承整份服务进程环境**（含 `PI_BOT_GITHUB_TOKEN`，若运维用该变量认证）。与 `app/model-env.ts:8`-`:9`「只导出这一组变量（白名单），不把整个 `process.env` 灌给子进程」的声明相反。凭证未进容器，未违反 AGENTS.md §10，但与代码自述不符。
  5. `apps/server/src/worker/run-task.ts:1243`-`:1291` 的兜底评论与 requirements 行 1057 冲突（详见 P4-4），需求内部（行 1054 vs 1057）也互斥，建议在需求侧裁定后再统一实现与用例。
