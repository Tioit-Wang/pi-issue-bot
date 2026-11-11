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
 * `/issue-format`：issue 信息完整性判断（项目默认技能之一）。
 *
 * 判定口径的来源顺序：仓库里的 issue 模板 → `CONTRIBUTING`/`docs` 里的规范 → 技能里的默认四条。
 * 这是「事实从仓库里取，方法在技能里」的直接体现：换一个仓库，模板换了，判定标准就跟着换。
 */
const ISSUE_FORMAT = `---
name: issue-format
description: 判断一条 issue 的信息是否足够让人动手（复现步骤、期望与实际、版本环境），逐条指出缺什么、如何补；适用于新 issue 刚创建、或作者说「已补充信息」需要复核的场景。
allowed-tools: [Read, Glob, Grep]
timeout: 5m
outputs: [comment]
metadata:
  category: triage
---

## 何时用

issue 需要「能不能开工」的判断：要么刚建，要么作者刚补过信息。不做分类、不打标签（那是 \`/label-triage\` 的事）。

## 工具用法（本技能允许的工具）

- \`Glob(pattern=".github/ISSUE_TEMPLATE/*")\` —— 先看本仓库有没有 issue 模板；有就以模板字段为判定清单。
- \`Read(file_path=".github/ISSUE_TEMPLATE/<文件>")\` —— 读模板，把必填字段抄成清单（字段名照抄，别改写）。
- \`Grep(pattern="issue|Issue", path="CONTRIBUTING.md")\` —— 没有模板时看贡献指南里的 issue 规范。
- \`Glob(pattern="docs/**/*.md")\` + \`Read\` —— 再找不到才用本技能末尾的默认四条。
- issue 正文本身**不用工具取**：它已经在 \`## 任务上下文\` 的「issue 标题 / issue 正文」两段里。

## 步骤

1. 按上面的顺序找判定清单：模板 → 贡献指南 → 默认四条。**把你实际用的是哪一份写进评论**（例如「依据 .github/ISSUE_TEMPLATE/bug_report.yml」）。
2. 逐项对照正文，每项给一个结论：有 / 缺 / 有但不可用（例如「复现步骤只有一句『点一下就坏了』」）。
3. 每项都要**引用原文片段**；正文里没有就写「正文未提及」。
4. 缺项要给**可直接照做的补法**（「补上：应用版本 + 浏览器版本」），不要写「请补充完整信息」。

## 默认判定四条（仅当仓库里找不到模板与规范时使用）

1. **复现步骤**：能照着做的步骤序列（从哪个入口、点什么、用什么数据）。
2. **期望 vs 实际**：期望发生什么、实际发生了什么，两者能对上。
3. **版本环境**：应用版本，加操作系统或浏览器版本（至少一项能定位到具体构建）。
4. 可选：日志、堆栈、截图、录屏。

## 输出

- 只发**一条**评论：先结论（合规 / 不合规），再逐条列 \`字段名 → 结论 → 证据/补法\`。
- \`actions\` 里只给一条 comment 动作，形状见 \`## 输出契约\`。
- 缺信息时**不打标签**（缺项本身不构成缺陷）；合规时也不要为了「表示看过」发明标签。

## 边界与不要做

- ${NO_INVENTED_FACTS}
- 只有标题、正文为空 → 直接不合规，列出「全部字段缺失」而不是让对方「补全所有信息」。
- 模板存在但读不懂（字段是空的、格式损坏）→ 退回默认四条，并在评论里说明模板不可用。
- 仓库里若还留着 \`.github/pi-bot.yml\`（旧版平台配置，**已退役**），它**不是**必填信息的规范，
  不要拿它当判定依据、也不要在评论里引用它；以 issue 模板 / \`CONTRIBUTING\` / \`docs\` 为准。
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

issue 需要「从现象走到可动手的下一步」：根因在哪、影响谁、先验证什么。要复现步骤用 \`/issue-repro\`，要判断信息是否够用 \`/issue-format\`。

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
  { path: 'skills/builtin/issue-format/SKILL.md', text: ISSUE_FORMAT },
  { path: 'skills/builtin/label-triage/SKILL.md', text: LABEL_TRIAGE },
  { path: 'skills/builtin/issue-analysis/SKILL.md', text: ISSUE_ANALYSIS },
]);

/** 内置技能名（归一化后）。用于「面板里至少应该有这几条」的断言与文档。 */
export const BUILTIN_SKILL_NAMES: readonly string[] = Object.freeze([
  '/review-pr',
  '/issue-triage',
  '/issue-repro',
  '/issue-format',
  '/label-triage',
  '/issue-analysis',
]);

/**
 * **每个项目默认就有的三个技能**（需求 §1）。按这个顺序展示，且面板里排在最前。
 *
 * 与 `BUILTIN_SKILL_FILES` 的关系：那六个是「随二进制发布的内置技能」，
 * 这三个是其中的子集 —— 项目级技能页要保证它们一定存在（缺失时按内置正文播种一份可编辑的副本）。
 */
export const DEFAULT_PROJECT_SKILL_NAMES: readonly string[] = Object.freeze([
  '/issue-format',
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
