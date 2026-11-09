import { createColumnHelper } from '@tanstack/react-table';
import { AsyncSection } from '../components/AsyncSection.tsx';
import { DataTable } from '../components/tables/DataTable.tsx';
import { panelTableFeatures } from '../components/tables/features.ts';
import { Badge, statusVariant } from '../components/ui/badge.tsx';
import { api } from '../lib/api.ts';
import type { AuditRow } from '../lib/contract.ts';
import { formatTimeCell } from '../lib/format.ts';
import { useAudit } from '../lib/queries.ts';
import { PageShell } from './PageShell.tsx';

/**
 * 审计（S6，数据源 `/api/audit`，每 15s 轮询；导出走 `/api/audit/export.csv`）。
 *
 * 「谁触发 / 跑哪个 sha / 写了什么 / 审批判定」四件事都在一行里。
 * P0 已接真数据 + CSV 下载链接；W3-K 继续做的是筛选栏与 `truncated` 提示的呈现细节。
 */
const helper = createColumnHelper<typeof panelTableFeatures, AuditRow>();

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
    cell: (info) => <span className="font-mono text-xs">{info.getValue().login ?? '—（cron）'}</span>,
  }),
  helper.accessor('repo', {
    header: '仓库 / 目标',
    cell: (info) => (
      <span className="font-mono text-xs">
        {info.getValue()}
        {info.row.original.target.number === null ? '' : `#${String(info.row.original.target.number)}`}
      </span>
    ),
  }),
  helper.accessor('intent', {
    header: '写了什么',
    cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
  }),
  helper.accessor('status', {
    header: '结果',
    cell: (info) => <Badge variant={statusVariant(info.getValue())}>{info.getValue()}</Badge>,
  }),
  helper.accessor('headSha', {
    header: '提交',
    cell: (info) => <span className="font-mono text-xs">{info.getValue()?.slice(0, 10) ?? '—'}</span>,
  }),
  helper.accessor('approval', {
    header: '审批判定',
    cell: (info) => {
      const approval = info.getValue();
      if (approval === null) return <span className="text-muted-foreground">—</span>;
      return (
        <Badge variant={approval.decision === 'allow' ? 'success' : 'danger'}>
          {approval.tool} · {approval.decision}
        </Badge>
      );
    },
  }),
]);

export function AuditPage() {
  const { data, error, isLoading } = useAudit({ limit: 50 });

  return (
    <PageShell
      title="审计"
      description="每一次写操作：谁触发、跑哪个提交、写了什么、审批判定如何"
      actions={
        <a
          className="inline-flex h-8 items-center rounded-md border border-border px-2.5 text-xs hover:bg-accent"
          href={api.auditCsvUrl({})}
          download="audit.csv"
        >
          导出 CSV
        </a>
      }
    >
      <AsyncSection
        isLoading={isLoading}
        error={error}
        isEmpty={data !== undefined && data.items.length === 0}
        emptyText="窗口内没有审计记录"
        testId="audit"
        skeletonHeight="h-64"
      >
        <div className="flex flex-col gap-2">
          {data?.truncated === true ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              命中行数超过单次导出口径（{data.exportLimit} 行），请缩小时间范围后再导出。
            </p>
          ) : null}
          <DataTable
            columns={columns}
            data={data?.items ?? []}
            loading={isLoading}
            getRowId={(row) => row.id}
            emptyText="窗口内没有审计记录"
          />
        </div>
      </AsyncSection>
    </PageShell>
  );
}
