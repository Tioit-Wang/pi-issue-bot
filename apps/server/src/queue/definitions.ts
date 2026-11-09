/**
 * 队列定义的**单一事实源**（tech-plan §7.1–§7.6、§4.7）。
 *
 * 这里集中三件事，别的文件不许再各写一份：
 *  1. **队列名与并发**：`QUEUES`。并发 2–4（§7.1 的规模：<100 事件/天）。
 *  2. **`expireIn`（执行期硬上限）**：默认 20min，`/review-pr` 30min（plan §9.1、§4.7）。
 *     注意它**只**表示「job 处于 active 的最长时间」，绝不是「排队等了多久」——
 *     排队闸门是独立定时任务 + `tasks.queued_at`（§4.7 F5，见 queue-gate.ts）。
 *  3. **定时任务**：排队闸门每分钟、生命周期清理每分钟、metrics 聚合每天 00:10、
 *     改回 reconcile 每小时、保留期清理每天（§7.5、§7.6）。
 *
 * pg-boss 12 的选项名与 v9/v10 不同（`expireIn` → `expireInSeconds`，分钟变秒）。
 * 本仓库内部统一用 `expireInSeconds`，注释里保留 §4.7 的「20min / 30min」口径。
 */

/** 队列名常量。字符串写死在这里，别的模块只准引用常量。 */
export const QUEUE = {
  /** 主执行队列：一个任务一个 job，`singletonKey = taskId` */
  runTask: 'run-task',
  /** 排队闸门：每分钟扫 `tasks.status='queued' and now()-queued_at > 10min` */
  queueGate: 'queue-gate',
  /** 容器 / worktree 生命周期清理（成功留 24h、失败留 1h、水位 85% 无视保留期） */
  lifecycleCleanup: 'lifecycle-cleanup',
  /** metrics 每日预聚合（§7.6，必须幂等 UPSERT） */
  metricsRollup: 'metrics-rollup',
  /** 「自动执行后被人改回」对账（§7.5 第 4 条，每小时） */
  reconcile: 'reconcile',
  /** 保留期清理：webhook 原文与 run_events 明细各 90 天 */
  retentionCleanup: 'retention-cleanup',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

/** `/review-pr` 这条命令的时间闸比别处长（plan §9.1） */
export const REVIEW_PR_COMMAND = '/review-pr';

/** 默认执行期硬上限：20min（§4.7 第二行） */
export const EXPIRE_IN_SECONDS_DEFAULT = 20 * 60;

/** `/review-pr` 的执行期硬上限：30min */
export const EXPIRE_IN_SECONDS_REVIEW_PR = 30 * 60;

/**
 * 按命令取执行期硬上限。webhook handler 入队时用它填 `expireInSeconds`（§5.3 第 7 步）。
 * 未知命令一律走默认值：宁可早杀，也不让一个卡住的容器占 30 分钟。
 */
export function expireInSecondsForCommand(command: string): number {
  return command === REVIEW_PR_COMMAND ? EXPIRE_IN_SECONDS_REVIEW_PR : EXPIRE_IN_SECONDS_DEFAULT;
}

/** 一个队列的完整定义。 */
export type QueueSpec = {
  readonly name: QueueName;
  /** 该队列在**本进程**的 worker 并发数（§7.1：2–4） */
  readonly concurrency: number;
  /** job 处于 active 状态的最长时间（秒） */
  readonly expireInSeconds: number;
  /**
   * pg-boss 队列级自动重试次数。
   * **`run-task` 必须是 0**：自动重试会让「任务级超时」被 pg-boss 顺手重跑一次，
   * 直接违反 plan §9.1「超时不自动重试，只接受 /retry」（§7.3 F6）。
   * 重试一律走 `retry-policy.ts` 的显式决策（429 用 startAfter 重投、5xx 用 retryLimit）。
   */
  readonly retryLimit: number;
  /** 重试间隔（秒），只在 `retryLimit > 0` 时有意义 */
  readonly retryDelaySeconds: number;
  /** 指数退避 + 抖动（§7.3：5xx 那条要它） */
  readonly retryBackoff: boolean;
  /** 给运维看的一句话说明 */
  readonly summary: string;
};

/**
 * 6 个队列的定义。
 *
 * 并发取舍：`run-task` 取 3 而不是 4——每个任务容器按 §6.1 吃 2 CPU / 2 GB，
 * 8 vCPU / 16 GB 的目标机上留一份给宿主机与 pi-host（§3.5），3 是「不排队也不抢内存」的折中。
 */
export const QUEUES: readonly QueueSpec[] = [
  {
    name: QUEUE.runTask,
    concurrency: 3,
    expireInSeconds: EXPIRE_IN_SECONDS_DEFAULT,
    retryLimit: 0,
    retryDelaySeconds: 0,
    retryBackoff: false,
    summary: '执行任务（检出→容器→run→校验→写回），重试由 retry-policy 显式决定',
  },
  {
    name: QUEUE.queueGate,
    concurrency: 1,
    expireInSeconds: 120,
    retryLimit: 1,
    retryDelaySeconds: 30,
    retryBackoff: false,
    summary: '排队闸门：每分钟扫排队超 10min 的任务并取消',
  },
  {
    name: QUEUE.lifecycleCleanup,
    concurrency: 1,
    expireInSeconds: 120,
    retryLimit: 1,
    retryDelaySeconds: 30,
    retryBackoff: false,
    summary: '生命周期清理：孤儿容器 / worktree 保留期与水位',
  },
  {
    name: QUEUE.metricsRollup,
    concurrency: 1,
    expireInSeconds: 600,
    retryLimit: 1,
    retryDelaySeconds: 60,
    retryBackoff: false,
    summary: 'metrics_daily 聚合（幂等 UPSERT，全量覆盖不累加）',
  },
  {
    name: QUEUE.reconcile,
    concurrency: 1,
    expireInSeconds: 600,
    retryLimit: 1,
    retryDelaySeconds: 60,
    retryBackoff: false,
    summary: '改回对账：用 Octokit 重查最近 7 天 actions 的现状',
  },
  {
    name: QUEUE.retentionCleanup,
    concurrency: 1,
    expireInSeconds: 600,
    retryLimit: 1,
    retryDelaySeconds: 60,
    retryBackoff: false,
    summary: '保留期清理：webhook 原文与 run_events 明细各 90 天',
  },
];

/** 按名字取队列定义；未定义即抛（拼错队列名不该静默变成「无并发」）。 */
export function queueSpecOf(name: QueueName): QueueSpec {
  const spec = QUEUES.find((candidate) => candidate.name === name);
  if (spec === undefined) {
    throw new Error(`未定义的队列：${name}`);
  }
  return spec;
}

/** 定时任务定义。cron 表达式按 UTC 解释（`timezone` 显式给出，避免依赖服务器本地时区）。 */
export type ScheduleSpec = {
  /** 触发哪个队列（同名的 job 会被 worker 消费） */
  readonly queue: QueueName;
  /** 5 段 cron */
  readonly cron: string;
  /** 时区，默认 UTC：定时任务的可预测性比「本地时间好看」重要 */
  readonly timezone: string;
  /** 该定时 job 的执行期硬上限（秒） */
  readonly expireInSeconds: number;
  readonly summary: string;
};

/**
 * 定时任务清单（tech-plan §4.7 / §7.5 / §7.6）。
 *
 * 时刻选择：metrics 聚合在 00:10，是为了让 00:00 前后那一分钟的 run 先落库；
 * 保留期清理放 00:40，与聚合错开，避免两个每日任务抢同一批行的锁。
 */
export const SCHEDULES: readonly ScheduleSpec[] = [
  {
    queue: QUEUE.queueGate,
    cron: '* * * * *',
    timezone: 'UTC',
    expireInSeconds: 120,
    summary: '排队闸门（每分钟）：status=queued 且 now()-queued_at > 10min → 取消 + 评论',
  },
  {
    queue: QUEUE.lifecycleCleanup,
    cron: '* * * * *',
    timezone: 'UTC',
    expireInSeconds: 120,
    summary: '生命周期清理（每分钟）：孤儿容器 / worktree 过期回收',
  },
  {
    queue: QUEUE.metricsRollup,
    cron: '10 0 * * *',
    timezone: 'UTC',
    expireInSeconds: 600,
    summary: 'metrics 聚合（每天 00:10 UTC）：写 metrics_daily',
  },
  {
    queue: QUEUE.reconcile,
    cron: '0 * * * *',
    timezone: 'UTC',
    expireInSeconds: 600,
    summary: '改回对账（每小时）：最近 7 天 actions 重查现状',
  },
  {
    queue: QUEUE.retentionCleanup,
    cron: '40 0 * * *',
    timezone: 'UTC',
    expireInSeconds: 600,
    summary: '保留期清理（每天 00:40 UTC）：webhook 原文 / run_events 90 天',
  },
];

/** 启动自检的最小 boss 面（结构性类型，测试可注入假对象，不连库、不拉 pg-boss）。 */
export type QueueAdminBoss = {
  getQueue: (name: string) => Promise<unknown | null>;
  createQueue: (name: string, options: CreateQueueOptions) => Promise<void>;
};

/** `createQueue` 认的字段（与 pg-boss 12 的 `Queue` 选项同名）。 */
export type CreateQueueOptions = {
  expireInSeconds: number;
  retryLimit: number;
  retryDelay: number;
  retryBackoff: boolean;
};

export type ScheduleAdminBoss = {
  schedule: (
    name: string,
    cron: string,
    data: object | null,
    options: Record<string, unknown>,
  ) => Promise<void>;
};

export type DefinitionLogger = {
  info: (message: string) => void;
  warn?: (message: string) => void;
};

const silentLogger: DefinitionLogger = { info: () => {}, warn: () => {} };

/**
 * 启动自检：队列不存在则 create（tech-plan §7.2「pg-boss 自己的 schema 由库自行创建」）。
 * 幂等：已存在就跳过，重复调用无副作用。返回本次新建与已存在的名单，便于日志与 doctor 展示。
 */
export async function ensureQueues(
  boss: QueueAdminBoss,
  logger: DefinitionLogger = silentLogger,
): Promise<{ created: QueueName[]; existing: QueueName[] }> {
  const created: QueueName[] = [];
  const existing: QueueName[] = [];
  for (const spec of QUEUES) {
    const current = await boss.getQueue(spec.name);
    if (current !== null && current !== undefined) {
      existing.push(spec.name);
      continue;
    }
    await boss.createQueue(spec.name, {
      expireInSeconds: spec.expireInSeconds,
      retryLimit: spec.retryLimit,
      retryDelay: spec.retryDelaySeconds,
      retryBackoff: spec.retryBackoff,
    });
    logger.info(`queue created: ${spec.name}`);
    created.push(spec.name);
  }
  return { created, existing };
}

/**
 * 注册定时任务（幂等：pg-boss 的 `schedule` 对同名 + 同 key 是 upsert 语义）。
 * 返回注册的 job 名（队列名），便于启动日志里核对「五个定时任务都在」。
 */
export async function registerSchedules(
  boss: ScheduleAdminBoss,
  schedules: readonly ScheduleSpec[] = SCHEDULES,
  logger: DefinitionLogger = silentLogger,
): Promise<QueueName[]> {
  const registered: QueueName[] = [];
  for (const spec of schedules) {
    await boss.schedule(spec.queue, spec.cron, null, {
      tz: spec.timezone,
      expireInSeconds: spec.expireInSeconds,
      retryLimit: 0,
      singletonKey: `${spec.queue}-schedule`,
    });
    logger.info(`schedule registered: ${spec.queue} @ ${spec.cron} (${spec.timezone})`);
    registered.push(spec.queue);
  }
  return registered;
}

export type DefinitionViolation = { target: string; message: string };

/**
 * 定义的静态自检（纯函数，单测直接跑）：cron 段数、并发区间、时间上限、队列名唯一。
 * 放在这里而不是「靠 review」：§4.7 的 10min 与 20min 是产品承诺，写错了没人会发现。
 */
export function validateDefinitions(
  queues: readonly QueueSpec[] = QUEUES,
  schedules: readonly ScheduleSpec[] = SCHEDULES,
): DefinitionViolation[] {
  const violations: DefinitionViolation[] = [];
  const seen = new Set<string>();

  for (const spec of queues) {
    if (seen.has(spec.name)) {
      violations.push({ target: spec.name, message: '队列名重复' });
    }
    seen.add(spec.name);
    if (!Number.isInteger(spec.concurrency) || spec.concurrency < 1 || spec.concurrency > 4) {
      violations.push({ target: spec.name, message: `并发必须在 1–4 之间（当前 ${spec.concurrency}）` });
    }
    if (!Number.isInteger(spec.expireInSeconds) || spec.expireInSeconds < 1) {
      violations.push({ target: spec.name, message: 'expireInSeconds 必须是正整数' });
    }
    if (spec.retryLimit < 0 || !Number.isInteger(spec.retryLimit)) {
      violations.push({ target: spec.name, message: 'retryLimit 必须是非负整数' });
    }
  }

  const runTask = queues.find((spec) => spec.name === QUEUE.runTask);
  if (runTask !== undefined && runTask.retryLimit !== 0) {
    // §7.3 F6：自动重试会让「任务级超时」被重跑一次，直接违反 plan §9.1
    violations.push({
      target: QUEUE.runTask,
      message: 'run-task 的 retryLimit 必须为 0，重试只能由 retry-policy 显式决定',
    });
  }

  for (const schedule of schedules) {
    if (schedule.cron.trim().split(/\s+/).length !== 5) {
      violations.push({ target: schedule.queue, message: `cron 必须是 5 段：${schedule.cron}` });
    }
    if (!seen.has(schedule.queue)) {
      violations.push({ target: schedule.queue, message: '定时任务指向未定义的队列' });
    }
  }

  return violations;
}
