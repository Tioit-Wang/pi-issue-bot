/**
 * `label` 动作的**目标态对齐**（`docs/v21-contract.md` §5 第一行 / FR-5.4 / BR-9~BR-11）。
 *
 * 为什么叫「目标态」而不是「增量」：v2 的 `label` 动作给的是**完整期望集合** `desired`，
 * 执行侧必须自己算出 `add` 与 `remove`。这样模型只需要回答「这个 issue 应该有哪些标签」，
 * 不需要知道 issue 现在有什么（它看不到当前标签的可靠快照），也就不会出现
 * 「想打 A 但漏说 B 于是 B 被删掉」之外的第二种歧义。
 *
 * 四条安全规则（顺序就是优先级，改动等于改行为）：
 *  1. **空集保护**（BR-9）：`desired` 为空且 `clear !== true` → 整条动作拒绝。
 *     模型少写一个字段绝不能等价于「把标签清空」。
 *  2. **超限整批拒绝**：`desired.length > maxPerIssue` → 拒绝，**不截断**。
 *     截断会静默丢掉模型明确表达的意图，而「哪几个被丢」没有正确答案。
 *  3. **目录外/不可管理 → 拒绝**：`desired` 里出现目录外、`retired`、`managed=false`、
 *     或没填 `meaning` 的标签，说明执行侧给了不该给的东西 → `unknown-label`。
 *     （加一个不存在的标签只会 422，删一个没人填过含义的标签会删掉人的组织方式。）
 *  4. **删除只发生在可管理集合内**：`remove = current ∩ 可管理目录 − desired`。
 *     当前的每个标签若不可管理，就既不删也不加，落进 `skipped` 里留痕
 *     —— 面板要能回答「为什么这个标签还挂着」。
 *
 * 纯函数：不查库、不发请求、不看时间。执行器只负责把 I/O 的结果喂进来。
 */

/** 目录外/不可管理的四种原因（进 `skipped.reason`，面板按它分组）。 */
export type LabelSkipReason = 'not-in-catalog' | 'retired' | 'unmanaged' | 'missing-meaning';

/**
 * 标签目录的一项。
 *
 * 与 `config/v21-settings.ts::ManagedCatalogEntry` 结构兼容（那边多一个 `group`），
 * 但这里**独立声明**：写回层不该为了三个字段 import 配置层，否则单测要造一份 settings。
 */
export type CatalogEntry = {
  readonly name: string;
  readonly meaning: string | null;
  readonly managed: boolean;
  readonly status: 'active' | 'retired';
};

/** 整条动作被拒绝的三种原因（§5 第一行）。 */
export const LABEL_PLAN_FAILURES = ['empty-without-clear', 'over-limit', 'unknown-label'] as const;

export type LabelPlanFailure = (typeof LABEL_PLAN_FAILURES)[number];

/** 一条被跳过的当前标签 + 原因。 */
export type SkippedLabel = {
  readonly label: string;
  readonly reason: LabelSkipReason;
};

export type LabelPlanInput = {
  /** issue 当前的标签（GitHub 顺序，不作排序依据）。 */
  readonly current: readonly string[];
  /** 模型声明的完整目标集合。 */
  readonly desired: readonly string[];
  /** 显式的「允许清空」许可；只有 `true` 才算许可。 */
  readonly clear?: boolean | undefined;
  readonly catalog: readonly CatalogEntry[];
  /** 仓库配置的 `labels.max_per_issue`。 */
  readonly maxPerIssue: number;
  /** 我们（bot）历史上打过的标签 —— 决定删除的 `owner`（审计用，不参与过滤）。 */
  readonly botLabels: readonly string[];
};

export type LabelPlan =
  | {
      readonly ok: true;
      /** 要加的标签（`desired − current`，保持 `desired` 的顺序）。 */
      readonly add: string[];
      /** 要删的标签（`current ∩ 可管理目录 − desired`，保持 `current` 的顺序）。 */
      readonly remove: string[];
      /** 看着像该删、但按规则不能动的当前标签。 */
      readonly skipped: SkippedLabel[];
    }
  | {
      readonly ok: false;
      readonly reason: LabelPlanFailure;
      /** 人可读的一句话（进告警与面板，说明为什么拒绝）。 */
      readonly detail: string;
    };

/** 目录项是否落在「自动管理」范围内（`status='active'` + `managed!==false` + `meaning` 非空）。 */
export function isManageableCatalogEntry(entry: CatalogEntry): boolean {
  return entry.managed !== false && entry.status === 'active' && isMeaningFilled(entry.meaning);
}

