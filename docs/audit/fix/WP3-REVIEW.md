# WP3 审查 · 标签三件套（FR-5.4 / FR-5.5 / BR-11 / AC-15 / LD-1 / LD-2）

审查者：独立 review session（角度：**安全与不变式**；默认假设实现有问题，主动找反证）
被审对象：`docs/audit/fix/WP3.md` 的四条「已改完」声称 + §三的 I4 裁决。
必读依据：`AGENTS.md` §4 十条不变式（尤其 **I4**、I10）、`AGENTS.md` 开头的「产品行为以需求正文为准」与优先级声明、`docs/requirements.html` 的 FR-5.4（`:1038`）/ FR-5.5（`:1052`）/ BR-10（`:1795`）/ BR-11（`:1796`）/ BR-12（`:1797`）/ AC-15（`:1863`）/ §6.5（`:1589`）/ 修订记录（`:425`）。

审查口径声明：工作区同时挂着 WP1~WP13 的改动（`git status` 是 100+ 个 M + 38 个未跟踪），**git 无法按包归属**。本报告用「diff 里是否出现本包标识」判定足迹：`writeback/v21/labels.ts` 的 diff **只有注释**（已核对，见 §二-1）、`workflows/*` 与 `worker/writeback.ts` 的 diff 是本包主体、`compose.ts` / `worker-deps.ts` 的 diff 与他人改动交织（这两个文件我按区域读代码判定，不按 diff 判定）。

---

## 结论：**有条件通过**

技术方向我认可：`current` 从「自家台账」换成「GitHub 实况」是本包唯一正确的根因修复，四条缺陷的**代码**确实都动了，且没有把安全边界整体拆掉（可管理目录 / `managed=false` / 无含义不删 / 空集保护 / 超限整批拒绝全部还在）。

但它**不能按「I4 已裁决」验收**，理由三条：

1. **裁决只存在于 WP3.md 里，规范没动。** `AGENTS.md:65` 的 I4 原文仍是「标签只撤 `bot_labels` 记过的 / 破坏后果：撤掉人打的标签」，`docs/requirements.html:1863` 的 AC-15 仍是「人工删除后不会被自动加回」。两份规范现在都与代码**文字相反**，而且需求正文**自己内部矛盾**（BR-11＋FR-5.4 vs AC-15，见 §一-2）。按 `AGENTS.md` §1「同批修文档」与 §14，这是必须由编排侧/人处理的门禁项，不是「本包权限外」就能挂账的。
2. **新增了一条能静默删除人手动标签的路径**，且没有守卫、没有告警：`readLiveLabels` 读失败返回 `[]`（`compose.ts:1807-1825`），而提示词用的读（`:1254`）与执行时刻的读（`:951`）是**两次独立请求**。第一次失败 → 模型看不到「当前标签」→ 目标态按「本来没有标签」写；第二次成功 → `remove = 实况 ∩ 可管理目录 − desired` 把人刚打的标签删掉。这正是 FR-5.4 `:1049` 明令禁止的「看不到全量就输出目标态，等于盲删」。
3. **「可审计可回滚」不成立**：人打的标签被删时 `bot_labels` **零行**（`recordRemoved` 是 `UPDATE`，见 §一-3），`owner` 只落在 `actions.audit.detail` 的自由文本里，且 `reconcile` 只认 `intent='label'`，v2.1 写的是 `v21:label` → 撤标**没有改回检测**。

四条条件见 §四 P1 三段 + §四 P2-1，其中 P1-3（规范同批修）需要人批，其余是几行到十几行的代码。

---

## 一、I4 vs FR-5.4 的裁定

### 1.1 两份原文（逐字）

| 出处 | 原文 |
|---|---|
| `docs/requirements.html:1040`（FR-5.4，P0） | 「平台与当前实际标签对齐。平台拥有**删除权**，包括删除人手动打的标签。」 |
| `docs/requirements.html:1049`（前提） | 「执行侧的输入必须包含**当前全部标签**……看不到全量就输出目标态，等于盲删。」 |
| `docs/requirements.html:1047`（BR-11 同义） | 「**人工删除不构成永久否决**：下一轮按目标态重新对齐……不是靠「删过一次」隐式推断。」 |
| `AGENTS.md:65`（I4） | 「标签只撤 `bot_labels` 记过的」→ 破坏后果「撤掉人打的标签」 |

### 1.2 判定 1：这个裁决**化解了字面冲突，但没有化解规范状态**

