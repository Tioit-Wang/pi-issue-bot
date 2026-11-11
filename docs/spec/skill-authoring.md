# 技能写作规范（Agent Tools / Skill 构建 / 行业规则）

适用对象：内置技能（`apps/server/src/skills/builtin.ts`）与项目里自己写的技能（面板 → 项目技能 → 编辑）。
本规范由 `apps/server/test/skills-authoring.test.ts` 的断言兜底；改技能前先看那份测试。

## 1. 三层分工：事实 / 方法 / 动作

一次 agent 运行里，信息分三层，**各层只由一处负责**：

| 层 | 内容 | 谁提供 | 写在哪里 |
|---|---|---|---|
| 事实 | 仓库 `owner/name`、目标 `issue#12`、当前标签、项目标签词表（含说明与互斥组）、base/head 提交 | `skills/prompt.ts` 用运行时真值渲染 | 提示词的 `## 任务上下文` / `## 项目标签` |
| 方法 | 这件事怎么做：先调哪个工具、传什么参数、结果怎么判、判不出来怎么办 | 技能正文 | `SKILL.md` |
| 动作 | 结论怎么落到 GitHub（评论、打标、提 PR） | 信封 `actions` | 提示词的 `## 输出契约` |

因此：**技能正文里不许出现 `{{...}}` 占位符**。占位符既不是事实（它要人填），也不是工具（它不能被调用）；
它唯一的效果是让模型把「该去读 `## 项目标签`」读成「这里有东西会替你好」。需要事实时，引用段名：

```md
标签名只看 `## 项目标签` 段；当前标签看 `## 任务上下文` 的「当前标签」一行。
```

## 2. 技能要写清楚「工具怎么用」

宿主的工具面是 `Read / Write / Edit / Glob / Grep / Bash`（契约 `SKILL_ALLOWED_TOOLS`），
技能的 `allowed-tools` 只能从这里取子集，**矩阵外一律 deny**。所以：

- 技能必须有 `## 工具用法（本技能允许的工具）` 一节，每个工具写：**调用形式 + 用它做什么 + 什么时候才用**。
  例：`` `Grep(pattern="<报错文案>", path="src")` —— 从 issue 里的原文反查代码位置，第一步就做这个，别按文件名猜。``
- 正文点名调用的工具必须在 `allowed-tools` 里（测试会查）；反过来，声明了却一个都没提也不合格。
- 提示词还会渲染一份 `## 可用工具`（按 `allowed-tools` 过滤的目录 + 通用约定）。技能不要复制这份清单，
  只写**本场景特有的用法**。
- 「获取项目可用标签」这类需求**不需要**新增工具：标签真相在服务端（`repos.settings.labels.vocabulary`），
  已渲染进 `## 项目标签`。技能要写明「这一段就是权威来源，不要用 Bash / 网络去猜」。
- 要让 agent 去仓库里取证（issue 模板、贡献指南、术语表、现有测试），必须给出**具体路径或搜索参数**，
  不要写「参考仓库里的相关文档」这种无法执行的句子。

## 3. 行业通用规则（Agent Skills 标准 + 通用实践）

参考 `https://agentskills.io/specification`，本仓的落地口径：

1. **`description` 写「何时用」**：触发条件 + 适用对象，不写步骤。它会被拿去检索（面板、目录、未来路由）。
   本仓要求包含「适用于」。
2. **一个技能只做一件事**：`/issue-format` 判信息完整性，`/label-triage` 分类打标，
   `/issue-analysis` 找根因。相近能力靠「何时用」互相指路（「要复现步骤用 `/issue-repro`」）。
3. **渐进披露**：`SKILL.md` 只放「做这件事的最小必要知识」；长词典、长清单放 `references/`，
   正文里写清什么时候去读哪个文件。
4. **可执行的步骤**：编号步骤，每步一个动作动词；避免「综合考虑」「酌情处理」。
5. **边界与失败必须显式**：输入缺失、工具失败、无权限、搜不到，各自怎么办都要写，
   而不是让模型临场发明（「没配置标签词表 → 不打标，只说明原因」）。
6. **不许编造**：正文没有的信息写「正文未提及」；结论必须能指到 `文件:行`、命令输出或某个提示词段。
7. **动作要闭环**：「说了就要做」。打标的唯一生效方式是 `actions` 里的
   `{"intent":"label","add":[...],"remove":[]}`；`verdict.labels` 不写回（见 issue #25 的教训）。

## 4. 反面样例（曾经的真实写法）

```md
你是这个仓库的 issue 格式检查员。仓库：`{{repo}}`，issue：`{{target}}`。

## 判定依据（按顺序看）
1. 复现步骤 …
```
问题：① `{{repo}}` / `{{target}}` 是占位符，模型看到的是「等一个值」而不是「去读某段」；② 没说这些信息在
`## 任务上下文` 里；③ 没写「仓库有模板时以模板为准」，于是模型会去翻仓库里已退役的 `.github/pi-bot.yml`。

## 5. 改完怎么验

```powershell
cd apps/server
npx vitest run test/skills-authoring.test.ts test/skills-prompt.test.ts test/skills-registry.test.ts
```

`skills-authoring` 断言：无占位符、有工具用法与边界两节、正文工具 ⊆ `allowed-tools`、`description` 含「适用于」、
`/label-triage` 写明 actions 打标、`/issue-triage` 静默（`outputs: [labels]`）。
`skills-registry` 会比对 `examples/.github/pi-bot/skills/*.md` 与内置技能的 name / allowed-tools / outputs ——
改内置技能时记得同步这三份模板（它们由内置正文生成）。
