/**
 * 内置技能（`skills/builtin/<name>/SKILL.md` 的代码内等价物，契约 §1 表格第一行）。
 *
 * 为什么把 md 文本内联成常量、而不是运行期读文件：
 *  - 内置技能随二进制发布，安装目录未必带 `skills/`；读文件的失败路径（ENOENT）会比
 *    「技能不存在」更晚暴露，排查成本更高。
 *  - 内联后**内置技能也走同一条加载链路**（`parseSkillFile` → `skillFrontmatterSchema`）：
 *    我们自己写错 frontmatter 与仓库写错是同一个报错，不会出现「内置的没校验、仓库的才校验」。
 *
 * ── 技能怎么写（三层分工，改这些常量前先读一遍）───────────────────────────────
 * 1. **事实层**：仓库名、issue/PR 编号、当前标签、项目标签词表、提交 sha —— 全部由
 *    `skills/prompt.ts` 用运行时真值渲染进提示词的 `## 任务上下文` / `## 项目标签` 段。
 *    **技能正文里不许出现 `{{...}}` 占位符**：占位符既不是事实（它要人填），也不是工具
 *    （它不能被调用），只会让模型漏掉真正该看的那一段。技能要引用事实时，引用**段名**：
 *    「`## 项目标签` 里列出的标签名」「`## 任务上下文` 的 head/base 提交」。
 * 2. **方法层**（就是下面的正文）：这一件事怎么做 —— 先调哪个工具、传什么参数、结果怎么判、
 *    判不出来怎么办。工具是宿主的 `Read / Glob / Grep / Bash`（必要时 `Write / Edit`），
 *    每个技能只列**自己用得到的那几个**，并写清调用形式。
 * 3. **动作层**：结论怎么落到 GitHub —— 信封 `actions`（`comment` / `label` / …），
 *    形状由提示词的 `## 输出契约` 规定，技能里只强调本场景最容易错的那一条。
 *
 * 与 Agent Skills 标准（agentskills.io）对齐的几条硬规则：
 *  - `description` 写**何时用**（触发条件 + 适用对象），不写步骤；它会被拿去检索。
 *  - SKILL.md 只放「做这件事的最小必要知识」，长清单/词典引到 `references/`（渐进披露）。
 *  - 只做一件事；边界（缺信息、找不到、权限不足）与「不要做什么」必须显式写。
 *
 * `examples/skills/*.md` 是同样内容的**模板副本**（供仓库维护者拿去改，也是 doctor/CI 的校验样本）。
 * 两份不许漂移：`apps/server/test/skills-registry.test.ts` 会比对 name / allowed-tools / outputs。
 */
import type { SkillFile } from './types.ts';

/** 正文里反复出现的两句话，抽出来避免各技能写歪。 */
const NO_INVENTED_FACTS = '正文里没有的信息写「正文未提及」，不要补全、不要推测。';
const FILE_LINE_RULE = '每条结论都要能指到 `文件:行`（或明确写「未定位到」），不要凭文件名猜。';

