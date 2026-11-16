/**
 * 外壳（侧栏式 admin）与设计系统原语的行为测试。
 *
 * 覆盖范围刻意选「会让用户卡住」的地方，而不是像素：
 * - 侧栏三组导航：项目 / 证据 / 全局，当前页 `aria-current="page"`，`[` 折叠；
 * - 面板面包屑由外壳渲染（一个视图里只有一条）；
 * - ⌘K 命令面板：快捷键打开 / 搜索 / ↑↓ / ↵ 跳转 / Esc 关闭并把焦点还回去；
 * - ⌘. 去系统页（**导航**，不是模态框）；
 * - 主题切换：三态循环写进 `<html data-theme>` 与 localStorage；
 * - 降级横幅：一行摘要 + 详情抽屉；
 * - `AsyncSection`：错误态的重试 + 折叠技术细节、空态的可行动作、离线 pill；
 * - `AsyncSection` 之外的提示体系是 `sonner`（官方），本项目不再有自造 toast。
 *
 * 不再覆盖 `Dialog` / `Table` / `Field` / `Segmented` / `Toast`：它们要么已是 shadcn 官方产物
 * （`components/ui/*`，开合与可访问性由上游负责），要么在本轮重构里被官方组件取代
 * （`Segmented` → `ToggleGroup`、`Toast` → `sonner`），手写实现已删除。
 * 在这里再测一遍只是把上游的行为抄成第二处真相。
 */
import { toast } from 'sonner';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { HttpResponse, http } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { createHandlers } from '../src/mocks/handlers/index.ts';
import { AppRoutes } from '../src/routes.tsx';
import { AsyncSection } from '../src/components/AsyncSection.tsx';
import { closeCommandPalette } from '../src/components/CommandPalette.tsx';
import { THEME_STORAGE_KEY, setThemeMode } from '../src/layout/use-theme.ts';

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
  closeCommandPalette();
  toast.dismiss();
  setThemeMode('system');
  vi.restoreAllMocks();
});

function renderApp(path = '/'): void {
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

describe('侧栏（三组导航）', () => {
  it('项目 / 证据 / 全局三组都在，当前页是 `aria-current="page"`', async () => {
    renderApp('/repos/acme__widgets/settings/general');
    await screen.findByTestId('repo-settings-section');

    const nav = screen.getByRole('navigation', { name: '主导航' });
    const project = within(nav).getByTestId('nav-group-project');
    const evidence = within(nav).getByTestId('nav-group-evidence');
    const global = within(nav).getByTestId('nav-group-global');

    // 项目组三项按 Issue / 设置 / 技能排（顺序即优先级）
    expect(within(project).getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Issue',
      '设置',
      '技能',
    ]);
    // 证据组是「运行」：路由 `nav: false`，但侧栏要能找回
    expect(within(evidence).getByRole('link', { name: '运行' }).getAttribute('href')).toBe(
      '/repos/acme__widgets/runs',
    );
    // 全局组只有系统，且是页面不是浮层
    expect(within(global).getByRole('link', { name: '系统' }).getAttribute('href')).toBe('/system');

    expect(within(project).getByRole('link', { name: '设置' }).getAttribute('aria-current')).toBe('page');
    expect(within(project).getByRole('link', { name: 'Issue' }).getAttribute('aria-current')).toBeNull();
  });

  it('`[` 折叠 / 展开侧栏（折叠后侧栏进入 icon 形态）', async () => {
    renderApp('/repos/acme__widgets/issues');
    await screen.findByTestId('issue-rail');

    const shell = (): HTMLElement | null => document.querySelector('[data-slot="sidebar"]');
    expect(shell()?.getAttribute('data-state')).toBe('expanded');
    expect(document.querySelector('[data-collapsible="icon"]')).toBeNull();

    // `[` 是 window 上的全局快捷键（不挂在某个元素上），所以直接派发到 window
    fireEvent.keyDown(window, { key: '[' });
    await waitFor(() => {
      expect(shell()?.getAttribute('data-state')).toBe('collapsed');
    });
    expect(document.querySelector('[data-collapsible="icon"]')).not.toBeNull();

    fireEvent.keyDown(window, { key: '[' });
    await waitFor(() => {
      expect(shell()?.getAttribute('data-state')).toBe('expanded');
    });
  });

  it('面板面包屑由外壳渲染：全部项目 / 仓库 / 当前页', async () => {
    renderApp('/repos/acme__widgets/skills');
    await screen.findByTestId('repo-skills-list');

    const crumb = screen.getByTestId('shell-breadcrumb');
    expect(crumb.textContent).toContain('全部项目');
    expect(crumb.textContent).toContain('acme/widgets');
    expect(crumb.textContent).toContain('技能');
    // 一个视图里只有一条面包屑
    expect(screen.getAllByTestId('shell-breadcrumb')).toHaveLength(1);
  });
});

