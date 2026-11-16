/**
 * `/api/settings/*` 与 `/api/repos/:owner/:name/model` 的**路由**用例（真库 + 假探测端口）。
 *
 * 钉五件事：
 *  1. 写接口**必须**过写守卫（缺 `X-Pi-Bot-CSRF` → 403，且不改库）；
 *  2. 读接口把 key 只暴露成 `key_configured` + `key_mask`（明文永不出响应）；
 *  3. 连通性测试**失败也回 200**（`status: 'fail'` + 原因），面板据此画状态点；
 *  4. 执行模型只有一档；项目级 `inherit` 时 `effective` 填的是全局值（面板显示「继承全局」）；
 *  5. 身份「检查权限」把 scope / 过期落库，并在不可用时写一条退回留痕。
 *
 * 探测端口全部注入假实现：本用例不连 GitHub、不连真实模型端点。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createNullLogger } from '../../../packages/shared/src/index.ts';
import { buildServer, createAllowAllAuth } from '../src/http/index.ts';
import type { ZodFastify } from '../src/http/index.ts';
import type { GithubIdentityProbe } from '../src/app/index.ts';
import { generateSecretKey } from '../src/runtime/crypto.ts';
import { saveIdentity, saveProvider } from '../src/config/model-settings.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

const FIXED_NOW = new Date('2026-06-01T12:00:00.000Z');
const REPO = 'acme/widgets';
const KEY = generateSecretKey();
/** 写守卫要求的那一个头（跨站/表单发不出来）。`accept` 让无响应体的写请求也有合法头组合。 */
const CSRF = { 'x-pi-bot-csrf': '1', 'content-type': 'application/json' };
/** 无 body 的写请求（DELETE / POST check）：不声明 `content-type`，否则 Fastify 会判空 body 非法。 */
const CSRF_NO_BODY = { 'x-pi-bot-csrf': '1' };

let db: TestDb;
let app: ZodFastify;

/** 假身份探测：默认 scope 齐全、不过期。 */
let identityProbeResult: GithubIdentityProbe = {
  login: 'alice',
  scopes: ['repo'],
  expiresAt: null,
};
let identityProbeCalls = 0;

/** 假供应商探测：默认连通、延迟 12ms。 */
let providerProbeOk = true;

beforeAll(async () => {
  db = await openTestDb(FIXED_NOW);
  app = buildServer({
    logger: createNullLogger(),
    pool: db.pool,
    queries: db.queries,
    requireAuth: createAllowAllAuth('tester'),
    webhook: {
      verify: async () => true,
      db: db.pool,
      enqueue: async () => null,
      ack: { addEyesReaction: async () => undefined },
      logger: createNullLogger(),
      now: () => FIXED_NOW,
    },
    settings: {
      db: db.pool,
      secretKey: KEY,
      writeMode: 'any',
      identityProbe: async () => {
        identityProbeCalls += 1;
        return identityProbeResult;
      },
      providerProbe: async () => {
        if (!providerProbeOk) {
          return { ok: false, latencyMs: 3, error: 'https://down.example/v1/models 请求失败：ECONNREFUSED' };
        }
        return { ok: true, latencyMs: 12, error: null };
      },
    },
    appVersion: 'test',
    now: () => FIXED_NOW,
  });
});

afterAll(async () => {
  await app.close();
  await db.close();
});

beforeEach(async () => {
  await db.pool.query(
    `truncate table model_providers, model_default, repo_model_override, panel_identities, identity_fallbacks cascade`,
  );
  identityProbeResult = { login: 'alice', scopes: ['repo'], expiresAt: null };
  identityProbeCalls = 0;
  providerProbeOk = true;
});

