/**
 * 两级导航 + 仓库切换器 + 当前仓库工作台（W1-C 的骨架行为）。
 *
 * 用 `AppRoutes`（生产同一份路由表）渲染，因为要断言的正是「外壳 + 路由」一起工作的效果：
 * - 左栏一列两组：全局 6 条（`NAV_ITEMS`）+ 当前仓库 4 条（`:repo` 从 URL 解出来）；
 * - 仓库切换器：打开 → 搜索过滤 → 选中即跳该仓库工作台，并把仓库记进 localStorage；
 * - 四态：加载（Skeleton）/ 空 / 错 / 有数据在切换器与工作台两处都有落点。
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
import { AppRoutes, NAV_ITEMS } from '../../routes.tsx';
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

describe('两级导航', () => {
  it('没有选中仓库时：只渲染「全局」一组（空组与提示句都不出现），切换器只说「选择仓库」', async () => {
    renderAt('/');
    expect(await screen.findByRole('heading', { level: 1, name: '工作台' })).toBeTruthy();

    const nav = screen.getByRole('navigation', { name: '主导航' });
    expect(nav.textContent).toContain('全局');
    // 没有仓库上下文 → 整组「当前仓库」不渲染（版面自己解释，不写提示句）
    expect(nav.textContent).not.toContain('当前仓库');
    expect(screen.queryByTestId('sidebar-no-repo')).toBeNull();
    for (const item of NAV_ITEMS) {
      expect(within(nav).getByRole('link', { name: item.label })).toBeTruthy();
    }
    // 仓库组的 4 条链接此时不存在（避免 `undefined` 拼出的坏 URL）
    expect(within(nav).queryByRole('link', { name: '工作台' })).toBeNull();

    // 切换器触发器：只说要去做什么，不用"未选择"这种否定式次级标签
    const trigger = screen.getByRole('button', { name: '切换仓库' });
    expect(trigger.textContent).toContain('选择仓库');
    expect(trigger.textContent).not.toContain('未选择');
  });

  it('落在仓库页面时：仓库组 4 条链接指向当前仓库（不再有「流水线」），且当前页高亮', async () => {
    renderAt('/repos/acme__widgets/runs');
    expect(await screen.findByRole('heading', { level: 1, name: '运行' })).toBeTruthy();

    const nav = screen.getByRole('navigation', { name: '主导航' });
    expect(within(nav).getByRole('link', { name: '工作台' }).getAttribute('href')).toBe('/repos/acme__widgets');
    expect(within(nav).getByRole('link', { name: 'Issue 中心' }).getAttribute('href')).toBe(
      '/repos/acme__widgets/issues',
    );
    // v0.3：「流水线」页已退役，仓库组里不能再有这个链接（否则点过去是 404）
    expect(within(nav).queryByRole('link', { name: '流水线' })).toBeNull();
    expect(within(nav).getByRole('link', { name: '运行' }).getAttribute('href')).toBe('/repos/acme__widgets/runs');
    expect(within(nav).getByRole('link', { name: '设置' }).getAttribute('href')).toBe('/repos/acme__widgets/settings');

    const runsLink = within(nav).getByRole('link', { name: '运行' });
    expect(runsLink.getAttribute('aria-current')).toBe('page');

    // 两组各有微标签，且第二组带 hairline 分隔（`mt-2 border-t pt-2`）
    expect(nav.textContent).toContain('全局');
    expect(nav.textContent).toContain('当前仓库');
    const repoGroup = nav.lastElementChild as HTMLElement | null;
    expect(repoGroup?.className).toContain('border-t');
  });
});

describe('仓库切换器', () => {
  it('打开 → 两个仓库都在 → 搜索过滤 → 选中跳工作台并记住仓库', async () => {
    const user = userEvent.setup();
    renderAt('/');
    await screen.findByRole('heading', { level: 1, name: '工作台' });

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

    expect(await screen.findByRole('heading', { level: 1, name: 'acme/widgets' })).toBeTruthy();
    expect(readLastRepo()).toBe('acme/widgets');
    // 面板关闭
    expect(screen.queryByLabelText('搜索仓库')).toBeNull();
  });

  it('Escape 关闭面板并把焦点还给触发器', async () => {
    const user = userEvent.setup();
    renderAt('/');
    await screen.findByRole('heading', { level: 1, name: '工作台' });

    const trigger = screen.getByRole('button', { name: '切换仓库' });
    await user.click(trigger);
    const search = await screen.findByLabelText('搜索仓库');
    search.focus();
    await user.keyboard('{Escape}');

    expect(screen.queryByLabelText('搜索仓库')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('底部固定「全部项目」与「管理仓库…」', async () => {
    const user = userEvent.setup();
    renderAt('/repos/acme__widgets');
    await screen.findByRole('heading', { level: 1, name: 'acme/widgets' });

    await user.click(screen.getByRole('button', { name: '切换仓库' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: '全部项目' })).toBeTruthy();

    await user.click(within(menu).getByRole('menuitem', { name: '管理仓库…' }));
    expect(await screen.findByRole('heading', { level: 1, name: '系统' })).toBeTruthy();
  });

  it('空态：两个来源都没有仓库 → 提示去系统页确认安装（不是空白）', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/repos', () => HttpResponse.json({ repos: [] })),
      http.get('/api/system', () => HttpResponse.json({ ...systemMock(), repos: [] })),
    );
    renderAt('/');
    await screen.findByRole('heading', { level: 1, name: '工作台' });

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
    await screen.findByRole('heading', { level: 1, name: '工作台' });

    await user.click(screen.getByRole('button', { name: '切换仓库' }));
    const error = await screen.findByTestId('repo-switcher-error');
    expect(error.textContent).toContain('仓库清单读取失败');
    expect(within(error).getByRole('button', { name: '重试' })).toBeTruthy();
  });
});

describe('/repos/:repo 工作台', () => {
  it('正常态：面包屑 + 仓库徽章 + 最近运行 / 最近 Issue / 全局口径', async () => {
    renderAt('/repos/acme__widgets');

    expect(await screen.findByTestId('repo-workspace-content')).toBeTruthy();
    expect(screen.getByTestId('repo-breadcrumb').textContent).toContain('工作台');
    // 仓库徽章来自 /api/repos（dry-run 必须显眼：它决定「不写 GitHub」）
    const badges = screen.getByTestId('repo-workspace-badges');
    expect(badges.textContent).toContain('启用');
    await waitFor(() => {
      expect(badges.textContent).toContain('dry-run');
    });

    expect(screen.getByTestId('repo-workspace-runs')).toBeTruthy();
    expect(screen.getByTestId('repo-workspace-issues')).toBeTruthy();
    // overview 没按仓库切分 ⇒ 明确写「全局口径」
    expect(screen.getByTestId('repo-workspace-global').textContent).toContain('全局口径');
  });

  it('空态：该仓库没有任何运行与会话 → 「该仓库暂无数据」', async () => {
    renderAt('/repos/acme__widgets?mock=empty');

    const empty = await screen.findByTestId('repo-workspace-empty');
    expect(empty.textContent).toContain('该仓库暂无数据');
    expect(screen.queryByTestId('repo-workspace-content')).toBeNull();
  });

  it('错误态：500 → Alert（不是白屏）', async () => {
    renderAt('/repos/acme__widgets?mock=error');

    const error = await screen.findByTestId('repo-workspace-error');
    expect(error.textContent).toContain('读取失败');
  });

  it('加载态：先 Skeleton 再有内容', async () => {
    renderAt('/repos/acme__widgets?mock=slow');

    expect(await screen.findByTestId('repo-workspace-loading')).toBeTruthy();
    expect(await screen.findByTestId('repo-workspace-content', undefined, { timeout: 5000 })).toBeTruthy();
  });

  it('设置分区：4 个分区导航都在，落地页是「通用」的真表单（不是占位说明）', async () => {
    renderAt('/repos/acme__widgets/settings/general');

    expect(await screen.findByRole('heading', { level: 1, name: '设置 · 通用' })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: '设置分区' });
    for (const label of ['通用', '触发', '标签', '限额']) {
      expect(within(nav).getByRole('link', { name: label })).toBeTruthy();
    }

    // 设置来自 MSW 的 `/api/repos/:owner/:name/settings`（W3-H 的 mock），等它到再断言控件
    const section = await screen.findByTestId('repo-settings-section');
    expect(within(section).getByTestId('settings-general-repo').textContent).toBe('acme/widgets');
    expect(within(section).getByRole('switch', { name: '接受事件（enabled）' })).toBeTruthy();
    expect(within(section).getByRole('switch', { name: '干跑（dry_run）' })).toBeTruthy();
  });
});