/** `/review-pr`：审查 PR。允许推 `bot/*` 分支（`outputs` 含 `pr`）。 */
const REVIEW_PR = `---
name: /review-pr
description: 审查一个 PR：按改动范围读 diff、只跑受影响检查，给出「可合并 / 需修改」的结论与必修项清单；适用于 PR 需要人工 review 或合并前把关的场景。
allowed-tools: [Read, Glob, Grep, Bash]
timeout: 30m
inputs:
  - name: focus
    required: false
    pattern: '^[a-z0-9-]{1,20}$'
    description: 只看某一方面：repro / tests / api / deps / style
outputs: [comment, pr]
---

## 何时用

PR 需要结论性 review：能不能合、要改什么。不做代码风格挑刺，不做无关重构建议。

## 工具用法（本技能允许的工具）

- \`Read(file_path="<路径>")\` —— 读改动涉及的文件原文。先读改动点前后各 20 行，别通读全仓。
- \`Grep(pattern="<符号名|报错文案>", path="<目录>")\` —— 找调用方与被调用方，判断改动是否漏改。
- \`Glob(pattern="<改动文件同目录>/**/*.test.*")\` —— 找这个改动对应的现有测试。
- \`Bash(command="git diff --stat <base>..<head>")\` —— base/head 见 \`## 任务上下文\` 的「base 提交 / head 提交」两行；先看 stat 再决定读哪几个文件。
- \`Bash(command="pnpm --filter <包名> test")\` —— 只跑受影响包的测试；改的是类型或公共包时再补 \`pnpm -w typecheck\`。

## 步骤

1. 读 PR 标题与正文（见 \`## 任务上下文\`），用一句话复述它想解决的问题；说不清就在结论里点明「描述不足」。
2. \`git diff --stat\` 看改动范围，按文件分组；每个文件挑**最关键的 1–3 处**读。
3. 找受影响面：导出符号被谁用（Grep）、有没有配套测试（Glob）、有没有改到公共契约。
4. 只跑受影响检查；跑不动（依赖缺失、命令不存在）就写明「未运行，原因 X」，不要假称通过。
5. 逐条给结论，每条附 \`文件:行\` 与证据。

## 输出

- 一条评论：一句话结论（可合并 / 需修改）+ 必修项清单（按严重度排序）+ 已验证过什么。
- 有**明确、可自动修复且只落在允许路径内**的问题时，可推 \`bot/*\` 分支并提 PR；否则只评论、不动代码。
- 参数 \`focus\` 给定时只深入该方面，其余各一句带过。

## 边界与不要做

- ${FILE_LINE_RULE}
- 不做全仓测试、不做纯风格建议、不逐行复述 diff。
- 没有实测就不要写「已验证」；写「未验证」并说明缺什么。
`;

/**
 * `/issue-triage`：静默分诊（只打标，不发评论）。
 *
 * 与 `/label-triage` 的分工：这个给**自动化流程**用（事件触发、无人看评论），
 * 那个是有人在意结论时用（打标 + 一条结论评论）。
 */
const ISSUE_TRIAGE = `---
name: /issue-triage
description: 静默分诊：只判定 issue 的类别并打上标签，不发表任何评论；适用于事件触发的自动化流程，或只想让标签自动归位、不打扰作者的场景。
allowed-tools: [Read, Grep, Glob]
outputs: [labels]
---

## 何时用

需要「标签自动归位」但不要打扰作者的场合。要给人看结论时改用 \`/label-triage\`。

## 工具用法（本技能允许的工具）

- 标签清单**不需要工具**：\`## 项目标签\` 段就是本仓库当前可用的全部标签名（含说明与互斥组）。
- \`Grep(pattern="<模块名|组件名|接口路径>", path=".")\` —— 正文提到的是哪个子系统的词，就在仓库里确认它存在，避免把「猜的模块」写进判定依据。
- \`Read(file_path="<路径>")\` —— 需要看 \`README\`/\`CONTRIBUTING\`/领域术语表时读对应文件。
- \`Glob(pattern="docs/**/*.md")\` —— 不确定术语表位置时先列出来。

## 步骤

1. 读 \`## 任务上下文\` 的标题与正文，判断这是**缺陷**（行为与预期不符）、**需求**（想要新能力）还是**提问**（使用咨询）。
2. 在 \`## 项目标签\` 里按每条标签的说明挑出对应项；同组（互斥组）只打一个。
3. 拿 \`## 任务上下文\` 的「当前标签」比对：已经有的不要重复添加。
4. 证据不足就**不打**，并在 \`verdict.evidence\` 写明缺哪条证据。

## 输出

- \`actions\` 里给 label 动作：\`{"intent":"label","add":["<标签名>"],"remove":[]}\`。
- \`actions\` 里**不要**放 comment —— 本技能的语义就是静默。
- \`verdict.labels\` 只是判定说明，**不会写回 GitHub**；不写 actions 就等于没打标。

## 边界与不要做

- 词表为空（\`## 项目标签\` 写着「没有配置标签词表」）→ 不打任何标签，只填 \`verdict.evidence\`。
- 不发明标签名，不把判定键（\`bug\`/\`feature\` 这类内部词）直接当仓库标签。
- ${NO_INVENTED_FACTS}
`;

