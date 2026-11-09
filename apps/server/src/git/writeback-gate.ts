/**
 * 写回闸门（tech-plan §5.6，M4 ⛔ 项 F2）。
 *
 * 一句话：**推送集 = declared ∩ actual**，其余全部丢弃并留痕；命中拒收清单则整次失败。
 *
 * 为什么「声明」不能单独作数：声明是模型写的文本，磁盘是内核写的状态，两者不是一个
 * 可信级别。身份挂载让容器内的写入直接落在 worktree 里——`postinstall` 里一行
 * `node evil.js` 就能改 README、改 `.git/config`、往 `.git/hooks/*` 放东西。
 * 闸门的价值正是让前者无法代替后者，所以：
 *   - `actual` 只来自 `git status --porcelain -z --untracked-files=all`（不猜、不缓存）；
 *   - `declared` 只来自信封里 `push_branch.paths`（glob 在这里展开，见 `paths.ts`）；
 *   - 命中拒收清单 → **整次写回失败**，不是「跳过那个文件」：命中意味着容器侧有人在
 *     推边界，跳过只会让这次越界悄无声息地成功一半。
 *
 * `writeback_rejected` 是**信号**而不是错误日志：它一出现就说明「容器里的代码试图改它
 * 没被允许改的地方」，M4 之前应当有告警（见 `writeback.ts` 的审计字段）。
 */
import { lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import type { RunGit } from './run-git.ts';
import {
  isWritebackProtectedPath,
  matchesDeclared,
  normalizeRepoPath,
  validateDeclaredPaths,
} from './paths.ts';
import type { WritebackRejectionReason } from './paths.ts';
import type { PathSetSummary, WritebackAudit } from './types.ts';

/** 审计里每个集合最多列多少条路径（tech-plan §5.6 第 4 条）。 */
export const MAX_AUDIT_PATHS = 200;

/** `git status --porcelain -z` 的一条记录。 */
export interface ActualChange {
  /** 相对仓库根的路径（重命名/复制时是**新**路径）。 */
  readonly path: string;
  /** porcelain 的两字符状态码（`M `、`??`、`R ` …）。 */
  readonly status: string;
  /** 重命名/复制时的**旧**路径。 */
  readonly origPath?: string;
}

/**
 * 解析 `git status --porcelain -z`。
 *
 * 为什么必须 `-z`：不加它，git 会把含空格/中文/引号的路径转义成 `"a\\tb"`，
 * 于是「声明的路径」和「实际的路径」永远对不上——而这正是闸门要比的东西。
 * `-z` 下重命名/复制的记录是两条 NUL 分隔的项：`R  <新路径>\0<旧路径>\0`。
 */
export function parseStatusPorcelainZ(stdout: string): ActualChange[] {
  const parts = stdout.split('\0');
  const changes: ActualChange[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index] ?? '';
    if (entry.length === 0) {
      continue;
    }
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path.length === 0) {
      continue;
    }
    const kind = status.slice(0, 1);
    if (kind === 'R' || kind === 'C') {
      const origPath = parts[index + 1] ?? '';
      index += 1;
      changes.push(origPath.length === 0 ? { path, status } : { path, status, origPath });
      continue;
    }
    changes.push({ path, status });
  }
  return changes;
}

/** 列出工作树里的**全部**变更（未跟踪文件也算：`--untracked-files=all`）。 */
export async function listActualChanges(input: { jobDir: string; runGit: RunGit }): Promise<ActualChange[]> {
  const result = await input.runGit(
    ['status', '--porcelain', '-z', '--untracked-files=all', '--ignore-submodules=all'],
    { cwd: input.jobDir, code: 'GIT_STATUS_FAILED' },
  );
  return parseStatusPorcelainZ(result.stdout);
}

/** 路径集合的摘要：排序后 `\n` 连接取 sha256，路径列表按上限截断。 */
export function summarizePathSet(paths: readonly string[], maxPaths: number = MAX_AUDIT_PATHS): PathSetSummary {
  const sorted = [...new Set(paths)].sort();
  const digest = createHash('sha256').update(sorted.join('\n')).digest('hex');
  return {
    count: sorted.length,
    sha256: digest,
    paths: sorted.slice(0, maxPaths),
    truncated: sorted.length > maxPaths,
  };
}

/** 文件系统探针（单测可替身；真实实现直接读磁盘）。 */
export interface PathProbe {
  lstat(target: string): Promise<{ isSymbolicLink(): boolean }>;
  realpath(target: string): Promise<string>;
}

const DEFAULT_PROBE: PathProbe = {
  lstat: async (target) => lstat(target),
  realpath: async (target) => realpath(target),
};

export interface WritebackGateInput {
  readonly jobDir: string;
  /** 信封 `push_branch.paths` 的原文（未展开）。 */
  readonly declared: readonly string[];
  readonly runGit: RunGit;
  readonly probe?: PathProbe;
  readonly maxAuditPaths?: number;
}

export interface WritebackGateAllowed {
  readonly ok: true;
  /** 归一化后的声明（glob 保持原样，已是相对仓库根形式）。 */
  readonly declared: readonly string[];
  readonly actual: readonly string[];
  /** 推送集（declared ∩ actual，含重命名的旧路径）。 */
  readonly intersect: readonly string[];
  /** actual − intersect：这些字节**不会**进入提交。 */
  readonly dropped: readonly string[];
  readonly audit: WritebackAudit;
}

export interface WritebackGateRejected {
  readonly ok: false;
  readonly code: 'WRITEBACK_REJECTED';
  readonly reason: WritebackRejectionReason;
  /** 触发拒绝的路径（供 `run_events` 与面板直接显示）。 */
  readonly paths: readonly string[];
  readonly detail: string;
  readonly audit: WritebackAudit;
}

