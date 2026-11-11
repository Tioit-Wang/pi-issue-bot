/**
 * `@pi-issue-bot/envelope` —— 任务信封的 JSON Schema + Ajv 校验器 + 动作白名单/过滤器。
 *
 * 使用方：`apps/server/src/envelope`（tech-plan §8.2 的 `envelope/` 模块，只做转接）
 * 与 `apps/server/src/worker`（校验产出 → 过滤动作 → 交写执行器）。
 * 硬约束：本包不得 import `apps/*`；除 ajv/ajv-formats 外不引第三方依赖。
 *
 * 阶段扩展（`docs/plan-fixed-pipeline.md` §4.1 的顶层可选 `stage`）全部由本包 `export *` 带出：
 * `STAGE_NAMES` / `STAGE_RESULT_VALUES` / `STAGE_RESULTS_BY_NAME`（`schema.ts`）
 * 与 `validateEnvelope()` 里的 name↔result 配对校验（`validate.ts`）。
 */
export * from './schema.ts';
export * from './validate.ts';
export * from './actions.ts';
