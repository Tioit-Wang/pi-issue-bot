import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { ChevronsUpDown } from 'lucide-react';
import { describeError } from '../components/AsyncSection.tsx';
import { Badge, StatusDot } from '../components/ui/badge.tsx';
import { DropdownMenu } from '../components/ui/dropdown-menu.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import { formatRelativeTime } from '../lib/format.ts';
import { rememberLastRepo, repoWorkspacePath, useRepoRoute } from '../lib/repo-route.ts';
import { useRepoDirectory, type RepoSummary } from '../lib/repos.ts';
import { cn } from '../lib/utils.ts';

/**
 * 仓库切换器（左栏顶部）。
 *
 * 交互：点触发器 → 面板（搜索框自动聚焦）→ 输入即筛（`owner/name` 子串匹配）
 * → 点一行进该仓库工作台，同时把它记成「上次打开的仓库」（旧 `/tasks/:id` 链接要用）。
 * 底部固定两项：`全部项目`（回全局总览）与 `管理仓库…`（`/system`）。
 *
 * 每行给一个**状态点 + 徽章组**，回答「这个仓库现在能不能正常跑」：
 * 启用（success）/ 停用（neutral）/ 干跑（warn）/ 配置非法（danger）/ 已归档（neutral）。
 * 第二行是最近活动时间（相对时间）。
 *
 * 数据：`GET /api/repos`，失败退回 `/api/system`（见 `lib/repos.ts` 的降级说明）。
 * 四态都在这里有落点：加载（与行同形骨架）/ 空（给去处）/ 错误（原因 + 重试）/ 有数据。
 */
export function RepoSwitcher() {
  const { repo: activeRepo } = useRepoRoute();
  const { repos, source, isLoading, error, isEmpty, refetch } = useRepoDirectory();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return repos;
    return repos.filter((repo) => repo.repo.toLowerCase().includes(needle));
  }, [repos, query]);

  const openRepo = (repo: string): void => {
    rememberLastRepo(repo);
    void navigate(repoWorkspacePath(repo));
  };

  return (
    <DropdownMenu
      testId="repo-switcher"
      triggerLabel="切换仓库"
      panelClassName="w-72"
      label={
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {activeRepo === null ? (
            // 空态只说要去做什么（"选择仓库"），不用"未选择"这种否定式次级标签占两行
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">选择仓库</span>
          ) : (
            // 选中时只显示仓库名（等宽一行）："当前仓库"已经由下方分组标题说明，不重复
            <span
              className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-foreground"
              title={activeRepo}
            >
              {activeRepo}
            </span>
          )}
          <ChevronsUpDown aria-hidden className="ml-auto size-3.5 shrink-0 text-faint" strokeWidth={1.75} />
        </span>
      }
    >
      {(close) => (
        <>
          <div className="border-b border-border p-1.5">
            <input
              data-autofocus
              type="search"
              aria-label="搜索仓库"
              placeholder="搜索 owner/name…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              className={cn(
                'h-7 w-full rounded-sm border border-input bg-background px-2 text-xs text-foreground',
                'transition-[border-color] duration-[120ms] ease-out-quint hover:border-border-strong',
                'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
              )}
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-1" data-testid="repo-switcher-list">
            {isLoading ? (
              <div className="flex flex-col gap-1 p-1" data-testid="repo-switcher-loading">
                {[0, 1, 2].map((index) => (
                  <Skeleton key={`repo-skeleton-${String(index)}`} className="h-8 w-full" />
                ))}
              </div>
            ) : error !== null ? (
              <div className="px-2 py-2 text-xs" data-testid="repo-switcher-error">
                <p className="font-medium text-danger-fg">仓库清单读取失败</p>
                <p className="mt-0.5 text-muted-foreground">{describeError(error)}</p>
                <button
                  type="button"
                  className="mt-2 rounded-sm border border-border px-2 py-0.5 text-foreground transition-colors duration-[120ms] hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                  onClick={() => {
                    refetch();
                  }}
                >
                  重试
                </button>
              </div>
            ) : isEmpty ? (
              <div className="px-2 py-2 text-xs" data-testid="repo-switcher-empty">
                <p className="text-foreground">还没有任何仓库</p>
                <p className="mt-0.5 leading-relaxed text-muted-foreground">
                  去「系统」页确认安装信息，或等 GitHub App 安装事件建行。
                </p>
                <button
                  type="button"
                  onClick={() => {
                    void navigate('/system');
                  }}
                  className="mt-2 rounded-sm border border-border px-2 py-0.5 text-foreground transition-colors duration-[120ms] hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                >
                  打开系统页
                </button>
              </div>
            ) : filtered.length === 0 ? (
              <p className="px-2 py-2 text-xs text-muted-foreground" data-testid="repo-switcher-no-match">
                {`没有匹配「${query.trim()}」的仓库`}
              </p>
            ) : (
              filtered.map((repo) => (
                <RepoRow
                  key={repo.repo}
                  repo={repo}
                  active={repo.repo === activeRepo}
                  onSelect={() => {
                    openRepo(repo.repo);
                    close(false);
                  }}
                />
              ))
            )}
          </div>

          {source === 'system' ? (
            <p
              className="border-t border-border px-2 py-1 text-2xs text-muted-foreground"
              data-testid="repo-switcher-degraded"
            >
              降级数据：`/api/repos` 不可用，本列表来自 `/api/system`
            </p>
          ) : null}

          <div className="border-t border-border p-1">
            <button
              type="button"
              role="menuitem"
              aria-current={activeRepo === null ? 'true' : undefined}
              className={cn(
                'flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-xs',
                'transition-colors duration-[120ms] ease-out-quint',
                'hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
                activeRepo === null ? 'bg-brand-soft font-medium text-foreground' : 'text-foreground',
              )}
              onClick={() => {
                void navigate('/');
                close(false);
              }}
            >
              全部项目
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-xs text-muted-foreground transition-colors duration-[120ms] hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              onClick={() => {
                void navigate('/system');
                close(false);
              }}
            >
              管理仓库…
            </button>
          </div>
        </>
      )}
    </DropdownMenu>
  );
}

