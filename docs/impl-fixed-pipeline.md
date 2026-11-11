# 固定流水线 · 实施记录

> 上游计划：`docs/plan-fixed-pipeline.md`（v1.5，方案定稿）。本文记录**已落地的实现**，不是规划。
> 与计划冲突时以本文为准；尚未实现的部分集中在 §7（偏差）与 §6 末尾（面板缺口），不冒充已完成。
> 面向读者：后续维护者、运维、以及要在这条流水线上继续加东西的人。

---

## 1. 一句话结论

S0–S5 六片全部落地：三段串行流水线（`format` → `classify` → `agent`）已在所有已接入仓库上**全量生效**，老路径（`auto:triage`）已删除、无开关可回退；`pnpm -r typecheck` 6 包全绿、`pnpm lint` 0 error、`pnpm -r test` **1735 通过 / 0 失败**（明细见 §8）。

三个阶段的职责边界：阶段 0 判「信息够不够」（light，不建容器）；阶段 1 判「是需求还是缺陷」（sandboxed，起容器验代码证据）；阶段 2 才是真正干活的 agent，按 issue 复用会话。

---

## 2. 契约与数据

### 2.1 `repos.settings`（项目级可配项只剩 3 类）

```jsonc
{
  "pipeline": {
    "managers": ["login1"],            // 非空 = 保存硬条件（superRefine）
    "format_prompt_version": 0,        // 0 = 用内置默认
    "classify_prompt_version": 0,
    "agent_prompt_version": 0
  },
  "labels": {
    "vocabulary": [
      { "name": "需求", "role": "requirement", "meaning": "…" },
      { "name": "缺陷", "role": "defect",      "meaning": "…" },
      { "name": "咨询", "role": "other",       "meaning": "…" }
    ],
    "map": { }                         // 原样保留，不参与 role 判定
  }
}
```

要点（都与计划一致，列在这里是因为它们是最容易被改回去的地方）：

- **没有 `pipeline.enabled`**：不存在「关掉流程」的项目配置。`repos.enabled=false` 只表示「未接入机器人」，是部署准入。
- **没有任何流程阈值**：48h、5 次、冷却、限速都在代码常量里（§5），改阈值 = 发版。
- `labels.vocabulary[].role` **必填**，取值 `requirement | defect | other`；`role` 缺失的条目在迁移 0005 里被整条丢弃（Q4 不回填）。
- 阈值键（`close_after_hours` / `max_runs_per_stage`）、已删键（`triggers.faces`）、`pipeline.enabled` 一律被 `.strict()` 拒收：读路径与写路径共用同一套严格 schema，没有「老配置宽容」分支。
- `kind=project` 的版本指针仍沿用 `settings.prompt.current_version`，不在 `pipeline` 段里。
- `version` 仍是 `z.literal(1)`，新段用 `.prefault({})`。

### 2.2 枚举与常量取值

| 位置 | 取值 |
|---|---|
| `TASK_SOURCES` | `webhook` / `command` / `cron` / **`pipeline`**（新增；放行 comment 的唯一新来源） |
| `tasks.command`（流水线） | `pipeline:format` / `pipeline:classify` / `pipeline:notice` |
| `PIPELINE_STAGE` | `format` / `classify` / `agent` / `closed` |
| `PIPELINE_STATE` | `pending` / `running` / `awaiting_info` / `ready` / `blocked` / `closed` |
| `PIPELINE_CATEGORY` | `requirement` / `defect` / `other` / `not-found` |
| `PROMPT_KIND` | `project` / `format_check` / `classify` / `agent`（4 条独立版本线） |
| `triggers.faces` | **已删除**（服务端零消费，留着只会让人以为能关流程） |

### 2.3 信封：顶层可选 `stage`

```jsonc
{
  "stage": { "name": "format | classify", "result": "pass | fail | requirement | defect | not-found | other" },
  "verdict": { "kind": "issue", "labels": [], "evidence": [{ "rule": "code:…", "quote": "path/to.ts:123", "passed": true }] },
  "actions": [{ "intent": "comment", "body": "AI 自由撰写" }],
  "usage": { "inputTokens": 0, "outputTokens": 0, "costUsd": 0 }
}
```

