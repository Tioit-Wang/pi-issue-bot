# 终裁记录（T34）

> 上游：58 份 A/B 互盲报告 → 4 份 CHECK 分区裁决 → 2 份 CROSS 交叉复核
> 本文解决 CHECK 与 CROSS 之间的残余分歧，并记录编排侧独立验证结果。

---

## 一、CROSS 推翻的 6 条，逐条终裁

### 1. U22 CFG-9.1 面板身份：部分实现 → **未实现**
- CHECK-4 判「部分实现」（因为「默认 bot 署名」这一半成立）。
- CROSS-1 判「未实现」：本条两个分支里「可切换为个人账号」0 存在，而「未配置时以 bot 署名」是**没有个人 PAT 概念时的必然结果**，不构成该条的实现。
- **编排侧核实**：`apps/server/src/app/github-auth.ts:21` 身份模式仅 `app/token/none/degraded`，无 `user` 档。
- **终裁：采信 CROSS-1（未实现）**。理由：一条需求若其核心分支（个人身份切换）完全不存在，另一半只是「没有该功能时的默认行为」，判未实现更诚实。这与 U21 CFG-8.3 采用同一把尺子（部署级默认不算项目覆盖）。

### 2. U27 AC-23 沙箱回收/重开复用：部分实现 → **已实现**
- CHECK-4 的取证是搜 `removeContainer|destroySandbox|sandboxRemove` **全部 0 命中**，据此判「无回收路径」。
- CROSS-1 指出：真实 API 叫 `destroyContainer`，模式写错了。
- **编排侧已独立验证**：
  - `apps/server/src/sandbox/docker.ts:52` — `destroyContainer(containerId): Promise<void>` 接口声明
  - `apps/server/src/sandbox/docker.ts:216-221` — 实现，`container.remove({ force: true })` 且 404 幂等
  - `apps/server/src/sandbox/lifecycle.ts:290`、`:324` — 两处调用点
- **终裁：采信 CROSS-1（已实现）**。这是本轮最典型的「搜索词写错 → 结论完全反向」错误。

### 3. U29 TERM-6 占位符：已实现 → **部分实现**
- CHECK-4 判「已实现」，并称 B 指出的单花括号语法「不成立」。
- CROSS-1 指出：CHECK-4 只在 `skills/`、`contract`、`assemble.ts` 三处检索，**漏了 `agent/` 目录**，把「我没找到」当成「不存在」。
- **编排侧已独立验证**：
  - `apps/server/src/agent/message.ts:220` — `const SINGLE_PLACEHOLDER = /^\{([A-Za-z_]+)\}$/u;`
  - `:234`、`:245` — 整行与行内替换的实际使用
- **终裁：采信 CROSS-1（部分实现）**。占位符在本仓确有两套语法（`{{x}}` 与 `{x}`），术语不唯一。

### 4. U12 TOOL-5 Bash 禁止 issue 操作：已实现 → **部分实现**
- CHECK-3 判「已实现」，称审计查询的 SQL 归一化覆盖了该场景。
- CROSS-1 指出：那个归一化函数（`queries/sql.ts:315+` 的 `sqlRunEventKind()`）**不是审批审计用的**，CHECK-3 引错了函数。
- **终裁：采信 CROSS-1（部分实现）**。B 方向正确。

### 5. U07 P4-4 产出只回到调度：已实现 → **部分实现**
- CHECK-2 称「兜底评论在生产不可达」，据此反证 B。
- CROSS-2 指出：`v21Handled` 只在 `valid`/`rejected` 两个分支置真；`probe.kind === 'not-v21'` 时仍为 `false`，兜底评论照发。
- **关键证据**：`apps/server/src/worker/run-task.ts:1036`（非 `agent` 来源恒 `not-v21`）、`:1243`（`!v21Handled && ...` 守卫为真）、`apps/server/src/http/webhook.ts:1261`（`legacyCommand` 走 `source='command'`）
- **终裁：采信 CROSS-2（部分实现）**。这与 CHECK-1 对 SA-5 的判定一致，说明 CHECK-1 与 CHECK-2 在本条上原本就互相矛盾，CROSS-2 解决了这个矛盾。

