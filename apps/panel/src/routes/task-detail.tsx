import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { AsyncSection } from '../components/AsyncSection.tsx';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx';
import { Badge, statusVariant } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.tsx';
import { Tabs, type TabItem } from '../components/ui/tabs.tsx';
import type { TaskDetailResponse } from '../lib/contract.ts';
import { EMPTY, formatCount, formatDuration, formatTimeCell, formatTokens, formatUsd } from '../lib/format.ts';
import { useTaskDetail } from '../lib/queries.ts';
import { NotFoundPage } from './not-found.tsx';
import { PageShell } from './PageShell.tsx';

/**
 * 任务详情（S3，数据源 `/api/tasks/:id`，每 5s 轮询——任务可能正在跑，tech-plan §9.4）。
 *
 * 三段式（tech-plan §9.3），每一段都有明确的「读什么」：
 *
 *  1. **事件时间线**：按 `cursor` 升序。`approval` 类事件必须把 `decision`（allow/deny）
 *     与 `rule` / `reason` 一起显示——「被拒了但不知道为什么」等于没有审计。
 *  2. **信封 JSON**：`verdict` / `evidence` / `actions` 三栏并排。两件必须被标出来的事：
 *     - 信封 `valid: false`（`verdict` 为 null）→ 这一封结论不可信；
 *     - 动作的写回闸门摘要里 `dropped` 非空（`declared` 之外的文件被丢弃）→ 越界。
 *  3. **diff**：等宽 + 行号；长行可切「折行 / 横向滚动」，`truncated`（>200 KB）显式提示。
 *
 * 404 走 `useTaskDetail` 的 `null` 约定（`/api/tasks/:id` 的 404 是正常业务态），
 * 页面显示「任务不存在」，不是空白也不弹错误。
 */
export function TaskDetailPage() {
  const params = useParams();
  const id = params['id'] ?? '';

  if (id === '') {
    return <NotFoundPage />;
  }

  return <TaskDetail id={id} />;
}

/** 事件类型的展示文案（契约 §3 的十个 `kind`，不做技术 id 直出）。 */
const EVENT_KIND_LABEL: Record<TaskDetailResponse['events'][number]['kind'], string> = {
  session: '会话',
  turn: '回合',
  'tool-call': '工具调用',
  approval: '审批',
  command: '命令',
  sandbox: '沙箱',
  envelope: '信封',
  action: '动作',
  writeback: '写回',
  notice: '通知',
};

/** 动作的写回意图文案。 */
const INTENT_LABEL: Record<TaskDetailResponse['actions'][number]['intent'], string> = {
  comment: '评论',
  label: '标签',
  create_issue: '建 issue',
  push_branch: '推分支',
  close_issue: '关闭 issue',
};

/** 从事件 payload 里安全取字符串（`payload` 是 `Record<string, unknown>`，不能直接点）。 */
function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function TaskDetail({ id }: { id: string }) {
  const { data, error, isLoading } = useTaskDetail(id);
  // 404：hook 把 status 404 规约成 null，所以「不是错误 + 没有数据」= 任务不存在
  const missing = !isLoading && error === null && data === null;

  return (
    <PageShell
      title="任务详情"
      description={`任务 ${id} · 每 5 秒刷新`}
      actions={
        <Link className="text-xs text-muted-foreground underline-offset-2 hover:underline" to="/tasks">
          返回任务列表
        </Link>
      }
    >
      <AsyncSection isLoading={isLoading} error={error} testId="task-detail" skeletonHeight="h-48">
        {missing ? (
          <MissingTask id={id} />
        ) : data === null || data === undefined ? null : (
          <TaskDetailBody data={data} />
        )}
      </AsyncSection>
    </PageShell>
  );
}

/** 404：明确说「不存在」并给出下一步，而不是留一块空白。 */
function MissingTask({ id }: { id: string }) {
  return (
    <Alert variant="warning" data-testid="task-detail-missing">
      <AlertTitle>任务不存在</AlertTitle>
      <AlertDescription>
        找不到任务 <span className="font-mono">{id}</span>
        ：可能已被保留期清理（`run_event`/`transcript` 默认 90 天），或链接里的 id 拼错了。
        <span className="mt-2 block">
          <Link className="underline underline-offset-2" to="/tasks">
            回到任务列表
          </Link>
        </span>
      </AlertDescription>
    </Alert>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={mono ? 'min-w-0 break-all font-mono' : 'min-w-0 break-words'} title={value}>
        {value}
      </span>
    </div>
  );
}

