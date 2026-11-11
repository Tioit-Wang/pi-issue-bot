import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AsyncSection } from '../components/AsyncSection.tsx';
import { EventTimeline } from '../components/EventTimeline.tsx';
import { isStalledIssue } from '../components/issues/status.ts';
import { PageHeader } from '../components/PageHeader.tsx';
import { Section } from '../components/Section.tsx';
import { Badge, StatusDot } from '../components/ui/badge.tsx';
import { Button, buttonVariants } from '../components/ui/button.tsx';
import { Segmented } from '../components/ui/segmented.tsx';
import { TONE_BORDER, TONE_TEXT, type Tone } from '../components/ui/status.ts';
import { api } from '../lib/api.ts';
import type { IssueListItem, OverviewResponse } from '../lib/contract.ts';
import {
  EMPTY,
  formatCount,
  formatDuration,
  formatRelativeTime,
  formatTimeCell,
  formatUsd,
} from '../lib/format.ts';
import { useAudit, useIssuesInfinite, useOverview, useTasks } from '../lib/queries.ts';
import {
  readLastRepo,
  repoGitHubUrl,
  repoIssuePath,
  repoIssuesPath,
  repoRunPath,
  repoSettingsPath,
  repoWorkspacePath,
  repoSkillsPath,
} from '../lib/repo-route.ts';
import { useRepoDirectory } from '../lib/repos.ts';
import { cn } from '../lib/utils.ts';

/**
 * 全局工作台（`/`）—— 数据源 `/api/overview`（10s）+ 各区块自己的列表接口。
 *
 * 页面顺序就是**问题的顺序**（见 `apps/panel/DESIGN.md` §0）：
 *
 *  ① 需要你处理：失败 > 超时/停滞 > 待人回答 > 配置非法，每条是一个对象行，
 *     带原因、相对时间与就地动作；空态是一句事实 + 一个可行动作；
 *  ② 最近活动：`/api/audit` 的连续时间轴，按天分组；
 *  ③ 仓库：对象列表（不是卡片网格），一行一个仓库；
 *  ④ 趋势：全页唯一的图，一张多序列折线 + 24h/7d 切换，图例可点隐藏；
 *  ⑤ 快捷：次级动作条，无接口的动作**禁用并写明原因**。
 *
 * 五态统一走 `AsyncSection`（`overview-loading/error/empty/content`）；②③ 各自的失败只影响自己那块。
 * 只读红线：整页没有任何写请求（「暂停全部」等缺接口的动作只画禁用按钮）。
 */
const DAY_MS = 86_400_000;

/** 待办队列最多显示 8 行（再多就不是「扫一眼」而是「读日志」）。 */
const TODO_LIMIT = 8;

/** 时间窗（趋势区唯一的多余参数，落在 URL 上以便刷新恢复）。 */
type TrendWindow = '24h' | '7d';

const TREND_WINDOW_OPTIONS = [
  { value: '24h' as const, label: '24h' },
  { value: '7d' as const, label: '7d' },
];

