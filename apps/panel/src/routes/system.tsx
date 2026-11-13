/**
 * 系统（`/api/system`，每 15s 轮询）—— 一屏三块 + 两条清单：
 *
 *  1. **版本与协议**（含 pi-host 状态与「降级条件」逐条展开）；
 *  2. **doctor 逐项**（按 fail → warn → ok → skip 分组，失败项把 detail 摊开）；
 *  3. **队列与保留策略**（队列是真在排队的量，保留期是 cron 的清理窗口）；
 *  4. **仓库**（对象行，只读；写入口链接到设置页）；
 *  5. **能力（skills）**（契约里唯一的技能清单）。
 *
 * 面板只做展示、不做判断：`version.host` 为 `null`、doctor 没跑过，都如实显示 `—` / `还没跑过`，
 * 不假装正常（tech-plan §11 R10 的「半升级状态」就靠这里暴露）。
 */
import { Link, useSearchParams } from 'react-router';
import { AsyncSection } from '../components/AsyncSection.tsx';
import { Section } from '../components/Section.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Toolbar } from '../components/Toolbar.tsx';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx';
import { Badge, StatusDot } from '../components/ui/badge.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.tsx';
import { RepoFilterSelect } from '../components/repo-filter.tsx';
import type { SystemResponse } from '../lib/contract.ts';
import { EMPTY, formatCount, formatDuration, formatTimeCell } from '../lib/format.ts';
import { useSystem } from '../lib/queries.ts';
import { repoSettingsPath } from '../lib/repo-route.ts';
import { cn } from '../lib/utils.ts';

const HOST_LABEL: Record<SystemResponse['host']['status'], string> = {
  ok: '正常',
  degraded: '降级',
  down: '不可达',
  unknown: '未知',
};

const DOCTOR_LABEL: Record<SystemResponse['doctor']['status'], string> = {
  ok: '通过',
  warn: '有告警',
  fail: '未通过',
  unknown: '状态未定',
  'not-run': '还没跑过',
};

type CheckStatus = SystemResponse['doctor']['checks'][number]['status'];

const CHECK_LABEL: Record<CheckStatus, string> = { ok: '通过', warn: '告警', fail: '失败', skip: '跳过' };
const CHECK_TONE: Record<CheckStatus, 'success' | 'warn' | 'danger' | 'neutral'> = {
  ok: 'success',
  warn: 'warn',
  fail: 'danger',
  skip: 'neutral',
};

/** 分组顺序 = 出事时的阅读顺序（fail 先看）。 */
const CHECK_ORDER: readonly CheckStatus[] = ['fail', 'warn', 'ok', 'skip'];

export function SystemPage() {
  const [searchParams] = useSearchParams();
  const repoFilter = searchParams.get('repo') ?? '';
  const { data, error, isLoading, refetch } = useSystem();

  const isEmpty =
    data !== undefined && data.repos.length === 0 && data.queue.length === 0 && data.flags.length === 0;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader
        title="系统"
        actions={
          error === null ? undefined : (
            <button
              type="button"
              onClick={() => {
                void refetch();
              }}
              className="h-7 rounded-md border border-border px-2 text-xs text-foreground hover:bg-muted"
            >
              重试
            </button>
          )
        }
      />

      {data === undefined ? null : (
        <Toolbar meta="仓库筛选只影响「仓库」这一块">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="system-filters">
            <RepoFilterSelect testId="system-repo-filter" options={data.repos.map((repo) => repo.repo)} />
            <span className="text-2xs text-faint">
              {repoFilter === '' ? '全部仓库' : `只看 ${repoFilter}`}
            </span>
          </span>
        </Toolbar>
      )}

      <AsyncSection
        isLoading={isLoading}
        error={error}
        isEmpty={isEmpty}
        emptyText="还没有任何仓库与队列配置（服务刚启动？）"
        emptyHint="服务第一次启动时会建队列并种子仓库配置；如果是刚部署，等十几秒再刷新。"
        testId="system"
        skeletonRows={7}
      >
        {data === undefined ? null : <SystemContent data={data} repoFilter={repoFilter} />}
      </AsyncSection>
    </div>
  );
}

