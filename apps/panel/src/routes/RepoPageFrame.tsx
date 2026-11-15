import type { ReactNode } from 'react';
import type { Crumb } from '../components/Breadcrumb.tsx';
import { repoWorkspacePath } from '../lib/repo-route.ts';

/**
 * 仓库维度页面的统一外框。
 *
 * 改造前它自己画一条面包屑（`全部项目 / <repo> / <当前页>`），改造后**不再画**：
 * 侧栏式外壳（`layout/AppLayout.tsx`）在内容区顶部统一渲染 `shell-breadcrumb`，
 * 一个视图里只允许有一条面包屑。这一层现在只剩「页面之间一致的外边距」。
 *
 * `crumb` / `repoCrumbs` 保留：`repoCrumbs` 还被 `task-detail` 用来拼 `PageHeader` 的
 * `breadcrumb`（该 prop 现在同样由外壳承担渲染），删掉会连带改别的 session 的文件。
 */
export function repoCrumbs(repo: string, tail: readonly Crumb[]): Crumb[] {
  return [{ label: '全部项目', to: '/' }, { label: repo, to: repoWorkspacePath(repo) }, ...tail];
}

export function RepoPageFrame({
  crumb,
  children,
}: {
  repo: string;
  /** 当前页名字（保留：语言上的自说明，外壳面包屑按路由算同一段）。 */
  crumb: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3" data-page-crumb={crumb}>
      {children}
    </div>
  );
}
