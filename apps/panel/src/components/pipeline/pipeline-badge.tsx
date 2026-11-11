import type { IssuePipeline, PipelineCategory, PipelineState } from '../../lib/contract.ts';
import { Badge } from '../ui/badge.tsx';
import {
  CATEGORY_DESCRIPTION,
  CATEGORY_LABEL,
  CATEGORY_TONE,
  STATE_DESCRIPTION,
  STATE_LABEL,
  STATE_TONE,
  stageStateText,
  stageStateTitle,
} from './pipeline-status.ts';

/**
 * 流水线徽章（三处视图共用：看板卡、issue 列表、issue 详情）。
 *
 * 两条硬约束（设计系统 §1 / §6.3）：
 *  - 状态色只出现在**小面积**上（徽章底 + 状态点），不整行/整卡染色；
 *  - `closed` 用**描边**而不是实底：流程结束是中性事实，不是「成功」，也不该和 `ready` 抢注意力。
 */

/** 阶段 + 状态合成一枚：`阶段 0 · 待人补充`；没有状态行 → 中性描边「未入流水线」。 */
export function StageStateBadge({ pipeline, className }: { pipeline: IssuePipeline | null; className?: string }) {
  const text = stageStateText(pipeline);
  const title = stageStateTitle(pipeline);
  if (pipeline === null) {
    return (
      <Badge variant="outline" className={className} title={title} data-testid="pipeline-stage-badge">
        {text}
      </Badge>
    );
  }
  if (pipeline.stage === 'closed' || pipeline.state === 'closed') {
    return (
      <Badge variant="outline" className={className} title={title} data-testid="pipeline-stage-badge">
        {text}
      </Badge>
    );
  }
  return (
    <Badge tone={STATE_TONE[pipeline.state]} dot className={className} title={title} data-testid="pipeline-stage-badge">
      {text}
    </Badge>
  );
}

/** 只显示状态（看板卡第二行、阶段时间线用）。 */
export function PipelineStateBadge({ state, className }: { state: PipelineState; className?: string }) {
  if (state === 'closed') {
    return (
      <Badge variant="outline" className={className} title={STATE_DESCRIPTION.closed} data-testid="pipeline-state-badge">
        {STATE_LABEL.closed}
      </Badge>
    );
  }
  return (
    <Badge tone={STATE_TONE[state]} dot className={className} title={STATE_DESCRIPTION[state]} data-testid="pipeline-state-badge">
      {STATE_LABEL[state]}
    </Badge>
  );
}

/** 分类结论；没有结论（还没跑分类 / 结论非法被 blocked）→ 灰 `—`。 */
export function CategoryBadge({ category, className }: { category: PipelineCategory | null; className?: string }) {
  if (category === null) {
    return (
      <span className={className} title="还没有分类结论（issue_pipeline.category 为 NULL：没跑分类，或结论非法被 blocked）">
        —
      </span>
    );
  }
  return (
    <Badge tone={CATEGORY_TONE[category]} className={className} title={CATEGORY_DESCRIPTION[category]} data-testid="pipeline-category-badge">
      {CATEGORY_LABEL[category]}
    </Badge>
  );
}
