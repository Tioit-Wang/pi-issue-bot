import { Link } from 'react-router';
import type { IssueListItem } from '../../lib/contract.ts';
import { repoIssuePath, repoIssuesPath } from '../../lib/repo-route.ts';
import { cn } from '../../lib/utils.ts';
import { StatusDot } from '../ui/badge.tsx';
import { BOARD_COLUMNS, dwellOfItem, type PipelineGroups } from './aggregate.ts';
import { PipelineStateBadge } from './pipeline-badge.tsx';
import {
  PIPELINE_FORMAT_MAX_FAILS,
  STAGE_FOOTNOTE,
  STAGE_TONE,
  attemptsText,
  stageTitle,
} from './pipeline-status.ts';

/**
 * 阶段看板（四列：format / classify / agent / closed）。
 *
 * 版面规则（D1）：
 *  - **不是卡片套卡片**：列是一根 hairline 分隔的轨道（列头 + 列表 + 列底口径），列内卡片只有
 *    hairline 描边、没有阴影；页面元素不投影（设计系统 §3）；
 *  - 每张卡只有四项信息：**标题 / 状态徽章 / 停留时长 / 尝试次数** —— 阶段已经从列头知道了，
 *    不在卡里重复；
 *  - 卡片顺序 = 停留时长降序（最久的在最上面），该列的口径写在最后一行；
 *  - `pipeline === null` 的行**不进任何阶段列**：它们放在看板下方单独一行「未入流水线」，
 *    理由写在 `title` 里（懒创建 / 存量放行），不用「阶段 0 待跑」冒充。
 */
export type StageBoardProps = {
  groups: PipelineGroups;
  now: number;
  /** 当前仓库（`owner/name`）：卡片链接用它拼路由。 */
  repo: string;
  /** 单列最多显示几张卡（超出给一条「去 Issue 中心」的链接，不裁剪内容）。 */
  maxCards?: number;
};

const DEFAULT_MAX_CARDS = 12;

export function StageBoard({ groups, now, repo, maxCards = DEFAULT_MAX_CARDS }: StageBoardProps) {
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="stage-board">
      <div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {BOARD_COLUMNS.map((stage) => (
          <StageColumn key={stage} stage={stage} items={groups[stage]} now={now} repo={repo} maxCards={maxCards} />
        ))}
      </div>
      {groups.unassigned.length === 0 ? null : <UnassignedRow items={groups.unassigned} repo={repo} />}
    </div>
  );
}

function StageColumn({
  stage,
  items,
  now,
  repo,
  maxCards,
}: {
  stage: (typeof BOARD_COLUMNS)[number];
  items: readonly IssueListItem[];
  now: number;
  repo: string;
  maxCards: number;
}) {
  const shown = items.slice(0, maxCards);
  const hidden = items.length - shown.length;

  return (
    <section
      className="flex min-w-0 flex-col gap-2 border-t-2 border-border pt-1.5"
      data-testid={`stage-column-${stage}`}
      aria-label={stageTitle(stage)}
    >
      <header className="flex min-w-0 items-center gap-1.5">
        <StatusDot tone={STAGE_TONE[stage]} />
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground" title={stageTitle(stage)}>
          {stageTitle(stage)}
        </h3>
        <span className="shrink-0 text-xs tabular text-faint" data-testid={`stage-count-${stage}`}>
          {String(items.length)}
        </span>
      </header>

      <div className="flex min-w-0 flex-col gap-1.5">
        {shown.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-2 py-3 text-xs text-subtle">此阶段没有 issue</p>
        ) : (
          shown.map((item) => (
            <StageCard key={`${item.repo}#${String(item.number)}`} item={item} now={now} repo={repo} />
          ))
        )}
        {hidden <= 0 ? null : (
          <Link
            to={`${repoIssuesPath(repo)}?stage=${stage}`}
            className="rounded-sm px-1 py-1 text-2xs text-faint transition-[color] duration-[var(--dur-fast)] ease-out-quint hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            title={`这一列还有 ${String(hidden)} 个没画出来：去 Issue 中心按阶段筛选看全`}
          >
            {`还有 ${String(hidden)} 个 · 去 Issue 中心`}
          </Link>
        )}
      </div>

      <p className="text-2xs leading-relaxed text-faint" data-testid={`stage-footnote-${stage}`}>
        {STAGE_FOOTNOTE[stage]}
      </p>
    </section>
  );
}

