/**
 * 全局设置的拦截器（`AC-32` / CFG-8.1 / CFG-8.2）：读两条 + 写三条。
 *
 * 夹具刻意覆盖四种形态，让面板的每个分支都有路可走：
 * 1. 一家**连通**（`status: 'ok'` + 真实延迟 + 三个 model + 单价）；
 * 2. 一家**不通**（`status: 'fail'` + `latency_ms: null` + `check_error` 原因）——
 *    失败的时间不是延迟，所以延迟必须是 `null` 而不是 0；
 * 3. 一家**没 key**（`key_configured: false` / `key_mask: null`）—— 面板要显示「未配置」；
 * 4. 执行模型**未配置**时用 `?mock=empty`（`configured: false` + `price: null`）—— 面板要显示「未配置」
 *    而不是隐藏，单价必须显示 `—`（`null ≠ 0`，这是契约里反复强调的那条）。
 *
 * **没有明文 key**：契约的 `ModelProvider` 根本没有 `key` 字段，夹具也就造不出来 ——
 * 面板能把真值渲染出来这件事，在类型层面就不可能。写接口收到的明文 key 只用来算掩码，
 * 不落进任何夹具（与真实服务端「落库前加密、只回掩码」一致）。
 *
 * 状态是模块级的：`PUT` / `POST check` 之后 `GET` 能读到变化，这样浏览器里点一次
 * 「测连通性」就能看到状态点变绿；测试里要固定响应请自己 `server.use` 覆盖。
 */
import { HttpResponse, http, type HttpHandler } from 'msw';
import type {
  ModelProvider,
  ModelProvidersResponse,
  ModelSetting,
  SaveModelProviderRequest,
  SaveModelRequest,
} from '../../lib/contract.ts';
import { requireCsrf, scenarioResponse } from './shared.ts';

const CHECKED_AT = '2026-06-01T11:58:00.000Z';

