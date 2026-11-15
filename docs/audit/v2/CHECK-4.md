# CHECK-4 裁决（U20-U29）

> 范围：U20 §6.7 / U21 §6.8 / U22 §6.9 / U23 §7 / U24 §8 / U25 §9 / U26-27 §10 / U28 §11 / U29 §12，共 89 条。
> 基线：工作区 HEAD（`_baseline.txt`）。判定口径：**当前代码是否已具备该能力**，不以测试是否跑过为准。
> 取证方式：只读 `git grep` / `Select-String` + 亲自打开 `file:line`；未跑 typecheck / lint / 测试，未起 PG / Docker / 真模型。

## 区间结论表

| 单元 | 条目 | A | B | 归类 | 最终判定 |
|---|---|---|---|---|---|
| U20 | SL-1 系统提示词 | 部分实现 | 部分实现 | 收敛 | 部分实现（抽验通过：只看新建会话分支） |
| U20 | SL-2 并发数 | 部分实现 | 部分实现 | 收敛 | 部分实现（`agent.limits.concurrency` 死字段 + 等槽可被取消） |
| U20 | SL-3 日配额 | 未实现 | 未实现 | 收敛 | 未实现（抽验通过：计数表零读写、判定入参无生产方） |
| U20 | SL-4 单轮超时 | 部分实现 | 部分实现 | 收敛 | 部分实现（触顶行为对，时长硬编码 20/30min） |
| U20 | SL-5 不设平台级业务限流 | 已实现 | 已实现 | 收敛 | 已实现 |
| U21 | CFG-8.1 供应商记录 | 未实现 | 未实现 | 收敛 | 未实现（抽验通过：**完全没有**实体，只有 env 三元组） |
| U21 | CFG-8.2 模型角色四档 | 未实现 | 未实现 | 收敛 | 未实现（抽验通过：四档 / 角色单价 / 兜底降级全无） |
| U21 | CFG-8.3 全局默认 + 项目覆盖 | 未实现 | 未实现 | 收敛 | 未实现（`repos.settings.model` 死字段） |
| U22 | CFG-9.1 面板身份（个人 PAT） | 部分实现 | 未实现 | **分歧** | **部分实现**（详见分歧裁决 1） |
| U22 | CFG-9.2 三态与退回 bot | 未实现 | 未实现 | 收敛 | 未实现（`scopes` / `getAuthenticated` 全仓 0 命中） |
| U23 | BR-1 会话唯一 | 部分实现 | 部分实现 | 收敛 | 部分实现（无部分唯一索引） |
| U23 | BR-2 串行消费 | 部分实现 | 部分实现 | 收敛 | 部分实现 |
| U23 | BR-3 事件幂等 | 部分实现 | 部分实现 | 收敛 | 部分实现（失败行永久占键，抽验通过） |
| U23 | BR-4 增量投喂 | 与需求冲突 | 与需求冲突 | 收敛 | 与需求冲突 |
| U23 | BR-5 会话域隔离 | 与需求冲突 | 与需求冲突 | 收敛 | 与需求冲突 |
| U23 | BR-6 不触发也留痕 | 部分实现 | 未实现 | **分歧** | **未实现**（详见分歧裁决 2） |
| U23 | BR-7 失败可见 | 已实现 | 部分实现 | **分歧** | **已实现**（详见分歧裁决 3） |
| U23 | BR-8 配置即快照 | 已实现 | 已实现 | 收敛 | 已实现 |
| U23 | BR-9 标签以目录为准 | 部分实现 | 部分实现 | 收敛 | 部分实现（无 GitHub 对账） |
| U23 | BR-10 删除留痕 | 部分实现 | 部分实现 | 收敛 | 部分实现（原主人只在自由文本） |
| U23 | BR-11 标签管辖边界 | 与需求冲突 | 与需求冲突 | 收敛 | 与需求冲突（永久 veto 仍在，抽验通过） |
| U23 | BR-12 无语义不删 | 部分实现 | 已实现 | 收敛 | 部分实现（取严：legacy 写回不看目录语义） |
| U24 | DATA-1 事件投递 | 部分实现 | 部分实现 | 收敛 | 部分实现（`decision_reason` 只写不读） |
| U24 | DATA-2 项目配置 | 部分实现 | 部分实现 | 收敛 | 部分实现（无版本概念，抽验通过） |
| U24 | DATA-3 会话 | 已实现 | 已实现 | 收敛 | 已实现 |
| U24 | DATA-4 轮次 | 已实现 | 已实现 | 收敛 | 已实现 |
| U24 | DATA-5 对话 | 部分实现 | 部分实现 | 收敛 | 部分实现（A 的 90 天硬删 + B 的展示截断均成立） |
| U24 | DATA-6 用量 | 已实现 | 已实现 | 收敛 | 已实现 |
| U25 | NFR-1 规模 | 已实现 | 已实现 | 收敛 | 已实现 |
| U25 | NFR-2 响应 | 已实现 | 部分实现 | **分歧** | **部分实现**（详见分歧裁决 4） |
| U25 | NFR-3 可靠 | 已实现 | 已实现 | 收敛 | 已实现（三层去重全在 PG） |
| U25 | NFR-4 安全 | 已实现 | 已实现 | 收敛 | 已实现 |
| U25 | NFR-5 可维护 | 已实现 | 已实现 | 收敛 | 已实现（附 4 个死字段缺口，见 B 额外问题） |
| U25 | NFR-6 可追溯 | 已实现 | 部分实现 | **分歧** | **已实现**（详见分歧裁决 5） |
| U26 | AC-1 | 已实现 | 已实现 | 收敛 | 已实现 |
| U26 | AC-2 | 已实现 | 部分实现 | **分歧** | **已实现**（详见分歧裁决 6） |
| U26 | AC-3 | 部分实现 | 部分实现 | 收敛 | 部分实现（同 BR-6） |
| U26 | AC-4 | 已实现 | 已实现 | 收敛 | 已实现 |
| U26 | AC-5 | 已实现 | 已实现 | 收敛 | 已实现 |
| U26 | AC-6 | 已实现 | 已实现 | 收敛 | 已实现 |
| U26 | AC-7 | 已实现 | 部分实现 | **分歧** | **已实现**（详见分歧裁决 7） |
| U26 | AC-8 | 已实现 | 已实现 | 收敛 | 已实现 |
| U26 | AC-9 | 部分实现 | 部分实现 | 收敛 | 部分实现（工具输出不进契约） |
| U26 | AC-10 | 部分实现 | 部分实现 | 收敛 | 部分实现（无该轮 token 读出口） |
| U26 | AC-11 | 已实现 | 已实现 | 收敛 | 已实现 |
| U26 | AC-12 | 已实现 | 已实现 | 收敛 | 已实现 |
| U26 | AC-13 | 部分实现 | 部分实现 | 收敛 | 部分实现（需补充信息标签无专门移除路径） |
| U26 | AC-14 | 已实现 | 已实现 | 收敛 | 已实现 |
| U26 | AC-15 | 与需求冲突 | 与需求冲突 | 收敛 | 与需求冲突（同 BR-11） |
| U26 | AC-16 | 已实现 | 已实现 | 收敛 | 已实现 |
| U26 | AC-17 | 已实现 | 已实现 | 收敛 | 已实现 |
| U27 | AC-18 | 部分实现 | 已实现 | **分歧** | **部分实现**（详见分歧裁决 8） |
| U27 | AC-19 | 部分实现 | 部分实现 | 收敛 | 部分实现（`contentDuplicate` 无生产方） |
| U27 | AC-20 | 与需求冲突 | 与需求冲突 | 收敛 | 与需求冲突（抽验通过，与 BR-3 同一根因） |
| U27 | AC-21 | 已实现 | 已实现 | 收敛 | 已实现 |
| U27 | AC-22 | 已实现 | 已实现 | 收敛 | 已实现 |
| U27 | AC-23 | 已实现 | 部分实现 | **分歧** | **部分实现**（详见分歧裁决 9） |
| U27 | AC-24 | 无法判定 | 未实现 | **分歧** | **未实现**（详见分歧裁决 10） |
| U27 | AC-25 | 部分实现 | 部分实现 | 收敛 | 部分实现（有落库、无读取面） |
| U27 | AC-26 | 与需求冲突 | 与需求冲突 | 收敛 | 与需求冲突（5 全局页 + 5 项目页都在） |
| U27 | AC-27 | 未实现 | 未实现 | 收敛 | 未实现 |
| U27 | AC-28 | 未实现 | 未实现 | 收敛 | 未实现 |
| U27 | AC-29 | 未实现 | 未实现 | 收敛 | 未实现 |
| U27 | AC-30 | 部分实现 | 部分实现 | 收敛 | 部分实现（verdict/actions 未折叠） |
| U27 | AC-31 | 未实现 | 未实现 | 收敛 | 未实现 |
| U27 | AC-32 | 未实现 | 未实现 | 收敛 | 未实现（同 CFG-8.1/8.2/8.3） |
| U27 | AC-33 | 部分实现 | 部分实现 | 收敛 | 部分实现（标记人工 / 面板内发送无控件） |
| U28 | Q-1 | 已实现 | 已实现 | 收敛 | 已实现 |
| U28 | Q-2 | 已实现 | 已实现 | 收敛 | 已实现（告警仅进程日志，不影响本条） |
| U28 | Q-3 会话无结束状态 | 已实现 | 与需求冲突 | **分歧** | **与需求冲突**（详见分歧裁决 11） |
| U28 | Q-4 自动压缩 | 部分实现 | 部分实现 | 收敛 | 部分实现（compactor 零调用方） |
| U28 | Q-5 | 已实现 | 已实现 | 收敛 | 已实现 |
| U28 | Q-6 不维护技能注册表 | 与需求冲突 | 已实现 | **分歧** | **与需求冲突**（详见分歧裁决 12） |
| U28 | Q-7 面板只留三项目页 | 与需求冲突 | 与需求冲突 | 收敛 | 与需求冲突 |
| U28 | Q-8 Issue 页会话流 | 部分实现 | 部分实现 | 收敛 | 部分实现 |
| U28 | Q-9 面板内发送不做 | 部分实现 | 已实现 | **分歧** | **部分实现**（详见分歧裁决 13） |
| U29 | TERM-1 事件 | 已实现 | 已实现 | 收敛 | 已实现 |
| U29 | TERM-2 触发 | 已实现 | 已实现 | 收敛 | 已实现 |
| U29 | TERM-3 会话 | 与需求冲突 | 与需求冲突 | 收敛 | 与需求冲突（同 Q-3） |
| U29 | TERM-4 轮次 | 已实现 | 已实现 | 收敛 | 已实现 |
| U29 | TERM-5 模板 | 已实现 | 部分实现 | **分歧** | **部分实现**（详见分歧裁决 14） |
| U29 | TERM-6 占位符 | 已实现 | 部分实现 | **分歧** | **已实现**（详见分歧裁决 15） |
| U29 | TERM-7 闸门 | 部分实现 | 部分实现 | 收敛 | 部分实现（同词另指排队/推送集闸门） |
| U29 | TERM-8 写回 | 已实现 | 部分实现 | **分歧** | **部分实现**（详见分歧裁决 16） |
| U29 | TERM-9 目标态 | 已实现 | 已实现 | 收敛 | 已实现 |
| U29 | TERM-10 标签目录 | 部分实现 | 已实现 | **分歧** | **已实现**（详见分歧裁决 17） |
| U29 | TERM-11 槽位 | 已实现 | 部分实现 | **分歧** | **部分实现**（详见分歧裁决 18） |
| U29 | TERM-12 提及关键词 | 部分实现 | 已实现 | **分歧** | **部分实现**（详见分歧裁决 19） |
| U29 | TERM-13 角色清单 | 已实现 | 已实现 | 收敛 | 已实现 |