- **字面上成立**：I4 与 FR-5.4 的冲突是**真冲突**（同一集合 `remove`，一个要求 ⊆ `bot_labels`，一个要求包含人打的标签），不可能同时满足。WP3 选 FR-5.4 是对的选择，理由见 1.3。
- **但它把 I4「架空」了，而且没有替换物落纸**。WP3 §三-1 说「I4 的真实保护对象是目录外/不可管理的标签」——这个解释是**事后的**：I4 的字面内容是「只撤 `bot_labels` 记过的」，与「目录外」无关；旧实现里「目录外不删」是 `planLabelTargetState` 规则 4 给的，**与 I4 无关**（`writeback/v21/labels.ts:22-25` 的注释在 WP3 之前就写着「删除只发生在可管理集合内」，diff 证明那段行为一行没改）。所以「I4 保护的是目录外标签」这个说法，是把**另一条不变式**（BR-9/BR-11/BR-12）的功劳记到 I4 头上。
- **后果是现实的**：`AGENTS.md` 是给后续 agent 读的执行规范。它现在写着「撤掉人打的标签 = 破坏不变式」，而代码正在这么做。下一个 agent（或下一个人）照 I4 改回去，就是一次合规的「修复」，然后再被 FR-5.4 打回——这种反复在 `AGENTS.md:65` 未改之前是必然的。
- **需求正文自己也矛盾**：`:1863` 的 AC-15 仍在，且与 BR-11 相反。WP3 §二-缺陷2 说「AC-15 已被 BR-11 与 FR-5.4 推翻」——**依据只有 `:425` 的修订记录**（「BR-11 改为显式『不自动管理』标记（取消『人删过永久不加回』）」）。我核对过：`requirements.html` 里**没有任何一处**标注 AC-15 已作废，`grep ac-15` 只命中那一行定义。所以准确的说法是「AC-15 是那次修订的漏改项」，不是「被推翻」。验收者拿 AC-15 当标准时，这个实现是**不通过**的。

### 1.3 判定 2：冲突时谁优先 —— **FR-5.4 优先，但优先级链要写清**

依据是 `AGENTS.md` 开头：「产品行为以**需求正文**为准，测试做法以测试规范为准，**工程约束以本文件为准**」。

- I4 虽然住在「工程约束」文件里，但它规制的是**产品行为**（哪些标签会被摘掉），不是工程手段（怎么实现、依赖方向、性能）。按上述分工，产品行为归需求正文 → FR-5.4（P0）优先。
- 第二句「优先级：正确性 > 数据安全 > 安全边界 > 向后兼容 > 架构完整 > 可测试性 > 交付速度」是**质量项之间的排序**，不是**规范源之间的排序**。拿它压需求是误用：它说的是「在都必须满足时先保谁」，不是「安全边界条款可以覆盖产品需求」。
- 还有一条独立的支持理由：**I4 从未被任何测试或门禁固化**。我查了 `apps/server/test`——`no-merge.test.ts`（I1）这类「扫源码钉不变式」的范式只覆盖 I1，I4 没有对应扫描测试，也没有一条用例断言 `remove ⊆ bot_labels`。也就是说 I4 一直是靠人读文字遵守的，`bot_labels` 当 `current` 是**实现巧合**，不是被守住的约束。
- 结论：**WP3 的选择正确**，但正确做法的完整形态是「FR-5.4 胜 + I4 同批改成新边界」，WP3 只做了前半句。建议照它 §三 的建议改，但要写死判据而不是含糊的措辞：`remove ⊆ {目录内 ∧ status='active' ∧ managed!==false ∧ meaning 非空} ∧ 每次删除在 bot_labels 或 actions.audit 留下 owner`。

### 1.4 判定 3：`deletionOwner()` 让撤人标签「可审计可回滚」吗 —— **可审计（弱）、不可回滚**

事实链：

| 环节 | 代码 | 事实 |
|---|---|---|
| owner 计算 | `writeback/v21/execute.ts:532-535` | 只算出 `Record<label, 'bot'\|'human'>`，用于**拼一句话** |
| 落库 | `worker/run-task.ts:1407-1430` | 只有 `intent='v21:label'` + `audit={source,contract,index,type,outcome,detail,dryRun}`；`detail` 里是 `删 [需求/human]` 这种**自由文本** |
| 台账 | `worker/run-task.ts:385-392` → `workflows/bot-labels.ts:96-106` | `recordRemoved` = `UPDATE bot_labels SET removed_at=... WHERE label = ANY(...)`。人打的标签**没有那一行** → 影响 0 行 → **不留任何记录** |
| 改回检测 | `jobs/reconcile-reverts.ts:296` | `if (candidate.intent === 'label')`；v2.1 写的是 `v21:label` → **这条规则对 v2.1 永不命中** |

所以：

