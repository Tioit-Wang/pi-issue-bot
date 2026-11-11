# 固定流水线 · 验收测试目录与覆盖审计

> 状态：流水线 S0–S5 **已实现并全绿**（实现记录见 `docs/impl-fixed-pipeline.md`）。
> 本文不是「将来怎么测」，而是**当前基线下的可执行验收目录 + 缺口账**：把 `docs/plan-fixed-pipeline.md` §12 的 V1–V20 逐条落到真实存在的用例上，并标出「实现已做但没测」「规格要求但实现/测试都没有」。
> 规格口径以 `plan-fixed-pipeline.md` §2 / §5 / §6 / §7 / §8 / §9 / §11 / §12 / §16.1–§16.3 为准；偏差以 `impl-fixed-pipeline.md` §7 的 8 处为准。
> 本文只做用例设计，不含任何代码改动；所有断言均可在现有测试框架（vitest + 真 PG + 假 GitHub/RACP）里直接落地。

---

## 1. 总览

### 1.1 用例规模

| 项 | 数值 |
|---|---|
| 登记用例总数 | **355**（2026-11-12：339 + 本轮 P1-4 行为面 10 条 + P2-3 的 HTTP 层 6 条） |
| 涉及测试文件 | **28**（27 + `http-webhook-triggers-disabled`；另加 `packages/contract/test/config.test.ts` 一个文件里只登记 10/25 条） |
| 未登记但同文件的无关用例 | 15（`contract/test/config.test.ts` 里的技能 frontmatter / 配额 / 版本号等，与本改造无关） |
| 基线（`impl-fixed-pipeline.md` §8） | server 105 文件 / 1281 通过 / 2 skipped；panel 223；contract 81；envelope 33；shared 30；racp-client 87。**复核（2026-11-11，§6 的 12 条补测落地后实测）：server 115 文件 / 1324 通过 / 2 skipped**（相对上一轮 112 文件 / 1312 通过：+3 文件、+12 条；其余 4 个文件 / 8 条来自 P0/P1 那批回归用例）。**复核（2026-11-12，本轮 P1-4 + P2-3 落地后实测）：server 116 文件 / 1340 通过 / 2 skipped**（相对上一轮 +1 文件、+16 条） |

### 1.2 按切片分布

| 切片 | 范围 | 文件数 | 登记用例数 |
|---|---|---|---|
| S0 数据与契约 | `issue_pipeline` 列/迁移、`repos.settings` 严格化、4 类 prompt kind、常量、`jobs/` 注册 | 4 | **56** |
| S1 状态机与门禁 | 转移表、`issue_pipeline` 读写、webhook 三分支、`@` 闸门（`pipeline:notice`）、评论优先、幂等锚形状、`auto:triage` 源码断言、`triggers.enabled` 的提及类触发开关 | 6 | **81** |
| S2 阶段 0 | light 运行时、pass/fail/重检三路径、`stage-result` 校验、5 次不通过、48h 关闭作业 | 5 | **49** |
| S3 阶段 1 | 四分支、`path:line` 降级、`@` 单槽、按 role 打标、`normalizeDesired`、`pipeline:classify` 跑 sandboxed | 3 | **27** |
| S4 阶段 2 | `agent` 阶段提示词、会话复用/轮换、层序与预算、四版本线集成 | 7 | **87** |
| S5 面板 | 流水线页、issue 列表四列、设置页流水线分区、提示词四 tab、层序预览、提示词路由的 HTTP 层（400 与 `kind` 隔离） | 6 | **55** |
| 合计 | | **28（+1 部分）** | **355** |

### 1.3 覆盖判定口径

| 判定 | 定义（必须同时满足） |
|---|---|
| **已覆盖** | ① 存在至少一条真实用例（能 grep 到 `it(...)` 名字）；② 该用例断言到**次数**（调用几次 / 产生几行 / 几个任务）或**具体字段值**（`issue_pipeline.state`、`info_requested_at`、`session_turns` 等），而不是「不抛错」；③ 判据里出现的**每一条**分句都有对应断言。 |
| **部分** | 判据的某条分句**没有任何断言**，或只有纯函数层断言而**接线层（`compose.ts` / `webhook.ts` 真实入口）无断言**。缺什么写进 V 表最后一列。 |
| **缺失** | 判据对应不到任何用例（含「只有手测记录」）。 |

> 反例口径：`expect(report.outcome).toBe('succeeded')` 这种**不算**覆盖；`expect(api.comments).toHaveLength(1)` / `expect(row?.state).toBe('blocked')` 才算。

### 1.4 §3 用到的文件短名

| 短名 | 路径 |
|---|---|
| CONFIG | `packages/contract/test/config.test.ts` |
| REPOCFG | `apps/server/test/config-repo-config.test.ts` |
| CONST | `apps/server/test/pipeline-constants.test.ts` |
| JOBS | `apps/server/test/jobs-index.test.ts` |
| SM | `apps/server/test/pipeline-state-machine.test.ts` |
| DIR | `apps/server/test/pipeline-directives.test.ts` |
| WH | `apps/server/test/http-webhook-pipeline.test.ts` |
| FP | `apps/server/test/pipeline-format-paths.test.ts` |
| FE | `apps/server/test/pipeline-format-exec.test.ts` |
| LIGHT | `apps/server/test/pipeline-light-runtime.test.ts` |
| SR | `apps/server/test/pipeline-stage-result.test.ts` |
| CLOSE | `apps/server/test/pipeline-close-job.test.ts` |
| CP | `apps/server/test/pipeline-classify-paths.test.ts` |
| LAB | `apps/server/test/pipeline-labels.test.ts` |
| SES | `apps/server/test/pipeline-agent-session.test.ts` |
| AP | `apps/server/test/pipeline-agent-prompt.test.ts` |
| SP | `apps/server/test/pipeline-stage-prompt.test.ts` |
| MODE | `apps/server/test/pipeline-session-mode.test.ts` |
| ASM | `apps/server/test/skills-stage-assemble.test.ts` |
| STP | `apps/server/test/skills-stage-prompts.test.ts` |
| PK | `apps/server/test/prompt-kinds.test.ts` |
| P-PAGE | `apps/panel/src/routes/__tests__/pipeline.test.tsx` |
| P-VIEW | `apps/panel/src/components/pipeline/__tests__/pipeline-view.test.tsx` |
| P-SET | `apps/panel/src/components/settings/__tests__/settings-pipeline.test.tsx` |
| P-USE | `apps/panel/src/components/settings/__tests__/use-prompt.test.tsx` |
| P-API | `apps/panel/src/lib/api-prompt.test.ts` |
| P-COL | `apps/panel/src/components/issues/__tests__/pipeline-columns.test.tsx` |
| HS | `apps/server/test/http-server.test.ts` |
| WH-TD | `apps/server/test/http-webhook-triggers-disabled.test.ts` |

---

## 2. V1–V20 映射表

统计：**已覆盖 13 / 部分 7 / 缺失 1**（共 21 条，含 V4b）。2026-11-12：V10、V11 由「部分」改「已覆盖」（依据见各自行的补记：`triggers.enabled=false` 的提及类触发行为已有 10 条投递用例，提示词路由的 400 映射与 `?kind=` 隔离已有 6 条 `app.inject`）。

| V 编号 | 验收摘要 | 判定用例（文件::用例名） | 覆盖状态 | 缺什么 |
|---|---|---|---|---|
| V1 | 新 issue 触发阶段 0；`command=pipeline:format`、`source=pipeline`、`format/pending`、容器 0 次 | `WH::issues.opened → pipeline:format 任务 + format/pending 行 + 正文快照`；`LIGHT::一次成功：只有 host + turn，四步序列，容器与 worktree 都没被碰过` | 已覆盖 | — |
| V2 | 首次 pass 零评论 + `rocket` + 分类已入队 | `FE::零评论、只有 rocket、状态推进到 classify/pending`；`FP::没有任何评论动作，只有 rocket + 推进分类`（`shape=['reaction:rocket']`、`effects.enqueue='pipeline:classify'`） | 已覆盖 | — |
| V3 | fail 恰好一条评论 + `awaiting_info`；同版本重投不新增 | `FE::一条评论 + needs-info 标签 + confused；info_requested_at 落库`；`FE::同版本重投：第二轮进 noop，不再发第二条评论`；`FP::评论 / 标签 / reaction / 状态一次给全` | 已覆盖 | — |
| V4 | 补信息重跑（锚含 commentId）+ pass 后恰一条确认评论 | `WH::format/awaiting_info + 作者普通评论 → 立即重跑，锚含 commentId，state 回 pending`；`FP::模型写了确认评论：用它，且标记 model`、`FP::模型没写：控制面兜底句 + warn + note` | 已覆盖 | 判据的两段分处两个用例，「评论触发 → 新任务跑出 pass → 恰好 1 条确认评论」没有一条端到端串起的用例（见 §6 P1-2） |
| V4b | 评论优先：立即触发、补充置顶、其后 120s 内编辑不再触发、反向仍立即触发 | `WH::format/awaiting_info + 作者普通评论 → 立即重跑…`；`WH::评论触发后的 120s 内，issues.edited 让位`；`SP::补充评论置顶在正文之前（评论优先，E4）`；`STP::补充评论段置顶、只取最近 3 条、按新→旧` | 部分 | **反向（先 `issues.edited` 后 120s 内评论仍立即触发）无用例**；`pipelineTransitionFor()`（冷却实现点，`webhook.ts:1713-1727`）没有直接用例 |
| V5 | requirement：role=requirement 标签 + 1 条评论含 `/cc @managers` | `CP::打 role=requirement 标签 + 1 条评论（含 /cc @managers）+ 状态推进到 agent/ready`（`labels=[['需求']]`、`comments.length=1`） | 已覆盖 | — |
| V6 | 缺陷三态 + not-found 等管理员（作者不推进、managers 推进、`/pipeline next` 推进） | `CP::有 path:line 证据：打 role=defect 标签 + 评论 + @ + 直接 ready`；`CP::没有 path:line → 降级 not-found：不打缺陷标签、停在 classify/awaiting_info、仍然 @managers`；`CP::无标签 + 1 条评论…+ @；停在等管理员`；`CP::作者（非 managers）的评论 → 只记录，不重跑`；`CP::managers 的评论 → 重跑分类…`；`CP::/pipeline next（managers）→ 直接 agent/ready` | 已覆盖 | — |
| V7 | other：只打标签、0 评论、0 `@` | `CP::只打 role=other 标签：0 条评论、0 个 @、直接 ready`（`mentionSentAt` 仍为 NULL） | 已覆盖 | — |
| V8 | 门禁：被拦命令不建任务、只产 `pipeline:notice`、回 1 条 AI 评论、每小时限速 | `WH::format/awaiting_info → 命令被拦，只产 pipeline:notice（不建命令任务）`；`WH::同一小时内的第二条 @ 只打 eyes（回执限速）`；`WH::format/running → 只打 eyes，零任务`；`WH::blocked → notice`；`WH::closed → 静默`；`WH::PR 完全不受闸门影响` | 部分 | **「回执恰好 1 条 AI 评论」只在提示词/渲染层有断言**（`SP::buildNoticePrompt 从 prompt_text 取 gate_state`、`STP::把 {{gate_state}} 插进模板`），没有「跑一条 `pipeline:notice` 任务 → `createIssueComment` 1 次」的执行面用例；`classify/awaiting_info` 那一行的门禁分支无用例（只有 `blocked` / `format/awaiting_info` / `running`） |
| V9 | 作用域：阶段 0/1 grep 不到 P1 与技能层，但 grep 到 AGENTS.md 与阶段系统提示词；阶段 2 四层齐 | `SP::stage=format：有 AGENTS.md，没有 P1、没有技能层`；`AP::含 AGENTS.md，不含 P1 与技能层（Q9 / V9）`；`AP::四层齐全：agent 阶段提示词 + P1 + AGENTS.md + 技能层，契约仍在最后`；`ASM::层序：阶段系统提示词 → AGENTS.md → 输出契约` | 已覆盖 | — |
| V10 | 全量切换/不可绕过：无 `pipeline.enabled`；`triggers.enabled=false`、`commands.enabled=false`、`repos.enabled=true` 组合下三段照跑；全仓 grep 不到 `auto:triage` 任务 | `CONFIG::pipeline 段没有 enabled、没有任何流程阈值`（`pipeline.enabled` 被拒）；`CONFIG::未知键被拒…pipeline.enabled`；`WH::commands.enabled=false 不影响流水线`；`WH::V10 不可绕过：triggers.enabled=false 不影响流水线（P1-4）`；`WH-TD::triggers.enabled=false：流水线照跑（P8 的前半句，V10 不可绕过）`；`no-auto-triage.test.ts` 三条（扫到源码 / 扫描面 / 零命中） | 已覆盖 | **2026-11-12 补齐**（原缺 `triggers.enabled=false` 的投递用例 + `auto:triage` 源码断言）。行为面新增 10 条（`WH-TD`）：`enabled=false` 时 `@bot /命令`（issue 与 PR）与 `@bot 提问` **0 条任务**、投递仍落 1 行、不打回执；同一开关下 `issues.opened`、`format/awaiting_info` 作者补充评论、`classify/awaiting_info` managers 评论**照常**产 `pipeline:format` / `pipeline:classify`。**口径取舍**：管理员指令（`/recheck`、`/pipeline next|prev`）按 P8「只关提及类触发、流水线走独立分支」的读法**不**受该开关约束（`webhook.ts` 的 `triggersEnabled` 注释写明）；若要一并关掉须单独定口径 |
| V11 | 占位符：`format_check` 缺 `{{title}}`/`{{body}}` → 400；未知占位符 400 并列出名字 | `STP::format_check 缺 {{title}} / {{body}} → ok=false 并列出缺的名字`；`STP::未知占位符 → ok=false 并列出名字`；`PK::未知占位符 / 缺 title·body / 超上限：拒写且一行不留`；`PK::body-too-long` 断言（`tooLong.code`）；`HS::PUT ?kind=format_check 缺 {{body}} / 缺 {{title}} → 400 placeholder-missing，并列出缺失名字`；`HS::PUT ?kind=classify 正文含未知占位符 {{nope}} → 400 placeholder-unknown，并列出名字`；`HS::PUT ?kind=agent 正文超过 4000 字符 → 400 body-too-long` | 已覆盖 | **2026-11-12 补齐 HTTP 层**（P2-3，`HS` 6 条 inject）：路由→400 的映射（`error.details.code` + 占位符名字）、`?kind=` 的枚举 400 与四条版本线互不串味、`restore` 回内置默认都在路由层断言；`placeholder-missing` 那条顺带断言「校验不过一行都不写」（`prompt_versions` 0 行） |
| V12 | 关闭：注入 `PIPELINE_CLOSE_AFTER_HOURS=0.01` 到点关；注入 `PIPELINE_FORMAT_MAX_FAILS=2` 第 2 次关；`close_after_hours`/`max_runs_per_stage` 被 `.strict()` 拒收 | `CLOSE::format/awaiting_info 超时：关一次 + 状态落 closed + closed_at 有值`；`CLOSE::反例一：classify/awaiting_info（info_requested_at 为 NULL）不动`；`FP::注入 formatMaxFails=2：第 2 次不通过就关`；`FE::注入 formatMaxFails=2：第 2 次不通过就关`；`CONFIG::pipeline 段没有 enabled、没有任何流程阈值` | 已覆盖 | — |
| V13 | 连续两次 `@`：`session_id` 不变、`session_turns +2`、archive 0 次、`after=cursor`；阶段 0/1/2 的 `session_id` 两两不同 | `SES::session_id 不变、session_turns +2、session/archive 0 次、订阅用 cursor 当 after`（真 `createApplication().executeTask()`，`attach=[OLD,OLD]`、`archive=0`、`after=[3,4]`、`turns=6`）；`SES::pipeline:format（light + ephemeral）：跑完 session_id 仍是 NULL` | 部分 | **`classify` 阶段跑完 `session_id` 仍为 NULL 无用例**（判据要求三段两两不同，现在只钉住 0 与 2）；`session_turns` 轮换后从 1 起虽有用例，但「三段 `session_id` 两两不同」需要一条把三段都跑一遍的用例 |
| V14 | 真实环境：不合格 issue 收到评论、补充后通过、需求 issue 能点到人 | 无（`doctor-real.test.ts` 只验配置/连通性） | **缺失** | 需要一条**人工验收脚本**（脚本化 drop-in 到 `docs/`，不进 `pnpm test`）：在 `Tioit-Wang/pi-issue-bot-test` 上投 3 个 issue（不合规 / 合规 / 缺陷），核对评论数、`/cc` 命中、`issue_pipeline` 行；当前只有 `impl-fixed-pipeline.md` §8 的配置校验记录 |
| V15 | 4 条提示词版本线 + 整体覆盖：互相独立、`version=0` 回落、保存项目版后不含默认模板 40 字符片段、恢复默认指针回 0、`project` 与 `agent` 阶段 2 同时出现 | `PK::四个 kind 各自独立取号`、`PK::指针各去各的地方`、`PK::回滚按 kind 独立`、`PK::恢复默认：指针回 0、历史仍在`、`PK::version=0：阶段 kind 用内置默认，project 不注入`；`ASM::项目版整体覆盖：最终 prompt 里找不到默认模板的任何 40 字符片段`；`AP::四层齐全…` | 已覆盖 | — |
| V16 | 输出契约不可配：改成「不要输出 JSON」后末尾仍有契约，且信封校验仍生效 | `AP::改坏 agent 提示词也不影响输出契约（V16）`；`ASM::项目把 agent 提示词写成「不要输出 JSON」，契约仍然在最后` | 部分 | **「信封校验仍生效」没有与前面同一条用例关联**：`SR` / `LIGHT` 的信封校验用例用的是默认提示词，没有一条「项目版 `agent` 提示词 + 坏信封 → `blocked`/`valid=false`」 |
| V17 | 配置无兼容承诺：旧形状解析失败；`.strict()` 拒收已删键；迁移后存量是新形状；缺 role / managers 空 → 400 | `CONFIG::空对象不再合法：pipeline.managers 非空是运行前提`；`CONFIG::未知键被拒…compliance / triggers.faces / pipeline.enabled`；`CONFIG::标签 role 必填…`；`REPOCFG::updateRepoSettings：非法配置不写库（库里保持 last-known-good）`；`REPOCFG::last-known-good：库里的 jsonb 被手改成非法 → settings=null 且标为不可用`；`CONST::Q4 重置覆盖四个已废弃键、managers 播种、缺 role 的词条丢弃` | 部分 | **「0005 迁移跑完后存量 `settings` 全部过 `repoSettingsSchema`」没有执行面用例**——现在只断言迁移 SQL 的**文本**（`CONST` 里 4 条），没有「跑迁移 → `select settings` → `parseRepoSettings` 全绿 + 被丢空的仓库 `settings_valid=false`」；HTTP 层 `PUT /settings` 的 400 映射也无 inject 用例 |
| V18 | 预算不挤掉 P1：`agent` 4000 时 `available ≥ 2000`；层序预览有各层字符数；`truncated` 里不出现 `base`/输出契约 | `ASM::agent 存满 4000 时 P1 还能存 2000 以上`；`ASM::available 随 agent 长度变化`；`ASM::运行期统计里 agent 落在 baseChars`；`ASM::超预算时只丢可丢层：truncated 里不出现 base / 输出契约`；`ASM::head / tail 恒为 droppable:false`；`P-SET::agent tab 显示它对 P1 预算的影响（V18）` | 已覆盖 | — |
| V19 | 格式 5 次不通过自动关：注入 `=2` → `closeIssue` 恰好 1 次、`closed_at` 落库、不再有新任务；通过不计数 | `FP::第 5 次（默认上限）不通过：评论 + closeIssue，且不再打标/打 reaction/入队`；`FP::到第 5 次也不另发关闭评论：评论恰好 1 条`；`FE::第 5 次不通过：closeIssue 恰好 1 次、状态 closed、closed_at 落库`；`FE::注入 formatMaxFails=2：第 2 次不通过就关`；`FP::通过不增加 format_fail_count，只把 attempts +1` | 已覆盖 | — |
| V20 | 管理员进/退：`format/awaiting_info`+next→`classify/pending`；`classify/awaiting_info`+next→`agent/ready`；`agent/ready`+prev→重新分类；非 managers 被拒；每次有审计 | `SM::/pipeline next：format→classify、classify→ready、agent → 没有下一步`；`SM::/pipeline next 的 blocked 等价解禁；非 managers 被拒`；`SM::/pipeline prev：agent→classify（清旧结论）、classify→format…`；`DIR::managers 的 /pipeline next（format → classify）→ 状态推进 + 建分类任务`；`DIR::非 managers 的 /recheck → ignored（不执行、不建任务）`；`DIR::commands.enabled=false 也不影响指令` | 部分 | **「审计记录」只断言了 `tasks` 1 行**；`webhook_deliveries` 的投递行与 `directive=…` 日志没有断言（`webhook.ts:1743` 的审计口径未测）；`/recheck`（非 `--force`）在 `blocked` 下不改 `blocked_reason` 只有纯函数断言，没有真库用例 |

