/**
 * `tasks.idempotency_key` 的生成（tech-plan §7.2 的 F9，webhook 第 6 步用）。
 *
 * 公式：`sha256([kind, repo, target, anchor, trigger_actor].join("\n"))` 取 hex 前 32 位。
 * 落到 `tasks.idempotency_key` 的 unique 索引上——**幂等落在数据库，不靠内存去重**（§5.3）。
 *
 * `anchor` 只有两档（`docs/impl-multi-repo.md` §4 W2-E 第 6 条收敛之后）：
 *  - **有 `head_sha` 就用它**：同一提交重跑是空操作（plan §6.4），换新提交才该产生新任务；
 *  - **没有 `head_sha`（issue 判定类）就用 issue 版本 hash**：issue 没有提交可锚，
 *    而「正文变了」正是「该重新判定」的判据。
 *
 * 为什么删掉旧的 `usesMissingSetAnchor()` / `compliance` kind 分支：那套口径按 kind 名字
 * 决定锚，而 `compliance` 这个 kind 整体退役了（§0.3：合规缺失项由提示词控制）；
 * 而且「缺失项集合」当锚是错的 —— 编辑正文但缺失项没变时它会给出同一个键，
 * 于是「用户补了信息」的那一轮被唯一索引吃掉。现在锚只由**数据**决定，不由 kind 决定。
 *
 * `trigger_actor` 进键是**有意的**：人工 `/retry` 与 webhook 重投必须能区分，
 * 否则「重跑」会被唯一键吃掉，人点了 /retry 什么也不会发生。
 *
 * `kind` 取 `triage` / `command:/review-pr` / `create_issue` 这类短串。
 */
import { createHash } from 'node:crypto';

/** 键里字段的占位值：字段缺失时用它，保证键仍是确定性的（不抛错、不产出随机串）。 */
export const MISSING_ANCHOR = 'none';

export type IdempotencyInput = {
  /** `triage` / `command:/review-pr` / `create_issue` …… */
  readonly kind: string;
  /** `owner/name` */
  readonly repo: string;
  /** 目标串，建议 `issue#123` / `pr#456`，与 `runs`/`actions` 的 target 口径一致 */
  readonly target: string;
  /** PR / 命令类的锚：提交 sha */
  readonly headSha?: string | null;
  /**
   * issue 判定类的锚：**issue 版本 hash**（webhook 的 `issueVersionHash`）。
   *
   * 字段名保留 `missingSetHash` 只是为了不改 `http/webhook.ts` 的调用形状；
   * 语义已是「issue 版本 hash」，`missing_set_hash` 那套锚法已退役。
   */
  readonly missingSetHash?: string | null;
  /** 触发者 GitHub login */
  readonly triggerActor: string;
};

/**
 * 取锚：有提交就用提交，否则用 issue 版本 hash，两者都没有给 `MISSING_ANCHOR`。
 *
 * 缺失时返回占位值而不是抛错：入队路径不能因为 payload 少一个字段就 500
 * （GitHub 会重投，重投还是同样的 payload）。
 */
export function anchorFor(input: IdempotencyInput): string {
  if (input.headSha !== undefined && input.headSha !== null && input.headSha !== '') {
    return input.headSha;
  }
  if (input.missingSetHash !== undefined && input.missingSetHash !== null && input.missingSetHash !== '') {
    return input.missingSetHash;
  }
  return MISSING_ANCHOR;
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
