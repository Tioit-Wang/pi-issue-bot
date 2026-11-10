import { Badge, type BadgeProps } from '../ui/badge.tsx';
import type { ReactionState, ReactionValue } from './contract-extras.ts';

/**
 * reaction 徽章（`issue_feedback` 的最新终态）。
 *
 * 为什么不用「只放一个 emoji」：`👀`/`🚀`/`😕` 在屏幕阅读器里各有读法（有的读成
 * 「眼睛」有的读成「looking」），而且色盲用户分不清 rocket 与 confused 的语义。
 * 所以这里**emoji 只做装饰**（`aria-hidden`），可读的词是 `eyes`/`rocket`/`confused`
 * 这三个契约原词——面板不翻译它们（排查时要能和 `issue_feedback.content` 对上）。
 *
 * `null` 不是「失败」，是「没有记录」：dry-run 仓库一个 reaction 都不打，
 * 只在 `run_events(kind='feedback.planned')` 留痕，所以显式说「没有记录」。
 */

type ReactionMeta = {
  glyph: string;
  /** 表格里的短说明（悬停与详情页用）。 */
  hint: string;
  variant: NonNullable<BadgeProps['variant']>;
};

const REACTION_META: Record<ReactionState, ReactionMeta> = {
  eyes: { glyph: '👀', hint: '已收到，正在处理', variant: 'muted' },
  rocket: { glyph: '🚀', hint: '处理完成（成功收尾）', variant: 'success' },
  confused: { glyph: '😕', hint: '失败 / 缺信息 / 被取消', variant: 'danger' },
};

export function reactionHint(state: ReactionValue): string {
  return state === null ? '没有 reaction 记录（dry-run 仓库只写 run_events）' : REACTION_META[state].hint;
}

export function ReactionChip({ state, className }: { state: ReactionValue; className?: string }) {
  if (state === null) {
    return (
      <span className={className === undefined ? 'text-xs text-muted-foreground' : `text-xs text-muted-foreground ${className}`}>
        —
      </span>
    );
  }
  const meta = REACTION_META[state];
  return (
    <Badge variant={meta.variant} className={className} title={meta.hint}>
      <span aria-hidden="true" className="mr-1">
        {meta.glyph}
      </span>
      {state}
    </Badge>
  );
}
