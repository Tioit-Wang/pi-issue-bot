/**
 * 路由表与导航的可达性（`AC-26` / `FR-7.1` / `Q-7` 改写后：侧栏式 admin）。
 *
 * 这里的断言就是 `AC-26` 的验收口径：「侧栏分项目 / 证据 / 全局三组；
 * 一级入口是 `nav: true` 的五条（`/`、项目三条、`/system`）；总览、成本、质量、审计
 * 四条页面**在路由表里不存在**」。
 *
 * 断言方式：用 `AppRoutes`（与生产同一份路由表）在 `MemoryRouter` 里渲染，
 * 在这个层级没有 `PageShell` 的 `h1` 了（`FR-7.3` 的标题行是数据本身），
 * 所以断言落在 `data-testid` 上：`issues` / `settings-rail` / `repo-skills` / `nav-group-*`。
 *
 * `/api/repos` 不在本文件的夹具范围（`src/mocks/**` 归 W3-H），所以这里用 `server.use` 自带一份。
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { HttpResponse, http } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { createHandlers } from '../src/mocks/handlers/index.ts';
import { AppRoutes, PANEL_ROUTES, REPO_NAV_KEYS } from '../src/routes.tsx';
import { REPO_NAV } from '../src/layout/nav.ts';
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

function renderAt(path: string): RenderResult {
  server.use(http.get('/api/repos', () => HttpResponse.json(REPOS)));

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false, gcTime: 0 } },
  });
  window.history.replaceState({}, '', path);
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 同名别名：批量 404 用例要能在循环里 `unmount()`（否则多个 404 标题会同时挂在 body 上）。 */
const renderAtView = renderAt;

