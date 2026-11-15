/**
 * 导航表（**只描述结构，不引用组件**）：侧栏、路由表、面包屑、命令面板都从这里取。
 *
 * 为什么单独一个文件：`routes.tsx` 要 import 页面、页面 import 导航（拼链接）、
 * 外壳 import 导航 —— 全放 `routes.tsx` 会形成循环 import。这里只放常量与拼路径的纯函数，
 * 任何方向引用都安全。
 *
 * ## 信息架构（`FR-7.1` / `AC-26` 改写后：侧栏式 admin）
 *
 * 侧栏分三组，组名就是「这是哪一层」：
 *
 * | 组 | 项 | 为什么在这一组 |
 * | --- | --- | --- |
 * | **项目** | Issue / 设置 / 技能 | 都要有项目上下文才有意义（`path` 为 `null` 时不渲染） |
 * | **证据** | 运行 | 会话流里点 `taskId` / 写回行进来的证据页，路由 `nav: false`：不是并列的一级入口，但仍要能从侧栏找回 |
 * | **全局** | 系统 | 不依赖项目，`/system`；原来是「系统」模态框，现在是一条真路由 |
 *
 * 为什么不再有「总览 / 成本 / 质量 / 审计」四项：它们的去处见 `FR-7.2`
 * （状态带、会话流、系统页），没有任何一项需要一个新的侧栏入口。
 *
 * 顺序即信息优先级：**Issue 在最上**，它是唯一的高频动作（处理某一条卡住的 issue）。
 */
import { decodeRepo, repoWorkspacePath } from '../lib/repo-route.ts';

/** 项目级导航项的键（Issue / 设置 / 技能）。 */
export type RepoNavKey = 'issues' | 'settings' | 'skills';

/** 侧栏里出现过的所有键（含证据与全局）。 */
export type NavItemKey = RepoNavKey | 'runs' | 'system';

/** 侧栏分组键（顺序 = 侧栏从上到下）。 */
export type NavGroupKey = 'project' | 'evidence' | 'global';

export type RepoNavItem = {
  key: RepoNavKey;
  label: string;
  /** 相对仓库根的后缀。 */
  suffix: string;
  /** `NavLink` 的 `end`：前缀匹配还是精确匹配。 */
  end: boolean;
  /** 侧栏折叠成图标时的一句话说明（`title` / tooltip 用）。 */
  title: string;
};

/**
 * **项目组**（三组里的第一组）。
 *
 * 顺序即信息优先级：Issue 与设置、技能并列摆在一起，是因为它们都要项目上下文；
 * 没有项目上下文时只有 Issue 落在 `/`（「全部项目」的队列），另两项无处可去。
 */
export const REPO_NAV: readonly RepoNavItem[] = [
  { key: 'issues', label: 'Issue', suffix: '/issues', end: false, title: 'Issue 队列与会话' },
  { key: 'settings', label: '设置', suffix: '/settings', end: false, title: '这个项目的配置' },
  { key: 'skills', label: '技能', suffix: '/skills', end: false, title: '这个项目会用到哪些技能' },
];

/** 全局组唯一一项：系统页（不依赖项目）。 */
export const SYSTEM_PATH = '/system';

/**
 * 侧栏里的一行链接。
 *
 * `path` 为 `null` 表示「当前没有这个入口」（没有项目上下文时的设置 / 技能 / 运行）：
 * 由渲染方过滤掉，而不是画一个点了会 404 的链接。这样「哪个入口能用」只有一处真值。
 */
export type NavLink = {
  key: NavItemKey;
  label: string;
  title: string;
  path: string | null;
  /** `NavLink` 的 `end`。 */
  end: boolean;
};

export type NavGroup = {
  key: NavGroupKey;
  label: string;
  links: readonly NavLink[];
};

/** 拼出某个项目导航项的绝对路径（`repo` 是 `owner/name`）。 */
export function repoNavPath(repo: string, key: RepoNavKey): string {
  const item = REPO_NAV.find((candidate) => candidate.key === key);
  return `${repoWorkspacePath(repo)}${item?.suffix ?? ''}`;
}

