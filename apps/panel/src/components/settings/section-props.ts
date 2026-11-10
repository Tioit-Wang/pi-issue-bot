import type { SettingsDraft } from './use-settings-draft.ts';

/**
 * 每个分区的入参：**只有草稿 API**（不传整页状态）。
 *
 * `onDirtyChange` 只有提示词分区会用到：它除了 settings 草稿，还有第二份草稿（`prompt_versions`
 * 的正文），切分区时同样要被拦一次。
 */
export type SettingsSectionProps = {
  state: SettingsDraft;
  onDirtyChange?: (dirty: boolean) => void;
};
