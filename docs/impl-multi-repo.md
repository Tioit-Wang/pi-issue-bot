# 多仓库改造 · 实施规格（子代理唯一依据）

> 状态：实施中。任何与本文件冲突的实现以本文件为准；本文件与 `docs/plan-multi-repo.md`（设计）冲突时，以**本文件**为准（已按 2026-11-10 的拍板收敛）。
> 所有子代理必须：只改自己名下的文件、改完跑该包的验收命令、在汇报里列出「改了哪些文件 + 验收命令输出摘要」。

## 0. 不变式（任何包都不得违反）

1. 「项目」= 仓库，**不引入** `projects` 表 / `project_id` / `repo_id` / 别名表；一律沿用 `repo`（`owner/name` 文本）。
2. `.github/pi-bot.yml` **整体退役**：配置只存在于 `repos.settings jsonb`（面板写入），新建仓库时由部署默认（`PI_BOT_DEFAULT_SETTINGS`）seed 一份。**不再读、不再同步仓库内配置**。
3. **合规缺失项由提示词控制**：删除 `compliance.rules` 配置与 `buildComplianceComment()`；issue 缺信息时只打 `needs-info` 标签 + `confused` reaction，明细只在面板。判定依据写进技能/提示词里。
4. **无感反馈**：**平台判定类**自动通道零评论——但固定流水线的三个阶段例外（`tasks.source='pipeline'`：格式检查不通过/复查通过的确认、分类结论、未 ready 时的 `@` 门禁回执都会发评论，由 AI 撰写）；只有 `@bot /命令`、`@bot 提问` 允许一条最终回答（信息型产出，不是模板回执）。例外口径见 `docs/impl-fixed-pipeline.md` §3。
5. 非多租户、无用户系统、内网不设防；开发态，数据可重建。
6. 现有唯一约束/主键不推翻：`repo` 文本 + 既有唯一索引即可支撑多仓库（已核实不会撞键）。
7. 每个包收尾必须让 `pnpm -r typecheck` 通过；测试只能新增/调整**本包相关**断言，不得为了变绿删掉别人的测试语义。

## 1. 已完成的底座（W0，主代理，勿重做）

- `packages/contract/src/trigger.ts`：别名归一/解析/蒙版/触发人/事件面，29 条单测通过。
- `packages/contract/src/repo-config.ts`：新增 `triggers` 段。
- `apps/server/src/http/webhook.ts`：触发判定改走 `parseTriggerBody`，别名来自 `resolveTriggerAliases({configured: policy.config?.triggers, deployment})`；删除「接管」评论（`ISSUE_GREETING_BODY` + `deps.greet`）。
- `apps/server/src/app/config.ts` 删除 `greet`；`app/compose.ts` 改为传 `aliases`。
- 验收基线：`apps/server` typecheck 通过，`http-webhook*.test.ts` 32 条通过。

## 2. 目标数据模型（最终形态）

```
repos (PK repo_full_name)
  enabled, dry_run, archived_at,
  settings jsonb NOT NULL default '{}'     ← 全部配置（repoSettingsSchema）
  settings_valid boolean NOT NULL default true,
  settings_error text, settings_updated_at timestamptz,
  source text NOT NULL default 'manual',   ← manual | installation
  installation_id bigint,
  config jsonb, config_valid, config_error ← 过渡期保留（W1 后不再读，W3 可删列）

issue_feedback (bigserial PK)
  repo, target_kind, target_number, comment_id bigint, stage, content,
  anchor, reaction_id bigint, applied_at timestamptz, audit jsonb, created_at
  UNIQUE (repo, target_kind, target_number, stage, anchor)

label_decisions (bigserial PK)
  repo, target_number, judgement_hash, desired jsonb, applied jsonb,
  blocked_reason text, reason text, run_id uuid, created_at

quota_counters
  repo, kind, window_start timestamptz, count int
  UNIQUE (repo, kind, window_start)

prompt_versions
  repo, version int, body text, note text, created_at
  UNIQUE (repo, version)

增量列：
  webhook_deliveries + repo text（可空）
  runtime_flags + repo text（可空；NULL = 全局）
  bot_labels + source_key text, judgement_hash text, reason text, run_id uuid
  metrics_daily 语义不变（已是 (day, repo, outcome)）
```

迁移：新增 `migrations/0003_multi_repo.sql` + `migrations/meta/0003_snapshot.json` + `_journal.json` 追加条目。**不重生成 0000**（`db/migrate.ts` 有校验和账本）。开发态允许 `DROP`/`ADD COLUMN`，不写数据搬迁脚本。

## 3. 配置契约（`repoSettingsSchema`）