/** `/issue-repro`：尝试复现并写回最小复现步骤。 */
const ISSUE_REPRO = `---
name: /issue-repro
description: 按 issue 描述在本仓库尝试复现问题，写回最小复现步骤或明确的缺口清单；适用于「怀疑是代码问题但还无法稳定重现」的 issue。
allowed-tools: [Read, Grep, Glob, Bash]
timeout: 20m
outputs: [comment]
---

## 何时用

issue 描述了可观察的异常行为，但还没有人能稳定重现。目标是把「能不能重现」问清楚，而不是修。

## 工具用法（本技能允许的工具）

- \`Read(file_path="<路径>")\` —— 读被怀疑的实现与它的现有测试。
- \`Grep(pattern="<报错文案|接口路径|界面文案>", path=".")\` —— issue 里的原始文案逐字拿去搜，这是定位最快的一步。
- \`Glob(pattern="**/*.test.*")\` —— 找最接近的现有测试，复现优先落在测试基建里。
- \`Bash(command="pnpm --filter <包名> test -t '<关键字>'")\` —— 跑单个相关测试；不要跑全量。
- \`Bash(command="git log --oneline -10 -- <路径>")\` —— 怀疑是近期改动引入时看这段历史。

## 步骤

1. 从 \`## 任务上下文\` 的正文里抽出四件事：环境（版本/系统）、操作步骤、期望结果、实际结果。缺哪项直接记下来。
2. 用 issue 里的原文（报错文案、接口路径）去 Grep，定位最可能的代码位置。
3. 在现有测试基建里写一个**最小**复现（临时文件不要提交；能跑就够）。
4. 跑它：
   - 复现成功 → 记录最小步骤 + 关键失败输出（只摘必要几行）。
   - 复现失败 → 说明试过什么、卡在哪、还需要作者补哪一条信息。

## 输出

- 一条评论：结论（已复现 / 未能复现 / 信息不足）+ 最小步骤或缺口清单 + 你实际跑过的命令。
- 不动代码、不打标签、不提 PR。

## 边界与不要做

- 不新增依赖，不改源码；需要的改动只在评论里说明。
- 跑不起来就写清原因（缺依赖、缺环境变量、无网络），不要用「应该能复现」代替实测。
`;

/**
 * `/proposal-analysis`：issue 打开 / 正文被编辑后的「提议分析」（取代原 `/issue-format`）。
 *
 * 为什么不再做「格式检查」：模板字段是给人的提示，不是准入门槛。判合格的唯一标准是
 * 「这条内容能不能被读懂并处理」——`rt`/`如题`/`闪退`/`win11` 这类口语必须按语义等价理解。
 *
 * 正文刻意写短（≤2.5KB）：装配预算 12k 字符，超了会**从后往前丢**，第一个被丢的就是技能正文
 * （2026-11-12 实测：技能体 4.7KB 时整段被丢，模型退化成自由发挥）。
 */
