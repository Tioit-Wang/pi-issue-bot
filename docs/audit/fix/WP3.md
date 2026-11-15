# WP3 · 标签三件套（实现交付）

- 日期：2026-11-15
- 范围：FR-5.4 / FR-5.5 / BR-11 / AC-15 / LD-1 / LD-2
- 结论：**四条缺陷全部改完。** 收口时 `cd apps/server; npx tsc --noEmit` exit 0、`pnpm -r typecheck` exit 0、本包相关 5 个测试文件 77/77 通过、涉及文件的 eslint exit 0。收口后他人并发编辑又引入 1 条 `queries/issues.ts` 的类型错误（不属本包，§五-1）与 14 条他包测试失败（§五-5）；本包面内零错误。

---

## 一、根因

四条缺陷是同一个根因的几副面孔：

> `current`（issue 当前有哪些标签）取自**自家的 `bot_labels` 台账**，而不是 GitHub 上实际挂着的标签。

台账只记「我们打过什么」，于是：

| 方向 | 现象 | 违反 |
|---|---|---|
| 人打了标、台账没有 | 永进不了 `remove` 集合 → 平台删不掉人打的标签 | FR-5.4「删除权包括人手动打的标签」 |
| 人删了标、台账仍记 `applied` | 被判成「已经在」→ `add` 不含它 → 永不补加 | FR-5.4 的前提「输入必须包含当前全部标签」 |
| 台账的 `removed_at` 被当成「人不要了」 | 而它的写入方**只有我们自己**的撤标动作 | BR-11「人工删除不构成永久否决」 |

---

## 二、四条逐条对照

### 缺陷 1 · FR-5.4 删除权包括人手动打的标签

| | |
|---|---|
| **需求原文** | 「平台与当前实际标签对齐。平台拥有**删除权**，包括删除人手动打的标签。」（`docs/requirements.html:1040`，`id="fr-5-4"`）<br>「前提：执行侧的输入必须包含**当前全部标签**……看不到全量就输出目标态，等于盲删。」（`:1049`） |
| **改前行为** | `compose.ts` 的 `readAppliedLabels` 只查 `bot_labels`（`applied_at is not null and removed_at is null`），两个调用点都拿它**同时**当 `currentLabels` 与 `botLabels`。`writeback/v21/labels.ts` 的 `remove = current ∩ 可管理目录 − desired`，于是 `current` 里根本没有人的标签 → **人打的标签永远删不掉**。 |
| **改后行为** | 两个来源彻底分开：<br>• `currentLabels` ← 新增 `readLiveLabels()`，一次 `GET /repos/{o}/{r}/issues/{n}` 取 GitHub 实况，人打的与我们的都算；<br>• `botLabels` ← `readAppliedLabels()`（仍是 `bot_labels`），**只用于** `deletionOwner()` 的归属判定（BR-10 留痕）。<br>`remove` 现在按 GitHub 实况算，人打的标签照样进 `remove`；`owner` 记成 `human`，可复盘。 |
| **证据** | [compose.ts:946](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/app/compose.ts:946)（执行器钩子：两个来源分别读）<br>[compose.ts:1251](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/app/compose.ts:1251)（`executeTask`：`currentLabels` 取实况）<br>[compose.ts:1764](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/app/compose.ts:1764)（`readAppliedLabels` 注释改为「只判归属」）<br>[compose.ts:1798](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/app/compose.ts:1798)（`readLiveLabels` 新增）<br>[worker-deps.ts:1141](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/app/worker-deps.ts:1141)（`createV21TargetContextPort`：两个字段口径分列）<br>[labels.ts:9](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/writeback/v21/labels.ts:9)（`current` 口径的不可让渡约束写进头注释）<br>[writeback-v21-labels.test.ts:219](/C:/Code/NodeProjects/pi-issue-bot/apps/server/test/writeback-v21-labels.test.ts:219)（人打的标签被删 + owner=human） |

**为什么 `bot_labels` 不删**：它仍是 BR-10「删除留痕：原主人是人还是机器」与归因（`source_key` / `judgement_hash` / `run_id`）的唯一事实源。删表会让「谁动了标签」在事故复盘时无从查起。

---

### 缺陷 2 · BR-11 / AC-15 人工删除不构成永久否决

