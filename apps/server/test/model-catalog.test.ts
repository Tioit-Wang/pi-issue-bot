/**
 * 模型参数（上下文窗口 / 输出上限）来源的纯函数测试。
 *
 * 断言的都是**可观察事实**：从哪里取到、取到多少、取不到时说清原因 —— 不测「有没有调用」。
 * 这层的意义在于：压缩预算一旦拿到错的窗口，要么每轮都压缩、要么直接撞 provider 400，
 * 所以数字与 `source` 必须钉死。
 */
import { describe, expect, it } from 'vitest';
import {
  KNOWN_MODEL_PARAMETERS,
  matchCatalogEntry,
  matchKnownParameters,
  normalizeModelName,
  parseOpenRouterPayload,
  resolveModelParameters,
} from '../src/config/model-catalog.ts';

/** 一份最小的 OpenRouter 形状（只留本模块用到的字段）。 */
function payloadOf(entries: readonly { id: string; ctx?: number | null; maxOut?: number | null }[]): unknown {
  return {
    data: entries.map((entry) => ({
      id: entry.id,
      context_length: entry.ctx === undefined ? 1_000_000 : entry.ctx,
      top_provider: { max_completion_tokens: entry.maxOut === undefined ? 32_768 : entry.maxOut },
    })),
  };
}

