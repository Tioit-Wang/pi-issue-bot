/**
 * 技能注册表：把「内置 + 仓库自带」两批文件合成一张确定的命令表（契约 §3）。
 *
 * 覆盖与冲突的判决全部在这里，且**没有任何一条路径是静默丢弃**：
 *
 * | 情形 | 结果 |
 * |---|---|
 * | 仓库技能与内置同名 | 用仓库的（整体替换，不做字段级合并） |
 * | 仓库内两个技能归一化后同名 | **两者都不加载**，记 `skill_conflict` |
 * | 仓库技能 frontmatter 非法 | **不回落内置**，该命令不可用并给出原因 |
 * | 仓库技能超时超过 `30m` | 截断到上限并 warn（技能仍可用，由 `toSkillEffectiveConfig` 决定） |
 * | `requires-repo-config: true` 而配置缺失 | 命令不可用，回一条说明 |
 * | `skills.project_skills: false` | 仓库技能整批不生效（记一条 warn；不逐个占位，避免与内置同名） |
 *
 * 被禁用的技能仍然留在 `list()` 里（面板要能看见「文件读了、但不能用」），
 * 这是与「跳过这个文件继续跑」最本质的区别。
 */
import { toSkillEffectiveConfig, effectiveSkillTimeout } from '../../../../packages/contract/src/index.ts';
import type { RepoSettings } from '../../../../packages/contract/src/index.ts';
import type { Logger } from '../../../../packages/shared/src/index.ts';
import { BUILTIN_SKILL_FILES } from './builtin.ts';
import { normalizeSkillName, parseSkillFile } from './frontmatter.ts';
import type { SkillDefinition, SkillDisabledReason, SkillEntry, SkillFile, SkillSource, SkillSummary } from './types.ts';

/** 仓库自带技能目录（契约 §1 第二行）。仓库配置从默认分支取这个目录下的 `*.md`。 */
export const REPO_SKILLS_DIR = '.github/pi-bot/skills';

/** 非法技能在面板里的占位名（`skillSummarySchema` 要求 name 非空且 ≤33 字符）。 */
export const UNNAMED_SKILL = '(未命名)';

/**
 * 注册表只关心仓库配置的两段（`skills` / `labels`）；拿整份 `RepoSettings` 也兼容。
 *
 * `compliance` 段已随 `docs/impl-multi-repo.md` §0.3 删除（合规缺失项改由提示词/技能控制），
 * 所以这里不再要它，也就不会再出现「注册表还指着一个不存在的配置段」这种编译期错误。
 */
export type SkillRepoConfig = Pick<RepoSettings, 'skills' | 'labels'>;

export type SkillRegistryOptions = {
  /** 内置技能文件（默认 `BUILTIN_SKILL_FILES`；单测可注入自己的）。 */
  readonly builtin?: readonly SkillFile[];
  /** 仓库自带技能文件（由 `.github/pi-bot/skills/` 拉取，调用方负责读文件）。 */
  readonly repoSkills?: readonly SkillFile[];
  /** 仓库配置快照；`null`/缺省表示「没有配置」（等价于全默认值，`project_skills` 默认为 true）。 */
  readonly config?: SkillRepoConfig | null;
  readonly logger?: Logger;
  /**
   * `requires-repo-config: true` 的判定实现。
   * 契约 §2 只说「仓库配置里必须存在该技能所需的配置段」，而**技能本身不携带段名**
   * （frontmatter 里没有这个字段）。所以默认实现取一个可判定的代理：仓库配置存在，
   * 且 `labels.map` 或 `labels.vocabulary` 至少有一段非空——这两段正是判定类技能唯一的输入
   * （`compliance.rules` 已删除，词表 `labels.vocabulary` 是它的替代）。
   * 需要更严格的口径时由调用方注入。
   */
  readonly requiresRepoConfigSatisfied?: (skill: SkillDefinition, config: SkillRepoConfig | null) => boolean;
};

export type SkillRegistry = {
  /** 全部技能（含禁用），按名排序。 */
  list(): readonly SkillEntry[];
  /** 面板/`/api/system` 用的摘要列表（顺序同 `list()`）。 */
  summaries(): readonly SkillSummary[];
  /** 按名查一条（大小写不敏感，允许省略开头的 `/`）。 */
  get(name: string): SkillEntry | undefined;
  /** 只要可用的定义；禁用或不存在都返回 `undefined`。 */
  resolve(name: string): SkillDefinition | undefined;
  /** 可用技能名（排序）。 */
  enabledNames(): readonly string[];
  /** 加载期产生的 warn/error 记录（面板与单测都读它，避免「日志里说了但代码里查不到」）。 */
  diagnostics(): readonly SkillDiagnostic[];
};

