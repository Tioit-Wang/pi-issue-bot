import { http, HttpResponse, type HttpHandler } from 'msw';
import type { AuditResponse, AuditRow } from '../../lib/contract.ts';
import { scenarioResponse } from './shared.ts';

/**
 * 审计（S6）的拦截器 —— W3-K 只改这一个文件。
 *
 * 契约：`GET /api/audit`（`AuditResponse`）+ `GET /api/audit/export.csv`（docs/spec/contract-api.md §6/§7）。
 *
 * 四个关键点（都是契约里写死、页面不能自己补的）：
 *  1. **行内四件事**：谁触发（`actor.login` / `actor.association`）、跑哪个 sha（`headSha`）、
 *     写了什么（`intent` + `target`）、审批判定（`approval.decision` / `rule`）。
 *  2. **CSV 列顺序**固定为 `AUDIT_CSV_COLUMNS`（21 列），UTF-8 **带 BOM**、CRLF 换行、
 *     空值写空串、含 `,` `"` 换行的字段按 RFC 4180 加引号并把 `"` 翻倍。Excel 打开不乱码靠 BOM。
 *  3. **截断**：命中行数超过 `AUDIT_EXPORT_LIMIT`（50000）时只导前 50000 行，并在响应头
 *     `X-Pi-Bot-Truncated: true` 标出，绝不静默丢数据。
 *  4. 数据集锚在**请求时刻**（每 3 小时一条、共 120 条 ≈ 15 天），这样「时间范围」筛选才有东西可筛。
 *
 * 预览截断提示（数据量到不了 50000，用一个 mock 专用的页面参数）：
 *   - 列表横幅：`http://localhost:5173/audit?mockTruncated=1`
 *   - 导出横幅：测试里覆写 export 处理器并带上 `x-pi-bot-truncated: true`（见 audit.test.tsx）
 */

const HOUR_MS = 3_600_000;

/** 契约 §6：`exportLimit` = `AUDIT_EXPORT_LIMIT` = 50000。 */
export const AUDIT_EXPORT_LIMIT = 50_000;

/** CSV 列顺序：**契约 §7 逐字**，改这里等于改契约。 */
export const AUDIT_CSV_COLUMNS = [
  'id',
  'at',
  'repo',
  'task_id',
  'run_id',
  'actor_login',
  'actor_association',
  'command',
  'target_kind',
  'target_number',
  'target_ref',
  'intent',
  'status',
  'head_sha',
  'external_ref',
  'approval_tool',
  'approval_decision',
  'approval_rule',
  'reverted_at',
  'revert_kind',
  'dry_run',
] as const;

const DATASET_SIZE = 120;
const STEP_MS = 3 * HOUR_MS;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const CURSOR_PREFIX = 'o:';

const REPOS = ['acme/widgets', 'other/lib'] as const;
const COMMANDS = ['/review-pr', 'auto:triage', 'auto:compliance'] as const;
const INTENTS: readonly AuditRow['intent'][] = ['comment', 'label', 'create_issue', 'push_branch', 'close_issue'];
const STATUSES: readonly AuditRow['status'][] = ['applied', 'dry-run', 'skipped', 'rejected', 'failed'];
const ACTORS = ['alice', 'bob', 'carol', 'dana'] as const;
const ASSOCIATIONS: readonly NonNullable<AuditRow['actor']['association']>[] = [
  'MEMBER',
  'OWNER',
  'CONTRIBUTOR',
  'NONE',
];
const APPROVAL_TOOLS = ['Bash', 'Edit', 'Write', 'WebFetch'] as const;
const REVERT_KINDS: readonly NonNullable<AuditRow['revertKind']>[] = [
  'label-removed',
  'changes-requested',
  'pr-closed',
  'comment-deleted',
  'revert-commit',
];

/** 取模取值：`noUncheckedIndexedAccess` 下索引访问是 `T | undefined`，这里收敛成 `T`。 */
function pick<T>(list: readonly T[], index: number): T {
  const value = list[index % list.length];
  if (value === undefined) throw new Error('mock 列表不应为空');
  return value;
}

