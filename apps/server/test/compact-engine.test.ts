/**
 * 压缩引擎六阶降级的断言（FR-5.6「失败降级」+「可观测」）。
 *
 * 为什么全部注入假依赖：真实模型无法复现「连续 4 次超时」「401 立刻失败」「兜底也装不下」
 * 这些分支，而它们恰恰是最容易写错、也最贵的部分（发一个注定被拒的包 = 白烧一轮时限）。
 *
 * 每个用例对应降级链的一阶：
 *  1 预检（below 不调模型） → 2 重试 3 次 2/4/8s → 3 有界削减 500 → 4 分块链式
 *  → 5 兜底 checkpoint → 6 硬边界拒发。
 */
import { describe, expect, it } from 'vitest';

import {
  SUMMARY_MAX_RETRIES,
  SUMMARY_RETRY_BACKOFF_MS,
  buildFallbackSummary,
  compactSession,
  createCompactor,
  isFatalSummarizeError,
  planChunks,
  selectRecentWindow,
} from '../src/compact/engine.ts';
import type { CompactDeps, CompactionRecordInput, SummarizeResult } from '../src/compact/engine.ts';
import type { MessageLike } from '../src/compact/tokens.ts';

const NOW = 1_700_000_000_000;
const REPO = 'acme/widgets';
const SESSION = 'sess-1';
const WINDOW = 32_000; // hardLimit 16k / autoLimit 14.4k（见 thresholds 单测）

const VALID_SUMMARY = [
  '## 目标',
  '修掉登录接口 500',
  '',
  '## 约束与偏好',
  '不得改 packages/**',
  '',
  '## 进度',
  '已完成：定位到 src/login.ts:88',
  '进行中：补单测',
  '受阻：（无）',
  '',
  '## 关键决策',
  '改 src/login.ts 而不是加 try/catch 兜底',
  '',
  '## 下一步',
  '跑单测',
  '',
  '## 关键上下文',
  '报错原文：TypeError at src/login.ts:88',
].join('\n');

type Harness = {
  readonly deps: CompactDeps;
  readonly prompts: string[];
  readonly sleeps: number[];
  readonly records: CompactionRecordInput[];
};

/** 造一套注入依赖：脚本决定第 index 次摘要请求成功还是失败。 */
function harness(
  script: (prompt: string, index: number) => Promise<SummarizeResult>,
  options?: { readonly latestGeneration?: number },
): Harness {
  const prompts: string[] = [];
  const sleeps: number[] = [];
  const records: CompactionRecordInput[] = [];

  const deps: CompactDeps = {
    summarize: async (prompt: string): Promise<SummarizeResult> => {
      const index = prompts.length;
      prompts.push(prompt);
      return script(prompt, index);
    },
    store: {
      record: async (record: CompactionRecordInput): Promise<void> => {
        records.push(record);
      },
      latestGeneration: async (): Promise<number> => options?.latestGeneration ?? 0,
    },
    now: (): number => NOW,
    sleep: async (ms: number): Promise<void> => {
      sleeps.push(ms);
    },
  };

  return { deps, prompts, sleeps, records };
}

/** 每条消息约 505 token；40 条约 20k，稳定超过 32k 窗口的硬边界（16k）。 */
function history(count = 40, chars = 2_000): MessageLike[] {
  const padding = 'x'.repeat(chars);
  const messages: MessageLike[] = [];
  for (let index = 0; index < count; index += 1) {
    const cycle = index % 3;
    if (cycle === 0) {
      messages.push({ role: 'user', content: `问题 ${String(index)} ${padding}` });
    } else if (cycle === 1) {
      messages.push({
        role: 'assistant',
        content: `分析 ${String(index)} ${padding}`,
        toolCalls: [{ id: `call-${String(index)}`, name: 'Read' }],
      });
    } else {
      messages.push({
        role: 'tool',
        toolName: 'Read',
        toolCallId: `call-${String(index - 1)}`,
        content: `结果 ${String(index)} ${padding}`,
      });
    }
  }
  return messages;
}

function chunkCount(layers: readonly string[]): number {
  const layer = layers.find((item) => item.startsWith('chunked:'));
  if (layer === undefined) {
    return 0;
  }
  const parsed = Number(layer.slice('chunked:'.length));
  return Number.isFinite(parsed) ? parsed : 0;
}

describe('compactSession · 阶 1 预检', () => {
  it('未过自动线：直接返回 below，不调模型、不查库、不落记录', async () => {
    const h = harness(async () => ({ text: VALID_SUMMARY }));

    const result = await compactSession(h.deps, {
      repo: REPO,
      issueNumber: 7,
      sessionId: SESSION,
      windowTokens: WINDOW,
      messages: [{ role: 'user', content: '小问题' }],
    });

    expect(result.compacted).toBe(false);
    if (!result.compacted) {
      expect(result.reason).toBe('below');
      expect(result.layers).toEqual(['precheck']);
    }
    expect(h.prompts).toHaveLength(0);
    expect(h.records).toHaveLength(0);
    expect(h.sleeps).toHaveLength(0);
  });
});

