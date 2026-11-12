/**
 * 压缩记录存储的断言（AC-25：压缩发生后后台能看到压缩记录）。
 *
 * 不连真库：注入一个假 `SqlRunner`，把「写了哪张表的哪些列、参数顺序对不对、
 * 读出来的行怎么映射」这三件最容易悄悄写错的事钉住。
 * （列名与 `db/schema.ts` 的 `agent_compactions` 一一对应，改列等于改契约。）
 */
import { describe, expect, it } from 'vitest';

import type { SqlRunner } from '../src/config/repo-config.ts';
import type { CompactionRecordInput } from '../src/compact/engine.ts';
import {
  COMPACTION_SQL,
  createCompactionStore,
  insertCompaction,
  latestCompactionGeneration,
  listCompactions,
} from '../src/compact/store.ts';

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

const RECORD: CompactionRecordInput = {
  repo: 'acme/widgets',
  issueNumber: 7,
  sessionId: 'agent-7-abc',
  generation: 2,
  beforeTokens: 120_000,
  afterTokens: 30_000,
  summaryChars: 4_200,
  fallback: false,
};

describe('insertCompaction', () => {
  it('写全 agent_compactions 的九个字段，顺序与 SQL 占位符一致', async () => {
    const db = new FakeSql();
    await insertCompaction(db, RECORD);

    const query = db.queries[0]!;
    expect(query.text).toContain('INSERT INTO agent_compactions');
    for (const column of [
      'repo',
      'issue_number',
      'session_id',
      'generation',
      'before_tokens',
      'after_tokens',
      'summary_chars',
      'fallback',
      'created_at',
    ]) {
      expect(query.text).toContain(column);
    }

    expect(query.values).toEqual([
      'acme/widgets',
      7,
      'agent-7-abc',
      2,
      120_000,
      30_000,
      4_200,
      false,
      expect.any(Date) as unknown as Date,
    ]);
  });

  it('created_at 可注入（测试/回放用固定时钟）', async () => {
    const db = new FakeSql();
    const createdAt = new Date('2026-11-12T08:00:00.000Z');
    await insertCompaction(db, { ...RECORD, createdAt });

    expect(db.queries[0]!.values?.[8]).toBe(createdAt);
  });

  it('兜底压缩也照写（fallback=true 是后台判「这次丢了多少」的依据）', async () => {
    const db = new FakeSql();
    await insertCompaction(db, { ...RECORD, fallback: true });
    expect(db.queries[0]!.values?.[7]).toBe(true);
  });
});

describe('latestCompactionGeneration', () => {
  it('没有记录 → 0（下一代从 1 开始）', async () => {
    const db = new FakeSql();
    db.rows = [{ generation: 0 }];
    await expect(latestCompactionGeneration(db, 'agent-7-abc')).resolves.toBe(0);
    expect(db.queries[0]!.text).toContain('MAX(generation)');
    expect(db.queries[0]!.values).toEqual(['agent-7-abc']);
  });

  it('数字与字符串两种驱动返回都认', async () => {
    const db = new FakeSql();
    db.rows = [{ generation: 3 }];
    await expect(latestCompactionGeneration(db, 's')).resolves.toBe(3);

    db.rows = [{ generation: '4' }];
    await expect(latestCompactionGeneration(db, 's')).resolves.toBe(4);
  });

  it('脏值（null / NaN / 负数）收敛成 0', async () => {
    const db = new FakeSql();
    for (const generation of [null, Number.NaN, -5, 'abc']) {
      db.rows = [{ generation }];
      await expect(latestCompactionGeneration(db, 's')).resolves.toBe(0);
    }
  });
});

describe('listCompactions', () => {
  it('行映射成 camelCase，fallback 强制成布尔', async () => {
    const db = new FakeSql();
    db.rows = [
      {
        repo: 'acme/widgets',
        issue_number: 7,
        session_id: 'agent-7-abc',
        generation: 1,
        before_tokens: 110_000,
        after_tokens: 28_000,
        summary_chars: 3_000,
        fallback: true,
        created_at: new Date('2026-11-12T08:00:00.000Z'),
      },
    ];

    const rows = await listCompactions(db, { repo: 'acme/widgets', issueNumber: 7 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      repo: 'acme/widgets',
      issueNumber: 7,
      sessionId: 'agent-7-abc',
      generation: 1,
      beforeTokens: 110_000,
      afterTokens: 28_000,
      summaryChars: 3_000,
      fallback: true,
      createdAt: new Date('2026-11-12T08:00:00.000Z'),
    });
  });

  it('按时间正序返回（内层取最近 N 条、外层升序）', () => {
    expect(COMPACTION_SQL.listByIssue).toContain('ORDER BY created_at DESC');
    expect(COMPACTION_SQL.listByIssue).toContain('ORDER BY latest.created_at ASC');
  });

  it('limit 缺省 50，并夹在 1..500', async () => {
    const db = new FakeSql();

    await listCompactions(db, { repo: 'a/b', issueNumber: 1 });
    expect(db.queries[0]!.values?.[2]).toBe(50);

    await listCompactions(db, { repo: 'a/b', issueNumber: 1, limit: 0 });
    expect(db.queries[1]!.values?.[2]).toBe(1);

    await listCompactions(db, { repo: 'a/b', issueNumber: 1, limit: 10_000 });
    expect(db.queries[2]!.values?.[2]).toBe(500);
  });
});

describe('createCompactionStore', () => {
  it('record / latestGeneration 直接落到同一套 SQL', async () => {
    const db = new FakeSql();
    const store = createCompactionStore(db);

    await store.record(RECORD);
    db.rows = [{ generation: 2 }];
    await expect(store.latestGeneration('agent-7-abc')).resolves.toBe(2);

    expect(db.queries).toHaveLength(2);
    expect(db.queries[0]!.text).toContain('INSERT INTO agent_compactions');
    expect(db.queries[1]!.text).toContain('MAX(generation)');
  });

  it('可以直接喂给 compactSession 的 deps.store', async () => {
    const db = new FakeSql();
    const store = createCompactionStore(db);
    // 形状兼容性由类型保证，这里断言运行时方法存在且可调用
    expect(typeof store.record).toBe('function');
    expect(typeof store.latestGeneration).toBe('function');
  });
});
