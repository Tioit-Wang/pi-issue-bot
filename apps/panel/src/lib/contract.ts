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
  OverviewResponse,
  RevertsResponse,
  RunEventRecord,
  RunSummary,
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
  OverviewResponse,
  RevertsResponse,
  RunEventRecord,
  RunSummary,
  SystemResponse,
  TaskDetailResponse,
  TaskListItem,
  TasksResponse,
};

/** 审计行（`AuditResponse['items'][number]`）。 */
export type AuditRow = AuditResponse['items'][number];
/** 详情里的 diff（`TaskDetailResponse['diff']`）。 */
export type TaskDiff = TaskDetailResponse['diff'];

/* ── 查询入参（对应 contract 的 `*QuerySchema`，见文件头说明） ──────────────── */

/** `overviewQuerySchema` = `timeRangeShape`。 */
export type OverviewQuery = { from?: string; to?: string };

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
 * TODO(S-A): 换成契约导出 —— `packages/contract` 的 issue schema 由 S-A 补，
 * 那边落地后把这一段换成 `packages/contract/src/index.ts` 的类型再导出即可（字段名一字不改）。
 * 在那之前按 spec §3 **逐字**声明最小类型：不自行改名、不加派生字段。
 */

/** `kind` 只有两个取值（spec §3.1 查询参数 `kind?=issue|pr`，默认 `issue`）。 */
export type IssueKind = 'issue' | 'pr';

/** `GET /api/issues` 的列表行（spec §3.1）。 */
export type IssueListItem = {
  repo: string;
  kind: IssueKind;
  number: number;
  title: string | null;
  url: string | null;
  state: 'open' | 'closed' | 'unknown';
  /** `max(最后一条 task.queued_at, 最后一件 action.applied_at)`。 */
  lastActivityAt: string;
  /** 人类触发次数（tasks 行数）。 */
  humanTurns: number;
  /** 机器人发言/动作次数（actions 行数，含 label）。 */
  botTurns: number;
  /** `bot_labels` 里未移除的。 */
  labels: string[];
  /** `{ succeeded: 2, failed: 1 }`：该 issue 下的结果计数。 */
  outcomes: Record<string, number>;
  /** 最后一条机器人正文前 120 字；取不到退化成最后一条人类问题；再取不到 `null`。 */
  lastPreview: string | null;
};

/** `GET /api/issues` 的响应体（spec §3.1）。 */
export type IssuesResponse = {
  generatedAt: string;
  issues: IssueListItem[];
  hasMore: boolean;
  nextCursor: string | null;
};

/** `GET /api/issues` 的查询参数（spec §3.1；`limit` 1..100，默认 30）。 */
export type IssuesQuery = {
  repo?: string;
  kind?: IssueKind;
  limit?: number;
  /** 不透明字符串，只能原样回传。 */
  cursor?: string;
  /** 标题/编号模糊匹配（可选）。 */
  q?: string;
};

/** 单次工具调用（spec §3.2 `toolCalls[]`）。 */
export type IssueToolCall = {
  name: string;
  summary: string;
  at: string;
  ok: boolean;
};

/**
 * 一轮对话（spec §3.2 `turns[]`）：人类 = 一次任务，机器人 = 一次 run 的产出。
 *
 * 字段名严格照抄 spec：`channel` 只有人类轮有值，`labels`/`failureClass`/`taskId`
 * 只有机器人轮有值（这里统一成「没有就是 null / 空数组」，页面不必区分联合类型）。
 * `truncated` 与 `toolCalls` 同级（单轮 >50 条时置 true）。
 */
export type IssueTurn = {
  id: string;
  role: 'human' | 'bot';
  login: string;
  at: string;
  channel: 'mention' | 'command' | 'auto' | null;
  text: string | null;
  commentUrl: string | null;
  labels: string[];
  status: string | null;
  failureClass: string | null;
  /** ⚠ 仅接口字段：**不得**出现在任何 GitHub 评论里（spec §3.2 的警示）。 */
  taskId: string | null;
  toolCalls: IssueToolCall[];
  truncated?: boolean;
};

/** `GET /api/issues/:owner/:name/:kind/:number` 的响应体（spec §3.2）。 */
export type IssueSessionResponse = {
  generatedAt: string;
  issue: {
    repo: string;
    kind: IssueKind;
    number: number;
    title: string | null;
    url: string | null;
    state: 'open' | 'closed' | 'unknown';
    labels: string[];
    participants: string[];
  };
  turns: IssueTurn[];
};

/** 详情接口的路径参数：`repo` 含 `/`，所以拆成 `owner`/`name` 两段（spec §3.2）。 */
export type IssueSessionParams = {
  owner: string;
  name: string;
  kind: IssueKind;
  number: string | number;
};
/** 错误体（契约 §0.1）：所有 4xx/5xx 只有这一种形状。 */
export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};