| | |
|---|---|
| **需求原文** | 「**人工删除不构成永久否决**：下一轮按目标态重新对齐。确实不想让平台碰某个标签，用项目级的「不自动管理」标记（见 BR-11），那是显式契约，不是靠「删过一次」隐式推断。」（`docs/requirements.html:1047`）<br>BR-11：「标记后平台既不删也不加。未标记的标签按目标态正常对齐——**人工删除不构成永久否决**。」（`:1796`）<br>AC-15 原文是旧口径（「维护者手动删除某标签后……也不会被自动加回」，`:1863`），已被 BR-11 与 FR-5.4 推翻；本包按 BR-11 / FR-5.4 实现。 |
| **改前行为** | `workflows/normalize.ts` 有第 6 步「人工否决」：`humanVetoedFrom()` 从 `bot_labels` 历史推出「最后一次是撤标」的集合，命中的标签一律拦成 `human-veto`。而 `bot_labels.removed_at` 的写入方**只有两处**——`github/executor.ts:342`（我们自己 `removeLabel` 成功后）与 `workflows/bot-labels.ts:138`（记账器本身）。真正的 `issues.unlabeled` 事件从未被接收。于是「我们的撤标」被当成「人的否决」，且一次就永久生效。 |
| **改后行为** | 整条规则删除：<br>• `normalize.ts` 去掉 `human-veto` 原因、`NormalizeDesiredInput.humanVetoed` 字段与第 6 步；<br>• `bot-labels.ts` 删除 `loadHumanVetoed()` / `listBotLabelHistory()` / `toDate()` / `BOT_LABEL_SQL.listHistory`；<br>• `worker/writeback.ts` 的 `LabelWritebackPolicy.humanVetoed` 端口与调用删除；<br>• `worker-deps.ts` 的 `createLabelWritebackPolicy` 不再注入它。<br>「别动这个标签」只剩一条显式路径：目录里 `managed=false`（BR-11 的契约）。 |
| **证据** | [normalize.ts:28](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/workflows/normalize.ts:28)（删除说明 + 「不要接回来」）<br>[normalize.ts:102](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/workflows/normalize.ts:102)（归一化只剩 5 条规则，无状态）<br>[bot-labels.ts:1](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/workflows/bot-labels.ts:1)（为什么不再参与 `current`）<br>[writeback.ts:112](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/worker/writeback.ts:112)（`LabelWritebackPolicy` 无 `humanVetoed`）<br>[writeback.ts:161](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/worker/writeback.ts:161)（「没有人工否决」）<br>[worker-deps.ts:572](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/app/worker-deps.ts:572)（装配注释写明「没有人工否决」）<br>[workflow-normalize.test.ts:118](/C:/Code/NodeProjects/pi-issue-bot/apps/server/test/workflow-normalize.test.ts:118)（新用例：同输入两次逐字段相同；`human-veto` 产不出来） |

---

### 缺陷 3 · LD-1 标签目录五字段：颜色/描述来自 GitHub，平台不单独维护

| | |
|---|---|
| **需求原文** | 需求 §6.5 表（`docs/requirements.html:1594-1602`）：名称 ← GitHub；**颜色 / 描述 ← GitHub（「与仓库同步，平台不单独维护」）**；含义 / 分组 / 状态 ← 平台。<br>`_unimplemented.md` 第 7 条：「颜色/描述是平台手填字段，并**反向下发**给 GitHub」。 |
| **改前行为** | ① `packages/contract/src/repo-config.ts` 的 `labelVocabularyEntrySchema` 把 `color` / `description` 当平台手填字段；② `settings-v21.ts` 的 `labelCatalogEntryV21Schema`（判定视图）也带这两个字段；③ `worker/writeback.ts` 的 `applyMissingPolicy` 在 `create` 策略下用 `vocabulary[label].color / .description` 去 `POST` 新标签——正是「反向下发」。 |
| **改后行为** | • 判定视图 `labelCatalogEntryV21Schema` **删掉 `color` / `description`**（只留平台维护的 `meaning` / `group` / `managed` / `status`）；<br>• `labelVocabularyEntrySchema` 保留这两个字段但语义改成**只读同步快照**（注释写明来源 GitHub、平台不维护、不反向下发）；<br>• 目录端口 `LabelCatalogPort.list()` 返回类型从 `readonly string[]` 改为 `readonly LabelCatalogEntry[]`（`{name, color?, description?}`），即颜色/描述**从 GitHub 读进来**；<br>• 反向下发的代码路径整体删除（见缺陷 4）。 |
| **证据** | [settings-v21.ts:319](/C:/Code/NodeProjects/pi-issue-bot/packages/contract/src/settings-v21.ts:319)（判定视图无 color/description）<br>[repo-config.ts:62](/C:/Code/NodeProjects/pi-issue-bot/packages/contract/src/repo-config.ts:62)（五字段来源表 + 只读快照说明）<br>[ports.ts:84](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/workflows/ports.ts:84)（端口只读 + 新增 `LabelCatalogEntry`）<br>[worker-deps.ts:617](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/app/worker-deps.ts:617)（`createGithubLabelCatalog`：只 GET，返回 name+color+description）<br>[writeback.ts:219](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/worker/writeback.ts:219)（`knownLabelsOf` 只取名字） |

