# 技能验证报告（2026-11-12，issue 实测）

> 目标：用真实 issue 验证「issue 格式检查 / 需求分析 / 缺陷分析」三个技能是否正常、回答是否直观易懂、格式是否规范，并跟踪日志与数据库。
> 环境：本机 `pi-bot serve`（127.0.0.1:3000）+ 容器 `postgres18`（库 `pi_issue_bot`）+ 仓库 `Tioit-Wang/pi-issue-bot-test`（`dry_run=false`）。

## 1. 本轮改了什么

| 文件 | 改动 | 原因 |
|---|---|---|
| `apps/server/src/skills/builtin.ts` | 新增内置技能 `/req-analysis`、`/bug-analysis`（原 `/issue-analysis` 保留为通用兜底） | 需求分析与缺陷分析要分成两个技能 |
| `apps/server/src/http/webhook-v21.ts` | 新增 `explicitSkillOfComment()` / `withSkillFirstLine()`，评论里点名的技能覆盖模板首行 | **实测缺陷**：`issue_comment.created` 默认模板首行写死 `/issue-analysis`，导致 `@bot /bug-analysis` 永远跑通用分析 |
| `apps/server/src/git/repo-cache.ts` | `fetch()` 加有限重试（4 次、1s×n 退避，可注入） | 链路抖动一次 fetch 失败就把整条任务判成 `sandbox-crash` |
| `apps/server/test/skills-registry.test.ts` | 内置技能清单加入两个新技能 | 断言随实现同步 |
| `apps/server/test/v21-comment-skill.test.ts`、`repo-cache-fetch-retry.test.ts` | 新增单测（4 + 3 例） | 钉住上述两处行为 |

## 2. 逐技能结论

| 用例 | issue | 触发 | 结果 | 判定 |
|---|---|---|---|---|
| 格式检查（只有标题） | #35 `[Bug]`（正文空） | `issues.opened`（真实投递） | 结论「不合规」+ 说明依据是默认四条（仓库无模板/CONTRIBUTING）+ 逐项 `字段 → 缺 → 补法` + 明确「未打标签」 | **通过**（8/8） |
| 格式检查（合规 bug） | #36 | `issues.opened`（真实投递） | 只回了一句占位话「与第一段一致的说明（可省略这条动作）」 | **不通过**（模板/契约示例被直接抄入评论，退化输出） |
| 格式检查（一句话 bug） | #33 | `issues.opened` | run 因 `GIT_FETCH_FAILED` 失败，未产出评论 | 未取得证据 |
| 缺陷分析 | #36（评论 `@pi-bot /bug-analysis`） | `issue_comment.created` | 结论 + 依据 1/2/3（`文件:行`）+ 影响面 + 下一步 + 需作者补的信息；明确写「未定位到」并给出搜索词 | **通过**（7/8，扣分见 §4） |
| 需求分析 | #34 / #37（评论 `/req-analysis`） | `issue_comment.created` | 技能路由正确（`agent_messages.skill_ids=["req-analysis"]`、提示词首行 `/req-analysis`），但两次 run 都因 `GIT_FETCH_FAILED` 失败，未产出评论 | **未取得证据**（路由已验证） |
| 通用分析（兜底） | #32 | 评论 `@pi-bot /bug-analysis`（修复前） | 跑成了 `/issue-analysis`，但产出仍然合规：结论「未定位到」+ 搜索词 + 三条根因假设（标注推测）+ 影响面 + 下一步 | 说明缺陷已复现并定位 |

## 3. 「正文 @」与「评论 @」场景

| # | 场景 | 期望 | 实测 |
|---|---|---|---|
| M1 | 正文 `@pi-bot`（无技能词） | 走 `issues.opened` → `on_opened=issue-format`；@ 本身不换技能 | ✅ 一致（#35/#36 正文无 @；#28 历史样例含 @ 也按 opened 跑） |
| M2 | 正文 `@pi-bot /label-triage` | 仍按 opened 跑；首行正则只认首行 | ⚠️ 事件路径 `v21SkillIdsOf()` 只看**首行**，正文里的技能词不生效（按设计，但需在文档里写明） |
| M5 | 评论 `@pi-bot /技能名` | 命中该技能 | ✅ 修复后正确（`skill_ids=["bug-analysis"]`、首行 `/bug-analysis`）；修复前恒为 `/issue-analysis` |
| M7 | 评论 `@pi-bot/bug-analysis`（`/` 前无空格） | 不算技能命中 | ✅ `skill_ids` 回落到模板默认 `/issue-analysis` |
| M9 | 评论 `@pi-issue-bot-tioit /bug-analysis`（句柄不在 `comment.mentions`） | ignored | ✅ `decision=ignored` |
| M10 | 机器人自己的评论 | `ignore_bot` 拦住 | ✅ `decision=ignored` |
| M13 | 代码块/行内代码里的 `/技能名` | 引用不是调用 | ✅ 单测钉住（`maskCodeRegions`） |

