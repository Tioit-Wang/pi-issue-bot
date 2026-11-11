# Issue Agent v0.3 · 测试用例设计（v2，已吸收三方审校）

> 事实源：`docs/req-issue-agent.md`（v0.3 定稿）。配套开发计划：`docs/dev-plan-issue-agent.md`。
> 基线（实测，`3d7e188`）：server 121 文件 / 1335 用例、panel 24 文件 / 210 用例、contract 85、envelope 33、shared 30、racp-client 87。
> 层级：**U** 纯函数单测｜**I** 真 PG + 假 GitHub/假 RACP 集成｜**P** 面板（vitest + MSW）｜**M** 真环境手动（不计入自动化门槛）。
> ID 前缀约定（v2 修掉重号）：`L` 生命周期、`H` 技能命中、`E` 事件、`EQ` 两种输入等价、`S` 技能链路、`CF` 配置、`A/B/C/D` 场景、`R` 硬规则、`PT` 拍板、`X` 边界、`T` 退役回归。

---

## 0. 总览

| 章节 | 用例数 |
|---|---|
| §1.2 生命周期（L） | 8 |
| §1.3 技能命中（H） | 10 |
| §1.4 事件（E） | 10 |
| §1.5 两种输入（EQ） | 3 |
| §2 技能链路（S） | 10 |
| §3 配置（CF） | 7 |
| §4 场景 A / B / C / D | 8 / 6 / 11 / 10 |
| §5 硬规则 + §7 拍板（R / PT） | 5 + 3 |
| 边界（X） | 14 |
| 退役回归（T） | 8 |
| **自动化合计** | **113** |
| 真环境手动（A-M / B-M / C-M / D-M） | 4（不计入） |

> 旧版 §0 的 `46/51/3/8` 分列算法有误，v2 只保留按章节计数（逐行可数）。

---

## 1. §1.2 一条消息的生命周期（L）

| ID | 覆盖 | 前置 | 输入 | 期望（可判定） | 层级 | 现状（据实测） |
|---|---|---|---|---|---|---|
| L-01 | 去重（永久） | `agent_messages` 里已有同 issue 同 fingerprint 的 `status='done'` 行 | 同一文本再次 @ | `tasks` 新增 **0** 行；`agent_messages` 仍 1 行；**`turn/start` 0 次**；返回体 `duplicate=true` 且带上次 `comment_id` | I | 新建（现为任务级锚 `tasks.idempotency_key`，语义不同） |
| L-02 | 归一化 | — | `@bot 打个标签` vs `@bot  打个标签！` | 两者 fingerprint 相同；**大小写不同也不同**（`@bot 打个标签` vs `@bot 打个标签`以外的差异不算） | U | 新建 `agent/canonical-text.ts` |
| L-03 | reaction 进入 | 假 reaction 记账 | `@bot ...` | `addReaction('eyes')` **恰好 1 次**，且 `seq(addReaction) < seq(入队)`（跨假实现共享序号，见 §11 夹具） | I | 新建夹具（现有各文件内联假实现，无全局序号） |
| L-04 | 扫描技能 + 改写 | 目录含 `format-check` | `@bot 看看格式 /format-check` | 进 agent 的**用户消息**不含 `/format-check`，且含「先加载 format-check」；`maskCodeRegions` 内的不动 | I | 新建 |
| L-05 | 同 issue 串行 | 同 issue 已有 `running` 任务 | 第二条 @ | 第二条 `tasks.status='queued'`；同 issue 的 `runs` 时间区间**不重叠** | I | 新建（现有的是**仓库级**并发：`app-wiring.test.ts:336`） |
| L-06 | reaction 移除 | 一次成功执行 | — | `removeReaction('eyes')` **恰好 1 次**；失败路径同样移除（D-07） | I | 新建（现仅空桩） |
| L-07 | **事件消息豁免永久幂等** | 同一 issue 连续两次 `issues.edited`（文本完全相同） | `tasks` 新增 **2** 行、`turn/start` 2 次（key 含 `issue.updated_at`，不是纯文本 hash） | I | 新建（否则「edited 每次都投」与 §5 规则 2 直接冲突） |
| L-08 | 权限拒绝独立记账 | 非管理员发言 → `agent_denials` 1 行（`repo/issue/actor_login`）；该用户被加入 `managers` 后同一句话 | `tasks` 新增 1 行并正常执行（拒绝记录**不参与**幂等命中） | I | 新建（v2 修：拒绝不能写进幂等主键） |

