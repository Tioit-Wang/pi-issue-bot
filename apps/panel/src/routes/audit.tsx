import { createColumnHelper } from '@tanstack/react-table';
import createClient from 'openapi-fetch';
import { useMemo, useState } from 'react';
import { AsyncSection, describeError } from '../components/AsyncSection.tsx';
import { DataTable } from '../components/tables/DataTable.tsx';
import { panelTableFeatures } from '../components/tables/features.ts';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx';
import { Badge, statusVariant } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Select } from '../components/ui/select.tsx';
import { ApiError } from '../lib/api.ts';
import type { ApiErrorBody, AuditQuery, AuditRow } from '../lib/contract.ts';
import { formatCount, formatTimeCell } from '../lib/format.ts';
import { useAudit } from '../lib/queries.ts';
import { PageShell } from './PageShell.tsx';

/**
 * 审计（S6，数据源 `/api/audit`，每 15s 轮询；导出走 `/api/audit/export.csv`，tech-plan §9.3）。
 *
 * 一行回答四个问题：**谁触发**（`actor.login` / `association`）、**跑哪个 sha**（`headSha`）、
 * **写了什么**（`intent` + `target`）、**结果与审批**（`status` / `approval.decision`+`rule`）。
 *
 * 导出（契约 §7）：
 *  - 服务端返回 `text/csv` + `Content-Disposition: attachment; filename="audit-<from>-<to>.csv"`，
 *    **文件名以服务端为准**（前端不猜），UTF-8 带 BOM；
 *  - 命中行数超过 `AUDIT_EXPORT_LIMIT`（50000）时服务端只给前 50000 行并置
 *    `X-Pi-Bot-Truncated: true`——面板必须把这件事说出来，不能静默丢数据；
 *  - 面板只负责取 blob、触发下载、提示结果（不做流式解析：表存在 server 的 pg 里，导出是它的活）。
 *
 * 为什么导出不走 `lib/api.ts`：`api.ts`（P0 冻结）只有 JSON 的 `request<T>`，CSV 需要 blob + 响应头，
 * 所以导出单独走 `openapi-fetch`（见文件下方的 `AuditExportPaths`），页面其余取数仍用 `useAudit`。
 */
const helper = createColumnHelper<typeof panelTableFeatures, AuditRow>();

/** 每页条数（契约默认 50、上限 200）。审计页只取第一页，聚合看导出。 */
const PAGE_SIZE = 100;

/** 契约 §6 的 `AUDIT_EXPORT_LIMIT`：服务端导出的硬上限，拿到响应前用它做兜底文案。 */
const AUDIT_EXPORT_LIMIT = 50_000;

const INTENT_LABEL: Record<AuditRow['intent'], string> = {
  comment: '评论',
  label: '标签',
  create_issue: '建 issue',
  push_branch: '推分支',
  close_issue: '关闭 issue',
};

const INTENT_OPTIONS = [
  { value: '', label: '全部意图' },
  ...(Object.keys(INTENT_LABEL) as Array<AuditRow['intent']>).map((intent) => ({
    value: intent,
    label: INTENT_LABEL[intent],
  })),
];

/** 命令类型：契约 §2 注明的三个取值。 */
const COMMAND_OPTIONS = [
  { value: '', label: '全部命令' },
  { value: '/review-pr', label: '/review-pr' },
  { value: 'auto:triage', label: 'auto:triage' },
  { value: 'auto:compliance', label: 'auto:compliance' },
] as const;

const RANGE_OPTIONS = [
  { value: '', label: '全部时间' },
  { value: '24h', label: '最近 24 小时' },
  { value: '7d', label: '最近 7 天' },
  { value: '30d', label: '最近 30 天' },
] as const;

const RANGE_WINDOW_MS: Record<string, number> = {
  '24h': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
};

/** 导出结果：三种可读终态 + 进行中（`null` = 还没点过）。 */
type ExportState =
  | { tone: 'ok'; rows: number; filename: string }
  | { tone: 'truncated'; rows: number; filename: string; limit: number }
  | { tone: 'error'; message: string };

