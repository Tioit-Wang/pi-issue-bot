# U18 6.5 标签目录 · B

> 核查范围：docs/requirements.html 行 1589-1636
> 代码基线：见 docs/audit/v2/_baseline.txt

## 结论速览
| 条目 | 状态 | 一句话缺口 |
|---|---|---|
| LD-1 五字段 | 与需求冲突 | color / description 是平台手填字段（面板可编辑），并在 `labels.missing=create` 时**反向写给 GitHub**；需求写「来自 GitHub、平台不单独维护」 |
| LD-2 三条同步规则 | 与需求冲突 | 存在 `POST /repos/{o}/{r}/labels` 反向创建路径；「新增自动进目录（含义空）」「删除自动标 retired」两条均无代码，status/managed 只能人工切 |
| LD-3 含义为空不进自动对齐 | 已实现 | — |
| LD-4 按需刷新（有有效期） | 部分实现 | 有「写回前拉一次」，但无 TTL / 缓存，每条写回都请求一次；v2.1 目标态计算完全不经 GitHub |
| LD-5 固定注入而非占位符 | 部分实现 | 非占位符✓、固定注入✓；但位置在技能正文之后 / 任务提示词尾部，不「紧跟系统提示词」；且未过滤含义为空的条目 |

## 逐条

### LD-1
- **状态**：与需求冲突
- **证据**：
  - `packages/contract/src/repo-config.ts:76-94` — 词表条目字段：`name`(78) / `role`(80) / `meaning`(82) / `color`(84) / `description`(86) / `group`(88) / `managed`(90) / `status`(92)，全部是仓库配置里的**可写字段**，没有任何字段标注来源。
  - `apps/panel/src/components/settings/labels-section.tsx:23` — 列宽常量即面板列：`name / 角色 / meaning / color / description / group / 操作`；`:224-242` color 由人输入（`TextField` + 6 位十六进制校验 + 色块预览），`:246-255` description 同样人工输入，`:211-217` meaning 人工输入。
  - `apps/server/src/app/worker-deps.ts:622-631` — `create` 用**平台侧** color / description 去建 GitHub 标签：`POST /repos/{owner}/{repo}/labels`，body 里带 `color: input.color`、`description: input.description`。
  - `packages/contract/src/settings-v21.ts:253` — `status` = `['active','retired']`，有效/失效齐；`managed`(288) / `status`(290) 带默认值。
  - 分组互斥：字段在 `repo-config.ts:88`，裁剪逻辑只在旧通道 `apps/server/src/workflows/normalize.ts:178-195`（`groupOwner` + `group-conflict`）；v2.1 目标态 `apps/server/src/writeback/v21/labels.ts:135-223` 无任何 group 判定，只在提示词里写成一句话（`apps/server/src/skills/prompt.ts:279-281`）。
- **缺口**：需求明写「颜色 / 描述 —— 来源 GitHub，与仓库同步，平台不单独维护」（requirements 行 1597），代码把两者做成平台可编辑配置并作为**推送源**（平台→GitHub），方向相反。名称侧也没有任何「与 GitHub 一致」的落地：保存时不校验仓库是否存在同名标签，只有写回时 `labels.missing=warn` 记一笔（`apps/server/src/worker/writeback.ts:320-323`）。
- **判定依据**：字段来源方向是可判事实：需求=拉取，代码=手填 + 推送。`worker-deps.ts:622-631` 是「平台单独维护」的直接证据，不是「未同步」而是「反着同步」。
- **反证过程**（假设「颜色不单独维护」成立，去找它该有的样子）：① 若颜色来自同步，应当有「从 GitHub labels 响应里读 color 并写入配置」的代码——全仓 `GET /repos/{owner}/{repo}/labels` 只有一处（`worker-deps.ts:613-616`），且只 `map(row => row.name)`（619-620），**响应里的 color / description 被丢弃**；② 若颜色不可手填，面板应无输入框——实际有（`labels-section.tsx:224-242`、`:246-255`）；③ 若平台不维护，就不该有把 color 传给 GitHub 的路径——实际有（`worker-deps.ts:624-630`）。三条全部反向，假设被推翻。