> **口径待拍板**：需求 §1.2 写「窗口内只跑一次」、§5 规则 2 写「永久」、D1 写「10 秒内」。本文件按「永久」（§5 优先）写期望，见 §13-OQ-7。

---

## 2. §1.3 技能命中（H）

| ID | 覆盖 | 输入 | 期望 | 层级 | 现状 |
|---|---|---|---|---|---|
| H-01 | 行首命中 | `/label-triage` | 命中，token 删除，剩空正文 + 加载指令 | U | 新建 |
| H-02 | 空格后命中 | `@bot /label-triage` | 命中，剩 `@bot` | U | 新建 |
| H-03 | 句中命中 | `@bot 看看格式 /format-check` | 命中，剩 `@bot 看看格式` | U | 新建 |
| H-04 | 粘连不命中 | `@bot/label-triage` | 不命中，正文原样 | U | 新建 |
| H-05 | 未知 id | `@bot /label-tri` | 不命中、不报错、token 保留 | U | 新建 |
| H-06 | 多次命中 | `@bot /a /b` | 两个都命中，顺序保留 | U | 新建 |
| H-07 | 重复命中 | `@bot /a /a` | 去重为一个 | U | 新建 |
| H-08 | 大小写 | `@bot /Label-Triage` | id 精确匹配（区分大小写）→ 不命中 | U | 新建（需求未明说，见 §13-OQ-10） |
| H-09 | 代码块内 | 围栏/行内代码里出现 `/label-triage` | 不命中（沿用 `maskCodeRegions`） | U | 已有 `packages/contract/test/trigger.test.ts:53-68` 的 mask 用例，**改写为技能口径** |
| H-10 | 目录 vs 正文边界 | `@bot /label-triage` | system prompt 含目录行、**不含技能正文**；正文只在 `Skill(id)` 调用后出现 | I | 新建（当前正文预注入，必红） |

---

## 3. §1.4 事件（E）

| ID | 覆盖 | 输入 | 期望 | 层级 | 现状（实测位置） |
|---|---|---|---|---|---|
| E-01 | `issues.opened` | 非 bot 新 issue | 1 条 `agent:opened`；默认点名 `format-check` | I | **新建**（现役 opened 用例在 `http-webhook-pipeline.test.ts:172`，`http-webhook.test.ts` 里没有） |
| E-02 | `issues.edited` 标题变更 | title 变 | 投递 `on_edited` | I | 新建 |
| E-03 | `issues.edited` 仅 label 变 | 无标题/正文变化 | 0 任务 | I | 新建 |
| E-04 | `issues.reopened` | reopen | 0 任务 | I | **改写**（当前 `reopened` 在 `ISSUE_ACTIONS` 内且会建任务：`webhook.ts:327`） |
| E-05 | 评论里 @ | `@bot 帮看下` | 投递，消息=原话 | I | 已有 `http-webhook.test.ts:289` |
| E-06 | `labeled` | — | 0 任务 | I | **新建**（全库无 labeled 用例） |
| E-07 | `assigned` / `closed` | — | 0 任务 | I | 新建 |
| E-08 | bot 自己 | `sender.type='Bot'` | 0 任务 | I | 已有 `http-webhook.test.ts:502` |
| E-09 | dependabot / renovate | `user.login='dependabot[bot]'` / `'renovate[bot]'` | 0 任务（**两条都要**） | I | 新建（现无 login 白名单，`isBotActor` 只判 type） |
| E-10 | 正文 @ 不算 mention | opened 且正文含 `@pi-bot` | 只 1 条任务、1 次 `turn/start` | I | 新建 |

