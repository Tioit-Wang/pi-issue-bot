import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Info, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { AsyncSection } from '../components/AsyncSection.tsx';
import { FilterSelect } from '../components/FilterSelect.tsx';
import { IssueConversation } from '../components/issues/IssueConversation.tsx';
import { IssueQueueRow, issueKey } from '../components/issues/issue-queue.tsx';
import { Rail } from '../components/Rail.tsx';
import { Toolbar } from '../components/Toolbar.tsx';
import { Button } from '../components/ui/button.tsx';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../components/ui/empty.tsx';
import { Input } from '../components/ui/input.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import { Spinner } from '../components/ui/spinner.tsx';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/ui/tooltip.tsx';
import type { IssueListItem, IssuesQuery } from '../lib/contract.ts';
import { formatCount } from '../lib/format.ts';
import { queueCountLabel } from '../lib/issue-counts.ts';
import { useIssueSession, useIssuesInfinite } from '../lib/queries.ts';
import { repoIssuePath, repoRunPath } from '../lib/repo-route.ts';

/**
 * Issue 队列（`/repos/:repo/issues`，以及「全部项目」的 `/`）—— **主从**布局。
 *
 * 这是 `AC-26` 之后**唯一**的列表页，所以它同时承担两件事：
 *   左 = **Issue 队列**（`FR-7.4` 的三左栏之一），右 = **会话流**（`Q-8`）。
 *
 * 版式按企业级 admin 的列表页形态：**一条工具栏**（筛选 / 搜索 → 右侧计数与动作）
 * → 双栏主体（左队列 + 右会话）→ 空 / 加载 / 错误态由 `AsyncSection` 统一给出。
 * 这里**不做**「表格式视图切换」：本页的核心交互是「点左栏换右栏」，
 * 表格视图没有 URL 语义也没有需求（`AC-27` 要求首屏就能看到会话流），
 * 加一个切不回去的视图开关只会让同一份数据有两条读法。
 *
 * 筛选分成两半，界线是**服务端有没有这个参数**（不发明后端行为）：
 *
 * | 筛选项 | 位置 | 键 | 说明 |
 * |---|---|---|---|
 * | 类型 / 状态 / 待人回答 | 服务端 | `kind` / `state` / `awaiting` / `status` | 契约里真实存在，进 queryKey |
 * | 搜索 | **客户端** | `q` | 契约 `issuesQuerySchema` 没有 `q`（标题只在 jsonb 投递里），debounce 300ms |
 * | 标签 | **客户端** | `label` | 契约没有 `label`（`.strict()` 会 400），只在已加载的行里精确匹配 |
 * | 时间窗 | **客户端** | `window` | 契约没有 `from`/`to`，按 `lastActivityAt` 过滤已加载的行 |
 *
 * 客户端那几项必须说清口径，否则「筛不到」会被当成「真的没有」：工具条右侧的 (i) 写明
 * 「只作用于已加载的 N 行」。
 *
 * 键盘（列表容器 `tabIndex=0`，`aria-keyshortcuts` 说明）：
 * `j` / `↓` 下一条、`k` / `↑` 上一条、`Enter` 打开整页详情、`/` 聚焦搜索、`Esc` 清筛选。
 * 输入框里打字时这些快捷键不接管（`isTypingTarget`）。
 */
const PAGE_SIZE = 20;

/**
 * 认识的 URL 键：同步时**只动这几个**，其余原样保留（`?mock=error` 这类 mock 参数）。
 */
const FILTER_KEYS = ['repo', 'kind', 'state', 'status', 'awaiting', 'label', 'window', 'q'] as const;
/** 选中键（`?selected=acme/widgets#issue17`）——单独一条，清除筛选时保留。 */
const SELECTED_KEY = 'selected';

type FilterKey = (typeof FILTER_KEYS)[number];
type Filters = Record<FilterKey, string>;

