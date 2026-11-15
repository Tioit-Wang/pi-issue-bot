import { useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { Search } from 'lucide-react';
import { Breadcrumb } from '../components/Breadcrumb.tsx';
import { CommandPalette, openCommandPalette } from '../components/CommandPalette.tsx';
import { Button } from '../components/ui/button.tsx';
import { Kbd } from '../components/ui/kbd.tsx';
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from '../components/ui/sidebar.tsx';
import { Toaster } from '../components/ui/sonner.tsx';
import { useSystem } from '../lib/queries.ts';
import { useRepoRoute } from '../lib/repo-route.ts';
import { cn } from '../lib/utils.ts';
import { AppSidebar } from './AppSidebar.tsx';
import { degradedStateOf } from './degraded.ts';
import { DegradedBanner } from './DegradedBanner.tsx';
import { crumbsFor, SYSTEM_PATH } from './nav.ts';
import { StatusStrip } from './StatusStrip.tsx';

/**
 * 面板外壳：**侧栏式 admin**（`FR-7.1` / `AC-26` 改写后的形状）。
 *
 * ```
 * ┌───────────┬─────────────────────────────────────────┐
 * │ 侧栏       │ 状态带（四个数字 + 降级 chip）· 搜索 ⌘K   │
 * │ 仓库切换   ├─────────────────────────────────────────┤
 * │ 项目       │ 降级横幅（只在真降级时占一行）             │
 * │ 证据       ├─────────────────────────────────────────┤
 * │ 全局       │ 面包屑                                   │
 * │ 主题/折叠  │ <Outlet />  ← 内容区是唯一滚动容器        │
 * └───────────┴─────────────────────────────────────────┘
 * ```
 *
 * 三个决定，都有代价：
 *
 * 1. **导航只有侧栏一处**。改造前是「顶栏 + 吸底 dock + 系统模态框」三层，
 *    高频动作（处理某条卡住的 issue）反而要再点两次。现在项目 / 证据 / 全局三组
 *    常驻左侧，`FR-7.2` 的「五个全局页的信息去处」仍按原文落在状态带、会话流与系统页。
 * 2. **内容区是唯一滚动容器**（`overflow-y-auto`）。外壳高度锁在视口内
 *    （`h-dvh overflow-hidden`），否则「整页不滚、只有编辑区滚」的设置页无处安放。
 *    侧栏自己滚（`SidebarContent` 内部 `overflow-auto`），两个滚动区互不影响。
 * 3. **面包屑由外壳画**（`shell-breadcrumb`），页面只画自己的 `h1`。
 *    一个视图里只允许有一条「我在哪」。
 *
 * 全局浮层只有两个，都挂在这里（唯一挂载点）：`<CommandPalette />`（⌘K）与
 * `<Toaster />`（右下提示）。「系统」不再是浮层 —— 它是 `/system` 路由。
 *
 * 快捷键（`aria-keyshortcuts` 已经写在对应按钮上）：
 * - `⌘K` / `Ctrl+K`：命令面板（实现在 `CommandPalette` 自己身上，因为它要在关闭时也能开）；
 * - `⌘.` / `Ctrl+.`：去系统页（导航，不是模态框）；
 * - `[`：折叠 / 展开侧栏（与侧栏底部按钮同一个 `toggleSidebar`）。
 */
export function AppLayout() {
  return (
    <SidebarProvider className="h-dvh min-h-0 w-full overflow-hidden">
      <Shell />
    </SidebarProvider>
  );
}

function Shell() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { repo } = useRepoRoute();
  const { toggleSidebar } = useSidebar();
  const { data: system, isError } = useSystem();
  const degradation = degradedStateOf(system, isError);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      // `⌘.` / `Ctrl+.`：系统是**页面**，所以这里是跳转而不是开浮层
      if ((event.metaKey || event.ctrlKey) && event.key === '.') {
        event.preventDefault();
        void navigate(SYSTEM_PATH);
        return;
      }
      // `[`：折叠 / 展开侧栏。输入框里按 `[` 是打字，不是快捷键
      if (event.key !== '[' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
      }
      event.preventDefault();
      toggleSidebar();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [navigate, toggleSidebar]);

  return (
    <>
      {/* 键盘用户第一站：跳过侧栏直达主内容 */}
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

      <AppSidebar />

      {/*
        `SidebarInset` 本身就是 `<main>`：再套一层 `<main>` 会是嵌套 landmark。
        所以它承担「主内容 + 跳过链接目标」，里面再分固定行与滚动区。
      */}
      <SidebarInset
        id="main-content"
        tabIndex={-1}
        data-testid="shell-main"
        className="flex h-dvh min-w-0 flex-1 flex-col overflow-hidden"
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-2">
          <SidebarTrigger className="md:hidden" aria-label="打开侧栏" data-testid="sidebar-mobile-trigger" />
          <div className="min-w-0 flex-1 overflow-hidden">
            <StatusStrip repo={repo} state={degradation} />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={openCommandPalette}
            aria-keyshortcuts="Meta+K Control+K"
            data-testid="command-trigger"
            className="hidden shrink-0 gap-2 text-xs font-normal text-muted-foreground md:inline-flex"
          >
            <Search aria-hidden className="size-3.5" strokeWidth={1.75} />
            <span>搜索页面 / 仓库…</span>
            <Kbd className="h-4 text-2xs">⌘K</Kbd>
          </Button>
        </div>

        <DegradedBanner />

        {/*
          唯一滚动容器。`flex flex-col` 而不是光 `block`：Issue 页与设置页的根节点写的
          是 `flex-1`（它们自己内部还要再分几块滚动区），`flex-1` 只在 flex 父级里生效。
        */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-3 py-3 md:px-4 md:py-4">
          <div className="shrink-0 pb-2">
            <Breadcrumb items={crumbsFor(pathname)} testId="shell-breadcrumb" />
          </div>
          <Outlet />
        </div>
      </SidebarInset>

      <CommandPalette />
      <Toaster />
    </>
  );
}
