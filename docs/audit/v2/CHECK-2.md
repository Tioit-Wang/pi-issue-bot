# CHECK-2 裁决（U06-U10）

> 基线：HEAD `fbfa029`，工作区与 `_baseline.txt` 一致。
> 口径来源：`docs/audit/v2/_TASK-TEMPLATE.md`（五态、证据口径四条）。
> 本文件只做裁决，不改代码。

## 区间结论表

| 单元 | 条目 | A | B | 归类 | 最终判定 |
|---|---|---|---|---|---|
| U06 | SC-1 收到 `issue_comment.created` | 已实现 | 已实现 | 收敛 | 已实现（未抽验） |
| U06 | SC-2 三个闸门 | 已实现 | 已实现 | 收敛 | 已实现（未抽验） |
| U06 | SC-3 合法提及判定 | 已实现 | 已实现 | 收敛 | 已实现（未抽验） |
| U06 | SC-4 复用该 issue 已有会话 | 已实现 | 部分实现 | **分歧** | **部分实现**（采信 B） |
| U06 | SC-5 两个评论占位符 | 已实现 | 已实现 | 收敛 | 已实现（未抽验） |
| U06 | SC-6 与场景 A 不同槽位 | 部分实现 | 部分实现 | 收敛（缺口表述不同） | 部分实现（两条缺口并存） |
| U07 | P4-1 四部件可辨认 | 已实现 | 已实现 | 收敛 | 已实现（未抽验） |
| U07 | P4-2 Agent 不直读配置 | 已实现 | 已实现 | 收敛 | 已实现（未抽验） |
| U07 | P4-3 Agent 不直连 GitHub | 部分实现 | 已实现 | **分歧** | **已实现**（采信 B） |
| U07 | P4-4 输出只回调度、校验后执行 | 已实现 | 部分实现 | **分歧** | **已实现**（采信 A） |
| U07 | P4-5 配置改动不需动 agent | 已实现 | 部分实现 | **分歧** | **已实现**（采信 A） |
| U08 | FR-1.1 接收 webhook / 原始 body | 已实现 | 部分实现 | **分歧** | **部分实现**（采信 B） |
| U08 | FR-1.2 签名校验 + 失败留痕 | 部分实现 | 部分实现 | 收敛 | 部分实现（抽验通过） |
| U08 | FR-1.3 投递去重 | 已实现 | 已实现 | 收敛 | 已实现（未抽验） |
| U08 | FR-1.4 10 秒应答 | 部分实现 | 部分实现 | 收敛 | 部分实现（未抽验） |
| U09 | FR-2.1 每事件一个开关 | 已实现 | 已实现 | 收敛 | 已实现（未抽验） |
| U09 | FR-2.2 每事件一份模板 | 已实现 | 已实现 | 收敛 | 已实现（未抽验） |
| U09 | FR-2.3 占位符替换 + 配置告警 | 部分实现 | 部分实现 | 收敛 | 部分实现（抽验通过） |
| U09 | FR-2.4 评论四闸门 | 已实现 | 已实现 | 收敛 | 已实现（未抽验） |
| U09 | FR-2.5 提及关键词与合法提及 | 已实现 | 已实现 | 收敛 | 已实现（未抽验） |
| U10 | FR-3.1 一个 issue 一个会话 | 部分实现 | 部分实现 | 收敛（缺口不同） | 部分实现（A+B 缺口并列） |
| U10 | FR-3.2 多事件进入同一会话 | 部分实现 | 与需求冲突 | **分歧** | **与需求冲突**（采信 B） |
| U10 | FR-3.3 同 issue 串行 | 已实现 | 部分实现 | **分歧** | **部分实现**（采信 B） |
| U10 | FR-3.4 会话常驻不归档 | 与需求冲突 | 与需求冲突 | 收敛 | 与需求冲突（抽验通过，本段最重） |
| U10 | FR-3.5 三层去重 | 与需求冲突 | 与需求冲突 | 收敛 | 与需求冲突（未抽验，两边指认行一致） |

小结：25 个条目里 18 条收敛、7 条分歧；分歧全部由本次亲自读代码裁决，无一含糊。裁决后状态分布：已实现 14、部分实现 8、与需求冲突 3（无未实现、无无法判定）。