- **可追溯性**：只到「`actions.audit` 里有一句 `detail` 含 `/human`」这一级。要回答「本周我们删了几个人打的标签、分别是谁的、哪个仓库多」，得 `like '%"detail":"%删 [%,human%'`——这是审计，不是可查询的审计字段。BR-10（`:1795`）要求「记录原主人（人/机器）与删除原因，**可复盘**」；**删除原因完全没有记录**（`desired` 不含它 = 原因，但哪个 desired 导致的没有落到任何列）。
- **可回滚性**：**没有**。GitHub 上没有「撤销一次删标」的接口，平台也没有保存「删之前的标签集合」。理论上 `detail` 里能反解出被删的名字（只要是人读得懂的那串），但没有任何自动化路径，且 `reconcile` 不认这类 action。**风险**：一次误删（模型漏写目标态、或 §一 那类读失败）之后，只有等下一轮事件、模型恰好又想打那个标签时才可能回来；人的组织意图（例如手工加的 `待确认`）可能永久丢失，且**没有任何告警**。

**这不是 WP3 新引入的**（`deletionOwner` 的语义 WP3 没改，脚本也只是从「几乎总是 bot」变成「经常 human」），但 FR-5.4 生效后它从「理论风险」变成「常态路径」，所以必须在这一包里补：至少把 `owner` / 被删标签数组写进 `actions.audit` 的结构化字段，并在 `bot_labels` 里为 human 标签插一行 `applied_at=null, removed_at=now`（表结构支持，`applied_at` 可空，见 `db/schema.ts` 的 `bot_labels` 定义）。

### 1.5 判定 4：破坏性操作有哪些闸门 —— **没有一道是专门为撤标设的**

| 候选闸门 | 实际覆盖 | 证据 |
|---|---|---|
| dry-run 默认开（I2） | **有效**。`PI_BOT_DRY_RUN` 缺省 `true`；标签动作在 dry-run 下提前返回，且不写 `actions` 行（I3 零副作用） | `app/config.ts:124-125`；`writeback/v21/execute.ts:538-543`；`worker/run-task.ts:1404-1410` |
| 写回闸门「推送集 = declared ∩ actual」 | **零覆盖**。它只管 git push | `git/writeback-gate.ts:4`；`git/paths.ts:11-13,157` |
| 受保护路径 | **零覆盖**。同上，git push 专用 | `git/paths.ts:41-42` |
| 槽位（I5，(repo,issue,slot) 覆盖） | **零覆盖**。槽位只作用于评论（`writeback/v21/comments`），撤标是**按标签名逐个 DELETE**，没有 slot、没有去重 | `writeback/v21/execute.ts:555-557` |
| 目录边界（BR-9/BR-11/BR-12） | **唯一的实质闸门**。`remove = current ∩ 可管理目录 − desired`，其中「可管理」= `status='active'` ∧ `managed!==false` ∧ `meaning` 非空 | `writeback/v21/labels.ts:88-113,184-203` |
| 空集保护 / 超限整批拒绝 | **有效**，但只防「整体清空」与「一次加太多」，不防「少写一个名字」 | `writeback/v21/labels.ts:145-162` |

两个必须写下来的结论：

1. **「撤标必须经槽位」这个说法不成立**，也不该成立（槽位是评论的覆盖语义）。所以撤标**没有幂等锚**：同一轮重复执行 = 重复 DELETE（GitHub 对不存在的标签返回 404，会被执行器当失败）。
2. `managed` **缺省是 true**（`contract/src/settings-v21.ts:342`、`contract/src/repo-config.ts:100-101`、`config/v21-settings.ts:327`）。也就是说：一个进了词表、填了含义、人从没碰过 `managed` 开关的标签，**默认就在可管理范围内**。I4 在时，「它是不是我们打的」这道天然闸门存在；I4 让位后，**默认值是唯一的最后一道闸**。这是 WP3 裁决里最需要人拍板的一点：`managed` 默认 true 是否仍然合适。如不合适，正确做法是「词表里新出现的标签默认 `managed=false`，人显式打开才纳入对齐」——那才是 I4 精神（谁打的、谁负责）在 FR-5.4 框架下的合法延续。

---

## 二、四条缺陷逐条判定

| # | 声称 | 我的判定 | 关键证据（行号已核对） |
|---|---|---|---|
| 1 | FR-5.4 删除权包括人打的标签 | **已实现（有条件）** | 见下 2-1 |
| 2 | BR-11 / AC-15 人工删除不构成永久否决 | **就 BR-11 已实现；就 AC-15 相反；需求未同批修** | 见下 2-2 |
| 3 | LD-1 颜色/描述来自 GitHub、不反向维护 | **部分**（「不下发」已净，「来自 GitHub」零实现） | 见下 2-3 |
| 4 | LD-2 不发明标签、不反向创建 | **已实现**（服务端净），面板仍提供无效选项 | 见下 2-4 |