---

## 3. 按切片分章的用例目录

列口径：

- **前置状态**：`issue_pipeline` 行（repo / issue / stage / state 及其它列）+ 仓库配置 + 信封；
- **注入 / 假实现**：注入的常量（`createPipelineLimits({...})`）与假对象（假 GitHub 写面、假 RACP、假 host）；
- **输入**：投递的 webhook 载荷 / 纯函数入参 / 任务行；
- **断言**：精确到次数与字段。

标 `(缺失)` 的行是「设计上应该有、但仓库里 grep 不到」的用例，第 6 章编号引用（P0-x / P1-x / P2-x）。

### 3.1 S0 数据与契约（56）

| ID | 文件::用例名 | 前置状态 | 注入 / 假实现 | 输入 | 断言 |
|---|---|---|---|---|---|
| S0-C01 | `CONFIG::合法配置的缺省值（含 version、dry-run、并发、队列等待、提示词版本、流水线段）` | — | 无（纯 schema） | `{pipeline:{managers:['alice']}}` | `settings.pipeline` 深等于 `{managers:['alice'], format_prompt_version:0, classify_prompt_version:0, agent_prompt_version:0}`；`version===1`、`prompt.current_version===0`、`triggers.enabled===true` |
| S0-C02 | `CONFIG::空对象不再合法：pipeline.managers 非空是运行前提（Q4，不做兼容）` | — | 无 | `{}`、`{pipeline:{managers:[]}}`、`{pipeline:{}}` | 三者 `success===false`；错误 `issues` 里有 `path==='pipeline.managers'` |
| S0-C03 | `CONFIG::DEFAULT_REPO_SETTINGS = 形状默认值（managers 为空）：不是合法运行配置` | — | 无 | `DEFAULT_REPO_SETTINGS` | `pipeline.managers` 为 `[]`；严格 schema 上 `success===false`；补 `managers:['alice']` 后 `true` |
| S0-C04 | `CONFIG::managers：login 形状、上限 20、大小写不敏感去重` | — | 无 | 5 组 managers | `['alice','bob-2']`→true；`['@alice']`/`['']`/`['alice','Alice']`/21 个→false |
| S0-C05 | `CONFIG::pipeline 段没有 enabled、没有任何流程阈值（Q2：收为系统常量）` | — | 无 | `pipeline.enabled / close_after_hours / max_runs_per_stage / format_prompt_version:-1 / agent_prompt_version:7` | 前四个 `false`（被 `.strict()` 拒），`agent_prompt_version:7` 为 `true`；`pipelineConfigSchema.parse({}).managers===[]` |
| S0-C06 | `CONFIG::标签 role 必填，且只接受 requirement / defect / other（Q4 不做回填）` | — | 无 | `vocabulary:[{name:'bug'}]` / `role:'not-found'` / 多一个 `bogus` 键 | 缺 role 时 `success===false` 且 `path==='labels.vocabulary.0.role'`；非法 role 与多余键均 `false` |
| S0-C07 | `CONFIG::词表内重复 name 被拒（大小写不敏感…）` | — | 无 | 两条同名 / `bug` vs `Bug` / 两条不同名 | 前两组 `false`，第三组 `true` |
| S0-C08 | `CONFIG::pipelineLabelCoverage：缺角色只提示不报错（相对 §4.5 的有意放宽）` | — | 无 | 只含 `requirement` 的词表 / `DEFAULT_REPO_SETTINGS` / 含两 role | `missingRoles` 分别 `['defect']`、`['requirement','defect']`、`[]`；且只含 requirement 时解析**仍成功** |
| S0-C09 | `CONFIG::完整配置可以解析（标签词表 / 1:N 映射 / 提示词 / 并发 / 流水线）` | — | 无 | 全字段 settings | `pipeline.agent_prompt_version===4`、`vocabulary[0].role==='defect'`、`labels.map['needsInfo']` 为 2 元素数组 |
| S0-C10 | `CONFIG::未知键被拒（配置写错不能静默忽略）：compliance / triggers.faces / pipeline.enabled` | — | 无 | 三个已删键各一份配置 | 三次 `success===false` |
| S0-R01 | `REPOCFG::未设置 → 契约默认值（不复制第二份默认值）` | 无 env | `PI_BOT_DEFAULT_SETTINGS` 未设 | — | 返回值深等于契约默认值 |
| S0-R02 | `REPOCFG::内联 JSON：在默认值上覆写（未写的键仍有默认值）` | 无 | env 内联 JSON | — | 覆写键生效，未写键仍是默认值 |
| S0-R03 | `REPOCFG::文件路径：读文件后按 JSON 解析（相对路径按 cwd 解析）` | 临时文件 | env 指向文件 | — | 解析结果与文件内容一致 |
| S0-R04 | `REPOCFG::解析失败要抛明确错误（不静默降级成默认值）` | 无 | 坏 JSON | — | 抛错（不是返回默认值） |
| S0-R05 | `REPOCFG::defaultRepoSettings() 走缓存，reset 后重新解析 env` | 缓存已填 | 改 env 后 reset | — | 改 env 前返回值不变；reset 后读到新值 |
| S0-R06 | `REPOCFG::合法 → ok；非法 → issues 带字段路径` | 无 | 无 | `validateRepoSettings`（合法 / 缺 managers） | 合法 `ok===true`；非法 `ok===false` 且 issues 路径指向 `pipeline.managers` |
| S0-R07 | `REPOCFG::upsertRepo：用部署默认 settings seed 一行（source=manual）` | 空 `repos` | 无 | `upsertRepo` | `repos` 1 行、`source='manual'`、`settings` 非空 |
| S0-R08 | `REPOCFG::upsertRepo：重复调用幂等，且不覆盖面板改过的 settings` | 已有 1 行（面板改过） | 无 | 再调 `upsertRepo` | 行数仍 1、`settings` 与改过后一致（未被 seed 覆盖） |
| S0-R09 | `REPOCFG::upsertRepo：安装来源可以显式建一个「关着 + dry-run」的行` | 空 | 无 | `source='installation'` | `enabled===false`、`dry_run===true` |
| S0-R10 | `REPOCFG::updateRepoSettings：合法配置写库，并把 enabled / dry_run 列同步过去` | 已有行 | 无 | 合法 settings | 库内 `settings` 更新；`enabled`/`dry_run` 列与 settings 一致 |
| S0-R11 | `REPOCFG::updateRepoSettings：非法配置不写库（库里保持 last-known-good）` | 已有合法行 | 无 | `managers:[]` 的 settings | 返回非 ok；库内 `settings` 一字未变 |
| S0-R12 | `REPOCFG::last-known-good：库里的 jsonb 被手改成非法 → settings=null 且标为不可用` | 库内 jsonb 被 `update` 成非法 | 无 | `readRepoPolicy` | `settings===null`、`settingsValid===false` |
| S0-R13 | `REPOCFG::settings_valid=false 时直接按不可用处理，并带上列里记的原因` | `settings_valid=false` + 原因列 | 无 | `readRepoPolicy` | `settingsValid===false` 且原因透出 |
| S0-R14 | `REPOCFG::归档 → enabled=false（不删行），重新安装后恢复` | 已有行 | 无 | 归档 / 重装 | 归档后行仍存在 `enabled===false`；重装后 `enabled===true`，行数不变 |
| S0-R15 | `REPOCFG::readRepoPolicy：repos 没有这一行 → UNKNOWN_REPO_POLICY（webhook 据此忽略）` | 空 `repos` | 无 | `readRepoPolicy` | 返回值与 `UNKNOWN_REPO_POLICY` 相等 |
| S0-R16 | `REPOCFG::updateRepoSettings：仓库不存在 → notFound（HTTP 层据此回 404）` | 空 | 无 | 不存在的 repo | 结果为 `notFound` |
| S0-R17 | `REPOCFG::listRepos：列出全部仓库与状态（按 repo_full_name 升序）` | 3 行乱序 | 无 | `listRepos` | 返回 3 行且按名升序 |
| S0-R18 | `REPOCFG::读路径不会写库（readRepoPolicy 是只读的）` | 已有行 | 无 | 连续 `readRepoPolicy` | 行内容与 `updated_at` 不变 |
| S0-K01 | `CONST::默认值与文档定案逐项对齐` | — | 无 | `PIPELINE_LIMITS` | 12 个常量逐个等值（含 `closeAfterHours=48`、`formatMaxFails=5`、`recheckCooldownSeconds=120`、`gateNoticeIntervalSeconds=3600`、`sessionMaxTurns=30`、`sessionMaxAgeDays=7`） |
| S0-K02 | `CONST::单个常量与聚合常量是同一份值（改值只需改一处）` | — | 无 | 导出常量 vs `PIPELINE_LIMITS` | 每个 `PIPELINE_*` 与对应字段 `toBe` 相等 |
| S0-K03 | `CONST::pipeline-close 作业是每 10 分钟（5 段 cron，UTC 由调度方给）` | — | 无 | `JOB_SCHEDULES` | `pipeline-close` 的 cron 为 5 段且 `job==='pipeline-close'` |
| S0-K04 | `CONST::常量对象是冻结的：运行期改默认值会抛错（阈值只该走注入）` | — | 无 | 对 `PIPELINE_LIMITS` 赋值 | 抛 `TypeError`（strict mode） |
| S0-K05 | `CONST::不传参时等于默认值` | — | `createPipelineLimits()` | — | 与 `PIPELINE_LIMITS` 深等且**不是同一个对象** |
| S0-K06 | `CONST::注入 closeAfterHours 0.01 / formatMaxFails 2，其余保持默认` | — | `createPipelineLimits({closeAfterHours:0.01, formatMaxFails:2})` | — | 两个字段被覆盖，其余 10 个仍等于默认值 |
| S0-K07 | `CONST::commandExpireSeconds 是浅合并：只改一档不会把另外两档变成 undefined` | — | 只注入 `notice` | — | 三档都有值，`format=600`、`classify=1800` |
| S0-K08 | `CONST::不改入参、不污染默认值（两次注入互不影响）` | — | 两次注入 | — | 入参对象未被改写；第二次结果不含第一次的值 |
| S0-K09 | `CONST::前缀常量与三档取值` | — | 无 | `PIPELINE_QUEUE_PREFIX` 与 `expireInSecondsForCommand` | 前缀为 `pipeline:`；三个子命令各回 600/1800/300 |
| S0-K10 | `CONST::老命令不受影响：/review-pr 30min，其余自动通道 20min` | — | 无 | `/review-pr`、`/issue-triage` | 分别 1800 / `EXPIRE_IN_SECONDS_DEFAULT` |
| S0-K11 | `CONST::认不出的 pipeline 子命令与空后缀回落默认值（拼错不享受长闸）` | — | 无 | `pipeline:`、`pipeline:x` | 均回默认值 |
| S0-K12 | `CONST::前缀匹配不会把「以 pipeline 开头的其它命令」误认（pipelineX:format）` | — | 无 | `pipelineX:format` | `pipelineStageOfCommand` 为 `null`、过期时间取默认 |
| S0-K13 | `CONST::issue_pipeline 表名与 §4.3 的列一一对应` | — | 无 | drizzle table 定义 | 列名集合与 §4.3 的 24 列逐个相等 |
| S0-K14 | `CONST::默认值与可空性与 §4.3 一致（stage=format / state=pending / 三个计数从 0 起）` | — | 无 | 表定义 | 三个默认值/可空性逐项断言 |
| S0-K15 | `CONST::tasks 的正文 / 补充快照：title/body 可空，target_supplement 是 NOT NULL 的 jsonb 数组` | — | 无 | 表定义 | `target_title/target_body` 可空；`target_supplement` NOT NULL 且默认 `[]` |
| S0-K16 | `CONST::envelopes 有阶段投影列，prompt_versions 有 kind（默认 project）` | — | 无 | 表定义 | `envelopes.stage_name/stage_result` 存在；`prompt_versions.kind` 默认 `'project'` |
| S0-K17 | `CONST::建 issue_pipeline + 关闭扫描索引，主键是 (repo, issue_number)` | 空库 | 真 PG 建表 | `0005_pipeline.sql` | 表存在；索引 `issue_pipeline_close_scan_idx` 存在；主键两列 |
| S0-K18 | `CONST::增量列与 schema 对齐（tasks / envelopes / prompt_versions）` | 空库 | 同上 | 迁移文本 + 真库 | 三张表的增量列都在库里 |
| S0-K19 | `CONST::旧唯一索引被 DROP，新唯一索引带 kind` | 空库 | 同上 | 迁移文本 | 旧索引名出现 `DROP`；新索引含 `kind` 列 |
| S0-K20 | `CONST::Q4 数据重置是单条 UPDATE 且可重复执行（IS DISTINCT FROM），不用 PL/pgSQL` | — | 无 | 迁移文本 | 只有 1 条 `UPDATE "repos"`；含 `IS DISTINCT FROM`；不含 `DO $$` |
| S0-K21 | `CONST::Q4 重置覆盖四个已废弃键、managers 播种、缺 role 的词条丢弃` | — | 无 | 迁移文本 | 含 `("settings" -> 'triggers') - 'faces'`；不含 `'close_after_hours'` / `'max_runs_per_stage'`；含 managers 播种与词条过滤 |
| S0-K22 | `CONST::语句之间用 statement-breakpoint 分隔（migrate.ts 按它切分）` | — | 无 | 迁移文本 | 每条语句后都有分隔符 |
| S0-K23 | `CONST::正向语句里没有 DROP TABLE / DROP COLUMN（回滚只写在注释块里）` | — | 无 | 迁移文本 | 正向段落不含 `DROP TABLE`/`DROP COLUMN` |
| S0-J01 | `JOBS::六个作业覆盖 queue/SCHEDULES 里对应的六个队列（排队闸门排最前）` | — | 无 | `JOB_SCHEDULES` | 6 条、`pipeline-close` 在列表里、首条是排队闸门 |
| S0-J02 | `JOBS::依赖齐全时注册六个队列的 worker，并把结果写进日志` | 假 PG boss | 假 deps | `registerJobs` | 6 次 `boss.work`；`pipeline-close` 1 次 |
| S0-J03 | `JOBS::缺 docker / github / github 写面时跳过对应队列并告警，其余照注册` | — | 缺 `github` 写面 | `registerJobs` | 注册数减少 1；warn 1 条 |
| S0-J04 | `JOBS::作业抛错时把错误记录下来并向上抛（交给 pg-boss 重试）` | — | 作业抛错 | 调 runner | 记录 1 条 error + 向上抛 |
| S0-J05 | `JOBS::createJobRunners：缺注入时按作业报错，不静默跳过` | — | 缺 `closeIssue` | `runners['pipeline-close']()` | 抛 `/缺少 github 写面/` |

