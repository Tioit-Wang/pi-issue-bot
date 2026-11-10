/**
 * 仓库配置契约：`repoSettingsSchema` —— 一个仓库的**全部**配置。
 *
 * 依据：`docs/impl-multi-repo.md` §3。三条硬规则不变：
 * 1. **未知键一律拒绝**（`.strict()`）：拼错的键静默忽略等于配置写错了却看不出来。
 * 2. **键名用 snake_case**，与 `dry_run` / `settings_valid` 等列名一致。
 * 3. **默认值写在 schema 里**，不写在加载代码里：面板、文档、部署默认都从这份 schema 取默认行为。
 *
 * 多仓库改造（W1-A）后的两处结构性变化：
 * - 配置**只存在于 `repos.settings`（jsonb）**，不再读仓库里的 `.github/pi-bot.yml`；
 * - `compliance` 段**整体删除**：合规缺失项由提示词/技能控制（`docs/impl-multi-repo.md` §0.3），
 *   配置里不再有「哪些规则算必填」这一层。
 *
 * 为什么不像触发器别名那样在这里做归一化（`.transform()`）：注册表测试要求每个 schema 都能
 * 生成 JSON Schema（`packages/contract/test/contract.test.ts`），带 transform 的 schema 生成不了。
 */
import { z } from 'zod';
import { MODEL_NAME_RE } from './enums.ts';
import { triggersConfigSchema } from './trigger.ts';

/* ── 标签 ──────────────────────────────────────────────────────────────────── */

/**
 * 一条映射的目标：`'bug'`（1:1）或 `['bug', 'needs-info']`（1:N）。
 * 1:N 由应用层展开（`workflows/triage.ts` 的 `normalizeDesired()`），schema 只负责形状。
 */
export const labelTargetSchema = z.union([
  z.string().min(1).max(50),
  z.array(z.string().min(1).max(50)).min(1).max(20),
]);
export type LabelTarget = z.infer<typeof labelTargetSchema>;

/** 判定键 → 仓库实际标签名。键是我们内部的判定名，值必须是仓库里**已存在**的标签（R4）。 */
export const labelMapSchema = z.record(z.string().min(1).max(40), labelTargetSchema);

/**
 * 标签词表的一项：面板的候选来源 + 注入提示词（替掉 `worker-deps.ts` / `builtin.ts` 里的硬编码标签集）。
 * `name` 是仓库里的真实标签名。
 */
export const labelVocabularyEntrySchema = z
  .object({
    name: z.string().min(1).max(50),
    /** 这个标签意味着什么（提示词里原样给出，模型据此判断）。 */
    meaning: z.string().min(1).max(200).optional(),
    /** `RRGGBB`，不带 `#`（与 GitHub 标签颜色口径一致）。 */
    color: z.string().regex(/^[0-9A-Fa-f]{6}$/u, 'color 是 6 位十六进制，不带 #').optional(),
    /** 面板展示用的说明。 */
    description: z.string().min(1).max(500).optional(),
    /** 互斥组：同一组内只保留一个标签（由应用层裁剪）。 */
    group: z.string().min(1).max(40).optional(),
  })
  .strict();
export type LabelVocabularyEntry = z.infer<typeof labelVocabularyEntrySchema>;

export const labelsConfigSchema = z
  .object({
    /** 项目标签词表；为空时不注入任何标签说明。 */
    vocabulary: z.array(labelVocabularyEntrySchema).max(200).default([]),
    /** 判定键 → 标签名（1:1 或 1:N）。为空时判定类降级为「只判定不打标」并记 warn。 */
    map: labelMapSchema.default({}),
    /** 允许打的标签白名单；给定时，映射结果不在其中一律不打（防手滑写错标签名）。 */
    allow: z.array(z.string().min(1).max(50)).max(100).optional(),
    /** 映射到仓库里不存在的标签时怎么办：`warn`（默认，只记日志）/ `create`（建标签）/ `ignore`。 */
    missing: z.enum(['warn', 'create', 'ignore']).default('warn'),
    /** 一个 issue 上最多由我们打几个标签（互斥组裁剪之后的硬上限）。 */
    max_per_issue: z.number().int().min(1).max(20).default(6),
  })
  .strict();
export type LabelsConfig = z.infer<typeof labelsConfigSchema>;

/* ── 其余各段 ──────────────────────────────────────────────────────────────── */

export const createIssueConfigSchema = z
  .object({
    /** 默认关闭：主动建 issue 是唯一「无触发的写」，先让 owner 显式打开。 */
    enabled: z.boolean().default(false),
    /** 每仓库每日配额。 */
    daily_quota: z.number().int().min(1).max(100).default(10),
    /** 允许的场景。`pr-review` = PR 审查顺带发现的独立缺陷（R5 只保留这一项的实现）。 */
    scenarios: z.array(z.enum(['pr-review', 'dependency', 'regression'])).min(1).max(3).default(['pr-review']),
  })
  .strict();