### 2-1 · FR-5.4 删除权 — 已实现（有条件）

成立的部分：

- `compose.ts:947-952`：`currentLabels = readLiveLabels(...)`（GitHub 实况）与 `botLabels = readAppliedLabels(...)`（台账）**分开读**，`botLabels` 只喂 `deletionOwner`。`compose.ts:1251-1254` 的提示词/目标态也改用实况（`:1411` 把实况放进 `{{issue.labels}}` 的上下文）。
- `createV21TargetContextPort`（`worker-deps.ts:1142-1171`）注释与字段口径正确。
- `writeback/v21/labels.ts` 的 diff **是纯注释**（我核过 `git diff`），规则 4 的行为没被改——即「行为本来就对，缺的是 `current` 从哪来」这个判断是**准确**的。
- `readLiveLabels` 用的是 `GET /repos/{o}/{r}/issues/{n}` → `IssueSnapshot.labels`（`github/octokit.ts:309-326` + `normalizeLabelNames:338-356`，同时接受 `string[]` 与 `{name}[]`），实现正确。

条件（详见 §四）：

- **P1-1**：读失败静默 → 与「提示词/执行器两次独立读」组合成盲删路径。
- **P1-2**：删人标签不留台账行、`owner` 只在自由文本。
- **P2-1**：这条根因没有一条集成测试锁住（把 `compose.ts:951` 改回 `botLabels`，全部 1763 个用例依旧全绿——因为 `v21-worker-integration.test.ts:348` 的假件恒返回 `{currentLabels: [], botLabels: []}`，没有任何用例让「实况」与「台账」不同）。

### 2-2 · BR-11 / AC-15 — 就 BR-11 已实现，就 AC-15 相反

成立的部分（全部核对过，`human-veto` 在 `apps/`+`packages/` 的 `src` 里**已无实现残留**）：

- `workflows/normalize.ts` 只剩 5 条规则（`:123-213`），`LabelBlockedReason` 无 `human-veto`（`:39-56`），`NormalizeDesiredInput` 无 `humanVetoed`（`:67-72`）。
- `workflows/bot-labels.ts` 无 `loadHumanVetoed` / `listBotLabelHistory` / `toDate` / `BOT_LABEL_SQL.listHistory`（整个文件 122 行，只剩 `insertActive` / `markRemoved` / `listActive`）。
- `worker/writeback.ts:108-127` 的 `LabelWritebackPolicy` 无 `humanVetoed`；`worker-deps.ts:572-602` 的装配不再注入它。

必须纠正 WP3 的两处表述：

- **`recordRemoved` 的调用方**（WP3 问「现在是谁」）：只有两处，都是**我们自己的撤标**——`github/executor.ts:342`（v1.5 `executeLabelPlan`）与 `worker/run-task.ts:387`（v2.1 写端口）。这**反证了 WP3 的根因判断**是对的：`bot_labels.removed_at` 的写入方只有我们自己，所以旧「人工否决」的证据 100% 来自我们自己的动作。
- **`issues.unlabeled` 至今未被接收**：`http/webhook-v21.ts:110-133` 的 `v21EventKeyOf()` 只映射 `issues.opened / edited / labeled / closed` 与 `issue_comment.created`，`unlabeled` 落 `default: null`。WP3 自认这一点，我确认成立。功能上不阻塞（`current` 已是实况，下一轮任意事件都会重新对齐），但代价是：**人删标签这个动作不会触发任何一轮**，「人工删除不构成永久否决」实际是「等到下一次别的事件才对齐」。这不是缺陷，但验收 AC 时要按这个口径写。

真正的问题在**规范**：`requirements.html:1863` 的 AC-15 未改（见 §一-1.2）。

### 2-3 · LD-1 — 部分

「不反向下发」这一半**已经干净**：

- 全仓 `POST /repos/{owner}/{repo}/labels` 只剩两处**注释**（`app/worker-deps.ts:625`、`workflows/ports.ts:88`），无代码。
- `createGithubLabelCatalog` 只有 `GET`（`worker-deps.ts:631-658`）；`knownLabelsOf` 只取 `entry.name`（`worker/writeback.ts:219-235`）。
- `settings-v21.ts:319-346` 的判定视图确实没有 `color`/`description`。

「颜色/描述来自 GitHub、与仓库同步」这一半**一行都没实现**，且注释在谎报：

