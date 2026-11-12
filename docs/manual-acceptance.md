# 真实环境验收（plan §12 V14 / test-plan §6.2 P2-7）

> ⚠️ **适用范围：本清单是 v0.3 固定流水线的人工验收清单，不覆盖 v2.1 的 25 条 AC，不能用来判定 v2.1 是否放行。**
> v2.1 的验收覆盖与遗留情况见 `docs/v21-static-review.md` §5.5：
> - **AC-24**（同一会话压缩两次后仍能复述第一轮确定的目标与硬约束）**仅能人工验收**；
> - **AC-2 / AC-12 / AC-16 / AC-20** 目前**没有自动化用例**；
> - 另有 6 条 BLOCKER、3 处断言反向与 1 条需求内部冲突（§5.4），以及 25 个需 PostgreSQL 的测试文件本机不可跑。
> 下文的三条流程（A/B/C）与前置条件一律沿用 v0.3 口径，本节说明**不改动清单正文**。

> **这一步需要真 GitHub 凭证与真实 issue，CI 不跑。**
> 自动化测试（`apps/server/test/pipeline-*.test.ts`）用的是假 GitHub 与假 RACP，
> 它们能钉住「发了什么动作、落库成什么状态」，但钉不住这三件事：
> ① `@` 是否**真的点到人**（非组织成员的 login 不会变蓝）、② 评论/标签是否被 GitHub 拒（权限、长度）、
> ③ 真实模型给出的分类结论像不像人话（假 RACP 的结论是我们自己编的）。
>
> 预计耗时 30 分钟（不含等容器跑分类的时间：分类阶段要读代码，首轮 3–8 分钟）。

---

## 0. 本清单覆盖的三条流程

| 用例 | issue 形状 | 期望终点 |
|---|---|---|
| A | 不合规（缺复现步骤 / 环境） | `format/awaiting_info`（等作者补充） |
| B | 补充信息后合规 | `agent/ready` + 需求/缺陷标签 + 带 `/cc @<manager>` 的评论 |
| C | 听起来像缺陷、但查不到证据 | `classify/awaiting_info`（等管理员）；管理员评论后重跑分类；`/pipeline next` 推到 `agent/ready` |

---

## 1. 前置条件（缺一条，下面的现象就对不上，先补齐再做）

1. **库已迁移**：内网 dev 库执行过 `pi-bot migrate`。
   自检：`select id, name, applied_at from schema_migrations order by id desc limit 3;` 能看到 `0005_pipeline`。
2. **面板 `#pipeline` 配置齐全**（这两条现在是**硬校验**，缺了整份配置解析失败、webhook 会忽略所有事件）：
   - `pipeline.managers` 至少 1 人（GitHub login，大小写不敏感；**必须是该组织成员**，否则 `/cc @x` 不会变蓝）；
   - 标签角色「需求（requirement）」「缺陷（defect）」**各至少一条**词表项（打标只能按 role 找词条）。
   自检：`select settings_valid, settings -> 'pipeline' as pipeline from repos where repo_full_name = '<owner>/<repo>';`
3. **该仓库 `dry_run=false`**（面板「仓库」页的开关，或
   `update repos set dry_run = false where repo_full_name = '<owner>/<repo>';`）。
   `dry_run=true` 时只推进内部状态、不发任何 GitHub 写动作（见 §5）。
4. **机器人 App 已安装在该测试仓库**，token 至少要有 `Issues: write`（评论 / 标签 / reaction 都靠它）。
5. `triggers.enabled` **无所谓**：它只关 `@` 提及类触发（命令 / 自由问答），三段流水线与管理员指令不读它。
6. 库里有该仓库一行：`select repo_full_name, enabled from repos where repo_full_name = '<owner>/<repo>';`（`enabled=true`）。
7. 所有 SQL 里的 `<owner>/<repo>` 与 `<N>` 换成实际仓库与 issue 号，再开始用例。

---

## 2. 用例 A：不合规 issue → 1 条 AI 评论、`needs-info`、`confused`、停在 `format/awaiting_info`

**步骤**

1. 在测试仓库新开 issue：
   - 标题：`登录页点击保存后报 500`
   - 正文：`保存的时候报错了，快修。` —— **故意不写**复现步骤、**不写**环境（OS / 浏览器 / 版本 / 部署方式）。
2. 等 1–3 分钟（阶段 0 是 light 运行：不起容器，通常 10–60 秒；模型慢时久一些）。

**期望的 GitHub 现象**

- issue 下恰好 **1 条**机器人评论：说清「缺什么」（复现步骤 / 环境），不是空话模板。
- 标签：**1 个** `needs-info`（若 `labels.map` 把判定名映射成了别的实际标签名，以映射名为准）。
- issue 上出现 **1 个 `confused`（😕）reaction**。
- **没有**「需求」「缺陷」标签，**没有** `@` 任何人，issue 仍开着。

**期望的库内状态**

