/**
 * 排队闸门作业（`QUEUE.queueGate`，每分钟；tech-plan §4.7 第三行，F5）。
 *
 * 每分钟做四件事：
 *  1. 读每个仓库的 `settings.limits.queue_wait_minutes`（默认 10 分钟）；
 *  2. 用**最小的**阈值扫一遍 `tasks.status='queued'`（SQL 只做粗筛，走 `(status, queued_at)` 索引）；
 *  3. 在 JS 侧按**该仓库的**阈值精确判定（`isQueueTimedOut`），边界严格大于；
 *  4. 命中就 `status='cancelled_queue'` + 打一个 `confused` reaction（**零评论**，§0.4）。
 *
 * 为什么阈值放在这里读而不是写死在 SQL 里：`queue_wait_minutes` 是仓库级配置，
 * 一条 SQL 只能带一个 interval。用「最小阈值粗筛 + JS 精筛」换「一条 SQL 服务所有仓库」，
 * 代价是可能多扫几行（队列深度本来就只有几十），换来的是不需要按仓库分组跑 N 次。
 *
 * 取消 job 与打 reaction 都是**注入端口**：
 *  - `cancelJob`：pg-boss 的 `cancel`（`queue/cancelTaskJob`）；
 *  - `ack`：W2-D 的 reaction 状态机（`feedback/`）。不注入也不影响闸门的核心职责
 *    （把任务从 queued 拿掉），只是用户看不到角标，所以降级成 warning 而不是失败。
 */
import { TASK_STATUS } from '../db/schema.ts';
import {
  QUEUE_GATE_BATCH_LIMIT,
  QUEUE_GATE_CANCEL_SQL,
  QUEUE_GATE_SQL,
  QUEUE_WAIT_LIMIT_MINUTES,
  queueGateActions,
  queueWaitMinutesOf,
  smallestQueueWaitSeconds,
} from '../queue/index.ts';
import type { QueueGateCandidate, QueueGateReactionPort } from '../queue/index.ts';
import { JOB_NULL_LOGGER, finishJob, rowCountOf, systemClock } from './types.ts';
import type { JobClock, JobLogger, JobPool, JobResult } from './types.ts';

/** 读所有仓库的 settings（只取闸门要的那一个数字，见文件头）。 */
export const QUEUE_GATE_REPO_SETTINGS_SQL = `SELECT "repo_full_name", "settings" FROM "repos"`;

export type QueueGateDeps = {
  readonly pool: JobPool;
  readonly clock?: JobClock;
  readonly logger?: JobLogger;
  /** reaction 端口（与 `WebhookAck.addReaction` 同形）；不注入 → 只改状态。 */
  readonly ack?: QueueGateReactionPort;
  /** 取消排队中的 pg-boss job；不注入 → 只改库里的状态（worker 拿到会自己跳过）。 */
  readonly cancelJob?: (taskId: string) => Promise<boolean>;
  /** 单次扫描上限（缺省 `QUEUE_GATE_BATCH_LIMIT`）。 */
  readonly batchLimit?: number;
};

export type QueueGateStats = {
  /** 扫到的候选行数（粗筛后） */
  readonly scanned: number;
  /** 真正被改成 `cancelled_queue` 的行数 */
  readonly cancelled: number;
  /** 成功打上的 reaction 数 */
  readonly reactions: number;
  /** 成功取消的 pg-boss job 数 */
  readonly jobsCancelled: number;
  /** 参与判定的仓库数 */
  readonly repos: number;
};

/** 扫表结果的一行 → 判定用的候选（`pg` 给的是 snake_case）。 */
function toCandidate(row: Record<string, unknown>): QueueGateCandidate {
  const queuedAt = row['queued_at'];
  return {
    id: String(row['id']),
    repo: String(row['repo']),
    targetKind: String(row['target_kind']),
    targetNumber: Number(row['target_number']),
    command: String(row['command']),
    queuedAt: queuedAt instanceof Date ? queuedAt : null,
    // SQL 只扫 queued 的行，这里不必再从结果里读状态
    status: TASK_STATUS.queued,
  };
}

