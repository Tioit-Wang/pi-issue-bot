# CHECK-3 裁决（U11-U19）

> 基线：`docs/audit/v2/_baseline.txt`（HEAD `fbfa029` + 工作区未提交改动）
> 方法：读 A/B 状态 → 相同者抽验 1 条证据（亲自打开 `file:line`）→ 不同者亲自读代码裁决，不做中间调和
> 裁决人立场：只认代码，不认注释与文档自述；「存在」≠「生效」

## 区间结论表

### U11 §5.4 提示词下发

| 单元 | 条目 | A | B | 归类 | 最终判定 |
|---|---|---|---|---|---|
| U11 | FR-4.1 | 部分实现 | 部分实现 | 收敛 | **部分实现**（自定义模板无结构校验 + `claimOldest` 丢 `skill_ids`） |
| U11 | FR-4.2 | 与需求冲突 | 与需求冲突 | 收敛 | **与需求冲突**（五个模板全含 `{{issue.content}}`） |

### U12 §5.5 执行与工具

| 单元 | 条目 | A | B | 归类 | 最终判定 |
|---|---|---|---|---|---|
| U12 | FR-5.1 | 已实现 | 与需求冲突 | **分歧** | **与需求冲突** |
| U12 | FR-5.2 | 部分实现 | 部分实现 | 收敛 | **部分实现** |
| U12 | FR-5.3 | 部分实现 | 与需求冲突 | **分歧** | **与需求冲突** |
| U12 | FR-5.4 | 已实现 | 与需求冲突 | **分歧** | **与需求冲突** |
| U12 | FR-5.5 | 部分实现 | 部分实现 | 收敛 | **部分实现** |
| U12 | FR-5.6 | 部分实现 | 未实现 | **分歧** | **未实现** |
| U12 | TOOL-1 | 已实现 | 已实现 | 收敛 | **已实现** |
| U12 | TOOL-2 | 部分实现 | 已实现 | **分歧** | **已实现**（附需求文档漂移） |
| U12 | TOOL-3 | 已实现 | 已实现 | 收敛 | **已实现**（契约 19，需求 16，16 个全在） |
| U12 | TOOL-4 | 已实现 | 已实现 | 收敛 | **已实现** |
| U12 | TOOL-5 | 已实现 | 部分实现 | **分歧** | **已实现**（B 的反证被推翻） |
| U12 | TOOL-6 | 已实现 | 部分实现 | **分歧** | **部分实现**（B 方向对，机制错） |
| U12 | TOOL-7 | 已实现 | 已实现 | 收敛 | **已实现** |
| U12 | TOOL-8 | 已实现 | 已实现 | 收敛 | **已实现** |

### U13 §5.6 记录与查询

| 单元 | 条目 | A | B | 归类 | 最终判定 |
|---|---|---|---|---|---|
| U13 | FR-6.1 | 部分实现 | 部分实现 | 收敛 | **部分实现** |
| U13 | FR-6.2 | 部分实现 | 部分实现 | 收敛 | **部分实现**（耗时 / argv / 退出码全无） |
| U13 | FR-6.3 | 部分实现 | 部分实现 | 收敛 | **部分实现**（run 粒度，非 turn） |
| U13 | FR-6.4 | 部分实现 | 部分实现 | 收敛 | **部分实现** |

### U14 §5.7 面板

| 单元 | 条目 | A | B | 归类 | 最终判定 |
|---|---|---|---|---|---|
| U14 | FR-7.1 | 与需求冲突 | 与需求冲突 | 收敛 | **与需求冲突**（五个全局页仍是独立路由） |
| U14 | FR-7.2 | 部分实现 | 部分实现 | 收敛 | **部分实现** |
| U14 | FR-7.3 | 部分实现 | 部分实现 | 收敛 | **部分实现** |
| U14 | FR-7.4 | 与需求冲突 | 未实现 | **分歧** | **与需求冲突** |
| U14 | FR-7.5 | 部分实现 | 部分实现 | 收敛 | **部分实现** |

### U15 §6.1+6.2 层级

