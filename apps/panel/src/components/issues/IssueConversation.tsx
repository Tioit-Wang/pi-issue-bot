/**
 * Issue 会话流 —— **Issue 页的主体**（需求 `FR-7.3` / `Q-8` / `AC-27` / `AC-28` / `AC-29`）。
 *
 * 首屏自上而下必须是（`AC-27` 原话）：「标题行、收起的原文卡、收起的系统提示词、
 * 第一条人类输入；不需要滚到第二屏才知道它卡在哪」。所以顺序就是这四块，一块都不许挪。
 *
 * 消息流的画法（`Q-8` / `FR-7.3`）：
 * - **人类 / 触发的输入在右**：气泡 + 触发来源 chip + 事件元信息
 *   （`issues.opened · #318 · 2026-05-31T08:24:11Z`）；
 * - **agent 在左，无卡片**：只有行、回答、三层工具（轮 → 组 → 单次调用，成功/失败可见）、
 *   默认收起的 `verdict` / `actions`；
 * - **平台写回居中成行**（`✓ 写回 标签 + 评论 slot=format-review · 2/2 成功`），失败换红。
 *
 * 刻意不做「为什么停在这里 / 证据」这类摘要卡（`Q-8` 的理由）：那是人替模型做的归纳，
 * 模型一改结论就过期；原始会话不会过期。
 *
 * 评论只出现一次：原文卡放的是 **issue 主贴原文**，会话流放的是**评论**，
 * 两者是不同的东西；同一条评论不会既在卡里又在流里（`AC-28`）。
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { StatusBadge, StatusDot } from '../ui/status-badge.tsx';
import { Button, buttonVariants } from '../ui/button.tsx';
import type { IssueSessionResponse, IssueToolCall, IssueTurn } from '../../lib/contract.ts';
import { EMPTY, formatCount, formatDuration, formatTimeCell, formatTokens, formatUsd } from '../../lib/format.ts';
import { readOriginalBody, readSystemPrompt } from './conversation-extras.ts';
import { EnvelopeBlock } from './EnvelopeBlock.tsx';
import { readRunCost } from './contract-extras.ts';
import { ISSUE_STATE_LABEL, ISSUE_STATE_TONE } from './status.ts';
import { cn } from '../../lib/utils.ts';

/** 触发渠道：只有人类轮有 `channel`（spec §3.2 的 `mention|command|auto`）。 */
const CHANNEL_LABEL: Record<'mention' | 'command' | 'auto', string> = {
  mention: '被 @',
  command: '命令',
  auto: '自动',
};

export type IssueConversationProps = {
  data: IssueSessionResponse;
  /** 任务详情链接的拼法（仓库上下文里是 `/repos/:repo/runs/:id`）。 */
  taskHref: (taskId: string) => string;
  /** 「在 GitHub 打开」的目标地址（没有就是禁用态）。 */
  onCopyLink?: () => void;
};

export function IssueConversation({ data, taskHref, onCopyLink }: IssueConversationProps) {
  const { issue, turns } = data;
  const humanCount = turns.filter((turn) => turn.role === 'human').length;
  const botCount = turns.length - humanCount;

  /** 原文卡里的「N 条评论」= 会话流里的人类轮数（同一份数据的另一个视角，不另取数）。 */
  const commentCount = humanCount;

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="issue-conversation">
      {/* ① 标题行：编号、标题、状态、⋯ 动作菜单（`FR-7.3` 第一块） */}
      <ConversationHeader
        issue={issue}
        onCopyLink={onCopyLink}
        turnCounts={{ total: turns.length, human: humanCount, bot: botCount }}
      />

      {/* ② 原文折叠卡：默认收起，只露标题与「原文 · 作者 · N 条评论」（`AC-27` / `AC-28`） */}
      <OriginalCard data={data} commentCount={commentCount} />

      {/* ③ 系统提示词：居中、可折叠，内容就是系统通道下发的那段 markdown 原文（`AC-29`） */}
      <SystemPromptBlock data={data} />

      {/* ④ 消息流：人类在右气泡 / agent 在左无卡片 / 平台写回居中 */}
      <ol className="flex min-w-0 flex-col gap-1" data-testid="issue-turns">
        {turns.map((turn) => (
          <TurnRow key={turn.id} turn={turn} taskHref={taskHref} />
        ))}
      </ol>

      {/* 输入区：只呈现形态，发送按钮禁用（`FR-7.5` / `Q-9` / `AC-33`） */}
      <Composer />
    </div>
  );
}

