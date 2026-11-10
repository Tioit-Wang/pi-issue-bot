import { Info } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { AsyncSection } from '../components/AsyncSection.tsx';
import { IssueTable, issueKey } from '../components/issues/issue-table.tsx';
import { ReactionChip } from '../components/issues/reaction-chip.tsx';
import { readLabelDecision, readReactionState } from '../components/issues/contract-extras.ts';
import { ISSUE_STATE_LABEL, ISSUE_STATE_TONE, presentStatus } from '../components/issues/status.ts';
import { Toolbar } from '../components/Toolbar.tsx';
import { Badge, StatusDot } from '../components/ui/badge.tsx';
import { Button, buttonVariants } from '../components/ui/button.tsx';
import { Select } from '../components/ui/select.tsx';
import { TONE_TEXT } from '../components/ui/status.ts';
import { useToast } from '../components/ui/toast.tsx';
import { Tooltip } from '../components/ui/tooltip.tsx';
import type { IssueListItem, IssuesQuery } from '../lib/contract.ts';
import { EMPTY, formatCount, formatTimeCell } from '../lib/format.ts';
import { useIssuesInfinite, useIssueSession } from '../lib/queries.ts';
import { repoIssuePath } from '../lib/repo-route.ts';
import { useViewportMode } from '../layout/use-viewport.ts';
import { cn } from '../lib/utils.ts';
import { PageShell } from './PageShell.tsx';

/**
 * Issue 中心（`/repos/:repo/issues`；`/issues` 已重定向到这里）—— **主从**布局。
 *
 * 左列表（对象行）+ 右概要（当前选中项），一屏回答两件事：**有没有事等我**
 * 与 **这个 issue 处理成什么样了**。详情页仍然是独立路由
 * （`/repos/:repo/issues/:kind/:number`），刷新 / 分享 / 新标签页都可用。
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
 * 客户端那三项必须说清口径，否则「搜不到」会被当成「真的没有」：列表 caption 与
 * 工具条右侧都写明「只作用于已加载的 N 行」。
 *
 * 键盘（列表容器 `tabIndex=0`，`aria-keyshortcuts` 说明）：
 * `j` / `↓` 下一条、`k` / `↑` 上一条、`Enter` 打开选中项详情、`/` 聚焦搜索、`Esc` 清筛选。
 * 输入框里打字时这些快捷键不接管（`isTypingTarget`）。
 */
const PAGE_SIZE = 10;

/** 认识的 URL 键：同步时**只动这几个**，其余原样保留（`?mock=error` 这类 mock 参数）。 */
const FILTER_KEYS = ['repo', 'kind', 'state', 'status', 'awaiting', 'label', 'window', 'q'] as const;
/** 选中键（`?selected=acme/widgets#issue17`）——单独一条，清除筛选时保留。 */
const SELECTED_KEY = 'selected';

type FilterKey = (typeof FILTER_KEYS)[number];
type Filters = Record<FilterKey, string>;

const STATE_OPTIONS = [
  { value: 'open', label: 'open' },
  { value: 'closed', label: 'closed' },
  { value: 'unknown', label: '状态未知' },
] as const;

const KIND_OPTIONS = [
  { value: 'issue', label: 'Issue' },
  { value: 'pr', label: 'Pull request' },
] as const;

const AWAITING_OPTIONS = [
  { value: 'true', label: '待人回答' },
  { value: 'false', label: '不欠回答' },
] as const;

const STATUS_OPTIONS = [
  { value: 'running', label: '进行中' },
  { value: 'queued', label: '已排队' },
  { value: 'failed', label: '失败' },
  { value: 'answered', label: '已回复' },
  { value: 'idle', label: '无结果' },
] as const;

