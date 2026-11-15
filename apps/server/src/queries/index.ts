/**
 * `queries/` 的唯一出口 —— **E12 冻结签名**，http 层（W2-G）只从这里取数。
 *
 * ```ts
 * createQueries({ pool, now? }) => {
 *   overview(q), tasks(q), taskDetail(id), costs(q),
 *   reverts(q), audit(q), auditCsv(q), system()
 * }
 * ```
 *
 * 约定：
 *  - **只读**：全部实现只有 `select`；`createQueries` 不建池（池由入口建好传进来），也不改连接参数。
 *  - **`now` 可注入**：默认 `() => new Date()`；测试传固定时钟，断言「今日 / 最近 24h / 排队时长」的具体数字。
 *  - **返回值可被 `*ResponseSchema.parse()` 通过**：这一点由 `apps/server/test/queries-*.test.ts` 逐接口断言
 *    （不是靠 review）。
 *  - **错误语义**：参数类错误抛 `QueryError`（`code: 'bad-request' | 'unprocessable'`），
 *    http 层据此映射 400 / 422；「任务不存在」不抛，`taskDetail` 返回 `null`（http 层映射 404）。
 */
import { QueryError, resolveWindow, type QueriesDeps, type QueryErrorCode } from './sql.ts';
import { queryAudit, queryAuditCsv } from './audit.ts';
import { queryCosts } from './costs.ts';
import { queryDeliveries } from './deliveries.ts';
import type { DeliveriesParams } from './deliveries.ts';
import { queryIssueTrace } from './trace.ts';
import type { IssueTraceParams } from './trace.ts';
import { queryIssues, queryIssueSession } from './issues.ts';
import { queryOverview } from './overview.ts';
import { queryReverts } from './quality.ts';
import { querySystem } from './system.ts';
import { queryTaskDetail, queryTasks } from './tasks.ts';
import type {
  AuditQuery,
  AuditResponse,
  CostsQuery,
  CostsResponse,
  DeliveriesQuery,
  DeliveriesResponse,
  DeliveryRow,
  IssueTraceAction,
  IssueTraceResponse,
  IssueTraceRun,
  IssueTraceToolCall,
  OverviewQuery,
  OverviewResponse,
  QualityQuery,
  RevertsResponse,
  SystemQuery,
  SystemResponse,
  TaskDetailResponse,
  TasksQuery,
  TasksResponse,
  ActionRecord,
  AuditRow,
  CostBucket,
  EnvelopeRecord,
  RevertBucket,
  RunEventRecord,
  RunSummary,
  TaskDiff,
  TaskListItem,
} from './types.ts';
import type {
  IssuesListResponse,
  IssuesQuery,
  IssueSessionParams,
  IssueSessionResponse,
} from './issues.ts';

