/**
 * `lib/format.ts` 的六类断言（tech-plan §9.4：面板所有数字都从这里出）。
 *
 * 六类：时长 / 金额 / token / 时间（相对 + 绝对）/ 百分比 / `null` 显示 `—`。
 * 这些是**契约层面的可读性约定**，改了就等于改了面板所有页面的观感，所以逐条钉死。
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY,
  formatAbsoluteTime,
  formatCount,
  formatDuration,
  formatPercent,
  formatRelativeTime,
  formatTimeCell,
  formatTokens,
  formatUsd,
} from './format.ts';

const NOW = new Date('2026-06-01T12:00:00.000Z');

describe('formatDuration：毫秒 → 人话', () => {
  it('毫秒 / 秒 / 分秒 / 小时', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(32)).toBe('32ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(12_000)).toBe('12s');
    expect(formatDuration(80_000)).toBe('1m 20s');
    expect(formatDuration(600_000)).toBe('10m');
    expect(formatDuration(1_140_000)).toBe('19m');
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(3_900_000)).toBe('1h 5m');
  });

  it('null / undefined → —（不是 0ms）', () => {
    expect(formatDuration(null)).toBe(EMPTY);
    expect(formatDuration(undefined)).toBe(EMPTY);
  });
});

describe('formatUsd：契约要求 4 位小数', () => {
  it('金额格式', () => {
    expect(formatUsd(0.0412)).toBe('$0.0412');
    expect(formatUsd(0)).toBe('$0.0000');
    expect(formatUsd(7.77)).toBe('$7.7700');
    expect(formatUsd(0.1)).toBe('$0.1000');
  });

  it('null → —（「没有值」与「免费」的区别）', () => {
    expect(formatUsd(null)).toBe(EMPTY);
  });
});

describe('formatTokens：只在展示层缩写', () => {
  it('k / M', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1000)).toBe('1k');
    expect(formatTokens(12_400)).toBe('12.4k');
    expect(formatTokens(1_500_000)).toBe('1.5M');
  });

  it('null → —', () => {
    expect(formatTokens(null)).toBe(EMPTY);
  });
});

describe('formatRelativeTime / formatAbsoluteTime：相对量 + 绝对 title', () => {
  it('相对时间按秒/分/时/天递进', () => {
    expect(formatRelativeTime('2026-06-01T11:59:55.000Z', NOW)).toBe('刚刚');
    expect(formatRelativeTime('2026-06-01T11:59:30.000Z', NOW)).toBe('30 秒前');
    expect(formatRelativeTime('2026-06-01T11:57:00.000Z', NOW)).toBe('3 分钟前');
    expect(formatRelativeTime('2026-06-01T10:00:00.000Z', NOW)).toBe('2 小时前');
    expect(formatRelativeTime('2026-05-29T12:00:00.000Z', NOW)).toBe('3 天前');
    // 超过一个月退化成日期
    expect(formatRelativeTime('2026-01-01T00:00:00.000Z', NOW)).toBe('2026-01-01');
  });

  it('未来时间用「后」', () => {
    expect(formatRelativeTime('2026-06-01T12:15:00.000Z', NOW)).toBe('15 分钟后');
  });

  it('绝对时间带 UTC 后缀（契约：面板不做时区换算）', () => {
    expect(formatAbsoluteTime('2026-06-01T12:00:00.000Z')).toBe('2026-06-01 12:00:00 UTC');
    expect(formatAbsoluteTime(null)).toBe(EMPTY);
  });

  it('formatTimeCell 同时给出相对量与绝对量', () => {
    expect(formatTimeCell('2026-06-01T11:57:00.000Z', NOW)).toEqual({
      text: '3 分钟前',
      title: '2026-06-01 11:57:00 UTC',
    });
  });
});

describe('formatPercent：入参是 0–1，不乘 100', () => {
  it('比例 → 百分比（一位小数，去尾 .0）', () => {
    expect(formatPercent(0.333333)).toBe('33.3%');
    expect(formatPercent(0.5)).toBe('50%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0)).toBe('0%');
  });

  it('null → —（分母为 0 时不能用 0 冒充）', () => {
    expect(formatPercent(null)).toBe(EMPTY);
  });
});

describe('formatCount：整数带千分位', () => {
  it('千分位与 null', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(1234)).toBe('1,234');
    expect(formatCount(1_234_567)).toBe('1,234,567');
    expect(formatCount(null)).toBe(EMPTY);
  });
});
