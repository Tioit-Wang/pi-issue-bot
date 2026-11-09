import { readdirSync, readFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * plan §7.1 / tech-plan §5.4 的可执行检查：
 * 「代码层不存在 merge 调用」——Octokit 里有 `pulls.merge`，但我们永远不写。
 *
 * 只扫 `src/` 目录（本文件在 `apps/server/test/` 下），所以本文件可以放心地把
 * 被禁模式写成字面量，不会自我命中。
 */

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

const SCAN_ROOTS = [
  'apps/server/src',
  'apps/panel/src',
  'packages/contract/src',
  'packages/envelope/src',
  'packages/racp-client/src',
  'packages/shared/src',
];

type ForbiddenPattern = { readonly label: string; readonly pattern: RegExp };

const FORBIDDEN_PATTERNS: readonly ForbiddenPattern[] = [
  { label: 'Octokit pulls.merge 调用', pattern: /\.merge\s*\(/ },
  { label: 'pulls.merge 引用', pattern: /\bpulls\.merge\b/ },
  { label: 'GraphQL mergePullRequest', pattern: /\bmergePullRequest\b/ },
  { label: 'REST merge_pull_request', pattern: /\bmerge_pull_request\b/ },
];

function listSourceFiles(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }
      files.push(...listSourceFiles(full));
    } else if (entry.isFile() && /\.(ts|tsx|mts|cts)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

describe('禁止 merge 的源码断言（plan §7.1 / tech-plan §5.4）', () => {
  const sourceFiles = SCAN_ROOTS.flatMap((root) => listSourceFiles(join(REPO_ROOT, root)));

  it('扫描到了源码（防止扫描路径写错导致断言变成空转）', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it('src/ 下不存在任何 merge 调用', () => {
    const violations: string[] = [];

    for (const file of sourceFiles) {
      const displayPath = relative(REPO_ROOT, file).replaceAll('\\', '/');
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        for (const { label, pattern } of FORBIDDEN_PATTERNS) {
          if (pattern.test(line)) {
            violations.push(`${displayPath}:${index + 1} 命中「${label}」→ ${line.trim()}`);
          }
        }
      });
    }

    expect(
      violations,
      '本项目没有 merge 权限，也没有 merge 代码路径：动作只到 push_branch / open_pr 为止',
    ).toEqual([]);
  });
});
