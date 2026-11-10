/**
 * 提示词资源（`GET/PUT/POST /api/repos/:owner/:name/prompt`）的取数与写操作。
 *
 * 三个接口返回**同一个形状**（`PromptResponse`，见 `lib/contract.ts`），所以写成功就直接
 * `setQueryData` 覆盖：版本号、版本列表、预算、装配预览一次性更新，页面不需要二次 GET。
 *
 * 与设置草稿分开的原因：这是独立资源（`prompt_versions` 表 + 预算闸门），保存语义是
 * 「保存即新建版本」，而不是「覆盖 settings」。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.ts';
import type { PromptResponse } from '../../lib/contract.ts';
import { describeWriteFailure, type WriteFailure } from './failures.ts';

export const promptQueryKey = (repo: string): readonly [string, string] => ['repoPrompt', repo];

export type PromptSaveVariables = { body: string; note: string | undefined };

export function usePromptResource(repo: string) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: promptQueryKey(repo),
    queryFn: () => api.prompt(repo),
    // 编辑器不能被「切回窗口就刷新」冲掉；保存成功后由 setQueryData 更新
    refetchOnWindowFocus: false,
    refetchInterval: false,
  });

  const apply = (data: PromptResponse): void => {
    queryClient.setQueryData(promptQueryKey(repo), data);
  };

  const save = useMutation({
    mutationFn: (variables: PromptSaveVariables) => api.savePrompt(repo, variables.body, variables.note),
    onSuccess: apply,
  });

  const rollback = useMutation({
    mutationFn: (version: number) => api.rollbackPrompt(repo, version),
    onSuccess: apply,
  });

  const saveFailure: WriteFailure | null =
    save.error === null ? null : describeWriteFailure(save.error, '保存提示词');
  const rollbackFailure: WriteFailure | null =
    rollback.error === null ? null : describeWriteFailure(rollback.error, '回滚');

  return { query, save, rollback, saveFailure, rollbackFailure };
}
