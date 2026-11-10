import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { AsyncSection } from '../components/AsyncSection.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Select } from '../components/ui/select.tsx';
import type { IssueListItem, IssuesQuery } from '../lib/contract.ts';
import { formatCount, formatTimeCell } from '../lib/format.ts';
import { useIssuesInfinite } from '../lib/queries.ts';
import { PageShell } from './PageShell.tsx';

/**
 * Issue 会话列表（R3；数据源 `GET /api/issues`，每 15s 轮询）。
 *
 * 这一页要回答的是**「有没有事等我」**，不是「有多少轮对话」。2026-11-10 的改版
 * （`docs/spec/ux-issue-sessions.md` §5.1）按这个结论重排信息层级：
 *
 *  1. **结果状态最先看到**：7px 色点 + 状态词。旧版把「人 N · 机 N」摆在最显眼处，
 *     而真数据里 14/18 条是 `人 0 机 0` + 后台 `failed:1`——最要紧的失败完全看不见。
 *  2. **标题与「多久没动」同行**：标题单行截断，时间右对齐常显（不 hover 换位）。
 *  3. **副信息降噪**：仓库名、`人/自动/机` 计数、标签、`状态可能过期` 都在第二行，11px。
 *  4. **预览标来源**：`机：`/`人：`（预览会退化成人类提问，不标来源会被误读）。
 *  5. **按天分组** + **顶部摘要可点成筛选**（只改 URL，不发任何写请求）。
 *
 * 两个口径都来自服务端，面板不自己发明：
 *  - 派生状态 = 契约 `issueStatusFilterSchema` 的优先级（服务端 WHERE 与这里逐条对齐）；
 *  - 「待人回答」= 服务端算好的 `awaitingReply`（`state=open` ∧ 最后发言是人 ∧ 之后没回复）。
 *    早前用「`humanTurns>0 && botTurns===0`」当代理是错的：`botTurns` 数的是 `actions` 行数，
 *    机器人发过评论但没写 `actions` 时会被判成「没回答」（真数据里的 #16 就是这种）。
 *
 * 只读红线（R4）：行链接、三个下拉、摘要里的筛选按钮——没有输入框、没有写操作。
 */
const PAGE_SIZE = 10;

/** 只认识的筛选键：同步 URL 时**只动这几个**，其余原样保留（例如 MSW 的 `?mock=error`）。 */
const FILTER_KEYS = ['repo', 'kind', 'status', 'state', 'awaiting'] as const;

type FilterKey = (typeof FILTER_KEYS)[number];
type Filters = Record<FilterKey, string>;

/**
 * 「进行中」超过这个时长没有新活动，就标成**已停滞**。
 *
 * 为什么需要：run 崩掉时 `runs` 会留下 `outcome=null` 的行，`outcomes.running` 永远 > 0，
 * 列表就会一直说「进行中」。这是显示层的诚实修正（不改数据、不改契约）；
 * 真正的清理归生命周期作业。
 */
const STALE_RUNNING_MS = 60 * 60 * 1000;

const STATE_LABEL: Record<IssueListItem['state'], string> = {
  open: 'open',
  closed: 'closed',
  unknown: '状态未知',
};

const STATE_VARIANT: Record<IssueListItem['state'], 'success' | 'outline' | 'muted'> = {
  open: 'success',
  closed: 'outline',
  unknown: 'muted',
};

type DerivedStatus = 'running' | 'queued' | 'failed' | 'answered' | 'idle';

const STATUS_TEXT: Record<DerivedStatus, string> = {
  running: '进行中',
  queued: '已排队',
  failed: '失败',
  answered: '已回复',
  idle: '无结果',
};

const STATUS_DOT: Record<DerivedStatus, string> = {
  running: 'bg-amber-500 ring-amber-500/15',
  queued: 'bg-sky-500 ring-sky-500/15',
  failed: 'bg-red-500 ring-red-500/15',
  answered: 'bg-emerald-500 ring-emerald-500/15',
  idle: 'bg-muted-foreground/40 ring-transparent',
};

const STATUS_TEXT_COLOR: Record<DerivedStatus, string> = {
  running: 'text-amber-600 dark:text-amber-400',
  queued: 'text-sky-600 dark:text-sky-400',
  failed: 'text-red-600 dark:text-red-400',
  answered: 'text-emerald-600 dark:text-emerald-400',
  idle: 'text-muted-foreground',
};

