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