## 4. 回答质量问题（打分表 8 分制）

- 通过样本（#35 格式检查、#36 缺陷分析）：结论先行、逐项证据、补法可执行、明确标注推测/未定位、@ 提问人，均达标。
- 扣分点（#36 缺陷分析、#37 格式检查）：评论正文里带出了 `AGENTMARK-9` 这个非人类可读的标记；#36 的 opened 回复是「与第一段一致的说明（可省略这条动作）」——**契约里的示例句被当成正文输出**，属退化输出，需要提示词侧堵住。
- 需求类 issue 被格式检查按「缺版本环境」判不合规（#37）：技能边界需要在 `issue-format` 正文里写明「需求类不要求复现步骤/环境」。

## 5. 日志与数据库检查点（本轮实际用到的）

```sql
-- 投递是否进来、决策是什么
select event, action, decision, received_at from webhook_deliveries order by received_at desc limit 10;
-- 任务与运行结果
select t.target_number, t.status, r.outcome, r.failure_class
  from tasks t left join runs r on r.task_id = t.id order by t.queued_at desc limit 10;
-- 技能是否真的被点名加载（本轮关键指标）
select issue_number, status, skill_ids from agent_messages order by created_at desc limit 10;
```

- `envelopes` 26 条全部 `valid=true`；`/healthz` 三项 ok；队列无积压。
- 全部失败都指向同一个信号：`sandbox-crash` ← `GIT_FETCH_FAILED` / `GIT_CLONE_FAILED`（git 出口链路间歇性不可用，重试常能成功）。

## 6. 未完成与阻塞

1. **fork 同步未完成**：`gh repo sync --force` 报 `git/refs/heads%2Fmain 404`；`POST /merge-upstream` 返回 409（fork 与上游有冲突）；`PATCH /git/refs/heads/main` 404；`git fetch/push` 走 https 报 `TLS ... unexpected eof`，SSH 可用但 209 MB 的对象传输在多次 5–7 分钟内没完成。按「远端为主」的意图，正确做法是 `git push --force` 覆盖 fork 的 `main`，需要一条稳定链路。
2. **fork 仓无法跑任务**：`Tioit-Wang/PI-Desktop` 首次 clone 在沙箱内 `exit 128`（新仓没有缓存，必须 clone）。已验证同一条链路对 `pi-issue-bot-test`（有缓存）可用。
3. **需求分析无成功样本**：两次 `/req-analysis` 都卡在 fetch 失败（路由已证明正确）。
4. **既有失败用例**：`apps/server/test/agent-serial-queue.test.ts` 4 个用例失败，**与本次改动无关**（stash 我的改动后同样失败）。

## 7. 现场变更说明（重要）

- 原 `serve` 进程被重启为「带日志的常驻实例」，日志在 `%PI_SCRATCH_DIR%\serve.log`，启动脚本 `launch-serve.cmd` + `runtime.env`（含新 webhook secret）。
- 原进程环境里的 **webhook secret 与 host 设备令牌不可恢复**：secret 已重置（GitHub 侧 dev webhook 用 `gh webhook forward --secret` 重新对齐），设备令牌通过重新配对（`connection/pair`）换新。
- GitHub 投递靠 `gh webhook forward --repo=Tioit-Wang/pi-issue-bot-test --events=issues,issue_comment --url=http://127.0.0.1:3000/webhook --secret=<…>` 常驻；该进程随终端退出即失效，需要重开。

## 8. 改在 `Tioit-Wang/PI-Desktop` 上重跑（2026-11-13）

### 8.1 为跑通做的三件事

1. **离线造缓存仓**：用本地已有的上游 `main` 对象（`e6461c7`，4083 个文件）在
   `~/.pi-bot/data/cache/Tioit-Wang/PI-Desktop.git` 建出缓存，`origin/main` 指向该提交。
