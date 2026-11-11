import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useNavigate } from 'react-router';
import { api } from '../lib/api.ts';
import { queryKeys } from '../lib/queries.ts';
import { repoIssuePath, repoWorkspacePath, useRepoRoute } from '../lib/repo-route.ts';
import { useRepoDirectory } from '../lib/repos.ts';
import { cn } from '../lib/utils.ts';
import { GLOBAL_NAV, REPO_NAV, repoNavPath } from '../layout/nav.ts';
import { useModalFocus } from './ui/dialog.tsx';

/**
 * 命令面板（⌘K / Ctrl+K，或 `/`）。
 *
 * 目标：让「去某页 / 切仓库 / 跳到最近处理过的 issue」这三件事**不用碰鼠标**。
 * 搜索范围（子序列模糊匹配：命中即可，命中越靠前、越连续分越高）：
 * 1. 页面（全局 5 条 + 当前仓库 5 条）；
 * 2. 仓库（`useRepoDirectory`，与左栏切换器同一数据源）；
 * 3. 最近 issue（`api.issues({ limit: 8 })`，**只在面板打开时**发请求）。
 *
 * 键盘：`↑`/`↓` 移动、`Home`/`End` 首尾、`↵` 打开、`Esc` 关闭（焦点还给触发元素）。
 * 无结果时给「换个词试试」+ 一个直达链接（系统页：仓库从这里注册）。
 *
 * 打开状态放在模块级 store：顶栏按钮与全局快捷键都要能开它，而它自己挂在 AppLayout。
 */
const listeners = new Set<() => void>();
let opened = false;

function emit(): void {
  for (const listener of listeners) listener();
}

/** 同步读当前是否打开（快捷键回调里不经过 React 渲染）。 */
function isPaletteOpen(): boolean {
  return opened;
}

export function openCommandPalette(): void {
  if (opened) return;
  opened = true;
  emit();
}

export function closeCommandPalette(): void {
  if (!opened) return;
  opened = false;
  emit();
}

function usePaletteOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => opened,
    () => false,
  );
}

type Entry = {
  id: string;
  group: '页面' | '仓库' | '最近 Issue';
  label: string;
  /** 副标题：路径、仓库名、issue 标题。 */
  hint?: string;
  to: string;
};

/** 子序列模糊匹配：`acw` 命中 `acme/widgets`；不命中的字符直接淘汰。 */
export function fuzzyScore(needle: string, haystack: string): number | null {
  const query = needle.trim().toLowerCase();
  if (query === '') return 0;
  const text = haystack.toLowerCase();
  let score = 0;
  let cursor = 0;
  let previous = -2;
  for (const char of query) {
    const found = text.indexOf(char, cursor);
    if (found < 0) return null;
    // 连续命中给额外奖励，越靠前越好
    score += found === previous + 1 ? 4 : 1;
    score += Math.max(0, 12 - found) / 12;
    previous = found;
    cursor = found + 1;
  }
  return score;
}

/** 匹配并排序（同分按原顺序，避免输入时结果跳动）。 */
function rank<T extends { label: string; hint?: string }>(items: readonly T[], query: string): T[] {
  if (query.trim() === '') return [...items];
  return items
    .map((item, index) => ({
      item,
      index,
      score: Math.max(
        fuzzyScore(query, item.label) ?? Number.NEGATIVE_INFINITY,
        fuzzyScore(query, item.hint ?? '') ?? Number.NEGATIVE_INFINITY,
      ),
    }))
    .filter((row) => Number.isFinite(row.score))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((row) => row.item);
}

