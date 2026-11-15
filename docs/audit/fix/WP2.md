# WP2 交付：会话域隔离（BR-5 / FR-3.1）

> 执行时间：2026-11-15 03:0x ~ 03:4x（会话 `f6ad5441`）
> 基线：`docs/audit/fix/_baseline-fix.txt`（HEAD `fbfa029`）+ 15 个工作区既有改动（未回滚）

---

## 一、逐条对照

### BR-5 会话域隔离（需求 `docs/requirements.html:1790`）

> 「issue 与 PR 各自独立会话，上下文不互通。」

| 需求要求 | 修前 | 修后 | 证据 |
|---|---|---|---|
| issue 与 PR 各自独立会话行 | 主键 `(repo, issue_number)`，PR #7 与 issue #7 共用一行 | 主键 `(repo, domain, issue_number)`，同号两域是两行 | 迁移 §4；`agent-session-domain.test.ts`「同仓库同编号不同域 → 两行」 |
| 两域互不影响（上下文不互通） | 一方 UPSERT 覆盖另一方；issue 关单把 PR 会话一起标 `idle` | UPSERT 只命中自己那一域；沙箱回收只碰 issue 域 | 同文件「UPSERT 只改自己那一域」「issue 关单回收沙箱，PR 那一行不受影响」 |
| 所有读写路径带域 | `loadSession` / `saveSession` / `V21_SESSION_TRANSITION_SQL` / `V21_SESSION_SQL` / `recordSessionSystemPrompt` / `v21IsFirstEventOf` 全按两段键 | 全部三段键 | `agent/store.ts:200-212`、`app/compose.ts:281-295`、`http/webhook-v21.ts:1153-1190` |
| 「属于 issue 还是 PR」有事实源、不发明判据 | 无判据（所有事件共用一个域） | `v21SessionDomainOf()`：`X-GitHub-Event` 前缀 + 载荷 `issue.pull_request` 字段 | `http/webhook-v21.ts:1195-1222`。**判据照抄现有代码**：`v21EventKeyOf()` 已经按事件名前缀判 PR；`http/webhook.ts:563` 的 `isPullRequest`、`queries/issues.ts:83-85` 的 `kind='pr'` 都是同一口径（`pull_request` 字段非空） |

**执行侧的事实源**：`tasks.target_kind`（`agentSessionDomainOf()`，`app/compose.ts:298-306`）。理由是执行侧手里只有 `tasks` 行、没有 webhook 载荷，而这一列本来就记着目标是不是 PR（`/review-pr` 的任务就是 `target_kind='pr'`）。不引入第二处判据。

### FR-3.1 一个 issue 只对应一个会话（残余）

> 「映射是一对一，且是唯一权威来源…… 边界：PR 与 issue 各自独立会话，不共享上下文。」

| 要求 | 修后 | 证据 |
|---|---|---|
| 同 repo 同号不同域是**两行** | ✅ | `agent-session-domain.test.ts`：`rows` 长度 2，`domain` = `['issue','pr']`，`session_id` = `['session-issue','session-pr']` |
| 互不影响 | ✅ | 写 PR 的 `turns/cursor` 后 issue 行仍是 `turns=5` / `session-issue`；issue 关单后 PR 行仍是 `active` + `sandbox_id='sbx-pr'` |
| 首轮判据（FR-4.2）按域各算 | ✅ | issue 跑过一轮后，`v21IsFirstEventOf(pr)` 仍 `true`（PR 第一句话拿到全文而不是增量） |
| 会话键不去染消息层 | ✅ | `agent_messages` 主键刻意不变（它在别人的文件面里）；用例钉住同号两条消息仍是两行 |

---

## 二、迁移全文与回填策略

文件：`migrations/0014_wp2_session_domain.sql`（**只写 SQL，不自动应用**；编号说明见 §五）

