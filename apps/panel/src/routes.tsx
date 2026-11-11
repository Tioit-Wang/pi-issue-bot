import { Route, Routes } from 'react-router';
import type { ReactElement } from 'react';
import { AppLayout } from './layout/AppLayout.tsx';
import { GLOBAL_NAV, REPO_NAV } from './layout/nav.ts';
import { AuditPage } from './routes/audit.tsx';
import { CostsPage } from './routes/costs.tsx';
import { IssueDetailPage } from './routes/issue-detail.tsx';
import {
  LegacyIssueDetailRedirect,
  LegacyIssueListRedirect,
  LegacyTaskDetailRedirect,
  LegacyTaskListRedirect,
} from './routes/legacy.tsx';
import { NotFoundPage } from './routes/not-found.tsx';
import { OverviewPage } from './routes/overview.tsx';
import { QualityPage } from './routes/quality.tsx';
import { RepoIssuesPage } from './routes/repo-issues.tsx';
import { RepoRunsPage } from './routes/repo-runs.tsx';
import { RepoSettingsPage } from './routes/repo-settings.tsx';
import { RepoSkillsPage } from './routes/repo-skills.tsx';
import { RepoWorkspacePage } from './routes/repo-workspace.tsx';
import { SkillsPage } from './routes/skills.tsx';
import { SystemPage } from './routes/system.tsx';
import { TaskDetailPage } from './routes/task-detail.tsx';

/**
 * 路由表 —— **一次冻结在这里**（多仓库工作台版，`docs/plan-multi-repo.md` §9）。
 *
 * 为什么用 `<Routes>` 而不是 `createBrowserRouter`：测试里要能塞 `MemoryRouter`
 * （jsdom 没有 History 语义），声明式路由两种入口通吃；`main.tsx` 用 `BrowserRouter`。
 *
 * 为什么 `:repo` 是**单段** `owner__name`：见 `lib/repo-route.ts` 的说明（编码/解码与往返）。
 *
 * 三组路径：
 * - `global`：不带仓库（总览/成本/质量/审计/技能/系统），URL 与改造前一致；
 * - `repo`：`/repos/:repo/*`，左栏「当前仓库」分组只用这几条；
 * - `legacy`：旧路径，只做 302 重定向（`routes/legacy.tsx`），不出现在导航里。
 *
 * 新增页面时**只改这一个数组**：导航（`layout/nav.ts` 的两个分组）、路由、四态测试断言
 * 都跟着它走；`routes/__tests__` 与 `test/routes.test.tsx` 会钉住这张表。
 */
export type PanelRouteGroup = 'global' | 'repo' | 'legacy';

export type PanelRoute = {
  path: string;
  label: string;
  /** 是否出现在左栏导航（详情页与旧路径重定向不出现在导航里）。 */
  nav: boolean;
  /** 路径归属（见文件头三组说明）。 */
  group: PanelRouteGroup;
  element: ReactElement;
};

export const PANEL_ROUTES: readonly PanelRoute[] = [
  /* ── 全局 ──────────────────────────────────────────────────────────────── */
  { path: '/', label: '总览', nav: true, group: 'global', element: <OverviewPage /> },
  { path: '/costs', label: '成本', nav: true, group: 'global', element: <CostsPage /> },
  { path: '/quality', label: '质量', nav: true, group: 'global', element: <QualityPage /> },
  { path: '/audit', label: '审计', nav: true, group: 'global', element: <AuditPage /> },
  { path: '/skills', label: '技能', nav: true, group: 'global', element: <SkillsPage /> },
  { path: '/system', label: '系统', nav: true, group: 'global', element: <SystemPage /> },

  /* ── 当前仓库 ──────────────────────────────────────────────────────────── */
  { path: '/repos/:repo', label: '工作台', nav: true, group: 'repo', element: <RepoWorkspacePage /> },
  { path: '/repos/:repo/issues', label: 'Issue 中心', nav: true, group: 'repo', element: <RepoIssuesPage /> },
  {
    path: '/repos/:repo/issues/:kind/:number',
    label: 'Issue 详情',
    nav: false,
    group: 'repo',
    element: <IssueDetailPage />,
  },
  { path: '/repos/:repo/runs', label: '运行', nav: true, group: 'repo', element: <RepoRunsPage /> },
  { path: '/repos/:repo/runs/:id', label: '运行详情', nav: false, group: 'repo', element: <TaskDetailPage /> },
  { path: '/repos/:repo/settings', label: '设置', nav: true, group: 'repo', element: <RepoSettingsPage /> },
  {
    path: '/repos/:repo/settings/:section',
    label: '设置分区',
    nav: false,
    group: 'repo',
    element: <RepoSettingsPage />,
  },
  { path: '/repos/:repo/skills', label: '技能', nav: true, group: 'repo', element: <RepoSkillsPage /> },

  /* ── 旧路径（302 重定向，见 routes/legacy.tsx） ──────────────────────────── */
  { path: '/tasks', label: '任务（旧链接）', nav: false, group: 'legacy', element: <LegacyTaskListRedirect /> },
  { path: '/tasks/:id', label: '任务详情（旧链接）', nav: false, group: 'legacy', element: <LegacyTaskDetailRedirect /> },
  { path: '/issues', label: 'Issue 会话（旧链接）', nav: false, group: 'legacy', element: <LegacyIssueListRedirect /> },
  {
    path: '/issues/:owner/:name/:kind/:number',
    label: 'Issue 会话详情（旧链接）',
    nav: false,
    group: 'legacy',
    element: <LegacyIssueDetailRedirect />,
  },
];

/**
 * 旧的 `NAV_ITEMS`（= 全局导航）。
 *
 * 保留是为了不破坏 `index.ts` 的对外导出与既有引用；**新代码请用** `layout/nav.ts` 的
 * `GLOBAL_NAV` / `REPO_NAV`（仓库那一组要按当前 `:repo` 拼路径，静态表拼不出来）。
 */
export const NAV_ITEMS = GLOBAL_NAV.map((item) => ({ path: item.path, label: item.label }));

/** 左栏「当前仓库」分组的键（供测试断言导航与路由表一致）。 */
export const REPO_NAV_KEYS = REPO_NAV.map((item) => item.key);

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
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