- 新增的 `LabelCatalogEntry.color/description`（`workflows/ports.ts:101-106`）**没有任何消费方**——我全仓搜过，只有端口实现本身与两个测试假件（`app-wiring.test.ts:196`、`writeback-v21-labels.test.ts:313`）。没有任何代码把 GitHub 的颜色/描述写进 `repos.settings.labels.vocabulary`，**没有同步作业、没有 sync 函数**。
- 反过来，唯一能填充这两个字段的路径仍是**人在面板手填**：`apps/panel/src/components/settings/labels-section.tsx:230`（color 输入框）、`:251`（description 输入框），保存进 settings。
- 而 `contract/src/repo-config.ts:88-97` 的注释现在写「**来源是 GitHub**……同步时原样落进来，面板只读展示」，`settings-v21.ts:325` 写「面板要展示颜色/描述时读同步快照」。**这两句与事实相反**：没有同步，面板也不是只读。这违反 `AGENTS.md` §11「注释写为什么」的底线——注释描述了一个不存在的行为。
- `labelCatalogEntryV21Schema` 删 `color`/`description` 这一步**对运行时零影响**：这个 schema 只被 `packages/contract/test/settings-v21.test.ts` 用（`:36,112,276-290,386`），没有注册进 `schemas.ts`，也**没有出现在 `openapi/pi-bot.openapi.json` 里**（我 grep 过，0 命中）。所以 WP3 §六-1 担心的「`pnpm gen:openapi` 会改产物」对这次改动**不成立**——它不会改。顺带：WP3 §六-4 说调用面是 `http/webhook-v21.ts:1021`、`worker/run-task.ts:396`、`config/v21-settings.ts`，实际这三处取的是 `resolveManagedCatalog()` → `ManagedCatalogEntry`（`config/v21-settings.ts:302-330`），**根本不是这个 schema**；而且这三个行号在别人改动后也已漂移（现在是 `webhook-v21.ts:1106`、`run-task.ts:406`）。证据引错对象，结论（「删除安全」）恰好仍然成立。

判定：**部分**。要补齐有两条路，必须选一条并说清楚：(a) 实现同步（把 `catalog.list()` 的 color/description 落到 settings 快照）；(b) 把这两句话改成「平台手填、与 GitHub 无关，且不下发」——那就等于承认 LD-1 的这一格没做，登记为缺口。**不能保持现在这种「注释声称已同步、代码没有同步」的状态。**

### 2-4 · LD-2 — 已实现（服务端净）

- `LabelCatalogPort` 只剩 `list?`（`workflows/ports.ts:97-99`），端口层面**没有 create 可调**。
- `createGithubLabelCatalog` 无 POST 分支（`worker-deps.ts:631-658`）。
- `applyMissingPolicy` 是同步函数、无 `create` 分支；`'create'` 与 `'warn'` 走同一路径，只有 `detail` 措辞不同（`worker/writeback.ts:248-282`）；`normalize.ts:46-56` 的 `missing-label` 注释一致。
- 契约仍接受 `'create'` 字面量并注明理由（`contract/src/repo-config.ts:113-118`），这个取舍我认可（`.strict()` 下收窄枚举会让存量 `repos.settings` 整份解析失败 → `settings_valid=false` → 整仓事件被忽略，属数据安全）。

遗留（面在面板，但**不能算「行为只变保守」就了事**）：

- `labels-section.tsx:58-62` 仍提供 `create` 选项，文案是「缺哪个建哪个：这是**写动作**，会给仓库新增标签……**颜色/说明取词表里的值**」，并在 `:440` 打 `写动作` 徽章。用户选了它、以为会建标签，实际什么都不建、只留一条 warn。这是**功能性误导**（不是「更保守所以没关系」）：面板在承诺一个已经不存在的能力。WP3 把它推给 WP11 可以接受，但必须登记为「LD-2 未收口项」，不能写成「已实现」。

### 2-5 · `LabelCatalogEntry` 类型替换（`string[]` → 对象数组）有没有让消费方静默降级

**没有静默降级**：唯一的实现消费方 `knownLabelsOf` 显式 `map(entry => entry.name)`（`worker/writeback.ts:229-230`），两个测试假件都给了对象数组，`tsc` 全绿。但**新增的两个字段是死代码**（见 2-3），这才是这次类型替换的真实状态：形状升级了，能力没接上。

---

## 三、实跑结果

全部真跑，本机 Node v22.19.0 / pnpm 10.9.0（仓库要求 `>=24`，pnpm 有 engine WARN，不影响结果）。

