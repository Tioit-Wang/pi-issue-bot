import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { AsyncSection } from '../components/AsyncSection.tsx';
import { StatusDot } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Select } from '../components/ui/select.tsx';
import { statusTone, TONE_TEXT } from '../components/ui/status.ts';
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
 * 这一页是**对象行**列表（不是数据表）：一行一次运行，读的顺序是
 * **状态点 → 命令 → 目标（repo#issue17）→ 耗时 / 成本 → 多久以前**，
 * 右侧整行可点进运行详情。`running` 的行状态点有轻微脉冲（reduced-motion 下自动静止）。
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
    return [...seen].sort().map((value) => ({ value, label: value }));
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
          {isFetching && !isLoading ? <span className="text-xs text-muted-foreground">刷新中…</span> : null}
          <Button variant="ghost" size="sm" disabled={!anyFilter} onClick={clearFilters} data-testid="tasks-clear">
            清除筛选
          </Button>
        </div>
      }
    >
      <div className="flex flex-wrap items-center gap-2" data-testid="tasks-filters">
        {repoLock === undefined ? (
          <Select
            aria-label="仓库筛选"
            options={repoOptions}
            placeholder="全部仓库"
            value={filters.repo}
            onChange={(event) => {
              setFilter('repo', event.target.value);
            }}
          />
        ) : null}
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
        isEmpty={items.length === 0}
        emptyText="没有匹配的运行"
        emptyHint={anyFilter ? '放宽条件或换个时间范围' : '在 issue 里 @ 机器人或发一条 /命令 就会出现'}
        emptyAction={
          anyFilter ? (
            <Button className="mt-1" variant="secondary" size="sm" onClick={clearFilters} data-testid="tasks-empty-clear">
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
          <ul className="flex min-w-0 flex-col rounded-lg border border-border bg-card px-1" data-testid="tasks-list">
            {items.map((run) => (
              <RunRow key={run.id} run={run} repoLock={repoLock} />
            ))}
          </ul>
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
              {hasNextPage === true
                ? isFetchingNextPage
                  ? '加载中…'
                  : `加载更多（已显示 ${loadedText} 条）`
                : `没有更多了（共 ${loadedText} 条）`}
            </Button>
          </div>
        </div>
      </AsyncSection>
    </PageShell>
  );
}

/** 一行运行：状态点 → 命令 → 目标 → 耗时 / 成本 → 时间。整行可点进详情。 */
function RunRow({ run, repoLock }: { run: TaskListItem; repoLock: string | undefined }) {
  const tone = statusTone(run.status);
  const time = formatTimeCell(run.queuedAt);
  const href = repoRunPath(repoLock ?? run.repo, run.id);

  return (
    <li className="min-w-0 border-b border-border last:border-0" data-testid={`tasks-row-${run.id}`}>
      <Link
        to={href}
        className={cn(
          'grid min-w-0 items-center gap-x-3 gap-y-0.5 py-1.5 pl-2',
          'grid-cols-[auto_minmax(0,1fr)_auto] md:grid-cols-[auto_minmax(0,1fr)_minmax(0,10rem)_4rem_4.5rem_5.5rem]',
          'border-l-2 border-transparent transition-[background-color] duration-[120ms] ease-out-quint hover:bg-muted',
        )}
      >
        <span className="flex items-center gap-1.5">
          <StatusDot tone={tone} label={run.status} pulse={run.status === 'running'} />
          <span className={cn('text-xs font-medium', TONE_TEXT[tone])}>{run.status}</span>
        </span>

        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate font-mono text-xs text-foreground" title={run.command}>
              {run.command}
            </span>
            <span className="shrink-0 text-2xs text-faint">{SOURCE_LABEL[run.source]}</span>
            {run.dryRun ? <span className="shrink-0 text-2xs text-warn-fg">dry-run</span> : null}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-2xs text-faint">
            <span className="min-w-0 truncate font-mono" title={`${run.repo} ${run.targetKind}#${String(run.targetNumber)}`}>
              {`${run.repo} ${run.targetKind}#${String(run.targetNumber)}`}
            </span>
            {run.failureClass === null ? null : <span className="shrink-0 text-danger-fg">{run.failureClass}</span>}
            {run.actorLogin === null ? null : <span className="shrink-0">{`由 ${run.actorLogin} 触发`}</span>}
            <span className="shrink-0 font-mono" title={run.id}>
              {run.id}
            </span>
          </span>
        </span>

        <span className="hidden min-w-0 truncate font-mono text-2xs text-faint md:block" title={run.headSha ?? undefined}>
          {run.headSha === null ? '—' : run.headSha.slice(0, 7)}
        </span>

        <span className="hidden text-right text-xs tabular text-muted-foreground md:block" title="耗时">
          {formatDuration(run.durationMs)}
        </span>

        <span className="hidden text-right text-xs tabular text-muted-foreground md:block" title="成本">
          {formatUsd(run.costUsd)}
        </span>

        <time className="justify-self-end text-2xs tabular text-faint md:justify-self-auto md:text-right" title={time.title} dateTime={run.queuedAt}>
          {time.text}
        </time>
      </Link>
    </li>
  );
}
