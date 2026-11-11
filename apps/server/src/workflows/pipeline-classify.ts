/**
 * 阶段 1（标签分类）的**四分支收敛点**（`docs/plan-fixed-pipeline.md` §6 / §12 V5·V6·V7 / §1.8 Q6 修订）。
 *
 * ```
 * requirement ─┬ role=requirement 标签 + 评论（模型写） + @managers（一次） → agent/ready
 * defect ──────┤ 同上，category='defect'
 * not-found ───┼ **不打任何标签** + 评论（查不到 + 已查范围 + 需要什么） + @managers
 *              └ → classify/awaiting_info（等管理员，info_requested_at=NULL，不进 48h 扫描）
 * other ───────┴ role=other 标签（可空），**无评论、无 @** → agent/ready
 * ```
 *
 * 拆分理由与阶段 0（`pipeline-format.ts`）完全同构，不重复解释：
 *  - `planClassifyOutcome()` **纯函数**（时钟、频率计数都从参数来），四分支的动作集合可逐条断言
 *    —— 标签集合、评论条数、`@` 追加几次、状态行写了哪些列；
 *  - `executeClassifyPlan()` 才碰 IO（GitHub 写面 / `issue_pipeline`），单测注入假实现即可复现 V5/V6/V7。
 *
 * 三条纪律（每一条都能被单测钉住，改动前先读）：
 *  1. **`@` 是单槽**：`mention_sent_at` 非空 → 整个 issue 永不再补 `@`（D4 / §6「重分类不补 @」）；
 *     名单只取 `settings.pipeline.managers`，**模型输出不参与 mention**（防乱 @ 人）；
 *  2. **`not-found` 不打缺陷标签**（D3）：模型说「这是缺陷但没有 `path:line`」时
 *     `readStageResult()` 已把它降级成 `not-found`，这里照 not-found 走并留一条 warn；
 *  3. **状态先落、评论后发**：重投同版本时靠状态机挡住第二条评论，而不是靠「有没有发过」；
 *  4. **`@` 单槽最后落**（且只在评论真的发出去之后）：评论失败不写 `mention_sent_at`，
 *     否则这个 issue 会被一条根本没发出去的评论永久锁死 `@`（`mentionSlot` 就是为此单列的）。
 */
import { MAX_COMMENT_BODY } from '../../../../packages/envelope/src/schema.ts';
import type { VerdictEvidence } from '../../../../packages/envelope/src/index.ts';
import { PIPELINE_CATEGORIES } from '../../../../packages/contract/src/index.ts';
import type { PipelineCategory, RepoSettings } from '../../../../packages/contract/src/index.ts';
import type { Logger } from '../../../../packages/shared/src/index.ts';
import { appendMentions, managerMentions } from './pipeline-directives.ts';
import { pipelineLabelPlan } from './pipeline-labels.ts';
import { applyTransition, decideTransition } from './pipeline.ts';
import type {
  PipelineKey,
  PipelineQueryable,
  PipelineRow,
  PipelineTransition,
} from './pipeline.ts';
import { readStageResult } from './stage-result.ts';

/* ── 兜底文案（Q8 唯一例外：故障兜底，不做服务端模板渲染）────────────────────── */

/**
 * requirement / defect 但模型没写评论时的控制面兜底。
 *
 * §6 要求这两类**必须有评论**（初步分析 / 缺陷报告）；模型漏写时用这句最小安全常量，
 * 并记一条 warn —— 与阶段 0 的 `FORMAT_*_FALLBACK` 同一条纪律（只在故障时生效）。
 */
export const CLASSIFY_COMMENT_FALLBACK = '已完成初步分类，后续会按固定流程继续处理。';

/**
 * `not-found` 但模型没写评论时的兜底（§6：必须说明「查不到 + 需要什么」并 `@managers`）。
 *
 * 这一条比上面那句更硬：停在 `classify/awaiting_info` 等管理员时，
 * 如果评论里什么都没有，管理员根本不知道该回什么。
 */
