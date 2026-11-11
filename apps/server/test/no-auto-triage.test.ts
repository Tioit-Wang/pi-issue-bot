import { readdirSync, readFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * V10「全量切换 / 不可绕过」的**源码级**断言（`docs/plan-fixed-pipeline.md` §12 V10 / §16.1 第 3 条）：
 *
 * 流水线改造之后，issue 事件只该产生 `pipeline:*` 任务；老的 `auto:triage` 判定通道
 * **不该再有任何任务分支**。为什么必须写成源码断言而不是行为断言：
 *  - 行为层只看得到「这次走的是 `pipeline:format`」，看不到「某个条件分支里又摸回了老通道」
 *    （比如把 `triggers.enabled=false` 当成回退开关）；
 *  - 这类回退是**静默**的：任务照建、issue 照处理，只是绕过四段流水线（没有任何一条既有用例会红）。
 *
 * 范式照 `no-merge.test.ts`：只扫 `apps/server/src`，本文件在 `apps/server/test/` 下，
 * 所以可以把被禁字面量放心写在用例里，不会自我命中。
 */

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

const SCAN_ROOTS = ['apps/server/src'] as const;

type ForbiddenPattern = { readonly label: string; readonly pattern: RegExp };

/**
 * 被禁的三种拼法：冒号字面量、`auto_triage` / `auto-triage` 变体、以及「冒号两边带空格」的
 * 写法（`auto : triage`）——后两种存在的意义是堵住「换个拼法绕过去」。
 */
const FORBIDDEN_PATTERNS: readonly ForbiddenPattern[] = [
  { label: 'auto:triage 字面量', pattern: /auto:triage/u },
  { label: 'auto_triage 字面量', pattern: /auto[:_-]triage/u },
  { label: 'auto:triaging / triage:auto 变体', pattern: /auto\s*:\s*triag/iu },
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
    } else if (entry.isFile() && /\.(ts|tsx|mts|cts)$/u.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

describe('禁止 auto:triage 任务分支的源码断言（V10 / §16.1 第 3 条）', () => {
  const sourceFiles = SCAN_ROOTS.flatMap((root) => listSourceFiles(join(REPO_ROOT, root)));

  it('扫描到了源码（防止扫描路径写错导致断言变成空转）', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it('扫描面确实覆盖了会建任务的目录（webhook / workflows / queue / worker）', () => {
    const display = sourceFiles.map((file) => relative(REPO_ROOT, file).replaceAll('\\', '/'));
    // 这四处任一消失，说明流水线被整体挪走了，下面那条「零命中」就没有意义了
    expect(display.some((path) => path.endsWith('apps/server/src/http/webhook.ts'))).toBe(true);
    expect(display.some((path) => path.startsWith('apps/server/src/workflows/'))).toBe(true);
    expect(display.some((path) => path.startsWith('apps/server/src/queue/'))).toBe(true);
    expect(display.some((path) => path.startsWith('apps/server/src/worker/'))).toBe(true);
  });

  it('apps/server/src 下不存在任何 auto:triage 任务分支字面量', () => {
    const violations: string[] = [];

    for (const file of sourceFiles) {
      const displayPath = relative(REPO_ROOT, file).replaceAll('\\', '/');
      const lines = readFileSync(file, 'utf8').split(/\r?\n/u);
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
      'issue 事件只该产生 pipeline:* 任务（§1.3 / §16.1 第 3 条）；auto:triage 是已删除的旧通道',
    ).toEqual([]);
  });
});