**条目漏检**：无。89 条与需求 §6.7–§12 的条目数逐一对齐（SL×5 / CFG-8×3 / CFG-9×2 / BR×12 / DATA×6 / NFR×6 / AC×33 / Q×9 / TERM×13）。A、B 两侧均无漏条目。

## 分歧裁决

### U22 CFG-9.1
- A：部分实现 / B：未实现
- 裁决：**部分实现**（A），但个人 PAT 这一主体**确认为 0 存在**
- 依据：`apps/server/src/app/compose.ts:759-761`（写面恒 `createGithubWriteApi(baseGithubClient)`）、`apps/server/src/app/github-auth.ts:21-106`（身份模式只有 `app/token/none/degraded`）、`apps/server/src/app/config.ts:71-79`（只有部署级 `PI_BOT_GITHUB_*`）
- 理由：本条四个子条件按「已实现 / 未实现」拆开是 (a) 1 / (b)(c)(d) 3。四条件中子条件 (a)「未配置个人令牌时以 bot 身份署名」有真实执行链（App installation token，且 `isOwn(appSlug)` 能识别自身 login），属可验证能力；而 (b) 个人 PAT 存储+CRUD、(c) 身份切换点、(d) scope/过期校验三层**全空**——全仓 `X-OAuth-Scopes` / `getAuthenticated` / `personalAccessToken` / `PAT` 命中 0，`repos` 表 14 列无 token/identity 列。所以「完全没有个人 PAT」与 A 的「部分实现」并不矛盾：A 判的不是 PAT 存在，而是四个明写子条件完成了 1 个。B 的取证全部正确，仅在分类粒度上把「默认 bot 署名」排除在需求之外；本条标题即「面板身份（GitHub 令牌）」，默认署名是它的显式分支（需求行 1766 同一句），故不能整条抹掉。缺的是招牌能力，实现优先级与 B 的结论一致。