/** 加载期诊断：谁、为什么。`level` 与日志级别对齐。 */
export type SkillDiagnostic = {
  readonly level: 'info' | 'warn' | 'error';
  readonly code: 'timeout-truncated' | 'skill-invalid' | 'skill-conflict' | 'repo-config-missing' | 'repo-skills-disabled' | 'builtin-overridden';
  readonly message: string;
  /** 相关文件路径（内置技能是 `skills/builtin/...`）。 */
  readonly path: string;
  readonly name: string | null;
};

/** 默认的「仓库配置是否满足技能要求」判定（见 `SkillRegistryOptions.requiresRepoConfigSatisfied` 的说明）。 */
export function defaultRequiresRepoConfigSatisfied(
  _skill: SkillDefinition,
  config: SkillRepoConfig | null,
): boolean {
  if (config === null) {
    return false;
  }
  const hasLabels = Object.keys(config.labels.map).length > 0;
  const hasVocabulary = config.labels.vocabulary.length > 0;
  return hasLabels || hasVocabulary;
}

/** 归一化命令名（容忍调用方传 `review-pr` / `/Review-PR`）。 */
export function canonicalSkillName(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function summaryOf(input: {
  readonly name: string;
  readonly source: SkillSource;
  readonly enabled: boolean;
  readonly disabledReason: string | null;
  readonly outputs: readonly SkillDefinition['effective']['outputs'][number][];
  readonly timeoutMs: number;
}): SkillSummary {
  return {
    name: input.name,
    source: input.source,
    enabled: input.enabled,
    disabledReason: input.disabledReason,
    outputs: input.outputs,
    timeoutMs: input.timeoutMs,
  };
}

function disabledEntry(input: {
  readonly name: string;
  readonly source: SkillSource;
  readonly reason: SkillDisabledReason;
  readonly detail: string;
}): SkillEntry {
  return {
    kind: 'disabled',
    reason: input.reason,
    detail: input.detail.slice(0, 500),
    // 禁用技能没有生效的 outputs/超时；给空数组与默认 20m，面板据此显示「未生效」。
    summary: summaryOf({
      name: input.name.slice(0, 33),
      source: input.source,
      enabled: false,
      disabledReason: input.reason,
      outputs: [],
      timeoutMs: effectiveSkillTimeout(undefined).ms,
    }),
  };
}

/** 一批文件里，归一化名 → 出现次数。用于发现同名冲突。 */
function countNames(parsed: readonly { readonly name: string | null }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of parsed) {
    if (item.name === null) {
      continue;
    }
    counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
  }
  return counts;
}

/**
 * 建注册表。纯函数式装配（不读文件、不查库），所有输入都是注入的。
 */
