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
import {
  ALL_TABLE_NAMES,
  agentCompactions,
  botLabels,
  commentSlots,
  issueFeedback,
  issueStates,
  labelDecisions,
  agentSessions,
  quotaCounters,
  repos,
  runtimeFlags,
  tasks,
  webhookDeliveries,
} from '../src/db/schema.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const MIGRATION_FILE = path.join(REPO_ROOT, 'migrations', '0000_init.sql');

/** tech-plan §7.2 的 16 张表（0000_init.sql 建的那批）。 */
const INIT_TABLES = [
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

/** 多仓库改造新增的四张表（`docs/impl-multi-repo.md` §2）。 */
const MULTI_REPO_TABLES = ['issue_feedback', 'label_decisions', 'quota_counters'] as const;

/** v0.3 issue agent 新增的三张表（`migrations/0006_agent.sql`）。 */
const AGENT_TABLES = ['agent_sessions', 'agent_messages', 'agent_denials'] as const;

/** v2.1 新增的两张表（`migrations/0011_v21.sql`）：评论槽位 + 压缩记录。 */
const V21_TABLES = ['comment_slots', 'agent_compactions'] as const;

const EXPECTED_TABLES = [...INIT_TABLES, ...MULTI_REPO_TABLES, ...AGENT_TABLES, ...V21_TABLES] as const;

/** `0003_multi_repo.sql`：纯新增的列与表（`ALTER TABLE ADD COLUMN` / `CREATE TABLE`）。 */
const MIGRATION_0003 = path.join(REPO_ROOT, 'migrations', '0003_multi_repo.sql');

/** `0011_v21.sql`：v2.1 的判定留痕 / 会话状态 / 槽位 / 压缩记录（同样只加列与建表）。 */
const MIGRATION_0011 = path.join(REPO_ROOT, 'migrations', '0011_v21.sql');

async function readMigration(): Promise<string> {
  return readFile(MIGRATION_FILE, 'utf8');
}

describe('db/schema：24 张表', () => {
  it('表名清单 = tech-plan §7.2 的 16 张 + 多仓库 3 张 + issue agent 3 张 + v2.1 2 张（无多无少）', () => {
    expect(ALL_TABLE_NAMES.length).toBe(24);
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
  it('离线生成的 0000_init.sql 覆盖全部 16 张表且带语句分隔符（新增表在 0003，不回填 0000）', async () => {
    const sql = await readMigration();
    for (const table of INIT_TABLES) {
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

describe('多仓库改造的增量列（db/schema ↔ 0003_multi_repo.sql）', () => {
  it('repos：settings 一族 + source / installation_id / archived_at 都在，旧 config 三列保留', () => {
    const columns = getTableColumns(repos);
    expect(Object.keys(columns)).toEqual(
      expect.arrayContaining([
        'repoFullName',
        'enabled',
        'dryRun',
        'settings',
        'settingsValid',
        'settingsError',
        'settingsUpdatedAt',
        'source',
        'installationId',
        'archivedAt',
        // 过渡期列（W1 之后不再读，W3 可删）
        'config',
        'configValid',
        'configError',
      ]),
    );
    expect(columns.settings.notNull).toBe(true);
    expect(columns.settingsValid.notNull).toBe(true);
    expect(columns.source.notNull).toBe(true);
    // 归档时刻与 installation id 可空（手动添加的仓库没有 installation）
    expect(columns.archivedAt.notNull).toBe(false);
    expect(columns.installationId.notNull).toBe(false);
  });

  it('webhook_deliveries.repo / bot_labels 的四个新列 / runtime_flags.repo 都在', () => {
    expect(getTableColumns(webhookDeliveries).repo.notNull).toBe(false);

    const labelColumns = getTableColumns(botLabels);
    expect(Object.keys(labelColumns)).toEqual(
      expect.arrayContaining(['sourceKey', 'judgementHash', 'reason', 'runId']),
    );

    const flagColumns = getTableColumns(runtimeFlags);
    // NULL = 全局 flag，所以 repo 必须可空
    expect(flagColumns.repo.notNull).toBe(false);
  });

  it('四张新表的列与唯一键（幂等的前提）', () => {
    expect(Object.keys(getTableColumns(issueFeedback))).toEqual(
      expect.arrayContaining([
        'id',
        'repo',
        'targetKind',
        'targetNumber',
        'commentId',
        'stage',
        'content',
        'anchor',
        'reactionId',
        'appliedAt',
        'audit',
        'createdAt',
      ]),
    );
    expect(Object.keys(getTableColumns(labelDecisions))).toEqual(
      expect.arrayContaining([
        'repo',
        'targetNumber',
        'judgementHash',
        'desired',
        'applied',
        'blockedReason',
        'reason',
        'runId',
      ]),
    );
    expect(Object.keys(getTableColumns(quotaCounters))).toEqual(
      expect.arrayContaining(['repo', 'kind', 'windowStart', 'count']),
    );
    expect(Object.keys(getTableColumns(agentSessions))).toEqual(
      expect.arrayContaining(['repo', 'issueNumber', 'sessionId', 'cursor', 'turns', 'startedAt', 'updatedAt']),
    );
  });

  it('0003_multi_repo.sql 包含全部新增列与表，并用 statement-breakpoint 切句', async () => {
    const sql = await readFile(MIGRATION_0003, 'utf8');
    for (const column of [
      'settings',
      'settings_valid',
      'settings_error',
      'settings_updated_at',
      'source',
      'installation_id',
      'archived_at',
    ]) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS "${column}"`);
    }
    for (const table of ['issue_feedback', 'label_decisions', 'quota_counters', 'prompt_versions']) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "${table}"`);
    }
    // runtime_flags 的 repo 列 + 两条 partial 唯一索引（NULL = 全局）
    expect(sql).toContain('ALTER TABLE "runtime_flags" ADD COLUMN IF NOT EXISTS "repo" text');
    expect(sql).toContain('"runtime_flags_global_uidx"');
    expect(sql).toContain('"runtime_flags_repo_uidx"');
    expect(sql).toContain('WHERE "repo" IS NULL');
    // bot_labels 的四个新列
    for (const column of ['source_key', 'judgement_hash', 'reason', 'run_id']) {
      expect(sql).toContain(`ALTER TABLE "bot_labels" ADD COLUMN IF NOT EXISTS "${column}"`);
    }
    expect(sql).toContain('--> statement-breakpoint');
  });

  it('0003 不重写历史：文件里没有 DROP TABLE，也没有改 0000 的列', async () => {
    const sql = await readFile(MIGRATION_0003, 'utf8');
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);
    // 唯一允许的 DROP 是 runtime_flags 的旧主键（改由 handle 两条 partial 唯一索引承担）
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "runtime_flags_pkey"');
  });
});

describe('v2.1 的增量列与两张新表（db/schema ↔ 0011_v21.sql）', () => {
  it('webhook_deliveries 带上判定留痕两列，且都允许为空（历史投递没有结论）', () => {
    const columns = getTableColumns(webhookDeliveries);
    expect(Object.keys(columns)).toEqual(expect.arrayContaining(['decision', 'decisionReason']));
    // 「还没判定」与「判定为忽略」必须能区分，所以不能 NOT NULL + 默认值
    expect(columns.decision.notNull).toBe(false);
    expect(columns.decisionReason.notNull).toBe(false);
  });

  it('agent_sessions 带上 state / sandbox_id / closed_at（只有 active/idle，没有 ended）', () => {
    const columns = getTableColumns(agentSessions);
    expect(Object.keys(columns)).toEqual(
      expect.arrayContaining(['state', 'sandboxId', 'closedAt']),
    );
    // 状态必须有值：NULL 会让「沙箱在不在」变成三态
    expect(columns.state.notNull).toBe(true);
    expect(columns.state.default).toBe('idle');
    // 空闲态没有沙箱，所以 sandbox_id 可空
    expect(columns.sandboxId.notNull).toBe(false);
    expect(columns.closedAt.notNull).toBe(false);
    expect(columns.closedAt.columnType).toBe('PgTimestamp');
  });

  it('comment_slots：槽位键就是主键，(repo, issue_number) 有索引', () => {
    expect(getTableName(commentSlots)).toBe('comment_slots');
    expect(Object.keys(getTableColumns(commentSlots))).toEqual(
      expect.arrayContaining(['repo', 'issueNumber', 'slot', 'commentId', 'bodyHash', 'updatedAt']),
    );
    expect(getTableColumns(commentSlots).issueNumber.notNull).toBe(true);
    expect(getTableColumns(commentSlots).slot.notNull).toBe(true);
  });

  it('agent_compactions：一次压缩一行，token 与降级标记都在', () => {
    expect(getTableName(agentCompactions)).toBe('agent_compactions');
    const columns = getTableColumns(agentCompactions);
    expect(Object.keys(columns)).toEqual(
      expect.arrayContaining([
        'id',
        'repo',
        'issueNumber',
        'sessionId',
        'generation',
        'beforeTokens',
        'afterTokens',
        'summaryChars',
        'fallback',
        'createdAt',
      ]),
    );
    expect(columns.fallback.notNull).toBe(true);
    expect(columns.beforeTokens.notNull).toBe(true);
  });

  it('0011_v21.sql 只加列与建表，且每条语句都能重复执行（IF NOT EXISTS）', async () => {
    const sql = await readFile(MIGRATION_0011, 'utf8');
    // 判定留痕
    expect(sql).toContain('ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "decision" text');
    expect(sql).toContain('ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "decision_reason" text');
    // 会话状态
    expect(sql).toContain('ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "state" text NOT NULL DEFAULT \'idle\'');
    expect(sql).toContain('ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "sandbox_id" text');
    expect(sql).toContain('ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "closed_at" timestamp with time zone');
    // 两张新表 + 索引
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "comment_slots"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "agent_compactions"');
    expect(sql).toContain('"comment_slots_repo_issue_number_slot_pk"');
    expect(sql).toContain('"comment_slots_repo_issue_idx"');
    expect(sql).toContain('"agent_compactions_repo_issue_created_idx"');
    // 不重写历史
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/ALTER COLUMN/i);
    // 语句分隔符是迁移运行器切句的依据（不要按分号切：函数体里有分号）
    expect(sql).toContain('--> statement-breakpoint');
  });
});
