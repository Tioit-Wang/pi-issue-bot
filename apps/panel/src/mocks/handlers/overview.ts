import { http, type HttpHandler } from 'msw';
import type { OverviewResponse } from '../../lib/contract.ts';
import { MOCK_NOW, overviewEmptyFixture } from '../fixtures.ts';
import { scenarioResponse } from './shared.ts';

/**
 * 总览页（S1）的拦截器 —— **W3-J 只改这一个文件**。
 * 契约：`GET /api/overview`（`OverviewResponse`，见 `docs/spec/contract-api.md` §1）。
 *
 * 为什么不用 `fixtures.ts` 里那份：那份是 P0 的「四态锚点」（字段齐全但趋势只有 4 个值、分布只有 2 桶），
 * 页面上的分桶/配色/排序看不出来。这里按契约字段**造满**：24 个整点、5 类失败、4 类结果分布、
 * doctor 告警与队列都非空，且数字之间**自洽**（`trend` 之和 = `today.tasks`，successRate = succeeded / tasks）。
 *
 * `overviewMock()` 导出给 `src/routes/__tests__/overview.test.tsx` 做「局部覆盖」
 * （例如只把 `queue.pausedUntil` 改成非空，验证熔断提示），不必再手写第二份完整 payload。
 */

const HOUR_MS = 3_600_000;
const WINDOW_START = '2026-05-31T12:00:00.000Z';

/** 24 个整点的任务数（相加 = 40，`today.tasks` 就是这个和，不手抄常量）。 */
const HOURLY_TASKS = [0, 0, 0, 0, 0, 0, 0, 2, 5, 7, 3, 1, 0, 4, 6, 5, 3, 2, 2, 0, 0, 0, 0, 0];
/** 与上面逐位对应的失败数（相加 = 4 ⇒ 成功率 90%，区间内不会有负数）。 */
const HOURLY_FAILED = [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];

/** 带 `?repo=` 时保留哪些整点（每 3 个小时留 1 个 → 数字变小，但趋势/今日仍自洽）。 */
const REPO_SCOPE_KEEP_EVERY = 3;

/** 24 点趋势：按 `MOCK_NOW` 往前推整点，升序。`scoped = true` 时只留一部分整点。 */
function trendPoints(scoped: boolean): OverviewResponse['trend'] {
  const end = Date.parse(MOCK_NOW);
  return HOURLY_TASKS.map((tasks, index) => {
    const at = new Date(end - (23 - index) * HOUR_MS).toISOString();
    // `noUncheckedIndexedAccess` 下逐位取值要兜底；失败数不允许超过任务数
    const failed = Math.min(tasks, HOURLY_FAILED[index] ?? 0);
    return { at, tasks, succeeded: tasks - failed, failed };
  }).filter((_, index) => !scoped || index % REPO_SCOPE_KEEP_EVERY === 0);
}

/**
 * 总览的「正常态」payload（契约里的字段一个不落）。
 *
 * `repo` 非空 = 按该仓库口径（`today` / `trend` / 分布都只算它）：这里用「每 3 个整点留 1 个」
 * 近似，数字之间仍自洽，页面能看见「切仓库后数字变了」，而不是两份一模一样的 payload。
 */
export function overviewMock(repo: string | null = null): OverviewResponse {
  const trend = trendPoints(repo !== null);
  const taskCount = trend.reduce((total, point) => total + point.tasks, 0);
  const succeededCount = trend.reduce((total, point) => total + point.succeeded, 0);
  const failedCount = trend.reduce((total, point) => total + point.failed, 0);

  return {
    generatedAt: MOCK_NOW,
    repo,
    window: { from: WINDOW_START, to: MOCK_NOW },
    today: {
      // webhook 投递含重复，所以「投递数」永远 ≥ 任务数
      deliveries: taskCount + (repo === null ? 46 : 12),
      tasks: taskCount,
      succeeded: succeededCount,
      failed: failedCount,
      successRate: taskCount === 0 ? null : succeededCount / taskCount,
      p50Ms: repo === null ? 480_000 : 420_000,
      p95Ms: repo === null ? 1_500_000 : 1_260_000,
      costUsd: repo === null ? 0.8931 : 0.2842,
    },
    queue: { depth: 3, active: 2, oldestQueuedMs: 96_000, pausedUntil: null },
    doctor: {
      status: 'warn',
      checkedAt: '2026-06-01T11:58:00.000Z',
      failedChecks: ['disk-space'],
    },
    trend,
    // 没有出现的 outcome 不占位（契约 §1）
    outcomeDistribution: (
      [
        { outcome: 'success', count: succeededCount },
        { outcome: 'failed', count: failedCount },
        { outcome: 'timed-out', count: repo === null ? 2 : 0 },
        { outcome: 'degenerate-output', count: repo === null ? 1 : 0 },
      ] satisfies OverviewResponse['outcomeDistribution']
    ).filter((bucket) => bucket.count > 0),
    // Top5，数量降序
    failureTop: (
      [
        { failureClass: 'timeout', count: repo === null ? 3 : 1 },
        { failureClass: 'rate-limit', count: repo === null ? 2 : 1 },
        { failureClass: 'sandbox-oom', count: 1 },
        { failureClass: 'parse', count: 1 },
        { failureClass: 'auth', count: repo === null ? 1 : 0 },
      ] satisfies OverviewResponse['failureTop']
    ).filter((bucket) => bucket.count > 0),
  };
}

export const overviewHandlers: HttpHandler[] = [
  /**
   * `?repo=` 走仓库口径（`overviewMock(repo)`）；不带就是全部仓库（`repo: null`）。
   * 空串按「不带」处理——面板的 `toSearch()` 不会拼空值，但手工改 URL 时可能带上。
   */
  http.get('/api/overview', ({ request }) => {
    const repo = new URL(request.url).searchParams.get('repo');
    return scenarioResponse({
      data: overviewMock(repo === null || repo === '' ? null : repo),
      empty: overviewEmptyFixture(),
    });
  }),
];
