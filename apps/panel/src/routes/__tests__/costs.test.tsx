import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { Route, Routes } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHandlers } from '../../mocks/handlers/index.ts';
import { renderWithProviders } from '../../../test/render.tsx';
import { CostsPage } from '../costs.tsx';

/**
 * 成本页（S4）的渲染断言。
 *
 * 关键点两个：
 * 1. 金额/token 只走 `format.ts`（`$12.4837`、`1M`、`86.7%`），页面里没有 `toFixed`；
 * 2. 最贵任务表**可点进详情**——用真实 `<Routes>` 验证「点行 → 到 `/tasks/:id`」这条链路，
 *    而不是只断言 `onRowClick` 被调用（那样测不到路由拼错）。
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

function renderCosts() {
  return renderWithProviders(
    <Routes>
      <Route path="/costs" element={<CostsPage />} />
      <Route path="/tasks/:id" element={<p>任务详情桩</p>} />
    </Routes>,
    { route: '/costs' },
  );
}

describe('/costs', () => {
  it('正常态：合计 + 堆叠柱 + 命令条形 + 最贵任务表（null 结束时间显示 —）', async () => {
    renderCosts();

    expect(await screen.findByTestId('costs-content')).toBeTruthy();

    expect(screen.getByText('总成本')).toBeTruthy();
    expect(screen.getByText('$12.4837')).toBeTruthy();
    expect(screen.getByText('定价覆盖率')).toBeTruthy();
    expect(screen.getByText('86.7%')).toBeTruthy();

    expect(screen.getByText('按仓库的 token')).toBeTruthy();
    expect(screen.getByText('按模型的 token')).toBeTruthy();
    expect(screen.getByText('按命令的成本')).toBeTruthy();
    expect(screen.getByText('最贵的 10 个任务')).toBeTruthy();

    // 10 条都渲染出来了；最后一条 `endedAt: null` ⇒ `—`
    expect(screen.getByText('t-2026-0601-01')).toBeTruthy();
    expect(screen.getByText('t-2026-0601-10')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    // 未命中价格表的模型成本按 0 计（`0 ≠ null`）：总 token 与合计金额仍只经 format.ts
    expect(screen.getByText('输入 token')).toBeTruthy();
    expect(screen.getByText('3.8M')).toBeTruthy();
  });

  it('点击最贵任务行 → 跳到 /tasks/:id', async () => {
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