export function OverviewPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const trendWindow: TrendWindow = searchParams.get('window') === '7d' ? '7d' : '24h';

  const query = useMemo(
    () =>
      trendWindow === '24h'
        ? {}
        : {
            from: new Date(Date.now() - 7 * DAY_MS).toISOString(),
            to: new Date().toISOString(),
          },
    [trendWindow],
  );

  const { data, error, isLoading, isFetching, refetch } = useOverview(query);

  // 空态：窗口内既没有投递也没有任务（服务刚启动），此时率与分位数都是 null
  const isEmpty =
    data !== undefined &&
    data.today.deliveries === 0 &&
    data.today.tasks === 0 &&
    data.trend.every((point) => point.tasks === 0);

  const setTrendWindow = (next: TrendWindow): void => {
    const params = new URLSearchParams(searchParams);
    if (next === '24h') params.delete('window');
    else params.set('window', next);
    setSearchParams(params, { replace: true });
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader
        title="工作台"
        updatedAt={
          data === undefined ? undefined : formatRelativeTime(data.generatedAt)
        }
        actions={
          <Button
            variant="secondary"
            size="sm"
            loading={isFetching && !isLoading}
            onClick={() => {
              void refetch();
            }}
            data-testid="overview-refresh"
          >
            刷新
          </Button>
        }
      />

      <AsyncSection
        isLoading={isLoading}
        error={error}
        isEmpty={isEmpty}
        emptyText="还没有任何数据：最近 24 小时没有 webhook 投递，也没有任务"
        emptyAction={
          <Link className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'mt-1')} to="/system">
            去系统页确认安装
          </Link>
        }
        onRetry={() => {
          void refetch();
        }}
        skeletonRows={6}
        testId="overview"
      >
        {data === undefined ? null : (
          <div className="flex min-w-0 flex-col gap-5">
            <TodoSection overview={data} />
            <ActivitySection />
            <ReposSection queueDepth={data.queue.depth} queueActive={data.queue.active} oldestQueuedMs={data.queue.oldestQueuedMs} />
            <TrendSection overview={data} trendWindow={trendWindow} onWindowChange={setTrendWindow} />
            <QuickSection overview={data} />
          </div>
        )}
      </AsyncSection>
    </div>
  );
}

/* ── ① 需要你处理 ─────────────────────────────────────────────────────────── */

type TodoAction = {
  label: string;
  /** 有 `to` 就是内部链接，有 `href` 就是外链。 */
  to?: string;
  href?: string;
  /** 无接口的动作：禁用 + 这句原因。 */
  disabledReason?: string;
};

/**
 * 一条待办 = **一行**。
 *
 * 版面（D4）：`状态点 · 对象 · 原因徽章 · 耗时 · 相对时间`，左对齐紧凑排布；
 * 整行是链接（Enter / 点击任意位置进详情），行内动作只在 hover / focus 时出现。
 * 为什么不再两行：两行结构在 1851 宽下会在中间留出 300px 空白，
 * 每条行高 49px，8 条就是 400px —— 超过一屏的一半，而这一区的用途是"扫一眼有没有事"。
 */
type TodoItem = {
  key: string;
  /** 排序键：0 失败 / 1 超时·停滞 / 2 待人回答 / 3 配置非法。 */
  rank: number;
  tone: Tone;
  /** 对象主段：`pr#16` / `issue#17` / `owner/name`（等宽，不截断）。 */
  target: string;
  /** 对象中段：命令或 issue 标题（可截断）；`null` = 没有这一段。 */
  subject: string | null;
  /** 对象尾段：`owner/name`；`null` = 主段已经是仓库名。 */
  repo: string | null;
  /** 原因徽章：短到能放进一行（≤ 8 字）。 */
  reason: string;
  /** 原因全文：进行 `title`（可核对的事实，含失败类、时长、检查项）。 */
  detail: string;
  /** 耗时（`null` = 这一类没有这个量）。 */
  durationMs: number | null;
  /** 相对时间用的时间戳（`null` = 没有时间可比）。 */
  at: string | null;
  /** 行主链接：整行 / Enter 都进这里。 */
  to: string;
  actions: TodoAction[];
};

const RERUN_DISABLED = '缺少写接口：POST /api/tasks/:id/rerun 尚未实现，面板不会假装发出请求';