### 3.2 S1 状态机与门禁（61）

#### S1-a `SM`（纯函数 23 条 + 真库 6 条 = 29）

| ID | 文件::用例名 | 前置状态 | 注入 / 假实现 | 输入 | 断言 |
|---|---|---|---|---|---|
| S1-01 | `SM::issues.opened（无行）→ format/pending + 入队 pipeline:format` | 无行 | — | `{kind:'issue-opened', issueVersion:'v1'}` | transition `{stage:'format', state:'pending', issueVersion:'v1', effects:{enqueue:'pipeline:format'}}` |
| S1-02 | `SM::issues.opened 在 ready 之后 → 忽略（D7 不回退）` | `agent/ready` | — | `issue-opened` | `ignore` 非空（不产生 stage 回退） |
| S1-03 | `SM::issues.opened 在 closed 之后 → 忽略` | `closed/closed` | — | `issue-opened` | `ignore` 非空 |
| S1-04 | `SM::格式 pass（首次）→ classify/pending，无确认评论` | `format/running`、`formatFailCount=0` | — | `format-pass-first` | `{stage:'classify', state:'pending'}`；`effects.confirmComment` 为假；`effects.enqueue==='pipeline:classify'` |
| S1-05 | `SM::格式 pass（重检）→ 要有确认评论（D8），失败次数不变` | `format/running`、`formatFailCount=1` | — | `format-pass-recheck` | `effects.confirmComment===true`；`formatFailCount` 仍 1 |
| S1-06 | `SM::格式 fail → format/awaiting_info + info_requested_at=now（进 48h 扫描）` | `format/running` | — | `format-fail` | `{stage:'format', state:'awaiting_info', infoRequestedAt:AT, formatFailCount:+1}` |
| S1-07 | `SM::第 5 次格式不通过 → 自动关 issue（Q5）` | `formatFailCount=4` | 默认 limits | `format-fail` | `{stage:'closed', state:'closed', closedAt:AT}`；`effects.closeIssue===true`；`effects.enqueue` 为空 |
| S1-08 | `SM::formatMaxFails 可注入（V19：注入 2 → 第 2 次就关）` | `formatFailCount=1` | `createPipelineLimits({formatMaxFails:2})` | `format-fail` | 同上，且第 1 次时不关 |
| S1-09 | `SM::补充评论（作者）→ 立即重跑，清 info_requested_at、记 last_recheck_at` | `format/awaiting_info`、`infoRequestedAt` 非空 | — | `{kind:'supplement-comment', actor:'author', commentId:555}` | `{state:'pending', infoRequestedAt:null, lastRecheckAt:AT}`；`effects.enqueue==='pipeline:format'` |
| S1-10 | `SM::补充评论（路人）→ 忽略；不在 awaiting_info 的评论也忽略` | 同上 / `format/pending` | — | `actor:'other'`、非 awaiting 状态 | 两次 `ignore` 非空 |
| S1-11 | `SM::classify/awaiting_info + managers 评论 → 重跑分类（info_requested_at 保持 NULL）` | `classify/awaiting_info`、`infoRequestedAt=null` | — | `{kind:'manager-comment', fromManager:true}` | `{stage:'classify', state:'pending', infoRequestedAt:null}`；`enqueue==='pipeline:classify'` |
| S1-12 | `SM::classify/awaiting_info 的非 managers 评论 → 不重跑` | 同上 | — | `fromManager:false` | `ignore` 非空 |
| S1-13 | `SM::分类 requirement / defect / other → agent/ready（真实类别直接放行）` | `classify/running` | — | 三种 `classify-done` | 三次都 `{stage:'agent', state:'ready', readyAt:AT, category:<该值>}` |
| S1-14 | `SM::分类 not-found → classify/awaiting_info，且 info_requested_at 必须为 NULL` | `classify/running` | — | `result:'not-found'` | `{stage:'classify', state:'awaiting_info', category:'not-found', infoRequestedAt:null}` |
| S1-15 | `SM::连续 2 次运行失败 / 信封不合法 → blocked；第 1 次只回 pending` | `format/running` | — | `consecutiveFailures=1 / 2` | 1 次→`state:'pending'`；2 次→`state:'blocked'` 且 `blockedReason` 非空 |
| S1-16 | `SM::/pipeline next：format→classify、classify→ready、agent → 没有下一步` | 三个阶段的 `awaiting_info`/`ready` | — | `{kind:'manual-next', fromManager:true}` | format→`{classify/pending, enqueue:'pipeline:classify'}`；classify→`{agent/ready, readyAt}`；agent→`ignore==='already-last-stage'` |
| S1-17 | `SM::/pipeline next 的 blocked 等价解禁；非 managers 被拒` | `classify/blocked`、`format/pending` | — | `fromManager:true / false` | 解禁后 `blockedReason===null` 且 `stage==='agent'`；非 managers→`ignore==='not-manager'` |
| S1-18 | `SM::/pipeline prev：agent→classify（清旧结论）、classify→format、format → 没有上一步` | `agent/ready`+`category='defect'`、`classify/pending`、`format/pending` | — | `manual-prev` | agent→`{classify/pending, category:null, enqueue:'pipeline:classify'}`；classify→`{format/pending, enqueue:'pipeline:format'}`；format→`ignore` |
| S1-19 | `SM::/recheck：重跑当前阶段；--force 才清 blocked_reason；agent 阶段没有重跑` | `format/blocked`、`agent/ready` | — | `manual-recheck`（带/不带 force） | 不带 force：`blockedReason` 保留；带 force：`null`；agent→`ignore` |
| S1-20 | `SM::48h 无补充 → 关（auto-close），没到点不动` | `format/awaiting_info`、`infoRequestedAt` = 49h / 47h 前 | — | `{kind:'auto-close'}` | 49h→`{closed/closed, closedAt}` 且 `effects.closeIssue===true`；47h→`ignore` |
| S1-21 | `SM::classify/awaiting_info（等管理员）永远不会被 48h 关掉` | `classify/awaiting_info`、`infoRequestedAt=null` | — | `auto-close` | `ignore` 非空、`stage` 仍 `classify` |
| S1-22 | `SM::issues.closed → closed；已经 closed 的不重复写` | 任意 / 已 closed | — | `issue-closed` | 首次 `{closed/closed}`；第二次 `ignore==='already-closed'` |
| S1-23 | `SM::issues.edited（format 阶段）→ 重跑；ready → 只记 stale_at（D7）` | `format/awaiting_info`、`agent/ready` | — | `issue-edited`（`issueVersion:'v2'`） | format→`{format/pending, issueVersion:'v2', lastRecheckAt:AT, enqueue:'pipeline:format'}`；ready→**深等于** `{staleAt:AT}` |
| S1-24 | `SM::无行 → loadPipeline 返回 null（§1.3 无行放行）` | 库内无该行 | 真 PG | `loadPipeline` | 返回 `null`（不是抛错/空对象） |
| S1-25 | `SM::ensurePipeline 建 format/pending，且第二次调用不覆盖已有进度` | 空 / 已有 `classify/pending` | 真 PG | `ensurePipeline` ×2 | 首次行 `{format,pending}`；第二次**不改**已有 `stage/state`；行数仍 1 |
| S1-26 | `SM::createReadyRow → agent/ready + ready_at（存量 issue 懒创建）` | 空 | 真 PG | `createReadyRow` | 行 `{stage:'agent', state:'ready', readyAt:AT}` |
| S1-27 | `SM::applyTransition 写的列名与 §4.3 一致（含把 info_requested_at 显式写成 NULL）` | 已有行（`infoRequestedAt` 非空） | 真 PG | `applyTransition({state:'pending', infoRequestedAt:null})` | 库内 `stage` 不变、`state==='pending'`、`info_requested_at IS NULL` |
| S1-28 | `SM::两种 awaiting_info 落库后：一个非空、一个恒为 NULL` | 两行 | 真 PG | 两次转移 | `format` 行 `info_requested_at` 非空；`classify` 行 `IS NULL` |
| S1-29 | `SM::applyTransition 对 ignore 型转移一行都不写（返回 0）` | 已有行 | 真 PG | `applyTransition({ignore:'x'})` | 返回 0；库内 `state/updated_at` 均未变 |

#### S1-b `DIR`（13）

| ID | 文件::用例名 | 前置状态 | 注入 / 假实现 | 输入 | 断言 |
|---|---|---|---|---|---|
| S1-30 | `DIR::/recheck 与 /recheck --force` | — | — | 两段评论文本 | `{kind:'recheck', force:false/true}` |
| S1-31 | `DIR::/pipeline next 与 /pipeline prev（后面跟别的词也是合法指令）` | — | — | 4 段文本 | 解析出 next/prev，多余词被忽略 |
| S1-32 | `DIR::大小写不敏感（GitHub 的句柄本来就不分大小写）` | — | — | `@PI-Bot /PIPELINE NEXT` | 解析成功 |
| S1-33 | `DIR::不是指令：普通命令 / 裸指令 / 别的别名 / 未知子命令` | — | — | 4 段文本 | 四次 `null` |
| S1-34 | `DIR::describeDirective 还原成人读的原文（审计日志用）` | — | — | parse 结果 | 字符串含原文关键片段 |
| S1-35 | `DIR::managers 里的 login 大小写不敏感；OWNER 也算管理员` | settings `managers:['alice']` | — | `Alice` / association `OWNER` | 两次 `true` |
| S1-36 | `DIR::@ 名单只取 managers；appendMentions 不重复追加 /cc` | 同上 | — | 已含 `/cc` 的正文 | mentions 只含 managers；`/cc` 出现次数仍 1 |
| S1-37 | `DIR::非 managers 的 /recheck → ignored（不执行、不建任务）` | `format/pending`、`managers:['alice']` | 真 PG | `@pi-bot /recheck`（`login:'bob'`） | `kind==='ignored'`、`reason==='not-manager'`；`tasks` 行数 0；行 `state` 仍 `pending` |
| S1-38 | `DIR::managers 的 /pipeline next（format → classify）→ 状态推进 + 建分类任务` | `format/pending` | 真 PG | `@pi-bot /pipeline next`（`alice`） | `kind==='enqueued'`、`plan.command==='pipeline:classify'`；行 `{classify,pending}`；`tasks` 恰好 1 行 `{command:'pipeline:classify', source:'pipeline'}` |
| S1-39 | `DIR::commands.enabled=false 也不影响指令（§16.1 第 3 条）` | `commands.enabled=false`、`classify/*` | 真 PG | `/pipeline prev` | `kind==='enqueued'`；行 `{format,pending}` |
| S1-40 | `DIR::没有状态行时指令不执行（§1.3 的放行只针对 @）` | 无行 | 真 PG | `/pipeline next` | `ignored`、`reason==='no-row'`；`tasks` 0 行 |
| S1-41 | `DIR::/pipeline next 进到 agent/ready 时没有阶段任务（no-stage-task）` | `classify/pending` | 真 PG | `/pipeline next` | `ignored`、`reason==='no-stage-task'`；行 `{agent,ready}`；`tasks` 0 行 |
| S1-42 | `DIR::普通评论不是指令（返回 null，交回原通道）` | — | — | `看下这个` | `null` |

#### S1-c `WH`（19，真 PG + 假 GitHub/RACP）

| ID | 文件::用例名 | 前置状态 | 注入 / 假实现 | 输入 | 断言 |
|---|---|---|---|---|---|
| S1-43 | `WH::issues.opened → pipeline:format 任务 + format/pending 行 + 正文快照` | 无行；`repos.enabled=true` | 假 enqueue/eyes | `issues.opened`（issue #7，作者 `author`） | `h.sends` 恰好 1 条 `{command:'pipeline:format', repo}`；`tasks` 1 行 `{command:'pipeline:format', source:'pipeline', target_title:'登录时报 500', target_body:'复现步骤：……'}`、`target_supplement=[]`；`eyes` 1 次；行 `{format,pending}` |
| S1-44 | `WH::commands.enabled=false 不影响流水线（§16.1 第 3 条）` | `commands.enabled=false` | 同上 | `issues.opened` | `action==='enqueued'`；`tasks[0].command==='pipeline:format'` |
| S1-45 | `WH::issues.closed → 只推进状态机，不建任务` | 行 `format/pending` | 同上 | `issues.closed` | `action==='ignored'`；`tasks` 0 行；行 `{closed,closed}` |
| S1-46 | `WH::无行 → 放行命令任务，并懒创建 agent/ready 行（§1.3）` | 无行 | 同上 | `@pi-bot /review-pr` | `sends` 恰好 1 条 `command:'/review-pr'`；行 `{agent, ready}`（懒创建） |
| S1-47 | `WH::ready → 正常建命令任务` | 行 `agent/ready` | 同上 | 同上 | `sends` 恰好 1 条 `command:'/review-pr'` |
| S1-48 | `WH::format/awaiting_info → 命令被拦，只产 pipeline:notice（不建命令任务）` | 行 `format/awaiting_info` | 同上 | `@pi-bot /review-pr` | `sends` 恰好 1 条且 `command==='pipeline:notice'`；`tasks` 1 行 `{command:'pipeline:notice', source:'pipeline'}`；`/review-pr` **0 条**；`gateNoticeAt===NOW` |
| S1-49 | `WH::同一小时内的第二条 @ 只打 eyes（回执限速，§8）` | 行 `format/awaiting_info`，两次投递 | 同上 | 两条 `@pi-bot /review-pr`（commentId 601/602） | `sends` 里 `pipeline:notice` 恰好 1 条；`eyes` 2 次 |
| S1-50 | `WH::format/running → 只打 eyes，零任务（回执是噪音）` | 行 `format/running` | 同上 | `@pi-bot /review-pr` | `action==='ignored'`；`sends` 0；`tasks` 0；`eyes` 1 次 |
| S1-51 | `WH::blocked → notice（提示用 /recheck --force 或 /pipeline next）` | 行 `classify/blocked` | 同上 | `@pi-bot /review-pr` | `sends` 恰好 1 条 `pipeline:notice` |
| S1-52 | `WH::closed → 静默（不建任务、不打 eyes）` | 行 `closed/closed` | 同上 | 同上 | `action==='ignored'`；`sends` 0；`eyes` 0 |
| S1-53 | `WH::PR 完全不受闸门影响` | 行 `format/awaiting_info`（issue 7） | 同上 | `issue_comment` 且 `issue.pull_request` 存在 | `action==='enqueued'`；`sends` 1 条 `command:'/review-pr'`；`tasks[0] {command:'/review-pr', source:'command'}` |
| S1-54 | `WH::format/awaiting_info + 作者普通评论 → 立即重跑，锚含 commentId，state 回 pending` | 行 `format/awaiting_info` | 同上 | 普通评论（`login:'author'`，`commentId:777`） | `sends` 1 条 `pipeline:format`；`tasks` 1 行且 `target_supplement` 深等于 `[{commentId:777, author:'author', body:'…', at:NOW}]`；行 `{state:'pending', infoRequestedAt:null, lastRecheckAt:NOW}` |
| S1-55 | `WH::同一条评论的变化会换锚（不同 commentId → 两条任务；同一条重投 → 幂等）` | 行 `format/awaiting_info`（重投前手改回 awaiting） | 同上 | 同一 commentId 投 2 次、换 commentId 投 1 次 | 第 1 轮后 `tasks` 1 行；同 commentId 重投后仍 1 行；换 id 后 2 行 |
| S1-56 | `WH::评论触发后的 120s 内，issues.edited 让位（§16.2 第 3 条）` | 行 `format/awaiting_info` | 同上 | 先评论（commentId 901）再 `issues.edited` | 评论后 `tasks` 1 行；`issues.edited` 返回 `action==='ignored'` 且 `tasks` 仍 1 行 |
| S1-57 | `WH::classify/awaiting_info 的普通（非 managers）评论不触发重分类` | 行 `classify/awaiting_info` | 同上 | 评论 `login:'author'`、`association:'NONE'` | `action==='ignored'`；`sends` 0 |
| S1-58 | `WH::classify/awaiting_info + managers 评论 → 重跑分类（info_requested_at 保持 NULL）` | 行 `classify/awaiting_info` | 同上 | 评论 `login:'alice'`（managers） | `sends` 1 条 `pipeline:classify`；行 `{state:'pending', infoRequestedAt:null}` |
| S1-59 | `WH::评论补充重跑时 target_supplement 整体替换（最多 3 条）` | 行 `format/awaiting_info`，连续 4 条评论（每轮手改回 awaiting） | 同上 | commentId 11/12/13/14 | 最后一次任务的 `target_supplement` 的 commentId 序列**恰好** `[12,13,14]` |
| S1-60 | `WH::普通评论（既没命令也没 @）在 ready 之后不建任务（交回 Agent 自己处理）` | 行 `agent/ready` | 同上 | 普通评论 `login:'author'` | `action==='ignored'`；`sends` 0 |
| S1-61 | `WH::限速窗口过后（> 1 小时）可以再发一条回执` | 行 `format/awaiting_info`、`gate_notice_at = NOW-1h-1s` | 同上 | `@pi-bot /review-pr` | `sends` 恰好 1 条 `pipeline:notice`（限速放行） |

