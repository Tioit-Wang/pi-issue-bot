/**
 * 仓库设置页的验收用例（D2-b 重做信息组织后的版本）。
 *
 * 这一版盯的是「一屏看清」的四件事 + 原有逻辑不回退：
 *  1. 左二级导航 5 项都能到、且每项带一句现状摘要；
 *  2. 顶部状态条：仓库名 + 启用 / 干跑 / 配置合法 三个点 + 最后一次保存；
 *  3. 吸底保存条：改了 N 项、四态文案、提示词分区的预算剩余；
 *  4. 原逻辑：草稿层脏数据拦截、triggers 的整份 payload、命中预览三条分支、
 *     提示词超预算禁用保存、回滚二次确认、预览抽屉（现在是 `Sheet`）。
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { HttpResponse, http } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHandlers } from '../../../mocks/handlers/index.ts';
import type { PromptResponse, RepoSettingsResponse, SaveRepoSettingsRequest } from '../../../lib/contract.ts';
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

function promptFixture(body: string, available: number): PromptResponse {
  return {
    repo: 'acme/widgets',
    enabled: true,
    version: 2,
    present: true,
    body,
    versions: [
      { version: 2, note: '补一条约定', createdAt: '2026-05-31T10:00:00.000Z', chars: body.length, current: true },
      { version: 1, note: '初版', createdAt: '2026-05-20T08:30:00.000Z', chars: 12, current: false },
    ],
    budget: {
      budgetChars: 12_000,
      p1Cap: 4_000,
      otherLayersChars: 8_000,
      available,
      requested: body.length,
      ok: body.length <= available,
      source: 'last-assembly',
      layers: { p0: 1_000, p1: available, p2Root: 1_000, p2Nearby: 1_000, p3: 1_000, p4: 1_000 },
    },
    preview: {
      text: `# pi-issue-bot\n\n（基座省略）\n\n${body}`,
      stats: {
        baseChars: 1_000,
        promptChars: body.length,
        agentsChars: 500,
        skillChars: 200,
        totalChars: 1_700 + body.length,
        truncated: [],
      },
      omitted: ['AGENTS.md（来自 worktree）'],
      ref: null,
      sha: null,
    },
    lastAssembly: null,
  } satisfies PromptResponse;
}

describe('设置页 · 骨架', () => {
  it('5 个分区都能打开，导航每项都有一句现状摘要', async () => {
    const user = userEvent.setup();
    renderAt('/repos/acme__widgets/settings/general');

    expect(await screen.findByRole('heading', { level: 1, name: '设置 · 通用' })).toBeTruthy();
    expect(await screen.findByTestId('settings-general')).toBeTruthy();

    // 摘要来自草稿：acme/widgets 的样本是「启用 · 真写」，触发面默认 3 个别名
    expect(screen.getByTestId('repo-settings-tab-general').textContent).toContain('启用 · 真写');
    expect(screen.getByTestId('repo-settings-tab-triggers').textContent).toContain('触发人 all');
    expect(screen.getByTestId('repo-settings-tab-limits').textContent).toContain('评论 10/h');

    await user.click(screen.getByTestId('repo-settings-tab-triggers'));
    expect(await screen.findByRole('heading', { level: 1, name: '设置 · 触发' })).toBeTruthy();
    expect(await screen.findByTestId('settings-triggers')).toBeTruthy();

    await user.click(screen.getByTestId('repo-settings-tab-labels'));
    expect(await screen.findByTestId('settings-labels')).toBeTruthy();

    await user.click(screen.getByTestId('repo-settings-tab-limits'));
    expect(await screen.findByTestId('settings-limits')).toBeTruthy();

    await user.click(screen.getByTestId('repo-settings-tab-prompt'));
    expect(await screen.findByTestId('settings-prompt')).toBeTruthy();
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

    await user.click(screen.getByTestId('repo-settings-tab-triggers'));
    const guard = await screen.findByTestId('repo-settings-dirty-guard');
    expect(guard.textContent).toContain('有未保存的改动');

    await user.click(screen.getByTestId('repo-settings-dirty-stay'));
    expect(screen.getByRole('heading', { level: 1, name: '设置 · 通用' })).toBeTruthy();

    await user.click(screen.getByTestId('repo-settings-tab-triggers'));
    await user.click(await screen.findByTestId('repo-settings-dirty-discard'));
    expect(await screen.findByRole('heading', { level: 1, name: '设置 · 触发' })).toBeTruthy();
  });
});

describe('设置页 · triggers', () => {
  it('保存 payload：别名小写化 + 去重、merge_defaults、remove 全在（整份 settings）', async () => {
    const user = userEvent.setup();
    const calls = recordSettingsPut();
    renderAt('/repos/acme__widgets/settings/triggers');

    const aliasInput = await screen.findByLabelText('额外别名（aliases，1–8 个）');
    await user.type(aliasInput, '@IssueBotX');
    await user.keyboard('{Enter}');

    const chips = screen.getByTestId('triggers-aliases-chips');
    expect(chips.textContent).toContain('issuebotx');
    expect(chips.textContent).not.toContain('IssueBotX');

    await user.type(aliasInput, 'ISSUEBOTX');
    await user.keyboard('{Enter}');
    expect(await screen.findByText(/已经在列表里/u)).toBeTruthy();

    await user.click(screen.getByRole('switch', { name: '与部署默认别名并集（merge_defaults）' }));

    const removeInput = screen.getByLabelText('从并集里摘掉（remove，≤ 8 个）');
    await user.type(removeInput, '@iBot');
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('triggers-remove-chips').textContent).toContain('ibot');

    await user.click(screen.getByTestId('settings-triggers-save'));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });

    const saved = calls[0];
    expect(saved?.triggers.aliases).toEqual(['issuebotx']);
    expect(saved?.triggers.merge_defaults).toBe(false);
    expect(saved?.triggers.remove).toEqual(['ibot']);
    expect(saved?.triggers.users).toBe('all');
    expect(saved?.triggers.enabled).toBe(true);
    expect(saved?.version).toBe(1);
    expect(saved?.limits.max_comments_per_hour).toBe(10);
    expect(saved?.prompt.enabled).toBe(true);
  });

  it('命中预览 ① 命令：@issuebot /issue-triage 17 --deep', async () => {
    renderAt('/repos/acme__widgets/settings/triggers');

    const textarea = await screen.findByLabelText('粘贴一段评论正文');
    fireEvent.change(textarea, { target: { value: '@issuebot /issue-triage 17 --deep' } });

    expect(screen.getByTestId('trigger-preview-verdict').textContent).toBe('会触发');
    expect(screen.getByTestId('trigger-preview-alias').textContent).toContain('@issuebot');
    expect(screen.getByTestId('trigger-preview-kind').textContent).toContain('命令');
    expect(screen.getByTestId('trigger-preview-command').textContent).toBe('/issue-triage');
    expect(screen.getByTestId('trigger-preview-args').textContent).toBe('17 --deep');
    expect(screen.getByTestId('trigger-preview-code').textContent).toContain('没有代码区');
  });

  it('命中预览 ② 提问：@ibot 后面跟一段话 → 自由问答', async () => {
    renderAt('/repos/acme__widgets/settings/triggers');

    const textarea = await screen.findByLabelText('粘贴一段评论正文');
    fireEvent.change(textarea, { target: { value: '@ibot 这个报错的复现步骤是什么？' } });

    expect(screen.getByTestId('trigger-preview-verdict').textContent).toBe('会触发');
    expect(screen.getByTestId('trigger-preview-alias').textContent).toContain('@ibot');
    expect(screen.getByTestId('trigger-preview-kind').textContent).toContain('提问');
    expect(screen.getByTestId('trigger-preview-question').textContent).toContain('这个报错的复现步骤是什么');
    expect(screen.getByTestId('trigger-preview-command').textContent).toBe('—');
  });

  it('命中预览 ③ 代码块：@ 在围栏里 → 不触发，并列出被蒙版挡住的片段', async () => {
    renderAt('/repos/acme__widgets/settings/triggers');

    const textarea = await screen.findByLabelText('粘贴一段评论正文');
    fireEvent.change(textarea, { target: { value: '可以这么写吗？\n```\n@issuebot /issue-triage 17\n```\n' } });

    expect(screen.getByTestId('trigger-preview-verdict').textContent).toBe('不触发');
    expect(screen.getByTestId('trigger-preview-alias').textContent).toContain('没命中');
    expect(screen.getByTestId('trigger-preview-reason').textContent).toContain('代码区');
    const code = screen.getByTestId('trigger-preview-code');
    expect(code.textContent).toContain('@issuebot /issue-triage 17');
  });

  it('别名留空 = 只有部署默认；生效别名跟着 remove 变', async () => {
    const user = userEvent.setup();
    renderAt('/repos/acme__widgets/settings/triggers');

    const effective = await screen.findByTestId('triggers-effective-aliases');
    expect(effective.textContent).toContain('@issuebot');
    expect(effective.textContent).toContain('@ibot');

    const removeInput = screen.getByLabelText('从并集里摘掉（remove，≤ 8 个）');
    await user.type(removeInput, 'ibot');
    await user.keyboard('{Enter}');

    expect(screen.getByTestId('triggers-effective-aliases').textContent).not.toContain('@ibot');
  });
});

describe('设置页 · 提示词', () => {
  it('超预算：预算条转 danger、保存按钮禁用并写明原因、保存条显示超出额度', async () => {
    server.use(http.get('/api/repos/:owner/:name/prompt', () => HttpResponse.json(promptFixture('短正文', 100))));
    renderAt('/repos/acme__widgets/settings/prompt');

    const editor = await screen.findByLabelText('正文（等宽，保存为新版本）');
    expect(screen.getByTestId('prompt-budget').textContent).toContain('/ 100 字符');

    const save = screen.getByTestId('prompt-save');
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(save.getAttribute('title')).toContain('没有改动');

    fireEvent.change(editor, { target: { value: 'x'.repeat(150) } });

    expect(screen.getByTestId('prompt-budget-numbers').textContent).toContain('150 / 100');
    expect(screen.getByTestId('prompt-budget').textContent).toContain('保存被禁用');
    const blocked = screen.getByTestId('prompt-save');
    expect((blocked as HTMLButtonElement).disabled).toBe(true);
    expect(blocked.getAttribute('title')).toContain('超出预算');

    // 吸底保存条里的预算读数也跟着翻转
    expect(screen.getByTestId('settings-prompt-budget').textContent).toContain('超出预算');
  });

  it('预算内可以保存，成功后提示版本号', async () => {
    const calls: { body: string; note?: string }[] = [];
    server.use(
      http.get('/api/repos/:owner/:name/prompt', () => HttpResponse.json(promptFixture('短正文', 4_000))),
      http.put('/api/repos/:owner/:name/prompt', async ({ request }) => {
        const payload = (await request.json()) as { body: string; note?: string };
        calls.push(payload);
        return HttpResponse.json(promptFixture(payload.body, 4_000));
      }),
    );
    const user = userEvent.setup();
    renderAt('/repos/acme__widgets/settings/prompt');

    const editor = await screen.findByLabelText('正文（等宽，保存为新版本）');
    fireEvent.change(editor, { target: { value: '## 约定\n- 中文提交信息' } });
    await user.type(screen.getByLabelText('版本备注（可选，≤ 500 字）'), '补一条约定');
    await user.click(screen.getByTestId('prompt-save'));

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.body).toBe('## 约定\n- 中文提交信息');
    expect(calls[0]?.note).toBe('补一条约定');
    expect(await screen.findByTestId('prompt-save-ok')).toBeTruthy();
  });

  it('回滚要二次确认：取消不发请求，确认才 POST 版本号', async () => {
    const rolls: number[] = [];
    server.use(
      http.get('/api/repos/:owner/:name/prompt', () => HttpResponse.json(promptFixture('短正文', 4_000))),
      http.post('/api/repos/:owner/:name/prompt/rollback', async ({ request }) => {
        const payload = (await request.json()) as { version: number };
        rolls.push(payload.version);
        return HttpResponse.json(promptFixture('短正文', 4_000));
      }),
    );
    const user = userEvent.setup();
    renderAt('/repos/acme__widgets/settings/prompt');

    await screen.findByTestId('prompt-version-1');
    await user.click(screen.getByTestId('prompt-rollback-1'));

    const confirm = await screen.findByTestId('prompt-rollback-confirm-1');
    expect(confirm.textContent).toContain('确认回滚到 v1');

    await user.click(screen.getByTestId('prompt-rollback-cancel-1'));
    expect(screen.queryByTestId('prompt-rollback-confirm-1')).toBeNull();
    expect(rolls).toHaveLength(0);

    await user.click(screen.getByTestId('prompt-rollback-1'));
    await user.click(await screen.findByTestId('prompt-rollback-confirm-yes-1'));
    await waitFor(() => {
      expect(rolls).toEqual([1]);
    });
  });

  it('「预览最终 prompt」抽屉（Sheet）：全文 / 未参与层 / ref@sha 说明，Esc 关闭且焦点归还', async () => {
    server.use(http.get('/api/repos/:owner/:name/prompt', () => HttpResponse.json(promptFixture('## 约定', 4_000))));
    const user = userEvent.setup();
    renderAt('/repos/acme__widgets/settings/prompt');

    await screen.findByLabelText('正文（等宽，保存为新版本）');
    const trigger = screen.getByTestId('prompt-preview-open');
    await user.click(trigger);

    const drawer = await screen.findByTestId('prompt-preview-panel');
    expect(drawer.getAttribute('role')).toBe('dialog');
    expect(within(drawer).getByTestId('prompt-preview-text').textContent).toContain('## 约定');
    expect(within(drawer).getByTestId('prompt-preview-omitted').textContent).toContain('AGENTS.md');
    expect(drawer.textContent).toContain('ref@sha 为空');

    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('prompt-preview-panel')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});