/** `Content-Disposition: attachment; filename="audit-2026-06-01-2026-06-02.csv"` → 文件名。 */
function filenameFromDisposition(header: string | null): string | null {
  if (header === null) return null;
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  const value = match?.[1];
  return value === undefined || value === '' ? null : decodeURIComponent(value);
}

/**
 * 数据行数（提示用）。
 *
 * 按行切分而不是逐字符解析 RFC 4180：含内嵌换行的字段会让计数偏大，
 * 但这里的数字只用于「导出了多少行」的提示，不是账目；真要看行数以服务端为准（`X-Pi-Bot-Rows`）。
 */
function countCsvRows(text: string): number {
  const lines = text.split(/\r?\n/).filter((line) => line !== '');
  return Math.max(0, lines.length - 1);
}

/** 触发下载：`<a download>` + object URL（不新开窗口，不污染历史）。 */
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
 * 导出通道：`openapi-fetch`（tech-plan §9.3 指定用它拿 blob）。
 *
 * 为什么在页面里声明一个「最小 paths」而不是用生成类型：`openapi/pi-bot.openapi.json`
 * 当前生成不出类型（11 个自指 `$ref`，见 `lib/contract.ts` 文件头），而 `lib/api.ts` 是 P0 冻结文件。
 * 这里**只声明要用到的那一个 GET**（查询参数直接复用 contract 的 `AuditQuery`，响应体不解析任何 DTO），
 * 等 `gen:openapi` 修好后，把 `AuditExportPaths` 换成生成类型即可，调用处一行不用改。
 */
type AuditExportPaths = {
  '/api/audit/export.csv': {
    get: {
      parameters: { query?: AuditQuery };
      responses: {
        200: {
          headers: {
            'content-disposition'?: string;
            'x-pi-bot-truncated'?: string;
          };
          content: { 'text/csv': Blob };
        };
      };
    };
  };
};

/**
 * 面板与 `/api/*` 永远同站：`baseUrl` 取当前 origin。
 * 这样 `openapi-fetch` 交给 `fetch` 的是**绝对 URL**（相对 URL 在 Node/undici 下会被拒绝解析），
 * 同时又保持同源（cookie `sid` 由 `credentials: 'same-origin'` 带上）。
 */
const PANEL_ORIGIN = globalThis.location?.origin ?? '';

const csvClient = createClient<AuditExportPaths>({
  baseUrl: PANEL_ORIGIN,
  credentials: 'same-origin',
  headers: { accept: 'text/csv' },
});

/** 取 CSV：非 2xx 与 `lib/api.ts` 同口径（契约 §0.1），成功返回 blob + 服务端文件名 + 截断标记。 */
async function fetchAuditCsv(
  query: AuditQuery,
): Promise<{ blob: Blob; filename: string; rows: number; truncated: boolean }> {
  // `limit` 被服务端忽略（契约 §7），原样带上不影响结果
  // `parseAs: 'blob'`：CSV 不能按 JSON 解析。openapi-fetch 会把响应体读进 `data`，
  // 所以 blob 只能从 `data` 取（再对 `response` 调 `.blob()` 会「Body has already been read」）
  const { data, error, response } = await csvClient.GET('/api/audit/export.csv', {
    params: { query },
    parseAs: 'blob',
  });

  if (!response.ok) {
    // 非 2xx：openapi-fetch 已把响应体按 JSON 解出（这里就是契约错误体）
    const body = error as ApiErrorBody | undefined;
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'internal',
      body?.error?.message ?? `导出失败（HTTP ${String(response.status)}）`,
    );
  }

  // 不用 `instanceof Blob`：MSW/undici 返回的 Blob 与 jsdom 的 Blob 不是同一个 realm，
  // `instanceof` 会假阴性（生产环境无此问题，但没必要为此写两套判断）
  if (data === undefined) {
    throw new ApiError(response.status, 'internal', '导出响应为空（服务端未返回 CSV）');
  }

  const filename = filenameFromDisposition(response.headers.get('content-disposition')) ?? 'audit.csv';
  const rows = countCsvRows(await data.text());
  return { blob: data, filename, rows, truncated: response.headers.get('x-pi-bot-truncated') === 'true' };
}

