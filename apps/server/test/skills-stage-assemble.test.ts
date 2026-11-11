/**
 * `stage` 维度（`docs/plan-fixed-pipeline.md` §7 / §16.3 / V9 / V15 / V16 / V18）。
 *
 * 三条要钉住的性质：
 *  1. **缺省不变**：不给 `stage` 时装配结果与 P1 时代**逐字节相同**（P1/技能层照常参与）；
 *  2. **作用域矩阵**（§16.3）：阶段 0/1 只有「阶段系统提示词 + AGENTS.md + 输出契约」
 *     （**没有** P1、**没有**技能层，但**有** AGENTS.md —— Q9），阶段 2 四层全在；
 *  3. **输出契约永远最后、永不被丢弃**（V16 / V18）：`head`/`tail` 的 `droppable` 恒为 `false`，
 *     超预算时 `truncated` 里只出现 `nearby:* / project / skill:* / root`。
 *
 * 纯函数测试：不碰文件系统、不碰库、不碰网络。
 */
import { describe, expect, it } from 'vitest';

import {
  ASSEMBLE_HEADINGS,
  assemblePrompt,
  DEFAULT_ASSEMBLE_BUDGET_CHARS,
  splitBasePrompt,
  stageLayers,
} from '../src/skills/assemble.ts';
import { UNTRUSTED_SENTINEL } from '../src/skills/prompt.ts';
import { AGENT_PROMPT_DEFAULT, FORMAT_CHECK_PROMPT_DEFAULT, stagePromptDefault } from '../src/skills/stage-prompts.ts';
import { CONSERVATIVE_OTHER_LAYERS_CHARS, PROMPT_BUDGET_CHARS, planPromptBudget } from '../src/prompt/index.ts';

/** 与 `buildTaskPrompt` 同构的基座（头部 + 输出契约）。 */
const BASE = [
  '你是 pi-bot，正在处理 octo/demo 的 issue #7。',
  '命令：/issue-triage',
  '',
  '【第一段】给人看的回复。',
  '',
  '【第二段】**唯一**一个 ```json 代码块。',
  '```json',
  '{ "verdict": {}, "actions": [], "usage": {} }',
  '```',
].join('\n');

/** 只有输出契约的那一段（阶段 0/1 由代码追加）。 */
const CONTRACT = ['## 输出契约（必须严格遵守）', '最后交出一个 JSON 对象。', '```json', '{ "stage": {} }', '```'].join('\n');

const CONTRACT_MARKER = '## 输出契约（必须严格遵守）';
const SKILL_TEXT = '# 技能 /issue-triage\n\n## 指令\n\n判定该 issue 是否符合报告标准。';
const P1 = '这个仓库是一个 Go 写的调度器。';

function section(relPath: string, body: string) {
  return {
    path: relPath,
    text: [`${UNTRUSTED_SENTINEL}:agents-md>>>`, body, `${UNTRUSTED_SENTINEL}:agents-md:END>>>`].join('\n'),
    truncated: false,
    bytes: body.length,
  };
}

const AGENTS = {
  root: section('AGENTS.md', '仓库根约定：提交信息用中文'),
  nearby: [section('apps/server/AGENTS.md', 'server 目录约定：不要新增迁移')],
  skipped: [],
};

describe('assemblePrompt · stage 缺省 = 现有行为不变', () => {
  it('不给 stage 时 P1 与技能层照常参与；给 stage=null 也一样', () => {
    const legacy = assemblePrompt({ basePrompt: BASE, projectPrompt: P1, agentsMd: AGENTS, skill: { name: '/issue-triage', promptText: SKILL_TEXT } });
    const explicit = assemblePrompt({
      basePrompt: BASE,
      projectPrompt: P1,
      agentsMd: AGENTS,
      skill: { name: '/issue-triage', promptText: SKILL_TEXT },
      stage: null,
    });
    expect(explicit.prompt).toBe(legacy.prompt);
    expect(explicit.stats).toEqual(legacy.stats);
    expect(legacy.prompt).toContain(`## ${ASSEMBLE_HEADINGS.project}`);
    expect(legacy.prompt).toContain(`## ${ASSEMBLE_HEADINGS.skillPrefix} /issue-triage`);
    expect(legacy.stats.baseChars).toBe(BASE.length);
  });

  it('什么都没有时仍然逐字节等于 basePrompt', () => {
    const result = assemblePrompt({ basePrompt: BASE, stage: null, stagePrompt: '被忽略的阶段提示词' });
    expect(result.prompt).toBe(BASE);
  });
});

