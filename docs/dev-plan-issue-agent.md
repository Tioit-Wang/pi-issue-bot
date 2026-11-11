# Issue Agent v0.3 · 开发计划（v2，已吸收三方审校）

> 事实源：`docs/req-issue-agent.md`（v0.3 定稿）。配套测试设计：`docs/test-plan-issue-agent.md`（108 条自动化用例 + 4 条真环境）。
> 起点：`main@3d7e188`（刚完成「固定流水线」v1.5，本次是**方向性回退 + 收敛**）。
> 本版修订依据：三份独立审校（需求覆盖 / 代码事实 / 测试可执行性）的全部发现，含 1 个原方案会直接踩爆的坑（**持久会话状态存在 `issue_pipeline` 里**）。

---

## 0. 总览

### 0.1 一句话

把「三阶段流水线 + 状态机 + 闸门 + 判定任务」整体退役，收敛成：**一个 issue 一个 agent、一个串行队列、一份技能目录、一条永久幂等规则**。

### 0.2 与当前实现的差（v2 重算，产品/测试分开计）

| 类别 | 产品文件 | 测试文件 | 说明 |
|---|---|---|---|
| **删除** | 约 22 | 29 | 产品：`workflows/pipeline*.ts`(4) + `stage-result.ts` + `pipeline-labels.ts` + `skills/stage-prompts.ts` + `jobs/pipeline-close.ts` + `config/pipeline-constants.ts` + `prompt/store.ts` + `http/api/prompt.ts` + 面板 `repo-pipeline.tsx` + `components/pipeline/**`(8) + `components/settings/pipeline-section.tsx`。测试：`pipeline-*.test.ts` **28** + `http-webhook-pipeline.test.ts` 1 + 面板 4 |
| **改造** | 约 26 | 约 18 | 见 §3 索引表 |
| **新增** | 约 17 | 约 14 | `agent/**`、`skills/catalog.ts`、契约 `skill-mentions.ts`、`migrations/0006_agent.sql`、面板 agent 视图等 |
| **保留不动** | — | — | webhook 投递审计、`tasks/runs/envelopes/actions/run_events`、sandbox/worktree、成本统计、设计令牌与 `components/ui/*` |

### 0.3 切片与依赖

```
S0 退役（含会话状态搬家 + 0006）──┬─→ S1 消息模型与幂等 ──→ S3 权限与串行 ──→ S5 面板
                                   └─→ S2 技能目录化 ─────→ S4 事件模板与投递 ─┘
                              （S6 真环境验收、S7 收尾；D-1/D-2/D-3 三份文档必须在 S1 之前完成）
```

---

## 1. 退役清单（S0，P0）

> v1 漏了 12 处引用，其中 5 处「不补就编译/测试红」。下表已补全。