describe('compactSession · 阶 2 摘要请求重试', () => {
  it('失败 3 次后第 4 次成功，退避 2/4/8 秒', async () => {
    const h = harness(async (_prompt, index) => {
      if (index < SUMMARY_MAX_RETRIES) {
        throw new Error('boom: upstream timeout');
      }
      return { text: VALID_SUMMARY };
    });

    const result = await compactSession(h.deps, {
      repo: REPO,
      issueNumber: 7,
      sessionId: SESSION,
      windowTokens: WINDOW,
      messages: history(),
    });

    expect(h.prompts).toHaveLength(SUMMARY_MAX_RETRIES + 1);
    expect(h.sleeps).toEqual([...SUMMARY_RETRY_BACKOFF_MS]);
    expect(result.compacted).toBe(true);
    if (result.compacted) {
      expect(result.fallback).toBe(false);
      expect(result.layers).toContain('summary:l1');
      expect(result.summary).toContain('## 目标');
    }
  });

  it('鉴权 / 配额类错误首次即返回，不走降级链的重试', async () => {
    const authError = Object.assign(new Error('401 Unauthorized: invalid api key'), {
      status: 401,
    });
    const h = harness(async () => {
      throw authError;
    });

    const result = await compactSession(h.deps, {
      repo: REPO,
      issueNumber: 7,
      sessionId: SESSION,
      windowTokens: WINDOW,
      messages: history(),
    });

    // 只发一次：重试 3 次、等 14 秒，最后还是同一个 401
    expect(h.prompts).toHaveLength(1);
    expect(h.sleeps).toHaveLength(0);
    expect(isFatalSummarizeError(authError)).toBe(true);

    expect(result.compacted).toBe(true);
    if (result.compacted) {
      // 直接落到兜底 checkpoint
      expect(result.fallback).toBe(true);
      expect(result.layers).toContain('summary:l1-fatal');
      expect(result.layers).toContain('skip-bounded');
    }
  });

  it('空摘要算失败（看起来成功、实际丢上下文，比直接失败更糟）', async () => {
    const h = harness(async (_prompt, index) => {
      if (index === 0) {
        return { text: '   ' };
      }
      return { text: VALID_SUMMARY };
    });

    const result = await compactSession(h.deps, {
      repo: REPO,
      issueNumber: 7,
      sessionId: SESSION,
      windowTokens: WINDOW,
      messages: history(),
    });

    expect(result.compacted).toBe(true);
    if (result.compacted) {
      expect(result.layers).toContain('summary:empty');
      expect(result.fallback).toBe(false);
    }
  });
});

describe('compactSession · 阶 3 有界削减', () => {
  it('重试全败后把工具结果降到 500 字符 + 丢 thinking，再试一次并成功', async () => {
    const h = harness(async (_prompt, index) => {
      if (index <= SUMMARY_MAX_RETRIES) {
        throw new Error('boom: upstream timeout');
      }
      return { text: VALID_SUMMARY };
    });

    const result = await compactSession(h.deps, {
      repo: REPO,
      issueNumber: 7,
      sessionId: SESSION,
      windowTokens: WINDOW,
      messages: history(),
    });

    expect(h.prompts).toHaveLength(SUMMARY_MAX_RETRIES + 2);
    // 第 5 次（bounded）的提示词里工具结果已经被截到 500 字符并带标记
    expect(h.prompts[SUMMARY_MAX_RETRIES + 1]).toContain('已截断');
    expect(result.compacted).toBe(true);
    if (result.compacted) {
      expect(result.fallback).toBe(false);
      expect(result.layers).toContain('truncate:2000');
      expect(result.layers).toContain('truncate:500');
      expect(result.layers).toContain('summary:l2');
    }
  });
});

