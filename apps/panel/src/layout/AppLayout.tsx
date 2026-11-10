import { useEffect, useState } from 'react';
import { Outlet } from 'react-router';
import { PanelLeft } from 'lucide-react';
import { CommandPalette, openCommandPalette } from '../components/CommandPalette.tsx';
import { StatusDot } from '../components/ui/badge.tsx';
import { Toaster } from '../components/ui/toast.tsx';
import { useSystem } from '../lib/queries.ts';
import { cn } from '../lib/utils.ts';
import { DegradedBanner } from './DegradedBanner.tsx';
import { Sidebar } from './Sidebar.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';
import { useViewportMode } from './use-viewport.ts';

/**
 * 面板外壳：顶栏 + 左栏 + 内容区（+ 三个全局浮层）。
 *
 * 三层职责划分（不要互相抢）：
 * 1. **顶栏**：全局的东西 —— 品牌、⌘K、系统状态点、主题切换、侧栏开合；
 * 2. **左栏**：去哪里 —— 仓库切换器 + 两组导航 + 底部连接状态；
 * 3. **内容区**：当前页面（`min-w-0` 防溢出；页面自己管 `PageHeader` / `Section`）。
 *
 * 全局浮层只有三个，都挂在这里（唯一挂载点）：
 * `<CommandPalette />`（⌘K）、`<Toaster />`（右下提示）、`<DegradedBanner />`（降级横幅）。
 *
 * 响应式：≥1280 三栏可用；1024–1279 侧栏可折叠（顶栏按钮，带 `aria-expanded`）；
 * <1024 侧栏变抽屉（遮罩点击关闭，关闭时 `inert` 不进 Tab 序）。
 */
export function AppLayout() {
  const mode = useViewportMode();
  const [userSidebarOpen, setUserSidebarOpen] = useState<boolean | null>(null);

  // 宽屏恒开；中屏默认开（可折叠）；窄屏默认关（抽屉）
  const sidebarOpen = mode === 'wide' ? true : (userSidebarOpen ?? mode === 'medium');
  const toggleVisible = mode !== 'wide';

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* 键盘用户第一站：跳过导航直达主内容 */}
      <a
        href="#main-content"
        className={cn(
          'sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:top-2 focus-visible:left-2 focus-visible:z-50',
          'focus-visible:rounded-md focus-visible:border focus-visible:border-border focus-visible:bg-card',
          'focus-visible:px-3 focus-visible:py-1.5 focus-visible:text-sm focus-visible:text-foreground',
        )}
      >
        跳到主内容
      </a>

      {mode === 'narrow' && sidebarOpen ? (
        <button
          type="button"
          aria-label="关闭侧栏"
          tabIndex={-1}
          onClick={() => {
            setUserSidebarOpen(false);
          }}
          className="animate-fade-in fixed inset-0 z-20 cursor-default bg-foreground/25"
        />
      ) : null}

      <Sidebar
        mode={mode}
        open={sidebarOpen}
        onClose={() => {
          setUserSidebarOpen(false);
        }}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background/95 px-3 backdrop-blur">
          {toggleVisible ? (
            <button
              type="button"
              aria-expanded={sidebarOpen}
              aria-controls="app-sidebar"
              aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'}
              data-testid="sidebar-toggle"
              onClick={() => {
                setUserSidebarOpen(!sidebarOpen);
              }}
              className={cn(
                'grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground',
                'transition-colors duration-[120ms] ease-out-quint hover:bg-muted hover:text-foreground',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
              )}
            >
              <PanelLeft aria-hidden className="size-4" strokeWidth={1.75} />
            </button>
          ) : null}

          <div className="flex min-w-0 items-baseline gap-2">
            <span className="text-sm font-semibold tracking-tight whitespace-nowrap">pi-issue-bot</span>
          </div>

          <div className="ml-auto flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              onClick={openCommandPalette}
              aria-keyshortcuts="Meta+K Control+K"
              data-testid="command-trigger"
              className={cn(
                'hidden h-7 items-center gap-2 rounded-md border border-border bg-card px-2 text-xs text-muted-foreground',
                'transition-[background-color,border-color,color] duration-[120ms] ease-out-quint',
                'hover:border-border-strong hover:text-foreground',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand md:flex',
              )}
            >
              <span>搜索页面 / 仓库…</span>
              <kbd className="rounded-sm border border-border px-1 text-2xs text-faint">⌘K</kbd>
            </button>

            <GlobalStatus />
            <ThemeToggle />
          </div>
        </header>

        <DegradedBanner />

        <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 px-3 py-4 md:px-6 md:py-5">
          <Outlet />
        </main>
      </div>

      <CommandPalette />
      <Toaster />
    </div>
  );
}

/**
 * 全局状态点：一眼回答"现在有没有事需要我处理"。
 *
 * 优先级：离线 > 熔断暂停 > host 不可达 > 降级 > 正常。
 * 只显示**一个**点：状态点一多就没人看了；细节在总览与降级横幅里。
 *
 * 文案只用**状态词**（`429 熔断中` / `降级运行` / `pi-host 不可达`），
 * 不写"刷新中"这类瞬时动词 —— 顶栏描述的是"系统此刻处于什么状态"，
 * 而"正在请求"由刷新按钮的 spinner 承担，两件事不要混在一处。
 * 有异常时（warn / danger）整块升级成一行 pill，颜色只在异常时出现。
 */
function GlobalStatus() {
  const { data, isError } = useSystem();
  const online = useOnline();

  const paused = data !== undefined && data.flags.some((flag) => flag.key === 'rate_limit_pause');
  const hostDown = data?.host.status === 'down';
  const degraded = data?.doctor.status === 'fail' || data?.host.status === 'degraded' || isError;

  const state: { tone: 'success' | 'warn' | 'danger' | 'neutral'; label: string } = !online
    ? { tone: 'neutral', label: '离线' }
    : paused
      ? { tone: 'warn', label: '429 熔断中' }
      : hostDown
        ? { tone: 'danger', label: 'pi-host 不可达' }
        : degraded
          ? { tone: 'warn', label: '降级运行' }
          : { tone: 'success', label: '正常' };

  const pill = state.tone === 'warn' || state.tone === 'danger';

  return (
    <span
      data-testid="global-status"
      data-state={state.tone}
      title={`系统状态：${state.label}`}
      className={cn(
        'flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-2xs',
        pill ? 'bg-card' : 'text-muted-foreground',
        state.tone === 'warn' && 'border border-border text-warn-fg',
        state.tone === 'danger' && 'border border-border text-danger-fg',
      )}
    >
      <StatusDot tone={state.tone} pulse={state.tone === 'warn'} />
      <span aria-hidden className="hidden whitespace-nowrap sm:inline">
        {state.label}
      </span>
      <span className="sr-only">{`系统状态：${state.label}`}</span>
    </span>
  );
}

/** 浏览器在线状态（`navigator.onLine` + online/offline 事件）。 */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));

  useEffect(() => {
    const update = (): void => {
      setOnline(typeof navigator === 'undefined' ? true : navigator.onLine);
    };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  return online;
}