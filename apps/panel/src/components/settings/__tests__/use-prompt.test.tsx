/**
 * `usePromptResource` 与提示词面板的**按 kind 取数**契约。
 *
 * 三件事（都在这一层才看得见）：
 *  1. **一个 hook 只取自己那一份**：请求带 `?kind=`，缓存键按 kind 分开（四个 tab 不互相盖）；
 *  2. **mock 的四个 fixture 各不一样**（`project` v2 / `format_check` 系统默认 / `classify` v2 /
 *     `agent` v1），所以「切 tab 后数据变了」可以被断言，而不是靠肉眼看；
 *  3. **保存期的三种 400 要能在面板上读出中文文案**：`details.code` →
 *     `placeholder-missing` / `placeholder-unknown` / `body-too-long` 三条路径都走真实的 mock handler。
 *
 * 第 3 组刻意用**真实 mock**（`createHandlers()`）而不是本文件的临时 handler：
 * 「mock 的校验规则和面板的文案对得上」本身就是要守住的东西。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHandlers } from '../../../mocks/handlers/index.ts';
import { RepoSettingsPage } from '../../../routes/repo-settings.tsx';
import type { PromptResponse } from '../../../lib/contract.ts';
import { promptQueryKey, usePromptResource } from '../use-prompt.ts';

const REPO = 'acme/widgets';

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

/* ── 工具 ─────────────────────────────────────────────────────────────────── */

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false, gcTime: 0 } } });
}

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

/** 一个 kind 的最小视图（只给「按 kind 取数」这件事需要的字段）。 */
function stubView(kind: string, version: number): PromptResponse {
  return {
    repo: REPO,
    kind: kind as PromptResponse['kind'],
    kinds: ['project', 'format_check', 'classify', 'agent'],
    enabled: true,
    version,
    activeVersion: version,
    present: true,
    body: `${kind} 正文`,
    systemDefault: '',
    isSystemDefault: false,
    limit: 8_000,
    availableChars: 8_000,
    versions: [],
    budget: {
      budgetChars: 12_000,
      p1Cap: 4_000,
      otherLayersChars: 8_000,
      available: 4_000,
      requested: 10,
      ok: true,
      source: 'last-assembly',
      layers: { p0: 0, p1: 10, p2Root: 0, p2Nearby: 0, p3: 0, p4: 0 },
    },
    layers: [{ name: 'head', chars: 900, droppable: false, dropped: false }],
    preview: {
      text: 'x',
      stats: { baseChars: 900, promptChars: 0, agentsChars: 0, skillChars: 0, totalChars: 1_320, truncated: [] },
      omitted: [],
      ref: null,
      sha: null,
    },
    lastAssembly: null,
  };
}

/* ── 1. 一个 hook 只取自己那一份 ───────────────────────────────────────────── */

describe('usePromptResource · 按 kind 取数', () => {
  it('请求带 `?kind=`，四个 kind 各自一份缓存', async () => {
    const client = makeClient();
    const kinds: string[] = [];
    server.use(
      http.get('/api/repos/:owner/:name/prompt', ({ request }) => {
        const kind = new URL(request.url).searchParams.get('kind') ?? 'project';
        kinds.push(kind);
        return HttpResponse.json(stubView(kind, kind === 'classify' ? 2 : 1));
      }),
    );

    const classify = renderHook(() => usePromptResource(REPO, 'classify'), { wrapper: wrapperFor(client) });
    await waitFor(() => {
      expect(classify.result.current.query.data?.kind).toBe('classify');
    });

    const project = renderHook(() => usePromptResource(REPO, 'project'), { wrapper: wrapperFor(client) });
    await waitFor(() => {
      expect(project.result.current.query.data?.kind).toBe('project');
    });

    expect(kinds).toEqual(['classify', 'project']);
    // 两份缓存各自独立：classify 是 v2、project 是 v1，没有互相覆盖
    expect(client.getQueryData<PromptResponse>(promptQueryKey(REPO, 'classify'))?.activeVersion).toBe(2);
    expect(client.getQueryData<PromptResponse>(promptQueryKey(REPO, 'project'))?.activeVersion).toBe(1);
  });

  it('保存走 `PUT …/prompt?kind=`：响应写回自己的缓存，并把别的 kind 标脏重取', async () => {
    const client = makeClient();
    const puts: string[] = [];
    const gets: string[] = [];
    server.use(
      http.get('/api/repos/:owner/:name/prompt', ({ request }) => {
        const kind = new URL(request.url).searchParams.get('kind') ?? 'project';
        gets.push(kind);
        return HttpResponse.json(stubView(kind, 1));
      }),
      http.put('/api/repos/:owner/:name/prompt', async ({ request }) => {
        const kind = new URL(request.url).searchParams.get('kind') ?? 'project';
        puts.push(kind);
        const payload = (await request.json()) as { body: string };
        return HttpResponse.json({ ...stubView(kind, 9), body: payload.body });
      }),
    );

    const classify = renderHook(() => usePromptResource(REPO, 'classify'), { wrapper: wrapperFor(client) });
    const project = renderHook(() => usePromptResource(REPO, 'project'), { wrapper: wrapperFor(client) });
    await waitFor(() => {
      expect(classify.result.current.query.data?.activeVersion).toBe(1);
      expect(project.result.current.query.data?.activeVersion).toBe(1);
    });

    await classify.result.current.save.mutateAsync({ body: '新正文', note: undefined });

    expect(puts).toEqual(['classify']);
    expect(client.getQueryData<PromptResponse>(promptQueryKey(REPO, 'classify'))?.activeVersion).toBe(9);
    // `agent` / 阶段 kind 会改别人的可用额度：别的 kind 被标脏 → 自动重取
    await waitFor(() => {
      expect(gets.filter((kind) => kind === 'project')).toHaveLength(2);
    });
  });
});

