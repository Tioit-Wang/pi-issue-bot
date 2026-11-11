/**
 * 看板与指标条的**客户端聚合**（本切片不新增后端接口）。
 *
 * 数据来源只有 `GET /api/issues`（契约 `IssueListItem.pipeline`，必填 + nullable）：
 *  - 有流水线行 → 按 `stage` 分到四列（format / classify / agent / closed）；
 *  - **`pipeline === null` → 单独一组 `unassigned`（「未入流水线」）**，不混进任何阶段列：
 *    「没有行」与「行在但状态是 pending」是两件事（§1.3 的懒创建 / 存量放行）。
 *
 * 拿不到的数就写 `null`（界面显示 `—` + `title` 说明缺哪个接口），**不造假数字**：
 *  - `今日自动关闭`：需要 `pipeline-close` 作业的执行记录或带时间点的关闭事件，
 *    当前读接口没有（`issue_pipeline` 的 `closed_at` 不在 API 投影里）；
 *  - `已归档会话`：没有会话归档的查询接口。
 *
 * 计数口径一律作用在**已加载的行**上（游标分页），所以界面要同时显示「已加载 N 行」。
 */
import type { IssueListItem } from '../../lib/contract.ts';
import { dwellOf, isInFlow, type Dwell } from './pipeline-status.ts';

export type PipelineGroupKey = 'format' | 'classify' | 'agent' | 'closed' | 'unassigned';

export type PipelineGroups = Record<PipelineGroupKey, IssueListItem[]>;

/** 看板四列的顺序（`unassigned` 不在列里，单独一行）。 */
export const BOARD_COLUMNS = ['format', 'classify', 'agent', 'closed'] as const;

export type BoardColumnKey = (typeof BOARD_COLUMNS)[number];

/** 一行的停留时长（看板排序与卡片右侧共用）。 */
export function dwellOfItem(item: IssueListItem, now: number): Dwell | null {
  return item.pipeline === null ? null : dwellOf(item.pipeline, item.lastActivityAt, now);
}

/**
 * 按阶段分组。
 *
 * 列内排序：**停留时长降序**（最久的在最前，因为它是「现在最该处理的那个」）；
 * `unassigned` 按最后活动倒序（它没有锚点，只能用最后活动）。没有锚点的行排最后。
 */
export function groupByStage(items: readonly IssueListItem[], now: number): PipelineGroups {
  const groups: PipelineGroups = {
    format: [],
    classify: [],
    agent: [],
    closed: [],
    unassigned: [],
  };

  for (const item of items) {
    const pipeline = item.pipeline;
    if (pipeline === null) {
      groups.unassigned.push(item);
      continue;
    }
    groups[pipeline.stage].push(item);
  }

  const dwellDesc = (left: IssueListItem, right: IssueListItem): number => {
    const leftMs = dwellOfItem(left, now)?.ms ?? -1;
    const rightMs = dwellOfItem(right, now)?.ms ?? -1;
    return rightMs - leftMs;
  };

  groups.format.sort(dwellDesc);
  groups.classify.sort(dwellDesc);
  groups.agent.sort(dwellDesc);
  groups.closed.sort(dwellDesc);
  groups.unassigned.sort((left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt));
  return groups;
}

export type PipelineMetrics = {
  /** 有流水线行且还没结束（`stage ≠ closed`）。 */
  inPipeline: number;
  /** `state = awaiting_info`。 */
  awaiting: number;
  /** 等得最久的那个的停留毫秒；没有等补充的行 → `null`。 */
  awaitingLongestMs: number | null;
  /** `state = blocked`。 */
  blocked: number;
  /** 阻塞行里最大的格式失败次数；没有阻塞行 → `null`。 */
  blockedMaxFails: number | null;
  /** `pipeline === null` 的行数（懒创建 / 存量放行）。 */
  noRow: number;
  /** `stage = closed` 的行数（口径：已结束，不等于「今日自动关闭」）。 */
  closedRows: number;
  /** **拿不到**：没有「自动关闭」的时间点来源 → 恒为 `null`，界面显示 `—`。 */
  closedToday: null;
};

export function pipelineMetrics(items: readonly IssueListItem[], now: number): PipelineMetrics {
  let inPipeline = 0;
  let awaiting = 0;
  let awaitingLongestMs: number | null = null;
  let blocked = 0;
  let blockedMaxFails: number | null = null;
  let noRow = 0;
  let closedRows = 0;

  for (const item of items) {
    const pipeline = item.pipeline;
    if (pipeline === null) {
      noRow += 1;
      continue;
    }
    if (isInFlow(pipeline)) inPipeline += 1;
    if (pipeline.stage === 'closed' || pipeline.state === 'closed') closedRows += 1;

    if (pipeline.state === 'awaiting_info') {
      awaiting += 1;
      const ms = dwellOfItem(item, now)?.ms ?? null;
      if (ms !== null && (awaitingLongestMs === null || ms > awaitingLongestMs)) awaitingLongestMs = ms;
    }
    if (pipeline.state === 'blocked') {
      blocked += 1;
      const fails = pipeline.formatFailCount;
      if (blockedMaxFails === null || fails > blockedMaxFails) blockedMaxFails = fails;
    }
  }

  return { inPipeline, awaiting, awaitingLongestMs, blocked, blockedMaxFails, noRow, closedRows, closedToday: null };
}

export type SessionHealth = {
  /** 有 `sessionId` 的 issue 数（= 阶段 2 复用会话中）。 */
  sessions: number;
  /** 这些会话的平均轮数（保留 1 位）；没有会话 → `null`。 */
  avgTurns: number | null;
  /** `sessionTurns ≥ 轮换阈值 − 5` 的会话数（接近 `SESSION_MAX_TURNS`）。 */
  nearRotation: number;
  /** **拿不到**：没有归档会话的查询接口 → 恒为 `null`。 */
  archived: null;
};

/** 会话健康：全部字段来自 `/api/issues` 的 `pipeline.sessionId / sessionTurns`。 */
export function sessionHealth(items: readonly IssueListItem[], nearThreshold = 25): SessionHealth {
  const sessions = items.filter((item) => item.pipeline !== null && item.pipeline.sessionId !== null);
  const turns = sessions.map((item) => (item.pipeline === null ? 0 : item.pipeline.sessionTurns));
  const total = turns.reduce((sum, value) => sum + value, 0);
  return {
    sessions: sessions.length,
    avgTurns: turns.length === 0 ? null : Math.round((total / turns.length) * 10) / 10,
    nearRotation: turns.filter((value) => value >= nearThreshold).length,
    archived: null,
  };
}