**为什么 `color` / `description` 不从 `repos.settings.labels.vocabulary` 里彻底删掉**：那是存量 jsonb 里已有的键，`.strict()` 下删键会让老配置整份解析失败（`settings_valid=false` → 该仓库事件全被忽略），属数据安全问题。改为「保留字段、语义改为 GitHub 同步的只读快照」，既满足 LD-1 的「平台不维护、不下发」，也不破坏存量配置。

---

### 缺陷 4 · LD-2 三条同步规则：平台不发明标签、不反向创建

| | |
|---|---|
| **需求原文** | 「**GitHub 是身份的事实源**：名称、颜色、是否存在，一律以仓库为准；平台**不发明标签、不反向创建**。」（`docs/requirements.html:1607`）<br>「漂移要显性：仓库新增的标签自动进目录但含义为空；仓库删除的标签标记失效。」（`:1609`） |
| **改前行为** | 存在 `POST /repos/{o}/{r}/labels` 反向创建路径，由 `labels.missing='create'` 开启（`worker-deps.ts` 的 `createGithubLabelCatalog.create` → `worker/writeback.ts` 的 `applyMissingPolicy`，用词表里的 color/description 建标签）。 |
| **改后行为** | • `LabelCatalogPort` 只剩 `list`（端口层面就没有 `create` 可调）；<br>• `createGithubLabelCatalog` 删掉 `POST` 分支；<br>• `applyMissingPolicy` 改为同步函数，`create` 策略**取消**：缺标签一律记 `missing-label`（`label_decisions` 留痕），由人先在 GitHub 上建；<br>• 契约里 `missing` 仍接受 `'create'` 字面量，但写入面按 `warn` 处理——升级后行为只会变保守。 |
| **证据** | [ports.ts:84](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/workflows/ports.ts:84)（端口只读）<br>[worker-deps.ts:617](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/app/worker-deps.ts:617)（无 POST）<br>[writeback.ts:232](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/worker/writeback.ts:232)（`applyMissingPolicy`：无 create 分支，注释写明「存量 'create' 按 warn」）<br>[normalize.ts:46](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/workflows/normalize.ts:46)（`missing-label` 的注释）<br>[repo-config.ts:113](/C:/Code/NodeProjects/pi-issue-bot/packages/contract/src/repo-config.ts:113)（`missing` 的注释）<br>[writeback-v21-labels.test.ts:288](/C:/Code/NodeProjects/pi-issue-bot/apps/server/test/writeback-v21-labels.test.ts:288)（3 条用例：存量 `create` 也不建、`ignore` 仍留痕、dry-run 零 GET） |

---

## 三、I4 与 FR-5.4 的裁决

**结论：I4 的措辞需要按 FR-5.4 重新解释；它保护的是「目录外 / 不可管理」的标签，不是阻止删除人打的标签。`bot_labels` 台账保留。**

AGENTS.md 不变式 I4 写的是：

> 「标签只撤 `bot_labels` 记过的」→ 破坏后果：「撤掉人打的标签」

而 FR-5.4 明写「平台拥有删除权，**包括删除人手动打的标签**」。两者表面冲突，实际是分工：

1. **I4 的真实保护对象是「目录外 / 不可管理」的标签。** 需求 §6.5 与 BR-11 / BR-12 给出了四条「不动」的判据：目录外（`not-in-catalog`）、`managed=false`（`unmanaged`）、`status='retired'`（`retired`）、没填含义（`missing-meaning`）。这四条**仍然全部生效**，且是 `remove` 集合的硬边界（[labels.ts:20](/C:/Code/NodeProjects/pi-issue-bot/apps/server/src/writeback/v21/labels.ts:20) 的规则 4）。所以「人打的标签被删」只发生在**该标签属于可管理目录**的前提下——那不是「撤掉人的组织方式」，而是「把人打的标签对齐到目录内的目标态」。
2. **I4 的历史实现（`remove ⊆ bot_labels`）与 FR-5.4 直接矛盾，必须让位。** FR-5.4 是需求正文的显式要求（P0），I4 是内部工程约束；AGENTS.md §1 明确「产品行为以需求正文为准，文档与代码冲突时先核实代码，再在交付里说明」。这里是需求与工程约束冲突，需求优先。
3. **`bot_labels` 台账一个字段都不删。** 它现在负责两件事：BR-10 的删除留痕（`owner: bot | human`）与归因四列。I4 里「可核对、而不是靠读 issue 现状反推」的**审计意图**完整保留，只是不再用它当 `current` 的**判定**依据——判定用 GitHub 实况，留痕用台账。

