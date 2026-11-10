import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { Route, Routes } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHandlers } from '../../mocks/handlers/index.ts';
import { renderWithProviders } from '../../../test/render.tsx';
import { QualityPage } from '../quality.tsx';

/**
 * 质量页：被改回率（口径带真实分母）+ 改回方式分布 + 逐条记录。
 *
 * 盯的是契约里最容易做错的一条：`applied = 0` 时 `rate` 必须是 `null`（不是 0），
 * 页面对应显示 `—`。所以正常态里既有 13.3% 这种真比率，也有 `/summarize` 的 `—`。
 */
const server = setupServer(...createHandlers());
const requests: string[] = [];

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
  server.events.on('request:start', (event) => {
    requests.push(event.request.url);
  });
});

beforeEach(() => {
  requests.length = 0;
  server.use(
    http.get('/api/repos', () =>
      HttpResponse.json({
        repos: [
          { repo: 'acme/widgets', enabled: true, dryRun: false, settingsValid: true },
          { repo: 'other/lib', enabled: false, dryRun: false, settingsValid: true },
        ],
      }),
    ),
  );
});
afterAll(() => {
  server.close();
});
afterEach(() => {
  server.resetHandlers();
});

describe('/quality', () => {
  it('正常态：被改回率 + 分母口径在标题旁 + 分组条形 + 逐条记录', async () => {
    renderWithProviders(<QualityPage />, { route: '/quality' });

    expect(await screen.findByTestId('quality-content')).toBeTruthy();

    // 17 / 128 = 0.1328125 ⇒ 13.3%（比例 0–1 → 百分比只发生在 formatPercent 里）
    expect(screen.getByTestId('quality-rate').textContent).toBe('13.3%');
    // 分母口径必须写在标题旁
    expect(screen.getByText(/被改回 17 \/ 已应用 128 个动作/)).toBeTruthy();

    const buckets = screen.getByTestId('quality-buckets');
    expect(buckets.textContent).toContain('/review-pr');
    // applied = 0 的分组必须显示 —，不能是 0%
    expect(buckets.textContent).toContain('/summarize');
    expect(buckets.textContent).toContain('改回 0 / 应用 0');
    expect(within(buckets).getAllByText('—').length).toBeGreaterThan(0);

    // 改回方式分布：五类枚举值原样展示
    const kinds = screen.getByTestId('quality-kinds');
    for (const kind of ['label-removed', 'changes-requested', 'pr-closed', 'comment-deleted', 'revert-commit']) {
      expect(kinds.textContent).toContain(kind);
    }
    expect(screen.getByText(/还有更多/)).toBeTruthy();
  });

  it('点改回记录行 → 跳到 /tasks/:id', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Routes>
        <Route path="/quality" element={<QualityPage />} />
        <Route path="/tasks/:id" element={<p>任务详情桩</p>} />
      </Routes>,
      { route: '/quality' },
    );

    await screen.findByTestId('quality-content');
    await user.click(screen.getByText('t-2026-0601-04'));

    expect(await screen.findByText('任务详情桩')).toBeTruthy();
  });

  it('空态：`?mock=empty` → 没有可评估样本', async () => {
    renderWithProviders(<QualityPage />, { route: '/quality?mock=empty' });

    const empty = await screen.findByTestId('quality-empty');
    expect(empty.textContent).toContain('窗口内没有已应用的动作');
    expect(screen.queryByTestId('quality-content')).toBeNull();
  });

  it('错误态：500 → Alert + 重试按钮', async () => {
    renderWithProviders(<QualityPage />, { route: '/quality?mock=error' });

    expect((await screen.findByTestId('quality-error')).textContent).toContain('读取失败');
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });
});

describe('/quality 筛选', () => {
  it('选仓库后 `?repo=` 落到 /api/quality/reverts', async () => {
    const user = userEvent.setup();
    renderWithProviders(<QualityPage />, { route: '/quality' });

    await screen.findByTestId('quality-content');
    requests.length = 0;

    await user.selectOptions(screen.getByLabelText('仓库筛选'), 'acme/widgets');

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests.some((url) => url.includes('/api/quality/reverts') && url.includes('repo=acme%2Fwidgets'))).toBe(true);
    expect(screen.getByTestId('quality-filters').textContent).toContain('只看 acme/widgets');
  });
});