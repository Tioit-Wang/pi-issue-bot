/**
 * `needs-info` 标签名（平台级的「缺信息」打标）。
 *
 * 为什么单独一个模块：它原先住在 `workflows/pipeline-labels.ts`（v1.5 的「结论 → 标签」），
 * 流水线退役后（`docs/dev-plan-issue-agent.md` §1 行 2）打标改由 agent 侧决定，但
 * 「缺信息用哪个仓库标签」仍是平台级行为，所以搬到这里，语义不变。
 *
 * 为什么自带兜底而不是要求每个仓库都写 `labels.map['needs-info']`：
 * 缺信息打标是**平台级行为**（`docs/impl-multi-repo.md` §0.3），不该因为一个新仓库
 * 没配映射就静默失效（否则上线即瘫痪）；配了映射的按映射走
 * （`labels.map['needs-info'] = '缺少信息'` 之类），没配（或映射到空串）就用字面量。
 */
import type { RepoConfig } from '../../../../packages/contract/src/index.ts';

/** 判定键：缺必填信息（`labels.map` 里可以把它改名成仓库自己的标签）。 */
export const NEEDS_INFO_KEY = 'needs-info';

/** `labels.map` 里没有 `needs-info` 映射时用的字面量标签名。 */
export const NEEDS_INFO_FALLBACK_LABEL = 'needs-info';

/** `needs-info` 在该仓库里的实际标签名（映射的第一项；1:N 时取第一个）。 */
export function needsInfoLabelOf(config: RepoConfig): string {
  const mapped = config.labels.map[NEEDS_INFO_KEY];
  if (mapped === undefined) {
    return NEEDS_INFO_FALLBACK_LABEL;
  }
  const first = typeof mapped === 'string' ? mapped : mapped[0];
  return first === undefined || first === '' ? NEEDS_INFO_FALLBACK_LABEL : first;
}
