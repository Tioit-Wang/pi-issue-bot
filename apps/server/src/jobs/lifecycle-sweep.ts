/**
 * `lifecycle-cleanup`：容器 / worktree 的生命周期清扫（tech-plan §6.3 那张四行表，每分钟一轮）。
 *
 * | 结果 | 容器 | worktree |
 * |---|---|---|
 * | 成功 | 立即销毁 | 保留 24h |
 * | 失败（非超时） | 保留 1h 便于复现 | 保留 1h |
 * | 超时 / 熔断 / 取消 | **立即销毁** | 立即回收 |
 * | 磁盘 > 85% | 清最旧的失败容器 | 清最旧的 worktree |
 *
 * 策略本身不在这里重写：保留期矩阵与水位规则由 `sandbox/lifecycle.ts` 的 `planSweep()` 给（纯函数），
 * 销毁动作由 `createLifecycleExecutor()` 做——它已经把「**先 `inspect` 采 `OOMKilled`/`ExitCode`，
 * 再 kill + remove**」这个顺序写死在 `dispose()` 里（顺序反了就永远采不到 OOM，§6.3 的 (a)）。
 * 本作业负责的是三件它管不到的事：
 *  1. **容器从哪来**：`tasks` 表（`container_name` + 终态 + `ended_at`），默认实现见 `listTrackedContainers()`；
 *  2. **采到的状态落库**：`run_events` 追加一条 `sandbox.inspected`，OOM 时把 `runs.failure_class`
 *     升级成 `sandbox-oom`（§7.3 的重试决策只读这一列）；
 *  3. **worktree 那一列**：`WorktreeReaper` 是注入接口（真实的 git worktree 归 `git/` owner），
 *     本文件只按同一张表算出「该回收谁」。
 */
import type {
  ContainerStateSnapshot,
  EndpointReaper,
  RetentionPolicy,
  SandboxDocker,
  SandboxLogger,
  TaskOutcome,
  TrackedContainer,
} from '../sandbox/index.ts';
import {
  createLifecycleExecutor as createSandboxLifecycleExecutor,
  planSweep as planSandboxSweep,
  retentionForOutcome,
  DEFAULT_RETENTION_POLICY,
} from '../sandbox/index.ts';
import type { JobLogger, JobPool, JobResult } from './types.ts';
import { finishJob, JOB_NULL_LOGGER, rowCountOf, systemClock } from './types.ts';

/**
 * 从 `tasks.status` 反推 §6.3 的结果档。
 * `cancelled_queue`（排队超 10min 被闸门取消）归到 `cancelled`：容器可能已经起来了，立即销毁。
 */
const OUTCOME_BY_TASK_STATUS: Readonly<Record<string, TaskOutcome>> = Object.freeze({
  succeeded: 'success',
  failed: 'failure',
  'timed-out': 'timeout',
  cancelled: 'cancelled',
  cancelled_queue: 'cancelled',
});

/**
 * 默认的容器来源：终态任务 + 有容器名。按结束时间升序（最旧的先清）。
 *
 * ⚠ `tasks.container_name` **永不清空**（它是审计信息），所以这张表天然会一直列出历史任务。
 * 必须用 `sandbox.inspected` 这个「已经处置过」的凭据把它们排除，否则每轮清扫都会对早已不存在的
 * 容器重放一次 `dispose()`，并往 `run_events` 追加一条重复的 `sandbox.inspected` ——
 * 实机（2026-11-11）一条已结束的 run 在 36 分钟里被追加了 36 行，面板整页都是「通知」。
 *
 * 判定粒度是「任务**最近一次** run」：worker 自己销毁容器时也会写这条事件（`worker/run-task.ts`），
 * 于是正常任务一次都不会被清扫碰到；只有容器真被留下的（进程崩了 / worker 销毁失败）才进清单，
 * 且处置一次后立刻被排除。重试会产生新的 run（`runs.attempt` +1）→ 重新进清单，这是对的。
 */