| # | 命令 | 结果 |
|---|---|---|
| 1 | `cd apps/server; npx tsc --noEmit -p tsconfig.json` | `TSC_EXIT=0`，无输出 |
| 2 | `cd apps/server; npx vitest run test/writeback-v21-labels.test.ts test/workflow-normalize.test.ts test/app-wiring.test.ts` | **3 files / 34 tests passed**，3.79s |
| 3 | `cd apps/server; npx vitest run` | **139 files passed / 1763 passed / 2 skipped / 0 failed**，168.41s |
| 4 | `pnpm lint`（仓库根） | `✖ 6 problems (0 errors, 6 warnings)`，`LINT_EXIT=0`；6 条 warning 全在 `scripts/spike/lib/*.mjs`，与本次改动无关 |

第 2 条的分项：`app-wiring 5` + `workflow-normalize **12**` + `writeback-v21-labels **17**`。**与 WP3.md §五-3 自述的「normalize 14 / labels 15」不一致**（现在是 12/17）。我按当前文件核过内容：`workflow-normalize.test.ts` 里「人工删除不构成永久否决」两条新用例在（`normalize、human-veto` 组），`writeback-v21-labels.test.ts` 里 FR-5.4 三例 + LD-2 三例都在（`:219-276`、`:288-345`）。差异应是 WP3 报告写成后有人（或它自己收口时）又调整过用例，不影响结论，但**交付报告的数字不要当准**。

与编排侧给的基线（139 / 1763 / 2 skipped / 0 failed）**完全一致**；WP3.md 里那 14 条失败（`writeback-v21-execute` 13 条 + `app-config` 1 条）在当前工作区**已不复存在**，确认已被各自 owner 修掉，不是被本包掩盖。

**没跑**：`pnpm -r typecheck`（编排侧已跑 6 包全 Done，且第 1 条覆盖了本包面）、`pnpm gen:openapi`（见 2-3：这次 schema 改动不在 OpenAPI 注册表里，产物不会变，我改用 grep 验证而非重生成）、真 GitHub / Docker 依赖用例（本机无凭证，`2 skipped` 就是这类）。

---

## 四、发现的问题（按严重度）

### P1-1 · `readLiveLabels` 读失败静默 → 新增「盲删」路径（`compose.ts:1251-1254` / `:951` / `:1807-1825`）

两次**独立**读：提示词用 `:1254` 的快照，执行器用 `:951` 的快照。`readLiveLabels` 失败一律 `catch { return [] }`，**不告警、不带标记**。因此存在这条路径：

1. `:1254` 失败（429/5xx/网络抖动）→ 提示词里没有「当前标签」（`:1411` 空数组时直接不进上下文）→ 模型按「本来没有标签」输出目标态；
2. `:951` 成功 → `current` 是人打的真标签；
3. `planLabelTargetState` 规则 4（`labels.ts:193-203`）把那些**可管理**的现存标签算进 `remove` → `execute.ts:555-557` 逐个 DELETE。

FR-5.4 `:1049` 的原文正是禁止这个（「看不到全量就输出目标态，等于盲删」），而实现**没有任何「只有看到全量才允许删」的守卫**。WP3 §六-2 把它归为「读失败只会让执行器只加不删，比拿过期快照删标签安全」——这个结论只对「执行器那次读失败」成立，**漏掉了「提示词那次失败、执行器那次成功」的反向组合**。

修法（任选，成本都很低）：把 `readLiveLabels` 改成返回 `{labels, ok}`；`ok=false` 时本轮禁止 `remove`（把 `current` 喂成 `desired` 也行），并留一条 warn。顺带解决 §四 P3-6 的重复 GET。

### P1-2 · 人打的标签被删时不留台账行、`owner` 只是自由文本、`reconcile` 不认 v2.1 标签动作

- `workflows/bot-labels.ts:96-106`：`recordRemoved` 是 `UPDATE`，人打的标签零行 → 删完查不到。
- `worker/run-task.ts:1418-1426`：`audit` 只有 `detail` 字符串（`删 [需求/human]`），没有结构化的 `owner` / `labels` 字段。
- `jobs/reconcile-reverts.ts:296`：只处理 `intent === 'label'`，而 v2.1 写的是 `v21:${type}`（`run-task.ts:1414`）→ **v2.1 的标签动作用远不参与改回对账**（这条是既有缺陷，不是 WP3 引入，但 FR-5.4 生效后它成了「撤错标签无人发现」的主因）。

影响：BR-10 的「记录原主人与删除原因、可复盘」只做到「有一句话」，不可查询、不可聚合、无告警；「可回滚」不成立（见 §一-1.4）。

### P1-3 · 规范未同批修（需人批，**阻塞验收**）

- `AGENTS.md:65`：I4 原文未改 → 代码与不变式文字相反（`Policy-Sync: 2026-11-13.3` 那次 bump 是别人为 §11.1 做的，与 I4 无关）。
- `docs/requirements.html:1863`：AC-15 与 BR-11/FR-5.4 相反，且 `:425` 的修订记录已经说明「取消『人删过永久不加回』」→ AC-15 是漏改项。

