# 契约 · 面板 API · v1.0

> 上游：`docs/tech-plan.md` v1.1 §8.3（9 个接口）、§9.3（每页数据源）、`docs/plan.md` v0.4 §6.5。
> 下游：W2-H（`queries/` + `apps/panel`）、W2-G（`http/api/**`）。
> 单一事实源：`packages/contract/src/api.ts`（zod）；产物 `openapi/pi-bot.openapi.json`（`pnpm gen:openapi` 生成，入 git）。
> **本文的 TS 类型块与 zod 一一对应**：冲突时以 zod 为准，并立刻改本文。

## 索引

| # | 接口 | 一句话 |
|---|---|---|
| 0 | 全局约定 | 时间 / 金额 / 分页 / 错误体 / 鉴权 |
| 1 | `GET /api/overview` | 吞吐、结果分布、p50/p95、队列、熔断、doctor |
| 2 | `GET /api/tasks` | 任务列表（筛选 + 游标分页） |
| 3 | `GET /api/tasks/:id` | 任务详情（runs / 事件 / 信封 / 动作 / diff） |
| 4 | `GET /api/costs` | 成本拆分与最贵任务 |
| 5 | `GET /api/quality/reverts` | 改回率 |
| 6 | `GET /api/audit` | 审计查询 |
| 7 | `GET /api/audit/export.csv` | 审计 CSV 导出 |
| 8 | `GET /api/system` | 版本 / host / 队列配置 / 保留期 / 仓库与技能 |
| 9 | `POST /webhook` | GitHub 投递入口 |
| 10 | `GET /api/issues` | 按 issue 聚合的列表（会话视图，`ux-issue-sessions.md` §3.1） |
| 11 | `GET /api/issues/:owner/:name/:kind/:number` | 一个 issue 的会话：人问 AI 答（同上 §3.2） |

---

## 0. 全局约定（所有接口共享）

| 项 | 约定 |
|---|---|
| 时间 | ISO8601 **UTC**，字符串必须以 `Z` 结尾（`2026-06-01T00:00:00Z`）。面板只做相对时间展示，不做时区换算 |
| 金额 | USD，保留 **4 位小数**（`0.0412`）；JSON 是 number，不是字符串 |
| token | 整数（`1200`），不写 `1.2k`（缩写只发生在 `lib/format.ts`） |
| 耗时 | 毫秒整数，字段名一律带 `Ms` 后缀（`p95Ms`，不是 `p95`） |
| 比例 | 0–1 的 number，**不乘 100**（`0.83` 不是 `83`），字段名带 `Rate` 后缀 |
| `null` vs `0` | 必须可区分：`null` = 「没有这个值」（队列空时的 p95、分母为 0 的比率），`0` = 「值是 0」（跑了但没花钱）。所有可缺字段用 `.nullable()`，**不用可选字段** |
| 分页 | 游标式：请求带 `cursor`（不透明，只许回传）+ `limit`（默认 50，上限 200）；响应必给 `nextCursor`（末页 `null`）与 `hasMore` |
| 筛选参数名 | `repo` / `status` / `failureClass` / `command` / `intent` / `from` / `to` / `cursor` / `limit`（camelCase，与 JSON 字段一致） |
| 排序 | 列表一律按时间倒序；`/api/costs` 的 `series` 按日期升序；`trend` 按小时升序 |
| 错误 | 所有 4xx/5xx 都是 `{ error: { code, message, details? } }`，没有第二种形状 |
| 鉴权 | `/api/*` 需要面板会话 cookie（只放 `sid`）；`/webhook` 用 HMAC 签名，不看 cookie |
| 缓存 | 一律 `Cache-Control: no-store`（面板是内网实时视图，不做条件请求） |

### 0.1 错误码与状态

