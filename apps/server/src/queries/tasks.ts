/**
 * 任务列表（`/api/tasks`）与任务详情（`/api/tasks/:id`）。
 *
 * 三处口径在注释里说清，免得 PM/面板各自猜：
 *
 * 1. **`startedAt` / `durationMs`**：`tasks` 表没有 `started_at` 列（§7.2 的列清单里确实没有），
 *    所以「开始时刻」取该任务**最早一次 run 的 `started_at`**；`durationMs = ended_at - startedAt`，
 *    两者任一为空（还在排队 / 还在跑）就是 `null`。
 * 2. **`outcome` / `failureClass`**：取**最后一次 run**（`attempt` 最大，其次 `started_at`）的值，
 *    并映射成契约枚举（`rate_limit` → `rate-limit` 等，见 `sql.ts`）。
 * 3. **`costUsd`**：该任务所有 run 的 `usage_costs` 之和；**没有任何 usage 行时为 `null`**（与「跑了但免费 = 0」区分）。
 * 4. **`dryRun`**：`tasks` 没有 dry-run 列，取仓库级开关 `repos.dry_run`（首周强制 dry-run 的口径，plan §11）；
 *    仓库还没有 `repos` 行时为 `false`。
 */
import {
  ACTION_INTENTS_SQL,
  Params,
  arrayOf,
  decodeCursor,
  encodeCursor,
  intOf,
  isoOf,
  isoOrNull,
  msBetween,
  msOf,
  recordOf,
  sqlActionStatus,
  sqlFailureClass,
  sqlOutcome,
  sqlRevertKind,
  sqlRunEventKind,
  sqlTaskStatus,
  stringOrNull,
  taskStatusFilterValues,
  type SqlRunner,
} from './sql.ts';
import type {
  ActionRecord,
  EnvelopeRecord,
  RunEventRecord,
  RunSummary,
  TaskDetailResponse,
  TaskDiff,
  TaskListItem,
  TasksQuery,
  TasksResponse,
} from './types.ts';

/**
 * `taskCte` 只关心筛选条件，不关心分页：详情页传 `{}`、列表页传完整 `TasksQuery`。
 * 单独取出这一层是因为 `TasksQuery.limit` 经 zod 的 `.default()` 之后是**必填**的，
 * 而 CTE 根本用不到它。
 */
type TaskFilter = Partial<Pick<TasksQuery, 'repo' | 'status' | 'failureClass' | 'command' | 'from' | 'to'>>;

/** 列表默认页大小（与 `pageLimitSchema` 的默认值一致；http 层已补齐，这里只是兜底）。 */
const DEFAULT_LIMIT = 50;

/** 详情页每次最多看 20 次尝试、500 条事件、100 条动作（契约上限）。 */
const DETAIL_RUNS_LIMIT = 20;
const DETAIL_EVENTS_LIMIT = 500;
const DETAIL_ACTIONS_LIMIT = 100;

type TaskRow = {
  id: string;
  repo: string;
  source: string;
  command: string;
  target_kind: string;
  target_number: number;
  head_sha: string | null;
  status: string;
  run_outcome: string | null;
  failure_class: string | null;
  actor_login: string | null;
  queued_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
  duration_ms: number | string | null;
  cost_usd: string | number | null;
  dry_run: boolean;
};

/**
 * 「任务 + 首次 started_at + 末次 outcome/failure_class + 成本 + dry-run」的公共 CTE。
 *
 * 为什么用 `left join lateral` 而不是三次子查询：三份聚合的 `where` 都是 `task_id = t.id`，
 * lateral 让优化器一次扫 `runs`（`runs_task_id_idx`）就能拿到两行，成本聚合也只扫该任务的行。
 */