/* 每个下拉的第一项都是 `value: ''`（= 不筛选）：`FilterSelect` 把它渲染成「全部 X」。 */
const STATE_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'open', label: 'open' },
  { value: 'closed', label: 'closed' },
  { value: 'unknown', label: '状态未知' },
] as const;

const KIND_OPTIONS = [
  { value: '', label: 'Issue 与 PR' },
  { value: 'issue', label: 'Issue' },
  { value: 'pr', label: 'Pull request' },
] as const;

const AWAITING_OPTIONS = [
  { value: '', label: '是否待人回答' },
  { value: 'true', label: '待人回答' },
  { value: 'false', label: '不欠回答' },
] as const;

const STATUS_OPTIONS = [
  { value: '', label: '全部派生状态' },
  { value: 'running', label: '进行中' },
  { value: 'queued', label: '已排队' },
  { value: 'failed', label: '失败' },
  { value: 'answered', label: '已回复' },
  { value: 'idle', label: '无结果' },
] as const;

const WINDOW_OPTIONS = [
  { value: '', label: '全部时间' },
  { value: '24h', label: '最近 24 小时' },
  { value: '7d', label: '最近 7 天' },
  { value: '30d', label: '最近 30 天' },
] as const;

const WINDOW_MS: Record<string, number> = {
  '24h': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
};

function readFilters(params: URLSearchParams): Filters {
  const value = (key: FilterKey): string => params.get(key) ?? '';
  return {
    repo: value('repo'),
    kind: value('kind'),
    state: value('state'),
    status: value('status'),
    awaiting: value('awaiting'),
    label: value('label'),
    window: value('window'),
    q: value('q'),
  };
}

/** 搜索：标题、仓库、类型、编号（`#17` / `17` / `eacces` 都能命中）。 */
function matchesSearch(item: IssueListItem, needle: string): boolean {
  const query = needle.trim().toLowerCase();
  if (query === '') return true;
  const haystack = `${item.title ?? ''} ${item.repo} ${item.kind} ${String(item.number)}`.toLowerCase();
  return haystack.includes(query);
}

function matchesWindow(item: IssueListItem, windowKey: string, now: number): boolean {
  const span = WINDOW_MS[windowKey];
  if (span === undefined) return true;
  const at = Date.parse(item.lastActivityAt);
  // 时间解析不了就当「不在窗口内」：宁可少显示，也不把不确定的算成最近
  return !Number.isNaN(at) && now - at <= span;
}

function matchesLabel(item: IssueListItem, label: string): boolean {
  if (label === '') return true;
  return item.labels.includes(label);
}

/** 焦点在输入类控件里时不接管 j/k/`/`。 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export type IssuesPageProps = {
  /** 仓库锁：挂在 `/repos/:repo/issues` 下时由路由传入（仓库固定、下拉隐藏）。 */
  repoLock?: string;
};