const TRACKED_CONTAINERS_SQL = `
select
  t.id as job_id,
  t.container_name as container_name,
  t.status as status,
  coalesce(t.ended_at, t.updated_at) as finished_at
from tasks t
where t.container_name is not null
  and t.status in ('succeeded', 'failed', 'timed-out', 'cancelled', 'cancelled_queue')
  and not exists (
    select 1
    from run_events e
    join runs r on r.id = e.run_id
    where r.task_id = t.id
      and e.kind = 'sandbox.inspected'
      and r.id = (
        select r2.id from runs r2 where r2.task_id = t.id order by r2.started_at desc, r2.id desc limit 1
      )
  )
order by coalesce(t.ended_at, t.updated_at) asc, t.id asc
`;

const LATEST_RUN_SQL = `
select id
  from runs
 where task_id = $1
 order by started_at desc, id desc
 limit 1
`;

/**
 * 追加一条事件：游标取 `max(cursor)+1`。
 * 聚合查询在空集上也返回一行，所以「第一条事件」天然是 cursor=1。
 */
const APPEND_EVENT_SQL = `
insert into run_events (run_id, cursor, kind, payload, created_at)
select $1, coalesce(max(cursor), 0) + 1, $2, $3::jsonb, $4::timestamptz
  from run_events
 where run_id = $1
returning cursor
`;

/**
 * OOM 升级 `failure_class`：只在「没有分类」或「分类明显没看到 OOM」时才改写，
 * 不覆盖 `auth` / `rate_limit` 这类更精确的既有判定。
 */
const UPGRADE_FAILURE_SQL = `
update runs
   set failure_class = $2,
       failure_detail = coalesce(failure_detail, '{}'::jsonb) || $3::jsonb
 where id = $1
   and (failure_class is null or failure_class in ('unknown', 'sandbox-crash'))
`;

/** 一个待回收的 worktree（真实实现归 `git/` owner，本作业只消费这个形状）。 */
export type WorktreeCandidate = {
  readonly jobId: string;
  /** worktree 绝对路径（回收时的目标）。 */
  readonly path: string;
  readonly outcome: TaskOutcome;
  /** 任务结束时刻（ms epoch）。 */
  readonly finishedAt: number;
};

/** worktree 回收端口：列出 + 删除。两条都注入，测试可以只看调用顺序。 */
export interface WorktreeReaper {
  list: () => Promise<readonly WorktreeCandidate[]>;
  remove: (candidate: WorktreeCandidate) => Promise<void>;
}

export type WorktreeSweepPlan = {
  readonly remove: readonly { readonly candidate: WorktreeCandidate; readonly reason: string }[];
  readonly keep: readonly WorktreeCandidate[];
  readonly watermarkExceeded: boolean;
};

/**
 * worktree 那一列的策略（纯函数）。
 *
 * 与容器**不能**共用 `planSweep()`：成功任务的容器立即销毁、worktree 却保留 24h，
 * 两者的 `RetentionDecision` 字段不同（`container` vs `worktreeKeepMs`），套用容器策略会把
 * 「刚成功、还要看 diff」的 worktree 一起删掉。所以这里按 `worktreeKeepMs` 单独算一遍。
 */
export function planWorktreeSweep(input: {
  readonly now: number;
  readonly diskUsageRatio: number;
  readonly candidates: readonly WorktreeCandidate[];
  readonly policy?: RetentionPolicy;
}): WorktreeSweepPlan {
  const policy = input.policy ?? DEFAULT_RETENTION_POLICY;
  const remove: { candidate: WorktreeCandidate; reason: string }[] = [];
  const keep: WorktreeCandidate[] = [];

  for (const candidate of input.candidates) {
    const decision = retentionForOutcome(candidate.outcome, policy);
    if (decision.worktreeKeepMs === 0) {
      remove.push({ candidate, reason: `${decision.reason}（worktree 立即回收）` });
      continue;
    }
    const age = Math.max(0, input.now - candidate.finishedAt);
    if (age >= decision.worktreeKeepMs) {
      remove.push({
        candidate,
        reason: `worktree 保留期已到（${String(Math.round(decision.worktreeKeepMs / 60_000))} 分钟）`,
      });
      continue;
    }
    keep.push(candidate);
  }

  const watermarkExceeded = input.diskUsageRatio > policy.diskWatermark;
  const removedIds = new Set(remove.map((item) => item.candidate.path));
  if (watermarkExceeded) {
    // §6.3 第四行：worktree 清最旧的（不限失败——成功的 worktree 是磁盘占用的大头）
    const oldest = keep
      .filter((candidate) => !removedIds.has(candidate.path))
      .slice()
      .sort((left, right) => left.finishedAt - right.finishedAt)
      .slice(0, Math.max(1, policy.watermarkCleanupPerSweep));
    for (const candidate of oldest) {
      remove.push({
        candidate,
        reason: `磁盘水位 ${(input.diskUsageRatio * 100).toFixed(1)}% > ${(policy.diskWatermark * 100).toFixed(0)}%：清最旧的 worktree`,
      });
      removedIds.add(candidate.path);
    }
  }

  return {
    remove,
    keep: keep.filter((candidate) => !removedIds.has(candidate.path)),
    watermarkExceeded,
  };
}

