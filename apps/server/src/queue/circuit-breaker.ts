/**
 * 全局 429 熔断（tech-plan §7.4 第 2 条）。
 *
 * 规则：**连续 5 次 429 → 写 `runtime_flags{key:'rate_limit_pause', until: now+15min}`**；
 * worker 在取任务前读这个 flag，为真就直接延迟重投。
 *
 * 为什么不引熔断库（§7.4 明写）：`opossum` 的语义是「打开后快速失败」，我们要的是「暂停入队」，
 * 硬套只会扭曲语义。这里就是一个计数器 + 一个时间戳，四十行。
 *
 * 两个刻意的设计：
 *  - **不在内存里存「暂停到什么时候」当唯一事实**：多进程部署时（§8.4 `--worker-only`）
 *    两个进程各有一份计数器，必须落 `runtime_flags` 才算全局。所以这里既提供状态机，
 *    也提供读写该 flag 的 SQL 与两侧判定。
 *  - **`until` 过了即视为解冻**，不需要额外的清理任务：读侧比较时间就够了。
 */
import { RUNTIME_FLAG_KEY } from '../db/schema.ts';

/** 连续多少次 429 触发暂停（plan §9.2「连续 5 次 429 触发全局熔断」） */
export const RATE_LIMIT_TRIP_THRESHOLD = 5;

/** 暂停时长：15min（同上） */
export const RATE_LIMIT_PAUSE_SECONDS = 15 * 60;

export type BreakerState = {
  /** 连续 429 次数（成功一次即清零） */
  readonly consecutive: number;
  /** 暂停到期时刻；null = 未暂停 */
  readonly pausedUntil: Date | null;
};

export type RateLimitBreakerOptions = {
  threshold?: number;
  pauseSeconds?: number;
  /** 注入时钟，单测不依赖真实时间 */
  now?: () => Date;
};

/** 连续 429 计数器 + 暂停窗口。非线程安全，但单进程内 worker 是串行调用的（拿任务前一次）。 */
export class RateLimitBreaker {
  readonly #threshold: number;
  readonly #pauseSeconds: number;
  readonly #now: () => Date;
  #consecutive = 0;
  #pausedUntil: Date | null = null;

  constructor(options: RateLimitBreakerOptions = {}) {
    this.#threshold = options.threshold ?? RATE_LIMIT_TRIP_THRESHOLD;
    this.#pauseSeconds = options.pauseSeconds ?? RATE_LIMIT_PAUSE_SECONDS;
    this.#now = options.now ?? (() => new Date());
  }

  /** 记一次 429；返回记完后的状态（调用方据此决定要不要写 `runtime_flags`）。 */
  recordRateLimit(): BreakerState {
    this.#consecutive += 1;
    if (this.#consecutive >= this.#threshold) {
      this.#pausedUntil = new Date(this.#now().getTime() + this.#pauseSeconds * 1000);
    }
    return this.state();
  }

  /** 记一次成功：连续计数清零（暂停窗口不因成功而缩短，避免「边暂停边放行」）。 */
  recordSuccess(): BreakerState {
    this.#consecutive = 0;
    return this.state();
  }

  /** 是否处于暂停窗口。到期就地解冻（并把连续计数清零，否则下个 429 会立刻再次触发）。 */
  isPaused(): boolean {
    const until = this.#pausedUntil;
    if (until === null) {
      return false;
    }
    if (this.#now().getTime() >= until.getTime()) {
      this.#pausedUntil = null;
      this.#consecutive = 0;
      return false;
    }
    return true;
  }

  state(): BreakerState {
    return {
      consecutive: this.#consecutive,
      pausedUntil: this.#pausedUntil === null ? null : new Date(this.#pausedUntil.getTime()),
    };
  }
}

/** `runtime_flags` 的一行（`key` / `value` / `until`）。 */
export type RuntimeFlagRow = {
  readonly key: string;
  readonly value: string;
  readonly until: Date | null;
};

/** 读写 `runtime_flags` 的两条语句（调用方注入 executor，不在这里建池）。 */
export const RUNTIME_FLAG_SQL = {
  /** $1 = key → { value, until } */
  read: `SELECT "value", "until" FROM "runtime_flags" WHERE "key" = $1`,
  /** $1 = key, $2 = value, $3 = until（幂等 UPSERT：写 flag 不该失败于「键已存在」） */
  upsert: `INSERT INTO "runtime_flags" ("key", "value", "until", "updated_at")
VALUES ($1, $2, $3, now())
ON CONFLICT ("key") DO UPDATE
SET "value" = EXCLUDED."value", "until" = EXCLUDED."until", "updated_at" = now()`,
} as const;

/**
 * 把熔断状态翻成要落库的 flag 行。
 * 未暂停时 `until` 置为过去时间（而不是删行）：`runtime_flags` 只增不删，读侧按 `until` 判活。
 */
export function breakerFlagRow(state: BreakerState, now: Date = new Date()): RuntimeFlagRow {
  return {
    key: RUNTIME_FLAG_KEY.rateLimitPause,
    value: state.pausedUntil === null ? '0' : '1',
    until: state.pausedUntil ?? new Date(now.getTime() - 1000),
  };
}

/**
 * 读侧判定：该 flag 现在是否生效。
 *  - 行不存在 / `value !== '1'` → 未暂停
 *  - `until` 为 null → 暂停不过期（人工置的开关）
 *  - `until` 已过 → 未暂停
 */
export function isPauseFlagActive(row: RuntimeFlagRow | null, now: Date = new Date()): boolean {
  if (row === null || row.value !== '1') {
    return false;
  }
  if (row.until === null) {
    return true;
  }
  return row.until.getTime() > now.getTime();
}

/** 暂停时 worker 的重投延迟（秒）：等到窗口结束即可，不必自己再加抖动。 */
export function pauseRedeliverSeconds(row: RuntimeFlagRow, now: Date = new Date()): number {
  if (!isPauseFlagActive(row, now) || row.until === null) {
    return 0;
  }
  return Math.max(1, Math.ceil((row.until.getTime() - now.getTime()) / 1000));
}
