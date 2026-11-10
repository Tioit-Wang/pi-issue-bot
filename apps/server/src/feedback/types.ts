/**
 * 无感反馈的类型面（`docs/impl-multi-repo.md` W2-D、设计见 `docs/plan-multi-repo.md` §5）。
 *
 * 一句话：**用 reaction 表达「我收到了 / 我做完了 / 我卡住了」，不再发固定回复**。
 *
 * 四件事实决定了本模块的形状（都是实测，见 plan §11）：
 *  1. 同 content 重复 POST 幂等（第一次 201、第二次 200，返回同一个 id）→ **发之前不查重**；
 *  2. DELETE 后再 POST 同 content 会得到**新 id** → 绝不为「刷新状态」删了重加；
 *  3. 跨 content 必须两次调用（`-eyes` 然后 `+rocket`），删和加都不能省；
 *  4. 只删自己打的（`user.login` 以 `[bot]` 结尾或等于 App slug）。
 *
 * 本文件只放类型与常量；SQL 在 `sql.ts`、状态机在 `stage.ts`、执行在 `apply.ts`。
 */
import type { GithubReactionApi, ReactionContent } from '../github/types.ts';

/** `issue_feedback.stage` 的取值（终态三种 + 入队一种）。 */
export const FEEDBACK_STAGES = ['received', 'succeeded', 'failed', 'timed-out', 'cancelled'] as const;

export type FeedbackStage = (typeof FEEDBACK_STAGES)[number];

/** 目标类型（与 `tasks.target_kind` 同值）。 */
export const FEEDBACK_TARGET_KINDS = ['issue', 'pr'] as const;

export type FeedbackTargetKind = (typeof FEEDBACK_TARGET_KINDS)[number];

/** reaction 打到哪儿（`commentId` 给了就是评论级，否则主贴）。 */
export type FeedbackTarget = {
  readonly repo: string;
  readonly targetKind: FeedbackTargetKind;
  readonly targetNumber: number;
  /** 触发评论 id（评论级 reaction）；`null` / 省略 = 主贴。 */
  readonly commentId?: number | null;
};

/** `issue_feedback` 的一行（只取执行需要的四列）。 */
export type FeedbackRow = {
  readonly id: number;
  readonly content: string;
  readonly reactionId: number | null;
  readonly appliedAt: Date | null;
};

/** `claim()` 的结果：`inserted=false` 表示唯一键已命中（这一格此前已经记过账）。 */
export type FeedbackClaim = {
  readonly inserted: boolean;
  readonly row: FeedbackRow;
};

/** `issue_feedback` 台账（PG 实现在 `pg.ts`，单测注入内存假实现）。 */
export interface FeedbackLedger {
  /**
   * 占位：`INSERT ... ON CONFLICT (repo, target_kind, target_number, stage, anchor) DO NOTHING RETURNING`。
   *
   * 唯一键命中时**不报错**，而是把既有行读回来（`inserted=false`）——
   * 幂等闸就在这里，不靠内存去重表。
   */
  claim(input: {
    readonly repo: string;
    readonly targetKind: FeedbackTargetKind;
    readonly targetNumber: number;
    readonly commentId: number | null;
    readonly stage: FeedbackStage;
    readonly content: ReactionContent;
    readonly anchor: string;
    readonly audit: Readonly<Record<string, unknown>> | null;
  }): Promise<FeedbackClaim>;
  /** 回填 `reaction_id` + `applied_at`（GitHub 调用成功之后）。 */
  markApplied(input: {
    readonly id: number;
    readonly reactionId: number | null;
    readonly appliedAt: Date;
    readonly audit: Readonly<Record<string, unknown>> | null;
  }): Promise<void>;
  /** 记一次失败：`applied_at` 保持 NULL，原因进 `audit`（面板的「未落地」一栏）。 */
  markFailed(input: {
    readonly id: number;
    readonly reason: string;
    readonly httpStatus: number | null;
  }): Promise<void>;
}

/** `runtime_flags{key:'reactions_disabled'}` 的读写面（进程内要缓存，见 `pg.ts`）。 */
export interface ReactionsFlagStore {
  /** 是否已禁用（`true` → 后续 POST / DELETE 一律跳过）。 */
  isDisabled(): Promise<boolean>;
  /** 置为禁用（403 / 无权限时由 `applyFeedback()` 调用）。 */
  disable(input: { readonly reason: string }): Promise<void>;
}

/**
 * `applyFeedback()` 的依赖。
 *
 * `reactions` 用 `GithubReactionApi`（github 层的窄接口）：本模块不做 REST 细节，
 * 只做「状态机 + 台账 + 降级」。`flags` 可缺省（单测/无库场景就是不降级）。
 */
export type FeedbackDeps = {
  readonly ledger: FeedbackLedger;
  readonly reactions: GithubReactionApi;
  readonly flags?: ReactionsFlagStore | undefined;
  /** 本 App 的 slug（`user.login` 为 `<slug>[bot]`）；不传就只按 `[bot]` 后缀判。 */
  readonly appSlug?: string | null | undefined;
  readonly logger?: FeedbackLogger | undefined;
  readonly clock?: (() => number) | undefined;
  /** dry-run 的 `run_events(kind='feedback.planned')` 由调用方落库。 */
  readonly onEvent?: ((kind: string, payload: unknown) => void) | undefined;
};

/** 只用到 `warn` / `info` 两个级别（避免把 shared 的 Logger 拉进来形成环）。 */
export type FeedbackLogger = {
  warn(detail: Readonly<Record<string, unknown>>, message: string): void;
  info?(detail: Readonly<Record<string, unknown>>, message: string): void;
};

/** `applyFeedback()` 的入参。 */
export type ApplyFeedbackInput = FeedbackTarget & {
  readonly stage: FeedbackStage;
  /**
   * 幂等锚点：取 **`tasks.idempotency_key`**（不是 taskId）。
   *
   * 为什么不是 taskId：重投 / `/retry` / 超时重跑都会产生新 taskId，用它当锚点等于没有
   * 幂等（同一个 (目标, 阶段) 会被反复记账、反复打 reaction）。
   */
  readonly anchor: string;
  /** dry-run：一个 reaction 都不打、`issue_feedback` 也不写，只留 `feedback.planned`。 */
  readonly dryRun?: boolean;
};

/** `applyFeedback()` 的结局。 */
export const FEEDBACK_STATUSES = ['applied', 'skipped', 'planned', 'disabled', 'failed'] as const;

export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export type FeedbackOutcome = {
  readonly stage: FeedbackStage;
  readonly content: ReactionContent;
  readonly status: FeedbackStatus;
  readonly reason: string;
  /** 加上去的 reaction id（`applied` 时有值）。 */
  readonly reactionId: number | null;
  /** 被删掉的 reaction id（终态先删 `eyes`）。 */
  readonly removed: readonly number[];
  readonly httpStatus: number | null;
  /** `true` = 403 / 无权限（已置 `reactions_disabled`，调用方应留 `actions(applied_at=null)`）。 */
  readonly permissionDenied: boolean;
};
