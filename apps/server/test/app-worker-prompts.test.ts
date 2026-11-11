/**
 * 提示词里的「信封示例」必须**真的合规**，并且标签集只能来自项目词表。
 *
 * 两条由来（都是「提示词在教模型犯错」）：
 *  1. 旧版 `buildTaskPrompt` / `buildAnswerPrompt` 的示例写着 `"usage": {}`、
 *     `"evidence": ["一句话依据"]`，而契约（`packages/envelope/src/schema.ts`）要求
 *     `usage` 必须有三个数字字段、`evidence` 项必须有 `rule` + `quote`——
 *     **照着提示词写出来的信封一定不合规**，于是每轮都判 parse 失败、用户什么也收不到。
 *  2. 旧版把示范标签写成固定一串（`bug / feature / needs-info / area/db`），
 *     于是每个仓库都被教成同一套「平台词汇」，和面板里配的 `labels.vocabulary` 无关。
 *
 * 所以这里不做「包含某个字符串」这种松断言：示例代码块直接丢给 Ajv，
 * 标签集则断言「词表里的名字出现、写死的平台词汇消失」。
 */
import { describe, expect, it } from 'vitest';

import { parseRepoSettings, repoSettingsShapeSchema } from '../../../packages/contract/src/index.ts';
import { buildAnswerPrompt, buildTaskPrompt } from '../src/app/worker-deps.ts';
import { parseEnvelopeJson } from '../src/worker/deps.ts';

/** 取 prompt 里**最后一个** ```json 代码块（契约要求信封是最后一个代码块）。 */
function lastJsonBlock(prompt: string): string {
  const blocks = [...prompt.matchAll(/```json\n([\s\S]*?)```/gu)].map((matched) => matched[1] ?? '');
  expect(blocks.length).toBeGreaterThan(0);
  return blocks[blocks.length - 1] ?? '';
}

const baseTaskInput = { command: '/issue-triage', repo: 'octo/demo', targetKind: 'issue' as const, targetNumber: 17, dryRun: false };

describe('任务提示词：信封示例必须能通过 Ajv', () => {
  it('buildAnswerPrompt（@answer）：最后一个 json 代码块合规', () => {
    const prompt = buildAnswerPrompt({
      repo: 'octo/demo',
      targetKind: 'issue',
      targetNumber: 17,
      question: '这个 EACCES 是只读挂载导致的吗？',
    });

    const block = lastJsonBlock(prompt);
    expect(parseEnvelopeJson(block).ok).toBe(true);

    // 硬要求写清楚：最后一个代码块 + 能 JSON.parse + 字段示例齐全
    expect(prompt).toContain('**最后一段**');
    expect(prompt).toContain('JSON.parse');
    expect(prompt).toContain('"inputTokens"');
    expect(prompt).toContain('"costUsd"');
    // 人话段必须独立成立（兜底路径只发它）
    expect(prompt).toContain('只发这一段');
    // `verdict.kind` 用目标类型，避免模型去猜 issue/pr
    expect(block).toContain('"kind": "issue"');
  });

  it('buildAnswerPrompt：pr 目标的示例 kind 跟着变', () => {
    const prompt = buildAnswerPrompt({ repo: 'octo/demo', targetKind: 'pr', targetNumber: 8, question: '改得对吗？' });
    expect(lastJsonBlock(prompt)).toContain('"kind": "pr"');
  });

  it('buildTaskPrompt（/issue-triage 等）：最后一个 json 代码块合规', () => {
    const prompt = buildTaskPrompt(baseTaskInput);
    expect(parseEnvelopeJson(lastJsonBlock(prompt)).ok).toBe(true);
  });
});

describe('任务提示词：标签集来自 settings.labels.vocabulary', () => {
  const settings = parseRepoSettings({
    // `agent.managers` 非空同样是 §4.5 / Q4 的硬要求（否则整份配置解析失败）。
    agent: { managers: ['alice'] },
    labels: {
      vocabulary: [
        // `role` 自 §4.5 / Q4 起必填；`requirement` / `defect` 两类各至少 1 条（§4.5 的硬校验），
        // 顺序保持 `缺陷` 在前 —— 下面断言「示例信封的 labels 取词表第一项」。
        { name: '缺陷', role: 'defect', meaning: '功能不符合预期', color: 'D73A4A', group: '类型' },
        { name: '缺少信息', role: 'other', meaning: '正文不足以复现', group: '类型' },
        { name: '需求', role: 'requirement', meaning: '新的功能或改进' },
      ],
      map: { bug: '缺陷', 'needs-info': '缺少信息' },
    },
  });

  it('有词表：逐个渲染标签名与含义，示例信封里的 labels 取词表第一项', () => {
    const prompt = buildTaskPrompt({ ...baseTaskInput, settings });

    expect(prompt).toContain('## 项目标签');
    expect(prompt).toContain('`缺陷`');
    expect(prompt).toContain('功能不符合预期');
    expect(prompt).toContain('`缺少信息`');
    expect(prompt).toContain('互斥组：类型');
    // 示例信封用的是词表里的名字，而不是写死的平台词汇
    expect(lastJsonBlock(prompt)).toContain('"labels": ["缺陷"]');
    expect(parseEnvelopeJson(lastJsonBlock(prompt)).ok).toBe(true);
  });

  it('有词表：写死的平台标签集不再出现（bug / feature / area/db 之类）', () => {
    const prompt = buildTaskPrompt({ ...baseTaskInput, settings });

    expect(prompt).not.toContain('（bug / feature / question / docs / needs-info / area/db）');
    expect(prompt).not.toContain('"labels": ["bug"]');
  });

  it('没有词表 / 没有 settings：退回「只打仓库已有标签」的说明，示例 labels 为空', () => {
    for (const input of [
      baseTaskInput,
      // 空词表在严格层（superRefine 要求两角色各 1 条）已经非法，但「词表为空」正是本用例的前提，
      // 所以走**形状层**（默认值 = 空词表），模拟「仓库没配词表」的历史配置。
      { ...baseTaskInput, settings: repoSettingsShapeSchema.parse({ agent: { managers: ['alice'] } }) },
      { ...baseTaskInput, settings: null },
    ]) {
      const prompt = buildTaskPrompt(input);
      expect(prompt).toContain('本仓库没有配置标签词表');
      expect(prompt).toContain('只能用该 issue 上已经存在的标签名');
      expect(lastJsonBlock(prompt)).toContain('"labels": []');
      expect(parseEnvelopeJson(lastJsonBlock(prompt)).ok).toBe(true);
    }
  });
});
