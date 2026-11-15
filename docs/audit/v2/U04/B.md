# U04 3.2 场景 A · B

## 结论速览

| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| SA-1 | 已实现 | `issues.opened` 在事件白名单内且直达 v2 判定；前置拦截只有验签/去重/暂停/仓库未登记/安装不匹配/仓库配置非法，均属合理拦截，但「仓库配置非法整仓不触发」是新 issue 收不到任何处理的唯一常见静默路径。 |
| SA-2 | 已实现 | 开关来自项目配置 `triggers.events['issues.opened']`，默认 `on`（缺省即触发）；缺口仅在「`settings` 过不了严格校验时整仓被判 `repo-disabled`」，判定原因可查但事件不触发。 |
| SA-3 | 已实现 | 模板按「项目 + 事件」取（`resolveEventTrigger(settings, event).prompt`，空白回落该事件内置默认），占位符一次遍历渲染、未知原样保留并告警；无方案层面缺口。 |
| SA-4 | 已实现 | 消息以 `(repo, issue_number, fingerprint)` 落 `agent_messages`、任务按 issue 串行，会话复用 `agent_sessions` 的「一 issue 一行」；会话迁移失败只 warn（静默但可查日志，不阻断消息落库）。 |
| SA-5 | 已实现 | v2.1 路径里不存在「收到 opened 就发固定评论 / 打固定标签」的分支，动作全部来自模型产出的 v2 信封；遗留的 `needs-info` 硬编码只在 v0.3 流水线任务里，注入 v21 后不可达。 |
| SA-6 | 部分实现 | 评论槽位写回完全落地（覆盖/重建 + 槽位索引）；标签目标态的「当前态」取自 `bot_labels` 台账而非 GitHub 实时标签，人打的标签永不被删，且默认 `dry_run=true` 时一条都不真写。 |

## 逐条

### SA-1
- 状态：已实现
- 反证过程：
  1. 假设「`issues.opened` 不在白名单」→ 被推翻：`v21EventKeyOf()` 把 `issues/opened` 显式映射成 `issues.opened`（`webhook-v21.ts:93-98`）。
  2. 假设「会被旧 v0.3 白名单提前拦掉」→ 被推翻：v2 分支在旧 `decideWebhookTask()` 之前并直接使用 `v21Decision`，只有 `source='command'` 的旧命令通道会交回旧路径（`webhook.ts:1255-1287`、`webhook-v21.ts:984-986`）。注释明确说明旧白名单只放行 opened/edited+提及，所以 v2 必须独立（`webhook-v21.ts:979-981`）。
  3. 假设「被签名/去重/暂停拦掉」→ 这些都在判定之前且按设计属合理拦截：验签失败 401（`webhook.ts:1064-1097`）、投递级幂等直接回 200 `duplicate`（`webhook.ts:1099-1122`）、暂停只记投递不入队（`webhook.ts:1142-1153`）、未知仓库忽略（`webhook.ts:1172-1175`）。
  4. 假设「仓库未配置就静默丢弃」→ 部分成立：`repoDisabled: !policy.enabled || !policy.settingsValid`（`webhook.ts:1200`），而 `settingsValid` 依赖严格 schema（`managers` 非空 + 词表 requirement/defect 各一）（`config/repo-config.ts:262-264`、`contract/src/repo-config.ts:270-339`）。这条是「配置坏了不许拿默认值开工」的有意设计，但确实会让新 issue 无任何反应。
  5. 单测证据：`trigger-decide.test.ts:47`（`issues.opened` 默认触发）与 `v21-webhook-integration.test.ts:276`（开关关闭只留痕）。
- 证据：`apps/server/src/http/webhook-v21.ts:85-108` — 事件键映射含 `issues.opened`；`apps/server/src/http/webhook.ts:1192-1223` — 注入 v21 后在仓库可用性之后立刻做 v2 判定并落会话；`apps/server/src/http/webhook-v21.ts:983-994` — 触发即继续、未触发只留痕。
- 缺口：无代码级断点；风险点是「严格配置校验」把未配置/旧配置仓库整体挡在 `repo-disabled`（原因可见于 `webhook_deliveries.decision_reason`，但事件不会触发）。
- 判定依据：事件键映射 + 分支位置 + 前置拦截逐条排除，且单测覆盖默认触发与开关关闭两种情况。

