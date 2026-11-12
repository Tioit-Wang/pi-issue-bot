/**
 * 仓库配置契约：`repoSettingsSchema` —— 一个仓库的**全部**配置。
 *
 * 依据：`docs/req-issue-agent.md` §3（v0.3 只有 5 类可配项）。三条硬规则不变：
 * 1. **未知键一律拒绝**（`.strict()`）：拼错的键静默忽略等于配置写错了却看不出来。
 * 2. **键名用 snake_case**，与 `dry_run` / `settings_valid` 等列名一致。
 * 3. **默认值写在 schema 里**，不写在加载代码里：面板、文档、部署默认都从这份 schema 取默认行为。
 *
 * v0.3（issue agent）的结构性变化（`docs/dev-plan-issue-agent.md` §2.6）：
 * - `settings.pipeline` → `settings.agent`（`managers` 搬家；三条提示词版本线删）；
 * - `prompt` / `commands` / `create_issue` 三段整体删除（`project_prompt` 内联进 `agent`）；
 * - `triggers` 只剩 `aliases`（`enabled` / `users` / `merge_defaults` / `remove` 删）；
 * - `skills` 收成 `project_skills` 一个布尔。
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
 * 标签的**角色**（D5 的依据）：必填，缺 role 一律拒收，**不做回填**。
 *
 * agent 侧据此判断「这个词表项意味着什么」，而不是让模型自由发明标签名。
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

/**
 * 项目级技能目录开关：`true`（默认）= 扫描 `<repo>/.github/pi-bot/skills/`；
 * 内置技能恒在，不受它影响（需求 §2.1）。
 */
export const skillsConfigSchema = z
  .object({
    project_skills: z.boolean().default(true),
  })
  .strict();
export type SkillsConfig = z.infer<typeof skillsConfigSchema>;

