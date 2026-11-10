import { Link } from 'react-router';
import { AsyncSection } from '../components/AsyncSection.tsx';
import { Badge, statusVariant } from '../components/ui/badge.tsx';
import { buttonVariants } from '../components/ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.tsx';
import { formatCount, formatDuration, formatPercent, formatTimeCell, formatUsd } from '../lib/format.ts';
import { useIssuesInfinite, useOverview, useTasks } from '../lib/queries.ts';
import {
  repoGitHubUrl,
  repoIssuePath,
  repoIssuesPath,
  repoRunPath,
  repoRunsPath,
  repoSettingsPath,
  useRepoRoute,
} from '../lib/repo-route.ts';
import { useRepoDirectory, type RepoSummary } from '../lib/repos.ts';
import { cn } from '../lib/utils.ts';
import { NotFoundPage } from './not-found.tsx';
import { PageShell } from './PageShell.tsx';
import { RepoPageFrame } from './RepoPageFrame.tsx';

/**
 * 当前仓库工作台 `/repos/:repo`。
 *
 * 数据来源（**全部是已有接口**，没有为这一页新开契约）：
 * - `/api/tasks?repo=…`：最近 8 次运行 + 失败运行（`status=failed`）；
 * - `/api/issues?repo=…`：最近 5 个会话（顺带「待人回答」的入口）；
 * - `/api/overview`：全局口径的吞吐 / 成本 / p95（**尚未按仓库切分**，见下方说明）；
 * - `/api/repos`：该仓库的启停 / dry-run / 配置合法性（失败降级 `/api/system`）。
 *
 * 「没有仓库维度」的处理（`docs/impl-multi-repo.md` §4 W1-C 第 4 条）：
 * `overview` 目前不接受 `repo` 参数，所以这一页把它明确标成「全局口径」，
 * 而把**仓库维度必须有数据**的判断放在 tasks/issues 上——两者都空时显示
 * 「该仓库暂无数据」，而不是拿全局数字冒充这个仓库的成绩。
 */
export function RepoWorkspacePage() {
  const { repo } = useRepoRoute();
  if (repo === null) return <NotFoundPage />;
  return <Workspace repo={repo} />;
}

