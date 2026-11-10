/**
 * S6 审计：渲染 / 筛选 / CSV 导出（blob + 服务端文件名）/ 截断提示 / 空态与错误态。
 *
 * 导出这条链路有三个可断言的点，缺一不可：
 *  1. 打到了 `/api/audit/export.csv`（MSW 的 `request:start` 记录 URL）；
 *  2. 真的把 blob 交给了下载（jsdom 没有 `URL.createObjectURL`，这里打桩并记录调用）；
 *  3. 文件名与行数来自**服务端响应**（`Content-Disposition`），不是前端猜的。
 */
import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHandlers } from '../../mocks/handlers/index.ts';
import { renderWithProviders } from '../../../test/render.tsx';
import { AuditPage } from '../audit.tsx';

const server = setupServer(...createHandlers());

/** 每一次页面发出的请求。 */
const requests: string[] = [];
/** `URL.createObjectURL` 收到的 blob（= 准备下载的内容）。 */
const downloaded: Blob[] = [];
/** 被点击的 `<a download>`（jsdom 不支持 download，直接拦掉导航并记下文件名）。 */
const downloads: Array<{ filename: string }> = [];
const originalAnchorClick = HTMLAnchorElement.prototype.click;

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
  server.events.on('request:start', (event) => {
    requests.push(event.request.url);
  });
  // jsdom 不实现 object URL：打桩，让「下载」这一步可观测
  Object.defineProperty(URL, 'createObjectURL', {
    writable: true,
    value: (blob: Blob) => {
      downloaded.push(blob);
      return 'blob:mock';
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', { writable: true, value: () => {} });
  HTMLAnchorElement.prototype.click = function stubClick(this: HTMLAnchorElement) {
    downloads.push({ filename: this.download });
  };
});

afterAll(() => {
  server.close();
  HTMLAnchorElement.prototype.click = originalAnchorClick;
});

afterEach(() => {
  server.resetHandlers();
});

beforeEach(() => {
  requests.length = 0;
  downloaded.length = 0;
  downloads.length = 0;
  // 仓库清单（`lib/repos.ts` 认 `{ repos: [...] }`；W3-H 的 `/api/repos` mock 落地后可删）
  server.use(
    http.get('/api/repos', () =>
      HttpResponse.json({
        repos: [
          { repo: 'acme/widgets', enabled: true, dryRun: false, settingsValid: true },
          { repo: 'other/lib', enabled: false, dryRun: false, settingsValid: true },
        ],
      }),
    ),
  );
});

describe('/audit 审计', () => {
  it('默认时间轴：按分钟聚簇，展开看行（intent / status 的 tone、目标链接、cron 行）', async () => {
    renderWithProviders(<AuditPage />, { route: '/audit' });

    expect(await screen.findByTestId('audit-content')).toBeTruthy();
    const timeline = screen.getByTestId('audit-timeline');
    expect(timeline).toBeTruthy();

    // 聚簇：同一分钟的 3 小时步长数据会落进不同桶，至少有一个桶展开着行（默认展开第一个）
    expect(screen.getAllByTestId(/^audit-cluster-/).length).toBeGreaterThan(0);
    expect(screen.getAllByTestId(/^audit-row-/).length).toBeGreaterThan(0);

    // 触发人 + association 徽章
    expect(screen.getAllByText('alice').length).toBeGreaterThan(0);
    expect(screen.getAllByText('MEMBER').length).toBeGreaterThan(0);
    // cron 触发的行：触发人是 null，显示成「—（cron）」而不是空白
    expect(screen.getAllByText('—（cron）').length).toBeGreaterThan(0);
  });

  it('切到表格：八列表头齐全（谁触发 / 仓库 / 命令 / sha / 写了什么 / 结果 / 审批）', async () => {
    renderWithProviders(<AuditPage />, { route: '/audit?view=table' });

    expect(await screen.findByTestId('audit-content')).toBeTruthy();
    for (const header of ['时间', '触发人', '仓库', '命令', '提交 sha', '写了什么', '结果', '审批判定']) {
      expect(screen.getByRole('columnheader', { name: header })).toBeTruthy();
    }
    // 表格视图里同样能看到 status 与审批判定
    expect(screen.getAllByText('applied').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/allow-tests/).length).toBeGreaterThan(0);
  });
  it('筛选改变会重新请求（repo / intent 落到契约参数上）', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AuditPage />, { route: '/audit' });

    await screen.findByTestId('audit-content');
    requests.length = 0;
    await user.selectOptions(screen.getByLabelText('意图筛选'), 'push_branch');

    await waitFor(() => {
      expect(requests.some((url) => url.includes('intent=push_branch'))).toBe(true);
    });
  });

  it('导出 CSV：调导出接口、用服务端文件名、提示行数', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AuditPage />, { route: '/audit' });

    await screen.findByTestId('audit-content');
    await user.click(screen.getByTestId('audit-export'));

    const status = await screen.findByTestId('audit-export-status');
    expect(requests.some((url) => url.includes('/api/audit/export.csv'))).toBe(true);
    // 真的触发了下载：blob 交给了 object URL，`<a download>` 的文件名来自服务端
    expect(downloaded).toHaveLength(1);
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.filename).toMatch(/^audit-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/);
    // 文件名与行数都来自服务端响应（前端不猜）
    expect(status.textContent).toMatch(/audit-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv/);
    expect(status.textContent).toContain('已导出');
    expect(status.textContent).toContain('120');
  });

  it('导出被截断：明确告知只导出了前 50,000 行', async () => {
    server.use(
      http.get('/api/audit/export.csv', () =>
        new HttpResponse('\uFEFFid,at\r\n1,2026-06-01T00:00:00Z\r\n', {
          status: 200,
          headers: {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': 'attachment; filename="audit-full.csv"',
            'x-pi-bot-truncated': 'true',
          },
        }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<AuditPage />, { route: '/audit' });

    await screen.findByTestId('audit-content');
    await user.click(screen.getByTestId('audit-export'));

    const status = await screen.findByTestId('audit-export-status');
    expect(status.textContent).toContain('只导出了前');
    expect(status.textContent).toContain('50,000');
    expect(status.textContent).toContain('audit-full.csv');
  });

  it('列表截断提示：`truncated` 为真时明说命中超过导出口径', async () => {
    renderWithProviders(<AuditPage />, { route: '/audit?mockTruncated=1' });

    const banner = await screen.findByTestId('audit-truncated');
    expect(banner.textContent).toContain('50,000');
    expect(banner.textContent).toContain('缩小时间范围');
  });

  it('空态：窗口内没有审计记录', async () => {
    renderWithProviders(<AuditPage />, { route: '/audit?mock=empty' });

    const empty = await screen.findByTestId('audit-empty');
    expect(empty.textContent).toContain('窗口内没有审计记录');
  });

  it('错误态：500 走 Alert', async () => {
    renderWithProviders(<AuditPage />, { route: '/audit?mock=error' });

    const error = await screen.findByTestId('audit-error');
    expect(error.textContent).toContain('读取失败');
  });

  it('未登录：401 文案提示重新登录', async () => {
    renderWithProviders(<AuditPage />, { route: '/audit?mock=unauthorized' });

    const error = await screen.findByTestId('audit-error');
    expect(error.textContent).toContain('会话已过期或未登录');
  });
});

describe('/audit 仓库筛选（进 URL）', () => {
  it('选仓库后 `?repo=` 落到 /api/audit，并进 URL（刷新不丢）', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AuditPage />, { route: '/audit' });

    await screen.findByTestId('audit-content');
    requests.length = 0;

    await user.selectOptions(screen.getByLabelText('仓库筛选'), 'other/lib');

    await waitFor(() => {
      expect(requests.some((url) => url.includes('/api/audit') && url.includes('repo=other%2Flib'))).toBe(true);
    });
  });
});