# 多仓库方案（同一 bot 安装到多个仓库）· 讨论汇总 v1.1

> 状态：**讨论稿，未实现**。v1.1 按 2026-11-10 的四点拍板改写：
> ①「项目」就是仓库的别名，不引入独立 project 实体；②不再有仓库内 yaml，配置全部落库 + 部署默认；③合规缺项不发评论；④`dry_run` 保留、新接入默认开。
> 三条 GitHub 事实已在本机实测（§11 记录，临时探测仓库 `Tioit-Wang/pi-bot-reaction-probe` 已归档待删）。
> 分方向原始调研（逐条 `文件:行` 证据、DDL、测试用例）在会话 scratch：`multi-repo/01-trigger.md` … `08-data-contract.md`。
> 前提约束：非多租户、无用户系统、内网不设防、开发态历史数据可任意覆盖。

---

## 0. 结论先行（12 条决策）

| # | 决策 | 一句话理由 |
|---|---|---|
| D1 | **「项目」= 仓库，只是叫法**；沿用 `repos` 表（主键 `repo_full_name`），不加合成 id、不加 `project_id` 外键列 | 全库已有 `repo` 文本口径，换键只会制造两份事实 |
| D2 | **配置全部落库**：`.github/pi-bot.yml` 整体退役，改为 `repos.settings jsonb`（zod 校验）；部署时给一份默认配置做 seed | 运维要改的东西不该跟代码一起 review |
| D3 | **部署默认配置**：`PI_BOT_DEFAULT_SETTINGS`（文件或内联 JSON），新项目入库时复制一份，之后只认库里的值 | "设置一个默认的"落点 |
| D4 | 配置非法**不停摆**：保留 last-known-good，面板红条告警；只有"从未成功过一次"才 `enabled=false` | 面板一次手滑不该让整个仓库静默停机 |
| D5 | **发现 ≠ 上线**：安装事件只建 `enabled=false, dry_run=true` 的行，面板一键启用；没有 yaml 也就不需要"同步"这一步 | 装到仓库 ≠ 愿意让它干活 |
| D6 | 触发重做成**五步流水线**（蒙版 → 别名扫描 → 面开关 → 触发人 → 命令解析），`settings.triggers` 默认 `['issuebot','ibot']`，大小写不敏感 | 现有三条正则 bug + 命令 args 被丢弃，叠别名治不了 |
| D7 | 反馈走 **reaction 状态机**（eyes → rocket / confused），`issue_feedback` 表以幂等键为锚做动作级去重；固定回复移除 | 实测：同 content 重复 POST 是幂等的（§11），可以直接当"收尾"用 |
| D8 | 打标 = 模型产判定键 → **机械归一化（词表/1:N/互斥组/上限/人工否决）** → 现有执行器；`settings.labels.vocabulary` 取代提示词里的硬编码标签集 | 标签体系随项目不同，不能写死在提示词字面量里 |
| D9 | 系统提示词 **6 层**，新增 P1「项目人格层」，**只从库里取**（部署默认给初值） | 与 D2 一致：一个地方配置，一个地方预览 |
| D10 | 隔离：仓库级并发（默认 2 / 全局 3）、排队闸门可配、熔断两级、`quota_counters` 计数、`metrics_daily` 按仓库分桶 | 一个仓库刷屏不该把别的饿死 |
| D11 | API 双轨：只读接口加 `?repo=`，**写接口新增在 `/api/repos/:owner/:name/...`** | 一次性改面板全部调用点 = 高风险大爆炸 |
| D12 | 迁移**只做新增**（`0003`），不改既有表结构、不重生成 `0000` | `migrate.ts` 有校验和账本；改已应用迁移会让环境拒绝启动 |

---

## 1. 必须先修的主链（P0）

