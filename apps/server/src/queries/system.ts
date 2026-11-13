/**
 * `GET /api/system` —— host 版本/能力、pi-host 状态、队列配置、保留期、仓库开关、runtime flags。
 *
 * 这里有一类是**真数据**，一类是**占位**，分清比假装齐全重要：
 *
 * 真数据（有表就读）：
 * - `queue`：`pgboss.queue` 的配置（`retry_limit`、`expire_seconds`）+ `pgboss.job` 的
 *   `pending`/`active` 计数。**`expireInMs` 是 job 存活上限，不是排队时长**（§5.3 F5）。
 *   内部队列（`__pgboss__*`）不展示。没有 `pgboss` schema 时数组为空。
 * - `flags`：`runtime_flags`（全局 429 熔断 / 暂停开关）。带 `?repo=` 时只留
 *   「全局（`repo is null`）+ 该仓库」的；其余行属于别家仓库，展示出来只会误导。
 * - `repos`：**`repos` 表**（`listRepos()`，多仓库改造后的唯一仓库载体）。
 *   返回 `settingsValid/settingsError/source/archivedAt/lastActivityAt`；
 *   `configValid/configError` 是同值别名（老面板读法继续能用）。
 *   `lastActivityAt` = `tasks.queued_at` 与 `actions.applied_at` 的 max（一次聚合，不算 jsonb）。
 * - `retention`：§7.6 的保留期常量（webhook / run_events / transcript 各 90 天，指标永久）。
 * - `version.contract`：契约包的 `CONTRACT_VERSION`（与 OpenAPI 的 `info.version` 同源）。
 *
 * 占位（等对应 session 落地，字段语义已按契约给好）：
 * - `version.app`：根 `package.json` 的版本还没注入运行时，先给 `0.0.0`（W3-L/部署面接）。
 * - `version.host` / `hostPinned` / `host`：RACP 握手信息由 `runtime/` 持有，查询层拿不到（B6）。
 *   `host.status` 返回 `unknown`、`sessions: 0`——面板据此显示「未知」而不是「正常」。
 * - `doctor`：doctor 产物未落库（W3-L），返回 `not-run`。
 */
import { CONTRACT_VERSION } from '../../../../packages/contract/src/index.ts';
import { listRepos } from '../config/repo-config.ts';
import type { SqlRunner as RepoDb } from '../config/repo-config.ts';
import { Params, intOf, isoOrNull, type SqlRunner } from './sql.ts';
import type { SystemQuery, SystemResponse } from './types.ts';

/** 应用版本占位：与根 `package.json` 的 `version` 一致，等部署面注入。 */
const APP_VERSION = '0.0.0';

/** RACP 握手常量（tech-plan §4.2 / E2 的字面量，contract-api §8 原样给出）。 */
const PROTOCOL = { wsPath: '/v1/racp/ws', wsSubprotocol: 'pi-racp.v1.jsonrpc' } as const;

/** 保留期（tech-plan §7.6）：明细 90 天，指标永久。 */
const RETENTION = { webhookDays: 90, runEventDays: 90, transcriptDays: 90, metricsForever: true } as const;

/** 仓库列表上限（与契约 `SystemResponse.repos.max(200)` 一致）。 */
const REPO_LIMIT = 200;

type QueueRow = {
  name: string;
  retry_limit: number | string;
  expire_seconds: number | string;
  pending: number | string;
  active: number | string;
};

type FlagRow = { key: string; value: string; until: Date | null };

type LastActivityRow = { repo: string; last_at: Date | null };