function pseudoSha(index: number): string {
  const head = (index * 1_103_515_245).toString(16).padStart(8, '0');
  const tail = (index * 12_345).toString(16).padStart(4, '0');
  return `${head}${tail}`.slice(0, 12);
}

function targetFor(intent: AuditRow['intent'], index: number): AuditRow['target'] {
  const number = 10 + index;
  switch (intent) {
    case 'comment':
      return { kind: 'comment', number, ref: null };
    case 'push_branch':
      return { kind: 'branch', number: null, ref: `pi-bot/task-${String(index + 1)}` };
    case 'label':
      return { kind: 'pr', number, ref: null };
    case 'create_issue':
    case 'close_issue':
    case 'reaction.add':
    case 'reaction.remove':
      return { kind: 'issue', number, ref: null };
  }
}

function buildRow(index: number, now: number): AuditRow {
  const intent = pick(INTENTS, index);
  const status = index % 9 === 8 ? pick(STATUSES, index + 1) : 'applied';
  const command = pick(COMMANDS, index);
  // `close_issue` 可能来自 cron：那时没有触发人、也没有 run
  const fromCron = command === 'auto:compliance' && intent === 'close_issue';
  const reverted = status === 'applied' && index % 11 === 5;

  return {
    id: String(index + 1),
    at: new Date(now - index * STEP_MS).toISOString(),
    repo: pick(REPOS, index),
    taskId: `t-mock-${String(index + 1)}`,
    runId: fromCron ? null : `r-mock-${String(index + 1)}`,
    actor: {
      login: fromCron ? null : pick(ACTORS, index),
      association: fromCron ? null : pick(ASSOCIATIONS, index),
    },
    command,
    target: targetFor(intent, index),
    intent,
    status,
    headSha: intent === 'create_issue' ? null : pseudoSha(index),
    externalRef: intent === 'comment' && status === 'applied' ? String(9_000 + index) : null,
    approval:
      index % 4 === 0
        ? { tool: pick(APPROVAL_TOOLS, index), decision: index % 8 === 0 ? 'deny' : 'allow', rule: index % 8 === 0 ? 'deny-network' : 'allow-tests' }
        : null,
    revertedAt: reverted ? new Date(now - index * STEP_MS + 2 * HOUR_MS).toISOString() : null,
    revertKind: reverted ? pick(REVERT_KINDS, index) : null,
    dryRun: status === 'dry-run' || index % 13 === 12,
  };
}

/** 完整数据集（按时间倒序）。导出给测试复用，页面不要 import 它。 */
export function buildAuditDataset(now: number = Date.now()): AuditRow[] {
  return Array.from({ length: DATASET_SIZE }, (_, index) => buildRow(index, now));
}

function readLimit(raw: string | null): number {
  if (raw === null || raw === '') return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new RangeError(`limit 必须是 1–${String(MAX_LIMIT)} 的整数`);
  }
  return value;
}

function readCursor(raw: string | null): number {
  if (raw === null || raw === '') return 0;
  const offset = raw.startsWith(CURSOR_PREFIX) ? Number(raw.slice(CURSOR_PREFIX.length)) : Number.NaN;
  if (!Number.isInteger(offset) || offset < 0) throw new RangeError('cursor 不合法');
  return offset;
}

function filterRows(rows: readonly AuditRow[], params: URLSearchParams): AuditRow[] {
  const repo = params.get('repo');
  const command = params.get('command');
  const intent = params.get('intent');
  const from = params.get('from');
  const to = params.get('to');
  const fromMs = from === null || from === '' ? null : Date.parse(from);
  const toMs = to === null || to === '' ? null : Date.parse(to);

  return rows.filter((row) => {
    if (repo !== null && repo !== '' && row.repo !== repo) return false;
    if (command !== null && command !== '' && row.command !== command) return false;
    if (intent !== null && intent !== '' && row.intent !== intent) return false;
    const at = Date.parse(row.at);
    if (fromMs !== null && !Number.isNaN(fromMs) && at < fromMs) return false;
    if (toMs !== null && !Number.isNaN(toMs) && at > toMs) return false;
    return true;
  });
}

/** 列表页的截断横幅只能靠 `?mockTruncated=1` 预览（数据量到不了 50000，见文件头）。 */
function wantsTruncatedPreview(): boolean {
  return new URLSearchParams(globalThis.location?.search ?? '').get('mockTruncated') === '1';
}

