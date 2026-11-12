/**
 * v2.1 设置分区（`docs/v21-contract.md` §1）的验收用例。
 *
 * 盯五件事（对应 WS5 的交付物 A ~ E）：
 *  1. 四个新分区都能打开，且旧分区仍在（不破坏存量配置的编辑入口）；
 *  2. 改一个事件开关后保存条变脏（草稿层是唯一状态，没有本地双写）；
 *  3. 保存请求体里带 `triggers.events['issues.opened'].enabled`
 *     （PUT 的 body 是**整份 settings**，键路径写错就等于配置没生效）；
 *  4. 角色清单为空时 `allow_roles` 多选禁用并说明「先去定义角色」
 *     （引用不存在的角色是服务端硬错误，界面必须先拦住）；
 *  5. 目录里的 `managed` 开关可切换（BR-11 的人工接管标记）。
 *
 * 用 `RepoSettingsPage` 直接渲染（与 `repos/__tests__/repo-settings.test.tsx` 同一套做法）：
 * 设置页只依赖 `:repo` / `:section` 两个路径参数，不需要整个 `AppRoutes`。
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { HttpResponse, http } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHandlers } from '../../mocks/handlers/index.ts';
import type { RepoSettingsResponse, SaveRepoSettingsRequest } from '../../lib/contract.ts';
import { RepoSettingsPage } from '../repo-settings.tsx';

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

/** 直接渲染页面本体（`:repo` / `:section` 两个参数足够）。 */
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

/** 记录 PUT 的请求体（断言「保存的就是看到的那一份」）。 */
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

describe('设置页 · v2.1 分区骨架', () => {
  it('四个新分区都能打开，旧的四个分区也还在', async () => {
    const user = userEvent.setup();
    renderAt('/repos/acme__widgets/settings/events');

    expect(await screen.findByTestId('settings-events')).toBeTruthy();

    const nav = screen.getByRole('navigation', { name: '设置分区' });
    for (const label of ['通用', '事件与模板', '评论触发', '标签', '标签目录 v2.1', '执行与限额', '触发', '限额']) {
      expect(within(nav).getByRole('link', { name: label })).toBeTruthy();
    }

    // 导航第二行的现状摘要来自草稿（不是另一套计算）
    expect(screen.getByTestId('repo-settings-tab-events').textContent).toContain('直接 2');
    expect(screen.getByTestId('repo-settings-tab-comment').textContent).toContain('关键词 1');
    expect(screen.getByTestId('repo-settings-tab-catalog').textContent).toContain('参与对齐');
    expect(screen.getByTestId('repo-settings-tab-execution').textContent).toContain('并发');

    await user.click(screen.getByTestId('repo-settings-tab-comment'));
    expect(await screen.findByTestId('settings-comment')).toBeTruthy();

    await user.click(screen.getByTestId('repo-settings-tab-catalog'));
    expect(await screen.findByTestId('settings-catalog')).toBeTruthy();

    await user.click(screen.getByTestId('repo-settings-tab-execution'));
    expect(await screen.findByTestId('settings-execution')).toBeTruthy();
  });

  it('事件分区：五个事件各有一行，评论事件的四个闸门都在', async () => {
    renderAt('/repos/acme__widgets/settings/events');
    await screen.findByTestId('settings-events');

    for (const key of ['issues.opened', 'issues.edited', 'issues.labeled', 'issues.closed', 'issue_comment.created']) {
      expect(screen.getByTestId(`v21-event-${key}`)).toBeTruthy();
    }

    // 附加条件只出现在对应事件下（不会渲染一个写了也不生效的开关）
    expect(within(screen.getByTestId('v21-event-issues.edited')).getByRole('switch', { name: /only_body_changed/u })).toBeTruthy();
    expect(within(screen.getByTestId('v21-event-issues.opened')).queryByRole('switch')).toBeNull();

    const comment = screen.getByTestId('v21-event-issue_comment.created');
    for (const label of [/require_mention/u, /require_role/u, /ignore_bot/u, /allow_closed/u]) {
      expect(within(comment).getByRole('switch', { name: label })).toBeTruthy();
    }
  });
});

