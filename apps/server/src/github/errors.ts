/**
 * GitHub 错误分类（tech-plan §7.3 的重试矩阵要用它）。
 *
 * 归一化目标：把 Octokit 抛出的 `RequestError`、Node 的网络错误、以及我们自己包的
 * `GithubError` 统一成一个 `GithubErrorInfo`，让上层的重试决策**只读一个字段**
 * （`info.retry`），不必在各处判断 HTTP 状态码。
 *
 * 安全边界：本模块只搬运 `status` / `message` / `request-id` / 限流头数字，
 * **不保留请求头与请求体**——那里可能有 installation token（tech-plan §5.2：
 * 令牌只在请求期持有，不落盘、不写日志）。
 */
import { readHeader, parseRateLimitHeaders, FALLBACK_RETRY_AFTER_MS } from './headers.ts';
import type { HeaderBag } from './types.ts';

/**
 * 四个主分类 + 两个兜底：
 *  - `auth`：401，或 403 且不是限流（权限不足 / 令牌失效 / 安装被移除）
 *  - `rate_limit`：429，或 403 带限流头，或响应头表明额度已用尽
 *  - `github_api`：其余 HTTP 错误（404 / 422 / 5xx 等）
 *  - `network`：没拿到 HTTP 响应（DNS / 连接重置 / 超时）
 *  - `unknown`：以上都不是
 */
export type GithubErrorClass = 'auth' | 'rate_limit' | 'github_api' | 'network' | 'unknown';

/**
 * 重试建议。字段直接对应 tech-plan §7.3 的第二张表：
 *  - 429 → `useStartAfter`（`boss.send(..., { startAfter })`，最多 4 次）
 *  - 5xx / 网络抖动 → `retryLimit: 3` + `retryDelay: 30` + `retryBackoff: true`
 *  - 401/403/其它 4xx、结果解析失败、命令级/任务级超时 → 不重试
 */
export type RetryAdvice = {
  readonly retry: boolean;
  readonly maxAttempts: number;
  readonly delayMs: number;
  /** true 表示走定时重投（`startAfter`），false 表示走 pg-boss 的 `retryLimit`。 */
  readonly useStartAfter: boolean;
  readonly backoff: boolean;
};

/** 归一化后的错误信息（可安全写进 `runs.failure_detail` / 日志）。 */
export type GithubErrorInfo = {
  readonly class: GithubErrorClass;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly message: string;
  readonly requestId: string | null;
  readonly documentationUrl: string | null;
  readonly retry: RetryAdvice;
};

/** 本层统一抛出的错误类型；`instanceof` 在跨模块边界上仍然可用。 */
export class GithubError extends Error {
  readonly info: GithubErrorInfo;

  constructor(info: GithubErrorInfo, options?: { readonly cause?: unknown }) {
    super(info.message, options);
    this.name = 'GithubError';
    this.info = info;
  }
}

/** 5xx / 网络抖动：`retryLimit: 3`, `retryDelay: 30`, `retryBackoff: true`。 */
const TRANSIENT_RETRY: RetryAdvice = {
  retry: true,
  maxAttempts: 3,
  delayMs: 30_000,
  useStartAfter: false,
  backoff: true,
};

const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** 403 里出现这些字样时，GitHub 说的是「限流」，不是「你权限不够」。 */
const RATE_LIMIT_MESSAGE_PATTERN = /rate limit|secondary rate|abuse detection/i;

/** `instanceof` 判据（被测函数可能收到被包装过或被序列化的错误）。 */
export function isGithubError(error: unknown): error is GithubError {
  return error instanceof GithubError;
}

/** 不重试的建议（401/403/其它 4xx、解析失败、配置错误）。 */
export const NO_RETRY_ADVICE: RetryAdvice = {
  retry: false,
  maxAttempts: 1,
  delayMs: 0,
  useStartAfter: false,
  backoff: false,
};

/**
 * 把任意错误归一化成 `GithubErrorInfo`。
 *
 * `now` 可注入：`x-ratelimit-reset` 是绝对时间戳，测试必须能固定「现在」。
 */
