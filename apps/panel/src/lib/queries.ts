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
import { QueryClient, useQuery } from '@tanstack/react-query';
import { ApiError, api } from './api.ts';
import type { AuditQuery, CostsQuery, OverviewQuery, QualityQuery, TasksQuery } from './contract.ts';

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