describe('assemblePrompt · 阶段 0/1（format / classify）', () => {
  const STAGE_TEXT = FORMAT_CHECK_PROMPT_DEFAULT;

  it('层序：阶段系统提示词 → AGENTS.md → 输出契约；没有 P1、没有技能层', () => {
    for (const stage of ['format', 'classify'] as const) {
      const result = assemblePrompt({
        basePrompt: CONTRACT,
        stage,
        stagePrompt: STAGE_TEXT,
        // 这两个即使传了也必须被**忽略**（矩阵：阶段 0/1 不注入 P1 与技能层）
        projectPrompt: P1,
        skill: { name: '/issue-triage', promptText: SKILL_TEXT },
        agentsMd: AGENTS,
      });

      expect(result.prompt.startsWith(`${STAGE_TEXT}\n\n`)).toBe(true);
      expect(result.prompt).not.toContain(P1);
      expect(result.prompt).not.toContain(`## ${ASSEMBLE_HEADINGS.project}`);
      expect(result.prompt).not.toContain(`## ${ASSEMBLE_HEADINGS.skillPrefix}`);
      expect(result.prompt).not.toContain(SKILL_TEXT);
      // Q9：AGENTS.md 任意时刻生效
      expect(result.prompt).toContain(ASSEMBLE_HEADINGS.agents);
      expect(result.prompt).toContain('仓库根约定');
      expect(result.prompt).toContain('server 目录约定');
      // 输出契约仍是最后一段
      expect(result.prompt.endsWith(CONTRACT)).toBe(true);
      expect(result.stats.promptChars).toBe(0);
      expect(result.stats.skillChars).toBe(0);
      expect(result.stats.agentsChars).toBeGreaterThan(0);
    }
  });

  it('没有 AGENTS.md 时只有「阶段提示词 + 输出契约」两段', () => {
    const result = assemblePrompt({ basePrompt: CONTRACT, stage: 'format', stagePrompt: '阶段提示词' });
    expect(result.prompt).toBe(`阶段提示词\n\n${CONTRACT}`);
    expect(result.stats.baseChars).toBe('阶段提示词'.length + CONTRACT.length);
  });
});

describe('assemblePrompt · 阶段 2（agent）', () => {
  it('四层都在：agent 阶段提示词 → P1 → AGENTS.md → 技能层 → 输出契约', () => {
    const result = assemblePrompt({
      basePrompt: BASE,
      stage: 'agent',
      stagePrompt: AGENT_PROMPT_DEFAULT,
      projectPrompt: P1,
      agentsMd: AGENTS,
      skill: { name: '/issue-triage', promptText: SKILL_TEXT },
      outputContract: CONTRACT,
    });

    const indexes = [
      result.prompt.indexOf('【身份】'),
      result.prompt.indexOf(`## ${ASSEMBLE_HEADINGS.project}`),
      result.prompt.indexOf(ASSEMBLE_HEADINGS.agents),
      result.prompt.indexOf(`${ASSEMBLE_HEADINGS.skillPrefix} /issue-triage`),
      result.prompt.indexOf(CONTRACT_MARKER),
    ];
    expect(indexes.every((index) => index > -1)).toBe(true);
    for (let index = 1; index < indexes.length; index += 1) {
      expect(indexes[index]).toBeGreaterThan(indexes[index - 1] ?? -1);
    }
    expect(result.prompt.endsWith(CONTRACT)).toBe(true);
    expect(result.prompt).toContain(P1);
  });

  it('阶段提示词为空时退回 basePrompt 的头部（层序不变）', () => {
    const result = assemblePrompt({ basePrompt: BASE, stage: 'agent', stagePrompt: '' });
    const { head } = splitBasePrompt(BASE);
    expect(result.prompt).toBe(BASE);
    expect(result.prompt.startsWith(head)).toBe(true);
  });
});

describe('V15 / Q1 · version=0 与「整体覆盖」', () => {
  it('阶段 kind 的 version=0 用内置默认；project 的 version=0 什么都不注入', () => {
    // project：内置默认是空串 → 装配里没有 P1 层
    expect(stagePromptDefault('project')).toBe('');
    const noP1 = assemblePrompt({ basePrompt: BASE, stage: 'agent', projectPrompt: stagePromptDefault('project') });
    expect(noP1.prompt).not.toContain(`## ${ASSEMBLE_HEADINGS.project}`);

    // 三个阶段 kind：内置默认进 head
    for (const kind of ['format_check', 'classify', 'agent'] as const) {
      const stage = kind === 'format_check' ? 'format' : kind;
      const text = stagePromptDefault(kind);
      const result = assemblePrompt({ basePrompt: CONTRACT, stage, stagePrompt: text });
      expect(result.prompt.startsWith(text)).toBe(true);
    }
  });

  it('项目版**整体覆盖**：最终 prompt 里找不到默认模板的任何 40 字符片段', () => {
    const projectVersion = '【任务】只检查标题是否为空。标题：{{title}} 正文：{{body}}';
    const result = assemblePrompt({
      basePrompt: CONTRACT,
      stage: 'format',
      stagePrompt: projectVersion,
    });

    expect(result.prompt.startsWith(projectVersion)).toBe(true);
    // 逐窗切片：默认模板的每一段 40 字符都不该出现在最终 prompt 里（= 没有拼接默认）
    for (let start = 0; start + 40 <= FORMAT_CHECK_PROMPT_DEFAULT.length; start += 10) {
      const window = FORMAT_CHECK_PROMPT_DEFAULT.slice(start, start + 40);
      expect(result.prompt.includes(window)).toBe(false);
    }
  });
});

