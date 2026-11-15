# U07 4.1 平台内部四个部件与边界 · A

> 核查范围：docs/requirements.html 行 638-718
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| P4-1 | 已实现 | — |
| P4-2 | 已实现 | — |
| P4-3 | 部分实现 | 容器内确无凭证，但 agent 宿主进程（pi-host）继承整份 `process.env`，静态 token / App 私钥路径都在里面；容器另有公网出口，匿名读 GitHub 无法从架构上禁掉 |
| P4-4 | 已实现 | — |
| P4-5 | 已实现 | — |

## 逐条

### P4-1
- **状态**：已实现
- **证据**：
  - 配置：`apps/server/src/config/v21-settings.ts:6` — 只做「`repos.settings`（jsonb）→ 判定/执行侧真值」的纯函数解析，不查库；`apps/server/src/config/repo-config.ts:165` — `repos` 行的 `settings / settings_valid / settings_error` 读写 SQL。五项都在 v2.1 段解析里各有落点：系统提示词 `config/v21-settings.ts:209`（`system_prompt`）、事件模板与评论闸门 `trigger/decide.ts:209`（`decideEvent`）、并发限额 `queue/repo-concurrency.ts:25` + `queue/queue-gate.ts:34`（读 `settings.limits.*`）、标签目录 `resolveManagedCatalog`（`config/index.ts` 导出，`worker/run-task.ts:391` 消费）。
  - 调度：验签去重 `http/webhook.ts:1068`（缺 `X-Hub-Signature-256` 直接 401）+ `http/webhook.ts:1100`（`webhook_deliveries` 主幂等点）；触发判定 `trigger/decide.ts:209`；会话映射 `agent/store.ts:153`（读 `agent_sessions`）+ `agent/store.ts:156`（`saveSession`）；事件排队 `queue/definitions.ts:19`（`run-task`）/ `:35`（`agent-dispatch`）；模板渲染 `agent/message.ts:35`（`AGENT_MESSAGE_TEMPLATES`）+ `:229`（`renderTemplate`）。
  - Agent：会话与轮次 `runtime/turn-driver.ts:6`（`session/create` → turn）；上下文组装 `app/worker-deps.ts:305`（`buildTaskPrompt`）+ `skills/prompt.ts:75`（`AGENT_IDENTITY_PROMPT`）；工具与沙箱 `sandbox/exec-proxy.ts:6`（shim → exec-client → 代理 → `docker exec`）；模型调用 `app/model-env.ts:36`（`hostModelEnv`，pi-host 自己按 OpenAI 兼容协议发请求）；产出 `worker/envelope.ts:10`（信封校验）。
  - 记录：`db/schema.ts:297`（`run_events`）/`:453`（`usage_costs`）/`:659`（`agent_sessions`）/`:707`（`agent_messages`）；写入 `worker/run-store.ts:42`（`insert into run_events`）/`:91`（`insert into usage_costs`）；后台查询 `apps/server/src/http/api/index.ts:120`（`/api/tasks/:id`）/`:137`（`/api/costs`）/`:157`（`/api/audit`）。
- **判定依据**：四块各自有独立目录/文件边界，且每块的两个以上子项都能追到「被谁调用」的执行路径（不是只存在表或函数）。
- **说明**：目录名 `agent/` 对应的是**调度块**（dispatcher / store / message 构造），真正的「Agent」块是 `runtime/` + `sandbox/` + 提示词装配；按目录名直读会错位，按职责读则与需求四块一一对应。

### P4-2
- **状态**：已实现
- **证据**：
  - `apps/server/src/runtime/*.ts` 与 `apps/server/src/sandbox/*.ts` 全部 import 中**没有** `../config/*`（逐文件检索：runtime 只 import `deps.ts / pin.ts / crypto.ts / host-supervisor.ts / approval-policy.ts / turn-driver.ts / issue-*-tools.ts`；sandbox 只 import 本目录 + `dockerode` + `node:*`）。
  - `apps/server/src/agent/*.ts` 对 config 的全部依赖是 `import type { SqlRunner } from '../config/repo-config.ts'`（`agent/store.ts:17`、`agent/permission.ts:11`、`agent/dispatcher.ts:35`），只要一个 `query()` 形状，不读 `repos` 行。
  - 配置读取点集中在平台侧：`apps/server/src/worker/run-task.ts:1313`（`deps.v21.settings` → `readV21Settings`）`:1316`（`resolveAgentExecution`）`:1329`（标签目录），`apps/server/src/app/compose.ts:1407`（`resolveAgentExecution(policy.settings).system_prompt` 注入 worker），`apps/server/src/http/webhook.ts:1550`（`isManager({ agent: { managers: input.settings?.managers ?? [] } }, ...)`，settings 由 webhook 读取后作参数传入）。
  - 需要配置的 agent 侧纯函数一律「吃已解析值」：`agent/permission.ts:51`（`isManager(settings: AgentManagerSettings, login)`）、`agent/message.ts:163`（`eventSkillsOf(settings, templateId)`）、`app/worker-deps.ts:288`（`settings?: RepoSettings | null`）。