export function createSkillRegistry(options: SkillRegistryOptions = {}): SkillRegistry {
  const diagnostics: SkillDiagnostic[] = [];
  const builtinFiles = options.builtin ?? BUILTIN_SKILL_FILES;
  const logger = options.logger;
  const config = options.config ?? null;
  const satisfied = options.requiresRepoConfigSatisfied ?? defaultRequiresRepoConfigSatisfied;

  const record = (diagnostic: SkillDiagnostic): void => {
    diagnostics.push(diagnostic);
    const fields = { path: diagnostic.path, name: diagnostic.name, code: diagnostic.code };
    if (diagnostic.level === 'error') {
      logger?.error(fields, diagnostic.message);
    } else if (diagnostic.level === 'warn') {
      logger?.warn(fields, diagnostic.message);
    } else {
      logger?.info(fields, diagnostic.message);
    }
  };

  /* ── 1. 已加载的条目（name → entry） ─────────────────────────────────────── */

  const entries = new Map<string, SkillEntry>();

  const loadFile = (file: SkillFile, source: SkillSource): { readonly name: string | null; readonly entry: SkillEntry } => {
    const parsed = parseSkillFile(file.text);
    if (!parsed.ok) {
      const name = parsed.name ?? UNNAMED_SKILL;
      record({
        level: 'error',
        code: 'skill-invalid',
        message: `技能 ${name} 未通过校验（${file.path}）：${parsed.detail}`,
        path: file.path,
        name: parsed.name,
      });
      return {
        name: parsed.name,
        entry: disabledEntry({ name, source, reason: 'skill_invalid', detail: `${file.path}: ${parsed.detail}` }),
      };
    }

    const effective = toSkillEffectiveConfig(parsed.frontmatter);
    if (effective.timeoutTruncated) {
      record({
        level: 'warn',
        code: 'timeout-truncated',
        message: `技能 ${parsed.name} 的 timeout 超过 30m 上限，已截断到 30m（技能仍可用）`,
        path: file.path,
        name: parsed.name,
      });
    }

    const skill: SkillDefinition = {
      name: parsed.name,
      source,
      origin: source === 'builtin' ? `builtin:${parsed.name}` : file.path,
      frontmatter: parsed.frontmatter,
      effective,
      body: parsed.body,
    };

    if (effective.requiresRepoConfig && !satisfied(skill, config)) {
      const detail = `${file.path}: 该命令要求仓库配置（labels.map 或 labels.vocabulary），当前配置缺失，命令不可用`;
      record({ level: 'warn', code: 'repo-config-missing', message: detail, path: file.path, name: parsed.name });
      return { name: parsed.name, entry: disabledEntry({ name: parsed.name, source, reason: 'repo-config-missing', detail }) };
    }

    return {
      name: parsed.name,
      entry: {
        kind: 'ready',
        skill,
        summary: summaryOf({
          name: skill.name,
          source,
          enabled: true,
          disabledReason: null,
          outputs: effective.outputs,
          timeoutMs: effective.timeoutMs,
        }),
      },
    };
  };

  /* ── 2. 内置技能 ─────────────────────────────────────────────────────────── */

  for (const file of builtinFiles) {
    const loaded = loadFile(file, 'builtin');
    if (loaded.name === null) {
      // 内置技能没有名字：仍然放进去，面板可见（否则「少了一条」没人会发现）。
      entries.set(`${UNNAMED_SKILL}:${file.path}`, loaded.entry);
      continue;
    }
    entries.set(loaded.name, loaded.entry);
  }

  /* ── 3. 仓库技能 ─────────────────────────────────────────────────────────── */

  const repoSkills = options.repoSkills ?? [];
  if (repoSkills.length > 0) {
    if (config !== null && config.skills.project_skills === false) {
      record({
        level: 'warn',
        code: 'repo-skills-disabled',
        message: `仓库配置 skills.project_skills=false：${repoSkills.length} 个仓库技能不生效`,
        path: REPO_SKILLS_DIR,
        name: null,
      });
    } else {
      const loaded = repoSkills.map((file) => ({ file, ...loadFile(file, 'repo') }));
      const counts = countNames(loaded);

      for (const item of loaded) {
        const name = item.name;
        if (name === null) {
          entries.set(`${UNNAMED_SKILL}:${item.file.path}`, item.entry);
          continue;
        }

        if ((counts.get(name) ?? 0) > 1) {
          // 撞名：**两个都不加载**（契约 §3），并且覆盖掉同名内置技能——
          // 冲突状态下「用内置的继续跑」会让 owner 以为自己的文件生效了。
          const detail = `${REPO_SKILLS_DIR} 下有两个技能归一化后同名：${name}（${item.file.path}）；两者都不加载`;
          record({ level: 'error', code: 'skill-conflict', message: detail, path: item.file.path, name });
          entries.set(name, disabledEntry({ name, source: 'repo', reason: 'skill_conflict', detail }));
          continue;
        }

        if (item.entry.kind === 'disabled') {
          // 非法仓库技能：**不回落内置**（契约 §3），直接盖掉同名内置条目。
          entries.set(name, item.entry);
          continue;
        }

        const previous = entries.get(name);
        if (previous !== undefined && previous.summary.source === 'builtin') {
          record({
            level: 'info',
            code: 'builtin-overridden',
            message: `仓库技能 ${name} 覆盖了内置技能（整体替换，不合并字段）`,
            path: item.file.path,
            name,
          });
        }
        entries.set(name, item.entry);
      }
    }
  }

  /* ── 4. 对外视图 ─────────────────────────────────────────────────────────── */

  const sorted = (): SkillEntry[] =>
    [...entries.values()].sort((left, right) => left.summary.name.localeCompare(right.summary.name, 'en'));

  return {
    list: sorted,
    summaries: () => sorted().map((entry) => entry.summary),
    get: (name) => entries.get(canonicalSkillName(name)),
    resolve: (name) => {
      const entry = entries.get(canonicalSkillName(name));
      return entry?.kind === 'ready' ? entry.skill : undefined;
    },
    enabledNames: () =>
      sorted()
        .filter((entry) => entry.kind === 'ready')
        .map((entry) => entry.summary.name),
    diagnostics: () => diagnostics,
  };
}

/** 排序用的稳定字符串（保留给测试与面板，避免各写一份 `localeCompare` 口径）。 */
export function sortSkillNames(names: Iterable<string>): string[] {
  return [...names].map((name) => normalizeSkillName(name)).sort((left, right) => left.localeCompare(right, 'en'));
}
