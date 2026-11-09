import { useParams } from 'react-router';
import { AsyncSection } from '../components/AsyncSection.tsx';
import { Badge, statusVariant } from '../components/ui/badge.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.tsx';
import { Tabs, type TabItem } from '../components/ui/tabs.tsx';
import { formatDuration, formatTimeCell, formatUsd } from '../lib/format.ts';
import { useTaskDetail } from '../lib/queries.ts';
import { NotFoundPage } from './not-found.tsx';
import { PageShell } from './PageShell.tsx';

/**
 * 任务详情（S3，数据源 `/api/tasks/:id`，每 5s 轮询——可能在跑）。
 *
 * 三段式（tech-plan §9.3）：事件时间线 · 信封（verdict/evidence/actions）· diff。
 * P0 已把三段都接上真数据，等宽显示原文；W3-K 继续做的是 diff 的折叠与语法高亮。
 */
export function TaskDetailPage() {
  const params = useParams();
  const id = params['id'] ?? '';

  if (id === '') {
    return <NotFoundPage />;
  }

  return <TaskDetail id={id} />;
}

function TaskDetail({ id }: { id: string }) {
  const { data, error, isLoading } = useTaskDetail(id);

  const tabs: TabItem[] =
    data === null || data === undefined
      ? []
      : [
          {
            key: 'events',
            label: '事件时间线',
            count: data.events.length,
            content: (
              <Card>
                <CardHeader>
                  <CardTitle>事件（按 cursor 升序，最多 500 条）</CardTitle>
                </CardHeader>
                <CardContent>
                  {data.events.length === 0 ? (
                    <p className="text-sm text-muted-foreground">还没有事件</p>
                  ) : (
                    <ul className="flex flex-col gap-1 font-mono text-xs">
                      {data.events.map((event) => (
                        <li key={`${event.runId}-${String(event.cursor)}`} className="flex gap-3">
                          <span className="w-8 text-right text-muted-foreground">{event.cursor}</span>
                          <Badge variant="muted">{event.kind}</Badge>
                          <span className="text-muted-foreground">{formatTimeCell(event.at).text}</span>
                          <span className="min-w-0 flex-1 break-all text-muted-foreground">
                            {JSON.stringify(event.payload)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            ),
          },
          {
            key: 'envelopes',
            label: '信封',
            count: data.envelopes.length,
            content: (
              <div className="flex flex-col gap-3">
                {data.envelopes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">这个任务没有信封（没跑到产出阶段）</p>
                ) : (
                  data.envelopes.map((envelope) => (
                    <Card key={envelope.runId}>
                      <CardHeader>
                        <CardTitle>
                          run {envelope.runId} · {envelope.valid ? '校验通过' : '校验失败'} ·{' '}
                          {envelope.actionCount} 个动作
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <pre className="overflow-x-auto text-xs">
                          {JSON.stringify(
                            { verdict: envelope.verdict, usage: envelope.usage },
                            null,
                            2,
                          )}
                        </pre>
                      </CardContent>
                    </Card>
                  ))
                )}
              </div>
            ),
          },
          {
            key: 'diff',
            label: 'diff',
            content: (
              <Card>
                <CardHeader>
                  <CardTitle>
                    worktree diff{data.diff.truncated ? '（超过 200 KB，已截断）' : ''}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {data.diff.available && data.diff.text !== null ? (
                    <pre className="max-h-96 overflow-auto text-xs leading-relaxed">{data.diff.text}</pre>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      没有 diff（任务没有改工作区，或 worker 未落库）
                    </p>
                  )}
                </CardContent>
              </Card>
            ),
          },
        ];

  return (
    <PageShell title="任务详情" description={`任务 ${id} · 每 5 秒刷新`}>
      <AsyncSection
        isLoading={isLoading}
        error={error}
        isEmpty={data === null || data === undefined}
        emptyText="任务不存在（可能已被保留期清理）"
        testId="task-detail"
        skeletonHeight="h-48"
      >
        {data === null || data === undefined ? null : (
          <div className="flex flex-col gap-3">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <span className="font-mono text-xs">{data.task.repo}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {data.task.targetKind}#{String(data.task.targetNumber)}
                  </span>
                  <Badge variant={statusVariant(data.task.status)}>{data.task.status}</Badge>
                  {data.task.failureClass === null ? null : (
                    <Badge variant="danger">{data.task.failureClass}</Badge>
                  )}
                  {data.task.dryRun ? <Badge variant="outline">dry-run</Badge> : null}
                </CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <Field label="命令" value={data.task.command} mono />
                <Field label="触发人" value={data.task.actorLogin ?? '—'} />
                <Field label="提交" value={data.task.headSha ?? '—'} mono />
                <Field label="耗时" value={formatDuration(data.task.durationMs)} />
                <Field label="成本" value={formatUsd(data.task.costUsd)} />
                <Field label="入队" value={formatTimeCell(data.task.queuedAt).title} />
                <Field label="开始" value={formatTimeCell(data.task.startedAt).title} />
                <Field label="结束" value={formatTimeCell(data.task.endedAt).title} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>执行尝试（{data.runs.length}）</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-1 font-mono text-xs">
                {data.runs.length === 0 ? (
                  <p className="text-muted-foreground">还没有 run</p>
                ) : (
                  data.runs.map((run) => (
                    <div key={run.id} className="flex flex-wrap items-center gap-2">
                      <span className="w-6 text-right text-muted-foreground">{run.attempt}</span>
                      <span>{run.id}</span>
                      <Badge variant={statusVariant(run.outcome ?? '—')}>{run.outcome ?? '—'}</Badge>
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
        )}
      </AsyncSection>
    </PageShell>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={mono ? 'font-mono' : undefined}>{value}</span>
    </div>
  );
}
