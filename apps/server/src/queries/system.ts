/**
 * `GET /api/system` —— host 版本/能力、pi-host 状态、队列配置、保留期、仓库开关、runtime flags。
 *
 * 这里有一类是**真数据**，一类是**占位**，分清比假装齐全重要：
 *
 * 真数据（有表就读）：
 * - `queue`：`pgboss.queue` 的配置（`retry_limit`、`expire_seconds`）+ `pgboss.job` 的
 *   `pending`/`active` 计数。**`expireInMs` 是 job 存活上限，不是排队时长**（§5.3 F5）。
 *   内部队列（`__pgboss__*`）不展示。没有 `pgboss` schema 时数组为空。
 * - `flags`：`runtime_flags`（全局 429 熔断 / 暂停开关）。
 * - `repos`：`repos` 表（开关、dry-run、配置校验结果）。
 * - `retention`：§7.6 的保留期常量（webhook / run_events / transcript 各 90 天，指标永久）。
 * - `version.contract`：契约包的 `CONTRACT_VERSION`（与 OpenAPI 的 `info.version` 同源）。
 *
 * 占位（等对应 session 落地，字段语义已按契约给好）：
 * - `version.app`：根 `package.json` 的版本还没注入运行时，先给 `0.0.0`（W3-L/部署面接）。
 * - `version.host` / `hostPinned` / `host`：RACP 握手信息由 `runtime/` 持有，查询层拿不到（B6）。
 *   `host.status` 返回 `unknown`、`sessions: 0`——面板据此显示「未知」而不是「正常」。
 * - `doctor`：doctor 产物未落库（W3-L），返回 `not-run`。
 * - `skills`：技能清单由 `skills/` 在启动期解析（W4-M），当前没有可读的表，返回空数组。
 */
import { CONTRACT_VERSION } from '../../../../packages/contract/src/index.ts';
import { Params, intOf, isoOrNull, type SqlRunner } from './sql.ts';
import type { SystemResponse } from './types.ts';

/** 应用版本占位：与根 `package.json` 的 `version` 一致，等部署面注入。 */
const APP_VERSION = '0.0.0';

/** RACP 握手常量（tech-plan §4.2 / E2 的字面量，contract-api §8 原样给出）。 */
const PROTOCOL = { wsPath: '/v1/racp/ws', wsSubprotocol: 'pi-racp.v1.jsonrpc' } as const;

/** 保留期（tech-plan §7.6）：明细 90 天，指标永久。 */
const RETENTION = { webhookDays: 90, runEventDays: 90, transcriptDays: 90, metricsForever: true } as const;

type QueueRow = {
  name: string;
  retry_limit: number | string;
  expire_seconds: number | string;
  pending: number | string;
  active: number | string;
};

type FlagRow = { key: string; value: string; until: Date | null };

type RepoRow = {
  repo_full_name: string;
  enabled: boolean;
  dry_run: boolean;
  config_valid: boolean;
  config_error: string | null;
};

export async function querySystem(runner: SqlRunner, now: Date): Promise<SystemResponse> {
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
  const flagRows = (
    await runner.query(
      `select f.key, f.value, f.until
       from runtime_flags f
       where f.until is null or f.until > ${flagsParams.add(generatedAt, 'timestamptz')}
       order by f.key asc
       limit 32`,
      flagsParams.list(),
    )
  ).rows as FlagRow[];

  const repoRows = (
    await runner.query(
      `select repo_full_name, enabled, dry_run, config_valid, config_error
       from repos
       order by repo_full_name asc
       limit 200`,
    )
  ).rows as RepoRow[];


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
    repos: repoRows.map((row) => ({
      repo: row.repo_full_name,
      enabled: row.enabled === true,
      dryRun: row.dry_run === true,
      configValid: row.config_valid === true,
      configError: row.config_error,
    })),
    skills: [],
  };
}