| # | 对象 | 位置 | 动作 | 删干净判据 |
|---|---|---|---|---|
| 1 | 状态机/阶段 | `apps/server/src/workflows/{pipeline,pipeline-format,pipeline-classify,pipeline-directives}.ts` | 删文件 | `grep -r "pipeline:format\|pipeline:classify\|pipeline:notice" apps/server/src` = 0 |
| 2 | 阶段结果/标签 | `workflows/stage-result.ts`、`workflows/pipeline-labels.ts` | **先搬后删**：`missingEvidenceOf`/`describeMissing`/`REASON_QUOTE_LIMIT`/`MissingEvidence`、`Verdict` 类型 → 新 `workflows/evidence.ts`；`needsInfoLabelOf`/`NEEDS_INFO_*` → 新 `workflows/labels.ts`；其余导出（`labelsOfRole`/`pipelineLabelsFor`/`pipelineLabelPlan`）随文件删除 | 两文件不存在；搬迁符号在新位置有测试 |
| 3 | 阶段提示词 | `apps/server/src/skills/stage-prompts.ts`（`STAGE_PROMPT_KINDS`/`AGENT_PROMPT_DEFAULT`/`PIPELINE_PROMPT_LIMITS`/`GATE_NOTICE_PROMPT`） | 删文件；`ASSEMBLE_STAGE_OF_KIND` 等引用点全清 | `grep -r "stage-prompts\|STAGE_PROMPT" apps/server/src` = 0 |
| 4 | 自动关闭作业 | `jobs/pipeline-close.ts` + `jobs/index.ts`（`JOB_SCHEDULES` 条目、`createJobRunners['pipeline-close']`、`pickPipelineCloseDeps`）+ `jobs/types.ts:26` 的 `'pipeline-close'` 联合成员 | 删 | `grep -r "pipelineClose\|PIPELINE_CLOSE" apps/server/src` = 0；`QUEUE` 7→6，`queue-definitions.test.ts` 同步 |
| 5 | 常量 | `config/pipeline-constants.ts`（含 `JOB_PIPELINE_CLOSE_SCHEDULE`，被 `queue/definitions.ts:257` 引用） | 删；`PIPELINE_CLASSIFY_MAX_MINUTES` 若仍要，搬 `agent/constants.ts` | `grep -r "PIPELINE_" apps/server/src` 只剩新常量 |
| 6 | **持久会话状态（关键）** | `issue_pipeline.session_id/session_cursor/session_turns/session_started_at`（`0005:33-36`，schema `646-731`），被 `runtime/turn-driver.ts:57,188,388`、`worker/run-task.ts:237`、`app/compose.ts:1196` 读写 | **新建 `agent_sessions` 表**（§4），把读写改成它；`planAgentSession` 改读新表 | 会话复用/轮换测试（L-05/D-02）在 `issue_pipeline` 删除后仍通过 |
| 7 | 数据表 | `issue_pipeline` | 0006 `DROP TABLE IF EXISTS` | 表不存在；读路径无 SELECT |
| 8 | Drizzle 定义 | `apps/server/src/db/schema.ts` 的 `issuePipeline` + `ALL_TABLES`/`ALL_TABLE_NAMES` | 删；表数 21→20（含 0006 新增的 2 张 → 22，见 §4） | `db-schema.test.ts` 同步通过 |
| 9 | 契约 | `packages/contract/src/repo-config.ts`（`pipelineConfigSchema`/`PipelineConfig`）、`enums.ts`（`PIPELINE_*`/`PROMPT_KINDS` 的阶段项）、`api.ts`（`issuePipelineSchema`/`IssuePipeline`）、`schemas.ts:17,39,61-62`（注册表）、`index.ts:7`（导出清单注释） | 删；新增 `agentConfigSchema` | `contract test` 通过；openapi 重生成后无 `IssuePipeline`/`RepoPipelineConfig` |
| 10 | 接入层 | `http/webhook.ts` 的闸门与指令分支：`pipelineTransitionFor:1804`、`decideSupplementOutcome:1660`、`noticePlanFor:1758`、`runDirective:1837`、`gateNotice` 引用（`:1306,1745`） | 删 | `grep -r "gateNotice\|/pipeline next" apps/server/src` = 0 |
| 11 | 执行层 | `app/compose.ts`：`PIPELINE_RUNTIME_MODE`、`assembleStageOfCommand`、`enqueueStageTask`、`persistPipelineAfterRun`、`planAgentSession`（轮换阈值见 OQ-5） | 删/改 | `grep -r "pipelineCommand" apps/server/src` = 0 |
| 12 | 查询层 | `queries/issues.ts:234-276`（`pipelineOf` + left join + `pipeline_dwell_seconds`）、`queries/sql.ts:344` 的 `ACTION_INTENTS_SQL` | 删 join；契约 `IssueListItem/IssueSummary.pipeline` 删 | 类型全绿 |
| 13 | HTTP 层 | `http/api/index.ts:203-216`（`pipeline` 响应与路由注释） | 删 | — |
| 14 | 提示词版本线 | `apps/server/src/prompt/store.ts`（`prompt_versions` kind 逻辑）、`apps/server/src/http/api/prompt.ts`（四个 kind 的路由） | 删；`settings.prompt` 改内联 `agent.project_prompt` | `grep -r "kind.*format_check\|PROMPT_KINDS" apps/server/src` = 0 |
| 15 | barrel | `apps/server/src/workflows/index.ts`（`:29-30,47,57,59-113` 的转出口） | 改（删对应 export） | typecheck 绿 |
| 16 | 面板 | `routes/repo-pipeline.tsx`、`components/pipeline/**`（8）、`components/settings/pipeline-section.tsx`、`routes.tsx:18,73` | 删 | `grep -r "repo-pipeline\|pipeline-status\|pipeline-section" apps/panel/src` = 0 |
| 17 | 面板（改写） | `layout/nav.ts`、`routes/issues.tsx`、`components/issues/issue-table.tsx`、`routes/issue-detail.tsx`、`routes/tasks.tsx`、`routes/repo-settings.tsx`、`lib/queries.ts:48`（注释）、`mocks/handlers/{issues,repos,task-detail}.ts` | 改 | 面板 build + 约 178 用例 0 failed |
| 18 | 测试基建 | `apps/server/test/db-schema.test.ts:58-59,72`（21 表断言）、`no-dead-workflows.test.ts:82,84,85,118`（**要求** `workflows/pipeline.ts`/`pipeline-labels.ts`/`stage-result.ts` 必须存在——反向互锁） | 改：删掉「必须存在」的断言，改成「这三个文件必须**不**存在」 | 该测试通过 |
| 19 | 生成物 | `openapi/pi-bot.openapi.json`（`IssuePipeline:1273`、`RepoPipelineConfig:1636`、`pipeline` 属性 2062/3961/4086/5009） | 重新生成 | `grep -c IssuePipeline openapi/pi-bot.openapi.json` = 0 |
| 20 | 文档 | `docs/{plan-fixed-pipeline,impl-fixed-pipeline,test-plan-fixed-pipeline,manual-acceptance}.md` | 首行加 `> 状态：已作废（被 v0.3 取代，见 docs/req-issue-agent.md）`，不删 | 4 个文件首行有标记 |
| 21 | 提示词子系统（v2 补漏） | `apps/server/src/prompt/{store,preview,budget}.ts`、`http/api/prompt.ts`、`packages/contract/src/api.ts` 的 prompt 请求/响应、面板 `components/settings/{prompt-section,prompt-kinds,prompt-layers-preview,use-prompt}.tsx?`、`mocks/handlers/prompt.ts` | 删（`project_prompt` 内联到 `settings.agent`） | `grep -r "prompt_versions\|current_version" apps/server/src packages/contract/src` = 0 |
| 22 | 命令通道残余（v2 补漏） | `apps/server/src/workflows/command-gate.ts`、`apps/server/src/skills/command.ts`（`parseCommand`/`usageMessage`） | 删（v0.3 无「命令」概念，`/名字` 归技能） | `grep -r "checkCommandGate\|parseCommandMention" apps/server/src` = 0 |
| 23 | **内置技能正文（v2 补漏，P0）** | `apps/server/src/skills/builtin.ts` 现在只打包 `review-pr`；`format-check`/`label-triage` **只存在于文档**（`grep -r "format-check" apps/server/src` 零命中） | **新增两份内置技能**（正文 + frontmatter：`name`/`description`），并给出「格式合格」的判据口径（由 `project_prompt` 补充） | 目录里 3 条内置技能、正文非空、`on_opened=format-check` 能真的加载到 |