function TaskDetailBody({ data }: { data: TaskDetailResponse }) {
  const task = data.task;

  const tabs: TabItem[] = [
    {
      key: 'events',
      label: '事件时间线',
      count: data.events.length,
      content: <EventTimeline events={data.events} />,
    },
    {
      key: 'envelopes',
      label: '信封 JSON',
      count: data.envelopes.length,
      content: <EnvelopesSection envelopes={data.envelopes} actions={data.actions} />,
    },
    {
      key: 'diff',
      label: 'diff',
      content: <DiffSection diff={data.diff} />,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">{task.repo}</span>
            <span className="font-mono text-xs text-muted-foreground">
              {task.targetKind}#{formatCount(task.targetNumber)}
            </span>
            <Badge variant={statusVariant(task.status)}>{task.status}</Badge>
            <Badge variant="outline">{task.command}</Badge>
            {task.failureClass === null ? null : <Badge variant="danger">{task.failureClass}</Badge>}
            {task.dryRun ? <Badge variant="outline">dry-run</Badge> : null}
          </CardTitle>
          <CardDescription>
            本次运行耗时 {formatDuration(task.durationMs)} · 成本 {formatUsd(task.costUsd)} ·
            入队 <time title={formatTimeCell(task.queuedAt).title}>{formatTimeCell(task.queuedAt).text}</time>
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3 xl:grid-cols-5">
          <Field label="命令" value={task.command} mono />
          <Field label="提交 sha" value={task.headSha ?? EMPTY} mono />
          <Field label="触发人" value={task.actorLogin ?? EMPTY} />
          <Field label="outcome" value={task.outcome ?? EMPTY} />
          <Field label="failure_class" value={task.failureClass ?? EMPTY} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>执行尝试（{formatCount(data.runs.length)}）</CardTitle>
          <CardDescription>重试会新增一条 run；`failure_detail` 只给审计看，不在这里展开</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 font-mono text-xs">
          {data.runs.length === 0 ? (
            <p className="font-sans text-muted-foreground">还没有 run（任务可能还在排队）</p>
          ) : (
            data.runs.map((run) => (
              <div key={run.id} className="flex flex-wrap items-center gap-2">
                <span className="w-6 text-right text-muted-foreground">#{formatCount(run.attempt)}</span>
                <span>{run.id}</span>
                <Badge variant={statusVariant(run.outcome ?? EMPTY)}>{run.outcome ?? EMPTY}</Badge>
                {run.failureClass === null ? null : <Badge variant="danger">{run.failureClass}</Badge>}
                <span className="text-muted-foreground">
                  {formatTimeCell(run.startedAt).text} → {formatTimeCell(run.endedAt).text}
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Tabs items={tabs} />
    </div>
  );
}

function EventTimeline({ events }: { events: TaskDetailResponse['events'] }) {
  if (events.length === 0) {
    return (
      <Card>
        <CardContent className="text-sm text-muted-foreground">还没有事件（worker 没开始跑？）</CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>事件（按 cursor 升序，最多 500 条）</CardTitle>
        <CardDescription>审批事件把 allow/deny 与规则、理由一起显示</CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-1.5 text-xs" data-testid="task-detail-events">
          {events.map((event) => {
            const kindLabel = EVENT_KIND_LABEL[event.kind];
            const decision = payloadString(event.payload, 'decision');
            const rule = payloadString(event.payload, 'rule');
            const reason = payloadString(event.payload, 'reason');
            const tool = payloadString(event.payload, 'tool');

            return (
              <li
                key={`${event.runId}-${String(event.cursor)}`}
                className="flex flex-wrap items-baseline gap-2 border-b border-border/60 pb-1.5 last:border-0"
                data-testid={`task-detail-event-${event.kind}`}
              >
                <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">
                  {formatCount(event.cursor)}
                </span>
                <Badge variant="muted">{kindLabel}</Badge>
                <time
                  className="shrink-0 text-muted-foreground"
                  title={formatTimeCell(event.at).title}
                >
                  {formatTimeCell(event.at).text}
                </time>
                {event.kind === 'approval' ? (
                  <>
                    <Badge variant={decision === 'allow' ? 'success' : 'danger'}>
                      {tool ?? '审批'} · {decision ?? '未知判定'}
                    </Badge>
                    {rule === null ? null : (
                      <span className="font-mono text-muted-foreground">rule={rule}</span>
                    )}
                    {reason === null ? null : <span className="min-w-0 flex-1 break-all">{reason}</span>}
                  </>
                ) : (
                  <span className="min-w-0 flex-1 break-all font-mono text-muted-foreground">
                    {JSON.stringify(event.payload)}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

function EnvelopesSection({
  envelopes,
  actions,
}: {
  envelopes: TaskDetailResponse['envelopes'];
  actions: TaskDetailResponse['actions'];
}) {
  const invalidCount = envelopes.filter((envelope) => !envelope.valid).length;

  if (envelopes.length === 0) {
    return (
      <Card>
        <CardContent className="text-sm text-muted-foreground">
          这个任务没有信封（没跑到产出阶段，或 worker 未落库）
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="task-detail-envelopes">
      {invalidCount > 0 ? (
        <Alert variant="destructive">
          <AlertTitle>有 {formatCount(invalidCount)} 封信封校验失败</AlertTitle>
          <AlertDescription>
            校验失败的信封 `verdict` 为 null：这一轮产出的结论不可信，写回也被闸门挡住（见各封的 actions 栏）。
          </AlertDescription>
        </Alert>
      ) : null}

      {envelopes.map((envelope) => {
        const runActions = actions.filter((action) => action.runId === envelope.runId);
        const droppedFiles = runActions.flatMap((action) => action.audit?.dropped ?? []);

        return (
          <Card key={envelope.runId}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">run {envelope.runId}</span>
                <Badge variant={envelope.valid ? 'success' : 'danger'}>
                  {envelope.valid ? '校验通过' : '校验失败'}
                </Badge>
                <span className="text-xs font-normal text-muted-foreground">
                  动作 {formatCount(envelope.actionCount)} · token{' '}
                  {formatTokens(envelope.usage.inputTokens)}/{formatTokens(envelope.usage.outputTokens)} ·{' '}
                  {formatUsd(envelope.usage.costUsd)}
                </span>
              </CardTitle>
              {droppedFiles.length === 0 ? null : (
                <CardDescription>
                  <span className="text-destructive">
                    闸门丢弃 {formatCount(droppedFiles.length)} 个越界文件：{droppedFiles.join('、')}
                  </span>
                </CardDescription>
              )}
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-4 text-xs lg:grid-cols-3">
              <section>
                <h4 className="mb-1 font-semibold">verdict</h4>
                {envelope.verdict === null ? (
                  <p className="text-destructive">没有 verdict（信封校验失败或模型未产出）</p>
                ) : (
                  <div className="flex flex-col gap-1">
                    <span className="font-mono text-muted-foreground">kind={envelope.verdict.kind}</span>
                    <span className="flex flex-wrap gap-1">
                      {envelope.verdict.labels.length === 0 ? (
                        <span className="text-muted-foreground">没有标签</span>
                      ) : (
                        envelope.verdict.labels.map((label) => (
                          <Badge key={label} variant="outline">
                            {label}
                          </Badge>
                        ))
                      )}
                    </span>
                  </div>
                )}
              </section>

              <section>
                <h4 className="mb-1 font-semibold">evidence</h4>
                {envelope.verdict === null || envelope.verdict.evidence.length === 0 ? (
                  <p className="text-muted-foreground">没有证据项</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {envelope.verdict.evidence.map((item) => (
                      <li key={item.rule} className="flex flex-wrap items-baseline gap-1.5">
                        <Badge
                          variant={item.passed === null ? 'muted' : item.passed ? 'success' : 'danger'}
                        >
                          {item.passed === null ? '未判定' : item.passed ? '通过' : '不通过'}
                        </Badge>
                        <span className="font-mono text-muted-foreground">{item.rule}</span>
                        <span className="min-w-0 break-words">{item.quote}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <h4 className="mb-1 font-semibold">actions</h4>
                {runActions.length === 0 ? (
                  <p className="text-muted-foreground">这个 run 没有动作</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {runActions.map((action) => {
                      const audit = action.audit;
                      return (
                        <li
                          key={action.id}
                          className={
                            audit !== null && audit.dropped.length > 0
                              ? 'rounded-md border border-destructive/50 px-2 py-1'
                              : 'rounded-md border border-border px-2 py-1'
                          }
                        >
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant="outline">{INTENT_LABEL[action.intent]}</Badge>
                            <Badge variant={statusVariant(action.status)}>{action.status}</Badge>
                            <span className="font-mono text-muted-foreground">
                              {action.target.kind}
                              {action.target.number === null ? '' : `#${formatCount(action.target.number)}`}
                              {action.target.ref === null ? '' : ` ${action.target.ref}`}
                            </span>
                          </div>
                          {audit === null ? null : (
                            <div className="mt-1 flex flex-col gap-0.5">
                              <span className="text-muted-foreground">
                                闸门：声明 {formatCount(audit.declared.length)} · 实际{' '}
                                {formatCount(audit.actual.length)} · 交集{' '}
                                {formatCount(audit.intersect.length)} · 丢弃{' '}
                                {formatCount(audit.dropped.length)}
                              </span>
                              {audit.dropped.length === 0 ? null : (
                                <span className="break-all font-mono text-destructive">
                                  越界：{audit.dropped.join('、')}
                                </span>
                              )}
                              {audit.rejectedReason === null ? null : (
                                <span className="font-mono text-destructive">
                                  rejected_reason={audit.rejectedReason}
                                </span>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

/** diff 行配色：只用 shadcn 变量 + 图表变量（没有 `--success`，用 `--chart-2`）。 */
function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-muted-foreground';
  if (line.startsWith('+')) return 'text-chart-2';
  if (line.startsWith('-')) return 'text-destructive';
  if (line.startsWith('@@')) return 'text-muted-foreground bg-muted';
  return 'text-foreground';
}

function DiffSection({ diff }: { diff: TaskDetailResponse['diff'] }) {
  // 折行默认开：详情页的读者通常先「看懂」再「抠空格」，长行溢出反而看不见内容
  const [wrap, setWrap] = useState(true);
  const lines = useMemo(() => {
    const rows = (diff.text ?? '').split('\n');
    if (rows.at(-1) === '') rows.pop();
    return rows;
  }, [diff.text]);

  if (!diff.available || diff.text === null) {
    return (
      <Card>
        <CardContent className="text-sm text-muted-foreground">
          没有 diff：任务没有改工作区（只读结论类命令），或 worker 未落库
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          worktree diff
          <Badge variant="outline">
            {formatCount(lines.length)} 行
          </Badge>
          {diff.truncated ? <Badge variant="warning">已截断（超过 200 KB）</Badge> : null}
          <Button variant="outline" size="sm" onClick={() => setWrap((current) => !current)}>
            {wrap ? '不折行（横向滚动）' : '折行'}
          </Button>
        </CardTitle>
        <CardDescription className="font-mono">
          base {diff.baseSha ?? EMPTY} → head {diff.headSha ?? EMPTY}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div
          className="max-h-[32rem] overflow-auto rounded-md border border-border bg-muted/30 py-2 font-mono text-xs leading-relaxed"
          data-testid="task-detail-diff"
        >
          {lines.map((line, index) => (
            <div key={`diff-${String(index)}`} className="flex">
              <span className="w-12 shrink-0 select-none pr-3 text-right tabular-nums text-muted-foreground">
                {formatCount(index + 1)}
              </span>
              <span
                className={
                  wrap
                    ? `min-w-0 flex-1 whitespace-pre-wrap break-all ${diffLineClass(line)}`
                    : `shrink-0 whitespace-pre ${diffLineClass(line)}`
                }
              >
                {line === '' ? ' ' : line}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