| 单元 | 条目 | A | B | 归类 | 最终判定 |
|---|---|---|---|---|---|
| U15 | 6.1-A 平台级只管模型+bot | 部分实现 | 部分实现（6.1-a） | 收敛 | **部分实现** |
| U15 | 6.1-B 触发侧（开关/模板/关键词/角色） | 已实现 | 已实现（b/f/g/h/i） | 收敛 | **已实现** |
| U15 | 6.1-C 执行侧（提示词/并发/日配额/超时） | 部分实现 | 部分实现（b~e） | 收敛 | **部分实现** |
| U15 | 6.1-D 标签目录与 GitHub 同步 | 部分实现 | 已实现（6.1-j） | **分歧** | **部分实现** |
| U15 | 6.1-E 数据保留期 | 部分实现 | 部分实现（k） | 收敛 | **部分实现** |
| U15 | 6.2-1 默认是内置默认 | 部分实现 | 部分实现（a） | 收敛 | **部分实现** |
| U15 | 6.2-2 未配置回落内置默认 | 已实现 | 已实现（b） | 收敛 | **已实现** |
| U15 | 6.2-3 整体覆盖不拼接 | 已实现 | 部分实现（c） | **分歧** | **部分实现** |
| U15 | 6.2-4 改动下一事件生效 | 部分实现 | 部分实现（d） | 收敛 | **部分实现** |
| U15 | 6.2-5 配置随事件快照 | 已实现 | 部分实现（e） | **分歧** | **部分实现** |

> A/B 条目切分不同（A 五条聚合，B 十一条），对照关系已在上表括号内标明；无条目遗漏，仅粒度不同。

### U16 §6.3 占位符

| 单元 | 条目 | A | B | 归类 | 最终判定 |
|---|---|---|---|---|---|
| U16 | PH-1 十二个占位符 | 已实现 | 已实现 | 收敛 | **已实现** |
| U16 | PH-2 标签列表格式与边界 | 已实现 | 已实现 | 收敛 | **已实现** |
| U16 | PH-3 `{{repo.issues}}` 规模控制 | 已实现 | 部分实现 | **分歧** | **部分实现** |

### U17 §6.4 配置示例

| 单元 | 条目 | A | B | 归类 | 最终判定 |
|---|---|---|---|---|---|
| U17 | EX-1 事件开关 | 已实现 | 部分实现 | **分歧** | **部分实现** |
| U17 | EX-2 事件模板 | 已实现 | 已实现 | 收敛 | **已实现** |
| U17 | EX-3 `only_body_changed` | 已实现 | 部分实现 | **分歧** | **部分实现** |
| U17 | EX-4 评论四闸门 | 已实现 | 已实现 | 收敛 | **已实现** |
| U17 | EX-5 配置载体 | 已实现 | 已实现 | 收敛 | **已实现** |

### U18 §6.5 标签目录

| 单元 | 条目 | A | B | 归类 | 最终判定 |
|---|---|---|---|---|---|
| U18 | LD-1 五个字段 | 与需求冲突 | 与需求冲突 | 收敛 | **与需求冲突** |
| U18 | LD-2 三条同步规则 | 与需求冲突 | 与需求冲突 | 收敛 | **与需求冲突** |
| U18 | LD-3 含义为空保护 | 已实现 | 已实现 | 收敛 | **已实现** |
| U18 | LD-4 刷新时机 | 未实现 | 部分实现 | **分歧** | **部分实现** |
| U18 | LD-5 目录交付执行侧 | 部分实现 | 部分实现 | 收敛 | **部分实现** |

### U19 §6.6 评论触发配置

| 单元 | 条目 | A | B | 归类 | 最终判定 |
|---|---|---|---|---|---|
| U19 | CC-1 提及关键词 | 已实现 | 部分实现 | **分歧** | **部分实现** |
| U19 | CC-2 角色清单 | 已实现 | 已实现 | 收敛 | **已实现** |
| U19 | CC-3 存 user id、按 id 匹配 | 未实现 | 未实现 | 收敛 | **未实现** |
| U19 | CC-4 保存时校验账号存在 | 未实现 | 未实现 | 收敛 | **未实现** |

**区间合计**：52 个条目，收敛 36、分歧 16。最终判定分布：已实现 16、部分实现 25、与需求冲突 8、未实现 3、无法判定 0。

## 分歧裁决

### U12 FR-5.1 平台不决定处理内容

