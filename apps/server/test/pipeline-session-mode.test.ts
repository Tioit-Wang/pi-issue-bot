/**
 * 会话模式（`runtime/turn-driver.ts`，§7 / §10.5 / V13）。
 *
 * 这一组只回答两个问题：
 *  1. **archive 调用次数**：ephemeral 一次（现状），persistent **零次**（归档了下一轮没得 attach）；
 *  2. **cursor 传递**：persistent 用上一轮的游标当 `events/subscribe` 的 `after`（防重放旧事件），
 *     并把本轮最新的 `sequence` 交回去给上层写 `session_cursor`。
 *
 * attach 失败（Host 没这条 operation / 会话被清理）不是失败路径：新建会话 + warn + `sessionReset`。
 */
import { describe, expect, it } from 'vitest';

import { driveTurn, sessionCursorOf } from '../src/runtime/turn-driver.ts';
import type { TurnDriverOps } from '../src/runtime/turn-driver.ts';
import type { EventEnvelope } from '../src/runtime/deps.ts';

const ROOT = '/tmp/pi-bot-light';
const SESSION_ID = 'session-existing';
const NEW_SESSION_ID = 'session-new';
const TURN_ID = 'turn-1';

type Call = { readonly method: string; readonly params: Record<string, unknown> };

function createOps(options: { readonly attach?: 'ok' | 'throw' | 'missing'; readonly cursor?: number } = {}): TurnDriverOps & {
  readonly calls: Call[];
} {
  const calls: Call[] = [];
  const record = (method: string, params: Record<string, unknown>): void => {
    calls.push({ method, params });
  };

  const ops: TurnDriverOps = {
    projectRegister: async (params) => {
      record('project/register', { ...params });
      return { projectId: 'project-1' };
    },
    sessionCreate: async (params) => {
      record('session/create', { ...params });
      return { id: NEW_SESSION_ID };
    },
    eventsSubscribe: async (params) => {
      record('events/subscribe', { ...params });
      return {};
    },
    turnStart: async (params) => {
      record('turn/start', { sessionId: params.sessionId });
      return { id: TURN_ID };
    },
    turnInterrupt: async (params) => {
      record('turn/interrupt', { ...params });
      return {};
    },
    approvalRespond: async () => ({}),
    inputRespond: async () => ({}),
    workspaceDiff: async (params) => {
      record('workspace/diff', { ...params });
      return { diff: '' };
    },
    sessionArchive: async (params) => {
      record('session/archive', { ...params });
      return {};
    },
  };

  const mode = options.attach ?? 'ok';
  if (mode !== 'missing') {
    ops.sessionAttach = async (params) => {
      record('session/attach', { ...params });
      if (mode === 'throw') {
        throw new Error('SESSION_NOT_FOUND');
      }
      return { cursor: { sequence: options.cursor ?? 0 } };
    };
  }

  return { ...ops, calls };
}

function event(index: number, kind: string): EventEnvelope {
  return {
    eventId: `e-${String(index)}`,
    scope: 'session',
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    epoch: 'epoch-1',
    sequence: index,
    revision: index,
    kind,
    occurredAt: '2026-06-01T00:00:00.000Z',
    payload: {},
  } as unknown as EventEnvelope;
}

function stream(events: readonly EventEnvelope[]): AsyncIterable<EventEnvelope> {
  return {
    [Symbol.asyncIterator]: async function* generate() {
      for (const item of events) {
        yield item;
      }
    },
  };
}

const events = () => stream([event(1, 'turn.started'), event(4, 'turn.completed')]);

const methods = (calls: readonly Call[]): string[] => calls.map((call) => call.method);
const paramsOf = (calls: readonly Call[], method: string): Record<string, unknown> | undefined =>
  calls.find((call) => call.method === method)?.params;

describe('ephemeral（缺省，现状）', () => {
  it('create + archive 各一次，attach 不参与，mode=ephemeral', async () => {
    const ops = createOps();

    const result = await driveTurn({
      ops,
      worktreeRoot: ROOT,
      prompt: 'p',
      messageId: 'm',
      events,
    });

    expect(result.sessionMode).toBe('ephemeral');
    expect(result.sessionId).toBe(NEW_SESSION_ID);
    expect(result.archived).toBe(true);
    expect(methods(ops.calls)).not.toContain('session/attach');
    expect(methods(ops.calls).filter((method) => method === 'session/archive')).toHaveLength(1);
    // 订阅从 0 开始（ephemeral 没有历史要跳过）
    expect(paramsOf(ops.calls, 'events/subscribe')).toEqual({ sessionId: NEW_SESSION_ID, after: 0 });
    // 最新游标 = 事件流最后一条的 sequence
    expect(result.cursor).toBe(4);
  });

  it('显式 {mode:ephemeral} 与不传完全一致', async () => {
    const ops = createOps();
    const result = await driveTurn({
      ops,
      worktreeRoot: ROOT,
      prompt: 'p',
      messageId: 'm',
      events,
      session: { mode: 'ephemeral' },
    });
    expect(result.archived).toBe(true);
    expect(result.sessionMode).toBe('ephemeral');
  });
});