- 阶段任务 `allowedIntents` 只含 `comment`——**没有** push / create_issue / label 能力。
- `verdict.labels` 在阶段任务里被忽略；标签由控制面按 `result` + `labels.vocabulary[].role` 打。
- 控制面校验不通过 → `blocked`，不写任何东西；`result=defect` 但 `evidence` 里没有 `rule` 以 `code:` 开头 + `quote` 命中 `path:line` → **强制降级 `not-found`**（正确性校验）。
- 老信封（没有 `stage`）仍然合法，Agent 阶段完全不受影响。

### 2.4 数据表

**新表 `issue_pipeline`**（PK `(repo, issue_number)`，24 列）：

```
repo, issue_number,
stage, state, category,
format_attempts, format_fail_count, classify_attempts, issue_version,
info_requested_at, last_recheck_at,
mention_sent_at, mention_category,
gate_notice_at,
session_id, session_cursor, session_turns, session_started_at,
stale_at, blocked_reason, ready_at, closed_at,
created_at, updated_at
```

索引 `issue_pipeline_close_scan_idx (state, info_requested_at)`：48h 关闭作业按它扫；`classify/awaiting_info` 的 `info_requested_at` 恒为 `NULL`，天然扫不到。

**增量列**：

| 表 | 列 | 说明 |
|---|---|---|
| `tasks` | `target_title` / `target_body` | issue 标题/正文**入队时快照**，`target_body` 截断到 8000 字符（进提示词时再截 4000）；不再依赖只留 90 天的 `webhook_deliveries` |
| `tasks` | `target_supplement` | **jsonb 数组**，最近 3 条补充评论、每条 ≤1000 字符；写侧永远整体替换（不 concat），默认 `'[]'` |
| `envelopes` | `stage_name` / `stage_result` | 阶段结论投影列；面板按阶段筛选/画时间线不解 jsonb。Agent 阶段的老信封这两列为 `NULL` |
| `prompt_versions` | `kind` | 默认 `'project'`（0003 时代存量行原地归位）；唯一键从 `(repo, version)` **换成 `(repo, kind, version)`**，旧键必须删——否则阶段 0 存一版会顶掉 P1 的同号版本 |

### 2.5 API 投影 `IssuePipeline`（camelCase）

`GET /api/issues` 的列表行与 `GET /api/issues/:owner/:name/:kind/:number` 的详情都带 `pipeline` 字段：

```ts
{
  stage: 'format' | 'classify' | 'agent' | 'closed';
  state: 'pending' | 'running' | 'awaiting_info' | 'ready' | 'blocked' | 'closed';
  category: 'requirement' | 'defect' | 'other' | 'not-found' | null;
  formatFailCount: number;
  infoRequestedAt: string | null;
  blockedReason: string | null;
  readyAt: string | null;
  staleAt: string | null;
  sessionId: string | null;
  sessionTurns: number;
}
```

**库里没有流水线行时整个字段为 `null`**（不用空对象冒充）：「没有行」与「行在但字段空」是两件事，前者对应「存量 issue 一律放行」的口径。`pipeline` 是 `.strict()` 的 schema，加字段要同步改三处：contract 的 schema、`queries/issues.ts` 的投影、panel 的 `api/queries/mocks`。

### 2.6 迁移 `migrations/0005_pipeline.sql`

三部分，全部 `IF NOT EXISTS` 幂等：

1. 建 `issue_pipeline` + 关闭扫描索引；
2. 增量列（§2.4）；
3. **Q4 数据重置**：一条 `UPDATE` 把存量 `repos.settings` 重算成新形状（可重复执行，结尾带 `WHERE settings IS DISTINCT FROM 目标值`）：
   - 删 `triggers.faces`（`triggers` 段不存在时不新造）；
   - `pipeline` 段只留 4 个已知键（`enabled` / `close_after_hours` / `max_runs_per_stage` 与任何未知键一起丢掉）；
   - `labels.vocabulary` 丢弃**缺 `role`** 的整条（保序），`labels.map` 等其余键原样保留，`labels` 段原本不存在就不新造；
   - `managers` 非空数组原样保留，缺省/空数组时种入仓库 owner（`split_part(repo_full_name,'/',1)`）；
   - 三个提示词版本指针铺底为 0（已有值不覆盖）。