### SA-2
- 状态：已实现
- 反证过程：
  1. 假设「开关默认不触发」→ 被推翻：契约里 `issues.opened` 预置 `{ enabled: 'on' }`（`packages/contract/src/settings-v21.ts:326-334`），`eventTriggerSchema.enabled` 默认 `'on'`（`settings-v21.ts:81-91`）。
  2. 假设「缺字段时静默不触发」→ 被推翻：`readV21Settings()` 用形状层解析，缺失键走默认（`config/v21-settings.ts:70-77`），`decideEvent()` 取 `resolveEventTrigger(...).enabled` 只在 `off` 时跳过（`trigger/decide.ts:225-229`）。
  3. 假设「开关是三态时 opened 会卡在 conditional」→ 被推翻：`issues.opened` 无附加条件（`checkEventCondition()` 只处理 edited / labeled，`trigger/decide.ts:141-164`），因此即使配成 `conditional` 也直接 `conditional-met`（`trigger/decide.ts:260-265`）。
  4. 假设「配置读取的是别处（如快照/缓存）」→ 被推翻：判定与渲染都读同一次 `policy.settings`（`webhook.ts:1199`），热路径复用 `decision.template` 不再二次解析（`webhook-v21.ts:445-464`）。
  5. 单测证据：`trigger-decide.test.ts:47,102,444,457`。
- 证据：`packages/contract/src/settings-v21.ts:328` — `'issues.opened': eventTriggerSchema.prefault({ enabled: 'on' })`；`apps/server/src/config/v21-settings.ts:105-116` — 按事件取 `enabled/prompt`；`apps/server/src/trigger/decide.ts:225-229` — `off` 才跳过。
- 缺口：项目必须处于「配置合法 + `repos.enabled=true`」状态；`repos.enabled=false`（安装事件默认写入 `enabled:false`）或配置不合法的仓库，opened 一律 `repo-disabled` 不触发（`webhook.ts:900-907`、`webhook.ts:1225-1231`）。这是前置条件而非开关本身缺失。
- 判定依据：默认值在契约里唯一一份，缺省不触发的情况被形状层默认值排除，测试直接断言默认触发。

### SA-3
- 状态：已实现
- 反证过程：
  1. 假设「模板不按事件取」→ 被推翻：`resolveEventTrigger(settings, event).prompt`（`config/v21-settings.ts:105-116`），event 来自判定结果 `decision.event`（`webhook-v21.ts:996,1009,1017`）。
  2. 假设「空模板会发空指令」→ 被推翻：两处都把空白串收敛到该事件内置默认（`trigger/decide.ts:255-258`、`webhook-v21.ts:359-362`），内置默认在契约里按事件一份（`settings-v21.ts:473-480`）。
  3. 假设「渲染走另一套私有实现」→ 被推翻：项目模板与内置默认都进同一个 `renderTemplateAsync()`（`webhook-v21.ts:474-476`、`prompt/render.ts:193-204`），一次 `replace` 保证替换值不被二次扫描（`render.ts:170-185`）。
  4. 假设「渲染失败会炸或静默丢数据」→ 被推翻：唯一异步源（`{{repo.issues}}`）失败时回落同步渲染并把占位符原样保留 + warn（`webhook-v21.ts:477-493`）；未知占位符收集进 `unknown`、原样保留并落结构化告警（`render.ts:173-183`、`webhook-v21.ts:495-504`）。
  5. 假设「渲染结果没真正交给会话」→ 被推翻：渲染正文写进 `agent_messages.comment_body`（`webhook-v21.ts:1029-1037`），运行时作为「## 这一条消息」拼进提示词（`app/compose.ts:1236-1252`）。
  6. 单测证据：`v21-webhook-integration.test.ts:363,390,406,435,466,504`。
- 证据：`apps/server/src/http/webhook-v21.ts:450-516` — 一个入口完成「取模板 → 渲染 → 未知告警 → 技能首行」；`apps/server/src/prompt/render.ts:89-95,132-185` — 12 个占位符与字面替换；`packages/contract/src/settings-v21.ts:420-446` — 占位符清单唯一一份。
- 缺口：无功能性缺口。可注意的语义点：渲染是字面替换，`{{comment.*}}` 在非评论事件渲染成空串（`render.ts:126-162` 注释与实现），模板作者若依赖它做条件会出现空段。
- 判定依据：模板选择、空值回落、渲染实现、失败降级、落库与提示词装配五段均有代码与单测对应。

### SA-4
- 状态：已实现
- 反证过程：
  1. 假设「消息落到别的桶里」→ 被推翻：消息键是 `(repo, issue_number, fingerprint)`，主键即此三元组（`agent/store.ts:95-98,212-238`）。
  2. 假设「同一 issue 会并发开新会话」→ 被推翻：`agent_messages` 取件用 `FOR UPDATE SKIP LOCKED` 且 `NOT EXISTS(running)` 保证同 issue 串行（`agent/store.ts:106-139`、`agent/dispatcher.ts:161-184`）。
  3. 假设「首次创建与复用语义缺失」→ 被推翻：`planSessionOnEvent()` 显式区分 create / reuse / recycle-sandbox（`agent/session-state.ts:108-164`），opened 已有会话时按「重开复用 + 重建沙箱」处理（`session-state.ts:133-142`），并只 INSERT/UPDATE 从不 DELETE（`webhook-v21.ts:786-802`）。
  4. 假设「会话 id 不复用（每条消息都新建会话）」→ 被推翻：`loadSession()` → `planAgentSession()` → `persistAgentSessionAfterRun()`（`app/compose.ts:1157-1177,1228-1233,1440-1452`），无 id 时 `{mode:'persistent'}` 由 `driveTurn` 建一次并回写。
  5. 假设「创建失败静默」→ 部分成立：会话状态迁移异常只 `log.warn`（`webhook.ts:1218-1221`），但消息已经落库、下一轮事件会再修，且真正建会话在 worker 内，失败会进 `run_events`/任务终态。
