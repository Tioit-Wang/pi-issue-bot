/**
 * 项目设置（四项分区）的验收用例。
 *
 * 盯六件事：
 *  1. 四个分区都能打开，旧分区 key（comment / catalog / triggers / limits）跳转到合并后的分区；
 *  2. 改一个事件开关后保存条变脏，PUT 的 body 是**整份 settings**，键路径写对；
 *  3. 事件模板与系统提示词**默认就填着内置默认值**，改成本地默认之外才写库；
 *  4. 评论闸门与提及关键词/角色清单在同一个分区（原「评论触发」已合并）；
 *  5. 标签分区同时承载 `managed` / `status`（原「标签目录」已合并）；
 *  6. 执行分区同时承载两套限额与写回动作开关（原「限额」已合并）。
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { HttpResponse, http } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_EVENT_TEMPLATES, DEFAULT_SYSTEM_PROMPT, PROMPT_PLACEHOLDERS } from '../../../../../packages/contract/src/index.ts';
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

describe('设置页 · 分区骨架', () => {
  it('四个分区都在，导航每项带现状摘要', async () => {
    renderAt('/repos/acme__widgets/settings/events');

    expect(await screen.findByTestId('settings-events')).toBeTruthy();

    const nav = screen.getByRole('navigation', { name: '设置分区' });
    for (const label of ['通用', '事件绑定', '标签', '执行']) {
      expect(within(nav).getByRole('link', { name: new RegExp(label, 'u') })).toBeTruthy();
    }

    // 摘要来自草稿（不是另一套计算）
    expect(screen.getByTestId('repo-settings-tab-events').textContent).toContain('直接 2');
    expect(screen.getByTestId('repo-settings-tab-labels').textContent).toContain('参与对齐');
    expect(screen.getByTestId('repo-settings-tab-execution').textContent).toContain('并发');
  });

  it('旧分区 key 跳到合并后的分区（老书签不 404）', async () => {
    renderAt('/repos/acme__widgets/settings/comment');
    expect(await screen.findByTestId('settings-events')).toBeTruthy();

    renderAt('/repos/acme__widgets/settings/catalog');
    expect(await screen.findByTestId('settings-labels')).toBeTruthy();

    renderAt('/repos/acme__widgets/settings/limits');
    expect(await screen.findByTestId('settings-execution')).toBeTruthy();
  });

  it('事件分区：五个事件是标签页，一次只渲染一个面板', async () => {
    renderAt('/repos/acme__widgets/settings/events');
    await screen.findByTestId('settings-events');

    // 五个标签都在（无论开关状态）
    for (const key of ['issues.opened', 'issues.edited', 'issues.labeled', 'issues.closed', 'issue_comment.created']) {
      expect(screen.getByTestId(`v21-event-tab-${key}`)).toBeTruthy();
    }
    // 但面板只有一个：默认停在第一个事件
    expect(screen.getByTestId('v21-event-issues.opened')).toBeTruthy();
    expect(screen.queryByTestId('v21-event-issues.edited')).toBeNull();
  });

  it('切换标签 → 渲染对应事件；附加条件只出现在该事件的面板里', async () => {
    const user = userEvent.setup();
    renderAt('/repos/acme__widgets/settings/events');
    await screen.findByTestId('settings-events');

    await user.click(screen.getByTestId('v21-event-tab-issues.edited'));
    const edited = await screen.findByTestId('v21-event-issues.edited');
    expect(within(edited).getByRole('switch', { name: '正文变更才触发' })).toBeTruthy();

    await user.click(screen.getByTestId('v21-event-tab-issues.opened'));
    const opened = await screen.findByTestId('v21-event-issues.opened');
    expect(within(opened).queryByRole('switch')).toBeNull();
  });

  it('评论事件标签页里四个闸门与关键词/角色都在', async () => {
    const user = userEvent.setup();
    renderAt('/repos/acme__widgets/settings/events');
    await screen.findByTestId('settings-events');

    await user.click(screen.getByTestId('v21-event-tab-issue_comment.created'));
    const comment = await screen.findByTestId('v21-event-issue_comment.created');
    for (const label of ['必须 @ 到关键词', '限定角色', '忽略机器人自己的评论', '已关闭的 issue 也响应']) {
      expect(within(comment).getByRole('switch', { name: label })).toBeTruthy();
    }
    expect(within(comment).getByLabelText('提及关键词（@ 后面的名字）')).toBeTruthy();
    expect(within(comment).getByLabelText('新增角色（回车添加）')).toBeTruthy();
  });

  it('事件未开启 → 标签置灰、面板内容不可编辑，只有开关可点', async () => {
    const user = userEvent.setup();
    renderAt('/repos/acme__widgets/settings/events');
    await screen.findByTestId('settings-events');

    // 样本里 issues.closed 默认是 off
    const closedTab = screen.getByTestId('v21-event-tab-issues.closed');
    expect(closedTab.getAttribute('data-off')).toBe('true');

    await user.click(closedTab);
    const panel = await screen.findByTestId('v21-event-issues.closed');
    expect(panel.getAttribute('data-off')).toBe('true');
    // 可编辑区整块 inert（不可聚焦、不可点、读屏跳过）
    expect(screen.getByTestId('v21-event-editable').hasAttribute('inert')).toBe(true);
    expect(screen.getByTestId('v21-event-off-note').textContent).toContain('不触发');

    // 开关本身仍然可点：改成「直接触发」后内容恢复可编辑
    await user.click(within(panel).getByRole('radio', { name: '直接触发' }));
    expect(screen.getByTestId('v21-event-editable').hasAttribute('inert')).toBe(false);
    expect(screen.getByTestId('v21-event-tab-issues.closed').getAttribute('data-off')).toBe('false');
  });
});

describe('设置页 · 事件与模版', () => {
  it('模板输入框默认填着内置默认模板；改成别的内容才写库', async () => {
    const user = userEvent.setup();
    const calls = recordSettingsPut();
    renderAt('/repos/acme__widgets/settings/events');

    const opened = await screen.findByTestId('v21-event-issues.opened');
    const textarea = within(opened).getByLabelText('提示词模板') as HTMLTextAreaElement;
    // 默认就把内置模板显示出来（不再是空框 + 「留空 = 用内置默认」）
    expect(textarea.value).toBe(DEFAULT_EVENT_TEMPLATES['issues.opened']);

    await user.clear(textarea);
    await user.type(textarea, '请判定这条 issue 的类型');
    expect(screen.getByTestId('v21-event-prompt-count-issues.opened').textContent).toContain('/ 4000');

    await user.click(screen.getByTestId('settings-events-save'));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.triggers.events['issues.opened'].prompt).toBe('请判定这条 issue 的类型');
  });

  it('清空模板 → 落库是 null（回到内置默认，只有一种「没写」）', async () => {
    const user = userEvent.setup();
    const calls = recordSettingsPut();
    renderAt('/repos/acme__widgets/settings/events');

    const opened = await screen.findByTestId('v21-event-issues.opened');
    const textarea = within(opened).getByLabelText('提示词模板') as HTMLTextAreaElement;
    // 先写一段自定义内容，再清空：清空后框里保持为空（不会被默认值立刻填回来）
    await user.clear(textarea);
    await user.type(textarea, '自定义指令');
    expect(textarea.value).toBe('自定义指令');
    await user.clear(textarea);
    expect(textarea.value).toBe('');

    // 同时改一个开关，让保存条变脏（清空等于回到基线，本身不算改动）
    await user.click(within(opened).getByRole('radio', { name: '条件触发' }));
    await user.click(screen.getByTestId('settings-events-save'));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.triggers.events['issues.opened'].prompt).toBeNull();
  });
  it('点占位符按钮 → 插到光标处，不是追加到末尾', async () => {
    const user = userEvent.setup();
    const calls = recordSettingsPut();
    renderAt('/repos/acme__widgets/settings/events');

    const opened = await screen.findByTestId('v21-event-issues.opened');
    const textarea = within(opened).getByLabelText('提示词模板') as HTMLTextAreaElement;
    await user.clear(textarea);
    await user.type(textarea, '请判定：类型');

    // 光标停在「请判定：」之后、「类型」之前，插入应当落在这里
    const caret = '请判定：'.length;
    textarea.setSelectionRange(caret, caret);
    await user.click(within(opened).getByRole('button', { name: '插入占位符 issue.labels' }));

    expect(textarea.value).toBe('请判定：{{issue.labels}}类型');
    // 光标挪到插入文本之后：可以接着连点下一个占位符
    expect(textarea.selectionStart).toBe(caret + '{{issue.labels}}'.length);

    await user.click(within(opened).getByRole('button', { name: '插入占位符 issue.number' }));
    expect(textarea.value).toBe('请判定：{{issue.labels}}{{issue.number}}类型');

    await user.click(screen.getByTestId('settings-events-save'));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.triggers.events['issues.opened'].prompt).toBe('请判定：{{issue.labels}}{{issue.number}}类型');
  });

  it('12 个占位符按钮都在每个事件下（清单来自契约，不自造）', async () => {
    renderAt('/repos/acme__widgets/settings/events');

    const opened = await screen.findByTestId('v21-event-issues.opened');
    const tokens = within(opened).getByTestId('v21-event-prompt-issues.opened-tokens');
    expect(within(tokens).getAllByRole('button')).toHaveLength(PROMPT_PLACEHOLDERS.length);
    // 名字与契约逐项对得上：按钮点下去插的一定是服务端认识的占位符
    for (const placeholder of PROMPT_PLACEHOLDERS) {
      expect(within(tokens).getByRole('button', { name: `插入占位符 ${placeholder.name}` }).textContent).toBe(
        `{{${placeholder.name}}}`,
      );
    }
  });
  it('改一个事件开关 → 保存条变脏，保存请求体里带该事件的 enabled', async () => {
    const user = userEvent.setup();
    const calls = recordSettingsPut();
    renderAt('/repos/acme__widgets/settings/events');

    const opened = await screen.findByTestId('v21-event-issues.opened');
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
    expect(saved?.triggers.events['issues.edited'].enabled).toBe('on');
    expect(saved?.triggers.events['issues.closed'].enabled).toBe('off');
    // 没动过的模板不写自定义内容
    expect(saved?.triggers.events['issues.opened'].prompt).toBeNull();
  });

  it('别名与命中预览也在事件分区（原「触发」分区）', async () => {
    renderAt('/repos/acme__widgets/settings/events');
    await screen.findByTestId('settings-events');

    expect(screen.getByTestId('settings-triggers')).toBeTruthy();
    expect(screen.getByTestId('triggers-effective-aliases').textContent).toContain('@issuebot');
    expect(screen.getByTestId('triggers-preview')).toBeTruthy();
  });
});

describe('设置页 · 评论闸门（已并入事件分区的评论标签页）', () => {
  /** 评论闸门在评论标签页里：先切过去，否则面板里根本没有这些控件。 */
  async function openCommentTab(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
    renderAt('/repos/acme__widgets/settings/events');
    await screen.findByTestId('settings-events');
    await user.click(screen.getByTestId('v21-event-tab-issue_comment.created'));
    return await screen.findByTestId('v21-event-issue_comment.created');
  }

  it('角色为空时 allow_roles 多选禁用，并提示先定义角色', async () => {
    const user = userEvent.setup();
    await openCommentTab(user);

    const allowRoles = await screen.findByTestId('v21-allow-roles');
    const group = within(allowRoles).getByRole('group');
    expect(group.getAttribute('data-disabled')).toBe('true');
    expect(allowRoles.textContent).toContain('先在上方新增角色');
    expect(within(allowRoles).queryByRole('checkbox')).toBeNull();
  });

  it('新增角色（回车添加）会把角色写进 comment.roles', async () => {
    const user = userEvent.setup();
    const calls = recordSettingsPut();
    await openCommentTab(user);

    const addRole = screen.getByLabelText('新增角色（回车添加）');
    await user.type(addRole, '维护者{Enter}');

    expect(screen.getByTestId('v21-comment-roles').textContent).toContain('维护者');

    await user.click(screen.getByTestId('settings-events-save'));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    // 成员默认取项目管理员（样本 acme/widgets 的 agent.managers）
    expect(calls[0]?.comment.roles).toEqual([
      { name: '维护者', by: 'members', members: (calls[0]?.agent.managers ?? []) as string[] },
    ]);
  });
});