export const CLASSIFY_NOT_FOUND_FALLBACK =
  '当前无法完成分类：按现有信息查不到足够的证据。请补充复现步骤、相关文件与行号、期望结果；管理员会跟进确认。';

/** 阶段 1 任务的命令名（`pipeline:classify`）；别的命令不该调这里。 */
export const CLASSIFY_STAGE_COMMAND = 'pipeline:classify';

/** 「已查范围」在评论里的标题（模型已写这一段时不再补）。 */
export const CHECKED_SCOPE_HEADING = '已查范围';

/** 超长时的收尾标记（可见，且不会被误认为模型原文）。 */
export const COMMENT_TRUNCATED_MARK = '…（评论已按上限截断）';

/* ── 动作 ─────────────────────────────────────────────────────────────────── */

/** 一条待执行动作。执行顺序 = 数组顺序（见 `executeClassifyPlan()`）。 */
export type ClassifyAction =
  | {
      readonly kind: 'comment';
      readonly body: string;
      /** `model` = 模型写的；`fallback` = 控制面兜底句（一定伴随一条 warn）。 */
      readonly source: 'model' | 'fallback';
    }
  | { readonly kind: 'label'; readonly labels: readonly string[] };

/** 四分支 + 两种「不做事」的结论。 */
export type ClassifyOutcome =
  /** 需求：标签 + 评论 + `@` → `agent/ready`（V5） */
  | 'requirement'
  /** 缺陷（有 `path:line` 证据）：标签 + 评论 + `@` → `agent/ready`（V6 前半） */
  | 'defect'
  /** 虚拟缺陷 / 未知分类：不标签 + 评论 + `@` → `classify/awaiting_info`（V6 后半 / Q6 修订） */
  | 'not-found'
  /** 其他：只标签 → `agent/ready`（V7） */
  | 'other'
  /** 运行失败 / 信封不合法**连续 2 次**：零写入 + `blocked` */
  | 'blocked'
  /** 这一轮什么都不该做（重投、状态已不在 `classify/pending|running`、没有流水线行…） */
  | 'noop';

export interface ClassifyPlan {
  readonly outcome: ClassifyOutcome;
  /** 落库的 `category`（`blocked` / `noop` 时为 `null`）。 */
  readonly category: PipelineCategory | null;
  /** 要执行的动作（顺序即执行顺序）。 */
  readonly actions: readonly ClassifyAction[];
  /**
   * 要落的转移（`applyTransition()` 的入参）。
   * `null` = 这一轮不动状态行；带 `ignore` 时 `applyTransition()` 会自动跳过写库。
   *
   * **不含 `@` 单槽**（`mention_sent_at` / `mention_category`）：那两列由 `mentionSlot`
   * 单独落，且必须等评论**发出去之后**才落（见 `executeClassifyPlan()`）。
   */
  readonly transition: PipelineTransition | null;
  /**
   * `@` 单槽的记账（`mention_sent_at` / `mention_category`），`null` = 本轮没把 `@` 写进评论。
   *
   * 为什么要与 `transition` 分开：单槽是「已经 @ 过人了」这个**已发生事实**的记录，
   * 而评论是之后才 POST 的。两者合在一个 UPDATE 里落库的话，评论失败（限流 / 权限）
   * 会让这一列永久写死 —— 那个 issue 以后**再也不会 @ 任何人**（单槽永不复位）。
   */
  readonly mentionSlot: PipelineTransition | null;
  /** 这一轮要不要在评论末尾追加 `@managers`（单槽：`mention_sent_at` 非空时恒 `applied:false`）。 */
  readonly mention: { readonly logins: readonly string[]; readonly applied: boolean } | null;
  /** 人读的留痕（日志 / 面板）：用了哪句兜底、为什么不发评论… */
  readonly notes: readonly string[];
}

export type ClassifyPlanLogger = Pick<Logger, 'warn'>;

