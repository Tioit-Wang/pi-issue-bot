/**
 * 容器 / worktree 的生命周期（plan §8.3 → tech-plan §6.3）。
 *
 * 整张表就四行，规则集中在这一个文件里，便于逐行对照：
 *
 * | 结果 | 容器 | worktree |
 * |---|---|---|
 * | 成功 | 立即销毁 | 保留 24h |
 * | 失败（非超时） | 保留 1h 便于复现 | 保留 1h |
 * | 超时 / 熔断 / 取消 | **立即销毁**（kill + remove） | 立即回收 |
 * | 磁盘 > 85% | 清最旧的失败容器 | 清最旧的 worktree |
 *
 * 两个**必须写在销毁路径上**的动作（§6.3 明文）：
 *   (a) 销毁前先 `inspect` 一次，采 `State.OOMKilled` 与 `State.ExitCode`——容器没了就读不到，
 *       §7.3 的 `sandbox-oom` 判定全靠这一次采集；
 *   (b) 同时 `unlink` 该 job 的 `<job_dir>/.pi-bot/exec.sock` 并从代理的映射表删条目，
 *       否则 agent 的下一条命令会打到一个已经不存在的容器上。
 *
 * 策略部分是**纯函数**（`retentionForOutcome` / `planSweep`），执行器只负责把它们接上 docker。
 */
import { statfs } from 'node:fs/promises';

import type { ContainerStateSnapshot, SandboxDocker } from './docker.ts';
import { isSandboxError } from './errors.ts';
import type { FailureClassLike, SandboxLogger } from './types.ts';
import { NULL_LOGGER } from './types.ts';

const HOUR_MS = 60 * 60 * 1000;

/** 任务结束时的结果类别（比 `failure_class` 粗一档：只影响销毁节奏）。 */
export type TaskOutcome = 'success' | 'failure' | 'timeout' | 'cancelled' | 'circuit-open';