function taskCte(params: Params, query: TaskFilter): string {
  const where: string[] = [];
  if (query.repo !== undefined) {
    where.push(`t.repo = ${params.add(query.repo)}`);
  }
  if (query.status !== undefined) {
    where.push(`t.status = any(${params.add(taskStatusFilterValues(query.status), 'text[]')})`);
  }
  if (query.command !== undefined) {
    where.push(`t.command = ${params.add(query.command)}`);
  }
  if (query.from !== undefined) {
    where.push(`t.queued_at >= ${params.add(query.from, 'timestamptz')}`);
  }
  if (query.to !== undefined) {
    where.push(`t.queued_at < ${params.add(query.to, 'timestamptz')}`);
  }
  const whereSql = where.length === 0 ? '' : `\n  where ${where.join('\n    and ')}`;

  return `with base as (
  select
    t.id,
    t.repo,
    t.source,
    t.command,
    t.target_kind,
    t.target_number,
    t.head_sha,
    ${sqlTaskStatus('t.status')} as status,
    ${sqlOutcome('last_run.outcome')} as run_outcome,
    ${sqlFailureClass('last_run.failure_class')} as failure_class,
    t.actor_login,
    t.queued_at,
    t.ended_at,
    first_run.started_at,
    case
      when t.ended_at is not null and first_run.started_at is not null
        then extract(epoch from (t.ended_at - first_run.started_at)) * 1000
      else null
    end as duration_ms,
    cost.cost_usd,
    coalesce(rep.dry_run, false) as dry_run
  from tasks t
  left join lateral (
    select min(r.started_at) as started_at from runs r where r.task_id = t.id
  ) first_run on true
  left join lateral (
    select r.outcome, r.failure_class
    from runs r
    where r.task_id = t.id
    order by r.attempt desc, r.started_at desc, r.id desc
    limit 1
  ) last_run on true
  left join lateral (
    select sum(uc.cost_usd) as cost_usd
    from usage_costs uc
    join runs r on r.id = uc.run_id
    where r.task_id = t.id
  ) cost on true
  left join repos rep on rep.repo_full_name = t.repo${whereSql}
)`;
}

/** `tasks` 行 → 契约的 `TaskListItem`（这是全项目唯一一处转换，详情页复用）。 */
function toTaskListItem(row: TaskRow): TaskListItem {
  const startedAt = isoOrNull(row.started_at);
  const endedAt = isoOrNull(row.ended_at);
  const durationMs = msOf(row.duration_ms) ?? msBetween(row.started_at, row.ended_at);
  return {
    id: row.id,
    repo: row.repo,
    source: row.source as TaskListItem['source'],
    command: row.command,
    targetKind: row.target_kind as TaskListItem['targetKind'],
    targetNumber: intOf(row.target_number),
    headSha: row.head_sha,
    status: row.status as TaskListItem['status'],
    failureClass: (row.failure_class ?? null) as TaskListItem['failureClass'],
    outcome: (row.run_outcome ?? null) as TaskListItem['outcome'],
    actorLogin: row.actor_login,
    queuedAt: isoOf(row.queued_at, new Date(0).toISOString()),
    startedAt,
    endedAt,
    durationMs,
    costUsd: row.cost_usd === null || row.cost_usd === undefined ? null : Number(row.cost_usd),
    dryRun: row.dry_run === true,
  };
}

/**
 * 列表查询。
 *
 * **游标语义**：排序键是 `(queued_at desc, id desc)`，游标里存的就是上一页最后一行的这两个值，
 * 下一页取「严格小于」的行（keyset）。`nextCursor` 在 `hasMore` 为真时才有值，
 * 面板只要原样回传即可（编码见 `sql.ts#encodeCursor`）。
 */