```ts
type ErrorCode =
  | 'bad-request'        // 400 参数不合法
  | 'unauthorized'       // 401 未登录 / 会话过期 / webhook 验签失败
  | 'forbidden'          // 403 已登录但不是组织成员
  | 'not-found'          // 404
  | 'conflict'           // 409
  | 'payload-too-large'  // 413
  | 'unprocessable'      // 422 语义不合法（例如 from > to）
  | 'internal'           // 500
  | 'unavailable';       // 503 降级（doctor fail / DB 不可用）

interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;                          // 面向人，可含中文，不含密钥
    details?: Record<string, unknown>;        // 结构化补充（例如 zod 字段错误）
  };
}
```

### 0.2 鉴权语义（401 vs 403）

| 情形 | 状态 | code | 说明 |
|---|---|---|---|
| 没有 `sid` cookie / `panel_sessions` 无此行 / `expires_at < now()` / `revoked_at` 非空 | 401 | `unauthorized` | 前端跳 OAuth 登录 |
| 有会话但 `login` 不在组织内（或组织成员校验失败） | 403 | `forbidden` | 前端显示「不是组织成员」，**不跳登录**（再登一次也一样） |
| `/webhook` 的 `X-Hub-Signature-256` 不匹配或缺失 | 401 | `unauthorized` | 记审计，不做「宽容模式」（tech-plan §5.3） |
| `/metrics` | — | — | 不在本契约内：独立实例绑 `127.0.0.1:9464`，公网不可达（tech-plan §10.1） |

---

## 1. `GET /api/overview`

查询：`from?` `to?`（缺省最近 24h）。

```ts
interface OverviewResponse {
  generatedAt: string;                        // ISO8601 UTC
  window: { from: string; to: string };
  today: {                                    // UTC 自然日 00:00 起
    deliveries: number;                        // webhook 投递数（含重复）
    tasks: number;
    succeeded: number;
    failed: number;
    successRate: number | null;                // tasks = 0 时为 null
    p50Ms: number | null;                      // 无样本为 null
    p95Ms: number | null;
    costUsd: number;
  };
  queue: {
    depth: number;                             // 排队中
    active: number;                            // 执行中
    oldestQueuedMs: number | null;             // 队列空为 null
    pausedUntil: string | null;                // 全局 429 熔断解除时间
  };
  doctor: {
    status: 'ok' | 'warn' | 'fail' | 'unknown' | 'not-run';
    checkedAt: string | null;
    failedChecks: string[];                    // 检查项 id，≤20
  };
  trend: Array<{ at: string; tasks: number; succeeded: number; failed: number }>;  // 24 点，升序
  outcomeDistribution: Array<{                                                  // 无出现的 outcome 不占位
    outcome: 'success' | 'failed' | 'timed-out' | 'degenerate-output' | 'parse-failed' | 'interrupted';
    count: number;
  }>;
  failureTop: Array<{                                                           // Top5，数量降序
    failureClass: 'timeout' | 'interrupt' | 'degenerate-output' | 'sandbox-oom' | 'sandbox-crash'
                | 'auth' | 'rate-limit' | 'model' | 'parse' | 'github-api';
    count: number;
  }>;
}
```

## 2. `GET /api/tasks`

查询：`repo?` `status?` `failureClass?` `command?` `from?` `to?` `cursor?` `limit?`（1–200，默认 50）。

```ts
interface TaskListItem {
  id: string;
  repo: string;                               // owner/name
  source: 'webhook' | 'command' | 'cron';
  command: string;                            // '/review-pr' 或 'auto:triage' / 'auto:compliance'
  targetKind: 'issue' | 'pr';
  targetNumber: number;                       // > 0
  headSha: string | null;                     // issue 判定类为 null
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  failureClass: string | null;                // 取值同 overview.failureTop，未失败为 null
  outcome: string | null;                     // 未跑到 run 为 null
  actorLogin: string | null;                  // cron 为 null
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;                  // 未结束为 null
  costUsd: number | null;                     // 无 usage 为 null；0 = 免费
  dryRun: boolean;
}

interface TasksResponse {
  items: TaskListItem[];                      // ≤200
  nextCursor: string | null;
  hasMore: boolean;
  totalEstimate: number | null;               // 未统计好为 null
}
```

## 3. `GET /api/tasks/:id`