- 证据：`apps/server/src/http/webhook.ts:1203-1222` — 事件即迁移会话，失败只 warn；`apps/server/src/agent/store.ts:55-57,305-339` — 消息 → 任务幂等键绑定 `repo#issue`；`apps/server/src/agent/session-state.ts:133-142` — 重开复用同一会话。
- 缺口：会话状态迁移失败时没有任何重试机制，仅依赖后续事件或 worker 的 `persistent` 计划自愈（`session-state.ts` 无补偿路径）；这是「可观测但非自动修复」。
- 判定依据：消息键、串行闸、会话行唯一性与复用路径四处齐备，且状态迁移有测试（`v21-worker-integration.test.ts:632,728`）。

### SA-5
- 状态：已实现
- 反证过程：
  1. 假设「按事件类型 switch 硬编码动作」→ 被推翻：全文搜索 `issues.opened` / `action === 'opened'` 命中仅事件键映射、会话迁移、以及 v0.3 的模板 id 选择（`webhook-v21.ts:96`、`agent/session-state.ts:31,134`、`webhook.ts:640`、`app/compose.ts:256`），没有一处产出评论/标签。
  2. 假设「有内置技能与事件的绑定表」→ 被推翻：v2.1 的技能来自渲染正文首行的技能词（`webhook-v21.ts:394-399,514`），旧路径的 `agent.on_opened/on_edited` 仅影响技能 id 选择且契约已标 deprecated「新路径不读」（`contract/src/repo-config.ts:153-172`、`agent/message.ts:162-164`）。
  3. 假设「有 opened 专属固定评论文本」→ 被推翻：唯一带「一条评论 + 一个标签」字样的是内置默认**模板文本**（`settings-v21.ts:474-480`），它是发给模型的指令，不是平台执行的动作。
  4. 假设「平台仍自动做某个写动作」→ 部分成立且已知：触发后会自动打 `eyes` 回执（`webhook-v21.ts:1056-1067`、`agent/ack.ts:47-66`），属回执而非评论/标签，dry-run 下也不写。
  5. 假设「遗留硬编码 `needs-info` 会影响 opened」→ 被推翻：`NEEDS_INFO_KEY` 在 `worker/writeback.ts:93-97,220`、`workflows/labels.ts`，只由 v0.3 流水线任务（`source='pipeline'`）的 4-intent 信封写回触发（`worker/run-task.ts:1488-1505`）；注入 v21 后 5 类事件在 `handleV21Webhook()` 内就被接管，旧管线不会为 opened 建流水线任务（`webhook-v21.ts:983-994` 恒返回非 null）。
- 证据：`apps/server/src/writeback/v21/execute.ts:465-492` — 动作类型表来自产出 payload，与事件无关；`apps/server/src/http/webhook-v21.ts:1006-1037` — 触发后只做「渲染 → 落消息 → 投递」；`apps/server/src/worker/run-task.ts:1168-1190` — 只有合规 v2 产出才进 `executeV21()`。
- 缺口：`workflows/labels.ts` / `worker/writeback.ts` 的 `needs-info` 硬编码仍留在仓库里（旧路径），若哪天有装配再次走 v0.3 流水线，它会重新生效；当前生产装配（`app/compose.ts:981` 注入 v21）下不可达。
- 判定依据：事件到动作的路径上没有任何「事件类型 → 固定评论/标签」的映射，动作来源唯一是 v2 信封；遗留代码已定位且在当前装配下不可达。

