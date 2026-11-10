import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { AsyncSection } from '../components/AsyncSection.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Section } from '../components/Section.tsx';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx';
import { Badge, StatusDot } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { statusTone, TONE_TEXT } from '../components/ui/status.ts';
import type { TaskDetailResponse } from '../lib/contract.ts';
import { EMPTY, formatCount, formatDuration, formatTokens, formatUsd, formatTimeCell } from '../lib/format.ts';
import { useTaskDetail } from '../lib/queries.ts';
import { repoRunsPath, useRepoRoute } from '../lib/repo-route.ts';
import { cn } from '../lib/utils.ts';
import { NotFoundPage } from './not-found.tsx';
import { repoCrumbs } from './RepoPageFrame.tsx';

/**
 * 运行详情（`/repos/:repo/runs/:id`，数据源 `/api/tasks/:id`，5s 轮询——任务可能正在跑）。
 *
 * 布局是**两栏**：左边「时间线」（执行尝试 runs，一次尝试一行，状态点 + 起止 + 失败分类），
 * 右边「事件流」（`run_events` 按 cursor 升序，审批类事件把 decision/rule/reason 一起显示）。
 * 其下是全宽的「信封与动作」与「diff」——两者都是长内容，塞进半栏只会横向溢出。
 *
 * 三件必须被标出来的事：
 *  - 信封 `valid: false` → 这一封结论不可信（红色 Alert）；
 *  - 写回闸门 `audit.dropped` 非空 → 越界文件被丢弃；
 *  - diff `truncated`（>200 KB）→ 只显示截断部分。
 *
 * 404 走 `useTaskDetail` 的 `null` 约定（`/api/tasks/:id` 的 404 是正常业务态）。
 */
export function TaskDetailPage() {
  const params = useParams();
  const id = params['id'] ?? '';
  if (id === '') return <NotFoundPage />;
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
  const { repo } = useRepoRoute();
  const { data, error, isLoading, refetch } = useTaskDetail(id);
  // 404：hook 把 status 404 规约成 null，所以「不是错误 + 没有数据」= 任务不存在
  const missing = !isLoading && error === null && data === null;
  const task = data?.task;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader
        testId="task-detail-header"
        breadcrumb={repo === null ? undefined : repoCrumbs(repo, [{ label: '运行', to: repoRunsPath(repo) }, { label: id }])}
        title={
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="min-w-0 break-all font-mono text-sm">{task?.command ?? `运行 ${id}`}</span>
            <span className="min-w-0 break-all font-mono text-xs text-muted-foreground">{`${id}`}</span>
          </span>
        }
        description={task === undefined ? undefined : `${task.targetKind}#${formatCount(task.targetNumber)}`}
        badges={
          task === undefined ? undefined : (
            <>
              <Badge tone={statusTone(task.status)} dot>
                {task.status}
              </Badge>
              {task.failureClass === null ? null : <Badge tone="danger">{task.failureClass}</Badge>}
              {task.outcome === null ? null : <Badge tone={statusTone(task.outcome)}>{task.outcome}</Badge>}
              {task.dryRun ? <Badge tone="warn">dry-run</Badge> : null}
              <Badge tone="neutral">{`耗时 ${formatDuration(task.durationMs)}`}</Badge>
              <Badge tone="neutral">{`成本 ${formatUsd(task.costUsd)}`}</Badge>
            </>
          )
        }
        actions={
          <Link
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            to={repo === null ? '/audit' : repoRunsPath(repo)}
          >
            {repo === null ? '返回审计' : '返回运行列表'}
          </Link>
        }
      />

      <AsyncSection
        isLoading={isLoading}
        error={error}
        isEmpty={missing}
        emptyText="任务不存在"
        emptyHint="可能已被保留期清理（run_event / transcript 默认 90 天），或链接里的 id 拼错了。"
        emptyAction={
          <Link
            className="mt-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            to={repo === null ? '/audit' : repoRunsPath(repo)}
          >
            {repo === null ? '回到审计' : '回到运行列表'}
          </Link>
        }
        onRetry={() => {
          void refetch();
        }}
        skeletonRows={6}
        testId="task-detail"
      >
        {data === null || data === undefined ? null : <TaskDetailBody data={data} />}
      </AsyncSection>
    </div>
  );
}