function TodoSection({ overview }: { overview: OverviewResponse }) {
  const directory = useRepoDirectory();
  const failed = useTasks({ status: 'failed', limit: 8 });
  const awaiting = useIssuesInfinite({ awaiting: 'true', limit: 8 });
  const running = useIssuesInfinite({ status: 'running', limit: 8 });
  const now = Date.now();

  const invalidRepos = directory.repos.filter((repo) => repo.settingsValid === false && repo.archivedAt === null);
  const failedTasks = failed.data?.items ?? [];
  const awaitingIssues = awaiting.data?.pages.flatMap((page) => page.issues) ?? [];
  const stalledIssues = (running.data?.pages.flatMap((page) => page.issues) ?? []).filter(
    (issue) => isStalledIssue(issue, now),
  );

  const items: TodoItem[] = [];

  for (const task of failedTasks) {
    const failure = task.failureClass ?? '失败（没有 failureClass）';
    const took = task.endedAt === null ? null : formatDuration(task.durationMs);
    items.push({
      key: `task-${task.id}`,
      rank: task.failureClass === 'timeout' ? 1 : 0,
      tone: task.failureClass === 'timeout' ? 'warn' : 'danger',
      target: `${task.targetKind}#${formatCount(task.targetNumber)}`,
      subject: task.command,
      repo: task.repo,
      reason: failure,
      detail: `${failure}${took === null ? '' : ` · 耗时 ${took}`}`,
      durationMs: took === null ? null : task.durationMs,
      at: task.endedAt ?? task.queuedAt,
      to: repoRunPath(task.repo, task.id),
      actions: [
        { label: '看详情', to: repoRunPath(task.repo, task.id) },
        { label: '重跑', disabledReason: RERUN_DISABLED },
        ...(repoGitHubUrl(task.repo) === null ? [] : [{ label: '打开 GitHub', href: repoGitHubUrl(task.repo) ?? '' }]),
      ],
    });
  }

  for (const issue of stalledIssues) {
    const idle = formatDuration(now - Date.parse(issue.lastActivityAt));
    items.push(
      issueTodo(issue, {
        rank: 1,
        tone: 'warn',
        reason: `停滞 ${idle}`,
        detail: `进行中但 ${idle}没有新活动（run 可能已崩）`,
      }),
    );
  }

  for (const issue of awaitingIssues) {
    items.push(
      issueTodo(issue, {
        rank: 2,
        tone: 'warn',
        reason: '待人回答',
        detail:
          issue.lastActorLogin === null
            ? '最后说话的是人，机器人还没回'
            : `${issue.lastActorLogin} 最后发言，机器人还没回`,
      }),
    );
  }

  for (const repo of invalidRepos) {
    items.push({
      key: `repo-${repo.repo}`,
      rank: 3,
      tone: 'danger',
      target: repo.repo,
      subject: null,
      repo: null,
      reason: '配置非法',
      detail:
        repo.settingsError === null
          ? '配置未通过 schema 校验，该仓库不会被调度'
          : `配置非法：${repo.settingsError}`,
      durationMs: null,
      at: repo.lastActivityAt,
      to: repoSettingsPath(repo.repo),
      actions: [
        { label: '去修配置', to: repoSettingsPath(repo.repo) },
        ...(repoGitHubUrl(repo.repo) === null ? [] : [{ label: '打开 GitHub', href: repoGitHubUrl(repo.repo) ?? '' }]),
      ],
    });
  }

  items.sort((left, right) => {
    if (left.rank !== right.rank) return left.rank - right.rank;
    const leftAt = left.at === null ? 0 : Date.parse(left.at);
    const rightAt = right.at === null ? 0 : Date.parse(right.at);
    return rightAt - leftAt;
  });

  const shown = items.slice(0, TODO_LIMIT);
  const hidden = items.length - shown.length;
  const doctorNeedsAttention = overview.doctor.status === 'warn' || overview.doctor.status === 'fail';
  const paused = overview.queue.pausedUntil;

  const loading = failed.isLoading || awaiting.isLoading || running.isLoading || directory.isLoading;
  const loadError = failed.error ?? awaiting.error ?? running.error ?? directory.error;

  return (
    <Section
      first
      title="需要你处理"
      count={items.length === 0 ? undefined : items.length}
      actions={
        items.length === 0 ? (
          <Badge tone="success" dot>
            没有待办
          </Badge>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-2">
        {/* 两条全局提示各占一行（高 24px），不再是整块 Alert：它们只说明"为什么现在的数字长这样" */}
        {paused === null && !doctorNeedsAttention ? null : (
          <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1">
            {paused === null ? null : (
              <TodoNotice
                testId="overview-paused"
                tone="warn"
                label="全局 429 熔断中"
                detail={`解除 ${formatTimeCell(paused).title} · 熔断期间新事件只入队，不占并发`}
                to="/system"
                linkLabel="系统页"
              />
            )}
            {doctorNeedsAttention ? (
              <TodoNotice
                testId="overview-doctor"
                tone="warn"
                label={`doctor ${DOCTOR_LABEL[overview.doctor.status] ?? overview.doctor.status}`}
                detail={`最近体检 ${formatTimeCell(overview.doctor.checkedAt).title}${
                  overview.doctor.failedChecks.length === 0
                    ? ' · 没有未通过的检查项'
                    : ` · 未通过项：${overview.doctor.failedChecks.join('、')}`
                }`}
                to="/system"
                linkLabel="系统页"
              />
            ) : null}
          </div>
        )}

        <AsyncSection
          isLoading={loading}
          error={loadError}
          isEmpty={items.length === 0}
          emptyText="当前没有需要你处理的事"
          emptyAction={
            <Link
              className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'mt-1')}
              to={recentRunsPath(directory.repos[0]?.repo)}
              data-testid="home-todo-empty-action"
            >
              去看最近的运行
            </Link>
          }
          skeletonRows={4}
          testId="home-todo"
        >
          <ul className="flex min-w-0 flex-col" data-testid="home-todo-list">
            {shown.map((item, index) => (
              <TodoRow
                key={item.key}
                item={item}
                index={index}
                testId={`home-todo-${item.key}`}
              />
            ))}
          </ul>
          {hidden === 0 ? null : (
            <div className="mt-1.5 flex items-center gap-2">
              <Link className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" to="/audit">
                {`查看全部 ${formatCount(items.length)} 项`}
              </Link>
            </div>
          )}
        </AsyncSection>
      </div>
    </Section>
  );
}

