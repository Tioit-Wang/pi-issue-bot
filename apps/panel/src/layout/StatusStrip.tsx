/**
 * 内容区第一行的**状态带**：「此刻什么状态」（需求 `FR-7.2`）。
 *
 * 原文：「状态带回答『此刻什么状态』：待处理、运行中、失败、p95 四个数字，
 * 加一个降级 chip。系统健康（doctor 各项、运行时开关、连接、只读常量）进「系统」页第一屏。」
 *
 * 四个数字各有唯一来源，**不新开接口**：
 * - 待处理 / 运行中 / 失败：`/api/issues` 的 `totalEstimate`（按 `status` 各查一次，
 *   与 Issue 队列同一份口径，见 `lib/issue-counts.ts`）——**全量**，不是「已加载」；
 * - p95：`/api/overview` 的 `today.p95Ms`（服务端已按 `?repo=` 切分）。
 *
 * 数字是链接：点「失败 3」直接落到 `?status=failed` 的队列 —— 状态带不只是报表，它是入口。
 * 口径也在这里说清（`title` + `data-scope`）：服务端没统计时显示 `—`，绝不是 `0`。
 *
 * 颜色只经 `StatusBadge` / `StatusDot`（tone 由 `ui/status.ts` 定义），不写 `bg-warn-bg`
 * 这类原生色板类，也不在这里重定义 token。
 */
import { Link } from 'react-router';
import { StatusBadge } from '../components/ui/status-badge.tsx';
import { formatCount, formatDuration } from '../lib/format.ts';
import { countScopeTitle, useIssueCounts } from '../lib/issue-counts.ts';
import { useOverview } from '../lib/queries.ts';
import { repoIssuesPath } from '../lib/repo-route.ts';
import { cn } from '../lib/utils.ts';
import type { DegradedState } from './degraded.ts';


/** 兼容旧调用方的名字（`StripState` 与 `degraded.ts` 的 `DegradedState` 同形）。 */
export type StripState = DegradedState;

export function StatusStrip({ repo, state }: { repo: string | null; state: StripState }) {
  const counts = useIssueCounts(repo);
  const overview = useOverview(repo === null ? {} : { repo });

  const base = repo === null ? '/' : repoIssuesPath(repo);
  const p95 = overview.data?.today.p95Ms ?? null;
  /** 口径只说一次：三个数字是全量（`totalEstimate`）还是「服务端未统计」。 */
  const scopeTitle = countScopeTitle(counts);

  return (
    <div
      className="flex min-w-0 items-center gap-x-3 overflow-x-auto text-xs text-muted-foreground"
      data-testid="status-strip"
    >
      <StripNumber
        label="待处理"
        value={counts.pending}
        to={`${base}?status=queued`}
        testId="strip-pending"
        title={scopeTitle}
      />
      <StripNumber
        label="运行中"
        value={counts.running}
        to={`${base}?status=running`}
        testId="strip-running"
        title={scopeTitle}
      />
      <StripNumber
        label="失败"
        value={counts.failed}
        to={`${base}?status=failed`}
        testId="strip-failed"
        tone={counts.failed !== null && counts.failed > 0 ? 'danger' : undefined}
        title={scopeTitle}
      />
      <span className="flex shrink-0 items-baseline gap-1 whitespace-nowrap" data-testid="strip-p95">
        p95
        <span className="tabular text-xs font-semibold text-foreground">{formatDuration(p95)}</span>
      </span>

      {/*
        降级 chip：`data-state` 保留给测试与「一眼看出是不是降级」的样式钩子；
        颜色只经 `StatusBadge`（tone 由共用的 `degradedStateOf` 决定，不在这里判断）。
      */}
      <span
        data-testid="strip-degraded"
        data-state={state.degraded ? 'degraded' : 'ok'}
        title={`系统状态：${state.label}`}
        className="shrink-0"
      >
        <StatusBadge tone={state.degraded ? 'warn' : 'success'} dot>
          {state.label}
        </StatusBadge>
      </span>
    </div>
  );
}

function StripNumber({
  label,
  value,
  to,
  testId,
  title,
  tone,
}: {
  label: string;
  value: number | null;
  to: string;
  testId: string;
  /** 数字的口径说明（`全量` / `服务端未统计` / `请求失败`）。 */
  title: string;
  tone?: 'danger';
}) {
  return (
    <Link
      to={to}
      data-testid={testId}
      data-scope={value === null ? 'unknown' : 'total'}
      title={title}
      className="flex shrink-0 items-baseline gap-1 whitespace-nowrap rounded-sm transition-[color] duration-[120ms] ease-out-quint hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      {label}
      <span className={cn('tabular text-xs font-semibold', tone === 'danger' ? 'text-destructive' : 'text-foreground')}>
        {formatCount(value)}
      </span>
    </Link>
  );
}