describe('设置页 · 标签（含目标态字段）', () => {
  it('managed 开关可切换；status 可改 retired', async () => {
    const user = userEvent.setup();
    renderAt('/repos/acme__widgets/settings/labels');

    await screen.findByTestId('settings-labels');

    const managed = screen.getAllByRole('switch', { name: '自动对齐' })[0] as HTMLElement;
    expect(managed.getAttribute('aria-checked')).toBe('true');
    await user.click(managed);
    expect(managed.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('settings-labels-changed').textContent).toContain('改了 1 项');

    // status 下拉：改成 retired 后仍能保存（服务端把 retired 当「不进入目标态」）
    const selects = screen.getAllByRole('combobox', { name: /status/u });
    expect(selects.length).toBeGreaterThan(0);
    await user.selectOptions(selects[0] as HTMLSelectElement, 'retired');
  });
});

describe('设置页 · 执行', () => {
  it('系统提示词默认填着内置默认值，改后才写库（两处同写）', async () => {
    const user = userEvent.setup();
    const calls = recordSettingsPut();
    renderAt('/repos/acme__widgets/settings/execution');

    await screen.findByTestId('settings-execution');

    const prompt = screen.getByLabelText('项目级系统提示词') as HTMLTextAreaElement;
    expect(prompt.value).toBe(DEFAULT_SYSTEM_PROMPT);

    await user.clear(prompt);
    await user.type(prompt, '本仓库只回答与构建相关的问题。');

    await user.click(screen.getByTestId('settings-execution-save'));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });

    const saved = calls[0];
    expect(saved?.agent.system_prompt).toBe('本仓库只回答与构建相关的问题。');
    // 两处同写：服务端按「前者非空优先，否则读 limits」
    expect(saved?.agent.limits.system_prompt).toBe('本仓库只回答与构建相关的问题。');
    expect(saved?.agent.actions).toEqual({ create_issue: false, open_pr: false, close_issue: false });
    expect(saved?.agent.limits.daily_quota).toBe(100);
    // v0.3 的限额字段也在这台页面上可写
    expect(saved?.limits.max_comments_per_hour).toBeDefined();
    expect(saved?.limits.concurrency_per_repo).toBeDefined();
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
