/**
 * 外壳导航 + 仓库切换器 + 设置分区（`FR-7.1` / `AC-26` / `AC-31`，侧栏式 admin）。
 *
 * 改造后没有顶栏、没有 dock、没有系统模态框：三层是「项目上下文（侧栏顶部切换器）
 * → 项目 / 证据 / 全局三组导航 → 系统页（`/system`）」。所以这里断言的全是**版面事实**：
 *
 * - 没有仓库上下文时项目组只剩 Issue（`/`），设置 / 技能 / 运行无处可去（不渲染死链）；
 * - 落在项目页面时三条链接指向当前项目，且当前页高亮（`aria-current`）；
 * - 仓库切换器：打开 → 搜索过滤 → 选中即跳该项目的 Issue 队列并记住仓库；
 * - 「全部项目」与「管理仓库…」固定在切换器底部，后者跳到系统页。
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { HttpResponse, http } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { createHandlers } from '../../mocks/handlers/index.ts';
import { systemMock } from '../../mocks/handlers/system.ts';
import { AppRoutes } from '../../routes.tsx';
import { REPO_NAV } from '../../layout/nav.ts';
import { forgetLastRepo, readLastRepo } from '../../lib/repo-route.ts';

const server = setupServer(...createHandlers());

const REPOS = {
  repos: [
    { repo: 'acme/widgets', enabled: true, dryRun: true, settingsValid: true, archivedAt: null, lastActivityAt: null },
    { repo: 'other/lib', enabled: false, dryRun: false, settingsValid: false, archivedAt: null, lastActivityAt: null },
  ],
};

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
});
afterAll(() => {
  server.close();
});
beforeEach(() => {
  // 默认仓库清单：单个用例可以用 `server.use` 覆盖它（后注册的 handler 优先）
  server.use(http.get('/api/repos', () => HttpResponse.json(REPOS)));
});
afterEach(() => {
  server.resetHandlers();
  forgetLastRepo();
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

/** 侧栏的三组（组名就是「这是哪一层」）。 */
function navGroup(key: 'project' | 'evidence' | 'global'): HTMLElement {
  return within(screen.getByRole('navigation', { name: '主导航' })).getByTestId(`nav-group-${key}`);
}

describe('侧栏导航（项目 / 证据 / 全局）', () => {
  it('没有项目上下文时：项目组只有 Issue，「证据」组整个不渲染', async () => {
    renderAt('/');
    expect(await screen.findByTestId('issue-rail')).toBeTruthy();

    const project = navGroup('project');
    expect(within(project).getAllByRole('link').map((link) => link.textContent)).toEqual(['Issue']);
    expect(within(project).queryByRole('link', { name: '设置' })).toBeNull();
    expect(within(project).queryByRole('link', { name: '技能' })).toBeNull();
    // 没有仓库就没有运行记录可看：证据组不渲染，而不是画一个点了 404 的链接
    expect(within(screen.getByRole('navigation', { name: '主导航' })).queryByTestId('nav-group-evidence')).toBeNull();
    // 全局组始终在：系统不依赖项目
    expect(within(navGroup('global')).getByRole('link', { name: '系统' })).toBeTruthy();

    // 切换器触发器：只说要去做什么，不用「未选择」这种否定式次级标签
    const trigger = screen.getByRole('button', { name: '切换仓库' });
    expect(trigger.textContent).toContain('选择仓库');
    expect(trigger.textContent).not.toContain('未选择');
  });

  it('落在项目页面时：三项指向当前项目，当前页高亮（aria-current）', async () => {
    renderAt('/repos/acme__widgets/settings/general');
    expect(await screen.findByTestId('repo-settings-section')).toBeTruthy();

    const project = navGroup('project');
    expect(within(project).getByRole('link', { name: 'Issue' }).getAttribute('href')).toBe('/repos/acme__widgets/issues');
    expect(within(project).getByRole('link', { name: '设置' }).getAttribute('href')).toBe('/repos/acme__widgets/settings');
    expect(within(project).getByRole('link', { name: '技能' }).getAttribute('href')).toBe('/repos/acme__widgets/skills');

    // 顺序即信息优先级：Issue 在最上
    expect(REPO_NAV.map((item) => item.label)).toEqual(['Issue', '设置', '技能']);
    expect(within(project).getByRole('link', { name: '设置' }).getAttribute('aria-current')).toBe('page');
    expect(within(project).getByRole('link', { name: 'Issue' }).getAttribute('aria-current')).toBeNull();
  });

  it('「证据」组在项目上下文里出现，指向该项目的运行列表', async () => {
    renderAt('/repos/acme__widgets/issues');
    await screen.findByTestId('issue-rail');

    const evidence = navGroup('evidence');
    expect(within(evidence).getByRole('link', { name: '运行' }).getAttribute('href')).toBe('/repos/acme__widgets/runs');
  });

  it('「系统」是页面跳转（不是浮层）：点一下路由就变', async () => {
    const user = userEvent.setup();
    renderAt('/repos/acme__widgets/issues');
    await screen.findByTestId('issue-rail');

    await user.click(within(navGroup('global')).getByRole('link', { name: '系统' }));

    expect(await screen.findByTestId('system-page')).toBeTruthy();
    // `MemoryRouter` 不动 `window.location`：路由真的变了由「系统页渲染出来」证明
  });
});

