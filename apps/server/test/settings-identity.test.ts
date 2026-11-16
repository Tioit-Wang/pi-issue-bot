/**
 * CFG-8.2 / CFG-8.3 / CFG-9.2 的**纯逻辑**用例（不连库、不连网络）。
 *
 * 三块：
 *  1. `classifyIdentityState()` —— 令牌三态的唯一判定实现（缺失 / scope 不足 / 过期）；
 *  2. `estimateDeepSeekCostUsd({ resolvePrice })` —— 单价从配置读，取不到退回官价表；
 *  3. `hostModelNameEnv()` / `hostEndpointEnv()` —— 执行模型名与供应商端点的环境增量。
 *
 * 为什么要这些用例：它们都是「一个数字/一个判定错了，面板上却看不出来」的地方
 * （三态判反 = 用过期令牌写回；单价取错 = 成本页少一个数量级）。
 */
import { describe, expect, it } from 'vitest';

import {
  CLASSIC_SCOPE_EQUIVALENTS,
  classifyIdentityState,
  maskSecret,
  missingRequiredScopes,
  REQUIRED_PANEL_IDENTITY_SCOPES,
} from '../../../packages/contract/src/index.ts';
import { estimateDeepSeekCostUsd } from '../src/cost/index.ts';
import type { PriceResolver } from '../src/cost/index.ts';
import { HOST_MODEL_ENV_KEYS, hostEndpointEnv, hostModelNameEnv } from '../src/app/index.ts';

/** 判定时刻（注入时钟：三态里有一项是时间比较）。 */
const FIXED_NOW = new Date('2026-06-01T12:00:00.000Z');

describe('CFG-9.2 令牌三态判定', () => {
  it('没配个人 PAT → missing（一切写回以 bot 署名，合法默认）', () => {
    const result = classifyIdentityState({ configured: false, scopes: null, expiresAt: null, at: FIXED_NOW });
    expect(result.state).toBe('missing');
    expect(result.reason).toContain('bot');
  });

  it('配了但还没读过 scope → unchecked（不是「权限不足」，不能混为一谈）', () => {
    const result = classifyIdentityState({ configured: true, scopes: null, expiresAt: null, at: FIXED_NOW });
    expect(result.state).toBe('unchecked');
  });

  it('有 issues:write → ok；只有 repo（经典 PAT）也算满足', () => {
    expect(
      classifyIdentityState({ configured: true, scopes: ['issues:write'], expiresAt: null, at: FIXED_NOW }).state,
    ).toBe('ok');
    expect(classifyIdentityState({ configured: true, scopes: ['repo'], expiresAt: null, at: FIXED_NOW }).state).toBe(
      'ok',
    );
  });

  it('只有 read 类 scope → insufficient-scope，且说清缺哪个', () => {
    const result = classifyIdentityState({
      configured: true,
      scopes: ['read:user', 'public_repo'],
      expiresAt: null,
      at: FIXED_NOW,
    });
    expect(result.state).toBe('insufficient-scope');
    expect(result.reason).toContain('issues:write');
  });

  it('过期（<= 判定时刻）→ expired，哪怕 scope 齐全', () => {
    const result = classifyIdentityState({
      configured: true,
      scopes: ['repo'],
      expiresAt: '2026-06-01T11:59:59.000Z',
      at: FIXED_NOW,
    });
    expect(result.state).toBe('expired');
    expect(result.reason).toContain('2026-06-01T11:59:59.000Z');
  });

  it('恰好等于判定时刻也算过期（边界闭区间）', () => {
    expect(
      classifyIdentityState({
        configured: true,
        scopes: ['repo'],
        expiresAt: '2026-06-01T12:00:00.000Z',
        at: FIXED_NOW,
      }).state,
    ).toBe('expired');
  });

  it('还没到期 → 继续按 scope 判定（顺序：缺失 > 过期 > scope）', () => {
    expect(
      classifyIdentityState({
        configured: true,
        scopes: ['repo'],
        expiresAt: '2026-07-01T00:00:00.000Z',
        at: FIXED_NOW,
      }).state,
    ).toBe('ok');
  });

  it('必需 scope 清单与经典等价集是同源的（不各写一份）', () => {
    expect([...REQUIRED_PANEL_IDENTITY_SCOPES]).toEqual(['issues:write']);
    expect(CLASSIC_SCOPE_EQUIVALENTS['issues:write']).toEqual(['repo']);
    expect([...missingRequiredScopes(['repo', 'issues:write'])]).toEqual([]);
  });

  it('掩码只留头 4 尾 4；太短的整串打点（不泄露长度）', () => {
    expect(maskSecret('github_pat_1234567890abcdef')).toBe('gith…cdef');
    expect(maskSecret('short')).toBe('…');
  });
});

