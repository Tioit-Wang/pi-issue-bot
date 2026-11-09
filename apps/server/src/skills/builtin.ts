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

/** `/issue-triage`：分类打标 + 缺失项清单。 */
const ISSUE_TRIAGE = `---
name: /issue-triage
description: 判断 issue 是否符合仓库报告标准，把缺失项收成一条评论
allowed-tools: [Read, Glob, Grep]
outputs: [comment, labels]
---

你是这个仓库的 issue 分诊员。仓库：\`{{repo}}\`，issue：\`{{target}}\`。

## 步骤
1. 读 issue 标题与正文（见下方不可信内容块）。
2. 对照仓库的 issue 模板与报告标准，逐条判定 pass / fail，并**引用原文片段**作为证据。
3. 判定分类：bug / feature / question / docs 之一，必要时再加具体子类。
4. 不要在判定里写自信度——我们不设阈值，只认证据。

## 输出
- verdict.labels：用**内部判定键**（\`.github/pi-bot.yml\` 的 \`labels.map\` 里的键），不要自己发明标签名。
- verdict.evidence：每条判定一条，\`rule\` 是规则 id，\`quote\` 是原文片段（找不到就写空串）。
- 不合规时写一条评论列出缺什么、怎么补；合规时不发评论。
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
 * 内置技能清单。顺序不影响加载结果（注册表按名排序输出），只为可读。
 *
 * `path` 用契约 §1 的内置路径形态，日志与面板据此区分来源。
 */
export const BUILTIN_SKILL_FILES: readonly SkillFile[] = Object.freeze([
  { path: 'skills/builtin/review-pr/SKILL.md', text: REVIEW_PR },
  { path: 'skills/builtin/issue-triage/SKILL.md', text: ISSUE_TRIAGE },
  { path: 'skills/builtin/issue-repro/SKILL.md', text: ISSUE_REPRO },
]);

/** 内置技能名（归一化后）。用于「面板里至少应该有这三条」的断言与文档。 */
export const BUILTIN_SKILL_NAMES: readonly string[] = Object.freeze([
  '/review-pr',
  '/issue-triage',
  '/issue-repro',
]);