按 `AGENTS.md` §1「代码、`package.json`、schema 与可执行脚本是唯一事实源……文档与代码冲突时先核实代码，再在交付里说明，**并同批修文档**」，这两处必须在本批内定稿（改 I4 措辞 + 删/改 AC-15）。在定稿前，**「I4 合规」这句话不成立**，谁都不该在交付里写「安全边界无放宽」。

### P2-1 · 根因修复没有集成测试（`test/v21-worker-integration.test.ts:348`）

全仓 `readLiveLabels` 在测试里 **0 命中**；`v21-worker-integration.test.ts:346-350` 的假 `targets` 恒返回 `{currentLabels: [], botLabels: []}`。`app-wiring.test.ts` 走的是旧 4-intent 路径，不经过 `planLabelTargetState`。结论：**把 `compose.ts:951-952` 两行对调（`currentLabels` 用台账、`botLabels` 用实况），1763 个用例全绿。** 按 `AGENTS.md` §6「新增涉及时间的逻辑给 `now?`」「断言可观察事实」，这条根因至少需要一条「实况含人打标签、台账不含 → DELETE 调用里出现那个标签」的用例（假 GitHub 记录调用序列即可，`app-wiring.test.ts` 已有 `github.calls` 范式）。

### P2-2 · LD-1「颜色/描述来自 GitHub」零实现 + 注释谎报（`worker-deps.ts:628-629`、`contract/src/repo-config.ts:88-97`、`contract/src/settings-v21.ts:323-325`、`ports.ts:91-93`、`labels-section.tsx:230,251`）

见 §二-3。新增的 `LabelCatalogEntry.color/description` 无消费方；注释声称「同步时原样落进来、面板只读展示」，实际无同步、面板可写。

### P2-3 · 面板仍提供 `missing: 'create'` 并标注「写动作」（`labels-section.tsx:58-62,440`）

服务端已按 warn 处理（`worker/writeback.ts:267-278`），面板文案仍承诺「会建标签」「颜色/说明取词表里的值」。用户视角是「选了写动作，什么也没发生」。属 WP11 面，但必须登记；在它修好前，LD-2 只能说「服务端已实现」。

### P3-1 · `bot_labels` 查询两处真相（`compose.ts:1782-1787` vs `workflows/bot-labels.ts:30-36`）

`readAppliedLabels` 手写 SQL（`applied_at is not null and removed_at is null`）与 `listBotLabels`（`removed_at is null`）**条件已经不同**；而 `createV21TargetContextPort`（`worker-deps.ts:1164-1167`）已经在调 `listBotLabels`。违反 `AGENTS.md` §11「规则会被复制成第二处真相 → 先抽取再实现」。

### P3-2 · `compose.ts` 被加了新职责（`AGENTS.md:145`）

`readLiveLabels` / 改写的 `readAppliedLabels` 都落在 `app/compose.ts`（1826 行），而 §11 明列「`app/compose.ts` 不再加新职责」。这两段是 GitHub 读取逻辑，更合适的位置是 `github/`（`getIssue` 已在那里）或 `worker-deps.ts`（`createV21TargetContextPort` 已在那里）。

### P3-3 · 陈旧注释（会误导下一个改这块的人）

| 位置 | 内容 |
|---|---|
| `worker/writeback.ts:103` | 「……（词表、map、上限、**人工否决**、仓库已有标签……）」——`humanVetoed` 已删 |
| `worker/writeback.ts:494` | 「词表 / 1:N / 互斥组 / 上限 / **人工否决** / `labels.missing` 必须在写之前生效」 |
| `db/schema.ts:623` | `label_decisions.blocked_reason` 注释仍列 **`human-veto`** |
| `test/app-wiring.test.ts:254` | 「`bot_labels` 记账（只增删自己打过的标签 + **人工否决** 都靠它）」——两句话都已不成立（这正是被推翻的 I4 语义） |
| `workflows/normalize.ts:12-19` | 规则表列了**第 6 步**「仓库里有没有 → `missing-label`」，但 `normalizeDesired()` 到第 5 步就 `return`（`:200-213`）；`missing-label` 实际由 `worker/writeback.ts:196-202` 产生。文档表与函数体不符 |

### P3-4 · `labelCatalogEntryV21Schema` 是死契约；WP3 的「调用面已核对」引错对象

见 §二-3 末段。删字段本身安全（无消费方、不在 OpenAPI），但**证据链是错的**，且它给人「LD-1 已收口」的错觉。

### P3-5 · 提示词里的「项目标签」不筛可管理范围，与规则 3（整批拒绝）相互作用（`skills/prompt.ts:263-289`）

