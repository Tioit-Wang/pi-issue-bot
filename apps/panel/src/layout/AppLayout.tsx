import { NavLink, Outlet } from 'react-router';
import { cn } from '../lib/utils.ts';
import { DegradedBanner } from './DegradedBanner.tsx';

/**
 * 面板外壳（tech-plan §9.2）：左侧导航 + 顶栏 + **降级横幅位** + 内容区。
 *
 * 页面内容由 W3 的 session 填（每页一个文件），这里只提供：
 * - 固定的 7 条导航（`routes.tsx` 的 `PANEL_ROUTES` 是唯一来源，本文件只渲染 `nav: true` 的项）；
 * - 顶栏右侧的「只读 · 内网」标识（提醒操作者这里没有任何写操作）；
 * - `<DegradedBanner />`：全局降级横幅的**唯一挂载点**（doctor fail / host down / 熔断中）。
 */
export type NavItem = { path: string; label: string };

export type AppLayoutProps = {
  navItems: readonly NavItem[];
};

export function AppLayout({ navItems }: AppLayoutProps) {
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="flex w-48 shrink-0 flex-col border-r border-border bg-card/40 px-3 py-4">
        <div className="px-2 pb-4">
          <div className="text-sm font-semibold tracking-tight">pi-issue-bot</div>
          <div className="text-[11px] text-muted-foreground">控制面板 · 只读</div>
        </div>
        <nav className="flex flex-col gap-0.5">
          {navItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === '/'}
              className={({ isActive }) =>
                cn(
                  'rounded-md px-2.5 py-1.5 text-sm transition-colors',
                  isActive
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto px-2 text-[11px] leading-relaxed text-muted-foreground">
          数据来自只读 API
          <br />
          总览 10s · 列表 15s · 详情 5s
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center justify-between border-b border-border px-6">
          <span className="text-xs text-muted-foreground">内网工具 · 不做任何写操作（/retry 走 GitHub 评论）</span>
          <span className="text-[11px] text-muted-foreground">UTC 时区</span>
        </header>
        <DegradedBanner />
        <main className="min-w-0 flex-1 px-6 py-5">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
