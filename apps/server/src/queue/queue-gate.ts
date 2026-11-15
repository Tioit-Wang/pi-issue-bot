/**
 * 排队闸门（tech-plan §4.7 第三行，F5；多仓库改造后阈值来自 `repos.settings.limits.queue_wait_minutes`）。
 *
 * 它**不是** `expireIn`：`expireIn` 的语义是「job 处于 active 的最长时间」，不是一个「排队等了多久」
 * 的计时器；更要紧的是排队中的任务根本没有 worker 在执行，想在 worker 里回「排队过长」在时序上就不可能。
 *
 * 所以闸门是一条**独立定时任务**（每分钟，见 `definitions.ts` 的 SCHEDULES）+ 一条直接扫表的 SQL：
 * `tasks.status='queued' and now()-queued_at > <repo 的 queue_wait_minutes>` →
 * `status='cancelled_queue'` + 打一个 `confused` reaction。
 *
 * **零评论**（`docs/impl-multi-repo.md` §0.4「无感反馈」）：原来的「排队过长，请稍后」评论已删除，
 * 用户看到的只是角标变化；明细在面板。reaction 的完整状态机（入队 eyes → 终态 rocket/confused、
 * 幂等台账）属 W2-D 的 `feedback/`，本文件只提供「闸门要打哪个 reaction」与注入端口。
 *
 * 本文件把「判定」写成可测的纯函数，把「扫表语句」写成常量：
 * 单测不需要数据库，`jobs/queue-gate.ts` 只要把候选行喂进来就能断言边界。
 */
import { TASK_STATUS } from '../db/schema.ts';

/** 队列等待上限的**默认值**：10min（plan §9.1 第三行）。仓库可在 settings 里覆盖。 */
export const QUEUE_WAIT_LIMIT_MINUTES = 10;

/** 同上，秒。SQL 里用 `make_interval(secs => $2)` 传参，避免把分钟数写死在语句里。 */
export const QUEUE_WAIT_LIMIT_SECONDS = QUEUE_WAIT_LIMIT_MINUTES * 60;

/** 每分钟批量处理的上限：一次跑太久会让下一分钟的定时任务撞上自己。 */
export const QUEUE_GATE_BATCH_LIMIT = 200;

/** 闸门取消任务时打的 reaction（`docs/impl-multi-repo.md` §0.3/§0.4：只打角标，不发评论）。 */
export const QUEUE_GATE_REACTION = 'confused' as const;

/**
 * 扫表语句。
 *
 * 参数：`$1 = status`（`TASK_STATUS.queued`）、`$2 = 等待上限秒数`、`$3 = 批量上限`。
 * 严格大于（`>`）而不是 `>=`：§4.7 写的是 `now()-queued_at > 10min`，正好 10 分钟还不算超。
 * 走 `tasks_status_queued_at_idx (status, queued_at)` 索引。
 *
 * 传进来的秒数是**所有仓库里最小的**那个阈值（见 `jobs/queue-gate.ts`）：SQL 只做粗筛，
 * 精确边界由 `isQueueTimedOut(candidate, now, 该仓库的阈值)` 在 JS 侧判定——
 * 一条 SQL 服务多个阈值，避免「按仓库分组跑 N 次全表扫描」。
 *
 * **排除「等槽」的任务（需求 §6.7 SL-2：并发触顶 = 排队等待、不丢弃）。**
 * 一个仓库已经在跑的任务数达到它的项目级并发上限时，它排队中的任务是在**等槽**，
 * 此时把它们判成 `cancelled_queue` 就是「触顶即丢弃」，直接违反需求。所以这一段用
 * `NOT EXISTS` 把「本仓库 running 数 >= 本仓库并发上限」的行整批排除在候选之外：
 * 只要还有槽位被占着，排队就继续排；等槽位空出来，任务照常被 worker 领走。
 *
 * 为什么把上限读在 SQL 里而不是 JS 侧：取消与否的判定发生在「哪些行是候选」这一层，
 * 而这个文件是候选集的唯一来源；在同一处读 `repos.settings` 才能保证
 * 「谁生效」与 `concurrencyPerRepoOf()` 完全一致（v2.1 的 `agent.limits.concurrency`
 * 优先，老键 `limits.concurrency_per_repo` 只兜底，都没有就 2）。
 * `jsonb_typeof(...) = 'number'` 是必要的守卫：直接 `::int` 会在手改库写成字符串时抛错，
 * 而排队闸门必须**永远能工作**（宁可这一轮不取消，也不能让整条定时任务失败）。
 */
