/**
 * 阶段 0（格式检查）的**三条路径收敛点**（`docs/plan-fixed-pipeline.md` §5 / §12 V2·V3·V4·V19）。
 *
 * ```
 * 信封 stage.result=pass ┬ 首次（format_fail_count=0） → 无评论 + rocket + 入队分类（V2）
 *                        └ 重检（format_fail_count>0） → **一条确认评论**（D8）+ rocket + 入队分类（V4）
 * 信封 stage.result=fail ─┬ 未到上限 → 评论 + needs-info + confused + awaiting_info + info_requested_at（V3）
 *                        └ 到上限   → 评论（最后反馈）+ closeIssue + closed（V19）
 * 运行失败 / 信封不合法 ── 连续 2 次 → blocked，**不写任何东西**
 * ```
 *
 * 为什么拆成「先算动作、再执行」两步：
 *  - `planFormatOutcome()` 是**纯函数**（时钟与阈值都从参数来），三条路径的动作集合可以逐条断言
 *    —— 评论几条、打了什么标签、什么 reaction、状态行写到哪；
 *  - `executeFormatPlan()` 才碰 IO（GitHub 写面 / reaction / `issue_pipeline`），
 *    单测注入假实现即可复现 V2/V3/V19，不需要真仓库。
 *
 * 谁执行：`app/compose.ts` 在 `executeTask()` 之后调这两个函数（写入方只有一处）。
 *
 * 两条纪律：
 *  1. **状态先落、评论后发**：重投同版本时靠状态机（不再 `format/pending|running` → `ignore`）
 *     挡住第二条评论，而不是靠「有没有发过」（那是不可判定的事实）；
 *  2. **不重复关闭**：`closeIssue` 只在 `decideTransition()` 给出 `effects.closeIssue` 时出现，
 *     第 5 次（默认）不通过的**那条 AI 评论就是最后反馈**，不再另发关闭评论（Q5 / V19）。
 */
import type { RepoConfig } from '../../../../packages/contract/src/index.ts';
import { PIPELINE_LIMITS } from '../config/pipeline-constants.ts';
import type { PipelineLimits } from '../config/pipeline-constants.ts';
import type { ReactionContent } from '../github/types.ts';
import { decideTransition, applyTransition } from './pipeline.ts';
import type {
  PipelineKey,
  PipelineQueryable,
  PipelineRow,
  PipelineTransition,
} from './pipeline.ts';
import { commentBodyOf, readStageResult } from './stage-result.ts';
import { NEEDS_INFO_FALLBACK_LABEL, needsInfoLabelOf } from './triage.ts';

/* ── 兜底文案（Q8 唯一例外：故障兜底，不做服务端模板渲染）────────────────────── */

/**
 * 重检通过但模型没写确认评论时的控制面兜底（D8）。
 *
 * §5：`pass 补充后复查` **必须有确认评论**；模型没写时由控制面补这一句，
 * 并记一条 warn —— 这是 Q8「评论一律 AI 撰写」的唯一例外，且只在**故障**时生效。
 */
export const FORMAT_PASS_COMMENT_FALLBACK = '已收到补充信息，格式检查通过。';

/**
 * 不通过但模型没写评论时的兜底（§5「fail 必须带 comment」）。
 *
 * 与确认句同一条纪律：只在模型漏写时使用，永远不是首选文案。
 */
export const FORMAT_FAIL_COMMENT_FALLBACK = '还缺必要的格式信息，请按上一条评论补充。';

/** 阶段 0 任务的命令名（`pipeline:format`）；别的命令不该调这里。 */
export const FORMAT_STAGE_COMMAND = 'pipeline:format';

/* ── 动作 ─────────────────────────────────────────────────────────────────── */

