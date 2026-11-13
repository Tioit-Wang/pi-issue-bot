/**
 * 产出契约 v2（`docs/v21-contract.md` §4 / FR-5.3）：**仅 `tasks.source='agent'` 使用**。
 *
 * 与旧 4-intent 信封（`schema.ts`）的关系：两者**并存且互不改写**——
 * 旧的 `TaskEnvelope` 继续服务 `source='pipeline'|'command'` 的路径，本文件服务 v2.1 的 agent 路径。
 * 因此这里不 import `schema.ts` 里除分支/指纹规则以外的任何东西：把两份契约绑在一起，
 * 任何一侧的字段调整都会变成「另一侧的行为也变了」。
 *
 * 三条与旧契约**刻意不同**的语义（都来自 §4 的校验条款）：
 *  1. **整份判定，不逐条丢弃**。旧信封靠 `filterActions()` 丢掉坏动作、留下好动作；
 *     v2 的语义是「任一动作不合规 → 整份产出拒绝，一条都不执行」。所以本文件的校验器
 *     返回的是「整份 ok / 整份不 ok + 错误列表」，没有 `dropped` 这种中间态。
 *  2. **`actions` 必填但可为空数组**（只判定不动作）。旧的 `TaskEnvelope` 也要 actions，
 *     但它同时强制 `verdict`；v2 的 `verdict` 是可省的（纯问答不出结论）。
 *  3. **后三类动作（`create_issue` / `open_pr` / `close_issue`）的开关不在契约里判**：
 *     schema 只管形状，开关关闭 → 执行器在**执行前**整份拒绝（`action-disabled`）。
 *     把开关写进 schema 会让「同一份产出在 dry-run 里合法、在正式执行里不合法」，
 *     错误路径也就从「配置」漂到「产出」，面板分不清该让人改哪一边。
 *
 * 为什么用 zod 而不是 JSON Schema：v2 的校验要给出**字段级路径**（`/actions/0/payload/slot`），
 * 且判定的消费方是后端代码（执行器），不是纯数据消费方（面板/文档）。
 * 旧信封选 Ajv 的理由（见 `schema.ts` 文件头）在 v2 不再成立。
 */
import { z } from 'zod';

/* ── 0. 封闭枚举与阈值（改动即契约变更）──────────────────────────────────── */

/**
 * v2 产出的动作类型（`docs/v21-contract.md` §4 的 `ActionV21`）。顺序即面板展示顺序。
 *
 * **前七类**是 v2.0 就冻结的那七类；**后五类**是 v2.2 补的（`docs/plan-issue-tools.md` §5）。
 * 补的理由是可核对的：issue 工具面 19 个里有 5 个在动作词表里**没有落点** ——
 * 工具名、入参、使用规范都对，模型也说得出「改标题」「重新打开」「删掉那条评论」，
 * 但产出里没有任何位置能表达它，平台于是只能当没听见。
 *
 * 为什么一工具一动作、而不是加一个通用 `issue_op` + `op` 字段：通用动作会把
 * 项目开关（`GATED_ACTION_TYPES`）、dry-run、审计、错误码全部退化成
 * 「payload 里的字符串判断」，闸门与词表就不再一一对应，面板也没法按动作类型分组。
 */
export const OUTPUT_ACTION_TYPES = [
  'verdict',
  'label',
  'comment',
  'reaction',
  'create_issue',
  'open_pr',
  'close_issue',
  'reopen_issue',
  'update_issue',
  'update_comment',
  'delete_comment',
  'link',
] as const;

export type OutputActionType = (typeof OUTPUT_ACTION_TYPES)[number];

/**
 * 需要项目级开关的三类动作（§4 校验第 5 条）。
 *
 * 单列一个常量而不是在执行器里写字面量：开关判定要在**执行前**跑一遍，
 * 而面板要按同一份集合解释「哪些动作默认关闭」，两处引用同一个来源。
 */
export const GATED_ACTION_TYPES = ['create_issue', 'open_pr', 'close_issue'] as const;

