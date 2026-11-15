# WP5 独立审查（压缩接线 / FR-5.6 / AC-24 / AC-25）

- 审查对象：`docs/audit/fix/WP5.md` 的声称 + 工作区里 `apps/server/src/compact/{window,remind,turn-compaction}.ts`、
  `apps/server/src/queries/compactions.ts`、3 个新用例、`runtime/turn-driver.ts`、`worker/run-task.ts`、
  `app/worker-deps.ts`、`app/compose.ts` 的改动。
- 审查方式：读代码 + 逐项反证 + 真跑（命令与输出见 §1）。**未改动任何代码，未 git add / commit。**
- 审查基线：`HEAD = fbfa029`，工作区含多个并行会话的未提交改动（怀疑对象是 `git status` 里那一批）。

## 结论三态：**打回**（接线部分可保留）

**打回**。理由不是「没接上」—— 接线是真的。打回是因为三条需求级不达标：AC-24 未实现；`turn/start` 收到的不是重建视图而是
「全量历史 + 附言」（上下文反而变大）；硬边界守的是一份假想视图而非真正发出的包。
若要按「有条件通过」处理，唯一可接受的改法是把它降级声明为「压缩观测 + 前缀式提醒」，并把 FR-5.6 / AC-24 / AC-25 在账上重新置为**未完成**。

### 必答一：所有 `turn/start` 调用点是否都在检查点之后？—— **是，无漏网路径**

- `driveTurn` 内 `ops.turnStart(` **只有 1 处**：`runtime/turn-driver.ts:444`，位于 `:428-441` 的检查点之后。
- 全仓 `grep turn/start` 的其余命中全是：`packages/racp-client` 的 operation 定义与参数校验、注释、测试假件。
- 生产里 `driveTurn` 只有一个调用方：`worker/run-task.ts:923`（全仓 `grep driveTurn(` 核对过）。
  因此 agent 轮、只读工具轮第 2–3 轮、审批后续、attach 失败降级、超时中断这些分支**都不存在第二个发送点**：
  审批与 `input/request` 在同一 try 块内就地应答（`turn-driver.ts:451-459` 的 `runEventLoop`），不重新 `turn/start`；
  RACP 客户端自身不重发（`packages/racp-client/src/client.ts:11`）。
- **唯一的「漏网」不是发送点，而是检查点的输入可能为空**：`session/attach` 不可用或失败时 `history = []`，端口原样返回（见必答二 a）。
  位置对了，但没有可压缩的东西。

### 必答二：装配链是否每一处都注入了 `compaction`？—— **都注入了，但有 3 条静默失效分支**

- 注入链完整：`app/compose.ts:1374`（每 run 绑 `repo` / `issueNumber`）→ `worker/run-task.ts:850` 取值、`:931` 传入 →
  `runtime/turn-driver.ts:435` 使用。没有第二条生产装配路径（`runTask` 全仓只有 `compose.ts:1282` 一个调用点）。
- 静默失效分支（注意：是「注入了但什么都不做」，不是「没注入」）：
  - (a) `session/attach` 缺失或失败 → `turn-driver.ts:600-618` 返回 `null` → `:546-548` 空历史 → `turn-compaction.ts:341-344` 原样返回；
  - (b) `ephemeral`（`/review-pr`、`@answer`、format/classify）与首轮无 `sessionId` → 无 attach → 空历史。**这条合理**（没有会累积的历史），用例也钉住了；
  - (c) 端口 fail-open：`turn-compaction.ts:430-437` 与 `turn-driver.ts:558-565` → 压缩器故障 = 按原文发送，只留一条 warn。
- 覆盖缺口：全仓 `compaction:` 只出现在 `compact-turn-driver.test.ts`，**装配链零运行时用例**；
  谁删掉 `run-task.ts:931` 那一行，`compaction` 是可选参数，连 `tsc` 都不会红。

### 必答三：AC-24 在默认配置下算「实现」还是「未实现」？—— **未实现**

