import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * S5「删死代码」的**源码级**护栏（`docs/plan-fixed-pipeline.md` §11 S5，验收判据 `grep runTriage` 为 0）：
 *
 * 这批删的是三份**没有生产调用者**的模块——
 *  - `workflows/triage.ts`（`runTriage()` 只被它自己的单测调用；真实打标走 `worker/writeback.ts`）；
 *  - `workflows/close-gate.ts`（关闭闸门，已被 `issue_pipeline` 的状态机 + `pipeline-format.ts`
 *    的 `closeIssue` 取代）；
 *  - `workflows/issue-state.ts`（`issue_states` 的读写面，同上）。
 *
 * 为什么必须写成源码断言而不是行为断言：
 *  - 行为层只看得到「这一轮走的是 `pipeline:*`」，看不到「某个分支又把 `runTriage()` 接回来了」；
 *  - 这种回退是**静默**的：任务照建、issue 照处理，只是绕过了四段流水线，没有任何一条既有用例会红。
 *
 * 范式照 `no-auto-triage.test.ts` / `no-merge.test.ts`：只扫 `apps/server/src`，本文件在
 * `apps/server/test/` 下，所以可以把被禁字面量放心写在用例里，不会自我命中。
 */

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

const SCAN_ROOTS = ['apps/server/src'] as const;

/** 已删除的三个模块（相对仓库根，正斜杠）。 */
const DELETED_FILES = [
  'apps/server/src/workflows/triage.ts',
  'apps/server/src/workflows/close-gate.ts',
  'apps/server/src/workflows/issue-state.ts',
] as const;

type ForbiddenPattern = { readonly label: string; readonly pattern: RegExp };

/**
 * 被禁的三种引用：模块名（`./triage.ts` / `close-gate.ts` / `issue-state.ts`）与那个
 * 已经没有人调用的入口函数名。**不**禁 `issue_states`：那是仍然存在于库里的表名，
 * `db/schema.ts` 与 `queries/issues.ts` 合法地读它。
 */
const FORBIDDEN_PATTERNS: readonly ForbiddenPattern[] = [
  { label: 'runTriage 入口函数', pattern: /runTriage/iu },
  { label: 'close-gate 模块名', pattern: /close-gate/iu },
  { label: 'issue-state 模块名', pattern: /issue-state/iu },
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

describe('已删除的三份死代码不得被接回来（§11 S5）', () => {
  const sourceFiles = SCAN_ROOTS.flatMap((root) => listSourceFiles(join(REPO_ROOT, root)));

  it('扫描到了源码（防止扫描路径写错导致断言变成空转）', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it('扫描面确实覆盖了 workflows/（搬迁后的新家也必须在面里）', () => {
    const display = sourceFiles.map((file) => relative(REPO_ROOT, file).replaceAll('\\', '/'));
    // 这两条任一消失，说明流水线被整体挪走了，下面那条「零命中」就没有意义了
    expect(display.some((path) => path.startsWith('apps/server/src/workflows/'))).toBe(true);
    expect(display.some((path) => path.endsWith('apps/server/src/workflows/pipeline.ts'))).toBe(true);
    // 搬家的落点：`needsInfoLabelOf` 在这里，`missingEvidenceOf` / `describeMissing` 在这里
    expect(display.some((path) => path.endsWith('apps/server/src/workflows/pipeline-labels.ts'))).toBe(true);
    expect(display.some((path) => path.endsWith('apps/server/src/workflows/stage-result.ts'))).toBe(true);
  });

  it('apps/server/src 下不存在 runTriage / close-gate / issue-state 的符号或路径引用', () => {
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
      'S5 之后这三份模块是已删除的死代码（真实打标走 worker/writeback.ts，关闭走 issue_pipeline 状态机）',
    ).toEqual([]);
  });

  it('三个文件确实已经不在 workflows/ 目录里', () => {
    const present = DELETED_FILES.filter((file) => existsSync(join(REPO_ROOT, file)));
    expect(present).toEqual([]);

    // 反方向也钉一次：目录本身还在（否则上面那条会因为「目录没了」而空转）
    const workflowsDir = join(REPO_ROOT, 'apps/server/src/workflows');
    const names = readdirSync(workflowsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    expect(names).toContain('pipeline.ts');
    expect(names).not.toContain('triage.ts');
    expect(names).not.toContain('close-gate.ts');
    expect(names).not.toContain('issue-state.ts');
  });
});
