import { Link } from 'react-router';
import type { IssueListItem } from '../../lib/contract.ts';
import { EMPTY, formatCount, formatDuration, formatTimeCell, formatUsd } from '../../lib/format.ts';
import { repoIssuePath } from '../../lib/repo-route.ts';
import { Badge, StatusDot } from '../ui/badge.tsx';
import { TONE_BORDER, TONE_TEXT } from '../ui/status.ts';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.tsx';
import { readLabelDecision, readReactionState, readRunCost } from './contract-extras.ts';
import { ReactionChip } from './reaction-chip.tsx';
import { ISSUE_STATE_LABEL, ISSUE_STATE_TONE, presentStatus, shortRepo } from './status.ts';

/**
 * Issue 中心的**主从列表**（列定义只有这一处）。
 *
 * 列：**编号 / 标题 / 标签 / 状态 / reaction / 耗时 / 最后活动**（仓库上下文里没有「项目」列）。
 *
 * 三处刻意的设计：
 *
 *  1. **每行是一个对象**：点行 = 选中（右侧出概要），点标题 = 进整页详情（真 URL，刷新/分享可用）。
 *     选中态用品牌 8% 底 + 左缘 2px 条（`data-state=selected` 由 `TableRow` 处理底色，
 *     左缘条加在编号单元格上），**不是胶囊**。
 *  2. **首列吸顶**（`stickyFirst`）：窄屏横向滚动时「编号」不会跑掉，标题仍然可读。
 *  3. **容错**：`耗时` / `成本` 是服务端可选字段，没来就是 `—`（不是 0）；reaction 与打标理由
 *     通过 `contract-extras.ts` 宽容读取，字段缺失只表现为没有徽章，页面不炸。
 */
export type IssueListProps = {
  rows: readonly IssueListItem[];
  /** 选中键（`repo#kind17`）；`null` = 没选中。 */
  selectedKey: string | null;
  /** 点行：选中（宽屏）或跳详情（窄屏），由页面决定。 */
  onSelect: (item: IssueListItem) => void;
  /** 是否显示「项目」列（全局列表 true；仓库上下文 false）。 */
  showRepo: boolean;
  /** 表格说明（caption）：必须交代排序与「—」的含义。 */
  caption: string;
  repoLock?: string;
  /** 只有多仓库时才在编号里带 owner 短名。 */
  showOwner?: boolean;
};

/** 列表行的稳定键（选中状态与 React key 共用）。 */
export function issueKey(item: IssueListItem): string {
  return `${item.repo}#${item.kind}${String(item.number)}`;
}

function detailHref(item: IssueListItem, repoLock: string | undefined): string {
  if (repoLock !== undefined) return repoIssuePath(repoLock, item.kind, item.number);
  return repoIssuePath(item.repo, item.kind, item.number);
}

export function IssueTable({
  rows,
  selectedKey,
  onSelect,
  showRepo,
  caption,
  repoLock,
  showOwner = true,
}: IssueListProps) {
  const now = Date.now();
  const hasRunCost = rows.some((row) => {
    const cost = readRunCost(row);
    return cost.durationMs !== null || cost.costUsd !== null;
  });

  return (
    <Table stickyFirst className="min-w-[44rem] table-fixed text-[13px]" data-testid="issue-table">
      <TableCaption className="text-left">{caption}</TableCaption>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {showRepo ? (
            <TableHead scope="col" className="w-[9rem]">
              项目
            </TableHead>
          ) : null}
          <TableHead scope="col" className="w-[5rem]">
            编号
          </TableHead>
          <TableHead scope="col">标题</TableHead>
          <TableHead scope="col" className="w-[8.5rem]">
            标签
          </TableHead>
          <TableHead scope="col" className="w-[7rem]">
            状态
          </TableHead>
          <TableHead scope="col" className="w-[5.5rem]">
            reaction
          </TableHead>
          <TableHead
            scope="col"
            className="w-[4rem] text-right"
            title={
              hasRunCost
                ? '接口没返回 durationMs 时显示 —（不是 0）'
                : '/api/issues 还没有 durationMs / costUsd 字段：这一列暂时全为 —'
            }
          >
            耗时
          </TableHead>
          <TableHead scope="col" className="w-[6.5rem] text-right">
            最后活动
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((item) => {
          const key = issueKey(item);
          return (
            <IssueRow
              key={key}
              item={item}
              selected={selectedKey === key}
              onSelect={onSelect}
              showRepo={showRepo}
              showOwner={showOwner}
              repoLock={repoLock}
              now={now}
            />
          );
        })}
      </TableBody>
    </Table>
  );
}