**建议**（不在本包权限内，留给人改 AGENTS.md）：把 I4 改写为「删除集合 ⊆ 可管理目录（`active` + `managed!==false` + `meaning` 非空），且每次删除必须记 `owner`（`bot_labels` 台账）」。破坏后果改为「撤掉目录外/不自动管理的标签，或删除无法复盘」。

**附带一处判断**：`deletionOwner()` 的语义没变（在 `botLabels` 里就是 `bot`，否则 `human`），但现在它会**经常**返回 `human`——因为人打的标签终于能进 `remove` 了。这不是回归，是 FR-5.4 生效后的正常结果。

---

## 四、改了哪些文件与原因

| 文件 | 改动 | 原因 |
|---|---|---|
| `apps/server/src/workflows/normalize.ts` | 删 `human-veto`（原因 + `humanVetoed` 入参 + 第 6 步）、删 `humanVetoedFrom()`、`NormalizeDesiredResult` 去掉 `vocabulary` | 缺陷 2：人工删除不构成永久否决 |
| `apps/server/src/workflows/bot-labels.ts` | 删 `loadHumanVetoed` / `listBotLabelHistory` / `toDate` / `BOT_LABEL_SQL.listHistory`；文件头重写职责说明 | 同上；台账只剩归属与归因 |
| `apps/server/src/workflows/ports.ts` | `LabelCatalogPort` 只留 `list`；新增 `LabelCatalogEntry`（name + color + description） | 缺陷 3 / 4：只读、不反向创建 |
| `apps/server/src/workflows/index.ts` | 跟进导出（去掉 `humanVetoedFrom` / `listBotLabelHistory` / `loadHumanVetoed`） | 同上 |
| `apps/server/src/worker/writeback.ts` | `LabelWritebackPolicy` 去 `humanVetoed`；`planLabelWriteback` 去否决步骤；`applyMissingPolicy` 去 `create` 分支（改同步）；`knownLabelsOf` 适配对象数组 | 缺陷 2 / 3 / 4 |
| `apps/server/src/writeback/v21/labels.ts` | 头注释重写：`current` 必须是 GitHub 实况、台账只判归属 | 缺陷 1 的契约说明（行为本来就对，缺的是「`current` 从哪来」） |
| `apps/server/src/app/worker-deps.ts` | ① 去 `loadHumanVetoed` import 与注入；② `createGithubLabelCatalog` 只读、返回 `LabelCatalogEntry[]`；③ `createV21TargetContextPort` 注释重写 | 缺陷 1 / 2 / 3 / 4（**只动标签目录与打标策略相关行**） |
| `apps/server/src/app/compose.ts` | ① 新增 `readLiveLabels()`；② `readAppliedLabels` 注释改为「只判归属」；③ 执行器钩子与 `executeTask` 分别取两个来源 | 缺陷 1（**只动 `readAppliedLabels` 与标签目标态相关行**） |
| `packages/contract/src/settings-v21.ts` | `labelCatalogEntryV21Schema` 删 `color` / `description` | 缺陷 3（LD-1 的判定视图） |
| `packages/contract/src/repo-config.ts` | `labelVocabularyEntrySchema` 的 color/description 注释改为「GitHub 只读快照」；`labels.missing` 注释写明 `create` 已取消 | 缺陷 3 / 4 |
| `apps/server/test/writeback-v21-labels.test.ts` | 新增 2 组用例：FR-5.4 删除权（3 条）、LD-2 不反向创建（3 条） | 新行为必须有可观察事实的断言 |
| `apps/server/test/workflow-normalize.test.ts` | 删「人工否决」的 2 条旧用例，换 2 条新用例（无状态 + 产不出 `human-veto`） | 缺陷 2 |
| `apps/server/test/app-wiring.test.ts` | 假件 `labelCatalog.list` 返回 `LabelCatalogEntry[]` | 端口类型变更带出的机械修改 |

