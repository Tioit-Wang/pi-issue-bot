import { useSystem } from '../lib/queries.ts';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx';

/**
 * 全局降级横幅（`AppLayout` 里唯一挂载点）。
 *
 * 数据源：`/api/system`（doctor 状态、host 状态、`runtime_flags`）。
 * 只有**确有降级**时才出现；正常时返回 `null`，不占高度。
 *
 * 这里刻意不传 props：横幅是全局判断（熔断 / host down / doctor fail / PIN 未校验），
 * 页面不该各自决定要不要警告。
 */
export function DegradedBanner() {
  const { data } = useSystem();
  if (data === undefined) return null;

  const reasons: string[] = [];
  const paused = data.flags.find((flag) => flag.key === 'rate_limit_pause');
  if (paused !== undefined) {
    reasons.push(paused.until === null ? '全局 429 熔断中（未设解除时间）' : `全局 429 熔断中，${paused.until} 解除`);
  }
  if (data.host.status === 'down') reasons.push('pi-host 不可达（任务会一直排队）');
  if (data.host.status === 'degraded') reasons.push('pi-host 降级运行');
  if (data.version.hostPinned === false) reasons.push('pi-host 版本未通过 PIN 哈希校验');
  if (data.doctor.status === 'fail') {
    const failed = data.doctor.checks.filter((check) => check.status === 'fail').map((check) => check.id);
    reasons.push(`doctor 未通过${failed.length === 0 ? '' : `：${failed.join('、')}`}`);
  }
  if (data.retention.metricsForever !== true) reasons.push('指标保留期配置异常（契约要求永久保留）');

  if (reasons.length === 0) return null;

  return (
    <div className="px-6 pt-3">
      <Alert variant="warning" data-testid="degraded-banner">
        <AlertTitle>系统处于降级状态</AlertTitle>
        <AlertDescription>
          <ul className="list-disc pl-4">
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </AlertDescription>
      </Alert>
    </div>
  );
}