**漏条目检查**：U06-U10 五个单元 A/B 文件齐全（各 1 份），条目数与小节一一对应（SC-1~6、P4-1~5、FR-1.1~1.4、FR-2.1~2.5、FR-3.1~3.5），**无漏条目**。U07/U08/U09 的 A、B 也未越界到别的单元。

## 分歧裁决

### U06 SC-4 复用该 issue 已有会话
- A：已实现（`(repo, issue_number)` 定位 `agent_sessions`，有会话就 `reuse` + `session/attach`）。
- B：部分实现（30 轮 / 7 天后 `sessionArchive` 归档旧会话并新建，队列路径上该分支真的会走）。
- 裁决：**采信 B，判部分实现。**
- 依据：
  - `apps/server/src/app/compose.ts:209` — `AGENT_SESSION_POLICY = { maxTurns: 30, maxAgeDays: 7 }`，常量真实存在。
  - `apps/server/src/app/compose.ts:450` — `(turns ?? 0) >= maxTurns ? 'turns' : ageMs >= maxAgeDays*86400000 ? 'age' : null`；`:456` 命中即返回 `{ session: { mode:'persistent' }, rotate:true, archiveSessionId: sessionId }`（**不带 sessionId = 本轮新建**）。
  - `apps/server/src/app/compose.ts:1315` — `if (!v21SessionEventActive && agentSession.archiveSessionId !== null) { … await channel.ops.sessionArchive(...) }`。
  - `apps/server/src/app/compose.ts:1461` — 生产唯一调用点 `onTaskJob` 只传 `{ taskId, attempt }`，不传 `sessionEvent`，故 `v21SessionEventActive`（`:1195`）在生产恒 `false`。
- 理由：A 只追到复用分支（`:466` 起），把轮换分支当死代码略过；B 的整条链路（阈值 → 计划 → 归档 → 队列不传 `sessionEvent`）逐行可核，判「同一 issue 永远同一条会话」在时间维度上不成立。A 的缺失是**漏路径**，不是口径差异。

### U07 P4-3 Agent 不直连 GitHub
- A：部分实现（pi-host 继承整份 `process.env`，token / 私钥路径随之进入 agent 宿主进程）。
- B：已实现（容器 Env 白名单、exec 不透传 env、无裸 `api.github.com`、审批层拒绝 `gh`/`api`）。
- 裁决：**采信 B，判已实现**（A 指出的 env 继承记为该节额外问题，不构成 4.1 的子条件缺失）。
- 依据：
  - `docs/requirements.html:717` — 4.1 的「边界」callout 原文只有三句：不直读配置、不直连 GitHub、输出只回调度。**全文未出现「执行环境内没有 GitHub 凭证」这一子条件**（`:638-718` 整节已通读）。
  - `apps/server/src/runtime/host-supervisor.ts:487` — `const base = options.baseEnv ?? process.env;`；`apps/server/src/app/compose.ts:592`/`:601` 只传 `extraEnv: hostModelEnv(config)`，确实未传 `baseEnv`。事实成立。
- 理由：A 用一个**需求正文里不存在的子条件**（凭证不得出现在 agent 宿主进程）把该条从「已实现」下调，属自行加码；按口径「缺哪个子条件必须点名」，而 4.1 点不出这一条。env 继承是真问题，但归 `app/model-env.ts` 自述与 AGENTS.md §10 的硬化项，记入该节额外问题。

### U07 P4-4 输出只回调度、经校验后执行
- A：已实现（v2 三态分流：`rejected` 整份拒绝、零动作）。
- B：部分实现（`run-task.ts:1243-1291` 兜底评论：信封无效时仍把模型最后一段人话发成评论，与 FR-5.5「保持原状」相反）。
- 裁决：**采信 A（就 4.1 边界判已实现）**，B 的发现转为跨节问题。
- 依据：
  - `apps/server/src/worker/run-task.ts:1243` — 兜底分支的守卫是 `if (!v21Handled && prepared !== null && (!prepared.valid || !hasCommentAction))`。
  - `apps/server/src/worker/run-task.ts:1169`/`:1174` — `probe.kind === 'valid'` 与 `'rejected'` **都**把 `v21Handled = true`；即 v2 形状但不合格的信封根本进不了兜底分支（B 的反证第 3 点只查了命令白名单 `:1253`，漏了 `!v21Handled` 这道前置）。
  - `apps/server/src/worker/run-task.ts:1241` — 代码注释亦明示「v2 分支不发兜底评论」。
