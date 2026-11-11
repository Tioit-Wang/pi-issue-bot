/**
 * 「缺必填信息」的唯一判据（`verdict.evidence` → 人读的一句话）。
 *
 * 为什么单独一个模块：它原先住在 `workflows/stage-result.ts`（v1.5 三段流水线的阶段结论读取），
 * 流水线退役后（`docs/dev-plan-issue-agent.md` §1 行 2）这个判据仍然要留给 agent 侧的
 * 「缺什么、缺在哪一行」提示，所以搬到这里，语义不变：
 *
 *  - `passed !== true` 的一律算缺（**「没给证据」≠「通过了」**）；
 *  - `quote` 截到 `REASON_QUOTE_LIMIT`：长引用会让面板的 `label_decisions.reason` 变成噪声。
 */
import type { Verdict } from '../../../../packages/envelope/src/index.ts';

/** `label_decisions.reason` 里引用原文片段的上限（长引用会让面板变成噪声）。 */
export const REASON_QUOTE_LIMIT = 80;

/** 缺的一项必填信息（来自 `verdict.evidence` 的 `passed !== true`）。 */
export type MissingEvidence = {
  readonly rule: string;
  /** 命中的原文片段（已截断）；`null` = 模型没给证据。 */
  readonly quote: string | null;
};

/** 从 verdict 里看出「缺哪些必填信息」：`passed !== true` 的都算缺（「没证据」≠「通过了」）。 */
export function missingEvidenceOf(verdict: Verdict | null): readonly MissingEvidence[] {
  const evidence = verdict?.evidence ?? [];
  return evidence
    .filter((item) => item.passed !== true)
    .map((item) => {
      const quote = (item.quote ?? '').trim();
      return {
        rule: item.rule,
        quote: quote === '' ? null : quote.slice(0, REASON_QUOTE_LIMIT),
      };
    });
}

/** 把缺项写成人读的一句话（`label_decisions.reason`，面板直接展示）。 */
export function describeMissing(evidence: readonly MissingEvidence[]): string | null {
  if (evidence.length === 0) {
    return null;
  }
  const items = evidence.map((item) =>
    item.quote === null ? `${item.rule}（当前正文里找不到依据）` : `${item.rule}（引用：「${item.quote}」）`,
  );
  return `缺 ${String(evidence.length)} 项必填信息：${items.join('；')}`;
}
