/**
 * 审计（`/api/audit`，每 15s 轮询；导出走 `/api/audit/export.csv`）。
 *
 * 两种读法，一个开关：
 *  - **时间轴**（默认）：按分钟聚簇，先看「什么时候集中出了什么事」，展开看行；
 *  - **表格**：一行一条，扫只读字段（sha、审批规则）更快。
 *
 * 一行回答四件事：谁触发（actor + association）、跑哪个 sha、写了什么（intent + target）、
 * 结果与审批（status / approval）。所以行内既有 intent 的 tone，也有 status 的 tone，且状态不只靠颜色
 * （徽章带文字）。目标链接只在能确定 URL 时才给（issue / PR 编号、分支名），其余如实不给。
 */
import createClient from 'openapi-fetch';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { AsyncSection, describeError } from '../components/AsyncSection.tsx';
import { Section } from '../components/Section.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Toolbar } from '../components/Toolbar.tsx';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { statusTone } from '../components/ui/status.ts';
import { Button } from '../components/ui/button.tsx';
import { Segmented } from '../components/ui/segmented.tsx';
import { Select } from '../components/ui/select.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.tsx';
import { RepoFilterSelect } from '../components/repo-filter.tsx';
import { ApiError } from '../lib/api.ts';
import type { ApiErrorBody, AuditQuery, AuditRow } from '../lib/contract.ts';
import { formatCount, formatTimeCell } from '../lib/format.ts';
import { useAudit } from '../lib/queries.ts';
import { repoGitHubUrl } from '../lib/repo-route.ts';
import { cn } from '../lib/utils.ts';

/** 每页条数（契约默认 50、上限 200）。审计页只取第一页，聚合看导出。 */
const PAGE_SIZE = 100;
const AUDIT_EXPORT_LIMIT = 50_000;

const INTENT_LABEL: Record<AuditRow['intent'], string> = {
  comment: '评论',
  label: '标签',
  create_issue: '建 issue',
  push_branch: '推分支',
  close_issue: '关闭 issue',
};

/** 会改仓库的写动作给 warn，只读的给 info：一眼分出「这条动没动东西」。 */
const INTENT_TONE: Record<AuditRow['intent'], 'warn' | 'info'> = {
  comment: 'info',
  label: 'info',
  create_issue: 'warn',
  push_branch: 'warn',
  close_issue: 'warn',
};

const INTENT_OPTIONS = [
  { value: '', label: '全部意图' },
  ...(Object.keys(INTENT_LABEL) as Array<AuditRow['intent']>).map((intent) => ({
    value: intent,
    label: INTENT_LABEL[intent],
  })),
];

const COMMAND_OPTIONS = [
  { value: '', label: '全部命令' },
  { value: '/review-pr', label: '/review-pr' },
  { value: 'auto:triage', label: 'auto:triage' },
  { value: 'auto:compliance', label: 'auto:compliance' },
];

const RANGE_OPTIONS = [
  { value: '', label: '全部时间' },
  { value: '24h', label: '最近 24 小时' },
  { value: '7d', label: '最近 7 天' },
  { value: '30d', label: '最近 30 天' },
];

