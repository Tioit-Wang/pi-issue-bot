/**
 * 错误模型（共享叶子包）。
 *
 * `FailureClass` 是**运行期侧**的分类枚举：contract 包里的 `FAILURE_CLASSES` 是**线上格式**的权威表，
 * 二者字面量必须一致，但 shared 是叶子包、不允许 import contract（tech-plan §8.2），所以这里只做镜像，
 * 由 `apps/server/test/*` 的组合断言保证不漂移（见 apps/server/test/shared-parity.test.ts）。
 */

/** 失败分类（与 contract 的 FAILURE_CLASSES 字面量一致）。 */
export const FAILURE_CLASSES = [
  'timeout',
  'interrupt',
  'degenerate-output',
  'sandbox-oom',
  'sandbox-crash',
  'auth',
  'rate-limit',
  'model',
  'parse',
  'github-api',
  'sandbox',
  'unknown',
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** 本项目的统一错误：必须带分类，因为重试决策只读分类（tech-plan §7.3）。 */
export class AppError extends Error {
  readonly code: string;
  readonly failureClass: FailureClass;
  readonly retriable: boolean;
  readonly details?: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor(
    message: string,
    init: {
      code: string;
      failureClass: FailureClass;
      retriable?: boolean;
      details?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'AppError';
    this.code = init.code;
    this.failureClass = init.failureClass;
    this.retriable = init.retriable ?? false;
    if (init.details !== undefined) {
      this.details = init.details;
    }
    if (init.cause !== undefined) {
      this.cause = init.cause;
    }
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** 把任意抛出物归一化成 AppError（未知错误默认 `unknown` 且不重试）。 */
export function toAppError(value: unknown, fallback?: Partial<Pick<AppError, 'code' | 'failureClass'>>): AppError {
  if (isAppError(value)) {
    return value;
  }
  const message = value instanceof Error ? value.message : String(value);
  return new AppError(message, {
    code: fallback?.code ?? 'UNKNOWN',
    failureClass: fallback?.failureClass ?? 'unknown',
    cause: value,
  });
}