/** 一条待执行动作。执行顺序 = 数组顺序（见 `executeFormatPlan()`）。 */
export type FormatAction =
  | {
      readonly kind: 'comment';
      readonly body: string;
      /** `model` = 模型写的；`fallback` = 控制面兜底句（一定伴随一条 warn）。 */
      readonly source: 'model' | 'fallback';
    }
  | { readonly kind: 'label'; readonly labels: readonly string[] }
  | { readonly kind: 'reaction'; readonly content: ReactionContent }
  | { readonly kind: 'closeIssue' };

/** 三条路径 + 两种「不做事」的结论。 */
export type FormatOutcome =
  /** 首次通过：零评论（V2） */
  | 'pass-first'
  /** 补充后复查通过：一条确认评论（V4 / D8） */
  | 'pass-recheck'
  /** 不通过：评论 + needs-info + confused + awaiting_info（V3） */
  | 'fail'
  /** 不通过且到上限：评论 + 关 issue（V19） */
  | 'fail-closed'
  /** 运行失败 / 信封不合法连续 2 次：**零写入** + blocked */
  | 'blocked'
  /** 这一轮什么都不该做（重投、状态已不在 format/pending、没有流水线行…） */
  | 'noop';

export interface FormatPlan {
  readonly outcome: FormatOutcome;
  /** 要执行的动作（顺序即执行顺序）。 */
  readonly actions: readonly FormatAction[];
  /**
   * 要落的转移（`applyTransition()` 的入参）。
   * `null` = 这一轮不动状态行；带 `ignore` 时 `applyTransition()` 会自动跳过写库。
   */
  readonly transition: PipelineTransition | null;
  /** 要不要在转移之后调 `closeIssue`（Q5 自动关）。 */
  readonly closeIssue: boolean;
  /** 人读的留痕（日志 / `run_events`）：兜底句用了哪一句、为什么被忽略… */
  readonly notes: readonly string[];
}

export type FormatPlanLogger = {
  warn: (fields: Record<string, unknown> | string, message?: string) => void;
};

export interface FormatPlanInput {
  readonly repo: string;
  readonly issueNumber: number;
  /** 当前流水线行；`null` = 没有行（不该有阶段 0 任务，按 noop 处理并留痕）。 */
  readonly pipeline: PipelineRow | null;
  /** worker 交出的信封（`PreparedEnvelope.envelope`）；运行失败 / 不合法 → `null`。 */
  readonly envelope: unknown;
  /** 信封是否通过 Ajv 校验（`false` 时 `envelope` 也可能是 `null`）。 */
  readonly envelopeValid: boolean;
  /** 本次 run 的结局（`worker/types.ts::RunOutcome`）。只有 `succeeded` 才算「跑完了」。 */
  readonly runOutcome: string;
  /**
   * 连续运行失败次数（含本次）。
   *
   * 表里没有这一列（`issue_pipeline` 只记阶段结论，不记「连续跑挂几次」），
   * 所以由调用方按任务的尝试次数推：`tasks.attempt + 1`。
   * `>= 2` → `blocked`（§2「运行失败 / 信封不合法连续 2 次」）。
   */
  readonly consecutiveFailures?: number;
  readonly command: string;
  /** 仓库配置（`needs-info` 标签名从 `labels.map` 取，沿用 `needsInfoLabelOf()`）。 */
  readonly config?: RepoConfig | null;
  /** 阈值注入（V12 / V19：`formatMaxFails: 2`）。 */
  readonly limits?: PipelineLimits;
  /** 事件时刻（纯函数：不读时钟）。 */
  readonly at: Date;
  readonly logger?: FormatPlanLogger;
}

/* ── 规划（纯函数） ────────────────────────────────────────────────────────── */

/** `needs-info` 的实际标签名；没有仓库配置时用兜底名（`needsInfoLabelOf` 需要合法的 `labels`）。 */
function needsInfoLabelOfRepo(config: RepoConfig | null | undefined): string {
  if (config === null || config === undefined) {
    return NEEDS_INFO_FALLBACK_LABEL;
  }
  return needsInfoLabelOf(config);
}