describe('compactSession · 阶 4 分块链式摘要', () => {
  it('前两阶全败后按 token 分块，每块带上一块摘要', async () => {
    const h = harness(async (_prompt, index) => {
      if (index <= SUMMARY_MAX_RETRIES + 1) {
        throw new Error('boom: upstream timeout');
      }
      return { text: VALID_SUMMARY.replace('修掉登录接口 500', `修掉登录接口 500（第${String(index)}块）`) };
    });

    const result = await compactSession(h.deps, {
      repo: REPO,
      issueNumber: 7,
      sessionId: SESSION,
      windowTokens: WINDOW,
      messages: history(),
    });

    expect(result.compacted).toBe(true);
    if (!result.compacted) {
      return;
    }
    const chunks = chunkCount(result.layers);
    expect(chunks).toBeGreaterThan(1);
    expect(chunks).toBeLessThanOrEqual(16);
    expect(result.fallback).toBe(false);
    expect(h.prompts).toHaveLength(SUMMARY_MAX_RETRIES + 2 + chunks);

    // 第二块的提示词里带着第一块的摘要（链式，不是并行独立）
    const secondChunkPrompt = h.prompts[SUMMARY_MAX_RETRIES + 3];
    expect(secondChunkPrompt).toContain('【上一版摘要】');
    expect(secondChunkPrompt).toContain('第5块');
    // 最终收敛成一份：只保留最后一块的产物，不拼接
    expect(result.summary).toContain(`第${String(SUMMARY_MAX_RETRIES + 2 + chunks - 1)}块`);
  });
});

describe('compactSession · 阶 5 兜底 checkpoint', () => {
  it('全链路失败时返回 fallback=true，并写明这是兜底', async () => {
    const h = harness(async () => {
      throw new Error('boom: upstream timeout');
    });

    const result = await compactSession(h.deps, {
      repo: REPO,
      issueNumber: 7,
      sessionId: SESSION,
      windowTokens: WINDOW,
      messages: history(),
    });

    expect(result.compacted).toBe(true);
    if (result.compacted) {
      expect(result.fallback).toBe(true);
      expect(result.summary).toContain('兜底 checkpoint');
      expect(result.summary).toContain('未能生成模型摘要');
      expect(result.layers).toContain('fallback');
      // 兜底仍然落记录（后台要能看出这次是降级）
      expect(h.records).toHaveLength(1);
      expect(h.records[0]?.fallback).toBe(true);
    }
  });

  it('有上一版摘要时兜底直接沿用（不重写、不拼接）', async () => {
    const previousSummary = '## 目标\n修掉登录接口 500';
    const h = harness(async () => {
      throw new Error('boom: upstream timeout');
    });

    const result = await compactSession(h.deps, {
      repo: REPO,
      issueNumber: 7,
      sessionId: SESSION,
      windowTokens: WINDOW,
      messages: history(),
      previousSummary,
    });

    expect(result.compacted).toBe(true);
    if (result.compacted) {
      expect(result.fallback).toBe(true);
      expect(result.summary.startsWith(previousSummary)).toBe(true);
    }
  });
});

describe('compactSession · 阶 6 硬边界拒绝发送', () => {
  it('兜底视图仍超硬边界 → compacted=false + hard-limit + 报错，不落记录', async () => {
    const h = harness(async () => {
      throw new Error('boom: upstream timeout');
    });

    const result = await compactSession(h.deps, {
      repo: REPO,
      issueNumber: 7,
      sessionId: SESSION,
      windowTokens: WINDOW,
      messages: history(),
      // 上一版摘要本身就 25k token（10 万 ASCII 字符），塞不进 16k 的硬边界
      previousSummary: 'y'.repeat(100_000),
    });

    expect(result.compacted).toBe(false);
    if (!result.compacted) {
      expect(result.reason).toBe('hard-limit');
      expect(result.error).toBeDefined();
      expect(result.error).toContain('拒绝发送');
      expect(result.layers).toContain('hard-limit');
    }
    expect(h.records).toHaveLength(0);
  });

  it('最近窗口已覆盖全部消息时也拒绝（没有可摘要的旧历史）', async () => {
    const h = harness(async () => ({ text: VALID_SUMMARY }));
    // 单条超大消息：全落在最近窗口里，old 为空
    const messages: MessageLike[] = [{ role: 'user', content: 'z'.repeat(80_000) }];

    const result = await compactSession(h.deps, {
      repo: REPO,
      issueNumber: 7,
      sessionId: SESSION,
      windowTokens: WINDOW,
      messages,
    });

    expect(result.compacted).toBe(false);
    if (!result.compacted) {
      expect(result.reason).toBe('hard-limit');
      expect(result.error).toContain('没有可压缩的旧历史');
    }
    expect(h.prompts).toHaveLength(0);
  });
});

