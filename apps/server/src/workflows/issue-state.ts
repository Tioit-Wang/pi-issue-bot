/**
 * `issue_states` 的读写（tech-plan §7.2 的 F4）。
 *
 * 这张表是两件事的**唯一判定源**：
 *  - plan §6.2「只在缺失项集合变化时再回复」——要记住上一次的集合哈希与「催过没」；
 *  - plan §7「关闭」——要记住这批缺失项是什么时候出现的、人有没有再说话。
 *
 * 写入点只有两处，别的路径一律不许写这张表：
 *  1. 判定产出之后（`applyMissingSet` / `markNudged`）。**2026-11 起缺信息不再算「缺失项集合」**：
 *     合规评论已删除（`docs/impl-multi-repo.md` §0.3），`missing_set_hash` 目前只由
 *     历史数据与关闭判定使用，新流程不再写入；保留这两个函数是为了让关闭闸门能重放旧数据。
 *  2. 收到**人**的 `issue_comment.created`（`recordHumanReply`）。
 *
 * `first_seen_at` 的语义是「**当前这批**缺失项首次出现的时刻」，所以：
 *  - 集合没变 → 不推进（否则 48h 计时会被每次重算清零，issue 永远关不掉）；
 *  - 集合变了 → 重置为本次时刻（这是「新一轮催办」的起点）；
 *  - 集合变空 → 置 `NULL`（关闭判定要求 `missing_set_hash IS NOT NULL`）。
 */
import type { SqlRunner } from './ports.ts';

/** 一行 `issue_states`（时间列已转成 `Date`）。 */
export type IssueStateSnapshot = {
  readonly repo: string;
  readonly issueNumber: number;
  /** `sha256(sorted(failed rule ids))`；`null` = 当前无缺失项。 */
  readonly missingSetHash: string | null;
  readonly firstSeenAt: Date | null;
  readonly lastHumanReplyAt: Date | null;
  readonly lastNudgeAt: Date | null;
  readonly closedAt: Date | null;
  readonly updatedAt: Date | null;
};

const RETURNING_COLUMNS = `"repo", "issue_number", "missing_set_hash", "first_seen_at",
       "last_human_reply_at", "last_nudge_at", "closed_at", "updated_at"`;

export const ISSUE_STATE_SQL = {
  /** $1 repo, $2 issue_number */
  select: `SELECT ${RETURNING_COLUMNS} FROM "issue_states" WHERE "repo" = $1 AND "issue_number" = $2`,
  /**
   * $1 repo, $2 issue_number, $3 missing_set_hash, $4 at
   *
   * 与 tech-plan §7.2 给的那条 UPSERT 等价，只是把 `now()` 换成参数 `$4`（单测要能摆位时间）：
   * `first_seen_at` 只在哈希变化时推进，其余情况原样保留。
   */
  applyMissingSet: `INSERT INTO "issue_states" ("repo", "issue_number", "missing_set_hash", "first_seen_at", "updated_at")
VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz)
ON CONFLICT ("repo", "issue_number") DO UPDATE SET
  "missing_set_hash" = EXCLUDED."missing_set_hash",
  "first_seen_at" = CASE
    WHEN "issue_states"."missing_set_hash" = EXCLUDED."missing_set_hash" THEN "issue_states"."first_seen_at"
    ELSE EXCLUDED."first_seen_at"
  END,
  "updated_at" = EXCLUDED."updated_at"
RETURNING ${RETURNING_COLUMNS}`,
  /**
   * $1 repo, $2 issue_number, $3 at —— 集合变空。
   *
   * 为什么不能复用上面那条：`NULL = NULL` 在 SQL 里是 `NULL`（不是 true），
   * `CASE WHEN` 会走到 ELSE 把 `first_seen_at` 重置成 now()，于是「无缺失项」这个状态
   * 反而带上了一个时间戳。空集合必须显式清零。
   */
  clearMissingSet: `INSERT INTO "issue_states" ("repo", "issue_number", "missing_set_hash", "first_seen_at", "updated_at")
VALUES ($1, $2, NULL, NULL, $3::timestamptz)
ON CONFLICT ("repo", "issue_number") DO UPDATE SET
  "missing_set_hash" = NULL,
  "first_seen_at" = NULL,
  "updated_at" = EXCLUDED."updated_at"
RETURNING ${RETURNING_COLUMNS}`,
  /** $1 repo, $2 issue_number, $3 at */
  markNudged: `UPDATE "issue_states"
SET "last_nudge_at" = $3::timestamptz, "updated_at" = $3::timestamptz
WHERE "repo" = $1 AND "issue_number" = $2`,
  /**
   * $1 repo, $2 issue_number, $3 at
   *
   * 用 UPSERT 而不是纯 UPDATE：一个还没跑过合规判定的 issue 也可能先收到人的评论，
   * 这时 UPDATE 会静默影响 0 行，那条「人说过话」的事实就丢了。
   */
  recordHumanReply: `INSERT INTO "issue_states" ("repo", "issue_number", "missing_set_hash", "last_human_reply_at", "updated_at")
VALUES ($1, $2, NULL, $3::timestamptz, $3::timestamptz)
ON CONFLICT ("repo", "issue_number") DO UPDATE SET
  "last_human_reply_at" = EXCLUDED."last_human_reply_at",
  "updated_at" = EXCLUDED."updated_at"`,
  /** 关闭后置位（关闭是唯一不可回收动作，置位后不再重复关） */
  markClosed: `UPDATE "issue_states"
SET "closed_at" = $3::timestamptz, "updated_at" = $3::timestamptz
WHERE "repo" = $1 AND "issue_number" = $2 AND "closed_at" IS NULL`,
} as const;

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

