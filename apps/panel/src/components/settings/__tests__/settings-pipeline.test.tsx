/**
 * 设置页新增的流水线面（`docs/plan-fixed-pipeline.md` §4.4 / §4.5 / §16.3）：
 *
 *  1. 「流水线」分区的 managers chips（增 / 逗号批增 / 大小写不敏感去重 / 退格删 / 空值禁用保存）；
 *  2. 四个提示词 tab + hash 持久（`#prompt/classify` 刷新仍在同一 tab）+ `#pipeline` 深链接；
 *  3. 字符计数与超限禁用（阶段 kind 用 `limit`，不是 P1 预算）；
 *  4. 「恢复默认」二次确认（取消不发请求）；
 *  5. 层序预览：`dropped` 的层要显式出现，`head`/`tail` 不可丢；agent 要标出对 P1 预算的影响；
 *  6. 标签角色下拉与覆盖提示（只提示不 400，但面板先禁用保存）。
 *
 * 数据一律走 MSW：新增字段（`limit` / `availableChars` / `layers` / `systemDefault`）由本文件的
 * fixture 给出，不依赖 mock handler 是否已跟上 `?kind=`。
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { HttpResponse, http } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_REPO_SETTINGS } from '../../../../../../packages/contract/src/index.ts';
import type { RepoSettings } from '../../../../../../packages/contract/src/index.ts';
import type { RepoSettingsResponse } from '../../../lib/contract.ts';
import type { PromptKindView } from '../use-prompt.ts';
import { createHandlers } from '../../../mocks/handlers/index.ts';
import { RepoSettingsPage } from '../../../routes/repo-settings.tsx';

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
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/* ── fixtures ─────────────────────────────────────────────────────────────── */

function promptView(patch: Partial<PromptKindView> = {}): PromptKindView {
  const body = patch.body ?? '## 约定\n- 中文提交信息';
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
      available: 4_000,
      requested: body.length,
      ok: true,
      source: 'last-assembly',
      layers: { p0: 1_000, p1: 4_000, p2Root: 2_000, p2Nearby: 1_000, p3: 1_000, p4: 1_000 },
    },
    preview: {
      text: body,
      stats: {
        baseChars: 1_000,
        promptChars: body.length,
        agentsChars: 500,
        skillChars: 200,
        totalChars: 1_700 + body.length,
        truncated: [] as string[],
      },
      omitted: [],
      ref: null,
      sha: null,
    },
    lastAssembly: null,
    kind: 'project',
    activeVersion: 2,
    isSystemDefault: false,
    limit: 4_000,
    availableChars: 4_000,
    systemDefault: '',
    layers: [
      { name: 'head', chars: 900, droppable: false, dropped: false },
      { name: 'project', chars: body.length, droppable: true, dropped: false },
      { name: 'tail', chars: 120, droppable: false, dropped: false },
    ],
    ...patch,
  } as PromptKindView;
}

function servePrompt(make: (kind: string) => PromptKindView): void {
  server.use(
    http.get('/api/repos/:owner/:name/prompt', ({ request }) => {
      const kind = new URL(request.url).searchParams.get('kind') ?? 'project';
      return HttpResponse.json(make(kind));
    }),
  );
}

function settingsView(settings: RepoSettings): RepoSettingsResponse {
  return {
    repo: 'acme/widgets',
    enabled: true,
    dryRun: false,
    settings,
    settingsValid: true,
    settingsError: null,
    source: 'installation',
    installationId: '12345678',
    archivedAt: null,
  };
}

function serveSettings(patch: (current: RepoSettings) => RepoSettings): void {
  server.use(
    http.get('/api/repos/:owner/:name/settings', () => HttpResponse.json(settingsView(patch(DEFAULT_REPO_SETTINGS)))),
  );
}

/* ── 流水线分区 · 管理人员 ──────────────────────────────────────────────────── */

