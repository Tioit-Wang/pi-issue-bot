/**
 * 全局设置 · 模型配置的**写入面**（`CFG-8.1` / `CFG-8.2` / `AC-32`）。
 *
 * 断言的是「请求体形状」与「保存之后界面读到的值」，不是像素：
 *
 * - 供应商保存只发**要改的字段**；key 三态互斥（不填 = 保持不变 / 填了 = 换新 / 勾选 = 清空），
 *   这是需求 §6.8 点名的那个坑（「没传」与「传空」必须能区分），所以每种都单独断言请求体；
 * - 清空 key 之后页面上不能还留着明文（面板从不持有真值，这里顺带把「回显」也测掉）；
 * - 连通性测试失败也回 200：状态点按 body 画，只有请求被拒才进错误分支；
 * - 执行模型绑定只发 `{ provider_id, model }`，且下拉选项来自该供应商的目录（服务端会拒目录外的模型）；
 * - 服务端 400 必须在表单里说清原因（不静默失败）。
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { HttpResponse, http } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { createHandlers } from '../src/mocks/handlers/index.ts';
import { AppRoutes } from '../src/routes.tsx';
import type {
  ModelProvider,
  ModelSetting,
  SaveModelProviderRequest,
  SaveModelRequest,
} from '../src/lib/contract.ts';

const server = setupServer(...createHandlers());

const REPOS = {
  repos: [
    {
      repo: 'acme/widgets',
      enabled: true,
      dryRun: true,
      settingsValid: true,
      archivedAt: null,
      lastActivityAt: null,
    },
  ],
};

/** 供应商夹具：一家有 key（anthropic）、一家没有 key（local，便于测「填新 key」）。 */
function providerFixture(): ModelProvider[] {
  return [
    {
      id: 'anthropic',
      name: 'Anthropic',
      base_url: 'https://api.anthropic.com/v1',
      key_configured: true,
      key_mask: 'sk-a…7f21',
      models: [
        {
          model: 'claude-opus-4',
          price: { input_usd_per_mtok: 15, output_usd_per_mtok: 75 },
          // 已知参数：chip 显示「上下文 200K · 输出 8K」；「查参数」时这一行要算「已有值，跳过」
          context_window: 200_000,
          max_output_tokens: 8_192,
        },
        { model: 'deepseek-v4.1-flash', price: { input_usd_per_mtok: 0.05, output_usd_per_mtok: 0.2 } },
      ],
      enabled: true,
      status: 'ok',
      latency_ms: 412,
      checked_at: '2026-06-01T11:58:00.000Z',
      check_error: null,
      updated_at: '2026-05-30T09:00:00.000Z',
    },
    {
      id: 'local',
      name: '自建端点',
      base_url: 'http://10.0.0.7:8000/v1',
      key_configured: false,
      key_mask: null,
      models: [],
      enabled: true,
      status: 'unknown',
      latency_ms: null,
      checked_at: null,
      check_error: null,
      updated_at: null,
    },
  ];
}

/** 执行模型夹具：默认已配好（anthropic / claude-opus-4），用例可按需改成「未配置」。 */
function modelSettingFixture(): ModelSetting {
  return {
    configured: true,
    provider_id: 'anthropic',
    provider_name: 'Anthropic',
    model: 'claude-opus-4',
    price: { input_usd_per_mtok: 15, output_usd_per_mtok: 75 },
    updated_at: '2026-05-30T09:00:00.000Z',
  };
}

let providers: ModelProvider[] = providerFixture();
let modelSetting: ModelSetting = modelSettingFixture();
/** 最近一次写请求体（断言用；每个用例开头置空）。 */
let lastProviderBody: SaveModelProviderRequest | null = null;
let lastModelBody: SaveModelRequest | null = null;
let checkCalls = 0;

/** 读接口一律回本地状态：写完之后 `invalidate` 的重取才能看到变化。 */
function useSettingsReads(): void {
  server.use(
    http.get('/api/repos', () => HttpResponse.json(REPOS)),
    http.get('/api/settings/providers', () => HttpResponse.json({ items: providers })),
    http.get('/api/settings/model', () => HttpResponse.json(modelSetting)),
  );
}

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
});
afterAll(() => {
  server.close();
});
beforeEach(() => {
  providers = providerFixture();
  modelSetting = modelSettingFixture();
  lastProviderBody = null;
  lastModelBody = null;
  checkCalls = 0;
  useSettingsReads();
});
afterEach(() => {
  server.resetHandlers();
});