### SA-6
- 状态：部分实现
- 反证过程：
  1. 假设「评论直接新建、不按槽位覆盖」→ 被推翻：槽位标记 + 先查索引、再列评论按标记找，命中就 `updateIssueComment`，被删（404）才重建（`writeback/v21/execute.ts:589-684`、`comments.ts` 的 `buildSlotMarker/findSlotComment/planSlotWrite`）。
  2. 假设「标签是增量追加、没有目标态」→ 被推翻：`planLabelTargetState()` 用「完整期望集合」算 add/remove，空集保护、超限整批拒绝、目录外拒绝（`writeback/v21/labels.ts:135-200`），执行时先加后删（`execute.ts:545-558`）。
  3. 假设「动作没真到 GitHub」→ 被推翻：执行器端口由 `v21WritePort()` 接到既有 GitHub 写面，并在打/删标签时同步 `bot_labels` 台账（`worker/run-task.ts:354-381,1337-1343`），装配层注入的是同一份写面（`app/compose.ts:836-844`）。
  4. 假设「失败不可见」→ 被推翻：整份拒绝与中途失败都写 `envelopes.errors`、`run_events.writeback.v21.result`、以及失败信号（`run-task.ts:1406-1477`），`actions` 行按 `failed/applied/dry-run` 落库（`run-task.ts:1424-1448`）。
  5. 假设「目标态的当前态来自 GitHub 实时标签」→ **被推翻**：装配层注入的 `currentLabels` 与 `botLabels` 都来自 `bot_labels` 台账（`app/compose.ts:857-864`），注释也写明「读失败退化为空集，只会只加不删」；`plan.remove = current(台账) ∩ 可管理目录 − desired`（`labels.ts:178-197`），因此人打的标签、或台账缺失的历史标签永远不会被目标态删除。
  6. 假设「开了就会真写」→ 被推翻：`dryRun = policy.dryRun || forcedDryRun`（`webhook.ts:1241`），默认 `dry_run: true`（`contract/src/repo-config.ts:218`），dry-run 下执行器只给计划、一条写方法都不调（`execute.ts:538-540,645-649`）。
- 证据：`apps/server/src/writeback/v21/execute.ts:519-559` — `label` 目标态落 `addLabels/removeLabel`；`execute.ts:651-683` — 评论槽位覆盖/重建落 `updateIssueComment/createIssueComment`；`apps/server/src/app/compose.ts:857-864` — 当前标签来源是 `bot_labels` 台账；`apps/server/src/worker/run-task.ts:1300-1309` — 直连路径同样只用 `deps.targets.load()` 给的两个集合。
- 缺口：标签的「目标态」只在 `bot_labels` 台账范围内成立（删除侧不完整，缺少 GitHub 实时当前标签这一数据源）；默认 `dry_run=true` 时评论与标签都只留在 `actions`（dry-run）与 `run_events`，不会真的出现在 GitHub 上。评论侧无缺口。
- 判定依据：评论槽位与标签增删的执行链路完整并有单测；但「当前态」数据源与默认 dry-run 使「标签目标态真正落到 GitHub」只部分成立。

## 本节整体结论

场景 A 的端到端链路在代码上是成立的：`issues.opened` 进入判定（默认 `on`）→ 按事件取项目/内置模板并渲染 → 渲染正文写入该 issue 的 `agent_messages` → dispatcher 按 issue 串行建任务并投递 → worker 复用/创建该 issue 的会话 → 模型产出 v2 信封后由 `executeV21()` 落地评论槽位与标签对齐，平台自身不预设任何评论或标签。

成立的前提条件需要显式承认（否则「新 issue 进来无反应」会被误判为链路断裂）：
1. 该仓库 `repos.enabled=true` 且 `settings_valid=true`，即 `agent.managers` 非空、标签词表含 `requirement`/`defect`（`contract/src/repo-config.ts:270-339`、`config/repo-config.ts:262-264`）；安装事件写入的行默认 `enabled:false`。
2. `dry_run=false`，否则动作只进审计、不出现在 GitHub 上（`webhook.ts:1241`）。
3. 标签的「目标态」目前只在 `bot_labels` 台账范围内成立（`app/compose.ts:857-864`），这是本节唯一实质性的语义折损。

## 核查边界

- 是否执行了命令：未运行 `typecheck` / `lint` / `test`，也未连真实 PostgreSQL 或 GitHub。仅在该仓库执行只读检索命令（`git status --short`、`Get-ChildItem`、`Select-String`、`Test-Path`）以定位文件与行号。所有结论来自静态阅读，测试文件仅用于交叉验证「该行为有单测断言」，未实际运行。
- 未覆盖的条目及原因：
  - 真实 GitHub 端到端（收到 webhook → 评论/标签真的出现在 issue 上）没有可执行验证：仓库内无真 App + 真 issue 的集成测试，本核查也没有凭据环境，只能确认执行器端口到写面的接线。
  - `v21-webhook-integration.test.ts` 等用的是内存假件，无法证明「槽位索引在真库上的覆盖语义」（`slotStore` 在生产装配里没有注入，走的是「列评论按标记找」的退化路径，见 `writeback/v21/execute.ts:627-636`）。
  - 未核查面板侧对 `triggers.events['issues.opened'].prompt` 的写入与校验（超出本次范围：只核 3.2 场景 A 的运行链路）。
  - 未核查 `dry_run` 的开启流程与运维期望是否一致（属部署/面板配置范围）。