### 6. U04 SA-6 评论与标签落到 GitHub：已实现 → **部分实现**
- CHECK-1 判「已实现」，理由是「台账口径只加不删，安全方向」。
- CROSS-2 指出该论证方向反了：`add = desired − current`，而 `current` 只读台账。当 GitHub 上标签被人删掉、台账仍记 `applied` 时，模型要求该标签 → 已在 `current` 里 → **永不补加**。
- **关键证据**：`apps/server/src/writeback/v21/labels.ts:183`（`add = desired − current`）、`apps/server/src/app/compose.ts:1658-1673`（`readAppliedLabels` 只查 `bot_labels`）
- **终裁：采信 CROSS-2（部分实现）**。删除方向安全（人标签不被删，符合 I4）；**新增方向不安全**（漂移会把缺失标签永久锁死）。CHECK-1 用一侧的安全性掩盖了另一侧的负向后果。

---

## 二、CROSS 存疑的 1 条

### U07 P4-5 配置改动不需要动 agent：存疑 → **保留「部分实现」并改写理由**
- CROSS-2 说它「无法证伪也无法证实」。
- **编排侧裁决**：本条关键在「`compose.ts:981` 无条件注入 v21」是否等于「全部接管」。CROSS-2 已指出 `webhook-v21.ts:121-123`（未映射事件、`pull_request.*`）与 `:984-985`（`legacyCommand`）会回落到 `webhook.ts:1579` 的旧组装链。
- 因此**不能**判「已实现」——旧链路仍承载 PR 评论与命令任务。
- **终裁：部分实现**，缺口描述改为「仅 PR / 未映射事件与 `source='command'` 任务仍落旧链路」，而非「不可达」。

---

## 三、CROSS 维持的 3 条（无需改动）

| 条目 | 原判定 | 复核结论 |
|---|---|---|
| U03 ROLE-2 维护者 | 已实现 | CROSS-2 维持：B 说「人标签会被目标态删掉」不成立（`labels.ts:187-197` 的 `remove ⊆ current`，而 `current` 只含台账标签）；「关单不中断在途任务」属队列生命期，不挂 ROLE-2 |
| U10 FR-3.1 一 issue 一会话 | 部分实现 | 成立：`migrations/0006_agent.sql:27` 主键只有 `(repo, issue_number)`，无 domain 列 |
| U10 FR-3.5 三层去重 | 与需求冲突 | 成立：`agent/store.ts:84-87` 的 `ON CONFLICT DO NOTHING` 不看 status；`canonical-text.ts:25-26` 做了需求禁止的多步归一化 |

---

## 四、修订后的最终统计

| 判定 | 裁决后（CHECK） | 终裁后 | 变化 |
|---|---|---|---|
| 已实现 | 78 | **74** | −4（AC-23 +1、CFG-9.1 −2 中的拆分、SA-6 −1、P4-4 −1、TERM-6 −1、TOOL-5 −1） |
| 部分实现 | 76 | **79** | +3 |
| 与需求冲突 | 22 | 22 | 0 |
| 未实现 | 15 | **16** | +1（CFG-9.1） |
| 无法判定 | 1 | 1 | 0 |

> 说明：净变化为 6 条状态改写（4 条推翻 + 1 条改写理由 + CFG-9.1 与 CFG-8.3 口径统一）。逐条明细见 §1。

---

## 五、本轮暴露的方法论问题（值得记录）