export type LifecycleSweepDeps = {
  readonly pool: JobPool;
  /** docker 窄接口（`sandbox/docker.ts`），只用来 inspect / destroy。 */
  readonly docker: SandboxDocker;
  readonly clock?: () => number;
  readonly logger?: JobLogger;
  /** 保留期策略（默认 `DEFAULT_RETENTION_POLICY`：24h / 1h / 85%）。 */
  readonly policy?: RetentionPolicy;
  /** exec 代理：销毁容器时必须同时清端点（§6.3 的 (b)）。 */
  readonly proxy?: EndpointReaper;
  /** worktree 回收端口；不注入就跳过 worktree 那一列（记一条 warning）。 */
  readonly worktreeReaper?: WorktreeReaper;
  /** 磁盘水位采样路径，默认 `process.cwd()`。 */
  readonly diskPath?: string;
  /** 注入扫描函数（默认 `sandbox/lifecycle.ts` 的 `planSweep`）。 */
  readonly planSweep?: typeof planSandboxSweep;
  /** 注入执行器工厂（默认 `sandbox/lifecycle.ts` 的 `createLifecycleExecutor`）。 */
  readonly createExecutor?: typeof createSandboxLifecycleExecutor;
  /** 注入磁盘水位采样（测试里直接给 0.9）。 */
  readonly readDiskUsageRatio?: (path: string) => Promise<number>;
  /** 注入容器清单（默认读 `tasks` 表）。 */
  readonly listContainers?: () => Promise<readonly TrackedContainer[]>;
};

export type LifecycleSweepOptions = {
  readonly diskPath?: string;
  /** 直接给磁盘水位（0–1），跳过 `readDiskUsageRatio()`。 */
  readonly diskUsageRatio?: number;
  /** 直接给容器清单，跳过 `listContainers()`。 */
  readonly containers?: readonly TrackedContainer[];
  /** 只看不杀（打印计划）。 */
  readonly dryRun?: boolean;
};

export type LifecycleSweepStats = {
  readonly containersScanned: number;
  readonly containersDestroyed: number;
  readonly containersKept: number;
  readonly watermarkExceeded: boolean;
  readonly watermarkDestroyed: number;
  /** 销毁前采到 `OOMKilled=true` 的容器数（= `sandbox-oom` 的判定次数）。 */
  readonly oomCaptured: number;
  /** 采到非 0 退出码的容器数。 */
  readonly exitCodeNonZero: number;
  readonly worktreesScanned: number;
  readonly worktreesRemoved: number;
  readonly worktreesKept: number;
  readonly diskUsagePercent: number;
};

