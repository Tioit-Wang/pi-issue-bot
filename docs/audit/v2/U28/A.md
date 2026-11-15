# U28 11 决策记录 Q-1 ~ Q-9 · A

> 核查范围：docs/requirements.html 行 1886-1948
> 代码基线：见 docs/audit/v2/_baseline.txt（HEAD fbfa029，工作区与基线一致）

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| Q-1 占位符清单全正式 | 已实现 | — |
| Q-2 未知占位符原样保留 + 配置告警 | 已实现 | — |
| Q-3 会话无结束状态 / 关闭只回收沙箱 | 已实现 | — |
| Q-4 上下文自动压缩（三处取舍） | 部分实现 | 压缩引擎零生产调用点，缺「自动」这一环 |
| Q-5 事件进不进会话由项目配置说了算 | 已实现 | — |
| Q-6 一个事件一个提示词 / 平台不维护技能注册表 | 与需求冲突 | 平台确有技能注册表（registry + 内置技能 + 逐项目播种 + /api/skills 全套 CRUD） |
| Q-7 面板只留三个项目页 | 与需求冲突 | 五个全局页与五项项目导航仍在，系统页仍是独立页面 |
| Q-8 Issue 页做成会话流 | 部分实现 | 缺原文折叠卡、系统提示词折叠段、平台写回居中行、verdict/actions 折叠 |
| Q-9 面板内发消息本版不做 | 部分实现 | 发送能力确实没有，但「输入区形态 + 禁用态发送按钮」也不存在 |

## 逐条
### Q-1
- **状态**：已实现
- **证据**：`packages/contract/src/settings-v21.ts:420` — `PROMPT_PLACEHOLDERS` 共 12 条，字段只有 `name` / `description`，**没有 `pending` / `tentative` 之类的待定标记**；`:446` 导出 `PLACEHOLDER_NAMES`（12 个字面量）；`apps/server/src/prompt/render.ts:132` — `resolvePlaceholder()` 的 switch 覆盖全部 12 个名字 + `default: return null`（无第二套待定分支）；`apps/server/src/prompt/render.ts:25` 再导出同一份清单（注释明确「不再另抄一份」）；面板 `apps/panel/src/components/settings/v21-events-section.tsx:637` 把 `PROMPT_PLACEHOLDERS` 直接当插入按钮清单；`apps/server/test/prompt-render.test.ts:42` 断言 `PLACEHOLDER_NAMES` 长度为 12，`:47` 逐个渲染并断言 `unknown` 为空。
- **缺口**：（无）
- **判定依据**：需求「现有占位符全部列为正式，不再区分待定」的判据是「清单里每一项都能渲染，且不存在待定标记」。清单与渲染实现一一对应，面板与服务端共用同一份来源，且无任何代码区分待定；12 个占位符逐个可渲染由单测钉住（测试存在且断言具体，未执行）。

### Q-2
- **状态**：已实现
- **证据**：`apps/server/src/prompt/render.ts:175` — 解析不到的值走 `return match`（把命中的原文原样吐回），并把名字收进 `unknown`（`:176`-`:179`），**不替换成空串**；`apps/server/src/http/webhook-v21.ts:495` — `rendered.unknown.length > 0` 时构造 `V21UnknownPlaceholderWarning` 并调用 `reportV21UnknownPlaceholders()`；`:376` — 落一条结构化 `logger.warn`，字段含 `unknown` / `event` / `repo` / `deliveryId`，文案「v2.1 模板含未知占位符：已原样保留（请检查项目事件模板配置）」；`:503` 额外回调 `deps.onUnknownPlaceholders?.()`；`apps/server/test/prompt-render.test.ts:101` 断言 `unknown` 为 `['issue.foo','issue.bar']`（原样保留）。
- **缺口**：（无）。备注：`deps.onUnknownPlaceholders` 仅测试注入（`apps/server/test/v21-webhook-integration.test.ts:218`），生产未接线，告警出口目前只有日志。
- **判定依据**：需求的两个子条件——「原样保留不替换」在渲染器实现级成立，「记一条配置告警」有生产消费方（`buildV21AgentMessage` 内调用，`webhook-v21.ts:450` 是该模块唯一入口），告警带仓库/事件/投递 id 可定位。

