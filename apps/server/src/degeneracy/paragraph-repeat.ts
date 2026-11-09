/**
 * 判据 1：**段落重复**（plan §9.3 第 1 条）。
 *
 * 判据原文：「归一化（去空白、去标点）后，同一段 ≥ 200 字符的窗口在一次任务里出现 ≥ 3 次」。
 *
 * 流式实现（tech-plan §7.4 要求「在事件流上做流式检测」，不能等任务结束再整篇扫）：
 *   1. `push(chunk)` 把增量归一化后接到缓冲尾部；缓冲的起点永远是「下一个还没算过的窗口起点」；
 *   2. 对**每一个起点**取 200 字符窗口，用 `Map<窗口内容, 次数>` 计数，任一窗口到 3 即命中；
 *   3. 扫完把已扫过的前缀丢掉，内存只跟「未扫尾巴 + 计数表」有关。
 *
 * 为什么步长必须是 1（这里有个踩过的坑）：
 * 重复单元的长度是任意的。若按固定步长 S 扫（S=20 也一样），长度为 L 的单元重复 3 次时，
 * 三个窗口的起点是 `p, p+L, p+2L`，只有当某个偏移恰好落在 S 的格点上才会被数到 3 次；
 * `L=250, S=20` 时就只能数到 2 次 —— 真的在重复却判成正常，这是最坏的失败方向。
 * 逐字符扫的代价是「位置数 × 窗口长度」的字符拷贝；十万字符量级只需几十毫秒，
 * 换来的是「任意单元长度都不会漏」。
 *
 * 内存边界：`maxTrackedWindows` 给计数表一个上限，超限时按插入顺序丢掉**计数为 1** 的键
 * （计数 ≥ 2 的键留着，它们离命中最近）。这是有意的取舍：熔断只关心「还在重复」，
 * 不关心「历史上出现过多少种不同的窗口」。
 */
import { normalizeText } from './text.ts';
import type { DegeneracyClock, DegeneracyHit, TextDegeneracyDetector } from './types.ts';

/** 判据窗口：200 字符（plan §9.3 的字面量）。 */
export const PARAGRAPH_WINDOW_CHARS = 200;
/** 命中所需的窗口出现次数（plan §9.3：≥ 3 次）。 */
export const PARAGRAPH_REPEAT_THRESHOLD = 3;
/** 计数表上限（超出后丢弃计数为 1 的旧键）。 */
export const PARAGRAPH_MAX_TRACKED_WINDOWS = 20_000;

export interface ParagraphRepeatOptions {
  readonly windowChars?: number;
  readonly threshold?: number;
  readonly maxTrackedWindows?: number;
  readonly clock?: DegeneracyClock;
}

export interface ParagraphRepeatDetector extends TextDegeneracyDetector {
  /** 当前计数的最大值（诊断/测试用：能断言「差一次就命中」）。 */
  readonly maxCount: number;
  /** 计数最大的那个窗口的前 80 字符（诊断用，可能为空串）。 */
  readonly hottestPreview: string;
}

export function createParagraphRepeatDetector(
  options: ParagraphRepeatOptions = {},
): ParagraphRepeatDetector {
  const windowChars = Math.max(1, options.windowChars ?? PARAGRAPH_WINDOW_CHARS);
  const threshold = Math.max(2, options.threshold ?? PARAGRAPH_REPEAT_THRESHOLD);
  const maxTracked = Math.max(threshold, options.maxTrackedWindows ?? PARAGRAPH_MAX_TRACKED_WINDOWS);
  const clock = options.clock ?? ((): number => Date.now());

  /** 归一化文本：`buffer[0]` 的绝对字符偏移是 `baseIndex`。 */
  let buffer = '';
  let baseIndex = 0;
  /** 累计吃进来的原始字符数（归一化前，用于诊断）。 */
  let consumed = 0;
  const counts = new Map<string, number>();
  let sticky: DegeneracyHit | null = null;

  /** 超出上限时丢计数为 1 的旧键（Map 的迭代顺序即插入顺序）。 */
  const evictIfNeeded = (): void => {
    if (counts.size <= maxTracked) {
      return;
    }
    for (const [key, count] of counts) {
      if (counts.size <= maxTracked) {
        return;
      }
      if (count < threshold - 1) {
        counts.delete(key);
      }
    }
  };

  const scan = (): DegeneracyHit | null => {
    let offset = 0;
    while (offset + windowChars <= buffer.length) {
      const window = buffer.slice(offset, offset + windowChars);
      const next = (counts.get(window) ?? 0) + 1;
      counts.set(window, next);
      if (next >= threshold) {
        return {
          criterion: 'paragraph-repeat',
          detail: {
            windowChars,
            repeats: next,
            threshold,
            // 绝对起点 = 缓冲起点 + 相对偏移（两个量都不在循环里被改写，断言可手算）。
            windowStart: baseIndex + offset,
            charsConsumed: consumed,
            preview: `${window.slice(0, 80)}…`,
          },
          at: clock(),
        };
      }
      offset += 1;
    }
    // 把已扫过的前缀丢掉：下一轮从新的起点继续（窗口起点永远不回退）。
    if (offset > 0) {
      buffer = buffer.slice(offset);
      baseIndex += offset;
    }
    return null;
  };

  return {
    get consumed(): number {
      return consumed;
    },
    get maxCount(): number {
      let max = 0;
      for (const count of counts.values()) {
        if (count > max) {
          max = count;
        }
      }
      return max;
    },
    get hottestPreview(): string {
      let best = 0;
      let preview = '';
      for (const [key, count] of counts) {
        if (count > best) {
          best = count;
          preview = key.slice(0, 80);
        }
      }
      return preview;
    },
    reset(): void {
      buffer = '';
      baseIndex = 0;
      consumed = 0;
      counts.clear();
      sticky = null;
    },
    push(chunk: string): DegeneracyHit | null {
      if (sticky !== null) {
        return sticky;
      }
      if (typeof chunk !== 'string' || chunk.length === 0) {
        return null;
      }
      consumed += chunk.length;
      buffer += normalizeText(chunk);
      evictIfNeeded();
      const hit = scan();
      if (hit !== null) {
        sticky = hit;
        return hit;
      }
      return null;
    },
  };
}
