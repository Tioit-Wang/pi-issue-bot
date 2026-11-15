/**
 * 项目级并发（需求 §6.7 SL-2）的测试：**字段唯一真相** + **触顶只排队、不丢弃**。
 *
 * 三件事：
 *  1. 生效的字段是 `agent.limits.concurrency`（v2.1，需求指的那个旋钮）；老的
 *     `limits.concurrency_per_repo` 只在存量配置没写新键时兜底 —— 两条都有值时新键赢。
 *     **老键仍然生效**（存量配置不许因为新键的出现被静默顶成默认值 2），所以这里有两组用例。
 *  2. 排队闸门的候选 SQL 必须把「本仓库 running 数已达并发上限」的行整批排除：
 *     否则等槽的任务超过 `queue_wait_minutes` 就会被改判 `cancelled_queue`，直接违反「不丢弃」。
 *  3. `RepoConcurrencyLimiter` 的等槽者只是等待，不会超时/失败；
 *  4. 「满载导致的永久挂起」只做观测：那条 SQL 必须**只读**，且与取消判据同一优先级。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONCURRENCY_PER_REPO,
  MAX_CONCURRENCY_PER_REPO,
  MIN_CONCURRENCY_PER_REPO,
  RepoConcurrencyLimiter,
  concurrencyPerRepoOf,
} from '../src/queue/repo-concurrency.ts';
import { QUEUE_GATE_SQL, QUEUE_GATE_STARVATION_SQL } from '../src/queue/queue-gate.ts';

describe('concurrencyPerRepoOf：agent.limits.concurrency 是唯一真相', () => {
  it('只配 v2.1 字段时按它来', () => {
    expect(concurrencyPerRepoOf({ agent: { limits: { concurrency: 4 } } })).toBe(4);
  });

  it('只配老字段时兜底（存量配置不会突然变成默认 2）', () => {
    expect(concurrencyPerRepoOf({ limits: { concurrency_per_repo: 3 } })).toBe(3);
  });

  it('两条路径都有值时新字段赢（老键已 deprecated）', () => {
    expect(
      concurrencyPerRepoOf({
        agent: { limits: { concurrency: 5 } },
        limits: { concurrency_per_repo: 1 },
      }),
    ).toBe(5);
  });

  it('都没配 / 值不是数字 → 默认 2', () => {
    expect(concurrencyPerRepoOf({})).toBe(DEFAULT_CONCURRENCY_PER_REPO);
    expect(concurrencyPerRepoOf(null)).toBe(DEFAULT_CONCURRENCY_PER_REPO);
    expect(concurrencyPerRepoOf({ agent: { limits: { concurrency: '4' } } })).toBe(
      DEFAULT_CONCURRENCY_PER_REPO,
    );
  });

  it('越界值夹到 1–8（既不能 0 也不能独占全部槽位）', () => {
    expect(concurrencyPerRepoOf({ agent: { limits: { concurrency: 0 } } })).toBe(MIN_CONCURRENCY_PER_REPO);
    expect(concurrencyPerRepoOf({ agent: { limits: { concurrency: -2 } } })).toBe(MIN_CONCURRENCY_PER_REPO);
    expect(concurrencyPerRepoOf({ agent: { limits: { concurrency: 40 } } })).toBe(MAX_CONCURRENCY_PER_REPO);
  });
});

describe('concurrencyPerRepoOf：老键仍然生效（存量配置不被默认值 2 顶掉）', () => {
  it('只配老键（新键缺失）→ 用老键的值', () => {
    expect(concurrencyPerRepoOf({ limits: { concurrency_per_repo: 1 } })).toBe(1);
    expect(concurrencyPerRepoOf({ limits: { concurrency_per_repo: 3 } })).toBe(3);
    // 空的 v2.1 段不该压掉老键
    expect(concurrencyPerRepoOf({ agent: {}, limits: { concurrency_per_repo: 1 } })).toBe(1);
  });

  it('老键值非法（字符串 / NaN / 结构不对）→ 回落默认 2，而不是 0 或 NaN', () => {
    expect(concurrencyPerRepoOf({ limits: { concurrency_per_repo: '1' } })).toBe(
      DEFAULT_CONCURRENCY_PER_REPO,
    );
    expect(concurrencyPerRepoOf({ limits: { concurrency_per_repo: Number.NaN } })).toBe(
      DEFAULT_CONCURRENCY_PER_REPO,
    );
    expect(concurrencyPerRepoOf({ limits: 'oops' })).toBe(DEFAULT_CONCURRENCY_PER_REPO);
  });

  it('老键越界夹到 1–8（存量配置也不能独占全部槽位）', () => {
    expect(concurrencyPerRepoOf({ limits: { concurrency_per_repo: 0 } })).toBe(MIN_CONCURRENCY_PER_REPO);
    expect(concurrencyPerRepoOf({ limits: { concurrency_per_repo: 99 } })).toBe(MAX_CONCURRENCY_PER_REPO);
  });
});

describe('排队闸门 SQL：等槽的任务不进候选', () => {
  it('保留了原阈值条件与分页参数（边界语义不变）', () => {
    expect(QUEUE_GATE_SQL).toContain('"status" = $1');
    expect(QUEUE_GATE_SQL).toContain('"queued_at" IS NOT NULL');
    expect(QUEUE_GATE_SQL).toContain('now() - "queued_at" > make_interval(secs => $2)');
    expect(QUEUE_GATE_SQL).toContain('ORDER BY "queued_at"');
    expect(QUEUE_GATE_SQL).toContain('LIMIT $3');
  });

  it('按「本仓库 running 数 >= 本仓库并发上限」排除等槽任务（不丢弃）', () => {
    expect(QUEUE_GATE_SQL).toContain('NOT EXISTS');
    expect(QUEUE_GATE_SQL).toContain(`"running"."status" = 'running'`);
    expect(QUEUE_GATE_SQL).toContain('count(*) >=');
  });

  it('SQL 里的上限读数与 concurrencyPerRepoOf() 同一优先级（新键 → 老键 → 2）', () => {
    const v21 = QUEUE_GATE_SQL.indexOf('{agent,limits,concurrency}');
    const legacy = QUEUE_GATE_SQL.indexOf('{limits,concurrency_per_repo}');
    const fallback = QUEUE_GATE_SQL.indexOf('ELSE 2');
    expect(v21).toBeGreaterThan(-1);
    expect(legacy).toBeGreaterThan(v21);
    expect(fallback).toBeGreaterThan(legacy);
    // 直接 ::int 会在手改库写成字符串时抛错 —— 必须有类型守卫
    expect(QUEUE_GATE_SQL).toContain(`jsonb_typeof`);
  });
});

describe('RepoConcurrencyLimiter：等槽只是等待', () => {
  it('槽位满时第三个等待者不返回失败，槽位释放后立刻拿到', async () => {
    const limiter = new RepoConcurrencyLimiter();
    const releaseFirst = await limiter.acquire('acme/widget', 1);

    let acquired = false;
    const pending = limiter.acquire('acme/widget', 1).then((release) => {
      acquired = true;
      return release;
    });

    // 冲刷微任务：等待者不该在这时就已经拿到槽位
    await Promise.resolve();
    expect(acquired).toBe(false);
    expect(limiter.activeCount('acme/widget')).toBe(1);
    expect(limiter.waitingRepos()).toContain('acme/widget');

    releaseFirst();
    const releaseSecond = await pending;
    expect(acquired).toBe(true);
    // 槽位是「转移」的：active 数没变，仍是 1
    expect(limiter.activeCount('acme/widget')).toBe(1);

    releaseSecond();
    expect(limiter.activeCount('acme/widget')).toBe(0);
  });
});

describe('满载观测 SQL：只读，且与取消判据同一口径', () => {
  it('不含任何写动作（观测不得改变行为）', () => {
    expect(QUEUE_GATE_STARVATION_SQL).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b/i);
  });

  it('与 QUEUE_GATE_SQL 用同一套上限读数顺序（新键 → 老键 → 2）与类型守卫', () => {
    const v21 = QUEUE_GATE_STARVATION_SQL.indexOf('{agent,limits,concurrency}');
    const legacy = QUEUE_GATE_STARVATION_SQL.indexOf('{limits,concurrency_per_repo}');
    const fallback = QUEUE_GATE_STARVATION_SQL.indexOf('ELSE 2');
    expect(v21).toBeGreaterThan(-1);
    expect(legacy).toBeGreaterThan(v21);
    expect(fallback).toBeGreaterThan(legacy);
    // 手改库写成字符串时不能抛错：观测量坏了不该让整条定时任务失败
    expect(QUEUE_GATE_STARVATION_SQL).toContain('jsonb_typeof');
  });

  it('只统计「已经等超粗筛阈值」的排队行（与取消判据同一个时钟条件）', () => {
    expect(QUEUE_GATE_STARVATION_SQL).toContain('make_interval(secs => $2)');
    expect(QUEUE_GATE_STARVATION_SQL).toContain(`"r"."status" = 'running'`);
    expect(QUEUE_GATE_STARVATION_SQL).toContain('>= "cap"."limit_value"');
  });
});