- 默认配置没有摘要模型（`createUnavailableSummarize`，`turn-compaction.ts:462-468`），摘要恒走阶 5 兜底
  `buildFallbackSummary`（`engine.ts:302-347`）：目标 = 首条用户消息前 400 字；**「约束与偏好」= `（无 —— 兜底压缩未分析）`**；
  进度 = 「模型摘要生成失败……信息丢失」；关键决策 = 「（无）」。
- AC-24 要求「压缩两次后仍能复述第一轮的**目标与硬约束**」。约束这一栏在默认配置下是空的，所以判定**未实现**，
  不是「部分」—— 兜底摘要里没有任何一条硬约束，没有中间态可言。
- **反证陷阱**（写进结论以免被误用）：因为历史其实没删（见下一条），真机上模型**仍然能**复述约束，于是 AC-24 会「看起来通过」。
  但它通过的原因是**压缩没有发生**。拿这种观测当达成证据，等于用 P0-1 的缺陷给 WP5 记功。

### B3「前缀 ≠ 重建」是否等于上下文没变小、P0-1 的阻塞没解除？—— **是，两者都成立**

- checkpoint 只作为本轮 `turn/start` 的 `input.text` 前缀（`turn-compaction.ts:232-282`），发出去后它自己成为宿主历史的一部分
  （`turn-driver.ts:430-431`、`turn-compaction.ts:18-19` 均自述）；宿主历史一条不删。
- 下一轮历史来自 attach 快照，适配层只跳过宿主的 `itemType === 'compaction'`（`turn-compaction.ts:191`），
  我们塞进 user 消息的 checkpoint **不会被跳过**，会被重复计入并再进一次摘要。
- 所以每轮请求 = 全量历史（含此前全部 checkpoint）+ 本轮提示词 + 新 checkpoint，**单调递增**：
  压缩没有移出任何一个 token，反而每轮多一段。**上下文没有变小。**
- 结论：P0-1 把上下文治理整体推给 FR-5.6（`P0-1.md:68`），本包没有接住 → **P0-1 的阻塞未解除**，
  并且叠加了一个新的每轮增长源。这是判「打回」的第一条理由。

## 分轴判定

| 轴 | 判定 | 一句话 |
|---|---|---|
| **接线是否真的接上**（核心） | ✅ **成立** | `driveTurn` 内部**只有一处** `turn/start`，检查点就在它前面；装配链 `compose → runTask → driveTurn` 三处都传了，没有哪条生产路径漏传。 |
| **过硬边界不发送请求** | ⚠️ **机制成立、生产不可达** | 抛点确实在 `turn/start` 之前、抛后零 op 调用、用例是强断言；但它比的是**假想视图**，不是真正发出去的包，而按默认装配这个分支几乎永远走不到（§3.2 有代数证明）。 |
| **FR-5.6 核心目的（上下文不再无限增长）** | ❌ **未达成** | checkpoint 只是「本轮提示词前缀」，宿主历史一条不删；下一轮它自己又成了历史。**每次压缩让请求更大**，不是更小。 |
| **AC-24（压缩两次后仍能复述目标与硬约束）** | ❌ **未实现**（不是「部分」） | 兜底摘要在「约束与偏好」一栏写的是 `（无 —— 兜底压缩未分析）`（`engine.ts:331-332`）。默认配置下摘要里没有任何硬约束。 |
| **AC-25（后台可见记录 + 原始对话一条不少）** | ⚠️ **一半** | 记录落库 ✓、原文一条不少 ✓；「**后台能看到**」缺 HTTP 路由与面板（`queries/compactions.ts` 未登记进 `queries/index.ts`，`apps/panel` 零引用），且落库的 `after_tokens` 描述的是假想视图（§3.2）。 |

**总判断：接线本身是真的、可复现的，值得保留；但 WP5.md 的第 3 行结论「检查点真的接上了」把「机制存在」说成了「需求达成」。**
按 FR-5.6 的验收（AC-24 + 「喂给模型的内容 = 从最新 checkpoint 重建」+ 硬边界守真实请求），本包**应当以「未完成」回归**，
而不是以「已接线、两处子项部分」收口。下面 §3.1 / §3.2 / §3.3 是三条必须在上线前决定怎么办的理由。