### LD-2
- **状态**：与需求冲突
- **证据**：
  - 反向创建路径：`apps/server/src/app/worker-deps.ts:622-631`（`POST /repos/{owner}/{repo}/labels`）；启用条件 `packages/contract/src/repo-config.ts:105-106`（`missing: 'warn' | 'create' | 'ignore'`，默认 `warn`），策略实现在 `apps/server/src/worker/writeback.ts:280-292`（`policy === 'create'` 时调 `create`，成功即推送 `已按词表（labels.missing=create）新建标签`）；面板可选该项 `apps/panel/src/components/settings/labels-section.tsx:416-430`。
  - 拉取侧只有「判 missing」：`apps/server/src/worker/writeback.ts:203`（`const known = input.dryRun ? null : await knownLabelsOf(...)`）→ `:225-240`（`list` 返回纯 `string[]`，不是目录条目）。
  - 无「仓库新增 → 目录新增（含义空）」：`LabelCatalogPort.list` 的返回值 `apps/server/src/workflows/ports.ts:95` 仅 `readonly string[]`，无任何写 `settings.labels.vocabulary` 的代码路径。
  - 无「仓库删除 → 标 retired」：`status` 只在契约里有默认值（`settings-v21.ts:290`）与人工开关（`labels-section.tsx:271,301` 的文案与 `title`），全仓无「按 GitHub 现状改 status」的写入。
  - 「同步不覆盖语义」这一点实际成立，但原因是**根本没有同步写回**：不存在把仓库标签 upsert 进 `vocabulary` 的函数（`grep syncLabels|labelSync|refreshCatalog` 零命中）。
- **缺口**：三条规则中 —— (a)「不发明、不反向创建」被 `labels.missing='create'` 打破（默认关闭，但面板可选、代码完整）；(b)「不覆盖语义」以「完全没有同步」的方式空过；(c)「漂移显性」两条子条件全缺：新增标签不会自动进目录（含义为空的条目只能人工加），删除标签不会自动置 `retired`。
- **判定依据**：需求行 1607 明确「平台不发明标签、不反向创建」，而 `worker-deps.ts:624` 是真实的 `POST /labels`；模板 §七「需求写不 X，代码有 X 分支 → 与需求冲突」即此情形。
- **反证过程**（假设「不反向创建」成立）：① 全仓搜 `createLabel` / `POST /labels` —— 命中 `worker-deps.ts:624`，并且装配点上真的接进了 worker（`apps/server/src/app/compose.ts:798-800` + `:1133` 把 `labelCatalog` 传给写回策略），不是死代码；② 假设「删除会被标失效」——去搜 `status =` / `retired` 的写入方，只有面板 onChange 与契约 default，无 GitHub 驱动；③ 假设「新增标签自动进目录且含义为空」——去搜 `vocabulary` 的写入方（`apps/panel/src/components/settings/labels-section.tsx` 的表单 + `updateVocabulary`），无服务端写入；④ 假设「同步会覆盖 meaning」——找不到同步函数，故这条「看起来达标」其实是空缺而非正确实现。

### LD-3
- **状态**：已实现
- **证据**：
  - `apps/server/src/writeback/v21/labels.ts:82-85` — `isManageableCatalogEntry()` 三个条件与：`managed !== false && status === 'active' && isMeaningFilled(meaning)`。
  - `apps/server/src/writeback/v21/labels.ts:87-90` — `isMeaningFilled()`：`null` / 空串 / 纯空白一律算没填。
  - `apps/server/src/writeback/v21/labels.ts:70-71,93-107` — 删除集合是 `current ∩ 可管理目录 − desired`（`remove` 注释即「可管理目录」），不可管理条目走 `skipped` 且 `unmanageableReason()` 第 4 项为 `'missing-meaning'`。
  - `apps/server/src/worker/run-task.ts:383-397` — 装配处**故意不预筛**（`v21CatalogOf` 全量返回），把过滤留在纯函数里，避免「不可管理」与「目录外」被压成同一种错误。
  - 断言存在且具体：`apps/server/test/writeback-v21-labels.test.ts:139`（`{ label: '外部标签', reason: 'missing-meaning' }`）、`:146-174`（`meaning 为空 / retired / managed=false / 目录外一律不动`，含纯空白用例）。
