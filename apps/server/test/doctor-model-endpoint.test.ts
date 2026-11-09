/**
 * `doctor` 的 `model-endpoint` 项：三态语义 + 不烧 token 的探针（`GET <base>/models`）。
 *
 * 用 `vi.stubGlobal('fetch', …)` 造四种响应：200（含/不含配置的模型名）、401、网络错误。
 * 不驱动真网络：预检的判定必须能在 CI 上复现。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MODEL_PROBE_TIMEOUT_MS, modelEndpointCheck, parseModelIds } from '../src/doctor/checks/model-endpoint.ts';
import { resolveDeps } from '../src/doctor/deps.ts';
import type { CheckContext, DoctorDeps } from '../src/doctor/deps.ts';

function ctxOf(env: Record<string, string>, over: DoctorDeps = {}): CheckContext {
  return resolveDeps({
    env,
    platform: 'linux',
    repoRoot: '/repo',
    migrationsDir: '/repo/migrations',
    ...over,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseModelIds', () => {
  it('接受 OpenAI 形态与裸数组，其它返回 null', () => {
    expect(parseModelIds({ data: [{ id: 'a' }, { id: 'b' }] })).toEqual(['a', 'b']);
    expect(parseModelIds(['x', 'y'])).toEqual(['x', 'y']);
    expect(parseModelIds({ oops: 1 })).toBeNull();
    expect(parseModelIds('text')).toBeNull();
  });
});

describe('model-endpoint 检查', () => {
  it('未配 base URL → warn（不阻断启动），提示里给出三家示例', async () => {
    const outcome = await modelEndpointCheck.run(ctxOf({}));
    expect(outcome.status).toBe('warn');
    expect(outcome.detail).toContain('PI_BOT_MODEL_BASE_URL');
    expect(outcome.fixHint).toContain('deepseek-chat');
    expect(outcome.fixHint).toContain('gpt-4o-mini');
  });

  it('200 且模型名在列表里 → ok，带耗时与模型数', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await modelEndpointCheck.run(
      ctxOf({
        PI_BOT_MODEL_BASE_URL: 'https://api.deepseek.com/v1/',
        PI_BOT_MODEL_API_KEY: 'sk-test',
        PI_BOT_MODEL_NAME: 'deepseek-chat',
      }),
    );

    expect(outcome.status).toBe('ok');
    expect(outcome.detail).toContain('2 个模型');
    expect(outcome.detail).toContain('deepseek-chat');
    // 尾部斜杠被吃掉，拼出来是单斜杠
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/v1/models');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-test');
    expect(init.signal).toBeDefined();
  });

  it('200 但列表里没有配置的模型名 → warn（多半拼错）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: [{ id: 'deepseek-chat' }] })));

    const outcome = await modelEndpointCheck.run(
      ctxOf({
        PI_BOT_MODEL_BASE_URL: 'https://api.deepseek.com/v1',
        PI_BOT_MODEL_NAME: 'deepseek-chta',
      }),
    );

    expect(outcome.status).toBe('warn');
    expect(outcome.detail).toContain('deepseek-chta');
    expect(outcome.fixHint).toContain('deepseek-chat');
  });

  it('401 → fail（凭证被拒必须挡在启动前）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'invalid api key' }, 401)));

    const outcome = await modelEndpointCheck.run(
      ctxOf({ PI_BOT_MODEL_BASE_URL: 'https://api.openai.com/v1', OPENAI_API_KEY: 'sk-bad' }),
    );

    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('401');
    expect(outcome.detail).toContain('凭证被拒');
  });

  it('网络错误 → fail，并说明是 bot 直接发请求', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND api.deepseek.com');
      }),
    );

    const outcome = await modelEndpointCheck.run(
      ctxOf({ DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1', DEEPSEEK_API_KEY: 'sk-x' }),
    );

    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('ENOTFOUND');
    expect(outcome.fixHint).toContain('base URL');
  });

  it('404 → fail，并提示 base URL 路径可能多写了一段', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'not found' }, 404)));

    const outcome = await modelEndpointCheck.run(ctxOf({ PI_BOT_MODEL_BASE_URL: 'https://host/v1/chat' }));

    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('404');
    expect(outcome.detail).toContain('端点不存在');
  });

  it('探测超时上限是个小数字（预检不能拖住启动）', () => {
    expect(MODEL_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });
});