export const commandsConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** 命令白名单：不在其中的 `@bot /cmd` 直接回「未知命令」，不入队。 */
    allowed: z
      .array(z.string().regex(/^\/[a-z][a-z0-9-]{1,30}$/u))
      .max(32)
      .default(['/review-pr', '/issue-triage', '/issue-repro']),
    /**
     * 命令门禁：只认这些 `author_association`。
     * 默认 OWNER / MEMBER / COLLABORATOR；机器人账号（`type: Bot`）无论 association 一律忽略。
     */
    author_associations: z
      .array(z.enum(['OWNER', 'MEMBER', 'COLLABORATOR']))
      .min(1)
      .max(3)
      .default(['OWNER', 'MEMBER', 'COLLABORATOR']),
    /** 额外白名单（login），用于组织外的受信用户。 */
    allow_users: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u)).max(50).default([]),
    /** 每仓库每小时命令上限。超限回一条说明，不入队。 */
    rate_limit_per_hour: z.number().int().min(1).max(200).default(20),
  })
  .strict();

export const skillsConfigSchema = z
  .object({
    /** 是否允许仓库自带的技能（`.github/pi-bot/skills/*.md`，见 `contract-skill.md` §1）。 */
    repo_skills: z.boolean().default(true),
  })
  .strict();

export const limitsConfigSchema = z
  .object({
    /** 每仓库每小时自动评论上限（判定类 + 命令类合计）。 */
    max_comments_per_hour: z.number().int().min(1).max(200).default(10),
    /** 单封信封最多执行多少个动作（信封本身也限 8，两处取小）。 */
    max_actions_per_run: z.number().int().min(1).max(8).default(8),
    /** 单任务上限；技能可用自己的 `timeout` 覆盖，但不能超过 30m。 */
    max_task_minutes: z.number().int().min(1).max(30).default(20),
    /** 单仓库同时跑几个任务（全局并发仍由部署常量兜底）。 */
    concurrency_per_repo: z.number().int().min(1).max(8).default(2),
    /** 排队超过多少分钟就取消（`tasks.status='cancelled_queue'`）。 */
    queue_wait_minutes: z.number().int().min(1).max(120).default(10),
  })
  .strict();

/** 项目提示词层（P1，`prompt_versions` 表）。正文不在配置里，配置只记「启用哪个版本」。 */
export const promptConfigSchema = z
  .object({
    /** 是否把 P1 层注入到提示词（关掉 = 装配结果与没有 P1 时逐字节一致）。 */
    enabled: z.boolean().default(true),
    /** 当前启用的版本号；`0` = 还没有任何版本（不注入）。 */
    current_version: z.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();
export type PromptConfig = z.infer<typeof promptConfigSchema>;

/* ── 完整形状 ──────────────────────────────────────────────────────────────── */

/**
 * 一个仓库的完整配置（`repos.settings` 的 jsonb 形状）。
 *
 * 校验失败 = 该仓库的配置不可用（`settings_valid=false`），webhook 忽略其事件，
 * **不是**「用默认值继续跑」：配置写坏了却照常放评论，等于把错误配置的后果推给仓库维护者。
 */
export const repoSettingsSchema = z
  .object({
    /** 配置格式版本。改结构时升版本号，旧版本被拒（不猜语义）；缺省 1 便于「部署默认 = `parse({})`」。 */
    version: z.literal(1).default(1),
    /** 仓库开关：false 时该仓库的任何事件都不处理。 */
    enabled: z.boolean().default(true),
    /** dry-run：只产出信封与审计，不写 GitHub。**永久保留**。 */
    dry_run: z.boolean().default(true),
    /** 该仓库默认模型（`provider/model`）；技能可以覆盖，只影响成本归集。 */
    model: z.string().regex(MODEL_NAME_RE).optional(),
    /** 触发体系：别名 / 触发人 / 事件面。 */
    triggers: triggersConfigSchema.prefault({}),
    labels: labelsConfigSchema.prefault({}),
    create_issue: createIssueConfigSchema.prefault({}),
    commands: commandsConfigSchema.prefault({}),
    skills: skillsConfigSchema.prefault({}),
    limits: limitsConfigSchema.prefault({}),
    prompt: promptConfigSchema.prefault({}),
  })
  .strict()
  .meta({ id: 'RepoSettings' });

export type RepoSettings = z.infer<typeof repoSettingsSchema>;

/**
 * 旧名（`.github/pi-bot.yml` 时代）——**deprecated**，只为让尚未迁移的调用点继续编译。
 * 新代码只用 `RepoSettings` / `repoSettingsSchema`；`compliance` 段已删除，旧调用点升级时一并删掉。
 */
export const repoConfigSchema = repoSettingsSchema;

/** @deprecated 用 `RepoSettings`。 */
export type RepoConfig = RepoSettings;

/** 部署默认配置的解析（`PI_BOT_DEFAULT_SETTINGS` 的最终形态也走它）。 */
export function parseRepoSettings(input: unknown): RepoSettings {
  return repoSettingsSchema.parse(input);
}

/** @deprecated 用 `parseRepoSettings()`。 */
export const parseRepoConfig = parseRepoSettings;

/** 全默认值（缺省 `version: 1` 也在这里生效）。 */
export const DEFAULT_REPO_SETTINGS: RepoSettings = parseRepoSettings({});