export function IssuesPage({ repoLock }: IssuesPageProps = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const filters = readFilters(searchParams);
  const repoFilter = repoLock ?? filters.repo;

  /* 搜索框的本地草稿：输入立刻反映，300ms 后才写 URL（避免每敲一个字就重渲染整张表）。 */
  const [searchDraft, setSearchDraft] = useState(filters.q);
  const searchRef = useRef<HTMLInputElement | null>(null);
  /*
   * 最新的 URL 参数：debounce 的定时器回调必须基于**最新**参数改一个键，
   * 而不是用 300ms 前那份快照 —— 否则「清搜索」的定时器会把之后改的 `label` 冲掉。
   */
  const paramsRef = useRef<URLSearchParams>(searchParams);
  paramsRef.current = searchParams;

  useEffect(() => {
    setSearchDraft(filters.q);
  }, [filters.q]);

  useEffect(() => {
    if (searchDraft === filters.q) return;
    const timer = setTimeout(() => {
      const next = new URLSearchParams(paramsRef.current);
      if (searchDraft === '') next.delete('q');
      else next.set('q', searchDraft);
      setSearchParams(next, { replace: true });
    }, 300);
    return () => {
      clearTimeout(timer);
    };
  }, [searchDraft, filters.q, setSearchParams]);

  /*
   * 服务端参数只有契约里真实存在的这几个（`issuesQuerySchema` 是 `.strict()`：
   * 多带一个参数会被 400 顶回来）。**没有 `label` / `q` / `from` / `to`**。
   */
  const query = useMemo((): IssuesQuery => {
    const next: IssuesQuery = { limit: PAGE_SIZE };
    if (repoFilter !== '') next.repo = repoFilter;
    if (filters.kind !== '') next.kind = filters.kind as IssueListItem['kind'];
    if (filters.status !== '') next.status = filters.status as IssuesQuery['status'];
    if (filters.state !== '') next.state = filters.state as IssueListItem['state'];
    if (filters.awaiting !== '') next.awaiting = filters.awaiting as 'true' | 'false';
    return next;
  }, [repoFilter, filters.kind, filters.status, filters.state, filters.awaiting]);

  const { data, error, isLoading, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage, refetch } =
    useIssuesInfinite(query);

  const loaded = useMemo(() => data?.pages.flatMap((page) => page.issues) ?? [], [data]);
  /**
   * 队列头部的计数是**全量口径**（`FR-7.4`）：`totalEstimate` 与上面的 `issues` 共用
   * 服务端同一份筛选谓词，且不带游标（带游标总数会随翻页变小）。
   * `null` = 服务端没统计 → 头部显示「已加载 N 项」并说明口径，绝不写成 0。
   * 只取**第一页**的值：翻页不改变总数，用后面那页的只会让缓存里多一份同样的数。
   */
  const totalEstimate = data?.pages.at(0)?.totalEstimate ?? null;
  const now = useMemo(() => Date.now(), []);
  const rows = useMemo(
    () =>
      loaded.filter(
        (item) =>
          matchesSearch(item, filters.q) &&
          matchesWindow(item, filters.window, now) &&
          matchesLabel(item, filters.label),
      ),
    [loaded, filters.q, filters.window, filters.label, now],
  );

  const selectedValue = searchParams.get(SELECTED_KEY);
  /*
   * 默认选第一条：`AC-27` 要求「打开任一 issue，首屏就能看到标题行 / 原文卡 / 系统提示词」——
   * 空白右栏等于把「它卡在哪」推到第二次点击。URL 里的 `?selected=` 仍然优先（可分享）。
   */
  const selected = useMemo(() => {
    if (rows.length === 0) return null;
    if (selectedValue === null) return rows[0] ?? null;
    return rows.find((item) => issueKey(item) === selectedValue) ?? rows[0] ?? null;
  }, [rows, selectedValue]);

  const anyFilter = FILTER_KEYS.some((key) => (key === 'repo' && repoLock !== undefined ? false : filters[key] !== ''));
  const clientFilter = filters.q !== '' || filters.window !== '' || filters.label !== '';

  /*
   * 三个分桶（待处理 / 运行中 / 失败）只在状态带上用，而状态带的 hook（`lib/issue-counts.ts`）
   * 自己去取同一份 `/api/issues`。队列这里不再算一遍 —— 否则两处口径必然分叉
   * （这正是 `FR-7.2` 要防止的「状态带说 5 个失败、列表里只有 3 条」）。
   */

  /** 标签候选 = 已加载数据里的标签 ∪ 当前选中值（不凭空造标签清单）。 */
  const labelOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const item of loaded) for (const label of item.labels) seen.add(label);
    if (filters.label !== '') seen.add(filters.label);
    return [
      { value: '', label: '全部标签' },
      ...[...seen].sort().map((value) => ({ value, label: value })),
    ];
  }, [loaded, filters.label]);

  /** 仓库候选 = 已加载数据里的仓库 ∪ 当前选中值（契约里没有仓库清单接口，不凭空造）。 */
  const repoOptions = useMemo(() => {
    const seen = new Set(loaded.map((item) => item.repo));
    if (filters.repo !== '') seen.add(filters.repo);
    return [
      { value: '', label: '全部仓库' },
      ...[...seen].sort().map((value) => ({ value, label: value })),
    ];
  }, [loaded, filters.repo]);

  const patchParams = useMemo(
    () =>
      (mutate: (next: URLSearchParams) => void): void => {
        // 复制一份再改：`?mock=error` 这类外部参数必须原样留着
        const next = new URLSearchParams(searchParams);
        mutate(next);
        setSearchParams(next, { replace: true });
      },
    [searchParams, setSearchParams],
  );

  const setFilter = (key: FilterKey, value: string): void => {
    patchParams((next) => {
      if (value === '') next.delete(key);
      else next.set(key, value);
    });
  };

  const clearFilters = (): void => {
    setSearchDraft('');
    patchParams((next) => {
      for (const key of FILTER_KEYS) next.delete(key);
      next.delete(SELECTED_KEY);
    });
  };

  const select = (item: IssueListItem): void => {
    patchParams((next) => {
      next.set(SELECTED_KEY, issueKey(item));
    });
  };

  const openDetail = (item: IssueListItem): void => {
    void navigate(repoIssuePath(repoLock ?? item.repo, item.kind, item.number));
  };

  /* 键盘：j/k/↑↓ 移动选中、Enter 打开、`/` 聚焦搜索、Esc 清筛选。 */
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const typing = isTypingTarget(event.target);

      if (event.key === '/' && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }

      if (event.key === 'Escape') {
        if (typing) {
          searchRef.current?.blur();
        }
        if (anyFilter || clientFilter) clearFilters();
        return;
      }

      if (typing || event.key === 'Tab') return;

      const isNext = event.key === 'j' || event.key === 'ArrowDown';
      const isPrev = event.key === 'k' || event.key === 'ArrowUp';
      if (isNext || isPrev) {
        if (rows.length === 0) return;
        event.preventDefault();
        const currentIndex = selected === null ? -1 : rows.findIndex((item) => issueKey(item) === issueKey(selected));
        const nextIndex = isNext
          ? Math.min(rows.length - 1, currentIndex + 1)
          : Math.max(0, currentIndex <= 0 ? 0 : currentIndex - 1);
        const target = rows[nextIndex];
        if (target !== undefined) select(target);
        return;
      }

      if (event.key === 'Enter' && selected !== null) {
        event.preventDefault();
        openDetail(selected);
      }
    };

    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, [rows, selected, anyFilter, clientFilter, clearFilters, select, openDetail]);

  /*
   * 两处计数**口径不同且都写清**（不拿一个数字冒充另一个）：
   *  - `totalEstimate` = 服务端按同一组**服务端筛选**算出的全量总数（翻页不改变它）；
   *  - `loaded.length` / `rows.length` = 已经拉到浏览器的行数 / 客户端再筛之后的可见行数。
   */
  const caption =
    totalEstimate === null
      ? `按最后更新倒序 · 已加载 ${formatCount(loaded.length)} 行（服务端没有返回全量计数）`
      : `按最后更新倒序 · 共 ${formatCount(totalEstimate)} 行（全量口径）· 已加载 ${formatCount(loaded.length)} 行${
          rows.length === loaded.length ? '' : ` · 筛选后 ${formatCount(rows.length)} 行`
        }`;

  /**
   * rail 头部的计数（`FR-7.4` 的「30px 小标 + 计数」）：
   * - 只有服务端筛选时给**全量**（`totalEstimate`）—— 这正是 `FR-7.4` 要的「计数」；
   * - 客户端筛选（标签 / 搜索 / 时间窗）只作用于已加载行，此时全量数字与眼前的行无关，
   *   如实退回「已加载 N 项」，不拿全量冒充筛选结果；
   * - `totalEstimate` 为 `null`（服务端没统计）时同样写「已加载 N 项」，不写 0。
   */
  const railCountText = clientFilter
    ? `已加载 ${formatCount(rows.length)} 项`
    : queueCountLabel(totalEstimate, loaded.length, '项');

  const copyLink = (item: IssueListItem): void => {
    const url = `${window.location.origin}${repoIssuePath(repoLock ?? item.repo, item.kind, item.number)}`;
    void navigator.clipboard
      .writeText(url)
      .then(() => {
        toast.success('链接已复制', { description: url });
      })
      .catch(() => {
        toast.error('复制失败', { description: '浏览器拒绝了剪贴板写入' });
      });
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="issues">
      {/* ① 工具栏：搜索 + 筛选在左，计数 / 病灶说明 / 动作在右（企业级列表页的第一行） */}
      <Toolbar
        meta={clientFilter ? `筛选后 ${formatCount(rows.length)} / 已加载 ${formatCount(loaded.length)} 行` : undefined}
        actions={
          <>
            {isFetching && !isLoading ? (
              <span className="flex items-center gap-1.5 text-2xs text-muted-foreground" data-testid="issues-fetching">
                <Spinner className="size-3" />
                刷新中
              </span>
            ) : null}
            {clientFilter ? (
              // 口径必须贴在筛选旁：标签 / 搜索 / 时间窗只覆盖已加载的行
              <TooltipProvider delayDuration={0}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label="筛选范围" data-testid="issues-filter-scope">
                      <Info aria-hidden strokeWidth={2} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {`标签 / 搜索 / 时间窗只筛选已加载的 ${formatCount(loaded.length)} 行：服务端没有这些参数`}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void refetch();
              }}
              data-testid="issues-refresh"
            >
              <RefreshCw aria-hidden />
              刷新
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!anyFilter && selectedValue === null}
              onClick={clearFilters}
              data-testid="issues-clear"
            >
              清除筛选
            </Button>
          </>
        }
      >
        <Input
          ref={searchRef}
          type="search"
          aria-label="搜索标题或编号"
          placeholder="搜索标题 / 编号（/）"
          value={searchDraft}
          onChange={(event) => {
            setSearchDraft(event.target.value);
          }}
          className="h-8 w-56"
          data-testid="issues-search"
        />
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
          label="类型筛选"
          options={KIND_OPTIONS}
          value={filters.kind}
          onChange={(next) => {
            setFilter('kind', next);
          }}
        />
        <FilterSelect
          label="状态筛选"
          options={STATE_OPTIONS}
          value={filters.state}
          onChange={(next) => {
            setFilter('state', next);
          }}
        />
        <FilterSelect
          label="派生状态筛选"
          options={STATUS_OPTIONS}
          value={filters.status}
          onChange={(next) => {
            setFilter('status', next);
          }}
        />
        <FilterSelect
          label="标签筛选"
          options={labelOptions}
          value={filters.label}
          onChange={(next) => {
            setFilter('label', next);
          }}
        />
        <FilterSelect
          label="待人回答筛选"
          options={AWAITING_OPTIONS}
          value={filters.awaiting}
          onChange={(next) => {
            setFilter('awaiting', next);
          }}
        />
        <FilterSelect
          label="时间窗筛选"
          options={WINDOW_OPTIONS}
          value={filters.window}
          onChange={(next) => {
            setFilter('window', next);
          }}
        />
      </Toolbar>

      <AsyncSection
        isLoading={isLoading}
        error={error}
        isEmpty={rows.length === 0}
        emptyText={
          anyFilter || clientFilter
            ? `当前筛选下没有会话${clientFilter ? `（标签/搜索/时间窗只覆盖已加载的 ${formatCount(loaded.length)} 行，可以继续加载或清除筛选）` : '。换个仓库/类型/状态，或清除筛选。'}`
            : '还没有处理过的 Issue 会话 —— 在 issue 里 @ 机器人 或发一条 /命令 就会出现在这里。'
        }
        onRetry={() => {
          void refetch();
        }}
        skeletonRows={6}
        testId="issues"
        fill
      >
        {/* 主从：左 Issue 队列（`FR-7.4` 的三左栏之一）+ 右会话流（`Q-8`） */}
        <div className="flex min-h-0 min-w-0 flex-1 gap-0" data-testid="issues-split">
          <aside
            tabIndex={0}
            role="group"
            aria-label="Issue 队列（j/k 移动，Enter 打开）"
            aria-keyshortcuts="j k ArrowUp ArrowDown Enter / Escape"
            className="flex min-h-0 min-w-0 flex-col"
          >
            <Rail
              label="Issue 队列"
              count={railCountText}
              ariaLabel="Issue 队列"
              testId="issue-rail"
              className="flex-1"
            >
              {rows.map((item) => (
                <IssueQueueRow
                  key={issueKey(item)}
                  item={item}
                  selected={selected !== null && issueKey(selected) === issueKey(item)}
                  showRepo={repoLock === undefined}
                  onSelect={select}
                  onOpen={openDetail}
                  now={now}
                />
              ))}
              <div className="flex items-center justify-center gap-2 border-t border-border p-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="issues-load-more"
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
                      `加载更多（已加载 ${formatCount(loaded.length)} 个）`
                    )
                  ) : (
                    `没有更多了（共 ${formatCount(loaded.length)} 个）`
                  )}
                </Button>
              </div>
            </Rail>
          </aside>

          <section className="min-h-0 min-w-0 flex-1 overflow-y-auto px-3" aria-live="polite">
            {selected === null ? (
              <Empty data-testid="issues-preview-empty" className="py-10">
                <EmptyHeader>
                  <EmptyTitle>还没有可预览的会话</EmptyTitle>
                  <EmptyDescription>从左边选一条 issue，会话流会显示在这里。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <SelectedConversation item={selected} repoLock={repoLock} onCopyLink={copyLink} />
            )}
          </section>
        </div>
      </AsyncSection>

      <p className="pt-1 text-2xs text-faint" data-testid="issues-caption">
        {caption}
      </p>
    </div>
  );
}

