import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { AsyncSection } from '../components/AsyncSection.tsx';
import { readReactionState, readRunCost } from '../components/issues/contract-extras.ts';
import { ReactionChip, reactionHint } from '../components/issues/reaction-chip.tsx';
import { ISSUE_STATE_LABEL, ISSUE_STATE_TONE } from '../components/issues/status.ts';
import { PageHeader } from '../components/PageHeader.tsx';
import { Badge, StatusDot } from '../components/ui/badge.tsx';
import { Button, buttonVariants } from '../components/ui/button.tsx';
import { useToast } from '../components/ui/toast.tsx';
import type { IssueKind, IssueSessionResponse, IssueToolCall, IssueTurn } from '../lib/contract.ts';
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
 * Issue 会话详情（`/repos/:repo/issues/:kind/:number`）—— 只回答一件事：
 * **「这个 issue 的会话长什么样」**。
 *
 * 视觉与结构按需求文档 §5 的「完整对话」demo：
 *  - 消息行**无卡片**，只有用户输入带气泡；
 *  - 机器人一轮 = 「轮 → 组 → 工具」三层折叠，工具行是弱化的单行；
 *  - 头部一条会话栏（会话 id / issue / 轮次 / 累计 token）。
 *
 * 刻意**去掉**的东西（已过时的产出视图）：结论正文、标签与理由、缺哪些信息、run 时间线表格、
 * reaction 台账、参与者、成本汇总。它们要么与「会话」无关，要么在实现里已经不再写入；
 * 留着只会让人以为平台在维护两套口径。判定与写回的审计在「运行」「审计」两页可查。
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
              onClick={() => {
                copy(`${window.location.origin}${pageHref}`, '链接已复制');
              }}
              data-testid="issue-detail-copy-link"
            >
              复制链接
            </Button>
            {issue === null || issue.url === null ? null : (
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
        {data === null || data === undefined ? null : <SessionBody data={data} onCopy={copy} />}
      </AsyncSection>
    </div>
  );
}

/** 会话主体：一条对话栏 + 逐轮消息（人类气泡 / 机器人三层折叠）。 */
function SessionBody({ data, onCopy }: { data: IssueSessionResponse; onCopy: (text: string, title: string) => void }) {
  const { issue, turns } = data;
  const humanCount = turns.filter((turn) => turn.role === 'human').length;
  const botCount = turns.length - humanCount;

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="issue-detail-session">
      {/* 对话栏：会话级元信息（demo `.dlg-hd`） */}
      <div
        className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 rounded-t-lg border border-border bg-muted/40 px-3 py-2 text-2xs text-muted-foreground"
        data-testid="issue-detail-session-header"
      >
        <span>
          <span className="text-faint">Issue </span>
          <span className="font-mono text-foreground/80">{`${issue.kind}#${formatCount(issue.number)}`}</span>
        </span>
        <span>
          <span className="text-faint">轮次 </span>
          <span className="tabular text-foreground/80">{formatCount(turns.length)}</span>
        </span>
        <span>
          <span className="text-faint">人类 </span>
          <span className="tabular text-foreground/80">{formatCount(humanCount)}</span>
        </span>
        <span>
          <span className="text-faint">机器人 </span>
          <span className="tabular text-foreground/80">{formatCount(botCount)}</span>
        </span>
        {issue.labels.length === 0 ? null : (
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            {issue.labels.map((label) => (
              <Badge key={label} tone="neutral">
                {label}
              </Badge>
            ))}
          </span>
        )}
      </div>

      {/* 消息列表：无卡片，只有用户输入有气泡 */}
      <ol className="flex min-w-0 flex-col gap-1" data-testid="issue-detail-turns">
        {turns.map((turn) => (
          <TurnRow key={turn.id} turn={turn} onCopy={onCopy} />
        ))}
      </ol>
    </div>
  );
}

/** 一轮：人类 = 右对齐气泡 + 事件元信息；机器人 = 轮标题 + 工具组 + 输出块。 */
function TurnRow({ turn, onCopy }: { turn: IssueTurn; onCopy: (text: string, title: string) => void }) {
  return turn.role === 'human' ? (
    <HumanRow turn={turn} />
  ) : (
    <BotRow turn={turn} onCopy={onCopy} />
  );
}