function TaskDetailBody({ data }: { data: TaskDetailResponse }) {
  const task = data.task;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {/* 两栏：左时间线（执行尝试）· 右事件流 */}
      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <Section first title="时间线" className="min-w-0">
          <ol className="flex min-w-0 flex-col gap-2" data-testid="task-detail-runs">
            <li className="flex min-w-0 items-center gap-2 text-xs">
              <StatusDot tone={statusTone(task.status)} label={task.status} pulse={task.status === 'running'} />
              <span className={cn('text-xs font-medium', TONE_TEXT[statusTone(task.status)])}>{task.status}</span>
              <span className="text-2xs text-faint">入队</span>
              <time className="ml-auto text-2xs text-faint" title={formatTimeCell(task.queuedAt).title}>
                {formatTimeCell(task.queuedAt).text}
              </time>
            </li>
            {data.runs.length === 0 ? (
              <li className="text-xs text-muted-foreground">还没有 run（任务可能还在排队）</li>
            ) : (
              data.runs.map((run) => {
                const tone = statusTone(run.outcome ?? run.failureClass ?? 'queued');
                return (
                  <li key={run.id} className="flex min-w-0 flex-col gap-0.5 border-l border-border pl-3">
                    <span className="flex min-w-0 items-center gap-1.5 text-xs">
                      <StatusDot tone={tone} />
                      <span className="text-faint tabular">{`#${formatCount(run.attempt)}`}</span>
                      <span className="min-w-0 truncate font-mono" title={run.id}>
                        {run.id}
                      </span>
                    </span>
                    <span className="flex min-w-0 flex-wrap items-center gap-1 text-2xs text-faint">
                      <span>{run.outcome ?? '未结束'}</span>
                      {run.failureClass === null ? null : <span className="text-danger-fg">{run.failureClass}</span>}
                      <time title={formatTimeCell(run.startedAt).title}>
                        {`${formatTimeCell(run.startedAt).text} → ${formatTimeCell(run.endedAt).text}`}
                      </time>
                    </span>
                  </li>
                );
              })
            )}
          </ol>
          <dl className="mt-2 grid min-w-0 grid-cols-2 gap-x-2 gap-y-1 border-t border-border pt-2 text-xs">
            <Field label="命令" value={task.command} mono />
            <Field label="提交 sha" value={task.headSha === null ? EMPTY : task.headSha.slice(0, 7)} mono />
            <Field label="触发人" value={task.actorLogin ?? EMPTY} />
            <Field label="outcome" value={task.outcome ?? EMPTY} />
            <Field label="failure_class" value={task.failureClass ?? EMPTY} />
            <Field label="dry-run" value={task.dryRun ? '是（不写 GitHub）' : '否'} />
          </dl>
        </Section>

        <Section first title="事件流" description="最多 500 条（按 cursor 升序）" className="min-w-0">
          {data.events.length === 0 ? (
            <p className="text-xs text-muted-foreground">还没有事件（worker 没开始跑？）</p>
          ) : (
            <ol className="flex min-w-0 flex-col gap-1 text-xs" data-testid="task-detail-events">
              {data.events.map((event) => {
                const decision = payloadString(event.payload, 'decision');
                const rule = payloadString(event.payload, 'rule');
                const reason = payloadString(event.payload, 'reason');
                const tool = payloadString(event.payload, 'tool');

                return (
                  <li
                    key={`${event.runId}-${String(event.cursor)}`}
                    className="flex min-w-0 flex-wrap items-baseline gap-2 border-b border-border py-1 last:border-0"
                    data-testid={`task-detail-event-${event.kind}`}
                  >
                    <span className="w-8 shrink-0 text-right tabular text-faint">{formatCount(event.cursor)}</span>
                    <Badge tone="neutral">{EVENT_KIND_LABEL[event.kind]}</Badge>
                    <time className="shrink-0 text-2xs text-faint" title={formatTimeCell(event.at).title}>
                      {formatTimeCell(event.at).text}
                    </time>
                    {event.kind === 'approval' ? (
                      <>
                        <Badge tone={decision === 'allow' ? 'success' : 'danger'}>
                          {`${tool ?? '审批'} · ${decision ?? '未知判定'}`}
                        </Badge>
                        {rule === null ? null : <span className="font-mono text-2xs text-muted-foreground">{`rule=${rule}`}</span>}
                        {reason === null ? null : <span className="min-w-0 flex-1 break-all">{reason}</span>}
                      </>
                    ) : (
                      <span className="min-w-0 flex-1 break-all font-mono text-2xs text-muted-foreground" title={JSON.stringify(event.payload)}>
                        {JSON.stringify(event.payload)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </Section>
      </div>

      <EnvelopesSection envelopes={data.envelopes} actions={data.actions} />
      <DiffSection diff={data.diff} />
    </div>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-2xs text-faint">{label}</dt>
      <dd className={cn('min-w-0 truncate text-muted-foreground', mono && 'font-mono')} title={value}>
        {value}
      </dd>
    </div>
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

  return (
    <Section
      title="信封与动作"
      actions={<span className="text-2xs tabular text-faint">{`${formatCount(envelopes.length)} 封`}</span>}
    >
      {envelopes.length === 0 ? (
        <p className="text-xs text-muted-foreground">这个任务没有信封（没跑到产出阶段，或 worker 未落库）</p>
      ) : (
        <div className="flex min-w-0 flex-col gap-3" data-testid="task-detail-envelopes">
          {invalidCount > 0 ? (
            <Alert variant="destructive">
              <AlertTitle>{`有 ${formatCount(invalidCount)} 封信封校验失败`}</AlertTitle>
              <AlertDescription>
                校验失败的信封 verdict 为 null：这一轮产出的结论不可信，写回也被闸门挡住（见各封的 actions 栏）。
              </AlertDescription>
            </Alert>
          ) : null}

          {envelopes.map((envelope) => {
            const runActions = actions.filter((action) => action.runId === envelope.runId);
            const droppedFiles = runActions.flatMap((action) => action.audit?.dropped ?? []);

            return (
              <div key={envelope.runId} className="flex min-w-0 flex-col gap-2 border-t border-border pt-2 first:border-0 first:pt-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
                  <span className="font-mono text-xs">{`run ${envelope.runId}`}</span>
                  <Badge tone={envelope.valid ? 'success' : 'danger'}>{envelope.valid ? '校验通过' : '校验失败'}</Badge>
                  <span className="text-2xs text-faint">
                    {`动作 ${formatCount(envelope.actionCount)} · token ${formatTokens(envelope.usage.inputTokens)}/${formatTokens(envelope.usage.outputTokens)} · ${formatUsd(envelope.usage.costUsd)}`}
                  </span>
                  {droppedFiles.length === 0 ? null : (
                    <span className="text-2xs text-danger-fg">{`闸门丢弃 ${formatCount(droppedFiles.length)} 个越界文件`}</span>
                  )}
                </div>

                <div className="grid min-w-0 grid-cols-1 gap-4 text-xs lg:grid-cols-3">
                  <section className="min-w-0">
                    <h4 className="micro-label mb-1">verdict</h4>
                    {envelope.verdict === null ? (
                      <p className="text-danger-fg">没有 verdict（信封校验失败或模型未产出）</p>
                    ) : (
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="font-mono text-faint">{`kind=${envelope.verdict.kind}`}</span>
                        <span className="flex flex-wrap gap-1">
                          {envelope.verdict.labels.length === 0 ? (
                            <span className="text-muted-foreground">没有标签</span>
                          ) : (
                            envelope.verdict.labels.map((label) => (
                              <Badge key={label} tone="neutral">
                                {label}
                              </Badge>
                            ))
                          )}
                        </span>
                      </div>
                    )}
                  </section>

                  <section className="min-w-0">
                    <h4 className="micro-label mb-1">evidence</h4>
                    {envelope.verdict === null || envelope.verdict.evidence.length === 0 ? (
                      <p className="text-muted-foreground">没有证据项</p>
                    ) : (
                      <ul className="flex min-w-0 flex-col gap-1">
                        {envelope.verdict.evidence.map((item) => (
                          <li key={item.rule} className="flex min-w-0 flex-wrap items-baseline gap-1.5">
                            <Badge tone={item.passed === null ? 'neutral' : item.passed ? 'success' : 'danger'}>
                              {item.passed === null ? '未判定' : item.passed ? '通过' : '不通过'}
                            </Badge>
                            <span className="font-mono text-2xs text-faint">{item.rule}</span>
                            <span className="min-w-0 break-words">{item.quote}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  <section className="min-w-0">
                    <h4 className="micro-label mb-1">actions</h4>
                    {runActions.length === 0 ? (
                      <p className="text-muted-foreground">这个 run 没有动作</p>
                    ) : (
                      <ul className="flex min-w-0 flex-col gap-1.5">
                        {runActions.map((action) => {
                          const audit = action.audit;
                          return (
                            <li
                              key={action.id}
                              className={cn(
                                'flex min-w-0 flex-col gap-0.5 border-l-2 pl-2',
                                audit !== null && audit.dropped.length > 0 ? 'border-danger' : 'border-border',
                              )}
                            >
                              <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                                <Badge tone="neutral">{INTENT_LABEL[action.intent]}</Badge>
                                <Badge tone={statusTone(action.status)}>{action.status}</Badge>
                                <span className="min-w-0 truncate font-mono text-2xs text-faint">
                                  {action.target.kind}
                                  {action.target.number === null ? '' : `#${formatCount(action.target.number)}`}
                                  {action.target.ref === null ? '' : ` ${action.target.ref}`}
                                </span>
                              </span>
                              {audit === null ? null : (
                                <span className="text-2xs text-faint">
                                  {`闸门：声明 ${formatCount(audit.declared.length)} · 实际 ${formatCount(audit.actual.length)} · 交集 ${formatCount(audit.intersect.length)} · 丢弃 ${formatCount(audit.dropped.length)}`}
                                </span>
                              )}
                              {audit === null || audit.dropped.length === 0 ? null : (
                                <span className="break-all font-mono text-2xs text-danger-fg">{`越界：${audit.dropped.join('、')}`}</span>
                              )}
                              {audit === null || audit.rejectedReason === null ? null : (
                                <span className="break-all font-mono text-2xs text-danger-fg">{`rejected_reason=${audit.rejectedReason}`}</span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </section>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

/** diff 行配色：只用语义令牌（新增用 `--success-fg`，删除用 `--danger-fg`）。 */
function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-faint';
  if (line.startsWith('+')) return 'text-success-fg';
  if (line.startsWith('-')) return 'text-danger-fg';
  if (line.startsWith('@@')) return 'bg-muted text-muted-foreground';
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
      <Section title="diff">
        <p className="text-xs text-muted-foreground">没有 diff：任务没有改工作区（只读结论类命令），或 worker 未落库</p>
      </Section>
    );
  }

  return (
    <Section
      title="diff"
      description={`base ${diff.baseSha ?? EMPTY} → head ${diff.headSha ?? EMPTY}`}
      actions={
        <>
          <Badge tone="neutral">{`${formatCount(lines.length)} 行`}</Badge>
          {diff.truncated ? <Badge tone="warn">已截断（超过 200 KB）</Badge> : null}
          <Button variant="secondary" size="sm" onClick={() => setWrap((current) => !current)}>
            {wrap ? '不折行（横向滚动）' : '折行'}
          </Button>
        </>
      }
    >
      <div
        className="max-h-[32rem] overflow-auto rounded-lg border border-border bg-muted/30 py-2 font-mono text-xs leading-relaxed"
        data-testid="task-detail-diff"
      >
        {lines.map((line, index) => (
          <div key={`diff-${String(index)}`} className="flex min-w-0">
            <span className="w-12 shrink-0 select-none pr-3 text-right tabular text-faint">{formatCount(index + 1)}</span>
            <span
              className={cn(
                'min-w-0',
                wrap ? 'flex-1 break-all whitespace-pre-wrap' : 'shrink-0 whitespace-pre',
                diffLineClass(line),
              )}
            >
              {line === '' ? ' ' : line}
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}
