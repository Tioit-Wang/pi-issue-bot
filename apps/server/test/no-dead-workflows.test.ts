import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * S0「固定流水线退役」的**源码级**护栏（`docs/dev-plan-issue-agent.md` §1 退役清单 1–15、21、22 行）。
 *
 * 这一批删掉的是「固定四段流水线」的整套实现：阶段推进（`pipeline.ts`）、格式/分类/指令三个
 * 阶段实现、`issue_pipeline` 状态机读写、阶段提示词装配与 `/命令` 闸门、`prompt_versions` 版本表、
 * `pipeline-close` 定时任务。判据是**这些文件不存在、且源码里不再引用它们的入口符号**。
 *
 * 为什么必须写成源码断言而不是行为断言：
 *  - 行为层只看得到「这一轮没建任务」，看不到「某个分支又把 `enqueueStageTask()` 接回来了」；
 *  - 这种回退是**静默**的：任务照建、issue 照处理，只是重新走回了流水线，没有任何一条既有用例会红。
 *
 * 范式照 `no-auto-triage.test.ts` / `no-merge.test.ts`：只扫 `apps/server/src`，本文件在
 * `apps/server/test/` 下，所以可以把被禁字面量放心写在用例里，不会自我命中。
 */

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

const SCAN_ROOTS = ['apps/server/src'] as const;

/** 已删除的模块（相对仓库根，正斜杠）。 */
const DELETED_FILES = [
  'apps/server/src/workflows/pipeline.ts',
  'apps/server/src/workflows/pipeline-format.ts',
  'apps/server/src/workflows/pipeline-classify.ts',
  'apps/server/src/workflows/pipeline-directives.ts',
  'apps/server/src/workflows/pipeline-labels.ts',
  'apps/server/src/workflows/stage-result.ts',
  'apps/server/src/workflows/command-gate.ts',
  'apps/server/src/skills/stage-prompts.ts',
  'apps/server/src/skills/command.ts',
  'apps/server/src/config/pipeline-constants.ts',
  'apps/server/src/prompt/budget.ts',
  'apps/server/src/prompt/index.ts',
  'apps/server/src/prompt/preview.ts',
  'apps/server/src/prompt/store.ts',
  'apps/server/src/http/api/prompt.ts',
  'apps/server/src/jobs/pipeline-close.ts',
] as const;

type ForbiddenPattern = {
  readonly label: string;
  readonly pattern: RegExp;
  /**
   * `true` = 只在**代码**行上算违规（整行注释不算）。
   *
   * 为什么需要：S0 删模块时故意留了「原来住在这里」的说明注释（`compose.ts` 的
   * `config/pipeline-constants.ts`、`skills/assemble.ts` 的 `skills/stage-prompts.ts`），
   * 那些注释不是回退。模块**路径**按代码口径判；入口**符号**仍然注释里也不许出现。
   */
  readonly codeOnly?: boolean;
};

/**
 * 被禁的引用：已删模块的路径片段，以及只属于流水线的入口符号。
 *
 * **不**禁 `issue_pipeline` / `prompt_versions` 这两个表名——`migrations/0006_agent.sql` 要
 * `drop table` 它们，而迁移 SQL 不在扫描面内；源码注释提到时也允许（同 `codeOnly` 的理由）。
 */
const FORBIDDEN_PATTERNS: readonly ForbiddenPattern[] = [
  { label: 'pipeline 阶段推进入口', pattern: /enqueueStageTask/u },
  { label: '阶段提示词装配', pattern: /assembleStagePrompt/u },
  { label: '/命令 闸门', pattern: /checkCommandGate/u },
  { label: '阶段结果类型', pattern: /StageResult\b/u },
  { label: 'pipeline 运行时开关', pattern: /PIPELINE_RUNTIME_MODE/u },
  { label: 'stage-prompts 模块路径', pattern: /skills\/stage-prompts\.ts/u, codeOnly: true },
  { label: 'pipeline-constants 模块路径', pattern: /config\/pipeline-constants\.ts/u, codeOnly: true },
  { label: 'prompt store 模块路径', pattern: /prompt\/store\.ts/u, codeOnly: true },
  { label: 'command-gate 模块路径', pattern: /workflows\/command-gate\.ts/u, codeOnly: true },
];

