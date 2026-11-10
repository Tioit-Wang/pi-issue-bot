/**
 * `/api/skills` 的 HTTP 层测试：**鉴权、CSRF/来源、错误码映射**。
 *
 * 上传成功路径不在这里（`skills-store.test.ts` 覆盖存储、真机验收覆盖端到端）；
 * 这个文件盯的是「没带头就不许写」这类**一旦失效就是安全洞**的行为。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HttpError, buildServer, createAllowAllAuth, createOctokitVerifier } from '../src/http/index.ts';
import type { ZodFastify } from '../src/http/index.ts';
import { createSkillStore } from '../src/skills/store.ts';
import { createNullLogger } from '../../../packages/shared/src/index.ts';
import { FIXED_NOW, openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

const SECRET = 'test-secret';
const ack = {
  addEyesReaction: async () => undefined,
  postAckComment: async () => undefined,
};

describe('/api/skills（HTTP 层）', () => {
  let db: TestDb;
  let dataDir: string;
  let app: ZodFastify;
  let deniedApp: ZodFastify;

  const makeServer = (requireAuth: unknown, writeMode: 'off' | 'loopback' | 'any'): ZodFastify =>
    buildServer({
      logger: createNullLogger(),
      pool: db.pool,
      queries: db.queries,
      requireAuth: requireAuth as never,
      skills: { store: createSkillStore({ pool: db.pool, dataDir, now: () => FIXED_NOW }), writeMode },
      webhook: {
        verify: createOctokitVerifier(SECRET),
        db: db.pool,
        enqueue: async () => 'job-1',
        ack,
        logger: createNullLogger(),
        now: () => FIXED_NOW,
      },
      appVersion: 'test',
      now: () => FIXED_NOW,
    });

  beforeAll(async () => {
    db = await openTestDb(FIXED_NOW);
    dataDir = await mkdtemp(join(tmpdir(), 'pi-skills-http-'));
    app = makeServer(createAllowAllAuth('tester'), 'loopback');
    deniedApp = makeServer(async () => {
      throw new HttpError('unauthorized', '未登录');
    }, 'loopback');
  });

  afterAll(async () => {
    await app.close();
    await deniedApp.close();
    await rm(dataDir, { recursive: true, force: true });
    await db.close();
  });

  it('GET /api/skills 未登录 → 401（沿用既有 requireAuth）', async () => {
    const response = await deniedApp.inject({ method: 'GET', url: '/api/skills' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /api/skills → 200 + 契约形状（空列表也有 generatedAt）', async () => {
    await db.sql('truncate table skills, skill_versions, skills_audit cascade');
    const response = await app.inject({ method: 'GET', url: '/api/skills' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { generatedAt: string; skills: unknown[] };
    expect(body.skills).toEqual([]);
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('POST 缺少 X-Pi-Bot-CSRF → 403（写面第一道门）', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/skills',
      headers: { 'content-type': 'application/zip' },
      payload: Buffer.from('not a zip'),
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: { code: string } }).error.code).toBe('forbidden');
  });

  it('POST 带 CSRF 但 Origin 是外站 → 403', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/skills',
      headers: {
        'content-type': 'application/zip',
        'x-pi-bot-csrf': '1',
        origin: 'https://evil.example.com',
      },
      payload: Buffer.from('not a zip'),
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: { code: string } }).error.code).toBe('forbidden');
  });

  it('POST 带 CSRF + Sec-Fetch-Site: cross-site → 403', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/skills',
      headers: {
        'content-type': 'application/zip',
        'x-pi-bot-csrf': '1',
        'sec-fetch-site': 'cross-site',
      },
      payload: Buffer.from('not a zip'),
    });
    expect(response.statusCode).toBe(403);
  });

  it('POST 校验通过后：body 不是 zip → 400 bad-request（不 500、不入库）', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/skills',
      headers: {
        'content-type': 'application/zip',
        'x-pi-bot-csrf': '1',
        origin: 'http://localhost:5173',
      },
      payload: Buffer.from('not a zip at all'),
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad-request');
    expect(body.error.message).toContain('zip');

    const rows = await db.sql('select count(*)::int as n from skills');
    expect((rows[0] as { n: number }).n).toBe(0);
  });

  it('writeMode=off 时连本机请求也拒（PI_BOT_PANEL_WRITE=off）', async () => {
    const offApp = makeServer(createAllowAllAuth('tester'), 'off');
    try {
      const response = await offApp.inject({
        method: 'POST',
        url: '/api/skills',
        headers: { 'content-type': 'application/zip', 'x-pi-bot-csrf': '1' },
        payload: Buffer.from('not a zip'),
      });
      expect(response.statusCode).toBe(403);
      expect((response.json() as { error: { message: string } }).error.message).toContain('PI_BOT_PANEL_WRITE');
    } finally {
      await offApp.close();
    }
  });

  it('PATCH 不存在的技能 → 404（带齐写面头）', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/skills/does-not-exist',
      headers: { 'content-type': 'application/json', 'x-pi-bot-csrf': '1' },
      payload: { enabled: false },
    });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: { code: string } }).error.code).toBe('not-found');
  });

  it('PATCH 空 body 被 zod 拒（至少要改一个字段）', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/skills/whatever',
      headers: { 'content-type': 'application/json', 'x-pi-bot-csrf': '1' },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('DELETE 不存在的技能 → 404', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/skills/nope',
      headers: { 'x-pi-bot-csrf': '1' },
    });
    expect(response.statusCode).toBe(404);
  });
});