export interface ClassifyPlanInput {
  readonly repo: string;
  readonly issueNumber: number;
  /** 当前流水线行；`null` = 没有行（不该有分类任务，按 noop 处理并留痕）。 */
  readonly pipeline: PipelineRow | null;
  /** worker 交出的信封（`PreparedEnvelope.envelope`）；运行失败 / 不合法 → `null`。 */
  readonly envelope: unknown;
  /** 信封是否通过 Ajv 校验（`false` 时 `envelope` 也可能是 `null`）。 */
  readonly envelopeValid: boolean;
  /** 本次 run 的结局（`worker/types.ts::RunOutcome`）。只有 `succeeded` 才算「跑完了」。 */
  readonly runOutcome: string;
  /**
   * 连续运行失败次数（含本次），由调用方按任务的尝试次数推：`tasks.attempt + 1`。
   * `>= 2` → `blocked`（§2「运行失败 / 信封不合法连续 2 次」）。
   */
  readonly consecutiveFailures?: number;
  readonly command: string;
  /**
   * 仓库配置：`labels`（role → 标签名）、`pipeline.managers`（`@` 名单）、
   * `limits.max_comments_per_hour`（频率上限）。`null` = 读不出来，照样跑（只是不打标、不 @）。
   */
  readonly settings?: Pick<RepoSettings, 'labels' | 'limits' | 'pipeline'> | null;
  /** 人撤下过的标签（`bot_labels`，走 `normalizeDesired` 的人工否决）。 */
  readonly humanVetoed?: readonly string[];
  /**
   * 本 issue **最近一小时**已经发出去的评论条数（频率上限的判据，§13「自由评论跑题/超长」）。
   * 计数由调用方提供（表里没有一列能直接算）；缺省 0 = 不限速。
   */
  readonly commentsLastHour?: number;
  /** 事件时刻（纯函数：不读时钟）。 */
  readonly at: Date;
  readonly logger?: ClassifyPlanLogger;
}

/* ── 小工具 ───────────────────────────────────────────────────────────────── */

/** 信封结论 → `PipelineCategory`（`readStageResult` 已按阶段校验过，这里只是类型收窄）。 */
function toCategory(value: string): PipelineCategory | null {
  return (PIPELINE_CATEGORIES as readonly string[]).includes(value)
    ? (value as PipelineCategory)
    : null;
}

/** 把正文压到 `MAX_COMMENT_BODY` 以内（超长才加标记）。 */
export function clampCommentBody(body: string, limit: number = MAX_COMMENT_BODY): string {
  if (body.length <= limit) {
    return body;
  }
  const keep = Math.max(0, limit - COMMENT_TRUNCATED_MARK.length);
  return `${body.slice(0, keep)}${COMMENT_TRUNCATED_MARK}`;
}

/**
 * 「已查范围」段落（§6：查不到时必须写清查了哪儿，否则「查不到」是一句无法验证的话）。
 *
 * 模型自己写了「已查范围」就**不再补**（Q8：评论一律 AI 撰写，控制面只在漏写时补一段）。
 * 没有 `checked:` 证据时也返回空串：控制面不凭空编造「查了哪儿」。
 */
export function checkedScopeSection(body: string, scope: readonly VerdictEvidence[]): string {
  if (scope.length === 0 || body.includes(CHECKED_SCOPE_HEADING)) {
    return '';
  }
  const lines = scope.map((item) => `- ${item.quote}`.trimEnd());
  return `${CHECKED_SCOPE_HEADING}：\n${lines.join('\n')}`;
}

/** 评论 = 正文 + （已查范围）+ （`@managers`），超长时先丢「已查范围」再截断正文。 */
function composeComment(input: {
  readonly core: string;
  readonly scope: readonly VerdictEvidence[];
  readonly mentions: readonly string[];
  readonly notes: string[];
}): string {
  const scopeSection = checkedScopeSection(input.core, input.scope);
  const withScope = scopeSection === '' ? input.core : `${input.core.trimEnd()}\n\n${scopeSection}`;
  const withMentions = appendMentions(withScope, input.mentions);
  if (withMentions.length <= MAX_COMMENT_BODY) {
    return withMentions;
  }
  // 超长：先丢「已查范围」（它还有 `envelopes.verdict` 可供面板复核），`@` 必须留下
  if (scopeSection !== '') {
    input.notes.push('comment-over-limit:已查范围段被丢弃');
    const core = appendMentions(input.core, input.mentions);
    if (core.length <= MAX_COMMENT_BODY) {
      return core;
    }
  }
  input.notes.push('comment-over-limit:正文已截断');
  return clampCommentBody(appendMentions(input.core, input.mentions));
}

