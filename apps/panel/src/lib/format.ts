/**
 * 面板的**唯一**数字格式化入口（tech-plan §9.4）：所有页面都走这里，不许各自 `toFixed`。
 *
 * 六类约定：
 *  1. 时长 `1m 20s`（毫秒入参，字段名都带 `Ms`）；
 *  2. 金额 `$0.0412`（契约：USD、4 位小数）；
 *  3. token `12.4k`（缩写只发生在展示层）；
 *  4. 时间：相对量（`3 分钟前`）+ `title` 里的绝对时间（`formatAbsoluteTime`）；
 *  5. 百分比 `33.3%`（入参是 0–1 的比例，**不乘 100**）；
 *  6. `null` / `undefined` 一律显示 `—`，绝不显示成 `0`（契约要求两者可区分）。
 */

/** 「没有这个值」的占位符（与 `null ≠ 0` 的契约一致）。 */
export const EMPTY = '—';

function isMissing(value: number | null | undefined): value is null | undefined {
  return value === null || value === undefined || !Number.isFinite(value);
}

/** 32 → `32ms`；1500 → `1.5s`；80_000 → `1m 20s`；3_600_000 → `1h`。 */
export function formatDuration(ms: number | null | undefined): string {
  if (isMissing(ms)) return EMPTY;
  const value = Math.max(0, Math.round(ms));
  if (value < 1000) return `${value}ms`;

  const totalSeconds = value / 1000;
  if (totalSeconds < 60) {
    const text = totalSeconds < 10 ? totalSeconds.toFixed(1) : String(Math.round(totalSeconds));
    return `${text.replace(/\.0$/, '')}s`;
  }

  const seconds = Math.round(totalSeconds);
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) {
    return restSeconds === 0 ? `${minutes}m` : `${minutes}m ${restSeconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
}

/** 0.0412 → `$0.0412`；0 → `$0.0000`（跑了但免费）；null → `—`。 */
export function formatUsd(value: number | null | undefined): string {
  if (isMissing(value)) return EMPTY;
  return `$${value.toFixed(4)}`;
}

/** 12345 → `12.3k`；999 → `999`；1_500_000 → `1.5M`。 */
export function formatTokens(value: number | null | undefined): string {
  if (isMissing(value)) return EMPTY;
  const tokens = Math.max(0, Math.round(value));
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${trimZero((tokens / 1000).toFixed(1))}k`;
  return `${trimZero((tokens / 1_000_000).toFixed(1))}M`;
}

/** 整数带千分位：`1234` → `1,234`（计数、任务数、行数用它）。 */
export function formatCount(value: number | null | undefined): string {
  if (isMissing(value)) return EMPTY;
  const text = String(Math.round(value));
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 0.333 → `33.3%`；0.5 → `50%`；1 → `100%`；null → `—`。 */
export function formatPercent(rate: number | null | undefined): string {
  if (isMissing(rate)) return EMPTY;
  const clamped = Math.min(1, Math.max(0, rate));
  return `${trimZero((clamped * 100).toFixed(1))}%`;
}

/**
 * 相对时间：`刚刚` / `3 分钟前` / `2 小时前` / `5 天前` / 更早用绝对日期。
 * `now` 可注入，单测才能断言到具体字面量（不依赖真实时钟）。
 */
export function formatRelativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  const absolute = absoluteDate(iso);
  if (absolute === null) return EMPTY;

  const deltaSeconds = Math.abs((now.getTime() - absolute.getTime()) / 1000);
  const suffix = absolute.getTime() <= now.getTime() ? '前' : '后';
  if (deltaSeconds < 10) return '刚刚';

  if (deltaSeconds < 60) return `${Math.floor(deltaSeconds)} 秒${suffix}`;
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)} 分钟${suffix}`;
  if (deltaSeconds < 86_400) return `${Math.floor(deltaSeconds / 3600)} 小时${suffix}`;
  if (deltaSeconds < 30 * 86_400) return `${Math.floor(deltaSeconds / 86_400)} 天${suffix}`;

  // 超过一个月：相对量没有信息量了，退化成日期
  return (iso ?? '').slice(0, 10);
}

/** 绝对时间（给 `title` 用）：`2026-06-01 12:00:00 UTC`。 */
export function formatAbsoluteTime(iso: string | null | undefined): string {
  const absolute = absoluteDate(iso);
  if (absolute === null) return EMPTY;
  return `${iso === null || iso === undefined ? '' : iso.slice(0, 19).replace('T', ' ')} UTC`;
}

/** 组合：`{ text, title }`，表格里 `<time title={title}>{text}</time>` 直接用。 */
export function formatTimeCell(
  iso: string | null | undefined,
  now: Date = new Date(),
): { text: string; title: string } {
  return { text: formatRelativeTime(iso, now), title: formatAbsoluteTime(iso) };
}

function trimZero(text: string): string {
  return text.replace(/\.0$/, '');
}

function absoluteDate(iso: string | null | undefined): Date | null {
  if (iso === null || iso === undefined || iso === '') return null;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