路径参数 `id`（字符串，≤64）。不存在 → 404 `not-found`。

```ts
interface TaskDetailResponse {
  task: TaskListItem;
  runs: Array<{
    id: string;
    attempt: number;                          // 0 起
    sessionId: string | null;
    turnId: string | null;
    startedAt: string | null;
    endedAt: string | null;
    outcome: string | null;
    failureClass: string | null;
    failureDetail: Record<string, unknown> | null;   // 其余观测信号，仅审计
  }>;                                          // ≤20
  events: Array<{                              // 按 cursor 升序，最近 500 条
    runId: string;
    cursor: number;                            // 单调递增
    kind: 'session' | 'turn' | 'tool-call' | 'approval' | 'command' | 'sandbox'
        | 'envelope' | 'action' | 'writeback' | 'notice';
    at: string;
    payload: Record<string, unknown>;
  }>;
  envelopes: Array<{                           // 每个 run 一封；校验失败的也在这里
    runId: string;
    valid: boolean;
    verdict: {
      kind: 'issue' | 'pr';
      labels: string[];
      evidence: Array<{ rule: string; quote: string; passed: boolean | null }>;
    } | null;
    actionCount: number;                       // 含被丢弃的
    usage: { inputTokens: number; outputTokens: number; costUsd: number };
  }>;                                          // ≤20
  actions: Array<{                             // ≤100
    id: string;
    runId: string;
    intent: 'comment' | 'label' | 'create_issue' | 'push_branch' | 'close_issue';
    status: 'applied' | 'dry-run' | 'skipped' | 'rejected' | 'failed';
    target: { kind: 'issue' | 'pr' | 'comment' | 'branch'; number: number | null; ref: string | null; url: string | null };
    externalRef: string | null;
    appliedAt: string | null;
    revertedAt: string | null;
    revertKind: 'label-removed' | 'changes-requested' | 'pr-closed' | 'comment-deleted' | 'revert-commit' | null;
    audit: {                                   // 写回闸门摘要；非 push 类为 null
      declared: string[]; actual: string[]; intersect: string[]; dropped: string[];   // 各 ≤200
      rejectedReason: string | null;
    } | null;
    dryRun: boolean;
  }>;
  diff: {
    available: boolean;
    text: string | null;                       // unified diff；不可用为 null
    truncated: boolean;                        // 超过 200 KB
    baseSha: string | null;
    headSha: string | null;
  };
}
```

## 4. `GET /api/costs`

查询：`from?` `to?` `repo?` `top?`（1–50，默认 10）。

```ts
interface CostsResponse {
  generatedAt: string;
  window: { from: string; to: string };
  currency: 'USD';
  total: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    pricingCoverage: number;                   // 命中价格表的 run 占比 0–1
  };
  byRepo: CostBucket[];                        // 按 costUsd 降序
  byCommand: CostBucket[];
  byModel: CostBucket[];
  series: Array<{ day: string; costUsd: number; inputTokens: number; outputTokens: number }>;  // YYYY-MM-DD，升序
  topTasks: Array<{
    taskId: string; repo: string; command: string;
    costUsd: number; inputTokens: number; outputTokens: number;
    endedAt: string | null;
  }>;
}

interface CostBucket {
  key: string;                                 // 维度值（仓库 / 命令 / 模型名）
  inputTokens: number; outputTokens: number; costUsd: number;
  tasks: number;                               // 该维度任务数
  runs: number;                                // 该维度 run 数（重试算多次）
}
```

## 5. `GET /api/quality/reverts`

查询：`from?` `to?` `repo?` `command?` `cursor?` `limit?`。

**口径**：`rate = reverted / applied`（tech-plan §7.5 末段）。`applied = 0` 时 `rate` **必须**是 `null`；
`applied > 0` 时 `rate` 不能是 `null`——这条由 zod 的 `refine` 强制，不是文案约定。

