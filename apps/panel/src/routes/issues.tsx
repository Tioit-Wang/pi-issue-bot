import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { AsyncSection } from '../components/AsyncSection.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Select } from '../components/ui/select.tsx';
import type { IssueListItem } from '../lib/contract.ts';
import { EMPTY, formatCount, formatTimeCell } from '../lib/format.ts';
import { useIssuesInfinite } from '../lib/queries.ts';
import { PageShell } from './PageShell.tsx';

/**
 * Issue 会话列表（R3 / S-B，数据源 `GET /api/issues`，每 15s 轮询）。
 *
 * 这一页只做三件事（其余都是呈现）：
 *
 *  1. **一行 = 一个 issue = 一个 session**：`repo#number`、标题、状态 chip、
 *     `humanTurns/botTurns`、最后活跃相对时间、最后一条预览（单行省略，`title` 里放全文）。
 *  2. **游标分页**：契约是 `cursor`（不透明）+ `nextCursor`/`hasMore`，所以用
 *     `useInfiniteQuery`（`useIssuesInfinite`）累积页，点「加载更多」拿下一页，不退化成页码语义。
 *  3. **筛选与 URL 双向同步**：`useSearchParams` 是唯一事实源（不在 `useState` 存副本），
 *     刷新/前进后退/贴链接都保持同一份筛选；写入时保留不认识的参数（例如 MSW 的 `?mock=error`）。
 *
 * 只读红线（spec §5 / R4）：这一页只有**导航**（行链接）与**筛选下拉**，
 * 没有输入框、没有发送按钮、没有任何写操作。
 */
const PAGE_SIZE = 10;

/** 只认识的筛选键：同步 URL 时**只动这几个**，其余原样保留。 */
const FILTER_KEYS = ['repo'] as const;

type FilterKey = (typeof FILTER_KEYS)[number];
type Filters = Record<FilterKey, string>;

/** `state` 是契约的 `open|closed|unknown`（`unknown` = 取不到 issue 元数据）。 */
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

function readFilters(params: URLSearchParams): Filters {
  return { repo: params.get('repo') ?? '' };
}

/** `Tioit-Wang/pi-issue-bot#17` → `/issues/Tioit-Wang/pi-issue-bot/issue/17`（`repo` 含 `/`，接口拆四段）。 */
function detailHref(item: IssueListItem): string {
  const [owner, name] = item.repo.split('/');
  return `/issues/${encodeURIComponent(owner ?? '')}/${encodeURIComponent(name ?? '')}/${item.kind}/${String(item.number)}`;
}

export function IssuesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = readFilters(searchParams);

  const query = useMemo(
    () => ({ limit: PAGE_SIZE, ...(filters.repo === '' ? {} : { repo: filters.repo }) }),
    [filters.repo],
  );

  const { data, error, isLoading, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage } =
    useIssuesInfinite(query);

  const issues = useMemo(() => data?.pages.flatMap((page) => page.issues) ?? [], [data]);
  const anyFilter = FILTER_KEYS.some((key) => filters[key] !== '');

  /** 仓库候选值 = 已加载数据 ∪ 当前选中值（契约没有「仓库清单」接口，不凭空造列表）。 */
  const repoOptions = useMemo(() => {
    const seen = new Set(issues.map((issue) => issue.repo));
    if (filters.repo !== '') seen.add(filters.repo);
    return [...seen].sort().map((value) => ({ value, label: value }));
  }, [issues, filters.repo]);

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

  return (
    <PageShell
      title="Issue 会话"
      description={`按最后活跃时间倒序 · 已显示 ${formatCount(issues.length)} 个会话 · 每 15 秒刷新`}
      actions={
        <div className="flex items-center gap-2">
          {isFetching && !isLoading ? (
            <span className="text-xs text-muted-foreground" data-testid="issues-refreshing">
              刷新中…
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            disabled={!anyFilter}
            onClick={clearFilters}
            data-testid="issues-clear"
          >
            清除筛选
          </Button>
        </div>
      }
    >
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
      </div>

      <AsyncSection
        isLoading={isLoading}
        error={error}
        isEmpty={issues.length === 0}
        emptyText="还没有处理过的 Issue 会话；换个仓库或清空筛选再试。"
        testId="issues"
        skeletonHeight="h-64"
        skeleton={
          <div className="flex flex-col gap-2">
            {Array.from({ length: 6 }, (_, index) => (
              <div
                key={`issues-skeleton-${String(index)}`}
                className="h-14 w-full animate-pulse rounded-md bg-muted"
              />
            ))}
          </div>
        }
      >
        <Card className="flex flex-col" data-testid="issues-list">
          <ul className="flex flex-col">
            {issues.map((issue) => (
              <li
                key={`${issue.repo}#${issue.kind}${String(issue.number)}`}
                data-testid={`issue-row-${issue.repo}#${issue.kind}${String(issue.number)}`}
                className="border-b border-border/60 last:border-0"
              >
                <Link
                  to={detailHref(issue)}
                  className="flex flex-col gap-1 px-3 py-2.5 hover:bg-muted/50"
                  data-testid="issue-row-link"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs">{issue.repo}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      #{formatCount(issue.number)}
                    </span>
                    {issue.kind === 'pr' ? <Badge variant="outline">PR</Badge> : null}
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {issue.title ?? '（取不到标题）'}
                    </span>
                    <Badge variant={STATE_VARIANT[issue.state]}>{STATE_LABEL[issue.state]}</Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span data-testid="issue-row-turns">
                      人 {formatCount(issue.humanTurns)} · 机 {formatCount(issue.botTurns)}
                    </span>
                    <span aria-hidden="true">·</span>
                    <time title={formatTimeCell(issue.lastActivityAt).title}>
                      {formatTimeCell(issue.lastActivityAt).text}
                    </time>
                    {issue.labels.length === 0 ? null : (
                      <span className="flex flex-wrap items-center gap-1">
                        {issue.labels.map((label) => (
                          <Badge key={label} variant="secondary">
                            {label}
                          </Badge>
                        ))}
                      </span>
                    )}
                  </div>
                  <p
                    className="truncate text-xs text-muted-foreground"
                    title={issue.lastPreview ?? ''}
                    data-testid="issue-row-preview"
                  >
                    {issue.lastPreview ?? EMPTY}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </Card>

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
