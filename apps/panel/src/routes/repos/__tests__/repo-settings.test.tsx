/**
 * 仓库设置页的验收用例（D2-b 重做信息组织后的版本）。
 *
 * 这一版盯的是「一屏看清」的四件事 + 原有逻辑不回退：
 *  1. 左二级导航 4 项都能到、且每项带一句现状摘要；
 *  2. 顶部状态条：仓库名 + 启用 / 干跑 / 配置合法 三个点 + 最后一次保存；
 *  3. 吸底保存条：改了 N 项、四态文案；
 *  4. 原逻辑：草稿层脏数据拦截、triggers 的整份 payload、命中预览两条分支（提及 / 代码块）。
 *
 * v0.3：提示词分区（以及「流水线」分区）随固定流水线退役删除，设置只剩 4 个分区。
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { HttpResponse, http } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHandlers } from '../../../mocks/handlers/index.ts';
import type { RepoSettingsResponse, SaveRepoSettingsRequest } from '../../../lib/contract.ts';
import { RepoSettingsPage } from '../../repo-settings.tsx';

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

beforeEach(() => {
  window.history.replaceState({}, '', '/');
});

/** 直接渲染页面本体（不经过 `AppRoutes`：设置页只依赖 `:repo` / `:section` 两个参数）。 */
function renderAt(path: string): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false, gcTime: 0 } },
  });
  window.history.replaceState({}, '', path);
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/repos/:repo/settings/:section" element={<RepoSettingsPage />} />
          <Route path="/system" element={<p>系统页桩</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function recordSettingsPut(): SaveRepoSettingsRequest[] {
  const calls: SaveRepoSettingsRequest[] = [];
  server.use(
    http.put('/api/repos/:owner/:name/settings', async ({ request, params }) => {
      const body = (await request.json()) as SaveRepoSettingsRequest;
      calls.push(body);
      const view: RepoSettingsResponse = {
        repo: `${String(params['owner'])}/${String(params['name'])}`,
        enabled: body.enabled,
        dryRun: body.dry_run,
        settings: body,
        settingsValid: true,
        settingsError: null,
        source: 'installation',
        installationId: '12345678',
        archivedAt: null,
      };
      return HttpResponse.json(view);
    }),
  );
  return calls;
}

describe('设置页 · 骨架', () => {
  it('四个分区都能打开，导航每项都有一句现状摘要', async () => {
    const user = userEvent.setup();
    renderAt('/repos/acme__widgets/settings/general');

    expect(await screen.findByRole('heading', { level: 1, name: '设置 · 通用' })).toBeTruthy();
    expect(await screen.findByTestId('settings-general')).toBeTruthy();

    // 摘要来自草稿：acme/widgets 的样本是「启用 · 写回 GitHub」
    expect(screen.getByTestId('repo-settings-tab-general').textContent).toContain('启用 · 写回 GitHub');
    expect(screen.getByTestId('repo-settings-tab-events').textContent).toContain('关键词');
    expect(screen.getByTestId('repo-settings-tab-labels').textContent).toContain('词表');
    expect(screen.getByTestId('repo-settings-tab-execution').textContent).toContain('并发');

    await user.click(screen.getByTestId('repo-settings-tab-events'));
    expect(await screen.findByRole('heading', { level: 1, name: '设置 · 事件绑定' })).toBeTruthy();
    expect(await screen.findByTestId('settings-events')).toBeTruthy();

    await user.click(screen.getByTestId('repo-settings-tab-labels'));
    expect(await screen.findByTestId('settings-labels')).toBeTruthy();

    await user.click(screen.getByTestId('repo-settings-tab-execution'));
    expect(await screen.findByTestId('settings-execution')).toBeTruthy();
  });

  it('顶部状态条：仓库名 + 启用 / 真写 / 配置合法 + 最后一次保存', async () => {
    renderAt('/repos/acme__widgets/settings/general');

    const status = await screen.findByTestId('repo-settings-status');
    expect(within(status).getByTestId('repo-settings-status-repo').textContent).toBe('acme/widgets');
    expect(within(status).getByTestId('repo-settings-status-enabled').textContent).toContain('启用');
    expect(within(status).getByTestId('repo-settings-status-dryrun').textContent).toContain('真写');
    expect(within(status).getByTestId('repo-settings-status-valid').textContent).toContain('配置合法');
    expect(status.textContent).toContain('最后一次保存');
  });

  it('未保存改动时切分区会被拦下（留在本页 / 放弃并前往），保存条显示改了 N 项', async () => {
    const user = userEvent.setup();
    renderAt('/repos/acme__widgets/settings/general');

    const enabled = await screen.findByRole('switch', { name: '接受事件（enabled）' });
    await user.click(enabled);

    // 吸底保存条：改了 1 项 + 撤销可点
    expect(screen.getByTestId('settings-general-savebar')).toBeTruthy();
    expect(screen.getByTestId('settings-general-changed').textContent).toContain('改了 1 项');

    await user.click(screen.getByTestId('repo-settings-tab-events'));
    const guard = await screen.findByTestId('repo-settings-dirty-guard');
    expect(guard.textContent).toContain('有未保存的改动');

    await user.click(screen.getByTestId('repo-settings-dirty-stay'));
    expect(screen.getByRole('heading', { level: 1, name: '设置 · 通用' })).toBeTruthy();

    await user.click(screen.getByTestId('repo-settings-tab-events'));
    await user.click(await screen.findByTestId('repo-settings-dirty-discard'));
    expect(await screen.findByRole('heading', { level: 1, name: '设置 · 事件绑定' })).toBeTruthy();
  });
});

describe('设置页 · 触发（已并入事件分区）', () => {
  it('保存 payload：别名小写化 + 去重（整份 settings）', async () => {
    const user = userEvent.setup();
    const calls = recordSettingsPut();
    renderAt('/repos/acme__widgets/settings/events');

    const aliasInput = await screen.findByLabelText('额外别名（aliases，1–8 个）');
    await user.type(aliasInput, '@IssueBotX');
    await user.keyboard('{Enter}');

    const chips = screen.getByTestId('triggers-aliases-chips');
    expect(chips.textContent).toContain('issuebotx');
    expect(chips.textContent).not.toContain('IssueBotX');

    await user.type(aliasInput, 'ISSUEBOTX');
    await user.keyboard('{Enter}');
    expect(await screen.findByText(/已经在列表里/u)).toBeTruthy();

    await user.click(screen.getByTestId('settings-events-save'));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });

    const saved = calls[0];
    // 样本仓库的默认别名是 issuebot（`mocks/handlers/repos.ts`），新别名追加在后面
    expect(saved?.triggers.aliases).toEqual(['issuebot', 'issuebotx']);
    expect(saved?.version).toBe(1);
    expect(saved?.limits.max_comments_per_hour).toBe(10);
    expect(saved?.agent.on_opened).toBe('issue-format');
  });

  it('命中预览 ① 提及：@issuebot 后面跟正文 → 会交给 agent', async () => {
    renderAt('/repos/acme__widgets/settings/triggers');

    const textarea = await screen.findByLabelText('粘贴一段评论正文');
    fireEvent.change(textarea, { target: { value: '@issuebot /issue-triage 17 --deep' } });

    expect(screen.getByTestId('trigger-preview-verdict').textContent).toBe('会触发');
    expect(screen.getByTestId('trigger-preview-alias').textContent).toContain('@issuebot');
    expect(screen.getByTestId('trigger-preview-kind').textContent).toContain('命中别名');
    expect(screen.getByTestId('trigger-preview-code').textContent).toContain('没有代码区');
  });

  it('命中预览 ② 代码块：@ 在围栏里 → 不触发，并列出被蒙版挡住的片段', async () => {
    renderAt('/repos/acme__widgets/settings/triggers');

    const textarea = await screen.findByLabelText('粘贴一段评论正文');
    fireEvent.change(textarea, { target: { value: '可以这么写吗？\n```\n@issuebot /issue-triage 17\n```\n' } });

    expect(screen.getByTestId('trigger-preview-verdict').textContent).toBe('不触发');
    expect(screen.getByTestId('trigger-preview-alias').textContent).toContain('没命中');
    expect(screen.getByTestId('trigger-preview-reason').textContent).toContain('代码区');
    const code = screen.getByTestId('trigger-preview-code');
    expect(code.textContent).toContain('@issuebot /issue-triage 17');
  });

  it('生效别名来自仓库配置（aliases 就是它的全部来源）', async () => {
    renderAt('/repos/acme__widgets/settings/triggers');

    const effective = await screen.findByTestId('triggers-effective-aliases');
    expect(effective.textContent).toContain('@issuebot');
  });
});
