import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { RefreshCw } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { AsyncSection } from '../components/AsyncSection.tsx';
import { FilterSelect } from '../components/FilterSelect.tsx';
import { Toolbar } from '../components/Toolbar.tsx';
import { Button } from '../components/ui/button.tsx';
import { Spinner } from '../components/ui/spinner.tsx';
import { StatusDot } from '../components/ui/status-badge.tsx';
import { statusTone, TONE_TEXT } from '../components/ui/status.ts';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.tsx';
import { api } from '../lib/api.ts';
import type { TaskListItem, TasksQuery } from '../lib/contract.ts';
import { formatCount, formatDuration, formatTimeCell, formatUsd } from '../lib/format.ts';
import { REFETCH_INTERVAL, queryKeys } from '../lib/queries.ts';
import { repoRunPath } from '../lib/repo-route.ts';
import { cn } from '../lib/utils.ts';
import { PageShell } from './PageShell.tsx';

/**
 * 运行列表（`/repos/:repo/runs`；数据源 `/api/tasks`，15s 轮询）。
 *
 * 版式是企业级 admin 的**表格列表**：工具栏（筛选 + 动作用一条 hairline 与表体分开）
 * → 表头 + 数据行 → 底部「加载更多」。为什么从「对象行」改成真表格：
 * 这一页要横向比较的是同一组字段（状态 / 耗时 / 成本 / 时间），
 * 表头给一次列名比每行重复一次标签更省，也让数字列能对齐成一条线。
 *
 * 工具栏里**没有搜索框、也没有视图切换**：契约 `tasksQuerySchema` 没有 `q`，
 * 而运行列表只有「一行一次运行」这一种读法（明细在详情页），加一个假的视图开关
 * 等于让同一份数据有两条读法却没有第二条 URL 语义。
 *
 * 三件事仍然是这一页的全部难点：
 *
 *  1. **游标分页**：契约是游标（`cursor` 不透明 + `nextCursor`/`hasMore`），用 `useInfiniteQuery`
 *     累积页、点「加载更多」拿 `nextCursor`，不回退到 offset 语义。
 *  2. **筛选状态与 URL 双向同步**：`useSearchParams` 是唯一事实源，写入时保留不认识的参数
 *     （例如 MSW 的 `?mock=error`）。
 *  3. **五类筛选**：仓库 / 状态 / 失败分类 / 命令 / 时间范围；时间范围是 UI 侧预设
 *     （`range=24h|7d|30d`），落成契约里的 `from`/`to`。
 *
 * 数字与时间一律走 `lib/format.ts`；`null` 显示 `—`（契约：`null ≠ 0`，`$0.0000` 与「未计价」是两件事）。
 */
/** 每页条数：契约默认 50（上限 200），这里显式传，免得服务端默认值变了页面跟着变。 */
const PAGE_SIZE = 50;

/* 每个下拉的第一项都是 `value: ''`（= 不筛选）：`FilterSelect` 把它渲染成「全部 X」。 */
const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'queued', label: '排队中' },
  { value: 'running', label: '执行中' },
  { value: 'succeeded', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'cancelled', label: '已取消' },
] as const;

/** 失败分类取值 = 契约 `failureClassSchema` 的十个枚举（技术 id，不做翻译）。 */
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

