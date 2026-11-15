/**
 * 打标归一化：把「模型给的判定键」变成「真的要打到 issue 上的标签名」（`docs/impl-multi-repo.md`
 * §4 W2-E 第 1 条）。
 *
 * 为什么要有这一层（而不是在打标路径里就地做）：
 *  - 它全是纯函数，规则可以逐条钉死在单测里；打标路径（`worker/writeback.ts`）只负责 I/O。
 *  - 「哪些标签被拦了、为什么被拦」是面板要展示的东西（`label_decisions.blocked_reason`），
 *    所以拦截**必须显式产出**，不能是 `if (...) continue` 之后悄悄少一个标签。
 *
 * 规则顺序（顺序本身就是语义，改动等于改行为）：
 *
 * | # | 步骤 | 依据 | 被拦 → `reason` |
 * |---|---|---|---|
 * | 1 | `labels.map` 1:N 展开 | 判定键 → 标签名（`string` 或 `string[]`） | `unmapped` |
 * | 2 | 词表过滤 | `labels.vocabulary` 非空时只允许词表内的名字 | `not-in-vocabulary` |
 * | 3 | 白名单 | `labels.allow` 给定时只允许其中的名字 | `not-allowed` |
 * | 4 | 互斥组 | `vocabulary[].group` 相同的只留**输入顺序**里第一个 | `group-conflict` |
 * | 5 | 上限截断 | `labels.max_per_issue` | `max-per-issue` |
 * | 6 | 仓库里有没有 | `labels.missing` 的策略（只读，**不建**） | `missing-label` |
 *
 * 两处刻意的口径：
 *  - **第 1 步必须在第 2 步之前**：词表里存的是**仓库标签名**（`LabelVocabularyEntry.name`），
 *    而判定键是我们内部的短名；先展开才知道要拿谁去对词表。写成「先过滤键再展开」会把
 *    `needs-info → ['needs-info','triage']` 这类 1:N 映射里的第二个名字判成非法。
 *  - **去重是静默的**：两个判定键映射到同一个标签名时只留一份、不记 blocked——
 *    那不是「被拦」，而是同一件事说了两遍。
 *
 * 已经删掉的规则（**不要接回来**）：
 *  - **人工否决**（`human-veto`）：旧实现是「人删过一次就永久不加回」，而它的证据来自
 *    **我们自己的撤标动作**（`bot_labels.removed_at`），真正的 `issues.unlabeled` 事件从未
 *    被接收过。FR-5.4 / BR-11 要的是相反的方向：**人工删除不构成永久否决**，下一轮按目标态
 *    重新对齐；不想让平台碰某个标签，用目录里的 `managed=false` 显式标记。
 *  - **反向创建标签**（`not-creatable`）：LD-2 规定平台**不发明标签、不反向创建**。
 *    仓库里缺标签时只报错（`missing-label`），由人先在 GitHub 上建。
 */
import type { LabelVocabularyEntry, LabelsConfig } from '../../../../packages/contract/src/index.ts';

/** 归一化时可能出现的拦截原因（进 `label_decisions.blocked_reason`，面板按它分组）。 */
export type LabelBlockedReason =
  /** 判定键在 `labels.map` 里没有映射（R4：不发明标签）。 */
  | 'unmapped'
  /** 名字不在 `labels.vocabulary` 里（词表非空时生效）。 */
  | 'not-in-vocabulary'
  /** 名字不在 `labels.allow` 白名单里。 */
  | 'not-allowed'
  /** 同组已经有更靠前的标签（`vocabulary[].group`）。 */
  | 'group-conflict'
  /** 超过 `labels.max_per_issue`。 */
  | 'max-per-issue'
  /**
   * 仓库里没有这个标签。
   *
   * 只有这一种「缺标签」原因：平台**不建标签**（LD-2），所以不再区分
   * 「策略不允许建」与「建失败」—— 两种都是「仓库里没有，本轮不打」。
   */
  | 'missing-label';

/** 一条被拦下的标签 + 原因（`detail` 是给人看的一句话）。 */
export type BlockedLabel = {
  readonly label: string;
  readonly reason: LabelBlockedReason;
  readonly detail: string;
  /** 触发它的判定键；词表/白名单阶段的拦截仍然能追到来源。 */
  readonly sourceKey: string | null;
};

export type NormalizeDesiredInput = {
  /** 模型给的标签名/判定键（顺序有意义：互斥组与上限都按它先后来判）。 */
  readonly keys: readonly string[];
  /** `settings.labels`（词表 / 1:N 映射 / 白名单 / 上限）。 */
  readonly labels: LabelsConfig;
};

export type NormalizeDesiredResult = {
  /** 真正想打的标签（有序、去重），可直接喂 `planLabelTargetState()`。 */
  readonly desired: readonly string[];
  /** 被拦下的（顺序同判定过程），`reason` 进 `label_decisions.blocked_reason`。 */
  readonly blocked: readonly BlockedLabel[];
  /** 标签 → 判定键（1:N 展开时取第一个命中键）：`bot_labels.source_key` 用它。 */
  readonly sourceKeys: Readonly<Record<string, string>>;
  /** 需要记进日志/`label_decisions.reason` 的人读提示（不参与判定）。 */
  readonly warnings: readonly string[];
};

