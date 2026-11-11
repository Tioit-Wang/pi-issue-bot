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
 * 1:N 由应用层展开（`workflows/normalize.ts` 的 `normalizeDesired()`），schema 只负责形状。
 */
export const labelTargetSchema = z.union([
  z.string().min(1).max(50),
  z.array(z.string().min(1).max(50)).min(1).max(20),
]);
export type LabelTarget = z.infer<typeof labelTargetSchema>;

/** 判定键 → 仓库实际标签名。键是我们内部的判定名，值必须是仓库里**已存在**的标签（R4）。 */
export const labelMapSchema = z.record(z.string().min(1).max(40), labelTargetSchema);

/**
 * 标签的**角色**（`docs/plan-fixed-pipeline.md` §4.5 / Q4）：必填，缺 role 一律拒收，**不做回填**。
 *
 * 这是流程分叉的唯一依据，不是展示字段：分类阶段只给结论（`requirement` / `defect` / `other`），
 * 打哪个标签由控制面按「同 role 的词表项」决定。所以词表里没有 `defect` 角色的项 —— 缺陷结论就没有标签可打。
 */
export const labelRoleSchema = z.enum(['requirement', 'defect', 'other']);
export type LabelRole = z.infer<typeof labelRoleSchema>;

/**
 * 标签词表的一项：面板的候选来源 + 注入提示词（替掉 `worker-deps.ts` / `builtin.ts` 里的硬编码标签集）。
 * `name` 是仓库里的真实标签名。
 */
export const labelVocabularyEntrySchema = z
  .object({
    name: z.string().min(1).max(50),
    /** 归到哪一类结论；**必填**（Q4：还是老配置、缺这个键的，一律解析失败，由面板重新配置）。 */
    role: labelRoleSchema,
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

/* ── 固定流水线（`docs/plan-fixed-pipeline.md` §4.5）──────────────────────────── */

/** login 字符集：与 `commands.allow_users` / `triggers.users` 同一套（GitHub login 规则）。 */
export const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u;

/**
 * `settings.pipeline` —— v1.2 之后「项目级可配项只剩 3 类」里的第 2 类（`labels.vocabulary[].role`
 * 与 4 条提示词版本线是另外两类，`kind=project` 的指针沿用 `prompt.current_version`）。
 *
 * 刻意**没有** `enabled`：不存在「关闭流程」的项目配置（E1 全量切换，§16.1）；
 * `repos.enabled=false` 只表示「该仓库未接入」，不是流程开关。
 * 刻意**没有任何阈值**：`close_after_hours` / `max_runs_per_stage` 已收为系统常量（Q2，§1.5），
 * 改常量走发布，面板只读展示。
 */
export const pipelineConfigSchema = z
  .object({
    /**
     * 管理员 login：`/pipeline next|prev` 的权限来源，也是「分类无法判断时等谁回话」的名单。
     * schema 层只保证形状；**非空**与**不重复**由 `repoSettingsSchema` 的 superRefine 无条件校验。
     */
    managers: z.array(z.string().regex(LOGIN_RE)).max(20).default([]),
    /** 阶段 0 的提示词版本号；`0` = 用内置默认模板（§15）。三条版本线互不干扰（§4.4）。 */
    format_prompt_version: z.number().int().min(0).max(1_000_000).default(0),
    classify_prompt_version: z.number().int().min(0).max(1_000_000).default(0),
    agent_prompt_version: z.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();
export type PipelineConfig = z.infer<typeof pipelineConfigSchema>;

/* ── 完整形状 ──────────────────────────────────────────────────────────────── */

/**
 * 配置的**形状**（不含跨字段约束）：`repos.settings` 的 jsonb 形状 + 默认值。
 *
 * 单列一份的理由（`docs/plan-fixed-pipeline.md` §4.5）：`managers` 非空是**运行**前提，
 * 而「部署默认 / 迁移播种」需要一个**形状合法**的初始值（`managers: []` 是形状上的合法空值）。
 * 所以拆成「形状」+「严格」两层，其它调用点（迁移、面板的「恢复默认」）用形状层，
 * 校验一律用 `repoSettingsSchema`。
 */
export const repoSettingsShapeSchema = z
  .object({
    /** 配置格式版本。改结构时升版本号，旧版本被拒（不猜语义）；缺省 1 便于「部署默认 = `parse({})`」。 */
    version: z.literal(1).default(1),
    /** 仓库开关：false 时该仓库的任何事件都不处理。 */
    enabled: z.boolean().default(true),
    /** dry-run：只产出信封与审计，不写 GitHub。**永久保留**。 */
    dry_run: z.boolean().default(true),
    /** 该仓库默认模型（`provider/model`）；技能可以覆盖，只影响成本归集。 */
    model: z.string().regex(MODEL_NAME_RE).optional(),
    /** 触发体系：别名 / 触发人（`faces` 已按 P7 删除，事件面由流水线固定）。 */
    triggers: triggersConfigSchema.prefault({}),
    labels: labelsConfigSchema.prefault({}),
    create_issue: createIssueConfigSchema.prefault({}),
    commands: commandsConfigSchema.prefault({}),
    skills: skillsConfigSchema.prefault({}),
    limits: limitsConfigSchema.prefault({}),
    prompt: promptConfigSchema.prefault({}),
    /** 固定流水线段（E1 之后**没有** `enabled`，见 `pipelineConfigSchema`）。 */
    pipeline: pipelineConfigSchema.prefault({}),
  })
  .strict();

/** 同一份 JSON 里的 login / 标签名按「大小写不敏感」判重（GitHub 侧也是这个口径）。 */
function firstDuplicate(values: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) return value;
    seen.add(key);
  }
  return null;
}

/**
 * 一个仓库的**合法**完整配置（`repos.settings` 的 jsonb 形状 + 跨字段约束）。
 *
 * 校验失败 = 该仓库的配置不可用（`settings_valid=false`），webhook 忽略其事件，
 * **不是**「用默认值继续跑」：配置写坏了却照常放评论，等于把错误配置的后果推给仓库维护者。
 *
 * 跨字段约束**无条件生效**，读写同一套（Q4：不为存量配置让步，缺 `role` / `managers` 为空 /
 * 词表缺 `requirement` 或 `defect` / 含已删键（`triggers.faces`、`pipeline.enabled`）一律解析失败、保存 400）：
 * 1. `pipeline.managers` 非空（否则没人能推进被卡住的流程）；
 * 2. `pipeline.managers` 内无重复 login；
 * 3. `labels.vocabulary` 内无重复 `name`（重复会让「同 role 打哪个标签」变成不确定）；
 * 4. `labels.vocabulary` 里 `role='requirement'` 与 `role='defect'` **各至少 1 个**（`other` 可缺省）——
 *    与 `docs/plan-fixed-pipeline.md` §4.5 / V17 字面一致（见 §4.5「`superRefine` 无条件生效」）。
 */
export const repoSettingsSchema = repoSettingsShapeSchema
  .superRefine((settings, ctx) => {
    if (settings.pipeline.managers.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['pipeline', 'managers'],
        message: 'pipeline.managers 不能为空：至少一个管理员 login（否则卡住的流程没人能推进）',
      });
    }
    const duplicateManager = firstDuplicate(settings.pipeline.managers);
    if (duplicateManager !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['pipeline', 'managers'],
        message: `pipeline.managers 里重复：${duplicateManager}`,
      });
    }
    const duplicateLabel = firstDuplicate(settings.labels.vocabulary.map((entry) => entry.name));
    if (duplicateLabel !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['labels', 'vocabulary'],
        message: `labels.vocabulary 里重复的 name：${duplicateLabel}`,
      });
    }
    /**
     * §4.5：`requirement` / `defect` 是流程分叉的唯一依据，缺哪一类就等于该结论没有标签可打。
     * 所以这一条**硬校验**，不再降级成面板提示（`pipelineLabelCoverage()` 只做防御性展示）。
     */
    const missingRoles = (['requirement', 'defect'] as const).filter(
      (role) => !settings.labels.vocabulary.some((entry) => entry.role === role),
    );
    if (missingRoles.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['labels', 'vocabulary'],
        message: `分类需要至少一个需求标签与一个缺陷标签：labels.vocabulary 里缺 role='${missingRoles.join("' / role='")}' 的词表项（role='other' 可缺省）`,
      });
    }
  })
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

