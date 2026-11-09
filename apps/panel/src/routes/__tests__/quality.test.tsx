import { screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { Route, Routes } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { userEvent } from '@testing-library/user-event';
import { createHandlers } from '../../mocks/handlers/index.ts';
import { renderWithProviders } from '../../../test/render.tsx';
import { QualityPage } from '../quality.tsx';

/**
 * 质量页（S5）的渲染断言。
 *
 * 这里盯的是契约里最容易做错的一条：`applied = 0` 时 `rate` 必须是 `null`（而不是 0），
 * 页面对应显示 `—`。所以正常态里既有 13.3% 这种真比率，也有 `/summarize` 的 `0 / 0 · —`。
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

describe('/quality', () => {
  it('正常态：改回率大数字 + 按命令条形 + 逐条记录（含 revertKind 徽章）', async () => {
    renderWithProviders(<QualityPage />, { route: '/quality' });

    expect(await screen.findByTestId('quality-content')).toBeTruthy();

    // 17 / 128 = 0.1328125 ⇒ 13.3%（比例 0–1 → 百分比只发生在 formatPercent 里）
    expect(screen.getByTestId('quality-rate').textContent).toBe('13.3%');
    expect(screen.getByText('按命令的改回分布')).toBeTruthy();
    expect(screen.getByText('逐条改回记录')).toBeTruthy();

    // applied = 0 的分组必须显示 `—`，不能是 0%
    expect(screen.getByText('/summarize')).toBeTruthy();
    expect(screen.getByText('0 / 0 · —')).toBeTruthy();

    // revertKind 原样展示（契约枚举，不翻译），五类都在
    for (const kind of ['label-removed', 'changes-requested', 'pr-closed', 'comment-deleted', 'revert-commit']) {
      expect(screen.getAllByText(kind).length).toBeGreaterThan(0);
    }
    // hasMore = true ⇒ 提示还有更多
    expect(screen.getByText(/还有更多记录/)).toBeTruthy();
  });

  it('点击改回记录行 → 跳到 /tasks/:id（record.taskId）', async () => {
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

  it('空态：`?mock=empty` → 空提示（applied = 0 时没有可评估样本）', async () => {
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