---

## 一、实跑结果

在 `C:\Code\NodeProjects\pi-issue-bot` 下逐条真跑：

| # | 命令 | 结果 |
|---|---|---|
| 1 | `cd apps/server; npx tsc --noEmit` | **通过**（无输出，`EXIT=0`） |
| 2 | `cd apps/server; npx vitest run test/compact-turn-driver.test.ts test/compact-turn-port.test.ts test/compact-query.test.ts` | **3 files / 28 passed**，`Duration 9.64s` |
| 3 | `cd apps/server; npx vitest run test/compact` | **8 files / 107 passed**（与 WP5.md 的 8 / 107 一致），`Duration 16.08s` |
| 4 | `cd apps/server; npx vitest run`（全量） | **129 test files passed · 1616 passed / 2 skipped / 0 failed**，`Duration 251.03s` |
| 5 | `cd apps/server; npx eslint src/compact/*.ts src/queries/compactions.ts src/runtime/turn-driver.ts src/worker/run-task.ts test/compact-*.test.ts` | **0 problems**（无输出） |
| 6 | `pnpm lint`（全仓） | **0 errors / 6 warnings**，6 条全在 `scripts/spike/lib/*.mjs`（改动前既有） |

三点必须点名：

1. **WP5.md §6 里那「2 个失败」现已不复现**：`test/app-wiring.test.ts`、`test/v21-integration.test.ts` 在全量里都过了（129/129 文件全绿）。
   也就是说「失败与压缩无关」这一辩解不再需要，但反过来也说明**本包的全量结果不能用来证明它没引入回归**——那两条是被别的会话修好的，不是本包证明的。
2. **`pnpm lint` 里 WP5.md 提到的 `compose.ts:92 'timeoutMsForCommand' is defined but never used` 现在也没有了**（0 errors）。结论：那条 error 已被清掉，与 WP5 是否该修它无关。
3. **跳过的**：Docker / 真 git 的执行面用例（本包不触及执行面）、`pnpm gen:openapi`（未改契约 / schema，已核对 `packages/contract` 无 compaction 相关改动）。
   全量里的 2 条 `skipped` 是既有环境条件（`skipIf`），不混进「全部通过」。

---

## 二、需求逐条对照（只列与结论相关的）

| 需求原文 | 声称 | 审查判定 |
|---|---|---|
| FR-5.6 `:1067` 阈值从当前模型窗口**现算**，不做配置项 | 已实现（取数降级） | ⚠️ **不满足**。`window.ts:39-56` 是一张硬编码正则表 + `:21` 的 32_768 兜底。表本身不可配（所以不是「配置项」），但对**表外模型**它就是「一个固定数字」——正是需求这句话要否掉的东西。见 §3.3。 |
| `:1068` 两条线：自动线 0.9×安全预算 / 硬边界 = 安全预算；**过了硬边界不发送请求** | 已实现 | ⚠️ 两条线算得对（`thresholds.ts:77-114`），但「不过硬边界」这一条守的是假想视图（§3.2），且默认装配下走不到。 |
| `:1069` 检查点固定在「请求发出前」 | 已实现 | ✅ `turn-driver.ts:428-441`，在 `events/subscribe` 之后、`turn/start` 之前。 |
| `:1075` 摘要覆盖切点前**全部**消息 | 已实现（生产走兜底） | ⚠️ 生产永远走阶 5 兜底（没有摘要模型），兜底摘要不「覆盖」任何内容，它只是首条用户消息 400 字 + 文件清单。 |
| `:1076` 摘要必须保留目标 / **约束** / 进度 / 决策 / 下一步；精确路径、函数名、报错原文原样保留 | 提示词侧已实现 | ❌ 生产路径（兜底）里「约束与偏好」= `（无 —— 兜底压缩未分析）`，进度 = 「信息丢失」。见 §3.4。 |
| `:1082` 追加一条 checkpoint，不改写历史；原始对话一条不删 | 已实现 | ✅ 只 INSERT 一行 `agent_compactions`；用例用 `JSON.stringify` 前后比对钉住（`compact-turn-port.test.ts:283`）。这一条**是**本包做得最实的。 |
| `:1083` **喂给模型的内容 = 从最新 checkpoint 重建**；与后台对话是**两套视图** | 阻塞（降级） | ❌ 现在只有一套视图：宿主历史。前缀 ≠ 重建（§3.1）。 |
| `:1089` 第二次压缩用**更新式**提示词（上一版摘要 + 新增） | 提示词已实现；生产不适用 | ❌ 生产路径连「沿用上一版摘要」都没走到：端口不传 `previousSummary`（`turn-compaction.ts:347-354`），`buildFallbackSummary` 的 `previousSummary` 分支（`engine.ts:312-315`）永久失效，每代兜底内容几乎一样。 |
| `:1122` 仍超硬边界 → 拒绝发送 + 记录失败原因 | 已实现 | ⚠️ 拒绝分支存在，但默认装配下不可达（§3.2 末）；「失败原因」只以字符串形式进 `report`（`worker/failure.ts:47-54` 只保留 `code: message`），`details` 里那四个结构化字段只进日志。 |
| AC-24 压缩两次后仍能复述第一轮目标与硬约束 | 部分 | ❌ **未实现**（§3.4）。 |
| AC-25 后台能看到压缩记录（前后 token / 是否兜底 / 第几代），且原始对话一条不少 | 是 | ⚠️ 记录 ✓ / 原文 ✓ / **后台看不到**（无路由、无面板）、**前后 token 数字失真**（§3.2）。 |