- 理由：B 的裁决支点（"v2.1 链路同样可达"）在被引用的同一行上就被 `!v21Handled` 否掉，故不能据此下调。真是缺口的部分（`probe.kind==='not-v21'` 的纯人话产出仍走兜底评论，与 FR-5.5 `docs/requirements.html:1057`「输出不合契约时标签与评论保持原状」相反，而 `:1054` 又要求「至少有兜底反馈」——需求内部互斥）**不属于 4.1 的四部件边界**，记为 FR-5.5 待裁项，不进本单元判定。

### U07 P4-5 配置改动不需要动 agent
- A：已实现（模板/系统提示词/目录全在配置，agent 侧拿渲染结果）。
- B：部分实现（仍在交付的 v0.3 链路把事件文案硬编码在 `agent/message.ts:35-72`）。
- 裁决：**采信 A，判已实现。**
- 依据：
  - `apps/server/src/app/compose.ts:981` — 装配层**无条件**注入 `v21: { db: pool, ...(repoIssues ? {repoIssues} : {}) }`（同一处只有 `repoIssues` 是可选的）；`apps/server/src/http/webhook.ts:1250-1286` 在有 `deps.v21` 时提前 return，不再走 `:1579` 那条旧组装链。
  - `apps/server/src/agent/message.ts:35-72` 的三条硬编码模板唯一调用点即 `webhook.ts:1579`，生产装配下不可达。
- 理由：按口径 §三.2「冻结在无执行路径的代码上不算实现」，也同理不算**反证**——B 拿一条生产不可达的旧链路否定生效链路，属把「存在」当「生效」（方向相反的同一种误用）。旧链路的处置是「是否还属交付面」的架构问题，记入该节额外问题。

### U08 FR-1.1 接收 webhook / 不得先做 JSON 解析
- A：已实现（先取 rawBody，验签用 rawBody，解析不影响签名）。
- B：部分实现（`webhook.ts:1052` 的 `JSON.parse` 在 `:1074` 验签之前，非法 JSON 直接 400 且零留痕）。
- 裁决：**采信 B，判部分实现。**
- 依据：
  - `docs/requirements.html:733` — 「必须读取原始请求体，不得先做 JSON 解析（否则签名无法校验）。」这是 FR-1.1 下的**独立子条件**，不附属于别的条目。
  - `apps/server/src/http/webhook.ts:1052` — `payload = JSON.parse(input.rawBody)`；`:1055` 解析失败即 `return finish(400, ...)`；`:1066`/`:1074` 的验签在**其后**。
- 理由：需求把顺序写成了子条件，代码顺序反着来，且失败分支既不验签也不写 `webhook_deliveries`，有可观察后果（非法 body 零留痕）。A 的抗辩（验签用 rawBody，签名不会坏）成立，但那只说明**危害小**，不构成子条件成立——按口径「已实现 = 全部子条件成立」，故为部分实现；危害面在 FR-1.2 一并记账。

### U10 FR-3.2 多事件进入同一会话
- A：部分实现（attach + `turn/start` 追加，但轮换切断一次历史）。
- B：与需求冲突（轮换主动做了需求禁止的动作）。
- 裁决：**采信 B，判与需求冲突。**
- 依据：
  - `docs/requirements.html:872` — 「事件进入会话的方式是『追加一轮』……每一轮（turn）都建立在前一轮的历史之上。」
  - `apps/server/src/app/compose.ts:1315-1317` — 轮换时对旧会话 `sessionArchive()`；`:1039` 起把 `session_id` 换成新 id，`turns` 归 1。
  - 可达性同上（`compose.ts:1461` 不传 `sessionEvent` ⇒ 守卫恒假）。另有旁证：`apps/server/src/worker/run-task.ts` 与 `runtime/turn-driver.ts` 的主路径确实是 attach 复用，说明只有轮换这一处反向。
