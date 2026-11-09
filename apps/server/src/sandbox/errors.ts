/**
 * 沙箱执行面（B7）的错误模型。
 *
 * 为什么不 import `@pi-issue-bot/shared` 的 `AppError`：本切片开工时 `apps/server/package.json`
 * 还没有 `@pi-issue-bot/shared` 依赖（本 session 被禁止改 package.json 与跑 `pnpm install`，
 * 见 dev-plan §11 E9），从 `apps/server` 里 import 那个包会直接 `ERR_MODULE_NOT_FOUND`。
 * 这里放一个**结构兼容**的最小实现（同样带 `code` / `failureClass` / `details`），
 * 等 PM 把 shared 依赖接进 server 后可以直接替换，不影响调用方（字段名一致）。
 */
import type { FailureClassLike } from './types.ts';

/** 沙箱内部的错误码。前四个直接决定 exec-client 的退出码（dev-plan §11 E7）。 */
export const SANDBOX_ERROR_CODES = [
  /** 请求帧不合规：不是正文要求的 `{argv,cwd,clientPid}`。 */
  'BAD_REQUEST',
  /** socket 在监听，但映射表里没有这个端点（容器已销毁或代理重启）。 */
  'NO_JOB_MAPPING',
  /** `cwd` 解析后不在该 job 的 job_dir 内（dev-plan §11 E7：报错退 3，禁止静默回退）。 */
  'CWD_OUTSIDE_JOB',
  /** 目标容器已经不存在。 */
  'CONTAINER_GONE',
  /** docker exec 本身失败（帧层拿不到退出码）。 */
  'EXEC_FAILED',
  /** 宿主侧看门狗触发（容器内 `timeout` 没生效时的最后一道保险，§4.7）。 */
  'EXEC_TIMEOUT',
  /** docker daemon 不可达。 */
  'DOCKER_UNAVAILABLE',
] as const;

export type SandboxErrorCode = (typeof SANDBOX_ERROR_CODES)[number];

/**
 * 错误码 → exec-client 退出码。
 * E7 的裁定是**两条硬编码**：`NO_EXEC_ENDPOINT` 退 2、`CWD_OUTSIDE_JOB` 退 3；其余退 1。
 * 这条映射写在 TS 与 `exec-client.mjs` 各一份（客户端是独立可执行文件，不能回引 TS），
 * 由 `test/sandbox-protocol.test.ts` 用文本断言两边一致。
 */
export const EXIT_CODE_BY_ERROR_CODE: Readonly<Record<string, number>> = Object.freeze({
  NO_EXEC_ENDPOINT: 2,
  CWD_OUTSIDE_JOB: 3,
});

/** 取退出码：未列出的错误码统一 1（"跑失败"，与"找不到端点"要区分开）。 */
export function exitCodeForErrorCode(code: string): number {
  return EXIT_CODE_BY_ERROR_CODE[code] ?? 1;
}

export class SandboxError extends Error {
  readonly code: string;
  readonly failureClass: FailureClassLike;
  readonly details?: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor(
    message: string,
    init: {
      code: SandboxErrorCode | string;
      failureClass?: FailureClassLike;
      details?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'SandboxError';
    this.code = init.code;
    // 默认 `sandbox`：重试策略读这个字段（tech-plan §7.3），沙箱层默认不自动重试。
    // OOM / 超时的细分发生在调用方（lifecycle 采 OOMKilled 之后），不在这里猜。
    this.failureClass = init.failureClass ?? 'sandbox';
    if (init.details !== undefined) {
      this.details = init.details;
    }
    if (init.cause !== undefined) {
      this.cause = init.cause;
    }
  }
}

export function isSandboxError(value: unknown): value is SandboxError {
  return value instanceof SandboxError;
}

/** 把任何抛出物归一成 SandboxError，避免调用方到处 `instanceof`。 */
export function toSandboxError(
  value: unknown,
  fallback?: { code?: SandboxErrorCode | string; failureClass?: FailureClassLike },
): SandboxError {
  if (isSandboxError(value)) {
    return value;
  }
  const message = value instanceof Error ? value.message : String(value);
  return new SandboxError(message, {
    code: fallback?.code ?? 'EXEC_FAILED',
    failureClass: fallback?.failureClass ?? 'sandbox',
    cause: value,
  });
}
