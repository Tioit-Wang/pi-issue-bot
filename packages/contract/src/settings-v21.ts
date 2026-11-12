/**
 * v2.1 设置契约（`docs/v21-contract.md` §1）：事件开关 / 事件提示词模板 / 评论闸门 /
 * 提及关键词 / 角色清单 / 执行限额 / 标签目录的 v2.1 字段。
 *
 * 为什么单独一个模块而不是继续塞进 `repo-config.ts`：v2.1 的这六段是**一张互相引用的网**
 * （闸门引用角色、事件模板引用标签目录、执行限额决定写回动作开不开），放在一起才能一眼看出
 * 「谁能引用谁」；而 `repo-config.ts` 已经很清楚地表达了 v0.3 的旧结构，混进去只会让两边都读不懂。
 * 装配点在 `repo-config.ts` 的 `repoSettingsShapeSchema`：它 import 本模块，本模块**不**回头 import 它
 * （`repo-config → trigger → settings-v21` 是一条单向链，没有模块环）。
 *
 * 三条硬规则沿用 v0.3：
 * 1. **未知键一律拒绝**（`.strict()`）：拼错的键静默忽略等于配置写错了却看不出来；
 * 2. **默认值写在 schema 里**：面板、服务端解析、文档默认值都从这一份取；
 * 3. **不用 `.transform()`**：带 transform 的 schema 生成不了 JSON Schema
 *    （`packages/contract/test/contract.test.ts` 要求每个注册的 schema 都能出 JSON Schema）。
 */
import { z } from 'zod';

/* ── 0. 长度上限（面板文案与服务端截断共用一处） ─────────────────────────────── */

/** 单个事件提示词模板上限（与 `agent.project_prompt` 同口径）。 */
export const EVENT_PROMPT_MAX_CHARS = 4000;
/** 项目级系统提示词的硬上限：它每次调用都带，太长会把窗口吃掉一半。 */
export const SYSTEM_PROMPT_MAX_CHARS = 20_000;
/** 提及关键词上限（`@` 后面的名字）。 */
export const COMMENT_KEYWORD_MAX_CHARS = 50;
/** 角色名上限：给人看的中文名，40 字足够。 */
export const ROLE_NAME_MAX_CHARS = 40;
/** 关键词条数上限（句柄 / 别名 / 历史叫法）。 */
export const MAX_COMMENT_KEYWORDS = 10;
/** 角色清单条数上限。 */
export const MAX_COMMENT_ROLES = 50;
/** 单个角色里的成员数上限（GitHub login 列表）。 */
export const MAX_ROLE_MEMBERS = 50;
/** `issues.labeled` 的触发标签数上限。 */
export const MAX_LABEL_TRIGGER_TARGETS = 50;
/** 标签目录单个 entry 的含义/说明长度上限（与 `labelVocabularyEntrySchema` 一致）。 */
export const LABEL_MEANING_MAX_CHARS = 200;

/**
 * GitHub login 的字符集（`^[A-Za-z0-9]` 开头，其后允许 `-`，总长 1–39）。
 *
 * 为什么不从 `repo-config.ts` 的 `LOGIN_RE` import：那会让
 * `repo-config → trigger → settings-v21 → repo-config` 成环，而本文件的 schema 在**模块求值期**
 * 就会读取这个正则（TDZ 直接抛错）。所以复制一份 `MEMBER_LOGIN_RE`，
 * 并由 `packages/contract/test/settings-v21.test.ts` 断言两者**完全相等**，防止各自漂移。
 */
export const MEMBER_LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u;

/* ── 1. 事件开关 ────────────────────────────────────────────────────────────── */

/**
 * 事件全集（FR-2.1）。`pull_request.*` **刻意不在其中**：本期不处理 PR 事件
 * （`docs/v21-contract.md` §0「不纳入」），收到即按未触发留痕。
 */
export const EVENT_KEYS = [
  'issues.opened',
  'issues.edited',
  'issues.labeled',
  'issues.closed',
  'issue_comment.created',
] as const;

export type EventKey = (typeof EVENT_KEYS)[number];

export const eventKeySchema = z.enum(EVENT_KEYS);

