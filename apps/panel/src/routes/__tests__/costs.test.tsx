import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { Route, Routes } from 'react-router';
import { HttpResponse, http } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHandlers } from '../../mocks/handlers/index.ts';
import { renderWithProviders } from '../../../test/render.tsx';
import { CostsPage } from '../costs.tsx';

/**
 * 成本页：一条筛选条 + 一张主图 + 明细表 + 最贵任务表。
 *
 * 两条硬约束：
 * 1. 金额 / token / 百分比只经 `format.ts`（`$12.4837`、`86.7%`、`3.8M`）；
 * 2. `?repo=` 是**服务端筛选**（落到 `/api/costs`），命令筛选只是展示收窄（接口没有该参数）。
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

function renderCosts(route = '/costs'): ReturnType<typeof renderWithProviders> {
  return renderWithProviders(
    <Routes>
      <Route path="/costs" element={<CostsPage />} />
      <Route path="/tasks/:id" element={<p>任务详情桩</p>} />
    </Routes>,
    { route },
  );
}

describe('/costs', () => {
  it('正常态：合计（口径同句）+ 主图 + 明细 + 最贵任务表（null 结束时间显示 —）', async () => {
    renderCosts();

    expect(await screen.findByTestId('costs-content')).toBeTruthy();
    expect(screen.getByText('按天的成本')).toBeTruthy();

    const summary = screen.getByTestId('costs-summary');
    expect(summary.textContent).toContain('$12.4837');
    expect(summary.textContent).toContain('3.8M');
    expect(summary.textContent).toContain('86.7%');
    // 覆盖率 < 1 必须说出来（未命中价格表按 0 计）
    expect(summary.textContent).toContain('未命中价格表');

    // 主图：默认选中最后一天，明细条给出那天的构成
    expect(screen.getByTestId('costs-trend')).toBeTruthy();
    expect(screen.getByTestId('costs-trend-detail').textContent).toContain('2026-06-01');

    // 明细：默认按命令，占比是内联条 + 数字
    expect(screen.getByTestId('costs-bucket-/review-pr').textContent).toContain('$8.0236');
    expect(screen.getByTestId('costs-bucket-/review-pr').textContent).toContain('64.3%');

    // 最贵任务：10 条都渲染；最后一条 endedAt 为 null ⇒ —
    expect(screen.getByText('t-2026-0601-01')).toBeTruthy();
    expect(screen.getByText('t-2026-0601-10')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('切换明细维度：按仓库 / 按模型都能落到表格里', async () => {
    const user = userEvent.setup();
    renderCosts();
    await screen.findByTestId('costs-content');

    await user.click(within(screen.getByRole('radiogroup', { name: '明细维度' })).getByText('按仓库'));
    expect(screen.getByTestId('costs-bucket-acme/widgets')).toBeTruthy();

    await user.click(within(screen.getByRole('radiogroup', { name: '明细维度' })).getByText('按模型'));
    // 未命中价格表的模型成本按 0 计（0 ≠ null）
    expect(screen.getByTestId('costs-bucket-local/unpriced-qwen').textContent).toContain('$0.0000');
  });

  it('点最贵任务 → 跳到 /tasks/:id', async () => {
    const user = userEvent.setup();
    renderCosts();

    await screen.findByTestId('costs-content');
    await user.click(screen.getByText('t-2026-0601-02'));

    expect(await screen.findByText('任务详情桩')).toBeTruthy();
  });

  it('空态：`?mock=empty` → 空提示（不是一堆 $0.0000 的假数据）', async () => {
    renderWithProviders(<CostsPage />, { route: '/costs?mock=empty' });

    const empty = await screen.findByTestId('costs-empty');
    expect(empty.textContent).toContain('窗口内没有用量记录');
    expect(screen.queryByTestId('costs-content')).toBeNull();
  });
});

describe('/costs 筛选', () => {
  it('选仓库后 `?repo=` 落到 /api/costs（服务端筛选）', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CostsPage />, { route: '/costs' });

    await screen.findByTestId('costs-content');
    requests.length = 0;

    await user.selectOptions(screen.getByLabelText('仓库筛选'), 'other/lib');

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests.some((url) => url.includes('/api/costs') && url.includes('repo=other%2Flib'))).toBe(true);
    expect(screen.getByTestId('costs-filters').textContent).toContain('只看 other/lib');
  });
});