describe('设置页 · 流水线分区', () => {
  it('缓存命中前先渲染出 managers chips（mock 的 alice / bob），每个都能移除', async () => {
    const user = userEvent.setup();
    renderAt('/repos/acme__widgets/settings/pipeline');

    const chips = await screen.findByTestId('pipeline-managers-chips');
    await waitFor(() => {
      expect(chips.textContent).toContain('alice');
    });
    expect(chips.textContent).toContain('bob');

    await user.click(within(chips).getByRole('button', { name: '移除 alice' }));
    expect(chips.textContent).not.toContain('alice');
    expect(chips.textContent).toContain('bob');
  });

  it('回车添加、逗号批量添加、大小写不敏感去重、退格删最后一个', async () => {
    const user = userEvent.setup();
    renderAt('/repos/acme__widgets/settings/pipeline');

    const input = await screen.findByLabelText('管理人员（GitHub login）');
    const chips = screen.getByTestId('pipeline-managers-chips');
    await waitFor(() => {
      expect(chips.textContent).toContain('alice');
    });

    await user.type(input, 'Carol{Enter}');
    expect(chips.textContent).toContain('Carol');

    // 逗号 = 批量提交
    await user.type(input, 'dave,erin,');
    await waitFor(() => {
      expect(chips.textContent).toContain('dave');
    });
    expect(chips.textContent).toContain('erin');

    // 大小写不敏感去重：ALICE 与 alice 是同一个 login
    await user.type(input, 'ALICE{Enter}');
    expect(await screen.findByText(/已经在名单里/u)).toBeTruthy();

    // 输入框为空时退格删最后一个（erin 是最后加进去的）
    await user.click(input);
    await user.keyboard('{Backspace}');
    await waitFor(() => {
      expect(chips.textContent).not.toContain('erin');
    });
  });

  it('管理人员清空后：保存禁用 + title 说明原因', async () => {
    const user = userEvent.setup();
    serveSettings((current) => ({ ...current, pipeline: { ...current.pipeline, managers: ['alice'] } }));
    renderAt('/repos/acme__widgets/settings/pipeline');

    const chips = await screen.findByTestId('pipeline-managers-chips');
    await waitFor(() => {
      expect(chips.textContent).toContain('alice');
    });
    await user.click(within(chips).getByRole('button', { name: '移除 alice' }));

    const save = await screen.findByTestId('settings-pipeline-save');
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(save.getAttribute('title')).toBe('流水线需要至少一个管理人员');
    expect(screen.getByTestId('pipeline-managers-chips').textContent).toContain('服务端会拒收');
  });

  it('系统常量只读区：五个数字都在，且带「只读」徽章', async () => {
    renderAt('/repos/acme__widgets/settings/pipeline');

    const format = await screen.findByTestId('pipeline-constant-PIPELINE_FORMAT_MAX_FAILS');
    expect(format.textContent).toContain('5 次');
    expect(screen.getByTestId('pipeline-constant-PIPELINE_CLOSE_AFTER_HOURS').textContent).toContain('48 小时');
    expect(screen.getByTestId('pipeline-constant-SESSION_MAX_TURNS').textContent).toContain('30');
    expect(screen.getByTestId('pipeline-constant-SESSION_MAX_AGE').textContent).toContain('7 天');
    expect(screen.getByTestId('pipeline-constant-评论冷却').textContent).toContain('120 秒');
    expect(screen.getByText('只读')).toBeTruthy();
  });

  it('缺标签角色时给一行 warn + 去标签分区的链接；齐了就不显示', async () => {
    serveSettings((current) => ({ ...current, labels: { ...current.labels, vocabulary: [] } }));
    renderAt('/repos/acme__widgets/settings/pipeline');

    const coverage = await screen.findByTestId('pipeline-label-coverage');
    expect(coverage.textContent).toContain('缺少标签角色：需求、缺陷');
    expect(screen.getByTestId('pipeline-label-coverage-link').getAttribute('href')).toContain('/settings/labels');
  });
});

/* ── 提示词分区 · 四个 tab + hash ─────────────────────────────────────────── */

