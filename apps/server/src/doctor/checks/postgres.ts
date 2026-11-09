/**
 * `postgres`：可连 + 迁移已到最新（tech-plan §6.4 / §7.2）。
 *
 * 「迁移已到最新」的判定不用 `migrate()`——那会**写库**。doctor 是只读预检：
 * 它只读 `schema_migrations` 与 `migrations/` 目录，用 `planMigrations()`（db 层的纯函数）
 * 算出「还差哪些、校验和有没有变」，然后报告。要不要跑迁移由人决定（`pi-bot migrate`）。
 *
 * 三个必须区分的失败形态（它们的修复动作完全不同）：
 *  - **连不上**：DSN / 网络 / 认证问题；
 *  - **账本表不存在**：这是空库，跑 `pi-bot migrate` 就行；
 *  - **checksum 不符 / 撞号**：历史迁移被改过或两个 session 抢了同一序号，
 *    此时**不能**自动迁移（§7.2 / dev-setup §5 明确禁止），必须人工处置。
 */
import path from 'node:path';
import {
  describeTarget,
  parseMigrationFileName,
  ping,
  planMigrations,
  toMigrationFile,
} from '../../db/index.ts';
import type { AppliedMigration, MigrationFile, SqlExecutor } from '../../db/index.ts';
import { QUEUES } from '../../queue/index.ts';
import { describeError } from '../deps.ts';
import type { CheckContext, CheckDefinition } from '../deps.ts';

/** PostgreSQL 的「表不存在」错误码。 */
const UNDEFINED_TABLE = '42P01';

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** 读 `migrations/`：只认 `NNNN_tag.sql`，其余（`.gitkeep`、`meta/`）跳过。走注入的 fs。 */
async function readMigrationFiles(ctx: CheckContext): Promise<MigrationFile[]> {
  const entries = await ctx.fs.readdir(ctx.migrationsDir);
  const files: MigrationFile[] = [];
  for (const name of entries) {
    if (parseMigrationFileName(name) === null) {
      continue;
    }
    const sql = await ctx.fs.readFile(path.join(ctx.migrationsDir, name), 'utf8');
    const file = toMigrationFile(name, sql);
    if (file !== null) {
      files.push(file);
    }
  }
  return files.sort((left, right) => left.seq - right.seq);
}

/** 读账本；表不存在时抛（由调用方翻译成「空库，还没迁移」）。 */
async function readApplied(pool: SqlExecutor): Promise<AppliedMigration[]> {
  const result = await pool.query(
    'SELECT "id", "name", "checksum", "applied_at" FROM "schema_migrations" ORDER BY "id"',
  );
  return result.rows.map((row) => {
    const record = asRecord(row);
    const appliedAt = record['applied_at'];
    return {
      id: String(record['id']),
      name: String(record['name']),
      checksum: String(record['checksum']),
      appliedAt: appliedAt instanceof Date ? appliedAt.toISOString() : String(appliedAt),
    };
  });
}

/** 队列状态：`pgboss.queue` 里已建了哪些队列（用于比对 §7.3 的定义清单）。 */
async function readQueueNames(
  pool: SqlExecutor,
): Promise<{ readonly present: boolean; readonly names: readonly string[] }> {
  const exists = await pool.query("SELECT to_regclass('pgboss.queue') AS q");
  const q = asRecord(exists.rows[0] ?? {})['q'];
  if (q === null || q === undefined) {
    return { present: false, names: [] };
  }
  const listed = await pool.query('SELECT "name" FROM "pgboss"."queue"');
  return { present: true, names: listed.rows.map((row) => String(asRecord(row)['name'])) };
}

