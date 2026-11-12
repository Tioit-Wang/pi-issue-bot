# Issue 处理平台 v2.1 · 静态审查与需求逐项校验汇总

> **最终结论见 §5**（集成落地后由主理人增量复核）。§1–§4 是 7 份审查报告在 `f4e04b0` 集成前快照上的原始结论，保留原貌以供追溯，不代表最终态。
>
> 取证基准：HEAD=`f4e04b0`（远程 jobs 已并入）。本文件汇总 **1 份静态代码审查** + **7 组需求实现审查机器人** 的结论，用于结果追溯。
> 门禁基线：`pnpm -r typecheck` 6/6 全绿；`pnpm -r test` 1076 passed / 229 skipped / 3 failed（3 个真失败与 25 个失败文件根因均为本机无 PostgreSQL，`ECONNREFUSED 127.0.0.1:5432`；本机 `psql`/`pg_ctl`/`docker` 均不可用、5432 未监听，属环境性失败，非代码缺陷）。
> **时效声明**：审查取证时 WS6 集成尚未落地，所有「孤儿模块」判定是当时快照；WS6 落地后由 R2/R4/R5 定向复核，本文件不把快照当最终结论。

---

## 1. 静态代码审查（software-qa-engineer）

**IS_PASS: NO**。理由：6 项 P0 语义与冻结契约直接冲突，且 WS1–WS4 新模块在生产代码里零 import，当前 HEAD 只是「可编译的零件」。

### 已核对通过
- §1 配置默认值逐项一致（5 事件开关与附加默认、4 闸门、AgentExecution 6 项、目录 managed/status 默认）；`V21_DEFAULTS` 单一出口；面板 mocks 从它展开。
- zod schema ↔ `migrations/0011_v21.sql` 列名/类型/默认值一致；`ALL_TABLES` 含 `commentSlots`/`agentCompactions`；`db-schema.test.ts` 有断言。
- 跨字段 7 条校验在 `repo-config.ts:268-340` 生效；`execute.ts:233-247` 后三类开关执行前整份拒绝；`:276-291` 顺序执行遇失败即停；`v21.ts:284-330` 未知 type 整份拒绝 + 字段级路径。
- `compact/thresholds.ts:90-98` 双阈值公式与契约逐字一致；`session-state.ts:19` 只有 active/idle、无 ended；`render.ts:189-203` 一次遍历语义正确；`mention.ts` FR-2.5 四条示例全通过。
- WS5 面板 4 个 section 已接入 `repo-settings.tsx` / `nav.ts` / mocks / 测试。

### BLOCKER（6 条）

| # | 文件:行号 | 问题 | 依据 |
|---|---|---|---|
| B1 | `writeback/v21/execute.ts:607-612` | `close_issue` 只判顶层 `verdict==='fail'` 就关单，无「确定性关闭条件」；`verdict` 是模型自评，等于把「不采信模型自评」实现成「采信模型自评」，且 fail 时关单语义相反、动作不可逆 | FR-5.3 / 契约 §5 |
| B2 | `writeback/v21/comments.ts:98-114` + `execute.ts:52,425-431` | 槽位标记可被任意人伪造：`SlotComment` 不返回作者，`findSlotComment` 只按注释标记匹配，会把他人评论当 bot 槽位去 update（覆盖他人评论 / 403 中断整份产出）；`composeSlotBody` 不剥离正文里已有的 `pi-bot:slot` 标记 | 契约 §5 / FR-5.3 |
| B3 | `trigger/decide.ts:283,288,294,320` | `on`/`off`/`conditional` 三态退化为两态：只判 `off`，其余一律跑条件与闸门，`on` 与 `conditional` 行为相同；面板已把三态暴露给用户，改了等于没改 | 契约 §1/§2 / FR-2.1 |
| B4 | `settings-v21.ts:87,329` + `v21-settings.ts:107` + `decide.ts:210` | `only_body_changed` 默认 true 在「显式配置 issues.edited 但不写该字段」时丢失（`.optional()` 无 `.default()`，prefault 不生效 → `undefined` → `=== true` 判 false），导致只改标题/标签也触发 | FR-2.1 / 契约 §1 / BR-8 |
| B5 | `trigger/roles.ts:70-72` + `repo-config.ts:301-309` | 角色闸门 fail-open（越权）：`require_role=true` 且 `allow_roles=[]` 是合法可保存配置，却直接放行所有人 | FR-2.4 / §6.6 / 契约 §2 |
| B6 | `writeback/v21/labels.ts:140-147` + `execute.ts:361-363` | 「空集 + `clear!==true`」实现成 `throw`，按「遇失败即停」中断整份产出并触发兜底；契约明写是 `no-op` | BR-9 / FR-5.4 / 契约 §5 |

