# 契约 · 技能（命令）· v1.0

> 上游：`docs/plan.md` v0.4 §6.4（「命令即技能，markdown frontmatter，仓库可自带技能」）。
> 下游：`docs/tech-plan.md` v1.1 §8.2 的 `skills/` 模块、M2 的命令面。
> 状态：已定稿。本文只定义「一个技能文件长什么样、怎么被校验、冲突怎么算」，不定义具体技能的内容。

---

## 0. 为什么需要这份契约

plan §6.4 只说「命令即技能（markdown frontmatter）」，没给 schema。而 M2 一批要落三个命令（`/review-pr`、`/issue-triage`、`/issue-repro`），没有契约就会各写一套 frontmatter、各解析一套默认值，第三个命令出现时必然互不兼容。

这份契约要钉死三件事：

1. 一个技能文件的**字段集合与约束**（多一个未知字段就拒绝，不是忽略）；
2. **谁覆盖谁**（仓库自带 vs 内置）以及冲突时的确定性结果；
3. 校验发生在**加载期还是运行期**，以及对应的 zod schema 落在哪个包。

一个前置判断：技能是**配置**，不是代码。所以它走仓库配置的加载链路（`.github/pi-bot.yml` 同一批），加载失败的行为与非法配置一致——**禁用该仓库的机器人并通知 owner**（plan §10 最后一条）。

---

## 1. 文件位置

| 来源 | 路径 | 谁写 | 优先级 |
|---|---|---|---|
| 内置 | `skills/builtin/<name>/SKILL.md` | 我们，随二进制发布，只读 | 低 |
| 仓库 | `.github/pi-bot/skills/<name>.md` | 仓库维护者，跟随默认分支 | **高** |

- 仓库技能从**默认分支**读取，与 `repos.config` 快照同批加载；分支上的技能不影响已入队任务（任务用的是入队时的快照，见 `tasks` 表）。
- 路径不在 `.github/workflows/**` 之下，因此不与写回闸门（tech-plan §5.6）的拒收清单冲突；但技能文件的改动仍然只能由**人**的提交带进来——bot 自己不许写技能文件（`push_branch` 的 `paths` 里出现技能路径一律 `writeback_rejected`）。
- 文件名与 `name` 无关（文件名只用于日志定位），`name` 以 frontmatter 为准。

---

## 2. frontmatter 字段表

YAML frontmatter，位于文件首个 `---` 与第二个 `---` 之间。**未知顶层键一律拒绝**（`zod .strict()`）：拼错的键静默忽略，等价于配置写错了却看不出来。

| 字段 | 类型 | 必填 | 约束 | 语义 |
|---|---|---|---|---|
| `name` | string | 是 | 正则 `^/[a-z][a-z0-9-]{1,30}$`（ASCII 小写，总长 ≤32） | 必须以 `/` 开头。与评论里 `@bot /name` 的 token 一一对应；匹配时大小写不敏感，但存储与展示归一化为小写。不得使用保留名 `/retry`、`/help`、`/skills` |
| `description` | string | 是 | 10–200 字符，**单行**（不允许 `\|`/`>` 块） | 出现在「未知命令」的回复与面板命令列表里。单行是刻意的：它会被拼进面向人的评论，多行会让回复格式不可控 |
| `allowed-tools` | string[] | 是 | 非空，元素 ∈ `Read` `Write` `Edit` `Glob` `Grep` `Bash`（大小写敏感） | 声明本技能**允许**调用的工具。它是上限不是授权：实际决策仍走 tech-plan §4.6 的审批矩阵，声明之外的工具被 deny 并记审计。`WebFetch`/MCP 等一律不在枚举内（§4.6 已 deny） |
| `timeout` | string | 否（默认 `20m`） | `^(0\|[1-9][0-9]*)(s\|m)$`，且 `≤ 30m` | 单任务上限，喂给 tech-plan §4.7 的「单任务」时间闸。超过服务端上限时**截断到上限并记 warn**（技能本身合法，不因此拒绝） |
| `model` | string | 否 | `^[a-z0-9-]+\/[a-z0-9._-]+$`（`provider/model`） | 空则用仓库配置的默认模型。只影响本次任务的成本归集（`usage_costs`），不影响 `tasks.idempotency_key` |
| `inputs` | object[] | 否 | ≤8 项；每项 `{ name, required, pattern?, description? }` | 命令参数的形状声明，见 §2.1 |
| `outputs` | string[] | 是 | 非空，元素 ∈ `comment` `labels` `issue` `pr` | 本技能**允许产出**的动作类型。信封里出现未声明的 intent → 该动作丢弃并记 `parse` 失败（不是整封信封失败）。`pr` 隐含 `push_branch` + `open_pr`，且此时动作必须带 `paths`（tech-plan §5.6） |
| `requires-repo-config` | boolean | 否（默认 `false`） | 只接受字面量 `true` / `false` | 为 `true` 时，仓库的 `.github/pi-bot.yml` 里必须存在该技能所需的配置段；缺失则本命令不可用，回一条说明（不静默降级） |