const PROPOSAL_ANALYSIS = `---
name: proposal-analysis
description: issue 打开或正文被编辑后自动做的「提议分析」：先判这条内容属于 bug、需求、无关还是滥用，再按类型给出下一步——bug 看现象能否定位，需求按「最小 RFC」看能否决策，无关内容告知不该开在这里，滥用只做处置；适用于 open / edited 的自动入口。
allowed-tools: [Read, Glob, Grep]
timeout: 5m
outputs: [comment, labels]
metadata:
  category: triage
---

## 工具用法（本技能允许的工具）

- \`Grep(pattern="<正文里的界面文案|模块名|接口路径>", path=".")\` —— 确认「是不是本项目的真实问题」。
- \`Read(file_path="AGENTS.md")\` / \`Read(file_path="README.md")\` —— 判断这条内容是否属于本项目的讨论范围。

## 只判语义，不判格式

用户不用按模板写，能被读懂就算合格：\`rt\`/\`如题\` = 见标题；\`闪退\`/\`卡死\`/\`点了没反应\` = 实际行为；\`win11\`/\`mac 14\` = 系统环境。缺日志、缺截图、缺分步复现都**不是**打回理由。

## 先判类型（落到标签）

- **bug**：行为与预期不符 → \`bug\`
- **需求 / 提案**：想要新能力或改变现有行为 → \`enhancement\`
- **无关**：与项目无关的闲聊、广告、投票、问别的项目 → \`invalid\`
- **滥用**：人身攻击、辱骂、挑衅 → \`abuse\`

## 需求类：最小 RFC（够决策即可，不要求作者写全）

1. **Summary**：一句话说清改变谁的什么行为
2. **动机**：什么问题、为什么现在做、不做会怎样
3. **Goals / Non-goals**：明确**不做什么**（否则范围必然蔓延）
4. **备选**：至少 1 个被否掉的方案与理由
5. **风险与回滚**：最坏情况、出问题怎么退
6. **验收**：≤3 条可测标准
7. **待决议**：谁决定什么（≤3 条）

缺项**由你给默认建议**（「若无人反对就按 X 做」）；只有「连目标都说不清」才要求作者补充一句。

## 提案质量的三个反例

- 只写「打算怎么实现」、没有取舍与备选 → 没有决策价值，补一条备选
- 没有 Non-goals → 范围会一直长，先划出「本次不做」
- 没有回滚路径 → 不可上线，先说明开关与退路

## 处置

1. **读得懂** → 类型 + 引用原文依据 + 一句下一步；需求附「RFC 缺口 + 默认建议」
2. **读不懂** → 点名缺哪几项、每项怎么补（「补一句：在哪个界面、点了什么、看到什么」）
3. **无关** → 说明这里只讨论 bug / 需求 / 提案，并给一句「改成提案怎么写」的示范
4. **滥用** → 一句「已按滥用处理」+ \`abuse\` 标签，**不复述攻击性原文**，只描述性质

## 输出

- 一条评论（≤10 行）+ 一个 label 动作：\`{"intent":"label","add":["<标签名>"],"remove":[]}\`。
- 标签只用 \`## 项目标签\` 里的；互斥组只打一个；用与作者相同的语言。

## 边界与不要做

- ${NO_INVENTED_FACTS}
- 不把 bug 套进 RFC 结构（bug 只看现象、预期、影响面）。
- 不改代码、不提 PR、不关闭 issue（关闭由维护者按 \`abuse\` 标签处理）。
`;

/**
 * `/label-triage`：分类并**真正打上**标签（项目默认技能之一）。
 *
 * 「最容易错的一步」写在这里是有来历的：实测模型会把标签写进 `verdict.labels` 就宣布「已打标」，
 * 而写回只认 `actions` 里的 label 动作 —— 于是评论说打了、issue 上什么都没有（issue #25）。
 */
const LABEL_TRIAGE = `---
name: label-triage
description: 判定 issue 属于缺陷、需求还是提问，从项目标签词表里选出对应标签并真正打上，同时用一条评论说明依据；适用于需要给人看清结论的归类场景。
allowed-tools: [Read, Grep, Glob]
timeout: 5m
outputs: [comment, labels]
metadata:
  category: triage
---

## 何时用

需要「归类 + 让人知道为什么这么归类」。只想静默打标时用 \`/issue-triage\`。
标签不能凭印象取：本仓库有哪些标签、每个标签什么含义，全在 \`## 项目标签\` 段。

## 工具用法（本技能允许的工具）

- **取标签清单**：读 \`## 项目标签\` 段（服务端用本项目的 \`labels.vocabulary\` 渲染，含每个标签的说明与互斥组）。这一段就是「当前项目可用标签」的权威来源，**不要用 Bash/网络去猜 GitHub 标签**。
- **取当前标签**：读 \`## 任务上下文\` 的「当前标签」一行，避免重复添加、避免互斥组冲突。
- \`Grep(pattern="<正文里出现的模块名/接口路径>", path=".")\` —— 归类需要确认「这属于哪个子系统」时，先在仓库里证实该词存在。
- \`Read(file_path="README.md")\` / \`Read(file_path="docs/<...>.md")\` —— 需要理解产品范围（是缺陷还是需求）时读文档，而不是凭感觉。

## 步骤

1. 判断类别：**缺陷**（行为与预期不符）/ **需求**（要新能力）/ **提问**（使用咨询）。判据来自正文的具体描述，不是标题里的「bug」两个字。
2. 到 \`## 项目标签\` 里按说明匹配：每个候选标签都要能对上标签说明里的含义。
3. 检查冲突：同一互斥组只能选一个；与「当前标签」重复的不要重复 add。
4. 证据不足（正文只有一句话、看不出类别）→ 不打标，在评论里说明需要哪条信息才能定类。

## 打标的唯一生效方式（最容易错的一步）

- 让标签真的出现在 GitHub 上，必须在 \`actions\` 里给 label 动作：
  \`{"intent":"label","add":["<标签名>"],"remove":[]}\`
- \`verdict.labels\` 只是判定说明，**不写回**。评论里写「已打 X 标签」却没有对应动作，是本技能最严重的错误。
- 发现旧标签确实错了才用 \`remove\`；宁可不删也不错删。

## 输出

- 一条评论：一句话说清「判为什么、依据哪几句原文」；不要罗列内部推理过程。
- \`actions\`：label 动作（必须）+ comment 动作（必须，内容与评论一致）。

## 边界与不要做

- 词表为空 → 不打标，只评论说明「本项目尚未配置标签词表」。
- 仓库里若还留着 \`.github/pi-bot.yml\`（已退役的旧版平台配置），不要从它里面找标签名 —— 标签名只看 \`## 项目标签\`。
- 不发明标签名；不把内部判定键当仓库标签；不在同一条里 add 同一互斥组的两个标签。
- ${NO_INVENTED_FACTS}
`;