/** 整行注释：`//` / `*`（块注释延续行）/ `/*` 开头。 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** 扫一段源码里的违规点；`displayPath` 只用于报告里定位。 */
function violationsIn(displayPath: string, source: string): string[] {
  const violations: string[] = [];
  source.split(/\r?\n/u).forEach((line, index) => {
    for (const { label, pattern, codeOnly } of FORBIDDEN_PATTERNS) {
      if (codeOnly === true && isCommentLine(line)) {
        continue;
      }
      if (pattern.test(line)) {
        violations.push(`${displayPath}:${index + 1} 命中「${label}」→ ${line.trim()}`);
      }
    }
  });
  return violations;
}

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

describe('固定流水线的实现不得被接回来（§1 S0 退役）', () => {
  const sourceFiles = SCAN_ROOTS.flatMap((root) => listSourceFiles(join(REPO_ROOT, root)));

  it('扫描到了源码（防止扫描路径写错导致断言变成空转）', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it('扫描面确实覆盖了 workflows/ 与 skills/（搬迁后的新家也必须在面里）', () => {
    const display = sourceFiles.map((file) => relative(REPO_ROOT, file).replaceAll('\\', '/'));
    expect(display.some((path) => path.startsWith('apps/server/src/workflows/'))).toBe(true);
    expect(display.some((path) => path.startsWith('apps/server/src/skills/'))).toBe(true);
    // 搬家的两个落点：`needsInfoLabelOf` 在这里，`missingEvidenceOf` / `describeMissing` 在这里
    expect(display.some((path) => path.endsWith('apps/server/src/workflows/labels.ts'))).toBe(true);
    expect(display.some((path) => path.endsWith('apps/server/src/workflows/evidence.ts'))).toBe(true);
  });

  it('apps/server/src 下不存在流水线的入口符号或已删模块路径', () => {
    const violations = sourceFiles.flatMap((file) =>
      violationsIn(relative(REPO_ROOT, file).replaceAll('\\', '/'), readFileSync(file, 'utf8')),
    );

    expect(
      violations,
      'S0 之后固定流水线已整体退役（事件面由 agent 接管，见 dev-plan §1）',
    ).toEqual([]);
  });

  it('正控：注释里提到已删模块路径放过，代码里 import 它必须被抓到', () => {
    // 没有这条，「`codeOnly` 把护栏变成空转」就没人发现
    expect(violationsIn('fake.ts', '// 这两个数字原来在 config/pipeline-constants.ts（已删）')).toEqual([]);
    expect(violationsIn('fake.ts', "import { X } from '../config/pipeline-constants.ts';")).toHaveLength(1);
    expect(violationsIn('fake.ts', "import { Y } from '../prompt/store.ts';")).toHaveLength(1);
    // 入口符号不看注释/代码：出现在注释里也算违规（这条路子不许靠写注释绕过）
    expect(violationsIn('fake.ts', '// 别再把 enqueueStageTask() 接回来')).toHaveLength(1);
  });

  it('这些文件确实已经不存在', () => {
    const present = DELETED_FILES.filter((file) => existsSync(join(REPO_ROOT, file)));
    expect(present).toEqual([]);
  });

  it('workflows/ 目录本身还在（否则上一条会因为「目录没了」而空转）', () => {
    const workflowsDir = join(REPO_ROOT, 'apps/server/src/workflows');
    const names = readdirSync(workflowsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    expect(names).toContain('index.ts');
    expect(names).not.toContain('pipeline.ts');
    expect(names).not.toContain('command-gate.ts');
  });

  it('prompt/ 只剩 v2.1 的渲染模块、skills/ 下不再有 stage-prompts.ts / command.ts', () => {
    /**
     * v2.1 起 `prompt/` 重新有了合法用途：占位符渲染与 issue 索引（`docs/v21-contract.md` §3）。
     * 护栏的意图是「v0.3 的四个提示词版本线模块不许复活」，不是「这个目录永不存在」——
     * 所以这里逐文件断言旧模块缺失，而不是断言整个目录不存在。
     */
    const promptNames = readdirSync(join(REPO_ROOT, 'apps/server/src/prompt'), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    expect(promptNames).not.toContain('store.ts');
    expect(promptNames).not.toContain('preview.ts');
    expect(promptNames).not.toContain('budget.ts');
    expect(promptNames).not.toContain('index.ts');

    const skillsNames = readdirSync(join(REPO_ROOT, 'apps/server/src/skills'), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    expect(skillsNames).toContain('index.ts');
    expect(skillsNames).not.toContain('stage-prompts.ts');
    expect(skillsNames).not.toContain('command.ts');
  });
});