/**
 * 决定这一轮格式检查要做什么。**纯函数**：不写库、不打 GitHub、不读时钟。
 */
export function planFormatOutcome(input: FormatPlanInput): FormatPlan {
  const limits = input.limits ?? PIPELINE_LIMITS;
  const at = input.at;
  const notes: string[] = [];

  if (input.pipeline === null) {
    return { outcome: 'noop', actions: [], transition: null, closeIssue: false, notes: ['no-pipeline-row'] };
  }
  if (input.command !== FORMAT_STAGE_COMMAND) {
    return {
      outcome: 'noop',
      actions: [],
      transition: null,
      closeIssue: false,
      notes: [`not-format-stage:${input.command}`],
    };
  }

  const pipeline = input.pipeline;
  const running =
    pipeline.stage === 'format' && (pipeline.state === 'pending' || pipeline.state === 'running');

  /* ── 运行失败 / 信封不合法：不写任何用户可见的东西，连续 2 次 → blocked ────────── */
  if (input.runOutcome !== 'succeeded' || !input.envelopeValid) {
    const consecutive = Math.max(1, Math.trunc(input.consecutiveFailures ?? 1));
    const reason =
      input.runOutcome !== 'succeeded'
        ? `阶段 0 运行失败（outcome=${input.runOutcome}）`
        : '阶段 0 信封不合法（缺 stage / result 不在允许集合内）';
    const transition = decideTransition(pipeline, {
      kind: 'run-invalid',
      at,
      consecutive,
      reason,
    });
    return {
      outcome: consecutive >= 2 ? 'blocked' : 'noop',
      // 零写入：运行失败时不发评论、不打标、不打 reaction（§5 最后一行）
      actions: [],
      transition,
      closeIssue: false,
      notes: [consecutive >= 2 ? `blocked:${reason}` : `run-invalid-first:${reason}`],
    };
  }

  const read = readStageResult(input.envelope, 'format');
  if (!read.ok) {
    // 信封合规但 stage 结论缺失/不匹配：与「信封不合法」同档处理（不猜结论）
    const consecutive = Math.max(1, Math.trunc(input.consecutiveFailures ?? 1));
    return {
      outcome: consecutive >= 2 ? 'blocked' : 'noop',
      actions: [],
      transition: decideTransition(pipeline, {
        kind: 'run-invalid',
        at,
        consecutive,
        reason: read.detail,
      }),
      closeIssue: false,
      notes: [`stage-invalid:${read.reason}`],
    };
  }

  /* ── 通过（首次 / 重检） ─────────────────────────────────────────────────── */
  if (read.result === 'pass') {
    const recheck = pipeline.formatFailCount > 0;
    const transition = decideTransition(pipeline, {
      kind: recheck ? 'format-pass-recheck' : 'format-pass-first',
      at,
    });
    if (transition.ignore !== undefined) {
      // 重投 / 状态已被别的路径推进：一个字都不写（V3 的「同版本重投不新增评论」）
      return { outcome: 'noop', actions: [], transition, closeIssue: false, notes: [transition.ignore] };
    }
    const actions: FormatAction[] = [];
    if (recheck) {
      // D8：补充信息后复查通过 **必须有确认评论**；模型没写就用控制面兜底句（Q8 唯一例外）
      if (read.commentBody === null) {
        notes.push('recheck-pass-without-comment:控制面兜底句');
        input.logger?.warn(
          { repo: input.repo, issue: input.issueNumber },
          '格式重检通过但模型没写确认评论：已用控制面兜底句（Q8 唯一例外）',
        );
        actions.push({ kind: 'comment', body: FORMAT_PASS_COMMENT_FALLBACK, source: 'fallback' });
      } else {
        actions.push({ kind: 'comment', body: read.commentBody, source: 'model' });
      }
    }
    // 首次通过与重检通过都打 `rocket`（V2 / V4：pass 的可见反馈只有它）
    actions.push({ kind: 'reaction', content: 'rocket' });
    return {
      outcome: recheck ? 'pass-recheck' : 'pass-first',
      actions,
      transition,
      closeIssue: false,
      notes,
    };
  }

  /* ── 不通过 ─────────────────────────────────────────────────────────────── */
  if (!running) {
    return {
      outcome: 'noop',
      actions: [],
      transition: { ignore: `not-format-running:${pipeline.stage}/${pipeline.state}` },
      closeIssue: false,
      notes: [`not-format-running:${pipeline.stage}/${pipeline.state}`],
    };
  }

  const transition = decideTransition(pipeline, {
    kind: 'format-fail',
    at,
    formatMaxFails: limits.formatMaxFails,
  });
  if (transition.ignore !== undefined) {
    return { outcome: 'noop', actions: [], transition, closeIssue: false, notes: [transition.ignore] };
  }

  // 评论：模型写的优先；缺失 → 兜底句 + warn（「fail 必须带 comment」）
  let body = read.commentBody;
  let source: 'model' | 'fallback' = 'model';
  if (body === null) {
    body = FORMAT_FAIL_COMMENT_FALLBACK;
    source = 'fallback';
    notes.push('fail-without-comment:控制面兜底句');
    input.logger?.warn(
      { repo: input.repo, issue: input.issueNumber },
      '格式不通过但模型没写评论：已用控制面兜底句',
    );
  }

  const closing = transition.effects?.closeIssue === true;
  const actions: FormatAction[] = [{ kind: 'comment', body, source }];

  if (closing) {
    // Q5 / V19：累计到上限 → 关 issue。这一条评论就是最后反馈，
    // **不再打 needs-info、不再打 confused、不再另发关闭评论**（关掉的 issue 上那些都是噪音）
    actions.push({ kind: 'closeIssue' });
    notes.push(
      `fail-closed:${String(pipeline.formatFailCount + 1)}/${String(limits.formatMaxFails)}`,
    );
    return { outcome: 'fail-closed', actions, transition, closeIssue: true, notes };
  }

  // 未到上限：needs-info 标签（沿用 `needsInfoLabelOf`）+ `confused` reaction + awaiting_info
  actions.push({ kind: 'label', labels: [needsInfoLabelOfRepo(input.config)] });
  actions.push({ kind: 'reaction', content: 'confused' });
  notes.push(`fail:${String(pipeline.formatFailCount + 1)}/${String(limits.formatMaxFails)}`);
  return { outcome: 'fail', actions, transition, closeIssue: false, notes };
}