2. **`ensureCache` 容忍拉取失败**：缓存已在时 fetch 失败只记 warn，让工作树照常建立
   （真的缺 ref 时由 `resolveSha()` 报更准确的错）。
3. **技能与提示词按项目适配**：三个技能以「项目级技能」写入该仓（不是改内置），
   并把 `agent.project_prompt` 设为 PI-Desktop 的仓库地图/必读/命令/语言规则。

### 8.2 结果（全部真实写回到 GitHub）

| 用例 | issue | 结果 | 评分 |
|---|---|---|---|
| 缺陷分析 | #7（`session_id` 注入导致 400） | 定位 `packages/agent-runtime/src/session-affinity.ts:68-84`、`provider-binding.ts:460-464`、`packages/shared/src/provider-presets.ts:404-408`；用测试断言**反驳**正文「anthropic-messages 不受影响」「responses 完全不受影响」两处说法；列出 3 条待补信息 | 8/8 |
| 需求分析 | #5（subagent 配置） | 指出入口已存在（`SubagentEditorSheet.tsx:395-468`、`SettingsPage.tsx:474`）、生效点 `runtime.ts:5181-5187`、改动面含 9 个 locale；3 条待确认各带默认建议；4 条验收含命令 | 8/8 |
| 需求分析 | #6（文件查看器标签页） | 给出 P0/P1/P2 分期与 2 条待确认，但**没有 `文件:行`** | 7/8 |
| 格式检查 | #4（低信息 bug） | 依据 `bug_report.yml` 逐字段判定，列出已合规项与两条补法 | 8/8 |
| 格式检查 | #3 / #7（信息完整的 bug） | 复现「照抄契约示例正文」——issue 上出现 `与第一段一致的说明（可省略这条动作）` | 修复后不再出现 |

### 8.3 本轮修掉的缺陷

- **契约示例被照抄**：`apps/server/src/app/worker-deps.ts` 的 JSON 示例里，`comment.body`
  是一句像正文的说明，模型在「无事可写」时原样抄进 actions → 写回成无信息量评论。
  修法：①示例正文改成明确的填空提示；②新增 `isPlaceholderCommentBody()`，
  写回时把占位句/空串丢弃（`worker.ts` 的 `executeActions`）；③契约补一条
  「无需动作时 `actions` 可给 `[]`」，避免模型被迫凑格式。
- 修完后 #3 的第三次判定：run `succeeded`，**没有**再往 issue 上贴占位评论。

### 8.4 仍然存在

- `#6` 的需求分析没有 `文件:行`（技能要求了，模型没做到）——可在技能的「输出」里把
  「至少 1 处 `文件:行`，否则写未定位到」提到更硬的位置。
- 合规类 issue 目前会被判「无需动作 → 静默」，作者收不到「合规」确认；如果希望有确认，
  应把 issue-format 的输出改成「合规时也发一条一句话确认」。
- 仓库同步（workflow scope）与代理节点稳定性仍是外部阻塞，与技能本身无关。

## 9. 改造：取消格式检查，改为「提议分析」（2026-11-13）

### 9.1 改了什么

| 位置 | 改动 |
|---|---|
| `apps/server/src/skills/builtin.ts` | 删除 `/issue-format`；新增 `/proposal-analysis`（≈2.3KB，刻意写短）；`DEFAULT_PROJECT_SKILL_NAMES` 换成它 |
| `packages/contract/src/settings-v21.ts` | `issues.opened` / `issues.edited` 默认模板首行 → `/proposal-analysis`，并新增一行「分析当前issue」 |
| `packages/contract/src/repo-config.ts` | `agent.on_opened` / `on_edited` 默认值 → `proposal-analysis` |
| 该仓技能库 | 软删 `/issue-format`，上传项目版 `/proposal-analysis` |
| 该仓 settings | `triggers.events['issues.opened'/'issues.edited'].prompt` 换成新模板；labels 词表加 `invalid` / `abuse` / `needs-info` |
| GitHub 标签 | 新建 `invalid`、`abuse`、`needs-info` |

「谩骂直接关闭」按你的要求**不实现为功能**：技能里规定「一句『已按滥用处理』+ `abuse` 标签，关闭交维护者执行」。

### 9.2 四条用例（真 issue，逐条跑）