### U23 BR-6
- A：部分实现 / B：未实现
- 裁决：**未实现**（B）
- 依据：`apps/server/src/http/webhook-v21.ts:198-211`（写 `decision` / `decision_reason`）、`apps/server/src/db/schema.ts:124`（列定义）、`apps/server/src/queries/`（`decision` 0 命中，`Select-String` 全目录）；`packages/contract/src`（无 `decision` / `decisionReason` 响应字段）
- 理由：本条唯一的验收点是「后台可查」，而写入侧再完整也不产生可查能力。全仓读路径为 0：三个 `from webhook_deliveries` 的查询（`queries/issues.ts:152` / `278` / `827`）都不带该列，`/api/system` 契约也没有该字段，面板 `decision` 命中项全是审批 `approval.decision`。A 判「部分实现」的依据（写入完整）不是本条的任一部分，属把存储当能力。

### U23 BR-7
- A：已实现 / B：部分实现
- 裁决：**已实现**（A），附窄口径说明
- 依据：需求行 1792「失败必须有可见反馈（**兜底评论或后台告警**），不得静默」；`apps/server/src/feedback/stage.ts:8-25`（`failed/timed-out/cancelled` → `-eyes +confused`）、`apps/server/src/worker/run-task.ts:1243-1282`（兜底评论五条件，含第 3 条 `terminal !== 'turn.completed'` 拦截）、`apps/server/src/worker/run-task.ts:1170-1174` + `:1243`（`!v21Handled` 挡掉 v2 兜底评论）、`runs.failure_class` + `run_events` 留痕
- 理由：需求给的是**或**关系。失败一定有可见反馈这一半成立：终态 reaction 从 `-eyes` 翻成 `confused`（GitHub 上可见）+ `tasks.status` 终态 + `runs.failure_class` + `writeback.fallback-skipped` 事件留痕，任何失败路径都不静默。B 的事实（超时 / OOM / host 不可用 / v2 分支无兜底评论）全部核实为真，但那是「兜底评论」这一**选项**的适用范围，不是「可见反馈」缺失。故不判部分实现，也不判冲突；缺口另记为：v2 分支与异常收尾的评论级反馈缺位（信息量低，非静默）。

