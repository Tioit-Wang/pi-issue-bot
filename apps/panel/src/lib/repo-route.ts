/**
 * 仓库 → URL 的**唯一**换算处（多仓库工作台的两级导航都靠它）。
 *
 * 约定（`docs/plan-multi-repo.md` §9）：
 * - `:repo` 是**单段**编码 `owner__name`。为什么不用两段 `:owner/:name`：两级导航里
 *   `/repos/:repo/issues/:kind/:number` 已经 5 段，再拆 owner/name 会让「Issue 详情的编号」
 *   挤到第 6 段，且所有 `to=` 都要重新拼。单段编码只有一个真相源，路由表也短。
 * - 分隔符取 `__` 且在**第一个** `__` 处切分：GitHub 的 owner 不允许下划线，
 *   所以 `acme/foo__bar` 这种仓库名也能无损往返（见 `repo-route.test.ts`）。
 * - 「上次打开的仓库」存在 localStorage：旧链接 `/tasks/:id` → 302 到运行详情时需要它
 *   （旧 URL 里没有仓库信息，也拿不到任务归属，见 `routes/legacy.tsx` 的说明）。
 *
 * 这个文件**不碰** `lib/contract.ts` / `lib/api.ts`（那两个归 W3-H）：纯路径与存储，
 * 与接口契约无关。
 */
import { useParams } from 'react-router';

/** URL 里的单段分隔符（`owner__name`）。 */
export const REPO_PATH_SEGMENT_SEPARATOR = '__';

/** localStorage 里「上次打开的仓库」的键。 */
export const LAST_REPO_STORAGE_KEY = 'pi-panel:last-repo';

/** 仓库名各段的合法字符（GitHub 的 owner/name 都落在这个集合里）。 */
const PART_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * `owner/name` → `owner__name`。
 *
 * 非法输入（没有 `/`、以 `/` 开头或结尾）**原样返回**：调用方要么已经拿到契约里的
 * `repo`（必然合法），要么就是拼错了；让 `decodeRepo` 返回 `null` 落到 404，
 * 比在这里抛异常把整页打崩更好。
 */
export function encodeRepo(repo: string): string {
  const index = repo.indexOf('/');
  if (index <= 0 || index === repo.length - 1) return repo;
  return `${repo.slice(0, index)}${REPO_PATH_SEGMENT_SEPARATOR}${repo.slice(index + 1)}`;
}

/** `owner__name` → `owner/name`；不是合法的单段编码时返回 `null`（页面显示 404）。 */
export function decodeRepo(segment: string): string | null {
  const index = segment.indexOf(REPO_PATH_SEGMENT_SEPARATOR);
  if (index <= 0) return null;

  const owner = segment.slice(0, index);
  const name = segment.slice(index + REPO_PATH_SEGMENT_SEPARATOR.length);
  if (name === '') return null;
  // 两段都不允许再出现 `/`（那说明链接是「两段式」的旧写法，不是单段编码）
  if (owner.includes('/') || name.includes('/')) return null;
  if (!PART_PATTERN.test(owner) || !PART_PATTERN.test(name)) return null;
  return `${owner}/${name}`;
}

/* ── 路径构造（页面只许用这几个函数拼 URL） ───────────────────────────────── */

export function repoWorkspacePath(repo: string): string {
  return `/repos/${encodeRepo(repo)}`;
}

export function repoIssuesPath(repo: string): string {
  return `${repoWorkspacePath(repo)}/issues`;
}

export function repoIssuePath(repo: string, kind: string, number: string | number): string {
  return `${repoIssuesPath(repo)}/${encodeURIComponent(kind)}/${encodeURIComponent(String(number))}`;
}

export function repoRunsPath(repo: string): string {
  return `${repoWorkspacePath(repo)}/runs`;
}

export function repoRunPath(repo: string, runId: string): string {
  return `${repoRunsPath(repo)}/${encodeURIComponent(runId)}`;
}

/** 设置分区（`general|triggers|labels|limits|prompt`）；不传就是设置首页。 */
export function repoSettingsPath(repo: string, section?: string): string {
  const base = `${repoWorkspacePath(repo)}/settings`;
  return section === undefined || section === '' ? base : `${base}/${encodeURIComponent(section)}`;
}

/** GitHub 上的仓库地址（「打开 GitHub」用；只对合法 `owner/name` 生效）。 */
export function repoGitHubUrl(repo: string): string | null {
  const index = repo.indexOf('/');
  if (index <= 0 || index === repo.length - 1) return null;
  return `https://github.com/${repo}`;
}

/* ── 「上次打开的仓库」（旧链接兼容用） ───────────────────────────────────── */

/** 读 localStorage；浏览器禁用存储或值不合法时返回 `null`（绝不抛）。 */
export function readLastRepo(): string | null {
  try {
    const value = globalThis.localStorage?.getItem(LAST_REPO_STORAGE_KEY) ?? null;
    if (value === null) return null;
    const decoded = decodeRepo(value);
    return decoded;
  } catch {
    return null;
  }
}

/** 记住当前仓库（在仓库维度页面挂载时调用）。 */
export function rememberLastRepo(repo: string): void {
  try {
    globalThis.localStorage?.setItem(LAST_REPO_STORAGE_KEY, encodeRepo(repo));
  } catch {
    // 隐私模式 / 存储被禁用：旧链接会退化成回首页，这不值得打断当前页面
  }
}

/** 只给测试用：清掉记住的仓库，避免用例之间互相污染。 */
export function forgetLastRepo(): void {
  try {
    globalThis.localStorage?.removeItem(LAST_REPO_STORAGE_KEY);
  } catch {
    // 同上：存储不可用时什么也不用做
  }
}

/* ── 路由参数 ─────────────────────────────────────────────────────────────── */

export type RepoRoute = {
  /** 解码后的 `owner/name`；编码非法时为 `null`。 */
  repo: string | null;
  /** URL 里的原始单段（`owner__name`）。 */
  segment: string | null;
};

/** 读当前路由的 `:repo`（`/repos/:repo/...` 下都可用；其它路由返回 `null`）。 */
export function useRepoRoute(): RepoRoute {
  const params = useParams();
  const segment = params['repo'] ?? null;
  return { repo: segment === null ? null : decodeRepo(segment), segment };
}
