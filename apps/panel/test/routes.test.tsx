/**
 * 路由可达性：**多仓库工作台的路由表一次冻结**（`docs/plan-multi-repo.md` §9）+ 旧路径重定向 + 404。
 *
 * 断言方式：用 `AppRoutes`（与生产同一份路由表）在 `MemoryRouter` 里渲染，等页面标题（`h1`）
 * ——标题来自 `PageShell`，是「这一页真的挂上了」的最稳锚点。MSW 在这一层就位，
 * 所以页面里的数据请求都能拿到 fixture（不会打真网络）。
 *
 * `/api/repos` 不在 W1-C 的可写范围（`src/mocks/**` 归 W3-H），所以这里用 `server.use` 自带一份。
 */
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { HttpResponse, http } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { createHandlers } from '../src/mocks/handlers/index.ts';
import { AppRoutes, NAV_ITEMS, PANEL_ROUTES, REPO_NAV_KEYS } from '../src/routes.tsx';
import { forgetLastRepo, rememberLastRepo } from '../src/lib/repo-route.ts';

const server = setupServer(...createHandlers());

const REPOS = {
  repos: [
    { repo: 'acme/widgets', enabled: true, dryRun: true, settingsValid: true, archivedAt: null, lastActivityAt: null },
    { repo: 'other/lib', enabled: false, dryRun: false, settingsValid: true, archivedAt: null, lastActivityAt: null },
  ],
};

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
});
afterAll(() => {
  server.close();
});
afterEach(() => {
  server.resetHandlers();
  forgetLastRepo();
});

function renderAt(path: string): void {
  server.use(http.get('/api/repos', () => HttpResponse.json(REPOS)));

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
  it('冻结的路由表：全局 6 条 + 当前仓库 8 条 + 旧路径 4 条', () => {
    expect(PANEL_ROUTES.map((route) => route.path)).toEqual([
      '/',
      '/costs',
      '/quality',
      '/audit',
      '/skills',
      '/system',
      '/repos/:repo',
      '/repos/:repo/issues',
      '/repos/:repo/issues/:kind/:number',
      '/repos/:repo/pipeline',
      '/repos/:repo/runs',
      '/repos/:repo/runs/:id',
      '/repos/:repo/settings',
      '/repos/:repo/settings/:section',
      '/tasks',
      '/tasks/:id',
      '/issues',
      '/issues/:owner/:name/:kind/:number',
    ]);
  });

  it('导航只有两组：全局 6 条（NAV_ITEMS）+ 当前仓库 5 条；详情页与旧路径不进导航', () => {
    expect(NAV_ITEMS.map((item) => item.path)).toEqual(['/', '/costs', '/quality', '/audit', '/skills', '/system']);
    expect(REPO_NAV_KEYS).toEqual(['workspace', 'issues', 'pipeline', 'runs', 'settings']);
    expect(PANEL_ROUTES.filter((route) => route.nav).map((route) => route.path)).toEqual([
      '/',
      '/costs',
      '/quality',
      '/audit',
      '/skills',
      '/system',
      '/repos/:repo',
      '/repos/:repo/issues',
      '/repos/:repo/pipeline',
      '/repos/:repo/runs',
      '/repos/:repo/settings',
    ]);
  });

  /**
   * 断言目标是 `h1` 的**可访问名**（D3 收口后详情页的 h1 是数据本身，不再是「Issue 详情」）。
   * 标题里带数据的那两页用正则匹配，避免把 fixture 文案抄进测试。
   */
  const cases: ReadonlyArray<{ path: string; heading: string | RegExp }> = [
    // 全局
    { path: '/', heading: '工作台' },
    { path: '/costs', heading: '成本' },
    { path: '/quality', heading: '质量' },
    { path: '/audit', heading: '审计' },
    { path: '/skills', heading: '技能' },
    { path: '/system', heading: '系统' },
    // 当前仓库
    { path: '/repos/acme__widgets', heading: 'acme/widgets' },
    { path: '/repos/acme__widgets/issues', heading: 'Issue 中心' },
    { path: '/repos/acme__widgets/pipeline', heading: '流水线' },
    { path: '/repos/acme__widgets/issues/issue/17', heading: /^issue#17/u },
    { path: '/repos/acme__widgets/runs', heading: '运行' },
    // 运行详情：h1 = 命令 + 任务 id
    { path: '/repos/acme__widgets/runs/t-mock-1', heading: /t-mock-1/u },
    { path: '/repos/acme__widgets/settings/general', heading: '设置 · 通用' },
    { path: '/repos/acme__widgets/settings/prompt', heading: '设置 · 提示词' },
  ];

  for (const testCase of cases) {
    const label = typeof testCase.heading === 'string' ? testCase.heading : String(testCase.heading);
    it(`路由 ${testCase.path} 可达（h1「${label}」）`, async () => {
      renderAt(testCase.path);
      expect(await screen.findByRole('heading', { level: 1, name: testCase.heading })).toBeTruthy();
    });
  }

  it('未定义的路径落到 404 页', async () => {
    renderAt('/nope');
    expect(await screen.findByRole('heading', { level: 1, name: '页面不存在' })).toBeTruthy();
  });

  it('非法的 `:repo` 段（没有 `__`）→ 404，而不是拼出一个假仓库', async () => {
    renderAt('/repos/acme');
    expect(await screen.findByRole('heading', { level: 1, name: '页面不存在' })).toBeTruthy();
  });

  it('每个页面都渲染在同一个外壳里（两组导航 + 仓库切换器 + 仓库面包屑）', async () => {
    renderAt('/repos/acme__widgets/runs');
    expect(await screen.findByRole('heading', { level: 1, name: '运行' })).toBeTruthy();

    // 全局导航的 6 个链接都在左栏
    for (const item of NAV_ITEMS) {
      expect(screen.getAllByRole('link', { name: item.label }).length).toBeGreaterThan(0);
    }
    // 仓库切换器在（触发器可点）
    expect(screen.getByRole('button', { name: '切换仓库' })).toBeTruthy();
    // 面包屑：全部项目 / acme/widgets / 运行
    const crumbs = screen.getByTestId('repo-breadcrumb');
    expect(crumbs.textContent).toContain('全部项目');
    expect(crumbs.textContent).toContain('acme/widgets');
    expect(crumbs.textContent).toContain('运行');
  });
});

