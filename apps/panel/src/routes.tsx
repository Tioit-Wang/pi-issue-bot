import { Route, Routes } from 'react-router';
import type { ReactElement } from 'react';
import { AppLayout } from './layout/AppLayout.tsx';
import { AuditPage } from './routes/audit.tsx';
import { CostsPage } from './routes/costs.tsx';
import { IssueDetailPage } from './routes/issue-detail.tsx';
import { IssuesPage } from './routes/issues.tsx';
import { NotFoundPage } from './routes/not-found.tsx';
import { OverviewPage } from './routes/overview.tsx';
import { QualityPage } from './routes/quality.tsx';
import { SkillsPage } from './routes/skills.tsx';
import { SystemPage } from './routes/system.tsx';
import { TaskDetailPage } from './routes/task-detail.tsx';
import { TasksPage } from './routes/tasks.tsx';

/**
 * 路由表 —— **一次冻结在这里**（tech-plan §9.2）：原 7 条 + Issue 会话 2 条（R3）+ 技能 1 条（R9）。
 *
 * 为什么用 `<Routes>` 而不是 `createBrowserRouter`：
 * 测试里要能塞 `MemoryRouter`（jsdom 没有 History 语义），声明式路由两种入口通吃；
 * `main.tsx` 用 `BrowserRouter`，测试用 `MemoryRouter`，路由表本身不感知。
 *
 * `nav` 决定是否出现在左侧导航（任务详情是子页面，不出现在导航里）。
 * 新增页面时**只改这一个数组**：导航、路由、测试断言都跟着走。
 */
export type PanelRoute = {
  path: string;
  label: string;
  nav: boolean;
  element: ReactElement;
};

export const PANEL_ROUTES: readonly PanelRoute[] = [
  { path: '/', label: '总览', nav: true, element: <OverviewPage /> },
  { path: '/tasks', label: '任务', nav: true, element: <TasksPage /> },
  { path: '/tasks/:id', label: '任务详情', nav: false, element: <TaskDetailPage /> },
  { path: '/costs', label: '成本', nav: true, element: <CostsPage /> },
  { path: '/quality', label: '质量', nav: true, element: <QualityPage /> },
  { path: '/audit', label: '审计', nav: true, element: <AuditPage /> },
  { path: '/issues', label: 'Issue 会话', nav: true, element: <IssuesPage /> },
  {
    path: '/issues/:owner/:name/:kind/:number',
    label: 'Issue 会话详情',
    nav: false,
    element: <IssueDetailPage />,
  },
  { path: '/skills', label: '技能', nav: true, element: <SkillsPage /> },
  { path: '/system', label: '系统', nav: true, element: <SystemPage /> },
];

/** 左侧导航项（顺序 = 路由表顺序）。 */
export const NAV_ITEMS = PANEL_ROUTES.filter((route) => route.nav).map((route) => ({
  path: route.path,
  label: route.label,
}));

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppLayout navItems={NAV_ITEMS} />}>
        {PANEL_ROUTES.map((route) =>
          route.path === '/' ? (
            <Route key={route.path} index element={route.element} />
          ) : (
            <Route key={route.path} path={route.path.slice(1)} element={route.element} />
          ),
        )}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
