import { describe, expect, it } from 'vitest';
import { RacpClient } from '../src/client.ts';
import { RacpError } from '../src/errors.ts';
import {
  OPS_OPERATION_BY_METHOD,
  RACP_OPERATIONS,
  RacpOps,
  collectEvents,
} from '../src/ops.ts';
import type { EventEnvelope } from '../src/schema.ts';
import { MOCK_DEVICE_TOKEN, MOCK_PAIRING_TOKEN, MockHost, mockEvent } from './mock-host.ts';

const expectAsyncRacpError = async (run: () => Promise<unknown>, code: string): Promise<RacpError> => {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(RacpError);
    const racpError = error as RacpError;
    expect(racpError.code).toBe(code);
    return racpError;
  }
  throw new Error(`期望异步抛出 ${code}，但成功返回了`);
};

async function connected(host: MockHost): Promise<{ client: RacpClient; ops: RacpOps }> {
  const client = new RacpClient({
    port: host.port,
    token: MOCK_DEVICE_TOKEN,
    requestIdFactory: () => 'req-test',
  });
  await client.connect();
  return { client, ops: new RacpOps(client) };
}

describe('ops：导出面必须等于 tech-plan §4.4 的白名单', () => {
  it('方法名集合 == 白名单（双向，不多不少）', () => {
    const methodNames = Object.getOwnPropertyNames(RacpOps.prototype)
      .filter((name) => name !== 'constructor')
      .filter((name) => {
        const descriptor = Object.getOwnPropertyDescriptor(RacpOps.prototype, name);
        return typeof descriptor?.value === 'function';
      })
      .sort();
    expect(methodNames).toEqual(Object.keys(OPS_OPERATION_BY_METHOD).sort());
    expect([...methodNames]).toHaveLength(18);
  });

  it('方法的 operation 值集合 == RACP_OPERATIONS（且一一对应）', () => {
    const operations = Object.values(OPS_OPERATION_BY_METHOD).sort();
    expect(operations).toEqual([...RACP_OPERATIONS].sort());
    expect(new Set(operations).size).toBe(RACP_OPERATIONS.length);
  });

  it('明确不用的 operation 一个都不在表里', () => {
    const forbidden = [
      'terminal/attach',
      'attachment/upload',
      'tools/advertise',
      'workspace/toolExecute',
      'workspace/toolShell',
      'workspace/files',
      'workspace/pluginFiles',
      'workspace/list',
      'workspace/read',
      'host/list',
      'session/fork',
      'session/rename',
      'session/configure',
      'session/compact',
      'session/history',
    ];
    for (const operation of forbidden) {
      expect(RACP_OPERATIONS).not.toContain(operation);
      expect(Object.values(OPS_OPERATION_BY_METHOD)).not.toContain(operation);
    }
  });

  it('每个方法发出的 method 名正好是表里那一个（全 18 个跑一遍）', async () => {
    const host = await MockHost.start();
    try {
      const { ops } = await connected(host);
      await ops.initialize();
      await ops.ping();
      await ops.pair({ pairingToken: MOCK_PAIRING_TOKEN });
      await ops.projectRegister({ path: '/tmp/worktree' });
      await ops.sessionCreate({ projectId: 'project-1' });
      await ops.sessionAttach({ sessionId: 'session-1' });
      await ops.sessionArchive({ sessionId: 'session-1' });
      await ops.sessionDelete({ sessionId: 'session-1' });
      await ops.eventsSubscribe({ sessionId: 'session-1', after: 0 });
      await ops.eventsUnsubscribe({ subscriptionId: 'sub-1' });
      await ops.eventsAck({ sessionId: 'session-1', cursor: { epoch: 'epoch-1', sequence: 1 } });
      await ops.turnStart({ sessionId: 'session-1', input: { messageId: 'm1', text: 'hello' } });
      await ops.turnGet({ sessionId: 'session-1', turnId: 'turn-1' });
      await ops.turnInterrupt({ sessionId: 'session-1', turnId: 'turn-1' });
      await ops.turnStop({ sessionId: 'session-1', turnId: 'turn-1' });
      await ops.approvalRespond({ approvalId: 'approval-1', decision: 'allow-once' });
      await ops.inputRespond({ inputId: 'input-1', answers: [[], null] });
      await ops.workspaceDiff({ sessionId: 'session-1' });

      const sent = host.requests.map((request) => request.method);
      // connect() 额外发了一次 initialize；除此之外每条白名单 operation 都恰好被发过一次。
      const counted = new Map<string, number>();
      for (const method of sent) counted.set(method, (counted.get(method) ?? 0) + 1);
      expect(counted.get('connection/initialize')).toBe(2);
      for (const operation of RACP_OPERATIONS) {
        expect(counted.get(operation) ?? 0, `${operation} 应该被发过一次`).toBeGreaterThanOrEqual(1);
        if (operation !== 'connection/initialize') expect(counted.get(operation)).toBe(1);
      }
      // 没有表外的 method 被发出去。
      for (const method of counted.keys()) expect(RACP_OPERATIONS).toContain(method);
    } finally {
      await host.close();
    }
  });
});