describe('旧路径 302 重定向', () => {
  it('`/tasks/:id` + 上次仓库 → 该仓库的运行详情', async () => {
    rememberLastRepo('acme/widgets');
    renderAt('/tasks/t-mock-1');

    expect(await screen.findByRole('heading', { level: 1, name: /t-mock-1/u })).toBeTruthy();
    expect(screen.getByTestId('task-detail-header-breadcrumb').textContent).toContain('acme/widgets');
  });

  it('`/tasks/:id` 没有上次仓库 → 回首页（不猜仓库）', async () => {
    renderAt('/tasks/t-mock-1');
    expect(await screen.findByRole('heading', { level: 1, name: '工作台' })).toBeTruthy();
  });

  it('`/tasks` → 上次仓库的运行列表', async () => {
    rememberLastRepo('acme/widgets');
    renderAt('/tasks');
    expect(await screen.findByRole('heading', { level: 1, name: '运行' })).toBeTruthy();
  });

  it('`/issues/:owner/:name/:kind/:number` → `/repos/:repo/issues/:kind/:number`', async () => {
    renderAt('/issues/acme/widgets/issue/17');

    expect(await screen.findByRole('heading', { level: 1, name: /^issue#17/u })).toBeTruthy();
    expect(screen.getByTestId('issue-detail-header-breadcrumb').textContent).toContain('acme/widgets');
  });

  it('`/issues` 没有上次仓库 → 回首页', async () => {
    renderAt('/issues');
    expect(await screen.findByRole('heading', { level: 1, name: '工作台' })).toBeTruthy();
  });
});
