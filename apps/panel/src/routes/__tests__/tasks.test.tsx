/**
 * S2 任务列表：渲染 / 筛选（URL 双向同步 + 新请求）/ 游标分页 / 空态 / 错误态。
 *
 * 断言方式的两条原则：
 *  1. **请求侧**：MSW 的 `request:start` 事件记录真实发出的 URL，
 *     这样「切筛选真的换了请求」是被观测到的事实，而不是靠推断；
 *  2. **URL 侧**：`MemoryRouter` 不写 `window.location`，所以挂一个 `LocationProbe`
 *     把 `useLocation().search` 渲染出来——刷新后筛选是否还在，就看它。
 */
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { Route, Routes, useLocation } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHandlers } from '../../mocks/handlers/index.ts';
import { renderWithProviders } from '../../../test/render.tsx';
import { TasksPage } from '../tasks.tsx';

const server = setupServer(...createHandlers());

/** 每一次页面发出的请求（含 `/api/tasks?...`）。 */
const requests: string[] = [];

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
  server.events.on('request:start', (event) => {
    requests.push(event.request.url);
  });
});

afterAll(() => {
  server.close();
});

afterEach(() => {
  server.resetHandlers();
});

beforeEach(() => {
  requests.length = 0;
});

/** 把当前路由的查询串渲染出来（`MemoryRouter` 下断言 URL 同步的唯一办法）。 */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.search}</div>;
}

describe('/tasks 列表', () => {
  it('渲染对象行，并按契约默认每页 50 条', async () => {
    renderWithProviders(<TasksPage />, { route: '/tasks' });

    expect(await screen.findByTestId('tasks-content')).toBeTruthy();
    // 对象行：状态点 / 命令 / 目标 / 耗时 / 成本 / 时间 —— 一行一次运行
    expect(screen.getAllByTestId(/^tasks-row-/)).toHaveLength(50);
    expect(screen.getAllByText('acme/widgets').length).toBeGreaterThan(0);
    // 第一页请求带 limit=50、不带 cursor
    const listUrl = requests.find((url) => url.includes('/api/tasks?'));
    expect(listUrl).toContain('limit=50');
    expect(listUrl).not.toContain('cursor=');
  });

  it('切状态筛选：URL 同步 + 发出带 status 的新请求', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <TasksPage />
        <LocationProbe />
      </>,
      { route: '/tasks' },
    );
    await screen.findByTestId('tasks-content');

    await user.selectOptions(screen.getByLabelText('状态筛选'), 'failed');

    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toContain('status=failed');
    });
    await waitFor(() => {
      expect(requests.some((url) => url.includes('status=failed'))).toBe(true);
    });
    // 筛选由服务端做：剩下的行都是 failed
    expect(screen.getAllByText('failed').length).toBeGreaterThan(0);
    expect(screen.queryByText('succeeded')).toBeNull();
  });

  it('时间范围筛选落成契约的 from/to', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TasksPage />, { route: '/tasks' });

    await screen.findByTestId('tasks-content');
    requests.length = 0;
    await user.selectOptions(screen.getByLabelText('时间范围筛选'), '24h');

    await waitFor(() => {
      const ranged = requests.find((url) => url.includes('from='));
      expect(ranged).toBeDefined();
      expect(ranged).toContain('to=');
    });
  });

  it('从 URL 恢复筛选（刷新不丢）', async () => {
    renderWithProviders(<TasksPage />, { route: '/tasks?status=failed&repo=other%2Flib&range=24h' });

    await screen.findByTestId('tasks-content');
    expect((screen.getByLabelText('状态筛选') as HTMLSelectElement).value).toBe('failed');
    expect((screen.getByLabelText('仓库筛选') as HTMLSelectElement).value).toBe('other/lib');
    expect((screen.getByLabelText('时间范围筛选') as HTMLSelectElement).value).toBe('24h');
    expect(
      requests.some((url) => url.includes('status=failed') && url.includes('repo=other%2Flib')),
    ).toBe(true);
  });

  it('游标分页：「加载更多」拿 nextCursor 追加第二页', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TasksPage />, { route: '/tasks' });

    await screen.findByTestId('tasks-content');
    expect(screen.getAllByTestId(/^tasks-row-/)).toHaveLength(50);

    await user.click(screen.getByTestId('tasks-load-more'));

    await waitFor(() => {
      expect(screen.getAllByTestId(/^tasks-row-/)).toHaveLength(100);
    });
    expect(requests.some((url) => url.includes('cursor='))).toBe(true);
    expect(screen.getByTestId('tasks-load-more').textContent).toContain('已显示 100 条');
  });

  it('空态：给出「没有匹配的运行」与清除筛选动作', async () => {
    renderWithProviders(<TasksPage />, { route: '/tasks?mock=empty&status=cancelled' });

    const empty = await screen.findByTestId('tasks-empty');
    expect(empty.textContent).toContain('没有匹配的运行');
    expect(screen.getByTestId('tasks-empty-clear')).toBeTruthy();
  });

  it('错误态：500 走 Alert（不白屏）', async () => {
    renderWithProviders(<TasksPage />, { route: '/tasks?mock=error' });

    const error = await screen.findByTestId('tasks-error');
    expect(error.textContent).toContain('读取失败');
  });

  it('未登录：401 的文案与 500 不同（提示重新登录）', async () => {
    renderWithProviders(<TasksPage />, { route: '/tasks?mock=unauthorized' });

    const error = await screen.findByTestId('tasks-error');
    expect(error.textContent).toContain('会话已过期或未登录');
  });

  it('慢态：先给骨架，再给内容', async () => {
    renderWithProviders(<TasksPage />, { route: '/tasks?mock=slow' });

    expect(await screen.findByTestId('tasks-loading')).toBeTruthy();
    expect(await screen.findByTestId('tasks-content', undefined, { timeout: 5000 })).toBeTruthy();
  });
});

/**
 * 仓库锁定模式（`/repos/:repo/runs` 用 `repoLock` 复用这一页）。
 *
 * 与上面「全局任务列表」的区别只有三点，也正是要钉住的契约：
 * 标题变「运行」、仓库下拉消失（切仓库走左栏切换器）、请求固定带 `repo`、
 * 点行进的是**该仓库**的运行详情而不是旧的 `/tasks/:id`。
 */
describe('/repos/:repo/runs（仓库锁定）', () => {
  function renderRuns() {
    return renderWithProviders(
      <Routes>
        <Route path="/repos/:repo/runs" element={<TasksPage repoLock="acme/widgets" />} />
        <Route path="/repos/:repo/runs/:id" element={<p>运行详情桩</p>} />
      </Routes>,
      { route: '/repos/acme__widgets/runs' },
    );
  }

  it('标题是「运行」、没有仓库下拉、请求固定带 repo', async () => {
    renderRuns();

    expect(await screen.findByTestId('tasks-content')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: '运行' })).toBeTruthy();
    expect(screen.queryByLabelText('仓库筛选')).toBeNull();
    expect(requests.find((url) => url.includes('/api/tasks?'))).toContain('repo=acme%2Fwidgets');
  });

  it('点一行进该仓库的运行详情', async () => {
    const user = userEvent.setup();
    renderRuns();

    await screen.findByTestId('tasks-content');
    const firstRow = screen.getAllByTestId(/^tasks-row-/)[0];
    if (firstRow === undefined) throw new Error('没有数据行');
    // 整行是链接：点行即进详情（真实 URL，刷新/分享可用）
    const rowLink = within(firstRow).getByRole('link');
    await user.click(rowLink);

    expect(await screen.findByText('运行详情桩')).toBeTruthy();
  });
});
