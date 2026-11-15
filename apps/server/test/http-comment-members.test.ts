/**
 * `PUT /api/repos/:owner/:name/settings` 的角色成员校验（需求 §6.6 两个坑，审计 `CC-3` / `CC-4`）。
 *
 * 这里测的是**HTTP 语义**（真库 + 真路由），三件事：
 *  1. 拼错的账号 → 400 `bad-request`，错误消息点名 login，**库里保持 last-known-good**；
 *  2. 账号存在 → 200，并且落库的成员已经是 `{login, id}`（判定侧才能按 id 匹配）；
 *  3. 本部署没注入 GitHub 凭据 → 503 `unavailable`，不静默放行。
 *
 * 假件是注入的 `GithubUserLookup` 端口（`vi.mock` 在仓库里是硬禁）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createNullLogger } from '../../../packages/shared/src/index.ts';
import { buildServer, createAllowAllAuth, createOctokitVerifier } from '../src/http/index.ts';
import type { WebhookAck, ZodFastify } from '../src/http/index.ts';
import type { GithubUserLookup } from '../src/github/users.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';
import { validRepoSettings } from './helpers/repo-settings.ts';

const REPO = 'acme/widgets';
const SECRET = 'test-webhook-secret';

let db: TestDb;
let app: ZodFastify;
let appWithoutLookup: ZodFastify;

const ack: WebhookAck = {
  addEyesReaction: async () => undefined,
};

/** 假查询端口：GitHub 上只有 `alice`（id 1001）。 */
const lookup: GithubUserLookup = {
  async findUser(login: string) {
    return login.toLowerCase() === 'alice' ? { login: 'Alice', id: 1001 } : null;
  },
};

function makeServer(githubUsers: GithubUserLookup | undefined): ZodFastify {
  return buildServer({
    logger: createNullLogger(),
    pool: db.pool,
    queries: db.queries,
    requireAuth: createAllowAllAuth() as never,
    webhook: {
      verify: createOctokitVerifier(SECRET),
      db: db.pool,
      enqueue: async () => 'job-1',
      ack,
      logger: createNullLogger(),
      now: () => new Date('2026-06-01T12:00:00.000Z'),
    },
    ...(githubUsers === undefined ? {} : { githubUsers }),
    appVersion: 'test',
  });
}

/** 带一个「指定成员」角色的合法配置（成员写法可换）。 */
function settingsWithMembers(members: readonly unknown[]) {
  return validRepoSettings({
    comment: {
      mentions: [{ keyword: 'pi-bot' }],
      roles: [{ name: '值班同学', by: 'members', members }],
    },
    triggers: {
      events: { 'issue_comment.created': { gates: { require_role: true, allow_roles: ['值班同学'] } } },
    },
  });
}

type SettingsView = {
  settings: { comment: { roles: { by: string; members?: unknown }[] } } | null;
};

/** 读当前库里那一行 settings 的角色清单（断言只看这一格）。 */
async function readMembers(target: ZodFastify = app): Promise<unknown> {
  const response = await target.inject({ method: 'GET', url: `/api/repos/${REPO}/settings` });
  expect(response.statusCode).toBe(200);
  const view = response.json() as SettingsView;
  const role = view.settings?.comment.roles.find((item) => item.by === 'members');
  return role?.members ?? null;
}

async function put(target: ZodFastify, members: readonly unknown[]) {
  return target.inject({
    method: 'PUT',
    url: `/api/repos/${REPO}/settings`,
    payload: settingsWithMembers(members),
  });
}

describe('保存配置时校验角色成员（CC-3 / CC-4）', () => {
  beforeAll(async () => {
    db = await openTestDb();
    app = makeServer(lookup);
    appWithoutLookup = makeServer(undefined);
  });

  afterAll(async () => {
    // `beforeAll` 里 `openTestDb()` 可能因环境问题（迁移撞号 / 没有库）先失败：
    // 那时 `db` 还是 undefined，这里不该再抛一个「读 undefined」的噪音错误盖住真正的原因。
    await db?.close();
  });

  beforeEach(async () => {
    await db.truncate();
    const created = await app.inject({ method: 'POST', url: '/api/repos', payload: { repo: REPO } });
    expect(created.statusCode).toBe(201);
  });

  it('拼错的 login → 400 bad-request，错误点名 @alcie，库里没有写进这条配置', async () => {
    const response = await put(app, ['alcie']);
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { code: string; message: string; details?: { issues?: string[] } } };
    expect(body.error.code).toBe('bad-request');
    expect(body.error.message).toContain('@alcie');
    expect(body.error.details?.issues).toContain('comment.roles.members: GitHub 上不存在账号 @alcie');

    // last-known-good：库里仍是部署默认配置（没有「值班同学」这个角色）
    expect(await readMembers()).toBeNull();
  });

  it('账号存在 → 200，且落库的成员已解析成 {login, id}（login 用 GitHub 的规范写法）', async () => {
    const response = await put(app, ['alice']);
    expect(response.statusCode).toBe(200);
    expect(await readMembers()).toEqual([{ login: 'Alice', id: 1001 }]);
  });

  it('本部署没有 GitHub 凭据 → 503 unavailable（不静默保存拼写无法校验的成员）', async () => {
    const response = await put(appWithoutLookup, ['alice']);
    expect(response.statusCode).toBe(503);
    const body = response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('unavailable');
    expect(body.error.message).toContain('没有可用的 GitHub 凭据');
    expect(await readMembers()).toBeNull();
  });

  it('不带成员角色的配置照旧能保存（校验只对「指定成员」生效）', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/repos/${REPO}/settings`,
      payload: validRepoSettings({
        comment: {
          mentions: [{ keyword: 'pi-bot' }],
          roles: [{ name: '维护者', by: 'association', any_of: ['OWNER', 'MEMBER'] }],
        },
        triggers: {
          events: { 'issue_comment.created': { gates: { require_role: true, allow_roles: ['维护者'] } } },
        },
      }),
    });
    expect(response.statusCode).toBe(200);
  });
});
