import { AsyncSection } from '../components/AsyncSection.tsx';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.tsx';
import type { SystemResponse } from '../lib/contract.ts';
import { EMPTY, formatCount, formatDuration, formatTimeCell } from '../lib/format.ts';
import { useSystem } from '../lib/queries.ts';
import { cn } from '../lib/utils.ts';
import { PageShell } from './PageShell.tsx';

/**
 * 系统（S7，数据源 `/api/system`，每 15 秒轮询）—— 也是**四态代表页**（空 / 载 / 错 / 慢）。
 *
 * 契约里这份响应把「机器还行不行」的东西集中在一处（contract-api.md §8）：
 * 版本与协议 → host 状态 → doctor 逐项 → 队列与保留期 → 仓库开关 → 能力（skills）。
 * 面板只做展示，不做判断：`version.host` 为 `null`、doctor 没跑过，都**如实**显示为 `—` / `还没跑过`，
 * 不假装正常（tech-plan §11 R10 的「半升级状态」就靠这里暴露）。
 *
 * 「降级横幅条件」这一块是 `layout/DegradedBanner.tsx` 的判断依据的**展开版**：
 * 横幅只显示「有降级」，这页说清楚**是哪几条**成立，运维不用去翻代码猜。
 */
export function SystemPage() {
  const { data, error, isLoading, refetch } = useSystem();

  // 空态：没有任何仓库 / 队列 / flag（服务刚启动，pg-boss 还没建队列）
  const isEmpty =
    data !== undefined && data.repos.length === 0 && data.queue.length === 0 && data.flags.length === 0;

  return (
    <PageShell
      title="系统"
      description="版本与协议、pi-host 状态、doctor 逐项检查、队列与保留期（每 15 秒刷新）"
      actions={
        error === null ? undefined : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void refetch();
            }}
          >
            重试
          </Button>
        )
      }
    >
      <AsyncSection
        isLoading={isLoading}
        error={error}
        isEmpty={isEmpty}
        emptyText="还没有任何仓库与队列配置（服务刚启动？）"
        testId="system"
        skeletonHeight="h-40"
      >
        {data === undefined ? null : <SystemContent data={data} />}
      </AsyncSection>
    </PageShell>
  );
}

/** host 状态的中文文案（`unknown` 是「没协商过」，不是「正常」，所以单独一个词）。 */
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

const CHECK_LABEL: Record<CheckStatus, string> = {
  ok: '通过',
  warn: '告警',
  fail: '失败',
  skip: '跳过',
};

const CHECK_VARIANT: Record<CheckStatus, 'success' | 'warning' | 'danger' | 'muted'> = {
  ok: 'success',
  warn: 'warning',
  fail: 'danger',
  skip: 'muted',
};