function Workspace({ repo }: { repo: string }) {
  const directory = useRepoDirectory();
  const summary = directory.repos.find((item) => item.repo === repo) ?? null;

  const runs = useTasks({ repo, limit: 8 });
  const failed = useTasks({ repo, status: 'failed', limit: 5 });
  const issues = useIssuesInfinite({ repo, limit: 5 });
  const overview = useOverview();

  const runItems = runs.data?.items ?? [];
  const failedItems = failed.data?.items ?? [];
  const issueItems = issues.data?.pages.flatMap((page) => page.issues) ?? [];
  const awaitingItems = issueItems.filter((issue) => issue.awaitingReply);
  const isEmpty = runs.isLoading === false && runItems.length === 0 && issueItems.length === 0;
  const githubUrl = repoGitHubUrl(repo);

  return (
    <RepoPageFrame repo={repo} crumb="工作台">
      <PageShell
        title={repo}
        actions={
          <div className="flex items-center gap-2">
            {githubUrl === null ? null : (
              <a
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                href={githubUrl}
                target="_blank"
                rel="noreferrer"
              >
                打开 GitHub
              </a>
            )}
            <Link className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))} to={repoSettingsPath(repo)}>
              仓库设置
            </Link>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <RepoBadges summary={summary} directorySource={directory.source} />

          <AsyncSection
            testId="repo-workspace"
            isLoading={runs.isLoading}
            error={runs.error}
            isEmpty={isEmpty}
            emptyText="该仓库暂无数据：还没有跑过任何任务，也没有任何 issue 会话"
            skeletonHeight="h-40"
          >
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="repo-workspace-stats">
                <MiniStat
                  label="最近运行"
                  value={formatCount(runs.data?.totalEstimate ?? runItems.length)}
                  hint="总计"
                />
                <MiniStat
                  label="失败运行"
                  value={formatCount(failedItems.length)}
                  tone={failedItems.length > 0 ? 'danger' : 'neutral'}
                />
                <MiniStat
                  label="待人回答"
                  value={formatCount(awaitingItems.length)}
                  tone={awaitingItems.length > 0 ? 'warning' : 'neutral'}
                />
                <MiniStat
                  label="最近活动"
                  value={formatTimeCell(summary?.lastActivityAt ?? runItems[0]?.queuedAt ?? null).text}
                />
              </div>

              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                <Card data-testid="repo-workspace-runs">
                  <CardHeader className="flex-row items-center justify-between">
                    <div>
                      <CardTitle>最近运行</CardTitle>
                    </div>
                    <Link
                      className="shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                      to={repoRunsPath(repo)}
                    >
                      全部运行
                    </Link>
                  </CardHeader>
                  <CardContent>
                    {runItems.length === 0 ? (
                      <Empty text="该仓库暂无运行记录" />
                    ) : (
                      <ul className="flex flex-col gap-1">
                        {runItems.map((run) => (
                          <li key={run.id} className="min-w-0">
                            <Link
                              to={repoRunPath(repo, run.id)}
                              className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent/60"
                            >
                              <span className="min-w-0 flex-1 truncate font-mono" title={run.id}>
                                {run.id}
                              </span>
                              <span className="shrink-0 text-muted-foreground">{run.command}</span>
                              <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
                              <time
                                className="shrink-0 tabular-nums text-muted-foreground"
                                title={formatTimeCell(run.queuedAt).title}
                              >
                                {formatTimeCell(run.queuedAt).text}
                              </time>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>

                <Card data-testid="repo-workspace-issues">
                  <CardHeader className="flex-row items-center justify-between">
                    <div>
                      <CardTitle>最近 Issue</CardTitle>
                    </div>
                    <Link
                      className="shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                      to={repoIssuesPath(repo)}
                    >
                      Issue 中心
                    </Link>
                  </CardHeader>
                  <CardContent>
                    {issueItems.length === 0 ? (
                      <Empty text="该仓库暂无 issue 会话" />
                    ) : (
                      <ul className="flex flex-col gap-1">
                        {issueItems.map((issue) => (
                          <li key={`${issue.kind}-${String(issue.number)}`} className="min-w-0">
                            <Link
                              to={repoIssuePath(repo, issue.kind, issue.number)}
                              className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent/60"
                            >
                              <span className="shrink-0 font-mono text-muted-foreground">
                                {`${issue.kind}#${String(issue.number)}`}
                              </span>
                              <span className="min-w-0 flex-1 truncate" title={issue.title ?? undefined}>
                                {issue.title ?? '（取不到标题）'}
                              </span>
                              {issue.awaitingReply ? <Badge variant="warning">待人回答</Badge> : null}
                              <time
                                className="shrink-0 tabular-nums text-muted-foreground"
                                title={formatTimeCell(issue.lastActivityAt).title}
                              >
                                {formatTimeCell(issue.lastActivityAt).text}
                              </time>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              </div>

              <Card data-testid="repo-workspace-attention">
                <CardHeader>
                  <CardTitle>需要人介入（该仓库）</CardTitle>
                </CardHeader>
                <CardContent>
                  {failedItems.length === 0 && awaitingItems.length === 0 ? (
                    <Empty text="该仓库没有需要人介入的项" />
                  ) : (
                    <ul className="flex flex-col gap-1 text-xs">
                      {failedItems.map((run) => (
                        <li
                          key={run.id}
                          className="flex min-w-0 items-center gap-2 rounded-md border border-border border-l-2 border-l-destructive px-2 py-1.5"
                        >
                          <Badge variant="danger">{run.failureClass ?? 'failed'}</Badge>
                          <Link
                            className="min-w-0 flex-1 truncate font-mono underline-offset-2 hover:underline"
                            to={repoRunPath(repo, run.id)}
                          >
                            {run.id}
                          </Link>
                          <span className="shrink-0 text-muted-foreground">{run.command}</span>
                        </li>
                      ))}
                      {awaitingItems.map((issue) => (
                        <li
                          key={`awaiting-${issue.kind}-${String(issue.number)}`}
                          className="flex min-w-0 items-center gap-2 rounded-md border border-border border-l-2 border-l-amber-500 px-2 py-1.5"
                        >
                          <Badge variant="warning">待人回答</Badge>
                          <Link
                            className="min-w-0 flex-1 truncate underline-offset-2 hover:underline"
                            to={repoIssuePath(repo, issue.kind, issue.number)}
                          >
                            {`${issue.kind}#${String(issue.number)} ${issue.title ?? ''}`}
                          </Link>
                          <span className="shrink-0 text-muted-foreground">{issue.lastActorLogin ?? ''}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              <Card data-testid="repo-workspace-global">
                <CardHeader>
                  <CardTitle>全局口径参考</CardTitle>
                  <CardDescription>全部仓库合计（/api/overview 没有 repo 参数）</CardDescription>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                  <GlobalStat label="今日任务" value={formatCount(overview.data?.today.tasks)} />
                  <GlobalStat label="成功率" value={formatPercent(overview.data?.today.successRate)} />
                  <GlobalStat label="今日成本" value={formatUsd(overview.data?.today.costUsd)} />
                  <GlobalStat label="p95 耗时" value={formatDuration(overview.data?.today.p95Ms)} />
                </CardContent>
              </Card>
            </div>
          </AsyncSection>
        </div>
      </PageShell>
    </RepoPageFrame>
  );
}

function RepoBadges({ summary, directorySource }: { summary: RepoSummary | null; directorySource: string }) {
  if (summary === null) {
    return (
      <p className="text-[11px] text-muted-foreground" data-testid="repo-workspace-badges">
        {directorySource === 'system'
          ? '该仓库不在降级清单（/api/system）里：可能刚建行，或清单接口还没上线'
          : '读不到该仓库的启停状态（仓库清单不可用）；下面的数据仍然是这个仓库的'}
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="repo-workspace-badges">
      {summary.archivedAt === null ? null : <Badge variant="muted">已归档</Badge>}
      {summary.enabled ? <Badge variant="success">启用</Badge> : <Badge variant="muted">停用</Badge>}
      {summary.dryRun ? <Badge variant="warning">dry-run（不写 GitHub）</Badge> : <Badge variant="outline">真写</Badge>}
      {summary.settingsValid ? null : <Badge variant="danger">配置无效</Badge>}
      {summary.settingsError === null ? null : (
        <span className="break-all text-[11px] text-destructive">{summary.settingsError}</span>
      )}
    </div>
  );
}

function MiniStat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'neutral' | 'danger' | 'warning';
}) {
  const toneClass =
    tone === 'danger' ? 'text-destructive' : tone === 'warning' ? 'text-amber-600 dark:text-amber-400' : 'text-foreground';
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn('text-xl font-semibold tabular-nums', toneClass)}>{value}</div>
      {hint === undefined ? null : <div className="truncate text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function GlobalStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="text-base font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">{text}</p>
  );
}