export const QUEUE_GATE_SQL = `SELECT "id", "repo", "target_kind", "target_number", "command", "queued_at"
FROM "tasks"
WHERE "status" = $1
  AND "queued_at" IS NOT NULL
  AND now() - "queued_at" > make_interval(secs => $2)
  AND NOT EXISTS (
    SELECT 1
    FROM "tasks" "running"
    -- LEFT JOIN 而非 JOIN：repos 表里没有这一行时也要有「默认 2」的读数，
    -- 否则等槽保护直接落空（那种仓库的排队行会被当成超时取消）
    LEFT JOIN "repos" "cfg" ON "cfg"."repo_full_name" = "running"."repo"
    WHERE "running"."status" = 'running'
      AND "running"."repo" = "tasks"."repo"
    GROUP BY "cfg"."settings"
    HAVING count(*) >= GREATEST(
      1,
      LEAST(
        8,
        CASE
          WHEN jsonb_typeof("cfg"."settings" #> '{agent,limits,concurrency}') = 'number'
            THEN ("cfg"."settings" #>> '{agent,limits,concurrency}')::int
          WHEN jsonb_typeof("cfg"."settings" #> '{limits,concurrency_per_repo}') = 'number'
            THEN ("cfg"."settings" #>> '{limits,concurrency_per_repo}')::int
          ELSE 2
        END
      )
    )
  )
ORDER BY "queued_at"
LIMIT $3`;

/** 闸门扫描出来的候选行（只带判定与取消需要的列）。 */
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
 * 阈值可以是一个数字（全局同一条线）或「按仓库取」的函数。
 *
 * 多仓库之后后者是常态：`settings.limits.queue_wait_minutes` 是**仓库级**配置，
 * 一个仓库允许等 30 分钟不该让另一个仓库的 3 分钟阈值失效。
 */
export type QueueWaitLimit = number | ((repo: string) => number);

/** 取某个仓库的阈值（`limit` 是函数就按仓库算，是数字就照用）。 */
export function resolveQueueWaitMinutes(limit: QueueWaitLimit, repo: string): number {
  return typeof limit === 'function' ? limit(repo) : limit;
}

/**
 * 单个任务是否该被闸门取消。
 *
 * 三个条件都必须成立：
 *  1. `status === 'queued'`（已开跑的、已结束的都不算——`running` 归任务级时间闸管）
 *  2. `queued_at` 非空（数据异常时保守放过，绝不因为一个 NULL 就取消任务）
 *  3. 等待秒数**严格大于**该仓库的上限（600s 整不算超）
 */
export function isQueueTimedOut(
  task: { readonly status: string; readonly queuedAt: Date | null; readonly repo?: string },
  now: Date,
  limit: QueueWaitLimit = QUEUE_WAIT_LIMIT_MINUTES,
): boolean {
  if (task.status !== TASK_STATUS.queued) {
    return false;
  }
  if (task.queuedAt === null) {
    return false;
  }
  const minutes = resolveQueueWaitMinutes(limit, task.repo ?? '');
  return queueWaitSeconds(task.queuedAt, now) > minutes * 60;
}

/**
 * 闸门要执行的动作：改状态（由调用方 UPDATE）+ 打一个 reaction（由注入的 ack 端口发）。
 *
 * 没有 `comment` 字段是有意的：闸门属于自动通道，**只允许零评论**（§0.4）。
 */
export type QueueGateAction = {
  readonly taskId: string;
  readonly repo: string;
  readonly targetKind: string;
  readonly targetNumber: number;
  readonly command: string;
  readonly waitedSeconds: number;
  /** 落库的新状态，固定 `cancelled_queue`（tech-plan §4.7 原文用了下划线） */
  readonly nextStatus: typeof TASK_STATUS.cancelledQueue;
  /** 要打的 reaction（固定 `confused`；文案已删除） */
  readonly reaction: typeof QUEUE_GATE_REACTION;
};

/**
 * 从一批候选行里挑出要取消的，并给出动作。
 * 纯函数：`now` 由调用方传入，因此「阈值边界」可以精确断言。
 */