```ts
interface RevertsResponse {
  generatedAt: string;
  window: { from: string; to: string };
  overall: { applied: number; reverted: number; rate: number | null };
  byCommand: RevertBucket[];
  byRepo: RevertBucket[];
  records: Array<{                             // ≤200，按 revertedAt 降序
    actionId: string; taskId: string; repo: string; command: string;
    intent: 'comment' | 'label' | 'create_issue' | 'push_branch' | 'close_issue';
    revertKind: 'label-removed' | 'changes-requested' | 'pr-closed' | 'comment-deleted' | 'revert-commit';
    appliedAt: string; revertedAt: string;
    url: string | null;
  }>;
  nextCursor: string | null;
  hasMore: boolean;
}

interface RevertBucket {
  key: string;
  applied: number;
  reverted: number;
  rate: number | null;                         // applied = 0 ⇒ null
}
```

## 6. `GET /api/audit`

查询：`from?` `to?` `repo?` `command?` `intent?` `cursor?` `limit?`。

```ts
interface AuditResponse {
  items: AuditRow[];                           // ≤200
  nextCursor: string | null;
  hasMore: boolean;
  truncated: boolean;                          // 命中数超过导出口径（提示「请缩小范围」）
  exportLimit: number;                         // 50000（AUDIT_EXPORT_LIMIT）
}

interface AuditRow {
  id: string;                                  // actions.id
  at: string;
  repo: string;
  taskId: string;
  runId: string | null;                        // close_issue 可能来自 cron
  actor: {
    login: string | null;
    association: 'OWNER' | 'MEMBER' | 'COLLABORATOR' | 'CONTRIBUTOR' | 'NONE'
               | 'FIRST_TIMER' | 'FIRST_TIME_CONTRIBUTOR' | 'MANNEQUIN' | null;
  };
  command: string;
  target: { kind: 'issue' | 'pr' | 'comment' | 'branch'; number: number | null; ref: string | null };
  intent: 'comment' | 'label' | 'create_issue' | 'push_branch' | 'close_issue';
  status: 'applied' | 'dry-run' | 'skipped' | 'rejected' | 'failed';
  headSha: string | null;                      // 跑的是哪个提交
  externalRef: string | null;
  approval: { tool: string; decision: 'allow' | 'deny'; rule: string } | null;
  revertedAt: string | null;
  revertKind: string | null;
  dryRun: boolean;
}
```

## 7. `GET /api/audit/export.csv`

查询：同 `/api/audit`（`limit` 被忽略，上限固定 `AUDIT_EXPORT_LIMIT = 50000`）。

- 响应：`200`，`Content-Type: text/csv; charset=utf-8`，`Content-Disposition: attachment; filename="audit-<from>-<to>.csv"`。
- UTF-8 **带 BOM**（`\uFEFF`），保证 Excel 打开中文不乱码。
- 首行表头，列顺序固定为 `AUDIT_CSV_COLUMNS`（`packages/contract/src/api.ts`）：

```
id, at, repo, task_id, run_id, actor_login, actor_association, command,
target_kind, target_number, target_ref, intent, status, head_sha, external_ref,
approval_tool, approval_decision, approval_rule, reverted_at, revert_kind, dry_run
```

- 空值写空串（不写 `null`），含逗号/引号/换行的字段按 RFC 4180 加引号并把 `"` 翻倍。
- 超过 50000 行时**截断**并在响应头 `X-Pi-Bot-Truncated: true` 标出（面板显示提示，不静默丢数据）。

## 8. `GET /api/system`

无查询参数。

