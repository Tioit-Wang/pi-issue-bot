/**
 * 四态代表页（`/system`）：**空 / 错 / 401 / 慢**（+ 正常态做对照）。
 *
 * 为什么用 `/system` 当代表：它的数据源 `/api/system` 是唯一「无参数、必返回」的接口，
 * 四态语义最干净（不带筛选、不带游标），也覆盖了 `AsyncSection` 的全部四个分支。
 *
 * 场景开关读页面 URL 的 `?mock=`，所以每条用例只需要把 `window.location` 设成对应 URL。
 */
import { screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHandlers } from '../src/mocks/handlers/index.ts';
import { SystemPage } from '../src/routes/system.tsx';
import { renderWithProviders } from './render.tsx';

const server = setupServer(...createHandlers());

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
});
afterAll(() => {
  server.close();
});
afterEach(() => {
  server.resetHandlers();
});

describe('/system 的四态', () => {
  it('正常态：渲染真数据（版本 / 队列 / 仓库）', async () => {
    renderWithProviders(<SystemPage />, { route: '/system' });

    expect(await screen.findByTestId('system-content')).toBeTruthy();
    expect(await screen.findByText('版本与协议')).toBeTruthy();
    expect(screen.getByText('run-task')).toBeTruthy();
    expect(screen.getByText('acme/widgets')).toBeTruthy();
    // 契约占位字段如实显示「未知 / 未体检」，不假装正常
    expect(screen.getByText('未知')).toBeTruthy();
  });

  it('空态：`?mock=empty` → 显示空提示而不是空白页', async () => {
    renderWithProviders(<SystemPage />, { route: '/system?mock=empty' });

    const empty = await screen.findByTestId('system-empty');
    expect(empty.textContent).toContain('还没有任何仓库与队列配置');
    expect(screen.queryByTestId('system-content')).toBeNull();
  });

  it('错误态：`?mock=error` → 500 走 Alert（不重试、不白屏）', async () => {
    renderWithProviders(<SystemPage />, { route: '/system?mock=error' });

    const error = await screen.findByTestId('system-error');
    expect(error.textContent).toContain('读取失败');
    expect(error.textContent).toContain('读取数据库失败');
  });

  it('401：`?mock=unauthorized` → 提示会话过期（文案与 500 不同）', async () => {
    renderWithProviders(<SystemPage />, { route: '/system?mock=unauthorized' });

    const error = await screen.findByTestId('system-error');
    expect(error.textContent).toContain('会话已过期或未登录');
  });

  it('慢态：`?mock=slow` → 先出骨架，再出内容', async () => {
    renderWithProviders(<SystemPage />, { route: '/system?mock=slow' });

    expect(await screen.findByTestId('system-loading')).toBeTruthy();
    expect(await screen.findByTestId('system-content', undefined, { timeout: 5000 })).toBeTruthy();
  });
});
