/**
 * 技能（命令）frontmatter 契约 —— 逐字段照 `docs/spec/contract-skill.md` v1.0 实现。
 *
 * 落位与导出面由契约 §4.1 指定（本文件必须导出同名列）：
 * `skillFrontmatterSchema` / `SkillFrontmatter` / `skillInputsSchema` / `SKILL_NAME_RE` /
 * `SKILL_ALLOWED_TOOLS` / `SKILL_OUTPUTS` / `SKILL_RESERVED_NAMES`。
 *
 * 明确不做的事：本包**不解析 YAML**（只依赖 zod，不引 yaml 库）。`skills/` 模块负责把 frontmatter
 * 解析成对象，再交给这里校验。JSON Schema 由 zod 生成，不手写第二份。
 *
 * 本文件有两段，别混：
 * 1) 上半段：一个技能文件长什么样（`contract-skill.md` v1.0）；
 * 2) 下半段（自 `skillScopeSchema` 起）：面板技能管理接口传什么
 *    （`docs/spec/skill-management.md` §5/§6）。两段共用字段名，不另起一套。
 */
import { z } from 'zod';
import { isoDateTimeSchema } from './common.ts';
import { MODEL_NAME_RE, SKILL_ALLOWED_TOOLS, SKILL_OUTPUTS } from './enums.ts';

/** `^/[a-z][a-z0-9-]{1,30}$`（ASCII 小写，总长 ≤32，必须以 `/` 开头）。 */
export const SKILL_NAME_RE = /^\/[a-z][a-z0-9-]{1,30}$/;

/** 保留名：仓库技能不许覆盖人工重跑入口（契约 §3）。 */
export const SKILL_RESERVED_NAMES = ['/retry', '/help', '/skills'] as const;

/** 单任务超时上限：30 分钟。超过时截断到上限并记 warn（技能本身仍合法）。 */
export const SKILL_TIMEOUT_MAX_MS = 30 * 60 * 1000;

/** `^(0|[1-9][0-9]*)(s|m)$` */
export const SKILL_TIMEOUT_RE = /^(0|[1-9][0-9]*)(s|m)$/;

/** 单行约束：description 会被拼进面向人的评论，多行会破坏回复格式。 */
const singleLineText = (schema: z.ZodString) => schema.refine((value) => !/[\r\n]/.test(value), { message: '必须是单行（不允许换行或块标量）' });

/** `inputs` 的一项（契约 §2.1）。单独导出是为了复用与单测。 */
export const skillInputsSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,23}$/),
    required: z.boolean(),
    /** RE2 兼容正则，≤128 字符；运行期用于校验参数值。 */
    pattern: z.string().min(1).max(128).optional(),
    /** ≤80 字符，单行。 */
    description: singleLineText(z.string().max(80)).optional(),
  })
  .strict();
export type SkillInput = z.infer<typeof skillInputsSchema>;

/** 解析 `timeout`（`20m` / `90s`）为毫秒。格式已由 schema 保证，这里不做二次校验。 */
export function parseSkillTimeoutMs(timeout: string): number {
  const match = SKILL_TIMEOUT_RE.exec(timeout);
  if (match === null) {
    throw new Error(`非法的 timeout：${timeout}`);
  }
  const amount = Number(match[1]);
  return match[2] === 'm' ? amount * 60_000 : amount * 1_000;
}

/**
 * 生效的超时：超过 `30m` 上限时**截断到上限并记 warn**，不是拒绝（契约 §2 / §3）。
 * 返回值带 `truncated`，调用方据此写 warn 日志与 `/api/system` 的 `timeoutMs`。
 */
export function effectiveSkillTimeout(timeout: string | undefined): { ms: number; truncated: boolean } {
  const raw = timeout === undefined ? 20 * 60_000 : parseSkillTimeoutMs(timeout);
  if (raw > SKILL_TIMEOUT_MAX_MS) {
    return { ms: SKILL_TIMEOUT_MAX_MS, truncated: true };
  }
  return { ms: raw, truncated: false };
}

