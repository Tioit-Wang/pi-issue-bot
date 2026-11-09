import { AsyncSection } from '../components/AsyncSection.tsx';
import { Badge, statusVariant } from '../components/ui/badge.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.tsx';
import { formatCount, formatPercent } from '../lib/format.ts';
import { useSystem } from '../lib/queries.ts';
import { PageShell } from './PageShell.tsx';

/**
 * 系统（S7，数据源 `/api/system`，每 15s 轮询）——**四态的代表页**（空 / 载 / 错 / 慢）。
 *
 * 契约里 `version.host` / `host` / `doctor` / `skills` 目前是占位（见 `queries/system.ts` 的说明），
 * 面板按占位语义显示为「未知 / 未体检 / 空」，**不假装正常**。
 * 四态用 `AsyncSection` 的 `testId="system"` 统一锚点：`system-loading` / `system-error` /
 * `system-empty` / `system-content`。
 */
export function SystemPage() {
  const { data, error, isLoading } = useSystem();
  const isEmpty =
    data !== undefined && data.repos.length === 0 && data.queue.length === 0 && data.flags.length === 0;

  return (
    <PageShell title="系统" description="版本与协议、pi-host 状态、doctor、队列配置、保留期、仓库开关">
      <AsyncSection
        isLoading={isLoading}
        error={error}
        isEmpty={isEmpty}
        emptyText="还没有任何仓库与队列配置（服务刚启动？）"
        testId="system"
        skeletonHeight="h-40"
      >
        {data === undefined ? null : (
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>版本与协议</CardTitle>
                <CardDescription>契约版本与面板类型来源一致（CONTRACT_VERSION）</CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-2 text-xs">
                <Field label="应用" value={data.version.app} />
                <Field label="契约" value={data.version.contract} />
                <Field label="pi-host" value={data.version.host ?? '未知'} />
                <Field label="PIN 校验" value={data.version.hostPinned ? '通过' : '未通过 / 未知'} />
                <Field label="WS 路径" value={data.protocol.wsPath} mono />
                <Field label="子协议" value={data.protocol.wsSubprotocol} mono />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>host 与 doctor</CardTitle>
                <CardDescription>doctor 产物未落库时显示 not-run</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">host</span>
                  <Badge variant={data.host.status === 'ok' ? 'success' : 'warning'}>{data.host.status}</Badge>
                  <span className="text-muted-foreground">sessions {formatCount(data.host.sessions)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">doctor</span>
                  <Badge variant={data.doctor.status === 'ok' ? 'success' : 'muted'}>{data.doctor.status}</Badge>
                  <span className="text-muted-foreground">{data.doctor.checks.length} 项检查</span>
                </div>
                {data.doctor.checks.length === 0 ? null : (
                  <ul className="flex flex-col gap-1">
                    {data.doctor.checks.map((check) => (
                      <li key={check.id} className="flex items-center gap-2">
                        <Badge variant={statusVariant(check.status === 'ok' ? 'success' : 'failed')}>
                          {check.status}
                        </Badge>
                        <span className="font-mono">{check.id}</span>
                        <span className="text-muted-foreground">{check.detail ?? ''}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>队列</CardTitle>
                <CardDescription>expireIn 是 job 存活上限，不是排队时长</CardDescription>
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
                          <td className="py-1 text-right tabular-nums">
                            {formatCount(Math.round(queue.expireInMs / 1000))}s
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>保留期与开关</CardTitle>
                <CardDescription>指标永久；其余按天清理</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-xs">
                <Field
                  label="保留期"
                  value={`webhook ${String(data.retention.webhookDays)}d · 事件 ${String(data.retention.runEventDays)}d · transcript ${String(data.retention.transcriptDays)}d · 指标${data.retention.metricsForever ? '永久' : '有期限'}`}
                />
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] text-muted-foreground">runtime flags</span>
                  {data.flags.length === 0 ? (
                    <span className="text-muted-foreground">没有生效中的 flag</span>
                  ) : (
                    data.flags.map((flag) => (
                      <span key={flag.key} className="font-mono">
                        {flag.key} = {flag.value}
                        {flag.until === null ? '' : `（至 ${flag.until}）`}
                      </span>
                    ))
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] text-muted-foreground">仓库（{formatCount(data.repos.length)}）</span>
                  {data.repos.length === 0 ? (
                    <span className="text-muted-foreground">还没有仓库配置</span>
                  ) : (
                    data.repos.map((repo) => (
                      <span key={repo.repo} className="flex items-center gap-2">
                        <span className="font-mono">{repo.repo}</span>
                        <Badge variant={repo.enabled ? 'success' : 'muted'}>{repo.enabled ? '启用' : '停用'}</Badge>
                        {repo.dryRun ? <Badge variant="outline">dry-run</Badge> : null}
                        {repo.configValid ? null : <Badge variant="danger">配置无效</Badge>}
                        {repo.configError === null ? null : (
                          <span className="text-muted-foreground">{repo.configError}</span>
                        )}
                      </span>
                    ))
                  )}
                </div>
                <Field label="技能" value={data.skills.length === 0 ? '尚未加载（skills/ 在 W4 落地）' : formatPercent(1)} />
              </CardContent>
            </Card>
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