describe('/api/settings/providers（CFG-8.1）', () => {
  it('PUT 缺 CSRF → 403，且不落库', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/providers/deepseek',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'DeepSeek', key: 'sk-live-1234567890abcdef' },
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: { code: string } }).error.code).toBe('forbidden');
    const rows = await db.sql(`select count(*)::int as n from model_providers`);
    expect((rows[0] as { n: number }).n).toBe(0);
  });

  it('PUT 带 CSRF → 回掩码与 key_configured，响应里没有明文', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/providers/deepseek',
      headers: CSRF,
      payload: {
        name: 'DeepSeek',
        base_url: 'https://api.deepseek.com/v1',
        key: 'sk-live-1234567890abcdef',
        models: [{ model: 'deepseek-v4.1-flash', price: { input_usd_per_mtok: 0.3, output_usd_per_mtok: 1.2 } }],
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { key_configured: boolean; key_mask: string };
    expect(body.key_configured).toBe(true);
    expect(body.key_mask).toBe('sk-l…cdef');
    expect(response.body).not.toContain('sk-live-1234567890abcdef');
  });

  it('GET 列表按 id 升序，且每行都只有掩码', async () => {
    await saveProvider(db.pool, { id: 'b-one', name: 'B', key: 'sk-b-1234567890' }, KEY);
    await saveProvider(db.pool, { id: 'a-one', name: 'A', key: 'sk-a-1234567890' }, KEY);
    const response = await app.inject({ method: 'GET', url: '/api/settings/providers' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: { id: string }[] };
    expect(body.items.map((item) => item.id)).toEqual(['a-one', 'b-one']);
    expect(response.body).not.toContain('sk-a-1234567890');
  });

  it('连通性测试成功 → status=ok + 延迟', async () => {
    await saveProvider(
      db.pool,
      { id: 'p1', name: 'P1', baseUrl: 'https://up.example/v1', key: 'sk-p1-1234567890' },
      KEY,
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/providers/p1/check',
      headers: CSRF,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ provider_id: 'p1', status: 'ok', latency_ms: 12, error: null });
    const rows = await db.sql(`select status, latency_ms from model_providers where id = 'p1'`);
    expect(rows[0]).toMatchObject({ status: 'ok', latency_ms: 12 });
  });

  it('连通性测试失败 → **仍然 200** + status=fail + 原因（面板画状态点，不是错误横幅）', async () => {
    providerProbeOk = false;
    await saveProvider(
      db.pool,
      { id: 'p1', name: 'P1', baseUrl: 'https://down.example/v1', key: 'sk-p1-1234567890' },
      KEY,
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/providers/p1/check',
      headers: CSRF,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { status: string; latency_ms: number | null; error: string };
    expect(body.status).toBe('fail');
    // 失败的时间不是「延迟」：必须是 null 而不是 0
    expect(body.latency_ms).toBe(null);
    expect(body.error).toContain('ECONNREFUSED');
  });

  it('缺 key 就测连通性 → 400（先把这一行填全）', async () => {
    await saveProvider(db.pool, { id: 'p1', name: 'P1', baseUrl: 'https://up.example/v1' }, KEY);
    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/providers/p1/check',
      headers: CSRF,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { message: string } }).error.message).toContain('key');
  });
});

describe('/api/settings/model 与项目级覆盖（CFG-8.2 / CFG-8.3）', () => {
  it('没配时 configured=false、price=null（单档：不是一个 items 数组）', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/settings/model' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      configured: false,
      provider_id: null,
      provider_name: null,
      model: null,
      price: null,
      updated_at: null,
    });
  });

  it('配好之后回供应商名 + 模型 + 目录单价', async () => {
    await saveProvider(
      db.pool,
      {
        id: 'p1',
        name: 'P1',
        models: [{ model: 'm1', price: { input_usd_per_mtok: 1, output_usd_per_mtok: 2 } }],
      },
      KEY,
    );
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/settings/model',
      headers: CSRF,
      payload: { provider_id: 'p1', model: 'm1' },
    });
    expect(saved.statusCode).toBe(200);

    const response = await app.inject({ method: 'GET', url: '/api/settings/model' });
    expect(response.json()).toMatchObject({
      configured: true,
      provider_id: 'p1',
      provider_name: 'P1',
      model: 'm1',
      price: { input_usd_per_mtok: 1, output_usd_per_mtok: 2 },
    });
  });

  it('项目页 inherit 时 effective 填全局值；override 后填项目值 + 各自单价', async () => {
    await saveProvider(
      db.pool,
      {
        id: 'p1',
        name: 'P1',
        models: [
          { model: 'global-model', price: { input_usd_per_mtok: 1, output_usd_per_mtok: 2 } },
          { model: 'repo-model', price: { input_usd_per_mtok: 3, output_usd_per_mtok: 9 } },
        ],
      },
      KEY,
    );
    await app.inject({
      method: 'PUT',
      url: '/api/settings/model',
      headers: CSRF,
      payload: { provider_id: 'p1', model: 'global-model' },
    });

    const inherited = await app.inject({ method: 'GET', url: `/api/repos/${REPO}/model` });
    expect(inherited.statusCode).toBe(200);
    const inheritedBody = inherited.json() as {
      repo: string;
      selection: { mode: string };
      effective: { provider_id: string; model: string } | null;
      effective_price: unknown;
    };
    expect(inheritedBody.repo).toBe(REPO);
    expect(inheritedBody.selection).toEqual({ mode: 'inherit' });
    expect(inheritedBody.effective).toEqual({ provider_id: 'p1', model: 'global-model' });
    expect(inheritedBody.effective_price).toEqual({ input_usd_per_mtok: 1, output_usd_per_mtok: 2 });

    const override = await app.inject({
      method: 'PUT',
      url: `/api/repos/${REPO}/model`,
      headers: CSRF,
      payload: { mode: 'override', provider_id: 'p1', model: 'repo-model' },
    });
    expect(override.statusCode).toBe(200);

    const afterOverride = await app.inject({ method: 'GET', url: `/api/repos/${REPO}/model` });
    const overridden = afterOverride.json() as typeof inheritedBody;
    expect(overridden.selection).toEqual({ mode: 'override', provider_id: 'p1', model: 'repo-model' });
    expect(overridden.effective).toEqual({ provider_id: 'p1', model: 'repo-model' });
    expect(overridden.effective_price).toEqual({ input_usd_per_mtok: 3, output_usd_per_mtok: 9 });
  });

  it('绑不存在的模型 → 400（保存时拒，不留静默失效）', async () => {
    await saveProvider(
      db.pool,
      { id: 'p1', name: 'P1', models: [{ model: 'm1', price: { input_usd_per_mtok: 1, output_usd_per_mtok: 2 } }] },
      KEY,
    );
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/model',
      headers: CSRF,
      payload: { provider_id: 'p1', model: 'm-typo' },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { message: string } }).error.message).toContain('m-typo');
  });
});

