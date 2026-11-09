import { http, type HttpHandler } from 'msw';
import type { RevertsResponse } from '../../lib/contract.ts';
import { MOCK_NOW, revertsEmptyFixture } from '../fixtures.ts';
import { scenarioResponse } from './shared.ts';

/**
 * 质量页（S5）的拦截器 —— **W3-J 只改这一个文件**。
 * 契约：`GET /api/quality/reverts`（`RevertsResponse`，见 `docs/spec/contract-api.md` §5）。
 *
 * 口径是契约里唯一带 `refine` 的约束：`rate = reverted / applied`，
 * **`applied > 0` 时 `rate` 不能是 null，`applied = 0` 时必须是 null**。
 * 所以这里刻意放一个 `applied = 0` 的命令桶（`/summarize`）：
 * 页面上它必须显示 `—`，而不是 `0%`（`lib/format.ts` 的 `formatPercent(null) === '—'`）。
 */

/** 按 revertedAt 降序的记录（契约要求），`revertKind` 五类各来一条。 */
export function revertsMock(): RevertsResponse {
  return {
    generatedAt: MOCK_NOW,
    window: { from: '2026-05-25T00:00:00.000Z', to: MOCK_NOW },
    // 17 / 128 = 0.1328125 ⇒ 页面显示 13.3%
    overall: { applied: 128, reverted: 17, rate: 0.1328125 },
    byCommand: [
      { key: '/review-pr', applied: 74, reverted: 11, rate: 0.148649 },
      { key: 'auto:triage', applied: 42, reverted: 5, rate: 0.119048 },
      { key: 'auto:compliance', applied: 12, reverted: 1, rate: 0.083333 },
      // 窗口内没有已应用的动作用：rate 必须是 null
      { key: '/summarize', applied: 0, reverted: 0, rate: null },
    ],
    byRepo: [
      { key: 'acme/widgets', applied: 71, reverted: 10, rate: 0.140845 },
      { key: 'acme/billing', applied: 38, reverted: 5, rate: 0.131579 },
      { key: 'other/lib', applied: 19, reverted: 2, rate: 0.105263 },
    ],
    records: [
      {
        actionId: 'a-0601-11',
        taskId: 't-2026-0601-04',
        repo: 'acme/widgets',
        command: '/review-pr',
        intent: 'label',
        revertKind: 'label-removed',
        appliedAt: '2026-06-01T06:32:00.000Z',
        revertedAt: '2026-06-01T11:41:00.000Z',
        url: 'https://github.com/acme/widgets/pull/412#pullrequestreview-9001',
      },
      {
        actionId: 'a-0601-10',
        taskId: 't-2026-0601-03',
        repo: 'acme/widgets',
        command: '/review-pr',
        intent: 'comment',
        revertKind: 'changes-requested',
        appliedAt: '2026-06-01T08:02:00.000Z',
        revertedAt: '2026-06-01T10:18:00.000Z',
        url: 'https://github.com/acme/widgets/pull/409#issuecomment-9012',
      },
      {
        actionId: 'a-0601-09',
        taskId: 't-2026-0601-02',
        repo: 'acme/billing',
        command: 'auto:triage',
        intent: 'label',
        revertKind: 'label-removed',
        appliedAt: '2026-06-01T08:43:00.000Z',
        revertedAt: '2026-06-01T09:55:00.000Z',
        url: null,
      },
      {
        actionId: 'a-0601-08',
        taskId: 't-2026-0601-05',
        repo: 'other/lib',
        command: 'auto:compliance',
        intent: 'comment',
        revertKind: 'comment-deleted',
        appliedAt: '2026-06-01T05:49:00.000Z',
        revertedAt: '2026-06-01T07:30:00.000Z',
        url: 'https://github.com/other/lib/issues/88#issuecomment-9015',
      },
      {
        actionId: 'a-0531-07',
        taskId: 't-2026-0531-12',
        repo: 'acme/widgets',
        command: '/review-pr',
        intent: 'push_branch',
        revertKind: 'revert-commit',
        appliedAt: '2026-05-31T21:10:00.000Z',
        revertedAt: '2026-05-31T23:47:00.000Z',
        url: 'https://github.com/acme/widgets/commit/1f2e3d4',
      },
      {
        actionId: 'a-0531-06',
        taskId: 't-2026-0531-09',
        repo: 'acme/billing',
        command: '/review-pr',
        intent: 'create_issue',
        revertKind: 'pr-closed',
        appliedAt: '2026-05-31T18:22:00.000Z',
        revertedAt: '2026-05-31T19:04:00.000Z',
        url: 'https://github.com/acme/billing/pull/77',
      },
    ],
    // 还有更多（游标分页）：页面要提示「当前只看前 N 条」
    nextCursor: 'rev-cursor-2',
    hasMore: true,
  };
}

export const qualityHandlers: HttpHandler[] = [
  http.get('/api/quality/reverts', () =>
    scenarioResponse({ data: revertsMock(), empty: revertsEmptyFixture() }),
  ),
];