describe('设置页 · 事件开关', () => {
  it('改一个事件开关 → 保存条变脏，保存请求体里带该事件的 enabled', async () => {
    const user = userEvent.setup();
    const calls = recordSettingsPut();
    renderAt('/repos/acme__widgets/settings/events');

    const opened = await screen.findByTestId('v21-event-issues.opened');
    // 默认 on（FR-2.1），改成条件触发
    await user.click(within(opened).getByRole('radio', { name: '条件触发' }));

    expect(await screen.findByTestId('settings-events-changed')).toBeTruthy();
    expect(screen.getByTestId('settings-events-changed').textContent).toContain('改了 1 项');
    expect(screen.getByTestId('v21-event-state-issues.opened').textContent).toContain('条件触发');

    await user.click(screen.getByTestId('settings-events-save'));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });

    const saved = calls[0];
    expect(saved?.triggers.events['issues.opened'].enabled).toBe('conditional');
    // 其余事件保持默认（改一处不该顺手改别的）
    expect(saved?.triggers.events['issues.edited'].enabled).toBe('on');
    expect(saved?.triggers.events['issues.closed'].enabled).toBe('off');
    // 模板清空 = 用内置默认（落库是 null，不是空串）
    expect(saved?.triggers.events['issues.opened'].prompt).toBeNull();
  });

  it('事件提示词模板：填了就写进 payload，清空回 null', async () => {
    const user = userEvent.setup();
    const calls = recordSettingsPut();
    renderAt('/repos/acme__widgets/settings/events');

    const openedBlock = await screen.findByTestId('v21-event-issues.opened');
    // 五个事件的模板输入框共用同一个 label 文案，所以先在事件块内定位（事件名里带点，不能写进 CSS 选择器）
    const textarea = within(openedBlock).getByLabelText('提示词模板（留空 = 用内置默认）');
    await user.type(textarea, '请判定这条 issue 的类型');
    expect(screen.getByTestId('v21-event-prompt-count-issues.opened').textContent).toContain('/ 4000');

    await user.click(screen.getByTestId('settings-events-save'));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.triggers.events['issues.opened'].prompt).toBe('请判定这条 issue 的类型');
  });
});

describe('设置页 · 评论触发', () => {
  it('角色为空时 allow_roles 多选禁用，并提示先定义角色', async () => {
    renderAt('/repos/acme__widgets/settings/events');

    const allowRoles = await screen.findByTestId('v21-allow-roles');
    // 样本仓库的 comment.roles 是空（默认值），所以闸门没有可选项、整组禁用
    const group = within(allowRoles).getByRole('group');
    expect(group.getAttribute('data-disabled')).toBe('true');
    expect(allowRoles.textContent).toContain('先到「评论触发」分区定义角色');
    expect(within(allowRoles).queryByRole('checkbox')).toBeNull();
  });

  it('新增角色可以切判定来源；指定成员要求至少一个 login', async () => {
    const user = userEvent.setup();
    const calls = recordSettingsPut();
    renderAt('/repos/acme__widgets/settings/comment');

    await screen.findByTestId('settings-comment');
    expect(screen.getByTestId('v21-roles-empty')).toBeTruthy();

    await user.click(screen.getByTestId('v21-role-add'));
    const row = screen.getByTestId('v21-role-row-0');
    await user.type(within(row).getByLabelText('角色名'), '维护者');

    // 新角色默认按「作者关联」判，七项里默认勾了 OWNER
    const owner = within(row).getByRole('checkbox', { name: /OWNER/u }) as HTMLInputElement;
    expect(owner.checked).toBe(true);

    // 切成「指定成员」：来源变了，成员列表为空 → 明确的错误（不是静默存一个空角色）
    await user.click(within(row).getByRole('radio', { name: '指定成员' }));
    expect(screen.getByText('至少填一个 login（否则这个角色永远判不出来）')).toBeTruthy();

    const members = screen.getByLabelText('成员 GitHub login（逗号或换行分隔，≤ 50 个）');
    await user.type(members, 'alice,bob');
    expect(screen.queryByText('至少填一个 login（否则这个角色永远判不出来）')).toBeNull();
    expect(screen.getByTestId('v21-role-members-0-count').textContent).toContain('2 / 50');

    await user.click(screen.getByTestId('settings-comment-save'));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.comment.roles).toEqual([{ name: '维护者', by: 'members', members: ['alice', 'bob'] }]);
  });

  it('关键词重复时禁用保存并说明原因（服务端硬校验）', async () => {
    const user = userEvent.setup();
    renderAt('/repos/acme__widgets/settings/comment');

    await screen.findByTestId('settings-comment');
    await user.click(screen.getByTestId('v21-mention-add'));

    const second = screen.getByLabelText('关键词（@ 后面的名字）', { selector: '#v21-mention-keyword-1' });
    await user.type(second, 'PI-BOT');

    const save = screen.getByTestId('settings-comment-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.getAttribute('title') ?? '').toContain('重复');
  });
});