describe('路由表（AC-26）', () => {
  it('冻结的路由表：全部项目 2 条 + 当前项目 8 条 + 旧路径 4 条', () => {
    expect(PANEL_ROUTES.map((route) => route.path)).toEqual([
      '/',
      '/system',
      '/repos/:repo',
      '/repos/:repo/issues',
      '/repos/:repo/issues/:kind/:number',
      '/repos/:repo/settings',
      '/repos/:repo/settings/:section',
      '/repos/:repo/skills',
      '/repos/:repo/runs',
      '/repos/:repo/runs/:id',
      '/tasks',
      '/tasks/:id',
      '/issues',
      '/issues/:owner/:name/:kind/:number',
    ]);
  });

  it('总览 / 成本 / 质量 / 审计四条页面在路由表里不存在；系统是页面（/system）', () => {
    const paths = PANEL_ROUTES.map((route) => route.path);
    for (const removed of ['/overview', '/costs', '/quality', '/audit']) {
      expect(paths).not.toContain(removed);
    }
    const rootRoute = PANEL_ROUTES.find((route) => route.path === '/');
    expect(rootRoute?.label).toBe('Issue');
    // 「系统」从模态框变成真路由：能书签、能刷新、能被 ⌘. 直接打开
    const systemRoute = PANEL_ROUTES.find((route) => route.path === '/system');
    expect(systemRoute?.label).toBe('系统');
    expect(systemRoute?.nav).toBe(true);
    expect(systemRoute?.group).toBe('global');
  });

  it('侧栏一级导航是五条：`/` + 项目三条 + `/system`；「运行」是证据页', () => {
    expect(REPO_NAV.map((item) => item.label)).toEqual(['Issue', '设置', '技能']);
    expect(REPO_NAV_KEYS).toEqual(['issues', 'settings', 'skills']);
    expect(PANEL_ROUTES.filter((route) => route.nav).map((route) => route.path)).toEqual([
      '/',
      '/system',
      '/repos/:repo/issues',
      '/repos/:repo/settings',
      '/repos/:repo/skills',
    ]);
    // 「运行」「运行详情」是证据页：路由在，但不在 `nav: true` 里
    expect(PANEL_ROUTES.find((route) => route.path === '/repos/:repo/runs')?.nav).toBe(false);
  });

  it('`/` 是「全部项目」的 Issue 队列（不是总览）', async () => {
    renderAt('/');
    expect(await screen.findByTestId('issues-content')).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1, name: '工作台' })).toBeNull();
  });

  it('旧书签 `/repos/:repo`（原「工作台」）落到 Issue 队列，不是 404', async () => {
    renderAt('/repos/acme__widgets');
    expect(await screen.findByTestId('issue-rail')).toBeTruthy();
  });

  it('项目内三条路由都可达：Issue 队列 / 设置分区 / 技能列表', async () => {
    const cases: ReadonlyArray<{ path: string; testId: string }> = [
      { path: '/repos/acme__widgets/issues', testId: 'issue-rail' },
      { path: '/repos/acme__widgets/settings/general', testId: 'repo-settings-section' },
      { path: '/repos/acme__widgets/skills', testId: 'repo-skills-list' },
    ];
    for (const testCase of cases) {
      renderAt(testCase.path);
      expect(await screen.findByTestId(testCase.testId)).toBeTruthy();
    }
  });

  it('未定义的路径落到 404 页', async () => {
    renderAt('/nope');
    expect(await screen.findByRole('heading', { level: 1, name: '页面不存在' })).toBeTruthy();
  });

  it('被删掉的四个页面都 404（书签进来不会白屏）', async () => {
    for (const removed of ['/costs', '/quality', '/audit', '/overview']) {
      const view = renderAtView(removed);
      expect((await screen.findAllByRole('heading', { level: 1, name: '页面不存在' })).length).toBeGreaterThan(0);
      view.unmount();
    }
  });

  it('退役的「流水线」页 → 404（v0.3 删除，不再有页面）', async () => {
    renderAt('/repos/acme__widgets/pipeline');
    expect(await screen.findByRole('heading', { level: 1, name: '页面不存在' })).toBeTruthy();
  });

  it('退役的「提示词」设置分区 → 404', async () => {
    renderAt('/repos/acme__widgets/settings/prompt');
    expect(await screen.findByRole('heading', { level: 1, name: '页面不存在' })).toBeTruthy();
  });

  it('非法的 `:repo` 段（没有 `__`）→ 404，而不是拼出一个假仓库', async () => {
    renderAt('/repos/acme');
    expect(await screen.findByRole('heading', { level: 1, name: '页面不存在' })).toBeTruthy();
  });

  it('每个页面都渲染在同一个外壳里：侧栏三组 + 状态带 + 面包屑', async () => {
    renderAt('/repos/acme__widgets/issues');
    expect(await screen.findByTestId('issue-rail')).toBeTruthy();

    const nav = screen.getByRole('navigation', { name: '主导航' });
    const project = within(nav).getByTestId('nav-group-project');
    expect(within(project).getByRole('link', { name: 'Issue' })).toBeTruthy();
    expect(within(project).getByRole('link', { name: '设置' })).toBeTruthy();
    expect(within(project).getByRole('link', { name: '技能' })).toBeTruthy();
    // 全局只有一个入口：侧栏最下面的「系统」链接（页面，不是浮层）
    const global = within(nav).getByTestId('nav-group-global');
    expect(within(global).getByRole('link', { name: '系统' }).getAttribute('href')).toBe('/system');
    // 面包屑由外壳画：一个视图里只有一条
    expect(screen.getByTestId('shell-breadcrumb').textContent).toContain('acme/widgets');
    // 状态带的四个数字 + 降级 chip
    const strip = screen.getByTestId('status-strip');
    expect(strip.textContent).toContain('待处理');
    expect(strip.textContent).toContain('运行中');
    expect(strip.textContent).toContain('失败');
    expect(strip.textContent).toContain('p95');
    expect(screen.getByTestId('strip-degraded')).toBeTruthy();
  });

  it('状态带的三个数字读的是 `totalEstimate`（全量），不是页面上的行数', async () => {
    /*
     * 覆盖 `/api/issues`：**只回 1 行**但 `totalEstimate` 明确是 42。
     * 如果状态带还在按「已加载的行」数，就会显示 0 或 1；按 `totalEstimate` 才是 42。
     */
    const row = {
      repo: 'acme/widgets',
      kind: 'issue' as const,
      number: 17,
      title: 'EACCES',
      url: null,
      state: 'open' as const,
      stateStale: false,
      lastActivityAt: '2026-06-01T11:59:00.000Z',
      humanTurns: 1,
      autoTurns: 0,
      botTurns: 1,
      lastReplyAt: null,
      lastActorLogin: 'alice',
      lastActorKind: 'human' as const,
      awaitingReply: false,
      labels: [],
      outcomes: { succeeded: 1 },
      lastPreview: null,
      reactionState: null,
      feedback: [],
    };
    server.use(
      http.get('/api/issues', ({ request }) => {
        const status = new URL(request.url).searchParams.get('status');
        return HttpResponse.json({
          generatedAt: '2026-06-01T12:00:00.000Z',
          issues: status === null ? [row] : [],
          hasMore: false,
          nextCursor: null,
          totalEstimate: status === null ? 1 : 42,
        });
      }),
    );

    renderAt('/');
    const strip = await screen.findByTestId('status-strip');
    // 四条计数请求回来前是 `—`；回来后必须是 42（不是 0、也不是 1）
    await waitFor(() => {
      expect(within(strip).getByTestId('strip-running').textContent).toContain('42');
    });
    expect(within(strip).getByTestId('strip-running').getAttribute('data-scope')).toBe('total');
    expect(within(strip).getByTestId('strip-failed').textContent).toContain('42');
    // 待处理 = queued + idle（两档各 42）
    expect(within(strip).getByTestId('strip-pending').textContent).toContain('84');
    expect(within(strip).getByTestId('strip-failed').getAttribute('title')).toContain('全量口径');
  });

  it('`totalEstimate` 为 `null` 时状态带显示 `—` 并说明「服务端没有返回全量计数」', async () => {
    server.use(
      http.get('/api/issues', () =>
        HttpResponse.json({
          generatedAt: '2026-06-01T12:00:00.000Z',
          issues: [],
          hasMore: false,
          nextCursor: null,
          totalEstimate: null,
        }),
      ),
    );

    renderAt('/');
    const strip = await screen.findByTestId('status-strip');
    await waitFor(() => {
      expect(within(strip).getByTestId('strip-running').getAttribute('title')).toContain('服务端没有返回全量计数');
    });
    // `null` 显示 `—`，绝不冒充 0
    expect(within(strip).getByTestId('strip-running').textContent).toContain('—');
    expect(within(strip).getByTestId('strip-running').getAttribute('data-scope')).toBe('unknown');
  });
});

