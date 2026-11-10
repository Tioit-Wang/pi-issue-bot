/**
 * S-B（Issue 会话视图）的页面测试：列表渲染与预览/计数、点进详情看多轮问答、
 * 工具调用默认折叠、只读红线、四态锚点（`issues-*` / `issue-detail-*`）。
 *
 * 断言方式沿用 `tasks.test.tsx` / `task-detail.test.tsx`：
 *  - **请求侧**：MSW 的 `request:start` 记录真实发出的 URL，「换筛选 = 换一次请求」是观测到的事实；
 *  - **状态侧**：`AsyncSection` 的四态 `testid` 约定 `{testId}-{loading,error,empty,content}`；
 *  - **导航**：`MemoryRouter` 不写 `window.location`，所以用一个 `LocationProbe` 把
 *    `useLocation().search` 渲染出来，断言「筛选进了 URL（刷新不丢）」。
 */
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { Route, Routes, useLocation } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHandlers } from '../../mocks/handlers/index.ts';
import { renderWithProviders } from '../../../test/render.tsx';
import { IssueDetailPage } from '../issue-detail.tsx';
import { IssuesPage } from '../issues.tsx';

const server = setupServer(...createHandlers());

/** 每一次页面发出的请求（含 `/api/issues?...`）。 */
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

function renderList(route = '/issues') {
  return renderWithProviders(<IssuesPage />, { route });
}

/** 详情页要真实的 `useParams`，所以按生产同一份路由形态（列表 + 详情）挂载。 */
function renderSession(route: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/issues" element={<IssuesPage />} />
      <Route path="/issues/:owner/:name/:kind/:number" element={<IssueDetailPage />} />
    </Routes>,
    { route },
  );
}

describe('/issues 列表', () => {
  it('一行一个 issue：repo#number、标题、状态、人机轮数、单行预览', async () => {
    renderList();

    const content = await screen.findByTestId('issues-content');
    const row = within(content).getByTestId('issue-row-acme/widgets#issue17');

    expect(row.textContent).toContain('acme/widgets');
    expect(row.textContent).toContain('#17');
    expect(row.textContent).toContain('EACCES');
    expect(row.textContent).toContain('open');
    // 预览来自最后一条机器人正文（契约 §3.1 的 lastPreview）
    expect(within(row).getByTestId('issue-row-preview').textContent).toContain('不会。A 轮结论');
    // 单行省略：靠 `truncate` 裁切，全文放 `title`
    const preview = within(row).getByTestId('issue-row-preview');
    expect(preview.className).toContain('truncate');
    expect(preview.getAttribute('title') ?? '').toContain('不会。A 轮结论');
    // 计数：3 轮人类 + 3 轮机器人
    const turns = within(row).getByTestId('issue-row-turns');
    expect(turns.textContent).toContain('人 3');
    expect(turns.textContent).toContain('机 3');

    // 首屏是一页：页码由页面显式传（limit=10），且第一页不带 cursor
    expect(within(content).getAllByTestId('issue-row-link')).toHaveLength(10);
    const listUrl = requests.find((url) => url.includes('/api/issues?'));
    expect(listUrl).toContain('limit=10');
    expect(listUrl).not.toContain('cursor=');
  });

  it('游标分页「加载更多」，仓库筛选与 URL 双向同步', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <IssuesPage />
        <LocationProbe />
      </>,
      { route: '/issues' },
    );

    await screen.findByTestId('issues-content');
    expect(screen.getAllByTestId('issue-row-link')).toHaveLength(10);

    await user.click(screen.getByTestId('issues-load-more'));
    await waitFor(() => {
      expect(screen.getAllByTestId('issue-row-link')).toHaveLength(12);
    });
    expect(requests.some((url) => url.includes('cursor='))).toBe(true);

    // 切仓库：URL 与请求同时变（筛选由服务端做）
    requests.length = 0;
    await user.selectOptions(screen.getByLabelText('仓库筛选'), 'other/lib');
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toContain('repo=other%2Flib');
    });
    await waitFor(() => {
      expect(requests.some((url) => url.includes('repo=other%2Flib'))).toBe(true);
    });
  });

  it('从 URL 恢复筛选（刷新不丢）', async () => {
    renderList('/issues?repo=other%2Flib');

    await screen.findByTestId('issues-content');
    expect((screen.getByLabelText('仓库筛选') as HTMLSelectElement).value).toBe('other/lib');
    expect(requests.some((url) => url.includes('repo=other%2Flib'))).toBe(true);
  });
});

