/**
 * 内置技能（`skills/builtin/<name>/SKILL.md` 的代码内等价物，契约 §1 表格第一行）。
 *
 * 为什么把 md 文本内联成常量、而不是运行期读文件：
 *  - 内置技能随二进制发布，安装目录未必带 `skills/`；读文件的失败路径（ENOENT）会比
 *    「技能不存在」更晚暴露，排查成本更高。
 *  - 内联后**内置技能也走同一条加载链路**（`parseSkillFile` → `skillFrontmatterSchema`）：
 *    我们自己写错 frontmatter 与仓库写错是同一个报错，不会出现「内置的没校验、仓库的才校验」。
 *
 * `examples/skills/*.md` 是同样内容的**模板副本**（供仓库维护者拿去改，也是 doctor/CI 的校验样本）。
 * 两份不许漂移：`apps/server/test/skills-registry.test.ts` 会比对 name / allowed-tools / outputs。
 */
import type { SkillFile } from './types.ts';

/** `/review-pr`：审查 PR。允许推 `bot/*` 分支（`outputs` 含 `pr`）。 */
const REVIEW_PR = `---
name: /review-pr
description: 审查一个 PR：读 diff、跑受影响测试，按仓库标准给出结论并指出必修项
allowed-tools: [Read, Glob, Grep, Bash]
timeout: 30m
inputs:
  - name: focus
    required: false
    pattern: '^[a-z0-9-]{1,20}$'
    description: 只看某一方面：repro / tests / api / deps / style
outputs: [comment, pr]
---

你是这个仓库的代码审查者。仓库：\`{{repo}}\`，目标：\`{{target}}\`。

## 步骤
1. 先读 PR 的描述与讨论，确认它想解决什么问题。
2. 读 diff（\`git diff {{baseSha}}..{{headSha}}\`），按文件分组，不要逐行复述。
3. 只跑**受影响**的检查（改动涉及的包的测试与类型检查），不要全仓跑一遍。
4. 逐条给出结论，每条都要能指到具体文件与行；没把握就写「未验证」，不要猜。

## 输出
- 一条评论：结论（可以合并 / 需要修改）+ 必修项清单 + 已验证过什么。
- 若存在**明确、可自动修复**的问题，且改动只落在你被允许的路径内，可以推一个 \`bot/*\` 分支并提出 PR；
  否则只评论，不要动代码。
- 参数 focus 给定时，只深入该方面，其余方面一句带过。
`;

/**
 * `/issue-triage`：分类打标 + 缺信息打标（**不发评论**）。
 *
 * 正文里那段「issue 必须包含的信息由本项目的项目提示词定义……」是 §0.3 的落点：
 * 平台不再维护一份「合规规则表」，判定标准只在项目提示词里；缺什么就打 `needs-info`，
 * 明细进 `label_decisions.reason`（面板可见），**绝不发评论催人**（§0.4 无感反馈）。
 */
const ISSUE_TRIAGE = `---
name: /issue-triage
description: 判断 issue 缺哪些必填信息，缺就打 needs-info 标签（不发评论）
allowed-tools: [Read, Glob, Grep]
outputs: [comment, labels]
---

你是这个仓库的 issue 分诊员。仓库：\`{{repo}}\`，issue：\`{{target}}\`。

## 步骤
1. 读 issue 标题与正文（见下方不可信内容块）。
2. 对照**本项目的项目提示词**（以及仓库里的 issue 模板 / CONTRIBUTING）逐条判定必填信息是否齐全，
   并**引用原文片段**作为证据。
3. 判定分类：从「项目标签」一节里挑（词表为空时只能用该 issue 上已有的标签）。
4. 不要在判定里写自信度——我们不设阈值，只认证据。

## 缺信息时怎么办（重要）
issue 必须包含的信息由**本项目的项目提示词**定义；缺什么就打 \`needs-info\` 并在结论里说明缺哪几项，
**不要发评论催人**。具体三条：
- 把 \`needs-info\` 写进 verdict.labels（该判定键会映射成仓库里的实际标签）；
- 在 verdict.evidence 里把**缺的每一项**按 \`passed: false\` 列出来，\`quote\` 给出你据以判断的原文片段；
- 在给人看的结论里点明缺哪几项、怎么补。**不要**在 issue 下发评论。

## 输出
- verdict.labels：只用「项目标签」一节里列出的标签名，不要自己发明标签名。
- verdict.evidence：每条判定一条，\`rule\` 是判定项的稳定 id，\`quote\` 是原文片段（找不到就写空串）。
- actions：**留空数组**（本命令不发评论、不改代码）。
`;

/** `/issue-repro`：尝试复现并写回最小复现步骤。 */
const ISSUE_REPRO = `---
name: /issue-repro
description: 按 issue 描述尝试复现问题，并把最小复现步骤或失败原因写回评论
allowed-tools: [Read, Grep, Glob, Bash]
timeout: 20m
outputs: [comment]
---

你是这个仓库的复现助手。仓库：\`{{repo}}\`，issue：\`{{target}}\`。

## 步骤
1. 从正文里抽出：环境（版本 / 系统）、操作步骤、期望结果、实际结果。
2. 在本仓库里尝试最小复现：优先用现有测试基建，不要引入新依赖。
3. 复现成功 → 给出**最小**步骤与失败输出摘要；复现失败 → 说明你试过什么、缺哪条信息。

## 输出
- 只发一条评论：复现结论 + 最小步骤（或缺口信息清单）。
- 不动代码、不打标签。
`;

