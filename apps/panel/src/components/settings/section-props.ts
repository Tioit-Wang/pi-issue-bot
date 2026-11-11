import type { MouseEvent } from 'react';
import type { SettingsSectionKey } from '../../layout/nav.ts';
import type { SettingsDraft } from './use-settings-draft.ts';

/**
 * 每个分区的入参：**只有草稿 API**（不传整页状态）。
 *
 * `onDirtyChange` 只有带第二份草稿的分区会用到（提示词分区的正文、流水线分区的提示词入口），
 * 切分区时同样要被拦一次。
 *
 * `onNavigate` 给「分区内部跳去另一个分区」的链接用（流水线 → 提示词 tab、标签角色提示 → 标签）。
 * 不直接用 `<Link>` 的原因：跳出前要先问一句「有未保存改动」，否则 managers 的改动会被静默丢掉。
 * 返回值 `true` = 已经拦下（调用方不必再导航）。
 */
export type SettingsSectionProps = {
  state: SettingsDraft;
  onDirtyChange?: (dirty: boolean) => void;
  onNavigate?: (event: MouseEvent<HTMLAnchorElement>, key: SettingsSectionKey) => boolean;
};
