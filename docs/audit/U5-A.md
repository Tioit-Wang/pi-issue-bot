# U5-A 核查报告：FR-5.4 / FR-5.5 / FR-5.6

- 仓库：`C:\Code\NodeProjects\pi-issue-bot`
- 需求源：`docs/requirements.html`（FR-5.4 行 1037-1051、FR-5.5 行 1053-1060、FR-5.6 行 1062-1131）
- 核查方式：只读。逐条读源码 + 契约 + 测试，按「有没有真分支 / 真调用点」判状态，不采信注释自述。
- 状态取值：已实现 / 部分实现 / 未实现 / 与需求冲突 / 无法判定

> 一句话结论：**FR-5.4 的判定内核写得很完整但输入源给错了（看不到人的标签），FR-5.5 顺序执行到位但「失败不静默」只走到日志，FR-5.6 引擎六阶降级全部写完且单测很全，唯一缺的是「谁在请求发出前调用它」——整条自动压缩没有接在运行链路上。**

---

## FR-5.4 标签目标态与删除权

**状态：部分实现（核心判定已实现；「删除人的标签」这条实质能力不成立）**

### 证据

1. 目标态差集纯函数齐备
   - `apps/server/src/writeback/v21/labels.ts:135-200` `planLabelTargetState()`：`add = desired − current`、`remove = current ∩ 可管理目录 − desired`、`skipped` 留痕。
   - 边界①作用域（目录即全量）：`labels.ts:93-107` `unmanageableReason()` 把 `not-in-catalog / retired / unmanaged / missing-meaning` 四种原因分列；`labels.ts:83-85` `isManageableCatalogEntry()`。
   - 边界②空集保护：`labels.ts:139-147`，`desired.length === 0 && !clear` → `ok:false, reason:'empty-without-clear'`，**有真分支**。
   - 边界③超限整批拒绝：`labels.ts:149-156`，`desired.length > maxPerIssue` → `ok:false, reason:'over-limit'`，注释与实现都明确「不截断」。
   - 边界⑤`managed=false` → 既不删也不加：`labels.ts:191-197` 进 `skipped`。
2. 执行侧（写回）拒绝时不留半套：`apps/server/src/writeback/v21/execute.ts:515-530` `runLabel()` 先整批算 `plan`，`!plan.ok` 直接 `throw`（一条标签都不写）；`execute.ts:545-557` 先加后删。
3. 边界④删除留痕有实现：`labels.ts:130-132` `deletionOwner(label, botLabels) → 'bot' | 'human'`；`execute.ts:532-536` 为每个 `remove` 算 owner，`execute.ts:562-573` 把 `删 [label/bot|human]` 写进 `detail`，`run-task.ts:1424-1447` 落 `actions.audit.detail`。
4. 「不自动管理」标记存在（BR-11）：契约 `packages/contract/src/repo-config.ts:67,90`、`packages/contract/src/settings-v21.ts:269-288` 有 `managed` 字段；解析 `apps/server/src/config/v21-settings.ts:249-259` `resolveManagedCatalog()`；上限 `repo-config.ts:108` `max_per_issue`（默认 6，上限 20）。
5. 测试覆盖到真分支：`apps/server/test/writeback-v21-labels.test.ts:51-120`（空集 / 全空白 / clear=true / over-limit / unknown-label）、`:121-176`（差集 + 不可管理保护）、`:190-200`（owner）；`writeback-v21-execute.test.ts:223-262`（顺序执行、遇失败即停）。

### 缺口（关键）