- **判定依据**：断言是「agent/执行侧不直读配置」。执行侧（runtime/sandbox）连 config 目录都没有 import；调度侧（agent/ 的 store/message/permission）只接受调用方传进来的已解析结构。注释不作为依据，按的是 import 图与实际调用点。

### P4-3
- **状态**：部分实现
- **证据**：
  - 容器侧无凭证：`apps/server/src/sandbox/hostconfig.ts:165` — `Env` 是硬编码四条（`NODE_OPTIONS / HOME / CI / TERM`），注释明写「不含任何凭证」；`:123` — `Binds` 只有 job 目录与只读 `/cache`；`:103`/`:107`/`:109` — 只读根、`CapDrop: ALL`、`no-new-privileges`。
  - issue 操作走平台代理：`apps/server/src/runtime/issue-read-tools.ts:26` — 只 `import type { GithubIssueReadApi }`（编译期擦除，无运行时 github 依赖）；执行器由装配层造：`apps/server/src/app/compose.ts:1417` — `createIssueReadExecutor(v21IssueRead, {}, { repo })`，`v21IssueRead` 来自 `createGithubIssueReadApi(baseGithubClient)`（`compose.ts:811`）。写面同理只在平台侧：`compose.ts:753`—`:761`、`:887`—`:889`。
  - 模型 key 只在可信侧、白名单口径见 `apps/server/src/app/model-env.ts:8`—`:9`、`:36`—`:52`（只输出 `PI_BOT_MODEL_*` / `OPENAI_*`）。
  - **缺口一（agent 宿主进程）**：`apps/server/src/runtime/host-supervisor.ts:487`—`:492` — 子进程环境 = `baseEnv ?? process.env` **整份拷贝**，只在其上 `Object.assign(extraEnv)`（`:493`）；`apps/server/src/app/compose.ts:592`—`:602` 构造 `HostSupervisor` 时没传 `baseEnv`，于是走默认。`PI_BOT_GITHUB_TOKEN`（`app/config.ts:73`，赋值见 `:404`）与 `PI_BOT_GITHUB_APP_PRIVATE_KEY_PATH`（`app/config.ts:77`）因此随 `serve` 进程一起进到 pi-host 的环境里，与 `model-env.ts:8` 宣称的「只给它需要的白名单」不一致。
  - **缺口二（网络）**：`apps/server/src/sandbox/hostconfig.ts:31`—`:32`（`pi-jobs` 是**非** `internal` 的 bridge，注释写明「所以能出公网」）与 `:128`（`NetworkMode` 落进 HostConfig）——容器内可匿名访问 github.com，「不直连」只能靠「没有凭证 → 写不了」这一层。
- **缺口**：需求子条件「执行环境内没有 GitHub 凭证」对 agent **宿主进程**不成立：token（静态模式）与 App 私钥路径都在 pi-host 的 env 里，`bash` 一旦不指向 shim 就是同用户可读。容器内的无凭证与 issue 操作走代理这两条成立。
- **判定依据**：子条件需同时成立才能判「已实现」；容器成立、宿主进程不成立，故为部分实现。token 的实际可达性取决于部署形态（App 认证下 env 里只有私钥**路径**，但这仍是可读凭证）。

### P4-4
- **状态**：已实现
- **证据**：
  - `apps/server/src/worker/run-task.ts:1153` — 第 7 步 `validate`；`:1169`—`:1190` — v2 信封三态：`valid` 才进第 8 步，`rejected` **整份拒绝、一条动作都不执行**并落 `envelopes.valid=false` + `run_events`；`:1193`—`:1211` — 旧信封走 `prepareEnvelope()` + `recordEnvelope(valid, errors)`（`worker/envelope.ts:10` 明写「不合规也入库」）。
  - 执行只在平台侧：`apps/server/src/writeback/v21/execute.ts:6`—`:14`（顺序执行、遇失败即停 / 后三类动作执行前整份拒绝 / dry-run 只算不写）、`:16`（本文件不 import `github/*`，只认注入的 `V21GithubPort`）；调用点 `worker/run-task.ts:1345`—`:1374`（`degeneracyHit` 命中则零写动作，`:1349`）。
  - 推送闸门：`apps/server/src/git/writeback.ts:27` — 推送前 `evaluateWriteback()`（`git/writeback-gate.ts`）。
