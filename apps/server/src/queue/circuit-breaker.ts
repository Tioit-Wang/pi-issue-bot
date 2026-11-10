/**
 * 两级 429 熔断（tech-plan §7.4 第 2 条 + `docs/impl-multi-repo.md` §4 W1-B 第 4 条）。
 *
 * 规则（**滑动窗口**，不是「连续次数」）：
 *  - **仓库级**：10 分钟内 3 次 429 → 只暂停这个仓库（`runtime_flags.repo = 'owner/name'`）；
 *  - **全局**：15 分钟内 5 次 429 → 暂停全部（`runtime_flags.repo IS NULL`）。
 *
 * 两级**互不影响**：一个仓库把模型打到限流，只该让这个仓库歇 10 分钟，
 * 不该让另外九个仓库一起停摆；反之全局限流一定同时压住所有仓库。
 * 所以两级的计数、窗口、阈值、flag 行各存一份，`CircuitBreaker` 只负责「同一份时钟 + 同一份预算」。
 *
 * 为什么不引熔断库（§7.4 明写）：`opossum` 的语义是「打开后快速失败」，我们要的是「暂停入队」，
 * 硬套只会扭曲语义。这里就是一个滑动窗口计数器 + 一个时间戳。
 *
 * 两个刻意的设计：
 *  - **不在内存里存「暂停到什么时候」当唯一事实**：多进程部署时（§8.4 `--worker-only`）
 *    两个进程各有一份计数器，必须落 `runtime_flags` 才算全局。所以这里既提供状态机，
 *    也提供读写该 flag 的 SQL 与两侧判定。
 *  - **`until` 过了即视为解冻**，不需要额外的清理任务：读侧比较时间就够了。
 *
 * 迁移 0003 之后 `runtime_flags` 的 pkey 被删掉，换成两条 partial 唯一索引
 * （`(key) WHERE repo IS NULL` 与 `(key, repo) WHERE repo IS NOT NULL`），
 * 所以 UPSERT 必须**带上同一个谓词**，否则运行期报 `no unique or exclusion constraint matching`。
 */
import { RUNTIME_FLAG_KEY } from '../db/schema.ts';

/** 全局：15 分钟内 5 次 429 触发暂停（plan §9.2「连续 5 次 429 触发全局熔断」） */
export const RATE_LIMIT_TRIP_THRESHOLD = 5;

/** 全局暂停时长：15min（同上） */
export const RATE_LIMIT_PAUSE_SECONDS = 15 * 60;

/** 仓库级：10 分钟内 3 次 429（多仓库后新增，单个仓库的模型错误不该拖垮别的项目） */
export const REPO_RATE_LIMIT_TRIP_THRESHOLD = 3;

/** 仓库级窗口：10min（同时是仓库级的暂停时长） */
export const REPO_RATE_LIMIT_WINDOW_SECONDS = 10 * 60;

/** 熔断级别：仓库级 / 全局。 */
export type BreakerLevel = 'repo' | 'global';

export type BreakerState = {
  /** 窗口内的命中次数 */
  readonly count: number;
  /** 是否达到阈值（达到即视为本轮触发） */
  readonly tripped: boolean;
  /** 暂停到期时刻；null = 未暂停 */
  readonly pausedUntil: Date | null;
  /** 阈值（面板/日志展示用） */
  readonly threshold: number;
  /** 窗口长度（秒） */
  readonly windowSeconds: number;
};

export type BreakerOptions = {
  threshold?: number;
  windowSeconds?: number;
  /** 注入时钟，单测不依赖真实时间 */
  now?: () => Date;
};

/** 滑窗计数器 + 暂停窗口。非线程安全，但单进程内 worker 是串行调用的（拿任务前一次）。 */
export class RateLimitWindowBreaker {
  readonly #threshold: number;
  readonly #windowSeconds: number;
  readonly #now: () => Date;
  #hits: number[] = [];
  #pausedUntil: Date | null = null;

  constructor(options: BreakerOptions = {}) {
    this.#threshold = options.threshold ?? RATE_LIMIT_TRIP_THRESHOLD;
    this.#windowSeconds = options.windowSeconds ?? RATE_LIMIT_PAUSE_SECONDS;
    this.#now = options.now ?? (() => new Date());
  }

  /** 记一次 429；返回记完后的状态（调用方据此决定要不要写 `runtime_flags`）。 */
  recordRateLimit(): BreakerState {
    const nowMs = this.#now().getTime();
    this.#prune(nowMs);
    this.#hits.push(nowMs);
    if (this.#hits.length >= this.#threshold) {
      this.#pausedUntil = new Date(nowMs + this.#windowSeconds * 1000);
    }
    return this.state();
  }

