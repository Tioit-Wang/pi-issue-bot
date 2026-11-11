import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { AsyncSection } from '../components/AsyncSection.tsx';
import {
  readFeedbackTimeline,
  readLabelDecision,
  readReactionState,
  readRunCost,
} from '../components/issues/contract-extras.ts';
import { ReactionChip, reactionHint } from '../components/issues/reaction-chip.tsx';
import { ISSUE_STATE_LABEL, ISSUE_STATE_TONE } from '../components/issues/status.ts';
import { PageHeader } from '../components/PageHeader.tsx';
import { Section } from '../components/Section.tsx';
import { Badge, StatusDot } from '../components/ui/badge.tsx';
import { Button, buttonVariants } from '../components/ui/button.tsx';
import { useToast } from '../components/ui/toast.tsx';
import type { IssueKind, IssueSessionResponse, IssueTurn } from '../lib/contract.ts';
import {
  EMPTY,
  formatCount,
  formatDuration,
  formatRelativeTime,
  formatTimeCell,
  formatUsd,
} from '../lib/format.ts';
import { useIssueSession } from '../lib/queries.ts';
import { decodeRepo, repoIssuePath, repoIssuesPath, repoRunPath, useRepoRoute } from '../lib/repo-route.ts';
import { cn } from '../lib/utils.ts';
import { NotFoundPage } from './not-found.tsx';
import { repoCrumbs } from './RepoPageFrame.tsx';

/**
 * Issue 详情（`/repos/:repo/issues/:kind/:number`）—— 回答**「这个 issue 被处理成什么样了」**。
 *
 * 自动通道零评论（无感反馈），结论、标签理由、缺项清单、reaction 台账都只能在这里看到，
 * 所以结构就是问题的顺序（左主栏 → 右侧栏）：
 *
 *  左：① 结论正文（未发布到 GitHub 时显式标注，长文折叠，代码块等宽）
 *      ② 标签与理由（打了什么 + 为什么 + 想打没打上的）
 *      ③ 缺哪些信息（来自 `label_decisions.reason` 的展示层切分）
 *      ④ run 时间线与成本（逐轮：时间 / 环节 / 状态 / 耗时 / 成本 / 任务）
 *      ⑤ 对话记录（逐轮正文与工具调用；纯文本渲染，不解析 Markdown/HTML）
 *  右：元信息（编号 / 状态 / 最后活动 / 计数）· 参与者 · reaction 台账 · 成本汇总
 *
 * **不套卡片**：主栏与右侧栏都用 `Section` + hairline 分隔（DESIGN §6.1）。
 * 就地操作：复制链接 / 复制正文 / 重跑（写接口未落地 → 禁用 + `title`）/ 打开 GitHub。
 * 404 走 `useIssueSession` 的 `null` 约定（没有 tasks 行是正常业务态）→ 空态而非错误态。
 */
export function IssueDetailPage() {
  const params = useParams();
  // 新路径 `/repos/:repo/issues/:kind/:number`（`:repo = owner__name`）；
  // 旧路径 `/issues/:owner/:name/:kind/:number` 只作为重定向入口（见 `routes/legacy.tsx`）。
  const repoParam = params['repo'] ?? '';
  const decoded = repoParam === '' ? null : decodeRepo(repoParam);
  const slash = decoded === null ? -1 : decoded.indexOf('/');
  const owner = decoded === null ? (params['owner'] ?? '') : decoded.slice(0, slash);
  const name = decoded === null ? (params['name'] ?? '') : decoded.slice(slash + 1);
  const kind: IssueKind = params['kind'] === 'pr' ? 'pr' : 'issue';
  const number = Number(params['number'] ?? '');

  if (owner === '' || name === '' || !Number.isInteger(number) || number <= 0) {
    return <NotFoundPage />;
  }

  return <IssueSession owner={owner} name={name} kind={kind} number={number} />;
}

/** 触发渠道：只有人类轮有 `channel`（spec §3.2 的 `mention|command|auto`）。 */
const CHANNEL_LABEL: Record<'mention' | 'command' | 'auto', string> = {
  mention: '被 @',
  command: '命令',
  auto: '自动',
};

