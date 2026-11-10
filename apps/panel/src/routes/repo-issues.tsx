import { useRepoRoute } from '../lib/repo-route.ts';
import { IssuesPage } from './issues.tsx';
import { NotFoundPage } from './not-found.tsx';
import { RepoPageFrame } from './RepoPageFrame.tsx';

/**
 * Issue 中心 `/repos/:repo/issues`。
 *
 * 同 `repo-runs.tsx`：复用 S-B 的 Issue 列表，只把仓库锁成路由参数。
 * 详情页是独立路由（`/repos/:repo/issues/:kind/:number`），行内链接由 `issues.tsx`
 * 的 `detailHref(item, repoLock)` 拼出来。
 */
export function RepoIssuesPage() {
  const { repo } = useRepoRoute();
  if (repo === null) return <NotFoundPage />;

  return (
    <RepoPageFrame repo={repo} crumb="Issue 中心">
      <IssuesPage repoLock={repo} />
    </RepoPageFrame>
  );
}
