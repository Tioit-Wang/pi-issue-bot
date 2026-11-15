/**
 * 队列定义的**单一事实源**（tech-plan §7.1–§7.6、§4.7）。
 *
 * 这里集中三件事，别的文件不许再各写一份：
 *  1. **队列名与并发**：`QUEUES`。并发 2–4（§7.1 的规模：<100 事件/天）。
 *  2. **`expireIn`（pg-boss 的执行期硬上限）**：固定取区间**上界**（`MAX_TURN_TIMEOUT_MINUTES` = 30min，
 *     见 `EXPIRE_IN_SECONDS_MAX`）。它**只**表示「job 处于 active 的最长时间」，不是业务闸门 ——
 *     单轮超时是任务级 deadline（项目值，`turnTimeoutMsFor()`）；排队闸门是独立定时任务 +
 *     `tasks.queued_at`（§4.7 F5，见 queue-gate.ts）。取上界是为了让 pg-boss 永远不早于项目配置动手。
 *  3. **定时任务**：排队闸门每分钟、生命周期清理每分钟、metrics 聚合每天 00:10、
 *     改回 reconcile 每小时、保留期清理每天（§7.5、§7.6）。
 *
 * pg-boss 12 的选项名与 v9/v10 不同（`expireIn` → `expireInSeconds`，分钟变秒）。
 * 本仓库内部统一用 `expireInSeconds`。
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
  /**
   * issue agent 的串行调度（v0.3）：扫 `agent_messages` 里每个 issue 最老的一条 `queued`，
   * 置 `running` 并投 `run-task`。**不能**用 `run-task` 的 `singletonKey` 排队
   * （同 key 已在队列就丢弃，见 `boss.ts` 的注释）。
   */
  agentDispatch: 'agent-dispatch',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

/** `/review-pr` 这条命令的名字（单轮超时比别处长的那一条，plan §9.1） */
export const REVIEW_PR_COMMAND = '/review-pr';

/**
 * 单轮执行的默认最长时长（分钟）：20。
 *
 * 与契约 `agentExecutionSchema.turn_timeout_minutes` 的默认值**必须相等**（等值性由
 * `test/queue-turn-timeout.test.ts` 断言）：一处是「项目没配置时的默认」，一处是
 * 「配置项缺省值」，两者不同步就是「面板显示 20、实际跑 30」这类最难查的偏差。
 */
export const DEFAULT_TURN_TIMEOUT_MINUTES = 20;

/** `/review-pr` 的单轮上限（分钟）：30。项目显式配置了 `turn_timeout_minutes` 时以项目为准。 */
export const REVIEW_PR_TURN_TIMEOUT_MINUTES = 30;

/** 契约允许的单轮超时区间（`agentExecutionSchema.turn_timeout_minutes` 的 1–30）。 */
export const MIN_TURN_TIMEOUT_MINUTES = 1;
export const MAX_TURN_TIMEOUT_MINUTES = 30;

/**
 * `expireInSeconds` 的唯一取值：区间**上界** 1800s = 30min（`MAX_TURN_TIMEOUT_MINUTES × 60`）。
 *
 * 为什么入队点不再「按命令分 20/30」、也不读项目配置（需求 §6.7 SL-4 的收口结论）：
 *  - 入队点（`http/webhook.ts::createQueueEnqueuer`、`jobs/agent-dispatch`）手里**没有**仓库 settings，
 *    硬要在那里读库，只是把同一份配置读成第二个「入队时刻的快照」；读错了反而更糟。
 *  - 更要紧的是方向性：`expireIn` 一旦小于项目配置，pg-boss 会在项目值还没到的时候把 job 判成过期 ——
 *    「项目配了 30 分钟却被平台在第 20 分钟杀掉」是最难查的一类偏差。
 *  - 真正的闸门只有一处：任务级 deadline（`turnTimeoutMsFor(command, 项目显式值)`，被
 *    `worker/run-task.ts` / `runtime/turn-driver.ts` 消费）。项目配 5 分钟就是 5 分钟终止、
 *    记 `timed-out`，而 `run-task.retryLimit` 恒为 0（不自动重试）。
 *
 * 所以这一层的语义是「**绝不早于任何合法项目配置**」：取合法区间上界，平台层不做业务判定。
 */
