/**
 * 迁移运行器 —— `pi-bot migrate` 的实现（tech-plan §8.4）。
 *
 * 本仓库只有**一本迁移账**：`schema_migrations`（下面 `LEDGER_DDL` 建的表）。
 * `drizzle-kit generate` 只负责产出 `migrations/NNNN_*.sql`，不参与应用（见 apps/server/drizzle.config.ts 的理由）；
 * 千万别再跑 `drizzle-kit migrate`，那会用另一个账本把同一条 DDL 应用第二次。
 *
 * 三条约定（dev-setup §5）：
 *  1. 文件名 `NNNN_snake_case_summary.sql`，`NNNN` 四位零填充；M0 段 0000–0099。
 *  2. 已应用的迁移文件**只读**：改 schema 就加新文件。运行器用 sha256 校验，
 *     内容变过就直接拒绝启动（否则已部署环境与仓库对不上，且没有任何提示）。
 *  3. 每条迁移在**独立事务**里执行（DDL + 记账同进同退）。PostgreSQL 的 DDL 是事务性的，
 *     所以失败一条就干净回滚，不会留下「表建了一半」的状态。
 *
 * 本机没有 PostgreSQL（dev-plan §13.1）：真正 `BEGIN/COMMIT` 与 DDL 只能在目标机验。
 * 本文件的可测部分是纯函数（文件名解析、语句切分、计划计算），单测不连库。
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { withTransaction } from './pool.ts';
import type { TransactionalPool } from './pool.ts';

/** 账本表名（表名固定，改它等于让所有已部署环境的账本失联）。 */
export const MIGRATION_LEDGER_TABLE = 'schema_migrations';

