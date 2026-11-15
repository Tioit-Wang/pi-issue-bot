/**
 * 单轮超时（需求 §6.7 SL-4）的单一事实源测试。
 *
 * 这一组钉四件事：
 *  1. **项目显式配置优先**：`agent.limits.turn_timeout_minutes` 配了就以它为准（连 `/review-pr` 也一起）；
 *  2. **没配才用命令默认值**：`/review-pr` 30min、其余 20min —— 这是「没配置」的默认表，唯一一份；
 *  3. `turnTimeoutMs` 与分钟表**同源**；pg-boss 的 `expireInSeconds` 取区间**上界**
 *     （不按命令分档、也不读项目配置 —— 入队点拿不到仓库 settings，见 `EXPIRE_IN_SECONDS_MAX`）；
 *  4. 契约默认值与这里的默认值相等，且与 `worker/run-task.ts::timeoutMsForCommand()` 的旧口径一致
 *     （等值性靠断言而不是靠「大家都记得改」）。
 */
import { describe, expect, it } from 'vitest';
import { agentExecutionSchema } from '../../../packages/contract/src/index.ts';
import {
  DEFAULT_TURN_TIMEOUT_MINUTES,
  EXPIRE_IN_SECONDS_MAX,
  enqueueExpireInSeconds,
  MAX_TURN_TIMEOUT_MINUTES,
  MIN_TURN_TIMEOUT_MINUTES,
  QUEUE,
  REVIEW_PR_TURN_TIMEOUT_MINUTES,
  queueSpecOf,
  turnTimeoutMinutesFor,
  turnTimeoutMsFor,
} from '../src/queue/definitions.ts';
import { queueJobOptions } from '../src/queue/boss.ts';
import { resolveTurnTimeoutMinutes } from '../src/config/v21-settings.ts';
import { decideOutcome, timeoutMsForCommand } from '../src/worker/run-task.ts';

describe('turnTimeoutMinutesFor：项目配置优先', () => {
  it('没配置（undefined）= 按命令给默认值', () => {
    expect(turnTimeoutMinutesFor('auto:triage')).toBe(DEFAULT_TURN_TIMEOUT_MINUTES);
    expect(turnTimeoutMinutesFor('/review-pr')).toBe(REVIEW_PR_TURN_TIMEOUT_MINUTES);
    // 带参数与大小写都按同一条命令算（与 worker 侧同口径）
    expect(turnTimeoutMinutesFor('/Review-PR 123')).toBe(REVIEW_PR_TURN_TIMEOUT_MINUTES);
  });

  it('项目显式配置了就以项目为准 —— 连 /review-pr 的 30min 也能被压下去', () => {
    expect(turnTimeoutMinutesFor('auto:triage', 5)).toBe(5);
    expect(turnTimeoutMinutesFor('/review-pr', 5)).toBe(5);
    expect(turnTimeoutMinutesFor('/review-pr', 25)).toBe(25);
  });

  it('越界值被夹到 1–30（配置写坏不能让单轮闸门变成 0 或无穷）', () => {
    expect(turnTimeoutMinutesFor('auto:triage', 0)).toBe(MIN_TURN_TIMEOUT_MINUTES);
    expect(turnTimeoutMinutesFor('auto:triage', -3)).toBe(MIN_TURN_TIMEOUT_MINUTES);
    expect(turnTimeoutMinutesFor('auto:triage', 999)).toBe(MAX_TURN_TIMEOUT_MINUTES);
    expect(turnTimeoutMinutesFor('auto:triage', 7.8)).toBe(7);
  });

  it('毫秒都由分钟表推算，不会各写一份 20/30', () => {
    expect(turnTimeoutMsFor('auto:triage')).toBe(DEFAULT_TURN_TIMEOUT_MINUTES * 60_000);
    expect(turnTimeoutMsFor('/review-pr')).toBe(REVIEW_PR_TURN_TIMEOUT_MINUTES * 60_000);
    expect(turnTimeoutMsFor('auto:triage', 12)).toBe(12 * 60_000);
  });

  it('pg-boss 的 expireIn 取区间上界：任何合法项目值都不会被平台提前杀掉', () => {
    // SL-4 收口的核心理由：入队点手里没有仓库 settings，猜一个「按命令 20/30」的值必然有两个方向的风险，
    // 危险的那个方向是「项目配了 30 分钟、平台第 20 分钟判 job 过期」。取上界等于平台永不抢跑。
    expect(EXPIRE_IN_SECONDS_MAX).toBe(MAX_TURN_TIMEOUT_MINUTES * 60);
    for (const minutes of [MIN_TURN_TIMEOUT_MINUTES, 5, DEFAULT_TURN_TIMEOUT_MINUTES, MAX_TURN_TIMEOUT_MINUTES]) {
      expect(EXPIRE_IN_SECONDS_MAX * 1000).toBeGreaterThanOrEqual(turnTimeoutMsFor('auto:triage', minutes));
      expect(EXPIRE_IN_SECONDS_MAX * 1000).toBeGreaterThanOrEqual(turnTimeoutMsFor('/review-pr', minutes));
    }
    // 边界等值：项目取最大 30 分钟时两者相等（再长就不合法了）
    expect(EXPIRE_IN_SECONDS_MAX * 1000).toBe(turnTimeoutMsFor('auto:triage', MAX_TURN_TIMEOUT_MINUTES));
  });

  it('契约默认值与默认表相等（两处不同步就是「面板显示 20、实际跑 30」）', () => {
    expect(agentExecutionSchema.parse({}).turn_timeout_minutes).toBe(DEFAULT_TURN_TIMEOUT_MINUTES);
    expect(agentExecutionSchema.parse({ turn_timeout_minutes: MAX_TURN_TIMEOUT_MINUTES }).turn_timeout_minutes).toBe(
      MAX_TURN_TIMEOUT_MINUTES,
    );
  });

  it('没配置时与 worker 侧旧口径逐值一致（改默认值要两边一起动）', () => {
    for (const command of ['auto:triage', '/review-pr', '/review-pr 12', 'auto:notice']) {
      expect(turnTimeoutMsFor(command)).toBe(timeoutMsForCommand(command));
    }
  });
});

