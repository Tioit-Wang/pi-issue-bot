# P0-1 独立审查

## 结论

**有条件通过** —— 会话轮换确实被连根拔掉（归档调用、阈值常量、计划字段、写回分支、守卫变量全部消失），编译与相关用例自跑通过；但「上下文无限增长」的处置被写成了「有意取舍」，而需求 FR-5.6 原文禁止这种结果，必须升级为与 P0-5 同批上线的前置条件，不能记为遗留风险。

## 逐条核查

### 1 是否满足需求

- 结论：**满足**。FR-3.4 的三句话（不归档、不释放映射、重开复用）在代码层面都成立。
- 证据：
  - 轮换路径已无。`apps/server/src/app/compose.ts` 中 `planAgentSession()` 只剩三条规则（非 agent → `ephemeral`；无 id → 新建；有 id → `{mode:'persistent', sessionId, after?}`），`AgentSessionPlan` 只剩 `session` 一个字段，`executeTask()` 里那段 `channel.ops.sessionArchive(...)` 整块已删（现为 `:1268-1272` 的说明注释）。
  - 全仓 `sessionArchive` 剩余四个调用点，逐条核过，**没有一条能归档"issue 的常驻会话"**：
    - `apps/server/src/runtime/turn-driver.ts:433-443`：`if (!persistent)`，`persistent` 会话不归档；
    - `apps/server/src/runtime/turn-driver.ts:514-519`（`interruptAndArchive`）：`archive: !persistent`，同上；
    - `apps/server/src/worker/run-task.ts:1109-1123`：条件是 `usedPersistentRound && !firstRoundPersistent`，即"第 1 轮是 ephemeral、后续工具轮才建了会话"的任务内临时会话；agent 任务第 1 轮恒 `persistent` → 不进这一段；
    - `packages/racp-client/src/ops.ts:325` 只是 RACP 客户端方法，不是调用点。
  - `session_id` 的写入点只有两处：`apps/server/src/agent/store.ts:184-191`（UPSERT）与 `compose.ts:998-1012` 组装参数。`V21_SESSION_TRANSITION_SQL`（`compose.ts:273-286`）只写 `state / sandbox_id / closed_at`，**不碰 `session_id`**，与"关闭只回收沙箱、不释放映射"一致。
  - 全仓源码无 `DELETE FROM "agent_sessions"`（`db/schema.ts:659`、`compose.ts:670` 的命中都是表清单/自检），因此没有清理作业释放映射。
  - 需求原文核对：`docs/requirements.html:890`「创建后一直有效，不归档、不释放映射」、`:892`「issue 重开时直接复用原会话」、`:1903-1904`「会话本身不归档……重开时直接复用原会话」。修复方向与原文一致。

### 2 删除是否过度

- 结论：**不过度，且无残留引用**。
- 证据：
  - `AGENT_SESSION_POLICY` / `AgentSessionRotationReason` / `rotateReason` / `maxTurns` / `maxAgeDays` 在 `apps/`、`packages/` 的 TS/TSX 里**零命中**，只剩 `compose.ts:203`（解释为什么删掉的注释）与 `docs/audit/**`（历史审计文档，保留原样合理）。
  - 编译验证：`npx tsc -p tsconfig.json --noEmit`（apps/server）退出码 0，无输出 → 没有任何地方因删类型/删字段而挂。见"我实际执行的验证"。
  - `agent/constants.ts` 存在但不含任何 session 策略常量，没有第二处真相残留。

### 3 是否误伤他人改动

- 结论：**未误伤**。
- 证据：`compose.ts:911-912` 的两行 `panelDistDir` 注入原样在位，内容与语义未变：
  `// 面板静态资源（vite build 产物）：默认托管，PI_BOT_PANEL_DIR=off 时交给 Caddy。`
  `...(config.panelDistDir === null ? {} : { panelDistDir: config.panelDistDir }),`
  `git diff -- apps/server/src/app/compose.ts` 中除这一处（他人未提交改动）之外，其余 hunk 全部与 P0-1 相关，没有夹带格式化或无关重构。

### 4 是否引入新缺陷

