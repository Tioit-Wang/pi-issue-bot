/**
 * 仓库清单：`GET /api/repos` 的客户端（左栏切换器 + 首页健康卡的数据源）。
 *
 * 取数走 `api.repos()`（W3-H 起的契约：`ReposResponse = { items: RepoSummary[] }`），
 * 这一层只做**面板侧的投影与容错**：
 * - 请求失败 → 退回 `/api/system` 的 `repos[]`（`configValid` 与 `settingsValid` 同值，两个都认）；
 * - 两者都失败 → `source: 'none'`，切换器显示「仓库清单读不到」，页面不崩；
 * - 单条缺字段 → 按「保守值」补齐（`enabled=false` / `dryRun=true`），宁可显示得更保守。
 */
import { useQuery } from '@tanstack/react-query';
import { api } from './api.ts';
import type { SystemResponse } from './contract.ts';
import { REFETCH_INTERVAL, useSystem } from './queries.ts';

/** 一行仓库（`repos` 表投影到面板需要的字段）。 */
export type RepoSummary = {
  /** `owner/name`（契约里的 `repo`）。 */
  repo: string;
  enabled: boolean;
  dryRun: boolean;
  /** `repos.settings` 是否通过 schema 校验（旧接口字段名是 `configValid`）。 */
  settingsValid: boolean;
  /** 校验失败的原因（`repos.settings_error`）；接口没给就是 `null`。 */
  settingsError: string | null;
  /** 归档时间（`null` = 未归档）。 */
  archivedAt: string | null;
  /** 最近一次活动（`null` = 从没跑过）。 */
  lastActivityAt: string | null;
};

/** `GET /api/repos` 的响应体。 */
export type ReposResponse = { repos: RepoSummary[] };

/** 清单来源：`repos` = 新接口；`system` = 降级到 `/api/system`；`none` = 两个都读不到。 */
export type RepoDirectorySource = 'repos' | 'system' | 'none';

export const reposQueryKey = ['repos'] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * 把未知 JSON 规约成 `RepoSummary[]`（容忍 `{repos: []}` / 裸数组 / 缺字段）。
 *
 * 导出是为了单测能钉住「形状漂移不炸」这条约束；页面只用 `useRepoDirectory`。
 */
export function normalizeRepoList(payload: unknown): RepoSummary[] {
  const root = asRecord(payload);
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(root?.['repos'])
      ? (root['repos'] as unknown[])
      : Array.isArray(root?.['items'])
        ? (root['items'] as unknown[])
        : [];

  const byRepo = new Map<string, RepoSummary>();
  for (const item of list) {
    const record = asRecord(item);
    const repo = asString(record?.['repo']);
    if (record === null || repo === null) continue;
    byRepo.set(repo, {
      repo,
      enabled: asBoolean(record['enabled'], false),
      // 缺 dryRun 时按「保守 = 不真写」展示，避免把没配置的仓库误看成线上生效
      dryRun: asBoolean(record['dryRun'], true),
      settingsValid: asBoolean(record['settingsValid'], asBoolean(record['configValid'], true)),
      settingsError: asString(record['settingsError']) ?? asString(record['configError']),
      archivedAt: asString(record['archivedAt']),
      lastActivityAt: asString(record['lastActivityAt']),
    });
  }
  return [...byRepo.values()].sort((left, right) => left.repo.localeCompare(right.repo));
}

/**
 * `/api/system` 的 `repos[]` → `RepoSummary[]`（降级路径：W3-H 起字段已经齐了，
 * `settingsValid` / `archivedAt` / `lastActivityAt` 都是真值，不再从 `configValid` 别名推）。
 */
export function fromSystemRepos(repos: SystemResponse['repos']): RepoSummary[] {
  return repos
    .map((item) => ({
      repo: item.repo,
      enabled: item.enabled,
      dryRun: item.dryRun,
      settingsValid: item.settingsValid,
      settingsError: item.settingsError,
      archivedAt: item.archivedAt,
      lastActivityAt: item.lastActivityAt,
    }))
    .sort((left, right) => left.repo.localeCompare(right.repo));
}

/** 拉一次仓库清单：`api.repos()`（契约 `{ items: [...] }`），形状漂移仍由 `normalizeRepoList` 兜底。 */
async function fetchRepos(): Promise<RepoSummary[]> {
  return normalizeRepoList(await api.repos());
}

/** 仓库清单查询（15s 轮询，与其它列表页一致）。 */
export function useRepos() {
  return useQuery({
    queryKey: reposQueryKey,
    queryFn: fetchRepos,
    refetchInterval: REFETCH_INTERVAL.list,
  });
}

export type RepoDirectory = {
  repos: RepoSummary[];
  source: RepoDirectorySource;
  isLoading: boolean;
  /** 两个来源都失败时才有值（切换器据此显示错误态）。 */
  error: unknown;
  /** 是否有仓库清单可展示。 */
  isEmpty: boolean;
  refetch: () => void;
};

/**
 * 仓库清单的**降级外壳**：新接口优先，失败就退回 `/api/system`。
 *
 * 为什么值得这一层：左栏切换器是每个页面都挂着的全局组件，它一旦抛错，整个面板就白屏。
 * 降级路径让「W1-A 的接口还没上线 / 数据库读不出来」只表现为一行提示，而不是页面崩掉。
 */
export function useRepoDirectory(): RepoDirectory {
  const reposQuery = useRepos();
  const system = useSystem();

  const systemRepos = system.data === undefined ? [] : fromSystemRepos(system.data.repos);
  const primary = reposQuery.data;
  // 两个来源都还没给出任何东西时才算「加载中」：降级源先到就先渲染，不空等新接口
  const isLoading = primary === undefined && system.data === undefined && (reposQuery.isLoading || system.isLoading);
  const preferredRepos = primary !== undefined && primary.length > 0 ? primary : systemRepos;
  const source: RepoDirectorySource =
    primary !== undefined && primary.length > 0 ? 'repos' : systemRepos.length > 0 ? 'system' : 'none';

  return {
    repos: preferredRepos,
    source,
    isLoading,
    error: primary === undefined && source === 'none' ? reposQuery.error : null,
    isEmpty: preferredRepos.length === 0,
    refetch: () => {
      void reposQuery.refetch();
    },
  };
}
