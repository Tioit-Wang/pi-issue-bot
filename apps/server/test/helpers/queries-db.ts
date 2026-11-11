/**
 * 真库测试夹具：`pi_issue_bot_test` 上的建表、清库、种子数据与查询实例。
 *
 * 三条约定（看一眼能省掉「为什么这个测试有时红」的排错）：
 *  1. **连的是真 PostgreSQL**（dev-plan §13.1：本机有 PG 18，数据库相关验收必须真跑）。
 *     DSN 用 `PI_BOT_TEST_DSN` 覆盖，默认 `postgres://postgres:postgres@127.0.0.1:5432/pi_issue_bot_test`；
 *     **只碰测试库**，不碰 `pi_issue_bot` / `postgres`。
 *  2. **文件之间串行**：vitest 默认多文件并行，而所有查询测试共用一个库。
 *     所以每个文件开头取一把 advisory lock（专用连接持有整场），结束时释放——
 *     代价是慢一点，换来的是「不会互相 truncate」。
 *  3. **种子数据固定在一个时刻**（`FIXED_NOW`）：`where` 之后的数字全部可手算，
 *     断言的是**数字**而不是形状（任务书要求）。
 */
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Pool } from 'pg';
import { createPool, migrate } from '../../src/db/index.ts';
import { createQueries } from '../../src/queries/index.ts';
import type { Queries } from '../../src/queries/index.ts';

/** 测试时钟：所有种子数据都相对这个时刻摆位（UTC）。 */
export const FIXED_NOW = new Date('2026-06-01T12:00:00.000Z');

const DEFAULT_DSN = 'postgres://postgres:postgres@127.0.0.1:5432/pi_issue_bot_test';

/** 迁移目录（仓库根 `migrations/`）：测试自己建表，不依赖外部先跑过 CLI。 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../migrations/', import.meta.url));

/** advisory lock 的键：同一个测试库上，本文件的所有测试独占。 */
const LOCK_KEY = 73_210_001;

export type TestDb = {
  readonly pool: Pool;
  readonly queries: Queries;
  /** 直接跑一条 SQL（断言「与手写 SQL 相等」时用）。 */
  readonly sql: (text: string, values?: unknown[]) => Promise<Array<Record<string, unknown>>>;
  /** 清空所有业务表与 pgboss 的 job（保持「空库」可测）。 */
  readonly truncate: () => Promise<void>;
  readonly close: () => Promise<void>;
};

export function testDsn(): string {
  return process.env['PI_BOT_TEST_DSN'] ?? DEFAULT_DSN;
}

export async function openTestDb(now: Date = FIXED_NOW): Promise<TestDb> {
  // 1. 先拿锁（专用连接，不参与查询池）
  const locker = new pg.Client({ connectionString: testDsn() });
  await locker.connect();
  await locker.query('select pg_advisory_lock($1)', [LOCK_KEY]);

  // 2. 建池 + 跑迁移（幂等：已建表就 skip）
  const pool = createPool({
    connectionString: testDsn(),
    applicationName: 'pi-issue-bot-queries-test',
    max: 4,
  });
  await migrate(pool, MIGRATIONS_DIR);

  const sql = async (text: string, values: unknown[] = []): Promise<Array<Record<string, unknown>>> => {
    const result = await pool.query(text, values);
    return result.rows as Array<Record<string, unknown>>;
  };

  const truncate = async (): Promise<void> => {
    // `agent_sessions` / `agent_denials` 没有外键指向 `repos`，`truncate repos ... cascade` 带不走它们。
    // 漏掉 `agent_sessions`，下一个测试文件就会看到上一个文件留下的会话行：
    // 同一 issue 的 `issues.opened` 会被判成「续跑」而非新会话（表现为 e2e 用例假红，且只在整库跑时出现）。
    await pool.query(
      `truncate table
       tasks, runs, run_events, envelopes, actions, bot_labels, issue_fingerprints, issue_states,
       agent_sessions, agent_messages, agent_denials,
       usage_costs, degeneracy_hits, metrics_daily, repos, webhook_deliveries, runtime_flags,
       panel_sessions, host_credentials, issue_feedback, label_decisions, quota_counters
      cascade`,
    );
    // pg-boss 的表由库自己建：job 表清空（队列配置本身保留，system 要读它）
    const hasJobs = await pool.query("select to_regclass('pgboss.job') is not null as present");
    if ((hasJobs.rows[0] as { present: boolean }).present) {
      await pool.query('delete from pgboss.job');
    }
  };

  const close = async (): Promise<void> => {
    await pool.end();
    await locker.query('select pg_advisory_unlock($1)', [LOCK_KEY]);
    await locker.end();
  };

  return {
    pool,
    queries: createQueries({ pool, now: () => now }),
    sql,
    truncate,
    close,
  };
}