- 理由：不是「缺一条子条件」（部分实现），而是代码**主动执行**了需求明文禁止的切断动作，且该动作在真实路径上可达 —— 按五态定义属「与需求冲突」。A 把它写成「部分实现」，低估了「主动归档」与「少实现一个分支」的区别。

### U10 FR-3.3 同 issue 串行、跨 issue 并行
- A：已实现（`FOR UPDATE SKIP LOCKED` + `NOT EXISTS(running)` + `agent-dispatch` 并发 1；把多实例窗口记为残余风险）。
- B：部分实现（串行只在应用层，缺数据库部分唯一索引；且存在 `running` 永久卡死、无清扫作业）。
- 裁决：**采信 B，判部分实现。**
- 依据：
  - `docs/requirements.html:883` — 「并发写同一会话……这是**硬约束**而非优化项」。
  - `migrations/0006_agent.sql:46` — `agent_messages` 上只有普通索引 `(repo, issue_number, status, created_at)`，**没有** `(repo, issue_number) WHERE status='running'` 之类部分唯一索引（全 `migrations/*.sql` 检索 `WHERE status` 无命中）。
  - `apps/server/src/agent/store.ts:125` — `SET "status" = 'running'` 是唯一置 `running` 处；`apps/server/src/jobs/*.ts` 里**没有**任何清扫 `agent_messages.status='running'` 的作业（`jobs/index.ts` 注册的六个作业均不涉及）。
- 理由：需求把它定为硬约束，而代码的串行保证全部依赖「单进程 + 快照判定」，且缺一条崩溃恢复路径（`NOT EXISTS(running)` 会把该 issue 永久挡住）。A 已看见同一事实却按「量级问题」不计缺口，与「硬约束」的措辞冲突；按口径「已实现 = 全部子条件 + 可定位实现路径」，这里子条件在代码里不成立，只能是部分实现。

### U10 FR-3.4 会话常驻不归档（本段最重分歧点）
- A：与需求冲突（`compose.ts:1315` 在真实路径上会 `sessionArchive`；沙箱回收只是记账）。
- B：与需求冲突（同一处归档；生产免归档守卫永不生效）。
- 裁决：**两边一致，判与需求冲突**；分歧不存在，只有表述详略差。以下为本人独立复核。
- 依据：
  - `docs/requirements.html:888` / `:890` — 「会话没有『结束』这个状态……任何归档动作都会让重开的 issue 失去上下文」「创建后一直有效，不归档、不释放映射」。
  - `apps/server/src/app/compose.ts:1315` — 归档调用点；`:1313-1314` 的注释本身写着「FR-3.4 明令会话没有『结束』这个状态」——即代码知道需求，守卫却因 `compose.ts:1461` 不传 `sessionEvent` 而恒不生效（`v21SessionEventActive` 在 `:1195` 置 `false`）。
  - 对照：`apps/server/src/agent/session-state.ts` 的状态枚举与迁移矩阵确实不含 archive/delete，`agent_sessions` 行永不删除，`jobs/retention-cleanup.ts` 也不清会话行 —— 数据侧正确，资源侧与归档一侧相反。
- 理由：这是「代码行为与需求相反」的教科书情形：需求禁用归档，代码在可达路径上归档。**同时**它是一个一致性缺陷而非设计取舍：`compose.ts:1313` 的注释表明作者的意图是「v2.1 路径不归档」，守卫条件写在了全仓唯一生产调用点**永不传**的字段上，于是意图与行为分叉。整改方向唯一：要么删掉 `planAgentSession()` 的轮换分支，要么让 `onTaskJob` 传递真实 `sessionEvent`；两者都不能靠注释维持。

## 抽验记录

只记本人亲自打开代码确认的项；未抽验的收敛项如实标「未抽验」，不以对方结论代替。