**没有 down 迁移**：回滚脚本以注释形式写在迁移文件末尾，且数据不可完全回滚（老配置已被重置）。想彻底回到 0004 的库形状，还要手工删掉 `schema_migrations` 里 `0005_pipeline` 那行——历史迁移只读，不允许「改文件重跑」。

---

## 3. 状态机

### 3.1 转移表（精简版）

| 事件 / 条件 | 前置 | 后置 | 副作用 |
|---|---|---|---|
| `issues.opened`（非 bot） | 无行 | `format/pending` | 建行 + 入队 `pipeline:format`（light）+ 快照正文 |
| 格式 pass（**首次**） | `format/running` | `classify/pending` | **零评论** + `rocket`；入队 `pipeline:classify`（sandboxed） |
| 格式 pass（**重检**，`format_fail_count>0`） | `format/running` | `classify/pending` | **必须一条确认评论**；模型没写则用控制面兜底句 |
| 格式 fail | `format/running` | `format/awaiting_info` | 评论（AI 写）+ `needs-info` + `confused`；`info_requested_at=now` |
| `issue_comment.created`（补信息） | `format/awaiting_info` | `format/pending` | 立即重跑（锚含 comment id）；补充段置顶进 `{{body}}`；**不受 120s 冷却约束** |
| `issues.edited`（body/title 变） | `format/pending` / `format/awaiting_info` | `format/pending` | 重跑，冷却 120s；120s 内已有评论触发则跳过 |
| `issues.edited` | `agent/ready` | `agent/ready` | **忽略**（D7），只记 `stale_at` 供面板显示 |
| 分类 → `requirement` / `defect` | `classify/running` | `agent/ready` + `ready_at` | 按 role 打标 + 评论 + `@`（整个 issue 只 @ 一次） |
| 分类 → `other` | `classify/running` | `agent/ready` + `ready_at` | 只打标，不评论 |
| 分类 → `not-found` | `classify/running` | `classify/awaiting_info` | 评论（查不到 + 已查范围 + 需要什么）+ **`@managers`**；`info_requested_at=NULL`；不打缺陷标签 |
| `issue_comment.created`（managers） | `classify/awaiting_info` | `classify/pending` | 重跑分类；作者/他人评论只记录不重跑 |
| 信封不合法 / 运行失败**连续 2 次** | 运行态 | `blocked` | 面板红点 + 异常通知 |
| 格式**不通过累计 5 次** | 任意 format 态 | `closed` | `closeIssue` + `closed_at`；第 5 次 fail 的评论即最后反馈，不另发关闭评论 |
| `awaiting_info`（format）满 48h | `format/awaiting_info` | `closed` | `closeIssue` + `closed_at`（系统常量，非项目配置） |
| `issues.closed`（人工关） | 任意 | `closed` | 不再接事件 |
| `/pipeline next`（managers） | 任意非 `closed` | 下一阶段 | format→classify/pending；classify→agent/ready；`blocked` 等价解禁 |
| `/pipeline prev`（managers） | `classify/*` / `agent/ready` | 上一阶段 | → format/pending 或 → classify/pending |

### 3.2 两种 `awaiting_info` 的差别（最容易混的一处）

| | `format/awaiting_info` | `classify/awaiting_info` |
|---|---|---|
| 等谁 | 等 **issue 作者 / managers** 补充信息 | 等 **managers** 做人工分类判断 |
| `info_requested_at` | **非空** | **`NULL`** |
| 48h 关闭扫描 | **会被扫到**，到点自动关 | **不会被扫到**（不在扫描集合里） |
| 谁能推进 | 作者或 managers 的普通评论、`issues.edited`、`/pipeline next` | **只有 managers**：managers 评论触发重分类，或 `/pipeline next` |
| 其他人评论 | 正常触发重跑 | 只记录，不重跑 |

「无流水线行」= 未知 = 放行，并在首次处理时懒创建 `ready` 行，不因为缺行把存量 issue 全拦下。

### 3.3 门禁（未 `ready` 时收到 `@` 命令）