---

## 三、发现的问题（按严重度）

### 3.1 【严重】压缩不减小上下文，反而让每次请求更大 → FR-5.6 的核心目的未达成

- 投递方式是前缀：`turn-compaction.ts:232-282`（`composeTurnText` 只把 checkpoint 拼到 `turnText` 前面）；
  `turn-driver.ts:443-447` 把这段文本作为 `turn/start` 的 `input.text` 发出去。
- 发起后它自己就变成宿主历史的一部分：`turn-driver.ts:430-431`、`turn-compaction.ts:18-19` 都自己写明了这一点。
- 下一轮历史从哪里来：`session/attach` 快照 → `messagesFromSnapshotItems()`（`turn-compaction.ts:181-221`）。
  它只跳过 `itemType === 'compaction'`（`:191`）——那是**宿主自己**的压缩标记；我们塞进 user 消息里的 checkpoint
  **不会被跳过**，会被当成正常历史再算一遍 token、再进一次摘要。
- 因此每一轮的请求 = 全量历史（含此前所有 checkpoint）+ 本轮提示词 + 新 checkpoint，**单调递增**。
  所谓「压缩」在这条链路里没有减少任何一个 token，反而每轮增加一个 checkpoint 的开销。
- P0-1（会话永不轮换）把上下文治理的责任整体推给了 FR-5.6（`P0-1.md:68`）。本包没有接住这个责任：
  **P0-1 的「上下文无限增长」仍然存在，而且多了一层每轮增长的 checkpoint。**

判定：WP5.md 的「阻塞（降级）」写法是诚实的，但它与第 3 行结论「检查点真的接上了」互相矛盾。
需求 `:1083` 要求的是「重建」，本包做的是「附言」。两者不是同一个能力的两阶段，而是**目的相反**：
一个是把窗口之外的历史挪出上下文，一个是把所有东西都留在上下文里再加一段说明。

### 3.2 【严重】硬边界的判据是一份「假想视图」，不是真正发出去的包

- 判据：`engine.ts:484-486` `viewTokensOf = estimateTokens(summary) + estimateMessagesTokens(viewMessages)`，
  在 `:561`、`:598`、`:659`、`:676` 四处与 `plan.hardLimit` 比较。
- 实际发送：全量历史 + 前缀（§3.1）。**两者不是同一个东西。**
- 后果 A（安全线失效）：真实请求超过 `hardLimit` 时，`viewTokensOf` 仍然很小 → `finish()` → `send:true` → **照发**。
  「过了硬边界不发送请求」（`:1068`、`:1122`）对真正的请求不成立。