- 结论：**核心写回逻辑没有新缺陷；两处低级问题见"发现的问题"**。
- 证据：
  - `turns`：`const turns = (params.session?.turns ?? 0) + 1`，单调递增，不再有"轮换那一轮归 1"的分支。旧行为里唯一会把 `turns` 打回 1 的路径随轮换一起消失，与面板/统计口径兼容。
  - `session_id` 不会被无端写成 `null`：`report.sessionId !== null ? report.sessionId : (params.session?.sessionId ?? null)` —— 只有"旧行本身就没有 id"（首轮失败）时才写 null，这比修复前更严格（修复前轮换那一轮会主动写 null）。核过 `saveAgentSessionRow` 的 SQL（`agent/store.ts:184-191`）：冲突时 `session_id = excluded."session_id"`，传什么写什么，没有额外清零。
  - v2.1 状态写回未受影响：`compose.ts:1154-1182` 的 `applyV21SessionTransition` 块完整保留，只删掉了 `v21SessionEventActive` 的声明与置位；`v21SessionEventActive` 现在全仓**代码零引用**（仅存于 `docs/audit/**`），删它不产生"少写一次状态"的副作用。
  - `planAgentSession()` 的调用点只有一个（`compose.ts:1186`），已同步去掉 `at`；`grep planAgentSession` 在 src 下只有定义 + 这一处调用。类型检查通过即证明无漏改调用方。
  - 交叉核对：`agent-serial-queue.test.ts` 的「两次 @ 复用同一个 `session_id`，`agent_sessions.turns` 递增」用例**自跑通过**，说明"第 2 轮真的 attach 原会话"在装配层仍然成立（这条用例不依赖轮换）。

### 5 反证「永不轮换」的合理性（含 FR-5.6 依赖）

- 结论：**技术判断成立，但与 P0-5 的依赖关系被"降级"描述了 —— 这是本报告唯一的实质问题。**
- 证据：
  - "压缩引擎零生产调用方"**属实**：`apps/server/src/worker/run-task.ts:202` 只有 `readonly compactor?: unknown | undefined;` 这一处声明，全文件（1784 行）**没有任何调用**；`compose.ts:842` 把 `createV21Compactor` 塞进依赖里，注释自己写着「`createV21Compactor` 只暴露不调用」（`compose.ts:1334`）。所以压缩今天不会发生。
  - 需求原文不允许"报错"这个结果：`docs/requirements.html:1063`「超过模型窗口时**必须自动压缩**，而不是报错、丢消息，或强行开新会话」。修复报告的残余风险 §1 写的是「表现是 `context_length_exceeded` 一类失败……这是本修复**有意换来**的取舍」—— 方向对（诚实说明会发生什么），但定性错：需求把"报错"明列为不可接受，所以这不是"取舍"，而是**一条 P0 需求从"被错误行为违反"变成"依赖另一条未修缺陷才成立"**。
  - 因此判断：删掉轮换本身是对的（轮换从来不是上下文治理手段，且它违反 FR-3.4 是硬冲突）；但 P0-1 的完成态**依赖 P0-5**。若 P0-5 不同批修，长命 issue 会在第 N 轮后开始撞上下文上限，这是需求明确禁止的形态。这一条应写成"上线前置条件"，而不是"遗留风险 1"。

### 6 测试

- 结论：**新增 5 条确实存在且全绿；`e2e-dry-run` 未被破坏；现存单测中另有一处失败，与本改动无关（我复现并定位了原因）**。
- 证据见"我实际执行的验证"。新增用例的内容也核过：31 轮 + 存活 400 天仍返回同一 `sessionId`、`Object.keys(plan)` 只有 `session`（钉住没有 `rotate`/`archiveSessionId` 入口）、空串按首轮、`cursor=0` 不传 `after` —— 覆盖点与报告的 5 条描述逐条对上。

### 7 类型检查

- 结论：**通过**。
- 证据：`apps/server/package.json` 的 `typecheck` 就是 `tsc -p tsconfig.json --noEmit`；直接执行该命令退出码 0、无输出。

## 我实际执行的验证

工作目录 `C:\Code\NodeProjects\pi-issue-bot`，2026-11-14。

| 命令 | 结果 |
|---|---|
| `cd apps/server; npx tsc -p tsconfig.json --noEmit` | 退出码 0，无任何输出 |
| `cd apps/server; npx vitest run test/app-agent-session-plan.test.ts` | 1 file / **5 passed**（与报告一致） |
| `cd apps/server; npx vitest run test/e2e-dry-run.test.ts` | 1 file / **2 passed**；证据行 `hostOps=connection/initialize,project/register,session/create,events/subscribe,turn/start,workspace/diff`，**无 `session/archive`** |
| `cd apps/server; npx vitest run test/agent-session-state.test.ts test/app-racp-event-feed.test.ts` | 2 files / **19 passed**（v2.1 状态机与 `archiveSessionId` 恒 null 的断言未因删字段而红） |
| `cd apps/server; npx vitest run test/agent-serial-queue.test.ts` | 12 条中 **1 failed / 11 passed**；失败为 `L-02：归一化等价（多空格 / 标点 / 不同别名）→ 同一条消息`（`:174`，期望 `duplicate` 得到 `enqueued`）；「两次 @ 复用同一个 `session_id`」**passed** |
| `Grep AGENT_SESSION_POLICY\|AgentSessionRotationReason\|rotateReason\|maxAgeDays\|maxTurns`（全仓，排除 node_modules/dist） | 源码零命中，仅 `compose.ts:203` 注释 + `docs/audit/**` |
| `Grep sessionArchive`（全仓） | 源码仅 `turn-driver.ts:435/519`、`run-task.ts:1114`、`racp-client/ops.ts` 定义，均核过条件 |

