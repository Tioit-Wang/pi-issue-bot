/**
 * `git/` 对 workspace 包与共享能力的**唯一**引入入口。
 *
 * 理由与 `worker/deps.ts` / `runtime/deps.ts` 完全一致：
 * `apps/server/package.json` 尚未声明 `@pi-issue-bot/shared` / `@pi-issue-bot/envelope`，
 * `node_modules` 里也没有链接，直接写包名会 TS2307；而依赖声明与 lockfile 归 PM 独占
 * （dev-plan §13.2 E9），本切片不得 `pnpm add`。于是这里集中用**相对路径**指到同一个包的
 * `src/index.ts`——依赖方向仍然满足 tech-plan §8.2（`git → envelope`、`任何模块 → shared`），
 * PM 补上依赖后把这几行改回包名即可，其余文件一行都不用动。
 */

// ── shared（分类化错误、脱敏、日志门面） ────────────────────────────────────────
export { AppError, isAppError, redactSecrets, toAppError } from '../../../../packages/shared/src/index.ts';
export type { FailureClass, Logger } from '../../../../packages/shared/src/index.ts';

// ── envelope（拒收清单的唯一权威定义） ─────────────────────────────────────────
//
// 为什么复用而不是抄一份：`envelope` 侧的清单决定「信封里的声明能不能被接受」，
// `git` 侧的清单决定「磁盘上的实际变更能不能被推出」，两者必须是同一个集合，
// 否则会出现「声明被接受、实际写回被拒」这种自相矛盾的组合。`git/` 只允许**收紧**
// （见 `paths.ts` 里的 `WRITEBACK_PROTECTED_PATTERNS`），不许放宽。
export { PROTECTED_PATH_PATTERNS, isProtectedPath } from '../../../../packages/envelope/src/index.ts';
