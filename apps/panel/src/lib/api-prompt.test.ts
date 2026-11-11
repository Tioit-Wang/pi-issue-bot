/**
 * `lib/api.ts` 的五个提示词函数：**URL / 方法 / `?kind=` / 请求体 / CSRF 头**。
 *
 * 为什么单独测这一层：`?kind=` 是这五个接口唯一的区分方式（四条版本线共用同一条路径），
 * 拼错了不会报错 —— 只会静默读到 `project` 那一份（服务端缺省值）。所以这里逐条钉住：
 *  1. 省略 `kind` 时**不带** `?kind=`（旧调用点行为不变）；
 *  2. 给了 `kind` 就一定在查询串上（`prompt` / `savePrompt` / `rollbackPrompt` /
 *     `restorePrompt` / `promptVersions` 五个都要）；
 *  3. 写接口仍然走同一套写面约定（CSRF 头 + JSON content-type）；
 *  4. 400 的 `details.code` 原样带到 `ApiError`（面板的错误文案就靠它）。
 */
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, CSRF_HEADER, api } from './api.ts';

type Recorded = {
  method: string;
  path: string;
  search: string;
  csrf: string | null;
  contentType: string | null;
  body: string | null;
};

const requests: Recorded[] = [];

/** 记录一次请求（响应体不重要：这一层只关心「怎么发的」）。 */
async function record(request: Request): Promise<Recorded> {
  const url = new URL(request.url);
  const contentType = request.headers.get('content-type');
  const text = await request.text();
  const entry: Recorded = {
    method: request.method,
    path: url.pathname,
    search: url.search,
    csrf: request.headers.get(CSRF_HEADER),
    contentType,
    body: text === '' ? null : text,
  };
  requests.push(entry);
  return entry;
}

/** 最小可用的提示词视图（`lib/api.ts` 不做校验，这里够用就行）。 */
const VIEW = {
  repo: 'acme/widgets',
  enabled: true,
  version: 2,
  present: true,
  body: '## 项目约定',
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
    stats: { baseChars: 0, promptChars: 0, agentsChars: 0, skillChars: 0, totalChars: 0, truncated: [] },
    omitted: [],
    ref: null,
    sha: null,
  },
  lastAssembly: null,
};

const server = setupServer(
  http.get('/api/repos/:owner/:name/prompt', async ({ request }) => {
    const entry = await record(request);
    return HttpResponse.json({ ...VIEW, kind: entry.search.includes('kind=classify') ? 'classify' : 'project' });
  }),
  http.get('/api/repos/:owner/:name/prompt/versions', async ({ request }) => {
    await record(request);
    return HttpResponse.json({ kind: 'agent', activeVersion: 1, limit: 4_000, versions: [] });
  }),
  http.put('/api/repos/:owner/:name/prompt', async ({ request }) => {
    const entry = await record(request);
    if (entry.body?.includes('{{nope}}') === true) {
      return HttpResponse.json(
        {
          error: {
            code: 'bad-request',
            message: 'classify 正文里有未识别的占位符：{{nope}}',
            details: { code: 'placeholder-unknown', unknownPlaceholders: ['nope'] },
          },
        },
        { status: 400 },
      );
    }
    return HttpResponse.json({ ...VIEW, version: 3 });
  }),
  http.post('/api/repos/:owner/:name/prompt/rollback', async ({ request }) => {
    await record(request);
    return HttpResponse.json({ ...VIEW, version: 4 });
  }),
  http.post('/api/repos/:owner/:name/prompt/restore', async ({ request }) => {
    await record(request);
    return HttpResponse.json({ ...VIEW, version: 0, present: false, body: '' });
  }),
);

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
  requests.length = 0;
});

describe('api.prompt', () => {
  it('省略 kind：不带查询串（旧调用点行为不变）', async () => {
    await api.prompt('acme/widgets');

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.path).toBe('/api/repos/acme/widgets/prompt');
    expect(requests[0]?.search).toBe('');
  });

  it('给 kind：`?kind=` 落进查询串；`{owner,name}` 形式也走同一条路径', async () => {
    const view = await api.prompt({ owner: 'acme', name: 'widgets' }, 'classify');

    expect(requests[0]?.path).toBe('/api/repos/acme/widgets/prompt');
    expect(requests[0]?.search).toBe('?kind=classify');
    expect(view.kind).toBe('classify');
  });
});

describe('api.savePrompt', () => {
  it('PUT + `?kind=` + CSRF 头 + JSON（带 note）', async () => {
    await api.savePrompt('acme/widgets', 'format_check', '【模板】{{title}} {{body}}', '补必填占位符');

    const entry = requests[0];
    expect(entry?.method).toBe('PUT');
    expect(entry?.path).toBe('/api/repos/acme/widgets/prompt');
    expect(entry?.search).toBe('?kind=format_check');
    expect(entry?.csrf).toBe('1');
    expect(entry?.contentType).toBe('application/json');
    expect(entry?.body).toBe(JSON.stringify({ body: '【模板】{{title}} {{body}}', note: '补必填占位符' }));
  });

  it('不给 note：请求体里就没有 note 这个键', async () => {
    await api.savePrompt('acme/widgets', 'agent', '【身份】{{repo}}');

    expect(requests[0]?.search).toBe('?kind=agent');
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({ body: '【身份】{{repo}}' });
  });

  it('400 的 `details.code` 原样进 ApiError（面板据此选文案）', async () => {
    const error = await api.savePrompt('acme/widgets', 'classify', '{{nope}}').catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(400);
    expect(apiError.code).toBe('bad-request');
    expect(apiError.details?.['code']).toBe('placeholder-unknown');
    expect(apiError.details?.['unknownPlaceholders']).toEqual(['nope']);
  });
});

describe('api.rollbackPrompt / api.restorePrompt / api.promptVersions', () => {
  it('rollback：POST + `?kind=` + `{version}`', async () => {
    await api.rollbackPrompt('acme/widgets', 'agent', 1);

    const entry = requests[0];
    expect(entry?.method).toBe('POST');
    expect(entry?.path).toBe('/api/repos/acme/widgets/prompt/rollback');
    expect(entry?.search).toBe('?kind=agent');
    expect(entry?.csrf).toBe('1');
    expect(entry?.body).toBe(JSON.stringify({ version: 1 }));
  });

  it('restore：POST + `?kind=` + 没有请求体', async () => {
    await api.restorePrompt('acme/widgets', 'format_check');

    const entry = requests[0];
    expect(entry?.method).toBe('POST');
    expect(entry?.path).toBe('/api/repos/acme/widgets/prompt/restore');
    expect(entry?.search).toBe('?kind=format_check');
    expect(entry?.csrf).toBe('1');
    expect(entry?.body).toBeNull();
  });

  it('versions：GET `/prompt/versions?kind=`（不跑装配预览的那条轻量路径）', async () => {
    const response = await api.promptVersions('acme/widgets', 'agent');

    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.path).toBe('/api/repos/acme/widgets/prompt/versions');
    expect(requests[0]?.search).toBe('?kind=agent');
    expect(response.kind).toBe('agent');
  });
});