```sql
-- 1) 加域列。DEFAULT 'issue' 同时承担两件事：新列不可空 + 既有行自动回填。
ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "domain" text NOT NULL DEFAULT 'issue';
--> statement-breakpoint

-- 2) 显式回填
UPDATE "agent_sessions" SET "domain" = 'issue' WHERE "domain" IS NULL;
--> statement-breakpoint

-- 3) 取值面收口
ALTER TABLE "agent_sessions" DROP CONSTRAINT IF EXISTS "agent_sessions_domain_check";
ALTER TABLE "agent_sessions"
  ADD CONSTRAINT "agent_sessions_domain_check" CHECK ("domain" IN ('issue', 'pr'));
--> statement-breakpoint

-- 4) 主键换三段键（包在 DO 里做幂等判断，见下）
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'agent_sessions'::regclass
      AND contype = 'p'
      AND pg_get_constraintdef(oid) = 'PRIMARY KEY (repo, domain, issue_number)'
  ) THEN
    RETURN;
  END IF;
  ALTER TABLE "agent_sessions" DROP CONSTRAINT IF EXISTS "agent_sessions_repo_issue_number_pk";
  ALTER TABLE "agent_sessions" DROP CONSTRAINT IF EXISTS "agent_sessions_pkey";
  ALTER TABLE "agent_sessions"
    ADD CONSTRAINT "agent_sessions_repo_domain_issue_number_pk"
    PRIMARY KEY ("repo", "domain", "issue_number");
END $$;
--> statement-breakpoint

-- 5) 域内扫行的索引
CREATE INDEX IF NOT EXISTS "agent_sessions_repo_domain_idx"
  ON "agent_sessions" USING btree ("repo", "domain");
```

**回填策略（有损但有据）**：既有行一律标 `issue`。

- 历史数据里**没有任何信息**能区分「这行是 issue 的还是 PR 的」—— 旧表就没有这一列。
- 而且可以确认历史上被执行的全是 issue 事件：`trigger/decide.ts:274-276` 的 `decidePullRequest()` 对 `pull_request.*` 固定返回 `{triggered:false, reason:'pr-ignored'}`，`http/webhook-v21.ts` 的 `handleV21Webhook()` 在 `!triggered` 时直接 200 ignored、**不入队**。所以没有 PR 域会话会被建出来。
- 结论：`issue` 是唯一有依据的默认，而不是随手挑一个值。代价是「假如曾经有 PR 事件误入 issue 行，那段落历史仍归在 issue 域」—— 无法补救，也不需要补救（它本来就是错的域，合并进 issue 域与修前行为一致）。

**幂等性**：五次语句全部带 `IF NOT EXISTS` / `IF EXISTS`，主键替换用 `DO` + `pg_get_constraintdef` 判语义（不靠约束名，名字只是 drizzle 生成的）。已在本机真库上验证过重复执行（第一次失败于「multiple primary keys」，加 `DO` 后第二次通过）。

---

## 三、改了哪些文件与原因

### 我独占的文件

| 文件 | 改动 |
|---|---|
| `apps/server/src/agent/store.ts` | 新增 `AGENT_SESSION_DOMAINS` / `AgentSessionDomain` / `AgentSessionKey`；`AGENT_SQL.loadSession` / `saveSession` 改三段键 + `ON CONFLICT ("repo","domain","issue_number")`；`loadSession()` / `saveSession()` 参数改 `AgentSessionKey` |
| `apps/server/src/agent/index.ts` | 再导出上面三个符号 |
| `apps/server/src/db/schema.ts` | **只改 `agent_sessions`**：加 `domain` 列（`text notNull default 'issue'`）、主键改 `(repo, domain, issue_number)`、加 `AGENT_SESSION_DOMAIN` 常量、更新头部注释解释取舍 |
| `migrations/0014_wp2_session_domain.sql` | 新建（编号原因见 §五） |
| `apps/server/test/agent-session-domain.test.ts` | 新建，6 条用例（全部断言库里的行） |

### 允许的最小改动面

| 文件 | 只改会话相关行 |
|---|---|
| `apps/server/src/app/compose.ts` | `V21_SESSION_TRANSITION_SQL` 四条语句改三段键；新增 `agentSessionDomainOf()`；`planV21SessionOnEvent` / `v21SessionRowOf` / `applyV21SessionTransition` 加 `domain` 入参；`loadAgentSession()` 接受 `AgentSessionKey`；`persistAgentSessionAfterRun()` 用 `tasks.target_kind` 派生域；任务路径的会话行改为**两域都读**（原来 `targetKind==='issue'` 才读）。**`panelDistDir` / `nextAgentTurns` / 压缩装配 / 标签行未动** |
| `apps/server/src/http/webhook-v21.ts` | `V21_SESSION_PROMPT_SQL.record` / `V21_SESSION_SQL` 四条语句改三段键；新增 `v21SessionDomainOf()`；`recordSessionSystemPrompt()` / `applyV21SessionOnEvent()` / `v21IsFirstEventOf()` / `v21SessionRowOf()` 加 `domain`；`handleV21Webhook()` 里算出 `sessionKey` 供首轮判据与提示词留痕共用。**`v21TemplateOf` / `pickEventTemplate` / `v21ContentDeltaOf` / 配额判定行未动** |
| `apps/server/src/http/webhook.ts` | 只有 `applyV21SessionOnEvent` 那一次调用加 `domain: v21SessionDomainOf({event, payload})`（3 行 + 注释）。**不改就编译不过**，属必需连带 |

