# 契约 · 面板 API · v1.0

> 上游：`docs/tech-plan.md` v1.1 §8.3（9 个接口）、§9.3（每页数据源）、`docs/plan.md` v0.4 §6.5。
> 下游：W2-H（`queries/` + `apps/panel`）、W2-G（`http/api/**`）。
> 单一事实源：`packages/contract/src/api.ts`（zod）；产物 `openapi/pi-bot.openapi.json`（`pnpm gen:openapi` 生成，入 git）。
> **本文的 TS 类型块与 zod 一一对应**：冲突时以 zod 为准，并立刻改本文。

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
