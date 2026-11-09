/**
 * 数据模型的门禁测试：**不连库**。
 *
 * 两件事必须被钉住，否则后面几个 session 会各自理解一套：
 *  1. §7.2 的 16 张表一张不少，且关键列（`tasks` 的 command / actor_login / queued_at / idempotency_key /
 *     container_name / head_sha）都在。
 *  2. 生成出来的迁移 SQL 里时间列一律 `timestamp with time zone`，`issue_states` 是复合 PK，
 *     `metrics_daily` 有 `(day, repo, outcome)` 唯一索引——这三条是「重跑幂等」与「关闭判定」的前提。
 *
 * 断言为什么一半看 drizzle 对象、一半看 SQL 文本：列的存在看对象最直接；
 * 约束/索引（尤其 partial index、复合 PK）在 drizzle 对象里是内部符号，读生成产物更稳，
 * 而生成产物本来就是真正会跑在目标机上的东西。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { ALL_TABLE_NAMES, issueStates, tasks } from '../src/db/schema.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const MIGRATION_FILE = path.join(REPO_ROOT, 'migrations', '0000_init.sql');

const EXPECTED_TABLES = [
  'webhook_deliveries',
  'repos',
  'tasks',
  'runs',
  'run_events',
  'envelopes',
  'actions',
  'bot_labels',
  'issue_fingerprints',
  'issue_states',
  'usage_costs',
  'degeneracy_hits',
  'metrics_daily',
  'host_credentials',
  'runtime_flags',
  'panel_sessions',
] as const;

async function readMigration(): Promise<string> {
  return readFile(MIGRATION_FILE, 'utf8');
}

describe('db/schema：16 张表', () => {
  it('表名清单与 tech-plan §7.2 完全一致（16 张，无多无少）', () => {
    expect(ALL_TABLE_NAMES.length).toBe(16);
    expect([...ALL_TABLE_NAMES].sort()).toEqual([...EXPECTED_TABLES].sort());
  });

  it('tasks 携带入队时写死的三列 + 幂等键 + 容器名 + head_sha', () => {
    expect(getTableName(tasks)).toBe('tasks');
    const columns = getTableColumns(tasks);
    expect(Object.keys(columns)).toEqual(
      expect.arrayContaining([
        'id',
        'source',
        'repo',
        'targetKind',
        'targetNumber',
        'headSha',
        'command',
        'actorLogin',
        'queuedAt',
        'idempotencyKey',
        'status',
        'containerName',
      ]),
    );
    // 四列必须 NOT NULL：缺一个就说明入队路径漏写了 §5.3 第 6 步的信息
    expect(columns.idempotencyKey.notNull).toBe(true);
    expect(columns.queuedAt.notNull).toBe(true);
    expect(columns.command.notNull).toBe(true);
    expect(columns.actorLogin.notNull).toBe(true);
    // head_sha 与 container_name 允许为空（判定类任务无提交；容器尚未拉起）
    expect(columns.headSha.notNull).toBe(false);
    expect(columns.containerName.notNull).toBe(false);
  });

  it('issue_states 的复合主键是 (repo, issue_number)，缺失项哈希允许为空', () => {
    const columns = getTableColumns(issueStates);
    expect(columns.repo.notNull).toBe(true);
    expect(columns.issueNumber.notNull).toBe(true);
    // NULL = 当前无缺失项（§7.2 的「集合变空」语义），所以这两列必须可空
    expect(columns.missingSetHash.notNull).toBe(false);
    expect(columns.firstSeenAt.notNull).toBe(false);
    expect(columns.lastHumanReplyAt.notNull).toBe(false);
  });
});

describe('migrations/0000_init.sql', () => {
  it('离线生成的 0000_init.sql 覆盖全部 16 张表且带语句分隔符', async () => {
    const sql = await readMigration();
    for (const table of EXPECTED_TABLES) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }
    // 语句分隔符是迁移运行器切分语句的依据（不要按分号切：函数体里有分号）
    expect(sql).toContain('--> statement-breakpoint');
  });

  it('时间列一律 timestamptz：不存在不带时区的 timestamp 列', async () => {
    const sql = await readMigration();
    const bareTimestamps = [...sql.matchAll(/^\t"[a-z_]+" timestamp (?!with time zone)/gm)];
    expect(bareTimestamps).toEqual([]);
    expect(sql).toContain('"queued_at" timestamp with time zone');
    expect(sql).toContain('"received_at" timestamp with time zone');
  });

  it('issue_states 的复合主键落在 DDL 上', async () => {
    const sql = await readMigration();
    expect(sql).toContain('CONSTRAINT "issue_states_repo_issue_number_pk" PRIMARY KEY("repo","issue_number")');
  });

  it('metrics_daily 的 (day, repo, outcome) 唯一索引存在（幂等 UPSERT 的前提）', async () => {
    const sql = await readMigration();
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "metrics_daily_day_repo_outcome_uidx" ON "metrics_daily" USING btree ("day","repo","outcome")',
    );
  });

  it('关键索引都在：tasks(status,queued_at)、runs(task_id)、run_events(run_id,cursor)、actions(target)…', async () => {
    const sql = await readMigration();
    expect(sql).toContain(
      'CREATE INDEX "tasks_status_queued_at_idx" ON "tasks" USING btree ("status","queued_at")',
    );
    expect(sql).toContain('CREATE INDEX "runs_task_id_idx" ON "runs" USING btree ("task_id")');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "run_events_run_id_cursor_uidx" ON "run_events" USING btree ("run_id","cursor")',
    );
    expect(sql).toContain(
      'CREATE INDEX "actions_target_idx" ON "actions" USING btree ("target","applied_at")',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "tasks_idempotency_key_uidx" ON "tasks" USING btree ("idempotency_key")',
    );
    // bot_labels 的「当前持有」唯一索引必须是 partial（removed_at is null），否则重新打标会撞唯一键
    expect(sql).toContain('WHERE removed_at is null');
  });
});