- **执行侧拿不到 issue 的「当前全部标签」，拿的是自己的记账表。**
  - `apps/server/src/app/compose.ts:859-863`：`const currentLabels = await readAppliedLabels(pool, repo, issueNumber)`，并直接 `botLabels: currentLabels`（两个字段同一个值）。
  - `apps/server/src/app/compose.ts:1658-1678` `readAppliedLabels()` 的 SQL 是 `select distinct label from bot_labels where applied_at is not null and removed_at is null` —— 这是**我们打过、还没撤**的标签，不是 issue 现状。
  - 直连路径同样：`compose.ts:1427` `targets: createV21TargetContextPort({ pool, currentLabels })` → `apps/server/src/app/worker-deps.ts:1073-1086` 只是把同一个 `currentLabels` 转发。
  - 后果 A：人手动打的标签**永远不在 `current` 里**，因此永远不会进 `remove` —— 与需求「平台拥有删除权，包括删除人手动打的标签」直接冲突。
  - 后果 B：`deletionOwner()` 的 `'human'` 分支在生产路径**不可达**（`current ⊆ bot_labels`，判出来恒为 `'bot'`），「记录原主人是人还是机器」在数据上永远是「机器」。
  - 后果 C：需求注明的**前提**「执行侧输入必须包含当前全部标签」只有一半成立：`{{issue.labels}}`（webhook 载荷，`http/webhook-v21.ts:307-310,323`）与提示词事实层（`compose.ts:1297-1302`，其中 `labels` 仍来自 `readAppliedLabels`）里，**技能提示词中的「当前标签」也是记账表值**，不是 issue 现状。
- 判定内核本身没有 bug；这是**输入源错误**，所以「删除权」只对我们自己打过的标签成立。

### 附带发现（旧链路，与本条冲突）

- 旧 `label` 写回路径仍实现「人工删除 = 永久否决」：`apps/server/src/worker/writeback.ts:111-117,191-199` → `apps/server/src/workflows/normalize.ts:116` `human-veto`，装配在 `apps/server/src/app/worker-deps.ts:581`。v2.1 agent 路径没有这个概念（满足 BR-11），但 `source='command'|'pipeline'` 的任务仍走它。若这两条路径都要符合 BR-11，旧路径需要单独处理；本次只按 FR-5.4 所属的 v2.1 链路判分。

---

## FR-5.5 写回与失败处理

**状态：部分实现**

### 证据

1. 动作按顺序执行、失败即停、不静默吞：`apps/server/src/writeback/v21/execute.ts:414-457`（第 2 步 for 循环，`catch` 里 push `errors` + `stoppedAt = index` + `break`）；执行前整份拒绝见 `execute.ts:419-429`（开关未开一条都不执行）。契约明确「返回值永远不抛」：`execute.ts:408-413`。
2. 失败进库与事件流：`apps/server/src/worker/run-task.ts:1412-1419`（`envelopes.errors`）、`:1424-1447`（`actions` 行，`appliedAt: null`）、`:1457-1469`（`run_events` `writeback.v21.result`）、`:1470-1477`（`parse` 信号 → `failure_class`）。
3. 不合并 PR：全仓无 merge 能力，`apps/server/src/github/types.ts:113` 明确「这一层刻意**不含** merge」；`grep -i merge src` 仅命中 `merge-base`（branch-cleanup）、注释与 `reconcile` 的 `merged` 读取，无合并调用。
4. 「没拿到结论 ≠ 判定不合格」：`run-task.ts:1154`（只有 `turnResult !== undefined` 才校验信封）、`:1299`（只有 `v21Handled && v21Plan !== null` 才执行写回）、`:1245-1256`（兜底评论要求 `terminal === 'turn.completed'`）。超时 / 崩溃 / 不合契约时**标签与评论都不动**，这一条成立。

### 缺口

- **「至少有兜底反馈（如普通评论）」在 v2.1 路径上不存在。** `run-task.ts:1241-1243` 明确：`if (!v21Handled && …)` 才走 `postFallbackComment()`，注释写「v2 分支**不发兜底评论**」。于是 12 类动作里任一条失败（或被整份拒绝）后，issue 上**一个字的反馈都没有**，用户只看到 reaction `confused`（`run-task.ts:1629-1660` 的终态反馈）。
- 「后台告警」只有日志与指标，没有告警通道：`logger.warn` + `run_events` + `failure_class` + `metrics`（`apps/server/src/metrics.ts:26` 附近的指标名），没有任何主动通知/告警出口（全仓 `grep 告警|notify|alert` 无投递实现，`racp.ts:93-106` 的 `notify` 只是本地 promise）。
- 兜底评论模块本身是好的（`apps/server/src/worker/fallback.ts:281-347`，不抛、失败只落 `applied_at=null` 一行），只是被 `!v21Handled` 排除在 v2.1 之外。

---

## FR-5.6 上下文压缩

### 触发