export type GatedActionType = (typeof GATED_ACTION_TYPES)[number];

/**
 * 一条动作实际受哪个项目开关约束（§4 校验第 5 条）。
 *
 * 为什么不是「`type` 在 `GATED_ACTION_TYPES` 里」这么一句：`link` 的 `duplicate`
 * **等价于关闭 issue**（GitHub 侧就是 `state_reason=duplicate` + 关闭）。若只按 `type`
 * 判，`agent.actions.close_issue=false` 的项目会留一个关单后门 —— 模型换个工具名就能关。
 * 其余三个 relation（blocks / blocked_by / parent / relates）是纯关联，不受开关约束。
 *
 * 放在契约包而不是执行器里：面板要按同一份口径解释「哪个开关管哪些动作」，
 * 两处各写一遍必然漂移。
 */
export function gatedActionOf(action: {
  readonly type: string;
  readonly payload?: unknown;
}): GatedActionType | null {
  if ((GATED_ACTION_TYPES as readonly string[]).includes(action.type)) {
    return action.type as GatedActionType;
  }
  if (action.type === 'link') {
    const payload = action.payload;
    if (
      typeof payload === 'object' &&
      payload !== null &&
      (payload as Record<string, unknown>)['relation'] === 'duplicate'
    ) {
      return 'close_issue';
    }
  }
  return null;
}

/**
 * reaction 的目标（`IssueReactionAdd` / `IssueReactionRemove` 的 `target`）。
 *
 * 缺省 `issue`：老产出（只写 `op` + `content`）继续合法，语义不变。
 * `comment` 时必须同时给 `comment_id` —— 这条交叉校验放在 `semanticIssuesOf()` 里做，
 * 不用 zod 的 `superRefine`：`discriminatedUnion` 的成员一旦是 refinement，
 * 判别联合的类型收窄就失效（`action.payload` 变成 `unknown`）。
 */
export const REACTION_TARGETS = ['issue', 'comment'] as const;

export type ReactionTargetKind = (typeof REACTION_TARGETS)[number];

/**
 * `link` 的关系枚举（`IssueLink` 的 `relation`）。
 *
 * 取的是 GitHub **原生结构**能表达的四种 + 一个兜底：
 *  - `duplicate`：`state_reason=duplicate` 关单，并留一条指向原 issue 的关联评论；
 *  - `blocks` / `blocked_by`：issue dependencies 端点；
 *  - `parent`：把当前 issue 挂成目标 issue 的 sub-issue；
 *  - `relates`：GitHub 没有原生「相关」结构，落到一条带标记的关联评论上。
 */
export const LINK_RELATIONS = ['duplicate', 'blocks', 'blocked_by', 'parent', 'relates'] as const;

export type LinkRelation = (typeof LINK_RELATIONS)[number];

/**
 * `close_issue` 的 `state_reason`。
 *
 * GitHub 的原生枚举是四个（completed / not_planned / duplicate / reopened），
 * `reopened` 是 reopen 动作的产物而不是关闭理由，所以关闭侧只接受前三个。
 * 缺省 `not_planned`：v2.0 的执行器就是这么写死的（关单即「不打算做」），保留可回归。
 */
export const CLOSE_STATE_REASONS = ['completed', 'not_planned', 'duplicate'] as const;

export type CloseStateReason = (typeof CLOSE_STATE_REASONS)[number];

/**
 * 只读的 issue 工具名（与 `packages/contract/src/issue-tools.ts` 的 read 组逐字一致）。
 *
 * 为什么在契约里再写一遍而不是 import contract：两个包都是叶子包、互不依赖
 * （`packages/*` 不得互相 import 以免成环）。等值性由能同时 import 两个包的测试盯住
 * （`apps/server/test/skills-prompt.test.ts`）。
 */
export const ISSUE_READ_TOOL_NAMES = [
  'IssueGet',
  'IssueList',
  'IssueCommentsList',
  'IssueTimeline',
  'IssueSearch',
] as const;