/** 行 → 快照（列名 snake_case → camelCase 只在这一处做）。 */
export function toIssueStateSnapshot(row: Record<string, unknown>): IssueStateSnapshot {
  return {
    repo: String(row['repo'] ?? ''),
    issueNumber: Number(row['issue_number'] ?? 0),
    missingSetHash: typeof row['missing_set_hash'] === 'string' ? row['missing_set_hash'] : null,
    firstSeenAt: toDate(row['first_seen_at']),
    lastHumanReplyAt: toDate(row['last_human_reply_at']),
    lastNudgeAt: toDate(row['last_nudge_at']),
    closedAt: toDate(row['closed_at']),
    updatedAt: toDate(row['updated_at']),
  };
}

/** 读一行；没有返回 `null`（不抛错：没有状态行是正常状态，不是异常）。 */
export async function loadIssueState(
  db: SqlRunner,
  input: { readonly repo: string; readonly issueNumber: number },
): Promise<IssueStateSnapshot | null> {
  const result = await db.query(ISSUE_STATE_SQL.select, [input.repo, input.issueNumber]);
  const row = result.rows[0];
  return row === undefined ? null : toIssueStateSnapshot(row as Record<string, unknown>);
}

/** 写缺失项集合（`null` 走清零分支），返回写后的行。 */
export async function applyMissingSet(
  db: SqlRunner,
  input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly missingSetHash: string | null;
    readonly at: Date;
  },
): Promise<IssueStateSnapshot> {
  const at = input.at.toISOString();
  const result =
    input.missingSetHash === null
      ? await db.query(ISSUE_STATE_SQL.clearMissingSet, [input.repo, input.issueNumber, at])
      : await db.query(ISSUE_STATE_SQL.applyMissingSet, [
          input.repo,
          input.issueNumber,
          input.missingSetHash,
          at,
        ]);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`issue_states 的 UPSERT 没有返回行：${input.repo}#${input.issueNumber}`);
  }
  return toIssueStateSnapshot(row as Record<string, unknown>);
}

/** 记「催过了」。 */
export async function markNudged(
  db: SqlRunner,
  input: { readonly repo: string; readonly issueNumber: number; readonly at: Date },
): Promise<void> {
  await db.query(ISSUE_STATE_SQL.markNudged, [input.repo, input.issueNumber, input.at.toISOString()]);
}

/** 记「已关闭」。 */
export async function markClosed(
  db: SqlRunner,
  input: { readonly repo: string; readonly issueNumber: number; readonly at: Date },
): Promise<void> {
  await db.query(ISSUE_STATE_SQL.markClosed, [input.repo, input.issueNumber, input.at.toISOString()]);
}

/** 评论作者的人机判定（`author_association` 与 `user.type` 两处都要对）。 */
export function isHumanReplyActor(input: {
  readonly authorAssociation: string;
  readonly userType?: string | null;
  readonly botLogin?: string | null;
  readonly login?: string | null;
}): boolean {
  if ((input.userType ?? '').toLowerCase() === 'bot') {
    return false;
  }
  if (input.botLogin !== undefined && input.botLogin !== null && input.login === input.botLogin) {
    return false;
  }
  return ['MEMBER', 'OWNER', 'COLLABORATOR'].includes(input.authorAssociation.toUpperCase());
}

/**
 * 收到**人**的评论 → 推进 `last_human_reply_at`（这是唯一会推进该字段的事件）。
 *
 * 机器人自己的评论不算，编辑事件也不算（tech-plan §7.2 第 2 条）。
 * 返回是否真的记了，调用方据此决定要不要记审计。
 */
export async function recordHumanReply(
  db: SqlRunner,
  input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly at: Date;
    readonly actor: {
      readonly authorAssociation: string;
      readonly userType?: string | null;
      readonly login?: string | null;
      readonly botLogin?: string | null;
    };
  },
): Promise<boolean> {
  if (!isHumanReplyActor(input.actor)) {
    return false;
  }
  await db.query(ISSUE_STATE_SQL.recordHumanReply, [
    input.repo,
    input.issueNumber,
    input.at.toISOString(),
  ]);
  return true;
}