| # | 断点 | 证据 | 影响 |
|---|---|---|---|
| B1 | `syncRepoConfig()` **全仓无生产调用者** | `apps/server/src/config/repo-config.ts:250`，仅 `config/index.ts:30` 再导出 | 真实投递一律命中 `UNKNOWN_REPO_POLICY`（`repo-config.ts:183`）被静默忽略 |
| B2 | 触发正则三类 bug：大小写不敏感缺失、前缀误判（`foo@ibot`）、前导字符只认空白；命令 args 在 `webhook.ts:296-302` 被丢弃 | `apps/server/src/http/webhook.ts:117-152` | 别名做不成可配置集合 |
| B3 | 标签集**硬编码**在提示词字面量里 | `apps/server/src/app/worker-deps.ts:191,199`、`apps/server/src/skills/builtin.ts:61` | 多项目不同标签体系无解 |
| B4 | 预算双口径：`DEFAULT_ASSEMBLE_BUDGET_CHARS=12_000` 按整条判定，`PROMPT_LIMITS.prompt=20_000` 内部硬截 | `apps/server/src/skills/assemble.ts:36`、`prompt.ts:36,331` | "面板预览"与"实际装配"不可能一致 |
| B5 | `triage` 幂等锚用 `missing_set_hash`，编辑正文不改这个哈希 | `apps/server/src/queue/idempotency.ts:23` | issue 编辑后重算被唯一键吃掉（静默不重跑） |
| B6 | `runtime_flags` 全局单例；`webhook_deliveries` 无 repo 列 | `apps/server/src/db/schema.ts:419`、`:83-104` | 无法按仓库暂停/熔断/回溯投递 |
| B7 | `runTriage()` / `applyCompliance()` 只被导出，生产链路无人调用 | `apps/server/src/workflows/index.ts:31,62` | 打标实际走信封 `actions[intent=label]`，改造落点是执行器与归一化层 |

> 注：B1 在 D2 之后**自然消失**（不再有 yaml 可同步）。但"项目从哪来"必须换成安装事件 + 手动添加两条入口，否则 `repos` 依旧是空表。

---

## 2. 数据模型（D1/D2/D12）

```
repos（沿用；主键 repo_full_name = owner/name）
 ├ repo_full_name PK
 ├ enabled, dry_run, archived_at
 ├ settings jsonb        ← 全部项目配置（zod: repoSettingsSchema）
 ├ settings_valid, settings_error, settings_updated_at
 ├ source               ← installation | manual
 └ installation_id
        │ repo（text，无 FK，与现有口径一致）
        ├── tasks / webhook_deliveries（新增 repo 列）/ issue_states / issue_fingerprints
        ├── bot_labels（+ source_key / judgement_hash / reason / run_id）
        ├── label_decisions      ← 新增：每轮判定一行，含 blocked_reason
        ├── issue_feedback       ← 新增：reaction 账本
        ├── quota_counters       ← 新增：命令/评论/建 issue/打标 计数
        ├── prompt_versions      ← 新增：P1 项目人格层版本正文
        └── metrics_daily（端上 DROP 重建为 (day, repo, outcome) 语义不变）
```

- **不加 `project_id`、不加外键、不加合成主键**。现有唯一约束全部已含 `repo` 文本（`tasks_repo_created_at_idx`、`metrics_daily_day_repo_outcome_uidx`、`bot_labels(repo,issue,label)` 等），多仓库不会撞键。
- `issue_feedback(repo, target_kind, target_number, comment_id, stage, content, anchor, reaction_id, applied_at, audit)`，唯一键 `(repo, target_kind, target_number, stage, anchor)`，`anchor = tasks.idempotency_key`（**不用 taskId**：retry/重投会换 taskId）。
- `prompt_versions(repo, version, body, note, created_at)` + `repos.settings.prompt = { enabled, current_version }`（与 `skills`/`skill_versions` 同构）。
- `quota_counters(repo, kind, window_start, count)`，唯一键 `(repo, kind, window_start)`。
- 迁移 `0003`: 只 `ALTER TABLE ... ADD COLUMN` + `CREATE TABLE`，不动既有列与主键（`repo_full_name` 继续当主键，URL 需要短标识时在路由层编码 `owner__name`，纯展示）。
- 改名/转移：`repo_full_name` 变了就是新仓库，历史留旧名（**明确接受的取舍**，不引入 repo_id 跟踪；需要时 `UPDATE repos SET repo_full_name=...` 一条语句）。

---

## 3. 配置形状（D2/D3）