export type Queries = {
  /** 总览：今日四个数字 + 24h 趋势 + 结果分布 + 失败 Top5 + 队列深度 + 熔断 + doctor 摘要。 */
  overview: (query: OverviewQuery) => Promise<OverviewResponse>;
  /** 任务列表：5 个筛选 + 游标分页（`(queued_at, id)` keyset，倒序）。 */
  tasks: (query: TasksQuery) => Promise<TasksResponse>;
  /** 任务详情；任务不存在返回 `null`（http 层映射 404）。 */
  taskDetail: (id: string) => Promise<TaskDetailResponse | null>;
  /** 成本：按仓库/命令/模型拆分 + 按日趋势 + 最贵 N 个任务。 */
  costs: (query: CostsQuery) => Promise<CostsResponse>;
  /** 改回率：总体 + 按命令 + 按仓库 + 逐条记录（keyset 分页）。 */
  reverts: (query: QualityQuery) => Promise<RevertsResponse>;
  /** 审计：谁触发 / 哪个 sha / 写了什么 / 审批判定（keyset 分页）。 */
  audit: (query: AuditQuery) => Promise<AuditResponse>;
  /** 审计 CSV（`AUDIT_CSV_COLUMNS` 顺序 + UTF-8 BOM，上限 `AUDIT_EXPORT_LIMIT`）。 */
  auditCsv: (query: AuditQuery) => Promise<string>;
  /** 系统信息：版本 / 协议 / host / doctor / 队列配置 / 保留期 / flags / 仓库开关。 */
  system: (query?: SystemQuery) => Promise<SystemResponse>;
  /** 按 issue 聚合的列表（`(repo, kind, number)` 分组，`lastActivityAt` 倒序 + keyset 游标）。 */
  issues: (query: IssuesQuery) => Promise<IssuesListResponse>;
  /** 一个 issue 的会话（人问 AI 答）；该 issue 没有任何任务时返回 `null`（http 层映射 404）。 */
  issueSession: (params: IssueSessionParams) => Promise<IssueSessionResponse | null>;
  /**
   * 一个仓库的投递判定留痕（BR-6 / FR-6.4③）：未触发的事件也要能查到 `decisionReason`。
   * 时间窗语义同其它只读接口（默认最近 24h）；分页是 `(receivedAt, deliveryId)` 倒序的 keyset。
   */
  deliveries: (params: DeliveriesParams, query: DeliveriesQuery) => Promise<DeliveriesResponse>;
  /**
   * 一个 issue 的**完整链路**（FR-6.1/6.2/6.3 + FR-6.4③ + NFR-6）：
   * 投递（含判定原因）→ 执行（run）→ 写回（actions），并在 run 上挂
   * FR-6.2 的工具明细与 FR-6.3 的按轮次用量。
   * 「这个 issue 没被处理过」不返回 `null`（投递可能仍在，那正是要查的东西）。
   */
  issueTrace: (params: IssueTraceParams) => Promise<IssueTraceResponse>;
};

export function createQueries(deps: QueriesDeps): Queries {
  const runner = deps.pool;
  const now = (): Date => deps.now?.() ?? new Date();

  return {
    overview: (query) => queryOverview(runner, now(), query),
    tasks: (query) => queryTasks(runner, query),
    taskDetail: (id) => queryTaskDetail(runner, id),
    costs: (query) => queryCosts(runner, now(), query),
    reverts: (query) => queryReverts(runner, now(), query),
    audit: (query) => {
      const at = now();
      return queryAudit(runner, at, query, resolveWindow(query, at));
    },
    auditCsv: (query) => {
      const at = now();
      return queryAuditCsv(runner, query, resolveWindow(query, at));
    },
    system: (query: SystemQuery = {}) => querySystem(runner, now(), query),
    issues: (query) => queryIssues(runner, now(), query),
    issueSession: (params) => queryIssueSession(runner, now(), params),
    deliveries: (params, query) => {
      // 时间窗与 /api/audit 同一处补齐：缺省最近 24h，`from > to` 走 QueryError(422)
      const at = now();
      return queryDeliveries(runner, params, query, resolveWindow(query, at));
    },
    issueTrace: (params) => queryIssueTrace(runner, now(), params),
  };
}

/* ── 错误类型与查询/响应类型（http 层与面板契约测试都要用） ──────────────────── */
export { QueryError };
export type { QueryErrorCode };
export type {
  ActionRecord,
  AuditQuery,
  AuditResponse,
  AuditRow,
  CostBucket,
  CostsQuery,
  CostsResponse,
  EnvelopeRecord,
  OverviewQuery,
  OverviewResponse,
  QualityQuery,
  RevertBucket,
  RevertsResponse,
  RunEventRecord,
  RunSummary,
  SystemQuery,
  SystemResponse,
  TaskDetailResponse,
  TaskDiff,
  TaskListItem,
  TasksQuery,
  TasksResponse,
  IssuesListResponse,
  IssuesQuery,
  IssueSessionParams,
  IssueSessionResponse,
  DeliveriesQuery,
  DeliveriesResponse,
  DeliveryRow,
  DeliveriesParams,
  IssueTraceParams,
  IssueTraceResponse,
  IssueTraceRun,
  IssueTraceToolCall,
  IssueTraceAction,
};
