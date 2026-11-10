/**
 * Octokit 工厂 / 限流头解析 / App 认证的单测（B12；tech-plan §5.1–§5.3、§7.3）。
 *
 * 全部注入：假构造器（`createFakeOctokit`）+ 假 auth 工厂，绝不发真实请求。
 * `no-merge.test.ts` 里的「源码里不存在 merge 调用」是全局断言，本文件不重复实现。
 */
import { describe, expect, it } from 'vitest';
import {
  assertAppCredentials,
  createInstallationTokenProvider,
} from '../src/github/auth.ts';
import type { CreateAppAuthFactory } from '../src/github/auth.ts';
import {
  FALLBACK_RETRY_AFTER_MS,
  parseRateLimitHeaders,
  parseRetryAfterMs,
} from '../src/github/headers.ts';
import { GithubError } from '../src/github/errors.ts';
import { createGithubClient, createGithubReactionApi, createGithubWriteApi } from '../src/github/octokit.ts';
import type { RateLimitSignal } from '../src/github/types.ts';
import { createFakeOctokit } from './helpers/fake-github.ts';

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----';
const NOW = Date.parse('2026-06-01T00:00:00Z');

describe('限流头归一化（tech-plan §7.3 第一行）', () => {
  it('有 retry-after（秒）→ 优先用它', () => {
    const state = parseRateLimitHeaders(
      { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((NOW + 120_000) / 1000), 'retry-after': '42' },
      NOW,
    );

    expect(state.kind).toBe('rate_limit');
    if (state.kind !== 'rate_limit') {
      throw new Error('unreachable');
    }
    expect(state.retryAfterMs).toBe(42_000);
    expect(state.source).toBe('retry-after');
    expect(state.remaining).toBe(0);
  });

  it('没有 retry-after 但有 remaining=0 + reset → 用 reset 与 now 的差', () => {
    const resetAt = (NOW + 90_000) / 1000;
    const state = parseRateLimitHeaders(
      { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(resetAt) },
      NOW,
    );

    expect(state.kind).toBe('rate_limit');
    if (state.kind !== 'rate_limit') {
      throw new Error('unreachable');
    }
    expect(state.retryAfterMs).toBe(90_000);
    expect(state.source).toBe('x-ratelimit-reset');
    expect(state.resetAtMs).toBe(resetAt * 1000);
  });

  it('remaining=0 且没有任何时间信息 → 兜底等待', () => {
    const state = parseRateLimitHeaders({ 'x-ratelimit-remaining': 0 }, NOW);
    expect(state.kind).toBe('rate_limit');
    if (state.kind !== 'rate_limit') {
      throw new Error('unreachable');
    }
    expect(state.retryAfterMs).toBe(FALLBACK_RETRY_AFTER_MS);
    expect(state.source).toBe('fallback');
  });

  it('额度充足 → ok（顺带把 remaining / reset 带出去）', () => {
    const state = parseRateLimitHeaders(
      { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': '1700000000' },
      NOW,
    );

    expect(state.kind).toBe('ok');
    expect(state.remaining).toBe(4999);
    expect(state.resetAtMs).toBe(1_700_000_000_000);
  });

  it('retry-after 也接受 HTTP 日期', () => {
    const now = Date.parse('2026-06-01T00:00:00Z');
    expect(parseRetryAfterMs('Mon, 01 Jun 2026 00:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfterMs('not-a-date', now)).toBeNull();
    expect(parseRetryAfterMs(undefined, now)).toBeNull();
  });
});

describe('Octokit 工厂（注入构造器，零真实请求）', () => {
  it('非 GET 调用会被计数（M0 的「GitHub 零副作用」验收读它）', async () => {
    const fake = createFakeOctokit(() => ({ status: 200, headers: {}, data: {} }));
    const client = createGithubClient({ OctokitCtor: fake.OctokitCtor, authToken: 'test-token' });

    await client.request('GET /repos/{owner}/{repo}/issues', { owner: 'acme', repo: 'widgets' });
    expect(client.getMetrics()).toEqual({ getCalls: 1, nonGetCalls: 0 });

    await client.request('POST /repos/{owner}/{repo}/issues', { title: 'x' });
    await client.request('/repos/{owner}/{repo}/issues/{n}', { method: 'PATCH', n: 1 });
    expect(client.getMetrics()).toEqual({ getCalls: 1, nonGetCalls: 2 });

    client.resetMetrics();
    expect(client.getMetrics()).toEqual({ getCalls: 0, nonGetCalls: 0 });
  });

  it('authStrategy 被原样交给构造器（生产路径：令牌由 auth-app 自动挂上并续期）', () => {
    const fake = createFakeOctokit(() => ({ status: 200, headers: {}, data: {} }));
    const authStrategy = async (): Promise<unknown> => ({ token: 't' });

    createGithubClient({ OctokitCtor: fake.OctokitCtor, authStrategy, baseUrl: 'https://ghe.invalid/api/v3' });

    const options = fake.constructions[0];
    expect(options?.['authStrategy']).toBe(authStrategy);
    expect(options?.['baseUrl']).toBe('https://ghe.invalid/api/v3');
    expect(options?.['auth']).toBeUndefined();
  });

  it('认证必须显式给一个（authTokenProvider / authStrategy / authToken），且不能同时给两个', () => {
    const fake = createFakeOctokit(() => ({ status: 200, headers: {}, data: {} }));
    expect(() => createGithubClient({ OctokitCtor: fake.OctokitCtor })).toThrow(/authTokenProvider/);
    expect(() =>
      createGithubClient({
        OctokitCtor: fake.OctokitCtor,
        authToken: 't',
        authStrategy: async () => ({}),
      }),
    ).toThrow(/只能给一个/);
  });

  it('authTokenProvider：每次请求把令牌挂到 Authorization（App 认证的生产路径）', async () => {
    const seen: (Record<string, unknown> | undefined)[] = [];
    const fake = createFakeOctokit((route, params) => {
      seen.push(params);
      return { status: 200, headers: {}, data: { ok: true, route } };
    });
    let minted = 0;
    const client = createGithubClient({
      OctokitCtor: fake.OctokitCtor,
      authTokenProvider: async () => {
        minted += 1;
        return 'ghs_test_token';
      },
    });
    await client.request('GET /repos/{owner}/{repo}/issues', { owner: 'o', repo: 'r' });
    const headers = seen[0]?.['headers'] as Record<string, string> | undefined;
    expect(minted).toBe(1);
    expect(headers?.['authorization']).toBe('token ghs_test_token');
    expect(seen[0]?.['owner']).toBe('o');
  });

  it('成功的响应也读限流头：remaining=0 → 触发 onRateLimit 回调', async () => {
    const signals: RateLimitSignal[] = [];
    const fake = createFakeOctokit(() => ({
      status: 200,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((NOW + 60_000) / 1000) },
      data: {},
    }));
    const client = createGithubClient({
      OctokitCtor: fake.OctokitCtor,
      authToken: 'test-token',
      now: () => NOW,
      onRateLimit: (signal) => signals.push(signal),
    });

    await client.request('GET /rate_limit');

    expect(signals).toHaveLength(1);
    expect(signals[0]?.retryAfterMs).toBe(60_000);
  });

  it('失败响应：429/403 的 retry-after 被归一化成 GithubError + onRateLimit', async () => {
    const signals: RateLimitSignal[] = [];
    const fake = createFakeOctokit(() => {
      throw Object.assign(new Error('API rate limit exceeded'), {
        status: 403,
        response: { status: 403, headers: { 'retry-after': '30' }, data: {} },
      });
    });
    const client = createGithubClient({
      OctokitCtor: fake.OctokitCtor,
      authToken: 'test-token',
      now: () => NOW,
      onRateLimit: (signal) => signals.push(signal),
    });

    const failure = client.request('POST /repos/{owner}/{repo}/issues', { title: 'x' });
    await expect(failure).rejects.toBeInstanceOf(GithubError);
    await expect(failure).rejects.toMatchObject({ info: { class: 'rate_limit', status: 403 } });

    expect(signals).toHaveLength(1);
    expect(signals[0]?.retryAfterMs).toBe(30_000);
    // 失败的非 GET 尝试也要计数（零副作用看的是「有没有尝试写」）
    expect(client.getMetrics().nonGetCalls).toBe(1);
  });
});

describe('createGithubWriteApi：REST 细节集中在一处', () => {
  const buildClient = (data: unknown): { client: ReturnType<typeof createGithubClient>; fake: ReturnType<typeof createFakeOctokit> } => {
    const fake = createFakeOctokit(() => ({ status: 200, headers: {}, data }));
    const client = createGithubClient({ OctokitCtor: fake.OctokitCtor, authToken: 'test-token' });
    return { client, fake };
  };

  it('listIssueComments 走 GET 并摊平 body=null', async () => {
    const { client, fake } = buildClient([
      { id: 1, body: 'old' },
      { id: 2, body: null },
      { nonsense: true },
    ]);

    const comments = await createGithubWriteApi(client).listIssueComments({
      repo: 'acme/widgets',
      issueNumber: 42,
    });

    expect(comments).toEqual([
      { id: 1, body: 'old' },
      { id: 2, body: null },
    ]);
    expect(fake.requests[0]?.route).toBe('GET /repos/{owner}/{repo}/issues/{issue_number}/comments');
    expect(fake.requests[0]?.params).toMatchObject({ owner: 'acme', repo: 'widgets', issue_number: 42 });
  });

  it('各写动作的 route 与参数（含空标签列表时不发请求）', async () => {
    const { client, fake } = buildClient({ id: 11, html_url: 'https://x.invalid/1', number: 77 });
    const api = createGithubWriteApi(client);

    await api.createIssueComment({ repo: 'acme/widgets', issueNumber: 42, body: 'hi' });
    await api.addLabels({ repo: 'acme/widgets', issueNumber: 42, labels: ['needs-info'] });
    await api.addLabels({ repo: 'acme/widgets', issueNumber: 42, labels: [] });
    await api.removeLabel({ repo: 'acme/widgets', issueNumber: 42, label: 'needs-info' });
    await api.createIssue({ repo: 'acme/widgets', title: 't', body: 'b', labels: ['bug'] });
    await api.closeIssue({ repo: 'acme/widgets', issueNumber: 42 });

    expect(fake.requests.map((request) => request.route)).toEqual([
      'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
      'POST /repos/{owner}/{repo}/issues/{issue_number}/labels',
      'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}',
      'POST /repos/{owner}/{repo}/issues',
      'PATCH /repos/{owner}/{repo}/issues/{issue_number}',
    ]);
    expect(fake.requests[2]?.params).toMatchObject({ name: 'needs-info' });
    expect(fake.requests[3]?.params).toMatchObject({ title: 't', labels: ['bug'] });
    expect(fake.requests[4]?.params).toMatchObject({ state: 'closed', state_reason: 'not_planned' });
  });

  it('仓库标识不合法时直接报错（不拼进 URL）', async () => {
    const { client } = buildClient({});
    await expect(
      createGithubWriteApi(client).listIssueComments({ repo: 'widgets', issueNumber: 1 }),
    ).rejects.toThrow(/owner\/name/);
  });
});

describe('createGithubReactionApi：reaction 的 REST 细节（W2-D）', () => {
  const buildClient = (data: unknown): {
    client: ReturnType<typeof createGithubClient>;
    fake: ReturnType<typeof createFakeOctokit>;
  } => {
    const fake = createFakeOctokit(() => ({ status: 200, headers: {}, data }));
    const client = createGithubClient({ OctokitCtor: fake.OctokitCtor, authToken: 'test-token' });
    return { client, fake };
  };

  it('主贴：POST /issues/{n}/reactions（PR 主贴同端点），参数带 content', async () => {
    const { client, fake } = buildClient({ id: 4242, content: 'rocket' });
    const ref = await createGithubReactionApi(client).addReaction({
      repo: 'acme/widgets',
      issueNumber: 42,
      content: 'rocket',
    });

    expect(ref.id).toBe(4242);
    expect(fake.requests[0]?.route).toBe('POST /repos/{owner}/{repo}/issues/{issue_number}/reactions');
    expect(fake.requests[0]?.params).toMatchObject({ owner: 'acme', repo: 'widgets', issue_number: 42, content: 'rocket' });
  });

  it('评论级：给了 commentId 就打 /issues/comments/{id}/reactions', async () => {
    const { client, fake } = buildClient([{ id: 7, content: 'eyes', user: { login: 'pi-issue-bot[bot]' } }]);
    const entries = await createGithubReactionApi(client).listReactions({
      repo: 'acme/widgets',
      issueNumber: 42,
      commentId: 9001,
      content: 'eyes',
    });

    expect(entries).toEqual([{ id: 7, content: 'eyes', userLogin: 'pi-issue-bot[bot]' }]);
    expect(fake.requests[0]?.route).toBe('GET /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions');
    expect(fake.requests[0]?.params).toMatchObject({ comment_id: 9001, content: 'eyes', per_page: 100 });
  });

  it('删：DELETE .../reactions/{reaction_id}（主贴与评论两条路都带 reaction_id）', async () => {
    const { client, fake } = buildClient({});
    const api = createGithubReactionApi(client);

    await api.removeReaction({ repo: 'acme/widgets', issueNumber: 42, reactionId: 5 });
    await api.removeReaction({ repo: 'acme/widgets', issueNumber: 42, commentId: 9, reactionId: 6 });

    expect(fake.requests.map((request) => request.route)).toEqual([
      'DELETE /repos/{owner}/{repo}/issues/{issue_number}/reactions/{reaction_id}',
      'DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions/{reaction_id}',
    ]);
    expect(fake.requests[0]?.params).toMatchObject({ reaction_id: 5 });
    expect(fake.requests[1]?.params).toMatchObject({ comment_id: 9, reaction_id: 6 });
  });

  it('列表里缺少 user.login 的条目 → userLogin=null（归属判定会把它排除）', async () => {
    const { client } = buildClient([{ id: 1, content: 'eyes' }, { id: 2, content: 'eyes', user: {} }]);
    const entries = await createGithubReactionApi(client).listReactions({
      repo: 'acme/widgets',
      issueNumber: 1,
      content: 'eyes',
    });

    expect(entries.map((entry) => entry.userLogin)).toEqual([null, null]);
  });
});

describe('GitHub App 认证（令牌只在内存）', () => {
  const createFakeAppAuth = (): {
    factory: CreateAppAuthFactory;
    calls: Array<Readonly<Record<string, unknown>>>;
  } => {
    const calls: Array<Readonly<Record<string, unknown>>> = [];
    let counter = 0;
    const factory: CreateAppAuthFactory = () => {
      return async (options) => {
        calls.push(options as Readonly<Record<string, unknown>>);
        counter += 1;
        return {
          type: 'token',
          token: `ghs_fake_${String(counter)}`,
          tokenType: 'installation',
          installationId: 99,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        };
      };
    };
    return { factory, calls };
  };

  it('凭证形状校验：私钥不是 PEM → auth 类错误，且消息里不含私钥片段', () => {
    expect(() => assertAppCredentials({ appId: 1, privateKey: PEM })).not.toThrow();

    try {
      assertAppCredentials({ appId: 1, privateKey: 'secret-but-not-pem' });
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(GithubError);
      const info = (error as GithubError).info;
      expect(info.class).toBe('auth');
      expect(info.retry.retry).toBe(false);
      expect(info.message).not.toContain('secret-but-not-pem');
    }
  });

  it('同一安装的令牌走内存缓存，refresh 才会重新取', async () => {
    const { factory, calls } = createFakeAppAuth();
    const providers = createInstallationTokenProvider({
      credentials: { appId: 12345, privateKey: PEM },
      installationId: 99,
      createAppAuthImpl: factory,
    });

    const first = await providers.getToken();
    const second = await providers.getToken();
    expect(first.token).toBe('ghs_fake_1');
    expect(second.token).toBe('ghs_fake_1');
    expect(calls).toHaveLength(1);

    const refreshed = await providers.getToken({ refresh: true });
    expect(refreshed.token).toBe('ghs_fake_2');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ type: 'installation', installationId: 99, refresh: true });

    providers.clearCache();
    const afterClear = await providers.getToken();
    expect(afterClear.token).toBe('ghs_fake_3');
  });

  it('未指定 installationId → 明确报错（不去猜安装）', async () => {
    const { factory } = createFakeAppAuth();
    const providers = createInstallationTokenProvider({
      credentials: { appId: 12345, privateKey: PEM },
      createAppAuthImpl: factory,
    });

    await expect(providers.getToken()).rejects.toMatchObject({ info: { class: 'auth' } });
  });

  it('auth 策略返回里没有 token → auth 错误，且不回显返回值', async () => {
    const providers = createInstallationTokenProvider({
      credentials: { appId: 12345, privateKey: PEM },
      installationId: 7,
      createAppAuthImpl: () => async () => ({ somethingElse: 'leaky-value' }),
    });

    try {
      await providers.getToken();
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(GithubError);
      expect((error as GithubError).info.message).not.toContain('leaky-value');
    }
  });
});