- **缺口**：（无）
- **判定依据**：需求「含义为空的标签不进入自动对齐范围」（行 1614）在删除侧与新增侧都有执行路径，且是纯函数 + 具体断言，不是注释承诺。
- **反证过程**：假设只判 `managed` 不判 `meaning` —— 若如此，`labels.ts:84` 会只有两个条件；实测三条件且 `isMeaningFilled` 对空白串返回 false（`88-90`），并有 `:162-174` 的空白串用例断言 `missing-meaning`。再查「是否存在绕过该函数的另一条删除路径」：旧通道 `workflows/normalize.ts` 只做打标裁剪（`group` / `max_per_issue`），其 `blocked` 原因枚举（`normalize.ts:38-46`）里没有 meaning 概念，但旧通道只加不删目标态——真正执行删除的 `removeLabel` 由 v2.1 计划产出，故保护未被旁路。

### LD-4
- **状态**：部分实现
- **证据**：
  - 有刷新动作但只在旧通道：`apps/server/src/worker/writeback.ts:203` 每次写回都 `await knownLabelsOf(...)`；`:225-240` 内部直接调 `catalog.list`（即 `GET /repos/{owner}/{repo}/labels`，`worker-deps.ts:613-616`）。
  - 无 TTL / 缓存：`knownLabelsOf` 无入参时间、无存取缓存；`apps/server/src/app/compose.ts:797-800` 只创建一个无状态端口对象，`createGithubLabelCatalog`（`worker-deps.ts:609-633`）内部无 memo，`list` 的返回值也不落库。
  - v2.1 目标态计算完全不碰 GitHub：`apps/server/src/http/webhook-v21.ts:705` 传的是 `settings.labels.max_per_issue`，`run-task.ts:390-397` 的 catalog 来自配置快照，`writeback/v21/labels.ts:135` 起为纯函数。
- **缺口**：需求行 1619 明写「有有效期，不必每条事件都请求一次」；代码是每条写回都请求一次（无有效期常量、无缓存层），且刷新只影响 `labels.missing` 判定，不刷新目录内容本身（目录仍是配置快照，永远不会反映 GitHub 现状）。
- **判定依据**：「按需刷新」的字面要求有两条：时机（处理事件前）+ 有效期（不每条都请求）。前者成立，后者缺失，故为部分实现而非未实现。
- **反证过程**：假设实现有 TTL —— 去找常量与缓存读写：`grep labelCatalogTtl|LABEL_.*TTL|refreshCatalog` 零命中，`knownLabelsOf` 每次直连；假设「刷新会更新目录」——`list` 返回 `string[]`（`ports.ts:95`）被 `applyMissingPolicy` 只用于 `knownSet.has()`（`writeback.ts:262-268`），不写回 `vocabulary`。两者都不成立，只剩「每次请求」，故有效期子条件判定为缺。

### LD-5
- **状态**：部分实现
- **证据**：
  - **非占位符**：`packages/contract/src/settings-v21.ts:420-433` 的 12 个正式占位符里没有目录项（只有 `issue.labels`，行 425），`PLACEHOLDER_NAMES`（446）随之不含目录。✓
  - **固定注入**：`apps/server/src/skills/prompt.ts:717` 在 `renderSkillPrompt()` 组装里无条件调用 `renderLabelVocabulary(context.config?.labels.vocabulary)`；另一条 `apps/server/src/app/worker-deps.ts:344` 在 `buildTaskPrompt()` 结尾无条件调用（`vocabulary` 来自 `:307` 的 `input.settings?.labels.vocabulary ?? []`）。不依赖技能是否命中，属固定注入。✓
  - **位置**：`skills/prompt.ts:702-727` 的段落顺序是「技能身份 → 指令正文(714) → 项目标签(717) → 任务上下文(719)」，即目录在**技能正文之后**；`worker-deps.ts:344` 更是放在输出契约之后的**末尾**。而 system 通道是另一条路：`compose.ts:1407`（`systemPrompt: resolveAgentExecution(policy.settings).system_prompt`）→ `run-task.ts:916` → `turn-driver.ts:384-386`，这条链路里**没有**目录。需求行 1623 要求「位置紧跟系统提示词」。
  - **只列含义非空**：`skills/prompt.ts:270-283` 遍历全部 entry，`meaning` 缺失时 `parts` 为空、落到 `:282` 的 `- \`${name}\`` 分支——**含义为空的标签照样出现**，且首行（`:264`）宣称「本仓库当前可用的全部标签」。
  - 段落有 60 条上限：`skills/prompt.ts:50-53`（`vocabularyEntries: 60`）与 `:255` 的 `slice`，超出部分静默截断（目录最多 200 条，`repo-config.ts:100`）。