export const postgresCheck: CheckDefinition = {
  id: 'postgres',
  title: 'Postgres 可连 + 迁移已到最新',
  async run(ctx) {
    const pool = ctx.pool;
    if (pool === undefined) {
      return {
        status: 'fail',
        detail: 'PI_BOT_DATABASE_URL 未配置，无法连库',
        fixHint: 'export PI_BOT_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/pi_issue_bot（tech-plan §7.1）',
      };
    }
    const dsn = ctx.env['PI_BOT_DATABASE_URL'] ?? '';
    const target = dsn === '' ? '<injected-pool>' : describeTarget(dsn);

    let latencyMs: number;
    try {
      const pinged = await ping(pool);
      latencyMs = pinged.latencyMs;
    } catch (error) {
      return {
        status: 'fail',
        detail: `连不上 ${target}：${describeError(error)}`,
        fixHint: '确认 PG 在跑、DSN 正确、库已建；`psql "$PI_BOT_DATABASE_URL" -c "select 1"` 先手工验一遍',
      };
    }

    let applied: AppliedMigration[];
    try {
      applied = await readApplied(pool);
    } catch (error) {
      if (errorCode(error) === UNDEFINED_TABLE) {
        return {
          status: 'fail',
          detail: `连上 ${target}（${String(latencyMs)}ms），但 schema_migrations 不存在：库还没迁移过`,
          fixHint: 'pnpm --filter @pi-issue-bot/server cli -- migrate',
        };
      }
      return {
        status: 'fail',
        detail: `读 schema_migrations 失败：${describeError(error)}`,
        fixHint: '确认连接用户对 schema_migrations 有 SELECT 权限（只读预检不改库）',
      };
    }

    let files: MigrationFile[];
    try {
      files = await readMigrationFiles(ctx);
    } catch (error) {
      return {
        status: 'fail',
        detail: `读迁移目录 ${ctx.migrationsDir} 失败：${describeError(error)}`,
        fixHint: '确认 PI_BOT_MIGRATIONS_DIR 指向仓库的 migrations/（默认就是它）',
      };
    }

    const plan = planMigrations(files, applied);
    if (plan.duplicateSeq.length > 0) {
      return {
        status: 'fail',
        detail: `迁移序号撞号：${plan.duplicateSeq.map(String).join('、')}（并行开发同时占了同一段）`,
        fixHint: '给后来者重新编号（dev-setup §5 的里程碑号段），撞号时谁先谁后是运气，不能靠运气改库',
      };
    }
    if (plan.checksumMismatches.length > 0) {
      const first = plan.checksumMismatches[0];
      return {
        status: 'fail',
        detail:
          `历史迁移被改过（${String(plan.checksumMismatches.length)} 个）：` +
          `${first === undefined ? '' : `${first.id} 期望 ${first.expected.slice(0, 12)}… 实际 ${first.actual.slice(0, 12)}…`}`,
        fixHint: '已应用的迁移文件只读（dev-setup §5）：恢复原文，改动写成新迁移',
      };
    }
    const migrationNote = `${String(plan.alreadyApplied.length)}/${String(files.length)} 已应用`;
    if (plan.pending.length > 0) {
      return {
        status: 'fail',
        detail:
          `迁移未到最新：待执行 ${plan.pending.map((file) => file.id).join('、')}` +
          `（已应用 ${migrationNote}，连上 ${target} ${String(latencyMs)}ms）`,
        fixHint: 'pnpm --filter @pi-issue-bot/server cli -- migrate（先跑迁移再启动）',
      };
    }

    let queue: { readonly present: boolean; readonly names: readonly string[] };
    try {
      queue = await readQueueNames(pool);
    } catch (error) {
      return {
        status: 'warn',
        detail: `迁移已最新（${migrationNote}），但读队列失败：${describeError(error)}`,
        fixHint: 'pg-boss 的 schema 由首次 `pi-bot serve` 建；确认连接用户有 pgboss schema 的读权限',
      };
    }

    const missingQueues = QUEUES.filter((spec) => !queue.names.includes(spec.name)).map((spec) => spec.name);
    const base =
      `连上 ${target}（${String(latencyMs)}ms）；迁移 ${migrationNote}；` +
      `队列 ${String(queue.names.length)} 条（定义 ${String(QUEUES.length)} 条）`;
    if (!queue.present) {
      return {
        status: 'warn',
        detail: `${base}：pgboss.queue 不存在（队列尚未初始化）`,
        fixHint: '首次 `pi-bot serve`（或 queue bootstrap）会 ensureQueues 建 6 条队列（§7.3）',
      };
    }
    if (missingQueues.length > 0) {
      return {
        status: 'warn',
        detail: `${base}：缺 ${missingQueues.join('、')}`,
        fixHint: '`pi-bot serve` 启动时会 ensureQueues 补齐；确认没有半途失败的启动',
      };
    }
    return { status: 'ok', detail: base };
  },
};
