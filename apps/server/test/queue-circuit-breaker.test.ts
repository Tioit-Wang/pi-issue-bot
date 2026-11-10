/**
 * 两级 429 熔断的单测（tech-plan §7.4 第 2 条 + `docs/impl-multi-repo.md` §4 W1-B 第 4 条）。
 *
 * 规则：**滑动窗口**计数，不是「连续次数」——
 *  - 仓库级：10 分钟内 3 次 429 → 只暂停这个仓库（`runtime_flags.repo = 'owner/name'`）；
 *  - 全局：15 分钟内 5 次 429 → 暂停全部（`runtime_flags.repo IS NULL`）。
 *
 * 三件必须钉死的事：
 *  1. 两级**互不影响**：一个仓库被打爆不该停摆全局，反之全局暂停要压住所有仓库；
 *  2. 窗口边界精确（滑出窗口的计数不再参与）；
 *  3. `runtime_flags` 的 UPSERT 必须带 partial 索引的谓词（0003 之后不带会运行期报错）。
 */
import { describe, expect, it } from 'vitest';
import {
  CircuitBreaker,
  RATE_LIMIT_PAUSE_SECONDS,
  RATE_LIMIT_TRIP_THRESHOLD,
  REPO_RATE_LIMIT_TRIP_THRESHOLD,
  REPO_RATE_LIMIT_WINDOW_SECONDS,
  RUNTIME_FLAG_SQL,
  RateLimitWindowBreaker,
  breakerFlagRow,
  installationPauseKey,
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

describe('常量与 plan §9.2 一致', () => {
  it('全局 5 次 / 15 分钟，仓库级 3 次 / 10 分钟', () => {
    expect(RATE_LIMIT_TRIP_THRESHOLD).toBe(5);
    expect(RATE_LIMIT_PAUSE_SECONDS).toBe(15 * 60);
    expect(REPO_RATE_LIMIT_TRIP_THRESHOLD).toBe(3);
    expect(REPO_RATE_LIMIT_WINDOW_SECONDS).toBe(10 * 60);
  });
});

describe('RateLimitWindowBreaker：滑动窗口', () => {
  it('阈值内不暂停，达到阈值后暂停一个窗口', () => {
    const fake = clock();
    const breaker = new RateLimitWindowBreaker({ now: fake.now, threshold: 3, windowSeconds: 600 });

    expect(breaker.recordRateLimit()).toMatchObject({ count: 1, pausedUntil: null });
    expect(breaker.recordRateLimit()).toMatchObject({ count: 2, pausedUntil: null });
    expect(breaker.isPaused()).toBe(false);

    const tripped = breaker.recordRateLimit();
    expect(tripped.count).toBe(3);
    expect(tripped.pausedUntil?.toISOString()).toBe('2026-06-01T12:10:00.000Z');
    expect(breaker.isPaused()).toBe(true);
  });

  it('窗口到期即解冻，并把计数清零（下个 429 不会立刻再次触发）', () => {
    const fake = clock();
    const breaker = new RateLimitWindowBreaker({ now: fake.now, threshold: 3, windowSeconds: 600 });
    for (let index = 0; index < 3; index += 1) {
      breaker.recordRateLimit();
    }
    expect(breaker.isPaused()).toBe(true);

    fake.advance(599);
    expect(breaker.isPaused()).toBe(true);
    fake.advance(1);
    expect(breaker.isPaused()).toBe(false);
    expect(breaker.state()).toMatchObject({ count: 0, pausedUntil: null });
  });

  it('滑出窗口的命中不再计数（不是「连续」，是「窗口内」）', () => {
    const fake = clock();
    const breaker = new RateLimitWindowBreaker({ now: fake.now, threshold: 3, windowSeconds: 600 });
    breaker.recordRateLimit(); // t0
    fake.advance(500);
    breaker.recordRateLimit(); // t0+500
    // 走到 t0+601：cutoff = t0+1，第一条（t0）滑出窗口、第二条（t0+500）还在
    fake.advance(101);
    const state = breaker.recordRateLimit();
    expect(state.count).toBe(2);
    expect(state.pausedUntil).toBeNull();

    // 再走到 t0+1102：t0+500 那条也滑出，只剩最新一条
    fake.advance(501);
    expect(breaker.state().count).toBe(1);
  });

  it('一次成功清空窗口计数（暂停窗口不因此缩短）', () => {
    const fake = clock();
    const breaker = new RateLimitWindowBreaker({ now: fake.now, threshold: 3, windowSeconds: 600 });
    breaker.recordRateLimit();
    breaker.recordRateLimit();
    expect(breaker.recordSuccess().count).toBe(0);
    expect(breaker.recordRateLimit()).toMatchObject({ count: 1, pausedUntil: null });
  });
});

describe('CircuitBreaker：两级互不影响', () => {
  it('仓库级 3 次触发只停这个仓库，全局仍在正常计数', () => {
    const fake = clock();
    const breaker = new CircuitBreaker({ now: fake.now });

    breaker.recordRateLimit('acme/a');
    breaker.recordRateLimit('acme/a');
    const tripped = breaker.recordRateLimit('acme/a');

    expect(tripped.repo).toMatchObject({ count: 3, pausedUntil: expect.any(Date) as unknown });
    // 全局只记了 3 次（阈值 5），不暂停
    expect(tripped.global).toMatchObject({ count: 3, pausedUntil: null });

    expect(breaker.isPaused('acme/a')).toEqual({ paused: true, scope: 'repo' });
    // 另一个仓库完全不受影响 —— 这就是两级的全部意义
    expect(breaker.isPaused('acme/b')).toEqual({ paused: false, scope: null });
  });

  it('全局只有到 5 次才触发，且压住所有仓库', () => {
    const fake = clock();
    const breaker = new CircuitBreaker({ now: fake.now });

    // 每个仓库只各记 1 次：谁都不会被仓库级触发
    for (const repo of ['acme/a', 'acme/b', 'acme/c', 'acme/d']) {
      breaker.recordRateLimit(repo);
    }
    expect(breaker.isPaused('acme/a')).toEqual({ paused: false, scope: null });

    const tripped = breaker.recordRateLimit('acme/e');
    expect(tripped.global.pausedUntil?.toISOString()).toBe('2026-06-01T12:15:00.000Z');
    // 全局触发 → 每个仓库都被暂停，但报出来的 scope 是 global
    expect(breaker.isPaused('acme/a')).toEqual({ paused: true, scope: 'global' });
    expect(breaker.isPaused('acme/b')).toEqual({ paused: true, scope: 'global' });
  });

  it('仓库级暂停到期后恢复，全局不受影响（各自有各自的窗口）', () => {
    const fake = clock();
    const breaker = new CircuitBreaker({ now: fake.now });
    for (let index = 0; index < REPO_RATE_LIMIT_TRIP_THRESHOLD; index += 1) {
      breaker.recordRateLimit('acme/a');
    }
    expect(breaker.isPaused('acme/a').paused).toBe(true);

    fake.advance(REPO_RATE_LIMIT_WINDOW_SECONDS);
    expect(breaker.isPaused('acme/a')).toEqual({ paused: false, scope: null });
    expect(breaker.isPaused(null)).toEqual({ paused: false, scope: null });
  });

  it('repo=null 时不建仓库计数器（只记全局）', () => {
    const fake = clock();
    const breaker = new CircuitBreaker({ now: fake.now });
    const state = breaker.recordRateLimit(null);
    expect(state.repo).toBeNull();
    expect(breaker.repos()).toEqual([]);
  });

  it('recordSuccess 清掉该仓库与全局的窗口', () => {
    const fake = clock();
    const breaker = new CircuitBreaker({ now: fake.now });
    breaker.recordRateLimit('acme/a');
    breaker.recordRateLimit('acme/a');
    breaker.recordRateLimit('acme/b');
    breaker.recordSuccess('acme/a');
    expect(breaker.repo('acme/a').state().count).toBe(0);
    // 全局也清了（成功一次 = 这一轮不再是「持续限流」）
    expect(breaker.global().state().count).toBe(0);
  });
});

describe('runtime_flags 两侧判定', () => {
  it('暂停时落 value=1 + until；未暂停时落 value=0 + 过去时间（不删行）', () => {
    const fake = clock();
    const breaker = new CircuitBreaker({ now: fake.now });
    const idle = breakerFlagRow(breaker.global().state(), { now: fake.now() });
    expect(idle.key).toBe('rate_limit_pause');
    expect(idle.repo).toBeNull();
    expect(idle.value).toBe('0');
    expect(idle.until?.getTime()).toBeLessThan(fake.now().getTime());

    for (let index = 0; index < RATE_LIMIT_TRIP_THRESHOLD; index += 1) {
      breaker.recordRateLimit(null);
    }
    const paused = breakerFlagRow(breaker.global().state(), { now: fake.now() });
    expect(paused.value).toBe('1');
    expect(paused.until?.toISOString()).toBe('2026-06-01T12:15:00.000Z');
  });

  it('仓库级的 flag 行带 repo（NULL = 全局）', () => {
    const fake = clock();
    const breaker = new CircuitBreaker({ now: fake.now });
    for (let index = 0; index < REPO_RATE_LIMIT_TRIP_THRESHOLD; index += 1) {
      breaker.recordRateLimit('acme/a');
    }
    const row = breakerFlagRow(breaker.repo('acme/a').state(), { repo: 'acme/a', now: fake.now() });
    expect(row).toMatchObject({ key: 'rate_limit_pause', repo: 'acme/a', value: '1' });
  });

  it('安装级暂停的 key 与仓库无关（repo NULL）', () => {
    expect(installationPauseKey(42)).toBe('pause:installation:42');
    expect(installationPauseKey('42')).toBe('pause:installation:42');
  });

  it('读侧：行不存在 / value=0 / until 已过 都算未暂停', () => {
    const now = new Date('2026-06-01T12:00:00.000Z');
    expect(isPauseFlagActive(null, now)).toBe(false);
    expect(isPauseFlagActive({ value: '0', until: null }, now)).toBe(false);
    expect(isPauseFlagActive({ value: '1', until: new Date('2026-06-01T11:00:00Z') }, now)).toBe(false);
  });

  it('读侧：until 为空视为人工置的常开开关（installation.suspend 就是这种）', () => {
    const now = new Date('2026-06-01T12:00:00.000Z');
    expect(isPauseFlagActive({ value: '1', until: null }, now)).toBe(true);
  });

  it('重投延迟 = 距窗口结束的秒数（未暂停则为 0）', () => {
    const now = new Date('2026-06-01T12:00:00.000Z');
    expect(pauseRedeliverSeconds({ value: '1', until: new Date('2026-06-01T12:10:00Z') }, now)).toBe(600);
    expect(pauseRedeliverSeconds({ value: '0', until: null }, now)).toBe(0);
  });

  it('SQL 带 partial 索引的谓词（0003 之后不带会报 no unique/exclusion constraint）', () => {
    // 全局写：ON CONFLICT ("key") WHERE "repo" IS NULL
    expect(RUNTIME_FLAG_SQL.upsert).toContain('ON CONFLICT ("key") WHERE "repo" IS NULL DO UPDATE');
    expect(RUNTIME_FLAG_SQL.upsert).toContain('VALUES ($1, NULL, $2, $3, now())');
    // 仓库级写：ON CONFLICT ("key","repo") WHERE "repo" IS NOT NULL
    expect(RUNTIME_FLAG_SQL.upsertRepo).toContain('ON CONFLICT ("key", "repo") WHERE "repo" IS NOT NULL DO UPDATE');
    // 读：全局行必须带 repo IS NULL，否则会读到某个仓库的行
    expect(RUNTIME_FLAG_SQL.read).toContain('WHERE "key" = $1 AND "repo" IS NULL');
    expect(RUNTIME_FLAG_SQL.readRepo).toContain('WHERE "key" = $1 AND "repo" = $2');
    expect(RUNTIME_FLAG_SQL.readMany).toContain('"repo" IS NULL');
  });
});
