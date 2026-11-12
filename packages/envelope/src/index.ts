/**
 * `@pi-issue-bot/envelope` —— 任务信封的 JSON Schema + Ajv 校验器 + 动作白名单/过滤器。
 *
 * 使用方：`apps/server/src/envelope`（tech-plan §8.2 的 `envelope/` 模块，只做转接）
 * 与 `apps/server/src/worker`（校验产出 → 过滤动作 → 交写执行器）。
 * 硬约束：本包不得 import `apps/*`；第三方依赖只有 ajv/ajv-formats（旧 4-intent 契约的
 * JSON Schema 校验器）与 zod（v2 产出契约的 7 动作 schema），见 `package.json`。
 *
 * 阶段扩展（`docs/plan-fixed-pipeline.md` §4.1 的顶层可选 `stage`）全部由本包 `export *` 带出：
 * `STAGE_NAMES` / `STAGE_RESULT_VALUES` / `STAGE_RESULTS_BY_NAME`（`schema.ts`）
 * 与 `validateEnvelope()` 里的 name↔result 配对校验（`validate.ts`）。
 */
export * from './schema.ts';
export * from './validate.ts';
export * from './actions.ts';
/**
 * 产出契约 v2（`docs/v21-contract.md` §4，仅 `tasks.source='agent'` 使用）。
 *
 * 与上面三个模块**并存**：旧的 4-intent 信封继续服务 `source='pipeline'|'command'` 的路径。
 * 两份契约共享的名字（目前只有 `MAX_COMMENT_BODY` 的语义，v2 侧叫 `MAX_V21_COMMENT_BODY`）
 * 刻意不复用同一个标识符：`export *` 遇到同名会变成歧义导出，而「两个数字碰巧相等」
 * 不该成为「它们必须永远相等」的承诺。
 */
export * from './v21.ts';