| 当前状态 | 行为 |
|---|---|
| `*/pending`、`*/running` | 只打 `eyes`，**零任务**，不回复（正在跑，回复是噪音） |
| `format/awaiting_info` / `classify/awaiting_info` / `blocked` | **不建命令任务**，改入队 `pipeline:notice`（light）；AI 写一条回执；每 issue 每小时 1 条（`gate_notice_at`） |
| `closed` | 静默 |
| 无行 / `ready` | 正常建命令任务 |
| `target_kind='pr'` | **不受影响**，走原命令门禁 |

被拦的命令**不进 `tasks`**；`pipeline:notice` 是独立轻量任务，只产评论，进投递审计与面板计数。

---

## 4. 四类提示词与装配层序

### 4.1 四类 `kind` 与生效范围

| kind | 生效阶段 | 版本 0 | 保存期上限 | 覆盖方式 |
|---|---|---|---|---|
| `project`（P1 用户设定提示词） | 阶段 2 | 不注入 | 4000 | 项目版本整体替换 |
| `format_check` | 阶段 0 | 内置模板 | 8000 | **项目版本整体覆盖内置默认**（不追加） |
| `classify` | 阶段 1 | 内置模板 | 8000 | 同上 |
| `agent` | 阶段 2 | 内置模板（= 原 `buildTaskPrompt` 系统段） | **4000** | 同上 |

- 四条版本线**各自独立**：版本号、保存、回滚互不干扰；`version=0` 一律回落内置默认；「恢复默认」= 指针回 0，不删历史。
- **输出契约永远由代码追加在最后、不可配**：项目就算把 `agent` 提示词改成「不要输出 JSON」，末尾的输出契约照样存在、信封照样校验。
- 阶段 0/1 注入 `AGENTS.md`（Q9：任意时刻生效），但**不注入 P1、不注入技能层**。

### 4.2 层序

```
head：阶段系统提示词（format_check / classify / agent，可整体覆盖）
  → P1 用户设定提示词（仅阶段 2，kind=project）
  → AGENTS.md（根 + 就近；仅阶段 2），阶段 0/1 只注 AGENTS.md 这一层
  → 技能层（仅阶段 2 的 agent/ready issue 任务）
  → tail：输出契约（代码固定，永不丢弃）
```

`head` / `tail` 在运行期超预算时**永不丢弃**；被牺牲的是 P1 → 就近 AGENTS → 技能层 → 根 AGENTS。

### 4.3 预算表（12k 目标预算）

| 层 | 上限（字符） | 进不进 P1 的可用额度计算 |
|---|---|---|
| `agent` 阶段系统提示词（`head`） | 4000 | **进**（`baseChars`） |
| P1 `project` | 4000 | 本身就是被扣减的对象 |
| `AGENTS.md` 根 / 就近 | 4000 / 6000 | 进（`agentsChars`） |
| 技能层 | 4000 | 进（`skillChars`） |
| 输出契约（`tail`） | — | 不进（永不丢） |
| issue 正文 `PROMPT_LIMITS.body` | 4000 | — （任务上下文，不是系统层） |

保存期预演：`available = min(4000, 12000 − (baseChars + agentsChars + skillChars))`。

**这就是 `agent` 上限只能是 4000 的原因**：它落在 `basePrompt` 里、计入 `baseChars`，设 8000 会让 P1 永远存不进去。面板的层序预览显示各层字符数、`available` 与预计丢弃项。

---

## 5. 常量表（`apps/server/src/config/pipeline-constants.ts`）

**改任何一个都要发版。** 面板只读展示，不提供编辑入口。

