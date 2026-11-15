/**
 * 全局设置的两条拦截器（`AC-32` / CFG-8.1 / CFG-8.2）：
 * `GET /api/settings/providers` 与 `GET /api/settings/models`。
 *
 * 夹具刻意覆盖四种形态，让面板的每个分支都有路可走：
 * 1. 一家**连通**（`status: 'ok'` + 真实延迟 + 三个 model + 单价）；
 * 2. 一家**不通**（`status: 'fail'` + `latency_ms: null` + `check_error` 原因）——
 *    失败的时间不是延迟，所以延迟必须是 `null` 而不是 0；
 * 3. 一家**没 key**（`key_configured: false` / `key_mask: null`）—— 面板要显示「未配置」；
 * 4. 四档里**缺一档**（`configured: false` + `price: null`）—— 面板要显示「未配置」而不是隐藏，
 *    单价必须显示 `—`（`null ≠ 0`，这是契约里反复强调的那条）。
 *
 * **没有明文 key**：契约的 `ModelProvider` 根本没有 `key` 字段，夹具也就造不出来 ——
 * 面板能把真值渲染出来这件事，在类型层面就不可能。
 */
import { http, type HttpHandler } from 'msw';
import type { ModelProvider, ModelProvidersResponse, ModelRolesResponse } from '../../lib/contract.ts';
import { scenarioResponse } from './shared.ts';

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
        { model: 'claude-opus-4', price: { input_usd_per_mtok: 15, output_usd_per_mtok: 75 } },
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

/** 外部（夹具）→ 契约响应：`{ items }`。 */
export function modelProvidersMock(): ModelProvidersResponse {
  return { items: providerFixture() };
}

export function modelProvidersEmptyMock(): ModelProvidersResponse {
  return { items: [] };
}

/** 四档固定四行（契约 `modelRolesResponseSchema` 要求 `length(4)`），缺的那档 `configured: false`。 */
export function modelRolesMock(): ModelRolesResponse {
  return {
    items: [
      {
        role: 'agent',
        configured: true,
        provider_id: 'anthropic',
        provider_name: 'Anthropic',
        model: 'claude-opus-4',
        price: { input_usd_per_mtok: 15, output_usd_per_mtok: 75 },
        updated_at: '2026-05-30T09:00:00.000Z',
      },
      {
        role: 'format',
        configured: true,
        provider_id: 'anthropic',
        provider_name: 'Anthropic',
        model: 'claude-haiku-4',
        price: { input_usd_per_mtok: 0.8, output_usd_per_mtok: 4 },
        updated_at: '2026-05-30T09:00:00.000Z',
      },
      {
        role: 'classify',
        configured: true,
        provider_id: 'openai',
        provider_name: 'OpenAI',
        model: 'gpt-5',
        price: { input_usd_per_mtok: 2.5, output_usd_per_mtok: 10 },
        updated_at: '2026-05-29T12:00:00.000Z',
      },
      {
        // 没配的那档：面板必须显示「未配置 + —」，不隐藏、不写 0
        role: 'fallback',
        configured: false,
        provider_id: null,
        provider_name: null,
        model: null,
        price: null,
        updated_at: null,
      },
    ],
  };
}

/** 四档都没配（`?mock=empty`）：四行仍在，`configured` 全 false。 */
export function modelRolesEmptyMock(): ModelRolesResponse {
  return {
    items: (['agent', 'format', 'classify', 'fallback'] as const).map((role) => ({
      role,
      configured: false,
      provider_id: null,
      provider_name: null,
      model: null,
      price: null,
      updated_at: null,
    })),
  };
}

export const settingsHandlers: HttpHandler[] = [
  http.get('/api/settings/providers', () =>
    scenarioResponse({ data: modelProvidersMock(), empty: modelProvidersEmptyMock() }),
  ),
  http.get('/api/settings/models', () =>
    scenarioResponse({ data: modelRolesMock(), empty: modelRolesEmptyMock() }),
  ),
];