```ts
interface SystemResponse {
  generatedAt: string;
  version: {
    app: string;
    contract: string;                          // CONTRACT_VERSION，面板据此发现「后端换契约了」
    host: string | null;                       // 协商出的 pi-host 版本，未连上为 null
    hostPinned: boolean;                       // PIN.json 哈希校验通过
  };
  protocol: { wsPath: string; wsSubprotocol: string };   // '/v1/racp/ws' / 'pi-racp.v1.jsonrpc'
  host: { status: 'ok' | 'degraded' | 'down' | 'unknown'; lastPingAt: string | null; sessions: number };
  doctor: {
    status: 'ok' | 'warn' | 'fail' | 'unknown' | 'not-run';
    checkedAt: string | null;
    checks: Array<{ id: string; status: 'ok' | 'warn' | 'fail' | 'skip'; detail: string | null }>;   // ≤64
  };
  queue: Array<{
    name: string; pending: number; active: number; retryLimit: number;
    expireInMs: number;                        // job 存活上限，**不是**排队时长（tech-plan §5.3 F5）
  }>;
  retention: { webhookDays: number; runEventDays: number; transcriptDays: number; metricsForever: boolean };
  flags: Array<{ key: string; value: string; until: string | null }>;
  repos: Array<{ repo: string; enabled: boolean; dryRun: boolean; configValid: boolean; configError: string | null }>;
  skills: Array<{                              // 被禁用的技能也要出现（contract-skill §3）
    name: string;                              // '/review-pr'
    source: 'builtin' | 'repo';
    enabled: boolean;
    disabledReason: string | null;             // 'skill_invalid' / 'skill_conflict' / 'repo-config-missing' …
    outputs: Array<'comment' | 'labels' | 'issue' | 'pr'>;
    timeoutMs: number;                         // 已被截断到 30m 上限时等于上限
  }>;
}
```

## 9. `POST /webhook`

请求头（我们只依赖这三个）：

```ts
type WebhookHeaders = {
  'x-github-delivery': string;                 // 去重键
  'x-github-event': string;
  'x-hub-signature-256': `sha256=${string}`;   // HMAC-SHA256
};
```

请求体：GitHub 原始 JSON（验签必须用 **raw body**，不能先反序列化再 `JSON.stringify`）。

```ts
interface WebhookAcceptedResponse {
  status: 'accepted';
  deliveryId: string;
  taskId: string | null;                       // 没建任务（忽略/重复）为 null
  duplicate: boolean;                          // 命中 webhook_deliveries 去重
  action: 'enqueued' | 'duplicate' | 'ignored' | 'unauthorized' | 'paused';
  ackComment: string | null;                   // 命令类给评论回复用的确认文案
}
```

- 重复投递也返回 `200` + `duplicate: true`（GitHub 只看 2xx 决定是否重投）。
- **10 秒内必须应答**（plan §6.4）：`eyes` reaction 与入队都在 handler 内完成，执行发生在应答之后。
- 验签失败 `401`；body 超过 25 MB `413`；熔断中返回 `200` + `action:'paused'`（不丢事件、不占用并发）。

## 10. `GET /api/issues`

按 issue / PR 聚合的**会话列表**：一个 `(repo, kind, number)` 一行。事实源 `docs/spec/ux-issue-sessions.md` §3.1 + 评审修正（§11.2）。

查询：`repo?`（`owner/name`）、`kind?`（`issue|pr`，**默认 `issue`**）、`limit?`（1–100，**默认 30**）、`cursor?`。

> `limit` 的默认值/上限与 §0 的 50/200 不同：spec §3.1 单独定的口径（一屏按会话读）。
> **没有 `q`（标题搜索）**：标题只存在于 `webhook_deliveries.payload`（jsonb），按 §0「不解 jsonb 做维度」的约定不做深挖；
> 按标题检索要等后续的物化列（`issues.title` 之类），这版如实不做。

```ts
interface IssuesListResponse {
  generatedAt: string;
  issues: IssueListItem[];                    // ≤100
  nextCursor: string | null;
  hasMore: boolean;
}

interface IssueListItem {
  repo: string;                               // owner/name
  kind: 'issue' | 'pr';
  number: number;                             // > 0
  title: string | null;                       // 该 issue 最新一条投递里的 title
  url: string | null;                         // …html_url
  state: 'open' | 'closed' | 'unknown';
  stateStale: boolean;                        // true = 不是从投递事件取的（见下）
  lastActivityAt: string;                     // 四源 max，见下
  humanTurns: number;                         // tasks.source = 'command'
  autoTurns: number;                          // tasks.source <> 'command'（auto:triage / cron）
  botTurns: number;                           // actions 行数（含 label；与 turns 口径不同，见 §11.2）
  labels: string[];                           // bot_labels 里未移除的，≤50
  outcomes: Partial<Record<'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled', number>>;
  lastPreview: string | null;                 // 最后一条机器人正文前 120 字；没有则最后一条人类提问
  pipeline: IssuePipeline | null;             // 三段流水线的当前位置；无行 = null（见 §10 口径）
}
```