/* ── 规划（纯函数） ────────────────────────────────────────────────────────── */

/**
 * 决定这一轮分类要做什么。**纯函数**：不写库、不打 GitHub、不读时钟。
 */
export function planClassifyOutcome(input: ClassifyPlanInput): ClassifyPlan {
  const at = input.at;
  const notes: string[] = [];
  const noop = (
    reason: string,
    transition: PipelineTransition | null = null,
  ): ClassifyPlan => ({
    outcome: 'noop',
    category: null,
    actions: [],
    transition,
    mentionSlot: null,
    mention: null,
    notes: [reason],
  });

  if (input.pipeline === null) {
    return noop('no-pipeline-row');
  }
  if (input.command !== CLASSIFY_STAGE_COMMAND) {
    return noop(`not-classify-stage:${input.command}`);
  }

  const pipeline = input.pipeline;
  const running =
    pipeline.stage === 'classify' && (pipeline.state === 'pending' || pipeline.state === 'running');

  /* ── 运行失败 / 信封不合法：零写入；连续 2 次 → blocked ─────────────────────── */
  if (input.runOutcome !== 'succeeded' || !input.envelopeValid) {
    const consecutive = Math.max(1, Math.trunc(input.consecutiveFailures ?? 1));
    const reason =
      input.runOutcome !== 'succeeded'
        ? `阶段 1 运行失败（outcome=${input.runOutcome}）`
        : '阶段 1 信封不合法（缺 stage / result 不在允许集合内）';
    return {
      outcome: consecutive >= 2 ? 'blocked' : 'noop',
      category: null,
      // 零写入：不评论、不打标、不 @（§2「运行失败 / 信封不合法连续 2 次」那一行）
      actions: [],
      transition: decideTransition(pipeline, { kind: 'run-invalid', at, consecutive, reason }),
      mentionSlot: null,
      mention: null,
      notes: [consecutive >= 2 ? `blocked:${reason}` : `run-invalid-first:${reason}`],
    };
  }

  const read = readStageResult(input.envelope, 'classify');
  if (!read.ok) {
    // 信封合规但 stage 结论缺失 / 跨阶段 / result 非法：不猜结论，与「信封不合法」同档
    const consecutive = Math.max(1, Math.trunc(input.consecutiveFailures ?? 1));
    input.logger?.warn(
      { repo: input.repo, issue: input.issueNumber, reason: read.reason },
      `阶段 1 信封不合法：${read.detail}`,
    );
    return {
      outcome: consecutive >= 2 ? 'blocked' : 'noop',
      category: null,
      actions: [],
      transition: decideTransition(pipeline, {
        kind: 'run-invalid',
        at,
        consecutive,
        reason: read.detail,
      }),
      mentionSlot: null,
      mention: null,
      notes: [`stage-invalid:${read.reason}`],
    };
  }

  if (read.downgraded) {
    // defect 但没有 `path:line` → 已降级 not-found（D3 / Q6 修订）：按虚拟缺陷处理并留痕
    input.logger?.warn(
      { repo: input.repo, issue: input.issueNumber },
      '分类结论 defect 缺少 path:line 证据：已降级为 not-found（不打缺陷标签）',
    );
    notes.push('downgraded:defect-without-code-evidence');
  }

  if (!running) {
    // 重投 / 状态已被别的路径推进：一个字都不写（同 §5 的 noop 口径）
    const ignore = `not-classify-running:${pipeline.stage}/${pipeline.state}`;
    return noop(ignore, { ignore });
  }

  const category = toCategory(read.result);
  if (category === null) {
    // `readStageResult` 已按 `STAGE_RESULTS_BY_NAME` 校验过；走到这里说明契约与实现漂了
    input.logger?.warn(
      { repo: input.repo, issue: input.issueNumber, result: read.result },
      '分类结论不是已知的 pipeline category：本轮不动状态机',
    );
    return noop(`unknown-category:${read.result}`);
  }

  const transition = decideTransition(pipeline, { kind: 'classify-result', at, result: category });
  if (transition.ignore !== undefined) {
    return noop(transition.ignore, transition);
  }

  /* ── 标签：走 `pipelineLabelPlan`（互斥组 / 上限 / 人工否决；`not-found` 恒空） ────── */
  const settings = input.settings ?? null;
  const labelPlan =
    settings === null
      ? null
      : pipelineLabelPlan({
          settings,
          result: category,
          ...(input.humanVetoed === undefined ? {} : { humanVetoed: input.humanVetoed }),
          ...(input.logger === undefined ? {} : { logger: input.logger }),
        });
  if (labelPlan === null) {
    notes.push('no-settings:本轮不打标');
  }
  const labels = labelPlan?.desired ?? [];
  const actions: ClassifyAction[] = [];

  /* ── 评论：requirement / defect / not-found 有；other **没有**（§6）──────────── */
  // `@` 名单：单槽（`mention_sent_at` 非空 → 永远不再补）+ 只取 managers
  const managerLogins = managerMentions(settings);
  const mentionSlotOpen = pipeline.mentionSentAt === null && managerLogins.length > 0;
  const mentionsForComment = mentionSlotOpen ? managerLogins : [];
  let mentionApplied = false;

  if (category !== 'other') {
    const maxCommentsPerHour = settings?.limits.max_comments_per_hour ?? 10;
    const recent = Math.max(0, Math.trunc(input.commentsLastHour ?? 0));
    if (recent >= maxCommentsPerHour) {
      // 频率上限（§13）：超限丢评论，状态照常推进（否则 issue 会卡在一个已经判完的阶段）
      notes.push(`comment-rate-limited:${String(recent)}/${String(maxCommentsPerHour)}`);
      input.logger?.warn(
        { repo: input.repo, issue: input.issueNumber, recent, maxCommentsPerHour },
        '分类评论超过每小时上限：本轮不发评论（状态照常推进）',
      );
    } else {
      let core = read.commentBody;
      let source: 'model' | 'fallback' = 'model';
      if (core === null) {
        core = category === 'not-found' ? CLASSIFY_NOT_FOUND_FALLBACK : CLASSIFY_COMMENT_FALLBACK;
        source = 'fallback';
        notes.push(`comment-missing:控制面兜底句(${category})`);
        input.logger?.warn(
          { repo: input.repo, issue: input.issueNumber, category },
          '分类结论没有评论：已用控制面兜底句（Q8 唯一例外）',
        );
      }
      const body = composeComment({ core, scope: read.checkedScope, mentions: mentionsForComment, notes });
      actions.push({ kind: 'comment', body, source });
      mentionApplied = mentionsForComment.length > 0;
    }
  }

  if (labels.length > 0) {
    actions.push({ kind: 'label', labels });
  }

  // `@` 单槽的记账：只有真把 `@` 写进评论了才落 `mention_sent_at`
  // （写错这一列 = 这个 issue 以后再也不会 @ 人；漏写 = 每次重分类都 @ 一遍）
  //
  // **单独一列、单独一次 UPDATE**，且由 `executeClassifyPlan()` 在评论**发成功之后**才落：
  // 合进 `transition` 里先落库的话，评论被限流 / 权限拒掉时这一列已经写死，
  // 那个 issue 就再也不会有 `@`（单槽永不复位，D4）。
  const mentionSlot: PipelineTransition | null = mentionApplied
    ? { mentionSentAt: at, mentionCategory: category }
    : null;

  return {
    outcome: category,
    category,
    actions,
    transition,
    mentionSlot,
    mention:
      managerLogins.length === 0 ? null : { logins: managerLogins, applied: mentionApplied },
    notes,
  };
}

