/**
 * 迁移运行器的单测：**不连库**（dev-plan §13.4 第 5 条）。
 *
 * 真跑 `BEGIN/COMMIT` 与 DDL 需要目标机的 PostgreSQL，本机没有；
 * 所以这里覆盖的是运行器的全部可判定逻辑：命名解析、切句、计划、账本比对、中止条件，
 * 以及「用假执行面跑完整流程」。真实事务与 DDL 的执行留给目标机（见汇报里的验收命令）。
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LEDGER_DDL,
  MIGRATION_LEDGER_TABLE,
  checksumOf,
  parseMigrationFileName,
  planMigrations,
  readMigrationsFromDir,
  runMigrations,
  splitSqlStatements,
  toMigrationFile,
} from '../src/db/migrate.ts';
import type { AppliedMigration, MigrationExecutor, MigrationFile } from '../src/db/migrate.ts';

function file(name: string, sql: string): MigrationFile {
  const created = toMigrationFile(name, sql);
  if (created === null) {
    throw new Error(`测试夹具文件名不合规：${name}`);
  }
  return created;
}

/** 假执行面：记录执行顺序与账本，不连库（计数器随实例走，`Object.assign` 复制数值会测不到自增）。 */
class FakeMigrationExecutor implements MigrationExecutor {
  readonly applied: string[] = [];
  readonly ledger: AppliedMigration[];
  ensureLedgerCalls = 0;

  constructor(initial: AppliedMigration[] = []) {
    this.ledger = [...initial];
  }

  ensureLedger = async (): Promise<void> => {
    this.ensureLedgerCalls += 1;
  };

  listApplied = async (): Promise<readonly AppliedMigration[]> => [...this.ledger];

  apply = async (target: MigrationFile): Promise<void> => {
    this.applied.push(target.id);
    this.ledger.push({
      id: target.id,
      name: target.tag,
      checksum: target.checksum,
      appliedAt: new Date().toISOString(),
    });
  };
}

function fakeExecutor(initial: AppliedMigration[] = []): FakeMigrationExecutor {
  return new FakeMigrationExecutor(initial);
}

describe('parseMigrationFileName / toMigrationFile', () => {
  it('按 NNNN_snake_case_summary.sql 解析序号与摘要', () => {
    expect(parseMigrationFileName('0000_init.sql')).toEqual({ seq: 0, tag: 'init' });
    expect(parseMigrationFileName('0102_add_envelopes.sql')).toEqual({ seq: 102, tag: 'add_envelopes' });
  });

  it('拒绝不合规命名（.gitkeep / 三位数 / 大写 / 缺摘要）', () => {
    expect(parseMigrationFileName('.gitkeep')).toBeNull();
    expect(parseMigrationFileName('000_init.sql')).toBeNull();
    expect(parseMigrationFileName('0000_Init.sql')).toBeNull();
    expect(parseMigrationFileName('0000.sql')).toBeNull();
    expect(parseMigrationFileName('0000_init.SQL')).toBeNull();
  });

  it('checksum 对 CRLF/LF 归一，Windows 检出不会误报「历史文件被改」', () => {
    expect(checksumOf('select 1;\nselect 2;')).toBe(checksumOf('select 1;\r\nselect 2;'));
    expect(checksumOf('select 1;')).not.toBe(checksumOf('select 2;'));
  });
});

describe('splitSqlStatements', () => {
  it('按 drizzle 的 statement-breakpoint 切分，而不是按分号', () => {
    const sql = [
      'CREATE TABLE "a" ("id" text);',
      '--> statement-breakpoint',
      'CREATE INDEX "a_idx" ON "a" ("id");',
    ].join('\n');
    expect(splitSqlStatements(sql)).toEqual([
      'CREATE TABLE "a" ("id" text);',
      'CREATE INDEX "a_idx" ON "a" ("id");',
    ]);
  });

  it('函数体里的分号不会被撕开', () => {
    const sql = 'CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;';
    expect(splitSqlStatements(sql)).toEqual([sql]);
  });

  it('丢弃空块与只剩注释的块', () => {
    const sql = '-- 只是注释\n--> statement-breakpoint\n\n--> statement-breakpoint\nSELECT 1;';
    expect(splitSqlStatements(sql)).toEqual(['SELECT 1;']);
  });
});

