import { useInfiniteQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { AsyncSection } from '../components/AsyncSection.tsx';
import { DataTable } from '../components/tables/DataTable.tsx';
import { panelTableFeatures } from '../components/tables/features.ts';
import { Badge, statusVariant } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Select } from '../components/ui/select.tsx';
import { api } from '../lib/api.ts';
import type { TaskListItem, TasksQuery } from '../lib/contract.ts';
import { formatCount, formatDuration, formatTimeCell, formatUsd } from '../lib/format.ts';
import { REFETCH_INTERVAL, queryKeys } from '../lib/queries.ts';
import { PageShell } from './PageShell.tsx';

/**
 * 任务列表（S2，数据源 `/api/tasks`，每 15s 轮询，tech-plan §9.3）。
 *
 * 三件事是这一页的全部难点，其余都是呈现：
 *
 *  1. **游标分页**：契约是游标（`cursor` 不透明 + `nextCursor`/`hasMore`），不是页码。
 *     所以用 `useInfiniteQuery` 累积页、点「加载更多」拿 `nextCursor`，不回退到 offset 语义。
 *     为什么在页面里自己写这个 hook 而不是加到 `lib/queries.ts`：`queries.ts` 在 P0 已冻结，
 *     且**只有这一页需要分页**（其余页都是单次快照），放页面里改动面最小。
 *  2. **筛选状态与 URL 双向同步**：`useSearchParams` 是唯一事实源（不在 `useState` 存一份），
 *     刷新、前进/后退、贴链接给别人都保持同一份筛选；写入时**保留不认识的参数**
 *     （例如 MSW 的 `?mock=error`），否则切一次筛选就把场景开关吃掉了。
 *  3. **五类筛选**：仓库 / 状态 / 失败分类 / 命令类型 / 时间范围。前四个与服务端参数同名，
 *     时间范围是 UI 侧预设（`range=24h|7d|30d`），落成契约里的 `from`/`to`。
 *
 * 数字与时间一律走 `lib/format.ts`；`null` 显示 `—`（契约：`null ≠ 0`）。
 */
const helper = createColumnHelper<typeof panelTableFeatures, TaskListItem>();

/** 每页条数：契约默认 50（上限 200），这里显式传，免得服务端默认值变了页面跟着变。 */
const PAGE_SIZE = 50;

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'queued', label: '排队中' },
  { value: 'running', label: '执行中' },
  { value: 'succeeded', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'cancelled', label: '已取消' },
] as const;

/** 失败分类取值 = 契约 §1 `failureTop` 的十个枚举（技术 id，不做翻译）。 */
const FAILURE_CLASS_OPTIONS = [
  { value: '', label: '全部分类' },
  { value: 'timeout', label: 'timeout' },
  { value: 'interrupt', label: 'interrupt' },
  { value: 'degenerate-output', label: 'degenerate-output' },
  { value: 'sandbox-oom', label: 'sandbox-oom' },
  { value: 'sandbox-crash', label: 'sandbox-crash' },
  { value: 'auth', label: 'auth' },
  { value: 'rate-limit', label: 'rate-limit' },
  { value: 'model', label: 'model' },
  { value: 'parse', label: 'parse' },
  { value: 'github-api', label: 'github-api' },
] as const;

/** 命令类型：契约 §2 注明的三个取值（`/review-pr`、`auto:triage`、`auto:compliance`）。 */
const COMMAND_OPTIONS = [
  { value: '', label: '全部命令' },
  { value: '/review-pr', label: '/review-pr' },
  { value: 'auto:triage', label: 'auto:triage' },
  { value: 'auto:compliance', label: 'auto:compliance' },
] as const;

/** 时间范围：预设落在契约的 `from`/`to` 上（服务端按 `queuedAt` 过滤）。 */
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

/** 命令类型 → 徽章文案（`source` 是「任务从哪来」，不是命令名本身）。 */
const SOURCE_LABEL: Record<TaskListItem['source'], string> = {
  webhook: '事件',
  command: '命令',
  cron: '定时',
};