| 常量 | 值 | 含义 |
|---|---|---|
| `PIPELINE_CLOSE_AFTER_HOURS` | 48 | `format/awaiting_info` 满多少小时自动关 issue |
| `PIPELINE_FORMAT_MAX_FAILS` | 5 | 格式**不通过**累计次数上限，`>=` 即关 issue（通过不计数、重跑不限次） |
| `recheckCooldownSeconds` | 120 | 同一阶段两次重跑最小间隔；**只挡 `issues.edited`**，评论补充优先 |
| `gateNoticeIntervalSeconds` | 3600 | `pipeline:notice` 门禁回执：每 issue 每小时 1 条 |
| `sessionMaxTurns` | 30 | 阶段 2 会话轮数上限，达到即 archive + 新建 |
| `sessionMaxAgeDays` | 7 | 阶段 2 会话存活天数，超期即轮换 |
| `supplementMaxItems` | 3 | `target_supplement` 保留最近几条补充评论 |
| `supplementItemMaxChars` | 1000 | 每条补充评论截断长度 |
| `targetBodyMaxChars` | 8000 | `target_body` 入队时截断长度（进提示词再截 4000） |
| `PROMPT_LIMITS.body` | 4000 | 正文进提示词的上限，截断处显式标注 |
| `classifyMaxMinutes` | 30 | 分类阶段（sandboxed）执行闸，超时按 `timed-out` |
| `commandExpireSeconds` | format 600 / classify 1800 / notice 300 | 队列过期时间 |

`PIPELINE_LIMITS` 是同一个值的聚合对象，`createPipelineLimits(overrides)` 是**纯函数**（不读 env、不连库），单测用它注入 `0.01` 小时 / `2` 次。生产代码直接用 `PIPELINE_LIMITS`。

---

## 6. 面板变化

| 位置 | 变化 |
|---|---|
| 新路由 `/repos/:repo/pipeline` | **阶段看板**：四列（format / classify / agent + 关闭）× 未入流水线分组；门禁表（§3.3 七行口径）；系统常量只读表；四个提示词指针；阶段 2 会话健康。数据**只用既有读接口**（`GET /api/issues` 的 `pipeline` 字段 + `GET /api/repos/:owner/:name/settings`）客户端聚合，本切片不新增后端 |
| issue 列表（`/repos/:repo/issues`） | 新增 阶段 / 类别 / 停留 / 尝试 四列；三个筛选（阶段、类别、状态） |
| issue 详情 | 三段阶段时间线 + 分类证据（`code:` 引用与 `checked:` 已查范围） |
| 设置页 | 新增「流水线」分区（`#pipeline` 深链接）：managers chips、超时/次数**只读**展示系统常量、提示词指针、标签覆盖提示；**提示词四个 kind tab**（hash `#prompt/<kind>`，刷新不丢、可贴给别人）；标签词表加 `role` 下拉 |

**已知缺口（如实记录，不要当成已完成）**：

1. 面板「今日自动关闭」与会话「已归档」显示 `—`：缺 `closed_at` 与会话归档状态的 API 投影（`title` 里写清了缺哪个接口）。
2. issue 列表的标签/搜索/时间窗筛选、以及阶段筛选都是**客户端过滤**（服务端仍只支持 `repo` / `kind` / `limit` / `cursor`）。
3. 重跑 / 暂停 / 归档 / 导出仍**没有写接口**——面板全部只读。
4. `/api/overview` 没有仓库维度队列（按仓库的队列深度只能在流水线页由客户端聚合）。
5. 流水线页最多取 `limit=100` 的 issue 客户端聚合；超过 100 条的老仓库，看板计数不是全量。

---

## 7. 与规划的偏差

每条都写清「规划怎么写 / 实现怎么改 / 为什么」。§7.1 原本是一处偏差，现已撤销（改回与规划一致，保留编号不动）。

### 7.1 标签角色覆盖：偏差已撤销，已按 §4.5 落实

- **规划**（`docs/plan-fixed-pipeline.md` §4.5、V17）：`superRefine` **无条件生效**——`managers` 非空；`vocabulary` 里 `requirement` 与 `defect` **各至少 1 个**（`other` 可缺省）；`role` 必填。
- **实现（现状）**：与规划一致。`repoSettingsSchema.superRefine`（`packages/contract/src/repo-config.ts`）在缺 `requirement` 或 `defect` 时向 `['labels','vocabulary']` 报 issue：`分类需要至少一个需求标签与一个缺陷标签：labels.vocabulary 里缺 role='…' 的词表项（role='other' 可缺省）`，保存即 400、`settings_valid=false`。
- **`pipelineLabelCoverage()` 仍在**，但只作**防御性**展示：schema 已强制覆盖，正常路径拿不到 `missingRoles` 非空；存量数据 / 迁移后尚未在面板配置的仓库拿到的是形状默认值（空词表），面板靠它把「缺哪类角色」直接摆给用户。
- **预期副作用**：0005 迁移把存量 `settings` 重置为形状默认后，未重新配置的仓库 `settings_valid=false` 属预期（§10.2 / V17），webhook 忽略其事件，重新在面板补 `managers` + 两条标签后恢复。

