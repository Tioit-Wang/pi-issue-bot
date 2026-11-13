/**
 * 项目默认技能 + 运行目录物化（`skills/defaults.ts` / `skills/workspace.ts`）。
 *
 * 两条要钉住的事实：
 *  1. 三个默认技能都能被解析成合法技能包，且**存储名带前导 `/`**（`store.upload` 硬要求；
 *     标准写法的 `name` 不带，所以必须归一化，否则播种会静默跳过 —— 实机踩过）；
 *  2. 技能是按**本次运行目录**物化的：写进 `<root>/.pi/skills/<name>/SKILL.md`，清理后整目录消失，
 *     并且再次物化会先清空上一次的残留（同一目录重试时不能读到已删除的技能）。
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_PROJECT_SKILL_NAMES, builtinSkillText } from '../src/skills/builtin.ts';
import { bundleOfBuiltinSkill } from '../src/skills/defaults.ts';
import { WORKSPACE_SKILLS_DIR, materializeWorkspaceSkills, removeWorkspaceSkills } from '../src/skills/workspace.ts';

let root = '';

beforeAll(async () => {
  root = await mkdtemp(nodePath.join(tmpdir(), 'pi-bot-skills-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('默认技能（每项目至少三个）', () => {
  it('三个默认技能名固定，且都能取到正文', () => {
    expect([...DEFAULT_PROJECT_SKILL_NAMES]).toEqual(['/proposal-analysis', '/label-triage', '/issue-analysis']);
    for (const name of DEFAULT_PROJECT_SKILL_NAMES) {
      expect(builtinSkillText(name)).not.toBeNull();
    }
  });

  it('内置技能能包成技能包：name 带前导 /，正文非空，validation.ok', () => {
    for (const name of DEFAULT_PROJECT_SKILL_NAMES) {
      const bundle = bundleOfBuiltinSkill(name);
      expect(bundle).not.toBeNull();
      expect(bundle?.name).toBe(name);
      expect(bundle?.name.startsWith('/')).toBe(true);
      expect((bundle?.body ?? '').length).toBeGreaterThan(20);
      expect(bundle?.validation.ok).toBe(true);
      expect(bundle?.files[0]?.path).toBe('SKILL.md');
    }
  });

  it('打标技能明确写了「必须给 label 动作」这一条（issue #25 的根因）', () => {
    const text = builtinSkillText('/label-triage') ?? '';
    expect(text).toContain('actions');
    expect(text).toContain('intent":"label');
    expect(text).toContain('verdict.labels');
  });
});

describe('运行目录物化（每个 issue 独立目录）', () => {
  it('写进 <root>/.pi/skills/<name>/SKILL.md，并返回技能名', async () => {
    const workspace = nodePath.join(root, 'job-a');
    const files = DEFAULT_PROJECT_SKILL_NAMES.map((name) => ({
      path: `skills/builtin${name}/SKILL.md`,
      text: builtinSkillText(name) ?? '',
    }));

    const result = await materializeWorkspaceSkills({ workspaceRoot: workspace, files });

    expect(result.names).toEqual(['/proposal-analysis', '/label-triage', '/issue-analysis']);
    expect(result.dir).toBe(nodePath.join(workspace, WORKSPACE_SKILLS_DIR));
    const dirs = (await readdir(result.dir)).sort();
    expect(dirs).toEqual(['issue-analysis', 'label-triage', 'proposal-analysis']);
    const body = await readFile(nodePath.join(result.dir, 'proposal-analysis', 'SKILL.md'), 'utf8');
    expect(body).toContain('name: proposal-analysis');
  });

  it('清理后整目录消失，不影响另一个任务的目录', async () => {
    const a = nodePath.join(root, 'job-b');
    const b = nodePath.join(root, 'job-c');
    const files = [{ path: 'x/SKILL.md', text: builtinSkillText('/proposal-analysis') ?? '' }];
    await materializeWorkspaceSkills({ workspaceRoot: a, files });
    await materializeWorkspaceSkills({ workspaceRoot: b, files });

    expect(await removeWorkspaceSkills({ workspaceRoot: a })).toBe(true);
    expect(await readdir(a).catch(() => [])).not.toContain(WORKSPACE_SKILLS_DIR);
    // 另一个任务的目录仍在（不共享路径）
    expect(await readdir(nodePath.join(b, WORKSPACE_SKILLS_DIR))).toEqual(['proposal-analysis']);
  });

  it('再次物化会先清空上一次的残留（重试不会读到已删技能）', async () => {
    const workspace = nodePath.join(root, 'job-d');
    await materializeWorkspaceSkills({
      workspaceRoot: workspace,
      files: [
        { path: 'a/SKILL.md', text: builtinSkillText('/proposal-analysis') ?? '' },
        { path: 'b/SKILL.md', text: builtinSkillText('/label-triage') ?? '' },
      ],
    });
    const second = await materializeWorkspaceSkills({
      workspaceRoot: workspace,
      files: [{ path: 'a/SKILL.md', text: builtinSkillText('/proposal-analysis') ?? '' }],
    });
    expect(second.names).toEqual(['/proposal-analysis']);
    expect((await readdir(second.dir)).sort()).toEqual(['proposal-analysis']);
  });
});