/** 只认识的筛选键：同步 URL 时**只动这几个**，其余原样保留。 */
const FILTER_KEYS = ['repo', 'status', 'failureClass', 'command', 'range'] as const;

type FilterKey = (typeof FILTER_KEYS)[number];

type Filters = Record<FilterKey, string>;

/** 失败分类是契约里的字面量联合（十个值 + null），不是任意字符串——筛选值要显式收窄。 */
type FailureClass = NonNullable<TaskListItem['failureClass']>;

/** 白名单校验：URL 里的值不在选项里就当没传（拼错的参数不该把页面变成空列表）。 */
function accept(value: string | null, options: readonly { value: string }[]): string {
  if (value === null || value === '') return '';
  return options.some((option) => option.value === value) ? value : '';
}

function readFilters(params: URLSearchParams): Filters {
  return {
    repo: params.get('repo') ?? '',
    status: accept(params.get('status'), STATUS_OPTIONS),
    failureClass: accept(params.get('failureClass'), FAILURE_CLASS_OPTIONS),
    command: accept(params.get('command'), COMMAND_OPTIONS),
    range: accept(params.get('range'), RANGE_OPTIONS),
  };
}

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
    cell: (info) => (
      <span className="font-mono text-xs">
        {info.getValue()}
        <span className="ml-1 text-muted-foreground">
          #{formatCount(info.row.original.targetNumber)}
        </span>
      </span>
    ),
  }),
  helper.accessor('command', {
    header: '类型 / 命令',
    cell: (info) => (
      <span className="flex items-center gap-1.5">
        <Badge variant="outline">{SOURCE_LABEL[info.row.original.source]}</Badge>
        <span className="font-mono text-xs">{info.getValue()}</span>
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
  helper.accessor('failureClass', {
    header: '失败分类',
    cell: (info) => {
      const failureClass = info.getValue();
      if (failureClass === null) return <span className="text-muted-foreground">—</span>;
      return <Badge variant="danger">{failureClass}</Badge>;
    },
  }),
]);

export function TasksPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = readFilters(searchParams);

  const query = useMemo<TasksQuery>(() => {
    const now = Date.now();
    const windowMs = filters.range === '' ? null : (RANGE_WINDOW_MS[filters.range] ?? null);
    return {
      limit: PAGE_SIZE,
      ...(filters.repo === '' ? {} : { repo: filters.repo }),
      ...(filters.status === '' ? {} : { status: filters.status as TaskListItem['status'] }),
      ...(filters.failureClass === '' ? {} : { failureClass: filters.failureClass as FailureClass }),
      ...(filters.command === '' ? {} : { command: filters.command }),
      // 预设范围每次重建 from/to：切筛选就换 queryKey，切回来也拿新窗口
      ...(windowMs === null
        ? {}
        : { from: new Date(now - windowMs).toISOString(), to: new Date(now).toISOString() }),
    };
  }, [filters.repo, filters.status, filters.failureClass, filters.command, filters.range]);

  const { data, error, isLoading, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage } =
    useInfiniteQuery({
      // 独立的 key 后缀：无限查询的缓存形状是 `{pages, pageParams}`，不能和 `useTasks` 的扁平响应共用
      queryKey: [...queryKeys.tasks(query), 'pages'] as const,
      queryFn: ({ pageParam }) =>
        api.tasks({ ...query, ...(pageParam === null ? {} : { cursor: pageParam }) }),
      initialPageParam: null as string | null,
      getNextPageParam: (lastPage) =>
        lastPage.hasMore && lastPage.nextCursor !== null ? lastPage.nextCursor : undefined,
      refetchInterval: REFETCH_INTERVAL.list,
    });

  const items = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);
  const totalEstimate = data?.pages.at(0)?.totalEstimate ?? null;
  const anyFilter = FILTER_KEYS.some((key) => filters[key] !== '');

  /** 仓库 / 命令的候选值来自「已加载数据 ∪ 当前选中值」：契约里没有仓库清单接口，不能凭空造列表。 */
  const repoOptions = useMemo(() => {
    const seen = new Set(items.map((item) => item.repo));
    if (filters.repo !== '') seen.add(filters.repo);
    return [...seen].sort().map((value) => ({ value, label: value }));
  }, [items, filters.repo]);

  const setFilter = (key: FilterKey, value: string): void => {
    // 复制一份再改：`?mock=error` 这类 mock/外部参数必须原样留着
    const next = new URLSearchParams(searchParams);
    if (value === '') next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  const clearFilters = (): void => {
    const next = new URLSearchParams(searchParams);
    for (const key of FILTER_KEYS) next.delete(key);
    setSearchParams(next, { replace: true });
  };

  const loadedText = formatCount(items.length);
  const totalText = formatCount(totalEstimate);

  return (
    <PageShell
      title="任务"
      description={`按时间倒序 · 共 ${totalText} 条 · 已显示 ${loadedText} 条 · 每 15 秒刷新`}
      actions={
        <div className="flex items-center gap-2">
          {isFetching && !isLoading ? (
            <span className="text-xs text-muted-foreground" data-testid="tasks-refreshing">
              刷新中…
            </span>
          ) : null}
          <Button variant="ghost" size="sm" disabled={!anyFilter} onClick={clearFilters} data-testid="tasks-clear">
            清除筛选
          </Button>
        </div>
      }
    >
      <div className="flex flex-wrap items-center gap-2" data-testid="tasks-filters">
        <Select
          aria-label="仓库筛选"
          options={repoOptions}
          placeholder="全部仓库"
          value={filters.repo}
          onChange={(event) => {
            setFilter('repo', event.target.value);
          }}
        />
        <Select
          aria-label="状态筛选"
          options={STATUS_OPTIONS}
          placeholder={null}
          value={filters.status}
          onChange={(event) => {
            setFilter('status', event.target.value);
          }}
        />
        <Select
          aria-label="失败分类筛选"
          options={FAILURE_CLASS_OPTIONS}
          placeholder={null}
          value={filters.failureClass}
          onChange={(event) => {
            setFilter('failureClass', event.target.value);
          }}
        />
        <Select
          aria-label="命令类型筛选"
          options={COMMAND_OPTIONS}
          placeholder={null}
          value={filters.command}
          onChange={(event) => {
            setFilter('command', event.target.value);
          }}
        />
        <Select
          aria-label="时间范围筛选"
          options={RANGE_OPTIONS}
          placeholder={null}
          value={filters.range}
          onChange={(event) => {
            setFilter('range', event.target.value);
          }}
        />
      </div>

      <AsyncSection
        isLoading={isLoading}
        error={error}
        testId="tasks"
        skeletonHeight="h-64"
        skeleton={
          <div className="flex flex-col gap-2">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={`tasks-skeleton-${String(index)}`} className="h-9 w-full animate-pulse rounded-md bg-muted" />
            ))}
          </div>
        }
      >
        {items.length === 0 ? (
          <div
            data-testid="tasks-empty"
            className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground"
          >
            <p className="font-medium text-foreground">没有匹配的任务</p>
            <p className="mt-1 text-xs">当前筛选条件下没有任何任务；放宽条件或换个时间范围再试。</p>
            <Button
              className="mt-3"
              variant="outline"
              size="sm"
              onClick={clearFilters}
              data-testid="tasks-empty-clear"
            >
              清除筛选
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <DataTable
              columns={columns}
              data={items}
              loading={isLoading}
              getRowId={(row) => row.id}
              onRowClick={(row) => {
                void navigate(`/tasks/${encodeURIComponent(row.id)}`);
              }}
              emptyText="没有匹配的任务"
            />
            <div className="flex items-center justify-center gap-2">
              <Button
                variant="outline"
                size="sm"
                data-testid="tasks-load-more"
                disabled={hasNextPage !== true || isFetchingNextPage}
                onClick={() => {
                  void fetchNextPage();
                }}
              >
                {hasNextPage === true
                  ? isFetchingNextPage
                    ? '加载中…'
                    : `加载更多（已显示 ${loadedText} 条）`
                  : `没有更多了（共 ${loadedText} 条）`}
              </Button>
            </div>
          </div>
        )}
      </AsyncSection>
    </PageShell>
  );
}
