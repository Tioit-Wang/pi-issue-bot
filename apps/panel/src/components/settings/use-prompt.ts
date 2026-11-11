/**
 * 提示词资源（`/api/repos/:owner/:name/prompt?kind=…`）的取数与写操作。
 *
 * 四件事决定了这里的形状：
 *
 * 1. **四条版本线各自独立**（`docs/plan-fixed-pipeline.md` §4.4 / V15）：`kind` 是查询参数，
 *    所以查询键必须带 `kind`，否则四个 tab 会互相盖缓存。
 * 2. **保存 = 新建版本**（不是覆盖），保存成功直接用响应体覆盖缓存：版本号、预算、层序、
 *    预览一次更新，页面不需要二次 GET。
 * 3. **传输层只有 `lib/api.ts`**：`api.prompt / savePrompt / rollbackPrompt / restorePrompt /
 *    promptVersions` 已经吃 `kind`（CSRF 头、`credentials: same-origin`、`ApiError` 都在那边），
 *    这个 hook 不再自己拼 URL —— 否则「哪条 kind 用哪个 query」会变成两处真相。
 * 4. **`agent` 会挤占 P1 预算**（V18）：所以在 `agent` / 两个阶段 kind 保存成功后，
 *    顺手把**其它 kind** 的缓存标脏 —— 它们的 `availableChars` 变了。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PromptKind } from '../../../../../packages/contract/src/index.ts';
import { api } from '../../lib/api.ts';
import type { PromptResponse } from '../../lib/contract.ts';
import { describeWriteFailure, type WriteFailure } from './failures.ts';

/** 层序预览的一层（服务端 `assemble.ts` 的 `AssembleStageLayer`；形状在契约里，这里只再导出）。 */
export type { PromptLayerView } from '../../lib/contract.ts';

/**
 * 一个 kind 的视图：就是 `PromptResponse`（`kind` 那一组字段与老字段同住一个类型）。
 *
 * 保留这个名字是为了调用点不用改（`prompt-section.tsx` / 层序预览 / 测试都按它取类型）；
 * 新字段在契约里是**可选**的，旧服务端与旧 mock 只给老形状时面板按本地常量兜底。
 */
export type PromptKindView = PromptResponse;

export const promptQueryKey = (repo: string, kind: PromptKind): readonly [string, string, PromptKind] => [
  'repoPrompt',
  repo,
  kind,
];

/** 四个 kind 的查询键前缀：写成功时用它一次标脏（`agent` 会改别人的可用额度）。 */
export const promptQueryRoot = (repo: string): readonly [string, string] => ['repoPrompt', repo];

/** 一个 kind 的资源 */

export type PromptSaveVariables = { body: string; note: string | undefined };

export function usePromptResource(repo: string, kind: PromptKind) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: promptQueryKey(repo, kind),
    queryFn: () => api.prompt(repo, kind),
    // 编辑器不能被「切回窗口就刷新」冲掉；保存成功后由 setQueryData 更新
    refetchOnWindowFocus: false,
    refetchInterval: false,
  });

  const apply = (data: PromptKindView): void => {
    queryClient.setQueryData(promptQueryKey(repo, kind), data);
  };

  /** 保存/回滚/恢复默认都会动「别的 kind 还能存多少」：把它们标脏，回来时自动重取。 */
  const markOtherKindsStale = (): void => {
    void queryClient.invalidateQueries({
      queryKey: promptQueryRoot(repo),
      predicate: (candidate) => candidate.queryKey[2] !== kind,
    });
  };

  const save = useMutation({
    mutationFn: (variables: PromptSaveVariables) => api.savePrompt(repo, kind, variables.body, variables.note),
    onSuccess: (data) => {
      apply(data);
      markOtherKindsStale();
    },
  });

  const rollback = useMutation({
    mutationFn: (version: number) => api.rollbackPrompt(repo, kind, version),
    onSuccess: (data) => {
      apply(data);
      markOtherKindsStale();
    },
  });

  /** 「恢复默认」= 指针回 0（不删历史），所以历史里仍然能选回旧版本。 */
  const restore = useMutation({
    mutationFn: () => api.restorePrompt(repo, kind),
    onSuccess: (data) => {
      apply(data);
      markOtherKindsStale();
    },
  });

  /**
   * 历史版本：主视图已经带了同一份列表，所以默认不取。
   * 留这个入口是因为「只想要版本列表」时不必跑一次装配预览（`GET …/prompt/versions` 轻得多）。
   */
  const versions = useQuery({
    queryKey: [...promptQueryKey(repo, kind), 'versions'] as const,
    queryFn: () => api.promptVersions(repo, kind),
    refetchOnWindowFocus: false,
    refetchInterval: false,
    enabled: false,
  });

  const saveFailure: WriteFailure | null = save.error === null ? null : describeWriteFailure(save.error, '保存提示词');
  const rollbackFailure: WriteFailure | null =
    rollback.error === null ? null : describeWriteFailure(rollback.error, '回滚');
  const restoreFailure: WriteFailure | null =
    restore.error === null ? null : describeWriteFailure(restore.error, '恢复默认');

  return {
    query,
    save,
    rollback,
    restore,
    versions,
    saveFailure,
    rollbackFailure,
    restoreFailure,
    /** 原始错误（错误码 → 文案的映射在 `prompt-kinds.tsx`，这里不翻译）。 */
    saveError: save.error,
    rollbackError: rollback.error,
    restoreError: restore.error,
  };
}

export type PromptResource = ReturnType<typeof usePromptResource>;

/** 设置页「流水线」分区要看四个 kind 的指针状态：一次并发取四个视图，只读。 */
export const promptSummaryQuery = (repo: string, kind: PromptKind) => ({
  queryKey: promptQueryKey(repo, kind),
  queryFn: () => api.prompt(repo, kind),
  refetchOnWindowFocus: false,
  refetchInterval: false as const,
  staleTime: 30_000,
});
