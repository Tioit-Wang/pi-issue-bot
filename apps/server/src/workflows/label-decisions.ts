/**
 * `label_decisions` 的写入面（`docs/impl-multi-repo.md` §2 的表 + §4 W2-E 第 4 条）。
 *
 * 为什么每轮都要写一行（哪怕什么都没打）：这张表是**唯一能回答「为什么这个 issue 长这样」**
 * 的地方。日志会被轮转、`console.warn` 不能被查询，而面板要展示的正是
 * 「想要的标签 / 真打上的标签 / 被谁拦了 / 为什么」这四件事。
 *
 * 表里 `desired` 与 `applied` 刻意分开：两者不等就说明有东西被拦了（词表外、互斥组、
 * 上限、人工否决……），而 `blocked_reason` 是那些原因的摘要（明细在 `reason`）。
 *
 * 本文件不判定任何东西：判定在 `normalize.ts`，落标在 `github/executor.ts`，
 * 这里只负责「把这一轮的结论按列摊平」。
 */
import type { BlockedLabel } from './normalize.ts';
import type { SqlRunner } from './ports.ts';

/** `blocked_reason` 列的字符上限（表里是 text，这里只是不让它变成一篇文章）。 */
export const BLOCKED_REASON_LIMIT = 500;

export const LABEL_DECISION_SQL = {
  /** $1 repo, $2 target_number, $3 judgement_hash, $4 desired(jsonb), $5 applied(jsonb),
   *  $6 blocked_reason, $7 reason, $8 run_id(uuid) */
  insert: `INSERT INTO "label_decisions"
  ("repo", "target_number", "judgement_hash", "desired", "applied", "blocked_reason", "reason", "run_id")
VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8::uuid)
RETURNING "id"`,
  /** $1 repo, $2 target_number, $3 limit —— 面板「标签与理由」区块按时间倒序取。 */
  selectByTarget: `SELECT "id", "judgement_hash", "desired", "applied", "blocked_reason", "reason", "run_id", "created_at"
FROM "label_decisions"
WHERE "repo" = $1 AND "target_number" = $2
ORDER BY "created_at" DESC, "id" DESC
LIMIT $3`,
} as const;

/** 一轮打标的结论（落库形状）。 */
export type LabelDecisionRecord = {
  readonly repo: string;
  readonly targetNumber: number;
  /**
   * 判定快照哈希。**用 issue 版本 hash**（webhook 的 `issueVersionHash`），
   * 不再用「缺失项集合」当锚：编辑正文但缺失项不变时前者会变、后者不会，导致重算被误判成同一轮。
   */
  readonly judgementHash: string | null;
  /** 归一化之后「想要」的标签。 */
  readonly desired: readonly string[];
  /** 真正打上的标签（`dry-run` 与拿不到信封时为空）。 */
  readonly applied: readonly string[];
  readonly blocked: readonly BlockedLabel[];
  /** 面向人的一句话（缺哪几项、引用哪段），面板直接展示。 */
  readonly reason: string | null;
  readonly runId: string | null;
};

/** 注入面：`triage.ts` 只认这个端口，单测可以给一个只记内存的实现。 */
export type LabelDecisionRecorder = {
  record(input: LabelDecisionRecord): Promise<void> | void;
};

/** 把拦截列表压成 `blocked_reason`（`reason:label` 用 `,` 连，多条用 `;` 连）。 */
export function summarizeBlockedReason(blocked: readonly BlockedLabel[]): string | null {
  if (blocked.length === 0) {
    return null;
  }
  const parts = blocked.map((item) => `${item.reason}:${item.label}`);
  const joined = parts.join('; ');
  return joined.length <= BLOCKED_REASON_LIMIT
    ? joined
    : `${joined.slice(0, BLOCKED_REASON_LIMIT - 1)}…`;
}

/** 写一行；返回自增 id（面板的「重跑一次看差异」靠它排序）。 */
export async function recordLabelDecision(db: SqlRunner, input: LabelDecisionRecord): Promise<number> {
  const result = await db.query(LABEL_DECISION_SQL.insert, [
    input.repo,
    input.targetNumber,
    input.judgementHash,
    JSON.stringify([...input.desired]),
    JSON.stringify([...input.applied]),
    summarizeBlockedReason(input.blocked),
    input.reason,
    input.runId,
  ]);
  const row = result.rows[0] as { id?: unknown } | undefined;
  return typeof row?.id === 'number' ? row.id : Number(row?.id ?? 0);
}

/** 生产用的记录器（装配层注入）。 */
export function createPgLabelDecisionRecorder(db: SqlRunner): LabelDecisionRecorder {
  return {
    record: async (input) => {
      await recordLabelDecision(db, input);
    },
  };
}

/** 读某目标的判定历史（面板/单测用；`limit` 默认 20）。 */
export async function listLabelDecisions(
  db: SqlRunner,
  input: { readonly repo: string; readonly targetNumber: number; readonly limit?: number },
): Promise<readonly Record<string, unknown>[]> {
  const result = await db.query(LABEL_DECISION_SQL.selectByTarget, [
    input.repo,
    input.targetNumber,
    input.limit ?? 20,
  ]);
  return result.rows as readonly Record<string, unknown>[];
}
