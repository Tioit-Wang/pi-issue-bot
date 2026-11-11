/**
 * `prompt/` 的公开出口（W3-G：P1 项目人格层）。
 *
 * 三个文件各管一件事，别混：
 *  - `budget.ts`   预算口径 + **保存期预演**（纯函数，不读库）
 *  - `store.ts`    `prompt_versions` 的读写（保存即新版本、回滚也是新版本、最近装配统计）
 *  - `preview.ts`  「最终 system prompt 预览」（调的就是运行时那个 `assemblePrompt`）
 */

export {
  CONSERVATIVE_OTHER_LAYERS_CHARS,
  PROMPT_BUDGET_CHARS,
  PROMPT_LAYER_LIMITS,
  planPromptBudget,
} from './budget.ts';
export type { AssembleStatsSubset, PlanPromptBudgetInput, PromptBudget } from './budget.ts';
export {
  PROMPT_BODY_MAX_CHARS,
  PROMPT_SQL,
  PROMPT_STATS_FLAG_KEY,
  PROMPT_VERSION_RETRIES,
  activePromptBody,
  getPrompt,
  listPromptVersions,
  readLastAssembleStats,
  recordAssembleStats,
  rollbackPrompt,
  savePrompt,
  setPromptEnabled,
  withPromptSettings,
} from './store.ts';
export type { PromptState, PromptVersion, SavePromptResult } from './store.ts';
export { previewBasePrompt, previewPrompt } from './preview.ts';
export type { PreviewPromptInput, PreviewPromptResult } from './preview.ts';
/**
 * 四类提示词的 kind 级小工具（S2-a 追加）。
 *
 * `activePromptBody` / `getPrompt` / `listPromptVersions` / `savePrompt` / `rollbackPrompt`
 * 已在上面那条 `store.ts` 导出里（它们现在都带 `kind` 参数，缺省 `project`）。
 */
export { PROMPT_KIND_DEFAULT, PROMPT_KIND_POINTERS, isSystemDefault, promptLimitOf, resetPromptToDefault } from './store.ts';