function SystemContent({ data, repoFilter }: { data: SystemResponse; repoFilter: string }) {
  const repos = repoFilter === '' ? data.repos : data.repos.filter((repo) => repo.repo === repoFilter);
  const paused = data.flags.find((flag) => flag.key === 'rate_limit_pause');

  // 与 `DegradedBanner` 同一套判据，这里是「逐条展开」
  const conditions: string[] = [];
  if (paused !== undefined) {
    conditions.push(
      paused.until === null ? '全局 429 熔断中（未设解除时间）' : `全局 429 熔断中，${formatTimeCell(paused.until).text}解除`,
    );
  }
  if (data.host.status === 'down') conditions.push('pi-host 不可达（任务会一直排队）');
  if (data.host.status === 'degraded') conditions.push('pi-host 降级运行');
  if (!data.version.hostPinned) conditions.push('pi-host 版本未通过 PIN 哈希校验');
  if (data.doctor.status === 'fail') {
    const failed = data.doctor.checks.filter((check) => check.status === 'fail').map((check) => check.id);
    conditions.push(`doctor 未通过${failed.length === 0 ? '' : `：${failed.join('、')}`}`);
  }
  if (!data.retention.metricsForever) conditions.push('指标保留期配置异常（契约要求永久保留）');

  const groups = CHECK_ORDER.map((status) => ({
    status,
    checks: data.doctor.checks.filter((check) => check.status === status),
  })).filter((group) => group.checks.length > 0);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="grid min-w-0 gap-6 xl:grid-cols-2">
        <Section first title="版本与协议">
          <div className="flex flex-col gap-2">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              <Kv label="应用" value={data.version.app} mono />
              <Kv label="契约" value={data.version.contract} mono />
              <Kv label="pi-host 版本" value={data.version.host ?? EMPTY} mono />
              <Kv label="PIN 校验" value={data.version.hostPinned ? '通过' : '未通过'} tone={data.version.hostPinned ? 'success' : 'danger'} />
              <Kv label="WS 路径" value={data.protocol.wsPath} mono />
              <Kv label="子协议" value={data.protocol.wsSubprotocol} mono />
            </dl>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span className="inline-flex items-center gap-1.5" data-testid="system-host">
                <StatusDot
                  tone={data.host.status === 'ok' ? 'success' : data.host.status === 'unknown' ? 'neutral' : 'danger'}
                  label={HOST_LABEL[data.host.status]}
                />
                <span className="text-muted-foreground">pi-host</span>
                <span className="text-foreground">{HOST_LABEL[data.host.status]}</span>
              </span>
              <span className="tabular text-muted-foreground">会话 {formatCount(data.host.sessions)}</span>
              <span className="text-faint">心跳 {formatTimeCell(data.host.lastPingAt).text}</span>
            </div>

            <Alert tone={conditions.length === 0 ? 'success' : 'warn'} data-testid="system-degraded">
              <AlertTitle>{conditions.length === 0 ? '当前没有降级条件' : `命中 ${String(conditions.length)} 条降级条件`}</AlertTitle>
              {conditions.length === 0 ? null : (
                <AlertDescription>
                  <ul className="list-disc pl-4">
                    {conditions.map((condition) => (
                      <li key={condition}>{condition}</li>
                    ))}
                  </ul>
                </AlertDescription>
              )}
            </Alert>
          </div>
        </Section>

        <Section
          title="doctor 逐项检查"
          description={`共 ${formatCount(data.doctor.checks.length)} 项 · 整体 ${DOCTOR_LABEL[data.doctor.status]} · 体检时间 ${formatTimeCell(data.doctor.checkedAt).text}`}
        >
          {data.doctor.checks.length === 0 ? (
            <p className="text-xs text-muted-foreground">doctor 还没跑过（`pi-bot doctor` 或启动自检后才有结果）。</p>
          ) : (
            <div className="flex flex-col gap-2">
              {groups.map((group) => (
                <div key={group.status} className="flex min-w-0 flex-col gap-1">
                  <p className="micro-label flex items-center gap-1.5">
                    <span aria-hidden className={cn('size-1.5 rounded-full', group.status === 'fail' ? 'bg-danger' : group.status === 'warn' ? 'bg-warn' : group.status === 'ok' ? 'bg-success' : 'bg-neutral')} />
                    {CHECK_LABEL[group.status]}（{group.checks.length}）
                  </p>
                  <ul className="flex flex-col divide-y divide-border">
                    {group.checks.map((check) => (
                      <li
                        key={check.id}
                        data-testid={`doctor-${check.id}`}
                        data-tone={CHECK_TONE[check.status]}
                        className={cn(
                          'flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 px-1.5 py-1',
                          check.status === 'fail' && 'rounded-sm bg-danger-bg',
                        )}
                      >
                        <Badge tone={CHECK_TONE[check.status]}>{CHECK_LABEL[check.status]}</Badge>
                        <span className="font-mono text-xs text-foreground">{check.id}</span>
                        <span
                          className={cn(
                            'min-w-0 flex-1 text-xs',
                            check.status === 'fail' ? 'text-danger-fg' : 'text-muted-foreground',
                            check.status === 'ok' || check.status === 'skip' ? 'truncate' : 'break-words',
                          )}
                          title={check.detail ?? undefined}
                        >
                          {check.detail ?? EMPTY}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="队列与保留策略" description="expireIn 是 job 存活上限，不是排队时长；保留期只有 metrics 是永久。">
          <div className="flex flex-col gap-3">
            {data.queue.length === 0 ? (
              <p className="text-xs text-muted-foreground">pg-boss 还没有建队列。</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>队列</TableHead>
                    <TableHead className="text-right">排队</TableHead>
                    <TableHead className="text-right">执行中</TableHead>
                    <TableHead className="text-right">重试上限</TableHead>
                    <TableHead className="text-right">存活上限</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.queue.map((queue) => (
                    <TableRow key={queue.name}>
                      <TableCell className="font-mono text-xs">{queue.name}</TableCell>
                      <TableCell className="tabular text-right text-xs">{formatCount(queue.pending)}</TableCell>
                      <TableCell className="tabular text-right text-xs">{formatCount(queue.active)}</TableCell>
                      <TableCell className="tabular text-right text-xs">{formatCount(queue.retryLimit)}</TableCell>
                      <TableCell className="tabular text-right text-xs">{formatDuration(queue.expireInMs)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            <p className="text-xs text-muted-foreground">
              webhook {formatCount(data.retention.webhookDays)} 天 · 事件 {formatCount(data.retention.runEventDays)} 天 · transcript{' '}
              {formatCount(data.retention.transcriptDays)} 天 · 指标{data.retention.metricsForever ? '永久' : '有期限'}
            </p>

            <div className="flex flex-col gap-1">
              <p className="micro-label">runtime flags</p>
              {data.flags.length === 0 ? (
                <span className="text-xs text-muted-foreground">没有生效中的 flag</span>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {data.flags.map((flag) => (
                    <li key={flag.key} className="flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="font-mono text-foreground">
                        {flag.key} = {flag.value}
                      </span>
                      {flag.until === null ? null : (
                        <span className="text-2xs text-faint">至 {formatTimeCell(flag.until).title}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Section>

        <Section
          title="仓库"
          description={`共 ${formatCount(data.repos.length)} 个${repoFilter === '' ? '' : `，当前只看 ${repoFilter}`}`}
          actions={<Badge tone="neutral">只读</Badge>}
        >
          <ul className="flex flex-col divide-y divide-border" data-testid="system-repos">
            {repos.length === 0 ? (
              <li className="py-2 text-xs text-muted-foreground">
                {repoFilter === '' ? '还没有仓库配置' : `没有 ${repoFilter} 这个仓库（或它不在清单里）`}
              </li>
            ) : (
              repos.map((repo) => (
                <li
                  key={repo.repo}
                  data-testid={`system-repo-${repo.repo}`}
                  className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-0.5 py-1.5 md:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <div className="min-w-0">
                    <Link
                      to={repoSettingsPath(repo.repo, 'general')}
                      className="font-mono text-xs text-foreground underline-offset-2 hover:text-brand hover:underline"
                      title={`打开 ${repo.repo} 的设置`}
                    >
                      {repo.repo}
                    </Link>
                    <p className="text-2xs text-faint">
                      最近活动{' '}
                      {repo.lastActivityAt === null ? EMPTY : formatTimeCell(repo.lastActivityAt).text}
                      {repo.archivedAt === null ? '' : ` · 归档于 ${formatTimeCell(repo.archivedAt).text}`}
                      {repo.settingsError === null ? '' : ` · ${repo.settingsError}`}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1 md:justify-end">
                    <Badge tone={repo.enabled ? 'success' : 'neutral'} dot>
                      {repo.enabled ? '启用' : '停用'}
                    </Badge>
                    <Badge tone={repo.dryRun ? 'warn' : 'success'} dot>
                      {repo.dryRun ? '干跑' : '真写'}
                    </Badge>
                    <Badge tone={repo.settingsValid ? 'success' : 'danger'} dot>
                      {repo.settingsValid ? '配置合法' : '配置非法'}
                    </Badge>
                    {repo.archivedAt === null ? null : <Badge tone="neutral">已归档</Badge>}
                  </div>
                </li>
              ))
            )}
          </ul>
        </Section>

        <p className="mt-1 text-2xs text-faint">
          生成于 {formatTimeCell(data.generatedAt).text}（{formatTimeCell(data.generatedAt).title}）
        </p>
      </div>
    </div>
  );
}

function Kv({
  label,
  value,
  mono = false,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: 'success' | 'danger';
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-2xs text-faint">{label}</dt>
      <dd className={cn('truncate text-xs', mono && 'font-mono', tone === 'success' ? 'text-success-fg' : tone === 'danger' ? 'text-danger-fg' : 'text-foreground')} title={value}>
        {value}
      </dd>
    </div>
  );
}