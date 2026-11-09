/**
 * 任务信封契约（plan §5 + tech-plan §5.6 的补充）。
 *
 * 信封是 agent 交给控制面的**唯一**结构化产出：agent 拿不到 GitHub 凭证，
 * 动作由控制面校验后执行，字段不合规的动作直接丢弃并记 `parse` 失败。
 *
 * 为什么这里手写 JSON Schema 而不是从 zod 生成：信封的校验面在 **Ajv**（tech-plan §2.1），
 * 且同一份 schema 要能被 vendored 的 `racp.schema.json` 之外的消费方（测试、文档、面板详情页）
 * 当作纯数据读取。手写一份 + 3 正例 3 反例单测，比再引一个 zod→JSON Schema 依赖更省。
 * （仓库配置与技能 frontmatter 走 zod，因为它们的消费方是后端校验代码，不是数据。）
 *
 * 相对 plan §5 的两处补充：
 * 1. `push_branch` **必须**带 `paths: string[]`（tech-plan §5.6：声明 ∩ 实际才是推送集）。
 * 2. `verdict.evidence[]` 允许可选的 `passed: boolean`（plan §6.2 要 pass/fail 判定）。
 *    可选而非必填，所以 plan §5 的原样示例仍然合法。
 */
import type { ACTION_INTENTS } from './actions.ts';

/** 信封里的动作 intent（只有 plan §5 那 4 类）。 */
export type EnvelopeActionIntent = (typeof ACTION_INTENTS)[number];

export interface VerdictEvidence {
  rule: string;
  quote: string;
  passed?: boolean;
}

export interface Verdict {
  kind: 'issue' | 'pr';
  labels: string[];
  evidence: VerdictEvidence[];
}

export interface CommentAction {
  intent: 'comment';
  body: string;
}

export interface LabelAction {
  intent: 'label';
  add?: string[];
  remove?: string[];
}

export interface CreateIssueAction {
  intent: 'create_issue';
  title: string;
  fingerprint: string;
  body?: string;
}

export interface PushBranchAction {
  intent: 'push_branch';
  branch: string;
  /** 相对仓库根的显式路径或 glob；服务端展开后固定（tech-plan §5.6）。 */
  paths: string[];
  /** 推完分支后是否开 PR。默认 false。 */
  openPr?: boolean;
}

export type EnvelopeAction = CommentAction | LabelAction | CreateIssueAction | PushBranchAction;

export interface EnvelopeUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface TaskEnvelope {
  verdict: Verdict;
  actions: EnvelopeAction[];
  usage: EnvelopeUsage;
}

/** 分支名规则：只到 `bot/*`（plan §7「永不强推，永不改写贡献者分支」）。 */
export const BRANCH_RE = '^bot/[a-z0-9][a-z0-9._-]{1,60}$';

/** 去重键的指纹形状（plan §6.3 的 `(repo, fingerprint)`）。 */
export const FINGERPRINT_RE = '^[a-z0-9][a-z0-9:._-]{2,63}$';

/** 单条评论正文上限（GitHub 是 65536，这里留余量并按 8 字节/字符的保守估计）。 */
export const MAX_COMMENT_BODY = 60_000;

/** 单封信封最多几个动作（与 `.github/pi-bot.yml` 的 `limits.max_actions_per_run` 取小）。 */
export const MAX_ACTIONS = 8;

const labelSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 50,
  // 禁止控制字符（允许中文与空格）：标签名最终要进评论与 URL。
  pattern: '^[^\\u0000-\\u001f\\u007f]+$',
} as const;

/** 信封的 JSON Schema（draft 2020-12）。 */
export const ENVELOPE_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://pi-issue-bot.local/schemas/envelope-1.json',
  title: 'TaskEnvelope',
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'actions', 'usage'],
  properties: {
    verdict: { $ref: '#/$defs/verdict' },
    actions: { type: 'array', maxItems: MAX_ACTIONS, items: { $ref: '#/$defs/action' } },
    usage: { $ref: '#/$defs/usage' },
  },
  $defs: {
    verdict: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'labels', 'evidence'],
      properties: {
        kind: { enum: ['issue', 'pr'] },
        labels: { type: 'array', maxItems: 16, items: { $ref: '#/$defs/label' } },
        evidence: { type: 'array', maxItems: 32, items: { $ref: '#/$defs/evidence' } },
      },
    },
    label: labelSchema,
    evidence: {
      type: 'object',
      additionalProperties: false,
      required: ['rule', 'quote'],
      properties: {
        rule: { type: 'string', minLength: 1, maxLength: 120 },
        quote: { type: 'string', minLength: 1, maxLength: 2000 },
        passed: { type: 'boolean' },
      },
    },
    action: {
      type: 'object',
      // 四种动作各自封闭字段集：多一个字段就是模型在自创动作形状，直接不合规。
      oneOf: [
        { $ref: '#/$defs/commentAction' },
        { $ref: '#/$defs/labelAction' },
        { $ref: '#/$defs/createIssueAction' },
        { $ref: '#/$defs/pushBranchAction' },
      ],
    },
    commentAction: {
      type: 'object',
      additionalProperties: false,
      required: ['intent', 'body'],
      properties: {
        intent: { const: 'comment' },
        body: { type: 'string', minLength: 1, maxLength: MAX_COMMENT_BODY },
      },
    },
    labelAction: {
      type: 'object',
      additionalProperties: false,
      required: ['intent'],
      // 至少要有一侧：`intent` + `add`/`remove` 至少一个键（额外字段被 additionalProperties:false 挡住）。
      // 用 minProperties 而不是 anyOf(required)：Ajv 的 strictRequired 不接受「子 schema 里 required 未定义」。
      minProperties: 2,
      properties: {
        intent: { const: 'label' },
        add: { type: 'array', maxItems: 10, items: { $ref: '#/$defs/label' } },
        remove: { type: 'array', maxItems: 10, items: { $ref: '#/$defs/label' } },
      },
    },
    createIssueAction: {
      type: 'object',
      additionalProperties: false,
      required: ['intent', 'title', 'fingerprint'],
      properties: {
        intent: { const: 'create_issue' },
        title: { type: 'string', minLength: 1, maxLength: 120 },
        fingerprint: { type: 'string', pattern: FINGERPRINT_RE },
        body: { type: 'string', maxLength: 20_000 },
      },
    },
    pushBranchAction: {
      type: 'object',
      additionalProperties: false,
      // `paths` 是 tech-plan §5.6 的补充：缺了它，写回闸门就没有「声明集」，
      // 该动作判为不合规并在过滤阶段被丢弃（reason = missing-paths）。
      required: ['intent', 'branch', 'paths'],
      properties: {
        intent: { const: 'push_branch' },
        branch: { type: 'string', pattern: BRANCH_RE },
        paths: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'string',
            minLength: 1,
            maxLength: 400,
            // 仓库相对路径：不许绝对路径、不许 `..` 出仓。
            pattern: '^(?!/)(?!.*(^|/)\\.\\.(/|$)).+$',
          },
        },
        openPr: { type: 'boolean' },
      },
    },
    usage: {
      type: 'object',
      additionalProperties: false,
      required: ['inputTokens', 'outputTokens', 'costUsd'],
      properties: {
        inputTokens: { type: 'integer', minimum: 0 },
        outputTokens: { type: 'integer', minimum: 0 },
        costUsd: { type: 'number', minimum: 0 },
      },
    },
  },
} as const;