```ts
{
  version: 1,
  triggers: triggersConfigSchema,        // 已存在（别名/触发人/事件面）
  labels: {
    vocabulary: Array<{ name, meaning?, color?, description?, group? }>,  // 新增：项目标签词表
    map: Record<judgementKey, string | string[]>,                          // 支持 1:N
    allow?: string[],
    missing: 'warn' | 'create' | 'ignore',                                 // 默认 warn
    max_per_issue: number,                                                 // 默认 6
  },
  commands: { enabled, allowed[], author_associations[], allow_users[], rate_limit_per_hour },
  create_issue: { enabled, daily_quota, scenarios[] },
  skills: { repo_skills: boolean },
  limits: { max_comments_per_hour, max_actions_per_run, max_task_minutes,
            concurrency_per_repo, queue_wait_minutes },                  // 后两个新增
  prompt: { enabled: boolean, current_version: number },                 // 新增
  dry_run: boolean,
}
```
**删除** `compliance` 段（规则改由提示词/技能承载）。`repoConfigSchema` 更名为 `repoSettingsSchema`（旧名保留一个版本作为 deprecated alias 导出，避免一次性改光调用点；新代码只用新名）。

部署默认：`PI_BOT_DEFAULT_SETTINGS`（文件路径或内联 JSON；缺省 `repoSettingsSchema.parse({})`）。建行时写入，之后只认库里的值。

## 4. 任务包与文件所有权（严格）

> 冲突规则：**不在你名下的文件一行都不要改**。需要别人配合时，在汇报里写「需要 X 包改 Y」，由主代理转派。

### W1-A · 配置落库与仓库存储（fixer）
负责人文件：
- `packages/contract/src/repo-config.ts`、`packages/contract/src/schemas.ts`、`packages/contract/test/config.test.ts`
- `apps/server/src/config/repo-config.ts`（→ 改为 `repos` 存储：`readRepoPolicy` 从 `settings` 读、`upsertRepo`、`updateRepoSettings`、`listRepos`、默认 settings、`settings_valid/error` 处理）
- `apps/server/src/config/index.ts`
- `apps/server/test/config-repo-config.test.ts`
交付：
1. `repoSettingsSchema`（§3 形状）+ 编译期类型导出；旧 `repoConfigSchema` 作为 deprecated alias。
2. 删除 `REPO_CONFIG_PATH`/`createGithubRepoConfigFetcher`/`syncRepoConfig`/`REPO_CONFIG_SQL.upsert`（全仓无生产调用者，已核实）。
3. `repos` 存储 API：`upsertRepo({repo, source, installationId, settings})`、`readRepoPolicy(db, repo)`（读 settings，非法则 `settings_valid=false` 且保留 last-known-good）、`updateRepoSettings(db, repo, settings)`、`listRepos(db)`。
4. 面板 HTTP：`GET /api/repos`、`GET /api/repos/:owner/:name/settings`、`PUT /api/repos/:owner/:name/settings`、`POST /api/repos`（手动添加，body `{repo}`）。
验收：`pnpm --filter @pi-issue-bot/contract test`、`pnpm --filter @pi-issue-bot/server typecheck`、`npx vitest run test/config-repo-config.test.ts`。

### W1-B · 路由与仓库生命周期（fixer）
负责人文件：`apps/server/src/http/webhook.ts`、`apps/server/src/http/server.ts`、`apps/server/src/queue/**`、`apps/server/src/jobs/**`、`apps/server/test/http-webhook.test.ts`、`apps/server/test/http-webhook-free-mention.test.ts`、`apps/server/test/queue-*.test.ts`
交付：
1. webhook「第 4.5 步」：`repository.full_name` → 仓库行；`installation.id` 准入校验；未知仓库**记日志 + 落 `webhook_deliveries.repo`**，仍回 200 `ignored`。
2. 安装事件白名单：`installation.created` / `installation_repositories.added|removed` / `installation.deleted` / `installation.suspend|unsuspend`。added → 建 `repos` 行（`enabled=false, dry_run=true, source='installation', settings=默认`）；removed/deleted → 按 `installation_id` 批量 `enabled=false`；suspend → `runtime_flags{key:'pause:installation:<id>', repo:NULL}`。
3. 仓库级并发与闸门：`limits.concurrency_per_repo`（默认 2，全局仍 3）、`limits.queue_wait_minutes`（默认 10）替代常量。
4. 熔断两级：仓库 3 次/10min、全局 5 次/15min（`runtime_flags.repo`，NULL=全局）。
5. 删除死代码：`WebhookAck.postAckComment`、"已收到"评论分支、`ackStyle` 字段（改为一律 reaction）；`queue-gate.ts` 的 `QUEUE_GATE_COMMENT` 文案删除（改为 `confused` reaction + `tasks.status='cancelled_queue'`）。
验收：`npx vitest run test/http-webhook.test.ts test/http-webhook-free-mention.test.ts test/queue-gate.test.ts test/queue-circuit-breaker.test.ts` + `pnpm --filter @pi-issue-bot/server typecheck`。

