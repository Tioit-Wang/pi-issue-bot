/**
 * 仓库的「行级状态」（`/api/repos` 的一行）：设置页顶部状态条要的
 * 「最后一次保存 N 分钟前」只在这个接口里（`settingsUpdatedAt`）。
 *
 * 为什么不复用 `lib/repos.ts` 的 `useRepoDirectory()`：它把行投影成面板需要的字段，
 * 但**丢掉了 `settingsUpdatedAt`**（那个文件不归本次改动）。这里用独立的 queryKey
 * 直接读契约里的 `RepoSummary`，保存后由 `['repos']` 前缀失效一起刷新。
 *
 * 轮询关掉：这是表单页，切回窗口就刷新会把正在编辑的内容冲掉（与草稿层同一取舍）。
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.ts';
import type { RepoSummaryItem } from '../../lib/contract.ts';

export const repoStatusQueryKey = (repo: string): readonly [string, string, string] => [
  'repos',
  'status',
  repo,
];

export function useRepoStatus(repo: string): { row: RepoSummaryItem | null; isLoading: boolean } {
  const query = useQuery({
    queryKey: repoStatusQueryKey(repo),
    queryFn: async (): Promise<RepoSummaryItem | null> => {
      const response = await api.repos();
      return response.items.find((item) => item.repo === repo) ?? null;
    },
    refetchOnWindowFocus: false,
    refetchInterval: false,
  });

  return { row: query.data ?? null, isLoading: query.isLoading };
}
