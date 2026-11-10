/**
 * `issue_feedback` 与 `runtime_flags` 的 SQL（W2-D）。
 *
 * 参数化到底，`jsonb` 列显式 `::jsonb` + `JSON.stringify`（同 `worker/run-store.ts` 的约定：
 * `pg` 会把 JS 数组按 Postgres 数组编码，直接塞进 jsonb 列就是坏数据）。
 *
 * 唯一键 `(repo, target_kind, target_number, stage, anchor)` 是**幂等闸**：
 * `ON CONFLICT DO NOTHING` 命中时不报错、不返行（`RETURNING` 为空数组），
 * 于是「同一 (目标, 阶段, 锚点) 只打一次 reaction」由数据库保证，不靠内存去重表。
 */
export const FEEDBACK_SQL = {
  /** $1..$8 → 新行；冲突时返回空集（调用方据此走「读回既有行」分支）。 */
  claim: `INSERT INTO "issue_feedback"
  ("repo", "target_kind", "target_number", "comment_id", "stage", "content", "anchor", "audit")
VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
ON CONFLICT ("repo", "target_kind", "target_number", "stage", "anchor") DO NOTHING
RETURNING "id", "content", "reaction_id", "applied_at"`,

  /** $1..$5 = (repo, target_kind, target_number, stage, anchor) → 既有行。 */
  readOne: `SELECT "id", "content", "reaction_id", "applied_at"
  FROM "issue_feedback"
 WHERE "repo" = $1 AND "target_kind" = $2 AND "target_number" = $3
   AND "stage" = $4 AND "anchor" = $5`,

  /** $1 = id, $2 = reaction_id, $3 = applied_at, $4 = audit。 */
  markApplied: `UPDATE "issue_feedback"
   SET "reaction_id" = $2, "applied_at" = $3, "audit" = coalesce($4::jsonb, "audit")
 WHERE "id" = $1`,

  /** $1 = id, $2 = audit（`applied_at` 保持 NULL = 「计划过但没落地」）。 */
  markFailed: `UPDATE "issue_feedback"
   SET "audit" = coalesce($2::jsonb, "audit")
 WHERE "id" = $1`,
} as const;

/** 降级开关的 key（`docs/impl-multi-repo.md` W2-D 第 6 条）。 */
export const REACTIONS_DISABLED_FLAG = 'reactions_disabled';

/**
 * `runtime_flags` 的两条语句，针对**全局** flag（`repo IS NULL`）。
 *
 * 为什么用 partial index 形式的 `ON CONFLICT`：`runtime_flags` 的唯一性拆成了
 * 两条 partial 索引（全局 `(key) WHERE repo IS NULL` / 仓库级 `(key, repo)`），
 * 不带谓词的 `ON CONFLICT (key)` 在 PG 里匹配不到它们。
 */
export const REACTIONS_FLAG_SQL = {
  /** $1 = key → { value, until } */
  read: `SELECT "value", "until" FROM "runtime_flags" WHERE "key" = $1 AND "repo" IS NULL`,
  /** $1 = key, $2 = value, $3 = until */
  upsert: `INSERT INTO "runtime_flags" ("key", "repo", "value", "until", "updated_at")
VALUES ($1, NULL, $2, $3, now())
ON CONFLICT ("key") WHERE "repo" IS NULL DO UPDATE
SET "value" = EXCLUDED."value", "until" = EXCLUDED."until", "updated_at" = now()`,
} as const;