| 单元 | 来源 | 引用 | 存在 | 相符 |
|---|---|---|---|---|
| U06 | A/B（SC-4 分歧） | `apps/server/src/app/compose.ts:209` `AGENT_SESSION_POLICY` 30 轮 / 7 天 | 是 | 是（A 未提及，B 正确） |
| U06 | B | `compose.ts:450`/`:456` 轮换命中即不带 `sessionId` | 是 | 是 |
| U06 | A/B | `compose.ts:1315` 归档守卫 | 是 | 是 |
| U06 | B | `compose.ts:1461` 队列路径只传 `taskId`/`attempt` | 是 | 是 |
| U07 | A/B（P4-3 分歧） | `runtime/host-supervisor.ts:487` `baseEnv ?? process.env` | 是 | 是 |
| U07 | A | `compose.ts:592`/`:601` 未传 `baseEnv` | 是 | 是 |
| U07 | B（P4-4） | `worker/run-task.ts:1243` 守卫 `!v21Handled && …` | 是 | 是（B 漏读，其「v2.1 可达」不成立） |
| U07 | B 反证 | `run-task.ts:1169`/`:1174` `v21Handled = true`（valid 与 rejected 都是） | 是 | 是（反证 B 的结论） |
| U07 | B（P4-5） | `compose.ts:981` 无条件注入 `v21` | 是 | 是（反证 B 的结论：旧链路生产不可达） |
| U08 | B（FR-1.1 分歧） | `http/webhook.ts:1052` `JSON.parse` 先于 `:1074` 验签 | 是 | 是 |
| U08 | A/B（FR-1.2） | `webhook.ts:1066-1069` 缺签名头 401 且无 `insertDelivery` | 是 | 是 |
| U09 | A/B（FR-2.3） | `compose.ts:981-984` 生产 `v21` deps 只有 `db` + 可选 `repoIssues`，无 `onUnknownPlaceholders` | 是 | 是（告警仅日志，无落库/查询） |
| U10 | B（FR-3.3 分歧） | `migrations/0006_agent.sql:46` 普通索引、无部分唯一索引 | 是 | 是 |
| U10 | B（FR-3.3 分歧） | `agent/store.ts:125` 置 `running`；`jobs/*.ts` 无 `running` 清扫 | 是 | 是 |
| U10 | A/B（FR-3.4） | `compose.ts:1195` 守卫 + `:1315-1317` 归档（见上） | 是 | 是 |
未抽验（仅比对两边状态一致，未独立打开代码）：U06 SC-1/2/3/5/6、U07 P4-1/P4-2、U08 FR-1.3/FR-1.4、U09 FR-2.1/2.2/2.4/2.5、U10 FR-3.1/FR-3.5（共 15 条）。这些项两路结论相同且指认行号互不矛盾，风险等级低于本段 7 处分歧。

## STALE

**未发现 STALE。** 本轮读到的行号（`compose.ts:209/450/456/1195/1315/1461`、`host-supervisor.ts:487`、`webhook.ts:1052/1066/1074`、`run-task.ts:1169/1174/1243`、`0006_agent.sql:46`、`store.ts:125`）与 A/B 引用全部对应实际内容，无一处「文件已变」或行号不存在。

两处**引用偏差**（事实成立、行号略偏，不计 STALE）：

1. U06 A 的 SC-4 只引 `compose.ts:466-479`（复用分支）而无轮换分支，属**选择性引用**，是这次分歧的成因。
2. U10 B 的 FR-3.2 写「第 8 天触发」，实际比较是 `ageMs >= maxAgeDays*86400000`（`compose.ts:453`，即 ≥7 天整），表述偏差 1 天，判定不受影响。

## 本段遗留

- FR-5.5 需求内部互斥（`requirements.html:1054` 要求兜底反馈 vs `:1057` 要求保持原状），代码选了 1054。这是 U07 P4-4 的裁决支点，需在需求侧裁定后统一实现与用例。
- 「会话 SQL 三份拷贝」（`agent/store.ts`、`app/compose.ts`、`http/webhook-v21.ts`）两路都提到，属架构债，不在本段判定范围。
- PR 上的 `issue_comment` 会进 issue 会话（U09 A 用探针实测、U10 B 独立指认同一处），与 `requirements.html:867`「PR 与 issue 各自独立会话」冲突，落在 U10 FR-3.1 的缺口里。
