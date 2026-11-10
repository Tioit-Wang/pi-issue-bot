/**
 * 无感反馈的执行层（`docs/impl-multi-repo.md` W2-D）。
 *
 * 一次调用做三件事，顺序不能换：
 *  1. **台账先占位**：`issue_feedback` 的 `INSERT ... ON CONFLICT DO NOTHING RETURNING`
 *     就是幂等闸。命中「已有行且 `applied_at` 非空」→ 直接跳过（不碰 GitHub）；
 *     命中「已有行但 `applied_at` 为空」→ 允许重试（上一轮调到一半失败了）；
 *  2. **终态先收 `eyes`**：跨 content 必须两次调用；只删自己打的（`removeOwnReaction`）；
 *  3. **POST 幂等**：同 content 重复 POST 返回同一个 id，所以**发之前不查重**，
 *     成功后回填 `reaction_id` + `applied_at`。
 *
 * 降级（`docs/impl-multi-repo.md` W2-D 第 6 条）：
 *  - 403 / 无权限 → 记 `warn` + `actions(applied_at=null)`（由调用方落）+ 置
 *    `runtime_flags{key:'reactions_disabled'}`，本进程后续 POST/DELETE 全部跳过；
 *  - 429 / 5xx → 只重试 1 次，再失败就放过（reaction 不值得拖住整轮任务）。
 *
 * 本文件**不写库**（PSQL 在 `pg.ts`）、**不打 HTTP**（REST 在 `github/`），
 * 于是单测可以完全用假实现钉住状态机与降级路径。
 */
import { classifyGithubError } from '../github/errors.ts';
import { isOwnReactionLogin, withTransientRetry } from '../github/executor.ts';
import type { GithubReactionApi, ReactionContent } from '../github/types.ts';
import { planStage } from './stage.ts';
import type {
  ApplyFeedbackInput,
  FeedbackDeps,
  FeedbackLogger,
  FeedbackOutcome,
  FeedbackTarget,
  ReactionsFlagStore,
} from './types.ts';

/** `removeOwnReaction()` 的依赖（`FeedbackDeps` 的子集）。 */
export type RemoveOwnReactionDeps = {
  readonly reactions: GithubReactionApi;
  readonly appSlug?: string | null | undefined;
  readonly logger?: FeedbackLogger | undefined;
  readonly clock?: (() => number) | undefined;
};

/** `removeOwnReaction()` 的入参。 */
export type RemoveOwnReactionInput = FeedbackTarget & {
  /** 要删的 content（终态删 `eyes`）。 */
  readonly content: ReactionContent;
};

const DEFAULT_CLOCK = (): number => Date.now();

function targetPayload(target: FeedbackTarget): Readonly<Record<string, unknown>> {
  return {
    repo: target.repo,
    targetKind: target.targetKind,
    targetNumber: target.targetNumber,
    commentId: target.commentId ?? null,
  };
}

/**
 * 只删「自己打的」某个 content 的 reaction，返回删掉的 id 列表。
 *
 * 为什么单独成函数：入队阶段的 `+eyes`（http 侧）与终态的 `-eyes`（worker 侧）
 * 必须用**同一套**归属判定，否则会出现「入队打的是评论级、终态删的是主贴」这种错位。
 */
export async function removeOwnReaction(
  deps: RemoveOwnReactionDeps,
  input: RemoveOwnReactionInput,
): Promise<readonly number[]> {
  const clock = deps.clock ?? DEFAULT_CLOCK;
  const entries = await withTransientRetry(
    () =>
      deps.reactions.listReactions({
        repo: input.repo,
        issueNumber: input.targetNumber,
        ...(input.commentId === undefined ? {} : { commentId: input.commentId }),
        content: input.content,
        perPage: 100,
      }),
    {
      now: clock,
      onRetry: (info) => {
        deps.logger?.warn(
          { ...targetPayload(input), content: input.content, status: info.status, attempt: info.attempt },
          '列 reaction 遇到 429/5xx，重试 1 次',
        );
      },
    },
  );

  const own = entries
    .filter((entry) => isOwnReactionLogin(entry.userLogin, deps.appSlug))
    .map((entry) => entry.id);
  if (own.length === 0) {
    return [];
  }

  const removed: number[] = [];
  for (const reactionId of own) {
    await withTransientRetry(
      () =>
        deps.reactions.removeReaction({
          repo: input.repo,
          issueNumber: input.targetNumber,
          ...(input.commentId === undefined ? {} : { commentId: input.commentId }),
          reactionId,
        }),
      { now: clock },
    );
    removed.push(reactionId);
  }
  return removed;
}