### MAJOR（8 条，摘要）
1. `roles.ts:55-59` 按 login 字符串匹配，未用 GitHub user id（login 可改名/被占用 → 权限外溢）。
2. `repo-issues.ts:163-174` `invalidate()` 不清 inflight，失效后第一次 render 命中旧在途 Promise 拿旧数据。
3. `repo-issues.ts:30-35` lister 无 sort/direction，`MAX_PAGES=2` 只取前 200，无法兑现「按更新时间倒序截断」。
4. `execute.ts:308-325` `runAction` 无 default / 无运行期 `isOutputActionType` 复检，WS6 若漏校验会把非法 type 静默当成功。
5. `execute.ts:395-407` 删除留痕的 bot/human owner 只拼进 detail 字符串，`ExecuteV21Result` 无 `audit` 字段，集成层无法结构化落库。
6. `execute.ts:564-566` `create_issue` 配额用尽 `throw` 中断整份产出；契约要求「不执行并记录」。
7. octokit 无 `openPullRequest` / `listIssues`：`open_pr` 动作与 `{{repo.issues}}` 在生产无数据源。
8. `v21-settings.ts:66-73` 用形状层解析不跑 superRefine，运行期非法配置仍 `ok:true`；`execute.ts:549-558` dry-run 仍调有副作用的 `createIssueGuard`；`MAX_OUTPUT_ACTIONS=20` 未与 `limits.max_actions_per_run`（默认 8）取小。

### MINOR / NOTE（摘要）
`repo-issues` 截断说明 M 硬编码、缓存键未大小写归一、`render.ts` 连字符占位符不进 unknown、同步 `repoIssues` 重复调用、`mention.ts` 分隔符白名单把 `@` 既列为分隔符又列为禁区、角色重名校验大小写口径不一致、面板 mocks `on_opened/on_edited` 仍是旧坏值 `format-check`、`packages/envelope/src/index.ts` 头注释过期。
契约内部措辞冲突：§5「空集 + !clear → no-op」与 `v21.ts:140`/`labels.ts:140` 注释「= 拒绝」；§5「目录外 → 不删不加」与 `labels.ts:163-176` 对 desired 侧整批拒绝。

### 测试缺口（最关键）
1. `writeback-v21-execute.test.ts` 全文无 `label`/`desired`/`clear`/`catalog` 字样——BLOCKER B6 藏身处。
2. `on` vs `conditional` 行为差异零用例；「显式配置 edited 不写 only_body_changed」零用例（B3/B4 盲区）。
3. 槽位标记伪造 / 评论作者归属零用例（B2 无护栏）。
4. `writeback-v21-execute.test.ts:283-320` 标题「不采信模型自评」，断言却是 `verdict=fail → 允许`；`:359-375` 断言 `quota → 失败并中断`，与契约相反——**两处把错误行为钉成断言，修实现必须同步改测试**。
5. `no-dead-workflows.test.ts` 只防旧流水线复活，**不检查新模块是否被装配**，无法捕获本轮 18 个孤儿模块。建议补源码级装配护栏。

---

## 2. 需求逐项校验（7 组审查机器人）

