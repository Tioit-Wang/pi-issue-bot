/**
 * 提示词里的「信封示例」必须**真的合规**。
 *
 * 这条测试的由来：旧版的 `buildTaskPrompt` / `buildAnswerPrompt` 里给模型的示例写着
 * `"usage": {}`、`"evidence": ["一句话依据"]`，而契约（`packages/envelope/src/schema.ts`）
 * 要求 `usage` 必须有 `inputTokens` / `outputTokens` / `costUsd`，`evidence` 项必须有
 * `rule` + `quote`。也就是说：**照着提示词写出来的信封一定不合规** ——
 * 于是每一轮都判 `parse` 失败、用户什么也收不到。
 *
 * 所以这里不做「包含某个字符串」这种松断言，直接把示例代码块丢给 Ajv：
 * 示例不过，说明提示词在教模型犯法。
 */
import { describe, expect, it } from 'vitest';

import { buildAnswerPrompt, buildTaskPrompt } from '../src/app/worker-deps.ts';
import { parseEnvelopeJson } from '../src/worker/deps.ts';

/** 取 prompt 里**最后一个** ```json 代码块（契约要求信封是最后一个代码块）。 */
function lastJsonBlock(prompt: string): string {
  const blocks = [...prompt.matchAll(/```json\n([\s\S]*?)```/gu)].map((matched) => matched[1] ?? '');
  expect(blocks.length).toBeGreaterThan(0);
  return blocks[blocks.length - 1] ?? '';
}

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
    const prompt = buildTaskPrompt({
      command: '/issue-triage',
      repo: 'octo/demo',
      targetKind: 'issue',
      targetNumber: 17,
      dryRun: false,
    });

    expect(parseEnvelopeJson(lastJsonBlock(prompt)).ok).toBe(true);
  });
});