/** ① 标题行 + `⋯` 动作菜单。缺写接口的动作一律禁用并在 `title` 写明缺哪个接口（`AC-33`）。 */
function ConversationHeader({
  issue,
  onCopyLink,
  turnCounts,
}: {
  issue: IssueSessionResponse['issue'];
  onCopyLink?: () => void;
  turnCounts: { total: number; human: number; bot: number };
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1" data-testid="issue-conversation-header">
      <span className="font-mono text-sm text-muted-foreground">{`${issue.kind}#${formatCount(issue.number)}`}</span>
      <h2 className="min-w-0 flex-1 text-base font-semibold tracking-tight" data-testid="issue-conversation-title">
        {issue.title ?? '（标题取不到）'}
      </h2>
      <StatusBadge tone={ISSUE_STATE_TONE[issue.state]}>{ISSUE_STATE_LABEL[issue.state]}</StatusBadge>
      {issue.stateStale ? (
        <StatusBadge tone="warn" title="状态不是来自投递事件（从 issue_states 推断），可能过期">
          状态可能过期
        </StatusBadge>
      ) : null}
      <span className="tabular text-2xs text-faint" title="轮次 / 人类 / 机器人">
        {`${formatCount(turnCounts.total)} 轮 · 人 ${formatCount(turnCounts.human)} · 机 ${formatCount(turnCounts.bot)}`}
      </span>

      <div className="relative">
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          aria-label="更多动作"
          data-testid="issue-conversation-menu"
          onClick={() => {
            setMenuOpen((open) => !open);
          }}
        >
          ⋯
        </Button>
        {menuOpen ? (
          <div
            role="menu"
            data-testid="issue-conversation-menu-list"
            className="absolute top-8 right-0 z-20 w-56 rounded-lg border border-border bg-card p-1 shadow-lg"
          >
            <MenuButton
              disabled
              title="缺少写接口：需要 POST /api/tasks/:id/rerun"
              testId="issue-menu-rerun"
              label="重跑这一条"
            />
            <MenuButton
              disabled
              title="缺少写接口：需要 POST /api/issues/:owner/:name/:kind/:number/assignee"
              testId="issue-menu-manual"
              label="标记为人工处理"
            />
            {onCopyLink === undefined ? null : (
              <button
                type="button"
                role="menuitem"
                onClick={onCopyLink}
                className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                复制面板链接
              </button>
            )}
            {issue.url === null ? null : (
              <a
                role="menuitem"
                href={issue.url}
                target="_blank"
                rel="noreferrer"
                className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                在 GitHub 打开 issue ↗
              </a>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 缺接口的动作：禁用 + `title` 写明缺哪个接口（不是画一个能点但静默失败的按钮）。 */
function MenuButton({
  label,
  title,
  testId,
  disabled,
}: {
  label: string;
  title: string;
  testId: string;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      data-testid={testId}
      className={cn(
        'block w-full rounded-md px-2 py-1.5 text-left text-xs',
        disabled ? 'cursor-not-allowed text-subtle' : 'text-foreground hover:bg-muted',
      )}
    >
      {label}
    </button>
  );
}

/**
 * ② 原文折叠卡。
 *
 * 收起时只露一行：标题 + 「原文 · 作者 · N 条评论」（`FR-7.3` 原话）。
 * 展开才是作者、时间、标签、正文（`AC-28`）—— 正文是 **issue 主贴原文**，不是评论。
 */
function OriginalCard({ data, commentCount }: { data: IssueSessionResponse; commentCount: number }) {
  const original = readOriginalBody(data.issue);
  const time = formatTimeCell(original.at);

  return (
    <details className="group rounded-lg border border-border bg-card" data-testid="issue-original-card">
      <summary
        className="flex cursor-pointer items-center gap-2 px-2.5 py-2 text-sm text-foreground select-none hover:bg-muted/60"
        data-testid="issue-original-summary"
      >
        <span aria-hidden className="shrink-0 text-2xs text-faint group-open:rotate-90">▶</span>
        <span className="min-w-0 flex-1 truncate font-medium">{data.issue.title ?? '（没有原文标题）'}</span>
        <span className="shrink-0 text-2xs text-faint">
          {`原文 · ${original.author ?? '作者未知'} · ${formatCount(commentCount)} 条评论`}
        </span>
      </summary>

      <div className="flex min-w-0 flex-col gap-1.5 border-t border-border px-3 py-2" data-testid="issue-original-body">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-faint">
          <span className="font-mono text-foreground/80">{original.author ?? EMPTY}</span>
          <time title={time.title}>{time.text}</time>
          {data.issue.labels.length === 0 ? null : (
            <>
              <span aria-hidden>·</span>
              {data.issue.labels.map((label) => (
                <StatusBadge key={label} tone="neutral">
                  {label}
                </StatusBadge>
              ))}
            </>
          )}
        </div>
        {original.bodyState === 'absent' ? (
          <p className="text-sm text-muted-foreground" data-testid="issue-original-missing">
            响应里没有 `IssueSummary.body` 这个字段（旧服务端 / mock 夹具）：这是**契约缺字段**，
            不是「这个 issue 没有正文」。
          </p>
        ) : original.body === null ? (
          // 契约给了 `null`：服务端确实没有这条主贴的正文（投递里没带 / 正文为空）
          <p className="text-sm text-muted-foreground" data-testid="issue-original-empty">
            这个 issue 的主贴没有正文（服务端返回 null）。
          </p>
        ) : (
          <MessageText text={original.body} testId="issue-original-text" />
        )}
      </div>
    </details>
  );
}

/** ③ 系统提示词：居中、默认收起；展开是**完整 markdown 原文**（含 `# 角色` 等标题），不是摘要。 */
function SystemPromptBlock({ data }: { data: IssueSessionResponse }) {
  const prompt = readSystemPrompt(data);
  if (prompt.state !== 'value' || prompt.text === null) {
    /*
     * 两种「没有」必须分开说（与原文卡同一类问题）：
     * - `absent`：响应里没有这个键 → 契约 / 代理的问题，要报给开发；
     * - `null`：服务端明确说这次会话没有记录 → 业务事实（例如只有被拒绝的投递）。
     */
    const absent = prompt.state === 'absent';
    return (
      <div className="flex justify-center" data-testid="issue-system-prompt-empty">
        <p className="max-w-[42rem] rounded-md border border-dashed border-border px-3 py-1.5 text-2xs text-muted-foreground">
          {absent
            ? '响应里没有 IssueSessionResponse.systemPrompt 这个字段（旧服务端 / mock 夹具）：这是契约缺字段，不是「这次会话没有提示词」。'
            : '这次会话没有系统提示词的记录（服务端 agent_sessions.system_prompt 为 null）：可能还没跑过一轮，或只有被拒绝的投递。'}
        </p>
      </div>
    );
  }
  const tokens = prompt.text.length === 0 ? 0 : Math.ceil(prompt.text.length / 4);

  return (
    <div className="flex justify-center" data-testid="issue-system-prompt">
      <details className="w-full max-w-[42rem] rounded-lg border border-border bg-muted/40">
        <summary
          className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-2xs text-muted-foreground select-none hover:text-foreground"
          data-testid="issue-system-prompt-summary"
        >
          <span aria-hidden className="text-faint">▸</span>
          <span className="font-semibold text-foreground/80">系统提示词</span>
          <span className="min-w-0 flex-1 truncate">{prompt.meta ?? EMPTY}</span>
          <span className="shrink-0 font-mono text-faint">{`${formatTokens(tokens)} tok`}</span>
        </summary>
        <div className="border-t border-dashed border-border px-2.5 py-2">
          {/* `white-space: pre-wrap`：Wave 原文的换行与 `#` 标题一个字符都不改 */}
          <pre
            className="max-h-[20rem] overflow-auto rounded-md border border-border bg-card px-2 py-1.5 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-words"
            data-testid="issue-system-prompt-text"
          >
            {prompt.text}
          </pre>
        </div>
      </details>
    </div>
  );
}

/** ④ 一轮：人类在右 / agent 在左 / 写回居中。 */
function TurnRow({ turn, taskHref }: { turn: IssueTurn; taskHref: (taskId: string) => string }) {
  if (turn.role === 'human') return <HumanRow turn={turn} />;
  return <AgentRow turn={turn} taskHref={taskHref} />;
}

function HumanRow({ turn }: { turn: IssueTurn }) {
  const time = formatTimeCell(turn.at);
  return (
    <li className="flex min-w-0 flex-col gap-1 py-2" data-testid="issue-turn-human">
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-0.5 text-2xs text-faint">
        <span className="font-mono text-foreground/80">{turn.login ?? '人类'}</span>
        {turn.channel === null ? null : <StatusBadge tone="neutral">{CHANNEL_LABEL[turn.channel]}</StatusBadge>}
        {/* 事件元信息：来源 · 编号 · 绝对时间（`FR-7.3` 的例子就是这个形状） */}
        <span className="font-mono">
          {`${turn.channel ?? 'event'} · #${String(turn.id.split(':')[1] ?? '')} · ${new Date(turn.at).toISOString()}`}
        </span>
        <time title={time.title}>{time.text}</time>
      </div>
      <div className="flex min-w-0 justify-end">
        <div className="flex w-max max-w-[min(82%,37.5rem)] flex-col gap-1 rounded-lg rounded-br-sm bg-foreground/[0.08] px-3 py-2">
          <MessageText text={turn.text} testId="issue-turn-human-text" />
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

/** agent 一轮：无卡片、只有行 + 回答 + 三层工具 + 默认收起的 verdict/actions。 */
function AgentRow({ turn, taskHref }: { turn: IssueTurn; taskHref: (taskId: string) => string }) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const time = formatTimeCell(turn.at);
  const cost = readRunCost(turn);
  const toolCount = turn.toolCalls.length;
  const failedTools = turn.toolCalls.filter((call) => !call.ok).length;

  return (
    <li className="flex min-w-0 flex-col gap-1.5 py-2" data-testid="issue-turn-bot">
      {/* 轮标题（第一层）：状态 · 时间 · 耗时 · 工具数 */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground">
        <button
          type="button"
          className="flex w-fit items-center gap-1.5 rounded-md px-1 py-0.5 transition-[background-color,color] duration-[120ms] hover:bg-foreground/[0.04] hover:text-foreground"
          aria-expanded={toolsOpen}
          data-testid="issue-turn-tools-toggle"
          title={toolCount === 0 ? '本轮没有工具调用' : '展开 / 收起本轮的工具调用'}
          onClick={() => {
            if (toolCount === 0) return;
            setToolsOpen((current) => !current);
          }}
        >
          <span aria-hidden className="inline-block w-2">
            {toolCount === 0 ? '·' : toolsOpen ? '▾' : '▸'}
          </span>
          <span className="font-medium text-foreground/80">agent</span>
          <span>{turn.status === 'succeeded' ? '运行完成' : turn.status}</span>
        </button>
        <span className="text-faint">·</span>
        <time title={time.title}>{time.text}</time>
        <span className="text-faint">·</span>
        <span className="tabular">{cost.durationMs === null ? '耗时 —' : formatDuration(cost.durationMs)}</span>
        <span className="text-faint">·</span>
        <span className="tabular">{toolCount === 0 ? '无工具调用' : `${formatCount(toolCount)} 个工具`}</span>
        {failedTools === 0 ? null : (
          <span className="tabular text-danger-fg">{`${formatCount(failedTools)} 次失败`}</span>
        )}
        {turn.failureClass === null ? null : <StatusBadge tone="danger">{turn.failureClass}</StatusBadge>}
        {turn.attempts > 1 ? <span className="text-faint">{`合并 ${formatCount(turn.attempts)} 次 attempt`}</span> : null}
      </div>

      {/* 回答正文（agent 在左，无卡片） */}
      {turn.text === null || turn.text === '' ? null : (
        <div className="min-w-0 pl-3">
          <MessageText text={turn.text} testId="issue-turn-bot-text" />
        </div>
      )}

      {/* 第二层：工具组；第三层：单次调用（展开后） */}
      {toolCount === 0 || !toolsOpen ? null : (
        <div className="flex min-w-0 flex-col gap-1 pl-3" data-testid="issue-turn-tool-calls">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground">
            <span aria-hidden>▾</span>
            <span>工具调用</span>
            <span className="text-faint">·</span>
            <span className="tabular">{`${formatCount(toolCount)} 次操作`}</span>
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

      {/* 默认收起的信封原文：`verdict` / `actions`（`AC-30` / `FR-7.3`） */}
      <EnvelopeBlock turn={turn} />

      {/* 脚注：成本（token 与单价）+ 任务证据链接 + 评论链接 */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pl-3 text-2xs text-faint">
        {cost.costUsd === null ? null : <span className="tabular" title="本轮成本（USD）">{formatUsd(cost.costUsd)}</span>}
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

/** 第三层：一次工具调用（单行，失败可见）。 */
function ToolRow({ call }: { call: IssueToolCall }) {
  return (
    <li className="flex min-w-0 items-center gap-1.5 py-0.5 text-2xs">
      <StatusDot tone={call.ok ? 'success' : 'danger'} label={call.ok ? '成功' : '失败'} />
      <span className="shrink-0 font-mono text-foreground/80">{call.name}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={call.summary ?? undefined}>
        {call.summary ?? EMPTY}
      </span>
    </li>
  );
}

/**
 * 输入区：**只呈现形态**（`FR-7.5` / `Q-9` / `AC-33`）。
 *
 * 本版不提供「在面板里回复并同步到 issue」：写路径要同时做「代发评论 + 落 agent 消息 +
 * 直接入队」，还要过 CSRF / Origin / 外部文本围栏，混在 UI 改版里会把风险埋进纯视觉变更。
 * 所以按钮是 `disabled`，`title` 写明**缺哪个接口** —— 不假装成功。
 */
function Composer() {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2" data-testid="issue-composer">
      <div className="flex min-w-0 items-center gap-1.5 text-2xs text-faint">
        <StatusDot tone="neutral" />
        <span>以 bot 身份回复这条 issue</span>
        <span aria-hidden>·</span>
        <span>本版不做发送（需求 §5.7 / Q-9）</span>
      </div>
      <div className="flex min-w-0 items-end gap-2">
        <textarea
          readOnly
          rows={2}
          aria-label="回复这条 issue"
          placeholder="这里只呈现形态：发送按钮没有后端接口。"
          title="缺少写接口：需要 POST /api/issues/:owner/:name/:kind/:number/messages（代发评论 + 落 agent 消息 + 直接入队）"
          data-testid="issue-composer-input"
          className="min-h-14 min-w-0 flex-1 resize-none rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs text-foreground placeholder:text-subtle"
        />
        <button
          type="button"
          disabled
          title="缺少写接口：需要 POST /api/issues/:owner/:name/:kind/:number/messages（代发评论 + 落 agent 消息 + 直接入队）"
          data-testid="issue-composer-send"
          className={cn(buttonVariants({ size: 'sm' }), 'cursor-not-allowed opacity-50')}
        >
          发送
        </button>
      </div>
    </div>
  );
}

/** 正文按纯文本渲染（不解析 Markdown / HTML）；代码围栏用等宽块。 */
export function MessageText({ text, testId }: { text: string | null; testId?: string }) {
  if (text === null || text === '') {
    return (
      <p className="text-sm text-muted-foreground italic" data-testid={testId}>
        （没有正文）
      </p>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid={testId}>
      {splitFences(text).map((block, index) =>
        block.kind === 'code' ? (
          <pre
            key={`block-${String(index)}`}
            className="max-w-full overflow-x-auto rounded-md border border-border bg-muted/50 px-2 py-1.5 font-mono text-xs leading-relaxed text-foreground"
          >
            {block.text}
          </pre>
        ) : (
          <p key={`block-${String(index)}`} className="max-w-full break-words whitespace-pre-wrap text-sm leading-[1.65] text-foreground">
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
