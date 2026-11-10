/**
 * 主实例装配（`http/server.ts`）+ 面板只读 API + `/healthz` 的测试。
 *
 * 用 **真 PostgreSQL**（读接口直接跑真查询）与 **真 HMAC**（`@octokit/webhooks` 的 verify 对
 * 我们看到的原始 body 验签）：后者顺带证明「/webhook 用了 raw body 解析器」——
 * 一旦有人把它换回 JSON parser，签名必然对不上，这条测试立刻红。
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditQuerySchema, overviewResponseSchema, tasksResponseSchema } from '../../../packages/contract/src/index.ts';
import { createNullLogger } from '../../../packages/shared/src/index.ts';
import {
  HttpError,
  buildServer,
  createAllowAllAuth,
  createOctokitVerifier,
} from '../src/http/index.ts';
import type { WebhookAck, ZodFastify } from '../src/http/index.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

const REPO = 'acme/widgets';
const SECRET = 'test-webhook-secret';
const FIXED_NOW = new Date('2026-06-01T12:00:00.000Z');

let db: TestDb;
let app: ZodFastify;
let deniedApp: ZodFastify;
let forbiddenApp: ZodFastify;

/** 签名：与 GitHub 相同的 `sha256=<hex>` 形态。 */
function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

const ack: WebhookAck = {
  addEyesReaction: async () => undefined,
};