```sql
-- 阶段 0 停在等补充信息
select stage, state, category, format_fail_count,
       info_requested_at is not null as info_asked, info_requested_at
  from issue_pipeline where repo = '<owner>/<repo>' and issue_number = <N>;
-- 期望：format | awaiting_info | (空) | 1 | t | <非空时间>

-- 只有一条阶段任务
select command, source, status from tasks
 where repo = '<owner>/<repo>' and target_number = <N> order by queued_at;
-- 期望：1 行 pipeline:format / pipeline

-- 信封：合规但结论是 fail（不是「跑挂了」）
select e.valid, e.stage_name, e.stage_result
  from envelopes e join runs r on r.id = e.run_id
  join tasks t on t.id = r.task_id
 where t.target_number = <N> order by e.created_at desc limit 1;
-- 期望：t | format | fail
```

---

## 3. 用例 B：补充信息后通过 → 1 条确认评论 + `rocket` → `agent/ready` + 标签 + `/cc`

**步骤**

1. 用**该 issue 的作者本人**账号在用例 A 的 issue 下追加一条评论，写清复现步骤与环境，例如：
   `补充：1) 打开 /settings 2) 修改任意字段 3) 点保存 → 500。环境：Chrome 126 / macOS 14.5 / v1.4.2。`
2. 等 1–3 分钟（重跑格式检查同样是 light）。
3. 分类阶段要读代码：**首轮通常 3–8 分钟**（容器 + 依赖安装），期间 issue 上有 `eyes`（👀）reaction。

**期望的 GitHub 现象**

- 补信息后立刻：**1 条**确认评论，正文为
  `已收到补充信息，格式检查通过。`（模型自己写了确认句时用模型那句，语义一致）
  + **`rocket`（🚀）reaction** 1 个。**不需要再补信息时不会有第二条「请补充」评论。**
- 分类跑完后：
  - **「需求」标签 1 个**（或按结论打「缺陷」标签——只要模型判定为需求/缺陷，就必须有对应 role 的标签）；
  - **1 条**评论：初步分析 / 缺陷报告（含 `path:line` 证据时才算缺陷）；
  - 该评论**末尾**是 `/cc @<manager>`，其中 `<manager>` 是前置条件 2 里配的人，且在 GitHub 上**真的变成了可点击的 mention**（不是纯文本）；
  - `@` **只出现一次**：之后再跑分类不会重复 `@`（单槽 `mention_sent_at`）。
- 不会再有别的评论（同一条 issue 一小时内最多 10 条自动评论，超了会降级——正常流程用不到这个数）。

**期望的库内状态**

```sql
select stage, state, category, mention_sent_at, mention_category
  from issue_pipeline where repo = '<owner>/<repo>' and issue_number = <N>;
-- 中间态（分类还在跑）：classify | pending | (空) | (空) | (空)
-- 终态：                  agent    | ready   | requirement（或 defect） | <非空> | requirement

-- 阶段任务：format 重跑 + classify（阶段交接也会写一行 tasks）
select command, source, count(*)
  from tasks where repo = '<owner>/<repo>' and target_number = <N>
 group by command, source order by command;
-- 期望：pipeline:classify/pipeline 1 行；pipeline:format/pipeline 2 行（原始 + 补信息重跑）

select e.stage_name, e.stage_result, e.valid
  from envelopes e join runs r on r.id = e.run_id join tasks t on t.id = r.task_id
 where t.target_number = <N> order by e.created_at desc limit 3;
-- 期望（由旧到新）：format/fail、format/pass、classify/requirement（或 defect）
```

---

## 4. 用例 C：「虚拟缺陷」（查不到证据）→ 不打缺陷标签、等管理员、`/pipeline next`

**步骤**

1. 新开 issue，描述一个**听起来像缺陷但仓库里查不到**的问题，且**不给任何文件 / 行号 / 日志**，例如：
   标题：`数据导出按钮偶尔点了没反应`
   正文：`导出功能不好用，点了没反应，希望能修一下。`
   （前提：该仓库里确实没有导出功能，或者模型找不到证据。）
2. 等 1–3 分钟 → 分类阶段跑一轮（3–8 分钟）。

**期望的 GitHub 现象**

- **没有「缺陷」标签**（也没有「需求」标签）。
- **1 条**评论，必须同时有两块内容：
  - `已查范围`（模型写了什么就照原样，说明查过哪些文件/目录）；
  - 需要什么证据（复现步骤 / 相关文件与行号 / 期望结果其中的具体几项）；
  - 末尾 `/cc @<manager>`（一次，点到人）。
- issue **停在原地**等管理员，**不会**被 48 小时自动关闭规则盯上。

**期望的库内状态**

```sql
select stage, state, category, info_requested_at, mention_sent_at
  from issue_pipeline where repo = '<owner>/<repo>' and issue_number = <N>;
-- 期望：classify | awaiting_info | not-found | NULL | <非空>
```

