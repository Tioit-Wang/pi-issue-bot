/**
 * pg-boss 封装（tech-plan §7.1、§5.3 第 7 步）。
 *
 * 设计原则：**boss 实例一律从外部传入**。本模块只在 `createBoss()` 里 `new PgBoss(...)`，
 * 其余函数都吃一个「结构性最小接口」（`QueueBoss` / `WorkBoss` / `QueueAdminBoss`），
 * 于是单测可以塞假对象——不连库、不拉起 pg-boss 的后台线程（dev-plan §13.4 第 5 条）。
 *
 * pg-boss 12 与本仓库命名差异（一次性说明，别处不再解释）：
 *  - `expireIn`（分钟，v9/v10）→ **`expireInSeconds`**（秒）
 *  - `retryDelay` 单位是秒；`retryBackoff` 是布尔
 *  - `send()` 返回值是 job id（`string | null`；被 `singletonKey` 去重时返回 null）
 *  - `work()` 的 handler 收到的是**数组**（`batchSize` 默认 1），所以这里包一层再交给业务
 */
import { PgBoss } from 'pg-boss';
import type { SendOptions } from 'pg-boss';
import { QUEUE, expireInSecondsForCommand, ensureQueues, queueSpecOf, registerSchedules } from './definitions.ts';
import type { QueueAdminBoss, ScheduleAdminBoss } from './definitions.ts';
import { toSendOptions } from './retry-policy.ts';
import type { RetryDecision } from './retry-policy.ts';

/** 建 boss 的参数：DSN 由入口传入（本模块不读 env）。 */
export type CreateBossOptions = {
  connectionString: string;
  /** pg-boss 自己的 schema；与业务表分开放（§7.2「两套互不干扰」） */
  schema?: string;
  /** pg-boss 连接池上限；默认 4（队列并发上限就是 3，再多也是空转） */
  max?: number;
  /** 进 `pg_stat_activity.application_name` */
  applicationName?: string;
};

const DEFAULT_BOSS_SCHEMA = 'pgboss';
const DEFAULT_BOSS_MAX = 4;

/** 构造 boss（**不** start：连库与建表在 `startBoss()` 里发生，入口决定时机）。 */
export function createBoss(options: CreateBossOptions): PgBoss {
  return new PgBoss({
    connectionString: options.connectionString,
    schema: options.schema ?? DEFAULT_BOSS_SCHEMA,
    max: options.max ?? DEFAULT_BOSS_MAX,
    application_name: options.applicationName ?? 'pi-bot-queue',
  });
}

/** 启动 boss（内部会建 `pgboss` schema 与表；再调 `ensureQueues` 建我们自己的队列）。 */
export async function startBoss(boss: PgBoss): Promise<PgBoss> {
  return boss.start();
}

/** 优雅停机：等手上的 job 结束（最长 30s），再关池。 */
export async function stopBoss(boss: PgBoss): Promise<void> {
  await boss.stop({ graceful: true, timeout: 30_000 });
}

/**
 * 启动自检一步到位：建队列 + 注册定时任务。
 * 顺序有讲究：先 `ensureQueues`（队列不存在时 `schedule` 会失败），再注册 cron。
 */
export async function bootstrapQueue(
  boss: QueueAdminBoss & ScheduleAdminBoss,
  logger?: { info: (message: string) => void },
): Promise<{ created: readonly string[]; existing: readonly string[]; scheduled: readonly string[] }> {
  const { created, existing } = await ensureQueues(boss, logger);
  const scheduled = await registerSchedules(boss, undefined, logger);
  return { created, existing, scheduled };
}

/* ── 任务 job 的载荷与入队 ──────────────────────────────────────────────────── */

/** `run-task` 的载荷。只放定位信息，任务本体在 `tasks` 表里（队列不做业务存储）。 */
export type RunTaskJobData = {
  /** `tasks.id`，同时是 pg-boss 的 `singletonKey` */
  readonly taskId: string;
  /** 命令名，决定 `expireInSeconds`（20min / 30min） */
  readonly command: string;
  readonly repo: string;
  /** 已完成的尝试次数（重投时 +1，与 `retry-policy.ts` 的 `attempt` 同口径） */
  readonly attempt?: number;
};

/** pg-boss 的 job 形状（只需 id + data）。 */
export type QueueJob<T> = {
  readonly id: string;
  readonly data: T;
};

/** `send` / `cancel` / `findJobs` 的最小接口。 */
export type QueueBoss = {
  send: (name: string, data: object | null, options?: SendOptions) => Promise<string | null>;
  cancel: (name: string, id: string | string[]) => Promise<unknown>;
  findJobs: (
    name: string,
    options: { key?: string; queued?: boolean; limit?: number },
  ) => Promise<readonly { id: string }[]>;
};