- **判定依据**：agent 的产出只有两条出口——事件流里的信封文本与工作区文件；前者必须过 zod/Ajv 校验才可能变成 GitHub 写动作，后者要过 `declared ∩ actual` 闸门才能推送。执行主体是 worker/writeback，不是 agent 侧代码。

### P4-5
- **状态**：已实现
- **证据**：
  - 配置到行为的链路全在平台侧：事件触发/闸门 `trigger/decide.ts:209`（吃 `repos.settings`，见 `:104`）；并发限额 `queue/repo-concurrency.ts:25` + `queue/queue-gate.ts:34`；系统提示词 `app/compose.ts:1407` → `worker/run-task.ts:838` → `:916`（`systemPrompt` 只随 `session/create` 传给 turn-driver，见 `runtime/turn-driver.ts:383`—`:386`）；标签词表 `app/worker-deps.ts:307`—`:308`（按 `settings.labels.vocabulary` 渲染进任务提示词）；动作开关 `worker/run-task.ts:1328`。
  - agent 侧不参与解析：`config/v21-settings.ts:6` 的「纯函数、不查库」契约 + 上面 P4-2 的 import 图；提示词到 agent 手里已是字符串（`worker-deps.ts:305` 返回 `string`）。
- **判定依据**：改一处配置（`repos.settings`）后，重新读配置的是 webhook / trigger / worker / compose 这条链，agent 侧（runtime 会话与 turn、sandbox 命令、pi-host）拿到的是渲染结果，没有需要同步改动的解析代码路径。

## 本节整体结论
四块在代码结构上可辨认，且「Agent 不直读配置」「输出只回调度、校验后执行」「配置改动不需要动 agent」三条边界都能追到执行路径，可以判为已实现。唯一不成立的是 callout 后半句里「执行环境内没有 GitHub 凭证」在 agent 宿主进程这一层：pi-host 继承整份 `process.env`，token / 私钥路径随进程进去，与 `model-env.ts` 自称的白名单不符；容器侧确实无凭证，issue 操作也确实走平台注入端口。因此本节整体按「主体已实现、P4-3 一处子条件缺失」记。

## 核查边界
- 是否执行了命令：未跑构建/测试，纯静态核查。执行过的只有只读检索命令：`git status --short`、`git log --oneline -1`（工作区与 `_baseline.txt` 列出的 27 个 M + `?? docs/audit/` 一致，结论对应基线），以及对 `apps/server/src` 的 `Get-ChildItem` / `Select-String` import 图与关键字检索。
- 未覆盖的条目及原因：pi-host 是 vendored bundle（`vendor/pi-host`，不在本仓库），无法静态确认它自身工具面（是否有内建 http/git 工具、`PI_DESKTOP_BASH` 缺省时 bash 落在哪）——这部分只能靠运行时验证。
- 发现的额外问题（不属本节范围但值得记录）：
  1. `apps/server/src/app/compose.ts:592`—`:602` 构造 `HostSupervisor` 时既没传 `baseEnv` 也没传 `sandboxBashPath`；`PI_DESKTOP_BASH` 只可能从父进程环境透传。而 `apps/server/src/doctor/checks/shell.ts:6` 明写「shim 不可执行 = 命令落回宿主」。生产装配下 shim 是否真的接上取决于部署环境变量，代码里没有兜底或断言。
  2. `apps/server/src/git/repo-cache.ts:151` 用带 token 的 remote URL（`app/compose.ts:628` 的 `https://x-access-token:${token}@github.com/...`）clone，clone 后没有 `git remote set-url` 抹除。该 URL 落在 `cacheRoot` 的 `.git/config`；worktree 的 `.git` 文件指向宿主上的该路径，容器里不可达（只挂 job 目录），所以当前不构成容器内泄露，但缓存目录本身的权限就是唯一防线。
  3. `apps/server/src/worker/run-task.ts:975` 有意不落 `item.delta`（流式增量），「对话全文」以 `item.completed` 的整条内容为口径；面板详情页 500 条上限会挤掉早期事件，与需求「对话全文可查」的口径差异值得另条核。
