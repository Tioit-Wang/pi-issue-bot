/**
 * 压缩记录的 PG 实现（`agent_compactions`，FR-5.6「可观测」/ AC-25）。
 *
 * 为什么单独一个模块而不是塞进 `agent/store.ts`：
 *  - `agent/store.ts` 是 `agent_messages` / `agent_sessions` / `tasks` 的读写面（S1 的会话与队列），
 *    压缩记录是**会话级的横切观测**，混进去会让那个文件的职责继续膨胀；
 *  - WS4 的写面就这一张表，独立成文件后 WS6 装配时一眼看到「压缩记录从哪来」。
 *
 * 三条约定：
 *  1. **只追加**：不 UPDATE、不 DELETE。压缩不改写历史，记录也一样；
 *  2. `generation` 在同一会话内单调递增，`latestGeneration` 就是「下一代从几开始」；
 *  3. 走 `SqlRunner`（`query(text, values)`）而不是 drizzle builder：与 `config/repo-config.ts`、
 *     `agent/store.ts` 的既有写法一致，测试注入一个假 SqlRunner 就能断言 SQL 与参数。
 */
import type { SqlRunner } from '../config/repo-config.ts';
import type { CompactStore, CompactionRecordInput } from './engine.ts';

/** `agent_compactions` 的一行（camelCase，便于直接扔给面板/测试断言）。 */
export type CompactionRecordRow = {
  readonly repo: string;
  readonly issueNumber: number;
  readonly sessionId: string;
  readonly generation: number;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly summaryChars: number;
  readonly fallback: boolean;
  readonly createdAt: Date;
};

/** 全部 SQL 集中在这里（改列名等于改契约，集中才好一起改）。 */
export const COMPACTION_SQL = {
  insert: [
    'INSERT INTO agent_compactions',
    '  (repo, issue_number, session_id, generation, before_tokens, after_tokens, summary_chars, fallback, created_at)',
    'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
  ].join('\n'),

  latestGeneration: [
    'SELECT COALESCE(MAX(generation), 0) AS generation',
    'FROM agent_compactions',
    'WHERE session_id = $1',
  ].join('\n'),

  /**
   * 某个 issue 的压缩史（**按时间正序**返回，面板直接画 checkpoint 点）。
   *
   * 内层 `DESC + LIMIT` 保证「取最近 N 条」，外层 `ASC` 保证「读起来是时间顺序」；
   * 只用一层 DESC 会让面板拿到倒序，只用一层 ASC + LIMIT 会拿到**最老的 N 条**（典型 bug）。
   */
  listByIssue: [
    'SELECT repo, issue_number, session_id, generation, before_tokens, after_tokens,',
    '       summary_chars, fallback, created_at',
    'FROM (',
    '  SELECT * FROM agent_compactions',
    '  WHERE repo = $1 AND issue_number = $2',
    '  ORDER BY created_at DESC, id DESC',
    '  LIMIT $3',
    ') latest',
    'ORDER BY latest.created_at ASC, latest.id ASC',
  ].join('\n'),
} as const;

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(typeof value === 'string' ? value : 0);
}

function toRow(raw: unknown): CompactionRecordRow {
  const row = (raw ?? {}) as Record<string, unknown>;
  return {
    repo: typeof row['repo'] === 'string' ? row['repo'] : '',
    issueNumber: toNumber(row['issue_number']),
    sessionId: typeof row['session_id'] === 'string' ? row['session_id'] : '',
    generation: toNumber(row['generation']),
    beforeTokens: toNumber(row['before_tokens']),
    afterTokens: toNumber(row['after_tokens']),
    summaryChars: toNumber(row['summary_chars']),
    fallback: row['fallback'] === true,
    createdAt: toDate(row['created_at']),
  };
}

/**
 * 写一行压缩记录。
 *
 * `createdAt` 缺省走 `now()`：压缩发生在「请求发出前」，用数据库时间比应用进程时间更抗时钟漂移。
 */
export async function insertCompaction(
  db: SqlRunner,
  record: CompactionRecordInput & { readonly createdAt?: Date },
): Promise<void> {
  await db.query(COMPACTION_SQL.insert, [
    record.repo,
    record.issueNumber,
    record.sessionId,
    record.generation,
    record.beforeTokens,
    record.afterTokens,
    record.summaryChars,
    record.fallback,
    record.createdAt ?? new Date(),
  ]);
}

/** 该会话当前的最高代数（0 = 从未压缩过）。 */
export async function latestCompactionGeneration(
  db: SqlRunner,
  sessionId: string,
): Promise<number> {
  const result = await db.query(COMPACTION_SQL.latestGeneration, [sessionId]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return Math.max(0, Math.trunc(toNumber(row?.['generation'])));
}

/** 某个 issue 的压缩记录（时间正序，最多 `limit` 条）。 */
export async function listCompactions(
  db: SqlRunner,
  input: { readonly repo: string; readonly issueNumber: number; readonly limit?: number },
): Promise<CompactionRecordRow[]> {
  const limit = Math.min(Math.max(1, Math.trunc(input.limit ?? 50)), 500);
  const result = await db.query(COMPACTION_SQL.listByIssue, [
    input.repo,
    input.issueNumber,
    limit,
  ]);
  return result.rows.map((row) => toRow(row));
}

/**
 * `engine.ts` 的 `CompactStore` 的 PG 实现 —— 直接喂给 `compactSession({ store, … })`。
 */
export function createCompactionStore(db: SqlRunner): CompactStore {
  return {
    async record(record: CompactionRecordInput): Promise<void> {
      await insertCompaction(db, record);
    },
    async latestGeneration(sessionId: string): Promise<number> {
      return latestCompactionGeneration(db, sessionId);
    },
  };
}