const WINDOW_OPTIONS = [
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
  const viewport = useViewportMode();
  const toast = useToast();

  const filters = readFilters(searchParams);
  const repoFilter = repoLock ?? filters.repo;

  /* 搜索框的本地草稿：输入立刻反映，300ms 后才写 URL（避免每敲一个字就重渲染整张表）。 */
  const [searchDraft, setSearchDraft] = useState(filters.q);
  const searchRef = useRef<HTMLInputElement | null>(null);
  /*
   * 最新的 URL 参数：debounce 的定时器回调必须基于**最新**参数改一个键，
   * 而不是用 300ms 前那份快照 —— 否则「清搜索」的定时器会把之后改的 `label` 冲掉。
   */
  const listRef = useRef<HTMLDivElement | null>(null);
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
  const selected = useMemo(
    () => rows.find((item) => issueKey(item) === selectedValue) ?? null,
    [rows, selectedValue],
  );

  const anyFilter = FILTER_KEYS.some((key) => (key === 'repo' && repoLock !== undefined ? false : filters[key] !== ''));
  const clientFilter = filters.q !== '' || filters.window !== '' || filters.label !== '';

  const summary = useMemo(() => {
    let running = 0;
    let failed = 0;
    let awaiting = 0;
    for (const item of rows) {
      const status = presentStatus(item, now);
      if (status.status === 'running' || status.status === 'queued') running += 1;
      if (status.status === 'failed') failed += 1;
      if (item.awaitingReply) awaiting += 1;
    }
    return { running, failed, awaiting };
  }, [rows, now]);

  /** 标签候选 = 已加载数据里的标签 ∪ 当前选中值（不凭空造标签清单）。 */
  const labelOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const item of loaded) for (const label of item.labels) seen.add(label);
    if (filters.label !== '') seen.add(filters.label);
    return [...seen].sort().map((value) => ({ value, label: value }));
  }, [loaded, filters.label]);

  const showOwner = useMemo(() => new Set(loaded.map((item) => item.repo)).size > 1, [loaded]);

  const patchParams = useCallback(
    (mutate: (next: URLSearchParams) => void): void => {
      // 复制一份再改：`?mock=error` 这类外部参数必须原样留着
      const next = new URLSearchParams(searchParams);
      mutate(next);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const setFilter = useCallback(
    (key: FilterKey, value: string): void => {
      patchParams((next) => {
        if (value === '') next.delete(key);
        else next.set(key, value);
      });
    },
    [patchParams],
  );

  const toggleFilter = useCallback(
    (key: FilterKey, value: string): void => {
      setFilter(key, filters[key] === value ? '' : value);
    },
    [filters, setFilter],
  );

  const clearFilters = useCallback((): void => {
    setSearchDraft('');
    patchParams((next) => {
      for (const key of FILTER_KEYS) next.delete(key);
      next.delete(SELECTED_KEY);
    });
  }, [patchParams]);

  /** 选中：宽屏只改 URL（右侧出概要）；窄屏直接进整页详情。 */
  const select = useCallback(
    (item: IssueListItem): void => {
      if (viewport !== 'wide') {
        void navigate(repoIssuePath(repoLock ?? item.repo, item.kind, item.number));
        return;
      }
      patchParams((next) => {
        next.set(SELECTED_KEY, issueKey(item));
      });
    },
    [viewport, navigate, repoLock, patchParams],
  );

  const openDetail = useCallback(
    (item: IssueListItem): void => {
      void navigate(repoIssuePath(repoLock ?? item.repo, item.kind, item.number));
    },
    [navigate, repoLock],
  );

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

  const caption =
    rows.length === loaded.length
      ? `共 ${formatCount(rows.length)} 行 · 按最后更新倒序`
      : `显示 ${formatCount(rows.length)} / 已加载 ${formatCount(loaded.length)} 行 · 按最后更新倒序`;

  return (
    <PageShell
      title="Issue 中心"
      actions={
        <div className="flex items-center gap-2">
          {isFetching && !isLoading ? <span className="text-xs text-muted-foreground">刷新中…</span> : null}
          <Button
            variant="ghost"
            size="sm"
            disabled={!anyFilter && selectedValue === null}
            onClick={clearFilters}
            data-testid="issues-clear"
          >
            清除筛选
          </Button>
        </div>
      }
    >
      <div className="flex min-w-0 flex-col gap-2">
        <Toolbar
          meta={
            clientFilter
              ? `已加载 ${formatCount(loaded.length)} 行 · 筛选后 ${formatCount(rows.length)} 行`
              : `已加载 ${formatCount(loaded.length)} 行`
          }
          actions={
            <>
              <span className="text-2xs text-faint">j/k 移动 · Enter 打开 · / 搜索 · Esc 清筛选</span>
              {clientFilter ? (
                <Tooltip
                  label={`标签 / 搜索 / 时间窗只筛选已加载的 ${formatCount(loaded.length)} 行：服务端没有这些参数`}
                >
                  <button
                    type="button"
                    aria-label="筛选范围"
                    data-testid="issues-filter-scope"
                    className="grid size-5 place-items-center rounded-sm text-faint transition-[color] duration-[120ms] ease-out-quint hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                  >
                    <Info aria-hidden className="size-3" strokeWidth={2} />
                  </button>
                </Tooltip>
              ) : null}
            </>
          }
        >
          <input
            ref={searchRef}
            type="search"
            aria-label="搜索标题或编号"
            placeholder="搜索标题 / 编号（/）"
            value={searchDraft}
            onChange={(event) => {
              setSearchDraft(event.target.value);
            }}
            className={cn(
              'h-8 w-56 min-w-0 rounded-md border border-input bg-card px-2 text-sm text-foreground',
              'transition-[border-color,background-color] duration-[120ms] ease-out-quint',
              'hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
            )}
            data-testid="issues-search"
          />
          {repoLock === undefined ? (
            <Select
              aria-label="仓库筛选"
              options={[...new Set(loaded.map((item) => item.repo))].sort().map((value) => ({ value, label: value }))}
              placeholder="全部仓库"
              value={filters.repo}
              onChange={(event) => {
                setFilter('repo', event.target.value);
              }}
            />
          ) : null}
          <Select
            aria-label="类型筛选"
            options={KIND_OPTIONS}
            placeholder="Issue 与 PR"
            value={filters.kind}
            onChange={(event) => {
              setFilter('kind', event.target.value);
            }}
          />
          <Select
            aria-label="状态筛选"
            options={STATE_OPTIONS}
            placeholder="全部状态"
            value={filters.state}
            onChange={(event) => {
              setFilter('state', event.target.value);
            }}
          />
          <Select
            aria-label="派生状态筛选"
            options={STATUS_OPTIONS}
            placeholder="全部派生状态"
            value={filters.status}
            onChange={(event) => {
              setFilter('status', event.target.value);
            }}
          />
          <Select
            aria-label="标签筛选"
            options={labelOptions}
            placeholder="全部标签"
            value={filters.label}
            onChange={(event) => {
              setFilter('label', event.target.value);
            }}
          />
          <Select
            aria-label="待人回答筛选"
            options={AWAITING_OPTIONS}
            placeholder="是否待人回答"
            value={filters.awaiting}
            onChange={(event) => {
              setFilter('awaiting', event.target.value);
            }}
          />
          <Select
            aria-label="时间窗筛选"
            options={WINDOW_OPTIONS}
            placeholder="全部时间"
            value={filters.window}
            onChange={(event) => {
              setFilter('window', event.target.value);
            }}
          />
        </Toolbar>

        {loaded.length === 0 ? null : (
          <p className="flex flex-wrap items-center gap-1 px-1 text-xs text-muted-foreground" data-testid="issues-summary">
            <span className="text-faint">{`已加载 ${formatCount(loaded.length)} 行`}</span>
            <span aria-hidden>·</span>
            <ToggleCount
              testId="issues-summary-running"
              tone="warn"
              label="进行中"
              count={summary.running}
              pressed={filters.status === 'running'}
              onClick={() => {
                toggleFilter('status', 'running');
              }}
            />
            <ToggleCount
              testId="issues-summary-failed"
              tone="danger"
              label="失败"
              count={summary.failed}
              pressed={filters.status === 'failed'}
              onClick={() => {
                toggleFilter('status', 'failed');
              }}
            />
            <ToggleCount
              testId="issues-summary-awaiting"
              tone="warn"
              label="待人回答"
              count={summary.awaiting}
              pressed={filters.awaiting === 'true'}
              onClick={() => {
                toggleFilter('awaiting', 'true');
              }}
            />
          </p>
        )}
      </div>

      <AsyncSection
        isLoading={isLoading}
        error={error}
        isEmpty={rows.length === 0}
        emptyText={
          anyFilter || clientFilter
            ? `当前筛选下没有会话${clientFilter ? `（标签/搜索/时间窗只覆盖已加载的 ${formatCount(loaded.length)} 行，可以继续加载或清除筛选）` : '。换个仓库/类型/状态，或清除筛选。'}`
            : '还没有处理过的 Issue 会话 —— 在 issue 里 @ 机器人或发一条 /命令 就会出现在这里（去「系统」页可确认在线状态）。'
        }
        onRetry={() => {
          void refetch();
        }}
        skeletonRows={6}
        testId="issues"
      >
        <div className="flex min-w-0 flex-col gap-3" data-testid="issues-list">
          {/* ≥1280 并排：左列表 + 右概要；更窄时右侧隐藏，点行直接进整页详情 */}
          <div
            ref={listRef}
            tabIndex={0}
            role="group"
            aria-label="Issue 列表（j/k 移动，Enter 打开）"
            aria-keyshortcuts="j k ArrowUp ArrowDown Enter / Escape"
            className="grid min-w-0 gap-3 rounded-lg border border-border bg-card p-1 xl:grid-cols-[minmax(0,1fr)_22rem]"
          >
            <div className="min-w-0">
              <IssueTable
                rows={rows}
                selectedKey={selected === null ? null : issueKey(selected)}
                onSelect={select}
                showRepo={repoLock === undefined}
                showOwner={showOwner}
                caption={caption}
                repoLock={repoLock}
              />
            </div>
            <aside className="hidden min-w-0 border-l border-border pl-3 xl:block" aria-live="polite">
              <IssuePreview
                item={selected}
                onOpenDetail={openDetail}
                onCopyLink={(item) => {
                  const url = `${window.location.origin}${repoIssuePath(repoLock ?? item.repo, item.kind, item.number)}`;
                  void navigator.clipboard
                    .writeText(url)
                    .then(() => {
                      toast.push({ tone: 'success', title: '链接已复制', description: url });
                    })
                    .catch(() => {
                      toast.push({ tone: 'danger', title: '复制失败', description: '浏览器拒绝了剪贴板写入' });
                    });
                }}
              />
            </aside>
          </div>

          <div className="flex items-center justify-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              data-testid="issues-load-more"
              disabled={hasNextPage !== true || isFetchingNextPage}
              onClick={() => {
                void fetchNextPage();
              }}
            >
              {hasNextPage === true
                ? isFetchingNextPage
                  ? '加载中…'
                  : `加载更多（已加载 ${formatCount(loaded.length)} 个）`
                : `没有更多了（共 ${formatCount(loaded.length)} 个）`}
            </Button>
          </div>
        </div>
      </AsyncSection>
    </PageShell>
  );
}

function ToggleCount({
  testId,
  tone,
  label,
  count,
  pressed,
  onClick,
}: {
  testId: string;
  tone: 'warn' | 'danger';
  label: string;
  count: number;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      data-testid={testId}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-sm px-1 py-0.5 transition-[background-color,color] duration-[120ms] ease-out-quint hover:bg-muted',
        TONE_TEXT[tone],
      )}
    >
      <StatusDot tone={tone} />
      {label}
      <span className="tabular">{formatCount(count)}</span>
    </button>
  );
}