```ts
// packages/contract/src/repo-settings.ts（替代 repo-config.ts 的 yml 契约）
export const repoSettingsSchema = z.object({
  version: z.literal(1),
  triggers: triggersConfigSchema.prefault({}),   // 见 §4
  labels: labelsConfigSchema.prefault({}),       // vocabulary / map / allow / missing
  compliance: complianceConfigSchema.prefault({}),
  commands: commandsConfigSchema.prefault({}),
  create_issue: createIssueConfigSchema.prefault({}),
  limits: limitsConfigSchema.prefault({}),       // 并发/配额/闸门/模型
  skills: skillsConfigSchema.prefault({}),
  prompt: promptRefSchema.prefault({}),          // enabled / current_version
  dry_run: z.boolean().default(true),
}).strict();
```

- **唯一写入方**：面板 `PUT /api/repos/:owner/:name/settings`（`dry_run`/`enabled` 另有专用端点）。
- **默认来源**：`PI_BOT_DEFAULT_SETTINGS`（文件路径或内联 JSON，缺省用 `repoSettingsSchema.parse({})` 的默认值）。新建仓库行时 `INSERT ... settings = <default>`，此后不再读它——**避免"改了默认值把线上项目一起改了"**。
- 校验失败：`settings_valid=false` + `settings_error`，保留 last-known-good 生效；面板红条 + "恢复默认"按钮。
- 退役清单：`REPO_CONFIG_PATH`、`createGithubRepoConfigFetcher`、`syncRepoConfig`/`REPO_CONFIG_SQL.upsert`、`config_synced_at`、blob sha 短路、push 触发同步、15min 轮询、`.github/pi-bot.yml` 与 `.github/pi-bot/PROMPT.md` 两份仓库内配置。

---

## 4. 触发体系（D6，约束 6）

**流水线**（`packages/contract/src/trigger.ts` 纯函数，webhook / worker / 面板预览共用）：

```
0 事件面查表 FACES[event][action]        off → ignore
1 自激过滤   sender.type==='Bot' | 自身 login | 正文含自有隐藏标记 → ignore
2 取别名     aliases = settings.triggers 解析结果（默认 issuebot, ibot / 大小写不敏感）
3 蒙版+扫描  scanAliases(maskCode(body), aliases)
             ├ 0 命中 & face='auto'    → 自动通道（issue 面 → auto:triage）
             └ 0 命中 & face='mention' → ignore
4 触发人门禁 users: 'all' | login 名单（空数组 = 配置非法，不是 all）
5 命令解析   command / question / bare / null → 命令层门禁（author_association + allow_users）
6 幂等 → INSERT tasks → enqueue → ack
```

```yaml
# 面板里的 triggers（部署默认值，不来自仓库文件）
triggers:
  enabled: true
  aliases: [issuebot, ibot]     # 小写归一；@IssueBot 由大小写不敏感免费得到
  users: all                    # 或 [alice, bob]，只约束提及类触发
  faces:
    issue_opened: auto          # 新 issue 不看 @ 直接判
    issue_edited: auto
    issue_reopened: auto
    issue_comment: mention
    issue_comment_edited: off   # 修错别字重跑 = 重复扣费
    pr_review_comment: mention
    pr_review_submitted: off
    pr_opened: off
    body_mention: off
```

- 触发人 ≠ 命令门禁，**分层串联**：触发层判"能不能叫醒我"，命令层判"能不能花我的钱"。
- `merge_defaults` / `remove` 保留（部署默认别名撞真人用户名时能摘），App slug 永久并入且不可摘。
- `PI_BOT_MENTION` 降级为兼容读取，一个版本后删。

---

## 5. 无感反馈：reaction 代替固定回复（D7，约束 5）

| 阶段 | GitHub 动作 | 目标 |
|---|---|---|
| received（入队成功） | `+eyes` | 触发评论；issue/PR 事件 → 主贴 |
| succeeded | `-eyes` → `+rocket` | 同锚点 |
| failed / timed-out / cancelled / 队列超时 | `-eyes` → `+confused` | 同锚点（闸门路径没有 worker，由闸门自己收尾） |
| 重复投递 / 门禁拒绝 / dry-run | 不写 DB、不动 GitHub（dry-run 只写 `run_events(feedback.planned)`） | — |

