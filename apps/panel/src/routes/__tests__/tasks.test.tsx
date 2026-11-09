/**
 * S2 任务列表：渲染 / 筛选（URL 双向同步 + 新请求）/ 游标分页 / 空态 / 错误态。
 *
 * 断言方式的两条原则：
 *  1. **请求侧**：MSW 的 `request:start` 事件记录真实发出的 URL，
 *     这样「切筛选真的换了请求」是被观测到的事实，而不是靠推断；
 *  2. **URL 侧**：`MemoryRouter` 不写 `window.location`，所以挂一个 `LocationProbe`
 *     把 `useLocation().search` 渲染出来——刷新后筛选是否还在，就看它。
 */
import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { useLocation } from 'react-router';
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
  it('渲染 7 列，并按契约默认每页 50 条', async () => {
    renderWithProviders(<TasksPage />, { route: '/tasks' });

    expect(await screen.findByTestId('tasks-content')).toBeTruthy();
    for (const header of ['时间', '仓库', '类型 / 命令', '状态', '耗时', '成本', '失败分类']) {
      expect(screen.getByRole('columnheader', { name: header })).toBeTruthy();
    }
    expect(screen.getAllByText('acme/widgets').length).toBeGreaterThan(0);
    // 表头 1 行 + 数据 50 行
    expect(screen.getAllByRole('row')).toHaveLength(51);
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
    expect(screen.getAllByRole('row')).toHaveLength(51);

    await user.click(screen.getByTestId('tasks-load-more'));

    await waitFor(() => {
      expect(screen.getAllByRole('row')).toHaveLength(101);
    });
    expect(requests.some((url) => url.includes('cursor='))).toBe(true);
    expect(screen.getByTestId('tasks-load-more').textContent).toContain('已显示 100 条');
  });

  it('空态：给出「没有匹配的任务」与清除筛选动作', async () => {
    renderWithProviders(<TasksPage />, { route: '/tasks?mock=empty&status=cancelled' });

    const empty = await screen.findByTestId('tasks-empty');
    expect(empty.textContent).toContain('没有匹配的任务');
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
