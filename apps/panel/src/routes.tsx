import { Route, Routes } from 'react-router';
import type { ReactElement } from 'react';
import { AppLayout } from './layout/AppLayout.tsx';
import { REPO_NAV } from './layout/nav.ts';
import { IssueDetailPage } from './routes/issue-detail.tsx';
import {
  LegacyIssueDetailRedirect,
  LegacyIssueListRedirect,
  LegacyTaskDetailRedirect,
  LegacyTaskListRedirect,
} from './routes/legacy.tsx';
import { NotFoundPage } from './routes/not-found.tsx';
import { GlobalIssuesPage, RepoIssuesPage } from './routes/repo-issues.tsx';
import { RepoRunsPage } from './routes/repo-runs.tsx';
import { RepoSettingsPage } from './routes/repo-settings.tsx';
import { RepoSkillsPage } from './routes/repo-skills.tsx';
import { SystemPage } from './routes/system.tsx';
import { TaskDetailPage } from './routes/task-detail.tsx';

/**
 * 路由表 —— **一次冻结在这里**。
 *
 * 为什么用 `<Routes>` 而不是 `createBrowserRouter`：测试里要能塞 `MemoryRouter`
 * （jsdom 没有 History 语义），声明式路由两种入口通吃；`main.tsx` 用 `BrowserRouter`。
 *
 * 为什么 `:repo` 是**单段** `owner__name`：见 `lib/repo-route.ts` 的说明（编码/解码与往返）。
 *
 * 三组路径：
 * - `global`：不带仓库 —— `/`（「全部项目」的 Issue 队列）与 `/system`（系统页）；
 * - `repo`：`/repos/:repo/*`，承载项目级三件事（Issue / 设置 / 技能）+ 两个证据页；
 * - `legacy`：旧路径，只做 302 重定向（`routes/legacy.tsx`），不出现在导航里。
 *
 * **`AC-26` / `FR-7.1` 改写后的落点**：面板是侧栏式 admin。侧栏渲染的是 `layout/nav.ts` 的三组
 * （项目 / 证据 / 全局），这里的 `nav` 字段说的是「它是不是一级入口」—— 运行虽在侧栏的「证据」组
 * 里可点，但它是会话流里的证据，不是并列的一级入口，所以 `nav: false`。
 * 总览、成本、质量、审计四条路由**不存在**，所以任何书签、文档链接、命令面板条目都打不开它们
 * （不是「藏起来了」）。它们的去处见 `FR-7.2`：状态带、会话流、系统页。
 *
 * 「运行」与「运行详情」保留路由但 `nav: false`：它们是会话流里的**证据**
 * （`taskId` / 写回行点进去的详情）。侧栏的「证据」组按这条路由渲染，但它不是
 * 并列的一级入口 —— `nav` 说的就是这件事。
 *
 * 新增页面时**只改这一个数组**：导航（`layout/nav.ts`）、路由、四态测试断言
 * 都跟着它走；`routes/__tests__` 与 `test/routes.test.tsx` 会钉住这张表。
 */
export type PanelRouteGroup = 'global' | 'repo' | 'legacy';

export type PanelRoute = {
  path: string;
  label: string;
  /** 是否出现在侧栏的一级导航里；详情页、证据页与旧路径都是 false。 */
  nav: boolean;
  /**
   * **路径归属**（不带仓库 / 带仓库 / 旧路径），不是侧栏分组 —— 侧栏分组在 `layout/nav.ts`。
   * `'/'` 因此是 `global`（没有仓库段），而它在侧栏里落在「项目」组。
   */
  group: PanelRouteGroup;
  element: ReactElement;
};

export const PANEL_ROUTES: readonly PanelRoute[] = [
  /* ── 全部项目（没有仓库上下文） ──────────────────────────────────────────── */
  { path: '/', label: 'Issue', nav: true, group: 'global', element: <GlobalIssuesPage /> },
  { path: '/system', label: '系统', nav: true, group: 'global', element: <SystemPage /> },
  /* ── 当前项目 ──────────────────────────────────────────────────────────── */
  // 旧书签 `/repos/<repo>`（原「工作台」页）落到同一个 Issue 队列：那一页已按 `FR-7.1` 退役
  { path: '/repos/:repo', label: 'Issue', nav: false, group: 'repo', element: <RepoIssuesPage /> },
  { path: '/repos/:repo/issues', label: 'Issue', nav: true, group: 'repo', element: <RepoIssuesPage /> },
  {
    path: '/repos/:repo/issues/:kind/:number',
    label: 'Issue 会话',
    nav: false,
    group: 'repo',
    element: <IssueDetailPage />,
  },
  { path: '/repos/:repo/settings', label: '设置', nav: true, group: 'repo', element: <RepoSettingsPage /> },
  {
    path: '/repos/:repo/settings/:section',
    label: '设置分区',
    nav: false,
    group: 'repo',
    element: <RepoSettingsPage />,
  },
  { path: '/repos/:repo/skills', label: '技能', nav: true, group: 'repo', element: <RepoSkillsPage /> },
  // 证据页：从会话流的 `taskId` / 写回行点进来
  { path: '/repos/:repo/runs', label: '运行', nav: false, group: 'repo', element: <RepoRunsPage /> },
  { path: '/repos/:repo/runs/:id', label: '运行详情', nav: false, group: 'repo', element: <TaskDetailPage /> },

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

/** 项目级导航的键（供测试断言侧栏「项目」组与路由表一致；顺序 = 侧栏顺序）。 */
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
