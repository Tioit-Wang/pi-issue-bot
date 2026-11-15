import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ChevronsUpDown } from 'lucide-react';
import { describeError } from '../components/AsyncSection.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import { StatusBadge, StatusDot } from '../components/ui/status-badge.tsx';
import { formatRelativeTime } from '../lib/format.ts';
import { rememberLastRepo, repoWorkspacePath, useRepoRoute } from '../lib/repo-route.ts';
import { useRepoDirectory, type RepoSummary } from '../lib/repos.ts';
import { cn } from '../lib/utils.ts';
import { SYSTEM_PATH } from './nav.ts';

/**
 * 仓库切换器（侧栏顶部）：**项目上下文的唯一入口**（`FR-7.1` 的第一层）。
 *
 * 交互：点触发器 → 面板（搜索框自动聚焦）→ 输入即筛（`owner/name` 子串匹配）
 * → 点一行进该仓库的 Issue 队列，同时把它记成「上次打开的仓库」（旧 `/tasks/:id` 要用）。
 * 底部固定两项：`全部项目`（回全局 Issue 队列）与 `管理仓库…`（`/system`）。
 *
 * 为什么是 `Popover` 而不是 `DropdownMenu`：面板里有一个**文本输入框**。
 * Radix 的菜单把方向键与逐个可打印字符按「菜单项之间的跳转」解释，
 * 输入框放进去会抢键（打不出 `zzz`）。Popover 只负责定位与关合，键盘留给输入框。
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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return repos;
    return repos.filter((repo) => repo.repo.toLowerCase().includes(needle));
  }, [repos, query]);

  const openRepo = (repo: string): void => {
    rememberLastRepo(repo);
    setOpen(false);
    void navigate(repoWorkspacePath(repo));
  };

  // 打开就聚焦搜索框：键盘用户不必先 Tab 进面板再找输入框。
  // 用一次 timeout 而不是同步 focus：Portal 里的内容在本次提交里才挂上，
  // 而 Radix 的开合焦点管理也在这一轮跑 —— 同步抢焦点会被它盖掉。
  useEffect(() => {
    if (!open) return;
    setQuery('');
    const timer = window.setTimeout(() => {
      searchRef.current?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="切换仓库"
          title="切换仓库（⌘K 也能搜）"
          data-testid="repo-switcher"
          className="h-8 w-full justify-start gap-2 px-2 font-normal"
        >
          {activeRepo === null ? (
            // 空态只说要去做什么（"选择仓库"），不用"未选择"这种否定式次级标签占两行
            <span className="min-w-0 flex-1 truncate text-muted-foreground">选择仓库</span>
          ) : (
            // 选中时只显示仓库名（等宽一行）："当前仓库"已经由分组标题说明，不重复
            <span className="min-w-0 flex-1 truncate text-left font-mono text-xs font-medium text-foreground" title={activeRepo}>
              {activeRepo}
            </span>
          )}
          <ChevronsUpDown aria-hidden className="ml-auto size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        className="w-72 gap-0 p-0"
        // 焦点交给下面那个输入框（Popover 默认把焦点放在内容容器上）
        onOpenAutoFocus={(event) => {
          event.preventDefault();
        }}
      >
        <div className="border-b border-border p-1.5">
          <Input
            ref={searchRef}
            type="search"
            aria-label="搜索仓库"
            placeholder="搜索 owner/name…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            className="h-8 text-xs"
          />
        </div>

        <div
          className="flex max-h-80 min-h-0 flex-col overflow-y-auto p-1"
          role="listbox"
          aria-label="仓库"
          data-testid="repo-switcher-list"
        >
          {isLoading ? (
            <div className="flex flex-col gap-1 p-1" data-testid="repo-switcher-loading">
              {[0, 1, 2].map((index) => (
                <Skeleton key={`repo-skeleton-${String(index)}`} className="h-8 w-full" />
              ))}
            </div>
          ) : error !== null ? (
            <div className="px-2 py-2 text-xs" data-testid="repo-switcher-error">
              <p className="font-medium text-destructive">仓库清单读取失败</p>
              <p className="mt-0.5 text-muted-foreground">{describeError(error)}</p>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="mt-2"
                onClick={() => {
                  refetch();
                }}
              >
                重试
              </Button>
            </div>
          ) : isEmpty ? (
            <div className="px-2 py-2 text-xs" data-testid="repo-switcher-empty">
              <p className="text-foreground">还没有任何仓库</p>
              <p className="mt-0.5 leading-relaxed text-muted-foreground">
                去「系统」页确认安装信息，或等 GitHub App 安装事件建行。
              </p>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="mt-2"
                onClick={() => {
                  setOpen(false);
                  void navigate(SYSTEM_PATH);
                }}
              >
                打开系统页
              </Button>
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

        <div className="flex flex-col gap-0.5 border-t border-border p-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-current={activeRepo === null ? 'true' : undefined}
            className="justify-start text-xs"
            onClick={() => {
              setOpen(false);
              void navigate('/');
            }}
          >
            全部项目
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="justify-start text-xs text-muted-foreground"
            onClick={() => {
              setOpen(false);
              void navigate(SYSTEM_PATH);
            }}
          >
            管理仓库…
          </Button>
        </div>
      </PopoverContent>
    </Popover>
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
      role="option"
      aria-selected={active}
      data-testid={`repo-switcher-item-${repo.repo}`}
      onClick={onSelect}
      className={cn(
        'flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left',
        'transition-colors duration-[120ms] ease-out-quint',
        'hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        active ? 'bg-accent text-accent-foreground' : 'text-foreground',
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <StatusDot tone={dot.tone} label={dot.label} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={repo.repo}>
          {repo.repo}
        </span>
        {repo.archivedAt === null ? null : <StatusBadge tone="neutral">已归档</StatusBadge>}
        {repo.enabled ? null : <StatusBadge tone="neutral">停用</StatusBadge>}
        {repo.dryRun ? <StatusBadge tone="warn">dry-run</StatusBadge> : null}
        {repo.settingsValid ? null : <StatusBadge tone="danger">配置无效</StatusBadge>}
      </span>
      <span className="truncate text-2xs text-muted-foreground">
        {repo.lastActivityAt === null ? '暂无活动' : `最近活动 ${formatRelativeTime(repo.lastActivityAt)}`}
      </span>
    </button>
  );
}