口径：

- **排序**：`lastActivityAt` 降序，再按 `repo`、`kind`、`number` 降序（保证分页稳定）。
- **`lastActivityAt` 取四源 max**：`tasks.queued_at`、`actions.applied_at`、`runs.ended_at`、`bot_labels.applied_at`
  —— 漏掉后两者会出现「刚失败 / 刚打标但列表没动」。
- **游标**：`base64url("<lastActivityAt>|<repo>#<kind><number>")`；下一页取
  `(lastActivityAt, repo, kind, number)` **严格小于**游标的行（keyset，不用 offset）。
  元组**必须含 `kind`**，否则同仓库的 `issue#5` 与 `pr#5` 会互相挤掉（漏行 / 重复）。不合法 → `400 bad-request`。
- **`state` 的来源**：取该 issue **任意事件**里 `received_at` 最新的一条投递（用
  `payload.repository.full_name` + `payload.<issue|pull_request>.number` 定位）的 `state`——`issues.closed` 不建任务，
  只看「最新 task 的投递」会永远显示 open。取不到时用 `issue_states.closed_at` 推断并置 `stateStale: true`；
  两者都没有则 `state: 'unknown'`、`stateStale: true`。
- **`title` / `url`** 与 `state` 来自同一条投递，只按 `title/html_url/state/number` 这几个键取值，
  不把整份 payload 拉到 Node 侧。
- **分组**：只出现被处理过的 `(repo, kind, number)`；`kind=pr` 是独立一组，不和 issue 混（spec §1.3 坑 3）。
- **`pipeline`（2026-11，固定流水线）**：每行带 `pipeline: IssuePipeline | null`——有状态行时是
  `{stage, state, category, formatFailCount, infoRequestedAt, blockedReason, readyAt, staleAt, sessionId, sessionTurns}`
  （camelCase，`.strict()`）；**无行时整个字段为 `null`**，不用空对象冒充（「没有行」= 存量 issue 一律放行）。
  数据源是 `issue_pipeline` 单表 left join，面板不解析 jsonb；形状与状态机见 `docs/impl-fixed-pipeline.md` §2.5 / §3。

错误：`400 bad-request`（`limit` / `cursor` 不合法）、`401 unauthorized`、`403 forbidden`、`503 unavailable`。

## 11. `GET /api/issues/:owner/:name/:kind/:number`

一个 issue 的**会话**：人类一轮 = 一次任务；机器人一轮 = 一次任务（**多次 attempt 合并**）。
事实源 `docs/spec/ux-issue-sessions.md` §3.2 + 评审修正（§11.2）。

路径参数：`owner`、`name`（各 1–100 个 `[A-Za-z0-9_.-]`）、`kind`（`issue|pr`）、`number`（正整数）。
**路径是四段**，不是 `:repo`：`repo` 含 `/`，`:repo` 会吞掉后面的段。