### W1-C · 面板骨架（ui-designer）
负责人文件：`apps/panel/src/**`（除 `src/lib/contract.ts`、`src/lib/api.ts`、`src/mocks/**` —— 那三处归 W3-B）
交付：
1. 两级导航：全局（总览/成本/质量/审计/技能/系统）+ 当前仓库（工作台/Issue 中心/Issue 详情/运行/设置），路由前缀 `/repos/:repo`（`:repo = owner__name`），旧 `/tasks/:id`、`/issues/:owner/:name/:kind/:number` 保留 302 重定向。
2. 仓库切换器（左栏顶部；数据来自 `GET /api/repos`，允许失败态与空态）。
3. 全局工作台首页 5 区块骨架（数据先用现有接口 + 空态兜底）：需要人介入 / 24h 事件流 / 仓库健康卡 / 迷你趋势 / 快捷动作。
4. 四态（loading/空/错误/降级）沿用现有 `AsyncSection`/`Skeleton`。
验收：`pnpm --filter @pi-issue-bot/panel typecheck`、`npx vitest run`（panel 包内）、`pnpm --filter @pi-issue-bot/panel build`。

### W2-D · 无感反馈（reaction 状态机）（fixer）
负责人文件：`apps/server/src/github/**`、`apps/server/src/worker/**`、`apps/server/src/feedback/**`（新建）、`apps/server/test/github-executor.test.ts`、`apps/server/test/worker-*.test.ts`、`apps/server/test/e2e-*.test.ts`
交付：
1. `feedback` 模块：`applyFeedback()` 实现 §2 的 `issue_feedback` 台账 + 幂等（唯一键命中即跳过；`reaction_id` 可空）。实测已确认同 content 重复 POST 幂等 → **POST 前不查重**。
2. 状态机：入队 `+eyes`（已有）→ 终态 `-eyes` + `+rocket`（成功）/ `+confused`（失败/超时/取消/队列超时）。只删自己的 reaction（`GET ?content=&per_page=100` 后按 `user.login` 过滤）。
3. `actions.intent` 扩 `reaction.add` / `reaction.remove`；`queries/sql.ts` 的 `ACTION_INTENTS_SQL` 同步。
4. 移除 executor 里针对「打标/反馈」的评论隐藏标记依赖（命令/问答类保留）。
5. dry-run：一个 reaction 都不打，只写 `run_events(kind='feedback.planned')`。
验收：`npx vitest run test/github-executor.test.ts test/worker-*.test.ts test/e2e-dry-run.test.ts` + typecheck。

### W2-E · 打标与质检（fixer）
负责人文件：`apps/server/src/workflows/**`、`apps/server/src/app/worker-deps.ts`、`apps/server/src/skills/prompt.ts`、`apps/server/src/skills/builtin.ts`、`apps/server/src/app/model-env.ts`、`apps/server/test/workflow-*.test.ts`、`apps/server/test/app-worker-prompts.test.ts`
交付：
1. `normalizeDesired()` 纯函数：词表过滤 → `map` 1:N 展开 → 互斥组（同 group 只留一个）→ `max_per_issue` → 人工否决剔除；落标仍走 `planLabelDelta` + `executeLabelPlan`。
2. 提示词注入 `labels.vocabulary`（替掉 `worker-deps.ts:191,199`、`builtin.ts:61` 的硬编码标签集）。
3. `labels.missing` = warn（默认）/create/ignore；打标失败 `FailureSignal.fatal=false`。
4. `label_decisions` 落库（每轮一行，含 `blocked_reason`），`bot_labels` 补 `source_key/judgement_hash/reason/run_id`。
5. **删除** `workflows/compliance.ts` 的评论构造与调用；缺信息改 `needs-info` 标签 + `confused` reaction；`compliance` 相关配置从契约移除（由 W1-A 做，你只删用法）。
验收：`npx vitest run test/workflow-triage.test.ts test/workflow-compliance.test.ts test/app-worker-prompts.test.ts` + typecheck。

### W2-F · 面板 Issue 中心 / 详情 / 统计分析（ui-designer，接 W1-C）
负责人文件：`apps/panel/src/routes/**`、`apps/panel/src/components/**`
交付：Issue 中心表（项目/编号/标题/标签/状态/reaction/耗时/成本/最后更新 + 筛选搜索分页）、Issue 详情（结论正文、标签与理由、reaction 状态、合规缺项、run 时间线与成本、重跑入口）、成本/质量/审计加仓库筛选、系统页仓库开关。
验收：panel typecheck + vitest + build。

