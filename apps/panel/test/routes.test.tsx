/**
 * 路由可达性：**7 条路由一次冻结**（tech-plan §9.2）+ 404 兜底。
 *
 * 断言方式：用 `AppRoutes`（与生产同一份路由表）在 `MemoryRouter` 里渲染，
 * 等页面标题（`h1`）出现——标题来自 `PageShell`，是「这一页真的挂上了」的最稳锚点。
 * MSW 在这一层就位，所以页面里的数据请求都能拿到 fixture（不会打真网络）。
 */
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { createHandlers } from '../src/mocks/handlers/index.ts';
import { AppRoutes, NAV_ITEMS, PANEL_ROUTES } from '../src/routes.tsx';

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

function renderAt(path: string): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false, gcTime: 0 } },
  });
  window.history.replaceState({}, '', path);
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('路由表', () => {
  it('冻结的路由表与导航项（原 7 条 + Issue 会话 2 条 + 技能 1 条）', () => {
    expect(PANEL_ROUTES.map((route) => route.path)).toEqual([
      '/',
      '/tasks',
      '/tasks/:id',
      '/costs',
      '/quality',
      '/audit',
      '/issues',
      '/issues/:owner/:name/:kind/:number',
      '/skills',
      '/system',
    ]);
    // 详情页不出现在左侧导航（它是 Issue 会话列表的子页面）
    expect(NAV_ITEMS.map((item) => item.path)).toEqual([
      '/',
      '/tasks',
      '/costs',
      '/quality',
      '/audit',
      '/issues',
      '/skills',
      '/system',
    ]);
  });

  const cases: ReadonlyArray<{ path: string; heading: string }> = [
    { path: '/issues', heading: 'Issue 会话' },
    { path: '/issues/acme/widgets/issue/17', heading: 'Issue 会话' },
    { path: '/', heading: '总览' },
    { path: '/tasks', heading: '任务' },
    { path: '/tasks/t-mock-1', heading: '任务详情' },
    { path: '/costs', heading: '成本' },
    { path: '/quality', heading: '质量' },
    { path: '/skills', heading: '技能' },
    { path: '/audit', heading: '审计' },
    { path: '/system', heading: '系统' },
  ];

  for (const testCase of cases) {
    it(`路由 ${testCase.path} 可达（标题「${testCase.heading}」）`, async () => {
      renderAt(testCase.path);
      expect(await screen.findByRole('heading', { level: 1, name: testCase.heading })).toBeTruthy();
    });
  }

  it('未定义的路径落到 404 页', async () => {
    renderAt('/nope');
    expect(await screen.findByRole('heading', { level: 1, name: '页面不存在' })).toBeTruthy();
  });

  it('每个页面都渲染在同一个外壳里（导航项 + 内网说明）', async () => {
    renderAt('/costs');
    expect(await screen.findByRole('heading', { level: 1, name: '成本' })).toBeTruthy();
    for (const item of NAV_ITEMS) {
      expect(screen.getAllByRole('link', { name: item.label }).length).toBeGreaterThan(0);
    }
    // 面板从「纯只读」变成「技能页可写」，文案随之更新；这里断言的是**有说明**，不锁死措辞
    expect(screen.getByText(/只有「技能」页会写数据/)).toBeTruthy();
  });
});
