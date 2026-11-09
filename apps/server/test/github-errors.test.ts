/**
 * GitHub 错误分类的单测（B12；tech-plan §7.3 的重试矩阵）。
 *
 * 断言的是「上层只读 `info.retry` 就能决策」这件事：
 *  - 401/403/其它 4xx → 不重试（进异常兜底）
 *  - 429 / 403+限流头 → `useStartAfter`，最多 4 次，退避按响应头
 *  - 5xx / 网络抖动 → 最多 3 次 + 指数退避
 */
import { describe, expect, it } from 'vitest';
import {
  GithubError,
  authConfigError,
  classifyGithubError,
  describeGithubError,
  isGithubError,
  toGithubError,
} from '../src/github/errors.ts';

const NOW = Date.parse('2026-06-01T00:00:00Z');

/** 造一个 Octokit `RequestError` 形状的错误（不 import 它的类，避免耦合）。 */
function requestError(status: number, message: string, headers: Record<string, string> = {}): Error {
  return Object.assign(new Error(message), {
    status,
    request: { method: 'GET', url: 'https://api.github.invalid/x', headers: {} },
    response: { status, headers, data: {} },
  });
}

describe('错误分类', () => {
  it('401 → auth，不重试', () => {
    const info = classifyGithubError(requestError(401, 'Bad credentials'), NOW);
    expect(info.class).toBe('auth');
    expect(info.status).toBe(401);
    expect(info.retry.retry).toBe(false);
  });

  it('403 且带限流头 → rate_limit，走 startAfter，最多 4 次', () => {
    const info = classifyGithubError(
      requestError(403, 'API rate limit exceeded', { 'retry-after': '20' }),
      NOW,
    );

    expect(info.class).toBe('rate_limit');
    expect(info.retryAfterMs).toBe(20_000);
    expect(info.retry).toMatchObject({
      retry: true,
      maxAttempts: 4,
      delayMs: 20_000,
      useStartAfter: true,
      backoff: false,
    });
  });

  it('403 不带限流头 → auth（权限不足 / 安装被移除）', () => {
    const info = classifyGithubError(requestError(403, 'Resource not accessible by integration'), NOW);
    expect(info.class).toBe('auth');
    expect(info.retry.retry).toBe(false);
  });

  it('429 → rate_limit（即使没有响应头也给兜底等待）', () => {
    const info = classifyGithubError(requestError(429, 'Too Many Requests'), NOW);
    expect(info.class).toBe('rate_limit');
    expect(info.retry.retry).toBe(true);
    expect(info.retry.delayMs).toBeGreaterThan(0);
  });

  it('404 / 422 → github_api，不重试', () => {
    expect(classifyGithubError(requestError(404, 'Not Found'), NOW)).toMatchObject({
      class: 'github_api',
      status: 404,
      retry: { retry: false },
    });
    expect(classifyGithubError(requestError(422, 'Validation Failed'), NOW).class).toBe('github_api');
  });

  it('5xx → github_api 且按 3 次 + 指数退避重试', () => {
    const info = classifyGithubError(requestError(502, 'Bad Gateway'), NOW);
    expect(info.class).toBe('github_api');
    expect(info.retry).toMatchObject({
      retry: true,
      maxAttempts: 3,
      delayMs: 30_000,
      useStartAfter: false,
      backoff: true,
    });
  });

  it('没有 HTTP 状态的网络错误 → network（DNS / 连接重置 / 超时）', () => {
    for (const code of ['ECONNRESET', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT']) {
      const info = classifyGithubError(Object.assign(new Error('socket hang up'), { code }), NOW);
      expect(info.class).toBe('network');
      expect(info.status).toBeNull();
      expect(info.retry.retry).toBe(true);
    }
  });

  it('既无状态也不是网络错误 → unknown，不重试', () => {
    const info = classifyGithubError(new Error('boom'), NOW);
    expect(info.class).toBe('unknown');
    expect(info.retry.retry).toBe(false);
  });

  it('request-id / documentation_url 会被保留（便于对账），但请求头不保留', () => {
    const info = classifyGithubError(
      Object.assign(requestError(404, 'Not Found', { 'x-github-request-id': 'abc123' }), {
        documentation_url: 'https://docs.github.invalid/x',
      }),
      NOW,
    );

    expect(info.requestId).toBe('abc123');
    expect(info.documentationUrl).toBe('https://docs.github.invalid/x');
    expect(JSON.stringify(info)).not.toContain('authorization');
  });
});

describe('GithubError 包装与日志摘要', () => {
  it('已经是 GithubError 时原样返回（不重复包装）', () => {
    const original = authConfigError('私钥格式不对');
    expect(isGithubError(original)).toBe(true);
    expect(toGithubError(original)).toBe(original);
    expect(classifyGithubError(original)).toBe(original.info);
  });

  it('包装后保留 cause，消息里没有令牌/私钥', () => {
    const cause = requestError(401, 'Bad credentials');
    const wrapped = toGithubError(cause, NOW);

    expect(wrapped).toBeInstanceOf(GithubError);
    expect(wrapped.cause).toBe(cause);
    expect(wrapped.info.class).toBe('auth');
    expect(describeGithubError(wrapped.info)).toContain('HTTP 401');
    expect(describeGithubError(wrapped.info)).toContain('no-retry');
  });
});