const columns = helper.columns([
  helper.accessor('at', {
    header: '时间',
    cell: (info) => {
      const cell = formatTimeCell(info.getValue());
      return <time title={cell.title}>{cell.text}</time>;
    },
  }),
  helper.accessor('actor', {
    header: '触发人',
    cell: (info) => {
      const actor = info.getValue();
      if (actor.login === null) return <span className="text-muted-foreground">—（cron）</span>;
      return (
        <span className="flex items-center gap-1">
          <span className="font-mono text-xs">{actor.login}</span>
          {actor.association === null ? null : <Badge variant="muted">{actor.association}</Badge>}
        </span>
      );
    },
  }),
  helper.accessor('repo', {
    header: '仓库',
    cell: (info) => (
      <span className="font-mono text-xs">
        {info.getValue()}
        {info.row.original.target.number === null ? null : (
          <span className="ml-1 text-muted-foreground">
            #{formatCount(info.row.original.target.number)}
          </span>
        )}
      </span>
    ),
  }),
  helper.accessor('command', {
    header: '命令',
    cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
  }),
  helper.accessor('headSha', {
    header: '提交 sha',
    cell: (info) => {
      const sha = info.getValue();
      if (sha === null) return <span className="text-muted-foreground">—</span>;
      return (
        <span className="font-mono text-xs" title={sha}>
          {sha.slice(0, 10)}
        </span>
      );
    },
  }),
  helper.accessor('intent', {
    header: '写了什么',
    cell: (info) => (
      <span className="flex items-center gap-1">
        <Badge variant="outline">{INTENT_LABEL[info.getValue()]}</Badge>
        <span className="font-mono text-xs text-muted-foreground">
          {info.row.original.target.kind}
          {info.row.original.target.ref === null ? '' : ` ${info.row.original.target.ref}`}
        </span>
      </span>
    ),
  }),
  helper.accessor('status', {
    header: '结果',
    cell: (info) => (
      <span className="flex items-center gap-1">
        <Badge variant={statusVariant(info.getValue())}>{info.getValue()}</Badge>
        {info.row.original.dryRun ? <Badge variant="outline">dry-run</Badge> : null}
      </span>
    ),
  }),
  helper.accessor('approval', {
    header: '审批判定',
    cell: (info) => {
      const approval = info.getValue();
      if (approval === null) return <span className="text-muted-foreground">—</span>;
      return (
        <span className="flex items-center gap-1">
          <Badge variant={approval.decision === 'allow' ? 'success' : 'danger'}>
            {approval.tool} · {approval.decision}
          </Badge>
          <span className="font-mono text-[11px] text-muted-foreground">{approval.rule}</span>
        </span>
      );
    },
  }),
]);