| 子项 | 状态 | 证据 | 缺口 |
|---|---|---|---|
| 阈值从当前模型窗口现算、不做配置项 | 已实现 | `apps/server/src/compact/thresholds.ts:77-113`；`COMPACTION_DEFAULTS` `:39-50`；32k 下限保护 `:78-82` | — |
| 两条线：自动线=安全预算 90%，硬边界=预算本身 | 已实现 | `thresholds.ts:97-104`（`hardLimit = window − reserve`，`autoLimit = 0.9 × hardLimit`，`reason: hard/auto/below`） | — |
| 过硬边界不发送请求 | 已实现（引擎层） | `apps/server/src/compact/engine.ts:680-689` 返回 `compacted:false, reason:'hard-limit', error:'…拒绝发送请求'`；`:516-527` 无可压缩旧历史时同样拒发 | 引擎返回「拒绝」，但**没有调用方**（见下） |
| 检查点固定在请求发出前（新消息前 / 轮次边界 / 工具批次之后） | **未实现** | 全仓无调用点：`engine.ts:436` `compactSession()` 只被 `apps/server/src/app/worker-deps.ts:1032,1059-1067` 暴露、`apps/server/test/*` 调用；`worker-deps.ts:1028-1030` 与 `apps/server/src/app/compose.ts:880-881` 自述「只暴露不调用」；`apps/server/src/worker/run-task.ts:932-936` 自述「这里**不发起压缩**」 | 三处检查点一个都没挂 |
| 临近边界两档提醒模型收尾，每档只响一次 | **未实现** | 全仓无该逻辑：`compact/` 下无 nudge/tier 相关代码，`{{issue.labels}}` 之外无任何预算提醒；`db/schema.ts:439` 的 `last_nudge_at` 属于 `issue_states`（合规催办），与压缩无关 | 两档（还能用多少 / 现在就把必须留存的写下来）都没有 |

### 压缩方式

| 子项 | 状态 | 证据 | 缺口 |
|---|---|---|---|
| 结构化摘要覆盖切点之前全部消息 | 已实现 | `engine.ts:479-481`（`window.old` 即切点前全部）、`:537-548`（把 `old` 整段送摘要）；提示词 `apps/server/src/compact/summary.ts:131-145`「下面列出的**全部消息**，一条都不能漏」 | — |
| 摘要保留六要素（目标/约束与偏好/进度/关键决策/下一步/关键上下文） | 已实现 | `summary.ts:27-34` `SUMMARY_SECTIONS`；`summary.ts:121-129` 规则 3、规则 4（进度必须分已完成/进行中/受阻三档） | — |
| 精确文件路径 / 函数名 / 报错原文原样保留 | 已实现（靠提示词硬约束） | `summary.ts:122-123` 规则 1；执行层无法校验「原文是否被改写」（只有段落检查 `summary.ts:182-211`） | 无机械校验，只能算「提示词实现」 |
| 压缩区间读写过的文件清单由系统追加 | 已实现 | `summary.ts:219-246` `collectFileMentions()`（正则抠路径）；`engine.ts:488` 算、`:560,597,658` 拼、`:397-403` `withFileListNote()` 追加；兜底摘要也带 `engine.ts:343-346` | — |

### 压缩结果怎么放

| 子项 | 状态 | 证据 | 缺口 |
|---|---|---|---|
| 追加 checkpoint，不改写历史，原始一条不删 | 已实现 | `apps/server/src/compact/store.ts:32-37` 只有 INSERT（无 UPDATE/DELETE，`:10` 注释固定）；`engine.ts:491-514` 只写一行记录并返回视图，不触碰 `input.messages` | 记录会在**引擎被调用时**写；当前无调用 → 表实际为空 |
| 喂给模型的 = 从最新 checkpoint 重建，与后台是两套视图 | 部分实现 | `engine.ts:119-126` 返回 `view: { summary, messages }`，注释要求调用方据此重建；但 RACP 客户端没有 session/history 注入能力（`run-task.ts:414-417`、`worker-deps.ts:1051-1055` 自述），**没有任何代码把 `view` 喂给模型** | 「两套视图」只有数据结构，没有消费方 |
| 重建时保留最近一段真实消息 | 已实现 | `engine.ts:212-243` `selectRecentWindow()`（从尾部按 token 预算切、至少留一条、切点前移到非 tool 消息）；预算 `engine.ts:405-416`（20% hardLimit 且 ≥8k） | — |

