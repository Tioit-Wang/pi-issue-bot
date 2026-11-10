/**
 * `skills/assemble.ts` 的单测（spec §7「装配顺序」+ R8）。
 *
 * 三条要钉住的性质：
 *  1. **缺省不改语义**：没有 AGENTS.md 也没有技能时，输出与 `basePrompt` 逐字节相同；
 *  2. **层序固定**：AGENTS.md 段在技能段之前，`basePrompt` 的输出契约仍在最后一段；
 *  3. **预算截断从后往前、整段丢弃**：先丢最远的就近 AGENTS.md，再丢技能，根最后丢；
 *     围栏/哨兵永远不会被切成半截（按整段丢，不切字符）。
 *
 * 纯函数测试：不碰文件系统、不碰库、不碰网络。
 */
import { describe, expect, it } from 'vitest';

import type { AgentsMdSection } from '../src/skills/agents-md.ts';
import { ASSEMBLE_HEADINGS, assemblePrompt, splitBasePrompt } from '../src/skills/assemble.ts';
import { UNTRUSTED_SENTINEL } from '../src/skills/prompt.ts';

/** 与 `buildTaskPrompt` / `buildAnswerPrompt` 同构的基座提示词（头部 + 输出契约）。 */
const BASE = [
  '你是 pi-bot，正在处理 octo/demo 的 issue #7。',
  '命令：/issue-triage',
  '本轮是 dry-run：只做判断，不要做任何写操作。',
  '',
  '输出分两段，顺序不能反，也不要再加别的段落：',
  '',
  '【第一段】给人看的回复：中文，不超过 8 行。',
  '',
  '【第二段】**唯一**一个 ```json 代码块。',
  '```json',
  '{ "verdict": {}, "actions": [], "usage": {} }',
  '```',
].join('\n');

/** 输出契约段的识别串（装配后它必须仍是最靠后的语义段）。 */
const CONTRACT_MARKER = '【第二段】';

/** 造一段「已围栏」的 AGENTS.md（形状与 `collectAgentsMd` 的产出一致）。 */
function section(relPath: string, body: string, truncated = false): AgentsMdSection {
  return {
    path: relPath,
    text: [
      `${UNTRUSTED_SENTINEL}:agents-md>>>`,
      body,
      `${UNTRUSTED_SENTINEL}:agents-md:END>>>`,
    ].join('\n'),
    truncated,
    bytes: body.length,
  };
}

function sentinelCount(text: string): number {
  return text.split(UNTRUSTED_SENTINEL).length - 1;
}