/* ── 右侧概要（当前选中项） ───────────────────────────────────────────────── */

function IssuePreview({
  item,
  onOpenDetail,
  onCopyLink,
}: {
  item: IssueListItem | null;
  onOpenDetail: (item: IssueListItem) => void;
  onCopyLink: (item: IssueListItem) => void;
}) {
  if (item === null) {
    return (
      <div className="flex h-full flex-col gap-1 p-2" data-testid="issue-preview-empty">
        <p className="text-sm text-foreground">未选中会话</p>
      </div>
    );
  }

  return <IssuePreviewBody item={item} onOpenDetail={onOpenDetail} onCopyLink={onCopyLink} />;
}

function IssuePreviewBody({
  item,
  onOpenDetail,
  onCopyLink,
}: {
  item: IssueListItem;
  onOpenDetail: (item: IssueListItem) => void;
  onCopyLink: (item: IssueListItem) => void;
}) {
  const slash = item.repo.indexOf('/');
  const owner = slash < 0 ? item.repo : item.repo.slice(0, slash);
  const name = slash < 0 ? '' : item.repo.slice(slash + 1);
  const session = useIssueSession({ owner, name, kind: item.kind, number: item.number });
  const now = Date.now();
  const status = presentStatus(item, now);
  const reaction = readReactionState(item);
  const decision = readLabelDecision(item);
  const issue = session.data?.issue ?? null;
  const turns = session.data?.turns ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-2.5 p-2" data-testid="issue-preview">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <StatusDot tone={status.tone} label={status.label} pulse={status.status === 'running' && !status.stalled} />
          <span className={cn('text-xs font-medium', TONE_TEXT[status.tone])}>{status.label}</span>
          <Badge tone={ISSUE_STATE_TONE[item.state]}>{ISSUE_STATE_LABEL[item.state]}</Badge>
          {item.awaitingReply ? <Badge tone="warn">待人回答</Badge> : null}
        </span>
        <h3 className="min-w-0 text-sm font-semibold text-foreground" title={item.title ?? undefined}>
          <span className="font-mono text-xs text-faint">{`${item.kind}#${String(item.number)} `}</span>
          {item.title ?? '（取不到标题）'}
        </h3>
        <span className="min-w-0 truncate font-mono text-2xs text-faint" title={item.repo}>
          {item.repo}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <ReactionChip state={reaction} />
        {item.labels.length === 0 ? (
          <span className="text-xs text-muted-foreground">没有标签</span>
        ) : (
          item.labels.slice(0, 4).map((label) => (
            <Badge key={label} tone="neutral" className="max-w-full truncate">
              {label}
            </Badge>
          ))
        )}
        {item.labels.length > 4 ? <span className="text-2xs text-faint">{`+${String(item.labels.length - 4)}`}</span> : null}
      </div>

      <AsyncSection
        isLoading={session.isLoading}
        error={session.error}
        isEmpty={session.data === null && !session.isLoading}
        emptyText="这个 issue 没有会话记录"
        emptyHint="接口返回 404：没有任何任务处理过它"
        onRetry={() => {
          void session.refetch();
        }}
        skeletonRows={3}
        testId="issue-preview-session"
      >
        <div className="flex min-w-0 flex-col gap-2 text-xs">
          <dl className="grid min-w-0 grid-cols-2 gap-x-2 gap-y-1">
            <Meta label="人类轮次" value={formatCount(item.humanTurns)} />
            <Meta label="机器人轮次" value={formatCount(item.botTurns)} />
            <Meta label="最后活动" value={formatTimeCell(item.lastActivityAt).text} title={formatTimeCell(item.lastActivityAt).title} />
            <Meta
              label="最后回复"
              value={item.lastReplyAt === null ? EMPTY : formatTimeCell(item.lastReplyAt).text}
              title={item.lastReplyAt === null ? 'dry-run 仓库不写 actions 行，这个值会是空的（≠ 没回过）' : undefined}
            />
          </dl>

          {decision?.reason === null || decision === null ? null : (
            <p className="min-w-0 break-words text-muted-foreground">
              <span className="text-faint">打标理由：</span>
              {decision.reason}
            </p>
          )}

          {issue === null ? null : (
            <p className="min-w-0 break-words text-muted-foreground">
              <span className="text-faint">参与者：</span>
              {issue.participants.length === 0 ? EMPTY : issue.participants.join('、')}
            </p>
          )}

          <div className="flex min-w-0 flex-col gap-1">
            <p className="micro-label">最近轮次</p>
            {turns.length === 0 ? (
              <p className="text-muted-foreground">还没有轮次</p>
            ) : (
              <ol className="flex min-w-0 flex-col gap-1">
                {turns.slice(-3).reverse().map((turn) => (
                  <li key={turn.id} className="flex min-w-0 items-center gap-1.5">
                    <Badge tone={turn.role === 'human' ? 'neutral' : 'info'}>{turn.role === 'human' ? '人' : '机'}</Badge>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground" title={turn.text ?? undefined}>
                      {turn.text === null || turn.text === '' ? '（没有正文）' : turn.text}
                    </span>
                    <time className="shrink-0 text-2xs text-faint" title={formatTimeCell(turn.at).title}>
                      {formatTimeCell(turn.at).text}
                    </time>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </AsyncSection>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            onOpenDetail(item);
          }}
          data-testid="issue-preview-open"
        >
          打开完整详情
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onCopyLink(item);
          }}
          data-testid="issue-preview-copy"
        >
          复制链接
        </Button>
        {item.url === null ? null : (
          <a
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
            href={item.url}
            target="_blank"
            rel="noreferrer"
          >
            打开 GitHub
          </a>
        )}
      </div>
    </div>
  );
}

function Meta({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-2xs text-faint">{label}</span>
      <span className="min-w-0 truncate tabular text-muted-foreground" title={title ?? value}>
        {value}
      </span>
    </div>
  );
}