/** `/issue-analysis`：issue 分析（项目默认技能之一）。 */
const ISSUE_ANALYSIS = `---
name: issue-analysis
description: 分析一条 issue 的根因假设、影响面与下一步验证动作，结论要指到具体代码位置；适用于「知道有问题但不知道从哪下手」的 issue。
allowed-tools: [Read, Grep, Glob, Bash]
timeout: 20m
outputs: [comment]
metadata:
  category: analysis
---

## 何时用

issue 需要「从现象走到可动手的下一步」：根因在哪、影响谁、先验证什么。要复现步骤用 \`/issue-repro\`，要判「这条内容值不值得处理」用 \`/proposal-analysis\`。

## 工具用法（本技能允许的工具）

- \`Grep(pattern="<报错文案|界面文案|接口路径>", path=".")\` —— 从 issue 里的**原文**反查代码位置，这是第一步，不是按文件名猜。
- \`Glob(pattern="**/*.test.*")\` —— 找到相关测试，判断现有测试为什么不覆盖这个场景。
- \`Read(file_path="<路径>")\` —— 读命中的实现与调用方，确认数据从哪来到哪去。
- \`Bash(command="pnpm --filter <包名> test -t '<关键字>'")\` —— 跑相关测试验证假设；只跑相关，不全量。
- \`Bash(command="git log --oneline -10 -- <路径>")\` —— 怀疑是近期回归时查这段历史。

## 步骤

1. **定位**：用正文里的原始文案 Grep，落到文件与行；给出你实际用的搜索词。
2. **读透**：读命中处及其调用方，写出当前的真实行为（不是你以为的行为）。
3. **假设**：最多 3 条根因，按可能性排序，每条附 \`文件:行\` 与支持它的证据；没有证据的假设要标明「推测」。
4. **影响面**：受影响的用户路径、数据结构、是否有兼容性/迁移影响。
5. **下一步验证**：能在本仓库跑的命令，或需要作者补的一条关键信息。

## 输出

- 一条评论：结论 → 依据（\`文件:行\`）→ 影响面 → 下一步。
- 每条都要能复核；没把握写「未验证」并说明缺什么。

## 边界与不要做

- ${FILE_LINE_RULE}
- 不改代码、不推分支；需要改动时在评论里写清范围，由人确认。
- 搜不到就写「未定位到」+ 试过的搜索词，不要编造代码位置。
`;

