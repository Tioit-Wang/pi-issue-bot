# CROSS-1 复核 CHECK-3 / CHECK-4

> 复核对象：[CHECK-3.md](./CHECK-3.md)（U11-U19 裁决）、[CHECK-4.md](./CHECK-4.md)（U20-U29 裁决）
> 基线：工作区 HEAD `fbfa029` + 未提交改动（见 [_baseline.txt](./_baseline.txt)）
> 方法：**只补 CHECK-3 未抽验的条目 + 逐条质疑分歧裁决**，不重做全量审查。所有结论均亲自打开 `file:line` 核实，不采信 CHECK 的引述。
> 未执行测试 / 未起 PG / 未起 Docker；纯静态读码 + `Select-String` 定位。
> 结论前置：**推翻 4 条、存疑 1 条、维持 30 条**（分歧共 35 条）；补验 CHECK-3 未抽验条 7 条，**维持 7**。

## 一、对 CHECK-3 未抽验条目的补验

挑选标准：涉及数字常量 / 涉及「有字段 vs 有消费方」/ 涉及跨模块链路。下表 7 条均取自 CHECK-3 第 260 行列出的未抽验集合。

| 条目 | CHECK-3 判定 | 我的核验 | 依据 |
|---|---|---|---|
| U12 TOOL-4（移除工具的闭合写法） | 已实现 | **维持**。「前缀」是真前缀不是逐个列举；审批层把它排在所有判定最前，写进技能 frontmatter 会整份非法 | `packages/contract/src/issue-tools.ts:33`（`REMOVED_TOOL_PREFIXES = ['mcp__','plugin_']`）、`:56-63`（`normalize` 后 `startsWith`，`REMOVED_TOOLS` 走 `toLowerCase` 精确匹配）、`apps/server/src/runtime/approval-policy.ts:228-234`（`isRemovedTool` → deny，rule=`removed-tool`，注释明写「放在未知工具兜底之前是为了 rule 可区分」） |
| U12 TOOL-7（读操作走平台代理、token 不进沙箱） | 已实现 | **维持**。执行器由装配层注入，`repo` 平台绑死，只读名单从契约筛「read + search」组 | `apps/server/src/app/compose.ts:1410-1419`（`createIssueReadExecutor(v21IssueRead, {}, { repo: row.repo })`，注释明写「模型的 `tool_calls` 里没有 `repo`」）、`apps/server/src/runtime/issue-read-tools.ts:36-38`（`ISSUE_TOOLS.filter(group==='read'||'search')`） |
| U12 TOOL-8（通道不可用时提示词不提「你可以调用」） | 已实现 | **维持**。常量 + 单一消费方 + 措辞分支，不是死字段 | `packages/contract/src/issue-tools.ts:383`（`EXECUTE_CHANNEL_AVAILABLE = false`）、`:391-393`、`apps/server/src/skills/prompt.ts:481-487`（`issueToolAvailability() === 'callable'` 二选一，false 分支写「由平台代你执行」） |
| U13 FR-6.2（工具调用六项：工具名/入参/返回摘要/成功与否/耗时/argv+退出码） | 部分实现（耗时 / argv / 退出码全无） | **维持**。契约四字段 `.strict()` 堵死「可展开看入参」；`exitCode` 在全仓只出现在容器、doctor、git、failure 分类四处，**没有任何写入工具调用记录**的路径；`exec-proxy` 的末帧退出码只走 socket | `packages/contract/src/api.ts:908-918`（只有 `name/summary/at/ok`）、`apps/server/src/sandbox/exec-proxy.ts:384`（`{ exitCode }` 只进末帧）、`apps/server/src/worker/failure.ts:151-161`（`exitCode` 只用于失败归类，不落 `run_events`）、全仓 `exitCode` 命中见 `doctor/`、`git/run-git.ts:184-187`、`sandbox/docker.ts:174`、`jobs/lifecycle-sweep.ts:430` —— 均与工具调用记录无关 |
| U15 6.1-C（项目级执行侧：提示词 / 并发 / 日配额 / 超时） | 部分实现 | **维持，且实际更差**：四项里只有「系统提示词」有消费方，`concurrency` / `daily_quota` / `turn_timeout_minutes` 三个字段由 `resolveAgentExecution()` 产出后**全仓零读取** | 产出侧 `apps/server/src/config/v21-settings.ts:210-212`；消费侧只有 `apps/server/src/app/compose.ts:1407`（`resolveAgentExecution(policy.settings).system_prompt`）、`apps/server/src/http/webhook-v21.ts:686-688`（只读 `execution.actions`）、`apps/server/src/worker/run-task.ts:1328`（只读 `resolved.actions`）；全仓 `.concurrency` / `daily_quota` / `turn_timeout_minutes` 再无处命中（`queue/` 的 `concurrency_per_repo` 是另一字段）。与 CHECK-4 的 SL-2/SL-3/SL-4 完全同源 |
| U16 PH-1（十二个占位符逐个存在） | 已实现 | **维持**。清单 12 条与 `switch` 12 个 `case` 数量与名字一一对应，`default` 返回 `null`（未知原样保留） | `packages/contract/src/settings-v21.ts:420-433`（12 条逐项）、`apps/server/src/prompt/render.ts:132-161`（`repo/actor/event.action/issue.author/issue.number/issue.url/issue.title/issue.content/issue.labels/comment.author/comment.body/repo.issues` 共 12 个 case，`:159-160` default） |
| U18 LD-5（目录交给执行侧：非占位符 + 固定注入 + 只列含义非空 + 紧跟系统提示词） | 部分实现 | **维持**。非占位符与固定注入成立；「只列含义非空」确实没做（缺 meaning 时落到只输出名字的分支），位置也确实在技能正文之后 / 任务提示词末尾，系统通道里没有目录 | `apps/server/src/skills/prompt.ts:270-283`（`meaning === undefined` 时 `parts.length === 0` → 只输出 `- \`name\``）、`:702-727`（顺序：技能身份 → 指令正文 `:714` → 项目标签 `:717` → 任务上下文 `:719`）、`apps/server/src/app/worker-deps.ts:344`（`buildTaskPrompt` 最后一段） |