/** 纯函数：查询串 → `AuditResponse`（handler 与测试共用同一份实现）。 */
export function buildAuditResponse(search: string, now: number = Date.now()): AuditResponse {
  const params = new URLSearchParams(search);
  const filtered = filterRows(buildAuditDataset(now), params);
  const offset = readCursor(params.get('cursor'));
  const limit = readLimit(params.get('limit'));
  const items = filtered.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  const hasMore = nextOffset < filtered.length;

  return {
    items,
    nextCursor: hasMore ? `${CURSOR_PREFIX}${String(nextOffset)}` : null,
    hasMore,
    truncated: wantsTruncatedPreview() || filtered.length > AUDIT_EXPORT_LIMIT,
    exportLimit: AUDIT_EXPORT_LIMIT,
  };
}

/** `?mock=empty` 用的空响应。 */
export function buildEmptyAuditResponse(): AuditResponse {
  return { items: [], nextCursor: null, hasMore: false, truncated: false, exportLimit: AUDIT_EXPORT_LIMIT };
}

/** 一个 CSV 字段：空值写空串，含 `,` `"` CR LF 的按 RFC 4180 加引号并把 `"` 翻倍。 */
function csvField(value: string | number | boolean | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvRow(row: AuditRow): string {
  const fields: Array<string | number | boolean | null> = [
    row.id,
    row.at,
    row.repo,
    row.taskId,
    row.runId,
    row.actor.login,
    row.actor.association,
    row.command,
    row.target.kind,
    row.target.number,
    row.target.ref,
    row.intent,
    row.status,
    row.headSha,
    row.externalRef,
    row.approval?.tool ?? null,
    row.approval?.decision ?? null,
    row.approval?.rule ?? null,
    row.revertedAt,
    row.revertKind,
    row.dryRun,
  ];
  return fields.map(csvField).join(',');
}

/** `YYYY-MM-DD`（文件名用；面板不做时区换算，与 `lib/format.ts` 的口径一致）。 */
function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

/** 纯函数：查询串 → CSV 文本 + 文件名 + 行数（handler 与测试共用）。 */
export function buildAuditCsv(
  search: string,
  now: number = Date.now(),
): { csv: string; filename: string; rows: number; truncated: boolean } {
  const params = new URLSearchParams(search);
  const filtered = filterRows(buildAuditDataset(now), params);
  const exported = filtered.slice(0, AUDIT_EXPORT_LIMIT);
  const truncated = filtered.length > AUDIT_EXPORT_LIMIT;

  const from = params.get('from');
  const to = params.get('to');
  const fromDate = dateOnly(from === null || from === '' ? new Date(exported.at(-1)?.at ?? now).toISOString() : from);
  const toDate = dateOnly(to === null || to === '' ? new Date(now).toISOString() : to);

  const lines = [AUDIT_CSV_COLUMNS.join(','), ...exported.map(csvRow)];
  // BOM：Excel 双击打开中文不乱码的唯一办法（契约 §7）
  const csv = `\uFEFF${lines.join('\r\n')}\r\n`;
  return { csv, filename: `audit-${fromDate}-${toDate}.csv`, rows: exported.length, truncated };
}

export const auditHandlers: HttpHandler[] = [
  http.get('/api/audit', ({ request }) => {
    const search = new URL(request.url).search;
    let data: AuditResponse;
    try {
      data = buildAuditResponse(search);
    } catch (error) {
      if (error instanceof RangeError) {
        return HttpResponse.json({ error: { code: 'bad-request', message: error.message } }, { status: 400 });
      }
      throw error;
    }
    return scenarioResponse({ data, empty: buildEmptyAuditResponse() });
  }),

  http.get('/api/audit/export.csv', ({ request }) => {
    const { csv, filename, rows, truncated } = buildAuditCsv(new URL(request.url).search);
    return new HttpResponse(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
        'x-pi-bot-truncated': String(truncated),
        // 便于人工核对：行数很多时 curl 也能直接看出来
        'x-pi-bot-rows': String(rows),
      },
    });
  }),
];
