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

/**
 * 设置分区（v2.1 整合版，**四项**）。
 *
 * 合并原则：同一个问题只留一个入口。
 * - 「通用」：仓库启停与写回；
 * - 「事件绑定」：五个事件的开关 + 提示词模板 + 评论闸门 + 提及关键词 + 角色清单
 *   （原来的「事件与模板」+「评论触发」+「触发」三项，原「事件与提示词」一名已弃用）；
 * - 「标签」：词表 + 判定映射 + 目标态字段（原「标签」+「标签目录 v2.1」）；
 * - 「执行」：系统提示词 + 两套限额 + 写回动作开关 + 默认模型
 *   （原「执行与限额」+「限额」）。
 */
export const SETTINGS_SECTIONS = [
  { key: 'general', label: '通用' },
  { key: 'events', label: '事件绑定' },
  { key: 'labels', label: '标签' },
  { key: 'execution', label: '执行' },
] as const;

export type SettingsSectionKey = (typeof SETTINGS_SECTIONS)[number]['key'];

/**
 * 旧分区 key → 新分区 key。
 *
 * 老书签 / 文档里的 `settings/comment`、`settings/catalog`、`settings/triggers`、`settings/limits`
 * 仍然要能打开（而不是 404）：它们的内容都已经并进上面四项，按这张表跳过去。
 */
export const LEGACY_SETTINGS_SECTIONS: Readonly<Record<string, SettingsSectionKey>> = {
  comment: 'events',
  triggers: 'events',
  catalog: 'labels',
  limits: 'execution',
};

export function isSettingsSectionKey(value: string | undefined): value is SettingsSectionKey {
  return SETTINGS_SECTIONS.some((section) => section.key === value);
}

/** 旧 key 归一（新 key 原样返回；认不出的返回 `null`）。 */
export function normalizeSettingsSection(value: string | undefined): SettingsSectionKey | null {
  if (value === undefined) return null;
  if (isSettingsSectionKey(value)) return value;
  return LEGACY_SETTINGS_SECTIONS[value] ?? null;
}