**没有新建迁移**：本次全部是代码与契约形状变化，不动表结构（`bot_labels` / `label_decisions` 的列一个没改，`schema.ts` 未触碰）。

**没有触碰的他人面**：`apps/server/src/compact/**`、`runtime/**`、`agent/**`、`queries/**`、`db/schema.ts`、`migrations/**`、`packages/contract/src/api.ts`、`http/webhook-v21.ts`。`worker-deps.ts` 里 `createV21TurnCompaction` / `isSummarizeUnavailable` 相关行未改；`compose.ts` 里 `panelDistDir` / `persistAgentSessionAfterRun` / `nextAgentTurns` / 压缩装配未改。

---

## 五、命令与真实输出

### 1. `cd apps/server; npx tsc --noEmit`

本包刚收口时（我的改动全部落定、别人的文件当时是绿的）：

```
$ npx tsc --noEmit -p tsconfig.json
TSC_EXIT=0
```

**收口后几分钟，他人的并发编辑又引入了一条新错误**（`packages/contract/src/api.ts` 于 04:27:50 被改，`apps/server/src/queries/issues.ts` 未动、停在 11/12）：

```
$ npx tsc --noEmit -p tsconfig.json
src/queries/issues.ts(1026,5): error TS2739: Type '{ repo: string; kind: "issue" | "pr"; ... }'
  is missing the following properties ...: body, author, createdAt
TSC_EXIT=2
```

这条**不在本包面内**（`queries/**` 与 `packages/contract/src/api.ts` 都不归 WP3）。按文件过滤复核，本包涉及的文件零错误：

```
$ npx tsc --noEmit -p apps/server/tsconfig.json 2>&1 | Select-String -Pattern "normalize|writeback|bot-labels|ports.ts|worker-deps|compose.ts|repo-config|settings-v21"
（无输出）
```

契约包单独跑也是绿的：

```
$ npx tsc --noEmit -p packages/contract/tsconfig.json
CONTRACT_TSC_EXIT=0
```

### 2. `pnpm -r typecheck`

```
$ pnpm -r typecheck
packages/envelope typecheck: Done
packages/contract typecheck: Done
packages/racp-client typecheck: Done
packages/shared typecheck: Done
apps/panel typecheck: Done
apps/server typecheck: Done
EXIT=0
```

### 3. 标签相关用例

```
$ cd apps/server; npx vitest run test/workflow-normalize.test.ts test/writeback-v21-labels.test.ts

 ✓ test/workflow-normalize.test.ts (14 tests) 17ms
 ✓ test/writeback-v21-labels.test.ts (15 tests) 12ms

 Test Files  2 passed (2)
      Tests  29 passed (29)
```

```
$ cd apps/server; npx vitest run test/app-wiring.test.ts

 ✓ test/app-wiring.test.ts (5 tests) 3.80s

 Test Files  1 passed (1)
      Tests  5 passed (5)
```

```
$ cd apps/server; npx vitest run test/workflow-normalize.test.ts test/writeback-v21-labels.test.ts \
    test/app-wiring.test.ts test/v21-worker-integration.test.ts test/worker-run-task.test.ts

 Test Files  5 passed (5)
      Tests  77 passed (77)
   Duration  7.19s
```

### 4. lint（本包涉及文件）

```
$ npx eslint apps/server/src/workflows apps/server/src/worker/writeback.ts apps/server/src/writeback \
    apps/server/src/app/worker-deps.ts apps/server/src/app/compose.ts \
    packages/contract/src/repo-config.ts packages/contract/src/settings-v21.ts \
    apps/server/test/writeback-v21-labels.test.ts apps/server/test/workflow-normalize.test.ts
LINT_EXIT=0
```

### 5. 全量 `npx vitest run`（apps/server）

```
 Test Files  2 failed | 137 passed (139)
      Tests  14 failed | 1751 passed | 2 skipped (1767)
   Duration  197.55s
```

失败文件只有两个，均**不在本包范围**：

- `test/writeback-v21-execute.test.ts`（13 条）：`link` / `reopen_issue` / `update_issue` / `update_comment` / `delete_comment` 等动作类型已被 WP10 从 FR-5.3 的封闭集合移除（`packages/envelope/src/v21.ts` 现为 `M`，其注释写「`link` 已不在封闭集合里（`REMOVED_ACTION_TYPES`）」），而该测试文件仍按旧动作集写夹具，`validateOutputV21()` 直接判「动作类型 link 已不在 FR-5.3 的封闭集合里」。**归 WP10。**
- `test/app-config.test.ts`（1 条）：`脱敏` 用例 `expected '{"pgDsn":"postgres://pi:***@127.0.0.1…' not to contain 'secret'`，来自 `apps/server/src/app/config.ts`（`M`，他人的改动）。**归该文件 owner。**