- A：已实现（平台只转发 + 校验 + 执行）；B：与需求冲突（既有技能注册表，也有按事件类型写死触发词的默认模板表）。
- 裁决：**与需求冲突**。
- 依据：`apps/server/src/skills/registry.ts`（技能注册表存在）、`apps/server/src/skills/builtin.ts:178`（内置 `/proposal-analysis`）、`packages/contract/src/settings-v21.ts:473`（`DEFAULT_EVENT_TEMPLATES` 按事件类型写死触发词）。
- 理由：需求原文（requirements.html 行 957-963）写「平台不维护技能注册表，也不按事件类型硬编码行为」。代码两件都做了。A 把「注册表可配置」当成「平台不决定」，但注册表本身就在平台代码里，且默认模板按事件类型预置技能点名，属需求明列的反例。超集式默认不能抹平这条。

### U12 FR-5.3 产出契约：封闭动作集合

- A：部分实现（12 类 vs 7 类）；B：与需求冲突（多出 5 类照常执行）。
- 裁决：**与需求冲突**。
- 依据：`packages/envelope/src/v21.ts:465-476`（verdict/label/comment/reaction/create_issue/open_pr/close_issue/reopen_issue/update_issue/update_comment/delete_comment/link 共 12 型）。
- 理由：需求 1039 行前表定义 7 类封闭集合且「集合外一律拒绝」。代码 12 类且多出的 5 类走同一执行器（`apps/server/src/writeback/v21/execute.ts`）。封闭集合被实质性扩大 = 行为与需求相反，不是「实现不全」。

### U12 FR-5.4 标签目标态与删除权

- A：已实现；B：与需求冲突（当前标签取自 `bot_labels`，人打的标签永不进差集）。
- 裁决：**与需求冲突**。
- 依据：`apps/server/src/app/compose.ts:1652-1665`（`currentLabels` 从 `bot_labels` 取 `not removed` 的行）、`apps/server/src/app/compose.ts:857`、`apps/server/src/app/compose.ts:1148`。
- 理由：需求 1038-1048 行明写「平台拥有删除权，**包括删除人手动打的标签**」「人工删除不构成永久否决」。代码把「当前实际标签」换成自家台账，人打的标签永远不在差集里，永远删不掉。A 采信的 I4 安全不变式与需求正文正面冲突，此处按需求正文判冲突（并单列在残余风险：改它会动 AGENTS.md I4，需产品决策）。

### U12 FR-5.6 上下文压缩

- A：部分实现（引擎在、无调用方、两档提醒缺）；B：未实现。
- 裁决：**未实现**。
- 依据：`apps/server/src/compact/engine.ts:436`（`compactSession` 定义）；全仓 `compactSession` 的调用点只有 `apps/server/src/compact/engine.ts:701`（`createCompactor` 内部转调）与 `test/compact-engine.test.ts` 的 12 处用例；`apps/server/src/worker/run-task.ts:414` 注释自认「只做识别、不在这里调」。
- 理由：判定口径是「有函数 ≠ 有调用方」。`createCompactor` 同样无生产装配点，故整条压缩链路零生产入口，窗口临近边界的行为不存在。A 把「引擎 + 单测齐全」折算成部分实现，混淆了库代码与生效路径；按 §3.2 口径只能是未实现。

### U12 TOOL-2 工具清单唯一事实源

- A：部分实现（需求文档表格未派生，16 vs 契约 19）；B：已实现。
- 裁决：**已实现**，附文档漂移。
- 依据：`packages/contract/src/issue-tools.ts:127-271`（19 项 `ISSUE_TOOLS`）；派生消费方 `packages/contract/src/enums.ts:20`、`apps/server/src/runtime/issue-read-tools.ts:36`、`apps/server/src/skills/prompt.ts:500,542`。
- 理由：A 自己也承认审批矩阵 / 技能枚举 / 提示词目录全部派生，唯一缺口是 `docs/requirements.html:1152-1167` 那张表仍写 16 条。需求文档是上游规格，不是代码里的第二份清单实现，属「规格未同步」的文档漂移，不构成 TOOL-2 的实现缺口；该漂移已单列在 STALE/残余项。

### U12 TOOL-5 Bash 不得做 issue 操作

- A：已实现；B：部分实现（deny 审计写入 `kind='approval.audit'`，审计查询按 `approval` 匹配不到）。
- 裁决：**已实现**（B 的反证不成立）。
- 依据：`apps/server/src/worker/run-task.ts:981`（`appendEvent('approval.audit', audit)`）；`apps/server/src/queries/sql.ts:330`（`when ${column} like 'approval.%' then 'approval'`）把 `approval.audit` 归一到 `approval`；`apps/server/src/queries/audit.ts:78` 按归一后的 kind 过滤。
- 理由：B 的缺口假设「查询按字面 `approval` 等值匹配」，但归一化视图显式覆盖了 `approval.%`。deny 路径有审计、审计查得到，故已实现。