function SystemContent({ data }: { data: SystemResponse }) {
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

  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>版本与协议</CardTitle>
          <CardDescription>契约版本用于发现「后端换契约了」；协议是 RACP 的 WS 路径与子协议</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-2 text-xs">
          <Field label="应用" value={data.version.app} />
          <Field label="契约" value={data.version.contract} />
          {/* 契约：未连上就是 null —— 这里显示 `—`，不用 0 或假版本号糊过去 */}
          <Field label="pi-host 版本" value={data.version.host ?? EMPTY} />
          <Field label="PIN 校验" value={data.version.hostPinned ? '通过' : '未通过'} />
          <Field label="WS 路径" value={data.protocol.wsPath} mono />
          <Field label="子协议" value={data.protocol.wsSubprotocol} mono />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>降级横幅条件</CardTitle>
          <CardDescription>命中任一条件时，页面顶部会出现全局降级横幅</CardDescription>
        </CardHeader>
        <CardContent>
          <Alert
            variant={conditions.length === 0 ? 'default' : 'warning'}
            data-testid="system-degraded"
            className="px-3 py-2"
          >
            <AlertTitle>{conditions.length === 0 ? '当前没有降级条件' : `命中 ${String(conditions.length)} 条`}</AlertTitle>
            <AlertDescription>
              {conditions.length === 0 ? (
                '熔断、host、PIN、doctor、保留期五项都正常'
              ) : (
                conditions.map((condition, index) => (
                  <span key={condition}>
                    {index === 0 ? '' : '；'}
                    {condition}
                  </span>
                ))
              )}
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>pi-host 状态</CardTitle>
          <CardDescription>{`最近心跳 ${formatTimeCell(data.host.lastPingAt).text}`}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3 text-xs">
          <Badge variant={data.host.status === 'ok' ? 'success' : data.host.status === 'unknown' ? 'muted' : 'danger'}>
            {HOST_LABEL[data.host.status]}
          </Badge>
          <span className="text-muted-foreground">{`会话 ${formatCount(data.host.sessions)} 个`}</span>
          <span className="text-muted-foreground">{`doctor ${DOCTOR_LABEL[data.doctor.status]}`}</span>
          <span className="text-muted-foreground">{`体检时间 ${formatTimeCell(data.doctor.checkedAt).text}`}</span>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>队列配置</CardTitle>
          <CardDescription>`expireIn` 是 job 存活上限，**不是**排队时长（tech-plan §5.3 F5）</CardDescription>
        </CardHeader>
        <CardContent>
          {data.queue.length === 0 ? (
            <p className="text-xs text-muted-foreground">pg-boss 还没有建队列</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1">队列</th>
                  <th className="py-1 text-right">排队</th>
                  <th className="py-1 text-right">执行中</th>
                  <th className="py-1 text-right">重试上限</th>
                  <th className="py-1 text-right">存活上限</th>
                </tr>
              </thead>
              <tbody>
                {data.queue.map((queue) => (
                  <tr key={queue.name} className="border-t border-border">
                    <td className="py-1 font-mono">{queue.name}</td>
                    <td className="py-1 text-right tabular-nums">{formatCount(queue.pending)}</td>
                    <td className="py-1 text-right tabular-nums">{formatCount(queue.active)}</td>
                    <td className="py-1 text-right tabular-nums">{formatCount(queue.retryLimit)}</td>
                    <td className="py-1 text-right tabular-nums">{formatDuration(queue.expireInMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card className="xl:col-span-2">
        <CardHeader>
          <CardTitle>doctor 逐项检查</CardTitle>
          <CardDescription>
            {`共 ${formatCount(data.doctor.checks.length)} 项 · 整体 ${DOCTOR_LABEL[data.doctor.status]}；fail 整行高亮`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.doctor.checks.length === 0 ? (
            <p className="text-xs text-muted-foreground">doctor 还没跑过（`pi-bot doctor` 或启动自检后才有结果）</p>
          ) : (
            <ul className="flex flex-col gap-1 text-xs">
              {data.doctor.checks.map((check) => (
                <li
                  key={check.id}
                  data-testid={`doctor-${check.id}`}
                  className={cn(
                    'flex flex-wrap items-center gap-2 rounded-md px-2 py-1',
                    check.status === 'fail' ? 'bg-destructive/10 text-destructive' : null,
                    check.status === 'warn' ? 'bg-muted' : null,
                  )}
                >
                  <Badge variant={CHECK_VARIANT[check.status]}>{CHECK_LABEL[check.status]}</Badge>
                  <span className="font-mono">{check.id}</span>
                  <span className="text-muted-foreground">{check.detail ?? EMPTY}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>保留期与 runtime flags</CardTitle>
          <CardDescription>指标永久保留；其余按天清理（retention 任务是 cron）</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-xs">
          <Field
            label="保留期"
            value={`webhook ${formatCount(data.retention.webhookDays)} 天 · 事件 ${formatCount(data.retention.runEventDays)} 天 · transcript ${formatCount(data.retention.transcriptDays)} 天 · 指标${data.retention.metricsForever ? '永久' : '有期限'}`}
          />
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">runtime flags</span>
            {data.flags.length === 0 ? (
              <span className="text-muted-foreground">没有生效中的 flag</span>
            ) : (
              data.flags.map((flag) => (
                <span key={flag.key} className="font-mono">
                  {`${flag.key} = ${flag.value}`}
                  {flag.until === null ? '' : `（至 ${formatTimeCell(flag.until).title}）`}
                </span>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>仓库开关</CardTitle>
          <CardDescription>{`共 ${formatCount(data.repos.length)} 个仓库；配置无效的仓库不会被调度`}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-1.5 text-xs">
          {data.repos.length === 0 ? (
            <p className="text-muted-foreground">还没有仓库配置</p>
          ) : (
            data.repos.map((repo) => (
              <div key={repo.repo} className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{repo.repo}</span>
                <Badge variant={repo.enabled ? 'success' : 'muted'}>{repo.enabled ? '启用' : '停用'}</Badge>
                {repo.dryRun ? <Badge variant="outline">dry-run</Badge> : null}
                {repo.configValid ? null : <Badge variant="danger">配置无效</Badge>}
                {repo.configError === null ? null : <span className="text-muted-foreground">{repo.configError}</span>}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card className="xl:col-span-2">
        <CardHeader>
          <CardTitle>能力（skills）</CardTitle>
          <CardDescription>
            契约只有 skills 这一份能力清单（没有单独的 capabilities 字段）：`outputs` 是允许的写回类型，
            `timeoutMs` 已被截断到 30m 上限
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.skills.length === 0 ? (
            <p className="text-xs text-muted-foreground">还没有加载任何技能（skills/ 目录为空）</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1">技能</th>
                  <th className="py-1">来源</th>
                  <th className="py-1">状态</th>
                  <th className="py-1">outputs</th>
                  <th className="py-1 text-right">超时</th>
                </tr>
              </thead>
              <tbody>
                {data.skills.map((skill) => (
                  <tr key={skill.name} className="border-t border-border">
                    <td className="py-1 font-mono">{skill.name}</td>
                    <td className="py-1 font-mono text-muted-foreground">{skill.source}</td>
                    <td className="py-1">
                      <Badge variant={skill.enabled ? 'success' : 'danger'}>
                        {skill.enabled ? '已启用' : (skill.disabledReason ?? '已禁用')}
                      </Badge>
                    </td>
                    <td className="py-1 font-mono text-muted-foreground">{skill.outputs.join(' · ')}</td>
                    <td className="py-1 text-right tabular-nums">{formatDuration(skill.timeoutMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground xl:col-span-2">
        {`生成于 ${formatTimeCell(data.generatedAt).text}（${formatTimeCell(data.generatedAt).title}）`}
      </p>
    </div>
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