| 组 | 范围 | 统计 | 核心结论 |
|---|---|---|---|
| R1 | FR-1.1~1.4 | 已实现 2 / 部分 2 / 冲突 2 | FR-1.1 单一入口+原始体+三头+四类事件、FR-1.3 持久层去重已实现（真 PG 测试 + 生产 import 齐备）。FR-1.2 缺签名头 401 不留痕（`http-webhook.test.ts:223-235` 把「不写任何行」固化为断言）、非 JSON 400 不留痕；FR-1.4 handler 在 200 前同步 `await` GitHub 写（eyes / 拒绝回复）且无超时保护，与「10s/异步/不写 GitHub」冲突，被 `:287-304` 当特性固化 |
| R2 | FR-2.1~2.5 | 部分实现（孤儿模块） | `trigger/**`、`prompt/**` 生产零 import；`decideEvent` 产出 template 与 `renderTemplateAsync` 无生产消费方；`RenderResult.unknown` 无告警消费方；`createRepoIssuesProvider` 无注入点。**配置层 `settings-v21.ts` 不是孤儿**（被 `repo-config.ts` 生产 import，superRefine 生效） |
| R3 | FR-3.1~3.5 | 已实现 2 / 部分 3 / 冲突 3 | FR-3.1 一对一映射、FR-3.3 同 issue 串行跨 issue 并行已实现。FR-3.2/3.4 冲突：`compose.ts:220,249-263,958-983` 真实 `sessionArchive` + turns/age 轮换新建会话；FR-3.4 `session-state.ts` 孤儿、0011 的 state/sandbox_id/closed_at 是死列、`issues.closed` 被白名单挡掉。FR-3.5 冲突：`canonical-text.ts` 强归一化把措辞不同判重复（需求要「不语义近似」）、`ON CONFLICT DO NOTHING` 对 failed 行照吞（需求要「上一轮失败放行」）、跳过无持久化留痕、事件级去重层缺失 |
| R4 | FR-4.1~4.2 | 部分 2 / 冲突 0 | 四段结构只在旧 `agent/message.ts:35-72` 私有 `{名字}` 模板里，无 `{{issue.url}}` 链接段；项目模板字段形状已在配置链生效，缺口精确在「模板内容 → 渲染 → 下发」执行层。FR-4.2 两边模板都整篇重发正文（P1） |
| R5 | FR-5.1~5.6 | 已实现 0 / 部分 6 / 冲突 6 | v2.1 产出契约、七类执行器、标签目标态、压缩引擎代码质量与单测断言方向全部正确，但**全是孤儿模块**。6 处冲突：技能注册表+按命令硬编码 outputs（FR-5.1）、失败继续下一个（FR-5.3/5.5）、agent 路径未分流 7-action（FR-5.3）、`planLabelDelta` 只删自己打的（FR-5.4）、`humanVetoed` 人删过永久否决（FR-5.4 / 已废除的 BR-11）、不合契约仍发兜底评论（FR-5.5，倾向视为允许例外）。FR-5.6 **孤儿引擎**：八小节算法与六阶降级单测完备，但 `driveTurn` 发请求前后无任何压缩触点，`MessageLike` 适配、`windowTokens` 取值、两档收尾提醒、`new_context` 均未实现 |
| R6 | FR-6.1~6.4 | 已实现 1 / 部分 3 / 冲突 1 | **FR-6.1 已实现**（唯一全绿项）：会话记录由执行侧 RACP 事件流生成（`run-task.ts:420-428` → `run-store.ts:40-45`，cursor 保序），`run-task.ts:701` 明确拒绝 agent 自述的 `envelopes.usage`。FR-6.2 缺 5 项字段：耗时、命令类 argv、退出码、独立返回摘要、完整可展开入参（`IssueToolCall` 契约只有 name/summary/at/ok；`sandbox/protocol.ts:24,31` 的 exec 线协议**有** argv/exitCode 但只用于容器级失败分类，没记录进工具调用层）。FR-6.3 缺「按 issue」聚合，`IssueTurn` 契约无 costUsd/durationMs 导致会话详情单轮成本恒空。FR-6.4 四种视图①②④可达、③「事件时间线」名不副实（`EventTimeline.tsx` 实为首页写回动作流，不含投递/判定/执行分段，被忽略事件因不建 task 永远不出现）。**冲突 C1**：`task-detail.tsx:289` 把 agent 自述的 `envelope.usage` 当 token/成本展示，同页并存「真值 usage_costs」与「自述 0」两套管账。判定原因与压缩记录**均无写入侧也无展示位** |
| R7 | 第 6/7/8/10 章 | A 已实现 1/部分 5；B 部分 10/冲突 2；C 已实现 2/部分 4/未实现 1；D 18/25 | **AC 覆盖 18/25（含部分 21/25）**，未覆盖 AC-2 / AC-12 / AC-16 / AC-20，AC-24 仅人工。**BR-11 冲突**：新语义只在孤儿 `writeback/v21/labels.ts`，生产链路 `compose.ts:842` → `worker-deps.ts:566` → `worker/writeback.ts:190-199` → `workflows/normalize.ts:215-218` 仍是「人删过永久否决」，且 AC-15 验收项也是旧语义 → **需求文档内部三处对立（FR-5.4/BR-11 ↔ AC-15），需拍板，非实现问题**。C2 数据保留天数 `jobs/retention-cleanup.ts:25` 硬编码 90，不读 settings。A4 目录漂移显性化、A5 login id 兜底、A6 触顶行为均无执行代码；`compose.ts:482-499 REQUIRED_TABLES` 未含两张新表。AC-16 无 v2.1 用例（旧路径 `e2e-envelope-invalid.test.ts` 是 dry-run + 4-intent，不等价） |