### Q-3
- **状态**：已实现
- **证据**：`apps/server/src/agent/session-state.ts:19` — `SESSION_STATES = ['active','idle']`（无 `closed` / `archived` / `ended`）；`:69` — `SESSION_ACTIONS = ['create','reuse','recycle-sandbox']`，类型层面就不存在 archive / delete；`:123`-`:130` — `issues.closed` 且实时状态确为 closed → `recycle-sandbox`，`state:'idle'`、`keepSession:true`、`rebuildSandbox:false`；`:134`-`:141` — 重开 → `reuse` + 重建沙箱（会话沿用）；`apps/server/src/app/compose.ts:287` — recycle 语句只 `UPDATE state/sandbox_id/closed_at`，全表三条语句无 `DELETE`；`apps/server/src/http/webhook.ts:1210` — 生产路径用真实 `X-GitHub-Event` + `issue.state` 调 `applyV21SessionOnEvent`（实现见 `http/webhook-v21.ts:829`，`:849` 关闭走 recycle，`:851` 其余走 reuse）。
- **缺口**：（无）
- **判定依据**：四个子条件（无结束状态 / 关闭只回收沙箱 / 会话与记录保留 / 重开直接复用）都能落到「存在且有调用方」的路径：状态集合与动作集合是闭集，落库语句只有 INSERT/UPDATE，权威写入点在 webhook 且有真实调用链。

### Q-4
- **状态**：部分实现
- **证据**：`apps/server/src/compact/thresholds.ts:97` — `hardLimit = max(窗口 − 预留, 1)`、`:98` — `autoLimit = 0.9 × hardLimit`，两个阈值全部由 `windowTokens` 现算，`COMPACTION_DEFAULTS` 里没有任何可配置阈值（`packages/contract` 全仓无 compaction 配置字段）；`apps/server/src/compact/engine.ts:212` — `selectRecentWindow()` 从尾部按 token 预算切「真实最近窗口」，`:238` 把切点前移到非 tool 消息，`:480` 只对窗口内孤儿 toolResult 做剔除 → **保留的是含 assistant 与 toolResult 的窗口，不是只留用户消息**；`apps/server/src/compact/store.ts:33` — 只有 `INSERT` 与两条 `SELECT`，无 UPDATE/DELETE（追加 checkpoint 不改写历史）；`apps/server/src/compact/engine.ts:493` — 压缩产物只写一行 `agent_compactions`。
- **缺口**：缺「自动」这一半——`createCompactor` 只被再导出（`apps/server/src/app/worker-deps.ts:1032`，`:1022` 注释「本轮只暴露、不自动调用」）并作为 `compactor` 注入（`apps/server/src/app/compose.ts:881`），而 worker 侧字段类型是 `readonly compactor?: unknown`（`apps/server/src/worker/run-task.ts:202`）**没有任何调用点**；`apps/server/src/worker/run-task.ts:414` 明写「`compactSession()` 不在这里调：`packages/racp-client` 没有 session/history 与 compact 操作」。生产实际落地的只有「识别 host 上报的 `itemType==='compaction'` → 写 `agent_compactions`」（`run-task.ts:419`-`:452`）。
- **判定依据**：三处取舍在引擎里逐条成立，但需求是「参考 checkpoint 机制做自动压缩」，判据包含「请求发出前过线就压」。压缩引擎无生产调用点，等于自动压缩未生效；按模板硬规则「有函数 ≠ 有调用方」，只能判部分实现。

