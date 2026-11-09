/**
 * `model-endpoint`：模型 API 端点预检（标准 **OpenAI / DeepSeek / MiMo** 兼容接口）。
 *
 * 为什么查 `GET <base>/models` 而不是发一次 chat 请求：
 *  - 它同时验证两件事——**端点在不在**（网络/DNS/base URL 拼错）与**凭证是否被接受**（401/403），
 *    而 chat 请求还要挑模型、烧 token、可能因为 quota 与 max_tokens 参数报错，噪声大；
 *  - `/models` 是 OpenAI 兼容协议里所有厂商都实现的最小只读端点（DeepSeek、MiMo、
 *    vLLM/Ollama 网关、Azure 兼容层都有），用它做预检不绑定具体供应商。
 *
 * 三态语义（与 §6.4 一致）：
 *  - 没配 base URL → `warn`（本机 dry-run 不需要模型端点，不该因此拒绝启动）；
 *  - 2xx → `ok`；配了模型名但列表里没有 → `warn`（多半是名字拼错，不阻断启动）；
 *  - 401/403 → `fail`（凭证问题必须挡在启动前）；其它状态码/网络错误 → `fail`（端点不可达）。
 */

import { describeError } from '../deps.ts';
import type { CheckContext, CheckDefinition } from '../deps.ts';
import type { CheckOutcome } from '../types.ts';

/** 单次探测上限：预检不该拖住 `systemctl start`。 */
export const MODEL_PROBE_TIMEOUT_MS = 8_000;

/** env 别名（与我们自己的名字并列，谁先有值用谁）。 */
const BASE_URL_KEYS = ['PI_BOT_MODEL_BASE_URL', 'OPENAI_BASE_URL', 'DEEPSEEK_BASE_URL'] as const;
const API_KEY_KEYS = ['PI_BOT_MODEL_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY'] as const;
const MODEL_NAME_KEYS = ['PI_BOT_MODEL_NAME', 'PI_BOT_MODEL'] as const;

function firstEnv(ctx: CheckContext, keys: readonly string[]): string | null {
  for (const key of keys) {
    const raw = ctx.env[key];
    if (raw !== undefined && raw.trim() !== '') {
      return raw.trim();
    }
  }
  return null;
}

/** 从 `/models` 响应里取模型 id 列表（OpenAI 形态：`{data:[{id}]}`；也容忍裸数组）。 */
export function parseModelIds(body: unknown): readonly string[] | null {
  if (Array.isArray(body)) {
    return body.flatMap((item) => {
      if (typeof item === 'string') {
        return [item];
      }
      if (typeof item === 'object' && item !== null && 'id' in item && typeof item.id === 'string') {
        return [item.id];
      }
      return [];
    });
  }
  if (typeof body === 'object' && body !== null && 'data' in body) {
    const data = (body as { data: unknown }).data;
    return Array.isArray(data) ? parseModelIds(data) : null;
  }
  return null;
}

export const modelEndpointCheck: CheckDefinition = {
  id: 'model-endpoint',
  title: '模型 API 端点（OpenAI / DeepSeek / MiMo 兼容）',
  async run(ctx): Promise<CheckOutcome> {
    const base = firstEnv(ctx, BASE_URL_KEYS);
    const apiKey = firstEnv(ctx, API_KEY_KEYS);
    const modelName = firstEnv(ctx, MODEL_NAME_KEYS);

    if (base === null) {
      return {
        status: 'warn',
        detail:
          '未配置 PI_BOT_MODEL_BASE_URL（或 OPENAI_BASE_URL / DEEPSEEK_BASE_URL）：' +
          'dry-run 与单测不需要模型端点，但真跑 turn 时 pi-host 会以默认端点或直接失败' +
          (modelName === null ? '' : `；当前模型名 ${modelName}`),
        fixHint:
          '在 EnvironmentFile 里补 PI_BOT_MODEL_BASE_URL 与 PI_BOT_MODEL_NAME，例如\n' +
          '  DeepSeek: https://api.deepseek.com/v1 + deepseek-chat\n' +
          '  OpenAI:   https://api.openai.com/v1 + gpt-4o-mini\n' +
          '  MiMo:     厂商文档给的 OpenAI 兼容 base URL + 对应模型名',
      };
    }

    const baseUrl = base.replace(/\/+$/u, '');
    const url = `${baseUrl}/models`;
    const started = ctx.elapsed();
    const headers: Record<string, string> = { accept: 'application/json' };
    if (apiKey !== null) {
      headers['authorization'] = `Bearer ${apiKey}`;
    }

    let response: Response;
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(MODEL_PROBE_TIMEOUT_MS) });
    } catch (error) {
      return {
        status: 'fail',
        detail: `GET ${url} 失败：${describeError(error)}`,
        fixHint:
          '确认 base URL 可达（防火墙 / 代理 / DNS），且填的是 base URL 而不是某个接口的完整路径；' +
          '容器与 bot 都不走容器网络，这条请求由 bot 直接发出',
      };
    }

    const elapsedMs = Math.max(0, Math.round(ctx.elapsed() - started));

    if (response.status === 401 || response.status === 403) {
      return {
        status: 'fail',
        detail: `GET ${url} → ${String(response.status)}：凭证被拒（${apiKey === null ? '未配置 key' : 'key 无效或无权限'}）`,
        fixHint: '检查 PI_BOT_MODEL_API_KEY（或 OPENAI_API_KEY / DEEPSEEK_API_KEY）是否与端点归属同一账号',
      };
    }

    if (!response.ok) {
      return {
        status: 'fail',
        detail: `GET ${url} → ${String(response.status)}${response.status === 404 ? '（端点不存在：base URL 多写/少写了一段路径？）' : ''}`,
        fixHint: '把 base URL 改成厂商文档的 OpenAI 兼容地址，通常形如 https://host/v1',
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const ids = parseModelIds(body);

    if (modelName !== null && ids !== null && ids.length > 0 && !ids.includes(modelName)) {
      return {
        status: 'warn',
        detail:
          `GET ${url} → 200（${String(ids.length)} 个模型，${String(elapsedMs)}ms），` +
          `但列表里没有配置的 ${modelName}（可能拼错，或该账号无此模型权限）`,
        fixHint: `可用模型示例：${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ' …' : ''}`,
      };
    }

    return {
      status: 'ok',
      detail:
        `GET ${url} → 200` +
        `（${ids === null ? '返回体不是标准 /models 形态' : `${String(ids.length)} 个模型`}，` +
        `${String(elapsedMs)}ms）${modelName === null ? '；未配置模型名' : `；模型 ${modelName}`}`,
    };
  },
};