### 审查口径更正（R1 / R3 / R5 / R6 / R7 交叉复核后采纳）
1. **BR-6 归 R7 横向审查**，不归 R2；`0011_v21.sql` 注释误挂 FR-2.1，需求正文留痕在 BR-6。R2 的 FR-2.1~2.5 判定不受影响。
2. **根因归并**：R3/R5 双向确认 `agent/session-state.ts`（FR-3.4）与 `compact/*`（FR-5.6）是同一根因（WS6 装配层未挂载），汇总时收敛为**一条 P0 总根因「WS6 端到端未接线」**，不拆成 7 条独立缺口。
3. **分层澄清**：`packages/contract/src/settings-v21.ts` **不是孤儿**（`repo-config.ts:27-36` 生产 import，superRefine 生效）；`config/index.ts:57-72` 仅 barrel re-export、不算生产消费；`agent/message.ts:229` 是 v0.3 私有 `{名字}` 渲染器，不是 §6.3 的 12 占位符渲染器。
4. **行号均为读取时点快照**：WS6 集成期间 `run-task.ts` / `webhook.ts` / `webhook-v21.ts` 被并发改写，`webhook.ts` 短路点从 `:979` 漂到 `:981`、压缩注释从 `:414-417` 漂到 `~:455`。所有行号按快照理解，定性结论不受影响。
5. `agent_compactions` 表定义是 `db/schema.ts:788-812`（`:759` 是 `commentSlots`），`migrations/0011_v21.sql:45-59` 无误。

### 孤儿模块清单（18 个，生产零 import）
`writeback/v21/{index,execute,labels,comments}.ts`、`trigger/{decide,mention,roles}.ts`、`prompt/{render,repo-issues}.ts`、`compact/{engine,store,summary,thresholds,tokens,truncate}.ts`、`agent/session-state.ts`、`packages/envelope/src/v21.ts`（仅 barrel 导出）、`config/v21-settings.ts` 的 `resolve*`（仅 re-export）。
死列：`agent_sessions.state/sandbox_id/closed_at`、`webhook_deliveries.decision/decision_reason`。

---

## 3. 修复分工与时序（避免与 WS6 并发撞文件）

WS6 已拆为两个文件组不重叠的执行者并发落地：
- **WS6-A**：`http/webhook.ts` + 新增 `http/webhook-v21.ts` + `test/v21-webhook-integration.test.ts`（判定留痕、模板渲染、unknown 告警、repoIssues 惰性注入、PR 留痕）
- **WS6-B**：`worker/run-task.ts` + `app/compose.ts` + `app/worker-deps.ts` + `test/v21-worker-integration.test.ts`（v2 产出分流、七类写回、会话状态、压缩事件落库）

据此分两批修复：

**第一批（与 WS6 并行，约束：不改任何导出名/签名、不碰 WS6 的 6 个文件）**
- 修复组 A（`software-engineer-3`）：B2、B6、MAJOR 4/6/7/8 中的内部逻辑；`github/octokit.ts` 补 `openPullRequest` / `listIssues`；同步修正 2 处反向测试断言。
- 修复组 B（`software-engineer-1`）：B3、B4、B5，MAJOR 1/2/3，`prompt/render.ts` 与 `repo-issues.ts` 的 MINOR，面板 mocks 旧值。

