import { NavLink } from 'react-router';
import { CircleDot, History, Settings2, SlidersHorizontal, Sparkles } from 'lucide-react';
import {
  Sidebar as SidebarShell,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
} from '../components/ui/sidebar.tsx';
import { useRepoRoute } from '../lib/repo-route.ts';
import { cn } from '../lib/utils.ts';
import { navGroups, type NavItemKey } from './nav.ts';
import { RepoSwitcher } from './RepoSwitcher.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';

/**
 * 侧栏：**面板的唯一导航**（`FR-7.1` / `AC-26` 改写后：侧栏式 admin）。
 *
 * 版面从上到下：
 * 1. **品牌 + 仓库切换器**（项目上下文，`FR-7.1` 的第一层）；
 * 2. **三组导航**：项目 / 证据 / 全局（分组的理由见 `layout/nav.ts` 的文件头表格）；
 * 3. **底部工具**：主题切换 + 折叠按钮。
 *
 * 折叠用官方 `collapsible="icon"`：折叠后只剩图标 + tooltip，宽度从 16rem 变 3rem。
 * 移动端（`useIsMobile`）由 `ui/sidebar.tsx` 自己换成 `Sheet`，这里不需要分支 ——
 * 一处实现，两种断点，避免「桌面一套、移动端另一套」的第二处真相。
 *
 * 高亮的判定交给 `NavLink`（`aria-current="page"` 由它写），不在每次渲染里手算前缀匹配：
 * `end` 已经把「设置」与「设置分区」的差别说清了。
 */
const ICONS: Record<NavItemKey, typeof CircleDot> = {
  issues: CircleDot,
  settings: Settings2,
  skills: Sparkles,
  runs: History,
  system: SlidersHorizontal,
};

export function AppSidebar() {
  const { repo } = useRepoRoute();
  const groups = navGroups(repo);

  return (
    <SidebarShell collapsible="icon" data-testid="app-sidebar">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1 group-data-[collapsible=icon]:px-0">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">pi-issue-bot</span>
        </div>
        <div className="group-data-[collapsible=icon]:hidden">
          <RepoSwitcher />
        </div>
      </SidebarHeader>

      <SidebarContent role="navigation" aria-label="主导航">
        {groups.map((group) => {
          const links = group.links.filter((link) => link.path !== null);
          if (links.length === 0) return null;
          return (
            <SidebarGroup key={group.key} data-testid={`nav-group-${group.key}`}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {links.map((link) => {
                    const Icon = ICONS[link.key];
                    const to = link.path ?? '/';
                    return (
                      <SidebarMenuItem key={link.key}>
                        <SidebarMenuButton asChild tooltip={link.label}>
                          <NavLink
                            to={to}
                            end={link.end}
                            title={link.title}
                            data-testid={`nav-${link.key}`}
                            className={({ isActive }) =>
                              cn(isActive && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground')
                            }
                          >
                            <Icon aria-hidden strokeWidth={1.75} />
                            <span>{link.label}</span>
                          </NavLink>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
      </SidebarContent>

      <SidebarFooter>
        <div className="flex items-center justify-between gap-1 group-data-[collapsible=icon]:flex-col">
          <ThemeToggle />
          {/*
            折叠按钮：`aria-keyshortcuts` 与 `AppLayout` 里的 `[` 全局键一致 ——
            快捷键只有一处实现，但两处都要告诉读屏用户「按什么」。
          */}
          <SidebarTrigger aria-keyshortcuts="[" title="折叠 / 展开侧栏（[）" data-testid="sidebar-toggle" />
        </div>
      </SidebarFooter>

      <SidebarRail />
    </SidebarShell>
  );
}