function providerFixture(): ModelProvider[] {
  return [
    {
      id: 'anthropic',
      name: 'Anthropic',
      base_url: 'https://api.anthropic.com/v1',
      key_configured: true,
      // 掩码形状与服务端 `key_mask` 一致（前 4 后 4），夹具也**不**放真值
      key_mask: 'sk-a…7f21',
      models: [
        {
          model: 'claude-opus-4',
          price: { input_usd_per_mtok: 15, output_usd_per_mtok: 75 },
          // 已经查过参数的一条：面板 chip 要能显示「上下文 200K · 输出 8K」
          context_window: 200_000,
          max_output_tokens: 8_192,
        },
        { model: 'claude-sonnet-4', price: { input_usd_per_mtok: 3, output_usd_per_mtok: 15 } },
        { model: 'claude-haiku-4', price: { input_usd_per_mtok: 0.8, output_usd_per_mtok: 4 } },
      ],
      enabled: true,
      status: 'ok',
      latency_ms: 412,
      checked_at: CHECKED_AT,
      check_error: null,
      updated_at: '2026-05-30T09:00:00.000Z',
    },
    {
      id: 'openai',
      name: 'OpenAI',
      // `base_url: null` = 用 pi-host 默认端点（面板要显示这个区别，不是空白）
      base_url: null,
      key_configured: true,
      key_mask: 'sk-o…9c3d',
      models: [{ model: 'gpt-5', price: { input_usd_per_mtok: 2.5, output_usd_per_mtok: 10 } }],
      enabled: false,
      status: 'fail',
      // 失败的时间不是「延迟」：必须是 null
      latency_ms: null,
      checked_at: CHECKED_AT,
      check_error: '连接超时（5000ms）：ECONNREFUSED api.openai.com:443',
      updated_at: '2026-05-29T12:00:00.000Z',
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

/** 全局执行模型（单档，已配好）。`?mock=empty` 用下面那份「未配置」。 */
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

/** 写接口之后的读：同一份模块级状态（夹具只在首次导入时生成）。 */
const providerState: ModelProvider[] = providerFixture();
const modelState: ModelSetting = modelSettingFixture();

/** 外部（夹具）→ 契约响应：`{ items }`。 */
export function modelProvidersMock(): ModelProvidersResponse {
  return { items: providerState.map((item) => ({ ...item })) };
}

export function modelProvidersEmptyMock(): ModelProvidersResponse {
  return { items: [] };
}

export function modelSettingMock(): ModelSetting {
  return { ...modelState, price: modelState.price === null ? null : { ...modelState.price } };
}

/** 未配置（`?mock=empty`）：面板必须显示「未配置 + —」，不隐藏、不写 0。 */
export function modelSettingEmptyMock(): ModelSetting {
  return {
    configured: false,
    provider_id: null,
    provider_name: null,
    model: null,
    price: null,
    updated_at: null,
  };
}

/** 掩码算法与真实服务端同一形状（前 4 后 4），且**只**产出掩码。 */
function maskOf(key: string): string {
  if (key.length <= 8) return `${key.slice(0, 2)}…`;
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function priceOf(provider: ModelProvider | undefined, model: string | null): ModelSetting['price'] {
  if (provider === undefined || model === null) return null;
  const hit = provider.models.find((entry) => entry.model === model);
  return hit === undefined ? null : { ...hit.price };
}

/** 执行模型跟着供应商目录重算：改目录之后单价必须一起变，否则界面自相矛盾。 */
function refreshModelPrice(): void {
  const provider =
    modelState.provider_id === null
      ? undefined
      : providerState.find((item) => item.id === modelState.provider_id);
  modelState.provider_name = provider?.name ?? modelState.provider_name;
  modelState.price = priceOf(provider, modelState.model);
}

export const settingsHandlers: HttpHandler[] = [
  http.get('/api/settings/providers', () =>
    scenarioResponse({
      data: modelProvidersMock(),
      empty: modelProvidersEmptyMock(),
    }),
  ),
  http.get('/api/settings/model', () =>
    scenarioResponse({
      data: modelSettingMock(),
      empty: modelSettingEmptyMock(),
    }),
  ),

  http.put('/api/settings/providers/:id', async ({ request, params }) => {
    const csrf = requireCsrf(request);
    if (csrf !== null) return csrf;

    const id = String(params['id']);
    const body = (await request.json()) as SaveModelProviderRequest;
    if (body.key !== undefined && body.clear_key === true) {
      return HttpResponse.json(
        { error: { code: 'bad-request', message: 'key 与 clear_key 不能同时给', details: { issues: ['key'] } } },
        { status: 400 },
      );
    }

    const at = providerState.findIndex((item) => item.id === id);
    const previous = at === -1 ? undefined : providerState[at];
    const next: ModelProvider = {
      id,
      name: body.name ?? previous?.name ?? id,
      base_url: body.base_url === undefined ? (previous?.base_url ?? null) : body.base_url,
      key_configured:
        body.clear_key === true ? false : body.key === undefined ? (previous?.key_configured ?? false) : true,
      key_mask: body.clear_key === true ? null : body.key === undefined ? (previous?.key_mask ?? null) : maskOf(body.key),
      models: body.models ?? previous?.models ?? [],
      enabled: body.enabled ?? previous?.enabled ?? true,
      // 新登记的一家还没测过：`unknown` + `null` 延迟（不是 0）
      status: previous?.status ?? 'unknown',
      latency_ms: previous?.latency_ms ?? null,
      checked_at: previous?.checked_at ?? null,
      check_error: previous?.check_error ?? null,
      updated_at: new Date().toISOString(),
    };
    if (at === -1) providerState.push(next);
    else providerState[at] = next;
    refreshModelPrice();
    return HttpResponse.json(next);
  }),

  http.post('/api/settings/providers/:id/check', async ({ request, params }) => {
    const csrf = requireCsrf(request);
    if (csrf !== null) return csrf;

    const id = String(params['id']);
    const target = providerState.find((item) => item.id === id);
    if (target === undefined) {
      return HttpResponse.json(
        { error: { code: 'not-found', message: `供应商不存在：${id}` } },
        { status: 404 },
      );
    }
    // 缺 key / base URL：真实服务端是 400 让你先填全（不是「连接失败」）
    if (!target.key_configured || target.base_url === null) {
      return HttpResponse.json(
        {
          error: {
            code: 'bad-request',
            message: `供应商 ${id} 缺 ${target.key_configured ? 'base URL' : 'key'}：先把这一行填全再测连通性`,
          },
        },
        { status: 400 },
      );
    }
    const checkedAt = new Date().toISOString();
    target.status = 'ok';
    target.latency_ms = 380;
    target.checked_at = checkedAt;
    target.check_error = null;
    return HttpResponse.json({
      provider_id: id,
      status: 'ok',
      latency_ms: 380,
      checked_at: checkedAt,
      error: null,
      models: null,
    });
  }),

  /**
   * 「查参数」的夹具口径与真实服务端一致：DeepSeek v4 系命中公共库（1M 上下文 / 393K 输出），
   * 其余返回「未查到」——面板必须把这两种都画出来（查到就填、查不到就不猜）。
   */
  http.post('/api/settings/providers/:id/models/lookup', async ({ request, params }) => {
    const csrf = requireCsrf(request);
    if (csrf !== null) return csrf;

    const id = String(params['id']);
    const target = providerState.find((item) => item.id === id);
    if (target === undefined) {
      return HttpResponse.json(
        { error: { code: 'not-found', message: `供应商不存在：${id}` } },
        { status: 404 },
      );
    }
    const items = target.models.map((entry) => {
      const hit = /deepseek-v4/u.test(entry.model.toLowerCase());
      return {
        model: entry.model,
        found: hit,
        context_window: hit ? 1_048_576 : null,
        max_output_tokens: hit ? 393_216 : null,
        source: hit ? ('openrouter' as const) : ('none' as const),
        matched_id: hit ? `deepseek/${entry.model}` : null,
        error: hit ? null : '公共库与内置表里都没有这个模型',
      };
    });
    return HttpResponse.json({ items, fetched: 'openrouter', note: null });
  }),

  http.put('/api/settings/model', async ({ request }) => {
    const csrf = requireCsrf(request);
    if (csrf !== null) return csrf;

    const body = (await request.json()) as SaveModelRequest;
    const provider = providerState.find((item) => item.id === body.provider_id);
    if (provider === undefined) {
      return HttpResponse.json(
        {
          error: {
            code: 'bad-request',
            message: `供应商不存在：${body.provider_id}`,
            details: { issues: ['provider_id'] },
          },
        },
        { status: 400 },
      );
    }
    // 与真实服务端同一条拒绝：目录里没有的模型不许绑定（否则单价没有来源）
    if (!provider.models.some((entry) => entry.model === body.model)) {
      return HttpResponse.json(
        {
          error: {
            code: 'bad-request',
            message: `供应商 ${body.provider_id} 的 model 目录里没有 ${body.model}（先把 model 加进目录，单价才有来源）`,
            details: { issues: ['model'] },
          },
        },
        { status: 400 },
      );
    }
    modelState.configured = true;
    modelState.provider_id = body.provider_id;
    modelState.provider_name = provider.name;
    modelState.model = body.model;
    modelState.price = priceOf(provider, body.model);
    modelState.updated_at = new Date().toISOString();
    return HttpResponse.json({ ok: true });
  }),
];
