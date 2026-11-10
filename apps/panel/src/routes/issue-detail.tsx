import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { AsyncSection } from '../components/AsyncSection.tsx';
import { Badge, statusVariant } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card.tsx';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.tsx';
import type { IssueKind, IssueSessionResponse, IssueTurn } from '../lib/contract.ts';
import { EMPTY, formatCount, formatTimeCell } from '../lib/format.ts';
import { useIssueSession } from '../lib/queries.ts';
import { NotFoundPage } from './not-found.tsx';
import { PageShell } from './PageShell.tsx';

/**
 * Issue 会话页（R3 / S-B，数据源 `GET /api/issues/:owner/:name/:kind/:number`，每 5s 轮询）。
 *
 * **一个 issue = 一个 session**，视觉按 AI 对话组织（spec §5）：
 *
 *  - 主列是**气泡时间线**：人类右对齐（`ml-auto`，`accent` 底色）、机器人左对齐（`card` 底色），
 *    每轮按 `at` 升序，人类在前（契约已排好序，页面不再排）；气泡头区分 `role` 与 `login`。
 *  - 气泡内顺序固定：**正文 → 标签 chips → 可折叠「工具调用（N）」**。
 *    正文一律按**纯文本**渲染（`whitespace-pre-wrap`，绝不 `dangerouslySetInnerHTML`）；
 *    折叠区只有工具调用摘要表格（名字/摘要/时间/ok），**不放 `item.delta` 之类的原始流**。
 *  - 右侧栏（`lg` 以上 `sticky`，窄屏是气泡上方的可折叠块）：「做了什么」/「结果」/「标签」，
 *    `结果` 里的 `taskId` 链到既有的 `/tasks/:id`。
 *  - **只读红线**：整页只有导航（Github 链接 / 任务链接 / 返回列表）与展开-折叠，
 *    没有 `<input>`、`<textarea>`、发送按钮，也没有任何写请求（`lib/api.ts` 只有 GET）。
 *
 * 404 走 `useIssueSession` 的 `null` 约定（没有 `tasks` 行是正常业务态），显示空态而非错误态。
 */
export function IssueDetailPage() {
  const params = useParams();
  const owner = params['owner'] ?? '';
  const name = params['name'] ?? '';
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

/** 列表/详情共用的 `state` 语义（`unknown` = 取不到 issue 元数据）。 */
function stateVariant(state: IssueSessionResponse['issue']['state']): 'success' | 'outline' | 'muted' {
  if (state === 'open') return 'success';
  if (state === 'closed') return 'outline';
  return 'muted';
}

function stateLabel(state: IssueSessionResponse['issue']['state']): string {
  return state === 'unknown' ? '状态未知' : state;
}

/** 侧栏「做了什么」的一行：当前契约里没有 `actions[]`，只能由本轮已有字段反推（见 `railActions`）。 */
type RailAction = {
  intent: 'ask' | 'comment' | 'label' | 'tool';
  label: string;
};

/** intent → 徽章语义（评论=实心、标签=warning、工具=描边、提问=灰）。 */
const INTENT_VARIANT: Record<RailAction['intent'], 'default' | 'warning' | 'outline' | 'muted'> = {
  ask: 'muted',
  comment: 'default',
  label: 'warning',
  tool: 'outline',
};

/**
 * 从一轮里反推「做了什么」。
 *
 * ⚠ spec §5 要求侧栏展示「本轮 actions（评论/标签/推送）按 intent 分色」，
 * 但 §3.2 的 `turns[]` 里**没有 `actions[]` 字段**（只有 `text`/`labels`/`toolCalls`）。
 * 所以这里只用已有字段反推：有正文 = 发过评论，`labels` = 本轮打的标，`toolCalls` = 工具调用。
 * 等 S-A 在契约里补上 `actions[]` 后换回真实 intent（TODO(S-A)），页面结构不用动。
 */
function railActions(turn: IssueTurn): RailAction[] {
  const actions: RailAction[] = [];

  if (turn.role === 'human') {
    actions.push({
      intent: 'ask',
      label: turn.channel === null ? '提问' : `${CHANNEL_LABEL[turn.channel]} 触发`,
    });
  } else if (turn.text !== null && turn.text !== '') {
    actions.push({ intent: 'comment', label: '评论（回答正文）' });
  }

  for (const label of turn.labels) {
    actions.push({ intent: 'label', label: `打标 ${label}` });
  }

  if (turn.toolCalls.length > 0) {
    actions.push({ intent: 'tool', label: `工具调用 ${formatCount(turn.toolCalls.length)} 次` });
  }

  return actions;
}

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
  const { data, error, isLoading } = useIssueSession({ owner, name, kind, number });

  // 404：hook 把 404 规约成 null，所以「不是错误 + 没有数据」= 这个 issue 没有会话
  const missing = !isLoading && error === null && data === null;
  const turns = data?.turns ?? [];
  const isEmpty = missing || turns.length === 0;

  return (
    <PageShell
      title="Issue 会话"
      description={`${owner}/${name} ${kind} #${formatCount(number)} · 每 5 秒刷新`}
      actions={
        <Link className="text-xs text-muted-foreground underline-offset-2 hover:underline" to="/issues">
          返回 Issue 列表
        </Link>
      }
    >
      <AsyncSection
        isLoading={isLoading}
        error={error}
        isEmpty={isEmpty}
        emptyText={
          missing
            ? '找不到这个会话：这个 issue 没有任何处理记录（或者链接里的仓库 / 编号拼错了）。'
            : '这个会话还没有任何轮次（任务可能刚入队）。'
        }
        testId="issue-detail"
        skeletonHeight="h-48"
        skeleton={
          <div className="flex flex-col gap-2">
            {Array.from({ length: 4 }, (_, index) => (
              <div
                key={`issue-detail-skeleton-${String(index)}`}
                className="h-20 w-full animate-pulse rounded-md bg-muted"
              />
            ))}
          </div>
        }
      >
        {data === null || data === undefined ? null : <SessionBody data={data} />}
      </AsyncSection>
    </PageShell>
  );
}