type OutcomeKey = keyof IssueListItem['outcomes'];

function countOf(item: IssueListItem, key: OutcomeKey): number {
  return item.outcomes[key] ?? 0;
}

/** 与契约 `issueStatusFilterSchema` 的优先级**逐条对齐**（服务端 WHERE 也照这个顺序）。 */
function deriveStatus(item: IssueListItem): DerivedStatus {
  if (countOf(item, 'running') > 0) return 'running';
  if (countOf(item, 'queued') > 0) return 'queued';
  if (countOf(item, 'failed') > 0 && countOf(item, 'succeeded') === 0) return 'failed';
  if (countOf(item, 'succeeded') > 0) return 'answered';
  return 'idle';
}

/** 「进行中」但很久没动：多半是 run 崩了留下的僵状态。 */
function isStalled(item: IssueListItem, status: DerivedStatus, now: number): boolean {
  if (status !== 'running') return false;
  const at = Date.parse(item.lastActivityAt);
  return !Number.isNaN(at) && now - at > STALE_RUNNING_MS;
}

function readFilters(params: URLSearchParams): Filters {
  const value = (key: FilterKey): string => params.get(key) ?? '';
  return {
    repo: value('repo'),
    kind: value('kind'),
    status: value('status'),
    state: value('state'),
    awaiting: value('awaiting'),
  };
}

/** `Tioit-Wang/pi-issue-bot#17` → `/issues/Tioit-Wang/pi-issue-bot/issue/17`（`repo` 含 `/`，接口拆四段）。 */
function detailHref(item: IssueListItem): string {
  const [owner, name] = item.repo.split('/');
  return `/issues/${encodeURIComponent(owner ?? '')}/${encodeURIComponent(name ?? '')}/${item.kind}/${String(item.number)}`;
}

/** 仓库名：只有一个仓库时省略 owner；多个仓库时带 owner（否则 `widgets#17` 与 `lib#17` 撞名）。 */
function shortRepo(repo: string, showOwner: boolean): string {
  if (showOwner) return repo;
  const parts = repo.split('/');
  return parts.length === 2 ? (parts[1] ?? repo) : repo;
}

type DayGroup = { key: 'today' | 'yesterday' | 'earlier'; label: string; items: IssueListItem[] };

/** 按本地日历日分组：今天 / 昨天 / 更早（输入已是 `lastActivityAt` 倒序）。 */
function groupByDay(items: readonly IssueListItem[], now: Date): DayGroup[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const buckets: DayGroup[] = [
    { key: 'today', label: '今天', items: [] },
    { key: 'yesterday', label: '昨天', items: [] },
    { key: 'earlier', label: '更早', items: [] },
  ];
  for (const item of items) {
    const at = Date.parse(item.lastActivityAt);
    const bucket =
      Number.isNaN(at) || at >= startOfToday ? buckets[0] : at >= startOfYesterday ? buckets[1] : buckets[2];
    bucket?.items.push(item);
  }
  return buckets.filter((bucket) => bucket.items.length > 0);
}

