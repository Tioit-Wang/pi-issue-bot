import { Navigate, useParams } from 'react-router';
import { readLastRepo, repoIssuePath, repoIssuesPath, repoRunPath, repoRunsPath } from '../lib/repo-route.ts';

/**
 * 旧路径兼容（`docs/impl-multi-repo.md` §4 W1-C 第 1 条「旧 `/tasks/:id`、`/issues/:owner/:name/...`
 * 保留 302 重定向」）。
 *
 * 「302」在这里是**客户端语义**：`<Navigate replace>` 直接把当前历史项换掉，不产生一条
 * 可以「后退回到旧地址」的记录——和 302 一样是「临时改道，别记着」。SPA 没有真正的
 * HTTP 状态码可用（`main.tsx` 用 `BrowserRouter`），所以用 react-router 既有的能力实现，
 * 不引入额外依赖。
 *
 * 映射表：
 * ```
 * /tasks                     → /repos/<lastRepo>/runs         （无 lastRepo → /）
 * /tasks/:id                 → /repos/<lastRepo>/runs/:id     （无 lastRepo → /）
 * /issues                    → /repos/<lastRepo>/issues       （无 lastRepo → /）
 * /issues/:owner/:name/:kind/:number
 *                            → /repos/<owner>__<name>/issues/:kind/:number
 * ```
 * 为什么 `/tasks/:id` 要靠 localStorage 而不是查一次接口：旧 URL 里只有任务 id，
 * 而 `GET /api/tasks/:id` 的响应体里虽然带 `repo`，但那要先把页面渲染出来再等一次往返，
 * 且 404 时没有任何信息可用。`<Sidebar />` 会在每次进入仓库维度页面时写入
 * `pi-panel:last-repo`，所以常用路径下这个值总是最新的；实在没有就回首页。
 */
/** `/tasks`：旧的任务列表 → 上次打开的仓库的运行列表。 */
export function LegacyTaskListRedirect() {
  const repo = readLastRepo();
  return <Navigate replace to={repo === null ? '/' : repoRunsPath(repo)} />;
}

/** `/tasks/:id`：旧的任务详情 → 上次打开的仓库的运行详情（同 id）。 */
export function LegacyTaskDetailRedirect() {
  const params = useParams();
  const repo = readLastRepo();
  const id = params['id'] ?? '';

  if (repo === null || id === '') return <Navigate replace to="/" />;
  return <Navigate replace to={repoRunPath(repo, id)} />;
}

/** `/issues`：旧 Issue 列表 → 上次打开的仓库的 Issue 中心。 */
export function LegacyIssueListRedirect() {
  const repo = readLastRepo();
  return <Navigate replace to={repo === null ? '/' : repoIssuesPath(repo)} />;
}

/** `/issues/:owner/:name/:kind/:number`：旧四段路径 → `/repos/:repo/issues/:kind/:number`。 */
export function LegacyIssueDetailRedirect() {
  const params = useParams();
  const owner = params['owner'] ?? '';
  const name = params['name'] ?? '';
  const kind = params['kind'] === 'pr' ? 'pr' : 'issue';
  const number = params['number'] ?? '';

  if (owner === '' || name === '' || number === '') return <Navigate replace to="/" />;
  return <Navigate replace to={repoIssuePath(`${owner}/${name}`, kind, number)} />;
}