### Q-5
- **状态**：已实现
- **证据**：`packages/contract/src/settings-v21.ts:81` — `eventTriggerSchema` 的四个字段（`enabled` / `prompt` / `only_body_changed` / `labels`）全在项目配置 `triggers.events.<event>` 下；`:326` — `eventTriggersSchema` 为五个事件各自预置默认值；`:344` — `V21_DEFAULT_EVENT_TRIGGERS`；`:473` — `DEFAULT_EVENT_TEMPLATES` 是平台唯一一套内置默认；`apps/server/src/config/v21-settings.ts:105` — `resolveEventTrigger()` 从项目 settings 取 `enabled`/`prompt`；`apps/server/src/trigger/decide.ts:226` — 判定顺序从项目配置读开关，`:257`-`:258` 模板为空时才回落内置默认；`apps/server/src/http/webhook-v21.ts:360` — 渲染取同一份 `resolveEventTrigger(settings, event).prompt`。
- **缺口**：（无）
- **判定依据**：需求是「事件开关、触发条件、模板全在项目级，平台只给一套内置默认值」。三个要素都在项目配置结构里，且都有读取路径改变判定结果（`decideEvent` 返回 `template`），平台侧只有 `DEFAULT_EVENT_TEMPLATES` 一份默认值。

### Q-6
- **状态**：与需求冲突
- **证据**：「一个事件一个提示词」成立：`packages/contract/src/settings-v21.ts:85` — 事件配置里只有一个 `prompt: string | null` 字段，没有任何技能清单字段。但「平台不维护技能注册表」不成立：`apps/server/src/skills/registry.ts:157` — `createSkillRegistry()`（文件头自述「技能注册表：把内置 + 仓库自带两批文件合成一张确定的命令表」），提供 `list/summaries/get/resolve/enabledNames` 六个查询面；`apps/server/src/skills/builtin.ts:438` — `BUILTIN_SKILL_FILES`（平台随二进制发布的内置技能），`:469` — `DEFAULT_PROJECT_SKILL_NAMES`（每项目默认播种三个）；`apps/server/src/skills/defaults.ts:55` — `seedProjectDefaults()` 把内置技能按项目写进库；`:254`（`apps/server/src/http/api/skills.ts`）— `GET /api/skills` 打开技能页即播种；`apps/server/src/http/api/skills.ts:291`/`:325`/`:358`/`:380`/`:409`/`:442`/`:522`/`:588` — 上传、新版本、启停、回滚、删除、在线编辑、按文件读写、批量导入共 8 条写路由。
- **缺口**：需求明写「平台不维护技能注册表」，代码里注册表、内置技能库、逐项目播种与全套增删改版本接口齐备；平台还根据提示词里的 `/name` 决定把哪份技能正文注入提示词（`apps/server/src/app/worker-deps.ts:982` 调 `renderSkillPrompt`）。反向行号：`skills/registry.ts:157`、`skills/builtin.ts:438`、`apps/server/src/http/api/skills.ts:254`。
- **判定依据**：本条是「已定结论」里的否定式要求。若把「技能注册表」理解为「事件→技能映射表」，该表确实不存在（一事件一 `prompt`，一轮最多命中一个技能：`worker-deps.ts:879` 的 `pickRequestedSkill` 只返回单个名字）；但按代码事实，平台确实在维护一张技能表并据以装配提示词，故按字面判冲突。两种读法的差异见「发现的额外问题」第 1 条。