function makeServer(requireAuth: ReturnType<typeof createAllowAllAuth> | (() => Promise<never>)): ZodFastify {
  return buildServer({
    logger: createNullLogger(),
    pool: db.pool,
    queries: db.queries,
    requireAuth: requireAuth as never,
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
}

beforeAll(async () => {
  db = await openTestDb(FIXED_NOW);
  app = makeServer(createAllowAllAuth('tester'));
  deniedApp = buildServer({
    logger: createNullLogger(),
    pool: db.pool,
    queries: db.queries,
    requireAuth: async () => {
      throw new HttpError('unauthorized', '未登录');
    },
    webhook: {
      verify: createOctokitVerifier(SECRET),
      db: db.pool,
      enqueue: async () => null,
      ack,
      logger: createNullLogger(),
    },
  });
  forbiddenApp = buildServer({
    logger: createNullLogger(),
    pool: db.pool,
    queries: db.queries,
    requireAuth: async () => {
      throw new HttpError('forbidden', '不是组织成员');
    },
    webhook: {
      verify: createOctokitVerifier(SECRET),
      db: db.pool,
      enqueue: async () => null,
      ack,
      logger: createNullLogger(),
    },
  });
});

afterAll(async () => {
  await app.close();
  await deniedApp.close();
  await forbiddenApp.close();
  await db.close();
});

/**
 * 只清本切片会写/会断言为空的表。
 *
 * 为什么不 `db.truncate()`：真库与并行 session 共用，清全库会擦掉别人（不走 advisory lock 的）
 * 测试文件的行，制造偶发红。
 */
beforeEach(async () => {
  await db.pool.query('truncate table tasks, webhook_deliveries, repos, runtime_flags cascade');
});

describe('/healthz', () => {
  it('DB 可用 → 200 且逐项给出结果（queue/doctor 未注入标 skip）', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { status: string; checks: Array<{ id: string; status: string }> };
    expect(body.status).toBe('ok');
    expect(body.checks.find((check) => check.id === 'db')?.status).toBe('ok');
    expect(body.checks.find((check) => check.id === 'queue')?.status).toBe('skip');
    expect(body.checks.find((check) => check.id === 'doctor')?.status).toBe('skip');
    // /healthz 是运维通道：不需要面板会话
    expect(response.headers['cache-control']).toBeUndefined();
  });

  it('探针失败 → 503（Caddy/systemd 只看状态码）', async () => {
    const failing = buildServer({
      logger: createNullLogger(),
      pool: db.pool,
      queries: db.queries,
      requireAuth: createAllowAllAuth(),
      webhook: {
        verify: async () => true,
        db: db.pool,
        enqueue: async () => null,
        ack,
        logger: createNullLogger(),
      },
      queueHealth: async () => [{ id: 'queue.runTask', status: 'fail', detail: '队列不可用' }],
    });
    try {
      const response = await failing.inject({ method: 'GET', url: '/healthz' });
      expect(response.statusCode).toBe(503);
      expect((response.json() as { status: string }).status).toBe('fail');
    } finally {
      await failing.close();
    }
  });
});

describe('面板只读 API', () => {
  it('/api/overview：200，响应通过契约 schema', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/overview' });
    expect(response.statusCode).toBe(200);
    // 用契约 schema 再解析一次：序列化结果必须是契约形状（多/少字段都会被抓到）
    expect(() => overviewResponseSchema.parse(response.json())).not.toThrow();
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('/api/tasks：200，分页字段齐全', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/tasks?limit=5' });
    expect(response.statusCode).toBe(200);
    const parsed = tasksResponseSchema.parse(response.json());
    expect(parsed.items).toEqual([]);
    expect(parsed.hasMore).toBe(false);
  });

  it('/api/tasks 查询参数非法（limit=abc）→ 400 bad-request + 字段明细', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/tasks?limit=abc' });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { code: string; details?: { issues?: unknown[] } } };
    expect(body.error.code).toBe('bad-request');
    expect(Array.isArray(body.error.details?.issues)).toBe(true);
  });

  it('/api/tasks/:id 不存在 → 404 not-found（不是 200 + null）', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/tasks/does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: { code: string } }).error.code).toBe('not-found');
  });

  it('/api/audit/export.csv：text/csv + BOM + 附件文件名', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/audit/export.csv?from=2026-05-01T00:00:00Z&to=2026-06-01T00:00:00Z',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(String(response.headers['content-disposition'])).toContain('attachment; filename="audit-2026-05-01T00_00_00Z-2026-06-01T00_00_00Z.csv"');
    expect(response.body.startsWith('\uFEFF')).toBe(true);
  });

  it('审计 CSV 的查询参数与 /api/audit 共用同一份 schema', () => {
    // 两边是同一个 schema 对象，避免「导出漏了某个筛选条件」
    expect(auditQuerySchema.parse({})).toMatchObject({ limit: 50 });
  });

  it('/api/system 与 /api/costs、/api/quality/reverts 都能回 200（空库）', async () => {
    for (const url of ['/api/system', '/api/costs', '/api/quality/reverts', '/api/audit']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
    }
  });

  it('★ /api/repos 已挂载（buildServer 把池子接给仓库写面）：列表 → 手动添加 → 读写 settings', async () => {
    const empty = await app.inject({ method: 'GET', url: '/api/repos' });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ items: [] });

    // 手动添加（部署默认 settings seed，source='manual'）
    const created = await app.inject({
      method: 'POST',
      url: '/api/repos',
      payload: { repo: REPO },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ repo: REPO, source: 'manual' });

    // 读 settings：默认 concurrency_per_repo=2 / queue_wait_minutes=10（多仓库改造的两个新阈值）
    const read = await app.inject({ method: 'GET', url: `/api/repos/${REPO}/settings` });
    expect(read.statusCode).toBe(200);
    const view = read.json() as {
      repo: string;
      enabled: boolean;
      settings: { limits: { concurrency_per_repo: number; queue_wait_minutes: number } };
    };
    expect(view.repo).toBe(REPO);
    expect(view.enabled).toBe(true);
    expect(view.settings.limits.concurrency_per_repo).toBe(2);
    expect(view.settings.limits.queue_wait_minutes).toBe(10);

    // 写 settings：改一个阈值后再读出来
    const write = await app.inject({
      method: 'PUT',
      url: `/api/repos/${REPO}/settings`,
      payload: {
        ...view.settings,
        limits: { ...view.settings.limits, concurrency_per_repo: 4, queue_wait_minutes: 3 },
      },
    });
    expect(write.statusCode).toBe(200);
    const reread = await app.inject({ method: 'GET', url: `/api/repos/${REPO}/settings` });
    const after = reread.json() as {
      settings: { limits: { concurrency_per_repo: number; queue_wait_minutes: number } };
    };
    expect(after.settings.limits).toMatchObject({ concurrency_per_repo: 4, queue_wait_minutes: 3 });
  });

  it('★ /api/system 的 repos[] 读 `repos` 表：新字段齐 + 老字段别名同值 + `?repo=` 只回一行', async () => {
    await db.pool.query(
      `insert into repos (repo_full_name, enabled, dry_run, settings, settings_valid, source, archived_at)
       values
         ('acme/widgets', true, false, '{"version":1}'::jsonb, true, 'installation', null),
         ('other/lib', true, true, '{"version":1}'::jsonb, false, 'manual', '2026-05-01T00:00:00Z')`,
    );
    // 让 acme/widgets 有「最近活动」（tasks.queued_at 的 max）
    await db.pool.query(
      `insert into tasks (id, source, repo, target_kind, target_number, command, actor_login, idempotency_key, queued_at, status, created_at, updated_at)
       values ('t-sys-1', 'webhook', 'acme/widgets', 'issue', 3, 'auto:triage', 'alice', 'k-sys-1',
               '2026-06-01T10:00:00Z', 'succeeded', '2026-06-01T10:00:00Z', '2026-06-01T10:00:00Z')`,
    );

    const response = await app.inject({ method: 'GET', url: '/api/system' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { repos: Array<Record<string, unknown>> };
    const byRepo = new Map(body.repos.map((item) => [String(item['repo']), item]));

    expect(byRepo.get('acme/widgets')).toMatchObject({
      enabled: true,
      dryRun: false,
      settingsValid: true,
      settingsError: null,
      configValid: true,
      configError: null,
      source: 'installation',
      archivedAt: null,
      lastActivityAt: '2026-06-01T10:00:00.000Z',
    });
    // 归档 = 不可用（enabled 被压成 false），但行还在
    expect(byRepo.get('other/lib')).toMatchObject({
      enabled: false,
      settingsValid: false,
      configValid: false,
      source: 'manual',
      archivedAt: '2026-05-01T00:00:00.000Z',
    });

    // `?repo=` 只收窄 repos / flags 两段
    const scoped = await app.inject({ method: 'GET', url: '/api/system?repo=acme/widgets' });
    expect(scoped.statusCode).toBe(200);
    expect((scoped.json() as { repos: Array<{ repo: string }> }).repos.map((item) => item.repo)).toEqual([
      'acme/widgets',
    ]);
  });

  it('/api/repos 与 /api/overview 的 `?repo=`：响应通过契约 schema', async () => {
    await db.pool.query(
      `insert into repos (repo_full_name, enabled, dry_run, settings, settings_valid)
       values ('acme/widgets', true, true, '{"version":1}'::jsonb, true)`,
    );
    const repos = await app.inject({ method: 'GET', url: '/api/repos' });
    expect(repos.statusCode).toBe(200);
    const body = repos.json() as { items: Array<Record<string, unknown>> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ repo: 'acme/widgets', settingsValid: true, source: 'manual' });

    const overview = await app.inject({ method: 'GET', url: '/api/overview?repo=acme/widgets' });
    expect(overview.statusCode).toBe(200);
    const parsed = overviewResponseSchema.parse(overview.json());
    expect(parsed.repo).toBe('acme/widgets');
  });
});