### U12 TOOL-6 写操作只有一条路

- A：已实现；B：部分实现（v2 动作行 `intent='v21:*'`，被 intent 白名单过滤）。
- 裁决：**部分实现**（采纳 B 的结论，修正其机制表述）。
- 依据：`apps/server/src/worker/run-task.ts:1431,1450`（`intent: \`v21:${item.type}\``）；`packages/contract/src/enums.ts:130`（`RECORDED_ACTION_INTENTS` 只有 comment/label/create_issue/push_branch/close_issue/reaction.*）；`packages/contract/src/api.ts:313,496`（响应契约用 `recordedActionIntentSchema`）。
- 理由：「只有一条写入通道」成立，但 v2 行写进 `actions.intent` 的值不在契约枚举里，任何按契约解析这些行的读出口（面板/AI 查询 API）都会 parse 失败或被过滤。这不是「白名单过滤」而是契约枚举缺口，结论同样是部分实现。

### U14 FR-7.4 三个左栏画法一致

- A：与需求冲突（宽度/行高/强调条数值不符）；B：未实现（代码里没有 320/300/3px）。
- 裁决：**与需求冲突**。
- 依据：`apps/panel/src/index.css:92`（`--row-height: 2.0625rem` = 33px）；全仓 `apps/panel/src` 无 `320px` / `300px` 面板列宽常量（检索 `320px|300px|208px|224px` 仅命中注释里的无关描述）。
- 理由：需求 1428-1432 行给的是具体数值（320 / 窄屏 300 / 行高 28 / 左侧 3px 强调条）。左栏本身存在、只是数值与画法不符，属「实现与需求数值相反」，按模板归「与需求冲突」；B 的「没有这个数」实际就是冲突，分类错了。

### U15 6.1-D 标签目录与 GitHub 同步

- A：部分实现（无任何同步实现）；B：已实现（字段 + 消费方）。
- 裁决：**部分实现**。
- 依据：`apps/server/src/app/worker-deps.ts:603-624`（目录端口只有 `GET /repos/{owner}/{repo}/labels` 用于判 missing 与 `POST .../labels` 建标签）；全仓无「把仓库标签读回 `repos.settings.labels.vocabulary`」的写入路径。
- 理由：需求 6.1 的条目是「标签目录（与 GitHub 同步）」。字段与消费成立，但「与 GitHub 同步」只有单向的「仓库有 / 没有」判据，没有回流到目录的路径，故部分实现。

### U15 6.2-3 整体覆盖不拼接

- A：已实现；B：部分实现（`resolveAgentExecution()` 对 actions 两处取或）。
- 裁决：**部分实现**。
- 依据：`apps/server/src/config/v21-settings.ts:204-207`（`agent.system_prompt` 与 `limits.system_prompt` 二选一回落）、`:214-216`（`agent.actions.create_issue || limits.actions.create_issue` 等三处按「或」合并）。
- 理由：需求 6.2 要求「项目配置整体覆盖，不追加不拼接」。同一语义字段在 `agent.*` 与 `agent.limits.*` 两处按「或」合成一个生效值，正是拼接；注释解释的「避免配置了却不生效」是工程妥协，不改变语义。

### U15 6.2-5 配置随事件打成快照

- A：已实现（请求级快照，判定=渲染）；B：部分实现（落库渲染文本非配置本体，任务开始再读一次库）。
- 裁决：**部分实现**。
- 依据：`apps/server/src/http/webhook-v21.ts:684`（webhook 侧 `resolveAgentExecution(rawSettings)` 用快照）；`apps/server/src/app/compose.ts:1405-1407`（任务装配时再次 `readRepoPolicy` + `resolveAgentExecution` 取 `systemPrompt`）。
- 理由：「判定与渲染同一份」成立，但同一事件在任务装配时二次读库，中间若有配置改动，执行侧拿到的是新值。需求要求「随事件打成快照」，二次读库即破坏该性质，故部分实现。

### U16 PH-3 `{{repo.issues}}` 规模控制