describe('仓库切换器（项目上下文）', () => {
  it('打开 → 两个仓库都在 → 搜索过滤 → 选中跳 Issue 队列并记住仓库', async () => {
    const user = userEvent.setup();
    renderAt('/');
    await screen.findByTestId('issue-rail');

    await user.click(screen.getByRole('button', { name: '切换仓库' }));

    // 搜索框自动聚焦（键盘用户直接能输入）
    const search = await screen.findByLabelText('搜索仓库');
    expect(document.activeElement).toBe(search);
    expect(await screen.findByTestId('repo-switcher-item-acme/widgets')).toBeTruthy();
    expect(screen.getByTestId('repo-switcher-item-other/lib')).toBeTruthy();

    await user.type(search, 'other');
    expect(screen.queryByTestId('repo-switcher-item-acme/widgets')).toBeNull();
    expect(screen.getByTestId('repo-switcher-item-other/lib')).toBeTruthy();

    // 搜不到时的空提示（不是空白面板）
    await user.clear(search);
    await user.type(search, 'zzz');
    expect(screen.getByTestId('repo-switcher-no-match').textContent).toContain('没有匹配');

    await user.clear(search);
    await user.click(await screen.findByTestId('repo-switcher-item-acme/widgets'));

    // 切换项目 = 落在该项目的 Issue 队列（`/repos/acme__widgets`）
    await waitFor(() => {
      expect(screen.getByTestId('repo-switcher').textContent).toContain('acme/widgets');
    });
    expect(readLastRepo()).toBe('acme/widgets');
    // 面板关闭
    expect(screen.queryByLabelText('搜索仓库')).toBeNull();
  });

  it('Escape 关闭面板并把焦点还给触发器', async () => {
    const user = userEvent.setup();
    renderAt('/');
    await screen.findByTestId('issue-rail');

    const trigger = screen.getByRole('button', { name: '切换仓库' });
    await user.click(trigger);
    const search = await screen.findByLabelText('搜索仓库');
    search.focus();
    await user.keyboard('{Escape}');

    expect(screen.queryByLabelText('搜索仓库')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('底部固定「全部项目」与「管理仓库…」（后者打开系统页）', async () => {
    const user = userEvent.setup();
    renderAt('/repos/acme__widgets/issues');
    await screen.findByTestId('issue-rail');

    await user.click(screen.getByRole('button', { name: '切换仓库' }));
    expect(await screen.findByRole('button', { name: '全部项目' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '管理仓库…' }));
    expect(await screen.findByTestId('system-page')).toBeTruthy();
  });

  it('空态：两个来源都没有仓库 → 提示去「系统」确认安装（不是空白）', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/repos', () => HttpResponse.json({ repos: [] })),
      http.get('/api/system', () => HttpResponse.json({ ...systemMock(), repos: [] })),
    );
    renderAt('/');
    await screen.findByTestId('issue-rail');

    await user.click(screen.getByRole('button', { name: '切换仓库' }));
    const empty = await screen.findByTestId('repo-switcher-empty');
    expect(empty.textContent).toContain('还没有任何仓库');
  });

  it('错误态：两个来源都 500 → 错误提示 + 重试按钮（页面不崩）', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/repos', () => HttpResponse.json({ error: { code: 'internal', message: '读不到仓库' } }, { status: 500 })),
      http.get('/api/system', () => HttpResponse.json({ error: { code: 'internal', message: '读不到系统' } }, { status: 500 })),
    );
    renderAt('/');
    await screen.findByTestId('issue-rail');

    await user.click(screen.getByRole('button', { name: '切换仓库' }));
    const error = await screen.findByTestId('repo-switcher-error');
    expect(error.textContent).toContain('仓库清单读取失败');
    expect(within(error).getByRole('button', { name: '重试' })).toBeTruthy();
  });
});

describe('设置分区（FR-7.4 的三左栏之一）', () => {
  it('4 个分区都在 rail 里，落地页是「通用」的真表单', async () => {
    renderAt('/repos/acme__widgets/settings/general');

    expect(await screen.findByTestId('repo-settings-section')).toBeTruthy();
    const rail = screen.getByTestId('settings-rail');
    const nav = within(rail).getByRole('navigation', { name: '设置分区' });
    for (const label of ['通用', '事件绑定', '标签', '执行']) {
      expect(within(nav).getByRole('link', { name: new RegExp(label, 'u') })).toBeTruthy();
    }

    const section = screen.getByTestId('repo-settings-section');
    expect(within(section).getByTestId('settings-general-repo').textContent).toBe('acme/widgets');
    expect(within(section).getByRole('switch', { name: '接受事件（enabled）' })).toBeTruthy();
    expect(within(section).getByRole('switch', { name: '写回 GitHub' })).toBeTruthy();
  });
});