### U25 NFR-2
- A：已实现 / B：部分实现
- 裁决：**部分实现**（B）
- 依据：需求行 1826「webhook 应答 < 10 秒；处理异步；应答只表示已收到」；`apps/server/src/http/webhook-v21.ts:1057-1066`（应答前 `await rt.addEyesReaction`，无超时参数）、`apps/server/src/http/webhook-v21.ts:1029-1037`（应答前 `await insertMessage`，同步落库）、模板需要 `{{repo.issues}}` 时在应答路径上同步取 GitHub REST
- 理由：「异步执行」成立（执行在 worker），但「< 10 秒」在应答路径上有两处无超时护栏的同步网络调用（reaction 写、repo issues 取数），慢网络下一次 GitHub 抖动就能把应答推过 10 秒，且代码里没有任何超时或降级兜底。A 自己在证据里写了「无硬超时护栏」，却仍判已实现，前后不一致。按「当前代码是否具备该能力」判部分实现。

### U25 NFR-6
- A：已实现 / B：部分实现
- 裁决：**已实现**（A）
- 依据：需求行 1830「任一 issue 的处理过程可回放：对话 + 工具 + 用量三线齐全」；对话 `agent_messages.comment_body` / 轮次正文、工具 `run_events.toolCalls`、用量 `envelopes.usage` + `usage_costs`（`worker/run-task.ts:1599-1610` 写入），出口 `/api/tasks/:id`（`packages/contract/src/api.ts:300` 有 `usage`）
- 理由：三线都能落到某一 issue 的处理过程上，「可回放」成立，只是用量要走「轮次 `taskId` → `/api/tasks/:id`」两跳。B 的取证（issue 会话响应无用量字段、`apps/panel/src/components/issues/contract-extras.ts:104-105` 自述「契约还没提供这两个字段时返回 null」）为真，但那是**单屏展示**体验问题，不构成「用量线缺失」。判已实现，缺口记入面板成本展示。