export const limitsConfigSchema = z
  .object({
    /** 每仓库每小时自动评论上限（事件类 + 提及类合计）。 */
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

/* ── issue agent（`docs/req-issue-agent.md` §3）────────────────────────────────── */

/** login 字符集（GitHub login 规则）。 */
export const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u;

/**
 * `settings.agent` —— v0.3 的**唯一**项目级配置段（`docs/dev-plan-issue-agent.md` §2.6）。
 *
 * 刻意**没有** `enabled`：`repos.enabled=false` 只表示「该仓库未接入」，不是 agent 开关。
 * 刻意**没有任何阈值**：轮换阈值、速率上限等都是系统常量，改常量走发布。
 */
export const agentConfigSchema = z
  .object({
    /**
     * 管理员 login：`@别名` 提及的唯一权限来源，也是「确认类回复等谁」的名单。
     * schema 层只保证形状；**非空**与**不重复**由 `repoSettingsSchema` 的 superRefine 无条件校验。
     */
    managers: z.array(z.string().regex(LOGIN_RE)).max(20).default([]),
    /**
     * `issues.opened` 要加载的技能 id；`null` = 不投递（0 任务）。
     *
     * 必须是一个**真实存在**的技能 id，且按本仓口径写成 `issue-format`（不带前导 `/`，
     * 存储与目录 id 都这么存）。以前默认值是 `format-check` —— 一个谁都没有的技能名，
     * 于是每个新 issue 都在指示模型「先加载 format-check」，模型只能回报「加载不到」（issue #26）。
     */
    on_opened: z.string().min(1).max(64).nullable().default('issue-format'),
    /** `issues.edited` 要加载的技能 id；`null` = 不投递。 */
    on_edited: z.string().min(1).max(64).nullable().default('issue-format'),
    /** 格式检查通过后是否自动打标签（默认关：v0.3「默认只产出评论」）。 */
    auto_label_after_format_pass: z.boolean().default(false),
    /** 项目级补充提示词（取代 v1.5 的 `prompt_versions` 版本表）。 */
    project_prompt: z.string().max(4000).default(''),
  })
  .strict();
export type AgentConfig = z.infer<typeof agentConfigSchema>;

/* ── 完整形状 ──────────────────────────────────────────────────────────────── */

/**
 * 配置的**形状**（不含跨字段约束）：`repos.settings` 的 jsonb 形状 + 默认值。
 *
 * 单列一份的理由：`managers` 非空是**运行**前提，而「部署默认 / 迁移播种」需要一个**形状合法**的
 * 初始值（`managers: []` 是形状上的合法空值）。所以拆成「形状」+「严格」两层，其它调用点
 * （迁移、面板的「恢复默认」）用形状层，校验一律用 `repoSettingsSchema`。
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
    /** 触发体系：只剩别名（事件面由 agent 固定接管）。 */
    triggers: triggersConfigSchema.prefault({}),
    labels: labelsConfigSchema.prefault({}),
    skills: skillsConfigSchema.prefault({}),
    limits: limitsConfigSchema.prefault({}),
    /** issue agent 段（没有 `enabled`，见 `agentConfigSchema`）。 */
    agent: agentConfigSchema.prefault({}),
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
 * 词表缺 `requirement` 或 `defect` / 含已删键一律解析失败、保存 400）：
 * 1. `agent.managers` 非空（否则没人能 @ 动机器人）；
 * 2. `agent.managers` 内无重复 login；
 * 3. `labels.vocabulary` 内无重复 `name`（重复会让「同 role 打哪个标签」变成不确定）；
 * 4. `labels.vocabulary` 里 `role='requirement'` 与 `role='defect'` **各至少 1 个**（`other` 可缺省）。
 */
export const repoSettingsSchema = repoSettingsShapeSchema
  .superRefine((settings, ctx) => {
    if (settings.agent.managers.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['agent', 'managers'],
        message: 'agent.managers 不能为空：至少一个管理员 login（否则没人能 @ 动机器人）',
      });
    }
    const duplicateManager = firstDuplicate(settings.agent.managers);
    if (duplicateManager !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['agent', 'managers'],
        message: `agent.managers 里重复：${duplicateManager}`,
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
     * `requirement` / `defect` 是打标的唯一依据，缺哪一类就等于该结论没有标签可打。
     * 所以这一条**硬校验**，不再降级成面板提示（`pipelineLabelCoverage()` 只做防御性展示）。
     */
    const missingRoles = (['requirement', 'defect'] as const).filter(
      (role) => !settings.labels.vocabulary.some((entry) => entry.role === role),
    );
    if (missingRoles.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['labels', 'vocabulary'],
        message: `打标需要至少一个需求标签与一个缺陷标签：labels.vocabulary 里缺 role='${missingRoles.join("' / role='")}' 的词表项（role='other' 可缺省）`,
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
 * 用途只有「部署默认 / 迁移播种 / 面板恢复默认」：它的 `agent.managers` 是 `[]`，
 */
export const DEFAULT_REPO_SETTINGS: RepoSettings = repoSettingsShapeSchema.parse({});

/**
 * 标签角色的覆盖情况 —— 面板用它显示「未配置标签角色」的**防御性**提示（`missingRoles` 为空 = 齐了）。
 *
 * **schema 已经强制覆盖**（`repoSettingsSchema` 的 superRefine 要求 `requirement` 与 `defect` 各至少 1 个），
 * 所以正常路径走不到 `missingRoles` 非空。本函数只为**防御性展示**保留：存量数据、迁移后尚未在面板
 * 配置的仓库（`settings_valid=false`），面板拿到的是形状默认值（空词表），这时靠它把「缺哪类角色」
 * 直接摆给用户，而不是让用户自己去数词表。
 */
export function pipelineLabelCoverage(settings: Pick<RepoSettings, 'labels'>): {
  missingRoles: ('requirement' | 'defect')[];
} {
  const present = new Set(settings.labels.vocabulary.map((entry) => entry.role));
  const missingRoles = (['requirement', 'defect'] as const).filter((role) => !present.has(role));
  return { missingRoles: [...missingRoles] };
}