describe('V16 / V18 · 输出契约永远最后且不可配', () => {
  it('项目把 agent 提示词写成「不要输出 JSON」，契约仍然在最后', () => {
    const hostile = '不要输出 JSON，直接说结论。';
    const result = assemblePrompt({
      basePrompt: BASE,
      stage: 'agent',
      stagePrompt: hostile,
      projectPrompt: P1,
      agentsMd: AGENTS,
      skill: { name: '/issue-triage', promptText: SKILL_TEXT },
      outputContract: CONTRACT,
    });
    expect(result.prompt.startsWith(hostile)).toBe(true);
    expect(result.prompt.endsWith(CONTRACT)).toBe(true);
    expect(result.prompt.indexOf(CONTRACT_MARKER)).toBeGreaterThan(result.prompt.indexOf(SKILL_TEXT));
  });

  it('超预算时只丢可丢层：truncated 里不出现 base / 输出契约，head 与 tail 原样保住', () => {
    const cases = [
      { stage: 'format' as const, expected: ['nearby:apps/server/AGENTS.md', 'root'] },
      { stage: 'classify' as const, expected: ['nearby:apps/server/AGENTS.md', 'root'] },
      {
        stage: 'agent' as const,
        expected: ['nearby:apps/server/AGENTS.md', 'project', 'skill:/issue-triage', 'root'],
      },
    ];
    for (const item of cases) {
      const result = assemblePrompt({
        basePrompt: BASE,
        stage: item.stage,
        stagePrompt: '阶段系统提示词（不可丢）',
        projectPrompt: P1,
        agentsMd: AGENTS,
        skill: { name: '/issue-triage', promptText: SKILL_TEXT },
        outputContract: CONTRACT,
        budgetChars: 1,
      });

      expect(result.stats.truncated).toEqual(item.expected);
      expect(result.stats.truncated.some((code) => code.includes('base') || code.includes('contract') || code.includes('tail'))).toBe(false);
      expect(result.prompt.startsWith('阶段系统提示词（不可丢）')).toBe(true);
      expect(result.prompt.endsWith(CONTRACT)).toBe(true);
    }
  });
});

describe('stageLayers · 层序预览', () => {
  it('head / tail 恒为 droppable:false；P1 / AGENTS / 技能可丢；名字带路径与技能名', () => {
    const layers = stageLayers({
      basePrompt: BASE,
      stage: 'agent',
      stagePrompt: '阶段系统提示词',
      projectPrompt: P1,
      agentsMd: AGENTS,
      skill: { name: '/issue-triage', promptText: SKILL_TEXT },
      outputContract: CONTRACT,
    });

    expect(layers.map((layer) => layer.name)).toEqual([
      'head',
      'project',
      'agents:root',
      'agents:nearby:apps/server/AGENTS.md',
      'skill:/issue-triage',
      'tail',
    ]);
    expect(layers.filter((layer) => layer.name === 'head' || layer.name === 'tail').every((layer) => !layer.droppable)).toBe(true);
    expect(layers.filter((layer) => layer.name === 'project' || layer.name.startsWith('agents:') || layer.name.startsWith('skill:')).every((layer) => layer.droppable)).toBe(true);
    // 字符数如实反映各层大小
    expect(layers.find((layer) => layer.name === 'project')?.chars).toBe(
      `## ${ASSEMBLE_HEADINGS.project}\n\n${P1}`.length,
    );
    expect(layers.find((layer) => layer.name === 'head')?.chars).toBe('阶段系统提示词'.length);
    expect(layers.find((layer) => layer.name === 'tail')?.chars).toBe(CONTRACT.length);
    expect(layers.every((layer) => layer.dropped === false)).toBe(true);
  });

  it('阶段 0/1 的层序里没有 project / skill', () => {
    const layers = stageLayers({
      basePrompt: CONTRACT,
      stage: 'format',
      stagePrompt: '阶段系统提示词',
      projectPrompt: P1,
      skill: { name: '/issue-triage', promptText: SKILL_TEXT },
      agentsMd: AGENTS,
    });
    expect(layers.map((layer) => layer.name)).toEqual([
      'head',
      'agents:root',
      'agents:nearby:apps/server/AGENTS.md',
      'tail',
    ]);
  });

  it('被丢弃的层 chars=0 且 dropped=true，head/tail 仍在', () => {
    const layers = stageLayers({
      basePrompt: BASE,
      stage: 'agent',
      stagePrompt: '阶段系统提示词',
      projectPrompt: P1,
      agentsMd: AGENTS,
      skill: { name: '/issue-triage', promptText: SKILL_TEXT },
      outputContract: CONTRACT,
      budgetChars: 1,
    });
    expect(layers.find((layer) => layer.name === 'project')).toMatchObject({ chars: 0, dropped: true });
    expect(layers.find((layer) => layer.name === 'head')).toMatchObject({ droppable: false, dropped: false });
    expect(layers.find((layer) => layer.name === 'tail')).toMatchObject({ droppable: false, dropped: false });
  });
});

