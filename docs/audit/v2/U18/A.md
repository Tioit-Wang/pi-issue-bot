# U18 6.5 标签目录 · A

> 核查范围：docs/requirements.html 行 1589-1636
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览

| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| LD-1 五个字段 | 与需求冲突 | 颜色/描述是平台自持字段（面板可编辑）并会反向下发 GitHub；名称/颜色/描述没有任何以仓库为来源的写入路径 |
| LD-2 三条同步规则 | 与需求冲突 | `labels.missing=create` 会把平台词表在仓库里新建出来（反着来）；「仓库新增自动进目录」「仓库删除标记失效」两条都无实现 |
| LD-3 含义为空保护 | 已实现 | — |
| LD-4 刷新时机 | 未实现 | 没有「按需刷新」这个动作，也没有任何 TTL；目录是对 `repos.settings` 的纯内存映射 |
| LD-5 目录怎么交给执行侧 | 部分实现 | 「只列含义非空」没做（无含义条目照列）；目录落在装配尾部/技能正文之后，不紧跟系统提示词 |

## 逐条

### LD-1 五个字段

- **状态**：与需求冲突
- **证据**：
  - 五个字段的落点是同一份 zod schema：`packages/contract/src/repo-config.ts:76-94`（`name` / `role` / `meaning` / `color` / `description` / `group` / `managed` / `status`），v2.1 超集在 `packages/contract/src/settings-v21.ts:275-292`（`managed`、`status` 带默认值）。
  - 名称 / 颜色 / 描述**没有**以 GitHub 为来源的写入路径：目录 100% 由 `settings.labels.vocabulary` 映射而来 `apps/server/src/config/v21-settings.ts:249-258`；唯一的 GitHub 标签读取 `apps/server/src/app/worker-deps.ts:611-621` 返回的是 `readonly string[]`（只有 name），调用方只拿它判「map 里的标签是否存在」`apps/server/src/worker/writeback.ts:203`、`:226-236`，结果不写回目录。
  - 名称在提示词层还会被改写：`apps/server/src/skills/prompt.ts:271` 用 `oneLine(entry.name, …)` 压成单行，`:292-297` 折叠空白并删掉 `{}`。
  - 颜色 / 描述是**平台自持**且可编辑：`packages/contract/src/settings-v21.ts:281-284`（`color` 6 位 hex、`description` 500 字，均为平台字段）、面板输入框 `apps/panel/src/components/settings/labels-section.tsx:222-252`；并且被当作权威值反向下发：`apps/server/src/worker/writeback.ts:285-290` 把 `entry.color` / `entry.description` 传给 `POST /repos/{owner}/{repo}/labels`（`apps/server/src/app/worker-deps.ts:622-631`）。
  - 含义来自平台并被消费：`packages/contract/src/repo-config.ts:82` → `apps/server/src/skills/prompt.ts:276-278`（原样进提示词）。
  - 分组是互斥组并真的裁剪：`packages/contract/src/repo-config.ts:88` → `apps/server/src/workflows/normalize.ts:177-197`（同组只留输入顺序第一个，其余进 `blocked: reason='group-conflict'`）。
  - 状态 `active` / `retired` 存在且被目标态使用：`packages/contract/src/settings-v21.ts:290`、`apps/server/src/config/v21-settings.ts:255-257`、`apps/server/src/writeback/v21/labels.ts:97-99`。
- **缺口**：
  1. 「名称来源 GitHub」缺失——名称是人在面板里手填的，仓库改名/改名标签不会被发现；「完全一致不改写」也无从保证（提示词层 `oneLine` 会改写）。
  2. 「颜色/描述来源 GitHub，平台不单独维护」**反向**：平台自己存 `color` / `description`（`settings-v21.ts:281-284` + 面板输入框），并在 `labels.missing=create` 时把它们写成 GitHub 标签的属性（`worker/writeback.ts:285-290` → `POST /labels`）。仓库侧改了颜色/描述，平台看不到也不会更新。
  3. 「状态=已失效」只有人手填一条路径，没有「GitHub 上被删除」这个来源（见 LD-2 第 3 条）。
- **判定依据**：需求把「颜色/描述」明写为「GitHub 来源、平台不单独维护」，而代码里它是平台的独立可编辑字段、还能反向写到 GitHub —— 这是行为方向相反，不是「缺一个子条件」，所以是冲突而非部分实现。

### LD-2 三条同步规则