补验小结：7/7 维持，未发现「已实现被高估」或「部分实现被低估」的条目。CHECK-3 收敛判定的**方向**是可靠的；问题在于**抽样记账**（见第三节）。

## 二、分歧裁决质疑

### CHECK-3（16 条）

| 单元 | 条目 | 原裁决 | 我的态度 | 我的依据 |
|---|---|---|---|---|
| U12 | FR-5.1 平台不决定处理内容 | 与需求冲突 | **维持** | 技能注册表是真的（`apps/server/src/skills/registry.ts` 存在、`skills/index.ts:17,23` 公开导出）；事件模板按事件硬编码触发点也是真的（`packages/contract/src/settings-v21.ts:473` `DEFAULT_EVENT_TEMPLATES`）；内置技能 `/proposal-analysis` 在 `apps/server/src/skills/builtin.ts:169-184`。需求 957-963 明列两条反例，判冲突成立 |
| U12 | FR-5.3 封闭动作集合 | 与需求冲突 | **维持** | `packages/envelope/src/v21.ts:465-476` 逐类型列出 12 类（含 `verdict`），超出需求 7 类的 5 类（`create_issue/open_pr/close_issue/reopen_issue/update_issue/update_comment/delete_comment/link/reaction`）都在同一执行器里。需求写「集合外一律拒绝」，集合被扩大即行为相反 |
| U12 | FR-5.4 标签目标态与删除权 | 与需求冲突 | **维持（但需产品裁决，CHECK-3 已单列）** | `apps/server/src/app/compose.ts:1651-1669`：`readAppliedLabels()` 的注释与 SQL 都写明「当前生效标签 = `bot_labels` 里 `removed_at is null` 的行」，人打的标签不在差集里，永远删不掉。需求 1038-1048 明确要求可删人打的标签，二者不可同时成立；按 AGENTS.md「产品行为以需求正文为准」判冲突是对的，但改动会触碰 §4 不变式 I4，必须产品侧定夺 |
| U12 | FR-5.6 上下文压缩 | 未实现 | **维持** | `compactSession` 定义在 `apps/server/src/compact/engine.ts:436`，生产装配只有 `apps/server/src/app/compose.ts:881`（`compactor: createV21Compactor`）与 `:1400` 的注释「只暴露不调用」；执行侧 `apps/server/src/worker/run-task.ts:202` 声明 `compactor?: unknown` 且 `:414` 自认「只做识别、不在这里调」。全仓调用点只剩 `engine.ts:701`（`createCompactor` 内部转调）与 `test/compact-engine.test.ts` |
| U12 | TOOL-2 工具清单唯一事实源 | 已实现（附文档漂移） | **维持** | 代码侧确无第二份字面量清单（`runtime/issue-read-tools.ts:36-38` 从契约筛组、`skills/prompt.ts:481-487` 按可得性换措辞）；未落地的只是 `docs/requirements.html` 那张表。把「上游规格未同步」计入实现缺口会混淆规格与实现两层 |
| U12 | TOOL-5 Bash 不得做 issue 操作 | 已实现（B 的反证被推翻） | **推翻 → 部分实现（B 正确）** | CHECK-3 说 `queries/sql.ts:330` 的 `like 'approval.%' → 'approval'` 归一化覆盖了审计查询，但该归一化函数是 `sqlRunEventKind()`（`queries/sql.ts:315-337`），**全仓只被 `queries/tasks.ts:476` 使用**。审计页走的是 `queries/audit.ts:78` 的裸条件 `e.kind = 'approval'`，而全仓写入只有 `apps/server/src/worker/run-task.ts:981` 的 `appendEvent('approval.audit', …)`——没有任何地方写 `kind='approval'`。结论：deny 判定的审计写入成立，`/api/audit` 的 `approval` 列**恒为 null**，「留审计可复盘」不成立。CHECK-3 用了一条**在目标查询里并不生效**的归一化作为反证，这是本轮最实质的错判 |
| U12 | TOOL-6 写操作只有一条路 | 部分实现 | **维持** | 写入值 `apps/server/src/worker/run-task.ts:1431,1450`（`intent: \`v21:${item.type}\``）与白名单 `apps/server/src/queries/sql.ts:368`（`ACTION_INTENTS_SQL` 无 `v21:*`）冲突；`queries/audit.ts:58` 用它过滤。CHECK-3 纠正「机制是契约枚举缺口而非白名单过滤」——两者同时成立，结论不变 |
| U14 | FR-7.4 三个左栏画法一致 | 与需求冲突 | **维持** | `apps/panel/src/index.css:92` 行高 33px（需求 28）；`apps/panel/src` 内 `320px` / `300px` 仅命中两处无关注释（`routes/overview.tsx:172,461`），无左栏列宽常量。左栏存在但数值与需求相反，归「与需求冲突」符合口径 |
| U15 | 6.1-D 标签目录与 GitHub 同步 | 部分实现 | **维持** | 目录端口 `apps/server/src/app/worker-deps.ts:609-633`：`list()` 用 `GET /repos/{owner}/{repo}/labels` 但 `.map(row => row.name)` **丢掉 color/description**，`create()` 反而是把平台 color/description 推给 GitHub。全仓无「读回 → 写 `settings.labels.vocabulary`」路径 |
| U15 | 6.2-3 整体覆盖不拼接 | 部分实现 | **维持** | `apps/server/src/config/v21-settings.ts:206`（两条 `system_prompt` 路径二选一回落）、`:214-216`（`create_issue/open_pr/close_issue` 按「或」合成）。注释自陈是工程妥协，但「或」合并即拼接 |
| U15 | 6.2-5 配置随事件打成快照 | 部分实现 | **维持** | webhook 侧用快照 `apps/server/src/http/webhook-v21.ts:684`；任务装配侧**再次读库** `apps/server/src/app/compose.ts:1405-1407`（`readRepoPolicy` + `resolveAgentExecution`）。同一事件两次取配置，快照性质被破坏 |
| U16 | PH-3 `{{repo.issues}}` 规模控制 | 部分实现 | **维持** | `apps/server/src/prompt/repo-issues.ts:110`（`listIssues({state:'open', perPage, page})` 无 `sort`）、`:115`（取满一页才续翻）、`:120-123`（先滤 PR 再本地 `updatedAt` 排序后截 200）、`:127-128`（`total` 直接取 GitHub 的 total，含 PR）。「最近 200 条」只在已抓到的两页子集上成立 |
| U17 | EX-1 按事件开关 | 部分实现 | **维持** | `packages/contract/src/settings-v21.ts:83`（对象内 `enabled` 默认 `on`）与 `:328-332`（`issues.closed` 的 `off` 只挂在 **key 级 `prefault`**）。`prefault` 仅在键缺失时生效，部分写入会让本该关闭的事件默认开启；`apps/server/src/config/repo-config.ts:449-463` 是整份覆盖、无深合并 |
| U17 | EX-3 `only_body_changed` | 部分实现 | **维持** | `packages/contract/src/settings-v21.ts:87`（`optional()` 无默认）、`:329`（`true` 只在 key 级 `prefault`）、`apps/server/src/config/v21-settings.ts:111`（`trigger.only_body_changed === true` → undefined 即 false）→ 任意编辑都触发 |
| U18 | LD-4 刷新时机 | 部分实现 | **维持** | v0.3 写回路径确实每次现拉 `apps/server/src/app/worker-deps.ts:611-621`，无 TTL/缓存；v2.1 目标态不刷新（`app/compose.ts:1651-1657` 明写「为什么读自己的记账表而不是打一次 GitHub API」）。「按需刷新有一半」成立 |
| U19 | CC-1 提及关键词 | 部分实现 | **维持** | `packages/contract/src/settings-v21.ts:131-141`（`case_sensitive` 可选）；唯一编辑入口 `apps/panel/src/components/settings/v21-events-section.tsx:125` 写 `mentions: next.map((keyword) => ({ keyword }))`，保存即抹掉该字段 |