---

## 2. 逐项开发（按需求章节）

### 2.1 §1.2 消息生命周期

| 步骤 | 改动点 | 面 | 测试 |
|---|---|---|---|
| **幂等范围（关键）** | 永久幂等**只约束人消息**（`issue_comment` 的 @）。事件消息（`opened`/`edited`）用**固定模板**，文本天然相同——若也走永久幂等，同一 issue 第二次编辑会被永久命中，与需求 §1.4「edited 每次都投」直接冲突。事件消息的 key = `sha256(repo, issue, templateId, issue.updated_at)`（更新时刻变化即视为新事件） | 后端 | L-01 / L-02 / L-07 |
| 去重落库 | `agent_messages`（§4）：PK `(repo, issue_number, fingerprint)`，存 `kind('mention'|'event')`、`status`、`comment_id/comment_body`。**不再复用 `tasks.idempotency_key`** | 后端 | L-01 / R-02 |
| 权限拒绝**独立记账** | 新增 `agent_denials`（PK `(repo, issue_number, actor_login)`）：`status='denied'` **不得**参与幂等命中——否则该用户日后被提成管理员，同一句话会永久静默且查不到原因 | 后端 | C-10 / R-01 / X-09 |
| reaction | 新增 `agent/ack.ts::ackReceived/ackDone`，走现有 `feedback/` 的 reaction 写面 | 后端 | L-03 / L-06 / A-01 |
| 扫描技能 + 改写 | 新增契约 `packages/contract/src/skill-mentions.ts::findSkillMentions(text, ids)`（正则 `/(^|\s)\/([^\s]+)/g`，先过 `maskCodeRegions`）+ `agent/message.ts::composeAgentMessage` | 契约 + 后端 | H-01..H-10 / L-04 |
| 同 issue 串行（**v2 修正机制**） | **不能**用 pg-boss 的 `singletonKey` 当排队：本仓 `boss.ts:110-124` 的注释写明「同 key 已在队列就不再入队，`send()` 返回 null」——那样第二条消息会被**丢弃**而不是排队。正确做法：`agent_messages` 本身就是队列（`status='queued' \|\| 'running'`），由一个 dispatcher 按 issue 取**最老的一条**、用 `SELECT … FOR UPDATE SKIP LOCKED` + `singletonKey = issue:${repo}#${n}:${fingerprint}`（每条消息唯一，重复投递才被去重）入队；一条结束后再取该 issue 的下一条 | 后端 | L-05 / D-02 / X-07 |
| 交给 agent | `app/compose.ts::executeTask` 一个 issue 一个**持久会话**：会话状态从新表 `agent_sessions` 读（§4），`session/attach` + `after=cursor` 沿用 `turn-driver.ts` | 后端 | EQ-01 / L-05 |

