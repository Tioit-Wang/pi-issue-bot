/**
 * 质量（`/api/quality/reverts`，每 15s 轮询）：**一条筛选条 + 一张主图 + 明细**。
 *
 * 面板唯一的「干得好不好」信号：自动执行后**被人改回**的比例（tech-plan §7.5）。
 * 口径由契约的 zod `refine` 强制：`rate = reverted / applied`，`applied = 0` 时 `rate` 必须是 `null`，
 * 所以页面**不能**把 null 画成 0% —— 标题旁的口径必须带上真实分母，桶里 null 显示 `—`。
 */
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { AsyncSection } from '../components/AsyncSection.tsx';
import { Section } from '../components/Section.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Toolbar } from '../components/Toolbar.tsx';
import { BarList } from '../components/charts/BarList.tsx';
import { RepoFilterSelect } from '../components/repo-filter.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Segmented } from '../components/ui/segmented.tsx';
import { Select } from '../components/ui/select.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.tsx';
import type { RevertsResponse } from '../lib/contract.ts';
import { formatCount, formatPercent, formatTimeCell } from '../lib/format.ts';
import { useReverts } from '../lib/queries.ts';

const RANGE_DAYS: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90 };

/** 改回方式的中文（契约枚举值照旧显示在括号里，便于对日志）。 */
const REVERT_KIND_LABEL: Record<string, string> = {
  'label-removed': '摘标签',
  'changes-requested': '被请求改动',
  'pr-closed': '关 PR',
  'comment-deleted': '删评论',
  'revert-commit': '回滚提交',
};

export function QualityPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const repo = searchParams.get('repo') ?? '';
  const command = searchParams.get('command') ?? '';
  const range = searchParams.get('range') ?? '7d';
  const [dimension, setDimension] = useState<'command' | 'repo'>('command');

  const query = useMemo(() => {
    const days = RANGE_DAYS[range] ?? null;
    return {
      limit: 50,
      ...(repo === '' ? {} : { repo }),
      ...(command === '' ? {} : { command }),
      ...(days === null ? {} : { from: new Date(Date.now() - days * 86_400_000).toISOString() }),
    };
  }, [repo, command, range]);

  const { data, error, isLoading, refetch } = useReverts(query);
  const isEmpty = data !== undefined && data.overall.applied === 0;

  const setParam = (key: string, value: string): void => {
    const next = new URLSearchParams(searchParams);
    if (value === '') next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader
        title="质量"
        actions={
          error === null ? undefined : (
            <button
              type="button"
              onClick={() => {
                void refetch();
              }}
              className="h-7 rounded-md border border-border px-2 text-xs text-foreground hover:bg-muted"
            >
              重试
            </button>
          )
        }
      />

      <Toolbar>
        <span className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="quality-filters">
          <RepoFilterSelect testId="quality-repo-filter" />
          <Segmented
            label="时间窗"
            value={range}
            onChange={(next) => {
              setParam('range', next === '7d' ? '' : next);
            }}
            options={[
              { value: '7d', label: '7 天' },
              { value: '30d', label: '30 天' },
              { value: '90d', label: '90 天' },
            ]}
          />
          <Select
            aria-label="命令筛选"
            options={(data?.byCommand ?? []).map((bucket) => ({ value: bucket.key, label: bucket.key }))}
            placeholder="全部命令"
            value={command}
            onChange={(event) => {
              setParam('command', event.target.value);
            }}
          />
          {repo === '' ? null : <span className="text-2xs text-faint">{`只看 ${repo}`}</span>}
        </span>
      </Toolbar>

      <AsyncSection
        isLoading={isLoading}
        error={error}
        isEmpty={isEmpty}
        emptyText="窗口内没有已应用的动作（没有可评估的样本）"
        testId="quality"
        skeletonRows={5}
      >
        {data === undefined ? null : (
          <QualityContent
            data={data}
            dimension={dimension}
            onDimensionChange={setDimension}
            onOpenTask={(taskId) => {
              void navigate(`/tasks/${encodeURIComponent(taskId)}`);
            }}
          />
        )}
      </AsyncSection>
    </div>
  );
}

