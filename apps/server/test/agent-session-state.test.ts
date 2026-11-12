/**
 * 会话状态机的断言（FR-3.4 / Q-3 / AC-23）。
 *
 * 这段逻辑只有一条不能错的线：**关闭 issue 时回收的是沙箱，不是历史**。
 * 所以这里既钉具体分支（关闭 / 重开 / 关闭后评论），也用一张全矩阵钉「任何输入都不会
 * 返回删除会话的动作」—— 靠类型 + 断言双保险，防止后来者顺手加个 `ended`。
 */
import { describe, expect, it } from 'vitest';

import {
  SESSION_ACTIONS,
  SESSION_EVENT_KEYS,
  SESSION_STATES,
  isSessionState,
  planSessionOnEvent,
} from '../src/agent/session-state.ts';
import type { AgentSessionRow, IssueState } from '../src/agent/session-state.ts';

const SESSION: AgentSessionRow = {
  repo: 'acme/widgets',
  issueNumber: 7,
  sessionId: 'sess-1',
  state: 'active',
  sandboxId: 'sandbox-1',
  turns: 3,
  cursor: 42,
};

function sessionWith(patch: Partial<AgentSessionRow>): AgentSessionRow {
  return { ...SESSION, ...patch };
}

describe('SESSION_STATES', () => {
  it('只有 active / idle，没有 ended', () => {
    expect([...SESSION_STATES]).toEqual(['active', 'idle']);
    expect((SESSION_STATES as readonly string[]).includes('ended')).toBe(false);
    expect((SESSION_STATES as readonly string[]).includes('archived')).toBe(false);
  });

  it('允许的动作里没有删除/归档会话', () => {
    expect([...SESSION_ACTIONS]).toEqual(['create', 'reuse', 'recycle-sandbox']);
    for (const forbidden of ['delete', 'end', 'archive', 'close']) {
      expect((SESSION_ACTIONS as readonly string[]).includes(forbidden)).toBe(false);
    }
  });

  it('isSessionState 校验脏值', () => {
    expect(isSessionState('active')).toBe(true);
    expect(isSessionState('idle')).toBe(true);
    expect(isSessionState('ended')).toBe(false);
    expect(isSessionState(undefined)).toBe(false);
  });
});

describe('planSessionOnEvent · 没有会话', () => {
  it('新建会话并拉沙箱', () => {
    const transition = planSessionOnEvent({
      session: null,
      issueState: 'open',
      event: 'issues.opened',
    });
    expect(transition).toEqual({
      action: 'create',
      state: 'active',
      keepSession: false,
      rebuildSandbox: true,
      reason: 'no-session',
    });
  });

  it('issue 已关闭也先建会话（历史从零开始，之后才可能被回收）', () => {
    const transition = planSessionOnEvent({
      session: null,
      issueState: 'closed',
      event: 'issue_comment.created',
    });
    expect(transition.action).toBe('create');
    expect(transition.state).toBe('active');
  });
});

describe('planSessionOnEvent · issue 关闭只回收沙箱', () => {
  it('issues.closed + 已关闭 → recycle-sandbox，会话保留', () => {
    const transition = planSessionOnEvent({
      session: SESSION,
      issueState: 'closed',
      event: 'issues.closed',
    });
    expect(transition).toEqual({
      action: 'recycle-sandbox',
      state: 'idle',
      keepSession: true,
      rebuildSandbox: false,
      reason: 'issue-closed',
    });
  });

  it('事件说关了但实时状态还是 open（乱序/重开竞态）→ 不砸沙箱', () => {
    const transition = planSessionOnEvent({
      session: SESSION,
      issueState: 'open',
      event: 'issues.closed',
    });
    expect(transition.action).toBe('reuse');
    expect(transition.state).toBe('active');
    expect(transition.rebuildSandbox).toBe(false);
  });

  it('已关闭 issue 上的其它触发 → 复用会话、重建沙箱（AC-23）', () => {
    const transition = planSessionOnEvent({
      session: sessionWith({ state: 'idle', sandboxId: null }),
      issueState: 'closed',
      event: 'issue_comment.created',
    });
    expect(transition.action).toBe('reuse');
    expect(transition.keepSession).toBe(true);
    expect(transition.rebuildSandbox).toBe(true);
    expect(transition.reason).toBe('closed-issue-trigger');
  });
});

