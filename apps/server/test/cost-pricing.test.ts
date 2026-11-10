/**
 * DeepSeek 官方价目（`cost/pricing.ts`）。
 *
 * 断言的都是**文档里写死的数**（<https://api-docs.deepseek.com/quick_start/pricing>）：
 *  - flash：命中 $0.006 / 未命中 $0.30 / 输出 $1.20（每 1M，高峰价）
 *  - 低谷 = 高峰的一半
 *  - 高峰 = UTC 工作日 01–04、06–10
 */
import { describe, expect, it } from 'vitest';

import {
  DEEPSEEK_PRICES,
  PRICE_VERSION,
  estimateDeepSeekCostUsd,
  isPeakHour,
  parseHolidays,
  resolveTier,
} from '../src/cost/index.ts';

/** 周二 02:00 UTC（高峰）。 */
const TUESDAY_PEAK = new Date('2026-11-10T02:00:00Z');
/** 周二 05:00 UTC（两段高峰之间 → 低谷）。 */
const TUESDAY_OFF = new Date('2026-11-10T05:00:00Z');
/** 周日 02:00 UTC（周末 → 低谷）。 */
const SUNDAY_PEAK_HOUR = new Date('2026-11-08T02:00:00Z');

describe('价目表与档位', () => {
  it('flash 的三段价与官方文档一致', () => {
    expect(DEEPSEEK_PRICES.flash).toEqual({ cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 });
    expect(DEEPSEEK_PRICES.pro).toEqual({ cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 });
    expect(PRICE_VERSION).toContain('deepseek');
  });

  it('模型名认 flash / pro，未知按 flash', () => {
    expect(resolveTier('deepseek-v4.1-flash')).toBe('flash');
    expect(resolveTier('deepseek-v4-flash')).toBe('flash');
    expect(resolveTier('deepseek-v4-pro')).toBe('pro');
    expect(resolveTier(null)).toBe('flash');
    expect(resolveTier('aimom/whatever')).toBe('flash');
  });
});

describe('高峰时段判定', () => {
  it('工作日的高峰窗口内为 true，窗口外为 false', () => {
    expect(isPeakHour(new Date('2026-11-10T01:00:00Z'))).toBe(true);
    expect(isPeakHour(new Date('2026-11-10T03:59:00Z'))).toBe(true);
    expect(isPeakHour(new Date('2026-11-10T04:00:00Z'))).toBe(false);
    expect(isPeakHour(new Date('2026-11-10T05:00:00Z'))).toBe(false);
    expect(isPeakHour(new Date('2026-11-10T06:00:00Z'))).toBe(true);
    expect(isPeakHour(new Date('2026-11-10T09:59:00Z'))).toBe(true);
    expect(isPeakHour(new Date('2026-11-10T10:00:00Z'))).toBe(false);
  });

  it('周末全天低谷', () => {
    expect(isPeakHour(SUNDAY_PEAK_HOUR)).toBe(false);
    expect(isPeakHour(new Date('2026-11-14T07:00:00Z'))).toBe(false); // 周六
  });

  it('节假日表里的日期按低谷算', () => {
    expect(isPeakHour(TUESDAY_PEAK, ['2026-11-10'])).toBe(false);
    expect(isPeakHour(TUESDAY_PEAK, ['2026-11-11'])).toBe(true);
  });
});

describe('金额计算', () => {
  const tokens = { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 };

  it('高峰价：三段各乘各的价（不是先加总再乘）', () => {
    const cost = estimateDeepSeekCostUsd({ model: 'deepseek-v4.1-flash', tokens, at: TUESDAY_PEAK });
    // 1M 未命中 0.30 + 1M 命中 0.006 + 1M 输出 1.20
    expect(cost.peak).toBe(true);
    expect(cost.costUsd).toBeCloseTo(1.506, 6);
  });

  it('低谷价正好是高峰的一半', () => {
    const cost = estimateDeepSeekCostUsd({ model: 'deepseek-v4.1-flash', tokens, at: TUESDAY_OFF });
    expect(cost.peak).toBe(false);
    expect(cost.costUsd).toBeCloseTo(0.753, 6);
  });

  it('pro 档比 flash 贵（同一份 token）', () => {
    const flash = estimateDeepSeekCostUsd({ model: 'deepseek-v4.1-flash', tokens, at: TUESDAY_PEAK });
    const pro = estimateDeepSeekCostUsd({ model: 'deepseek-v4-pro', tokens, at: TUESDAY_PEAK });
    expect(pro.costUsd).toBeGreaterThan(flash.costUsd);
  });

  it('真实一轮（13202 未命中 + 43648 命中 + 3304 输出，低谷）', () => {
    const cost = estimateDeepSeekCostUsd({
      model: 'deepseek-v4.1-flash',
      tokens: { inputTokens: 13202, cacheReadTokens: 43648, outputTokens: 3304 },
      at: TUESDAY_OFF,
    });
    // 13202/1e6*0.15 + 43648/1e6*0.003 + 3304/1e6*0.6 = 0.0019803 + 0.00013094 + 0.0019824
    expect(cost.costUsd).toBeCloseTo(0.004094, 6);
  });

  it('负数/NaN 一律当 0，不产生负金额', () => {
    const cost = estimateDeepSeekCostUsd({
      model: 'deepseek-v4.1-flash',
      tokens: { inputTokens: -5, cacheReadTokens: Number.NaN, outputTokens: 0 },
      at: TUESDAY_PEAK,
    });
    expect(cost.costUsd).toBe(0);
  });

  it('scale 可以整体缩放（换价的应急口子）', () => {
    const cost = estimateDeepSeekCostUsd({ model: 'deepseek-v4.1-flash', tokens, at: TUESDAY_PEAK, scale: 2 });
    expect(cost.costUsd).toBeCloseTo(3.012, 6);
  });
});

describe('parseHolidays', () => {
  it('只认 YYYY-MM-DD，其余忽略', () => {
    expect(parseHolidays('2026-01-01, 2026-02-17 ,bad,2026-1-1')).toEqual(['2026-01-01', '2026-02-17']);
    expect(parseHolidays(undefined)).toEqual([]);
    expect(parseHolidays('')).toEqual([]);
  });
});
