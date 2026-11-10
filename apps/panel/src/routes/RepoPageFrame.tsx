import type { ReactNode } from 'react';
import { Breadcrumb, type Crumb } from '../components/Breadcrumb.tsx';
import { repoWorkspacePath } from '../lib/repo-route.ts';

/**
 * 仓库维度页面的统一外框：**面包屑 + 页面内容**。
 *
 * 面包屑固定三段：`全部项目 / <repo> / <当前页>`。为什么每页都画：两级导航里
 * 「当前仓库」在左栏只是分组标题，页面本身必须能回答「我在哪个仓库的哪一页」——
 * 尤其是从首页健康卡直接跳进来的时候。
 */
export function repoCrumbs(repo: string, tail: readonly Crumb[]): Crumb[] {
  return [{ label: '全部项目', to: '/' }, { label: repo, to: repoWorkspacePath(repo) }, ...tail];
}

export function RepoPageFrame({
  repo,
  crumb,
  children,
}: {
  repo: string;
  /** 当前页名字（面包屑最后一段，不可点）。 */
  crumb: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Breadcrumb testId="repo-breadcrumb" items={repoCrumbs(repo, [{ label: crumb }])} />
      {children}
    </div>
  );
}