/**
 * frontmatter 的完整 schema。`.strict()` 是有意的：未知顶层键一律拒绝。
 *
 * 五处典型越界（`contract-skill.md` §5.3）都会在这里被拒：
 * 1. `description` 多行（块标量）
 * 2. `allowed-tools` 含枚举外工具（`WebFetch` 等）—— 授权类字段不截断，整份非法
 * 3. `timeout: 45`（缺单位 / 超上限）
 * 4. `outputs` 含 `push_branch`（枚举只有 `comment`/`labels`/`issue`/`pr`）
 * 5. `requires-repo-config: yes`（YAML 1.1 会解析成 `true`，1.2 解析成字符串；只收字面量布尔）
 */
export const skillFrontmatterSchema = z
  .object({
    name: z
      .string()
      .regex(SKILL_NAME_RE, '必须以 / 开头，小写 ASCII，总长 ≤32')
      .refine((value) => !(SKILL_RESERVED_NAMES as readonly string[]).includes(value), {
        message: `不得使用保留名：${SKILL_RESERVED_NAMES.join(' / ')}`,
      }),
    description: singleLineText(z.string().min(10).max(200)),
    'allowed-tools': z.array(z.enum(SKILL_ALLOWED_TOOLS)).min(1).max(SKILL_ALLOWED_TOOLS.length),
    /** 缺省 `20m`；超过 `30m` 由 `effectiveSkillTimeout` 截断并 warn。 */
    timeout: z.string().regex(SKILL_TIMEOUT_RE, '只接受 <数字>s / <数字>m，例如 20m').optional(),
    /** `provider/model`；空则用仓库配置的默认模型。不影响 `tasks.idempotency_key`。 */
    model: z.string().regex(MODEL_NAME_RE).optional(),
    /** 参数形状声明，最多 8 项。 */
    inputs: z.array(skillInputsSchema).max(8).optional(),
    /** 允许产出哪些动作类型；`pr` 隐含 `push_branch`（必须带 `paths`）。 */
    outputs: z.array(z.enum(SKILL_OUTPUTS)).min(1).max(SKILL_OUTPUTS.length),
    'requires-repo-config': z.boolean().optional(),
  })
  .strict()
  .meta({ id: 'SkillFrontmatter' });
export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

/**
 * 加载后的有效配置（默认值已展开）。`skills/` 模块与 `/api/system` 用它，
 * 避免「默认值散落在各处」——例如 `timeout` 的默认 20m 只在这里出现一次。
 */
export const skillEffectiveConfigSchema = z
  .object({
    name: z.string().min(1).max(33),
    description: z.string().min(10).max(200),
    allowedTools: z.array(z.enum(SKILL_ALLOWED_TOOLS)).min(1),
    timeoutMs: z.number().int().min(0).max(SKILL_TIMEOUT_MAX_MS),
    /** 生效值是否被上限截断（true 时加载期记 warn）。 */
    timeoutTruncated: z.boolean(),
    model: z.string().nullable(),
    inputs: z.array(skillInputsSchema).max(8),
    outputs: z.array(z.enum(SKILL_OUTPUTS)).min(1),
    requiresRepoConfig: z.boolean(),
  })
  .strict()
  .meta({ id: 'SkillEffectiveConfig' });
export type SkillEffectiveConfig = z.infer<typeof skillEffectiveConfigSchema>;

/** 把 frontmatter 展开成有效配置（纯函数，不读文件、不查仓库配置）。 */
export function toSkillEffectiveConfig(frontmatter: SkillFrontmatter): SkillEffectiveConfig {
  const timeout = effectiveSkillTimeout(frontmatter.timeout);
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    allowedTools: [...frontmatter['allowed-tools']],
    timeoutMs: timeout.ms,
    timeoutTruncated: timeout.truncated,
    model: frontmatter.model ?? null,
    inputs: frontmatter.inputs ?? [],
    outputs: [...frontmatter.outputs],
    requiresRepoConfig: frontmatter['requires-repo-config'] ?? false,
  };
}