### 多次压缩

| 子项 | 状态 | 证据 | 缺口 |
|---|---|---|---|
| 第二次不是重压全量，而是「上一版摘要 + 新增消息」更新式提示词 | 已实现 | `summary.ts:74-79` `isIncremental()`；`summary.ts:148-171` 增量提示词（保留/补充/迁移三分动作）；`engine.ts:539-544` 传 `previousSummary` | 增量靠调用方传 `previousSummary`（`engine.ts:103`），而当前无人调用 —— 生产上不会发生第二代 |
| 分块链式摘要，每块带上一块，最终收敛成一份，不允许拼接 | 已实现 | `engine.ts:610-663`（`planChunks()` `:251-289` 上限 16 块；`carried` 逐块传递；链断即 `chained=null` 转兜底，不拼接）；约束 `summary.ts:128`「禁止把多份摘要拼接」 | — |

### 工具输出三层

| 子项 | 状态 | 证据 | 缺口 |
|---|---|---|---|
| 执行时抓取有上限，超出落文件，正文留截断标记与文件路径 | 部分实现 / 与需求不符 | 沙箱只有**硬上限 + 布尔标记**：`apps/server/src/sandbox/protocol.ts:16,99-123`（1MB 上限，末帧 `truncated`）、`exec-proxy.ts:381-384` | 没有「超出部分落文件」也没有「文件路径」回填正文；`compact/truncate.ts:3-7` 注释把这层推给 sandbox，sandbox 侧未实现落文件 |
| 拼摘要时单条工具结果截到 2000 字符 + 「已截断 N 字符」标记 | 已实现 | `truncate.ts:26-31`（`first: 2_000`）、`:49-51`（`[已截断 N 字符]`）、`:96-109`；调用点 `engine.ts:531-536`（`truncate:2000`） | — |
| 仍超预算降到 500 字符并丢思考块，正文与入参不动、不删消息 | 已实现 | `truncate.ts:111-115`（`maxChars: 500` + `dropThinking: true`）、`:75-78`（`thinking` 置空，不删字段）、`:66-82`（map 不 filter，条数不变）；调用点 `engine.ts:570-575` | — |

### 保留策略（刻意偏离）

| 子项 | 状态 | 证据 | 缺口 |
|---|---|---|---|
| 保留真实最近窗口（含助手输出与工具结果），按 token 预算裁剪，摘要补窗口外旧历史 | 已实现 | `engine.ts:212-243`（窗口含 assistant/tool）、`:405-416`（预算）、`:479-486`（视图 = 摘要 + 窗口，`afterTokens` 同口径估算） | — |
| 必须同时剔除「工具调用已不在窗口内的孤儿结果」 | 已实现 | `truncate.ts:130-147` `stripOrphanToolResults()`（只有能查到调用方的 tool 结果才留，`toolCallId` 缺失也算孤儿）；调用点 `engine.ts:480`；测试 `apps/server/test/compact-truncate.test.ts:113-137` | — |

### 失败降级六步

| 步 | 状态 | 证据 |
|---|---|---|
| 1 预检（用实际发送内容估算 token） | 已实现 | `engine.ts:445-456`（`estimateMessagesTokens` 全文 → `planCompaction`），未过线不发请求不落库 `:458-467` |
| 2 摘要请求短重试 3 次、退避 2/4/8 秒；鉴权配额类首次即返回 | 已实现 | `engine.ts:37-40`（`SUMMARY_RETRY_BACKOFF_MS = [2000,4000,8000]`，`SUMMARY_MAX_RETRIES = 3`）；`engine.ts:352-380`（`isFatal` 立即返回，退避在 371-375）；`isFatalSummarizeError` `:159-192`（401/403/429 + quota/unauthorized 等关键词） |
| 3 一次有界削减（工具结果 500 + 丢思考块） | 已实现 | `engine.ts:568-607`（`TRUNCATE_LIMITS.second` + `dropThinking`，`maxRetries: 0` 只试一次） |
| 4 分块摘要（长区间切块链式） | 已实现 | `engine.ts:609-663` |
| 5 兜底 checkpoint（沿用上版摘要 + 真实最近窗口 + 明确标记） | 已实现 | `engine.ts:669-678` 调用 `:302-347` `buildFallbackSummary()`（有上版则沿用 + `[兜底 checkpoint · ISO] 本段历史未能生成模型摘要…`；无上版给六段骨架 + 首条用户消息摘录 + 文件清单）；`finish(…, true)` 置 `fallback=true` |
| 6 仍超硬边界 → 拒绝发送并明确报错、记录原因 | 已实现（引擎层） | `engine.ts:680-689`（`layers.push('hard-limit')` + `error` 含 hardLimit 与兜底视图 token） |
| 空摘要视为失败 | 已实现 | `summary.ts:199-211` `parseSummary()`：`trim()` 为空 → `ok:false, reason:'empty'`；缺段 → `'missing-sections'`；engine 三处调用都按失败降级（`engine.ts:555-566`、`594-604`、`646-651`） |