export type IssueReadToolName = (typeof ISSUE_READ_TOOL_NAMES)[number];

/** 单份产出里最多几条只读调用（与工具轮预算同源：一轮 6 次，够查「评论 + 相似 issue」）。 */
export const MAX_TOOL_CALLS_PER_OUTPUT = 6;

/**
 * 一条只读调用。
 *
 * `input` 故意是开放对象而不是逐工具的联合：读工具的参数还在长（cursor / limit / labels…），
 * 写死 schema 会让「参数多给一个」变成整份产出被拒 —— 而这里的失败代价不对等：
 * 参数错了执行器会回一条结构化错误给模型，模型下一轮就能改；整份拒绝则要白跑一轮。
 * 真正的参数校验在执行器（`runtime/issue-read-tools.ts`）里做，错误以 `bad-input` 回给模型。
 */
export const issueToolCallSchema = z.strictObject({
  name: z.enum(ISSUE_READ_TOOL_NAMES),
  input: z.record(z.string(), z.unknown()),
});

/**
 * GitHub 的 8 种 reaction content。
 *
 * 与 `apps/server/src/github/types.ts` 的同名常量逐字一致（那里是**执行面**的窄接口，
 * 这里是**产出面**的封闭枚举）。刻意重复而不互相 import：`packages/` 是叶子包，
 * 不得 import `apps/*`（eslint `import-x/no-restricted-paths` 硬约束）。
 */
export const REACTION_CONTENTS = [
  '+1',
  '-1',
  'laugh',
  'confused',
  'heart',
  'hooray',
  'rocket',
  'eyes',
] as const;

export type ReactionContentV21 = (typeof REACTION_CONTENTS)[number];

/** 单份产出的动作上限（§4：与 `.github/pi-bot.yml` 的 `limits.max_actions_per_run` 取小）。 */
export const MAX_OUTPUT_ACTIONS = 20;

/** 一次 `label` 动作最多声明多少个目标标签（§5 的 `max_per_issue` 是仓库配置，这里是硬上限）。 */
export const MAX_DESIRED_LABELS = 32;

/** 单个标签名的长度上下界（GitHub 是 50）。 */
export const MAX_LABEL_NAME = 50;

/**
 * 评论正文上限：与旧契约同一个数字（`schema.ts` 的 `MAX_COMMENT_BODY`）。
 *
 * 名字带 `V21` 是因为 `index.ts` 用 `export *` 同时转出两份契约：同名常量会让
 * 该名字变成「歧义导出」（TS 直接报重复导出），所以此处必须与旧契约区分开。
 */
export const MAX_V21_COMMENT_BODY = 60_000;

/** 槽位名规则（`docs/v21-contract.md` §5：槽位键 = `(repo, issue, slot)`）。 */
export const SLOT_PATTERN = '^[a-z0-9][a-z0-9._-]{0,63}$';

/** 分支名规则：只到 `bot/*`（§5 的 `open_pr`；与旧契约 `BRANCH_RE` 同一个正则）。 */
export const BOT_BRANCH_PATTERN = '^bot/[a-z0-9][a-z0-9._-]{1,60}$';

/** 指纹形状（§5 的 `create_issue` 去重键；与旧契约 `FINGERPRINT_RE` 同一个正则）。 */
export const FINGERPRINT_PATTERN = '^[a-z0-9][a-z0-9:._-]{2,63}$';

/* ── 1. 基础 schema 片段 ─────────────────────────────────────────────────── */

/** 标签名：1..50，禁止控制字符（允许中文与空格，标签名最终要进评论与 URL）。 */
const labelName = z
  .string()
  .min(1)
  .max(MAX_LABEL_NAME)
  .regex(/^[^\u0000-\u001f\u007f]+$/u, '标签名不得包含控制字符');

/** 判定依据/理由的一条文本（进 `run_events` 与面板详情，所以有长度上界）。 */
const evidenceItem = z.string().min(1).max(2000);

const evidenceList = z.array(evidenceItem).max(32);