describe('normalizeModelName', () => {
  it('去掉 vendor 前缀与 :batch 变体，再小写', () => {
    expect(normalizeModelName('deepseek/deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash');
    expect(normalizeModelName('Xiaomi/MiMo-v2.6-pro')).toBe('mimo-v2.6-pro');
    expect(normalizeModelName('deepseek/deepseek-v4.1-flash:batch')).toBe('deepseek-v4.1-flash');
    expect(normalizeModelName('  gpt-5  ')).toBe('gpt-5');
    // 没有 vendor 前缀的名字原样返回（本地目录就是这么写的）
    expect(normalizeModelName('deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash');
  });
});

describe('parseOpenRouterPayload', () => {
  it('坏数据逐条丢弃，缺字段的条目保留（能证明「这个模型在库里」）', () => {
    const entries = parseOpenRouterPayload({
      data: [
        { id: 'deepseek/deepseek-v4.1-flash', context_length: 1_048_576, top_provider: { max_completion_tokens: 393_216 } },
        { id: '', context_length: 1_000 },
        { context_length: 1_000 },
        null,
        { id: 'xiaomi/mimo-v2.6-pro' },
      ],
    });

    expect(entries.map((entry) => entry.id)).toEqual(['deepseek/deepseek-v4.1-flash', 'xiaomi/mimo-v2.6-pro']);
    expect(entries[0]).toMatchObject({ contextLength: 1_048_576, maxCompletionTokens: 393_216 });
    // 缺字段：数字为 null，不是 0
    expect(entries[1]).toMatchObject({ contextLength: null, maxCompletionTokens: null });
  });

  it('响应体不是对象 / data 不是数组时回空数组（不抛错）', () => {
    expect(parseOpenRouterPayload(null)).toEqual([]);
    expect(parseOpenRouterPayload('nope')).toEqual([]);
    expect(parseOpenRouterPayload({ data: 'nope' })).toEqual([]);
  });
});

describe('matchCatalogEntry', () => {
  const entries = parseOpenRouterPayload(
    payloadOf([
      { id: 'deepseek/deepseek-v4.1-flash', ctx: 1_048_576, maxOut: 393_216 },
      { id: 'deepseek/deepseek-v4.1-flash-1017', ctx: 1_048_576, maxOut: 393_216 },
      { id: 'xiaomi/mimo-v2.5', ctx: 1_000_000, maxOut: 65_536 },
      { id: 'xiaomi/mimo-v2.5-pro', ctx: 1_024_000, maxOut: 131_072 },
    ]),
  );

  it('完全相等优先（不会因为存在 -1017 快照就跑偏）', () => {
    expect(matchCatalogEntry(entries, 'deepseek-v4.1-flash')?.id).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('没有完全相等时用「以它开头」的快照，且取最短的那个', () => {
    expect(matchCatalogEntry(entries, 'deepseek-v4.1')?.id).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('不做反向包含：mimo-v2.5 不会被安上 pro 的窗口', () => {
    expect(matchCatalogEntry(entries, 'mimo-v2.5')?.id).toBe('xiaomi/mimo-v2.5');
    expect(matchCatalogEntry(entries, 'mimo-v2.5-pro')?.id).toBe('xiaomi/mimo-v2.5-pro');
    // 库里有 mimo-v2.5 / -pro，但没有 v2.6：v2.6 不许命中 v2.5
    expect(matchCatalogEntry(entries, 'mimo-v2.6-pro')).toBeNull();
  });

  it('空名 / 库里没有 → null', () => {
    expect(matchCatalogEntry(entries, '   ')).toBeNull();
    expect(matchCatalogEntry(entries, 'some-private-model')).toBeNull();
  });
});

describe('matchKnownParameters（内置兜底表）', () => {
  it('覆盖 DeepSeek v4 系与 MiMo v2.6 系的真实参数', () => {
    // 这两个数字是 2026-11 从 OpenRouter 公共库抓到的：1M 上下文 / 393K 输出；1.05M / 131K
    expect(matchKnownParameters('deepseek-v4.1-flash')).toMatchObject({
      contextWindow: 1_048_576,
      maxOutputTokens: 393_216,
      family: 'deepseek-v4',
    });
    expect(matchKnownParameters('deepseek/deepseek-v4-pro')).toMatchObject({ family: 'deepseek-v4' });
    expect(matchKnownParameters('xiaomi/mimo-v2.6-pro')).toMatchObject({
      contextWindow: 1_050_000,
      maxOutputTokens: 131_072,
      family: 'mimo-v2.6',
    });
    expect(matchKnownParameters('mimo-v2.6-flash')).toMatchObject({ family: 'mimo-v2.6' });
  });

  it('表外模型一律不命中（宁可不给，也不要猜）', () => {
    expect(matchKnownParameters('deepseek-chat')).toBeNull();
    expect(matchKnownParameters('mimo-v2.5-pro')).toBeNull();
    expect(matchKnownParameters('gpt-4.1')).toBeNull();
    expect(KNOWN_MODEL_PARAMETERS).toHaveLength(2);
  });
});

describe('resolveModelParameters', () => {
  const payload = payloadOf([
    { id: 'deepseek/deepseek-v4.1-flash', ctx: 1_048_576, maxOut: 393_216 },
    { id: 'someone/no-limits-model', ctx: null, maxOut: null },
  ]);

  it('联网命中：source=openrouter，带上外部 id', () => {
    expect(resolveModelParameters('deepseek-v4.1-flash', payload)).toEqual({
      model: 'deepseek-v4.1-flash',
      found: true,
      contextWindow: 1_048_576,
      maxOutputTokens: 393_216,
      source: 'openrouter',
      matchedId: 'deepseek/deepseek-v4.1-flash',
      error: null,
    });
  });

  it('联网失败（null）：表命中的给 table + 原因，让人知道数字不新鲜', () => {
    const result = resolveModelParameters('mimo-v2.6-pro', null);
    expect(result).toMatchObject({
      found: true,
      contextWindow: 1_050_000,
      maxOutputTokens: 131_072,
      source: 'table',
      matchedId: null,
    });
    expect(result.error).toContain('联网查询失败');
  });

  it('联网成功但库里没有：仍然用表，原因写「公共库里没有这一条」', () => {
    const result = resolveModelParameters('mimo-v2.6-pro', payload);
    expect(result.source).toBe('table');
    expect(result.error).toContain('公共库里没有这一条');
  });

  it('库里命中但没有窗口字段：found=false 且数字为 null（不写 0）', () => {
    expect(resolveModelParameters('no-limits-model', payload)).toMatchObject({
      found: false,
      contextWindow: null,
      maxOutputTokens: null,
      source: 'none',
      matchedId: 'someone/no-limits-model',
    });
  });

  it('两处都没有：source=none，原因分清「联网失败」与「查无此模型」', () => {
    expect(resolveModelParameters('llama-9-private', payload)).toMatchObject({
      found: false,
      source: 'none',
      error: '公共库与内置表里都没有这个模型',
    });
    expect(resolveModelParameters('llama-9-private', null).error).toContain('联网查询失败');
  });
});
