/**
 * 导航表（**只描述结构，不引用组件**）：左栏、路由表、面包屑都从这里取。
 *
 * 为什么单独一个文件：`routes.tsx` 要 import 页面、页面 import 导航（拼链接）、
 * 外壳 import 导航 —— 全放 `routes.tsx` 会形成循环 import。这里只放常量与拼路径的纯函数，
 * 任何方向引用都安全。
 *
 * 两级结构（`docs/plan-multi-repo.md` §9）：
 * - 全局：不依赖仓库，URL 不带 `:repo`；
 * - 当前仓库：URL 前缀 `/repos/:repo`，`repo` 的编码规则见 `lib/repo-route.ts`。
 */
import { repoWorkspacePath } from '../lib/repo-route.ts';

export type GlobalNavItem = {
  path: string;
  label: string;
  /** `NavLink` 的 `end`：`/` 只有精确匹配才算选中。 */
  end?: boolean;
};

/** 全局导航（顺序 = 左栏顺序）。 */
export const GLOBAL_NAV: readonly GlobalNavItem[] = [
  { path: '/', label: '总览', end: true },
  { path: '/costs', label: '成本' },
  { path: '/quality', label: '质量' },
  { path: '/audit', label: '审计' },
  { path: '/skills', label: '技能' },
  { path: '/system', label: '系统' },
];


export type RepoNavKey = 'workspace' | 'issues' | 'runs' | 'settings' | 'skills';

export type RepoNavItem = {
  key: RepoNavKey;
  label: string;
  /** 相对仓库根的后缀（工作台是空串）。 */
  suffix: string;
  end: boolean;
};

/**
 * 当前仓库导航。Issue 详情 / 运行详情是子页面（`nav: false`），不在这里。
 *
 * 顺序即信息优先级：工作台 → Issue 中心 → 运行 → 设置 → 技能。
 * 「技能」留在最后：它是配置类入口，日常看板与队列排在它前面。
 * v0.3 的「流水线」页与它那一组阶段视图已随固定流水线退役删除。
 */
export const REPO_NAV: readonly RepoNavItem[] = [
  { key: 'workspace', label: '工作台', suffix: '', end: true },
  { key: 'issues', label: 'Issue 中心', suffix: '/issues', end: false },
  { key: 'runs', label: '运行', suffix: '/runs', end: false },
  { key: 'settings', label: '设置', suffix: '/settings', end: false },
  { key: 'skills', label: '技能', suffix: '/skills', end: false },
];

/** 拼出某个仓库导航项的绝对路径（`repo` 是 `owner/name`）。 */
export function repoNavPath(repo: string, key: RepoNavKey): string {
  const item = REPO_NAV.find((candidate) => candidate.key === key);
  return `${repoWorkspacePath(repo)}${item?.suffix ?? ''}`;
}

/** 设置分区（`docs/impl-multi-repo.md` §4 W3-I；提示词分区已随 v0.3 退役，剩 4 个）。 */
export const SETTINGS_SECTIONS = [
  { key: 'general', label: '通用' },
  { key: 'triggers', label: '触发' },
  { key: 'labels', label: '标签' },
  { key: 'limits', label: '限额' },
] as const;

export type SettingsSectionKey = (typeof SETTINGS_SECTIONS)[number]['key'];

export function isSettingsSectionKey(value: string | undefined): value is SettingsSectionKey {
  return SETTINGS_SECTIONS.some((section) => section.key === value);
}