**第二批（WS6 落地后，允许改接口形状）**
- B1 `closeCondition` 入参、MAJOR 5 `ExecuteV21Result.audit`、MAJOR 8 `maxActionsPerRun` —— 都涉及 `ExecuteV21Input` / `ExecuteV21Result` 形状变更，必须等 WS6-B 调用代码稳定后再改，否则双向返工。
- 补「新模块必须被装配」的源码级护栏测试（`no-dead-workflows.test.ts`）。
- R2 / R4 / R5 按新磁盘状态定向复核。

**已知不可在本机修复**：25 个失败文件 / 3 个真失败需 PostgreSQL，本机无实例，只能如实标注。

---

## 4. 契约自身待拍板（不阻塞开发，但需口径统一）
1. §5「空集 + !clear → no-op」vs `v21.ts:140` / `labels.ts:140` 注释「= 拒绝」——按需求 BR-9/FR-5.4 应为 **no-op**（B6 依此判定）。
2. §5「目录外/含义空/managed=false/retired → 不删不加」——精确化为「current 侧不删、desired 侧整批拒绝」。
3. `resolveAgentExecution` 用「或」合并 `agent.actions` 与 `limits.actions`，扩大授权面；建议改为显式优先级。
4. FR-5.5「不合契约时评论保持原状」与「失败必须有兜底反馈」的张力：兜底评论不占槽位且为需求明确要求，倾向视为允许例外，但需王哥确认口径。

---

## 5. 最终执行结果（集成落地后复核，2026-11-12 14:25）

### 5.1 五步流程完成情况

| 步骤 | 状态 | 产物 |
|---|---|---|
| 1 梳理现状与需求要点 | 完成 | 现状差距表（6 个需求域）、26 条 FR / 12 条 BR / 25 条 AC 编号清单 |
| 2 开发计划与并发调度 | 完成 | `docs/v21-contract.md`（接口冻结 + 文件归属矩阵）、任务板 17 项 |
| 3 分派多子代理并行实现 | 完成 | WS0–WS6 共 9 个实现子代理，文件组不重叠并发 |
| 4 静态代码审查并汇总问题 | 完成 | §1（IS_PASS: NO，6 BLOCKER / 10 MAJOR / 8 MINOR）、`apps/server/test/writeback-v21-*.test.ts` 39 例有效性复核 |
| 5 需求小结 + N 个审查机器人逐项校验 | 完成 | `docs/v21-requirements-summary.md` + 7 组机器人（R1–R7）逐条判定表、交叉互证与勘误 |

### 5.2 最终门禁（本次实跑，非子代理转述）

| 项目 | 结果 |
|---|---|
| `pnpm -r typecheck` | **6/6 工作区全绿，0 error** |
| `pnpm -r test` | **1157 passed / 229 skipped / 3 failed**（111 文件：84 passed / 25 failed / 2 skipped） |
| 3 个真失败 | 全部 `ECONNREFUSED 127.0.0.1:5432`：`agent-skill-wiring.test.ts`（1）、`http-cli.test.ts`（replay + migrate 2）。本机 `psql`/`pg_ctl`/`docker` 均不可用、5432 未监听，**环境性失败，非代码缺陷** |
| v2.1 集成测试 | `v21-integration`(13) + `v21-webhook-integration`(13) + `v21-worker-integration`(16) = **42/42 全绿** |
| 新增模块合计 | WS1/2/4 复跑 204 例、WS3 补测 39 例、面板 198 例、契约包 123 例，均全绿 |

**本轮收口修复（2 处，均为一致性问题）**：
1. `apps/server/test/v21-integration.test.ts:188` 断言过期 —— `v21DecisionRowOf` 已改为触发侧也写 `enabled`，断言仍期望 `null`。已改为 `'enabled'`（BR-6 要求每次判定都留原因）。这是修复前唯一一条非 PG 真失败。
2. `apps/server/src/db/schema.ts:113-118` 注释漂移 —— 原写「触发时为空」且只列 11 个未触发 reason；已改为「触发与未触发都写」，补齐 `enabled` / `conditional-met`。

### 5.3 集成落地后的接线复核（推翻部分快照结论）

WS6-A（webhook 侧）与 WS6-B（执行/会话侧）已落盘并通过 42 例集成测试。**§2 各表的「孤儿模块 / 运行时未启用」判定是集成前快照，现按当前磁盘增量复核如下**：

