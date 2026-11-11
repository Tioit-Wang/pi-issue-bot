import type { IssuePipeline } from '../../lib/contract.ts';
import { Badge, StatusDot } from '../ui/badge.tsx';
import { cn } from '../../lib/utils.ts';
import { PipelineStateBadge } from './pipeline-badge.tsx';
import {
  CATEGORY_LABEL,
  PIPELINE_FORMAT_MAX_FAILS,
  SESSION_MAX_TURNS,
  STAGE_LABEL,
  STATE_DESCRIPTION,
  attemptsText,
  dwellOf,
  type Dwell,
} from './pipeline-status.ts';

/**
 * 阶段时间线（issue 详情主列第一块）：**三段**——阶段 0 格式检查 / 阶段 1 分类 / 阶段 2 Agent。
 *
 * 每段只回答三件事：**到没到**、**关键事实**（失败次数 / 分类结论 / 会话轮次）、**什么时候**。
 *  - 「到没到」= `已通过` / 当前状态徽章 / `未开始`：颜色只出现在 6px 圆点与徽章上；
 *  - 「关键事实」用 `dl`（两列一组），数字 `tabular`、id 与命令 `font-mono`；
 *  - 「什么时候」优先用状态转换时落库的真实时刻（`readyAt` / `infoRequestedAt`），
 *    当前段用停留时长（口径见 `pipeline-status.ts`），**没有就写 `—`**，不编时间。
 *
 * `pipeline === null`（没有状态行）不画三段：只有一行事实 + 一句 `title` 说明为什么。
 */
export type StageTimelineProps = {
  pipeline: IssuePipeline | null;
  now: number;
  /** 用哪一行的「最后活动」兜底停留时长的锚点（`IssueListItem.lastActivityAt`）。 */
  lastActivityAt?: string;
};

export type TimelineSegmentKey = 'format' | 'classify' | 'agent';

export type SegmentStatus = 'done' | 'current' | 'pending';

export type TimelineFact = {
  label: string;
  value: string;
  mono?: boolean;
  /** 悬停口径（例如「格式不通过 2 次，累计 5 次自动关」）。 */
  title?: string;
  /** 值是否为「缺失」占位（`—`），面板用 faint 色而不是把它当数据。 */
  missing?: boolean;
};

export type TimelineSegment = {
  key: TimelineSegmentKey;
  /** `阶段 0 · 格式检查`。 */
  title: string;
  status: SegmentStatus;
  /** 当前段的流水线状态词（`待跑` / `待人补充` …）；`done` / `pending` 为 `null`。 */
  stateText: string | null;
  facts: TimelineFact[];
  /** 时间格：当前段是停留时长，已过的段是落库时刻。 */
  time: { text: string; title: string } | null;
};

const STAGE_INDEX: Record<IssuePipeline['stage'], number> = { format: 0, classify: 1, agent: 2, closed: 3 };

/** 三段标题（与看板列名同源：`STAGE_LABEL`）。 */
const SEGMENTS: readonly { key: TimelineSegmentKey; title: string }[] = [
  { key: 'format', title: `阶段 0 · ${STAGE_LABEL.format}` },
  { key: 'classify', title: `阶段 1 · ${STAGE_LABEL.classify}` },
  { key: 'agent', title: `阶段 2 · ${STAGE_LABEL.agent}` },
];

function shortTime(iso: string | null): { text: string; title: string } | null {
  if (iso === null) return null;
  return { text: iso.slice(0, 16).replace('T', ' '), title: `${iso.slice(0, 19).replace('T', ' ')} UTC` };
}