export function IssuesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = readFilters(searchParams);

  const query = useMemo((): IssuesQuery => {
    const next: IssuesQuery = { limit: PAGE_SIZE };
    if (filters.repo !== '') next.repo = filters.repo;
    if (filters.kind !== '') next.kind = filters.kind as IssueListItem['kind'];
    if (filters.status !== '') next.status = filters.status as DerivedStatus;
    if (filters.state !== '') next.state = filters.state as IssueListItem['state'];
    if (filters.awaiting === 'true') next.awaiting = 'true';
    return next;
  }, [filters.repo, filters.kind, filters.status, filters.state, filters.awaiting]);

  const { data, error, isLoading, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage } =
    useIssuesInfinite(query);

  const issues = useMemo(() => data?.pages.flatMap((page) => page.issues) ?? [], [data]);
  const anyFilter = FILTER_KEYS.some((key) => filters[key] !== '');

  const summary = useMemo(() => {
    let running = 0;
    let failed = 0;
    let awaiting = 0;
    for (const item of issues) {
      const status = deriveStatus(item);
      if (status === 'running' || status === 'queued') running += 1;
      if (status === 'failed') failed += 1;
      if (item.awaitingReply) awaiting += 1;
    }
    return { running, failed, awaiting };
  }, [issues]);

  const groups = useMemo(() => groupByDay(issues, new Date()), [issues]);

  /** 仓库候选值 = 已加载数据 ∪ 当前选中值（契约没有「仓库清单」接口，不凭空造列表）。 */
  const repoOptions = useMemo(() => {
    const seen = new Set(issues.map((issue) => issue.repo));
    if (filters.repo !== '') seen.add(filters.repo);
    return [...seen].sort().map((value) => ({ value, label: value }));
  }, [issues, filters.repo]);

  /** 只有出现多个仓库时才在行内显示 owner（单仓库时那是每行都重复的噪声）。 */
  const showOwner = repoOptions.length > 1;

  const setFilter = (key: FilterKey, value: string): void => {
    // 复制一份再改：`?mock=error` 这类 mock/外部参数必须原样留着
    const next = new URLSearchParams(searchParams);
    if (value === '') next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  /** 摘要里的数字点一下就是筛选；再点一次取消（只改 URL）。 */
  const toggleFilter = (key: FilterKey, value: string): void => {
    setFilter(key, filters[key] === value ? '' : value);
  };

  const clearFilters = (): void => {
    const next = new URLSearchParams(searchParams);
    for (const key of FILTER_KEYS) next.delete(key);
    setSearchParams(next, { replace: true });
  };

  return (
    <PageShell
      title="Issue 会话"
      description="一个 issue = 一个会话 · 按最后活跃倒序 · 每 15 秒刷新"
      actions={
        <div className="flex items-center gap-2">
          {isFetching && !isLoading ? (
            <span className="text-xs text-muted-foreground" data-testid="issues-refreshing">
              刷新中…
            </span>
          ) : null}
          <Button variant="ghost" size="sm" disabled={!anyFilter} onClick={clearFilters} data-testid="issues-clear">
            清除筛选
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2" data-testid="issues-filters">
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
            aria-label="类型筛选"
            options={[
              { value: 'issue', label: 'Issue' },
              { value: 'pr', label: 'Pull request' },
            ]}
            placeholder="Issue 与 PR"
            value={filters.kind}
            onChange={(event) => {
              setFilter('kind', event.target.value);
            }}
          />
          <Select
            aria-label="状态筛选"
            options={[
              { value: 'open', label: 'open' },
              { value: 'closed', label: 'closed' },
              { value: 'unknown', label: '状态未知' },
            ]}
            placeholder="全部状态"
            value={filters.state}
            onChange={(event) => {
              setFilter('state', event.target.value);
            }}
          />
        </div>

        {issues.length === 0 ? null : (
          <p className="px-1 text-[11px] text-muted-foreground" data-testid="issues-summary">
            已加载 {formatCount(issues.length)} 个 ·{' '}
            <button
              type="button"
              className={`underline-offset-2 hover:underline ${STATUS_TEXT_COLOR.running}`}
              aria-pressed={filters.status === 'running'}
              data-testid="issues-summary-running"
              onClick={() => {
                toggleFilter('status', 'running');
              }}
            >
              进行中 {formatCount(summary.running)}
            </button>{' '}
            ·{' '}
            <button
              type="button"
              className={`underline-offset-2 hover:underline ${STATUS_TEXT_COLOR.failed}`}
              aria-pressed={filters.status === 'failed'}
              data-testid="issues-summary-failed"
              onClick={() => {
                toggleFilter('status', 'failed');
              }}
            >
              失败 {formatCount(summary.failed)}
            </button>{' '}
            ·{' '}
            <button
              type="button"
              className={`underline-offset-2 hover:underline ${STATUS_TEXT_COLOR.running}`}
              aria-pressed={filters.awaiting === 'true'}
              data-testid="issues-summary-awaiting"
              onClick={() => {
                toggleFilter('awaiting', 'true');
              }}
            >
              待人回答 {formatCount(summary.awaiting)}
            </button>
          </p>
        )}
      </div>

      <AsyncSection
        isLoading={isLoading}
        error={error}
        isEmpty={issues.length === 0}
        emptyText={
          anyFilter
            ? '当前筛选下没有会话。换个仓库/类型/状态，或清除筛选。'
            : '还没有处理过的 Issue 会话 —— 在 issue 里 @ 机器人或发一条 /命令 就会出现在这里（去「系统」页可确认在线状态）。'
        }
        testId="issues"
        skeletonHeight="h-64"
        skeleton={
          <div className="flex flex-col gap-1">
            {Array.from({ length: 6 }, (_, index) => (
              <div
                key={`issues-skeleton-${String(index)}`}
                className="h-12 w-full animate-pulse rounded-[10px] bg-muted"
              />
            ))}
          </div>
        }
      >
        {/* 行间用 1px 间距而不是分隔线：让 10px 圆角的 hover 底读成独立行（PI-Desktop 的做法） */}
        <div className="flex flex-col gap-3" data-testid="issues-list">
          {groups.map((group) => (
            <section key={group.key} className="flex flex-col gap-px">
              <h2 className="px-1.5 pb-1 text-[11px] font-medium text-muted-foreground">
                {group.label} · {formatCount(group.items.length)}
              </h2>
              <ul className="flex flex-col gap-px">
                {group.items.map((issue) => (
                  <IssueRow
                    key={`${issue.repo}#${issue.kind}${String(issue.number)}`}
                    issue={issue}
                    showOwner={showOwner}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div className="mt-3 flex items-center justify-center gap-2">
          <Button
            variant="outline"
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
                : `加载更多（已显示 ${formatCount(issues.length)} 个）`
              : `没有更多了（共 ${formatCount(issues.length)} 个）`}
          </Button>
        </div>
      </AsyncSection>
    </PageShell>
  );
}

/** 一行 = 一个会话。三段：状态 + 标题 + 时间 / 元信息 / 预览。 */
function IssueRow({ issue, showOwner }: { issue: IssueListItem; showOwner: boolean }) {
  const status = deriveStatus(issue);
  const stalled = isStalled(issue, status, Date.now());
  const time = formatTimeCell(issue.lastActivityAt);
  const previewSource = issue.lastActorKind === 'human' ? '人' : issue.lastActorKind === 'bot' ? '机' : '人';
  const dot = stalled ? 'bg-amber-500/50 ring-amber-500/10' : STATUS_DOT[status];
  const label = stalled ? '已停滞' : STATUS_TEXT[status];
  const labelColor = stalled ? 'text-amber-600/80 dark:text-amber-400/80' : STATUS_TEXT_COLOR[status];

  return (
    <li data-testid={`issue-row-${issue.repo}#${issue.kind}${String(issue.number)}`} className="min-w-0">
      <Link
        to={detailHref(issue)}
        className="group flex min-w-0 flex-col gap-0.5 rounded-[10px] px-2 py-1.5 transition-colors hover:bg-foreground/[0.05] focus-visible:bg-foreground/[0.05] focus-visible:outline-none"
        data-testid="issue-row-link"
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`inline-flex h-[7px] w-[7px] shrink-0 rounded-full ring-[3px] ${dot}`}
          />
          <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px] text-foreground/80 group-hover:text-foreground">
            {issue.title ?? '（取不到标题）'}
          </span>
          <time className="shrink-0 text-[11px] text-muted-foreground" title={time.title}>
            {time.text}
          </time>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-1.5 pl-[13px] text-[11px] text-muted-foreground">
          <span className={`font-medium ${labelColor}`}>{label}</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono">
            {shortRepo(issue.repo, showOwner)}#{issue.number}
          </span>
          {issue.kind === 'pr' ? <Badge variant="outline">PR</Badge> : null}
          <Badge variant={STATE_VARIANT[issue.state]}>{STATE_LABEL[issue.state]}</Badge>
          {issue.awaitingReply ? <Badge variant="warning">待人回答</Badge> : null}
          {issue.stateStale ? (
            <span className="text-amber-600 dark:text-amber-400" title="状态不是来自投递事件，可能过期">
              状态可能过期
            </span>
          ) : null}
          <span data-testid="issue-row-turns">
            人 {formatCount(issue.humanTurns)}
            {issue.autoTurns > 0 ? ` · 自动 ${formatCount(issue.autoTurns)}` : ''} · 机{' '}
            {formatCount(issue.botTurns)}
          </span>
          {issue.labels.length === 0 ? null : (
            <span className="flex flex-wrap items-center gap-1">
              {issue.labels.map((label2) => (
                <Badge key={label2} variant="secondary">
                  {label2}
                </Badge>
              ))}
            </span>
          )}
        </div>

        <p
          className="truncate pl-[13px] text-[11px] text-muted-foreground/80"
          title={issue.lastPreview ?? ''}
          data-testid="issue-row-preview"
        >
          {issue.lastPreview === null ? '—' : `${previewSource}：${issue.lastPreview}`}
        </p>
      </Link>
    </li>
  );
}
