/**
 * 合法 `repos.settings` 夹具工厂（固定流水线契约收紧之后，`docs/plan-fixed-pipeline.md` §4.5 / Q4）。
 *
 * 为什么需要它：`repoSettingsSchema` 现在是「形状 + 跨字段约束」两层，夹具**不再能只写自己关心的字段**
 * （`parseRepoSettings({ labels: {...} })` 会直接抛错）：
 *
 * 1. `pipeline.managers` **必须非空**（superRefine 无条件校验）。空 = 整份配置解析失败 →
 *    该仓库 `settings_valid=false` → webhook 忽略事件。症状是 `expected 'ignored' to be 'enqueued'`。
 * 2. `labels.vocabulary[].role` **必填**（`requirement | defect | other`），缺键即解析失败。
 * 3. `triggers.faces` / `pipeline.enabled` / `pipeline.close_after_hours` / `pipeline.max_runs_per_stage`
 *    已删除，`.strict()` 拒收 —— 夹具里不许再出现。
 * 4. `DEFAULT_REPO_SETTINGS` 已降级为**形状默认值**（`pipeline.managers: []`），**不是**合法运行配置；
 *    想要「一份能跑的配置」就走这里，不要把它塞进 `repos.settings`。
 *
 * 用法（保持最小改动：只声明关心的字段，其余由契约默认值补）：
 *
 * ```ts
 * parseValidSettings({ labels: { vocabulary: vocabularyWithRoles([{ name: '缺陷' }]) } })
 * validRepoSettings({ dry_run: false })            // 需要普通对象时（落库 / 环境变量）
 * ```
 *
 * 5. `labels.vocabulary` **必须含 `requirement` 与 `defect` 各至少 1 个**（§4.5 的硬校验，`other` 可缺省）。
 *    所以 `validRepoSettings()` 默认就带一份两角色词表；`vocabularyWithRoles()` 会**自动补齐**缺的角色，
 *    让「只关心别的字段」的用例不必每次都写两条标签（真实配置由用户在面板提供）。
 */
import { parseRepoSettings } from '../../../../packages/contract/src/index.ts';
import type { LabelRole, LabelVocabularyEntry, RepoSettings } from '../../../../packages/contract/src/index.ts';

/**
 * 夹具里的管理员 login（`pipeline.managers`）。
 *
 * 取值与 webhook 夹具里的 `sender.login` 一致，避免「配置里的人和事件里的人不是一个」的困惑。
 * 需要多个管理员时在 `overrides.pipeline.managers` 里显式给。
 */
export const TEST_MANAGER = 'alice';

/** `validRepoSettings()` 的覆写参数：与 `repoSettingsSchema` 的顶层键同名。 */
export type RepoSettingsOverrides = Record<string, unknown>;

/**
 * 夹具默认词表：一条 `requirement` + 一条 `defect`（§4.5：两类各至少 1 个，`other` 可缺省）。
 *
 * 没有它，`validRepoSettings()` 的默认值在 `repoSettingsSchema` 下就是非法配置，
 * 所有「只想改一个字段」的用例都会莫名其妙变成 `settings_valid=false`。
 */
const DEFAULT_VOCABULARY: readonly LabelVocabularyInput[] = [
  { name: '需求', role: 'requirement', meaning: '新的功能或改进' },
  { name: '缺陷', role: 'defect', meaning: '功能不符合预期' },
];

/**
 * 一份**合法**的 `repos.settings`（普通对象，可直接 `JSON.stringify` 后落库 / 塞进 env）。
 *
 * `overrides` 是浅合并，但 `pipeline` / `labels` 段是**深一层**合并：只想改提示词版本号或标签映射时
 * 不用重复写 `managers` / 默认词表（显式给的 `labels.vocabulary` 仍然原样生效，负例才写得出来）。
 */
export function validRepoSettings(overrides: RepoSettingsOverrides = {}): RepoSettingsOverrides {
  const pipeline = (overrides['pipeline'] ?? {}) as RepoSettingsOverrides;
  const labels = (overrides['labels'] ?? {}) as RepoSettingsOverrides;
  return {
    ...overrides,
    labels: { vocabulary: DEFAULT_VOCABULARY, ...labels },
    pipeline: { managers: [TEST_MANAGER], ...pipeline },
  };
}

/** 同上，但过一遍契约（夹具写法还想拿到 `RepoSettings` 类型时用）。 */
export function parseValidSettings(overrides: RepoSettingsOverrides = {}): RepoSettings {
  return parseRepoSettings(validRepoSettings(overrides));
}

/** 落库用的 jsonb 字面量（`$n::jsonb` 参数直接给这个字符串）。 */
export function validSettingsJson(overrides: RepoSettingsOverrides = {}): string {
  return JSON.stringify(validRepoSettings(overrides));
}

/* ── 标签词表 ─────────────────────────────────────────────────────────────── */

/** 词表条目夹具：`role` 可省（由名字推），其余字段与契约一致。 */
export type LabelVocabularyInput = Omit<LabelVocabularyEntry, 'role'> & { readonly role?: LabelRole };

/** 名字里带这些字样 → `defect`（缺陷类结论的候选标签）。 */
const DEFECT_HINTS = ['缺陷', 'bug', '崩溃', '报错', 'crash'] as const;
/** 名字里带这些字样 → `requirement`（需求类结论的候选标签）。 */
const REQUIREMENT_HINTS = ['需求', 'feat', 'enhancement'] as const;

/** `vocabularyWithRoles()` 自动补角色时用的默认标签名（撞名时加数字后缀）。 */
const AUTO_ROLE_NAMES = { requirement: '需求', defect: '缺陷' } as const;

/**
 * 按名字推 `role`：`缺陷`/`bug`/`崩溃` → `defect`，`需求`/`feat`/`enhancement` → `requirement`，
 * 其余 → `other`。**只为夹具省字**：语义不清的条目请显式写 `role`。
 */
export function inferLabelRole(name: string): LabelRole {
  const lower = name.toLowerCase();
  if (DEFECT_HINTS.some((hint) => lower.includes(hint))) {
    return 'defect';
  }
  if (REQUIREMENT_HINTS.some((hint) => lower.includes(hint))) {
    return 'requirement';
  }
  return 'other';
}

/**
 * 给词表条目补 `role`（`role` 自 §4.5 / Q4 起必填），**并补齐 `requirement` / `defect`**。
 *
 * 已显式写 `role` 的条目原样保留；缺哪一类角色就自动补一条（名字优先用 `需求` / `缺陷`，
 * 撞名时加数字后缀）。自动补是为了让夹具默认合法 —— §4.5 要求这两类各至少 1 个，缺一个
 * `repoSettingsSchema` 就整份解析失败；真实配置由用户提供，不是这里补出来的。
 *
 * 返回**新数组**，不改入参：同一个常量被多个用例共用时不会互相污染。
 */
export function vocabularyWithRoles(
  entries: readonly LabelVocabularyInput[],
): (LabelVocabularyInput & { readonly role: LabelRole })[] {
  const resolved = entries.map((entry) => ({ ...entry, role: entry.role ?? inferLabelRole(entry.name) }));
  const taken = new Set(resolved.map((entry) => entry.name.toLowerCase()));
  for (const role of ['requirement', 'defect'] as const) {
    if (resolved.some((entry) => entry.role === role)) continue;
    const base = AUTO_ROLE_NAMES[role];
    let name: string = base;
    for (let suffix = 2; taken.has(name.toLowerCase()); suffix += 1) {
      name = `${base}${String(suffix)}`;
    }
    taken.add(name.toLowerCase());
    resolved.push({ name, role });
  }
  return resolved;
}
