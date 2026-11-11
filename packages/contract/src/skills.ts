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

/**
 * 技能的**存储名**：`/` + Agent Skills 标准的 `name`（小写字母/数字/连字符）。
 *
 * 为什么保留前导 `/`：技能在本仓同时是「`@bot /技能名`」的触发词（`skill-mentions.ts`），
 * 会话里靠这个前缀区分「命令」与普通正文。标准格式的 `name`（无斜杠）在解析层归一到这里，
 * 存储与展示只有一种形状。
 */
export const SKILL_NAME_RE = /^\/[a-z][a-z0-9-]{0,62}$/;

/**
 * Agent Skills 标准的 `name`（`https://agentskills.io/specification`）：
 * 1–64 字符、只有小写字母/数字/连字符、不得以连字符开头或结尾、不得出现连续连字符。
 * 本仓额外接受带前导 `/` 的写法（历史与命令触发都这么写）。
 */
export const AGENT_SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9]|-(?!-)){0,62}[a-z0-9]$|^[a-z0-9]$/;

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
      // Agent Skills 标准写法（`format-check`）与本仓的命令写法（`/format-check`）都收；
      // 归一化成 `/format-check` 由 `skills/frontmatter.ts::normalizeSkillName` 负责。
      .regex(
        /^\/?[a-z0-9](?:[a-z0-9]|-(?!-)){0,62}[a-z0-9]$|^\/?[a-z0-9]$/u,
        '小写字母/数字/连字符，1–64 字符（可带前导 /），首尾不能是连字符',
      )
      .refine((value) => !(SKILL_RESERVED_NAMES as readonly string[]).includes(`/${value.replace(/^\//u, '')}`), {
        message: `不得使用保留名：${SKILL_RESERVED_NAMES.join(' / ')}`,
      }),
    /**
     * 一句话描述（**必填**，标准里 ≤1024）。会被拼进提示词的技能目录，所以这里限制 1024
     * 并把多行归一化成单行（YAML 的块标量在标准里是允许的，`toSkillEffectiveConfig` 负责折行）。
     */
    description: z.string().min(10).max(1024),
    /** 标准里是可选字段（实验性）；缺省见 `toSkillEffectiveConfig`。 */
    'allowed-tools': z.array(z.enum(SKILL_ALLOWED_TOOLS)).min(1).max(SKILL_ALLOWED_TOOLS.length).optional(),
    /** 缺省 `20m`；超过 `30m` 由 `effectiveSkillTimeout` 截断并 warn。 */
    timeout: z.string().regex(SKILL_TIMEOUT_RE, '只接受 <数字>s / <数字>m，例如 20m').optional(),
    /** `provider/model`；空则用仓库配置的默认模型。不影响 `tasks.idempotency_key`。 */
    model: z.string().regex(MODEL_NAME_RE).optional(),
    /** 参数形状声明，最多 8 项。 */
    inputs: z.array(skillInputsSchema).max(8).optional(),
    /** 允许产出哪些动作类型；`pr` 隐含 `push_branch`（必须带 `paths`）。缺省 `['comment']`。 */
    outputs: z.array(z.enum(SKILL_OUTPUTS)).min(1).max(SKILL_OUTPUTS.length).optional(),
    'requires-repo-config': z.boolean().optional(),
    // ── 以下是 Agent Skills 标准的可选字段（`agentskills.io/specification`）──────────
    // 存进 `frontmatter` jsonb、面板原样回显；本仓的加载期不读它们（不影响注册表）。
    license: z.string().min(1).max(200).optional(),
    compatibility: z.string().min(1).max(500).optional(),
    metadata: z.record(z.string().min(1).max(64), z.string().max(500)).optional(),
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
    name: z.string().min(1).max(65),
    description: z.string().min(10).max(1024),
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
/** 缺省工具集：标准里 `allowed-tools` 是可选的，本仓按「只读三件套」兜底（最小授权）。 */
export const DEFAULT_SKILL_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep'] as const;

/** 缺省产出：只发评论（需求 §1「默认产出一条评论」）。 */
export const DEFAULT_SKILL_OUTPUTS = ['comment'] as const;