### CHECK-4（19 条）

| 单元 | 条目 | 原裁决 | 我的态度 | 我的依据 |
|---|---|---|---|---|
| U22 | CFG-9.1 面板身份 | 部分实现 | **推翻 → 未实现** | 本条两个分支里「可切换为个人账号」0 存在（`apps/server/src/app/github-auth.ts:21` 只有 `app/token/none/degraded`，无 `user`；全仓 `X-OAuth-Scopes|getAuthenticated|personalAccessToken` 命中 0）。CHECK-3/4 给分的依据是子条件 (a)「未配置个人令牌时以 bot 身份署名」，但**面板侧根本没有 GitHub 写回**：`apps/server/src/http/api/` 只有 DB 与技能文件写，`http/api/skills.ts:140-146` 是本地文件守卫；唯一的 GitHub 写面 `apps/server/src/app/compose.ts:759-761` 服务的是 webhook 触发的写回。也就是说 (a) 不是一个「已实现的分支」，而是系统唯一且有的事实；把它折算成「四条件完成 1 个」等于给不存在的能力发分。与 CHECK-4 自己给 U21 CFG-8.3（同样是「有部署级默认、无项目级覆盖」）判**未实现**的标准自相矛盾 |
| U23 | BR-6 不触发也留痕 | 未实现 | **维持** | `apps/server/src/queries/` 内 `decision` 命中全是审批判定（`audit.ts:107-110,247-248`），`decision_reason` 零读取；契约侧 `decisionReason` 0 命中。写入侧 `apps/server/src/http/webhook-v21.ts:198-211` 完整但不产生可查能力 |
| U23 | BR-7 失败可见 | 已实现 | **存疑** | 「有 App 凭证时」成立且有代码（`apps/server/src/feedback/stage.ts:24-38` 终态 `-eyes +confused`、`feedback/apply.ts:149-160,308`）。但装配层 `apps/server/src/app/compose.ts:785-792` 明写「`feedback === null` 表示本部署没有可用的 reaction 写面…worker 缺端口就是不打 reaction」——**没装 App 的部署失败即静默**，而需求给的另一选项「后台告警」在全仓无落点（无告警通道，`run-task.ts:1263-1282` 的兜底评论在 v2 分支被 `!v21Handled` 挡掉）。判「已实现」把「部署前提」当成了实现，建议降为部分实现并把缺的告警通道单列 |
| U25 | NFR-2 应答 < 10 秒 | 部分实现 | **维持** | 应答路径上是同步 await：`apps/server/src/http/webhook-v21.ts:1029-1037`（`insertMessage` 落库）与 `:1057-1067`（`addEyesReaction`，只有 try/catch 没有超时）。10 秒护栏不存在 |
| U25 | NFR-6 可追溯三线 | 已实现 | **维持** | 三线都有落库点，出口是 `/api/tasks/:id`（`packages/contract/src/api.ts` 的 usage 字段）+ `queries/audit.ts`。B 的「面板单屏拿不到用量」是展示问题，不构成三线缺失 |
| U26 | AC-2 两轮对话完整 | 已实现 | **维持** | 逐条领消息 `apps/server/src/agent/store.ts:124-139`、会话复用 `app/compose.ts:444-478`。`item.delta` 不落库属渲染过程，算进「完整对话」会让几乎所有条目都不成立，CHECK-4 的口径订正站得住 |
| U26 | AC-7 三级事件按到达序 | 已实现 | **维持** | `apps/server/src/agent/store.ts:106-115`（`ORDER BY MIN(created_at)`）、`:124-139`（`FOR UPDATE SKIP LOCKED` + `NOT EXISTS(running)`）。同 issue 串行由这两条 SQL 保证，不依赖内存 |
| U27 | AC-18 角色清单 | 部分实现 | **维持** | `apps/server/src/trigger/roles.ts:69-72`（`allowRoles.length === 0` → `allowed: true`）、`apps/server/src/trigger/decide.ts:188-199`；契约只校验引用的名字存在（`packages/contract/src/repo-config.ts:293-305`），空清单合法 → 开启限定角色却空清单时全放行 |
| U27 | AC-23 沙箱回收 / 重开复用 | 部分实现 | **推翻 → 已实现** | CHECK-4 的取证是「`apps/server/src/sandbox/` 全目录 `removeContainer|destroySandbox|sandboxRemove` 0 命中」——**模式写错了**：真实 API 叫 `destroyContainer`。`apps/server/src/sandbox/docker.ts:52,216-221`（`container.remove({force:true})`，404 幂等）、`apps/server/src/sandbox/lifecycle.ts:283-310`（`dispose()`：inspect → destroy → 清端点）、`apps/server/src/jobs/lifecycle-sweep.ts:291-308`（定时把到点/超水位的容器再回收一次）、停机兜底 `apps/server/src/app/compose.ts:1583-1586`。重建侧是每任务建容器 `apps/server/src/worker/run-task.ts:740`，会话侧 `app/compose.ts:1188` 只改 `state/sandbox_id/closed_at` 保留 `session_id`。三个子条件都有代码事实，判部分实现偏严且理由失效 |
| U27 | AC-24 压缩后仍能复述 | 未实现 | **维持** | `compactor` 全仓仅 `app/compose.ts:881` 注入 + `worker/run-task.ts:202` 声明，无调用（已亲自复核）。A 的「无法判定」把举证责任推给真模型，而缺的是静态调用点 |
| U28 | Q-3 会话无结束状态 | 与需求冲突 | **维持，且比 CHECK-4 说得更实** | `apps/server/src/app/compose.ts:1311-1338`（`!v21SessionEventActive && archiveSessionId !== null` → `sessionArchive`）；轮换计划 `:450-463`（turns≥30 或 age≥7 天 → `archiveSessionId`）；`v21SessionEventActive` 只在 `input.sessionEvent` 存在时置真（`:1195-1207`）。**队列 job 路径不传 `sessionEvent`**，所以 v2.1 事件任务跑到 30 轮会真的归档——不是「只剩 legacy v0.3」这一条路，而是 v2.1 主力路径的守卫在队列路径上失效 |
| U28 | Q-6 不维护技能注册表 | 与需求冲突 | **维持** | `apps/server/src/skills/registry.ts` 存在并经 `skills/index.ts:17,23` 导出；`apps/server/src/agent/message.ts:163` `eventSkillsOf(settings, templateId)` 就是「事件/模板 → 技能集合」那张表。补注：`eventSkillsOf` 的生产调用点在 `agent/message.ts:272`（`composeAgentMessage`），其唯一生产调用方是 `http/webhook.ts:1579`（v0.3 路径），v2.1 webhook 不走它——结论仍成立（注册表本身在平台代码里），但 CHECK-4 的证据链**只覆盖 legacy 路径**，措辞应收紧 |
| U28 | Q-9 面板内发送不做 | 部分实现 | **维持** | `apps/panel/src` 全量检索 `sendMessage|发送` 命中 0，会话流底部无输入区；需求 1437 要求「输入区只呈现形态、发送按钮禁用」，这半个形态不存在 |
| U29 | TERM-5 模板 | 部分实现 | **维持** | 两套渲染器：`packages/contract/src/settings-v21.ts:473` `DEFAULT_EVENT_TEMPLATES`（事件模板）与 `apps/server/src/agent/message.ts:229,273,299` `renderTemplate(AGENT_MESSAGE_TEMPLATES[…])`（agent 消息模板，`AgentTemplateId = opened/edited`） |
| U29 | TERM-6 占位符 | 已实现 | **推翻 → 部分实现（B 正确）** | 单花括号语法**确实存在**：`apps/server/src/agent/message.ts:220` `SINGLE_PLACEHOLDER = /^\{([A-Za-z_]+)\}$/u`、`:234-254`（整行单占位符替换 + 行内 `/\{([A-Za-z_]+)\}/gu` 替换），变量名如 `{skills}`/`{catalog}`/`{project_prompt}`。CHECK-4 在 `skills/`、`contract`、`assemble.ts` 三处检索没命中，结论却写成「B 的该条证据不成立」并计入 STALE 口径订正——**检索范围漏了 `agent/`**，这是把「我没找到」当成「不存在」。占位符在本仓有两套语法，术语不唯一 |
| U29 | TERM-8 写回 | 部分实现 | **维持** | `apps/server/src/git/writeback.ts`、`git/writeback-gate.ts` 与 `github/executor.ts` 的 6 类写动作并存（`executeComment/executeLabelPlan/executeCreateIssue/executePushBranch/executeOpenPr/executeCloseIssue` + reaction），与术语表 5 类不一致，且「写回」两义 |
| U29 | TERM-10 标签目录 | 已实现 | **维持** | 目录实体存在（`settings.labels.vocabulary` → `config/v21-settings.ts:249-258` → `writeback/v21/labels.ts`）。「与 GitHub 一致」是 BR-9 的功能要求，二次计入会重复扣分 |
| U29 | TERM-11 槽位 | 部分实现 | **维持** | `apps/server/src/skills/assemble.ts:151-159`（`SkillSlot` / `ProjectSlot`）把「槽位」用于装配层位置，与 `comment_slots` 两义 |
| U29 | TERM-12 提及关键词 | 部分实现 | **维持** | `apps/server/src/agent/message.ts:144`（`aliases` 入参）、`:296`（`stripAliases`），与 `comment.mentions` 两套并存且都在生产链路上 |