### 2.2 §1.3 技能命中

| 项 | 改动点 | 面 |
|---|---|---|
| 命中算法 | 契约新纯函数（上表）；`parseTriggerBody` 保留「是否给我的消息」判定，**命令语义删除** | 契约 |
| 未命中 | 不提示、token 保留、当自然语言 | 契约 |

### 2.3 §1.4 事件

| 事件 | 改动点 | 面 |
|---|---|---|
| `issues.opened` | `decideWebhookTask` 产出 `{source:'agent', command:'agent:opened', templateId:'opened', skillIds:[on_opened]}`；**`on_opened` 为空则 0 任务**。注意：正文里的 `@bot` 不产生独立事件（GitHub 行为），只需断言「只投一次」 | 后端 |
| `issues.edited` | 仅 `changes.title \|\| changes.body` 才投；**`reopened` 从 `ISSUE_ACTIONS` 移除**（现在它会产生任务，`webhook.ts:327`） | 后端 |
| `issue_comment.created` | 命中 `@别名` → `agent:mention`，消息=原话（经 skill-mentions 改写）；非管理员 → 权限分支 | 后端 |
| `labeled`/`assigned`/`closed` | 保持白名单外 + 源码级护栏 | 后端 |
| bot / dependabot / renovate | `isBotActor` 已判 `type==='Bot'`，**只差 login 白名单**（`dependabot[bot]`/`renovate[bot]`） | 后端 |
| 永不回填 | 不存在遍历 issue 的初始化路径 + 护栏测试 | 后端 |

### 2.4 §1.5 两种输入

`skills/assemble.ts::assemblePrompt` 现有层参数是 `basePrompt/projectPrompt/agentsMd/skill/budgetChars/stage/stagePrompt/outputContract`：**新增 `catalog`，删除 `skill` 与 `stage/stagePrompt`**；层序变成 `catalog → project_prompt → agentsMd → 输出契约`。

### 2.5 §2 技能链路（v2 修正了三处事实错误）

| 阶段 | 现状（实测） | 改动 |
|---|---|---|
| 内置 3 技能 | 已有 `apps/server/src/skills/builtin.ts`（77 行） | 保留；`skills/` 配置项只控制**项目级目录是否扫描**，内置恒在 |
| 两级扫描 | `skills/registry.ts` 只做解析与注册表，**没有目录扫描** | 新增 `skills/catalog.ts`：扫 `<data>/skills` 与 `<repo>/.github/pi-bot/skills/`，两种形状（`<id>.md`、`<name>/SKILL.md`），每条带 `source` |
| 上限 | 真实常量在 **`skills/zip.ts:56-66::ZIP_LIMITS`**（`maxEntries:200`、`maxFileBytes:512KB`、`maxTotalBytes:5MB`、`maxRatio:100`）；**全仓没有 128 条/128KB** | v0.3 的「128 个技能」是**新增**上限（目录层），单文件沿用 `maxFileBytes`；需求里的「目录型 2MB / 整包 16MB」见 OQ-11 |
| 坏文件 | `frontmatter.ts` 已是「单文件 `ok:false`」，`registry.ts:180-195` 逐文件加载，坏文件只产生一条禁用条目（`skills-registry.test.ts:249` 断言它**仍占面板一行**） | 改为「不进目录」+ warn；面板可见性由 S5 决定 |
| 覆盖 | 现为全局 + 项目分别注入 | 项目同名**整体替换**；同 id 只留扫描顺序第一个 |
| 只注入目录 | `skills/prompt.ts::renderSkillPrompt` 注入**正文**（`assemble.ts` 的 `skill` 层） | 新增 `catalog` 层；删 `skill` 层；正文只在 `Skill(id)` 时进上下文 |
| 按需加载 | **OQ-1**：`runtime/approval-policy.ts` 只有 Read/Glob/Grep/Bash/Write/Edit，无 `Skill`；RACP（`racp-client/src/ops.ts`，18 个操作）也没有工具类操作 | 若宿主提供 → 加 `SKILL_TOOL` 并改 `decideApproval` 的 4 个分支；否则退化为「控制面注入正文」并记偏离 |