---

### 3.3 S2 阶段 0（49）

#### S2-a `FP` 纯函数（17）：动作集合 + 要落的转移

夹具：`pipelineRow(over)` 造 `format/pending` 行；`envelope(result, comment)` 造 `stage.name='format'` 的信封；`plan(over)` 调 `planFormatOutcome`；`shape()` 把 actions 压成 `comment:model` / `label:…` / `reaction:…` / `closeIssue`。

| ID | 文件::用例名 | 前置状态 | 注入 / 假实现 | 输入 | 断言 |
|---|---|---|---|---|---|
| S2-01 | `FP::没有任何评论动作，只有 rocket + 推进分类` | 行 `format/running`、`formatFailCount=0` | 默认 limits | `envelope('pass')` | `outcome==='pass-first'`；`shape===['reaction:rocket']`（评论 0 条）；`transition={classify/pending, formatAttempts:1}`；`effects.enqueue==='pipeline:classify'`；`'formatFailCount' in transition === false`；`closeIssue===false` |
| S2-02 | `FP::通过不增加 format_fail_count，只把 attempts +1（两个计数别混）` | `formatAttempts=3, formatFailCount=0` | 同上 | pass | `transition.formatAttempts===4`；`transition.formatFailCount===undefined` |
| S2-03 | `FP::pass 不写 info_requested_at（只有 fail 才写）` | `infoRequestedAt=AT` | 同上 | pass | `transition.infoRequestedAt===null` |
| S2-04 | `FP::模型写了确认评论：用它，且标记 model` | `formatFailCount=1`（重检） | 同上 | `envelope('pass','收到，补齐了…')` | `outcome==='pass-recheck'`；`shape===['comment:model','reaction:rocket']`；评论正文**等于**模型那句 |
| S2-05 | `FP::模型没写：控制面兜底句 + warn + note（Q8 唯一例外）` | `formatFailCount=2` | 假 logger 收 warn | `envelope('pass',null)` | `shape===['comment:fallback','reaction:rocket']`；正文 === `FORMAT_PASS_COMMENT_FALLBACK`；`notes` 含 `recheck-pass-without-comment`；warn **1 次** |
| S2-06 | `FP::评论 / 标签 / reaction / 状态一次给全` | 行 `format/running` | `config.labels.map['needs-info']='需要信息'` | `envelope('fail','缺复现步骤…')` | `shape===['comment:model','label:需要信息','reaction:confused']`（评论 1 条）；`transition={format, awaiting_info, formatAttempts:1, formatFailCount:1, infoRequestedAt:AT}`；`closeIssue===false` |
| S2-07 | `FP::模型没写评论：兜底句 + warn` | 同上 | 假 logger | `envelope('fail',null)` | `actions[0]` 为 `{kind:'comment', body:FORMAT_FAIL_COMMENT_FALLBACK, source:'fallback'}`；warn 含「没写评论」 |
| S2-08 | `FP::没有仓库配置时 needs-info 用兜底标签名（不抛）` | 无 config | — | fail 信封 | `shape` 含 `label:needs-info` |
| S2-09 | `FP::同版本重投（状态已不在 format/pending）→ 一个字都不写` | 行 `format/awaiting_info`、`formatFailCount=1` | — | fail 信封 | `outcome==='noop'`；`actions===[]`；`transition.ignore` 含 `not-format-running` |
| S2-10 | `FP::第 5 次（默认上限）不通过：评论 + closeIssue，且不再打标/打 reaction/入队` | `formatFailCount=4` | 默认 limits | fail 信封 | `outcome==='fail-closed'`；`shape===['comment:model','closeIssue']`（无 label/reaction）；`transition={closed/closed, formatFailCount:5, closedAt:AT, infoRequestedAt:null}`；`effects.enqueue` 为空 |
| S2-11 | `FP::注入 formatMaxFails=2：第 2 次不通过就关（阈值可注入）` | 第 1 次 `failCount=0`；第 2 次 `failCount=1` | `createPipelineLimits({formatMaxFails:2})` | fail ×2 | 第 1 次 `outcome==='fail'`、`closeIssue===false`；第 2 次 `outcome==='fail-closed'`、`shape===['comment:model','closeIssue']` |
| S2-12 | `FP::到第 5 次也不另发关闭评论：评论恰好 1 条` | `formatFailCount=4` | 默认 limits | fail 信封 | `actions.filter(kind==='comment').length===1` |
| S2-13 | `FP::第一次失败：不写任何东西，只把状态留在 pending` | 行 `format/running` | — | `runOutcome:'failed'` | `outcome==='noop'`；`actions===[]`；`transition={state:'pending', blockedReason:null}` |
| S2-14 | `FP::连续 2 次：blocked + blocked_reason，仍然零写入` | 同上 | — | `consecutiveFailures:2` + `envelopeValid:false` | `outcome==='blocked'`；`actions===[]`；`transition.state==='blocked'`；`blockedReason` 含「运行失败」 |
| S2-15 | `FP::信封合规但缺 stage：按不合法处理（不猜结论）` | 同上 | — | 无 `stage` 的信封、`consecutiveFailures:2` | `outcome==='blocked'`；`actions===[]` |
| S2-16 | `FP::不是阶段 0 的命令：忽略（不改状态机）` | 行 `format/running` | — | `command:'pipeline:classify'` | `outcome==='noop'`；`transition===null` |
| S2-17 | `FP::没有流水线行：忽略` | 无行 | — | 任意 | `outcome==='noop'`；`transition===null` |

#### S2-b `FE` 执行面（8）：真 PG + 假 GitHub（`createFakeApi` 记 `calls: Call[]`、`createFakeReactions` 记 `calls: string[]`）