### 2.1 `inputs` 项

| 键 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `name` | string | 是 | `^[a-z][a-z0-9_]{0,23}$` |
| `required` | boolean | 是 | `true` / `false` |
| `pattern` | string | 否 | RE2 兼容正则，≤128 字符；用于运行期校验参数值 |
| `description` | string | 否 | ≤80 字符，单行 |

参数传递形式：`@bot /review-pr focus=repro depth=2`。解析规则刻意很窄——`key=value`，值必须是单个 token（不接受空格、引号、空值），最多 8 个；未知 key 或超出 `inputs` 声明即拒绝并回一条用法说明（不消耗容器、不入队）。

`outputs` 与 plan §5 动作的映射：

| `outputs` | 允许的信封 intent |
|---|---|
| `comment` | `comment` |
| `labels` | `label` |
| `issue` | `create_issue` |
| `pr` | `push_branch`（必须带 `paths`）、`open_pr` |

技能**不能**新增动作类型。新增动作类型意味着绕过写执行器，属于改代码的范畴，不是改配置。

---

## 3. 覆盖与冲突

**优先级：仓库自带技能 > 内置技能。同名时整体替换，不合并。**

不做字段级合并的理由很实在：合并出的最终形态既不是内置的、也不是仓库写的，排查「为什么这个技能行为怪」时没人能一眼看出源文件。整体替换至少让「谁生效」是唯一确定的。

冲突与异常的确定性处理：

| 情形 | 结果 |
|---|---|
| 仓库技能与内置同名 | 用仓库的；面板与 `/api/system` 标 `source=repo` |
| 仓库内两个技能归一化后同名（如 `/Review-Pr` 与 `/review-pr`） | **两者都不加载**，记 `skill_conflict`，该命令不可用，通知 owner |
| 仓库技能 frontmatter 非法 | **不回落内置**，该命令不可用并说明原因。回落会让「改坏了」看起来像「改好了」 |
| 仓库技能 `timeout` 超过上限 | 截断到 `30m` 并记 warn（技能可用） |
| 仓库技能 `allowed-tools` 含枚举外工具 | 整份技能非法（拒绝），不截断——授权类字段静默收窄会让人误以为在放宽 |
| `requires-repo-config: true` 但配置缺失 | 命令不可用，回一条「该命令需要仓库配置 `x`，见 `.github/pi-bot.yml`」 |
| 仓库技能用了保留名 | 非法（拒绝），避免仓库用 `/retry` 覆盖人工重跑入口 |
| 一次性加载失败 | 与 `.github/pi-bot.yml` 非法同批处理：禁用该仓库机器人 + 通知 owner（plan §10），不是「跳过这个文件继续跑」两种待遇 |

被禁用的技能仍在面板可见（带禁用原因），否则 owner 会以为文件没被读到。

---

## 4. 校验时机与落位约定

### 4.1 zod schema 落位

`packages/contract/src/skills.ts`，导出：

| 导出名 | 内容 |
|---|---|
| `skillFrontmatterSchema` | frontmatter 的 zod schema（`.strict()`） |
| `SkillFrontmatter` | `z.infer` 类型，供 `skills/` 模块与面板类型使用 |
| `skillInputsSchema` | `inputs` 数组项的 schema（单独导出，便于复用与单测） |
| `SKILL_NAME_RE` | `^/[a-z][a-z0-9-]{1,30}$` |
| `SKILL_ALLOWED_TOOLS` | 工具枚举常量（与 tech-plan §4.6 的矩阵同源） |
| `SKILL_OUTPUTS` | 输出枚举常量（与 §2 的映射表同源） |
| `SKILL_RESERVED_NAMES` | 保留名列表 |

JSON Schema 由 zod 生成，不手写第二份——「手工维护的第二份契约是缺陷」这条原则对技能契约同样成立。**不引入新依赖**：zod 已在技术选型内（tech-plan §2.1）。

### 4.2 三个校验时机，各自负责一件事

| 时机 | 校验什么 | 失败后果 |
|---|---|---|
| **加载期**（与 `.github/pi-bot.yml` 同一批，每次仓库配置刷新） | frontmatter 全量：字段、枚举、正则、长度、保留名、同名冲突、`requires-repo-config` 的配置存在性 | 该技能不可用；配置级失败则禁用该仓库机器人并通知 owner |
| **解析期**（收到 `@bot /cmd …`，入队前） | 命令名是否已加载、参数是否符合 `inputs`、`pattern` 是否通过 | 回一条用法说明，**不入队**（不占并发、不计成本） |
| **运行期**（信封产出后，写执行器之前） | 信封动作是否都在 `outputs` 允许集内、`pr` 类是否带 `paths` | 越界的动作丢弃并记 `parse`；其余动作照常执行 |

