/**
 * `GET /api/quality/reverts` —— 「自动执行后被人改回」的次数与比例（plan §6.5、tech-plan §7.5）。
 *
 * 口径（契约把这条写成了 `refine`，不是文案）：
 * - `rate = reverted / applied`；`applied = 0` 时 `rate` **必须是 `null`**（不能用 0 冒充），
 *   `applied > 0` 时 `rate` 不能是 `null`。`ratioOf()` 就是这个语义。
 * - 「已应用」= `actions.applied_at` 落在窗口内（`rejected` / `skipped` / `dry-run` 的 `applied_at` 为空，天然不计入）。
 * - 「被改回」= 同一行的 `reverted_at` 非空（reconcile 或反向 webhook 置位，§7.5 第 3 条）。
 * - 分组维度：`byCommand` 读 `tasks.command`、`byRepo` 读 `tasks.repo`（F9：不解 jsonb）。
 * - `records` 按 `reverted_at` 倒序 + `actions.id` 倒序做 keyset 分页，每页上限 200（契约）。
 */
import {
  ACTION_INTENTS_SQL,
  Params,
  decodeCursor,
  encodeCursor,
  intOf,
  isoOf,
  ratioOf,
  resolveWindow,
  sqlRevertKind,
  stringOrNull,
  type SqlRunner,
} from './sql.ts';
import { targetOfAction } from './tasks.ts';
import type { QualityQuery, RevertBucket, RevertsResponse } from './types.ts';

/** 契约：`records` 每页最多 200 行。 */
const MAX_RECORDS = 200;

type OverallRow = { applied: number | string; reverted: number | string };

type BucketRow = { key: string; applied: number | string; reverted: number | string };

type RecordRow = {
  id: number | string;
  task_id: string;
  repo: string;
  command: string;
  target_kind: string;
  intent: string;
  target: string;
  external_ref: string | null;
  applied_at: Date;
  reverted_at: Date;
  revert_kind: string;
};

/** 「窗口内已应用的 actions」：三个聚合与 records 共用同一份过滤，避免数字与明细不一致。 */
function scopedCte(params: Params, query: QualityQuery, window: { from: string; to: string }): string {
  const where = [
    `a.applied_at >= ${params.add(window.from, 'timestamptz')}`,
    `a.applied_at < ${params.add(window.to, 'timestamptz')}`,
    `a.intent in ${ACTION_INTENTS_SQL}`,
  ];
  if (query.repo !== undefined) {
    where.push(`t.repo = ${params.add(query.repo)}`);
  }
  if (query.command !== undefined) {
    where.push(`t.command = ${params.add(query.command)}`);
  }
  return `with scoped as (
  select
    a.id,
    a.intent,
    a.target,
    a.external_ref,
    a.applied_at,
    a.reverted_at,
    ${sqlRevertKind('a.revert_kind')} as revert_kind,
    t.id as task_id,
    t.repo,
    t.command,
    t.target_kind
  from actions a
  join runs r on r.id = a.run_id
  join tasks t on t.id = r.task_id
  where ${where.join('\n    and ')}
)`;
}

function toBucket(row: BucketRow): RevertBucket {
  const applied = intOf(row.applied);
  const reverted = intOf(row.reverted);
  return { key: row.key, applied, reverted, rate: ratioOf(reverted, applied) };
}

export async function queryReverts(
  runner: SqlRunner,
  now: Date,
  query: QualityQuery,
): Promise<RevertsResponse> {
  const window = resolveWindow(query, now);
  const limit = Math.min(query.limit ?? 50, MAX_RECORDS);

  /* 1. 总体改回率 */
  const overallParams = new Params();
  const overallRows = (
    await runner.query(
      `${scopedCte(overallParams, query, window)}
select
  count(*) as applied,
  count(*) filter (where reverted_at is not null) as reverted
from scoped`,
      overallParams.list(),
    )
  ).rows as OverallRow[];
  const applied = intOf(overallRows[0]?.applied);
  const reverted = intOf(overallRows[0]?.reverted);

  /* 2. 按命令 / 仓库分组 */
  const byCommandParams = new Params();
  const byCommandRows = (
    await runner.query(
      `${scopedCte(byCommandParams, query, window)}
select
  command as key,
  count(*) as applied,
  count(*) filter (where reverted_at is not null) as reverted
from scoped
group by command
order by count(*) desc, command asc`,
      byCommandParams.list(),
    )
  ).rows as BucketRow[];

  const byRepoParams = new Params();
  const byRepoRows = (
    await runner.query(
      `${scopedCte(byRepoParams, query, window)}
select
  repo as key,
  count(*) as applied,
  count(*) filter (where reverted_at is not null) as reverted
from scoped
group by repo
order by count(*) desc, repo asc`,
      byRepoParams.list(),
    )
  ).rows as BucketRow[];

  /* 3. 逐条改回记录（keyset 分页） */
  const recordParams = new Params();
  const recordWhere = ['reverted_at is not null', 'revert_kind is not null'];
  const cursor = decodeCursor(query.cursor);
  if (cursor !== null) {
    const at = recordParams.add(cursor.at, 'timestamptz');
    const atAgain = recordParams.add(cursor.at, 'timestamptz');
    const id = recordParams.add(cursor.id, 'bigint');
    recordWhere.push(`(reverted_at < ${at} or (reverted_at = ${atAgain} and id < ${id}))`);
  }
  const recordRows = (
    await runner.query(
      `${scopedCte(recordParams, query, window)}
select id, task_id, repo, command, target_kind, intent, target, external_ref, applied_at, reverted_at, revert_kind
from scoped
where ${recordWhere.join('\n  and ')}
order by reverted_at desc, id desc
limit ${recordParams.add(limit + 1, 'int')}`,
      recordParams.list(),
    )
  ).rows as RecordRow[];

  const hasMore = recordRows.length > limit;
  const page = hasMore ? recordRows.slice(0, limit) : recordRows;
  const last = page[page.length - 1];

  return {
    generatedAt: now.toISOString(),
    window,
    overall: { applied, reverted, rate: ratioOf(reverted, applied) },
    byCommand: byCommandRows.map(toBucket),
    byRepo: byRepoRows.map(toBucket),
    records: page.map((row) => {
      const appliedAt = isoOf(row.applied_at, now.toISOString());
      const target = targetOfAction(
        row.target,
        row.intent,
        row.repo,
        row.target_kind,
        stringOrNull(row.external_ref, 200),
        appliedAt,
      );
      return {
        actionId: String(row.id),
        taskId: row.task_id,
        repo: row.repo,
        command: row.command,
        intent: row.intent as RevertsResponse['records'][number]['intent'],
        revertKind: row.revert_kind as RevertsResponse['records'][number]['revertKind'],
        appliedAt,
        revertedAt: isoOf(row.reverted_at, appliedAt),
        url: target.url,
      };
    }),
    nextCursor: hasMore && last !== undefined ? encodeCursor(isoOf(last.reverted_at, ''), String(last.id)) : null,
    hasMore,
  };
}