function SessionBody({ data }: { data: IssueSessionResponse }) {
  const { issue } = data;
  const humanCount = data.turns.filter((turn) => turn.role === 'human').length;
  const botCount = data.turns.length - humanCount;

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">{issue.repo}</span>
            <span className="font-mono text-xs text-muted-foreground">
              {issue.kind}#{formatCount(issue.number)}
            </span>
            <Badge variant={stateVariant(issue.state)}>{stateLabel(issue.state)}</Badge>
            {issue.url === null ? null : (
              <a
                className="text-xs font-normal text-muted-foreground underline underline-offset-2"
                href={issue.url}
                target="_blank"
                rel="noreferrer"
              >
                在 GitHub 打开
              </a>
            )}
          </CardTitle>
          <CardDescription className="break-words text-sm text-foreground">
            {issue.title ?? '（取不到标题）'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span data-testid="issue-detail-counts">
            人类 {formatCount(humanCount)} 轮 · 机器人 {formatCount(botCount)} 轮
          </span>
          <span aria-hidden="true">·</span>
          <span className="break-all">
            参与人：{issue.participants.length === 0 ? EMPTY : issue.participants.join('、')}
          </span>
          {issue.labels.length === 0 ? null : (
            <span className="flex flex-wrap items-center gap-1">
              {issue.labels.map((label) => (
                <Badge key={label} variant="secondary">
                  {label}
                </Badge>
              ))}
            </span>
          )}
        </CardContent>
      </Card>

      <ol className="flex flex-col" data-testid="issue-detail-turns">
        {data.turns.map((turn) => (
          <TurnItem key={turn.id} turn={turn} />
        ))}
      </ol>
    </div>
  );
}