### U26 AC-2
- A：已实现 / B：部分实现
- 裁决：**已实现**（A）
- 依据：需求行 1850「能看到两轮的完整对话，且第二轮不再重复询问」；`apps/server/src/agent/store.ts:124-139`（同 issue 逐条领消息）、`agent_sessions.session_id` 复用（`apps/server/src/app/compose.ts:444-478`）、会话视图取每轮触发正文 + 最终评论正文
- 理由：AC-2 的「完整对话」指两轮各自的问与答都在，代码满足。B 扣的是 `item.delta`（流式增量）不落库——那是渲染过程，不是对话内容；把它算进「完整对话」会让几乎所有条目都不成立。B 的观察成立、归类不成立。

### U26 AC-7
- A：已实现 / B：部分实现
- 裁决：**已实现**（A）
- 依据：需求行 1855「三个事件的顺序与到达顺序一致，没有并发交错」；`apps/server/src/agent/store.ts:106-115`（`queuedIssues` 按 `MIN(created_at)` 排序）、`:124-139`（`claimOldest` 单行 `UPDATE … FOR UPDATE SKIP LOCKED` + `NOT EXISTS(running)`）、`apps/server/src/queue/definitions.ts:152-153`（`agentDispatch` 并发 1）
- 理由：`created_at` 在入队时 `now()` 落值，就是到达序；同一 issue 只有一条 `running`，第二个事件不会被提前领走，三次处理必然串行且按序。B 的「没有数据库唯一约束」说的是 BR-1 会话唯一（另一条），「顺序依赖 created_at」在本条恰恰是对的机制。

### U27 AC-18
- A：部分实现 / B：已实现
- 裁决：**部分实现**（A）
- 依据：需求行 1870；`apps/server/src/trigger/roles.ts:69-71`（`allowRoles.length === 0` → `allowed: true`）、`apps/server/src/trigger/decide.ts:188-198`（`gates.require_role` 为真即调用）、`packages/contract/src/repo-config.ts:296`（只校验引用的角色名存在，**不校验非空**）、`apps/panel/src/components/settings/v21-events-section.tsx:447-459`
- 理由：「限定角色」开启但清单为空时，闸门把所有人放行——这正好是 AC-18 要拦的场景（清单里没有他）。契约只要求引用的名字存在于 `comment.roles`，空数组合法，面板也不会阻止保存空清单。B 的「有判定路径与用例」为真，但漏了空清单这个让本条失效的入口。

### U27 AC-23
- A：已实现 / B：部分实现
- 裁决：**部分实现**（B）
- 依据：需求行 1873「沙箱被回收，重开后复用原会话、沙箱自动重建」；`apps/server/src/app/compose.ts:1188`（关闭只 `UPDATE state / sandbox_id / closed_at`，会话行与 `session_id` 保留）、`apps/server/src/worker/run-task.ts`（无容器回收调用）、`apps/server/src/sandbox/` 全目录 `removeContainer|destroySandbox|sandboxRemove` 0 命中
- 理由：「会话复用」「沙箱重建」两半成立，「沙箱被回收」这一半在平台代码里没有动作：只是把 `sandbox_id` 置空，容器是否真的回收取决于宿主/pi-host，本仓无调用点、无断言、无留痕。A 把「置空 = 回收」当成实现，属推断而非代码事实。