/* ── 2. mock 的四份 fixture 各不一样 ───────────────────────────────────────── */

describe('mock 的四个 kind fixture', () => {
  async function viewOf(kind: 'project' | 'format_check' | 'classify' | 'agent'): Promise<PromptResponse> {
    const client = makeClient();
    const hook = renderHook(() => usePromptResource(REPO, kind), { wrapper: wrapperFor(client) });
    await waitFor(() => {
      expect(hook.result.current.query.data?.kind).toBe(kind);
    });
    const data = hook.result.current.query.data;
    if (data === undefined) throw new Error(`没有读到 ${kind} 的视图`);
    return data;
  }

  it('project：v2 项目版，有 project 层，head / tail 不可丢', async () => {
    const view = await viewOf('project');

    expect(view.activeVersion).toBe(2);
    expect(view.isSystemDefault).toBe(false);
    expect(view.limit).toBe(4_000);
    expect(view.systemDefault).toBe('');
    expect(view.body).toContain('项目约定');
    expect(view.layers?.map((layer) => layer.name)).toContain('project');
    for (const layer of view.layers ?? []) {
      if (layer.name === 'head' || layer.name === 'tail') expect(layer.droppable).toBe(false);
    }
  });

  it('format_check：系统默认（指针 v0、无项目版本），只读默认正文带必填占位符', async () => {
    const view = await viewOf('format_check');

    expect(view.activeVersion).toBe(0);
    expect(view.present).toBe(false);
    expect(view.isSystemDefault).toBe(true);
    expect(view.body).toBe('');
    expect(view.systemDefault).toContain('{{title}}');
    expect(view.systemDefault).toContain('{{body}}');
    expect(view.limit).toBe(8_000);
    // 阶段 kind 没有 project 层（项目版整体覆盖 head，不与默认拼接）
    expect(view.layers?.map((layer) => layer.name)).toEqual(['head', 'tail']);
  });

  it('classify：v2 项目版，上限 8000（不是 P1 预算）', async () => {
    const view = await viewOf('classify');

    expect(view.activeVersion).toBe(2);
    expect(view.isSystemDefault).toBe(false);
    expect(view.limit).toBe(8_000);
    expect(view.body).toContain('除了通用判据');
    expect(view.availableChars).toBe(8_000 - view.body.length);
  });

  it('agent：v1 项目版，上限 4000（它计入 baseChars，写多长就扣 P1 多少）', async () => {
    const view = await viewOf('agent');

    expect(view.activeVersion).toBe(1);
    expect(view.limit).toBe(4_000);
    expect(view.body).toContain('迁移');
    expect(view.availableChars).toBe(4_000 - view.body.length);
  });
});

/* ── 3. 三种 400 经面板显示对应文案 ────────────────────────────────────────── */

describe('提示词面板 · 保存期 400 的错误文案', () => {
  function renderAt(path: string): void {
    const client = makeClient();
    window.history.replaceState({}, '', path);
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/repos/:repo/settings/:section" element={<RepoSettingsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('format_check 缺 {{title}} / {{body}}：显示「格式检查必须包含 …」', async () => {
    const user = userEvent.setup();
    renderAt('/repos/acme__widgets/settings/prompt#prompt/format_check');

    const editor = await screen.findByLabelText('正文（等宽，保存为新版本）');
    fireEvent.change(editor, { target: { value: '只写判据，一个占位符都没有。' } });
    await user.click(screen.getByTestId('prompt-save'));

    const error = await screen.findByTestId('prompt-save-error');
    expect(error.textContent).toContain('格式检查必须包含 {{title}} 与 {{body}}');
  });

  it('未知占位符：显示「未知占位符：{{nope}}」', async () => {
    const user = userEvent.setup();
    renderAt('/repos/acme__widgets/settings/prompt#prompt/classify');

    const editor = await screen.findByLabelText('正文（等宽，保存为新版本）');
    fireEvent.change(editor, { target: { value: '【补充】{{nope}} 这个占位符不存在。' } });
    await user.click(screen.getByTestId('prompt-save'));

    const error = await screen.findByTestId('prompt-save-error');
    expect(error.textContent).toContain('未知占位符：{{nope}}');
  });

  it('超上限：面板显示「超出 8,000 字符」（服务端 400 body-too-long）', async () => {
    const user = userEvent.setup();
    // 面板缓存里的上限可能是旧的（另一个 tab 改过配置），所以这里把 GET 报的上限放大，
    // 让保存按钮可用 —— 真正拒收的是服务端的 `body-too-long`。
    const base = (await fetch('/api/repos/acme/widgets/prompt?kind=format_check').then((response) =>
      response.json(),
    )) as PromptResponse;
    server.use(
      http.get('/api/repos/:owner/:name/prompt', () =>
        HttpResponse.json({ ...base, limit: 20_000, availableChars: 20_000 }),
      ),
    );

    renderAt('/repos/acme__widgets/settings/prompt#prompt/format_check');
    const editor = await screen.findByLabelText('正文（等宽，保存为新版本）');
    fireEvent.change(editor, { target: { value: `{{title}}{{body}}${'x'.repeat(9_000)}` } });
    await user.click(screen.getByTestId('prompt-save'));

    const error = await screen.findByTestId('prompt-save-error');
    expect(error.textContent).toContain('超出 8,000 字符');
  });
});
