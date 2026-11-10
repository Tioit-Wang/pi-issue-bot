/**
 * AGENTS.md 加载：仓库根（总是）+ 就近子目录（按任务涉及的路径向上找，最多 3 个）。
 *
 * 为什么这一层要单独一个文件、且**不**复用技能加载：
 *  - 来源不同：技能来自内置/仓库/面板，AGENTS.md 只来自 worktree（检出后的真实文件）；
 *  - 生命周期不同：技能是「按命令展开」的，AGENTS.md 是「总是进上下文的仓库约定」（spec §2.2 的映射）；
 *  - 信任级别相同：两者都是**仓库内容**，可能被人改成提示注入，所以都要过
 *    `sanitizeUntrustedText` + `fenceUntrusted`（spec §8「提示词注入」那一行）。
 *
 * 三条硬约束（都能被单测钉住）：
 *  1. **只读 `worktreeDir` 内部**：任何解析后落在 worktree 之外的路径（`..`、绝对路径、盘符、
 *     UNC）都不读，记进 `skipped`。符号链接一律不跟随（否则一个 `ln -s /etc AGENTS.md`
 *     就能把宿主文件读出来）；文件本身 realpath 后再判一次包含关系，防「中间目录是软链」。
 *  2. **限长**：根 ≤4000 字符，就近各 ≤2000 字符、合计 ≤6000 字符（spec §7），
 *     单文件 >1 MB 直接跳过（进 `skipped`，不是截断——1 MB 的 markdown 不是约定，是攻击/误提交）。
 *  3. **返回的 `text` 已经包好围栏**：装配层不再二次包裹，也不做转义。
 *
 * 文件不存在**不算错误**（缺省只是少一段上下文，spec R7 第一条）。
 */
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { fenceUntrusted, sanitizeUntrustedText } from './prompt.ts';

/** 约定的文件名（跨 Codex / Cursor / Amp / Zed 的事实标准，spec §2.2）。 */
export const AGENTS_MD_FILENAME = 'AGENTS.md';

/** 各类上限（spec §7 与 §8 的数字，集中在这里便于测试引用）。 */
export const AGENTS_MD_LIMITS = {
  /** 仓库根：总是进上下文，所以给得最宽。 */
  rootMaxChars: 4_000,
  /** 单个就近文件。 */
  nearbyMaxChars: 2_000,
  /** 全部就近文件合计（防 3 个 2000 字符把上下文吃掉）。 */
  nearbyTotalChars: 6_000,
  /** 就近最多几个。 */
  maxNearby: 3,
  /** 单文件字节上限：超过直接跳过（不进 `root`/`nearby`，记 `skipped`）。 */
  maxFileBytes: 1_048_576,
} as const;

/** 截断标记（可见，且不会被 `sanitizeUntrustedText` 的规则吃掉）。 */
export const AGENTS_MD_TRUNCATED_MARK = '[AGENTS.md 已截断]';

/** 围栏里用的标签（`<<<PI-BOT:UNTRUSTED:agents-md>>>`）。 */
export const AGENTS_MD_UNTRUSTED_LABEL = 'agents-md';

/** 一个 AGENTS.md 段。`text` 是**已围栏包裹**后的文本，`bytes` 是原始文件字节数。 */
export interface AgentsMdSection {
  /** 相对 worktree 根的路径（`AGENTS.md`、`apps/server/AGENTS.md`）。 */
  readonly path: string;
  /** 已过 `sanitizeUntrustedText` + `fenceUntrusted` 的正文（含 `[AGENTS.md 已截断]` 标记）。 */
  readonly text: string;
  readonly truncated: boolean;
  readonly bytes: number;
}

/** 一次收集的结果。`skipped` 是「看见了但没读」的路径 + 原因（人读 + 可断言）。 */
export interface AgentsMdResult {
  readonly root: AgentsMdSection | null;
  readonly nearby: readonly AgentsMdSection[];
  readonly skipped: readonly string[];
}

