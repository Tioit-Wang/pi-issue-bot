/**
 * ⚠️ 当前**未接线**：本模块假定服务端能看到 agent 的 workspace 目录，但 RACP 没有 workspace 写入通道
 * （`packages/racp-client/src/ops.ts` 明确不用 `workspace/toolExecute` / `tools/advertise`），
 * 所以技能正文目前走**提示词**投递，而不是落盘到 `<workspace>/.pi/skills/`。
 * 保留它是因为 `session/create` 一旦支持文件投放，这是唯一需要接的地方；**不要**在文档里声称
 * 「技能会被物化到运行目录」—— 现在不会。
 *
 * 把技能**物化到本次运行的目录**里（不是共享路径）。
 *
 * 为什么需要这一层：
 *  - 技能正文要能被 agent 用普通文件工具读到（`Skill` 工具 / `Read`），而每个 issue 的运行目录
 *    都不同（`jobs/<taskId>/` 或 worktree），**不存在一个可以共享的技能目录**；
 *  - 因此每次 agent 启动时按本次仓库解析出的技能写进 `<workspace>/.pi/skills/<name>/SKILL.md`，
 *    agent 销毁时整目录删掉 —— 下一个任务、另一个 issue 都不会看到残留。
 *
 * 目录布局与 Agent Skills 标准一致（`skills/<name>/SKILL.md`），所以外部工具按标准路径也能读懂。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';

import { splitFrontmatter } from './frontmatter.ts';

/** 运行目录下的技能根（相对 workspace）。 */
export const WORKSPACE_SKILLS_DIR = '.pi/skills';

/** 一个待物化的技能：`path` 只用来兜底取名（正文里的 `name` 优先）。 */
export type WorkspaceSkillFile = {
  readonly path: string;
  readonly text: string;
};

/** 物化结果：写入了哪些技能（面板/日志用），以及是否被上限截断。 */
export type MaterializedSkills = {
  readonly names: readonly string[];
  readonly dir: string;
};

/** 目录名只能是小写字母/数字/连字符（与标准 `name` 一致）；其余字符折成 `-`。 */
function dirNameOf(text: string, fallbackPath: string): string {
  const split = splitFrontmatter(text);
  const yaml = split.ok ? split.yaml : '';
  const raw = /^name\s*:\s*(.+)$/mu.exec(yaml)?.[1] ?? '';
  const fromFrontmatter = raw
    .trim()
    .replace(/^['"]|['"]$/gu, '')
    .replace(/^\//u, '');
  const candidate = fromFrontmatter === '' ? (fallbackPath.split('/').slice(-2)[0] ?? 'skill') : fromFrontmatter;
  const safe = candidate
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return safe === '' ? 'skill' : safe.slice(0, 64);
}

/**
 * 把技能写进 `<workspace>/.pi/skills/<name>/SKILL.md`。
 *
 * 先**清空**目标目录：上一轮同一个目录可能残留（比如同一 task 重试），
 * 不清就会让「已经被禁用/删掉」的技能继续被读到。
 */
export async function materializeWorkspaceSkills(input: {
  readonly workspaceRoot: string;
  readonly files: readonly WorkspaceSkillFile[];
}): Promise<MaterializedSkills> {
  const dir = nodePath.join(input.workspaceRoot, WORKSPACE_SKILLS_DIR);
  await rm(dir, { recursive: true, force: true });
  if (input.files.length === 0) {
    return { names: [], dir };
  }
  const names: string[] = [];
  for (const file of input.files) {
    const name = dirNameOf(file.text, file.path);
    const target = nodePath.join(dir, name, 'SKILL.md');
    await mkdir(nodePath.dirname(target), { recursive: true });
    await writeFile(target, file.text, 'utf8');
    names.push(`/${name}`);
  }
  return { names, dir };
}

/** agent 销毁时调用：删掉本次物化的技能目录（连同空的 `.pi` 里的 skills 子目录）。 */
export async function removeWorkspaceSkills(input: { readonly workspaceRoot: string }): Promise<boolean> {
  const dir = nodePath.join(input.workspaceRoot, WORKSPACE_SKILLS_DIR);
  try {
    await rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
