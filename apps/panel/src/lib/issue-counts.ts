/**
 * Issue 队列的三个计数（待处理 / 运行中 / 失败）—— **状态带与 Issue 队列共用一份口径**。
 *
 * 为什么不直接在状态带里再算一遍：`FR-7.2` 要求「顶栏状态带回答此刻什么状态」，
 * 而 `AC-26` 之后 Issue 队列是唯一的列表页。两处各算一遍必然对不上（一个按派生状态、
 * 一个按 issue 状态），用户就会看到「状态带说 5 个失败，列表里只有 3 条」。
 *
 * ## 计数口径：全量，不是「已加载」
 *
 * 游标分页下 `issues.length` 只是这一页。`FR-7.4` 要的是队列头部的**计数**，
 * 所以这里按 `status` 各取一次 `totalEstimate`（契约 `IssuesListResponse.totalEstimate`：
 * 与一页查询共用同一份筛选谓词、且**不带游标** —— 带游标总数会随翻页变小）。
 *
 * 为什么不「拉满一页再客户端分桶」（改造前的做法，WP11 §六.3 的已知缺陷）：
 * 一页上限 100 条，超过 100 条时客户端分桶只能给出「至少这么多」，而用户以为它是精确值。
 *
 * `totalEstimate` 可能是 `null`（契约：未统计的部署 / 将来关掉聚合）——此时计数是
 * **未知**而不是 0：`null` 一路传到 `formatCount()` 显示 `—`，绝不冒充「没有待处理」。
 *
 * 状态的**定义**仍然只有一处（`components/issues/status.ts` 的 `deriveStatus`，
 * 与契约 `issueStatusFilterSchema` 的优先级逐条对齐）：这里只是把同一个 `status`
 * 参数交给服务端，让服务端按同一份谓词 count，而不是在客户端再分一次桶。
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api.ts';
import type { IssuesQuery } from './contract.ts';
import { queryKeys, REFETCH_INTERVAL } from './queries.ts';

export type IssueCounts = {
  /** 还没有结论、也不是在跑的（`queued` + `idle`）——「等我处理」。 */
  pending: number | null;
  running: number | null;
  failed: number | null;
  /**
   * 三个数字的口径：`total` = 全量（服务端 `totalEstimate`）、
   * `unknown` = 服务端没统计（`null`）、`unavailable` = 请求失败（三个数字都不可信）。
   */
  scope: 'total' | 'unknown' | 'unavailable';
};

/** 请求失败：三个数字都不可信（`scope` 让状态带能说清这一点）。 */
const UNAVAILABLE: IssueCounts = { pending: null, running: null, failed: null, scope: 'unavailable' };

/** 一次计数查询：只要 `totalEstimate`，所以 `limit: 1`（不为了计数拉一整页）。 */
function countQuery(repo: string | null, status: IssuesQuery['status']): IssuesQuery {
  return { ...(repo === null ? {} : { repo }), status, limit: 1 };
}

/** 某一档的全量计数（`null` = 服务端没统计 / 还没取到；两者都不当 0）。 */
function useIssueTotal(repo: string | null, status: IssuesQuery['status']) {
  const query = countQuery(repo, status);
  return useQuery({
    queryKey: [...queryKeys.issues(query), 'total'] as const,
    queryFn: () => api.issues(query),
    select: (data) => data.totalEstimate ?? null,
    // 与列表同一档（15s）：状态带与队列页看到的必须是同一时刻的数
    refetchInterval: REFETCH_INTERVAL.list,
  });
}

export function useIssueCounts(repo: string | null): IssueCounts {
  const queued = useIssueTotal(repo, 'queued');
  const idle = useIssueTotal(repo, 'idle');
  const running = useIssueTotal(repo, 'running');
  const failed = useIssueTotal(repo, 'failed');

  return useMemo(() => {
    if (queued.isError || idle.isError || running.isError || failed.isError) return UNAVAILABLE;

    // 「待处理」= 排队 + 无结果（两档之和）；任一侧未知则整体未知。
    const pending =
      queued.data === null || queued.data === undefined || idle.data === null || idle.data === undefined
        ? null
        : queued.data + idle.data;
    const runningTotal = running.data ?? null;
    const failedTotal = failed.data ?? null;
    const scope: IssueCounts['scope'] =
      pending === null && runningTotal === null && failedTotal === null ? 'unknown' : 'total';
    return { pending, running: runningTotal, failed: failedTotal, scope };
  }, [
    queued.data,
    queued.isError,
    idle.data,
    idle.isError,
    running.data,
    running.isError,
    failed.data,
    failed.isError,
  ]);
}

/** 状态带上一个数字的 `title`：说清它是全量还是「服务端未统计」。 */
export function countScopeTitle(counts: IssueCounts): string {
  if (counts.scope === 'unavailable') return '计数接口请求失败：数字不可信';
  if (counts.scope === 'unknown') return '服务端没有返回全量计数（totalEstimate 为 null）：数字显示为 —，不是 0';
  return '全量口径（服务端 totalEstimate，与筛选条件一致、不受翻页影响）';
}

/**
 * 队列头部的计数文案：全量已知给 `12 项`；未知给 `已加载 4 项`（**明确标出口径**）。
 *
 * 为什么 `null` 不退化成 `0 项`：服务端没统计与「真的一条都没有」是两件事。
 * 为什么 `null` 时仍显示已加载数：左栏里明明摆着那几行，写 `—` 会让人以为列表画错了。
 */
export function queueCountLabel(total: number | null, loaded: number, unit: string): string {
  if (total === null) return `已加载 ${String(loaded)} ${unit}`;
  return `${String(total)} ${unit}`;
}
