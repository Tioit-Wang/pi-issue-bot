/**
 * 仓库级并发（`docs/impl-multi-repo.md` §4 W1-B 第 3 条；需求 §6.7 的「并发数」）。
 *
 * 两层的分工：
 *  - **全局并发** = `QUEUES` 里 `run-task` 的 `concurrency`（3）—— 也就是本进程同时跑几个任务，
 *    由 pg-boss 的 `localConcurrency` 管（`queue/boss.ts`）；这是**部署层**约束（需求 SL-5 允许）。
 *  - **项目级并发** = `repos.settings.agent.limits.concurrency`（默认 2）—— 同一个仓库同时跑几个任务。
 *
 * **字段只有一个真相**：`settings.agent.limits.concurrency`（v2.1，需求 §6.7 指向的那个旋钮）。
 * 老的 `settings.limits.concurrency_per_repo` 在 v2.1 之前是唯一入口，现在**已 deprecated**，
 * 只在「新字段真的没写」的存量配置上兜底：两条路径读出不同数字时，新字段永远赢。
 * 保留兜底而不是直接删读点，是因为存量 `repos.settings` 里满是老键；但「谁生效」只有这一处
 * 决定（装配层只调 `concurrencyPerRepoOf()`，不自己解 jsonb）。
 *
 * 为什么仓库级要单独限：一个仓库连发十个命令会把三个全局槽位全占满，其余仓库的投递只能排队；
 * 收到 2 以后「吵的那个仓库」最多占两个槽，第三个槽永远留给别人。
 *
 * 触顶行为是**排队等待、不丢弃**（需求 §6.7 第二行）：等槽的任务由 `queue/queue-gate.ts`
 * 的 SQL 显式排除在「排队超时取消」之外，见那里的注释。
 *
 * 为什么不用 `p-limit` 之类的依赖：我们要的是「按 key 分组 + 上限可动态变（每次取任务都读库）」，
 * 那是二十行 Map 的活；而且这里的等待者语义是「槽位直接转移」（见 `#releaser`），
 * 通用库要么不提供按 key 限流，要么要造一个 per-key limiter 的池子。
 */

/** 仓库级默认并发：2（全局仍 3，见 `queue/definitions.ts` 的 `QUEUES`）。 */
export const DEFAULT_CONCURRENCY_PER_REPO = 2;

/** 仓库级并发的合法区间（与契约 `agentExecutionSchema.concurrency` 的 1–8 对齐）。 */
export const MIN_CONCURRENCY_PER_REPO = 1;
export const MAX_CONCURRENCY_PER_REPO = 8;

/** 取一层对象（`unknown` → 对象或 `undefined`）。 */
function objectAt(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

/** 读 `agent.limits.concurrency`（v2.1，唯一真相）；不是数字就返回 `undefined`。 */
function v21ConcurrencyOf(settings: unknown): number | undefined {
  const value = objectAt(objectAt(objectAt(settings, 'agent'), 'limits'), 'concurrency');
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 读已 deprecated 的 `limits.concurrency_per_repo`（只给存量配置兜底）。 */
function legacyConcurrencyOf(settings: unknown): number | undefined {
  const value = objectAt(objectAt(settings, 'limits'), 'concurrency_per_repo');
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 从 `repos.settings` 里读项目级并发上限。
 *
 * 与 `queueWaitMinutesOf` 同样的取舍：只读一个数字，越界就夹到 1–8、读不到就回落到默认 2——
 * 一个写坏的 jsonb 不该让仓库「永远拿不到槽位」，也不该让它「独占全部槽位」。
 */
export function concurrencyPerRepoOf(settings: unknown): number {
  const raw =
    v21ConcurrencyOf(settings) ?? legacyConcurrencyOf(settings) ?? DEFAULT_CONCURRENCY_PER_REPO;
  return Math.min(MAX_CONCURRENCY_PER_REPO, Math.max(MIN_CONCURRENCY_PER_REPO, Math.trunc(raw)));
}

/** 仓库级并发的注入端口：worker 每取到一个任务就问一次「这个仓库能同时跑几个」。 */
export type RepoConcurrencyGate = {
  /** 该仓库允许的并发上限（实现里通常读 `repos.settings`）。 */
  readonly limitFor: (repo: string) => Promise<number>;
};

/** 按仓库分组的信号量。 */
export class RepoConcurrencyLimiter {
  readonly #active = new Map<string, number>();
  readonly #waiters = new Map<string, Array<() => void>>();

  /** 某仓库当前在跑的槽位数。 */
  activeCount(repo: string): number {
    return this.#active.get(repo) ?? 0;
  }

  /** 全部在跑的槽位数（面板/日志用）。 */
  totalActive(): number {
    let total = 0;
    for (const count of this.#active.values()) {
      total += count;
    }
    return total;
  }

  /** 有任务在排队等待的仓库名。 */
  waitingRepos(): readonly string[] {
    return [...this.#waiters.keys()];
  }

  /**
   * 拿一个槽位。返回**幂等**的释放函数（重复调用只生效一次）；
   * 调用方必须 `try/finally` 释放，否则这个仓库会被永久卡住。
   *
   * 等槽是**阻塞等待**而不是丢弃（需求 §6.7「排队等待，不丢弃」）：等待者不超时、不返回失败，
   * 只会一直等到有槽位转移过来。
   */
  async acquire(repo: string, limit: number): Promise<() => void> {
    const safeLimit = Math.max(MIN_CONCURRENCY_PER_REPO, Math.trunc(limit));
    if (this.activeCount(repo) < safeLimit) {
      this.#bump(repo, 1);
      return this.#releaser(repo);
    }
    await new Promise<void>((resolve) => {
      const queue = this.#waiters.get(repo) ?? [];
      queue.push(resolve);
      this.#waiters.set(repo, queue);
    });
    // 被唤醒时槽位是「转移」过来的，active 数不变（见 #releaser）
    return this.#releaser(repo);
  }

  /** 拿槽位跑一段活，结束时必定释放（推荐入口）。 */
  async run<T>(repo: string, limit: number, task: () => Promise<T>): Promise<T> {
    const release = await this.acquire(repo, limit);
    try {
      return await task();
    } finally {
      release();
    }
  }

  #bump(repo: string, delta: number): void {
    const next = this.activeCount(repo) + delta;
    if (next <= 0) {
      this.#active.delete(repo);
      return;
    }
    this.#active.set(repo, next);
  }

  #releaser(repo: string): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const queue = this.#waiters.get(repo);
      const next = queue?.shift();
      if (next !== undefined) {
        if (queue !== undefined && queue.length === 0) {
          this.#waiters.delete(repo);
        }
        // 槽位直接交给下一个等待者：不先减再加，避免「减到 0 时新来的任务插队」
        next();
        return;
      }
      this.#waiters.delete(repo);
      this.#bump(repo, -1);
    };
  }
}