describe('resolveTurnTimeoutMinutes：只回答「项目配没配」', () => {
  it('缺失 = undefined（交给默认表），配了就给出原值', () => {
    expect(resolveTurnTimeoutMinutes({})).toBeUndefined();
    expect(resolveTurnTimeoutMinutes(null)).toBeUndefined();
    expect(resolveTurnTimeoutMinutes({ agent: { limits: { concurrency: 3 } } })).toBeUndefined();
    expect(resolveTurnTimeoutMinutes({ agent: { limits: { turn_timeout_minutes: 7 } } })).toBe(7);
    expect(resolveTurnTimeoutMinutes({ agent: { limits: { turn_timeout_minutes: 30 } } })).toBe(30);
  });

  it('越界 / 非数字 / 整份配置不合法一律按「没配」处理', () => {
    expect(resolveTurnTimeoutMinutes({ agent: { limits: { turn_timeout_minutes: 45 } } })).toBeUndefined();
    expect(resolveTurnTimeoutMinutes({ agent: { limits: { turn_timeout_minutes: 0 } } })).toBeUndefined();
    expect(resolveTurnTimeoutMinutes({ agent: { limits: { turn_timeout_minutes: '7' } } })).toBeUndefined();
    expect(resolveTurnTimeoutMinutes({ unknown_section: true })).toBeUndefined();
  });
});

describe('SL-4 收口：项目配 5 分钟时的完整口径', () => {
  /**
   * 装配层（`app/compose.ts::deps.timeoutForCommand`）就是这么算的：
   * `turnTimeoutMsFor(command, resolveTurnTimeoutMinutes(policy.settings))`。
   * 这里按同一表达式取，断言「5 分钟的项目值」一路走到就是 5 分钟的**任务级**闸门。
   */
  const SETTINGS_5_MIN = { agent: { limits: { turn_timeout_minutes: 5 } } };

  it('任务级闸门就是 5 分钟（项目值压过命令默认的 20/30）', () => {
    expect(turnTimeoutMsFor('auto:triage', resolveTurnTimeoutMinutes(SETTINGS_5_MIN))).toBe(5 * 60_000);
    expect(turnTimeoutMsFor('/review-pr', resolveTurnTimeoutMinutes(SETTINGS_5_MIN))).toBe(5 * 60_000);
  });

  it('pg-boss 的 expireIn 比 5 分钟宽，抢跑不了（真正终止的是任务级 deadline）', () => {
    const taskDeadlineMs = turnTimeoutMsFor('auto:triage', resolveTurnTimeoutMinutes(SETTINGS_5_MIN));
    expect(enqueueExpireInSeconds() * 1000).toBeGreaterThan(taskDeadlineMs);
    expect(queueJobOptions('task-5m').expireInSeconds).toBe(enqueueExpireInSeconds());
  });

  it('超时记为 timed-out，且 run-task 不自动重试（retryLimit 恒为 0）', () => {
    // 任务级 deadline 到点后走的是这条判定：唯一信号是 timeout → `timed-out`（不是 failed、不是重跑）
    expect(decideOutcome([{ failureClass: 'timeout' }], null, false)).toBe('timed-out');
    // 自动重试会让「超时」被 pg-boss 顺手重跑一次，直接违反「不自动重试」
    expect(queueSpecOf(QUEUE.runTask).retryLimit).toBe(0);
    expect(queueJobOptions('task-5m').retryLimit).toBe(0);
  });
});
