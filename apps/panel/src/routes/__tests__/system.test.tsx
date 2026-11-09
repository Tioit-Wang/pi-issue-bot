import { screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHandlers } from '../../mocks/handlers/index.ts';
import { renderWithProviders } from '../../../test/render.tsx';
import { SystemPage } from '../system.tsx';

/**
 * 系统页（S7）的渲染断言。
 *
 * `test/system-states.test.tsx`（P0，冻结）管的是**四态锚点**；本文件管的是**内容语义**：
 * doctor 的 ok/warn/fail/skip 四种样式、保留期数字、能力清单、以及「降级横幅到底命中了哪几条」。
 * doctor 的 fail 行必须高亮（`bg-destructive/*`），这是「运维一眼看到坏消息」的最低要求。
 */
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

describe('/system', () => {
  it('正常态：版本与协议 / host / doctor 逐项 / 队列 / 保留期 / 能力', async () => {
    renderWithProviders(<SystemPage />, { route: '/system' });

    expect(await screen.findByTestId('system-content')).toBeTruthy();

    // 版本：pi-host 未协商 ⇒ `—`（不是 0，也不是编造的版本号）
    expect(screen.getByText('版本与协议')).toBeTruthy();
    expect(screen.getByText('pi-host 版本')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);

    // doctor：fail 行整行高亮 + 中文状态词
    const failed = screen.getByTestId('doctor-canary-network');
    expect(failed.textContent).toContain('失败');
    expect(failed.className).toContain('bg-destructive');
    expect(screen.getByTestId('doctor-disk-space').textContent).toContain('告警');
    expect(screen.getByTestId('doctor-tls-cert').textContent).toContain('跳过');

    // 队列：expireInMs 走 formatDuration（1_200_000ms → 20m）
    expect(screen.getByText('run-task')).toBeTruthy();
    expect(screen.getByText('20m')).toBeTruthy();

    // 保留期：天数是对计数值调用 formatCount，不是手写字符串拼接
    expect(screen.getByText(/webhook 90 天/)).toBeTruthy();

    // 能力：skills 是被禁用的也要出现（contract-skill §3）
    expect(screen.getByText('能力（skills）')).toBeTruthy();
    expect(screen.getByText('/review-pr')).toBeTruthy();
    expect(screen.getByText('skill_invalid')).toBeTruthy();
  });

  it('降级横幅条件：命中项逐条展开（熔断 / PIN / doctor）', async () => {
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