### 别人的测试文件（只做机械适配，不放宽断言）

`v21IsFirstEventOf` / `applyV21SessionOnEvent` / `applyV21SessionTransition` / `v21SessionRowOf` 的入参多了必填的 `domain`，不加就 typecheck 红：

| 文件 | 改动 |
|---|---|
| `apps/server/test/v21-incremental-feed.test.ts` | 两处调用加 `domain: 'issue'`（本组用例就是 issue 域） |
| `apps/server/test/v21-integration.test.ts` | 三处 `applyV21SessionOnEvent` 调用加 `domain: 'issue' as const` |
| `apps/server/test/v21-worker-integration.test.ts` | 五处加 `domain: 'issue' as const`；**一处断言跟着参数序更新**：`[REPO, ISSUE, 'sandbox-rebuilt']` → `[REPO, 'issue', ISSUE, 'sandbox-rebuilt']`（域是第二段，与实际 SQL 的 `$2` 一致；没有放宽，是把断言改对） |

---

## 四、命令与真实输出

### 1. `cd apps/server; npx tsc --noEmit`

```
（空输出，退出码 0）
```

### 2. `cd apps/server; npx vitest run test/agent-serial-queue.test.ts test/v21-webhook-integration.test.ts test/app-agent-session-plan.test.ts`

```
 Test Files  3 passed (3)
      Tests  35 passed (35)
   Duration  6.24s
```

### 3. 新增用例：`cd apps/server; npx vitest run test/agent-session-domain.test.ts`

```
 ✓ @pi-issue-bot/server  test/agent-session-domain.test.ts (6 tests) 185ms
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

### 4. `cd apps/server; npx vitest run`（全量）

```
 Test Files  1 failed | 134 passed (135)
      Tests  1 failed | 1692 passed | 2 skipped (1695)
   Duration  194.75s