describe('planSessionOnEvent · issue 重开复用原会话', () => {
  it('issues.opened 且已有会话 → 复用同一会话，沙箱重建', () => {
    const transition = planSessionOnEvent({
      session: sessionWith({ state: 'idle', sandboxId: null }),
      issueState: 'open',
      event: 'issues.opened',
    });
    expect(transition).toEqual({
      action: 'reuse',
      state: 'active',
      keepSession: true,
      rebuildSandbox: true,
      reason: 'issue-reopened',
    });
  });

  it('会话仍是 active（沙箱还在）也按重开处理并确保沙箱可用', () => {
    const transition = planSessionOnEvent({
      session: SESSION,
      issueState: 'open',
      event: 'issues.opened',
    });
    expect(transition.action).toBe('reuse');
    expect(transition.rebuildSandbox).toBe(true);
  });
});

describe('planSessionOnEvent · 常规事件', () => {
  it('active + 沙箱在 → 复用，不重建', () => {
    const transition = planSessionOnEvent({
      session: SESSION,
      issueState: 'open',
      event: 'issues.edited',
    });
    expect(transition).toEqual({
      action: 'reuse',
      state: 'active',
      keepSession: true,
      rebuildSandbox: false,
      reason: 'active-sandbox',
    });
  });

  it('idle（沙箱已回收）→ 复用会话 + 重建沙箱', () => {
    const transition = planSessionOnEvent({
      session: sessionWith({ state: 'idle', sandboxId: null }),
      issueState: 'open',
      event: 'issue_comment.created',
    });
    expect(transition.action).toBe('reuse');
    expect(transition.rebuildSandbox).toBe(true);
    expect(transition.reason).toBe('idle-sandbox');
  });

  it('state 说 active 但 sandboxId 丢了（运维 sweep 过）→ 仍然重建', () => {
    const transition = planSessionOnEvent({
      session: sessionWith({ sandboxId: null }),
      issueState: 'open',
      event: 'issues.labeled',
    });
    expect(transition.rebuildSandbox).toBe(true);
  });
});

describe('planSessionOnEvent · 全矩阵不变量', () => {
  const sessions: readonly (AgentSessionRow | null)[] = [
    null,
    SESSION,
    sessionWith({ state: 'idle', sandboxId: null }),
  ];
  const issueStates: readonly IssueState[] = ['open', 'closed'];

  it('任何输入都只产生 create / reuse / recycle-sandbox，且状态只有 active / idle', () => {
    for (const session of sessions) {
      for (const issueState of issueStates) {
        for (const event of SESSION_EVENT_KEYS) {
          const transition = planSessionOnEvent({ session, issueState, event });
          expect(SESSION_ACTIONS).toContain(transition.action);
          expect(SESSION_STATES).toContain(transition.state);

          // 没有会话才允许 keepSession=false；其余一律保留会话（永不丢历史）
          if (session === null) {
            expect(transition.action).toBe('create');
            expect(transition.keepSession).toBe(false);
          } else {
            expect(transition.keepSession).toBe(true);
          }

          // 只有「关闭回收」允许把状态置 idle，且它绝不能顺带重建沙箱
          if (transition.state === 'idle') {
            expect(transition.action).toBe('recycle-sandbox');
            expect(transition.rebuildSandbox).toBe(false);
          }
        }
      }
    }
  });

  it('没有会话被删除/归档：迁移动词里不存在这类动作', () => {
    for (const session of sessions) {
      for (const issueState of issueStates) {
        for (const event of SESSION_EVENT_KEYS) {
          const transition = planSessionOnEvent({ session, issueState, event });
          const verbs = Object.keys(transition);
          expect(verbs).not.toContain('deleteSession');
          expect(verbs).not.toContain('archiveSession');
          expect(verbs).not.toContain('ended');
        }
      }
    }
  });
});