### Q-7
- **状态**：与需求冲突
- **证据**：`apps/panel/src/layout/nav.ts:22` — `GLOBAL_NAV` 仍是五项「总览 / 成本 / 质量 / 审计 / 系统」；`:48` — `REPO_NAV` 是五项「工作台 / Issue 中心 / 运行 / 设置 / 技能」（需求只要 Issue / 设置 / 技能）；`apps/panel/src/routes.tsx:55`-`:59` — 五个全局页面仍作为独立路由注册（`/`、`/costs`、`/quality`、`/audit`、`/system`），`:62`、`:71` 还注册了「工作台」「运行」；`apps/panel/src/layout/Sidebar.tsx:67`、`:76` 直接用这两份表渲染左栏（不是死常量）。
- **缺口**：需求「总览、成本、质量、审计、系统五个页面取消」「全局只剩一个『系统』模态框」「项目级导航只有 Issue / 设置 / 技能」三条全部相反：五个页面都在，系统是独立页面而非模态框，项目导航多出「工作台」「运行」两项。
- **判定依据**：需求取消的东西在代码中逐一存在且有渲染路径（`Sidebar` 直接消费导航表，路由表直接挂页面），属于「有 archive 分支式」的反向证据，不是「尚未接线」。

### Q-8
- **状态**：部分实现
- **证据**：已具备的部分——`apps/panel/src/routes/issue-detail.tsx:195`-`:233` 会话栏 + 单一消息列表（无分区卡片）；`:247`-`:273` 人类消息右对齐气泡，带 `login` / 触发渠道 chip / 时间（`:251`-`:255`）；`:276`-`:341` agent 消息左侧无卡片，轮标题按钮 → 工具组 → 工具单行三层折叠（`:291` 轮折叠、`:318` 组、`:385` 单次调用）；`:343`-`:358` 输出正文 + 复制。
- **缺口**：四个明写子条件缺失。① issue 原文折叠卡（默认收起、只露标题与「原文·作者·N 条评论」）不存在——页面无该段，契约侧 `packages/contract/src/api.ts:1092` 的 `issueSessionResponseSchema` 只有 `issue` 摘要 + `turns`，无原文卡所需的评论数/作者展示单元；② 系统提示词（居中、可折叠、markdown 原文）不存在——`api.ts:931` 的 `issueTurnSchema` 无 `systemPrompt` 字段，页面也无该段；③ 平台写回居中断行不存在——`api.ts:876` `issueTurnRoleSchema = ['human','bot']`，没有「写回」这一种行，页面也不渲染；④ agent 轮默认收起的 `verdict`/`actions` JSON 不渲染（`issue-detail.tsx:343`-`:358` 只渲染 `text`）。
- **判定依据**：需求 FR-7.3 把页面自上而下定为「标题 → 原文折叠卡 → 系统提示词 → 消息流 → 输入区」，消息流内还要求三类行（人类右 / agent 左 / 写回居中）。代码实现了消息流的左右分侧与三层折叠，但五段结构里缺两段、三类行里缺一类、JSON 折叠缺一项，属主体在而若干明写子条件缺失。

### Q-9
- **状态**：部分实现
- **证据**：「不做面板内发消息」这一半成立——HTTP 写面只有配置类（`apps/server/src/http/api/index.ts:319` `PUT /api/repos/:owner/:name/settings`、`:344` `POST /api/repos`）与技能类（`apps/server/src/http/api/skills.ts:291` 起 8 条），全仓没有「代发评论 / 入队 agent 消息」的接口；面板侧也没有输入区（`apps/panel/src` 下 `textarea` 仅出现在技能编辑器与快捷键判断里，`issue-detail.tsx` 无输入框、无发送按钮）。
- **缺口**：缺「输入区只呈现形态 + 发送按钮禁用态」——需求 FR-7.5（docs/requirements.html 行 1436-1437）要求缺写接口的动作只画禁用按钮并在 `title` 写明缺哪个接口，而会话流底部目前没有任何输入区（`apps/panel/src/routes/issue-detail.tsx:229`-`:233` 以 `<ol>` 直接结束，无 composer）。
- **判定依据**：本条是两个子条件：「不做发送」与「画出禁用形态」。前者满足（后端确无该能力），后者无任何实现痕迹；禁用按钮的存在与否是可静态判定的事实，不能算「已按决策落地」。