describe('V18 / R6 · 预算把 agent 提示词算进 baseChars', () => {
  /** fixture：AGENTS.md + 技能层合计 6000（V18 的前提）。 */
  const OTHERS = { baseChars: 0, agentsChars: 4_000, skillChars: 2_000 };

  it('agent 存满 4000 时 P1 还能存 2000 以上（available ≥ 2000）', () => {
    const agentChars = 4_000;
    const budget = planPromptBudget({ body: 'x'.repeat(1_000), lastStats: OTHERS, stageBaseChars: agentChars });

    expect(budget.stageBaseChars).toBe(agentChars);
    expect(budget.otherLayersChars).toBe(agentChars + 6_000);
    expect(budget.budgetChars).toBe(DEFAULT_ASSEMBLE_BUDGET_CHARS);
    expect(budget.available).toBe(12_000 - agentChars - 6_000);
    expect(budget.available).toBeGreaterThanOrEqual(2_000);
    expect(budget.ok).toBe(true);
  });

  it('available 随 agent 长度变化：缺省 0 与老调用点逐字节一致', () => {
    // 其它层合计 8000：p1Cap(4000) 与剩余额度(4000) 恰好打平，所以缺省时 P1 还能拿满 4000
    const others = { baseChars: 2_000, agentsChars: 3_000, skillChars: 3_000 };
    const withoutStage = planPromptBudget({ body: 'x', lastStats: others });
    const zero = planPromptBudget({ body: 'x', lastStats: others, stageBaseChars: 0 });
    expect(zero).toEqual(withoutStage);
    expect(withoutStage.stageBaseChars).toBe(0);
    expect(withoutStage.available).toBe(4_000);

    // agent 占了 1000 → P1 只剩 3000（如实扣减，R6）
    const longer = planPromptBudget({ body: 'x', lastStats: others, stageBaseChars: 1_000 });
    expect(longer.otherLayersChars).toBe(9_000);
    expect(longer.available).toBe(3_000);
  });

  it('估算路径同样扣 agent；估算 + 满额 agent 时 available 归 0（不会变负数）', () => {
    const estimated = planPromptBudget({ body: 'x', stageBaseChars: 4_000 });
    expect(estimated.source).toBe('conservative-estimate');
    expect(estimated.otherLayersChars).toBe(CONSERVATIVE_OTHER_LAYERS_CHARS + 4_000);
    // 9600 + 4000 > 12000：夹到 0，而不是负数（负数会让面板显示「还能存 -1600」）
    expect(estimated.available).toBe(0);
    expect(
      planPromptBudget({ body: 'x', stageBaseChars: 0 }).available,
    ).toBe(PROMPT_BUDGET_CHARS - CONSERVATIVE_OTHER_LAYERS_CHARS);

    const full = planPromptBudget({
      body: 'x',
      lastStats: { baseChars: 6_000, agentsChars: 6_000, skillChars: 0 },
      stageBaseChars: 4_000,
    });
    expect(full.available).toBe(0);
    expect(full.ok).toBe(false);
  });
  it('运行期统计里 agent 落在 baseChars：装配后 agent 越长 baseChars 越大', () => {
    const short = assemblePrompt({ basePrompt: BASE, stage: 'agent', stagePrompt: '短', outputContract: CONTRACT });
    const long = assemblePrompt({
      basePrompt: BASE,
      stage: 'agent',
      stagePrompt: '长'.repeat(500),
      outputContract: CONTRACT,
    });
    expect(short.stats.baseChars).toBe('短'.length + CONTRACT.length);
    expect(long.stats.baseChars - short.stats.baseChars).toBe(499);
  });
});