/** 把 `labels.map` 的一项归一成数组（`string | string[]`，空数组按「没有」处理）。 */
export function toLabelTargets(target: string | readonly string[] | undefined): readonly string[] {
  if (target === undefined) {
    return [];
  }
  return typeof target === 'string' ? [target] : target;
}

/** 词表 → `name → entry`（面板与提示词共用同一份口径：先出现的名字赢）。 */
export function vocabularyIndex(
  vocabulary: readonly LabelVocabularyEntry[],
): Readonly<Record<string, LabelVocabularyEntry>> {
  const index: Record<string, LabelVocabularyEntry> = {};
  for (const entry of vocabulary) {
    if (index[entry.name] === undefined) {
      index[entry.name] = entry;
    }
  }
  return index;
}

/**
 * 归一化。纯函数：同样的输入永远得到同样的输出（含 `blocked` 的顺序）。
 *
 * 为什么把「被拦」也算成输出的一部分：面板要回答「为什么这个 issue 没有 `bug` 标签」，
 * 而日志会被轮转、`console.warn` 不会被查询。拦住的事实必须随每轮判定一起落库。
 */
export function normalizeDesired(input: NormalizeDesiredInput): NormalizeDesiredResult {
  const labels = input.labels;
  const vocab = vocabularyIndex(labels.vocabulary);
  const vocabNames = new Set(Object.keys(vocab));
  const hasVocabulary = labels.vocabulary.length > 0;
  const allow = labels.allow === undefined ? null : new Set(labels.allow);

  const blocked: BlockedLabel[] = [];
  const warnings: string[] = [];
  const sourceKeys: Record<string, string> = {};

  /* ── 1. `labels.map` 1:N 展开 ─────────────────────────────────────────────── */
  const expanded: { readonly label: string; readonly sourceKey: string }[] = [];
  const seenKeys = new Set<string>();
  for (const key of input.keys) {
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    const targets = toLabelTargets(labels.map[key]);
    if (targets.length === 0) {
      blocked.push({
        label: key,
        reason: 'unmapped',
        detail: `判定键 \`${key}\` 在 labels.map 里没有映射：按 R4 不发明标签`,
        sourceKey: key,
      });
      warnings.push(`判定键 \`${key}\` 在 labels.map 里没有映射：不打这个标签（不发明标签名）`);
      continue;
    }
    for (const target of targets) {
      const label = target.trim();
      if (label === '') {
        continue;
      }
      /* ── 2. 词表过滤 ───────────────────────────────────────────────────── */
      if (hasVocabulary && !vocabNames.has(label)) {
        blocked.push({
          label,
          reason: 'not-in-vocabulary',
          detail: `\`${label}\`（来自判定键 \`${key}\`）不在 labels.vocabulary 里：词表非空时只打词表内的标签`,
          sourceKey: key,
        });
        warnings.push(`\`${label}\` 不在 labels.vocabulary 里：按词表只打声明过的标签`);
        continue;
      }
      /* ── 3. 白名单 ────────────────────────────────────────────────────── */
      if (allow !== null && !allow.has(label)) {
        blocked.push({
          label,
          reason: 'not-allowed',
          detail: `\`${label}\`（来自判定键 \`${key}\`）不在 labels.allow 白名单里：防手滑写错标签名`,
          sourceKey: key,
        });
        warnings.push(`\`${label}\` 不在 labels.allow 白名单里：不打`);
        continue;
      }
      // 去重（静默：同一件事说了两遍不算被拦）
      if (expanded.some((item) => item.label === label)) {
        continue;
      }
      expanded.push({ label, sourceKey: key });
      sourceKeys[label] = key;
    }
  }

  /* ── 4. 互斥组：同组只留输入顺序第一个 ────────────────────────────────────── */
  const groupOwner = new Map<string, string>();
  const afterGroups: { readonly label: string; readonly sourceKey: string }[] = [];
  for (const item of expanded) {
    const group = vocab[item.label]?.group;
    if (group !== undefined) {
      const owner = groupOwner.get(group);
      if (owner !== undefined) {
        blocked.push({
          label: item.label,
          reason: 'group-conflict',
          detail: `\`${item.label}\` 与 \`${owner}\` 同属互斥组 \`${group}\`：只留先判到的那个`,
          sourceKey: item.sourceKey,
        });
        warnings.push(`标签 \`${item.label}\` 与 \`${owner}\` 互斥（组 ${group}）：只保留 \`${owner}\``);
        continue;
      }
      groupOwner.set(group, item.label);
    }
    afterGroups.push(item);
  }

  /* ── 5. `max_per_issue` 截断 ─────────────────────────────────────────────── */
  const max = labels.max_per_issue;
  const afterMax = afterGroups.slice(0, max);
  for (const item of afterGroups.slice(max)) {
    blocked.push({
      label: item.label,
      reason: 'max-per-issue',
      detail: `超过 labels.max_per_issue（${String(max)}）：本轮不打 \`${item.label}\``,
      sourceKey: item.sourceKey,
    });
    warnings.push(`标签数超过上限 ${String(max)}：\`${item.label}\` 本轮不打`);
  }

  return { desired: afterMax.map((item) => item.label), blocked, sourceKeys, warnings };
}