const verdictValue = z.enum(['pass', 'fail']);

/** 槽位名（`^[a-z0-9][a-z0-9._-]{0,63}$`）：小写字母/数字开头，最长 64。 */
const slotName = z.string().regex(new RegExp(SLOT_PATTERN), `槽位名必须匹配 ${SLOT_PATTERN}`);

const branchName = z
  .string()
  .regex(new RegExp(BOT_BRANCH_PATTERN), `分支名必须匹配 ${BOT_BRANCH_PATTERN}（只允许 bot/*）`);

/* ── 2. 七类动作 ─────────────────────────────────────────────────────────── */

/**
 * `verdict`：给结论。它**不写任何东西**，存在的意义是让「只判定」的一轮产出
 * 有一个可审计的落点（面板按它渲染 ✔/✘），也让 `close_issue` 的 `verdict==='fail'`
 * 前置条件有一个显式的来源（§5）。
 */
export const verdictActionSchema = z.strictObject({
  type: z.literal('verdict'),
  payload: z.strictObject({
    verdict: verdictValue,
    evidence: evidenceList.optional(),
  }),
});

/**
 * `label`：目标态对齐（§5 第一行）。
 *
 * `desired` 是**完整的目标集合**而不是增量：执行侧要用 `current ∩ 可管理目录 - desired`
 * 算删除集，增量表达不出去。`clear` 是「允许清空」的显式许可——空集 + 没有它 = 拒绝，
 * 这是 BR-9 的空集保护（模型少写一个字段不该把 issue 的标签清空）。
 */
export const labelActionSchema = z.strictObject({
  type: z.literal('label'),
  payload: z.strictObject({
    desired: z.array(labelName).max(MAX_DESIRED_LABELS),
    clear: z.boolean().optional(),
  }),
});

/* ── v2.2 的目标标识：issue 号 / 评论 id / login ────────────────────────────── */

/** 目标 issue 号：正整数，上界防溢出（GitHub 的 issue number 是 int32 量级）。 */
const targetIssueNumber = z.number().int().positive().max(2_000_000_000);

/** 评论 id：GitHub 的 comment id 是 int64 量级，用安全整数上界。 */
const targetCommentId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** 指派人的 login 形状（最长 39，只允许字母数字与连字符 —— GitHub 的账号规则）。 */
const loginName = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/u, 'login 只允许字母、数字与连字符');

/**
 * `comment`：写进**槽位**（§5 第二行）。同 issue 同槽位只保留一条，
 * 所以 `slot` 是必填且必须稳定（发布说明、失败说明各占一个槽）。
 *
 * v2.2 的 `reply_to`（`IssueCommentReply`）：给的是**被回复评论的 id**。
 * 平台据此把原评论渲染成引用块并定向 `@` 作者 —— GitHub 的 issue 评论没有 thread，
 * 「回复」只能这样表达（`docs/plan-issue-tools.md` §2）。渲染在
 * `writeback/v21/markup.ts` 里做，进正文的只有渲染结果，`reply_to` 本身不落 GitHub。
 */
export const commentActionSchema = z.strictObject({
  type: z.literal('comment'),
  payload: z.strictObject({
    slot: slotName,
    body: z.string().min(1).max(MAX_V21_COMMENT_BODY),
    reply_to: targetCommentId.optional(),
  }),
});

/**
 * `reaction`：幂等的表情反馈（§5 第三行）。`op='remove'` 只删自己打的那条。
 *
 * v2.2 的 `target` / `comment_id`（`IssueReactionAdd` / `IssueReactionRemove`）：
 * 缺省打主贴，`target='comment'` 打某条评论。两个字段都可选，所以老产出继续合法；
 * 「`target='comment'` 却没给 `comment_id`」由 `semanticIssuesOf()` 判成整份拒绝。
 */
