/**
 * `tasks.idempotency_key` 的生成（tech-plan §7.2 的 F9，webhook 第 6 步用）。
 *
 * 公式：`sha256([kind, repo, target, anchor, trigger_actor].join("\n"))` 取 hex 前 32 位。
 * 落到 `tasks.idempotency_key` 的 unique 索引上——**幂等落在数据库，不靠内存去重**（§5.3）。
 *
 * `anchor` 按 kind 二选一：
 *  - **PR / 命令类用 `head_sha`**：同一提交重跑是空操作（plan §6.4），换新提交才该产生新任务。
 *  - **issue 判定类用 `missing_set_hash`**：issue 没有提交可锚，而「同一批缺失项」正是
 *    「重复回复」的判据（plan §6.2 只在缺失项集合变化时再回复）。
 *
 * `trigger_actor` 进键是**有意的**：人工 `/retry` 与 webhook 重投必须能区分，
 * 否则「重跑」会被唯一键吃掉，人点了 /retry 什么也不会发生。
 *
 * `kind` 取 `triage` / `compliance` / `command:/review-pr` / `create_issue` 这类短串。
 */
import { createHash } from 'node:crypto';

/**
 * 用 `missing_set_hash` 做锚的 kind（issue 判定类）。
 * 其余 kind（含 `create_issue`）一律用 `head_sha`：§7.2 只给了这两档，不额外发明第三种。
 */
export const MISSING_SET_ANCHOR_KINDS: readonly string[] = Object.freeze(['triage', 'compliance']);

/** 键里字段的占位值：字段缺失时用它，保证键仍是确定性的（不抛错、不产出随机串）。 */
export const MISSING_ANCHOR = 'none';

export type IdempotencyInput = {
  /** `triage` / `compliance` / `command:/review-pr` / `create_issue` …… */
  readonly kind: string;
  /** `owner/name` */
  readonly repo: string;
  /** 目标串，建议 `issue#123` / `pr#456`，与 `runs`/`actions` 的 target 口径一致 */
  readonly target: string;
  /** PR / 命令类的锚：提交 sha */
  readonly headSha?: string | null;
  /** issue 判定类的锚：缺失项集合哈希 */
  readonly missingSetHash?: string | null;
  /** 触发者 GitHub login */
  readonly triggerActor: string;
};

/** 该 kind 是否用 `missing_set_hash` 做锚。 */
export function usesMissingSetAnchor(kind: string): boolean {
  return MISSING_SET_ANCHOR_KINDS.includes(kind);
}

/**
 * 取锚。缺失时返回 `MISSING_ANCHOR` 而不是抛错：
 * 入队路径不能因为 payload 少一个字段就 500（GitHub 会重投，重投还是同样的 payload）。
 */
export function anchorFor(input: IdempotencyInput): string {
  if (usesMissingSetAnchor(input.kind)) {
    return input.missingSetHash ?? MISSING_ANCHOR;
  }
  return input.headSha ?? MISSING_ANCHOR;
}

/** 键的组成五项，顺序固定（改顺序等于换一套键，历史任务的唯一约束会全部失效）。 */
export function idempotencyParts(input: IdempotencyInput): readonly string[] {
  return [input.kind, input.repo, input.target, anchorFor(input), input.triggerActor];
}

/** 32 位 hex 键。 */
export function buildIdempotencyKey(input: IdempotencyInput): string {
  return createHash('sha256')
    .update(idempotencyParts(input).join('\n'), 'utf8')
    .digest('hex')
    .slice(0, 32);
}
