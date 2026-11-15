/**
 * `agent_compactions` 的只读读模型（FR-5.6「可观测」/ AC-25）。
 *
 * 一句话职责：给后台/面板回答「这个 issue 的会话在什么时候、因为多少 token 被压缩过，
 * 第几代、是不是兜底」——也就是让人知道**哪一段历史已经不在模型上下文里了**。
 *
 * 三条约定：
 *  1. **只读**：本文件只有 SELECT；写入在 `compact/store.ts`（`insertCompaction`）。
 *  2. 不 import 业务模块（`queries/` 只允许依赖 `db/` 与 `shared`/`contract`，AGENTS §3）：
 *     所以这里自己写 SQL，不复用 `compact/store.ts` 的语句，也不碰 `agent/`。
 *  3. 时间与排序口径：**按时间正序**返回（面板从左到右画 checkpoint 点）。内层 `DESC + LIMIT`
 *     取「最近 N 条」，外层 `ASC` 让读出来的顺序是时间顺序 —— 只写一层 DESC 会拿到倒序，
 *     只写一层 ASC + LIMIT 会拿到**最老的 N 条**。
 *
 * 迁移状态：本文件不新增列、不改 schema。`generation` / `before_tokens` / `after_tokens` /
 * `summary_chars` / `fallback` 五列就是 FR-5.6 要求的四项观测（前后 token、摘要长度、是否兜底、第几代）。
 * TODO(FR-5.6): 「这一代覆盖到哪条消息」需要一列 `checkpoint_seq`（或 `covered_item_id`），
 *  属 schema 工作包；缺失时面板只能按 `created_at` 标点，标不出精确切点。
 */

import { intOf, isoOf, recordOf } from './sql.ts';
import type { SqlRunner } from './sql.ts';

/** 一行压缩记录（camelCase，字段与 `agent_compactions` 一一对应）。 */
export type CompactionRow = {
  readonly repo: string;
  readonly issueNumber: number;
  readonly sessionId: string;
  readonly generation: number;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly summaryChars: number;
  readonly fallback: boolean;
  readonly createdAt: string;
};

/** 查询入参：一个 issue 的压缩史（`limit` 上限 200，与面板单页粒度一致）。 */
export type CompactionListQuery = {
  readonly repo: string;
  readonly issueNumber: number;
  readonly limit?: number;
};

/** 默认返回条数（一次压缩一行，50 代已经是极端长了）。 */
export const COMPACTIONS_DEFAULT_LIMIT = 50;
/** 硬上限：防止调用方传一个巨大的 limit 把详情页拖死。 */
export const COMPACTIONS_MAX_LIMIT = 200;

/** 一条 SQL 常量：改列名等于改契约，集中一处才好一起改。 */
export const LIST_COMPACTIONS_SQL = [
  'SELECT repo, issue_number, session_id, generation, before_tokens, after_tokens,',
  '       summary_chars, fallback, created_at',
  'FROM (',
  '  SELECT * FROM agent_compactions',
  '  WHERE repo = $1 AND issue_number = $2',
  '  ORDER BY created_at DESC, id DESC',
  '  LIMIT $3',
  ') latest',
  'ORDER BY latest.created_at ASC, latest.id ASC',
].join('\n');

function toRow(raw: unknown): CompactionRow {
  const row = recordOf(raw);
  return {
    repo: typeof row['repo'] === 'string' ? row['repo'] : '',
    issueNumber: intOf(row['issue_number']),
    sessionId: typeof row['session_id'] === 'string' ? row['session_id'] : '',
    generation: intOf(row['generation']),
    beforeTokens: intOf(row['before_tokens']),
    afterTokens: intOf(row['after_tokens']),
    summaryChars: intOf(row['summary_chars']),
    fallback: row['fallback'] === true,
    createdAt: isoOf(row['created_at'], ''),
  };
}

/** 某个 issue 的压缩史（时间正序）。读不到就是空数组，不抛。 */
export async function queryCompactions(
  runner: SqlRunner,
  query: CompactionListQuery,
): Promise<CompactionRow[]> {
  const limit = Math.min(Math.max(1, intOf(query.limit ?? COMPACTIONS_DEFAULT_LIMIT, COMPACTIONS_DEFAULT_LIMIT)), COMPACTIONS_MAX_LIMIT);
  const result = await runner.query(LIST_COMPACTIONS_SQL, [query.repo, query.issueNumber, limit]);
  return result.rows.map((row) => toRow(row));
}