| 复核项 | 最终状态 |
|---|---|
| `deps.v21` 注入 | **已真实注入 2 处**：`app/compose.ts:955`（webhook deps）、`:1375`（runTask deps，含 settings/reactions/openPullRequest/compactionStore）→ 快照期「全仓 `v21:` 0 命中、dead branch」结论**已失效** |
| 生产 import 图 | `decideEvent` 3 文件、`renderTemplateAsync` 2、`createRepoIssuesProvider` 3、`parseOutputV21Json` 2、`executeV21` 4、`planSessionOnEvent` 3、`createCompactionStore` 4、`writeV21Decision` 2 —— 均非 test 文件 |
| 判定留痕 BR-6 | `webhook.ts` 外层包装在**所有 early-return** 后统一写 `decision/decision_reason`，未触发也写；投递级重投加 `skipDecision` 防覆写 |
| 模板渲染 FR-2.2/4.1 | 项目模板与内置默认模板都过同一个 `renderTemplateAsync`；`issues.labeled/closed` 走独立 v2 分支，不再被 v0.3 `decideWebhookTask` 丢弃；四段顺序有测试钉住 |
| 未知占位符告警 | `reportV21UnknownPlaceholders` 结构化 `logger.warn({unknown, event, repo, deliveryId})` |
| `{{repo.issues}}` | `needsRepoIssues` 惰性 + WeakMap 复用 provider（修掉「每次投递新建、5min 缓存形同虚设」）；`createV21OpenPullRequest` 已实现（**快照期「全仓无实现」结论失效**） |
| v2 产出分流 | `probeV21Output()` 三态（valid / rejected / not-v21），整份拒绝不回落旧信封；`source='command'|'pipeline'` 走旧 4-intent，零回归 |
| 会话状态 FR-3.4 | create / recycle / reuse 三条 SQL，**无 DELETE、无 archive**；关闭只回收沙箱并置 idle，重开复用 |
| 七类动作 | `executeV21` 接入 `createV21PortFromGithub` + `resolveManagedCatalog` 全量目录 + `resolveAgentExecution().actions` 开关 + `labels.max_per_issue` |

### 5.4 最终审查结论

**静态审查：IS_PASS: NO（不撤回复核结论）。** 接线完成不等于语义正确，6 条 BLOCKER 与需求内部冲突与接线无关，仍成立：

| 类别 | 数量 | 处置 |
|---|---|---|
| BLOCKER（未修） | 6 | `close_issue` 只信模型自评 `verdict`、槽位标记可伪造、三态开关退化、`only_body_changed` 默认丢失、角色闸门 fail-open、空集 no-op 实现成 throw |
| MAJOR | 10 + 复核新增 2（verdict 来源冲突、`slotStore.get` 无降级） | 含 `open_pr`/`listIssues` 能力缺口（前者已由 WS6 补上，后者待核）、dry-run guard 副作用、删除留痕无结构化出口 |
| CONFLICT（需拍板） | 1 | **FR-5.4 / BR-11 ↔ AC-15 需求内部三处对立**：「人工删除不构成永久否决」与「不会被自动加回」二选一；生产链路 `workflows/normalize.ts:215-218` 仍是旧 human-veto 永久否决语义。靠改代码无法同时满足 |
| 断言反向（未修） | 3 | `writeback-v21-labels.test.ts:52-60`、`writeback-v21-execute.test.ts:310-322` / `:359-376` 把与契约冲突的行为钉成正确断言，修 BLOCKER 时必须同步改 |

**需求实现：26 条 FR 中已实现 5 条 / 部分实现 21 条**（按集成前 7 组判定表统计：R1 2/2、R2 0/5、R3 2/3、R4 0/2、R5 0/6、R6 1/3；集成落地后部分条目可上调，但未整体重跑 7 份判定表，见 5.5 遗留）。12 条 BR 无一条达到严格「已实现」口径，AC 覆盖 18/25（含部分 21/25），未覆盖 AC-2 / AC-12 / AC-16 / AC-20。

需求编号经 `grep` 核实为 **FR 26 / BR 12 / AC 25**；此前多处转述的「27 条 FR」是口误，已统一修正。

### 5.5 遗留问题（按优先级）

