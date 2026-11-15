/**
 * 项目**日配额**的单测（需求 §6.7 SL-3）。
 *
 * 这一组钉的是四件可观察事实：
 *  1. 窗口是 **UTC 自然日**（跨日要归零，否则「每天」变成「每 24 小时」）；
 *  2. 占额度是**原子的一条语句**：`INSERT ... ON CONFLICT DO UPDATE ... WHERE count < limit`
 *     抢不到最后一格时既不改数也不返回行 —— 单测用内存假件重现这个语义；
 *  3. 判定只在**已经决定要处理**时才占额度（被开关关掉 / 闸门拒绝的事件不吃额度）；
 *  4. 占不到时判定改判 `daily-quota`（外层据此写 `webhook_deliveries.decision_reason`）；
 *     而配额表读不到时**放行**（配额是限额，不是可用性开关）。
 */
import { describe, expect, it } from 'vitest';
import {
  DAILY_QUOTA_DEFAULT,
  DAILY_QUOTA_KIND,
  MAX_DAILY_QUOTA,
  QUOTA_SQL,
  clampDailyQuota,
  dailyQuotaWindowStart,
  isDailyQuotaExhausted,
  readDailyQuotaUsed,
  reserveDailyQuota,
} from '../src/queue/quota.ts';
import { decideV21DeliveryWithQuota } from '../src/http/webhook-v21.ts';

const NOW = new Date('2026-06-01T12:00:00.000Z');

type QueryCall = { readonly text: string; readonly values: readonly unknown[] | undefined };