describe('/api/settings/identity（CFG-9.1 / CFG-9.2）', () => {
  it('没配个人 PAT → effective=bot（合法默认），identity=null', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/settings/identity' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ effective: 'bot', identity: null });
  });

  it('存 PAT → 响应含掩码与 unchecked（还没检查过，不能冒充可用）', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/identity',
      headers: CSRF,
      payload: { login: 'alice', token: 'github_pat_1234567890abcdef' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { identity: { state: string; token_mask: string } };
    expect(body.identity.state).toBe('unchecked');
    expect(body.identity.token_mask).toBe('gith…cdef');
    expect(response.body).not.toContain('github_pat_1234567890abcdef');
  });

  it('检查权限成功 → state=ok、scope 落库、effective=user', async () => {
    await saveIdentity(db.pool, { login: 'alice', token: 'github_pat_1234567890abcdef' }, KEY);
    const check = await app.inject({
      method: 'POST',
      url: '/api/settings/identity/alice/check',
      headers: CSRF,
      payload: {},
    });
    expect(check.statusCode).toBe(200);
    expect(check.json()).toMatchObject({ remote_checked: true, identity: { state: 'ok' } });
    expect(identityProbeCalls).toBe(1);

    const current = await app.inject({ method: 'GET', url: '/api/settings/identity' });
    expect(current.json()).toMatchObject({ effective: 'user' });
  });

  it('scope 不足 → state=insufficient-scope，并写一条退回留痕', async () => {
    identityProbeResult = { login: 'alice', scopes: ['read:user'], expiresAt: null };
    await saveIdentity(db.pool, { login: 'alice', token: 'github_pat_1234567890abcdef' }, KEY);
    const check = await app.inject({
      method: 'POST',
      url: '/api/settings/identity/alice/check',
      headers: CSRF,
      payload: {},
    });
    expect(check.statusCode).toBe(200);
    expect(check.json()).toMatchObject({ identity: { state: 'insufficient-scope' } });

    const fallbacks = await app.inject({ method: 'GET', url: '/api/settings/identity/fallbacks' });
    const body = fallbacks.json() as { items: { state: string; operation: string; reason: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.state).toBe('insufficient-scope');
    expect(body.items[0]?.operation).toBe('identity-check');
    expect(body.items[0]?.reason).toContain('issues:write');
  });

  it('已过期 → state=expired（本地就能判，不必先问 GitHub）', async () => {
    identityProbeResult = { login: 'alice', scopes: ['repo'], expiresAt: '2026-05-01T00:00:00.000Z' };
    await saveIdentity(db.pool, { login: 'alice', token: 'github_pat_1234567890abcdef' }, KEY);
    const check = await app.inject({
      method: 'POST',
      url: '/api/settings/identity/alice/check',
      headers: CSRF,
      payload: {},
    });
    expect(check.json()).toMatchObject({ identity: { state: 'expired' } });
  });

  it('没存过 PAT 就检查 → 404', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/identity/nobody/check',
      // 无 body 的写请求：只带 CSRF 头（声明了 JSON 却不给 body 会被判 400）
      headers: CSRF_NO_BODY,
    });
    expect(response.statusCode).toBe(404);
  });

  it('删除个人令牌 → 退回 bot 并留痕', async () => {
    await saveIdentity(db.pool, { login: 'alice', token: 'github_pat_1234567890abcdef' }, KEY);
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/settings/identity/alice',
      headers: CSRF_NO_BODY,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, deleted: true });

    const current = await app.inject({ method: 'GET', url: '/api/settings/identity' });
    expect(current.json()).toMatchObject({ effective: 'bot', identity: null });

    const fallbacks = await app.inject({ method: 'GET', url: '/api/settings/identity/fallbacks' });
    expect((fallbacks.json() as { items: { state: string }[] }).items[0]?.state).toBe('missing');
  });
});