const RANGE_WINDOW_MS: Record<string, number> = { '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000 };

type ExportState =
  | { tone: 'ok'; rows: number; filename: string }
  | { tone: 'truncated'; rows: number; filename: string; limit: number }
  | { tone: 'error'; message: string };

function filenameFromDisposition(header: string | null): string | null {
  if (header === null) return null;
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  const value = match?.[1];
  return value === undefined || value === '' ? null : decodeURIComponent(value);
}

function countCsvRows(text: string): number {
  const lines = text.split(/\r?\n/).filter((line) => line !== '');
  return Math.max(0, lines.length - 1);
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * 导出通道：`openapi-fetch`（`lib/api.ts` 是 P0 冻结文件，只有 JSON 的 `request<T>`；CSV 要 blob + 响应头）。
 * 生成类型修好后把 `AuditExportPaths` 换成生成类型即可，调用处一行不用改。
 */
type AuditExportPaths = {
  '/api/audit/export.csv': {
    get: {
      parameters: { query?: AuditQuery };
      responses: {
        200: {
          headers: { 'content-disposition'?: string; 'x-pi-bot-truncated'?: string };
          content: { 'text/csv': Blob };
        };
      };
    };
  };
};

const PANEL_ORIGIN = globalThis.location?.origin ?? '';

const csvClient = createClient<AuditExportPaths>({
  baseUrl: PANEL_ORIGIN,
  credentials: 'same-origin',
  headers: { accept: 'text/csv' },
});

async function fetchAuditCsv(
  query: AuditQuery,
): Promise<{ blob: Blob; filename: string; rows: number; truncated: boolean }> {
  const { data, error, response } = await csvClient.GET('/api/audit/export.csv', {
    params: { query },
    parseAs: 'blob',
  });

  if (!response.ok) {
    const body = error as ApiErrorBody | undefined;
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'internal',
      body?.error?.message ?? `导出失败（HTTP ${String(response.status)}）`,
    );
  }
  if (data === undefined) throw new ApiError(response.status, 'internal', '导出响应为空（服务端未返回 CSV）');

  const filename = filenameFromDisposition(response.headers.get('content-disposition')) ?? 'audit.csv';
  const rows = countCsvRows(await data.text());
  return { blob: data, filename, rows, truncated: response.headers.get('x-pi-bot-truncated') === 'true' };
}

/** 目标对象能拼出 URL 才给链接，拼不出来就是纯文本（不猜）。 */
function targetUrl(row: AuditRow): string | null {
  const base = repoGitHubUrl(row.repo);
  if (base === null) return null;
  if (row.target.kind === 'branch') return row.target.ref === null ? null : `${base}/tree/${encodeURIComponent(row.target.ref)}`;
  if (row.target.number === null) return null;
  if (row.target.kind === 'issue') return `${base}/issues/${String(row.target.number)}`;
  if (row.target.kind === 'pr') return `${base}/pull/${String(row.target.number)}`;
  return null;
}

/** 分钟桶键：`2026-06-01T11:58`（UTC，契约时间一律 UTC）。 */
function minuteOf(iso: string): string {
  return iso.slice(0, 16);
}

type Cluster = { minute: string; rows: AuditRow[] };

function clusterByMinute(rows: readonly AuditRow[]): Cluster[] {
  const clusters: Cluster[] = [];
  for (const row of rows) {
    const minute = minuteOf(row.at);
    const last = clusters.at(-1);
    if (last !== undefined && last.minute === minute) last.rows.push(row);
    else clusters.push({ minute, rows: [row] });
  }
  return clusters;
}

export function AuditPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const repo = searchParams.get('repo') ?? '';
  const command = searchParams.get('command') ?? '';
  const intent = searchParams.get('intent') ?? '';
  const range = searchParams.get('range') ?? '';
  const view = searchParams.get('view') === 'table' ? 'table' : 'timeline';
  const [exportState, setExportState] = useState<ExportState | null>(null);
  const [exporting, setExporting] = useState(false);

  const query = useMemo<AuditQuery>(() => {
    const now = Date.now();
    const windowMs = range === '' ? null : (RANGE_WINDOW_MS[range] ?? null);
    return {
      limit: PAGE_SIZE,
      ...(repo === '' ? {} : { repo }),
      ...(command === '' ? {} : { command }),
      ...(intent === '' ? {} : { intent: intent as AuditRow['intent'] }),
      ...(windowMs === null ? {} : { from: new Date(now - windowMs).toISOString(), to: new Date(now).toISOString() }),
    };
  }, [repo, command, intent, range]);

  const { data, error, isLoading } = useAudit(query);
  const items = data?.items ?? [];
  const exportLimit = data?.exportLimit ?? AUDIT_EXPORT_LIMIT;
  const anyFilter = repo !== '' || command !== '' || intent !== '' || range !== '';

  const setParam = (key: string, value: string): void => {
    const next = new URLSearchParams(searchParams);
    if (value === '') next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  const clearFilters = (): void => {
    const next = new URLSearchParams(searchParams);
    for (const key of ['repo', 'command', 'intent', 'range']) next.delete(key);
    setSearchParams(next, { replace: true });
    setExportState(null);
  };

  const runExport = async (): Promise<void> => {
    setExporting(true);
    setExportState(null);
    try {
      const result = await fetchAuditCsv(query);
      saveBlob(result.blob, result.filename);
      setExportState(
        result.truncated
          ? { tone: 'truncated', rows: result.rows, filename: result.filename, limit: exportLimit }
          : { tone: 'ok', rows: result.rows, filename: result.filename },
      );
    } catch (caught) {
      setExportState({ tone: 'error', message: describeError(caught) });
    } finally {
      setExporting(false);
    }
  };

  const clusters = clusterByMinute(items);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader
        title="审计"
        actions={
          <div className="flex items-center gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              data-testid="audit-export"
              loading={exporting}
              onClick={() => {
                void runExport();
              }}
              title={`导出当前筛选下的 CSV（单次上限 ${formatCount(exportLimit)} 行）`}
            >
              导出 CSV
            </Button>
            <Button variant="ghost" size="sm" data-testid="audit-clear" disabled={!anyFilter} onClick={clearFilters}>
              清除筛选
            </Button>
          </div>
        }
      />

      <Toolbar
        meta={`本页 ${formatCount(items.length)} 条${data?.hasMore === true ? '（还有更多）' : ''}`}
      >
        <span className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="audit-filters">
          <RepoFilterSelect testId="audit-repo-filter" />
          <Select
            aria-label="命令筛选"
            options={COMMAND_OPTIONS}
            placeholder={null}
            value={command}
            onChange={(event) => {
              setParam('command', event.target.value);
            }}
          />
          <Select
            aria-label="意图筛选"
            options={INTENT_OPTIONS}
            placeholder={null}
            value={intent}
            onChange={(event) => {
              setParam('intent', event.target.value);
            }}
          />
          <Select
            aria-label="时间范围筛选"
            options={RANGE_OPTIONS}
            placeholder={null}
            value={range}
            onChange={(event) => {
              setParam('range', event.target.value);
            }}
          />
          <Segmented
            label="读法"
            value={view}
            onChange={(next) => {
              setParam('view', next === 'timeline' ? '' : next);
            }}
            options={[
              { value: 'timeline', label: '时间轴' },
              { value: 'table', label: '表格' },
            ]}
          />
        </span>
      </Toolbar>

      {exportState === null ? null : exportState.tone === 'ok' ? (
        <p className="text-xs text-success-fg" role="status" data-testid="audit-export-status">
          已导出 {formatCount(exportState.rows)} 行 → {exportState.filename}
        </p>
      ) : exportState.tone === 'truncated' ? (
        <Alert tone="warn" data-testid="audit-export-status">
          <AlertTitle>只导出了前 {formatCount(exportState.limit)} 行（命中行数超过导出上限）</AlertTitle>
          <AlertDescription>
            文件 {exportState.filename} 共 {formatCount(exportState.rows)} 行；请缩小时间范围或加筛选后再导出，超出的部分不会出现在文件里。
          </AlertDescription>
        </Alert>
      ) : (
        <Alert tone="danger" data-testid="audit-export-status">
          <AlertTitle>导出失败</AlertTitle>
          <AlertDescription>{exportState.message}</AlertDescription>
        </Alert>
      )}

      <AsyncSection
        isLoading={isLoading}
        error={error}
        isEmpty={data !== undefined && items.length === 0}
        emptyText="窗口内没有审计记录"
        emptyHint="换个时间范围，或清除筛选看看全部。"
        testId="audit"
        skeletonRows={8}
      >
        <div className="flex min-w-0 flex-col gap-4">
          {data?.truncated === true ? (
            <Alert tone="warn" data-testid="audit-truncated">
              <AlertTitle>命中行数超过单次导出上限（{formatCount(exportLimit)} 行）</AlertTitle>
              <AlertDescription>
                列表只显示最近的一页；导出也会被截断在前 {formatCount(exportLimit)} 行。请缩小时间范围或加筛选条件后再导出。
              </AlertDescription>
            </Alert>
          ) : null}

          {view === 'timeline' ? (
            <Section first title="时间轴">
              <ol className="flex min-w-0 flex-col gap-1" data-testid="audit-timeline">
                {clusters.map((cluster, index) => (
                  <ClusterRow key={cluster.minute} cluster={cluster} defaultOpen={index === 0} />
                ))}
              </ol>
            </Section>
          ) : (
            <Section first title="表格">
              <Table stickyFirst>
                <TableHeader>
                  <TableRow>
                    <TableHead>时间</TableHead>
                    <TableHead>触发人</TableHead>
                    <TableHead>仓库</TableHead>
                    <TableHead>命令</TableHead>
                    <TableHead>提交 sha</TableHead>
                    <TableHead>写了什么</TableHead>
                    <TableHead>结果</TableHead>
                    <TableHead>审批判定</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((row) => (
                    <TableRow key={row.id} data-testid={`audit-row-${row.id}`}>
                      <AuditCells row={row} />
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Section>
          )}
        </div>
      </AsyncSection>
    </div>
  );
}

function ClusterRow({ cluster, defaultOpen }: { cluster: Cluster; defaultOpen: boolean }) {
  const failed = cluster.rows.filter((row) => row.status === 'failed' || row.status === 'rejected').length;
  const time = formatTimeCell(`${cluster.minute}:00.000Z`);

  return (
    <li data-testid={`audit-cluster-${cluster.minute}`} className="min-w-0">
      <details open={defaultOpen} className="group min-w-0 rounded-md border border-border bg-card">
        <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 px-2 py-1.5 hover:bg-muted">
          <span aria-hidden className="text-2xs text-faint transition-transform duration-[120ms] ease-out-quint group-open:rotate-90">
            ▸
          </span>
          <time className="tabular shrink-0 font-mono text-xs text-foreground" title={time.title}>
            {cluster.minute.slice(11, 16)}
          </time>
          <span className="shrink-0 text-2xs text-faint">{cluster.minute.slice(0, 10)}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {cluster.rows.length} 条动作
            {failed === 0 ? '' : `，其中 ${String(failed)} 条失败 / 被拒`}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {[...new Set(cluster.rows.map((row) => row.intent))].map((intent) => (
              <Badge key={intent} tone={INTENT_TONE[intent]}>
                {INTENT_LABEL[intent]}
              </Badge>
            ))}
          </span>
        </summary>
        <Table>
          <TableBody>
            {cluster.rows.map((row) => (
              <TableRow key={row.id} data-testid={`audit-row-${row.id}`}>
                <AuditCells row={row} showTime={false} />
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </details>
    </li>
  );
}

/** 一行审计的单元格（时间轴与表格共用同一套渲染，标题列由 `showTime` 决定）。 */
function AuditCells({ row, showTime = true }: { row: AuditRow; showTime?: boolean }) {
  const at = formatTimeCell(row.at);
  const url = targetUrl(row);
  const target =
    row.target.kind === 'branch'
      ? (row.target.ref ?? '—')
      : row.target.number === null
        ? '—'
        : `${row.target.kind} #${formatCount(row.target.number)}`;

  return (
    <>
      <TableCell className={cn('whitespace-nowrap text-xs', showTime ? 'text-foreground' : 'px-1 text-faint')}>
        {showTime ? (
          <time title={at.title}>{at.text}</time>
        ) : (
          <time title={at.title} className="tabular font-mono">
            {row.at.slice(11, 19)}
          </time>
        )}
      </TableCell>
      <TableCell className="text-xs">
        {row.actor.login === null ? (
          <span className="text-muted-foreground">—（cron）</span>
        ) : (
          <span className="flex items-center gap-1">
            <span className="font-mono">{row.actor.login}</span>
            {row.actor.association === null ? null : <Badge tone="neutral">{row.actor.association}</Badge>}
          </span>
        )}
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">{row.repo}</TableCell>
      <TableCell className="font-mono text-xs">{row.command}</TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">
        {row.headSha === null ? '—' : <span title={row.headSha}>{row.headSha.slice(0, 10)}</span>}
      </TableCell>
      <TableCell className="text-xs">
        <span className="flex items-center gap-1">
          <Badge tone={INTENT_TONE[row.intent]}>{INTENT_LABEL[row.intent]}</Badge>
          {url === null ? (
            <span className="font-mono text-2xs text-muted-foreground">{target}</span>
          ) : (
            <a
              href={url}
              target="_blank"
              rel="noreferrer noopener"
              className="font-mono text-2xs text-brand underline underline-offset-2"
              title={url}
            >
              {target}
            </a>
          )}
        </span>
      </TableCell>
      <TableCell className="text-xs">
        <span className="flex items-center gap-1">
          <Badge tone={statusTone(row.status)}>{row.status}</Badge>
          {row.dryRun ? <Badge tone="warn">dry-run</Badge> : null}
        </span>
      </TableCell>
      <TableCell className="text-xs">
        {row.approval === null ? (
          <span className="text-faint">—</span>
        ) : (
          <span className="flex items-center gap-1">
            <Badge tone={row.approval.decision === 'allow' ? 'success' : 'danger'}>
              {row.approval.tool} · {row.approval.decision}
            </Badge>
            <span className="font-mono text-2xs text-muted-foreground">{row.approval.rule}</span>
          </span>
        )}
      </TableCell>
    </>
  );
}