function QualityContent({
  data,
  dimension,
  onDimensionChange,
  onOpenTask,
}: {
  data: RevertsResponse;
  dimension: 'command' | 'repo';
  onDimensionChange: (next: 'command' | 'repo') => void;
  onOpenTask: (taskId: string) => void;
}) {
  const { overall } = data;
  const buckets = dimension === 'command' ? data.byCommand : data.byRepo;
  const kinds = new Map<string, number>();
  for (const record of data.records) kinds.set(record.revertKind, (kinds.get(record.revertKind) ?? 0) + 1);
  const kindRows = [...kinds.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([kind, count]) => ({
      key: `${REVERT_KIND_LABEL[kind] ?? kind}（${kind}）`,
      value: count,
      display: `${formatCount(count)} 条`,
      tone: 'warn' as const,
    }));

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Section
        first
        title="被改回率"
        description={`口径：被改回 ${formatCount(overall.reverted)} / 已应用 ${formatCount(overall.applied)} 个动作（窗口内）；分母为 0 时显示 —，不是 0%。`}
        actions={
          <Segmented
            label="分组维度"
            value={dimension}
            onChange={(next) => {
              onDimensionChange(next as 'command' | 'repo');
            }}
            options={[
              { value: 'command', label: '按命令' },
              { value: 'repo', label: '按仓库' },
            ]}
          />
        }
      >
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="tabular text-xl font-semibold text-foreground" data-testid="quality-rate">
              {formatPercent(overall.rate)}
            </span>
            <span className="text-xs text-muted-foreground">
              被改回 <span className="tabular text-foreground">{formatCount(overall.reverted)}</span> / 已应用{' '}
              <span className="tabular text-foreground">{formatCount(overall.applied)}</span>
              <span className="text-faint"> · 命令 {formatCount(data.byCommand.length)} 组 · 仓库 {formatCount(data.byRepo.length)} 组</span>
            </span>
          </div>

          <BarList
            testId="quality-buckets"
            max={1}
            emptyText="窗口内没有已应用的动作"
            items={buckets.map((bucket) => ({
              key: bucket.key,
              value: bucket.rate ?? 0,
              display: bucket.rate === null ? '—' : formatPercent(bucket.rate),
              note: `改回 ${formatCount(bucket.reverted)} / 应用 ${formatCount(bucket.applied)}`,
              tone: bucket.rate === null ? 'neutral' : bucket.rate >= 0.2 ? 'danger' : bucket.rate >= 0.1 ? 'warn' : 'success',
            }))}
          />
          <p className="text-2xs text-faint">条形满格 = 100%；判色 ≥20% 红 / ≥10% 黄（只是阅读辅助）</p>
        </div>
      </Section>

      <Section
        title="改回方式分布"
      >
        <BarList testId="quality-kinds" emptyText="窗口内没有被改回的记录" items={kindRows} />
        <p className="mt-1 text-2xs text-faint">
          共 {formatCount(data.records.length)} 条记录
          {data.hasMore ? '（还有更多，游标分页；用筛选缩小范围更能说明问题）' : ''}
        </p>
      </Section>

      <Section title="逐条改回记录">
        <Table stickyFirst>
          <TableHeader>
            <TableRow>
              <TableHead>任务</TableHead>
              <TableHead>仓库</TableHead>
              <TableHead>命令</TableHead>
              <TableHead>写的是什么</TableHead>
              <TableHead>改回方式</TableHead>
              <TableHead className="text-right">落地</TableHead>
              <TableHead className="text-right">被改回</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.records.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-6 text-center text-sm text-muted-foreground">
                  窗口内没有被改回的动作
                </TableCell>
              </TableRow>
            ) : (
              data.records.map((record) => {
                const applied = formatTimeCell(record.appliedAt);
                const reverted = formatTimeCell(record.revertedAt);
                return (
                  <TableRow
                    key={record.actionId}
                    className="cursor-pointer"
                    onClick={() => {
                      onOpenTask(record.taskId);
                    }}
                  >
                    <TableCell className="font-mono text-xs">{record.taskId}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{record.repo}</TableCell>
                    <TableCell className="font-mono text-xs">{record.command}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{record.intent}</TableCell>
                    <TableCell>
                      <Badge tone="warn">{record.revertKind}</Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      <time title={applied.title}>{applied.text}</time>
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      <time title={reverted.title}>{reverted.text}</time>
                      {record.url === null ? null : (
                        <a
                          href={record.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="ml-1.5 text-brand underline underline-offset-2"
                          onClick={(event) => {
                            event.stopPropagation();
                          }}
                        >
                          GitHub
                        </a>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
        <p className="text-2xs text-faint">
          统计窗口 {formatTimeCell(data.window.from).title} — {formatTimeCell(data.window.to).title} · 生成于{' '}
          {formatTimeCell(data.generatedAt).text}
        </p>
      </Section>
    </div>
  );
}