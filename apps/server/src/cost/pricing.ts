/**
 * DeepSeek 官方价目（USD / 1M tokens）与计费时刻判定。
 *
 * 事实源：<https://api-docs.deepseek.com/quick_start/pricing>（2026-11-10 抓取），要点照抄在下面：
 *
 *  - 模型名：`deepseek-flash`（= DeepSeek-V4.1-Flash-1017）、`deepseek-v4-pro`（= DeepSeek-V4-Pro-0813）。
 *    旧的 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 仍接受，但按 Flash 计费。
 *  - 三个价：输入缓存命中 / 输入缓存未命中 / 输出。
 *  - **低谷价是高峰价的一半**。高峰时段 = **UTC 周一至周五 01:00–04:00 与 06:00–10:00**，
 *    中国法定节假日全天按低谷。
 *  - 费用 = token 数 × 单价（文档 "Deduction Rules"）。
 *
 * 为什么把价目写死在代码里而不是读 env：价目是**事实**，不是部署参数；env 只用来覆盖
 * 我们无法离线知道的两件事（中国节假日、以及换价时的整体缩放）。
 */
export type DeepSeekTier = 'flash' | 'pro';

/** 单价（USD / 1M tokens）。 */
export type PriceRow = {
  /** 输入命中缓存 */
  readonly cacheHit: number;
  /** 输入未命中缓存 */
  readonly cacheMiss: number;
  /** 输出 */
  readonly output: number;
};

/** 官方价目表（高峰价；低谷 = 一半）。 */
export const DEEPSEEK_PRICES: Record<DeepSeekTier, PriceRow> = {
  flash: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
  pro: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
};

/** 高峰时段（UTC 小时，左闭右开）：01:00–04:00、06:00–10:00。 */
export const PEAK_WINDOWS_UTC: readonly (readonly [number, number])[] = [
  [1, 4],
  [6, 10],
];

/** 价目版本号：换价时改这里，历史行仍按当时算过的金额存库。 */
export const PRICE_VERSION = 'deepseek-2026-11-10';

/** 1M tokens 的除数（`cost = tokens / 1e6 * price`）。 */
const PER_MILLION = 1_000_000;

/** 模型名 → 计费档。认 `flash` / `pro`；未知档按 flash 计（官方也是这么兜底的）。 */
export function resolveTier(model: string | null | undefined): DeepSeekTier {
  const name = (model ?? '').toLowerCase();
  return name.includes('pro') ? 'pro' : 'flash';
}

/** `YYYY-MM-DD`（UTC 日）。 */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * 是否高峰时段。
 *
 * @param at 计费时刻（UTC）
 * @param holidays 额外视为低谷的 UTC 日期（`YYYY-MM-DD`）。中国法定节假日无法离线推导，
 *   由调用方从 `PI_BOT_PEAK_HOLIDAYS`（逗号分隔）传进来；不传就只按「工作日 + 时段」判。
 */
export function isPeakHour(at: Date, holidays: readonly string[] = []): boolean {
  const day = at.getUTCDay(); // 0=周日 … 6=周六
  if (day === 0 || day === 6) return false;
  if (holidays.includes(utcDay(at))) return false;
  const hour = at.getUTCHours() + at.getUTCMinutes() / 60;
  return PEAK_WINDOWS_UTC.some(([from, to]) => hour >= from && hour < to);
}

export type UsageTokens = {
  /** 未命中缓存的输入 token */
  readonly inputTokens: number;
  /** 命中缓存的输入 token（DeepSeek 的 `cacheReadTokens`，单独计价） */
  readonly cacheReadTokens: number;
  /** 输出 token */
  readonly outputTokens: number;
};

export type CostBreakdown = {
  readonly costUsd: number;
  readonly tier: DeepSeekTier;
  readonly peak: boolean;
  readonly price: PriceRow;
  readonly priceVersion: string;
  /** 参与计价的三段 token（`input` 只含未命中部分）。 */
  readonly tokens: UsageTokens;
};

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * 算一次 turn 的金额。
 *
 * 口径：`inputTokens` 是**未命中缓存**的那部分（DeepSeek 的 usage 里 `inputTokens` 与
 * `cacheReadTokens` 是并列的两段，`totalTokens = cacheRead + input + output`），
 * 所以三段各乘各的价，不要先加总再乘。
 */
export function estimateDeepSeekCostUsd(input: {
  readonly model: string | null | undefined;
  readonly tokens: UsageTokens;
  readonly at: Date;
  readonly holidays?: readonly string[];
  /** 整体缩放（换价但没改代码时的应急口子）；默认 1。 */
  readonly scale?: number;
}): CostBreakdown {
  const tier = resolveTier(input.model);
  const peak = isPeakHour(input.at, input.holidays);
  const base = DEEPSEEK_PRICES[tier];
  const price: PriceRow = peak
    ? base
    : { cacheHit: base.cacheHit / 2, cacheMiss: base.cacheMiss / 2, output: base.output / 2 };
  const tokens: UsageTokens = {
    inputTokens: nonNegative(input.tokens.inputTokens),
    cacheReadTokens: nonNegative(input.tokens.cacheReadTokens),
    outputTokens: nonNegative(input.tokens.outputTokens),
  };
  const raw =
    (tokens.inputTokens / PER_MILLION) * price.cacheMiss +
    (tokens.cacheReadTokens / PER_MILLION) * price.cacheHit +
    (tokens.outputTokens / PER_MILLION) * price.output;
  const scaled = raw * (input.scale ?? 1);
  // 金额列是 numeric(12,6)：这里就按 6 位小数收敛，避免库里出现 1e-9 的尾巴
  return {
    costUsd: Math.round(scaled * 1_000_000) / 1_000_000,
    tier,
    peak,
    price,
    priceVersion: PRICE_VERSION,
    tokens,
  };
}

/** 从 `PI_BOT_PEAK_HOLIDAYS`（`YYYY-MM-DD,YYYY-MM-DD`）解析节假日；非法项直接忽略。 */
export function parseHolidays(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item));
}