### U27 AC-24
- A：无法判定 / B：未实现
- 裁决：**未实现**（B）
- 依据：`apps/server/src/app/compose.ts:881`（`compactor: createV21Compactor` 注入）、`apps/server/src/worker/run-task.ts:202`（端口声明 `compactor?: unknown`）；全仓 `compactor` 只有这 2 处，**无任何调用**
- 理由：AC-24 的前提是「压缩跑过两次」。压缩引擎在装配层被注入但执行侧从不调用，`agent_compactions` 只在识别 host 主动发来的 compaction 事件时落库（属被动记录）。生产链路上压缩不会发生，「模型仍能复述」无从谈起，因此不是「无法判定」而是「能力缺失」。A 的无法判定把举证责任推给了真模型，但缺失的是调用点这一静态事实。

### U28 Q-3
- A：已实现 / B：与需求冲突
- 裁决：**与需求冲突**（B）
- 依据：需求行 443「会话取消结束状态，issue 关闭只回收沙箱、记录保留、重开复用（FR-3.4 / Q-3）」；`apps/server/src/app/compose.ts:1311-1332`（`!v21SessionEventActive && agentSession.archiveSessionId !== null` → `await channel.ops.sessionArchive(...)`）、`apps/server/src/app/compose.ts:458-462`（轮换时置 `archiveSessionId: sessionId`）、`apps/server/src/worker/run-task.ts:1111-1118`（另一处 `deps.ops.sessionArchive`）
- 理由：v2.1 的计划确实恒 `archiveSessionId: null`（`compose.ts:302/352/435`），但 v0.3 命令任务（`/review-pr` 等）的轮换计划仍在生产装配里，且归档调用有两条活路径。只要一条可达，「会话不归档、没有结束状态」这一条就不成立。A 只看 v2.1 分支，漏了 legacy 轮换。

### U28 Q-6
- A：与需求冲突 / B：已实现
- 裁决：**与需求冲突**（A）
- 依据：需求行 485 / §11 Q-6「一个事件一个提示词，平台不维护技能注册表」；`apps/server/src/skills/registry.ts` + `apps/server/src/skills/index.ts:22-23`（`SkillRegistry` 公开出口）、`apps/server/src/agent/message.ts:163-177`（`eventSkillsOf(settings, templateId)` —— **事件/模板 → 技能集合**的映射仍在）、`/api/skills/*` CRUD
- 理由：B 自己也写了「另有遗留事件→技能映射」，而 `eventSkillsOf()` 就是按 `templateId` 决定这条事件带哪些技能，正是 Q-6 取消的那张表。技能目录（文档）与事件→技能路由（注册表）在本仓是同一套实体，无法只取前者。

### U28 Q-9
- A：部分实现 / B：已实现
- 裁决：**部分实现**（A）
- 依据：需求行 1437「本版范围：面板内发送消息不做。会话流底部**输入区只呈现形态，发送按钮为禁用态**」；`apps/panel/src` 全量检索 `发送` / `sendMessage` 0 命中，会话流底部无输入区
- 理由：Q-9 不是纯非目标，它把「输入区形态 + 禁用态发送按钮」写成了本版要做的事。发送能力确实没有（B 对），但需求明写的那半个形态也不存在，故部分实现。

### U29 TERM-5
- A：已实现 / B：部分实现
- 裁决：**部分实现**（B）
- 依据：术语表「模板 = 事件到提示词的模板」；代码里同时有 `DEFAULT_EVENT_TEMPLATES`（`packages/contract/src/settings-v21.ts:473`，走 `webhook-v21.ts:1016` 的 `decidedTemplate` 渲染）与 `apps/server/src/agent/message.ts:229` 的 `renderTemplate(template, vars)`（agent 消息模板，`AgentTemplateId` = `opened/edited`），两套渲染器、两处 `template`
- 理由：同词两义在代码里成立，术语「模板」不唯一。A 只看了配置层的 `prompt`/`template` 同源，漏了 agent 消息模板这套。

### U29 TERM-6
- A：已实现 / B：部分实现
- 裁决：**已实现**（A）
- 依据：`apps/server/src/skills/prompt.ts:158`（`PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.-]{1,40})\s*\}\}/`，唯一语法）、`packages/contract/src/settings-v21.ts:420-446`（`PROMPT_PLACEHOLDERS` / `PLACEHOLDER_NAMES` 单一清单）
- 理由：B 主张存在 `{名字}` 第二套语法，我在 `skills/`、`contract`、`assemble.ts` 三个地方检索单花括号替换均无命中，无法证实；占位符在本仓只有 `{{a.b}}` 一套，且名字清单是唯一事实源。B 的该条证据不成立（见 STALE）。