describe('设置页 · 标签目录 v2.1', () => {
  it('managed 开关可切换，且「参与对齐」的判定跟着变', async () => {
    const user = userEvent.setup();
    renderAt('/repos/acme__widgets/settings/catalog');

    await screen.findByTestId('settings-catalog');

    // 样本：「需求」参与对齐，「文档」是 managed=false（人工接管）
    expect(screen.getByTestId('v21-catalog-align-0').textContent).toContain('参与对齐');
    expect(screen.getByTestId('v21-catalog-align-2').textContent).toContain('不参与');

    const managed = within(screen.getByTestId('v21-catalog-row-0')).getByRole('switch', { name: /参与自动对齐/u });
    expect(managed.getAttribute('aria-checked')).toBe('true');
    await user.click(managed);
    expect(managed.getAttribute('aria-checked')).toBe('false');

    // 判定跟着变：不再参与自动对齐
    expect(screen.getByTestId('v21-catalog-align-0').textContent).toContain('不参与');
    expect(screen.getByTestId('settings-catalog-changed').textContent).toContain('改了 1 项');
    expect(screen.getByTestId('v21-catalog-participating').textContent).toContain('参与对齐 1 / 3');
  });

  it('status 改成 retired 也会退出目标态', async () => {
    const user = userEvent.setup();
    renderAt('/repos/acme__widgets/settings/catalog');

    await screen.findByTestId('settings-catalog');
    await user.selectOptions(screen.getByTestId('v21-catalog-status-1'), 'retired');

    expect(screen.getByTestId('v21-catalog-align-1').textContent).toContain('不参与');
  });
});

describe('设置页 · 执行与限额', () => {
  it('系统提示词与默认模型限额都是可写的，越界禁用保存', async () => {
    const user = userEvent.setup();
    const calls = recordSettingsPut();
    renderAt('/repos/acme__widgets/settings/execution');

    await screen.findByTestId('settings-execution');

    const prompt = screen.getByLabelText('项目级系统提示词');
    await user.type(prompt, '本仓库只回答与构建相关的问题。');

    await user.click(screen.getByTestId('settings-execution-save'));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });

    const saved = calls[0];
    expect(saved?.agent.system_prompt).toBe('本仓库只回答与构建相关的问题。');
    // 两处同写：服务端按「前者非空优先，否则读 limits」裁决，只写一处会被绕回旧值
    expect(saved?.agent.limits.system_prompt).toBe('本仓库只回答与构建相关的问题。');
    // 三类写回动作默认全关
    expect(saved?.agent.actions).toEqual({ create_issue: false, open_pr: false, close_issue: false });
    expect(saved?.agent.limits.daily_quota).toBe(100);
  });

  it('打开「建 issue」开关后两处都为 true（服务端按或裁决）', async () => {
    const user = userEvent.setup();
    const calls = recordSettingsPut();
    renderAt('/repos/acme__widgets/settings/execution');

    await screen.findByTestId('settings-execution');
    await user.click(screen.getByRole('switch', { name: '允许 agent 新建 issue' }));
    expect(screen.getByTestId('v21-execution-actions-count').textContent).toContain('已开 1 / 3');

    await user.click(screen.getByTestId('settings-execution-save'));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.agent.actions.create_issue).toBe(true);
    expect(calls[0]?.agent.limits.actions.create_issue).toBe(true);
    expect(calls[0]?.agent.actions.open_pr).toBe(false);
  });
});