﻿/**
﻿ * `/req-analysis`：需求类 issue 分析（相对 `/issue-analysis` 的分工：那边问「根因在哪」，
 * 这边问「要改成什么样、改哪里、算不算做完」）。
﻿ *
﻿ * 与 `/label-triage` 的边界写进「何时用」：那边只归类，这边只出方案。
﻿ */
﻿const REQ_ANALYSIS = `---
name: req-analysis
description: 把一条需求 issue 变成可动手的方案：复述目标、指出仓库里现有的相关实现、列改动面与可测的验收标准，并点出必须澄清的歧义；适用于「想做什么已经说了、但不知道要改哪里、怎样算做完」的需求类 issue。
allowed-tools: [Read, Glob, Grep, Bash]
timeout: 20m
outputs: [comment]
metadata:
  category: analysis
---

## 何时用

需求类 issue（想要新能力、或要改变现有行为）。缺陷用 \`/bug-analysis\`；开 issue 时的类型判定与准入用 \`/proposal-analysis\`；归类打标用 \`/label-triage\`。

## 工具用法（本技能允许的工具）

- \`Grep(pattern="<正文里的模块名|接口路径|界面文案>", path=".")\` —— 需求常提到现有概念，先在仓库里证实它存在、在哪一层。
- \`Glob(pattern="apps/**/*")\` / \`Glob(pattern="packages/**/*")\` —— 按目录结构找相关模块；不确定归属时先 Glob 再 Read，别猜文件名。
- \`Read(file_path="<路径>")\` —— 只读你准备引用的那几处实现和它的测试，别通读全仓。
- \`Bash(command="git log --oneline -10 -- <路径>")\` —— 这块最近在动什么，决定是「新增」还是「改造」。

## 步骤

1. **复述**：一句话说清这条需求要改变谁的什么行为；说不清就写「目标不明确」，并给出你认为的两种理解。
2. **现状**：仓库里最相关的实现（\`文件:行\`）、现有测试、是否已有部分能力。找不到就写「未定位到」+ 用过的搜索词。
3. **改动面**：要动哪些模块 / 契约 / 数据结构；有没有兼容性或迁移影响（改了会破坏哪个已有调用方）。
4. **歧义与待确认**：最多 3 条，每条给一个**默认建议**（「若无人反对就按 X 做」），不要只提问不给主张。
5. **验收标准**：3–5 条可测、能判断「做完没做完」的标准，尽量写成「输入 → 期望结果」。

## 输出

- 一条评论：目标一句话 → 现状（\`文件:行\`）→ 改动面 → 待确认（带默认建议）→ 验收标准。
- 25 行以内；能用列表就别写长段落。

## 边界与不要做

- ${FILE_LINE_RULE}
- 不写代码、不提 PR、不打标签：需要改动时写清范围，由人确认。
- 不把需求当缺陷：没有「行为与预期不符」的证据就不要列根因假设。
- 不给排期与人力承诺。
- ${NO_INVENTED_FACTS}
`;

/**
 * `/bug-analysis`：缺陷类 issue 分析（相对 `/issue-repro` 的分工：那边只回答能不能重现，
 * 这边要给出根因假设、影响面与下一步验证动作）。
 */
