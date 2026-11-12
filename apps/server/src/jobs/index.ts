/**
 * `jobs/` 的公共出口：五个定时作业 + 一个注册便捷函数（tech-plan §7.5 / §7.6 / §6.3；排队闸门见 §4.7）。
 *
 * 与队列的对应关系**只认 `queue/SCHEDULES`**（队列名是本仓库的单一事实源）：
 *
 * | 队列（`QUEUE.*`）      | 定时（UTC）      | 作业                  |
 * |------------------------|------------------|-----------------------|
 * | `queue-gate`           | `* * * * *`      | `queueGateSweep`      |
 * | `metrics-rollup`       | `10 0 * * *`     | `metricsRollup`       |
 * | `reconcile`            | `0 * * * *`      | `reconcileReverts`    |
 * | `retention-cleanup`    | `40 0 * * *`     | `retentionCleanup`    |
 * | `lifecycle-cleanup`    | `* * * * *`      | `lifecycleSweep`      |
 *
 * 为什么要 `registerJobs()`：队列名、并发、`expireInSeconds` 已经在 `queue/definitions.ts` 定好了，
 * 入口只该说「这几个队列由这几个函数处理」。映射写在这里，队列名拼错就编译不过（`QUEUE.*` 是常量）。
 */
import { QUEUE, registerScheduleWorker as defaultRegisterScheduleWorker } from '../queue/index.ts';
import type { QueueGateReactionPort, WorkBoss } from '../queue/index.ts';
import type { GithubClient } from '../github/index.ts';
import type {
  EndpointReaper,
  RetentionPolicy,
  SandboxDocker,
  TrackedContainer,
  createLifecycleExecutor,
  planSweep,
} from '../sandbox/index.ts';
import type { JobClock, JobLogger, JobName, JobPool, JobResult } from './types.ts';
import { JOB_NULL_LOGGER } from './types.ts';
import { metricsRollup } from './metrics-rollup.ts';
import { reconcileReverts } from './reconcile-reverts.ts';
import { retentionCleanup } from './retention-cleanup.ts';
import { lifecycleSweep } from './lifecycle-sweep.ts';
import type { WorktreeReaper } from './lifecycle-sweep.ts';
import { queueGateSweep } from './queue-gate.ts';
import type { QueueGateDeps } from './queue-gate.ts';
import { agentDispatchJob } from './agent-dispatch.ts';
import type { AgentDispatchJobDeps } from './agent-dispatch.ts';
export { agentDispatchJob } from './agent-dispatch.ts';
export type { AgentDispatchJobDeps, AgentDispatchJobStats } from './agent-dispatch.ts';
export { metricsRollup, resolveRollupDays, ROLLUP_DEFAULT_OFFSET_DAYS } from './metrics-rollup.ts';
export type {
  MetricsDailySnapshot,
  MetricsRollupDeps,
  MetricsRollupOptions,
  MetricsRollupStats,
} from './metrics-rollup.ts';

export {
  RECONCILE_BATCH_LIMIT,
  RECONCILE_WINDOW_DAYS,
  REVERT_KINDS,
  parseActionTarget,
  reconcileReverts,
} from './reconcile-reverts.ts';
export type {
  ReconcileCandidate,
  ReconcileRevertsDeps,
  ReconcileRevertsOptions,
  ReconcileRevertsStats,
  RevertKind,
} from './reconcile-reverts.ts';

export { RETENTION_BATCH_SIZE, RETENTION_DAYS, retentionCleanup } from './retention-cleanup.ts';
export type {
  RetentionCleanupDeps,
  RetentionCleanupOptions,
  RetentionCleanupStats,
} from './retention-cleanup.ts';

export { lifecycleSweep, listTrackedContainers, planWorktreeSweep } from './lifecycle-sweep.ts';
export type {
  LifecycleSweepDeps,
  LifecycleSweepOptions,
  LifecycleSweepStats,
  WorktreeCandidate,
  WorktreeReaper,
  WorktreeSweepPlan,
} from './lifecycle-sweep.ts';

export { QUEUE_GATE_REPO_SETTINGS_SQL, queueGateSweep } from './queue-gate.ts';
export type { QueueGateDeps, QueueGateStats } from './queue-gate.ts';

export { JOB_NULL_LOGGER } from './types.ts';
export type { JobClock, JobLogger, JobName, JobPool, JobResult, JobStatValue, JobStats } from './types.ts';