### 2.6 §3 配置

新增 `agentConfigSchema`（`.strict()`）：

```jsonc
"agent": {
  "managers": ["login"],                 // 沿用现有 managers
  "on_opened": "format-check",           // 置空 = 不投递
  "on_edited": "format-check",
  "auto_label_after_format_pass": false,
  "project_prompt": ""                   // 取代 prompt.current_version 版本表
}
```

| 现有键 | 处置 |
|---|---|
| `pipeline.*` | 删（`managers` → `agent.managers`） |
| `prompt.{enabled,current_version}` + `prompt_versions` 表 | 删表与路由；改内联 `project_prompt`（OQ-2） |
| `triggers` | 保留 `aliases`；删 `enabled`（P8 的语义在 v0.3 不存在）与 `users`（改由 managers） |
| `commands` | 删（`/名字` 归技能） |
| `labels` | 保留（词表 + role 是 D5 的依据） |
| `create_issue` / `skills` | `create_issue` 删；`skills` 收为布尔「是否扫描项目技能」 |
| `limits` / `enabled` / `dry_run` / `model` | 保留（部署项） |

面板：`components/settings/agent-section.tsx`（managers chips、两个技能下拉 + 「不投递」、自动打标开关、`project_prompt` 多行框）。

### 2.7 §5 硬规则（v2 修正规则 4 的方向）

| 规则 | 改动点 | 注意 |
|---|---|---|
| 1 @ 仅管理员 | 新增 `agent/permission.ts::isManager`；拒绝记 `agent_messages.status='denied' + denied_once=true` | 「只回一次」按 issue 维度 |
| 2 永久幂等 | `agent_messages` + fingerprint；命中直接返回上次 `comment_*` | 与 §1.2「窗口内」冲突，见 OQ-7 |
| 3 一 issue 一 agent 串行 | 新队列 `agent-issue`（§2.1） | 与仓库级并发正交 |
| 4 默认只产出评论 | **现状是反的**：`worker/writeback.ts:491` 对 `intent !== 'comment'` 一律放行。要改成「`source='agent'` 时：comment 允许；label/close/push 仅在信封显式声明时允许（v0.3「必须显式调工具」）」——即**不是**禁止，而是**默认不发生**。同时 `run-task.ts:566`、`webhook.ts:347` 的本地 source 联合类型（连 `cron` 都缺）要统一到 `TaskSourceKind` | 影响 R-04 / C-05 |
| 5 永不回填 | §2.3 末行 | — |

### 2.8 §4 场景的代码支撑

| 场景 | 支撑点 | 备注 |
|---|---|---|
| A7 issue 已不存在 | **新增** `github/` 的读 issue 能力（现在全仓 `getIssue` 零命中）；404 → `runs.failure_detail.reason='issue-gone'`（**字段在 `runs`**，不在 `tasks`） | 新增能力 |
| C7 「把 issue 关了」 | `close_issue` 现在只属执行器（`packages/contract/src/enums.ts:159` 的 `EXECUTOR_ONLY_ACTION_INTENTS`），且执行侧 `github/executor.ts:18,904,950-957` 要求传入由 `decideCloseIssue()` 算出的 `CloseIssueDecision`。放开需改 3 处：契约枚举 + `packages/envelope/src/actions.ts:16,114-116,230` 的第二份副本与 switch + 执行器分支 | 风险最高的一条 |
| C5 一回合多件事 | 信封 `actions[]` 已支持多动作；只需 §2.7 规则 4 的放行 | 与 R-04 同源 |
| D3 执行中被关 | `agent/` 侧在写回前重查 issue 状态（复用 A7 的读能力） | v1 漏了这条 |
| D4 人工标签 | 现有 `workflows/bot-labels.ts` + `label-decisions.ts` 的 veto 台账 | 扩到新通道 |
| D5 词表缺标签 | 组装消息时注入「词表缺 X」；断言不发明标签 | — |
| D6 超时/非法输出 | 沿用现有失败处置，但**不得 blocked 粘性**（下一条必须能跑） | — |
| D7 无 label 权限 | `github/` 写失败 → `failure_class='github-api'` + 一条评论 | — |
| D9 frontmatter 缺 name | 已是单文件丢弃，只需「不进目录」 | 已基本成立 |
| B6 批量打标 | 不存在批量接口；加源码级护栏 | — |

