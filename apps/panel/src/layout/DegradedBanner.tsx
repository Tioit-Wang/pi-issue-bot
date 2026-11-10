import { useState } from 'react';
import { Link } from 'react-router';
import { StatusDot } from '../components/ui/badge.tsx';
import { Sheet } from '../components/ui/dialog.tsx';
import { formatAbsoluteTime } from '../lib/format.ts';
import { useSystem } from '../lib/queries.ts';

/**
 * 全局降级横幅（`AppLayout` 里唯一挂载点）。
 *
 * 数据源：`/api/system`（doctor 状态、host 状态、`runtime_flags`）。
 * 只有**确有降级**时才出现；正常时返回 `null`，不占高度。
 *
 * 形态（D4）：**固定 36px 的一行**，不换行、不折叠主内容 ——
 * `系统降级 · 429 熔断 · 3 项  [详情]`。
 * 为什么不再是大色块 + 三条 bullet：横幅在页面最上方，用户来这里是看「需要你处理」的，
 * 一条常驻告警每多占 20px，就是每屏少看半行待办。原因明细放 `Sheet`（点「详情」才展开），
 * 一行摘要 + 一个入口既保留了信息，又把常驻成本压到 36px。
 *
 * 文案只用**状态词**，不用「刷新中」这类瞬时词：横幅描述的是"系统此刻处于降级态"，
 * 不是"正在做某件事"。
 *
 * 这里刻意不传 props：横幅是全局判断（熔断 / host down / doctor fail / PIN 未校验），
 * 页面不该各自决定要不要警告。
 */
type DegradedReason = {
  /** 一行摘要里出现的短标签（2–6 字）。 */
  short: string;
  /** 明细里的一句事实（含时间、检查项这些可核对的量）。 */
  detail: string;
};

export function DegradedBanner() {
  const { data } = useSystem();
  const [open, setOpen] = useState(false);
  if (data === undefined) return null;

  const reasons: DegradedReason[] = [];
  const paused = data.flags.find((flag) => flag.key === 'rate_limit_pause');
  if (paused !== undefined) {
    reasons.push({
      short: '429 熔断',
      // 明细只补"短标签之外的量"（解除时间 / 检查项），不复述标签
      detail: paused.until === null ? '未设解除时间' : `${formatAbsoluteTime(paused.until)} 解除`,
    });
  }
  if (data.host.status === 'down') {
    reasons.push({ short: 'pi-host 不可达', detail: '任务会一直排队' });
  }
  if (data.host.status === 'degraded') {
    reasons.push({ short: 'pi-host 降级', detail: '宿主进程降级运行' });
  }
  if (data.version.hostPinned === false) {
    reasons.push({ short: 'PIN 未校验', detail: 'pi-host 版本未通过 PIN 哈希校验' });
  }
  if (data.doctor.status === 'fail') {
    const failed = data.doctor.checks.filter((check) => check.status === 'fail').map((check) => check.id);
    reasons.push({
      short: 'doctor 未通过',
      detail: failed.length === 0 ? '没有列出未通过的检查项' : `未通过项：${failed.join('、')}`,
    });
  }
  if (data.retention.metricsForever !== true) {
    reasons.push({ short: '保留期异常', detail: '指标保留期配置异常（契约要求永久保留）' });
  }

  if (reasons.length === 0) return null;

  const summary = reasons.map((reason) => reason.detail).join('；');

  return (
    <>
      <div
        data-testid="degraded-banner"
        role="region"
        aria-label="系统降级"
        className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border bg-warn-bg px-3 text-xs whitespace-nowrap text-warn-fg md:px-6"
      >
        <StatusDot tone="warn" />
        <span className="shrink-0 font-medium">系统降级</span>
        <Sep />
        <span className="min-w-0 truncate" title={summary}>
          {reasons[0]?.short}
        </span>
        <Sep />
        <span className="shrink-0 tabular" title={summary}>
          {`${String(reasons.length)} 项`}
        </span>

        <button
          type="button"
          onClick={() => {
            setOpen(true);
          }}
          className="ml-auto h-6 shrink-0 rounded-sm border border-border bg-card px-1.5 text-xs text-foreground transition-[background-color,color] duration-[120ms] ease-out-quint hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          详情
        </button>
      </div>

      <Sheet
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        title="系统降级"
        description={`${String(reasons.length)} 项未满足的条件`}
        testId="degraded-detail"
        width="sm"
        footer={
          <Link
            to="/system"
            className="rounded-sm border border-border bg-card px-2 py-1 text-xs text-foreground transition-[background-color] duration-[120ms] ease-out-quint hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            onClick={() => {
              setOpen(false);
            }}
          >
            系统页
          </Link>
        }
      >
        <ul className="flex flex-col gap-2" data-testid="degraded-detail-list">
          {reasons.map((reason) => (
            <li key={reason.short} className="flex min-w-0 flex-col gap-0.5 border-l-2 border-warn pl-2">
              <span className="text-sm font-medium text-foreground">{reason.short}</span>
              <span className="text-xs leading-relaxed text-muted-foreground">{reason.detail}</span>
            </li>
          ))}
        </ul>
      </Sheet>
    </>
  );
}

/** 行内分隔点：两侧留同样的 6px（` · ` 的唯一写法）。 */
function Sep() {
  return (
    <span aria-hidden className="shrink-0 text-faint">
      ·
    </span>
  );
}
