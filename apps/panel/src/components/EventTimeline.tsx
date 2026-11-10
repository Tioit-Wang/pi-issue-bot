import { Link } from 'react-router';
import { Badge, StatusDot } from './ui/badge.tsx';
import type { Tone } from './ui/status.ts';
import type { AuditRow } from '../lib/contract.ts';
import { formatAbsoluteTime, formatCount, formatRelativeTime } from '../lib/format.ts';
import { repoWorkspacePath } from '../lib/repo-route.ts';

/**
 * 事件时间轴（首页「最近活动」区块）。
 *
 * 数据源用 `/api/audit`：它是唯一带「谁、在哪个仓库、做了什么、结果如何」的**事件**接口
 * （`run_events` 只有详情接口能按任务取）。
 *
 * 组织方式（D4 收口）：**连续时间轴 + 按天分组 + 事件单行**。
 * 一天一个微标签（今天 / 昨天 / 2026-06-01），组内按时间倒序；
 * 一行从左到右：**相对时间**（`title` 给绝对时间）· **对象**（`owner/name` + `issue#17`）
 * ·**intent 徽章**·**@actor**。行高 28px，`·` 两侧各 6px（`flex gap-1.5` + 分隔点，不拼字符串）。
 *
 * 命令、任务 id、绝对时间、dry-run 都进**行的 `title`**：这些是"点进去才需要"的细节，
 * 常驻在行里会把时间轴从"扫一眼"变成"读日志"。状态（applied / failed / dry-run）由
 * 时间轴上的色点承担，读屏文案用 `StatusDot` 的 `label`。
 *
 * 配色语义只有四档，全部来自 `ui/status.ts`（不再出现 `bg-emerald-500` 这类自造色）。
 */
export type EventTimelineProps = {
  rows: readonly AuditRow[];
  testId?: string;
};

/** 动作落在什么上：`issue#17` / `pr#42` / `comment#9` / `branch:main`。 */
function targetLabel(target: AuditRow['target']): string {
  if (target.kind === 'branch') return `branch:${target.ref ?? '—'}`;
  return `${target.kind}#${target.number === null ? '—' : String(target.number)}`;
}

const INTENT_LABEL: Record<AuditRow['intent'], string> = {
  comment: '评论',
  label: '打标',
  create_issue: '建 issue',
  push_branch: '推分支',
  close_issue: '关 issue',
};

/** 事件结果 → tone（`dry-run` 是 warn：写没落地，但也没失败）。 */
function eventTone(status: AuditRow['status']): Tone {
  if (status === 'applied') return 'success';
  if (status === 'failed' || status === 'rejected') return 'danger';
  if (status === 'dry-run') return 'warn';
  return 'neutral';
}

/** 一天的分组键（UTC 自然日，与契约的时间口径一致）。 */
function dayKey(at: string): string {
  const parsed = Date.parse(at);
  if (Number.isNaN(parsed)) return 'unknown';
  return new Date(parsed).toISOString().slice(0, 10);
}

/** 分组标题：今天 / 昨天 / 绝对日期（UTC）。 */
function dayLabel(key: string, now: Date): string {
  if (key === 'unknown') return '时间未知';
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  if (key === today) return '今天';
  if (key === yesterday) return '昨天';
  return key;
}

/** 行 `title`：绝对时间 / 命令 / 任务 id / 状态 —— 全部是可核对的事实。 */
function rowTitle(row: AuditRow, statusLabel: string): string {
  const parts = [
    formatAbsoluteTime(row.at),
    `${targetLabel(row.target)} · ${INTENT_LABEL[row.intent]}`,
    row.command,
    `任务 ${row.taskId}`,
    statusLabel,
  ];
  if (row.dryRun) parts.push('dry-run · 未写 GitHub');
  return parts.join(' · ');
}

/** 事件的读屏文案（状态不能只靠颜色）。 */
const STATUS_LABEL: Partial<Record<AuditRow['status'], string>> = {
  applied: '已应用',
  failed: '失败',
  rejected: '被拒绝',
  'dry-run': '干跑',
  skipped: '跳过',
};

export function EventTimeline({ rows, testId }: EventTimelineProps) {
  const now = new Date();
  const groups: { key: string; label: string; rows: AuditRow[] }[] = [];
  for (const row of rows) {
    const key = dayKey(row.at);
    const last = groups.at(-1);
    if (last !== undefined && last.key === key) {
      last.rows.push(row);
    } else {
      groups.push({ key, label: dayLabel(key, now), rows: [row] });
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      {groups.map((group, groupIndex) => (
        <div key={group.key} className="flex min-w-0 flex-col">
          <p className="micro-label pb-0.5">{group.label}</p>
          <ol
            className="flex min-w-0 flex-col border-l border-border pl-4"
            data-testid={`${testId ?? 'timeline'}-day-${group.key}`}
          >
            {group.rows.map((row, rowIndex) => {
              const tone = eventTone(row.status);
              const statusLabel = STATUS_LABEL[row.status] ?? row.status;
              const stagger = groupIndex === 0 ? rowIndex : 8;
              return (
                <li
                  key={row.id}
                  data-testid={`event-${row.id}`}
                  title={rowTitle(row, statusLabel)}
                  className={`relative flex h-7 min-w-0 items-center gap-1.5 text-xs ${stagger < 8 ? 'stagger-row' : ''}`}
                  style={stagger < 8 ? { animationDelay: `${String(stagger * 24)}ms` } : undefined}
                >
                  <span aria-hidden className="absolute top-1/2 -left-[21px] -translate-y-1/2">
                    <StatusDot tone={tone} className="size-2 ring-2 ring-card" />
                  </span>
                  <StatusDot tone={tone} label={statusLabel} className="sr-only" />

                  <time
                    className="w-14 shrink-0 tabular text-faint"
                    dateTime={row.at}
                    title={formatAbsoluteTime(row.at)}
                  >
                    {formatRelativeTime(row.at, now)}
                  </time>
                  <Sep />
                  <Link
                    to={repoWorkspacePath(row.repo)}
                    className="min-w-0 max-w-[11rem] shrink-0 truncate font-mono text-xs text-foreground/90 underline-offset-2 transition-[color] duration-[120ms] hover:text-foreground hover:underline"
                    title={row.repo}
                  >
                    {row.repo}
                  </Link>
                  <span className="shrink-0 font-mono text-2xs text-faint" title={targetLabel(row.target)}>
                    {targetLabel(row.target)}
                  </span>
                  <Sep />
                  <Badge tone={tone}>{INTENT_LABEL[row.intent]}</Badge>
                  {row.dryRun ? <Badge tone="warn">dry-run</Badge> : null}
                  <span className="ml-auto min-w-0 shrink-0 truncate text-2xs text-faint">
                    {row.actor.login === null ? '@—' : `@${row.actor.login}`}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">没有事件</p>
      ) : (
        <p className="text-2xs tabular text-faint">{`共 ${formatCount(rows.length)} 条 · 时间倒序`}</p>
      )}
    </div>
  );
}

/** 行内分隔点：两侧各 6px（` · ` 的唯一写法）。 */
function Sep() {
  return (
    <span aria-hidden className="shrink-0 text-faint">
      ·
    </span>
  );
}