export function CommandPalette() {
  const open = usePaletteOpen();
  const navigate = useNavigate();
  const { repo } = useRepoRoute();
  const { repos } = useRepoDirectory();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  // 最近 issue：只在打开时取（避免每个页面都多打一个请求）
  const issues = useQuery({
    queryKey: [...queryKeys.issues({ limit: 8 }), 'palette'],
    queryFn: () => api.issues({ limit: 8 }),
    enabled: open,
    staleTime: 30_000,
  });

  // 全局快捷键：一直挂着（关闭状态下也要能 ⌘K 打开）
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (isPaletteOpen()) closeCommandPalette();
        else openCommandPalette();
        return;
      }
      if (event.key === '/' && !meta) {
        const target = event.target as HTMLElement | null;
        const typing =
          target !== null &&
          (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
        if (typing || isPaletteOpen()) return;
        event.preventDefault();
        openCommandPalette();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    // 焦点由 `useModalFocus` 交给 `[data-autofocus]` 的输入框，这里不重复抢
  }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const pages: Entry[] = [
      ...GLOBAL_NAV.map((item) => ({
        id: `page:${item.path}`,
        group: '页面' as const,
        label: item.label,
        hint: item.path,
        to: item.path,
      })),
      ...(repo === null
        ? []
        : REPO_NAV.map((item) => ({
            id: `page:${item.key}`,
            group: '页面' as const,
            label: item.label,
            hint: `${repo}${item.suffix}`,
            to: repoNavPath(repo, item.key),
          }))),
    ];

    const repoEntries: Entry[] = repos.map((item) => ({
      id: `repo:${item.repo}`,
      group: '仓库' as const,
      label: item.repo,
      hint: item.enabled ? '工作台' : '已停用',
      to: repoWorkspacePath(item.repo),
    }));

    const issueEntries: Entry[] = (issues.data?.issues ?? []).slice(0, 8).map((issue) => ({
      id: `issue:${issue.repo}:${String(issue.number)}`,
      group: '最近 Issue' as const,
      label: `#${String(issue.number)} ${issue.title ?? '（无标题）'}`,
      hint: issue.repo,
      to: repoIssuePath(issue.repo, issue.kind, issue.number),
    }));

    return [...pages, ...repoEntries, ...issueEntries];
  }, [repo, repos, issues.data]);

  const groups = useMemo(() => {
    const map = new Map<Entry['group'], Entry[]>();
    for (const entry of rank(entries, query)) {
      const bucket = map.get(entry.group);
      if (bucket === undefined) map.set(entry.group, [entry]);
      else bucket.push(entry);
    }
    return [...map.entries()];
  }, [entries, query]);

  const flat = useMemo(() => groups.flatMap(([, list]) => list), [groups]);
  const current = flat[Math.min(active, Math.max(0, flat.length - 1))];

  useEffect(() => {
    if (current === undefined) return;
    document.getElementById(`palette-item-${current.id}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [current]);

  const { panelRef, onKeyDown } = useModalFocus(open, closeCommandPalette);

  const go = (entry: Entry): void => {
    closeCommandPalette();
    void navigate(entry.to);
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (
      event.key === 'ArrowDown' ||
      event.key === 'ArrowUp' ||
      event.key === 'Home' ||
      event.key === 'End'
    ) {
      event.preventDefault();
      if (flat.length === 0) return;
      const last = flat.length - 1;
      setActive((value) =>
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? last
            : event.key === 'ArrowDown'
              ? (value + 1) % flat.length
              : value <= 0
                ? last
                : value - 1,
      );
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (current !== undefined) go(current);
    }
  };

  if (!open) return null;

  let flatIndex = -1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]"
      onKeyDown={onKeyDown}
      data-testid="command-palette"
    >
      <button
        type="button"
        aria-label="关闭命令面板"
        tabIndex={-1}
        onClick={closeCommandPalette}
        className="animate-fade-in absolute inset-0 cursor-default bg-foreground/25"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        className="animate-pop-in relative z-10 flex w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-overlay"
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search aria-hidden className="size-4 shrink-0 text-faint" strokeWidth={1.75} />
          <input
            data-autofocus
            type="text"
            aria-label="搜索页面、仓库与最近 issue"
            placeholder="搜索页面 / 仓库 / 最近 issue…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onInputKeyDown}
            className="h-7 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-faint"
          />
          <kbd className="rounded-sm border border-border px-1 text-2xs text-faint">esc</kbd>
        </div>

        <div
          id="palette-list"
          role="listbox"
          aria-label="结果"
          className="max-h-[52vh] overflow-y-auto p-1"
        >
          {flat.length === 0 ? (
            <div className="px-3 py-6 text-center" data-testid="palette-empty">
              <p className="text-sm text-foreground">{`没有匹配「${query.trim()}」的结果`}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                换个词试试，或者去系统页看看仓库有没有注册。
              </p>
              <button
                type="button"
                onClick={() => {
                  closeCommandPalette();
                  void navigate('/system');
                }}
                className="mt-2 rounded-md border border-border px-2 py-1 text-xs text-foreground transition-colors duration-[120ms] hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                打开「系统」
              </button>
            </div>
          ) : (
            groups.map(([group, list]) => (
              <div key={group} className="mb-1 last:mb-0">
                <p className="micro-label px-2 py-1">{group}</p>
                {list.map((entry) => {
                  flatIndex += 1;
                  const index = flatIndex;
                  const selected = current?.id === entry.id;
                  return (
                    <button
                      key={entry.id}
                      id={`palette-item-${entry.id}`}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      data-testid={`palette-item-${entry.id}`}
                      onMouseEnter={() => {
                        setActive(index);
                      }}
                      onClick={() => {
                        go(entry);
                      }}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs',
                        'transition-colors duration-[120ms] ease-out-quint',
                        selected ? 'bg-brand-soft text-foreground' : 'text-foreground hover:bg-muted',
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                      {entry.hint === undefined ? null : (
                        <span className="max-w-40 shrink-0 truncate font-mono text-2xs text-faint">
                          {entry.hint}
                        </span>
                      )}
                      {selected ? (
                        <kbd className="shrink-0 rounded-sm border border-border px-1 text-2xs text-faint">
                          ↵
                        </kbd>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-2xs text-faint">
          <span>↑↓ 移动</span>
          <span>↵ 打开</span>
          <span>esc 关闭</span>
          <span className="ml-auto tabular">{`${String(flat.length)} 条结果`}</span>
        </div>
      </div>
    </div>
  );
}