function renderApp(path = '/system'): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false, gcTime: 0 } },
  });
  window.history.replaceState({}, '', path);
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('供应商写入（CFG-8.1）', () => {
  it('改 base URL + 填新 key：只发改了的那几个字段，保存后行内读回新值', async () => {
    const user = userEvent.setup();
    server.use(
      http.put('/api/settings/providers/:id', async ({ request, params }) => {
        lastProviderBody = (await request.json()) as SaveModelProviderRequest;
        const at = providers.findIndex((item) => item.id === String(params['id']));
        providers[at] = {
          ...providers[at],
          base_url: lastProviderBody.base_url ?? null,
          key_configured: true,
          key_mask: 'sk-t…3456',
        } as ModelProvider;
        return HttpResponse.json(providers[at]);
      }),
    );

    renderApp();
    const page = await screen.findByTestId('system-page');
    const row = await within(page).findByTestId('system-provider-local');
    expect(row.textContent).toContain('key 未配置');

    await user.click(within(row).getByTestId('system-provider-edit-local'));
    const form = await screen.findByTestId('system-provider-form');

    const baseUrl = within(form).getByLabelText('base URL（留空 = pi-host 默认端点）');
    await user.clear(baseUrl);
    await user.type(baseUrl, 'https://new.example/v1');
    await user.type(within(form).getByLabelText('key'), 'sk-test-123456');
    await user.click(within(form).getByTestId('system-provider-save'));

    await waitFor(() => {
      expect(lastProviderBody).not.toBeNull();
    });
    // 只发改了的字段：没传 `clear_key`（否则等于顺手把 key 抹掉）
    expect(lastProviderBody?.base_url).toBe('https://new.example/v1');
    expect(lastProviderBody?.key).toBe('sk-test-123456');
    expect(lastProviderBody?.clear_key).toBeUndefined();
    // 名称没改也带上（服务端「未传 = 原样保留」，带上不会误伤），但目录/启用保持原值
    expect(lastProviderBody?.models).toEqual([]);
    expect(lastProviderBody?.enabled).toBe(true);

    // 重取之后：行内显示新 baseURL 与新掩码，且明文 key 一个字都不留在页面上
    await waitFor(() => {
      expect(screen.getByTestId('system-provider-local').textContent).toContain('https://new.example/v1');
    });
    expect(screen.getByTestId('system-provider-key-local').textContent).toContain('sk-t…3456');
    expect(screen.queryByDisplayValue('sk-test-123456')).toBeNull();
  });

  it('勾「清空已存的 key」：请求体带 clear_key 且不带 key（两件事不能同时给）', async () => {
    const user = userEvent.setup();
    server.use(
      http.put('/api/settings/providers/:id', async ({ request }) => {
        lastProviderBody = (await request.json()) as SaveModelProviderRequest;
        providers[0] = { ...providers[0], key_configured: false, key_mask: null } as ModelProvider;
        return HttpResponse.json(providers[0]);
      }),
    );

    renderApp();
    const page = await screen.findByTestId('system-page');
    const row = await within(page).findByTestId('system-provider-anthropic');
    await user.click(within(row).getByTestId('system-provider-edit-anthropic'));

    const form = await screen.findByTestId('system-provider-form');
    await user.click(within(form).getByLabelText('清空已存的 key'));
    // 勾了清空就不许再填新 key（输入框被禁用），避免「到底想清还是想换」的猜测
    expect((within(form).getByLabelText('key（留空 = 保持现有）') as HTMLInputElement).disabled).toBe(true);
    await user.click(within(form).getByTestId('system-provider-save'));

    await waitFor(() => {
      expect(lastProviderBody).not.toBeNull();
    });
    expect(lastProviderBody?.clear_key).toBe(true);
    expect(lastProviderBody?.key).toBeUndefined();

    await waitFor(() => {
      expect(screen.getByTestId('system-provider-key-anthropic').textContent).toContain('key 未配置');
    });
  });

  it('测连通性：打 POST，行内状态点换成这次的结果（失败也回 200 不当错误）', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/settings/providers/:id/check', () => {
        checkCalls += 1;
        return HttpResponse.json({
          provider_id: 'local',
          status: 'fail',
          latency_ms: null,
          checked_at: '2026-06-01T12:00:00.000Z',
          error: '连接被拒绝：ECONNREFUSED 10.0.0.7:8000',
          models: null,
        });
      }),
    );

    renderApp();
    const page = await screen.findByTestId('system-page');
    const row = await within(page).findByTestId('system-provider-local');
    await user.click(within(row).getByTestId('system-provider-check-local'));

    await waitFor(() => {
      expect(checkCalls).toBe(1);
    });
    // 200 + status:'fail' → 行内说「不通」+ 原因，不弹保存失败
    await waitFor(() => {
      const status = screen.getByTestId('system-provider-status-local');
      expect(status.textContent).toContain('不通');
      expect(status.textContent).toContain('刚测于');
    });
    expect(screen.getByTestId('system-provider-local').textContent).toContain('ECONNREFUSED');
    expect(screen.queryByTestId('system-provider-check-error-local')).toBeNull();
  });

  it('请求被拒（400）必须在表单里说清原因，不静默', async () => {
    const user = userEvent.setup();
    server.use(
      http.put('/api/settings/providers/:id', () =>
        HttpResponse.json(
          {
            error: {
              code: 'bad-request',
              message: 'key 与 clear_key 不能同时给',
              details: { issues: ['key'] },
            },
          },
          { status: 400 },
        ),
      ),
    );

    renderApp();
    const page = await screen.findByTestId('system-page');
    const row = await within(page).findByTestId('system-provider-local');
    await user.click(within(row).getByTestId('system-provider-edit-local'));
    const form = await screen.findByTestId('system-provider-form');
    await user.type(within(form).getByLabelText('key'), 'sk-test-123456');
    await user.click(within(form).getByTestId('system-provider-save'));

    const failure = await screen.findByTestId('system-provider-form-error');
    expect(failure.textContent).toContain('保存供应商失败');
    expect(failure.textContent).toContain('key 与 clear_key 不能同时给');
    // 表单还开着：失败不该把用户填的东西一起收走
    expect(screen.getByTestId('system-provider-form')).toBeTruthy();
  });
});

