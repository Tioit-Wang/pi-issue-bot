/**
 * 判据 1（段落重复，plan §9.3 第 1 条）的单测。
 *
 * 正例要真的命中，反例要「像但不该触发」：
 *   - 反例 1：重复单元 150 字符 —— 归一化后凑不出 3 个相同的 **200 字符**窗口；
 *   - 反例 2：200 字符单元只重复 2 次 —— 次数不够；
 *   - 反例 3：三段各不相同的长文本 —— 没有任何窗口重合。
 *
 * 另有一条「刻意让它通过的」正例：250 字符单元重复 3 次。
 * 它是「按固定步长扫窗口」这类实现的漏网之鱼（步长 20 时只能数到 2 次），
 * 把这条写进单测，是为了把「逐字符扫」这个实现决定钉住。
 */
import { describe, expect, it } from 'vitest';

import {
  PARAGRAPH_REPEAT_THRESHOLD,
  PARAGRAPH_WINDOW_CHARS,
  createParagraphRepeatDetector,
  normalizeText,
} from '../src/degeneracy/index.ts';

/**
 * 确定性伪随机单元（mulberry32）。
 *
 * 为什么不用「字母表循环」或 `state*1103515245` 的 LCG：两者都会产生周期性文本，
 * 周期性文本天然含大量相同窗口，反例就会被判成正例，测试也就失去意义。
 * mulberry32 全程 32 位整数运算（`Math.imul`），不会因为超出 2^53 而在 JS 里丢精度。
 */
function makeUnit(length: number, seed: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let state = seed >>> 0;
  let out = '';
  while (out.length < length) {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    out += alphabet[Math.floor(value * alphabet.length)];
  }
  return out.slice(0, length);
}

describe('段落重复判据常量与归一化', () => {
  it('默认参数照抄 plan §9.3：200 字符窗口、≥3 次', () => {
    expect(PARAGRAPH_WINDOW_CHARS).toBe(200);
    expect(PARAGRAPH_REPEAT_THRESHOLD).toBe(3);
  });

  it('归一化只消除不可见差异：去空白与标点，保留字序与大小写', () => {
    expect(normalizeText('  Foo, bar!\n\t baz。 ')).toBe('Foobarbaz');
    // 全角空格、零宽空格也算空白
    expect(normalizeText('a\u3000b\u200bc')).toBe('abc');
  });
});

describe('段落重复判据：正例', () => {
  it('200 字符单元重复 3 次 → 命中，且 detail 可手工核对', () => {
    const unit = makeUnit(200, 7);
    const detector = createParagraphRepeatDetector({ clock: () => 1_700_000_000_000 });
    const hit = detector.push(`${unit}${unit}${unit}`);

    expect(hit).not.toBeNull();
    expect(hit?.criterion).toBe('paragraph-repeat');
    expect(hit?.detail['windowChars']).toBe(200);
    expect(hit?.detail['repeats']).toBe(3);
    expect(hit?.at).toBe(1_700_000_000_000);
  });

  it('流式喂入（40 字符一片，跨界）同样命中', () => {
    const unit = makeUnit(200, 11);
    const text = unit + unit + unit;
    const detector = createParagraphRepeatDetector();

    let hit = null;
    for (let index = 0; index < text.length; index += 40) {
      hit = detector.push(text.slice(index, index + 40)) ?? hit;
    }

    expect(hit?.criterion).toBe('paragraph-repeat');
  });

  it('标点与空白不同但归一化后相同 → 仍算重复（否则换个换行就逃掉了）', () => {
    const unit = makeUnit(200, 13);
    const noisy = unit.replace(/(.{10})/gu, '$1 \n，');
    const detector = createParagraphRepeatDetector();

    expect(detector.push(noisy)).toBeNull();
    expect(detector.push(unit)).toBeNull();
    expect(detector.push(unit)?.criterion).toBe('paragraph-repeat');
  });

  it('250 字符单元重复 3 次 → 命中（按固定步长扫的实现会漏，这条钉住逐字符扫）', () => {
    const unit = makeUnit(250, 17);
    const detector = createParagraphRepeatDetector();
    expect(detector.push(unit + unit + unit)?.criterion).toBe('paragraph-repeat');
  });

  it('命中后粘住：后续 push 返回同一个 hit（worker 只中断一次）', () => {
    const unit = makeUnit(200, 19);
    const detector = createParagraphRepeatDetector();
    const first = detector.push(unit + unit + unit);
    const second = detector.push('完全无关的新内容'.repeat(20));
    expect(second).toBe(first);
  });
});

describe('段落重复判据：反例', () => {
  it('150 字符单元重复 3 次 → 不命中（凑不出 3 个相同的 200 字符窗口）', () => {
    const unit = makeUnit(150, 23);
    const detector = createParagraphRepeatDetector();

    expect(detector.push(unit + unit + unit)).toBeNull();
    // 最多只有 2 个窗口重合：这就是「窗口 <200 字符」的反例
    expect(detector.maxCount).toBe(2);
  });

  it('200 字符单元只重复 2 次 → 不命中（次数不够）', () => {
    const unit = makeUnit(200, 29);
    const detector = createParagraphRepeatDetector();

    expect(detector.push(unit + unit)).toBeNull();
    expect(detector.maxCount).toBe(2);
  });

  it('三段各不相同的长文本 → 不命中', () => {
    const detector = createParagraphRepeatDetector();
    const text = makeUnit(600, 31);
    for (let index = 0; index < text.length; index += 100) {
      expect(detector.push(text.slice(index, index + 100))).toBeNull();
    }
    expect(detector.maxCount).toBe(1);
  });

  it('短文本（不足一个窗口）→ 不命中', () => {
    const detector = createParagraphRepeatDetector();
    expect(detector.push('短'.repeat(199))).toBeNull();
    expect(detector.maxCount).toBe(0);
  });
});
