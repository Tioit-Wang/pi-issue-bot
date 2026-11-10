/**
 * 面板的 API 客户端：**一个文件、只有 GET**（契约里面板侧没有写操作，tech-plan §8.3）。
 *
 * 关于 openapi-fetch：原本按 E8 的方案是 `createClient<paths>()` + `openapi-typescript` 产物。
 * 现状是 `openapi/pi-bot.openapi.json` 的响应体是自指 `$ref`（生成会抛
 * `Self-referencing circular pointer`，见 `lib/contract.ts` 的说明），所以这里用
 * **同一份契约类型 + 原生 fetch**：类型来源不变，只换传输实现。等 spec 修好后，
 * 只需本文件换成 openapi-fetch 的 3 行调用（页面与 hooks 的签名都不用动）。
 *
 * 约定：
 * - 查询参数只带**有值**的（`undefined` / 空串不拼进 URL，否则后端 zod 会当成显式空值）；
 * - 4xx/5xx 一律抛 `ApiError`（带 status 与 `error.code`），由 hooks 决定展示或降级；
 * - CSV 导出返回 URL 字符串，交给 `<a download>` 或 `window.open`（W3-K 用）。
 */
import type {
  ApiErrorBody,
  AuditQuery,
  AuditResponse,
  CostsQuery,
  CostsResponse,
  IssueSessionParams,
  IssueSessionResponse,
  IssuesQuery,
  IssuesResponse,
  OverviewQuery,
  OverviewResponse,
  QualityQuery,
  RevertsResponse,
  SystemResponse,
  TaskDetailResponse,
  TasksQuery,
  TasksResponse,
} from './contract.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type QueryValues = Record<string, string | number | boolean | undefined>;

/** 只拼有值的参数：`{ repo: undefined, limit: 50 }` → `?limit=50`。 */
export function toSearch(query: QueryValues | undefined): string {
  if (query === undefined) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

async function request<T>(path: string, query?: QueryValues): Promise<T> {
  const response = await fetch(`${path}${toSearch(query)}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
    // 面板会话是 cookie（`sid`），同站请求必须带上
    credentials: 'same-origin',
  });

  if (!response.ok) {
    // 错误体也可能不是 JSON（网关 502 之类），此时退化成状态码文案
    let body: ApiErrorBody | null = null;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      // 非 JSON 错误体（网关 502 等）：body 保持 null，用状态码兜底
    }
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'internal',
      body?.error?.message ?? `请求失败（HTTP ${String(response.status)}）`,
      body?.error?.details,
    );
  }

  return (await response.json()) as T;
}

export const api = {
  overview: (query: OverviewQuery = {}): Promise<OverviewResponse> =>
    request<OverviewResponse>('/api/overview', { ...query }),

  tasks: (query: TasksQuery): Promise<TasksResponse> => request<TasksResponse>('/api/tasks', { ...query }),

  taskDetail: (id: string): Promise<TaskDetailResponse> =>
    request<TaskDetailResponse>(`/api/tasks/${encodeURIComponent(id)}`),

  issues: (query: IssuesQuery): Promise<IssuesResponse> =>
    request<IssuesResponse>('/api/issues', { ...query }),

  /**
   * 一个 issue = 一个 session（spec §3.2）。
   * `repo` 含 `/` 会被路由吞掉，所以路径是四段 `:owner/:name/:kind/:number`。
   */
  issueSession: (params: IssueSessionParams): Promise<IssueSessionResponse> =>
    request<IssueSessionResponse>(
      `/api/issues/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.name)}/${params.kind}/${String(params.number)}`,
    ),

  costs: (query: CostsQuery): Promise<CostsResponse> => request<CostsResponse>('/api/costs', { ...query }),

  reverts: (query: QualityQuery): Promise<RevertsResponse> =>
    request<RevertsResponse>('/api/quality/reverts', { ...query }),

  audit: (query: AuditQuery): Promise<AuditResponse> => request<AuditResponse>('/api/audit', { ...query }),

  system: (): Promise<SystemResponse> => request<SystemResponse>('/api/system'),

  /** 审计 CSV 的下载地址（`limit` 被服务端忽略，上限固定 50000）。 */
  auditCsvUrl: (query: AuditQuery = {}): string => `/api/audit/export.csv${toSearch({ ...query })}`,
};