function IssueSession({
  owner,
  name,
  kind,
  number,
}: {
  owner: string;
  name: string;
  kind: IssueKind;
  number: number;
}) {
  const { repo } = useRepoRoute();
  const { data, error, isLoading, refetch } = useIssueSession({ owner, name, kind, number });
  const toast = useToast();

  // 404：hook 把 404 规约成 null，所以「不是错误 + 没有数据」= 这个 issue 没有会话
  const missing = !isLoading && error === null && data === null;
  const turns = data?.turns ?? [];
  const isEmpty = missing || turns.length === 0;
  const issue = data?.issue ?? null;

  const copy = (text: string, title: string): void => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        toast.push({ tone: 'success', title });
      })
      .catch(() => {
        toast.push({ tone: 'danger', title: '复制失败', description: '浏览器拒绝了剪贴板写入' });
      });
  };

  const pageHref = repoIssuePath(repo ?? `${owner}/${name}`, kind, number);
  const conclusionText = pickConclusion(turns)?.text ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader
        testId="issue-detail-header"
        breadcrumb={
          repo === null
            ? undefined
            : repoCrumbs(repo, [{ label: 'Issue 中心', to: repoIssuesPath(repo) }, { label: `${kind}#${String(number)}` }])
        }
        title={
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-mono text-sm text-muted-foreground">{`${kind}#${formatCount(number)}`}</span>
            <span className="min-w-0 break-words" data-testid="issue-detail-title">
              {issue?.title ?? '（标题取不到）'}
            </span>
          </span>
        }
        updatedAt={data === null || data === undefined ? undefined : formatRelativeTime(data.generatedAt)}
        badges={
          <>
            {issue === null ? null : (
              <>
                <Badge tone={ISSUE_STATE_TONE[issue.state]}>{ISSUE_STATE_LABEL[issue.state]}</Badge>
                {issue.stateStale ? (
                  <Badge tone="warn" title="状态不是来自投递事件（从 issue_states 推断），可能过期">
                    状态可能过期
                  </Badge>
                ) : null}
                <ReactionChip state={readReactionState(data ?? undefined)} />
                <span className="sr-only">{reactionHint(readReactionState(data ?? undefined))}</span>
              </>
            )}
          </>
        }
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={conclusionText === null}
              title={conclusionText === null ? '还没有机器人正文可复制' : '复制最后一次结论正文'}
              onClick={() => {
                if (conclusionText !== null) copy(conclusionText, '正文已复制');
              }}
              data-testid="issue-detail-copy-body"
            >
              复制正文
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                copy(`${window.location.origin}${pageHref}`, '链接已复制');
              }}
              data-testid="issue-detail-copy-link"
            >
              复制链接
            </Button>
            {issue?.url === null || issue === null ? null : (
              <a
                className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}
                href={issue.url}
                target="_blank"
                rel="noreferrer"
                data-testid="issue-detail-github"
              >
                打开 GitHub
              </a>
            )}
          </>
        }
      />

      <AsyncSection
        isLoading={isLoading}
        error={error}
        isEmpty={isEmpty}
        emptyText={
          missing
            ? '找不到这个会话：这个 issue 没有任何处理记录（或者链接里的仓库 / 编号拼错了）。'
            : '这个会话还没有任何轮次（任务可能刚入队）。'
        }
        emptyAction={
          <Link
            className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'mt-1')}
            to={repo === null ? '/audit' : repoIssuesPath(repo)}
          >
            {repo === null ? '去看审计记录' : '回到 Issue 中心'}
          </Link>
        }
        onRetry={() => {
          void refetch();
        }}
        skeletonRows={5}
        testId="issue-detail"
      >
        {data === null || data === undefined ? null : (
          <SessionBody
            data={data}
            onCopy={(text, title) => {
              copy(text, title);
            }}
          />
        )}
      </AsyncSection>
    </div>
  );
}

