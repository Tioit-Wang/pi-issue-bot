/**
 * 面板侧契约类型的**唯一**入口（E8：单一事实源 = `packages/contract/src/**`）。
 *
 * 为什么不是 `openapi/pi-bot.openapi.json` + `openapi-typescript`：
 * 该产物当前有 11 个**自指 `$ref`**（`components.schemas.XResponse = {$ref: "#/components/schemas/XResponse"}`，
 * 即响应体本身丢了），`openapi-typescript` 会在 redocly 解析阶段直接抛
 * `Self-referencing circular pointer`，生成不出类型（缺陷属于 W1-A 的 `gen:openapi`，不在本 session 的可写范围）。
 *
 * 因此这里**只做类型再导出**：响应类型仍然来自那份 zod（`z.infer` 的产物），不手抄任何 DTO。
 * 唯一的例外是下面 5 个**查询入参**类型：`api.ts` 只导出了 `*Response` 类型，
 * `*Query` 是 `z.infer<typeof xxxQuerySchema>`（需要 zod 才能推导，而面板不直接依赖 zod），
 * 所以按 schema 的字面约束写在这里，一字不差（字段名、可空性、枚举取值都对齐）。
 * `gen:openapi` 修好后，把整个文件换成生成类型的别名即可，页面代码一行都不用改。
 */
import type {
  AuditResponse,
  CostsResponse,
  EnvelopeRecord,
  IssueFeedbackEvent,
  IssueLabelDecisionSummary,
  IssueListItem,
  IssueSessionResponse,
  IssuesListResponse,
  IssueToolCall,
  IssueTurn,
  OverviewResponse,
  RepoSummary as RepoSummaryContract,
  RepoSettingsResponse,
  ReposResponse,
  RevertsResponse,
  RunEventRecord,
  RunSummary,
  SaveRepoSettingsRequest,
  SystemResponse,
  TaskDetailResponse,
  TaskListItem,
  TasksResponse,
} from '../../../../packages/contract/src/index.ts';

/* ── 响应类型（与契约的 `*Response` 一一对应） ────────────────────────────── */
export type {
  AuditResponse,
  CostsResponse,
  EnvelopeRecord,
  IssueFeedbackEvent,
  IssueLabelDecisionSummary,
  IssueListItem,
  IssueSessionResponse,
  IssuesListResponse,
  IssueToolCall,
  IssueTurn,
  OverviewResponse,
  RepoSettingsResponse,
  ReposResponse,
  RevertsResponse,
  RunEventRecord,
  RunSummary,
  SaveRepoSettingsRequest,
  SystemResponse,
  TaskDetailResponse,
  TaskListItem,
  TasksResponse,
};

/** `GET /api/repos` 的一行（契约名 `RepoSummary`，避免与 `lib/repos.ts` 的面板投影同名）。 */
export type RepoSummaryItem = RepoSummaryContract;

/** 审计行（`AuditResponse['items'][number]`）。 */
export type AuditRow = AuditResponse['items'][number];
/** 详情里的 diff（`TaskDetailResponse['diff']`）。 */
export type TaskDiff = TaskDetailResponse['diff'];

/* ── 查询入参（对应 contract 的 `*QuerySchema`，见文件头说明） ──────────────── */

/** `overviewQuerySchema` = `timeRangeShape` + 可选的 `repo`（按仓库口径算 today / 趋势 / 分布）。 */
export type OverviewQuery = { from?: string; to?: string; repo?: string };

/** `systemQuerySchema`：`repo` 只收窄 `repos` 与 `flags`。 */
export type SystemQuery = { repo?: string };

/** `tasksQuerySchema`。 */
export type TasksQuery = {
  repo?: string;
  status?: TaskListItem['status'];
  failureClass?: NonNullable<TaskListItem['failureClass']>;
  command?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
};

/** `costsQuerySchema`。 */
export type CostsQuery = { from?: string; to?: string; repo?: string; top?: number };

/** `qualityQuerySchema`。 */
export type QualityQuery = {
  from?: string;
  to?: string;
  repo?: string;
  command?: string;
  cursor?: string;
  limit?: number;
};

/** `auditQuerySchema`。 */
export type AuditQuery = {
  from?: string;
  to?: string;
  repo?: string;
  command?: string;
  intent?: AuditRow['intent'];
  cursor?: string;
  limit?: number;
};

/* ── Issue 会话（`docs/spec/ux-issue-sessions.md` §3） ──────────────────────────
 * 响应/行/轮次类型全部来自 `packages/contract`（E8 单一事实源），这里只补两个
 * 契约里没有的面板侧类型：查询入参与路由路径参数（路由参数是字符串）。
 */

/** `kind` 取值 = 列表行的 `kind`（契约 `targetKindSchema`）。 */
export type IssueKind = IssueListItem['kind'];

/** `GET /api/issues` 响应体（契约名 `IssuesListResponse`，保留旧别名以免页面大改）。 */
export type IssuesResponse = IssuesListResponse;

/** `GET /api/issues` 的查询参数：`kind` 缺省 `issue`，`limit` 1..100 默认 30。 */
export type IssuesQuery = {
  repo?: string;
  kind?: IssueKind;
  /** 派生状态筛选（优先级定义见契约 `issueStatusFilterSchema`）。 */
  status?: 'running' | 'queued' | 'failed' | 'answered' | 'idle';
  /** issue 状态筛选；`unknown` = 取不到元数据。 */
  state?: IssueListItem['state'];
  /** 「我方欠一个回答」（服务端按 `state / 最后发言人 / 回复时间` 判定）。 */
  awaiting?: 'true' | 'false';
  limit?: number;
  /** 不透明字符串，只能原样回传。 */
  cursor?: string;
};
/** 详情接口的路径参数：`repo` 含 `/`，所以拆成 `owner`/`name` 两段（spec §3.2）。 */
export type IssueSessionParams = {
  owner: string;
  name: string;
  kind: IssueKind;
  number: string | number;
};

/* ── 仓库写面（`/api/repos/*`，W3-H 起有契约；形状见 `packages/contract/src/api.ts`） ──────
 *
 * 这几个类型**不手抄**：全部是契约 schema 的 `z.infer` 产物（`RepoSummaryItem` /
 * `RepoSummary` / `RepoSettingsResponse` / `SaveRepoSettingsRequest` 已在上面再导出）。
 *
 * v0.3：提示词子系统（`/api/repos/:owner/:name/prompt`、四条版本线、保存期预算预演）
 * 随「固定流水线」一起退役，对应的手写类型也一并删除。
 */

/** 错误体（契约 §0.1）：所有 4xx/5xx 只有这一种形状。 */
export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};