- 后果 B（默认装配下这个分支基本走不到，代数证明）：
  - 走阶 6 拒发的条件是 `viewTokensOf(fallback) > plan.hardLimit`，而 `view` 的最近窗口按
    `resolveKeepRecentTokens()`（`engine.ts:406-416`）= `max(8000, 0.2×hardLimit)`（上限 `hardLimit`），
    兜底摘要本身 ~1k token。`0.2×hardLimit + 1k < hardLimit` 恒成立；
    只有「单条消息本身超预算、被 `selectRecentWindow` 强行保留」（`engine.ts:226-229` 的 `pickedNothingYet`）才可能挤过线，
    而单条条目在适配层被 `SNAPSHOT_TEXT_LIMIT = 8000` 字符截断（`turn-compaction.ts:86`）——极端 CJK 情况下才够得着。
  - 走阶 1 后的 `old.length === 0` 拒发分支（`engine.ts:516-527`）要求 `currentTokens ≥ 0.9×hardLimit` 且所有消息都落在
    `≤max(8000, 0.2×hardLimit)` 的窗口里 —— 两个不等式互斥（`hardLimit ≥ 16000` 恒成立），**该分支实际不可达**
    （只在「历史只有 1 条」时可达）。
  - 结论：`COMPACTION_HARD_LIMIT` / `send:false` 在默认装配下是**死路**。它会一路 `send:true`，
    直到 provider 返回 400（`context_length_exceeded`）——而需求要的正是「不要发一个注定被拒的包」。
- 后果 C（AC-25 的数字失真）：`agent_compactions.before_tokens / after_tokens` 落的是这份假想视图
  （`engine.ts:498-499`），对同一段历史会稳定写出「after < before」。后台（或将来接上的面板）看到的是
  「压缩省了 X token」，而真实请求更大。**这不是口径误差，是指标方向相反。**
- 后果 D（估算还漏了两块）：`turn-compaction.ts:347-354` 只把 `request.history` 传给引擎，
  `beforeTokens` 因此不含 system 通道的身份提示词（`session/create` 带的那份）与本轮任务提示词 —— 真实请求里它们都在。

### 3.3 【严重】32_768 兜底把「1M 窗口模型」变成「16k 预算模型」

- 表与兜底：`window.ts:21`（`FALLBACK_WINDOW_TOKENS = 32_768`）、`:39-56`（8 条正则）、`:78-97`（未命中即兜底）。
- 代入 `thresholds.ts:77-114`：未命中模型 → 无 `outputTokens` → `reserve = max(16000, min(8192, 0)=0, 1638) = 16000`
  → **`hardLimit = 16_768`、`autoLimit = 15_091`**（与用例里的 `16_768 / 15_091` 字面一致）。
- 对真实 1M 窗口模型，等于把自动压缩线压到真实能力的 **1.5%**（15 091 / 1 000 000）。后果按严重度排序：
  1. **过度压缩 + 记录刷行**：越过 15k 之后，**每一轮**都会重新走一遍引擎，落一条 `fallback=true` 的
     `agent_compactions`（`engine.ts:469-514` 每轮 `generation+1`）。该表**没有任何保留期作业**
     （`grep agent_compactions` 全仓无 retention 命中），是无界增长。
  2. **提示词反向施压**：checkpoint 头部写「上下文已接近安全预算……请立刻收敛」（`turn-compaction.ts:258-269`），
     模型会在任务还远没做完时开始收尾 —— 长任务质量直接下降。
  3. **误判硬边界导致任务失败**：只在「单条超预算消息」边角可达（§3.2），**不是**主要风险，但真实存在（`send:false` 无自动恢复，WP5.md 残余风险 #3 已承认）。
