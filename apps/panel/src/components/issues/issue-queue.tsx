import type { IssueListItem } from '../../lib/contract.ts';
import { formatCount, formatTimeCell } from '../../lib/format.ts';
import { repoIssuePath } from '../../lib/repo-route.ts';
import { railRowClass } from '../Rail.tsx';
import { StatusBadge, StatusDot } from '../ui/status-badge.tsx';
import { TONE_TEXT } from '../ui/status.ts';
import { readReactionState } from './contract-extras.ts';
import { ISSUE_STATE_LABEL, ISSUE_STATE_TONE, presentStatus, shortRepo } from './status.ts';

/**
 * Issue 队列的一行 —— **`FR-7.4` 的三左栏之一**。
 *
 * 改造前这里是 7 列表格（项目 / 编号 / 标题 / 标签 / 状态 / reaction / 最后活动），
 * 在 320px 的左栏里根本放不下，于是三处左栏只能用三种宽度（表格 / 208px 两列 / 表格）。
 * 现在按需求原文统一成「一列可选条目」：
 *
 * - 行高 28（`rail-row`）—— 与设置分区、技能列表同一套令牌；
 * - 选中态 = 左侧 3px 强调条 + 浅强调底（`rail-row-selected`），不是胶囊、不是整行染色；
 * - 三件事留在行内：**编号**（`#17`）、**标题**（唯一进详情页的入口）、**状态**；
 *   标签 / reaction / 时间降到第二行，`title` 里给全（密度优先，不是删信息）。
 *
 * 点行 = 选中（右栏换会话流），点标题 = 进整页详情（真 URL，刷新 / 分享可用）。
 * 两者不抢同一个手势。
 */
export function issueKey(item: IssueListItem): string {
  return `${item.repo}#${item.kind}${String(item.number)}`;
}

export function IssueQueueRow({
  item,
  selected,
  showRepo,
  onSelect,
  onOpen,
  now,
}: {
  item: IssueListItem;
  selected: boolean;
  showRepo: boolean;
  onSelect: (item: IssueListItem) => void;
  onOpen: (item: IssueListItem) => void;
  now: number;
}) {
  const status = presentStatus(item, now);
  const time = formatTimeCell(item.lastActivityAt);
  const reaction = readReactionState(item);
  const key = issueKey(item);

  return (
    <div
      data-testid={`issue-row-${key}`}
      data-state={selected ? 'selected' : undefined}
      aria-current={selected ? 'true' : undefined}
      onClick={() => {
        onSelect(item);
      }}
      className={railRowClass(
        selected,
        'flex-col items-stretch justify-center gap-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <StatusDot tone={status.tone} label={status.label} pulse={status.status === 'running' && !status.stalled} />
        <span
          className="shrink-0 font-mono text-2xs text-faint"
          title={`${item.repo} ${item.kind}#${String(item.number)}`}
        >
          {`#${formatCount(item.number)}`}
        </span>
        {/* 标题：唯一进整页详情的入口（真 `<a>`，右键可复制链接；不触发选中） */}
        <a
          href={repoIssuePath(item.repo, item.kind, item.number)}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onOpen(item);
          }}
          className="min-w-0 flex-1 truncate text-sm text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          data-testid="issue-row-link"
          title={item.title ?? undefined}
        >
          {item.title ?? '（取不到标题）'}
        </a>

        <span
          className={`shrink-0 text-2xs font-medium ${TONE_TEXT[status.tone]}`}
          title={status.stalled ? '进行中但超过 1 小时没有新活动（run 可能崩了）' : undefined}
        >
          {status.label}
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-1 text-2xs text-faint">
        {showRepo ? <span className="shrink-0 font-mono">{shortRepo(item.repo, false)}</span> : null}
        {item.awaitingReply ? <span className="shrink-0 text-warn-fg">待人回答</span> : null}
        <StatusBadge tone={ISSUE_STATE_TONE[item.state]}>{ISSUE_STATE_LABEL[item.state]}</StatusBadge>
        {item.labels.length === 0 ? null : (
          <span className="min-w-0 truncate" title={item.labels.join('、')} data-testid="issue-row-labels">
            {item.labels.slice(0, 2).join(' · ')}
            {item.labels.length > 2 ? ` +${String(item.labels.length - 2)}` : ''}
          </span>
        )}
        {reaction === null ? null : <span className="shrink-0" title="reaction">{reaction}</span>}
        <time className="ml-auto shrink-0 tabular" title={time.title}>
          {time.text}
        </time>
      </span>
    </div>
  );
}