标题写「本仓库**当前可用**的全部标签；打标只能从这里选」，正文列出 `vocabulary` **全部**条目——包括 `status='retired'`、`managed=false`、没填 `meaning` 的。模型照它写进 `desired` → `labels.ts:169-182` 规则 3 判 `unknown-label` → **整条 label 动作拒绝（不加也不删）**。也就是说：一个 `retired` 条目留在词表里，就能让所有标签对齐停摆。需求 §6.5 要求「只列含义非空的」。这条**不是 WP3 引入**（规则 3 与渲染都是既有行为），但 WP3 §六-4 只把它记为「已知缺口」，低估了它与「整批拒绝」的耦合。

另：`PROMPT_LIMITS.labels = 40`（`skills/prompt.ts:44`、`formatLabels:236-240`）对「当前标签」静默截断。FR-5.4 把「当前**全部**标签」写成前提，>40 个标签时这个前提不成立。GitHub 单个 issue 上限是 100，实际很少超，属低风险，但既不告警也不进 `skipped`，与「漂移要显性」的取向不一致。

### P3-6 · 每任务两次 GET；`targets` 端口的 `currentLabels` 在 execute 路径实际未被使用

`compose.ts:1254`（提示词）＋ `:951`（执行器）＝ 2 次 `GET /issues/{n}`。而 `run-task.ts:1285-1292` 从 `deps.targets.load()` 取出的 `currentLabels` **只喂直连路径**（`:1361-1374`）；生产路径走 `v21Config.execute`（`:1337-1342`），ctx 里**根本不传** `currentLabels`（只传 repo/issueNumber/dryRun/allowedMentions），由 `compose.ts:951` 重新读。所以 `createV21TargetContextPort` 的 `currentLabels`（`worker-deps.ts:1159,1168`，快照取自 `executeTask` 时刻）在两种路径下**都没有被用上**，是死参数。WP3 §六-1 把它描述成「刻意不合并」，实际是**读了两遍、还用了一遍的都丢掉**。

### P3-7 · dry-run 的 GET 口径不一致

`compose.ts:1810` 注释：「dry-run 也照读：这是 GET，不是副作用」；`worker/writeback.ts:159` 注释：「**dry-run 不查仓库标签**：一次 GET 也不该发生」，`:195` 用 `input.dryRun ? null : await knownLabelsOf(...)` 落实。两种取向并存，将来谁按错的那条改都会破坏另一个测试的口径。`AGENTS.md` I3 只说「零副作用（不写 `actions`）」，两条都不违规，但应当统一并写在一处。

---

## 五、我不确定的地方

1. **`managed` 默认 true 是否是产品意图。** FR-5.4 + BR-11 的字面组合下它是自洽的（目录内 + 有含义 = 纳入管理）。但它让「人打的标签」默认进入删除范围，而 I4 被撤掉了。这是产品决策，我不替它拍板；我把它列为 §一-1.5 的第 2 条结论，需要人回一句「是」或「改成默认 false」。
2. **「撤销人删除的标签」到底该不该发生。** 我按 `:425` 的修订记录认定 AC-15 是漏改项。如果真实意图是「保留 AC-15」，那 WP3 缺陷 2 的方向就是错的（应该留 veto，只是换证据来源）。这一点只有需求作者能定，`requirements.html` 现在是自相矛盾的。
3. **`deletionOwner` 的边界语义。** `bot_labels` 只记「现在我们持有的」。若一个标签我们先打、人删掉、人又打回来，台账是 `removed_at` 非空 → `listActive`/`readAppliedLabels` 都不返回 → `owner` 记成 `human`。这在审计上其实是**对的**（当前持有者是人），但和 `deletionOwner` 的命名（「原主人」）不完全一致。我没有把它算成缺陷。
4. **`app-wiring.test.ts` 的假 GitHub `getIssue` 返回什么。** 我确认它不会让用例失败（`readLiveLabels` 的 `catch` 兜住），但**没有**逐行读 `createCountingGithubApi` 的实现去确认它到底返不返回 labels。这影响的是「这条用例是否顺带覆盖了实况读取」——结论里我已经按「没覆盖」写了（因为即使返回了，也没有断言）。
5. **`pnpm -r typecheck` / `gen:openapi` 我没在本轮亲跑**（依据见 §三末），如果编排侧要求「每个审查者都必须亲自跑全量门禁」，这两项要补。
6. **WP3.md 的测试数字（14/15）与现状（12/17）对不上**，我核了用例内容都在，但没去追是谁在什么时候改的——如果这中间发生过「顺手删掉 2 条 normalize 用例」，我看到的 12 条里已经没有那 2 条的原文，无法判断删得对不对。