**实测结论直接改写了实现方式**（§11）：同 content 重复 POST 幂等且返回同一个 id，所以
- 终态"先删 eyes 再加 rocket"是**两次必要调用**（跨 content，不能省）；
- 但**同一 content 不需要先查再发**，直接 POST 即可；只有"要在面板里显示 reaction id"时才回填；
- **不要为了刷状态删了重加同一 content**：删了重加会换 id，白白多写一次审计。

其它规则：
- 只碰自己的 reaction：`GET .../reactions?content=X&per_page=100` 后按 `user.login` 过滤（App 身份显示为 `<slug>[bot]`）。
- 已关闭的 issue 允许删 eyes，但**不加**终态 reaction。
- 输出两条通道：**A 自动通道**（triage / compliance / 闸门）**只有 reaction + 标签，零评论**，结论落 `envelopes.actions`/`bot_labels` → 面板；**B 人工通道**（`@bot /cmd`、`@bot 提问`）评论级 eyes → 完成后一条最终回答。
- 移除 6 处固定文案（欢迎语 `webhook.ts:69-75`、死代码 ack `webhook.ts:167-182`、triage 降级评论 `triage.ts:206-244`、未接线的排队文案 `queue-gate.ts:40-42`、命令门禁 5 条 message、compliance nudge）。
- 保留 3 类信息型：B 通道最终回答、`create_issue` 命中指纹的追加、`fallback` 兜底。
- `actions.intent` 扩 `reaction.add` / `reaction.remove`（DB 无 CHECK，只需改 `queries/sql.ts:339` 与契约文档）。

---

## 6. 打标与「合规缺失项」

### 6.1 合规缺失项是什么

`compliance.rules` 是一组**"issue 必须包含哪些信息"的检查项**（现有契约 `packages/contract/src/repo-config.ts:29-47`），例如：

| 规则 id | 含义 | 判定 |
|---|---|---|
| `repro-steps` | 有可复现步骤 | 正文里有步骤/编号列表/复现描述 |
| `version` | 说明了版本或环境 | 命中版本号、OS、浏览器、commit 等 |
| `expected-actual` | 说了预期与实际 | 两段都有 |
| `logs` | 附了日志/截图 | 代码块、图片链接、堆栈 |

现在缺项时由 `buildComplianceComment()`（`workflows/compliance.ts:141-155`）发一条「## 还缺这些信息（N 项）」评论催人补，并按 `missing_set_hash` 去重。**这就是"合规缺失项"** —— 本质是 issue 质检，与打标同源。

**拍板结果**：不发这条评论。缺项时 → 打 `needs-info` 标签 + `confused` reaction + 面板 Issue 详情列出"缺哪几条、引用哪段原文"。规则集默认内置上面 4 条（可由面板按项目改），`compliance.enabled` 默认 `false`（先观察，不打扰）。

### 6.2 打标流水线

1. 模型产出标签名或判定键（现状）。
2. `normalizeDesired()` 纯函数机械裁剪：词表过滤 → `map` 1:N 展开 → 互斥组（`priority:*` 只留一个）→ `max_labels_per_issue`（≤6）→ 人工否决剔除（人撤掉的标签记 tombstone，不再自动加回）。
3. 落标走现有 `planLabelDelta` + `executeLabelPlan`，执行器不改。
4. `labels.vocabulary: [{name, meaning, color, description, group}]` —— 打标白名单 + 提示词注入源（替掉 B3）。
5. `labels.missing: warn`（默认，只告警+面板）| `create`（按词表 color/description 建）| `ignore`。
6. **打标失败不翻 run**（`FailureSignal.fatal=false`），否则一个拼错的标签名会把 `rocket` 变成 `confused`。
7. 限流：每 issue/小时 ≤4 次、每仓库/小时 ≤60 次；422/404 不重试；并发用 `pg_advisory_xact_lock(hashtext('repo#n'))`。
8. 顺序天然满足"先打标后 rocket"：打标在 run 内，reaction 是 run 终态收尾。

