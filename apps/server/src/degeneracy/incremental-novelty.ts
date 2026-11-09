/**
 * 判据 2：**低增量**（plan §9.3 第 2 条）。
 *
 * 判据原文：「最近 4k 输出 token 里新增 n-gram 占比 < 5%」。
 *
 * 为什么需要它（段落重复抓不住的那类退化）：agent 可能不整段重发，而是每轮都换词序、
 * 换同义词、把同一句话拆成三种说法——字符级窗口对不上，但信息量已经为零。
 * 这时 token 级 n-gram 的新增量会掉到 5% 以下。
 *
 * 实现（流式，一次只看滑动窗口）：
 *   - `tokenize()` 把增量切成 token（CJK 逐字、拉丁按词，见 `text.ts`）；
 *   - 维护长度 `windowTokens`（默认 4096）的窗口，以及「**窗口之前**出现过的 n-gram 集合」`seen`；
 *   - 每次 push 后算 `novelty = 窗口内不在 seen 里的**不同** n-gram 数 / 窗口内 n-gram 总数`；
 *     分母按**出现次数**计，所以「同一句重复十遍」会把占比迅速稀释到 0；
 *   - 窗口滑出的 n-gram 进入 `seen`（它们从此算「旧内容」）。
 *
 * 三个刻意的取舍：
 *   1. 窗口**没填满不判**（窗口 token 数 < `windowTokens` 时不算占比）：任务开头本来全是新内容，
 *      拿不完整的窗口算占比会把每个任务都判成退化。
 *   2. 分母是 n-gram 个数而不是 token 数：`n=3` 时两者差 2，对判断没影响，但 0/0 的边界更清楚。
 *   3. `seen` 只增不减（一个 run 一个有界窗口的生命周期内可接受；run 结束随实例丢弃）。
 *      代价是「隔了很久再重复」也会被判旧——那正是我们要的语义。
 */
import { tokenize } from './text.ts';
import type { DegeneracyClock, DegeneracyHit, TextDegeneracyDetector } from './types.ts';

/** 判据窗口：最近 4k 输出 token（plan §9.3 的字面量）。 */
export const NOVELTY_WINDOW_TOKENS = 4096;
/** n-gram 阶数：3（英文/中文都够敏感，2 太容易命中常见搭配）。 */
export const NOVELTY_NGRAM = 3;
/** 新增占比阈值：< 5% 即命中（plan §9.3 的字面量）。 */
export const NOVELTY_THRESHOLD = 0.05;

export interface IncrementalNoveltyOptions {
  readonly windowTokens?: number;
  readonly ngram?: number;
  readonly threshold?: number;
  readonly clock?: DegeneracyClock;
}

export interface IncrementalNoveltyDetector extends TextDegeneracyDetector {
  /** 最近一次算出的新增占比（窗口未填满时为 null）。测试与面板诊断用。 */
  readonly lastNoveltyRatio: number | null;
  /** 窗口内的 n-gram 总数（诊断用）。 */
  readonly ngramCount: number;
}

export function createIncrementalNoveltyDetector(
  options: IncrementalNoveltyOptions = {},
): IncrementalNoveltyDetector {
  const windowTokens = Math.max(4, options.windowTokens ?? NOVELTY_WINDOW_TOKENS);
  const ngram = Math.max(2, options.ngram ?? NOVELTY_NGRAM);
  const threshold = options.threshold ?? NOVELTY_THRESHOLD;
  const clock = options.clock ?? ((): number => Date.now());

  /** 当前窗口的 token。 */
  let window: string[] = [];
  /** 窗口之前出现过的 n-gram。 */
  const seen = new Set<string>();
  /** 窗口内每种 n-gram 的出现次数（滑出时同步减，避免每次重算 Map）。 */
  const windowGrams = new Map<string, number>();
  let totalTokensConsumed = 0;
  let lastRatio: number | null = null;
  let sticky: DegeneracyHit | null = null;

  const gramAt = (start: number): string | null => {
    if (start < 0 || start + ngram > window.length) {
      return null;
    }
    return window.slice(start, start + ngram).join('\u0001');
  };

  /** 把 `[from, to)` 这些起点上的 n-gram 记进窗口计数。 */
  const addGrams = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) {
      const gram = gramAt(index);
      if (gram === null) {
        return;
      }
      windowGrams.set(gram, (windowGrams.get(gram) ?? 0) + 1);
    }
  };

  /** 窗口头部吐出 `count` 个 token：相关 n-gram 移入 seen 并从窗口计数里扣掉。 */
  const dropTokens = (count: number): void => {
    if (count <= 0) {
      return;
    }
    for (let index = 0; index < count; index += 1) {
      const gram = gramAt(index);
      if (gram === null) {
        break;
      }
      const next = (windowGrams.get(gram) ?? 0) - 1;
      if (next <= 0) {
        windowGrams.delete(gram);
        // 滑出窗口即成为「旧内容」：同一段再来一遍时它不算新增。
        seen.add(gram);
      } else {
        windowGrams.set(gram, next);
      }
    }
    window = window.slice(count);
  };

  const computeRatio = (): number | null => {
    if (window.length < windowTokens) {
      return null;
    }
    let total = 0;
    let novel = 0;
    for (const [gram, count] of windowGrams) {
      total += count;
      if (!seen.has(gram)) {
        novel += 1;
      }
    }
    return total === 0 ? null : novel / total;
  };

  return {
    get consumed(): number {
      return totalTokensConsumed;
    },
    get lastNoveltyRatio(): number | null {
      return lastRatio;
    },
    get ngramCount(): number {
      let total = 0;
      for (const count of windowGrams.values()) {
        total += count;
      }
      return total;
    },
    reset(): void {
      window = [];
      seen.clear();
      windowGrams.clear();
      totalTokensConsumed = 0;
      lastRatio = null;
      sticky = null;
    },
    push(chunk: string): DegeneracyHit | null {
      if (sticky !== null) {
        return sticky;
      }
      if (typeof chunk !== 'string' || chunk.length === 0) {
        return null;
      }
      const tokens = tokenize(chunk);
      if (tokens.length === 0) {
        return null;
      }
      totalTokensConsumed += tokens.length;

      const before = window.length;
      window = window.concat(tokens);
      // 超出窗口的部分从头部吐出（一次 chunk 可能比整个窗口还长）。
      const dropped = Math.min(Math.max(0, before + tokens.length - windowTokens), window.length);
      dropTokens(dropped);
      // 新 token 只影响「尾部往回 ngram-1 个起点」开始的那些 n-gram。
      const start = Math.max(0, before - dropped - (ngram - 1));
      addGrams(start, window.length - ngram + 1);

      const ratio = computeRatio();
      lastRatio = ratio;
      if (ratio === null || ratio >= threshold) {
        return null;
      }
      const hit: DegeneracyHit = {
        criterion: 'low-novelty',
        detail: {
          windowTokens,
          ngram,
          threshold,
          noveltyRatio: Number(ratio.toFixed(4)),
          windowGramCount: windowGrams.size,
          tokensConsumed: totalTokensConsumed,
        },
        at: clock(),
      };
      sticky = hit;
      return hit;
    },
  };
}