describe('persistent（阶段 2 复用）', () => {
  it('attach 复用 + 用 after=cursor 订阅 + **不 archive**', async () => {
    const ops = createOps({ attach: 'ok' });

    const result = await driveTurn({
      ops,
      worktreeRoot: ROOT,
      prompt: 'p',
      messageId: 'm',
      events,
      session: { mode: 'persistent', sessionId: SESSION_ID, after: 7 },
    });

    expect(methods(ops.calls)).toContain('session/attach');
    expect(paramsOf(ops.calls, 'session/attach')).toEqual({ sessionId: SESSION_ID });
    expect(methods(ops.calls)).not.toContain('session/create');
    // 防重放：订阅起点是上一轮的游标，不是 0
    expect(paramsOf(ops.calls, 'events/subscribe')).toEqual({ sessionId: SESSION_ID, after: 7 });
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.sessionMode).toBe('persistent');
    expect(result.archived).toBe(false);
    // archive 一次都不能发生（否则下一轮无处 attach）
    expect(methods(ops.calls).filter((method) => method === 'session/archive')).toHaveLength(0);
    // 最新游标交回上层
    expect(result.cursor).toBe(4);
  });

  it('没给 after 时用 attach 快照里的游标兜底（不从 0 重放）', async () => {
    const ops = createOps({ attach: 'ok', cursor: 12 });

    await driveTurn({
      ops,
      worktreeRoot: ROOT,
      prompt: 'p',
      messageId: 'm',
      events,
      session: { mode: 'persistent', sessionId: SESSION_ID },
    });

    expect(paramsOf(ops.calls, 'events/subscribe')).toEqual({ sessionId: SESSION_ID, after: 12 });
  });

  it('attach 抛错：新建会话 + sessionReset（不阻塞），仍然不 archive', async () => {
    const warnings: string[] = [];
    const ops = createOps({ attach: 'throw' });

    const result = await driveTurn({
      ops,
      worktreeRoot: ROOT,
      prompt: 'p',
      messageId: 'm',
      events,
      session: { mode: 'persistent', sessionId: SESSION_ID, after: 9 },
      logger: {
        debug: () => {},
        info: () => {},
        warn: (_fields: Record<string, unknown> | string, message?: string) => {
          warnings.push(String(message));
        },
        error: () => {},
        child: () => {
          throw new Error('unused');
        },
      } as unknown as Parameters<typeof driveTurn>[0]['logger'],
    });

    expect(result.sessionReset).toBe(true);
    expect(result.sessionId).toBe(NEW_SESSION_ID);
    expect(methods(ops.calls)).toContain('session/create');
    expect(result.archived).toBe(false);
    expect(warnings.join('|')).toContain('session/attach');
  });

  it('Host 没有 attach operation：同样按失败处理（不抛）', async () => {
    const ops = createOps({ attach: 'missing' });

    const result = await driveTurn({
      ops,
      worktreeRoot: ROOT,
      prompt: 'p',
      messageId: 'm',
      events,
      session: { mode: 'persistent' },
    });

    expect(result.sessionReset).toBe(false); // 没给 sessionId = 第一轮，不算 reset
    expect(methods(ops.calls)).toContain('session/create');
    expect(result.archived).toBe(false);
  });

  it('第一次 persistent（没有 sessionId）：新建会话，不 attach 也不 archive', async () => {
    const ops = createOps();

    const result = await driveTurn({
      ops,
      worktreeRoot: ROOT,
      prompt: 'p',
      messageId: 'm',
      events,
      session: { mode: 'persistent' },
    });

    expect(methods(ops.calls)).not.toContain('session/attach');
    expect(methods(ops.calls)).toContain('session/create');
    expect(result.archived).toBe(false);
  });
});

describe('collectDiff（light 不采 diff）', () => {
  it('collectDiff:false → 不调 workspace/diff，diff 为空', async () => {
    const ops = createOps();

    const result = await driveTurn({
      ops,
      worktreeRoot: ROOT,
      prompt: 'p',
      messageId: 'm',
      events,
      collectDiff: false,
    });

    expect(methods(ops.calls)).not.toContain('workspace/diff');
    expect(result.diff.diff).toBe('');
  });
});

describe('sessionCursorOf：两种游标形态都认', () => {
  it('裸数字 / {sequence} / 空都给对', () => {
    expect(sessionCursorOf({ cursor: 3 })).toBe(3);
    expect(sessionCursorOf({ cursor: { sequence: 8 } })).toBe(8);
    expect(sessionCursorOf({ cursor: null })).toBeNull();
    expect(sessionCursorOf({})).toBeNull();
    expect(sessionCursorOf(null)).toBeNull();
  });
});