export async function lifecycleSweep(
  deps: LifecycleSweepDeps,
  options: LifecycleSweepOptions = {},
): Promise<JobResult<LifecycleSweepStats>> {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger ?? JOB_NULL_LOGGER;
  const startedAt = clock();
  const policy = deps.policy ?? DEFAULT_RETENTION_POLICY;
  const planSweep = deps.planSweep ?? planSandboxSweep;
  const createExecutor = deps.createExecutor ?? createSandboxLifecycleExecutor;
  const dryRun = options.dryRun === true;
  const warnings: string[] = [];

  const diskUsageRatio = options.diskUsageRatio ?? (await readDisk(deps, options));
  if (!Number.isFinite(diskUsageRatio) || diskUsageRatio < 0 || diskUsageRatio > 1) {
    throw new Error(`lifecycle：磁盘水位必须在 0–1 之间，收到 ${String(diskUsageRatio)}`);
  }

  const containers = options.containers ?? (await (deps.listContainers ?? (() => listTrackedContainers(deps)))());

  const plan = planSweep({ now: startedAt, diskUsageRatio, containers, policy });
  const executor = createExecutor({
    docker: deps.docker,
    ...(deps.proxy === undefined ? {} : { proxy: deps.proxy }),
    logger: asSandboxLogger(deps.logger ?? JOB_NULL_LOGGER),
    policy,
    clock,
  });

  const watermarkIds = new Set(plan.watermarkCleanup.map((item) => item.container.containerId));
  let containersDestroyed = 0;
  let watermarkDestroyed = 0;
  let oomCaptured = 0;
  let exitCodeNonZero = 0;

  for (const item of plan.destroy) {
    if (dryRun) {
      logger.info(
        { job: 'lifecycle-cleanup', jobId: item.container.jobId, containerId: item.container.containerId, reason: item.reason },
        '生命周期清扫（dry-run）：本应销毁',
      );
      continue;
    }
    // dispose() 的顺序是 inspect → destroy → 清端点，OOM 只在 inspect 这一步读得到
    const disposed = await executor.dispose({
      jobId: item.container.jobId,
      containerId: item.container.containerId,
      jobDir: item.container.jobDir,
      outcome: item.container.outcome,
    });
    containersDestroyed += 1;
    if (watermarkIds.has(item.container.containerId)) {
      watermarkDestroyed += 1;
    }
    if (disposed.state?.oomKilled === true) {
      oomCaptured += 1;
    }
    if (disposed.state !== null && disposed.state.exitCode !== 0) {
      exitCodeNonZero += 1;
    }
    await persistDisposal(deps, item.container, item.reason, disposed.state, disposed.failureClass, logger, startedAt);
  }

  // worktree 那一列：同一张表，另一套保留期
  let worktreesRemoved = 0;
  let worktreesKept = 0;
  let worktreesScanned = 0;
  if (deps.worktreeReaper === undefined) {
    warnings.push('未注入 WorktreeReaper：本轮只清容器，worktree 保留期未生效');
  } else {
    const candidates = await deps.worktreeReaper.list();
    worktreesScanned = candidates.length;
    const worktreePlan = planWorktreeSweep({ now: startedAt, diskUsageRatio, candidates, policy });
    for (const item of worktreePlan.remove) {
      if (dryRun) {
        logger.info(
          { job: 'lifecycle-cleanup', path: item.candidate.path, reason: item.reason },
          '生命周期清扫（dry-run）：本应回收 worktree',
        );
        continue;
      }
      await deps.worktreeReaper.remove(item.candidate);
      worktreesRemoved += 1;
      logger.info(
        { job: 'lifecycle-cleanup', path: item.candidate.path, reason: item.reason },
        '生命周期清扫：worktree 已回收',
      );
    }
    worktreesKept = worktreePlan.keep.length;
  }

  logger.info(
    {
      job: 'lifecycle-cleanup',
      diskUsagePercent: Math.round(diskUsageRatio * 1000) / 10,
      containersScanned: containers.length,
      containersDestroyed,
      containersKept: plan.keep.length,
      watermarkExceeded: plan.watermarkExceeded,
      watermarkDestroyed,
      oomCaptured,
      worktreesRemoved,
    },
    '生命周期清扫完成',
  );

  return finishJob(
    'lifecycle-sweep',
    startedAt,
    clock,
    {
      containersScanned: containers.length,
      containersDestroyed,
      containersKept: plan.keep.length,
      watermarkExceeded: plan.watermarkExceeded,
      watermarkDestroyed,
      oomCaptured,
      exitCodeNonZero,
      worktreesScanned,
      worktreesRemoved,
      worktreesKept,
      diskUsagePercent: Math.round(diskUsageRatio * 1000) / 10,
    },
    warnings,
  );
}