### 2.9 §8 三件事（开发前文档，S1 的输入）

| # | 产出物 | 验收判据 |
|---|---|---|
| D-1 | `docs/retired-pipeline-map.md` | 覆盖 `plan-fixed-pipeline.md` 的 §2 转移表 / §7 门禁 / §8 门禁处置 / §4.3 / §4.5 五节，每节标「作废 / 部分保留（正文快照、会话复用）/ 由 v0.3 §x 取代」 |
| D-2 | `docs/agent-context.md` | 给出首次/后续上下文构成、裁剪顺序（先丢历史 → 再截正文 → 目录不动）、预算数字（正文 4000、历史 20×1000、目录 128、总 12k） |
| D-3 | `docs/agent-message-templates.md` | 5 个模板（opened / edited / mention / permission-denied / failure）各含正文 + 变量表 + 「点不点技能」规则 |

---

## 3. 四个面的索引

### 3.1 后端（产品）

| 类型 | 文件 |
|---|---|
| 新增 | `agent/{canonical-text,fingerprint,message,permission,ack,constants}.ts`、`skills/catalog.ts`、`workflows/{evidence,labels}.ts`（搬迁）、`packages/contract/src/skill-mentions.ts`、`migrations/0006_agent.sql` |
| 改造 | `http/webhook.ts`、`app/{compose,worker-deps}.ts`、`skills/{registry,bundle,frontmatter,prompt,assemble}.ts`、`worker/{writeback,run-task,types}.ts`、`runtime/{approval-policy,turn-driver}.ts`、`queue/{boss,definitions}.ts`、`queries/{issues,sql}.ts`、`db/schema.ts`、`jobs/{index,types}.ts`、`packages/contract/src/{repo-config,trigger,enums,api,schemas,index}.ts`、`packages/envelope/src/actions.ts` |
| 删除 | §1 表 1–17 行涉及的产品文件（约 22） |

### 3.2 前端

| 类型 | 文件 |
|---|---|
| 新增 | `routes/repo-agent.tsx`、`components/settings/agent-section.tsx`、`components/skills/catalog-list.tsx` |
| 改造 | `routes/{issues,issue-detail,tasks,repo-settings,skills}.tsx`、`components/issues/issue-table.tsx`、`layout/nav.ts`、`routes.tsx`、`lib/{api,queries,contract}.ts`、`mocks/handlers/{issues,repos,task-detail,skills}.ts` |
| 删除 | `routes/repo-pipeline.tsx`、`components/pipeline/**`(8)、`components/settings/pipeline-section.tsx` |

### 3.3 后端测试

| 类型 | 文件 |
|---|---|
| 新增 | `agent-canonical-text`、`agent-fingerprint`、`agent-message`、`agent-idempotency`、`agent-serial-queue`、`agent-permission`、`agent-events`、`agent-scenarios-{a,b,c,d}`、`skills-catalog`、`agent-retirement`（各 `.test.ts`）+ `packages/contract/test/skill-mentions.test.ts` |
| 改造 | `http-webhook.test.ts`（**新增** opened/edited —— 它现在没有）、`e2e-envelope-invalid.test.ts`（扩 D-06）、`skills-{registry,store,prompt}.test.ts`、`helpers/{repo-settings,queries-db,e2e-harness}.ts`（**truncate 加 `agent_messages`**、reaction 记账、tool-call 脚本）、`db-schema.test.ts`、`db-migrate.test.ts`、`no-dead-workflows.test.ts`（改为断言三文件**不存在**） |
| 删除 | `pipeline-*.test.ts` **28 个** + `http-webhook-pipeline.test.ts` |

### 3.4 前端测试

| 类型 | 文件 |
|---|---|
| 新增 | `routes/__tests__/repo-agent.test.tsx`、`components/settings/__tests__/agent-section.test.tsx`、`components/skills/__tests__/catalog-list.test.tsx` |
| 改造 | `routes/__tests__/{issues,issue-detail,repo-nav}.test.tsx`、`test/routes.test.tsx`、`routes/__tests__/overview.test.tsx`、`routes/repos/__tests__/repo-settings.test.tsx` |
| 删除 | `routes/__tests__/pipeline.test.tsx`(5)、`components/settings/__tests__/settings-pipeline.test.tsx`(14)、`components/pipeline/__tests__/pipeline-view.test.tsx`(11)、`components/issues/__tests__/pipeline-columns.test.tsx`(2) |