/** 结论正文：最后一轮**有正文**的机器人轮次（没有正文的失败轮不算结论）。 */
function pickConclusion(turns: readonly IssueTurn[]): IssueTurn | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn !== undefined && turn.role === 'bot' && turn.text !== null && turn.text !== '') return turn;
  }
  return null;
}

function SessionBody({ data, onCopy }: { data: IssueSessionResponse; onCopy: (text: string, title: string) => void }) {
  const { issue, turns } = data;
  const humanCount = turns.filter((turn) => turn.role === 'human').length;
  const botCount = turns.length - humanCount;
  const conclusion = pickConclusion(turns);
  const lastBot = [...turns].reverse().find((turn) => turn.role === 'bot') ?? null;
  const reaction = readReactionState(data);
  const feedback = readFeedbackTimeline(data);
  const decision = readLabelDecision(data);
  const runnableTaskId = [...turns].reverse().find((turn) => turn.taskId !== null)?.taskId ?? null;


  // 成本汇总：只累加**有值**的轮次，并把「有几轮没数据」说出来（不把缺失当 0）
  const costs = turns.map((turn) => readRunCost(turn));
  const knownCosts = costs.filter((cost) => cost.costUsd !== null);
  const totalCost = knownCosts.reduce((sum, cost) => sum + (cost.costUsd ?? 0), 0);
  const knownDurations = costs.filter((cost) => cost.durationMs !== null);
  const totalDuration = knownDurations.reduce((sum, cost) => sum + (cost.durationMs ?? 0), 0);

  return (
    <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_17rem]">
      {/* ── 左主栏 ─────────────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-col gap-5">
        <Section
          title="结论正文"
          actions={
            conclusion === null ? null : (
              <Badge
                tone={conclusion.commentId === null ? 'warn' : 'success'}
                title={
                  conclusion.commentId === null
                    ? '没有对应评论：dry-run 仓库或自动通道不写 GitHub，正文只在这里'
                    : undefined
                }
                data-testid="issue-detail-result-unpublished"
              >
                {conclusion.commentId === null ? '未发布到 GitHub' : '已发布评论'}
              </Badge>
            )
          }
        >
          <div data-testid="issue-detail-result">
            {conclusion === null ? (
              <p className="text-xs text-muted-foreground">
                {lastBot === null
                  ? '还没有机器人轮次（任务可能刚入队，或者只有人类发言）。'
                  : `最后一条机器人轮次没有正文${lastBot.failureClass === null ? '' : `（失败分类 ${lastBot.failureClass}）`}。`}
              </p>
            ) : (
              <div className="flex min-w-0 flex-col gap-2">
                <CollapsibleText text={conclusion.text ?? ''} testId="issue-detail-result-text" />
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-faint">
                  <time title={formatTimeCell(conclusion.at).title}>{formatTimeCell(conclusion.at).text}</time>
                  {conclusion.attempts > 1 ? <span>{`合并了 ${formatCount(conclusion.attempts)} 次 attempt`}</span> : null}
                  {conclusion.commentUrl === null ? null : (
                    <a className="underline underline-offset-2 hover:text-foreground" href={conclusion.commentUrl} target="_blank" rel="noreferrer">
                      在 GitHub 看这条评论
                    </a>
                  )}
                  <button
                    type="button"
                    className="underline underline-offset-2 hover:text-foreground"
                    onClick={() => {
                      onCopy(conclusion.text ?? '', '正文已复制');
                    }}
                  >
                    复制
                  </button>
                </div>
              </div>
            )}
          </div>
        </Section>

        <Section
          title="标签与理由"
          actions={
            decision === null || decision.lastAt === null ? null : (
              <span className="text-2xs text-faint" title={formatTimeCell(decision.lastAt).title}>
                {`最近判定 ${formatTimeCell(decision.lastAt).text}`}
              </span>
            )
          }
        >
          <div className="flex min-w-0 flex-col gap-2 text-xs" data-testid="issue-detail-label-decision">
            <div className="flex flex-wrap items-center gap-1">
              {issue.labels.length === 0 ? (
                <span className="text-muted-foreground">这个 issue 上没有机器人打的标签</span>
              ) : (
                issue.labels.map((label) => (
                  <Badge key={label} tone="neutral">
                    {label}
                  </Badge>
                ))
              )}
            </div>

            {decision?.reason === undefined || decision.reason === null ? (
              <p className="text-muted-foreground">没有记录理由（label_decisions 还没有这一轮）。</p>
            ) : (
              <p
                className="min-w-0 break-words whitespace-pre-wrap text-foreground/90"
                data-testid="issue-detail-labels-reason"
              >
                {decision.reason}
              </p>
            )}

            {decision === null || decision.blockedLabels.length === 0 ? null : (
              <p className="text-muted-foreground">
                想打但没打上：<span className="font-mono">{decision.blockedLabels.join('、')}</span>
              </p>
            )}

            {decision === null || decision.blocked.length === 0 ? null : (
              <ul
                className="flex min-w-0 flex-col gap-1 border-l-2 border-warn pl-2 text-warn-fg"
                data-testid="issue-detail-labels-blocked"
              >
                {decision.blocked.map((entry) => (
                  <li key={entry.reason} className="break-words">
                    {`没打上：${entry.reason}${entry.count > 1 ? `（${String(entry.count)} 次）` : ''}`}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Section>

        <Section
          title="缺哪些信息"
          footnote="来源 label_decisions.reason；不再在 GitHub 发「还缺这些信息」评论"
        >
          <div className="text-xs" data-testid="issue-detail-missing">
            {decision === null || decision.missing.length === 0 ? (
              <p className="text-muted-foreground">没有记录缺项 —— 这一轮不缺信息，或者还没跑过质检。</p>
            ) : (
              <ul className="flex list-disc flex-col gap-1 pl-4 text-foreground/90">
                {decision.missing.map((item) => (
                  <li key={item} className="break-words">
                    {item}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Section>

        <Section
          title="run 时间线与成本"
          description="「耗时 / 成本」为 — 表示接口未提供该字段（不等于 0）"
          actions={
            <span className="text-2xs tabular text-faint">{`${formatCount(turns.length)} 轮`}</span>
          }
        >
          <ol className="flex min-w-0 flex-col" data-testid="issue-detail-timeline">
            {turns.map((turn) => (
              <TimelineRow key={turn.id} turn={turn} />
            ))}
          </ol>
        </Section>

        <Section
          title="对话记录"
          description="正文按纯文本渲染，不解析 Markdown / HTML"
          actions={
            <span className="text-2xs tabular text-faint">{`人类 ${formatCount(humanCount)} · 机器人 ${formatCount(botCount)}`}</span>
          }
        >
          <ol className="flex min-w-0 flex-col" data-testid="issue-detail-turns">
            {turns.map((turn) => (
              <TurnItem key={turn.id} turn={turn} />
            ))}
          </ol>
        </Section>
      </div>

      {/* ── 右侧栏 ─────────────────────────────────────────────────────────── */}
      <aside className="flex min-w-0 flex-col gap-4 xl:border-l xl:border-border xl:pl-4">
        <Section title="元信息">
          <dl className="grid min-w-0 grid-cols-2 gap-x-2 gap-y-1.5 text-xs" data-testid="issue-detail-meta">
            <Field label="编号" value={`${issue.kind}#${formatCount(issue.number)}`} mono />
            <Field label="状态" value={ISSUE_STATE_LABEL[issue.state]} />
            <Field label="人类轮次" value={formatCount(humanCount)} />
            <Field label="机器人轮次" value={formatCount(botCount)} />
            <Field
              label="最后活动"
              value={turns.length === 0 ? EMPTY : formatTimeCell(turns[turns.length - 1]?.at ?? null).text}
            />
            <Field label="reaction" value={reaction === null ? EMPTY : reaction} />
          </dl>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              disabled
              title="缺少写接口：POST /api/tasks/:id/rerun 尚未实现，面板不会假装发出请求"
              aria-describedby="issue-detail-rerun-reason"
              data-testid="issue-detail-rerun-button"
            >
              重跑这一轮
            </Button>
            {runnableTaskId === null ? null : (
              <span className="font-mono text-2xs text-faint" title={runnableTaskId}>
                {`最近任务 ${runnableTaskId}`}
              </span>
            )}
          </div>
          {/* 禁用原因走 aria-describedby，不占正文行（D3 文案规则） */}
          <p id="issue-detail-rerun-reason" className="sr-only" data-testid="issue-detail-rerun">
            写接口未就绪（POST /api/tasks/:id/rerun 未实现）：重跑需要排队并走仓库并发与闸门。
          </p>
        </Section>

        <Section title="参与者">
          <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs" data-testid="issue-detail-participants">
            {issue.participants.length === 0 ? (
              <span className="text-muted-foreground">{EMPTY}</span>
            ) : (
              issue.participants.map((handle) => (
                <Badge key={handle} tone={handle.endsWith('[bot]') ? 'info' : 'neutral'}>
                  {handle}
                </Badge>
              ))
            )}
          </div>
        </Section>

        <Section title="reaction 台账" description={reactionHint(reaction)}>
          <div className="text-xs" data-testid="issue-detail-reaction">
            {feedback.length === 0 ? (
              <p className="text-muted-foreground">没有台账明细（issue_feedback 为空，或 dry-run 仓库只写 run_events）。</p>
            ) : (
              <ul className="flex min-w-0 flex-col gap-1" data-testid="issue-detail-feedback">
                {feedback.map((entry, index) => (
                  <li key={`${entry.stage}-${String(index)}`} className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <Badge tone={entry.stage === 'succeeded' ? 'success' : entry.stage === 'received' ? 'info' : 'danger'}>
                      {entry.stage}
                    </Badge>
                    <span className="font-mono text-muted-foreground">{entry.content ?? EMPTY}</span>
                    <span className="text-2xs text-faint">
                      {entry.appliedAt === null ? '未落地' : formatTimeCell(entry.appliedAt).text}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Section>

        <Section
          title="成本汇总"
          footnote={
            knownCosts.length === turns.length
              ? '全部轮次都有成本字段'
              : `${formatCount(turns.length - knownCosts.length)} / ${formatCount(turns.length)} 轮没有 costUsd（接口未提供，不当 0）`
          }
        >
          <dl className="grid min-w-0 grid-cols-2 gap-x-2 gap-y-1.5 text-xs" data-testid="issue-detail-cost">
            <Field label="合计成本" value={knownCosts.length === 0 ? EMPTY : formatUsd(totalCost)} />
            <Field label="已知轮次" value={`${formatCount(knownCosts.length)}/${formatCount(turns.length)}`} />
            <Field
              label="合计耗时"
              value={knownDurations.length === 0 ? EMPTY : formatDuration(totalDuration)}
            />
            <Field label="工具调用" value={formatCount(turns.reduce((sum, turn) => sum + turn.toolCalls.length, 0))} />
          </dl>
        </Section>
      </aside>
    </div>
  );
}

function Field({
  label,
  value,
  mono = false,
  title,
  danger = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  /** 悬停口径（默认用值本身，例如「没有这个字段」的原因）。 */
  title?: string;
  /** 超期/失败用 danger 色文字（不是整行染色）。 */
  danger?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-2xs text-faint">{label}</dt>
      <dd
        className={cn(
          'min-w-0 truncate tabular',
          danger ? 'font-medium text-danger-fg' : 'text-muted-foreground',
          mono && 'font-mono',
        )}
        title={title ?? value}
      >
        {value}
      </dd>
    </div>
  );
}

/** 折叠阈值：超过这个字符数才出现「展开全文」（短正文不制造无意义的点击）。 */
const COLLAPSE_THRESHOLD = 360;

/**
 * 长文本：默认折叠到 10 行 + 显式「展开全文 / 收起」；代码块（``` 围栏）用等宽渲染。
 *
 * 折叠是**显式控件**（不是用 `overflow-hidden` 把错位藏起来）：按钮文案说明还有多少字。
 */
function CollapsibleText({ text, testId }: { text: string; testId?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > COLLAPSE_THRESHOLD;
  const blocks = splitFences(text);

  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid={testId}>
      <div className={cn('flex min-w-0 flex-col gap-1.5', long && !open && 'max-h-56 overflow-hidden')}>
        {blocks.map((block, index) =>
          block.kind === 'code' ? (
            <pre
              key={`block-${String(index)}`}
              className="max-w-full overflow-x-auto rounded-md border border-border bg-muted/50 px-2 py-1.5 font-mono text-xs leading-relaxed text-foreground"
            >
              {block.text}
            </pre>
          ) : (
            <p
              key={`block-${String(index)}`}
              className="max-w-full break-words whitespace-pre-wrap text-sm leading-[1.65] text-foreground"
            >
              {block.text}
            </p>
          ),
        )}
      </div>
      {long ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen((current) => !current);
          }}
          className="w-fit text-xs text-muted-foreground underline underline-offset-2 transition-[color] duration-[120ms] hover:text-foreground"
          data-testid={testId === undefined ? undefined : `${testId}-toggle`}
        >
          {open ? '收起' : `展开全文（共 ${formatCount(text.length)} 字符）`}
        </button>
      ) : null}
    </div>
  );
}

/** 按 ``` 围栏切段：围栏内是代码块（等宽、可横向滚动），其余按纯文本。 */
function splitFences(text: string): { kind: 'text' | 'code'; text: string }[] {
  const parts = text.split(/```[a-zA-Z0-9_-]*\n?/);
  if (parts.length === 1) return [{ kind: 'text', text }];
  const blocks: { kind: 'text' | 'code'; text: string }[] = [];
  parts.forEach((part, index) => {
    // 奇数下标 = 围栏内部
    const kind = index % 2 === 1 ? 'code' : 'text';
    const trimmed = kind === 'code' ? part.replace(/\n$/, '') : part.trim();
    if (trimmed !== '') blocks.push({ kind, text: trimmed });
  });
  return blocks.length === 0 ? [{ kind: 'text', text }] : blocks;
}

/** run 时间线的一行：时间 / 环节 / 状态 / 耗时 / 成本 / 任务 / 工具调用。 */
function TimelineRow({ turn }: { turn: IssueTurn }) {
  const { repo } = useRepoRoute();
  const time = formatTimeCell(turn.at);
  const cost = readRunCost(turn);
  const taskHref = (taskId: string): string =>
    repo === null ? `/tasks/${encodeURIComponent(taskId)}` : repoRunPath(repo, taskId);

  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border py-1.5 text-xs last:border-0">
      <time className="w-[7.5rem] shrink-0 text-faint" title={time.title}>
        {time.text}
      </time>
      <span className="flex shrink-0 items-center gap-1">
        <Badge tone={turn.role === 'human' ? 'neutral' : 'info'}>{turn.role === 'human' ? '人类' : '机器人'}</Badge>
        {turn.channel === null ? null : <span className="text-2xs text-faint">{CHANNEL_LABEL[turn.channel]}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <StatusDot tone={turn.failureClass === null ? 'neutral' : 'danger'} />
        <span className="text-muted-foreground">{turn.status}</span>
        {turn.failureClass === null ? null : <Badge tone="danger">{turn.failureClass}</Badge>}
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={turn.text ?? undefined}>
        {turn.text === null || turn.text === '' ? '（没有正文）' : turn.text}
      </span>
      <span className="w-14 shrink-0 text-right tabular text-muted-foreground" title="耗时">
        {cost.durationMs === null ? <span title="接口未提供该字段">—</span> : formatDuration(cost.durationMs)}
      </span>
      <span className="w-16 shrink-0 text-right tabular text-muted-foreground" title="成本">
        {cost.costUsd === null ? <span title="接口未提供该字段">—</span> : formatUsd(cost.costUsd)}
      </span>
      <span className="w-20 shrink-0 font-mono text-2xs">
        {turn.taskId === null ? (
          <span className="text-faint">{EMPTY}</span>
        ) : (
          <Link className="underline underline-offset-2" to={taskHref(turn.taskId)}>
            {turn.taskId}
          </Link>
        )}
      </span>
    </li>
  );
}

/** 逐轮：人类右对齐气泡、机器人左对齐纯正文；工具调用默认收起。 */
function TurnItem({ turn }: { turn: IssueTurn }) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const isHuman = turn.role === 'human';
  const time = formatTimeCell(turn.at);

  return (
    <li className="flex min-w-0 flex-col gap-1 border-b border-border py-2.5 last:border-0" data-testid={`issue-detail-turn-${turn.role}`}>
      <header className="flex flex-wrap items-center gap-1.5 text-2xs text-faint">
        <span className="font-mono font-medium text-foreground/80">{turn.login ?? (isHuman ? '人类' : '机器人')}</span>
        {isHuman && turn.channel !== null ? <span>{CHANNEL_LABEL[turn.channel]}</span> : null}
        <span className="text-muted-foreground">{turn.status}</span>
        {turn.failureClass === null ? null : <span className="text-danger-fg">{turn.failureClass}</span>}
        <time title={time.title}>{time.text}</time>
      </header>

      <div className={isHuman ? 'flex min-w-0 justify-end' : 'flex min-w-0'}>
        <div
          className={
            isHuman
              ? 'flex w-max max-w-[min(82%,37.5rem)] flex-col gap-1 rounded-[18px] rounded-br-[4px] bg-foreground/[0.08] px-[15px] py-2'
              : 'flex min-w-0 w-full max-w-[45rem] flex-col gap-1'
          }
        >
          {turn.text === null || turn.text === '' ? (
            <p className="text-sm text-muted-foreground italic">（本轮没有正文）</p>
          ) : (
            <CollapsibleText text={turn.text} />
          )}

          {turn.labels.length === 0 ? null : (
            <div className="flex flex-wrap items-center gap-1" data-testid="issue-detail-turn-labels">
              {turn.labels.map((label) => (
                <Badge key={label} tone="neutral">
                  {label}
                </Badge>
              ))}
            </div>
          )}

          {turn.commentUrl === null ? null : (
            <a
              className="self-start text-2xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              href={turn.commentUrl}
              target="_blank"
              rel="noreferrer"
            >
              在 GitHub 看这条评论
            </a>
          )}

          {turn.toolCalls.length === 0 ? null : (
            <div className="flex min-w-0 flex-col gap-1">
              <button
                type="button"
                className="flex w-fit items-center gap-1.5 rounded-md px-1 py-0.5 text-2xs text-muted-foreground transition-[background-color,color] duration-[120ms] hover:bg-foreground/[0.04] hover:text-foreground"
                aria-expanded={toolsOpen}
                data-testid="issue-detail-tools-toggle"
                onClick={() => {
                  setToolsOpen((current) => !current);
                }}
              >
                <span aria-hidden className="inline-block w-2">
                  {toolsOpen ? '▾' : '▸'}
                </span>
                {`工具调用（${formatCount(turn.toolCalls.length)}）`}
              </button>

              {toolsOpen ? (
                <ul className="flex min-w-0 flex-col gap-0.5" data-testid="issue-detail-tool-calls">
                  {turn.toolCalls.map((call, index) => (
                    <li key={`${call.name}-${String(index)}`} className="flex min-w-0 items-center gap-1.5 text-2xs">
                      <StatusDot tone={call.ok ? 'success' : 'danger'} />
                      <span className="font-mono text-foreground/80">{call.name}</span>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={call.summary ?? undefined}>
                        {call.summary ?? EMPTY}
                      </span>
                      <time className="shrink-0 text-faint" title={formatTimeCell(call.at).title}>
                        {formatTimeCell(call.at).text}
                      </time>
                    </li>
                  ))}
                </ul>
              ) : null}

              {turn.truncated ? (
                <span className="text-2xs text-faint">工具调用超过 50 条，这里只显示前 50 条</span>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