---

## 7. 项目级系统提示词（D9，约束 4）

| 层 | 内容 | 来源 | 覆盖/追加 | 上限 |
|---|---|---|---|---|
| P0 | **每阶段一份系统提示词**（`format_check` / `classify` / `agent`）：身份、能力边界、输出格式、以及「哪些话不该说」；流程结构、状态转移、动作白名单仍由代码固定 | `prompt_versions` 按 `kind` 的 4 条版本线 + 内置默认常量 | ✅ **整体覆盖**（项目版本替换默认，不追加） | `agent` **4000**（阶段 2，计入 P1 预算）/ `format_check`·`classify` **8000**（阶段 0/1，不注入 P1） |
| **P1** | **项目人格层**（项目背景、领域知识、语气、术语） | `prompt_versions`（库）+ 部署默认 | ✅ 整体替换 | 4000 |
| P2 | 仓库约定（`AGENTS.md` 语义，属代码约定不是 bot 配置） | worktree 文件 | ⚠️ 只能改文件 | 根 4000 / 就近 6000 |
| P3 | 任务技能 | registry（面板 > 仓库文件 > 内置） | ✅ 整体替换 | 4000 |
| P4 | 任务上下文（issue 标题/正文/标签/参数） | `tasks` + 事件 | ❌ | ~4400 |
| P0' | 输出契约 | 代码常量 | ❌ **必须最后** | — |

- P1 插在 head 之后、`AGENTS.md` 之前（`assemble.ts` 只需多 push 一块，切分逻辑零改动；输出契约保住"最后一段"）。
- 保存即新建一个 `prompt_versions` 行（可回滚），`repos.settings.prompt.current_version` 指过去。
- 变量：`{{repo}}`、`{{default_branch}}`、`{{labels}}`、`{{triggers}}`；未定义变量 → 保存期报错。
- **预算统一**：12k 为目标预算，各层上限改软上限；**保存期预演**（用最近一次装配统计估算 P0/P2/P3 长度），存不下直接拒绝；运行期只做整段丢弃兜底并记事件。
- **`agent` 层与 P1 的预算口径（2026-11 落地）**：`agent` 落在 `basePrompt` 里、计入 `baseChars`，故
  `available = min(4000, 12000 − (baseChars + agentsChars + skillChars))`，**`agent` 写多长就直接扣掉 P1 多少可存额度**；
  据此 `agent` 上限收窄到 **4000**（与 P1 同档，不是 8000）。运行期超预算的丢弃顺序是「P1 → 就近 AGENTS → 技能层 → 根 AGENTS」，
  `head` / `tail`（含 `agent` 段与输出契约）**永不丢弃**；面板层序预览显示各层字符数、`available` 与预计丢弃项。
- 面板"预览最终 system prompt 全文"必须调用与运行时同一个装配函数，并回显 `ref@sha`。
- 无 P1 时装配结果与今天逐字节相同（兼容）。**2026-11 补充**：阶段 2 的 `head` 已换成可覆盖的 `agent` 段（内置默认正文 = 原 `buildTaskPrompt` 系统段），阶段 0/1 另有 `format_check` / `classify` 两份默认；命令类任务（`/review-pr` 等）的 head 逐字节不变——见 `docs/impl-fixed-pipeline.md` §4 / §7.7。

---

## 8. 生命周期、隔离与配额（D3/D5/D10）

**接入两条入口**：

| 入口 | 动作 |
|---|---|
| `installation_repositories.added` | 建 `repos` 行：`enabled=false, dry_run=true, settings=<部署默认>, source='installation'`；面板标「待接入」 |
| 面板手动添加 `owner/name` | 同上，`source='manual'`（内部仓库/无 App 安装场景） |
| `installation_repositories.removed` / `installation.deleted` | 按 `installation_id` 限定批量 `enabled=false`（防同名误伤） |
| `installation.suspend` | `runtime_flags{key:'pause:installation:<id>'}` |

启用自检（面板一键跑）：App 权限足够、`settings` 校验通过、标签词表可读 → 才允许把 `dry_run` 关掉。