/**
 * 全局提示（熔断 / doctor）：一行 24px。
 *
 * 口径细节（解除时间、未通过的检查项）留在 `title` 与可见的尾段里，不再堆 `AlertTitle + AlertDescription`：
 * 这两条信息都在「系统」页有完整版本，总览只需要"有这么回事 + 去哪里"。
 */
function TodoNotice({
  testId,
  tone,
  label,
  detail,
  to,
  linkLabel,
}: {
  testId: string;
  tone: Tone;
  label: string;
  detail: string;
  to: string;
  linkLabel: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn('flex h-6 min-w-0 items-center gap-1.5 text-xs', TONE_TEXT[tone])}
    >
      <StatusDot tone={tone} />
      <span className="shrink-0 font-medium">{label}</span>
      <span aria-hidden className="shrink-0 text-faint">
        ·
      </span>
      <span className="min-w-0 truncate" title={detail}>
        {detail}
      </span>
      <Link className="shrink-0 underline underline-offset-2 hover:text-foreground" to={to}>
        {linkLabel}
      </Link>
    </div>
  );
}

/** issue → 待办行（停滞 / 待人回答共用）。 */
function issueTodo(
  issue: IssueListItem,
  extra: { rank: number; tone: Tone; reason: string; detail: string },
): TodoItem {
  const number = formatCount(issue.number);
  return {
    key: `issue-${issue.repo}-${issue.kind}-${String(issue.number)}`,
    rank: extra.rank,
    tone: extra.tone,
    target: `${issue.kind}#${number}`,
    subject: issue.title ?? '（取不到标题）',
    repo: issue.repo,
    reason: extra.reason,
    detail: extra.detail,
    durationMs: null,
    at: issue.lastActivityAt,
    to: repoIssuePath(issue.repo, issue.kind, issue.number),
    actions: [
      { label: '看会话', to: repoIssuePath(issue.repo, issue.kind, issue.number) },
      ...(issue.url === null
        ? []
        : [{ label: issue.awaitingReply ? '去 GitHub 回复' : '打开 GitHub', href: issue.url }]),
    ],
  };
}

