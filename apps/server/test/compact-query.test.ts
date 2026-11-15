/**
 * 压缩记录的**只读**读模型（FR-5.6「可观测」/ AC-25 的后台可查那一半）。
 *
 * 不连真库：注入假 `SqlRunner`，钉住三件最容易写错的事 ——
 *  1. 只发 SELECT（`queries/` 只读，AGENTS §3）；
 *  2. `LIMIT` 被夹到 [1, 200]，且取的是**最近** N 条而不是最老的 N 条（DESC 在内层、ASC 在外层）；
 *  3. 行映射：`fallback` 严格等于 `true`（不是「非空字符串就算 true」）。
 */
import { describe, expect, it } from 'vitest';

import {
  COMPACTIONS_DEFAULT_LIMIT,
  COMPACTIONS_MAX_LIMIT,
  LIST_COMPACTIONS_SQL,
  queryCompactions,
} from '../src/queries/compactions.ts';
import type { SqlRunner } from '../src/queries/sql.ts';

type CapturedQuery = { readonly text: string; readonly values: readonly unknown[] | undefined };

class FakeSql implements SqlRunner {
  readonly queries: CapturedQuery[] = [];
  rows: unknown[] = [];

  async query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: unknown[]; readonly rowCount?: number | null }> {
    this.queries.push({ text, values });
    return { rows: this.rows, rowCount: this.rows.length };
  }
}

const ROW = {
  repo: 'acme/widgets',
  issue_number: 7,
  session_id: 'agent-7-abc',
  generation: 3,
  before_tokens: '120000',
  after_tokens: 4200,
  summary_chars: 880,
  fallback: true,
  created_at: new Date('2026-11-14T08:00:00.000Z'),
};

describe('queryCompactions · 只读读模型', () => {
  it('只发一条 SELECT，参数是 (repo, issueNumber, limit)，limit 默认 50', async () => {
    const db = new FakeSql();
    db.rows = [ROW];

    const rows = await queryCompactions(db, { repo: 'acme/widgets', issueNumber: 7 });

    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]?.text.trimStart().startsWith('SELECT')).toBe(true);
    expect(db.queries[0]?.text).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/iu);
    expect(db.queries[0]?.values).toEqual(['acme/widgets', 7, COMPACTIONS_DEFAULT_LIMIT]);

    // 行映射：数字列容错、fallback 严格 true、时间转 ISO
    expect(rows).toEqual([
      {
        repo: 'acme/widgets',
        issueNumber: 7,
        sessionId: 'agent-7-abc',
        generation: 3,
        beforeTokens: 120_000,
        afterTokens: 4_200,
        summaryChars: 880,
        fallback: true,
        createdAt: '2026-11-14T08:00:00.000Z',
      },
    ]);
  });

  it('limit 被夹进 [1, 200]：巨大值不放大、0 与负数变 1', async () => {
    const db = new FakeSql();
    await queryCompactions(db, { repo: 'o/r', issueNumber: 1, limit: 100_000 });
    await queryCompactions(db, { repo: 'o/r', issueNumber: 1, limit: 0 });

    expect(db.queries[0]?.values?.[2]).toBe(COMPACTIONS_MAX_LIMIT);
    expect(db.queries[1]?.values?.[2]).toBe(1);
  });

  it('取最近 N 条而不是最老 N 条：DESC 在内层、ASC 在外层', async () => {
    // 顺序写错的典型症状：面板拿到最老的一批压缩记录，而最近的（最该看的）永远不出现
    expect(LIST_COMPACTIONS_SQL.indexOf('ORDER BY created_at DESC')).toBeGreaterThan(0);
    expect(LIST_COMPACTIONS_SQL.indexOf('ORDER BY created_at DESC')).toBeLessThan(
      LIST_COMPACTIONS_SQL.indexOf('LIMIT $3'),
    );
    expect(LIST_COMPACTIONS_SQL.trimEnd().endsWith('ORDER BY latest.created_at ASC, latest.id ASC')).toBe(true);
  });

  it('读不到就是空数组（不抛），fallback 只认严格 true', async () => {
    const db = new FakeSql();
    db.rows = [{ ...ROW, fallback: 'true' }, { ...ROW, fallback: false }];
    const rows = await queryCompactions(db, { repo: 'o/r', issueNumber: 1 });
    expect(rows.map((row) => row.fallback)).toEqual([false, false]);

    db.rows = [];
    await expect(queryCompactions(db, { repo: 'o/r', issueNumber: 1 })).resolves.toEqual([]);
  });
});
