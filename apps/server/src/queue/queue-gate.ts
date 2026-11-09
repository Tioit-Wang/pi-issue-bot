/**
 * 排队闸门（tech-plan §4.7 第三行，F5）。
 *
 * 它**不是** `expireIn`：`expireIn` 的语义是「job 处于 active 的最长时间」，不是一个「排队等了多久」
 * 的计时器；更要紧的是排队中的任务根本没有 worker 在执行，想在 worker 里回「排队过长」在时序上就不可能。
 *
 * 所以闸门是一条**独立定时任务**（每分钟，见 definitions.ts 的 SCHEDULES）+ 一条直接扫表的 SQL：
 * `tasks.status='queued' and now()-queued_at > 10min` → 发「排队过长，请稍后」评论 + 取消 job +
 * `status='cancelled_queue'`。判定与 worker 是否存活无关。
 *
 * 本文件把「判定」写成可测的纯函数，把「扫表语句」写成常量：
 * 单测不需要数据库，`worker/` 只要把候选行喂进来就能断言边界。
 */
import { TASK_STATUS } from '../db/schema.ts';

/** 队列等待上限：10min（plan §9.1 第三行） */
export const QUEUE_WAIT_LIMIT_MINUTES = 10;

/** 同上，秒。SQL 里用 `make_interval(secs => $2)` 传参，避免把 10 分钟写死在语句里。 */
export const QUEUE_WAIT_LIMIT_SECONDS = QUEUE_WAIT_LIMIT_MINUTES * 60;

/** 每分钟批量处理的上限：一次跑太久会让下一分钟的定时任务撞上自己。 */
export const QUEUE_GATE_BATCH_LIMIT = 200;

/**
 * 扫表语句。
 *
 * 参数：`$1 = status`（`TASK_STATUS.queued`）、`$2 = 等待上限秒数`、`$3 = 批量上限`。
 * 严格大于（`>`）而不是 `>=`：§4.7 写的是 `now()-queued_at > 10min`，正好 10 分钟还不算超。
 * 走 `tasks_status_queued_at_idx (status, queued_at)` 索引。
 */
export const QUEUE_GATE_SQL = `SELECT "id", "repo", "target_kind", "target_number", "command", "queued_at"
FROM "tasks"
WHERE "status" = $1
  AND "queued_at" IS NOT NULL
  AND now() - "queued_at" > make_interval(secs => $2)
ORDER BY "queued_at"
LIMIT $3`;

/** 取消时要打的那条评论（隐藏标记由 github/ 的写执行器追加，见 §5.4「comment」行）。 */
export const QUEUE_GATE_COMMENT =
  '排队过长，请稍后（当前队列繁忙）。这条任务已被取消，需要时请重新触发。';

/** 闸门扫描出来的候选行（只带判定与评论需要的列）。 */
export type QueueGateCandidate = {
  readonly id: string;
  readonly repo: string;
  readonly targetKind: string;
  readonly targetNumber: number;
  readonly command: string;
  readonly queuedAt: Date | null;
  readonly status: string;
};

/** 已排队秒数；`queuedAt` 为空返回 0（没有入队时间就没有等待时长，不能靠猜）。 */
export function queueWaitSeconds(queuedAt: Date | null, now: Date): number {
  if (queuedAt === null) {
    return 0;
  }
  const elapsedMs = now.getTime() - queuedAt.getTime();
  return elapsedMs <= 0 ? 0 : Math.floor(elapsedMs / 1000);
}

/**
 * 单个任务是否该被闸门取消。
 *
 * 三个条件都必须成立：
 *  1. `status === 'queued'`（已开跑的、已结束的都不算——`running` 归任务级时间闸管）
 *  2. `queued_at` 非空（数据异常时保守放过，绝不因为一个 NULL 就取消任务）
 *  3. 等待秒数**严格大于**上限（600s 整不算超）
 */
export function isQueueTimedOut(
  task: { readonly status: string; readonly queuedAt: Date | null },
  now: Date,
  limitMinutes: number = QUEUE_WAIT_LIMIT_MINUTES,
): boolean {
  if (task.status !== TASK_STATUS.queued) {
    return false;
  }
  if (task.queuedAt === null) {
    return false;
  }
  return queueWaitSeconds(task.queuedAt, now) > limitMinutes * 60;
}

/** 闸门要执行的动作：改状态（由调用方 UPDATE）+ 评论（由 github/ 发）。 */
export type QueueGateAction = {
  readonly taskId: string;
  readonly repo: string;
  readonly targetKind: string;
  readonly targetNumber: number;
  readonly command: string;
  readonly waitedSeconds: number;
  /** 落库的新状态，固定 `cancelled_queue`（tech-plan §4.7 原文用了下划线） */
  readonly nextStatus: typeof TASK_STATUS.cancelledQueue;
  /** 评论正文（不含隐藏标记） */
  readonly comment: string;
};

/**
 * 从一批候选行里挑出要取消的，并给出动作。
 * 纯函数：`now` 由调用方传入，因此「10 分钟边界」可以精确断言。
 */
export function queueGateActions(
  candidates: readonly QueueGateCandidate[],
  now: Date,
  limitMinutes: number = QUEUE_WAIT_LIMIT_MINUTES,
): QueueGateAction[] {
  const actions: QueueGateAction[] = [];
  for (const candidate of candidates) {
    if (!isQueueTimedOut(candidate, now, limitMinutes)) {
      continue;
    }
    actions.push({
      taskId: candidate.id,
      repo: candidate.repo,
      targetKind: candidate.targetKind,
      targetNumber: candidate.targetNumber,
      command: candidate.command,
      waitedSeconds: queueWaitSeconds(candidate.queuedAt, now),
      nextStatus: TASK_STATUS.cancelledQueue,
      comment: QUEUE_GATE_COMMENT,
    });
  }
  return actions;
}

/** 更新语句：把状态改成 `cancelled_queue` 并写 `ended_at`（面板按 `ended_at` 算停留时长）。 */
export const QUEUE_GATE_CANCEL_SQL = `UPDATE "tasks"
SET "status" = $2, "ended_at" = now(), "updated_at" = now()
WHERE "id" = $1 AND "status" = $3`;