---

## 4. §1.5 两种输入（EQ）

| ID | 覆盖 | 期望 | 层级 | 现状 |
|---|---|---|---|---|
| EQ-01 | 系统提示相同 | 同一 issue、**冻结同一份历史快照**下，自然语言与 `/label-triage` 两次下发的 system prompt 逐字节相等（用假 host 抓 `turn/start` 的 system 段；历史快照由夹具固定，不随执行变化） | I | 新建（旧写法「两次执行逐字节相等」不可判定，已修） |
| EQ-02 | 用户消息差异 | 自然语言：原话；`/` 版：原话删 token + 前置加载指令 | U | 新建 |
| EQ-03 | 同一通道 | 自然语言下模型自行 `Skill(id)` 与 `/` 版命中后加载，产出的正文注入相同 | I | 新建（依赖 OQ-1 与 §11 的 tool-call 夹具） |

---

## 5. §2 技能链路（S）

| ID | 覆盖 | 期望 | 层级 | 现状 |
|---|---|---|---|---|
| S-01 | 两级扫描 | 全局（内置 3 + 上传）+ 项目（`.github/pi-bot/skills/`）；每条带 `source: 'builtin'\|'global'\|'project'` 字段 | U | **新建**（现有 `skills-registry.test.ts` 只测解析与注册表，无目录扫描） |
| S-02 | 两种形状 | `<id>.md` 与 `<名字>/SKILL.md` 都收录 | U | **新建**（现只在 `skills-store.test.ts:52` 作为上传文件名出现） |
| S-03 | 坏文件不拖累其他 | frontmatter 缺 name：该条**不出现**在目录里，其余照常；logger 1 条 warn | U | **改写**（现状是进面板一行但被禁用，`skills-registry.test.ts:249`） |
| S-04 | 正文为空 | 丢弃 + warn | U | 已有 |
| S-05 | 单文档 512KB | 超 `ZIP_LIMITS.maxFileBytes` 丢弃；边界值收录 | U | 改写（真实常量在 `skills/zip.ts:56-66`，不是 128KB） |
| S-06 | 目录上限 128 条 | 130 条 → 收录 128，超出按**字典序**丢弃 + warn（顺序稳定） | U | 新建（128 条是 v0.3 新增，现有上限是 `maxEntries:200`） |
| S-07 | 项目覆盖全局 | 同名：目录只 1 条，正文取项目版（整体替换） | U | 新建 |
| S-08 | 同 id 只留第一个 | 保留扫描顺序第一个 + warn | U | 新建 |
| S-09 | 禁用 | DB 技能 `enabled=false` 不进目录；`/id` 视同未知 | U | 改写 |
| S-10 | 目录格式 | `- \`<id>\` — <名字>: <描述>`（正则断言）；描述超长按 §13-OQ-10 的口径处理 | U | 新建 |

> **需求 §2.2 还有两个上限**（目录型单资源 2MB、整包 16MB）——两份文档原本都漏了。本文件标为 **S-11（待定）**：若 v0.3 保留，则断言按 `ZIP_LIMITS` 现值；若不保留，删除该行。见 §13-OQ-11。

---

## 6. §3 配置（CF）