/** 建账本表：`IF NOT EXISTS` 保证在空库与已有库上都能幂等执行。 */
export const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS "${MIGRATION_LEDGER_TABLE}" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "checksum" text NOT NULL,
  "applied_at" timestamp with time zone DEFAULT now() NOT NULL
)`;

/** drizzle-kit 在语句之间插的分隔标记（也是它自家 CLI 的切分依据）。 */
export const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

/** 里程碑 → 迁移序号段（dev-setup §5）。 */
export const MIGRATION_SEQ_BLOCKS = {
  M0: { from: 0, to: 99 },
  M1: { from: 100, to: 199 },
  M2: { from: 200, to: 299 },
  M3: { from: 300, to: 399 },
  M4: { from: 400, to: 499 },
} as const;

export type MigrationFile = {
  /** 文件名去掉 `.sql`，如 `0000_init`（同时是账本主键） */
  id: string;
  /** 序号，`0000_init` → 0 */
  seq: number;
  /** 摘要部分，`0000_init` → `init` */
  tag: string;
  /** 文件全文（已把 CRLF 归一为 LF） */
  sql: string;
  /** `sha256(sql)` 的 hex，用于「历史文件只读」校验 */
  checksum: string;
};

export type AppliedMigration = {
  id: string;
  name: string;
  checksum: string;
  appliedAt: string;
};

export type MigrationPlan = {
  /** 需要执行的迁移，按 seq 升序 */
  pending: readonly MigrationFile[];
  /** 账本里已有、且校验和一致的迁移 */
  alreadyApplied: readonly MigrationFile[];
  /** 账本里已有、但文件内容变过 —— 必须中止（dev-setup §5） */
  checksumMismatches: readonly { id: string; expected: string; actual: string }[];
  /** 同一序号出现在两个文件里（并行开发撞号）—— 必须中止 */
  duplicateSeq: readonly number[];
};

export type MigrationRunResult = {
  applied: readonly string[];
  skipped: readonly string[];
};

export type MigrationLogger = {
  info: (message: string) => void;
};

const silentLogger: MigrationLogger = { info: () => {} };

/** `NNNN_snake_case_summary.sql` → `{ seq, tag }`；不符合命名规则返回 null。 */
export function parseMigrationFileName(fileName: string): { seq: number; tag: string } | null {
  const matched = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/.exec(fileName);
  if (matched === null) {
    return null;
  }
  const [, digits, tag] = matched;
  if (digits === undefined || tag === undefined) {
    return null;
  }
  return { seq: Number.parseInt(digits, 10), tag };
}

/** 内容归一（CRLF → LF）后取 sha256。归一的原因：Windows 检出可能是 CRLF，校验和不该因此变化。 */
export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/**
 * 把一个迁移文件切成可逐条执行的语句。
 *
 * 为什么按 `--> statement-breakpoint` 切而不是按 `;` 切：函数体（`$$ ... $$`）里也有分号，
 * 按分号切会把 `CREATE FUNCTION` 撕成两半。drizzle-kit 生成的文件只有这个标记能可靠界定语句边界。
 */
export function splitSqlStatements(sql: string): string[] {
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map((chunk) => chunk.replace(/\r\n/g, '\n').trim())
    .filter((chunk) => {
      if (chunk === '') {
        return false;
      }
      // 只剩注释的块（drizzle 有时会留 `-- ...`）不需要发给服务器
      const withoutComments = chunk
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim();
      return withoutComments !== '';
    });
}

/** 由文件名与内容构造 `MigrationFile`；文件名不合规则返回 null（由调用方决定报错还是忽略）。 */
export function toMigrationFile(fileName: string, sql: string): MigrationFile | null {
  const parsed = parseMigrationFileName(fileName);
  if (parsed === null) {
    return null;
  }
  const normalized = sql.replace(/\r\n/g, '\n');
  return {
    id: fileName.replace(/\.sql$/, ''),
    seq: parsed.seq,
    tag: parsed.tag,
    sql: normalized,
    checksum: checksumOf(normalized),
  };
}

/**
 * 计算「该跑哪些」。纯函数：不读盘、不连库，单测直接喂两个数组。
 *
 * 顺序：先按 seq 升序排，序号相同视为撞号（并行开发的真实故障，不是理论风险）。
 */
export function planMigrations(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): MigrationPlan {
  const sorted = [...files].sort((left, right) => left.seq - right.seq);
  const appliedById = new Map(applied.map((row) => [row.id, row]));

  const duplicateSeq: number[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index];
    const previous = sorted[index - 1];
    if (current !== undefined && previous !== undefined && current.seq === previous.seq) {
      duplicateSeq.push(current.seq);
    }
  }

  const pending: MigrationFile[] = [];
  const alreadyApplied: MigrationFile[] = [];
  const checksumMismatches: { id: string; expected: string; actual: string }[] = [];

  for (const file of sorted) {
    const row = appliedById.get(file.id);
    if (row === undefined) {
      pending.push(file);
      continue;
    }
    if (row.checksum !== file.checksum) {
      checksumMismatches.push({ id: file.id, expected: row.checksum, actual: file.checksum });
      continue;
    }
    alreadyApplied.push(file);
  }

  return { pending, alreadyApplied, checksumMismatches, duplicateSeq };
}

/** 迁移执行面：真实实现走 pg，测试实现是几行假函数。 */
export type MigrationExecutor = {
  ensureLedger: () => Promise<void>;
  listApplied: () => Promise<readonly AppliedMigration[]>;
  /** 单条迁移：DDL 与记账必须同一事务 */
  apply: (file: MigrationFile, statements: readonly string[]) => Promise<void>;
};

/** 真实执行面：`pool` 由入口传入（本模块不建池、不读 env）。 */
export function createPgMigrationExecutor(pool: TransactionalPool): MigrationExecutor {
  return {
    ensureLedger: async () => {
      const client = await pool.connect();
      try {
        await client.query(LEDGER_DDL);
      } finally {
        client.release();
      }
    },
    listApplied: async () => {
      const client = await pool.connect();
      try {
        const result = await client.query(
          `SELECT "id", "name", "checksum", "applied_at" FROM "${MIGRATION_LEDGER_TABLE}" ORDER BY "id"`,
        );
        return result.rows.map((row) => {
          const record = row as Record<string, unknown>;
          const appliedAt = record.applied_at;
          return {
            id: String(record.id),
            name: String(record.name),
            checksum: String(record.checksum),
            appliedAt: appliedAt instanceof Date ? appliedAt.toISOString() : String(appliedAt),
          };
        });
      } finally {
        client.release();
      }
    },
    apply: async (file, statements) => {
      await withTransaction(pool, async (client) => {
        for (const statement of statements) {
          await client.query(statement);
        }
        await client.query(
          `INSERT INTO "${MIGRATION_LEDGER_TABLE}" ("id", "name", "checksum") VALUES ($1, $2, $3)`,
          [file.id, file.tag, file.checksum],
        );
      });
    },
  };
}

/**
 * 跑迁移。顺序与中止条件都写在这里，CLI 只负责把 pool 与目录传进来。
 *
 * 中止条件（都抛错，不「尽力继续」）：
 *  - `duplicateSeq` 非空：两个文件抢同一个序号，谁先谁后是运气，不能靠运气改库。
 *  - `checksumMismatches` 非空：历史文件被改过（dev-setup §5 明确禁止）。
 */
export async function runMigrations(
  executor: MigrationExecutor,
  files: readonly MigrationFile[],
  logger: MigrationLogger = silentLogger,
): Promise<MigrationRunResult> {
  await executor.ensureLedger();
  const applied = await executor.listApplied();
  const plan = planMigrations(files, applied);

  if (plan.duplicateSeq.length > 0) {
    throw new Error(`迁移序号重复：${plan.duplicateSeq.join(', ')}（并行开发撞号，先改号再跑）`);
  }
  if (plan.checksumMismatches.length > 0) {
    const detail = plan.checksumMismatches.map((item) => item.id).join(', ');
    throw new Error(`已应用的迁移文件内容变了：${detail}（历史迁移只读，请新增文件）`);
  }

  const appliedIds: string[] = [];
  for (const file of plan.pending) {
    const statements = splitSqlStatements(file.sql);
    logger.info(`apply ${file.id} (${statements.length} statements)`);
    await executor.apply(file, statements);
    appliedIds.push(file.id);
  }

  return {
    applied: appliedIds,
    skipped: plan.alreadyApplied.map((file) => file.id),
  };
}

/** 读 `migrations/` 目录：忽略非 `.sql` 与不合命名规则的文件（如 `.gitkeep`、`meta/`）。 */
export async function readMigrationsFromDir(dir: string): Promise<MigrationFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: MigrationFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const parsed = parseMigrationFileName(entry.name);
    if (parsed === null) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    const sql = await readFile(fullPath, 'utf8');
    const file = toMigrationFile(entry.name, sql);
    if (file !== null) {
      files.push(file);
    }
  }
  return files.sort((left, right) => left.seq - right.seq);
}

/** `pi-bot migrate` 的入口：读目录 → 建执行面 → 跑。 */
export async function migrate(
  pool: TransactionalPool,
  dir: string,
  logger: MigrationLogger = silentLogger,
): Promise<MigrationRunResult> {
  const files = await readMigrationsFromDir(dir);
  return runMigrations(createPgMigrationExecutor(pool), files, logger);
}