function IssueRow({
  item,
  selected,
  onSelect,
  showRepo,
  showOwner,
  repoLock,
  now,
}: {
  item: IssueListItem;
  selected: boolean;
  onSelect: (item: IssueListItem) => void;
  showRepo: boolean;
  showOwner: boolean;
  repoLock: string | undefined;
  now: number;
}) {
  const status = presentStatus(item, now);
  const time = formatTimeCell(item.lastActivityAt);
  const reaction = readReactionState(item);
  const decision = readLabelDecision(item);
  const run = readRunCost(item);
  const blocked = decision?.blocked[0] ?? null;
  const extraLabels = item.labels.length > 3 ? item.labels.length - 3 : 0;

  return (
    <TableRow
      data-testid={`issue-row-${item.repo}#${item.kind}${String(item.number)}`}
      data-state={selected ? 'selected' : undefined}
      aria-selected={selected}
      className="cursor-pointer"
      onClick={() => {
        onSelect(item);
      }}
    >
      {showRepo ? (
        <TableCell className="truncate font-mono text-xs text-muted-foreground" title={item.repo}>
          {shortRepo(item.repo, showOwner)}
        </TableCell>
      ) : null}

      <TableCell className={selected ? `border-l-2 font-mono text-xs whitespace-nowrap ${TONE_BORDER.brand}` : 'font-mono text-xs text-muted-foreground whitespace-nowrap'}>
        <span
          className={selected ? 'text-brand' : undefined}
          title={`${item.repo} ${item.kind}#${String(item.number)}`}
        >
          #{formatCount(item.number)}
        </span>
      </TableCell>

      <TableCell className="min-w-0">
        <span className="flex min-w-0 flex-col gap-0.5">
          {/*
            标题是**唯一**进整页详情的入口（真 URL）：点行选中、点标题跳页，
            两者不抢同一个手势。`stopPropagation` 让行选中不被连带触发。
          */}
          <Link
            to={detailHref(item, repoLock)}
            className="min-w-0 truncate text-foreground outline-offset-2 hover:underline"
            data-testid="issue-row-link"
            title={item.title ?? undefined}
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            {item.title ?? '（取不到标题）'}
          </Link>
          <span className="flex min-w-0 items-center gap-1.5 text-2xs text-faint">
            {item.awaitingReply ? <span className="text-warn-fg">待人回答</span> : null}
            {item.awaitingReply ? <span aria-hidden>·</span> : null}
            <span className="min-w-0 truncate" title={item.lastPreview ?? undefined} data-testid="issue-row-preview">
              {item.lastPreview === null
                ? EMPTY
                : `${item.lastActorKind === 'bot' ? '机' : '人'}：${item.lastPreview}`}
            </span>
          </span>
        </span>
      </TableCell>

      <TableCell>
        {item.labels.length === 0 ? (
          <span className="text-xs text-muted-foreground">没有标签</span>
        ) : (
          <span className="flex flex-wrap items-center gap-1" data-testid="issue-row-labels">
            {item.labels.slice(0, 3).map((label) => (
              <Badge key={label} tone="neutral" className="max-w-full truncate">
                {label}
              </Badge>
            ))}
            {extraLabels === 0 ? null : <span className="text-2xs text-faint">{`+${String(extraLabels)}`}</span>}
            {blocked === null ? null : (
              <Badge
                tone="warn"
                title={`打标被拦：${blocked.reason}（${String(blocked.count)} 次）`}
                data-testid="issue-row-blocked"
              >
                {`打标被拦${blocked.count > 1 ? ` · ${String(blocked.count)}` : ''}`}
              </Badge>
            )}
          </span>
        )}
      </TableCell>

      <TableCell>
        <span className="flex min-w-0 flex-col gap-0.5" data-testid="issue-row-status">
          <span className="flex items-center gap-1">
            <StatusDot
              tone={status.tone}
              label={status.label}
              pulse={status.status === 'running' && !status.stalled}
            />
            <span
              className={`text-xs font-medium ${TONE_TEXT[status.tone]}`}
              title={status.stalled ? '进行中但超过 1 小时没有新活动（run 可能崩了）' : undefined}
            >
              {status.label}
            </span>
          </span>
          <span className="flex flex-wrap items-center gap-1">
            <Badge tone={ISSUE_STATE_TONE[item.state]}>{ISSUE_STATE_LABEL[item.state]}</Badge>
            {item.kind === 'pr' ? <Badge tone="neutral">PR</Badge> : null}
            {item.stateStale ? (
              <span className="text-2xs text-warn-fg" title="状态不是来自投递事件，可能过期">
                过期
              </span>
            ) : null}
          </span>
        </span>
      </TableCell>

      <TableCell>
        <ReactionChip state={reaction} className="max-w-full truncate" />
      </TableCell>

      <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
        {run.durationMs === null ? <span title="接口未提供该字段">—</span> : formatDuration(run.durationMs)}
      </TableCell>

      <TableCell className="text-right">
        <time className="text-xs text-muted-foreground" title={time.title} dateTime={item.lastActivityAt}>
          {time.text}
        </time>
      </TableCell>
    </TableRow>
  );
}

/** 成本单元格目前没有独立列（列宽优先给标题），保留读取器给右侧概要复用。 */
export { readRunCost as readRowRunCost, formatUsd as formatRowUsd };
