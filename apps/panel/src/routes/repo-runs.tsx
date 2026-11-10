import { useRepoRoute } from '../lib/repo-route.ts';
import { NotFoundPage } from './not-found.tsx';
import { RepoPageFrame } from './RepoPageFrame.tsx';
import { TasksPage } from './tasks.tsx';

/**
 * 运行列表 `/repos/:repo/runs`。
 *
 * 复用 S2 的任务列表（列、筛选、游标分页都已在 `tasks.tsx` 里实现并有测试），
 * 只把仓库**锁**成路由里的那个：查询带 `repo`、仓库下拉隐藏、行点击进
 * `/repos/:repo/runs/:id`。W2-F 若要改成「运行」专用列，直接改 `tasks.tsx` 即可，
 * 本文件只是一层参数适配。
 */
export function RepoRunsPage() {
  const { repo } = useRepoRoute();
  if (repo === null) return <NotFoundPage />;

  return (
    <RepoPageFrame repo={repo} crumb="运行">
      <TasksPage repoLock={repo} />
    </RepoPageFrame>
  );
}