**frontmatter 只在加载期校验，运行期不重复校验**：跑到一半才发现 frontmatter 非法属于设计错误，而不是「运行期该防的异常」——那时候容器已经跑起来了，唯一的处置也只能是丢掉整次结果。参数校验放解析期同理：`pattern` 不通过就不该消耗一次容器执行。

### 4.3 与 idempotency 的关系

`tasks.command` 直接存 frontmatter 的 `name`（如 `/review-pr`），`tasks.idempotency_key` 的 `kind` 取 `command:/review-pr`（tech-plan §7.2）。**同一 `head_sha` 重跑是空操作**（plan §6.4）由 `anchor = head_sha` 保证，与 `timeout`、`model` 无关——改技能里的模型不该让「重跑」变成「新任务」。

---

## 5. 示例

### 5.1 最小合法技能

```markdown
---
name: /issue-triage
description: 判断 issue 是否符合仓库报告标准，缺失项收成一条评论
allowed-tools: [Read, Glob, Grep]
outputs: [comment, labels]
---
列出 issue 模板的必填项，逐条判定 pass/fail 并附原文引用；
不合规时把缺失项写成一条评论，并打 needs-info。
```

其余字段全部取默认值，加载后的有效配置：

| 字段 | 生效值 |
|---|---|
| `timeout` | `20m` |
| `model` | 仓库配置的默认模型 |
| `inputs` | 空（该命令不接受参数） |
| `requires-repo-config` | `false` |

### 5.2 非法示例 A：键写错 + 名字不合规

```markdown
---
name: Review-PR
description: 审查 PR
allowed-tool: [Read, Bash]
outputs: [comment]
---
```

**为什么非法（三处，任何一处单独都足以拒绝）**：

1. `name` 不以 `/` 开头，且含大写 `Review-PR` —— 违反 `^/[a-z][a-z0-9-]{1,30}$`。
2. `allowed-tool` 是未知键（本意 `allowed-tools`）。`.strict()` 下直接报 `unrecognized_keys`；若改成「忽略未知键」，这个技能会以「没有任何允许工具」的状态加载，然后每条命令都被审批策略 deny——错误藏得比报错更深。
3. `allowed-tools`（即使拼对）缺 `Bash` 也无法通过写回阶段的命令执行，但这不是拒绝理由；拒绝理由是 1 与 2。

处置：该技能不加载，记 `skill_invalid`（含上面两条原因），`/Review-PR` 在回复里显示为「配置无效，已通知 owner」。

### 5.3 非法示例 B：五处越界

```markdown
---
name: /review-pr
description: |
  审查这个 PR，跑测试并给出结论。
  会推 bot 分支。
allowed-tools: [Read, Bash, WebFetch]
timeout: 45
outputs: [comment, push_branch]
requires-repo-config: yes
---
```

**为什么非法**：

1. `description` 用了块标量（多行）——字段约束是单行，它会被拼进面向人的评论，换行会破坏回复格式。
2. `allowed-tools` 含 `WebFetch`——不在 `SKILL_ALLOWED_TOOLS` 枚举内（tech-plan §4.6 对这些工具一律 deny）。授权类字段不做截断，直接拒绝。
3. `timeout: 45` —— 缺单位（只接受 `s`/`m` 后缀），且 45 分钟超过 `30m` 上限。注意这里与「合法技能但超时」的处置不同：那种是截断 + warn，这种是**格式非法**，没有可截断的值。
4. `outputs` 含 `push_branch`——枚举只允许 `comment`/`labels`/`issue`/`pr`；推分支必须声明 `pr`，并由动作自带 `paths`（tech-plan §5.6）。
5. `requires-repo-config: yes`——只接受字面量 `true`/`false`。YAML 1.1 会把 `yes` 解析成 `true`、YAML 1.2 解析成字符串，同一份文件在不同解析器下语义不同；按 strict boolean 校验就是为了不踩这个坑。

正确写法（对照）：`description` 合成一行、`allowed-tools: [Read, Bash]`、`timeout: 30m`、`outputs: [comment, pr]`、`requires-repo-config: true`。

---

## 6. 这份契约没有定义的东西

- **技能正文写了什么**：正文是 prompt 的一部分，随技能演进；契约只管 frontmatter 与它能产出的动作范围。
- **技能之间的调用**：MVP 不支持一个技能调用另一个技能（会造出无界的执行树与成本不可归集）。
- **技能的市场/分发**：仓库级覆盖已覆盖「每个仓库口径不同」的需求，MVP 不做跨仓库共享。
- **模型参数（温度、最大 token）**：由 host 侧与仓库配置决定，技能只能选 `model`。