function HumanRow({ turn }: { turn: IssueTurn }) {
  const time = formatTimeCell(turn.at);
  return (
    <li className="flex min-w-0 flex-col gap-1 py-2" data-testid={`issue-detail-turn-${turn.role}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-faint">
        <span className="font-mono text-foreground/80">{turn.login ?? '人类'}</span>
        {turn.channel === null ? null : <span>{CHANNEL_LABEL[turn.channel]}</span>}
        <time title={time.title}>{time.text}</time>
      </div>
      <div className="flex min-w-0 justify-end">
        <div className="flex w-max max-w-[min(82%,37.5rem)] flex-col gap-1 rounded-[18px] rounded-br-[4px] bg-foreground/[0.08] px-[15px] py-2">
          <MessageText text={turn.text} />
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
        </div>
      </div>
    </li>
  );
}

/** 一轮机器人：折叠的「轮」→ 折叠的「组」→ 工具单行；下面是输出块与脚注。 */
function BotRow({ turn, onCopy }: { turn: IssueTurn; onCopy: (text: string, title: string) => void }) {
  const { repo } = useRepoRoute();
  const [toolsOpen, setToolsOpen] = useState(false);
  const time = formatTimeCell(turn.at);
  const cost = readRunCost(turn);
  const taskHref = (taskId: string): string =>
    repo === null ? `/tasks/${encodeURIComponent(taskId)}` : repoRunPath(repo, taskId);

  const toolCount = turn.toolCalls.length;
  const failedTools = turn.toolCalls.filter((call) => !call.ok).length;

  return (
    <li className="flex min-w-0 flex-col gap-1.5 border-t border-border py-2.5" data-testid={`issue-detail-turn-${turn.role}`}>
      {/* 轮标题：运行完成 · 耗时 · N 个工具 */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground">
        <button
          type="button"
          className="flex w-fit items-center gap-1.5 rounded-md px-1 py-0.5 transition-[background-color,color] duration-[120ms] hover:bg-foreground/[0.04] hover:text-foreground"
          aria-expanded={toolsOpen}
          data-testid="issue-detail-tools-toggle"
          title={toolCount === 0 ? '本轮没有工具调用' : '展开 / 收起本轮的工具调用'}
          onClick={() => {
            if (toolCount === 0) return;
            setToolsOpen((current) => !current);
          }}
        >
          <span aria-hidden className="inline-block w-2">
            {toolCount === 0 ? '·' : toolsOpen ? '▾' : '▸'}
          </span>
          <span>{turn.status === 'succeeded' ? '运行完成' : turn.status}</span>
        </button>
        <span className="text-faint">·</span>
        <time title={time.title}>{time.text}</time>
        <span className="text-faint">·</span>
        <span className="tabular">{cost.durationMs === null ? '耗时 —' : formatDuration(cost.durationMs)}</span>
        <span className="text-faint">·</span>
        <span className="tabular">{toolCount === 0 ? '无工具调用' : `${formatCount(toolCount)} 个工具`}</span>
        {turn.failureClass === null ? null : <Badge tone="danger">{turn.failureClass}</Badge>}
        {turn.attempts > 1 ? <span className="text-faint">{`合并 ${formatCount(turn.attempts)} 次 attempt`}</span> : null}
      </div>

      {/* 工具组（第二层）：本轮的工具按「组」折叠成一行，展开后逐条显示（第三层） */}
      {toolCount === 0 || !toolsOpen ? null : (
        <div className="flex min-w-0 flex-col gap-1 pl-3" data-testid="issue-detail-tool-calls">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground">
            <span aria-hidden>▾</span>
            <span>工具调用</span>
            <span className="text-faint">·</span>
            <span className="tabular">{`${formatCount(toolCount)} 次操作`}</span>
            {failedTools === 0 ? null : (
              <>
                <span className="text-faint">·</span>
                <span className="text-danger-fg tabular">{`${formatCount(failedTools)} 次失败`}</span>
              </>
            )}
          </div>
          <ul className="flex min-w-0 flex-col">
            {turn.toolCalls.map((call, index) => (
              <ToolRow key={`${call.name}-${String(index)}`} call={call} />
            ))}
          </ul>
          {turn.truncated ? (
            <span className="text-2xs text-faint">工具调用超过 50 条，这里只显示前 50 条</span>
          ) : null}
        </div>
      )}

      {/* 输出块：机器人这一轮的正文 */}
      {turn.text === null || turn.text === '' ? null : (
        <div className="flex min-w-0 flex-col gap-1 pl-3">
          <span className="text-2xs text-faint">输出</span>
          <MessageText text={turn.text} />
          <button
            type="button"
            className="w-fit text-2xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={() => {
              onCopy(turn.text ?? '', '正文已复制');
            }}
          >
            复制
          </button>
        </div>
      )}

      {/* 脚注：任务 / 成本 / 评论链接 */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pl-3 text-2xs text-faint">
        {cost.costUsd === null ? null : (
          <span className="tabular" title="本轮成本（USD）">
            {formatUsd(cost.costUsd)}
          </span>
        )}
        {turn.taskId === null ? (
          <span>{EMPTY}</span>
        ) : (
          <Link className="font-mono underline underline-offset-2" to={taskHref(turn.taskId)}>
            {turn.taskId}
          </Link>
        )}
        {turn.commentUrl === null ? null : (
          <a className="underline underline-offset-2 hover:text-foreground" href={turn.commentUrl} target="_blank" rel="noreferrer">
            在 GitHub 看这条评论
          </a>
        )}
      </div>
    </li>
  );
}

/** 第三层：一次工具调用（单行，弱化）。 */
function ToolRow({ call }: { call: IssueToolCall }) {
  return (
    <li className="flex min-w-0 items-center gap-1.5 py-0.5 text-2xs">
      <StatusDot tone={call.ok ? 'success' : 'danger'} />
      <span className="shrink-0 font-mono text-foreground/80">{call.name}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={call.summary ?? undefined}>
        {call.summary ?? EMPTY}
      </span>
    </li>
  );
}

/** 正文按纯文本渲染（不解析 Markdown / HTML）；代码围栏用等宽块。 */
function MessageText({ text }: { text: string | null }) {
  if (text === null || text === '') {
    return <p className="text-sm text-muted-foreground italic">（本轮没有正文）</p>;
  }
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {splitFences(text).map((block, index) =>
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