---

## 4. 数据与迁移（`migrations/0006_agent.sql`）

```sql
-- 0. 会话状态的新家（v1 的致命缺口：它原本住在 issue_pipeline 里）
CREATE TABLE IF NOT EXISTS "agent_sessions" (
  "repo" text NOT NULL,
  "issue_number" integer NOT NULL,
  "session_id" text,
  "cursor" integer NOT NULL DEFAULT 0,
  "turns" integer NOT NULL DEFAULT 0,
  "started_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("repo", "issue_number")
);

-- 1. 消息级永久幂等（§5 规则 2）
CREATE TABLE IF NOT EXISTS "agent_messages" (
  "repo" text NOT NULL,
  "issue_number" integer NOT NULL,
  "fingerprint" text NOT NULL,
  "kind" text NOT NULL DEFAULT 'mention',  -- mention（人消息，永久幂等）| event（模板消息，key 含 updated_at）
  "status" text NOT NULL DEFAULT 'queued', -- queued|running|done|failed
  "comment_id" bigint,
  "comment_body" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("repo", "issue_number", "fingerprint")
);
-- 队列取件索引（dispatcher 按 issue 取最老一条）
CREATE INDEX IF NOT EXISTS "agent_messages_queue_idx" ON "agent_messages" ("repo","issue_number","status","created_at");

-- 1b. 权限拒绝（独立记账：不参与幂等命中、按 actor 区分）
CREATE TABLE IF NOT EXISTS "agent_denials" (
  "repo" text NOT NULL,
  "issue_number" integer NOT NULL,
  "actor_login" text NOT NULL,
  "replied_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("repo","issue_number","actor_login")
);

-- 2. 会话状态迁移（保留已有 issue 的对话连续性；开发态可接受为空）
INSERT INTO "agent_sessions" ("repo","issue_number","session_id","cursor","turns","started_at")
SELECT "repo","issue_number","session_id","session_cursor","session_turns","session_started_at"
FROM "issue_pipeline" WHERE "session_id" IS NOT NULL
ON CONFLICT DO NOTHING;

-- 3. 退役
DROP TABLE IF EXISTS "issue_pipeline";
DROP TABLE IF EXISTS "prompt_versions";   -- OQ-2：project_prompt 内联后不再需要

-- 4. settings 收窄（冒烟版，实际按 §2.6 映射逐段处理）
--    pipeline.managers → agent.managers；删 pipeline/commands/create_issue/prompt；
--    labels、triggers.aliases、enabled/dry_run/model/limits 保留。
```

要求：全部 `IF NOT EXISTS`/`IF EXISTS`；重复执行零副作用；文件头写回滚注释（从 `0005_pipeline.sql:18-48` 复制 `issue_pipeline` DDL，`:51,53,57` 三列保留说明）。

---

## 5. 切片与验收

| 片 | 范围 | 验收 | 依赖 |
|---|---|---|---|
| **S0 退役** | §1 全部（含新增的 21–23 行：prompt 子系统、命令通道残余、内置技能正文）+ 0006（含 `agent_sessions` 搬家 + `agent_denials`）+ 面板**只做删文件与改 mocks 到能编译** | typecheck 绿；lint 0 error；`grep` 判据全 0；T-01..T-08 通过；面板 build；**测试 0 failed（S0 不判用例数量）**；会话复用用例在 `issue_pipeline` 删除后仍通过 | D-1 |
| **S1 消息模型** | `agent_messages`、fingerprint、`composeAgentMessage`、webhook 投递「消息」 | L-01/L-02/L-04、E-01..E-10、B-01 | S0 + D-2/D-3 |
| **S2 技能目录化** | `skills/catalog.ts`、两级扫描、上限/覆盖、`assemblePrompt` 去 `skill` 层 | S-01..S-10、H-10、EQ-01 | S0 + OQ-1 |
| **S3 权限与串行** | `agent/permission.ts`、新队列 `agent-issue` | C-10、L-05、D-02、X-07、X-09 | S1 |
| **S4 事件模板** | 5 模板接入；`on_opened`/`on_edited`/自动打标 | A-01..A-08、B-02..B-06、C-01..C-11 | S1 + S2 |
| **S5 面板** | agent 视图、设置 agent 分区、技能目录页 | P 层通过；面板约 178 用例 0 failed；build；`grep transition-all` = 0 | S1..S4 定型 |
| **S6 真环境** | v0.3 版手动清单（3 issue + 2 对话） | 4 条 M 全过 | S5 |
| **S7 收尾** | 作废文档标记、`docs/impl-issue-agent.md`、openapi 重生成 | 全绿 + 文档齐 | 全部 |