/** 把一行流水线状态展开成三段（纯函数，单测直接断言）。 */
export function buildSegments(pipeline: IssuePipeline, now: number, lastActivityAt = ''): TimelineSegment[] {
  const index = STAGE_INDEX[pipeline.stage];
  const dwell: Dwell = dwellOf(pipeline, lastActivityAt, now);

  return SEGMENTS.map((segment, position) => {
    const status: SegmentStatus = index > position ? 'done' : index === position ? 'current' : 'pending';
    const facts: TimelineFact[] = [];
    let time: { text: string; title: string } | null = null;

    if (segment.key === 'format') {
      facts.push({
        label: '格式不通过',
        value: `${attemptsText(pipeline.formatFailCount)} 次`,
        title: `累计 ${String(pipeline.formatFailCount)} 次不通过；到 ${String(PIPELINE_FORMAT_MAX_FAILS)} 次自动关 issue`,
      });
      if (pipeline.infoRequestedAt !== null) {
        time = shortTime(pipeline.infoRequestedAt);
        facts.push({ label: '等补充始于', value: time?.text ?? '—', title: time?.title });
      }
    }

    if (segment.key === 'classify') {
      if (pipeline.category === null) {
        facts.push({ label: '结论', value: '—', missing: true, title: '还没跑分类，或结论非法被 blocked' });
      } else {
        facts.push({ label: '结论', value: CATEGORY_LABEL[pipeline.category], title: 'issue_pipeline.category' });
      }
      if (status === 'done' && pipeline.stage !== 'format') {
        time = shortTime(pipeline.readyAt);
        if (time !== null) facts.push({ label: '就绪于', value: time.text, title: time.title });
      }
    }

    if (segment.key === 'agent') {
      facts.push({
        label: '会话',
        value: pipeline.sessionId === null ? '—' : pipeline.sessionId,
        mono: true,
        missing: pipeline.sessionId === null,
        title: pipeline.sessionId === null ? '还没开会话（阶段 2 第一次 @ 时 create）' : '阶段 2 复用的 RACP 会话 id',
      });
      facts.push({
        label: '轮次',
        value: `${String(pipeline.sessionTurns)}/${String(SESSION_MAX_TURNS)}`,
        title: `会话已用 ${String(pipeline.sessionTurns)} 轮；到 ${String(SESSION_MAX_TURNS)} 轮或满 7 天会轮换`,
      });
      if (pipeline.staleAt !== null) {
        const stale = shortTime(pipeline.staleAt);
        facts.push({
          label: '就绪后有编辑',
          value: stale?.text ?? '—',
          title: 'ready 之后 issue 被编辑（只记 stale_at，不重跑、不通知）',
        });
      }
    }

    if (status === 'current' && dwell.ms !== null) {
      time = { text: `停留 ${dwell.text}`, title: dwell.title };
    } else if (status === 'done' && time === null) {
      time = shortTime(pipeline.readyAt);
    }

    return {
      key: segment.key,
      title: segment.title,
      status,
      stateText: status === 'current' ? STATE_DESCRIPTION[pipeline.state] : null,
      facts,
      time,
    };
  });
}

export function StageTimeline({ pipeline, now, lastActivityAt = '' }: StageTimelineProps) {
  if (pipeline === null) {
    return (
      <div className="flex min-w-0 flex-col gap-1" data-testid="stage-timeline">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <StatusDot tone="neutral" />
          未入流水线
        </p>
        <p className="text-2xs leading-relaxed text-faint">
          没有 issue_pipeline 行：存量 issue，或还没被 issues.opened 建行（懒创建）。收到 @ 时按「无行」放行。
        </p>
      </div>
    );
  }

  const segments = buildSegments(pipeline, now, lastActivityAt);

  return (
    <ol className="flex min-w-0 flex-col" data-testid="stage-timeline">
      {segments.map((segment, position) => (
        <li
          key={segment.key}
          className="flex min-w-0 gap-2.5 border-b border-border py-2 last:border-0"
          data-testid={`stage-timeline-${segment.key}`}
          data-status={segment.status}
        >
          <span className="w-6 shrink-0 pt-0.5 text-2xs tabular text-faint" aria-hidden>
            {String(position)}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <StatusDot
                tone={segment.status === 'done' ? 'success' : segment.status === 'pending' ? 'neutral' : 'info'}
                label={segment.status === 'done' ? '已通过' : segment.status === 'pending' ? '未开始' : '当前阶段'}
              />
              <h3 className="min-w-0 truncate text-sm font-medium text-foreground">{segment.title}</h3>
              {segment.status === 'done' ? (
                <Badge tone="success">已通过</Badge>
              ) : segment.status === 'pending' ? (
                <Badge variant="outline">未开始</Badge>
              ) : (
                <PipelineStateBadge state={pipeline.state} />
              )}
              {segment.time === null ? null : (
                <time className="ml-auto shrink-0 text-2xs tabular text-faint" title={segment.time.title}>
                  {segment.time.text}
                </time>
              )}
            </div>

            <dl className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-2xs">
              {segment.facts.map((fact) => (
                <div key={`${segment.key}-${fact.label}`} className="flex min-w-0 items-baseline gap-1">
                  <dt className="shrink-0 text-faint">{fact.label}</dt>
                  <dd
                    className={cn(
                      'min-w-0 truncate tabular',
                      fact.mono === true && 'font-mono',
                      fact.missing === true ? 'text-subtle' : 'text-muted-foreground',
                    )}
                    title={fact.title ?? fact.value}
                    data-testid={`stage-fact-${segment.key}-${fact.label}`}
                  >
                    {fact.value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </li>
      ))}
    </ol>
  );
}
