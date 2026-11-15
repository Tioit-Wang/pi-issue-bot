# 第一批修复汇总（P0-1 / P0-2 / P0-3）

> 基线：`_baseline-fix.txt`（HEAD `fbfa029` + 已知未提交改动）
> 流程：3 个实现 session 并行 → 3 个独立 Review session 并行 → 编排侧按 Review 结论修正
> 最终验证：`tsc --noEmit` 通过；`vitest run` **120 文件 / 1526 通过 / 2 skipped / 0 失败**

---

## 一、结果总览

| 缺陷 | 实现 | Review 结论 | 编排侧处置 | 最终状态 |
|---|---|---|---|---|
| **P0-1** 会话被归档 | 方案 A：删掉轮换 | 有条件通过 | 接受；把「上下文无限增长」升级为 P0-5 前置依赖 | ✅ 通过（带前置条件） |
| **P0-2** 失败永久判重 | 改 `insertMessage` + 越界改了 `insertTask` | 有条件通过（第 2 处越界） | **回退第 2 处**，保留核心修复 | ✅ 通过 |
| **P0-3** 去重口径越界 | 收窄 `normalizeForIdempotency` | **打回**（漏改旧测试，全量红） | 补修 `agent-serial-queue.test.ts` | ✅ 通过 |

---

## 二、逐项详情

### P0-1 会话常驻（FR-3.4 / Q-3）

**改动**：`apps/server/src/app/compose.ts`
- 删除 `AGENT_SESSION_POLICY = { maxTurns: 30, maxAgeDays: 7 }` 与 `AgentSessionRotationReason`
- `AgentSessionPlan` 只剩 `session` 一个字段（删 `rotate` / `rotateReason` / `archiveSessionId`）
- `planAgentSession()` 去掉时间判定，只留三条规则：非 agent → ephemeral；无 id → 新建；有 id → 永远 attach
- 删除 `executeTask()` 里的 `channel.ops.sessionArchive(...)` 整块与 `v21SessionEventActive` 变量

**Review 验证的要点**：
- 全仓 `sessionArchive` 剩余 4 个调用点逐条核过，**没有一条能归档常驻会话**（`turn-driver` 的两处都有 `!persistent` 前置；`run-task` 那处只针对 ephemeral 首轮）
- `V21_SESSION_TRANSITION_SQL` 只写 `state/sandbox_id/closed_at`，不碰 `session_id`
- 全仓无 `DELETE FROM "agent_sessions"`
- 全仓零残留引用 `AGENT_SESSION_POLICY` 等被删符号

**⚠️ 前置条件（Review 提出，编排侧采纳）**：
删掉轮换后会话上下文会**无限增长**，而 FR-5.6 的压缩引擎目前**零生产调用方**（P0-5 未修）。因此：
> **P0-1 不能单独上线。必须与 P0-5（压缩接线）同批，或在中间加一个临时的上下文上限保护。**

这不是「遗留风险」，是硬依赖。

---

### P0-2 上次失败不参与去重（FR-3.5 / AC-20）

**保留的核心改动**：`apps/server/src/agent/store.ts`
```sql
ON CONFLICT ("repo","issue_number","fingerprint") DO UPDATE
SET "status" = 'queued', "updated_at" = now()
WHERE "agent_messages"."status" = 'failed'
RETURNING "created_at"
```
- `failed` → 重置为 `queued`，`inserted = true`，上层照常建任务入队
- `queued` / `running` / `done` → 不重置（保持幂等）

**回退的越界改动**：`insertTask` 的 `DO UPDATE SET status='queued'`

Review 用实测链路推翻了实现者的「否则队列卡死」论证：
1. `insertTask` 冲突时 `DO NOTHING` → `rowCount=0`
2. 落到 `findTaskIdByKey()` → **返回上一轮那条任务的 id（非 null）**
3. dispatcher 拿到非 null 的 taskId → 照常 `enqueue`
4. `queue.send` 的 `singletonKey` 是**消息粒度**（`agent:<repo>#<n>:<fingerprint>`），上一轮 job 已结束，能重投
5. `run-task` 按 taskId 直接开跑，**不检查 `tasks.status`**

