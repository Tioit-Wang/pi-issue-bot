/**
 * Issue 行的**状态口径**（列表、详情、首页待办共用这一处）。
 *
 * 三件事都来自服务端契约，面板不自己发明：
 *
 *  1. **派生状态**（`deriveStatus`）——与契约 `issueStatusFilterSchema` 的优先级逐条对齐
 *     （服务端 WHERE 也照这个顺序）；「曾经成功、后来某次失败」不算 `failed`。
 *  2. **待人回答**（`awaitingReply`）——服务端算好的口径，面板只展示，不用「`botTurns === 0`」
 *     之类的代理（`botTurns` 数的是 `actions` 行数，机器人发过评论但没写 `actions` 时会误判）。
 *  3. **停滞修正**（`isStalled`）—— run 崩掉时 `outcomes.running` 会永远 > 0，显示层把
 *     一小时没动的「进行中」标成「已停滞」。这是显示层的诚实修正，不改数据（清理归生命周期作业）。
 *
 * 颜色**只来自** `ui/status.ts` 的 tone 映射（`TONE_DOT` / `TONE_TEXT`），这里不再写字面色。
 */
import type { IssueListItem } from '../../lib/contract.ts';
import { issueStateTone, type Tone } from '../ui/status.ts';

export type DerivedStatus = 'running' | 'queued' | 'failed' | 'answered' | 'idle';

/** 「进行中」超过这个时长没有新活动 → 标成已停滞。 */
export const STALE_RUNNING_MS = 60 * 60 * 1000;

const STATUS_TEXT: Record<DerivedStatus, string> = {
  running: '进行中',
  queued: '已排队',
  failed: '失败',
  answered: '已回复',
  idle: '无结果',
};

/** 派生状态 → tone（running 是「正在动」= warn，queued = 中性，failed = danger）。 */
const STATUS_TONE: Record<DerivedStatus, Tone> = {
  running: 'warn',
  queued: 'neutral',
  failed: 'danger',
  answered: 'success',
  idle: 'neutral',
};

/** issue 本身的状态（契约 `state`，`unknown` = 取不到元数据）。 */
export const ISSUE_STATE_LABEL: Record<IssueListItem['state'], string> = {
  open: 'open',
  closed: 'closed',
  unknown: '状态未知',
};

/** issue 状态的 tone（open = info，closed = 中性；`open` 不是「成功」）。 */
export const ISSUE_STATE_TONE: Record<IssueListItem['state'], Tone> = {
  open: issueStateTone('open'),
  closed: issueStateTone('closed'),
  unknown: 'neutral',
};

function countOf(item: IssueListItem, key: keyof IssueListItem['outcomes']): number {
  return item.outcomes[key] ?? 0;
}

/** 与契约 `issueStatusFilterSchema` 的优先级逐条对齐（服务端 WHERE 同序）。 */
export function deriveStatus(item: IssueListItem): DerivedStatus {
  if (countOf(item, 'running') > 0) return 'running';
  if (countOf(item, 'queued') > 0) return 'queued';
  if (countOf(item, 'failed') > 0 && countOf(item, 'succeeded') === 0) return 'failed';
  if (countOf(item, 'succeeded') > 0) return 'answered';
  return 'idle';
}

/** 「进行中」但很久没动：多半是 run 崩了留下的僵状态。 */
export function isStalled(item: IssueListItem, status: DerivedStatus, now: number): boolean {
  if (status !== 'running') return false;
  const at = Date.parse(item.lastActivityAt);
  return !Number.isNaN(at) && now - at > STALE_RUNNING_MS;
}

/** 是否「进行中但已经停滞」——首页待办队列与列表用同一个判断。 */
export function isStalledIssue(item: IssueListItem, now: number): boolean {
  return isStalled(item, deriveStatus(item), now);
}

export type StatusPresentation = {
  status: DerivedStatus;
  /** 展示用的词（`已停滞` 会替掉 `进行中`）。 */
  label: string;
  /** 状态点 / 文字 / 左缘条的语义色。 */
  tone: Tone;
  /** 是否被判定为停滞（列表里加 title 说明）。 */
  stalled: boolean;
};

/** 一次算齐「词 / tone / 是否停滞」，三个视图用同一份结果。 */
export function presentStatus(item: IssueListItem, now: number): StatusPresentation {
  const status = deriveStatus(item);
  const stalled = isStalled(item, status, now);
  if (stalled) return { status, label: '已停滞', tone: 'danger', stalled };
  return { status, label: STATUS_TEXT[status], tone: STATUS_TONE[status], stalled };
}

/** 待人回答 → tone（待办队列里它是 warn，不是 danger）。 */
export function awaitingTone(item: IssueListItem): Tone | null {
  return item.awaitingReply ? 'warn' : null;
}

/** 仓库名：只有一个仓库时省略 owner；多个仓库时带 owner（否则 `widgets#17` 与 `lib#17` 撞名）。 */
export function shortRepo(repo: string, showOwner: boolean): string {
  if (showOwner) return repo;
  const parts = repo.split('/');
  return parts.length === 2 ? (parts[1] ?? repo) : repo;
}
