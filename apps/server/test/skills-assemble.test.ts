/**
 * `skills/assemble.ts` 的单测（spec §7「装配顺序」+ R8），外加 W3-G 的 P1 层与预算预演。
 *
 * 四条要钉住的性质：
 *  1. **缺省不改语义**：没有 AGENTS.md、没有技能、没有 P1 时，输出与 `basePrompt` 逐字节相同；
 *     传了空的 P1 也一样（P1 这个特性不能改变任何既有提示词）。
 *  2. **层序固定**：P1 → AGENTS.md → 技能，`basePrompt` 的输出契约仍在最后一段；
 *     P1 插在 head 之后、AGENTS.md 之前（`docs/plan-multi-repo.md` §7）。
 *  3. **预算不够时只丢 P1 与技能正文，且整段丢**：系统提示词（head）与 AGENTS.md **永不裁** ——
 *     宁可少一段背景，也不让 agent 去违反仓库约定；围栏/哨兵永远不会被切成半截。
 *  4. **保存期预演**（`prompt/budget.ts`）与**面板预览**（`prompt/preview.ts`）用的是同一套口径与
 *     同一个装配函数——否则「保存时说放得下、运行期被丢」这类偏差查不出来。
 *
 * 纯函数测试：不碰文件系统、不碰库、不碰网络。
 */
import { describe, expect, it } from 'vitest';

import type { AgentsMdSection } from '../src/skills/agents-md.ts';
import { ASSEMBLE_HEADINGS, assemblePrompt, splitBasePrompt } from '../src/skills/assemble.ts';
import { UNTRUSTED_SENTINEL } from '../src/skills/prompt.ts';

