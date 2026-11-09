/**
 * `GET /api/audit` + `GET /api/audit/export.csv` —— 谁触发、跑哪个 sha、写了什么、审批判定。
 *
 * 口径与已知缺口：
 * - **谁触发**：`tasks.actor_login`（§7.2 三列之一，入队时写死；F9 明令不解 jsonb）。
 *   `actor.association` 目前**恒为 `null`**：入队时没有把 `author_association` 落到任何列里，
 *   唯一来源是 `webhook_deliveries.payload`，而在查询期解 payload 正是 F9 禁止的做法。
 *   记录为缺口，等入队侧加列（`tasks.actor_association`）后本文件改一行即可。
 * - **跑哪个 sha**：`tasks.head_sha`；issue 判定类没有提交可锚时为 `null`。
 * - **审批判定**：取该 run **最后一条** `kind='approval'` 事件的 `payload{tool,decision,rule}`
 *   （`approval/respond` 的落库约定）；没有审批事件、或形状不完整时为 `null`。
 * - **`truncated`**：命中行数超过 `AUDIT_EXPORT_LIMIT`（50 000，契约常量）时为 true。
 * - CSV 用 `AUDIT_CSV_COLUMNS` 的**顺序**做表头，UTF-8 **带 BOM**，空值写空串（RFC 4180）。
 *
 * 分页：`at`（= `actions.created_at`）倒序 + `actions.id` 倒序的 keyset；游标语义见 `sql.ts`。
 */
import { AUDIT_CSV_COLUMNS, AUDIT_EXPORT_LIMIT } from '../../../../packages/contract/src/index.ts';
import {
  ACTION_INTENTS_SQL,
  Params,
  decodeCursor,
  encodeCursor,
  intOf,
  isoOf,
  isoOrNull,
  recordOf,
  sqlActionStatus,
  sqlRevertKind,
  stringOrNull,
  type SqlRunner,
} from './sql.ts';
import { targetOfAction } from './tasks.ts';
import type { AuditQuery, AuditResponse, AuditRow } from './types.ts';

type AuditRowRaw = {
  id: number | string;
  run_id: string;
  created_at: Date;
  intent: string;
  target: string;
  external_ref: string | null;
  reverted_at: Date | null;
  revert_kind: string | null;
  status: string;
  dry_run: boolean;
  task_id: string;
  repo: string;
  command: string;
  target_kind: string;
  head_sha: string | null;
  actor_login: string | null;
  approval_payload: unknown;
};

/** 审计行与导出共用的 select（一份 SQL，两个出口，列不会漂移）。 */
function auditSelect(params: Params, query: AuditQuery, window: { from: string; to: string }): string {
  const where = [
    `a.intent in ${ACTION_INTENTS_SQL}`,
    `a.created_at >= ${params.add(window.from, 'timestamptz')}`,
    `a.created_at < ${params.add(window.to, 'timestamptz')}`,
  ];
  if (query.repo !== undefined) {
    where.push(`t.repo = ${params.add(query.repo)}`);
  }
  if (query.command !== undefined) {
    where.push(`t.command = ${params.add(query.command)}`);
  }
  if (query.intent !== undefined) {
    where.push(`a.intent = ${params.add(query.intent)}`);
  }

  return `from actions a
  join runs r on r.id = a.run_id
  join tasks t on t.id = r.task_id
  left join lateral (
    select e.payload
    from run_events e
    where e.run_id = a.run_id and e.kind = 'approval'
    order by e.cursor desc
    limit 1
  ) appr on true
  where ${where.join('\n    and ')}`;
}

const AUDIT_COLUMNS = `select
  a.id,
  a.run_id,
  a.created_at,
  a.intent,
  a.target,
  a.external_ref,
  a.reverted_at,
  ${sqlRevertKind('a.revert_kind')} as revert_kind,
  ${sqlActionStatus('a')} as status,
  coalesce(a.audit ->> 'dryRun' in ('true', '1'), false) as dry_run,
  t.id as task_id,
  t.repo,
  t.command,
  t.target_kind,
  t.head_sha,
  t.actor_login,
  appr.payload as approval_payload`;

function approvalOf(raw: unknown): AuditRow['approval'] {
  const record = recordOf(raw);
  const tool = typeof record.tool === 'string' ? record.tool.slice(0, 64) : '';
  const decision = record.decision === 'allow' || record.decision === 'deny' ? record.decision : null;
  const rule = typeof record.rule === 'string' ? record.rule.slice(0, 120) : '';
  if (tool === '' || decision === null || rule === '') return null;
  return { tool, decision, rule };
}

function toAuditRow(row: AuditRowRaw): AuditRow {
  const at = isoOf(row.created_at, new Date(0).toISOString());
  const externalRef = stringOrNull(row.external_ref, 200);
  // url 不在契约的 AuditRow 里，这里只借结构化解析的 kind/number/ref（appliedAt 传 null 不拼链接）
  const target = targetOfAction(row.target, row.intent, row.repo, row.target_kind, externalRef, null);
  return {
    id: String(row.id),
    at,
    repo: row.repo,
    taskId: row.task_id,
    runId: row.run_id,
    actor: { login: row.actor_login, association: null },
    command: row.command,
    target: { kind: target.kind, number: target.number, ref: target.ref },
    intent: row.intent as AuditRow['intent'],
    status: row.status as AuditRow['status'],
    headSha: row.head_sha,
    externalRef,
    approval: approvalOf(row.approval_payload),
    revertedAt: isoOrNull(row.reverted_at),
    revertKind: (row.revert_kind ?? null) as AuditRow['revertKind'],
    dryRun: row.dry_run === true,
  };
}