/* ── 种子数据 ─────────────────────────────────────────────────────────────── */

/**
 * 标准种子：5 个任务、5 次 run、6 条 action（+1 条契约外 intent）、4 条事件、2 封 envelope、
 * 5 条 usage、4 条投递、2 个 flag、2 个仓库、1 天 metrics、3 个 pgboss job。
 *
 * 数字与 `queries-*.test.ts` 里的断言一一对应；改这里必须同时改断言。
 */
export async function seedStandard(db: TestDb): Promise<void> {
  const { pool } = db;

  await pool.query(`
    insert into repos (repo_full_name, enabled, dry_run, settings, settings_valid, settings_error, source)
    values
      ('acme/widgets', true, false, '{"version":1}'::jsonb, true, null, 'manual'),
      ('other/lib', true, true, '{"version":1}'::jsonb, false, 'outputs 越界：pr 但没有 paths', 'installation')
  `);

  await pool.query(`
    insert into webhook_deliveries (delivery_id, event, action, payload, signature_valid, received_at)
    values
      ('d1', 'issues', 'opened', '{}'::jsonb, true, '2026-06-01T00:10:00Z'),
      ('d2', 'issues', 'labeled', '{}'::jsonb, true, '2026-06-01T02:10:00Z'),
      ('d3', 'pull_request', 'opened', '{}'::jsonb, true, '2026-06-01T03:10:00Z'),
      ('d4', 'issues', 'opened', '{}'::jsonb, true, '2026-05-31T13:00:00Z')
  `);

  await pool.query(`
    insert into tasks
      (id, source, repo, target_kind, target_number, head_sha, command, actor_login, queued_at,
       idempotency_key, status, container_name, attempt, delivery_id, created_at, updated_at, ended_at)
    values
      ('t-succ-1',  'command', 'acme/widgets', 'pr',    12, 'abcdef1234567', '/review-pr',      'alice',  '2026-06-01T01:00:00Z', 'k1', 'succeeded', 'pi-job-t-succ-1',  1, 'd1', '2026-06-01T01:00:00Z', '2026-06-01T01:10:00Z', '2026-06-01T01:10:00Z'),
      ('t-fail-1',  'webhook', 'acme/widgets', 'issue',  7, null,            'auto:triage',     'bob',    '2026-06-01T02:00:00Z', 'k2', 'timed-out', 'pi-job-t-fail-1',  1, 'd2', '2026-06-01T02:00:00Z', '2026-06-01T02:20:00Z', '2026-06-01T02:20:00Z'),
      ('t-fail-2',  'webhook', 'other/lib',    'pr',     3, 'deadbeef1234',  '/review-pr',      'carol',  '2026-06-01T03:00:00Z', 'k3', 'failed',    'pi-job-t-fail-2',  2, 'd3', '2026-06-01T03:00:00Z', '2026-06-01T03:05:00Z', '2026-06-01T03:05:00Z'),
      ('t-queue-1', 'cron',    'other/lib',    'issue',  9, null,            'auto:compliance', 'ci-bot', '2026-06-01T11:00:00Z', 'k4', 'queued',    null,               0, null, '2026-06-01T11:00:00Z', '2026-06-01T11:00:00Z', null),
      ('t-old-1',   'webhook', 'acme/widgets', 'pr',    21, '0f0f0f0f0f0f',  '/review-pr',      'dave',   '2026-05-31T13:00:00Z', 'k5', 'succeeded', 'pi-job-t-old-1',   1, 'd4', '2026-05-31T13:00:00Z', '2026-05-31T13:30:00Z', '2026-05-31T13:30:00Z')
  `);

  await pool.query(`
    insert into runs (id, task_id, attempt, session_id, turn_id, started_at, ended_at, outcome, failure_class, failure_detail, created_at)
    values
      ('r1', 't-succ-1',  1, 'sess-1', 'turn-1', '2026-06-01T01:00:00Z', '2026-06-01T01:10:00Z', 'success',   null,         null,                                     '2026-06-01T01:00:00Z'),
      ('r2', 't-fail-1',  1, 'sess-2', 'turn-2', '2026-06-01T02:00:00Z', '2026-06-01T02:20:00Z', 'timed-out', 'timeout',    '{"exitCode":137}'::jsonb,                '2026-06-01T02:00:00Z'),
      ('r3', 't-fail-2',  1, 'sess-3', 'turn-3', '2026-06-01T03:00:00Z', '2026-06-01T03:02:00Z', 'failed',    'rate_limit', '{"httpStatus":429}'::jsonb,              '2026-06-01T03:00:00Z'),
      ('r4', 't-fail-2',  2, 'sess-4', 'turn-4', '2026-06-01T03:03:00Z', '2026-06-01T03:05:00Z', 'failed',    'sandbox_crash', null,                                  '2026-06-01T03:03:00Z'),
      ('r5', 't-old-1',   1, 'sess-5', 'turn-5', '2026-05-31T13:00:00Z', '2026-05-31T13:30:00Z', 'success',   null,         null,                                     '2026-05-31T13:00:00Z')
  `);

  await pool.query(`
    insert into usage_costs (run_id, model, input_tokens, output_tokens, cost_usd, created_at)
    values
      ('r1', 'anthropic/claude-x', 1000, 500,  0.050000, '2026-06-01T01:10:00Z'),
      ('r2', 'anthropic/claude-x', 2000, 1000, 0.100000, '2026-06-01T02:20:00Z'),
      ('r3', 'openai/gpt-y',        500, 100,  0.020000, '2026-06-01T03:02:00Z'),
      ('r4', 'openai/gpt-y',        300,  50,  0.010000, '2026-06-01T03:05:00Z'),
      ('r5', 'anthropic/claude-x',  800, 200,  0.040000, '2026-05-31T13:30:00Z')
  `);

  await pool.query(`
    insert into run_events (run_id, cursor, kind, payload, created_at)
    values
      ('r1', 1, 'session', '{"phase":"create"}'::jsonb, '2026-06-01T01:00:01Z'),
      ('r1', 2, 'approval', '{"tool":"Bash","decision":"deny","rule":"deny-network"}'::jsonb, '2026-06-01T01:05:00Z'),
      ('r1', 3, 'notice', '{"diff":{"text":"diff --git a/src/a.ts b/src/a.ts\\n--- a\\n+++ b\\n","truncated":false,"baseSha":"abcdef1234567","headSha":"abcdef1234567"}}'::jsonb, '2026-06-01T01:06:00Z'),
      ('r1', 4, 'weird-custom', '{"x":1}'::jsonb, '2026-06-01T01:07:00Z'),
      ('r2', 1, 'turn', '{"phase":"start"}'::jsonb, '2026-06-01T02:00:01Z')
  `);

  await pool.query(`
    insert into envelopes (run_id, verdict, actions, usage, valid, errors, created_at)
    values
      ('r1',
       '{"kind":"pr","labels":["needs-info"],"evidence":[{"rule":"missing-test","quote":"没有新增测试","passed":false}]}'::jsonb,
       '[{"intent":"comment"},{"intent":"label"}]'::jsonb,
       '{"inputTokens":1000,"outputTokens":500,"costUsd":0.05}'::jsonb,
       true, null, '2026-06-01T01:09:00Z'),
      ('r2',
       '{"kind":"bogus"}'::jsonb,
       null, null, false, '[{"path":"kind","message":"枚举外取值"}]'::jsonb, '2026-06-01T02:19:00Z')
  `);

  await pool.query(`
    insert into actions (id, run_id, intent, target, external_ref, applied_at, reverted_at, revert_kind, audit, created_at)
    values
      (1, 'r1', 'comment',     'acme/widgets#12',  '9001',         '2026-06-01T01:11:00Z', '2026-06-01T04:00:00Z', 'comment-deleted',
         '{"declared":["src/a.ts"],"actual":["src/a.ts"],"intersect":["src/a.ts"],"dropped":[],"status":"applied","dryRun":false}'::jsonb, '2026-06-01T01:11:00Z'),
      (2, 'r1', 'label',       'acme/widgets#12',  null,           '2026-06-01T01:12:00Z', null, null, null, '2026-06-01T01:12:00Z'),
      (3, 'r2', 'close_issue', 'acme/widgets#7',   null,           '2026-06-01T02:21:00Z', null, null, null, '2026-06-01T02:21:00Z'),
      (4, 'r3', 'push_branch', 'other/lib#branch', 'pi-bot/fix-3', null, null, null,
         '{"declared":["a.ts","b.ts"],"actual":["a.ts"],"intersect":["a.ts"],"dropped":["b.ts"],"rejectedReason":"不在声明集合内","status":"rejected","dryRun":false}'::jsonb, '2026-06-01T03:02:00Z'),
      (5, 'r4', 'comment',     'other/lib#3',      '9002',         '2026-06-01T03:06:00Z', '2026-06-01T05:00:00Z', 'changes-requested',
         '{"status":"applied","dryRun":false}'::jsonb, '2026-06-01T03:06:00Z'),
      (6, 'r3', 'label',       'other/lib#3',      null,           '2026-06-01T03:07:00Z', null, null,
         '{"status":"applied"}'::jsonb, '2026-06-01T03:07:00Z'),
      (7, 'r3', 'open_pr',     'other/lib#3',      null,           '2026-06-01T03:08:00Z', null, null, null, '2026-06-01T03:08:00Z')
  `);

  await pool.query(`
    insert into metrics_daily (day, repo, outcome, run_count, p50_ms, p95_ms, cost_usd, revert_count, command_cost_usd)
    values
      ('2026-05-31', 'acme/widgets', 'success', 3, 600000, 900000, 0.040000, 0, '{"/review-pr":0.04}'::jsonb),
      ('2026-05-20', 'acme/widgets', 'success', 9, 500000, 800000, 7.770000, 1, '{"/review-pr":7.77}'::jsonb)
  `);

  await pool.query(`
    insert into runtime_flags (key, value, until)
    values
      ('rate_limit_pause', '1', '2026-06-01T12:15:00Z'),
      ('maintenance', '1', '2026-05-01T00:00:00Z')
  `);

  await pool.query(`
    insert into pgboss.job (name, data, state, retry_limit, retry_count, retry_delay, retry_backoff,
      expire_seconds, keep_until, created_on, policy)
    values
      ('run-task', '{"taskId":"t-queue-1"}'::jsonb, 'created', 0, 0, 0, false, 1200, '2026-06-02T12:00:00Z', '2026-06-01T11:50:00Z', 'standard'),
      ('run-task', '{"taskId":"t-queue-2"}'::jsonb, 'retry',   0, 0, 0, false, 1200, '2026-06-02T12:00:00Z', '2026-06-01T11:55:00Z', 'standard'),
      ('run-task', '{"taskId":"t-succ-1"}'::jsonb,  'active',  0, 0, 0, false, 1200, '2026-06-02T12:00:00Z', '2026-06-01T11:58:00Z', 'standard')
  `);
}