export const reactionActionSchema = z.strictObject({
  type: z.literal('reaction'),
  payload: z.strictObject({
    op: z.enum(['add', 'remove']),
    content: z.enum(REACTION_CONTENTS),
    target: z.enum(REACTION_TARGETS).optional(),
    comment_id: targetCommentId.optional(),
  }),
});

/** `create_issue`：新开 issue（§5 第四行）。`fingerprint` 可省 —— 省了就没有去重保护。 */
export const createIssueActionSchema = z.strictObject({
  type: z.literal('create_issue'),
  payload: z.strictObject({
    title: z.string().min(1).max(120),
    body: z.string().max(20_000).optional(),
    labels: z.array(labelName).max(10).optional(),
    fingerprint: z
      .string()
      .regex(new RegExp(FINGERPRINT_PATTERN), `指纹必须匹配 ${FINGERPRINT_PATTERN}`)
      .optional(),
  }),
});

/** `open_pr`：开 PR（§5 第五行）。分支只允许 `bot/*`；不提供 force push 的任何入口。 */
export const openPrActionSchema = z.strictObject({
  type: z.literal('open_pr'),
  payload: z.strictObject({
    branch: branchName,
    title: z.string().min(1).max(120),
    body: z.string().max(20_000).optional(),
  }),
});

/**
 * `close_issue`：关 issue（§5 第六行）。`state_reason` 缺省 `not_planned`（v2.0 的固定值）。
 *
 * v2.2 起支持 GitHub 原生的关闭理由与「重复」（`IssueClose`）：
 *  - `state_reason='duplicate'` **必须**同时给 `duplicate_of`（原 issue 号），
 *    否则等于关了一个没有指向的单 —— 由 `semanticIssuesOf()` 拒绝；
 *  - `comment` 是「关闭时附带的一句话」，执行侧把它写进 `close` 槽位，
 *    与 `comment` 动作共用槽位语义（省掉一条会随触发次数增长的散评论）。
 *
 * 仍然只在顶层 `verdict='fail'` 时允许执行（§5 第六行：不采信模型自评）。
 */
export const closeIssueActionSchema = z.strictObject({
  type: z.literal('close_issue'),
  payload: z.strictObject({
    state_reason: z.enum(CLOSE_STATE_REASONS).optional(),
    duplicate_of: targetIssueNumber.optional(),
    comment: z.string().min(1).max(MAX_V21_COMMENT_BODY).optional(),
  }),
});

/** `reopen_issue`：重新打开（`IssueReopen`，v2.2）。无参数 —— 目标由执行上下文决定。 */
export const reopenIssueActionSchema = z.strictObject({
  type: z.literal('reopen_issue'),
  payload: z.strictObject({}),
});

/**
 * `update_issue`：改标题 / 正文 / 指派人 / 里程碑（`IssueUpdate`，v2.2）。
 *
 * `expected_updated_at` 是**乐观锁**：issue 的 PATCH 没有 `If-Match`，两个人同时改正文
 * 是静默覆盖。执行侧拿到它就先读一次 `updated_at` 比对，不一致整份失败
 * （`update-conflict`），让模型重读再决定 —— 这是 GitHub 上唯一可行的并发检测手段。
 * 不给就等于「我知道可能覆盖，认了」（v2.0 的行为）。
 */
export const updateIssueActionSchema = z.strictObject({
  type: z.literal('update_issue'),
  payload: z.strictObject({
    title: z.string().min(1).max(120).optional(),
    body: z.string().max(MAX_V21_COMMENT_BODY).optional(),
    assignees: z.array(loginName).max(10).optional(),
    /** `null` = 清空里程碑（GitHub 的 PATCH 用 `milestone: null` 表达）。 */
    milestone: z.number().int().positive().max(2_000_000_000).nullable().optional(),
    expected_updated_at: z.string().min(1).max(64).optional(),
  }),
});