  /** 记一次成功：窗口内的命中清空（暂停窗口不因成功而缩短，避免「边暂停边放行」）。 */
  recordSuccess(): BreakerState {
    this.#hits = [];
    return this.state();
  }

  /** 是否处于暂停窗口。到期就地解冻（并把窗口计数清零，否则下个 429 会立刻再次触发）。 */
  isPaused(): boolean {
    const until = this.#pausedUntil;
    if (until === null) {
      return false;
    }
    if (this.#now().getTime() >= until.getTime()) {
      this.#pausedUntil = null;
      this.#hits = [];
      return false;
    }
    return true;
  }

  state(): BreakerState {
    this.#prune(this.#now().getTime());
    return {
      count: this.#hits.length,
      tripped: this.#pausedUntil !== null && this.#pausedUntil.getTime() > this.#now().getTime(),
      pausedUntil: this.#pausedUntil === null ? null : new Date(this.#pausedUntil.getTime()),
      threshold: this.#threshold,
      windowSeconds: this.#windowSeconds,
    };
  }

  /** 丢掉滑出窗口的命中（`now` 由调用方给，避免一次状态查询读两次时钟）。 */
  #prune(nowMs: number): void {
    const cutoff = nowMs - this.#windowSeconds * 1000;
    if (this.#hits.length === 0) {
      return;
    }
    this.#hits = this.#hits.filter((hit) => hit > cutoff);
  }
}

export type CircuitBreakerOptions = {
  now?: () => Date;
  /** 仓库级参数（默认 3 次 / 10min） */
  repo?: { threshold?: number; windowSeconds?: number };
  /** 全局参数（默认 5 次 / 15min） */
  global?: { threshold?: number; windowSeconds?: number };
};

/**
 * 两级熔断器：一个全局计数器 + 每个仓库一个计数器。
 *
 * 仓库计数器按需创建（`repo(repo)`），内存里没有的仓库等价于「没被限流过」。
 */
export class CircuitBreaker {
  readonly #now: () => Date;
  readonly #global: RateLimitWindowBreaker;
  readonly #repoOptions: { threshold: number; windowSeconds: number };
  readonly #repos = new Map<string, RateLimitWindowBreaker>();

