/**
 * `bot_labels` 的 PG 记账实现（`github/executor.ts` 的 `BotLabelLedger` 端口）。
 *
 * 这张表是「我打过哪些标签」的**唯一事实源**（tech-plan §7.2）。执行器只负责按计划调用它，
 * 于是「只增删自己打过的标签」（plan §6.1）就有了可核对的依据，而不是靠读 issue 现状反推——
 * 反推会把「人自己打的 bug」误判成「我们打的 bug」，然后在重算时把它删掉。
 *
 * 三条不变式：
 *  1. 「当前持有」= `removed_at IS NULL` 的行；`bot_labels_active_uidx` 是 partial 唯一索引，
 *     所以重复打标必须 `ON CONFLICT ... WHERE removed_at IS NULL DO NOTHING`，不能裸插。
 *  2. 撤标是**置位**不是删除：删了行就再也答不上「这个标签当初是谁打的」。
 *  3. 新增的四列（`source_key` / `judgement_hash` / `reason` / `run_id`，W2-E）是**归因**：
 *     面板要回答「这个标签是按哪条判定打的、哪一轮打的、为什么」。它们可空，
 *     所以老调用点（只给 `{now}`）行为不变。
 */
import type { BotLabelLedger } from '../github/index.ts';
import { humanVetoedFrom } from './normalize.ts';
import type { SqlRunner } from './ports.ts';

export const BOT_LABEL_SQL = {
  /** $1 repo, $2 issue_number, $3 label, $4 source_key, $5 judgement_hash, $6 reason, $7 run_id, $8 applied_at */
  insertActive: `INSERT INTO "bot_labels"
  ("repo", "issue_number", "label", "source_key", "judgement_hash", "reason", "run_id", "applied_at")
VALUES ($1, $2, $3, $4, $5, $6, $7::uuid, $8::timestamptz)
ON CONFLICT ("repo", "issue_number", "label") WHERE "removed_at" IS NULL DO NOTHING`,
  /** $1 repo, $2 issue_number, $3 labels(text[]), $4 removed_at */
  markRemoved: `UPDATE "bot_labels"
SET "removed_at" = $4::timestamptz
WHERE "repo" = $1 AND "issue_number" = $2 AND "label" = ANY($3::text[]) AND "removed_at" IS NULL`,
  /** $1 repo, $2 issue_number → 当前我们持有的标签名 */
  listActive: `SELECT "label" FROM "bot_labels"
WHERE "repo" = $1 AND "issue_number" = $2 AND "removed_at" IS NULL
ORDER BY "label"`,
  /** $1 repo, $2 issue_number → 全历史（含已撤下的），「人工否决」从它的最后一条推 */
  listHistory: `SELECT "label", "applied_at", "removed_at" FROM "bot_labels"
WHERE "repo" = $1 AND "issue_number" = $2
ORDER BY "label", "applied_at"`,
} as const;

/** 读「我们在该目标上当前持有的标签」。 */
export async function listBotLabels(
  db: SqlRunner,
  input: { readonly repo: string; readonly issueNumber: number },
): Promise<string[]> {
  const result = await db.query(BOT_LABEL_SQL.listActive, [input.repo, input.issueNumber]);
  return result.rows
    .map((row) => (row as { label?: unknown }).label)
    .filter((label): label is string => typeof label === 'string');
}

/** 读全历史行（含已撤下的）；时间列已转成 `Date`。 */
export async function listBotLabelHistory(
  db: SqlRunner,
  input: { readonly repo: string; readonly issueNumber: number },
): Promise<ReadonlyArray<{ readonly label: string; readonly appliedAt: Date; readonly removedAt: Date | null }>> {
  const result = await db.query(BOT_LABEL_SQL.listHistory, [input.repo, input.issueNumber]);
  return result.rows.map((row) => {
    const record = row as Record<string, unknown>;
    return {
      label: String(record['label'] ?? ''),
      appliedAt: toDate(record['applied_at']) ?? new Date(0),
      removedAt: toDate(record['removed_at']),
    };
  });
}

/**
 * 读「人工否决」集合（人把我们打过的标签撤了、之后我们没再打回来）。
 *
 * 用途（`docs/impl-multi-repo.md` §4 W2-E 第 1 条最后一步）：归一化时把这些标签剔除，
 * 否则重算一轮就会把用户刚撕掉的 `needs-info` 又贴回去——那是最招人烦的一种自动化。
 */
export async function loadHumanVetoed(
  db: SqlRunner,
  input: { readonly repo: string; readonly issueNumber: number },
): Promise<readonly string[]> {
  const history = await listBotLabelHistory(db, input);
  return humanVetoedFrom(history);
}

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

/** 单轮打标的归因（写进 `bot_labels` 的四列）。 */
export type BotLabelAttribution = {
  /** 产出这条结论的 run id（uuid；`null` = 不知道）。 */
  readonly runId?: string | null;
  /** 判定快照哈希（**issue 版本 hash**，不是缺失项集合 hash）。 */
  readonly judgementHash?: string | null;
  /** 标签 → 归因（`source_key` 是判定键，`reason` 是给人看的一句话）。 */
  readonly byLabel?: Readonly<Record<string, { readonly sourceKey?: string; readonly reason?: string }>>;
};

/**
 * 建记账器。`now` 可注入是为了单测能断言时间列（生产用 `Date`）。
 *
 * 加标与撤标都**先写库再返回**：执行器那边是「成功才记账」，
 * 所以这里不需要处理「GitHub 成功但落库失败」的回滚——真要回滚，重新跑一次就会收敛。
 *
 * `attribution` 是 W2-E 新增的可选参数：不给时插入的四个归因列都是 `NULL`，
 * 与改造前的行为逐列一致。
 */
export function createPgBotLabelLedger(
  db: SqlRunner,
  options: { readonly now?: () => Date; readonly attribution?: BotLabelAttribution } = {},
): BotLabelLedger {
  const now = options.now ?? (() => new Date());
  const attribution = options.attribution ?? {};
  return {
    recordApplied: async (input) => {
      const appliedAt = now().toISOString();
      for (const label of input.labels) {
        const meta = attribution.byLabel?.[label];
        await db.query(BOT_LABEL_SQL.insertActive, [
          input.repo,
          input.issueNumber,
          label,
          meta?.sourceKey ?? null,
          attribution.judgementHash ?? null,
          meta?.reason ?? null,
          attribution.runId ?? null,
          appliedAt,
        ]);
      }
    },
    recordRemoved: async (input) => {
      if (input.labels.length === 0) {
        return;
      }
      await db.query(BOT_LABEL_SQL.markRemoved, [
        input.repo,
        input.issueNumber,
        [...input.labels],
        now().toISOString(),
      ]);
    },
  };
}

/**
 * 「按本轮归因造记账器」的工厂（生产接线用）。
 *
 * 为什么需要工厂而不是直接给 `BotLabelLedger`：归因（`run_id` / `judgement_hash` / `source_key`）
 * 是**每一轮才算得出来**的东西，而 `BotLabelLedger` 是建一次就固定的对象。
 * 让调用方传工厂，打标路径就能在拿到 runId 之后再造记账器，两个约束都满足。
 */
export function createAttributedBotLabelLedger(
  db: SqlRunner,
  options: { readonly now?: () => Date } = {},
): (attribution: BotLabelAttribution) => BotLabelLedger {
  return (attribution) => createPgBotLabelLedger(db, { ...options, attribution });
}