/** 每个仓库的阈值（分钟）。没有 settings 的仓库不出现在 map 里，由调用方回落到默认值。 */
async function readQueueWaitMinutes(pool: JobPool): Promise<Map<string, number>> {
  const result = await pool.query(QUEUE_GATE_REPO_SETTINGS_SQL);
  const minutes = new Map<string, number>();
  for (const item of result.rows) {
    const row = item as Record<string, unknown>;
    const repo = row['repo_full_name'];
    if (typeof repo !== 'string' || repo === '') {
      continue;
    }
    minutes.set(repo, queueWaitMinutesOf(row['settings']));
  }
  return minutes;
}

/**
 * 跑一轮闸门。纯在看库与写库，没有内部定时器：`registerJobs` 每分钟调一次。
 *
 * `options.now` 只为测试注入（阈值边界要能精确断言）；不传就用时钟。
 */
export async function queueGateSweep(
  deps: QueueGateDeps,
  options: { readonly now?: Date } = {},
): Promise<JobResult<QueueGateStats>> {
  const clock = deps.clock ?? systemClock;
  const startedAt = clock();
  const now = options.now ?? new Date(startedAt);
  const logger = deps.logger ?? JOB_NULL_LOGGER;
  const warnings: string[] = [];

  const minutesByRepo = await readQueueWaitMinutes(deps.pool);
  const limitOf = (repo: string): number => minutesByRepo.get(repo) ?? QUEUE_WAIT_LIMIT_MINUTES;
  const scanSeconds = smallestQueueWaitSeconds([...minutesByRepo.values()]);

  const scanned = await deps.pool.query(QUEUE_GATE_SQL, [
    TASK_STATUS.queued,
    scanSeconds,
    deps.batchLimit ?? QUEUE_GATE_BATCH_LIMIT,
  ]);
  const candidates = (scanned.rows as Array<Record<string, unknown>>).map(toCandidate);
  const actions = queueGateActions(candidates, now, limitOf);

  let cancelled = 0;
  let reactions = 0;
  let jobsCancelled = 0;

  for (const action of actions) {
    const updated = await deps.pool.query(QUEUE_GATE_CANCEL_SQL, [
      action.taskId,
      action.nextStatus,
      TASK_STATUS.queued,
    ]);
    if (rowCountOf(updated) === 0) {
      // 守卫没命中：这一行在扫描与更新之间已经开跑了（或被人改过）。不覆盖别人的状态。
      logger.info(
        { taskId: action.taskId, repo: action.repo },
        '排队闸门：任务状态已变化，跳过取消',
      );
      continue;
    }
    cancelled += 1;

    if (deps.cancelJob !== undefined) {
      try {
        if (await deps.cancelJob(action.taskId)) {
          jobsCancelled += 1;
        }
      } catch (error) {
        warnings.push(`取消 job 失败（task=${action.taskId}）：${describeError(error)}`);
      }
    }

    if (deps.ack?.addReaction !== undefined) {
      try {
        await deps.ack.addReaction({
          repo: action.repo,
          issueNumber: action.targetNumber,
          content: action.reaction,
        });
        reactions += 1;
      } catch (error) {
        // reaction 失败不该回滚「任务已被取消」的事实：任务已经被拿掉了，重跑闸门也没有补偿动作
        warnings.push(`打 reaction 失败（task=${action.taskId}）：${describeError(error)}`);
      }
    }
  }

  if (cancelled > 0 && deps.ack?.addReaction === undefined) {
    warnings.push('未注入 reaction 端口：队列超时的任务只改了状态，没有打 confused 角标');
  }

  const stats: QueueGateStats = {
    scanned: candidates.length,
    cancelled,
    reactions,
    jobsCancelled,
    repos: minutesByRepo.size,
  };
  if (cancelled > 0) {
    logger.info({ ...stats }, '排队闸门：取消排队超时的任务');
  }
  return finishJob('queue-gate', startedAt, clock, stats, warnings);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
