/**
 * `FeedbackLedger` 与 `ReactionsFlagStore` 的 PG 实现（W2-D）。
 *
 * 两条实现约定与 `worker/run-store.ts` 一致：只走参数化 SQL、`jsonb` 显式 `::jsonb`；
 * 本文件只依赖 `db/`（`SqlExecutor`），不认识 http / worker / queries。
 *
 * 为什么 flag 要在**进程内缓存**：`reactions_disabled` 一旦置上，本进程的每一轮任务都不该
 * 再往 GitHub 发 POST/DELETE（403 说明 App 少了权限，重试只会再撞一次 403）。
 * 于是 `disable()` 立刻把内存开关翻成 true，`isDisabled()` 命中缓存就不再查库；
 * 首次读库拿到 `value='1'` 且未过期时同样落缓存。
 */
import type { SqlExecutor } from '../db/index.ts';
import { FEEDBACK_SQL, REACTIONS_DISABLED_FLAG, REACTIONS_FLAG_SQL } from './sql.ts';
import type {
  FeedbackClaim,
  FeedbackLedger,
  FeedbackRow,
  FeedbackStage,
  FeedbackTargetKind,
  ReactionsFlagStore,
} from './types.ts';

/** `createPgFeedbackLedger()` 的入参。 */
export type PgFeedbackLedgerOptions = {
  readonly pool: SqlExecutor;
};

/** JSON 参数：`undefined` / `null` 保持 SQL NULL，其余序列化成 `::jsonb`。 */
function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/** 日期列可能被驱动给成字符串（旧版本 `pg`）→ 统一成 `Date | null`。 */
function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string' && value !== '') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** `reaction_id` 同样是 `bigint`（驱动给字符串）→ 与 `toNumber()` 同一口径，只是允许 NULL。 */
function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * `bigserial` 列经 `pg` 驱动回来是**字符串**（`int8` 的历史行为）。
 *
 * 为什么必须认字符串：`issue_feedback.id` 是 `bigserial`，`markApplied()` 拿它当
 * `WHERE id = $1`。只认 number 的话 id 会退化成 0 → UPDATE 命中 0 行、**不报错**，
 * 于是 `reaction_id` / `applied_at` 永远回填不上，而「`applied_at` 非空即跳过」正是
 * 台账的幂等闸（W2-D 第 1 条）。装配级测试实测踩到：applied_at 恒为 NULL。
 */
function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** 把一行原始结果收成 `FeedbackRow`（驱动给的字段名是下划线形态）。 */
function rowOf(raw: unknown): FeedbackRow | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (record['id'] === undefined || record['id'] === null) {
    return null;
  }
  return {
    id: toNumber(record['id']),
    content: typeof record['content'] === 'string' ? record['content'] : '',
    reactionId: toNumberOrNull(record['reaction_id']),
    appliedAt: toDate(record['applied_at']),
  };
}

/**
 * `issue_feedback` 的 PG 台账。
 *
 * `claim()` 的两步是「先插、插不进就读回」：`ON CONFLICT DO NOTHING RETURNING` 在冲突时
 * 返回空集，所以冲突后还要一次 `SELECT` 才能拿到既有行的 `applied_at`（决定跳过还是重试）。
 * 两步之间没有事务：这一格只会被同一 `(目标, 阶段, 锚点)` 的并发写碰，读回的最坏结果
 * 是拿到别的进程刚写完的行——那正是我们要的「有人已经做过了」。
 */
