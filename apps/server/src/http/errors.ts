/**
 * HTTP 错误映射（B10，`docs/spec/contract-api.md` §0.1/§0.2 的机械实现）。
 *
 * 三条规则：
 *  1. **只有一种错误形状**：`{ error: { code, message, details? } }`，没有第二种（契约 §0）。
 *  2. **状态码只从 `ERROR_HTTP_STATUS` 取**，不在各处手写数字：契约包里已经冻结了 code → status 的对应。
 *  3. **消息进日志/响应前先脱敏**：错误消息里可能夹带 URL 或 token（plan §10）。
 */
import { ERROR_HTTP_STATUS } from '../../../../packages/contract/src/index.ts';
import type { ErrorBody, ErrorCode } from '../../../../packages/contract/src/index.ts';
import { redactSecrets } from '../../../../packages/shared/src/index.ts';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** 错误体里 `details` 的形状（键名稳定，面板可展示）。 */
export type ErrorDetails = Record<string, unknown>;

/** 带契约错误码的错误。业务代码只管抛它，状态码由 `status` 给出。 */
export class HttpError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails | undefined;

  constructor(code: ErrorCode, message: string, details?: ErrorDetails) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return ERROR_HTTP_STATUS[this.code];
  }
}

/** 构造并抛出的快捷方式（`throw httpError('unauthorized', '验签失败')`）。 */
export function httpError(code: ErrorCode, message: string, details?: ErrorDetails): HttpError {
  return new HttpError(code, message, details);
}

/** 状态码：只读契约表。 */
export function statusOfCode(code: ErrorCode): number {
  return ERROR_HTTP_STATUS[code];
}

/** 组装契约形状的错误体；`details` 为空时**不带这个键**（`strict()` 下不能塞 undefined 键）。 */
export function errorBodyOf(code: ErrorCode, message: string, details?: ErrorDetails): ErrorBody {
  const body: ErrorBody = {
    error: {
      code,
      message: clampMessage(redactSecrets(message)),
      ...(details === undefined ? {} : { details }),
    },
  };
  return body;
}

/** `message` 契约上限 500 字符（`packages/contract/src/common.ts`）。 */
function clampMessage(message: string): string {
  const trimmed = message.trim();
  if (trimmed === '') {
    return '（无错误详情）';
  }
  return trimmed.length > 500 ? `${trimmed.slice(0, 497)}...` : trimmed;
}

export type MappedError = {
  readonly status: number;
  readonly body: ErrorBody;
};

/** Node/Fastify 侧「有 statusCode 的错误」的最小形状。 */
type StatusBearingError = {
  readonly statusCode?: unknown;
  readonly validation?: unknown;
  readonly code?: unknown;
};

const STATUS_TO_CODE: Readonly<Record<number, ErrorCode>> = {
  400: 'bad-request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not-found',
  409: 'conflict',
  413: 'payload-too-large',
  415: 'bad-request',
  422: 'unprocessable',
  // 契约里没有 429 这一档：限流是「暂时不可用」的语义，状态码保留 429 让面板能区分
  429: 'unavailable',
  500: 'internal',
  502: 'unavailable',
  503: 'unavailable',
  504: 'unavailable',
};

/**
 * 任意错误 → `{ status, body }`。
 *
 * 顺序：`HttpError` → Fastify 校验错误（400 + 字段明细）→ `statusCode` 映射 → 兜底 500。
 * 兜底一律 `internal`，且**不把原始堆栈放进响应**（只进日志）。
 */
export function mapErrorToResponse(error: unknown): MappedError {
  if (error instanceof HttpError) {
    return { status: error.status, body: errorBodyOf(error.code, error.message, error.details) };
  }

  // `queries/` 的参数类错误（`QueryError`）：用鸭子类型识别，免得 http 侧为了一个 instanceof
  // 把查询实现拖进运行期依赖。`code` 只有两种，语义与契约的 400/422 一一对应。
  const queryError = error as { name?: unknown; code?: unknown } | null;
  if (queryError?.name === 'QueryError') {
    const mapped: ErrorCode = queryError.code === 'unprocessable' ? 'unprocessable' : 'bad-request';
    return { status: statusOfCode(mapped), body: errorBodyOf(mapped, (error as Error).message) };
  }

  const shaping = error as StatusBearingError | null;
  const validation = shaping?.validation;
  if (Array.isArray(validation)) {
    // fastify-type-provider-zod 把 zod 的 issues 放在 error.validation 里
    return {
      status: statusOfCode('bad-request'),
      body: errorBodyOf('bad-request', '请求参数不合法', { issues: validation }),
    };
  }

  const fastifyError = error as Partial<FastifyError> | null;
  const statusCode = typeof fastifyError?.statusCode === 'number' ? fastifyError.statusCode : undefined;
  if (statusCode !== undefined) {
    const code = STATUS_TO_CODE[statusCode] ?? 'internal';
    const message = fastifyError?.message ?? `HTTP ${String(statusCode)}`;
    // FST_ERR_CTP_BODY_TOO_LARGE 有独立错误码，用它把 413 说清楚
    const isTooLarge = fastifyError?.code === 'FST_ERR_CTP_BODY_TOO_LARGE';
    const finalCode: ErrorCode = isTooLarge ? 'payload-too-large' : code;
    return { status: statusOfCode(finalCode), body: errorBodyOf(finalCode, message) };
  }

  const message = error instanceof Error ? error.message : String(error);
  return { status: statusOfCode('internal'), body: errorBodyOf('internal', message) };
}

/** 错误日志的最小接口（与 `@pi-issue-bot/shared` 的 `Logger.warn/error` 结构一致，可直接传）。 */
export type ErrorLogger = {
  readonly warn: (fields: Record<string, unknown>, message: string) => void;
  readonly error: (fields: Record<string, unknown>, message: string) => void;
};

/**
 * 装统一的错误处理与 404。
 *
 * 日志由 `server.ts` 的 request 级 logger 负责（那里有 `delivery_id/task_id`），
 * 这里只把「映射结果」打一条 `warn/error`，避免两处重复输出。
 */
export function registerErrorHandling(
  app: FastifyInstance,
  log?: ErrorLogger,
): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const mapped = mapErrorToResponse(error);
    const fields = {
      method: request.method,
      url: request.url,
      status: mapped.status,
      code: mapped.body.error.code,
      err: error,
    };
    if (mapped.status >= 500) {
      log?.error(fields, '请求处理失败');
    } else {
      log?.warn(fields, '请求被拒绝');
    }
    return reply.status(mapped.status).send(mapped.body);
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const body = errorBodyOf('not-found', `没有这个路由：${request.method} ${request.url}`);
    return reply.status(statusOfCode('not-found')).send(body);
  });
}