describe('旧路径 302 重定向', () => {
  it('`/tasks/:id` + 上次仓库 → 该仓库的运行详情', async () => {
    rememberLastRepo('acme/widgets');
    renderAt('/tasks/t-mock-1');

    expect(await screen.findByRole('heading', { level: 1, name: /t-mock-1/u })).toBeTruthy();
    expect(screen.getByTestId('shell-breadcrumb').textContent).toContain('acme/widgets');
  });

  it('`/tasks/:id` 没有上次仓库 → 回首页（不猜仓库）', async () => {
    renderAt('/tasks/t-mock-1');
    expect(await screen.findByTestId('issues-content')).toBeTruthy();
  });

  it('`/tasks` → 上次仓库的运行列表', async () => {
    rememberLastRepo('acme/widgets');
    renderAt('/tasks');
    expect(await screen.findByRole('heading', { level: 1, name: '运行' })).toBeTruthy();
  });

  it('`/issues/:owner/:name/:kind/:number` → `/repos/:repo/issues/:kind/:number`', async () => {
    renderAt('/issues/acme/widgets/issue/17');
    expect(await screen.findByTestId('issue-conversation')).toBeTruthy();
  });

  it('`/issues` 没有上次仓库 → 回首页', async () => {
    renderAt('/issues');
    expect(await screen.findByTestId('issues-content')).toBeTruthy();
  });
});