/** 注册一个定时队列的 worker（`queue/boss.ts` 的 `registerScheduleWorker` 的形状）。 */
export type ScheduleRegistrar = (
  boss: WorkBoss,
  queueName: string,
  handler: () => Promise<void>,
) => Promise<string>;

/** 定时作业的调用形状：不带参数跑一轮（补跑走各作业自己的 `options`）。 */
export type JobRunner = () => Promise<JobResult>;

/** 注册表的一行：队列名 → 作业 + 它需要的注入依赖。 */
export type JobScheduleEntry = {
  readonly queue: string;
  readonly job: JobName;
  /** 缺这个依赖就跳过注册（例如没有 docker 的开发机不注册生命周期清扫）。 */
  readonly requires?: 'github' | 'docker';
};

/** 队列 ↔ 作业的映射（**队列名以 `queue/SCHEDULES` 为准**）。 */
export const JOB_SCHEDULES: readonly JobScheduleEntry[] = Object.freeze([
  // 排队闸门排最前：它只做「把排队太久的任务拿掉」，越早跑越早释放槽位
  { queue: QUEUE.queueGate, job: 'queue-gate' },
  { queue: QUEUE.metricsRollup, job: 'metrics-rollup' },
  { queue: QUEUE.reconcile, job: 'reconcile-reverts', requires: 'github' },
  { queue: QUEUE.retentionCleanup, job: 'retention-cleanup' },
  { queue: QUEUE.lifecycleCleanup, job: 'lifecycle-sweep', requires: 'docker' },
  // agent 串行调度排最后：它是兜底（主路径是 webhook 落库后立刻领一条 + 任务结束立刻取下一条）
  { queue: QUEUE.agentDispatch, job: 'agent-dispatch' },
]);

/** 五个作业需要的全部注入点（各作业只取自己用到的那些）。 */
export type JobDeps = {
  readonly pool: JobPool;
  readonly clock?: JobClock;
  readonly logger?: JobLogger;
  /** 生命周期清扫用：docker 窄接口。 */
  readonly docker?: SandboxDocker;
  /** 改回对账用：GitHub 读接口（只需要 `request`）。 */
  readonly github?: Pick<GithubClient, 'request'>;
  /** 生命周期清扫用：exec 代理端点清理。 */
  readonly proxy?: EndpointReaper;
  /** 生命周期清扫用：worktree 回收端口。 */
  readonly worktreeReaper?: WorktreeReaper;
  readonly policy?: RetentionPolicy;
  readonly diskPath?: string;
  readonly planSweep?: typeof planSweep;
  readonly createExecutor?: typeof createLifecycleExecutor;
  readonly readDiskUsageRatio?: (path: string) => Promise<number>;
  readonly listContainers?: () => Promise<readonly TrackedContainer[]>;
  /**
   * 排队闸门用：reaction 端口（W2-D 的 `feedback/`，与 `WebhookAck.addReaction` 同形）。
   * 不注入 = 任务照样被取消，只是没有 `confused` 角标（闸门会记一条 warning）。
   */
  readonly gateAck?: QueueGateReactionPort;
  /** 排队闸门用：取消排队中的 pg-boss job（`queue/cancelTaskJob`）。不注入 = 只改库里的状态。 */
  readonly cancelTaskJob?: (taskId: string) => Promise<boolean>;
  /**
   * agent 调度用：投递通道（`queue/boss.ts::enqueueTask`）。不注入 = 该作业跳过并记一条 warning
   * （没有队列的进程不该每轮抛错）。
   */
  readonly agentEnqueue?: AgentDispatchJobDeps['enqueue'] | undefined;
  /** agent 调度用：一轮最多处理多少个 issue。 */
  readonly agentMaxIssues?: number | undefined;
};

/** 把注入点绑成五个「跑一轮」的函数（不碰队列，测试与脚本直接调）。 */
export function createJobRunners(deps: JobDeps): Readonly<Record<JobName, JobRunner>> {
  return {
    'metrics-rollup': () => metricsRollup(pickRollupDeps(deps)),
    'reconcile-reverts': () => {
      if (deps.github === undefined) {
        throw new Error('jobs/reconcile-reverts：缺少 github 注入');
      }
      return reconcileReverts({ ...pickCommonDeps(deps), github: deps.github });
    },
    'retention-cleanup': () => retentionCleanup(pickCommonDeps(deps)),
    'lifecycle-sweep': () => {
      if (deps.docker === undefined) {
        throw new Error('jobs/lifecycle-sweep：缺少 docker 注入');
      }
      return lifecycleSweep(pickLifecycleDeps(deps, deps.docker));
    },
    'queue-gate': () => queueGateSweep(pickQueueGateDeps(deps)),
    'agent-dispatch': () => agentDispatchJob(pickAgentDispatchDeps(deps)),
  };
}