/** 置 `reactions_disabled`（失败只 warn：降级本身再失败，也不该让这轮任务翻车）。 */
async function disableReactions(
  flags: ReactionsFlagStore | undefined,
  logger: FeedbackLogger | undefined,
  input: { readonly reason: string; readonly target: FeedbackTarget },
): Promise<void> {
  if (flags === undefined) {
    return;
  }
  try {
    await flags.disable({ reason: input.reason });
  } catch (error) {
    logger?.warn(
      { ...targetPayload(input.target), err: error instanceof Error ? error.message : String(error) },
      '置 reactions_disabled 失败（已忽略）',
    );
  }
}

/**
 * 按阶段打/清 reaction 并落 `issue_feedback`。
 *
 * **不抛异常**（除非调用方自己的台账实现抛了且没有被下面兜住）：失败一律体现在
 * `FeedbackOutcome.status` 上。调用方（worker 终态收尾）据此决定要不要留
 * `actions(applied_at=null)`。`issue_feedback` 写入失败只 warn，不改 run 结论。
 */
export async function applyFeedback(
  deps: FeedbackDeps,
  input: ApplyFeedbackInput,
): Promise<FeedbackOutcome> {
  const clock = deps.clock ?? DEFAULT_CLOCK;
  const plan = planStage(input.stage);
  const logger = deps.logger;

  // ── 1) dry-run：一个 reaction 都不打、issue_feedback 也不写 ────────────────────
  if (input.dryRun === true) {
    deps.onEvent?.('feedback.planned', {
      ...targetPayload(input),
      stage: plan.stage,
      add: plan.add,
      remove: plan.remove,
      anchor: input.anchor,
    });
    return {
      stage: plan.stage,
      content: plan.add,
      status: 'planned',
      reason: 'dry-run：只写 run_events(feedback.planned)，不打 reaction、不写 issue_feedback',
      reactionId: null,
      removed: [],
      httpStatus: null,
      permissionDenied: false,
    };
  }

  // ── 2) 已被降级禁用：进程内命中了 reactions_disabled，后续一个请求都不发 ──────────
  if (deps.flags !== undefined) {
    let disabled = false;
    try {
      disabled = await deps.flags.isDisabled();
    } catch (error) {
      logger?.warn(
        { err: error instanceof Error ? error.message : String(error) },
        '读 reactions_disabled 失败（按未禁用处理）',
      );
    }
    if (disabled) {
      return {
        stage: plan.stage,
        content: plan.add,
        status: 'disabled',
        reason: 'runtime_flags.reactions_disabled 已生效：跳过后续 POST/DELETE',
        reactionId: null,
        removed: [],
        httpStatus: null,
        permissionDenied: true,
      };
    }
  }

  // ── 3) 台账占位（幂等闸） ────────────────────────────────────────────────────
  let claim;
  try {
    claim = await deps.ledger.claim({
      repo: input.repo,
      targetKind: input.targetKind,
      targetNumber: input.targetNumber,
      commentId: input.commentId ?? null,
      stage: plan.stage,
      content: plan.add,
      anchor: input.anchor,
      audit: { runAnchor: input.anchor, planned: { add: plan.add, remove: plan.remove } },
    });
  } catch (error) {
    // 台账写入失败只记 warn：宁可少一条反馈，也不能让 run 结论改变
    logger?.warn(
      {
        ...targetPayload(input),
        stage: plan.stage,
        err: error instanceof Error ? error.message : String(error),
      },
      'issue_feedback 写入失败（只 warn，不影响 run 结论）',
    );
    return {
      stage: plan.stage,
      content: plan.add,
      status: 'failed',
      reason: `issue_feedback 写入失败：${error instanceof Error ? error.message : String(error)}`,
      reactionId: null,
      removed: [],
      httpStatus: null,
      permissionDenied: false,
    };
  }

  if (!claim.inserted && claim.row.appliedAt !== null) {
    return {
      stage: plan.stage,
      content: plan.add,
      status: 'skipped',
      reason: `唯一键 (repo,target_kind,target_number,stage,anchor) 命中且 applied_at 非空（reaction_id=${String(claim.row.reactionId)}）：跳过`,
      reactionId: claim.row.reactionId,
      removed: [],
      httpStatus: null,
      permissionDenied: false,
    };
  }

  // ── 4) 终态先删 eyes（只删自己的；删失败不阻塞终态） ────────────────────────────
  const removed: number[] = [];
  if (plan.remove !== null) {
    try {
      removed.push(
        ...(await removeOwnReaction(
          {
            reactions: deps.reactions,
            ...(deps.appSlug === undefined ? {} : { appSlug: deps.appSlug }),
            ...(logger === undefined ? {} : { logger }),
            clock,
          },
          {
            repo: input.repo,
            targetKind: input.targetKind,
            targetNumber: input.targetNumber,
            ...(input.commentId === undefined ? {} : { commentId: input.commentId }),
            content: plan.remove,
          },
        )),
      );
    } catch (error) {
      const info = classifyGithubError(error, clock());
      logger?.warn(
        { ...targetPayload(input), content: plan.remove, httpStatus: info.status, reason: info.message },
        '删 eyes reaction 失败（继续加终态）',
      );
      if (info.class === 'auth') {
        await disableReactions(deps.flags, logger, {
          reason: `reaction.remove 403：${info.message}`,
          target: input,
        });
      }
    }
  }

  // ── 5) POST 终态（同 content 幂等，不查重） ────────────────────────────────────
  try {
    const ref = await withTransientRetry(
      () =>
        deps.reactions.addReaction({
          repo: input.repo,
          issueNumber: input.targetNumber,
          ...(input.commentId === undefined ? {} : { commentId: input.commentId }),
          content: plan.add,
        }),
      {
        now: clock,
        onRetry: (info) => {
          logger?.warn(
            { ...targetPayload(input), content: plan.add, status: info.status, attempt: info.attempt },
            '打 reaction 遇到 429/5xx，重试 1 次',
          );
        },
      },
    );

    try {
      await deps.ledger.markApplied({
        id: claim.row.id,
        reactionId: ref.id,
        appliedAt: new Date(clock()),
        audit: { reactionId: ref.id, content: plan.add, removed },
      });
    } catch (error) {
      logger?.warn(
        { ...targetPayload(input), reactionId: ref.id, err: error instanceof Error ? error.message : String(error) },
        '回填 issue_feedback.reaction_id 失败（reaction 已经打上，只 warn）',
      );
    }

    return {
      stage: plan.stage,
      content: plan.add,
      status: 'applied',
      reason: `已打 ${plan.add} reaction（id=${String(ref.id)}${removed.length > 0 ? `，先删 eyes ${String(removed.length)} 条` : ''}）`,
      reactionId: ref.id,
      removed,
      httpStatus: null,
      permissionDenied: false,
    };
  } catch (error) {
    const info = classifyGithubError(error, clock());
    const permissionDenied = info.class === 'auth';
    if (permissionDenied) {
      logger?.warn(
        { ...targetPayload(input), httpStatus: info.status, reason: info.message },
        '打 reaction 403/无权限：置 reactions_disabled，本轮降级',
      );
      await disableReactions(deps.flags, logger, {
        reason: `reaction.add 403：${info.message}`,
        target: input,
      });
    } else {
      logger?.warn(
        { ...targetPayload(input), httpStatus: info.status, failureClass: info.class, reason: info.message },
        '打 reaction 失败（重试 1 次后放弃）',
      );
    }

    try {
      await deps.ledger.markFailed({
        id: claim.row.id,
        reason: info.message,
        httpStatus: info.status,
      });
    } catch (markError) {
      logger?.warn(
        { err: markError instanceof Error ? markError.message : String(markError) },
        '记 issue_feedback 失败原因失败（已忽略）',
      );
    }

    return {
      stage: plan.stage,
      content: plan.add,
      status: 'failed',
      reason: permissionDenied
        ? `reaction 权限不足（HTTP ${String(info.status)}）：已置 reactions_disabled`
        : `打 reaction 失败：${info.message}`,
      reactionId: null,
      removed,
      httpStatus: info.status,
      permissionDenied,
    };
  }
}