function StageCard({ item, now, repo }: { item: IssueListItem; now: number; repo: string }) {
  const dwell = dwellOfItem(item, now);
  const pipeline = item.pipeline;
  const attempts = pipeline === null ? 0 : pipeline.formatFailCount;
  const blockedReason = pipeline?.blockedReason ?? null;
  const baseTitle = item.title ?? '（取不到标题）';

  return (
    <Link
      to={repoIssuePath(repo === '' ? item.repo : repo, item.kind, item.number)}
      className={cn(
        'flex min-w-0 flex-col gap-1 rounded-md border border-border bg-card px-2 py-1.5',
        'transition-[background-color,border-color] duration-[var(--dur-fast)] ease-out-quint',
        'hover:border-border-strong hover:bg-muted',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
      )}
      data-testid={`stage-card-${item.repo}#${item.kind}${String(item.number)}`}
      title={blockedReason === null ? baseTitle : `${baseTitle} · 阻塞原因：${blockedReason}`}
    >
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="shrink-0 font-mono text-2xs text-faint">{`#${String(item.number)}`}</span>
        <span className="min-w-0 line-clamp-2 text-sm leading-snug text-foreground">{baseTitle}</span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-2xs text-faint">
        {pipeline === null ? null : <PipelineStateBadge state={pipeline.state} />}
        <span
          className={cn('shrink-0 tabular', dwell?.overdue === true ? 'font-medium text-danger-fg' : 'text-muted-foreground')}
          title={dwell?.title ?? '没有流水线行，没有停留口径'}
          data-testid="stage-card-dwell"
        >
          {dwell?.text ?? '—'}
        </span>
        <span
          className="ml-auto shrink-0 tabular"
          title={`格式不通过 ${String(attempts)} 次，累计 ${String(PIPELINE_FORMAT_MAX_FAILS)} 次自动关闭`}
          data-testid="stage-card-attempts"
        >
          {`${attemptsText(attempts)} 次`}
        </span>
      </span>
    </Link>
  );
}

/** 「未入流水线」：`pipeline === null` 的行单独一组，不混进任何阶段列。 */
function UnassignedRow({ items, repo }: { items: readonly IssueListItem[]; repo: string }) {
  const shown = items.slice(0, 6);
  const hidden = items.length - shown.length;

  return (
    <div
      className="flex min-w-0 flex-col gap-1 border-t border-dashed border-border pt-2"
      data-testid="stage-unassigned"
      title="没有 issue_pipeline 行：存量 issue 或还没被 issues.opened 建行（懒创建）。收到 @ 时按「无行」放行，不进三段流程"
    >
      <p className="flex items-center gap-1.5 text-2xs text-faint">
        未入流水线
        <span className="tabular" data-testid="stage-unassigned-count">
          {String(items.length)}
        </span>
      </p>
      <ul className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        {shown.map((item) => (
          <li key={`${item.repo}#${String(item.number)}`} className="min-w-0 max-w-[22rem]">
            <Link
              to={repoIssuePath(repo === '' ? item.repo : repo, item.kind, item.number)}
              className="block min-w-0 truncate text-xs text-muted-foreground transition-[color] duration-[var(--dur-fast)] ease-out-quint hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              title={item.title ?? undefined}
            >
              {`#${String(item.number)} ${item.title ?? '（取不到标题）'}`}
            </Link>
          </li>
        ))}
        {hidden <= 0 ? null : <li className="text-2xs text-faint">{`+${String(hidden)}`}</li>}
      </ul>
    </div>
  );
}