## 三、漏审检查

**条目数对齐（逐单元点名）**：按各单元 `A.md` / `B.md` 的标题数扣掉 4 个固定段落（结论速览 / 逐条 / 本节整体结论 / 核查边界）后核对：

| 单元 | A 条数 | B 条数 | CHECK 表中条数 | 结论 |
|---|---|---|---|---|
| U11 | 2 | 2 | 2 | 齐 |
| U12 | 14 | 14 | 14 | 齐 |
| U13 | 4 | 4 | 4 | 齐 |
| U14 | 5 | 5 | 5 | 齐 |
| U15 | 10 | 16 | 10 | 齐（A 把 6.1 聚成 5 条、6.2 逐条 5 条；B 把 6.1 拆成 a~k 共 11 条、6.2 拆成 a~e 共 5 条。CHECK-3 表内括号逐条标注对照，无遗漏，只是 B 的粒度更细） |
| U16 | 3 | 3 | 3 | 齐 |
| U17 | 5 | 5 | 5 | 齐 |
| U18 | 5 | 5 | 5 | 齐 |
| U19 | 4 | 4 | 4 | 齐 |
| U20 | 5 | 5 | 5 | 齐 |
| U21 | 3 | 3 | 3 | 齐 |
| U22 | 2 | 2 | 2 | 齐 |
| U23 | 12 | 12 | 12 | 齐 |
| U24 | 6 | 6 | 6 | 齐 |
| U25 | 6 | 6 | 6 | 齐 |
| U26 | 17 | 17 | 17 | 齐 |
| U27 | 16 | 16 | 16 | 齐 |
| U28 | 9 | 9 | 9 | 齐 |
| U29 | 13 | 13 | 13 | 齐 |