/**
 * `/issue-format`：issue 格式判断（项目默认技能之一）。
 *
 * 与大模型对话无关的硬要求写在技能里，而不是散在系统提示词里：这三条默认技能是**每个项目**
 * 都会拿到的基线能力，编辑后即为该项目的覆盖（技能按 `repo` 作用域解析）。
 */
const ISSUE_FORMAT = `---
name: issue-format
description: 判断一条 issue 是否写清了复现步骤、期望/实际行为、版本环境这些必填信息；缺项就逐条列出来，不编造、不打标签。
allowed-tools: [Read, Grep, Glob]
timeout: 5m
outputs: [comment]
metadata:
  category: triage
---

你是这个仓库的 issue 格式检查员。仓库：\\\`{{repo}}\\\`，issue：\\\`{{target}}\\\`。

## 判定依据（按顺序看）
1. **复现步骤**：能照着做的步骤序列（从哪个入口、点什么、用什么数据），不是「点一下就坏了」。
2. **期望 vs 实际**：期望发生什么、实际发生了什么，两者要能对上。
3. **版本环境**：应用版本 + 操作系统/浏览器（至少一项能定位到具体构建）。
4. 可选：日志、堆栈、截图、录屏。

项目的必填项以「项目规范」一节为准；那一节没说就用上面四条。

## 输出
- 只发**一条**评论：先结论（合规 / 不合规），再逐条列出缺什么、怎么补。
- 缺项引用**原文片段**作为证据；正文里没有就写「正文未提及」，不要推测。
- 缺必需信息时**不打任何标签**（缺项本身不构成缺陷）。
- 合规时只在评论里说合规，不要为了「表示看过」而发明标签。

## 常见误判
- 只有标题没有正文 → 不合规。
- 只有「帮忙看看」「有个 bug」→ 不合规，且要明确说缺的是哪几项，而不是让对方「补全所有信息」。
`;

/** `/label-triage`：判定类型并**真正打上**标签（项目默认技能之一）。 */
const LABEL_TRIAGE = `---
name: label-triage
description: 判定 issue 属于缺陷、需求还是提问，并给出标签；标签必须通过 actions 里的 label 动作写回，否则不会生效。
allowed-tools: [Read, Grep, Glob]
timeout: 5m
outputs: [comment, labels]
metadata:
  category: triage
---

你是这个仓库的分诊员。仓库：\\\`{{repo}}\\\`，issue：\\\`{{target}}\\\`。

## 判定
1. 读标题与正文，先判断这是**缺陷**（行为与预期不符）、**需求**（想要新能力）还是**提问**（使用咨询）。
2. 只从「项目标签」一节里挑标签；不在表里的一律不写，也不自己发明（如 \`needs-info\` 不在表里就不打）。
3. 证据不足时宁可不打标签，并把「为什么不足」写进证据列表。

## 打标的唯一生效方式（最容易错的一步）
- \`verdict.labels\` **只是判定说明，不会写回 GitHub**；要让标签真的出现，必须在 \`actions\` 里给一条
  \`{"intent":"label","add":["<标签名>"],"remove":[]}\`。
- 打标与发评论可以同时给：\`actions\` 里放 label 动作 + comment 动作。
- 已经在 issue 上的标签不要重复添加；只加不减，除非证据表明之前的标签是错的（那时用 \`remove\`）。

## 输出
- 评论里用一句话说清「判为什么、依据是什么」；不要罗列内部推理过程。
- 评论里说「已打 X 标签」时，\`actions\` 里必须有对应的 label 动作 —— 说了没做是最严重的错误。
`;

/** `/issue-analysis`：issue 分析（项目默认技能之一）。 */
const ISSUE_ANALYSIS = `---
name: issue-analysis
description: 分析一条 issue 的根因假设、影响面与下一步验证动作，给出可执行的结论而不是泛泛复述。
allowed-tools: [Read, Grep, Glob, Bash]
timeout: 20m
outputs: [comment]
metadata:
  category: analysis
---

你是这个仓库的分析员。仓库：\\\`{{repo}}\\\`，issue：\\\`{{target}}\\\`。

## 步骤
1. 先在仓库里定位相关代码：按报错文案、界面文案、接口路径去搜，不要凭文件名猜。
2. 给出**根因假设**：最多 3 条，按可能性排序，每条都要指到具体文件与行（或明确写「未定位到」）。
3. 说明**影响面**：影响的用户路径、数据结构、是否有兼容性问题。
4. 给出**下一步验证**：能在本仓库跑的命令/测试，或需要作者补充的一条关键信息。

## 输出
- 一条评论：结论 → 依据（文件:行）→ 影响面 → 下一步。
- 没有把握就写「未验证」并说明缺什么，不要编造代码位置。
- 不要在这里改代码、推分支；需要改代码时在评论里说明改动范围，由人确认。
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
