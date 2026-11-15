/**
 * `planAgentSession()`：一个 issue 一个会话，**永不轮换**（FR-3.4 / Q-3）。
 *
 * 为什么单独钉这个纯函数：轮换策略（满 30 轮 / 存活满 7 天就先 `session/archive` 再新建）
 * 在全仓测试里是零覆盖的 —— 端到端跑不到「第 31 轮」「第 8 天」这种格子，而它一旦回来，
 * 症状只是「重开的 issue 记不得前面聊过什么」，很难在真库里被发现。
 *
 * 这里直接把阈值外的输入摆出来，断言：会话 id 还是那一个、计划里也没有 archive 的入口。
 */
import { describe, expect, it } from 'vitest';

import { nextAgentTurns, planAgentSession } from '../src/app/compose.ts';
import type { AgentSessionRow } from '../src/app/compose.ts';

/** 一条「跑了很久」的会话：31 轮、存活 400 天（两个旧阈值都超了）。 */
const OLD_SESSION: AgentSessionRow = {
  sessionId: 'sess-old',
  cursor: 42,
  turns: 31,
  startedAt: new Date('2025-01-01T00:00:00.000Z'),
};

describe('planAgentSession：永不轮换', () => {
  it('非 agent 任务仍是 ephemeral（不落会话字段）', () => {
    const plan = planAgentSession({ session: null, isAgentTask: false });
    expect(plan.session).toBeUndefined();
    // 计划本身只有 session 一个字段：没有 rotate / archiveSessionId 这种轮换入口
    expect(Object.keys(plan)).toEqual(['session']);
  });

  it('第一次：没有 session_id → persistent 且不带 id（本轮新建）', () => {
    const plan = planAgentSession({ session: null, isAgentTask: true });
    expect(plan.session).toEqual({ mode: 'persistent' });
  });

  it('session_id 是空串同样按「第一次」处理', () => {
    const plan = planAgentSession({
      session: { sessionId: '', cursor: 0, turns: 0, startedAt: null },
      isAgentTask: true,
    });
    expect(plan.session).toEqual({ mode: 'persistent' });
  });

  it('31 轮 + 存活 400 天仍复用原会话（旧的 30 轮 / 7 天阈值不再生效）', () => {
    const plan = planAgentSession({ session: OLD_SESSION, isAgentTask: true });
    expect(plan.session).toEqual({ mode: 'persistent', sessionId: 'sess-old', after: 42 });
  });

  it('cursor 为 0 时不传 after（否则会 subscribe{after:0} 重放整段旧事件）', () => {
    const plan = planAgentSession({
      session: { ...OLD_SESSION, cursor: 0 },
      isAgentTask: true,
    });
    expect(plan.session).toEqual({ mode: 'persistent', sessionId: 'sess-old' });
  });
});

/**
 * `agent_sessions.turns` 的写回裁决（FR-3.4 会话常驻 + FR-4.2 首轮判据）。
 *
 * 为什么必须钉住：`v21IsFirstEventOf()` 用 `turns <= 0` 判「首轮」，而 `turns` 只在
 * `persistAgentSessionAfterRun()` 里写。两个方向各错一半都不会有任何测试红：
 *  - 若「只增不减」被无条件套用，运行时重置会话后下一条事件会被当成「后续轮」只发变更，
 *    而新会话里没有任何历史 —— agent 既没历史也没正文（最坏的组合）；
 *  - 若「重置即归零」被滥用（比如每轮都归零），增量投喂永不生效，退化成每次全文。
 */
describe('nextAgentTurns：正常轮 +1，运行时重置归零', () => {
  it('正常跑完一轮：previousTurns + 1（会话常驻，只增不减）', () => {
    expect(nextAgentTurns({ previousTurns: 0, sessionReset: false })).toBe(1);
    expect(nextAgentTurns({ previousTurns: 7, sessionReset: false })).toBe(8);
  });

  it('还没有会话行（undefined）时按 0 起算', () => {
    expect(nextAgentTurns({ previousTurns: undefined, sessionReset: false })).toBe(1);
  });

  it('★ 运行时重置会话：归零（否则下一条事件被误判成「后续轮」只发增量）', () => {
    expect(nextAgentTurns({ previousTurns: 31, sessionReset: true })).toBe(0);
    expect(nextAgentTurns({ previousTurns: undefined, sessionReset: true })).toBe(0);
  });

  it('归零后下一条事件恢复「首轮」：把两个函数接起来看语义闭环', () => {
    const afterReset = nextAgentTurns({ previousTurns: 12, sessionReset: true });
    // 首轮判据的等价条件（`v21IsFirstEventOf()`：row 缺失或 turns <= 0）
    expect(afterReset <= 0).toBe(true);
    // 重置后的那一轮跑完，再下一条事件就是「后续轮」—— 增量投喂回到正常节奏
    const afterFirstTurn = nextAgentTurns({ previousTurns: afterReset, sessionReset: false });
    expect(afterFirstTurn <= 0).toBe(false);
  });
});
