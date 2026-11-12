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

/** 七类动作（`docs/v21-contract.md` §4 的 `ActionV21`）。顺序即面板展示顺序。 */
export const OUTPUT_ACTION_TYPES = [
  'verdict',
  'label',
  'comment',
  'reaction',
  'create_issue',
  'open_pr',
  'close_issue',
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

/**
 * `comment`：写进**槽位**（§5 第二行）。同 issue 同槽位只保留一条，
 * 所以 `slot` 是必填且必须稳定（发布说明、失败说明各占一个槽）。
 */
export const commentActionSchema = z.strictObject({
  type: z.literal('comment'),
  payload: z.strictObject({
    slot: slotName,
    body: z.string().min(1).max(MAX_V21_COMMENT_BODY),
  }),
});

/** `reaction`：幂等的表情反馈（§5 第三行）。`op='remove'` 只删自己打的那条。 */
export const reactionActionSchema = z.strictObject({
  type: z.literal('reaction'),
  payload: z.strictObject({
    op: z.enum(['add', 'remove']),
    content: z.enum(REACTION_CONTENTS),
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
 * `close_issue`：关 issue（§5 第六行）。**没有参数**：关哪个 issue 由执行上下文决定，
 * 关的理由由执行侧固定（`not_planned`）。空对象写成 `strictObject({})`，
 * 多写一个字段就是模型在自创语义，按「形状不合规」整份拒绝。
 */
export const closeIssueActionSchema = z.strictObject({
  type: z.literal('close_issue'),
  payload: z.strictObject({}),
});

/** 七类动作的判别联合（`type` 是判别键）。 */
export const outputActionSchema = z.discriminatedUnion('type', [
  verdictActionSchema,
  labelActionSchema,
  commentActionSchema,
  reactionActionSchema,
  createIssueActionSchema,
  openPrActionSchema,
  closeIssueActionSchema,
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

/* ── 4. 校验器 ───────────────────────────────────────────────────────────── */

/** 一条错误（路径是 JSON Pointer 风格，例如 `/actions/0/payload/slot`）。 */
export type OutputV21Issue = {
  readonly path: string;
  readonly message: string;
};

export type OutputV21Validation =
  | { readonly ok: true; readonly output: OutputV21 }
  | { readonly ok: false; readonly errors: readonly OutputV21Issue[] };

/** 是不是七类之一（导出给执行侧做「运行期再确认一次」用）。 */
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
 * 校验一份已解析的产出。
 *
 * 语义是**整份判定**：`ok: false` 时调用方一条动作都不能执行（§4 校验第 1、2 条）。
 */
export function validateOutputV21(value: unknown): OutputV21Validation {
  const preflight = preflightDiscriminator(value);
  if (preflight.length > 0) {
    return { ok: false, errors: preflight };
  }

  const parsed = outputV21Schema.safeParse(value);
  if (parsed.success) {
    return { ok: true, output: parsed.data };
  }
  const errors = parsed.error.issues.map((issue) => ({
    path: toPointer(issue.path),
    message: issue.message,
  }));
  return { ok: false, errors: errors.length > 0 ? errors : [{ path: '/', message: '产出不符合 v2 契约' }] };
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