/* ── 执行 ─────────────────────────────────────────────────────────────────── */

/** GitHub 写面的最小切片（`GithubWriteApi` 天然满足）。 */
export type FormatWriteApi = {
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
  closeIssue: (input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly reason?: 'completed' | 'not_planned';
  }) => Promise<void>;
};

/** reaction 写面（`GithubReactionApi` 天然满足）。 */
export type FormatReactionApi = {
  addReaction: (input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly content: ReactionContent;
  }) => Promise<unknown>;
};

export interface ExecuteFormatPlanInput {
  readonly plan: FormatPlan;
  readonly db: PipelineQueryable;
  readonly key: PipelineKey;
  readonly api: FormatWriteApi;
  /** 不注入 = 不打 reaction（没装 App 的部署），只记一条 note。 */
  readonly reactions?: FormatReactionApi;
  /** dry-run：不写 `issue_pipeline`、不发任何 GitHub 写请求（与 worker 的零副作用口径一致）。 */
  readonly dryRun?: boolean;
  readonly logger?: FormatPlanLogger;
}

export interface ExecuteFormatPlanResult {
  /** 真正做成的动作（顺序即执行顺序）。 */
  readonly applied: readonly string[];
  /** 失败的动作与原因（不抛错：一条评论发不出去不该让整条流水线卡死）。 */
  readonly errors: readonly string[];
}

