/**
 * 写回闸门的路径规则（tech-plan §5.6 第 1/2 条）。
 *
 * 三条不容商量的规则：
 * 1. **拒收清单硬编码**：`PROTECTED_PATH_PATTERNS`（来自 `envelope`，与「声明能不能被接受」
 *    共用同一份定义）+ 本模块**只能收紧**地补上 `.pi-bot/`（闸门自己的临时索引与
 *    askpass 脚本就在里面）。没有任何开关能放宽它——放宽一次，闸门就等于不存在。
 * 2. **声明只能是相对仓库根的形式**：绝对路径、`..` 段、超长一律判不合规。
 * 3. **声明的 glob 由服务端展开**，且只在**实际变更集内部**展开：
 *    `*` 不跨目录、`**` 跨目录、`?` 单字符；末尾带 `/` 视为目录前缀（等价于 `dir/**`）。
 *    「声明了但磁盘上没变」的路径不会凭空进入推送集——推送集是 declared ∩ actual。
 */
import { PROTECTED_PATH_PATTERNS, isProtectedPath } from './deps.ts';

/** 单条声明路径的最大长度（与 `envelope` 的 `checkPaths` 保持一致）。 */
export const MAX_DECLARED_PATH_LENGTH = 400;

/**
 * 拒收清单（写回侧）。只允许在 `PROTECTED_PATH_PATTERNS` 之上**追加**。
 *
 * `.pi-bot/` 加在这里的理由：它是闸门的脚手架目录（临时 index、askpass 脚本），
 * 容器侧若能改它，就能改「用哪个索引组提交」，等于绕过整段 §5.6。
 */
export const WRITEBACK_PROTECTED_PATTERNS: readonly RegExp[] = [
  ...PROTECTED_PATH_PATTERNS,
  /(^|\/)\.pi-bot(\/|$)/,
];

/** 拒收原因（进 `actions.audit` 与 `run_events`，改动即契约变更）。 */
export const WRITEBACK_REJECTION_REASONS = [
  'declared-empty', // push_branch 一条路径都没声明
  'declared-invalid', // 绝对路径 / `..` 出仓 / 超长 / 非法字符
  'declared-protected', // 声明的路径命中拒收清单
  'actual-protected', // 实际改动命中拒收清单（有人在推边界）
  'symlink-escape', // 实际改动里有指向仓库外的 symlink
] as const;

export type WritebackRejectionReason = (typeof WRITEBACK_REJECTION_REASONS)[number];

/** 拒收清单的统一判据（写回侧，含 `.pi-bot/`）。 */
export function isWritebackProtectedPath(path: string): boolean {
  return isProtectedPath(path) || WRITEBACK_PROTECTED_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * 归一化一条「相对仓库根」的路径写法。
 *
 * 只做**无歧义**的规范化：反斜杠转正斜杠、去掉开头的 `./`、合并重复 `/`。
 * 刻意**不**做「解析 `.`/`..`」——那种解析会掩盖越界意图，而越界必须被拒绝而不是被修正。
 */
export function normalizeRepoPath(raw: string): string {
  let path = raw.replace(/\\/g, '/');
  while (path.startsWith('./')) {
    path = path.slice(2);
  }
  path = path.replace(/\/{2,}/g, '/');
  return path;
}

/** 判断一个声明是否是 glob（含通配字符）。 */
export function isGlobPattern(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

/** 把声明翻译成正则：`**` 跨目录、`*` 不跨目录、`?` 单字符，其余按字面量。 */
export function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? '';
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        // `**/` 连斜杠一起吃掉，这样 `src/**/x.ts` 也能匹配 `src/x.ts`。
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** 把声明规整成可匹配的形式：归一化 + 目录写法补 `**`。 */
function normalizeDeclaredPattern(pattern: string): string {
  const normalized = normalizeRepoPath(pattern);
  return normalized.endsWith('/') ? `${normalized}**` : normalized;
}

/** 一条实际路径是否被某条声明覆盖（字面量或 glob）。 */
export function matchesDeclared(path: string, pattern: string): boolean {
  const subject = normalizeRepoPath(path);
  const normalizedPattern = normalizeDeclaredPattern(pattern);
  if (!isGlobPattern(normalizedPattern)) {
    return subject === normalizedPattern;
  }
  return globToRegExp(normalizedPattern).test(subject);
}

/** 一条声明路径的问题（`reason` 与拒收原因同一枚举）。 */
export interface DeclaredPathIssue {
  readonly reason: WritebackRejectionReason;
  readonly path: string;
  readonly detail: string;
}

/**
 * 校验声明的路径集合。
 *
 * 返回**全部**问题而不是第一条：一次 `writeback_rejected` 要能说清「都哪儿不对」，
 * 否则调参要一条一条试。
 */
export function validateDeclaredPaths(paths: readonly string[]): DeclaredPathIssue[] {
  if (paths.length === 0) {
    return [
      {
        reason: 'declared-empty',
        path: '',
        detail: 'push_branch 必须声明至少 1 条相对仓库根的路径（tech-plan §5.6）',
      },
    ];
  }

  const issues: DeclaredPathIssue[] = [];
  for (const raw of paths) {
    const path = normalizeRepoPath(raw);
    if (path.length === 0 || path.length > MAX_DECLARED_PATH_LENGTH) {
      issues.push({
        reason: 'declared-invalid',
        path: raw,
        detail: `路径长度不合法（1..${String(MAX_DECLARED_PATH_LENGTH)}）：${JSON.stringify(raw)}`,
      });
      continue;
    }
    if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) {
      issues.push({ reason: 'declared-invalid', path: raw, detail: `不接受绝对路径：${raw}` });
      continue;
    }
    if (path.split('/').includes('..')) {
      issues.push({ reason: 'declared-invalid', path: raw, detail: `不接受出仓路径（含 ..）：${raw}` });
      continue;
    }
    if (path.includes('\0')) {
      issues.push({ reason: 'declared-invalid', path: raw, detail: '路径中含 NUL 字节' });
      continue;
    }
    if (isWritebackProtectedPath(path)) {
      issues.push({ reason: 'declared-protected', path: raw, detail: `命中拒收清单：${raw}` });
    }
  }
  return issues;
}
