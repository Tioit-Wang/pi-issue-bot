/**
 * `runtime/` 对 workspace 包的**唯一**引入入口（含一处必须写清的技术债）。
 *
 * 为什么需要这个文件：
 *   本切片（W2-E / B6）的写权限只有 `apps/server/src/runtime/**`，而
 *   `apps/server/package.json` 目前**没有**声明 `@pi-issue-bot/shared` 与
 *   `@pi-issue-bot/racp-client` 依赖，`node_modules` 里也没有这两个 workspace 链接
 *   （`pnpm-workspace.yaml` 是对的，缺的是依赖声明 + 一次 `pnpm install`）。
 *   依赖声明与 lockfile 归 PM 独占（dev-plan §13.2 E9），本切片不得 `pnpm add`／`pnpm install`，
 *   也不得改 `apps/server/package.json`；直接写 `from '@pi-issue-bot/shared'` 会让
 *   `pnpm -r typecheck` 报 TS2307（已实测）。
 *   因此这里集中用**相对路径**引入这两个包，只此一处：
 *   PM 补上依赖后，把下面几行改回包名即可，其余文件一行都不用动。
 *
 * 依赖方向仍然满足 tech-plan §8.2 的 `runtime → racp-client`、`任何模块 → shared`：
 * 相对路径指的是同一个包的 `src/index.ts`，不是绕过包的边界去摸内部文件。
 */

// ── shared（叶子包：日志、脱敏、分类化错误、层级取消） ─────────────────────────
export {
  AppError,
  DEADLINE_EXCEEDED,
  INTERRUPTED,
  createLogger,
  createNullLogger,
  isAppError,
  previewRedacted,
  redactSecrets,
  redactValue,
  runWithDeadline,
  toAppError,
} from '../../../../packages/shared/src/index.ts';
export type {
  FailureClass,
  Logger,
  RunWithDeadlineOptions,
} from '../../../../packages/shared/src/index.ts';

// ── racp-client（三个握手常量 + 会话/事件类型） ───────────────────────────────
export {
  DEVICE_TOKEN_PREFIX,
  PAIRING_TOKEN_PREFIX,
  RACP_WS_PATH,
  RACP_WS_SUBPROTOCOL,
  RacpClient,
  RacpOps,
  assertBearerToken,
  buildRacpUrl,
  hostVersionMismatchError,
} from '../../../../packages/racp-client/src/index.ts';
export type {
  ApprovalRequest,
  EventEnvelope,
  InputRequest,
  PermissionMode,
  RequestOptions,
  SessionMode,
  WebSocketFactory,
} from '../../../../packages/racp-client/src/index.ts';