describe('ops：context 与结果形状', () => {
  it('业务 operation 带 context.requestId；连接级 operation 不带', async () => {
    const host = await MockHost.start();
    try {
      const { ops } = await connected(host);
      await ops.sessionCreate({});
      await ops.eventsSubscribe({ sessionId: 'session-1', after: 0 });
      await ops.ping();

      const create = host.requests.find((request) => request.method === 'session/create');
      expect((create?.params as Record<string, unknown>).context).toMatchObject({ requestId: 'req-test' });

      const ping = host.requests.find((request) => request.method === 'connection/ping');
      expect(ping?.params).not.toHaveProperty('context');
    } finally {
      await host.close();
    }
  });

  it('idempotencyKey / expectedRevision 落进 context（重试时用同一个值）', async () => {
    const host = await MockHost.start();
    try {
      const { ops } = await connected(host);
      await ops.turnStart(
        { sessionId: 'session-1', input: { messageId: 'm1', text: 'hi' } },
        { idempotencyKey: 'idem-1', expectedRevision: 3 },
      );
      const start = host.requests.find((request) => request.method === 'turn/start');
      expect((start?.params as Record<string, unknown>).context).toMatchObject({
        requestId: 'req-test',
        idempotencyKey: 'idem-1',
        expectedRevision: 3,
      });
    } finally {
      await host.close();
    }
  });

  it('session/create 返回扁平 Session 或 {session} 两种形状都接受', async () => {
    const host = await MockHost.start({
      handlers: { 'session/create': () => ({ id: 'flat', sessionLike: true }) },
    });
    try {
      const { ops } = await connected(host);
      // 扁平形状缺必填字段 → 明确报形状错误，而不是返回半个对象。
      await expectAsyncRacpError(() => ops.sessionCreate({}), 'PROTOCOL_ERROR');
    } finally {
      await host.close();
    }

    const host2 = await MockHost.start({
      handlers: {
        'session/create': () => ({
          id: 'flat-1',
          title: 'flat',
          mode: 'agent',
          status: 'idle',
          planningState: 'inactive',
          permissionMode: 'ask',
          queuedTurnIds: [],
          revision: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });
    try {
      const { ops } = await connected(host2);
      const session = await ops.sessionCreate({});
      expect(session.id).toBe('flat-1');
    } finally {
      await host2.close();
    }
  });

  it('workspace/diff 返回裸字符串时也归一成 {diff}', async () => {
    const host = await MockHost.start({ handlers: { 'workspace/diff': () => 'raw-diff-text' } });
    try {
      const { ops } = await connected(host);
      await expect(ops.workspaceDiff({ sessionId: 'session-1' })).resolves.toEqual({ diff: 'raw-diff-text' });
    } finally {
      await host.close();
    }
  });

  it('workspace/diff 返回对象但缺 diff 字段 → PROTOCOL_ERROR', async () => {
    const host = await MockHost.start({ handlers: { 'workspace/diff': () => ({ files: [] }) } });
    try {
      const { ops } = await connected(host);
      await expectAsyncRacpError(() => ops.workspaceDiff({ sessionId: 'session-1' }), 'PROTOCOL_ERROR');
    } finally {
      await host.close();
    }
  });

  it('approval/respond 结果走 ApprovalResult 守卫', async () => {
    const host = await MockHost.start({ handlers: { 'approval/respond': () => ({ approved: true }) } });
    try {
      const { ops } = await connected(host);
      await expectAsyncRacpError(
        () => ops.approvalRespond({ approvalId: 'approval-1', decision: 'deny' }),
        'PROTOCOL_ERROR',
      );
    } finally {
      await host.close();
    }
  });

  it('connection/pair 只接受 ppt1. 配对令牌，并校验返回的 pdt1. 设备令牌', async () => {
    const host = await MockHost.start();
    try {
      const { ops } = await connected(host);
      // 把设备令牌当配对令牌用 = 装配错误，本地就拦住。
      await expectAsyncRacpError(() => ops.pair({ pairingToken: MOCK_DEVICE_TOKEN }), 'INVALID_ARGUMENT');
      const result = await ops.pair({ pairingToken: MOCK_PAIRING_TOKEN, deviceName: 'pi-bot' });
      expect(result.deviceToken).toBe(MOCK_DEVICE_TOKEN);
      expect(result.hostId).toBe('mock-host');
    } finally {
      await host.close();
    }
  });

  it('connection/pair 返回的不是 pdt1. 前缀令牌 → 不静默接受', async () => {
    const host = await MockHost.start({ handlers: { 'connection/pair': () => ({ deviceToken: 'ghp_badtoken' }) } });
    try {
      const { ops } = await connected(host);
      await expectAsyncRacpError(() => ops.pair({ pairingToken: MOCK_PAIRING_TOKEN }), 'INVALID_ARGUMENT');
    } finally {
      await host.close();
    }
  });

  it('turn/start 缺 input.text 是本地参数错误（不发出去）', async () => {
    const host = await MockHost.start();
    try {
      const { ops } = await connected(host);
      await expectAsyncRacpError(
        () => ops.turnStart({ sessionId: 'session-1', input: { messageId: 'm1', text: '' } }),
        'INVALID_ARGUMENT',
      );
      expect(host.requests.some((request) => request.method === 'turn/start')).toBe(false);
    } finally {
      await host.close();
    }
  });

  it('events/subscribe 的 after 类型不对 → INVALID_ARGUMENT（不把脏游标发给 Host）', async () => {
    const host = await MockHost.start();
    try {
      const { ops } = await connected(host);
      await expectAsyncRacpError(
        () => ops.eventsSubscribe({ sessionId: 'session-1', after: 'yesterday' as unknown as number }),
        'INVALID_ARGUMENT',
      );
    } finally {
      await host.close();
    }
  });
});

describe('ops：事件收集辅助', () => {
  it('collectEvents 收满 max 就停，并 resolve 出已收事件', async () => {
    const host = await MockHost.start();
    try {
      const { client } = await connected(host);
      const collector = collectEvents(client, { max: 2 });
      host.sendEvent(mockEvent(1) as unknown as Record<string, unknown>);
      host.sendEvent(mockEvent(2) as unknown as Record<string, unknown>);
      host.sendEvent(mockEvent(3) as unknown as Record<string, unknown>);
      const events = await collector.done;
      expect(events.map((event: EventEnvelope) => event.sequence)).toEqual([1, 2]);
      expect(collector.events).toHaveLength(2);
    } finally {
      await host.close();
    }
  });

  it('collectEvents 的 signal 取消后立即 resolve', async () => {
    const host = await MockHost.start();
    try {
      const { client } = await connected(host);
      const controller = new AbortController();
      const collector = collectEvents(client, { signal: controller.signal });
      controller.abort();
      await expect(collector.done).resolves.toEqual([]);
    } finally {
      await host.close();
    }
  });
});