const BUG_ANALYSIS = `---
name: bug-analysis
description: 分析一条缺陷 issue 的根因假设、影响面与下一步验证动作，结论必须指到具体代码位置并说清证据强弱；适用于「已经能描述异常现象、但不知道是哪段代码、该先验证什么」的缺陷类 issue。
allowed-tools: [Read, Glob, Grep, Bash]
timeout: 20m
outputs: [comment]
metadata:
  category: analysis
---

## 何时用

缺陷类 issue（行为与预期不符）。要方案的需求用 \`/req-analysis\`；只要回答「能不能重现」用 \`/issue-repro\`；开 issue 时的类型判定与准入用 \`/proposal-analysis\`。

## 工具用法（本技能允许的工具）

- \`Grep(pattern="<报错文案|接口路径|界面文案>", path=".")\` —— 用正文原文逐字搜，这是定位第一步，不要按文件名猜。
- \`Glob(pattern="**/*.test.*")\` —— 找最接近的现有测试，看它为什么不覆盖这个场景。
- \`Read(file_path="<路径>")\` —— 读命中处与它的调用方，确认数据从哪来、到哪去。
- \`Bash(command="git log --oneline -10 -- <路径>")\` —— 怀疑是近期回归时查这段历史。

## 步骤

1. **现象**：把正文里的「期望 vs 实际」抄成两行；只有一边就写明缺哪一边。
2. **定位**：用原文 Grep，落到 \`文件:行\`；写清你实际用过的搜索词。
3. **假设**：最多 3 条根因，按可能性排序；每条附 \`文件:行\` 与支持它的证据，证据不足的标「推测」。
4. **影响面**：受影响的用户路径、数据结构、是否有兼容性 / 迁移影响。
5. **下一步验证**：能在本仓库跑的命令（\`Bash(command="pnpm --filter <包名> test -t '<关键字>'")\`，只跑相关不全量），或需要作者补的一条关键信息。

## 输出

- 一条评论：结论 → 依据（\`文件:行\`）→ 影响面 → 下一步验证；每条都要能被别人复核。
- 没把握写「未验证」并说明缺什么；搜不到写「未定位到」+ 试过的搜索词。

## 边界与不要做

- ${FILE_LINE_RULE}
- 不改代码、不推分支、不打标签；需要改动时在评论里写清范围，由人确认。
- 不把猜来的模块名写进判定依据；不要为了「看起来完整」编造堆栈或代码位置。
- ${NO_INVENTED_FACTS}
`;

/**
 * 内置技能清单。顺序不影响加载结果（注册表按名排序输出），只为可读。
 *
 * `path` 用契约 §1 的内置路径形态，日志与面板据此区分来源。
 */
export const BUILTIN_SKILL_FILES: readonly SkillFile[] = Object.freeze([
  { path: 'skills/builtin/review-pr/SKILL.md', text: REVIEW_PR },
  { path: 'skills/builtin/issue-triage/SKILL.md', text: ISSUE_TRIAGE },
  { path: 'skills/builtin/issue-repro/SKILL.md', text: ISSUE_REPRO },
  // 每个项目都该有的三个基线技能（需求：issue 格式判断 / 打标 / issue 分析）
  { path: 'skills/builtin/proposal-analysis/SKILL.md', text: PROPOSAL_ANALYSIS },
  { path: 'skills/builtin/label-triage/SKILL.md', text: LABEL_TRIAGE },
  { path: 'skills/builtin/issue-analysis/SKILL.md', text: ISSUE_ANALYSIS },
  // 需求 / 缺陷两个专用分析技能：与上面「通用分析」并存，靠 description 区分适用场景
  { path: 'skills/builtin/req-analysis/SKILL.md', text: REQ_ANALYSIS },
  { path: 'skills/builtin/bug-analysis/SKILL.md', text: BUG_ANALYSIS },
]);

/** 内置技能名（归一化后）。用于「面板里至少应该有这几条」的断言与文档。 */
export const BUILTIN_SKILL_NAMES: readonly string[] = Object.freeze([
  '/review-pr',
  '/issue-triage',
  '/issue-repro',
  '/proposal-analysis',
  '/label-triage',
  '/issue-analysis',
  '/req-analysis',
  '/bug-analysis',
]);

/**
 * **每个项目默认就有的三个技能**（需求 §1）。按这个顺序展示，且面板里排在最前。
 *
 * 与 `BUILTIN_SKILL_FILES` 的关系：那六个是「随二进制发布的内置技能」，
 * 这三个是其中的子集 —— 项目级技能页要保证它们一定存在（缺失时按内置正文播种一份可编辑的副本）。
 */
export const DEFAULT_PROJECT_SKILL_NAMES: readonly string[] = Object.freeze([
  '/proposal-analysis',
  '/label-triage',
  '/issue-analysis',
]);

/** 按名字取内置技能的 SKILL.md 正文（播种 / 物化用）。 */
export function builtinSkillText(name: string): string | null {
  const normalized = name.startsWith('/') ? name : `/${name}`;
  const file = BUILTIN_SKILL_FILES.find((item) => {
    const match = /^name:\s*\/?([a-z0-9-]+)\s*$/mu.exec(item.text);
    return match !== null && `/${match[1]}` === normalized;
  });
  return file === undefined ? null : file.text;
}