export interface CollectAgentsMdInput {
  readonly worktreeDir: string;
  /** 任务涉及的相对路径（可以是目录，也可以是文件；本层不猜，按「文件/目录」两种形态都试）。 */
  readonly hintPaths?: readonly string[];
}

/* ── 路径安全 ─────────────────────────────────────────────────────────────── */

/** 把外部给的相对路径切成安全段；任何可能逃出 worktree 的形态都在这里被拒。 */
export function toSafeSegments(raw: string): { readonly segments: readonly string[] } | { readonly reason: string } {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { reason: '空路径' };
  }
  if (trimmed.includes('\u0000')) {
    return { reason: '含 NUL 字符' };
  }
  const unified = trimmed.replace(/\\/gu, '/');
  if (unified.startsWith('/')) {
    // 同时覆盖 UNC（`\\server\share` → `//server/share`）
    return { reason: '绝对路径' };
  }
  if (/^[a-zA-Z]:/u.test(unified)) {
    return { reason: '盘符路径' };
  }
  const segments: string[] = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      return { reason: '含 .. 段' };
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    return { reason: '空路径' };
  }
  return { segments };
}

/** `target` 是否在 `root` 之内（两者都应是 realpath/绝对路径）。 */
function isInside(root: string, target: string): boolean {
  if (target === root) {
    return true;
  }
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target.startsWith(prefix);
}

/** 最后一段是否像文件名（`foo.ts` / `README.md`；`.github` 不算）。 */
function looksLikeFile(segments: readonly string[]): boolean {
  const last = segments[segments.length - 1] ?? '';
  return /\.[a-zA-Z0-9]+$/u.test(last);
}

/* ── 单文件读取 ───────────────────────────────────────────────────────────── */

async function readSection(input: {
  readonly worktreeRoot: string;
  readonly segments: readonly string[];
  readonly maxChars: number;
  readonly skipped: string[];
}): Promise<AgentsMdSection | null> {
  const relPath = input.segments.join('/');
  const absolute = path.join(input.worktreeRoot, ...input.segments);
  if (!isInside(input.worktreeRoot, absolute)) {
    input.skipped.push(`${relPath}（解析后逃出 worktree）`);
    return null;
  }

  let stats;
  try {
    stats = await lstat(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 文件不存在不算错误（spec R7：缺省只是少一段上下文）。
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      input.skipped.push(`${relPath}（lstat 失败：${String(error)}）`);
    }
    return null;
  }

  if (stats.isSymbolicLink()) {
    // 不跟随软链：否则 `AGENTS.md -> C:\Windows\...` 就能把宿主文件读进提示词。
    input.skipped.push(`${relPath}（符号链接，不跟随）`);
    return null;
  }
  if (!stats.isFile()) {
    input.skipped.push(`${relPath}（不是普通文件）`);
    return null;
  }
  if (stats.size > AGENTS_MD_LIMITS.maxFileBytes) {
    input.skipped.push(`${relPath}（${String(stats.size)} 字节超过 1 MB 上限）`);
    return null;
  }

  // 文件本身不是软链，但**中间目录**可能是；realpath 之后再判一次包含关系。
  let real: string;
  try {
    real = await realpath(absolute);
  } catch (error) {
    input.skipped.push(`${relPath}（realpath 失败：${String(error)}）`);
    return null;
  }
  if (!isInside(input.worktreeRoot, real)) {
    input.skipped.push(`${relPath}（realpath 后落在 worktree 之外）`);
    return null;
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(real);
  } catch (error) {
    input.skipped.push(`${relPath}（读取失败：${String(error)}）`);
    return null;
  }
  if (buffer.length > AGENTS_MD_LIMITS.maxFileBytes) {
    input.skipped.push(`${relPath}（${String(buffer.length)} 字节超过 1 MB 上限）`);
    return null;
  }

  const sanitized = sanitizeUntrustedText(buffer.toString('utf8'), input.maxChars);
  const body = sanitized.truncated ? `${sanitized.text}\n\n${AGENTS_MD_TRUNCATED_MARK}` : sanitized.text;

  return {
    path: relPath,
    text: fenceUntrusted(AGENTS_MD_UNTRUSTED_LABEL, body),
    truncated: sanitized.truncated,
    bytes: buffer.length,
  };
}