async function fetchAuditRows(
  runner: SqlRunner,
  query: AuditQuery,
  window: { from: string; to: string },
  options: { limit: number; paginated: boolean },
): Promise<{ rows: AuditRowRaw[]; hasMore: boolean }> {
  const params = new Params();
  const cursor = options.paginated ? decodeCursor(query.cursor) : null;
  // 游标参数先入队（占位符按返回的 $n 用，顺序本身不影响正确性）
  const cursorSql =
    cursor === null
      ? ''
      : `\n    and (a.created_at < ${params.add(cursor.at, 'timestamptz')}` +
        ` or (a.created_at = ${params.add(cursor.at, 'timestamptz')} and a.id < ${params.add(cursor.id, 'bigint')}))`;
  const from = auditSelect(params, query, window);
  const rows = (
    await runner.query(
      `${AUDIT_COLUMNS}
  ${from}${cursorSql}
  order by a.created_at desc, a.id desc
  limit ${params.add(options.limit + 1, 'int')}`,
      params.list(),
    )
  ).rows as AuditRowRaw[];
  return { rows, hasMore: rows.length > options.limit };
}

export async function queryAudit(runner: SqlRunner, now: Date, query: AuditQuery, window: { from: string; to: string }): Promise<AuditResponse> {
  const limit = Math.min(query.limit ?? 50, 200);
  const { rows, hasMore } = await fetchAuditRows(runner, query, window, { limit, paginated: true });
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  // truncated 与分页无关：它说的是「整个命中集是否超过一次性导出的口径」
  const countParams = new Params();
  const countRows = (
    await runner.query(
      `select count(*) as total ${auditSelect(countParams, query, window)}`,
      countParams.list(),
    )
  ).rows as Array<{ total: number | string }>;
  const total = intOf(countRows[0]?.total);

  return {
    items: page.map(toAuditRow),
    nextCursor: hasMore && last !== undefined ? encodeCursor(isoOf(last.created_at, ''), String(last.id)) : null,
    hasMore,
    truncated: total > AUDIT_EXPORT_LIMIT,
    exportLimit: AUDIT_EXPORT_LIMIT,
  };
}

/**
 * CSV 导出。
 *
 * 契约规定截断提示走**响应头** `X-Pi-Bot-Truncated`，而本函数只返回字符串，
 * 所以 http 层应当同时调用 `audit(q)` 拿 `truncated` 再写头（两个函数共用同一份过滤，
 * 不会出现「提示未截断但内容少了」）。行数上限固定 `AUDIT_EXPORT_LIMIT`，`limit` 入参被忽略。
 */
export async function queryAuditCsv(
  runner: SqlRunner,
  query: AuditQuery,
  window: { from: string; to: string },
): Promise<string> {
  const { rows } = await fetchAuditRows(runner, query, window, { limit: AUDIT_EXPORT_LIMIT, paginated: false });
  const sheet = rows.slice(0, AUDIT_EXPORT_LIMIT).map(toAuditRow);
  const lines = [AUDIT_CSV_COLUMNS.join(',')];
  for (const row of sheet) {
    lines.push(AUDIT_CSV_COLUMNS.map((column) => csvCell(csvValueOf(row, column))).join(','));
  }
  // BOM 让 Excel 正确识别 UTF-8（契约要求）
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** 一列的值 → 字符串（空值写空串，布尔写 `true`/`false`）。 */
function csvValueOf(row: AuditRow, column: (typeof AUDIT_CSV_COLUMNS)[number]): string {
  switch (column) {
    case 'id':
      return row.id;
    case 'at':
      return row.at;
    case 'repo':
      return row.repo;
    case 'task_id':
      return row.taskId;
    case 'run_id':
      return row.runId ?? '';
    case 'actor_login':
      return row.actor.login ?? '';
    case 'actor_association':
      return row.actor.association ?? '';
    case 'command':
      return row.command;
    case 'target_kind':
      return row.target.kind;
    case 'target_number':
      return row.target.number === null ? '' : String(row.target.number);
    case 'target_ref':
      return row.target.ref ?? '';
    case 'intent':
      return row.intent;
    case 'status':
      return row.status;
    case 'head_sha':
      return row.headSha ?? '';
    case 'external_ref':
      return row.externalRef ?? '';
    case 'approval_tool':
      return row.approval?.tool ?? '';
    case 'approval_decision':
      return row.approval?.decision ?? '';
    case 'approval_rule':
      return row.approval?.rule ?? '';
    case 'reverted_at':
      return row.revertedAt ?? '';
    case 'revert_kind':
      return row.revertKind ?? '';
    case 'dry_run':
      return row.dryRun ? 'true' : 'false';
    default:
      return '';
  }
}

/** RFC 4180：含逗号、引号、换行的字段加引号，内部 `"` 翻倍。 */
function csvCell(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}
