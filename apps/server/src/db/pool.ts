/**
 * Postgres 连接池工厂与事务包装。
 *
 * 两条硬约束（dev-plan §13.4、§13.1）：
 *  1. **不读 `process.env`**：DSN 由调用方（`serve` / `migrate` 子命令）解析好再传进来。
 *     好处是单测与 `replay` 都能塞一个假 DSN / 假池，数据层不碰全局状态。
 *  2. **不在模块顶层建池**：`createPool()` 是显式调用，进程何时连库由入口决定（优雅停机 §10 也更好做）。
 *
 * 池子按「一个进程一个」用的：pg-boss 有自己的池（`queue/boss.ts` 里创 PgBoss 实例时给），
 * 两套连接数加起来要算进 §3.5 的规格里，不要在这里偷偷放大 `max`。
 */
import pg from 'pg';
import type { Pool as PgPool, PoolConfig, PoolClient } from 'pg';

/** 只要能跑 SQL 就行——迁移器与查询测试都用这个接口，不绑死 `pg.Pool` 的具体类。 */
export type SqlExecutor = {
  query: (text: string, values?: unknown[]) => Promise<SqlResult>;
};

export type SqlResult = {
  rows: unknown[];
  rowCount?: number | null;
};

/** `withTransaction` 需要的东西：能拿连接，连接上能查、能归还。 */
export type TransactionalPool = {
  connect: () => Promise<TransactionClient>;
};

export type TransactionClient = SqlExecutor & {
  release: (error?: Error | false) => void;
};

/** 建池参数：显式、可测，默认值只覆盖「明显安全」的部分。 */
export type CreatePoolOptions = {
  /** 例如 `postgres://pi:secret@127.0.0.1:5432/pi_bot` —— 由入口从 env 解析后传入 */
  connectionString: string;
  /** 池上限；默认 10（§3.5：MVP <100 事件/天，够用） */
  max?: number;
  /** 连接超时毫秒，默认 5s：连不上就早点失败，别让 webhook 卡在 pending 上 */
  connectionTimeoutMillis?: number;
  /** 单条语句超时（服务端 `statement_timeout`），默认 30s：防止面板查询拖垮在线事务（§7.6） */
  statementTimeoutMillis?: number;
  /** 出现在 `pg_stat_activity.application_name` 里，便于排查 */
  applicationName?: string;
  /** 是否走 TLS（托管 PG 用；自托管同机一般 false） */
  ssl?: boolean;
};

const DEFAULT_MAX = 10;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

/** 建一个未连接的池。`pg.Pool` 是懒连接的，`ping()` 才真正握手。 */
export function createPool(options: CreatePoolOptions): PgPool {
  const config: PoolConfig = {
    connectionString: options.connectionString,
    max: options.max ?? DEFAULT_MAX,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    // 服务端超时：面板查询与聚合任务共用池子，单条语句必须有上限
    statement_timeout: options.statementTimeoutMillis ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    application_name: options.applicationName ?? 'pi-bot',
    ...(options.ssl === true ? { ssl: { rejectUnauthorized: true } } : {}),
  };
  return new pg.Pool(config);
}

type ReleaseTracked = TransactionClient & { _piReleased?: boolean };

/** 错误分支提前销毁连接时先打标记，避免 finally 再 release 一次（pg 里重复 release 会抛）。 */
function markReleased(client: TransactionClient): void {
  (client as ReleaseTracked)._piReleased = true;
}

function releaseQuietly(client: TransactionClient): void {
  const target = client as ReleaseTracked;
  if (target._piReleased === true) {
    return;
  }
  target._piReleased = true;
  client.release();
}

/**
 * 在事务里跑一段逻辑：`BEGIN` → fn → `COMMIT`；抛错则 `ROLLBACK` 后原样抛出。
 *
 * 为什么必须显式事务：`tasks` + `runs` + `actions` 的写入要么一起成功，要么都不要
 * （§7.3「非幂等写不盲目重试」全靠这里不留下半成品行）。
 */
export async function withTransaction<T>(
  pool: TransactionalPool,
  fn: (client: TransactionClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    let rollbackFailed = false;
    try {
      await client.query('ROLLBACK');
    } catch {
      // 回滚也失败（连接已断）：不能把坏连接还给池子，标记后带错误销毁
      rollbackFailed = true;
    }
    if (rollbackFailed) {
      markReleased(client);
      client.release(error instanceof Error ? error : false);
    }
    throw error;
  } finally {
    // 正常路径与已 rollback 的路径都在这里归还
    releaseQuietly(client);
  }
}

/** 启动自检：`select 1` 的往返耗时。失败即抛，由 `doctor` / `serve` 决定要不要拒绝启动。 */
export async function ping(executor: SqlExecutor): Promise<{ latencyMs: number }> {
  const started = Date.now();
  const result = await executor.query('select 1 as ok');
  if (result.rows.length === 0) {
    throw new Error('ping: 数据库没有返回行');
  }
  return { latencyMs: Date.now() - started };
}

/** 关池（优雅停机最后一步）。 */
export async function closePool(pool: PgPool): Promise<void> {
  await pool.end();
}

/**
 * 把 DSN 脱敏成能进日志/面板的形式：`postgres://user@host:port/db`。
 * 密码永不出现（plan §10「密钥不得出现在日志」）。解析失败一律返回 `<invalid-dsn>`，
 * 不把原始串回吐——原始串里可能就有密码。
 */
export function describeTarget(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    const user = url.username === '' ? '' : `${url.username}@`;
    const port = url.port === '' ? '' : `:${url.port}`;
    return `${url.protocol}//${user}${url.hostname}${port}${url.pathname}`;
  } catch {
    return '<invalid-dsn>';
  }
}

/** 供 `migrate.ts` 复用的连接类型别名（避免各文件各写一遍 pg 的导入）。 */
export type { PoolClient };