describe('/issues/:owner/:name/:kind/:number 会话', () => {
  it('点进详情：一个 issue = 一个会话，至少 2 轮问答，时间升序', async () => {
    const user = userEvent.setup();
    renderSession('/issues');

    const content = await screen.findByTestId('issues-content');
    const row = within(content).getByTestId('issue-row-acme/widgets#issue17');
    await user.click(within(row).getByTestId('issue-row-link'));

    await screen.findByTestId('issue-detail-content');
    expect(screen.getAllByTestId('issue-detail-turn-human').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByTestId('issue-detail-turn-bot').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/这个 EACCES 报错一般是什么原因/)).toBeTruthy();
    expect(screen.getByText(/EACCES 是「有权限做这个操作/)).toBeTruthy();

    // 气泡按 at 升序：第一轮是人类提问
    const turns = within(screen.getByTestId('issue-detail-turns')).getAllByRole('listitem');
    expect(turns[0]?.getAttribute('data-testid')).toBe('issue-detail-turn-human');
    // 头部计数与请求路径（四段 `:owner/:name/:kind/:number`）
    expect(screen.getByTestId('issue-detail-counts').textContent).toContain('人类 3 轮');
    expect(requests.some((url) => url.includes('/api/issues/acme/widgets/issue/17'))).toBe(true);
  });

  it('工具调用默认折叠，点击后展开成表格（不含原始流）', async () => {
    const user = userEvent.setup();
    renderSession('/issues/acme/widgets/issue/17');

    await screen.findByTestId('issue-detail-content');
    // 默认收起：工具名字与表格都不在 DOM 里
    expect(screen.queryByText('read/fetch-spans')).toBeNull();
    expect(screen.queryByTestId('issue-detail-tool-calls')).toBeNull();

    // 第一轮机器人有 2 次工具调用（另外两轮各 1 次，所以按下标找唯一的「2」）
    await user.click(screen.getByRole('button', { name: /工具调用（2）/ }));

    const table = await screen.findByTestId('issue-detail-tool-calls');
    expect(table.textContent).toContain('read/fetch-spans');
    expect(table.textContent).toContain('grep/search');
    for (const header of ['名字', '摘要', '时间', 'ok']) {
      expect(within(table).getByRole('columnheader', { name: header })).toBeTruthy();
    }
    // 折叠区只有工具调用摘要：原始流事件（item.delta 等）不得出现在页面上
    expect(document.body.textContent).not.toContain('item.delta');
    expect(table.textContent).not.toContain('item.delta');

    // 再点一次收起
    await user.click(screen.getByRole('button', { name: /工具调用（2）/ }));
    expect(screen.queryByTestId('issue-detail-tool-calls')).toBeNull();
  });

  it('右侧栏：「做了什么」/「结果」（status、failureClass、任务链接）/「标签」', async () => {
    renderSession('/issues/acme/widgets/issue/17');

    await screen.findByTestId('issue-detail-content');
    const rails = screen.getAllByTestId('issue-detail-rail-actions');
    expect(rails.length).toBeGreaterThan(0);
    expect(rails[0]?.textContent).toContain('ask');

    // 失败轮：status=failed + failureClass=timeout，并把 taskId 链到 /tasks/:id
    const results = screen.getAllByTestId('issue-detail-rail-result');
    const failed = results.find((element) => element.textContent?.includes('failed'));
    expect(failed).toBeDefined();
    expect(failed?.textContent ?? '').toContain('timeout');
    const taskLink = failed?.querySelector('a');
    expect(taskLink?.getAttribute('href')).toBe('/tasks/t-17-3');

    const labels = screen.getAllByTestId('issue-detail-rail-labels');
    expect(labels.some((element) => element.textContent?.includes('bug'))).toBe(true);
  });

  it('只读红线：没有输入框、没有发送按钮（列表页与详情页都成立）', async () => {
    const list = renderList();
    await screen.findByTestId('issues-content');
    expect(list.container.querySelectorAll('textarea, input')).toHaveLength(0);
    for (const button of screen.getAllByRole('button')) {
      expect(button.textContent ?? '').not.toContain('发送');
    }
    list.unmount();

    const detail = renderSession('/issues/acme/widgets/issue/17');
    await screen.findByTestId('issue-detail-content');
    expect(detail.container.querySelector('textarea,input[type=text]')).toBeNull();
    expect(detail.container.querySelectorAll('input, textarea')).toHaveLength(0);
    expect(detail.container.querySelectorAll('form')).toHaveLength(0);
    for (const button of screen.getAllByRole('button')) {
      expect(button.textContent ?? '').not.toContain('发送');
    }
  });
});

describe('四态锚点', () => {
  it('列表：issues-loading / issues-error / issues-empty / issues-content', async () => {
    const slow = renderList('/issues?mock=slow');
    expect(await screen.findByTestId('issues-loading')).toBeTruthy();
    expect(await screen.findByTestId('issues-content', undefined, { timeout: 5000 })).toBeTruthy();
    slow.unmount();

    const error = renderList('/issues?mock=error');
    expect((await screen.findByTestId('issues-error')).textContent).toContain('读取失败');
    error.unmount();

    renderList('/issues?mock=empty');
    expect((await screen.findByTestId('issues-empty')).textContent).toContain(
      '还没有处理过的 Issue 会话',
    );
  });

  it('详情：issue-detail-{loading,error,empty,content}，404 落空态而不是错误态', async () => {
    const slow = renderSession('/issues/acme/widgets/issue/17?mock=slow');
    expect(await screen.findByTestId('issue-detail-loading')).toBeTruthy();
    expect(
      await screen.findByTestId('issue-detail-content', undefined, { timeout: 5000 }),
    ).toBeTruthy();
    slow.unmount();

    const error = renderSession('/issues/acme/widgets/issue/17?mock=error');
    expect((await screen.findByTestId('issue-detail-error')).textContent).toContain('读取失败');
    error.unmount();

    // 404：这个 (repo, kind, number) 没有任何 tasks 行
    const missing = renderSession('/issues/acme/widgets/issue/999');
    expect((await screen.findByTestId('issue-detail-empty')).textContent).toContain('找不到这个会话');
    expect(screen.queryByTestId('issue-detail-error')).toBeNull();
    missing.unmount();

    // 200 但 0 轮（`?mock=empty`）：空态文案与 404 不同
    renderSession('/issues/acme/widgets/issue/17?mock=empty');
    expect((await screen.findByTestId('issue-detail-empty')).textContent).toContain('还没有任何轮次');
  });
});