| # | 问题 | 性质 |
|---|---|---|
| 1 | **FR-5.6 请求发出前自动压缩未接通**：`compactSession` 引擎 + 六阶降级 + 单测完备，但 `packages/racp-client` 无 session/history/compact 操作，本轮只做到「host 报出的 compaction 事件落 `agent_compactions`」 | **架构缺口，需产品/架构决策**，非补 import 可解 |
| 2 | 6 条 BLOCKER + 3 处反向断言 + 1 条需求内部冲突 | 语义缺陷，需单独一轮修复 |
| 3 | **FR-6.4③ 事件时间线 / 判定原因 / 压缩记录无展示位** | R6 判据：**写入 + 展示位双落地**才上调；当前写入侧已接，query/API/面板仍无消费，仍判部分实现。最小改动是 `queries/audit.ts:85-102` 加一列 + `audit.tsx` 加一格，但要覆盖「被忽略投递」必须以 `webhook_deliveries` 为主表新建视图 |
| 4 | 旧链路语义并存未清理：`humanVetoed` 永久否决、sessionArchive 轮换、`planLabelDelta` 只删自己打的标签 | 需与需求拍板结果一起处理 |
| 5 | FR-4.2 首次全量/后续增量（P1）、FR-6.2 工具记录 5 字段、FR-6.3 按 issue 成本聚合、`IssueToolCall` 契约扩展 | 明确未实现 |
| 6 | 7 份判定表未整体重跑；AC-2/12/16/20 无用例；`no-dead-workflows.test.ts` 无「新模块必须被装配」护栏 | 验证与测试缺口 |
| 7 | 25 个 PG 依赖测试文件本机不可跑 | 环境限制，需在带 PG 环境复跑 |
| 8 | `createIssueGuard`（指纹/配额闸门）、`slotStore`（comment_slots 索引）未注入生产 | 留了注入点，当前退化路径语义一致 |

### 5.6 交付文件清单（68 个工作区变更）

- 契约/配置：`packages/contract/src/settings-v21.ts`、`repo-config.ts`、`trigger.ts`、`index.ts`；`apps/server/src/config/{v21-settings,index}.ts`
- 触发/渲染：`apps/server/src/trigger/{decide,mention,roles}.ts`、`apps/server/src/prompt/{render,repo-issues}.ts`
- 产出/写回：`packages/envelope/src/v21.ts` + `index.ts`；`apps/server/src/writeback/v21/{execute,labels,comments,index}.ts`；`github/{types,octokit}.ts`
- 会话/压缩：`apps/server/src/agent/session-state.ts`；`apps/server/src/compact/{engine,store,summary,thresholds,tokens,truncate}.ts`
- 集成：`http/webhook.ts`、`http/webhook-v21.ts`（新增 546+ 行）、`app/compose.ts`、`worker/run-task.ts`、`app/worker-deps.ts`
- 面板：`components/settings/v21-{events,comment,catalog,agent,fields}-section.tsx`、`routes/repo-settings.tsx`、`layout/nav.ts`、`settings-chrome.tsx`、`mocks/handlers/repos.ts`
- 数据：`db/schema.ts`、`migrations/0011_v21.sql`；护栏 `test/no-dead-workflows.test.ts`
- 测试：新增 13 份（v21 / trigger / prompt / compact / writeback-v21 / session-state / 三份 integration / 面板），共约 300 例
- 文档：`docs/v21-contract.md`、`docs/v21-requirements-summary.md`、`docs/v21-static-review.md`
- 备份：`.workbuddy/backup-jobs-ws0/`（合并前本地 jobs 重建版，远程 f4e04b0 为准）

### 5.7 下一步建议
1. **先拍板 3 个口径**：BR-11/AC-15 二选一；契约 §5「空集 no-op vs 拒绝」；FR-5.5 兜底评论是否属「保持原状」的允许例外。
2. 开一轮 BLOCKER 修复，同步改 3 处反向断言，补 5 项测试盲区与装配护栏测试。
3. FR-5.6 需架构决策：扩展 RACP 客户端 session/history/compact 能力，或明确降级为非目标。
4. 在带 PostgreSQL 的环境复跑 `pnpm -r test`，消除 25 个环境性失败文件。
5. 集成冻结 commit 后统一重跑 7 份判定表并校准行号（所有审查行号均为读取时点快照）。