/** 内存版 `quota_counters`：只实现本模块用到的两条语句（按 `(repo, kind, window_start)` 一行）。 */
function createFakeDb(input: { readonly keep?: number } = {}): {
  db: { query: (text: string, values?: readonly unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> };
  calls: QueryCall[];
  countOf(repo: string): number;
} {
  const calls: QueryCall[] = [];
  const rows = new Map<string, number>();
  const keep = input.keep ?? 0;
  const keyOf = (repo: string, kind: string, windowStart: Date): string =>
    `${repo}|${kind}|${windowStart.toISOString()}`;

  return {
    calls,
    countOf(repo: string): number {
      return rows.get(keyOf(repo, DAILY_QUOTA_KIND, dailyQuotaWindowStart(NOW))) ?? 0;
    },
    db: {
      query: async (text: string, values?: readonly unknown[]) => {
        calls.push({ text, values });
        const [repo, kind, windowStart, limit] = values ?? [];
        const key = keyOf(String(repo), String(kind), windowStart as Date);
        if (text === QUOTA_SQL.read) {
          const count = rows.get(key);
          return {
            rows: count === undefined ? [] : [{ count }],
            rowCount: count === undefined ? 0 : 1,
          };
        }
        if (text === QUOTA_SQL.reserve) {
          const current = rows.get(key) ?? 0;
          if (current >= Number(limit)) {
            // `DO UPDATE ... WHERE count < limit` 不成立：不写、不返回行
            return { rows: [], rowCount: 0 };
          }
          const next = current + 1;
          rows.set(key, next);
          return { rows: [{ count: next }], rowCount: 1 };
        }
        return { rows: [{ count: keep }], rowCount: 1 };
      },
    },
  };
}

describe('配额窗口与边界（纯函数）', () => {
  it('窗口是 UTC 自然日：23:59 与次日 00:00 属于不同窗口', () => {
    expect(dailyQuotaWindowStart(new Date('2026-06-01T23:59:59.999Z')).toISOString()).toBe(
      '2026-06-01T00:00:00.000Z',
    );
    expect(dailyQuotaWindowStart(new Date('2026-06-02T00:00:00.000Z')).toISOString()).toBe(
      '2026-06-02T00:00:00.000Z',
    );
    // 东八区的 06-02 早上 07:00 仍是 UTC 的 06-01 —— 窗口按 UTC 算，不按本地时区
    expect(dailyQuotaWindowStart(new Date('2026-06-02T07:00:00+08:00')).toISOString()).toBe(
      '2026-06-01T00:00:00.000Z',
    );
  });

  it('用满即触顶（>=），20 条额度用掉 19 条还不算', () => {
    expect(isDailyQuotaExhausted(19, 20)).toBe(false);
    expect(isDailyQuotaExhausted(20, 20)).toBe(true);
    expect(isDailyQuotaExhausted(21, 20)).toBe(true);
  });

  it('上限被夹到契约区间（0 → 1、5000 → 1000、NaN → 默认 100）', () => {
    expect(clampDailyQuota(0)).toBe(1);
    expect(clampDailyQuota(5000)).toBe(MAX_DAILY_QUOTA);
    expect(clampDailyQuota(Number.NaN)).toBe(DAILY_QUOTA_DEFAULT);
    expect(clampDailyQuota(7.9)).toBe(7);
  });
});

describe('reserveDailyQuota：原子占格', () => {
  it('上限内逐条放行，返回的 used 是占完之后的值', async () => {
    const fake = createFakeDb();
    const first = await reserveDailyQuota(fake.db, { repo: 'acme/widget', limit: 2, now: NOW });
    const second = await reserveDailyQuota(fake.db, { repo: 'acme/widget', limit: 2, now: NOW });

    expect(first).toMatchObject({ granted: true, used: 1, limit: 2 });
    expect(second).toMatchObject({ granted: true, used: 2, limit: 2 });
    expect(fake.countOf('acme/widget')).toBe(2);
  });

  it('触顶后拒绝，且**不会**把计数继续加上去', async () => {
    const fake = createFakeDb();
    await reserveDailyQuota(fake.db, { repo: 'acme/widget', limit: 1, now: NOW });
    const rejected = await reserveDailyQuota(fake.db, { repo: 'acme/widget', limit: 1, now: NOW });

    expect(rejected.granted).toBe(false);
    // 拒绝路径会再读一次真实计数（面板要显示「已用 / 上限」），计数仍是 1
    expect(rejected.used).toBe(1);
    expect(fake.countOf('acme/widget')).toBe(1);
  });

  it('不同仓库各记各的账（平台不做业务限流，SL-5）', async () => {
    const fake = createFakeDb();
    await reserveDailyQuota(fake.db, { repo: 'acme/widget', limit: 1, now: NOW });
    const other = await reserveDailyQuota(fake.db, { repo: 'acme/gadget', limit: 1, now: NOW });

    expect(other.granted).toBe(true);
    expect(fake.countOf('acme/widget')).toBe(1);
    expect(fake.countOf('acme/gadget')).toBe(1);
  });

  it('读计数：没有行 = 0', async () => {
    const fake = createFakeDb();
    expect(await readDailyQuotaUsed(fake.db, { repo: 'acme/widget', now: NOW })).toBe(0);
  });
});

/* ── 判定接线：只有「要处理」的事件吃额度 ─────────────────────────────────── */

const OPENED_PAYLOAD = {
  action: 'opened',
  issue: { number: 42, state: 'open', user: { login: 'alice' } },
  sender: { login: 'alice', type: 'User' },
};

/** 打开了一条 issue 就能触发的项目配置（`issues.opened` 的默认开关是 `on`）。 */
function settingsWithQuota(dailyQuota: number): unknown {
  return {
    agent: { managers: ['alice'], limits: { daily_quota: dailyQuota } },
  };
}

describe('decideV21DeliveryWithQuota：日配额接线', () => {
  it('触发时占用额度并放行', async () => {
    const fake = createFakeDb();
    const decision = await decideV21DeliveryWithQuota(fake.db, {
      event: 'issues',
      action: 'opened',
      payload: OPENED_PAYLOAD,
      settings: settingsWithQuota(3),
      repo: 'acme/widget',
      now: () => NOW,
    });

    expect(decision).toMatchObject({ triggered: true, event: 'issues.opened' });
    expect(fake.countOf('acme/widget')).toBe(1);
  });

  it('额度用尽 → 改判 daily-quota（投递行据此留痕），且不再加计数', async () => {
    const fake = createFakeDb();
    await reserveDailyQuota(fake.db, { repo: 'acme/widget', limit: 1, now: NOW });

    const decision = await decideV21DeliveryWithQuota(fake.db, {
      event: 'issues',
      action: 'opened',
      payload: OPENED_PAYLOAD,
      settings: settingsWithQuota(1),
      repo: 'acme/widget',
      now: () => NOW,
    });

    expect(decision).toEqual({ triggered: false, event: 'issues.opened', reason: 'daily-quota' });
    expect(fake.countOf('acme/widget')).toBe(1);
  });

  it('未触发（开关关闭）的事件不吃额度：一次库调用都不该发生', async () => {
    const fake = createFakeDb();
    const decision = await decideV21DeliveryWithQuota(fake.db, {
      event: 'issues',
      action: 'opened',
      payload: OPENED_PAYLOAD,
      settings: { triggers: { events: { 'issues.opened': { enabled: 'off' } } } },
      repo: 'acme/widget',
      now: () => NOW,
    });

    expect(decision).toEqual({ triggered: false, event: 'issues.opened', reason: 'switch-off' });
    expect(fake.calls).toHaveLength(0);
  });

  it('不在 v2.1 五个事件里的投递返回 null，不碰配额', async () => {
    const fake = createFakeDb();
    const decision = await decideV21DeliveryWithQuota(fake.db, {
      event: 'ping',
      action: null,
      payload: {},
      settings: {},
      repo: 'acme/widget',
      now: () => NOW,
    });

    expect(decision).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it('配额表读不到时放行并记一条 warn（限额坏了不等于停服）', async () => {
    const warnings: string[] = [];
    const decision = await decideV21DeliveryWithQuota(
      {
        query: async () => {
          throw new Error('quota_counters 不存在');
        },
      },
      {
        event: 'issues',
        action: 'opened',
        payload: OPENED_PAYLOAD,
        settings: settingsWithQuota(3),
        repo: 'acme/widget',
        now: () => NOW,
        logger: {
          info: () => {},
          warn: (_detail: unknown, message: string) => {
            warnings.push(message);
          },
        } as never,
      },
    );

    expect(decision).toMatchObject({ triggered: true });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('日配额');
  });
});