/** `work` 的最小接口。 */
export type WorkBoss = {
  work: (
    name: string,
    options: { localConcurrency: number },
    handler: (jobs: readonly QueueJob<RunTaskJobData>[]) => Promise<void>,
  ) => Promise<string>;
};

/**
 * 入队选项（§5.3 第 7 步）：
 *  - `singletonKey = taskId`：任务已在队列里就不再入队，覆盖「第 3 步之后、第 6 步之前崩溃」的窗口
 *  - `expireInSeconds`：执行期硬上限（默认 20min，`/review-pr` 30min）
 *  - `retryLimit: 0`：自动重试一律关掉，重试由 `decideRetry()` 显式决定（§7.3 F6）
 */
export function queueJobOptions(taskId: string, command: string): SendOptions {
  return {
    singletonKey: taskId,
    expireInSeconds: expireInSecondsForCommand(command),
    retryLimit: 0,
  };
}

/** 入队一个任务 job。返回 job id；被 `singletonKey` 去重时返回 null（调用方按「已在队列」处理）。 */
export async function enqueueTask(boss: QueueBoss, data: RunTaskJobData): Promise<string | null> {
  return boss.send(QUEUE.runTask, data, queueJobOptions(data.taskId, data.command));
}

/**
 * 按重试决策重投。
 *
 * - `retry: false` → 不入队，返回 null（异常兜底由调用方做：评论/通知，不占队列）
 * - `mode: 'start-after'`（429）→ `startAfter` 秒后重投，`retryLimit: 0`（重投次数由 attempt 计数管）
 * - `mode: 'pgboss-retry'`（5xx / crash）→ 带上 `retryLimit/retryDelay/retryBackoff`
 *
 * 注意 `singletonKey` 仍然用**同一个 taskId**：同一任务的重投不该在队列里堆两份；
 * `attempt` 放在载荷里，让 worker 知道这是第几次尝试。
 */
export async function enqueueRetry(
  boss: QueueBoss,
  data: RunTaskJobData,
  decision: RetryDecision,
): Promise<string | null> {
  if (!decision.retry) {
    return null;
  }
  const options: SendOptions = {
    ...queueJobOptions(data.taskId, data.command),
    ...toSendOptions(decision),
  };
  // 重投的载荷里 attempt +1（`attempt` 缺省视为第一次已跑完）
  const payload: RunTaskJobData = { ...data, attempt: (data.attempt ?? 0) + 1 };
  return boss.send(QUEUE.runTask, payload, options);
}

/** 找队列里该任务对应的 job id（`singletonKey` 是 taskId，但 `cancel` 要 job id）。 */
export async function findTaskJobId(boss: QueueBoss, taskId: string): Promise<string | null> {
  const jobs = await boss.findJobs(QUEUE.runTask, { key: taskId, queued: true, limit: 1 });
  return jobs[0]?.id ?? null;
}

/**
 * 取消排队中的任务（排队闸门用，§4.7）。
 * 返回是否真的取消了一个 job：任务可能已经跑完或压根没入队，那不是错误。
 */
export async function cancelTaskJob(boss: QueueBoss, taskId: string): Promise<boolean> {
  const jobId = await findTaskJobId(boss, taskId);
  if (jobId === null) {
    return false;
  }
  await boss.cancel(QUEUE.runTask, jobId);
  return true;
}

/** 业务侧拿到的 job：只要 id 与 data。 */
export type TaskJob = {
  readonly id: string;
  readonly data: RunTaskJobData;
};

export type TaskJobHandler = (job: TaskJob) => Promise<void>;

/**
 * 注册 `run-task` 的 worker。
 *
 * 并发取 `QUEUES` 里 `run-task` 的 `concurrency`（3），并把 pg-boss 的批量 handler 收窄成
 * 「一次一个任务」——批量并发在 pg-boss 内部已经是 `localConcurrency` 个 worker，
 * 再在 handler 里并行跑只会让容器并发失控（§6.1 每个容器 2 CPU / 2 GB 是硬约束）。
 */
export async function registerTaskWorker(
  boss: WorkBoss,
  handler: TaskJobHandler,
  concurrency: number = queueSpecOf(QUEUE.runTask).concurrency,
): Promise<string> {
  return boss.work(QUEUE.runTask, { localConcurrency: concurrency }, async (jobs) => {
    for (const job of jobs) {
      await handler({ id: job.id, data: job.data });
    }
  });
}

/** 注册定时任务队列的 worker（每次取到 job 就跑一次回调；并发固定 1，见 QUEUES）。 */
export async function registerScheduleWorker(
  boss: WorkBoss,
  queueName: string,
  handler: () => Promise<void>,
): Promise<string> {
  return boss.work(queueName, { localConcurrency: 1 }, async () => {
    await handler();
  });
}