/**
 * 待办行：**单行 32px**。
 *
 * - 整行是链接（`after:absolute inset-0` 铺满），Enter / 点击空白都进详情；
 * - 动作条绝对定位在右端，`opacity-0` → `group-hover / group-focus-within` 显现：
 *   默认不占视觉空间（原来三个按钮常驻，1851 宽下中间留出 300px 空白），
 *   但仍在 Tab 序里，键盘 Tab 到它时 `focus-within` 让它出现（不是 `hidden`，否则不可达）；
 * - 行高固定 32px + hairline 分隔，长内容靠 `min-w-0 truncate` 收，不做溢出裁剪。
 */
function TodoRow({ item, index, testId }: { item: TodoItem; index: number; testId: string }) {
  const time = formatTimeCell(item.at);
  // `title` 只补行内看不到的量（绝对时间 + 原因全文），不重复已经可见的段落
  const rowTitle = [
    item.subject === null ? item.target : `${item.target} · ${item.subject}`,
    item.repo,
    item.detail,
    item.at === null ? '时间未知' : time.title,
  ]
    .filter((part) => part !== null)
    .join(' · ');

  return (
    <li
      data-testid={testId}
      className={cn(
        'group relative flex h-8 min-w-0 items-center gap-1.5 border-b border-l-2 border-border pr-1 pl-2 last:border-b-0',
        'transition-[background-color] duration-[120ms] ease-out-quint hover:bg-muted focus-within:bg-muted',
        TONE_BORDER[item.tone],
        index < TODO_LIMIT ? 'stagger-row' : '',
      )}
      style={index < TODO_LIMIT ? { animationDelay: `${String(index * 24)}ms` } : undefined}
    >
      <StatusDot tone={item.tone} label={item.reason} />

      <Link
        to={item.to}
        title={rowTitle}
        className="flex min-w-0 flex-1 items-center gap-1.5 after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand"
      >
        <span className="shrink-0 font-mono text-xs text-foreground">{item.target}</span>
        {item.subject === null ? null : (
          <>
            <span aria-hidden className="shrink-0 text-2xs text-faint">
              ·
            </span>
            <span className="min-w-0 truncate text-sm text-foreground">{item.subject}</span>
          </>
        )}
        {item.repo === null ? null : (
          <>
            <span aria-hidden className="shrink-0 text-2xs text-faint">
              ·
            </span>
            <span className="shrink-0 font-mono text-2xs text-muted-foreground">{item.repo}</span>
          </>
        )}
        <span aria-hidden className="shrink-0 text-2xs text-faint">
          ·
        </span>
        <Badge tone={item.tone} title={item.detail}>
          {item.reason}
        </Badge>
        {item.durationMs === null ? null : (
          <>
            <span aria-hidden className="shrink-0 text-2xs text-faint">
              ·
            </span>
            <span className="shrink-0 tabular text-2xs text-faint">{`耗时 ${formatDuration(item.durationMs)}`}</span>
          </>
        )}
        <span aria-hidden className="shrink-0 text-2xs text-faint">
          ·
        </span>
        <time
          className="shrink-0 tabular text-2xs text-faint"
          dateTime={item.at ?? undefined}
          title={time.title}
        >
          {item.at === null ? '时间未知' : time.text}
        </time>
      </Link>

      <span className="absolute top-1/2 right-1 z-10 flex -translate-y-1/2 items-center gap-0.5 rounded-sm bg-muted pl-1.5 opacity-0 transition-opacity duration-[120ms] ease-out-quint group-focus-within:opacity-100 group-hover:opacity-100">
        {item.actions.map((action) =>
          action.disabledReason === undefined ? (
            action.to !== undefined ? (
              <Link key={action.label} className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))} to={action.to}>
                {action.label}
              </Link>
            ) : (
              <a
                key={action.label}
                className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
                href={action.href ?? '#'}
                target="_blank"
                rel="noreferrer"
              >
                {action.label}
              </a>
            )
          ) : (
            <Button
              key={action.label}
              variant="ghost"
              size="sm"
              disabled
              title={action.disabledReason}
              data-testid={`${testId}-${action.label === '重跑' ? 'rerun' : 'disabled'}`}
            >
              {action.label}
            </Button>
          ),
        )}
      </span>
    </li>
  );
}
/**
 * 「最近的运行」落在哪个仓库：上次打开的仓库 > 清单里的第一个仓库 > 审计页。
 * （页面外的 localStorage 只在 `lib/repo-route.ts` 里读写。）
 */