/** 一行仓库的左侧状态点：配置非法 > 停用 > 归档 > 干跑 > 启用（只表达最该注意的一件事）。 */
function repoDot(repo: RepoSummary): { tone: 'success' | 'warn' | 'danger' | 'neutral'; label: string } {
  if (!repo.settingsValid) return { tone: 'danger', label: '配置非法' };
  if (!repo.enabled) return { tone: 'neutral', label: '停用' };
  if (repo.archivedAt !== null) return { tone: 'neutral', label: '已归档' };
  if (repo.dryRun) return { tone: 'warn', label: '干跑' };
  return { tone: 'success', label: '启用' };
}

function RepoRow({ repo, active, onSelect }: { repo: RepoSummary; active: boolean; onSelect: () => void }) {
  const dot = repoDot(repo);

  return (
    <button
      type="button"
      role="menuitem"
      aria-current={active ? 'true' : undefined}
      data-testid={`repo-switcher-item-${repo.repo}`}
      onClick={onSelect}
      className={cn(
        'flex w-full flex-col gap-0.5 rounded-sm px-2 py-1.5 text-left',
        'transition-colors duration-[120ms] ease-out-quint',
        'hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
        active ? 'bg-brand-soft text-foreground' : 'text-foreground',
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <StatusDot tone={dot.tone} label={dot.label} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={repo.repo}>
          {repo.repo}
        </span>
        {repo.archivedAt === null ? null : <Badge tone="neutral">已归档</Badge>}
        {repo.enabled ? null : <Badge tone="neutral">停用</Badge>}
        {repo.dryRun ? <Badge tone="warn">dry-run</Badge> : null}
        {repo.settingsValid ? null : <Badge tone="danger">配置无效</Badge>}
      </span>
      <span className="truncate text-2xs text-muted-foreground">
        {repo.lastActivityAt === null ? '暂无活动' : `最近活动 ${formatRelativeTime(repo.lastActivityAt)}`}
      </span>
    </button>
  );
}