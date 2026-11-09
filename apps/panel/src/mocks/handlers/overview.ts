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

/** 24 点趋势：按 `MOCK_NOW` 往前推整点，升序。 */
function trendPoints(): OverviewResponse['trend'] {
  const end = Date.parse(MOCK_NOW);
  return HOURLY_TASKS.map((tasks, index) => {
    const at = new Date(end - (23 - index) * HOUR_MS).toISOString();
    // `noUncheckedIndexedAccess` 下逐位取值要兜底；失败数不允许超过任务数
    const failed = Math.min(tasks, HOURLY_FAILED[index] ?? 0);
    return { at, tasks, succeeded: tasks - failed, failed };
  });
}

/** 总览的「正常态」payload（契约里的字段一个不落）。 */
export function overviewMock(): OverviewResponse {
  const trend = trendPoints();
  const taskCount = trend.reduce((total, point) => total + point.tasks, 0);
  const succeededCount = trend.reduce((total, point) => total + point.succeeded, 0);
  const failedCount = trend.reduce((total, point) => total + point.failed, 0);

  return {
    generatedAt: MOCK_NOW,
    window: { from: WINDOW_START, to: MOCK_NOW },
    today: {
      // webhook 投递含重复，所以「投递数」永远 ≥ 任务数
      deliveries: taskCount + 46,
      tasks: taskCount,
      succeeded: succeededCount,
      failed: failedCount,
      successRate: taskCount === 0 ? null : succeededCount / taskCount,
      p50Ms: 480_000,
      p95Ms: 1_500_000,
      costUsd: 0.8931,
    },
    queue: { depth: 3, active: 2, oldestQueuedMs: 96_000, pausedUntil: null },
    doctor: {
      status: 'warn',
      checkedAt: '2026-06-01T11:58:00.000Z',
      failedChecks: ['disk-space'],
    },
    trend,
    // 没有出现的 outcome 不占位（契约 §1）
    outcomeDistribution: [
      { outcome: 'success', count: succeededCount },
      { outcome: 'failed', count: failedCount },
      { outcome: 'timed-out', count: 2 },
      { outcome: 'degenerate-output', count: 1 },
    ],
    // Top5，数量降序
    failureTop: [
      { failureClass: 'timeout', count: 3 },
      { failureClass: 'rate-limit', count: 2 },
      { failureClass: 'sandbox-oom', count: 1 },
      { failureClass: 'parse', count: 1 },
      { failureClass: 'auth', count: 1 },
    ],
  };
}

export const overviewHandlers: HttpHandler[] = [
  http.get('/api/overview', () =>
    scenarioResponse({ data: overviewMock(), empty: overviewEmptyFixture() }),
  ),
];
