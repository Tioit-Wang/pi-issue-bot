/**
 * 仓库配置契约：`.github/pi-bot.yml`（B3 契约冻结）。
 *
 * 依据：plan §6.1（标签来自仓库配置，不发明新标签）、§6.2（显式检查项）、§6.3（主动建 issue 配额）、
 * §6.4（命令白名单与 `author_association` 门禁）、§10（加载时 schema 校验，非法则禁用该仓库机器人并通知 owner）、
 * tech-plan R4（沿用仓库现有标签 + 映射）、R5（主动建 issue 只做 PR review 场景）。
 *
 * 三条硬规则：
 * 1. **未知键一律拒绝**（`.strict()`）：拼错的键静默忽略等于配置写错了却看不出来。
 * 2. **键名用 snake_case**，与 `dry_run` 一致（tech-plan §7.2 的列名也是 snake_case）。
 * 3. **默认值写在 schema 里**，不写在加载代码里：面板与文档都从这份 schema 取默认行为。
 */
import { z } from 'zod';
import { MODEL_NAME_RE } from './enums.ts';

/** 判定键 → 仓库实际标签名。键是我们内部的判定名，值必须是仓库里**已存在**的标签（R4）。 */
export const labelMapSchema = z.record(z.string().min(1).max(40), z.string().min(1).max(50));

export const labelsConfigSchema = z
  .object({
    /** 判定键 → 标签名。为空时所有判定都降级为「只评论不打标」并记 warn（R4）。 */
    map: labelMapSchema.default({}),
    /** 允许打的标签白名单；给定时，映射结果不在其中一律不打（防手滑写错标签名）。 */
    allow: z.array(z.string().min(1).max(50)).max(100).optional(),
  })
  .strict();

/** 合规检查的一条规则：issue 模板的必填项或配置里的显式检查（plan §6.2）。 */
export const complianceRuleSchema = z
  .object({
    /** 规则 id，进 `missing_set_hash` 的排序输入，必须稳定（改了 id 等于换了规则）。 */
    id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
    /** 出现在评论里的说明；缺省用 id。 */
    description: z.string().min(1).max(200).optional(),
    /** `true`（默认）= 判定为必填项。 */
    required: z.boolean().default(true),
  })
  .strict();
export type ComplianceRule = z.infer<typeof complianceRuleSchema>;

export const complianceConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** 最多 16 条：评论里逐条列出缺失项的展示上限。 */
    rules: z.array(complianceRuleSchema).max(16).default([]),
  })
  .strict();

export const createIssueConfigSchema = z
  .object({
    /** 默认关闭：主动建 issue 是唯一「无触发的写」，先让 owner 显式打开。 */
    enabled: z.boolean().default(false),
    /** 每仓库每日配额（plan §6.3：默认 10 个，超限写入待办队列而不创建）。 */
    daily_quota: z.number().int().min(1).max(100).default(10),
    /** 允许的场景。`pr-review` = PR 审查顺带发现的独立缺陷（R5 只保留这一项的实现）。 */
    scenarios: z.array(z.enum(['pr-review', 'dependency', 'regression'])).min(1).max(3).default(['pr-review']),
  })
  .strict();

export const commandsConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** 命令白名单：不在其中的 `@bot /cmd` 直接回「未知命令」，不入队（plan §6.4）。 */
    allowed: z
      .array(z.string().regex(/^\/[a-z][a-z0-9-]{1,30}$/))
      .max(32)
      .default(['/review-pr', '/issue-triage', '/issue-repro']),
    /**
     * 命令门禁：只认这些 `author_association`（plan §6.4）。
     * 默认 OWNER / MEMBER / COLLABORATOR；机器人账号（`type: Bot`）无论 association 一律忽略。
     */
    author_associations: z
      .array(z.enum(['OWNER', 'MEMBER', 'COLLABORATOR']))
      .min(1)
      .max(3)
      .default(['OWNER', 'MEMBER', 'COLLABORATOR']),
    /** 额外白名单（login），用于组织外的受信用户。 */
    allow_users: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/)).max(50).default([]),
    /** 每仓库每小时命令上限（plan §7「发评论：频率限制」）。超限回一条说明，不入队。 */
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
    /** 单任务上限；技能可用自己的 `timeout` 覆盖，但不能超过 30m（`contract-skill.md` §2）。 */
    max_task_minutes: z.number().int().min(1).max(30).default(20),
  })
  .strict();

/**
 * `.github/pi-bot.yml` 的完整形状。
 *
 * 加载失败 = 「禁用该仓库机器人 + 通知 owner」（plan §10），**不是**「用默认值继续跑」：
 * 配置写坏了却照常放评论，等于把错误配置的后果直接推给仓库维护者。
 */
export const repoConfigSchema = z
  .object({
    /** 配置格式版本。改结构时升版本号，旧版本被拒（不猜语义）。 */
    version: z.literal(1),
    /** 仓库开关：false 时该仓库的任何事件都不处理（plan §11「以仓库开关 + dry-run 交付」）。 */
    enabled: z.boolean().default(true),
    /** dry-run：只产出信封与审计，不写 GitHub。**永久保留**（plan §11）。 */
    dry_run: z.boolean().default(true),
    /** 该仓库默认模型（`provider/model`）；技能可以覆盖，只影响成本归集。 */
    model: z.string().regex(MODEL_NAME_RE).optional(),
    labels: labelsConfigSchema.prefault({}),
    compliance: complianceConfigSchema.prefault({}),
    create_issue: createIssueConfigSchema.prefault({}),
    commands: commandsConfigSchema.prefault({}),
    skills: skillsConfigSchema.prefault({}),
    limits: limitsConfigSchema.prefault({}),
  })
  .strict()
  .meta({ id: 'RepoConfig' });
export type RepoConfig = z.infer<typeof repoConfigSchema>;

/** 配置合法时的默认值（测试与面板「默认行为」文案都读它，避免两处各写一份）。 */
export function parseRepoConfig(input: unknown): RepoConfig {
  return repoConfigSchema.parse(input);
}