**关于那 1 条失败**：属并行会话的 P0-3 改动（`apps/server/src/agent/canonical-text.ts` 的 `normalizeForIdempotency` 从"去 @/压空白/去标点"改成"只 trim + 合并空行"）。该 agent 更新了 `test/agent-message.test.ts` 与 `test/v21-webhook-integration.test.ts`，**漏改** `test/agent-serial-queue.test.ts:172-175` 这条仍按旧口径（标点不敏感）断言的用例。与 `compose.ts` 的会话计划无调用关系，不是 P0-1 引入。但**共享工作区的套件目前是红的**，交付时不能说"全绿"。

**未执行**：`pnpm -r test` 全量、`pnpm lint`、`pnpm gen:openapi`（本改动不触及契约/schema/样式；全量套件在他人未完成改动下红，跑它得不出关于 P0-1 的信息）。

## 发现的问题

| 严重度 | 问题 | 位置 | 建议 |
|---|---|---|---|
| 中 | FR-5.6 依赖被定性为"有意取舍"，而需求 `requirements.html:1063` 明写超窗必须自动压缩「而不是报错」。压缩引擎零调用方已核实（`run-task.ts:202` 只有声明）。 | `docs/audit/fix/P0-1.md` 残余风险 §1 | 改写为**上线前置条件**：P0-1 与 P0-5 必须同批上线；否则在 P0-5 完成前不发布。不要留在"残余风险"里。 |
| 低 | 报告称 compose 内"轮换"注释已全部清理，实际漏一处：`executeTask` 的文档注释仍写「复用 / 新建 / 轮换」。 | `apps/server/src/app/compose.ts:1068` | 改为「复用 / 新建」。 |
| 低 | 报告称"全仓无其他引用"只对标识符成立；仍有 5 处注释在描述已不存在的轮换策略，其中两处是列语义说明（schema），会误导后来者以为 `turns`/`started_at` 还是阈值。 | `agent/store.ts:183`；`db/schema.ts:668`、`:681`、`:799`；`worker/run-task.ts:1108`「那一次由装配层按轮换策略决定」 | 一并改成事实描述（`turns` 只增不减；`started_at` 只在首轮落）。`run-task.ts:1108` 尤其要改，否则读代码的人会以为装配层还有第 4 条规则。 |
| 低 | `started_at` 语义在运行时重置后不再自洽：`sessionReset` 换了新会话，但 `persistAgentSessionAfterRun` 仍保留旧 `started_at`（修复前 rotate 会刷新为 `now()`）。 | `compose.ts:1001`；列语义见 `db/schema.ts:681` | 若要保留"会话创建时刻"语义，`params.report.sessionReset === true` 时刷新 `started_at`；否则把该列改名为"issue 首次建会话时刻"。当前无阈值读取方，故仅影响展示，不阻塞。 |
| 提示 | v2.1 侧仍保留恒 `null` 的 `archiveSessionId` 字段（`compose.ts:296/345`，并有测试断言它恒 null）。与本次删除理由（"留着就是留入口"）不完全一致，但它是 v2.1 事件状态机的既有契约，不属于 P0-1 改动面。 | `compose.ts:288-302`、`:340-347` | 可留待 P0-1 之后单独清理，或在报告里点明"两处 null 字段语义不同"。 |

## 与 P0-5 的依赖关系（第 5 条）

- **事实**：压缩引擎今天零生产调用方。`run-task.ts:202` 声明 `compactor?: unknown`，全文件无调用；`compose.ts:842` 注入 `createV21Compactor`，`compose.ts:1334` 注释自认"只暴露不调用"；唯一会写压缩记录的是 `runTask` 里"模型自己报 `itemType==='compaction'`"那条被动路径（`run-task.ts:936-946`），它不是主动压缩。
- **后果链**：会话永不轮换 → 同一 issue 的事件流只追加 → 下一轮 `session/attach` 带回全部历史 → 迟早超过模型窗口。没有主动压缩时，唯一的现实结果是 `context_length_exceeded` 类失败。
- **需求怎么说的**：`requirements.html:1063`「超过模型窗口时**必须自动压缩**，而不是报错、丢消息，或强行开新会话」。三件事它都禁了：报错（无压缩时的现实结果）、丢消息、开新会话（轮换）。所以"永不轮换"把需求从"被错误行为违反"推到"依赖另一条未修缺陷才成立"，**不是终态**。
- **我的判断**：P0-1 的方向正确、实现干净，**但它是半个修复**。合并顺序应当是 P0-5（压缩接线）先或同批，P0-1 在后；或者至少把 P0-1 标记为"依赖 P0-5，两者必须同批上线"，而不是"上线后再看"。这一点必须在 `P0-1.md` 里改口径，否则读报告的人会以为 P0-1 可以独立发布。