/**
 * `update_comment` / `delete_comment`：改 / 删**我们自己写过**的评论
 * （`IssueCommentUpdate` / `IssueCommentDelete`，v2.2）。
 *
 * 为什么单独成动作而不是给 `comment` 加字段：`comment` 是槽位覆盖（正文由平台重拼、
 * 标记由平台追加），而这两个动作作用于**已有评论**，语义是「改那条」而不是「写这个槽」。
 * 合成一个会让「槽位」与「评论 id」两种寻址方式在同一 payload 里互斥，模型必然写错。
 */
export const updateCommentActionSchema = z.strictObject({
  type: z.literal('update_comment'),
  payload: z.strictObject({
    comment_id: targetCommentId,
    body: z.string().min(1).max(MAX_V21_COMMENT_BODY),
  }),
});

export const deleteCommentActionSchema = z.strictObject({
  type: z.literal('delete_comment'),
  payload: z.strictObject({ comment_id: targetCommentId }),
});

/**
 * `link`：与另一个 issue / PR 的结构关系（`IssueLink`，v2.2）。
 *
 * `duplicate` **等价于关单**，因此受 `agent.actions.close_issue` 开关约束
 * （`gatedActionOf()`）；其余 relation 是纯关联，不受开关约束。
 */
export const linkActionSchema = z.strictObject({
  type: z.literal('link'),
  payload: z.strictObject({
    relation: z.enum(LINK_RELATIONS),
    target_number: targetIssueNumber,
  }),
});

/** 全部动作的判别联合（`type` 是判别键；前七类 + v2.2 的五类）。 */
export const outputActionSchema = z.discriminatedUnion('type', [
  verdictActionSchema,
  labelActionSchema,
  commentActionSchema,
  reactionActionSchema,
  createIssueActionSchema,
  openPrActionSchema,
  closeIssueActionSchema,
  reopenIssueActionSchema,
  updateIssueActionSchema,
  updateCommentActionSchema,
  deleteCommentActionSchema,
  linkActionSchema,
]);

/**
 * 整份产出。`additionalProperties: false`（zod 的 `strictObject`）：
 * 多出来的顶层键同样拒绝 —— 那通常是模型在自创「meta」之类的旁路字段。
 */
export const outputV21Schema = z.strictObject({
  /** 纯问答可省；有 `close_issue` 动作时必须为 `'fail'`（执行侧判，不在这里）。 */
  verdict: verdictValue.optional(),
  evidence: evidenceList.optional(),
  actions: z.array(outputActionSchema).max(MAX_OUTPUT_ACTIONS),
  /**
   * v2.3 的只读调用（`docs/plan-issue-tools.md` §3 B 的「只读工具轮」）。
   *
   * 语义是**中间轮**：有它就一定没有 `actions`，也不许给 `verdict`（由 `semanticIssuesOf()` 强制）。
   * 两条理由：
   *  - 写只发生在最终轮 —— 否则模型第一轮就能发评论，绕过「这是最终结论」这层判断；
   *  - 结论只出现在看过数据之后 —— 允许同一轮既给 pass/fail 又要读数据，
   *    等于允许它先下结论再找证据。
   */
  tool_calls: z.array(issueToolCallSchema).max(MAX_TOOL_CALLS_PER_OUTPUT).optional(),
});

/* ── 3. 类型（从 schema 反推，保证「类型 = 校验」永远同步）────────────────── */

export type OutputV21 = z.infer<typeof outputV21Schema>;
export type OutputV21Action = OutputV21['actions'][number];

/** 每一类动作的窄类型（执行器的 `switch` 分支用得上）。 */
export type VerdictActionV21 = Extract<OutputV21Action, { type: 'verdict' }>;
export type LabelActionV21 = Extract<OutputV21Action, { type: 'label' }>;
export type CommentActionV21 = Extract<OutputV21Action, { type: 'comment' }>;
export type ReactionActionV21 = Extract<OutputV21Action, { type: 'reaction' }>;
export type CreateIssueActionV21 = Extract<OutputV21Action, { type: 'create_issue' }>;
export type OpenPrActionV21 = Extract<OutputV21Action, { type: 'open_pr' }>;
export type CloseIssueActionV21 = Extract<OutputV21Action, { type: 'close_issue' }>;
export type ReopenIssueActionV21 = Extract<OutputV21Action, { type: 'reopen_issue' }>;
export type UpdateIssueActionV21 = Extract<OutputV21Action, { type: 'update_issue' }>;
export type UpdateCommentActionV21 = Extract<OutputV21Action, { type: 'update_comment' }>;
export type DeleteCommentActionV21 = Extract<OutputV21Action, { type: 'delete_comment' }>;
export type LinkActionV21 = Extract<OutputV21Action, { type: 'link' }>;
/** 一条只读调用（v2.3；`output.tool_calls` 的元素类型）。 */
export type IssueToolCallV21 = z.infer<typeof issueToolCallSchema>;