describe('assemblePrompt', () => {
  it('没有 AGENTS.md、没有技能：输出与 basePrompt 逐字节相同', () => {
    const result = assemblePrompt({ basePrompt: BASE });

    expect(result.prompt).toBe(BASE);
    expect(result.stats).toEqual({
      baseChars: BASE.length,
      agentsChars: 0,
      skillChars: 0,
      totalChars: BASE.length,
      truncated: [],
    });
  });

  it('agentsMd 为 null、skill 为 null 时同样逐字节相同', () => {
    const result = assemblePrompt({ basePrompt: BASE, agentsMd: null, skill: null });

    expect(result.prompt).toBe(BASE);
  });

  it('层序：头部 → AGENTS.md（根在前、就近在后）→ 技能 → 输出契约（最后）', () => {
    const result = assemblePrompt({
      basePrompt: BASE,
      agentsMd: {
        root: section('AGENTS.md', '仓库根约定'),
        nearby: [section('apps/server/AGENTS.md', 'server 目录约定')],
        skipped: [],
      },
      skill: { name: '/issue-triage', promptText: '技能正文……' },
    });

    const head = splitBasePrompt(BASE).head;
    expect(result.prompt.startsWith(head)).toBe(true);

    const indexRoot = result.prompt.indexOf(ASSEMBLE_HEADINGS.agentsRoot);
    const indexNearby = result.prompt.indexOf('AGENTS.md（就近：apps/server/AGENTS.md）');
    const indexSkill = result.prompt.indexOf(`${ASSEMBLE_HEADINGS.skillPrefix} /issue-triage`);
    const indexContract = result.prompt.indexOf(CONTRACT_MARKER);

    expect(indexRoot).toBeGreaterThan(-1);
    expect(indexNearby).toBeGreaterThan(indexRoot);
    expect(indexSkill).toBeGreaterThan(indexNearby);
    // 输出契约仍在**最后**一段，且它的内容原样保留
    expect(indexContract).toBeGreaterThan(indexSkill);
    expect(result.prompt.endsWith('```')).toBe(true);
    expect(result.prompt.slice(indexContract)).toBe(BASE.slice(BASE.indexOf(CONTRACT_MARKER)));

    // 统计：baseChars 是基座长度，agents/skill 各自非空
    expect(result.stats.baseChars).toBe(BASE.length);
    expect(result.stats.agentsChars).toBeGreaterThan(0);
    expect(result.stats.skillChars).toBeGreaterThan(0);
    expect(result.stats.totalChars).toBe(result.prompt.length);
    expect(result.stats.truncated).toEqual([]);
  });

  it('AGENTS.md 段保留围栏（装配层不做二次转义，也不剥哨兵）', () => {
    const result = assemblePrompt({
      basePrompt: BASE,
      agentsMd: { root: section('AGENTS.md', '仓库根约定'), nearby: [], skipped: [] },
    });

    expect(result.prompt).toContain(`${UNTRUSTED_SENTINEL}:agents-md>>>`);
    expect(result.prompt).toContain(`${UNTRUSTED_SENTINEL}:agents-md:END>>>`);
    // 一段围栏 = 2 个哨兵，一个都不能少
    expect(sentinelCount(result.prompt)).toBe(2);
  });

  it('超预算：从后往前丢（最远就近 → 更近就近 → 技能 → 根），每步都留标记', () => {
    const result = assemblePrompt({
      basePrompt: BASE,
      agentsMd: {
        root: section('AGENTS.md', '根约定'),
        nearby: [section('a/AGENTS.md', '近的约定'), section('a/b/AGENTS.md', '远的约定')],
        skipped: [],
      },
      skill: { name: '/issue-triage', promptText: '技能正文……' },
      // 1 字符预算：必然把能丢的全丢掉
      budgetChars: 1,
    });

    expect(result.stats.truncated).toEqual([
      'nearby:a/b/AGENTS.md',
      'nearby:a/AGENTS.md',
      'skill:/issue-triage',
      'root',
    ]);
    // 丢弃后不能剩下半个围栏（整段丢，不切字符）
    expect(sentinelCount(result.prompt)).toBe(0);
    // 每一条丢弃都留了可见标记
    expect(result.prompt.split('已按总预算丢弃').length - 1).toBe(4);
    // 基座提示词本身仍然完整：头部在最前、输出契约在最后
    expect(result.prompt.startsWith(splitBasePrompt(BASE).head)).toBe(true);
    expect(result.prompt.slice(result.prompt.indexOf(CONTRACT_MARKER))).toBe(
      BASE.slice(BASE.indexOf(CONTRACT_MARKER)),
    );
  });

  it('略超预算：只丢最远的那一段，围栏完整的段原样保留', () => {
    const agentsMd = {
      root: section('AGENTS.md', '根约定'),
      nearby: [section('a/AGENTS.md', '近的约定'), section('a/b/AGENTS.md', '远的约定')],
      skipped: [],
    };
    const full = assemblePrompt({ basePrompt: BASE, agentsMd, skill: { name: '/issue-triage', promptText: '技能正文……' } });

    const trimmed = assemblePrompt({
      basePrompt: BASE,
      agentsMd,
      skill: { name: '/issue-triage', promptText: '技能正文……' },
      budgetChars: full.stats.totalChars - 1,
    });

    expect(trimmed.stats.truncated).toEqual(['nearby:a/b/AGENTS.md']);
    expect(trimmed.prompt).not.toContain('远的约定');
    // 近的那段仍然完整（开 + 关两个哨兵），根也还在
    expect(trimmed.prompt).toContain('近的约定');
    expect(trimmed.prompt).toContain('根约定');
    expect(sentinelCount(trimmed.prompt)).toBe(4);
  });

  it('技能的 promptText 原样进入技能层（含它自己的围栏）', () => {
    const promptText = [
      '# 技能 /issue-triage',
      '',
      '## 指令',
      '',
      '判定该 issue 是否符合报告标准。',
      '',
      `${UNTRUSTED_SENTINEL}:body>>>`,
      '用户正文',
      `${UNTRUSTED_SENTINEL}:body:END>>>`,
    ].join('\n');

    const result = assemblePrompt({ basePrompt: BASE, skill: { name: '/issue-triage', promptText } });

    expect(result.prompt).toContain(promptText);
    expect(result.prompt).toContain(`${ASSEMBLE_HEADINGS.skillPrefix} /issue-triage`);
    expect(sentinelCount(result.prompt)).toBe(2);
  });

  it('basePrompt 只有一行时：层追加到它之后（那时它本来就是最后一段）', () => {
    const result = assemblePrompt({
      basePrompt: '只有一行',
      agentsMd: { root: section('AGENTS.md', '根约定'), nearby: [], skipped: [] },
    });

    expect(result.prompt.startsWith('只有一行\n\n')).toBe(true);
    expect(result.prompt).toContain(ASSEMBLE_HEADINGS.agents);
  });
});