/**
 * 把 frontmatter 展开成有效配置（纯函数，不读文件、不查仓库配置）。
 *
 * 两处「标准兼容」的归一化都在这里：
 *  1. `allowed-tools` / `outputs` 在 Agent Skills 标准里是可选的 → 用上面的缺省值补齐；
 *  2. `description` 允许块标量（多行）→ 折叠成单行，因为它会被拼进提示词的技能目录。
 */
export function toSkillEffectiveConfig(frontmatter: SkillFrontmatter): SkillEffectiveConfig {
  const timeout = effectiveSkillTimeout(frontmatter.timeout);
  return {
    // 存储/展示口径一律带前导 `/`（`SKILL_NAME_RE`）：frontmatter 允许写成标准形态
    // `issue-format`，但注册表/命令解析/面板都按 `/issue-format` 索引 —— 不在这里补齐，
    // 同一个技能会出现「注册名不带斜杠、解析按带斜杠找」的错位（实测 `Skill … not available`）。
    name: frontmatter.name.startsWith('/') ? frontmatter.name : `/${frontmatter.name}`,
    description: frontmatter.description.replace(/\s+/gu, ' ').trim(),
    allowedTools: [...(frontmatter['allowed-tools'] ?? DEFAULT_SKILL_ALLOWED_TOOLS)],
    timeoutMs: timeout.ms,
    timeoutTruncated: timeout.truncated,
    model: frontmatter.model ?? null,
    inputs: frontmatter.inputs ?? [],
    outputs: [...(frontmatter.outputs ?? DEFAULT_SKILL_OUTPUTS)],
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

/* ── 模态框编辑器：按文件读写 + 多技能导入（docs/plan-skill-editor-modal.md）── */

/**
 * 技能目录里的一个文本文件。
 *
 * 面板的文件树只靠 `path` 的 `/` 分段渲染，所以这里不再给「目录/文件」标记：
 * 多一段就是目录，末段就是文件名。二进制文件不进这个结构。
 */
export const skillFileTextSchema = z
  .object({
    /** 相对技能根的路径（`SKILL.md`、`references/API.md`），≤300 字符。 */
    path: z.string().min(1).max(300),
    text: z.string().max(5_000_000),
  })
  .strict();
export type SkillFileText = z.infer<typeof skillFileTextSchema>;

/** `GET /api/skills/:id/files`：一次拉全，文件树在端上算。 */
export const skillFilesResponseSchema = z
  .object({
    generatedAt: isoDateTimeSchema,
    skillId: z.string().min(1).max(64),
    files: z.array(skillFileTextSchema).max(200),
  })
  .strict()
  .meta({ id: 'SkillFilesResponse' });
export type SkillFilesResponse = z.infer<typeof skillFilesResponseSchema>;

/**
 * `PUT /api/skills/:id/files` 的请求体：写入一个文件并生成新版本。
 *
 * `path` 由服务端再校验一次（无 `..`、无绝对路径、每段 ≤80 字符），前端校验不可信。
 */
export const skillFileWriteSchema = z
  .object({
    path: z.string().min(1).max(300),
    text: z.string().max(5_000_000),
  })
  .strict();
export type SkillFileWrite = z.infer<typeof skillFileWriteSchema>;

/**
 * `POST /api/skills/import` 的结果：一个 zip 里可能有多个技能目录。
 *
 * 部分成功是常态（例如 3 个目录里有 1 个 frontmatter 非法），所以 `imported` 与
 * `errors` 同时返回；调用方据 `errors.length` 决定是否提示「部分导入」。
 */
export const skillImportResponseSchema = z
  .object({
    generatedAt: isoDateTimeSchema,
    imported: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            name: z.string().min(2).max(65),
            version: z.number().int().min(1),
            /** `true` = 新建，`false` = 同名技能被覆盖成新版本。 */
            created: z.boolean(),
          })
          .strict(),
      )
      .max(50),
    /** 被跳过的技能目录及原因（中文，直接显示给用户）。 */
    errors: z.array(z.string().max(500)).max(50),
    warnings: z.array(z.string().max(500)).max(50),
  })
  .strict()
  .meta({ id: 'SkillImportResponse' });
export type SkillImportResponse = z.infer<typeof skillImportResponseSchema>;

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