export interface RetentionPolicy {
  /** 成功任务：worktree 保留 24h 供查 diff。 */
  readonly successWorktreeMs: number;
  /** 失败任务：容器与 worktree 各留 1h 便于复现。 */
  readonly failureRetentionMs: number;
  /** 磁盘水位：严格大于该比例即触发清理。 */
  readonly diskWatermark: number;
  /** 每次扫盘最多清几个最旧的失败容器（每分钟一轮，不一次清空）。 */
  readonly watermarkCleanupPerSweep: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = Object.freeze({
  successWorktreeMs: 24 * HOUR_MS,
  failureRetentionMs: HOUR_MS,
  diskWatermark: 0.85,
  watermarkCleanupPerSweep: 1,
});

export type ContainerDisposition = 'destroy-now' | 'keep';

export interface RetentionDecision {
  readonly outcome: TaskOutcome;
  readonly container: ContainerDisposition;
  /** 容器可保留多久（`destroy-now` 时为 0）。 */
  readonly containerKeepMs: number;
  /** worktree 可保留多久（`destroy-now` 类结果为 0 = 立即回收）。 */
  readonly worktreeKeepMs: number;
  readonly reason: string;
}

/** §6.3 的表逐行实现（纯函数）。 */
export function retentionForOutcome(
  outcome: TaskOutcome,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): RetentionDecision {
  switch (outcome) {
    case 'success':
      return {
        outcome,
        container: 'destroy-now',
        containerKeepMs: 0,
        worktreeKeepMs: policy.successWorktreeMs,
        reason: '成功：容器立即销毁，worktree 保留 24h 供查 diff',
      };
    case 'failure':
      return {
        outcome,
        container: 'keep',
        containerKeepMs: policy.failureRetentionMs,
        worktreeKeepMs: policy.failureRetentionMs,
        reason: '失败（非超时）：容器与 worktree 各保留 1h 便于复现',
      };
    case 'timeout':
    case 'cancelled':
    case 'circuit-open':
      return {
        outcome,
        container: 'destroy-now',
        containerKeepMs: 0,
        worktreeKeepMs: 0,
        reason:
          outcome === 'timeout'
            ? '超时：立即销毁（容器死则容器内所有进程一起死）'
            : outcome === 'cancelled'
              ? '取消：立即销毁'
              : '熔断：立即销毁',
      };
    default: {
      const exhaustive: never = outcome;
      throw new Error(`未知的任务结果：${String(exhaustive)}`);
    }
  }
}

/** 生命周期要跟踪的一个容器。 */
export interface TrackedContainer {
  readonly jobId: string;
  readonly containerId: string;
  readonly jobDir: string;
  readonly outcome: TaskOutcome;
  /** 任务结束时刻（ms epoch）。 */
  readonly finishedAt: number;
}

export interface SweepInput {
  readonly now: number;
  /** 磁盘已用比例（0–1），由 `readDiskUsageRatio()` 采。 */
  readonly diskUsageRatio: number;
  readonly containers: readonly TrackedContainer[];
  readonly policy?: RetentionPolicy;
}

export interface SweepPlanItem {
  readonly container: TrackedContainer;
  readonly reason: string;
}

export interface SweepPlan {
  readonly destroy: readonly SweepPlanItem[];
  readonly keep: readonly TrackedContainer[];
  readonly watermarkExceeded: boolean;
  /** 水位触发的「清最旧失败容器」部分（便于日志区分两种销毁原因）。 */
  readonly watermarkCleanup: readonly SweepPlanItem[];
}

/**
 * 扫描计划（纯函数）：**保留期到点的** 与 **水位超限时最旧的失败容器** 一起给出。
 *
 * 为什么水位清理只清「失败容器」且每轮限量：成功容器已经即时销毁，剩下占地的都是失败容器；
 * 每分钟清空一批会把「复现现场」一起清掉，所以按最旧优先、每轮清 `watermarkCleanupPerSweep` 个。
 */
export function planSweep(input: SweepInput): SweepPlan {
  const policy = input.policy ?? DEFAULT_RETENTION_POLICY;
  const destroy: SweepPlanItem[] = [];
  const keep: TrackedContainer[] = [];

  for (const container of input.containers) {
    const decision = retentionForOutcome(container.outcome, policy);
    if (decision.container === 'destroy-now') {
      destroy.push({ container, reason: decision.reason });
      continue;
    }
    const age = Math.max(0, input.now - container.finishedAt);
    if (age >= decision.containerKeepMs) {
      destroy.push({ container, reason: `保留期已到（${Math.round(decision.containerKeepMs / 60000)} 分钟）` });
      continue;
    }
    keep.push(container);
  }

  const watermarkExceeded = input.diskUsageRatio > policy.diskWatermark;
  const watermarkCleanup: SweepPlanItem[] = [];
  if (watermarkExceeded) {
    const oldestFailures = keep
      .filter((container) => container.outcome === 'failure')
      .slice()
      .sort((left, right) => left.finishedAt - right.finishedAt)
      .slice(0, Math.max(1, policy.watermarkCleanupPerSweep));
    for (const container of oldestFailures) {
      watermarkCleanup.push({
        container,
        reason: `磁盘水位 ${(input.diskUsageRatio * 100).toFixed(1)}% > ${(policy.diskWatermark * 100).toFixed(0)}%：清最旧的失败容器`,
      });
    }
  }
  const cleanupIds = new Set(watermarkCleanup.map((item) => item.container.containerId));
  return {
    destroy: [...destroy, ...watermarkCleanup],
    keep: keep.filter((container) => !cleanupIds.has(container.containerId)),
    watermarkExceeded,
    watermarkCleanup,
  };
}

/**
 * 销毁前采状态。容器已经不在了 → `null`（调用方按 `sandbox-crash` 之外的路径处理）。
 * **这一步不能省**：`State.OOMKilled` 只在容器对象还在时读得到（§3.6）。
 */
export async function collectStateBeforeDestroy(
  docker: SandboxDocker,
  containerId: string,
  logger: SandboxLogger = NULL_LOGGER,
): Promise<ContainerStateSnapshot | null> {
  try {
    return await docker.inspectState(containerId);
  } catch (error) {
    if (isSandboxError(error) && error.code === 'CONTAINER_GONE') {
      logger.warn({ containerId }, '销毁前 inspect 发现容器已不存在，OOM 标记无从采集');
      return null;
    }
    throw error;
  }
}

/**
 * 采到的状态 → `failure_class`（§3.6 / §7.3）。
 * 顺序要紧：**先看 OOM 再看退出码**，否则一次 OOM 会被记成普通的 `sandbox-crash`，
 * 走进「自动重试 1 次」的分支再 OOM 一遍。
 */
export function classifyDestroyedState(
  state: ContainerStateSnapshot | null,
): FailureClassLike | undefined {
  if (state === null) {
    return undefined;
  }
  if (state.oomKilled) {
    return 'sandbox-oom';
  }
  if (state.exitCode !== 0) {
    return 'sandbox-crash';
  }
  return undefined;
}

/** 单个 job 的处置结果：调用方拿它落库（`runs.exit_code` / `runs.failure_class`）。 */
export interface DisposeResult {
  readonly outcome: TaskOutcome;
  readonly retention: RetentionDecision;
  /** 销毁前采到的状态（容器已不在时为 null）。 */
  readonly state: ContainerStateSnapshot | null;
  /** 采到的状态推出的失败分类（成功 / 容器已不在时为 undefined）。 */
  readonly failureClass?: FailureClassLike;
}

export interface DisposeInput {
  readonly jobId: string;
  readonly containerId: string;
  readonly jobDir: string;
  readonly outcome: TaskOutcome;
}

export interface SweepResult {
  readonly disposed: readonly { jobId: string; containerId: string; reason: string; state: ContainerStateSnapshot | null }[];
  readonly kept: readonly TrackedContainer[];
  readonly watermarkExceeded: boolean;
}

/** 代理的最小接口（只用到 destroy），避免生命周期模块反向依赖代理实现细节。 */
export interface EndpointReaper {
  destroy(target: { jobId: string }): Promise<void>;
}

export interface LifecycleExecutorOptions {
  readonly docker: SandboxDocker;
  /** exec 代理：销毁容器时必须同时清端点（§6.3 的 (b)）。 */
  readonly proxy?: EndpointReaper;
  readonly logger?: SandboxLogger;
  readonly policy?: RetentionPolicy;
  readonly clock?: () => number;
}

export class LifecycleExecutor {
  readonly #docker: SandboxDocker;
  readonly #proxy: EndpointReaper | undefined;
  readonly #logger: SandboxLogger;
  readonly #policy: RetentionPolicy;
  readonly #clock: () => number;