| ID | 覆盖 | 期望 | 层级 | 现状 |
|---|---|---|---|---|
| CF-01 | 默认值 | 内置 3 技能（`format-check`/`label-triage`/`review-pr`，来源 `apps/server/src/skills/builtin.ts`）；`on_opened=format-check`；`on_edited=format-check`；`auto_label_after_format_pass=false`；`project_prompt=''` | U | 改写 `packages/contract/test/config.test.ts` |
| CF-02 | `on_opened` 置空 | 新 issue 0 任务 | I | 新建 |
| CF-03 | `on_edited` 置空 | 编辑 0 任务 | I | 新建 |
| CF-04 | 自动打标 | pass 后**再投递一次** `label-triage`（`tasks` +1）；若受永久幂等影响，由 §13-OQ-8 的口径决定断言 | I | 新建 |
| CF-05 | `project_prompt` | 进 system prompt；**只改它、不改技能文件**即可换口径（对照组：两次执行的技能正文哈希相同） | I | 改写（现为 `prompt.current_version` 版本表） |
| CF-06 | 严格校验 | 未知键/类型错 → 400；`on_opened` 指向不存在的 id → 由 §13-OQ-3 决定（400 或运行期 warn） | U | 改写 |
| CF-07 | **内置技能存在性** | 目录里 `format-check`/`label-triage`/`review-pr` 三条齐全，正文非空、`description` 非空；`on_opened=format-check` 能真的加载到正文 | U | 新建（现状：`builtin.ts` 只有 `review-pr`，另两个只存在于文档） |

---

## 7. §4 场景

### 7.1 A · 新 issue

| ID | 场景 | 期望 | 层级 | 现状 |
|---|---|---|---|---|
| A-01 | A1 合规 | pass → `addLabels` 0 次；`createIssueComment` 0 次；reaction 加了又移除（`addReaction('eyes')` 1 次 + `removeReaction('eyes')` 1 次） | I | 新建 |
| A-02 | A2 缺复现步骤 | `createIssueComment` 恰好 1 次且含缺失项；`addLabels` 0 次 | I | 新建 |
| A-03 | A3 只有一句「有个 bug」 | 1 条评论，含 `project_prompt` 里配置的**每一个**必填项名（夹具固定 3 项，断言 `toContain` 3 次） | I | 新建 |
| A-04 | A4 bot 自己创建 | 0 任务、0 评论 | I | 已有（E-08） |
| A-05 | A5 dependabot / renovate | 两个 login 各 0 任务 | I | 新建（E-09） |
| A-06 | A6 正文 @ 了 bot | 1 条任务、1 次 `turn/start`（不因正文 @ 重复） | I | 新建（E-10） |
| A-07 | A7 执行前 issue 已不存在 | 假 GitHub 的 issue 查询返回 404 → `createIssueComment` 0 次；`runs.failure_detail.reason='issue-gone'`；`tasks.status='failed'` | I | 新建（注意：`failure_detail` 在 **`runs`**，不在 `tasks`；且 `github/` 目前**没有**读 issue 的能力，属新增） |
| A-08 | A8 自动打标开关 | 见 CF-04 | I | 新建 |

### 7.2 B · 存量与接入

| ID | 场景 | 期望 | 层级 | 现状 |
|---|---|---|---|---|
| B-01 | B1 接入 2000 存量 | 接入动作：`turn/start` 0 次、写 GitHub 0 次、`tasks` 0 行 | I | 新建 |
| B-02 | B2 老 issue 上 @ | 正常工作，无前置状态 | I | 已有（`http-webhook-pipeline.test.ts:219`「无行也能跑」），**迁移后改写** |
| B-03 | B3 老 issue 被编辑 | 投递 `on_edited` | I | 新建（E-02） |
| B-04 | B4 老 issue reopen | 0 投递 | I | 改写（E-04） |
| B-05 | B5 手动补跑 | `/format-check` 与自然语言都能跑 | I | 新建 |
| B-06 | B6 批量打标本版不做 | 源码级：路由表无批量接口；`grep -r "batch.*label\|bulk" apps/server/src` = 0 | U | 新建（护栏） |

### 7.3 C · 对话