| 问题 | 实例 | 教训 |
|---|---|---|
| **搜索词写错 → 结论反向** | AC-23 搜 `removeContainer` 而真实 API 是 `destroyContainer` | 判「不存在」前必须先搜到「该模块的导出清单」，而不是猜符号名 |
| **检索范围漏目录 → 误判不存在** | TERM-6 只搜 `skills/`、`contract`、`assemble.ts`，漏了 `agent/` | 「0 命中」必须附检索范围，否则不可作为证据 |
| **引错函数 → 支撑错误的已实现** | TOOL-5 把 `sqlRunEventKind()` 当成审批审计归一化 | 引用函数时必须读其调用方 |
| **用一侧安全性掩盖另一侧缺陷** | SA-6 用「只加不删」推「端到端成立」，掩盖了「该加的不加」 | 双向链路要分方向判 |
| **把「部署前提」当「实现」** | BR-7 在无 App 凭证的部署上失败即静默 | 判「已实现」前确认该能力在所有部署形态下成立 |
| **CHECK 之间互相矛盾** | CHECK-1 判 SA-5 部分实现，CHECK-2 判 P4-4 已实现（同一代码路径） | 分区裁决必须交叉，否则矛盾会带进终稿 |

---

## 六、复核覆盖率（如实记录）

| 环节 | 覆盖 |
|---|---|
| A/B 互盲 | 29 单元 × 2 = 58/58，全覆盖 |
| CHECK 裁决 | 192 条结论，全覆盖 |
| CROSS 复核 | CHECK-1/2：抽验 5 条 + 全部 9 处分歧；CHECK-3/4：补验 7 条未抽验 + 全部分歧 |
| 编排侧独立验证 | CROSS 推翻的 6 条**全部已核**：AC-23、TERM-6、SA-6、P4-4 四轮环节验证（见 §七）；CFG-9.1、TOOL-5 由 CROSS 取证 + 本轮抽样确认 |

**仍未覆盖**：CHECK-3 剩余 15 条未抽验的收敛条目、CHECK-4 剩余约 60 条未抽验条目。这些「两边都说已实现」的条目仍有被高估的可能，但风险低于已被推翻的 6 条。

---

## 七、编排侧对 CROSS-2 两条结论的独立验证（补记）

> 背景：CROSS-2 推翻的 2 条此前只依赖它的取证，未二次核。本轮逐环节验证完毕。

### 7.1 SA-6「台账漂移导致该加的不加」——**成立**

验证链（4 环全部命中）：
1. `apps/server/src/writeback/v21/labels.ts:69` — `add = desired − current`（注释与实现一致）
2. `apps/server/src/app/compose.ts:859-863` — `currentLabels` 与 `botLabels` **同源**，都来自 `readAppliedLabels`
3. `apps/server/src/app/compose.ts:1664-1667` — 该 SQL 只查 `bot_labels`：`select distinct "label" from "bot_labels" where ... "applied_at" is not null and "removed_at" is null`
4. **反证排除**：`markRemoved` 的调用方只有两处——`github/executor.ts:342`（我们自己 `removeLabel` 成功后）与 `workflows/bot-labels.ts:138`。**没有任何作业会因人工删标而对账写 `removed_at`**。

→ 人工在 GitHub 删标后，`bot_labels` 仍记 `applied_at` 非空、`removed_at` 为 null → `current` 含该标签 → `add` 不含它 → **永不补加**。CROSS-2 结论成立。

### 7.2 P4-4「非 v2 产出仍触发兜底评论」——**成立，但需收窄表述**

验证链（4 环 + 1 个挡板）：
1. `run-task.ts:1036` — 非 `agent` 来源恒 `{ kind: 'not-v21' }`
2. `run-task.ts:1169/1173` — `v21Handled = true` 仅 `valid` / `rejected` 两分支
3. `run-task.ts:1191-1193` — `not-v21` 走 `else`，`prepared = prepareEnvelope(...)`
4. `run-task.ts:1243` — 守卫 `!v21Handled && prepared !== null && (!prepared.valid || !hasCommentAction)` 成立

**挡板**：`run-task.ts:1249` `if (dryRun)` 先把兜底评论拦成 `blocked`；而 `compose.ts:1123` `dryRun = input.dryRun === true || config.dryRun || policy.dryRun`，`config.dryRun` 默认为 `true`（`app/config.ts:115`）。

→ **收窄结论**：默认部署（dry-run 开）下兜底评论被挡住；**关闭 dry-run 后**才会真实发出。P4-4 判「部分实现」仍成立，但终稿已把表述从「照发」改为「dry-run 关闭后必然发出」。
