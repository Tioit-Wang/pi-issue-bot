/**
 * 「最终 system prompt 预览」—— 面板编辑 P1 时看到的那段文本。
 *
 * 硬约束（`docs/plan-multi-repo.md` §7 最后两条）：
 *  **预览必须调用与运行时同一个装配函数**（`assemblePrompt`），不能在前端或路由里另写一份拼接。
 *  否则「预览好看、跑起来不是那段」这种问题永远不会被发现。
 *
 * ## 为什么这里的 basePrompt 是「示例基座」
 *
 * 真实基座来自 `app/worker-deps.ts` 的 `buildTaskPrompt()`，它的入参是**任务行**（repo / 命令 /
 * 目标编号 / dry-run），面板在保存这一刻没有任务。所以：
 *  - 默认用 `previewBasePrompt()`（与 `buildTaskPrompt` 同构：一行身份头 + 空行 + 输出契约）；
 *  - 装配器照样走「头之后、输出契约之前」的插入逻辑，因此预览里 P1 的位置与运行期**一致**；
 *  - 调用方（`compose.ts` / `serve`）可以把真实的基座构造结果通过 `basePrompt` 注入，
 *    那时预览与运行期的整段文本完全相同（`docs/impl-multi-repo.md` W3-G 汇报里的接口形状）。
 *
 * 预览**不**带 AGENTS.md / 技能层：这两层来自 worktree，面板里读不到。返回体的 `omitted`
 * 明说这件事，免得有人以为「预览里没有 AGENTS.md = 运行时不带」。
 */

import { assemblePrompt } from '../skills/assemble.ts';
import type { AssemblePromptStats } from '../skills/assemble.ts';

/** 预览用的示例基座（与 `buildTaskPrompt` 同构：头部一行 + 空行 + 输出契约）。 */
export function previewBasePrompt(repo: string): string {
  return [
    `你是 pi-bot，正在处理 ${repo} 的 issue #1（预览基座，真实基座由 buildTaskPrompt 生成）。`,
    '',
    '输出分两段，顺序不能反，也不要再加别的段落：',
    '',
    '【第一段】给人看的回复：中文，不超过 8 行。',
    '',
    '【第二段】**唯一**一个 ```json 代码块。',
  ].join('\n');
}

export interface PreviewPromptInput {
  readonly repo: string;
  /** P1 正文（`prompt_versions.body`）；空串 = 没有这一层。 */
  readonly body: string;
  /** 覆盖示例基座（运行期可注入真实的 `buildTaskPrompt()` 结果）。 */
  readonly basePrompt?: string;
  /** 覆盖总预算（单测用）。 */
  readonly budgetChars?: number;
}

export interface PreviewPromptResult {
  readonly text: string;
  readonly stats: AssemblePromptStats;
  /** 预览里**没有**参与的层，面板要显示成提示而不是当成「运行期也没有」。 */
  readonly omitted: readonly string[];
}

/** 预览最终文本：`assemblePrompt({ basePrompt, projectPrompt })` 的原样产出。 */
export function previewPrompt(input: PreviewPromptInput): PreviewPromptResult {
  const basePrompt = input.basePrompt ?? previewBasePrompt(input.repo);
  const assembled = assemblePrompt({
    basePrompt,
    projectPrompt: input.body,
    ...(input.budgetChars === undefined ? {} : { budgetChars: input.budgetChars }),
  });
  return {
    text: assembled.prompt,
    stats: assembled.stats,
    omitted: ['AGENTS.md（来自 worktree）', '任务技能（来自 registry）'],
  };
}