→ 所以「重跑同一 task 行」本来就是通的。`DO UPDATE` 既改动了 `tasks` 的终态语义（违反 AGENTS §7.4 / §9 对入队字段与状态机的约束），又没解决任何真实问题。

**编排侧已回退并同步修正**：
- `insertTask` 恢复 `DO NOTHING`
- 两处注释改写，说明「为什么命中也要返回既有 id」（这是修复能生效的关键，原注释没讲清）
- 测试断言从「任务行变 `queued`」改为「任务行保持 `failed` 但返回旧 id」

---

### P0-3 去重口径收窄（FR-3.5 / :915）

**改动**：`apps/server/src/agent/canonical-text.ts`

| 项 | 改前 | 改后 |
|---|---|---|
| 抹代码区（`maskCodeRegions`） | ✅ 做 | ❌ 不做 |
| 去 `@handle` | ✅ 做 | ❌ 不做 |
| 删全部标点与符号 | ✅ 做 | ❌ 不做 |
| 压所有空白（含换行）成单空格 | ✅ 做 | ❌ 不做 |
| 合并连续空行 | ❌ 没做 | ✅ 做（`/\r?\n(?:[ \t]*\r?\n){2,}/gu` → `\n\n`） |
| trim | ✅ 做 | ✅ 做 |

**Review 抓到的问题（打回原因）**：
实现者只跑了 6 个选定文件，漏了 `apps/server/test/agent-serial-queue.test.ts:171` —— 那条 `L-02` 用例仍在断言旧口径（「只改标点算同一内容」），导致**全量测试是红的**。

**编排侧补修**：
重写该用例为四条独立断言，把口径钉死：
- 只多一个感叹号 → `enqueued`（新内容）
- 行内多几个空格 → `enqueued`（新内容）
- 完全一致 → `duplicate`
- 只差首尾空白 → `duplicate`（被 trim 掉）

**Review 的另一发现（已记录，未修）**：
mention 路径（`webhook.ts:1579` 走的 v0.3 链）在算指纹前还过 `stripAliases()`，它会压平行内空白。所以**两条路径口径不一致**：v2.1 评论路径行内空格算差异，v0.3 mention 路径不算。这属 v0.3 遗留，与本次 P0-3 无关，记为后续项。

---

## 三、实际执行的验证

```powershell
# 类型检查
cd apps/server; npx tsc --noEmit          → exit 0

# 定向测试
npx vitest run test/agent-serial-queue.test.ts  → 12 passed
npx vitest run test/app-agent-session-plan.test.ts → 5 passed

# 全量测试（最终态）
npx vitest run                            → 120 files / 1526 passed / 2 skipped / 0 failed
```

`2 skipped` 是原仓库既有的条件跳过（缺 Docker/git 环境），非本次改动引入。

---

## 四、未做的事与残余风险

| 项 | 说明 |
|---|---|
| **P0-5 压缩接线** | **成为 P0-1 的硬前置**。不修则会话上下文无限增长。 |
| **v0.3 mention 路径口径不一致** | `stripAliases` 仍压行内空白，与 v2.1 路径不同。属遗留，未修。 |
| 未提交 | 按任务要求**没有 `git add` / `git commit`**，改动都在工作区。 |
| 未跑面板测试 | 本次改动不涉及 `apps/panel`。 |
| 未跑 `pnpm lint` | 只跑了 `tsc` 与 `vitest`。 |

---

## 五、产物清单

```
docs/audit/fix/
├── _baseline-fix.txt        ← 修复前基线（含「不得回滚」清单）
├── P0-1.md                  ← 实现报告
├── P0-1-REVIEW.md           ← 独立审查（有条件通过）
├── P0-2.md                  ← 实现报告
├── P0-2-REVIEW.md           ← 独立审查（推翻第 2 处改动）
├── P0-3.md                  ← 实现报告
├── P0-3-REVIEW.md           ← 独立审查（打回）
└── SUMMARY-P0.md            ← 本文件
```
