/**
 * `runtime/turn-driver.ts` 的压缩接线（FR-5.6「检查点固定在请求发出前」）。
 *
 * 这一层必须单独测，不能只测引擎或只测端口：真正会出事的错法是「压缩做对了，但接在
 * `turn/start` **之后**」——那就等于压缩从来没生效过。所以这里的断言全是**调用顺序与是否发送**：
 *  1. 端口在 `turn/start` 之前被调用；
 *  2. `send:false` 时**一条 `turn/start` 都不发**（过硬边界宁可失败）；
 *  3. 历史来自 `session/attach` 快照（不是 run_events）；
 *  4. 不注入端口时提示词逐字节不变（老部署零影响）。
 *
 * 假件全部构造注入（AGENTS §6）：假 ops 记调用序列，假端口记收到的请求。
 */
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

import { COMPACTION_LIMIT_CODE } from '../src/compact/turn-compaction.ts';
import type { TurnCompactionOutcome, TurnCompactionRequest } from '../src/compact/turn-compaction.ts';
import { driveTurn } from '../src/runtime/turn-driver.ts';
import type { TurnDriverOps } from '../src/runtime/turn-driver.ts';
import type { EventEnvelope } from '../src/runtime/deps.ts';

const ROOT = resolve('/jobs/1/work');
const SESSION_ID = 'session-1';
const TURN_ID = 'turn-1';
const PROJECT_ID = 'project-1';
const PROMPT = '把 P0-1 的遗留风险讲清楚';

type Call = { readonly method: string; readonly params: Record<string, unknown> };

function createFakeOps(snapshot?: {
  readonly items?: readonly unknown[];
  readonly hasMoreHistory?: boolean;
}): TurnDriverOps & { readonly calls: Call[] } {
  const calls: Call[] = [];
  const record = (method: string, params: Record<string, unknown>): void => {
    calls.push({ method, params });
  };

  return {
    calls,
    projectRegister: async (params) => {
      record('project/register', { ...params });
      return { projectId: PROJECT_ID };
    },
    sessionCreate: async (params) => {
      record('session/create', { ...params });
      return { id: SESSION_ID };
    },
    eventsSubscribe: async (params) => {
      record('events/subscribe', { ...params });
      return {};
    },
    turnStart: async (params) => {
      record('turn/start', { sessionId: params.sessionId, messageId: params.input.messageId, text: params.input.text });
      return { id: TURN_ID };
    },
    turnInterrupt: async (params) => {
      record('turn/interrupt', { ...params });
      return {};
    },
    approvalRespond: async (params) => {
      record('approval/respond', { ...params });
      return {};
    },
    inputRespond: async (params) => {
      record('input/respond', { ...params });
      return {};
    },
    workspaceDiff: async (params) => {
      record('workspace/diff', { ...params });
      return { diff: '', truncated: false };
    },
    sessionArchive: async (params) => {
      record('session/archive', { ...params });
      return {};
    },
    ...(snapshot === undefined
      ? {}
      : {
          sessionAttach: async (params: { readonly sessionId: string }) => {
            record('session/attach', { ...params });
            return { cursor: { sequence: 12 }, ...snapshot };
          },
        }),
  };
}

function event(index: number, kind: EventEnvelope['kind']): EventEnvelope {
  return {
    eventId: `e-${String(index)}`,
    scope: 'session',
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    epoch: 'epoch-1',
    sequence: index,
    revision: index,
    kind,
    occurredAt: '2026-11-14T00:00:00.000Z',
    payload: {},
  };
}

function stream(): AsyncIterable<EventEnvelope> {
  return {
    [Symbol.asyncIterator]: async function* generator() {
      yield event(1, 'turn.started');
      yield event(2, 'turn.completed');
    },
  };
}

/** 一个记录请求、按脚本回答案的假端口。 */
function createFakePort(
  script: (request: TurnCompactionRequest) => TurnCompactionOutcome,
): { readonly requests: TurnCompactionRequest[]; readonly port: (request: TurnCompactionRequest) => Promise<TurnCompactionOutcome> } {
  const requests: TurnCompactionRequest[] = [];
  return {
    requests,
    port: async (request) => {
      requests.push(request);
      return script(request);
    },
  };
}

const PERSISTENT = { mode: 'persistent', sessionId: SESSION_ID, after: 12 } as const;