- A：已实现；B：部分实现（取两页原始条目后才过滤、未传 `sort=updated`、总数是近似值且含 PR）。
- 裁决：**部分实现**。
- 依据：`apps/server/src/prompt/repo-issues.ts:110`（`listIssues({ state:'open', perPage:100, page })`，无 `sort`）、`:115`（拿满 100 条才继续翻页）、`:121-123`（先过滤 PR 再本地按 `updatedAt` 排序后截 200）、`:127-128`（总数直接取自 appro 的 total）。
- 理由：取数窗口由 GitHub 默认排序（最新创建）决定的 200 条原始条目构成，PR 混杂其中；本地按更新时间重排只能重排已抓到的子集，「最近 200 条」这一语义不成立。A 只看到 200 的常量存在。

### U17 EX-1 按事件开关

- A：已实现；B：部分实现（事件对象部分写入时事件级默认失效）。
- 裁决：**部分实现**。
- 依据：`packages/contract/src/settings-v21.ts:83`（事件对象内部 `enabled: eventSwitchSchema.default('on')`）、`:328-332`（事件级正确默认挂在 **key 的 `prefault`** 上：`issues.closed` → `off`）；`apps/server/src/config/repo-config.ts:449-463`（`updateRepoSettings` 校验后整份覆盖，无深合并）。
- 理由：`prefault` 只在 `triggers['issues.closed'] === undefined` 时生效。项目写 `triggers: { issues.closed: { prompt: 'x' } }` 时对象存在，落到 `:83` 的 `default('on')`，于是本该默认关闭的事件被判开启。这是真实的默认值退化，A 只验了「字段与消费路径齐全」。

### U17 EX-3 `only_body_changed`

- A：已实现；B：部分实现（同一路径下默认退化成任意编辑都触发）。
- 裁决：**部分实现**。
- 依据：`packages/contract/src/settings-v21.ts:87`（`only_body_changed: z.boolean().optional()`，无默认）、`:329`（`issues.edited` 的 `true` 只挂在 key 级 `prefault`）、`apps/server/src/config/repo-config.ts:449-463`（整份覆盖，无合并）。
- 理由：与 EX-1 同源。只写标题相关字段的部分写入会让 `only_body_changed` 变 undefined，等同「任意编辑都触发」，与 FR-2.2「只认正文变更」相反。判定路径本身存在，故部分实现而非冲突。

### U18 LD-4 刷新时机

- A：未实现（无按需刷新动作、无 TTL）；B：部分实现（写回前拉一次，但无 TTL）。
- 裁决：**部分实现**。
- 依据：`apps/server/src/app/worker-deps.ts:614`（每次写回判定前 `GET /repos/{owner}/{repo}/labels`）、`:624`（`POST` 建缺失标签）；`apps/server/src/app/compose.ts:1655`（v2.1 目标态刻意不请求 GitHub，改用 `bot_labels` 台账）。
- 理由：「按需刷新」这一半在 v0.3 写回路径上真实存在（每次写回现拉），缺的是有效期/缓存，且 v2.1 目标态完全不刷新。A 的「未实现」忽略了这个真实调用点；判部分实现。

### U19 CC-1 提及关键词

- A：已实现；B：部分实现（面板无大小写开关，且编辑关键词时把 `case_sensitive` 抹掉）。
- 裁决：**部分实现**。
- 依据：`packages/contract/src/settings-v21.ts:131-144`（`commentMentionSchema.case_sensitive` 可选）、`:200`（`mentions` 数组 min 1）；`apps/panel/src/components/settings/v21-events-section.tsx:125`（`mentions: next.map((keyword) => ({ keyword }))` —— 只保留 keyword，丢掉 `case_sensitive`）。
- 理由：契约与判定齐备，但面板保存关键词即清掉该字段。需求「可配多个 / 默认不区分大小写」中的「可配大小写」在唯一编辑入口上被静默抹掉，属实现不全，判部分实现。

## 抽验记录

> 收敛条目共 36 条，抽验 14 个条目 / 15 处引用（其余 22 条未抽验，见文末残余）。