- 「这张表算不算配置项」——**判定：不算配置项，但算一个违反需求原意的硬编码数字**。
  需求 `:1067` 的理由原话是「一个固定数字无法同时服务 32K 和 1M 窗口」；`FALLBACK_WINDOW_TOKENS` 对表外模型做的正是
  「用 32K 的数字服务 1M 窗口」。表内命中（默认文档值 `deepseek-chat`，见 `docs/quickstart.html:59`）是准的；
  风险集中在自建代理 / 新模型名（`mistral`、`llama-3.3`、`yi-large`、`hunyuan`、`doubao`… 全落兜底）。
  建议的处理：兜底时**不要**同时把「自动线 / 硬边界」当成真实安全预算用 —— 至少把 `matched=false` 传成
  「只提醒、不压缩 / 不拒发」的弱策略，或者把兜底窗口提到 128K 这类主流下限。

### 3.4 【严重】AC-24 是「未实现」，不是「部分」

- 默认配置（没有摘要模型 → `createUnavailableSummarize()`，`turn-compaction.ts:462-468`）下，摘要正文来自
  `buildFallbackSummary()`（`engine.ts:302-347`）：目标 = 首条用户消息 `slice(0, 400)`；**约束与偏好 = 「（无 —— 兜底压缩未分析）」**；
  进度 = 「受阻：模型摘要生成失败……信息丢失」；决策 = 「（无）」。
- AC-24 的要求是「同一会话压缩两次后，模型仍能复述第一轮确定的**目标与硬约束**」。默认配置下摘要里没有约束。
- **必须点破的反证陷阱**：由于 §3.1（历史其实没删），模型在真机上**仍然能**复述第一轮约束 —— 它会「通过」，
  但通过的原因是「压缩根本没发生」，不是「摘要保住了信息」。拿这种观测当 AC-24 达成证据是自欺。
- 用例里的「AC-24 的最小证据」（`compact-turn-port.test.ts:286-302`）断的是「文件路径逐字出现」，不是「约束被复述」。
  文件名清单能证明「系统追加的文件清单没丢」，证明不了约束。

### 3.5 【中】端口接上了，但有三条「静默失效」路径，且装配链没有任何运行时用例

- (a) **`session/attach` 不可用 / 失败** → `turn-driver.ts:600-618` 返回 `null` → `:546-548` `history = []` →
  `turn-compaction.ts:341-344` 直接原样返回。宿主没有这条 operation 的部署、或会话被每日清理掉的场景，压缩静默不存在，
  而且此时 `driveTurn` 会新建会话继续跑（`P0-1.md:69` 残余风险 #2），表现为「历史莫名断了」而不是「压缩没生效」。
- (b) **首轮 / 非 agent 任务**（`ephemeral`，`/review-pr`、`@answer`、format/classify）→ 没有 attach → 无历史。
  这一条是**合理**的（没有会累积的历史），用例也钉住了（`compact-turn-driver.test.ts:271-288`）。
- (c) **端口 fail-open**：`turn-compaction.ts:430-437` 与 `turn-driver.ts:558-565` 双保险「按原文发送」。
  取舍本身可辩护（不判死任务），但**它与 §3.1/§3.2 叠加**后意味着：压缩器坏掉时表现与「压缩器没装」完全一样，
  只有一条 warn。
- **覆盖缺口（我认为这是本包最该补的一条）**：全仓 `compaction:` 只出现在 `compact-turn-driver.test.ts`。
  `compose.ts:1374` → `run-task.ts:931` → `driveTurn` 这条链**没有任何运行时用例**。
  `v21-worker-integration.test.ts` 的假 deps 传的是 `compactionStore`，不是 `compaction`。
  也就是说：谁删掉 `run-task.ts:931` 那一行，除了 `tsc` 没有任何测试会红；而 `compaction` 是可选参数，
  连 `tsc` 都不会红。**WP5.md 的核心声称（「真的接上了」）目前只由类型和一个可选字段保证。**

### 3.6 【中】AC-25「后台能看到」缺出口，且被标成了「是」

- `queries/compactions.ts` 写好了，但：`queries/index.ts` 里没有它（`grep compaction` 空）；
  `http/api/*` 无路由（只有 `webhook-v21.ts` 的写入侧钩子）；`apps/panel/**` 零引用（`grep compaction` 空）。
- 结论：数据在库里，**后台看不到**。WP5.md §2 第 27 行写了「部分 / B6」，但 AC-25 行标了「是」——两处自相矛盾，应以「部分」为准。