describe('命令面板（⌘K）', () => {
  it('⌘K 打开、搜索「设置」后 ↵ 跳到设置页，Esc 关闭', async () => {
    const user = userEvent.setup();
    renderApp('/repos/acme__widgets/issues');
    await screen.findByTestId('issues-content');

    await user.keyboard('{Meta>}k{/Meta}');
    const palette = await screen.findByTestId('command-palette');
    const input = within(palette).getByLabelText('搜索页面、仓库与最近 issue');
    expect(document.activeElement).toBe(input);

    await user.type(input, '设置');
    const options = within(palette).getAllByRole('option');
    expect(options[0]?.textContent).toContain('设置');

    await user.keyboard('{Enter}');
    expect(await screen.findByTestId('settings-rail')).toBeTruthy();
    expect(screen.queryByTestId('command-palette')).toBeNull();

    // 从顶栏按钮打开 → Esc 关闭，焦点必须回到打开它的按钮
    const trigger = screen.getByTestId('command-trigger');
    await user.click(trigger);
    await screen.findByTestId('command-palette');
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('command-palette')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('顶栏按钮也能打开；无结果时给「换个词试试」+ 直达系统页', async () => {
    const user = userEvent.setup();
    renderApp('/repos/acme__widgets/issues');
    await screen.findByTestId('issues-content');

    await user.click(screen.getByTestId('command-trigger'));
    const palette = await screen.findByTestId('command-palette');
    await user.type(within(palette).getByLabelText('搜索页面、仓库与最近 issue'), 'zzzz');

    const empty = await screen.findByTestId('palette-empty');
    expect(empty.textContent).toContain('换个词试试');
    const toSystem = within(empty).getByRole('button', { name: '打开「系统」' });
    await user.click(toSystem);
    expect(await screen.findByTestId('system-page')).toBeTruthy();
  });

  it('↑↓ 在结果之间移动（Home/End 到首尾）', async () => {
    const user = userEvent.setup();
    renderApp('/repos/acme__widgets/issues');
    await screen.findByTestId('issues-content');

    await user.click(screen.getByTestId('command-trigger'));
    const palette = await screen.findByTestId('command-palette');
    const input = within(palette).getByLabelText('搜索页面、仓库与最近 issue');

    const first = within(palette).getAllByRole('option')[0];
    expect(first?.getAttribute('aria-selected')).toBe('true');

    await user.type(input, '{ArrowDown}');
    expect(within(palette).getAllByRole('option')[1]?.getAttribute('aria-selected')).toBe('true');

    await user.type(input, '{End}');
    const options = within(palette).getAllByRole('option');
    expect(options[options.length - 1]?.getAttribute('aria-selected')).toBe('true');

    await user.type(input, '{Home}');
    expect(within(palette).getAllByRole('option')[0]?.getAttribute('aria-selected')).toBe('true');
  });
});

describe('主题切换', () => {
  it('跟随系统 → 浅色 → 深色循环，并把选择写进 localStorage', async () => {
    const user = userEvent.setup();
    renderApp('/repos/acme__widgets/issues');
    await screen.findByTestId('issues-content');

    const toggle = screen.getByTestId('theme-toggle');
    expect(toggle.getAttribute('data-mode')).toBe('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    // 系统模式：不写 `data-theme`，但 `.dark` 必须按系统偏好翻好（官方组件的 `dark:` 变体只认它）。
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    await user.click(toggle);
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    await user.click(screen.getByTestId('theme-toggle'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    await user.click(screen.getByTestId('theme-toggle'));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
  });
});

describe('系统页（/system）与 ⌘.', () => {
  it('⌘. 导航到系统页（不是模态框）', async () => {
    const user = userEvent.setup();
    renderApp('/repos/acme__widgets/issues');
    await screen.findByTestId('issues-content');

    await user.keyboard('{Meta>}.{/Meta}');

    const page = await screen.findByTestId('system-page');
    // 第一屏回答「健康吗」：doctor 逐项 + 运行时开关
    expect(within(page).getByText('系统健康（doctor）')).toBeTruthy();
    expect(within(page).getByText('运行时开关')).toBeTruthy();
    expect(within(page).getByRole('heading', { level: 1, name: '系统' })).toBeTruthy();
    // 面包屑说明「这是全局页，不属于任何项目」
    expect(screen.getByTestId('shell-breadcrumb').textContent).toContain('系统');
    // 原模态框不再存在
    expect(screen.queryByTestId('system-modal-panel')).toBeNull();
  });

  it('侧栏「系统」链接也打开同一个页面（同一个入口两处可点）', async () => {
    const user = userEvent.setup();
    renderApp('/repos/acme__widgets/issues');
    await screen.findByTestId('issues-content');

    const nav = screen.getByRole('navigation', { name: '主导航' });
    await user.click(within(nav).getByRole('link', { name: '系统' }));
    expect(await screen.findByTestId('system-page')).toBeTruthy();
  });
});

describe('AC-32 全局设置：供应商与执行模型', () => {
  it('供应商行给出 baseURL / key 掩码 / 连通性 + 延迟 / 可用 model', async () => {
    renderApp('/system');

    const page = await screen.findByTestId('system-page');
    // 连通的一家：状态点 + 延迟 + 三个 model + 单价
    const anthropic = await within(page).findByTestId('system-provider-anthropic');
    expect(anthropic.textContent).toContain('https://api.anthropic.com/v1');
    expect(anthropic.textContent).toContain('连通');
    expect(anthropic.textContent).toContain('412ms');
    expect(within(anthropic).getByTestId('system-provider-models-anthropic').textContent).toContain('claude-opus-4');
    expect(anthropic.textContent).toContain('$15 / $75');

    // key：只显示掩码（**绝不**请求真值 —— 契约里根本没有 `key` 字段）
    expect(within(anthropic).getByTestId('system-provider-key-anthropic').textContent).toContain('sk-a…7f21');

    // 不通的一家：状态点说「不通」，延迟是 —（失败的时间不是延迟）
    const openai = within(page).getByTestId('system-provider-openai');
    expect(openai.textContent).toContain('不通');
    expect(within(openai).getByTestId('system-provider-status-openai').textContent).toContain('—');
    expect(openai.textContent).toContain('ECONNREFUSED');
    // `base_url: null` = 用 pi-host 默认端点，不是空白
    expect(openai.textContent).toContain('pi-host 默认端点');

    // 没配 key 的一家：如实说「未配置」
    const local = within(page).getByTestId('system-provider-local');
    expect(within(local).getByTestId('system-provider-key-local').textContent).toContain('key 未配置');
    expect(local.textContent).toContain('没有登记可用 model');
  });

  it('执行模型只有一档：显示供应商 + 模型 + 输入/输出单价；未配置时显示未配置 + —（不写 0）', async () => {
    renderApp('/system');

    const page = await screen.findByTestId('system-page');
    const block = await within(page).findByTestId('system-model-setting');

    expect(block.textContent).toContain('Anthropic');
    expect(block.textContent).toContain('claude-opus-4');
    expect(block.textContent).toContain('$15 / $75');
    // 没有「四档」：多一行就多一个「配了但不生效」的槽位
    expect(within(page).queryByTestId('system-model-roles')).toBeNull();
    expect(within(page).queryByTestId('system-role-format')).toBeNull();
  });

  it('未配置时如实说未配置，单价是 —（不是 $0）', async () => {
    server.use(
      http.get('/api/settings/model', () =>
        HttpResponse.json({
          configured: false,
          provider_id: null,
          provider_name: null,
          model: null,
          price: null,
          updated_at: null,
        }),
      ),
    );
    renderApp('/system');

    const page = await screen.findByTestId('system-page');
    const block = await within(page).findByTestId('system-model-setting');
    expect(block.textContent).toContain('未配置');
    expect(block.textContent).toContain('—');
    expect(block.textContent).not.toContain('$0');
  });

  it('两块都读不到时不假装有值（错误态如实说原因）', async () => {
    server.use(
      http.get('/api/settings/providers', () =>
        HttpResponse.json({ error: { code: 'internal', message: '读取数据库失败' } }, { status: 500 }),
      ),
      http.get('/api/settings/model', () =>
        HttpResponse.json({ error: { code: 'internal', message: '读取数据库失败' } }, { status: 500 }),
      ),
    );
    renderApp('/system');

    const page = await screen.findByTestId('system-page');
    expect((await within(page).findByTestId('system-providers-error')).textContent).toContain('读取数据库失败');
    expect(within(page).getByTestId('system-model-error-load').textContent).toContain('读取数据库失败');
  });
});

describe('降级横幅（一行 + 详情抽屉）', () => {
  it('常驻只占一行：摘要 + 详情；明细进 Sheet，Esc 关闭后焦点归还', async () => {
    const user = userEvent.setup();
    renderApp('/repos/acme__widgets/issues');
    await screen.findByTestId('issues-content');

    const banner = await screen.findByTestId('degraded-banner');
    // 36px 一行（`h-9`），不再是色块 + bullet 列表
    expect(banner.className).toContain('h-9');
    expect(banner.textContent).toContain('系统降级');
    expect(banner.textContent).toContain('429 熔断');
    expect(banner.textContent).toContain('项');
    // 只用状态词：不出现"刷新中"这类瞬时口径
    expect(banner.textContent).not.toContain('刷新中');

    const opener = within(banner).getByRole('button', { name: '详情' });
    await user.click(opener);

    const sheet = await screen.findByTestId('degraded-detail-panel');
    expect(sheet.getAttribute('role')).toBe('dialog');
    expect(within(sheet).getByTestId('degraded-detail-list').textContent).toContain('429 熔断');
    expect(sheet.contains(document.activeElement)).toBe(true);

    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('degraded-detail-panel')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe('AsyncSection 的五态', () => {
  it('错误态：原因 + 重试 + 折叠的技术细节', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    render(
      <AsyncSection isLoading={false} error={new Error('数据库连接被拒绝')} onRetry={retry} testId="demo">
        <p>内容</p>
      </AsyncSection>,
    );

    const error = screen.getByTestId('demo-error');
    expect(error.textContent).toContain('读取失败');
    expect(error.textContent).toContain('数据库连接被拒绝');
    expect(error.textContent).toContain('技术细节');

    await user.click(within(error).getByRole('button', { name: '重试' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('空态：一句事实 + 一个可行动作', () => {
    render(
      <AsyncSection
        isLoading={false}
        error={null}
        isEmpty
        emptyText="还没有任何运行"
        emptyHint="触发一次命令就会出现在这里"
        emptyAction={<button type="button">去 Issue 中心</button>}
        testId="demo"
      >
        <p>内容</p>
      </AsyncSection>,
    );

    const empty = screen.getByTestId('demo-empty');
    expect(empty.textContent).toContain('还没有任何运行');
    expect(empty.textContent).toContain('触发一次命令就会出现在这里');
    expect(within(empty).getByRole('button', { name: '去 Issue 中心' })).toBeTruthy();
  });

  it('加载态：骨架行数与列表同形（不跳高）', () => {
    render(
      <AsyncSection isLoading error={null} skeletonRows={4} testId="demo">
        <p>内容</p>
      </AsyncSection>,
    );
    const loading = screen.getByTestId('demo-loading');
    // 官方 `Skeleton` 的锚点是 `data-slot="skeleton"`（项目层不再自己加 testid）
    expect(loading.querySelectorAll('[data-slot="skeleton"]').length).toBe(4);
  });

  it('离线：顶部出现「离线 · 数据可能过期」pill', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(
      <AsyncSection isLoading={false} error={null} testId="demo">
        <p>内容</p>
      </AsyncSection>,
    );
    expect(screen.getByTestId('demo-offline').textContent).toContain('离线');
  });
});