/* ── 执行 ─────────────────────────────────────────────────────────────────── */

/** GitHub 写面的最小切片（`GithubWriteApi` 天然满足）。 */
export type ClassifyWriteApi = {
  createIssueComment: (input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly body: string;
  }) => Promise<unknown>;
  addLabels: (input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly labels: readonly string[];
  }) => Promise<void>;
};

export interface ExecuteClassifyPlanInput {
  readonly plan: ClassifyPlan;
  readonly db: PipelineQueryable;
  readonly key: PipelineKey;
  readonly api: ClassifyWriteApi;
  /** dry-run：不写 `issue_pipeline`、不发任何 GitHub 写请求（与 worker 的零副作用口径一致）。 */
  readonly dryRun?: boolean;
  readonly logger?: ClassifyPlanLogger;
}

export interface ExecuteClassifyPlanResult {
  /** 真正做成的动作（顺序即执行顺序）。 */
  readonly applied: readonly string[];
  /** 失败的动作与原因（不抛错：一条评论发不出去不该让整条流水线卡死）。 */
  readonly errors: readonly string[];
}

/**
 * 执行规划出来的动作。**顺序：状态 → 评论 → （评论成功后才）`@` 单槽 → 标签**。
 *
 * 为什么状态在最前：重投同版本时靠状态机挡住第二条评论（`not-classify-running`）；
 * 状态落不下去就**不再发评论** —— 否则重投会得到两条一模一样的分类报告。
 *
 * 为什么 `@` 单槽在评论之后：`mention_sent_at` 记的是「已经 @ 过人了」，只有当那条
 * 带 `@` 的评论真的发出去了才成立。评论失败（限流 / 权限）时不落槽 —— 于是下一次
 * 分类仍会补 `@`，而不是把这个 issue 永久写死在「已经 @ 过」上（P1-4）。
 */
