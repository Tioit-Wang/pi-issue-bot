/**
 * 判据 2（低增量 / 新增 n-gram 占比，plan §9.3 第 2 条）的单测。
 *
 * 判据原文：「最近 4k 输出 token 里新增 n-gram 占比 < 5%」。默认窗口 4096 token 太大，
 * 单测里把窗口缩到 100 token（算法与阈值不变：`threshold` 仍是 0.05、`ngram` 仍是 3）。
 *
 * 三条反例都是「像但不该触发」：
 *   - 全新内容 → 占比 100%，不命中；
 *   - **增量刚好 6%** → 高于 5% 阈值，不命中（这条是为了钉住阈值的边界方向：
 *     若实现把「<5%」写成「≤6%」或把分母算错，这条会红）；
 *   - 窗口还没填满 → 一律不判（任务开头本来全是新内容）。
 */
import { describe, expect, it } from 'vitest';

import {
  NOVELTY_NGRAM,
  NOVELTY_THRESHOLD,
  NOVELTY_WINDOW_TOKENS,
  createIncrementalNoveltyDetector,
  tokenize,
} from '../src/degeneracy/index.ts';

const WINDOW = 100;

/** 一批互不相同的 token：`a0 a1 a2 …`。 */
function distinctTokens(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(' ');
}

describe('低增量判据常量与分词', () => {
  it('默认参数照抄 plan §9.3：4096 token 窗口、5% 阈值、3-gram', () => {
    expect(NOVELTY_WINDOW_TOKENS).toBe(4096);
    expect(NOVELTY_THRESHOLD).toBe(0.05);
    expect(NOVELTY_NGRAM).toBe(3);
  });

  it('分词：拉丁按词、CJK 按字（否则中文 3-gram 永远只有 1 个，必然误报）', () => {
    expect(tokenize('pnpm test --filter foo')).toEqual(['pnpm', 'test', 'filter', 'foo']);
    expect(tokenize('重复输出')).toEqual(['重', '复', '输', '出']);
  });
});

describe('低增量判据：正例', () => {
  it('窗口里全是同一个 token（同一句重复）→ 命中', () => {
    const detector = createIncrementalNoveltyDetector({ windowTokens: WINDOW });
    const hit = detector.push('w '.repeat(WINDOW));

    expect(hit).not.toBeNull();
    expect(hit?.criterion).toBe('low-novelty');
    expect(Number(hit?.detail['noveltyRatio'])).toBeLessThan(NOVELTY_THRESHOLD);
    expect(hit?.detail['ngram']).toBe(NOVELTY_NGRAM);
  });

  it('同一段先出现一次、再整段重放 → 第二次命中（新增占比掉到 0）', () => {
    const detector = createIncrementalNoveltyDetector({ windowTokens: WINDOW });
    const block = distinctTokens('t', WINDOW);

    expect(detector.push(block)).toBeNull();
    // 换一批完全不同的内容把它挤出窗口，让 block 的 n-gram 进入「历史」
    expect(detector.push(distinctTokens('f', WINDOW))).toBeNull();
    const hit = detector.push(block);

    expect(hit?.criterion).toBe('low-novelty');
    expect(Number(hit?.detail['noveltyRatio'])).toBe(0);
  });
});

describe('低增量判据：反例', () => {
  it('全新内容 → 占比 100%，不命中', () => {
    const detector = createIncrementalNoveltyDetector({ windowTokens: WINDOW });
    expect(detector.push(distinctTokens('n', WINDOW))).toBeNull();
    expect(detector.lastNoveltyRatio).toBe(1);
  });

  it('新增占比刚好 6% → 不命中（阈值是 <5%，边界方向不能反）', () => {
    const detector = createIncrementalNoveltyDetector({ windowTokens: WINDOW });

    // 1) 让窗口填满 A 段，A 的 n-gram 先算「新」
    expect(detector.push(distinctTokens('a', WINDOW))).toBeNull();
    // 2) 换一批 B 把 A 挤出窗口：A 的 n-gram 从此进入「历史」
    expect(detector.push(distinctTokens('b', WINDOW))).toBeNull();
    // 3) 再放 A，但替换其中 2 个 token：只新增 6 个不同的 3-gram / 98 个总数 ≈ 6.1%
    const mutated = Array.from({ length: WINDOW }, (_, index) =>
      index === 10 ? 'z0' : index === 60 ? 'z1' : `a${index}`,
    ).join(' ');

    const hit = detector.push(mutated);
    const ratio = detector.lastNoveltyRatio;

    expect(hit).toBeNull();
    expect(ratio).not.toBeNull();
    expect(ratio ?? 0).toBeGreaterThan(NOVELTY_THRESHOLD);
    expect(ratio ?? 1).toBeLessThan(0.07);
  });

  it('窗口还没填满 → 一律不判（否则每个任务开头都被判成退化）', () => {
    const detector = createIncrementalNoveltyDetector({ windowTokens: WINDOW });
    // 99 个相同 token：若按不完整窗口算，占比会低到直接命中
    expect(detector.push('w '.repeat(WINDOW - 1))).toBeNull();
    expect(detector.lastNoveltyRatio).toBeNull();
  });
});
