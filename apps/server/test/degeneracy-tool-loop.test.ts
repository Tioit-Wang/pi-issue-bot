/**
 * 判据 3（工具循环，plan §9.3 第 3 条）的单测。
 *
 * 判据原文：「同一工具、同一参数连续调用 3 次，且没有产生新的文件或测试结果变化」。
 * 三个词各有一条反例钉住：
 *   - 「连续」：中间插一次别的工具就归零；
 *   - 「同一参数」：参数变了就归零（而且要键顺序无关，否则同参数换个来源就漏判）；
 *   - 「没有状态变化」：每次调用后测试结果都不同（stateDigest 变），说明它其实在推进，不算空转。
 */
import { describe, expect, it } from 'vitest';

import { TOOL_LOOP_THRESHOLD, createToolLoopDetector, stableStringify } from '../src/degeneracy/index.ts';

const SAME_PARAMS = { command: 'pnpm test', cwd: '/jobs/1/work' };

describe('工具循环判据常量与稳定序列化', () => {
  it('默认阈值照抄 plan §9.3：连续 3 次', () => {
    expect(TOOL_LOOP_THRESHOLD).toBe(3);
  });

  it('稳定序列化：键顺序无关（否则同参数换个来源就漏判）', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(stableStringify({ a: 1, b: 2 })).not.toBe(stableStringify({ a: 1, b: 3 }));
  });
});

describe('工具循环判据：正例', () => {
  it('同工具同参数连续 3 次且状态不变 → 第 3 次命中', () => {
    const detector = createToolLoopDetector({ clock: () => 42 });

    expect(detector.push({ tool: 'Bash', params: SAME_PARAMS, stateDigest: 'same' })).toBeNull();
    expect(detector.push({ tool: 'Bash', params: SAME_PARAMS, stateDigest: 'same' })).toBeNull();

    const hit = detector.push({ tool: 'Bash', params: { cwd: '/jobs/1/work', command: 'pnpm test' }, stateDigest: 'same' });
    expect(hit?.criterion).toBe('tool-loop');
    expect(hit?.detail['tool']).toBe('Bash');
    expect(hit?.detail['consecutiveCalls']).toBe(3);
    expect(hit?.at).toBe(42);
  });

  it('不带 stateDigest（没观测到变化）也按「状态不变」处理', () => {
    const detector = createToolLoopDetector();
    detector.push({ tool: 'Grep', params: { pattern: 'TODO' } });
    detector.push({ tool: 'Grep', params: { pattern: 'TODO' } });
    expect(detector.push({ tool: 'Grep', params: { pattern: 'TODO' } })?.criterion).toBe('tool-loop');
  });

  it('命中后粘住：后续调用返回同一个 hit', () => {
    const detector = createToolLoopDetector();
    const hit = detector.push({ tool: 'Read', params: { path: 'a.ts' } });
    expect(hit).toBeNull();
    detector.push({ tool: 'Read', params: { path: 'a.ts' } });
    const first = detector.push({ tool: 'Read', params: { path: 'a.ts' } });
    expect(detector.push({ tool: 'Write', params: { path: 'b.ts' } })).toBe(first);
  });
});

describe('工具循环判据：反例', () => {
  it('只连续 2 次 → 不命中', () => {
    const detector = createToolLoopDetector();
    detector.push({ tool: 'Bash', params: SAME_PARAMS, stateDigest: 'same' });
    expect(detector.push({ tool: 'Bash', params: SAME_PARAMS, stateDigest: 'same' })).toBeNull();
    expect(detector.streak).toBe(2);
  });

  it('同工具同参数但每次状态都变（真的在推进）→ 不命中', () => {
    const detector = createToolLoopDetector();
    expect(detector.push({ tool: 'Bash', params: SAME_PARAMS, stateDigest: 'a' })).toBeNull();
    expect(detector.push({ tool: 'Bash', params: SAME_PARAMS, stateDigest: 'b' })).toBeNull();
    expect(detector.push({ tool: 'Bash', params: SAME_PARAMS, stateDigest: 'c' })).toBeNull();
    expect(detector.streak).toBe(1);
  });

  it('中间插一次别的工具 → 连续段归零', () => {
    const detector = createToolLoopDetector();
    detector.push({ tool: 'Bash', params: SAME_PARAMS, stateDigest: 'same' });
    detector.push({ tool: 'Bash', params: SAME_PARAMS, stateDigest: 'same' });
    detector.push({ tool: 'Read', params: { path: 'a.ts' }, stateDigest: 'same' });
    expect(detector.push({ tool: 'Bash', params: SAME_PARAMS, stateDigest: 'same' })).toBeNull();
    expect(detector.streak).toBe(1);
  });

  it('同工具但参数不同 → 不命中', () => {
    const detector = createToolLoopDetector();
    expect(detector.push({ tool: 'Bash', params: { command: 'pnpm test' }, stateDigest: 'same' })).toBeNull();
    expect(detector.push({ tool: 'Bash', params: { command: 'pnpm build' }, stateDigest: 'same' })).toBeNull();
    expect(detector.push({ tool: 'Bash', params: { command: 'pnpm lint' }, stateDigest: 'same' })).toBeNull();
  });
});