/** `meaning` 是不是「填过」：`null`、空串、纯空白都算没填（§6.5 的保护）。 */
function isMeaningFilled(meaning: string | null | undefined): boolean {
  return typeof meaning === 'string' && meaning.trim() !== '';
}

/** 不可管理的原因（`null` = 可管理）。顺序即原因判定顺序。 */
function unmanageableReason(entry: CatalogEntry | undefined): LabelSkipReason | null {
  if (entry === undefined) {
    return 'not-in-catalog';
  }
  if (entry.status !== 'active') {
    return 'retired';
  }
  if (entry.managed === false) {
    return 'unmanaged';
  }
  if (!isMeaningFilled(entry.meaning)) {
    return 'missing-meaning';
  }
  return null;
}

/** 去首尾空白 + 去空串 + 去重（保序）。 */
function normalizeNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name === '' || seen.has(name)) {
      continue;
    }
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * 删除的归属（`actions.audit.owner`，BR-10 的可追溯要求）。
 *
 * `bot` = 我们自己打的，删掉是我们收回自己的动作；`human` = 人打的，我们删它是替人做决定，
 * 审计里必须能分辨这两种情况（否则「谁动了标签」在事故复盘时无从查起）。
 */
export function deletionOwner(label: string, botLabels: readonly string[]): 'bot' | 'human' {
  return botLabels.includes(label) ? 'bot' : 'human';
}

/** 算目标态与当前态的差集。纯函数：同样的输入永远同样的输出。 */
export function planLabelTargetState(input: LabelPlanInput): LabelPlan {
  const desired = normalizeNames(input.desired);
  const clear = input.clear === true;

  // 规则 1：空集保护。注意 `desired` 里全是空白串与「空数组」等价 —— 那是同一个意思。
  if (desired.length === 0 && !clear) {
    return {
      ok: false,
      reason: 'empty-without-clear',
      detail:
        'desired 为空且没有 clear=true：拒绝清空标签（BR-9）。确实要清空请显式给 clear: true',
    };
  }

  // 规则 2：超限整批拒绝（不截断）。
  if (desired.length > input.maxPerIssue) {
    return {
      ok: false,
      reason: 'over-limit',
      detail: `desired 有 ${String(desired.length)} 个标签，超过上限 ${String(input.maxPerIssue)}：整批拒绝（不截断）`,
    };
  }

  const byName = new Map<string, CatalogEntry>();
  for (const entry of input.catalog) {
    byName.set(entry.name, entry);
  }

  // 规则 3：desired 里不许有目录外/不可管理的标签。
  const badDesired: string[] = [];
  for (const name of desired) {
    if (unmanageableReason(byName.get(name)) !== null) {
      badDesired.push(name);
    }
  }
  if (badDesired.length > 0) {
    return {
      ok: false,
      reason: 'unknown-label',
      detail: `desired 里有不在可管理目录内的标签（目录外 / retired / managed=false / 没填含义）：${badDesired.join(', ')}`,
    };
  }

  // 规则 4：删除只发生在可管理集合内。
  const current = normalizeNames(input.current);
  const desiredSet = new Set(desired);
  const currentSet = new Set(current);

  const add = desired.filter((name) => !currentSet.has(name));
  const remove: string[] = [];
  const skipped: SkippedLabel[] = [];

  for (const name of current) {
    if (desiredSet.has(name)) {
      continue;
    }
    const reason = unmanageableReason(byName.get(name));
    if (reason === null) {
      remove.push(name);
      continue;
    }
    skipped.push({ label: name, reason });
  }

  return { ok: true, add, remove, skipped };
}

/**
 * 给审计/面板用的一句话（`actions.audit.detail` 与 `run_events.payload` 共用）。
 *
 * `owner` 只对**要删的**标签有意义：加的标签没有归属问题（是我们主动打的）。
 */
export function describeLabelPlan(plan: LabelPlan, owners: Readonly<Record<string, 'bot' | 'human'>> = {}): string {
  if (!plan.ok) {
    return `拒绝（${plan.reason}）：${plan.detail}`;
  }
  const parts: string[] = [];
  parts.push(plan.add.length === 0 ? '不加标签' : `加 [${plan.add.join(', ')}]`);
  if (plan.remove.length === 0) {
    parts.push('不删标签');
  } else {
    const withOwner = plan.remove.map((label) => `${label}(${owners[label] ?? 'human'})`);
    parts.push(`删 [${withOwner.join(', ')}]`);
  }
  if (plan.skipped.length > 0) {
    parts.push(`保留 [${plan.skipped.map((item) => `${item.label}:${item.reason}`).join(', ')}]`);
  }
  return parts.join('; ');
}