/** 默认容器清单：读 `tasks` 的终态行。`jobDir` 只能留空（`tasks` 不存 worktree 路径）。 */
export async function listTrackedContainers(deps: {
  readonly pool: JobPool;
}): Promise<readonly TrackedContainer[]> {
  const rows = (
    await deps.pool.query(TRACKED_CONTAINERS_SQL)
  ).rows as { job_id: string; container_name: string; status: string; finished_at: Date }[];
  const containers: TrackedContainer[] = [];
  for (const row of rows) {
    const outcome = OUTCOME_BY_TASK_STATUS[row.status];
    if (outcome === undefined) {
      continue;
    }
    containers.push({
      jobId: row.job_id,
      containerId: row.container_name,
      jobDir: '',
      outcome,
      finishedAt: row.finished_at.getTime(),
    });
  }
  return containers;
}

/**
 * 落库：事件流 + `failure_class`。
 *
 * 为什么必须落库：容器一销毁，`OOMKilled` 与 `ExitCode` 就再也读不到了（§6.3 的 (a)）。
 * 这里把完整快照写进 `run_events`（审计/面板时间线可读），并把 OOM 升级成 `sandbox-oom`
 * 写入 `runs.failure_class`——§7.3 的重试决策与失败分布都只读那一列。
 */
async function persistDisposal(
  deps: LifecycleSweepDeps,
  container: TrackedContainer,
  reason: string,
  state: ContainerStateSnapshot | null,
  failureClass: string | undefined,
  logger: JobLogger,
  nowMs: number,
): Promise<void> {
  const runRows = (await deps.pool.query(LATEST_RUN_SQL, [container.jobId])).rows as { id: string }[];
  const runId = runRows[0]?.id;
  if (runId === undefined) {
    logger.warn(
      { job: 'lifecycle-cleanup', jobId: container.jobId, containerId: container.containerId },
      '生命周期清扫：该任务没有 run 记录，状态快照无处落库',
    );
    return;
  }

  const payload = {
    containerId: container.containerId,
    outcome: container.outcome,
    reason,
    oomKilled: state?.oomKilled ?? null,
    exitCode: state?.exitCode ?? null,
    status: state?.status ?? null,
    failureClass: failureClass ?? null,
  };
  try {
    rowCountOf(
      await deps.pool.query(APPEND_EVENT_SQL, [
        runId,
        'sandbox.inspected',
        JSON.stringify(payload),
        new Date(nowMs).toISOString(),
      ]),
    );
  } catch (error) {
    logger.warn(
      { job: 'lifecycle-cleanup', runId, error: error instanceof Error ? error.message : String(error) },
      '生命周期清扫：销毁前状态快照写入 run_events 失败（不阻断销毁）',
    );
  }

  if (failureClass === 'sandbox-oom') {
    const detail = { oomKilled: true, exitCode: state?.exitCode ?? null, containerId: container.containerId };
    await deps.pool.query(UPGRADE_FAILURE_SQL, [runId, 'sandbox-oom', JSON.stringify(detail)]);
    logger.info({ job: 'lifecycle-cleanup', runId, jobId: container.jobId }, '生命周期清扫：已标记 sandbox-oom');
  }
}

/**
 * `JobLogger` → `SandboxLogger` 的形状适配（后者多一个 `debug` 与 `child`）。
 * 只做透传，不改语义；`debug` 缺省时静默（作业本身不写 debug 日志）。
 */
function asSandboxLogger(logger: JobLogger): SandboxLogger {
  const adapter: SandboxLogger = {
    debug: (fields, message) => logger.debug?.(fields, message),
    info: (fields, message) => logger.info(fields, message),
    warn: (fields, message) => logger.warn(fields, message),
    error: (fields, message) => logger.error(fields, message),
    child: () => adapter,
  };
  return adapter;
}

async function readDisk(deps: LifecycleSweepDeps, options: LifecycleSweepOptions): Promise<number> {
  const read = deps.readDiskUsageRatio ?? defaultReadDiskUsageRatio;
  return read(options.diskPath ?? deps.diskPath ?? process.cwd());
}

/** 延迟到调用时才解析，避免把 `sandbox/lifecycle.ts` 的 fs 依赖提到模块顶层。 */
async function defaultReadDiskUsageRatio(targetPath: string): Promise<number> {
  const { readDiskUsageRatio } = await import('../sandbox/index.ts');
  return readDiskUsageRatio(targetPath);
}