### 7.2 `session_turns` 轮换后从 1 起

- **规划**：轮换后新会话从 0 计数（§7 只写「轮数达到上限 → archive + 新建」）。
- **实现**：轮换那一轮**已经跑在新会话上**，所以新会话的 `session_turns` 从 **1** 开始，不是 0。
- **为什么**：0 会让「已用轮数」少算一轮，`sessionMaxTurns=30` 实际能跑到 31 轮，与面板显示的会话健康对不上。

### 7.3 `blocked_reason='session-reset'` 是粘性的

- **规划**：「attach 失败 → 新建 + warn + `blocked_reason=session-reset`（不阻塞）」（§7），没写后续是否清除。
- **实现**：后续成功轮次**不清除**这个 `blocked_reason`（不阻塞流程，`state` 照常）。
- **为什么**：它是面板用来解释「这个 issue 的上下文断过一次」的唯一线索；清掉之后，「为什么这轮回答忘了前面说过的话」就无从追溯了。

### 7.4 分类阶段「信封不合法 → blocked」也按连续 2 次

- **规划**：§2 转移表写「运行失败 / 信封不合法连续 2 次 → blocked」，但 §6 只描述单次失败。
- **实现**：阶段 0 与阶段 1 **统一**用「连续 2 次」口径；单次坏输出只记 `parse` 失败并沿用到当前状态。
- **为什么**：一次模型抖动就把 issue 卡进 `blocked` 会逼人工介入；连续两次才说明是提示词或配置真有问题。两个阶段口径不一致会让人误判「分类为什么卡住了」。

### 7.5 频率上限的计数来源是 `actions` 表

- **规划**：「频率复用 `limits.max_comments_per_hour`」（§13 风险表），暗示有配额台账。
- **实现**：**没有专用台账**。计数来源是 `actions` 表近 1 小时的 `intent='comment'` 行数；`gate_notice_at` 只给门禁回执做「每 issue 每小时 1 条」的单列限速。
- **为什么**：少一张表和一套清理任务；`actions` 本来就是写操作的事实源、永久保留、有 `(repo, applied_at)` 索引，窗口查询够快。

### 7.6 「已查范围」补段对所有发评论的结论生效

- **规划**：§6 只要求 `not-found` 写「已查范围」，并要求落 `verdict.evidence` 的 `rule=checked:…`（§6 末段）。
- **实现**：补段对**所有会发评论的结论**生效——`requirement` / `defect` / `not-found` 都要写「查了哪些文件/命令」，都落 `checked:` 证据；`other` 不评论所以不需要。
- **为什么**：需求分析与缺陷报告同样要能复核「依据是什么」；只给 `not-found` 写，会让另外两类评论变成不可验证的断言。

### 7.7 阶段 2 四层提示词只对 `agent/ready` 的 issue 任务生效

- **规划**：§7 的层序表按「阶段 2」整体描述，未区分任务类型。
- **实现**：四层（`agent` + P1 + AGENTS.md + 技能层）只对 **`pipeline` 来源的 issue 任务**生效；`/review-pr`、`/issue-triage` 等命令类任务的 head 与老路径**逐字节不变**。
- **为什么**：命令类任务有自己的技能与实际需求，把 issue 流水线的阶段系统提示词套上去会改变既有命令的行为；而这次改造的验收前提是「命令通道不受影响」。

### 7.8 `registerPromptRoutes` 只注册一次

- **规划**：§10.4 只写「三个路由加 `?kind=`」，没写注册位置。
- **实现**：`registerPromptRoutes` **只在 `apps/server/src/http/api/index.ts` 注册一次**；不要在 `app/compose.ts` 里再注册一遍。
- **为什么**：Fastify 5 重复注册同一个路由会在**启动时直接抛错**（`FST_ERR_DUPLICATED_ROUTE`），表现为「服务起不来」，而且错误信息不会指向 compose。改这一带代码时先 grep 注册点。

