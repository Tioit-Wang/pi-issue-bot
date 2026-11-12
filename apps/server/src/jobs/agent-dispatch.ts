/**
 * agent 串行调度作业（`QUEUE.agentDispatch`，每分钟兜底；dev-plan §2.1）。
 *
 * 真正干活的是 `agent/dispatcher.ts::dispatchAgentMessages()`；本文件只做三件事，
 * 让它长成和别的定时作业一样的形状（`(deps, options?) => Promise<JobResult>`）：
 *  1. **不注入端口就跳过**：没有 `enqueue`（拿不到 pg-boss）时返回 `warnings` 而不是抛错 ——
 *     定时作业抛错会按 `QUEUES` 的 retryLimit 重试，而「没配端口」重试一万次也不会好；
 *  2. **异常不外抛**（`dispatchAgentMessages` 里单条投递失败已经就地置 `failed`）：
 *     整轮抛错说明库不可用，那本来就该让 pg-boss 记一次失败并重试；
 *  3. 把三轮计数写进 `stats`，面板/日志能看见「这一轮领了几条、投了几条、失败几条」。
 */
import { dispatchAgentMessages } from '../agent/index.ts';
import type { AgentDispatchDeps, AgentDispatchResult } from '../agent/index.ts';
import { JOB_NULL_LOGGER, finishJob, systemClock } from './types.ts';
import type { JobClock, JobLogger, JobPool, JobResult } from './types.ts';

export type AgentDispatchJobDeps = {
  readonly pool: JobPool;
  readonly clock?: JobClock;
  readonly logger?: JobLogger;
  /**
   * 投递通道（装配层接线到 `queue/boss.ts::enqueueTask`）。
   * 不给 = 本进程没有队列（单测 / 只读部署）：作业跳过并记一条 warning。
   */
  readonly enqueue?: AgentDispatchDeps['enqueue'] | undefined;
  /** 一轮最多处理多少个 issue（缺省 `AGENT_DISPATCH_MAX_ISSUES`）。 */
  readonly maxIssues?: number | undefined;
  /** 任务 id 生成器（测试注入固定值）。 */
  readonly newTaskId?: (() => string) | undefined;
};

export type AgentDispatchJobStats = {
  /** 有待处理消息的 issue 数 */
  readonly issues: number;
  readonly claimed: number;
  readonly enqueued: number;
  readonly failed: number;
  /** 是否因为没注入 `enqueue` 而跳过（`1` = 跳过） */
  readonly skipped: number;
};

/** 跑一轮调度。 */
export async function agentDispatchJob(
  deps: AgentDispatchJobDeps,
  options: { readonly maxIssues?: number | undefined } = {},
): Promise<JobResult<AgentDispatchJobStats>> {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger ?? JOB_NULL_LOGGER;
  const startedAtMs = clock();

  if (deps.enqueue === undefined) {
    logger.warn({ job: 'agent-dispatch' }, 'agent 调度跳过：未注入 enqueue（本进程没有队列）');
    return finishJob(
      'agent-dispatch',
      startedAtMs,
      clock,
      { issues: 0, claimed: 0, enqueued: 0, failed: 0, skipped: 1 },
      ['未注入 enqueue：agent 调度跳过'],
    );
  }

  const maxIssues = options.maxIssues ?? deps.maxIssues;
  const result: AgentDispatchResult = await dispatchAgentMessages({
    // `JobPool.query` 的入参是可变数组、`SqlRunner` 是 `readonly unknown[]`：语义完全相同，
    // 只是 `pg` 的泛型签名让两者不能直接赋值，这里显式桥接（运行期是同一个 `pool.query`）。
    db: deps.pool as unknown as AgentDispatchDeps['db'],
    enqueue: deps.enqueue,
    logger: {
      info: (detail, message) => {
        logger.info(detail, message);
      },
      warn: (detail, message) => {
        logger.warn(detail, message);
      },
    },
    ...(maxIssues === undefined ? {} : { maxIssues }),
    ...(deps.newTaskId === undefined ? {} : { newTaskId: deps.newTaskId }),
  });

  return finishJob('agent-dispatch', startedAtMs, clock, {
    issues: result.claimed,
    claimed: result.claimed,
    enqueued: result.enqueued,
    failed: result.failed,
    skipped: 0,
  });
}