export async function executeClassifyPlan(
  input: ExecuteClassifyPlanInput,
): Promise<ExecuteClassifyPlanResult> {
  const applied: string[] = [];
  const errors: string[] = [];
  const { repo, issueNumber } = input.key;
  const dryRun = input.dryRun === true;

  // 1) 状态转移（`ignore` 由 `applyTransition()` 自己跳过）
  if (input.plan.transition !== null) {
    try {
      if (!dryRun) {
        await applyTransition(input.db, input.key, input.plan.transition);
      }
      applied.push('transition');
    } catch (error) {
      errors.push(`transition:${error instanceof Error ? error.message : String(error)}`);
      input.logger?.warn(
        { repo, issueNumber, err: String(error) },
        '阶段 1 的状态转移落库失败：本轮不发评论（避免重投重复）',
      );
      return { applied, errors };
    }
  }

  for (const action of input.plan.actions) {
    if (action.kind === 'comment') {
      if (dryRun) {
        applied.push('comment:dry-run');
        continue;
      }
      try {
        await input.api.createIssueComment({ repo, issueNumber, body: action.body });
        applied.push(`comment:${action.source}`);
        // 评论发出去了 → 现在才把 `@` 单槽写死（失败只 warn：下一轮还能补 @）
        if (input.plan.mentionSlot !== null) {
          try {
            await applyTransition(input.db, input.key, input.plan.mentionSlot);
            applied.push('mention');
          } catch (error) {
            errors.push(`mention:${error instanceof Error ? error.message : String(error)}`);
            input.logger?.warn(
              { repo, issueNumber, err: String(error) },
              '评论已发出但 `@` 单槽落库失败：下一轮分类会再 @ 一次（宁可多 @，不可永久沉默）',
            );
          }
        }
      } catch (error) {
        errors.push(`comment:${error instanceof Error ? error.message : String(error)}`);
        input.logger?.warn(
          { repo, issueNumber, err: String(error) },
          '分类评论发送失败：不写 `@` 单槽（否则这个 issue 以后再也不会 @ 人）',
        );
      }
      continue;
    }
    if (action.labels.length === 0) {
      continue;
    }
    if (dryRun) {
      applied.push('label:dry-run');
      continue;
    }
    try {
      await input.api.addLabels({ repo, issueNumber, labels: action.labels });
      applied.push(`label:${action.labels.join(',')}`);
    } catch (error) {
      errors.push(`label:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { applied, errors };
}
