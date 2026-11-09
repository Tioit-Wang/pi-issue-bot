/**
 * `bot_labels` 的 PG 记账实现（`github/executor.ts` 的 `BotLabelLedger` 端口）。
 *
 * 这张表是「我打过哪些标签」的**唯一事实源**（tech-plan §7.2）。执行器只负责按计划调用它，
 * 于是「只增删自己打过的标签」（plan §6.1）就有了可核对的依据，而不是靠读 issue 现状反推——
 * 反推会把「人自己打的 bug」误判成「我们打的 bug」，然后在重算时把它删掉。
 *
 * 两条不变式：
 *  1. 「当前持有」= `removed_at IS NULL` 的行；`bot_labels_active_uidx` 是 partial 唯一索引，
 *     所以重复打标必须 `ON CONFLICT ... WHERE removed_at IS NULL DO NOTHING`，不能裸插。
 *  2. 撤标是**置位**不是删除：删了行就再也答不上「这个标签当初是谁打的」。
 */
import type { BotLabelLedger } from '../github/index.ts';
import type { SqlRunner } from './ports.ts';

export const BOT_LABEL_SQL = {
  /** $1 repo, $2 issue_number, $3 label, $4 applied_at */
  insertActive: `INSERT INTO "bot_labels" ("repo", "issue_number", "label", "applied_at")
VALUES ($1, $2, $3, $4::timestamptz)
ON CONFLICT ("repo", "issue_number", "label") WHERE "removed_at" IS NULL DO NOTHING`,
  /** $1 repo, $2 issue_number, $3 labels(text[]), $4 removed_at */
  markRemoved: `UPDATE "bot_labels"
SET "removed_at" = $4::timestamptz
WHERE "repo" = $1 AND "issue_number" = $2 AND "label" = ANY($3::text[]) AND "removed_at" IS NULL`,
  /** $1 repo, $2 issue_number → 当前我们持有的标签名 */
  listActive: `SELECT "label" FROM "bot_labels"
WHERE "repo" = $1 AND "issue_number" = $2 AND "removed_at" IS NULL
ORDER BY "label"`,
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

/**
 * 建记账器。`now` 可注入是为了单测能断言时间列（生产用 `Date`）。
 *
 * 加标与撤标都**先写库再返回**：执行器那边是「成功才记账」，
 * 所以这里不需要处理「GitHub 成功但落库失败」的回滚——真要回滚，重新跑一次就会收敛。
 */
export function createPgBotLabelLedger(
  db: SqlRunner,
  options: { readonly now?: () => Date } = {},
): BotLabelLedger {
  const now = options.now ?? (() => new Date());
  return {
    recordApplied: async (input) => {
      const appliedAt = now().toISOString();
      for (const label of input.labels) {
        await db.query(BOT_LABEL_SQL.insertActive, [input.repo, input.issueNumber, label, appliedAt]);
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