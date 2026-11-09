import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { overviewMock } from '../../mocks/handlers/overview.ts';
import { createHandlers } from '../../mocks/handlers/index.ts';
import { renderWithProviders } from '../../../test/render.tsx';
import { OverviewPage } from '../overview.tsx';

/**
 * 总览页（S1）的渲染断言。
 *
 * 断言的是**页面契约**（哪个数字用哪个字段、哪条提示由哪个条件触发），不是像素：
 * - 成功率的 90% 来自 `today.successRate = 36 / 40`（`formatPercent` 负责乘 100）；
 * - p95 的 `25m` 来自 `p95Ms = 1_500_000`（`formatDuration`）；
 * - 熔断提示只在 `queue.pausedUntil !== null` 时出现，所以正常态用它做「不存在」断言、
 *   熔断态用 `server.use` 局部覆盖 payload 再断言存在。
 */
const server = setupServer(...createHandlers());

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
});
afterAll(() => {
  server.close();
});
afterEach(() => {
  server.resetHandlers();
});

describe('/overview', () => {
  it('正常态：4 张统计卡 + 三张图 + doctor 提示', async () => {
    renderWithProviders(<OverviewPage />, { route: '/' });

    expect(await screen.findByTestId('overview-content')).toBeTruthy();

    for (const label of ['今日事件', '成功率', 'p95 耗时', '队列深度']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    // 数字只经 format.ts：90% = 36/40，25m = 1_500_000ms，86 = 40 个任务 + 46 次重复投递
    expect(screen.getByText('90%')).toBeTruthy();
    expect(screen.getByText('25m')).toBeTruthy();
    expect(screen.getByText('86')).toBeTruthy();

    for (const title of ['24 小时吞吐', '结果分布', '失败分类 Top5']) {
      expect(screen.getByText(title)).toBeTruthy();
    }

    // doctor 有告警 ⇒ 提示条出现，并把未通过的检查项点名
    const doctor = screen.getByTestId('overview-doctor');
    expect(doctor.textContent).toContain('doctor 未全绿');
    expect(doctor.textContent).toContain('disk-space');

    // 正常态没有熔断
    expect(screen.queryByTestId('overview-paused')).toBeNull();
  });

  it('熔断态：`queue.pausedUntil` 非空才出提示，且不误报 doctor', async () => {
    server.use(
      http.get('/api/overview', () =>
        HttpResponse.json({
          ...overviewMock(),
          queue: { depth: 12, active: 0, oldestQueuedMs: 900_000, pausedUntil: '2026-06-01T12:15:00.000Z' },
          doctor: { status: 'ok', checkedAt: '2026-06-01T12:00:00.000Z', failedChecks: [] },
        }),
      ),
    );

    renderWithProviders(<OverviewPage />, { route: '/' });

    const paused = await screen.findByTestId('overview-paused');
    expect(paused.textContent).toContain('全局 429 熔断中');
    // 队列深度 12 > 5 ⇒ 走告警色（statistic 卡仍在，只是色调用 warning）
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByTestId('overview-doctor').textContent).toContain('没有未通过的检查项');
  });

  it('空态：`?mock=empty` → 显示空提示而不是 0/0 的假数字', async () => {
    renderWithProviders(<OverviewPage />, { route:'/?mock=empty' });

    const empty = await screen.findByTestId('overview-empty');
    expect(empty.textContent).toContain('还没有任何数据');
    expect(screen.queryByTestId('overview-content')).toBeNull();
  });

  it('错误态：500 → Alert + 可重试按钮（点击不崩）', async () => {
    const user = userEvent.setup();
    renderWithProviders(<OverviewPage />, { route: '/?mock=error' });

    const error = await screen.findByTestId('overview-error');
    expect(error.textContent).toContain('读取失败');
    expect(error.textContent).toContain('读取数据库失败');

    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByTestId('overview-error')).toBeTruthy();
  });
});