describe('设置页 · 提示词四个 kind', () => {
  it('hash 决定默认 tab：`#prompt/format_check` 刷新后仍是格式检查', async () => {
    servePrompt((kind) => promptView({ kind: kind as PromptKindView['kind'], systemDefault: '格式模板', isSystemDefault: true }));
    renderAt('/repos/acme__widgets/settings/prompt#prompt/format_check');

    expect(await screen.findByTestId('prompt-panel-format_check')).toBeTruthy();
    expect(screen.getByRole('tab', { name: '格式检查' }).getAttribute('aria-selected')).toBe('true');
    expect((await screen.findByTestId('prompt-system-default')).textContent).toContain('格式模板');
  });

  it('点 tab 切到「分类」：面板换、hash 记在地址上、别的 tab 的正文草稿不丢', async () => {
    const user = userEvent.setup();
    servePrompt((kind) => promptView({ kind: kind as PromptKindView['kind'] }));
    renderAt('/repos/acme__widgets/settings/prompt');

    const editor = await screen.findByLabelText('正文（等宽，保存为新版本）');
    fireEvent.change(editor, { target: { value: '项目约定草稿' } });

    await user.click(screen.getByRole('tab', { name: '分类' }));
    expect(await screen.findByTestId('prompt-panel-classify')).toBeTruthy();

    await user.click(screen.getByRole('tab', { name: '项目约定' }));
    expect(await screen.findByTestId('prompt-panel-project')).toBeTruthy();
    expect((screen.getByLabelText('正文（等宽，保存为新版本）') as HTMLTextAreaElement).value).toBe('项目约定草稿');
  });

  it('`#pipeline` 与路径不一致时深链接到流水线分区（刷新不丢）', async () => {
    renderAt('/repos/acme__widgets/settings/general#pipeline');
    expect(await screen.findByRole('heading', { level: 1, name: '设置 · 流水线' })).toBeTruthy();
    expect(await screen.findByTestId('settings-pipeline')).toBeTruthy();
  });

  it('字符计数 + 超限禁用（阶段 kind 用 limit，不是 P1 预算）', async () => {
    servePrompt((kind) => promptView({ kind: kind as PromptKindView['kind'], body: 'abc', limit: 20, availableChars: 20 }));
    renderAt('/repos/acme__widgets/settings/prompt#prompt/classify');

    const editor = await screen.findByLabelText('正文（等宽，保存为新版本）');
    const count = screen.getByTestId('prompt-body-count');
    expect(count.textContent).toContain('3 字符');
    expect(count.textContent).toContain('上限 20');

    fireEvent.change(editor, { target: { value: 'x'.repeat(21) } });
    expect(screen.getByTestId('prompt-body-count').textContent).toContain('21 字符');
    expect(screen.getByTestId('prompt-body-count').className).toContain('text-danger-fg');

    const save = screen.getByTestId('prompt-save');
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(save.getAttribute('title')).toContain('超出上限');
  });

  it('恢复默认要二次确认：取消不发请求，确认才 POST …/prompt/restore?kind=', async () => {
    const user = userEvent.setup();
    const restores: string[] = [];
    servePrompt((kind) => promptView({ kind: kind as PromptKindView['kind'] }));
    server.use(
      http.post('/api/repos/:owner/:name/prompt/restore', ({ request }) => {
        restores.push(new URL(request.url).search);
        return HttpResponse.json(promptView({ kind: 'agent', activeVersion: 0, version: 0, isSystemDefault: true, body: '', present: false }));
      }),
    );
    renderAt('/repos/acme__widgets/settings/prompt#prompt/agent');

    const restore = await screen.findByTestId('prompt-restore');
    await waitFor(() => {
      expect((restore as HTMLButtonElement).disabled).toBe(false);
    });
    await user.click(restore);

    const confirm = await screen.findByTestId('prompt-restore-confirm');
    expect(confirm.textContent).toContain('指针回 v0');
    await user.click(screen.getByTestId('prompt-restore-cancel'));
    expect(screen.queryByTestId('prompt-restore-confirm')).toBeNull();
    expect(restores).toHaveLength(0);

    await user.click(screen.getByTestId('prompt-restore'));
    await user.click(await screen.findByTestId('prompt-restore-confirm-yes'));
    await waitFor(() => {
      expect(restores).toEqual(['?kind=agent']);
    });
    expect(await screen.findByTestId('prompt-restore-ok')).toBeTruthy();
  });

  it('层序预览：dropped 的层显式列出，head / tail 标成不可丢', async () => {
    servePrompt((kind) =>
      promptView({
        kind: kind as PromptKindView['kind'],
        body: 'x',
        layers: [
          { name: 'head', chars: 900, droppable: false, dropped: false },
          { name: 'project', chars: 0, droppable: true, dropped: true },
          { name: 'tail', chars: 120, droppable: false, dropped: false },
        ],
      }),
    );
    renderAt('/repos/acme__widgets/settings/prompt#prompt/classify');

    const head = await screen.findByTestId('prompt-layers-classify-layer-head');
    expect(head.getAttribute('data-droppable')).toBe('false');
    expect(head.textContent).toContain('不可丢');

    const tail = screen.getByTestId('prompt-layers-classify-layer-tail');
    expect(tail.textContent).toContain('输出契约');

    const project = screen.getByTestId('prompt-layers-classify-layer-project');
    expect(project.getAttribute('data-dropped')).toBe('true');

    const discarded = screen.getByTestId('prompt-layers-classify-discarded');
    expect(discarded.textContent).toContain('已丢弃');
    expect(discarded.textContent).toContain('项目约定');
  });

  it('agent tab 显示它对 P1 预算的影响（V18）', async () => {
    servePrompt((kind) =>
      promptView({
        kind: kind as PromptKindView['kind'],
        availableChars: 2_000,
        limit: 4_000,
        layers: [
          { name: 'head', chars: 3_900, droppable: false, dropped: false },
          { name: 'tail', chars: 120, droppable: false, dropped: false },
        ],
      } as Partial<PromptKindView>),
    );
    renderAt('/repos/acme__widgets/settings/prompt#prompt/agent');

    const impact = await screen.findByTestId('prompt-layers-agent-agent-budget');
    expect(impact.textContent).toContain('计入 baseChars');
    expect(impact.textContent).toContain('P1 可存 4,000 字符');
  });
});