**`dry_run` 是什么**：干跑开关。开着时 worker 产出的所有信封、动作、审计都正常写入，但**一个 GitHub 写都不做**——不发评论、不打标、不贴 reaction、不 push 分支（`worker/writeback.ts:159-169`、`webhook.ts:732-735` 已按此实现）。用途是新仓库接入时先观察判定质量、或出事故时一键止血。**拍板：保留，新接入默认 `true`**，面板上 dry-run 期间显示黄色横条，任务标记为"演练"。

| 维度 | 现状 | 目标 |
|---|---|---|
| 仓库解析 | 无 installation 校验 | webhook 第 5 步前插「4.5 步」：`repository.full_name` → 仓库行；`installation.id` 准入校验；未知仓库记指标 + 审计，不再静默 |
| 并发 | 全局 3 | 仓库 2 / 全局 3 |
| 排队闸门 | 常量 10min | `settings.limits.queue_wait_minutes` |
| 熔断 | 全局单键 | 两级：仓库 3 次/10min、全局 5 次/15min（`runtime_flags` 加 `repo` 列，`NULL`=全局） |
| 配额 | 无执行点 | `quota_counters` + `limits`：命令 / 评论 / 建 issue / 打标 |
| GitHub 速率池 | 共享 installation | 无法隔离 → 公平调度 + 退避 + 仓库级暂停 |
| git 缓存 / worktree / 容器 | 已按 repo 隔离 | 容器加 `pi-bot.repo` label |
| 成本 | `usage_costs` 经 run 归属 | 仓库维度聚合 + 月度预算软提醒 |
| 指标 | `metrics_daily(day,repo,outcome)` | 语义不变，查询加仓库筛选 |

---

## 9. Web 工作台（约束 7）

```
侧栏（一列，两个分组）
├ 全局        总览 /   成本 /costs   质量 /quality   审计 /audit   技能 /skills   系统 /system
└ 当前仓库     工作台 /repos/:repo                       （:repo = owner__name 单段编码）
               Issue 中心 /repos/:repo/issues
               Issue 详情 /repos/:repo/issues/:kind/:number
               运行 Runs /repos/:repo/runs[/:id]
               设置 /repos/:repo/settings/{general,triggers,labels,limits,prompt}
```

- **首页 5 区块**（统计降级为第 ④）：① 需要人介入（失败/超时/待人回答/配置无效）② 近 24h 事件流 ③ 仓库健康卡（启用/dry-run/配置合法/队列/最近错误）④ 4 个 sparkline（今日任务、成功率、成本、p95）⑤ 快捷动作（暂停、重跑、打开 GitHub、导出审计）。
- **Issue 详情页承担"结果去哪了"**：agent 结论正文（`actions.external_ref IS NULL` 时无评论但有正文）、打了/未打标签及理由（`bot_labels.reason` + `label_decisions.blocked_reason`）、reaction 状态（`issue_feedback`）、合规缺项清单、run 时间线与成本、重跑入口。
- **设置 5 分区**：general（开关/dry-run/安装信息/危险区）、triggers（别名 + 触发人 + 面开关，带"命中预览"）、labels（词表 + 1:N 映射 + missing 策略）、limits（并发/配额/闸门/模型）、prompt（编辑器 + 逐层预览 + 版本回滚）。无权限模型，只记 `updated_at`。
- 实时性：轮询为主（工作台 15s、详情 5s），SSE 只做"任务状态变化"一路。
- 新组件：仓库切换器（DropdownMenu + Command）、时间轴、diff 视图、提示词编辑器、健康卡；MSW 增加 repos/feedback/label-decisions 三组 fixtures。

---

