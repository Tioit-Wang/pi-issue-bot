import type { SystemResponse } from '../lib/contract.ts';
import { formatCount } from '../lib/format.ts';

/**
 * 降级判据的**唯一**来源（状态带、降级横幅、系统页第一屏三处共用）。
 *
 * 为什么抽出来：三处各写一遍 `doctor.status === 'fail' || host.status !== 'ok'` 之后，
 * 就会出现「横幅说降级、状态带说正常」这种没人能解释的不一致。
 *
 * 刻意不放在任何组件文件里：它不渲染任何东西，放在 `AppLayout` 旁边只是为了
 * 和外壳一起被读，不是因为它属于外壳。
 */
export type DegradedState = {
  degraded: boolean;
  /** 降级 chip 的一句话（`3 项检查未通过` / `429 熔断中` / `正常`）。 */
  label: string;
};

export function degradedStateOf(data: SystemResponse | undefined, isError: boolean): DegradedState {
  if (isError) return { degraded: true, label: '系统接口不可达' };
  if (data === undefined) return { degraded: false, label: '未知' };
  const paused = data.flags.find((flag) => flag.key === 'rate_limit_pause');
  if (paused !== undefined) return { degraded: true, label: '429 熔断中' };
  if (data.host.status === 'down') return { degraded: true, label: 'pi-host 不可达' };
  if (data.doctor.status === 'fail') {
    const failed = data.doctor.checks.filter((check) => check.status === 'fail').length;
    return { degraded: true, label: `${formatCount(failed)} 项检查未通过` };
  }
  if (data.host.status === 'degraded') return { degraded: true, label: 'pi-host 降级' };
  return { degraded: false, label: '正常' };
}