describe('planMigrations', () => {
  it('账本为空 → 全部待执行，按 seq 升序', () => {
    const files = [file('0002_c.sql', 'select 3;'), file('0000_a.sql', 'select 1;'), file('0001_b.sql', 'select 2;')];
    const plan = planMigrations(files, []);
    expect(plan.pending.map((item) => item.id)).toEqual(['0000_a', '0001_b', '0002_c']);
    expect(plan.alreadyApplied).toEqual([]);
    expect(plan.checksumMismatches).toEqual([]);
    expect(plan.duplicateSeq).toEqual([]);
  });

  it('已应用的按 id 跳过；内容变过则进 checksumMismatches', () => {
    const original = file('0000_a.sql', 'select 1;');
    const changed = file('0000_a.sql', 'select 1, 2;');
    const applied: AppliedMigration[] = [
      { id: original.id, name: original.tag, checksum: original.checksum, appliedAt: '2026-01-01T00:00:00Z' },
    ];

    const planSame = planMigrations([original], applied);
    expect(planSame.pending).toEqual([]);
    expect(planSame.alreadyApplied.map((item) => item.id)).toEqual(['0000_a']);

    const planChanged = planMigrations([changed], applied);
    expect(planChanged.checksumMismatches).toEqual([
      { id: '0000_a', expected: original.checksum, actual: changed.checksum },
    ]);
  });

  it('两个文件抢同一序号 → duplicateSeq（并行开发撞号）', () => {
    const files = [file('0010_a.sql', 'select 1;'), file('0010_b.sql', 'select 2;')];
    expect(planMigrations(files, []).duplicateSeq).toEqual([10]);
  });
});

describe('runMigrations（假执行面）', () => {
  it('按序执行待跑迁移、写账本，并把已应用的报成 skipped', async () => {
    const first = file('0000_a.sql', 'CREATE TABLE "a" ("id" text);');
    const second = file('0001_b.sql', 'CREATE TABLE "b" ("id" text);');
    const executor = fakeExecutor([
      { id: first.id, name: first.tag, checksum: first.checksum, appliedAt: '2026-01-01T00:00:00Z' },
    ]);

    const result = await runMigrations(executor, [first, second]);

    expect(executor.ensureLedgerCalls).toBe(1);
    expect(executor.applied).toEqual(['0001_b']);
    expect(result.applied).toEqual(['0001_b']);
    expect(result.skipped).toEqual(['0000_a']);
    expect(executor.ledger).toHaveLength(2);
  });

  it('历史迁移内容变过 → 抛错且一条都不执行', async () => {
    const changed = file('0000_a.sql', 'select 2;');
    const executor = fakeExecutor([
      { id: '0000_a', name: 'a', checksum: 'deadbeef', appliedAt: '2026-01-01T00:00:00Z' },
    ]);

    await expect(runMigrations(executor, [changed])).rejects.toThrow(/内容变了/);
    expect(executor.applied).toEqual([]);
  });

  it('序号撞车 → 抛错（谁先谁后不能靠运气）', async () => {
    const executor = fakeExecutor();
    const files = [file('0010_a.sql', 'select 1;'), file('0010_b.sql', 'select 2;')];
    await expect(runMigrations(executor, files)).rejects.toThrow(/序号重复/);
    expect(executor.applied).toEqual([]);
  });

  it('账本 DDL 用 IF NOT EXISTS，可在空库与已有库上重复执行', () => {
    expect(LEDGER_DDL).toContain('CREATE TABLE IF NOT EXISTS');
    expect(LEDGER_DDL).toContain(MIGRATION_LEDGER_TABLE);
  });
});

describe('readMigrationsFromDir', () => {
  it('读仓库里的 migrations/：包含 0000_init 且忽略 .gitkeep 与 meta/', async () => {
    const files = await readMigrationsFromDir(fileURLToPath(new URL('../../../migrations', import.meta.url)));
    const ids = files.map((item) => item.id);
    expect(ids).toContain('0000_init');
    expect(ids.every((id) => /^\d{4}_[a-z0-9_]+$/.test(id))).toBe(true);
    // 序号唯一（撞号由 planMigrations 兜，这里先看一眼现状）
    expect(new Set(files.map((item) => item.seq)).size).toBe(files.length);
  });
});