/** 开关三态：`on` 直接触发 / `off` 不触发 / `conditional` 过附加条件才触发。 */
export const EVENT_SWITCHES = ['on', 'off', 'conditional'] as const;

export type EventSwitch = (typeof EVENT_SWITCHES)[number];

export const eventSwitchSchema = z.enum(EVENT_SWITCHES);

/**
 * 单个事件的触发配置（FR-2.1 / FR-2.2）。
 *
 * `prompt: null` = 用平台内置默认模板（不是空模板）：配置里区分不开「没写」和「故意清空」，
 * 所以只有一个「用内置」的表示法，避免面板出现「模板为空到底发不发」的二义。
 */
export const eventTriggerSchema = z
  .object({
    enabled: eventSwitchSchema.default('on'),
    /** 事件触发时发给 agent 的指令模板；`null` = 用内置默认模板。 */
    prompt: z.string().max(EVENT_PROMPT_MAX_CHARS).nullable().default(null),
    /** 仅 `issues.edited` 有意义：只改标题/标签不触发（默认 `true`，见 `eventTriggersSchema`）。 */
    only_body_changed: z.boolean().optional(),
    /** 仅 `issues.labeled` 有意义：命中所配标签才触发；空数组 = 永不触发。 */
    labels: z.array(z.string().min(1).max(50)).max(MAX_LABEL_TRIGGER_TARGETS).optional(),
  })
  .strict();

export type EventTrigger = z.infer<typeof eventTriggerSchema>;

/* ── 2. 评论闸门（FR-2.4） ──────────────────────────────────────────────────── */

/**
 * 评论事件的四个闸门（FR-2.4）。
 *
 * 放在**事件配置里**而不是 `comment` 段：闸门是「这一个事件怎么判定」，与「项目有哪些关键词
 * 和角色」（`comment` 段，属于被引用的定义）是两件事——`docs/requirements.html` §6.6 的示例
 * YAML 也是这么落的。`allow_roles` 只能引用 `comment.roles` 里已定义的名字，
 * 跨字段校验在 `repoSettingsSchema` 的 superRefine（两个字段分属不同段，schema 内部看不到）。
 */
export const commentGatesSchema = z
  .object({
    /** 评论里出现**合法提及**才触发（FR-2.5）。 */
    require_mention: z.boolean().default(true),
    /** 是否限定角色：只能从 `comment.roles` 里选。 */
    require_role: z.boolean().default(false),
    /** 允许触发本次评论的角色名（必须存在于 `comment.roles`）。 */
    allow_roles: z.array(z.string().min(1).max(ROLE_NAME_MAX_CHARS)).max(MAX_COMMENT_ROLES).default([]),
    /** 机器人自己发的评论不触发（避免自问自答）。 */
    ignore_bot: z.boolean().default(true),
    /** issue 关闭后的新评论默认不处理。 */
    allow_closed: z.boolean().default(false),
  })
  .strict();

export type CommentGates = z.infer<typeof commentGatesSchema>;

/* ── 3. 评论触发配置（§6.6）：提及关键词 + 角色清单 ───────────────────────────── */

/**
 * 提及关键词：`@` 后面要命中的名字（`pi-bot` / 小豆 / 历史叫法）。
 *
 * 只禁空白与 `@`（`@小豆` 里的关键词本身不可能含 `@`），不限制中文：
 * §6.6 的示例就同时有 `pi-bot` 与 `小豆`。边界判定（关键词后必须是分隔符）由
 * WS2 的 `trigger/mention.ts` 负责，属于判定逻辑而不是形状约束。
 */
export const commentMentionSchema = z
  .object({
    keyword: z
      .string()
      .trim()
      .min(1)
      .max(COMMENT_KEYWORD_MAX_CHARS)
      .regex(/^[^\s@]+$/u, '关键词不能包含空白或 @'),
    /** 是否区分大小写；缺省不区分（`@Pi-Bot` 与 `@pi-bot` 等价）。 */
    case_sensitive: z.boolean().optional(),
  })
  .strict();

export type CommentMention = z.infer<typeof commentMentionSchema>;

/** GitHub 随每条评论给出的作者关联取值（FR-2.4 / §6.6，七个）。 */
export const ASSOCIATIONS = [
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
  'CONTRIBUTOR',
  'FIRST_TIME_CONTRIBUTOR',
  'FIRST_TIMER',
  'NONE',
] as const;

