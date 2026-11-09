/**
 * 沙箱执行面的共享小类型与最小日志门面。
 *
 * 这里刻意不 import `@pi-issue-bot/shared`（原因见 `errors.ts` 的文件头），
 * 但字段名与语义跟 shared 对齐：`FailureClass` 的字面量集合、logger 的五个方法。
 */

/** 与 `packages/shared/src/errors.ts` 的 `FailureClass` 字面量一致的镜像（顺序无关）。 */
export type FailureClassLike =
  | 'timeout'
  | 'interrupt'
  | 'degenerate-output'
  | 'sandbox-oom'
  | 'sandbox-crash'
  | 'auth'
  | 'rate-limit'
  | 'model'
  | 'parse'
  | 'github-api'
  | 'sandbox'
  | 'unknown';

/** 最小日志门面：只要 5 个方法，测试里可以塞一个记录器。 */
export interface SandboxLogger {
  debug(fields: Record<string, unknown>, message?: string): void;
  info(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
  error(fields: Record<string, unknown>, message?: string): void;
  child(bindings: Record<string, unknown>): SandboxLogger;
}

/** 默认空实现：不依赖日志也能跑（测试与 CLI 冷启动）。 */
export const NULL_LOGGER: SandboxLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NULL_LOGGER,
};