export function queueGateActions(
  candidates: readonly QueueGateCandidate[],
  now: Date,
  limit: QueueWaitLimit = QUEUE_WAIT_LIMIT_MINUTES,
): QueueGateAction[] {
  const actions: QueueGateAction[] = [];
  for (const candidate of candidates) {
    if (!isQueueTimedOut(candidate, now, limit)) {
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
      reaction: QUEUE_GATE_REACTION,
    });
  }
  return actions;
}

/** 更新语句：把状态改成 `cancelled_queue` 并写 `ended_at`（面板按 `ended_at` 算停留时长）。 */
export const QUEUE_GATE_CANCEL_SQL = `UPDATE "tasks"
SET "status" = $2, "ended_at" = now(), "updated_at" = now()
WHERE "id" = $1 AND "status" = $3`;

/**
 * 打 reaction 的注入端口（与 `http/webhook.ts` 的 `WebhookAck.addReaction` 同形）。
 *
 * 为什么在这里再声明一次而不是 import `http/`：`queue/` 与 `jobs/` 不许依赖 `http/`
 * （tech-plan §8.2 的依赖方向）。两处结构一致，所以真实的 ack 对象可以直接传进来。
 */
export type QueueGateReactionPort = {
  readonly addReaction?: (input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly commentId?: number | null;
    readonly content: string;
  }) => Promise<void>;
};

/* ── settings.limits 的读取（jsonb → 数字）────────────────────────────────── */

/**
 * 从 `repos.settings` 里读 `limits.queue_wait_minutes`。
 *
 * 为什么不用 `repoSettingsSchema` 解析：闸门只关心一个数字，整份 schema 解析失败
 * （settings_valid=false 时库里是 last-known-good，但开发态可能被手改坏）不该让
 * 「所有任务永远不被取消」——读不到就用默认 10 分钟，闸门必须始终能工作。
 */
export function queueWaitMinutesOf(settings: unknown): number {
  if (typeof settings !== 'object' || settings === null) {
    return QUEUE_WAIT_LIMIT_MINUTES;
  }
  const limits = (settings as { limits?: unknown }).limits;
  if (typeof limits !== 'object' || limits === null) {
    return QUEUE_WAIT_LIMIT_MINUTES;
  }
  const value = (limits as { queue_wait_minutes?: unknown }).queue_wait_minutes;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return QUEUE_WAIT_LIMIT_MINUTES;
  }
  return Math.trunc(value);
}

/** 一批仓库阈值里最小的那个（SQL 粗筛用）；没有仓库时回落到默认值。 */
export function smallestQueueWaitSeconds(minutes: readonly number[]): number {
  if (minutes.length === 0) {
    return QUEUE_WAIT_LIMIT_SECONDS;
  }
  return Math.min(...minutes) * 60;
}
/* ── 满载导致的永久挂起：只做可观测（需求 §6.7 SL-2「排队等待、不丢弃」的代价）────────── */

/**
 * 一次最多报多少个「被本仓库满载挡住」的仓库。
 *
 * 这不是业务限额，是日志上限：一个仓库一个聚合行，正常只有个位数；
 * 留一个上限是为了「有人手工造了上百个仓库配置」时也不会把日志刷爆。
 */
export const QUEUE_GATE_STARVATION_BATCH_LIMIT = 20;

/**
 * 「排队行因**本仓库满载**被 `QUEUE_GATE_SQL` 排除、且已等待超过粗筛阈值」的聚合查询。
 *
 * 为什么需要它：`NOT EXISTS` 保护让等槽的任务不被取消 —— 这是需求要的「触顶排队、不丢弃」，
 * 但代价是**某个仓库真的永久满载**时（任务卡在 `running` 却没人推进），它的排队行会被永远
 * 排除在候选之外，闸门一声不响。运维需要一条能被告警的痕迹，而不是事后从「任务怎么排了三小时」
 * 里倒推。这条查询**只读**：不取消、不改状态，命中与否都不影响 `QUEUE_GATE_SQL` 的判定。
 *
 * 参数：`$1 = status`（`TASK_STATUS.queued`）、`$2 = 粗筛秒数`（所有仓库阈值里最小的那个，
 * 与 `QUEUE_GATE_SQL` 同一个值）、`$3 = 批量上限`。粗筛条件与并发上限读数（新键 → 老键 → 2）
 * 都刻意与 `QUEUE_GATE_SQL` 保持一致：两处指的必须是同一批行，否则告警数与实际被挡的行数对不上。
 *
 * 返回的列全部在 SQL 里转成数字（`count(*)::int`、`floor(extract(epoch ...))::int`），
 * 避免 `pg` 把 interval 变成对象再在 JS 侧猜格式：
 *  - `repo`：仓库全名
 *  - `waiting`：被挡住的排队行数
 *  - `max_wait_seconds`：其中最长的一条等了多久（= 最早那条 `queued_at` 的等待秒数）
 *  - `running`：该仓库当前 `running` 行数
 *  - `limit_value`：该仓库的并发上限
 */