describe('鉴权语义（401 vs 403）', () => {
  it('未登录 → 401 unauthorized', async () => {
    const response = await deniedApp.inject({ method: 'GET', url: '/api/overview' });
    expect(response.statusCode).toBe(401);
    expect((response.json() as { error: { code: string } }).error.code).toBe('unauthorized');
  });

  it('不是组织成员 → 403 forbidden', async () => {
    const response = await forbiddenApp.inject({ method: 'GET', url: '/api/overview' });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: { code: string } }).error.code).toBe('forbidden');
  });

  it('/healthz 不受面板鉴权约束', async () => {
    const response = await deniedApp.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
  });
});

describe('POST /webhook', () => {
  async function seedRepo(dryRun: boolean): Promise<void> {
    await db.pool.query(
      `insert into repos (repo_full_name, enabled, dry_run, settings, settings_valid)
       values ($1, true, $2, '{"version":1}'::jsonb, true)`,
      [REPO, dryRun],
    );
  }

  function issueBody(number: number): string {
    return JSON.stringify({
      action: 'opened',
      repository: { full_name: REPO },
      sender: { login: 'alice', type: 'User' },
      issue: { number, updated_at: '2026-05-31T00:00:00Z', author_association: 'OWNER' },
    });
  }

  it('合法签名 → 200 accepted（证明 raw body 解析器没被换成 JSON parser）', async () => {
    await seedRepo(false);
    const body = issueBody(7);
    const response = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'dlv-http-1',
        'x-github-event': 'issues',
        'x-hub-signature-256': sign(SECRET, body),
      },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'accepted', action: 'enqueued', duplicate: false });
  });

  it('签名与 body 不匹配 → 401 unauthorized', async () => {
    await seedRepo(false);
    const body = issueBody(8);
    const response = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'dlv-http-2',
        'x-github-event': 'issues',
        'x-hub-signature-256': sign(SECRET, `${body} `),
      },
      payload: body,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('缺 X-GitHub-Delivery → 401', async () => {
    const body = issueBody(9);
    const response = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-hub-signature-256': sign(SECRET, body),
      },
      payload: body,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('错误映射与路由边界', () => {
  it('未知路由 → 404 + 契约错误体', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'not-found' } });
  });

  it('/metrics 不在主实例上（独立 9464 实例，tech-plan §10.1 F10）', async () => {
    const response = await app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(404);
  });
});