```

唯一失败项，**不是本包**：

```
FAIL test/db-schema.test.ts > db/schema：24 张表 > 表名清单 = … （无多无少）
AssertionError: expected 29 to be 24 // Object.is equality
```


归因：`db-schema.test.ts:78-82` 硬编码「表清单 = 16 + 3 + 3 + 2 = 24 张」。并行包新增了 5 张表（WP9 的模型/供应商表等），`ALL_TABLE_NAMES` 变成 29。**该断言属 WP6/WP9 的表清单面，不在本包文件列表内**（我独占的是 `agent_sessions` 表定义本身，没有增删表）。本包改动不会让它从绿变红。

### 5. 全量验证时的「红」几乎都是并行会话的中间态（重要）

复核期间工作区有 **10+ 个会话同时在写**同一个树（`git status` 里 100+ 个 M/D）。下列失败在同一分钟内反复出现又消失，都是**别人写到一半的中间态**，不是本包回归：

| 命令 | 观察到的失败 | 归因（文件属于谁） | 我的应对 |
|---|---|---|---|
| `vitest run ...` | `迁移序号重复：13` | WP9 新建了第二个 `0013` | 本包迁移改号 0014（§五.1） |
| `vitest run ...` | `Cannot find module '../../../packages/contract/src/index.ts'` | WP9 的 `src/config/model-settings.ts` / `src/app/model-role-resolver.ts` 路径段数写错 | 等待；对方修好后自动恢复 |
| `vitest run ...` | `[PARSE_ERROR] src/queue/queue-gate.ts` / `src/trigger/decide.ts` | WP7-R 正在写这两个文件 | 等待后重跑 |
| `vitest run ...` | `TypeError: eventTemplateSkillOf is not a function` | WP10 把 `agent/message.ts` 里的函数删了、`agent/index.ts` 的再导出与 `http/webhook.ts:1592` 的调用还没跟上 | 等待后重跑 |
| `tsc --noEmit` | `'loadHumanVetoed' has no exported member` / `'humanVetoedFrom'` | WP3 的 `workflows/**` ↔ `worker-deps.ts` ↔ `workflow-normalize.test.ts` 同步中 | 等待 |
| `tsc --noEmit` | `Property 'intent' does not exist on type 'never'`（`worker/run-task.ts:1710`） | WP10 正在改 `run-task.ts` | 等待 |

**基线对照**：本轮开工时的 `npx tsc --noEmit` 就已经有 4 个本包之外的错误（`src/trigger/decide.ts:191`、`src/trigger/roles.ts:59`、`test/v21-incremental-feed.test.ts:497/511`），证明本就存在别的会话的未完成状态，属于既有基线（`_baseline-fix.txt` 也写明「其余 27 个 M 无关」）。

**本包判定基线（唯一稳定的判据）**：把 tsc 输出按路径过滤掉别人的文件后，**与我的文件相关的错误恒为 0**：

```
npx tsc --noEmit 2>&1 | Select-String "error TS" |
  Where-Object { $_ -match "agent/store|agent/index|db/schema|webhook-v21|/webhook.ts|agent-session-domain|v21-worker-integration|v21-integration|v21-incremental-feed|app/compose" }
（空输出）
```

### 6. 最终验证状态（最后一次重跑，并行会话收口后）

受本包影响的 8 个测试文件**全部通过**（分两批跑，因为共用测试库的 advisory lock）：

| 命令 | 真实输出 |
|---|---|
| `npx vitest run test/agent-session-domain.test.ts test/agent-serial-queue.test.ts test/app-agent-session-plan.test.ts test/v21-webhook-integration.test.ts` | `Test Files  4 passed (4)` / `Tests  41 passed (41)` / `Duration 7.41s` |
| `npx vitest run test/v21-worker-integration.test.ts test/v21-integration.test.ts test/v21-session-prompt.test.ts test/v21-incremental-feed.test.ts` | `Test Files  4 passed (4)` / `Tests  60 passed (60)` / `Duration 5.29s` |
| `npx tsc --noEmit`（过滤到本包文件面） | 空输出 |
| `npx eslint <本包 11 个文件>` | 空输出 |

合计 **101 条测试通过**，含本包新增的 6 条域隔离用例。

**仍未拿到的完整绿灯**（如实声明）：`pnpm -r typecheck` 与 `npx vitest run`（全量）在我最后一次尝试时仍被 §四.5 表格里的并行中间态打断（`workflows/**`、`worker-deps.ts`、`run-task.ts`、`packages/envelope`），**因此不写成「通过」**。
### 7. `pnpm -r typecheck`

```
packages/envelope typecheck: test/v21.test.ts(284,1): error TS1128: Declaration or statement expected.
packages/envelope typecheck: Failed
```

`packages/envelope` 属 WP10 的文件面，正在被别的会话写入（同一分钟内该文件错误位置在变：先 `src/v21.ts:435`，后 `test/v21.test.ts:284`），是**并发写入的中间态**。
`apps/server`（本包所在包）单独跑 `npx tsc --noEmit` 是干净的（见 §4.1）。

### 6. lint

`pnpm lint`：`✖ 15 problems (9 errors, 6 warnings)`，9 个 error 全在别人的文件中（`http/api/index.ts` 重复 import、`http/api/settings.ts` 未用变量、`queries/trace.ts` 重复 import）。

本包文件单独跑 lint **零告警**：

```
npx eslint apps/server/src/agent/store.ts apps/server/src/agent/index.ts apps/server/src/db/schema.ts \
  apps/server/src/app/compose.ts apps/server/src/http/webhook-v21.ts apps/server/src/http/webhook.ts \
  apps/server/test/agent-session-domain.test.ts apps/server/test/agent-serial-queue.test.ts \
  apps/server/test/v21-worker-integration.test.ts apps/server/test/v21-integration.test.ts \
  apps/server/test/v21-incremental-feed.test.ts
（空输出，退出码 0）
```

---

## 五、跳过项、偏离与残余风险

### 1. 迁移编号 0013 → **0014**（偏离任务书写的「从 0013 起」）

任务书要求「新建 0013，别人建的 0012 不要动」。落地时 **WP9 会话（`9a557f48`）在同一分钟内也新建了 `0013_wp9_model_providers.sql`**，导致 `migrate.ts` 的 `duplicateSeq` 检查直接抛「迁移序号重复：13」，**全部 133 个连库测试连带失败**。

处理：把本包的迁移改名为 `0014_wp2_session_domain.sql`。理由：`migrations/` 是共享单账本，撞号必须有一方改号（`migrate.ts` 原文就是「先改号再跑」）；WP9 的文件在时间上晚于我最早创建的 0013，但我无法确认它是否已被 Review 引用，而本包的报告还没交，改号成本更低。**0012 未被触碰**。

### 2. 用真库验证了迁移的重复执行（发现并修了一个真 bug）

第一次实现是「`DROP` 旧主键 + `ADD` 新主键」两句直写。在已被我手工跑过一遍的测试库上重跑时炸 `multiple primary keys for table "agent_sessions" are not allowed` —— 这正是仓库「迁移在目标机上可能被人手跑过一遍」的历史教训（0009–0012 同款处理）。改成 `DO $$ … pg_get_constraintdef(oid) = 'PRIMARY KEY (repo, domain, issue_number)' … $$` 后通过。

### 3. 测试库账本里有两条 0013（历史遗留，不由我清理）

`pi_issue_bot_test.schema_migrations` 现存 `0013_wp2_session_domain`（我最早那一版）与 `0013_wp9_model_providers`。前者对应**已不存在的文件**（我改名了），`planMigrations()` 只按文件遍历、账本里多出来的 id 不会报错，所以测试能跑。但目标机若曾应用过旧 `0013_wp2_session_domain`，由于 `readMigrationsFromDir()` 不再看到那个文件，会**把它当未知记录忽略**，而新 `0014` 会再跑一遍 —— 因为本迁移是幂等的（`DO` 判断 + `IF NOT EXISTS`），重跑安全。**没有任何环境真正部署过这一版**（只在本地测试库出现过），故不写 down 迁移。

### 4. `agent_messages` / `comment_slots` / `agent_compactions` 仍是两段键

这三张表也有 `(repo, issue_number)`，理论上同样会被 PR 与 issue 同号串掉。本包**刻意不扩面**：

- 任务书的文件列表只给到 `agent/store.ts` 的 `loadSession` / `saveSession`（会话），`agent_messages` 的读写面（`insertMessage` / `readMessage` / `claimNextForIssue` …）明确不在「所有读写 `agent_sessions` 的路径」里；
- 而且 `trigger/decide.ts` 目前对 PR 固定 `pr-ignored`、**从不入队**，所以消息层暂时没有 PR 数据。

**残余风险**：一旦放开 `pull_request.*` 的处理（需求 FR-2.1 那一行「不纳入」被解除），`agent_messages` 的幂等键与 `comment_slots` 的槽位键会立刻变成串域点，必须同批加域列。建议记进项目说明 §10。

### 5. `tests/v21-integration.test.ts` 曾被我用 PowerShell `-replace` 写坏过（已修）

过程中我用 `(Get-Content -Raw) -replace ... | Set-Content` 改这个文件，PowerShell 5.1 按 ANSI 解码，把 87 处中文注释解成替换字符（U+FFFD，形如 `?` 夹在中文之间）。

处理：以 `git show HEAD:…` 为基线重建（HEAD 原文 + 用 ASCII 投影比对确认过的**唯一一处真实改动** —— 别人 WP3/WP7 的 `quota_counters` 假件 4 行 —— + 我的 3 处 `domain`），脚本见 scratch `restore-v21-integration.js`，并用 `analyse-diff.js` 复核「英文结构逐行一致」。最终 `git diff --stat` 为 `10 +++++++---`（7 增 3 删），与预期逐行吻合。**教训：中文文件的改写只用 Edit / Write。**

### 6. 与并行包的接触面（提醒编排侧）

- `apps/server/src/app/compose.ts` 被至少 4 个包认领。本包只碰 §三 列出的会话行；`git diff` 里该文件 +410/-255 的大头是**别人的既有改动**（基线里 `compose.ts` 就已是 M）。
- `apps/server/src/db/schema.ts` 我只改 `agentSessions` 一处；`git diff` 显示 201 行改动，大头同样是别人的新增表。

---

## 六、本包未做的（明确声明）

- 没有 `git add` / `git commit`。
- 没有改需求文档（`docs/requirements.html`）。
- 没有碰 `compact/**`、`runtime/**`、`queries/**`、`writeback/**`、`workflows/**`、`queue/**`、`packages/contract/**`。
- 没有跑 `drizzle-kit generate`（仓库 `meta/_journal.json` 只登记 0000，生成会重写整份 DDL；迁移发现靠 `migrate.ts` 的 `readdir`）。
- `docs/audit/fix/MASTER-PLAN.md` 的进度表未更新（属编排侧）。