### W3-G · 项目提示词层（fixer）
负责人文件：`apps/server/src/skills/assemble.ts`、`apps/server/src/skills/agents-md.ts`、`apps/server/src/skills/registry.ts`、`apps/server/src/skills/store.ts`、`apps/server/src/prompt/**`（新建）、`apps/server/src/http/api/skills.ts`、`apps/server/test/skills-assemble.test.ts`、`apps/server/test/skills-registry.test.ts`
交付：
1. P1「项目人格层」：来自 `prompt_versions`（库），插在 head 之后、`AGENTS.md` 之前；无 P1 时装配结果与现状逐字节一致。
2. 版本表读写 + 保存即新建版本 + 回滚为一等操作。
3. 预算统一：12k 目标预算 + 各层软上限 + **保存期预演**（超预算拒绝保存）；运行期整段丢弃兜底并记事件。
4. `GET /api/repos/:owner/:name/prompt`（含 `ref@sha` 与最终装配文本预览）、`PUT`（保存新版本）、`POST /prompt/rollback`。
验收：`npx vitest run test/skills-assemble.test.ts test/skills-registry.test.ts` + typecheck。

### W3-H · 查询 / API / 契约同步（fixer）
负责人文件：`apps/server/src/queries/**`、`apps/server/src/http/api/**`、`apps/server/src/http/metrics.ts`、`packages/contract/src/api.ts`、`packages/contract/test/contract.test.ts`、`openapi/**`、`apps/panel/src/lib/contract.ts`、`apps/panel/src/lib/api.ts`、`apps/panel/src/mocks/**`
交付：
1. 只读接口加 `?repo=`（overview/tasks/costs/quality/audit/issues/system），返回体字段向后兼容；写接口集中在 `/api/repos/*`。
2. `/api/system` 的 repos 列表改为读 `repos`（含 enabled/dryRun/settingsValid/archivedAt/lastActivityAt）。
3. `packages/contract` 改完 → `pnpm gen:openapi` 重新生成 → 面板 `lib/contract.ts` + mocks 跟进。
4. 面板统计页需要的新字段（reaction 状态、label decisions、feedback）加进响应体。
验收：`pnpm --filter @pi-issue-bot/contract test`、`pnpm gen:openapi`、`npx vitest run test/queries-*.test.ts test/http-server.test.ts`、panel typecheck。

### W3-I · 面板设置页（ui-designer，接 W2-F）
负责人文件：`apps/panel/src/routes/repos/**`（新建）、`apps/panel/src/components/settings/**`（新建）
交付 5 分区：general（开关/dry-run/安装信息/归档）、triggers（别名 + 触发人 + 面开关 + **命中预览**：用后端同一解析器，粘贴一段正文看是否命中）、labels（词表 + 1:N 映射 + missing 策略）、limits（并发/配额/闸门/模型）、prompt（编辑 + 逐层预览 + 版本回滚）。
验收：panel typecheck + vitest + build。

## 5. 波次与依赖

```
W0（已完）主代理：trigger 底座 + webhook 触发接线 + 删接管评论
W1 并行：A 配置落库 · B 路由/生命周期 · C 面板骨架
W2 并行：D 无感反馈 · E 打标质检 · F 面板 Issue/统计
W3 并行：G 提示词层 · H 查询/API/契约同步 · I 面板设置页
W4 主代理：整合 + 全盘验证 + 修残余
```
W2 依赖 W1（B 改过 webhook，D 在其后改 worker/or github；E 依赖 A 的 settings 形状）。
W3 依赖 W2（G 改 skills/prompt.ts，E 也在改它 → G 必须在 E 之后；H 依赖 A/G 的接口；I 依赖 H 的 mocks）。

## 6. 全盘验证（W4，主代理执行）

1. `pnpm -r typecheck`
2. `pnpm lint`
3. `pnpm test`（server 84 文件 + contract + panel + shared；含真 PG 的 e2e）
4. `pnpm gen:openapi` 后再跑一次 `pnpm --filter @pi-issue-bot/contract test`（防契约漂移）
5. 迁移重建：`DROP DATABASE`/新建库 → `pnpm --filter @pi-issue-bot/server exec tsx src/cli.ts migrate` → 断言 `db-schema.test.ts` 通过
6. 面板 `pnpm --filter @pi-issue-bot/panel build`
7. 手工冒烟（可选，需真 App）：装两个仓库 → 各自改触发词 → `@IssueBot` 触发、代码块不触发、处理后只有 rocket 无评论
