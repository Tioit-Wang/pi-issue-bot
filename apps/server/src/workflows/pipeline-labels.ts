/**
 * 分类结论 → 要打哪些标签（`docs/plan-fixed-pipeline.md` §4.5 / §6 / §10.3）。
 *
 * 分工必须照这个顺序理解，否则很容易「顺手」写成第二套打标逻辑：
 *
 *  1. **模型只给结论**（`requirement` / `defect` / `not-found` / `other`），
 *     它给的 `verdict.labels` 在阶段任务里**被忽略**（§4.1）；
 *  2. 结论 → 标签名由**项目词表的 `role`** 决定（`labels.vocabulary[].role`）；
 *  3. 标签名的**互斥组 / 上限 / 白名单 / 人工否决 / labels.missing** 全部交给既有
 *     `workflows/normalize.ts::normalizeDesired()`（逐条钉死在 `test/workflow-normalize.test.ts`），
 *     这里只负责「把判定名换成标签名」并补一层恒等映射（与 `worker/writeback.ts::planLabelWriteback` 同口径）。
 *
 * 两条刻意放宽（契约层已确认，见 `packages/contract/src/repo-config.ts::pipelineLabelCoverage`）：
 *  - 词表里没有某个 role 的项 → **返回空数组 + warn 一次，不报错**：流程照跑，只是这类结论不打标；
 *    `settings_valid` 不因此变 false（否则「存量仓库没补 role」= 上线即瘫痪）；
 *  - `not-found` **一律不打缺陷标签**（D3：虚拟缺陷不打标，评论里说明查不到）。
 */
import type {
  LabelRole,
  LabelVocabularyEntry,
  PipelineCategory,
  RepoConfig,
  RepoSettings,
} from '../../../../packages/contract/src/index.ts';
import type { Logger } from '../../../../packages/shared/src/index.ts';
import { normalizeDesired } from './normalize.ts';
import type { BlockedLabel, NormalizeDesiredResult } from './normalize.ts';

/* ── `needs-info` 标签名（阶段 0/1 的「缺信息」打标共用） ─────────────────────── */

/** 判定键：缺必填信息（`labels.map` 里可以把它改名成仓库自己的标签）。 */
export const NEEDS_INFO_KEY = 'needs-info';

/** `labels.map` 里没有 `needs-info` 映射时用的字面量标签名。 */
export const NEEDS_INFO_FALLBACK_LABEL = 'needs-info';

/**
 * `needs-info` 在该仓库里的实际标签名（映射的第一项；1:N 时取第一个）。
 *
 * 为什么这里自带兜底而不是要求每个仓库都写 `labels.map['needs-info']`：
 * 缺信息打标是**平台级行为**（`docs/impl-multi-repo.md` §0.3），不该因为一个新仓库
 * 没配映射就静默失效（否则上线即瘫痪）；配了映射的按映射走
 * （`labels.map['needs-info'] = '缺少信息'` 之类），没配（或映射到空串）就用字面量。
 */
export function needsInfoLabelOf(config: RepoConfig): string {
  const mapped = config.labels.map[NEEDS_INFO_KEY];
  if (mapped === undefined) {
    return NEEDS_INFO_FALLBACK_LABEL;
  }
  const first = typeof mapped === 'string' ? mapped : mapped[0];
  return first === undefined || first === '' ? NEEDS_INFO_FALLBACK_LABEL : first;
}

/** 只要 `warn` 就够（测试注入 `createNullLogger()`，生产注入带 repo 绑定的 child）。 */
export type PipelineLabelLogger = Pick<Logger, 'warn'>;

/**
 * 词表里 `role` 命中的标签名（保持词表顺序：互斥组与上限都按输入顺序判定）。
 *
 * 纯函数，不打日志：日志由 `pipelineLabelsFor()` 统一发（避免同一个 issue 每次分类都刷一条）。
 */
export function labelsOfRole(
  vocabulary: readonly LabelVocabularyEntry[],
  role: LabelRole,
): string[] {
  const out: string[] = [];
  for (const entry of vocabulary) {
    if (entry.role !== role) {
      continue;
    }
    const name = entry.name.trim();
    if (name !== '' && !out.includes(name)) {
      out.push(name);
    }
  }
  return out;
}

/**
 * 结论 → 应该打的标签名数组（`not-found` 一律 `[]`）。
 *
 * 「没有任何该 role 的标签」时返回 `[]` 并 `warn` 一次（**不抛错**）：这类结论只是不打标，
 * 流程（评论 / `@managers` / 状态推进）仍然照跑。
 */
export function pipelineLabelsFor(
  settings: Pick<RepoSettings, 'labels'>,
  result: PipelineCategory,
  logger?: PipelineLabelLogger,
): string[] {
  if (result === 'not-found') {
    // D3：虚拟缺陷 / 未知分类不打缺陷标签，评论里说「当前查不到」
    return [];
  }
  const vocabulary = settings.labels.vocabulary;
  const labels = labelsOfRole(vocabulary, result);
  if (labels.length === 0) {
    logger?.warn(
      { role: result, vocabularySize: vocabulary.length },
      `labels.vocabulary 里没有任何 role=${result} 的标签：本次结论不打标（流程继续）`,
    );
  }
  return labels;
}

/**
 * 结论 → 归一化之后的最终标签（走 `normalizeDesired`：互斥组 / 上限 / 白名单 / 人工否决）。
 *
 * `normalizeDesired` 的第 1 步要求「判定键在 `labels.map` 里有映射」，而这里的键**已经是标签名**，
 * 所以补一层恒等映射（显式 `labels.map` 优先，它仍然承担改名与 1:N 展开）——
 * 与 `worker/writeback.ts::planLabelWriteback()` 完全同一个做法，两处都不改 `normalizeDesired` 的规则。
 */
export function pipelineLabelPlan(input: {
  readonly settings: Pick<RepoSettings, 'labels'>;
  readonly result: PipelineCategory;
  /** 人撤下过的标签（`bot_labels` 里 `removed_at` 非空且之后没重打的）。 */
  readonly humanVetoed?: readonly string[];
  readonly logger?: PipelineLabelLogger;
}): NormalizeDesiredResult {
  const keys = pipelineLabelsFor(input.settings, input.result, input.logger);
  const identity: Record<string, string> = {};
  for (const key of keys) {
    identity[key] = key;
  }
  return normalizeDesired({
    keys,
    labels: { ...input.settings.labels, map: { ...identity, ...input.settings.labels.map } },
    ...(input.humanVetoed === undefined ? {} : { humanVetoed: input.humanVetoed }),
  });
}

/** 归一化之后真要打的标签（顺序与 `pipelineLabelPlan().desired` 一致）。 */
export function pipelineLabelsToApply(input: {
  readonly settings: Pick<RepoSettings, 'labels'>;
  readonly result: PipelineCategory;
  readonly humanVetoed?: readonly string[];
  readonly logger?: PipelineLabelLogger;
}): readonly string[] {
  return pipelineLabelPlan(input).desired;
}

/** 被拦住的部分（面板 `label_decisions` 已有展示通路，这里只做投影方便调用方拼一行提示）。 */
export function blockedLabelNames(blocked: readonly BlockedLabel[]): string[] {
  return blocked.map((item) => item.label);
}