/** 没有项目上下文时（「全部项目」）的同一个入口：Issue 是首页，其余两项不存在。 */
export function globalNavPath(key: RepoNavKey): string | null {
  return key === 'issues' ? '/' : null;
}

/**
 * 三组侧栏项（`repo` 为 `null` 时项目组只剩 Issue、「证据」组为空）。
 *
 * 为什么返回「已经算好路径的结构」而不是让调用方自己拼：侧栏、命令面板两处都要
 * 「这一项现在能不能去」，各拼一遍就会各错一遍。
 */
export function navGroups(repo: string | null): readonly NavGroup[] {
  const root = repo === null ? null : repoWorkspacePath(repo);

  const project: readonly NavLink[] = REPO_NAV.map((item) => ({
    key: item.key,
    label: item.label,
    title: item.title,
    end: item.end,
    path: root === null ? globalNavPath(item.key) : `${root}${item.suffix}`,
  }));

  const evidence: readonly NavLink[] = [
    {
      key: 'runs',
      label: '运行',
      title: '这个项目的运行记录（会话流里的证据）',
      end: false,
      path: root === null ? null : `${root}/runs`,
    },
  ];

  const global: readonly NavLink[] = [
    { key: 'system', label: '系统', title: '系统健康、队列与全局设置（⌘.）', end: true, path: SYSTEM_PATH },
  ];

  return [
    { key: 'project', label: '项目', links: project },
    { key: 'evidence', label: '证据', links: evidence },
    { key: 'global', label: '全局', links: global },
  ];
}

/** 三组合并成一列（命令面板按顺序列出用）。 */
export function navLinks(repo: string | null): readonly NavLink[] {
  return navGroups(repo).flatMap((group) => group.links);
}

/** 面包屑的一段（与 `components/Breadcrumb.tsx` 的 `Crumb` 结构一致，故意不 import 组件层）。 */
export type ShellCrumb = { label: string; to?: string };

/**
 * 当前路径的面包屑：`全部项目 / <repo> / <当前页>`。
 *
 * 为什么外壳来算：面包屑是「我在哪」的唯一答案，页面自己画就会有两份（一份在外壳、
 * 一份在页面里），两份迟早不一致。页面标题仍然是页面自己的 `h1`（一页一个 `h1`）。
 *
 * 认不出的路径**不猜**：只回 `全部项目 / 当前位置`，让人知道自己在面板里但不在某一条
 * 路由上（404 页就是这种情形）。
 */
export function crumbsFor(pathname: string): readonly ShellCrumb[] {
  const segments = pathname.split('/').filter((segment) => segment !== '');
  const home: ShellCrumb = { label: '全部项目', to: '/' };

  if (segments.length === 0) return [{ label: '全部项目' }, { label: 'Issue' }];

  if (segments[0] === 'system') return [home, { label: '系统' }];

  if (segments[0] !== 'repos' || segments.length < 2) {
    return [home, { label: '当前位置' }];
  }

  // URL 里是单段 `owner__name`，面包屑要读人能看懂的形式
  const repo = decodeRepo(segments[1] ?? '');
  if (repo === null) return [home, { label: '当前位置' }];

  const crumbs: ShellCrumb[] = [home, { label: repo, to: repoWorkspacePath(repo) }];
  const section = segments[2];

  if (section === undefined) return [...crumbs, { label: 'Issue' }];

  const tail = segments.length > 3;
  switch (section) {
    case 'issues':
      return [...crumbs, { label: tail ? 'Issue 会话' : 'Issue' }];
    case 'settings':
      return [...crumbs, { label: tail ? '设置分区' : '设置' }];
    case 'skills':
      return [...crumbs, { label: '技能' }];
    case 'runs':
      return [...crumbs, { label: tail ? '运行详情' : '运行' }];
    default:
      return [...crumbs, { label: '当前位置' }];
  }
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