---

## 6. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| **OQ-1 `Skill` 工具缺失** | 按需加载不成立 | S2 前必须定；退化方案与偏离记录进 `docs/agent-context.md` |
| **删 `issue_pipeline` 顺手删掉会话状态** | 阶段 2 的对话连续性全丢（v1 计划就踩这个） | S0 先建 `agent_sessions` 并迁移（§4）；验收里加会话复用回归 |
| 退役范围大（22 产品 + 29 测试文件，229 个 `it()`） | 主干长时间红 | S0 一次做完 + 当天全绿；`no-dead-workflows` 的反向断言**先**改成「必须不存在」 |
| `close_issue` 放开（3 处改动 + `CloseIssueDecision` 前置） | 误关 / 执行器无分支可走 | 独立小片；只允许管理员消息；保留审计；先做「拒绝执行 + 提示」再放开 |
| 永久幂等 vs 「窗口内」（需求自相矛盾） | 用户以为没跑 | 命中时回一条说明；OQ-7 定口径 |
| 串行队列改错会破坏任务取消 | 取消/重投失效 | 新开 `agent-issue` 队列，不动 `run-task` 的 `singletonKey=taskId` |
| 面板删改（4 文件 32 条 → 178 基线） | 面板测试红 | 删文件与断言同片；先改 mocks |
| `repo-settings.ts` 夹具被 29 个文件导入 | 改形状会连环红 | S0 里一次性改形状并跑全量 |

---

## 7. 待用户确认（开发前必须回答）

| # | 问题 | 影响面 |
|---|---|---|
| **OQ-1** | pi-host 是否提供 `Skill(id)`？ | S2 路线 + 5 条用例 |
| **OQ-2** | 配置破坏性迁移是否接受（`pipeline/commands/create_issue/prompt` 删、`prompt_versions` 表删、`project_prompt` 内联）？ | 0006 + 面板 |
| **OQ-3** | `review-pr` 是否并入技能通道？现有 PR 审查通道保留否？ | `commands` 删除范围 |
| **OQ-4** | agent 通道是否允许信封声明 `label` / `close_issue`？（「默认只出评论」= 默认不发生，还是禁止） | 规则 4 / C-05 / C-07 |
| **OQ-5** | 会话沿用 `persistent`？30 轮/7 天轮换是否保留？ | `planAgentSession` 去留 + `agent_sessions` 字段 |
| **OQ-6** | reaction 语义：加 eyes → 处理完移除？还是「只留一个」？ | L-03/L-06/A-01 |
| **OQ-7** | 幂等：永久（本计划按此实现）还是「窗口内」？ | `agent_messages` 清理策略 |
| **OQ-8** | `auto_label_after_format_pass` 触发的消息是否也受永久幂等？ | CF-04 |
| **OQ-9** | 「管理员」= 仅 `managers` 名单，还是含作者/协作者？ | 权限实现 |
| **OQ-10** | 归一化是否含「转小写」？代码块内不命中？目录描述截断 200 字符？ | 命中算法 |
| **OQ-11** | 需求 §2.2 的「目录型 2MB / 整包 16MB」与「增量 section」本版保留否？ | 扫描实现 |
| **OQ-12** | 事件消息是否**豁免**永久幂等？（本计划按「豁免，key 含 `issue.updated_at`」实现；若不豁免，同一 issue 第二次编辑会被永久吞掉） | L-07 / P-03 / §2.1 |
| **OQ-13** | PR 维度：`review-pr` 走技能通道后，PR 的串行键、容器与 `bot/*` 分支权限、「一个 issue 一个 agent」在 PR 上映射成什么？ | 12 条既有 PR 用例 + C-05/R-03 |
| **OQ-14** | 上下文超预算时**先丢历史还是先截正文**？（D-2 现在单方面选了「先丢历史」） | `docs/agent-context.md` + S2 |

---

## 8. 执行顺序（一句话）

**先答 OQ-1/OQ-2/OQ-4（它们决定 S2 与规则 4 能不能写），再写 D-1/D-2/D-3，然后 S0 一次性退役（含 `agent_sessions` 搬家 + 0006）并当天全绿，再 S1→S4 补功能、S5 改面板、S6 真环境验收。**
「先做技能、后删流水线」会让两套语义并存，测试无法判定哪套为准。