function TurnItem({ turn }: { turn: IssueTurn }) {
  // 折叠状态只影响观感，不参与数据：默认「工具调用」收起（spec §5），侧栏默认展开
  const [toolsOpen, setToolsOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(true);

  const isHuman = turn.role === 'human';
  const time = formatTimeCell(turn.at);

  return (
    <li
      className="grid min-w-0 gap-2 py-3 lg:grid-cols-[minmax(0,1fr)_15rem]"
      data-testid={`issue-detail-turn-${turn.role}`}
    >
      {/*
        主列对齐 PI-Desktop 的对话消息列（`apps/desktop/src/styles/messages.css` + `chat-shell.css`）：
        - 人类：右对齐的 shrink-wrap 气泡，最大 `min(82%, 600px)`，圆角 18px、右下角 4px，
          底色是前景色 8%，内边距 10px 15px；对齐由布局承担，不再额外挂「人类」徽章。
        - 机器人：左对齐的**纯正文**（无气泡、无边框、无底色），行宽 `min(100%, 720px)`。
        窄屏时侧栏排在前面（「顶部可折叠块」），lg 以上固定在右侧。
      */}
      <div
        className={
          isHuman
            ? 'order-2 flex min-w-0 justify-end lg:order-1'
            : 'order-2 flex min-w-0 justify-start lg:order-1'
        }
      >
        <article
          className={
            isHuman
              ? 'flex w-max max-w-[min(82%,37.5rem)] flex-col gap-1.5 rounded-[18px] rounded-br-[4px] bg-foreground/[0.08] px-[15px] py-2.5'
              : 'flex w-full max-w-[45rem] flex-col gap-1.5'
          }
        >
          <header className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="font-mono font-medium text-foreground/80">
              {turn.login ?? (isHuman ? '人类' : '机器人')}
            </span>
            {isHuman && turn.channel !== null ? (
              <span className="rounded-full bg-foreground/[0.06] px-1.5 py-px">{CHANNEL_LABEL[turn.channel]}</span>
            ) : null}
            {turn.status === null ? null : (
              <Badge variant={statusVariant(turn.status)}>{turn.status}</Badge>
            )}
            {turn.failureClass === null ? null : <Badge variant="danger">{turn.failureClass}</Badge>}
            <time className="text-muted-foreground/80" title={time.title}>
              {time.text}
            </time>
          </header>

          {turn.text === null || turn.text === '' ? (
            <p className="text-[15px] leading-[1.65] text-muted-foreground italic">（本轮没有正文）</p>
          ) : (
            // 纯文本渲染：不解析 Markdown / HTML（spec §5 的只读与安全要求）
            <p className="max-w-full break-words whitespace-pre-wrap text-[15px] leading-[1.65] text-foreground">
              {turn.text}
            </p>
          )}

          {turn.labels.length === 0 ? null : (
            <div className="flex flex-wrap items-center gap-1" data-testid="issue-detail-turn-labels">
              {turn.labels.map((label) => (
                <Badge key={label} variant="secondary">
                  {label}
                </Badge>
              ))}
            </div>
          )}

          {turn.commentUrl === null ? null : (
            <a
              className="self-start text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              href={turn.commentUrl}
              target="_blank"
              rel="noreferrer"
            >
              在 GitHub 看这条评论
            </a>
          )}

          {turn.toolCalls.length === 0 ? null : (
            <div className="flex flex-col gap-1">
              {/*
                工具调用是**安静的一行**（PI-Desktop 的 `.tool-row` 观感）：无底色、无边框，
                hover 才提亮；默认收起，展开后是一张无竖线的紧凑表。
              */}
              <button
                type="button"
                className="flex w-fit items-center gap-1.5 rounded-md px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
                aria-expanded={toolsOpen}
                data-testid="issue-detail-tools-toggle"
                onClick={() => {
                  setToolsOpen((current) => !current);
                }}
              >
                <span aria-hidden className="inline-block w-2 text-[9px]">
                  {toolsOpen ? '▾' : '▸'}
                </span>
                工具调用（{formatCount(turn.toolCalls.length)}）
              </button>

              {toolsOpen ? (
                <Table className="w-fit min-w-0 text-[11px]" data-testid="issue-detail-tool-calls">
                  <TableHeader>
                    <TableRow className="border-0 hover:bg-transparent">
                      <TableHead className="h-6 px-1 font-normal text-muted-foreground">名字</TableHead>
                      <TableHead className="h-6 px-1 font-normal text-muted-foreground">摘要</TableHead>
                      <TableHead className="h-6 px-1 font-normal text-muted-foreground">时间</TableHead>
                      <TableHead className="h-6 px-1 font-normal text-muted-foreground">ok</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {turn.toolCalls.map((call, index) => (
                      <TableRow
                        key={`${call.name}-${String(index)}`}
                        className="border-0 hover:bg-foreground/[0.03]"
                      >
                        <TableCell className="px-1 py-1 font-mono whitespace-nowrap text-foreground/80">
                          {call.name}
                        </TableCell>
                        <TableCell className="max-w-[28rem] truncate px-1 py-1 text-muted-foreground">
                          {call.summary}
                        </TableCell>
                        <TableCell className="px-1 py-1 whitespace-nowrap text-muted-foreground/80">
                          <time title={formatTimeCell(call.at).title}>{formatTimeCell(call.at).text}</time>
                        </TableCell>
                        <TableCell className="px-1 py-1">
                          <Badge variant={call.ok ? 'success' : 'danger'}>{call.ok ? 'ok' : 'fail'}</Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : null}

              {turn.truncated === true ? (
                <span className="text-[11px] text-muted-foreground">
                  工具调用超过 50 条，这里只显示前 50 条
                </span>
              ) : null}
            </div>
          )}
        </article>
      </div>

      {/* 侧栏：窄屏是气泡上方的折叠块，lg 以上固定在右侧 */}
      <aside className="order-1 min-w-0 lg:order-2 lg:sticky lg:top-4 lg:self-start">
        <TurnRail turn={turn} open={railOpen} onToggle={() => setRailOpen((current) => !current)} />
      </aside>
    </li>
  );
}

function TurnRail({ turn, open, onToggle }: { turn: IssueTurn; open: boolean; onToggle: () => void }) {
  const time = formatTimeCell(turn.at);
  const actions = railActions(turn);

  return (
    <Card className="bg-muted/20">
      <CardHeader className="flex-row items-center justify-between px-3 pt-2.5 pb-0">
        <CardTitle className="text-xs">本轮详情</CardTitle>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          data-testid="issue-detail-rail-toggle"
          onClick={onToggle}
        >
          {open ? '收起' : '展开'}
        </Button>
      </CardHeader>

      {open ? (
        <CardContent className="flex flex-col gap-2.5 px-3 py-2.5 text-xs">
          <section className="flex flex-col gap-1" data-testid="issue-detail-rail-actions">
            <h4 className="font-semibold text-muted-foreground">做了什么</h4>
            <div className="flex flex-col gap-1">
              {actions.map((action) => (
                <span key={`${action.intent}-${action.label}`} className="flex items-center gap-1.5">
                  <Badge variant={INTENT_VARIANT[action.intent]}>{action.intent}</Badge>
                  <span className="min-w-0 break-words">{action.label}</span>
                </span>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-1" data-testid="issue-detail-rail-result">
            <h4 className="font-semibold text-muted-foreground">结果</h4>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground">status</span>
              {turn.status === null ? (
                <span className="text-muted-foreground">{EMPTY}</span>
              ) : (
                <Badge variant={statusVariant(turn.status)}>{turn.status}</Badge>
              )}
              {turn.failureClass === null ? null : <Badge variant="danger">{turn.failureClass}</Badge>}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground">任务</span>
              {turn.taskId === null ? (
                <span className="text-muted-foreground">{EMPTY}</span>
              ) : (
                <Link
                  className="font-mono underline underline-offset-2"
                  to={`/tasks/${encodeURIComponent(turn.taskId)}`}
                >
                  {turn.taskId}
                </Link>
              )}
            </div>
            <time className="text-muted-foreground" title={time.title}>
              {time.text}
            </time>
          </section>

          <section className="flex flex-col gap-1" data-testid="issue-detail-rail-labels">
            <h4 className="font-semibold text-muted-foreground">标签</h4>
            {turn.labels.length === 0 ? (
              <span className="text-muted-foreground">本轮没有打标</span>
            ) : (
              <div className="flex flex-wrap items-center gap-1">
                {turn.labels.map((label) => (
                  <Badge key={label} variant="secondary">
                    {label}
                  </Badge>
                ))}
              </div>
            )}
          </section>
        </CardContent>
      ) : null}
    </Card>
  );
}
