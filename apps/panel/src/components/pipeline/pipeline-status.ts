/**
 * 固定流水线的**唯一文案与配色映射处**（`docs/plan-fixed-pipeline.md` §2 / §6 / §8）。
 *
 * 为什么单独一个文件：阶段名、状态名、类别名、四档语义色在流水线页、issue 列表、issue 详情
 * 三处都要出现，散着写必然出现「这里叫待人补充、那里叫等补充」和「同一个状态两种颜色」。
 * 颜色只从 `ui/status.ts` 的 tone 取（设计系统 §1），这里**不写任何字面色值**。
 *
 * 四种性质是固定的（设计系统 D1 + 本页口径）：
 *
 * | 状态 | tone | 含义 |
 * |---|---|---|
 * | `ready` | success | 三段走完，等 `@` |
 * | `awaiting_info` | warn | 等人补充（format 等用户 / classify 等管理员） |
 * | `blocked` | danger | 自动流程停了，只能人工推 |
 * | `running` / `pending` | info | 正在跑 / 排队中 |
 * | `closed` | 中性**描边**（不是实底） | 流程已结束 |
 *
 * 常量在这里各留一份**只读镜像**：面板不重复计算，只用于「N/5」这类展示与 `title` 口径。
 * 真实值属于服务端系统常量模块（改常量要发版），面板不提供编辑（§4.5）。
 */
import type {
  IssueListItem,
  IssuePipeline,
  PipelineCategory,
  PipelineStage,
  PipelineState,
} from '../../lib/contract.ts';
import type { Tone } from '../ui/status.ts';

/** 格式不通过累计到这个数就自动关 issue（Q5）。 */
export const PIPELINE_FORMAT_MAX_FAILS = 5;
/** `format/awaiting_info` 满这么久自动关（Q2）。 */
export const PIPELINE_CLOSE_AFTER_HOURS = 48;
/** 会话轮数上限（超过就轮换）。 */
export const SESSION_MAX_TURNS = 30;
/** 会话存活上限（天）。 */
export const SESSION_MAX_AGE_DAYS = 7;
/** 停留超过这个时长就用 danger 色文字（与「48h 自动关」不是一个数：这是面板的提醒阈值）。 */
export const DWELL_WARN_MS = 24 * 60 * 60 * 1000;

/** 阶段顺序 = 看板列顺序。 */
export const STAGE_ORDER: readonly PipelineStage[] = ['format', 'classify', 'agent', 'closed'];

export const STAGE_LABEL: Record<PipelineStage, string> = {
  format: '格式检查',
  classify: '标签分类',
  agent: 'Agent',
  closed: '已结束',
};

/** 阶段编号（`closed` 不是第 3 阶段，它是一条终态）。 */
const STAGE_NO: Record<PipelineStage, string> = {
  format: '阶段 0',
  classify: '阶段 1',
  agent: '阶段 2',
  closed: '终态',
};

/** `阶段 0 · 格式检查` / `已结束`。 */
export function stageTitle(stage: PipelineStage): string {
  return stage === 'closed' ? STAGE_LABEL.closed : `${STAGE_NO[stage]} · ${STAGE_LABEL[stage]}`;
}

/** 列头的圆点：阶段本身不带状态，颜色只区分「跑到哪一段」。 */
export const STAGE_TONE: Record<PipelineStage, Tone> = {
  format: 'warn',
  classify: 'info',
  agent: 'success',
  closed: 'neutral',
};

/** 列底那一行口径（一列一句，全部来自 §2 / §7）。 */
export const STAGE_FOOTNOTE: Record<PipelineStage, string> = {
  format: '一次性会话：create → run → archive，无评论（首次通过）',
  classify: '一次性会话；not-found 停在等管理员，其余直接进阶段 2',
  agent: '按 issue 复用会话；30 轮或 7 天轮换',
  closed: '关闭后不再接事件；reopen 由 GitHub 事件重新入队',
};

export const STATE_LABEL: Record<PipelineState, string> = {
  pending: '待跑',
  running: '执行中',
  awaiting_info: '待人补充',
  ready: '已就绪',
  blocked: '阻塞',
  closed: '已关闭',
};

export const STATE_TONE: Record<PipelineState, Tone> = {
  pending: 'info',
  running: 'info',
  awaiting_info: 'warn',
  ready: 'success',
  blocked: 'danger',
  closed: 'neutral',
};

/** 状态的口径（`title` 用，不进正文）。 */
export const STATE_DESCRIPTION: Record<PipelineState, string> = {
  pending: '已入队，等定时/并发闸放行',
  running: '该阶段任务正在跑（收到 @ 只打 eyes，不建任务）',
  awaiting_info: '等人补充：format 等作者补充（48h 无补充自动关），classify 等管理员',
  ready: '三段走完，收到 @ 正常建任务',
  blocked: '自动流程已暂停：运行失败或信封不合法连续 2 次，只能人工推',
  closed: '流程已结束：自动关闭 / 48h 无补充 / 人工关闭',
};

export const CATEGORY_LABEL: Record<PipelineCategory, string> = {
  requirement: '需求',
  defect: '缺陷',
  'not-found': '查不到',
  other: '其他',
};

export const CATEGORY_DESCRIPTION: Record<PipelineCategory, string> = {
  requirement: '打 role=requirement 标签 + 初步分析 + @ 管理员',
  defect: '必须有 path:line 证据，否则降级成 not-found',
  'not-found': '代码里定位不到：不打缺陷标签，@managers 等管理员回复',
  other: '只打标签，不发评论',
};