export type Association = (typeof ASSOCIATIONS)[number];

export const associationSchema = z.enum(ASSOCIATIONS);

/** 角色名：给人看、闸门里按名字引用，所以不许为空也不许带首尾空白。 */
export const roleNameSchema = z.string().trim().min(1).max(ROLE_NAME_MAX_CHARS);

/**
 * 角色清单的一项：**判别联合**（按 `by` 二选一）。
 *
 * 刻意不是「两个可选字段取其一」：那样能写出「既没给 any_of 也没给 members」的空壳角色，
 * 于是闸门里选了一个永远判不出结果的名字。判别联合让非法组合在解析期就失败。
 */
export const commentRoleSchema = z.discriminatedUnion('by', [
  z
    .object({
      name: roleNameSchema,
      by: z.literal('association'),
      /** 命中任一作者关联即算该角色。 */
      any_of: z.array(associationSchema).min(1).max(ASSOCIATIONS.length),
    })
    .strict(),
  z
    .object({
      name: roleNameSchema,
      by: z.literal('members'),
      /** GitHub 个人账号 login；**不支持组织与团队**（§6.6）。 */
      members: z.array(z.string().regex(MEMBER_LOGIN_RE, '成员必须是 GitHub login（不支持 org/team）')).min(1).max(MAX_ROLE_MEMBERS),
    })
    .strict(),
]);

export type CommentRole = z.infer<typeof commentRoleSchema>;

/**
 * `settings.comment`：评论事件的两个**定义源**（提及关键词 + 角色清单）。
 *
 * `mentions` 至少 1 个：没有关键词就永远判不出「被提及」，`require_mention` 这个默认闸门
 * 会把该事件变成永久不触发——那不是一个合法配置，是配置写坏了，所以要求非空。
 * `roles` 可以为空：不启用「限定角色」闸门时本来就不需要角色。
 */
export const commentConfigSchema = z
  .object({
    mentions: z.array(commentMentionSchema).min(1).max(MAX_COMMENT_KEYWORDS),
    roles: z.array(commentRoleSchema).max(MAX_COMMENT_ROLES).default([]),
  })
  .strict();

export type CommentConfig = z.infer<typeof commentConfigSchema>;

/* ── 4. 执行限额（§6.7 / FR-5.3） ───────────────────────────────────────────── */

/**
 * 后三类写回动作的项目级开关（FR-5.3）：默认**全关**。
 *
 * 前三类（verdict / label / comment / reaction）不需要开关：它们只作用在这条 issue 上，
 * 建 issue / 开 PR / 关单则会外溢到别处，默认关闭是「宁可少做、不可错做」。
 */
export const agentActionsSchema = z
  .object({
    create_issue: z.boolean().default(false),
    open_pr: z.boolean().default(false),
    close_issue: z.boolean().default(false),
  })
  .strict();

export type AgentActions = z.infer<typeof agentActionsSchema>;

/**
 * 执行侧的项目级配置（§6.7）：系统提示词 + 并发/配额/超时 + 动作开关 + 数据保留期。
 *
 * 数值范围都写死在这里（并发 1–8、日配额 1–1000、单轮 1–30 分钟）：
 * 平台不设业务限流，这些是**项目自己能拧的旋钮**，越界的值只会在运行时变成事故。
 */
export const agentExecutionSchema = z
  .object({
    /** 常驻角色设定，每次调用都带、不参与压缩；空串 = 用内置默认（不是「没有提示词」）。 */
    system_prompt: z.string().max(SYSTEM_PROMPT_MAX_CHARS).default(''),
    /** 同一项目同时最多几个会话在跑；超出的排队等待，不丢弃。 */
    concurrency: z.number().int().min(1).max(8).default(2),
    /** 每天最多处理多少个事件；超出的拒绝处理并记录原因（可查）。 */
    daily_quota: z.number().int().min(1).max(1000).default(100),
    /** 单轮执行的最长时长（分钟）；超时终止并记 timed-out，不自动重试。 */
    turn_timeout_minutes: z.number().int().min(1).max(30).default(20),
    /** 后三类写回动作的开关（默认全关）。 */
    actions: agentActionsSchema.prefault({}),
    /** 对话/工具/token 明细的保留天数（指标永久，§7.6 口径不变）。 */
    data_retention_days: z.number().int().min(1).max(365).default(90),
  })
  .strict();