> ★ `info_requested_at` **必须是 NULL**：这一列只表示「在等作者补信息」（48h 自动关闭的判据）。
> `classify/awaiting_info` 等的是管理员，写进去会让这条 issue 被 48h 规则误关。

**接着做三步人工推进**

1. **作者**再补一条评论（给点信息但不给证据）：
   - 期望：**不重跑**分类（`classify` 阶段只认管理员评论），`tasks` 不新增一行；
   - 期望：状态不变（仍 `classify/awaiting_info`）。
   自检：`select count(*) from tasks where target_number = <N>;` 与上一步相同。
2. **管理员**（`pipeline.managers` 里的人）评论给出证据，例如
   `证据在 src/settings/save.ts:120，并发覆盖导致。`：
   - 期望：新增 **1 行** `pipeline:classify` 任务，行回到 `classify/pending`，`info_requested_at` 仍为 NULL；
   - 期望：分类跑完按结论打标（此时应出现「缺陷」标签 + 报告 + `/cc`）。
3. **管理员**评论指令 `@<bot> /pipeline next`（`<bot>` 是机器人 handle，例如 `@pi-bot`）：
   - 期望：issue_pipeline 变 `agent/ready`（`ready_at` 落库）；`classify` 阶段没有残留任务；
   - 期望：审计三条通道都在：
     ```sql
     -- ① 投递行（这条评论）
     select delivery_id, event, action from webhook_deliveries order by received_at desc limit 1;
     -- ② 任务行（推到 ready 时没有阶段任务要跑，这一行可能不出现，见注）
     select command, source, actor_login from tasks order by queued_at desc limit 1;
     -- ③ 日志（journald / 进程输出里搜一条带 directive= 的记录）
     --    {"repo":"<owner>/<repo>","issue":<N>,"directive":"/pipeline next","stage":"agent","state":"ready", ...}
     ```
   - 注：`/pipeline next` 从 `classify` 推到 `agent/ready` 时**没有**阶段任务（阶段 2 由 `@` 触发），
     所以 ② 可能为空 —— 审计靠 ① + ③。
---

## 5. `dry_run=true` 时的差异（同一份用例，换一个预期）

`dry_run=true` 只推进**内部状态**，**不发任何 GitHub 写动作**：

| 用例 | `dry_run=true` 时的现象 |
|---|---|
| A | **零评论、零标签、零 reaction**；`issue_pipeline` 停在 `format/pending`（不写转移，`format_fail_count` 不累加） |
| B | 补信息后仍**零评论**（确认句也不发）；行停在 `format/pending`，`blocked_reason` 会被写成 `dry-run：仅推进内部状态（未入队下一阶段、未发任何 GitHub 写动作）` |
| C | 不会有 `classify` 行（分类任务根本没入队）：`issue_pipeline` 仍是 `format/*` |
| 通用 | `@` 不会被降级成「只打 eyes」：dry-run 下连 reaction 也不发；`tasks` 里只有阶段 0 那一行 |

自检：`select dry_run from repos where repo_full_name = '<owner>/<repo>';` → 确认是 `false` 再开始用例 A。

---

## 6. 收尾检查（三行状态 + 面板）

```sql
select repo, issue_number, stage, state, category, format_fail_count, mention_sent_at
  from issue_pipeline order by issue_number;
```

- 三行与本文件 §2 / §3 / §4 的描述一致（A 行 `format/awaiting_info`、B 行 `agent/ready`、C 行 `agent/ready`，且 C 若没做 `/pipeline next` 则停在 `classify/awaiting_info`）；
- `format_fail_count`：A、B 应为 1（A 失败那次），C 应为 0（格式一次就过）；
- 打开面板「流水线」页：看板四列（格式检查 / 分类 / Agent / 已关闭）里三条 issue 的位置与上表一致；门禁表无异常项；issue 列表四列（阶段 / 状态 / 类别 / 停留时长）与库一致。

---

## 7. 现象对不上时先看哪里（按命中率排序）

| 现象 | 先查 |
|---|---|
| 一条评论都没有 | `select dry_run from repos`；`select settings_valid, settings_error from repos`（配置不合法 → webhook 直接忽略）；`select * from runtime_flags`（熔断 / 暂停中） |
| 评论发了但 GitHub 回 4xx | token 权限（`Issues: write`）、评论长度（超限会被截断并带 `…（评论已按上限截断）` 标记）、issue 已关闭 |
| `@` 没变蓝 | manager 不是该组织成员 / login 写错（大小写不敏感，但拼写要对） |
| 一直卡在 `format/pending` 不再动 | `select command, status from tasks where target_number = <N>`：连续 2 次运行失败会置 `blocked`（`blocked_reason` 非空），用 `@<bot> /recheck --force` 或 `/pipeline next` 推进 |
| 停在 `classify/pending` 很久 | 分类是 sandboxed：容器拉起 + 依赖安装 3–8 分钟；30 分钟闸到点会失败 |
| 打标打到了意料外的标签 | 面板 `#pipeline` 的词表 `role` 配错（分类只按 role 找词条） |