export function createPgFeedbackLedger(options: PgFeedbackLedgerOptions): FeedbackLedger {
  const pool = options.pool;

  return {
    async claim(input): Promise<FeedbackClaim> {
      const inserted = await pool.query(FEEDBACK_SQL.claim, [
        input.repo,
        input.targetKind,
        input.targetNumber,
        input.commentId,
        input.stage,
        input.content,
        input.anchor,
        json(input.audit),
      ]);
      const insertedRow = rowOf(inserted.rows[0]);
      if (insertedRow !== null) {
        return { inserted: true, row: insertedRow };
      }

      const existing = await pool.query(FEEDBACK_SQL.readOne, [
        input.repo,
        input.targetKind,
        input.targetNumber,
        input.stage,
        input.anchor,
      ]);
      const row = rowOf(existing.rows[0]);
      if (row === null) {
        // 理论上不可达：冲突说明行存在；读不到只能是并发删除（本项目不删这一表）
        throw new Error(
          `issue_feedback 唯一键冲突但读不到既有行：${input.repo}#${String(input.targetNumber)} ${input.stage}/${input.anchor}`,
        );
      }
      return { inserted: false, row };
    },

    async markApplied(input): Promise<void> {
      await pool.query(FEEDBACK_SQL.markApplied, [
        input.id,
        input.reactionId,
        input.appliedAt,
        json(input.audit),
      ]);
    },

    async markFailed(input): Promise<void> {
      await pool.query(FEEDBACK_SQL.markFailed, [
        input.id,
        json({ status: 'failed', reason: input.reason, httpStatus: input.httpStatus }),
      ]);
    },
  };
}

/** `createPgReactionsFlagStore()` 的入参。 */
export type PgReactionsFlagStoreOptions = {
  readonly pool: SqlExecutor;
  /** 注入时钟（`until` 判定用）。 */
  readonly now?: (() => Date) | undefined;
  /**
   * 初始缓存：装配层可以按「上一次进程已知禁用」直接给 `true`，省掉一次读库。
   * 给出 `true` 后本实例不会再读库（`disable()` 的单向含义）。
   */
  readonly initiallyDisabled?: boolean | undefined;
};

/**
 * `runtime_flags{key:'reactions_disabled'}` 的读写面（全局 flag，`repo IS NULL`）。
 *
 * `isDisabled()` 的判定：内存开关为 true → 直接 true；否则读库一次并缓存结果
 * （`value='1'` 且 `until` 为空或未过期 → true）。写侧只置 true，从不主动清除：
 * 权限问题要人修（装 App / 加权限），不是代码自己恢复的事。
 */
export function createPgReactionsFlagStore(
  options: PgReactionsFlagStoreOptions,
): ReactionsFlagStore {
  const now = options.now ?? ((): Date => new Date());
  let cached = options.initiallyDisabled === true;
  let loaded = cached;

  return {
    async isDisabled(): Promise<boolean> {
      if (loaded) {
        return cached;
      }
      loaded = true;
      const result = await options.pool.query(REACTIONS_FLAG_SQL.read, [REACTIONS_DISABLED_FLAG]);
      const raw = result.rows[0];
      if (typeof raw !== 'object' || raw === null) {
        cached = false;
        return false;
      }
      const record = raw as Record<string, unknown>;
      const until = toDate(record['until']);
      const active =
        record['value'] === '1' && (until === null || until.getTime() > now().getTime());
      cached = active;
      return active;
    },

    async disable(input): Promise<void> {
      // `until` 置空 = 不过期：权限问题要人修（装 App / 加权限），代码不自我恢复。
      // 原因只进日志（`runtime_flags.value` 必须是 '1'，读侧按它判活），故这里不用 input。
      void input;
      await options.pool.query(REACTIONS_FLAG_SQL.upsert, [REACTIONS_DISABLED_FLAG, '1', null]);
      cached = true;
      loaded = true;
    },
  };
}

/** `issue_feedback.stage` 的取值集合（面板/查询侧按它校验）。 */
export const FEEDBACK_STAGE_VALUES: readonly FeedbackStage[] = [
  'received',
  'succeeded',
  'failed',
  'timed-out',
  'cancelled',
];

/** `issue_feedback.target_kind` 的取值集合。 */
export const FEEDBACK_TARGET_KIND_VALUES: readonly FeedbackTargetKind[] = ['issue', 'pr'];
