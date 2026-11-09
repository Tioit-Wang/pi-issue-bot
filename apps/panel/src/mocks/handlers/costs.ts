import { http, type HttpHandler } from 'msw';
import type { CostsResponse } from '../../lib/contract.ts';
import { MOCK_NOW, costsEmptyFixture } from '../fixtures.ts';
import { scenarioResponse } from './shared.ts';

/**
 * 成本页（S4）的拦截器 —— **W3-J 只改这一个文件**。
 * 契约：`GET /api/costs`（`CostsResponse`，见 `docs/spec/contract-api.md` §4）。
 *
 * 造数口径（与后端聚合一致，页面才能看出「堆叠柱 = 输入 + 输出」）：
 * - `byRepo` 的 token 之和 = `total` 的 token 之和（回款对得上账）；
 * - `byModel` 里留一个**没命中价格表**的模型，`pricingCoverage` 因此 = 0.87 而不是 1，
 *   页面上的「定价覆盖率」告警分支才有东西可显示（契约：0–1 的 number，不乘 100）；
 * - `topTasks` 给满 10 条（`top` 默认值就是 10），其中一条 `endedAt: null`（尚未结束 → 面板显示 `—`）。
 */

/** 按 costUsd 降序（契约要求）。 */
export function costsMock(): CostsResponse {
  return {
    generatedAt: MOCK_NOW,
    window: { from: '2026-05-31T12:00:00.000Z', to: MOCK_NOW },
    currency: 'USD',
    total: {
      inputTokens: 3_842_000,
      outputTokens: 1_126_500,
      costUsd: 12.4837,
      // 13/15 个 run 命中价格表
      pricingCoverage: 0.866667,
    },
    byRepo: [
      { key: 'acme/widgets', inputTokens: 2_310_000, outputTokens: 688_000, costUsd: 7.6125, tasks: 21, runs: 24 },
      { key: 'acme/billing', inputTokens: 1_020_000, outputTokens: 301_500, costUsd: 3.2841, tasks: 9, runs: 11 },
      { key: 'other/lib', inputTokens: 512_000, outputTokens: 137_000, costUsd: 1.5871, tasks: 5, runs: 6 },
    ],
    byCommand: [
      { key: '/review-pr', inputTokens: 2_420_000, outputTokens: 742_000, costUsd: 8.0236, tasks: 18, runs: 22 },
      { key: 'auto:triage', inputTokens: 890_000, outputTokens: 241_500, costUsd: 3.1204, tasks: 11, runs: 12 },
      { key: 'auto:compliance', inputTokens: 412_000, outputTokens: 118_000, costUsd: 1.0892, tasks: 5, runs: 5 },
      { key: '/triage', inputTokens: 120_000, outputTokens: 25_000, costUsd: 0.2505, tasks: 1, runs: 2 },
    ],
    byModel: [
      {
        key: 'anthropic/claude-sonnet-4',
        inputTokens: 2_640_000,
        outputTokens: 806_000,
        costUsd: 9.4217,
        tasks: 19,
        runs: 22,
      },
      { key: 'openai/gpt-5-codex', inputTokens: 812_000, outputTokens: 214_500, costUsd: 2.7620, tasks: 9, runs: 10 },
      // 未命中价格表：usage 有记录，成本按 0 计（契约：0 = 跑了但没花钱，null = 没有这个值）
      { key: 'local/unpriced-qwen', inputTokens: 390_000, outputTokens: 106_000, costUsd: 0, tasks: 7, runs: 9 },
    ],
    // 按日期升序
    series: [
      { day: '2026-05-28', costUsd: 1.2044, inputTokens: 402_000, outputTokens: 118_000 },
      { day: '2026-05-29', costUsd: 2.9318, inputTokens: 921_000, outputTokens: 274_500 },
      { day: '2026-05-30', costUsd: 1.7742, inputTokens: 588_000, outputTokens: 161_000 },
      { day: '2026-05-31', costUsd: 3.6409, inputTokens: 1_181_000, outputTokens: 353_000 },
      { day: '2026-06-01', costUsd: 2.9324, inputTokens: 750_000, outputTokens: 220_000 },
    ],
    topTasks: [
      {
        taskId: 't-2026-0601-01',
        repo: 'acme/widgets',
        command: '/review-pr',
        costUsd: 1.4821,
        inputTokens: 412_000,
        outputTokens: 128_000,
        endedAt: '2026-06-01T09:12:00.000Z',
      },
      {
        taskId: 't-2026-0601-02',
        repo: 'acme/billing',
        command: 'auto:triage',
        costUsd: 1.1903,
        inputTokens: 331_000,
        outputTokens: 96_500,
        endedAt: '2026-06-01T08:41:00.000Z',
      },
      {
        taskId: 't-2026-0601-03',
        repo: 'acme/widgets',
        command: '/review-pr',
        costUsd: 0.9744,
        inputTokens: 288_000,
        outputTokens: 74_000,
        endedAt: '2026-06-01T07:58:00.000Z',
      },
      {
        taskId: 't-2026-0601-04',
        repo: 'acme/widgets',
        command: '/review-pr',
        costUsd: 0.8612,
        inputTokens: 260_000,
        outputTokens: 66_500,
        endedAt: '2026-06-01T06:30:00.000Z',
      },
      {
        taskId: 't-2026-0601-05',
        repo: 'other/lib',
        command: 'auto:compliance',
        costUsd: 0.7938,
        inputTokens: 240_000,
        outputTokens: 61_000,
        endedAt: '2026-06-01T05:47:00.000Z',
      },
      {
        taskId: 't-2026-0601-06',
        repo: 'acme/billing',
        command: '/review-pr',
        costUsd: 0.7102,
        inputTokens: 214_000,
        outputTokens: 58_000,
        endedAt: '2026-06-01T04:22:00.000Z',
      },
      {
        taskId: 't-2026-0601-07',
        repo: 'acme/widgets',
        command: 'auto:triage',
        costUsd: 0.6419,
        inputTokens: 196_000,
        outputTokens: 52_500,
        endedAt: '2026-06-01T03:15:00.000Z',
      },
      {
        taskId: 't-2026-0601-08',
        repo: 'other/lib',
        command: '/review-pr',
        costUsd: 0.5327,
        inputTokens: 168_000,
        outputTokens: 44_000,
        endedAt: '2026-06-01T02:40:00.000Z',
      },
      {
        taskId: 't-2026-0601-09',
        repo: 'acme/billing',
        command: 'auto:compliance',
        costUsd: 0.4108,
        inputTokens: 132_000,
        outputTokens: 35_500,
        endedAt: '2026-06-01T01:55:00.000Z',
      },
      {
        // 还在跑：endedAt 为 null（契约：未结束为 null，面板显示 `—` 而不是 0）
        taskId: 't-2026-0601-10',
        repo: 'acme/widgets',
        command: '/review-pr',
        costUsd: 0.3964,
        inputTokens: 128_000,
        outputTokens: 32_000,
        endedAt: null,
      },
    ],
  };
}

export const costsHandlers: HttpHandler[] = [
  http.get('/api/costs', () => scenarioResponse({ data: costsMock(), empty: costsEmptyFixture() })),
];