/**
 * 注册五个定时作业的 worker。
 *
 * 顺序与 `JOB_SCHEDULES` 一致（metrics 在 retention 之前：保留期清理依赖前者的产物）。
 * 缺依赖的条目**跳过并告警**而不是抛错——本机开发没有 docker 时其余三个仍应能跑。
 * 返回已注册的队列名（便于启动日志核对「五个都在」）。
 */
export async function registerJobs(
  boss: WorkBoss,
  deps: JobDeps,
  register: ScheduleRegistrar = defaultRegisterScheduleWorker,
): Promise<string[]> {
  const logger = deps.logger ?? JOB_NULL_LOGGER;
  const runners = createJobRunners(deps);
  const registered: string[] = [];

  for (const entry of JOB_SCHEDULES) {
    if (entry.requires === 'github' && deps.github === undefined) {
      logger.warn({ queue: entry.queue, job: entry.job }, '定时作业注册跳过：未注入 github');
      continue;
    }
    if (entry.requires === 'docker' && deps.docker === undefined) {
      logger.warn({ queue: entry.queue, job: entry.job }, '定时作业注册跳过：未注入 docker');
      continue;
    }
    const runner = runners[entry.job];
    await register(boss, entry.queue, async () => {
      try {
        const result = await runner();
        logger.info(
          {
            queue: entry.queue,
            job: result.job,
            ok: result.ok,
            durationMs: result.durationMs,
            stats: result.stats,
            warnings: result.warnings,
          },
          '定时作业完成',
        );
      } catch (error) {
        // 抛出去让 pg-boss 记一次失败并按 QUEUES 的 retryLimit 重试（定时任务重试 1 次）
        logger.error(
          { queue: entry.queue, job: entry.job, error: error instanceof Error ? error.message : String(error) },
          '定时作业失败',
        );
        throw error;
      }
    });
    registered.push(entry.queue);
  }

  return registered;
}

function pickCommonDeps(deps: JobDeps): { pool: JobPool; clock?: JobClock; logger: JobLogger } {
  return {
    pool: deps.pool,
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
    logger: deps.logger ?? JOB_NULL_LOGGER,
  };
}

function pickRollupDeps(deps: JobDeps): Parameters<typeof metricsRollup>[0] {
  return pickCommonDeps(deps);
}

function pickLifecycleDeps(deps: JobDeps, docker: SandboxDocker): Parameters<typeof lifecycleSweep>[0] {
  return {
    ...pickCommonDeps(deps),
    docker,
    ...(deps.proxy === undefined ? {} : { proxy: deps.proxy }),
    ...(deps.worktreeReaper === undefined ? {} : { worktreeReaper: deps.worktreeReaper }),
    ...(deps.policy === undefined ? {} : { policy: deps.policy }),
    ...(deps.diskPath === undefined ? {} : { diskPath: deps.diskPath }),
    ...(deps.planSweep === undefined ? {} : { planSweep: deps.planSweep }),
    ...(deps.createExecutor === undefined ? {} : { createExecutor: deps.createExecutor }),
    ...(deps.readDiskUsageRatio === undefined ? {} : { readDiskUsageRatio: deps.readDiskUsageRatio }),
    ...(deps.listContainers === undefined ? {} : { listContainers: deps.listContainers }),
  };
}

function pickQueueGateDeps(deps: JobDeps): QueueGateDeps {
  return {
    ...pickCommonDeps(deps),
    ...(deps.gateAck === undefined ? {} : { ack: deps.gateAck }),
    ...(deps.cancelTaskJob === undefined ? {} : { cancelJob: deps.cancelTaskJob }),
  };
}

function pickAgentDispatchDeps(deps: JobDeps): AgentDispatchJobDeps {
  return {
    ...pickCommonDeps(deps),
    ...(deps.agentEnqueue === undefined ? {} : { enqueue: deps.agentEnqueue }),
    ...(deps.agentMaxIssues === undefined ? {} : { maxIssues: deps.agentMaxIssues }),
  };
}