/**
 * 执行规划出来的动作。**顺序：状态 → 评论 → 标签 → reaction → 关 issue**。
 *
 * 为什么状态在最前：重投同版本时靠状态机挡住第二条评论（`not-format-running`），
 * 这与「评论先发、状态后落」在重投场景下会得到两条一模一样的评论 —— 那是 V3 明确禁止的。
 */
export async function executeFormatPlan(
  input: ExecuteFormatPlanInput,
): Promise<ExecuteFormatPlanResult> {
  const applied: string[] = [];
  const errors: string[] = [];
  const { repo, issueNumber } = input.key;
  const dryRun = input.dryRun === true;

  // 1) 状态转移（`ignore` 由 `applyTransition()` 自己跳过）
  if (input.plan.transition !== null) {
    try {
      if (!dryRun) {
        await applyPipelineTransition(input.db, input.key, input.plan.transition);
      }
      applied.push('transition');
    } catch (error) {
      errors.push(`transition:${error instanceof Error ? error.message : String(error)}`);
      // 状态落不下去就不能再发评论：否则重投会重复发（V3）
      input.logger?.warn(
        { repo, issueNumber, err: String(error) },
        '阶段 0 的状态转移落库失败：本轮不发评论（避免重投重复）',
      );
      return { applied, errors };
    }
  }

  for (const action of input.plan.actions) {
    switch (action.kind) {
      case 'comment': {
        if (dryRun) {
          applied.push('comment:dry-run');
          break;
        }
        try {
          await input.api.createIssueComment({ repo, issueNumber, body: action.body });
          applied.push(`comment:${action.source}`);
        } catch (error) {
          errors.push(`comment:${error instanceof Error ? error.message : String(error)}`);
        }
        break;
      }
      case 'label': {
        if (dryRun) {
          applied.push('label:dry-run');
          break;
        }
        if (action.labels.length === 0) {
          break;
        }
        try {
          await input.api.addLabels({ repo, issueNumber, labels: action.labels });
          applied.push(`label:${action.labels.join(',')}`);
        } catch (error) {
          errors.push(`label:${error instanceof Error ? error.message : String(error)}`);
        }
        break;
      }
      case 'reaction': {
        if (dryRun) {
          applied.push(`reaction:${action.content}:dry-run`);
          break;
        }
        if (input.reactions === undefined) {
          input.logger?.warn({ repo, issueNumber }, '未注入 reaction 写面：本轮不打 reaction');
          break;
        }
        try {
          await input.reactions.addReaction({ repo, issueNumber, content: action.content });
          applied.push(`reaction:${action.content}`);
        } catch (error) {
          errors.push(`reaction:${error instanceof Error ? error.message : String(error)}`);
        }
        break;
      }
      case 'closeIssue': {
        if (dryRun) {
          applied.push('closeIssue:dry-run');
          break;
        }
        try {
          // Q5 自动关：`not_planned`（这不是「做完了」，是「信息一直没补」）
          await input.api.closeIssue({ repo, issueNumber, reason: 'not_planned' });
          applied.push('closeIssue');
        } catch (error) {
          errors.push(`closeIssue:${error instanceof Error ? error.message : String(error)}`);
          input.logger?.warn(
            { repo, issueNumber, err: String(error) },
            '阶段 0 自动关 issue 失败（状态已落 closed，issue 仍开着，下一轮不会再触发）',
          );
        }
        break;
      }
    }
  }

  return { applied, errors };
}

/** `applyTransition()` 的薄包装（只为让上面那段读起来是「一句一件事」）。 */
async function applyPipelineTransition(
  db: PipelineQueryable,
  key: PipelineKey,
  transition: PipelineTransition,
): Promise<void> {
  await applyTransition(db, key, transition);
}

/** 这一轮模型写的评论正文（`null` = 没写）；测试与面板留痕用。 */
export { commentBodyOf as formatCommentOf };
