# Issue 处理平台 v2.1 · 需求实现审查小结（审查标尺）

> 来源：`docs/requirements.html`（v2.1，2026-11-12，状态「评审中 · 决策已定」）。
> 用途：作为 **7 个需求实现审查机器人** 的统一输入；每个机器人只读代码、逐条给判定与证据，不改文件。
> 配套：`docs/v21-contract.md`（开发期接口冻结）、`docs/v21-contract.md` §8（需求→落点映射）。
> 本文件只陈述「要求与校验口径」，**不预判实现状态**；实现状态由审查机器人独立给出。

---

## 0. 审查判定口径（所有机器人必须遵守）

| 判定 | 含义 |
|---|---|
| `已实现` | 有生产代码 + 有对应单测/端到端用例 + **已接入运行时链路**（全仓存在真实生产 import，不是只有测试引用） |
| `部分实现` | 满足其一：有模块与单测但**无生产 import（孤儿模块）**；接入了但关键分支/边界缺失；只有旧实现、语义与新需求不一致 |
| `未实现` | 找不到承载该需求的生产代码 |
| `不适用` | 需求明确列为非目标（如 PR 会话域、合并 PR） |

硬要求：
1. 每条判定必须给 `文件:行号` 证据；「文件存在」不算证据。
2. **必须 grep 生产侧 import**，区分「模块写了」与「模块被用上」。孤儿模块一律降到 `部分实现`。
3. 测试要核对断言方向，不能只看「有测试文件」。
4. 发现与需求冲突的实现，单列 `冲突` 并给需求编号。
5. 输出统一表格：`需求编号 | 要求摘要 | 判定 | 证据（文件:行号 / 测试） | 缺口或冲突说明`。

---

## 1. R1 · 事件接入（FR-1.1 ~ FR-1.4，P0）

| 编号 | 要求摘要 | 关键校验点 |
|---|---|---|
| FR-1.1 | 单一 HTTP 入口；支持 issues / issue_comment / pull_request / installation；**读原始请求体**，不得先 JSON 解析；读事件类型、投递 ID、签名三个头 | 原始体在验签前未被解析；四类事件是否都有处理或明确的忽略留痕 |
| FR-1.2 | 每请求 HMAC-SHA256 校验；失败返回 401 **但仍落库留痕** | 验签失败路径是否写 `webhook_deliveries`；是否 401 |
| FR-1.3 | 以 GitHub 投递 ID 为唯一键，**去重必须在持久层** | 是否用 `webhook_deliveries` 主键 `INSERT ... ON CONFLICT`；进程重启后是否仍有效 |
| FR-1.4 | 10 秒内返回 2xx，实际处理异步 | 落库/入队是否在应答前完成；有无同步调模型或同步写 GitHub |

相关 BR：BR-6（判定留痕，见 R2）、BR-3（三层去重，见 R3）。
既有落点（供核对，不代表已满足）：`apps/server/src/http/webhook.ts`、`apps/server/src/db/schema.ts::webhookDeliveries`、`migrations/0000_init.sql`。

---

## 2. R2 · 事件触发配置（FR-2.1 ~ FR-2.5，P0）

| 编号 | 要求摘要 | 关键校验点 |
|---|---|---|
| FR-2.1 | 每事件独立开关；未配置继承默认值 | 五个事件默认值：opened=触发、edited=触发且仅正文变更、labeled=条件（命中所配标签）、closed=关闭、comment=条件（过闸门）；`pull_request.*` 独立不进 issue 会话 |
| FR-2.2 | 提示词模板按「项目 + 事件」配置；未配置用内置默认；模板可含技能触发词 | 模板是否真的用于生成本轮指令；`null` 与空串语义是否唯一 |
| FR-2.3 | 占位符：可重复出现全替换；**一次遍历**，替换结果不二次替换；未知占位符原样保留 + 后台配置告警；12 个占位符齐全 | `{{repo.issues}}` 惰性求值（模板未写则零请求）、缓存 5 分钟、上限 200、排除 PR、字段只给编号/状态/标题 |
| FR-2.4 | 评论事件四闸门：是否提及才触发(是)、是否限定角色(否，只能从项目角色清单选)、是否忽略机器人自身(是)、是否响应已关闭 issue(否)；**闸门在事件开关之后** | 判定顺序错会产生误导性留痕原因；角色只能引用不能临时填 |
| FR-2.5 | 合法提及：`@` + 关键词 + 分隔符（空格/换行/标点或结尾）；`@pi-bot-x`/`@pi-bot你好` 不合法；多关键词最长优先；代码区蒙版 | 四条判定示例必须逐条可验证；中文习惯粘连不识别是**有意的代价** |