function recentRunsPath(fallbackRepo?: string): string {
  const remembered = readLastRepo() ?? fallbackRepo ?? null;
  return remembered === null ? '/audit' : `${repoWorkspacePath(remembered)}/runs`;
}
/* ── ② 最近活动 ──────────────────────────────────────────────────────────── */

/** 时间轴最多显示这么多行。 */
const TIMELINE_ROWS = 10;

function ActivitySection() {
  const { data, error, isLoading, refetch } = useAudit({ limit: 20 });
  const rows = data?.items ?? [];
  // 技能只属于项目：知道上次打开的项目才给「看技能」的落点，否则不给空态动作
  const lastRepo = readLastRepo();

  return (
    <Section
      title="最近活动"
      actions={
        <Link className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" to="/audit">
          完整记录
        </Link>
      }
    >
      <AsyncSection
        testId="home-timeline"
        isLoading={isLoading}
        error={error}
        isEmpty={rows.length === 0}
        emptyText="还没有任何动作记录"
        emptyAction={
          lastRepo === null ? undefined : (
            <Link
              className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'mt-1')}
              to={repoSkillsPath(lastRepo)}
            >
              看这个项目装了哪些技能
            </Link>
          )
        }
        onRetry={() => {
          void refetch();
        }}
        skeletonRows={5}
      >
        <EventTimeline rows={rows.slice(0, TIMELINE_ROWS)} testId="home-timeline-list" />
      </AsyncSection>
    </Section>
  );
}

/* ── ③ 仓库（对象列表） ───────────────────────────────────────────────────── */