/**
 * 技能管理（面板可写面）的 DTO —— `docs/spec/skill-management.md` §5/§6 的落地形状。
 *
 * 与既有 `contract-skill.md` 的关系：那份契约定义**一个技能文件长什么样**；
 * 这份定义**面板接口传什么**。两者共用同一批字段名（`name` / `description` /
 * `allowed-tools` / `outputs` …），不要在这里另起一套命名。
 */

export const skillScopeSchema = z.enum(['global', 'repo']);
export type SkillScope = z.infer<typeof skillScopeSchema>;

export const skillSourceSchema = z.enum(['builtin', 'repo-file', 'upload']);
/** 注意：与 `apps/server/src/skills/types.ts` 的 `SkillSource`（`'builtin'|'repo'`）**不是**同一个东西，
 *  那是加载期的来源、这是面板看到的三值来源，故意不同名以免误导入。 */
export type SkillSourceKind = z.infer<typeof skillSourceSchema>;

/** 技能目录里的一个文件（内容不在这里，按需读详情）。 */
export const skillFileMetaSchema = z
  .object({
    path: z.string().min(1).max(300),
    bytes: z.number().int().min(0).max(5_000_000),
    sha256: z.string().length(64),
  })
  .strict();
export type SkillFileMeta = z.infer<typeof skillFileMetaSchema>;

/** 校验结果：`ok=false` 的版本不会生效（上传时就直接拒绝）。 */
export const skillValidationSchema = z
  .object({
    ok: z.boolean(),
    errors: z.array(z.string().max(500)).max(50),
    warnings: z.array(z.string().max(500)).max(50),
  })
  .strict();
export type SkillValidation = z.infer<typeof skillValidationSchema>;

/** 列表行：一屏能扫完的字段，不含正文。 */
export const skillListItemSchema = z
  .object({
    id: z.string().min(1).max(64),
    /** 规范名：`/xxx`（入库归一，见 spec D2）。 */
    name: z.string().min(2).max(33),
    description: z.string().min(1).max(200),
    scope: skillScopeSchema,
    /** `scope='repo'` 时为 `owner/name`，否则 `null`。 */
    repo: z.string().max(200).nullable(),
    source: skillSourceSchema,
    enabled: z.boolean(),
    currentVersion: z.number().int().min(1),
    /** 同 scope 下被更高优先级的同名技能覆盖时为覆盖者 id；否则 `null`。 */
    overriddenBy: z.string().max(64).nullable(),
    /** 目录总字节数（列表页展示「多大」）。 */
    sizeBytes: z.number().int().min(0).max(50_000_000),
    updatedAt: isoDateTimeSchema,
  })
  .strict();
export type SkillListItem = z.infer<typeof skillListItemSchema>;

export const skillsResponseSchema = z
  .object({
    generatedAt: isoDateTimeSchema,
    skills: z.array(skillListItemSchema).max(500),
  })
  .strict()
  .meta({ id: 'SkillsResponse' });
export type SkillsResponse = z.infer<typeof skillsResponseSchema>;

/** 详情：列表行 + frontmatter + 正文 + 文件清单 + 校验结果。 */
export const skillDetailSchema = skillListItemSchema
  .extend({
    /** 解析后的 frontmatter（键与 `contract-skill.md` 一致）。 */
    frontmatter: z.record(z.string(), z.unknown()),
    /** 正文（已剥 frontmatter）；面板只读展示，编辑走 PATCH。 */
    body: z.string().max(200_000),
    files: z.array(skillFileMetaSchema).max(200),
    validation: skillValidationSchema,
    treeSha256: z.string().length(64),
  })
  .meta({ id: 'SkillDetail' });