  constructor(options: CircuitBreakerOptions = {}) {
    this.#now = options.now ?? ((): Date => new Date());
    this.#global = new RateLimitWindowBreaker({
      now: this.#now,
      threshold: options.global?.threshold ?? RATE_LIMIT_TRIP_THRESHOLD,
      windowSeconds: options.global?.windowSeconds ?? RATE_LIMIT_PAUSE_SECONDS,
    });
    this.#repoOptions = {
      threshold: options.repo?.threshold ?? REPO_RATE_LIMIT_TRIP_THRESHOLD,
      windowSeconds: options.repo?.windowSeconds ?? REPO_RATE_LIMIT_WINDOW_SECONDS,
    };
  }

  /** 全局计数器。 */
  global(): RateLimitWindowBreaker {
    return this.#global;
  }

  /** 某仓库的计数器（按需创建）。 */
  repo(repo: string): RateLimitWindowBreaker {
    const existing = this.#repos.get(repo);
    if (existing !== undefined) {
      return existing;
    }
    const created = new RateLimitWindowBreaker({ now: this.#now, ...this.#repoOptions });
    this.#repos.set(repo, created);
    return created;
  }

  /** 记一次 429：仓库级与全局**都记**（一次限流既是仓库的也是全局的候选）。 */
  recordRateLimit(repo: string | null): { repo: BreakerState | null; global: BreakerState } {
    return {
      repo: repo === null ? null : this.repo(repo).recordRateLimit(),
      global: this.#global.recordRateLimit(),
    };
  }

  /** 记一次成功：清掉该仓库与全局的窗口（两级的暂停窗口都不缩短）。 */
  recordSuccess(repo: string | null): void {
    if (repo !== null) {
      this.repo(repo).recordSuccess();
    }
    this.#global.recordSuccess();
  }

  /** 谁在暂停：仓库级优先（更精确的那个先被报出来）。 */
  isPaused(repo: string | null): { paused: boolean; scope: BreakerLevel | null } {
    if (repo !== null && this.repo(repo).isPaused()) {
      return { paused: true, scope: 'repo' };
    }
    if (this.#global.isPaused()) {
      return { paused: true, scope: 'global' };
    }
    return { paused: false, scope: null };
  }

  /** 有计数器（且被触发过）的仓库名。 */
  repos(): readonly string[] {
    return [...this.#repos.keys()];
  }
}

/** `runtime_flags` 的一行（`key` / `repo` / `value` / `until`）。`repo = null` 表示全局。 */
export type RuntimeFlagRow = {
  readonly key: string;
  readonly repo: string | null;
  readonly value: string;
  readonly until: Date | null;
};

/** 读侧只需要这两列（`isPauseFlagActive` / `pauseRedeliverSeconds` 的入参形状）。 */
export type PauseFlagRow = {
  readonly value: string;
  readonly until: Date | null;
};

/**
 * 读写 `runtime_flags` 的语句（调用方注入 executor，不在这里建池）。
 *
 * 迁移 0003 之后统一按 `repo` 分作用域：
 *  - `read` / `upsert` 只碰**全局行**（`repo IS NULL`）——不这么写就会读到某个仓库的行；
 *  - `readRepo` / `upsertRepo` 只碰**仓库行**；
 *  - UPSERT 必须带上 partial 索引的谓词（见文件头）。
 */
export const RUNTIME_FLAG_SQL = {
  /** $1 = key → { value, until }（全局行） */
  read: `SELECT "value", "until" FROM "runtime_flags" WHERE "key" = $1 AND "repo" IS NULL`,
  /** $1 = key, $2 = repo → { value, until }（仓库行） */
  readRepo: `SELECT "value", "until" FROM "runtime_flags" WHERE "key" = $1 AND "repo" = $2`,
  /** $1 = key[], 一次读多条全局 flag（webhook 每次投递只查一次） */
  readMany: `SELECT "key", "value", "until" FROM "runtime_flags" WHERE "repo" IS NULL AND "key" = ANY($1::text[])`,
  /** 全局写：$1 = key, $2 = value, $3 = until（幂等 UPSERT：写 flag 不该失败于「键已存在」） */
  upsert: `INSERT INTO "runtime_flags" ("key", "repo", "value", "until", "updated_at")
VALUES ($1, NULL, $2, $3, now())
ON CONFLICT ("key") WHERE "repo" IS NULL DO UPDATE
SET "value" = EXCLUDED."value", "until" = EXCLUDED."until", "updated_at" = now()`,
  /** 仓库级写：$1 = key, $2 = repo, $3 = value, $4 = until */
  upsertRepo: `INSERT INTO "runtime_flags" ("key", "repo", "value", "until", "updated_at")
VALUES ($1, $2, $3, $4, now())
ON CONFLICT ("key", "repo") WHERE "repo" IS NOT NULL DO UPDATE
SET "value" = EXCLUDED."value", "until" = EXCLUDED."until", "updated_at" = now()`,
} as const;

/**
 * 安装被暂停（`installation.suspend`）的 flag key。
 *
 * 作用域是**全局**（`repo IS NULL`）：一个 installation 可以覆盖多个仓库，
 * 暂停它等于暂停「这一批仓库」，写成仓库级 row 会让 suspend 与 unsuspend 的增删对不上。
 */
export function installationPauseKey(installationId: string | number): string {
  return `pause:installation:${String(installationId)}`;
}

/**
 * 把熔断状态翻成要落库的 flag 行。
 *
 * 未暂停时 `until` 置为过去时间（而不是删行）：`runtime_flags` 只增不删，读侧按 `until` 判活。
 * `repo` 缺省/null = 全局行。
 */
export function breakerFlagRow(
  state: BreakerState,
  options: { readonly repo?: string | null; readonly key?: string; readonly now?: Date } = {},
): RuntimeFlagRow {
  const now = options.now ?? new Date();
  return {
    key: options.key ?? RUNTIME_FLAG_KEY.rateLimitPause,
    repo: options.repo ?? null,
    value: state.pausedUntil === null ? '0' : '1',
    until: state.pausedUntil ?? new Date(now.getTime() - 1000),
  };
}

/**
 * 读侧判定：该 flag 现在是否生效。
 *  - 行不存在 / `value !== '1'` → 未暂停
 *  - `until` 为 null → 暂停不过期（人工置的开关；`installation.suspend` 就是这种）
 *  - `until` 已过 → 未暂停
 */
export function isPauseFlagActive(row: PauseFlagRow | null, now: Date = new Date()): boolean {
  if (row === null || row.value !== '1') {
    return false;
  }
  if (row.until === null) {
    return true;
  }
  return row.until.getTime() > now.getTime();
}

/** 暂停时 worker 的重投延迟（秒）：等到窗口结束即可，不必自己再加抖动。 */
export function pauseRedeliverSeconds(row: PauseFlagRow, now: Date = new Date()): number {
  if (!isPauseFlagActive(row, now) || row.until === null) {
    return 0;
  }
  return Math.max(1, Math.ceil((row.until.getTime() - now.getTime()) / 1000));
}