### 可观测

| 子项 | 状态 | 证据 | 缺口 |
|---|---|---|---|
| 每次压缩记录压缩前后 token、摘要长度、是否兜底、第几代 | 已实现（引擎 + 表） | `engine.ts:57-66,491-502`（`beforeTokens/afterTokens/summaryChars/fallback/generation`）；`store.ts:32-37`；表 `apps/server/src/db/schema.ts:793-817` | 只记 4 项 + 代数，**没记走了哪几阶**（`layers` 只返回给调用方，不入库）；且引擎未被调用 → 表无数据 |
| 后台会话详情能标出压缩点 | **未实现** | 无只读查询：`apps/server/src/queries/` 下 `grep compaction` 命中 0；`listCompactions()`（`store.ts:127-138`）**零调用方**；面板 `apps/panel/src` 下 `grep compaction|压缩` 命中 0（只有 `dist` 旧产物） | 面板/HTTP 没有任何读压缩记录的出口 |

---

## 本节整体结论

| 需求 | 状态 | 一句话 |
|---|---|---|
| FR-5.4 | **部分实现** | 目标态内核（空集保护 / 超限整批拒绝 / 目录外拒绝 / skipped 留痕 / owner 计算）全部实现且有单测；但 `current` 取自 `bot_labels`（`compose.ts:859-863,1658-1678`）而非 issue 实际标签，导致「删除人手动打的标签」不成立、`owner='human'` 不可达 —— 与需求正文冲突。 |
| FR-5.5 | **部分实现** | 顺序执行 + 失败即停 + 不落半套 + 不合并 PR + 无产出保持原状都成立；但 v2.1 路径**没有兜底评论**（`run-task.ts:1241-1243` 显式排除），后台只有日志/指标、无告警出口。 |
| FR-5.6 | **部分实现（核心能力未接线）** | 引擎本身是三条需求里最完整的：双阈值、六阶降级（含 2/4/8 三次退避、空摘要判失败、2000/500 分层截断、孤儿剔除、兜底 checkpoint、过硬边界拒发）逐条对得上，且都有单测（`test/compact-*.test.ts` 五个文件）。**但没有任何生产调用点**：`compactSession()` 从未在请求发出前被调用（`worker-deps.ts:1028-1030`、`compose.ts:880-881`、`run-task.ts:932-936` 三处自述「只暴露不调用」），两档临边提醒、请求前检查点、后台标压缩点、执行时落文件四项缺失，`agent_compactions` 基本只会记录 host 自报的 compaction 事件（`run-task.ts:419-452`）。 |

### 优先级建议（按需求影响面）

1. FR-5.6 接线：RACP 缺 session/history/compact 是硬前提；在此之前 `compact/` 整包只是库代码，需求「超过模型窗口时必须自动压缩」未达成。
2. FR-5.4 输入源：`current` 必须来自 issue 实际标签（`GET /issues/{n}` 或 webhook 载荷的 `issue.labels`），否则删除权与删除留痕两项形同空转。
3. FR-5.5 兜底反馈：v2.1 失败至少要有一条普通评论（或明确的产品决定「只靠 reaction」），否则「失败不得静默」不成立。

### 本次未做的核查

- 未运行任何测试/typecheck（只读核查，未改仓库）。
- 未核对面板 `dist` 产物与源码一致性（`apps/panel/dist` 有旧构建，未作为证据）。
- FR-5.6「提示词保留报错原文」只有提示词约束，无机械校验；未构造真实模型输出来验证摘要质量。
