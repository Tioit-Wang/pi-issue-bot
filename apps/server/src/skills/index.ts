/**
 * `skills/` 的公开出口（tech-plan §8.2 的命令面）。
 *
 * 四个职责各有自己的文件，调用方按需取：
 *  - `parseSkillFile` / `splitFrontmatter`  解析与校验（加载期）
 *  - `createSkillRegistry`                 内置 + 仓库技能的合并、覆盖与冲突（加载期）
 *  - `parseCommand`                        `@bot /cmd k=v` 的解析与参数校验（解析期）
 *  - `renderSkillPrompt`                   插值 + 不可信正文的围栏与截断（运行期前）
 */
export { BUILTIN_SKILL_FILES, BUILTIN_SKILL_NAMES } from './builtin.ts';
export { bestEffortName, FRONTMATTER_FENCE, normalizeSkillName, parseSkillFile, splitFrontmatter } from './frontmatter.ts';
export type { FrontmatterSplit, ParsedSkillFile } from './frontmatter.ts';
export {
  canonicalSkillName,
  createSkillRegistry,
  defaultRequiresRepoConfigSatisfied,
  REPO_SKILLS_DIR,
  sortSkillNames,
  UNNAMED_SKILL,
} from './registry.ts';
export type { SkillDiagnostic, SkillRegistry, SkillRegistryOptions } from './registry.ts';
export {
  allowedIntentsOf,
  fenceUntrusted,
  isRenderableSkill,
  PROMPT_LIMITS,
  renderSkillPrompt,
  sanitizeUntrustedText,
  UNTRUSTED_SENTINEL,
} from './prompt.ts';
export type {
  RenderSkillPromptInput,
  RenderSkillPromptResult,
  RenderSkillPromptStats,
  SkillPromptContext,
} from './prompt.ts';
export { DEFAULT_COMMAND_MENTION, parseCommand, parseCommandMention, usageMessage } from './command.ts';
export type { CommandParseOptions, CommandParseResult, CommandRejectReason, ParsedCommand } from './command.ts';
export { toSkillSummary } from './types.ts';
export type {
  SkillDefinition,
  SkillDisabledReason,
  SkillEntry,
  SkillFile,
  SkillSource,
  SkillSummary,
} from './types.ts';

// ── M1：提示词装配（AGENTS.md + 技能层）──────────────────────────────────────
export { collectAgentsMd } from './agents-md.ts';
export type { AgentsMdResult, AgentsMdSection, CollectAgentsMdInput } from './agents-md.ts';
export { assemblePrompt, DEFAULT_ASSEMBLE_BUDGET_CHARS, stageLayers } from './assemble.ts';
export type {
  AssemblePromptInput,
  AssemblePromptResult,
  AssemblePromptStats,
  AssembleSkillLayer,
  AssembleStage,
  AssembleStageLayer,
} from './assemble.ts';

// ── S2-a：四类提示词（`kind=project|format_check|classify|agent`）────────────────
export {
  STAGE_PROMPT_DEFAULTS,
  STAGE_PROMPT_PLACEHOLDERS,
  STAGE_REQUIRED_PLACEHOLDERS,
  STAGE_PROMPT_KINDS,
  ASSEMBLE_STAGE_OF_KIND,
  GATE_NOTICE_PROMPT,
  PIPELINE_PROMPT_LIMITS,
  isStageKind,
  pipelinePromptLimit,
  stagePromptDefault,
} from './stage-prompts.ts';
export type { StagePromptKind } from './stage-prompts.ts';
export {
  STAGE_SUPPLEMENT_LIMITS,
  renderGateNoticePrompt,
  renderStageLabelList,
  renderStagePrompt,
  validateStagePrompt,
} from './prompt.ts';
export type {
  RenderStagePromptInput,
  RenderStagePromptResult,
  StagePromptIssues,
  StagePromptLimits,
  StagePromptSupplement,
  StagePromptVars,
} from './prompt.ts';

// ── M2：zip → 技能包 → 存储 ───────────────────────────────────────────────────
export { readZipEntries, ZIP_LIMITS, ZipError } from './zip.ts';
export type { ZipEntry, ZipErrorCode } from './zip.ts';
export { extractSkillBundle, SKILL_ENTRY_FILE } from './bundle.ts';
export type { SkillBundle, SkillBundleFile, SkillBundleValidation } from './bundle.ts';
export { createSkillStore, SkillStoreError, treeHashOf } from './store.ts';
export type {
  SkillAuditAction,
  SkillFileText,
  SkillListFilter,
  SkillStore,
  SkillStoreOptions,
  SkillUploadInput,
  SkillUploadResult,
} from './store.ts';