export function AuditPage() {
  const [repo, setRepo] = useState('');
  const [command, setCommand] = useState('');
  const [intent, setIntent] = useState('');
  const [range, setRange] = useState('');
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
      ...(windowMs === null
        ? {}
        : { from: new Date(now - windowMs).toISOString(), to: new Date(now).toISOString() }),
    };
  }, [repo, command, intent, range]);

  const { data, error, isLoading } = useAudit(query);

  const items = data?.items ?? [];
  const exportLimit = data?.exportLimit ?? AUDIT_EXPORT_LIMIT;

  /** 仓库候选来自已加载数据（契约没有仓库清单接口，不凭空造）。 */
  const repoOptions = useMemo(() => {
    const seen = new Set(items.map((item) => item.repo));
    if (repo !== '') seen.add(repo);
    return [...seen].sort().map((value) => ({ value, label: value }));
  }, [items, repo]);

  const anyFilter = repo !== '' || command !== '' || intent !== '' || range !== '';

  const clearFilters = (): void => {
    setRepo('');
    setCommand('');
    setIntent('');
    setRange('');
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

  return (
    <PageShell
      title="审计"
      description="每一次写操作：谁触发、跑哪个提交、写了什么、审批判定如何 · 每 15 秒刷新"
      actions={
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            data-testid="audit-export"
            disabled={exporting}
            onClick={() => {
              void runExport();
            }}
          >
            {exporting ? '导出中…' : '导出 CSV'}
          </Button>
          <Button variant="ghost" size="sm" data-testid="audit-clear" disabled={!anyFilter} onClick={clearFilters}>
            清除筛选
          </Button>
        </div>
      }
    >
      <div className="flex flex-wrap items-center gap-2" data-testid="audit-filters">
        <Select
          aria-label="仓库筛选"
          options={repoOptions}
          placeholder="全部仓库"
          value={repo}
          onChange={(event) => {
            setRepo(event.target.value);
          }}
        />
        <Select
          aria-label="命令筛选"
          options={COMMAND_OPTIONS}
          placeholder={null}
          value={command}
          onChange={(event) => {
            setCommand(event.target.value);
          }}
        />
        <Select
          aria-label="意图筛选"
          options={INTENT_OPTIONS}
          placeholder={null}
          value={intent}
          onChange={(event) => {
            setIntent(event.target.value);
          }}
        />
        <Select
          aria-label="时间范围筛选"
          options={RANGE_OPTIONS}
          placeholder={null}
          value={range}
          onChange={(event) => {
            setRange(event.target.value);
          }}
        />
      </div>

      {exportState === null ? null : exportState.tone === 'ok' ? (
        <p className="text-xs text-muted-foreground" data-testid="audit-export-status">
          已导出 {formatCount(exportState.rows)} 行 → {exportState.filename}
        </p>
      ) : exportState.tone === 'truncated' ? (
        <Alert variant="warning" data-testid="audit-export-status">
          <AlertTitle>
            只导出了前 {formatCount(exportState.limit)} 行（命中行数超过导出上限）
          </AlertTitle>
          <AlertDescription>
            文件 {exportState.filename} 共 {formatCount(exportState.rows)} 行；请缩小时间范围或加筛选后再导出，
            否则超出的部分不会出现在文件里。
          </AlertDescription>
        </Alert>
      ) : (
        <Alert variant="destructive" data-testid="audit-export-status">
          <AlertTitle>导出失败</AlertTitle>
          <AlertDescription>{exportState.message}</AlertDescription>
        </Alert>
      )}

      <AsyncSection
        isLoading={isLoading}
        error={error}
        isEmpty={data !== undefined && items.length === 0}
        emptyText="窗口内没有审计记录"
        testId="audit"
        skeletonHeight="h-64"
      >
        <div className="flex flex-col gap-3">
          {data?.truncated === true ? (
            <Alert variant="warning" data-testid="audit-truncated">
              <AlertTitle>命中行数超过单次导出上限（{formatCount(exportLimit)} 行）</AlertTitle>
              <AlertDescription>
                列表只显示最近的一页；导出也会被截断在前 {formatCount(exportLimit)} 行。
                请缩小时间范围或加筛选条件后再导出。
              </AlertDescription>
            </Alert>
          ) : null}
          <DataTable
            columns={columns}
            data={items}
            loading={isLoading}
            getRowId={(row) => row.id}
            emptyText="窗口内没有审计记录"
          />
          <p className="text-xs text-muted-foreground">
            共 {formatCount(items.length)} 条在本页
            {data?.hasMore === true ? '（还有更多，请用筛选缩小范围或用导出取全量）' : ''}
            {data?.exportLimit === undefined ? '' : ` · 单次导出上限 ${formatCount(exportLimit)} 行`}
          </p>
        </div>
      </AsyncSection>
    </PageShell>
  );
}
