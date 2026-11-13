import { screen, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHandlers } from '../../mocks/handlers/index.ts';
import { renderWithProviders } from '../../../test/render.tsx';
import { SystemPage } from '../system.tsx';

/**
 * 系统页的内容语义（四态锚点由 `test/system-states.test.tsx` 管）：
 * doctor 的 ok / warn / fail / skip 分组、保留期数字、能力清单、降级条件逐条展开，
 * 以及「仓库」这一块的只读性质（只有链接，没有开关）。
 */
const server = setupServer(...createHandlers());
const requests: string[] = [];

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
  server.events.on('request:start', (event) => {
    requests.push(event.request.url);
  });
});

beforeEach(() => {
  requests.length = 0;
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
afterAll(() => {
  server.close();
});
afterEach(() => {
  server.resetHandlers();
});

describe('/system', () => {
  it('正常态：版本与协议 / doctor 分组 / 队列 / 保留期', async () => {
    renderWithProviders(<SystemPage />, { route: '/system' });

    expect(await screen.findByTestId('system-content')).toBeTruthy();

    // 版本：pi-host 未协商 ⇒ —（不是 0，也不是编造的版本号）
    expect(screen.getByText('版本与协议')).toBeTruthy();
    expect(screen.getByText('pi-host 版本')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    // host 状态 unknown 显示「未知」，不假装正常
    expect(screen.getByTestId('system-host').textContent).toContain('未知');

    // doctor：fail 行整行高亮（danger 面）+ 中文状态词；按状态分组
    const failed = screen.getByTestId('doctor-canary-network');
    expect(failed.textContent).toContain('失败');
    expect(failed.getAttribute('data-tone')).toBe('danger');
    expect(failed.className).toContain('bg-danger');
    // 失败项把 detail 摊开（不是只在 title 里）
    expect(failed.textContent).toContain('金丝雀探测不可达');
    expect(screen.getByTestId('doctor-disk-space').textContent).toContain('告警');
    expect(screen.getByTestId('doctor-tls-cert').textContent).toContain('跳过');
    expect(screen.getByText(/失败（2）/)).toBeTruthy();
    expect(screen.getByText(/跳过（1）/)).toBeTruthy();

    // 队列：expireInMs 走 formatDuration（1_200_000ms → 20m）
    expect(screen.getByText('run-task')).toBeTruthy();
    expect(screen.getByText('20m')).toBeTruthy();

    // 保留期：天数是对计数值调用 formatCount
    expect(screen.getByText(/webhook 90 天/)).toBeTruthy();

    // 技能只属于项目：系统页不再有「能力（skills）」这一段
    expect(screen.queryByText('能力（skills）')).toBeNull();
    expect(screen.queryByText('/review-pr')).toBeNull();
  });

  it('降级条件：逐条展开（熔断 / PIN / doctor）', async () => {
    renderWithProviders(<SystemPage />, { route: '/system' });

    const degraded = await screen.findByTestId('system-degraded');
    expect(degraded.textContent).toContain('命中');
    expect(degraded.textContent).toContain('全局 429 熔断中');
    expect(degraded.textContent).toContain('PIN');
    expect(degraded.textContent).toContain('doctor 未通过');
  });

  it('空态：`?mock=empty` → 空提示（仓库/队列/flag 全空）', async () => {
    renderWithProviders(<SystemPage />, { route: '/system?mock=empty' });

    const empty = await screen.findByTestId('system-empty');
    expect(empty.textContent).toContain('还没有任何仓库与队列配置');
    expect(screen.queryByTestId('system-content')).toBeNull();
  });

  it('错误态：500 → Alert 文案与 401 不同，且提供重试', async () => {
    renderWithProviders(<SystemPage />, { route: '/system?mock=error' });

    const error = await screen.findByTestId('system-error');
    expect(error.textContent).toContain('读取数据库失败');
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });
});

describe('/system 仓库筛选与只读展示', () => {
  it('`?repo=` 只收窄「仓库」块；这一块没有开关，只有到设置页的链接', async () => {
    renderWithProviders(<SystemPage />, { route: '/system?repo=other/lib' });

    const content = await screen.findByTestId('system-content');
    expect(screen.getByTestId('system-filters').textContent).toContain('只看 other/lib');
    expect(within(content).getByTestId('system-repo-other/lib')).toBeTruthy();
    expect(within(content).queryByTestId('system-repo-acme/widgets')).toBeNull();

    const list = within(content).getByTestId('system-repos');
    // 只读 = 没有可点的开关（写入口是链接，不是开关）
    expect(within(list).queryAllByRole('button')).toHaveLength(0);
    expect(within(list).queryAllByRole('checkbox')).toHaveLength(0);
    const link = within(list).getByRole('link', { name: 'other/lib' });
    expect(link.getAttribute('href')).toBe('/repos/other__lib/settings/general');
  });
});