  constructor(options: LifecycleExecutorOptions) {
    this.#docker = options.docker;
    this.#proxy = options.proxy;
    this.#logger = options.logger ?? NULL_LOGGER;
    this.#policy = options.policy ?? DEFAULT_RETENTION_POLICY;
    this.#clock = options.clock ?? (() => Date.now());
  }

  get policy(): RetentionPolicy {
    return this.#policy;
  }

  /**
   * 一个 job 收尾：先 inspect 采 OOM/ExitCode → 销毁容器 → 清端点。
   * 顺序不可调换：先销毁就再也采不到 `OOMKilled` 了。
   */
  async dispose(input: DisposeInput): Promise<DisposeResult> {
    const retention = retentionForOutcome(input.outcome, this.#policy);
    const state = await collectStateBeforeDestroy(this.#docker, input.containerId, this.#logger);
    await this.#docker.destroyContainer(input.containerId);
    await this.#proxy?.destroy({ jobId: input.jobId });
    const failureClass = classifyDestroyedState(state);
    this.#logger.info(
      {
        jobId: input.jobId,
        containerId: input.containerId,
        outcome: input.outcome,
        oomKilled: state?.oomKilled ?? null,
        exitCode: state?.exitCode ?? null,
        failureClass: failureClass ?? null,
      },
      'job 已销毁',
    );
    return {
      outcome: input.outcome,
      retention,
      state,
      ...(failureClass !== undefined ? { failureClass } : {}),
    };
  }

  /** 定时任务（每分钟）调一次：保留期到点的 + 水位超限的最旧失败容器。 */
  async sweep(input: { containers: readonly TrackedContainer[]; diskUsageRatio: number }): Promise<SweepResult> {
    const now = this.#clock();
    const plan = planSweep({
      now,
      diskUsageRatio: input.diskUsageRatio,
      containers: input.containers,
      policy: this.#policy,
    });
    const disposed: { jobId: string; containerId: string; reason: string; state: ContainerStateSnapshot | null }[] = [];
    for (const item of plan.destroy) {
      const state = await collectStateBeforeDestroy(this.#docker, item.container.containerId, this.#logger);
      await this.#docker.destroyContainer(item.container.containerId);
      await this.#proxy?.destroy({ jobId: item.container.jobId });
      disposed.push({
        jobId: item.container.jobId,
        containerId: item.container.containerId,
        reason: item.reason,
        state,
      });
      this.#logger.info(
        { jobId: item.container.jobId, containerId: item.container.containerId, reason: item.reason },
        '水位/保留期清理：容器已销毁',
      );
    }
    return { disposed, kept: plan.keep, watermarkExceeded: plan.watermarkExceeded };
  }
}

export function createLifecycleExecutor(options: LifecycleExecutorOptions): LifecycleExecutor {
  return new LifecycleExecutor(options);
}

/**
 * 磁盘已用比例（0–1）。用 `statfs` 而不是 `docker df`：
 * `docker df` 给的是镜像/卷的占用估算，不是文件系统水位，拿它比 85% 会误判。
 */
export async function readDiskUsageRatio(targetPath: string): Promise<number> {
  const stats = await statfs(targetPath);
  const total = Number(stats.blocks) * Number(stats.bsize);
  const free = Number(stats.bfree) * Number(stats.bsize);
  if (total <= 0) {
    return 0;
  }
  return (total - free) / total;
}