describe('CFG-8.2 单价从配置读', () => {
  const tokens = { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 1_000_000 };

  it('配了单价 → 用配置价（1M 输入 + 1M 输出 = 3 + 15）', () => {
    const resolvePrice: PriceResolver = (model) =>
      model === 'my-model' ? { input_usd_per_mtok: 3, output_usd_per_mtok: 15 } : null;
    const cost = estimateDeepSeekCostUsd({ model: 'my-model', tokens, at: FIXED_NOW, resolvePrice });
    expect(cost.pricingSource).toBe('config');
    expect(cost.costUsd).toBeCloseTo(18, 6);
  });

  it('配了单价时不分高峰/低谷（那是 DeepSeek 自家规则）', () => {
    const resolvePrice: PriceResolver = () => { return { input_usd_per_mtok: 3, output_usd_per_mtok: 15 }; };
    const peak = estimateDeepSeekCostUsd({
      model: 'my-model',
      tokens,
      at: new Date('2026-11-10T02:00:00Z'),
      resolvePrice,
    });
    expect(peak.costUsd).toBeCloseTo(18, 6);
  });

  it('配置里没有这个模型 → 退回官价表并标明 pricingSource=static（不补 0）', () => {
    const resolvePrice: PriceResolver = () => null;
    const cost = estimateDeepSeekCostUsd({
      model: 'deepseek-v4.1-flash',
      tokens: { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 },
      at: new Date('2026-11-10T02:00:00Z'),
      resolvePrice,
    });
    expect(cost.pricingSource).toBe('static');
    // 官价表 flash 高峰未命中价 0.3
    expect(cost.costUsd).toBeCloseTo(0.3, 6);
  });

  it('不传 resolvePrice 时行为与旧实现一致（static）', () => {
    const cost = estimateDeepSeekCostUsd({ model: 'deepseek-v4.1-flash', tokens, at: FIXED_NOW });
    expect(cost.pricingSource).toBe('static');
  });
});

describe('CFG-8.2 / CFG-8.3 执行模型 → pi-host 环境', () => {
  it('模型名同时写两个变量名（自定义名 + 标准别名）', () => {
    const env = hostModelNameEnv('deepseek-v4-pro');
    expect(env[HOST_MODEL_ENV_KEYS.name]).toBe('deepseek-v4-pro');
    expect(env[HOST_MODEL_ENV_KEYS.openaiModel]).toBe('deepseek-v4-pro');
    expect(Object.keys(env).sort()).toEqual([HOST_MODEL_ENV_KEYS.name, HOST_MODEL_ENV_KEYS.openaiModel].sort());
  });

  it('没配时**不出现**（不写空串：空串会被下游当成「显式配了个空模型名」）', () => {
    expect(hostModelNameEnv(null)).toEqual({});
    expect(hostModelNameEnv('')).toEqual({});
  });

  it('执行模型沿用部署级变量名（pi-host 只认它，`PI_BOT_MODEL_NAME`）', () => {
    expect(HOST_MODEL_ENV_KEYS.name).toBe('PI_BOT_MODEL_NAME');
  });

  it('供应商端点：给了就覆盖 key/base URL 两个名字，不给就空对象', () => {
    expect(hostEndpointEnv({ baseUrl: null, apiKey: null })).toEqual({});
    expect(hostEndpointEnv({ baseUrl: 'https://self.example/v1', apiKey: 'sk-x' })).toEqual({
      [HOST_MODEL_ENV_KEYS.apiKey]: 'sk-x',
      [HOST_MODEL_ENV_KEYS.openaiApiKey]: 'sk-x',
      [HOST_MODEL_ENV_KEYS.baseUrl]: 'https://self.example/v1',
      [HOST_MODEL_ENV_KEYS.openaiBaseUrl]: 'https://self.example/v1',
    });
  });
});