合计 U11-U19 = 52（CHECK-3 自称 52 ✔）、U20-U29 = 89（CHECK-4 自称 89 ✔）。**没有条目被整条漏掉**，两边也没有「A 有 B 无」的条目。

**但 CHECK-3 的抽样记账不可复核**，三处要改：

1. **数字对不上**：自称「36 条收敛里抽验 14 条，其余 22 条未抽」，而第 260 行的未抽验清单只点名 **19 条**，差 3 条无归属。
2. **同一批条目被两处同时声明**：`FR-6.2`（抽验表第 235 行 `queries/issues.ts:951` ↔ 第 260 行「U13 的 FR-6.2/6.4 部分证据」）、`FR-7.1`（第 238 行 `routes.tsx:55-59` ↔ 「U14 的 FR-7.1」）、`CC-2`（第 244 行 `settings-v21.ts:182-184` ↔ 「U19 的 CC-2」）三项**既算抽验又算未抽验**。这正好解释了第 1 条的 3 条差额。
3. **「14 条」本身偏高**：按抽验表 15 行逐行归属，能明确落到某个收敛条目上的只有 11 条（FR-4.1、FR-4.2、FR-6.1、FR-6.2、FR-6.3、FR-7.1、6.2-2、PH-2、EX-4、LD-3、CC-2；另 1 行 FR-7.4 是分歧条目）。真实未抽验量约 25 条，不是 22。