## 10. 实施阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M0 主链** | 安装事件 + 手动添加两条建行入口（替掉无调用的 yaml 同步）；触发解析器重写（`contract/src/trigger.ts` + 单测）；B5 幂等锚换 `content_hash` | 真实投递能建行并跑通一次 triage；`@IssueBot`/`@ibot`/代码块蒙版用例全绿 |
| **M1 配置落库** | `settings jsonb` + `repoSettingsSchema` + 部署默认 seed + 面板读写接口；退役 yml 全链路 | 同一份默认配置装出两个仓库，各自改触发词互不影响；配置写坏后仍按 last-known-good 干活 |
| **M2 无感反馈** | reaction 状态机 + `issue_feedback` + 移除 6 处文案 + `actions` 枚举扩展 | 自动触发零评论；eyes→rocket/confused 正确；重复投递不重复贴；dry-run 零 GitHub 写 |
| **M3 打标与质检** | `labels.vocabulary` + `normalizeDesired()` + `missing` 策略 + `label_decisions` + compliance 改 `needs-info` | 两个仓库不同标签体系各自打对；缺项只出标签+confused；人工撤标不被加回 |
| **M4 提示词** | P1 层 + `prompt_versions` + 预算预演 + 预览接口 | 两仓库不同人格；预览 == 运行时装配；超预算保存被拒 |
| **M5 隔离与配额** | 4.5 步解析 + 两级并发/熔断/配额 + `metrics_daily` 查询改造 | 一个仓库压满不影响另一个；仓库暂停只影响自己 |
| **M6 工作台** | 两级导航 + 仓库切换器 + 首页 5 区块 + Issue 中心/详情 + 设置 5 分区 | 四态测试通过；旧链接重定向生效 |

契约同步顺序（固定）：`packages/contract/src/*` → `pnpm gen:openapi` → `apps/panel/src/lib/contract.ts` + `mocks/**` → 面板测试 → 服务端测试。每阶段收尾 `pnpm typecheck && pnpm test && pnpm lint`。

---

## 11. 实测记录（2026-11-10，本机 gh + Chrome）

探测仓库 `Tioit-Wang/pi-bot-reaction-probe`（临时建、已归档；`gh auth` 缺 `delete_repo` scope，删除需你执行 `gh repo delete Tioit-Wang/pi-bot-reaction-probe --yes`）。

| # | 事实 | 结果 |
|---|---|---|
| 1 | 同一 issue 主贴、同 content 连续 POST 两次 | 第一次 `201 Created`、第二次 `200 OK`，**返回同一个 reaction id**（`641848229`）→ 幂等 |
| 2 | 同一条评论、同 content 连续 POST 两次 | 同一个 id（`466986456`）→ 幂等 |
| 3 | `GET /issues/1/reactions?content=eyes&per_page=100` | 只返回 1 条，含 `user.login` → 可用于识别"我的 reaction" |
| 4 | `DELETE /issues/1/reactions/{id}` | `204 No Content`；随后重发同 content **产生新 id**（`641849973` → `641850193`）→ 不要为刷状态删了重加 |
| 5 | PR 主贴用 `/issues/{n}/reactions` | 成功且幂等（id `641851680`）→ PR 与 issue 共用一套端点 |
| 6 | 权限（Chrome 读官方 REST 文档） | issue / issue-comment 的 reaction：**Issues (write)**；PR review comment 的 reaction：**Pull requests (write)** |

结论与落地：
- **不需要新权限**：issue 与 issue 评论 reaction 走现有 `issues:write`（App 已在测试仓库真机贴出过 `<slug>[bot]` 的 eyes，见 `docs/spec/ux-issue-sessions.md:74`）。
- **不引入 `pull_requests:write`**：PR 行内 review comment 触发时，**reaction 打在 PR 主贴**，不打在 review comment 上（省一个权限，也少一处行内噪音）。
- `issue_feedback` 的 `reaction_id` 允许为空（只在需要 DELETE 时才必须有）；POST 前不必查重。

---

## 12. 已知取舍与风险

- **仓库改名/转移** = 新仓库：历史留旧名，跨改名聚合会断；需要时一条 `UPDATE repos SET repo_full_name=...` 手工处理（不做 repo_id 跟踪）。
- **没有仓库内配置**：仓库维护者不能自己改触发词/标签词表，必须经面板（这是 D2 的必然代价，换来"一处配置、一处预览"）。
- **提示词预览读默认分支、任务读检出 ref**，两者可能不同（面板回显 `ref@sha` 缓解）。
- **共享 installation token 的速率池**无法真隔离，只能公平调度 + 仓库级暂停。
- 合规判定依赖模型，规则集默认关闭，先观察再开。