/**
 * 右侧：选中项的**完整会话流**（`Q-8` / `AC-27`）。
 *
 * 与 `/repos/:repo/issues/:kind/:number` 用的是同一个 `IssueConversation` 组件：
 * 详情页是「刷新 / 分享 / 新标签页都可用」的稳定地址，这里是「点一下就换」的同一份内容。
 * 两处共用组件是 `AC-28`/`AC-29` 不会两边画法不一致的唯一办法。
 */
function SelectedConversation({
  item,
  repoLock,
  onCopyLink,
}: {
  item: IssueListItem;
  repoLock: string | undefined;
  onCopyLink: (item: IssueListItem) => void;
}) {
  const slash = item.repo.indexOf('/');
  const owner = slash < 0 ? item.repo : item.repo.slice(0, slash);
  const name = slash < 0 ? '' : item.repo.slice(slash + 1);
  const session = useIssueSession({ owner, name, kind: item.kind, number: item.number });
  const repo = repoLock ?? item.repo;

  if (session.isLoading) {
    return (
      <div className="flex flex-col gap-1 p-2" data-testid="issues-preview-loading">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={`skeleton-${String(index)}`} className="h-9 w-full rounded-md" />
        ))}
      </div>
    );
  }

  if (session.error !== null) {
    return (
      <AsyncSection
        isLoading={false}
        error={session.error}
        testId="issue-preview"
        onRetry={() => {
          void session.refetch();
        }}
      >
        {null}
      </AsyncSection>
    );
  }

  if (session.data === null || session.data === undefined) {
    return (
      <AsyncSection
        isLoading={false}
        error={null}
        isEmpty
        emptyText="这个 issue 没有会话记录"
        emptyHint="接口返回 404：没有任何任务处理过它"
        testId="issue-preview"
        onRetry={() => {
          void session.refetch();
        }}
      >
        {null}
      </AsyncSection>
    );
  }

  return (
    <IssueConversation
      data={session.data}
      taskHref={(taskId) => repoRunPath(repo, taskId)}
      onCopyLink={() => {
        onCopyLink(item);
      }}
    />
  );
}