export async function queryTasks(runner: SqlRunner, query: TasksQuery): Promise<TasksResponse> {
  const limit = query.limit ?? DEFAULT_LIMIT;
  const params = new Params();
  const cte = taskCte(params, query);

  const outer: string[] = [];
  if (query.failureClass !== undefined) {
    // 失败分类只在映射之后可见，所以过滤放在 CTE 外层（映射是 SQL 表达式，筛选必须与展示同源）
    outer.push(`failure_class = ${params.add(query.failureClass)}`);
  }
  const cursor = decodeCursor(query.cursor);
  if (cursor !== null) {
    const at = params.add(cursor.at, 'timestamptz');
    const atAgain = params.add(cursor.at, 'timestamptz');
    const id = params.add(cursor.id);
    outer.push(`(queued_at < ${at} or (queued_at = ${atAgain} and id < ${id}))`);
  }
  const outerSql = outer.length === 0 ? '' : `\n  where ${outer.join('\n    and ')}`;
  const limitParam = params.add(limit + 1, 'int');

  const rows = (
    await runner.query(
      `${cte}
select * from base${outerSql}
order by queued_at desc, id desc
limit ${limitParam}`,
      params.list(),
    )
  ).rows as TaskRow[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  // totalEstimate：MVP 规模（<100 事件/天）下直接 count(*) 就是「估计」的上限，不需要缓存列
  const countParams = new Params();
  const countCte = taskCte(countParams, query);
  const countOuter =
    query.failureClass === undefined ? '' : `\n  where failure_class = ${countParams.add(query.failureClass)}`;
  const countRows = (
    await runner.query(`${countCte}\nselect count(*) as total from base${countOuter}`, countParams.list())
  ).rows as Array<{ total: number | string }>;
  const totalEstimate = countRows.length === 0 ? 0 : intOf(countRows[0]?.total);

  return {
    items: page.map(toTaskListItem),
    nextCursor: hasMore && last !== undefined ? encodeCursor(isoOf(last.queued_at, ''), last.id) : null,
    hasMore,
    totalEstimate,
  };
}

/* ── 详情 ─────────────────────────────────────────────────────────────────── */

type RunRow = {
  id: string;
  attempt: number;
  session_id: string | null;
  turn_id: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  outcome: string | null;
  failure_class: string | null;
  failure_detail: unknown;
};

type EventRow = {
  run_id: string;
  cursor: number;
  kind: string;
  created_at: Date;
  payload: unknown;
};

type EnvelopeRow = {
  run_id: string;
  valid: boolean;
  verdict: unknown;
  actions: unknown;
  usage: unknown;
};

type ActionRow = {
  id: number | string;
  run_id: string;
  intent: string;
  target: string;
  external_ref: string | null;
  applied_at: Date | null;
  reverted_at: Date | null;
  revert_kind: string | null;
  audit: unknown;
  status: string;
  created_at: Date;
};

const SHA_RE = /^[0-9a-f]{7,40}$/;

/** 契约里的 `verdict`：只接受能通过契约约束的形状，其余一律 `null`（坏输出不改写成「空 verdict」）。 */
function verdictOf(raw: unknown): EnvelopeRecord['verdict'] {
  const record = recordOf(raw);
  const kind = record.kind;
  if (kind !== 'issue' && kind !== 'pr') return null;

  const labels = arrayOf(record.labels)
    .filter((label): label is string => typeof label === 'string' && label.length >= 1 && label.length <= 50)
    .filter((label) => !/\p{Cc}/u.test(label))
    .slice(0, 16);

  const evidence = arrayOf(record.evidence)
    .map((item) => {
      const entry = recordOf(item);
      const rule = typeof entry.rule === 'string' ? entry.rule.slice(0, 120) : '';
      const quote = typeof entry.quote === 'string' ? entry.quote.slice(0, 2000) : '';
      if (rule === '' || quote === '') return null;
      const passed = typeof entry.passed === 'boolean' ? entry.passed : null;
      return { rule, quote, passed };
    })
    .filter((item): item is { rule: string; quote: string; passed: boolean | null } => item !== null)
    .slice(0, 32);

  return { kind, labels, evidence };
}

function toRunSummary(row: RunRow): RunSummary {
  const detail = recordOf(row.failure_detail);
  return {
    id: row.id,
    attempt: intOf(row.attempt),
    sessionId: row.session_id,
    turnId: row.turn_id,
    startedAt: isoOrNull(row.started_at),
    endedAt: isoOrNull(row.ended_at),
    outcome: (row.outcome ?? null) as RunSummary['outcome'],
    failureClass: (row.failure_class ?? null) as RunSummary['failureClass'],
    failureDetail: Object.keys(detail).length === 0 ? null : detail,
  };
}

function toRunEvent(row: EventRow): RunEventRecord {
  return {
    runId: row.run_id,
    cursor: intOf(row.cursor),
    kind: row.kind as RunEventRecord['kind'],
    at: isoOf(row.created_at, new Date(0).toISOString()),
    payload: recordOf(row.payload),
  };
}

function usageOf(raw: unknown): EnvelopeRecord['usage'] {
  const record = recordOf(raw);
  return {
    inputTokens: intOf(record.inputTokens ?? record.input_tokens),
    outputTokens: intOf(record.outputTokens ?? record.output_tokens),
    costUsd: Number(record.costUsd ?? record.cost_usd ?? 0) || 0,
  };
}

function toEnvelopeRecord(row: EnvelopeRow): EnvelopeRecord {
  return {
    runId: row.run_id,
    valid: row.valid === true,
    verdict: verdictOf(row.verdict),
    actionCount: arrayOf(row.actions).length,
    usage: usageOf(row.usage),
  };
}

/** 动作对象类型：判定类动作沿用任务的目标类型，`push_branch` 是分支、`comment` 是评论。 */
function actionTargetKind(intent: string, taskTargetKind: string): 'issue' | 'pr' | 'comment' | 'branch' {
  if (intent === 'push_branch') return 'branch';
  if (intent === 'comment') return 'comment';
  return taskTargetKind === 'pr' ? 'pr' : 'issue';
}

/**
 * `actions.target` 是文本（`owner/name#123`），契约要的是结构化的 `{kind, number, ref, url}`。
 * 解析规则：`#<数字>` 取出编号；`url` 只在**真的写成功**（`applied_at` 非空）时按仓库与编号拼，
 * dry-run 与未写成一律 `null`（契约要求）。企业版自定义域名时这里要改成落库 `html_url`——记为已知缺口。
 */
function parseActionTarget(
  raw: string,
  kind: 'issue' | 'pr' | 'comment' | 'branch',
  repo: string,
  externalRef: string | null,
  appliedAt: string | null,
): ActionRecord['target'] {
  const match = /#(\d+)\s*$/.exec(raw);
  const number = match?.[1] === undefined ? null : Number.parseInt(match[1], 10);
  const ref = kind === 'branch' ? externalRef : null;

  let url: string | null = null;
  if (appliedAt !== null) {
    if (kind === 'issue' && number !== null) url = `https://github.com/${repo}/issues/${number}`;
    if (kind === 'pr' && number !== null) url = `https://github.com/${repo}/pull/${number}`;
    if (kind === 'comment' && number !== null && externalRef !== null) {
      url = `https://github.com/${repo}/issues/${number}#issuecomment-${externalRef}`;
    }
    if (kind === 'branch' && ref !== null) url = `https://github.com/${repo}/tree/${ref}`;
  }

  return {
    kind,
    number: number !== null && Number.isFinite(number) && number > 0 ? number : null,
    ref,
    url: url === null ? null : url.slice(0, 500),
  };
}

function toActionRecord(row: ActionRow, repo: string, taskTargetKind: string): ActionRecord {
  const kind = actionTargetKind(row.intent, taskTargetKind);
  const appliedAt = isoOrNull(row.applied_at);
  const externalRef = stringOrNull(row.external_ref, 200);
  const auditRecord = recordOf(row.audit);
  const audit =
    Object.keys(auditRecord).length === 0
      ? null
      : {
          declared: arrayOf(auditRecord.declared).filter((v): v is string => typeof v === 'string').slice(0, 200),
          actual: arrayOf(auditRecord.actual).filter((v): v is string => typeof v === 'string').slice(0, 200),
          intersect: arrayOf(auditRecord.intersect).filter((v): v is string => typeof v === 'string').slice(0, 200),
          dropped: arrayOf(auditRecord.dropped).filter((v): v is string => typeof v === 'string').slice(0, 200),
          rejectedReason: stringOrNull(auditRecord.rejectedReason, 500),
        };

  return {
    id: String(row.id),
    runId: row.run_id,
    intent: row.intent as ActionRecord['intent'],
    status: row.status as ActionRecord['status'],
    target: parseActionTarget(row.target, kind, repo, externalRef, appliedAt),
    externalRef,
    appliedAt,
    revertedAt: isoOrNull(row.reverted_at),
    revertKind: (row.revert_kind ?? null) as ActionRecord['revertKind'],
    audit,
    dryRun: auditRecord.dryRun === true,
  };
}

/**
 * diff 的取数约定（**已知缺口**：`actions`/`tasks` 没有 diff 列，plan 里它是 `workspace/diff` 的产物）。
 * 约定：worker 把 diff 写进某条 `run_events.payload.diff = { text, truncated, baseSha, headSha }`；
 * 这里取**最近一条**带 `payload.diff` 的事件。没有这样的事件时 `available: false`，`text: null`。
 */
function diffOf(events: readonly RunEventRecord[], headSha: string | null): TaskDiff {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    const diff = recordOf(event.payload.diff);
    const text = typeof diff.text === 'string' && diff.text !== '' ? diff.text : null;
    if (text === null) continue;
    const baseSha = typeof diff.baseSha === 'string' && SHA_RE.test(diff.baseSha) ? diff.baseSha : null;
    const eventHead = typeof diff.headSha === 'string' && SHA_RE.test(diff.headSha) ? diff.headSha : headSha;
    return { available: true, text, truncated: diff.truncated === true, baseSha, headSha: eventHead };
  }
  return { available: false, text: null, truncated: false, baseSha: null, headSha };
}

