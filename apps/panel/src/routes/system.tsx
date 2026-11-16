/**
 * 系统页 `/system` —— **全局层的唯一入口**（需求 `FR-7.1` / `FR-7.2` / `AC-26`）。
 *
 * 改造前它是个模态框（`layout/SystemModal.tsx`）：一个入口、一次开合、Esc 关掉。
 * 改成侧栏式 admin 之后「全局」是侧栏的第三组，系统就该是一条能书签、能刷新、
 * 能被 ⌘. 直接打开的**真路由** —— 模态框做不到这三件事（刷新即丢、深链不存在）。
 *
 * 内容与原模态框一致，一块都不能少（`FR-7.2` 硬约束：「找不到去处就不许删」）：
 *
 * | 原页面 | 去哪了 |
 * |---|---|
 * | 系统 | **这里**：doctor 逐项、运行时开关、连接（pi-host / PIN）、只读常量 |
 * | 总览 | 状态带的四个数字（`layout/StatusStrip.tsx`）+ 这里的 doctor 摘要与今日合计 |
 * | 成本 | 会话流里每轮的 token 与单价（`routes/issue-detail.tsx`）+ 这里的「今日成本」合计 |
 * | 质量 | 被改回的事件进行会话流的写回行；这里只给失败分类 Top5 作为索引 |
 * | 审计 | 写回动作的审计 id 落在写回行；这里只给最近事件的时间范围与条数 |
 *
 * 刻意**不**做的：把旧页面原样搬回来。第一屏只回答「现在健康吗、开关是什么」，
 * 报表留在「往下滚」的那几块里，且**不加新接口** —— 全部来自已有的 `/api/system`
 * 与 `/api/overview`。
 */
import { Link } from 'react-router';
import { AsyncSection } from '../components/AsyncSection.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Section } from '../components/Section.tsx';
import { StatusBadge, StatusDot } from '../components/ui/status-badge.tsx';
import type { SystemResponse } from '../lib/contract.ts';
import { EMPTY, formatCount, formatDuration, formatPercent, formatTimeCell, formatUsd } from '../lib/format.ts';
import { useOverview, useSystem } from '../lib/queries.ts';
import { repoSettingsPath } from '../lib/repo-route.ts';
import { cn } from '../lib/utils.ts';
import { degradedStateOf } from '../layout/degraded.ts';
import { ExecutionModelSection, ProvidersSection } from '../layout/system-settings.tsx';

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
  const { data, error, isLoading, refetch } = useSystem();
  const overview = useOverview();

  const isEmpty =
    data !== undefined && data.repos.length === 0 && data.queue.length === 0 && data.flags.length === 0;

  const degraded = degradedStateOf(data, error !== null);

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="system-page">
      <PageHeader
        title="系统"
        testId="system-page-header"
        description="不依赖项目 · 影响所有仓库"
        badges={
          <StatusBadge tone={degraded.degraded ? 'warn' : 'success'} dot>
            {degraded.label}
          </StatusBadge>
        }
      />

      <AsyncSection
        isLoading={isLoading}
        error={error}
        isEmpty={isEmpty}
        emptyText="还没有任何仓库与队列配置（服务刚启动？）"
        emptyHint="服务第一次启动时会建队列并种子仓库配置；如果是刚部署，等十几秒再刷新。"
        onRetry={() => {
          void refetch();
        }}
        skeletonRows={7}
        testId="system"
      >
        {data === undefined ? null : (
          <div className="flex min-w-0 flex-col gap-4">
            <HealthSection data={data} />
            <FlagsSection data={data} />
            <ConnectionSection data={data} />
            <QueueSection data={data} />
            <ReposSection data={data} />
            <TotalsSection overview={overview.data} />
            <p className="text-2xs text-muted-foreground">
              生成于 {formatTimeCell(data.generatedAt).text}（{formatTimeCell(data.generatedAt).title}）
            </p>
          </div>
        )}
      </AsyncSection>

      {/*
       * `AC-32` 的两块（供应商 / 执行模型单价）**不**放在上面的 `AsyncSection` 里：
       * 它们来自 `/api/settings/*`，与 `/api/system` 是否可达无关。
       * 塞进去的后果是「系统接口一挂，全局设置跟着消失」——那正是 `FR-7.5` 说的
       * 「缺接口不许假装成功」，但这里不是缺接口，是不该被别人的失败连坐。
       */}
      <div className="flex min-w-0 flex-col gap-4">
        <ProvidersSection />
        <ExecutionModelSection />
      </div>
    </div>
  );
}