export type SkillDetail = z.infer<typeof skillDetailSchema>;

export const skillVersionSchema = z
  .object({
    version: z.number().int().min(1),
    treeSha256: z.string().length(64),
    files: z.array(skillFileMetaSchema).max(200),
    validation: skillValidationSchema,
    createdAt: isoDateTimeSchema,
  })
  .strict();
export type SkillVersion = z.infer<typeof skillVersionSchema>;

export const skillVersionsResponseSchema = z
  .object({
    generatedAt: isoDateTimeSchema,
    skillId: z.string().min(1).max(64),
    versions: z.array(skillVersionSchema).max(100),
  })
  .strict()
  .meta({ id: 'SkillVersionsResponse' });
export type SkillVersionsResponse = z.infer<typeof skillVersionsResponseSchema>;

/** 上传成功（或新版本）的返回。 */
export const skillUploadResponseSchema = z
  .object({
    skill: skillListItemSchema,
    version: z.number().int().min(1),
    validation: skillValidationSchema,
  })
  .strict()
  .meta({ id: 'SkillUploadResponse' });
export type SkillUploadResponse = z.infer<typeof skillUploadResponseSchema>;

/**
 * 上传时可选的作用域（查询串）。缺省 `global`。
 * `scope=repo` 时必须同时给 `repo=owner/name`。
 */
export const skillUploadQuerySchema = z
  .object({
    scope: skillScopeSchema.default('global'),
    repo: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'repo 必须是 owner/name')
      .optional(),
    /** `enabled=false` 表示「传上来但先别启用」。缺省 `true`（上传即生效，spec D0）。 */
    enabled: z.enum(['true', 'false']).default('true'),
  })
  .strict();
export type SkillUploadQuery = z.infer<typeof skillUploadQuerySchema>;

/**
 * 局部更新：只允许改这三样。
 * **`name` / `scope` / `repo` 不可改**（改了就是另一个技能，语义是「删了再传」）。
 */
export const skillPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    description: z.string().min(10).max(200).optional(),
    /** 正文（不含 frontmatter）。给了就产生一个新版本。 */
    body: z.string().max(200_000).optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    '至少要改一个字段（enabled / description / body）',
  );
export type SkillPatch = z.infer<typeof skillPatchSchema>;

/** 列表筛选（查询串）。 */
export const skillsQuerySchema = z
  .object({
    scope: skillScopeSchema.optional(),
    repo: z.string().max(200).optional(),
    /** 缺省 = 不过滤（面板的「全部」）。给 `true` 只看启用的，给 `false` 只看停用的。 */
    enabled: z.enum(['true', 'false']).optional(),
    source: skillSourceSchema.optional(),
  })
  .strict();
export type SkillsQuery = z.infer<typeof skillsQuerySchema>;

/** 上传新版本（`POST /api/skills/:id/versions`）与回滚（`.../rollback`）共用的请求形状。 */
export const skillVersionUploadQuerySchema = skillUploadQuerySchema.pick({ enabled: true });
export type SkillVersionUploadQuery = z.infer<typeof skillVersionUploadQuerySchema>;

/** 回滚请求体：指定要回到哪个版本（会新建一个指向旧内容的新版本，不改历史）。 */
export const skillRollbackBodySchema = z
  .object({ version: z.number().int().min(1) })
  .strict();
export type SkillRollbackBody = z.infer<typeof skillRollbackBodySchema>;

/** 删除的结果（软删与硬删同一个形状，`hard` 说明这次是哪种）。 */
export const skillDeleteResponseSchema = z
  .object({ ok: z.boolean(), id: z.string().min(1).max(64), hard: z.boolean() })
  .strict()
  .meta({ id: 'SkillDeleteResponse' });
export type SkillDeleteResponse = z.infer<typeof skillDeleteResponseSchema>;