describe('执行模型写入（CFG-8.2）', () => {
  it('选供应商 + 模型后保存：只发 { provider_id, model }，单价随目录重算', async () => {
    const user = userEvent.setup();
    server.use(
      http.put('/api/settings/model', async ({ request }) => {
        lastModelBody = (await request.json()) as SaveModelRequest;
        const provider = providers.find((item) => item.id === lastModelBody?.provider_id);
        const entry = provider?.models.find((item) => item.model === lastModelBody?.model);
        modelSetting = {
          configured: true,
          provider_id: lastModelBody.provider_id,
          provider_name: provider?.name ?? null,
          model: lastModelBody.model,
          price: entry?.price ?? null,
          updated_at: '2026-06-01T12:00:00.000Z',
        };
        return HttpResponse.json({ ok: true });
      }),
    );

    renderApp();
    const page = await screen.findByTestId('system-page');
    const block = await within(page).findByTestId('system-model-setting');
    // 只读行先说清「现在用的是哪个模型」
    expect(block.textContent).toContain('claude-opus-4');
    expect(block.textContent).toContain('$15');

    await user.click(within(block).getByTestId('system-model-edit'));
    const form = await within(page).findByTestId('system-model-form');

    // 供应商下拉来自清单
    await user.click(within(form).getByTestId('system-model-provider'));
    await user.click(await screen.findByRole('option', { name: /Anthropic（anthropic）/ }));

    // 模型下拉来自该供应商的目录（不是自由输入）
    await user.click(within(form).getByTestId('system-model-model'));
    await user.click(await screen.findByRole('option', { name: /deepseek-v4\.1-flash/ }));

    await user.click(within(form).getByTestId('system-model-save'));

    await waitFor(() => {
      expect(lastModelBody).not.toBeNull();
    });
    expect(lastModelBody).toEqual({ provider_id: 'anthropic', model: 'deepseek-v4.1-flash' });

    // 保存后：读视图换成新模型，单价跟着目录算出来
    await waitFor(() => {
      const saved = screen.getByTestId('system-model-setting');
      expect(saved.textContent).toContain('deepseek-v4.1-flash');
      expect(saved.textContent).toContain('$0.05');
    });
  });

  it('未配置时显示「未配置」；没选完模型时保存按钮禁用，并说明原因', async () => {
    const user = userEvent.setup();
    modelSetting = {
      configured: false,
      provider_id: null,
      provider_name: null,
      model: null,
      price: null,
      updated_at: null,
    };
    renderApp();
    const page = await screen.findByTestId('system-page');
    const block = await within(page).findByTestId('system-model-setting');
    // 没配也看得见：不隐藏、不写 0
    expect(block.textContent).toContain('未配置');

    await user.click(within(block).getByTestId('system-model-edit'));
    const form = await within(page).findByTestId('system-model-form');

    await user.click(within(form).getByTestId('system-model-provider'));
    await user.click(await screen.findByRole('option', { name: /Anthropic（anthropic）/ }));

    const save = within(form).getByTestId('system-model-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.getAttribute('title')).toBe('先选供应商与模型');
  });
});

describe('查参数（CFG-8.1 模型目录扩展）', () => {
  it('只回填空格子并说清来源；保存时带上上下文窗口与最大输出', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/settings/providers/:id/models/lookup', () =>
        HttpResponse.json({
          items: [
            {
              model: 'claude-opus-4',
              found: true,
              context_window: 200_000,
              max_output_tokens: 8_192,
              source: 'openrouter',
              matched_id: 'anthropic/claude-opus-4',
              error: null,
            },
            {
              model: 'deepseek-v4.1-flash',
              found: true,
              context_window: 1_048_576,
              max_output_tokens: 393_216,
              source: 'openrouter',
              matched_id: 'deepseek/deepseek-v4.1-flash',
              error: null,
            },
          ],
          fetched: 'openrouter',
          note: null,
        }),
      ),
      http.put('/api/settings/providers/:id', async ({ request }) => {
        lastProviderBody = (await request.json()) as SaveModelProviderRequest;
        return HttpResponse.json(providers[0]);
      }),
    );

    renderApp();
    const page = await screen.findByTestId('system-page');
    const row = await within(page).findByTestId('system-provider-anthropic');
    // 已知参数在只读行上就能看到（不用展开）
    expect(within(row).getByTestId('system-provider-limits-anthropic-claude-opus-4').textContent).toBe(
      '上下文 200K · 输出 8K',
    );

    await user.click(within(row).getByTestId('system-provider-edit-anthropic'));
    const form = await screen.findByTestId('system-provider-form');
    await user.click(within(form).getByTestId('system-provider-lookup'));

    // 第二行（deepseek）被填上真实参数；第一行已有值不动
    await waitFor(() => {
      expect((within(form).getByLabelText('模型 2 上下文窗口') as HTMLInputElement).value).toBe('1048576');
    });
    expect((within(form).getByLabelText('模型 2 最大输出') as HTMLInputElement).value).toBe('393216');
    expect((within(form).getByLabelText('模型 1 上下文窗口') as HTMLInputElement).value).toBe('200000');

    const note = within(form).getByTestId('system-provider-lookup-note').textContent ?? '';
    expect(note).toContain('OpenRouter 公共库');
    expect(note).toContain('回填 2 条');
    expect(note).toContain('跳过 2 条已有值');

    await user.click(within(form).getByTestId('system-provider-save'));
    await waitFor(() => {
      expect(lastProviderBody).not.toBeNull();
    });
    expect(lastProviderBody?.models?.[1]).toEqual({
      model: 'deepseek-v4.1-flash',
      price: { input_usd_per_mtok: 0.05, output_usd_per_mtok: 0.2 },
      context_window: 1_048_576,
      max_output_tokens: 393_216,
    });
  });

  it('查不到的模型保持空白：请求体里不带这两个字段（不写 0）', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/settings/providers/:id/models/lookup', () =>
        HttpResponse.json({
          items: [
            {
              model: 'deepseek-v4.1-flash',
              found: false,
              context_window: null,
              max_output_tokens: null,
              source: 'none',
              matched_id: null,
              error: '公共库与内置表里都没有这个模型',
            },
          ],
          fetched: 'table',
          note: '联网查询失败（超时）：用了内置表',
        }),
      ),
      http.put('/api/settings/providers/:id', async ({ request }) => {
        lastProviderBody = (await request.json()) as SaveModelProviderRequest;
        return HttpResponse.json(providers[0]);
      }),
    );

    renderApp();
    const page = await screen.findByTestId('system-page');
    const row = await within(page).findByTestId('system-provider-anthropic');
    await user.click(within(row).getByTestId('system-provider-edit-anthropic'));
    const form = await screen.findByTestId('system-provider-form');
    await user.click(within(form).getByTestId('system-provider-lookup'));

    await waitFor(() => {
      const note = within(form).getByTestId('system-provider-lookup-note').textContent ?? '';
      expect(note).toContain('内置表');
      expect(note).toContain('联网查询失败');
    });
    // 输入框仍是空（placeholder「未知」），不是 0
    expect((within(form).getByLabelText('模型 2 上下文窗口') as HTMLInputElement).value).toBe('');

    await user.click(within(form).getByTestId('system-provider-save'));
    await waitFor(() => {
      expect(lastProviderBody).not.toBeNull();
    });
    expect(lastProviderBody?.models?.[1]).not.toHaveProperty('context_window');
    expect(lastProviderBody?.models?.[1]).not.toHaveProperty('max_output_tokens');
  });
});