/** 类别只给「需要人做什么」上色，不给结论本身判好坏。 */
export const CATEGORY_TONE: Record<PipelineCategory, Tone> = {
  requirement: 'info',
  defect: 'warn',
  'not-found': 'neutral',
  other: 'neutral',
};

/* ── 停留时长 ───────────────────────────────────────────────────────────────
 * 契约（`IssuePipeline`）**没有**「进入当前阶段的时刻」这一列，所以面板只能取一个近似锚点：
 *
 *   coalesce(infoRequestedAt, readyAt, staleAt, lastActivityAt)
 *
 * 前三个是状态转换时落库的真实时刻；最后一个 `lastActivityAt` 是四源 max 的「最后活动」，
 * 兜底用。口径必须写在列头 `title` 里（不写就等于编了一个数），这里用 `DwellSource`
 * 把「用的是哪个锚点」一起带出来，界面可以按需在 `title` 里说明。
 */

export type DwellSource = 'infoRequestedAt' | 'readyAt' | 'staleAt' | 'lastActivityAt';

export type DwellAnchor = {
  /** 起算时刻（ISO）；行里没有任何可用时刻时为 `null`。 */
  at: string | null;
  source: DwellSource | null;
};

/** 取停留时长的起算点（顺序即优先级，见上面的说明）。 */
export function dwellAnchor(pipeline: IssuePipeline, lastActivityAt: string): DwellAnchor {
  if (pipeline.infoRequestedAt !== null) return { at: pipeline.infoRequestedAt, source: 'infoRequestedAt' };
  if (pipeline.readyAt !== null) return { at: pipeline.readyAt, source: 'readyAt' };
  if (pipeline.staleAt !== null) return { at: pipeline.staleAt, source: 'staleAt' };
  return { at: lastActivityAt === '' ? null : lastActivityAt, source: 'lastActivityAt' };
}

const DWELL_SOURCE_LABEL: Record<DwellSource, string> = {
  infoRequestedAt: '进入「等补充」的时刻',
  readyAt: '就绪时刻',
  staleAt: '判旧时刻',
  lastActivityAt: '最后活动时刻（近似：契约没有「进入阶段时刻」）',
};

export type Dwell = {
  ms: number | null;
  /** `3.2h` / `46h` / `2.1 天`；没有锚点为 `—`。 */
  text: string;
  /** 超过 `DWELL_WARN_MS` → 用 danger 色文字（不是整行染色）。 */
  overdue: boolean;
  /** 悬停说明：用的是哪个锚点 + 绝对时间。 */
  title: string;
};

/** 停留时长：`now − anchor`，四舍五入到一档人类可读单位。 */
export function dwellOf(pipeline: IssuePipeline, lastActivityAt: string, now: number): Dwell {
  const anchor = dwellAnchor(pipeline, lastActivityAt);
  const at = anchor.at === null ? Number.NaN : Date.parse(anchor.at);
  if (Number.isNaN(at)) {
    return { ms: null, text: '—', overdue: false, title: '这一行没有可用的时间锚点（契约字段全为空）' };
  }
  const ms = Math.max(0, now - at);
  const source = anchor.source === null ? '' : DWELL_SOURCE_LABEL[anchor.source];
  return {
    ms,
    text: formatDwell(ms),
    overdue: ms >= DWELL_WARN_MS,
    title: `停留 ${formatDwell(ms)} · 起算：${source} · ${anchor.at?.slice(0, 19).replace('T', ' ') ?? '—'} UTC`,
  };
}

/** 毫秒 → `8m` / `3.2h` / `2.1 天`（一档，不做 `1h 20m` 这种双档）。 */
export function formatDwell(ms: number): string {
  const value = Math.max(0, ms);
  const minutes = value / 60_000;
  if (minutes < 1) return `${String(Math.max(0, Math.round(value / 1000)))}s`;
  if (minutes < 60) return `${String(Math.round(minutes))}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)} 天`;
}

/** 尝试次数：`2/5`（分子是格式**不通过**次数，分母是自动关闭阈值）。 */
export function attemptsText(formatFailCount: number): string {
  return `${String(formatFailCount)}/${String(PIPELINE_FORMAT_MAX_FAILS)}`;
}

/** 徽章合成文案：`阶段 0 · 待人补充`；没有流水线行 → `未入流水线`。 */
export function stageStateText(pipeline: IssuePipeline | null): string {
  if (pipeline === null) return '未入流水线';
  if (pipeline.stage === 'closed' || pipeline.state === 'closed') return STAGE_LABEL.closed;
  return `${STAGE_NO[pipeline.stage]} · ${STATE_LABEL[pipeline.state]}`;
}

/** 徽章的悬停说明（原因不进正文行）。 */
export function stageStateTitle(pipeline: IssuePipeline | null): string {
  if (pipeline === null) {
    return '没有 issue_pipeline 行：存量 issue 或还没被 opened 事件建行（懒创建），收到 @ 时按「无行」放行';
  }
  const parts = [STATE_DESCRIPTION[pipeline.state]];
  if (pipeline.stage === 'closed' || pipeline.state === 'closed') parts.unshift(STAGE_FOOTNOTE.closed);
  if (pipeline.blockedReason !== null) parts.push(`阻塞原因：${pipeline.blockedReason}`);
  return parts.join(' · ');
}

/** 这一行是否在流转中（有行且没结束）——指标条的「在流水线」口径。 */
export function isInFlow(pipeline: IssuePipeline | null): boolean {
  return pipeline !== null && pipeline.stage !== 'closed' && pipeline.state !== 'closed';
}

/** 便捷：从列表行取流水线（`null` = 没有状态行）。 */
export function pipelineOf(item: IssueListItem): IssuePipeline | null {
  return item.pipeline;
}