| ID | 场景 | 期望 | 层级 | 现状 |
|---|---|---|---|---|
| C-01 | C1 自然语言重打标 | 1 次 turn；产出至少一条评论（是否打标由模型决定，不断言 `addLabels` 次数） | I | 新建 |
| C-02 | C2 `/label-triage` | 用户消息被改写（EQ-02）；`Skill('label-triage')` 调用 ≥1 次（需 §11 tool-call 夹具） | I | 新建 |
| C-03 | C3 「这个格式行不行」 | 1 条评论，信封 `valid=true` | I | 新建 |
| C-04 | C4 「帮我复现一下」 | 两种结果都合法，但必须满足：`outcome==='succeeded'` 或 `'failed'`（不得挂起）；起容器时 `disposed` 次数 = 创建次数 | I | 新建 |
| C-05 | C5 一回合多件事 | 单次 turn 的信封 `actions` 可同时含 `comment` + `label`，且两者都执行（`createIssueComment` 1 次 + `addLabels` 1 次） | I | 新建（依赖 §13-OQ-4：agent 通道是否允许 label） |
| C-06 | C6 「你好」 | 评论正文 = 信封 `comment.body` **逐字相等**（控制面不注入固定话术） | I | 新建 |
| C-07 | C7 「把 issue 关了」 | 管理员 → `closeIssue` 1 次 + `actions` 1 行审计 | I | 新建（依赖 `close_issue` 放开，见开发计划） |
| C-08 | C8 `/unknown-skill` | 不报错：1 条正常回复，用户消息 token 保留 | U | 新建（H-05） |
| C-09 | C9 只 @ 不说话 | 1 条正常回复；`tasks.command` 不是命令类 | I | 新建 |
| C-10 | C10 非管理员 | 回 1 条「无权限」；同 issue 再次发言 → 0 条；`agent_denials` 1 行（`repo/issue/actor_login`），且该行**不参与**幂等命中（L-08） | I | 新建（v2 修：拒绝独立记账，`tasks` 无对应字段） |
| C-11 | C11 废话 + `/技能` | 命中，token 删除，剩余文本原样（含顺序） | I | 新建 |

### 7.4 D · 并发与异常

| ID | 场景 | 期望 | 层级 | 现状 |
|---|---|---|---|---|
| D-01 | D1 两次相同指令 | 第二次不建任务、`turn/start` 仍 1 次 | I | L-01 |
| D-02 | D2 两个管理员同时 @ | 同 issue 严格串行（`runs` 区间不重叠）；排队期间 eyes 在（`addReaction` 1 次、`removeReaction` 在第二条结束后共 2 次） | I | 新建 |
| D-03 | D3 执行中 issue 被关闭 | 结果丢弃：`createIssueComment` 0 次、`actions` 0 行；`tasks.status='failed'`、`runs.failure_detail.reason='issue-closed'` | I | 新建（**开发计划原缺此条，已补**） |
| D-04 | D4 人工改过标签 | 被人工移除的标签不再被自动加回（`bot_labels` 记 veto） | I | 已有 `jobs-reconcile.test.ts:114-205` 的对账 + `workflow-normalize.test.ts:124` 的 veto，扩端到端 1 条 |
| D-05 | D5 词表无合适标签 | `addLabels` 0 次；1 条评论含「词表缺」字样（断言包含） | I | 新建 |
| D-06 | D6 超时 / 输出不合法 | `runs.outcome='timed-out'`（或 `'parse-failed'`）+ `failure_class` 非空；**同 issue 下一条消息仍能成功**（`tasks` 2 行、第二行 `succeeded`） | I | 已有 `e2e-envelope-invalid.test.ts`，扩「下一条仍能跑」 |
| D-07 | D7 无 label 权限 | `addLabels` 抛错 → 1 条评论说明权限；`actions.audit.status='failed'`；`removeReaction` 仍执行 | I | 新建（需假 GitHub 抛错注入） |
| D-08 | D8 bot 自己评论 | 0 新任务 | I | 已有 `http-webhook.test.ts:502` |
| D-09 | D9 frontmatter 缺 name | 该条不进目录（S-03） | U | 改写 |
| D-10 | D10 项目同名覆盖 | `Skill(id)` 返回项目版（S-07） | U | 新建 |

---

## 8. §5 硬规则 + §7 拍板（R / PT）