## 本节整体结论
九条里 Q-1、Q-2、Q-3、Q-5 四条可按模板口径判为已实现：清单、告警、会话状态机、项目级事件配置都落在有调用方的路径上。Q-4 与 Q-8、Q-9 判部分实现：压缩引擎与三处取舍齐备但无生产调用点；Issue 会话流有了主体却缺三段结构与一类行；面板内发送确实没做，但禁用态输入区也没画。Q-6 与 Q-7 与需求相反：平台维护着完整技能注册表与技能库，面板仍是五项全局页 + 五项项目导航的旧 IA。因此本节**不能**整体判为已实现。

## 核查边界
- 是否执行了命令：仅执行只读检索类命令，未跑任何测试/构建。实际执行：`git status --short`（与 `_baseline.txt` 一致，除 `docs/audit/` 外无新增改动）、`git log --oneline -3`（HEAD fbfa029）、若干 `Select-String` 与目录列举用于定位（`待定`、`textarea|发送`、`findSkillMentions`、`app.(post|put|patch|delete)`、`seedProjectDefaults`、`routes`/`nav` 清单）。无一条结论依赖注释；注释只作为「实现者自述」被引用在需要对照的位置。
- 未覆盖的条目及原因：Q-4 的「真实最近窗口」是否被 provider 实际接受、Q-2 告警是否真的出现在运行日志，都需要真模型/真库运行才能确认（本单元未启服务）。`PLACEHOLDER_NAMES` 12 个逐个可渲染的断言只核对到测试存在（`apps/server/test/prompt-render.test.ts:42`、`:47`），未执行。
- 发现的额外问题（不属本节范围但值得记录）：
  1. **Q-6 的读法歧义需要一次拍板**：若「不维护技能注册表」的原意是「不维护事件→技能映射、不做多技能编排」，实现是符合的（一事件一 `prompt`；`apps/server/src/app/worker-deps.ts:879` 一轮最多命中一个技能）；若是字面「不维护技能表」，则 `skills/` 整个子系统与本条相反。两种读法对应完全不同的改法，建议在需求里写明限定语。
  2. **会话轮换仍会 `session/archive`**：`apps/server/src/app/compose.ts:1315` 在 `v21SessionEventActive === false` 时会归档旧会话再新建（30 轮 / 7 天策略，`AGENT_SESSION_POLICY` at `compose.ts:209`），而 `v21SessionEventActive` 只有在 `executeTask()` 显式传 `sessionEvent` 时才为真（`:1196`），队列路径不传 → 该分支在实际队列路径是活的。这与 Q-3「会话本身不归档」的精神有张力（触发原因不是 issue 关闭，但归档动作真实存在）。
  3. **回收沙箱没有真实容器可回收**：`apps/server/src/app/compose.ts:386`-`:388` 自述「本仓库并没有常驻的 per-session 沙箱可拉起」，因此 `recycle-sandbox` 落地为「清 `sandbox_id` + 标 idle」，与需求描述的「回收容器」在语义上只是近似。
  4. **技能正文里出现 `{{unknown}}` 时不会告警**：`apps/server/src/skills/prompt.ts:758` 产出 `stats.unknownPlaceholders`，但唯一调用方 `apps/server/src/app/worker-deps.ts:982` 只取 `.prompt`，`stats` 被丢弃 → 该字段全仓无消费方（仅 `test/skills-prompt.test.ts:163` 断言）。若 Q-2 的「记一条配置告警」也应覆盖技能正文，这里缺一条告警。
  5. **动作集合与需求规模不一致**：`apps/server/src/skills/prompt.ts:345` 渲染的 `actions` 有 12 类（含 `update_issue` / `reopen_issue` / `update_comment` / `delete_comment` / `link`），而 FR-5.3（docs/requirements.html 行 977-987）只定义 7 类。Q-6 引用的「只执行产出的四类动作」在这个集合面前也需要重新对齐口径（可能属其他单元）。