这三处不影响单条裁决的对错，但会让「未抽验面有多大」被系统性低估——`FR-5.2`、`FR-5.5`、`TOOL-3`、`6.1-B`、`LD-1`、`LD-2`、`CC-3`、`CC-4` 这 8 条在抽验表里找不到归属，却只有部分进了第 260 行的残余清单。

CHECK-4 侧的记账是清楚的（15 行抽验表、逐条带 `file:line`、STALE 分条列出），唯一缺陷是「口径订正 1」把一条**真实存在**的代码当成不存在（见 TERM-6）。

## 四、对「整节未实现」结论的抽验（U21 / U22）

抽了 U21 的 2 条与 U22 的 1 条，结论：**U21 的「完全没有」成立，U22 的「完全没有」在个人 PAT 上成立、但在「整条判未实现 vs 部分实现」上有争议**。

1. **U21 CFG-8.1 供应商记录 = 完全没有**（维持）。凭据表只有 `apps/server/src/db/schema.ts:514` `host_credentials`；供应商信息只有 env 三元组 `apps/server/src/app/config.ts:173-175,410`（`model.baseUrl/name/apiKey`）与 `app/model-env.ts:13-15` 的别名表。没有「供应商」实体，也没有多供应商并存选择。这是「有部署参数、无实体」的典型，不是半实现。
2. **U21 CFG-8.2 模型角色四档 = 完全没有**（维持）。角色相关词在契约、配置、运行时三层 0 命中；价目是代码常量 `apps/server/src/cost/pricing.ts:27-41`（两档 `flash/pro`，只按模型名分档，与「四档业务角色」无关），`agentExecutionSchema` 无 model 字段。没有「一半」。
3. **U21 CFG-8.3 全局默认 + 项目覆盖 = 未实现（维持，但请与 CFG-9.1 统一口径）**。`repos.settings.model` 字段存在（`packages/contract/src/repo-config.ts:219-220`）却零消费方：全仓模型名实际只来自 `apps/server/src/app/config.ts:173,410` 的部署配置。严格说这条是「全局默认（部署 env）有、项目覆盖无」，与 CFG-9.1 判部分实现用的是同一把尺子却得出相反结论——两根尺子必须选一根。本复核选择「部署级默认不算本条实现」：CFG-8.3 维持未实现，CFG-9.1 改判未实现。
4. **U22 CFG-9.1 面板身份 = 个人 PAT 完全没有**（三态：表 / 列 / 契约 / API / 面板五处均 0，复核通过）。争议只在分类，见第二节。
5. **U22 CFG-9.2 三态与退回 bot = 完全没有**（维持）。`X-OAuth-Scopes` / `getAuthenticated` / `personalAccessToken` 全仓 0 命中，`github-auth.ts:21` 的四种模式里没有「用户身份」这一档，失败退化为 `degraded`，与需求「scope 不足/过期要显式呈现并退回 bot」不是同一件事。