/* ── 4. 校验器 ───────────────────────────────────────────────────────────── */

/** 一条错误（路径是 JSON Pointer 风格，例如 `/actions/0/payload/slot`）。 */
export type OutputV21Issue = {
  readonly path: string;
  readonly message: string;
};

export type OutputV21Validation =
  | { readonly ok: true; readonly output: OutputV21 }
  | { readonly ok: false; readonly errors: readonly OutputV21Issue[] };

/** 是不是 `OUTPUT_ACTION_TYPES` 里的一类（导出给执行侧做「运行期再确认一次」用）。 */
export function isOutputActionType(value: unknown): value is OutputActionType {
  return typeof value === 'string' && (OUTPUT_ACTION_TYPES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * zod 的 issue.path → JSON Pointer。
 *
 * 空路径（整份不是对象）落成 `/`，与 `validate.ts::toPath()` 同一个约定，
 * 面板不必为两份契约写两套路径渲染。
 */
function toPointer(path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return '/';
  }
  return `/${path.map((segment) => String(segment)).join('/')}`;
}

/**
 * 判别键的**前置**检查。
 *
 * 为什么要单独做一遍：`z.discriminatedUnion` 在判别键非法时只能把错误落在
 * 「联合体所在位置」（`/actions/0`），报错文案是 `Invalid input`，面板读不出
 * 「是 `type` 写错了」还是「缺了 `payload`」。§4 校验第 1、2 条要求错误**定位到字段路径**，
 * 所以这里先用 20 行把「type 缺失/未知」判成 `/actions/0/type`，命中了就整份拒绝，
 * 剩下的形状问题才交给 zod（那时判别键已经合法，zod 的路径是精确的）。
 */
function preflightDiscriminator(value: unknown): OutputV21Issue[] {
  if (!isRecord(value)) {
    return [];
  }
  const rawActions = value['actions'];
  if (!Array.isArray(rawActions)) {
    return [];
  }
  const issues: OutputV21Issue[] = [];
  rawActions.forEach((raw, index) => {
    const at = `/actions/${String(index)}`;
    if (!isRecord(raw)) {
      issues.push({ path: at, message: '动作必须是对象' });
      return;
    }
    const type = raw['type'];
    if (!isOutputActionType(type)) {
      issues.push({
        path: `${at}/type`,
        message: `动作类型必须是 ${OUTPUT_ACTION_TYPES.join(' / ')} 之一（收到 ${JSON.stringify(type)}）`,
      });
    }
  });
  return issues;
}

/**
 * 形状合法之后的**语义交叉校验**（同样整份拒绝，路径精确到字段）。
 *
 * 为什么不用 zod 的 `superRefine`：判别联合的成员一旦是 refinement，`discriminatedUnion`
 * 的类型收窄就会失效（`action.payload` 退化成 `unknown`），执行器的 `switch` 也就拿不到
 * 字段类型 —— 而这里的校验本来就是跨字段的，放在「已解析成类型」之后反而更清楚。
 *
 * 三条规则都对应一次真实的失败：给了 `target='comment'` 却没有 `comment_id`（打不出去）、
 * 关单理由是 `duplicate` 却没有原 issue（关了一个没有指向的单）、
 * `update_issue` 一个字段都没给（一次什么都不改的 PATCH）。
 */
export function semanticIssuesOf(output: OutputV21): OutputV21Issue[] {
  const issues: OutputV21Issue[] = [];

  /*
    工具轮的两条不变量（§3 B 的「中间轮禁写」）。它们必须在契约层就成立，
    不能只靠编排层「看见 tool_calls 就跳过写回」：
     - 有 tool_calls ⇒ 没有 actions：否则模型第一轮就能发评论，绕开「最终结论」这层判断；
     - 有 tool_calls ⇒ 没有 verdict：否则它会先给结论再找证据。
  */
  const calls = output.tool_calls ?? [];
  if (calls.length > 0) {
    if (output.actions.length > 0) {
      issues.push({
        path: '/actions',
        message: '含 tool_calls 的产出不许带 actions：工具轮只读，写只发生在最终轮',
      });
    }
    if (output.verdict !== undefined) {
      issues.push({
        path: '/verdict',
        message: '含 tool_calls 的产出不许给 verdict：结论留给看过数据的最终轮',
      });
    }
  }
  output.actions.forEach((action, index) => {
    const at = `/actions/${String(index)}/payload`;
    switch (action.type) {
      case 'reaction': {
        if (action.payload.target === 'comment' && action.payload.comment_id === undefined) {
          issues.push({
            path: `${at}/comment_id`,
            message: 'target=comment 时必须给 comment_id（说明贴哪条评论）',
          });
        }
        break;
      }
      case 'close_issue': {
        if (action.payload.state_reason === 'duplicate' && action.payload.duplicate_of === undefined) {
          issues.push({
            path: `${at}/duplicate_of`,
            message: 'state_reason=duplicate 时必须给 duplicate_of（原 issue 的编号）',
          });
        }
        break;
      }
      case 'update_issue': {
        const payload = action.payload;
        if (
          payload.title === undefined &&
          payload.body === undefined &&
          payload.assignees === undefined &&
          payload.milestone === undefined
        ) {
          issues.push({
            path: at,
            message: '至少给一个要改的字段（title / body / assignees / milestone）',
          });
        }
        break;
      }
      default:
        break;
    }
  });
  return issues;
}

/**
 * 校验一份已解析的产出。
 *
 * 语义是**整份判定**：`ok: false` 时调用方一条动作都不能执行（§4 校验第 1、2 条）。
 * 顺序是「判别键 → 形状 → 语义交叉」：前两步的错误更基础，先报出来才不会被
 * 一堆 `Invalid input` 淹掉。
 */
export function validateOutputV21(value: unknown): OutputV21Validation {
  const preflight = preflightDiscriminator(value);
  if (preflight.length > 0) {
    return { ok: false, errors: preflight };
  }

  const parsed = outputV21Schema.safeParse(value);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => ({
      path: toPointer(issue.path),
      message: issue.message,
    }));
    return { ok: false, errors: errors.length > 0 ? errors : [{ path: '/', message: '产出不符合 v2 契约' }] };
  }

  const semantic = semanticIssuesOf(parsed.data);
  if (semantic.length > 0) {
    return { ok: false, errors: semantic };
  }
  return { ok: true, output: parsed.data };
}

/**
 * 校验一段 JSON 文本（agent 的原始产出）。
 *
 * JSON 语法错误与形状不合规走同一个返回形状：调用方只关心「能不能执行」。
 * 语法错误的路径固定是 `/`（没有字段可指）。
 */
export function parseOutputV21Json(text: string): OutputV21Validation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      errors: [
        { path: '/', message: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` },
      ],
    };
  }
  return validateOutputV21(parsed);
}

/** 把错误压成一行（日志与告警文案用；面板详情读的是完整数组）。 */
export function summarizeOutputV21Issues(issues: readonly OutputV21Issue[]): string {
  const head = issues.slice(0, 3).map((issue) => `${issue.path} ${issue.message}`);
  const rest = issues.length > 3 ? ` …（共 ${String(issues.length)} 条）` : '';
  return head.join('; ') + rest;
}