/**
 * 全默认值 —— **形状默认值，不是合法运行配置**。
 *
 * 从 `repoSettingsShapeSchema` 生成（不是 `parseRepoSettings({})`：那现在会因为 `managers` 为空、
 * 且 `labels.vocabulary` 缺 `requirement`/`defect` 而抛错）。
 * 用途只有「部署默认 / 迁移播种 / 面板恢复默认」：它的 `pipeline.managers` 是 `[]`，
 */
export const DEFAULT_REPO_SETTINGS: RepoSettings = repoSettingsShapeSchema.parse({});

/**
 * 标签角色的覆盖情况 —— 面板用它显示「未配置标签角色」的**防御性**提示（`missingRoles` 为空 = 齐了）。
 *
 * **schema 已经强制覆盖**（`repoSettingsSchema` 的 superRefine 要求 `requirement` 与 `defect` 各至少 1 个，
 * §4.5），所以正常路径走不到 `missingRoles` 非空。本函数只为**防御性展示**保留：
 * 存量数据、迁移后尚未在面板配置的仓库（`settings_valid=false`），面板拿到的是形状默认值（空词表），
 * 这时靠它把「缺哪类角色」直接摆给用户，而不是让用户自己去数词表。
 */
export function pipelineLabelCoverage(settings: Pick<RepoSettings, 'labels'>): {
  missingRoles: ('requirement' | 'defect')[];
} {
  const present = new Set(settings.labels.vocabulary.map((entry) => entry.role));
  const missingRoles = (['requirement', 'defect'] as const).filter((role) => !present.has(role));
  return { missingRoles: [...missingRoles] };
}