| ID | 覆盖 | 期望 | 层级 | 现状 |
|---|---|---|---|---|
| R-01 | 规则 1 | 非管理员 1 条、后续静默（C-10） | I | 新建 |
| R-02 | 规则 2 | 命中即**不建任务、不调模型**，直接返回上次结果 | I | 新建 |
| R-03 | 规则 3 | 同 issue 串行、不同 issue 可并行 | I | 新建（L-05/D-02） |
| R-04 | 规则 4 | **默认**产出只有评论：信封未声明 `label` 时 `addLabels` 0 次；声明了则允许（见 §13-OQ-4）。**不再**断言「自动通道一律拒 label」——`worker/writeback.ts:491` 的真实语义是「非 comment 一律放行」，与旧断言相反 | I | 改写（原「已有」不成立） |
| R-05 | 规则 5 | 见 B-01；源码级：无「遍历 issue 初始化」的函数（`grep` 判据） | U | 新建 |
| PT-01 | P1 opened 跑格式检查 | A-06 | I | 新建 |
| PT-02 | P2 命中边界 | H-01..H-09 | U | 新建 |
| PT-03 | P3 幂等副作用 | 正文编辑后同一句话仍不重跑；换说法则重跑 | I | 新建 |

---

## 9. 边界与反例（X）

| ID | 断言 |
|---|---|
| X-01 | `@bot/技能` 不命中，且**不产生**「技能不存在」提示 |
| X-02 | 未知技能：token **保留**、不报错 |
| X-03 | 目录为空时 system prompt 的 `# Skills` 整段不出现（不是空标题） |
| X-04 | 130 条 → 收录 128，**字典序**后 2 条被丢，连跑两次顺序相同 |
| X-05 | 单文件 512KB 边界：等于上限收录、+1 字节丢弃（与 `ZIP_LIMITS.maxFileBytes` 对齐） |
| X-06 | 同 issue 两次相同文本：`runs` 不新增、`envelopes` 不新增、`removeReaction` 不重复调用 |
| X-07 | 同 issue 排队 5 条：`runs` 任意两条区间不重叠（用 `started_at/ended_at` 判定） |
| X-08 | `dry_run=true`：`addLabels`/`createIssueComment`/`closeIssue` 全 0；`tasks.status='succeeded'` |
| X-09 | 「只回一次」按 issue 维度：换 issue 仍回一次 |
| X-10 | 正文为空：`turn/start` 消息里正文段有明确占位（`（正文为空）`），不抛错 |
| X-11 | 正文 200KB：按 `PROMPT_LIMITS.body` 截断且**显式标注**（断言含「已截断」） |
| X-12 | id 含大写/下划线：目录原样出现，命中需精确匹配（H-08） |
| X-13 | 上下文超预算：先丢历史、再截正文，技能目录**永不被裁**（目录里 3 条始终完整） |
| X-14 | 同 issue 连发 3 条消息：**3 条都进队列**（不是被 `singletonKey` 丢掉 2 条），按 `created_at` 串行执行 |

---

## 10. 退役回归（T）

| ID | 断言 | 层级 |
|---|---|---|
| T-01 | `apps/server/src` 里 `pipeline:format\|pipeline:classify\|pipeline:notice` = 0；**且** `no-dead-workflows.test.ts` 的反向断言已删除（它现在要求 `workflows/pipeline.ts` 必须存在，`:118`） | U |
| T-02 | 0006 之后 `issue_pipeline` 不存在；读路径已删（无 SELECT 该表的代码） | I |
| T-03 | 新 issue 只产生 `agent:opened`，无 `pipeline:*` | I |
| T-04 | `settings.pipeline` 被 `.strict()` 拒收；旧行迁移后为 `agent` 段 | U |
| T-05 | `/pipeline next` 当自然语言（不报错、不推状态） | I |
| T-06 | 面板：`/repos/:repo/pipeline` 404；issue 列表无阶段/类别列；详情无阶段时间线 | P |
| T-07 | 面板设置页无「流水线」分区（含 `components/settings/pipeline-section.tsx` 已删）、导航无入口 | P |
| T-08 | 0006 连跑两次：第二次 0 变更 | I |

---

## 11. 现有测试的处置（按实测，v2 修正）