export const QUEUE_GATE_STARVATION_SQL = `SELECT "w"."repo" AS "repo",
  "w"."waiting" AS "waiting",
  "w"."max_wait_seconds" AS "max_wait_seconds",
  "cap"."running" AS "running",
  "cap"."limit_value" AS "limit_value"
FROM (
  SELECT "t"."repo" AS "repo",
    count(*)::int AS "waiting",
    floor(extract(epoch FROM (now() - min("t"."queued_at"))))::int AS "max_wait_seconds"
  FROM "tasks" "t"
  WHERE "t"."status" = $1
    AND "t"."queued_at" IS NOT NULL
    AND now() - "t"."queued_at" > make_interval(secs => $2)
  GROUP BY "t"."repo"
) "w"
JOIN LATERAL (
  SELECT count(*)::int AS "running",
    -- 与 QUEUE_GATE_SQL 完全同源：新键 → 老键 → 2，且夹到 1–8；
    -- COALESCE(..., 2) 让「repos 表里没有这一行」也算默认 2，与 JS 侧 concurrencyPerRepoOf(null) 一致
    COALESCE(
      (
        SELECT GREATEST(
          1,
          LEAST(
            8,
            CASE
              WHEN jsonb_typeof("cfg"."settings" #> '{agent,limits,concurrency}') = 'number'
                THEN ("cfg"."settings" #>> '{agent,limits,concurrency}')::int
              WHEN jsonb_typeof("cfg"."settings" #> '{limits,concurrency_per_repo}') = 'number'
                THEN ("cfg"."settings" #>> '{limits,concurrency_per_repo}')::int
              ELSE 2
            END
          )
        )
        FROM "repos" "cfg"
        WHERE "cfg"."repo_full_name" = "w"."repo"
      ),
      2
    ) AS "limit_value"
  FROM "tasks" "r"
  WHERE "r"."status" = 'running' AND "r"."repo" = "w"."repo"
) "cap" ON true
WHERE "cap"."running" >= "cap"."limit_value"
ORDER BY "w"."max_wait_seconds" DESC
LIMIT $3`;

/** `QUEUE_GATE_STARVATION_SQL` 的一行：一个被本仓库满载挡住的仓库。 */
export type QueueGateStarvedRepo = {
  readonly repo: string;
  /** 被挡住的排队行数 */
  readonly waiting: number;
  /** 其中最早那条已经等了多少秒 */
  readonly maxWaitSeconds: number;
  /** 该仓库当前 `running` 行数 */
  readonly running: number;
  /** 该仓库的并发上限（与 `concurrencyPerRepoOf()` 同优先级：新键 → 老键 → 2） */
  readonly limit: number;
};

/**
 * 判断一条满载聚合是否值得报警；值得就原样返回（供结构化日志直接落字段），否则 `null`。
 *
 * 判据与「取消」用的是**同一条线**：最长等待**严格大于**该仓库的 `queue_wait_minutes`。
 * 换算成人话就是「这条本来该被闸门取消，只因为仓库满载才留着」—— 那正是要报警的现场；
 * 刚开始等、或者只是短暂满载的仓库不该刷日志。
 */
export function starvationWarningOf(
  row: QueueGateStarvedRepo,
  limitMinutes: number,
): QueueGateStarvedRepo | null {
  if (!Number.isFinite(row.maxWaitSeconds) || row.maxWaitSeconds <= 0) {
    // 没有等待时长就没有「卡住」的证据（与 isQueueTimedOut 对 queued_at 为空的保守口径一致）
    return null;
  }
  return row.maxWaitSeconds > limitMinutes * 60 ? row : null;
}