- **状态**：与需求冲突
- **证据**：
  - 规则①（GitHub 是事实源，平台不发明标签、不反向创建）**反着来**：`packages/contract/src/repo-config.ts:105-106` 允许 `labels.missing = 'create'`；执行侧 `apps/server/src/worker/writeback.ts:280-293` 在「仓库里没有这个词表标签」时按**平台的** `color` / `description` 调 `catalog.create`，端到端落到 `POST /repos/{owner}/{repo}/labels`（`apps/server/src/app/worker-deps.ts:622-631`）。调用链是活的：`apps/server/src/worker/run-task.ts:1495` → `executeActions` → `apps/server/src/worker/writeback.ts:541-550`。默认值是 `warn`（不建），但能力存在且可配置开启。
  - 规则②（平台只补语义，同步不覆盖含义/分组）：无覆盖路径 —— 目录读取是纯只读映射 `apps/server/src/config/v21-settings.ts:251-258`，`meaning` / `group` 只由面板写入（`apps/panel/src/components/settings/labels-section.tsx:211-221`）。但这条成立是**真空成立**：代码里根本没有同步动作，不是「同步时特意跳过」。
  - 规则③（漂移显性）**未实现**：没有「仓库新增标签 → 自动进目录、含义为空」的写入方（`worker-deps.ts:611-621` 拿到的仓库标签名只用于存在性判断，返回值不落库、不落 settings）；也没有「仓库删除 → 标记失效」的自动标记，`retired` 只能人在面板下拉里手选 `apps/panel/src/components/settings/labels-section.tsx:296-304`。
- **缺口**：
  1. `labels.missing=create` 与「平台不发明标签、不反向创建」直接冲突（`repo-config.ts:105-106` + `worker/writeback.ts:280-293`）；顺带让「颜色/描述由 GitHub 决定」变成平台决定。
  2. 漂移显性两条都没有：仓库新增的标签不会进目录（因此永远没有「含义为空的新条目」），仓库删除的标签不会自动变 `retired`（因此「已失效」这一状态实际上靠人记）。
  3. 规则②虽然表面上没被破坏，但没有同步机制意味着「不覆盖」这条约束没有被任何代码或测试固定住，后续一旦补同步就可能无意覆盖。
- **判定依据**：需求第 1607 行明写「平台不发明标签、不反向创建」，代码里存在一条按平台数据在仓库建标签的活路径（第 280-293 行即反着来的那段），按规范属于「与需求冲突」；同时第 1609 行「漂移要显性」两半均无实现，一并记入缺口。

### LD-3 含义为空保护

- **状态**：已实现
- **证据**：
  - 可管理集合定义：`apps/server/src/writeback/v21/labels.ts:83-85`（`managed !== false && status === 'active' && meaning 非空`）；`null` / 空串 / 纯空白都算没填 `:87-90`。
  - 不可管理原因分列：`apps/server/src/writeback/v21/labels.ts:93-107`（`not-in-catalog` / `retired` / `unmanaged` / `missing-meaning`）。
  - 出站方向：`desired` 里含不可管理项 → 整批拒绝 `apps/server/src/writeback/v21/labels.ts:163-176`（`unknown-label`）。
  - 删除方向（本条的实质）：删除只在可管理集合内产生，其余进 `skipped` `apps/server/src/writeback/v21/labels.ts:187-197` —— 含义为空的当前标签**不会被删**，正是「执行侧不知道它是什么意思，就不该删它」。
  - 测试断言具体：`apps/server/test/writeback-v21-labels.test.ts:146` 起「meaning 为空 / retired / managed=false / 目录外一律不动（不删不加）」，断言 `skipped` 的原因串；`:162-168` 断言纯空白等价于没填且与 `isManageableCatalogEntry()` 一致。
- **缺口**：无。
- **判定依据**：需求 1612-1615 的全部子条件（含义为空 → 不进自动对齐 → 不被删；补上含义后才纳入）都有对应执行路径，且删除路径上有「跳过并留痕」的可见证据。

### LD-4 刷新时机

- **状态**：未实现
- **证据**：
  - 目录的唯一来源是 `repos.settings` 的纯映射，不含任何请求：`apps/server/src/config/v21-settings.ts:249-258`；装配侧同样只是把它映射一遍 `apps/server/src/worker/run-task.ts:390-397`，另一处 `apps/server/src/http/webhook-v21.ts:690-704` 同源。
  - 仓库里与「有效期」相关的常量都不属于标签目录：AGENTS.md 缓存 5 分钟 `apps/server/src/app/worker-deps.ts:763`（`REPO_AGENTS_MD_CACHE_TTL_MS`）、issue 列表 provider 的 `ttlMs` `apps/server/src/http/webhook-v21.ts:239`。标签目录既没有 TTL 常量，也没有时间戳/缓存条目。
- **缺口**：需求 1619 要求的「处理事件前按需刷新 + 有有效期」两半都不存在。后果是双向的：一方面永远不会拿着过期目录做删除判断（因为目录从不刷新），另一方面仓库侧的漂移永远不会被发现 —— 即需求这条真正想防的问题（拿旧目录判断）被换成了另一个问题（目录是手填快照）。
- **判定依据**：需求写的是一个**从仓库取数 + 有效期**的机制，代码里没有任何取数与过期概念；这不是「有字段没人读」，而是机制整体缺失，故判未实现。

### LD-5 目录怎么交给执行侧