export const EXPIRE_IN_SECONDS_MAX = MAX_TURN_TIMEOUT_MINUTES * 60;

/** 命令是否就是 `/review-pr`（大小写与尾随参数都容忍，与 `worker/run-task.ts` 同口径）。 */
function isReviewPr(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  return normalized === REVIEW_PR_COMMAND || normalized.startsWith(`${REVIEW_PR_COMMAND} `);
}

/**
 * 单轮超时的生效分钟数（需求 §6.7 SL-4「单轮超时」，**唯一事实源**）。
 *
 * 裁决顺序：
 *  1. `configuredMinutes` 有值（项目在 `agent.limits.turn_timeout_minutes` 里显式配了 1–30）
 *     → 用它。需求把这个旋钮定义成**项目级**的，所以它连 `/review-pr` 的 30 分钟也要能压下去；
 *  2. 没配 → 按命令给默认值：`/review-pr` 30 分钟、其余 20 分钟。
 *
 * 为什么「有没有显式配置」要由调用方传 `undefined` 而不是传契约默认值：契约那一份永远有值
 * （`.default(20)`），拿它来判「配没配」就永远为真，`/review-pr` 的 30 分钟会静默消失。
 * 读取显式值用 `config/v21-settings.ts::resolveTurnTimeoutMinutes()`。
 */
export function turnTimeoutMinutesFor(command: string, configuredMinutes?: number): number {
  if (typeof configuredMinutes === 'number' && Number.isFinite(configuredMinutes)) {
    return Math.min(
      MAX_TURN_TIMEOUT_MINUTES,
      Math.max(MIN_TURN_TIMEOUT_MINUTES, Math.trunc(configuredMinutes)),
    );
  }
  return isReviewPr(command) ? REVIEW_PR_TURN_TIMEOUT_MINUTES : DEFAULT_TURN_TIMEOUT_MINUTES;
}

/** 单轮超时（毫秒）——`turn-driver` 的任务级 deadline 用它。 */
export function turnTimeoutMsFor(command: string, configuredMinutes?: number): number {
  return turnTimeoutMinutesFor(command, configuredMinutes) * 60_000;
}

/**
 * 入队时用的 `expireInSeconds`（**不**接受命令参数，见 `EXPIRE_IN_SECONDS_MAX` 的说明）。
 *
 * 保留成函数而不是让调用方直接引常量：入队点有两处（webhook / agent-dispatch），
 * 让它们都经这里能保证「不存在第二种取值」，也便于单测直接钉住这个口径。
 */
export function enqueueExpireInSeconds(): number {
  return EXPIRE_IN_SECONDS_MAX;
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
    expireInSeconds: EXPIRE_IN_SECONDS_MAX,
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
  {
    /**
     * agent 串行调度：并发 **1**。不是性能取舍，是语义 —— 一个 issue 同时只能有一条消息在跑，
     * 而「领一条」是「查最老 + 置 running」，两个并发 dispatcher 会各领到一条（见
     * `agent/dispatcher.ts` 文件头的已知窗口）。
     */
    name: QUEUE.agentDispatch,
    concurrency: 1,
    expireInSeconds: 120,
    retryLimit: 1,
    retryDelaySeconds: 30,
    retryBackoff: false,
    summary: 'issue agent 串行调度：每轮为每个 issue 投最老的一条 agent_messages',
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
  {
    /**
     * agent 调度：pg-boss 的 cron 最小粒度是 1 分钟，所以这里是**兜底**，不是主路径。
     *
     * 「10 秒」的语义由两处兑现（`AGENT_DISPATCH_INTERVAL_MS` = 10000）：
     *  - webhook 落库后**立刻**为这个 issue 领一条（`dispatchNextForIssue`）；
     *  - 任务结束后**立刻**领这个 issue 的下一条（`finishMessageAndContinue`）。
     * 这条 cron 只负责「上一轮投递失败 / 进程重启 / 消息在别处落库」的捞底。
     */
    queue: QUEUE.agentDispatch,
    cron: '* * * * *',
    timezone: 'UTC',
    expireInSeconds: 120,
    summary: 'agent 串行调度（每分钟兜底）：每个 issue 投最老的一条 agent_messages',
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