/* ── 标签分区 · 角色列 ───────────────────────────────────────────────────── */

describe('设置页 · 标签角色', () => {
  it('角色下拉把词条改成「需求」，覆盖提示消失后保存可用', async () => {
    const user = userEvent.setup();
    serveSettings((current) => ({
      ...current,
      labels: {
        ...current.labels,
        vocabulary: [
          { name: '需求', role: 'other' },
          { name: '缺陷', role: 'defect' },
        ],
      },
    }));
    renderAt('/repos/acme__widgets/settings/labels');

    const roleSelect = await screen.findByLabelText('词表第 1 条的角色');
    expect((roleSelect as HTMLSelectElement).value).toBe('other');

    // 缺「需求」角色：给一行提示，保存禁用并写明原因
    expect(screen.getByTestId('labels-role-coverage').textContent).toContain('分类需要至少一个需求标签与一个缺陷标签');
    const blocked = screen.getByTestId('settings-labels-save');
    expect((blocked as HTMLButtonElement).disabled).toBe(true);
    expect(blocked.getAttribute('title')).toBe('分类需要至少一个需求标签与一个缺陷标签');

    await user.selectOptions(roleSelect, 'requirement');
    await waitFor(() => {
      expect(screen.queryByTestId('labels-role-coverage')).toBeNull();
    });
    const save = screen.getByTestId('settings-labels-save');
    expect((save as HTMLButtonElement).disabled).toBe(false);
  });

  it('新增词表项默认 role=other（契约必填，不能留空）', async () => {
    const user = userEvent.setup();
    serveSettings((current) => ({ ...current, labels: { ...current.labels, vocabulary: [] } }));
    renderAt('/repos/acme__widgets/settings/labels');

    await user.click(await screen.findByTestId('labels-vocab-add'));
    const roleSelect = await screen.findByLabelText('词表第 1 条的角色');
    expect((roleSelect as HTMLSelectElement).value).toBe('other');
  });
});