相关 BR：BR-6（不触发也留痕，含原因）、BR-11（不自动管理标记）、BR-12。
相关 AC：AC-17 / AC-18 / AC-21 / AC-22。
既有落点：`packages/contract/src/settings-v21.ts`、`apps/server/src/trigger/{decide,mention,roles}.ts`、`apps/server/src/prompt/{render,repo-issues}.ts`、`apps/panel/src/components/settings/v21-{events,comment}-section.tsx`。

---

## 3. R3 · 会话协调与幂等（FR-3.1 ~ FR-3.5，P0）

| 编号 | 要求摘要 | 关键校验点 |
|---|---|---|
| FR-3.1 | 「仓库 + issue 编号 → 会话 ID」一对一映射，唯一权威来源；首次创建、后续复用 | 主键 `(repo, issue_number)`；不得由其他部件推断 |
| FR-3.2 | 事件进入会话是「追加一轮」，不是重开 | `session/attach` + 游标；是否有每轮新建会话的退化 |
| FR-3.3 | 同 issue 串行（同一时刻只允许一轮）、跨 issue 并行；事件到达即入队**不得丢弃** | 是否用 `singletonKey` 排队（会丢第二条）；`SELECT ... FOR UPDATE SKIP LOCKED` 取最老一条 |
| FR-3.4 | 会话**没有 ended 状态**；关闭只回收沙箱；重开复用原会话；运行状态仅活跃/空闲 | 关闭时是否保留会话行与全部记录；有无 archive/delete 动作 |
| FR-3.5 | 三层去重：投递级(投递 ID) → 事件级(事件唯一标识) → 内容级(同 issue 内评论正文规范化) | 内容级五条口径：只看 issue 内、只规范化不语义近似、与作者无关、上一轮失败不参与、跳过要留痕 |

相关 BR：BR-3；AC：AC-19 / AC-20 / AC-23。
既有落点：`apps/server/src/agent/{store,dispatcher,session-state}.ts`、`apps/server/src/db/schema.ts::agentSessions`、`migrations/0006_agent.sql` / `0011_v21.sql`。

---

## 4. R4 · 提示词下发（FR-4.1 P0 / FR-4.2 P1）

| 编号 | 要求摘要 | 关键校验点 |
|---|---|---|
| FR-4.1 | 四段固定顺序：技能触发词 → issue 锚点 `#编号` → 链接 → 正文快照；链接与快照并存 | 内置默认模板与项目模板是否都过同一渲染器；正文快照是否为事件时刻版本 |
| FR-4.2 | 首次下发完整正文；后续事件只下发变更内容与本轮指令，不重复整篇正文（P1） | 第二轮 `issues.edited` 是否仍整篇重发（若是，判 `部分实现` 并注明 P1） |

既有落点：`apps/server/src/trigger/decide.ts::DEFAULT_EVENT_TEMPLATES`、`apps/server/src/agent/message.ts`（v0.3 旧模板）、`apps/server/src/app/compose.ts`（装配）。

---

## 5. R5 · 执行与产出（FR-5.1 ~ FR-5.6，P0）

| 编号 | 要求摘要 | 关键校验点 |
|---|---|---|
| FR-5.1 | 平台不决定「做什么」：不维护技能注册表、不按事件硬编码行为；但必须定义「动作长什么样」 | 有无按事件类型硬编码动作；换模板行为是否随之改变 |
| FR-5.2 | 工具调用与沙箱；每次调用记录工具名、入参、返回；**写操作（评论/打标/关闭/开 PR）一律不作为工具开放** | 工具清单是否只含只读 + pi SDK 自带；写凭证是否进沙箱 |
| FR-5.3 | 封闭动作集合七类：判定/标签/评论/reaction 默认开放；建 issue/开 PR/关 issue **默认关闭、项目可开**；产出格式 `verdict / evidence / actions[] / actions[].type / actions[].payload`；三条校验：未知 type **拒绝整份**、缺必填拒绝、按序执行遇失败即停 | 是否逐条丢弃（错）；后三类开关是否在执行**前**整份拒绝；`actions:[]` 是否合法 |
| FR-5.4 | 标签目标态；平台有删除权（含人打的标签）；四条保护：目录即全量（目录外不存在）、空集不默认清空（需显式 clear）、超限**整批拒绝不截断**、删除留痕记原主人；人删过不构成永久否决（用「不自动管理」显式标记）；含义为空的标签不参与自动对齐 | 输入是否含当前全量标签 + 完整目录（含含义）；`managed=false`/`status=retired` 是否不删不加 |
| FR-5.5 | 按序执行、失败不得静默（兜底反馈 + 后台告警）；不合并 PR；**无产出/超时/不合契约时标签与评论保持原状** | 兜底评论是否绕过槽位；失败后是否有半成品中间态 |
| FR-5.6 | 上下文超模型窗口时**自动压缩**，不报错、不丢消息、不强开新会话；八小节：触发/压缩方式/结果怎么放/多次压缩/工具输出/保留策略/失败降级/可观测 | 双阈值从窗口现算；checkpoint 追加不改写历史；第二次走增量 UPDATE 摘要（PRESERVE/ADD/In Progress→Done）；工具输出三层裁剪；六阶降级；**是否真的在请求发出前被调用**（关键：孤儿引擎只能判 `部分实现`） |