function ReposSection({
  queueDepth,
  queueActive,
  oldestQueuedMs,
}: {
  queueDepth: number;
  queueActive: number;
  oldestQueuedMs: number | null;
}) {
  const { repos, isLoading, error, isEmpty, source, refetch } = useRepoDirectory();

  return (
    <Section
      title="仓库"
      description={
        <span title="队列是全局口径：契约没有按仓库拆分的队列数据">
          {`队列 ${formatCount(queueDepth)} 待处理 / ${formatCount(queueActive)} 执行中 · 最老等待 ${formatDuration(oldestQueuedMs)}`}
        </span>
      }
      actions={
        <Link className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" to="/system">
          管理
        </Link>
      }
      footnote={source === 'system' ? '仓库清单来自降级路径 /api/system（/api/repos 不可用）' : undefined}
    >
      <AsyncSection
        testId="home-repos"
        isLoading={isLoading}
        error={error}
        isEmpty={isEmpty}
        emptyText="还没有任何仓库"
        emptyAction={
          <Link className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'mt-1')} to="/system">
            去系统页
          </Link>
        }
        onRetry={refetch}
        skeletonRows={4}
      >
        <ul className="flex min-w-0 flex-col" data-testid="home-repos-list">
          {repos.map((repo) => {
            const tone: Tone = repo.settingsValid === false
              ? 'danger'
              : repo.archivedAt !== null || !repo.enabled
                ? 'neutral'
                : repo.dryRun
                  ? 'warn'
                  : 'success';
            return (
              <li key={repo.repo} data-testid={`home-repo-${repo.repo}`} className="min-w-0">
                <Link
                  to={repoWorkspacePath(repo.repo)}
                  className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border py-1.5 transition-[background-color] duration-[120ms] ease-out-quint last:border-0 hover:bg-muted"
                >
                  <StatusDot tone={tone} label={REPO_TONE_LABEL[tone]} />
                  <span className="min-w-0 flex-1 basis-[14rem] truncate font-mono text-sm text-foreground" title={repo.repo}>
                    {repo.repo}
                  </span>
                  <span className="flex shrink-0 flex-wrap items-center gap-1">
                    {repo.archivedAt === null ? null : <Badge tone="neutral">已归档</Badge>}
                    {repo.enabled ? <Badge tone="success">启用</Badge> : <Badge tone="neutral">停用</Badge>}
                    {repo.dryRun ? <Badge tone="warn">dry-run</Badge> : null}
                    {repo.settingsValid ? null : (
                      <Badge tone="danger" title={repo.settingsError ?? '配置未通过 schema 校验'}>
                        配置非法
                      </Badge>
                    )}
                  </span>
                  <span className="shrink-0 text-2xs tabular text-faint">
                    {repo.lastActivityAt === null ? '从未活动' : `最近活动 ${formatRelativeTime(repo.lastActivityAt)}`}
                  </span>
                  <span aria-hidden className="shrink-0 text-faint">
                    →
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </AsyncSection>
    </Section>
  );
}

const REPO_TONE_LABEL: Record<Tone, string> = {
  success: '启用且真写',
  warn: '启用但 dry-run',
  danger: '配置非法',
  info: '信息',
  neutral: '停用或归档',
  brand: '当前',
};

/* ── ④ 趋势（全页唯一的图） ────────────────────────────────────────────────── */

type TrendSeriesKey = 'tasks' | 'succeeded' | 'failed';

const TREND_SERIES: readonly { key: TrendSeriesKey; label: string; color: string }[] = [
  { key: 'tasks', label: '任务', color: 'var(--chart-1)' },
  { key: 'succeeded', label: '成功', color: 'var(--chart-2)' },
  { key: 'failed', label: '失败', color: 'var(--chart-4)' },
];

function TrendSection({
  overview,
  trendWindow,
  onWindowChange,
}: {
  overview: OverviewResponse;
  trendWindow: TrendWindow;
  onWindowChange: (next: TrendWindow) => void;
}) {
  const [hidden, setHidden] = useState<readonly TrendSeriesKey[]>([]);
  const points = overview.trend;
  const totalTasks = overview.today.tasks;

  const toggle = (key: TrendSeriesKey): void => {
    setHidden((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );
  };

  return (
    <Section
      title="趋势"
      description={`今日 ${formatCount(totalTasks)} 个任务 · 成功率 ${
        overview.today.successRate === null ? EMPTY : `${String(Math.round(overview.today.successRate * 100))}%`
      } · 成本 ${formatUsd(overview.today.costUsd)} · p50/p95 ${formatDuration(overview.today.p50Ms)} / ${formatDuration(overview.today.p95Ms)}`}
      actions={
        <Segmented
          label="趋势时间窗"
          options={TREND_WINDOW_OPTIONS}
          value={trendWindow}
          onChange={onWindowChange}
        />
      }
      footnote={
        trendWindow === '7d'
          ? '7d 窗口最多 48 个点，粒度由服务端决定（横轴按返回值画）。'
          : `窗口 ${formatTimeCell(overview.window.from).title} — ${formatTimeCell(overview.window.to).title}`
      }
    >
      {points.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-8 text-xs text-muted-foreground">
          窗口内没有趋势数据（服务端没返回 trend 点）
        </p>
      ) : (
        <div className="flex min-w-0 flex-col gap-1.5">
          {/* 图例可点隐藏：点一次去掉一条线，再点回来（按钮有 aria-pressed） */}
          <div className="flex flex-wrap items-center gap-1" data-testid="home-trend-legend">
            {TREND_SERIES.map((series) => {
              const off = hidden.includes(series.key);
              return (
                <button
                  key={series.key}
                  type="button"
                  aria-pressed={!off}
                  onClick={() => {
                    toggle(series.key);
                  }}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-xs',
                    'transition-[background-color,color,opacity] duration-[120ms] ease-out-quint hover:bg-muted',
                    off ? 'opacity-45' : 'opacity-100',
                  )}
                >
                  <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: series.color }} />
                  <span className={off ? 'text-faint line-through' : 'text-muted-foreground'}>{series.label}</span>
                </button>
              );
            })}
          </div>

          <div className="min-w-0" data-testid="home-trend-chart">
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="at"
                  tickFormatter={(value: string) => (trendWindow === '24h' ? value.slice(11, 16) : value.slice(5, 10))}
                  stroke="var(--border-strong)"
                  tick={{ fill: 'var(--faint-foreground)', fontSize: 10 }}
                  tickLine={false}
                  minTickGap={28}
                />
                <YAxis
                  stroke="var(--border-strong)"
                  tick={{ fill: 'var(--faint-foreground)', fontSize: 10 }}
                  tickLine={false}
                  allowDecimals={false}
                  width={36}
                />
                <Tooltip
                  contentStyle={{
                    fontSize: 12,
                    background: 'var(--card)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                  }}
                  labelFormatter={(value) => String(value).slice(0, 16).replace('T', ' ')}
                />
                {TREND_SERIES.map((series) => (
                  <Line
                    key={series.key}
                    type="monotone"
                    dataKey={series.key}
                    name={series.label}
                    hide={hidden.includes(series.key)}
                    stroke={series.color}
                    strokeWidth={1.75}
                    dot={false}
                    activeDot={{ r: 3 }}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </Section>
  );
}

/* ── ⑤ 快捷（次级动作条） ─────────────────────────────────────────────────── */

function QuickSection({ overview }: { overview: OverviewResponse }) {
  const { repos } = useRepoDirectory();
  const targetRepo = readLastRepo() ?? repos[0]?.repo ?? null;
  const githubUrl = targetRepo === null ? null : repoGitHubUrl(targetRepo);

  return (
    <Section
      title="快捷"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="home-actions">
        <Button
          variant="secondary"
          size="sm"
          disabled
          title="缺少写接口：POST /api/flags（暂停全部）尚未实现"
          data-testid="home-action-pause"
        >
          {overview.queue.pausedUntil === null ? '暂停全部' : '已全局熔断'}
        </Button>

        <a
          className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}
          href={api.auditCsvUrl({})}
          download
          data-testid="home-action-export"
        >
          导出审计 CSV
        </a>

        {githubUrl === null ? (
          <Button variant="secondary" size="sm" disabled title="先在左栏选择一个仓库">
            打开 GitHub
          </Button>
        ) : (
          <a
            className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}
            href={githubUrl}
            target="_blank"
            rel="noreferrer"
            data-testid="home-action-github"
            title={targetRepo ?? undefined}
          >
            {`打开 ${targetRepo ?? 'GitHub'}`}
          </a>
        )}

        <Link
          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
          to={recentRunsPath(targetRepo ?? undefined)}
        >
          最近的运行
        </Link>
        {targetRepo === null ? null : (
          <Link
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
            to={repoSkillsPath(targetRepo)}
          >
            本项目技能
          </Link>
        )}
        <Link className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))} to="/system">
          系统与仓库
        </Link>
        {targetRepo === null ? null : (
          <Link
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
            to={repoIssuesPath(targetRepo)}
          >
            当前仓库的 Issue
          </Link>
        )}
      </div>
    </Section>
  );
}

/** doctor 状态的展示文案（`/api/overview` 与 `/api/system` 共用同一套枚举）。 */
const DOCTOR_LABEL: Record<string, string> = {
  ok: '通过',
  warn: '有告警',
  fail: '未通过',
  unknown: '状态未知',
  'not-run': '还没跑过',
};