---

## 8. 验证基线

| 项 | 结果 |
|---|---|
| `pnpm -r typecheck` | 6 包全绿 |
| `pnpm lint` | 0 error（6 条既有 warning，全在 `scripts/spike/*.mjs`） |
| 测试 | contract 81 / envelope 33 / shared 30 / racp-client 87 / panel 223 / server 1281（105 文件，2 skipped）= **1735 通过，0 失败** |
| `pnpm gen:openapi` | 9 paths / 54 schemas |
| `pnpm --filter @pi-issue-bot/panel build` | 通过 |
| dev 库 `pi_issue_bot` | 已迁到 `0005_pipeline` |
| 真实仓库 `Tioit-Wang/pi-issue-bot-test` | `settings` 全量严格校验通过：`managers: ["Tioit-Wang"]`，4 条带 `role` 的词表，`pipelineLabelCoverage().missingRoles: []` |

---

## 9. 运维须知

### 9.1 迁移

```powershell
pnpm cli migrate          # 幂等；重复执行不会刷新 settings_updated_at
```

- 0005 会在**所有**仓库上重算 `settings`（删 `triggers.faces`、丢掉无 `role` 的词表条目、`managers` 空则种仓库 owner）。**迁移前先备份 `repos.settings`**。
- 迁移后可预期的中间态：词表被丢空的仓库 `settings_valid=false`，直到有人在面板重配 `managers` 与 `role`。这不是 bug。
- 没有 down 迁移；回滚步骤在 `migrations/0005_pipeline.sql` 末尾的注释块里，且**数据不可完全回滚**。

### 9.2 配置合法性（保存 400 的三个常见原因）

1. `pipeline.managers` 为空数组或缺失；
2. 词表条目缺 `role`（或 `role` 不是 `requirement|defect|other`）；
3. 带了已删/未知键（`pipeline.enabled`、`close_after_hours`、`max_runs_per_stage`、`triggers.faces`）——`.strict()` 直接拒收。

提示词保存的额外校验：未识别占位符 → 400 并列出名字；`format_check` 缺 `{{title}}` / `{{body}}` → 400；`format_check` / `classify` 超 8000、`agent` 超 4000 → 400（`kind=project` 不做插值、不校验未知占位符）。

### 9.3 限速与成本

- 门禁回执：每 issue 每小时 1 条（`gate_notice_at`）；`*/pending`、`*/running` 只打 `eyes`，不调用模型。
- 评论频率：按 `actions` 表近 1 小时 comment 计数（§7.5），没有独立台账。
- 每条回执/确认评论都是一次 light 调用；`pipeline:notice` 队列 300s 过期。
- 阶段 1 起容器 + 装依赖：首响应 3–8 分钟属正常，超过 30 分钟按 `timed-out` 处理。

### 9.4 dry-run

- dry-run 仓库照常推进 `issue_pipeline` 的内部状态、照常跑三个阶段、照常落 `runs` / `envelopes` / `run_events`，但**不写 GitHub**（无评论、无标签、无 reaction）。
- 因此 dry-run 下用户看到的是「issue 静静地变了状态」——面板要标注「dry-run：仅推进内部状态」；查证结论请读 `envelopes.actions` 与面板时间线，`actions` 表是空的。
- 验收方式：全量回放一轮历史 issue，比对 `issue_pipeline` 的落点与人工判断，确认无误后再关 dry-run。

### 9.5 出问题时的处置顺序

1. `blocked`：面板看 `blockedReason`；`/recheck --force` 解禁重跑当前阶段；`/pipeline next` / `/pipeline prev` 由 managers 强行推进/回退。
2. 会话断裂（`blockedReason='session-reset'`）：不用处理，下一轮已自动新建会话。
3. 关闭类问题：48h / 5 次两个阈值都在代码里，临时调只能发版；面板上的数字是**只读事实**，不是可编辑配置。
4. 判断「是不是流水线的问题」：先看 `tasks.source`——`pipeline` 来源才走三段；`command` 来源的 head 不变（§7.7），PR 完全不受影响。