相关 BR：BR-9 / BR-10 / BR-11 / BR-12；AC：AC-13 ~ AC-16 / AC-24 / AC-25。
既有落点：`packages/envelope/src/v21.ts`、`apps/server/src/writeback/v21/*`、`apps/server/src/compact/*`、`apps/server/src/agent/session-state.ts`。

---

## 6. R6 · 记录与查询（FR-6.1 ~ FR-6.4，P0）

| 编号 | 要求摘要 | 关键校验点 |
|---|---|---|
| FR-6.1 | 每轮用户输入/助手输出/工具调用与结果按顺序落库；**来源必须是执行侧生成，不能靠 agent 自述** | `run_events` 是否由事件流写入；有无依赖模型自报 |
| FR-6.2 | 每次工具调用记录：工具名、入参、返回摘要、耗时、成功与否；命令类另记 argv、退出码 | 是否已有字段承载；缺哪几项 |
| FR-6.3 | 按轮次记录 prompt/completion token 并折算成本；可按 issue / 仓库 / 时间聚合 | `usage_costs` 与 `cost/pricing.ts` |
| FR-6.4 | 后台四种查询：会话详情（按轮分组、工具入参可展开）、成本与用量（下钻单轮）、事件时间线（投递→判定→执行→写回，被忽略事件也能看原因）、审计（谁触发/改了什么/失败在哪步） | 判定原因与压缩记录是否有展示位；四种视图是否都在面板可达 |

既有落点：`apps/server/src/queries/{audit,costs,issues,tasks}.ts`、`apps/panel/src/routes/{issue-detail,costs,audit,task-detail}.tsx`、`apps/panel/src/components/EventTimeline.tsx`。

---

## 7. R7 · 配置模型 / 业务规则 / 数据 / 验收（横向）

| 分组 | 校验点 |
|---|---|
| 第 6 章配置模型 | 平台级**只有**模型相关（端点/模型名/密钥/调用参数）与 bot 相关（身份/句柄/App 凭证）；其余全部项目级（含 agent 系统提示词、并发限流、日配额、超时）；内置默认（随程序发布）而非「平台默认」；项目配置整体覆盖；6.3 的 12 个占位符；6.5 标签目录（名称/颜色来自 GitHub，含义/分组来自平台，漂移显性化）；6.6 角色清单只支持个人 login（不支持 org/team），七种 author_association；6.7 系统提示词与事件模板四维对比、触顶行为（并发排队/配额拒绝并留痕/超时终止不重试） |
| 第 7 章业务规则 | BR-1 ~ BR-12 逐条核对，尤其 BR-3（三层去重）、BR-6（不触发也留痕）、BR-9 ~ BR-12（目标态/槽位/删除权） |
| 第 8 章数据需求 | 会话保留期与 issue 同生命周期；数据保留天数可配；新增表 `comment_slots` / `agent_compactions`；`webhook_deliveries.decision/decision_reason`；迁移 0011 与 schema 一致 |
| 第 10 章验收 | AC-1 ~ AC-25 逐条标注「有自动化用例 / 仅人工验收 / 无」，并指出未覆盖项 |

---

## 8. 审查机器人分组与并发安排

| 机器人 | 负责 | 主要检索路径 |
|---|---|---|
| R1 | FR-1.1~1.4 | `apps/server/src/http/**`、`db/schema.ts` |
| R2 | FR-2.1~2.5 | `packages/contract/src/settings-v21.ts`、`trigger/**`、`prompt/**`、面板事件/评论分区 |
| R3 | FR-3.1~3.5 | `agent/**`、`db/schema.ts`、`migrations/0006*`、`0011*` |
| R4 | FR-4.1~4.2 | `trigger/decide.ts`、`agent/message.ts`、`app/compose.ts` |
| R5 | FR-5.1~5.6 | `packages/envelope/src/v21.ts`、`writeback/v21/**`、`compact/**`、`worker/**` |
| R6 | FR-6.1~6.4 | `queries/**`、`cost/**`、`apps/panel/src/routes/**`、`components/EventTimeline.tsx` |
| R7 | 第 6/7/8/10 章 | `packages/contract/**`、`config/**`、`migrations/**`、全部 test 文件 |

汇总由主理人完成：合并 7 份逐条判定表 → 统计「已实现/部分/未实现/冲突」→ 输出最终审查结论与遗留问题清单。
