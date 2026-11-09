/**
 * 全局 429 熔断的单测（tech-plan §7.4 第 2 条）。
 *
 * 规则：连续 5 次 429 → 暂停 15min。用注入时钟测，不依赖真实时间。
 * 另外测读侧判定（`runtime_flags` 的 `until` 过了即解冻，不需要清理任务）——
 * worker 取任务前读的就是这个判定。
 */
import { describe, expect, it } from 'vitest';
import {
  RATE_LIMIT_PAUSE_SECONDS,
  RATE_LIMIT_TRIP_THRESHOLD,
  RUNTIME_FLAG_SQL,
  RateLimitBreaker,
  breakerFlagRow,
  isPauseFlagActive,
  pauseRedeliverSeconds,
} from '../src/queue/circuit-breaker.ts';

/** 可推进的假时钟。 */
function clock(start = '2026-06-01T12:00:00.000Z'): { now: () => Date; advance: (seconds: number) => void } {
  let current = new Date(start);
  return {
    now: () => new Date(current.getTime()),
    advance: (seconds) => {
      current = new Date(current.getTime() + seconds * 1000);
    },
  };
}

describe('RateLimitBreaker 计数与触发', () => {
  it('常量与 plan §9.2 一致：5 次 / 15 分钟', () => {
    expect(RATE_LIMIT_TRIP_THRESHOLD).toBe(5);
    expect(RATE_LIMIT_PAUSE_SECONDS).toBe(15 * 60);
  });

  it('前 4 次不暂停，第 5 次暂停 15 分钟', () => {
    const fake = clock();
    const breaker = new RateLimitBreaker({ now: fake.now });

    for (let index = 0; index < 4; index += 1) {
      const state = breaker.recordRateLimit();
      expect(state.consecutive).toBe(index + 1);
      expect(state.pausedUntil).toBeNull();
      expect(breaker.isPaused()).toBe(false);
    }

    const tripped = breaker.recordRateLimit();
    expect(tripped.consecutive).toBe(5);
    expect(tripped.pausedUntil?.toISOString()).toBe('2026-06-01T12:15:00.000Z');
    expect(breaker.isPaused()).toBe(true);
  });

  it('一次成功清空连续计数（4 次 429 + 成功 + 1 次 429 不触发）', () => {
    const fake = clock();
    const breaker = new RateLimitBreaker({ now: fake.now });
    for (let index = 0; index < 4; index += 1) {
      breaker.recordRateLimit();
    }
    expect(breaker.recordSuccess()).toEqual({ consecutive: 0, pausedUntil: null });

    const after = breaker.recordRateLimit();
    expect(after.consecutive).toBe(1);
    expect(after.pausedUntil).toBeNull();
  });

  it('暂停窗口到期即解冻，并把计数清零（下个 429 不会立刻再次触发）', () => {
    const fake = clock();
    const breaker = new RateLimitBreaker({ now: fake.now });
    for (let index = 0; index < 5; index += 1) {
      breaker.recordRateLimit();
    }
    expect(breaker.isPaused()).toBe(true);

    fake.advance(RATE_LIMIT_PAUSE_SECONDS - 1);
    expect(breaker.isPaused()).toBe(true);

    fake.advance(1);
    expect(breaker.isPaused()).toBe(false);
    expect(breaker.state()).toEqual({ consecutive: 0, pausedUntil: null });
  });

  it('阈值与窗口可注入（单测与将来调参都不必改常量）', () => {
    const fake = clock();
    const breaker = new RateLimitBreaker({ now: fake.now, threshold: 2, pauseSeconds: 60 });
    breaker.recordRateLimit();
    const tripped = breaker.recordRateLimit();
    expect(tripped.pausedUntil?.toISOString()).toBe('2026-06-01T12:01:00.000Z');
  });
});

describe('runtime_flags 两侧判定', () => {
  it('暂停时落 value=1 + until；未暂停时落 value=0 + 过去时间（不删行）', () => {
    const fake = clock();
    const breaker = new RateLimitBreaker({ now: fake.now });
    const idle = breakerFlagRow(breaker.state(), fake.now());
    expect(idle.key).toBe('rate_limit_pause');
    expect(idle.value).toBe('0');
    expect(idle.until?.getTime()).toBeLessThan(fake.now().getTime());

    for (let index = 0; index < 5; index += 1) {
      breaker.recordRateLimit();
    }
    const paused = breakerFlagRow(breaker.state(), fake.now());
    expect(paused.value).toBe('1');
    expect(paused.until?.toISOString()).toBe('2026-06-01T12:15:00.000Z');
  });

  it('读侧：行不存在 / value=0 / until 已过 都算未暂停', () => {
    const now = new Date('2026-06-01T12:00:00.000Z');
    expect(isPauseFlagActive(null, now)).toBe(false);
    expect(isPauseFlagActive({ key: 'rate_limit_pause', value: '0', until: null }, now)).toBe(false);
    expect(
      isPauseFlagActive({ key: 'rate_limit_pause', value: '1', until: new Date('2026-06-01T11:00:00Z') }, now),
    ).toBe(false);
  });

  it('读侧：until 为空视为人工置的常开开关', () => {
    const now = new Date('2026-06-01T12:00:00.000Z');
    expect(isPauseFlagActive({ key: 'rate_limit_pause', value: '1', until: null }, now)).toBe(true);
  });

  it('重投延迟 = 距窗口结束的秒数（未暂停则为 0）', () => {
    const now = new Date('2026-06-01T12:00:00.000Z');
    expect(
      pauseRedeliverSeconds({ key: 'rate_limit_pause', value: '1', until: new Date('2026-06-01T12:10:00Z') }, now),
    ).toBe(600);
    expect(pauseRedeliverSeconds({ key: 'rate_limit_pause', value: '0', until: null }, now)).toBe(0);
  });

  it('SQL 是幂等 UPSERT，读语句只取 value/until', () => {
    expect(RUNTIME_FLAG_SQL.upsert).toContain('ON CONFLICT ("key") DO UPDATE');
    expect(RUNTIME_FLAG_SQL.read).toContain('WHERE "key" = $1');
  });
});