### U29 TERM-8
- A：已实现 / B：部分实现
- 裁决：**部分实现**（B）
- 依据：`apps/server/src/git/writeback.ts` 与 `apps/server/src/git/writeback-gate.ts` 实际存在（目录清单）；术语表只列 5 类写回动作，代码 `github/` 侧 6 类（含 `push_branch`）
- 理由：「写回」在代码里同时指 GitHub 写动作与 git 代码推送两套机制，且动作类目数与术语表不一致。B 的两条都核实为真；A 只核了 GitHub 写回那一支。

### U29 TERM-10
- A：部分实现 / B：已实现
- 裁决：**已实现**（B）
- 依据：`labels.vocabulary` / `CatalogEntry`（`apps/server/src/worker/writeback.ts` 的 `applyMissingPolicy` + 词表归一化）具备目录实体与消费方
- 理由：TERM-10 考的是「标签目录」这个术语在代码里有没有唯一对应实体，答案是「有」（异名 `vocabulary` / 词表）。A 扣的「与 GitHub 仓库保持一致」是 **BR-9** 的功能要求，BR-9 两侧都已判部分实现，把它二次计入术语条会重复扣分并混淆层级。TERM-10 判已实现，去重口径写在 BR-9。

### U29 TERM-11
- A：已实现 / B：部分实现
- 裁决：**部分实现**（B）
- 依据：术语表「槽位 = 写回评论的固定位置」；`apps/server/src/skills/assemble.ts:151-156`（`SkillSlot` / `ProjectSlot`）把「槽位」用于提示词装配的层位置
- 理由：同词两义在代码里成立，`comment_slots` 之外还有装配槽位，术语不唯一。

### U29 TERM-12
- A：部分实现 / B：已实现
- 裁决：**部分实现**（A）
- 依据：`apps/server/src/agent/message.ts:144` + `:296`（`stripAliases(rawText, aliases)` 仍按 `triggers.aliases` 摘正文 `@`）、`comment.mentions` 另有一套（闸门用）
- 理由：两套提及关键词并存且都在生产链路上跑，术语不唯一。B 判已实现只看了 `comment.mentions`，漏了 aliases 仍参与正文清洗。

## 抽验记录

