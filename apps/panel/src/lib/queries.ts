/**
 * TanStack Query 封装：**轮询间隔只在这里定义**（tech-plan §9.4）。
 *
 * - 总览 10s、列表 15s、详情 5s（详情页可能正在跑，要更勤）；
 * - 用轮询而不是 SSE：规模小，SSE 的复杂度不值当；接口层将来要推再换（契约预留 `/api/stream`）。
 *
 * 约定：所有 hooks 的 `queryKey` 都包含**筛选参数**，这样切筛选不会复用旧数据；
 * `taskDetail` 的 404 在 hook 里被规约成 `null`（`/api/tasks/:id` 的 404 是正常业务态，
 * 不是错误——上层面板显示「任务不存在」即可）。
 */
import { QueryClient, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ApiError, api } from './api.ts';
import type {
  AuditQuery,
  CostsQuery,
  IssueSessionParams,
  IssuesQuery,
  OverviewQuery,
  QualityQuery,
  TasksQuery,
} from './contract.ts';

/** 轮询间隔（毫秒）：总览 / 列表 / 详情。 */
export const REFETCH_INTERVAL = {
  overview: 10_000,
  list: 15_000,
  detail: 5_000,
} as const;

export const queryKeys = {
  overview: (query: OverviewQuery) => ['overview', query] as const,
  tasks: (query: TasksQuery) => ['tasks', query] as const,
  taskDetail: (id: string) => ['taskDetail', id] as const,
  costs: (query: CostsQuery) => ['costs', query] as const,
  reverts: (query: QualityQuery) => ['reverts', query] as const,
  audit: (query: AuditQuery) => ['audit', query] as const,
  issues: (query: IssuesQuery) => ['issues', query] as const,
  issueSession: (params: IssueSessionParams) => ['issueSession', params] as const,
  system: () => ['system'] as const,
};

/** 面板的 QueryClient 默认值：失败只重试一次（内网接口，重试多了只会拖慢首屏）。 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        staleTime: 0,
        refetchOnWindowFocus: true,
      },
    },
  });
}

export function useOverview(query: OverviewQuery = {}) {
  return useQuery({
    queryKey: queryKeys.overview(query),
    queryFn: () => api.overview(query),
    refetchInterval: REFETCH_INTERVAL.overview,
  });
}

export function useTasks(query: TasksQuery) {
  return useQuery({
    queryKey: queryKeys.tasks(query),
    queryFn: () => api.tasks(query),
    refetchInterval: REFETCH_INTERVAL.list,
  });
}

export function useTaskDetail(id: string) {
  return useQuery({
    queryKey: queryKeys.taskDetail(id),
    queryFn: async () => {
      try {
        return await api.taskDetail(id);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    refetchInterval: REFETCH_INTERVAL.detail,
  });
}

export function useCosts(query: CostsQuery) {
  return useQuery({
    queryKey: queryKeys.costs(query),
    queryFn: () => api.costs(query),
    refetchInterval: REFETCH_INTERVAL.list,
  });
}

export function useReverts(query: QualityQuery = {}) {
  return useQuery({
    queryKey: queryKeys.reverts(query),
    queryFn: () => api.reverts(query),
    refetchInterval: REFETCH_INTERVAL.list,
  });
}

export function useAudit(query: AuditQuery = {}) {
  return useQuery({
    queryKey: queryKeys.audit(query),
    queryFn: () => api.audit(query),
    refetchInterval: REFETCH_INTERVAL.list,
  });
}

export function useSystem() {
  return useQuery({
    queryKey: queryKeys.system(),
    queryFn: () => api.system(),
    refetchInterval: REFETCH_INTERVAL.list,
  });
}

/**
 * issue 列表（spec §3.1）：契约是**游标分页**（`cursor` 不透明 + `hasMore`/`nextCursor`），
 * 所以这里给 `useInfiniteQuery`，页面只负责「加载更多」。
 *
 * `queryKey` 带 `'pages'` 后缀：无限查询的缓存形状是 `{pages, pageParams}`，
 * 不能和单次快照的扁平响应共用 key（与 `/tasks` 列表同一约定）。
 */
export function useIssuesInfinite(query: IssuesQuery) {
  return useInfiniteQuery({
    queryKey: [...queryKeys.issues(query), 'pages'] as const,
    queryFn: ({ pageParam }) =>
      api.issues({ ...query, ...(pageParam === null ? {} : { cursor: pageParam }) }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore && lastPage.nextCursor !== null ? lastPage.nextCursor : undefined,
    refetchInterval: REFETCH_INTERVAL.list,
  });
}

/**
 * 一个 issue = 一个 session（spec §3.2），每 5s 轮询（详情可能正在跑）。
 *
 * 404 规约成 `null`：`(repo,kind,number)` 没有任何 `tasks` 行是**正常业务态**
 * （「这个 issue 我们从没处理过」），页面显示空态而不是错误态。
 */
export function useIssueSession(params: IssueSessionParams) {
  return useQuery({
    queryKey: queryKeys.issueSession(params),
    queryFn: async () => {
      try {
        return await api.issueSession(params);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    refetchInterval: REFETCH_INTERVAL.detail,
  });
}