```ts
interface IssueSessionResponse {
  generatedAt: string;
  issue: {
    repo: string; kind: 'issue' | 'pr'; number: number;
    title: string | null; url: string | null; state: 'open' | 'closed' | 'unknown';
    stateStale: boolean;                     // 同列表行
    labels: string[];
    participants: string[];                  // 人类触发者 + 能解析到的机器人自身
  };
  pipeline: IssuePipeline | null;       // 与列表行同一个形状；库里无流水线行时为 null（2026-11）
  turns: IssueTurn[];                        // ≤500，at 升序；同一时刻人类在前
}

interface IssueTurn {
  id: string;                                // 'task:<taskId>' | 'run:<最后一次 runId>'
  role: 'human' | 'bot';
  login: string | null;                      // 允许 xxx[bot]
  at: string;
  channel: 'mention' | 'command' | 'auto' | null;  // 人类轮渠道；bot 轮恒为 null
  text: string | null;                       // 见「口径」的两条事实源
  commentId: string | null;                  // actions.external_ref（comment id，不是 URL）
  commentUrl: string | null;                 // 服务端拼 …/issues/<n>#issuecomment-<id>
  labels: string[];                          // 本轮打的标（human 轮为 []）
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';  // 任务级状态
  failureClass: string | null;               // 10 个失败分类之一
  taskId: string | null;                     // ⚠ 仅供面板跳 /tasks/:id，不得进任何 GitHub 评论（R2）
  attempts: number;                          // 机器人轮合并了几次 attempt（human 轮恒为 1）
  toolCalls: Array<{ name: string; summary: string | null; at: string; ok: boolean }>;  // ≤50
  truncated: boolean;                        // 合并后的工具调用 > 50 条
}
```

口径：

- **机器人轮的骨架是 `runs`，不是 `actions`**：`writeback` 在 dry-run 下不写 `actions` 行，但 `run-task` 无论成败、
  信封是否合法都会写 `runs` + `envelopes`。反过来（以 `actions` 为骨架）会出现「dry-run 仓库：人类 4 轮、机器人 0 轮、
  点进去没有气泡」。
- **同一 task 的多次 attempt 合并成一转**：代表行是最后一次 attempt（`attempt` 最大），`attempts` 只作脚注
  —— 否则重试会在时间线上凭空多出几段机器人发言。
- **人类正文**：`webhook_deliveries.payload.comment.body`（触发评论原文）；没有评论（`issues.opened` 这类事件）才退回
  `tasks.prompt_text`；都没有为 `null`。
- **机器人正文**：`envelopes.actions` 里 `intent=comment` 的 `body`（`actions` 表**没有**正文列，spec §1.3 坑 2）；没有为 `null`。
  **兜底回复（`intent='fallback'`）的正文取不到**：它只写在 GitHub 评论里，`envelopes.actions` 没有它、`actions.audit`
  只留 `bodyChars`、`run_events` 里也没有正文——所以这种轮次 `text: null`，面板用 `commentUrl` 给「见评论」外链。
- **`commentId` / `commentUrl`**：来自 `actions.external_ref`，intent 认 `comment` **以及兜底回复的 `fallback`**
  （`fallback` 不在契约的 5 个 intent 里，`queries/sql.ts` 的 `ACTION_INTENTS_SQL` 会把它筛掉——而「信封不可信但 AI 回了人话」
  恰恰最需要被看到）。`external_ref` 是**评论 id 字符串，不是 URL**；`commentUrl` 由服务端拼。
- **`login`**：机器人自身从 `repos.config.bot.login` 取（App slug 因部署而异，不硬编码），取不到为 `null`。
- **工具调用**：先按 `toolCallId`（= `itemId`）合并 `item.started` / `tool.progress` / `item.completed`
  （一个工具调用会横跨多条事件：`started` 带名字与参数、若干 `progress` 带输出、`completed` 带结束/错误），
  只认 `payload.itemType='tool'`；`item.delta`（正文流）与契约里的 `'tool-call'` 一律不进（后者在真库里永远是 0 行）。
  `name` 取 `item.started` 的 `payload.event.toolName`，取不到为 `unknown`；`summary` 取 `payload.event.args` 里第一个
  字符串字段（`command` → `path`/`file_path` → `pattern` → `query` → `url`），**只留第一行**并截 160 字，
  没有 args 才退回输出首行；`ok` 在 `item.completed` 出现 `error` / `isError:true` 时才为 false；
  `at` 取该 toolCallId 里最早一条事件的时间（工具开始时间）。单轮上限 50 条（按合并后的条数）+ `truncated`。
- **顺序**：`at` 升序；同一时刻人类在前。
- **404**：`(repo, kind, number)` 没有任何 `tasks` 行 → `not-found`。

错误：`400 bad-request`（路径参数不合法）、`401 unauthorized`、`403 forbidden`、`404 not-found`、`503 unavailable`。