/** 第一屏：doctor 逐项 + 整体结论。失败项把 detail 摊开（那正是要看的）。 */
function HealthSection({ data }: { data: SystemResponse }) {
  const groups = CHECK_ORDER.map((status) => ({
    status,
    checks: data.doctor.checks.filter((check) => check.status === status),
  })).filter((group) => group.checks.length > 0);

  return (
    <Section
      first
      title="系统健康（doctor）"
      description={`共 ${formatCount(data.doctor.checks.length)} 项 · 整体 ${DOCTOR_LABEL[data.doctor.status]} · 体检时间 ${formatTimeCell(data.doctor.checkedAt).text}`}
    >
      {data.doctor.checks.length === 0 ? (
        <p className="text-xs text-muted-foreground">doctor 还没跑过（`pi-bot doctor` 或启动自检后才有结果）。</p>
      ) : (
        <div className="flex flex-col gap-2">
          {groups.map((group) => (
            <div key={group.status} className="flex min-w-0 flex-col gap-1">
              <p className="micro-label flex items-center gap-1.5">
                <StatusDot tone={CHECK_TONE[group.status]} />
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
                      // 失败只标左缘 2px 与文字色，**不整行染色**：一眼扫过去要能看出「哪几项挂了」，
                      // 但整行铺红底会把同屏其它行的重量压掉（设计系统 §2「状态色只允许小面积」）。
                      check.status === 'fail' && 'border-l-2 border-destructive pl-1',
                    )}
                  >
                    <StatusBadge tone={CHECK_TONE[check.status]}>{CHECK_LABEL[check.status]}</StatusBadge>
                    <span className="font-mono text-xs text-foreground">{check.id}</span>
                    <span
                      className={cn(
                        'min-w-0 flex-1 text-xs',
                        check.status === 'fail' ? 'text-destructive' : 'text-muted-foreground',
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
  );
}

/** 运行时开关（`runtime_flags`）：全局熔断 / 暂停都在这里。 */
function FlagsSection({ data }: { data: SystemResponse }) {
  return (
    <Section title="运行时开关" count={data.flags.length}>
      {data.flags.length === 0 ? (
        <p className="text-xs text-muted-foreground">没有生效中的 flag</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {data.flags.map((flag) => (
            <li key={flag.key} className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="font-mono text-foreground">
                {flag.key} = {flag.value}
              </span>
              {flag.until === null ? null : (
                <span className="text-2xs text-muted-foreground">至 {formatTimeCell(flag.until).title}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** 连接与只读常量：版本、PIN、WS 路径与子协议。 */
function ConnectionSection({ data }: { data: SystemResponse }) {
  return (
    <Section title="连接与只读常量">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        <Kv label="pi-host 版本" value={data.version.host ?? EMPTY} mono />
        <Kv
          label="PIN 校验"
          value={data.version.hostPinned ? '通过' : '未通过'}
          tone={data.version.hostPinned ? 'success' : 'danger'}
        />
        <Kv label="应用" value={data.version.app} mono />
        <Kv label="契约" value={data.version.contract} mono />
        <Kv label="WS 路径" value={data.protocol.wsPath} mono />
        <Kv label="子协议" value={data.protocol.wsSubprotocol} mono />
      </dl>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-1.5" data-testid="system-host">
          <StatusDot
            tone={data.host.status === 'ok' ? 'success' : data.host.status === 'unknown' ? 'neutral' : 'danger'}
            label={HOST_LABEL[data.host.status]}
          />
          <span className="text-muted-foreground">pi-host</span>
          <span className="text-foreground">{HOST_LABEL[data.host.status]}</span>
        </span>
        <span className="tabular text-muted-foreground">会话 {formatCount(data.host.sessions)}</span>
        <span className="text-muted-foreground">心跳 {formatTimeCell(data.host.lastPingAt).text}</span>
      </div>
    </Section>
  );
}

/** 队列与保留期：`expireIn` 是 job 存活上限，不是排队时长（这一句必须留着，否则会误读）。 */
function QueueSection({ data }: { data: SystemResponse }) {
  return (
    <Section title="队列与保留策略" description="expireIn 是 job 存活上限，不是排队时长；保留期只有 metrics 是永久。">
      <div className="flex flex-col gap-3 text-xs">
        {data.queue.length === 0 ? (
          <p className="text-muted-foreground">pg-boss 还没有建队列。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[24rem]">
              <thead>
                <tr className="text-muted-foreground">
                  <th scope="col" className="py-1 text-left font-normal">队列</th>
                  <th scope="col" className="py-1 text-right font-normal">排队</th>
                  <th scope="col" className="py-1 text-right font-normal">执行中</th>
                  <th scope="col" className="py-1 text-right font-normal">重试上限</th>
                  <th scope="col" className="py-1 text-right font-normal">存活上限</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.queue.map((queue) => (
                  <tr key={queue.name}>
                    <td className="py-1 font-mono">{queue.name}</td>
                    <td className="py-1 text-right tabular">{formatCount(queue.pending)}</td>
                    <td className="py-1 text-right tabular">{formatCount(queue.active)}</td>
                    <td className="py-1 text-right tabular">{formatCount(queue.retryLimit)}</td>
                    <td className="py-1 text-right tabular">{formatDuration(queue.expireInMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-muted-foreground">
          webhook {formatCount(data.retention.webhookDays)} 天 · 事件 {formatCount(data.retention.runEventDays)} 天 ·
          transcript {formatCount(data.retention.transcriptDays)} 天 · 指标
          {data.retention.metricsForever ? '永久' : '有期限'}
        </p>
      </div>
    </Section>
  );
}

/** 仓库清单（只读）：写入口跳设置页 —— 这里是「管理仓库…」那一项的落点。 */
function ReposSection({ data }: { data: SystemResponse }) {
  return (
    <Section title="仓库" count={data.repos.length} actions={<StatusBadge tone="neutral">只读</StatusBadge>}>
      <ul className="flex flex-col divide-y divide-border" data-testid="system-repos">
        {data.repos.length === 0 ? (
          <li className="py-2 text-xs text-muted-foreground">还没有仓库配置</li>
        ) : (
          data.repos.map((repo) => (
            <li
              key={repo.repo}
              data-testid={`system-repo-${repo.repo}`}
              className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5"
            >
              <Link
                to={repoSettingsPath(repo.repo, 'general')}
                className="font-mono text-xs text-foreground underline-offset-2 hover:text-primary hover:underline"
                title={`打开 ${repo.repo} 的设置`}
              >
                {repo.repo}
              </Link>
              <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
                最近活动 {repo.lastActivityAt === null ? EMPTY : formatTimeCell(repo.lastActivityAt).text}
                {repo.archivedAt === null ? '' : ` · 归档于 ${formatTimeCell(repo.archivedAt).text}`}
                {repo.settingsError === null ? '' : ` · ${repo.settingsError}`}
              </span>
              <span className="flex flex-wrap items-center gap-1">
                <StatusBadge tone={repo.enabled ? 'success' : 'neutral'} dot>
                  {repo.enabled ? '启用' : '停用'}
                </StatusBadge>
                <StatusBadge tone={repo.dryRun ? 'warn' : 'success'} dot>
                  {repo.dryRun ? '干跑' : '真写'}
                </StatusBadge>
                <StatusBadge tone={repo.settingsValid ? 'success' : 'danger'} dot>
                  {repo.settingsValid ? '配置合法' : '配置非法'}
                </StatusBadge>
              </span>
            </li>
          ))
        )}
      </ul>
    </Section>
  );
}

/** 今日合计（原「总览」与「成本」两页合计口径的最后落点）。 */
function TotalsSection({ overview }: { overview: ReturnType<typeof useOverview>['data'] }) {
  return (
    <Section title="今日合计（全部仓库）" description="口径同 /api/overview；单次成本在会话流里按轮显示。">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
        <Kv label="任务" value={formatCount(overview?.today.tasks ?? null)} />
        <Kv label="成功率" value={formatPercent(overview?.today.successRate ?? null)} />
        <Kv label="成本" value={formatUsd(overview?.today.costUsd ?? null)} />
        <Kv label="p95 耗时" value={formatDuration(overview?.today.p95Ms ?? null)} />
      </dl>
    </Section>
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
      <dt className="text-2xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'truncate',
          mono && 'font-mono',
          tone === 'success' ? 'text-foreground' : tone === 'danger' ? 'text-destructive' : 'text-foreground',
        )}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}