**实测基线**：`apps/server/test/pipeline-*.test.ts` = **28 个文件**（不是 29）/ **229 个 `it()`** / 948 处 expect。
`panel` 里 pipeline 专属测试 = **4 个文件 / 32 条**（`routes/__tests__/pipeline.test.tsx` 5、`settings/__tests__/settings-pipeline.test.tsx` 14、`components/pipeline/__tests__/pipeline-view.test.tsx` 11、`components/issues/__tests__/pipeline-columns.test.tsx` 2）。

| 处置 | 文件 |
|---|---|
| **全删（28）** | 全部 `pipeline-*.test.ts`。其中 3 个原计划「保留」的**站不住**：`pipeline-labels.test.ts` 与 `pipeline-stage-result.test.ts` 的 import 目标随源码一起删；`needsInfoLabelOf` 的唯一 src 调用方是 `pipeline-format.ts:144`（同删），`missingEvidenceOf` 在 src 里零调用；`pipeline-v17-migration-reset.test.ts` 断言的 `settings.pipeline` 形状（T-04）会变 |
| **搬迁重建（5 条断言）** | 把 `needsInfoLabelOf` 3 条 + `missingEvidenceOf`/`describeMissing` 2 条搬到新文件 `apps/server/test/workflows-labels.test.ts` 与 `evidence.test.ts`（**仅当**新代码仍需要这两个函数；若 v0.3 不再用 `needs-info` 标签体系，这两组直接删，不重建） |
| **删（4 / 32 条）** | 面板 4 个 pipeline 专属测试文件 |
| **改写（5 个面板文件）** | `routes/__tests__/issues.test.tsx`、`test/routes.test.tsx`、`routes/__tests__/issue-detail.test.tsx`、`overview.test.tsx`、`repo-nav.test.tsx` |
| **改写（server）** | `http-webhook.test.ts`（新增 opened/edited 用例，原本没有）、`e2e-envelope-invalid.test.ts`（扩 D-06）、`skills-{registry,store,prompt}.test.ts`、`helpers/repo-settings.ts`、`db-schema.test.ts`（表数 21→20）、`no-dead-workflows.test.ts`（**删掉**要求 pipeline 文件存在的断言）、`db-migrate.test.ts`（0006） |
| **删除（server）** | `http-webhook-pipeline.test.ts`（不是「改写」——它的 21 条都在测闸门/阶段，保留价值≈0；其中「无行也能跑」1 条口径由 B-02 重写） |

**目标基线**：server 121 − 28 + 约 11 个新 agent 文件 ≈ **104 文件**；panel 24 − 4 + 约 3 个新文件 ≈ **23 文件 / 178 用例**（删 32、新增约 15）。
这两组数字**允许下降**：旧流水线的 229 条 `it()` 随功能消失，不是覆盖缩水。

### 11.1 必须先补的夹具（否则 20+ 条用例写不出来）

| 夹具 | 签名 / 记录内容 | 服务的用例 |
|---|---|---|
| 反应记账 | `createCountingReactionApi(): { api; calls: {seq, op:'add'\|'remove', content, issueNumber, commentId?}[] }`（现有 `createCountingGithubApi` 只实现写面，**无 reaction**；各文件内联且无全局序号） | L-03 / L-06 / A-01 / D-02 / X-06 |
| 全局事件序号 | 假队列 + 假 reaction + 假 GitHub 共享 `emitOrder: string[]`（用于「reaction 早于入队」这类顺序断言） | L-03 / D-02 |
| tool-call 事件 | `FakeTurnScript` 扩展 `items: Array<{kind:'text'\|'tool_call', name?, input?}>`（现在只能推 `item.completed{text}`） | EQ-03 / H-10 / C-02 / D-10（**依赖 OQ-1**） |
| 同 issue 双任务 | `seedTask()` + `runTaskHandler()` 提升到 `helpers/`，复刻 `app-wiring.test.ts:336-373` 的双调模式 | L-05 / D-02 / X-07 |
| GitHub 错误注入 | 假写面支持 `failNext('addLabels', {status:403})` / issue 查询 404 | A-07 / D-07 |
| truncate 清单 | `helpers/queries-db.ts` 的 `truncate` 增加 `agent_messages`（**必修**，否则重演 `issue_pipeline` 跨文件污染） | L-01 / R-02 / X-06 / D-01 |

