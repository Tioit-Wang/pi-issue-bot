/**
 * `skills/` 的公共类型（契约：`docs/spec/contract-skill.md` v1.0）。
 *
 * 这一层只定义「加载后的技能长什么样」，不解析、不校验、不读文件——
 * 解析在 `frontmatter.ts`，注册与冲突在 `registry.ts`，渲染在 `prompt.ts`，命令解析在 `command.ts`。
 *
 * 依赖方向（tech-plan §8.2）：`skills/` 只依赖 `contract`（zod schema）与 node 内置。
 * 它**不**依赖 `github/` / `db/` / `worker/`：技能是配置，不是执行面。
 */
import type {
  SkillEffectiveConfig,
  SkillFrontmatter,
  SkillOutput,
} from '../../../../packages/contract/src/index.ts';

/** 技能来源。仓库自带优先级高于内置（契约 §3）。 */
export type SkillSource = 'builtin' | 'repo';

/**
 * 技能被禁用的原因。取值刻意复用契约 §3 的措辞，面板与 `/api/system` 直接展示它：
 *  - `skill_invalid`          frontmatter 非法（字段 / 枚举 / 正则 / 保留名 / 空文件）
 *  - `skill_conflict`         同名归一化后冲突（两个仓库技能撞名 → 两者都不加载）
 *  - `repo-config-missing`    `requires-repo-config: true` 但仓库配置里没有它要的段
 *  - `repo-skills-disabled`   仓库配置 `skills.repo_skills: false`，仓库技能不生效
 */
export type SkillDisabledReason =
  | 'skill_invalid'
  | 'skill_conflict'
  | 'repo-config-missing'
  | 'repo-skills-disabled';

/**
 * 面板可见的技能摘要。字段与契约 `skillSummarySchema` 一一对应
 * （`packages/contract/src/api.ts` 的 `GET /api/system` → `skills[]`）。
 *
 * 为什么不直接 `z.infer<typeof skillSummarySchema>`：这一层的产出会被 `http/api` 直接塞进
 * system 响应，用 zod 再 parse 一遍是运行期保证；类型层面保持结构相同即可，
 * 少一层对 zod 类型的耦合（`skills.ts` 里已经有 `SkillEffectiveConfig` 来自契约）。
 */
export type SkillSummary = {
  /** 归一化后的命令名（小写，带 `/`）。 */
  readonly name: string;
  readonly source: SkillSource;
  /** `false` = 该命令不可用，但仍在面板可见（契约 §3 最后一句）。 */
  readonly enabled: boolean;
  /** 禁用原因；可用为 `null`。 */
  readonly disabledReason: string | null;
  /** 生效的 `outputs`（解释「为什么这个命令不会推分支」）。 */
  readonly outputs: readonly SkillOutput[];
  /** 生效的单任务超时（超过 30m 上限时已被截断）。 */
  readonly timeoutMs: number;
};

/** 加载成功的一个技能。 */
export type SkillDefinition = {
  /** 归一化名（`/review-pr`）。 */
  readonly name: string;
  readonly source: SkillSource;
  /** 来源定位串：内置技能是 `builtin:/review-pr`，仓库技能是它的文件路径。 */
  readonly origin: string;
  readonly frontmatter: SkillFrontmatter;
  /** 生效配置（默认值已展开、超时已截断）。 */
  readonly effective: SkillEffectiveConfig;
  /** 正文（prompt 模板，含 `{{...}}` 占位符）。 */
  readonly body: string;
};

/** 注册表里的一条记录：可用或禁用都在，禁用的一律带原因（不静默丢弃）。 */
export type SkillEntry =
  | {
      readonly kind: 'ready';
      readonly summary: SkillSummary;
      readonly skill: SkillDefinition;
    }
  | {
      readonly kind: 'disabled';
      readonly summary: SkillSummary;
      readonly reason: SkillDisabledReason;
      /** 人读原因，进日志与 owner 通知（≤500 字符）。 */
      readonly detail: string;
    };

/** 一个待加载的技能文件：`path` 只用于日志与面板定位，`name` 以 frontmatter 为准。 */
export type SkillFile = {
  readonly path: string;
  readonly text: string;
};

/** 转成面板/`/api/system` 的可序列化形状（数组可变，便于 zod 再校验）。 */
export function toSkillSummary(entry: SkillEntry): {
  name: string;
  source: SkillSource;
  enabled: boolean;
  disabledReason: string | null;
  outputs: SkillOutput[];
  timeoutMs: number;
} {
  const { summary } = entry;
  return {
    name: summary.name,
    source: summary.source,
    enabled: summary.enabled,
    disabledReason: summary.disabledReason,
    outputs: [...summary.outputs],
    timeoutMs: summary.timeoutMs,
  };
}