`test/agent-events.test.ts` 在第一次全量跑里失败 2 条，单独跑与第二次全量跑均通过（15/15）——**并行抖动，非本包引入**。

---

## 六、跳过项与残余风险

### 跳过项

1. **`pnpm gen:openapi` 未跑。** 本次改了 `packages/contract/src/repo-config.ts` 与 `settings-v21.ts` 的 schema 注释与 `labelCatalogEntryV21Schema` 的字段集，按 AGENTS §8.2 应重生成产物。**未跑的原因**：`packages/contract` 同时被 WP9（模型供应商）与 WP8（角色成员）大幅改动（`git diff` 显示 `settings-v21.ts` +390 行、新增 `roleMemberSchema` 等段），此刻生成会把他人半成品的契约一并写进 `openapi/pi-bot.openapi.json`。**需要编排侧在契约面收口后统一跑一次 `pnpm gen:openapi`。** `labelCatalogEntryV21Schema` 未在 `packages/contract/src/schemas.ts` 注册为 API 组件，所以这次字段删除**大概率**不改变 OpenAPI 产物，但**未验证**。
2. **`issues.unlabeled` 事件未接入。** 它归 `http/webhook-v21.ts` 的事件面（有 WP1-R 在改），本包不碰该文件。功能上不依赖它：`current` 已改为 GitHub 实况，人工删除在**下一轮任意事件**上都会自动重新对齐。**需要谁做什么**：`http/webhook-v21.ts` 的 owner 决定 `issues.unlabeled` 是否映射成触发事件（或明确不做）。
3. **面板未改。** `apps/panel/src/components/settings/labels-section.tsx` 仍在渲染 color / description 的输入框，并提示「颜色/说明取词表里的值」；`labels.missing` 仍有 `create` 选项。按其语义已失效。按 MASTER-PLAN §七裁决，`apps/panel/**` **归 WP11**。**需要 WP11 做**：color / description 改只读展示（或注明「来自 GitHub，平台不维护」），去掉 `missing: 'create'` 选项。
4. **`skills/prompt.ts` 的「项目标签」段未按 §6.5 收紧。** 需求 §6.5「目录怎么交给执行侧」要求「每行「名称 | 含义 | 分组」，**只列含义非空的**（即可管理范围）」；现有实现列出全部词表条目，把「可管理」判定交给写回层。属**已知缺口**，未在本包修（改它会影响提示词断言，跨包）。

### 残余风险

1. **`readLiveLabels` 每轮多一次 GitHub GET。** `executeTask` 与执行器钩子各读一次（**一个任务里两次**）。刻意不合并：前者喂提示词与 `targets`，后者喂执行器，处在不同阶段，中间可能被别的写改动。风险是配额与延迟，不是正确性。要省可让钩子复用前者那份（需把它传进 `TaskRunnerDeps`，改动面更大）。
2. **`readLiveLabels` 读失败返回 `[]`，且不告警。** 空 `current` 只会让执行器「只加不删」（`remove ⊆ current`），比拿过期快照删标签安全。副作用：若 GitHub 持续 5xx，平台会长期停在「只加不删」——不伤人但也不收敛。建议后续补一条 warn 留痕（该函数在 `compose.ts` 模块作用域，当前拿不到本轮 logger）。
3. **`missing: 'create'` 的契约仍接受。** 这是刻意的（不破坏存量 jsonb），但意味着面板仍能保存 `create`；其行为已降级为 `warn`（不建标签），不会误写仓库。要彻底收窄需 WP11 先去掉面板选项，再改契约枚举（涉及存量值迁移，属独立小包）。
4. **`labelCatalogEntryV21Schema` 删字段的调用面已核对**：`http/webhook-v21.ts:1021`、`worker/run-task.ts:396`、`config/v21-settings.ts` 与 4 处测试都只取 `name/meaning/managed/status`，**无人读 color/description**，删除安全。后续若要在提示词里展示颜色，需从 `labelVocabularyEntrySchema` 取。
5. **`actions.audit.owner` 的落库链路未加断言。** 本次补了 `deletionOwner()` 在「人打的标签」下的单测，但 v2 执行器那条 `recordAction` 把 `owner` 写进 `actions.audit` 的路径没有断言（归执行器审计列，本包未扩测）。