| # | 输入 | 技能 | 分类/动作 | 回答要点 |
|---|---|---|---|---|
| 21 | bug，复现写 `rt`，带 0.22.0 / Win11 | proposal-analysis | `bug` | 判 bug；引用 `docs/spec/03-runtime/21-image-generation.md:16` + `apps/desktop/src/lib/composer-models.ts:41` 指出「可能是设计如此」，给出维护者确认与取消勾选的验证路径 |
| 22 | 提案（内置 Subagent 配置模型/强度） | proposal-analysis | `enhancement` | 归为提案；引用 `AgentSubagentsPage.tsx:286-305`、`SubagentEditorSheet.tsx:453`、`docs/adr/subagent-model-opt-in.md:55`；点出优先级链路需确认 |
| 23 | 闲聊（天气/打游戏/问别的软件） | proposal-analysis | `invalid` | 明确本仓只讨论 bug/需求/提案，说明不属于范围，并给出「改成提案」的写法 |
| 24 | 谩骂（「一群废物」「垃圾项目」） | proposal-analysis | `abuse` | 一句「已按滥用处理，交维护者关闭」+ 邀请另开正常 issue |

### 9.3 观测

- 4 条 `agent_messages.skill_ids` 全部 = `["proposal-analysis"]`。
- **技能不再被预算丢弃**：旧 4.7KB 技能时日志有 11 次 `truncated:["skill:..."]`；瘦身后（重启 17:44 之后）0 次。
- `pnpm -r typecheck` 6/6；相关单测 74 个通过。

### 9.4 仍待处理

1. 关闭动作仍由人执行（`abuse` 标签即交接信号）；要自动关闭需要动执行器，不在本轮范围。
2. 谩骂回答里为举证引用了一句脏话原文，与「不复述脏话」略有张力，可再收紧。
3. 面板仍不显示「技能是否真的注入 / 是否被预算丢弃」——建议加一条 run warning。

## 10. 联网研究：怎么分析一个「提议」（2026-11-13）

### 10.1 取到的三份权威骨架

| 来源 | 关键小节 |
|---|---|
| Google《Design Docs at Google》 | Context/scope、Goals **and non-goals**、Alternatives considered、Trade-offs、cross-cutting concerns（安全/隐私/可观测）、长度以「能被读懂并决策」为准；只写「怎么实现」而没有取舍 → 这类文档不值得写 |
| Kubernetes KEP | Summary、Motivation(Goals/Non-Goals)、Proposal(**Risks and Mitigations**)、**Test Plan**、Upgrade/**Rollback**、Monitoring、**Dependencies**、Drawbacks、**Alternatives** |
| Rust RFC | Summary、Motivation、Guide/Reference explanation、Drawbacks、**Rationale and alternatives**、**Prior art**、**Unresolved questions** |
| Agent Skills 规范（agentskills.io） | `SKILL.md` 精炼 + `references/` 渐进披露；description 写「做什么 + 何时用」 |

三者的交集，就是「最小 RFC」：**Summary / 动机 / Goals 与 Non-goals / 备选方案 / 风险与回滚 / 验收 / 待决议**。

### 10.2 据此改了两处

1. **技能** `/proposal-analysis`：新增「最小 RFC」七项检查 + 三条反例（只写实现没取舍、没有 Non-goals、没有回滚），并明确 **bug 不套 RFC**、缺项**由 AI 给默认建议**而不是打回。
2. **触发提示词**：`issues.opened` / `issues.edited` 的首条信息从「分析当前issue」升级为
   「分析当前issue：① 先判类型（bug / 需求 / 无关 / 滥用）② bug 看现象能否定位，需求按最小 RFC 看能否决策 ③ 一条评论 + 一个标签」。

### 10.3 验证（两条新 issue，逐条跑）

| # | 输入 | 结果 |
|---|---|---|
| 25 | 弱提案：「加个快捷键导出 Markdown」 | `enhancement`；定位 `ChatTranscript.tsx:270`、`keyboard-shortcuts.ts:34`；列出「正文未提及」三项；按 RFC 给 5 条默认建议（Non-goals / 备选 / 风险与回滚 / 验收 / 待决议） |
| 26 | bug：「打开模型页闪退」+ `rt` + macOS 14.5 / 0.22.0 | `bug`；明确写「不是需求，无需补 RFC」；定位 `SettingsPage.tsx:468 → ModelConfigPage.tsx`；缺项标注「不是打回理由」；给下一步 |

两条 `skill_ids` 均为 `["proposal-analysis"]`，启动后**没有**再出现技能被预算丢弃（`truncated:["skill:..."]` = 0）。
