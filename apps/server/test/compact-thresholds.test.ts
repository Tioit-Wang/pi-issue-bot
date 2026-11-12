/**
 * 双阈值的断言（FR-5.6「触发」/ `docs/v21-contract.md` §6）。
 *
 * 三个窗口都要过一遍，因为公式里的 max/min 只在特定窗口组合下才现形：
 *  - 32k：预留由 16k 地板决定（0.25×32k=8k、5%×32k=1.6k 都更小）；
 *  - 128k：地板仍然是主导（0.25×128k=32k 但输出上限未知 → 按 0 处理）；
 *  - 1M：5%×1M=50k 反超 16k 地板，预留第三次换人。
 */
import { describe, expect, it } from 'vitest';

import {
  COMPACTION_DEFAULTS,
  planCompaction,
  summaryBudgetFor,
} from '../src/compact/thresholds.ts';

describe('planCompaction · 双阈值', () => {
  it('32k 窗口：预留 16k，hard 16k / auto 14.4k', () => {
    const plan = planCompaction({ windowTokens: 32_000, currentTokens: 0, generation: 0 });
    expect(plan.hardLimit).toBe(16_000);
    expect(plan.autoLimit).toBe(14_400);
    expect(plan.needed).toBe(false);
    expect(plan.reason).toBe('below');
  });

  it('128k 窗口：预留仍为 16k 地板，hard 112k', () => {
    const plan = planCompaction({ windowTokens: 128_000, currentTokens: 0, generation: 0 });
    expect(plan.hardLimit).toBe(112_000);
    expect(plan.autoLimit).toBe(100_800);
  });

  it('1M 窗口：5% 反超地板，预留 50k，hard 950k', () => {
    const plan = planCompaction({ windowTokens: 1_000_000, currentTokens: 0, generation: 0 });
    expect(plan.hardLimit).toBe(950_000);
    expect(plan.autoLimit).toBe(855_000);
  });

  it('给到输出上限时，25% 那一项才参与（min(25% 窗口, 输出上限)）', () => {
    const plan = planCompaction({
      windowTokens: 128_000,
      outputLimitTokens: 64_000,
      currentTokens: 0,
      generation: 0,
    });
    // min(0.25×128k, 64k) = 32k > 地板 16k → 预留 32k
    expect(plan.hardLimit).toBe(96_000);
    expect(plan.autoLimit).toBe(86_400);
  });

  it('输出上限小于 25% 窗口时按输出上限预留', () => {
    const plan = planCompaction({
      windowTokens: 1_000_000,
      outputLimitTokens: 60_000,
      currentTokens: 0,
      generation: 0,
    });
    // min(250k, 60k) = 60k > max(16k, 50k) → 预留 60k
    expect(plan.hardLimit).toBe(940_000);
  });

  it('autoLimit 恒等于 hardLimit 的 90%', () => {
    for (const windowTokens of [32_000, 64_000, 128_000, 200_000, 1_000_000]) {
      const plan = planCompaction({ windowTokens, currentTokens: 0, generation: 0 });
      expect(plan.autoLimit).toBe(Math.trunc(COMPACTION_DEFAULTS.autoRatio * plan.hardLimit));
    }
  });
});

describe('planCompaction · 硬边界不会变成非正数', () => {
  it.each([
    ['窗口为 0', 0],
    ['窗口为负', -1],
    ['窗口是 NaN', Number.NaN],
    ['窗口比 32k 下限还小', 8_000],
  ])('%s：按 32k 下限算，hard=16k', (_label, windowTokens) => {
    const plan = planCompaction({ windowTokens, currentTokens: 0, generation: 0 });
    expect(plan.hardLimit).toBeGreaterThan(0);
    expect(plan.hardLimit).toBe(16_000);
    expect(plan.autoLimit).toBe(14_400);
  });

  it('autoLimit 不会大于 hardLimit', () => {
    const plan = planCompaction({ windowTokens: 32_000, currentTokens: 0, generation: 0 });
    expect(plan.autoLimit).toBeLessThanOrEqual(plan.hardLimit);
  });
});

describe('planCompaction · reason 与 needed', () => {
  const windowTokens = 128_000;
  const hard = 112_000;
  const auto = 100_800;

  it('差 1 个 token 到自动线：still below', () => {
    const plan = planCompaction({ windowTokens, currentTokens: auto - 1, generation: 0 });
    expect(plan.reason).toBe('below');
    expect(plan.needed).toBe(false);
  });

  it('刚好到自动线：auto', () => {
    const plan = planCompaction({ windowTokens, currentTokens: auto, generation: 0 });
    expect(plan.reason).toBe('auto');
    expect(plan.needed).toBe(true);
  });

  it('刚好到硬边界：hard', () => {
    const plan = planCompaction({ windowTokens, currentTokens: hard, generation: 0 });
    expect(plan.reason).toBe('hard');
    expect(plan.needed).toBe(true);
  });

  it('超过硬边界：hard', () => {
    const plan = planCompaction({ windowTokens, currentTokens: hard + 5_000, generation: 0 });
    expect(plan.reason).toBe('hard');
  });

  it('currentTokens 的脏值（负 / NaN）按 0 处理', () => {
    expect(planCompaction({ windowTokens, currentTokens: -1, generation: 0 }).reason).toBe('below');
    expect(
      planCompaction({ windowTokens, currentTokens: Number.NaN, generation: 0 }).currentTokens,
    ).toBe(0);
  });

  it('generation 原样透传（负数收敛为 0）', () => {
    expect(planCompaction({ windowTokens, currentTokens: 0, generation: 7 }).generation).toBe(7);
    expect(planCompaction({ windowTokens, currentTokens: 0, generation: -3 }).generation).toBe(0);
  });
});

describe('summaryBudgetFor', () => {
  it('hardLimit 扣掉最近窗口预算', () => {
    expect(summaryBudgetFor(16_000, 8_000)).toBe(8_000);
  });

  it('至少给 2k（窗口极小时不能把摘要预算压成 0）', () => {
    expect(summaryBudgetFor(16_000, 15_000)).toBe(2_000);
    expect(summaryBudgetFor(1_000, 1_000)).toBe(2_000);
  });
});