---

## 12. 缺口与风险

1. **OQ-1 `Skill(id)` 是否存在**：本仓库无 `vendor/pi-host`，RACP 操作集里没有工具类操作（`racp-client/src/ops.ts` 共 18 个）。H-10 / EQ-03 / S-07 / C-02 / D-10 在宿主确认前**不可测**，本文件已把它们标为依赖项而非既有覆盖。
2. **幂等存储面**：本文件统一按 `agent_messages`（新表）写期望；若最终复用 `tasks.idempotency_key`，L-01 / R-02 / X-06 / D-01 / C-10 的字段要全部改写。
3. **`agent` 通道能否打标签**（§13-OQ-4）：决定 R-04 与 C-05 的断言方向。
4. **面板 baseline 与实际不一致**：旧版写 223、实测 210；已按 210 重算。
5. **A-07 依赖的能力当前不存在**：`github/` 没有「读 issue」的调用点（`getIssue` 零命中），A-07 是新增能力 + 新增 404 注入。
6. **需求未定义处**：见 §13。

---

## 13. 需用户拍板（决定这些用例能不能写死）

| # | 问题 | 影响用例 |
|---|---|---|
| OQ-1 | 宿主是否提供 `Skill(id)` 工具？ | H-10 / EQ-03 / S-07 / C-02 / D-10 |
| OQ-2 | 配置破坏性迁移是否接受（`pipeline/commands/create_issue/prompt` 直接删、`project_prompt` 内联）？ | CF-01..CF-06 / T-04 |
| OQ-3 | `review-pr` 是否并入技能通道？ | CF-06 / 既有 PR 用例 |
| OQ-4 | agent 通道是否允许信封声明 `label` / `close_issue`（v0.3 §5 说「必须显式调工具」，与「默认只出评论」如何并存）？ | R-04 / C-05 / C-07 |
| OQ-5 | 一个 issue 一个会话是否沿用 `persistent`？30 轮/7 天轮换是否保留？ | L-05 / D-02 |
| OQ-6 | reaction 语义：A1「只留一个 reaction」vs §1.2「去掉 reaction」vs §5「处理完移除」——最终是「加 eyes → 处理完移除」吗？ | L-03 / L-06 / A-01 / D-02 |
| OQ-7 | 幂等范围：§1.2「窗口内」vs §5 规则 2「永久」vs D1「10 秒」——按永久（本文件口径）还是窗口？ | L-01 / R-02 / P-03 / X-06 |
| OQ-8 | `auto_label_after_format_pass` 触发的消息是否也受永久幂等？（同 issue 二次 pass 文本相同会被挡住） | CF-04 / A-08 |
| OQ-9 | 「管理员」外延：仅 `managers` 名单，还是含 issue 作者 / 协作者？ | R-01 / C-10 / X-09 |
| OQ-10 | 归一化与命中口径的两处扩展是否采纳：① 归一化「转小写」；② 代码块内不命中；③ 目录描述截断 200 字符 | L-02 / H-09 / S-10 |
| OQ-11 | 需求 §2.2 的两个上限（目录型 2MB / 整包 16MB）与「增量 section」是否本版保留？ | S-11 / 无（增量 section 若保留则补一条用例） |
| OQ-12 | 事件消息是否豁免永久幂等？（本文件按「豁免」写 L-07） | L-07 / PT-03 |
| OQ-13 | PR 维度：串行键、容器、`bot/*` 分支权限，以及「一个 issue 一个 agent」在 PR 上映射成什么 | 既有 PR 用例 / C-05 / R-03 |
| OQ-14 | 上下文超预算时先丢历史还是先截正文？ | X-13 / S2 |