describe('driveTurn · 压缩检查点在请求发出前', () => {
  it('顺序：attach → 压缩端口 → turn/start（压缩必须早于发送）', async () => {
    const order: string[] = [];
    const ops = createFakeOps({ items: [{ itemType: 'message', content: { role: 'user', text: '第一轮' } }] });
    const originalTurnStart = ops.turnStart;
    ops.turnStart = async (params, options) => {
      order.push('turn/start');
      return originalTurnStart(params, options);
    };

    await driveTurn({
      ops,
      worktreeRoot: ROOT,
      prompt: PROMPT,
      messageId: 'm-1',
      session: PERSISTENT,
      events: () => stream(),
      compaction: async (request) => {
        order.push(`compaction:${String(request.history.length)}`);
        return { send: true, text: request.turnText, note: null, reminder: null };
      },
    });

    expect(order).toEqual(['compaction:1', 'turn/start']);
    expect(ops.calls.map((call) => call.method)).toEqual([
      'project/register',
      'session/attach',
      'events/subscribe',
      'turn/start',
      'workspace/diff',
    ]);
  });

  it('过硬边界：拒绝发送 —— 一条 turn/start 都不发，错误码是 COMPACTION_HARD_LIMIT', async () => {
    const ops = createFakeOps({ items: [{ itemType: 'message', content: { text: '很长的历史' } }] });

    const error = await driveTurn({
      ops,
      worktreeRoot: ROOT,
      prompt: PROMPT,
      messageId: 'm-1',
      session: PERSISTENT,
      events: () => stream(),
      compaction: async () => ({
        send: false,
        code: COMPACTION_LIMIT_CODE,
        message: '压缩后仍超硬边界（hardLimit=16768），拒绝发送请求',
        details: { beforeTokens: 20_000, hardLimit: 16_768 },
      }),
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: COMPACTION_LIMIT_CODE,
      failureClass: 'model',
      retriable: false,
    });
    const methods = ops.calls.map((call) => call.method);
    expect(methods).not.toContain('turn/start');
    // 会话已 attach，但这一轮没有 turn → 也谈不上 interrupt
    expect(methods).not.toContain('turn/interrupt');
    expect(methods).toContain('events/subscribe');
  });

  it('历史来自 attach 快照；hasMoreHistory=true 时如实标成「不全」', async () => {
    const ops = createFakeOps({
      items: [
        { itemType: 'message', content: { role: 'user', text: '目标：修 FR-5.6' } },
        { itemType: 'tool', content: { toolCallId: 'c1', toolName: 'Bash', output: 'boom' } },
      ],
      hasMoreHistory: true,
    });
    const fake = createFakePort((request) => ({ send: true, text: request.turnText, note: null, reminder: null }));

    await driveTurn({
      ops,
      worktreeRoot: ROOT,
      prompt: PROMPT,
      messageId: 'm-1',
      session: PERSISTENT,
      events: () => stream(),
      compaction: fake.port,
    });

    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0];
    expect(request?.sessionId).toBe(SESSION_ID);
    expect(request?.history).toEqual([
      { role: 'user', content: '目标：修 FR-5.6' },
      { role: 'tool', content: 'boom', toolCallId: 'c1', toolName: 'Bash' },
    ]);
    expect(request?.historyComplete).toBe(false);
  });

  it('端口返回的文本就是真正发出去的内容（checkpoint 前缀进 turn/start）', async () => {
    const ops = createFakeOps({ items: [{ itemType: 'message', content: { text: '旧历史' } }] });

    await driveTurn({
      ops,
      worktreeRoot: ROOT,
      prompt: PROMPT,
      messageId: 'm-1',
      session: PERSISTENT,
      events: () => stream(),
      compaction: async () => ({
        send: true,
        text: `【上下文 checkpoint · 第 1 代（自动压缩）】\n## 目标\n修 FR-5.6\n【checkpoint 结束】\n\n${PROMPT}`,
        note: {
          generation: 1,
          beforeTokens: 20_000,
          afterTokens: 3_000,
          summaryChars: 20,
          fallback: false,
          layers: ['precheck', 'summary:l1'],
          historyComplete: true,
        },
        reminder: null,
      }),
    });

    const started = ops.calls.find((call) => call.method === 'turn/start');
    const text = started?.params['text'];
    expect(typeof text).toBe('string');
    expect(text).toContain('【上下文 checkpoint · 第 1 代（自动压缩）】');
    expect(text).toContain('修 FR-5.6');
    expect(text).toMatch(new RegExp(`${PROMPT}$`, 'u'));
  });

  it('不注入压缩端口：turn/start 的文本与 prompt 逐字节相同（老部署零影响）', async () => {
    const ops = createFakeOps({ items: [{ itemType: 'message', content: { text: '旧历史' } }] });

    await driveTurn({
      ops,
      worktreeRoot: ROOT,
      prompt: PROMPT,
      messageId: 'm-1',
      session: PERSISTENT,
      events: () => stream(),
    });

    const started = ops.calls.find((call) => call.method === 'turn/start');
    expect(started?.params['text']).toBe(PROMPT);
  });

  it('ephemeral（没有 attach）：历史为空，端口照常被调用且不改提示词', async () => {
    const ops = createFakeOps();
    const fake = createFakePort((request) => ({ send: true, text: request.turnText, note: null, reminder: null }));

    await driveTurn({
      ops,
      worktreeRoot: ROOT,
      prompt: PROMPT,
      messageId: 'm-1',
      events: () => stream(),
      compaction: fake.port,
    });

    expect(fake.requests[0]?.history).toEqual([]);
    expect(fake.requests[0]?.historyComplete).toBe(true);
    const started = ops.calls.find((call) => call.method === 'turn/start');
    expect(started?.params['text']).toBe(PROMPT);
  });

  it('端口自己抛错：按原文发送（压缩器故障不判死一轮任务）', async () => {
    const ops = createFakeOps({ items: [{ itemType: 'message', content: { text: '旧历史' } }] });

    await driveTurn({
      ops,
      worktreeRoot: ROOT,
      prompt: PROMPT,
      messageId: 'm-1',
      session: PERSISTENT,
      events: () => stream(),
      compaction: async () => {
        throw new Error('compactor exploded');
      },
    });

    const started = ops.calls.find((call) => call.method === 'turn/start');
    expect(started?.params['text']).toBe(PROMPT);
  });

  it('端口要求换会话重建：新会话 create + subscribe → 旧会话归档 → turn/start 用重建正文', async () => {
    const ops = createFakeOps({ items: [{ itemType: 'message', content: { text: '旧历史' } }] });
    // 第二次 session/create 是「换会话」：假 Host 给一个新 id
    ops.sessionCreate = async (params) => {
      ops.calls.push({ method: 'session/create', params: { ...params } });
      return { id: 'session-2' };
    };

    const rebuiltText = `【上下文 checkpoint · 第 1 代（自动压缩）】\n## 目标\n修 FR-5.6\n【checkpoint 结束】\n\n【本轮任务】\n${PROMPT}`;
    const result = await driveTurn({
      ops,
      worktreeRoot: ROOT,
      prompt: PROMPT,
      messageId: 'm-1',
      session: PERSISTENT,
      systemPrompt: 'IDENTITY',
      events: () => stream(),
      compaction: async () => ({
        send: true,
        // 前缀退路（换会话失败时才用）
        text: `【前缀】\n\n${PROMPT}`,
        note: {
          generation: 1,
          beforeTokens: 90_000,
          afterTokens: 3_000,
          summaryChars: 20,
          fallback: false,
          layers: ['precheck', 'summary:l1'],
          historyComplete: true,
        },
        reminder: null,
        rebuild: { text: rebuiltText, tokens: 3_200, recentMessages: 4 },
      }),
    });

    // 顺序：换会话在 turn/start 之前（不然「重建」等于什么都没发生）
    expect(ops.calls.map((call) => call.method)).toEqual([
      'project/register',
      'session/attach',
      'events/subscribe',
      'session/create',
      'events/subscribe',
      'session/archive',
      'turn/start',
      'workspace/diff',
    ]);
    // 新会话是全新上下文：systemPrompt 必须跟着一起给
    const created = ops.calls.find((call) => call.method === 'session/create');
    expect(created?.params['systemPrompt']).toBe('IDENTITY');
    // 新会话要重新订阅（订阅按 sessionId，旧会话那条读不到新事件）
    const subscribes = ops.calls.filter((call) => call.method === 'events/subscribe');
    expect(subscribes.map((call) => call.params['sessionId'])).toEqual([SESSION_ID, 'session-2']);
    expect(subscribes[1]?.params['after']).toBe(0);
    // 旧会话被归档，且只归档它一次
    const archives = ops.calls.filter((call) => call.method === 'session/archive');
    expect(archives).toHaveLength(1);
    expect(archives[0]?.params['sessionId']).toBe(SESSION_ID);
    // turn/start 发到新会话，正文是重建视图（不是前缀）
    const started = ops.calls.find((call) => call.method === 'turn/start');
    expect(started?.params['sessionId']).toBe('session-2');
    expect(started?.params['text']).toBe(rebuiltText);
    // 上层拿到新 id（`persistAgentSessionAfterRun()` 会把它落库），并把轮数归零
    expect(result.sessionId).toBe('session-2');
    expect(result.sessionReset).toBe(true);
  });

  it('换会话失败：退回前缀路径照常发送，不判死任务、不留下半截状态', async () => {
    const ops = createFakeOps({ items: [{ itemType: 'message', content: { text: '旧历史' } }] });
    ops.sessionCreate = async () => {
      throw new Error('host cannot create');
    };

    const result = await driveTurn({
      ops,
      worktreeRoot: ROOT,
      prompt: PROMPT,
      messageId: 'm-1',
      session: PERSISTENT,
      events: () => stream(),
      compaction: async () => ({
        send: true,
        text: `【前缀】\n\n${PROMPT}`,
        note: {
          generation: 1,
          beforeTokens: 90_000,
          afterTokens: 3_000,
          summaryChars: 20,
          fallback: false,
          layers: ['precheck', 'summary:l1'],
          historyComplete: true,
        },
        reminder: null,
        rebuild: { text: '不会被发送的重建视图', tokens: 3_200, recentMessages: 4 },
      }),
    });

    const started = ops.calls.find((call) => call.method === 'turn/start');
    // 旧会话照常发送，正文是前缀（缩小不了请求，但这一轮能跑完）
    expect(started?.params['sessionId']).toBe(SESSION_ID);
    expect(started?.params['text']).toBe(`【前缀】\n\n${PROMPT}`);
    // 没建成新会话就不能归档旧会话（否则任务会卡在没有会话的状态上）
    expect(ops.calls.map((call) => call.method)).not.toContain('session/archive');
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.sessionReset).toBe(false);
  });
});