describe('/openapi.json（可选，tech-plan §8.3「由 zod 生成」）', () => {
  function documentedServer(): ZodFastify {
    return buildServer({
      logger: createNullLogger(),
      pool: db.pool,
      queries: db.queries,
      requireAuth: createAllowAllAuth(),
      webhook: {
        verify: async () => true,
        db: db.pool,
        enqueue: async () => null,
        ack,
        logger: createNullLogger(),
      },
      openapi: true,
    });
  }

  it('openapi:true 时 9 条路由（8 个 /api + /webhook）都在文档里，查询参数来自 zod', async () => {
    const documented = documentedServer();
    try {
      const response = await documented.inject({ method: 'GET', url: '/openapi.json' });
      expect(response.statusCode).toBe(200);
      const doc = response.json() as {
        paths: Record<string, { get?: { parameters?: Array<{ name: string }> } }>;
      };
      for (const path of [
        '/api/overview',
        '/api/tasks',
        '/api/tasks/{id}',
        '/api/costs',
        '/api/quality/reverts',
        '/api/audit',
        '/api/audit/export.csv',
        '/api/system',
        '/webhook',
      ]) {
        expect(Object.keys(doc.paths), path).toContain(path);
      }
      // 查询参数是 zod schema 展开出来的，不是手写的第二份
      expect(doc.paths['/api/tasks']?.get?.parameters?.map((param) => param.name)).toEqual(
        expect.arrayContaining(['repo', 'status', 'cursor', 'limit']),
      );
    } finally {
      await documented.close();
    }
  });

  it('默认不暴露 /openapi.json（内网也不白送路由清单）', async () => {
    const response = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(response.statusCode).toBe(404);
  });
});
