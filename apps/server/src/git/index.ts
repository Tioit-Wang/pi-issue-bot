/**
 * `git/` 模块的公开出口（tech-plan §8.2 的执行面之一）。
 *
 * 三组能力：
 * 1. **检出**：`RepoCache` + `createRepoWorktreePort`（clone 缓存 / worktree / 回收）。
 * 2. **写回闸门**：`evaluateWriteback`（declared ∩ actual + 拒收清单 + 审计摘要）
 *    → `createWritebackCommit`（临时索引）→ `pushCommit`（`bot/*`、无 force、askpass）。
 *    一步到位用 `runWriteback`。
 * 3. **回收**：`cleanupBotBranches`。
 *
 * 依赖注入：所有 git 调用都经 `RunGit`，生产用 `createExecFileRunGit()`，
 * 测试用同一个工厂包一层记录 argv（断言「没有 --force」就是这么做的）。
 */
export { AppError } from './deps.ts';

export {
  GIT_BASE_ARGS,
  assertNoForceArgs,
  createExecFileRunGit,
  gitLines,
  gitOutput,
} from './run-git.ts';
export type { ExecFileRunGitOptions, GitResult, RunGit, RunGitOptions } from './run-git.ts';

export {
  MAX_DECLARED_PATH_LENGTH,
  WRITEBACK_PROTECTED_PATTERNS,
  WRITEBACK_REJECTION_REASONS,
  globToRegExp,
  isGlobPattern,
  isWritebackProtectedPath,
  matchesDeclared,
  normalizeRepoPath,
  validateDeclaredPaths,
} from './paths.ts';
export type { DeclaredPathIssue, WritebackRejectionReason } from './paths.ts';

export { RepoCache } from './repo-cache.ts';
export type { CacheRepo, PreparedWorktree, RepoCacheOptions } from './repo-cache.ts';

export { createRepoWorktreePort, defaultRemoteUrl } from './worktree-port.ts';
export type { RepoWorktreePortOptions } from './worktree-port.ts';

export {
  MAX_AUDIT_PATHS,
  evaluateWriteback,
  listActualChanges,
  parseStatusPorcelainZ,
  summarizePathSet,
} from './writeback-gate.ts';
export type {
  ActualChange,
  PathProbe,
  WritebackGateAllowed,
  WritebackGateInput,
  WritebackGateRejected,
  WritebackGateResult,
} from './writeback-gate.ts';

export {
  WRITEBACK_INDEX_REL,
  createWritebackCommit,
  indexSnapshotsEqual,
  snapshotIndex,
  worktreeIndexPath,
  writebackCommitMessage,
} from './commit-tree.ts';
export type { CreateWritebackCommitInput, CreateWritebackCommitResult } from './commit-tree.ts';

export {
  BOT_BRANCH_RE,
  TOKEN_ENV_KEY,
  assertBotBranch,
  createAskpassScript,
  deleteBotBranch,
  isBotBranch,
  pushCommit,
} from './push.ts';
export type { AskpassScript, DeleteBotBranchInput, PushCommitInput, PushCommitResult } from './push.ts';

export { WRITEBACK_REJECTED, runWriteback, toWritebackAuditRecord } from './writeback.ts';
export type {
  WritebackEmpty,
  WritebackInput,
  WritebackPushed,
  WritebackRejected,
  WritebackResult,
} from './writeback.ts';

export { cleanupBotBranches, parseLsRemote } from './branch-cleanup.ts';
export type {
  BotBranchCleanupInput,
  BotBranchCleanupResult,
  BotBranchRecord,
  SkippedBotBranch,
} from './branch-cleanup.ts';

export type { IndexSnapshot, PathSetSummary, WritebackAudit } from './types.ts';