/** 触发来源 → 文案（`source` 是「任务从哪来」，不是命令名本身）。 */
const SOURCE_LABEL: Record<TaskListItem['source'], string> = {
  webhook: '事件',
  command: '命令',
  cron: '定时',
  // v0.3 的 issue agent（`tasks.source = 'agent'`）
  agent: 'Agent',
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

export type TasksPageProps = {
  /**
   * 仓库锁：挂在 `/repos/:repo/runs` 下时由路由传入，此时仓库筛选被固定成它、
   * 仓库下拉隐藏（选别的仓库会离开当前仓库上下文，用左栏切换器更符合两级导航的语义）。
   */
  repoLock?: string;
};

export function TasksPage({ repoLock }: TasksPageProps = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const filters = readFilters(searchParams);
  const repoFilter = repoLock ?? filters.repo;

  const query = useMemo<TasksQuery>(() => {
    const now = Date.now();
    const windowMs = filters.range === '' ? null : (RANGE_WINDOW_MS[filters.range] ?? null);
    return {
      limit: PAGE_SIZE,
      ...(repoFilter === '' ? {} : { repo: repoFilter }),
      ...(filters.status === '' ? {} : { status: filters.status as TaskListItem['status'] }),
      ...(filters.failureClass === '' ? {} : { failureClass: filters.failureClass as FailureClass }),
      ...(filters.command === '' ? {} : { command: filters.command }),
      // 预设范围每次重建 from/to：切筛选就换 queryKey，切回来也拿新窗口
      ...(windowMs === null
        ? {}
        : { from: new Date(now - windowMs).toISOString(), to: new Date(now).toISOString() }),
    };
  }, [repoFilter, filters.status, filters.failureClass, filters.command, filters.range]);

  const { data, error, isLoading, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage, refetch } =
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

  /** 仓库的候选值来自「已加载数据 ∪ 当前选中值」：契约里没有仓库清单接口，不凭空造列表。 */
  const repoOptions = useMemo(() => {
    const seen = new Set(items.map((item) => item.repo));
    if (repoFilter !== '') seen.add(repoFilter);
    return [
      { value: '', label: '全部仓库' },
      ...[...seen].sort().map((value) => ({ value, label: value })),
    ];
  }, [items, repoFilter]);

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
  const runningCount = items.filter((item) => item.status === 'running').length;

  return (
    <PageShell
      title={repoLock === undefined ? '任务' : '运行'}
      description={`${repoLock === undefined ? '' : `${repoLock} · `}共 ${totalText} 条 · 已显示 ${loadedText} 条${
        runningCount > 0 ? ` · ${String(runningCount)} 条正在跑` : ''
      }`}
      actions={
        <div className="flex items-center gap-2">
          {isFetching && !isLoading ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Spinner className="size-3" />
              刷新中
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void refetch();
            }}
            data-testid="tasks-refresh"
          >
            <RefreshCw aria-hidden />
            刷新
          </Button>
          <Button variant="ghost" size="sm" disabled={!anyFilter} onClick={clearFilters} data-testid="tasks-clear">
            清除筛选
          </Button>
        </div>
      }
    >
      <div className="flex min-w-0 flex-col gap-3">
        {/* 工具栏：五类筛选（全部落 URL，刷新不丢），动作在页面标题行 */}
        <Toolbar
          meta={anyFilter ? `已筛选 · 已显示 ${formatCount(items.length)} 条` : undefined}
          className="border-0 pb-0"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="tasks-filters">
            {repoLock === undefined ? (
              <FilterSelect
                label="仓库筛选"
                options={repoOptions}
                value={filters.repo}
                onChange={(next) => {
                  setFilter('repo', next);
                }}
              />
            ) : null}
            <FilterSelect
              label="状态筛选"
              options={STATUS_OPTIONS}
              value={filters.status}
              onChange={(next) => {
                setFilter('status', next);
              }}
            />
            <FilterSelect
              label="失败分类筛选"
              options={FAILURE_CLASS_OPTIONS}
              value={filters.failureClass}
              onChange={(next) => {
                setFilter('failureClass', next);
              }}
            />
            <FilterSelect
              label="命令类型筛选"
              options={COMMAND_OPTIONS}
              value={filters.command}
              onChange={(next) => {
                setFilter('command', next);
              }}
            />
            <FilterSelect
              label="时间范围筛选"
              options={RANGE_OPTIONS}
              value={filters.range}
              onChange={(next) => {
                setFilter('range', next);
              }}
            />
          </div>
        </Toolbar>

        <AsyncSection
          isLoading={isLoading}
          error={error}
          testId="tasks"
          isEmpty={items.length === 0}
          emptyText="没有匹配的运行"
          emptyHint={anyFilter ? '放宽条件或换个时间范围' : '在 issue 里 @ 机器人或发一条 /命令 就会出现'}
          emptyAction={
            anyFilter ? (
              <Button variant="secondary" size="sm" onClick={clearFilters} data-testid="tasks-empty-clear">
                清除筛选
              </Button>
            ) : null
          }
          onRetry={() => {
            void refetch();
          }}
          skeletonRows={8}
        >
          <div className="flex min-w-0 flex-col gap-3">
            <div className="overflow-hidden rounded-lg border border-border" data-testid="tasks-list">
              {/*
                固定表格布局 + 显式列宽：命令格里有「命令 / 来源 / dry-run」与「失败分类 / 触发人 / 任务 id」
                两行可变长文本，自适应布局下它要么把相邻列挤变形，要么把自己的内容压成 4 个字符。
                固定布局让「命令」拿到剩余宽度，超长部分由内层 `truncate` 负责。
              */}
              <Table className="w-full table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">状态</TableHead>
                    <TableHead>命令</TableHead>
                    {/* 仓库在 `/repos/:repo/runs` 下与面包屑/侧栏重复，所以只在够宽时出现 */}
                    <TableHead className="hidden w-36 lg:table-cell">仓库</TableHead>
                    <TableHead className="hidden w-20 sm:table-cell">目标</TableHead>
                    <TableHead className="hidden w-16 text-right md:table-cell">耗时</TableHead>
                    <TableHead className="hidden w-20 text-right md:table-cell">成本</TableHead>
                    <TableHead className="w-24 text-right">时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((run) => (
                    <RunRow
                      key={run.id}
                      run={run}
                      repoLock={repoLock}
                      onOpen={() => {
                        void navigate(repoRunPath(repoLock ?? run.repo, run.id));
                      }}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex items-center justify-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                data-testid="tasks-load-more"
                disabled={hasNextPage !== true || isFetchingNextPage}
                onClick={() => {
                  void fetchNextPage();
                }}
              >
                {hasNextPage === true ? (
                  isFetchingNextPage ? (
                    <>
                      <Spinner aria-hidden />
                      加载中
                    </>
                  ) : (
                    `加载更多（已显示 ${loadedText} 条）`
                  )
                ) : (
                  `没有更多了（共 ${loadedText} 条）`
                )}
              </Button>
            </div>
          </div>
        </AsyncSection>
      </div>
    </PageShell>
  );
}

/**
 * 一行运行：状态 → 命令（唯一进详情的链接）→ 仓库 → 目标 → 耗时 / 成本 → 时间。
 *
 * 整行可点（`onClick` 进详情），但**链接只有一个**（命令格）：键盘用户 Tab 一次就够，
 * 也不需要每行两个同名目标。点链接时 `stopPropagation`，避免行与链接各导航一次。
 */
function RunRow({
  run,
  repoLock,
  onOpen,
}: {
  run: TaskListItem;
  repoLock: string | undefined;
  onOpen: () => void;
}) {
  const tone = statusTone(run.status);
  const time = formatTimeCell(run.queuedAt);
  const href = repoRunPath(repoLock ?? run.repo, run.id);

  return (
    <TableRow
      data-testid={`tasks-row-${run.id}`}
      onClick={onOpen}
      className="cursor-pointer"
    >
      <TableCell>
        <span className="flex items-center gap-1.5">
          <StatusDot tone={tone} label={run.status} pulse={run.status === 'running'} />
          <span className={cn('text-xs font-medium', TONE_TEXT[tone])}>{run.status}</span>
        </span>
      </TableCell>

      <TableCell>
        <span className="flex min-w-0 flex-col overflow-hidden">
          <span className="flex min-w-0 items-center gap-1.5">
            <Link
              to={href}
              onClick={(event) => {
                // 行本身也导航：链接自己处理掉，别让冒泡把同一次点击算两遍
                event.stopPropagation();
              }}
              className="min-w-0 truncate font-mono text-xs text-foreground underline-offset-2 hover:underline"
              title={run.command}
            >
              {run.command}
            </Link>
            <span className="shrink-0 text-2xs text-faint">{SOURCE_LABEL[run.source]}</span>
            {run.dryRun ? <span className="shrink-0 text-2xs text-warn-fg">dry-run</span> : null}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 overflow-hidden text-2xs text-faint">
            {run.failureClass === null ? null : <span className="shrink-0 text-danger-fg">{run.failureClass}</span>}
            {run.actorLogin === null ? null : <span className="min-w-0 truncate">{`由 ${run.actorLogin} 触发`}</span>}
            <span className="shrink-0 font-mono" title={run.id}>
              {run.id}
            </span>
          </span>
        </span>
      </TableCell>

      <TableCell className="hidden truncate font-mono text-xs text-muted-foreground lg:table-cell">{run.repo}</TableCell>

      <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
        {`${run.targetKind}#${formatCount(run.targetNumber)}`}
      </TableCell>

      <TableCell className="hidden text-right text-xs tabular text-muted-foreground md:table-cell" title="耗时">
        {formatDuration(run.durationMs)}
      </TableCell>

      <TableCell className="hidden text-right text-xs tabular text-muted-foreground md:table-cell" title="成本">
        {formatUsd(run.costUsd)}
      </TableCell>

      <TableCell className="text-right">
        <time className="text-2xs tabular text-faint" title={time.title} dateTime={run.queuedAt}>
          {time.text}
        </time>
      </TableCell>
    </TableRow>
  );
}
