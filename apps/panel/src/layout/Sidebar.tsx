import { useEffect, type ReactNode } from 'react';
import { NavLink } from 'react-router';
import { StatusDot } from '../components/ui/badge.tsx';
import { useSystem } from '../lib/queries.ts';
import { rememberLastRepo, useRepoRoute } from '../lib/repo-route.ts';
import { cn } from '../lib/utils.ts';
import { GLOBAL_NAV, REPO_NAV, repoNavPath } from './nav.ts';
import { RepoSwitcher } from './RepoSwitcher.tsx';
import type { ViewportMode } from './use-viewport.ts';

/**
 * 左栏：**一列、两个分组**（`docs/plan-multi-repo.md` §9）。
 *
 * ```
 * [仓库切换器]
 * 全局      总览 成本 质量 审计 技能 系统
 * ─────────
 * 当前仓库  工作台 Issue 中心 运行 设置
 * [底部：连接状态 / 版本 / 轮询口径]
 * ```
 *
 * 当前项的标记方式（D1）：**品牌色 8% 底 + 左缘 2px 品牌条**，不是胶囊高亮 ——
 * 胶囊会和按钮抢视觉语言，而这个控制台里"当前在哪一页"需要一眼可辨。
 * 分组标题用 10px 微标签（大写 + 0.02em 字距）+ 组间 hairline，只做分组，不做折叠。
 *
 * 没有选中仓库时**整组「当前仓库」不渲染**（D4）：空分组 + 一句"先选一个仓库"只是噪音，
 * 版面上少一组就等于说明了"还没有仓库上下文"，选择入口就在上方。
 *
 * 响应式：`narrow` 下变成抽屉（`translate` + `inert` 关闭时不进 Tab 序），
 * `medium` 下可折叠（顶栏按钮控制），`wide` 下常驻。
 */
export type SidebarProps = {
  mode: ViewportMode;
  open: boolean;
  onClose: () => void;
};

export function Sidebar({ mode, open, onClose }: SidebarProps) {
  const { repo } = useRepoRoute();

  useEffect(() => {
    if (repo !== null) rememberLastRepo(repo);
  }, [repo]);

  return (
    <aside
      id="app-sidebar"
      aria-label="侧栏"
      data-testid="app-sidebar"
      data-state={open ? 'open' : 'closed'}
      // 抽屉关闭时整块不可聚焦（`inert` 比 `aria-hidden` 更彻底：Tab 也进不去）
      inert={mode === 'narrow' && !open}
      className={cn(
        'z-30 flex w-56 shrink-0 flex-col border-r border-border bg-card',
        mode === 'narrow'
          ? 'fixed inset-y-0 left-0 shadow-overlay transition-transform duration-[220ms] ease-out-quint'
          : 'relative',
        mode === 'narrow' && !open && '-translate-x-full',
        mode === 'medium' && !open && 'hidden',
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 py-2">
        <RepoSwitcher />

        <nav className="flex flex-col" aria-label="主导航">
          <NavGroup label="全局">
            {GLOBAL_NAV.map((item) => (
              <SidebarLink key={item.path} to={item.path} end={item.end === true} onNavigate={onClose} mode={mode}>
                {item.label}
              </SidebarLink>
            ))}
          </NavGroup>

          {repo === null ? null : (
            <NavGroup label="当前仓库" divider>
              {REPO_NAV.map((item) => (
                <SidebarLink
                  key={item.key}
                  to={repoNavPath(repo, item.key)}
                  end={item.end}
                  onNavigate={onClose}
                  mode={mode}
                >
                  {item.label}
                </SidebarLink>
              ))}
            </NavGroup>
          )}
        </nav>
      </div>

      <SidebarFooter />
    </aside>
  );
}

/**
 * 一个分组的标题 + 链接。
 *
 * `divider` 给第二组及之后的组：`mt-2 pt-2` + 一根 hairline —— 分组之间必须有可见的分界，
 * 否则两串链接读起来是一串 10 项的导航。
 */
function NavGroup({
  label,
  divider = false,
  children,
}: {
  label: string;
  divider?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-px',
        divider && 'mt-2 border-t border-border pt-2',
      )}
    >
      <p className="micro-label px-2 pb-1">{label}</p>
      {children}
    </div>
  );
}

function SidebarLink({
  to,
  end,
  children,
  onNavigate,
  mode,
}: {
  to: string;
  end: boolean;
  children: ReactNode;
  onNavigate: () => void;
  mode: ViewportMode;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={() => {
        // 抽屉模式下点完就收起（宽屏不受影响）
        if (mode === 'narrow') onNavigate();
      }}
      className={({ isActive }) =>
        cn(
          'relative flex h-7 items-center rounded-sm px-2 text-sm',
          'transition-[background-color,color] duration-[120ms] ease-out-quint',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
          isActive
            ? 'bg-brand-soft font-medium text-foreground before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-brand'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )
      }
    >
      {children}
    </NavLink>
  );
}

/** 底部：连接状态 + 版本 + 轮询口径（这是"数据有多新"的唯一说明处）。 */
function SidebarFooter() {
  const { data, isError } = useSystem();

  const hostDown = data?.host.status === 'down';
  const degraded = data?.doctor.status === 'fail' || data?.host.status === 'degraded';
  const tone = isError || hostDown ? 'danger' : degraded ? 'warn' : 'success';
  const label = isError ? '系统接口不可达' : hostDown ? 'pi-host 不可达' : degraded ? '降级运行' : '运行正常';

  return (
    <div className="border-t border-border px-2 py-2">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="sidebar-connection">
        <StatusDot tone={tone} />
        <span className="truncate">{label}</span>
      </div>
      <p className="mt-1 text-2xs leading-relaxed text-faint">
        工作台 10s · 列表 15s · 详情 5s · UTC
      </p>
    </div>
  );
}