| 单元 | 来源 | 引用 | 存在 | 相符 |
|---|---|---|---|---|
| U20 | A/B（SL-3） | `apps/server/src/db/schema.ts:634`（`quota_counters`）；全仓仅 schema / `db/index.ts` / 测试命中，无 INSERT/SELECT/UPDATE | 是 | 相符 |
| U20 | A/B（SL-3） | `apps/server/src/trigger/decide.ts:251`（`dailyQuotaExceeded === true` 分支）；生产侧仅 `decide.ts:119` 声明 + `webhook-v21.ts:155` 透传，唯一置真处是 `test/trigger-decide.test.ts:388` | 是 | 相符 |
| U21 | A/B（CFG-8.1） | `apps/server/src/db/schema.ts:514`（`host_credentials` 为唯一凭据表）；`migrations` + `packages/contract/src` 的 `provider` 命中 3 处均为无关类型/注释 | 是 | 相符 |
| U21 | A/B（CFG-8.2） | `apps/server/src/cost/pricing.ts` 价目为常量；`packages/contract/src/settings-v21.ts` 的 `agentExecutionSchema` 无 model 字段 | 是 | 相符 |
| U22 | A/B（CFG-9.2） | `apps/server/src/app/github-auth.ts:21`（四种身份模式，无 user）；`X-OAuth-Scopes` / `getAuthenticated` 全仓 0 命中 | 是 | 相符 |
| U23 | A/B（BR-3 / AC-20） | `apps/server/src/agent/store.ts:95-98`（`ON CONFLICT (repo, issue_number, fingerprint) DO NOTHING`，不带 status）；`apps/server/src/http/webhook-v21.ts:1038-1043`（`inserted === false` → 返回 `duplicate`） | 是 | 相符 |
| U23 | A/B（BR-11 / AC-15） | `apps/server/src/workflows/normalize.ts:215-224`（`human-veto` 永久不加回）；`:234` 注释自述「人（**或我们的撤标**）把它撤了」；`apps/server/src/workflows/bot-labels.ts:73-79`（veto 集合从 `bot_labels` 历史推，无 actor 维度） | 是 | 相符 |
| U23 | A/B（BR-6） | `apps/server/src/queries/` 下 `decision` 0 命中（面板命中均为 `approval.decision`） | 是 | 相符 |
| U24 | A/B（DATA-2） | `apps/server/src/db/schema.ts:162`（`settings_updated_at`）+ `repos.settings` jsonb；无版本列、无历史表 | 是 | 相符 |
| U25 | A/B（NFR-3） | `apps/server/src/http/webhook.ts:97`（`ON CONFLICT (delivery_id)`）、`agent/store.ts:149`（`ON CONFLICT (idempotency_key)`） | 是 | 相符 |
| U26 | A/B（AC-19） | `apps/server/src/http/webhook-v21.ts:117/154` 只透传 `contentDuplicate`，无生产置真处 | 是 | 相符 |
| U27 | A/B（AC-24 / Q-4） | `compactor` 全仓仅 `app/compose.ts:881` 注入 + `worker/run-task.ts:202` 声明，无调用 | 是 | 相符 |
| U28 | A/B（Q-3） | `apps/server/src/app/compose.ts:1315-1317`（`sessionArchive` 活路径） | 是 | 相符 |
| U29 | A/B（TERM-3） | `apps/server/src/worker/run-task.ts:1111-1118`（第二条 `sessionArchive` 调用） | 是 | 相符 |
| U27 | A/B（AC-23） | `apps/server/src/sandbox/` 下 `removeContainer|destroySandbox|sandboxRemove` 0 命中 | 是 | 相符（B 的结论） |

抽验统计：15 条中 15 条引用存在且与原文相符，0 条失败。

## STALE

- **无确认失效的行号**：本次抽验与裁决用到的 15 处 `file:line`（`schema.ts:634`、`decide.ts:251`、`schema.ts:514`、`github-auth.ts:21`、`agent/store.ts:95-98`、`webhook-v21.ts:1038-1043`、`normalize.ts:215/234`、`bot-labels.ts:73-79`、`schema.ts:162`、`webhook.ts:97`、`store.ts:149`、`webhook-v21.ts:117`、`compose.ts:881`、`run-task.ts:202`、`compose.ts:1315-1317`、`run-task.ts:1111-1118`）全部命中且语义相符。
- **口径订正 1（U29 B / TERM-6）**：B 主张「`{名字}` 第二套占位符语法」，在 `apps/server/src/skills/`、`packages/contract/src`、`skills/assemble.ts` 检索单花括号替换均无命中，该证据不成立；已按「未证实」处理，不计入 B。
- **口径订正 2（U26 B / AC-2）**：B 把「`item.delta` 不落库」算作「缺完整对话」；`delta` 是流式渲染片段，不属对话内容，该缺口应挂在「对话明细可回放」而非 AC-2。
- **口径订正 3（U23 A / BR-7、U27 A / AC-24、U28 A / Q-3）**：A 在这三条里把「v2.1 分支已实现」当成整条已实现，遗漏 `!v21SessionEventActive` 的 legacy 归档路径、`compactor` 无调用点两个事实——已分别在裁决 3 / 10 / 11 中订正。

## 与权威口径的一致性

- **失败消息占键**：`agent_messages` 主键 `(repo, issue_number, fingerprint)` + `ON CONFLICT DO NOTHING` + 判重不看 `status`，失败行永久占用同内容键。因此 **BR-3「上一轮失败的不算重复」不成立**、**AC-20「失败后原样重发能触发」不成立**，两条统一判：BR-3 部分实现、AC-20 与需求冲突，根因单列（`agent/store.ts:95-98`、`http/webhook-v21.ts:1038-1043`）。
- **U21 / U22 的「完全没有」核实**：模型角色四档（`agent/format/classify/兜底`）在契约、配置、运行时三层均 0 命中，不是「有一半」；个人 PAT 在表、列、契约、API、面板五处均 0 命中，也不是「有一半」。