### 3.7 【中】第二次压缩不是更新式（与需求 `:1089` 冲突，且被 §3.2 掩盖）

- `createTurnCompaction` 传给引擎的 `CompactInput` 只有 `repo / issueNumber / sessionId / windowTokens / outputLimitTokens / messages`
  （`turn-compaction.ts:347-354`），**没有 `previousSummary`**。
- 于是 `buildFallbackSummary` 的「有上一版摘要 → 原文沿用」（`engine.ts:312-315`）与链式摘要的 `carried`（`:614`）在生产路径永远拿不到上一版。
- 现象：`generation` 逐轮递增，但每一代的摘要正文几乎一样（都是「首条用户消息 400 字 + 文件清单」）。
- WP5.md 第 42 行的辩解（「此时走增量会把同一段历史计两遍」）只对「真模型摘要」成立；兜底路径的问题正好相反 ——
  **它连一次增量都没做**，所以「第二次压缩不重压全量」这条在兜底路径上完全失效。

### 3.8 【低】注释与实现互相否定（会误导下一个维护者）

- `worker-deps.ts:1035-1037`：「**本轮只暴露、不自动调用**……请求前自动压缩还接不上」——本包已接上。
- `worker-deps.ts:1058-1062`：「host 侧不暴露 session/history，本轮不会在请求发出前调用它」——同上。
- `http/webhook-v21.ts:1052-1057`：「请求前自动压缩因此还接不上」——同上。
- 这三处都是**同一批改动里没有一起改的**陈注释。AGENTS §11 要求注释解释「为什么」，现在它们解释的是错的事实。

### 3.9 【低】`createV21Compactor` 成了无生产调用者的出口

- `worker-deps.ts:1039` 仍导出，`compose.ts` 已删掉唯一使用点（原来那个恒不调用的 `v21RunnerHooks.compactor`）。
- 现在只剩 `v21-worker-integration.test.ts:840-842` 在断言它「是函数」。属无害死代码，但会是下一个人的困惑源。

---

## 四、越界与误伤

### 4.1 `worker/run-task.ts`：**干净**，只有 3 个 hunk

`git diff -- apps/server/src/worker/run-task.ts` 的全部内容：

1. `+import type { TurnCompactionPort }`；
2. `V21RuntimeConfig.compactor?: unknown` → `compaction?: TurnCompactionPort` + 注释重写（`:197-207`）；
3. `const compaction = deps.v21?.compaction`（`:850`）+ `...(compaction === undefined ? {} : { compaction })`（`:931`）。

**没有**夹带其它改动（`git diff --stat` = 23 行改动）。越界理由（端口只能由调用方传，`recordingOps()` 逐方法显式委托所以不能挂 `ops`）成立。

### 4.2 `app/compose.ts`：**只动装配压缩的行**，但这份 diff 里混着三个会话的改动

`git diff --stat` = +103 / −116（196 行），其中：

| 归属 | 内容 | 判定 |
|---|---|---|
| WP5 | import 换 `createV21Compactor` → `createV21TurnCompaction` + `createReminderLedger`（`:112-114`）；`compactionReminderLedger`（`:816`）；删 `compactor: createV21Compactor`（原 `:852`）；便于逐 run 绑 repo 的 `compaction:` 装配（`:1374-1391`）；相关注释 | **本包该动的行，一处不多** |
| P0-1（同一会话上一包） | 会话轮换整块删除（`AGENT_SESSION_POLICY`、`rotate*`、`archiveSessionId`、`sessionArchive` 块） | 已由 `P0-1.md` 认领 |
| WP7（并行会话） | `timeoutMsForCommand` → `turnTimeoutMsFor(command, resolveTurnTimeoutMinutes(...))` + import 变更 | 不是本包的 |
| 其它会话 | `panelDistDir` 注入 | 见下 |

- **`panelDistDir` 一行未动：证据支持**。`P0-1.md:6` 记录它在 `:911-912`，现在在 `:918-920`，
  正好等于本包在它前面新增的行数（ledger 注释 7 行 + 代码 1 行）。内容与 `git diff` 的 `+` 行一致，无改写痕迹。