### 11.1 契约写法与真实数据的差异

1. **`participants` / `login` 不能用 `loginSchema`**：App 机器人是 `xxx[bot]`，方括号不在 `loginSchema` 的正则里。
   新增 `actorHandleSchema`（1–100 字符）；契约里 `participants: ["Tioit-Wang", "pi-issue-bot-tioit[bot]"]` 的例子就是这个原因。
2. **轮次 `status` 统一取任务级状态**（`tasks.status` → 契约 5 个取值）。spec §3.2 的 bot 轮注释写「`status` 是 `runs.outcome`」，
   但同一段的例子是 `"status": "succeeded"`——那是任务状态，`OUTCOMES` 里没有 `succeeded`。两轮同口径才不会让面板拿到两套枚举。
3. **工具名只在 `item.started` 里**：`item.started` 的 payload 是
   `{event:{type:'tool_start',toolName,toolCallId,args},itemId,itemType}`，`tool.progress` 只有输出
   （`{event:{type:'tool_update',toolCallId,partialResult}}`）。所以必须按 `toolCallId` 归并再取名字；
   并且**同一个 `item.started` 也用于消息条目**（`itemType='message'`，`itemId` 是消息 uuid，没有 `toolCallId`/`toolName`），
   不过滤 `itemType='tool'` 的话每条消息都会冒充一次「工具调用」。
4. **本轮标签的归属**：`actions.intent='label'` 没有标签名列，所以用 `bot_labels.applied_at ∈ [run.started_at, run.ended_at]`
   归属到 run；已撤掉的标仍会出现在该轮（它确实在这一轮打上），issue 头部的 `labels` 只给未移除的。
5. **`botTurns`（列表）与 `turns`（会话）不是同一个数**：前者数 `actions` 行数（含 label），后者一次任务（合并 attempt）一轮；
   dry-run 仓库尤其会差很多——这是数据形状，不是 bug。

### 11.2 评审修正清单（本版已全部落地）

| # | 修正 | 落点 |
|---|---|---|
| 1 | 机器人轮以 `runs` 为骨架（dry-run 不写 `actions`） | `queries/issues.ts` 的 run 查询 |
| 2 | 兜底回复 `intent='fallback'` 的正文/评论不能被筛掉 | `commentId` 的 intent 白名单 `('comment','fallback')` |
| 3 | `commentId`（`external_ref`）+ 服务端拼 `commentUrl`，不假设 `external_ref` 是 URL | `IssueTurn.commentId` / `commentUrl` |
| 4 | `humanTurns` 只数 `tasks.source='command'`，自动触发单列 `autoTurns`；`channel` 判据 `/`→command、`@answer`/提问→mention、`auto:*`/cron→auto | `IssueListItem.autoTurns`、`channelOf()` |
| 5 | `lastActivityAt` 取四源 max（`tasks` / `actions` / `runs` / `bot_labels`） | 列表 CTE 的 `greatest(...)` |
| 6 | 游标元组含 `kind`：`(lastActivityAt, repo, kind, number)` | `encodeIssueCursor` / keyset 条件 |
| 7 | `state` 取该 issue 最新投递（任意事件），取不到用 `issue_states.closed_at` 推断，新增 `stateStale` | 列表 `latest` CTE + 会话 meta |
| 8 | 去掉 `q`（标题只在 jsonb 里，这版实现不了） | `issuesQuerySchema`、本文 §10 |
| 9 | 工具调用按 `toolCallId` 合并 `item.started`/`tool.progress`/`item.completed`，只认 `itemType='tool'`；名字取 `event.toolName`，摘要取 `event.args` 首行 | 工具调用 SQL + `sqlToolArgs()` / `firstLine()` |
| 10 | 机器人 login 从 `repos.config.bot.login` 取，不硬编码 App slug，取不到为 `null` | `botLoginOfFromRow()` |
| 11 | 同一 task 的多次 attempt 合并成一转，`attempts` 作脚注 | `groupBotRuns()`、`IssueTurn.attempts` |