| ID | 文件::用例名 | 前置状态 | 注入 / 假实现 | 输入 | 断言 |
|---|---|---|---|---|---|
| S2-18 | `FE::零评论、只有 rocket、状态推进到 classify/pending` | 行 `format/pending` | 假 api + 假 reactions | pass 信封 | `calls` 里 `comment` **0 次**、`label` 0 次；`reactions==['rocket']`；库内 `{classify, pending}` |
| S2-19 | `FE::一条评论 + needs-info 标签 + confused；info_requested_at 落库` | 同上 | 同上 | fail 信封（带评论） | `calls` 计数 `comment=1`、`label=1`；`reactions==['confused']`；库内 `{format, awaiting_info, info_requested_at` 非空、`format_fail_count=1}` |
| S2-20 | `FE::同版本重投：第二轮进 noop，不再发第二条评论` | 第 1 轮已 fail | 同上 | 同一 fail 信封再跑 | 第 2 轮 `calls` 不新增 `comment`（全程 `comment` 总计 1 次）；库内状态不变 |
| S2-21 | `FE::第 5 次不通过：closeIssue 恰好 1 次、状态 closed、closed_at 落库` | `format_fail_count=4` | 同上 | fail 信封 | `calls` 里 `closeIssue` **恰好 1 次**；库内 `{closed, closed, closed_at` 非空}` |
| S2-22 | `FE::注入 formatMaxFails=2：第 2 次不通过就关` | `format_fail_count=1` | `createPipelineLimits({formatMaxFails:2})` | fail 信封 | `closeIssue` 1 次；库内 `state='closed'` |
| S2-23 | `FE::关闭失败不抛：状态已 closed，issue 仍开着（下一轮不会重复触发）` | `format_fail_count=4` | `createFakeApi({failClose:true})` | fail 信封 | 不抛；库内 `state='closed'`；再跑一轮 `closeIssue` **不新增**（总计仍 1 次尝试） |
| S2-24 | `FE::dry-run：GitHub 一个请求都不发，状态也不写（零副作用口径）` | 行 `format/pending` | 同上，`dryRun=true` | pass 信封 | `calls` 0、`reactions` 0；库内 `state` 仍 `pending` |
| S2-25 | `FE::没注入 reaction 写面：不打 reaction，也不报错` | 同上 | 不传 `reactions` | pass 信封 | `calls` 里无 reaction 类调用；不抛；状态仍推进 |

#### S2-c `LIGHT`（5）：light 运行时（`runTask({runtimeMode:'light'})`）+ 假 host / 假 docker / 假 worktree

| ID | 文件::用例名 | 前置状态 | 注入 / 假实现 | 输入 | 断言 |
|---|---|---|---|---|---|
| S2-26 | `LIGHT::一次成功：只有 host + turn，四步序列，容器与 worktree 都没被碰过` | — | 假 host/docker/worktree/proxy/disposer，计数 | `pipeline:format` 任务 + `item.completed` 带 `stage` 信封 | 步骤序列恰好 `host→turn→validate→execute`；`docker.create` **0 次**、`worktree.create` 0 次、`proxy` 0 次、`diff` 0 次、`dispose` 0 次 |
| S2-27 | `LIGHT::下游照样落库：信封 + run_events + 结束状态` | 同上 | 真 `RunStore` 假实现 | 同上 | `envelopes` 1 行（`valid=true`）、`run_events` 条数等于事件数、run 终态 `succeeded` |
| S2-28 | `LIGHT::light 不调 promptEnricher（提示词已由装配层拼好）` | 同上 | 假 enricher 计数 | 同上 | `promptEnricher` **0 次** |
| S2-29 | `LIGHT::host 起不来：跳过 turn，失败体面收场（不碰容器，也不抛）` | 同上 | `host.ready()` 抛错 | 同上 | `turn` **0 次**；`docker.create` 0 次；不抛；终态为失败（非 `succeeded`） |
| S2-30 | `LIGHT::不传 runtimeMode：worktree / 容器 / 代理 / 处置各一次，步骤仍是九步` | — | 同上 | `/issue-triage` 任务（`runtimeMode:undefined`） | 四类调用**各 1 次**；步骤 9 步；`report.runtimeMode==='sandboxed'` |

#### S2-d `SR` 阶段结论校验（12，纯函数）

| ID | 文件::用例名 | 前置状态 | 注入 / 假实现 | 输入 | 断言 |
|---|---|---|---|---|---|
| S2-31 | `SR::pass / fail 都合法` | — | — | `stage{format,pass/fail}` | 两次 `ok===true`，`result` 原样 |
| S2-32 | `SR::缺少 stage → missing-stage（调用方 blocked，零写入）` | — | — | 无 `stage` 的信封 | `{ok:false, reason:'missing-stage'}` |
| S2-33 | `SR::stage.name 与任务阶段不一致 → stage-mismatch` | — | — | `stage.name='format'` 喂给 `classify` 任务 | `reason==='stage-mismatch'` |
| S2-34 | `SR::result 不在该阶段允许集合内 → result-not-allowed` | — | — | format 阶段给 `result:'requirement'` | `reason==='result-not-allowed'` |
| S2-35 | `SR::requirement / other 不需要行号证据` | — | — | 无 evidence | 两次 `ok===true`，`downgraded` 为假 |
| S2-36 | `SR::defect 有 path:line 证据 → 保持 defect` | — | — | `evidence:[{rule:'code:src/a.ts', quote:'src/a.ts:42 …'}]` | `result==='defect'`、`downgraded===false` |
| S2-37 | `SR::defect 没有行号证据 → 强制降级 not-found 且标记 downgraded` | — | — | `quote` 无 `path:line` | `result==='not-found'`、`downgraded===true` |
| S2-38 | `SR::defect 的 rule 不是 code: 前缀 → 同样降级（证据必须指到代码）` | — | — | `rule:'checked:src/'` + 合法 quote | `result==='not-found'`、`downgraded===true` |
| S2-39 | `SR::not-found 原样通过（虚拟缺陷路径）` | — | — | `result:'not-found'` | `ok===true`、`result==='not-found'` |
| S2-40 | `SR::classifyEvidenceScope 只挑 checked: 开头的条目` | — | — | 混合 evidence | 返回数组只含 `checked:` 项（条数精确） |
| S2-41 | `SR::codeEvidenceOf 要求 rule=code:* 且 quote 形如 path:line` | — | — | 4 组 evidence | 只有同时满足的 1 组被返回 |
| S2-42 | `SR::commentBodyOf 取第一条非空 comment` | — | — | 3 个 action（空/空/非空） | 返回非空那条的正文 |

#### S2-e `CLOSE` 48h 作业（7）：真 PG + 假 `closeIssue`（注入 `closeAfterHours=0.01`）

| ID | 文件::用例名 | 前置状态 | 注入 / 假实现 | 输入 | 断言 |
|---|---|---|---|---|---|
| S2-43 | `CLOSE::扫描 SQL 自己就写死了「只扫等用户的 awaiting_info」` | — | — | 导出的 SQL 文本 | 含 `state = 'awaiting_info'` 且含 `info_requested_at IS NOT NULL` |
| S2-44 | `CLOSE::format/awaiting_info 超时：关一次 + 状态落 closed + closed_at 有值` | 行 `format/awaiting_info`、`info_requested_at` 早于阈值 | 假 `closeIssue` 计数 | 跑作业 1 次 | `closeIssue` 恰好 1 次；行 `{closed, closed, closed_at` 非空}` |
| S2-45 | `CLOSE::反例一：classify/awaiting_info（等管理员，info_requested_at 为 NULL）不动` | 行 `classify/awaiting_info`、该列 NULL | 同上 | 跑作业 | `closeIssue` **0 次**；行状态不变 |
| S2-46 | `CLOSE::反例二：没到阈值（36 秒 vs 10 秒前）不动` | 两行，`info_requested_at` 分别为 36s/10s 前 | 同上（阈值 30s） | 跑作业 | `closeIssue` 恰好 1 次（只关 36s 那条）；另一行不变 |
| S2-47 | `CLOSE::第二轮不重复关（同一条只关一次）` | 已关的行 | 同上 | 连跑 2 轮 | 第 2 轮 `closeIssue` 0 次（累计仍 1 次） |
| S2-48 | `CLOSE::单条失败不中断整批：其余照关，失败进 warning` | 2 行超时，其中 1 条 `closeIssue` 抛错 | 同上 | 跑作业 | 成功的 1 条被关（1 次调用 + 1 次失败）；返回 `warnings` 长度 1 |
| S2-49 | `CLOSE::缺 closeIssue 注入：不抛，返回 happened 的 warning` | 超时行 | 不注入 `closeIssue` | 跑作业 | 不抛；`warnings` 长度 1；`happened.closeIssue` 为假 |

### 3.4 S3 阶段 1（25）

#### S3-a `CP`（17）：真 PG + 假 GitHub 写面（`createFakeApi()` 记 `comments: string[]` / `labels: string[][]`）

配置夹具：`SETTINGS = parseValidSettings({labels:{vocabulary: vocabularyWithRoles([{name:'需求'},{name:'缺陷'},{name:'咨询'}])}})`（managers=`alice`）。

| ID | 文件::用例名 | 前置状态 | 注入 / 假实现 | 输入 | 断言 |
|---|---|---|---|---|---|
| S3-01 | `CP::打 role=requirement 标签 + 1 条评论（含 /cc @managers）+ 状态推进到 agent/ready` | 行 `classify/pending`、`issueVersion='v1'` | 假 api | `stage{classify,requirement}` + 评论 | `outcome==='requirement'`；`labels` 深等于 `[['需求']]`（打标 1 次）；`comments.length===1` 且含「需求理解」与 `/cc @alice`；行 `{agent, ready, category:'requirement', classifyAttempts:1, mentionCategory:'requirement', readyAt:AT, mentionSentAt:AT, infoRequestedAt:null}` |
| S3-02 | `CP::有 path:line 证据：打 role=defect 标签 + 评论 + @ + 直接 ready` | 同上 | 同上 | `defect` + `code:src/save.ts` 证据 | `labels===[['缺陷']]`；`comments.length===1` 含 `/cc @alice`；行 `{agent, ready, category:'defect', readyAt:AT}` |
| S3-03 | `CP::没有 path:line → 降级 not-found：不打缺陷标签、停在 classify/awaiting_info、仍然 @managers` | 同上 | 假 logger 收 warn | `defect` + 只有 `checked:` 证据 | `outcome==='not-found'`；`notes` 含 `downgraded`；warn 1 次；`labels===[]`；`comments.length===1` 含 `/cc @alice`；行 `{classify, awaiting_info, category:'not-found', infoRequestedAt:null, mentionSentAt:AT}` |
| S3-04 | `CP::无标签 + 1 条评论（查不到 + 已查范围 + 需要什么）+ @；停在等管理员` | 同上 | 同上 | `not-found` 信封 + `checked:` 证据 | `labels===[]`；`comments.length===1`，正文含「查不到」「还需要」「已查范围：」+ 证据原文 + `/cc @alice`；行 `{classify, awaiting_info, category:'not-found'}` |
| S3-05 | `CP::模型自己写了「已查范围」：控制面不再补第二段` | 同上 | 同上 | 正文已含「已查范围：」 | 评论中「已查范围：」出现次数**恰好 1** |
| S3-06 | `CP::模型没写评论：用兜底句 + warn（状态照常推进）` | 同上 | 假 logger | `not-found` + `comment:null` | `comments.length===1` 且含「无法完成分类」；warn 含「兜底句」；行 `state==='awaiting_info'` |
| S3-07 | `CP::只打 role=other 标签：0 条评论、0 个 @、直接 ready` | 同上 | 同上 | `other` | `labels===[['咨询']]`；`comments===[]`；`plan.mention.applied===false`；行 `{agent, ready, category:'other', mentionSentAt:null}` |
| S3-08 | `CP::已有 mention_sent_at：重分类不再追加 @，也不改这一列` | 行 `mention_sent_at='2026-05-01'` | 同上 | `requirement` | `comments.length===1` 且**不含** `@alice`；`mention.applied===false`；行 `mentionSentAt` 仍为旧值、`mentionCategory===null` |
| S3-09 | `CP::stage 名不匹配（format 信封冒充 classify）：blocked，一个字都不写` | 行 `classify/pending` | 同上 | `stage{format,pass}`、`consecutiveFailures:2` | `comments===[]`、`labels===[]`；行 `{state:'blocked'}`、`blockedReason` 含 `stage`；`category===null`、`mentionSentAt===null` |
| S3-10 | `CP::result 不在允许集合（classify 用 pass）：同样 blocked` | 同上 | 同上 | `stage{classify,pass}`、`consecutiveFailures:2` | `outcome==='blocked'`；`comments===[]`；行 `state==='blocked'` |
| S3-11 | `CP::第一次失败（连续 1 次）：不动用户可见的东西，也不 blocked` | 同上 | 同上 | `runOutcome:'failed'`、`consecutiveFailures:1` | `outcome==='noop'`；`comments===[]`；行 `state==='pending'` |
| S3-12 | `CP::同版本重投：状态已不在 classify/pending → noop，第二条评论不出现` | 已跑过 requirement | 同上 | 再跑 requirement | 第 2 轮 `outcome==='noop'`；`comments===[]`、`labels===[]` |
| S3-13 | `CP::频率上限：超过 limits.max_comments_per_hour → 丢评论，但状态照常推进` | 行 `classify/pending` | `commentsLastHour:10` | requirement | `comments===[]`；`notes` 含 `comment-rate-limited`；行 `{agent, ready, category:'requirement'}` |
| S3-14 | `CP::dry-run：GitHub 一个请求都不发，状态也不写` | 行 `classify/pending` | 同上 + `dryRun=true` | requirement | `comments===[]`、`labels===[]`；`executed.applied` 含 `comment:dry-run`；行 `state==='pending'` |
| S3-15 | `CP::managers 的评论 → 重跑分类（manager-comment → classify/pending + 入队 pipeline:classify）` | 由 not-found 走到 `classify/awaiting_info` | 同上 + `decideSupplementOutcome` | manager 评论（`alice`） | outcome 为 `rerun`/`channel:'classify'`；行 `{classify, pending}`；入队 1 个 `pipeline:classify` |
| S3-16 | `CP::作者（非 managers）的评论 → 只记录，不重跑` | 同上 | 同上 | 作者评论（`bob`） | outcome 非 rerun（`ignored`）；行仍 `classify/awaiting_info` |
| S3-17 | `CP::/pipeline next（managers）→ 直接 agent/ready（V20 的分类段）` | 同上 | 同上 | `/pipeline next` | 行 `{agent, ready, readyAt}`；`category` 保留 `not-found` |

#### S3-b `LAB`（8）：按 role 取标 + `normalizeDesired` 归一

| ID | 文件::用例名 | 前置状态 | 注入 / 假实现 | 输入 | 断言 |
|---|---|---|---|---|---|
| S3-18 | `LAB::按 role 取名字，保持词表顺序并去重` | — | — | 词表含 2 个 requirement | 返回 2 个名字且顺序与词表一致、无重复 |
| S3-19 | `LAB::词表里没有该 role → 空数组（不是抛错）` | — | — | 只有 other 的词表 | 返回 `[]`，不抛 |
| S3-20 | `LAB::requirement / defect / other 各取自己的 role` | — | — | 三个 role | 三次各返回对应 1 个名字 |
| S3-21 | `LAB::not-found 一律空数组（不打缺陷标签，D3）` | — | — | `result:'not-found'` | 返回 `[]` |
| S3-22 | `LAB::缺该 role 时返回空 + warn 一次（流程继续，不报错）` | — | 假 logger 计数 | 缺 requirement 的词表 | 返回 `[]`；warn **1 次**；不抛 |
| S3-23 | `LAB::同一互斥组只留第一个（词表 group 生效）` | — | 真/normalizeDesired | 同 group 两个标签 | 归一后只剩 1 个（第一个） |
| S3-24 | `LAB::人工否决的标签不会被打回来` | `bot_labels` 里记否决 | 同上 | 被否决的标签 | 归一结果不含该标签（计数 0） |
| S3-25 | `LAB::not-found 归一化后仍然是空（没有 key 就没有 desired）` | — | 同上 | not-found | 归一结果 `[]` |

---

### 3.5 S4 阶段 2（87）

#### S4-a `SES` 会话复用与轮换（11）：`planAgentSession`（纯函数）+ `createApplication().executeTask()`（真 PG + 假 RACP）

| ID | 文件::用例名 | 前置状态 | 注入 / 假实现 | 输入 | 断言 |
|---|---|---|---|---|---|
| S4-01 | `SES::没有流水线行 / 不在 agent 阶段：ephemeral（不 attach、不 archive）` | 无行 / `format/ready` | — | `planAgentSession({pipeline, at})` | 两次 `mode==='ephemeral'`，无 `sessionId` |
| S4-02 | `SES::第一轮（没有 session_id）：新建会话，不轮换` | 行 `agent/ready`、`sessionId=null` | — | 同上 | `plan.rotate===false`、`plan.mode==='persistent'` |
| S4-03 | `SES::复用：带上 sessionId 与 cursor 作 after（防重放旧事件）` | `sessionId='old'`、`cursor=3` | — | 同上 | `plan.sessionId==='old'`、`plan.after===3`、`rotate===false` |
| S4-04 | `SES::30 轮：轮换（archive 旧会话 + 新建）` | `sessionTurns=30` | — | 同上 | `plan.rotate===true`、`archiveSessionId` 为旧 id |
| S4-05 | `SES::超过 7 天：轮换（age）` | `sessionStartedAt` 8 天前 | — | 同上 | `plan.rotate===true` |
| S4-06 | `SES::29 轮 / 6 天：还没到阈值，继续复用` | `sessionTurns=29`、6 天 | — | 同上 | `rotate===false`、`sessionId` 为旧 id |
| S4-07 | `SES::session_id 不变、session_turns +2、session/archive 0 次、订阅用 cursor 当 after` | 行 `agent/ready`（`cursor=3, turns=4`），两条 `@answer` 任务 | 假 RACP 记 calls；`now=()=>NOW` | 连跑 2 次 `executeTask` | `session/attach` 2 次且 **sessionId 都是 `OLD_SESSION`**；`session/archive` **0 次**；`session/create` **0 次**；`events/subscribe.after` 序列**恰好** `[3,4]`；行 `{sessionId:OLD, sessionTurns:6, sessionCursor:4, sessionStartedAt` 未变, `blockedReason:null}` |
| S4-08 | `SES::session_turns >= 30：先 archive 旧会话再新建，落 session-reset` | `sessionTurns=30` | 同上 | 跑 1 次 | `session/archive` **1 次**（参数为旧 id）；`attach` 0 次；`create` 1 次；行 `{sessionId:NEW, blockedReason:'session-reset', sessionTurns:1, sessionStartedAt:NOW}` |
| S4-09 | `SES::会话超过 7 天：同样 archive 旧会话 + 新建` | `sessionStartedAt` 8 天前、`turns=2` | 同上 | 跑 1 次 | `archive` 1 次；行 `{sessionId:NEW, blockedReason:'session-reset'}` |
| S4-10 | `SES::第一轮（还没有 session_id）：不 archive，落新 id 与 session_started_at` | `sessionId=null, turns=0` | 同上 | 跑 1 次 | `archive` 0 次、`attach` 0 次、`create` 1 次；行 `{sessionId:NEW, sessionTurns:1, sessionStartedAt:NOW}` |
| S4-11 | `SES::pipeline:format（light + ephemeral）：跑完 session_id 仍是 NULL` | 行 `format/pending`、`issueVersion='v1'` | 同上 | `pipeline:format` 任务（pass 信封） | `report.sessionMode==='ephemeral'`；`session/archive` **1 次**；行 `{stage:'classify', sessionId:null, sessionTurns:0, sessionCursor:0}` |

#### S4-b `AP` AGENTS.md 加载 + 阶段 2 最终 prompt（10）

| ID | 文件::用例名 | 前置状态 | 注入 / 假实现 | 输入 | 断言 |
|---|---|---|---|---|---|
| S4-12 | `AP::读到正文：走同一套清洗与围栏（与 worktree 版同形）` | — | 假 GitHub 读面返回 AGENTS.md | `createRepoAgentsMdLoader` | 返回文本带同一套围栏标记；与 worktree 版**逐字节相同** |
| S4-13 | `AP::缓存：同一仓库在 TTL 内只打一次 API` | — | 假读面计数 | 调 2 次（TTL 内） | 读面调用 **1 次** |
| S4-14 | `AP::读不到：null + 一次 warn（同一仓库不刷日志）` | 读面返回 404 | 假 logger | 调 2 次 | 返回 `null`；warn **1 次** |
| S4-15 | `AP::读抛错：null + warn（不阻塞阶段 0）` | 读面抛错 | 同上 | 调 1 次 | 返回 `null`；warn 1 次；不抛 |
| S4-16 | `AP::没有 GitHub 读面：null，且一条日志都不刷` | 无读面 | 假 logger | 调 1 次 | `null`；日志 **0 条** |
| S4-17 | `AP::超长：截断并留可见标记` | 读面返回超长文本 | — | 调 1 次 | 长度受限且含截断标记 |
| S4-18 | `AP::含 AGENTS.md，不含 P1 与技能层（Q9 / V9）` | 行 `format/pending`；settings 有 P1 与技能 | 装配层 | `buildStagePrompt(stage:'format')` | 最终 prompt 含 AGENTS.md 唯一片段；**不含** P1 片段、不含技能层片段 |
| S4-19 | `AP::四层齐全：agent 阶段提示词 + P1 + AGENTS.md + 技能层，契约仍在最后` | 行 `agent/ready` | 装配层 | `stage:'agent'` | 四层片段各出现 **1 次**；输出契约在**最后一个**位置 |
| S4-20 | `AP::项目版 agent 提示词整体覆盖内置默认（Q1）` | `savePrompt(kind:'agent')` 存项目版 | — | `stage:'agent'` | 最终 prompt 含项目版片段、**不含**内置默认片段 |
| S4-21 | `AP::改坏 agent 提示词也不影响输出契约（V16：契约代码给、不可配、永远最后）` | 项目版 =「不要输出 JSON」 | — | `stage:'agent'` | 输出契约仍在末尾（1 次）；模型那句也在 |

#### S4-c `SP` 阶段提示词渲染与作用域（13）

| ID | 文件::用例名 | 前置状态 | 注入 / 假实现 | 输入 | 断言 |
|---|---|---|---|---|---|
| S4-22 | `SP::用内置默认模板渲染 title / body / recheck，且不含 P1 与技能层` | 行 `format/pending` | — | `buildStagePrompt(stage:'format')` | 三个占位符被替换；不含 P1/技能层片段 |
| S4-23 | `SP::AGENTS.md 照常注入（Q9：任意时刻生效）` | 同上 | 假 AGENTS 文本 | 同上 | prompt 含 AGENTS 片段 1 次 |
| S4-24 | `SP::重跑：recheck=true（D8 要求通过也要回一句确认）` | 行 `format_fail_count=1` | — | 同上 | prompt 里 `recheck` 渲染为 `true`（`false` 出现 0 次） |
| S4-25 | `SP::补充评论置顶在正文之前（评论优先，E4）` | 行带 `target_supplement` | — | 同上 | 补充段索引 **小于** 正文索引 |
| S4-26 | `SP::项目版阶段提示词整体覆盖内置默认（Q1）` | `savePrompt(kind:'format_check')` | — | 同上 | 最终 prompt 含项目版、不含内置默认 |
| S4-27 | `SP::用 classify 的模板，仍然不含 P1 / 技能层，但含 AGENTS.md` | 行 `classify/pending` | — | `stage:'classify'` | classify 片段 1 次；P1/技能层 0 次；AGENTS 1 次 |
| S4-28 | `SP::从 prompt_text 取 gate_state 并渲染内置模板` | `pipeline:notice` 任务、`prompt_text='gate_state=format/awaiting_info; …'` | — | `buildNoticePrompt` | 含 `format/awaiting_info`；输出只有一段话 |
| S4-29 | `SP::gate_state 缺失时不抛，给 unknown` | `prompt_text` 为 null | — | 同上 | 不抛；含 `unknown` |
| S4-30 | `SP::stage=format：有 AGENTS.md，没有 P1、没有技能层` | — | `createPromptEnricher` | `stage:'format'` | 三个断言分别为 1 / 0 / 0 |
| S4-31 | `SP::stage=classify：同样只加 AGENTS.md（Q9）` | — | 同上 | `stage:'classify'` | 同上 |
| S4-32 | `SP::不传 stage：P1 与技能层照旧（与接线前一致）` | — | 同上 | 不传 stage | P1 与技能层各 1 次 |
| S4-33 | `SP::isRecheckTask：补充评论 或 format_fail_count>0` | — | — | 三种任务行 | 两次 `true`、普通任务 `false` |
| S4-34 | `SP::toSupplements：坏 jsonb 只丢那一条，不整条失败` | `target_supplement` 含 1 个坏元素 | — | `toSupplements` | 返回其余合法条目（计数精确） |

#### S4-d `MODE` 会话模式（9）

| ID | 文件::用例名 | 前置状态 | 注入 / 假实现 | 输入 | 断言 |
|---|---|---|---|---|---|
| S4-35 | `MODE::create + archive 各一次，attach 不参与，mode=ephemeral` | 无会话 | 假 host/RACP | `runTask`（默认） | `session/create` 1 次、`archive` 1 次、`attach` 0 次；`report.sessionMode==='ephemeral'` |
| S4-36 | `MODE::显式 {mode:ephemeral} 与不传完全一致` | — | 同上 | 显式 ephemeral | 与上一条的调用序列逐项相等 |
| S4-37 | `MODE::attach 复用 + 用 after=cursor 订阅 + **不 archive**` | 注入 `sessionId`+`cursor` | 同上 | `{mode:'persistent'}` | `attach` 1 次；`events/subscribe.after===cursor`；`archive` **0 次** |
| S4-38 | `MODE::没给 after 时用 attach 快照里的游标兜底（不从 0 重放）` | attach 返回 `sequence=7` | 同上 | 同上 | `subscribe.after===7` |
| S4-39 | `MODE::attach 抛错：新建会话 + sessionReset（不阻塞），仍然不 archive` | attach 抛错 | 同上 | 同上 | `create` 1 次；`report.sessionReset===true`；`archive` 0 次 |
| S4-40 | `MODE::Host 没有 attach operation：同样按失败处理（不抛）` | host 缺 attach | 同上 | 同上 | 不抛；`sessionReset===true`；`create` 1 次 |
| S4-41 | `MODE::第一次 persistent（没有 sessionId）：新建会话，不 attach 也不 archive` | 无会话 | 同上 | `{mode:'persistent'}` | `create` 1 次；`attach` 0、`archive` 0 |
| S4-42 | `MODE::collectDiff:false → 不调 workspace/diff，diff 为空` | — | 同上 | light | `diff` 调用 0 次；`report.diff===''` |
| S4-43 | `MODE::sessionCursorOf：裸数字 / {sequence} / 空都给对` | — | — | 三种输入 | 分别 `3` / `5` / `0` |

#### S4-e `ASM` 层序与预算（17）

| ID | 文件::用例名 | 前置状态 | 注入 / 假实现 | 输入 | 断言 |
|---|---|---|---|---|---|
| S4-44 | `ASM::不给 stage 时 P1 与技能层照常参与；给 stage=null 也一样` | — | — | 两次 `assemblePrompt` | 两次结果逐字节相同，且都含 P1 与技能层 |
| S4-45 | `ASM::什么都没有时仍然逐字节等于 basePrompt` | — | — | 空输入 | 结果 === `basePrompt` |
| S4-46 | `ASM::层序：阶段系统提示词 → AGENTS.md → 输出契约；没有 P1、没有技能层` | — | — | `stage:'format'` | 三者的相对顺序正确；P1/技能层片段 0 次 |
| S4-47 | `ASM::没有 AGENTS.md 时只有「阶段提示词 + 输出契约」两段` | — | — | 同上（无 AGENTS） | 段数 2 |
| S4-48 | `ASM::四层都在：agent 阶段提示词 → P1 → AGENTS.md → 技能层 → 输出契约` | — | — | `stage:'agent'` | 五个位置严格递增；每层各 1 次 |
| S4-49 | `ASM::阶段提示词为空时退回 basePrompt 的头部（层序不变）` | — | — | 空阶段提示词 | 头部来自 `basePrompt`；层序与上一条相同 |
| S4-50 | `ASM::阶段 kind 的 version=0 用内置默认；project 的 version=0 什么都不注入` | `prompt_versions` 无行 | — | 两个 stage | format/classify/agent 用内置默认（各 1 次）；project 片段 0 次 |
| S4-51 | `ASM::项目版整体覆盖：最终 prompt 里找不到默认模板的任何 40 字符片段` | 项目版已存 | — | `stage:'agent'` | 默认模板的每个 40 字符切片在最终 prompt 中出现次数 **0** |
| S4-52 | `ASM::项目把 agent 提示词写成「不要输出 JSON」，契约仍然在最后` | 同上 | — | 同上 | 契约在末尾（1 次） |
| S4-53 | `ASM::超预算时只丢可丢层：truncated 里不出现 base / 输出契约` | AGENTS+技能超 12k | — | 同上 | `truncated` 集合不含 `base`、不含 `tail`；含 `project`/`nearby:*`/`skill:*`/`root` 中的至少 1 项 |
| S4-54 | `ASM::head / tail 恒为 droppable:false；P1 / AGENTS / 技能可丢；名字带路径与技能名` | — | — | `stageLayers` | head/tail `droppable===false`；其余 `true`；名字含路径/技能名 |
| S4-55 | `ASM::阶段 0/1 的层序里没有 project / skill` | — | — | `stage:'format'` | 层名里 `project`/`skill:` 计数 0 |
| S4-56 | `ASM::被丢弃的层 chars=0 且 dropped=true，head/tail 仍在` | 超预算 | — | 同上 | 丢弃层 `chars===0`、`dropped===true`；head/tail 仍 `dropped===false` |
| S4-57 | `ASM::agent 存满 4000 时 P1 还能存 2000 以上（available ≥ 2000）` | AGENTS+技能 ≤6000 | — | `planPromptBudget({baseChars:4000,…})` | `available >= 2000` 且 `<= 4000` |
| S4-58 | `ASM::available 随 agent 长度变化：缺省 0 与老调用点逐字节一致` | — | — | `baseChars=0` vs 不传 | 两者结果相同；`baseChars=4000` 时 `available` 比 0 时少 4000 |
| S4-59 | `ASM::估算路径同样扣 agent；估算 + 满额 agent 时 available 归 0（不会变负数）` | — | — | 估算输入 | `available===0`（不是负数） |
| S4-60 | `ASM::运行期统计里 agent 落在 baseChars：装配后 agent 越长 baseChars 越大` | — | — | 两次装配 | `stats.baseChars` 随 agent 长度单调增大 |

#### S4-f `STP` 内置模板 / 插值 / 保存期校验（18）

| ID | 文件::用例名 | 前置状态 | 注入 / 假实现 | 输入 | 断言 |
|---|---|---|---|---|---|
| S4-61 | `STP::三套默认模板都在，且都含 §15 列出的占位符` | — | — | 三个 kind 的默认模板 | 3 个模板非空；各自含规定的占位符集合 |
| S4-62 | `STP::每个模板末尾都提醒交出 JSON 信封（输出契约本身由控制面追加）` | — | — | 同上 | 3 个模板末尾都含信封提醒 |
| S4-63 | `STP::project 没有默认正文：version=0 就是「不注入」` | — | — | `kind:'project'` | 默认正文为空串 |
| S4-64 | `STP::上限表：agent 4000（与 P1 同档），format_check/classify 8000` | — | — | 上限表 | 三个值分别 4000/8000/8000 |
| S4-65 | `STP::默认模板自身都通过保存期校验（否则「恢复默认」不可用）` | — | — | `validateStagePrompt` | 3 个都 `ok===true` |
| S4-66 | `STP::八个占位符全部替换；值里的花括号被中和（不再扫描成占位符）` | — | — | 8 个描述符 | 输出里 `{{` 出现 0 次；值里的 `{}` 不出现在 `unknownPlaceholders` |
| S4-67 | `STP::未知占位符原样保留，并记进 unknownPlaceholders（不静默吞）` | — | — | 含 `{{nope}}` 的模板 | 输出保留 `{{nope}}`；`unknownPlaceholders` 恰好 `['nope']` |
| S4-68 | `STP::空词表时明说「不要猜标签名」` | 词表 `[]` | — | 渲染 | 输出含该提示句 1 次 |
| S4-69 | `STP::补充评论段置顶、只取最近 3 条、按新→旧；被丢掉的那条记进 dropped` | 4 条补充 | — | 渲染 | 顺序为新→旧共 3 条；`dropped` 恰好 1 项 |
| S4-70 | `STP::单条补充评论超过 1000 字符时截断，并记进 dropped / truncated` | 单条 1500 字符 | — | 渲染 | 该段长度 ≤1000；`truncated` 记录 1 次 |
| S4-71 | `STP::正文超长：{{body}} 不超过 4000，截断处标注原文长度` | 正文 9000 字符 | — | 渲染 | `{{body}}` 替换结果 ≤4000；含原文长度标注 |
| S4-72 | `STP::补充段与正文共享 4000 额度：两者都超长时总长仍受限` | 两者都超长 | — | 渲染 | 总长 ≤4000 |
| S4-73 | `STP::没有补充评论时只有正文；空正文给一句占位说明` | — / 空正文 | — | 渲染 | 无补充段；空正文时含占位说明 1 次 |
| S4-74 | `STP::未知占位符 → ok=false 并列出名字` | — | — | `validateStagePrompt` | `ok===false`、`unknown` 含该名字 |
| S4-75 | `STP::format_check 缺 {{title}} / {{body}} → ok=false 并列出缺的名字` | — | — | 缺占位符模板 | `ok===false`、`missing` 恰好 2 项 |
| S4-76 | `STP::classify / agent 不强制任何占位符；project 不校验未知占位符` | — | — | 3 种输入 | classify/agent 无占位符也 `ok`；project 带 `{{nope}}` 仍 `ok` |
| S4-77 | `STP::超过上限 → ok=false 且带上 chars / limit` | — | — | 8001 / 4001 字符 | `ok===false`；`chars`/`limit` 与实际一致 |
| S4-78 | `STP::把 {{gate_state}} 插进模板，产出只有一段话（不含命令指令）` | — | — | `renderGateNoticePrompt` | 含状态串 1 次；不出现 `/review-pr` 之类的命令 |

#### S4-g `PK` 四版本线集成（9，真 PG）

| ID | 文件::用例名 | 前置状态 | 注入 / 假实现 | 输入 | 断言 |
|---|---|---|---|---|---|
| S4-79 | `PK::四个 kind 各自独立取号：project v1 与 format_check v1 互不影响` | 空 `prompt_versions` | 真 PG | 各存 1 版 | 两个 kind 各自 `version===1`；行数 2 |
| S4-80 | `PK::指针各去各的地方：project 用 prompt.current_version，其余用 pipeline.*_prompt_version` | 同上 | 真 PG | 存 4 版 | `settings.prompt.current_version` 与三个 `pipeline.*_prompt_version` 分别指向各自最新版 |
| S4-81 | `PK::读取隔离：查 project 读不到 classify 的行` | 两 kind 各 1 版 | 真 PG | 按 kind 读 | project 返回 project 正文（不等于 classify 正文） |
| S4-82 | `PK::version=0：阶段 kind 用内置默认，project 不注入` | 指针 0 | 真 PG | 读 | 阶段 kind 返回内置默认；project 返回空正文 |
| S4-83 | `PK::未知占位符 / 缺 title·body / 超上限：拒写且一行不留` | 空表 | 真 PG | 3 次非法保存 | 每次抛/返错；`prompt_versions` 行数仍 **0** |
| S4-84 | `PK::project 的未知占位符不校验（沿用现状），但仍受 12k 预算管` | — | 真 PG | 含 `{{nope}}` 的 project | 保存成功；超预算时抛 |
| S4-85 | `PK::回滚按 kind 独立：回滚 classify 不动 project 的指针与历史` | 两 kind 各 2 版 | 真 PG | 回滚 classify | classify 指针回 v1；project 指针与行数不变 |
| S4-86 | `PK::恢复默认：指针回 0、历史仍在；之后还能回滚回项目版本` | project 有 2 版 | 真 PG | restore → rollback | restore 后指针 0 且行数不变；rollback 后指针回 2 |
| S4-87 | `PK::project 关掉开关 = 不注入（其它三条线不受影响）` | `prompt.enabled=false` | 真 PG | 读 4 个 kind | project 返回空；三个阶段 kind 不受影响 |

### 3.6 S5 面板（49）

#### S5-a `P-PAGE` 流水线页（5）

| ID | 文件::用例名 | 前置状态 | 注入 / 假实现 | 输入 | 断言 |
|---|---|---|---|---|---|
| S5-01 | `P-PAGE::页头：eyebrow 说明范围 + h1「流水线」+ 阶段配置入口` | mock `/api/issues`、`/api/repos/:o/:r/settings` | msw mock | 渲染路由 | h1 1 处；入口链接的 href 含 `#pipeline` |
| S5-02 | `P-PAGE::指标条：四格都在；「今日自动关闭」没有数据源 → —，并在 title 里说明缺哪个接口` | 同上 | 同上 | 同上 | 四格；`closed_at` 那格文本为 `—` 且 `title` 含缺的接口名 |
| S5-03 | `P-PAGE::阶段看板：四列 + 未入流水线一组，列底有口径、卡点开进详情` | 同上 | 同上 | 同上 | 列数 5（含未入流水线）；卡片点击后 href 指向 issue 详情 |
| S5-04 | `P-PAGE::门禁处置表：§8 的七行，状态用徽章、理由在 faint 列` | — | 同上 | 同上 | 行数 **7**（七行口径逐行） |
| S5-05 | `P-PAGE::右列：系统常量带「只读」、提示词指针两种形态、会话健康缺的写 —` | — | 同上 | 同上 | 常量 5 项且都带只读徽章；指针两种形态各 1 处；会话健康为 `—` |

#### S5-b `P-VIEW` 聚合与阶段时间线（11）

| ID | 文件::用例名 | 前置状态 | 注入 / 假实现 | 输入 | 断言 |
|---|---|---|---|---|---|
| S5-06 | `P-VIEW::pipeline === null 单独成组「未入流水线」，不进任何阶段列` | 3 条 issue，1 条 `pipeline:null` | 纯组件 props | 聚合函数 | 未入流水线组 1 条；三个阶段列合计 2 条 |
| S5-07 | `P-VIEW::列内按停留时长降序（等得久的在前）` | 3 条不同停留 | 同上 | 同上 | 顺序为时长降序 |
| S5-08 | `P-VIEW::指标：在流水线不含已结束；待人补充带最久时长；阻塞带最大失败次数；今日自动关闭 → null` | 混合状态 | 同上 | 同上 | 在流水线数不含 closed；最久时长等于最大值；失败次数等于最大值；自动关闭为 `null` |
| S5-09 | `P-VIEW::会话健康：只统计有 sessionId 的行；已归档没有接口 → null；接近轮换按 25 轮算` | 3 条（1 条无 sessionId） | 同上 | 同上 | 统计 2 条；已归档 `null`；`turns>=25` 计入接近轮换 |
| S5-10 | `P-VIEW::四列 + 列头计数 + 未入流水线一行` | — | 同上 | 渲染 | 列头计数与数据一致；未入流水线 1 行 |
| S5-11 | `P-VIEW::永远三段；已过的段是「已通过」，当前段是状态徽章，后面的段是「未开始」` | 行 `classify/awaiting_info` | 同上 | 渲染时间线 | 段数 3；三个段的状态文案各 1 次 |
| S5-12 | `P-VIEW::关键事实：格式失败次数 / 分类结论 / 会话轮次都在，缺的写 —` | 行有部分字段 | 同上 | 渲染 | 三个字段各 1 处；缺失字段显示 `—` |
| S5-13 | `P-VIEW::没有流水线行时不画三段，只说一句事实` | `pipeline:null` | 同上 | 渲染 | 时间线节点 0 个；提示 1 句 |
| S5-14 | `P-VIEW::按 rule 前缀切栏：code → 代码引用（path:line 拆开），checked → 已查范围，其余单列` | 混合 evidence | 同上 | 聚合 | 三栏条数与 evidence 一致；`path:line` 被拆成两段 |
| S5-15 | `P-VIEW::渲染成两栏 + 等宽引用` | — | 同上 | 渲染 | 两栏各 1 个；引用节点 1 个 |
| S5-16 | `P-VIEW::没有证据时两栏都是 —，并说明这一版信封没有 evidence` | `pipeline.evidence` 为空数组 | 同上 | 渲染 | 两栏各显示 `—`（2 处）；说明句 1 处 |

#### S5-c `P-SET` 设置页流水线分区（14）

| ID | 文件::用例名 | 前置状态 | 注入 / 假实现 | 输入 | 断言 |
|---|---|---|---|---|---|
| S5-17 | `P-SET::缓存命中前先渲染出 managers chips（mock 的 alice / bob），每个都能移除` | mock settings | msw | 渲染 | chip 2 个；点移除后剩 1 个 |
| S5-18 | `P-SET::回车添加、逗号批量添加、大小写不敏感去重、退格删最后一个` | 同上 | 同上 | 4 种输入 | 每次 chip 数量断言精确 |
| S5-19 | `P-SET::管理人员清空后：保存禁用 + title 说明原因` | managers 清空 | 同上 | 交互 | 保存按钮 `disabled`；`title` 含原因 |
| S5-20 | `P-SET::系统常量只读区：五个数字都在，且带「只读」徽章` | — | 同上 | 渲染 | 5 个数值；只读徽章 5 处；无输入控件（0 个） |
| S5-21 | `P-SET::缺标签角色时给一行 warn + 去标签分区的链接；齐了就不显示` | 两种 vocabulary | 同上 | 渲染 | 缺时 warn 1 行 + 链接 href 含 `#labels`；齐时 0 行 |
| S5-22 | `P-SET::hash 决定默认 tab：#prompt/format_check 刷新后仍是格式检查` | hash `#prompt/format_check` | 同上 | 渲染 | 激活 tab 为 format_check（1 个） |
| S5-23 | `P-SET::点 tab 切到「分类」：面板换、hash 记在地址上、别的 tab 的正文草稿不丢` | — | 同上 | 点击 | hash 变为 `#prompt/classify`；原草稿仍在（1 处文本） |
| S5-24 | `P-SET::#pipeline 与路径不一致时深链接到流水线分区（刷新不丢）` | hash `#pipeline` | 同上 | 渲染 | 滚到流水线分区；面包屑/hash 保持 |
| S5-25 | `P-SET::字符计数 + 超限禁用（阶段 kind 用 limit，不是 P1 预算）` | — | 同上 | 输入 8001 字符 | 计数显示；保存按钮 `disabled` |
| S5-26 | `P-SET::恢复默认要二次确认：取消不发请求，确认才 POST …/prompt/restore?kind=` | — | msw 记请求 | 点击 | 取消时请求 **0 次**；确认时 1 次且 URL 含 `?kind=` |
| S5-27 | `P-SET::层序预览：dropped 的层显式列出，head / tail 标成不可丢` | mock 层序 | 同上 | 渲染 | dropped 层 1 行；head/tail 标「不可丢」各 1 处 |
| S5-28 | `P-SET::agent tab 显示它对 P1 预算的影响（V18）` | agent v1 4000 字符 | 同上 | 渲染 | available 数值 1 处且 ≥2000 |
| S5-29 | `P-SET::角色下拉把词条改成「需求」，覆盖提示消失后保存可用` | vocabulary 无 requirement | 同上 | 交互 | 改前 warn 1 行、保存 `disabled`；改后 warn 0、保存可用 |
| S5-30 | `P-SET::新增词表项默认 role=other（契约必填，不能留空）` | — | 同上 | 点新增 | 新行 role 值为 `other`（1 处） |

#### S5-d `P-USE` / `P-API` 提示词客户端（17）

| ID | 文件::用例名 | 前置状态 | 注入 / 假实现 | 输入 | 断言 |
|---|---|---|---|---|---|
| S5-31 | `P-USE::请求带 ?kind=，四个 kind 各自一份缓存` | — | msw | 4 次取数 | 请求 4 次且各带 `?kind=`；缓存 4 份 |
| S5-32 | `P-USE::保存走 PUT …/prompt?kind=：响应写回自己的缓存，并把别的 kind 标脏重取` | — | msw | 保存 format_check | PUT 1 次；其它 kind 重取 ≥1 次 |
| S5-33 | `P-USE::project：v2 项目版，有 project 层，head / tail 不可丢` | mock fixture | — | 渲染 | project 层 1 个；head/tail 不可丢各 1 处 |
| S5-34 | `P-USE::format_check：系统默认（指针 v0、无项目版本），只读默认正文带必填占位符` | 同上 | — | 渲染 | 指针 0；默认正文只读；含 `{{title}}`/`{{body}}` |
| S5-35 | `P-USE::classify：v2 项目版，上限 8000（不是 P1 预算）` | 同上 | — | 渲染 | 上限显示 8000（1 处） |
| S5-36 | `P-USE::agent：v1 项目版，上限 4000（它计入 baseChars…）` | 同上 | — | 渲染 | 上限显示 4000（1 处）；含预算提示 1 处 |
| S5-37 | `P-USE::format_check 缺 {{title}} / {{body}}：显示「格式检查必须包含 …」` | 400 响应 | msw | 保存 | 错误文案 1 处含两个占位符名 |
| S5-38 | `P-USE::未知占位符：显示「未知占位符：{{nope}}」` | 400 响应 | msw | 保存 | 文案里出现 `{{nope}}` 1 次 |
| S5-39 | `P-USE::超上限：面板显示「超出 8,000 字符」（服务端 400 body-too-long）` | 400 响应 | msw | 保存 | 文案 1 处含 `8,000` |
| S5-40 | `P-API::省略 kind：不带查询串（旧调用点行为不变）` | — | 假 fetch | 调 `api.prompt` | URL 不含 `kind=` |
| S5-41 | `P-API::给 kind：?kind= 落进查询串；{owner,name} 形式也走同一条路径` | — | 假 fetch | 两种写法 | 两种 URL 都含 `?kind=`，且路径一致 |
| S5-42 | `P-API::PUT + ?kind= + CSRF 头 + JSON（带 note）` | — | 假 fetch | `savePrompt` | 方法 PUT 1 次；头含 CSRF；体含 note |
| S5-43 | `P-API::不给 note：请求体里就没有 note 这个键` | — | 假 fetch | 同上 | 体里 `note` 键不存在 |
| S5-44 | `P-API::400 的 details.code 原样进 ApiError（面板据此选文案）` | 400 响应 | 假 fetch | 调用 | `error.code==='body-too-long'` |
| S5-45 | `P-API::rollback：POST + ?kind= + {version}` | — | 假 fetch | 调用 | POST 1 次；体含 version |
| S5-46 | `P-API::restore：POST + ?kind= + 没有请求体` | — | 假 fetch | 调用 | POST 1 次；无 body |
| S5-47 | `P-API::versions：GET /prompt/versions?kind=（不跑装配预览的那条轻量路径）` | — | 假 fetch | 调用 | GET 1 次；URL 含 `/prompt/versions?kind=` |

#### S5-e `P-COL` issue 列表四列（2）

| ID | 文件::用例名 | 前置状态 | 注入 / 假实现 | 输入 | 断言 |
|---|---|---|---|---|---|
| S5-48 | `P-COL::阶段 / 类别 / 停留 / 尝试 都从 pipeline 投影；超过 24h 用警示色` | 3 条 issue（1 条 >24h） | props | 渲染列表 | 四列都有值；1 行带警示样式 |
| S5-49 | `P-COL::阶段筛选生效且不再发请求；「未入流水线」是一等选项` | 同上 | 假 fetch 计数 | 选筛选 | 行数变化正确；请求 **0 次**；选项里有「未入流水线」 |

---

## 4. 重点边界清单（逐条现状）

| # | 边界 | 现状 | 判定用例 / 缺什么 |
|---|---|---|---|
| B1 | 无 `issue_pipeline` 行 → `@` 放行 + 懒创建 `agent/ready` | **已覆盖** | `S1-46`（放行 `/review-pr` 且行变 `agent/ready`）、`S1-24`（`loadPipeline` 返回 null）、`S1-26`（`createReadyRow`）。反例侧也钉住了：`S1-40` 没有行时**指令**不执行，与「放行只针对 @」的规格一致 |
| B2 | `format/awaiting_info`（`info_requested_at` 非空）与 `classify/awaiting_info`（NULL）互不误判，48h 扫描只打前者 | **已覆盖** | `S1-27`/`S1-28`（两种 awaiting 落库后一非空一 NULL）、`S1-20`/`S1-21`（状态机 auto-close 只吃前者）、`S2-43`（扫描 SQL 自带 `info_requested_at IS NOT NULL`）、`S2-44`/`S2-45`（真库正反例） |
| B3 | 评论优先与 120s 冷却让位 | **部分** | 正向：`S1-56`（评论后编辑让位，`tasks` 仍 1 行）；置顶：`S4-25`/`S4-69`。**反向缺失**（先编辑后 120s 内评论仍立即触发，§16.2 第 3 条末句）→ **P1-1**。另：冷却判断在 `webhook.ts::pipelineTransitionFor`（`:1713-1727`），无直接用例 → 一并由 P1-1 覆盖 |
| B4 | 幂等锚 `pipeline:format:<issueVersion>:<commentId>` 重投不新增任务 | **部分** | 行为已覆盖：`S1-55`（同 commentId 重投 → `tasks` 仍 1 行）、`S2-20`、`S3-12`。**锚的字符串形状无断言**（`pipelineAnchor()` 在 `pipeline.ts:480`，无单测）→ **P2-5**（拼错锚不会挂，只会让幂等静默失效） |
| B5 | `PIPELINE_FORMAT_MAX_FAILS=2` 注入 → 关 issue 且无新任务 | **已覆盖** | `S2-11`（纯函数：第 2 次 `fail-closed`、`shape=[comment,closeIssue]`）、`S2-10`（`effects.enqueue` 为空）、`S2-21`/`S2-22`（执行面 `closeIssue` 恰好 1 次）、`S1-08`（状态机同阈值） |
| B6 | `stage.name` 与任务阶段不一致 → `blocked` 且零写入 | **已覆盖** | `S3-09`（`comments===[]`、`labels===[]`、`category===null`、`mentionSentAt===null`、`state==='blocked'`）、`S2-33`（`stage-mismatch`）、`S2-32`（`missing-stage`） |
| B7 | 无 `path:line` 的 defect → 降级 not-found 且停 `classify/awaiting_info` | **已覆盖** | `S3-03`（`labels===[]`、`comments.length===1` 含 `/cc @alice`、行 `{classify, awaiting_info, infoRequestedAt:null}`）、`S2-37`/`S2-38`（`downgraded===true`） |
| B8 | 配置严格性（`managers` 空 / 缺 `role` / 含已删键 `triggers.faces`、`pipeline.enabled`） | **已覆盖** | `S0-C02`、`S0-C05`、`S0-C06`、`S0-C10`、`S0-R11`（非法不写库）。**HTTP 层 `PUT /settings` 的 400 无 inject 用例**（错误映射靠 `S0-R11` 的 store 层反推）→ 归入 **P2-3** |
| B9 | `agent` 4000 上限与 `baseChars` 挤占 P1（V18） | **已覆盖** | `S4-57`（`available>=2000`）、`S4-58`/`S4-59`（随 agent 长度线性变化、不为负）、`S4-60`（`stats.baseChars`）、`S4-64`（上限表 4000）、`S5-28`（面板显示影响） |
| B10 | 输出契约不可配（V16） | **部分** | 契约永远在最后：`S4-21`、`S4-52`、`S4-48`。**缺「项目版 agent 提示词 + 坏信封 → 校验仍生效」的同一条用例** → **P1-5** |
| B11 | 会话复用（两次 `@` 同 `session_id`、`session_turns` 递增、`archive` 0 次、`after=cursor` 不重放） | **已覆盖** | `S4-07`（`attach` 2 次同 id、`archive` 0、`after=[3,4]`、`turns: 4→6`、`cursor: 3→4`）、`S4-37`/`S4-38`、`S4-43` |
| B12 | 30 轮 / 7 天轮换 | **已覆盖** | `S4-04`/`S4-05`（纯函数）、`S4-08`/`S4-09`（执行面 `archive` 1 次 + `blockedReason='session-reset'` + `turns` 从 1 起）、`S4-06`（29 轮/6 天不轮换） |
| B13 | 门禁回执每小时 1 条限速 + `running` 只 eyes 零任务 | **已覆盖** | `S1-49`（同小时第 2 条 → `notice` 仍 1 条、`eyes` 2 次）、`S1-61`（>1h 放行）、`S1-50`（`running`：`sends` 0、`tasks` 0、`eyes` 1）、`S1-52`（`closed` 静默） |
| **B14** | **门禁回执不得改动 `issue_pipeline` 任何字段** | **缺失（P0 回归）** | `S1-48` 只断言 `gateNoticeAt===NOW`，**没有断言 `stage`/`state`/`info_requested_at`/`last_recheck_at`/`mention_sent_at` 原封不动**。实现点在 `webhook.ts:1273`（`applyTransition(db, key, { gateNoticeAt: at })`），而 `buildUpdateStatement`（`pipeline.ts:282-302`）总会追加 `updated_at = now()`。→ **P0-1** |
| **B15** | **`blocked` 在连续 2 次失败后可达** | **部分（P1 回归）** | 纯函数/执行面都覆盖了（`S2-14`、`S3-09`、`S3-10`、`S3-11`），但真正修掉的那一行在接线层：`compose.ts:848` `consecutiveFailures: params.row.attempt + 1`。**没有用例让同一条任务失败两次并断言 `state='blocked'`** → **P1-3** |
| **B16** | **`triggers.enabled` 的边界（P8）：`false` 只关 `@` 提及类触发（`/命令` + 提问），流水线一个字不改** | **已覆盖（2026-11-12 补齐）** | 实现：`webhook.ts::handleWebhook` 读完 policy 把 `triggersEnabled` 传给纯函数 `decideWebhookTask`（纯函数不查库），只在「有 @ 且被识别成命令/提问」的评论上判 ignore（`reason=triggers-disabled`，**不打回执**）。用例：`WH-TD`（10 条）——`enabled=false` 下 `issues.opened` 仍产 `pipeline:format`、`format/awaiting_info` 作者评论与 `classify/awaiting_info` managers 评论仍重跑、`@bot /review-pr`（issue/PR）与 `@bot 提问` 0 任务且投递落 1 行；`enabled=true`／缺省三种场景照常建任务（防改反）。旧说法「`webhook.ts` 只取别名、不读 `enabled`，是碰巧对」已不成立 |

---

## 5. 夹具与假实现清单

### 5.1 现有可复用

| 名称 | 位置 | 用途 / 注意 |
|---|---|---|
| `validRepoSettings(overrides)` | `apps/server/test/helpers/repo-settings.ts:41` | 合法 `repos.settings` 普通对象；`pipeline` 段做一层深合并（改指针不用重写 `managers`） |
| `parseValidSettings(overrides)` | 同上 `:50` | 过一遍契约，拿 `RepoSettings` 类型（`labels.vocabulary` 需要它时才用） |
| `validSettingsJson(overrides)` | 同上 `:55` | 落库用 jsonb 字面量（`$n::jsonb`） |
| `TEST_MANAGER='alice'` | 同上 `:31` | 与 webhook 夹具的 `sender.login` 对齐 |
| `vocabularyWithRoles(entries)` / `inferLabelRole(name)` | 同上 `:73` / `:89` | 给词表补必填 `role`；名字带「缺陷/需求」时自动推断 |
| `openTestDb()`、`TestDb` | `apps/server/test/helpers/queries-db.ts` | 真 PG + 公共 truncate；**`issue_pipeline` 不在 truncate 清单里**，每个文件要自己 `delete from issue_pipeline where repo = $1` |
| `createFakePorts` / `fake-pi-host.ts` / `fake-github.ts` | `apps/server/test/helpers/*` | 装配级（`createApplication`）用例的假 host / 假 GitHub |
| `pipelineRow(over)` | `FP:24`、`SM:41` 等各自文件内 | 造 `PipelineRow`；每个文件一份，**签名一致**，可上提 |
| `envelope(result, comment[, evidence])` | `FP:55`、`FE:76`、`CP:92` | 造带 `stage` 的信封；`CP` 版多一个 `stageName` 参数用于造「冒充」信封 |
| `shape(plan)` | `FP:81` | 把 actions 压成 `comment:model` / `label:x` / `reaction:rocket` / `closeIssue`，**断言动作次数靠它** |
| `createFakeApi()`（format） | `FE:26` | 记 `calls: {kind, detail}[]`，可 `{failClose:true}` 造关闭失败 |
| `createFakeApi()`（classify） | `CP:72` | 记 `comments: string[]` / `labels: string[][]` |
| `createFakeReactions()` | `FE:48` | 记 `calls: string[]`（`rocket` / `confused`） |
| `createFakeRacp()` + `callsOf(method)` | `SES:229` / `:312` | 假 RACP 通道，按方法名过滤（`session/attach`、`events/subscribe`…） |
| `createCountingGithubApi()`、`createFakeQueue()`、`quietMetrics()`、`stubMetricsServer()`、`poolWithNoopEnd()` | `SES` 内 | 装配级跑 `executeTask` 的最小依赖集 |
| 假 PG boss（`work` 计数） | `JOBS` 内 | 断言「注册了哪几个队列」 |

### 5.2 建议补的（签名写出来）

```ts
// apps/server/test/helpers/pipeline-fixtures.ts
import type { PipelineRow } from '../../src/workflows/pipeline.ts';

/** 一行 issue_pipeline；默认 format/pending，其余列按 §4.3 给中性值。 */
export function pipelineRow(over?: Partial<PipelineRow>): PipelineRow;

/** 带 stage 的信封；stageName 与 result 解耦，用于造「冒充」与「缺 stage」。 */
export function stageEnvelope(input: {
  readonly stage: 'format' | 'classify';
  readonly result: string;
  readonly comment?: string | null;
  readonly evidence?: readonly { readonly rule: string; readonly quote: string }[];
  readonly stageName?: string;
}): unknown;

/** 记调用的 GitHub 写面（评论 / 标签 / 关闭 / reaction 四类分开计数）。 */
export function createRecordingGithub(init?: { readonly failClose?: boolean }): {
  readonly api: FormatWriteApi & ClassifyWriteApi;
  readonly comments: string[];
  readonly labels: string[][];
  readonly closes: number;
  readonly reactions: string[];
};

/** 一次「整行快照」，字段名与库一致（`snake_case`），给 B14 类断言用。 */
export async function snapshotPipelineRow(
  db: PipelineQueryable,
  key: { readonly repo: string; readonly issueNumber: number },
): Promise<Record<string, unknown>>;

/**
 * B14 的关键断言：除 gate_notice_at / updated_at 外，其它列**逐字段不变**。
 * 失败时打印出哪个列被顺手改了（这是 P0 的复发形态）。
 */
export function expectOnlyContributorColumnsChanged(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  allowed: readonly string[], // 例如 ['gate_notice_at', 'updated_at']
): void;

/** 跑一条 `pipeline:notice` 任务（装配级），返回 report 与评论计数。 */
export async function runNoticeTask(
  app: Application,
  deps: { readonly db: TestDb; readonly repo: string; readonly issueNumber: number },
): Promise<{ readonly report: TaskRunReport; readonly comments: string[] }>;

/** 把 0005 迁移跑进当前库（空库场景），供 V17 的「迁移后存量」用例复用。 */
export async function applyMigration0005(pool: Pool): Promise<void>;

/** 旧形状 settings：含 triggers.faces、词表无 role、pipeline.enabled=true（V17 负例）。 */
export function legacyShapeSettings(): Record<string, unknown>;
```

---

## 6. 缺口与建议

### 6.1 A 类：实现已做，但没有测（按优先级）

| 编号 | 缺口 | 一句可执行的补测动作 | 状态 / 用例位置 | 理由 |
|---|---|---|---|---|
| **P0-1** | 门禁回执只许写 `gate_notice_at`（B14，最近修掉的 P0 无回归） | 在 `WH` 新增「notice 不改行」用例：先 `snapshotPipelineRow`，投一条 `@pi-bot /review-pr`（行 `format/awaiting_info`），再快照，断言 `expectOnlyContributorColumnsChanged(before, after, ['gate_notice_at','updated_at'])` 且 `after.gate_notice_at===NOW` | **已补（4 条）**·`apps/server/test/pipeline-gate-no-state-push.test.ts`（三种「被拦」状态各 1 + 第二次 @ 仍只 eyes 1） | 回执是最高频路径（每条被拦命令都走），一旦顺手写 `state`，`awaiting_info` 会被抹成 `pending`，48h 关闭与补充通道全部失效 |
| **P0-2** | `pipeline:notice` 的执行面（「回 1 条 AI 评论」只有渲染层断言） | 在 `WH` 或新文件里用 `createApplication().executeTask()` 跑一条真 `pipeline:notice` 任务，断言 `createIssueComment` **1 次**、`addLabels` **0 次**、`issue_pipeline` 行不变 | **已补（5 条）**·`apps/server/test/pipeline-notice-comment.test.ts`（awaiting_info / running / 限速 / 兜底句 4 条执行面 + 兜底句纯函数 1 条） | V8 判据的「1 条 AI 评论」是用户唯一能感知的东西；现在只有 `renderGateNoticePrompt` 单测，写回闸门（`source='pipeline'` 且 command 白名单才允许评论，§4.6）在这条路径上没被跑过 |
| **P1-1** | 评论优先的**反向**（编辑后 120s 内评论仍立即触发，§16.2 第 3 条末句） | 在 `WH` 新增：先投 `issues.edited`（`tasks` 变 1 行），紧接着投作者评论，断言 `tasks` 变 **2 行**且第 2 行 command 仍 `pipeline:format` | **已补（1 条）**·`WH::评论优先的反向（P1-1）`（口径按真实时序收紧，见下方备注） | 现有一条只测了「评论→编辑让位」；反向若被写反（冷却也挡评论）会静默丢补充信息，用户以为机器人没收到 |
| **P1-2** | V4 端到端：评论触发 → 新任务 pass → **恰好 1 条确认评论** | 用装配级 harness：`format/awaiting_info` + 作者评论 → 跑掉入队的 `pipeline:format` 任务（pass 信封、无评论动作）→ 断言 `createIssueComment` **1 次**且是兜底确认句、行 `{classify,pending}`、`tasks` 恰好 2 行 | **未补** | 判据是「两段合成一条链」，现在两段分处 `WH`（触发）与 `FP`（确认文案），中间的 `confirmComment` 效果在装配层没有一条用例验证 |
| **P1-3** | 接线层的 `blocked` 可达（`compose.ts:848` 的 `attempt+1`） | 在 `SES`/新文件里跑同一条 `pipeline:format` 任务两次（`attempt=0`、`attempt=1`），两次都给坏信封，断言第 2 次后行 `state==='blocked'`、`blockedReason` 非空、`createIssueComment` **0 次** | **已补（2 条）**·`apps/server/test/pipeline-blocked-after-retry.test.ts`（连续 2 次失败 → blocked；成功一轮后再失败不 blocked） | P1 就是这个字段推错了（永远只算 1），修完没有接线层用例；纯函数用例给了 `consecutiveFailures=2` 是**喂进去**的，不是算出来的 |
| **P1-4** | V10 的「不可绕过」：`triggers.enabled=false` + 源码级 `auto:triage` 断言 | ① 在 `WH` 新增一条：`seedRepo({settings:{...VALID, triggers:{...VALID.triggers, enabled:false}}})` + `issues.opened` → 断言仍 `tasks[0].command==='pipeline:format'`；② 照 `no-merge.test.ts` 的范式加 `no-auto-triage.test.ts`，扫 `apps/server/src` 不存在 `'auto:triage'` 任务分支 | **已补（1 + 3 条）**·`WH::V10 不可绕过：triggers.enabled=false 不影响流水线（P1-4）`（1）+ `apps/server/test/no-auto-triage.test.ts`（3）。**2026-11-12 再补 10 条**（`WH-TD`）：把「提及类触发真的被关掉」这一半也钉住（原来只测了「不影响流水线」） | 规格 §16.1 第 3 条把这两条写成硬判据；`triggers.enabled=false` 当时是「碰巧跑得通」（不读 `enabled`），所以既要行为用例（现在会读它、必然关掉命令/提问）也要「流水线不受影响」的反向用例，缺一头就会在改动时静默回退 |
| **P1-5** | V16 的后半句：项目版 agent 提示词 + **坏信封** → 校验仍生效 | 新增：`savePrompt(kind:'agent', body:'不要输出 JSON')` → `buildStagePrompt({stage:'agent'})` 的最终 prompt 末尾含契约；再把该 prompt 跑一条返回「非 JSON」的任务，断言 `envelopes.valid===false` 且 `failure_class==='parse'`、`actions` 0 行 | **未补** | 现在前半句（契约在末尾）与后半句（校验生效）分属两个文件，没人验证「换了提示词之后校验还在」 |

> 备注（2026-11-11 补测时确认的两条口径）：
>
> - **P1-1 为什么不是逐字照原方案写**：原方案（「编辑先到 → 紧接着评论 → `tasks` 2 行」）在当前实现上**跑不通**，而且不是冷却写反：`issues.edited` 自己会把行推进成 `format/pending`（`workflows/pipeline.ts:877-885`），而 `decideSupplementOutcome()`（`http/webhook.ts:1647-1649`）把 `pending` 与 `running` 一律当「正在跑 → 只打 eyes」，评论在那一步就被丢掉。冷却本身只作用于编辑（`pipelineTransitionFor()` 仅在 `action === 'edited'` 分支读 `recheckCooldownElapsed`，`webhook.ts:1776-1781`），所以「评论被冷却挡住」这个回归不存在。用例因此按**真实时序**写：编辑先到（1 行任务、`last_recheck_at=NOW`）→ 这一轮不通过回到 `format/awaiting_info` → 120s 内的作者评论仍立刻产第 2 行 `pipeline:format`（补充正文也在第 2 行里）。「编辑后立刻评论也要单独触发」属于产品口径问题（与 §8「`pending` 只打 eyes」冲突），要改的是 `decideSupplementOutcome`，不该在测试里假定。
> - **P1-4 为什么拆两处**：`triggers.enabled=false` 在 2026-11-11 时是投递层的「碰巧对」（`webhook.ts` 当时只取别名、不读 `enabled`），行为用例只能钉住现状；源码级 `auto:triage` 零命中只有扫源码能钉，故拆成 `WH` 一条 + 新文件三条（扫到源码 / 扫描面覆盖 `http·workflows·queue·worker` / 零命中）。**2026-11-12 更新**：`enabled` 现在是**真的**被读（`handleWebhook` → `decideWebhookTask` 的 `triggersEnabled`），于是「关掉命令/提问」与「流水线照跑」两侧都需要用例，`WH-TD` 的 10 条补的就是这个交叉矩阵。

### 6.2 B 类：规格要求但实现/测试都没有

| 编号 | 缺口 | 一句可执行的补测动作 | 状态 / 用例位置 | 备注 |
|---|---|---|---|---|
| **P2-1** | `pipeline:classify` 必须跑 **sandboxed**（D6 + 30 分钟闸） | 为 `compose.ts:204-210` 的 `PIPELINE_RUNTIME_MODE` 加单测：断言 4 个 command 的映射，并用装配级用例断言 `pipeline:classify` 任务的 `report.runtimeMode==='sandboxed'` 且 `docker.create` 1 次 | **已补（2 条）**·`apps/server/test/pipeline-classify-runtime.test.ts`（映射表 1 + 装配级 1） | 现在只有 `pipeline:format → light` 有装配断言（`e2e-envelope-invalid.ts:151`）；映射表本身 0 用例，写错就是「分类不上容器」——流程看起来照跑，但查不到代码 |
| **P2-2** | V17 的「0005 迁移跑完后存量 settings 全部是新形状」 | 用 `applyMigration0005(pool)` 在含旧形状行的库上跑迁移，然后 `select settings from repos` 逐行 `parseRepoSettings` 断言全成功；再断言被丢空词表的仓库 `settings_valid=false` | **未补** | `CONST` 现有 4 条只断言 SQL **文本**；迁移里的 `jsonb` 运算写错不会红 |
| **P2-3** | HTTP 层：`PUT /api/repos/:o/:r/prompt?kind=` 的 400（未知占位符 / 缺 `{{title}}` / 超限）与 `GET` 的 kind 隔离；`PUT /settings` 的 400 | 在 `http-server.test.ts` 加 `app.inject`：非法占位符 → 400 且 `details.code`/名字、超限 → 400 `body-too-long`、`GET ?kind=classify` 不返回 project 正文 | **已补（6 条，2026-11-12）**·`HS::提示词 API（HTTP 层，P2-3）`：①`GET ?kind=classify` vs `?kind=project`（互不串味 + `limit`/`activeVersion`/`systemDefault`）②`GET ?kind=xxx` → 400 ③`PUT ?kind=format_check` 缺 `{{body}}` / 缺 `{{title}}` → 400 `placeholder-missing` + `missingPlaceholders` + 一行不写 ④`PUT ?kind=classify` 含 `{{nope}}` → 400 `placeholder-unknown` + `unknownPlaceholders` ⑤`PUT ?kind=agent` 4001 字符 → 400 `body-too-long` ⑥`POST ?kind=agent/restore` → 指针回 0、`GET` 回到内置默认。**剩半句**：`PUT /api/repos/:o/:r/settings` 的 400 仍只有 store 层断言（`S0-R11`），HTTP 层无 inject —— 本轮未做（不在这次改动面内），仍挂在 §4 B8 的备注上 | 面板侧已在 mock 上断言了文案（`P-USE`），**服务端路由一条都没测**——路由参数名写错也能「全绿」；补完后 `details.code` / 占位符名字 / `?kind=` 隔离都在真实路由上被钉住 |
| **P2-4** | V20 的「每次操作有审计记录」 | 在 `DIR` 里补断言：指令执行后 `webhook_deliveries` 恰好 1 行（`deliveryId` 对应）、`tasks` 1 行、日志 logger 收到 1 条带 `directive=` 的记录 | **未补** | 现在只断言 `tasks`；`webhook.ts:1743` 写的审计口径（投递行 + 任务行 + 日志）没被测 |
| **P2-5** | 幂等锚的字符串形状（B4） | 给 `pipelineAnchor()` / `supplementAnchor` 加单测：`pipelineAnchor('format','v1')==='pipeline:format:v1'`，补充锚 `==='pipeline:format:v1:777'` | **已补（5 条）**·`apps/server/test/pipeline-anchor-shape.test.ts` | 锚拼错不报错，只让幂等静默失效——最难查的一类回归 |
| **P2-6** | V13 的「三个阶段 `session_id` 两两不同」 | 在 `SES` 补一条：`pipeline:format`（light）、`pipeline:classify`（sandboxed）、两次 `@answer` 依次跑，断言 format/classify 后 `session_id` 均为 NULL、两条 `@` 后为同一非空 id，且 `session/archive` 共 3 次（阶段 0/1 各 1 + 无轮换时 0） | **未补** | 现在只有 format=null 有断言；classify 阶段没有装配级用例 |
| **P2-7** | V14 真实环境验收 | 写一个 `docs/manual-acceptance.md`（或 `scripts/acceptance/*.ps1`）走 3 个真实 issue：不合规 / 合规 / 缺陷，核对「评论 1 条 / 0 条 / 1 条 + `/cc` 点到人」与 `issue_pipeline` 三行状态 | **未补** | 自动化测试用假 GitHub，`@` 是否真点到人、评论是否被 GitHub 拒（权限/长度）只有真环境能验 |
| **P2-8** | 面板「今日自动关闭」「已归档」缺数据源（`impl-fixed-pipeline.md` §8 已知缺口 1） | 先补 `closed_at` / 会话归档状态到 `GET /api/issues` 投影，再把 `P-PAGE::指标条`、`P-VIEW::会话健康` 的 `—` 断言改成数值断言 | **未补** | 现在两条用例把「缺接口」写成期望值；接口补上后这两条会**假绿**，需要同步改 |

> 备注（2026-11-11）：**P2-1 的「4 个 command」按实际收敛为 3 条 + 1 条反例**——`PIPELINE_COMMANDS` 只有
> `pipeline:format` / `pipeline:classify` / `pipeline:notice` 三条，表里也只该有这三条（映射表键集合与
> `PIPELINE_COMMANDS` 逐项相等），非流水线命令（`/review-pr`、`@answer`、`/issue-triage`）**不进表**、
> 走 `compose.ts:1186` 的 `sandboxed` 缺省，故那一条写成「不在表内」。装配级用例同时钉住反面：
> 同一套假端口上 `pipeline:format` 跑完容器 0 次 / worktree 0 次，紧接的 `pipeline:classify` 各 1 次。

### 6.3 剩余待补清单（结论，按优先级）

> 2026-11-11 更新：P0-1/P0-2/P1-1/P1-3/P1-4/P2-1/P2-5 已补，以下为剩余。
> 前 5 条即原「最该补的 5 条」的位置被补完之后的新前 5；`P2-9` / `P2-10` 见 §7。
>
> 2026-11-12 更新：**P2-3 的 prompt 一半已补**（`HS` 6 条 inject，见 §6.2），已从下表移除；
> `PUT /api/repos/:o/:r/settings` 的 HTTP 层 400 仍缺（归 §4 B8）。

| 顺序 | 用例 | 一句话理由 |
|---|---|---|
| 1 | **P1-2** V4 的端到端链路（评论 → 重跑 → 恰 1 条确认评论） | 判据横跨两个文件（`WH` 触发 / `FP` 文案），中间 `confirmComment` 效果在装配层无人验证——P1-1 补完后，「评论 → 真的跑出确认评论」这条链仍是断的 |
| 2 | **P1-5** V16 后半句：项目版 agent 提示词 + **坏信封** → 校验仍生效 | 「契约永远在最后」已被钉住，「换了提示词之后信封校验还在」没有一条用例；这两半分开就有人把校验挪进提示词 |
| 3 | **P2-2** 0005 迁移跑完后存量 `settings` 全过新契约 | 现在只断言迁移 SQL 的**文本**；`jsonb` 运算写错（少删一个键、role 过滤反了）不会有任何红 |
| 4 | **P2-4** V20 的「每次操作有审计记录」（`webhook_deliveries` + `tasks` + 带 `directive=` 的日志） | 指令是唯一能改状态的入口，现在只断言 `tasks` 一行；`runDirective()` 的审计口径（投递行 + 任务行 + 日志）没被测 |
| 5 | **P2-6** V13 的「三个阶段 `session_id` 两两不同」 | 只有 `format=null` 有断言；`classify` 阶段没有装配级用例（补 P2-1 时已铺好跑 `pipeline:classify` 的 harness，成本已降到接近 0） |
| 6 | **P2-8** 面板「今日自动关闭」「已归档」缺数据源 | 两条用例把「缺接口」写成期望值，接口补上后会**假绿**，必须同步改 |
| 7 | **P2-7** V14 真实环境验收（3 个真实 issue） | 假 GitHub 验不了「`@` 是否真点到人 / 评论是否被拒」，只能手工脚本兜 |


---

## 7. 补充复核（独立核对：正文未列的 2 条）

> 本节是一次独立的用例核对补入的：第 1–6 节定稿后重扫了一遍 `apps/server/test`、`apps/server/src` 与 `migrations/`，
> 下面两条是正文（含 §4 边界清单与 §6 缺口账）没有覆盖到、且会在实现里**静默失效**的残留。
> 编号接 §6，仍然是「一句话可执行的补测动作」的口径。

| 编号 | 发现 | 为什么正文没兜住 | 一句可执行的补测 / 修正 |
|---|---|---|---|
| **P2-9** | `upsertRepo` 无参 seed 把 `settings_valid` 硬写成 `true`：`apps/server/src/config/repo-config.ts` 的 `REPO_SQL.upsert` 是 `VALUES ($1,$2,$3,$4::jsonb, true, null, …)`；而 Q4 之后 `defaultRepoSettings()`（`pipeline.managers: []`）**已不是合法运行配置** | §3.1 的 `S0-R07 / S0-R08 / S0-R09` 只断言「行数 / `source` / `enabled` / `dry_run`」，没有一条断言 `settings_valid` 列；`S0-R13` 验的是「列已经是 false 时」的读行为，不是「新建行时该写什么」 | 在 `REPOCFG` 加一条：`upsertRepo(db.pool, { repo })` 之后 `select settings_valid from repos` **必须为 false**，且 `readRepoPolicy(...).settingsValid === false`（列与读路径同口径）；`settings_error` 非空并含 `pipeline.managers`。**这条现在就会红**：实现侧要么把 `upsert` 的第 5 个参数改成 `validateRepoSettings(settings).ok`，要么让 seed 用一份合法默认 |
| **P2-10** | `apps/server/test/queries-issues.test.ts:438` 仍在用过渡列插 `repos`：`insert into repos (repo_full_name, enabled, dry_run, config, config_valid, config_error)` | `config / config_valid / config_error` 是 W1 之前的过渡列（`apps/server/src/db/schema.ts:146-150` 注明「W1 之后不再读」），`settings` 落到列默认 `{}` → 这些仓库在新契约下等于「配置不合法」。§5 与 §6 的迁移清单只扫到 `queries-db.ts` 与 `http-webhook*.ts`，没扫到这一处 | 改成 `insert into repos (…, settings, settings_valid) values (…, $n::jsonb, true)`，`settings` 用 `validSettingsJson()`（`apps/server/test/helpers/repo-settings.ts:55`）；改完确认该文件里凡涉及 `settings_valid` 与 issue 的 `pipeline` 投影的断言仍成立 |

> 两条都不是新功能，而是「迁移只做了一半」的残留：一条在**写侧**（列值说谎），一条在**测试夹具**（仓库在新契约下根本不合法）。
> 建议与 §6.3 的 5 条一起排期；P2-9 会先红，正好用来钉住 `upsert` 的 `settings_valid` 口径。