export type WritebackGateResult = WritebackGateAllowed | WritebackGateRejected;

/** 收集一条变更涉及的全部路径（重命名有两个：新旧都算变更）。 */
function changePaths(change: ActualChange): string[] {
  return change.origPath === undefined ? [change.path] : [change.path, change.origPath];
}

/**
 * 检查 symlink 是否指向仓库外。
 *
 * 为什么必须在闸门里查，而不是靠 `git`：git 只存 symlink 的目标字符串，从不解析它。
 * 一个指向 `/etc` 的链接在 git 眼里完全正常，但它会让后续读文件的人读到仓库外的东西。
 * 返回空数组表示全都安全。
 */
async function findSymlinkEscapes(input: {
  jobDir: string;
  paths: readonly string[];
  probe: PathProbe;
}): Promise<string[]> {
  const escapes: string[] = [];
  const root = await input.probe.realpath(input.jobDir);
  for (const relative of input.paths) {
    const absolute = path.resolve(input.jobDir, relative);
    let stats: { isSymbolicLink(): boolean };
    try {
      stats = await input.probe.lstat(absolute);
    } catch (error) {
      // 被删除的路径没有 lstat 可查——那不是 symlink，跳过。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    if (!stats.isSymbolicLink()) {
      continue;
    }
    const target = await input.probe.realpath(absolute);
    const inside = target === root || target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
    if (!inside) {
      escapes.push(relative);
    }
  }
  return escapes;
}

function buildAudit(input: {
  declared: readonly string[];
  actual: readonly string[];
  intersect: readonly string[];
  dropped: readonly string[];
  maxPaths: number;
}): WritebackAudit {
  return {
    declared: summarizePathSet(input.declared, input.maxPaths),
    actual: summarizePathSet(input.actual, input.maxPaths),
    intersect: summarizePathSet(input.intersect, input.maxPaths),
    dropped: summarizePathSet(input.dropped, input.maxPaths),
  };
}

/**
 * 评估一次写回。
 *
 * 顺序是刻意的：先看磁盘（actual），再看声明（declared）。反过来的话，
 * 一个「声明合法但磁盘上动了 `.git/config`」的写回会先被 declared 放过去，
 * 再依赖于后续步骤记得再查一次——闸门只有一个检查点，就该把最危险的放前面。
 */
export async function evaluateWriteback(input: WritebackGateInput): Promise<WritebackGateResult> {
  const probe = input.probe ?? DEFAULT_PROBE;
  const maxPaths = input.maxAuditPaths ?? MAX_AUDIT_PATHS;

  const changes = await listActualChanges({ jobDir: input.jobDir, runGit: input.runGit });
  const actualPaths = [...new Set(changes.flatMap(changePaths))].sort();
  const declaredRaw = input.declared.map((item) => normalizeRepoPath(item));

  const reject = (
    reason: WritebackRejectionReason,
    paths: readonly string[],
    detail: string,
    intersect: readonly string[] = [],
  ): WritebackGateRejected => ({
    ok: false,
    code: 'WRITEBACK_REJECTED',
    reason,
    paths,
    detail,
    audit: buildAudit({
      declared: declaredRaw,
      actual: actualPaths,
      intersect,
      dropped: actualPaths.filter((item) => !intersect.includes(item)),
      maxPaths,
    }),
  });

  // 1) 实际变更命中拒收清单 → 整次失败（不是跳过）。
  const protectedActual = actualPaths.filter((item) => isWritebackProtectedPath(item));
  if (protectedActual.length > 0) {
    return reject(
      'actual-protected',
      protectedActual,
      `实际变更命中拒收清单（容器侧在推边界）：${protectedActual.join(', ')}`,
    );
  }

  // 2) 指向仓库外的 symlink → 整次失败。
  const escapes = await findSymlinkEscapes({ jobDir: input.jobDir, paths: actualPaths, probe });
  if (escapes.length > 0) {
    return reject('symlink-escape', escapes, `实际变更里有指向仓库外的 symlink：${escapes.join(', ')}`);
  }

  // 3) 声明本身不合法 → 整次失败（并给出全部原因）。
  const issues = validateDeclaredPaths(input.declared);
  if (issues.length > 0) {
    const first = issues[0];
    const reason: WritebackRejectionReason = first?.reason ?? 'declared-invalid';
    return reject(
      reason,
      issues.map((issue) => issue.path).filter((item) => item.length > 0),
      issues.map((issue) => issue.detail).join('; '),
    );
  }

  // 4) 交集：只保留被声明覆盖的**实际**变更。重命名/复制的新旧路径作为一个变更整体进出，
  //    否则「只推新路径」会在远端留下一份没被删掉的旧文件（提交语义就变了）。
  const intersect: string[] = [];
  for (const change of changes) {
    const covered = [change.path, ...(change.origPath === undefined ? [] : [change.origPath])].some((candidate) =>
      declaredRaw.some((pattern) => matchesDeclared(candidate, pattern)),
    );
    if (covered) {
      intersect.push(...changePaths(change));
    }
  }
  const intersectSet = [...new Set(intersect)].sort();
  const dropped = actualPaths.filter((item) => !intersectSet.includes(item));

  return {
    ok: true,
    declared: declaredRaw,
    actual: actualPaths,
    intersect: intersectSet,
    dropped,
    audit: buildAudit({ declared: declaredRaw, actual: actualPaths, intersect: intersectSet, dropped, maxPaths }),
  };
}