describe('compactSession · 记录与视图', () => {
  it('落记录字段完整：前后 token、摘要长度、fallback、generation', async () => {
    const h = harness(async () => ({ text: VALID_SUMMARY }), { latestGeneration: 2 });
    const messages = history();

    const result = await compactSession(h.deps, {
      repo: REPO,
      issueNumber: 7,
      sessionId: SESSION,
      windowTokens: WINDOW,
      messages,
    });

    expect(result.compacted).toBe(true);
    expect(h.records).toHaveLength(1);
    const record = h.records[0]!;
    expect(record.repo).toBe(REPO);
    expect(record.issueNumber).toBe(7);
    expect(record.sessionId).toBe(SESSION);
    // 上一代是 2 → 本次是第 3 代
    expect(record.generation).toBe(3);
    expect(record.generation).toBe(result.compacted ? result.generation : -1);
    expect(record.beforeTokens).toBeGreaterThan(16_000);
    expect(record.afterTokens).toBeLessThan(record.beforeTokens);
    expect(record.summaryChars).toBe(result.compacted ? result.summary.length : -1);
    expect(record.fallback).toBe(false);
  });

  it('视图 = checkpoint + 真实最近窗口，孤儿 toolResult 被剔除（原始消息一条不少）', async () => {
    const h = harness(async () => ({ text: VALID_SUMMARY }));
    const messages = history();
    // 插一条「调用方不在历史里」的孤儿结果（模拟历史缺失/截断造成的脏数据）
    messages.splice(messages.length - 2, 0, {
      role: 'tool',
      toolName: 'Read',
      toolCallId: 'call-missing',
      content: '孤儿结果',
    });

    const result = await compactSession(h.deps, {
      repo: REPO,
      issueNumber: 7,
      sessionId: SESSION,
      windowTokens: WINDOW,
      messages,
    });

    expect(result.compacted).toBe(true);
    if (!result.compacted) {
      return;
    }

    expect(result.view.summary).toBe(result.summary);
    expect(result.view.messages.some((message) => message.content === '孤儿结果')).toBe(false);

    // 窗口内的工具结果都是有主的
    const callIds = new Set<string>();
    for (const message of result.view.messages) {
      for (const call of message.toolCalls ?? []) {
        callIds.add(call.id);
      }
    }
    for (const message of result.view.messages) {
      if (message.role === 'tool') {
        expect(message.toolCallId).toBeDefined();
        expect(callIds.has(String(message.toolCallId))).toBe(true);
      }
    }

    // 真实最近窗口：最后一条消息必须还在（不能只留摘要）
    expect(result.view.messages.at(-1)?.content).toBe(messages.at(-1)?.content);
    expect(result.view.messages.length).toBeGreaterThan(1);

    // 原始对话一条不删（后台视图不受影响）
    expect(messages.some((message) => message.content === '孤儿结果')).toBe(true);
  });

  it('createCompactor 与 compactSession 等价（装配层用法）', async () => {
    const h = harness(async () => ({ text: VALID_SUMMARY }));
    const run = createCompactor(h.deps);
    const result = await run({
      repo: REPO,
      issueNumber: 7,
      sessionId: SESSION,
      windowTokens: WINDOW,
      messages: history(),
    });
    expect(result.compacted).toBe(true);
  });
});

describe('视图切分与分块的纯函数', () => {
  it('selectRecentWindow 至少留最后一条消息', () => {
    const messages = history(6);
    const window = selectRecentWindow(messages, 0);
    expect(window.recent.length).toBeGreaterThanOrEqual(1);
    // 最后一条（index 5 是 tool）必须还在；为了不产生孤儿，它前面的 assistant 也被带进来
    expect(window.recent.at(-1)?.content).toBe(messages.at(-1)?.content);
    expect(window.recent).toHaveLength(2);
    expect(window.old).toHaveLength(messages.length - 2);
  });

  it('selectRecentWindow 不会从 tool 消息开始（否则第一条就是孤儿）', () => {
    const messages: MessageLike[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1', toolCalls: [{ id: 'c1', name: 'Read' }] },
      { role: 'tool', toolCallId: 'c1', content: 't1' },
    ];
    // 预算刚好只装得下最后一条 tool 消息 → 切点必须前移到 assistant
    const window = selectRecentWindow(messages, 1);
    expect(window.recent[0]?.role).toBe('assistant');
    expect(window.recent).toHaveLength(2);
  });

  it('planChunks 不超过 16 块，且块序与消息序一致', () => {
    const messages = history(60);
    const chunks = planChunks(messages);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(16);
    const flattened = chunks.flat();
    expect(flattened).toHaveLength(messages.length);
    expect(flattened[0]?.content).toBe(messages[0]?.content);
    expect(flattened.at(-1)?.content).toBe(messages.at(-1)?.content);
  });

  it('buildFallbackSummary 无上一版时给六段骨架 + 明确 marker', () => {
    const summary = buildFallbackSummary({
      messages: history(6),
      nowMs: NOW,
    });
    expect(summary).toContain('兜底 checkpoint');
    for (const section of ['## 目标', '## 约束与偏好', '## 进度', '## 关键决策', '## 下一步', '## 关键上下文']) {
      expect(summary).toContain(section);
    }
  });
});