- **`v21RunnerHooks.compactor` 无残留引用**：全仓 `grep compactor` 只命中 `worker-deps.ts` 的导出、
  `compact/engine.ts` 的 `createCompactor`、以及测试。删得干净。

### 4.3 「不许改」清单核对

`db/schema.ts`、`packages/contract/**`、`agent/**`、`writeback/**`、`queries/deliveries.ts`、`apps/panel/**`：
本包声称未改 —— 与 `git status` 里这些文件的改动归属（WP7/P0-3/P0-2）一致，**未发现本包越界改动**。

### 4.4 AGENTS.md 硬规则

| 规则 | 结果 |
|---|---|
| 无 `any` / `as any` / `@ts-ignore` / `@ts-expect-error` | ✅（4 个新源文件 + 3 个新用例，grep 无命中；`as Record<string, unknown>` 属既有 `asRecord()` 惯用法，非 `any`） |
| 新用例无 `vi.mock` / 快照 / `useFakeTimers` / `sleep` | ✅（唯一命中是 `compact-turn-port.test.ts:9` 的注释文字；`sleep` 由 `unavailableDeps()` 注入并断言 `sleeps=[]`） |
| 时间注入 | ✅（引擎用 `deps.now`；`window.ts` / `remind.ts` / `turn-compaction.ts` 无时间依赖） |
| 新模块 ≤ 500 行 | ✅（`turn-compaction.ts` 468、`remind.ts` 174、`window.ts` 98、`queries/compactions.ts` 85） |
| `queries/` 只读、不 import 业务模块 | ✅（只 import `./sql.ts`，只有 SELECT） |
| 不新增错误码到契约 | ✅（`COMPACTION_HARD_LIMIT` 只是 `AppError.code`，无面板映射 —— 但这也正是 §3.6 的一部分：面板看不到它） |

---

## 五、不确定处（我没有证据下结论的）

1. **真机上 `SessionSnapshot.items` 是否真的带历史、带多少**。协议层是有的（`packages/racp-client/src/schema.ts` 的
   `ItemSummary[]` + `hasMoreHistory`），但本机没有 pi-host bundle，WP5 也只做了类型级适配。
   如果真机 `items` 只给「活动条目」或干脆为空，`turn-compaction.ts:341-344` 会让压缩**永远静默 no-op** ——
   这是 §3.5(a) 的一个更坏的版本，我无法在本机证实或证伪。**建议上线前在真机打一条 info：`history.length` / `historyComplete`。**
2. **估算口径与 provider 真实 token 的偏差量级**。`tokens.ts` 是「CJK 1 字 1 token / ASCII 4 字 1 token」的估算，
   §3.2 的「假想视图」问题与之独立；但「真实请求是否真的会撞 400」取决于这二者的叠加，我没有做真机对照。
3. **`config.model.name` 是否等于宿主实际加载的模型**。`model-env.ts:15` 说它是「pi-host 的默认模型名」，
   我按此认定它是合法的身份事实（所以 §3.3 只判表 + 兜底，不判「拿错模型名」）。
   但若部署时 `PI_BOT_MODEL_NAME` 与实际加载的模型不一致（宿主侧另有配置），窗口会整体算错，这一条我无法验证。
4. **`agent_compactions` 是否被别处的保留期作业间接覆盖**。我在 `apps/server/src` 全量 grep 未命中 retention，
   但 `jobs-*` 的 SQL 是按表名拼的，可能有我没读到的动态路径（`migrations/` 里也没有清理该表的迹象）。
5. **WP5.md 里几个行号的小漂移**：它写台账在 `compose.ts:809 附近`，实际是 `:816`；`panelDistDir` 它没提具体行。
   其余引用（`turn-driver.ts:428 / 265 / 535`、`turn-compaction.ts:329 / 239 / 181`、`remind.ts:46 / 125`、
   `window.ts:78`、`worker-deps.ts:1097`、`run-task.ts:850`、`queries/compactions.ts:78`）**逐个核对全部命中**，
   这一项是可信的。
