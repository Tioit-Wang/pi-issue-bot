/**
 * S3 任务详情：头部概要 / 三个 Tab（事件时间线 · 信封 JSON · diff）/ 404 / 错误态。
 *
 * `useParams` 需要真实路由，所以这里用 `<Routes>` 而不是直接渲染页面组件
 * （与生产同一份路由形态：`/tasks/:id`）。
 */
import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHandlers } from '../../mocks/handlers/index.ts';
import { renderWithProviders } from '../../../test/render.tsx';
import { TaskDetailPage } from '../task-detail.tsx';

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

function renderDetail(path: string): void {
  renderWithProviders(
    <Routes>
      <Route path="/tasks/:id" element={<TaskDetailPage />} />
    </Routes>,
    { route: path },
  );
}

describe('/tasks/:id 任务详情', () => {
  it('头部概要：命令 / 提交 sha / 触发人 / outcome / failure_class', async () => {
    renderDetail('/tasks/t-mock-1');

    expect(await screen.findByTestId('task-detail-content')).toBeTruthy();
    // 命令在头部徽章与字段里各一处
    expect(screen.getAllByText('/review-pr').length).toBeGreaterThan(0);
    expect(screen.getAllByText('abcdef1').length).toBeGreaterThan(0);
    expect(screen.getAllByText('dana').length).toBeGreaterThan(0);
    expect(screen.getAllByText('success').length).toBeGreaterThan(0);
    // 两次 run：第一次超时失败
    expect(screen.getAllByText('timed-out').length).toBeGreaterThan(0);
    expect(screen.getAllByText('timeout').length).toBeGreaterThan(0);
  });

  it('事件时间线：审批判定给出 allow/deny 与规则、理由', async () => {
    renderDetail('/tasks/t-mock-1');

    const events = await screen.findByTestId('task-detail-events');
    const approvals = within(events).getAllByTestId('task-detail-event-approval');
    expect(approvals).toHaveLength(2);

    const allow = approvals[0]?.textContent ?? '';
    expect(allow).toContain('Bash · allow');
    expect(allow).toContain('rule=allow-tests');

    const deny = approvals[1]?.textContent ?? '';
    expect(deny).toContain('WebFetch · deny');
    expect(deny).toContain('rule=deny-network');
    // 被拒的理由必须可见（「不知道为什么被拒」等于没有审计）
    expect(deny).toContain('金丝雀网络未放行');
  });

  it('三个 Tab 都能切换渲染，且 dropped 动作被标出', async () => {
    const user = userEvent.setup();
    renderDetail('/tasks/t-mock-1');

    await screen.findByTestId('task-detail-content');
    // 事件流与信封/动作在同一页（不再用 Tab 分栏）
    expect(screen.getByTestId('task-detail-events')).toBeTruthy();

    const envelopes = await screen.findByTestId('task-detail-envelopes');
    expect(envelopes.textContent).toContain('校验通过');
    expect(envelopes.textContent).toContain('越界');
    expect(envelopes.textContent).toContain('config/secrets.env');
    const diff = await screen.findByTestId('task-detail-diff');
    expect(diff.textContent).toContain('@@ -1,6 +1,12 @@');
    expect(diff.textContent).toContain('+  return renderSummary');
    // 行号：每一行 diff 都是「行号 + 内容」两列，21 行内容（尾部空行不占位）
    expect(diff.children.length).toBe(21);
    expect(diff.textContent).toContain('21');
    // 长行可切换折行 / 横向滚动
    const wrapToggle = screen.getByRole('button', { name: '不折行（横向滚动）' });
    await user.click(wrapToggle);
    expect(screen.getByRole('button', { name: '折行' })).toBeTruthy();
  });

  it('404：显示「任务不存在」并给回列表的入口', async () => {
    renderDetail('/tasks/missing');

    const missing = await screen.findByTestId('task-detail-empty');
    expect(missing.textContent).toContain('任务不存在');
    expect(within(missing).getByRole('link', { name: '回到审计' })).toBeTruthy();
    // 不是错误态：501/500 的「读取失败」不该出现
    expect(screen.queryByTestId('task-detail-error')).toBeNull();
  });

  it('错误态：500 走 Alert', async () => {
    renderDetail('/tasks/t-mock-1?mock=error');

    const error = await screen.findByTestId('task-detail-error');
    expect(error.textContent).toContain('读取失败');
  });

  it('慢态：先给骨架', async () => {
    renderDetail('/tasks/t-mock-1?mock=slow');

    expect(await screen.findByTestId('task-detail-loading')).toBeTruthy();
    expect(await screen.findByTestId('task-detail-content', undefined, { timeout: 5000 })).toBeTruthy();
  });
});