- **缺口**：(a) 位置不紧跟系统提示词——它在技能正文之后 / 任务提示词末尾，system 通道里没有目录；(b) 未按「含义非空」过滤，与需求行 1628「只列含义非空的（即可管理范围）」相反，导致目录宣称「全部可用标签」但把不可管理的也列进去，模型可能给出会被 `missing-meaning` 拒绝的标签；(c) 60 条截断与 200 条目录上限不一致，且截断无任何提示（静默）。
- **判定依据**：固定注入与非占位符两条成立，位置与过滤两条不成立，属「主体在、子条件缺」→ 部分实现。
- **反证过程**：① 假设目录根本没注入 —— 找到两处无条件调用（`prompt.ts:717`、`worker-deps.ts:344`），假设被推翻；② 假设它只在某些技能命中时出现 —— 调用点在 `renderSkillPrompt` 的公共组装段，不在任何 `if (skill.name === …)` 里，也不在技能 frontmatter 的可选块里，假设被推翻；③ 假设位置紧跟系统提示词 —— 读 system 链路（`compose.ts:1407` → `turn-driver.ts:384-386`），拼进去的只有 `resolveAgentExecution(...).system_prompt`，`config/v21-settings.ts:209` 也只回落到 `AGENT_IDENTITY_PROMPT`，没有目录，假设被推翻；④ 假设已过滤含义为空 —— 构造「无 meaning」条目走 `:270-283`，必然输出 `- \`name\``（`parts.length === 0` 分支），未过滤成立；⑤ 额外反证「是否被别处过滤后再传入」——`worker-deps.ts:307` 直接取原始 `labels.vocabulary`，`prompt.ts:717` 直接取 `config.labels.vocabulary`，无 `resolveManagedCatalog` / `isManageableCatalogEntry` 调用（该函数仅在 `writeback/v21/labels.ts` 内被 plan 使用），故过滤确实不存在。

## 本节整体结论
§6.5 不能判为「已实现」。语义侧（含义 / 分组 / 状态 / managed）与「含义非空才可自动对齐」这条保护做得扎实（LD-3 已实现，且有具体断言），目录也确实以固定注入而非占位符进入提示词。但需求里最核心的**方向性**约束反了：颜色 / 描述被做成平台手填并反向推给 GitHub，`labels.missing='create'` 提供了「平台发明标签」的完整路径，而「仓库新增/删除自动反映到目录」这一半则完全没有代码。交付侧还有两处打折：注入位置不在系统提示词紧后，且未按含义过滤。建议按 LD-1 / LD-2 的冲突项先做产品裁决（删 `create` 策略、还是改需求允许平台建标签），再补 GitHub → 目录的同步与 TTL。

## 核查边界
- 是否执行了命令：未执行测试或构建；仅执行了两次只读检查——`Test-Path`/`New-Item` 创建本单元输出目录，`git` 相关命令未运行。结论为纯静态核查（`grep` / 读文件）。
- 未覆盖的条目及原因：
  - 「颜色实际是否与 GitHub 一致」需真 GitHub 环境验证（无法判定是否会 422 / 是否真的覆盖仓库色），按静态证据已可判冲突，未升级为「无法判定」。
  - `labels.missing='create'` 是否在生产配置里被打开，需读生产 settings 快照（本单元不接触运行数据），故只判「存在该路径」。
- 发现的额外问题（不属本节范围但值得记录）：
  1. `skills/prompt.ts:255` 的 60 条上限（`PROMPT_LIMITS.vocabularyEntries`）小于目录上限 200（`repo-config.ts:100`），超限静默截断，模型看到的是不完整目录却被告知「全部标签」——会让「看不到全量标签却输出目标态」这个需求本来想防的风险重新出现。
  2. 分组互斥在 v2.1 目标态里没有执行路径（`writeback/v21/labels.ts` 无 group 判定），只有旧 `workflows/normalize.ts:178-195` 有；如果旧通道废弃，`group` 会退化成纯提示词文案。
  3. `repo-config.ts:100` 的 `max(200)` 与 `settings-v21.ts:277` 的 `name.max(50)` 一致，但 `description.max(500)`（`repo-config.ts:86`）远大于 GitHub 标签描述上限 100，`create` 路径可能因超长 422（属 LD-2 冲突项的连带风险）。