## 五、结论

- **分歧裁决**：维持 **30** 条 / 推翻 **4** 条 / 存疑 **1** 条。推翻的四条：
  1. **U12 TOOL-5**（已实现 → 部分实现）：审计查询用的是裸 `e.kind='approval'`（`queries/audit.ts:78`），归一化视图只在任务详情用（`queries/tasks.ts:476`），`/api/audit` 的审批列恒 null。
  2. **U29 TERM-6**（已实现 → 部分实现）：`agent/message.ts:220,234-254` 确有 `{名字}` 单花括号占位符；CHECK-4 的「检索无命中」是漏了 `agent/` 目录。
  3. **U22 CFG-9.1**（部分实现 → 未实现）：个人 PAT 五处 0 存在，面板侧无任何 GitHub 写回；(a) 子条件不是「已实现的分支」而是系统唯一事实，且与 CFG-8.3 判未实现的口径冲突。
  4. **U27 AC-23**（部分实现 → 已实现）：取证模式 `removeContainer|destroySandbox|sandboxRemove` 漏掉了真实 API 名 `destroyContainer`（`sandbox/docker.ts:52,216`、`sandbox/lifecycle.ts:287-290`、`jobs/lifecycle-sweep.ts:291-308`）。
- 存疑 1 条：**U23 BR-7**（已实现），无 App 凭证的部署上失败是静默的（`app/compose.ts:785-792`），「后台告警」这一选项全仓无落点。
- **补验**：CHECK-3 未抽验的 7 条全部维持，无方向性错判。
- **漏审**：U11-U19 的 52 条与 U20-U29 的 89 条一个不缺；缺陷只在 CHECK-3 的抽样记账（自称 14/22，实为约 11/25，且 3 条被同时列入两处）。

**最需要重做的一条**：**U12 TOOL-5**。它不是分类松紧问题，而是 CHECK-3 用了一个在目标查询里不生效的归一化视图作为反证，把一个「写得进去、查不出来」的审计缺口判成了已实现；同一个文件的 `queries/audit.ts:58` 上还有 TOOL-6 的白名单问题，两处叠起来意味着**面板审计页对 v2 写回与审批判定两条线都读不到**——这是本节最需要修的实现缺口，而不是记账口径。

其次是 U29 TERM-6：它已被写进 CHECK-4 的「STALE / 口径订正」清单，若不撤回，会让后续审计误以为单花括号语法不存在。