/** 与 `buildTaskPrompt` / `buildAnswerPrompt` 同构的基座提示词（任务行 + 约束 + 输出契约）。 */
const BASE = [
  '这次要做的事：处理 octo/demo 的 issue #7。',
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
      promptChars: 0,
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

  it('超预算：只丢 P1 与技能正文，AGENTS.md（根 + 就近）一段都不丢', () => {
    const result = assemblePrompt({
      basePrompt: BASE,
      projectPrompt: '这个仓库是一个 Go 写的调度器。',
      agentsMd: {
        root: section('AGENTS.md', '根约定'),
        nearby: [section('a/AGENTS.md', '近的约定'), section('a/b/AGENTS.md', '远的约定')],
        skipped: [],
      },
      skill: { name: '/issue-triage', promptText: '技能正文……' },
      // 1 字符预算：必然把**能丢的**全丢掉
      budgetChars: 1,
    });

    // 只有两种层会被丢：项目上下文（P1）与技能正文
    expect(result.stats.truncated).toEqual(['project', 'skill:/issue-triage']);
    // AGENTS.md 三段围栏原样保留（整段不丢、不切字符）：3 段 × 开/关 = 6 个哨兵
    expect(sentinelCount(result.prompt)).toBe(6);
    expect(result.prompt).toContain('根约定');
    expect(result.prompt).toContain('近的约定');
    expect(result.prompt).toContain('远的约定');
    // 每一条丢弃都留了可见标记（P1 + 技能 = 2 条）
    expect(result.prompt.split('已按总预算丢弃').length - 1).toBe(2);
    // 基座提示词本身仍然完整：头部在最前、输出契约在最后
    expect(result.prompt.startsWith(splitBasePrompt(BASE).head)).toBe(true);
    expect(result.prompt.slice(result.prompt.indexOf(CONTRACT_MARKER))).toBe(
      BASE.slice(BASE.indexOf(CONTRACT_MARKER)),
    );
  });

  it('略超预算：先丢技能正文，AGENTS.md 的段一段都不丢', () => {
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

    // 预算只差 1 个字符也要先牺牲技能正文 —— AGENTS.md 不在丢弃清单里
    expect(trimmed.stats.truncated).toEqual(['skill:/issue-triage']);
    expect(trimmed.prompt).toContain('技能正文未进上下文');
    expect(trimmed.prompt).toContain('远的约定');
    expect(trimmed.prompt).toContain('近的约定');
    expect(trimmed.prompt).toContain('根约定');
    // 三段围栏（开 + 关）× 3 = 6 个哨兵，一个都不能少
    expect(sentinelCount(trimmed.prompt)).toBe(6);
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

/* ── P1：项目人格层（W3-G，`docs/plan-multi-repo.md` §7）────────────────────── */

describe('assemblePrompt · P1 项目人格层（projectPrompt）', () => {
  const P1 = ['这个仓库是一个 Go 写的调度器。', '', '术语：把 job 叫「任务」，把 worker 叫「执行器」。'].join('\n');

  it('没有 P1（缺省 / null / 空串 / 全空白）时，输出与「P1 不存在」逐字节相同', () => {
    const agentsMd = {
      root: section('AGENTS.md', '仓库根约定'),
      nearby: [section('apps/server/AGENTS.md', 'server 目录约定')],
      skipped: [],
    };
    const skill = { name: '/issue-triage', promptText: '技能正文……' };
    const withoutP1 = assemblePrompt({ basePrompt: BASE, agentsMd, skill });

    for (const projectPrompt of [undefined, null, '', '   \n\n  ']) {
      const withEmpty = assemblePrompt({ basePrompt: BASE, agentsMd, skill, projectPrompt });
      // 逐字节相同：加一层「空 P1」不该改任何字节（这是兼容性硬约束）
      expect(withEmpty.prompt).toBe(withoutP1.prompt);
      expect(withEmpty.stats).toEqual(withoutP1.stats);
    }
    expect(withoutP1.prompt).not.toContain(ASSEMBLE_HEADINGS.project);
  });

  it('有 P1：插在 head 之后、AGENTS.md 之前；输出契约仍是最后一段', () => {
    const result = assemblePrompt({
      basePrompt: BASE,
      projectPrompt: P1,
      agentsMd: { root: section('AGENTS.md', '仓库根约定'), nearby: [], skipped: [] },
      skill: { name: '/issue-triage', promptText: '技能正文……' },
    });

    const { head } = splitBasePrompt(BASE);
    // 1. head 原样在最前
    expect(result.prompt.startsWith(`${head}\n\n`)).toBe(true);
    // 2. 层序：P1 → AGENTS.md → 技能 → 输出契约
    const indexProject = result.prompt.indexOf(`## ${ASSEMBLE_HEADINGS.project}`);
    const indexAgents = result.prompt.indexOf(ASSEMBLE_HEADINGS.agents);
    const indexSkill = result.prompt.indexOf(`${ASSEMBLE_HEADINGS.skillPrefix} /issue-triage`);
    const indexContract = result.prompt.indexOf(CONTRACT_MARKER);
    expect(indexProject).toBeGreaterThan(head.length);
    expect(indexAgents).toBeGreaterThan(indexProject);
    expect(indexSkill).toBeGreaterThan(indexAgents);
    expect(indexContract).toBeGreaterThan(indexSkill);
    // 3. P1 的正文字节原样进去（不做二次转义、不加不可信围栏：它是 owner 在面板写的配置）
    expect(result.prompt).toContain(P1);
    expect(sentinelCount(result.prompt)).toBe(2); // 只有 AGENTS.md 那一段围栏
    // 4. 输出契约原样在最尾
    expect(result.prompt.slice(indexContract)).toBe(BASE.slice(BASE.indexOf(CONTRACT_MARKER)));
    expect(result.stats.promptChars).toBe(`## ${ASSEMBLE_HEADINGS.project}\n\n${P1}`.length);
  });

  it('只有 P1（没有 AGENTS.md/技能）时也照样插在 head 之后', () => {
    const result = assemblePrompt({ basePrompt: BASE, projectPrompt: P1 });
    const { head } = splitBasePrompt(BASE);
    expect(result.prompt.startsWith(`${head}\n\n## ${ASSEMBLE_HEADINGS.project}\n\n`)).toBe(true);
    expect(result.stats.agentsChars).toBe(0);
    expect(result.stats.skillChars).toBe(0);
    expect(result.stats.promptChars).toBeGreaterThan(0);
  });

  it('超预算：P1 先于技能被整段丢弃，两者都留可见标记', () => {
    const result = assemblePrompt({
      basePrompt: BASE,
      projectPrompt: P1,
      agentsMd: {
        root: section('AGENTS.md', '根约定'),
        nearby: [section('a/AGENTS.md', '近的约定')],
        skipped: [],
      },
      skill: { name: '/issue-triage', promptText: '技能正文……' },
      // 只够装 basePrompt：能丢的全丢
      budgetChars: 1,
    });

    // 丢弃顺序：P1 → 技能。AGENTS.md 不在这个清单里（它不可裁）
    expect(result.stats.truncated).toEqual(['project', 'skill:/issue-triage']);
    expect(result.prompt).not.toContain(P1);
    expect(result.prompt).toContain('项目提示词未进上下文');
    // AGENTS.md 原样保留：两段围栏都在
    expect(result.prompt).toContain('根约定');
    expect(result.prompt).toContain('近的约定');
    expect(sentinelCount(result.prompt)).toBe(4);
    // 基座本身仍完整：head 在最前、输出契约在最后
    expect(result.prompt.startsWith(splitBasePrompt(BASE).head)).toBe(true);
    expect(result.prompt.slice(result.prompt.indexOf(CONTRACT_MARKER))).toBe(
      BASE.slice(BASE.indexOf(CONTRACT_MARKER)),
    );
  });
});

/* ── 保存期预算预演（`prompt/budget.ts`）────────────────────────────────────── */