/* ── 就近候选 ─────────────────────────────────────────────────────────────── */

type NearbyCandidate = { readonly segments: readonly string[]; readonly relPath: string; readonly depth: number };

/**
 * 由 `hintPaths` 推出「就近 AGENTS.md」的候选（**只算路径，不读文件**）。
 *
 * `depth` = 距离任务路径的层数：0 是任务所在目录里的那个，越大越远（越近越靠前）。
 * 同一路径只保留最小的 `depth`（多个 hint 指向同一子树时不重复）。
 */
export function collectNearbyCandidates(
  hintPaths: readonly string[],
  skipped: string[],
): readonly NearbyCandidate[] {
  const byPath = new Map<string, number>();
  for (const hint of hintPaths) {
    const safe = toSafeSegments(hint);
    if (!('segments' in safe)) {
      skipped.push(`${hint}（${safe.reason}，已跳过）`);
      continue;
    }
    const dirSegments = looksLikeFile(safe.segments)
      ? safe.segments.slice(0, safe.segments.length - 1)
      : [...safe.segments];
    for (let depth = 0; depth < dirSegments.length; depth += 1) {
      const level = [...dirSegments.slice(0, dirSegments.length - depth), AGENTS_MD_FILENAME];
      const relPath = level.join('/');
      const existing = byPath.get(relPath);
      if (existing === undefined || depth < existing) {
        byPath.set(relPath, depth);
      }
    }
  }
  return [...byPath.entries()]
    .map(([relPath, depth]) => ({ segments: relPath.split('/'), relPath, depth }))
    .sort((left, right) => left.depth - right.depth || left.relPath.localeCompare(right.relPath, 'en'));
}

/* ── 入口 ─────────────────────────────────────────────────────────────────── */

/**
 * 收集根 + 就近 AGENTS.md。
 *
 * 不抛异常：worktree 读不到、某个文件读不到都只是「少一段」，进 `skipped` 或直接忽略。
 */
export async function collectAgentsMd(input: CollectAgentsMdInput): Promise<AgentsMdResult> {
  const skipped: string[] = [];

  let worktreeRoot: string;
  try {
    worktreeRoot = await realpath(path.resolve(input.worktreeDir));
  } catch (error) {
    skipped.push(`worktreeDir（不可读：${String(error)}）`);
    return { root: null, nearby: [], skipped };
  }

  const root = await readSection({
    worktreeRoot,
    segments: [AGENTS_MD_FILENAME],
    maxChars: AGENTS_MD_LIMITS.rootMaxChars,
    skipped,
  });

  const nearby: AgentsMdSection[] = [];
  let usedChars = 0;
  for (const candidate of collectNearbyCandidates(input.hintPaths ?? [], skipped)) {
    if (nearby.length >= AGENTS_MD_LIMITS.maxNearby) {
      break;
    }
    const section = await readSection({
      worktreeRoot,
      segments: candidate.segments,
      maxChars: AGENTS_MD_LIMITS.nearbyMaxChars,
      skipped,
    });
    if (section === null) {
      continue;
    }
    if (usedChars + section.text.length > AGENTS_MD_LIMITS.nearbyTotalChars) {
      // 越近的已经先放进去了；这一段放不下就丢掉（不切字符，整段丢）。
      skipped.push(`${section.path}（就近合计超过 ${String(AGENTS_MD_LIMITS.nearbyTotalChars)} 字符，已丢弃）`);
      continue;
    }
    usedChars += section.text.length;
    nearby.push(section);
  }

  return { root, nearby, skipped };
}
