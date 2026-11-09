import { createColumnHelper } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { AsyncSection } from '../components/AsyncSection.tsx';
import { DataTable } from '../components/tables/DataTable.tsx';
import { panelTableFeatures } from '../components/tables/features.ts';
import { Badge, statusVariant } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Select } from '../components/ui/select.tsx';
import type { TaskListItem } from '../lib/contract.ts';
import { formatCount, formatDuration, formatTimeCell, formatUsd } from '../lib/format.ts';
import { useTasks } from '../lib/queries.ts';
import { PageShell } from './PageShell.tsx';

/**
 * 任务列表（S2，数据源 `/api/tasks`，每 15s 轮询）。
 *
 * P0 已接真数据：仓库/状态筛选 + 游标分页 + 6 列（时间 / 仓库 / 命令 / 状态 / 耗时 / 成本）。
 * W3-K 在 P0 之上补：URL 查询参数同步（刷新后筛选不丢）、日期范围、失败分类筛选、
 * 每页大小的显式选择——数据接口与列定义都不用重写。
 */
const helper = createColumnHelper<typeof panelTableFeatures, TaskListItem>();

const STATUS_OPTIONS = [
  { value: 'queued', label: '排队中' },
  { value: 'running', label: '执行中' },
  { value: 'succeeded', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'cancelled', label: '已取消' },
] as const;

const REPO_OPTIONS = [
  { value: 'acme/widgets', label: 'acme/widgets' },
  { value: 'other/lib', label: 'other/lib' },
] as const;

const columns = helper.columns([
  helper.accessor('queuedAt', {
    header: '时间',
    cell: (info) => {
      const cell = formatTimeCell(info.getValue());
      return <time title={cell.title}>{cell.text}</time>;
    },
  }),
  helper.accessor('repo', {
    header: '仓库',
    cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
  }),
  helper.accessor('command', {
    header: '命令',
    cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
  }),
  helper.accessor('targetNumber', {
    header: '目标',
    cell: (info) => (
      <span className="font-mono text-xs">
        {info.row.original.targetKind}#{String(info.getValue())}
      </span>
    ),
  }),
  helper.accessor('status', {
    header: '状态',
    cell: (info) => (
      <span className="flex items-center gap-1">
        <Badge variant={statusVariant(info.getValue())}>{info.getValue()}</Badge>
        {info.row.original.dryRun ? <Badge variant="outline">dry-run</Badge> : null}
      </span>
    ),
  }),
  helper.accessor('durationMs', {
    header: '耗时',
    cell: (info) => <span className="tabular-nums">{formatDuration(info.getValue())}</span>,
  }),
  helper.accessor('costUsd', {
    header: '成本',
    cell: (info) => <span className="tabular-nums">{formatUsd(info.getValue())}</span>,
  }),
]);

export function TasksPage() {
  const navigate = useNavigate();
  const [repo, setRepo] = useState('');
  const [status, setStatus] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);

  const query = useMemo(
    () => ({
      limit: 50,
      ...(repo === '' ? {} : { repo }),
      ...(status === '' ? {} : { status: status as TaskListItem['status'] }),
      ...(cursors.length === 0 ? {} : { cursor: cursors[cursors.length - 1] as string }),
    }),
    [repo, status, cursors],
  );

  const { data, error, isLoading } = useTasks(query);

  return (
    <PageShell
      title="任务"
      description={`按时间倒序 · 共 ${formatCount(data?.totalEstimate ?? null)} 条 · 每 15 秒刷新`}
      actions={
        <div className="flex items-center gap-2">
          <Select
            aria-label="仓库筛选"
            options={REPO_OPTIONS}
            placeholder="全部仓库"
            value={repo}
            onChange={(event) => {
              setRepo(event.target.value);
              setCursors([]);
            }}
          />
          <Select
            aria-label="状态筛选"
            options={STATUS_OPTIONS}
            placeholder="全部状态"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setCursors([]);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={cursors.length === 0}
            onClick={() => {
              setCursors((current) => current.slice(0, -1));
            }}
          >
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={data === undefined || !data.hasMore || data.nextCursor === null}
            onClick={() => {
              const next = data?.nextCursor;
              if (next === undefined || next === null) return;
              setCursors((current) => [...current, next]);
            }}
          >
            下一页
          </Button>
        </div>
      }
    >
      <AsyncSection
        isLoading={isLoading}
        error={error}
        isEmpty={data !== undefined && data.items.length === 0}
        emptyText="没有符合条件的任务"
        testId="tasks"
        skeletonHeight="h-64"
      >
        <DataTable
          columns={columns}
          data={data?.items ?? []}
          loading={isLoading}
          getRowId={(row) => row.id}
          onRowClick={(row) => {
            void navigate(`/tasks/${encodeURIComponent(row.id)}`);
          }}
          emptyText="没有符合条件的任务"
        />
      </AsyncSection>
    </PageShell>
  );
}