export type AgentExecution = z.infer<typeof agentExecutionSchema>;

/* ── 5. 标签目录（FR-5.4 / §6.5） ───────────────────────────────────────────── */

/** 标签在平台侧的状态：`retired` = GitHub 上已被删除，不再进入目标态。 */
export const labelStatusSchema = z.enum(['active', 'retired']);

export type LabelStatus = z.infer<typeof labelStatusSchema>;

/**
 * 标签目录条目的角色（与 `repo-config.ts` 的 `labelRoleSchema` 同取值集）。
 *
 * 同样为了避开模块环而复制一份；等值性由单测断言（见 `settings-v21.test.ts`）。
 */
export const labelCatalogRoleSchema = z.enum(['requirement', 'defect', 'other']);

export type LabelCatalogRole = z.infer<typeof labelCatalogRoleSchema>;

/**
 * v2.1 的标签目录条目：**词表条目的超集**，多两个带默认值的字段（FR-5.4 / BR-11）。
 *
 * - `managed: false` = 这个标签**不参与自动对齐**（人明确要自己管）；
 * - `status: 'retired'` = GitHub 上已删除，留在目录里只为让历史记录仍能解释。
 *
 * 「目录即全量」的判定读这两个字段，所以它们必须有默认值：老配置（没有这两个键）
 * 一律按 `managed=true` / `status='active'` 解释，行为与 v2.0 完全一致。
 */
export const labelCatalogEntryV21Schema = z
  .object({
    name: z.string().min(1).max(50),
    role: labelCatalogRoleSchema,
    /** 含义；为空 = 执行侧不知道它是什么意思，**不进自动对齐范围**（§6.5 的保护）。 */
    meaning: z.string().min(1).max(LABEL_MEANING_MAX_CHARS).optional(),
    /** `RRGGBB`，不带 `#`（与 GitHub 标签颜色口径一致）。 */
    color: z.string().regex(/^[0-9A-Fa-f]{6}$/u, 'color 是 6 位十六进制，不带 #').optional(),
    /** 面板展示用的说明。 */
    description: z.string().min(1).max(500).optional(),
    /** 互斥组（同组只留一个）。 */
    group: z.string().min(1).max(40).optional(),
    /** `false` = 不自动管理（BR-11）。 */
    managed: z.boolean().default(true),
    /** `retired` = 已在 GitHub 上删除，不再进入目标态。 */
    status: labelStatusSchema.default('active'),
  })
  .strict();

export type LabelCatalogEntryV21 = z.infer<typeof labelCatalogEntryV21Schema>;

/* ── 6. 五个事件的默认值表（FR-2.1） ───────────────────────────────────────── */

/**
 * 评论事件多一层闸门（FR-2.4），所以它的条目形状比其它事件宽一格。
 *
 * 刻意不复用 `eventTriggerSchema.extend()`：把 shape 摊平写出来，类型推导与 JSON Schema
 * 生成都不依赖 zod 的 merge 行为，读代码时也能直接看到「评论事件多了 `gates`」。
 */
export const commentEventTriggerSchema = z
  .object({
    enabled: eventSwitchSchema.default('conditional'),
    prompt: z.string().max(EVENT_PROMPT_MAX_CHARS).nullable().default(null),
    only_body_changed: z.boolean().optional(),
    labels: z.array(z.string().min(1).max(50)).max(MAX_LABEL_TRIGGER_TARGETS).optional(),
    gates: commentGatesSchema.prefault({}),
  })
  .strict();

export type CommentEventTrigger = z.infer<typeof commentEventTriggerSchema>;

/**
 * `settings.triggers.events`：五个事件的触发配置，**每个键都预置默认值**。
 *
 * 为什么用 `.prefault({...})` 而不是在解析代码里补默认值：面板读到的 `settings` 与
 * webhook 判定用的必须是同一份值。`prefault` 的语义是「键缺失时把这段默认值**过一遍 schema**」，
 * 于是内层字段（`prompt: null` / `gates`）的默认值也只有一份。
 *
 * 默认值来自 FR-2.1：opened `on`、edited `on` + 只认正文变更、labeled `conditional` + 空标签表
 * （空 = 不触发）、closed `off`、comment `conditional` + 四闸门默认。
 */