export function classifyGithubError(error: unknown, now: number = Date.now()): GithubErrorInfo {
  if (isGithubError(error)) {
    return error.info;
  }

  const record = asRecord(error);
  const status = extractStatus(record);
  const headers = extractErrorHeaders(error);
  const message = extractMessage(error, record);
  const requestId = readHeader(headers, 'x-github-request-id') ?? null;
  const documentationUrl =
    typeof record?.['documentation_url'] === 'string' ? record['documentation_url'] : null;
  const code = typeof record?.['code'] === 'string' ? record['code'] : null;
  const isNetwork = code !== null && NETWORK_ERROR_CODES.has(code);

  const rateLimit = parseRateLimitHeaders(headers, now);
  const limited = rateLimit.kind === 'rate_limit';
  const mentionsRateLimit = RATE_LIMIT_MESSAGE_PATTERN.test(message);

  let errorClass: GithubErrorClass;
  if (status === 429 || (limited && (status === null || status === 403)) || (status === 403 && mentionsRateLimit)) {
    errorClass = 'rate_limit';
  } else if (status === 401 || status === 403) {
    errorClass = 'auth';
  } else if (status !== null) {
    errorClass = 'github_api';
  } else if (isNetwork) {
    errorClass = 'network';
  } else {
    errorClass = 'unknown';
  }

  const retryAfterMs = limited
    ? rateLimit.retryAfterMs
    : errorClass === 'rate_limit'
      ? FALLBACK_RETRY_AFTER_MS
      : null;

  return {
    class: errorClass,
    status,
    retryAfterMs,
    message: message === '' ? `${errorClass} error without message` : message,
    requestId,
    documentationUrl,
    retry: retryAdviceFor(errorClass, status, retryAfterMs),
  };
}

/** 归类 + 包成 `GithubError`（octokit.ts 的 catch 分支用它，保证上层只 catch 一种类型）。 */
export function toGithubError(error: unknown, now: number = Date.now()): GithubError {
  if (isGithubError(error)) {
    return error;
  }
  return new GithubError(classifyGithubError(error, now), { cause: error });
}

/** 供日志/审计使用的摘要（不含任何请求头或令牌）。 */
export function describeGithubError(info: GithubErrorInfo): string {
  const status = info.status === null ? 'no-response' : `HTTP ${String(info.status)}`;
  const retry = info.retry.retry
    ? `retry<=${String(info.retry.maxAttempts)} in ${String(info.retry.delayMs)}ms`
    : 'no-retry';
  return `[${info.class}] ${status} ${info.message} (${retry})`;
}

function retryAdviceFor(
  errorClass: GithubErrorClass,
  status: number | null,
  retryAfterMs: number | null,
): RetryAdvice {
  if (errorClass === 'rate_limit') {
    return {
      retry: true,
      // tech-plan §7.3：429「最多 4 次」，退避时长按响应头决定，所以不用 retryLimit
      maxAttempts: 4,
      delayMs: retryAfterMs ?? FALLBACK_RETRY_AFTER_MS,
      useStartAfter: true,
      backoff: false,
    };
  }
  if (errorClass === 'network') {
    return TRANSIENT_RETRY;
  }
  if (errorClass === 'github_api' && status !== null && status >= 500) {
    return TRANSIENT_RETRY;
  }
  return NO_RETRY_ADVICE;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function extractStatus(record: Record<string, unknown> | null): number | null {
  if (record === null) {
    return null;
  }
  // Octokit 的 RequestError：status 直接在顶层；个别包只给 response.status
  const direct = record['status'];
  if (typeof direct === 'number' && Number.isFinite(direct)) {
    return direct;
  }
  const statusCode = record['statusCode'];
  if (typeof statusCode === 'number' && Number.isFinite(statusCode)) {
    return statusCode;
  }
  const response = asRecord(record['response']);
  const nested = response?.['status'];
  if (typeof nested === 'number' && Number.isFinite(nested)) {
    return nested;
  }
  return null;
}

/** 从错误对象里取响应头（octokit.ts 的限流钩子要用；同样不保留请求头）。 */
export function extractErrorHeaders(error: unknown): HeaderBag | undefined {
  const response = asRecord(asRecord(error)?.['response']);
  const headers = response?.['headers'];
  if (typeof headers === 'object' && headers !== null) {
    return headers as HeaderBag;
  }
  return undefined;
}

/**
 * 认证/配置类错误（缺 App 凭证、私钥格式不对、解析不出 token）。
 *
 * **只传描述，不传私钥或令牌**：这两者永远不进 message、不进日志（tech-plan §5.2）。
 */
export function authConfigError(message: string): GithubError {
  return new GithubError({
    class: 'auth',
    status: null,
    retryAfterMs: null,
    message,
    requestId: null,
    documentationUrl: null,
    retry: NO_RETRY_ADVICE,
  });
}

function extractMessage(error: unknown, record: Record<string, unknown> | null): string {
  if (error instanceof Error && error.message !== '') {
    return error.message;
  }
  const message = record?.['message'];
  if (typeof message === 'string') {
    return message;
  }
  return '';
}
