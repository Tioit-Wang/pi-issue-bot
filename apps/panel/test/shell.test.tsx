/**
 * 外壳与设计系统原语的行为测试（D1 交付）。
 *
 * 覆盖范围刻意选「会让用户卡住」的地方，而不是像素：
 * - ⌘K 命令面板：快捷键打开 / 搜索 / ↑↓ / ↵ 跳转 / Esc 关闭并把焦点还回去；
 * - 主题切换：三态循环写进 `<html data-theme>` 与 localStorage；
 * - 侧栏开合：窄屏（抽屉）下按钮带 `aria-expanded`，收起后侧栏 `inert`；
 * - `AsyncSection`：错误态的重试 + 折叠技术细节、空态的可行动作、离线 pill；
 * - `Toast`：最多 3 条、可关闭；
 * - `Segmented` / `Field`：`radiogroup` 方向键、`aria-describedby` 绑定。
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { HttpResponse, http } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { useState } from 'react';
import { createHandlers } from '../src/mocks/handlers/index.ts';
import { AppRoutes } from '../src/routes.tsx';
import { AsyncSection } from '../src/components/AsyncSection.tsx';
import { Dialog } from '../src/components/ui/dialog.tsx';
import { Table, TableBody, TableCell, TableRow } from '../src/components/ui/table.tsx';
import { Field } from '../src/components/ui/field.tsx';
import { Segmented } from '../src/components/ui/segmented.tsx';
import { Toaster, clearToasts, pushToast } from '../src/components/ui/toast.tsx';
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
  clearToasts();
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

describe('命令面板（⌘K）', () => {
  it('⌘K 打开、搜索「成本」后 ↵ 跳到成本页，Esc 关闭', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('heading', { level: 1, name: '工作台' });

    await user.keyboard('{Meta>}k{/Meta}');
    const palette = await screen.findByTestId('command-palette');
    const input = within(palette).getByLabelText('搜索页面、仓库与最近 issue');
    expect(document.activeElement).toBe(input);

    await user.type(input, '成本');
    const options = within(palette).getAllByRole('option');
    expect(options[0]?.textContent).toContain('成本');

    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { level: 1, name: '成本' })).toBeTruthy();
    expect(screen.queryByTestId('command-palette')).toBeNull();

    // 从顶栏按钮打开 → Esc 关闭，焦点必须回到打开它的按钮
    const trigger = screen.getByTestId('command-trigger');
    await user.click(trigger);
    await screen.findByTestId('command-palette');
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('command-palette')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('顶栏按钮也能打开；无结果时给「换个词试试」+ 直达链接', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('heading', { level: 1, name: '工作台' });

    await user.click(screen.getByTestId('command-trigger'));
    const palette = await screen.findByTestId('command-palette');
    await user.type(within(palette).getByLabelText('搜索页面、仓库与最近 issue'), 'zzzz');

    const empty = await screen.findByTestId('palette-empty');
    expect(empty.textContent).toContain('换个词试试');
    expect(within(empty).getByRole('button', { name: '打开「系统」' })).toBeTruthy();
  });

  it('↑↓ 在结果之间移动（Home/End 到首尾）', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('heading', { level: 1, name: '工作台' });

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
    renderApp('/');
    await screen.findByRole('heading', { level: 1, name: '工作台' });

    const toggle = screen.getByTestId('theme-toggle');
    expect(toggle.getAttribute('data-mode')).toBe('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);

    await user.click(toggle);
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    await user.click(screen.getByTestId('theme-toggle'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    await user.click(screen.getByTestId('theme-toggle'));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
  });
});

describe('侧栏（窄屏抽屉）', () => {
  it('窄屏：开合按钮带 aria-expanded，收起后侧栏 inert 且 aria 控件仍在', async () => {
    // 模拟 <1024px：只让 max-width:1023.98px 命中
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => {
      const matches = query.includes('1023.98px');
      return {
        matches,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      } as unknown as MediaQueryList;
    });

    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('heading', { level: 1, name: '工作台' });

    const toggle = screen.getByTestId('sidebar-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('app-sidebar');

    const sidebar = screen.getByTestId('app-sidebar');
    expect(sidebar.hasAttribute('inert')).toBe(true);

    await user.click(toggle);
    expect(screen.getByTestId('sidebar-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('app-sidebar').hasAttribute('inert')).toBe(false);
  });
});

describe('降级横幅（一行 + 详情抽屉）', () => {
  it('常驻只占一行：摘要 + 详情；明细进 Sheet，Esc 关闭后焦点归还', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('heading', { level: 1, name: '工作台' });

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
    expect(loading.querySelectorAll('[data-testid="skeleton"]').length).toBe(4);
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

describe('Toast', () => {
  it('最多 3 条、可逐条关闭', async () => {
    const user = userEvent.setup();
    render(<Toaster />);

    pushToast({ tone: 'success', title: '已保存' });
    pushToast({ tone: 'warn', title: '干跑中' });
    pushToast({ tone: 'danger', title: '读取失败' });
    pushToast({ tone: 'info', title: '第 4 条应挤掉最旧的' });

    const toaster = await screen.findByTestId('toaster');
    expect(toaster.getAttribute('role')).toBe('status');

    const items = within(toaster).getAllByLabelText('关闭提示');
    expect(items.length).toBe(3);
    expect(toaster.textContent).not.toContain('已保存');

    await user.click(items[0] as HTMLElement);
    await waitFor(() => {
      expect(within(toaster).getAllByLabelText('关闭提示').length).toBe(2);
    });
  });
});

describe('Segmented / Field', () => {
  function Harness() {
    const [face, setFace] = useState<'off' | 'mention' | 'auto'>('mention');
    return (
      <div>
        <Segmented
          label="触发方式"
          value={face}
          onChange={setFace}
          options={[
            { value: 'off', label: '关闭' },
            { value: 'mention', label: '仅 @' },
            { value: 'auto', label: '自动' },
          ]}
        />
        <Field label="别名" hint="逗号分隔" error={face === 'off' ? '关闭时不需要别名' : null}>
          <input type="text" />
        </Field>
      </div>
    );
  }

  it('方向键切换单选项，Field 把说明与错误绑到控件上', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const group = screen.getByRole('radiogroup', { name: '触发方式' });
    const current = within(group).getByRole('radio', { name: '仅 @' });
    expect(current.getAttribute('aria-checked')).toBe('true');

    current.focus();
    await user.keyboard('{ArrowRight}');
    expect(within(group).getByRole('radio', { name: '自动' }).getAttribute('aria-checked')).toBe('true');

    await user.keyboard('{ArrowRight}');
    expect(within(group).getByRole('radio', { name: '关闭' }).getAttribute('aria-checked')).toBe('true');

    // 错误态：控件 aria-invalid + aria-describedby 同时指向说明与错误
    const input = screen.getByLabelText('别名');
    await waitFor(() => {
      expect(input.getAttribute('aria-invalid')).toBe('true');
    });
    const describedBy = input.getAttribute('aria-describedby') ?? '';
    expect(describedBy.split(' ').length).toBe(2);
  });
});

describe('Dialog / Table', () => {
  it('对话框：打开后焦点进面板、Esc 关闭并把焦点还给来路', async () => {
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
            }}
          >
            删除技能
          </button>
          <Dialog
            open={open}
            onClose={() => {
              setOpen(false);
            }}
            title="确认删除？"
            description="删除后列表里立刻消失"
            footer={<button type="button">确认</button>}
          >
            <p>这是不可撤销的动作。</p>
          </Dialog>
        </div>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole('button', { name: '删除技能' });
    await user.click(opener);

    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(within(dialog).getByRole('heading', { name: '确认删除？' })).toBeTruthy();
    // 首焦点在面板内（没有 data-autofocus 时取第一个可聚焦元素）
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('表格：stickyFirst 打开时首列带 sticky 类（横向滚动不丢行标识）', () => {
    const { container } = render(
      <Table stickyFirst>
        <TableBody>
          <TableRow>
            <TableCell>#17</TableCell>
            <TableCell>很长的标题</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const table = container.querySelector('table');
    expect(table?.className).toContain('[&_td:first-child]:sticky');
    expect(container.querySelector('[data-sticky-first]')).toBeTruthy();
  });
});