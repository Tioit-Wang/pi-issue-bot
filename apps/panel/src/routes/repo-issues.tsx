import { useRepoRoute } from '../lib/repo-route.ts';
import { IssuesPage } from './issues.tsx';
import { NotFoundPage } from './not-found.tsx';
import { RepoPageFrame } from './RepoPageFrame.tsx';

/**
 * 项目 Issue 队列 `/repos/:repo/issues`（旧书签 `/repos/:repo` 也落在这里）。
 *
 * 只把仓库锁成路由参数，其余（队列 + 会话流 + 筛选 + 键盘）都在 `issues.tsx` 里 ——
 * 「全部项目」与「单个项目」是**同一个页面**，区别只是仓库锁（`AC-26` 之后没有第二个列表页）。
 */
export function RepoIssuesPage() {
  const { repo } = useRepoRoute();
  if (repo === null) return <NotFoundPage />;

  return (
    <RepoPageFrame repo={repo} crumb="Issue">
      <IssuesPage repoLock={repo} />
    </RepoPageFrame>
  );
}

/**
 * 「全部项目」的 Issue 队列（`/`）：没有仓库锁，所以工具条上有仓库下拉。
 *
 * 这是 `AC-26` 之后面板的**首页**（原来这里是「总览」页）。
 * 不进 `RepoPageFrame`：没有项目上下文就没有项目面包屑，位置感由左上角的切换器承担。
 */
export function GlobalIssuesPage() {
  return <IssuesPage />;
}