| 单元 | 来源 | 引用 | 存在 | 相符 |
|---|---|---|---|---|
| U11 | A/B | `packages/contract/src/settings-v21.ts:85` `prompt: z.string().max(EVENT_PROMPT_MAX_CHARS).nullable().default(null)` | 是 | 相符（只限长度，无结构校验） |
| U11 | A/B | `packages/contract/src/settings-v21.ts:473` `DEFAULT_EVENT_TEMPLATES` 定义处 | 是 | 相符 |
| U11 | A/B | `settings-v21.ts:487/502/515/528/546` 五处 `{{issue.content}}` | 是 | 相符（五个模板全含正文占位符） |
| U11 | A | `apps/server/src/agent/store.ts:139` `RETURNING` 无 `skill_ids` | 是 | 相符 |
| U11 | A | `apps/server/src/agent/store.ts:201` `skillIds: toStringArray(row['skill_ids'])` | 是 | 相符（读的列取不回来，链路断在此） |
| U12 | A/B | `apps/server/src/queries/issues.ts:951` `e.kind = 'item.completed'` 归并工具调用 | 是 | 相符（无入参/返回正文） |
| U13 | A/B | `apps/server/src/queries/issues.ts:926` 注释：`item.delta` 是正文流、一律不进来 | 是 | 相符 |
| U13 | A/B | `apps/server/src/db/schema.ts:453,466` `usage_costs` 表 + `usage_costs_run_id_idx` | 是 | 相符（粒度是 run，不是 turn） |
| U14 | A/B | `apps/panel/src/routes.tsx:55-59` 五个 `group:'global'` 独立路由 | 是 | 相符 |
| U14 | B | `apps/panel/src/index.css:92` `--row-height: 2.0625rem /* 33px */` | 是 | 相符（需求 28px，判 FR-7.4 用） |
| U15 | A/B | `apps/server/src/config/v21-settings.ts:209` `configured === '' ? AGENT_IDENTITY_PROMPT : configured` | 是 | 相符（未配置回落内置默认） |
| U16 | A/B | `apps/server/src/prompt/render.ts:150-152` `issue.labels` → `join(', ')` | 是 | 相符（空集渲染空串） |
| U17 | A/B | `packages/contract/src/settings-v21.ts:332` `issue_comment.created` prefault 带 `gates: {}` | 是 | 相符（四闸门默认值齐全） |
| U18 | A/B | `apps/server/src/writeback/v21/labels.ts:82-89` `managed && status==='active' && isMeaningFilled(meaning)` | 是 | 相符（含义为空不进自动对齐） |
| U19 | A/B | `packages/contract/src/settings-v21.ts:182-184` `by:'members'` + `members: z.array(z.string().regex(MEMBER_LOGIN_RE))` | 是 | 相符（成员只有 login） |

抽验结论：**15/15 处引用存在且与所述相符**，无 STALE。

## STALE

无 STALE 条目。抽验 15 处引用（含 A/B 双方被裁决所依据的关键行）行号均存在且内容与所述相符。

两处**文档漂移**（不是代码 STALE，但会让后续审计误判）：

1. `docs/requirements.html:1152-1167` 工具表仍列 16 个 issue 工具，契约 `packages/contract/src/issue-tools.ts:127-271` 已是 19 个（多 `IssueCommentReply` / `IssueReactionAdd` / `IssueReactionRemove`）。影响 TOOL-2/TOOL-3 的口径，本报告按契约判已实现。
2. `docs/requirements.html:1038-1048`（FR-5.4）要求平台可删人手动打的标签，而 `AGENTS.md` §4 的不变式 I4「标签只撤 `bot_labels` 记过的」直接反向约束实现。二者不可能同时成立，需产品侧裁决后同批改文档或改不变式。

## 残余与边界

- 未执行任何命令（本轮纯静态读码 + `Select-String` 定位）；未跑测试，未验证运行时行为。
- 收敛条目 36 条中抽验 14 条（15 处引用），其余 22 条仅比对 A/B 表述一致，未逐条开行号：U12 的 TOOL-1/4/7/8；U13 的 FR-6.2/6.4 部分证据；U14 的 FR-7.1/7.2/7.3/7.5；U15 的 6.1-A/6.1-C/6.2-1/6.2-4；U16 的 PH-1；U17 的 EX-2/EX-5；U18 的 LD-5；U19 的 CC-2；U11 的 FR-4.2 已抽（见上）。
- 分歧 16 条中，涉及「需求正文 vs AGENTS.md 不变式」的只有 FR-5.4 一条，其余均可用代码行号直接定案。
- 本节只裁决状态，不评估修复成本；不修改任何代码、不提交。