/** 详情查询；任务不存在时返回 `null`（http 层据此回 404，不在查询层抛）。 */
export async function queryTaskDetail(runner: SqlRunner, id: string): Promise<TaskDetailResponse | null> {
  const taskParams = new Params();
  const taskCteSql = taskCte(taskParams, {});
  const taskIdParam = taskParams.add(id);
  const taskRows = (
    await runner.query(`${taskCteSql}\nselect * from base where id = ${taskIdParam} limit 1`, taskParams.list())
  ).rows as TaskRow[];
  const taskRow = taskRows[0];
  if (taskRow === undefined) return null;
  const task = toTaskListItem(taskRow);

  const runRows = (
    await runner.query(
      `select
         r.id, r.attempt, r.session_id, r.turn_id, r.started_at, r.ended_at,
         ${sqlOutcome('r.outcome')} as outcome,
         ${sqlFailureClass('r.failure_class')} as failure_class,
         r.failure_detail
       from runs r
       where r.task_id = $1
       order by r.attempt asc, r.started_at asc, r.id asc
       limit ${DETAIL_RUNS_LIMIT}`,
      [id],
    )
  ).rows as RunRow[];

  const eventRows = (
    await runner.query(
      `select tail.run_id, tail.cursor, tail.kind, tail.created_at, tail.payload
       from (
         select e.id, e.run_id, e.cursor, ${sqlRunEventKind('e.kind')} as kind, e.created_at, e.payload
         from run_events e
         join runs r on r.id = e.run_id
         where r.task_id = $1
         order by e.created_at desc, e.id desc
         limit ${DETAIL_EVENTS_LIMIT}
       ) tail
       order by tail.created_at asc, tail.cursor asc`,
      [id],
    )
  ).rows as EventRow[];

  const envelopeRows = (
    await runner.query(
      `select e.run_id, e.valid, e.verdict, e.actions, e.usage
       from envelopes e
       join runs r on r.id = e.run_id
       where r.task_id = $1
       order by r.attempt asc, e.id asc
       limit ${DETAIL_RUNS_LIMIT}`,
      [id],
    )
  ).rows as EnvelopeRow[];

  const actionRows = (
    await runner.query(
      `select
         a.id, a.run_id, a.intent, a.target, a.external_ref, a.applied_at, a.reverted_at,
         ${sqlRevertKind('a.revert_kind')} as revert_kind,
         a.audit,
         ${sqlActionStatus('a')} as status,
         a.created_at
       from actions a
       join runs r on r.id = a.run_id
       where r.task_id = $1
         and a.intent in ${ACTION_INTENTS_SQL}
       order by a.id asc
       limit ${DETAIL_ACTIONS_LIMIT}`,
      [id],
    )
  ).rows as ActionRow[];

  const events = eventRows.map(toRunEvent);
  return {
    task,
    runs: runRows.map(toRunSummary),
    events,
    envelopes: envelopeRows.map(toEnvelopeRecord),
    actions: actionRows.map((row) => toActionRecord(row, task.repo, task.targetKind)),
    diff: diffOf(events, task.headSha),
  };
}

/** 供 `quality` / `audit` 复用的 target 解析（`reverts` 的 `url` 与 `audit` 的 `target` 同源）。 */
export function targetOfAction(
  raw: string,
  intent: string,
  repo: string,
  taskTargetKind: string,
  externalRef: string | null,
  appliedAt: string | null,
): ActionRecord['target'] {
  return parseActionTarget(raw, actionTargetKind(intent, taskTargetKind), repo, externalRef, appliedAt);
}
