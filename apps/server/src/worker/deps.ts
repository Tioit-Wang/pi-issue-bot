/**
 * `worker/` 对 workspace 包与跨模块类型的**唯一**引入入口。
 *
 * 为什么需要这一层（与 `runtime/deps.ts` 同一个理由）：
 * `apps/server/package.json` 没有声明 `@pi-issue-bot/shared` / `@pi-issue-bot/envelope`
 * 依赖，`node_modules` 里也没有对应链接，直接写包名会 TS2307。
 * 依赖声明与 lockfile 归 PM 独占（dev-plan §13.2 E9），本切片不得 `pnpm add`。
 * 于是这里集中用**相对路径**指向同一个包的 `src/index.ts`——
 * 依赖方向仍然满足 tech-plan §8.2（`worker → envelope`、`任何模块 → shared`），
 * PM 补上依赖后把这几行改回包名即可，其余文件一行都不用动。
 */

// ── shared（日志、分类化错误、层级取消） ───────────────────────────────────────
export {
  AppError,
  DEADLINE_EXCEEDED,
  INTERRUPTED,
  createLogger,
  createNullLogger,
  isAppError,
  runWithDeadline,
  toAppError,
} from '../../../../packages/shared/src/index.ts';
export type { FailureClass as SharedFailureClass, Logger } from '../../../../packages/shared/src/index.ts';

// ── envelope（校验 + 动作过滤） ────────────────────────────────────────────────
export {
  DROP_REASON_TEXT,
  filterActions,
  parseEnvelopeJson,
  summarizeIssues,
  validateEnvelope,
} from '../../../../packages/envelope/src/index.ts';
export type {
  DroppedAction,
  EnvelopeAction,
  EnvelopeValidationResult,
  TaskEnvelope,
} from '../../../../packages/envelope/src/index.ts';

// ── racp-client 的事件类型（worker 只读事件，不建连接） ────────────────────────
export type { EventEnvelope } from '../../../../packages/racp-client/src/index.ts';
