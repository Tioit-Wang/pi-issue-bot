/**
 * 设置页的**草稿层**（W3-I）：一个仓库的 `repos.settings` 从「服务端视图」到「可编辑草稿」。
 *
 * 三条约束决定了这里的形状：
 *
 * 1. **PUT 的 body 就是整份 settings**（`packages/contract/src/api.ts` §7b），没有逐字段的
 *    PATCH。所以每个分区保存时提交的是「草稿全量」，而草稿只在**当前分区挂载期间**存在：
 *    切分区 = 重新从服务端取（除非还有未保存改动，页面会先拦一下）。
 * 2. **草稿必须能被判定为「脏」**：用 `JSON.stringify` 比较（settings 是纯 JSON、键序由
 *    构造顺序决定，草稿由同一份基线克隆而来，键序稳定）。不做指针比较，也不做逐字段 diff：
 *    逐字段 diff 要维护一张「哪些字段算改动」的清单，改 schema 时必然漏。
 * 3. **服务端是唯一事实源**：保存成功用响应体 `setQueryData`（PUT 返回的就是最新视图），
 *    失败一个字都不改草稿 —— 宁可能再点一次，也不要乐观更新出一个服务端并不认的状态。
 *
 * `settingsValid=false`（`settings === null`）时草稿层不给草稿：页面显示「配置无效 + 修复入口」，
 * 分区一个都不渲染（拿默认值硬套会把 last-known-good 覆盖掉）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { api } from '../../lib/api.ts';
import type { RepoSettingsResponse } from '../../lib/contract.ts';
import type { RepoSettings } from '../../../../../packages/contract/src/index.ts';
import { describeWriteFailure, type SaveIssue, type WriteFailure } from './failures.ts';

/** 设置查询的键前缀（`lib/queries.ts` 归 W3-H，这一组键在设置页内部自用）。 */
export const repoSettingsQueryKey = (repo: string): readonly [string, string] => ['repoSettings', repo];

/** 保存按钮/提示条要的状态机。 */
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export type SettingsDraft = {
  repo: string;
  /** 服务端视图（`source` / `installationId` / `archivedAt` 这类只读元数据从这里来）。 */
  response: RepoSettingsResponse;
  /** 服务端那一份（撤销改动的落点）。 */
  base: RepoSettings;
  /** 当前草稿（每个分区只改自己那一段，其余原样带上）。 */
  draft: RepoSettings;
  dirty: boolean;
  /** 已归档 = 只读（归档是「不可用但不删行」，面板不给改）。 */
  readOnly: boolean;
  status: SaveStatus;
  failure: WriteFailure | null;
  issues: SaveIssue[];
  update: (patch: (current: RepoSettings) => RepoSettings) => void;
  save: () => void;
  reset: () => void;
};

export type SettingsDraftResult =
  | { kind: 'loading' }
  | { kind: 'error'; error: unknown }
  /** `settings === null` / `settingsValid === false`：库里的配置不合法，需要先修复。 */
  | { kind: 'invalid'; response: RepoSettingsResponse }
  | { kind: 'ready'; state: SettingsDraft };

type StoredDraft = { key: string; value: RepoSettings };

/**
 * 一个仓库的设置草稿。
 *
 * `refetchOnWindowFocus: false` + 不轮询：这是表单，别的页面那种「回来就刷新」会把正在编辑的
 * 内容冲掉。保存成功后由 `setQueryData` 更新，所以不存在「保存了但显示旧的」。
 */
export function useSettingsDraft(repo: string): SettingsDraftResult {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: repoSettingsQueryKey(repo),
    queryFn: () => api.repoSettings(repo),
    refetchOnWindowFocus: false,
    refetchInterval: false,
  });

  const base = query.data?.settings ?? null;
  // 基线指纹：服务端回写（保存成功 / 别处改了）时草稿自动失效
  const key = base === null ? 'null' : JSON.stringify(base);

  const [stored, setStored] = useState<StoredDraft | null>(null);

  const mutation = useMutation({
    mutationFn: (next: RepoSettings) => api.saveRepoSettings(repo, next),
    onSuccess: (response) => {
      queryClient.setQueryData(repoSettingsQueryKey(repo), response);
      // 左栏切换器 / 系统页 / 首页健康卡都读 `/api/repos`
      void queryClient.invalidateQueries({ queryKey: ['repos'] });
    },
  });

  const resetMutation = mutation.reset;

  const draft = stored !== null && stored.key === key ? stored.value : base;

  const update = useCallback(
    (patch: (current: RepoSettings) => RepoSettings) => {
      setStored((current) => {
        const value = current !== null && current.key === key ? current.value : base;
        if (value === null) return current;
        return { key, value: patch(value) };
      });
      // 改动之后旧的「已保存」提示就不再成立
      resetMutation();
    },
    [key, base, resetMutation],
  );

  const save = useCallback(() => {
    if (draft === null) return;
    mutation.mutate(draft);
  }, [draft, mutation]);

  const reset = useCallback(() => {
    setStored(null);
    resetMutation();
  }, [resetMutation]);

  if (query.isLoading) return { kind: 'loading' };
  if (query.error !== null && query.error !== undefined) return { kind: 'error', error: query.error };

  const response = query.data;
  if (response === undefined) return { kind: 'loading' };
  if (response.settings === null || !response.settingsValid) return { kind: 'invalid', response };

  // 到这里的 settings 一定非空：`invalid` 分支已经把 null 挡掉了
  const currentBase = response.settings;
  const currentDraft = stored !== null && stored.key === key ? stored.value : currentBase;

  const failure = mutation.error === null ? null : describeWriteFailure(mutation.error, '保存');
  const status: SaveStatus = mutation.isPending
    ? 'saving'
    : failure !== null
      ? 'error'
      : mutation.isSuccess
        ? 'saved'
        : 'idle';

  return {
    kind: 'ready',
    state: {
      repo,
      response,
      base: currentBase,
      draft: currentDraft,
      dirty: JSON.stringify(currentDraft) !== key,
      readOnly: response.archivedAt !== null,
      status,
      failure,
      issues: failure?.issues ?? [],
      update,
      save,
      reset,
    },
  };
}

/**
 * 用部署默认覆盖（修复非法配置的入口）。
 *
 * 为什么需要它：`settingsValid=false` 时草稿层不给草稿，但「什么都不做」会让这个仓库永久卡在
 * 不可用状态 —— 面板必须给一条**能走通**的修复路径。默认值来自契约的
 * `DEFAULT_REPO_SETTINGS`（`repoSettingsSchema.parse({})`），不是面板自己发明的数字。
 */
export function useRestoreDefaults(repo: string): {
  restore: (settings: RepoSettings) => void;
  pending: boolean;
  failure: WriteFailure | null;
} {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (settings: RepoSettings) => api.saveRepoSettings(repo, settings),
    onSuccess: (response) => {
      queryClient.setQueryData(repoSettingsQueryKey(repo), response);
      void queryClient.invalidateQueries({ queryKey: ['repos'] });
    },
  });

  return {
    restore: (settings) => {
      mutation.mutate(settings);
    },
    pending: mutation.isPending,
    failure: mutation.error === null ? null : describeWriteFailure(mutation.error, '恢复默认设置'),
  };
}