export const eventTriggersSchema = z
  .object({
    'issues.opened': eventTriggerSchema.prefault({ enabled: 'on' }),
    'issues.edited': eventTriggerSchema.prefault({ enabled: 'on', only_body_changed: true }),
    'issues.labeled': eventTriggerSchema.prefault({ enabled: 'conditional', labels: [] }),
    'issues.closed': eventTriggerSchema.prefault({ enabled: 'off' }),
    'issue_comment.created': commentEventTriggerSchema.prefault({ enabled: 'conditional', gates: {} }),
  })
  .strict();

export type EventTriggers = z.infer<typeof eventTriggersSchema>;

/* ── 7. 默认值常量 ─────────────────────────────────────────────────────────── */

/** 默认提及关键词：部署时的机器人句柄（`@pi-bot`）。 */
export const DEFAULT_COMMENT_KEYWORD = 'pi-bot';

/** 五个事件的默认触发配置（`eventTriggersSchema.parse({})`）。 */
export const V21_DEFAULT_EVENT_TRIGGERS: EventTriggers = eventTriggersSchema.parse({});

/** 评论配置默认值：一个关键词、没有角色（角色清单由项目自己定义）。 */
export const V21_DEFAULT_COMMENT: CommentConfig = commentConfigSchema.parse({
  mentions: [{ keyword: DEFAULT_COMMENT_KEYWORD }],
  roles: [],
});

/** 四闸门默认值：要提及、不限角色、忽略机器人、不响应已关闭 issue。 */
export const V21_DEFAULT_COMMENT_GATES: CommentGates = commentGatesSchema.parse({});

/** 执行侧默认值：内置系统提示词、并发 2、日配额 100、单轮 20 分钟、三类动作全关、留 90 天。 */
export const V21_DEFAULT_AGENT_EXECUTION: AgentExecution = agentExecutionSchema.parse({});

/**
 * v2.1 全部默认值的**单一出口**（面板「恢复默认」、服务端解析失败兜底都从这里取）。
 *
 * 单独再列一次而不是让调用方各自 `parse({})`：默认值一旦要改，只改上面那几个常量即可，
 * 不会出现「面板恢复了 A 的默认值、服务端兜底用 B 的默认值」。
 */
export const V21_DEFAULTS = Object.freeze({
  events: V21_DEFAULT_EVENT_TRIGGERS,
  comment: V21_DEFAULT_COMMENT,
  gates: V21_DEFAULT_COMMENT_GATES,
  agent: V21_DEFAULT_AGENT_EXECUTION,
});

/* ── 8. 跨字段校验的小工具（`repoSettingsSchema` 与本模块的调用方共用） ───────── */

/**
 * 找出 `allow_roles` 里**没有在 `comment.roles` 中定义**的角色名（保存即报错，FR-2.4）。
 *
 * 为什么必须是硬校验：写错一个字，那个角色永远触发不了，而且没有任何报错
 * （§6.6「拼错会静默失效」）。返回名字而不是布尔值，是为了让错误消息能直接说清是哪个。
 * 名字按**精确匹配**比（角色名给人看，闸门是下拉选择，不存在大小写歧义）。
 */
export function findUnknownAllowRoles(
  comment: Pick<CommentConfig, 'roles'>,
  allowRoles: readonly string[],
): readonly string[] {
  const defined = new Set(comment.roles.map((role) => role.name));
  const unknown: string[] = [];
  for (const name of allowRoles) {
    if (!defined.has(name) && !unknown.includes(name)) {
      unknown.push(name);
    }
  }
  return unknown;
}

/** 同一份角色清单里重名的角色（重名会让「闸门选的是哪一个」变成不确定）。 */
export function findDuplicateRoleNames(comment: Pick<CommentConfig, 'roles'>): readonly string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const role of comment.roles) {
    if (seen.has(role.name) && !duplicates.includes(role.name)) {
      duplicates.push(role.name);
    }
    seen.add(role.name);
  }
  return duplicates;
}