- **状态**：部分实现
- **证据**：
  - 「不作为模板占位符」成立：占位符白名单里没有标签目录，只有 `repo` / `target` / `title` / `body` / `labels` / `input.*` 等 `apps/server/src/skills/prompt.ts:656-688`；目录是渲染时**无条件拼接**上去的一段 `apps/server/src/skills/prompt.ts:716-717`。
  - 「固定注入」在事件任务路径上成立：`buildTaskPrompt()` 末尾直接拼 `renderLabelVocabulary(vocabulary)` `apps/server/src/app/worker-deps.ts:344`，由 `apps/server/src/app/compose.ts:1235-1263` 每轮调用。
  - 每个条目确实是「名称 + 含义 + 互斥组」三件：`apps/server/src/skills/prompt.ts:270-283` 输出 `- \`名称\`：含义；互斥组：X（同组只打一个）`（分隔符与需求的「|」不同，字段集合相同）。
  - **「只列含义非空」没做**：`apps/server/src/skills/prompt.ts:276-282` 在 `meaning === undefined` 时仍输出 `- \`名称\`` 这一行；测试把这个行为固定下来了 —— `apps/server/test/skills-prompt.test.ts:200` 造了一条只有 `name` + `role` 的 `area/db`，`:208` 断言 `- \`area/db\`` 出现在提示词里。`retired` / `managed=false` 同样不过滤（渲染只读 `name` / `meaning` / `group`）。
  - **位置不是「紧跟系统提示词」**：系统提示词走独立 system 通道 `apps/server/src/runtime/turn-driver.ts:383-387`；目录在用户消息里，落在 `basePrompt` 的尾部（`worker-deps.ts:344` 是 `buildTaskPrompt` 的最后一段，被 `apps/server/src/skills/assemble.ts:397-423` 的 `tail` 收走），技能命中时还会在技能正文之后再出现一份 `apps/server/src/skills/prompt.ts:702-727`（`## 指令` 之后、`## 任务上下文` 之前）。
- **缺口**：
  1. 「只列含义非空的（即可管理范围）」缺失：无含义条目、`retired` 条目、`managed=false` 条目都会以「只有名字」的形式出现在「本仓库当前可用的全部标签；打标只能从这里选」这一段里（`prompt.ts:264`、`:282`）。模型据此选一个 `retired` 或空含义标签，写回时会被 `writeback/v21/labels.ts:163-176` 整批拒绝 —— 提示词给出的候选集与执行侧的可管理集合不一致。
  2. 「位置紧跟系统提示词」缺失：目录在装配尾部（事件任务路径）或技能正文之后（技能命中路径），与 system 通道的系统提示词之间隔着 P1 / AGENTS.md / 技能正文。
- **判定依据**：「非占位符 + 固定注入」两个子条件是实的，「只列含义非空」和「紧跟系统提示词」两个子条件是虚的，按规范是部分实现，缺口即上述两点。

## 本节整体结论

标签目录的**存储与消费**是完整的：五个字段在一份 schema 里齐备，含义/分组由平台维护，互斥组真的裁剪，`retired` 与含义为空在写回侧受到「不删不加」的保护（LD-3 是本节最扎实的一条）。但目录的**来源**整条链路缺失：名称/颜色/描述不来自 GitHub，仓库漂移不会被发现，也没有任何刷新与有效期机制（LD-1、LD-2、LD-4）。更严重的是代码里存在一条平台反向创建标签的活路径（`labels.missing=create`），与需求「平台不发明标签、不反向创建」方向相反。执行侧那一段又把不可管理的条目一起列为候选，且位置与需求描述不符。综合判：本节**不可**判为已实现。

## 核查边界

- 是否执行了命令：未执行，纯静态核查（只用了文件读取与内容检索；未跑 `pnpm -r test` / `typecheck` / `lint`）。
- 未覆盖的条目及原因：无遗漏条目。带运行环境的点未验证 —— `labels.missing=create` 的真实 GitHub 写入（需真 token）、`retired` 在真实 GitHub 标签删除后的行为（需求要求自动标记，代码里无此路径，属静态即可判定）。
- 发现的额外问题（不属本节范围但值得记录）：
  1. 目录注入在技能命中路径上出现**第二份**（`buildTaskPrompt` 末尾 + `renderSkillPrompt` 内 `prompt.ts:717`），同一条消息里会有两段 `## 项目标签`，措辞还不完全一样（前者无「打标只能从这里选」的强约束句）。
  2. 面板侧的「参与对齐」计数口径（`apps/panel/src/components/settings/settings-chrome.tsx:61-63`）与执行侧口径（`writeback/v21/labels.ts:83-85`）一致，但提示词侧没有复用同一判定，三处口径里提示词这一处是偏的 —— 建议抽一个共用的 `isManageableCatalogEntry()` 供渲染层使用。
  3. `apps/server/src/skills/prompt.ts:292-297` 的 `oneLine()` 会删除标签名里的 `{}`，理论上存在「提示词里的标签名 ≠ 仓库里的标签名」，会让模型给出一个必然被拒的名字。