export async function querySystem(
  runner: SqlRunner,
  now: Date,
  query: SystemQuery = {},
): Promise<SystemResponse> {
  const generatedAt = now.toISOString();

  const presence = (await runner.query("select to_regclass('pgboss.queue') is not null as present")).rows as Array<{
    present: boolean;
  }>;
  const queueRows =
    presence[0]?.present === true
      ? ((
          await runner.query(
            `select
               q.name,
               q.retry_limit,
               q.expire_seconds,
               coalesce(j.pending, 0) as pending,
               coalesce(j.active, 0) as active
             from pgboss.queue q
             left join (
               select
                 name,
                 count(*) filter (where state in ('created', 'retry')) as pending,
                 count(*) filter (where state = 'active') as active
               from pgboss.job
               group by name
             ) j on j.name = q.name
             where q.name not like '\\_\\_pgboss\\_\\_%'
             order by q.name asc
             limit 32`,
          )
        ).rows as QueueRow[])
      : [];

  const flagsParams = new Params();
  const flagsWhere = [
    `(f.until is null or f.until > ${flagsParams.add(generatedAt, 'timestamptz')})`,
  ];
  if (query.repo !== undefined) {
    // 全局开关（`repo is null`）+ 本仓库的；别家仓库的开关与这个页面无关
    flagsWhere.push(`(f.repo is null or f.repo = ${flagsParams.add(query.repo)})`);
  }
  const flagRows = (
    await runner.query(
      `select f.key, f.value, f.until
       from runtime_flags f
       where ${flagsWhere.join(' and ')}
       order by f.key asc
       limit 32`,
      flagsParams.list(),
    )
  ).rows as FlagRow[];

  /* ── 仓库：读 `repos` 表（多仓库改造后的唯一载体） ───────────────────────── */
  const lastActivity = await readLastActivity(runner);
  const repos = (await listRepos(toRepoDb(runner)))
    .filter((item) => query.repo === undefined || item.repo === query.repo)
    .slice(0, REPO_LIMIT)
    .map((item) => ({
      repo: item.repo,
      enabled: item.enabled,
      dryRun: item.dryRun,
      settingsValid: item.settingsValid,
      settingsError: item.settingsError,
      source: item.source,
      archivedAt: item.archivedAt,
      lastActivityAt: lastActivity.get(item.repo) ?? null,
      // 向后兼容别名（同名同值）：老面板读 `configValid` / `configError` 不用改
      configValid: item.settingsValid,
      configError: item.settingsError,
    }));

  return {
    generatedAt,
    version: {
      app: APP_VERSION,
      contract: CONTRACT_VERSION,
      host: null,
      hostPinned: false,
    },
    protocol: { wsPath: PROTOCOL.wsPath, wsSubprotocol: PROTOCOL.wsSubprotocol },
    host: { status: 'unknown', lastPingAt: null, sessions: 0 },
    doctor: { status: 'not-run', checkedAt: null, checks: [] },
    queue: queueRows.map((row) => ({
      name: row.name,
      pending: intOf(row.pending),
      active: intOf(row.active),
      retryLimit: intOf(row.retry_limit),
      expireInMs: intOf(row.expire_seconds) * 1000,
    })),
    retention: { ...RETENTION },
    flags: flagRows.map((row) => ({ key: row.key, value: row.value, until: isoOrNull(row.until) })),
    repos,
  };
}

/**
 * 每个仓库的「最近活动」：`tasks.queued_at` ∪ `actions.applied_at` 的 max。
 *
 * 为什么不在 `listRepos` 里做：那一层是**配置存储**（`config/repo-config.ts`），
 * 「最近跑过什么」是统计问题，属于查询层；两者混在一起会让面板的切换器查询背上业务表扫描。
 */
async function readLastActivity(runner: SqlRunner): Promise<Map<string, string>> {
  const rows = (
    await runner.query(
      `select x.repo as repo, max(x.at) as last_at
       from (
         select t.repo as repo, t.queued_at as at from tasks t
         union all
         select t.repo as repo, a.applied_at as at
         from actions a
         join runs r on r.id = a.run_id
         join tasks t on t.id = r.task_id
         where a.applied_at is not null
       ) x
       group by x.repo`,
    )
  ).rows as LastActivityRow[];

  const out = new Map<string, string>();
  for (const row of rows) {
    const at = isoOrNull(row.last_at);
    if (at !== null) out.set(row.repo, at);
  }
  return out;
}

/**
 * `queries/sql.ts` 的 `SqlRunner` → `config/repo-config.ts` 的 `SqlRunner`。
 *
 * 两个类型只差 `values` 的只读修饰（`unknown[]` vs `readonly unknown[]`），
 * 结构上不兼容但语义完全一致，所以在这里做一次显式适配，而不是把类型断言散到调用点。
 */
function toRepoDb(runner: SqlRunner): RepoDb {
  return {
    query: (text: string, values?: readonly unknown[]) =>
      runner.query(text, values === undefined ? undefined : [...values]),
  };
}
